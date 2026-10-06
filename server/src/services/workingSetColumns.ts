/**
 * A working set's derived columns, as READ (P7-2).
 *
 * P7-1 left `derived` on the manifest as `unknown[]` and said nothing stood on
 * its shape, because the thing that writes it is P7-5. P7-2 is the thing that
 * READS it — twice, from two interfaces — so this file gives it exactly the
 * shape a reader needs and not one field more:
 *
 *  - an `id`, because a URL sorts by it and a map asks for it by name;
 *  - a `label` and a `unit`, because a header and a legend have to say
 *    something;
 *  - `method` and `computedAt`, because a story quotes the number and has to be
 *    able to say where it came from;
 *  - the values.
 *
 * **Keyed on the county GEOID, and only that.** This is the one real constraint
 * and it comes from the map: county polygons are what the canvas draws, so a
 * GEOID is the only key BOTH interfaces can read. A column keyed on some column
 * of the anchor table would be readable by the table alone — half a feature
 * wearing the name of a whole one — so this reader does not pretend to offer
 * it. Values under a key that is not a county are dropped, and a column left
 * with none is still LISTED with a count of 0: "this column has no county
 * values" is a thing to go and fix, never a row to quietly drop (P6-23).
 *
 * **Inline or beside the manifest.** A set is a directory precisely so that a
 * 190,000-row proximity column can land as a file instead of inside a catalog
 * row (P7-1), so a column may carry `values` or a `file`, and the route
 * resolves either. One read path, so P7-5 never needs to invent a second.
 *
 * **P7-6 added one question to the shape: does this still stand?** A column
 * now also carries what produced it, whether its inputs have moved since, and
 * the arguments a re-run would take. The values come back either way — a stale
 * column renders, labelled — because a story quoting a number needs the number
 * AND the caveat, and the alternative to a caveat is a blank space nobody can
 * interpret.
 *
 * Pure, like `workingSetMeta.ts` — the only import is a `type`, which is erased
 * at compile — so the shape can still be checked without a bucket. The verdict
 * itself is computed by `analysisInputs.ts` and handed in, because answering it
 * needs the catalog and the bytes, and this file must stay readable without
 * either.
 */

import { WORKING_SETS_PREFIX } from './workingSetMeta.js'
import type { Freshness, InputVerdict } from './analysisInputs.js'

/** Enough columns for any set somebody curates by hand; a guard against a
 *  runaway manifest rather than a limit on anything real. */
export const DERIVED_COLUMNS_MAX = 24

/** A column's own id, as a URL and a file name can carry it. */
const COLUMN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

const LABEL_MAX = 120
const METHOD_MAX = 500

/**
 * A derived column as stored on the manifest. Every field but `id` is
 * optional, because a tolerant reader is the house rule for anything a hand
 * can edit (`readWorkingSet`, `readSiteLayers`, `tableStateOf`).
 */
export interface DerivedColumnDoc {
  id: string
  label?: string
  /** How to PRINT a number — never what it means. `''` for a bare number. */
  unit?: string
  /** One line saying how it was made. P7-5 writes this; `''` until then. */
  method?: string
  computedAt?: string
  /** GEOID → number, inline. For a column small enough to sit in a manifest. */
  values?: Record<string, unknown>
  /** …or a JSON file beside the manifest, for one that is not. Relative to
   *  the set's own directory: `derived/<id>.json`. */
  file?: string
  /**
   * P7-6: what produced it — the analysis type, its parameters, who ran it,
   * and the version of each input it read.
   *
   * P7-5 wrote this and this reader dropped it, because a reader needed only
   * the number. P7-6 is the ticket where the reader needs it too: whether a
   * stored column still stands is a question about these inputs, and a reader
   * who cannot ask it has to either recompute or quietly hope. Carried as an
   * opaque record — the resolver picks the fields a reader is owed and leaves
   * the rest alone, so a later analysis type widening it costs nothing here.
   */
  analysis?: Record<string, unknown>
}

