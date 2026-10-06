import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { mapboxStubModule, resetMapboxStub } from '@/testing/mapboxStub'

// P6-14: "Show on map" opens a real map on this page now, and mapbox-gl needs
// a WebGL canvas it cannot have here.
vi.mock('mapbox-gl', () => mapboxStubModule())

// P6-14: the pane resolves an `internal-…` id against the layer manifest,
// which is the only network call it makes of its own.
vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, sharedManifest: vi.fn() }
})

// P5-48: the county join is real; only the CSV loader behind a layer is faked.
vi.mock('@/lib/publicLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/publicLayers')>()
  return { ...actual, loadCountyRows: vi.fn() }
})

// P5-54: the saved-view API is faked; the shaping helpers around it are real.
vi.mock('@/lib/views', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/views')>()
  return { ...actual, fetchView: vi.fn(), fetchViews: vi.fn(), saveView: vi.fn() }
})

// P5-71: the checklist ticks from the action, so the call is what we assert.
vi.mock('@/lib/firstRun', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/firstRun')>()
  return { ...actual, completeFirstRunStep: vi.fn() }
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

import {
  fetchDatasetSchema,
  fetchDatasetRows,
  fetchColumnSummary,
  fetchColumnOverview,
  DatasetRequestError,
  type DatasetSchema,
  type RowsPage,
  type ColumnSummary,
  type ColumnOverview,
} from '@/lib/libraryData'
import { loadCountyRows, type CountyValueRow } from '@/lib/publicLayers'
import { fetchView, fetchViews, saveView, type SavedView, type SavedViewSummary } from '@/lib/views'
import { completeFirstRunStep } from '@/lib/firstRun'
import DatasetView from '../DatasetView.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'
import { stubCountyDataFetch, type CountyDataFetchStub } from '@/testing/countyData'
import { resetCountyDataCache } from '@/composables/useMapData'
import MapPane from '@/components/MapPane.vue'
import {
  sharedManifest,
  clearInternalLayerCache,
  type InternalLayerManifestEntry,
} from '@/lib/internalLayers'
import { resetBodyScrollLock } from '@/lib/scrollLock'

const mockedSchema = vi.mocked(fetchDatasetSchema)
const mockedRows = vi.mocked(fetchDatasetRows)
const mockedSummary = vi.mocked(fetchColumnSummary)
const mockedOverview = vi.mocked(fetchColumnOverview)
const mockedCountyRows = vi.mocked(loadCountyRows)
const mockedFetchView = vi.mocked(fetchView)
const mockedFetchViews = vi.mocked(fetchViews)
const mockedSaveView = vi.mocked(saveView)
const mockedFirstRun = vi.mocked(completeFirstRunStep)

const SCHEMA: DatasetSchema = {
  entry: { slug: 'orgs', title: 'Organizations', kind: 'dataset' },
  file: 'organizations.csv',
  files: ['organizations.csv', 'states.csv'],
  columns: [
    { name: 'Organization', type: 'string', filled: 3, distinct: 3 },
    { name: 'Tier', type: 'string', filled: 3, distinct: 2, topValues: [{ value: 'Tier 1', count: 2 }, { value: 'Tier 2', count: 1 }] },
    { name: 'HQ State', type: 'string', filled: 3, distinct: 2, topValues: [{ value: 'GA', count: 2 }, { value: 'NY', count: 1 }] },
    { name: 'Score', type: 'number', filled: 2, distinct: 2, min: 75, max: 90, mean: 82.5 },
    { name: 'Website', type: 'string', filled: 3, distinct: 3 },
  ],
  rowCount: 3,
  bytes: 200,
  parsedAt: '2026-09-03T00:00:00.000Z',
  layer: null,
}

const PAGE: RowsPage = {
  rows: [
    { _row: 0, Organization: 'Black Farmer Fund', Tier: 'Tier 1', 'HQ State': 'NY', Score: '90', Website: 'https://blackfarmerfund.org' },
    { _row: 1, Organization: 'Southwest Georgia Project', Tier: 'Tier 1', 'HQ State': 'GA', Score: '75', Website: 'https://swgaproject.com' },
    { _row: 2, Organization: 'Truly Living Well', Tier: 'Tier 2', 'HQ State': 'GA', Score: '', Website: 'https://trulylivingwell.com' },
  ],
  total: 3,
  page: 1,
  limit: 50,
}

/** P5-48 fixtures: a table that carries a county GEOID (as P5-23 geocoding
 *  writes it, next to lat/lng) and one layer's county values. */
const GEO_SCHEMA: DatasetSchema = {
  ...SCHEMA,
  entry: { slug: 'geo', title: 'Sites', kind: 'dataset' },
  file: 'sites.csv',
  files: ['sites.csv'],
  columns: [
    { name: 'Organization', type: 'string', filled: 3, distinct: 3 },
    { name: 'GEOID', type: 'string', filled: 2, distinct: 2 },
    { name: 'lat', type: 'number', filled: 2, distinct: 2 },
    { name: 'lng', type: 'number', filled: 2, distinct: 2 },
  ],
}

const GEO_PAGE: RowsPage = {
  rows: [
    { _row: 0, Organization: 'Black Farmer Fund', GEOID: '36061', lat: '40.7', lng: '-74' },
    { _row: 1, Organization: 'Southwest Georgia Project', GEOID: '13321', lat: '31.5', lng: '-84.2' },
    { _row: 2, Organization: 'Truly Living Well', GEOID: '', lat: '', lng: '' },
  ],
  total: 3,
  page: 1,
  limit: 50,
}

const HOME_VALUES: CountyValueRow[] = [
  { geoId: '36061', county: 'New York County', state: 'New York', value: 900000, display: '$900,000' },
  { geoId: '13321', county: 'Sumter County', state: 'Georgia', value: 84500, display: '$84,500' },
]

let router: Router
async function mountAt(path = '/library/orgs/data') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/library/:slug/data', component: DatasetView },
      { path: '/library/:slug', component: { template: '<div />' } },
      // P5-41: where the Ask box sends a question.
      { path: '/ask', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(DatasetView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

/** P5-42 fixtures: what the summary API says about this filtered set. */
const OVERVIEW: ColumnOverview[] = [
  { column: 'Organization', type: 'string', filledPct: 100, distinct: 3 },
  { column: 'Tier', type: 'string', filledPct: 100, distinct: 2 },
  { column: 'HQ State', type: 'string', filledPct: 100, distinct: 2 },
  { column: 'Score', type: 'number', filledPct: 66.7, distinct: 2 },
  { column: 'Website', type: 'string', filledPct: 100, distinct: 3 },
]

const TIER_SUMMARY: ColumnSummary = {
  column: 'Tier',
  type: 'string',
  filled: 3,
  empty: 0,
  distinct: 2,
  top: [
    { value: 'Tier 1', count: 2 },
    { value: 'Tier 2', count: 1 },
  ],
  numbers: null,
  dates: null,
}

const SCORE_SUMMARY: ColumnSummary = {
  column: 'Score',
  type: 'number',
  filled: 2,
  empty: 1,
  distinct: 2,
  top: [
    { value: '75', count: 1 },
    { value: '90', count: 1 },
  ],
  numbers: {
    min: 75,
    max: 90,
    mean: 82.5,
    median: 82.5,
    histogram: Array.from({ length: 10 }, (_, i) => ({ from: 75 + i * 1.5, to: 75 + (i + 1) * 1.5, count: i === 0 || i === 9 ? 1 : 0 })),
  },
  dates: null,
}

const DATE_SUMMARY: ColumnSummary = {
  column: 'Website',
  type: 'date',
  filled: 3,
  empty: 0,
  distinct: 3,
  top: [],
  numbers: null,
  dates: { min: '2022-06-30', max: '2024-03-01' },
}

beforeEach(() => {
  mockedSchema.mockReset()
  mockedRows.mockReset()
  mockedSummary.mockReset()
  mockedOverview.mockReset()
  mockedSchema.mockResolvedValue(SCHEMA)
  mockedRows.mockResolvedValue(PAGE)
  mockedOverview.mockResolvedValue(OVERVIEW)
  mockedSummary.mockResolvedValue(TIER_SUMMARY)
  mockedCountyRows.mockReset()
  mockedCountyRows.mockResolvedValue(HOME_VALUES)
  mockedFetchView.mockReset()
  mockedFetchViews.mockReset()
  mockedSaveView.mockReset()
  mockedFetchView.mockResolvedValue(null)
  mockedFetchViews.mockResolvedValue([])
  mockedFirstRun.mockReset()
  mockedSaveView.mockResolvedValue({ slug: 'georgia-orgs', name: 'Georgia orgs' })
  localStorage.clear()
  // A width stubbed by one case must not decide the next one's layout, and a
  // map from one must not be the map the next one reads (P6-14).
  restoreViewport()
  resetMapboxStub()
  resetCountyDataCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  restoreViewport()
})

describe('DatasetView', () => {
  it('renders the title, headers, rows, and counts from the schema + rows APIs', async () => {
    const w = await mountAt()
    expect(w.find('h1').text()).toBe('Organizations')
    expect(w.get('[data-testid="row-count"]').text()).toBe('3 rows · 5 columns')
    expect(w.findAll('thead th').map(th => th.find('.sort-btn').text())).toEqual(['Organization', 'Tier', 'HQ State', 'Score', 'Website'])
    expect(w.findAll('tbody tr')).toHaveLength(3)
    expect(w.get('[data-testid="showing"]').text()).toBe('Showing 1–3 of 3')
    expect(mockedSchema).toHaveBeenCalledWith('orgs', undefined)
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', {})
  })

  it('initialises from the URL and passes that state to the rows API', async () => {
    await mountAt('/library/orgs/data?q=georgia&sort=Score&dir=desc&page=2&limit=25')
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', { q: 'georgia', sort: 'Score', dir: 'desc', page: 2, limit: 25 })
  })

  it('header clicks cycle sort asc → desc → none and write the URL', async () => {
    const w = await mountAt()
    const scoreHeader = () => w.findAll('thead th')[3]
    await scoreHeader().find('.sort-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ sort: 'Score' })
    expect(scoreHeader().attributes('aria-sort')).toBe('ascending')
    await scoreHeader().find('.sort-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ sort: 'Score', dir: 'desc' })
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', { sort: 'Score', dir: 'desc' })
    await scoreHeader().find('.sort-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('debounces the search box into ?q=', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await mountAt()
    await w.get('input[type="search"]').setValue('georgia')
    expect(router.currentRoute.value.query.q).toBeUndefined()
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBe('georgia')
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', { q: 'georgia' })
  })

  it('applies and removes a column filter through the header popover and chips', async () => {
    const w = await mountAt()
    const stateHeader = w.findAll('thead th')[2]
    await stateHeader.find('.filter-btn').trigger('click')
    const pop = stateHeader.get('[data-testid="filter-pop"]')
    await pop.get('select').setValue('eq')
    await pop.get('input').setValue('GA')
    await pop.trigger('submit')
    await flushPromises()
    expect(JSON.parse(String(router.currentRoute.value.query.filter))).toEqual([{ column: 'HQ State', op: 'eq', value: 'GA' }])
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', { filter: [{ column: 'HQ State', op: 'eq', value: 'GA' }] })
    const chips = w.get('[data-testid="filter-chips"]')
    expect(chips.text()).toContain('HQ State')
    expect(chips.text()).toContain('“GA”')
    await chips.get('.chip-x').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.filter).toBeUndefined()
    expect(w.find('[data-testid="filter-chips"]').exists()).toBe(false)
  })

  it('schema panel top values are one-click "is" filters', async () => {
    const w = await mountAt()
    await w.findAll('.tool-btn').find(b => b.text() === 'Schema')!.trigger('click')
    const panel = w.get('[data-testid="schema-panel"]')
    expect(panel.text()).toContain('number · 2/3 filled · 75 – 90')
    await panel.findAll('.top-value').find(b => b.text().startsWith('Tier 2'))!.trigger('click')
    await flushPromises()
    expect(JSON.parse(String(router.currentRoute.value.query.filter))).toEqual([{ column: 'Tier', op: 'eq', value: 'Tier 2' }])
  })

  it('opens a row drawer with every field; http URLs become links', async () => {
    const w = await mountAt()
    await w.findAll('tbody tr')[1].trigger('click')
    const drawer = w.get('[data-testid="row-drawer"]')
    expect(drawer.text()).toContain('Row 2')
    expect(drawer.text()).toContain('Southwest Georgia Project')
    // The field list's own link, not the action row above it (P5-60).
    const link = drawer.get('.drawer-fields a')
    expect(link.attributes('href')).toBe('https://swgaproject.com')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    await drawer.get('[data-testid="row-drawer-close"]').trigger('click')
    expect(w.find('[data-testid="row-drawer"]').exists()).toBe(false)
  })

  it('column chooser hides columns and persists the choice per dataset file', async () => {
    const w = await mountAt()
    await w.findAll('.tool-btn').find(b => b.text().startsWith('Columns'))!.trigger('click')
    const boxes = w.get('[data-testid="columns-panel"]').findAll('input[type="checkbox"]')
    await boxes[4].setValue(false)
    expect(w.findAll('thead th').map(th => th.find('.sort-btn').text())).toEqual(['Organization', 'Tier', 'HQ State', 'Score'])
    expect(JSON.parse(localStorage.getItem('blo.dataset.hidden.orgs.organizations.csv')!)).toEqual(['Website'])
    // the drawer still shows hidden columns
    await w.findAll('tbody tr')[0].trigger('click')
    expect(w.get('[data-testid="row-drawer"]').text()).toContain('Website')
  })

  it('offers Show on map from the header and per row when the entry powers a point layer (P5-36)', async () => {
    mockedSchema.mockResolvedValue({ ...SCHEMA, layer: { id: 'internal-orgs', geometry: 'point', name: 'Organizations (HQ)', labelKey: 'Organization' } })
    const w = await mountAt()
    expect(w.get('[data-testid="show-on-map"]').attributes('href')).toBe('/?layers=internal-orgs')
    await w.findAll('tbody tr')[1].trigger('click')
    expect(w.get('[data-testid="row-show-on-map"]').attributes('href')).toBe('/?layers=internal-orgs&focus=internal-orgs%3ASouthwest+Georgia+Project')
    mockedSchema.mockResolvedValue(SCHEMA)
    const plain = await mountAt('/library/plain/data')
    expect(plain.find('[data-testid="show-on-map"]').exists()).toBe(false)
  })

  it('shows the server refusal (413 download hint) instead of a table', async () => {
    mockedSchema.mockRejectedValueOnce(new DatasetRequestError(413, 'big.csv is 40.0 MB — larger than the 25.0 MB browse limit; download it instead'))
    const w = await mountAt('/library/big/data')
    expect(w.get('[data-testid="dataset-error"]').text()).toContain('download it instead')
    expect(w.find('table').exists()).toBe(false)
    expect(mockedRows).not.toHaveBeenCalled()
  })

  it('shows an empty note with a clear action when nothing matches', async () => {
    mockedRows.mockResolvedValue({ rows: [], total: 0, page: 1, limit: 50 })
    const w = await mountAt('/library/orgs/data?q=zzz')
    expect(w.get('[data-testid="empty-note"]').text()).toContain('No rows match')
    await w.get('[data-testid="empty-note"] button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })
})

/**
 * P5-42: analysis for a researcher who does not write code — the overview
 * strip, the Summaries panel, group by, click-to-filter, and the CSV.
 */
describe('DatasetView — analysis (P5-42)', () => {
  /** Open the Summaries panel from the toolbar. */
  async function openSummaries(w: Awaited<ReturnType<typeof mountAt>>) {
    await w.get('[data-testid="summaries-toggle"]').trigger('click')
    await flushPromises()
  }

  /** Open one column's header menu and pick Summarize / Group by. */
  async function fromHeaderMenu(w: Awaited<ReturnType<typeof mountAt>>, index: number, testid: string) {
    const th = w.findAll('thead th')[index]
    await th.find('.filter-btn').trigger('click')
    await th.get(`[data-testid="${testid}"]`).trigger('click')
    await flushPromises()
  }

  it('shows an overview strip, and counts the matches only once something narrows the file', async () => {
    const plain = await mountAt()
    expect(plain.get('[data-testid="overview-strip"]').text()).toBe('3 rows · 5 columns')

    mockedRows.mockResolvedValue({ ...PAGE, rows: PAGE.rows.slice(0, 2), total: 2 })
    const filtered = await mountAt('/library/orgs/data?q=georgia')
    expect(filtered.get('[data-testid="overview-strip"]').text()).toBe('3 rows · 2 match your filters · 5 columns')

    // sorting moves rows around, it does not remove any — no match count
    const sorted = await mountAt('/library/orgs/data?sort=Score')
    expect(sorted.get('[data-testid="overview-strip"]').text()).toBe('3 rows · 5 columns')
  })

  it('the Summaries toggle lists every column with how much of it is filled in', async () => {
    const w = await mountAt()
    expect(w.find('[data-testid="summaries-panel"]').exists()).toBe(false)
    await openSummaries(w)
    expect(mockedOverview).toHaveBeenCalledWith('orgs', {})
    const rows = w.get('[data-testid="overview-list"]').findAll('.overview-row')
    expect(rows.map(r => r.get('.ov-name').text())).toEqual(['Organization', 'Tier', 'HQ State', 'Score', 'Website'])
    expect(rows[3].text()).toContain('67% filled')
    expect(rows[3].get('.ov-fill').attributes('style')).toContain('width: 66.7%')
  })

  it('shows a skeleton while the summaries are still loading', async () => {
    mockedOverview.mockReturnValue(new Promise(() => {}))
    const w = await mountAt()
    await openSummaries(w)
    expect(w.find('[data-testid="overview-skeleton"]').exists()).toBe(true)
    expect(w.find('[data-testid="overview-list"] .overview-row').exists()).toBe(false)
  })

  it('Summarize in a column header menu shows the distribution in plain words', async () => {
    const w = await mountAt()
    await fromHeaderMenu(w, 1, 'summarize-column')
    expect(mockedSummary).toHaveBeenCalledWith('orgs', {}, 'Tier', { groupBy: false })
    const panel = w.get('[data-testid="column-summary"]')
    expect(panel.text()).toContain('Filled')
    expect(panel.text()).toContain('3 of 3 (100%)')
    expect(panel.text()).toContain('Different values')
    expect(panel.text()).toContain('Most common')
    // no jargon
    expect(panel.text()).not.toMatch(/aggregate|facet|cardinality|distinct/i)
    const bars = panel.get('[data-testid="distribution-bars"]').findAll('.bar-row')
    expect(bars[0].text()).toContain('Tier 1')
    expect(bars[0].get('.bar-count').text()).toBe('2')
    expect(bars[0].get('.bar-share').text()).toBe('67%')
    expect(bars[1].get('.bar-share').text()).toBe('33%')
  })

  it('describes a number column with smallest / middle / largest and a ten-bar histogram', async () => {
    mockedSummary.mockResolvedValue(SCORE_SUMMARY)
    const w = await mountAt()
    await fromHeaderMenu(w, 3, 'summarize-column')
    const numbers = w.get('[data-testid="number-summary"]')
    expect(numbers.text()).toContain('Smallest')
    expect(numbers.text()).toContain('Middle')
    expect(numbers.text()).toContain('Largest')
    expect(numbers.text()).toContain('75')
    expect(numbers.text()).toContain('90')
    // P5-54: the spread is now the SVG chart (ten bins, one column each).
    expect(w.get('[data-testid="chart-columns"]').findAll('rect')).toHaveLength(10)
  })

  it('describes a date column as a range, with no number block', async () => {
    mockedSummary.mockResolvedValue(DATE_SUMMARY)
    const w = await mountAt()
    await fromHeaderMenu(w, 4, 'summarize-column')
    expect(w.get('[data-testid="date-summary"]').text()).toContain('2022-06-30')
    expect(w.get('[data-testid="date-summary"]').text()).toContain('2024-03-01')
    expect(w.find('[data-testid="number-summary"]').exists()).toBe(false)
  })

  it('clicking a bar filters the table through the URL and re-asks for the summary', async () => {
    const w = await mountAt()
    await fromHeaderMenu(w, 1, 'summarize-column')
    mockedSummary.mockClear()
    await w.get('[data-testid="distribution-bars"] .bar-row').trigger('click')
    await flushPromises()
    expect(JSON.parse(String(router.currentRoute.value.query.filter))).toEqual([{ column: 'Tier', op: 'eq', value: 'Tier 1' }])
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', { filter: [{ column: 'Tier', op: 'eq', value: 'Tier 1' }] })
    // the panel follows the table: the counts are now about the smaller set
    expect(mockedSummary).toHaveBeenLastCalledWith('orgs', { filter: [{ column: 'Tier', op: 'eq', value: 'Tier 1' }] }, 'Tier', {
      groupBy: false,
    })
  })

  it('Group by shows a value / count / share table that also filters on click', async () => {
    const w = await mountAt()
    await fromHeaderMenu(w, 1, 'group-by-column')
    expect(mockedSummary).toHaveBeenCalledWith('orgs', {}, 'Tier', { groupBy: true })
    const table = w.get('[data-testid="group-by-table"]')
    expect(table.findAll('thead th').map(th => th.text())).toEqual(['Tier', 'Rows', 'Share'])
    const cells = table.findAll('tbody tr').map(tr => tr.findAll('td').map(td => td.text()))
    expect(cells).toEqual([
      ['Tier 1', '2', '67%'],
      ['Tier 2', '1', '33%'],
    ])
    await table.get('tbody .value-btn').trigger('click')
    await flushPromises()
    expect(JSON.parse(String(router.currentRoute.value.query.filter))).toEqual([{ column: 'Tier', op: 'eq', value: 'Tier 1' }])
  })

  it('the group-by table saves as a CSV without asking the server again', async () => {
    const blobs: Blob[] = []
    const createUrl = vi.fn((blob: Blob) => {
      blobs.push(blob)
      return 'blob:fake'
    })
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = createUrl as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    const names: string[] = []
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download)
    })
    try {
      const w = await mountAt()
      await fromHeaderMenu(w, 1, 'group-by-column')
      const callsBefore = mockedSummary.mock.calls.length
      await w.get('[data-testid="group-by-csv"]').trigger('click')
      expect(clicked).toHaveBeenCalled()
      expect(names).toEqual(['orgs-Tier-counts.csv'])
      expect(mockedSummary.mock.calls).toHaveLength(callsBefore)
      // jsdom's Blob has no .text(); FileReader is how it reads one.
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(blobs[0])
      })
      expect(text).toBe('Tier,Count,Percent\r\nTier 1,2,66.7\r\nTier 2,1,33.3\r\n')
    } finally {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
      clicked.mockRestore()
    }
  })

  it('goes back to the column list from a summary', async () => {
    const w = await mountAt()
    await fromHeaderMenu(w, 1, 'summarize-column')
    expect(w.find('[data-testid="column-summary"]').exists()).toBe(true)
    await w.get('[data-testid="column-summary"] .back-btn').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="overview-list"]').exists()).toBe(true)
  })

  it('offers a Download filtered CSV link carrying the same search, filters and sort', async () => {
    const w = await mountAt('/library/orgs/data?q=georgia&sort=Score&dir=desc&page=2')
    const href = w.get('[data-testid="export-csv"]').attributes('href')!
    const url = new URL(href, 'http://localhost')
    expect(url.pathname).toBe('/api/library/data/orgs/export.csv')
    expect(url.searchParams.get('q')).toBe('georgia')
    expect(url.searchParams.get('sort')).toBe('Score')
    expect(url.searchParams.get('dir')).toBe('desc')
    // the page you happen to be on is not part of the file
    expect(url.searchParams.get('page')).toBeNull()
    expect(url.searchParams.get('columns')).toBeNull()
  })

  it('narrows the exported columns to the ones left on screen', async () => {
    const w = await mountAt()
    await w.findAll('.tool-btn').find(b => b.text().startsWith('Columns'))!.trigger('click')
    await w.get('[data-testid="columns-panel"]').findAll('input[type="checkbox"]')[4].setValue(false)
    const url = new URL(w.get('[data-testid="export-csv"]').attributes('href')!, 'http://localhost')
    expect(JSON.parse(url.searchParams.get('columns')!)).toEqual(['Organization', 'Tier', 'HQ State', 'Score'])
  })

  it('puts an Ask box at the top, told which dataset the question is about', async () => {
    const w = await mountAt()
    const ask = w.get('[data-testid="ask-box"]')
    expect(ask.get('input').attributes('placeholder')).toBe('Ask about this data…')
    await ask.get('input').setValue('how many are in Georgia?')
    await ask.trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/ask')
    expect(router.currentRoute.value.query).toEqual({ q: 'how many are in Georgia?', dataset: 'orgs' })
  })

  it('shows the summary refusal in the panel instead of an empty chart', async () => {
    mockedOverview.mockRejectedValue(new DatasetRequestError(400, 'unknown column: Nope'))
    const w = await mountAt()
    await w.get('[data-testid="summaries-toggle"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="overview-error"]').text()).toContain('unknown column')
  })
})

describe('DatasetView — group-by CSV includes the blank row (P5-42)', () => {
  it('downloads exactly the table on screen, blanks and all', async () => {
    mockedSummary.mockResolvedValue({ ...TIER_SUMMARY, filled: 2, empty: 1, top: [{ value: 'Tier 1', count: 2 }] })
    const blobs: Blob[] = []
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
    URL.createObjectURL = ((blob: Blob) => {
      blobs.push(blob)
      return 'blob:fake'
    }) as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const w = await mountAt()
      const th = w.findAll('thead th')[1]
      await th.find('.filter-btn').trigger('click')
      await th.get('[data-testid="group-by-column"]').trigger('click')
      await flushPromises()
      const rows = w.get('[data-testid="group-by-table"]').findAll('tbody tr').map(tr => tr.findAll('td').map(td => td.text()))
      expect(rows).toEqual([
        ['Tier 1', '2', '67%'],
        ['(blank)', '1', '33%'],
      ])
      await w.get('[data-testid="group-by-csv"]').trigger('click')
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsText(blobs[0])
      })
      expect(text).toBe('Tier,Count,Percent\r\nTier 1,2,66.7\r\n(blank),1,33.3\r\n')
    } finally {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
      clicked.mockRestore()
    }
  })
})

