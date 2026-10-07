/**
 * A `mapbox-gl` stand-in for jsdom (P6-10).
 *
 * The real library needs a WebGL canvas, so until now nothing that touched it
 * could be tested at all: `App.spec.ts` stubs `Map.vue` wholesale and two
 * other specs read the router's source as text rather than importing it,
 * because importing it reaches mapbox-gl. The map core was the one part of the
 * app with no test seam — which is exactly what made the canvas extraction
 * risky.
 *
 * This is that seam. It records what a component asked the map to do —
 * sources, layers, paint and layout properties, filters, the viewport — so a
 * test can assert on the map's state instead of on mapbox-gl's internals.
 *
 * Use it as the module mock:
 *
 *   vi.mock('mapbox-gl', () => mapboxStubModule())
 *   const map = lastStubMap()            // what the component constructed
 *   await map.fire('load')               // run its load handler
 *   expect(map.layers.get('county-choropleth')?.visibility).toBe('visible')
 */

export interface StubLayer {
  id: string
  type: string
  source?: string
  visibility: string
  paint: Record<string, unknown>
  filter?: unknown
}

type Handler = (event: any) => void

/** A `mapboxgl.Map` with its state readable. */
export class StubMap {
  static instances: StubMap[] = []

  options: Record<string, any>
  sources = new Map<string, any>()
  layers = new Map<string, StubLayer>()
  controls: unknown[] = []
  center: { lng: number; lat: number }
  zoom: number
  bounds: [number, number, number, number] | null = null
  /** Every `fitBounds` call, newest last — how a test checks the framing. */
  fits: { bounds: any; options: any }[] = []
  eases: { center: [number, number]; zoom: number }[] = []
  /** Every `jumpTo` call — how a test checks a saved viewport was honoured. */
  jumps: { center: [number, number]; zoom: number }[] = []
  removed = false
  styleLoaded = true
  /** Features `queryRenderedFeatures` should answer with, per layer id. */
  rendered = new Map<string, any[]>()

  private handlers = new Map<string, Handler[]>()
  private layerHandlers = new Map<string, Handler[]>()
  private canvas = { style: { cursor: '' } } as unknown as HTMLCanvasElement

  constructor(options: Record<string, any> = {}) {
    this.options = options
    const center = options.center ?? [-98, 39]
    this.center = { lng: center[0], lat: center[1] }
    this.zoom = options.zoom ?? 4
    StubMap.instances.push(this)
  }

