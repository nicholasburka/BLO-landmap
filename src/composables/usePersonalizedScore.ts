/**
 * Dynamic Scoring Engine
 *
 * Computes a weighted composite score per county given a set of layers
 * with weights and optional direction overrides. Handles missing data
 * via proportional weight redistribution.
 */

import { computed, type Ref, type ComputedRef } from 'vue'
import { LAYER_REGISTRY, getLayer } from '@/config/layerRegistry'
import type {
  ScoringQuery,
  CountyScore,
  ScoredComponent,
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationDataMap,
  EconomicDataMap,
  HousingDataMap,
  EquityDataMap,
  TransportationDataMap,
} from '@/types/mapTypes'

/**
 * All loaded data maps, passed in from useMapData refs.
 */
export interface DataMaps {
  diversityData: Ref<DiversityData>
  lifeExpectancyData: Ref<LifeExpectancyDataMap>
  countyContaminationCounts: ContaminationDataMap
  economicData: Ref<EconomicDataMap>
  housingData: Ref<HousingDataMap>
  equityData: Ref<EquityDataMap>
  transportationData: Ref<TransportationDataMap>
}

/**
 * Look up the raw numeric value for a layer from the appropriate data map.
 * Returns undefined if the county or field is missing.
 */
function getRawValue(
  geoId: string,
  layerId: string,
  dataKey: string,
  dataMaps: DataMaps
): number | undefined {
  let record: Record<string, any> | undefined

  switch (layerId) {
    case 'diversity_index':
    case 'pct_Black':
      record = dataMaps.diversityData.value[geoId]
      break
    case 'life_expectancy':
      record = dataMaps.lifeExpectancyData.value[geoId]
      break
    case 'contamination': {
      const contam = dataMaps.countyContaminationCounts[geoId]
      if (contam == null) return undefined
      if (typeof contam === 'number') return contam
      return (contam as any).total
    }
    case 'avg_weekly_wage':
    case 'median_income_by_race':
      record = dataMaps.economicData.value[geoId]
      break
    case 'median_home_value':
    case 'median_property_tax':
    case 'homeownership_by_race':
      record = dataMaps.housingData.value[geoId]
      break
    case 'poverty_by_race':
    case 'black_progress_index':
      record = dataMaps.equityData.value[geoId]
      break
    case 'commute_time':
    case 'drove_alone':
    case 'public_transit':
      record = dataMaps.transportationData.value[geoId]
      break
    default:
      return undefined
  }

  if (!record) return undefined

  const val = record[dataKey]
  if (val == null) return undefined

  const num = typeof val === 'string' ? parseFloat(val) : val
  return typeof num === 'number' && !isNaN(num) ? num : undefined
}

/**
 * Normalize a value to [0, 1] using min-max scaling.
 * Clamps to [0, 1] if value is outside range.
 */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0
  return Math.max(0, Math.min(1, (value - min) / (max - min)))
}

/**
 * Collect all unique GEOIDs across all data maps.
 */
function getAllGeoIds(dataMaps: DataMaps): Set<string> {
  const ids = new Set<string>()
  for (const id of Object.keys(dataMaps.diversityData.value)) ids.add(id)
  for (const id of Object.keys(dataMaps.lifeExpectancyData.value)) ids.add(id)
  for (const id of Object.keys(dataMaps.countyContaminationCounts)) ids.add(id)
  for (const id of Object.keys(dataMaps.economicData.value)) ids.add(id)
  for (const id of Object.keys(dataMaps.housingData.value)) ids.add(id)
  for (const id of Object.keys(dataMaps.equityData.value)) ids.add(id)
  for (const id of Object.keys(dataMaps.transportationData.value)) ids.add(id)
  return ids
}

/**
 * Score all counties against a scoring query.
 */
function computeScores(
  query: ScoringQuery,
  dataMaps: DataMaps
): Map<string, CountyScore> {
  const results = new Map<string, CountyScore>()

  if (query.length === 0) return results

  // Pre-resolve layer definitions
  const layers = query
    .filter((q) => q.weight > 0)
    .map((q) => {
      const def = LAYER_REGISTRY[q.layerId]
      if (!def) return null
      return { query: q, def }
    })
    .filter(Boolean) as { query: ScoringQuery[number]; def: (typeof LAYER_REGISTRY)[string] }[]

  if (layers.length === 0) return results

  const geoIds = getAllGeoIds(dataMaps)

  for (const geoId of geoIds) {
    const components: ScoredComponent[] = []
    const missingLayers: string[] = []
    let weightedSum = 0
    let availableWeight = 0

    for (const { query: q, def } of layers) {
      const rawValue = getRawValue(geoId, q.layerId, def.dataKey, dataMaps)

      if (rawValue === undefined) {
        missingLayers.push(q.layerId)
        continue
      }

      let normalizedValue = normalize(rawValue, def.range.min, def.range.max)

      // Apply direction: if lower_better, invert so lower raw = higher score
      const direction = q.direction || def.direction || 'higher_better'
      if (direction === 'lower_better') {
        normalizedValue = 1 - normalizedValue
      }

      weightedSum += normalizedValue * q.weight
      availableWeight += q.weight

      components.push({
        layerId: q.layerId,
        rawValue,
        normalizedValue,
        weight: q.weight,
        direction,
      })
    }

    // Skip counties with no available data
    if (availableWeight === 0) {
      results.set(geoId, {
        geoId,
        score: null,
        components: [],
        missingLayers: layers.map((l) => l.query.layerId),
      })
      continue
    }

    // Weight redistribution: divide by available weight, scale to 0-100
    const score = (weightedSum / availableWeight) * 100

    results.set(geoId, { geoId, score, components, missingLayers })
  }

  return results
}

/**
 * Composable for dynamic personalized scoring.
 *
 * @param query - Reactive scoring query (layers + weights + directions)
 * @param dataMaps - All loaded data maps from useMapData
 */
export function usePersonalizedScore(
  query: Ref<ScoringQuery>,
  dataMaps: DataMaps
) {
  const scores: ComputedRef<Map<string, CountyScore>> = computed(() => {
    return computeScores(query.value, dataMaps)
  })

  const rankedCounties: ComputedRef<CountyScore[]> = computed(() => {
    const ranked: CountyScore[] = []
    for (const cs of scores.value.values()) {
      if (cs.score !== null) ranked.push(cs)
    }
    ranked.sort((a, b) => (b.score as number) - (a.score as number))
    return ranked
  })

  return {
    scores,
    rankedCounties,
  }
}
