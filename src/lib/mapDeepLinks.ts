/**
 * Map deep links (P5-36): `/?layers=<id,id>[&focus=<layerId>:<label>]`
 * opens the map with those layers on — public registry ids and internal
 * `internal-<slug>` ids alike — and optionally flies to one point of an
 * internal point layer by its label. Parsed defensively: unknown or
 * malformed ids are dropped, never thrown; internal ids are applied only
 * after login (the map simply ignores them logged out).
 *
 * P5-55 adds `&fit=<geoid,…>`: frame the map on these counties. The map
 * already holds every county polygon (it draws them), so this costs a bounds
 * union and nothing else — which is what lets "Show on map" from a
 * comparison land on the counties instead of on the whole country.
 *
 * P5-74 lets `&fit=` carry a bounding box instead — `bbox:<minLng>,<minLat>,
 * <maxLng>,<maxLat>` — for a layer whose extent is not a set of counties.
 * That is how "Show on map" opens an internal point layer on its own points:
 * a Memphis layer lands on Memphis rather than on the whole country. The
 * `bbox:` prefix keeps the two forms apart, so neither can be read as the
 * other.
 */

export const INTERNAL_PREFIX = 'internal-'
const LAYER_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/
/** Every county GEOID is five digits (state FIPS + county FIPS). */
const GEOID = /^\d{5}$/
/** More layers than anyone toggles by hand; also the bound that keeps a
 *  crafted multi-megabyte `?layers=` from pinning the main thread (P5-19). */
export const MAX_DEEP_LINK_LAYERS = 24
/** The same cap a comparison has (P5-55): more counties than that and the
 *  fitted view is just the country again. */
export const MAX_DEEP_LINK_FIT = 12
/** Marks the bounding-box form of `?fit=` (P5-74). */
export const FIT_BBOX_PREFIX = 'bbox:'

/** `[minLng, minLat, maxLng, maxLat]` — the order mapbox-gl's `fitBounds`
 *  reads, and the order the URL writes. */
export type MapBounds = [number, number, number, number]

/** Read `bbox:<minLng>,<minLat>,<maxLng>,<maxLat>`. Anything that is not four
 *  finite, correctly ordered, on-Earth numbers is dropped, never thrown — a
 *  hand-edited URL must degrade to "leave the viewport alone". */
export function parseFitBounds(raw: string): MapBounds | null {
  if (!raw.startsWith(FIT_BBOX_PREFIX)) return null
  const parts = raw.slice(FIT_BBOX_PREFIX.length).split(',').map(Number)
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return null
  const [minLng, minLat, maxLng, maxLat] = parts
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) return null
  if (minLng > maxLng || minLat > maxLat) return null
  return [minLng, minLat, maxLng, maxLat]
}

export interface MapFocus {
  layerId: string
  label: string
}

export interface MapDeepLink {
  layers: string[]
  focus: MapFocus | null
  /** County GEOIDs to frame the map on (P5-55); empty means "leave the
   *  viewport alone". */
  fit: string[]
  /** The bounding box `?fit=bbox:…` named (P5-74), or null. A link carries
   *  one form or the other; when it somehow carries both, the box wins. */
  bounds: MapBounds | null
}

type QueryValue = string | string[] | null | undefined

function values(v: QueryValue): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return typeof v === 'string' ? [v] : []
}

export function parseMapDeepLink(query: Record<string, QueryValue>): MapDeepLink {
  const seen = new Set<string>()
  for (const chunk of values(query.layers)) {
    for (const id of chunk.split(',')) {
      if (seen.size >= MAX_DEEP_LINK_LAYERS) break
      const trimmed = id.trim()
      if (LAYER_ID.test(trimmed)) seen.add(trimmed)
    }
  }
  const layers = [...seen]
  let focus: MapFocus | null = null
  const raw = values(query.focus)[0]
  if (raw) {
    const colon = raw.indexOf(':')
    const layerId = colon === -1 ? raw : raw.slice(0, colon)
    const label = colon === -1 ? '' : raw.slice(colon + 1).trim()
    if (LAYER_ID.test(layerId) && layerId.startsWith(INTERNAL_PREFIX) && label) {
      focus = { layerId, label }
      if (!layers.includes(layerId)) layers.push(layerId)
    }
  }
  const fit = new Set<string>()
  let bounds: MapBounds | null = null
  for (const chunk of values(query.fit)) {
    const box = parseFitBounds(chunk.trim())
    if (box) {
      bounds ??= box
      continue
    }
    for (const id of chunk.split(',')) {
      if (fit.size >= MAX_DEEP_LINK_FIT) break
      const trimmed = id.trim()
      if (GEOID.test(trimmed)) fit.add(trimmed)
    }
  }
  return { layers, focus, fit: [...fit], bounds }
}

/** The `fit` query value for either form, or '' when there is nothing to
 *  frame. Coordinates are rounded to five decimals — ~1 m, far finer than a
 *  map frame needs, and it keeps the link readable. */
function fitParam(fit: string[] | MapBounds | null | undefined): string {
  if (!fit || fit.length === 0) return ''
  if (typeof fit[0] === 'number') {
    const box = (fit as MapBounds).map(n => Number(n.toFixed(5)))
    const value = `${FIT_BBOX_PREFIX}${box.join(',')}`
    return parseFitBounds(value) ? value : ''
  }
  return (fit as string[]).filter(id => GEOID.test(id)).slice(0, MAX_DEEP_LINK_FIT).join(',')
}

/** Build the map URL for a set of layers (optionally a point to focus, and
 *  optionally the frame to open on — county GEOIDs, or a bounding box). */
export function mapUrlForLayers(layerIds: string[], focus?: MapFocus | null, fit?: string[] | MapBounds | null): string {
  const ids = layerIds.filter(id => LAYER_ID.test(id))
  if (focus && !ids.includes(focus.layerId)) ids.push(focus.layerId)
  const params = new URLSearchParams()
  if (ids.length) params.set('layers', ids.join(','))
  if (focus && focus.label) params.set('focus', `${focus.layerId}:${focus.label}`)
  const frame = fitParam(fit)
  if (frame) params.set('fit', frame)
  const qs = params.toString()
  return qs ? `/?${qs}` : '/'
}

/** The "Show on map" link for a layer that has an extent of its own — an
 *  internal point layer, framed on its points (P5-74). `bounds` comes from
 *  `boundsForFeatures` in lib/internalFeatureLayers, computed on the
 *  client from the GeoJSON the caller already loaded; pass null for a county
 *  layer and the map keeps the national view. */
export function mapUrlForLayerBounds(layerId: string, bounds: MapBounds | null): string {
  return mapUrlForLayers([layerId], null, bounds)
}

export function internalLayerId(slug: string): string {
  return `${INTERNAL_PREFIX}${slug}`
}

/** The record link from a point (popup / rail) into the dataset explorer. */
export function recordUrl(slug: string, label: string): string {
  return `/library/${encodeURIComponent(slug)}?tab=data&q=${encodeURIComponent(label)}`
}
