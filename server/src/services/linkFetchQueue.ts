import { promises as fs } from 'node:fs'
import { getFile, putFile, putFileFromPath, isBucketEnabled } from './libraryBucket.js'
import { libraryQuery, isLibraryEnabled, writeAudit } from './libraryDb.js'
import { getCatalogEntry, indexFileBackedEntry } from './libraryCatalog.js'
import { contentTypeFor } from './contentTypes.js'
import { fetchToTemp, fetchMaxBytes, LinkFetchError, type LookupFn } from '../cli/fetchLink.js'
import { suggestForEntry, type SuggestOutcome } from './suggestFiling.js'
import { clearKbIndex } from './kbSearch.js'
import { reportsDetachedWork } from './detachedWork.js'
import { inspectUrl, inspectionText, type Inspection } from './linkInspect.js'
import type { AnthropicLike } from './assistantCall.js'
import { writeInspection, patchEntryManifest } from './entryManifest.js'
import { applyInferredFromInspection } from './remediate.js'

/**
 * Fetch a dropped link on the server, in the background (P5-47).
 *
 * Until now a link drop waited for a developer to run `library fetch`. The
 * queue does it on the drop instead: same guard as the CLI (it calls the CLI's
 * own `fetchToTemp`), one job at a time so a box shared with the public map
 * never has two downloads and a PDF parse racing, and never on the request
 * path — the intern's POST returns the moment the manifest is written.
 *
 * The queue is deliberately in-process and unpersisted. A restart loses
 * pending jobs, and that is fine: the entry says so ("Could not fetch …
 * Try again"), and the bucket, not this array, is the truth.
 */

/** Beyond this, a drop still succeeds — it just says the fetch will have to
 *  wait for a person to ask again. An unbounded queue would let one paste of
 *  a thousand links hold the box for an afternoon. */
export const QUEUE_MAX = 50

/** One retry, for the endings that are accidents (a reset, a timeout). */
export const FETCH_RETRIES = 1

export type FetchStatus = 'queued' | 'later' | 'fetching' | 'fetched' | 'failed'

/** What the manifest and the catalog row carry under `fetch`. */
export interface FetchState {
  status: FetchStatus
  at: string
  /** fetched: how big the file was, and what it is called in the entry. */
  bytes?: number
  name?: string
  /** failed / later: why, in words a reader can act on. */
  reason?: string
}

export interface LinkFetchJob {
  slug: string
  /** 'fetch' looks at the entry's url, downloads it when there is something to
   *  download, and suggests a filing; 'suggest' only suggests (uploads already
   *  have their file); 'replicate' copies a whole dataset in (P5-59);
   *  'annotate' is P6-8's wider read of a bulk-dropped document. */
  work: 'fetch' | 'suggest' | 'replicate' | 'annotate'
  userId: number | null
  actor: string
  /** The dropping user's IP, so the suggestion's tokens are billed to them. */
  clientIp?: string
  // --- test seams: the routes never pass these ---
  fetchImpl?: typeof fetch
  lookup?: LookupFn
  suggest?: typeof suggestForEntry
  inspect?: typeof inspectUrl
  replicate?: (job: LinkFetchJob) => Promise<void>
  annotate?: (job: LinkFetchJob) => Promise<void>
  /** P6-8: the model client the annotation pass asks. Only a test passes one;
   *  production builds its own. It doubles as the annotate seam — under a test
   *  runner a job carrying neither runs nothing at all (see `seamMissing`). */
  assistant?: AnthropicLike
  tmpDir?: string
}

/** Seams a job falls back to when it carries none of its own. Only tests set
 *  these — a route suite can then drive the REAL queue (real manifest writes,
 *  real catalog rows) with a fake network. Production leaves them empty. */
let defaults: Pick<LinkFetchJob, 'fetchImpl' | 'lookup' | 'suggest' | 'inspect' | 'replicate' | 'annotate' | 'assistant' | 'tmpDir'> = {}

