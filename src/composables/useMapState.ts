/**
 * The state one map on the page holds (P6-10).
 *
 * Extracted from `Map.vue` so there can be more than one map in a session:
 * the public map at `/`, the chat page's pane, and — the direction this is
 * heading — a "Show on map" submap opened inside whatever page you are
 * reading, framed on that page's own filtered rows.
 *
 * Everything here used to live in `Map.vue`'s setup, and two of the pieces
 * lived at *module* scope, which is what made a second map impossible:
 *
 *  - `layer.visible` / `layer.status` were written onto the shared arrays in
 *    `config/layerConfig.ts` (through `reactive(DEMOGRAPHIC_LAYERS)` and
 *    friends), so map B would believe a layer was loaded that only existed on
 *    map A's style — and a contamination row would read "loaded" against a
 *    style with nothing on it. Each instance now gets its own copies; the
 *    config arrays are definitions again and are never mutated.
 *  - `registerInternalLayers` deregistered everything on the way in and
 *    `unregisterInternalLayers` on the way out, so one map unmounting pulled
 *    the internal definitions out from under the other. Registration is now
 *    held per owner (`instanceId`), and the last holder is what releases it.
 *
 * Deliberately shared, because sharing them is right: the two promise caches
 * in `useMapData` (one download of each county file per session), the
 * manifest / values / points caches in `lib/internalLayers`, and
 * `lib/countyLookup`.
 *
 * What is *not* here: anything that touches a `mapboxgl.Map` (that is
 * `MapCanvas.vue`) and anything that is public-map chrome — the Lens, the
 * rails, the walkthrough, saved views, deep links (that stays in `Map.vue`).
 */
import { ref, reactive, computed, type Ref, type ComputedRef } from 'vue'
import {
  DEMOGRAPHIC_LAYERS,
  CONTAMINATION_LAYERS,
  ECONOMIC_LAYERS,
  HOUSING_LAYERS,
  EQUITY_LAYERS,
  TRANSPORTATION_LAYERS,
  type ContaminationLayer,
  type DemographicLayer,
  type EconomicLayer,
  type HousingLayer,
  type EquityLayer,
  type TransportationLayer,
} from '@/config/layerConfig'
import { DEV_MODE_DEMOGRAPHICS_ONLY, debugLog } from '@/config/constants'
import { LAYER_REGISTRY, type LayerDefinition } from '@/config/layerRegistry'
import { stateCodeFor, stateCodeForFips } from '@/config/stateFips'
import type { ScoringQuery, ScoringFilter } from '@/types/mapTypes'
import { useMapData } from '@/composables/useMapData'
import { usePersonalizedScore, type DataMaps } from '@/composables/usePersonalizedScore'
import {
  sharedManifest,
  fetchInternalLayerValues,
  registerInternalLayers,
  unregisterInternalLayers,
  applyLayerRange,
  clearInternalLayerCache,
  isInternalLayerId,
  slugFromLayerId,
  featureLayersFrom,
  type InternalFeatureLayer,
  type InternalFeatureCollection,
} from '@/lib/internalLayers'
import type { EntityRef } from '@/lib/entityRail'
import type { QueryStateInput, RankedCountyInfo } from '@/lib/mapTools'

/** The scoring engine's own return shape, so the facade below does not
 *  re-declare types that belong to it. */
type ScoreEngine = ReturnType<typeof usePersonalizedScore>

/** The county data store one page reads. Both caches inside it are shared, so
 *  a second instance costs a second set of refs over the same parsed objects. */
export type MapDataStore = ReturnType<typeof useMapData>

/** Per-instance copies of the layer definitions. `visible` and `status` are
 *  runtime state, not configuration, and must not be shared between maps. */
export interface MapLayerDefinitions {
  demographic: DemographicLayer[]
  economic: EconomicLayer[]
  housing: HousingLayer[]
  equity: EquityLayer[]
  transportation: TransportationLayer[]
  contamination: ContaminationLayer[]
}

/** Switching one layer on or off, whoever asks: a Lens checkbox, a deep
 *  link, the chat's `show_layer`, a host page opening a submap. */
export interface MapLayerToggles {
  demographic: (layerId: string) => void
  economic: (layerId: string) => void
  housing: (layerId: string) => void
  equity: (layerId: string) => void
  transportation: (layerId: string) => void
  internal: (layerId: string) => void
  points: (layerId: string) => void
  contaminationChoropleth: () => void
}

/**
 * Which layers one map is showing, and how to change it. A plain object of
 * refs (the shape `useLibraryChat` returns), so a host can destructure it back
 * to the refs it wants and `MapCanvas` can read and write it through one prop.
 *
 * Build it with `useMapState()`: it must be the same object for the life of
 * the canvas, which an inline object literal in a template would not be.
 */
