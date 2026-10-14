/**
 * A map state, checked against the layers that actually exist.
 *
 * Lifted out of `mcpWriteTools` by P11-1, unchanged in behaviour, because a
 * second caller arrived: a working set now carries its own default **framing**
 * (spec §F, as amended), and a framing is a map state. Two validators for one
 * shape would drift, and the drift would be silent — a layer id the view route
 * accepts and the set route rejects, or the reverse.
 *
 * The registries are read straight from the generated JSON rather than through
 * `mcpTools`, so this module is a leaf: `routes/views` ⇄ `mcpWriteTools` is
 * already a cycle, and nothing is served by joining it.
 *
 * **Why validate at all, when the browser cannot compose a bad state?** It
 * can't — it can only put on the map what the map offered it. But an assistant
 * composes a state from a conversation, and a manifest can be hand-edited or
 * hand-pushed. A typo'd layer id would otherwise be discovered by a person
 * opening a set that renders nothing.
 */
import publicLayerRegistry from '../prompt/publicLayers.generated.json' with { type: 'json' }
import siteLayerRegistry from '../prompt/siteLayers.generated.json' with { type: 'json' }
import { listInternalLayers } from './internalLayers.js'

/** Most scoring layers one state may name. */
export const VIEW_LAYERS_MAX = 20

/** Most two-letter state codes one state may name — every state and territory
 *  twice over, so this guards a runaway write rather than limiting anybody. */
export const VIEW_REGIONS_MAX = 60

/** The same ceiling every other stored body gets. A prompt is prose. */
const PROMPT_MAX = 200_000

const MAP_FILTER_OPERATORS = ['greater_than', 'less_than', 'between'] as const

/** The contamination overlays a map state may name (P5-78), generated from the
 *  client's `src/config/siteLayers.ts`. */
const SITE_LAYER_IDS = (siteLayerRegistry as { id: string }[]).map(l => l.id)

const PUBLIC_LAYER_IDS = (publicLayerRegistry as { id: string }[]).map(l => l.id)

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(v => typeof v === 'string') ? (value as string[]) : null
}

export interface MapStateOptions {
  /**
   * Validate and keep `viewport`.
   *
   * Off by default, which is what a view saved over MCP needs: an assistant
   * has no camera, so that path has always stored `viewport: null`. A working
   * set's framing is the opposite case — where the map was IS part of the
   * framing — so P11-1 passes this on.
   */
  viewport?: boolean
  /**
   * Keep `prompt`.
   *
   * On by default. A saved view records the question that produced it. A set's
   * framing has no question: it is the set's resting state, not a moment, so
   * P11-1 passes this off and the key is absent rather than empty.
   */
  prompt?: boolean
}

export type MapStateResult = { error: string } | { state: Record<string, unknown> }

/**
 * Validate a map state against both layer registries.
 *
 * Both are consulted — the generated public registry, and the internal
 * manifest (published datasets carrying a layer block, plus a working set's
 * composite columns, which are county layers by P7-8) — so an internal layer
 * is as saveable here as it is in the app.
 */