export function setLinkFetchDefaults(
  next: Pick<LinkFetchJob, 'fetchImpl' | 'lookup' | 'suggest' | 'inspect' | 'replicate' | 'annotate' | 'assistant' | 'tmpDir'>,
): void {
  defaults = next
}

const INCOMING_PREFIX = 'library/incoming/'

function metaKeyFor(slug: string): string {
  return `${INCOMING_PREFIX}${slug}/meta.json`
}

// --- The queue ------------------------------------------------------------

/**
 * Annotation jobs run three at a time (P6-8, spec: "three files in flight").
 *
 * Every other kind keeps P5-47's one-at-a-time rule, and keeps it for its own
 * reason: a download racing a PDF parse on a box that also serves the public
 * map is exactly what that rule is for. An annotation is neither — it reads a
 * file we already hold and makes one metered call — so a dropped folder of
 * fifty is not read one every few seconds. A job of any other kind still waits
 * for the queue to be empty, and still runs alone.
 */
export const ANNOTATE_IN_FLIGHT = 3

const pending: LinkFetchJob[] = []
let running: Promise<void> | null = null

interface RunningJob {
  work: LinkFetchJob['work']
  done: Promise<void>
}
const inFlight = new Set<RunningJob>()

export function queueDepth(): number {
  return pending.length
}

/** Add a job. Returns 'full' when the bound is reached — the caller records
 *  "later" on the entry and moves on. Never awaits the work. */
export function enqueueLinkJob(job: LinkFetchJob): 'queued' | 'full' {
  if (pending.length >= QUEUE_MAX) return 'full'
  pending.push(job)
  kick()
  return 'queued'
}

function kick(): void {
  if (running) return
  running = drain().finally(() => {
    running = null
    // A job that arrived while the last one was finishing would otherwise sit
    // here until the next drop.
    if (pending.length) kick()
  })
}

/** Is there room for this job right now? Only annotations share the queue,
 *  and only with each other. */
function canStart(job: LinkFetchJob): boolean {
  if (inFlight.size === 0) return true
  if (job.work !== 'annotate' || inFlight.size >= ANNOTATE_IN_FLIGHT) return false
  for (const active of inFlight) if (active.work !== 'annotate') return false
  return true
}

/** Resolves when any running job finishes. Never rejects — every job's own
 *  failure is caught where it is started. */
function whenOneFinishes(): Promise<void> {
  return Promise.race([...inFlight].map(job => job.done))
}

function start(job: LinkFetchJob): void {
  const entry: RunningJob = { work: job.work, done: Promise.resolve() }
  inFlight.add(entry)
  entry.done = (async () => {
    try {
      await runJob(job)
    } catch (err: any) {
      // A job must never take the process with it: this loop is detached from
      // every request that started it.
      console.error('[library] fetch job failed for', job.slug, '—', err?.message || err)
    } finally {
      inFlight.delete(entry)
    }
  })()
}

async function drain(): Promise<void> {
  while (pending.length) {
    if (!canStart(pending[0])) {
      await whenOneFinishes()
      continue
    }
    start(pending.shift()!)
  }
  // The drain is not done until the work is: `whenQueueIdle` waits on this,
  // and a test that awaited it while three annotations were still reading
  // would see half a drop.
  while (inFlight.size) await whenOneFinishes()
}

/** Resolve once the queue has nothing left to do. Tests await this; nothing
 *  in the app does — the point of the queue is that no request waits. */
export async function whenQueueIdle(): Promise<void> {
  while (running) await running.catch(() => {})
}

// P7-11: and offered to the harness, so the suites that upload a file or drop
// a link without knowing this queue exists still have its jobs joined before
// the next test — `writeFetchState` puts a manifest patch through the mirror,
// and three files had learned to await this by hand.
reportsDetachedWork(whenQueueIdle)

