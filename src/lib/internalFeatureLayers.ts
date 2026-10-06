/**
 * Internal feature layers on the map — points (P5-24), lines (P7-3) and
 * states (P7-9).
 *
 * Pure helpers around a minimal map interface so the source/layer plumbing and
 * the popup builder are unit testable without Mapbox. Sources and layers are
 * namespaced by the internal layer id (`internal-<slug>-…`) so they never
 * collide with public map ids.
 *
 * A point, a line and a state differ in exactly three places — the paint, what
 * counts as the feature's position, and how much of the popup is prose — and
 * everything else here is shared. The three geometries deliberately do not get
 * three modules.
 */
import { isHttpUrl } from './libraryData'
import type { MapBounds } from './mapDeepLinks'
import type { InternalFeatureLayer, InternalFeatureCollection, InternalFeature, FeatureGeometry } from './internalLayers'

export const POINT_DEFAULT_COLOR = '#ff6b1c'
export const CLUSTER_RADIUS = 45
export const CLUSTER_MAX_ZOOM = 12

/** Stroke width a line layer takes when its block names none. */
export const LINE_DEFAULT_WIDTH = 2
/** How much wider the hovered line draws, so which one you have is visible. */
export const LINE_HOVER_EXTRA = 3
/** The width of the invisible layer that catches the click. A 2 px line is
 *  under a finger's accuracy and nearly under a mouse's, so every line layer
 *  carries a wide transparent twin that hit-testing actually hits. */
export const LINE_HIT_WIDTH = 14

/** A state layer is a WASH, not a block of colour: fifty opaque states would
 *  hide the basemap and any choropleth under them, and the thing a reader came
 *  for is the popup. Hover lifts it, which is the only cue a 300-mile shape
 *  can give that it is the one under the pointer. */
export const STATE_FILL_OPACITY = 0.18
export const STATE_HOVER_OPACITY = 0.38
/** The outline carries the colour at full strength — it is what makes the
 *  wash read as a state rather than as a stain on the map. */
export const STATE_OUTLINE_WIDTH = 1.2
export const STATE_HOVER_OUTLINE_WIDTH = 2.5

export function featureSourceId(layerId: string): string {
  return `${layerId}-src`
}

export function pointMapLayerIds(layerId: string): { clusters: string; clusterCount: string; points: string } {
  return { clusters: `${layerId}-clusters`, clusterCount: `${layerId}-cluster-count`, points: `${layerId}-points` }
}

export function lineMapLayerIds(layerId: string): { line: string; hit: string } {
  return { line: `${layerId}-line`, hit: `${layerId}-line-hit` }
}

/** A state layer's two: the wash that is also the hit target, and the outline
 *  over it. No invisible twin — unlike a 2 px stroke, a state is impossible to
 *  miss with a pointer. */
export function stateMapLayerIds(layerId: string): { fill: string; outline: string } {
  return { fill: `${layerId}-fill`, outline: `${layerId}-outline` }
}

/**
 * Every map layer id a geometry uses, the clickable one first — which is also
 * the list the canvas hit-tests before deciding a click was on the county
 * underneath.
 *
 * P7-9: a state's fill is in here, so while a state layer is on a click reads
 * the state rather than the county under it. That is P7-3's rule with no
 * special case, and it is a bigger deal for a shape that covers the whole map
 * than for a corridor that covers one per cent of it: the layer is a mode, and
 * the same checkbox leaves it.
 */
export function featureMapLayerIds(layerId: string, geometry: FeatureGeometry): string[] {
  if (geometry === 'line') {
    const ids = lineMapLayerIds(layerId)
    return [ids.hit, ids.line]
  }
  if (geometry === 'state') {
    const ids = stateMapLayerIds(layerId)
    return [ids.fill, ids.outline]
  }
  const ids = pointMapLayerIds(layerId)
  return [ids.points, ids.clusters, ids.clusterCount]
}

/**
 * The same ids **bottom to top**, which is not the same order: a point layer's
 * clickable circles are drawn last so they sit over their own clusters, and a
 * line's transparent hit twin is drawn first so the visible stroke sits over
 * it. Only `orderFeatureLayers` needs this, and it needs it to be right.
 */
export function featureDrawOrder(layerId: string, geometry: FeatureGeometry): string[] {
  if (geometry === 'line') {
    const ids = lineMapLayerIds(layerId)
    return [ids.hit, ids.line]
  }
  if (geometry === 'state') {
    const ids = stateMapLayerIds(layerId)
    return [ids.fill, ids.outline]
  }
  const ids = pointMapLayerIds(layerId)
  return [ids.clusters, ids.clusterCount, ids.points]
}

/** Bottom to top: state washes, then lines, then points. */
const GEOMETRY_DEPTH: Record<FeatureGeometry, number> = { state: 0, line: 1, point: 2 }

