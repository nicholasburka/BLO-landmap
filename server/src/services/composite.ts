/**
 * The Lens, generalised — a weighted index over several county layers (P7-8).
 *
 * The public map's Lens (`src/composables/usePersonalizedScore.ts`) has done
 * weighted scoring with directions since P5-18, and does it well. What it
 * cannot do is leave anything behind: it scores the registry's county layers,
 * in client memory, against a query that lives in a URL, and the result cannot
 * be named, saved, cited or drawn as its own layer. Spec §F.3 wants the
 * workbook's *political efficacy layer* — "class and race based indicators …
 * areas of greater engagement" — which is a formula, and a formula a story
 * quotes has to be a thing on disk.
 *
 * So the arithmetic moves here, where a result can be written onto a working
 * set and inherit P7-6's provenance and staleness. **This module is pure** —
 * no bucket, no catalog, no DB, exactly like `proximity.ts` — so the maths can
 * be read and tested without a library behind it. The service that feeds it is
 * `workingSetComposite.ts`.
 *
 * ## What is the same as the Lens, deliberately
 *
 * - **Min–max normalisation per term**, then a weighted mean onto 0–100.
 * - **`direction` inverts the term, not the score** (`1 - normalised`).
 * - **Missing data divides by the FULL declared weight.** The Lens's own
 *   comment is the argument and it is worth keeping: a county missing one of
 *   two equally-weighted layers maxes out near 50, so it stays in the ranking
 *   where a reader can see it instead of tying a complete county at the top.
 *   Redistributing the missing weight — which `scripts/calculate_blo_v2_scores.cjs`
 *   does, and which is the third convention in this codebase — would let one
 *   available layer pump an incomplete county to 100.
 *
 * ## What is different, and why
 *
 * - **The scale comes from the data, never from a declared range.** The Lens
 *   normalises a registry layer against `LAYER_REGISTRY[id].range`, a literal.
 *   An index cannot: the number has to be a function of the bytes, because the
 *   bytes are what P7-6's input fingerprint covers. A declared `range` on a
 *   layer block is a legend domain — `color`, `width` and `name` are already
 *   excluded from that fingerprint as cosmetics, for exactly this reason — so
 *   normalising against it would let somebody change a published index by
 *   editing a legend while every freshness verdict still read green. The
 *   observed min and max are therefore recorded per term, so the 0–100 can be
 *   read back rather than taken on faith.
 * - **Direction is required, never defaulted.** The Lens falls back to the
 *   registry's semantic direction. A saved formula must not depend on a
 *   mutable manifest field, so a definition states every direction and the
 *   picker pre-fills it where the layer declares one.
 * - **The terms are sorted by layer id before anything is summed.** That is
 *   not tidiness: floating-point addition is not associative, so a fixed
 *   summation order is what makes "re-running a saved definition reproduces
 *   the same values" true to the last bit rather than to the last decimal.
 * - **A term that cannot rank anything is refused**, where the Lens scores it
 *   as 0. See `computeComposite`.
 */

export type CompositeDirection = 'higher_better' | 'lower_better'

/** One line of a definition: a layer, how much it counts, and which end is
 *  good. This IS the saved formula — nothing about it is read off a manifest. */
export interface CompositeTerm {
  /** P9-4: force this term's scale. Absent = pinned when the layer pins one. */
  scale?: 'pinned' | 'observed'
  /**
   * P9-5: the span THIS index scores the term against, overriding whatever
   * the layer pins.
   *
   * The published BLO index needs it: its unbounded terms were scored against
   * spans the registry does not hold — life expectancy 69-89.5 where the
   * registry pins 65-87 — so neither "the layer's range" nor "today's spread"
   * reproduces it. It is also the honest shape for any published index, since
   * a span recomputed on each refresh silently moves every historical score.
   */
  range?: { min: number; max: number }
  /** A public registry layer id (`pct_Black`) or an internal one
   *  (`internal-<slug>`). The caller resolves it; this module only names it. */
  layer: string
  weight: number
  direction: CompositeDirection
}

