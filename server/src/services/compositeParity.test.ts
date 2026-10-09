import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { computeComposite, type CompositeTermValues } from './composite.js'

/**
 * P9-5: the published BLO Livability Index, reproduced by the composite path.
 *
 * This is the test that makes "the index is a working set" safe to say. If
 * the scorer ever stops reproducing the published numbers, this fails — and
 * the right response is to find out why, not to update the fixture.
 *
 * It reads the published file's own `raw` block as the inputs, so it is
 * testing the ARITHMETIC rather than today's data files: a data refresh
 * cannot break it, and a change to how a composite is scored will.
 */

const published = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../public/datasets/precomputed/combined_scores_v2.json', import.meta.url)),
    'utf8',
  ),
) as Record<string, { blo_score_v2: number; raw: Record<string, number | null> }>

/** raw key → the definition's term. Spans and weights from BLO_INDEX_V2. */
const TERMS: { rawKey: string; layer: string; weight: number; direction: 'higher_better' | 'lower_better'; range: { min: number; max: number } }[] = [
  { rawKey: 'diversity_index',          layer: 'diversity_index',       weight: 4, direction: 'higher_better', range: { min: 0, max: 1 } },
  { rawKey: 'pct_black',                layer: 'pct_Black',             weight: 4, direction: 'higher_better', range: { min: 0, max: 100 } },
  { rawKey: 'life_expectancy',          layer: 'life_expectancy',       weight: 4, direction: 'higher_better', range: { min: 69, max: 89.5 } },
  { rawKey: 'contamination_count',      layer: 'contamination',         weight: 2, direction: 'lower_better',  range: { min: 0, max: 462 } },
  { rawKey: 'avg_weekly_wage',          layer: 'avg_weekly_wage',       weight: 4, direction: 'higher_better', range: { min: 601, max: 4514 } },
  { rawKey: 'median_income_black',      layer: 'median_income_by_race', weight: 4, direction: 'higher_better', range: { min: 2499, max: 250001 } },
  { rawKey: 'median_home_value',        layer: 'median_home_value',     weight: 4, direction: 'lower_better',  range: { min: 68300, max: 1535200 } },
  { rawKey: 'median_property_tax',      layer: 'median_property_tax',   weight: 2, direction: 'lower_better',  range: { min: 199, max: 10001 } },
  { rawKey: 'homeownership_rate_black', layer: 'homeownership_by_race', weight: 2, direction: 'higher_better', range: { min: 0, max: 100 } },
  { rawKey: 'poverty_rate_black',       layer: 'poverty_by_race',       weight: 4, direction: 'lower_better',  range: { min: 0, max: 100 } },
  { rawKey: 'black_progress_index',     layer: 'black_progress_index',  weight: 6, direction: 'higher_better', range: { min: 0, max: 100 } },
]

function termsFromPublished(): CompositeTermValues[] {
  return TERMS.map(t => {
    const values: Record<string, number> = {}
    for (const [geoid, row] of Object.entries(published)) {
      const v = row.raw?.[t.rawKey]
      if (typeof v === 'number' && Number.isFinite(v)) values[geoid] = v
    }
    return {
      layer: t.layer,
      weight: t.weight,
      direction: t.direction,
      values,
      declaredRange: t.range,
    }
  })
}

describe('the published BLO index, reproduced (P9-5)', () => {
  it('reproduces all 3,144 county scores exactly', () => {
    const result = computeComposite(termsFromPublished(), { missing: 'ignore' })

    let compared = 0
    let worst = 0
    let worstGeoid = ''
    for (const [geoid, row] of Object.entries(published)) {
      const got = (result.values[geoid] ?? 0) / 20 // 0-100 → the published 0-5
      const delta = Math.abs(got - row.blo_score_v2)
      if (delta > worst) { worst = delta; worstGeoid = geoid }
      compared += 1
    }

    expect(compared).toBe(3144)
    // The published file rounds to 4dp, so that is the tolerance — anything
    // larger is a real difference in the arithmetic.
    expect(worst, `worst county ${worstGeoid}`).toBeLessThan(0.0001)
  })

  it('does NOT reproduce them under the other missing-data rule', () => {
    // The guard on the guard: if this ever passed too, the test above would
    // be proving nothing about the divisor.
    const result = computeComposite(termsFromPublished(), { missing: 'penalise' })
    let exact = 0
    for (const [geoid, row] of Object.entries(published)) {
      if (Math.abs((result.values[geoid] ?? 0) / 20 - row.blo_score_v2) < 0.0001) exact += 1
    }
    expect(exact).toBeLessThan(3144)
  })
})
