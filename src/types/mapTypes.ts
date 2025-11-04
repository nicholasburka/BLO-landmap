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

/**
 * Available contamination layers
 */
export type ContaminationLayerId =
  | 'acres_brownfields'
  | 'air_pollution_sources'
  | 'hazardous_waste_sites'
  | 'superfund_sites'
  | 'toxic_release_inventory'

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
