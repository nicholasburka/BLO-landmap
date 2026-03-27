import { LAYER_REGISTRY, getLayer } from './layerRegistry'

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

export interface TransportationLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
  tooltip?: string
}

/** Helper: build tooltip from registry description + source */
function tip(id: string): string {
  const r = LAYER_REGISTRY[id]
  if (!r) return ''
  return `${r.description} (${r.source})`
}

export const DEMOGRAPHIC_LAYERS: DemographicLayer[] = [
  {
    id: 'combined_scores_v2',
    name: getLayer('combined_scores_v2').name,
    visible: true,
    tooltip: tip('combined_scores_v2'),
    category: '',
  },
  {
    id: 'diversity_index',
    name: getLayer('diversity_index').name,
    file: getLayer('diversity_index').dataPath,
    color: getLayer('diversity_index').color,
    visible: false,
    tooltip: tip('diversity_index'),
    category: 'Demographics',
  },
  {
    id: 'pct_Black',
    name: getLayer('pct_Black').name,
    file: getLayer('pct_Black').dataPath,
    color: getLayer('pct_Black').color,
    visible: false,
    tooltip: tip('pct_Black'),
    category: 'Demographics',
  },
  {
    id: 'life_expectancy',
    name: getLayer('life_expectancy').name,
    visible: false,
    tooltip: tip('life_expectancy'),
    category: 'Health',
  },
]

// Contamination layers are point/polygon overlays, not in the registry
export const CONTAMINATION_LAYERS: ContaminationLayer[] = [
  {
    id: 'acres_brownfields',
    name: 'Brownfields',
    file: '/datasets/epa-contamination/acres_brownfields.geojson',
    color: '#FF0000',
    visible: false,
    tooltip: 'Properties with potential hazardous substances complicating development. (EPA)',
  },
  {
    id: 'air_pollution_sources',
    name: 'Air Pollution Sources',
    file: '/datasets/epa-contamination/air_pollution_sources.geojson',
    color: '#00FF00',
    visible: false,
    tooltip: 'Facilities that emit air pollutants tracked by EPA. (EPA)',
  },
  {
    id: 'hazardous_waste_sites',
    name: 'Hazardous Waste Sites',
    file: '/datasets/epa-contamination/hazardous_waste_sites.geojson',
    color: '#0000FF',
    visible: false,
    tooltip: 'RCRA-regulated facilities managing hazardous waste. (EPA)',
  },
  {
    id: 'superfund_sites',
    name: 'Superfund Sites',
    file: '/datasets/epa-contamination/superfund_sites.geojson',
    color: '#FFFF00',
    visible: false,
    tooltip: 'National Priorities List sites requiring long-term hazardous cleanup. (EPA)',
  },
  {
    id: 'toxic_release_inventory',
    name: 'Toxic Release Inventory',
    file: '/datasets/epa-contamination/toxic_release_inventory.geojson',
    color: '#FF00FF',
    visible: false,
    tooltip: 'Facilities reporting annual toxic chemical releases. (EPA)',
  },
]

export const ECONOMIC_LAYERS: EconomicLayer[] = [
  {
    id: 'avg_weekly_wage',
    name: getLayer('avg_weekly_wage').name,
    file: getLayer('avg_weekly_wage').dataPath,
    color: getLayer('avg_weekly_wage').color!,
    visible: false,
    tooltip: tip('avg_weekly_wage'),
  },
  {
    id: 'median_income_by_race',
    name: getLayer('median_income_by_race').name,
    file: getLayer('median_income_by_race').dataPath,
    color: getLayer('median_income_by_race').color!,
    visible: false,
    tooltip: tip('median_income_by_race'),
  },
]

export const HOUSING_LAYERS: HousingLayer[] = [
  {
    id: 'median_home_value',
    name: getLayer('median_home_value').name,
    file: getLayer('median_home_value').dataPath,
    color: getLayer('median_home_value').color!,
    visible: false,
    tooltip: tip('median_home_value'),
  },
  {
    id: 'median_property_tax',
    name: getLayer('median_property_tax').name,
    file: getLayer('median_property_tax').dataPath,
    color: getLayer('median_property_tax').color!,
    visible: false,
    tooltip: tip('median_property_tax'),
  },
  {
    id: 'homeownership_by_race',
    name: getLayer('homeownership_by_race').name,
    file: getLayer('homeownership_by_race').dataPath,
    color: getLayer('homeownership_by_race').color!,
    visible: false,
    tooltip: tip('homeownership_by_race'),
  },
]

export const EQUITY_LAYERS: EquityLayer[] = [
  {
    id: 'poverty_by_race',
    name: getLayer('poverty_by_race').name,
    file: getLayer('poverty_by_race').dataPath,
    color: getLayer('poverty_by_race').color!,
    visible: false,
    tooltip: tip('poverty_by_race'),
  },
  {
    id: 'black_progress_index',
    name: getLayer('black_progress_index').name,
    file: getLayer('black_progress_index').dataPath,
    color: getLayer('black_progress_index').color!,
    visible: false,
    tooltip: tip('black_progress_index'),
  },
]

export const TRANSPORTATION_LAYERS: TransportationLayer[] = [
  {
    id: 'commute_time',
    name: getLayer('commute_time').name,
    file: getLayer('commute_time').dataPath,
    color: getLayer('commute_time').color!,
    visible: false,
    tooltip: tip('commute_time'),
  },
  {
    id: 'drove_alone',
    name: getLayer('drove_alone').name,
    file: getLayer('drove_alone').dataPath,
    color: getLayer('drove_alone').color!,
    visible: false,
    tooltip: tip('drove_alone'),
  },
  {
    id: 'public_transit',
    name: getLayer('public_transit').name,
    file: getLayer('public_transit').dataPath,
    color: getLayer('public_transit').color!,
    visible: false,
    tooltip: tip('public_transit'),
  },
]
