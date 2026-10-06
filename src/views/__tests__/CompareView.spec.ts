import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

/**
 * /compare (P5-55): candidate counties as rows, layers as columns.
 *
 * Only the three things that reach the network are faked — the county
 * lookup, the per-layer loaders and the views API. Everything the page is
 * actually judged on (which layers get loaded, how cells are formatted, what
 * is marked best of these, sorting, the CSV, the save payload) is the real
 * code running over those fakes.
 */
import { mapboxStubModule, resetMapboxStub } from '@/testing/mapboxStub'

// P6-14: "Show on map" opens a real map on this page now, and mapbox-gl needs
// a WebGL canvas it cannot have here.
vi.mock('mapbox-gl', () => mapboxStubModule())

vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'maria', role: 'internal' } } }),
  registerLogoutHook: vi.fn(),
}))

vi.mock('@/lib/compare', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/compare')>()),
  loadLayerColumn: vi.fn(),
  loadCompareCounties: vi.fn(),
  searchCounties: vi.fn(),
}))

vi.mock('@/lib/views', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/views')>()),
  fetchView: vi.fn(),
  fetchViews: vi.fn(),
  saveView: vi.fn(),
}))

vi.mock('@/lib/internalLayers', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/internalLayers')>()),
  fetchInternalLayerManifest: vi.fn(),
}))

import {
  clearShortlist,
  loadCompareCounties,
  loadLayerColumn,
  searchCounties,
  shortlist,
  type CompareCounty,
} from '@/lib/compare'
import { fetchView, fetchViews, saveView, type SavedView } from '@/lib/views'
import { fetchInternalLayerManifest } from '@/lib/internalLayers'
import CompareView from '../CompareView.vue'
import MapPane from '@/components/MapPane.vue'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'
import { stubCountyDataFetch, type CountyDataFetchStub } from '@/testing/countyData'
import { resetCountyDataCache } from '@/composables/useMapData'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const mockedCounties = vi.mocked(loadCompareCounties)
const mockedColumn = vi.mocked(loadLayerColumn)
const mockedSearch = vi.mocked(searchCounties)
const mockedFetchView = vi.mocked(fetchView)
const mockedFetchViews = vi.mocked(fetchViews)
const mockedSaveView = vi.mocked(saveView)
const mockedManifest = vi.mocked(fetchInternalLayerManifest)

const COUNTIES: CompareCounty[] = [
  { geoId: '47157', county: 'Shelby County', state: 'Tennessee' },
  { geoId: '13121', county: 'Fulton County', state: 'Georgia' },
  { geoId: '28033', county: 'DeSoto County', state: 'Mississippi' },
]

/** Real registry layers, so formatValue and direction are the real ones:
 *  median_home_value is lower_better, life_expectancy is higher_better. */
const HOMES: Record<string, { value: number; display: string }> = {
  '47157': { value: 180000, display: '$180,000' },
  '13121': { value: 380000, display: '$380,000' },
  '28033': { value: 250000, display: '$250,000' },
}
const LIFE: Record<string, { value: number; display: string }> = {
  '47157': { value: 74.2, display: '74.2 yrs' },
  '13121': { value: 79.1, display: '79.1 yrs' },
}

let router: Router
async function mountCompare(query = 'counties=47157,13121,28033&layers=median_home_value,life_expectancy') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push(`/compare${query ? `?${query}` : ''}`)
  await router.isReady()
  const wrapper = mount(CompareView, { global: { plugins: [router] } })
  await flushPromises()
  await flushPromises()
  return wrapper
}

type Wrapper = Awaited<ReturnType<typeof mountCompare>>

const rowText = (w: Wrapper) => w.findAll('[data-testid="compare-row"]').map(r => r.text())

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  clearShortlist()
  mockedCounties.mockImplementation(async ids => COUNTIES.filter(c => ids.includes(c.geoId)))
  mockedColumn.mockImplementation(async layer =>
    layer.id === 'median_home_value' ? HOMES : layer.id === 'life_expectancy' ? LIFE : {},
  )
  mockedSearch.mockResolvedValue([])
  mockedFetchViews.mockResolvedValue([])
  mockedFetchView.mockResolvedValue(null)
  mockedManifest.mockResolvedValue([])
  // A width stubbed by one case must not decide the next one's layout, and a
  // map from one must not be the map the next one reads (P6-14).
  restoreViewport()
  resetMapboxStub()
  resetCountyDataCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  restoreViewport()
})

