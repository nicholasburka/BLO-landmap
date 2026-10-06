/**
 * Working-set manifests (P7-1) — the shape, and nothing that touches storage.
 *
 * Spec §F.1. A **working set** is the compound data object an analysis runs
 * against: the datasets in it, the sites that anchor it, and the derived
 * columns P7-5 writes onto it. **It holds no framing** — no viewport, no sort,
 * no palette. Those belong to a saved view, and a set may carry several views,
 * which is the whole reason the two are different objects: every view reads the
 * same rows and the same derived columns, so none of them can disagree about a
 * number.
 *
 * Pure — no imports — for the same reason `sourceMeta.ts` is: `libraryCatalog`
 * has to normalise a row at reindex time without this module importing it back.
 */

export const WORKING_SET_KIND = 'working-set'

/** Where a working set lives. One DIRECTORY per set, manifest inside it.
 *
 * A saved view is a flat document; a set is not, deliberately. A view is
 * written once and read; a set is EDITED — members added as sourcing
 * progresses, derived columns written onto it by P7-5 — so it takes the nested
 * manifest layout the rest of the library uses, which `patchEntryManifest` and
 * `indexFileBackedEntry` already serve, and which leaves room for a large
 * derived column to land as a file beside the manifest instead of inside a
 * catalog row. */
export const WORKING_SETS_PREFIX = 'library/working-sets/'

/** The category every set is filed under. */
export const WORKING_SET_CATEGORY = 'working-sets'

/**
 * How many datasets a set may name.
 *
 * The workbook's set is 11. A hundred is far past any curated set and well
 * past the place report's own 50-source ceiling, so this guards a runaway
 * write rather than limiting anything anybody will build. A set that wanted a
 * thousand datasets would not be a working set.
 */
export const WORKING_SET_DATASETS_MAX = 100
export const WORKING_SET_LAYERS_MAX = 50
export const WORKING_SET_PURPOSE_MAX = 500

/** The kinds that can be a member: the two things with rows in them. A
 *  document, a note or a page is not a dataset and must not be filed as one. */
export const MEMBER_KINDS = ['dataset', 'source'] as const

/**
 * A working set, as stored.
 *
 * `derived` is P7-5/P7-6's and is **preserved verbatim** by every writer: the
 * set is where a derived column belongs (never a view), so the field exists
 * before the analysis that fills it, and nothing in P7-1 stands on its shape.
 * Absent means none have been computed — the stated-absence rule `siteLayers`
 * follows in `src/lib/views.ts`.
 */
export interface WorkingSetDoc {
  title: string
  /** What this set is for, in one line. '' when nobody said. */
  purpose: string
  /** Catalog slugs — held datasets and indexed sources, in the order given. */
  datasets: string[]
  /** Map layer ids: the public registry's, and `internal-<slug>` for a held
   *  dataset's own layer. */
  layers: string[]
  /** The held dataset whose rows the set is about, or null. Always also one of
   *  `datasets` — an anchor is a member by definition. */
  sites: string | null
  /** P7-5's columns. Written by analysis, never by a person, never by a view. */
  derived?: unknown[]
  savedBy: string
  savedById: number | null
  savedAt: string
  /** The saved view this set was promoted from, when it came into being that
   *  way (P7-1's promote action). */
  fromView?: string
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
    if (out.length >= max) break
  }
  return out
}

/** The anchor is a member by definition: a manifest that dropped it out of the
 *  list (hand-edited, hand-pushed) gets it put back rather than anchoring a set
 *  on something it does not contain. */
function withAnchor(datasets: string[], sites: string | null): string[] {
  if (!sites || datasets.includes(sites)) return datasets
  return [sites, ...datasets].slice(0, WORKING_SET_DATASETS_MAX)
}

/**
 * Read a manifest as a working set, dropping what cannot be understood.
 *
 * Tolerant on purpose — the rule `readSiteLayers` and `tableStateOf` already
 * follow. A manifest can be hand-edited or hand-pushed, and a set that names
 * one impossible thing has to keep opening rather than break the catalog. The
 * ROUTE validates on the way in, which is where a refusal can say something
 * a person can act on.
 */
export function readWorkingSet(meta: Record<string, unknown>, slug: string): WorkingSetDoc {
  const sites = typeof meta.sites === 'string' && meta.sites.trim() ? meta.sites.trim() : null
  return {
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : slug,
    purpose: typeof meta.purpose === 'string' ? meta.purpose.trim().slice(0, WORKING_SET_PURPOSE_MAX) : '',
    datasets: withAnchor(strings(meta.datasets, WORKING_SET_DATASETS_MAX), sites),
    layers: strings(meta.layers, WORKING_SET_LAYERS_MAX),
    sites,
    ...(Array.isArray(meta.derived) ? { derived: meta.derived } : {}),
    savedBy: typeof meta.savedBy === 'string' ? meta.savedBy : '',
    savedById: typeof meta.savedById === 'number' ? meta.savedById : null,
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
    ...(typeof meta.fromView === 'string' && meta.fromView ? { fromView: meta.fromView } : {}),
  }
}

/**
 * The one line a card, ⌘K row or `search_library` result reads.
 *
 * Counts, not names: a set of eleven cannot list them in a sentence, and the
 * count is the thing that says whether sourcing is done. The purpose leads when
 * there is one, because that is what the set IS.
 */
export function describeWorkingSet(doc: WorkingSetDoc): string {
  const parts: string[] = ['Working set']
  if (doc.purpose) parts.push(doc.purpose)
  parts.push(`${doc.datasets.length} ${doc.datasets.length === 1 ? 'dataset' : 'datasets'}`)
  if (doc.layers.length) parts.push(`${doc.layers.length} ${doc.layers.length === 1 ? 'layer' : 'layers'}`)
  if (doc.sites) parts.push(`anchored on ${doc.sites}`)
  const derived = Array.isArray(doc.derived) ? doc.derived.length : 0
  if (derived) parts.push(`${derived} derived ${derived === 1 ? 'column' : 'columns'}`)
  return parts.join(' · ')
}

/**
 * The manifest a set is stored as — and, being a nested-manifest kind, the
 * row's meta too.
 *
 * `description` is recomputed here on every write, so it can never disagree
 * with the members it is counting; `applyWorkingSet` in `libraryCatalog` runs
 * the same function at reindex, which is what keeps a hand-pushed manifest's
 * row identical to a route-written one.
 */
export function workingSetManifest(doc: WorkingSetDoc): Record<string, unknown> {
  return {
    title: doc.title,
    category: WORKING_SET_CATEGORY,
    status: 'published',
    tags: [],
    description: describeWorkingSet(doc),
    purpose: doc.purpose,
    datasets: doc.datasets,
    layers: doc.layers,
    sites: doc.sites,
    ...(doc.derived !== undefined ? { derived: doc.derived } : {}),
    savedBy: doc.savedBy,
    savedById: doc.savedById,
    savedAt: doc.savedAt,
    ...(doc.fromView ? { fromView: doc.fromView } : {}),
  }
}

/** The set's own directory in the bucket. P7-5's derived columns land under
 *  it (`derived/<id>.json`), which is what the directory layout is for. */
export function workingSetPrefix(slug: string): string {
  return `${WORKING_SETS_PREFIX}${slug}/`
}

/** Where a set's manifest lives in the bucket. */
export function workingSetKey(slug: string): string {
  return `${workingSetPrefix(slug)}meta.json`
}
