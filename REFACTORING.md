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

## Phase 2: Extract Data Loading and Color Calculation ✅ COMPLETED

### Overview
Phase 2 focused on extracting data loading and color calculation logic, reducing Map.vue from ~2,030 lines to ~1,641 lines (~389 line reduction, 19% decrease).

### Files Created

#### `src/types/mapTypes.ts` (~100 lines)
**Purpose**: TypeScript type definitions for all map data structures

**Exports**:
```typescript
interface CountyDiversityData {
  diversityIndex: number
  totalPopulation: number
  pct_Black: number
}

interface CombinedScoreData {
  combinedScore: number
  rankScore: number
}

interface ContaminationData {
  total: number
  brownfields?: number
  superfund?: number
  tri?: number
  hazardousWaste?: number
  airPollution?: number
}

interface LifeExpectancyData {
  lifeExpectancy: number
}

interface ColorBlend {
  r: number
  g: number
  b: number
  a: number
}
```

#### `src/composables/useMapData.ts` (~300 lines)
**Purpose**: Centralized data loading with progress tracking

**Exports**:
- `loadCountiesData()` - Load GeoJSON county boundaries
- `loadDiversityData()` - Load diversity and demographic data
- `loadLifeExpectancyData()` - Load life expectancy data
- `loadContaminationData()` - Load EPA contamination data
- `loadCombinedScores()` - Load BLO combined scores
- `loadContaminationLayers()` - Load individual EPA site layers

**Features**:
- Progress tracking for loading indicator
- Error handling and logging
- Data validation
- Centralized data state management

#### `src/composables/useColorCalculation.ts` (~200 lines)
**Purpose**: Color blending and normalization for choropleth layers

**Exports**:
- `preCalculateColors()` - Pre-compute all county colors
- `normalizeValue()` - Normalize values to 0-1 range
- `blendColors()` - Blend multiple layer colors
- `interpolateColor()` - Smooth color gradients

**Features**:
- Support for multiple active layers
- Color caching for performance
- Transparent blending algorithms
- Configurable color scales

### Changes to Map.vue

**Before Phase 2**: ~2,030 lines
**After Phase 2**: ~1,641 lines
**Reduction**: ~389 lines (19% decrease, 32% total reduction from original)

**What was removed**:
1. All data loading logic (moved to `useMapData`)
2. Color calculation functions (moved to `useColorCalculation`)
3. Type definitions scattered throughout (moved to `mapTypes.ts`)
4. Data transformation and normalization code

### Benefits Achieved

1. **Separation of Concerns**: Data loading separated from rendering
2. **Reusability**: Composables can be used in other components
3. **Type Safety**: Comprehensive TypeScript types prevent errors
4. **Maintainability**: Easier to modify data sources or color schemes
5. **Performance**: Pre-calculated colors improve map responsiveness
6. **Testability**: Data loading and color logic can be unit tested

---

## Phase 3: Component Splitting ✅ COMPLETED

### Overview
Phase 3 focused on extracting UI components and improving mobile/accessibility, reducing Map.vue from ~1,641 lines to ~1,550 lines (91 line reduction, 36% total reduction from original).

### Components Created

#### `src/components/CountyModal.vue` (~210 lines)
**Purpose**: Self-contained modal for displaying detailed county statistics

**Features**:
- Centered modal with responsive design
- Formatted data display (scores, rankings, demographics)
- ARIA accessibility attributes (role="dialog", aria-modal)
- Mobile-optimized layout
- 44px touch targets for close button

**Props**:
```typescript
{
  show: boolean
  countyId: string
  countyName: string
  diversityData?: CountyDiversityData
  contaminationData?: ContaminationData | number
  lifeExpectancy?: number
  combinedScore?: CombinedScoreData
}
```

#### `src/components/LayerControls.vue` (~180 lines)
**Purpose**: Layer toggle controls with checkbox inputs

**Features**:
- Expandable/collapsible panel
- Individual layer toggles for demographic data
- EPA contamination layer controls
- Tooltip support for layer descriptions
- Mobile: Bottom-left positioning, expands upward
- Desktop: Top-right positioning
- ARIA labels and keyboard navigation
- 44px minimum touch targets

**Props**:
```typescript
{
  expanded: boolean
  demographicLayers: DemographicLayer[]
  selectedDemographicLayers: string[]
  showContaminationLayers: boolean
  showContaminationChoropleth: boolean
  devModeOnly?: boolean
}
```

#### `src/components/LoadingIndicator.vue` (~60 lines)
**Purpose**: Loading progress overlay with progress bar

**Features**:
- Full-screen overlay during data loading
- Animated progress bar (0-100%)
- Smooth transitions
- Displays loading percentage

**Props**:
```typescript
{
  loaded: boolean
  progress: number
}
```

#### `src/components/AveragesPanel.vue` (~90 lines)
**Purpose**: Displays national county averages

**Features**:
- Collapsible panel at bottom-left
- Shows BLO score, demographics, life expectancy averages
- Hidden on mobile to prevent overlap
- ARIA accessibility attributes
- 44px touch targets

**Props**:
```typescript
{
  expanded: boolean
}
```

#### `src/config/stateFips.ts` (~60 lines)
**Purpose**: FIPS code to state name mapping

**Exports**:
- `FIPS_TO_STATE` - Object mapping FIPS codes to state names
- `getStateNameFromFips(code)` - Helper function

### Mobile & Accessibility Improvements

**Touch Targets**:
- All buttons: min-height 44px (WCAG AAA compliance)
- Close buttons: 44x44px clickable area
- Search buttons: 44px height

**ARIA Labels**:
- LayerControls: aria-expanded, aria-controls, aria-label
- AveragesPanel: aria-expanded, aria-controls, aria-label
- CountyModal: role="dialog", aria-modal, aria-labelledby

**Focus States**:
- 2px blue outline on all interactive elements
- 2px offset for visibility
- Consistent across all components

**Mobile Layout**:
- LayerControls: Bottom-left, expands upward, max-width prevents overflow
- AveragesPanel: Hidden on mobile (<768px)
- CountyModal: 90% width, centered, scrollable
- Search buttons: Full-width on mobile, stack vertically

**Responsive Breakpoint**: 768px

### Changes to Map.vue

**Before Phase 3**: ~1,641 lines
**After Phase 3**: ~1,550 lines
**Reduction**: ~91 lines (36% total reduction from original 2,420 lines)

**What was removed**:
1. FIPS mapping logic (moved to stateFips.ts)
2. County modal HTML generation (moved to CountyModal.vue)
3. Layer control template (moved to LayerControls.vue)
4. Loading indicator markup (moved to LoadingIndicator.vue)
5. Averages panel markup (moved to AveragesPanel.vue)
6. Duplicate mobile/desktop styles (moved to component files)

### Benefits Achieved

1. **Component Reusability**: Each UI component is self-contained
2. **Mobile-First**: Responsive design with proper touch targets
3. **Accessibility**: WCAG AAA compliance for keyboard and screen readers
4. **Maintainability**: UI changes isolated to component files
5. **Type Safety**: Component props and emits fully typed
6. **Performance**: Scoped styles prevent CSS conflicts
7. **Developer Experience**: Clear component boundaries

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