describe('CompareView — the table (P5-55)', () => {
  it('says what is being compared and puts one row per county', async () => {
    const w = await mountCompare()
    expect(w.get('[data-testid="compare-heading"]').text()).toBe('Comparing 3 counties across 2 layers')
    expect(rowText(w)).toHaveLength(3)
    expect(rowText(w)[0]).toContain('DeSoto County') // sorted by name to start
  })

  it('sits under the resource tabs, with Analysis marked current (P6-5)', async () => {
    const w = await mountCompare()
    const currentLink = w.get('[data-testid="kb-nav"]').findAll('a').find(a => a.attributes('aria-current') === 'page')
    expect(currentLink?.text().trim()).toBe('Analysis')
  })

  it('loads only the layers asked for, one loader each', async () => {
    await mountCompare()
    expect(mockedColumn).toHaveBeenCalledTimes(2)
    expect(mockedColumn.mock.calls.map(c => c[0].id).sort()).toEqual(['life_expectancy', 'median_home_value'])
  })

  it('formats each cell with the layer own formatter', async () => {
    const w = await mountCompare()
    const shelby = w.findAll('[data-testid="compare-row"]').find(r => r.text().includes('Shelby'))!
    const cells = shelby.findAll('[data-testid="compare-cell"]').map(c => c.text())
    expect(cells[0]).toContain('$180,000')
    expect(cells[1]).toContain('74.2 yrs')
  })

  it('shows the direction cue in each column header', async () => {
    const w = await mountCompare()
    expect(w.findAll('[data-testid="direction-cue"]').map(c => c.text())).toEqual([
      'lower is better',
      'higher is better',
    ])
  })

  it('marks the best and worst of these counties per layer, in plain words', async () => {
    const w = await mountCompare()
    const cell = (county: string, index: number) =>
      w
        .findAll('[data-testid="compare-row"]')
        .find(r => r.text().includes(county))!
        .findAll('[data-testid="compare-cell"]')[index]
    // Homes: lower is better, so the cheapest county is best of these.
    expect(cell('Shelby', 0).attributes('data-rank')).toBe('best')
    expect(cell('Shelby', 0).attributes('title')).toBe('best of these')
    expect(cell('Shelby', 0).text()).toContain('best of these')
    expect(cell('Fulton', 0).attributes('data-rank')).toBe('worst')
    // Life expectancy: higher is better, and DeSoto has no value at all.
    expect(cell('Fulton', 1).attributes('data-rank')).toBe('best')
    expect(cell('DeSoto', 1).attributes('data-rank')).toBeUndefined()
    expect(cell('DeSoto', 1).text()).toContain('—')
  })

  it('sorts by any column, and sinks blanks', async () => {
    const w = await mountCompare()
    await w.get('[data-testid="sort-median_home_value"]').trigger('click')
    expect(rowText(w)[0]).toContain('Shelby County') // cheapest first
    await w.get('[data-testid="sort-median_home_value"]').trigger('click')
    expect(rowText(w)[0]).toContain('Fulton County')
    await w.get('[data-testid="sort-life_expectancy"]').trigger('click')
    expect(rowText(w).at(-1)).toContain('DeSoto County') // no value — bottom either way
    await w.get('[data-testid="sort-life_expectancy"]').trigger('click')
    expect(rowText(w).at(-1)).toContain('DeSoto County')
  })

  it('shows a skeleton until the layers land', async () => {
    let release: (v: Record<string, never>) => void = () => {}
    mockedColumn.mockImplementation(() => new Promise(resolve => (release = resolve)))
    const w = await mountCompare('counties=47157&layers=median_home_value')
    expect(w.find('[data-testid="compare-skeleton"]').exists()).toBe(true)
    release({})
    await flushPromises()
    expect(w.find('[data-testid="compare-skeleton"]').exists()).toBe(false)
  })

  it('blanks one column and says so when a layer will not load', async () => {
    mockedColumn.mockImplementation(async layer => {
      if (layer.id === 'life_expectancy') throw new Error('offline')
      return HOMES
    })
    const w = await mountCompare()
    expect(w.get('[data-testid="compare-load-error"]').text()).toContain('Life Expectancy')
    expect(rowText(w)).toHaveLength(3)
  })

  it('links to the map with the layers on and the counties framed', async () => {
    const w = await mountCompare()
    const href = w.get('[data-testid="compare-map"]').attributes('href')!
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('layers')).toBe('median_home_value,life_expectancy')
    expect(params.get('fit')).toBe('47157,13121,28033')
  })

  it('prefills Ask with the counties and the layers', async () => {
    const w = await mountCompare()
    expect(w.get('[data-testid="ask-input"]').attributes('value') ?? (w.get('[data-testid="ask-input"]').element as HTMLInputElement).value).toContain(
      'Compare Shelby County, Tennessee',
    )
    expect((w.get('[data-testid="ask-input"]').element as HTMLInputElement).value).toContain(
      'on Median Home Value and Life Expectancy',
    )
  })
})