/**
 * Stack the active overlays in that order (P7-9).
 *
 * Mapbox appends, so without this the last layer switched on sits on top —
 * and a fifty-state wash switched on after a transmission layer would cover
 * the corridors it is context for, and take their clicks. Called after every
 * add, over every overlay currently on the map, so the stack is a function of
 * which layers are on rather than of the order somebody ticked them.
 */
export function orderFeatureLayers(map: FeatureMapLike, layers: { id: string; geometry: FeatureGeometry }[]): void {
  const stacked = [...layers].sort((a, b) => GEOMETRY_DEPTH[a.geometry] - GEOMETRY_DEPTH[b.geometry])
  for (const layer of stacked) {
    for (const id of featureDrawOrder(layer.id, layer.geometry)) {
      if (map.getLayer(id)) map.moveLayer(id)
    }
  }
}

/** The same, for a set of layers — what the canvas asks Mapbox about before
 *  deciding a click was on the county underneath. */
export function allFeatureMapLayerIds(layers: { id: string; geometry: FeatureGeometry }[]): string[] {
  return layers.flatMap(l => featureMapLayerIds(l.id, l.geometry))
}

// --- geometry ----------------------------------------------------------------

/** Every `[lng, lat]` of a feature that is on the earth. */
function verticesOf(feature: InternalFeature): [number, number][] {
  const geometry = feature?.geometry
  if (!geometry) return []
  const ok = (v: unknown): v is [number, number] => {
    if (!Array.isArray(v)) return false
    const [lng, lat] = v as number[]
    return Number.isFinite(lng) && Number.isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
  }
  if (geometry.type === 'Point') return ok(geometry.coordinates) ? [geometry.coordinates] : []
  if (geometry.type === 'LineString') return (geometry.coordinates ?? []).filter(ok)
  if (geometry.type === 'MultiLineString') return (geometry.coordinates ?? []).flatMap(part => (part ?? []).filter(ok))
  // A state's outline (P7-9). Every ring of every part, which is what both
  // the anchor rule and the extent want.
  if (geometry.type === 'Polygon') return (geometry.coordinates ?? []).flatMap(ring => (ring ?? []).filter(ok))
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates ?? []).flatMap(part => (part ?? []).flatMap(ring => (ring ?? []).filter(ok)))
  }
  return []
}

/**
 * The one `[lng, lat]` that stands for a feature — where its popup opens and
 * where the map centres when something asks to see it.
 *
 * A point has one. A line does not, so this takes the **middle vertex of its
 * path**: always a coordinate the line actually passes through, unlike the
 * centre of its bounding box, which for an L-shaped or diagonal corridor can
 * sit miles off the wire.
 *
 * P7-9: a state's outline does not have one either, and the same rule holds
 * for the same reason — a vertex on the boundary is always on the state, and a
 * box centre is not. Michigan's is in Lake Michigan and Florida's is in the
 * Gulf. It is only ever a fallback: a state's popup opens where you clicked,
 * and "show me this state" frames the outline.
 */
export function anchorOfFeature(feature: InternalFeature): [number, number] | null {
  const vertices = verticesOf(feature)
  if (vertices.length === 0) return null
  return vertices[Math.floor(vertices.length / 2)]
}

/** One feature's own extent — what framing a single line means. A point's is
 *  a degenerate box at its coordinate. */
export function boundsOfFeature(feature: InternalFeature): MapBounds | null {
  return boundsForVertices(verticesOf(feature))
}

/**
 * The extent of a layer's features, `[minLng, minLat, maxLng, maxLat]`
 * (P5-74, lines in P7-3). Computed here, on the client, from the GeoJSON the
 * caller already holds — that is what lets a "Show on map" link carry
 * `?fit=bbox:…` so a Memphis layer opens on Memphis. null when nothing has
 * usable coordinates, which the callers read as "keep the national view".
 */
export function boundsForFeatures(features: InternalFeature[]): MapBounds | null {
  const vertices: [number, number][] = []
  for (const feature of features ?? []) {
    // One at a time, never spread: a dense line layer is hundreds of
    // thousands of vertices and `push(...)` passes each as an argument.
    for (const vertex of verticesOf(feature)) vertices.push(vertex)
  }
  return boundsForVertices(vertices)
}

function boundsForVertices(vertices: [number, number][]): MapBounds | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const [lng, lat] of vertices) {
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  if (minLng === Infinity) return null
  return [minLng, minLat, maxLng, maxLat]
}

// --- the map ------------------------------------------------------------------

/** The subset of a map's API these helpers touch — mapboxgl.Map satisfies it.
 *  Source/layer params are `any` on purpose: Mapbox's specification unions
 *  aren't assignable to index-signature types, and the fake map in tests
 *  only records what it was given. */
