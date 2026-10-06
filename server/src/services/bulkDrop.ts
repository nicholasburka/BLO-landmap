import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { putFile, putFileFromPath } from './libraryBucket.js'
import { indexIncomingEntry } from './libraryCatalog.js'
import { contentTypeFor } from './contentTypes.js'
import { pickShapeFile, readShapeSignals, shapeFromSignals } from './shape.js'
import { sanitizeFilename } from './uploadFields.js'
import { enqueueLinkJob, type LinkFetchJob } from './linkFetchQueue.js'
import { ANNOTATE_COST_CENTS, annotateEntry, isAnnotateError, writeAnnotation, type AnnotateOutcome } from './annotateEntry.js'
import { applyInferredAtDrop } from './remediate.js'

/**
 * Many documents at once (P6-8).
 *
 * The difference between this and P5-10's single upload is not the storing —
 * that is the same bucket-first write, the same manifest, the same catalog row
 * — it is what happens next. A person who drops one file fills the form in
 * while they are there. A person who drops a folder of fifty cannot, so each
 * file gets a DETERMINISTIC FLOOR the moment it lands (its filename as its
 * title, its text extracted, its shape read off its own columns) and then a
 * queued model pass proposes the rest.
 *
 * Nothing the model says is applied. The drop's rows are a list of proposals
 * with an Accept button, and Accept is the ordinary filing call with the
 * ordinary audit row. The machine never writes to a manifest on its own.
 *
 * The drop registry is in-process and unpersisted, exactly like the fetch
 * queue: a restart loses the progress list, and that is fine — every file is
 * already in the bucket with its floor, filed `needs-review`, and the queue
 * page is not the truth.
 */

/** Caps, from the spec: 50 files, 100 MB each, 500 MB per drop. */
export const BULK_MAX_FILES = 50
export const BULK_MAX_FILE_BYTES = 100 * 1024 * 1024
export const BULK_MAX_DROP_BYTES = 500 * 1024 * 1024

export function bulkMaxFiles(): number {
  const raw = Number(process.env.LIBRARY_BULK_MAX_FILES)
  return Number.isInteger(raw) && raw > 0 ? raw : BULK_MAX_FILES
}

export function bulkMaxFileBytes(): number {
  const raw = Number(process.env.LIBRARY_BULK_MAX_FILE_BYTES)
  return Number.isInteger(raw) && raw > 0 ? raw : BULK_MAX_FILE_BYTES
}

export function bulkMaxDropBytes(): number {
  const raw = Number(process.env.LIBRARY_BULK_MAX_DROP_BYTES)
  return Number.isInteger(raw) && raw > 0 ? raw : BULK_MAX_DROP_BYTES
}

const INCOMING_PREFIX = 'library/incoming/'

/** Where a row is in the pass. `suggested` is the end state that matters:
 *  something was proposed and nobody has accepted it yet. */
export type BulkRowState = 'queued' | 'reading' | 'suggested' | 'failed'

export interface BulkRow {
  slug: string
  /** What the person will recognise: the name of the file they dropped. */
  file: string
  state: BulkRowState
  /** The deterministic floor's title — the filename, until someone accepts
   *  something better. */
  title: string
  /** failed: why, in words a reader can act on. */
  reason?: string
  /** The proposal, once there is one. Never applied by anything here. */
  suggested?: AnnotateOutcome
  /** What this row's model pass cost, in whole cents. 0 until it runs, and 0
   *  for a row whose pass could not run at all. */
  costCents: number
}

export interface BulkDrop {
  id: string
  userId: number | null
  actor: string
  at: string
  rows: BulkRow[]
}

// --- The registry ---------------------------------------------------------

const drops = new Map<string, BulkDrop>()
/** slug → drop id, so a finished job can find its row without a scan. */
const rowOwner = new Map<string, string>()

/** Drops older than this are forgotten. The page polls for minutes, not days,
 *  and the entries themselves are in the bucket. */
const DROP_TTL_MS = 6 * 60 * 60 * 1000

function forgetOldDrops(): void {
  const cutoff = Date.now() - DROP_TTL_MS
  for (const [id, drop] of drops) {
    if (Date.parse(drop.at) >= cutoff) continue
    for (const row of drop.rows) rowOwner.delete(row.slug)
    drops.delete(id)
  }
}

export function createBulkDrop(userId: number | null, actor: string): BulkDrop {
  forgetOldDrops()
  const drop: BulkDrop = { id: randomUUID(), userId, actor, at: new Date().toISOString(), rows: [] }
  drops.set(drop.id, drop)
  return drop
}

export function getBulkDrop(id: string): BulkDrop | null {
  return drops.get(id) ?? null
}

/** For tests, which share one process. */
export function resetBulkDrops(): void {
  drops.clear()
  rowOwner.clear()
}

function addRow(drop: BulkDrop, row: BulkRow): void {
  drop.rows.push(row)
  rowOwner.set(row.slug, drop.id)
}