/** A column, resolved: the metadata plus the values both interfaces read. */
export interface DerivedColumn {
  id: string
  label: string
  unit: string
  method: string
  computedAt: string
  /** GEOID → number. The one key the map and the table can both join on. */
  values: Record<string, number>
  /** How many counties carry a number. Said out loud so an empty column reads
   *  as empty rather than as missing. */
  rows: number
  /** Where the values came from: `'manifest'`, or the key of the file. Kept so
   *  a reader can say the number is stored rather than recomputed. */
  storedAt: string
  /** P7-6: the analysis type that produced it (`'proximity'`). `''` when the
   *  column records nothing — a hand-written column, or one from before P7-5. */
  type: string
  /** P7-6: who or what produced it — a username, or the name of the batch
   *  pass. `''` when nobody was recorded, which prints as nothing rather than
   *  as "someone" (P6-27's rule). */
  by: string
  /**
   * P7-6: whether the inputs this was computed from still hold.
   *
   * `'fresh'` — every input is byte-identical to what it read.
   * `'stale'` — one has changed, so the number may have drifted.
   * `'unknown'` — nothing was recorded to check, or it could not be re-read.
   *
   * **A stale column is still here, with all its values.** Hiding it would
   * leave a story's number unexplained and a map pane empty; labelling it is
   * the honest move, and it is the same choice P6-26 made for a cached report
   * and P6-34 for an inferred field.
   */
  freshness: InputVerdict
  /** The sentence that says why it is not fresh. `''` when it is — a label on
   *  every column makes the label meaningless on the one that needs it. */
  staleNote: string
  /** P7-6: the inputs and what each was checked as, so a reader can see WHICH
   *  dataset moved rather than only that something did. */
  inputs: { slug: string; role: string; verdict: InputVerdict; reason: string }[]
  /**
   * P7-6: exactly what a re-run of this column would ask for, or null when the
   * column records no analysis to re-run.
   *
   * The affordance the acceptance criterion requires — *"still renders, and
   * offers a re-run"* — needs arguments, and they are already in the stored
   * record. Handing them over means a reader looking at a stale number can fix
   * it where they found it, instead of being sent to a form to retype what the
   * manifest already knows.
   */
  rerun: DerivedRerun | null
  /** P7-8: the layer id this column draws as, or `''` when it is not a layer.
   *  A composite index is a county layer in its own right; a measurement in
   *  miles is not, because nothing in its record says which end is good. */
  layerId: string
}

/**
 * What a re-run asks for, per analysis type (P7-8 widened this).
 *
 * P7-6 shipped the proximity shape and said what it was leaving: *"`rerunOf`
 * is proximity-shaped. It needs a `type`, a `from` and a `to`; a weighted
 * index over six layers has a type and a list, so it will come back
 * `rerun: null` and simply offer no button until P7-8 widens it."* This is the
 * widening, and it is a **discriminated union** rather than a widened record
 * with optional halves: a caller switches on `type` and gets exactly the
 * arguments that type takes, so there is no shape in which a composite looks
 * like a proximity run with two empty strings.
 */
export type DerivedRerun =
  | { type: 'proximity'; from: string; to: string; within: number | null }
  | { type: 'composite'; terms: { layer: string; weight: number; direction: string }[] }

/** The units this knows how to print. Anything else is carried through
 *  verbatim and printed as a bare number with its unit appended — a column
 *  must not become unreadable because nobody taught this file a word.
 *
 *  `'index'` is P7-8's: a composite's 0-100, printed as a bare number. */
export const DERIVED_UNITS = ['miles', 'count', 'percent', 'dollars', 'index', ''] as const

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/**
 * A key as a 5-digit county GEOID, or null.
 *
 * The same two forgiving cases as `normalizeGeoId` in `src/lib/countyJoin.ts`,
 * for the same reason: a column written from a spreadsheet drops the leading
 * zero, and one written from a float column keeps a `.0`. Anything else — a
 * tract, a ZIP, a site id — is not a county and gets no value rather than a
 * wrong one.
 */
