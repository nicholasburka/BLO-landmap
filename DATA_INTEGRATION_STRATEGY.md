# BLO Liveability Index v2.0 - Data Integration Strategy

## Overview

This document outlines the strategy for integrating new economic, housing, and social vulnerability data into the BLO (Black Liveability Observatory) Liveability Index. The enhanced index will provide a more comprehensive assessment of county liveability for Black Americans.

---

## New Data Sources

### 1. Economic Data: Average Weekly Wages
**Location**: `source-data/AVG WEEKLY WAGES/explore_data_emp_09/emp_09.csv`

**Key Fields**:
- `geo_id`: County identifier (format: `0500000US{FIPS}`)
- `state_fips`: State FIPS code
- `county_fips`: County FIPS code
- `avg_wkly_wage`: Average weekly wage (dollars)
- `year`: Data year (2025)
- `qtr`: Quarter (1)

**Metric**: Economic opportunity indicator
**Weight in Index**: 15%
**Normalization**: Higher wages = higher score

### 2. Housing Affordability: Median Home Value
**Location**: `source-data/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/explore_data_hom_06.zip` (needs extraction)

**Expected Fields**:
- County identifier
- Median home value
- Year

**Metric**: Housing accessibility indicator
**Weight in Index**: 10%
**Normalization**: Lower values = higher score (more affordable)

### 3. Housing Affordability: Median Real Estate Taxes
**Location**: `source-data/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/explore_data_hom_08.zip` (needs extraction)

**Expected Fields**:
- County identifier
- Median annual property tax
- Year

**Metric**: Housing cost burden indicator
**Weight in Index**: 10%
**Normalization**: Lower taxes = higher score

### 4. Racial Progress: Multiple Datasets
**Location**: `source-data/RACIAL PROGRESS/`

#### a) Median Income by Race/Ethnicity
**File**: `Median Income by Race_Ethnicity/explore_data_emp_08/emp_08.csv`

**Key Fields**:
- `geo_name`: County name
- `median_income`: Overall median income
- `median_income_black_alone`: Median income for Black residents
- `median_income_white_alone`: Median income for White residents

**Metrics**:
- Income equity gap (Black vs White income ratio)
- Overall income level

**Weight in Index**: 10%

#### b) Homeownership Rate by Race/Ethnicity
**Location**: `Homeownership Rate by Race_Ehtnicity/`

**Metric**: Housing equity indicator
**Weight in Index**: 5%

#### c) Debt to Income Ratio
**Location**: `Debt to Income Ratio for Households/`

**Metric**: Financial stability indicator
**Weight in Index**: 5%

#### d) Poverty Rate by Race/Ethnicity
**Location**: `Percent Poverty (by Race_Ethnicity)/`

**Metric**: Economic hardship indicator
**Weight in Index**: 5%

#### e) Racial Equity Index
**Location**: `Racial Equity Index (National Equity Index)/`

**Metric**: Comprehensive equity measure
**Weight in Index**: 5%

#### f) Black Progress Index
**Location**: `The Black Progress Index (NAACPxBrookings)/`

**Metric**: Multi-dimensional progress measure
**Weight in Index**: 5%

### 5. Social Vulnerability Index (SVI)
**Location**: `source-data/SVI2022_US_county.gdb/` (Esri Geodatabase)

**Data Type**: Comprehensive social vulnerability indicators from CDC
**Format**: Requires conversion from .gdb to CSV/JSON

**Expected Metrics**:
- Socioeconomic vulnerability
- Household composition & disability
- Minority status & language
- Housing type & transportation

**Weight in Index**: 10%

---

## Enhanced BLO Liveability Index Formula

### Current Index Components (50% weight)
1. **Diversity Index** (10%) - Existing
2. **Percent Black Population** (10%) - Existing
3. **Life Expectancy** (15%) - Existing
4. **EPA Land Toxicity** (15%) - Existing (inverted - lower is better)

### New Index Components (50% weight)

#### Economic Opportunity (25%)
- Average Weekly Wages (15%)
- Median Income (Black) (10%)

