import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { mapboxStubModule, resetMapboxStub } from '@/testing/mapboxStub'

/**
 * Two interfaces over one working set (P7-2).
 *
 * The ticket's acceptance, in order: a derived column shows in BOTH interfaces
 * without a second computation; a filter applied in the data interface reaches
 * the map as `query.only`; a deep link to either interface opens there. Plus
 * the thing underneath all three — the set and its columns are read ONCE, and
 * switching interface is not a navigation.
 *
 * The explorer, the pane and the canvas are all real here. Only the network is
 * faked, because "no duplicate fetch" is a claim about the network and has to
 * be measured there.
 */

vi.mock('mapbox-gl', () => mapboxStubModule())

vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, sharedManifest: vi.fn() }
})

vi.mock('@/lib/publicLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/publicLayers')>()
  return { ...actual, loadCountyRows: vi.fn() }
})

vi.mock('@/lib/views', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/views')>()
  return { ...actual, fetchView: vi.fn(), fetchViews: vi.fn(), saveView: vi.fn() }
})

vi.mock('@/lib/libraryData', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryData')>()
  return {
    ...actual,
    fetchDatasetSchema: vi.fn(),
    fetchDatasetRows: vi.fn(),
    fetchColumnSummary: vi.fn(),
    fetchColumnOverview: vi.fn(),
  }
})

// The two reads this ticket is judged on. Everything else in `workingSets.ts`
// — the column conversion, the ranges, the hrefs — stays real, because the
// claim is that both interfaces read ONE object through it.
// P7-6: `rerunDerivedColumn` is faked too. The arithmetic that decides whether
// a re-run is OFFERED — the verdict, the badge, the sentence — is the real
// code, which is what the copy is judged on.
vi.mock('@/lib/workingSets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/workingSets')>()
  return {
    ...actual,
    fetchWorkingSet: vi.fn(),
    fetchWorkingSetColumns: vi.fn(),
    rerunDerivedColumn: vi.fn(),
    runComposite: vi.fn(),
  }
})

import {
  fetchDatasetSchema,
  fetchDatasetRows,
  fetchColumnOverview,
  fetchColumnSummary,
  type DatasetSchema,
  type RowsPage,
} from '@/lib/libraryData'
import { loadCountyRows } from '@/lib/publicLayers'
import { fetchView, fetchViews, type SavedView } from '@/lib/views'
import {
  fetchWorkingSet,
  fetchWorkingSetColumns,
  rerunDerivedColumn,
  runComposite,
  type CompositeRun,
  type DerivedColumn,
  type WorkingSetColumns,
  type WorkingSetDetail,
} from '@/lib/workingSets'
import { indexDraftKey, readIndexDraft } from '@/lib/indexDraft'
import { sharedManifest, clearInternalLayerCache, type InternalLayerManifestEntry } from '@/lib/internalLayers'
import WorkingSetWorkspace from '../WorkingSetWorkspace.vue'
import MapPane from '@/components/MapPane.vue'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'
import { stubCountyDataFetch, type CountyDataFetchStub } from '@/testing/countyData'
import { resetCountyDataCache } from '@/composables/useMapData'
import { resetBodyScrollLock } from '@/lib/scrollLock'

const mockedSchema = vi.mocked(fetchDatasetSchema)
const mockedRows = vi.mocked(fetchDatasetRows)
const mockedOverview = vi.mocked(fetchColumnOverview)
const mockedSummary = vi.mocked(fetchColumnSummary)
const mockedCountyRows = vi.mocked(loadCountyRows)
const mockedFetchView = vi.mocked(fetchView)
const mockedFetchViews = vi.mocked(fetchViews)
const mockedSet = vi.mocked(fetchWorkingSet)
const mockedColumns = vi.mocked(fetchWorkingSetColumns)
const mockedManifest = vi.mocked(sharedManifest)
const mockedComposite = vi.mocked(runComposite)

// --- Fixtures ---------------------------------------------------------------

const COUNTY_LAYER = { id: 'internal-sites', geometry: 'county' as const, name: 'Sites by county', labelKey: null }

const SCHEMA: DatasetSchema = {
  entry: { slug: 'memphis-sites', title: 'Memphis candidate sites', kind: 'dataset' },
  file: 'sites.csv',
  files: ['sites.csv'],
  columns: [
    { name: 'Site', type: 'string', filled: 3, distinct: 3 },
    { name: 'GEOID', type: 'string', filled: 2, distinct: 2 },
  ],
  rowCount: 3,
  bytes: 200,
  parsedAt: '2026-10-04T00:00:00.000Z',
  layer: COUNTY_LAYER,
}

const PAGE: RowsPage = {
  rows: [
    { _row: 0, Site: 'Old Rail Yard', GEOID: '47157' },
    { _row: 1, Site: 'River Terminal', GEOID: '28033' },
    { _row: 2, Site: 'Unlocated parcel', GEOID: '' },
  ],
  total: 3,
  page: 1,
  limit: 50,
}

const COLUMN: DerivedColumn = {
  id: 'transmission-miles',
  label: 'Miles to nearest transmission line',
  unit: 'miles',
  method: 'Nearest point on EPRI transmission lines, 2024',
  computedAt: '2026-10-05T09:00:00.000Z',
  values: { '47157': 1.4, '28033': 6.2 },
  rows: 2,
  storedAt: 'manifest',
  type: 'proximity',
  by: 'maria',
  freshness: 'fresh',
  staleNote: '',
  inputs: [],
  rerun: { type: 'proximity', from: 'memphis-sites', to: 'internal-transmission', within: null },
  layerId: '',
}

/** The same column after one of its inputs moved (P7-6). */
const STALE_COLUMN: DerivedColumn = {
  ...COLUMN,
  freshness: 'stale',
  staleNote: '“memphis-sites” has changed since this ran — 4,821 bytes, now 5,002, so this number may have drifted.',
  inputs: [{ slug: 'memphis-sites', role: 'from', verdict: 'stale', reason: '“memphis-sites” has changed' }],
}

function detail(over: Partial<WorkingSetDetail> = {}): WorkingSetDetail {
  return {
    slug: 'memphis-redevelopment',
    name: 'Memphis redevelopment',
    purpose: 'What bears on siting',
    description: 'Working set · 2 datasets · 1 layer',
    datasets: ['memphis-sites', 'epa-superfund-npl'],
    layers: ['internal-sites'],
    sites: 'memphis-sites',
    derivedCount: 0,
    savedBy: 'maria',
    savedAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    views: [
      { slug: 'memphis-map', name: 'Memphis map', type: 'map' },
      { slug: 'memphis-table', name: 'Memphis sites by distance', type: 'table' },
    ],
    members: [
      { slug: 'memphis-sites', kind: 'dataset', title: 'Memphis candidate sites', status: 'published' },
      { slug: 'epa-superfund-npl', kind: 'source', title: 'EPA Superfund NPL', status: 'published' },
    ],
    missing: [],
    ...over,
  }
}

function columnsBody(over: Partial<WorkingSetColumns> = {}): WorkingSetColumns {
  return { slug: 'memphis-redevelopment', name: 'Memphis redevelopment', columns: [], unreadable: [], ...over }
}