export function derivedKeyAsGeoId(key: string): string | null {
  const trimmed = key.trim().replace(/\.0+$/, '')
  if (/^\d{5}$/.test(trimmed)) return trimmed
  if (/^\d{4}$/.test(trimmed)) return `0${trimmed}`
  return null
}

/** The numbers in a stored `values` map, keyed by county. Non-finite values
 *  are dropped: `null` means "not computed for this county", and NaN in a
 *  stored column is a bug upstream, not a number to draw. */
export function readDerivedValues(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const geoId = derivedKeyAsGeoId(key)
    if (!geoId) continue
    const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
    if (Number.isFinite(num)) out[geoId] = num
  }
  return out
}

/**
 * The columns a manifest names, in the manifest's own order.
 *
 * A column with no usable `id` is dropped — there is nothing to call it, so
 * there is no way for a URL to sort by it or for a map to ask for it — and a
 * duplicate id is dropped too, because two columns answering to one name is
 * how a table and a map come to disagree about a number. Everything else
 * survives, however thin.
 */
export function readDerivedColumns(derived: unknown): DerivedColumnDoc[] {
  if (!Array.isArray(derived)) return []
  const out: DerivedColumnDoc[] = []
  const seen = new Set<string>()
  for (const item of derived) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    const id = text(row.id, 64).toLowerCase()
    if (!COLUMN_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      label: text(row.label, LABEL_MAX) || id,
      unit: text(row.unit, 32),
      method: text(row.method, METHOD_MAX),
      computedAt: text(row.computedAt, 40),
      ...(row.values && typeof row.values === 'object' ? { values: row.values as Record<string, unknown> } : {}),
      ...(typeof row.file === 'string' && row.file.trim() ? { file: row.file.trim() } : {}),
      // P7-6: carried, not inspected. The store's own rule for `derived`
      // applied one level in — this reader promises not to lose it.
      ...(row.analysis && typeof row.analysis === 'object' && !Array.isArray(row.analysis)
        ? { analysis: row.analysis as Record<string, unknown> }
        : {}),
    })
    if (out.length >= DERIVED_COLUMNS_MAX) break
  }
  return out
}

/**
 * The bucket key a column's file lives at, or null when the manifest names
 * something that is not inside the set's own directory.
 *
 * A manifest can be hand-pushed, so this is the boundary: `derived/<id>.json`
 * beside the manifest, never `../`, never an absolute key, never another
 * entry's file. A set must not be able to serve somebody else's document by
 * naming it as a column.
 */
export function derivedColumnKey(slug: string, file: string): string | null {
  // An absolute key is REFUSED rather than reinterpreted as a relative one.
  // `/etc/passwd` read as `…/<slug>/etc/passwd` would be harmless and also a
  // lie: whoever wrote it meant something else, and a quiet reinterpretation
  // is how a manifest comes to serve a file nobody meant to publish.
  if (!file || file.startsWith('/') || file.includes('..') || file.includes('//')) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(file)) return null
  return `${WORKING_SETS_PREFIX}${slug}/${file}`
}

/**
 * What a re-run of this column would ask for, read off its stored analysis.
 *
 * The rule across both types is the same and is the reason this returns null
 * so readily: **a button that cannot say what it would re-run is worse than no
 * button**, because pressing it would guess. So a record is only offered when
 * it carries every argument its own type takes.
 *
 * - **proximity** needs a type, a `from` and a `to`. `within` is normalised to
 *   null rather than dropped, so "count within 10 miles" and "no radius" stay
 *   two different questions — exactly what `storedProximity` matches on.
 * - **composite** needs a formula, and a formula is only a formula if every
 *   line of it has a layer, a weight above zero and a direction. A term with a
 *   missing direction is not defaulted here: `composite.ts` refuses to guess
 *   one at write time, so reading one back and inventing it would put a
 *   number on the map that the definition does not describe.
 */
