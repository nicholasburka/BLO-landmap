import { promises as fs } from 'node:fs'
import { getFile, putFile, putFileFromPath, isSafeKey } from './libraryBucket.js'
import { libraryQuery, isLibraryEnabled } from './libraryDb.js'
import { getCatalogEntry, indexFileBackedEntry, type CatalogEntryDetail } from './libraryCatalog.js'
import { contentTypeFor } from './contentTypes.js'
import { fetchToTemp, fetchMaxBytes, LinkFetchError, type LookupFn } from '../cli/fetchLink.js'
import { sameSite } from './linkHarvest.js'
import { extractFile, isExtractable } from './textExtract.js'
import { clearKbIndex } from './kbSearch.js'

/**
 * Pull the documents ON a page into the entry, as one collection (P5-80).
 *
 * The page that named this ticket lists thirty landowner profiles as PDFs.
 * Before this, the only way in was thirty separate link drops, because the
 * harvester keeps a PDF only when its anchor happens to say "download".
 *
 * Three rules hold the whole thing up:
 *  - NOTHING ARBITRARY IS EVER FETCHED. Every URL must already be on the
 *    entry's own `inspection.documents` list — what the page itself offered,
 *    on the page's own site. A URL that is not on it is a 400 naming it, not
 *    a request.
 *  - BOUNDED. At most `PULL_MAX_FILES` per call and `PULL_MAX_TOTAL_BYTES`
 *    across them, each fetched under the SAME guard the link fetch uses
 *    (public addresses per redirect hop, a hard timeout, a byte cap).
 *  - NO MODEL CALL. The files are stored, their text is extracted locally,
 *    and they inherit the entry's filing. Nothing here asks a model anything.
 *
 * Failures are per file and are reported per file: one unreachable profile
 * must not cost a person the other twenty-nine.
 */

/** Most documents in one pull — the harvester offers no more than this. */
export const PULL_MAX_FILES = 30

/** Bytes across one pull. A page of thirty documents is prose, not a data
 *  dump; past this, someone is copying a shelf and should say so. */
export const PULL_MAX_TOTAL_BYTES = 100 * 1024 * 1024

/** The cap, read at call time like every other byte cap here, so an operator
 *  (and a test) can set a different one without a redeploy. */
export function pullTotalBytes(): number {
  const raw = Number(process.env.LIBRARY_PULL_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : PULL_MAX_TOTAL_BYTES
}

/** Longest stored filename stem, before the extension and any `-2` suffix. */
const STEM_MAX = 80

/** Kinds that can hold a pulled document: a dropped link that has not been
 *  filed yet, and a document entry. A dataset or a source is a different
 *  thing, and dropping PDFs into one would be a filing decision. */
const PULLABLE_KINDS = new Set(['incoming', 'document'])

export type PullStatus = 'stored' | 'too-large' | 'unreachable' | 'not-a-document'

export interface PullResult {
  url: string
  status: PullStatus
  /** The name it was stored under, when it was stored. */
  file?: string
  /** Why it was not, in words a reader can act on. */
  error?: string
  /** P5-81: fetched over plain http after https failed, because the page itself is served that way. */
  via?: 'http'
}

export interface PullOptions {
  fetchImpl?: typeof fetch
  lookup?: LookupFn
  /** Where the temp files go; tests pass their own directory. */
  tmpDir?: string
}

export type PullOutcome =
  | { ok: true; results: PullResult[]; stored: number; bytes: number }
  | { ok: false; status: number; error: string }

/**
 * Seams a pull falls back to when the caller passes none. Only tests set
 * these — the route calls `pullDocuments(slug, urls)` and production reaches
 * the real network through the real guard.
 */
let defaults: PullOptions = {}

export function setDocumentPullDefaults(next: PullOptions): void {
  defaults = next
}

export function resetDocumentPullDefaults(): void {
  defaults = {}
}

/** Under a test runner a pull with no injected fetch is a bug, not a network
 *  request: no test may ever reach the outside world. */
function fetchSeam(options: PullOptions): typeof fetch | undefined {
  const impl = options.fetchImpl ?? defaults.fetchImpl
  if (!impl && process.env.VITEST) {
    throw new Error('documentPull: no fetch seam installed — a test must not reach the network')
  }
  return impl
}

// --- Naming ---------------------------------------------------------------

/** The document extension of a URL, lower-cased, or '' when it has none —
 *  which includes an address that does not parse at all. */
export function documentExtension(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return ''
  }
  const match = /\.(pdf|docx|doc|rtf|pptx|xlsx|xls)$/i.exec(pathname)
  return match ? `.${match[1].toLowerCase()}` : ''
}