function mapView(over: Partial<SavedView> = {}): SavedView {
  return {
    slug: 'memphis-map',
    name: 'Memphis map',
    type: 'map',
    savedBy: 'maria',
    savedAt: '2026-10-04T12:00:00.000Z',
    state: { layers: [], filters: [], limit: null, regionStates: [], prompt: '', viewport: null },
    results: [],
    workingSet: 'memphis-redevelopment',
    ...over,
  }
}

function tableView(state: Record<string, unknown> = {}): SavedView {
  return {
    ...mapView(),
    slug: 'memphis-table',
    name: 'Memphis sites by distance',
    type: 'table',
    state: {
      dataset: 'memphis-sites',
      filters: [{ column: 'Site', op: 'contains', value: 'River' }],
      sort: 'Site',
      dir: 'asc',
      savedRowCount: 1,
      ...state,
    },
  } as unknown as SavedView
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
    updatedAt: '2026-10-03T10:00:00.000Z',
  }
}

// --- Harness ----------------------------------------------------------------

let router: Router
let network: CountyDataFetchStub

/**
 * P9-6a arms a debounced write on a slider drag, and P7-11's lesson is that
 * detached work outliving the test that armed it is what a flaky suite is made
 * of: a 500ms autosave from one test landing in the next one's freshly cleared
 * storage reads as "this draft was restored" with no draft in sight.
 *
 * What unmounts these is `enableAutoUnmount` in `src/testing/vitestSetup.ts` —
 * global, because this file was one of twenty-seven that never unmounted and
 * the next one written would have been twenty-eight.
 */
async function mountAt(view: SavedView, path = '/views/memphis-map') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>map</div>' } },
      { path: '/views/:slug', component: WorkingSetWorkspace, props: true },
      { path: '/analysis', component: { template: '<div />' } },
      { path: '/datasets', component: { template: '<div />' } },
      { path: '/place', component: { template: '<div />' } },
      { path: '/library/:slug', component: { template: '<div />' } },
      { path: '/ask', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(WorkingSetWorkspace, { props: { view }, global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

/** Let `MapPane`'s on-demand canvas land (the `import()` is real I/O). */
async function settleMap(): Promise<void> {
  await import('@/components/MapCanvas.vue')
  for (let i = 0; i < 20; i++) await flushPromises()
}

/** What the open pane's canvas was handed as the answer. */
function paneOnly(w: VueWrapper): string[] | null {
  return w.findComponent(MapPane).props('query').only.value
}

async function switchTo(w: VueWrapper, iface: 'map' | 'data'): Promise<void> {
  await w.get(`[data-interface="${iface}"]`).trigger('click')
  await settleMap()
}

beforeEach(() => {
  network = stubCountyDataFetch({
    'http://localhost:3001/api/layers/internal/memphis-sites': {
      id: 'internal-sites',
      slug: 'memphis-sites',
      geometry: 'county',
      values: { '47157': 2, '28033': 1 },
      range: { min: 0, max: 10 },
    },
  })
  clearInternalLayerCache()
  mockedManifest.mockReset()
  mockedManifest.mockResolvedValue([manifestEntry()])
  mockedSchema.mockReset()
  mockedRows.mockReset()
  mockedOverview.mockReset()
  mockedSummary.mockReset()
  mockedSchema.mockResolvedValue(SCHEMA)
  mockedRows.mockResolvedValue(PAGE)
  mockedOverview.mockResolvedValue([])
  mockedSummary.mockResolvedValue(null as never)
  mockedCountyRows.mockReset()
  mockedCountyRows.mockResolvedValue([])
  mockedFetchView.mockReset()
  mockedFetchViews.mockReset()
  mockedFetchView.mockResolvedValue(null)
  mockedFetchViews.mockResolvedValue([])
  mockedSet.mockReset()
  mockedColumns.mockReset()
  mockedComposite.mockReset()
  mockedSet.mockResolvedValue(detail())
  mockedColumns.mockResolvedValue(columnsBody())
  localStorage.clear()
  restoreViewport()
  resetMapboxStub()
  resetCountyDataCache()
  resetBodyScrollLock()
  stubViewportWidth(1280)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  restoreViewport()
  clearInternalLayerCache()
})

describe('the two interfaces', () => {
  it('names the set both interfaces are over, and the other views reading the same rows', async () => {
    const w = await mountAt(mapView())
    expect(w.get('[data-testid="workspace-title"]').text()).toBe('Memphis map')
    expect(w.get('[data-testid="workspace-set-link"]').text()).toBe('Memphis redevelopment')
    expect(w.get('[data-testid="workspace-holds"]').text()).toContain('2 datasets · 1 layer')
    expect(w.get('[data-testid="workspace-purpose"]').text()).toBe('What bears on siting')
    // A set may carry several views; this one says which the others are.
    expect(w.findAll('[data-testid="workspace-sibling"]').map(a => a.text())).toEqual([
      'Memphis sites by distance',
    ])
  })

  it('reads the set and its columns ONCE, however often the interface is switched', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    await switchTo(w, 'data')
    await switchTo(w, 'map')
    await switchTo(w, 'data')
    expect(mockedSet).toHaveBeenCalledTimes(1)
    expect(mockedColumns).toHaveBeenCalledTimes(1)
    // And the rows the table fetched are not re-fetched to feed the map.
    expect(mockedRows).toHaveBeenCalledTimes(1)
  })

  it('switches without navigating: same path, a replace, nothing else in the query touched', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?q=River')
    const push = vi.spyOn(router, 'push')
    await switchTo(w, 'data')
    expect(router.currentRoute.value.path).toBe('/views/memphis-map')
    expect(router.currentRoute.value.query.interface).toBe('data')
    expect(router.currentRoute.value.query.q).toBe('River')
    expect(push).not.toHaveBeenCalled()
  })

  it('leaves the default interface unsaid in the URL', async () => {
    const w = await mountAt(mapView())
    await switchTo(w, 'data')
    expect(router.currentRoute.value.query.interface).toBe('data')
    await switchTo(w, 'map')
    // A map view's default IS the map, so the key goes away rather than
    // restating what the document says.
    expect(router.currentRoute.value.query.interface).toBeUndefined()
  })
})

describe('a deep link to either interface', () => {
  it('opens a map view on the map', async () => {
    const w = await mountAt(mapView())
    expect(w.get('[data-interface="map"]').attributes('aria-selected')).toBe('true')
    await settleMap()
    expect(w.findComponent(MapPane).exists()).toBe(true)
  })

  it('opens a table view on the data interface, because that view IS a table', async () => {
    const w = await mountAt(tableView(), '/views/memphis-table')
    expect(w.get('[data-interface="data"]').attributes('aria-selected')).toBe('true')
    expect(w.findComponent(MapPane).exists()).toBe(false)
  })

  it('opens ?interface=data there, whatever the view’s own kind', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    expect(w.get('[data-interface="data"]').attributes('aria-selected')).toBe('true')
    expect(w.findComponent(MapPane).exists()).toBe(false)
  })

  it('opens ?interface=map on a table view', async () => {
    const w = await mountAt(tableView(), '/views/memphis-table?interface=map')
    await settleMap()
    expect(w.get('[data-interface="map"]').attributes('aria-selected')).toBe('true')
    expect(w.findComponent(MapPane).exists()).toBe(true)
  })

  it('degrades a hand-edited interface rather than breaking the page', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?interface=sideways')
    expect(w.get('[data-interface="map"]').attributes('aria-selected')).toBe('true')
  })

  it('restores a saved table view’s own query into the URL it is already on', async () => {
    await mountAt(tableView(), '/views/memphis-table')
    const query = router.currentRoute.value.query
    expect(router.currentRoute.value.path).toBe('/views/memphis-table')
    expect(query.filter).toBe(JSON.stringify([{ column: 'Site', op: 'contains', value: 'River' }]))
    expect(query.sort).toBe('Site')
    expect(query.view).toBe('memphis-table')
  })

  it('lets a shared link’s own filters win over the ones the document was saved with', async () => {
    await mountAt(tableView(), '/views/memphis-table?q=Rail')
    expect(router.currentRoute.value.query.q).toBe('Rail')
    expect(router.currentRoute.value.query.filter).toBeUndefined()
  })
})

