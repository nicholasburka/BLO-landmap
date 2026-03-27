# Commute Times Layer Implementation Plan

## Overview
Integrate commute times data from the BWDC (Black Worker Data Center) into the BLO National Map as a new "Transportation" layer category.

## Data Source
- **File:** `source-data/commute-times/emp_06.csv`
- **Records:** 36,784 total (3,144 county-level, 33,640 ZCTA-level)
- **Year:** 2023

### Available Fields
| Field | Description | Coverage |
|-------|-------------|----------|
| `geo_level` | "county" or "zcta" | 100% |
| `geo_name` | "County Name, State" format | 100% |
| `most_frequent_commute_time` | 12 categorical ranges | 100% |
| `pct_workers_16andover_drove_alone_black_alone` | % drove alone | 97% |
| `pct_workers_16andover_carpooled_in_car_truck_van_black_alone` | % carpooled | 88% |
| `pct_workers_16andover_public_transportation_black_alone` | % public transit | 44% |
| `pct_black_alone` | % Black population | 98% |

### Commute Time Categories (Ordinal Scale)
1. Less than 5 minutes
2. 5 to 9 minutes
3. 10 to 14 minutes
4. 15 to 19 minutes
5. 20 to 24 minutes
6. 25 to 29 minutes
7. 30 to 34 minutes
8. 35 to 39 minutes
9. 40 to 44 minutes
10. 45 to 59 minutes
11. 60 to 89 minutes
12. 90 or more minutes

## Critical Preprocessing Requirement
**The source data lacks FIPS codes.** County names must be mapped to 5-digit FIPS codes for joining with existing map data.

### FIPS Mapping Strategy
1. Extract county name + state from `geo_name` field
2. Use existing `counties.geojson` as FIPS lookup source
3. Handle edge cases: Parishes (LA), Boroughs (AK), Independent Cities (VA)
4. Output: CSV with GEOID column for map integration

---

## Phase 1: Data Preprocessing

### Task 1.1: Create FIPS Mapping Script
- Read `counties.geojson` to build name→FIPS lookup
- Handle naming variations and edge cases
- Output reusable lookup table

### Task 1.2: Process Commute Times Data
- Filter to county-level records only
- Join FIPS codes using lookup
- Validate join success rate
- Output to `public/datasets/transportation/commute_times.csv`

### Expected Output Format
```csv
GEOID,county_name,state_name,most_frequent_commute_time,commute_time_ordinal,pct_drove_alone,pct_carpooled,pct_public_transit,pct_black
01001,Autauga County,Alabama,25 to 29 minutes,6,85.2,8.1,0.5,18.7
```

---

## Phase 2: Map Integration

### Task 2.1: Layer Configuration
**File:** `src/config/layerConfig.ts`
- Add `TransportationLayer` interface
- Add `TRANSPORTATION_LAYERS` constant array

### Task 2.2: Type Definitions
**File:** `src/types/mapTypes.ts`
- Add `TransportationData` interface
- Add `TransportationDataMap` type

### Task 2.3: Constants
**File:** `src/config/constants.ts`
- Add `COMMUTE_TIMES` to `DATA_PATHS`

### Task 2.4: Data Loading
**File:** `src/composables/useMapData.ts`
- Add `transportationData` ref
- Add `loadTransportationData()` function
- Export from composable

### Task 2.5: Map Component Integration
**File:** `src/components/Map.vue`
- Import transportation layer config
- Add reactive layer state
- Add selection state ref
- Add toggle function
- Add color calculation function
- Update `allSelectedLayers` computed
- Pass props to child components

### Task 2.6: Layer Controls UI
**File:** `src/components/LayerControls.vue`
- Add props for transportation layers
- Add emit for toggle event
- Add UI section with checkboxes

### Task 2.7: Color Legend
**File:** `src/components/ColorLegend.vue`
- Add legend definitions for transportation layers
- Update props and computed properties

### Task 2.8: County Modal (Optional)
**File:** `src/components/CountyModal.vue`
- Display transportation data in detailed popup

---

## Proposed Layers

| Layer ID | Display Name | Metric Type | Color Scheme |
|----------|--------------|-------------|--------------|
| `commute_time` | Most Common Commute Time | Ordinal (1-12) | Green→Yellow→Red |
| `drove_alone` | % Drove Alone (Black Workers) | Percentage | Light→Dark Blue |
| `public_transit` | % Public Transit (Black Workers) | Percentage | Light→Dark Purple |

---

## Success Criteria
- [ ] All 3,144 counties have FIPS codes mapped
- [ ] Transportation layers appear in Layer Controls
- [ ] Choropleth colors render correctly for each layer
- [ ] Color legend displays appropriate gradients
- [ ] Tooltips show correct values on hover
- [ ] County modal displays transportation data
- [ ] No console errors during layer toggling