/**
 * P5-48: county context — the public map's county numbers as extra columns on
 * any table that carries a GEOID.
 */
describe('DatasetView — county context (P5-48)', () => {
  async function openPicker(w: Awaited<ReturnType<typeof mountAt>>) {
    await w.get('[data-testid="county-context-toggle"]').trigger('click')
    await flushPromises()
  }

  /** Pick one layer by name from the picker. */
  async function addLayer(w: Awaited<ReturnType<typeof mountAt>>, name: string) {
    const row = w.findAll('[data-testid="context-layer"]').find(r => r.text().includes(name))!
    await row.get('input').setValue(true)
    await flushPromises()
  }

  const headers = (w: Awaited<ReturnType<typeof mountAt>>) =>
    w.findAll('thead th').map(th => th.find('.sort-btn').text())

  const contextCells = (w: Awaited<ReturnType<typeof mountAt>>) =>
    w.findAll('[data-testid="context-cell"]').map(td => td.text())

  it('offers nothing on a table with no county key', async () => {
    const w = await mountAt()
    expect(w.find('[data-testid="county-context-toggle"]').exists()).toBe(false)
    expect(mockedCountyRows).not.toHaveBeenCalled()
  })

  it('offers the control once the table carries a 5-digit GEOID', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data')
    expect(w.get('[data-testid="county-context-toggle"]').text()).toBe('Add county context')
    // nothing is loaded until a layer is actually chosen
    expect(mockedCountyRows).not.toHaveBeenCalled()
  })

  it('adds a layer as a column, formatted by the layer, with “—” where there is no county', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data')
    await openPicker(w)
    await addLayer(w, 'Median Home Value')

    expect(router.currentRoute.value.query.layers).toBe('median_home_value')
    expect(headers(w)).toEqual(['Organization', 'GEOID', 'lat', 'lng', 'Median Home Value'])
    expect(mockedCountyRows).toHaveBeenCalledTimes(1)
    expect(mockedCountyRows.mock.calls[0][0].id).toBe('median_home_value')
    expect(contextCells(w)).toEqual(['$900,000', '$84,500', '—'])
  })

  it('is a link: the layers in the URL come back as columns without touching the picker', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    expect(headers(w)).toContain('Median Home Value')
    expect(contextCells(w)).toEqual(['$900,000', '$84,500', '—'])
    expect(w.get('[data-testid="county-context-toggle"]').text()).toBe('Add county context (1)')
  })

  it('keeps the columns through a sort, and asks the server for rows only once', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    const rowsCalls = mockedRows.mock.calls.length
    await w.findAll('thead th')[0].find('.sort-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ layers: 'median_home_value', sort: 'Organization' })
    expect(headers(w)).toContain('Median Home Value')
    // the sort cost one rows request; adding the layer cost none
    expect(mockedRows.mock.calls.length).toBe(rowsCalls + 1)
  })

  it('sorts a joined column in the browser, blanks last, without asking the server again', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    const before = mockedRows.mock.calls.length
    const header = () => w.findAll('thead th')[4]

    await header().find('.sort-btn').trigger('click')
    expect(header().attributes('aria-sort')).toBe('ascending')
    expect(contextCells(w)).toEqual(['$84,500', '$900,000', '—'])

    await header().find('.sort-btn').trigger('click')
    expect(header().attributes('aria-sort')).toBe('descending')
    expect(contextCells(w)).toEqual(['$900,000', '$84,500', '—'])

    await header().find('.sort-btn').trigger('click')
    expect(header().attributes('aria-sort')).toBe('none')
    expect(contextCells(w)).toEqual(['$900,000', '$84,500', '—'])
    // client-side: the URL and the server were never involved
    expect(router.currentRoute.value.query.sort).toBeUndefined()
    expect(mockedRows.mock.calls.length).toBe(before)
  })

  it('removes a column from its header, clearing the URL with it', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    await w.get('[data-testid="context-header"] .filter-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.layers).toBeUndefined()
    expect(w.findAll('[data-testid="context-header"]')).toHaveLength(0)
  })

  it('says so when a layer will not load, and leaves the table alone', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    mockedCountyRows.mockRejectedValue(new Error('404'))
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    expect(w.get('[data-testid="context-error"]').text()).toContain('could not be loaded')
    expect(contextCells(w)).toEqual(['—', '—', '—'])
    expect(w.findAll('tbody tr')).toHaveLength(3)
  })

  it('downloads the page with the joined columns, without touching the server export', async () => {
    const created: Blob[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob)
      return 'blob:county'
    })
    vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    // the server export link is untouched and still there
    expect(w.get('[data-testid="export-csv"]').attributes('href')).toContain('/export.csv')

    await w.get('[data-testid="context-csv"]').trigger('click')
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    // jsdom's Blob has no text(); FileReader is the way to read one back.
    const csv = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(created[0])
    })
    expect(csv.split('\r\n')).toEqual([
      'Organization,GEOID,lat,lng,Median Home Value',
      // a leading "-" is a spreadsheet formula, so the server's rule quotes it
      'Black Farmer Fund,36061,40.7,\'-74,"$900,000"',
      'Southwest Georgia Project,13321,31.5,\'-84.2,"$84,500"',
      'Truly Living Well,,,,—',
      '',
    ])
    vi.unstubAllGlobals()
  })

  it('shows the county numbers in the row drawer too', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=median_home_value')
    await flushPromises()
    await w.findAll('tbody tr')[1].trigger('click')
    const drawer = w.get('[data-testid="row-drawer"]')
    expect(drawer.get('[data-testid="drawer-context"]').text()).toBe('Median Home Value')
    expect(drawer.text()).toContain('$84,500')
  })

  it('ignores a layer id it cannot join instead of breaking the table', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data?layers=made_up,internal-orgs')
    await flushPromises()
    expect(w.findAll('[data-testid="context-header"]')).toHaveLength(0)
    expect(mockedCountyRows).not.toHaveBeenCalled()
    expect(w.findAll('tbody tr')).toHaveLength(3)
  })
})

