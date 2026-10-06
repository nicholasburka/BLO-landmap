/**
 * Working sets (P7-1) — client half.
 *
 * A **working set** is the compound data object an analysis runs against: the
 * datasets in it, the sites that anchor it, and (P7-5) the derived columns
 * written onto it. A **saved view presents** one — `SavedView.workingSet` in
 * `lib/views.ts`, absent when the view is ad-hoc.
 *
 * Two objects, not one, because **a set may carry several views**: one set
 * about Memphis redevelopment can hold a map framed on the cluster, a table
 * sorted by distance to transmission, and a third framing written for a story —
 * all reading the same rows, none able to disagree about a number because none
 * of them owns one.
 *
 * This file is the API client and the arithmetic the browsers do over a set:
 * which sets a dataset is in (the chip row), and how far its sourcing has got
 * (*9 of 11 held, 2 could not be reached*). Types mirror
 * `server/src/routes/workingSets.ts`.
 *
 * P7-2 adds the half that makes a set usable: its **derived columns** — ONE
 * read, shared by the map and the table, because a derived column belongs to
 * the set and never to a view, and that only means something if there is one
 * place to read it from.
 *
 * P7-6 adds the half that makes a stored column **safe to trust**: each one
 * now says whether the datasets it was measured from have moved since, and
 * carries what a re-run would ask for. A stale column still arrives with all
 * its values — labelling it is the honest move and hiding it is not — so
 * everything here is about making the label reach a reader, in both
 * interfaces, rather than about withholding a number.
 *
 * P7-8 adds the second analysis type: a **weighted index** over several of the
 * set's county layers — the Lens, generalised and savable. Its output is a
 * derived column like any other, so everything above applies to it unchanged;
 * what it adds here is the formula (`CompositeTerm`), the run
 * (`runComposite`), and the one new fact about a column — `layerId`, which a
 * composite has and a measurement does not, because an index declares which
 * end of its scale is good and "miles away" does not.
 *
 * Which INTERFACE is being looked at is not here, and that is the §F.1 line
 * again: an interface is framing, so `SetInterface` and `workingSetViewHref`
 * live in `lib/views.ts` with the rest of the view-URL grammar. It also keeps
 * the public map's entry chunk out of this file, which `views.ts` is in.
 */

import { internalFetch } from './apiBase'
import { invalidateCatalogCache, type CatalogEntry } from './libraryCatalog'
import { attentionKeysFor, relativeTime } from './kb'
import type { GroupKey } from './browse'
// Type only — a derived column lands in the shape P5-48's county join already
// consumes, which is what lets the explorer's table sort one for free. Erased
// at build time, so nothing of the map's data loaders comes with it.
import type { CountyValueRow } from './publicLayers'

/** One saved view of a set, as the set's own row lists it. */
export interface WorkingSetView {
  slug: string
  name: string
  type: string
}

export interface WorkingSetSummary {
  slug: string
  name: string
  /** What the set is for, in one line. '' when nobody said. */
  purpose: string
  /** The server's one-line description — the same sentence ⌘K shows. */
  description: string
  /** Catalog slugs: held datasets and indexed sources, the anchor first. */
  datasets: string[]
  /** Map layer ids. */
  layers: string[]
  /** The held dataset the set is about, or null. */
  sites: string | null
  /**
   * P7-5's columns, COUNTED rather than sent. A list row has no use for the
   * values and a proximity column over 190,000 rows must never ride in one.
   */
  derivedCount: number
  savedBy: string
  savedAt: string
  updatedAt: string
  /** The view this set was promoted from, when it came into being that way. */
  fromView?: string
  /** The saved views presenting it. Several is the normal case, not an edge. */
  views: WorkingSetView[]
}

/** One member of a set, as the detail route resolves it. */
export interface WorkingSetMember {
  slug: string
  kind: string
  title: string
  status: string
  readiness?: { as: string; placeReport: string; notes: string[] }
}

export interface WorkingSetDetail extends WorkingSetSummary {
  members: WorkingSetMember[]
  /**
   * Slugs the set names that the library no longer has.
   *
   * Never folded into a shorter member list: P6-23's rule is that a count may
   * not disagree with the list it opens, and "this set names something we lost"
   * is a thing to go and fix rather than a row to quietly drop.
   */
  missing: string[]
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // non-JSON body — fall through
  }
  return fallback
}