describe('the filtered subset reaching the map (query.only, P6-10)', () => {
  it('draws the rows the table is showing, and says what the subset is', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    // The blank GEOID is not a county, so the map says nothing about it.
    expect(paneOnly(w)).toEqual(['47157', '28033'])
    expect(w.get('[data-testid="set-map-pane-note"]').text()).toBe('2 counties from 3 rows')
    expect(w.findComponent(MapPane).props('fit')).toEqual({ geoIds: ['47157', '28033'] })
  })

  it('shows THAT subset when a filter is applied in the data interface first', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    mockedRows.mockResolvedValue({ rows: [PAGE.rows[1]], total: 1, page: 1, limit: 50 })
    await router.replace({ path: '/views/memphis-map', query: { interface: 'data', q: 'River' } })
    await flushPromises()

    await switchTo(w, 'map')
    expect(paneOnly(w)).toEqual(['28033'])
    expect(w.get('[data-testid="set-map-pane-note"]').text()).toBe('1 county from 1 row')
    // The filter survived the switch, because a switch is not a navigation.
    expect(router.currentRoute.value.query.q).toBe('River')
  })

  it('names the set on the pane and draws the set’s own layers', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('[data-testid="set-map-pane-layer"]').text()).toBe('Memphis redevelopment')
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual(['internal-sites'])
  })

  it('fetches no county file while the data interface is the one showing', async () => {
    await mountAt(mapView(), '/views/memphis-map?interface=data')
    await settleMap()
    expect(network.askedForCountyData()).toBe(false)
  })

  /**
   * An empty `only` means "the whole layer", so a pane opened before the table
   * has answered would paint all 3,142 counties and snap to the subset a
   * moment later — and that late repaint lands in the middle of the Mapbox
   * style load, which the canvas logs as a missing layer. The gate is one-way:
   * once drawn, a later filter must not tear the canvas down and rebuild it.
   */
  it('waits for the table’s first answer before opening the pane, and never closes it again', async () => {
    let releaseRows: (page: RowsPage) => void = () => {}
    mockedRows.mockReturnValue(new Promise<RowsPage>(resolve => { releaseRows = resolve }))
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.findComponent(MapPane).exists()).toBe(false)

    releaseRows(PAGE)
    await settleMap()
    expect(w.findComponent(MapPane).exists()).toBe(true)
    // Its first paint is already the subset, never the whole layer.
    expect(paneOnly(w)).toEqual(['47157', '28033'])

    // A filter afterwards narrows the pane; it does not unmount it. The uid is
    // the instance's identity — `vm` is a fresh proxy on every lookup.
    const uid = w.findComponent(MapPane).vm.$.uid
    mockedRows.mockResolvedValue({ rows: [PAGE.rows[1]], total: 1, page: 1, limit: 50 })
    await router.replace({ path: '/views/memphis-map', query: { q: 'River' } })
    await settleMap()
    expect(w.findComponent(MapPane).vm.$.uid).toBe(uid)
    expect(paneOnly(w)).toEqual(['28033'])
  })

  it('draws a set with no table to anchor on rather than waiting for rows that will never come', async () => {
    mockedSet.mockResolvedValue(detail({ sites: null, members: [], datasets: ['epa-superfund-npl'] }))
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.findComponent(MapPane).exists()).toBe(true)
    expect(w.get('[data-testid="set-map-pane-note"]').text()).toBe('Every county in these layers')
  })

  /**
   * P9-6 regression. "There is not room for a map here" belongs to the PANE
   * being closed — a phone. It is a `v-else`, and between P9-2 and P9-6 it
   * sat after `SetLayerList`'s `v-if` instead of the pane's, so on a desktop
   * a set with no drawable layers would claim there was no room. None of the
   * other 45 tests here noticed, because none paired a wide viewport with an
   * open pane and checked what was NOT said.
   */
  it('does not claim there is no room when the pane is open', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.findComponent(MapPane).exists()).toBe(true)
    expect(w.find('[data-testid="map-too-narrow"]').exists()).toBe(false)
  })

  it('says so rather than drawing a blank map when the set names no layers', async () => {
    mockedSet.mockResolvedValue(detail({ layers: [] }))
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.findComponent(MapPane).exists()).toBe(false)
    expect(w.get('[data-testid="map-no-layers"]').text()).toContain('names no map layers yet')
  })
})

describe('a derived column, in both interfaces, from one computation', () => {
  beforeEach(() => {
    mockedSet.mockResolvedValue(detail({ derivedCount: 1 }))
    mockedColumns.mockResolvedValue(columnsBody({ columns: [COLUMN] }))
  })

  it('is a sortable column in the data interface', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    const headers = w.findAll('[data-testid="context-header"]').map(th => th.text())
    expect(headers.some(h => h.includes('Miles to nearest transmission line'))).toBe(true)
    expect(w.findAll('[data-testid="context-cell"]').map(td => td.text())).toEqual(['1.4 mi', '6.2 mi', '—'])
  })

  it('is reported over the counties the map interface is drawing, from the same values', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    const row = w.get('[data-testid="derived-row"]')
    expect(row.text()).toContain('Miles to nearest transmission line')
    expect(w.get('[data-testid="derived-range"]').text()).toBe('1.4 mi to 6.2 mi across 2 counties')
    // Where the number came from, because a story quotes it.
    expect(w.get('[data-testid="derived-method"]').text()).toBe('Nearest point on EPRI transmission lines, 2024')
  })

  it('narrows its reported range with the table’s filter — one column, one filter, two readings', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    mockedRows.mockResolvedValue({ rows: [PAGE.rows[0]], total: 1, page: 1, limit: 50 })
    await router.replace({ path: '/views/memphis-map', query: { interface: 'data', q: 'Rail' } })
    await flushPromises()
    await switchTo(w, 'map')
    expect(w.get('[data-testid="derived-range"]').text()).toBe('1.4 mi across 1 county')
  })

  it('says what the column says about a county pressed on the map', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.find('[data-testid="derived-here"]').exists()).toBe(false)
    w.findComponent(MapPane).vm.$emit('county-click', '28033')
    await flushPromises()
    expect(w.get('[data-testid="derived-here"]').text()).toContain('6.2 mi')
  })

  it('shows the column in both interfaces having asked for it once', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('[data-testid="derived-range"]').text()).toBe('1.4 mi to 6.2 mi across 2 counties')
    await switchTo(w, 'data')
    expect(w.findAll('[data-testid="context-cell"]').length).toBe(3)
    expect(mockedColumns).toHaveBeenCalledTimes(1)
  })

  it('says a column it could not read rather than dropping it', async () => {
    mockedColumns.mockResolvedValue(columnsBody({ columns: [], unreadable: ['transmission-miles'] }))
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('[data-testid="derived-unreadable"]').text()).toContain('transmission-miles')
  })

  it('says a column with no numbers for this subset rather than printing a range of nothing', async () => {
    mockedColumns.mockResolvedValue(columnsBody({ columns: [{ ...COLUMN, values: { '13121': 4 }, rows: 1 }] }))
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('[data-testid="derived-range"]').text()).toBe('No numbers for the counties on the map')
  })
})