#### Housing Affordability (20%)
- Median Home Value (10%) - inverted
- Median Property Taxes (10%) - inverted

#### Social & Racial Equity (15%)
- Homeownership Rate (Black) (5%)
- Income Equity Gap (Black/White ratio) (5%)
- Racial Equity Index (5%)

#### Vulnerability & Hardship (10%)
- Social Vulnerability Index (5%)
- Poverty Rate (Black) (5%)

### Formula Structure

```
BLO Score v2.0 = (
  // Demographics (10%)
  (diversityIndex * 0.10) +

  // Population (10%)
  (pctBlack_normalized * 0.10) +

  // Health (15%)
  (lifeExpectancy_normalized * 0.15) +

  // Environment (15%)
  ((1 - contamination_normalized) * 0.15) +

  // Economic (25%)
  (avgWeeklyWage_normalized * 0.15) +
  (medianIncome_black_normalized * 0.10) +

  // Housing (20%)
  ((1 - medianHomeValue_normalized) * 0.10) +
  ((1 - medianPropertyTax_normalized) * 0.10) +

  // Equity (15%)
  (homeownershipRate_black_normalized * 0.05) +
  (incomeEquityGap_normalized * 0.05) +
  (racialEquityIndex_normalized * 0.05) +

  // Vulnerability (10%)
  ((1 - socialVulnerabilityIndex_normalized) * 0.05) +
  ((1 - povertyRate_black_normalized) * 0.05)
) * 5.0
```

**Output**: Score from 0-5, where 5 is the highest liveability

---

## Implementation Strategy

### Phase 1: Data Extraction & Preprocessing (Week 1)

#### Step 1.1: Extract Zipped Files
```bash
# Create preprocessing script
scripts/preprocess/extract_datasets.sh

# Extract housing data
unzip "source-data/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/explore_data_hom_06.zip" -d "source-data/MEDIAN VALUE of OWNER OCCUPIED MORTGAGES/"
unzip "source-data/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/explore_data_hom_08.zip" -d "source-data/MEDIAN REAL ESTATE TAXES OF OWNER - OCCUPIED MORTGAGES/"

# Extract racial progress datasets (check each folder)
# Extract SVI geodatabase
```

#### Step 1.2: Convert SVI Geodatabase
```python
# scripts/preprocess/convert_svi_gdb.py
# Use ogr2ogr or GeoPandas to convert .gdb to CSV

import geopandas as gpd

gdb_path = "source-data/SVI2022_US_county.gdb"
output_path = "public/datasets/social-vulnerability/svi_2022_county.csv"

# Read geodatabase
gdf = gpd.read_file(gdb_path, layer="SVI2022_US_county")

# Convert to CSV (drop geometry)
df = gdf.drop(columns=['geometry'])
df.to_csv(output_path, index=False)
```

#### Step 1.3: Standardize Data Format
```javascript
// scripts/preprocess/standardize_datasets.cjs

// Convert all datasets to standard format:
// {
//   GEOID: "01001",
//   county_name: "Autauga County",
//   state_name: "Alabama",
//   metric_name: value,
//   year: 2023
// }
```

### Phase 2: Add to Layer Configuration (Week 1)

#### Update `src/config/layerConfig.ts`