export async function fetchWorkingSets(): Promise<WorkingSetSummary[]> {
  const res = await internalFetch('/api/working-sets')
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load working sets (${res.status})`))
  const body = (await res.json()) as { sets?: WorkingSetSummary[] }
  return Array.isArray(body.sets) ? body.sets : []
}

/** One set with its members resolved. Null on 404. */
export async function fetchWorkingSet(slug: string): Promise<WorkingSetDetail | null> {
  const res = await internalFetch(`/api/working-sets/${encodeURIComponent(slug)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load the working set (${res.status})`))
  return (await res.json()) as WorkingSetDetail
}

export interface WorkingSetFields {
  purpose?: string
  datasets?: string[]
  layers?: string[]
  sites?: string | null
}

export async function createWorkingSet(input: { name: string } & WorkingSetFields): Promise<{ slug: string; name: string }> {
  const res = await internalFetch('/api/working-sets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `Could not make the working set (${res.status})`))
  // A set is a catalog row: the landing, the browsers and ⌘K are stale until
  // they refetch (P5-89).
  invalidateCatalogCache()
  return (await res.json()) as { slug: string; name: string }
}

export async function updateWorkingSet(
  slug: string,
  fields: { name?: string } & WorkingSetFields,
): Promise<WorkingSetSummary> {
  const res = await internalFetch(`/api/working-sets/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `Could not save the working set (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()) as WorkingSetSummary
}

/** What a promotion took from the view, so the page can say it rather than
 *  implying the new set is finished. */
export interface PromotedWorkingSet {
  slug: string
  name: string
  fromView: string
  took: { datasets: string[]; layers: string[] }
}

/**
 * "Make a working set from this view" (spec §F.1).
 *
 * The deliberate action that is the ONLY way an existing view comes to present
 * a curated set. There is no backfill and there will not be one: a set
 * auto-built from a view's layer list is one to three registry layers with no
 * sites and no sources — it satisfies the schema and means nothing.
 */
export async function promoteViewToWorkingSet(
  viewSlug: string,
  input: { name?: string; purpose?: string } = {},
): Promise<PromotedWorkingSet> {
  const res = await internalFetch(`/api/working-sets/from-view/${encodeURIComponent(viewSlug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `Could not make a working set from that view (${res.status})`))
  invalidateCatalogCache()
  return (await res.json()) as PromotedWorkingSet
}

/** Point a saved view at a set, or clear the pointer (null). */
export async function setViewWorkingSet(viewSlug: string, workingSet: string | null): Promise<void> {
  const res = await internalFetch(`/api/views/${encodeURIComponent(viewSlug)}/working-set`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workingSet }),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `Could not change what that view presents (${res.status})`))
  invalidateCatalogCache()
}

// --- The browser's arithmetic ------------------------------------------------

/** The chip for "in no working set at all". '' is the id the browse kit's
 *  `NONE_VALUE` stands in for in a URL. */
export const NO_WORKING_SET_LABEL = 'In no working set'

/**
 * Which sets a dataset row is in, as chips.
 *
 * MULTI-VALUED, like P6-19's coverage: a dataset that eleven projects depend on
 * belongs under all eleven of their chips, because "what is the Memphis set
 * missing?" has to find it. A row in no set answers with the one empty-id chip
 * so that "in no working set" is a chip somebody can press, rather than a
 * silence.
 */
export function workingSetKeysOf(slug: string, sets: readonly WorkingSetSummary[]): GroupKey[] {
  const naming = sets.filter(set => set.datasets.includes(slug))
  if (naming.length === 0) return [{ id: '', label: NO_WORKING_SET_LABEL }]
  return naming.map(set => ({ id: set.slug, label: set.name }))
}

/** The ids `matchesAnyFilter` compares — the same values the chips are counted
 *  from, which is what keeps a chip's count and the list it opens one set. */
export function workingSetIdsOf(slug: string, sets: readonly WorkingSetSummary[]): string[] {
  return workingSetKeysOf(slug, sets).map(key => key.id)
}

/** The attention queues that mean "we tried and could not get at it" — a
 *  dropped link whose last look failed, and a source whose adapter errored.
 *  These are the "2 could not be reached" half of a set's progress. */
const UNREACHED_KEYS = ['unreachable', 'source-failing'] as const

export interface WorkingSetProgress {
  /** Members the set NAMES — the denominator, always. */
  total: number
  /** Tables we hold. */
  held: number
  /** Sources we index and fetch on demand. */
  indexed: number
  /** Named, but the library no longer has it. */
  missing: number
  /** Named and catalogued, but the last attempt to reach it failed. */
  unreached: number
}

/**
 * How far a set's sourcing has got (spec §D.1: *9 of 11 ingested, 2 could not
 * be reached*).
 *
 * The existing attention predicates, scoped to a set, **are** the project's
 * progress tracker — there is no second vocabulary for it, which is the point:
 * a member that needs work shows up in the same queue whether you came at it
 * from the landing page or from the set.
 *
 * The denominator is what the set NAMES, never what resolved. A set naming
 * eleven things of which one has been archived is 11 with a missing one, not a
 * tidy 10.
 */
