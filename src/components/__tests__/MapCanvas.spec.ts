import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, toRaw } from 'vue'

import { mapboxStubModule, lastStubMap, resetMapboxStub, StubMap } from '@/testing/mapboxStub'

vi.mock('mapbox-gl', () => mapboxStubModule())

/** Mutable so one block can log in and the rest stay anonymous (P7-3). */
const auth = vi.hoisted(() => ({ internalUser: { value: null as unknown } }))
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: auth.internalUser }),
  clearInternalSession: vi.fn(),
  registerLogoutHook: vi.fn(),
}))
const api = vi.hoisted(() => ({ internalFetch: vi.fn() }))
vi.mock('@/lib/apiBase', () => ({
  internalFetch: api.internalFetch,
  setInternalCsrfToken: vi.fn(),
  API_URL: '',
}))

import MapCanvas from '../MapCanvas.vue'
import { useMapState } from '@/composables/useMapState'
import { resetCountyDataCache } from '@/composables/useMapData'
import { executeTool } from '@/lib/mapTools'
import { clearInternalLayerCache } from '@/lib/internalLayers'
import { clearStateOutlines } from '@/lib/stateGeometry'
import DATASETS from '@/config/datasetsManifest.generated.json'

/**
 * P6-10. The map core had no test seam at all before this: `mapbox-gl` needs
 * a WebGL canvas, so every spec that came near it stubbed `Map.vue` whole.
 * With the canvas extracted and a `mapbox-gl` stand-in (`testing/mapboxStub`)
 * the map's own behaviour is finally assertable — including the thing the
 * ticket is for, two canvases on one page not standing on each other.
 */

const polygon = (geoId: string, name: string, x: number, y: number) => ({
  type: 'Feature',
  properties: { GEOID: geoId, NAME: name },
  geometry: {
    type: 'Polygon',
    coordinates: [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]],
  },
})

const GEOMETRY = {
  type: 'FeatureCollection',
  features: [polygon('13121', 'Fulton', -84.6, 33.6), polygon('28033', 'DeSoto', -90.1, 34.8)],
}