describe('CompareView — the pickers (P5-55)', () => {
  it('asks for at least one county and one layer before drawing anything', async () => {
    const w = await mountCompare('')
    expect(w.get('[data-testid="compare-empty"]').text()).toBe('Pick at least one county and one layer.')
    expect(w.find('[data-testid="compare-table"]').exists()).toBe(false)
    expect(mockedColumn).not.toHaveBeenCalled()
  })

  it('searches counties by name and adds one to the URL', async () => {
    mockedSearch.mockResolvedValue([{ geoId: '13121', county: 'Fulton County', state: 'Georgia' }])
    const w = await mountCompare('counties=47157&layers=median_home_value')
    await w.get('[data-testid="county-search"]').setValue('fulton')
    await flushPromises()
    await w.get('[data-testid="county-match"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.counties).toBe('47157,13121')
  })

  it('removes a county from the URL', async () => {
    const w = await mountCompare()
    await w.findAll('[data-testid="remove-county"]')[0].trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.counties).toBe('13121,28033')
  })

  it('groups layers the way /layers does, and toggling one rewrites the URL', async () => {
    const w = await mountCompare('counties=47157&layers=median_home_value')
    expect(w.findAll('[data-testid="layer-group-name"]')[0].text()).toBe('Overall index')
    const options = w.findAll('[data-testid="layer-option"]')
    const lifeOption = options.find(o => o.text().includes('Life Expectancy'))!
    await lifeOption.get('input').setValue(true)
    await flushPromises()
    expect(router.currentRoute.value.query.layers).toBe('median_home_value,life_expectancy')
  })

  it('offers the counties waiting on the shortlist, and clears it once they are in', async () => {
    shortlist.value = ['13121', '28033']
    const w = await mountCompare('counties=47157&layers=median_home_value')
    expect(w.get('[data-testid="shortlist-waiting"]').text()).toContain('2 counties are waiting')
    await w.get('[data-testid="add-waiting"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.counties).toBe('47157,13121,28033')
    expect(shortlist.value).toEqual([])
  })
})

describe('CompareView — saving a comparison (P5-55)', () => {
  it('saves counties, layers and notes as a compare view, with no window.prompt', async () => {
    mockedSaveView.mockResolvedValue({ slug: 'delta-shortlist', name: 'Delta shortlist' })
    const promptSpy = vi.spyOn(window, 'prompt')
    const w = await mountCompare()

    await w.findAll('[data-testid="compare-note"]')[0].setValue('Closest to the river port.')
    await w.get('[data-testid="compare-save"]').trigger('click')
    await w.get('[data-testid="compare-save-name"]').setValue('Delta shortlist')
    await w.get('[data-testid="compare-save-form"]').trigger('submit')
    await flushPromises()

    expect(promptSpy).not.toHaveBeenCalled()
    expect(mockedSaveView).toHaveBeenCalledWith({
      name: 'Delta shortlist',
      type: 'compare',
      state: {
        counties: ['47157', '13121', '28033'],
        layers: ['median_home_value', 'life_expectancy'],
        // Rows start sorted by name, so the first note belongs to DeSoto.
        notes: { '28033': 'Closest to the river port.' },
      },
      results: [],
    })
    // P5-69: one confirmation, worded like the map's and the table's, and it
    // links to the view that was just made.
    const saved = w.get('[data-testid="compare-saved"]')
    expect(saved.text().replace(/\s+/g, ' ')).toBe(
      'Saved \u2014 open \u201CDelta shortlist\u201D \u00B7 embed it in a page with view:delta-shortlist',
    )
    expect(saved.get('a').attributes('href')).toBe('/views/delta-shortlist')
  })

  it('calls the button Save view, the one label all three surfaces use (P5-69)', async () => {
    const w = await mountCompare()
    expect(w.get('[data-testid="compare-save"]').text()).toBe('Save view')
  })

  it('says what went wrong when the save is refused', async () => {
    mockedSaveView.mockRejectedValue(new Error('unknown layer: made_up'))
    const w = await mountCompare()
    await w.get('[data-testid="compare-save"]').trigger('click')
    await w.get('[data-testid="compare-save-name"]').setValue('Nope')
    await w.get('[data-testid="compare-save-form"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="compare-save-error"]').text()).toBe('unknown layer: made_up')
  })

  it('lists the comparisons already saved', async () => {
    mockedFetchViews.mockResolvedValue([
      {
        slug: 'delta-shortlist',
        name: 'Delta shortlist',
        type: 'compare',
        dataset: '',
        workingSet: '',
        description: '3 counties × 4 layers',
        savedBy: 'maria',
        savedAt: '2026-09-05T12:00:00.000Z',
        resultCount: 0,
      },
    ])
    const w = await mountCompare()
    expect(mockedFetchViews).toHaveBeenCalledWith({ type: 'compare' })
    const row = w.get('[data-testid="saved-comparison"]')
    expect(row.text()).toContain('Delta shortlist')
    expect(row.text()).toContain('3 counties × 4 layers')
    expect(row.get('a').attributes('href')).toBe('/views/delta-shortlist')
  })

  it('names the saved comparison it was opened from and brings its notes back', async () => {
    mockedFetchView.mockResolvedValue({
      slug: 'delta-shortlist',
      name: 'Delta shortlist',
      type: 'compare',
      savedBy: 'maria',
      savedAt: '2026-09-05T12:00:00.000Z',
      state: { counties: ['47157'], layers: ['median_home_value'], notes: { '47157': 'River port.' } },
      results: [],
    } as unknown as SavedView)
    const w = await mountCompare('counties=47157&layers=median_home_value&view=delta-shortlist')
    expect(w.get('[data-testid="compare-saved-banner"]').text()).toContain('Delta shortlist')
    expect((w.get('[data-testid="compare-note"]').element as HTMLTextAreaElement).value).toBe('River port.')
  })

  it('still shows the comparison when the saved view behind it is gone', async () => {
    mockedFetchView.mockResolvedValue(null)
    const w = await mountCompare('counties=47157&layers=median_home_value&view=deleted')
    expect(w.find('[data-testid="compare-saved-banner"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="compare-row"]')).toHaveLength(1)
  })
})