export interface FeatureMapLike {
  getSource(id: string): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addSource(id: string, source: any): unknown
  getLayer(id: string): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addLayer(layer: any): unknown
  /** Move a layer to the top of the stack — `orderFeatureLayers` only. */
  moveLayer(id: string): unknown
  removeLayer(id: string): unknown
  removeSource(id: string): unknown
}

/** Put a layer's features on the map, painted for their geometry. Idempotent. */
export function addFeatureLayerToMap(
  map: FeatureMapLike,
  layer: InternalFeatureLayer,
  collection: InternalFeatureCollection,
): void {
  if (layer.geometry === 'line') addLineLayers(map, layer, collection)
  else if (layer.geometry === 'state') addStateLayers(map, layer, collection)
  else addPointLayers(map, layer, collection)
}

/** A clustered GeoJSON source + three layers (clusters, counts, points). */
function addPointLayers(map: FeatureMapLike, layer: InternalFeatureLayer, collection: InternalFeatureCollection): void {
  const source = featureSourceId(layer.id)
  const ids = pointMapLayerIds(layer.id)
  const color = layer.color || POINT_DEFAULT_COLOR
  if (!map.getSource(source)) {
    map.addSource(source, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: collection.features },
      cluster: true,
      clusterRadius: CLUSTER_RADIUS,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
    })
  }
  if (!map.getLayer(ids.clusters)) {
    map.addLayer({
      id: ids.clusters,
      type: 'circle',
      source,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': color,
        'circle-opacity': 0.85,
        'circle-radius': ['step', ['get', 'point_count'], 14, 10, 18, 50, 24],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    })
  }
  if (!map.getLayer(ids.clusterCount)) {
    map.addLayer({
      id: ids.clusterCount,
      type: 'symbol',
      source,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-size': 12,
        'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#ffffff' },
    })
  }
  if (!map.getLayer(ids.points)) {
    map.addLayer({
      id: ids.points,
      type: 'circle',
      source,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': color,
        'circle-opacity': 0.9,
        'circle-radius': 6,
        'circle-stroke-width': 1.5,
        'circle-stroke-color': '#ffffff',
      },
    })
  }
}

/**
 * An unclustered GeoJSON source + two line layers: the wide transparent one
 * that catches the pointer, then the visible stroke on top of it.
 *
 * `generateId` is what gives each feature the id `feature-state` needs, which
 * is how the hovered line widens — with several corridors crossing, the
 * highlight is the only thing that says which one a click would take.
 * Clustering is meaningless for a line and is deliberately off.
 */
function addLineLayers(map: FeatureMapLike, layer: InternalFeatureLayer, collection: InternalFeatureCollection): void {
  const source = featureSourceId(layer.id)
  const ids = lineMapLayerIds(layer.id)
  const color = layer.color || POINT_DEFAULT_COLOR
  const width = layer.width ?? LINE_DEFAULT_WIDTH
  if (!map.getSource(source)) {
    map.addSource(source, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: collection.features },
      generateId: true,
    })
  }
  const layout = { 'line-cap': 'round', 'line-join': 'round' }
  if (!map.getLayer(ids.hit)) {
    map.addLayer({
      id: ids.hit,
      type: 'line',
      source,
      layout,
      paint: { 'line-color': color, 'line-opacity': 0, 'line-width': LINE_HIT_WIDTH },
    })
  }
  if (!map.getLayer(ids.line)) {
    map.addLayer({
      id: ids.line,
      type: 'line',
      source,
      layout,
      paint: {
        'line-color': color,
        'line-opacity': 0.9,
        'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], width + LINE_HOVER_EXTRA, width],
      },
    })
  }
}

/**
 * A state layer (P7-9): one unclustered source, a translucent fill, and the
 * outline that makes it read as a state.
 *
 * `generateId` for the same reason a line needs it — `feature-state` is what
 * lifts the hovered state's wash and thickens its outline in the paint, with
 * no re-render — and matching a click back to its rail row by `feature.id` is
 * exact, where a state has no coordinate to match on at all.
 *
 * The fill is also the hit target. A line needs a wide invisible twin because
 * a 2 px stroke is under a finger's accuracy; a state is the opposite problem.
 */
function addStateLayers(map: FeatureMapLike, layer: InternalFeatureLayer, collection: InternalFeatureCollection): void {
  const source = featureSourceId(layer.id)
  const ids = stateMapLayerIds(layer.id)
  const color = layer.color || POINT_DEFAULT_COLOR
  const hovered = ['boolean', ['feature-state', 'hover'], false]
  if (!map.getSource(source)) {
    map.addSource(source, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: collection.features },
      generateId: true,
    })
  }
  if (!map.getLayer(ids.fill)) {
    map.addLayer({
      id: ids.fill,
      type: 'fill',
      source,
      paint: {
        'fill-color': color,
        'fill-opacity': ['case', hovered, STATE_HOVER_OPACITY, STATE_FILL_OPACITY],
        // Off because the washes are edge-to-edge: Mapbox's fill antialiasing
        // draws a 1 px line on every polygon edge, which on a translucent
        // wash reads as a seam along every shared state line.
        'fill-antialias': false,
      },
    })
  }
  if (!map.getLayer(ids.outline)) {
    map.addLayer({
      id: ids.outline,
      type: 'line',
      source,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-opacity': 0.9,
        'line-width': ['case', hovered, STATE_HOVER_OUTLINE_WIDTH, STATE_OUTLINE_WIDTH],
      },
    })
  }
}

