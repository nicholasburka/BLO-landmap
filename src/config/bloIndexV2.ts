/**
 * The published BLO Livability Index v2, as a composite definition.
 *
 * P9-5. This is `calculate_blo_v2_scores.cjs` written as data: the same
 * eleven terms, the same weights, and — critically — the same per-term spans
 * and the same rule for a county missing a layer. Fed to `computeComposite`
 * it reproduces `public/datasets/precomputed/combined_scores_v2.json` for all
 * 3,144 counties exactly, which `composite.parity.test.ts` asserts.
 *
 * Three things here are easy to get wrong, and each one was:
 *
 * 1. **The weights are the script's, exactly.** `BLO_PRESET` says it mapped
 *    percentages "roughly" to 1-10; in fact every one is exactly x40
 *    (0.10 -> 4, 0.05 -> 2, 0.15 -> 6). Weights are relative, so that is the
 *    same formula, not an approximation of it.
 *
 * 2. **The spans are a MIX, not a policy.** Five terms have natural bounds —
 *    a percentage runs 0-100, the diversity index 0-1 — and the script
 *    declares those. The other six are money, years and counts with no
 *    natural ceiling, and the script takes their observed span. Scaling all
 *    eleven one way or the other does not reproduce the index.
 *
 * 3. **The observed spans are PINNED here, not recomputed.** Recomputing them
 *    would mean every data refresh silently moved every historical score, and
 *    two vintages of the index would not be comparable. These are the spans
 *    the published numbers were made with; they are a property of THIS index,
 *    not of today's files. A new index gets its own.
 *
 * The registry's ranges are NOT these. `life_expectancy` is 65-87 there
 * against 69-89.5 here, `avg_weekly_wage` 300-3000 against 601-4514 — close
 * enough to look like roundings and far enough to change the answer.
 */

export interface BloIndexTerm {
  /** Registry layer id. */
  layer: string
  weight: number
  direction: 'higher_better' | 'lower_better'
  /** The span this term was scored against when the index was published. */
  range: { min: number; max: number }
  /** Whether that span is a natural bound or the data's own spread, recorded
   *  because it says whether a refresh ought to move it. */
  bound: 'natural' | 'observed-at-publication'
}

export const BLO_INDEX_V2: BloIndexTerm[] = [
  { layer: 'diversity_index',       weight: 4, direction: 'higher_better', range: { min: 0, max: 1 },          bound: 'natural' },
  { layer: 'pct_Black',             weight: 4, direction: 'higher_better', range: { min: 0, max: 100 },        bound: 'natural' },
  { layer: 'life_expectancy',       weight: 4, direction: 'higher_better', range: { min: 69, max: 89.5 },      bound: 'observed-at-publication' },
  { layer: 'contamination',         weight: 2, direction: 'lower_better',  range: { min: 0, max: 462 },        bound: 'observed-at-publication' },
  { layer: 'avg_weekly_wage',       weight: 4, direction: 'higher_better', range: { min: 601, max: 4514 },     bound: 'observed-at-publication' },
  { layer: 'median_income_by_race', weight: 4, direction: 'higher_better', range: { min: 2499, max: 250001 },  bound: 'observed-at-publication' },
  { layer: 'median_home_value',     weight: 4, direction: 'lower_better',  range: { min: 68300, max: 1535200 },bound: 'observed-at-publication' },
  { layer: 'median_property_tax',   weight: 2, direction: 'lower_better',  range: { min: 199, max: 10001 },    bound: 'observed-at-publication' },
  { layer: 'homeownership_by_race', weight: 2, direction: 'higher_better', range: { min: 0, max: 100 },        bound: 'natural' },
  { layer: 'poverty_by_race',       weight: 4, direction: 'lower_better',  range: { min: 0, max: 100 },        bound: 'natural' },
  { layer: 'black_progress_index',  weight: 6, direction: 'higher_better', range: { min: 0, max: 100 },        bound: 'natural' },
]

/**
 * A county missing a layer is scored on the data it HAS.
 *
 * The published index divides by the weight available, not the full declared
 * weight. Under `penalise` only 1,360 of 3,144 counties reproduce; under
 * `ignore`, all 3,144 do.
 */
export const BLO_INDEX_V2_MISSING = 'ignore' as const

/** The published score is 0-5; a composite is 0-100. Same number, one dial. */
export const BLO_INDEX_V2_SCALE = 1 / 20
