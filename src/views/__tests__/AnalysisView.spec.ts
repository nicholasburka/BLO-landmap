import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

/**
 * /analysis (P6-4): the four tools, and what has been run with them.
 *
 * The two lists behind "recent analyses" live in two different places — saved
 * views in the catalog, cached place reports in the server's index — so both
 * requests are faked and the merge is the real code.
 */
vi.mock('@/lib/views', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/views')>()),
  fetchViews: vi.fn(),
}))

vi.mock('@/lib/placeReport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/placeReport')>()),
  fetchPlaceReports: vi.fn(),
}))

// P7-1: working sets sit between the tools and the record of what was run.
// Both the list and the promote action are faked; the arithmetic and the
// copy are the real code.
// P7-5: `runProximity` is faked too. The arithmetic it feeds (`proximityLine`,
// `measurableLayersOf`) is the real code, which is what the copy is judged on.
vi.mock('@/lib/workingSets', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/workingSets')>()),
  fetchWorkingSets: vi.fn(),
  promoteViewToWorkingSet: vi.fn(),
  runProximity: vi.fn(),
  runComposite: vi.fn(),
}))

vi.mock('@/lib/libraryCatalog', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/libraryCatalog')>()),
  fetchCatalog: vi.fn(),
}))

vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'maria', role: 'internal' } } }),
  registerLogoutHook: vi.fn(),
}))

import { fetchViews, type SavedViewSummary } from '@/lib/views'
import { fetchPlaceReports, type PlaceReportRow } from '@/lib/placeReport'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import {
  fetchWorkingSets,
  promoteViewToWorkingSet,
  runComposite,
  runProximity,
  type CompositeRun,
  type ProximityRun,
  type WorkingSetSummary,
} from '@/lib/workingSets'
import AnalysisView from '../AnalysisView.vue'
import { relativeTime } from '@/lib/kb'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const mockedViews = vi.mocked(fetchViews)
const mockedReports = vi.mocked(fetchPlaceReports)
const mockedSets = vi.mocked(fetchWorkingSets)
const mockedCatalog = vi.mocked(fetchCatalog)
const mockedPromote = vi.mocked(promoteViewToWorkingSet)
const mockedProximity = vi.mocked(runProximity)
const mockedComposite = vi.mocked(runComposite)

const VIEWS: SavedViewSummary[] = [
  {
    slug: 'georgia-shortlist',
    name: 'Georgia shortlist',
    type: 'compare',
    dataset: '',
    description: 'Fulton · DeKalb · Clayton',
    savedBy: 'maria',
    savedAt: '2026-09-22T10:00:00Z',
    resultCount: 3,
    // P7-1: ad-hoc — which is what every view written before P7-1 is, and
    // permanently fine.
    workingSet: '',
  },
  {
    slug: 'organizations-georgia',
    name: 'Organizations in Georgia',
    type: 'table',
    dataset: 'organizations',
    description: 'Organizations · HQ State is Georgia · 13 rows',
    savedBy: 'nick',
    savedAt: '2026-09-18T10:00:00Z',
    resultCount: 13,
    workingSet: '',
  },
]

/** P7-1: a view that already presents a set, for the tests about what the
 *  promote control may offer. Kept out of `VIEWS` on purpose — "recent
 *  analyses" is judged on that list and a new row would move every one of
 *  its expectations. */
const PRESENTING_VIEW: SavedViewSummary = {
  slug: 'memphis-cluster',
  name: 'Memphis cluster',
  type: 'map',
  dataset: '',
  description: 'Map view · brownfields near transmission',
  savedBy: 'maria',
  savedAt: '2026-09-25T10:00:00Z',
  resultCount: 0,
  workingSet: 'memphis-redevelopment',
}

const SETS: WorkingSetSummary[] = [
  {
    slug: 'memphis-redevelopment',
    name: 'Memphis redevelopment',
    purpose: 'Which parcels can be redeveloped',
    description: '',
    datasets: ['memphis-sites', 'epa-superfund-npl'],
    layers: ['combined_scores_v2'],
    sites: 'memphis-sites',
    derivedCount: 0,
    savedBy: 'maria',
    savedAt: '2026-09-25T10:00:00Z',
    updatedAt: '2026-09-25T10:00:00Z',
    views: [
      { slug: 'memphis-cluster', name: 'Memphis cluster', type: 'map' },
      { slug: 'memphis-by-distance', name: 'Memphis by distance', type: 'table' },
    ],
  },
]

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  slug: 'x',
  kind: 'dataset',
  title: 'X',
  category: '',
  status: 'published',
  tags: [],
  meta: {},
  files: [],
  bytes: 0,
  ...over,
})