/** Remove the layers then the source; tolerant of partial state, and of not
 *  being told which geometry the layer was — a toggle-off should never need
 *  the manifest still to be in hand. */
export function removeFeatureLayerFromMap(map: FeatureMapLike, layerId: string): void {
  const point = pointMapLayerIds(layerId)
  const line = lineMapLayerIds(layerId)
  const state = stateMapLayerIds(layerId)
  for (const id of [point.points, point.clusterCount, point.clusters, line.line, line.hit, state.outline, state.fill]) {
    if (map.getLayer(id)) map.removeLayer(id)
  }
  const source = featureSourceId(layerId)
  if (map.getSource(source)) map.removeSource(source)
}

/**
 * Popup content for one feature: title = label, then the popup fields that
 * have a value, then — for a state — the prose. Built with
 * createElement/textContent only, because property values are untrusted
 * dataset cells. http(s) URLs become links.
 *
 * The layer is passed whole rather than as three positional fields (P7-9):
 * `popupFields`, `detailFields` and `name` all come off the same object at
 * every call site, and adding a fourth positional string to a list of four
 * was how this would have started being called with the arguments in the
 * wrong order.
 *
 * **`detailFields` is why a state layer exists.** Spec §B asks for *"a pop-up
 * about the specific state requirements + permitting processes"* — a permitting
 * process is paragraphs, and a paragraph in the `<dd>` of a two-column list
 * 300 px wide is unreadable. These render under the list as headed prose, with
 * blank lines kept as paragraph breaks, in a block that scrolls on its own so
 * a long answer does not push the record link off the map.
 */
export function buildFeaturePopup(
  properties: Record<string, unknown>,
  layer: { name: string; popupFields: string[]; detailFields?: string[] },
  recordHref?: string,
): HTMLElement {
  const { name: layerName, popupFields } = layer
  const detailFields = layer.detailFields ?? []
  const root = document.createElement('div')
  root.className = 'internal-point-popup'
  const title = document.createElement('strong')
  title.className = 'popup-title'
  title.textContent = String(properties._label ?? '') || layerName
  root.appendChild(title)

  const list = document.createElement('dl')
  list.className = 'popup-fields'
  let shown = 0
  for (const field of popupFields) {
    const raw = properties[field]
    const value = raw == null ? '' : String(raw).trim()
    if (!value) continue
    const dt = document.createElement('dt')
    dt.textContent = field
    const dd = document.createElement('dd')
    if (isHttpUrl(value)) {
      const a = document.createElement('a')
      a.href = value
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = value
      dd.appendChild(a)
    } else {
      dd.textContent = value
    }
    list.appendChild(dt)
    list.appendChild(dd)
    shown++
  }
  if (shown > 0) root.appendChild(list)

  const prose = document.createElement('div')
  prose.className = 'popup-detail'
  let told = 0
  for (const field of detailFields) {
    const raw = properties[field]
    const value = raw == null ? '' : String(raw).trim()
    if (!value) continue
    const heading = document.createElement('h4')
    heading.textContent = field
    prose.appendChild(heading)
    // A blank line is a paragraph break, which is how a CSV cell written by a
    // person spells one. Every other newline is a wrap, not a break.
    for (const para of value.split(/\n\s*\n/)) {
      const text = para.replace(/\s*\n\s*/g, ' ').trim()
      if (!text) continue
      const p = document.createElement('p')
      if (isHttpUrl(text)) {
        const a = document.createElement('a')
        a.href = text
        a.target = '_blank'
        a.rel = 'noopener noreferrer'
        a.textContent = text
        p.appendChild(a)
      } else {
        p.textContent = text
      }
      prose.appendChild(p)
    }
    told++
  }
  if (told > 0) root.appendChild(prose)

  if (recordHref) {
    // In-app link; MapCanvas intercepts clicks on data-internal anchors and
    // routes them without a full reload.
    const record = document.createElement('a')
    record.className = 'popup-record'
    record.href = recordHref
    record.dataset.internal = '1'
    record.textContent = 'Open record →'
    root.appendChild(record)
  }
  const foot = document.createElement('small')
  foot.className = 'popup-layer'
  foot.textContent = layerName
  root.appendChild(foot)
  return root
}
