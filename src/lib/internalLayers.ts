/**
 * Internal map layers (P5-18): manifest + values from the authenticated
 * API, registered into LAYER_REGISTRY at runtime after login and removed on
 * logout. Nothing about a layer (names, slugs, values) exists in this
 * bundle — only this generic loader does. Types mirror
 * server/src/services/internalLayers.ts; keep in sync by hand.
 */
import { internalFetch } from './apiBase'
import { registerLogoutHook } from '@/composables/useAuth'
import { mapUrlForLayers, mapUrlForLayerBounds, type MapBounds } from './mapDeepLinks'
import { boundsForFeatures } from './internalFeatureLayers'
import { stateOutlines } from './stateGeometry'
import { LAYER_REGISTRY, type LayerDefinition, type DataType, type Direction } from '@/config/layerRegistry'
import type { DataDates } from './dataDates'

export const INTERNAL_LAYER_ID_PREFIX = 'internal-'

/** The geometries a layer can declare: a county choropleth (P5-18), points
 *  (P5-24), lines (P7-3) or states (P7-9). */
export type LayerGeometry = 'county' | 'point' | 'line' | 'state'

/** The geometries the map draws as overlays rather than as the scored
 *  choropleth — points, lines and states, none of which score.
 *
 *  A state is in here and not with `county` despite also being drawn on
 *  geometry it does not carry, because of what the map DOES with it: it is a
 *  shape you hover, click and read a popup on, which is the point and line
 *  path end to end. The only thing it shares with a county layer is that the
 *  polygons come from this bundle — and `fetchInternalLayerFeatures` settles
 *  that before the canvas ever sees the layer. */
export type FeatureGeometry = 'point' | 'line' | 'state'

export interface InternalLayerManifestEntry {
  id: string
  slug: string
  geometry: LayerGeometry
  name: string
  dataType: DataType
  unit: string
  direction: Direction
  range: { min: number; max: number } | null
  description: string
  source: string
  year: number | string
  /** P7-10: when the layer's DATA is from, folded by the server off the
   *  entry's own manifest.
   *
   *  Optional on this side of the wire — unlike the server type that builds
   *  it — for the same reason `width` and `detailFields` are: a manifest a
   *  browser is holding from before the field existed is still a manifest this
   *  reads, and a layer that says nothing about its dates is not a defect. */
  dates?: DataDates
  file: string | null
  /** Point, line and state layers (P5-24, P7-3, P7-9): swatch color + popup
   *  field names. */
  color: string | null
  popupFields: string[]
  /** State layers (P7-9): the popup columns whose values are prose. Optional
   *  on this side of the wire for the same reason `width` is. */
  detailFields?: string[]
  /** Line layers (P7-3): stroke width in px, null for the client default.
   *  Optional on this side of the wire — unlike the server type that builds
   *  it — because a manifest a browser is holding from before the field
   *  existed is still a manifest this reads. */
  width?: number | null
  /** Point and line layers (P5-77, P7-3): the extent of the layer's own
   *  features, so a "Show on map" link can carry the frame. Null for a county
   *  layer, and for a feature layer whose rows carry no drawable geometry. */
  bbox: MapBounds | null
  updatedAt: string | null
}

/**
 * A drawn-feature layer as the map UI needs it — never a registry entry,
 * because an overlay does not score. `geometry` is what the canvas switches
 * on to decide whether to paint circles or strokes.
 */
export interface InternalFeatureLayer {
  id: string
  slug: string
  geometry: FeatureGeometry
  name: string
  description: string
  source: string
  color: string | null
  popupFields: string[]
  /** States only; rendered as paragraphs under the field list. */
  detailFields: string[]
  /** Lines only; null takes `LINE_DEFAULT_WIDTH`. */
  width: number | null
}

export interface PointFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: Record<string, string>
}

/** P7-3. One part is a `LineString`, several a `MultiLineString` — both are
 *  what a Mapbox `line` layer draws. */
export interface LineFeature {
  type: 'Feature'
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'MultiLineString'; coordinates: [number, number][][] }
  properties: Record<string, string>
}

/**
 * P7-9. A state, once it has been located.
 *
 * The server ships these **unlocated** — `geometry: null` — because the
 * outlines are not its to send. `fetchInternalLayerFeatures` joins each row to
 * a dissolved state outline before handing the collection on, so everything
 * downstream of it holds an ordinary polygon feature and nothing in the canvas
 * needs a state-shaped exception.
 */
export interface StateFeature {
  type: 'Feature'
  geometry:
    | { type: 'Polygon'; coordinates: [number, number][][] }
    | { type: 'MultiPolygon'; coordinates: [number, number][][][] }
  properties: Record<string, string>
}