/** A term with the layer's county numbers attached, as the service reads them. */
export interface CompositeTermValues extends CompositeTerm {
  /**
   * P9-4: the range this measure is SCALED against, when one is pinned.
   *
   * A range is derived from the data by default and pinned where somebody
   * decided it. Pinning earns its place twice over: a floating range silently
   * moves every historical score and makes two indices incomparable, because
   * they were scaled against different denominators; and natural bounds beat
   * observation outright — a percentage runs 0-100 whether or not any county
   * reaches either end, and observed-scaling one that really spans 30-55%
   * manufactures a dramatic gradient from a narrow real range.
   *
   * This is also what makes the Lens and this function agree. The Lens scales
   * a registry layer against `LAYER_REGISTRY[id].range`, and those literals
   * are not rival declarations — `calculate_blo_v2_scores.cjs` computed them
   * from the data and rounded them. Same concept, written down.
   */
  declaredRange?: { min: number; max: number } | null
  /** GEOID → value. */
  values: Record<string, number>
}

/** What a term's normalisation actually used, recorded so a reader can see
 *  what this index's 0 and 100 mean for each layer. */
export interface CompositeScale extends CompositeTerm {
  min: number
  max: number
  /** How many counties carried a usable number for this term. */
  counties: number
  /** Which span the 0-100 was measured against (P9-4). */
  scale: 'pinned' | 'observed'
}

export interface CompositeStats {
  terms: number
  /** Counties carrying a score — at least one term. */
  counties: number
  /** Counties carrying every term. */
  complete: number
  /** Counties carrying some terms but not all; scored, and scored lower. */
  partial: number
}

export interface CompositeResult {
  /** Which missing-data rule produced these numbers (P9-4). */
  missing: MissingRule
  /** GEOID → index, 0–100. A county no term covers is absent, not zero. */
  values: Record<string, number>
  scales: CompositeScale[]
  stats: CompositeStats
}

/** Thrown for a definition the maths cannot answer. The service turns it into
 *  a 400 with this sentence; the CLI prints it. */
export class CompositeMathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompositeMathError'
  }
}

/** At least two: over one layer an index is that layer rescaled. */
export const COMPOSITE_TERMS_MIN = 2

/**
 * The spec's own explicit ceiling on the definition (§F.4b).
 *
 * Twelve, because the largest formula this codebase has ever shipped is the
 * eleven-layer `BLO_PRESET`, and a weighted index nobody can hold in their
 * head is a number nobody can defend. This bound is about the *formula*; the
 * one below is about the work.
 */
export const COMPOSITE_TERMS_MAX = 12

/** Weights are relative, so there is never a reason for a big one. */
export const COMPOSITE_WEIGHT_MAX = 100

/**
 * The real ceiling: total bytes of the files the terms read.
 *
 * **The layer count cannot see the work**, which is P7-5's lesson restated in
 * a different dimension. There, a row cap could not see that a few hundred
 * transmission corridors are millions of vertices. Here, twelve layer blocks
 * can sit on twelve very large tables: `LAYER_MAX_VALUES` caps the county
 * values a layer *projects* to (10,000) but not the rows it parses to get
 * there, so a county block over a two-million-row table passes every declared
 * cap and still parses two million rows.
 *
 * 32 MB is **measured, not guessed**: parse + project runs at ~17–20 MB/s for
 * county-shaped CSVs on this hardware, so 32 MB is about two seconds. Two
 * seconds is the number that matters for the same reason it was for proximity
 * — this is synchronous work on one Node event loop, on the single Railway
 * instance whose rate-limit and budget counters DEPLOY.md says are in memory.
 *
 * Unlike the proximity budget, this one is **pre-flight**: a file's size is on
 * the catalog row, so a refusal costs no parse at all rather than being
 * discovered after the inputs are already open.
 */
export const COMPOSITE_BYTES_BUDGET = 32 * 1024 * 1024

/**
 * The budget in force, which is the default unless the environment says
 * otherwise — the same lever `LAYER_MAX_VALUES` and `LAYER_MAX_FEATURES`
 * already give the single instance they protect.
 *
 * Read **lazily**, not captured at import: a module that latches an env var at
 * load time behaves differently depending on which test file imported it
 * first, which is exactly the class of problem P7-11 is about.
 */
export function compositeBytesBudget(): number {
  const raw = process.env.COMPOSITE_BYTES_BUDGET
  const n = raw ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : COMPOSITE_BYTES_BUDGET
}

/** Rounded like a proximity distance, and for the same reason: a stored number
 *  a story quotes must not depend on the last bit of a float. */
export const COMPOSITE_DECIMALS = 4

const ROUND = 10 ** COMPOSITE_DECIMALS

function stored(value: number): number {
  return Math.round(value * ROUND) / ROUND
}

const DIRECTIONS: readonly string[] = ['higher_better', 'lower_better']