describe('CompareView — download (P5-55)', () => {
  it('builds a CSV of the rows on screen, notes included', async () => {
    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return 'blob:compare'
      }),
      revokeObjectURL: vi.fn(),
    })
    const click = vi.fn()
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const el = realCreate(tag)
      if (tag === 'a') (el as HTMLAnchorElement).click = click
      return el
    })

    const w = await mountCompare()
    await w.findAll('[data-testid="compare-note"]')[0].setValue('note about DeSoto')
    await w.get('[data-testid="compare-download"]').trigger('click')

    expect(click).toHaveBeenCalledTimes(1)
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blobs[0])
    })
    expect(text.split('\n')[0]).toBe('GEOID,County,State,Median Home Value,Life Expectancy,Notes')
    expect(text).toContain('28033,DeSoto County,Mississippi,250000,,note about DeSoto')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})

describe('CompareView — place report (P5-58)', () => {
  it('offers a report link per county row, next to the numbers', async () => {
    const w = await mountCompare()
    const links = w.findAll('[data-testid="compare-report"]')
    expect(links).toHaveLength(3)
    // Sorted by county name, so the hrefs follow the rows on screen.
    const rowIds = w.findAll('[data-testid="compare-row"] .county-cell').map(c => c.text())
    expect(rowIds[0]).toContain('DeSoto County')
    expect(links[0].attributes('href')).toBe('/place?geoid=28033')
    expect(links[0].attributes('aria-label')).toBe('Place report for DeSoto County')
  })
})

/**
 * P6-14. The compare page's link already framed the shortlist — `&fit=` is
 * exactly these counties. What it could not do was *say* they were the
 * answer, and it took the comparison off screen to show them.
 */