/** A state row as it comes off the wire: the properties, no geometry. */
export interface StateRow {
  type: 'Feature'
  geometry: null
  properties: Record<string, string>
}

export type InternalFeature = PointFeature | LineFeature | StateFeature

export interface InternalFeatureCollection {
  id: string
  slug: string
  geometry: FeatureGeometry
  type: 'FeatureCollection'
  features: InternalFeature[]
  count: number
  skipped: number
  bbox: MapBounds | null
}

/** The geometries this bundle knows how to draw as an overlay. An ALLOWLIST
 *  and not `!== 'county'`: a browser holding this bundle can meet a newer
 *  server, and a geometry it has never heard of must be left off the map
 *  rather than drawn as whatever the fallback happens to be. */
const DRAWN_GEOMETRIES: readonly FeatureGeometry[] = ['point', 'line', 'state']

/** The manifest entries the map draws as overlays — points, lines and states,
 *  in the manifest's own order, so a mixed library lists as one group. */
export function featureLayersFrom(manifest: InternalLayerManifestEntry[]): InternalFeatureLayer[] {
  return manifest
    .filter((e): e is InternalLayerManifestEntry & { geometry: FeatureGeometry } =>
      (DRAWN_GEOMETRIES as readonly string[]).includes(e.geometry))
    .map(e => ({
      id: e.id,
      slug: e.slug,
      geometry: e.geometry,
      name: e.name,
      description: e.description,
      source: e.source,
      color: e.color,
      popupFields: e.popupFields ?? [],
      detailFields: e.detailFields ?? [],
      width: e.width ?? null,
    }))
}

export interface InternalLayerValues {
  id: string
  slug: string
  geometry: 'county'
  values: Record<string, number>
  count: number
  range: { min: number; max: number } | null
}

export function isInternalLayerId(id: string): boolean {
  return id.startsWith(INTERNAL_LAYER_ID_PREFIX)
}

export function slugFromLayerId(id: string): string {
  return isInternalLayerId(id) ? id.slice(INTERNAL_LAYER_ID_PREFIX.length) : id
}

export async function fetchInternalLayerManifest(): Promise<InternalLayerManifestEntry[]> {
  const res = await internalFetch('/api/layers/internal')
  if (!res.ok) throw new Error(`internal layer manifest failed (${res.status})`)
  const body = await res.json()
  return Array.isArray(body?.layers) ? (body.layers as InternalLayerManifestEntry[]) : []
}

let manifestPromise: Promise<InternalLayerManifestEntry[]> | null = null
const valuesCache = new Map<string, Promise<InternalLayerValues>>()

/** Per-slug promise cache; a failed fetch is evicted so the next toggle retries. */
export function fetchInternalLayerValues(slug: string): Promise<InternalLayerValues> {
  const hit = valuesCache.get(slug)
  if (hit) return hit
  const promise = (async () => {
    const res = await internalFetch(`/api/layers/internal/${encodeURIComponent(slug)}`)
    if (!res.ok) throw new Error(`internal layer "${slug}" failed (${res.status})`)
    return (await res.json()) as InternalLayerValues
  })()
  valuesCache.set(slug, promise)
  promise.catch(() => valuesCache.delete(slug))
  return promise
}

const featuresCache = new Map<string, Promise<InternalFeatureCollection>>()

/**
 * Features for an overlay layer — point, line or state; same promise-cache +
 * failure-eviction pattern as values. A county slug asked for here is a caller
 * bug, and says so rather than handing back an empty collection.
 *
 * **A state layer is located here, and only here.** The server sends rows with
 * `geometry: null`; this joins each to its dissolved outline so the collection
 * that comes out is an ordinary FeatureCollection of polygons. That is the
 * whole reason nothing in the canvas, the rail, the framing or the popup needs
 * to know where a state's shape came from — by the time any of them see it,
 * it is a feature with coordinates like every other.
 */
export function fetchInternalLayerFeatures(slug: string): Promise<InternalFeatureCollection> {
  const hit = featuresCache.get(slug)
  if (hit) return hit
  const promise = (async () => {
    const res = await internalFetch(`/api/layers/internal/${encodeURIComponent(slug)}`)
    if (!res.ok) throw new Error(`internal feature layer "${slug}" failed (${res.status})`)
    const body = (await res.json()) as InternalFeatureCollection
    if (body?.geometry === 'state') return locateStateRows(body as unknown as InternalLayerStateRows)
    if ((body?.geometry !== 'point' && body?.geometry !== 'line') || !Array.isArray(body.features)) {
      throw new Error(`internal layer "${slug}" is not a point, line or state layer`)
    }
    return body
  })()
  featuresCache.set(slug, promise)
  promise.catch(() => featuresCache.delete(slug))
  return promise
}

