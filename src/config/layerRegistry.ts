/**
 * Unified Layer Registry
 *
 * Single source of truth for all layer metadata in the BLO National Map.
 * Consolidates data previously scattered across layerConfig.ts, datasetMetadata.ts,
 * ColorLegend.vue, Map.vue color functions, and constants.ts.
 */

// ============= Types =============

export type LayerCategory =
  | 'composite'
  | 'demographic'
  | 'economic'
  | 'housing'
  | 'equity'
  | 'transportation'
  | 'environment'
  | 'health'

export type DataType = 'percentage' | 'currency' | 'count' | 'index' | 'years' | 'ordinal'

export type Direction = 'higher_better' | 'lower_better' | 'neutral'

export interface LayerGradient {
  /** CSS linear-gradient string for the legend */
  css: string
  lowLabel: string
  highLabel: string
}

export interface LayerDefinition {
  id: string
  name: string
  category: LayerCategory
  dataType: DataType
  /** Semantic direction — describes what the metric means, used for LLM context and UI labels.
   *  NOT used as a scoring default (scoring defaults to neutral). */
  direction: Direction
  unit: string
  range: { min: number; max: number }
  /** Human-readable description, also used as LLM context */
  description: string
  source: string
  sourceUrl?: string
  year: number | string
  /** Path to dataset file in public/datasets/ */
  dataPath: string
  /** Field name in the loaded data map (used by scoring engine to look up raw values) */
  dataKey: string
  gradient: LayerGradient
  /** Display formatter for tooltip/modal values */
  formatValue: (value: number | string | null | undefined) => string
  /** Hex color for single-layer UI elements */
  color?: string
}

// ============= Formatters =============

const fmt = {
  dollars: (v: number | string | null | undefined): string => {
    if (v == null) return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (isNaN(n)) return '?'
    return `$${n.toLocaleString()}`
  },
  percent: (v: number | string | null | undefined, decimals = 1): string => {
    if (v == null) return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (isNaN(n)) return '?'
    return `${n.toFixed(decimals)}%`
  },
  decimal: (v: number | string | null | undefined, decimals = 4): string => {
    if (v == null) return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (isNaN(n)) return '?'
    return n.toFixed(decimals)
  },
  years: (v: number | string | null | undefined): string => {
    if (v == null) return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (isNaN(n)) return '?'
    return `${n.toFixed(1)} years`
  },
  count: (v: number | string | null | undefined, label = ''): string => {
    if (v == null) return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (isNaN(n)) return '?'
    return label ? `${n} ${label}` : `${n}`
  },
  score: (v: number | string | null | undefined, max: number): string => {
    if (v == null) return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (isNaN(n)) return '?'
    return `${n.toFixed(2)} of ${max}`
  },
  passthrough: (v: number | string | null | undefined): string => {
    if (v == null) return '?'
    return String(v)
  },
}

// ============= Registry =============