export function workingSetProgress(
  set: Pick<WorkingSetSummary, 'datasets'>,
  entries: readonly CatalogEntry[],
): WorkingSetProgress {
  const bySlug = new Map(entries.map(entry => [entry.slug, entry]))
  const progress: WorkingSetProgress = { total: set.datasets.length, held: 0, indexed: 0, missing: 0, unreached: 0 }
  for (const slug of set.datasets) {
    const entry = bySlug.get(slug)
    if (!entry || (entry.kind !== 'dataset' && entry.kind !== 'source')) {
      progress.missing += 1
      continue
    }
    if (entry.kind === 'dataset') progress.held += 1
    else progress.indexed += 1
    const queues = attentionKeysFor(entry)
    if (UNREACHED_KEYS.some(key => queues.includes(key))) progress.unreached += 1
  }
  return progress
}

/**
 * That progress, in words.
 *
 * "9 of 11 held" leads because getting a table into the library is the work
 * the number is tracking. The rest is only said when it is true — a set with
 * nothing missing should not carry a "0 missing" clause for somebody to read
 * past.
 */
export function progressLine(progress: WorkingSetProgress): string {
  if (progress.total === 0) return 'Nothing in this set yet'
  const parts = [`${progress.held} of ${progress.total} held`]
  if (progress.indexed) parts.push(`${progress.indexed} indexed`)
  if (progress.unreached) parts.push(`${progress.unreached} could not be reached`)
  if (progress.missing) {
    parts.push(`${progress.missing} no longer in the library`)
  }
  return parts.join(' · ')
}

/**
 * Where a working set opens: its catalog entry, like anything else in the
 * library.
 *
 * P7-2 gave a set its two interfaces and they are deliberately NOT here. A set
 * holds no framing — no viewport, no sort, no palette — so there is nothing to
 * show it WITH until a view supplies one; the interfaces live on
 * `/views/:slug` (`workingSetViewHref`), over the set the view presents. A set
 * with no view yet has an entry page and a sourcing checklist, which is the
 * honest amount of surface for an object that has not been framed.
 */
export function workingSetHref(slug: string): string {
  return `/library/${encodeURIComponent(slug)}`
}

/** The datasets browser, narrowed to one set — the list its progress line
 *  counts, so the count and the list it opens can never disagree. */
export function workingSetDatasetsHref(slug: string): string {
  return `/datasets?workingSet=${encodeURIComponent(slug)}`
}

/** A place report run INSIDE a set: that set's sources, 11 instead of 40. */
export function workingSetPlaceHref(slug: string): string {
  return `/place?set=${encodeURIComponent(slug)}`
}

// --- The derived columns, which both interfaces read once -------------------

/**
 * One derived column of a set, with its values (P7-2; P7-5 computes them).
 *
 * **Keyed on the county GEOID.** That is the only key the map and the table can
 * both join on, because county polygons are what the canvas draws — see
 * `server/src/services/workingSetColumns.ts`, which is the one place these are
 * read from. The table sorts by it and the map reports it over the subset it
 * draws, from this one object.
 */
export type DerivedFreshness = 'fresh' | 'stale' | 'unknown'

/** One line of a weighted index: a layer, how much it counts, and which end
 *  is good (P7-8). This IS the saved formula — nothing about it is read off a
 *  layer manifest, so a saved index cannot change meaning when somebody edits
 *  a legend. */