/** Drop every pending job. For tests, which share one process. */
export function resetLinkFetchQueue(): void {
  pending.length = 0
  defaults = {}
}

// --- Plain words for a failure -------------------------------------------

function prettyLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} bytes`
}

/** Why it did not work, for a reader who did nothing wrong. */
export function failureReason(err: unknown): string {
  const code = err instanceof LinkFetchError ? err.code : null
  switch (code) {
    case 'not-public':
      return 'not a public address'
    case 'bad-scheme':
      return 'that link does not point at a web page'
    case 'http-error':
      return 'the site refused the request'
    case 'too-large':
      return `too large (limit ${prettyLimit(fetchMaxBytes())})`
    case 'timeout':
      return 'took too long'
    case 'network':
      return 'could not reach the site'
    case 'too-many-redirects':
      return 'the link kept redirecting'
    default:
      return 'the download did not work'
  }
}

/** Only accidents are retried. A refused host or an oversize file would fail
 *  the same way a second time, and a retry there is just a second request the
 *  other end did not ask for. */
function isRetryable(err: unknown): boolean {
  return err instanceof LinkFetchError && (err.code === 'network' || err.code === 'timeout')
}

// --- Manifest + catalog ---------------------------------------------------

async function readManifest(slug: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await getFile(metaKeyFor(slug), { fresh: true })).toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    // Deleted, re-filed as a source, or never there: nothing to fetch into.
    return null
  }
}

/**
 * Bucket first, then the catalog row — the same order (and the same delete +
 * insert) filing uses, so the browser sees a status change without waiting for
 * a reindex, and a reindex reproduces exactly what the bucket already says.
 */
async function saveManifest(
  slug: string,
  meta: Record<string, unknown>,
  extraFiles: { key: string; size: number }[] = [],
): Promise<void> {
  const metaKey = metaKeyFor(slug)
  const json = JSON.stringify(meta, null, 2)
  await putFile(metaKey, json, 'application/json')
  if (!isLibraryEnabled()) return
  const existing = await getCatalogEntry(slug)
  const files = new Map<string, { key: string; size: number }>()
  for (const file of existing?.files ?? []) files.set(file.key, file)
  for (const file of extraFiles) files.set(file.key, file)
  files.set(metaKey, { key: metaKey, size: Buffer.byteLength(json) })
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await indexFileBackedEntry(existing?.kind ?? 'incoming', slug, meta, [...files.values()])
}

/** Write one `fetch` status onto the entry, leaving everything else alone. */
export async function writeFetchState(slug: string, state: FetchState): Promise<Record<string, unknown> | null> {
  const meta = await readManifest(slug)
  if (!meta) return null
  const updated = { ...meta, fetch: state }
  await saveManifest(slug, updated)
  return updated
}

/** Write the suggestion onto the entry. Never touches title/category/tags:
 *  a suggestion is a proposal, and only a person applies it. */
async function writeSuggestion(slug: string, suggested: SuggestOutcome): Promise<void> {
  const meta = await readManifest(slug)
  if (!meta) return
  await saveManifest(slug, { ...meta, suggested })
  // Ask reads a cached index that is otherwise only rebuilt at reindex. A
  // summary written this morning has to be findable this morning, so the
  // cache is dropped here rather than at the next full rebuild.
  clearKbIndex()
}

/**
 * P5-79: the page's own words, onto an entry that has none.
 *
 * Every enrichment used to be the model's job, so a page dropped while the
 * account had no credit landed titled by its hostname with nothing else —
 * `http://www.engaginglandowners.org/` became an entry called
 * "www.engaginglandowners.org". The page told us its title and its
 * description; this is the deterministic floor under every drop, and the model
 * pass still improves on it.
 *
 * Never over a person's words. The title is replaced only while it is still
 * the one the drop DERIVED from the URL — the same derivation, compared, so
 * an entry someone has titled (or a filename drop) is never touched, and an
 * entry this has already titled is never touched again. The description is
 * written only when there is none.
 */
