/**
 * Type definitions for BLO Map data structures
 */

// ============= Color Types =============

/**
 * RGBA color tuple
 */
export type RGBAColor = [number, number, number, number]

/**
 * RGB color tuple
 */
export type RGBColor = [number, number, number]

/**
 * Pre-calculated color blends for a county
 */
export interface ColorBlend {
  geoID: string
  diversityColor: RGBAColor
  blackPctColor: RGBAColor
  contaminationColor: RGBAColor
  lifeExpectancyColor: RGBAColor
  blendedColors: {
    diversityAndContamination: RGBAColor
    blackPctAndContamination: RGBAColor
  }
  combinedScoreColor: RGBAColor
}

// ============= Data Types =============

/**
 * County demographic data
 */
export interface CountyDiversityData {
  diversityIndex: number
  totalPopulation: number
  nhWhite: number
  nhBlack: number
  pct_nhBlack: number
  pct_Black: number
  total_Black: number
  nhAmIndian: number
  nhAsian: number
  nhPacIslander: number
  nhTwoOrMore: number
  hispanic: number
  countyName: string
  stateName: string
}

/**
 * Collection of diversity data indexed by GEOID
 */
export interface DiversityData {
  [geoID: string]: CountyDiversityData
}

/**
 * Life expectancy data for a county
 */
export interface LifeExpectancyData {
  lifeExpectancy: number
  standardError: number
}

/**
 * Collection of life expectancy data indexed by GEOID
 */
export interface LifeExpectancyDataMap {
  [geoID: string]: LifeExpectancyData
}

/**
 * Contamination data for a county
 */
export interface ContaminationData {
  total: number
  layers?: {
    [layerId: string]: number
  }
}

/**
 * Collection of contamination data indexed by GEOID
 */
export interface ContaminationDataMap {
  [geoID: string]: ContaminationData | number
}

/**
 * BLO combined score data for a county
 */
export interface CombinedScoreData {
  combinedScore: number
  rankScore: number
  stdDevsFromMean: number
  countiesWithSameRank: number
}

/**
 * Collection of combined scores indexed by GEOID
 */
export interface CombinedScoresDataMap {
  [key: string]: CombinedScoreData
}

/**
 * BLO v2.0 score data with component breakdown
 */
export interface BLOScoreV2Data {
  fips: string
  county_name: string
  state_name: string
  blo_score_v2: number
  components: {
    diversity: number
    pct_black: number
    life_expectancy: number
    contamination: number
    avg_weekly_wage: number
    median_income_black: number
    median_home_value: number
    median_property_tax: number
    homeownership_black: number
    poverty_rate_black: number
    black_progress_index: number
  }
  raw: {
    diversity_index: number
    pct_black: number
    life_expectancy: number | null
    contamination_count: number
    avg_weekly_wage: number | null
    median_income_black: number | null
    median_home_value: number | null
    median_property_tax: number | null
    homeownership_rate_black: number | null
    poverty_rate_black: number | null
    black_progress_index: number | null
  }
  missing_data: string[]
}

/**
 * Collection of BLO v2.0 scores indexed by GEOID
 */
export interface BLOScoreV2DataMap {
  [geoID: string]: BLOScoreV2Data
}

/**
 * Economic data for a county
 */
export interface EconomicData {
  GEOID: string
  county_name: string
  state_name: string
  year: string
  avg_weekly_wage: number
  median_income_black?: number
}

/**
 * Collection of economic data indexed by GEOID
 */
export interface EconomicDataMap {
  [geoID: string]: EconomicData
}

/**
 * Housing data for a county
 */
export interface HousingData {
  GEOID: string
  county_name: string
  state_name: string
  year: string
  median_home_value?: number
  median_property_tax?: number
  homeownership_rate_black?: number
}

/**
 * Collection of housing data indexed by GEOID
 */
export interface HousingDataMap {
  [geoID: string]: HousingData
}

/**
 * Equity data for a county
 */
export interface EquityData {
  GEOID: string
  county_name: string
  state_name?: string
  state?: string
  year?: string
  poverty_rate_black?: number
  black_progress_index?: number
}

/**
 * Collection of equity data indexed by GEOID
 */
export interface EquityDataMap {
  [geoID: string]: EquityData
}

// ============= Computed Data Types =============

/**
 * Statistical averages for the dataset
 */
export interface DataAverages {
  diversityIndex: number
  blackPct: number
  contamination: number
  lifeExpectancy: number
  combinedScore?: number
}

/**
 * Range of values for normalization
 */
export interface DataRange {
  min: number
  max: number
}

// ============= GeoJSON Types =============

/**
 * County feature properties
 */
export interface CountyProperties {
  GEOID: string
  NAME: string
  STATE_NAME?: string
  STATEFP?: string
  COUNTYFP?: string
  [key: string]: any
}

/**
 * GeoJSON Feature with county properties
 */
export interface CountyFeature extends GeoJSON.Feature {
  properties: CountyProperties
}

/**
 * GeoJSON FeatureCollection with county features
 */
export interface CountiesGeoJSON extends GeoJSON.FeatureCollection {
  features: CountyFeature[]
}

// ============= Layer Types =============

/**
 * Layer visibility state
 */
export type LayerVisibility = 'visible' | 'none'

/**
 * Available demographic layers
 */
export type DemographicLayerId =
  | 'diversity_index'
  | 'pct_Black'
  | 'life_expectancy'
  | 'combined_scores'
  | 'combined_scores_v2'

/**
 * Available contamination layers
 */
export type ContaminationLayerId =
  | 'acres_brownfields'
  | 'air_pollution_sources'
  | 'hazardous_waste_sites'
  | 'superfund_sites'
  | 'toxic_release_inventory'

/**
 * Available economic layers
 */
export type EconomicLayerId = 'avg_weekly_wage' | 'median_income_by_race'

/**
 * Available housing layers
 */
export type HousingLayerId =
  | 'median_home_value'
  | 'median_property_tax'
  | 'homeownership_by_race'

/**
 * Available equity layers
 */
export type EquityLayerId = 'poverty_by_race' | 'black_progress_index'

// ============= Utility Types =============

/**
 * Parsed CSV row (generic)
 */
export interface CSVRow {
  [key: string]: string | number | null
}

/**
 * Papa Parse result type
 */
export interface ParseResult<T = any> {
  data: T[]
  errors: any[]
  meta: {
    fields?: string[]
    [key: string]: any
  }
}