/**
 * The definition in its canonical spelling: sorted by layer id.
 *
 * Two jobs, both load-bearing. It fixes the **summation order**, so the same
 * formula always produces bit-identical values (see the module note). And it
 * makes reuse readable field equality — the same six layers typed in another
 * order are the same index, and must not recompute.
 */
export function canonicalTerms(terms: readonly CompositeTerm[]): CompositeTerm[] {
  return [...terms]
    // P9-4: `scale` is part of the FORMULA, not of one run — a definition
    // that lost it would re-run against a different denominator and quietly
    // produce different numbers. Omitted when absent so an unset term stays
    // byte-identical to how it was stored before this field existed.
    .map(t => ({
      layer: t.layer,
      weight: t.weight,
      direction: t.direction,
      ...(t.scale ? { scale: t.scale } : {}),
      ...(t.range ? { range: { min: t.range.min, max: t.range.max } } : {}),
    }))
    .sort((a, b) => a.layer.localeCompare(b.layer))
}

/** Whether two definitions are the same formula — the field equality P7-6
 *  keyed reuse on, one level up from a single layer. */
export function sameTerms(a: readonly CompositeTerm[], b: readonly CompositeTerm[]): boolean {
  if (a.length !== b.length) return false
  const left = canonicalTerms(a)
  const right = canonicalTerms(b)
  return left.every(
    (term, i) =>
      term.layer === right[i].layer &&
      term.weight === right[i].weight &&
      term.direction === right[i].direction &&
      (term.scale ?? 'pinned') === (right[i].scale ?? 'pinned') &&
      (term.range?.min ?? null) === (right[i].range?.min ?? null) &&
      (term.range?.max ?? null) === (right[i].range?.max ?? null),
  )
}

/**
 * Validate a definition as it arrived over the wire, or off a manifest.
 *
 * Returns the canonical terms or ONE sentence naming the offending layer —
 * never a field-path error, because the caller is a person building a formula
 * and the thing they need to know is which line of it is wrong.
 */
export function readCompositeTerms(raw: unknown): { terms: CompositeTerm[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: 'An index is a list of layers, each with a weight and a direction.' }
  }
  if (raw.length < COMPOSITE_TERMS_MIN) {
    return {
      error:
        `An index needs at least ${COMPOSITE_TERMS_MIN} layers — over one layer it is that layer rescaled, ` +
        `so draw the layer instead.`,
    }
  }
  if (raw.length > COMPOSITE_TERMS_MAX) {
    return {
      error:
        `${raw.length} layers is more than an index holds — ${COMPOSITE_TERMS_MAX} is the most, ` +
        `because past that nobody can say what the number means.`,
    }
  }
  const terms: CompositeTerm[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const layer = typeof row.layer === 'string' ? row.layer.trim() : ''
    if (!layer) return { error: 'Every line of an index names a layer; one of these names none.' }
    if (seen.has(layer)) return { error: `“${layer}” is in this index twice. One layer, one weight.` }
    seen.add(layer)
    const direction = typeof row.direction === 'string' ? row.direction.trim() : ''
    if (!DIRECTIONS.includes(direction)) {
      return {
        error:
          `Every layer in an index needs a direction — “higher_better” or “lower_better”. ` +
          `“${layer}” has none.`,
      }
    }
    const weight = typeof row.weight === 'number' ? row.weight : Number.NaN
    if (!Number.isFinite(weight) || weight <= 0) {
      return { error: `“${layer}” needs a weight above zero — a layer counting for nothing is not in the index.` }
    }
    if (weight > COMPOSITE_WEIGHT_MAX) {
      return {
        error:
          `A weight of ${weight} is past the ${COMPOSITE_WEIGHT_MAX} an index takes — weights are relative, ` +
          `so scale them all down instead.`,
      }
    }
    // P9-4: a term may insist on its own observed spread, ignoring whatever
    // range the layer pins. Absent means "pinned if the layer has one".
    const scale = typeof row.scale === 'string' ? row.scale.trim() : ''
    if (scale && scale !== 'pinned' && scale !== 'observed') {
      return { error: `“${layer}” has an unknown scale “${scale}” — it is “pinned” or “observed”.` }
    }
    let range: { min: number; max: number } | undefined
    if (row.range !== undefined && row.range !== null) {
      const r = row.range as Record<string, unknown>
      const min = typeof r.min === 'number' ? r.min : Number.NaN
      const max = typeof r.max === 'number' ? r.max : Number.NaN
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
        return {
          error: `“${layer}” has a range that cannot be scored against — it needs a min below a max.`,
        }
      }
      range = { min, max }
    }
    terms.push({
      layer,
      weight,
      direction: direction as CompositeDirection,
      ...(scale ? { scale: scale as 'pinned' | 'observed' } : {}),
      ...(range ? { range } : {}),
    })
  }
  return { terms: canonicalTerms(terms) }
}