export interface CompositeTerm {
  layer: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

/**
 * What a re-run of a column would ask for, as the server read it off the
 * stored analysis. Null when the column records nothing to re-run — and a
 * button that cannot say what it would re-run is worse than no button.
 *
 * A **discriminated union**, not a widened record: P7-6 shipped the proximity
 * shape alone and a weighted index came back `rerun: null`. Switching on
 * `type` means a composite can never look like a proximity run with two empty
 * strings.
 */
export type DerivedRerun =
  | { type: 'proximity'; from: string; to: string; within: number | null }
  | { type: 'composite'; terms: CompositeTerm[] }

export interface DerivedColumn {
  id: string
  label: string
  /** How to PRINT the number ('miles', 'count', 'percent', 'dollars', ''). */
  unit: string
  /** One line saying how it was made. '' until P7-5 says. */
  method: string
  computedAt: string
  /** GEOID → number. */
  values: Record<string, number>
  /** How many counties carry a number. */
  rows: number
  /** 'manifest', or the bucket key of the file it was read from. */
  storedAt: string
  /** P7-6: the analysis type that produced it ('proximity'). '' when none. */
  type: string
  /** P7-6: who or what produced it — a username, or the batch pass's own
   *  name. '' when nobody was recorded, which prints as nothing rather than
   *  as "someone" (P6-27). */
  by: string
  /**
   * P7-6: whether the inputs this was computed from still hold.
   *
   * The values come back whatever this says — a stale column renders, with a
   * label — because a story quoting the number needs both halves.
   */
  freshness: DerivedFreshness
  /** Why it is not fresh, in the server's own sentence. '' when it is. */
  staleNote: string
  /** P7-6: which input moved, rather than only that one did. */
  inputs: { slug: string; role: string; verdict: DerivedFreshness; reason: string }[]
  /** P7-6: the arguments a re-run takes, or null. */
  rerun: DerivedRerun | null
  /**
   * P7-8: the layer id this column draws as, or `''` when it is not a layer.
   *
   * A composite index IS a county layer — it is listed in the internal layer
   * manifest and painted by the same pipeline as every other one, which is why
   * drawing it needed no new client code. A proximity column is not: nothing
   * in its record says whether being close to a transmission line is an asset
   * or a hazard, and inventing a direction is worse than declining to name one.
   */
  layerId: string
}

export interface WorkingSetColumns {
  slug: string
  name: string
  columns: DerivedColumn[]
  /**
   * Columns the set names that could not be opened. Reported rather than
   * dropped: "this set has a column we cannot read" is a thing to go and fix,
   * never a row to quietly lose (P6-23).
   */
  unreadable: string[]
}

const NO_COLUMNS: WorkingSetColumns = { slug: '', name: '', columns: [], unreadable: [] }

/**
 * A set's derived columns — THE one read, shared by both interfaces.
 *
 * A derived column belongs to the set and never to a view (spec §F.1), which
 * only means anything if there is one place to read it from. `/views/:slug`
 * calls this once and hands the result to both interfaces: the map narrows to
 * the counties it covers, the table sorts by it, and neither computes
 * anything. A 404 answers as "no columns" rather than throwing — a set can be
 * renamed out from under an open page, and the view is still worth drawing.
 */
export async function fetchWorkingSetColumns(slug: string): Promise<WorkingSetColumns> {
  const res = await internalFetch(`/api/working-sets/${encodeURIComponent(slug)}/columns`)
  if (res.status === 404) return { ...NO_COLUMNS, slug }
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load the set's columns (${res.status})`))
  const body = (await res.json()) as Partial<WorkingSetColumns>
  return {
    slug: typeof body.slug === 'string' ? body.slug : slug,
    name: typeof body.name === 'string' ? body.name : '',
    columns: Array.isArray(body.columns) ? body.columns.map(readColumn) : [],
    unreadable: Array.isArray(body.unreadable) ? body.unreadable : [],
  }
}

const FRESHNESS: readonly DerivedFreshness[] = ['fresh', 'stale', 'unknown']

/**
 * One column, with every field the templates read guaranteed present.
 *
 * Tolerant in one direction only, and deliberately: a missing verdict reads as
 * **`'unknown'`**, never as `'fresh'`. A column drawn as current because a
 * field was absent is the exact failure this ticket exists to prevent, and it
 * is the kind of failure that looks like nothing at all.
 */
function readColumn(raw: unknown): DerivedColumn {
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const verdict = FRESHNESS.includes(row.freshness as DerivedFreshness)
    ? (row.freshness as DerivedFreshness)
    : 'unknown'
  return {
    id: text(row.id),
    label: text(row.label) || text(row.id),
    unit: text(row.unit),
    method: text(row.method),
    computedAt: text(row.computedAt),
    values: row.values && typeof row.values === 'object' ? (row.values as Record<string, number>) : {},
    rows: typeof row.rows === 'number' ? row.rows : 0,
    storedAt: text(row.storedAt),
    type: text(row.type),
    by: text(row.by),
    freshness: verdict,
    staleNote: text(row.staleNote),
    inputs: Array.isArray(row.inputs) ? (row.inputs as DerivedColumn['inputs']) : [],
    rerun: readRerun(row.rerun),
    layerId: text(row.layerId),
  }
}

/**
 * The re-run arguments, per type, or null.
 *
 * Tolerant in exactly one direction, like `readColumn` itself: anything that
 * does not carry every argument its own type takes reads as **null**, which
 * offers no button, rather than as a half-filled record that would make the
 * button guess.
 */
function readRerun(raw: unknown): DerivedRerun | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  if (text(row.type) === 'composite') {
    if (!Array.isArray(row.terms) || row.terms.length < 2) return null
    const terms: CompositeTerm[] = []
    for (const item of row.terms) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const term = item as Record<string, unknown>
      const layer = text(term.layer)
      const direction = text(term.direction)
      const weight = typeof term.weight === 'number' && Number.isFinite(term.weight) ? term.weight : 0
      if (!layer || weight <= 0 || (direction !== 'higher_better' && direction !== 'lower_better')) return null
      terms.push({ layer, weight, direction })
    }
    return { type: 'composite', terms }
  }
  if (text(row.type) && text(row.from) && text(row.to)) {
    return {
      type: 'proximity',
      from: text(row.from),
      to: text(row.to),
      within: typeof row.within === 'number' ? row.within : null,
    }
  }
  return null
}

