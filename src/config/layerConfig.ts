import { LAYER_REGISTRY, getLayer } from './layerRegistry'
import { SITE_LAYERS } from './siteLayers'

export interface DemographicLayer {
  id: string
  name: string
  file?: string
  color?: string
  visible: boolean
  tooltip?: string
  category?: string
}

/** P5-74: where a contamination GeoJSON is in its on-demand load. Absent
 *  means it has never been asked for — which is every layer at startup. */
export type ContaminationLoadStatus = 'loading' | 'loaded' | 'error'

export interface ContaminationLayer {
  id: string
  name: string
  file: string
  color: string
  visible: boolean
  tooltip?: string
  /** Runtime, not configuration: set by the map the first time the layer is
   *  switched on, and read by the checkbox row (P5-74). */
  status?: ContaminationLoadStatus
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

/** Helper: build tooltip from registry description + source. The BLO
 *  composite gets a "See methodology" link to the About page so users
 *  can follow the weights/sources path the audit flagged as hidden. */
function tip(id: string): string {
  const r = LAYER_REGISTRY[id]
  if (!r) return ''
  const base = `${r.description} (${r.source})`
  if (id === 'combined_scores_v2') {
    return `${base} See <a href="/about" target="_blank" rel="noopener">methodology, weights, and disclaimer</a>.`
  }
  return base
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

/* ---------------------------------------------------------------------------
 * P5-74: contamination sources on demand
 *
 * The five EPA GeoJSONs below are 24 MB together. They used to be fetched and
 * parsed before the map would accept a click; now nothing touches them until
 * someone switches a layer on. The map plumbing lives here, beside the layer
 * definitions and behind a minimal map interface (the same shape
 * `lib/internalFeatureLayers.ts` uses), so it is testable without Mapbox.
 * ------------------------------------------------------------------------ */

export function contaminationSourceId(layerId: string): string {
  return `contamination-source-${layerId}`
}

export function contaminationMapLayerId(layerId: string): string {
  return `contamination-layer-${layerId}`
}

/** The subset of a map's API these helpers touch — mapboxgl.Map satisfies it.
 *  Source/layer params are `any` on purpose: Mapbox's specification unions
 *  aren't assignable to index-signature types. */
export interface ContaminationMapLike {
  getSource(id: string): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addSource(id: string, source: any): unknown
  getLayer(id: string): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addLayer(layer: any): unknown
  setLayoutProperty(id: string, name: string, value: unknown): unknown
}

const EPA_ATTRIBUTION =
  'Data source: <a href="https://www.epa.gov/frs" target="_blank" rel="noopener">U.S. EPA Facility Registry Service</a>'

/** Add one contamination GeoJSON as a hidden circle layer. Idempotent, so a
 *  retry after a half-finished add is safe. The layer starts hidden — the
 *  caller reveals it once it knows the user still wants it. */
export function addContaminationToMap(
  map: ContaminationMapLike,
  layer: ContaminationLayer,
  data: unknown,
): void {
  const sourceId = contaminationSourceId(layer.id)
  const mapLayerId = contaminationMapLayerId(layer.id)
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: 'geojson', data, attribution: EPA_ATTRIBUTION })
  }
  if (!map.getLayer(mapLayerId)) {
    map.addLayer({
      id: mapLayerId,
      type: 'circle',
      source: sourceId,
      paint: { 'circle-radius': 6, 'circle-color': layer.color, 'circle-opacity': 0.7 },
      layout: { visibility: 'none' },
    })
  }
}

/** Show or hide an already-added contamination layer; a no-op while its
 *  GeoJSON is still on the way. */
export function setContaminationVisibility(
  map: ContaminationMapLike,
  layerId: string,
  visible: boolean,
): void {
  const mapLayerId = contaminationMapLayerId(layerId)
  if (!map.getLayer(mapLayerId)) return
  map.setLayoutProperty(mapLayerId, 'visibility', visible ? 'visible' : 'none')
}

/** What the loader needs from its host. Both are functions so a load can
 *  start before the map's style has settled: the download begins at once and
 *  the add waits for `map()` to resolve. */
export interface ContaminationHost {
  /** The map, once its style can take sources; null if it never can. */
  map: () => Promise<ContaminationMapLike | null>
  fetchGeoJson: (url: string) => Promise<unknown>
}

async function loadContaminationOnce(
  layer: ContaminationLayer,
  host: ContaminationHost,
): Promise<boolean> {
  layer.status = 'loading'
  try {
    const data = await host.fetchGeoJson(layer.file)
    const map = await host.map()
    if (!map) throw new Error('the map went away before the layer could be added')
    addContaminationToMap(map, layer, data)
    layer.status = 'loaded'
    return true
  } catch (error) {
    console.warn(
      `[layers] contamination layer ${layer.id} failed:`,
      error instanceof Error ? error.message : error,
    )
    layer.status = 'error'
    return false
  }
}

/**
 * Fetch a contamination GeoJSON and put it on the map, at most once per layer
 * (P5-74). `layer.status` carries the result to the checkbox row: 'loading'
 * while it is on the way, 'loaded' once the map has it, 'error' when it could
 * not be had — and an errored layer loads again on the next ask, which is what
 * makes the row's "try again" work. `inflight` de-dupes callers that arrive
 * together: a checkbox click and a `?layers=` deep link share one download
 * rather than racing for two.
 */
export function ensureContaminationLayer(
  layer: ContaminationLayer,
  host: ContaminationHost,
  inflight: Map<string, Promise<boolean>>,
): Promise<boolean> {
  if (layer.status === 'loaded') return Promise.resolve(true)
  const existing = inflight.get(layer.id)
  if (existing) return existing
  const load = loadContaminationOnce(layer, host).finally(() => inflight.delete(layer.id))
  inflight.set(layer.id, load)
  return load
}

// Contamination layers are point/polygon overlays, not in the registry. The
// definitions live in `siteLayers.ts` because the server needs the same ids
// and labels to validate and describe a saved view's `siteLayers` (P5-78);
// `visible` is runtime state, so it is added here and always starts off.
export const CONTAMINATION_LAYERS: ContaminationLayer[] = SITE_LAYERS.map(layer => ({
  ...layer,
  visible: false,
}))

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