/** What the state route actually returns: the envelope, with unlocated rows. */
interface InternalLayerStateRows extends Omit<InternalFeatureCollection, 'features' | 'bbox'> {
  features: StateRow[]
  bbox: null
}

/**
 * Put each state row on its outline.
 *
 * A row whose state has no outline is dropped and counted in `skipped` — the
 * same word the server uses for a row it could not draw, because it is the
 * same fact arriving one hop later. Nothing here invents a shape: a state the
 * county polygons do not describe simply is not drawn.
 *
 * The bbox is computed from the joined features, which is why the server sends
 * none: it is the extent of the outlines, and those are this side's.
 */
async function locateStateRows(body: InternalLayerStateRows): Promise<InternalFeatureCollection> {
  const { byFips } = await stateOutlines()
  const features: StateFeature[] = []
  let skipped = body.skipped ?? 0
  for (const row of body.features ?? []) {
    const outline = byFips.get(String(row?.properties?._state ?? ''))
    if (!outline) {
      skipped++
      continue
    }
    features.push({ type: 'Feature', geometry: outline, properties: row.properties })
  }
  return {
    id: body.id,
    slug: body.slug,
    geometry: 'state',
    type: 'FeatureCollection',
    features,
    count: features.length,
    skipped,
    bbox: boundsForFeatures(features),
  }
}

export function clearInternalLayerCache(): void {
  valuesCache.clear()
  featuresCache.clear()
  manifestPromise = null
}

// P5-89: the manifest is shared by pages the map is not on any more (P5-86), so
// the map's own logout watcher is no longer what empties it. Nothing internal —
// not a layer name — may outlive the session.
registerLogoutHook(clearInternalLayerCache)

// ---- "Show on map" (P5-77) -------------------------------------------------

/** The "Show on map" link for an internal layer: a layer drawn from its own
 *  features — points or lines — opens on them, a county layer on the national
 *  view. One helper so every surface — entry page, layers index, search,
 *  embed card — links alike. */
export function mapHrefForInternalLayer(entry: Pick<InternalLayerManifestEntry, 'id' | 'geometry' | 'bbox'>): string {
  return entry.geometry !== 'county' && entry.bbox ? mapUrlForLayerBounds(entry.id, entry.bbox) : mapUrlForLayers([entry.id])
}

/** The manifest, fetched once and shared by every surface that needs it — the
 *  layers index, the palette, the entry page, the map. Dropped with the rest of
 *  the cache on logout; a failed fetch is evicted so the next ask retries.
 *
 *  P5-89: call this, never `fetchInternalLayerManifest`, unless you have a
 *  reason to force a fresh read. */
export function sharedManifest(): Promise<InternalLayerManifestEntry[]> {
  if (manifestPromise) return manifestPromise
  const promise = fetchInternalLayerManifest()
  manifestPromise = promise
  promise.catch(() => {
    if (manifestPromise === promise) manifestPromise = null
  })
  return promise
}

/** The same link when only the layer id is in hand. Falls back to the plain
 *  link whenever the manifest cannot say otherwise — logged out, a layer that
 *  is not in the manifest, or a request that failed. */
export async function mapHrefForInternalLayerId(layerId: string): Promise<string> {
  try {
    const entry = (await sharedManifest()).find(l => l.id === layerId)
    if (entry) return mapHrefForInternalLayer(entry)
  } catch {
    /* the plain link still opens the layer */
  }
  return mapUrlForLayers([layerId])
}

function formatterFor(dataType: DataType, unit: string): LayerDefinition['formatValue'] {
  return (v) => {
    if (v == null || v === '') return '?'
    const n = typeof v === 'string' ? parseFloat(v) : v
    if (typeof n !== 'number' || isNaN(n)) return '?'
    switch (dataType) {
      case 'percentage':
        return `${n.toFixed(1)}%`
      case 'currency':
        return `$${Math.round(n).toLocaleString()}`
      case 'count':
        return Math.round(n).toLocaleString()
      case 'years':
        return `${n.toFixed(1)} yrs`
      default: {
        const text = Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1)
        return unit ? `${text} ${unit}` : text
      }
    }
  }
}

/** Legend gradient: higher_better runs pale → BLO green; lower_better runs
 *  green → red, matching the public equity layers' convention. */
function gradientFor(direction: Direction): LayerDefinition['gradient'] {
  return direction === 'lower_better'
    ? { css: 'linear-gradient(to right, rgb(100, 200, 100), rgb(200, 0, 0))', lowLabel: 'Lower', highLabel: 'Higher' }
    : { css: 'linear-gradient(to right, rgb(230, 230, 230), rgb(31, 122, 46))', lowLabel: 'Lower', highLabel: 'Higher' }
}

