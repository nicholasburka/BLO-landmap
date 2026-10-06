/**
 * County data for the map.
 *
 * P5-87 / P5-90. This used to be thirteen fetches issued one after another —
 * `await` per file — with ten of them CSVs parsed on the main thread by Papa,
 * and the Mapbox map constructed only after the last one landed. Counties
 * reached the screen at 6.6 s locally and 25-38 s on a loaded laptop.
 *
 * Now there are two files, both built by `scripts/build-datasets.mjs` and both
 * named by the hash of their contents (so `/datasets/build/*` is served
 * `immutable` and a repeat visit re-fetches nothing):
 *
 *   - `county-data.<hash>.json` — every per-county number the map reads, in
 *     sections keyed exactly like the refs below, so consumers did not change.
 *   - `counties.<hash>.geojson` — the polygons.
 *
 * They are fetched in parallel by the caller (`Map.vue` starts both before the
 * map's own style is up). The county-name lookup (`lib/countyLookup.ts`) is
 * deliberately not part of this: it is a nicety for the chat tools, not
 * something the first paint waits on.
 */
import { ref, reactive } from 'vue'
import DATASETS from '@/config/datasetsManifest.generated.json'
import { debugLog } from '@/config/constants'
import type {
  DiversityData,
  LifeExpectancyDataMap,
  ContaminationDataMap,
  CombinedScoreData,
  CombinedScoresDataMap,
  BLOScoreV2Data,
  BLOScoreV2DataMap,
  EconomicDataMap,
  HousingDataMap,
  EquityDataMap,
  TransportationDataMap,
  CountiesGeoJSON,
} from '@/types/mapTypes'

/**
 * The prebuilt file's shape. Every section is `{ GEOID → record }` with the
 * field names the refs expose.
 *
 * The two score sections are trimmed by the build: nothing renders BLO v1's
 * component breakdown or v2's `components`/`raw` blobs (3.3 MB of the source
 * file), so the build keeps only the fields consumers reach for.
 */
export interface CountyDataBundle {
  version: number
  diversity: DiversityData
  lifeExpectancy: LifeExpectancyDataMap
  contamination: ContaminationDataMap
  combinedScores: Record<string, Pick<CombinedScoreData, 'combinedScore' | 'rankScore'>>
  combinedScoresV2: Record<string, Pick<BLOScoreV2Data, 'blo_score_v2'>>
  economic: EconomicDataMap
  housing: HousingDataMap
  equity: EquityDataMap
  transportation: TransportationDataMap
}

/** In-flight or settled fetch of the built file, shared by every caller:
 *  the map and a layer page mounted in the same session read one download. */
let bundleRequest: Promise<CountyDataBundle> | null = null

/**
 * Fetch (once) the prebuilt county file. A failure clears the cached promise
 * so a later attempt can genuinely retry instead of replaying the error.
 */
export function fetchCountyDataBundle(): Promise<CountyDataBundle> {
  bundleRequest ??= fetch(DATASETS.countyData)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`County data ${response.status} from ${DATASETS.countyData}`)
      }
      return (await response.json()) as CountyDataBundle
    })
    .catch((error) => {
      bundleRequest = null
      throw error
    })
  return bundleRequest
}

/** In-flight or settled fetch of the polygons, shared the same way (P6-10).
 *  Two maps can live in one page now — the home map and the chat pane — and
 *  the second one must not re-download and re-parse 1.86 MB the first already
 *  holds. Both get the same parsed object, so the cost is one copy. */
let geometryRequest: Promise<CountiesGeoJSON> | null = null

/**
 * Fetch (once) the county polygons. Same eviction-on-failure rule as the data
 * file above: a failed download is not cached, so the next caller retries.
 */
export function fetchCountiesGeoJSON(): Promise<CountiesGeoJSON> {
  geometryRequest ??= fetch(DATASETS.counties)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`County geometry ${response.status} from ${DATASETS.counties}`)
      }
      return (await response.json()) as CountiesGeoJSON
    })
    .catch((error) => {
      geometryRequest = null
      throw error
    })
  return geometryRequest
}

/** Test seam: forget both cached downloads. */
export function resetCountyDataCache(): void {
  bundleRequest = null
  geometryRequest = null
}

