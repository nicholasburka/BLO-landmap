import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { LAYER_REGISTRY, type LayerDefinition } from '@/config/layerRegistry'
import { mapboxStubModule, lastStubMap, resetMapboxStub, StubMap } from '@/testing/mapboxStub'

// P6-14: "Show on map" opens a real map on this page now. mapbox-gl needs a
// WebGL canvas, so it gets the stand-in and the county files a stubbed fetch.
vi.mock('mapbox-gl', () => mapboxStubModule())

vi.mock('@/lib/publicLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/publicLayers')>()
  return { ...actual, loadCountyRows: vi.fn() }
})

import { loadCountyRows, type CountyValueRow } from '@/lib/publicLayers'
import { resetCountyDataCache } from '@/composables/useMapData'
import { stubCountyDataFetch, type CountyDataFetchStub } from '@/testing/countyData'
import DATASETS from '@/config/datasetsManifest.generated.json'
import LayerAboutView from '../LayerAboutView.vue'
import MapPane from '@/components/MapPane.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'

const mockedRows = vi.mocked(loadCountyRows)

const ROWS: CountyValueRow[] = [
  { geoId: '01001', county: 'Autauga County', state: 'Alabama', value: 150000, display: '$150,000' },
  { geoId: '13121', county: 'Fulton County', state: 'Georgia', value: 380000, display: '$380,000' },
]

let router: Router
async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/layers/:id', component: LayerAboutView },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const w = mount(LayerAboutView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

beforeEach(() => {
  mockedRows.mockReset()
  mockedRows.mockResolvedValue(ROWS)
  // A width stubbed by one case must not decide the next one's layout.
  restoreViewport()
  resetMapboxStub()
  resetCountyDataCache()
  network = stubCountyDataFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  restoreViewport()
})

/** What the page asked `fetch` for, so a test can prove it did not. */
let network: CountyDataFetchStub

/**
 * Wait for the canvas to exist. `MapCanvas` is loaded on demand from inside
 * `MapPane`, so the import, the mount and the map land over a few ticks —
 * then its `load` handler is what adds the counties.
 */
async function settleMap(): Promise<void> {
  await import('@/components/MapCanvas.vue')
  for (let i = 0; i < 20 && StubMap.instances.length === 0; i++) await flushPromises()
  await lastStubMap().fire('load')
  await flushPromises()
}

/** Press "Show on map" and let the pane's canvas land. */
async function openPane(w: VueWrapper): Promise<void> {
  await w.get('[data-testid="layer-map-open"]').trigger('click')
  await settleMap()
}

/** What the open pane's canvas was handed as the answer. */
function paneOnly(w: VueWrapper): string[] | null {
  return w.findComponent(MapPane).props('query').only.value
}