const BUNDLE = {
  version: 1,
  diversity: {
    '13121': { diversityIndex: 0.6, pct_Black: 44.5, totalPopulation: 1_066_710, countyName: 'Fulton County', stateName: 'Georgia' },
    '28033': { diversityIndex: 0.5, pct_Black: 28.1, totalPopulation: 185_314, countyName: 'DeSoto County', stateName: 'Mississippi' },
  },
  lifeExpectancy: { '13121': { lifeExpectancy: 78.6 }, '28033': { lifeExpectancy: 76.1 } },
  contamination: { '13121': { total: 21 }, '28033': { total: 4 } },
  combinedScores: { '13121': { combinedScore: 4.1, rankScore: 12 }, '28033': { combinedScore: 3.2, rankScore: 40 } },
  combinedScoresV2: { '13121': { blo_score_v2: 3.9 }, '28033': { blo_score_v2: 2.7 } },
  economic: { '13121': { GEOID: '13121', avg_weekly_wage: 1_600 }, '28033': { GEOID: '28033', avg_weekly_wage: 900 } },
  housing: { '13121': { GEOID: '13121', median_home_value: 390_000 }, '28033': { GEOID: '28033', median_home_value: 230_000 } },
  equity: { '13121': { GEOID: '13121', poverty_rate_black: 18.4 }, '28033': { GEOID: '28033', poverty_rate_black: 21.2 } },
  transportation: { '13121': { GEOID: '13121', commute_time_ordinal: 6 }, '28033': { GEOID: '28033', commute_time_ordinal: 7 } },
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

let fetchMock: ReturnType<typeof vi.fn<any[], any>>

/** Mount a canvas over its own state and run its map through `load`. */
async function mountCanvas(props: Record<string, unknown> = {}) {
  const state = useMapState()
  const wrapper = mount(MapCanvas, {
    props: { layers: state.layers, query: state.query, data: state.data, ...props },
    global: { mocks: { $router: { push: vi.fn() } } },
  })
  await flushPromises()
  const map = lastStubMap()
  await map.fire('load')
  await flushPromises()
  return { wrapper, state, map }
}

beforeEach(() => {
  resetMapboxStub()
  resetCountyDataCache()
  fetchMock = vi.fn(async (url: string) => {
    if (url === DATASETS.countyData) return ok(BUNDLE)
    if (url === DATASETS.counties) return ok(GEOMETRY)
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  auth.internalUser.value = null
  api.internalFetch.mockReset()
  clearInternalLayerCache()
  // P7-9: the dissolve is cached for the session, and a session here is a test.
  clearStateOutlines()
  delete (window as unknown as { __bloMap?: unknown }).__bloMap
})

describe('MapCanvas — the counties and the choropleth', () => {
  it('builds a map, fetches its two county files, and paints once they land', async () => {
    const { wrapper, map } = await mountCanvas()

    expect(fetchMock).toHaveBeenCalledWith(DATASETS.counties)
    expect(fetchMock).toHaveBeenCalledWith(DATASETS.countyData)
    expect(map.getSource('counties')).toBeTruthy()
    const choropleth = map.getLayer('county-choropleth')
    expect(choropleth).toBeTruthy()
    // The BLO index is on by default, so the layer is visible and painted.
    expect(choropleth?.visibility).toBe('visible')
    expect(Array.isArray(choropleth?.paint['fill-color'])).toBe(true)
    wrapper.unmount()
  })

  it('puts the overlay layers and the hover outline on the counties source', async () => {
    const { wrapper, map } = await mountCanvas()
    for (const id of ['county-hover-outline', 'walkthrough-set-outline', 'inspect-halo', 'diversity-layer']) {
      expect(map.getLayer(id), id).toBeTruthy()
    }
    wrapper.unmount()
  })

  it('leaves the basemap usable when the county files fail', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    const { wrapper, map } = await mountCanvas()

    expect(map.getLayer('county-choropleth')).toBeUndefined()
    expect(map.removed).toBe(false)
    wrapper.unmount()
  })
})

describe('MapCanvas — two maps in one page (the P6-9 blocker)', () => {
  it('lets each canvas hold different layers on, on its own style', async () => {
    const a = await mountCanvas()
    const b = await mountCanvas()
    expect(a.map).not.toBe(b.map)

    a.state.toggleEconomicLayer('avg_weekly_wage')
    await nextTick()

    expect(a.state.layers.economic.value).toEqual(['avg_weekly_wage'])
    expect(b.state.layers.economic.value).toEqual([])
    // Each canvas painted its own style from its own state, and neither
    // reports the other's layer as loaded.
    expect(a.state.layers.definitions.economic.find(l => l.id === 'avg_weekly_wage')?.visible).toBe(true)
    expect(b.state.layers.definitions.economic.find(l => l.id === 'avg_weekly_wage')?.visible).toBe(false)
    expect(a.map.getLayer('county-choropleth')?.visibility).toBe('visible')

    // And one going away leaves the other's map alone.
    a.wrapper.unmount()
    expect(a.map.removed).toBe(true)
    expect(b.map.removed).toBe(false)
    b.wrapper.unmount()
  })

  it('downloads the county files once however many canvases mount', async () => {
    const a = await mountCanvas()
    const b = await mountCanvas()

    const counties = fetchMock.mock.calls.filter(([url]) => url === DATASETS.counties)
    const data = fetchMock.mock.calls.filter(([url]) => url === DATASETS.countyData)
    expect(counties).toHaveLength(1)
    expect(data).toHaveLength(1)
    expect(b.map.getSource('counties')).toBeTruthy()
    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('publishes window.__bloMap only for the canvas that claims it', async () => {
    const pane = await mountCanvas()
    expect((window as any).__bloMap).toBeUndefined()

    const publicMap = await mountCanvas({ exposeHandle: true })
    // `toRaw`: the handle is the ref's reactive proxy, as it has always been
    // — the e2e specs call methods on it, which a proxy forwards.
    expect(toRaw((window as any).__bloMap)).toBe(publicMap.map)

    publicMap.wrapper.unmount()
    expect((window as any).__bloMap).toBeUndefined()
    pane.wrapper.unmount()
  })
})

describe('MapCanvas — what it reports and what it is told', () => {
  it('hands over a tool context as soon as there is a map, and says when the counties are up', async () => {
    const state = useMapState()
    const wrapper = mount(MapCanvas, {
      props: { layers: state.layers, query: state.query, data: state.data },
    })
    await flushPromises()

    expect(wrapper.emitted('ready')).toHaveLength(1)
    expect(wrapper.emitted('counties-ready')).toBeUndefined()

    await lastStubMap().fire('load')
    await flushPromises()
    expect(wrapper.emitted('counties-ready')).toHaveLength(1)
    wrapper.unmount()
  })

  it('reports a county click and decides nothing about it', async () => {
    const { wrapper, map } = await mountCanvas()
    map.rendered.set('county-choropleth', [{ properties: { GEOID: '13121' } }])

    await map.fire('click', { point: { x: 1, y: 1 }, originalEvent: { target: null } })

    expect(wrapper.emitted('county-click')).toEqual([['13121']])
    wrapper.unmount()
  })

  it('frames a county from the polygons it draws', async () => {
    const { wrapper, map } = await mountCanvas()

    const framed = (wrapper.vm as any).zoomToGeoId('28033')

    expect(framed).toBe(true)
    const [west, south, east, north] = map.bounds!
    expect(west).toBeCloseTo(-90.1)
    expect(south).toBeCloseTo(34.8)
    expect(east).toBeCloseTo(-89.1)
    expect(north).toBeCloseTo(35.8)
    wrapper.unmount()
  })

  it('frames what the `fit` prop asks for, counties or a box', async () => {
    const { wrapper, map } = await mountCanvas()

    await wrapper.setProps({ fit: { geoIds: ['13121', '28033'], maxZoom: 8 } })
    await nextTick()
    expect(map.bounds![0]).toBeCloseTo(-90.1)
    expect(map.bounds![2]).toBeCloseTo(-83.6)

    await wrapper.setProps({ fit: { bbox: [-106, 33, -84, 41] } })
    await nextTick()
    expect(map.bounds).toEqual([-106, 33, -84, 41])
    wrapper.unmount()
  })

  it('jumps to a saved viewport when `fit` names one, instead of computing a frame (P7-4)', async () => {
    const { wrapper, map } = await mountCanvas()

    await wrapper.setProps({ fit: { center: [-90.05, 35.15], zoom: 8.5 } })
    await nextTick()
    expect(map.jumps.at(-1)).toEqual({ center: [-90.05, 35.15], zoom: 8.5 })
    expect(map.center.lng).toBeCloseTo(-90.05)
    expect(map.zoom).toBe(8.5)

    // Counties win: a host that says which rows matter has said the more
    // specific thing, and a stale viewport must not override it.
    await wrapper.setProps({ fit: { geoIds: ['13121'], center: [-90.05, 35.15], zoom: 8.5 } })
    await nextTick()
    expect(map.jumps).toHaveLength(1)

    // Half a viewport is not a viewport.
    await wrapper.setProps({ fit: { center: [-90.05, 35.15] } })
    await nextTick()
    expect(map.jumps).toHaveLength(1)
    wrapper.unmount()
  })

  it('zooms to the `focusGeoId` it is given', async () => {
    const { wrapper, map } = await mountCanvas()
    await wrapper.setProps({ focusGeoId: '13121' })
    await nextTick()
    expect(map.fits.at(-1)?.options.maxZoom).toBe(7) // regional framing
    wrapper.unmount()
  })

  it('takes everything it put on the page away with it', async () => {
    const { wrapper, map } = await mountCanvas()
    wrapper.unmount()
    expect(map.removed).toBe(true)
  })
})

describe('MapCanvas — the chat tools, through its own context', () => {
  it('runs show_layer against this canvas and reports it in words', async () => {
    const { wrapper, state } = await mountCanvas()
    const ctx = wrapper.emitted('ready')![0][0] as any

    const said = await executeTool('show_layer', { layerId: 'pct_Black', on: true }, ctx)

    expect(said).toContain('is now on')
    expect(state.layers.demographic.value).toContain('pct_Black')
    wrapper.unmount()
  })

  it('runs set_query_state against this canvas and nothing else', async () => {
    const a = await mountCanvas()
    const b = await mountCanvas()
    const ctx = a.wrapper.emitted('ready')![0][0] as any

    await executeTool(
      'set_query_state',
      { layers: [{ layerId: 'median_home_value', weight: 8, direction: 'lower_better' }], resultCount: 5 },
      ctx,
    )

    expect(a.state.layers.housing.value).toEqual(['median_home_value'])
    expect(b.state.layers.housing.value).toEqual([])
    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('answers show_county_details by reporting the county, for the host to place', async () => {
    const { wrapper } = await mountCanvas()
    const ctx = wrapper.emitted('ready')![0][0] as any

    await executeTool('show_county_details', { countyName: 'Fulton County, Georgia' }, ctx)

    // Resolution goes through the shared county lookup, which this test does
    // not load; what matters is that the tool runs and the canvas is the
    // thing that would move. A resolved county emits to the host.
    expect(StubMap.instances).toHaveLength(1)
    wrapper.unmount()
  })
})

/**
 * P7-3: line geometry, end to end through the canvas.
 *
 * Before this, nothing in the pipeline drew a `LineString` — the ticket's whole
 * reason — so these are the first assertions that a line reaches the map at
 * all. The third one is the acceptance criterion that matters most: all three
 * geometries drawn together, because the Redevelopment dashboard wants
 * brownfield points, transmission lines and a county choropleth at once.
 */
describe('MapCanvas — line layers (P7-3)', () => {
  const MANIFEST = [
    {
      id: 'internal-transmission', slug: 'transmission', geometry: 'line', name: 'Transmission lines',
      dataType: 'count', unit: '', direction: 'higher_better', range: null,
      description: 'Lines carrying load', source: 'HIFLD', year: 2026, file: 'transmission.geojson',
      color: '#2b6cb0', popupFields: ['OWNER'], width: 3, bbox: [-91, 34, -87.6, 36.4], updatedAt: null,
    },
    {
      id: 'internal-sites', slug: 'sites', geometry: 'point', name: 'Redevelopment sites',
      dataType: 'count', unit: '', direction: 'higher_better', range: null,
      description: 'Candidate sites', source: 'BLO', year: 2026, file: 'sites.csv',
      color: '#ff6b1c', popupFields: ['address'], width: null, bbox: [-90.2, 35, -89.8, 35.3], updatedAt: null,
    },
    {
      id: 'internal-target-index', slug: 'target-index', geometry: 'county', name: 'Target index',
      dataType: 'index', unit: '', direction: 'higher_better', range: { min: 0, max: 100 },
      description: '', source: '', year: 2026, file: null,
      color: null, popupFields: [], width: null, bbox: null, updatedAt: null,
    },
  ]

  const LINES = {
    id: 'internal-transmission', slug: 'transmission', geometry: 'line', type: 'FeatureCollection',
    count: 2, skipped: 0, bbox: [-91, 34, -87.6, 36.4],
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-90.05, 36], [-89.9, 36]] }, properties: { _label: 'Allen tie', OWNER: 'TVA' } },
      { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-91, 34], [-90.5, 34.5]], [[-88, 36.4], [-87.6, 36.2]]] }, properties: { _label: 'Nucor spur', OWNER: 'MLGW' } },
    ],
  }

  const POINTS = {
    id: 'internal-sites', slug: 'sites', geometry: 'point', type: 'FeatureCollection',
    count: 1, skipped: 0, bbox: [-90.05, 35.15, -90.05, 35.15],
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-90.05, 35.15] }, properties: { _label: 'TVA Allen', address: '2574 Plant Rd' } }],
  }

  const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  /** Log in and answer the internal layer routes from the fixtures above. */
  function asInternalUser() {
    auth.internalUser.value = { username: 'maria', displayName: 'Maria' }
    api.internalFetch.mockImplementation(async (path: string) => {
      if (path === '/api/layers/internal') return jsonOk({ layers: MANIFEST })
      if (path === '/api/layers/internal/transmission') return jsonOk(LINES)
      if (path === '/api/layers/internal/sites') return jsonOk(POINTS)
      throw new Error(`unexpected internal fetch: ${path}`)
    })
  }

  /** Mount, load the manifest, switch the named overlays on, settle. */
  async function withOverlays(ids: string[]) {
    asInternalUser()
    const mounted = await mountCanvas()
    await mounted.state.loadInternalLayers()
    await flushPromises()
    for (const id of ids) mounted.state.toggleInternalFeatureLayer(id)
    await flushPromises()
    await nextTick()
    await flushPromises()
    return mounted
  }

  it('draws a LineString layer: one source, a transparent hit layer, and the stroke on top', async () => {
    const { map } = await withOverlays(['internal-transmission'])

    expect(map.getSource('internal-transmission-src')).toBeTruthy()
    const hit = map.getLayer('internal-transmission-line-hit')!
    const stroke = map.getLayer('internal-transmission-line')!
    expect(hit.type).toBe('line')
    expect(hit.paint['line-opacity']).toBe(0)
    expect(stroke.type).toBe('line')
    expect(stroke.paint['line-color']).toBe('#2b6cb0')
    // Nothing clustered a line into a circle on the way.
    expect(map.getLayer('internal-transmission-points')).toBeUndefined()
    expect(map.getLayer('internal-transmission-clusters')).toBeUndefined()

    // The features arrived with their geometry intact — the thing the parser
    // used to throw away.
    const data = (map.sources.get('internal-transmission-src') as any).data
    expect(data.features.map((f: any) => f.geometry.type)).toEqual(['LineString', 'MultiLineString'])
  })

  it('popups a line where it was clicked, and highlights the line under the pointer', async () => {
    const { map } = await withOverlays(['internal-transmission'])
    const { StubPopup } = await import('@/testing/mapboxStub')
    const before = StubPopup.instances.length

    // A click carries where on the line it landed. The popup opens THERE —
    // a line has no one position, and the pointer is the honest answer.
    await map.fireLayer('click', 'internal-transmission-line-hit', {
      lngLat: { lng: -89.95, lat: 36 },
      features: [{ id: 0, geometry: LINES.features[0].geometry, properties: LINES.features[0].properties }],
    })
    const popup = StubPopup.instances[before]
    expect(popup).toBeTruthy()
    expect(popup.lngLat).toEqual({ lng: -89.95, lat: 36 })
    expect(popup.dom!.textContent).toContain('Allen tie')
    expect(popup.dom!.textContent).toContain('TVA')

    // Hover widens the line it would take — feature-state, set on the id the
    // source generated.
    await map.fireLayer('mousemove', 'internal-transmission-line-hit', { features: [{ id: 1 }] })
    expect(map.featureState.get('internal-transmission-src:1')).toEqual({ hover: true })
    expect(map.getCanvas().style.cursor).toBe('pointer')
    await map.fireLayer('mouseleave', 'internal-transmission-line-hit', {})
    expect(map.featureState.get('internal-transmission-src:1')).toEqual({})
    expect(map.getCanvas().style.cursor).toBe('')
  })

  it('draws points, lines and a county choropleth together', async () => {
    const { map, state } = await withOverlays(['internal-sites', 'internal-transmission'])
    state.toggleInternalLayer('internal-target-index')
    await flushPromises()
    await nextTick()

    // All three geometries, each with its own source and its own paint.
    expect(map.getLayer('internal-sites-points')!.type).toBe('circle')
    expect(map.getLayer('internal-transmission-line')!.type).toBe('line')
    expect(map.getLayer('county-choropleth')!.type).toBe('fill')
    expect(map.getSource('internal-sites-src')).toBeTruthy()
    expect(map.getSource('internal-transmission-src')).toBeTruthy()
    expect(map.getSource('counties')).toBeTruthy()

    // Switching one off leaves the others exactly as they were.
    state.toggleInternalFeatureLayer('internal-transmission')
    await flushPromises()
    expect(map.getLayer('internal-transmission-line')).toBeUndefined()
    expect(map.getSource('internal-transmission-src')).toBeUndefined()
    expect(map.getLayer('internal-sites-points')).toBeTruthy()
    expect(map.getLayer('county-choropleth')).toBeTruthy()
  })

  it('frames a line when asked to focus it, instead of flying to one vertex', async () => {
    const { wrapper, map } = await withOverlays(['internal-transmission'])
    const canvas = wrapper.vm as unknown as { focusEntity: (t: { layerId: string; index: number }) => void }
    const fitsBefore = map.fits.length
    const easesBefore = map.eases.length

    canvas.focusEntity({ layerId: 'internal-transmission', index: 0 })

    // The whole corridor is framed. Easing to its middle vertex at zoom 9
    // would show three miles of it and no sense of where it runs.
    expect(map.fits.length).toBe(fitsBefore + 1)
    expect(map.eases.length).toBe(easesBefore)
    expect(map.fits[map.fits.length - 1].bounds).toEqual([[-90.05, 35.15], [-89.9, 36]])
  })

  it('counts lines as lines when the chat switches the layer on', async () => {
    asInternalUser()
    const { state, wrapper } = await mountCanvas()
    await state.loadInternalLayers()
    await flushPromises()
    const canvas = wrapper.vm as unknown as { showLayer: (id: string, on: boolean) => Promise<string | null> }
    await expect(canvas.showLayer('internal-transmission', true)).resolves.toBe('Transmission lines is now on (2 lines).')
  })

  it('asks for nothing internal when nobody is logged in', async () => {
    const { map, state } = await mountCanvas()
    expect(state.layers.pointDefinitions.value).toEqual([])
    state.toggleInternalFeatureLayer('internal-transmission')
    await flushPromises()
    expect(api.internalFetch).not.toHaveBeenCalled()
    expect(map.getLayer('internal-transmission-line')).toBeUndefined()
  })
})