/**
 * A stale derived column (P7-6).
 *
 * The rule this block exists to hold: a number whose input has moved **still
 * renders**, labelled, with a way to put it right — and the label reaches a
 * reader on BOTH interfaces, because inside the explorer's table a derived
 * column is indistinguishable from a county-context one.
 */
describe('a derived column whose inputs have moved', () => {
  const mockedRerun = vi.mocked(rerunDerivedColumn)

  beforeEach(() => {
    mockedSet.mockResolvedValue(detail({ derivedCount: 1 }))
    mockedColumns.mockResolvedValue(columnsBody({ columns: [STALE_COLUMN] }))
    mockedRerun.mockReset()
  })

  it('still shows every value, with the label beside it', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    // The values are all there — hiding them would leave a published story's
    // number unexplained and a map pane empty.
    expect(w.get('[data-testid="derived-range"]').text()).toBe('1.4 mi to 6.2 mi across 2 counties')
    expect(w.get('[data-testid="derived-stale"]').text()).toBe('Out of date')
    expect(w.get('[data-testid="derived-row"]').attributes('data-freshness')).toBe('stale')
  })

  it('names which input moved, not merely that one did', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    const line = w.get('[data-testid="derived-provenance"]').text()
    expect(line).toContain('“memphis-sites” has changed')
    expect(line).toContain('4,821 bytes, now 5,002')
    // Who and when are still said: the caveat is added to the provenance, not
    // substituted for it.
    expect(line).toContain('by maria')
  })

  it('says so in the HEADER, so the data interface is told too', async () => {
    // The derived list lives inside the map pane. A caveat only the map shows
    // is not a caveat, so the count sits in the header, outside both panes.
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    const line = w.get('[data-testid="workspace-unsound"]').text()
    expect(line).toContain('A derived column is out of date')
    expect(line).toContain('Miles to nearest transmission line')
    // And the table still carries the numbers.
    expect(w.findAll('[data-testid="context-cell"]').map(td => td.text())).toEqual(['1.4 mi', '6.2 mi', '—'])
  })

  it('says nothing in the header when every column is fresh', async () => {
    mockedColumns.mockResolvedValue(columnsBody({ columns: [COLUMN] }))
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    // A label on every column makes the label invisible on the one that needs
    // one.
    expect(w.find('[data-testid="workspace-unsound"]').exists()).toBe(false)
    const fresh = await mountAt(mapView())
    await settleMap()
    expect(fresh.find('[data-testid="derived-stale"]').exists()).toBe(false)
    expect(fresh.find('[data-testid="derived-rerun"]').exists()).toBe(false)
  })

  it('offers a re-run and runs it with the stored arguments', async () => {
    mockedRerun.mockResolvedValue({} as never)
    const w = await mountAt(mapView())
    await settleMap()

    await w.get('[data-testid="derived-rerun"]').trigger('click')
    expect(mockedRerun).toHaveBeenCalledWith('memphis-redevelopment', STALE_COLUMN)

    // And it re-reads the columns afterwards, because a run may have written
    // two of them.
    mockedColumns.mockResolvedValue(columnsBody({ columns: [COLUMN] }))
    await flushPromises()
    expect(mockedColumns).toHaveBeenCalledTimes(2)
  })

  it('shows the ceiling’s own sentence when a re-run is refused', async () => {
    mockedRerun.mockRejectedValue(
      new Error('190,000 rows is a batch job, not a request — run npm run library -- proximity'),
    )
    const w = await mountAt(mapView())
    await settleMap()
    await w.get('[data-testid="derived-rerun"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="derived-rerun-error"]').text()).toContain('npm run library -- proximity')
    // The number is still there behind the error.
    expect(w.get('[data-testid="derived-range"]').text()).toContain('1.4 mi')
  })

  it('offers no re-run for a column that does not record what produced it', async () => {
    // An unchecked column is flagged differently and offers no button, because
    // there is nothing to re-run — a button that guessed would be worse.
    mockedColumns.mockResolvedValue(
      columnsBody({ columns: [{ ...COLUMN, freshness: 'unknown', staleNote: 'cannot be checked', rerun: null }] }),
    )
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('[data-testid="derived-stale"]').text()).toBe('Unchecked')
    expect(w.find('[data-testid="derived-rerun"]').exists()).toBe(false)
    expect(w.get('[data-testid="workspace-unsound"]').text()).toContain('cannot be checked')
  })

  it('says the column is stored rather than recomputed to draw this', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('.derived-note').text()).toContain('Stored on the set, not recomputed')
  })
})

describe('what the set does not have', () => {
  it('says so when the set is not anchored on a table we hold', async () => {
    mockedSet.mockResolvedValue(detail({ sites: null, members: [], datasets: ['epa-superfund-npl'] }))
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    expect(w.get('[data-testid="data-no-anchor"]').text()).toContain('not anchored on a table we hold')
  })

  it('falls back to the first held member when nothing names an anchor', async () => {
    mockedSet.mockResolvedValue(detail({ sites: null }))
    await mountAt(mapView(), '/views/memphis-map?interface=data')
    expect(mockedSchema).toHaveBeenCalledWith('memphis-sites', undefined)
  })

  it('reports a member the library no longer has (P6-23), never a tidier set', async () => {
    mockedSet.mockResolvedValue(detail({ missing: ['eia-transmission'] }))
    const w = await mountAt(mapView())
    expect(w.get('[data-testid="workspace-missing"]').text()).toContain('eia-transmission')
  })

  it('says what happened when the set itself is gone, and offers the map', async () => {
    mockedSet.mockResolvedValue(null)
    const w = await mountAt(mapView())
    const panel = w.get('[data-testid="workspace-set-gone"]')
    expect(panel.text()).toContain('memphis-redevelopment')
    expect(panel.findAll('a').map(a => a.attributes('href'))).toEqual(['/?view=memphis-map', '/analysis'])
    expect(w.find('[data-testid="interface-switch"]').exists()).toBe(false)
  })

  it('reports a failed read in words', async () => {
    mockedSet.mockRejectedValue(new Error('library unavailable'))
    const w = await mountAt(mapView())
    expect(w.get('[data-testid="workspace-error"]').text()).toContain('library unavailable')
  })
})