describe('LayerAboutView (P5-45)', () => {
  it('says what the layer measures, in what units, which way is better, and its range', async () => {
    const w = await mountAt('/layers/median_home_value')
    expect(w.get('[data-testid="layer-name"]').text()).toBe('Median Home Value')
    expect(w.get('[data-testid="layer-category"]').text()).toBe('Housing')
    expect(w.text()).toContain('Median value of owner-occupied homes with mortgages')
    const facts = w.get('[data-testid="layer-facts"]').text()
    expect(facts).toContain('dollars')
    expect(facts).toContain('lower is better')
    expect(facts).toContain('$30,000 to $1,535,200')
  })

  it('names the publisher with a link when the registry has one', async () => {
    const w = await mountAt('/layers/median_home_value')
    const source = w.get('[data-testid="layer-source"]')
    expect(source.text()).toContain('Urban Institute - Diversity Data Kids · 2022')
    expect(source.get('a').attributes('href')).toBe('https://data.diversitydatakids.org/')
  })

  // P5-65/P5-67: the provenance label reads Publisher — "Source" is the kind
  // of library entry, not the name of whoever wrote the data.
  it('says so plainly, as the publisher, when the registry records none', async () => {
    LAYER_REGISTRY.test_unsourced = {
      ...(LAYER_REGISTRY.median_home_value as LayerDefinition),
      id: 'test_unsourced',
      name: 'Unsourced layer',
      source: '',
      sourceUrl: undefined,
      year: '',
    }
    try {
      const w = await mountAt('/layers/test_unsourced')
      expect(w.get('[data-testid="layer-source"]').text()).toContain('Publisher: not recorded')
      expect(w.get('[data-testid="layer-source"]').text()).not.toContain('Source:')
      expect(w.find('[data-testid="layer-source"] a').exists()).toBe(false)
    } finally {
      delete LAYER_REGISTRY.test_unsourced
    }
  })

  it('offers Show on map and an Ask box already holding the question', async () => {
    const w = await mountAt('/layers/median_home_value')
    expect(w.get('[data-testid="layer-map-link"]').attributes('href')).toBe('/?layers=median_home_value')
    expect((w.get('[data-testid="ask-input"]').element as HTMLInputElement).value).toBe(
      'What does the Median Home Value layer measure and where does it come from?',
    )
  })

  it('loads only this layer data and hands it to the county table', async () => {
    const w = await mountAt('/layers/median_home_value')
    expect(mockedRows).toHaveBeenCalledTimes(1)
    expect(mockedRows.mock.calls[0][0].id).toBe('median_home_value')
    expect(w.get('[data-testid="county-table"]').text()).toContain('Autauga County')
  })

  it('keeps the page usable when the county data fails to load', async () => {
    mockedRows.mockRejectedValue(new Error('CSV unavailable'))
    const w = await mountAt('/layers/median_home_value')
    expect(w.get('[data-testid="county-error"]').text()).toContain('CSV unavailable')
    expect(w.get('[data-testid="layer-name"]').text()).toBe('Median Home Value')
  })

  it('sends an internal layer id to its library entry, which already has About / Data / Map', async () => {
    const w = await mountAt('/layers/internal-organizations')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/library/organizations')
    expect(mockedRows).not.toHaveBeenCalled()
    w.unmount()
  })

  it('says the layer is unknown rather than showing an empty page', async () => {
    const w = await mountAt('/layers/made_up_layer')
    expect(w.get('[data-testid="layer-missing"]').text()).toContain('made_up_layer')
    expect(mockedRows).not.toHaveBeenCalled()
  })
})

/**
 * P6-14. "Show on map" used to leave the page and draw the whole layer. Now
 * it opens a pane here, framed on the rows the county table is showing — the
 * subset a `?layers=…&fit=…` link has no way to say.
 */
