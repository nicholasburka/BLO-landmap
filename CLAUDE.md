# BLO National Map - AI Coding Agent Instructions

## Project Overview
This is a Vue 3 + TypeScript + Mapbox GL application for the Black Livability Observatory (BLO) National Map. It displays county-level livability data with interactive choropleth layers.

## Architecture

### Key Directories
- `src/components/` - Vue components (Map.vue is the main component)
- `src/composables/` - Data loading and state management
- `src/config/` - Layer configuration and constants
- `src/types/` - TypeScript type definitions
- `public/datasets/` - Static data files served to the browser
- `scripts/` - Preprocessing scripts for data transformation

### Data Flow
1. Raw data in `source-data/` is preprocessed by scripts
2. Processed data goes to `public/datasets/` as CSV/JSON
3. `useMapData.ts` composable loads data on app mount
4. Data is indexed by 5-digit FIPS GEOID codes
5. `Map.vue` renders choropleth layers based on selected layers

---

## Standards for Adding New Data Layers

When adding a new data layer category (e.g., Transportation, Climate, etc.), follow this checklist:

### 1. Data Preprocessing
- Create preprocessing script in `scripts/` to map county names to FIPS codes
- Output CSV with `GEOID` column (5-digit, zero-padded)
- Place output in `public/datasets/{category}/`

### 2. Configuration Files
Update these files in order:
1. `src/config/layerConfig.ts` - Add layer interface and `{CATEGORY}_LAYERS` array
2. `src/types/mapTypes.ts` - Add data interface and layer ID type
3. `src/config/constants.ts` - Add file path to `DATA_PATHS`

### 3. Data Loading
In `src/composables/useMapData.ts`:
- Add `{category}Data` ref with proper type
- Add `load{Category}Data()` async function
- Add to `loadAllCountyData()` call sequence
- Export ref and function

### 4. Map Component Integration
In `src/components/Map.vue`:
- Import layer config and data from composables
- Add `selected{Category}Layers` ref
- Add to `allSelectedLayers` computed
- Add `toggle{Category}Layer()` function
- Add `getColorFor{Category}Layer()` color calculation function
- **IMPORTANT: Add to hover tooltip** (see Tooltip Standard below)
- Update `updateChoroplethVisibility()` to include new layers
- Update `updateChoroplethColors()` to handle new layers
- Pass props to LayerControls, ColorLegend, CountyModal

### 5. UI Components
- `LayerControls.vue` - Add props, emits, and template section
- `ColorLegend.vue` - Add legend definitions and update `activeLayers`
- `CountyModal.vue` - Add props and display section

---

## Tooltip Standard (CRITICAL)

**When a layer is toggled, hovering over a county MUST show that layer's value in the tooltip.**

### Implementation Pattern

In `Map.vue`, inside the `addTooltip()` function:

#### Step 1: Add to `getLayerName()` helper (if layer name not in config)
```typescript
const getLayerName = (layerId: string) => {
  // Check allLayers array for name
  const allLayers = [
    ...demographicLayers,
    ...economicLayers,
    ...housingLayers,
    ...equityLayers,
    ...transportationLayers,  // Add new category
  ];
  return allLayers.find(l => l.id === layerId)?.name || layerId;
};
```

#### Step 2: Add cases to `getLayerValue()` helper
```typescript
const getLayerValue = (layerId: string) => {
  switch (layerId) {
    // ... existing cases ...

    // NEW: Transportation layers
    case 'commute_time':
      return transportationData.value[countyId]?.most_frequent_commute_time || '?';
    case 'drove_alone':
      return transportationData.value[countyId]?.pct_drove_alone != null
        ? `${transportationData.value[countyId].pct_drove_alone.toFixed(1)}%`
        : '?';
    case 'public_transit':
      return transportationData.value[countyId]?.pct_public_transit != null
        ? `${transportationData.value[countyId].pct_public_transit.toFixed(1)}%`
        : '?';

    default:
      return '?';
  }
};
```

#### Step 3: Add to activeLayers collection
```typescript
const activeLayers = [
  ...selectedDemographicLayers.value,
  ...selectedEconomicLayers.value,
  ...selectedHousingLayers.value,
  ...selectedEquityLayers.value,
  ...selectedTransportationLayers.value,  // Add new category
];
```

The tooltip automatically displays values for all layers in `activeLayers` by iterating through them and calling `getLayerName()` and `getLayerValue()`.

---

## Color Calculation Patterns

### Percentage Values (0-100)
```typescript
const normalized = Math.max(0, Math.min(1, value / 100));
const curved = Math.pow(normalized, 0.8);
// Apply to RGB
```

### Ordinal Values (categorical)
```typescript
const normalized = (value - min) / (max - min);
// Use green-yellow-red or similar gradient
```

### Inverted Scales (lower is better)
For metrics like poverty, property tax, etc.:
```typescript
const r = Math.round(curved * 220);        // Low = green
const g = Math.round((1 - curved) * 200);  // High = red
```

---

## Testing Checklist

After adding a new layer category:
- [ ] TypeScript compiles (`npm run build`)
- [ ] Layer appears in LayerControls
- [ ] Toggling layer shows choropleth colors
- [ ] Hovering shows layer value in tooltip
- [ ] Color legend displays when layer selected
- [ ] CountyModal shows data when county clicked
- [ ] No console errors during interaction

---

## Common FIPS Code Issues

- Always pad GEOID to 5 digits: `geoID.toString().padStart(5, '0')`
- County names vary (Parish, Borough, Census Area) - handle edge cases
- Some data uses `geo_id` format `0500000US{FIPS}` - extract the FIPS portion

---

## File Naming Conventions

- Layer configs: `{CATEGORY}_LAYERS` (e.g., `TRANSPORTATION_LAYERS`)
- Data refs: `{category}Data` (e.g., `transportationData`)
- Load functions: `load{Category}Data` (e.g., `loadTransportationData`)
- Toggle functions: `toggle{Category}Layer` (e.g., `toggleTransportationLayer`)
- Color functions: `getColorFor{Category}Layer` (e.g., `getColorForTransportationLayer`)
