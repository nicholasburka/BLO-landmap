# Map Component Refactoring

This document tracks the refactoring of the BLO Map component to improve maintainability and make it easier to add new data layers.

## Phase 1: Extract Composables, Configs, and Constants ✅ COMPLETED

### Overview
Phase 1 focused on extracting self-contained functionality into separate modules, reducing Map.vue from ~2,420 lines to ~2,030 lines (~390 line reduction, 16% decrease).

### Files Created

#### 1. `src/composables/usePropertyListings.ts` (~250 lines)
**Purpose**: Encapsulates all property listing search functionality

**Exports**:
- **State**:
  - `listings` - Array of property listing results
  - `listingMarkers` - Mapbox markers for listings
  - `listingsPanelExpanded` - Panel visibility state
  - `isSearchResultsLoading` - Loading indicator state
  - `currentGeocoderResult` - Current geocoder search result

- **Methods**:
  - `searchListings()` - Fetch and display property listings
  - `clearSearch()` - Clear search results and markers
  - `downloadCSV()` - Export listings to CSV file
  - `highlightMarker(listing)` - Highlight selected listing on map
  - `toggleListings()` - Toggle listings panel visibility

**Usage**:
```typescript
const {
  listings,
  searchListings,
  clearSearch,
  downloadCSV,
  highlightMarker,
  toggleListings,
} = usePropertyListings(map, geocoderRef)
```

#### 2. `src/config/layerConfig.ts` (~90 lines)
**Purpose**: Centralized layer configuration with TypeScript interfaces

**Exports**:
- `DEMOGRAPHIC_LAYERS[]` - Configuration for demographic data layers
  - Diversity Index
  - Percent Black
  - Life Expectancy
  - BLO Combined Score

- `CONTAMINATION_LAYERS[]` - Configuration for EPA contamination layers
  - Brownfields
  - Air Pollution Sources
  - Hazardous Waste Sites
  - Superfund Sites
  - Toxic Release Inventory

**Layer Structure**:
```typescript
interface DemographicLayer {
  id: string          // Unique layer identifier
  name: string        // Display name in UI
  file?: string       // Data file path
  color?: string      // Layer color (hex)
  visible: boolean    // Initial visibility
  tooltip?: string    // Tooltip text
}
```

**Adding New Layers**: Simply add a new object to the array:
```typescript
{
  id: 'crime_rate',
  name: 'Crime Rate',
  file: '/datasets/demographics/crime_rate.csv',
  color: '#FFA500',
  visible: false,
  tooltip: '2023 FBI Crime Statistics',
}
```

#### 3. `src/config/constants.ts` (~50 lines)
**Purpose**: Single source of truth for all configuration values

**Exports**:

**Feature Flags**:
- `DEV_MODE_DEMOGRAPHICS_ONLY` - Toggle demographic-only mode
- `DEBUG` - Enable/disable debug logging

**API Configuration**:
- `RENTCAST_API_KEY` - Property listing API key
- `MAPBOX_ACCESS_TOKEN` - Mapbox access token

**Data Paths** (all dataset file paths):
```typescript
DATA_PATHS = {
  COUNTIES: '/datasets/geographic/counties.geojson',
  CONTAMINATION_COUNTS: '/datasets/epa-contamination/contamination_counts.json',
  COMBINED_SCORES: '/datasets/BLO-liveability-index/combined_scores.json',
  DIVERSITY_DATA: '/datasets/demographics/county_pctBlack_diversity_index_with_stats.csv',
  LIFE_EXPECTANCY: '/datasets/demographics/lifeexpectancy-USA-county.csv',
}
```

**Map Configuration**:
```typescript
MAP_CONFIG = {
  DEFAULT_CENTER: [-98.5795, 39.8283],  // Center of USA
  DEFAULT_ZOOM: 2,
  GEOCODER_COUNTRIES: 'us',
}
```

**Property Search Configuration**:
```typescript
PROPERTY_SEARCH = {
  BASE_URL: 'https://api.rentcast.io/v1/listings/sale',
  PROPERTY_TYPE: 'Land',
  STATUS: 'Active',
  LIMIT: 60,
  SEARCH_RADIUS: 100,  // miles
}
```

**Layer Colors** (RGB tuples):
```typescript
LAYER_COLORS = {
  DIVERSITY_INDEX: [128, 0, 128],   // Purple
  PCT_BLACK: [139, 69, 19],         // Brown
  CONTAMINATION: [255, 0, 0],       // Red
  LIFE_EXPECTANCY: [0, 128, 0],     // Green
  COMBINED_SCORE: [0, 0, 255],      // Blue
}
```

**Utilities**:
- `debugLog(...args)` - Centralized debug logging function

