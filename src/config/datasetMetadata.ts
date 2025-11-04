/**
 * Dataset Metadata
 * Comprehensive information about all datasets used in the BLO Liveability Index
 */

export interface DatasetMetadata {
  id: string
  name: string
  description: string
  source: string
  sourceUrl?: string
  year: string | number
  methodology?: string
  interpretation?: string
  unit?: string
  range?: { min: number; max: number }
  colorScheme?: string
}

export const datasetMetadata: Record<string, DatasetMetadata> = {
  // BLO Composite Score
  blo_liveability_index: {
    id: 'blo_liveability_index',
    name: 'BLO Liveability Index',
    description: 'Comprehensive county liveability score combining demographics, equity, economics, housing, environment, and health.',
    source: 'Black Land Ownership (BLO)',
    year: 2024,
    methodology: 'Weighted composite score (0-5) combining 11 normalized metrics: diversity index (10%), percent Black (10%), life expectancy (10%), EPA contamination sites (5%), average weekly wage (10%), median income Black (10%), median home value (10%), median property tax (5%), Black homeownership rate (5%), poverty rate Black (10%), and Black Progress Index (15%). Missing data is handled through dynamic weight redistribution.',
    interpretation: 'Higher scores indicate more favorable conditions for Black liveability. Scores range from 1.15 to 3.28 across US counties, with a national average of 2.42.',
    unit: 'score',
    range: { min: 1.15, max: 3.28 },
    colorScheme: 'Yellow (low) to Emerald Green (high)',
  },

  // Demographics
  diversity_index: {
    id: 'diversity_index',
    name: 'Diversity Index',
    description: 'Probability that two randomly selected people are from different racial/ethnic groups.',
    source: 'US Census Bureau',
    sourceUrl: 'https://www.census.gov/topics/population/race/about.html',
    year: 2023,
    methodology: 'Calculated using Simpson\'s Diversity Index based on racial/ethnic composition from American Community Survey 5-year estimates.',
    interpretation: 'Ranges from 0 (completely homogeneous) to 1 (maximum diversity). National average is 0.33.',
    unit: 'index',
    range: { min: 0, max: 1 },
    colorScheme: 'Gradient based on diversity value',
  },

  pct_black: {
    id: 'pct_black',
    name: 'Percent Black Population',
    description: 'Percentage of county residents who identify as Black or African American.',
    source: 'US Census Bureau',
    sourceUrl: 'https://www.census.gov/topics/population/race.html',
    year: 2023,
    methodology: 'American Community Survey 5-year estimates, non-Hispanic Black alone population.',
    interpretation: 'Higher percentages indicate larger Black communities. National average is 9.47%.',
    unit: 'percent',
    range: { min: 0, max: 100 },
    colorScheme: 'Intensity based on percentage',
  },

  total_population: {
    id: 'total_population',
    name: 'Total Population',
    description: 'Total county population from census estimates.',
    source: 'US Census Bureau',
    sourceUrl: 'https://www.census.gov/programs-surveys/popest.html',
    year: 2023,
    unit: 'people',
    interpretation: 'National average county population is approximately 1,058,000.',
  },

  // Health
  life_expectancy: {
    id: 'life_expectancy',
    name: 'Life Expectancy',
    description: 'Average years a person born in this county is expected to live.',
    source: 'Institute for Health Metrics and Evaluation (IHME)',
    sourceUrl: 'https://www.healthdata.org/',
    year: 2014,
    methodology: 'County-level life expectancy calculated using mortality data and population estimates.',
    interpretation: 'Higher values indicate better overall health outcomes. National average is 77.74 years.',
    unit: 'years',
    range: { min: 65, max: 87 },
    colorScheme: 'Intensity based on years',
  },

  // Environment
  epa_contamination: {
    id: 'epa_contamination',
    name: 'EPA Contamination Sites',
    description: 'Total EPA-tracked contamination sites per county (lower is better).',
    source: 'Environmental Protection Agency (EPA)',
    sourceUrl: 'https://www.epa.gov/enviro',
    year: 2024,
    methodology: 'Aggregated count from EPA Envirofacts database across five categories: Superfund (NPL), hazardous waste (RCRA), toxic release inventory (TRI), brownfields, and air pollution sources.',
    interpretation: 'Lower counts indicate cleaner environments with less toxic exposure risk. National average is 8.77 sites per county.',
    unit: 'sites',
    colorScheme: 'Lower is better (inverted)',
  },

  // Economic Indicators
  avg_weekly_wage: {
    id: 'avg_weekly_wage',
    name: 'Average Weekly Wage',
    description: 'Average weekly wages across all industries in the county.',
    source: 'US Bureau of Labor Statistics (BLS)',
    sourceUrl: 'https://www.bls.gov/cew/',
    year: 2023,
    methodology: 'Quarterly Census of Employment and Wages (QCEW) data, averaged across all industries.',
    interpretation: 'Higher wages indicate stronger economic opportunities. National average is $1,070 per week.',
    unit: 'dollars',
    range: { min: 300, max: 3000 },
    colorScheme: 'Red (low/bad) to Green (high/good)',
  },

  median_income_black: {
    id: 'median_income_black',
    name: 'Median Household Income (Black)',
    description: 'Median household income for Black households in the county.',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    methodology: 'American Community Survey 5-year estimates, race-specific median household income for Black alone households.',
    interpretation: 'Higher incomes indicate greater economic prosperity for Black families. Counties with 0 values or unreliable data are marked as unknown. National average is $52,493.',
    unit: 'dollars',
    range: { min: 15000, max: 250000 },
    colorScheme: 'Light cyan to deep royal blue with varying opacity',
  },

  // Housing & Affordability
  median_home_value: {
    id: 'median_home_value',
    name: 'Median Home Value',
    description: 'Median value of owner-occupied homes with mortgages (lower is more affordable).',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    methodology: 'American Community Survey 5-year estimates, median value for owner-occupied units with mortgages.',
    interpretation: 'Lower values indicate more affordable housing markets. National average is $231,974.',
    unit: 'dollars',
    range: { min: 30000, max: 1535200 },
    colorScheme: 'Green (low/affordable) to Red (high/expensive)',
  },

  median_property_tax: {
    id: 'median_property_tax',
    name: 'Median Property Tax',
    description: 'Median annual property tax paid by homeowners (lower is better).',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    methodology: 'American Community Survey 5-year estimates, median real estate taxes for owner-occupied units with mortgages.',
    interpretation: 'Lower taxes indicate more affordable homeownership costs. National average is $2,124.',
    unit: 'dollars',
    range: { min: 200, max: 10000 },
    colorScheme: 'Green (low/affordable) to Red (high/expensive)',
  },

  homeownership_black: {
    id: 'homeownership_black',
    name: 'Black Homeownership Rate',
    description: 'Percentage of Black households that own their homes.',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    methodology: 'American Community Survey 5-year estimates, race-specific homeownership rate for Black alone households. Only includes counties with 50+ Black residents for statistical reliability.',
    interpretation: 'Higher rates indicate greater wealth accumulation opportunities. National average is 50.64%.',
    unit: 'percent',
    range: { min: 0, max: 100 },
    colorScheme: 'Red (low/bad) to Green (high/good)',
  },

  // Racial Equity
  poverty_rate_black: {
    id: 'poverty_rate_black',
    name: 'Poverty Rate (Black)',
    description: 'Percentage of Black individuals living below the federal poverty line.',
    source: 'Urban Institute - Diversity Data Kids',
    sourceUrl: 'https://data.diversitydatakids.org/',
    year: 2022,
    methodology: 'American Community Survey 5-year estimates, race-specific poverty rate for Black alone population.',
    interpretation: 'Lower rates indicate better economic conditions. Counties with 0% are marked as unknown due to data unreliability. National average is 29.44%.',
    unit: 'percent',
    range: { min: 0, max: 100 },
    colorScheme: 'Green (low/good) to Red (high/bad)',
  },

  black_progress_index: {
    id: 'black_progress_index',
    name: 'Black Progress Index',
    description: 'Composite measure of Black wellbeing from NAACP & Brookings combining health, education, and economic indicators.',
    source: 'NAACP & Brookings Institution',
    sourceUrl: 'https://www.brookings.edu/',
    year: 2020,
    methodology: 'Combines 8 indicators: Black life expectancy, low birth weight rate, math proficiency, bachelor\'s degree attainment, homeownership rate, business ownership rate, median household income (log), and Black population percentage.',
    interpretation: 'Higher scores (0-100) indicate better overall outcomes for Black residents. National average is 74.02.',
    unit: 'index',
    range: { min: 0, max: 100 },
    colorScheme: 'Red (low/bad) to Green (high/good)',
  },
}