async function applyPageFloor(slug: string, url: URL, inspection: Inspection | null): Promise<void> {
  const page = inspection?.page
  if (!page || (!page.title && !page.description)) return
  // Imported here rather than at the top: libraryLinks imports THIS module to
  // queue the fetch, and the title derivation must not close that cycle.
  const { defaultLinkTitle } = await import('./libraryLinks.js')
  const updated = await patchEntryManifest(slug, meta => {
    const title = page.title && meta.title === defaultLinkTitle(url) ? page.title : null
    const described = typeof meta.description === 'string' && !!meta.description.trim()
    const description = page.description && !described ? page.description : null
    if (!title && !description) return null
    return { ...meta, ...(title ? { title } : {}), ...(description ? { description } : {}) }
  })
  // ⌘K reads the catalog row, which the patch has just rebuilt; Ask reads a
  // cached index that is otherwise only dropped at the next reindex. A page
  // read this morning has to be findable this morning — `writeSuggestion`'s
  // rule, for the same reason.
  if (updated) clearKbIndex()
}

// --- Jobs -----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Under a test runner, a step with no injected seam does nothing at all.
 *
 * Every suite that drops a link or uploads a file now starts background work,
 * and background work here means DNS, HTTP and an Anthropic call. A test must
 * never reach the network, so the rule is inverted for tests: no injected
 * fetch (or suggester) means that step does not run. Suites that exercise
 * this path install their fakes per job or with `setLinkFetchDefaults`.
 */
function seamMissing(step: 'fetch' | 'suggest' | 'inspect' | 'replicate' | 'annotate', job: LinkFetchJob): boolean {
  if (!process.env.VITEST) return false
  if (step === 'fetch') return !(job.fetchImpl ?? defaults.fetchImpl)
  if (step === 'inspect') return !(job.inspect ?? defaults.inspect)
  if (step === 'replicate') return !(job.replicate ?? defaults.replicate)
  // P6-8: a stub model client is enough of a seam on its own — a suite that
  // provides one is asking for the REAL annotation path over a fake model.
  if (step === 'annotate') return !(job.annotate ?? defaults.annotate) && !(job.assistant ?? defaults.assistant)
  return !(job.suggest ?? defaults.suggest)
}

async function runJob(job: LinkFetchJob): Promise<void> {
  if (!isBucketEnabled()) return
  if (job.work === 'suggest') {
    await runSuggestion(job)
    return
  }
  if (job.work === 'annotate') {
    if (seamMissing('annotate', job)) return
    // Lazily, for the reason replication is: the annotation pass pulls in the
    // extractor and the taxonomy, and a plain link drop must not pay for that
    // at import time.
    const run = job.annotate ?? defaults.annotate ?? (await import('./bulkDrop.js')).runAnnotateJob
    // The stub model client is a queue-wide default in the suites that use
    // one, and the pass reads it off the job — so hand it down here.
    const assistant = job.assistant ?? defaults.assistant
    await run(assistant ? { ...job, assistant } : job)
    return
  }
  if (job.work === 'replicate') {
    if (seamMissing('replicate', job)) return
    // Loaded lazily: replication pulls in the tabular stack and the bucket
    // writer, and a plain link drop must not pay for that at import time.
    const run = job.replicate ?? defaults.replicate ?? (await import('./replicate.js')).runReplicateJob
    await run(job)
    return
  }
  if (seamMissing('fetch', job)) return
  await runFetch(job)
}

async function runSuggestion(job: LinkFetchJob, text?: { file: string; text: string }): Promise<void> {
  if (seamMissing('suggest', job)) return
  const suggest = job.suggest ?? defaults.suggest ?? suggestForEntry
  const suggested = await suggest(job.slug, { clientIp: job.clientIp, ...(text ? { text } : {}) })
  if (suggested) await writeSuggestion(job.slug, suggested)
}