/**
 * What a reader is told about a column's standing, in one line (P7-6).
 *
 * Shaped like the explorer's own `staleNote` and `freshnessPhrase`: the
 * relative time to scan, then what changed, in a sentence rather than a bare
 * adjective. A fresh column says when it was measured and by whom and nothing
 * more — a caveat on every column makes the caveat invisible on the one that
 * has one.
 */
export function derivedFreshnessLine(column: DerivedColumn, now = Date.now()): string {
  const when = relativeTime(column.computedAt, now)
  const measured = ['Measured', when, column.by ? `by ${column.by}` : ''].filter(Boolean).join(' ')
  if (column.freshness === 'fresh') return measured
  return column.staleNote ? `${measured} · ${column.staleNote}` : measured
}

/** The short word a chip beside the label carries, or '' when there is
 *  nothing to flag. Separate from the sentence because a reader scans the chip
 *  and reads the sentence. */
export function derivedFreshnessBadge(column: DerivedColumn): string {
  if (column.freshness === 'stale') return 'Out of date'
  if (column.freshness === 'unknown') return 'Unchecked'
  return ''
}

/**
 * Measure a stale column again — the "offers a re-run" half of P7-6.
 *
 * The arguments come from the column's own stored record, so this never
 * guesses what to re-run: `recompute` is passed because the caller is looking
 * at a result it has already been told is out of date, and the point is to
 * replace it.
 */
export async function rerunDerivedColumn(slug: string, column: DerivedColumn): Promise<void> {
  const rerun = column.rerun
  if (!rerun) throw new Error('This column does not record what produced it, so it cannot be re-run.')
  if (rerun.type === 'composite') {
    await runComposite(slug, {
      label: column.label,
      id: column.id,
      terms: rerun.terms,
      recompute: true,
    })
    return
  }
  await runProximity(slug, {
    from: rerun.from,
    to: rerun.to,
    within: rerun.within,
    id: column.id,
    recompute: true,
  })
}

/**
 * The number as this column prints it.
 *
 * The unit says how to PRINT, never what the number means — the same division
 * a layer's `formatValue` makes. A unit nobody taught this function is
 * appended verbatim rather than swallowed: a column must not become unreadable
 * because P7-5 invented a word after this was written.
 */
