/**
 * National averages by layer ID. Single source of truth for "what does the
 * average county look like." Consumed by:
 *   - LensContext.vue (Context tab snapshot)
 *   - CountyRail.vue stats coloring (via Map.vue computed)
 *
 * Values sourced from the data team's published averages and the inline
 * constants previously scattered across Map.vue and AveragesPanel.vue.
 * Adding a new layer? Add its average here too — no other wiring needed.
 */
export interface NationalAverage {
  value: number
  /** Optional small footnote shown below the row in the Context tab. */
  note?: string
}

export const NATIONAL_AVERAGES: Record<string, NationalAverage> = {
  combined_scores_v2: { value: 2.42 },
  pct_Black: { value: 9.47 },
  diversity_index: { value: 0.3289 },
  life_expectancy: { value: 77.74 },
  contamination: { value: 8.77, note: 'Sites per county' },
  avg_weekly_wage: { value: 1070 },
  median_income_by_race: { value: 52493 },
  median_home_value: { value: 231974 },
  median_property_tax: { value: 2124 },
  homeownership_by_race: { value: 50.64 },
  poverty_by_race: { value: 29.44 },
  black_progress_index: { value: 74.02 },
  commute_time: { value: 5 },
  drove_alone: { value: 76 },
  public_transit: { value: 5 },
}
