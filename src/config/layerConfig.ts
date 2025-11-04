export interface DemographicLayer {
  id: string
  name: string
  file?: string
  color?: string
  visible: boolean
  tooltip?: string
}

export interface ContaminationLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
}

export const DEMOGRAPHIC_LAYERS: DemographicLayer[] = [
  {
    id: 'diversity_index',
    name: 'Diversity Index',
    file: '/datasets/demographics/county_diversity_index_with_stats.csv',
    color: '#800080', // Purple color for diversity
    visible: false,
    tooltip: '2023 Census => Simpson\'s Diversity Index',
  },
  {
    id: 'pct_Black',
    name: 'Percent Black',
    file: '/datasets/demographics/county_diversity_index_with_stats.csv',
    color: '#8B4513', // Brown color
    visible: false,
    tooltip: '2023 Census',
  },
  {
    id: 'life_expectancy',
    name: 'Life Expectancy',
    visible: false,
    tooltip: '2014, Center for Disease Control',
  },
  {
    id: 'combined_scores',
    name: 'BLO Combined Score',
    visible: false,
  },
]

export const CONTAMINATION_LAYERS: ContaminationLayer[] = [
  {
    id: 'acres_brownfields',
    name: 'Brownfields',
    file: '/datasets/epa-contamination/acres_brownfields.geojson',
    color: '#FF0000',
    visible: false,
  },
  {
    id: 'air_pollution_sources',
    name: 'Air Pollution Sources',
    file: '/datasets/epa-contamination/air_pollution_sources.geojson',
    color: '#00FF00',
    visible: false,
  },
  {
    id: 'hazardous_waste_sites',
    name: 'Hazardous Waste Sites',
    file: '/datasets/epa-contamination/hazardous_waste_sites.geojson',
    color: '#0000FF',
    visible: false,
  },
  {
    id: 'superfund_sites',
    name: 'Superfund Sites',
    file: '/datasets/epa-contamination/superfund_sites.geojson',
    color: '#FFFF00',
    visible: false,
  },
  {
    id: 'toxic_release_inventory',
    name: 'Toxic Release Inventory',
    file: '/datasets/epa-contamination/toxic_release_inventory.geojson',
    color: '#FF00FF',
    visible: false,
  },
]