export function formatDerivedValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return MISSING_DERIVED
  switch (unit) {
    case 'miles':
      return `${value.toFixed(1)} mi`
    case 'count':
      return Math.round(value).toLocaleString()
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'dollars':
      return `$${Math.round(value).toLocaleString()}`
    // P7-8: a weighted index is 0-100 by construction, and one decimal is what
    // separates two counties without implying a precision the formula has not
    // got. `toFixed` rather than `toLocaleString` so 71 prints as 71.0 beside
    // 71.4 and a column of them lines up.
    case 'index':
      return value.toFixed(1)
    case '':
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    default:
      return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`
  }
}

/** What a county with no number in this column shows. The same em dash the
 *  county-context join uses, and for the same reason: a blank cell reads as
 *  zero, an em dash reads as "we have no number for this one". */
export const MISSING_DERIVED = '—'

/**
 * A derived column as the explorer's table already knows how to join.
 *
 * This is the whole seam of P7-2. P5-48 built a client-side join of county
 * numbers into any table that carries a GEOID — a `Map<GEOID, …>`, a cell
 * formatter, a client-side sort, a CSV that includes the joined columns — and a
 * derived column is that shape exactly. So the table gains a sortable derived
 * column through code that already exists and is already tested, and the
 * values it sorts are the same object the map is drawing.
 */
export function derivedColumnValues(column: DerivedColumn): Map<string, CountyValueRow> {
  const values = new Map<string, CountyValueRow>()
  for (const [geoId, value] of Object.entries(column.values)) {
    values.set(geoId, {
      geoId,
      county: geoId,
      state: '',
      value,
      display: formatDerivedValue(value, column.unit),
    })
  }
  return values
}

/** The set's columns as joined table columns, in the set's own order. */
export function derivedTableColumns(
  columns: readonly DerivedColumn[],
): { id: string; name: string; values: Map<string, CountyValueRow> }[] {
  return columns.map(column => ({
    id: `derived:${column.id}`,
    name: column.label,
    values: derivedColumnValues(column),
  }))
}

export interface DerivedRange {
  /** How many of the counties asked about carry a number. */
  count: number
  min: number
  max: number
}

/**
 * A column's spread across the counties the map is drawing.
 *
 * This is how the MAP shows a derived column without the layer pipeline: it is
 * drawing a subset, and the honest thing it can say about a column over that
 * subset is its range and how much of it is covered. Read off the same values
 * the table is sorting — one computation, two interfaces.
 *
 * Null when none of those counties has a number, which the caller says out
 * loud rather than printing a range of nothing.
 */
export function derivedRange(column: DerivedColumn, geoIds: readonly string[]): DerivedRange | null {
  let count = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  // An empty subset means "the whole layer", the same as `query.only` — so the
  // range is over the whole column rather than over nothing.
  const keys = geoIds.length ? geoIds : Object.keys(column.values)
  for (const geoId of keys) {
    const value = column.values[geoId]
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    count += 1
    if (value < min) min = value
    if (value > max) max = value
  }
  return count ? { count, min, max } : null
}

/** "1.4 mi to 6.2 mi across 18 counties", or the one value when they agree. */
export function derivedRangeLine(column: DerivedColumn, range: DerivedRange): string {
  const counties = `${range.count.toLocaleString()} ${range.count === 1 ? 'county' : 'counties'}`
  if (range.min === range.max) return `${formatDerivedValue(range.min, column.unit)} across ${counties}`
  const low = formatDerivedValue(range.min, column.unit)
  const high = formatDerivedValue(range.max, column.unit)
  return `${low} to ${high} across ${counties}`
}

// --- P7-5: proximity between two of a set's layers --------------------------

/** One row of A, measured. `miles` is null when the row has no coordinates —
 *  which is a shortfall to report, never a zero to draw. */
export interface ProximityRowResult {
  index: number
  label: string
  geoid: string | null
  miles: number | null
  /** The nearest feature's own label. '' when the row could not be measured. */
  nearest: string
  /** Features within the radius, or null when none was asked for. */
  within: number | null
}

export interface ProximityStats {
  rows: number
  measured: number
  withoutPoint: number
  withoutCounty: number
  counties: number
  targets: number
  vertices: number
}

export interface ProximityRun {
  set: string
  from: string
  to: string
  within: number | null
  /** True when this exact question had been asked and the stored answer came
   *  back. Said out loud, because "nothing recomputed" is the feature. */
  reused: boolean
  /** P7-6: `'stored'` when nothing was computed, `'computed'` when it ran.
   *  The feature stated rather than implied. */
  served: 'stored' | 'computed'
  /** P7-6: whether the inputs behind the number still hold. */
  freshness: DerivedFreshness
  /** P7-6: the server's sentence — a caveat on a served result, or the reason
   *  a computed one replaced an out-of-date number. '' when neither. */
  staleNote: string
  columns: { id: string; label: string; unit: string; counties: number }[]
  perRow: ProximityRowResult[]
  stats: ProximityStats
  method: string
  computedAt: string
}

/**
 * Measure each row of a set's site table against one of its layers (P7-5).
 *
 * Server-side for the three reasons §F.2 gives: the number has to be stable
 * and citable because a story quotes it, it joins datasets the browser does
 * not hold, and chat/MCP has to be able to ask for the same thing. The result
 * is a derived column on the SET, so `fetchWorkingSetColumns` serves it to
 * both interfaces afterwards with no second computation.
 *
 * A **413** is the on-demand ceiling and its message names the local batch
 * pass — show it, do not retry smaller.
 */
export async function runProximity(
  slug: string,
  input: { to: string; from?: string; within?: number | null; id?: string; recompute?: boolean },
): Promise<ProximityRun> {
  const res = await internalFetch(`/api/working-sets/${encodeURIComponent(slug)}/proximity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `The measurement could not be run (${res.status})`))
  // The set's row now carries one more derived column, and ⌘K and the
  // browsers are stale until they refetch (P5-89).
  invalidateCatalogCache()
  const body = (await res.json()) as ProximityRun
  // Same rule as `readColumn`: an answer that does not say what it did is
  // read as having computed and as uncheckable, never as a free serve.
  return {
    ...body,
    served: body.served === 'stored' ? 'stored' : 'computed',
    freshness: FRESHNESS.includes(body.freshness) ? body.freshness : 'unknown',
    staleNote: typeof body.staleNote === 'string' ? body.staleNote : '',
  }
}