/** "The Jones farm, 2024" → "the-jones-farm-2024". Bucket keys are one path
 *  component, so the charset is the bucket's, not the label's. */
function kebab(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STEM_MAX)
    .replace(/-+$/, '')
}

/**
 * What one document is stored as: the link's own words, kebab-cased, plus the
 * extension from its URL. The label is what a person reading the page saw, so
 * it is what the Files tab should show — falling back to the file's own name
 * and, past that, to something honest rather than nothing.
 */
export function documentFilename(label: string, url: string): string {
  const ext = documentExtension(url)
  const fromLabel = kebab(label)
  if (fromLabel) return `${fromLabel}${ext}`
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    /* malformed percent-encoding — the raw segment still names the file */
  }
  const fromUrl = kebab(decoded.slice(0, decoded.length - ext.length))
  return `${fromUrl || 'document'}${ext}`
}

/** The same name twice in one folder loses the first file. `-2`, `-3` … so a
 *  page with two links both labelled "Profile" keeps both. */
export function uniqueFilename(name: string, taken: Set<string>): string {
  if (!taken.has(name.toLowerCase())) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

// --- What the entry already offered ---------------------------------------

/** The URLs the last inspection found ON the page. Read defensively: the
 *  manifest is JSON from the bucket, and this list is the ONLY thing that
 *  makes a pull safe. */
function offeredDocuments(meta: Record<string, unknown>): Map<string, string> {
  const offered = new Map<string, string>()
  const inspection = meta.inspection
  if (!inspection || typeof inspection !== 'object' || Array.isArray(inspection)) return offered
  const raw = (inspection as Record<string, unknown>).documents
  if (!Array.isArray(raw)) return offered
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { url, label } = item as { url?: unknown; label?: unknown }
    if (typeof url !== 'string' || !url) continue
    offered.set(url, typeof label === 'string' ? label : '')
  }
  return offered
}

/** P5-81: whether the page the documents came from is served over http. */
function pageInsecure(meta: Record<string, unknown>): boolean {
  const inspection = meta.inspection
  if (!inspection || typeof inspection !== 'object') return false
  const page = (inspection as Record<string, unknown>).page
  return !!page && typeof page === 'object' && (page as Record<string, unknown>).insecure === true
}

/**
 * When a site serves its pages over http, its https links can be dead — an
 * expired certificate is the usual reason — while the same files answer over
 * http. For a same-site document on such a page, a failed https fetch is
 * retried over http, and the result says so. A page served properly over
 * https never gets this: an https failure there is the site's problem to fix.
 */
function httpFallbackUrl(url: string, meta: Record<string, unknown>, err: unknown): string | null {
  if (!pageInsecure(meta)) return null
  const code = err instanceof LinkFetchError ? err.code : null
  if (code && code !== 'network') return null
  let target: URL
  let page: URL
  try {
    target = new URL(url)
    page = new URL(String(meta.url ?? ''))
  } catch {
    return null
  }
  if (target.protocol !== 'https:' || !sameSite(target.hostname, page.hostname)) return null
  target.protocol = 'http:'
  return target.toString()
}

/** Why a fetch did not work, for a reader who did nothing wrong. Same words
 *  the fetch queue uses, without importing the queue for them. */