export async function parseMapState(
  raw: Record<string, unknown>,
  options: MapStateOptions = {},
): Promise<MapStateResult> {
  const keepViewport = options.viewport === true
  const keepPrompt = options.prompt !== false

  const internal = await listInternalLayers()
  const countyIds = new Set<string>([
    ...PUBLIC_LAYER_IDS,
    ...internal.filter(l => l.geometry === 'county').map(l => l.id),
  ])
  // Overlays — point and line (P7-3). Neither can be scored, and both ride
  // in the state's `pointLayers` list, which is the stored key.
  const pointIds = new Map(internal.filter(l => l.geometry !== 'county').map(l => [l.id, l.name]))

  if (!Array.isArray(raw.layers)) return { error: 'a map view needs a layers list' }
  if (raw.layers.length === 0) return { error: 'a map view needs at least one layer' }
  if (raw.layers.length > VIEW_LAYERS_MAX) return { error: `layers: at most ${VIEW_LAYERS_MAX}` }
  const layers: Record<string, unknown>[] = []
  for (const entry of raw.layers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: 'each layer is {layerId, weight}' }
    }
    const { layerId, weight, direction } = entry as Record<string, unknown>
    if (typeof layerId !== 'string' || !countyIds.has(layerId)) {
      return { error: `unknown layer: ${String(layerId)} — call list_layers for the ids` }
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      return { error: `layer ${layerId}: weight must be a positive number` }
    }
    if (direction !== undefined && direction !== 'higher_better' && direction !== 'lower_better') {
      return { error: `layer ${layerId}: direction must be higher_better or lower_better` }
    }
    layers.push({ layerId, weight, ...(direction ? { direction } : {}) })
  }

  const filters: Record<string, unknown>[] = []
  if (raw.filters !== undefined) {
    if (!Array.isArray(raw.filters)) return { error: 'filters must be a list' }
    for (const entry of raw.filters) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { error: 'each filter is {layerId, operator, value}' }
      }
      const { layerId, operator, value, max } = entry as Record<string, unknown>
      if (typeof layerId !== 'string' || !countyIds.has(layerId)) {
        return { error: `unknown layer in a filter: ${String(layerId)}` }
      }
      if (typeof operator !== 'string' || !(MAP_FILTER_OPERATORS as readonly string[]).includes(operator)) {
        return { error: `filter operator must be one of ${MAP_FILTER_OPERATORS.join(', ')}` }
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `filter on ${layerId}: value must be a number` }
      if (operator === 'between' && (typeof max !== 'number' || !Number.isFinite(max))) {
        return { error: `filter on ${layerId}: a between filter needs a numeric max` }
      }
      filters.push({ layerId, operator, value, ...(operator === 'between' ? { max } : {}) })
    }
  }

  const state: Record<string, unknown> = { layers, filters, viewport: null }
  if (keepPrompt) state.prompt = ''

  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== 'number' || !Number.isInteger(raw.limit) || raw.limit < 1) {
      return { error: 'limit must be a whole number of counties, or omitted' }
    }
    state.limit = raw.limit
  } else {
    state.limit = null
  }

  const regions = raw.regionStates === undefined ? [] : stringList(raw.regionStates)
  if (!regions) return { error: 'regionStates must be a list of two-letter state codes' }
  if (regions.length > VIEW_REGIONS_MAX) return { error: `regionStates: at most ${VIEW_REGIONS_MAX}` }
  const bad = regions.find(code => !/^[A-Za-z]{2}$/.test(code))
  if (bad !== undefined) return { error: `not a two-letter state code: ${bad}` }
  state.regionStates = regions.map(code => code.toUpperCase())

  if (keepPrompt && typeof raw.prompt === 'string') state.prompt = raw.prompt.trim().slice(0, PROMPT_MAX)

  // Where the map was. Only read when the caller says this state has a camera
  // behind it — see `MapStateOptions.viewport`.
  if (keepViewport && raw.viewport !== undefined && raw.viewport !== null) {
    const vp = raw.viewport as Record<string, unknown>
    if (!vp || typeof vp !== 'object' || Array.isArray(vp)) {
      return { error: 'viewport is {center: [lng, lat], zoom}' }
    }
    const center = vp.center
    if (!Array.isArray(center) || center.length !== 2 || !center.every(n => typeof n === 'number' && Number.isFinite(n))) {
      return { error: 'viewport.center is [lng, lat]' }
    }
    const [lng, lat] = center as [number, number]
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return { error: 'viewport.center is out of range — [lng, lat] in degrees' }
    }
    if (typeof vp.zoom !== 'number' || !Number.isFinite(vp.zoom) || vp.zoom < 0 || vp.zoom > 24) {
      return { error: 'viewport.zoom is a number between 0 and 24' }
    }
    state.viewport = { center: [lng, lat], zoom: vp.zoom }
  }

  if (raw.pointLayers !== undefined) {
    if (!Array.isArray(raw.pointLayers)) return { error: 'pointLayers must be a list' }
    const points: { id: string; name: string }[] = []
    for (const entry of raw.pointLayers) {
      const id = typeof entry === 'string' ? entry : (entry as Record<string, unknown>)?.id
      if (typeof id !== 'string' || !pointIds.has(id)) return { error: `unknown overlay layer: ${String(id)}` }
      points.push({ id, name: pointIds.get(id) as string })
    }
    if (points.length) state.pointLayers = points
  }

  // P5-78: the contamination overlays that come on with the state. A typo is
  // an error here rather than a dropped id the way the browser's route drops
  // one: an assistant composes this list from a conversation, and a silently
  // lost layer would only be noticed by whoever opens the view.
  if (raw.siteLayers !== undefined) {
    const ids = stringList(raw.siteLayers)
    if (!ids) return { error: 'siteLayers must be a list of contamination layer ids' }
    const bad = ids.find(id => !SITE_LAYER_IDS.includes(id))
    if (bad !== undefined) {
      return { error: `unknown site layer: ${bad} — one of ${SITE_LAYER_IDS.join(', ')}` }
    }
    const sites = [...new Set(ids)]
    if (sites.length) state.siteLayers = sites
  }

  return { state }
}

/**
 * A working set's default framing (P11-1).
 *
 * The same validator with the two differences a framing has from a view: it
 * remembers where the map was, and it carries no prompt.
 */
export function parseFraming(raw: Record<string, unknown>): Promise<MapStateResult> {
  return parseMapState(raw, { viewport: true, prompt: false })
}