/**
 * P5-59: look at the link before deciding what to do with it.
 *
 * Best effort in every direction — a probe that throws, or a bucket that has
 * lost the entry, must not cost the drop its download. The result is stored
 * as data and never applied.
 */
async function runInspection(job: LinkFetchJob, url: URL): Promise<Inspection | null> {
  if (seamMissing('inspect', job)) return null
  const inspect = job.inspect ?? defaults.inspect ?? inspectUrl
  try {
    const inspection = await inspect(url.toString(), {
      fetchImpl: job.fetchImpl ?? defaults.fetchImpl,
      lookup: job.lookup ?? defaults.lookup,
      // P5-61: a page inspection may run a model pass to prune its links.
      // It happens on the dropping user's behalf, so it is billed to them —
      // the same rule the filing suggestion follows — and it is logged
      // against the entry's slug, so "why is this unranked?" is greppable.
      ...(job.clientIp ? { clientIp: job.clientIp } : {}),
      label: job.slug,
    })
    await writeInspection(job.slug, inspection)
    // P7-7: the pass just read the page and said what the data answers, with
    // the sentence it read it from. Apply it now, on the verification queue —
    // the next remediation run would only have the manifest to go on, so a
    // line read from the page costs nothing here and a second model call
    // there.
    await applyInferredFromInspection(job.slug, inspection)
    return inspection
  } catch (err: any) {
    console.warn('[library] could not inspect', job.slug, '-', err?.message || err)
    return null
  }
}

/**
 * Links there is nothing to download from, and what the entry should say.
 *
 * Two kinds of "nothing":
 *  - a service we query (ArcGIS, Socrata): the URL answers with metadata, and
 *    storing that JSON as the file would leave a person wondering why the
 *    dataset has one row;
 *  - a web PAGE (P5-59, found live): the P5-47 download stored the raw HTML,
 *    which the viewer can only offer as an attachment. The probe already read
 *    the page for the summary, so there is nothing left to fetch. A `document`
 *    plan on one of these means "keep it as a link with its summary".
 *
 * `file` is unchanged: that is the case the download exists for.
 */
function skipDownload(inspection: Inspection | null): { reason: string; file: string } | null {
  switch (inspection?.kind) {
    case 'arcgis-layer':
    case 'arcgis-service':
    case 'socrata':
      return { reason: 'this is a service we query, not a file we download', file: 'the service description' }
    case 'page':
    case 'portal':
      // P5-61: the page's own links were pruned and stored; what there is
      // nothing to download from is the PAGE, and its data links are each a
      // drop of their own.
      return inspection.links?.length
        ? { reason: 'a web page — its data links are listed on the entry; the page itself is not a download', file: 'the page' }
        : { reason: 'a web page — its text was read for the summary; nothing to download', file: 'the page' }
    default:
      return null
  }
}

async function runFetch(job: LinkFetchJob): Promise<void> {
  const meta = await readManifest(job.slug)
  if (!meta || typeof meta.url !== 'string' || !meta.url) return
  let url: URL
  try {
    url = new URL(meta.url)
  } catch {
    return
  }

  // P5-59: inspection runs FIRST, for every dropped link. Downloading an
  // ArcGIS layer's URL would store its JSON metadata as if it were the data,
  // and a person would then have to work out why the "file" has one row.
  const inspection = await runInspection(job, url)
  // P5-79: before anything else is decided, the page's own title and
  // description land on an entry that has none of its own.
  await applyPageFloor(job.slug, url, inspection)
  const skip = skipDownload(inspection)
  if (skip) {
    await writeFetchState(job.slug, { status: 'later', at: nowIso(), reason: skip.reason })
    // There is no document to read, so what the probe read IS what the filing
    // model is shown — a service's metadata, or the page's own text.
    await runSuggestion(job, { file: skip.file, text: inspectionText(inspection!) })
    return
  }

  await writeFetchState(job.slug, { status: 'fetching', at: nowIso() })

  for (let attempt = 0; ; attempt++) {
    try {
      await downloadInto(job, url)
      break
    } catch (err: unknown) {
      if (isRetryable(err) && attempt < FETCH_RETRIES) continue
      const at = nowIso()
      const reason = failureReason(err)
      await writeFetchState(job.slug, { status: 'failed', at, reason })
      void writeAudit({
        userId: job.userId,
        actor: job.actor,
        action: 'library.fetch',
        target: job.slug,
        detail: { url: url.toString(), ok: false, reason },
      })
      return
    }
  }

  // The file is in and the row is current; the proposal is a separate step so
  // a model outage never costs us the download.
  await runSuggestion(job)
}