### Changes to Map.vue

**Before Phase 1**: ~2,420 lines
**After Phase 1**: ~2,030 lines
**Reduction**: ~390 lines (16%)

**What was removed**:
1. All property listing logic (moved to `usePropertyListings`)
2. Hard-coded layer configurations (moved to `layerConfig`)
3. Hard-coded constants and magic values (moved to `constants`)
4. Duplicate color definitions
5. API keys and URLs scattered throughout code

**What was updated**:
```typescript
// Old
const DEV_MODE_DEMOGRAPHICS_ONLY = false
const DEBUG = true
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
const searchUrl = 'https://api.rentcast.io/v1/listings/sale?'

// New
import { DEV_MODE_DEMOGRAPHICS_ONLY, DEBUG, MAPBOX_ACCESS_TOKEN } from '@/config/constants'
mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN
const searchUrl = `${PROPERTY_SEARCH.BASE_URL}?`
```

### Benefits Achieved

1. **Separation of Concerns**: Business logic separated from configuration
2. **Reusability**: Property listings composable can be used in other components
3. **Maintainability**: Changes to API keys, URLs, or layer configs require editing only one file
4. **Type Safety**: TypeScript interfaces ensure layer configs are valid
5. **Easier Testing**: Isolated modules can be unit tested independently
6. **Developer Experience**: Constants autocomplete in IDE, reducing typos
7. **Scalability**: Adding new layers is now a simple config addition

### Migration Guide

If you need to:

**Add a new data layer**:
1. Add entry to `src/config/layerConfig.ts` in `DEMOGRAPHIC_LAYERS` array
2. Add color to `LAYER_COLORS` in `src/config/constants.ts` if needed
3. Add data file path to `DATA_PATHS` if needed

**Change API configuration**:
1. Edit `src/config/constants.ts` - update `PROPERTY_SEARCH` or API keys

**Modify map defaults**:
1. Edit `src/config/constants.ts` - update `MAP_CONFIG`

**Update data file locations**:
1. Edit `src/config/constants.ts` - update `DATA_PATHS`

---

## Phase 2: Extract Data Loading and Color Calculation (PLANNED)

### Goals
- Extract data loading logic into `useMapData` composable
- Extract color calculation into `useColorCalculation` composable
- Create TypeScript type definitions in `mapTypes.ts`
- Further reduce Map.vue to ~1,000 lines

### Files to Create

#### `src/types/mapTypes.ts`
Type definitions for:
- `DiversityData`
- `CombinedScoreData`
- `ContaminationData`
- `ColorBlend`
- `LifeExpectancyData`

#### `src/composables/useMapData.ts`
Functions:
- `loadCountiesData()`
- `loadDiversityData()`
- `loadLifeExpectancyData()`
- `loadContaminationData()`

#### `src/composables/useColorCalculation.ts`
Functions:
- `preCalculateColors()`
- `getColorForLayer()`
- `blendColors()`
- `normalizeValue()`

### Expected Impact
- Map.vue: ~2,030 → ~1,000 lines (50% reduction)
- Better separation between data fetching and rendering
- Color logic reusable across components

---

## Phase 3: Component Splitting (PLANNED)

### Goals
- Split Map.vue into smaller sub-components
- Create unified data processing pipeline
- Build centralized scoring engine

### Components to Create
- `MapControls.vue` - Layer toggles and controls
- `CountyTooltip.vue` - Hover tooltip component
- `CountyModal.vue` - Detailed county statistics modal
- `LayerLegend.vue` - Map legend component
- `LoadingIndicator.vue` - Loading progress indicator

### Pipeline Restructure
Move scripts to unified pipeline:
```
scripts/pipeline/
├── 1-fetch-data.sh
├── 2-preprocess-census.py
├── 3-calculate-scores.cjs
├── 4-generate-combined.cjs
└── README.md
```

### Scoring Engine
Create `src/lib/ScoringEngine.ts`:
- Centralized scoring logic
- Easy to add new metrics
- Configurable weights
- Transparent calculations

### Expected Impact
- Map.vue: ~1,000 → ~200 lines (92% total reduction from original)
- Each component < 200 lines
- Clear separation of concerns
- Easy to test and maintain

---

## Testing Strategy

After each phase:
1. ✅ Verify map loads correctly
2. ✅ Test all layer toggles
3. ✅ Test property search functionality
4. ✅ Test hover tooltips
5. ✅ Test county click modals
6. ✅ Verify data loads correctly
7. ✅ Check console for errors

---

## Rollback Strategy

Each phase is in version control. To rollback:
```bash
git log --oneline  # Find commit before refactoring
git revert <commit-hash>
```

All refactoring maintains backward compatibility - no breaking changes to user-facing functionality.