  // --- events ------------------------------------------------------------
  on(event: string, layerOrHandler: string | Handler, maybeHandler?: Handler): this {
    if (typeof layerOrHandler === 'string' && maybeHandler) {
      const key = `${event}:${layerOrHandler}`
      this.layerHandlers.set(key, [...(this.layerHandlers.get(key) ?? []), maybeHandler])
    } else if (typeof layerOrHandler === 'function') {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), layerOrHandler])
    }
    return this
  }

  once(event: string, handler: Handler): this {
    return this.on(event, handler)
  }

  off(): this {
    return this
  }

  /** Fire a map-level event and wait for its handlers (they are async). */
  async fire(event: string, payload: any = {}): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload)
  }

  /** Fire a layer-scoped event (`click`, `mousemove`, …). */
  async fireLayer(event: string, layerId: string, payload: any = {}): Promise<void> {
    for (const handler of this.layerHandlers.get(`${event}:${layerId}`) ?? []) await handler(payload)
  }

  /** Layer-scoped handlers this map holds, for asserting they were attached. */
  layerEvents(): string[] {
    return [...this.layerHandlers.keys()]
  }

  // --- style -------------------------------------------------------------
  isStyleLoaded(): boolean {
    return this.styleLoaded
  }

  getSource(id: string): any {
    return this.sources.get(id)
  }

  addSource(id: string, source: any): void {
    this.sources.set(id, source)
  }

  removeSource(id: string): void {
    this.sources.delete(id)
  }

  getLayer(id: string): StubLayer | undefined {
    return this.layers.get(id)
  }

  addLayer(layer: any): void {
    this.layers.set(layer.id, {
      id: layer.id,
      type: layer.type,
      source: layer.source,
      visibility: layer.layout?.visibility ?? 'visible',
      paint: { ...(layer.paint ?? {}) },
      filter: layer.filter,
    })
  }

  removeLayer(id: string): void {
    this.layers.delete(id)
  }

  /** P7-9: Mapbox moves a layer to the top of the stack when given no
   *  `beforeId`. `layers` is a Map, so delete-then-set reproduces that —
   *  insertion order IS the draw order, and `[...map.layers.keys()]` is
   *  therefore the stack a test can assert. */
  moveLayer(id: string): void {
    const layer = this.layers.get(id)
    if (!layer) return
    this.layers.delete(id)
    this.layers.set(id, layer)
  }

  setPaintProperty(id: string, name: string, value: unknown): void {
    const layer = this.layers.get(id)
    if (layer) layer.paint[name] = value
  }

  /**
   * P9-1b: real Mapbox THROWS here — "Style is not done loading" before the
   * style settles, and "The layer '<id>' does not exist in the map's style"
   * for an unknown id. The stub used to return quietly, so a caller that
   * repainted too early passed every test and threw in the browser. A stub
   * that cannot fail the way the real thing fails lets the bug ship.
   */
  setLayoutProperty(id: string, name: string, value: unknown): void {
    if (!this.styleLoaded) throw new Error('Style is not done loading')
    const layer = this.layers.get(id)
    if (!layer) throw new Error(`The layer '${id}' does not exist in the map's style.`)
    if (name === 'visibility') layer.visibility = String(value)
  }

  setFilter(id: string, filter: unknown): void {
    const layer = this.layers.get(id)
    if (layer) layer.filter = filter
  }

  /** P7-3: feature state, which is how a hovered line widens. Keyed
   *  `<source>:<id>` so a test can read what the canvas highlighted. */
  featureState = new Map<string, Record<string, unknown>>()

  setFeatureState(target: { source: string; id: number | string }, state: Record<string, unknown>): void {
    const key = `${target.source}:${target.id}`
    this.featureState.set(key, { ...(this.featureState.get(key) ?? {}), ...state })
  }

  removeFeatureState(target: { source: string; id: number | string }, key?: string): void {
    const id = `${target.source}:${target.id}`
    if (!key) {
      this.featureState.delete(id)
      return
    }
    const held = this.featureState.get(id)
    if (held) delete held[key]
  }

  // --- viewport ----------------------------------------------------------
  fitBounds(bounds: any, options: any = {}): void {
    this.fits.push({ bounds, options })
    const box: [number, number, number, number] = Array.isArray(bounds)
      ? [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]]
      : [bounds.west, bounds.south, bounds.east, bounds.north]
    this.bounds = box
    this.center = { lng: (box[0] + box[2]) / 2, lat: (box[1] + box[3]) / 2 }
    this.zoom = options.maxZoom ?? this.zoom
  }

  easeTo(options: any): void {
    if (options.center) this.center = { lng: options.center[0], lat: options.center[1] }
    if (options.zoom != null) this.zoom = options.zoom
    this.eases.push({ center: options.center, zoom: options.zoom })
  }

  jumpTo(options: any): void {
    if (options.center) this.center = { lng: options.center[0], lat: options.center[1] }
    if (options.zoom != null) this.zoom = options.zoom
    this.jumps.push({ center: options.center, zoom: options.zoom })
  }

  getZoom(): number {
    return this.zoom
  }

  getCenter(): { lng: number; lat: number } {
    return this.center
  }

  getBounds(): any {
    const box = this.bounds ?? [-125, 24, -66, 50]
    return {
      getWest: () => box[0],
      getSouth: () => box[1],
      getEast: () => box[2],
      getNorth: () => box[3],
    }
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas
  }

  getContainer(): HTMLElement {
    return this.options.container
  }

  queryRenderedFeatures(_point: unknown, options: any = {}): any[] {
    const ids: string[] = options.layers ?? [...this.rendered.keys()]
    return ids.flatMap(id => this.rendered.get(id) ?? [])
  }

  addControl(control: unknown): this {
    this.controls.push(control)
    return this
  }

  remove(): void {
    this.removed = true
  }
}

/** A `mapboxgl.Popup`: what it was told to show, and whether it is up. */
export class StubPopup {
  static instances: StubPopup[] = []
  lngLat: [number, number] | null = null
  html = ''
  dom: HTMLElement | null = null
  open = false

  constructor(public options: Record<string, unknown> = {}) {
    StubPopup.instances.push(this)
  }

  setLngLat(lngLat: [number, number]): this {
    this.lngLat = lngLat
    return this
  }

  setHTML(html: string): this {
    this.html = html
    return this
  }

  setDOMContent(el: HTMLElement): this {
    this.dom = el
    return this
  }

  addTo(): this {
    this.open = true
    return this
  }

  remove(): this {
    this.open = false
    return this
  }
}

class StubMarker {
  setLngLat(): this { return this }
  addTo(): this { return this }
  remove(): this { return this }
  getElement(): HTMLElement { return document.createElement('div') }
}

/** The real bounds union — `zoomToGeoId` and `fitToGeoIds` depend on it. */
class StubLngLatBounds {
  west = Infinity
  south = Infinity
  east = -Infinity
  north = -Infinity

  extend(coord: [number, number]): this {
    this.west = Math.min(this.west, coord[0])
    this.east = Math.max(this.east, coord[0])
    this.south = Math.min(this.south, coord[1])
    this.north = Math.max(this.north, coord[1])
    return this
  }
}

/** The module mock: `vi.mock('mapbox-gl', () => mapboxStubModule())`. */
export function mapboxStubModule() {
  const mapboxgl = {
    accessToken: '',
    Map: StubMap,
    Popup: StubPopup,
    Marker: StubMarker,
    NavigationControl: class {},
    LngLatBounds: StubLngLatBounds,
  }
  return { default: mapboxgl, ...mapboxgl }
}

/** The map the component under test just built. */
export function lastStubMap(): StubMap {
  const map = StubMap.instances[StubMap.instances.length - 1]
  if (!map) throw new Error('no map was constructed')
  return map
}

/** Forget every recorded map and popup — call in `beforeEach`. */
export function resetMapboxStub(): void {
  StubMap.instances = []
  StubPopup.instances = []
}