```typescript
export const DEMOGRAPHIC_LAYERS: DemographicLayer[] = [
  // Existing layers...
  {
    id: 'diversity_index',
    name: 'Diversity Index',
    // ...
  },

  // NEW ECONOMIC LAYERS
  {
    id: 'avg_weekly_wage',
    name: 'Average Weekly Wage',
    file: '/datasets/economic/avg_weekly_wages.csv',
    color: '#2E8B57', // Sea green
    visible: false,
    tooltip: 'Average weekly wage (2025 Q1)',
  },
  {
    id: 'median_income_black',
    name: 'Median Income (Black)',
    file: '/datasets/economic/median_income_by_race.csv',
    color: '#20B2AA', // Light sea green
    visible: false,
    tooltip: 'Median household income for Black residents',
  },

  // NEW HOUSING LAYERS
  {
    id: 'median_home_value',
    name: 'Median Home Value',
    file: '/datasets/housing/median_home_value.csv',
    color: '#FF8C00', // Dark orange
    visible: false,
    tooltip: 'Median value of owner-occupied homes',
  },
  {
    id: 'median_property_tax',
    name: 'Median Property Tax',
    file: '/datasets/housing/median_property_tax.csv',
    color: '#FF6347', // Tomato
    visible: false,
    tooltip: 'Median annual property tax',
  },

  // NEW EQUITY LAYERS
  {
    id: 'homeownership_rate_black',
    name: 'Homeownership Rate (Black)',
    file: '/datasets/equity/homeownership_by_race.csv',
    color: '#9370DB', // Medium purple
    visible: false,
    tooltip: 'Homeownership rate for Black households',
  },
  {
    id: 'income_equity_gap',
    name: 'Income Equity Gap',
    file: '/datasets/equity/income_equity_gap.csv',
    color: '#BA55D3', // Medium orchid
    visible: false,
    tooltip: 'Ratio of Black to White median income',
  },
  {
    id: 'racial_equity_index',
    name: 'Racial Equity Index',
    file: '/datasets/equity/racial_equity_index.csv',
    color: '#8B008B', // Dark magenta
    visible: false,
    tooltip: 'Comprehensive racial equity measure',
  },

  // NEW VULNERABILITY LAYERS
  {
    id: 'social_vulnerability',
    name: 'Social Vulnerability Index',
    file: '/datasets/social-vulnerability/svi_2022_county.csv',
    color: '#DC143C', // Crimson
    visible: false,
    tooltip: 'CDC Social Vulnerability Index (2022)',
  },
  {
    id: 'poverty_rate_black',
    name: 'Poverty Rate (Black)',
    file: '/datasets/equity/poverty_by_race.csv',
    color: '#B22222', // Firebrick
    visible: false,
    tooltip: 'Poverty rate for Black residents',
  },
]
```

### Phase 3: Data Loading (Week 2)

#### Update `src/composables/useMapData.ts`

```typescript
// Add new data loading functions
export function useMapData() {
  // Existing state...
  const economicData = ref<Record<string, EconomicData>>({})
  const housingData = ref<Record<string, HousingData>>({})
  const equityData = ref<Record<string, EquityData>>({})
  const vulnerabilityData = ref<Record<string, VulnerabilityData>>({})

  // New loading functions
  const loadEconomicData = async () => {
    const wageResponse = await fetch('/datasets/economic/avg_weekly_wages.csv')
    const wageText = await wageResponse.text()
    const wageData = parseCSV(wageText)

    const incomeResponse = await fetch('/datasets/economic/median_income_by_race.csv')
    const incomeText = await incomeResponse.text()
    const incomeData = parseCSV(incomeText)

    // Merge and store
    wageData.forEach(row => {
      const fips = extractFIPS(row.geo_id)
      economicData.value[fips] = {
        avgWeeklyWage: parseFloat(row.avg_wkly_wage),
        medianIncomeBlack: incomeData.find(i => extractFIPS(i.geo_name) === fips)?.median_income_black_alone
      }
    })
  }

  const loadHousingData = async () => {
    // Similar pattern for housing data
  }

  const loadEquityData = async () => {
    // Similar pattern for equity data
  }

  const loadVulnerabilityData = async () => {
    // Load SVI data
  }

  return {
    // Existing exports...
    economicData,
    housingData,
    equityData,
    vulnerabilityData,
    loadEconomicData,
    loadHousingData,
    loadEquityData,
    loadVulnerabilityData,
  }
}
```

#### Update Type Definitions in `src/types/mapTypes.ts`