/**
 * The span a term is scaled against: its pinned range when it has a usable
 * one, otherwise its own min and max over the counties carrying a number.
 *
 * A pinned min === max says nothing — it cannot divide — so it is ignored
 * rather than turned into a division by zero.
 */
function spanOf(
  values: Record<string, number>,
  pinned: { min: number; max: number } | null | undefined,
  forced?: 'pinned' | 'observed',
): { min: number; max: number; counties: number; scale: 'pinned' | 'observed' } {
  if (forced === 'observed') return { ...scaleOf(values), scale: 'observed' }
  const observed = scaleOf(values)
  const usable =
    pinned &&
    Number.isFinite(pinned.min) &&
    Number.isFinite(pinned.max) &&
    pinned.max !== pinned.min
  if (!usable) return { ...observed, scale: 'observed' }
  return { min: pinned.min, max: pinned.max, counties: observed.counties, scale: 'pinned' }
}

/** A term's own min and max over the counties that carry a usable number. */
function scaleOf(values: Record<string, number>): { min: number; max: number; counties: number } {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let counties = 0
  for (const value of Object.values(values)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    counties += 1
    if (value < min) min = value
    if (value > max) max = value
  }
  return counties ? { min, max, counties } : { min: 0, max: 0, counties: 0 }
}

/**
 * Score every county at least one term covers.
 *
 * **Two refusals rather than two plausible wrong numbers**, and they are the
 * one place this departs from the Lens's arithmetic:
 *
 * - A term **no county carries** would contribute nothing to anybody while
 *   still taking its share of the declared weight — every county in the index
 *   silently scaled down by a layer that is not there.
 * - A term whose values are **all the same** is worse, because it looks fine.
 *   The Lens's `normalize` returns 0 when `max === min`, so a constant layer
 *   drags every county down by its whole weight share and ranks nothing. In
 *   client memory, with a slider to drag, that is recoverable. Written onto a
 *   working set and quoted by a story, it is a wrong number with provenance.
 *
 * Both say which layer and what to do about it. The ranking itself is left to
 * the reader: this returns values, and the map and the table sort them.
 */
/** P9-4: how a county missing a term is treated. */
export type MissingRule = 'penalise' | 'ignore'

export interface CompositeOptions {
  /**
   * `penalise` divides by the FULL declared weight, so a county missing a
   * layer is dragged down as though it scored zero there — "we know little
   * about this place, so it should not rank top".
   *
   * `ignore` divides by the weight actually available, scoring a county on
   * the data it has. This is what `calculate_blo_v2_scores.cjs` does, and so
   * what the published index means.
   *
   * Roughly two thirds of US counties are missing at least one of the BLO
   * index's eleven terms, so the two answers are far apart. Neither is wrong,
   * which is why it is a setting and not a constant. Default `penalise`:
   * what this did before the choice existed.
   */
  missing?: MissingRule
}