export function rerunOf(analysis: Record<string, unknown> | undefined): DerivedRerun | null {
  if (!analysis) return null
  const type = text(analysis.type, 40)
  if (type === 'composite') {
    if (!Array.isArray(analysis.terms) || analysis.terms.length < 2) return null
    const terms: { layer: string; weight: number; direction: string }[] = []
    for (const item of analysis.terms) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const row = item as Record<string, unknown>
      const layer = text(row.layer, 90)
      const direction = text(row.direction, 20)
      const weight = typeof row.weight === 'number' && Number.isFinite(row.weight) ? row.weight : 0
      if (!layer || weight <= 0 || (direction !== 'higher_better' && direction !== 'lower_better')) return null
      terms.push({ layer, weight, direction })
    }
    return { type: 'composite', terms }
  }
  const from = text(analysis.from, 80)
  const to = text(analysis.to, 90)
  if (!type || !from || !to) return null
  const within = typeof analysis.within === 'number' && Number.isFinite(analysis.within) ? analysis.within : null
  return { type: 'proximity', from, to, within }
}

/**
 * A stable identity for one analysis record, for de-duplicating its freshness
 * check across the columns it produced.
 *
 * P7-6 put this in the route as `` `${at}|${from}|${to}` `` so a proximity run's
 * distance and count columns were checked once rather than twice. A composite
 * has no `from` or `to`, which would have collapsed every composite computed
 * in the same millisecond onto one key — so the key is now built here, from
 * the fields each type actually has, where both the route and anything after
 * it read the same answer.
 */
export function analysisKeyOf(analysis: Record<string, unknown> | undefined): string {
  if (!analysis || typeof analysis.at !== 'string' || !analysis.at) return ''
  const rerun = rerunOf(analysis)
  if (!rerun) return ''
  return rerun.type === 'composite'
    ? `${analysis.at}|composite|${rerun.terms.map(t => `${t.layer}:${t.weight}:${t.direction}`).join(',')}`
    : `${analysis.at}|proximity|${rerun.from}|${rerun.to}|${rerun.within ?? ''}`
}

/** The column as the two interfaces receive it. Separated from the read so a
 *  file-backed column and an inline one land in exactly the same shape — and
 *  so a stale one lands in it too, values and all. */
export function resolveDerivedColumn(
  doc: DerivedColumnDoc,
  values: Record<string, number>,
  storedAt: string,
  freshness: Freshness = { verdict: 'unknown', note: '', inputs: [] },
  /** The set this column belongs to, so a column that IS a layer can say
   *  which layer. Omitted means "do not claim to be one" — a caller that
   *  cannot name the set cannot name the layer either. */
  setSlug = '',
): DerivedColumn {
  const rerun = rerunOf(doc.analysis)
  return {
    id: doc.id,
    label: doc.label ?? doc.id,
    unit: doc.unit ?? '',
    method: doc.method ?? '',
    computedAt: doc.computedAt ?? '',
    values,
    rows: Object.keys(values).length,
    storedAt,
    type: text(doc.analysis?.type, 40),
    by: text(doc.analysis?.by, 120),
    freshness: freshness.verdict,
    staleNote: freshness.note,
    inputs: freshness.inputs,
    rerun,
    // Spelled out rather than imported: `internalLayers.ts` owns both the
    // prefix and the separator, and it imports THIS file to list these layers
    // — so taking them from there would be a cycle. `derivedLayersOf` is what
    // actually lists them, and the rule is the same in both places: a
    // composite is a layer, a measurement in miles is not.
    layerId: setSlug && rerun?.type === 'composite' ? `internal-${setSlug}~${doc.id}` : '',
  }
}
