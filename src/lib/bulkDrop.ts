import { internalFetch } from './apiBase'
import {
  fileCatalogEntry,
  formatBytes,
  invalidateCatalogCache,
  type CatalogEntry,
} from './libraryCatalog'

/**
 * Many documents at once (P6-8), from the browser's side.
 *
 * The drop is a POST of files and a poll of one status route. Everything else
 * here is the arithmetic the page shows: what it will cost before you start,
 * what it has cost so far, and whether a batch is even allowed before a
 * megabyte leaves the machine.
 *
 * Accepting is deliberately NOT a new call. `accept` is the same
 * `fileCatalogEntry` the filing form has always used, so a bulk-accepted entry
 * and a hand-filed one leave the same audit row behind.
 */

/** The server's caps, mirrored so the page can refuse a hopeless drop before
 *  uploading it. The server enforces them; these only save a wasted upload. */
export const BULK_MAX_FILES = 50
export const BULK_MAX_FILE_BYTES = 100 * 1024 * 1024
export const BULK_MAX_DROP_BYTES = 500 * 1024 * 1024

/**
 * What one file's model pass costs, in whole cents.
 *
 * Mirrors `ANNOTATE_COST_CENTS` on the server, which derives it from the pass
 * itself: ~1,500 tokens of document plus a ~900-token prompt, capped at a
 * 600-token answer, on the Ask model's rates. DEPLOY.md prices a whole Ask
 * question — a far bigger prompt with tool rounds — at about a cent and a half.
 */
export const ANNOTATE_COST_CENTS = 1

export type BulkRowState = 'queued' | 'reading' | 'suggested' | 'failed'

/** What the model proposed. Every field is optional and none of it is applied
 *  until a person presses Accept. */
export interface Annotation {
  title?: string
  summary?: string
  category?: string
  topic?: string
  purpose?: string
  organization?: string
  shape?: string
  tags?: string[]
  at?: string
  model?: string
  basis?: 'head'
  /** Set instead of the fields when the model could not be asked. */
  error?: 'unavailable'
  reason?: string
}

export interface BulkRow {
  slug: string
  file: string
  state: BulkRowState
  title: string
  reason?: string
  suggested?: Annotation
  costCents: number
}

export interface BulkDropStatus {
  dropId: string
  at: string
  rows: BulkRow[]
  running: boolean
  counts: Record<BulkRowState, number>
  spentCents: number
  /** Only on the answer to the drop itself: what it is expected to cost. */
  estimateCents?: number
}

/** A proposal with something in it — an `unavailable` marker is not one. */
export function hasProposal(row: BulkRow): boolean {
  const suggested = row.suggested
  if (!suggested || suggested.error) return false
  return !!(suggested.title || suggested.summary || suggested.category || suggested.tags?.length)
}

// --- What it costs ---------------------------------------------------------

export function estimateCents(fileCount: number): number {
  return Math.max(0, Math.round(fileCount)) * ANNOTATE_COST_CENTS
}

/** "about 12¢" / "about $1.20". Always hedged, because it IS an estimate. */
export function formatCents(cents: number): string {
  if (cents < 100) return `about ${cents}¢`
  return `about $${(cents / 100).toFixed(2)}`
}

// --- What may be dropped ---------------------------------------------------

/** The first thing wrong with this selection, in words, or null when it is
 *  fine. Checked here so a 600 MB folder is refused before it is uploaded. */
export function checkBulkFiles(files: readonly File[]): string | null {
  if (!files.length) return 'Choose a folder or some files first.'
  if (files.length > BULK_MAX_FILES) {
    return `That is ${files.length} files. Drop at most ${BULK_MAX_FILES} at a time.`
  }
  const big = files.find(f => f.size > BULK_MAX_FILE_BYTES)
  if (big) return `"${big.name}" is too large — the limit is ${formatBytes(BULK_MAX_FILE_BYTES)} per file.`
  const total = files.reduce((sum, f) => sum + f.size, 0)
  if (total > BULK_MAX_DROP_BYTES) {
    return `That is ${formatBytes(total)} in one go — the limit is ${formatBytes(BULK_MAX_DROP_BYTES)}. Send it in a few smaller batches.`
  }
  return null
}

