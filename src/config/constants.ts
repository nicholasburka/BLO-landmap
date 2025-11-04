// Application mode flags
export const DEV_MODE_DEMOGRAPHICS_ONLY = false
export const DEBUG = true // Set to false to disable console logs

// API Configuration
export const RENTCAST_API_KEY = import.meta.env.VITE_RENTCAST_API_KEY || '72f7ed2c628a40169dfa4bdaf2655fd8'
export const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN

// Data file paths
export const DATA_PATHS = {
  COUNTIES: '/datasets/geographic/counties.geojson',
  CONTAMINATION_COUNTS: '/datasets/epa-contamination/contamination_counts.json',
  COMBINED_SCORES: '/datasets/BLO-liveability-index/combined_scores.json',
  DIVERSITY_DATA: '/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv',
  LIFE_EXPECTANCY: '/datasets/demographics/lifeexpectancy-USA-county.csv',
} as const

// Map configuration
export const MAP_CONFIG = {
  DEFAULT_CENTER: [-98.5795, 39.8283] as [number, number],
  DEFAULT_ZOOM: 2,
  GEOCODER_COUNTRIES: 'us',
} as const

// Property search configuration
export const PROPERTY_SEARCH = {
  BASE_URL: 'https://api.rentcast.io/v1/listings/sale',
  PROPERTY_TYPE: 'Land',
  STATUS: 'Active',
  LIMIT: 60,
  SEARCH_RADIUS: 100, // miles
} as const

// Color configuration
export const LAYER_COLORS = {
  DIVERSITY_INDEX: [128, 0, 128] as [number, number, number], // Purple
  PCT_BLACK: [139, 69, 19] as [number, number, number],       // Brown
  CONTAMINATION: [255, 0, 0] as [number, number, number],     // Red
  LIFE_EXPECTANCY: [0, 128, 0] as [number, number, number],   // Green
  COMBINED_SCORE: [0, 0, 255] as [number, number, number],    // Blue
} as const

// Debug logging helper
export const debugLog = (...args: any[]) => {
  if (DEBUG) {
    console.log(...args)
  }
}