export function useMapData() {
  // Data refs
  const countiesData = ref<CountiesGeoJSON | null>(null)
  const diversityData = ref<DiversityData>({})
  const lifeExpectancyData = ref<LifeExpectancyDataMap>({})
  const countyContaminationCounts = reactive<ContaminationDataMap>({})
  const combinedScoresData = ref<CombinedScoresDataMap>({})
  const combinedScoresV2Data = ref<BLOScoreV2DataMap>({})
  const economicData = ref<EconomicDataMap>({})
  const housingData = ref<HousingDataMap>({})
  const equityData = ref<EquityDataMap>({})
  const transportationData = ref<TransportationDataMap>({})

  /**
   * Load the county polygons. Independent of the data file — the caller runs
   * the two together.
   */
  const loadCountiesGeoJSON = async (): Promise<void> => {
    try {
      countiesData.value = await fetchCountiesGeoJSON()

      debugLog('Counties geometry loaded:', {
        features: countiesData.value?.features?.length,
      })
    } catch (error) {
      console.error('Error loading counties GeoJSON:', error)
      throw error
    }
  }

  /**
   * Load the prebuilt county data file into every data ref.
   *
   * Each section is assigned whole rather than built key by key: ~3,200
   * per-county writes into a reactive ref was a dependency trigger per county
   * per dataset, for maps nothing watches at that granularity.
   */
  const loadCountyData = async (): Promise<void> => {
    try {
      const bundle = await fetchCountyDataBundle()

      diversityData.value = bundle.diversity ?? {}
      lifeExpectancyData.value = bundle.lifeExpectancy ?? {}
      Object.assign(countyContaminationCounts, bundle.contamination ?? {})
      // The built file carries only the fields consumers read from the two
      // score blobs; see CountyDataBundle.
      combinedScoresData.value = (bundle.combinedScores ?? {}) as CombinedScoresDataMap
      combinedScoresV2Data.value = (bundle.combinedScoresV2 ?? {}) as BLOScoreV2DataMap
      economicData.value = bundle.economic ?? {}
      housingData.value = bundle.housing ?? {}
      equityData.value = bundle.equity ?? {}
      transportationData.value = bundle.transportation ?? {}

      debugLog('County data loaded:', {
        version: bundle.version,
        counties: Object.keys(bundle.diversity ?? {}).length,
      })
    } catch (error) {
      console.error('Error loading county data:', error)
      throw error
    }
  }

  /**
   * Per-layer entry points for the layer pages (`LAYER_DATA_SOURCES` in
   * `lib/publicLayers.ts`), which load one layer's values and nothing else.
   * They all resolve the same prebuilt file now — one download, deduped —
   * so the names stay as the documented per-layer contract while the ten CSV
   * parsers they used to run are gone.
   */
  const loadContaminationData = loadCountyData
  const loadDiversityData = loadCountyData
  const loadLifeExpectancyData = loadCountyData
  const loadCombinedScores = loadCountyData
  const loadCombinedScoresV2 = loadCountyData
  const loadEconomicData = loadCountyData
  const loadHousingData = loadCountyData
  const loadEquityData = loadCountyData
  const loadTransportationData = loadCountyData

  /**
   * Geometry and data together, in parallel. The map uses the two promises
   * separately (it counts files for the loading overlay); this is the simple
   * form for anything that just wants everything.
   */
  const loadAllCountyData = async (): Promise<void> => {
    await Promise.all([loadCountiesGeoJSON(), loadCountyData()])
    debugLog('All data loaded successfully')
  }

  return {
    // Data refs
    countiesData,
    diversityData,
    lifeExpectancyData,
    countyContaminationCounts,
    combinedScoresData,
    combinedScoresV2Data,
    economicData,
    housingData,
    equityData,
    transportationData,

    // Loading functions
    loadCountiesGeoJSON,
    loadCountyData,
    loadContaminationData,
    loadDiversityData,
    loadLifeExpectancyData,
    loadCombinedScores,
    loadCombinedScoresV2,
    loadEconomicData,
    loadHousingData,
    loadEquityData,
    loadTransportationData,
    loadAllCountyData,
  }
}