describe('DatasetView — county context on a table with no county key', () => {
  it('joins nothing and downloads nothing, whatever the link asks for', async () => {
    const w = await mountAt('/library/orgs/data?layers=median_home_value')
    await flushPromises()
    expect(w.findAll('[data-testid="context-header"]')).toHaveLength(0)
    expect(w.find('[data-testid="context-csv"]').exists()).toBe(false)
    expect(mockedCountyRows).not.toHaveBeenCalled()
  })
})

/**
 * P5-54: keeping a table. Saving writes the state the explorer is showing;
 * opening one restores it, re-runs the query, and says when the row count
 * has moved. The chart lives in the summary panel and is saved with it.
 */
function savedTableView(overrides: Record<string, unknown> = {}): SavedView {
  return {
    slug: 'georgia-orgs',
    name: 'Georgia orgs',
    type: 'table',
    savedBy: 'maria',
    savedAt: '2026-09-05T12:00:00.000Z',
    state: {
      dataset: 'orgs',
      datasetTitle: 'Organizations',
      filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
      sort: 'Score',
      dir: 'desc',
      savedRowCount: 13,
      ...overrides,
    },
    results: [],
  } as unknown as SavedView
}

const STRIP: SavedViewSummary[] = [
  { slug: 'georgia-orgs', name: 'Georgia orgs', type: 'table', dataset: 'orgs', description: 'Organizations · HQ State is Georgia · 13 rows', savedBy: 'maria', savedAt: '2026-09-05T12:00:00.000Z', resultCount: 0, workingSet: '' },
]

