import { randomUUID } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { createWriteStream, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { getFile, putFile, putFileFromPath, listFiles } from '../services/libraryBucket.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { reindexCatalog } from '../services/libraryCatalog.js'
import { isForbiddenHostname, isPrivateAddress, literalIp } from '../services/hostGuard.js'
import { contentTypeFor } from '../services/contentTypes.js'

/**
 * `npm run library -- fetch <slug> [--as <filename>]` (P5-34): download a
 * link drop's URL into its incoming folder in the bucket so the normal
 * pull → clean → push flow takes over. Size-capped, content type recorded,
 * `lineage.from` set to the URL. Failures are reported, never block.
 *
 * The URL came from a teammate's paste, so it is treated as hostile input:
 * every host (the original and every redirect hop) must resolve only to
 * public addresses, redirects are followed by hand so each hop is checked,
 * and each request has a hard timeout.
 */

export const FETCH_MAX_BYTES = Number(process.env.LIBRARY_UPLOAD_MAX_BYTES) > 0 ? Number(process.env.LIBRARY_UPLOAD_MAX_BYTES) : 200 * 1024 * 1024
export const FETCH_TIMEOUT_MS = 60_000
export const MAX_REDIRECTS = 5

/** The cap, read at call time. The CLI is a one-shot process so the constant
 *  above is enough for it, but the server-side queue (P5-47) lives for the
 *  life of the process and must see the env the operator actually set. */
export function fetchMaxBytes(): number {
  const raw = Number(process.env.LIBRARY_UPLOAD_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200 * 1024 * 1024
}

/** Why a fetch failed, in a form a caller can turn into plain words for a
 *  reader (P5-47) without matching on message text. */
export type FetchFailureCode =
  | 'bad-scheme'
  | 'not-public'
  | 'too-many-redirects'
  | 'http-error'
  | 'too-large'
  | 'timeout'
  | 'network'

export class LinkFetchError extends Error {
  code: FetchFailureCode
  constructor(message: string, code: FetchFailureCode) {
    super(message)
    this.name = 'LinkFetchError'
    this.code = code
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  'text/csv': '.csv',
  'application/json': '.json',
  'application/geo+json': '.geojson',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

/** Bucket-key-safe basename: no path, no spaces, never the manifest name. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/-+/g, '-').slice(0, 120)
  if (!cleaned || cleaned === 'meta.json') return 'download.bin'
  return cleaned
}

export function filenameFor(url: URL, contentType: string | null, override?: string): string {
  if (override) return safeFilename(override)
  const last = url.pathname.split('/').filter(Boolean).pop() ?? ''
  let decoded = last
  try {
    decoded = decodeURIComponent(last)
  } catch {
    /* malformed percent-encoding — the raw segment is still a usable name */
  }
  let name = safeFilename(decoded)
  if (name === 'download.bin' || !extname(name)) {
    const ext = EXT_BY_TYPE[(contentType ?? '').split(';')[0].trim().toLowerCase()] ?? ''
    name = (name === 'download.bin' ? url.hostname.replace(/[^A-Za-z0-9.-]+/g, '-') : name) + (ext || (name === 'download.bin' ? '.bin' : ''))
  }
  return name
}

/** The response's content type is stored in the bucket and the manifest, so
 *  it must be a plain `type/subtype` — parameters dropped, anything odd
 *  replaced by application/octet-stream rather than recorded verbatim. */
export function normalizeContentType(raw: string | null): string {
  const type = (raw ?? '').split(';')[0].trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : 'application/octet-stream'
}

export type LookupFn = (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>

/** True only when the hostname is not a reserved name and every address it
 *  names (literal or resolved) is public. Reserved names and literal
 *  addresses are decided without touching DNS. */
export async function isPublicHost(hostname: string, lookup: LookupFn = dns.lookup): Promise<boolean> {
  if (isForbiddenHostname(hostname)) return false
  const literal = literalIp(hostname)
  if (literal) return !isPrivateAddress(literal)
  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    return false
  }
  return addresses.length > 0 && addresses.every(a => !isPrivateAddress(a.address))
}

export interface FetchLinkOptions {
  /** Test seam: where the temp file goes (see FetchToTempOptions.tmpDir). */
  tmpDir?: string
  as?: string
  fetchImpl?: typeof fetch
  lookup?: LookupFn
  log?: (s: string) => void
}

export interface FetchLinkResult {
  key: string
  size: number
  contentType: string
  reindexed: boolean
}

/** GET with redirects followed by hand: each hop must be http(s) on a
 *  public host, and the chain is capped. Returns the final response and
 *  the URL that actually served it (the real filename lives there). */
async function fetchGuarded(
  start: URL,
  fetchImpl: typeof fetch,
  lookup: LookupFn,
  log: (s: string) => void,
): Promise<{ res: Response; finalUrl: URL }> {
  let url = start
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new LinkFetchError(`refusing to fetch a non-http(s) url: ${url.protocol}`, 'bad-scheme')
    }
    if (!(await isPublicHost(url.hostname, lookup))) {
      throw new LinkFetchError(`refusing to fetch ${url.hostname}: not a public host`, 'not-public')
    }
    log(hop === 0 ? `Fetching ${url} …` : `Following redirect to ${url} …`)
    let res: Response
    try {
      res = await fetchImpl(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (err: any) {
      // Transport failures (DNS, reset, TLS) and the hard timeout are the two
      // endings worth one retry from a queue; every other failure below is a
      // decision, not an accident, and retrying it would only repeat it.
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      throw new LinkFetchError(
        timedOut
          ? `no answer within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`
          : `could not reach ${url.hostname}: ${err?.message || err}`,
        timedOut ? 'timeout' : 'network',
      )
    }
    const location = res.headers.get('location')
    if (res.status < 300 || res.status >= 400 || !location) return { res, finalUrl: url }
    if (hop >= MAX_REDIRECTS) throw new LinkFetchError(`too many redirects (more than ${MAX_REDIRECTS})`, 'too-many-redirects')
    await res.body?.cancel().catch(() => {})
    url = new URL(location, url)
  }
}

export interface FetchToTempOptions {
  /** Store-as name override (`--as`), else the name is derived from the URL. */
  as?: string
  fetchImpl?: typeof fetch
  lookup?: LookupFn
  /** Byte cap; defaults to `fetchMaxBytes()`. */
  maxBytes?: number
  /** Where the temp file goes; defaults to the OS temp dir. Tests pass their
   *  own directory so parallel workers cannot see each other's files. */
  tmpDir?: string
  log?: (s: string) => void
}

export interface FetchToTempResult {
  /** Caller owns this file and MUST remove it (putFileFromPath consumes it). */
  tempPath: string
  /** Bucket-safe basename to store the bytes under. */
  name: string
  size: number
  /** What the remote server claimed, normalised — a record, not a label. */
  contentType: string
  /** The URL that actually served the bytes (after redirects). */
  finalUrl: URL
}

/**
 * Download one URL to a temp file under the guard, and stop there.
 *
 * Split out of `fetchLink` (P5-47) so the server-side fetch queue runs the
 * SAME guard as the CLI rather than a second copy of it: public-address check
 * per hop, redirects followed by hand and capped, a hard timeout, and a byte
 * cap enforced on both the declared length and the streamed bytes.
 */
export async function fetchToTemp(url: URL, options: FetchToTempOptions = {}): Promise<FetchToTempResult> {
  const log = options.log ?? (() => {})
  const fetchImpl = options.fetchImpl ?? fetch
  const lookup = options.lookup ?? dns.lookup
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : fetchMaxBytes()

  const { res, finalUrl } = await fetchGuarded(url, fetchImpl, lookup, log)
  if (!res.ok || !res.body) throw new LinkFetchError(`download failed: HTTP ${res.status}`, 'http-error')
  const contentType = normalizeContentType(res.headers.get('content-type'))
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new LinkFetchError(`download is ${declared} bytes — over the ${maxBytes}-byte cap`, 'too-large')
  }

  // Unguessable name + exclusive create: a pre-planted file at the path
  // (symlink or otherwise) fails the open instead of being written through.
  const tempPath = join(options.tmpDir ?? tmpdir(), `blo-fetch-${randomUUID()}`)
  let size = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > maxBytes) cb(new LinkFetchError(`download exceeded the ${maxBytes}-byte cap`, 'too-large'))
      else cb(null, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(tempPath, { flags: 'wx' }))
  } catch (err) {
    // Nobody downstream knows this path yet, so the half-written file is ours
    // to clear before the error travels.
    await fs.rm(tempPath, { force: true }).catch(() => {})
    throw err
  }
  return { tempPath, name: filenameFor(finalUrl, contentType, options.as), size, contentType, finalUrl }
}