const CATALOG: CatalogEntry[] = [
  entry({ slug: 'memphis-sites', title: 'Memphis candidate sites' }),
  entry({ slug: 'epa-superfund-npl', kind: 'source', title: 'Superfund NPL sites' }),
]

const REPORTS: PlaceReportRow[] = [
  { placeKey: 'g13121', label: 'Fulton County, GA', by: 'nick', at: '2026-09-21T10:00:00Z', found: 4, sources: 12 },
  { placeKey: 'p33.7490_-84.3880_r5', label: '55 Trinity Ave SW, Atlanta', by: 'maria', at: '2026-09-20T10:00:00Z', found: 6, sources: 12 },
]

let router: Router
async function mountIt() {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.replace('/analysis')
  await router.isReady()
  const w = mount(AnalysisView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

type Wrapper = Awaited<ReturnType<typeof mountIt>>

const rowTitles = (w: Wrapper) => w.findAll('[data-testid="analysis-row"]').map(r => r.get('.row-title').text())

beforeEach(() => {
  vi.clearAllMocks()
  mockedViews.mockResolvedValue(VIEWS)
  mockedReports.mockResolvedValue(REPORTS)
  mockedSets.mockResolvedValue(SETS)
  mockedCatalog.mockResolvedValue(CATALOG)
})

describe('the tool cards (P6-4)', () => {
  it('offers the four tools, each with a line about it and a Start', async () => {
    const w = await mountIt()
    const cards = w.findAll('[data-testid="tool-card"]')
    expect(cards.map(c => c.get('.tool-name').text())).toEqual([
      'Check a place',
      'Compare',
      'Explore a dataset',
      'Show on map',
    ])
    for (const card of cards) {
      expect(card.get('.tool-description').text().length).toBeGreaterThan(10)
      expect(card.get('[data-testid="tool-start"]').text()).toBe('Start')
    }
  })

  it('sends each Start somewhere real', async () => {
    const w = await mountIt()
    const hrefOf = (id: string) => w.get(`[data-tool="${id}"] [data-testid="tool-start"]`).attributes('href')
    expect(hrefOf('place')).toBe('/place')
    expect(hrefOf('compare')).toBe('/compare')
    // Not a route of its own: the explorer is a tab on an entry, so this
    // opens the browser narrowed to the tables we hold.
    expect(hrefOf('explore')).toBe('/datasets?readiness=held')
    expect(hrefOf('map')).toBe('/')
  })

  it('says where the two that are not pages of their own actually land', async () => {
    const w = await mountIt()
    expect(w.get('[data-tool="explore"] [data-testid="tool-hint"]').text()).toContain('Data tab')
    expect(w.get('[data-tool="map"] [data-testid="tool-hint"]').text()).toContain('layer picker')
    expect(w.find('[data-tool="place"] [data-testid="tool-hint"]').exists()).toBe(false)
  })
})

describe('recent analyses (P6-4)', () => {
  it('merges saved views and cached place reports, newest first', async () => {
    const w = await mountIt()
    expect(rowTitles(w)).toEqual([
      'Georgia shortlist',
      'Fulton County, GA',
      '55 Trinity Ave SW, Atlanta',
      'Organizations in Georgia',
    ])
  })

  it('names the kind, who ran it and when', async () => {
    const w = await mountIt()
    const rows = w.findAll('[data-testid="analysis-row"]')
    expect(rows[0].get('[data-testid="analysis-kind"]').text()).toBe('Comparison')
    expect(rows[1].get('[data-testid="analysis-kind"]').text()).toBe('Place report')
    expect(rows[3].get('[data-testid="analysis-kind"]').text()).toBe('Table view')
    expect(rows[1].get('[data-testid="analysis-who"]').text()).toContain('nick')
    expect(rows[1].get('[data-testid="analysis-who"]').text()).toMatch(/ago|·/)
  })

  it('opens each one in a press — a view through the shim, a report from its cache', async () => {
    const w = await mountIt()
    const rows = w.findAll('[data-testid="analysis-row"]')
    expect(rows[0].attributes('href')).toBe('/views/georgia-shortlist')
    expect(rows[1].attributes('href')).toBe('/place?geoid=13121')
    expect(rows[2].attributes('href')).toBe('/place?lat=33.749&lng=-84.388&radius=5')
    expect(rows[3].attributes('href')).toBe('/views/organizations-georgia')
  })

  it('says what a place report actually found', async () => {
    const w = await mountIt()
    const rows = w.findAll('[data-testid="analysis-row"]')
    expect(rows[1].get('[data-testid="analysis-line"]').text()).toBe('4 of 12 sources found something')
    expect(rows[0].get('[data-testid="analysis-line"]').text()).toBe('Fulton · DeKalb · Clayton')
  })

  it('shows the views when the report index cannot be read, and the other way round', async () => {
    mockedReports.mockRejectedValue(new Error('bucket down'))
    const noReports = await mountIt()
    expect(rowTitles(noReports)).toEqual(['Georgia shortlist', 'Organizations in Georgia'])

    mockedReports.mockResolvedValue(REPORTS)
    mockedViews.mockRejectedValue(new Error('nope'))
    const noViews = await mountIt()
    expect(rowTitles(noViews)).toEqual(['Fulton County, GA', '55 Trinity Ave SW, Atlanta'])
  })

  it('says so, in words, when nothing has been run', async () => {
    mockedViews.mockResolvedValue([])
    mockedReports.mockResolvedValue([])
    const w = await mountIt()
    expect(w.get('[data-testid="analyses-empty"]').text()).toContain('Nothing has been run yet')
    // The tools are still there — an empty library is where you start, not a
    // dead end.
    expect(w.findAll('[data-testid="tool-card"]')).toHaveLength(4)
  })

  it('says it is looking while the two lists are on their way', async () => {
    mockedViews.mockReturnValue(new Promise(() => {}) as never)
    const w = await mountIt()
    expect(w.find('[data-testid="analyses-loading"]').exists()).toBe(true)
  })
})

/**
 * P6-27: nine of eleven rows read "someone · Sep 15". The cause was on the
 * server (a reindex overwrote the name the live write had stored — see
 * `placeReportIndex`), but the page's own `analysis.by || 'someone'` is what
 * turned a missing name into a person who does not exist.
 */
describe('who ran it (P6-27)', () => {
  const UNATTRIBUTED = '2026-09-15T22:30:00Z'
  const NAMED = '2026-09-29T23:16:39Z'

  beforeEach(() => {
    mockedViews.mockResolvedValue([])
    mockedReports.mockResolvedValue([
      { placeKey: 'p40.7785_-73.9572_r5', label: '40.7785, -73.9572', by: 'dev-admin', at: NAMED, found: 2, sources: 12 },
      { placeKey: 'g13121', label: 'Fulton County, GA', by: '', at: UNATTRIBUTED, found: 4, sources: 12 },
    ])
  })

  it('shows the date alone when no actor was recovered — never a placeholder name', async () => {
    const w = await mountIt()
    const rows = w.findAll('[data-testid="analysis-row"]')
    expect(rows[1].get('[data-testid="analysis-who"]').text()).toBe(relativeTime(UNATTRIBUTED))
    // Not anywhere on the page, not just not in that row.
    expect(w.text()).not.toContain('someone')
  })

  it('names the actor when one is recorded, still with the date', async () => {
    const w = await mountIt()
    expect(w.findAll('[data-testid="analysis-row"]')[0].get('[data-testid="analysis-who"]').text()).toBe(
      `dev-admin \u00b7 ${relativeTime(NAMED)}`,
    )
  })

  it('drops the line entirely when neither the actor nor the date is known', async () => {
    mockedReports.mockResolvedValue([
      { placeKey: 'g13121', label: 'Fulton County, GA', by: '', at: '', found: 4, sources: 12 },
    ])
    const w = await mountIt()
    const row = w.get('[data-testid="analysis-row"]')
    expect(row.find('[data-testid="analysis-who"]').exists()).toBe(false)
    // The row is still a row: the title and what it found are the point.
    expect(row.get('.row-title').text()).toBe('Fulton County, GA')
    expect(row.get('[data-testid="analysis-line"]').text()).toContain('4 of 12')
  })
})

describe('phone layout (P5-60 guards)', () => {
  const css = readStyles('src/views/AnalysisView.vue')
  const phone = mediaBlock(css, 640)

  it('keeps the page from setting its own width', () => {
    expect(ruleFor(css, '.analysis-view')).toContain('min-width: 0')
    expect(ruleFor(phone, '.analysis-view')).toContain('max-width: 100%')
  })

  it('stacks the tool cards and gives Start a thumb-sized target', () => {
    expect(ruleFor(phone, '.tool-cards')).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(ruleFor(phone, '.tool-start')).toContain('min-height: 44px')
  })
})

/**
 * P7-1. A working set is what an analysis runs AGAINST, so it sits between the
 * tools and the record of what has been run.
 *
 * The two tests that matter most here are the ones about views: that a set can
 * carry several (the whole reason a set and a view are two objects), and that
 * a view presenting none shows no broken or empty affordance — it is ad-hoc,
 * which is permanent and first-class.
 */
describe('working sets (P7-1)', () => {
  it('lists each set with how far its sourcing has got', async () => {
    const w = await mountIt()
    const row = w.get('[data-testid="set-row"]')
    expect(row.get('[data-testid="set-title"]').text()).toBe('Memphis redevelopment')
    expect(row.get('[data-testid="set-title"]').attributes('href')).toBe('/library/memphis-redevelopment')
    expect(row.get('[data-testid="set-progress"]').text()).toBe('1 of 2 held · 1 indexed')
    expect(row.get('[data-testid="set-purpose"]').text()).toBe('Which parcels can be redeveloped')
  })

  /** §F.1's load-bearing claim, made visible: one set, several framings. */
  it('shows the several views a set carries, each as its own link', async () => {
    const w = await mountIt()
    const links = w.findAll('[data-testid="set-view-link"]')
    expect(links.map(l => l.text())).toEqual(['Memphis cluster', 'Memphis by distance'])
    expect(links[0].attributes('href')).toBe('/views/memphis-cluster')
    expect(w.get('[data-testid="set-views"]').text()).toContain('2 views')
  })

  it('says so when a set has no views yet, rather than drawing an empty strip', async () => {
    mockedSets.mockResolvedValue([{ ...SETS[0], views: [] }])
    const w = await mountIt()
    expect(w.get('[data-testid="set-no-views"]').text()).toBe('No views of it yet')
  })

  it('offers the scoped place report and the set’s own datasets', async () => {
    const w = await mountIt()
    expect(w.get('[data-testid="set-place"]').attributes('href')).toBe('/place?set=memphis-redevelopment')
    expect(w.get('[data-testid="set-datasets"]').attributes('href')).toBe(
      '/datasets?workingSet=memphis-redevelopment',
    )
  })

  it('says what to do first when there are none', async () => {
    mockedSets.mockResolvedValue([])
    const w = await mountIt()
    expect(w.get('[data-testid="sets-empty"]').text()).toContain('make a working set from it')
  })

  it('still shows the tools and the recent list when the sets could not be loaded', async () => {
    mockedSets.mockRejectedValue(new Error('bucket unhappy'))
    const w = await mountIt()
    expect(w.findAll('[data-testid="tool-card"]')).toHaveLength(4)
    expect(rowTitles(w).length).toBeGreaterThan(0)
    expect(w.find('[data-testid="sets-empty"]').exists()).toBe(true)
  })
})

describe('making a working set from a view (P7-1)', () => {
  it('offers only the views that present no set — there is no backfill', async () => {
    mockedViews.mockResolvedValue([...VIEWS, PRESENTING_VIEW])
    const w = await mountIt()
    const options = w.get('[data-testid="promote-view"]').findAll('option')
    expect(options.map(o => o.text())).toEqual([
      'Choose a view…',
      'Georgia shortlist',
      'Organizations in Georgia',
    ])
    expect(options.map(o => o.text())).not.toContain('Memphis cluster')
  })

  it('will not promote until a view is chosen', async () => {
    const w = await mountIt()
    expect(w.get('[data-testid="promote-submit"]').attributes('disabled')).toBeDefined()
  })

  it('promotes the chosen view, under the name that was typed', async () => {
    mockedPromote.mockResolvedValue({
      slug: 'georgia-sites',
      name: 'Georgia sites',
      fromView: 'georgia-shortlist',
      took: { datasets: [], layers: ['combined_scores_v2'] },
    })
    const w = await mountIt()
    await w.get('[data-testid="promote-view"]').setValue('georgia-shortlist')
    await w.get('[data-testid="promote-name"]').setValue('Georgia sites')
    await w.get('[data-testid="promote-form"]').trigger('submit')
    await flushPromises()
    expect(mockedPromote).toHaveBeenCalledWith('georgia-shortlist', { name: 'Georgia sites' })
  })

  it('keeps the view’s own name when none is typed', async () => {
    mockedPromote.mockResolvedValue({
      slug: 'georgia-shortlist-set',
      name: 'Georgia shortlist',
      fromView: 'georgia-shortlist',
      took: { datasets: [], layers: [] },
    })
    const w = await mountIt()
    await w.get('[data-testid="promote-view"]').setValue('georgia-shortlist')
    await w.get('[data-testid="promote-form"]').trigger('submit')
    await flushPromises()
    expect(mockedPromote).toHaveBeenCalledWith('georgia-shortlist', {})
  })

  /**
   * A promoted set is a STARTING point — auto-built from a view's layers it is
   * one to three registry layers with no sites and no sources. Saying so is
   * the difference between curation and a set that looks finished and means
   * nothing.
   */
  it('says the new set is not finished, and where to finish it', async () => {
    mockedPromote.mockResolvedValue({
      slug: 'georgia-sites',
      name: 'Georgia sites',
      fromView: 'georgia-shortlist',
      took: { datasets: [], layers: ['combined_scores_v2'] },
    })
    const w = await mountIt()
    await w.get('[data-testid="promote-view"]').setValue('georgia-shortlist')
    await w.get('[data-testid="promote-form"]').trigger('submit')
    await flushPromises()
    const note = w.get('[data-testid="promote-done"]')
    expect(note.text()).toContain('add the sources that bear on it to finish it')
    expect(note.get('a').attributes('href')).toBe('/datasets?workingSet=georgia-sites')
  })

  it('says what went wrong rather than failing silently', async () => {
    mockedPromote.mockRejectedValue(new Error('nope'))
    const w = await mountIt()
    await w.get('[data-testid="promote-view"]').setValue('georgia-shortlist')
    await w.get('[data-testid="promote-form"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="promote-error"]').text().length).toBeGreaterThan(10)
    expect(w.find('[data-testid="promote-done"]').exists()).toBe(false)
  })

  it('is not offered at all when every view already presents a set', async () => {
    mockedViews.mockResolvedValue([PRESENTING_VIEW])
    const w = await mountIt()
    expect(w.find('[data-testid="promote-form"]').exists()).toBe(false)
  })
})

// --- P7-5: Measure proximity, scoped to a set (spec §F.5) -------------------

describe('the proximity tool on a set', () => {
  /** The set as P7-5 needs it: an anchor table of sites, and a line layer to
   *  measure to. A county layer beside it, which must not be offered. */
  const MEASURABLE: WorkingSetSummary[] = [
    {
      ...SETS[0],
      layers: ['combined_scores_v2', 'internal-transmission', 'internal-target-index'],
      sites: 'memphis-sites',
    },
  ]
  const LAYER_CATALOG: CatalogEntry[] = [
    ...CATALOG,
    entry({ slug: 'transmission', title: 'EIA transmission', meta: { layer: { geometry: 'line', name: 'Transmission lines' } } }),
    entry({ slug: 'target-index', title: 'Target index', meta: { layer: { geometry: 'county', name: 'Target index' } } }),
  ]

  const RUN: ProximityRun = {
    set: 'memphis-redevelopment',
    from: 'memphis-sites',
    to: 'internal-transmission',
    within: null,
    reused: false,
    served: 'computed',
    freshness: 'fresh',
    staleNote: '',
    columns: [
      { id: 'miles-to-transmission', label: 'Miles to nearest Transmission lines', unit: 'miles', counties: 6 },
    ],
    perRow: [],
    stats: { rows: 11, measured: 9, withoutPoint: 2, withoutCounty: 0, counties: 6, targets: 4, vertices: 164 },
    method: 'Great-circle miles…',
    computedAt: '2026-10-06T00:00:00Z',
  }

  beforeEach(() => {
    mockedSets.mockResolvedValue(MEASURABLE)
    mockedCatalog.mockResolvedValue(LAYER_CATALOG)
    mockedProximity.mockResolvedValue(RUN)
  })

  async function openForm() {
    const w = await mountIt()
    await w.get('[data-testid="set-proximity"]').trigger('click')
    return w
  }

  it('offers the tool on a set that has both halves of the question', async () => {
    const w = await mountIt()
    expect(w.get('[data-testid="set-proximity"]').text()).toBe('Measure proximity')
  })

  it('does NOT offer it on a set with no anchor table — there are no rows to measure from', async () => {
    mockedSets.mockResolvedValue([{ ...MEASURABLE[0], sites: null }])
    const w = await mountIt()
    expect(w.find('[data-testid="set-proximity"]').exists()).toBe(false)
  })

  it('does NOT offer it on a set whose only layers are county choropleths', async () => {
    mockedSets.mockResolvedValue([{ ...MEASURABLE[0], layers: ['combined_scores_v2', 'internal-target-index'] }])
    const w = await mountIt()
    expect(w.find('[data-testid="set-proximity"]').exists()).toBe(false)
  })

  it('lists only the point and line layers, by the layer’s own name', async () => {
    const w = await openForm()
    const options = w.get('[data-testid="proximity-to"]').findAll('option')
    expect(options.map(o => o.text())).toEqual(['Transmission lines'])
  })

  it('posts the chosen layer and radius, and reports what it got back', async () => {
    const w = await openForm()
    await w.get('[data-testid="proximity-within"]').setValue('5')
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()

    expect(mockedProximity).toHaveBeenCalledWith('memphis-redevelopment', {
      to: 'internal-transmission',
      within: 5,
    })
    const result = w.get('[data-testid="proximity-result"]')
    expect(result.text()).toContain('Measured.')
    expect(w.get('[data-testid="proximity-counts"]').text()).toBe(
      '9 of 11 rows measured · 6 counties · 2 with no coordinates',
    )
    expect(w.get('[data-testid="proximity-column"]').text()).toContain('Miles to nearest Transmission lines')
    expect(w.get('[data-testid="proximity-column"]').text()).toContain('6 counties')
  })

  it('omits the radius entirely when nobody asked for one', async () => {
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    expect(mockedProximity).toHaveBeenCalledWith('memphis-redevelopment', { to: 'internal-transmission' })
  })

  it('says when nothing was recomputed, because that is the feature', async () => {
    mockedProximity.mockResolvedValue({ ...RUN, reused: true, served: 'stored' })
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    const result = w.get('[data-testid="proximity-result"]')
    expect(result.text()).toContain('the stored result, unchanged')
    expect(result.text()).toContain('Nothing was recomputed')
    expect(result.get('.proximity-done').attributes('data-served')).toBe('stored')
  })

  it('distinguishes a RE-measurement from a first one, and says why (P7-6)', async () => {
    // The dangerous case: a reader presses Measure, sees "Measured.", and does
    // not realise the number in front of them just changed because the sites
    // table did. The reason rides back with it.
    mockedProximity.mockResolvedValue({
      ...RUN,
      served: 'computed',
      staleNote: '“memphis-sites” has changed since this ran — 4,821 bytes, now 5,002, so this number may have drifted.',
    })
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    const served = w.get('[data-testid="proximity-served"]').text()
    expect(served).toContain('Measured again')
    expect(served).toContain('“memphis-sites” has changed')
  })

  it('carries the caveat on a STORED result whose input moved (P7-6)', async () => {
    // Served rather than recomputed, and still not clean: an uncheckable or
    // moved input must not be hidden by the good news that nothing ran.
    mockedProximity.mockResolvedValue({
      ...RUN,
      reused: true,
      served: 'stored',
      freshness: 'unknown',
      staleNote: 'This was computed before its inputs were recorded, so whether it still stands cannot be checked.',
    })
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    const served = w.get('[data-testid="proximity-served"]').text()
    expect(served).toContain('the stored result')
    expect(served).toContain('cannot be checked')
    expect(served).not.toContain('Nothing was recomputed')
  })

  it('shows the ceiling’s own sentence, which names the local pass', async () => {
    // The refusal IS the instruction. Replacing it with "something went wrong"
    // would leave the person with no way forward.
    mockedProximity.mockRejectedValue(
      new Error('190,000 rows is a batch job, not a request — run npm run library -- proximity <set> --to <layer>'),
    )
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="proximity-error"]').text()).toContain('npm run library -- proximity')
    expect(w.find('[data-testid="proximity-result"]').exists()).toBe(false)
  })

  it('points at the views that will show the column', async () => {
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    const links = w.get('[data-testid="proximity-result"]').findAll('.set-view-link')
    expect(links.map(l => l.text())).toEqual(['Memphis cluster', 'Memphis by distance'])
  })

  it('says so when the set has no view to show the column on', async () => {
    mockedSets.mockResolvedValue([{ ...MEASURABLE[0], views: [] }])
    const w = await openForm()
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="proximity-no-views"]').text()).toContain('Save a view of this set')
  })

  it('reloads the sets after a run, so the derived count is not stale', async () => {
    const w = await openForm()
    const before = mockedSets.mock.calls.length
    await w.get('[data-testid="proximity-form"]').trigger('submit')
    await flushPromises()
    expect(mockedSets.mock.calls.length).toBeGreaterThan(before)
  })

  it('closes on a second press', async () => {
    const w = await openForm()
    expect(w.find('[data-testid="proximity-form"]').exists()).toBe(true)
    await w.get('[data-testid="set-proximity"]').trigger('click')
    expect(w.find('[data-testid="proximity-form"]').exists()).toBe(false)
  })
})