/** One attempt: download, store, and record it exactly as the CLI does. */
async function downloadInto(job: LinkFetchJob, url: URL): Promise<void> {
  const { tempPath, name, size, contentType } = await fetchToTemp(url, {
    fetchImpl: job.fetchImpl ?? defaults.fetchImpl,
    lookup: job.lookup ?? defaults.lookup,
    maxBytes: fetchMaxBytes(),
    tmpDir: job.tmpDir ?? defaults.tmpDir,
  })
  try {
    // Re-read before storing anything: the entry can be filed as a source (or
    // deleted) while a large file is downloading, and writing then would
    // resurrect an incoming entry nobody asked for.
    const meta = await readManifest(job.slug)
    if (!meta) return
    const key = `${INCOMING_PREFIX}${job.slug}/${name}`
    // Label the object by the name it is stored under, never by what the
    // remote server claimed — the upload route's rule, and the CLI's.
    await putFileFromPath(key, tempPath, size, contentTypeFor(name))
    const at = nowIso()
    const lineage = meta.lineage && typeof meta.lineage === 'object' ? (meta.lineage as Record<string, unknown>) : {}
    await saveManifest(
      job.slug,
      {
        ...meta,
        originalFilename: name,
        contentType,
        size,
        fetchedAt: at,
        lineage: { ...lineage, from: url.toString() },
        fetch: { status: 'fetched', at, bytes: size, name } satisfies FetchState,
      },
      [{ key, size }],
    )
    // A new file means new document pages for Ask once the text is pulled.
    clearKbIndex()
    void writeAudit({
      userId: job.userId,
      actor: job.actor,
      action: 'library.fetch',
      target: job.slug,
      detail: { url: url.toString(), ok: true, bytes: size, name },
    })
  } finally {
    // putFileFromPath renames the temp file into the mirror on success, so
    // this is a no-op then; every failure path depends on it.
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

// --- What the routes call -------------------------------------------------

/** The `fetch` block a link drop starts life with: 'queued' when the queue
 *  took it, 'later' when it was full. Both are honest, and both are visible. */
export function queueLinkFetch(job: Omit<LinkFetchJob, 'work'>): FetchState {
  const at = nowIso()
  const result = enqueueLinkJob({ ...job, work: 'fetch' })
  return result === 'queued'
    ? { status: 'queued', at }
    : { status: 'later', at, reason: 'the fetch queue is busy' }
}

/** Uploads get the suggestion pass too, and it is queued for the same reason
 *  a fetch is: extracting a 300-page PDF must not hold the upload response. */
export function queueSuggestion(job: Omit<LinkFetchJob, 'work'>): 'queued' | 'full' {
  return enqueueLinkJob({ ...job, work: 'suggest' })
}

/** P5-59 "Replicate now". Queued for the strongest version of the same reason:
 *  copying a whole dataset can take minutes, and no request waits for it. */
export function queueReplicate(job: Omit<LinkFetchJob, 'work'>): 'queued' | 'full' {
  return enqueueLinkJob({ ...job, work: 'replicate' })
}