/**
 * What to tell a reader who just pressed Measure (P7-6).
 *
 * Three outcomes, and they are genuinely different things to say:
 * nothing ran; it ran for the first time; it ran again *because* an input had
 * moved — and the third is the one a reader must not mistake for the second,
 * since the number in front of them just changed.
 */
export function proximityServedLine(run: ProximityRun): string {
  if (run.served === 'stored') {
    return run.freshness === 'fresh'
      ? 'Already measured — the stored result, unchanged. Nothing was recomputed.'
      : `Already measured — the stored result. ${run.staleNote}`
  }
  return run.staleNote ? `Measured again — ${run.staleNote}` : 'Measured.'
}

/**
 * The set's layers that proximity can actually measure to.
 *
 * Read off the catalog the page already loaded rather than asking for the
 * layer manifest: a dataset's `meta.layer` IS its layer declaration, so the
 * geometry and the layer's own name are both already here, and this costs no
 * request.
 *
 * **County layers are left out.** They hold values, not features, so there is
 * nothing to measure a distance to — and the server refuses one by name. An
 * option that can only ever be refused is not an option.
 */
export function measurableLayersOf(
  set: Pick<WorkingSetSummary, 'layers'>,
  entries: readonly CatalogEntry[],
): { id: string; name: string; geometry: string }[] {
  const bySlug = new Map(entries.map(entry => [entry.slug, entry]))
  const out: { id: string; name: string; geometry: string }[] = []
  for (const id of set.layers) {
    if (!id.startsWith('internal-')) continue
    const entry = bySlug.get(id.slice('internal-'.length))
    const layer = entry?.meta?.layer as { geometry?: string; name?: string } | undefined
    const geometry = layer?.geometry ?? ''
    if (geometry !== 'point' && geometry !== 'line') continue
    out.push({ id, name: (layer?.name || entry?.title || id).trim(), geometry })
  }
  return out
}

/** "9 of 11 sites measured · 6 counties", or just the first clause when
 *  nothing fell short. The shortfall is never folded into a tidier number
 *  (P6-23) — two unlocated sites is a thing to go and fix. */
export function proximityLine(run: ProximityRun): string {
  const parts = [
    `${run.stats.measured.toLocaleString()} of ${run.stats.rows.toLocaleString()} ${
      run.stats.rows === 1 ? 'row' : 'rows'
    } measured`,
    `${run.stats.counties.toLocaleString()} ${run.stats.counties === 1 ? 'county' : 'counties'}`,
  ]
  if (run.stats.withoutPoint) parts.push(`${run.stats.withoutPoint.toLocaleString()} with no coordinates`)
  if (run.stats.withoutCounty) parts.push(`${run.stats.withoutCounty.toLocaleString()} not in a county`)
  return parts.join(' · ')
}

// --- P7-8: a weighted index over the set's layers ----------------------------

/** What each term's normalisation actually used — the answer to "what does
 *  100 mean", recorded per run rather than taken on faith. */
export interface CompositeScale extends CompositeTerm {
  min: number
  max: number
  counties: number
}

export interface CompositeRun {
  set: string
  column: string
  label: string
  /** The saved formula, canonically ordered (sorted by layer id). */
  terms: CompositeTerm[]
  scales: CompositeScale[]
  reused: boolean
  /** `'stored'` when nothing was computed, `'computed'` when it ran. */
  served: 'stored' | 'computed'
  freshness: DerivedFreshness
  staleNote: string
  counties: number
  complete: number
  partial: number
  /** The layer id the index now draws as. */
  layerId: string
  method: string
  computedAt: string
}

/**
 * Build a weighted index over several of a set's county layers (P7-8).
 *
 * Server-side for the same three reasons proximity is (§F.2), plus one of its
 * own: the formula has to be *saved*, and a formula that lives in client
 * memory is a number a story cannot cite. The result is a derived column on
 * the SET, so `fetchWorkingSetColumns` serves it to both interfaces
 * afterwards with no second computation — and because a composite declares
 * which end of its scale is good, it also arrives as a county layer the map
 * can paint.
 *
 * A **413** is the on-demand ceiling and its message names the local batch
 * pass — show it, do not retry with fewer layers.
 */
