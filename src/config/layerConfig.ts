import { datasetMetadata } from './datasetMetadata'

export interface DemographicLayer {
  id: string
  name: string
  file?: string
  color?: string
  visible: boolean
  tooltip?: string
  category?: string
}

export interface ContaminationLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
  tooltip?: string
}

export interface EconomicLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
  tooltip?: string
}

export interface HousingLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
  tooltip?: string
}

export interface EquityLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
  tooltip?: string
}

export const DEMOGRAPHIC_LAYERS: DemographicLayer[] = [
  {
    id: 'combined_scores_v2',
    name: 'BLO Liveability Index',
    visible: true,
    tooltip: datasetMetadata.blo_liveability_index?.description || 'Comprehensive liveability score combining 11 metrics across demographics, equity, economics, housing, environment, and health',
    category: '', // No category - appears at top
  },
  {
    id: 'diversity_index',
    name: 'Diversity Index',
    file: '/datasets/demographics/county_diversity_index_with_stats.csv',
    color: '#800080', // Purple color for diversity
    visible: false,
    tooltip: datasetMetadata.diversity_index?.description || 'Probability that two randomly selected people are from different racial/ethnic groups',
    category: 'Demographics',
  },
  {
    id: 'pct_Black',
    name: 'Percent Black',
    file: '/datasets/demographics/county_diversity_index_with_stats.csv',
    color: '#8B4513', // Brown color
    visible: false,
    tooltip: datasetMetadata.pct_black?.description || 'Percentage of county residents who identify as Black or African American',
    category: 'Demographics',
  },
  {
    id: 'life_expectancy',
    name: 'Life Expectancy',
    visible: false,
    tooltip: datasetMetadata.life_expectancy?.description || 'Average years a person born in this county is expected to live',
    category: 'Health',
  },
]

export const CONTAMINATION_LAYERS: ContaminationLayer[] = [
  {
    id: 'acres_brownfields',
    name: 'Brownfields',
    file: '/datasets/epa-contamination/acres_brownfields.geojson',
    color: '#FF0000',
    visible: false,
    tooltip: 'Properties with potential hazardous substances complicating development.',
  },
  {
    id: 'air_pollution_sources',
    name: 'Air Pollution Sources',
    file: '/datasets/epa-contamination/air_pollution_sources.geojson',
    color: '#00FF00',
    visible: false,
    tooltip: 'Facilities that emit air pollutants tracked by EPA.',
  },
  {
    id: 'hazardous_waste_sites',
    name: 'Hazardous Waste Sites',
    file: '/datasets/epa-contamination/hazardous_waste_sites.geojson',
    color: '#0000FF',
    visible: false,
    tooltip: 'RCRA-regulated facilities managing hazardous waste.',
  },
  {
    id: 'superfund_sites',
    name: 'Superfund Sites',
    file: '/datasets/epa-contamination/superfund_sites.geojson',
    color: '#FFFF00',
    visible: false,
    tooltip: 'National Priorities List sites requiring long-term hazardous cleanup.',
  },
  {
    id: 'toxic_release_inventory',
    name: 'Toxic Release Inventory',
    file: '/datasets/epa-contamination/toxic_release_inventory.geojson',
    color: '#FF00FF',
    visible: false,
    tooltip: 'Facilities reporting annual toxic chemical releases.',
  },
]

export const ECONOMIC_LAYERS: EconomicLayer[] = [
  {
    id: 'avg_weekly_wage',
    name: 'Average Weekly Wage',
    file: '/datasets/economic/avg_weekly_wages.csv',
    color: '#2E8B57', // Sea green
    visible: false,
    tooltip: datasetMetadata.avg_weekly_wage?.description || 'Average weekly wages across all industries in the county',
  },
  {
    id: 'median_income_by_race',
    name: 'Median Income (Black)',
    file: '/datasets/economic/median_income_by_race.csv',
    color: '#20B2AA', // Light sea green
    visible: false,
    tooltip: datasetMetadata.median_income_black?.description || 'Median household income for Black households',
  },
]

export const HOUSING_LAYERS: HousingLayer[] = [
  {
    id: 'median_home_value',
    name: 'Median Home Value',
    file: '/datasets/housing/median_home_value.csv',
    color: '#FF6347', // Tomato
    visible: false,
    tooltip: datasetMetadata.median_home_value?.description || 'Median value of owner-occupied housing units with mortgages',
  },
  {
    id: 'median_property_tax',
    name: 'Median Property Tax',
    file: '/datasets/housing/median_property_tax.csv',
    color: '#FF4500', // Orange red
    visible: false,
    tooltip: datasetMetadata.median_property_tax?.description || 'Median annual property tax paid by homeowners',
  },
  {
    id: 'homeownership_by_race',
    name: 'Black Homeownership Rate',
    file: '/datasets/equity/homeownership_by_race.csv',
    color: '#FFA500', // Orange
    visible: false,
    tooltip: datasetMetadata.homeownership_black?.description || 'Percentage of Black households that own their homes',
  },
]

export const EQUITY_LAYERS: EquityLayer[] = [
  {
    id: 'poverty_by_race',
    name: 'Poverty Rate (Black)',
    file: '/datasets/equity/poverty_by_race.csv',
    color: '#9370DB', // Medium purple
    visible: false,
    tooltip: datasetMetadata.poverty_rate_black?.description || 'Percentage of Black individuals living below the federal poverty line',
  },
  {
    id: 'black_progress_index',
    name: 'Black Progress Index',
    file: '/datasets/equity/black_progress_index.csv',
    color: '#8A2BE2', // Blue violet
    visible: false,
    tooltip: datasetMetadata.black_progress_index?.description || 'Composite measure of Black wellbeing from NAACP & Brookings',
  },
]