export async function fetchLink(slug: string, options: FetchLinkOptions = {}): Promise<FetchLinkResult> {
  const log = options.log ?? console.log
  const metaKey = `library/incoming/${slug}/meta.json`
  const existing = await listFiles(`library/incoming/${slug}/`)
  if (!existing.some(f => f.key === metaKey)) throw new Error(`no incoming entry "${slug}" in the bucket`)
  const meta = JSON.parse((await getFile(metaKey, { fresh: true })).toString('utf8')) as Record<string, unknown>
  if (typeof meta.url !== 'string' || !meta.url) throw new Error(`entry "${slug}" has no url — only link drops can be fetched`)
  const url = new URL(meta.url)

  const { tempPath, name, size, contentType } = await fetchToTemp(url, {
    as: options.as,
    fetchImpl: options.fetchImpl,
    lookup: options.lookup,
    tmpDir: options.tmpDir,
    log,
  })
  try {
    const key = `library/incoming/${slug}/${name}`
    // Label the object by the name it is stored under, not by what the
    // remote server claimed — the same rule the upload route follows.
    await putFileFromPath(key, tempPath, size, contentTypeFor(name))
    const lineage = meta.lineage && typeof meta.lineage === 'object' ? (meta.lineage as Record<string, unknown>) : {}
    const updated = {
      ...meta,
      originalFilename: name,
      contentType,
      size,
      fetchedAt: new Date().toISOString(),
      lineage: { ...lineage, from: url.toString() },
    }
    await putFile(metaKey, JSON.stringify(updated, null, 2), 'application/json')
    log(`Stored ${key} (${size} bytes, ${contentType}).`)
    let reindexed = false
    if (isLibraryEnabled()) {
      await reindexCatalog()
      reindexed = true
    } else {
      log('WARNING: not reindexed — DATABASE_URL is unset; hit Reindex in the app so the catalog sees the file.')
    }
    return { key, size, contentType, reindexed }
  } finally {
    await fs.rm(tempPath, { force: true })
  }
}