describe('DatasetView — saving a table view (P5-54)', () => {
  it('saves exactly what is on screen: filters, sort, hidden columns, county layers, and the open chart', async () => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue({ ...GEO_PAGE, total: 13 })
    mockedSummary.mockResolvedValue({ ...TIER_SUMMARY, column: 'Organization' })
    const w = await mountAt('/library/geo/data?q=farm&sort=Organization&layers=median_home_value')
    await flushPromises()
    // hide a column and open a summary, so both make it into the view
    await w.findAll('.tool-btn').find(b => b.text().startsWith('Columns'))!.trigger('click')
    await w.get('[data-testid="columns-panel"]').findAll('input')[1].trigger('change')
    const header = w.findAll('thead th')[0]
    await header.find('.filter-btn').trigger('click')
    await header.get('[data-testid="summarize-column"]').trigger('click')
    await flushPromises()

    await w.get('[data-testid="save-view-btn"]').trigger('click')
    await w.get('[data-testid="save-view-form"] input').setValue('Georgia orgs')
    await w.get('[data-testid="save-view-form"]').trigger('submit')
    await flushPromises()

    expect(mockedSaveView).toHaveBeenCalledTimes(1)
    expect(mockedSaveView.mock.calls[0][0]).toEqual({
      name: 'Georgia orgs',
      type: 'table',
      state: {
        dataset: 'geo',
        q: 'farm',
        filters: [],
        sort: 'Organization',
        columns: ['Organization', 'lat', 'lng'],
        layers: ['median_home_value'],
        summary: { column: 'Organization', chart: 'bars' },
        savedRowCount: 13,
      },
    })
  })

  it('shows how to open and how to embed the view it just saved', async () => {
    const w = await mountAt('/library/orgs/data?sort=Score&dir=desc')
    await w.get('[data-testid="save-view-btn"]').trigger('click')
    await w.get('[data-testid="save-view-form"] input').setValue('Georgia orgs')
    await w.get('[data-testid="save-view-form"]').trigger('submit')
    await flushPromises()
    const note = w.get('[data-testid="save-view-note"]')
    expect(note.text()).toContain('open “Georgia orgs”')
    expect(note.text()).toContain('view:georgia-orgs')
    expect(note.get('a').attributes('href')).toBe(
      '/library/orgs?tab=data&sort=Score&dir=desc&view=georgia-orgs',
    )
    expect(w.find('[data-testid="save-view-form"]').exists()).toBe(false)
  })

  it('says why a save failed and keeps the name for another go', async () => {
    mockedSaveView.mockRejectedValue(new Error('the view name needs at least one letter or number'))
    const w = await mountAt()
    await w.get('[data-testid="save-view-btn"]').trigger('click')
    await w.get('[data-testid="save-view-form"] input').setValue('§§§')
    await w.get('[data-testid="save-view-form"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="save-view-error"]').text()).toContain('needs at least one letter')
    expect(w.find('[data-testid="save-view-form"]').exists()).toBe(true)
  })

  it('lists this table\'s saved views, and only asks about this dataset', async () => {
    mockedFetchViews.mockResolvedValue(STRIP)
    const w = await mountAt()
    await flushPromises()
    expect(mockedFetchViews).toHaveBeenCalledWith({ dataset: 'orgs' })
    const strip = w.get('[data-testid="saved-views-strip"]')
    expect(strip.text()).toContain('Georgia orgs')
    expect(strip.get('a').attributes('href')).toBe('/views/georgia-orgs')
    expect(strip.get('a').attributes('title')).toContain('HQ State is Georgia')
  })

  it('has no strip at all when this table has no saved views', async () => {
    const w = await mountAt()
    await flushPromises()
    expect(w.find('[data-testid="saved-views-strip"]').exists()).toBe(false)
  })
})