// BLO Calculation Methodology
export const bloCalculationMethodology = `
## BLO Liveability Index Calculation

The BLO Liveability Index is a comprehensive measure designed to evaluate county-level conditions for Black American liveability. It combines 11 normalized metrics across 6 key dimensions:

### Metric Weights

**Demographics (20%)**
- Diversity Index: 10%
- Percent Black Population: 10%

**Health (10%)**
- Life Expectancy: 10%

**Environment (5%)**
- EPA Contamination Sites: 5%

**Economic Opportunity (20%)**
- Average Weekly Wage: 10%
- Median Household Income (Black): 10%

**Housing Affordability (20%)**
- Median Home Value: 10%
- Median Property Tax: 5%
- Black Homeownership Rate: 5%

**Racial Equity (15%)**
- Poverty Rate (Black): 10%
- Black Progress Index: 15%

### Normalization Process

1. Each metric is normalized to a 0-1 scale using min-max normalization
2. Inverted metrics (contamination, home value, property tax, poverty) are reversed so higher normalized values = better conditions
3. Missing data is handled through dynamic weight redistribution - available metrics are weighted proportionally to maintain the 0-5 scale

### Final Score Calculation

The weighted sum of normalized metrics is scaled to a 0-5 range:

\`\`\`
BLO Score = (Σ(normalized_metric × weight) / total_available_weight) × 5
\`\`\`

### Score Interpretation

- **Range**: 1.15 - 3.28 (actual county scores)
- **National Average**: 2.39
- **Higher is Better**: Higher scores indicate more favorable conditions across all measured dimensions

### Data Quality

All 3,144 US counties receive scores through weighted averaging. Counties with missing data for specific metrics have those weights redistributed among available metrics, ensuring comprehensive coverage while maintaining scoring integrity.
`

export function getDatasetById(id: string): DatasetMetadata | undefined {
  return datasetMetadata[id]
}

export function getAllDatasets(): DatasetMetadata[] {
  return Object.values(datasetMetadata)
}