export async function runComposite(
  slug: string,
  input: { label: string; terms: readonly CompositeTerm[]; id?: string; recompute?: boolean },
): Promise<CompositeRun> {
  const res = await internalFetch(`/api/working-sets/${encodeURIComponent(slug)}/composite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(await errorMessage(res, `The index could not be built (${res.status})`))
  // The set's row now carries one more derived column, and ⌘K and the
  // browsers are stale until they refetch (P5-89).
  invalidateCatalogCache()
  const body = (await res.json()) as CompositeRun
  // Same rule as `readColumn`: an answer that does not say what it did is read
  // as having computed and as uncheckable, never as a free serve.
  return {
    ...body,
    served: body.served === 'stored' ? 'stored' : 'computed',
    freshness: FRESHNESS.includes(body.freshness) ? body.freshness : 'unknown',
    staleNote: typeof body.staleNote === 'string' ? body.staleNote : '',
    terms: Array.isArray(body.terms) ? body.terms : [],
    scales: Array.isArray(body.scales) ? body.scales : [],
  }
}

/**
 * The set's layers an index can actually weigh.
 *
 * County layers only: a point or line layer has features, not values, so there
 * is nothing to normalise — and the server refuses one by name. An option that
 * can only ever be refused is not an option, which is the rule
 * `measurableLayersOf` follows in the other direction.
 *
 * Two kinds, because the registry is no longer the boundary (§F.3's "arbitrary
 * layers rather than the registry"):
 *
 * - **internal** layers come off the catalog the page already loaded — a
 *   dataset's `meta.layer` IS its layer declaration, so this costs no request.
 * - **public** layers come off `LAYER_REGISTRY`, which is static and always
 *   present. Their declared direction pre-fills the picker, which is a very
 *   different thing from the server defaulting it: a person sees the word and
 *   can change it, and whatever they leave is what gets saved.
 *
 * A **derived** layer is left out. A composite is itself a county layer, so an
 * index over an index is expressible — and would need a chain of staleness
 * P7-6's one-level input fingerprint does not keep, so the server refuses it.
 */
export function indexableLayersOf(
  set: Pick<WorkingSetSummary, 'layers'>,
  entries: readonly CatalogEntry[],
  registry: Record<string, { name?: string; direction?: string; unit?: string }> = {},
): { id: string; name: string; direction: 'higher_better' | 'lower_better'; kind: 'internal' | 'public' }[] {
  const bySlug = new Map(entries.map(entry => [entry.slug, entry]))
  const out: { id: string; name: string; direction: 'higher_better' | 'lower_better'; kind: 'internal' | 'public' }[] = []
  for (const id of set.layers) {
    if (id.startsWith('internal-')) {
      const slug = id.slice('internal-'.length)
      // A derived index's own layer id carries the separator the server uses;
      // it is not offered as a term.
      if (slug.includes('~')) continue
      const entry = bySlug.get(slug)
      const layer = entry?.meta?.layer as { geometry?: string; name?: string; direction?: string } | undefined
      if (layer?.geometry !== 'county') continue
      out.push({
        id,
        name: (layer.name || entry?.title || id).trim(),
        direction: layer.direction === 'lower_better' ? 'lower_better' : 'higher_better',
        kind: 'internal',
      })
      continue
    }
    const def = registry[id]
    if (!def) continue
    out.push({
      id,
      name: (def.name || id).trim(),
      direction: def.direction === 'lower_better' ? 'lower_better' : 'higher_better',
      kind: 'public',
    })
  }
  return out
}

/**
 * What to tell a reader who just pressed Build (P7-8).
 *
 * The same three outcomes `proximityServedLine` distinguishes, and the third
 * is the one that must not be mistaken for the second: the number in front of
 * them just changed.
 */
export function compositeServedLine(run: CompositeRun): string {
  if (run.served === 'stored') {
    return run.freshness === 'fresh'
      ? 'Already built — the stored index, unchanged. Nothing was recomputed.'
      : `Already built — the stored index. ${run.staleNote}`
  }
  return run.staleNote ? `Built again — ${run.staleNote}` : 'Built.'
}

/** "318 counties · 290 with every layer · 28 missing at least one". The
 *  shortfall is never folded into a tidier number (P6-23): a county scored on
 *  half the formula is scored lower, and a reader should know how many. */
export function compositeLine(run: Pick<CompositeRun, 'counties' | 'complete' | 'partial'>): string {
  const parts = [
    `${run.counties.toLocaleString()} ${run.counties === 1 ? 'county' : 'counties'}`,
    `${run.complete.toLocaleString()} with every layer`,
  ]
  if (run.partial) parts.push(`${run.partial.toLocaleString()} missing at least one`)
  return parts.join(' · ')
}

/** One term as a reader reads it back: "Black poverty rate ×4, lower is
 *  better, over 3.1 to 44.2". The scale is half the sentence — an index whose
 *  0 and 100 are unstated is a number nobody can check. */
export function compositeTermLine(scale: CompositeScale, name = ''): string {
  const which = scale.direction === 'lower_better' ? 'lower is better' : 'higher is better'
  const span = `${Number(scale.min.toFixed(3)).toLocaleString()} to ${Number(scale.max.toFixed(3)).toLocaleString()}`
  return `${name || scale.layer} ×${scale.weight}, ${which}, over ${span}`
}