describe('DatasetView — opening a saved table view (P5-54)', () => {
  it('runs the saved query again and says the count has moved', async () => {
    mockedFetchView.mockResolvedValue(savedTableView())
    mockedRows.mockResolvedValue({ ...PAGE, total: 15 })
    const w = await mountAt('/library/orgs/data?sort=Score&dir=desc&filter=' + encodeURIComponent(JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }])) + '&view=georgia-orgs')
    await flushPromises()
    expect(mockedFetchView).toHaveBeenCalledWith('georgia-orgs')
    // the URL — not the document — is what the rows request is built from
    expect(mockedRows).toHaveBeenLastCalledWith('orgs', {
      sort: 'Score',
      dir: 'desc',
      filter: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
    })
    expect(w.get('[data-testid="saved-view-banner"]').text()).toBe(
      'Saved view: Georgia orgs · saved with 13 rows, now 15',
    )
  })

  it('just names the view when the data has not moved', async () => {
    mockedFetchView.mockResolvedValue(savedTableView({ filters: [], sort: undefined, dir: undefined, savedRowCount: 3 }))
    const w = await mountAt('/library/orgs/data?view=georgia-orgs')
    await flushPromises()
    expect(w.get('[data-testid="saved-view-banner"]').text()).toBe('Saved view: Georgia orgs')
  })

  it('restores the columns that were on screen and the summary that was open', async () => {
    mockedFetchView.mockResolvedValue(
      savedTableView({ filters: [], sort: undefined, dir: undefined, columns: ['Organization', 'Tier'], summary: { column: 'Tier', chart: 'bars' } }),
    )
    const w = await mountAt('/library/orgs/data?view=georgia-orgs')
    await flushPromises()
    expect(w.findAll('thead th').map(th => th.find('.sort-btn').text())).toEqual(['Organization', 'Tier'])
    expect(w.get('[data-testid="column-summary"]').text()).toContain('Tier')
    expect(w.find('[data-testid="chart-bars"]').exists()).toBe(true)
    expect(mockedSummary).toHaveBeenCalledWith('orgs', expect.anything(), 'Tier', { groupBy: false })
  })

  it('restores a saved group-by as the counted table', async () => {
    mockedFetchView.mockResolvedValue(savedTableView({ filters: [], sort: undefined, dir: undefined, summary: { groupBy: 'Tier' } }))
    const w = await mountAt('/library/orgs/data?view=georgia-orgs')
    await flushPromises()
    expect(w.find('[data-testid="group-by-table"]').exists()).toBe(true)
    expect(mockedSummary).toHaveBeenCalledWith('orgs', expect.anything(), 'Tier', { groupBy: true })
  })

  it('says so once the reader has changed the query they arrived with', async () => {
    mockedFetchView.mockResolvedValue(savedTableView({ filters: [], sort: undefined, dir: undefined, savedRowCount: 3 }))
    const w = await mountAt('/library/orgs/data?view=georgia-orgs')
    await flushPromises()
    await w.findAll('thead th')[3].find('.sort-btn').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="saved-view-banner"]').text()).toBe(
      'Saved view: Georgia orgs · you have changed the filters since',
    )
  })

  it('ignores a view that has been deleted, or that belongs to another table', async () => {
    mockedFetchView.mockResolvedValue(null)
    const gone = await mountAt('/library/orgs/data?view=georgia-orgs')
    await flushPromises()
    expect(gone.find('[data-testid="saved-view-banner"]').exists()).toBe(false)
    expect(gone.findAll('tbody tr')).toHaveLength(3)

    mockedFetchView.mockResolvedValue(savedTableView({ dataset: 'somewhere-else' }))
    const other = await mountAt('/library/orgs/data?view=georgia-orgs')
    await flushPromises()
    expect(other.find('[data-testid="saved-view-banner"]').exists()).toBe(false)
  })
})

