// Application mode flags
export const DEV_MODE_DEMOGRAPHICS_ONLY = false
export const DEBUG = import.meta.env.DEV // console logs in dev builds only

// API Configuration
export const RENTCAST_API_KEY = import.meta.env.VITE_RENTCAST_API_KEY || ''
export const MAPBOX_ACCESS_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN

// Data file paths
//
// P5-90: the map no longer fetches the raw per-category CSVs. They are build
// inputs now — `scripts/build-datasets.mjs` (`SOURCE_FILES`) folds them into
// one content-hashed county file and writes the URLs the app imports into
// `src/config/datasetsManifest.generated.json`. Add a new dataset there, not
// here.

// Map configuration
export const MAP_CONFIG = {
  // Centered on the geographic center of the contiguous US
  DEFAULT_CENTER: [-98.5795, 39.8283] as [number, number],
  // Phase 4d cleanup: tighten initial framing so the user sees the CONUS,
  // not an oceans-and-Greenland world view.
  DEFAULT_ZOOM: 3.5,
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

// Debug logging helper
export const debugLog = (...args: any[]) => {
  if (DEBUG) {
    console.log(...args)
  }
}