function reasonFor(err: unknown): { status: PullStatus; error: string } {
  const code = err instanceof LinkFetchError ? err.code : null
  switch (code) {
    case 'too-large':
      return { status: 'too-large', error: 'too large for one pull' }
    case 'not-public':
      return { status: 'unreachable', error: 'not a public address' }
    case 'bad-scheme':
      return { status: 'unreachable', error: 'that link does not point at a web page' }
    case 'http-error':
      return { status: 'unreachable', error: 'the site refused the request' }
    case 'timeout':
      return { status: 'unreachable', error: 'took too long' }
    case 'too-many-redirects':
      return { status: 'unreachable', error: 'the link kept redirecting' }
    default:
      return { status: 'unreachable', error: 'could not reach the site' }
  }
}

/** A server that answers a `.pdf` link with a web page has given us its login
 *  screen or its 404, not the document. Storing that as `profile.pdf` would
 *  be a lie in the Files tab. */
function isPage(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml'
}

// --- The pull -------------------------------------------------------------

interface StoredFile {
  key: string
  name: string
  size: number
  url: string
  via?: 'http'
}

/**
 * Store the manifest and replace the catalog row, bucket first — the order
 * every writer in this codebase uses, so a reindex reproduces exactly what
 * the bucket says and the Files tab sees the new files without waiting for
 * one.
 */
async function saveEntry(
  entry: CatalogEntryDetail,
  metaKey: string,
  meta: Record<string, unknown>,
  added: StoredFile[],
): Promise<void> {
  const json = JSON.stringify(meta, null, 2)
  await putFile(metaKey, json, 'application/json')
  if (!isLibraryEnabled()) return
  const files = new Map<string, { key: string; size: number }>()
  for (const file of entry.files) files.set(file.key, file)
  for (const file of added) files.set(file.key, { key: file.key, size: file.size })
  files.set(metaKey, { key: metaKey, size: Buffer.byteLength(json) })
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [entry.slug])
  await indexFileBackedEntry(entry.kind, entry.slug, meta, [...files.values()])
}

/**
 * Pull the named documents into the entry.
 *
 * Returns per-file results rather than throwing: the caller is a person who
 * ticked twenty boxes, and "three of these could not be reached" is the
 * answer, not an error.
 */