const COUNTY_LAYER = { id: 'internal-geo', geometry: 'county' as const, name: 'Sites by county', labelKey: null }
const POINT_LAYER = { id: 'internal-geo', geometry: 'point' as const, name: 'Sites', labelKey: 'Organization' }

const mockedSharedManifest = vi.mocked(sharedManifest)

/** The manifest entry behind `internal-geo`, in whichever geometry a case
 *  is about. The pane cannot resolve an internal id without it. */
function manifestEntry(geometry: 'county' | 'point' | 'line' | 'state'): InternalLayerManifestEntry {
  return {
    id: 'internal-geo',
    slug: 'geo',
    name: geometry === 'county' ? 'Sites by county' : 'Sites',
    geometry,
    dataType: 'count',
    unit: '',
    direction: 'higher_better',
    range: { min: 0, max: 10 },
    description: '',
    source: '',
    year: 2026,
    file: null,
    color: null,
    popupFields: [],
    bbox: null,
    updatedAt: '2026-10-03T10:00:00.000Z',
  }
}

/** Let `MapPane`'s on-demand canvas land. The `import()` is real I/O the
 *  first time; that the page defers it at all is the point. */
async function settleMap(): Promise<void> {
  await import('@/components/MapCanvas.vue')
  for (let i = 0; i < 20; i++) await flushPromises()
}

/** Press "Show on map" and let the pane appear. */
async function openMapPane(w: VueWrapper): Promise<void> {
  await w.get('[data-testid="show-on-map-open"]').trigger('click')
  await settleMap()
}

/** What the open pane's canvas was handed as the answer. */
function paneOnly(w: VueWrapper): string[] | null {
  return w.findComponent(MapPane).props('query').only.value
}

/**
 * P6-14. The dataset explorer is the call site the ticket is really about: a
 * server-paged, searched, filtered, sorted table whose subset a
 * `?layers=internal-<slug>` link has no way to name. The pane names it.
 */
describe('DatasetView — Show on map, in place (P6-14)', () => {
  let network: CountyDataFetchStub

  beforeEach(() => {
    // The layer's own numbers, so a registered internal layer has something
    // to paint instead of warning that it could not look them up.
    network = stubCountyDataFetch({
      'http://localhost:3001/api/layers/internal/geo': {
        id: 'internal-geo',
        slug: 'geo',
        geometry: 'county',
        values: { '36061': 2, '13321': 1 },
        range: { min: 0, max: 10 },
      },
    })
    clearInternalLayerCache()
    mockedSharedManifest.mockReset()
    mockedSharedManifest.mockResolvedValue([manifestEntry('county')])
    mockedSchema.mockResolvedValue({ ...GEO_SCHEMA, layer: COUNTY_LAYER })
    mockedRows.mockResolvedValue(GEO_PAGE)
  })

  afterEach(clearInternalLayerCache)

  it('fetches no county file until the pane is opened', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/library/geo/data')

    expect(network.askedForCountyData()).toBe(false)
    expect(w.find('[data-testid="dataset-map-pane"]').exists()).toBe(false)

    await openMapPane(w)
    expect(w.find('[data-testid="dataset-map-pane"]').exists()).toBe(true)
    expect(network.askedForCountyData()).toBe(true)
  })

  it('draws the rows on screen, and says how many of the matched rows that is', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/library/geo/data')
    await openMapPane(w)

    expect(w.get('[data-testid="dataset-map-pane-layer"]').text()).toBe('Sites by county')
    expect(w.findComponent(MapPane).props('layers').internal.value).toEqual(['internal-geo'])
    // The blank GEOID is not a county, so the map says nothing about it.
    expect(paneOnly(w)).toEqual(['36061', '13321'])
    expect(w.get('[data-testid="dataset-map-pane-note"]').text()).toBe('2 of 3 rows')
    expect(w.findComponent(MapPane).props('fit')).toEqual({ geoIds: ['36061', '13321'] })
  })

  it('draws only the filtered rows, and the filter survives the pane opening', async () => {
    stubViewportWidth(1280)
    mockedRows.mockResolvedValue({
      rows: [{ _row: 1, Organization: 'Southwest Georgia Project', GEOID: '13321', lat: '31.5', lng: '-84.2' }],
      total: 1,
      page: 1,
      limit: 50,
    })
    const w = await mountAt('/library/geo/data?q=Georgia')
    const before = router.currentRoute.value.fullPath

    await openMapPane(w)

    expect(paneOnly(w)).toEqual(['13321'])
    expect(w.get('[data-testid="dataset-map-pane-note"]').text()).toBe('1 of 1 rows')
    // Opening a map is not a navigation: the filter, and the URL that holds
    // it, are exactly as they were.
    expect(router.currentRoute.value.fullPath).toBe(before)
    expect(router.currentRoute.value.query.q).toBe('Georgia')
    expect((w.get('input[type="search"]').element as HTMLInputElement).value).toBe('Georgia')
  })

  it('draws a point layer whole and says so, because `only` cannot filter dots', async () => {
    stubViewportWidth(1280)
    mockedSchema.mockResolvedValue({ ...GEO_SCHEMA, layer: POINT_LAYER })
    mockedSharedManifest.mockResolvedValue([manifestEntry('point')])
    const w = await mountAt('/library/geo/data')
    await openMapPane(w)

    // The header names the layer this page means, not the choropleth that
    // happens to be under it.
    expect(w.get('[data-testid="dataset-map-pane-layer"]').text()).toBe('Sites')
    // It goes on as an overlay, with its own source and its own markers…
    expect(w.findComponent(MapPane).props('layers').points.value).toEqual(['internal-geo'])
    // …and dimming county polygons would read as "these are your rows" while
    // every dot — which is what a row is here — stayed on the map.
    expect(paneOnly(w)).toBeNull()
    expect(w.get('[data-testid="dataset-map-pane-note"]').text()).toBe('Every point in this layer')
  })

  // P7-9: the same claim, named for the geometry. This read `=== 'point'`, so
  // a line layer — and then a state layer — fell through to counting GEOIDs
  // and told the reader "No counties in these rows". True, and not the
  // fidelity claim they need.
  it.each([
    ['line' as const, 'Every line in this layer'],
    ['state' as const, 'Every state in this layer'],
  ])('says what a %s layer draws, instead of counting counties it has none of', async (geometry, note) => {
    stubViewportWidth(1280)
    mockedSchema.mockResolvedValue({ ...GEO_SCHEMA, layer: { ...POINT_LAYER, geometry } })
    mockedSharedManifest.mockResolvedValue([manifestEntry(geometry)])
    const w = await mountAt('/library/geo/data')
    await openMapPane(w)
    expect(paneOnly(w)).toBeNull()
    expect(w.get('[data-testid="dataset-map-pane-note"]').text()).toBe(note)
  })

  it('closes back to the table, leaving the page as it was', async () => {
    stubViewportWidth(1280)
    const w = await mountAt('/library/geo/data')
    await openMapPane(w)

    await w.get('[data-testid="dataset-map-pane-close"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="dataset-map-pane"]').exists()).toBe(false)
    expect(router.currentRoute.value.fullPath).toBe('/library/geo/data')
    expect(w.findAll('tbody tr.data-row')).toHaveLength(3)
  })

  it('keeps the deep link on a narrow window, unchanged', async () => {
    stubViewportWidth(800)
    const w = await mountAt('/library/geo/data')

    expect(w.find('[data-testid="show-on-map-open"]').exists()).toBe(false)
    expect(w.get('[data-testid="show-on-map"]').attributes('href')).toBe('/?layers=internal-geo')
  })

  it('offers no map at all for a dataset that powers no layer', async () => {
    stubViewportWidth(1280)
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    const w = await mountAt('/library/geo/data')

    expect(w.find('[data-testid="show-on-map-open"]').exists()).toBe(false)
    expect(w.find('[data-testid="show-on-map"]').exists()).toBe(false)
  })
})