/** Manifest entry → registry definition. `range` may be null until the
 *  values arrive (the server computes one from the data); scoring needs a
 *  real range, so callers patch it in via `applyLayerRange`. */
export function toLayerDefinition(entry: InternalLayerManifestEntry): LayerDefinition {
  return {
    id: entry.id,
    name: entry.name,
    category: 'internal',
    dataType: entry.dataType,
    direction: entry.direction,
    unit: entry.unit,
    range: entry.range ?? { min: 0, max: 1 },
    description: entry.description,
    source: entry.source || 'Internal library',
    year: entry.year,
    // P7-10: the dates travel to the registry so the LEGEND can say when the
    // layer is from. `updatedAt` deliberately does NOT travel, as it never
    // has: it says when the bytes last moved in our storage, so a re-push of a
    // 2019 file would make the legend read 2026.
    dates: entry.dates ?? {},
    dataPath: '',
    dataKey: entry.slug,
    gradient: gradientFor(entry.direction),
    formatValue: formatterFor(entry.dataType, entry.unit),
    color: '#37b34a',
  }
}

/**
 * Who asked for which internal definitions (P6-10).
 *
 * `LAYER_REGISTRY` is one module object, and since the chat pane landed there
 * can be more than one map in a page — each registering the manifest for
 * itself. Registration is therefore held per owner: a definition lives in the
 * registry while at least one owner holds it, and the last one to let go is
 * what removes it. One map unmounting can no longer deregister the layers
 * another is still scoring against.
 *
 * The default owner keeps the single-caller behaviour (register replaces,
 * unregister clears) for callers that never name themselves.
 */
const DEFAULT_OWNER = 'default'
const registrations = new Map<string, Set<string>>()

/** Drop `owner`'s claim, deleting every id `keep` does not name and no other
 *  owner still holds. */
function releaseInternalLayers(owner: string, keep: ReadonlySet<string>): void {
  const held = registrations.get(owner)
  registrations.delete(owner)
  if (!held) return
  for (const id of held) {
    if (keep.has(id)) continue
    let heldElsewhere = false
    for (const other of registrations.values()) {
      if (other.has(id)) {
        heldElsewhere = true
        break
      }
    }
    if (!heldElsewhere) delete LAYER_REGISTRY[id]
  }
}

/** Register (or re-register) manifest entries into the live registry. */
export function registerInternalLayers(
  entries: InternalLayerManifestEntry[],
  owner: string = DEFAULT_OWNER,
): LayerDefinition[] {
  const defs = entries.filter(e => e.geometry === 'county').map(toLayerDefinition)
  const ids = new Set(defs.map(d => d.id))
  releaseInternalLayers(owner, ids)
  if (ids.size > 0) registrations.set(owner, ids)
  for (const def of defs) LAYER_REGISTRY[def.id] = def
  return defs
}

/** Let go of one owner's definitions — on the last logout the public registry
 *  is byte-identical to the public build's again. */
export function unregisterInternalLayers(owner: string = DEFAULT_OWNER): void {
  releaseInternalLayers(owner, EMPTY_IDS)
  // Belt and braces for the single-owner case: anything internal left in the
  // registry that nobody claims (an older register call, a stale entry) goes
  // too, so a logout cannot leave an internal id behind for the public map.
  if (owner === DEFAULT_OWNER && registrations.size === 0) {
    for (const id of Object.keys(LAYER_REGISTRY)) {
      if (isInternalLayerId(id)) delete LAYER_REGISTRY[id]
    }
  }
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

/** Once values arrive with a data-derived range, let scoring normalise against it. */
export function applyLayerRange(id: string, range: { min: number; max: number } | null): void {
  const def = LAYER_REGISTRY[id]
  if (def && range && range.max > range.min) def.range = range
}

/** Choropleth color for a registry layer from its range + direction —
 *  the generic counterpart of the per-category color functions in Map.vue.
 *  Curved like the public layers (pow 0.8) so mid-values read as mid-tones. */
export function colorForRegistryValue(def: LayerDefinition, value: number | null | undefined): [number, number, number, number] {
  if (value == null || !Number.isFinite(value)) return [0, 0, 0, 0]
  const { min, max } = def.range
  const span = max - min
  const normalized = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0
  const curved = Math.pow(normalized, 0.8)
  if (def.direction === 'lower_better') {
    return [Math.round(curved * 220), Math.round((1 - curved) * 200), 0, 0.85]
  }
  // pale grey → BLO deep green
  const r = Math.round(230 + (31 - 230) * curved)
  const g = Math.round(230 + (122 - 230) * curved)
  const b = Math.round(230 + (46 - 230) * curved)
  return [r, g, b, 0.85]
}
