/**
 * Working sets (P7-1) — the store.
 *
 * The shape lives in `workingSetMeta.ts` (pure, so `libraryCatalog` can
 * normalise a row without importing this back). This file is the bucket-first
 * write, the catalog-row read, and the one question the whole ticket exists to
 * answer:
 *
 * `/place` runs **every applicable source** — 40 of them — because
 * `applicableSources` filters with `fitsPlace` and nothing else, which is a
 * question about *where* and never about *what was asked*.
 * `workingSetMemberSlugs` is the answer: run the report inside a set and it
 * asks that set's sources, 11 instead of 40.
 */

import { putFile, isBucketEnabled, listFiles } from './libraryBucket.js'
import { libraryQuery } from './libraryDb.js'
import {
  getCatalogEntry,
  indexFileBackedEntry,
  searchCatalog,
  slugify,
  type CatalogEntryRow,
} from './libraryCatalog.js'
import {
  MEMBER_KINDS,
  WORKING_SET_DATASETS_MAX,
  WORKING_SET_KIND,
  WORKING_SET_LAYERS_MAX,
  WORKING_SET_PURPOSE_MAX,
  readWorkingSet,
  workingSetKey,
  workingSetManifest,
  workingSetPrefix,
  type WorkingSetDoc,
} from './workingSetMeta.js'

export interface WorkingSet extends WorkingSetDoc {
  slug: string
  /** When the manifest was last written — the catalog row's own stamp. */
  updatedAt?: string
}

/** De-duplicated, trimmed, capped. The route has already refused anything
 *  that is not a slug; this is the belt. */