/** The folder a `webkitdirectory` selection came from, when it came from one.
 *  The browser only puts it on `webkitRelativePath`; the upload itself carries
 *  basenames, so this is the only chance to learn the folder's name. */
export function folderNameOf(files: readonly File[]): string {
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''
    const folder = relative.split('/')[0]
    if (folder && folder !== file.name) return folder
  }
  return ''
}

// --- The calls -------------------------------------------------------------

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    /* non-JSON error body */
  }
  return fallback
}

export interface BulkDropInput {
  /** One entry holding every file, rather than one entry per file. */
  collection?: boolean
  collectionTitle?: string
}

export async function startBulkDrop(files: readonly File[], input: BulkDropInput = {}): Promise<BulkDropStatus> {
  const refusal = checkBulkFiles(files)
  if (refusal) throw new Error(refusal)
  const form = new FormData()
  if (input.collection) form.set('collection', '1')
  if (input.collectionTitle?.trim()) form.set('collectionTitle', input.collectionTitle.trim())
  for (const file of files) form.append('files', file, file.name)
  const res = await internalFetch('/api/library/bulk', { method: 'POST', body: form })
  if (!res.ok) throw new Error(await errorMessage(res, `the drop did not land (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()) as BulkDropStatus
}

export async function fetchBulkStatus(dropId: string): Promise<BulkDropStatus> {
  const res = await internalFetch(`/api/library/bulk/${encodeURIComponent(dropId)}`)
  if (!res.ok) throw new Error(await errorMessage(res, `could not read the drop (${res.status})`))
  return (await res.json()) as BulkDropStatus
}

/** "Look again" — re-run one entry's pass. */
export async function annotateAgain(slug: string): Promise<void> {
  const res = await internalFetch(`/api/library/entries/${encodeURIComponent(slug)}/annotate`, { method: 'POST' })
  if (!res.ok) throw new Error(await errorMessage(res, `the pass could not be started (${res.status})`))
  invalidateCatalogCache()
}

/** The fields an Accept (or an edited Accept) writes. Plain strings, never
 *  undefined, because the Edit form binds straight to them. */
export interface AcceptedFiling {
  title: string
  category: string
  /** Comma-separated, exactly as every other filing form stores them. */
  tags: string
  description: string
  /** P6-8a: the publisher id and the shape, when the proposal (or the person)
   *  named them. '' or absent means "not set". */
  organization?: string
  shape?: string
}

/** What Accept would write, straight from the proposal. Exported so the Edit
 *  form can start from exactly the values Accept would have applied. */
export function filingFrom(suggested: Annotation | undefined): AcceptedFiling {
  return {
    title: suggested?.title ?? '',
    category: suggested?.category ?? '',
    tags: (suggested?.tags ?? []).join(', '),
    description: suggested?.summary ?? '',
    ...(suggested?.organization ? { organization: suggested.organization } : {}),
    ...(suggested?.shape ? { shape: suggested.shape } : {}),
  }
}

/**
 * Apply a filing to one entry — the ordinary filing call, on purpose.
 *
 * Accept and "edit, then save" are the same write: the only difference is
 * whose words are in the fields. Nothing else in this file writes anything.
 */
export async function acceptFiling(slug: string, filing: AcceptedFiling): Promise<CatalogEntry> {
  return fileCatalogEntry(slug, {
    ...(filing.title.trim() ? { title: filing.title.trim() } : {}),
    category: filing.category.trim(),
    tags: filing.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean),
    description: filing.description.trim(),
    ...(filing.organization ? { organization: filing.organization } : {}),
    ...(filing.shape ? { shape: filing.shape } : {}),
  })
}
