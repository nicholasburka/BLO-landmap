import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { mapboxStubModule, lastStubMap, resetMapboxStub, StubMap } from '@/testing/mapboxStub'

/**
 * A map block in a page (P7-4).
 *
 * The ticket's acceptance, in order: a block renders the named view's state; a
 * page with no block fetches no map code (that half is in `wikiEmbeds.spec` —
 * it is a claim about the hydrator, not about this component); and on a phone
 * the block degrades rather than mounting a second WebGL context.
 *
 * `MapPane` and `MapCanvas` are real, over the mapbox stub, because "renders
 * the view's state" is a claim about what reaches the canvas — a stubbed pane
 * would let a block that applies nothing pass. Only the network is faked.
 */

vi.mock('mapbox-gl', () => mapboxStubModule())

vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, sharedManifest: vi.fn() }
})

vi.mock('@/lib/workingSets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/workingSets')>()
  return { ...actual, fetchWorkingSet: vi.fn() }
})

import { fetchWorkingSet, type WorkingSetDetail } from '@/lib/workingSets'
import { sharedManifest, clearInternalLayerCache, type InternalLayerManifestEntry } from '@/lib/internalLayers'
import type { SavedView } from '@/lib/views'
import WikiMapBlock from '../WikiMapBlock.vue'
import MapPane from '@/components/MapPane.vue'
import { stubViewportWidth, restoreViewport, type ViewportStub } from '@/testing/viewport'
import { stubCountyDataFetch, type CountyDataFetchStub } from '@/testing/countyData'
import { resetCountyDataCache } from '@/composables/useMapData'

const mockedSet = vi.mocked(fetchWorkingSet)
const mockedManifest = vi.mocked(sharedManifest)

// --- Fixtures ---------------------------------------------------------------

function view(over: Partial<SavedView> = {}, state: Record<string, unknown> = {}): SavedView {
  return {
    slug: 'memphis-siting',
    name: 'Memphis siting',
    type: 'map',
    savedBy: 'maria',
    savedAt: '2026-10-06T12:00:00.000Z',
    state: {
      layers: [{ layerId: 'pct_Black', weight: 7, direction: 'higher_better' }],
      filters: [],
      limit: null,
      regionStates: [],
      prompt: '',
      viewport: { center: [-90.05, 35.15], zoom: 8.5 },
      ...state,
    } as unknown as SavedView['state'],
    results: [],
    ...over,
  }
}

function detail(over: Partial<WorkingSetDetail> = {}): WorkingSetDetail {
  return {
    slug: 'memphis-redevelopment',
    name: 'Memphis redevelopment',
    purpose: 'What bears on siting',
    description: 'Working set · 2 datasets · 1 layer',
    datasets: ['memphis-sites'],
    layers: ['internal-sites'],
    sites: 'memphis-sites',
    derivedCount: 0,
    savedBy: 'maria',
    savedAt: '2026-10-05T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    views: [{ slug: 'memphis-siting', name: 'Memphis siting', type: 'map' }],
    members: [{ slug: 'memphis-sites', kind: 'dataset', title: 'Memphis candidate sites', status: 'published' }],
    missing: [],
    ...over,
  }
}

function manifestEntry(): InternalLayerManifestEntry {
  return {
    id: 'internal-sites',
    slug: 'memphis-sites',
    name: 'Sites by county',
    geometry: 'county',
    dataType: 'count',
    unit: '',
    direction: 'higher_better',
    range: { min: 0, max: 10 },
    description: '',
    source: '',
    year: 2026,
    file: null,
    color: null,
    bbox: null,
    popupFields: [],
    updatedAt: '2026-10-05T10:00:00.000Z',
  }
}

// --- Harness ----------------------------------------------------------------

let network: CountyDataFetchStub
let viewport: ViewportStub

/**
 * Let `MapPane`'s on-demand canvas land and run its map through `load`.
 *
 * The `import()` is real I/O, and the canvas does everything that touches the
 * style — the choropleth, and the `fit` the host asked for before the polygons
 * existed — inside its `load` handler, which only a test fires.
 */