function members(value: string[] | undefined, max: number): string[] {
  const out: string[] = []
  for (const item of value ?? []) {
    const trimmed = item.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

function withAnchor(datasets: string[], sites: string | null): string[] {
  if (!sites || datasets.includes(sites)) return datasets
  return [sites, ...datasets].slice(0, WORKING_SET_DATASETS_MAX)
}

/**
 * Every file the set's directory holds, as the row has to list them.
 *
 * Reindex groups **all** files under `library/working-sets/<slug>/` onto the
 * entry and sums their bytes, so a row that listed only `meta.json` would
 * differ from the one the next reindex rebuilds — which is the single
 * invariant P7-1's design note stands on. P7-5 is the first writer to put a
 * second file in there (`derived/<id>.json`), so the list is read from the
 * same place reindex reads it rather than being kept in step by hand.
 *
 * The manifest is forced into the list because it was written a moment ago and
 * a listing is the one call here that could lag behind its own write.
 */
async function workingSetFiles(slug: string, manifestKey: string, manifestSize: number) {
  const files = [{ key: manifestKey, size: manifestSize }]
  try {
    for (const file of await listFiles(workingSetPrefix(slug))) {
      if (file.key === manifestKey) continue
      files.push({ key: file.key, size: file.size })
    }
  } catch {
    // A listing that fails must not fail the write: the manifest is the row's
    // truth and a reindex repairs the file list. Losing the set would be worse.
  }
  return files
}

/** Bucket-first, then the row — the library's one write order, so a reindex
 *  rebuilds an identical row from the bucket alone. Delete + insert rather
 *  than UPDATE, like `patchEntryManifest` and every other row rewrite here:
 *  it mirrors what a reindex does and stays pg-mem-portable. */
async function writeWorkingSet(slug: string, doc: WorkingSetDoc): Promise<void> {
  const manifest = workingSetManifest(doc)
  const json = JSON.stringify(manifest, null, 2)
  const key = workingSetKey(slug)
  await putFile(key, json, 'application/json')
  await libraryQuery(`DELETE FROM library_catalog WHERE slug = $1`, [slug])
  await indexFileBackedEntry(
    WORKING_SET_KIND,
    slug,
    manifest,
    await workingSetFiles(slug, key, Buffer.byteLength(json)),
  )
}

/**
 * How big a column's values may be before they go in a file of their own.
 *
 * A county-keyed column tops out at 3,142 entries — about 50 kB of JSON — so
 * in practice a proximity column fits on the manifest, and inline is the
 * better place for it: one read, and the manifest stays the whole truth about
 * the set. The threshold exists because P7-1 made the set a directory
 * precisely so a column that does NOT fit has somewhere to land, and a path
 * nothing ever takes is a path nobody can trust. P7-2 resolves both shapes
 * through one route, so neither tier needs to know which was used.
 */
export const DERIVED_INLINE_MAX_BYTES = 64 * 1024

/**
 * A column as P7-5 writes it.
 *
 * `analysis` is the record of what produced it — the type, the inputs, the
 * parameters. It rides on the manifest verbatim (`readWorkingSet` carries
 * `derived` through untouched) and is what lets a re-run recognise that it has
 * already been asked this exact question. It is **not** a cache key: no hash,
 * no clock, just the parameters written down where a person can read them.
 * P7-6 adds the input *versions* to the same record and the staleness that
 * follows from them.
 */
export interface DerivedColumnWrite {
  id: string
  label: string
  unit: string
  method: string
  values: Record<string, number>
  /** Carried verbatim: the store does not inspect what produced a column, it
   *  only promises not to lose it. */
  analysis?: unknown
}

/**
 * Write derived columns onto a set, replacing any with the same id.
 *
 * **The only writer of `derived`, and it touches neither source dataset** —
 * which is the provenance rule the whole ticket turns on (spec §F.2): the
 * analysis output is a column on the set, so each source stays exactly as
 * fetched and stays re-fetchable. Everything else about the set is carried
 * through verbatim, the mirror image of `updateWorkingSet` leaving `derived`
 * alone.
 */
export async function putDerivedColumns(
  slug: string,
  columns: readonly DerivedColumnWrite[],
  extraFiles: readonly { key: string; body: string }[] = [],
): Promise<WorkingSet | null> {
  const existing = await getWorkingSet(slug)
  if (!existing) return null
  const computedAt = new Date().toISOString()

  const docs: Record<string, unknown>[] = []
  for (const column of columns) {
    const inline = JSON.stringify(column.values)
    const base = {
      id: column.id,
      label: column.label,
      unit: column.unit,
      method: column.method,
      computedAt,
      ...(column.analysis ? { analysis: column.analysis } : {}),
    }
    if (Buffer.byteLength(inline) <= DERIVED_INLINE_MAX_BYTES) {
      docs.push({ ...base, values: column.values })
      continue
    }
    const file = `derived/${column.id}.json`
    await putFile(`${workingSetPrefix(slug)}${file}`, inline, 'application/json')
    docs.push({ ...base, file })
  }

  for (const file of extraFiles) {
    await putFile(`${workingSetPrefix(slug)}${file.key}`, file.body, 'application/json')
  }

  // Replace by id, in place, so a re-run does not shuffle the column order a
  // table's headers are drawn in.
  const kept = Array.isArray(existing.derived) ? [...existing.derived] : []
  const idOf = (item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item) ? (item as { id?: unknown }).id : undefined
  for (const doc of docs) {
    const at = kept.findIndex(item => idOf(item) === doc.id)
    if (at >= 0) kept[at] = doc
    else kept.push(doc)
  }

  const doc: WorkingSetDoc = { ...existing, derived: kept }
  await writeWorkingSet(slug, doc)
  return { ...doc, slug }
}

export interface WorkingSetInput {
  name: string
  purpose?: string
  datasets?: string[]
  layers?: string[]
  sites?: string | null
  fromView?: string
  savedBy: string
  savedById: number | null
}

export type WorkingSetCreateResult =
  | { error: 'bad-name' }
  | { error?: undefined; slug: string; name: string }

/**
 * Create a set. The server owns the slug (slugify + collision suffix), exactly
 * as it does for a note and for a view, so two people naming a set the same
 * thing get two sets rather than one overwriting the other.
 */
export async function createWorkingSet(input: WorkingSetInput): Promise<WorkingSetCreateResult> {
  const name = input.name.trim()
  const base = slugify(name)
  if (!base) return { error: 'bad-name' }
  let slug = base
  for (let n = 2; await getCatalogEntry(slug); n++) slug = `${base}-${n}`

  const sites = input.sites ? input.sites.trim() : null
  const doc: WorkingSetDoc = {
    title: name,
    purpose: (input.purpose ?? '').trim().slice(0, WORKING_SET_PURPOSE_MAX),
    datasets: withAnchor(members(input.datasets, WORKING_SET_DATASETS_MAX), sites),
    layers: members(input.layers, WORKING_SET_LAYERS_MAX),
    sites,
    savedBy: input.savedBy,
    savedById: input.savedById,
    savedAt: new Date().toISOString(),
    ...(input.fromView ? { fromView: input.fromView } : {}),
  }
  await writeWorkingSet(slug, doc)
  return { slug, name }
}

export interface WorkingSetUpdates {
  name?: string
  purpose?: string
  datasets?: string[]
  layers?: string[]
  sites?: string | null
}

/**
 * Replace the named fields of a set; leave the rest exactly as they were.
 *
 * `derived`, `savedBy`, `savedById`, `savedAt` and `fromView` are never touched
 * here. **A derived column surviving an edit is the point** — P7-6 keys a
 * stored result on its inputs, and adding a twelfth dataset to a set must not
 * silently throw away the proximity column somebody is already quoting.
 */
export async function updateWorkingSet(slug: string, updates: WorkingSetUpdates): Promise<WorkingSet | null> {
  const existing = await getWorkingSet(slug)
  if (!existing) return null
  const name = updates.name?.trim()
  const sites = updates.sites === undefined ? existing.sites : updates.sites ? updates.sites.trim() : null
  const datasets =
    updates.datasets === undefined ? existing.datasets : members(updates.datasets, WORKING_SET_DATASETS_MAX)
  const doc: WorkingSetDoc = {
    ...existing,
    ...(name ? { title: name } : {}),
    ...(updates.purpose === undefined ? {} : { purpose: updates.purpose.trim().slice(0, WORKING_SET_PURPOSE_MAX) }),
    datasets: withAnchor(datasets, sites),
    ...(updates.layers === undefined ? {} : { layers: members(updates.layers, WORKING_SET_LAYERS_MAX) }),
    sites,
  }
  await writeWorkingSet(slug, doc)
  return { ...doc, slug }
}

/** Read one set. The catalog row is the existence check and its meta is the
 *  manifest, so a slug that names something else reads as missing. */
export async function getWorkingSet(slug: string): Promise<WorkingSet | null> {
  const entry = await getCatalogEntry(slug)
  if (!entry || entry.kind !== WORKING_SET_KIND) return null
  return { ...readWorkingSet(entry.meta, slug), slug, updatedAt: entry.updatedAt }
}

/** Every set. Catalog order (most recently written first). */
export async function listWorkingSets(): Promise<WorkingSet[]> {
  const rows = await searchCatalog({ kind: WORKING_SET_KIND })
  return rows.map(row => ({ ...readWorkingSet(row.meta, row.slug), slug: row.slug, updatedAt: row.updatedAt }))
}

/**
 * The catalog slugs a set names, or null when there is no such set.
 *
 * This is what scopes an analysis. `applicableSources` already takes a
 * shortlist and already filters to `kind: 'source'`, so handing it a set's
 * members asks exactly the set's sources and nothing else — a set that also
 * names five held tables does not make the report ask five more agencies.
 *
 * **Null and empty are different answers and both matter:** "there is no such
 * set" is a typo to report back, and "this set names nothing yet" is a
 * half-built set to report back. Neither may quietly become "run all forty".
 */
export async function workingSetMemberSlugs(slug: string): Promise<string[] | null> {
  const set = await getWorkingSet(slug)
  return set ? set.datasets : null
}

/**
 * The entries a set names, in the set's own order, with the slugs that no
 * longer resolve named separately.
 *
 * A member can go missing — an entry archived, a slug renamed — and the honest
 * reading of that is "this set names something the library no longer has",
 * never a silently shorter set. P6-23's rule: a count must not disagree with
 * the list it opens.
 */
export async function workingSetMembers(
  set: Pick<WorkingSet, 'datasets'>,
): Promise<{ entries: CatalogEntryRow[]; missing: string[] }> {
  const entries: CatalogEntryRow[] = []
  const missing: string[] = []
  for (const slug of set.datasets) {
    const entry = await getCatalogEntry(slug)
    if (entry && (MEMBER_KINDS as readonly string[]).includes(entry.kind)) entries.push(entry)
    else missing.push(slug)
  }
  return { entries, missing }
}

/** Is the bucket there? A set is a bucket document first, so every writer has
 *  to be able to say no. */
export function workingSetsAvailable(): boolean {
  return isBucketEnabled()
}