```typescript
export interface EconomicData {
  avgWeeklyWage: number
  medianIncomeBlack?: number
}

export interface HousingData {
  medianHomeValue: number
  medianPropertyTax: number
}

export interface EquityData {
  homeownershipRateBlack: number
  incomeEquityGap: number  // Black/White income ratio
  racialEquityIndex: number
  povertyRateBlack: number
}

export interface VulnerabilityData {
  svi_overall: number
  svi_socioeconomic: number
  svi_household: number
  svi_minority: number
  svi_housing: number
}
```

### Phase 4: Scoring Engine (Week 2)

#### Create `scripts/calculate_blo_v2_scores.cjs`

```javascript
// Calculate enhanced BLO scores
const fs = require('fs')
const d3 = require('d3')

// Load all datasets
const economicData = loadCSV('./public/datasets/economic/avg_weekly_wages.csv')
const housingValueData = loadCSV('./public/datasets/housing/median_home_value.csv')
const housingTaxData = loadCSV('./public/datasets/housing/median_property_tax.csv')
const equityData = loadCSV('./public/datasets/equity/combined_equity_metrics.csv')
const vulnerabilityData = loadCSV('./public/datasets/social-vulnerability/svi_2022_county.csv')
const existingScores = loadJSON('./public/datasets/BLO-liveability-index/combined_scores.json')

// Normalize function
function normalize(value, min, max, invert = false) {
  const normalized = (value - min) / (max - min)
  return invert ? 1 - normalized : normalized
}

// Calculate v2.0 scores
const scores = {}

counties.forEach(county => {
  const fips = county.GEOID

  // Get existing metrics
  const existing = existingScores[fips] || {}
  const diversity = existing.diversityIndex || 0
  const pctBlack = existing.pctBlack || 0
  const lifeExpectancy = existing.lifeExpectancy || 0
  const contamination = existing.contamination || 0

  // Get new metrics
  const economic = economicData[fips] || {}
  const housing = housingData[fips] || {}
  const equity = equityData[fips] || {}
  const vulnerability = vulnerabilityData[fips] || {}

  // Normalize all metrics
  const normalized = {
    diversity: diversity, // Already 0-1
    pctBlack: normalize(pctBlack, 0, 100),
    lifeExpectancy: normalize(lifeExpectancy, 65, 85),
    contamination: normalize(contamination, 0, maxContamination),
    avgWeeklyWage: normalize(economic.avgWeeklyWage || 0, 400, 1500),
    medianIncomeBlack: normalize(economic.medianIncomeBlack || 0, 20000, 100000),
    medianHomeValue: normalize(housing.medianHomeValue || 0, 50000, 500000),
    medianPropertyTax: normalize(housing.medianPropertyTax || 0, 500, 10000),
    homeownershipRateBlack: normalize(equity.homeownershipRateBlack || 0, 0, 100),
    incomeEquityGap: normalize(equity.incomeEquityGap || 0, 0, 1),
    racialEquityIndex: normalize(equity.racialEquityIndex || 0, 0, 100),
    svi: normalize(vulnerability.svi_overall || 0, 0, 1),
    povertyRateBlack: normalize(equity.povertyRateBlack || 0, 0, 50),
  }

  // Calculate composite score
  const score = (
    (normalized.diversity * 0.10) +
    (normalized.pctBlack * 0.10) +
    (normalized.lifeExpectancy * 0.15) +
    ((1 - normalized.contamination) * 0.15) +
    (normalized.avgWeeklyWage * 0.15) +
    (normalized.medianIncomeBlack * 0.10) +
    ((1 - normalized.medianHomeValue) * 0.10) +
    ((1 - normalized.medianPropertyTax) * 0.10) +
    (normalized.homeownershipRateBlack * 0.05) +
    (normalized.incomeEquityGap * 0.05) +
    (normalized.racialEquityIndex * 0.05) +
    ((1 - normalized.svi) * 0.05) +
    ((1 - normalized.povertyRateBlack) * 0.05)
  ) * 5.0

  scores[fips] = {
    combinedScore: score,
    components: {
      demographics: normalized.diversity * 0.10 + normalized.pctBlack * 0.10,
      health: normalized.lifeExpectancy * 0.15,
      environment: (1 - normalized.contamination) * 0.15,
      economic: normalized.avgWeeklyWage * 0.15 + normalized.medianIncomeBlack * 0.10,
      housing: (1 - normalized.medianHomeValue) * 0.10 + (1 - normalized.medianPropertyTax) * 0.10,
      equity: normalized.homeownershipRateBlack * 0.05 + normalized.incomeEquityGap * 0.05 + normalized.racialEquityIndex * 0.05,
      vulnerability: (1 - normalized.svi) * 0.05 + (1 - normalized.povertyRateBlack) * 0.05,
    }
  }
})

// Rank scores
const ranked = Object.entries(scores)
  .sort((a, b) => b[1].combinedScore - a[1].combinedScore)
  .forEach((entry, index) => {
    entry[1].rank = index + 1
  })

// Save
fs.writeFileSync(
  './public/datasets/BLO-liveability-index/combined_scores_v2.json',
  JSON.stringify(scores, null, 2)
)
```