export const LAYER_REGISTRY: Record<string, LayerDefinition> = {
  // ---- Composite ----
  combined_scores_v2: {
    id: 'combined_scores_v2',
    name: 'BLO Livability Index',
    category: 'composite',
    dataType: 'index',
    direction: 'higher_better',
    unit: 'score',
    range: { min: 1.15, max: 3.28 },
    description: 'Comprehensive county livability score combining demographics, equity, economics, housing, environment, and health.',
    source: 'Black Land Ownership (BLO)',
    year: 2024,
    dataPath: '/datasets/precomputed/combined_scores_v2.json',
    dataKey: 'blo_score_v2',
    gradient: {
      css: 'linear-gradient(to right, rgb(255, 245, 100), rgb(0, 100, 0))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.score(v, 5.0),
  },

  // ---- Demographics ----
  diversity_index: {
    id: 'diversity_index',
    name: 'Diversity Index',
    category: 'demographic',
    dataType: 'index',
    direction: 'higher_better',
    unit: 'index',
    range: { min: 0, max: 1 },
    description: 'Probability that two randomly selected people are from different racial/ethnic groups.',
    source: 'US Census Bureau',
    sourceUrl: 'https://www.census.gov/topics/population/race/about.html',
    year: 2023,
    dataPath: '/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv',
    dataKey: 'diversityIndex',
    gradient: {
      css: 'linear-gradient(to right, rgb(200, 0, 200), rgb(100, 0, 150))',
      lowLabel: 'Less Diverse',
      highLabel: 'More Diverse',
    },
    formatValue: (v) => fmt.decimal(v, 4),
    color: '#800080',
  },

  pct_Black: {
    id: 'pct_Black',
    name: 'Percent Black',
    category: 'demographic',
    dataType: 'percentage',
    direction: 'higher_better',
    unit: '%',
    range: { min: 0, max: 100 },
    description: 'Percentage of county residents who identify as Black or African American.',
    source: 'US Census Bureau',
    sourceUrl: 'https://www.census.gov/topics/population/race.html',
    year: 2023,
    dataPath: '/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv',
    dataKey: 'pct_nhBlack',
    gradient: {
      css: 'linear-gradient(to right, rgb(139, 69, 19, 0.3), rgb(69, 35, 10, 0.95))',
      lowLabel: 'Lower %',
      highLabel: 'Higher %',
    },
    formatValue: (v) => fmt.percent(v, 2),
    color: '#8B4513',
  },

  // ---- Health ----
  life_expectancy: {
    id: 'life_expectancy',
    name: 'Life Expectancy',
    category: 'health',
    dataType: 'years',
    direction: 'higher_better',
    unit: 'years',
    range: { min: 65, max: 87 },
    description: 'Average years a person born in this county is expected to live.',
    source: 'Institute for Health Metrics and Evaluation (IHME)',
    sourceUrl: 'https://www.healthdata.org/',
    year: 2014,
    dataPath: '/datasets/demographics/lifeexpectancy-USA-county.csv',
    dataKey: 'lifeExpectancy',
    gradient: {
      css: 'linear-gradient(to right, rgb(255, 100, 100), rgb(100, 200, 100))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.years(v),
  },

  // ---- Economic ----
  avg_weekly_wage: {
    id: 'avg_weekly_wage',
    name: 'Average Weekly Wage',
    category: 'economic',
    dataType: 'currency',
    direction: 'higher_better',
    unit: '$',
    range: { min: 300, max: 3000 },
    description: 'Average weekly wages across all industries in the county.',
    source: 'US Bureau of Labor Statistics (BLS)',
    sourceUrl: 'https://www.bls.gov/cew/',
    year: 2023,
    dataPath: '/datasets/economic/avg_weekly_wages.csv',
    dataKey: 'avg_weekly_wage',
    gradient: {
      css: 'linear-gradient(to right, rgb(200, 220, 100), rgb(0, 100, 0))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.dollars(v),
    color: '#2E8B57',
  },

  median_income_by_race: {
    id: 'median_income_by_race',
    name: 'Median Income (Black)',
    category: 'economic',
    dataType: 'currency',
    direction: 'higher_better',
    unit: '$',
    range: { min: 15000, max: 250000 },
    description: 'Median household income for Black households in the county.',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    dataPath: '/datasets/economic/median_income_by_race.csv',
    dataKey: 'median_income_black',
    gradient: {
      css: 'linear-gradient(to right, rgba(100, 200, 255, 0.3), rgba(0, 50, 150, 0.95))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.dollars(v),
    color: '#20B2AA',
  },

  // ---- Housing ----
  median_home_value: {
    id: 'median_home_value',
    name: 'Median Home Value',
    category: 'housing',
    dataType: 'currency',
    direction: 'lower_better',
    unit: '$',
    range: { min: 30000, max: 1535200 },
    description: 'Median value of owner-occupied homes with mortgages (lower is more affordable).',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    dataPath: '/datasets/housing/median_home_value.csv',
    dataKey: 'median_home_value',
    gradient: {
      css: 'linear-gradient(to right, rgb(0, 180, 0), rgb(220, 0, 0))',
      lowLabel: 'More Affordable',
      highLabel: 'Less Affordable',
    },
    formatValue: (v) => fmt.dollars(v),
    color: '#FF6347',
  },

  median_property_tax: {
    id: 'median_property_tax',
    name: 'Median Property Tax',
    category: 'housing',
    dataType: 'currency',
    direction: 'lower_better',
    unit: '$',
    range: { min: 200, max: 10000 },
    description: 'Median annual property tax paid by homeowners (lower is better).',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    dataPath: '/datasets/housing/median_property_tax.csv',
    dataKey: 'median_property_tax',
    gradient: {
      css: 'linear-gradient(to right, rgb(100, 200, 100), rgb(255, 100, 100))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.dollars(v),
    color: '#FF4500',
  },

  // ---- Equity ----
  homeownership_by_race: {
    id: 'homeownership_by_race',
    name: 'Black Homeownership Rate',
    category: 'equity',
    dataType: 'percentage',
    direction: 'higher_better',
    unit: '%',
    range: { min: 0, max: 100 },
    description: 'Percentage of Black households that own their homes.',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    dataPath: '/datasets/equity/homeownership_by_race.csv',
    dataKey: 'homeownership_rate_black',
    gradient: {
      css: 'linear-gradient(to right, rgb(220, 100, 100), rgb(100, 200, 100))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.percent(v, 1),
    color: '#FFA500',
  },

  poverty_by_race: {
    id: 'poverty_by_race',
    name: 'Poverty Rate (Black)',
    category: 'equity',
    dataType: 'percentage',
    direction: 'lower_better',
    unit: '%',
    range: { min: 0, max: 100 },
    description: 'Percentage of Black individuals living below the federal poverty line.',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    dataPath: '/datasets/equity/poverty_by_race.csv',
    dataKey: 'poverty_rate_black',
    gradient: {
      css: 'linear-gradient(to right, rgb(100, 200, 100), rgb(200, 0, 0))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.percent(v, 1),
    color: '#9370DB',
  },

  black_progress_index: {
    id: 'black_progress_index',
    name: 'Black Progress Index',
    category: 'equity',
    dataType: 'index',
    direction: 'higher_better',
    unit: 'index',
    range: { min: 0, max: 100 },
    description: 'Composite measure of Black wellbeing from NAACP & Brookings combining health, education, and economic indicators.',
    source: 'NAACP & Brookings Institution',
    sourceUrl: 'https://www.brookings.edu/',
    year: 2020,
    dataPath: '/datasets/equity/black_progress_index.csv',
    dataKey: 'black_progress_index',
    gradient: {
      css: 'linear-gradient(to right, rgb(220, 100, 100), rgb(100, 200, 100))',
      lowLabel: 'Lower',
      highLabel: 'Higher',
    },
    formatValue: (v) => fmt.decimal(v, 2),
    color: '#8A2BE2',
  },

  // ---- Transportation ----
  commute_time: {
    id: 'commute_time',
    name: 'Most Common Commute Time',
    category: 'transportation',
    dataType: 'ordinal',
    direction: 'lower_better',
    unit: 'category',
    range: { min: 1, max: 9 },
    description: 'Most frequent commute time category for Black workers age 16+ in the county.',
    source: 'Black Worker Data Center (BWDC)',
    sourceUrl: 'https://blackworkers.org/',
    year: 2023,
    dataPath: '/datasets/transportation/commute_times.csv',
    dataKey: 'most_frequent_commute_time',
    gradient: {
      css: 'linear-gradient(to right, rgb(0, 180, 0), rgb(255, 255, 0), rgb(255, 0, 0))',
      lowLabel: 'Shorter',
      highLabel: 'Longer',
    },
    formatValue: (v) => fmt.passthrough(v),
    color: '#FF6B6B',
  },

  drove_alone: {
    id: 'drove_alone',
    name: '% Drove Alone (Black Workers)',
    category: 'transportation',
    dataType: 'percentage',
    direction: 'neutral',
    unit: '%',
    range: { min: 0, max: 100 },
    description: 'Percentage of Black workers age 16+ who drove alone to work.',
    source: 'Black Worker Data Center (BWDC)',
    sourceUrl: 'https://blackworkers.org/',
    year: 2023,
    dataPath: '/datasets/transportation/commute_times.csv',
    dataKey: 'pct_drove_alone',
    gradient: {
      css: 'linear-gradient(to right, rgb(78, 205, 196), rgb(28, 125, 146))',
      lowLabel: 'Lower %',
      highLabel: 'Higher %',
    },
    formatValue: (v) => fmt.percent(v, 1),
    color: '#4ECDC4',
  },

  public_transit: {
    id: 'public_transit',
    name: '% Public Transit (Black Workers)',
    category: 'transportation',
    dataType: 'percentage',
    direction: 'higher_better',
    unit: '%',
    range: { min: 0, max: 100 },
    description: 'Percentage of Black workers age 16+ who used public transportation to work.',
    source: 'Black Worker Data Center (BWDC)',
    sourceUrl: 'https://blackworkers.org/',
    year: 2023,
    dataPath: '/datasets/transportation/commute_times.csv',
    dataKey: 'pct_public_transit',
    gradient: {
      css: 'linear-gradient(to right, rgb(200, 150, 230), rgb(155, 89, 182))',
      lowLabel: 'Lower %',
      highLabel: 'Higher %',
    },
    formatValue: (v) => fmt.percent(v, 1),
    color: '#9B59B6',
  },

  // ---- Environment ----
  contamination: {
    id: 'contamination',
    name: 'EPA Contamination Sites',
    category: 'environment',
    dataType: 'count',
    direction: 'lower_better',
    unit: 'sites',
    range: { min: 0, max: 500 },
    description: 'Total EPA-tracked contamination sites per county (lower is better).',
    source: 'Environmental Protection Agency (EPA)',
    sourceUrl: 'https://www.epa.gov/enviro',
    year: 2024,
    dataPath: '/datasets/epa-contamination/contamination_counts.json',
    dataKey: 'total',
    gradient: {
      css: 'linear-gradient(to right, rgba(255, 0, 0, 0), rgba(255, 0, 0, 1))',
      lowLabel: 'Fewer Sites',
      highLabel: 'More Sites',
    },
    formatValue: (v) => fmt.count(v, 'sites'),
  },
}

// ============= Helpers =============

/** Get a single layer definition by ID. Throws if not found. */
export function getLayer(id: string): LayerDefinition {
  const layer = LAYER_REGISTRY[id]
  if (!layer) throw new Error(`Layer not found in registry: ${id}`)
  return layer
}

/** Get all layers in a category. */
export function getLayersByCategory(category: LayerCategory): LayerDefinition[] {
  return Object.values(LAYER_REGISTRY).filter((l) => l.category === category)
}

/** Get all layers that can be used in dynamic scoring (excludes the composite BLO score). */
export function getAllScorableLayers(): LayerDefinition[] {
  return Object.values(LAYER_REGISTRY).filter((l) => l.category !== 'composite')
}

/** Get all layer IDs. */
export function getAllLayerIds(): string[] {
  return Object.keys(LAYER_REGISTRY)
}

/** Serialize the registry for use as LLM system prompt context (Phase 2). */
export function getRegistryForLLM(): string {
  const layers = getAllScorableLayers()
  const lines = layers.map((l) => {
    return [
      `- **${l.name}** (id: \`${l.id}\`)`,
      `  Category: ${l.category} | Type: ${l.dataType} | Unit: ${l.unit}`,
      `  Direction: ${l.direction} | Range: ${l.range.min}–${l.range.max}`,
      `  Source: ${l.source} (${l.year})`,
      `  ${l.description}`,
    ].join('\n')
  })
  return `# Available Data Layers\n\n${lines.join('\n\n')}`
}