describe('CompareView — Show on map, in place (P6-14)', () => {
  let network: CountyDataFetchStub

  beforeEach(() => {
    network = stubCountyDataFetch()
  })

  /** Let `MapPane`'s on-demand canvas land. */
  async function settleMap(): Promise<void> {
    await import('@/components/MapCanvas.vue')
    for (let i = 0; i < 20; i++) await flushPromises()
  }

  async function openMapPane(w: VueWrapper): Promise<void> {
    await w.get('[data-testid="compare-map-open"]').trigger('click')
    await settleMap()
  }

  it('downloads no county polygons until the pane is opened', async () => {
    stubViewportWidth(1280)
    const w = await mountCompare()

    // The compared layers' *numbers* are the table's own business. The
    // polygons are the pane's, and nothing pays for them unasked.
    expect(network.askedForGeometry()).toBe(false)
    expect(w.find('[data-testid="compare-map-pane"]').exists()).toBe(false)

    await openMapPane(w)
    expect(w.find('[data-testid="compare-map-pane"]').exists()).toBe(true)
    expect(network.askedForGeometry()).toBe(true)
  })

  it('draws the shortlist as the answer, framed on it, with the compared layers on', async () => {
    stubViewportWidth(1280)
    const w = await mountCompare()
    await openMapPane(w)

    const pane = w.findComponent(MapPane)
    expect(pane.props('query').only.value).toEqual(['47157', '13121', '28033'])
    expect(pane.props('fit')).toEqual({ geoIds: ['47157', '13121', '28033'] })
    expect(pane.props('layers').housing.value).toEqual(['median_home_value'])
    expect(pane.props('layers').demographic.value).toEqual(['life_expectancy'])
  })

  it('names the layers being compared rather than calling two of them the BLO index', async () => {
    stubViewportWidth(1280)
    const w = await mountCompare()
    await openMapPane(w)

    expect(w.get('[data-testid="compare-map-pane-layer"]').text()).toBe('Median Home Value · Life Expectancy')
    expect(w.get('[data-testid="compare-map-pane-note"]').text()).toBe('3 counties')
  })

  it('follows the shortlist: drop a county and the map drops it too', async () => {
    stubViewportWidth(1280)
    const w = await mountCompare()
    await openMapPane(w)

    await w.findAll('[data-testid="remove-county"]')[0].trigger('click')
    await flushPromises()
    await flushPromises()

    expect(w.findComponent(MapPane).props('query').only.value).toEqual(['13121', '28033'])
    expect(w.get('[data-testid="compare-map-pane-note"]').text()).toBe('2 counties')
  })

  it('closes back to the comparison, which never went anywhere', async () => {
    stubViewportWidth(1280)
    const w = await mountCompare()
    const before = router.currentRoute.value.fullPath
    await openMapPane(w)

    expect(router.currentRoute.value.fullPath).toBe(before)

    await w.get('[data-testid="compare-map-pane-close"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="compare-map-pane"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe(before)
    expect(w.get('[data-testid="compare-heading"]').text()).toBe('Comparing 3 counties across 2 layers')
  })

  it('keeps the deep link on a narrow window, unchanged', async () => {
    stubViewportWidth(800)
    const w = await mountCompare()

    expect(w.find('[data-testid="compare-map-open"]').exists()).toBe(false)
    const href = w.get('[data-testid="compare-map"]').attributes('href')!
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('layers')).toBe('median_home_value,life_expectancy')
    expect(params.get('fit')).toBe('47157,13121,28033')
  })
})

/**
 * P5-60: /compare on a phone. The audit measured this page 403 px wider than
 * a 375 px screen, its heading cut off, 17 px remove buttons, 13 px
 * checkboxes and 46 pieces of text under 13 px.
 *
 * The rules live in the component's `<style>` block (jsdom lays nothing out),
 * so they are asserted there; the markup they act on is asserted in the DOM.
 */
const COMPARE_SFC = readStyles('src/views/CompareView.vue')
const COMPARE_PHONE = mediaBlock(COMPARE_SFC, 640)