### Phase 5: UI Updates (Week 3)

#### Update LayerControls Categories

```vue
<!-- src/components/LayerControls.vue -->
<template>
  <div id="layer-control">
    <h3>Demographic Layers</h3>
    <!-- Existing layers -->

    <h3>Economic Layers</h3>
    <div class="layer-item">
      <input type="checkbox" id="avg_weekly_wage" />
      <label for="avg_weekly_wage">Average Weekly Wage</label>
    </div>
    <div class="layer-item">
      <input type="checkbox" id="median_income_black" />
      <label for="median_income_black">Median Income (Black)</label>
    </div>

    <h3>Housing Layers</h3>
    <div class="layer-item">
      <input type="checkbox" id="median_home_value" />
      <label for="median_home_value">Median Home Value</label>
    </div>
    <div class="layer-item">
      <input type="checkbox" id="median_property_tax" />
      <label for="median_property_tax">Median Property Tax</label>
    </div>

    <h3>Equity & Progress Layers</h3>
    <!-- New equity layers -->

    <h3>Vulnerability Layers</h3>
    <!-- SVI and poverty layers -->

    <h3>EPA - Sites of Land Toxicity</h3>
    <!-- Existing contamination layers -->
  </div>
</template>
```

#### Update CountyModal Display

```vue
<!-- src/components/CountyModal.vue -->
<table v-if="hasData" class="county-stats-table">
  <tr>
    <td class="label">BLO Liveability Score v2.0:</td>
    <td class="value">{{ formatCombinedScore }}</td>
  </tr>
  <tr>
    <td class="label">Rank:</td>
    <td class="value">{{ formatRank }}</td>
  </tr>

  <!-- Score Breakdown -->
  <tr class="section-header">
    <td colspan="2">Score Breakdown</td>
  </tr>
  <tr>
    <td class="label sub-label">Demographics:</td>
    <td class="value">{{ formatComponent('demographics') }}</td>
  </tr>
  <tr>
    <td class="label sub-label">Economic Opportunity:</td>
    <td class="value">{{ formatComponent('economic') }}</td>
  </tr>
  <tr>
    <td class="label sub-label">Housing Affordability:</td>
    <td class="value">{{ formatComponent('housing') }}</td>
  </tr>
  <tr>
    <td class="label sub-label">Racial Equity:</td>
    <td class="value">{{ formatComponent('equity') }}</td>
  </tr>

  <!-- Existing metrics -->
  <tr class="section-header">
    <td colspan="2">Demographics</td>
  </tr>
  <tr>
    <td class="label">Total Population:</td>
    <td class="value">{{ formatPopulation }}</td>
  </tr>
  <!-- ... -->

  <!-- New metrics -->
  <tr class="section-header">
    <td colspan="2">Economic Indicators</td>
  </tr>
  <tr>
    <td class="label">Avg Weekly Wage:</td>
    <td class="value">{{ formatEconomic('avgWeeklyWage') }}</td>
  </tr>
  <tr>
    <td class="label">Median Income (Black):</td>
    <td class="value">{{ formatEconomic('medianIncomeBlack') }}</td>
  </tr>

  <tr class="section-header">
    <td colspan="2">Housing Affordability</td>
  </tr>
  <tr>
    <td class="label">Median Home Value:</td>
    <td class="value">{{ formatHousing('medianHomeValue') }}</td>
  </tr>
  <tr>
    <td class="label">Median Property Tax:</td>
    <td class="value">{{ formatHousing('medianPropertyTax') }}</td>
  </tr>
</table>
```

