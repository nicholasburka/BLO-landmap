import { getFile, putFile, isBucketEnabled } from './libraryBucket.js'
import { libraryQuery, isLibraryEnabled } from './libraryDb.js'
import { getCatalogEntry, indexFileBackedEntry, type CatalogEntryDetail } from './libraryCatalog.js'
import { inspectionSummary, type Inspection } from './linkInspect.js'
import type { IngestPlan } from './ingestPlan.js'

/**
 * Change one field on any entry's manifest, whatever kind it is (P5-59).
 *
 * The inspection, the ingest plan and the replication status all land on
 * entries that may be `incoming`, `source` or `dataset`, which live under three
 * different bucket prefixes. `linkFetchQueue`'s own writer only knows about
 * `library/incoming/`, so rather than teach it two more prefixes this finds the
 * manifest through the catalog row's own file list — the one place that already
 * knows where an entry's files are.
 *
 * Order is the same everywhere in this codebase: BUCKET FIRST, then the row
 * replaced by delete + insert, so a reindex reproduces exactly what the bucket
 * says and the browser sees the change without waiting for one.
 */

export interface EntryManifest {
  entry: CatalogEntryDetail
  metaKey: string
  meta: Record<string, unknown>
}

/** The entry, where its manifest lives, and the manifest read FRESH — a CLI
 *  push can have changed it behind us, and the mirror would serve the stale
 *  copy (the staleness rule reindex learned the hard way in P5-13). */
export async function readEntryManifest(slug: string): Promise<EntryManifest | null> {
  if (!isBucketEnabled()) return null
  const entry = await getCatalogEntry(slug)
  if (!entry) return null
  const metaKey = entry.files.find(f => f.key.endsWith('/meta.json'))?.key
  if (!metaKey) return null
  try {
    const parsed = JSON.parse((await getFile(metaKey, { fresh: true })).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return { entry, metaKey, meta: parsed as Record<string, unknown> }
  } catch {
    // Deleted or unreadable between the row and the read: nothing to patch.
    return null
  }
}

/**
 * Apply `patch` to the entry's manifest and store the result.
 *
 * `patch` returns the WHOLE new manifest (or null to leave it alone), so a
 * caller that wants to delete a key can. Returns the stored manifest, or null
 * when there was nothing to patch.
 */
export async function patchEntryManifest(
  slug: string,
  patch: (meta: Record<string, unknown>, entry: CatalogEntryDetail) => Record<string, unknown> | null,
): Promise<Record<string, unknown> | null> {
  const current = await readEntryManifest(slug)
  if (!current) return null
  const next = patch(current.meta, current.entry)
  if (!next) return null

  const json = JSON.stringify(next, null, 2)
  await putFile(current.metaKey, json, 'application/json')
  if (!isLibraryEnabled()) return next

  const files = current.entry.files.map(f =>
    f.key === current.metaKey ? { key: f.key, size: Buffer.byteLength(json) } : f,
  )
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await indexFileBackedEntry(current.entry.kind, slug, next, files)
  return next
}

/**
 * Store what a probe found. Data, never applied: the entry's title, category
 * and status are untouched, exactly like the P5-47 suggestion beside it.
 */
export async function writeInspection(slug: string, inspection: Inspection): Promise<Record<string, unknown> | null> {
  // The summary is stored, not recomputed: naming the state an extent covers
  // needs a table of bounding boxes, and that table stays on the server.
  const stored: Inspection = { ...inspection, summary: inspectionSummary(inspection) }
  return patchEntryManifest(slug, meta => ({ ...meta, inspection: stored }))
}

/** Store the ingest decision. Only ever called behind `requireAdmin`. */
export async function writeIngestPlan(slug: string, plan: IngestPlan): Promise<Record<string, unknown> | null> {
  return patchEntryManifest(slug, meta => ({ ...meta, ingest: plan }))
}