describe('LayerAboutView — Show on map, in place (P6-14)', () => {
  it('downloads no county polygons until the pane is opened', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')

    // The *numbers* were already on their way — the county table needs them.
    // The polygons are the pane's own cost, and nothing pays it unasked.
    expect(network.askedForGeometry()).toBe(false)
    expect(w.find('[data-testid="layer-map-pane"]').exists()).toBe(false)

    await openPane(w)
    expect(w.find('[data-testid="layer-map-pane"]').exists()).toBe(true)
    expect(network.urls).toContain(DATASETS.counties)
  })

  it('opens the pane without touching the route — the page is still there behind it', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')
    const before = router.currentRoute.value.fullPath

    await openPane(w)

    expect(router.currentRoute.value.fullPath).toBe(before)
    // The page it was opened from is untouched: heading, facts, table.
    expect(w.get('[data-testid="layer-name"]').text()).toBe('Median Home Value')
    expect(w.get('[data-testid="county-table"]').text()).toContain('Autauga County')
    expect(w.get('[data-testid="layer-map-pane-layer"]').text()).toBe('Median Home Value')
  })

  it('draws the whole layer, unframed, while the table is showing everything', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')
    await openPane(w)

    const pane = w.findComponent(MapPane)
    expect(pane.props('layers').housing.value).toEqual(['median_home_value'])
    // Every county this layer has a number for is the layer, not a subset of
    // it — and framing that union would open the map on the globe, because it
    // contains Guam and American Samoa.
    expect(paneOnly(w)).toBeNull()
    expect(pane.props('fit')).toBeNull()
  })

  it('narrows to what the table is showing when the table is searched', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')
    await openPane(w)
    expect(paneOnly(w)).toBeNull()

    // The table's own search — the same set "Download what I see" writes out.
    await w.get('[data-testid="county-search"]').setValue('Fulton')
    await flushPromises()

    expect(paneOnly(w)).toEqual(['13121'])
    expect(w.findComponent(MapPane).props('fit')).toEqual({ geoIds: ['13121'] })
    // And it says so, because the reader cannot otherwise tell a narrowed map
    // from a whole one.
    expect(w.get('[data-testid="layer-map-pane-note"]').text()).toBe('1 of 2 counties')
  })

  it('says nothing about a subset when the table is showing everything', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')
    await openPane(w)
    expect(w.find('[data-testid="layer-map-pane-note"]').exists()).toBe(false)
  })

  it('closes back to the page, leaving it exactly as it was', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')
    await openPane(w)
    await w.get('[data-testid="county-search"]').setValue('Fulton')
    await flushPromises()

    await w.get('[data-testid="layer-map-pane-close"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="layer-map-pane"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/layers/median_home_value')
    // The search survives the pane closing — closing a map is not a reset.
    expect((w.get('[data-testid="county-search"]').element as HTMLInputElement).value).toBe('Fulton')
    expect(w.get('[data-testid="layer-name"]').text()).toBe('Median Home Value')
  })

  it('keeps the deep link on a narrow window, where a pane does not belong', async () => {
    stubViewportWidth(800)
    const w = await mountAt('/layers/median_home_value')

    expect(w.find('[data-testid="layer-map-open"]').exists()).toBe(false)
    expect(w.get('[data-testid="layer-map-link"]').attributes('href')).toBe('/?layers=median_home_value')
  })

  it('offers the button instead of the link on a desktop', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/layers/median_home_value')

    expect(w.find('[data-testid="layer-map-link"]').exists()).toBe(false)
    const button = w.get('[data-testid="layer-map-open"]')
    expect(button.attributes('aria-expanded')).toBe('false')
    await openPane(w)
    expect(w.get('[data-testid="layer-map-open"]').attributes('aria-expanded')).toBe('true')
  })
})

/**
 * P5-60: a layer's page on a phone. The four fact cards go two-up — they are
 * short enough to read side by side, and it keeps the county table nearer the
 * top — the heading scales instead of being cut off, and "Show on map" is a
 * 44 px button.
 */
const ABOUT_SFC = readStyles('src/views/LayerAboutView.vue')
const ABOUT_PHONE = mediaBlock(ABOUT_SFC, 640)

describe('LayerAboutView — phone layout (P5-60)', () => {
  it('puts the fact cards two to a row', async () => {
    const w = await mountAt('/layers/median_home_value')
    // Five since P7-10: the fourth card says when the data is from, which on
    // a registry layer is its declared vintage read as a period covered.
    expect(w.get('[data-testid="layer-facts"]').findAll('.fact')).toHaveLength(5)
    expect(w.get('[data-testid="layer-dates"]').text()).toContain('Data from')
    expect(ruleFor(ABOUT_PHONE, '.facts')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(ruleFor(ABOUT_PHONE, '.fact dd')).toContain('font-size: 14px')
    expect(ruleFor(ABOUT_PHONE, '.fact dt')).toContain('font-size: 13px')
  })

  it('can shrink below its content, so the county table never widens the page', () => {
    // The route root is a flex item of App.vue's `main`; the county table
    // scrolls inside CountyTable's own wrapper.
    expect(ruleFor(ABOUT_SFC, '.layer-view')).toContain('min-width: 0')
  })

  it('scales the heading and makes Show on map a 44 px button', async () => {
    const w = await mountAt('/layers/median_home_value')
    expect(w.get('[data-testid="layer-map-link"]').classes()).toContain('touch-target')
    expect(ruleFor(ABOUT_PHONE, '.layer-header h1')).toContain('clamp(')
    expect(ruleFor(ABOUT_PHONE, '.primary-action')).toContain('min-height: 44px')
    expect(ruleFor(ABOUT_PHONE, '.description')).toContain('font-size: 14px')
  })
})