### Phase 6: Testing & Validation (Week 3)

1. **Data Validation**:
   - Verify all county FIPS codes match
   - Check for missing data
   - Validate score ranges (0-5)
   - Ensure rankings are correct

2. **UI Testing**:
   - Test all new layer toggles
   - Verify color blending
   - Check mobile responsiveness
   - Test accessibility

3. **Score Validation**:
   - Compare v1.0 vs v2.0 scores
   - Identify significant changes
   - Validate against known good/bad counties
   - Get user feedback

---

## File Organization

```
public/datasets/
├── demographics/
│   ├── county_pctBlack_diversity_index_with_stats.csv (existing)
│   └── lifeexpectancy-USA-county.csv (existing)
├── epa-contamination/
│   └── contamination_counts.json (existing)
├── economic/
│   ├── avg_weekly_wages.csv (NEW)
│   ├── median_income_by_race.csv (NEW)
│   └── debt_to_income.csv (NEW)
├── housing/
│   ├── median_home_value.csv (NEW)
│   ├── median_property_tax.csv (NEW)
│   └── homeownership_by_race.csv (NEW)
├── equity/
│   ├── income_equity_gap.csv (NEW)
│   ├── poverty_by_race.csv (NEW)
│   ├── racial_equity_index.csv (NEW)
│   └── black_progress_index.csv (NEW)
├── social-vulnerability/
│   └── svi_2022_county.csv (NEW - converted from .gdb)
└── BLO-liveability-index/
    ├── combined_scores.json (existing v1.0)
    └── combined_scores_v2.json (NEW v2.0)

scripts/
├── preprocess/
│   ├── extract_datasets.sh (NEW)
│   ├── convert_svi_gdb.py (NEW)
│   └── standardize_datasets.cjs (NEW)
├── calculate_blo_v2_scores.cjs (NEW)
└── validate_scores.cjs (NEW)
```

---

## Timeline

- **Week 1**: Data extraction, conversion, preprocessing
- **Week 2**: Data loading, scoring engine implementation
- **Week 3**: UI updates, testing, validation
- **Week 4**: Documentation, deployment, user feedback

---

## Migration Strategy

### Backward Compatibility

The v2.0 index will coexist with v1.0:
- Keep `combined_scores.json` (v1.0)
- Add `combined_scores_v2.json` (v2.0)
- Add feature toggle in UI to switch between versions
- Allow users to compare scores

### Gradual Rollout

1. Deploy v2.0 as beta feature
2. Collect user feedback for 2 weeks
3. Adjust weights if needed
4. Make v2.0 the default
5. Keep v1.0 available as "Classic View"

---

## Future Enhancements

1. **Time Series**: Track score changes over time
2. **Predictions**: Use ML to forecast future scores
3. **Custom Weights**: Allow users to adjust component weights
4. **Export Reports**: Generate PDF reports for counties
5. **Comparison Tool**: Compare multiple counties side-by-side
6. **Mobile App**: Native mobile experience
7. **API**: Expose scores via REST API for third-party use

---

## Questions to Resolve

1. Should we invert median home value (higher = worse) or keep as-is?
2. What's the best way to handle missing data in new datasets?
3. Should income equity gap be Black/White ratio or absolute difference?
4. Which SVI component score to use (overall, or specific themes)?
5. Should we weight recent data more heavily than older data?
6. How to handle counties with zero Black population?

---

## Contact

For questions about this strategy, contact the BLO development team.

**Last Updated**: November 4, 2024
**Version**: 1.0
**Author**: Claude Code Assistant
