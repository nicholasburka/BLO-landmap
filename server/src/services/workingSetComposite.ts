/**
 * A weighted index over a working set's layers (P7-8) — the **on-demand tier**.
 *
 * Spec §F.4b's tier 2, the second analysis type after proximity, and the one
 * §F.3 asks for by name: *"the Lens already does weighted scoring with
 * directions — but only over registry county layers, only in client memory,
 * and the result cannot be named, saved, cited or drawn as its own layer."*
 *
 * The arithmetic is `composite.ts` and is shared verbatim with the local pass
 * (`cli/composite.ts`), because cardinality decides where an analysis runs and
 * not the operation — so the only difference between the two homes is where
 * the bytes come from and whether the ceiling applies. What this file owns is
 * the resolution, the refusals, and the record.
 *
 * ## The definition IS the saved object
 *
 * There is no second store and no definitions table. A composite's definition
 * lives in the `analysis` block of the derived column it produced, on the
 * set's manifest — which is where P7-6 put the one results store, and which is
 * what makes a reindex rebuild an identical row from the bucket alone. So a
 * saved index is: a **name** (the column's label), a **formula** (`terms`), a
 * **scale** per term (what its 0 and 100 meant), **inputs** with versions, and
 * **who ran it, when**. Re-running reads the formula back off that record, so
 * nothing is retyped and nothing is guessed — and reuse is the same readable
 * field equality proximity uses, one level up: same layers, same weights, same
 * directions (`sameTerms`).
 *
 * ## What it inherits for free, which was the point
 *
 * P7-6's note: *"the staleness machinery is already type-agnostic —
 * `checkAnalysisInputs` knows nothing about proximity — so a composite layer
 * gets versions, verdicts and the stale label for free by writing `inputs` the
 * same way."* It does, and that is all this does: one `AnalysisInput` per
 * term, captured the same way, so the stale badge, the "which input moved"
 * sentence, the header count and `GET …/columns`'s verdict all work with no
 * knowledge of what a composite is. The one thing P7-6 could not have
 * foreseen is that a term may be a **public registry layer**, which has no
 * catalog row — hence `source: 'public'` on an input, which is a widening by
 * kind of input rather than by kind of analysis.
 *
 * ## Two refusals that are design decisions
 *
 * - **The set is the scope.** A layer the set does not name is refused by
 *   name, exactly as proximity refuses one: P7-1's rule that a shortlist
 *   inside a set cannot reach outside it, applied to the formula. An index
 *   over a layer the set does not claim is not the question the set is asking.
 * - **A derived layer cannot be a term.** A composite column is itself a
 *   drawable county layer (see `internalLayers.ts`), so an index over an index
 *   is expressible — and would need a staleness *chain*, which P7-6's one-level
 *   input fingerprint does not have. Rather than report a stale-looking index
 *   as fresh because its own input's input moved, this refuses and says so.
 */

import { getCatalogEntry } from './libraryCatalog.js'
import {
  INTERNAL_LAYER_ID_PREFIX,
  isDerivedLayerSlug,
  readInternalLayerValues,
} from './internalLayers.js'
import { getWorkingSet, putDerivedColumns, type DerivedColumnWrite, type WorkingSet } from './libraryWorkingSets.js'
import { DERIVED_COLUMNS_MAX, readDerivedColumns } from './workingSetColumns.js'
import {
  captureAnalysisInput,
  checkAnalysisInputs,
  type AnalysisInput,
  type InputVerdict,
} from './analysisInputs.js'
import {
  CompositeMathError,
  canonicalTerms,
  compositeMethod,
  compositeRefusal,
  computeComposite,
  readCompositeTerms,
  sameTerms,
  type CompositeScale,
  type CompositeTerm,
  type CompositeTermValues,
} from './composite.js'
import { isPublicLayerId, publicLayerBytes, publicLayerRecord, readPublicCountyLayer } from './publicLayerValues.js'

/** Same three statuses the proximity service raises, for the same reasons:
 *  404 the set, 400 the definition, 413 the ceiling. */
export class CompositeError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'CompositeError'
  }
}

export interface CompositeInput {
  set: string
  /** What the index is called. Required: an index nobody named cannot be
   *  cited, and citing it is the whole point (§F.3). */
  label?: string
  /** The formula. Validated by `readCompositeTerms`. */
  terms?: unknown
  /** Column id; derived from the label when absent. */
  id?: string
  recompute?: boolean
  by?: string
  byId?: number | null
}

/** The record written into the column's `analysis` block — the saved
 *  definition, its provenance and its input versions, in one object. */