/**
 * P5-60: the explorer on a phone. The audit measured this page scrolling
 * 4,797 px sideways at 375 px, a toolbar that overflowed, ~19 px sort
 * buttons and a row drawer with no phone layout at all.
 *
 * jsdom lays nothing out, so the rules are asserted where they are written —
 * in the component's own `<style>` block — and the markup they hang off is
 * asserted in the DOM. `matchMedia` is faked for the one thing that is
 * genuinely behaviour rather than layout: the page holding still behind a
 * bottom sheet.
 */
const DATASET_SFC = readStyles('src/views/DatasetView.vue')
const DATASET_PHONE = mediaBlock(DATASET_SFC, 640)

/** Make every component that asks think it is (or is not) on a phone. */
function fakeMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

describe('DatasetView — phone layout (P5-60)', () => {
  afterEach(() => {
    resetBodyScrollLock()
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('keeps the table’s width inside its own scroll box', () => {
    // The wrapper clips…
    const wrapper = ruleFor(DATASET_SFC, '.table-scroll')
    expect(wrapper).toContain('overflow-x: auto')
    expect(wrapper).toContain('max-width: 100%')
    // …and every flex ancestor it sits in can shrink below the table's width.
    expect(ruleFor(DATASET_SFC, '.table-area')).toContain('min-width: 0')
    expect(ruleFor(DATASET_SFC, '.work-area')).toContain('min-width: 0')
    expect(ruleFor(DATASET_SFC, '.dataset-view')).toContain('min-width: 0')
    expect(ruleFor(DATASET_SFC, '.dataset-header')).toContain('min-width: 0')
  })

  it('pins the first column while the rest of the table scrolls', () => {
    const body = ruleFor(DATASET_PHONE, '.data-table tbody td:first-child')
    expect(body).toContain('position: sticky')
    expect(body).toContain('left: 0')
    // Opaque, or the scrolling cells would read straight through it.
    expect(body).toContain('background:')
    expect(ruleFor(DATASET_PHONE, '.data-table thead th:first-child')).toContain('left: 0')
  })

  it('puts the actions in one strip of 44 px buttons under the search row', async () => {
    const w = await mountAt()
    const strip = w.get('[data-testid="toolbar-actions"]')
    expect(strip.text()).toContain('Summaries')
    expect(strip.text()).toContain('Download filtered CSV')
    expect(strip.text()).toContain('Save view')
    // Every action in the strip is a tap target, not a 19 px pill.
    const actions = strip.findAll('.tool-btn')
    expect(actions.length).toBeGreaterThanOrEqual(5)
    expect(actions.every(a => a.classes('touch-target'))).toBe(true)

    expect(ruleFor(DATASET_PHONE, '.toolbar')).toContain('flex-direction: column')
    expect(ruleFor(DATASET_PHONE, '.toolbar-actions')).toContain('overflow-x: auto')
    expect(ruleFor(DATASET_PHONE, '.tool-btn')).toContain('min-height: 44px')
  })

  it('makes the whole header cell the sort control', async () => {
    const w = await mountAt()
    // The button, not the cell, carries the padding — so the tap area is the cell.
    expect(ruleFor(DATASET_SFC, '.th-inner')).toContain('padding: 0')
    expect(ruleFor(DATASET_SFC, '.sort-btn')).toContain('flex: 1 1 auto')
    expect(ruleFor(DATASET_PHONE, '.sort-btn')).toContain('min-height: 44px')
    expect(ruleFor(DATASET_PHONE, '.filter-btn')).toContain('min-width: 44px')
    // …and it still sorts.
    await w.findAll('thead th')[3].find('.sort-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.sort).toBe('Score')
  })

  it('opens the row as a bottom sheet with a handle, a close and an action row', async () => {
    const w = await mountAt()
    await w.findAll('tbody tr')[1].trigger('click')
    const drawer = w.get('[data-testid="row-drawer"]')
    expect(drawer.classes()).toContain('sheet')
    expect(drawer.find('.sheet-handle').exists()).toBe(true)
    // "Open record" is the shareable address of this one row.
    const record = drawer.get('[data-testid="row-open-record"]')
    expect(record.attributes('href')).toBe('/library/orgs?tab=data&q=Southwest%20Georgia%20Project')
    expect(record.classes()).toContain('touch-target')
    expect(drawer.get('[data-testid="row-drawer-close"]').classes()).toContain('touch-target')

    const sheet = ruleFor(DATASET_PHONE, '.sheet')
    expect(sheet).toContain('max-height: 85svh')
    expect(sheet).toContain('bottom: 0')
    expect(sheet).toContain('env(safe-area-inset-bottom')
    expect(ruleFor(DATASET_PHONE, '.sheet-handle')).toContain('display: block')
  })

  it('holds the page still behind the sheet on a phone, and puts it back on close', async () => {
    fakeMatchMedia(true)
    const w = await mountAt()
    expect(document.body.style.overflow).toBe('')
    await w.findAll('tbody tr')[1].trigger('click')
    expect(document.body.style.overflow).toBe('hidden')
    await w.get('[data-testid="row-drawer-close"]').trigger('click')
    expect(document.body.style.overflow).toBe('')
  })

  it('leaves the page scrolling behind the desktop side drawer', async () => {
    fakeMatchMedia(false)
    const w = await mountAt()
    await w.findAll('tbody tr')[1].trigger('click')
    expect(document.body.style.overflow).toBe('')
  })

  it('makes the save form a sheet too, and locks the page behind it', async () => {
    fakeMatchMedia(true)
    const w = await mountAt()
    await w.get('[data-testid="save-view-btn"]').trigger('click')
    const form = w.get('[data-testid="save-view-form"]')
    expect(form.classes()).toContain('sheet')
    expect(form.find('.sheet-handle').exists()).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
    await w.get('[data-testid="save-view-cancel"]').trigger('click')
    expect(document.body.style.overflow).toBe('')
  })

  it('locks the page behind the county-context picker', async () => {
    fakeMatchMedia(true)
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
    const w = await mountAt('/library/geo/data')
    await w.get('[data-testid="county-context-toggle"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="county-context-picker"]').exists()).toBe(true)
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('reads at 14 px: cells, counts and panels', () => {
    expect(ruleFor(DATASET_PHONE, '.data-table')).toContain('font-size: 14px')
    expect(ruleFor(DATASET_PHONE, '.count')).toContain('font-size: 14px')
    expect(ruleFor(DATASET_PHONE, '.drawer-fields')).toContain('font-size: 14px')
  })
})

describe('DatasetView — the checklist ticks on use (P5-69, P5-71)', () => {
  it('calls the save button "Save view", the one label the map and compare use', async () => {
    const w = await mountAt()
    expect(w.get('[data-testid="save-view-btn"]').text()).toBe('Save view')
  })

  it('ticks "data" when a filter is applied through a column header', async () => {
    const w = await mountAt()
    const stateHeader = w.findAll('thead th')[2]
    await stateHeader.find('.filter-btn').trigger('click')
    const pop = stateHeader.get('[data-testid="filter-pop"]')
    await pop.get('select').setValue('eq')
    await pop.get('input').setValue('GA')
    await pop.trigger('submit')
    await flushPromises()
    expect(mockedFirstRun).toHaveBeenCalledWith('data')
  })

  it('ticks "data" for a one-click schema filter, a sort, a summary and a group-by', async () => {
    const w = await mountAt()
    await w.findAll('.tool-btn').find(b => b.text() === 'Schema')!.trigger('click')
    await w.get('[data-testid="schema-panel"]').findAll('.top-value')[0].trigger('click')
    await flushPromises()
    expect(mockedFirstRun).toHaveBeenCalledWith('data')

    mockedFirstRun.mockReset()
    await w.findAll('thead th')[3].find('.sort-btn').trigger('click')
    await flushPromises()
    expect(mockedFirstRun).toHaveBeenCalledWith('data')

    mockedFirstRun.mockReset()
    const th = w.findAll('thead th')[1]
    await th.find('.filter-btn').trigger('click')
    await th.get('[data-testid="summarize-column"]').trigger('click')
    await flushPromises()
    expect(mockedFirstRun).toHaveBeenCalledWith('data')

    mockedFirstRun.mockReset()
    await th.find('.filter-btn').trigger('click')
    await th.get('[data-testid="group-by-column"]').trigger('click')
    await flushPromises()
    expect(mockedFirstRun).toHaveBeenCalledWith('data')
  })

  it('does not tick just for opening the table, or for clearing a sort', async () => {
    const w = await mountAt()
    expect(mockedFirstRun).not.toHaveBeenCalled()
    // Sort ascending, descending, then off: the third press applies nothing.
    const header = () => w.findAll('thead th')[3]
    await header().find('.sort-btn').trigger('click')
    await flushPromises()
    await header().find('.sort-btn').trigger('click')
    await flushPromises()
    mockedFirstRun.mockReset()
    await header().find('.sort-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.sort).toBeUndefined()
    expect(mockedFirstRun).not.toHaveBeenCalled()
  })
})

/**
 * P7-2: the explorer, reused over a working set.
 *
 * `/views/:slug` offers a Map interface and a Data interface over one set, and
 * the Data interface IS this table. Three props and one emit are the whole
 * seam: which dataset (the route is about the view, not the dataset), what
 * extra columns to join (the set's derived ones), whether the host already
 * provides a map — and, back the other way, which rows are on screen, so the
 * host's map draws this subset without fetching the rows a second time.
 */
type ShownPayload = { geoIds: string[]; rows: number; total: number; loading: boolean }

describe('the explorer over a working set (P7-2)', () => {
  const DERIVED = {
    id: 'derived:transmission-miles',
    name: 'Miles to transmission',
    values: new Map<string, CountyValueRow>([
      ['36061', { geoId: '36061', county: '36061', state: '', value: 6.2, display: '6.2 mi' }],
      ['13321', { geoId: '13321', county: '13321', state: '', value: 1.4, display: '1.4 mi' }],
    ]),
  }

  async function mountOverSet(props: Record<string, unknown> = {}, path = '/views/memphis-map') {
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/views/:slug', component: DatasetView },
        { path: '/library/:slug', component: { template: '<div />' } },
        { path: '/ask', component: { template: '<div />' } },
      ],
    })
    await router.push(path)
    await router.isReady()
    const wrapper = mount(DatasetView, { props: { embedded: true, slug: 'geo', ...props }, global: { plugins: [router] } })
    await flushPromises()
    return wrapper
  }

  beforeEach(() => {
    mockedSchema.mockResolvedValue(GEO_SCHEMA)
    mockedRows.mockResolvedValue(GEO_PAGE)
  })

  it('takes the dataset from a prop when the route is about the view', async () => {
    const w = await mountOverSet()
    // The route param says `memphis-map`; the table asked for `geo`.
    expect(mockedSchema).toHaveBeenCalledWith('geo', undefined)
    expect(mockedRows.mock.calls[0][0]).toBe('geo')
    expect(w.findAll('tr.data-row').length).toBe(3)
  })

  it('joins the set’s derived columns through the county join that already existed', async () => {
    const w = await mountOverSet({ extraColumns: [DERIVED] })
    const headers = w.findAll('[data-testid="context-header"]').map(th => th.text())
    expect(headers.some(h => h.includes('Miles to transmission'))).toBe(true)
    const cells = w.findAll('[data-testid="context-cell"]').map(td => td.text())
    expect(cells).toEqual(['6.2 mi', '1.4 mi', '—'])
  })

  it('sorts by a derived column — the table’s half of "one computation, two interfaces"', async () => {
    const w = await mountOverSet({ extraColumns: [DERIVED] })
    const sortButton = w.findAll('[data-testid="context-header"] .sort-btn').at(-1)!
    await sortButton.trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="context-cell"]').map(td => td.text())).toEqual(['1.4 mi', '6.2 mi', '—'])
    await sortButton.trigger('click')
    await flushPromises()
    // Descending, and a row with no number still sinks to the bottom.
    expect(w.findAll('[data-testid="context-cell"]').map(td => td.text())).toEqual(['6.2 mi', '1.4 mi', '—'])
  })

  it('tells the host which rows are on screen, so one fetch drives both interfaces', async () => {
    const w = await mountOverSet()
    const shown = w.emitted('shown') as ShownPayload[][]
    expect(shown.at(-1)![0]).toEqual({ geoIds: ['36061', '13321'], rows: 3, total: 3, loading: false })
  })

  /**
   * An empty `only` means "the whole layer", so a host that could not tell
   * "no rows yet" from "no counties in these rows" would open its map on
   * everything. The FIRST thing it hears has to say the subset is not settled.
   */
  it('says the subset is still landing before it says what it is', async () => {
    const w = await mountOverSet()
    const shown = w.emitted('shown') as ShownPayload[][]
    expect(shown[0][0]).toMatchObject({ geoIds: [], loading: true })
    expect(shown.at(-1)![0].loading).toBe(false)
  })

  it('re-emits the subset when a filter narrows it — the map follows without asking again', async () => {
    const w = await mountOverSet()
    mockedRows.mockResolvedValue({ ...GEO_PAGE, rows: [GEO_PAGE.rows[1]], total: 1 })
    await router.replace({ path: '/views/memphis-map', query: { q: 'Georgia' } })
    await flushPromises()
    const shown = w.emitted('shown') as ShownPayload[][]
    expect(shown.at(-1)![0]).toEqual({ geoIds: ['13321'], rows: 1, total: 1, loading: false })
  })

  it('offers no map of its own when the host provides one — two buttons would be two answers', async () => {
    mockedSchema.mockResolvedValue({
      ...GEO_SCHEMA,
      layer: { id: 'internal-geo', name: 'Sites', geometry: 'county' },
    } as DatasetSchema)
    stubViewportWidth(1280)
    const w = await mountOverSet({ hostMap: true })
    expect(w.find('[data-testid="show-on-map-open"]').exists()).toBe(false)
    expect(w.find('[data-testid="show-on-map"]').exists()).toBe(false)
    expect(w.findComponent(MapPane).exists()).toBe(false)
  })

  it('still offers its own map when nobody else does', async () => {
    mockedSchema.mockResolvedValue({
      ...GEO_SCHEMA,
      layer: { id: 'internal-geo', name: 'Sites', geometry: 'county' },
    } as DatasetSchema)
    stubViewportWidth(1280)
    const w = await mountOverSet()
    expect(w.find('[data-testid="show-on-map-open"]').exists()).toBe(true)
  })

  it('preserves a query key it does not own — `?interface=` survives a filter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = await mountOverSet({}, '/views/memphis-map?interface=data')
    await w.get('input[type="search"]').setValue('Georgia')
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBe('Georgia')
    // Switching interface is not a navigation and filtering is not a switch:
    // the table owns its own keys and leaves everything else alone.
    expect(router.currentRoute.value.query.interface).toBe('data')
    vi.useRealTimers()
  })
})