export interface MapLayerState {
  demographic: Ref<string[]>
  economic: Ref<string[]>
  housing: Ref<string[]>
  equity: Ref<string[]>
  transportation: Ref<string[]>
  /** P5-18 internal county layers (scorable) and P5-24 point overlays. */
  internal: Ref<string[]>
  points: Ref<string[]>
  /** The county-level contamination comparison, not the site overlays. */
  contaminationChoropleth: Ref<boolean>
  /** "All Individual Sites" — mirrors the per-site rows. */
  allContaminationSites: Ref<boolean>
  diversityChoropleth: Ref<boolean>
  definitions: MapLayerDefinitions
  internalDefinitions: Ref<LayerDefinition[]>
  pointDefinitions: Ref<InternalFeatureLayer[]>
  internalValues: Ref<Record<string, Record<string, number>>>
  pointData: Ref<Record<string, InternalFeatureCollection>>
  activeEntity: Ref<EntityRef | null>
  /** Every selected layer that takes part in scoring. */
  all: ComputedRef<string[]>
  /** What to call what is on screen — the Lens header and the pane header. */
  activeName: ComputedRef<string>
  toggle: MapLayerToggles
}

/** What one map is ranking, filtering and framing. */
export interface MapQueryState {
  weights: Ref<Record<string, number>>
  directions: Ref<Record<string, string>>
  filters: Ref<ScoringFilter[]>
  limit: Ref<number | null>
  /** Two-letter state codes the query is restricted to (the chat's region axis). */
  regionStates: Ref<string[]>
  /**
   * Render exactly these counties as the answer: the GEOIDs of a page's own
   * filtered or selected rows. Null (the public map) means "whatever the
   * query ranks". This is the one thing a `?layers=…&fit=…` deep link cannot
   * say, and the reason a submap pane can show a page's filtered data where a
   * link to `/` cannot.
   */
  only: Ref<string[] | null>
  scoring: ComputedRef<ScoringQuery>
  scores: ScoreEngine['scores']
  ranked: ScoreEngine['rankedCounties']
  /** `ranked` after `only` and `limit`. */
  limitedRanked: ComputedRef<ScoreEngine['rankedCounties']['value']>
  /** The counties drawn as the answer: dimmed-against, outlined, framed. */
  topNGeoIds: ComputedRef<Set<string>>
  /** Replace the whole query in one call (the `set_query_state` tool). */
  apply: (input: MapQueryInput) => void
  /** Back to the BLO Livability Index default. */
  reset: () => void
  /** The ranked answer as the chat narrates it, region filter applied. */
  topRanked: (limit: number) => RankedCountyInfo[]
  /** Tell every map drawing this state to re-read it. */
  repaint: () => void
  /** Subscribe a canvas to repaints; the returned function unsubscribes. */
  onRepaint: (hook: () => void) => () => void
}

/**
 * A query to apply, where leaving a field out means "don't touch it" —
 * `QueryStateInput` requires `filters` and `regionStates`, and the prompt's
 * own result distinguishes "the model said nothing about filters" from "the
 * model cleared them". Every `QueryStateInput` is a valid one of these.
 */
export type MapQueryInput = Omit<QueryStateInput, 'filters' | 'regionStates'> & {
  filters?: ScoringFilter[]
  regionStates?: string[]
}

/** What a caller can ask for up front — one object, all optional. */
export interface MapStateInit {
  /** Public, internal county and internal point layer ids, in any mix. */
  layers?: string[]
  filters?: ScoringFilter[]
  limit?: number | null
  regionStates?: string[]
  only?: string[] | null
  /** Share one county-data store with the page that owns this state. */
  data?: MapDataStore
}

let instanceCount = 0