export interface CompositeAnalysis {
  type: 'composite'
  /** The saved formula, canonical (sorted by layer id). */
  terms: CompositeTerm[]
  /** What each term's normalisation actually used. Provenance, not input:
   *  recomputed from the data every run, never read back as a parameter. */
  scales: CompositeScale[]
  columns: string[]
  counties: number
  complete: number
  partial: number
  inputs?: AnalysisInput[]
  by: string
  at: string
}

export interface CompositeRun {
  set: string
  column: string
  label: string
  terms: CompositeTerm[]
  scales: CompositeScale[]
  reused: boolean
  served: 'stored' | 'computed'
  freshness: InputVerdict
  staleNote: string
  counties: number
  complete: number
  partial: number
  /** The layer id this index now draws as — the "behaves like any other
   *  layer" half, handed back so a caller can switch it on. */
  layerId: string
  method: string
  computedAt: string
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LABEL_MAX = 120

/** `internal-<slug>` → `<slug>`; anything else unchanged. */
function bareSlug(layer: string): string {
  return layer.startsWith(INTERNAL_LAYER_ID_PREFIX) ? layer.slice(INTERNAL_LAYER_ID_PREFIX.length) : layer
}

/**
 * The layer id as the set would name it.
 *
 * A caller may say `internal-votes` or `votes` for an internal layer, and a
 * public layer is its registry id. Resolved to the one spelling the set's
 * `layers` list and the map both use, so the stored formula has exactly one
 * spelling per layer and field equality means what it says.
 */
function canonicalLayerId(asked: string): string {
  if (isPublicLayerId(asked)) return asked
  return `${INTERNAL_LAYER_ID_PREFIX}${bareSlug(asked)}`
}

function labelFor(input: CompositeInput): string {
  const label = (input.label ?? '').trim().slice(0, LABEL_MAX)
  if (!label) {
    throw new CompositeError(
      400,
      'An index needs a name — it becomes a layer and a column a story cites, and an unnamed number cannot be cited.',
    )
  }
  return label
}

/** The column id: what was asked for, or the label slugified. */
function columnIdFor(input: CompositeInput, label: string): string {
  const asked = (input.id ?? '').trim().toLowerCase()
  if (asked) {
    if (!ID_RE.test(asked)) throw new CompositeError(400, `“${asked}” is not a column id: lower case, digits and dashes.`)
    return asked
  }
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  if (!ID_RE.test(slug)) {
    throw new CompositeError(400, `“${label}” does not make a column id. Pass one with “id”.`)
  }
  return slug
}

/** The formula, validated and scoped to the set. */
function termsFor(set: WorkingSet, raw: unknown): CompositeTerm[] {
  const read = readCompositeTerms(
    Array.isArray(raw)
      ? raw.map(item => {
          const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
          return typeof row.layer === 'string' ? { ...row, layer: canonicalLayerId(row.layer.trim()) } : row
        })
      : raw,
  )
  if ('error' in read) throw new CompositeError(400, read.error)
  for (const term of read.terms) {
    if (isDerivedLayerSlug(bareSlug(term.layer))) {
      throw new CompositeError(
        400,
        `“${term.layer}” is itself a derived index, and an index over an index would need a chain of ` +
          `staleness this does not keep — a changed input two steps back would read as fresh. ` +
          `Build it from the layers underneath instead.`,
      )
    }
    if (!set.layers.includes(term.layer) && !set.datasets.includes(bareSlug(term.layer))) {
      throw new CompositeError(
        400,
        `“${term.layer}” is not a layer this working set names. Add it to the set first — an index ` +
          `over something outside the set would not be the question the set is asking.`,
      )
    }
  }
  return read.terms
}

// --- Reading the terms' numbers ---------------------------------------------

interface ResolvedTerm extends CompositeTermValues {
  /** For the method sentence and the refusals. */
  name: string
  /** The analysis input this term becomes. */
  input: AnalysisInput
}

/** A layer's own declared file, for the pre-flight byte budget. */
function declaredFileOf(meta: Record<string, unknown> | undefined, files: readonly { key: string; size: number }[]): string | undefined {
  const block = meta && typeof meta.layer === 'object' && meta.layer && !Array.isArray(meta.layer)
    ? (meta.layer as Record<string, unknown>)
    : null
  const named = block && typeof block.file === 'string' ? block.file.trim() : ''
  if (!named) return undefined
  return files.some(f => f.key.split('/').slice(3).join('/') === named) ? named : undefined
}

/**
 * How many bytes this index would parse, decided from the catalog and the
 * filesystem with **nothing opened**.
 *
 * This is what makes the ceiling pre-flight, which is the one way it improves
 * on proximity's: there, the segment budget could only be checked after layer
 * B had been read, so a refusal still cost the read. Here a size is a `stat`
 * or a catalog column. A size that cannot be known cheaply counts as zero —
 * the budget declines to refuse work it has no evidence against.
 */
async function bytesOfTerms(terms: readonly CompositeTerm[]): Promise<number> {
  let total = 0
  for (const term of terms) {
    if (isPublicLayerId(term.layer)) {
      total += (await publicLayerBytes(term.layer)) ?? 0
      continue
    }
    const entry = await getCatalogEntry(bareSlug(term.layer))
    if (!entry) continue
    const files = entry.files ?? []
    const declared = declaredFileOf(entry.meta, files)
    const file = declared
      ? files.find(f => f.key.split('/').slice(3).join('/') === declared)
      : files.slice().sort((a, b) => b.size - a.size)[0]
    total += file?.size ?? 0
  }
  return total
}

/** One term's county numbers, its name, and its input record. */
async function resolveTerm(term: CompositeTerm): Promise<ResolvedTerm> {
  if (isPublicLayerId(term.layer)) {
    const layer = await readPublicCountyLayer(term.layer)
    return {
      ...term,
      name: layer.name,
      values: layer.values,
      input: await captureAnalysisInput({ slug: term.layer, role: 'term', file: '', source: 'public' }),
    }
  }
  const slug = bareSlug(term.layer)
  const entry = await getCatalogEntry(slug)
  if (!entry) {
    throw new CompositeError(400, `“${term.layer}” is not a layer we hold, so it has no numbers to index.`)
  }
  const layer = await readInternalLayerValues(slug)
  if (layer.geometry !== 'county') {
    throw new CompositeError(
      400,
      `“${term.layer}” is a ${layer.geometry} layer: it has features, not county values, so there is ` +
        `nothing to weigh. An index is over county layers.`,
    )
  }
  return {
    ...term,
    name: entry.title || slug,
    values: layer.values,
    input: await captureAnalysisInput({
      slug,
      role: 'term',
      file: declaredFileOf(entry.meta, entry.files ?? []) ?? '',
    }),
  }
}

// --- Reuse -------------------------------------------------------------------

function analysisOf(doc: unknown): CompositeAnalysis | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const analysis = (doc as { analysis?: unknown }).analysis
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null
  const record = analysis as Record<string, unknown>
  if (record.type !== 'composite') return null
  const read = readCompositeTerms(record.terms)
  if ('error' in read) return null
  return { ...(record as unknown as CompositeAnalysis), terms: read.terms }
}