const loaded = new WeakSet<StubMap>()

async function settleMap(): Promise<void> {
  await import('@/components/MapCanvas.vue')
  for (let i = 0; i < 20; i++) await flushPromises()
  const map = StubMap.instances.at(-1)
  // Once per map: mapbox fires `load` once, and re-running that handler against
  // a map that has already been through it (or removed) hangs on its own waits.
  if (map && !loaded.has(map)) {
    loaded.add(map)
    await map.fire('load')
    await flushPromises()
  }
}

interface BlockProps {
  view: SavedView
  mode?: 'live' | 'preview' | 'capped'
  limit?: number
}

async function mountBlock(props: BlockProps): Promise<VueWrapper> {
  const wrapper = mount(WikiMapBlock, {
    props,
    global: { mocks: { $router: { push: vi.fn() } } },
  })
  await flushPromises()
  await settleMap()
  return wrapper
}

const standin = (w: VueWrapper) => w.find('[data-testid="wiki-map-standin"]').text()

beforeEach(() => {
  viewport = stubViewportWidth(1440)
  network = stubCountyDataFetch({
    'http://localhost:3001/api/layers/internal/memphis-sites': {
      id: 'internal-sites',
      slug: 'memphis-sites',
      geometry: 'county',
      values: { '13121': 2 },
      range: { min: 0, max: 10 },
    },
    // The point-overlay case asks by the id's own tail, not by the slug.
    'http://localhost:3001/api/layers/internal/sites': {
      id: 'internal-sites',
      slug: 'sites',
      geometry: 'point',
      features: { type: 'FeatureCollection', features: [] },
    },
  })
  clearInternalLayerCache()
  resetCountyDataCache()
  resetMapboxStub()
  mockedManifest.mockReset()
  mockedManifest.mockResolvedValue([manifestEntry()])
  mockedSet.mockReset()
  mockedSet.mockResolvedValue(detail())
})

afterEach(() => {
  restoreViewport()
  vi.unstubAllGlobals()
})

// --- "renders the named view's state" ---------------------------------------

describe('a map block renders the view it names', () => {
  it('mounts a canvas with the view\'s own layers and jumps to the viewport it saved', async () => {
    const wrapper = await mountBlock({ view: view() })

    const pane = wrapper.findComponent(MapPane)
    expect(pane.exists()).toBe(true)
    expect(pane.props('title')).toBe('Memphis siting')
    // The weight is the VIEW's, not a flat 5: the document said 7.
    expect(pane.props('query').weights.value).toEqual({ pct_Black: 7 })
    // The viewport is a decision, so it is jumped to rather than fitted.
    expect(lastStubMap().jumps.at(-1)).toEqual({ center: [-90.05, 35.15], zoom: 8.5 })
    expect(network.askedForGeometry()).toBe(true)
    wrapper.unmount()
  })

  it('carries the filters, the limit and the region the view saved', async () => {
    const wrapper = await mountBlock({
      view: view(
        {},
        {
          filters: [{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }],
          limit: 25,
          regionStates: ['TN'],
        },
      ),
    })
    const query = wrapper.findComponent(MapPane).props('query')
    expect(query.filters.value).toEqual([{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }])
    expect(query.limit.value).toBe(25)
    expect(query.regionStates.value).toEqual(['TN'])
    wrapper.unmount()
  })

  it('draws the whole layer, not a subset: a page has no table to narrow it', async () => {
    const wrapper = await mountBlock({ view: view() })
    expect(wrapper.findComponent(MapPane).props('query').only.value).toBeNull()
    wrapper.unmount()
  })

  it('frames the counties the view snapshotted when it saved no viewport', async () => {
    const wrapper = await mountBlock({
      view: view(
        { results: [{ rank: 1, geoId: '13121', name: 'Fulton', state: 'Georgia', score: 90 }] },
        { viewport: null },
      ),
    })
    expect(wrapper.findComponent(MapPane).props('fit')).toEqual({ geoIds: ['13121'] })
    wrapper.unmount()
  })

  it('names the view and what it draws in the pane header', async () => {
    const wrapper = await mountBlock({ view: view({ workingSet: undefined }) })
    expect(wrapper.findComponent(MapPane).props('note')).toBe('1 layer')
    wrapper.unmount()
  })
})