/** Change one row wherever it lives. A slug with no row (a "Look again" on an
 *  ordinary entry) is not an error — there is simply no list to update. */
function patchRow(slug: string, patch: Partial<BulkRow>): void {
  const drop = drops.get(rowOwner.get(slug) ?? '')
  const row = drop?.rows.find(r => r.slug === slug)
  if (!row) return
  Object.assign(row, patch)
}

/** What the status route answers with: the rows, and the running total. */
export interface BulkDropStatus {
  dropId: string
  at: string
  rows: BulkRow[]
  /** True while any row is still queued or being read. */
  running: boolean
  counts: Record<BulkRowState, number>
  /** Whole cents spent on this drop so far. */
  spentCents: number
}

export function bulkDropStatus(drop: BulkDrop): BulkDropStatus {
  const counts: Record<BulkRowState, number> = { queued: 0, reading: 0, suggested: 0, failed: 0 }
  let spentCents = 0
  for (const row of drop.rows) {
    counts[row.state] += 1
    spentCents += row.costCents
  }
  return {
    dropId: drop.id,
    at: drop.at,
    rows: drop.rows,
    running: counts.queued > 0 || counts.reading > 0,
    counts,
    spentCents,
  }
}

// --- The deterministic floor ---------------------------------------------

/** A filename as a title: "2024_land-loss REPORT.pdf" → "2024 land-loss REPORT".
 *  The extension and the separators go; the words the person chose stay. */
export function titleFromFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const words = stem.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return words || base
}

/**
 * What kind of thing this file's data is, read off its own header row.
 *
 * Only for a file whose columns can say. A PDF has no columns, and guessing
 * `records` for one would put a report in a dataset browser's "Records without
 * a location" group — so an unreadable shape is simply absent, and the
 * reindex's own derivation stays the fallback.
 */
export async function shapeOfFile(storedName: string, readHead: () => Promise<string>): Promise<string | null> {
  if (!pickShapeFile([storedName])) return null
  try {
    return shapeFromSignals(readShapeSignals(storedName, await readHead()))
  } catch (err: any) {
    console.warn('[library] could not read', storedName, 'to work out its shape —', err?.message || err)
    return null
  }
}

/** Bytes of a table we read to find its columns. The header line is all that
 *  is wanted; a GeoJSON needs enough of its first features to see a geometry. */
export const SHAPE_HEAD_BYTES = 64 * 1024