describe('CompareView — phone layout (P5-60)', () => {
  it('keeps the table’s width inside its scroll box, and off the page', () => {
    expect(ruleFor(COMPARE_SFC, '.table-scroll')).toContain('max-width: 100%')
    expect(ruleFor(COMPARE_SFC, '.compare-panel')).toContain('min-width: 0')
    // The one that actually fixed the audit's 403 px: this route root is a
    // flex item of App.vue's `main`, so its automatic minimum size is the
    // table's min-content width until it is told otherwise.
    expect(ruleFor(COMPARE_SFC, '.compare-view')).toContain('min-width: 0')
  })

  it('scales the heading instead of cutting it off', () => {
    expect(ruleFor(COMPARE_PHONE, '.compare-header h1')).toContain('clamp(')
    expect(ruleFor(COMPARE_PHONE, '.compare-header h1')).toContain('overflow-wrap: anywhere')
  })

  it('shortens the layer headers and keeps the full name reachable', async () => {
    const w = await mountCompare()
    const header = w.get('[data-testid="sort-median_home_value"]')
    const full = header.get('.head-full').text()
    const short = header.get('.head-short').text()
    // The abbreviation is what a phone shows; the full name is the title, the
    // accessible name, and the legend row under the table.
    expect(short.length).toBeLessThanOrEqual(12)
    expect(short.endsWith('…')).toBe(true)
    expect(header.attributes('title')).toBe(full)
    expect(header.attributes('aria-label')).toBe(`Sort by ${full}`)

    const legend = w.findAll('[data-testid="compare-legend-row"]')
    expect(legend).toHaveLength(2)
    expect(legend[0].text()).toContain(full)
    expect(legend[0].text()).toContain(short)

    // One at each width: the key only appears where the headers are short.
    expect(ruleFor(COMPARE_SFC, '.head-short')).toContain('display: none')
    expect(ruleFor(COMPARE_PHONE, '.head-full')).toContain('display: none')
    expect(ruleFor(COMPARE_PHONE, '.head-short')).toContain('display: inline')
    expect(ruleFor(COMPARE_PHONE, '.layer-legend')).toContain('display: grid')
  })

  it('abbreviates by clipping, so the short name still reads as the layer', async () => {
    const w = await mountCompare('counties=47157&layers=median_home_value,life_expectancy,public_transit')
    const heads = w.findAll('thead .sort-btn').filter(b => b.find('.head-short').exists())
    expect(heads.length).toBe(3)
    for (const head of heads) {
      const full = head.get('.head-full').text()
      const short = head.get('.head-short').text()
      expect(short.length).toBeLessThanOrEqual(12)
      // A prefix of the real name plus an ellipsis — never a made-up acronym.
      expect(full.startsWith(short.replace('…', ''))).toBe(true)
    }
  })

  it('pins the county column while the layers scroll', () => {
    const county = ruleFor(COMPARE_PHONE, '.county-cell')
    expect(county).toContain('position: sticky')
    expect(county).toContain('left: 0')
    expect(county).toContain('background:')
  })

  it('keeps the best/worst wording on the cells', async () => {
    const w = await mountCompare()
    const marked = w.findAll('[data-testid="compare-cell"]').filter(c => c.attributes('data-rank'))
    expect(marked.length).toBeGreaterThan(0)
    expect(marked.map(c => c.attributes('title'))).toContain('best of these')
  })

  it('gives every chip, checkbox and button a 44 px target', async () => {
    const w = await mountCompare()
    expect(w.findAll('[data-testid="remove-county"]').every(b => b.classes('touch-target'))).toBe(true)
    expect(w.findAll('[data-testid="layer-option"]').every(l => l.classes('touch-target'))).toBe(true)

    expect(ruleFor(COMPARE_PHONE, '.chip-remove')).toContain('min-width: 44px')
    expect(ruleFor(COMPARE_PHONE, '.chip-remove')).toContain('min-height: 44px')
    expect(ruleFor(COMPARE_PHONE, '.layer-option')).toContain('min-height: 44px')
    // A native checkbox scaled up, with the whole label row as its hit area.
    expect(ruleFor(COMPARE_PHONE, ".layer-option input[type='checkbox']")).toContain('width: 20px')
    expect(ruleFor(COMPARE_PHONE, '.tool-btn')).toContain('min-height: 44px')
    expect(ruleFor(COMPARE_PHONE, '.county-report')).toContain('min-height: 44px')
  })

  it('gives the save form and the notes the whole width, and scrolls the saved strip', () => {
    expect(ruleFor(COMPARE_PHONE, '.save-form')).toContain('flex: 1 1 100%')
    expect(ruleFor(COMPARE_PHONE, '.save-name')).toContain('flex: 1 1 100%')
    expect(ruleFor(COMPARE_PHONE, '.saved-list')).toContain('overflow-x: auto')
  })

  it('reads at 14 px or more', () => {
    expect(ruleFor(COMPARE_PHONE, '.compare-table')).toContain('font-size: 14px')
    expect(ruleFor(COMPARE_PHONE, '.lede')).toContain('font-size: 14px')
    expect(ruleFor(COMPARE_PHONE, '.layer-legend')).toContain('font-size: 14px')
  })
})