export function useMapState(init: MapStateInit = {}) {
  /** Who this instance is, for the registry's per-owner registration. */
  const instanceId = `map-${++instanceCount}`

  const data = init.data ?? useMapData()
  const {
    countiesData,
    diversityData,
    lifeExpectancyData,
    countyContaminationCounts,
    combinedScoresV2Data,
    economicData,
    housingData,
    equityData,
    transportationData,
  } = data

  // --- The layer definitions, per instance -------------------------------
  // A shallow copy per layer: `visible` and `status` are this map's answer
  // about this map's style. The exported arrays stay definitions.
  const copy = <T,>(layers: T[]): T[] => layers.map(layer => ({ ...layer }))
  const definitions: MapLayerDefinitions = {
    demographic: reactive(copy(DEMOGRAPHIC_LAYERS)),
    economic: reactive(copy(ECONOMIC_LAYERS)),
    housing: reactive(copy(HOUSING_LAYERS)),
    equity: reactive(copy(EQUITY_LAYERS)),
    transportation: reactive(copy(TRANSPORTATION_LAYERS)),
    contamination: DEV_MODE_DEMOGRAPHICS_ONLY ? [] : reactive(copy(CONTAMINATION_LAYERS)),
  }
  const demographicLayers = definitions.demographic
  const economicLayers = definitions.economic
  const housingLayers = definitions.housing
  const equityLayers = definitions.equity
  const transportationLayers = definitions.transportation
  const contaminationLayers = definitions.contamination

  // --- Selection ---------------------------------------------------------
  const selectedDemographicLayers = ref<string[]>(['combined_scores_v2'])
  const selectedEconomicLayers = ref<string[]>([])
  const selectedHousingLayers = ref<string[]>([])
  const selectedEquityLayers = ref<string[]>([])
  const selectedTransportationLayers = ref<string[]>([])
  // P5-18: internal library layers. Populated only while an internal user is
  // logged in (see `loadInternalLayers`); the public map never holds a
  // definition, a value, or a selection.
  const internalLayers = ref<LayerDefinition[]>([])
  const selectedInternalLayers = ref<string[]>([])
  const internalLayerValues = ref<Record<string, Record<string, number>>>({})
  // P5-24: internal point layers — overlays with their own map sources; never
  // part of the scoring query.
  const internalFeatureLayers = ref<InternalFeatureLayer[]>([])
  const selectedInternalFeatureLayers = ref<string[]>([])
  /** Fetched feature collections per toggled point layer (feeds the entity rail). */
  const internalFeatureData = ref<Record<string, InternalFeatureCollection>>({})
  /** P5-28: the entity highlighted in the rail (marker click ↔ row click). */
  const activeEntity = ref<EntityRef | null>(null)

  const showContaminationChoropleth = ref(false)
  const showContaminationLayers = ref(false)
  const showDiversityChoropleth = ref(true) // Start with true since BLO layer is pre-selected

  const layerWeights = ref<Record<string, number>>({})
  const layerDirections = ref<Record<string, string>>({})
  const activeFilters = ref<ScoringFilter[]>(init.filters ? [...init.filters] : [])
  const activeLimit = ref<number | null>(init.limit ?? null)
  const regionStates = ref<string[]>(init.regionStates ? [...init.regionStates] : [])
  const only = ref<string[] | null>(init.only ?? null)

  // --- Repainting and host reactions -------------------------------------
  // There is no bus and no store: a mutator says "the layers changed" and
  // whoever is drawing them hears it. `MapCanvas` subscribes with `onRepaint`
  // (so a toggle repaints as synchronously as it did when both lived in one
  // component), and the public chrome subscribes with `onQueryApplied` for
  // the things only it cares about — leaving a walkthrough, opening the
  // ranking panel.
  const repaintHooks = new Set<() => void>()
  const queryHooks = new Set<(input: MapQueryInput) => void>()

  /** Tell every map drawing this state to re-read it. */
  const repaint = (): void => {
    for (const hook of repaintHooks) hook()
  }

  /** Subscribe a canvas; returns the unsubscribe for its unmount. */
  const onRepaint = (hook: () => void): (() => void) => {
    repaintHooks.add(hook)
    return () => repaintHooks.delete(hook)
  }

  /** Subscribe a host to "the query was replaced by a tool or a page". */
  const onQueryApplied = (hook: (input: MapQueryInput) => void): (() => void) => {
    queryHooks.add(hook)
    return () => queryHooks.delete(hook)
  }

  // --- Derivations -------------------------------------------------------

  // Computed property to track ALL selected layers across categories
  const allSelectedLayers = computed(() => {
    const layers = [
      ...selectedDemographicLayers.value,
      ...selectedEconomicLayers.value,
      ...selectedHousingLayers.value,
      ...selectedEquityLayers.value,
      ...selectedTransportationLayers.value,
      ...selectedInternalLayers.value,
    ].filter(layerId =>
      // Exclude BLO combined scores from multi-layer computation
      layerId !== 'combined_scores' && layerId !== 'combined_scores_v2'
    )

    // Add contamination if the choropleth is showing
    if (showContaminationChoropleth.value) {
      layers.push('contamination')
    }

    return layers
  })

  // Build reactive scoring query from selected layers + weights + directions
  const scoringQuery = computed<ScoringQuery>(() => {
    return allSelectedLayers.value.map(layerId => {
      const reg = LAYER_REGISTRY[layerId]
      return {
        layerId,
        weight: layerWeights.value[layerId] ?? 5,
        direction: (layerDirections.value[layerId] as 'higher_better' | 'lower_better') ?? reg?.direction ?? 'higher_better',
      }
    })
  })

  /** Phase 4d: name shown in the Lens header (and the pane's header) when no
   *  query is active. Reflects whatever single layer is rendering by default. */
  const activeLayerName = computed(() => {
    if (allSelectedLayers.value.length === 0) {
      return showContaminationChoropleth.value ? 'Contamination' : 'BLO Livability Index'
    }
    if (allSelectedLayers.value.length === 1) {
      return LAYER_REGISTRY[allSelectedLayers.value[0]]?.name ?? allSelectedLayers.value[0]
    }
    return 'BLO Livability Index'
  })

  // Initialize scoring engine
  const dataMaps: DataMaps = {
    diversityData,
    lifeExpectancyData,
    countyContaminationCounts,
    economicData,
    housingData,
    equityData,
    transportationData,
    internalLayerValues,
  }

  const {
    scores: personalizedScores,
    rankedCounties,
    filteredOutCountyIds,
  } = usePersonalizedScore(scoringQuery, dataMaps, activeFilters)

  /** Ranked counties after the explicit subset and the display limit. */
  const limitedRankedCounties = computed(() => {
    const subset = only.value ? new Set(only.value) : null
    const rows = subset ? rankedCounties.value.filter(c => subset.has(c.geoId)) : rankedCounties.value
    const limit = activeLimit.value
    if (limit == null) return rows
    return rows.slice(0, limit)
  })

  /** Phase 4c: GEOIDs of the top-N counties when a limit is active. Drives
   *  choropleth dim logic (non-top-N counties render at reduced alpha) and
   *  the walkthrough overlays (set outline + numbered markers).
   *  Empty when nothing narrows the map — the choropleth renders normally.
   *  P6-10: an explicit `only` subset is itself the answer, with or without
   *  a scoring query, so it short-circuits the limit. */
  const topNGeoIds = computed<Set<string>>(() => {
    if (only.value) return new Set(only.value)
    if (activeLimit.value == null) return new Set()
    if (allSelectedLayers.value.length < 1) return new Set()
    return new Set(limitedRankedCounties.value.map(c => c.geoId))
  })

  // --- Reading values ----------------------------------------------------

  /** Resolve county name from GEOID. Tries the data maps first, then falls
   *  back to the polygon GeoJSON's NAME property — which covers ~3220 features
   *  including territories that aren't in diversityData. Last resort is the
   *  raw GEOID string, but we should rarely hit that now. */
  const getCountyName = (geoId: string): string => {
    const div = diversityData.value[geoId]
    if (div?.countyName) return div.countyName
    const econ = economicData.value[geoId]
    if (econ?.county_name) return econ.county_name
    const housing = housingData.value[geoId]
    if (housing?.county_name) return housing.county_name
    // GeoJSON fallback: polygon features include NAME for every county we draw
    const feature = countiesData.value?.features.find(
      (f: any) => f.properties?.GEOID === geoId
    )
    const geoName = feature?.properties?.NAME
    if (geoName && typeof geoName === 'string') return geoName
    return geoId
  }

  /** Resolve a state name from diversityData (which carries STNAME). */
  const getStateName = (geoId: string): string => {
    return diversityData.value[geoId]?.stateName || ''
  }

  /** Look up the raw value for a layer in the appropriate data map.
   *  Mirrors `getRawLayerValue` from the tooltip closure but takes geoId
   *  as a parameter so it can be used outside that closure (e.g. by
   *  CountyRail). Returns undefined when the layer or county is missing. */
  const getRawLayerValueFor = (layerId: string, geoId: string): any => {
    const reg = LAYER_REGISTRY[layerId]
    if (!reg) return undefined
    if (isInternalLayerId(layerId)) return internalLayerValues.value[layerId]?.[geoId]
    const key = reg.dataKey
    switch (layerId) {
      case 'combined_scores_v2':
        return combinedScoresV2Data.value[geoId]?.blo_score_v2
      case 'diversity_index':
        return diversityData.value[geoId]?.diversityIndex
      case 'pct_Black':
        return diversityData.value[geoId]?.pct_Black
      case 'life_expectancy':
        return lifeExpectancyData.value[geoId]?.lifeExpectancy
      case 'contamination': {
        const c = countyContaminationCounts[geoId] as any
        return typeof c === 'number' ? c : c?.total
      }
      case 'avg_weekly_wage':
      case 'median_income_by_race':
        return (economicData.value[geoId] as any)?.[key]
      case 'median_home_value':
      case 'median_property_tax':
      case 'homeownership_by_race':
        return (housingData.value[geoId] as any)?.[key]
      case 'poverty_by_race':
      case 'black_progress_index':
        return (equityData.value[geoId] as any)?.[key]
      case 'commute_time':
      case 'drove_alone':
      case 'public_transit':
        return (transportationData.value[geoId] as any)?.[key]
      default:
        return undefined
    }
  }

  /** The 2-letter state code for a GEOID. The GEOID's own FIPS prefix answers
   *  it outright (P6-19's one state table); `diversityData`'s STNAME is the
   *  fallback for a geo id that is not a county code. */
  const stateAbbrFromGeo = (geoId: string): string => {
    const fromFips = stateCodeForFips(String(geoId).padStart(5, '0').slice(0, 2))
    if (fromFips) return fromFips
    const name = getStateName(geoId)
    return stateCodeFor(name) || name.substring(0, 2).toUpperCase()
  }

  /**
   * The top ranked counties as the chat's `set_query_state` narrates them.
   * Applies the region filter the same way the ranking panel does, so the
   * tool_result and the panel cannot disagree (`rankedCounties` itself has no
   * region concept).
   */
  const topRankedCounties = (limit: number): RankedCountyInfo[] => {
    const region = regionStates.value.length > 0
      ? new Set(regionStates.value.map(s => s.toUpperCase()))
      : null
    const eligible = region
      ? rankedCounties.value.filter(c => region.has(stateAbbrFromGeo(c.geoId).toUpperCase()))
      : rankedCounties.value
    return eligible.slice(0, limit).map((c, i) => ({
      rank: i + 1,
      geoId: c.geoId,
      name: getCountyName(c.geoId),
      state: diversityData.value[c.geoId]?.stateName || '',
      score: c.score ?? 0,
    }))
  }

  // --- Mutators ----------------------------------------------------------

  const updateLayerWeight = (layerId: string, weight: number) => {
    layerWeights.value = { ...layerWeights.value, [layerId]: weight }
  }

  const updateLayerDirection = (layerId: string, direction: string) => {
    layerDirections.value = { ...layerDirections.value, [layerId]: direction }
  }

  /** Phase 4b: manual threshold filter edit from LayerControls.
   *  Replaces any existing filter for this layer; null removes it. */
  const updateLayerFilter = (layerId: string, filter: ScoringFilter | null) => {
    const others = activeFilters.value.filter(f => f.layerId !== layerId)
    activeFilters.value = filter ? [...others, filter] : others
  }

  /** Clear threshold filters without changing the scoring query or selected layers */
  const clearActiveFilters = () => {
    activeFilters.value = []
  }

  /** Clear BLO precomputed layer when user selects a different layer */
  const clearBLO = () => {
    const bloIdx = selectedDemographicLayers.value.indexOf('combined_scores_v2')
    if (bloIdx !== -1) selectedDemographicLayers.value.splice(bloIdx, 1)
    const bloLayer = demographicLayers.find(l => l.id === 'combined_scores_v2')
    if (bloLayer) bloLayer.visible = false
  }

  /** Check if BLO composite is the only selected layer (precomputed mode) */
  const isBLOPrecomputedMode = () => {
    return selectedDemographicLayers.value.length === 1 &&
      selectedDemographicLayers.value[0] === 'combined_scores_v2' &&
      selectedEconomicLayers.value.length === 0 &&
      selectedHousingLayers.value.length === 0 &&
      selectedEquityLayers.value.length === 0 &&
      selectedTransportationLayers.value.length === 0 &&
      !showContaminationChoropleth.value
  }

  const toggleDemographicLayer = (layerId: string) => {
    debugLog('TOGGLING ' + layerId)
    const layer = demographicLayers.find((l) => l.id === layerId)
    if (!layer) return

    if (layerId === 'combined_scores' || layerId === 'combined_scores_v2') {
      // BLO toggle: simple on/off for precomputed view
      if (selectedDemographicLayers.value.includes(layerId)) {
        selectedDemographicLayers.value = selectedDemographicLayers.value.filter(id => id !== layerId)
        layer.visible = false
      } else {
        selectedDemographicLayers.value.push(layerId)
        layer.visible = true
      }
    } else {
      const currentIndex = selectedDemographicLayers.value.indexOf(layerId)

      if (currentIndex === -1) {
        if (isBLOPrecomputedMode()) clearBLO()
        selectedDemographicLayers.value.push(layerId)
        layer.visible = true
      } else {
        selectedDemographicLayers.value.splice(currentIndex, 1)
        layer.visible = false
      }
    }

    showDiversityChoropleth.value = selectedDemographicLayers.value.length > 0
    repaint()
  }

  /** The four categories that behave identically: on unless already on, and
   *  BLO's precomputed view steps aside for the first of them. */
  const toggleCategoryLayer = (
    defs: { id: string; visible: boolean }[],
    selected: Ref<string[]>,
    layerId: string,
  ) => {
    const layer = defs.find((l) => l.id === layerId)
    if (!layer) return

    const currentIndex = selected.value.indexOf(layerId)

    if (currentIndex === -1) {
      if (isBLOPrecomputedMode()) clearBLO()
      selected.value.push(layerId)
      layer.visible = true
    } else {
      selected.value.splice(currentIndex, 1)
      layer.visible = false
    }

    showDiversityChoropleth.value = selected.value.length > 0 || selectedDemographicLayers.value.length > 0
    repaint()
  }

  const toggleEconomicLayer = (layerId: string) =>
    toggleCategoryLayer(economicLayers, selectedEconomicLayers, layerId)
  const toggleHousingLayer = (layerId: string) =>
    toggleCategoryLayer(housingLayers, selectedHousingLayers, layerId)
  const toggleEquityLayer = (layerId: string) =>
    toggleCategoryLayer(equityLayers, selectedEquityLayers, layerId)
  const toggleTransportationLayer = (layerId: string) =>
    toggleCategoryLayer(transportationLayers, selectedTransportationLayers, layerId)

  const toggleContaminationChoropleth = () => {
    if (!showContaminationChoropleth.value && isBLOPrecomputedMode()) {
      // Was expandBLOPreset() — that function became clearBLO() in the
      // "simplify BLO toggle" commit (5d2cb3f) and this call site was missed,
      // leaving a runtime ReferenceError. Matches the other toggle handlers.
      clearBLO()
    }
    showContaminationChoropleth.value = !showContaminationChoropleth.value
    repaint()
  }

  /**
   * Reset the scoring query back to the BLO Livability Index default:
   * selected layers, weights, directions, filters and limit. The public
   * map's own reset (`clearActiveQuery`) adds its chrome to this.
   */
  const resetQueryScoring = () => {
    selectedDemographicLayers.value = ['combined_scores_v2']
    selectedEconomicLayers.value = []
    selectedHousingLayers.value = []
    selectedEquityLayers.value = []
    selectedTransportationLayers.value = []
    selectedInternalLayers.value = []
    showContaminationChoropleth.value = false
    demographicLayers.forEach(l => { l.visible = l.id === 'combined_scores_v2' })
    economicLayers.forEach(l => { l.visible = false })
    housingLayers.forEach(l => { l.visible = false })
    equityLayers.forEach(l => { l.visible = false })
    transportationLayers.forEach(l => { l.visible = false })
    layerWeights.value = {}
    layerDirections.value = {}
    activeFilters.value = []
    activeLimit.value = null
    regionStates.value = []
    only.value = null
    showDiversityChoropleth.value = true
  }

  /**
   * Apply a whole query state in one call — the `set_query_state` tool, a
   * saved view's replay, and (soon) a page handing its own filtered rows to a
   * submap all land here. Nothing merges with what was showing: the input is
   * the desired state.
   */
  const applyQueryState = (input: MapQueryInput): void => {
    // Empty layers = explicit clear of the scoring query (set_query_state
    // tool contract: "Empty array clears scoring"). Reset to the BLO
    // default, but still honour filters/limit/region from the same call so a
    // region-only follow-up composes instead of silently no-oping.
    if (!input.layers || input.layers.length === 0) {
      resetQueryScoring()
      if (input.filters !== undefined) activeFilters.value = [...input.filters]
      activeLimit.value = typeof input.limit === 'number' ? input.limit : null
      if (input.regionStates !== undefined) regionStates.value = [...input.regionStates]
      if (input.only !== undefined) only.value = input.only ? [...input.only] : null
      repaint()
      for (const hook of queryHooks) hook(input)
      return
    }

    // Clear everything
    selectedDemographicLayers.value = []
    selectedEconomicLayers.value = []
    selectedHousingLayers.value = []
    selectedEquityLayers.value = []
    selectedTransportationLayers.value = []
    selectedInternalLayers.value = []
    showContaminationChoropleth.value = false
    demographicLayers.forEach(l => { l.visible = false })
    economicLayers.forEach(l => { l.visible = false })
    housingLayers.forEach(l => { l.visible = false })
    equityLayers.forEach(l => { l.visible = false })
    transportationLayers.forEach(l => { l.visible = false })

    const newWeights: Record<string, number> = {}
    const newDirections: Record<string, string> = {}

    for (const layer of input.layers) {
      newWeights[layer.layerId] = layer.weight
      // Cast: direction can be undefined (UI-selected layers in a snapshot
      // replay). Storing undefined here is pre-existing behavior — every
      // consumer reads with `?? registry default`, so it's indistinguishable
      // from the key being absent.
      newDirections[layer.layerId] = layer.direction as string

      // Route to the correct category array
      const demoLayer = demographicLayers.find(l => l.id === layer.layerId)
      if (demoLayer) {
        selectedDemographicLayers.value.push(layer.layerId)
        demoLayer.visible = true
        continue
      }
      const econLayer = economicLayers.find(l => l.id === layer.layerId)
      if (econLayer) {
        selectedEconomicLayers.value.push(layer.layerId)
        econLayer.visible = true
        continue
      }
      const housLayer = housingLayers.find(l => l.id === layer.layerId)
      if (housLayer) {
        selectedHousingLayers.value.push(layer.layerId)
        housLayer.visible = true
        continue
      }
      const eqLayer = equityLayers.find(l => l.id === layer.layerId)
      if (eqLayer) {
        selectedEquityLayers.value.push(layer.layerId)
        eqLayer.visible = true
        continue
      }
      const transLayer = transportationLayers.find(l => l.id === layer.layerId)
      if (transLayer) {
        selectedTransportationLayers.value.push(layer.layerId)
        transLayer.visible = true
        continue
      }
      if (layer.layerId === 'contamination') {
        showContaminationChoropleth.value = true
        continue
      }
      // P5-18: internal layers route by id prefix; unknown ids (logged out, or
      // a layer that no longer exists) are dropped silently.
      if (isInternalLayerId(layer.layerId) && internalLayers.value.some(l => l.id === layer.layerId)) {
        selectedInternalLayers.value.push(layer.layerId)
        void ensureInternalLayerValues(layer.layerId)
      }
    }

    layerWeights.value = newWeights
    layerDirections.value = newDirections

    // Phase 4a: apply filters and limit from the response.
    // Phase 4b: distinguish "the caller didn't touch filters" (undefined →
    // preserve) from "explicitly cleared" (empty array → clear).
    if (input.filters !== undefined) {
      activeFilters.value = [...input.filters]
    }
    activeLimit.value = typeof input.limit === 'number' ? input.limit : null
    if (input.regionStates !== undefined) regionStates.value = [...input.regionStates]
    if (input.only !== undefined) only.value = input.only ? [...input.only] : null

    showDiversityChoropleth.value = true
    repaint()
    for (const hook of queryHooks) hook(input)
  }

  // --- Internal layers (P5-18 / P5-24) -----------------------------------
  // Manifest → runtime registry entries while logged in; values fetched lazily
  // on first toggle (or on saved-view restore); everything torn down on logout
  // so the public map is byte-identical to today.

  const ensureInternalLayerValues = async (layerId: string): Promise<void> => {
    if (internalLayerValues.value[layerId]) return
    try {
      const loaded = await fetchInternalLayerValues(slugFromLayerId(layerId))
      // Still logged in and still registered? (logout may have raced the fetch)
      if (!internalLayers.value.some(l => l.id === layerId)) return
      applyLayerRange(layerId, loaded.range)
      internalLayerValues.value = { ...internalLayerValues.value, [layerId]: loaded.values }
      repaint()
    } catch (err) {
      console.warn('[layers] internal layer values failed:', err instanceof Error ? err.message : err)
    }
  }

  const toggleInternalLayer = (layerId: string) => {
    if (!internalLayers.value.some(l => l.id === layerId)) return
    const idx = selectedInternalLayers.value.indexOf(layerId)
    if (idx === -1) {
      if (isBLOPrecomputedMode()) clearBLO()
      selectedInternalLayers.value.push(layerId)
      void ensureInternalLayerValues(layerId)
    } else {
      selectedInternalLayers.value.splice(idx, 1)
    }
    repaint()
  }

  /** Switch a point overlay on or off. The map side of it — the source, the
   *  clusters, the popup — is `MapCanvas`, which watches this selection. */
  const toggleInternalFeatureLayer = (layerId: string) => {
    if (!internalFeatureLayers.value.some(l => l.id === layerId)) return
    const idx = selectedInternalFeatureLayers.value.indexOf(layerId)
    if (idx === -1) {
      selectedInternalFeatureLayers.value.push(layerId)
    } else {
      selectedInternalFeatureLayers.value.splice(idx, 1)
      const { [layerId]: _dropped, ...rest } = internalFeatureData.value
      internalFeatureData.value = rest
      if (activeEntity.value?.layerId === layerId) activeEntity.value = null
    }
  }

  /** Make exactly these point layers active (saved-view restore). */
  const setInternalFeatureLayers = (ids: string[]) => {
    const wanted = ids.filter(id => internalFeatureLayers.value.some(l => l.id === id))
    for (const id of [...selectedInternalFeatureLayers.value]) {
      if (!wanted.includes(id)) toggleInternalFeatureLayer(id)
    }
    for (const id of wanted) {
      if (!selectedInternalFeatureLayers.value.includes(id)) toggleInternalFeatureLayer(id)
    }
  }

  /** Wait (up to 10 s) for a point layer's features to land after it was
   *  switched on. Callers that need the data — the deep link's frame, the
   *  chat tool's fly-to, a `?focus=` label — all go through here. */
  const waitForPointData = async (layerId: string): Promise<InternalFeatureCollection | null> => {
    for (let i = 0; i < 50 && !internalFeatureData.value[layerId]; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return internalFeatureData.value[layerId] ?? null
  }

  const loadInternalLayers = async (): Promise<void> => {
    try {
      const manifest = await sharedManifest()
      internalLayers.value = registerInternalLayers(manifest, instanceId)
      internalFeatureLayers.value = featureLayersFrom(manifest)
    } catch (err) {
      console.warn('[layers] internal layer manifest failed:', err instanceof Error ? err.message : err)
      internalLayers.value = []
    }
  }

  /**
   * Logout, or this map going away. `clearCache` is false when only this
   * instance is leaving: the manifest and values caches are shared, and
   * another map in the page may still be reading them.
   */
  const teardownInternalLayers = (clearCache = true) => {
    const hadSelection = selectedInternalLayers.value.length > 0
    selectedInternalFeatureLayers.value = []
    internalFeatureLayers.value = []
    internalFeatureData.value = {}
    activeEntity.value = null
    selectedInternalLayers.value = []
    internalLayers.value = []
    internalLayerValues.value = {}
    unregisterInternalLayers(instanceId)
    if (clearCache) clearInternalLayerCache()
    if (hadSelection) repaint()
  }

  // --- The two facades a canvas takes as props ---------------------------

  const layers: MapLayerState = {
    demographic: selectedDemographicLayers,
    economic: selectedEconomicLayers,
    housing: selectedHousingLayers,
    equity: selectedEquityLayers,
    transportation: selectedTransportationLayers,
    internal: selectedInternalLayers,
    points: selectedInternalFeatureLayers,
    contaminationChoropleth: showContaminationChoropleth,
    allContaminationSites: showContaminationLayers,
    diversityChoropleth: showDiversityChoropleth,
    definitions,
    internalDefinitions: internalLayers,
    pointDefinitions: internalFeatureLayers,
    internalValues: internalLayerValues,
    pointData: internalFeatureData,
    activeEntity,
    all: allSelectedLayers,
    activeName: activeLayerName,
    toggle: {
      demographic: toggleDemographicLayer,
      economic: toggleEconomicLayer,
      housing: toggleHousingLayer,
      equity: toggleEquityLayer,
      transportation: toggleTransportationLayer,
      internal: toggleInternalLayer,
      points: toggleInternalFeatureLayer,
      contaminationChoropleth: toggleContaminationChoropleth,
    },
  }

  const query: MapQueryState = {
    weights: layerWeights,
    directions: layerDirections,
    filters: activeFilters,
    limit: activeLimit,
    regionStates,
    only,
    scoring: scoringQuery,
    scores: personalizedScores,
    ranked: rankedCounties,
    limitedRanked: limitedRankedCounties,
    topNGeoIds,
    apply: applyQueryState,
    reset: resetQueryScoring,
    topRanked: topRankedCounties,
    repaint,
    onRepaint,
  }

  // Anything a caller named up front is applied through the same path a tool
  // takes, so there is one definition of "show these layers".
  if (init.layers && init.layers.length > 0) {
    applyQueryState({
      layers: init.layers.map(layerId => ({ layerId, weight: 5 })),
      filters: activeFilters.value,
      limit: activeLimit.value,
      regionStates: regionStates.value,
      only: only.value,
    })
  }

  return {
    instanceId,
    data,
    layers,
    query,
    // Reading
    getCountyName,
    getStateName,
    getRawLayerValueFor,
    stateAbbrFromGeo,
    topRankedCounties,
    filteredOutCountyIds,
    // Writing
    repaint,
    onRepaint,
    onQueryApplied,
    applyQueryState,
    resetQueryScoring,
    clearActiveFilters,
    updateLayerWeight,
    updateLayerDirection,
    updateLayerFilter,
    toggleDemographicLayer,
    toggleEconomicLayer,
    toggleHousingLayer,
    toggleEquityLayer,
    toggleTransportationLayer,
    toggleContaminationChoropleth,
    toggleInternalLayer,
    toggleInternalFeatureLayer,
    setInternalFeatureLayers,
    waitForPointData,
    ensureInternalLayerValues,
    loadInternalLayers,
    teardownInternalLayers,
  }
}

export type MapState = ReturnType<typeof useMapState>