describe('the data interface does not offer a second map', () => {
  it('leaves the map to the host, because the host draws the whole set', async () => {
    const w = await mountAt(mapView(), '/views/memphis-map?interface=data')
    expect(w.find('[data-testid="show-on-map-open"]').exists()).toBe(false)
    expect(w.find('[data-testid="show-on-map"]').exists()).toBe(false)
    expect(w.findAllComponents(MapPane)).toHaveLength(0)
  })
})

// --- P7-8: an index that draws as its own layer ------------------------------

describe('a composite index on the map interface', () => {
  /** A composite column, which unlike a measurement IS a county layer: every
   *  term's direction is already in the formula, so more of the index is more
   *  of what the index measures. */
  const INDEX: DerivedColumn = {
    id: 'political-efficacy',
    label: 'Political efficacy',
    unit: 'index',
    method: 'Weighted index of 2 county layers…',
    computedAt: '2026-10-05T09:00:00.000Z',
    values: { '47157': 71.4, '28033': 38 },
    rows: 2,
    storedAt: 'manifest',
    type: 'composite',
    by: 'maria',
    freshness: 'fresh',
    staleNote: '',
    inputs: [],
    rerun: {
      type: 'composite',
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
      ],
    },
    layerId: 'internal-memphis-redevelopment~political-efficacy',
  }

  /** The manifest entry the server now builds for it (`derivedLayersOf`), and
   *  its values route — because the whole point of this design is that an
   *  index draws through the ORDINARY internal-layer path, so the test has to
   *  go through that path too. */
  beforeEach(() => {
    mockedSet.mockResolvedValue(detail({ derivedCount: 1 }))
    mockedColumns.mockResolvedValue(columnsBody({ columns: [INDEX] }))
    mockedManifest.mockResolvedValue([
      manifestEntry(),
      {
        ...manifestEntry(),
        id: 'internal-memphis-redevelopment~political-efficacy',
        slug: 'memphis-redevelopment~political-efficacy',
        name: 'Political efficacy',
        dataType: 'index',
        range: { min: 0, max: 100 },
        source: 'Derived from Memphis redevelopment',
      },
    ])
    network = stubCountyDataFetch({
      'http://localhost:3001/api/layers/internal/memphis-sites': {
        id: 'internal-sites',
        slug: 'memphis-sites',
        geometry: 'county',
        values: { '47157': 2, '28033': 1 },
        range: { min: 0, max: 10 },
      },
      'http://localhost:3001/api/layers/internal/memphis-redevelopment~political-efficacy': {
        id: 'internal-memphis-redevelopment~political-efficacy',
        slug: 'memphis-redevelopment~political-efficacy',
        geometry: 'county',
        values: { '47157': 71.4, '28033': 38 },
        range: { min: 0, max: 100 },
      },
    })
  })

  it('prints as a bare 0-100 number in both interfaces', async () => {
    const data = await mountAt(mapView(), '/views/memphis-map?interface=data')
    expect(data.findAll('[data-testid="context-cell"]').map(td => td.text())).toEqual(['71.4', '38.0', '—'])
    const map = await mountAt(mapView())
    await settleMap()
    expect(map.get('[data-testid="derived-range"]').text()).toBe('38.0 to 71.4 across 2 counties')
  })

  it('offers to draw itself, and draws INSTEAD of the set’s layers', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    // The pane starts on the set's own layers.
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual(['internal-sites'])

    await w.get('[data-testid="derived-draw"]').trigger('click')
    await settleMap()
    // Instead of, not as well as: the pane hands every layer it names to the
    // Lens at equal weight, so adding the index as one more term would dilute
    // the very number somebody asked to look at.
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual([
      'internal-memphis-redevelopment~political-efficacy',
    ])
    expect(w.get('[data-testid="derived-draw"]').text()).toContain('Show the set’s layers')
  })

  it('goes back to the set’s layers when pressed again', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    await w.get('[data-testid="derived-draw"]').trigger('click')
    await settleMap()
    await w.get('[data-testid="derived-draw"]').trigger('click')
    await settleMap()
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual(['internal-sites'])
    expect(w.get('[data-testid="derived-draw"]').text()).toBe('Draw on the map')
  })

  it('says which state it is in, for a reader who is not watching the canvas', async () => {
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.get('[data-testid="derived-draw"]').attributes('aria-pressed')).toBe('false')
    await w.get('[data-testid="derived-draw"]').trigger('click')
    expect(w.get('[data-testid="derived-draw"]').attributes('aria-pressed')).toBe('true')
  })

  it('offers nothing of the sort for a measurement', async () => {
    // Nothing in a proximity record says whether being close to a transmission
    // line is an asset or a hazard, so it is not a layer and there is no
    // control — P6-19's rule rather than a missing feature.
    mockedColumns.mockResolvedValue(columnsBody({ columns: [COLUMN] }))
    const w = await mountAt(mapView())
    await settleMap()
    expect(w.find('[data-testid="derived-draw"]').exists()).toBe(false)
  })

  it('stops drawing a column that has gone, rather than painting a layer that is not there', async () => {
    // Stale, so the re-run button is there to press — a re-run is the way a
    // column's list changes under an open page.
    mockedColumns.mockResolvedValue(
      columnsBody({
        columns: [{ ...INDEX, freshness: 'stale', staleNote: '“votes” has changed since this ran.' }],
      }),
    )
    const w = await mountAt(mapView())
    await settleMap()
    await w.get('[data-testid="derived-draw"]').trigger('click')
    await settleMap()
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual([
      'internal-memphis-redevelopment~political-efficacy',
    ])

    // A re-run that renamed the column, a set edited in another tab: the
    // switch must not be left pointing at a layer the manifest no longer has.
    mockedColumns.mockResolvedValue(
      columnsBody({ columns: [{ ...INDEX, id: 'renamed', layerId: 'internal-memphis-redevelopment~renamed' }] }),
    )
    await w.get('[data-testid="derived-rerun"]').trigger('click')
    await flushPromises()
    await settleMap()
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual(['internal-sites'])
  })

  /**
   * P9-6a: the weight editor, wired to the set it is about.
   *
   * The ticket's four questions are the four things asserted here: where the
   * terms come from, what the map shows while somebody drags, what a save
   * does, and what happens to an unsaved formula when they leave. The editor's
   * own arithmetic is `IndexWeightEditor.spec`; this is the wiring.
   */
  describe('weighing it differently (P9-6a)', () => {
    /** The index's internal term, so its row can be NAMED. Its public term
     *  (`poverty_by_race`) needs no manifest — the registry is static. */
    const VOTES: InternalLayerManifestEntry = {
      ...manifestEntry(),
      id: 'internal-votes',
      slug: 'votes',
      name: 'Voter turnout',
      range: { min: 0, max: 100 },
    }

    const SAVED: CompositeRun = {
      set: 'memphis-redevelopment',
      column: 'political-efficacy-v2',
      label: 'Efficacy, housing-weighted',
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 9, direction: 'lower_better' },
      ],
      scales: [],
      reused: false,
      served: 'computed',
      freshness: 'fresh',
      staleNote: '',
      counties: 2,
      complete: 2,
      partial: 0,
      layerId: 'internal-memphis-redevelopment~political-efficacy-v2',
      method: 'Weighted index of 2 county layers…',
      computedAt: '2026-10-08T09:00:00.000Z',
    }

    beforeEach(() => {
      mockedManifest.mockResolvedValue([
        manifestEntry(),
        VOTES,
        {
          ...manifestEntry(),
          id: 'internal-memphis-redevelopment~political-efficacy',
          slug: 'memphis-redevelopment~political-efficacy',
          name: 'Political efficacy',
          dataType: 'index',
          range: { min: 0, max: 100 },
        },
      ])
      network = stubCountyDataFetch({
        'http://localhost:3001/api/layers/internal/memphis-sites': {
          id: 'internal-sites',
          slug: 'memphis-sites',
          geometry: 'county',
          values: { '47157': 2, '28033': 1 },
          range: { min: 0, max: 10 },
        },
        'http://localhost:3001/api/layers/internal/votes': {
          id: 'internal-votes',
          slug: 'votes',
          geometry: 'county',
          values: { '47157': 61, '28033': 44 },
          range: { min: 0, max: 100 },
        },
        'http://localhost:3001/api/layers/internal/memphis-redevelopment~political-efficacy': {
          id: 'internal-memphis-redevelopment~political-efficacy',
          slug: 'memphis-redevelopment~political-efficacy',
          geometry: 'county',
          values: { '47157': 71.4, '28033': 38 },
          range: { min: 0, max: 100 },
        },
      })
    })

    /** Open the editor on the set's one index. */
    async function openWeights(w: VueWrapper): Promise<void> {
      await w.get('[data-testid="derived-weigh"]').trigger('click')
      await flushPromises()
    }

    function slider(w: VueWrapper, row: number) {
      return w.findAll('[data-testid="weight-row"]')[row].find('input[type="range"]')
    }

    it('offers the editor on a formula, and nothing of the sort on a measurement', async () => {
      const w = await mountAt(mapView())
      await settleMap()
      expect(w.get('[data-testid="derived-weigh"]').text()).toBe('Weigh it differently')

      // Nothing in "miles to the nearest line" can be weighed against anything,
      // so there is no control rather than one that refuses.
      mockedColumns.mockResolvedValue(columnsBody({ columns: [COLUMN] }))
      const measured = await mountAt(mapView())
      await settleMap()
      expect(measured.find('[data-testid="derived-weigh"]').exists()).toBe(false)
    })

    it('says why instead of offering a control that opens nothing, on a narrow window', async () => {
      // The editor lives in the map pane, beside the choropleth it repaints,
      // and the pane wants a desktop. Measured at 820px before the fix: the
      // button was there, clicking it relabelled itself "Close the weights",
      // and nothing appeared.
      stubViewportWidth(820)
      const w = await mountAt(mapView())
      await settleMap()
      expect(w.find('[data-testid="derived-weigh"]').exists()).toBe(false)
      expect(w.get('[data-testid="derived-weigh-why"]').text()).toContain('needs a wider window')
    })

    it('opens on the SAVED formula, naming each term instead of printing its id', async () => {
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      // The terms come from the column's own stored record — the same record a
      // re-run reads — so nothing is retyped and nothing is inferred.
      expect(w.findAll('[data-testid="weight-row"]').map(row => row.get('.w-name').text())).toEqual([
        'Voter turnout',
        'Poverty Rate (Black)',
      ])
      expect([slider(w, 0), slider(w, 1)].map(input => (input.element as HTMLInputElement).value)).toEqual([
        '6',
        '4',
      ])
    })

    it('draws the dragged formula INSTEAD of the saved index, and says which it is', async () => {
      const w = await mountAt(mapView())
      await settleMap()
      await w.get('[data-testid="derived-draw"]').trigger('click')
      await settleMap()
      expect(w.findComponent(MapPane).props('layers').internal.value).toEqual([
        'internal-memphis-redevelopment~political-efficacy',
      ])

      // Opening the editor changes nothing: a reader who has not touched a
      // slider is still looking at the record.
      await openWeights(w)
      await settleMap()
      expect(w.find('[data-testid="map-preview-note"]').exists()).toBe(false)
      expect(w.findComponent(MapPane).props('layers').internal.value).toEqual([
        'internal-memphis-redevelopment~political-efficacy',
      ])

      await slider(w, 1).setValue('9')
      await settleMap()

      // One choropleth, and it is the formula on the sliders: the saved index
      // is off the map rather than averaged with its own ingredients.
      const query = w.findComponent(MapPane).props('query')
      expect(query.weights.value).toEqual({ 'internal-votes': 6, poverty_by_race: 9 })
      expect(query.directions.value).toEqual({
        'internal-votes': 'higher_better',
        poverty_by_race: 'lower_better',
      })
      const note = w.get('[data-testid="map-preview-note"]').text()
      expect(note).toContain('unsaved version')
      expect(note).toContain('Political efficacy')
    })

    it('names the preview’s terms in the layer list, public ones included', async () => {
      // A public layer is not in the internal manifest, and was reading as
      // "not in the library any more" — a choropleth the national map draws
      // every day being called missing.
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')
      await settleMap()
      expect(w.findAll('[data-testid="set-layer"]').map(row => row.text())).toEqual([
        expect.stringContaining('Voter turnout'),
        expect.stringContaining('Poverty Rate (Black)'),
      ])
      expect(w.find('[data-testid="set-layer-missing"]').exists()).toBe(false)
    })

    it('stops offering to toggle a term while its weight is on a slider', async () => {
      // Unchecking a previewed term drops it from the scoring query while its
      // slider still shows a weight — measured: scoring went from two terms to
      // one with the slider still reading 6. The sliders would lie about what
      // the map is. A term leaves a formula by being dragged to zero, which the
      // editor labels "out": one control per decision.
      const w = await mountAt(mapView())
      await settleMap()
      expect(w.findAll('[data-testid="set-layer"] input[type="checkbox"]')).toHaveLength(1)

      await openWeights(w)
      await slider(w, 1).setValue('9')
      await settleMap()
      expect(w.findAll('[data-testid="set-layer"]')).toHaveLength(2)
      expect(w.findAll('[data-testid="set-layer"] input[type="checkbox"]')).toHaveLength(0)

      // And the toggles come back the moment the preview does not own the map.
      await w.get('[data-testid="derived-weigh"]').trigger('click')
      await settleMap()
      expect(w.findAll('[data-testid="set-layer"] input[type="checkbox"]')).toHaveLength(1)
    })

    it('says how many counties the drag moved, because the colours barely do', async () => {
      // P9-6c: dropping a whole term out of an eleven-term index repaints
      // about a tenth of the canvas at a maximum channel delta of 20/255 — a
      // real change almost nobody can see. The count is perceptible.
      // Three counties with numbers on both sides: below that `compareIndices`
      // correctly refuses to report a shift at all, which is its own rule and
      // not this one.
      network = stubCountyDataFetch({
        'http://localhost:3001/api/layers/internal/memphis-sites': {
          id: 'internal-sites',
          slug: 'memphis-sites',
          geometry: 'county',
          values: { '47157': 2, '28033': 1, '13121': 3 },
          range: { min: 0, max: 10 },
        },
        'http://localhost:3001/api/layers/internal/votes': {
          id: 'internal-votes',
          slug: 'votes',
          geometry: 'county',
          values: { '47157': 61, '28033': 44, '13121': 52 },
          range: { min: 0, max: 100 },
        },
      })
      mockedColumns.mockResolvedValue(
        columnsBody({
          columns: [{ ...INDEX, values: { '47157': 71.4, '28033': 38, '13121': 55 } }],
        }),
      )
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      expect(w.find('[data-testid="map-preview-shift"]').exists()).toBe(false)

      await slider(w, 1).setValue('9')
      await settleMap()
      const shift = w.find('[data-testid="map-preview-shift"]')
      expect(shift.exists()).toBe(true)
      expect(shift.text()).toMatch(/moved more than|No county changed place/i)
    })

    it('puts the saved formula back on Reset, and clears the preview with it', async () => {
      // Caught in a browser: Reset left a dragged weight exactly where it was,
      // because the editor's own reset copies `props.terms` and those are now
      // the LIVE formula (the host feeds it back so the editor survives being
      // unmounted). Only the host knows what "saved" means.
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')
      await slider(w, 0).setValue('0')
      await settleMap()
      expect(w.find('[data-testid="map-preview-note"]').exists()).toBe(true)

      await w.get('[data-testid="weight-reset"]').trigger('click')
      await settleMap()
      expect([slider(w, 0), slider(w, 1)].map(i => (i.element as HTMLInputElement).value)).toEqual([
        '6',
        '4',
      ])
      // Back to the saved index on the map, so the unsaved-version banner goes.
      expect(w.find('[data-testid="map-preview-note"]').exists()).toBe(false)
    })

    it('says it is opening, rather than going quiet for a second', async () => {
      // `openEditor` awaits the layer manifest so rows carry names not ids. On
      // a cold pane that was over a second of a button reading "Close the
      // weights" with nothing under it — long enough to press it twice and
      // close what never opened, which is what happened in the audit.
      let release!: () => void
      mockedManifest.mockImplementationOnce(
        () => new Promise(resolve => { release = () => resolve([manifestEntry(), VOTES]) }),
      )
      const w = await mountAt(mapView())
      await settleMap()
      mockedManifest.mockImplementationOnce(
        () => new Promise(resolve => { release = () => resolve([manifestEntry(), VOTES]) }),
      )
      await w.get('[data-testid="derived-weigh"]').trigger('click')
      await flushPromises()

      const button = w.get('[data-testid="derived-weigh"]')
      expect(button.text()).toBe('Opening…')
      expect(button.attributes('disabled')).toBeDefined()

      release()
      await flushPromises()
      await settleMap()
      expect(w.get('[data-testid="derived-weigh"]').text()).toBe('Close the weights')
    })

    it('takes a term dragged to zero OUT of the formula it draws', async () => {
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('0')
      await settleMap()
      expect(w.findComponent(MapPane).props('query').weights.value).toEqual({ 'internal-votes': 6 })
      // And it may not be saved as an index of one, which is that layer rescaled.
      expect(w.get('[data-testid="weight-save"]').attributes('disabled')).toBeDefined()
    })

    it('survives a switch to the data interface, part-way through a drag', async () => {
      // The editor sits with the derived columns rather than beside the canvas
      // precisely for this: switching interface tears the pane down, and a
      // formula somebody is part-way through must not go with it.
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')
      await settleMap()
      // A term dragged OUT is the subtle half: it is absent from the live
      // formula (zero means out), so a naive restore snaps it back to its
      // saved weight.
      await slider(w, 0).setValue('0')
      await settleMap()
      await switchTo(w, 'data')
      await switchTo(w, 'map')
      expect((slider(w, 1).element as HTMLInputElement).value).toBe('9')
      expect((slider(w, 0).element as HTMLInputElement).value).toBe('0')
      // And the map came back drawing the same formula the sliders show.
      expect(w.findComponent(MapPane).props('query').weights.value).toEqual({ poverty_by_race: 9 })
    })

    it('saves a VERSION — a new column, drawn, with the old one kept', async () => {
      mockedComposite.mockResolvedValue(SAVED)
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')

      const SAVED_COLUMN: DerivedColumn = {
        ...INDEX,
        id: 'political-efficacy-v2',
        label: 'Efficacy, housing-weighted',
        values: { '47157': 64.2, '28033': 41.5 },
        rerun: { type: 'composite', terms: SAVED.terms },
        layerId: SAVED.layerId,
      }
      mockedColumns.mockResolvedValue(columnsBody({ columns: [INDEX, SAVED_COLUMN] }))

      await w.get('[data-testid="weight-name"]').setValue('Efficacy, housing-weighted')
      await w.get('[data-testid="weight-save"]').trigger('click')
      await flushPromises()
      await settleMap()

      // No `id` is sent: the set GAINS a column and keeps the one it had, which
      // is the whole point of being able to compare two versions.
      expect(mockedComposite).toHaveBeenCalledWith('memphis-redevelopment', {
        label: 'Efficacy, housing-weighted',
        terms: [
          { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
          { layer: 'poverty_by_race', weight: 9, direction: 'lower_better' },
        ],
      })
      // Both columns are on the page without a reload, and the comparison the
      // second version exists to make is now offered.
      expect(w.findAll('[data-testid="derived-row"]')).toHaveLength(2)
      expect(w.find('[data-testid="index-compare"]').exists()).toBe(true)
      // The editor is closed and the preview is gone: what is drawn is a record
      // again, so the note that said otherwise must not still be there.
      expect(w.find('[data-testid="index-weight-editor"]').exists()).toBe(false)
      expect(w.find('[data-testid="map-preview-note"]').exists()).toBe(false)
      expect(readIndexDraft('memphis-redevelopment', 'political-efficacy')).toBeNull()
    })

    it('tells the layer list the new index exists, rather than calling it lost', async () => {
      // Seen after a real save: the map drew the new index and the list under
      // it said "internal-…~heavier-on-black-progress — not in the library any
      // more", because the manifest in hand had been fetched before the layer
      // existed. A saved index IS a new county layer.
      mockedComposite.mockResolvedValue(SAVED)
      const w = await mountAt(mapView())
      await settleMap()
      const readsBefore = mockedManifest.mock.calls.length

      mockedManifest.mockResolvedValue([
        manifestEntry(),
        VOTES,
        {
          ...manifestEntry(),
          id: 'internal-memphis-redevelopment~political-efficacy',
          slug: 'memphis-redevelopment~political-efficacy',
          name: 'Political efficacy',
        },
        {
          ...manifestEntry(),
          id: SAVED.layerId,
          slug: 'memphis-redevelopment~political-efficacy-v2',
          name: 'Efficacy, housing-weighted',
        },
      ])
      mockedColumns.mockResolvedValue(
        columnsBody({
          columns: [
            INDEX,
            { ...INDEX, id: 'political-efficacy-v2', label: SAVED.label, layerId: SAVED.layerId },
          ],
        }),
      )

      await openWeights(w)
      await slider(w, 1).setValue('9')
      await w.get('[data-testid="weight-name"]').setValue('Efficacy, housing-weighted')
      await w.get('[data-testid="weight-save"]').trigger('click')
      await flushPromises()
      await settleMap()

      // The manifest was asked for again…
      expect(mockedManifest.mock.calls.length).toBeGreaterThan(readsBefore)
      // …so the layer the map is now drawing is named, not mourned.
      expect(w.find('[data-testid="set-layer-missing"]').exists()).toBe(false)
      expect(w.findAll('[data-testid="set-layer"]').map(r => r.text())).toEqual([
        expect.stringContaining('Efficacy, housing-weighted'),
      ])
    })

    it('keeps the formula on screen when the save fails', async () => {
      // Losing five minutes of dragging to a 500 would be the worst possible
      // moment to discard it.
      // The server's own sentence, which `friendlyError` passes through word for
      // word: a 413 names the local batch pass, and that is the useful half.
      mockedComposite.mockRejectedValue(
        new Error('14 layers over 62.0 MB of source tables is past the 48.0 MB this parses in a request.'),
      )
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')
      await w.get('[data-testid="weight-name"]').setValue('Efficacy, housing-weighted')
      await w.get('[data-testid="weight-save"]').trigger('click')
      await flushPromises()
      expect(w.get('[data-testid="index-save-error"]').text()).toContain('past the 48.0 MB')
      expect(w.find('[data-testid="index-weight-editor"]').exists()).toBe(true)
      expect((slider(w, 1).element as HTMLInputElement).value).toBe('9')
    })

    it('brings an unsaved formula back after a page leave, and says it is unsaved', async () => {
      vi.useFakeTimers()
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')
      await slider(w, 0).setValue('0')
      vi.advanceTimersByTime(600)
      vi.useRealTimers()
      expect(readIndexDraft('memphis-redevelopment', 'political-efficacy')).toEqual([
        { layer: 'poverty_by_race', weight: 9, direction: 'lower_better' },
      ])

      // A different page, a closed tab, a clicked link: the formula comes back.
      const back = await mountAt(mapView())
      await settleMap()
      await openWeights(back)
      expect(back.get('[data-testid="index-draft-restored"]').text()).toContain('unsaved version')
      // Dragged to zero is OUT, and comes back out — not back at its saved 6.
      expect([slider(back, 0), slider(back, 1)].map(i => (i.element as HTMLInputElement).value)).toEqual([
        '0',
        '9',
      ])
    })

    it('does not call a formula unsaved when it matches the saved one', async () => {
      // Seen on the real page: Reset put the published weights back, the
      // autosave stored them, and reopening announced "an unsaved version from
      // last time" above sliders sitting on exactly the saved index.
      // `PageEditor`'s rule — a draft identical to what is saved is not a draft.
      vi.useFakeTimers()
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await slider(w, 1).setValue('9')
      vi.advanceTimersByTime(600)
      expect(readIndexDraft('memphis-redevelopment', 'political-efficacy')).not.toBeNull()

      // Back to where it started.
      await slider(w, 1).setValue('4')
      vi.advanceTimersByTime(600)
      vi.useRealTimers()
      expect(readIndexDraft('memphis-redevelopment', 'political-efficacy')).toBeNull()

      const back = await mountAt(mapView())
      await settleMap()
      await openWeights(back)
      expect(back.find('[data-testid="index-draft-restored"]').exists()).toBe(false)
    })

    it('throws the restored draft away on request, back to what the set holds', async () => {
      localStorage.setItem(
        indexDraftKey('memphis-redevelopment', 'political-efficacy'),
        JSON.stringify([{ layer: 'poverty_by_race', weight: 9, direction: 'lower_better' }]),
      )
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      await w.get('[data-testid="index-draft-discard"]').trigger('click')
      await settleMap()
      expect(w.find('[data-testid="index-draft-restored"]').exists()).toBe(false)
      expect([slider(w, 0), slider(w, 1)].map(i => (i.element as HTMLInputElement).value)).toEqual(['6', '4'])
      // And the map is back to drawing a record rather than a preview.
      expect(w.find('[data-testid="map-preview-note"]').exists()).toBe(false)
      expect(readIndexDraft('memphis-redevelopment', 'political-efficacy')).toBeNull()
    })

    it('sends a set with the layers but no formula to where a first one is built', async () => {
      // P9-3's rule, and the ticket's first question. Equal weights over a
      // set's candidate layers is a real formula wearing the clothes of a
      // neutral starting point, and a reader cannot tell the difference — so
      // there is exactly one way to make a first formula, and this says where.
      mockedSet.mockResolvedValue(detail({ layers: ['internal-sites', 'internal-votes'], derivedCount: 0 }))
      mockedColumns.mockResolvedValue(columnsBody())
      const w = await mountAt(mapView())
      await settleMap()
      const note = w.get('[data-testid="index-none-yet"]')
      expect(note.text()).toContain('nothing ranking them yet')
      expect(note.get('a').text()).toContain('Create a combined ranking')
      expect(note.get('a').attributes('href')).toBe('/analysis')
      expect(w.find('[data-testid="index-weight-editor"]').exists()).toBe(false)
    })

    it('says nothing of the sort to a set whose other layers are points and lines', async () => {
      // Seen on the redevelopment set: one county layer and five point/line
      // layers read as "layers that could be ranked together", because
      // `registerInternalLayers` puts internal COUNTY layers into
      // `LAYER_REGISTRY` too and the count used both sources. The reader was
      // pointed at a control that would refuse them for having fewer than two.
      mockedSet.mockResolvedValue(
        detail({ layers: ['internal-sites', 'internal-pipelines'], derivedCount: 0 }),
      )
      mockedColumns.mockResolvedValue(columnsBody())
      mockedManifest.mockResolvedValue([
        manifestEntry(),
        {
          ...manifestEntry(),
          id: 'internal-pipelines',
          slug: 'pipelines',
          name: 'Pipelines',
          geometry: 'line',
        },
      ])
      const w = await mountAt(mapView())
      await settleMap()
      expect(w.find('[data-testid="index-none-yet"]').exists()).toBe(false)
    })

    it('says nothing of the sort to a set that already has one', async () => {
      const w = await mountAt(mapView())
      await settleMap()
      expect(w.find('[data-testid="index-none-yet"]').exists()).toBe(false)
    })

    it('ignores a draft whose layers the formula no longer has', async () => {
      // A set edited since is a reason to start from what is saved, not to put
      // weights on screen for a term that is not in the index any more.
      localStorage.setItem(
        indexDraftKey('memphis-redevelopment', 'political-efficacy'),
        JSON.stringify([{ layer: 'internal-gone', weight: 7, direction: 'higher_better' }]),
      )
      const w = await mountAt(mapView())
      await settleMap()
      await openWeights(w)
      expect(w.find('[data-testid="index-draft-restored"]').exists()).toBe(false)
      expect([slider(w, 0), slider(w, 1)].map(i => (i.element as HTMLInputElement).value)).toEqual(['6', '4'])
    })
  })
})