// --- P7-8: Build an index ----------------------------------------------------

describe('the index tool on a set', () => {
  /** A set naming two county layers that can be weighed — one held, one from
   *  the public registry, which is the mix the workbook's political efficacy
   *  question actually needs — plus a line layer, which cannot. */
  const INDEXABLE: WorkingSetSummary[] = [
    {
      ...SETS[0],
      layers: ['internal-votes', 'poverty_by_race', 'internal-transmission'],
      sites: null,
    },
  ]
  const LAYER_CATALOG: CatalogEntry[] = [
    ...CATALOG,
    entry({ slug: 'votes', title: 'Black voter registration', meta: { layer: { geometry: 'county', name: 'Black voter registration', direction: 'higher_better' } } }),
    entry({ slug: 'transmission', title: 'EIA transmission', meta: { layer: { geometry: 'line', name: 'Transmission lines' } } }),
  ]

  const RUN: CompositeRun = {
    set: 'memphis-redevelopment',
    column: 'political-efficacy',
    label: 'Political efficacy',
    terms: [
      { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
      { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
    ],
    scales: [
      { layer: 'internal-votes', weight: 6, direction: 'higher_better', min: 38.6, max: 80.2, counties: 6 },
      { layer: 'poverty_by_race', weight: 4, direction: 'lower_better', min: 3.1, max: 44.2, counties: 3100 },
    ],
    reused: false,
    served: 'computed',
    freshness: 'fresh',
    staleNote: '',
    counties: 3100,
    complete: 6,
    partial: 3094,
    layerId: 'internal-memphis-redevelopment~political-efficacy',
    method: 'Weighted index of 2 county layers…',
    computedAt: '2026-10-06T00:00:00Z',
  }

  beforeEach(() => {
    mockedSets.mockResolvedValue(INDEXABLE)
    mockedCatalog.mockResolvedValue(LAYER_CATALOG)
    mockedComposite.mockResolvedValue(RUN)
  })

  async function openForm() {
    const w = await mountIt()
    await w.get('[data-testid="set-index"]').trigger('click')
    return w
  }

  it('offers the tool on a set naming at least two county layers', async () => {
    const w = await mountIt()
    expect(w.get('[data-testid="set-index"]').text()).toBe('Build an index')
  })

  it('does NOT offer it on a set with only one county layer — that is the layer', async () => {
    mockedSets.mockResolvedValue([{ ...INDEXABLE[0], layers: ['internal-votes', 'internal-transmission'] }])
    const w = await mountIt()
    // An option that can only ever be refused is not an option.
    expect(w.find('[data-testid="set-index"]').exists()).toBe(false)
  })

  it('lists the county layers, held and public alike, and never the features', async () => {
    const w = await openForm()
    const names = w.findAll('[data-testid="index-term"]').map(li => li.text())
    expect(names).toHaveLength(2)
    expect(names[0]).toContain('Black voter registration')
    // The registry's own name, read off LAYER_REGISTRY rather than invented
    // here — which is what proves a public layer really is offered as a term.
    expect(names[1]).toContain('Poverty Rate (Black)')
    expect(w.get('[data-testid="index-form"]').text()).not.toContain('Transmission lines')
  })

  it('pre-fills each direction from what the layer declares, as a control a person can change', async () => {
    const w = await openForm()
    await w.get('[data-testid="index-on-internal-votes"]').setValue(true)
    await w.get('[data-testid="index-on-poverty_by_race"]').setValue(true)
    // Registration higher, poverty lower — the registry's and the manifest's
    // own words, shown rather than applied silently.
    expect((w.get('[data-testid="index-direction-internal-votes"]').element as HTMLSelectElement).value).toBe('higher_better')
    expect((w.get('[data-testid="index-direction-poverty_by_race"]').element as HTMLSelectElement).value).toBe('lower_better')
  })

  it('arrives with nothing ticked and Build disabled, so nobody builds an index by pressing once', async () => {
    const w = await openForm()
    expect((w.get('[data-testid="index-submit"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.get('[data-testid="index-hint"]').text()).toContain('at least two layers')
  })

  it('still refuses to submit with two layers and no name', async () => {
    const w = await openForm()
    await w.get('[data-testid="index-on-internal-votes"]').setValue(true)
    await w.get('[data-testid="index-on-poverty_by_race"]').setValue(true)
    expect((w.get('[data-testid="index-submit"]').element as HTMLButtonElement).disabled).toBe(true)
    await w.get('[data-testid="index-name"]').setValue('Political efficacy')
    expect((w.get('[data-testid="index-submit"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('posts the formula a person built, weights and directions and all', async () => {
    const w = await openForm()
    await w.get('[data-testid="index-name"]').setValue('Political efficacy')
    await w.get('[data-testid="index-on-internal-votes"]').setValue(true)
    await w.get('[data-testid="index-on-poverty_by_race"]').setValue(true)
    await w.get('[data-testid="index-weight-internal-votes"]').setValue('6')
    await w.get('[data-testid="index-weight-poverty_by_race"]').setValue('4')
    await w.get('[data-testid="index-form"]').trigger('submit')
    await flushPromises()

    expect(mockedComposite).toHaveBeenCalledWith('memphis-redevelopment', {
      label: 'Political efficacy',
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
      ],
    })
  })

  it('says what it did, how much it covered, and what each layer’s 0 and 100 meant', async () => {
    const w = await openForm()
    await w.get('[data-testid="index-name"]').setValue('Political efficacy')
    await w.get('[data-testid="index-on-internal-votes"]').setValue(true)
    await w.get('[data-testid="index-on-poverty_by_race"]').setValue(true)
    await w.get('[data-testid="index-form"]').trigger('submit')
    await flushPromises()

    expect(w.get('[data-testid="index-served"]').text()).toBe('Built.')
    expect(w.get('[data-testid="index-counts"]').text()).toBe(
      '3,100 counties · 6 with every layer · 3,094 missing at least one',
    )
    const scales = w.findAll('[data-testid="index-scale"]').map(li => li.text())
    expect(scales[0]).toBe('Black voter registration ×6, higher is better, over 38.6 to 80.2')
    expect(scales[1]).toBe('Poverty Rate (Black) ×4, lower is better, over 3.1 to 44.2')
    // And it is a layer, which is the half that makes it citable on a map.
    expect(w.get('[data-testid="index-layer"]').text()).toContain('internal-memphis-redevelopment~political-efficacy')
  })

  it('says a stored index was served rather than letting it read as a fresh run', async () => {
    mockedComposite.mockResolvedValue({ ...RUN, served: 'stored', reused: true })
    const w = await openForm()
    await w.get('[data-testid="index-name"]').setValue('Political efficacy')
    await w.get('[data-testid="index-on-internal-votes"]').setValue(true)
    await w.get('[data-testid="index-on-poverty_by_race"]').setValue(true)
    await w.get('[data-testid="index-form"]').trigger('submit')
    await flushPromises()
    expect(w.get('[data-testid="index-served"]').text()).toBe(
      'Already built — the stored index, unchanged. Nothing was recomputed.',
    )
  })

  it('shows a refusal in the server’s own words, ceiling included', async () => {
    mockedComposite.mockRejectedValue(
      new Error(
        '3 layers over 90.0 MB of source tables is past the 32.0 MB this parses in a request. Run it locally instead: npm run library -- index <set> …',
      ),
    )
    const w = await openForm()
    await w.get('[data-testid="index-name"]').setValue('Political efficacy')
    await w.get('[data-testid="index-on-internal-votes"]').setValue(true)
    await w.get('[data-testid="index-on-poverty_by_race"]').setValue(true)
    await w.get('[data-testid="index-form"]').trigger('submit')
    await flushPromises()
    // The sentence IS the instruction, so it is relayed rather than reworded.
    expect(w.get('[data-testid="index-error"]').text()).toContain('npm run library -- index')
    expect(w.find('[data-testid="index-result"]').exists()).toBe(false)
  })

  it('closes and forgets what was half-typed, rather than reopening onto it', async () => {
    const w = await openForm()
    await w.get('[data-testid="index-name"]').setValue('Half a thought')
    await w.get('[data-testid="set-index"]').trigger('click')
    expect(w.find('[data-testid="index-form"]').exists()).toBe(false)
    await w.get('[data-testid="set-index"]').trigger('click')
    expect((w.get('[data-testid="index-name"]').element as HTMLInputElement).value).toBe('')
  })
})