async function headOf(path: string): Promise<string> {
  const handle = await fs.open(path, 'r')
  try {
    const buffer = Buffer.alloc(SHAPE_HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SHAPE_HEAD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export interface DroppedFile {
  /** Where the bytes are right now — a temp file the route streamed them to. */
  tempPath: string
  /** What the browser called it. A folder drop sends a relative path here. */
  originalFilename: string
  contentType: string
  size: number
}

export interface StoreOptions {
  userId: number | null
  actor: string
  /** One entry holding every file, rather than one entry per file. */
  collection?: boolean
  /**
   * The collection's title.
   *
   * A browser sending a folder puts the BASENAME in each part's filename —
   * the folder is only in `webkitRelativePath`, which never leaves the page —
   * so the folder's own name arrives here, from the drop form, or not at all.
   * Without one the entry is "N documents" until somebody names it.
   */
  collectionTitle?: string
}

/** One file, stored with its floor and added to the drop as a queued row. */
async function storeOne(drop: BulkDrop, file: DroppedFile, options: StoreOptions): Promise<void> {
  const slug = randomUUID()
  const storedName = sanitizeFilename(file.originalFilename)
  const key = `${INCOMING_PREFIX}${slug}/${storedName}`
  const metaKey = `${INCOMING_PREFIX}${slug}/meta.json`
  const shape = await shapeOfFile(storedName, () => headOf(file.tempPath))

  const meta: Record<string, unknown> = {
    title: titleFromFilename(file.originalFilename),
    category: '',
    // Filed, not queued for cataloguing: the floor IS a filing, and the drop
    // is a review queue with a proposal on every row.
    status: 'needs-review',
    tags: [],
    ...(shape ? { shape } : {}),
    uploadedBy: options.actor,
    uploadedById: options.userId,
    uploadedAt: new Date().toISOString(),
    originalFilename: file.originalFilename,
    contentType: file.contentType,
    size: file.size,
    bulkDrop: drop.id,
  }

  await putFileFromPath(key, file.tempPath, file.size, contentTypeFor(storedName))
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  await indexIncomingEntry(slug, meta, [
    { key, size: file.size },
    { key: metaKey, size: Buffer.byteLength(metaJson) },
  ])

  addRow(drop, {
    slug,
    file: file.originalFilename,
    state: 'queued',
    title: meta.title as string,
    costCents: 0,
  })
}

/** Every file under one entry (the "keep as one collection" tick). */
async function storeCollection(drop: BulkDrop, files: DroppedFile[], options: StoreOptions): Promise<void> {
  const slug = randomUUID()
  const metaKey = `${INCOMING_PREFIX}${slug}/meta.json`
  const stored: { key: string; size: number }[] = []
  const used = new Set<string>(['meta.json'])

  for (const file of files) {
    const name = uniqueName(sanitizeFilename(file.originalFilename), used)
    const key = `${INCOMING_PREFIX}${slug}/${name}`
    await putFileFromPath(key, file.tempPath, file.size, contentTypeFor(name))
    stored.push({ key, size: file.size })
  }

  const title = (options.collectionTitle ?? '').trim() || `${files.length} documents`
  const meta: Record<string, unknown> = {
    title,
    category: '',
    status: 'needs-review',
    tags: [],
    uploadedBy: options.actor,
    uploadedById: options.userId,
    uploadedAt: new Date().toISOString(),
    fileCount: files.length,
    bulkDrop: drop.id,
    collection: true,
  }
  const metaJson = JSON.stringify(meta, null, 2)
  await putFile(metaKey, metaJson, 'application/json')
  await indexIncomingEntry(slug, meta, [...stored, { key: metaKey, size: Buffer.byteLength(metaJson) }])

  addRow(drop, {
    slug,
    file: `${files.length} files`,
    state: 'queued',
    title,
    costCents: 0,
  })
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name)
    return name
  }
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}${ext}`
    if (used.has(candidate)) continue
    used.add(candidate)
    return candidate
  }
}

/**
 * Store everything, then queue one annotation per entry.
 *
 * Storing is awaited (the person's files are safe before the request answers);
 * annotating is not (reading fifty PDFs and asking a model fifty times is not
 * something anybody watches a spinner for).
 */
export async function storeBulkDrop(
  drop: BulkDrop,
  files: DroppedFile[],
  options: StoreOptions,
  seams: Pick<LinkFetchJob, 'annotate' | 'assistant'> & { clientIp?: string } = {},
): Promise<BulkDropStatus> {
  if (options.collection) await storeCollection(drop, files, options)
  else for (const file of files) await storeOne(drop, file, options)

  for (const row of drop.rows) {
    const queued = enqueueLinkJob({
      slug: row.slug,
      work: 'annotate',
      userId: options.userId,
      actor: options.actor,
      ...(seams.clientIp ? { clientIp: seams.clientIp } : {}),
      ...(seams.annotate ? { annotate: seams.annotate } : {}),
      ...(seams.assistant ? { assistant: seams.assistant } : {}),
    })
    if (queued === 'full') {
      patchRow(row.slug, {
        state: 'failed',
        reason: 'the queue was busy — press Look again',
      })
    }
  }
  return bulkDropStatus(drop)
}

// --- The queued pass ------------------------------------------------------

/**
 * One annotation job: mark the row, read the document, store the proposal.
 *
 * Every ending is a state a person can act on. A model that cannot be reached
 * leaves the entry exactly as it landed — floor intact, nothing lost — with
 * the honesty line on the row and Look again beside it (spec Example 3).
 */
export async function runAnnotateJob(job: LinkFetchJob): Promise<void> {
  patchRow(job.slug, { state: 'reading' })
  let outcome: AnnotateOutcome | null
  try {
    outcome = await annotateEntry(job.slug, {
      ...(job.assistant ? { client: job.assistant } : {}),
      ...(job.clientIp ? { clientIp: job.clientIp } : {}),
    })
  } catch (err: any) {
    console.warn('[library] annotation failed for', job.slug, '—', err?.message || err)
    patchRow(job.slug, { state: 'failed', reason: 'the pass did not finish — try again' })
    return
  }
  if (!outcome) {
    // The spec's scanned image: the file is in, and there was nothing to read.
    patchRow(job.slug, { state: 'failed', reason: 'no text could be read' })
    return
  }
  // P6-34: the whole answer is still stored as the suggestion and still waits
  // to be accepted — except the fields `applyInferredAtDrop` writes now (the
  // topic, and P7-7's answers line), each with its evidence and each on the
  // verification queue. An entry with no topic is invisible to the topic
  // facet, to Chat and to any working set scoped by subject, so remediation
  // runs on ingest rather than waiting for somebody to press Accept.
  await writeAnnotation(job.slug, outcome)
  if (!isAnnotateError(outcome)) await applyInferredAtDrop(job.slug, outcome)
  if (isAnnotateError(outcome)) {
    patchRow(job.slug, { state: 'failed', reason: 'no model pass', suggested: outcome })
    return
  }
  patchRow(job.slug, {
    state: 'suggested',
    suggested: outcome,
    costCents: ANNOTATE_COST_CENTS,
    ...(outcome.title ? { title: outcome.title } : {}),
  })
}

/** Queue a pass for one entry — the New page's and the entry page's
 *  "Look again". Returns 'full' when the queue is at its bound. */
export function queueAnnotate(job: Omit<LinkFetchJob, 'work'>): 'queued' | 'full' {
  const result = enqueueLinkJob({ ...job, work: 'annotate' })
  if (result === 'queued') patchRow(job.slug, { state: 'queued', reason: undefined })
  return result
}