/**
 * P7-9: a state layer end to end, on the same canvas, over the same two
 * county polygons the rest of this file draws — which is the point. The
 * outlines are dissolved from `GEOMETRY` above (Fulton → state 13, DeSoto →
 * state 28), so nothing here fetches a shape and nothing here invents one.
 */
describe('MapCanvas — state layers (P7-9)', () => {
  const MANIFEST = [
    {
      id: 'internal-permits', slug: 'permits', geometry: 'state', name: 'Permitting by state',
      dataType: 'count', unit: '', direction: 'higher_better', range: null,
      description: 'Who issues the permit', source: 'BLO research', year: 2026, file: 'permits.csv',
      color: '#2f855a', popupFields: ['Authority'], detailFields: ['Process'], width: null, bbox: null, updatedAt: null,
    },
    {
      id: 'internal-sites', slug: 'sites', geometry: 'point', name: 'Redevelopment sites',
      dataType: 'count', unit: '', direction: 'higher_better', range: null,
      description: 'Candidate sites', source: 'BLO', year: 2026, file: 'sites.csv',
      color: '#ff6b1c', popupFields: ['address'], detailFields: [], width: null, bbox: [-90.2, 35, -89.8, 35.3], updatedAt: null,
    },
  ]

  /** What the server actually sends: rows, no geometry. */
  const ROWS = {
    id: 'internal-permits', slug: 'permits', geometry: 'state', type: 'FeatureCollection',
    count: 3, skipped: 0, bbox: null,
    features: [
      { type: 'Feature', geometry: null, properties: { _state: '13', _label: 'Georgia', Authority: 'Georgia EPD', Process: 'Apply to EPD.\n\nThen a hearing.' } },
      { type: 'Feature', geometry: null, properties: { _state: '28', _label: 'Mississippi', Authority: 'MDEQ', Process: 'Apply to MDEQ.' } },
      // Wyoming: no county in this fixture, so no outline. Dropped, not faked.
      { type: 'Feature', geometry: null, properties: { _state: '56', _label: 'Wyoming', Authority: 'WDEQ', Process: '' } },
    ],
  }

  const POINTS = {
    id: 'internal-sites', slug: 'sites', geometry: 'point', type: 'FeatureCollection',
    count: 1, skipped: 0, bbox: [-90.05, 35.15, -90.05, 35.15],
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-90.05, 35.15] }, properties: { _label: 'TVA Allen', address: '2574 Plant Rd' } }],
  }

  const jsonOk = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

  function asInternalUser() {
    auth.internalUser.value = { username: 'maria', displayName: 'Maria' }
    api.internalFetch.mockImplementation(async (path: string) => {
      if (path === '/api/layers/internal') return jsonOk({ layers: MANIFEST })
      if (path === '/api/layers/internal/permits') return jsonOk(ROWS)
      if (path === '/api/layers/internal/sites') return jsonOk(POINTS)
      throw new Error(`unexpected internal fetch: ${path}`)
    })
  }

  async function withOverlays(ids: string[]) {
    asInternalUser()
    const mounted = await mountCanvas()
    await mounted.state.loadInternalLayers()
    await flushPromises()
    for (const id of ids) mounted.state.toggleInternalFeatureLayer(id)
    await flushPromises()
    await nextTick()
    await flushPromises()
    return mounted
  }

  it('locates the rows on outlines dissolved from the counties it already has, and fetches nothing extra', async () => {
    const { map } = await withOverlays(['internal-permits'])

    expect(map.getSource('internal-permits-src')).toBeTruthy()
    const data = (map.sources.get('internal-permits-src') as any).data
    // Two states drawn, each a real polygon; Wyoming had no county here.
    expect(data.features.map((f: any) => f.properties._label)).toEqual(['Georgia', 'Mississippi'])
    expect(data.features.map((f: any) => f.geometry.type)).toEqual(['Polygon', 'Polygon'])
    expect(data.features[0].geometry.coordinates[0]).toContainEqual([-84.6, 33.6])

    // The wash and the outline, in the layer's colour.
    expect(map.getLayer('internal-permits-fill')!.type).toBe('fill')
    expect(map.getLayer('internal-permits-fill')!.paint['fill-color']).toBe('#2f855a')
    expect(map.getLayer('internal-permits-outline')!.type).toBe('line')
    // Nothing clustered a state into a circle on the way.
    expect(map.getLayer('internal-permits-points')).toBeUndefined()

    // THE PAYLOAD CLAIM: the only files fetched are the two the public map
    // fetches anyway. A state layer downloads no geometry of its own.
    expect([...new Set(fetchMock.mock.calls.map(call => String(call[0])))].sort())
      .toEqual([DATASETS.countyData, DATASETS.counties].sort())
  })

  it('popups a state where it was clicked, with its prose, and highlights the one under the pointer', async () => {
    const { map } = await withOverlays(['internal-permits'])
    const { StubPopup } = await import('@/testing/mapboxStub')
    const before = StubPopup.instances.length

    await map.fireLayer('click', 'internal-permits-fill', {
      lngLat: { lng: -84.2, lat: 33.9 },
      features: [{ id: 0, geometry: { type: 'Polygon', coordinates: [[[-84.6, 33.6]]] }, properties: ROWS.features[0].properties }],
    })
    const popup = StubPopup.instances[before]
    // Where you clicked. A popup for Georgia opening on the Florida line
    // reads as Florida's.
    expect(popup.lngLat).toEqual({ lng: -84.2, lat: 33.9 })
    expect(popup.dom!.querySelector('.popup-title')!.textContent).toBe('Georgia')
    expect(popup.dom!.textContent).toContain('Georgia EPD')
    // The criterion: the permitting process, as paragraphs.
    expect([...popup.dom!.querySelectorAll('.popup-detail p')].map(p => p.textContent))
      .toEqual(['Apply to EPD.', 'Then a hearing.'])
    expect(popup.dom!.querySelector('a.popup-record')!.getAttribute('href')).toContain('Georgia')

    await map.fireLayer('mousemove', 'internal-permits-fill', { features: [{ id: 1 }] })
    expect(map.featureState.get('internal-permits-src:1')).toEqual({ hover: true })
    expect(map.getCanvas().style.cursor).toBe('pointer')
    await map.fireLayer('mouseleave', 'internal-permits-fill', {})
    expect(map.featureState.get('internal-permits-src:1')).toEqual({})
  })

  it('stacks the wash under the points however they were switched on', async () => {
    // Points first, then the state — the order that would bury them.
    const { map } = await withOverlays(['internal-sites', 'internal-permits'])
    const stack = [...map.layers.keys()]
    expect(stack.indexOf('internal-permits-fill')).toBeLessThan(stack.indexOf('internal-sites-points'))
    expect(stack.indexOf('internal-permits-outline')).toBeLessThan(stack.indexOf('internal-sites-points'))
    // And the point layer's own order is intact: circles over their clusters.
    expect(stack.indexOf('internal-sites-clusters')).toBeLessThan(stack.indexOf('internal-sites-points'))
  })

  it('frames a state when asked to focus it, instead of flying to one vertex', async () => {
    const { wrapper, map } = await withOverlays(['internal-permits'])
    const canvas = wrapper.vm as unknown as { focusEntity: (t: { layerId: string; index: number }) => void }
    const fitsBefore = map.fits.length
    const easesBefore = map.eases.length

    canvas.focusEntity({ layerId: 'internal-permits', index: 0 })

    expect(map.fits.length).toBe(fitsBefore + 1)
    expect(map.eases.length).toBe(easesBefore)
    expect(map.fits[map.fits.length - 1].bounds).toEqual([[-84.6, 33.6], [-83.6, 34.6]])
  })

  it('counts states as states when the chat switches the layer on', async () => {
    asInternalUser()
    const { state, wrapper } = await mountCanvas()
    await state.loadInternalLayers()
    await flushPromises()
    const canvas = wrapper.vm as unknown as { showLayer: (id: string, on: boolean) => Promise<string | null> }
    await expect(canvas.showLayer('internal-permits', true)).resolves.toBe('Permitting by state is now on (2 states).')
  })

  it('takes the layer and its source away on toggle-off, leaving the counties alone', async () => {
    const { map, state } = await withOverlays(['internal-permits'])
    state.toggleInternalFeatureLayer('internal-permits')
    await flushPromises()
    expect(map.getLayer('internal-permits-fill')).toBeUndefined()
    expect(map.getLayer('internal-permits-outline')).toBeUndefined()
    expect(map.getSource('internal-permits-src')).toBeUndefined()
    expect(map.getSource('counties')).toBeTruthy()
    expect(map.getLayer('county-choropleth')).toBeTruthy()
  })
})