/**
 * The stored index with exactly this formula, or null.
 *
 * Field equality on the formula the column already carries for provenance —
 * the same layers, the same weights, the same directions, order-insensitively
 * because the terms are stored canonically. A formula already asked for is not
 * recomputed, which is the acceptance criterion, and the comparison is
 * readable in the manifest rather than hidden in a digest.
 */
export function storedComposite(derived: unknown, terms: readonly CompositeTerm[]): CompositeAnalysis | null {
  if (!Array.isArray(derived)) return null
  for (const doc of derived) {
    const analysis = analysisOf(doc)
    if (!analysis) continue
    if (sameTerms(analysis.terms, terms)) return analysis
  }
  return null
}

/** Every index a set holds, with its standing — the GET's answer, and the
 *  surface a reader uses to see what the 0 and 100 meant per layer. */
export async function listWorkingSetComposites(
  slug: string,
): Promise<{ analysis: CompositeAnalysis; column: string; label: string; freshness: Awaited<ReturnType<typeof checkAnalysisInputs>> }[]> {
  const set = await getWorkingSet(slug)
  if (!set) return []
  const out: { analysis: CompositeAnalysis; column: string; label: string; freshness: Awaited<ReturnType<typeof checkAnalysisInputs>> }[] = []
  for (const doc of readDerivedColumns(set.derived)) {
    const analysis = analysisOf(doc)
    if (!analysis) continue
    out.push({
      analysis,
      column: doc.id,
      label: doc.label ?? doc.id,
      freshness: await checkAnalysisInputs(analysis.inputs),
    })
  }
  return out
}

// --- The run -----------------------------------------------------------------

/**
 * Score the set's counties against a formula and write the result onto the set.
 *
 * One column, GEOID-keyed — the only key both interfaces can read (P7-2) —
 * with `unit: 'index'`, so the table sorts it and the map draws it the moment
 * this returns. Serving a stored result is the default, exactly as P7-6 made
 * it for proximity: a stored index whose inputs still hold is served with
 * nothing parsed, and only a changed input makes it compute.
 */