export function computeComposite(
  terms: readonly CompositeTermValues[],
  options: CompositeOptions = {},
): CompositeResult {
  const ordered = [...terms].sort((a, b) => a.layer.localeCompare(b.layer))
  const scales: CompositeScale[] = []
  for (const term of ordered) {
    const { min, max, counties, scale } = spanOf(term.values, term.range ?? term.declaredRange, term.scale)
    if (!counties) {
      throw new CompositeMathError(
        `“${term.layer}” has no county values, so it cannot be part of an index. ` +
          `Check the layer draws on the map, then add it again.`,
      )
    }
    if (min === max) {
      throw new CompositeMathError(
        `“${term.layer}” has the same value in every county it covers (${min}), so it ranks nothing ` +
          `and would only scale the whole index down. Remove it, or use a layer with some spread.`,
      )
    }
    // `scale` travels with the number: "what does 100 mean" has a different
    // answer for a pinned term and an observed one, and a reader comparing
    // two indices needs to know which they are looking at.
    scales.push({ layer: term.layer, weight: term.weight, direction: term.direction, min, max, counties, scale })
  }

  const totalWeight = ordered.reduce((sum, term) => sum + term.weight, 0)
  const missing: MissingRule = options.missing === 'ignore' ? 'ignore' : 'penalise'
  const geoIds = new Set<string>()
  for (const term of ordered) for (const geoId of Object.keys(term.values)) geoIds.add(geoId)

  const values: Record<string, number> = {}
  let complete = 0
  let partial = 0
  // Sorted so the output object's key order is itself reproducible — a stored
  // JSON column that reshuffles on every run is a diff nobody can read.
  for (const geoId of [...geoIds].sort()) {
    let weighted = 0
    let present = 0
    let availableWeight = 0
    for (let i = 0; i < ordered.length; i++) {
      const term = ordered[i]
      const raw = term.values[geoId]
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
      const { min, max } = scales[i]
      let normalised = Math.max(0, Math.min(1, (raw - min) / (max - min)))
      if (term.direction === 'lower_better') normalised = 1 - normalised
      weighted += normalised * term.weight
      availableWeight += term.weight
      present += 1
    }
    if (!present) continue
    if (present === ordered.length) complete += 1
    else partial += 1
    // P9-4: the divisor IS the missing-data rule. Dividing by the full weight
    // treats an absent layer as a zero; dividing by what was available scores
    // the county on the data it has.
    const divisor = missing === 'ignore' ? availableWeight : totalWeight
    values[geoId] = stored((weighted / divisor) * 100)
  }

  return {
    values,
    scales,
    missing,
    stats: { terms: ordered.length, counties: complete + partial, complete, partial },
  }
}

/**
 * Why this request will not run, or null.
 *
 * Same shape and same argument as `proximityRefusal`: crawling is the failure
 * mode being avoided, so the refusal is a sentence naming the local pass that
 * *can* do the job. The CLI deliberately does not call this — same primitive,
 * different home (§F.4b's three tiers).
 */
export function compositeRefusal(terms: number, bytes: number): string | null {
  if (terms > COMPOSITE_TERMS_MAX) {
    return (
      `${terms.toLocaleString()} layers is more than an index holds — ${COMPOSITE_TERMS_MAX} is the most, ` +
      `because past that nobody can say what the number means.`
    )
  }
  const budget = compositeBytesBudget()
  if (bytes > budget) {
    const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
    return (
      `${terms.toLocaleString()} layers over ${mb(bytes)} of source tables is past the ` +
      `${mb(budget)} this parses in a request. The layer count alone cannot see this — ` +
      `a county layer caps the values it projects, not the rows it reads to get them. ` +
      `Run it locally instead: npm run library -- index <set> --name <label> ` +
      `--layer <layer>:<weight>:<direction> …, then push and reindex.`
    )
  }
  return null
}

/**
 * The sentence the column's `method` carries (§F.4d: every derived column
 * declares what it measures, its unit, its inputs and its method).
 *
 * It has to fit `METHOD_MAX` — 500 characters, which is what a column header
 * can show — and twelve long layer names do not. So the terms are named until
 * the budget runs out and the rest are counted; the full per-term record,
 * scales included, is in the stored `analysis` and comes back from
 * `GET …/composite`. A truncated list is better than a truncated sentence.
 */
export function compositeMethod(input: {
  names: Record<string, string>
  scales: readonly CompositeScale[]
  stats: CompositeStats
}): string {
  const { names, scales, stats } = input
  const head = `Weighted index of ${stats.terms} county ${stats.terms === 1 ? 'layer' : 'layers'}, each min–max normalised over its own counties`
  const tail =
    `; a county missing a layer is still divided by the full declared weight, so incomplete counties score ` +
    `lower; ${stats.counties.toLocaleString()} counties, ${stats.complete.toLocaleString()} with every layer.`
  const budget = 500 - head.length - tail.length - 2
  const listed: string[] = []
  let used = 0
  for (const scale of scales) {
    const name = (names[scale.layer] || scale.layer).trim()
    const piece = `${name} ×${scale.weight} ${scale.direction === 'lower_better' ? 'lower is better' : 'higher is better'}`
    const more = scales.length - listed.length - 1
    // Leave room for the "…and N more" the rest will need.
    const reserve = more > 0 ? ` and ${more} more`.length : 0
    if (used + piece.length + 2 + reserve > budget) break
    listed.push(piece)
    used += piece.length + 2
  }
  const rest = scales.length - listed.length
  const list = listed.join(', ') + (rest > 0 ? ` and ${rest} more` : '')
  return `${head}: ${list}${tail}`
}