// --- "or a working set" -----------------------------------------------------

describe('a set-backed view draws the set, framed by the view (§F.1)', () => {
  it('draws the layers the SET names, not the ones the view saved', async () => {
    const wrapper = await mountBlock({ view: view({ workingSet: 'memphis-redevelopment' }) })

    const pane = wrapper.findComponent(MapPane)
    // internal-sites is the SET's layer; pct_Black was the view's.
    expect(Object.keys(pane.props('query').weights.value)).toEqual(['internal-sites'])
    // …and the framing is still the view's, which is the whole point of the
    // two objects being two objects.
    expect(lastStubMap().jumps.at(-1)).toEqual({ center: [-90.05, 35.15], zoom: 8.5 })
    expect(pane.props('note')).toContain('Over Memphis redevelopment')
    wrapper.unmount()
  })

  it('falls back to the view\'s own layers when the set names none yet', async () => {
    mockedSet.mockResolvedValue(detail({ layers: [] }))
    const wrapper = await mountBlock({ view: view({ workingSet: 'memphis-redevelopment' }) })
    expect(wrapper.findComponent(MapPane).props('query').weights.value).toEqual({ pct_Black: 7 })
    wrapper.unmount()
  })

  it('says a named set has gone and still draws the view, rather than showing nothing', async () => {
    mockedSet.mockResolvedValue(null)
    const wrapper = await mountBlock({ view: view({ workingSet: 'memphis-redevelopment' }) })
    expect(wrapper.get('[data-testid="wiki-map-set-gone"]').text()).toContain('memphis-redevelopment')
    expect(wrapper.findComponent(MapPane).exists()).toBe(true)
    wrapper.unmount()
  })

  it('asks for the set once, however many times the pane reopens', async () => {
    const wrapper = await mountBlock({ view: view({ workingSet: 'memphis-redevelopment' }) })
    await wrapper.get('[data-testid="wiki-map-pane-close"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="wiki-map-show"]').trigger('click')
    await settleMap()
    expect(mockedSet).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

// --- "on a phone the block degrades" ----------------------------------------

describe('the phone path', () => {
  it('mounts no canvas and fetches no county file, and says where the map is', async () => {
    viewport = stubViewportWidth(390)
    const wrapper = await mountBlock({ view: view() })

    expect(wrapper.findComponent(MapPane).exists()).toBe(false)
    expect(standin(wrapper)).toContain('There is not room for a map here')
    expect(wrapper.get('[data-testid="wiki-map-standin"] a').attributes('href')).toBe('/?view=memphis-siting')
    // The acceptance criterion, measured where it is true or false.
    expect(network.askedForCountyData()).toBe(false)
    wrapper.unmount()
  })

  it('sends a set-backed view to the set, since that is where its two interfaces are', async () => {
    viewport = stubViewportWidth(390)
    const wrapper = await mountBlock({ view: view({ workingSet: 'memphis-redevelopment' }) })
    expect(wrapper.get('[data-testid="wiki-map-standin"] a').attributes('href')).toBe('/views/memphis-siting')
    wrapper.unmount()
  })

  it('draws the map once a window grows past the breakpoint', async () => {
    viewport = stubViewportWidth(800)
    const wrapper = await mountBlock({ view: view() })
    expect(wrapper.findComponent(MapPane).exists()).toBe(false)

    viewport.resize(1440)
    await settleMap()
    expect(wrapper.findComponent(MapPane).exists()).toBe(true)
    wrapper.unmount()
  })

  it('closes the pane when a window narrows, rather than hiding a live canvas', async () => {
    const wrapper = await mountBlock({ view: view() })
    expect(wrapper.findComponent(MapPane).exists()).toBe(true)

    viewport.resize(700)
    await flushPromises()
    expect(wrapper.findComponent(MapPane).exists()).toBe(false)
    expect(lastStubMap().removed).toBe(true)
    wrapper.unmount()
  })
})

// --- every other way a block is not a map -----------------------------------

describe('what a block says when it cannot be a map', () => {
  it('a table view: there is no map in it, and it says which kind it is', async () => {
    const wrapper = await mountBlock({ view: view({ type: 'table' }) })
    expect(standin(wrapper)).toContain('is a table view')
    expect(network.askedForCountyData()).toBe(false)
    wrapper.unmount()
  })

  it('a comparison: the same, named as a comparison', async () => {
    const wrapper = await mountBlock({ view: view({ type: 'compare' }) })
    expect(standin(wrapper)).toContain('saved comparison')
    wrapper.unmount()
  })

  it('a view naming no layer: the thing to fix, not an empty grey country', async () => {
    const wrapper = await mountBlock({ view: view({}, { layers: [] }) })
    expect(standin(wrapper)).toContain('names no map layer')
    expect(network.askedForCountyData()).toBe(false)
    wrapper.unmount()
  })

  it('a view with only a point overlay IS a map — the points are what it shows', async () => {
    const wrapper = await mountBlock({
      view: view({ workingSet: undefined }, { layers: [], pointLayers: [{ id: 'internal-sites', name: 'Sites' }] }),
    })
    expect(wrapper.findComponent(MapPane).exists()).toBe(true)
    expect(wrapper.findComponent(MapPane).props('note')).toBe('1 point overlay')
    wrapper.unmount()
  })

  it('the editor preview: the block names the view and mounts no canvas', async () => {
    const wrapper = await mountBlock({ view: view(), mode: 'preview' })
    expect(wrapper.findComponent(MapPane).exists()).toBe(false)
    expect(standin(wrapper)).toContain('A map of “Memphis siting”')
    expect(standin(wrapper)).toContain('the preview does not mount a canvas')
    expect(network.askedForCountyData()).toBe(false)
    // A preview re-renders per keystroke, so it must not fetch per keystroke.
    expect(mockedSet).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('over the cap: it says how many a page holds, and links out', async () => {
    const wrapper = await mountBlock({ view: view(), mode: 'capped', limit: 3 })
    expect(wrapper.findComponent(MapPane).exists()).toBe(false)
    expect(standin(wrapper)).toContain('already draws 3 maps')
    expect(network.askedForCountyData()).toBe(false)
    wrapper.unmount()
  })
})

// --- the reader's own switch -------------------------------------------------

describe('a reader can put the map away', () => {
  it('Close releases the canvas and offers it back; Show it draws again', async () => {
    const wrapper = await mountBlock({ view: view() })
    const first = lastStubMap()

    await wrapper.get('[data-testid="wiki-map-pane-close"]').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(MapPane).exists()).toBe(false)
    expect(first.removed).toBe(true)
    expect(wrapper.get('[data-testid="wiki-map-hidden"]').text()).toContain('is hidden')

    await wrapper.get('[data-testid="wiki-map-show"]').trigger('click')
    await settleMap()
    expect(wrapper.findComponent(MapPane).exists()).toBe(true)
    wrapper.unmount()
  })

  it('a resize does not undo a Close: the reader decided, the window did not', async () => {
    const wrapper = await mountBlock({ view: view() })
    await wrapper.get('[data-testid="wiki-map-pane-close"]').trigger('click')
    await flushPromises()

    viewport.resize(700)
    await flushPromises()
    viewport.resize(1440)
    await settleMap()
    expect(wrapper.findComponent(MapPane).exists()).toBe(false)
    wrapper.unmount()
  })

  it('takes the canvas away with it when the page unmounts the block', async () => {
    const wrapper = await mountBlock({ view: view() })
    const map = lastStubMap()
    wrapper.unmount()
    expect(map.removed).toBe(true)
  })
})