export async function pullDocuments(slug: string, rawUrls: unknown, options: PullOptions = {}): Promise<PullOutcome> {
  if (!Array.isArray(rawUrls) || rawUrls.some(u => typeof u !== 'string')) {
    return { ok: false, status: 400, error: 'urls must be a list of addresses from this page.' }
  }
  // One row per distinct address: two ticks of the same box are one file.
  const urls = [...new Set((rawUrls as string[]).map(u => u.trim()).filter(Boolean))]
  if (!urls.length) return { ok: false, status: 400, error: 'Pick at least one document.' }
  if (urls.length > PULL_MAX_FILES) {
    return { ok: false, status: 400, error: `That is more than ${PULL_MAX_FILES} documents — pull them in two goes.` }
  }

  const entry = await getCatalogEntry(slug)
  if (!entry) return { ok: false, status: 404, error: 'not found' }
  if (!PULLABLE_KINDS.has(entry.kind)) {
    return { ok: false, status: 409, error: 'Only a dropped link or a document entry can hold pulled documents.' }
  }
  const metaKey = entry.files.find(f => f.key.endsWith('/meta.json'))?.key
  if (!metaKey) return { ok: false, status: 409, error: 'This entry has no manifest to store documents against.' }

  let meta: Record<string, unknown>
  try {
    // Fresh: a CLI push or another writer may have changed the manifest
    // behind us, and the mirror would serve the stale copy.
    const parsed = JSON.parse((await getFile(metaKey, { fresh: true })).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    meta = parsed as Record<string, unknown>
  } catch {
    return { ok: false, status: 409, error: 'This entry’s manifest could not be read.' }
  }

  // The subset rule. Nothing arbitrary is ever fetched: the list came from
  // the page, and the page's own site is the only place a pull can reach.
  const offered = offeredDocuments(meta)
  const stranger = urls.find(url => !offered.has(url))
  if (stranger) {
    return { ok: false, status: 400, error: `"${stranger}" is not one of the documents on this page.` }
  }

  const folder = metaKey.slice(0, -'meta.json'.length)
  const taken = new Set(entry.files.map(f => (f.key.split('/').pop() ?? '').toLowerCase()))
  const results: PullResult[] = []
  const added: StoredFile[] = []
  let used = 0

  const totalCap = pullTotalBytes()
  for (const url of urls) {
    const budget = totalCap - used
    if (budget <= 0) {
      results.push({ url, status: 'too-large', error: `this pull already used its ${prettyBytes(totalCap)}` })
      continue
    }
    // Second gate, after the subset rule: the address must still LOOK like a
    // document. The list is stored data, and stored data is not a licence to
    // fetch an installer because someone hand-edited a manifest.
    if (!documentExtension(url)) {
      results.push({ url, status: 'not-a-document', error: 'that address does not end in a document' })
      continue
    }
    const fetchImpl = fetchSeam(options)
    const lookup = options.lookup ?? defaults.lookup
    const tmpDir = options.tmpDir ?? defaults.tmpDir
    let fetched: Awaited<ReturnType<typeof fetchToTemp>>
    let via: 'http' | undefined
    try {
      fetched = await fetchToTemp(new URL(url), {
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(lookup ? { lookup } : {}),
        ...(tmpDir ? { tmpDir } : {}),
        // Never more than the upload cap, and never more than this pull has left.
        maxBytes: Math.min(fetchMaxBytes(), budget),
      })
    } catch (err: unknown) {
      const fallback = httpFallbackUrl(url, meta, err)
      if (!fallback) {
        results.push({ url, ...reasonFor(err) })
        continue
      }
      try {
        fetched = await fetchToTemp(new URL(fallback), {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(lookup ? { lookup } : {}),
          ...(tmpDir ? { tmpDir } : {}),
          maxBytes: Math.min(fetchMaxBytes(), budget),
        })
        via = 'http'
      } catch (retryErr: unknown) {
        results.push({ url, ...reasonFor(retryErr) })
        continue
      }
    }
    try {
      if (isPage(fetched.contentType)) {
        results.push({ url, status: 'not-a-document', error: 'the site answered with a web page, not a document' })
        continue
      }
      const name = uniqueFilename(documentFilename(offered.get(url) ?? '', url), taken)
      const key = `${folder}${name}`
      if (!isSafeKey(key)) {
        results.push({ url, status: 'not-a-document', error: 'that document has no name we can store it under' })
        continue
      }
      // Labelled by the name it is STORED under, never by what the remote
      // server claimed — the upload route's rule, and the fetch queue's.
      await putFileFromPath(key, fetched.tempPath, fetched.size, contentTypeFor(name))
      taken.add(name.toLowerCase())
      used += fetched.size
      added.push({ key, name, size: fetched.size, url , ...(via ? { via } : {}) })
      results.push({ url, status: 'stored', file: name , ...(via ? { via } : {}) })
    } finally {
      // putFileFromPath renames the temp file into the mirror on success, so
      // this is a no-op then; every other path depends on it.
      await fs.rm(fetched.tempPath, { force: true }).catch(() => {})
    }
  }

  if (added.length) {
    const at = new Date().toISOString()
    const pulled = Array.isArray(meta.pulledDocuments) ? (meta.pulledDocuments as unknown[]) : []
    await saveEntry(entry, metaKey, {
      ...meta,
      // Lineage, per file: where each of these came from, so nobody has to
      // guess later which page a PDF was pulled off.
      pulledDocuments: [...pulled, ...added.map(f => ({ file: f.name, from: f.url, bytes: f.size, at, ...(f.via ? { via: f.via } : {}) }))],
    }, added)

    // Text, locally and with no model anywhere near it, so Ask and the
    // document viewer can read what just arrived.
    for (const file of added) {
      if (!isExtractable(file.name)) continue
      try {
        await extractFile(slug, file.name, file.key, file.size)
      } catch (err: any) {
        // extractFile records its own failures; this is the bucket hiccup
        // case, and one unreadable file must not undo twenty stored ones.
        console.warn(`[library] could not extract ${file.key}: ${err?.message || err}`)
      }
    }
    // Ask reads a cached index; new document pages have to be findable now.
    clearKbIndex()
  }

  return { ok: true, results, stored: added.length, bytes: used }
}

function prettyBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${n} bytes`
}