export async function runWorkingSetComposite(input: CompositeInput): Promise<CompositeRun> {
  const set = await getWorkingSet(input.set)
  if (!set) throw new CompositeError(404, `There is no working set called “${input.set}”.`)

  const label = labelFor(input)
  const terms = termsFor(set, input.terms)
  const id = columnIdFor(input, label)
  const layerId = `${INTERNAL_LAYER_ID_PREFIX}${set.slug}~${id}`

  // An index must not silently replace a measurement. `putDerivedColumns`
  // replaces by id, so a name that happens to collide with a proximity column
  // would overwrite a number somebody is quoting with a different kind of
  // number under the same header.
  const clash = readDerivedColumns(set.derived).find(c => c.id === id)
  const clashType = clash && analysisOf(clash) === null ? typeOf(clash) : ''
  if (clashType) {
    throw new CompositeError(
      400,
      `This set already has a ${clashType} column called “${id}”. Give the index another name, ` +
        `or pass a different “id” — replacing it would change what that header means.`,
    )
  }

  // Reuse before any reading: the point of storing a result is that an
  // unchanged question costs nothing at all, not that it costs less.
  let staleBefore = ''
  if (!input.recompute) {
    const stored = storedComposite(set.derived, terms)
    if (stored) {
      const freshness = await checkAnalysisInputs(stored.inputs)
      if (freshness.verdict === 'stale') {
        staleBefore = freshness.note
      } else {
        const column = readDerivedColumns(set.derived).find(c => stored.columns.includes(c.id))
        return {
          set: set.slug,
          column: column?.id ?? id,
          label: column?.label ?? label,
          terms: stored.terms,
          scales: Array.isArray(stored.scales) ? stored.scales : [],
          reused: true,
          served: 'stored',
          // 'unknown' is served too: recomputing a result whose inputs cannot
          // be checked is exactly the compute P7-6 exists to avoid.
          freshness: freshness.verdict,
          staleNote: freshness.note,
          counties: stored.counties ?? 0,
          complete: stored.complete ?? 0,
          partial: stored.partial ?? 0,
          layerId: `${INTERNAL_LAYER_ID_PREFIX}${set.slug}~${column?.id ?? id}`,
          method: column?.method ?? '',
          computedAt: stored.at,
        }
      }
    }
  }

  // The ceiling, before anything is opened.
  const refusal = compositeRefusal(terms.length, await bytesOfTerms(terms))
  if (refusal) throw new CompositeError(413, refusal)

  const resolved: ResolvedTerm[] = []
  for (const term of terms) resolved.push(await resolveTerm(term))

  let result
  try {
    result = computeComposite(resolved)
  } catch (err) {
    // The maths refuses a flat or empty term. That is a 400 about the
    // definition, not a 500 about the server.
    if (err instanceof CompositeMathError) throw new CompositeError(400, err.message)
    throw err
  }

  const names = Object.fromEntries(resolved.map(t => [t.layer, t.name]))
  const method = compositeMethod({ names, scales: result.scales, stats: result.stats })
  const computedAt = new Date().toISOString()
  const analysis: CompositeAnalysis = {
    type: 'composite',
    terms: canonicalTerms(terms),
    scales: result.scales,
    columns: [id],
    counties: result.stats.counties,
    complete: result.stats.complete,
    partial: result.stats.partial,
    inputs: resolved.map(t => t.input),
    by: input.by ?? '',
    at: computedAt,
  }

  const already = readDerivedColumns(set.derived).filter(c => c.id !== id).length
  if (already + 1 > DERIVED_COLUMNS_MAX) {
    throw new CompositeError(
      400,
      `This set already carries ${already} derived columns, and ${DERIVED_COLUMNS_MAX} is the most it holds. ` +
        `Nothing was computed.`,
    )
  }

  const write: DerivedColumnWrite = {
    id,
    label,
    // §F.4d: the column declares what it measures, its unit, its inputs and
    // its method in the same write. 'index' prints as a bare 0-100 number.
    unit: 'index',
    method,
    values: result.values,
    analysis,
  }
  const written = await putDerivedColumns(set.slug, [write])
  if (!written) throw new CompositeError(404, `There is no working set called “${input.set}”.`)

  return {
    set: set.slug,
    column: id,
    label,
    terms: analysis.terms,
    scales: result.scales,
    reused: false,
    served: 'computed',
    freshness: 'fresh',
    staleNote: staleBefore,
    counties: result.stats.counties,
    complete: result.stats.complete,
    partial: result.stats.partial,
    layerId,
    method,
    computedAt,
  }
}

/** The analysis type a column already carries, for the name-clash refusal. */
function typeOf(doc: { analysis?: unknown }): string {
  const analysis = doc.analysis
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return 'derived'
  const type = (analysis as Record<string, unknown>).type
  return typeof type === 'string' && type ? type : 'derived'
}
