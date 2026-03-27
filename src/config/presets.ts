/**
 * Scoring Presets
 *
 * Predefined scoring queries that users can load as starting points.
 * The BLO Livability Index preset mirrors the original BLO v2 composite
 * score weights and directions.
 */

import type { ScoringQuery } from '@/types/mapTypes'

/**
 * BLO Livability Index preset.
 * Weights mapped from original percentage weights in calculate_blo_v2_scores.cjs
 * to 1-10 scale (roughly: 5% → 2, 10% → 4, 15% → 6).
 */
export const BLO_PRESET: ScoringQuery = [
  { layerId: 'diversity_index', weight: 4, direction: 'higher_better' },
  { layerId: 'pct_Black', weight: 4, direction: 'higher_better' },
  { layerId: 'life_expectancy', weight: 4, direction: 'higher_better' },
  { layerId: 'contamination', weight: 2, direction: 'lower_better' },
  { layerId: 'avg_weekly_wage', weight: 4, direction: 'higher_better' },
  { layerId: 'median_income_by_race', weight: 4, direction: 'higher_better' },
  { layerId: 'median_home_value', weight: 4, direction: 'lower_better' },
  { layerId: 'median_property_tax', weight: 2, direction: 'lower_better' },
  { layerId: 'homeownership_by_race', weight: 2, direction: 'higher_better' },
  { layerId: 'poverty_by_race', weight: 4, direction: 'lower_better' },
  { layerId: 'black_progress_index', weight: 6, direction: 'higher_better' },
]

/** Layer IDs included in the BLO preset */
export const BLO_PRESET_LAYER_IDS = BLO_PRESET.map(q => q.layerId)

/** Which category each preset layer belongs to, for selecting across category arrays */
export const BLO_PRESET_CATEGORIES: Record<string, string> = {
  'diversity_index': 'demographic',
  'pct_Black': 'demographic',
  'life_expectancy': 'demographic',
  'contamination': 'contamination',
  'avg_weekly_wage': 'economic',
  'median_income_by_race': 'economic',
  'median_home_value': 'housing',
  'median_property_tax': 'housing',
  'homeownership_by_race': 'housing',
  'poverty_by_race': 'equity',
  'black_progress_index': 'equity',
}
