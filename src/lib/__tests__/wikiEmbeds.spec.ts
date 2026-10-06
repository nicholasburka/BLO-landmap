import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { hydrateEmbeds, clearEmbedCache, EMBED_RESULTS_SHOWN, EMBED_ROWS_SHOWN } from '../wikiEmbeds'
import { fetchView, type SavedView } from '../views'
import { fetchCatalogEntry, type CatalogEntry } from '../libraryCatalog'
import { fetchDatasetRows, fetchColumnSummary, type ColumnSummary, type RowsPage } from '../libraryData'
import { compareLayerIndex, loadCompareCounties, loadLayerColumn, type LayerColumn } from '../compare'
import { mapHrefForInternalLayerId } from '../internalLayers'
import { fetchWorkingSet, type WorkingSetDetail } from '../workingSets'
import { MAP_BLOCKS_LIVE } from '../wikiEmbeds'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

// Only the API calls are faked; the shaping around them (tableStateOf,
// tableViewUrl, the chart builders) is the code under test.
vi.mock('../views', async importOriginal => ({ ...(await importOriginal<typeof import('../views')>()), fetchView: vi.fn() }))
vi.mock('../libraryCatalog', async importOriginal => ({ ...(await importOriginal<typeof import('../libraryCatalog')>()), fetchCatalogEntry: vi.fn() }))
vi.mock('../libraryData', async importOriginal => ({
  ...(await importOriginal<typeof import('../libraryData')>()),
  fetchDatasetRows: vi.fn(),
  fetchColumnSummary: vi.fn(),
}))
// P5-55: only the three things a compare card fetches are faked — the row
// building, ranking and formatting are the code under test.
vi.mock('../compare', async importOriginal => ({
  ...(await importOriginal<typeof import('../compare')>()),
  compareLayerIndex: vi.fn(),
  loadCompareCounties: vi.fn(),
  loadLayerColumn: vi.fn(),
}))
// P5-77: the card's map link asks the manifest for the layer's frame; the
// helper has its own spec, so here it is faked and only the wiring is tested.
vi.mock('../internalLayers', async importOriginal => ({
  ...(await importOriginal<typeof import('../internalLayers')>()),
  mapHrefForInternalLayerId: vi.fn(),
}))

/**
 * P7-4: the map block, stubbed — and the stub exists mostly to be COUNTED.
 *
 * The ticket's second acceptance criterion is "a page with no map block fetches
 * no map code", and the only honest place to measure that is the module graph:
 * `renderMapBlock` reaches the component through a dynamic `import()`, so a
 * factory that has never run is proof that mapbox-gl and the two county files
 * were never requested. `block.imports` counts the evaluations; the real
 * component is exercised in `WikiMapBlock.spec.ts`.
 */
const block = vi.hoisted(() => ({ imports: 0, unmounts: 0, routers: [] as unknown[] }))
vi.mock('@/components/WikiMapBlock.vue', async () => {
  const { useRouter } = await import('vue-router')
  block.imports++
  return {
    default: {
      name: 'WikiMapBlock',
      props: { view: { type: Object, required: true }, mode: { type: String, default: 'live' }, limit: Number },
      setup() {
        // Proves the host's router was installed on the mounted app: the real
        // component's `MapCanvas` resolves one for its feature popups.
        block.routers.push(useRouter())
      },
      unmounted() {
        block.unmounts++
      },
      template: '<div class="stub-map" :data-mode="mode" :data-limit="limit">{{ view.name }}</div>',
    },
  }
})

// The working-set client is reached by a dynamic import too, and only when a
// `map:` slug turns out not to be a view at all.
vi.mock('../workingSets', async importOriginal => ({
  ...(await importOriginal<typeof import('../workingSets')>()),
  fetchWorkingSet: vi.fn(),
}))

const mockFetchView = vi.mocked(fetchView)
const mockFetchEntry = vi.mocked(fetchCatalogEntry)
const mockFetchRows = vi.mocked(fetchDatasetRows)
const mockFetchSummary = vi.mocked(fetchColumnSummary)
const mockLayerIndex = vi.mocked(compareLayerIndex)
const mockCompareCounties = vi.mocked(loadCompareCounties)
const mockLayerColumn = vi.mocked(loadLayerColumn)
const mockMapHref = vi.mocked(mapHrefForInternalLayerId)
const mockFetchWorkingSet = vi.mocked(fetchWorkingSet)

function makeView(overrides: Partial<SavedView> = {}): SavedView {
  return {
    slug: 'tn-target-counties',
    name: 'TN target counties',
    type: 'map',
    savedBy: 'maria',
    savedAt: '2026-09-03T12:00:00.000Z',
    state: {
      layers: [{ layerId: 'pct_black', weight: 1 }],
      filters: [],
      limit: 10,
      regionStates: ['TN'],
      prompt: 'rank TN counties',
      viewport: { center: [-86.6, 35.8], zoom: 6 },
    },
    results: [
      { rank: 1, geoId: '47157', name: 'Shelby County', state: 'Tennessee', score: 91.2 },
      { rank: 2, geoId: '47065', name: 'Hamilton County', state: 'Tennessee', score: 84.5 },
    ],
    ...overrides,
  }
}

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: 'tn-heirs-dataset',
    kind: 'dataset',
    title: 'TN Heirs Property',
    category: 'land',
    status: 'published',
    tags: [],
    meta: {},
    files: [],
    bytes: 1024,
    ...overrides,
  }
}

function makeContainer(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

/**
 * A container the document can see.
 *
 * `makeContainer` is detached, which is right for card tests and wrong for map
 * ones: the live-map cap and the unmount sweep both key on `isConnected`, so a
 * detached block would never count and would be reclaimed on the next pass.
 */
const attached: HTMLElement[] = []
function makeAttachedContainer(html: string): HTMLElement {
  const div = makeContainer(html)
  document.body.appendChild(div)
  attached.push(div)
  return div
}

function mapPlaceholders(count: number, slug = 'tn-target-counties'): string {
  return Array.from(
    { length: count },
    (_, i) => `<div data-embed="map" data-embed-slug="${slug}-${i}">map:${slug}-${i}</div>`,
  ).join('')
}

beforeEach(() => {
  for (const node of attached.splice(0)) node.remove()
  // After clearEmbedCache: it unmounts the previous test's blocks, and those
  // unmounts are not this test's.
  clearEmbedCache()
  block.imports = 0
  block.unmounts = 0
  block.routers.length = 0
  vi.clearAllMocks()
})

describe('link entry cards (P5-34)', () => {
  it('shows the dropped URL as an external link', async () => {
    mockFetchEntry.mockResolvedValueOnce(makeEntry({ slug: 'parcels', kind: 'incoming', status: 'needs-cataloging', meta: { url: 'https://example.org/parcels' }, files: [] }))
    const c = makeContainer('<div data-embed="entry" data-embed-slug="parcels">entry:parcels</div>')
    await hydrateEmbeds(c)
    const ext = c.querySelector('a.embed-link--external')!
    expect(ext.getAttribute('href')).toBe('https://example.org/parcels')
    expect(ext.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('entry card actions (P5-36)', () => {
  it('offers Browse data and Show on map only when the entry supports them, framed on the layer (P5-77)', async () => {
    mockMapHref.mockResolvedValue('/?layers=internal-orgs&fit=bbox%3A-90.31%2C34.99%2C-89.6%2C35.35')
    mockFetchEntry.mockResolvedValueOnce(makeEntry({ slug: 'orgs', files: [{ key: 'library/datasets/orgs/orgs.csv', size: 10 }], meta: { layer: { geometry: 'point', name: 'Orgs' } } }))
    const rich = makeContainer('<div data-embed="entry" data-embed-slug="orgs">entry:orgs</div>')
    await hydrateEmbeds(rich)
    expect(mockMapHref).toHaveBeenCalledWith('internal-orgs')
    const hrefs = [...rich.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['/library/orgs', '/library/orgs?tab=data', '/?layers=internal-orgs&fit=bbox%3A-90.31%2C34.99%2C-89.6%2C35.35'])
    expect(hrefs[2]).toContain('fit=bbox%3A')
    clearEmbedCache()
    mockFetchEntry.mockResolvedValueOnce(makeEntry({ slug: 'notes', files: [{ key: 'library/documents/notes/notes.pdf', size: 10 }] }))
    const plain = makeContainer('<div data-embed="entry" data-embed-slug="notes">entry:notes</div>')
    await hydrateEmbeds(plain)
    expect([...plain.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual(['/library/notes'])
  })
})

describe('archived entry cards (P5-35)', () => {
  it('points at the superseding entry instead of presenting the archived one as current', async () => {
    mockFetchEntry.mockResolvedValueOnce(makeEntry({ slug: 'old-manual', title: 'Old manual', status: 'archived', supersededBy: { slug: 'fact-manual', title: 'Fact manual' }, supersedes: [] }))
    const container = makeContainer('<div data-embed="entry" data-embed-slug="old-manual">entry:old-manual</div>')
    await hydrateEmbeds(container)
    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.classList.contains('wiki-embed-card--archived')).toBe(true)
    expect(card.textContent).toContain('Archived — superseded by Fact manual')
    const links = [...card.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(links).toEqual(['/library/fact-manual', '/library/old-manual'])
    expect(card.textContent).not.toContain('document · ')
  })
})

describe('view card point layers (P5-24)', () => {
  const placeholder = '<div data-embed="view" data-embed-slug="tn-target-counties">view:tn-target-counties</div>'

  it('lists toggled point layers by name and tolerates a malformed field', async () => {
    mockFetchView.mockResolvedValueOnce(
      makeView({ state: { ...makeView().state, pointLayers: [{ id: 'internal-orgs-hq', name: 'Organizations (HQ)' }, { id: 'x' } as any], siteLayers: ['superfund_sites', 'not-a-layer'] } }),
    )
    const container = makeContainer(placeholder)
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('Point layers: Organizations (HQ)')
    // P5-78: a map view's contamination layers are named on the card too.
    expect(container.textContent).toContain('Site layers: Superfund Sites')

    clearEmbedCache()
    mockFetchView.mockResolvedValueOnce(makeView({ state: { ...makeView().state, pointLayers: 'nope' as any } }))
    const plain = makeContainer(placeholder)
    await hydrateEmbeds(plain)
    expect(plain.textContent).not.toContain('Point layers')
  })
})

describe('hydrateEmbeds', () => {
  it('replaces a view placeholder with a card: name, data-as-of, results, open-in-map link', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeContainer(
      '<div data-embed="view" data-embed-slug="tn-target-counties">view:tn-target-counties</div>',
    )
    await hydrateEmbeds(container)

    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.dataset.embedState).toBe('loaded')
    expect(card.textContent).toContain('TN target counties')
    expect(card.textContent).toContain('Data as of')
    expect(card.textContent).toContain('maria')
    expect(card.textContent).toContain('Shelby County')
    expect(card.textContent).toContain('91.2')
    const link = card.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/views/tn-target-counties')
    expect(link.textContent).toContain('Open in map')
  })

  it('shows at most EMBED_RESULTS_SHOWN results with an "and N more" note', async () => {
    const results = Array.from({ length: 9 }, (_, i) => ({
      rank: i + 1,
      geoId: String(10000 + i),
      name: `County ${i + 1}`,
      state: 'Tennessee',
      score: 90 - i,
    }))
    mockFetchView.mockResolvedValue(makeView({ results }))
    const container = makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>')
    await hydrateEmbeds(container)

    const items = container.querySelectorAll('li')
    expect(items.length).toBe(EMBED_RESULTS_SHOWN)
    expect(container.textContent).toContain(`and ${9 - EMBED_RESULTS_SHOWN} more`)
  })

  it('replaces an entry placeholder with a card linking to the library', async () => {
    mockFetchEntry.mockResolvedValue(makeEntry())
    const container = makeContainer('<div data-embed="entry" data-embed-slug="tn-heirs-dataset"></div>')
    await hydrateEmbeds(container)

    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.dataset.embedState).toBe('loaded')
    expect(card.textContent).toContain('TN Heirs Property')
    expect(card.textContent).toContain('dataset')
    const link = card.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/library/tn-heirs-dataset')
    expect(link.textContent).toContain('Open in library')
  })

  it('renders a not-found note when the view is missing', async () => {
    mockFetchView.mockResolvedValue(null)
    const container = makeContainer('<div data-embed="view" data-embed-slug="gone"></div>')
    await hydrateEmbeds(container)

    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.dataset.embedState).toBe('missing')
    expect(card.textContent).toContain('not found')
    expect(card.textContent).toContain('gone')
  })

  it('marks invalid slugs without fetching', async () => {
    const container = makeContainer(
      '<div data-embed="view" data-embed-slug="NOT VALID"></div>' +
        '<div data-embed="bogus" data-embed-slug="fine-slug"></div>',
    )
    await hydrateEmbeds(container)

    for (const card of container.querySelectorAll<HTMLElement>('[data-embed]')) {
      expect(card.dataset.embedState).toBe('error')
      expect(card.textContent).toContain('Invalid embed')
    }
    expect(mockFetchView).not.toHaveBeenCalled()
    expect(mockFetchEntry).not.toHaveBeenCalled()
  })

  it('degrades to an error note when the fetch fails (does not throw)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchView.mockRejectedValue(new Error('network down'))
    const container = makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>')
    await expect(hydrateEmbeds(container)).resolves.toBeUndefined()

    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.dataset.embedState).toBe('error')
    expect(card.textContent).toContain('tn-target-counties')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is idempotent — a second pass does not refetch or rebuild', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>')
    await hydrateEmbeds(container)
    await hydrateEmbeds(container)
    expect(mockFetchView).toHaveBeenCalledTimes(1)
  })

  it('caches fetches per slug across separate hydrations (fresh DOM, e.g. preview re-render)', async () => {
    mockFetchView.mockResolvedValue(makeView())
    await hydrateEmbeds(makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>'))
    await hydrateEmbeds(makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>'))
    expect(mockFetchView).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed fetch (failures are not cached)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchView.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(makeView())
    await hydrateEmbeds(makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>'))
    const container = makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>')
    await hydrateEmbeds(container)
    expect(container.querySelector<HTMLElement>('[data-embed]')!.dataset.embedState).toBe('loaded')
    warn.mockRestore()
  })

  it('never injects markup from untrusted names (textContent only)', async () => {
    mockFetchView.mockResolvedValue(
      makeView({ name: '<img src=x onerror=alert(1)>', savedBy: '<b>evil</b>' }),
    )
    const container = makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>')
    await hydrateEmbeds(container)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('does nothing on a container with no placeholders', async () => {
    const container = makeContainer('<p>plain page</p>')
    await hydrateEmbeds(container)
    expect(mockFetchView).not.toHaveBeenCalled()
  })
})


// --- Saved table views (P5-54) ----------------------------------------------

/** A saved table view as the server stores it. */
function makeTableView(state: Record<string, unknown> = {}, overrides: Partial<SavedView> = {}): SavedView {
  return {
    slug: 'georgia-orgs',
    name: 'Georgia orgs',
    type: 'table',
    savedBy: 'maria',
    savedAt: '2026-09-05T12:00:00.000Z',
    description: 'Organizations · HQ State is Georgia · 13 rows',
    state: {
      dataset: 'orgs',
      datasetTitle: 'Organizations',
      filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
      sort: 'Score',
      dir: 'desc',
      savedRowCount: 13,
      ...state,
    },
    results: [],
    ...overrides,
  } as unknown as SavedView
}

const ROWS: RowsPage = {
  rows: [
    { _row: 0, Organization: 'Southwest Georgia Project', Tier: 'Tier 1', 'HQ State': 'GA', Score: '75' },
    { _row: 1, Organization: 'Truly Living Well', Tier: 'Tier 2', 'HQ State': 'GA', Score: '60' },
  ],
  total: 15,
  page: 1,
  limit: 20,
}

const TIER_COUNTS: ColumnSummary = {
  column: 'Tier',
  type: 'string',
  filled: 15,
  empty: 0,
  distinct: 2,
  top: [
    { value: 'Tier 1', count: 9 },
    { value: 'Tier 2', count: 6 },
  ],
  numbers: null,
  dates: null,
}

const TABLE_PLACEHOLDER = '<div data-embed="view" data-embed-slug="georgia-orgs">view:georgia-orgs</div>'

describe('table view embeds (P5-54)', () => {
  beforeEach(() => {
    mockFetchRows.mockResolvedValue(ROWS)
    mockFetchSummary.mockResolvedValue(TIER_COUNTS)
  })

  it('re-runs the saved query and shows the first rows, with a link into the explorer', async () => {
    mockFetchView.mockResolvedValue(makeTableView())
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)

    // The saved query, capped to a card's worth of rows.
    expect(mockFetchRows).toHaveBeenCalledWith('orgs', {
      filter: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
      sort: 'Score',
      dir: 'desc',
      limit: EMBED_ROWS_SHOWN,
    })
    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.dataset.embedState).toBe('loaded')
    expect(card.textContent).toContain('Georgia orgs')
    expect(card.textContent).toContain('Organizations · HQ State is Georgia')
    expect([...card.querySelectorAll('th')].map(th => th.textContent)).toEqual(['Organization', 'Tier', 'HQ State', 'Score'])
    expect(card.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(card.textContent).toContain('Southwest Georgia Project')
    expect(card.textContent).toContain('…and 13 more rows')
    const link = card.querySelector('a')!
    expect(link.textContent).toContain('Open the table →')
    const expected = new URLSearchParams({
      tab: 'data',
      sort: 'Score',
      dir: 'desc',
      filter: JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]),
      view: 'georgia-orgs',
    })
    expect(link.getAttribute('href')).toBe(`/library/orgs?${expected.toString()}`)
  })

  it('says when the row count has moved since the view was saved', async () => {
    mockFetchView.mockResolvedValue(makeTableView())
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('Saved with 13 rows · 15 rows now')

    clearEmbedCache()
    mockFetchView.mockResolvedValue(makeTableView({ savedRowCount: 15 }))
    const same = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(same)
    expect(same.textContent).toContain('15 rows')
    expect(same.textContent).not.toContain('Saved with')
  })

  it('shows only the saved columns, and carries county context through the link', async () => {
    mockFetchView.mockResolvedValue(makeTableView({ columns: ['Organization', 'Score'], layers: ['median_home_value'] }))
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)
    expect([...container.querySelectorAll('th')].map(th => th.textContent)).toEqual(['Organization', 'Score'])
    expect(container.querySelector('a')!.getAttribute('href')).toContain('layers=median_home_value')
  })

  it('draws the saved chart instead of the table when the view kept one', async () => {
    mockFetchView.mockResolvedValue(makeTableView({ summary: { column: 'Tier', chart: 'bars' } }))
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)

    expect(mockFetchRows).not.toHaveBeenCalled()
    expect(mockFetchSummary).toHaveBeenCalledWith(
      'orgs',
      { filter: [{ column: 'HQ State', op: 'eq', value: 'GA' }], sort: 'Score', dir: 'desc' },
      'Tier',
      { groupBy: false },
    )
    const card = container.querySelector<HTMLElement>('[data-embed]')!
    expect(card.querySelector('[data-testid="chart-bars"]')).not.toBeNull()
    expect(card.textContent).toContain('Most common values in Tier')
    expect(card.textContent).toContain('9 rows · 60%')
    // The chart's own count is what the note compares against.
    expect(card.textContent).toContain('Saved with 13 rows · 15 rows now')
    expect(card.querySelector('table')).toBeNull()
  })

  it('draws a saved group-by as bars too, asking for the group-by list', async () => {
    mockFetchView.mockResolvedValue(makeTableView({ summary: { groupBy: 'Tier' } }))
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)
    expect(mockFetchSummary.mock.calls[0][3]).toEqual({ groupBy: true })
    expect(container.querySelector('[data-testid="chart-bars"]')).not.toBeNull()
  })

  it('says so plainly when the saved query now matches nothing', async () => {
    mockFetchView.mockResolvedValue(makeTableView())
    mockFetchRows.mockResolvedValue({ rows: [], total: 0, page: 1, limit: 20 })
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('No rows match this view right now.')
    expect(container.textContent).toContain('Saved with 13 rows · 0 rows now')
  })

  it('degrades to a note when the rows request fails, and never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockFetchView.mockResolvedValue(makeTableView())
    mockFetchRows.mockRejectedValue(new Error('403'))
    const container = makeContainer(TABLE_PLACEHOLDER)
    await expect(hydrateEmbeds(container)).resolves.toBeUndefined()
    expect(container.querySelector<HTMLElement>('[data-embed]')!.dataset.embedState).toBe('error')
    warn.mockRestore()
  })

  it('builds every cell with textContent, so a value can never inject markup', async () => {
    mockFetchView.mockResolvedValue(makeTableView({ columns: ['Organization'] }))
    mockFetchRows.mockResolvedValue({
      rows: [{ _row: 0, Organization: '<img src=x onerror=alert(1)>' }],
      total: 1,
      page: 1,
      limit: 20,
    })
    const container = makeContainer(TABLE_PLACEHOLDER)
    await hydrateEmbeds(container)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('leaves the map-view card exactly as it was', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeContainer('<div data-embed="view" data-embed-slug="tn-target-counties"></div>')
    await hydrateEmbeds(container)
    expect(mockFetchRows).not.toHaveBeenCalled()
    expect(container.querySelector('a')!.getAttribute('href')).toBe('/views/tn-target-counties')
    expect(container.textContent).toContain('Data as of')
  })
})


describe('compare view embeds (P5-55)', () => {
  const COMPARE_STATE = {
    counties: ['47157', '13121', '28033'],
    layers: ['median_home_value', 'life_expectancy'],
    notes: { '47157': 'Closest to the river port.' },
  }

  function compareView(state: Record<string, unknown> = {}): SavedView {
    return makeView({
      slug: 'delta-shortlist',
      name: 'Delta shortlist',
      type: 'compare',
      description: '3 counties × 2 layers',
      results: [],
      state: { ...COMPARE_STATE, ...state } as never,
    })
  }

  beforeEach(() => {
    mockLayerIndex.mockResolvedValue(
      new Map([
        ['median_home_value', LAYER_REGISTRY.median_home_value],
        ['life_expectancy', LAYER_REGISTRY.life_expectancy],
      ]),
    )
    mockCompareCounties.mockResolvedValue([
      { geoId: '47157', county: 'Shelby County', state: 'Tennessee' },
      { geoId: '13121', county: 'Fulton County', state: 'Georgia' },
      { geoId: '28033', county: 'DeSoto County', state: 'Mississippi' },
    ])
    mockLayerColumn.mockImplementation(
      async (layer): Promise<LayerColumn> =>
        layer.id === 'median_home_value'
          ? {
              '47157': { value: 180000, display: '$180,000' },
              '13121': { value: 380000, display: '$380,000' },
              '28033': { value: 250000, display: '$250,000' },
            }
          : {
              '47157': { value: 74.2, display: '74.2 yrs' },
              '13121': { value: 79.1, display: '79.1 yrs' },
            },
    )
  })

  async function hydrateCompare(view: SavedView) {
    mockFetchView.mockResolvedValueOnce(view)
    const c = makeContainer('<div data-embed="view" data-embed-slug="delta-shortlist">view:delta-shortlist</div>')
    await hydrateEmbeds(c)
    return c
  }

  it('draws the whole comparison: counties as rows, layers as columns, notes last', async () => {
    const c = await hydrateCompare(compareView())
    const headers = [...c.querySelectorAll('.embed-table th')].map(th => th.textContent)
    expect(headers).toEqual(['County', 'Median Home Value', 'Life Expectancy', 'Notes'])
    const rows = [...c.querySelectorAll('.embed-table tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent),
    )
    expect(rows).toEqual([
      ['Shelby County, Tennessee', '$180,000', '74.2 yrs', 'Closest to the river port.'],
      ['Fulton County, Georgia', '$380,000', '79.1 yrs', ''],
      // No life-expectancy value for DeSoto — a dash, not a blank.
      ['DeSoto County, Mississippi', '$250,000', '—', ''],
    ])
  })

  it('marks best and worst of these counties, in the same words the page uses', async () => {
    const c = await hydrateCompare(compareView())
    const rows = [...c.querySelectorAll('.embed-table tbody tr')]
    const cell = (row: number, col: number) => rows[row].querySelectorAll('td')[col] as HTMLTableCellElement
    // Median home value is lower_better: the cheapest county is best.
    expect(cell(0, 1).title).toBe('best of these')
    expect(cell(1, 1).title).toBe('worst of these')
    expect(cell(2, 1).title).toBe('')
    // Life expectancy is higher_better.
    expect(cell(1, 2).title).toBe('best of these')
  })

  it('leaves the notes column out when nothing was written', async () => {
    const c = await hydrateCompare(compareView({ notes: {} }))
    const headers = [...c.querySelectorAll('.embed-table th')].map(th => th.textContent)
    expect(headers).toEqual(['County', 'Median Home Value', 'Life Expectancy'])
  })

  it('links back to the comparison it came from', async () => {
    const c = await hydrateCompare(compareView())
    const link = c.querySelector('a.embed-link')!
    expect(link.textContent).toBe('Open comparison →')
    const href = link.getAttribute('href')!
    expect(href.startsWith('/compare?')).toBe(true)
    const params = new URLSearchParams(href.split('?')[1])
    expect(params.get('counties')).toBe('47157,13121,28033')
    expect(params.get('view')).toBe('delta-shortlist')
  })

  it('loads only the layers the comparison names', async () => {
    await hydrateCompare(compareView())
    expect(mockLayerColumn).toHaveBeenCalledTimes(2)
    expect(mockLayerColumn.mock.calls.map(call => call[0].id).sort()).toEqual([
      'life_expectancy',
      'median_home_value',
    ])
  })

  it('blanks one column rather than the card when a layer will not load', async () => {
    mockLayerColumn.mockImplementation(async (layer): Promise<LayerColumn> => {
      if (layer.id === 'life_expectancy') throw new Error('offline')
      return { '47157': { value: 180000, display: '$180,000' } }
    })
    const c = await hydrateCompare(compareView())
    expect(c.querySelectorAll('.embed-table tbody tr')).toHaveLength(3)
    expect(c.querySelector('a.embed-link')!.textContent).toBe('Open comparison →')
  })

  it('says so plainly when the saved layers no longer exist', async () => {
    mockLayerIndex.mockResolvedValue(new Map())
    const c = await hydrateCompare(compareView())
    expect(c.textContent).toContain('This comparison has nothing left to show.')
  })

  it('builds every cell with textContent, so a county name can never inject markup', async () => {
    mockCompareCounties.mockResolvedValue([
      { geoId: '47157', county: '<img src=x onerror=alert(1)>', state: 'Tennessee' },
    ])
    const c = await hydrateCompare(compareView({ counties: ['47157'], notes: { '47157': '<script>bad()</script>' } }))
    expect(c.querySelector('img')).toBeNull()
    expect(c.querySelector('script')).toBeNull()
    expect(c.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

// --- Map blocks (P7-4) -------------------------------------------------------

describe('a map block in a page', () => {
  function workingSet(over: Partial<WorkingSetDetail> = {}): WorkingSetDetail {
    return {
      slug: 'memphis-redevelopment',
      name: 'Memphis redevelopment',
      purpose: '',
      description: '',
      datasets: [],
      layers: [],
      sites: '',
      derivedCount: 0,
      savedBy: 'maria',
      savedAt: '2026-10-05T10:00:00.000Z',
      updatedAt: '2026-10-05T10:00:00.000Z',
      views: [
        { slug: 'memphis-map', name: 'Memphis map', type: 'map' },
        { slug: 'memphis-table', name: 'Memphis sites by distance', type: 'table' },
      ],
      members: [],
      missing: [],
      ...over,
    }
  }

  /**
   * THE acceptance criterion: no block, no map code.
   *
   * Measured at the module graph rather than asserted in prose — the component
   * is behind a dynamic `import()`, and mapbox-gl plus the county files are
   * behind the component, so a factory that never ran is the whole claim.
   */
  it('is never imported by a page that has no map block', async () => {
    mockFetchView.mockResolvedValue(makeView())
    mockFetchEntry.mockResolvedValue(makeEntry())
    const container = makeAttachedContainer(
      '<div data-embed="view" data-embed-slug="tn-target-counties">view:tn-target-counties</div>' +
        '<div data-embed="entry" data-embed-slug="tn-heirs-dataset">entry:tn-heirs-dataset</div>',
    )
    await hydrateEmbeds(container)

    expect(container.querySelectorAll('.wiki-embed-card')).toHaveLength(2)
    expect(block.imports).toBe(0)
  })

  it('mounts the block for a map: placeholder, with the view it names', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeAttachedContainer(
      '<div data-embed="map" data-embed-slug="tn-target-counties">map:tn-target-counties</div>',
    )
    await hydrateEmbeds(container)

    expect(block.imports).toBe(1)
    const mounted = container.querySelector('.stub-map')!
    expect(mounted.textContent).toBe('TN target counties')
    expect(mounted.getAttribute('data-mode')).toBe('live')
    expect(container.querySelector('[data-embed]')!.className).toContain('wiki-embed-map')
  })

  it('lends the host its router, so what the block mounts can navigate', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: {} }] })
    await hydrateEmbeds(
      makeAttachedContainer('<div data-embed="map" data-embed-slug="tn-target-counties">map:x</div>'),
      { router },
    )
    expect(block.routers).toEqual([router])
  })

  it('tells the block not to draw in the editor preview', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeAttachedContainer(
      '<div data-embed="map" data-embed-slug="tn-target-counties">map:tn-target-counties</div>',
    )
    await hydrateEmbeds(container, { liveMaps: false })
    expect(container.querySelector('.stub-map')!.getAttribute('data-mode')).toBe('preview')
  })

  it('draws at most MAP_BLOCKS_LIVE canvases per page, in the order a reader meets them', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeAttachedContainer(mapPlaceholders(MAP_BLOCKS_LIVE + 2))
    await hydrateEmbeds(container)

    const modes = [...container.querySelectorAll('.stub-map')].map(node => node.getAttribute('data-mode'))
    expect(modes).toEqual([...Array(MAP_BLOCKS_LIVE).fill('live'), 'capped', 'capped'])
    // The capped ones are told the number so they can say it.
    expect(container.querySelectorAll('[data-mode="capped"]')[0].getAttribute('data-limit')).toBe(
      String(MAP_BLOCKS_LIVE),
    )
  })

  it('counts the maps already on the page, so a second pass cannot exceed the cap', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const first = makeAttachedContainer(mapPlaceholders(MAP_BLOCKS_LIVE - 1, 'a'))
    await hydrateEmbeds(first)
    const second = makeAttachedContainer(mapPlaceholders(2, 'b'))
    await hydrateEmbeds(second)

    const modes = [...second.querySelectorAll('.stub-map')].map(node => node.getAttribute('data-mode'))
    expect(modes).toEqual(['live', 'capped'])
  })

  it('releases a block whose node has left the document — that is the WebGL context', async () => {
    mockFetchView.mockResolvedValue(makeView())
    const container = makeAttachedContainer(mapPlaceholders(1))
    await hydrateEmbeds(container)
    expect(block.unmounts).toBe(0)

    // What the editor's preview does on every keystroke: replace the DOM.
    container.innerHTML = mapPlaceholders(1, 'later')
    await hydrateEmbeds(container)
    expect(block.unmounts).toBe(1)
  })

  it('asks for the view once when a page carries both a card and a map of it', async () => {
    mockFetchView.mockResolvedValue(makeView())
    await hydrateEmbeds(
      makeAttachedContainer(
        '<div data-embed="view" data-embed-slug="tn-target-counties">view:x</div>' +
          '<div data-embed="map" data-embed-slug="tn-target-counties">map:x</div>',
      ),
    )
    expect(mockFetchView).toHaveBeenCalledTimes(1)
  })

  it('says a slug is a WORKING SET and names its views — a page embeds a view of it (§F.1)', async () => {
    mockFetchView.mockResolvedValue(null)
    mockFetchWorkingSet.mockResolvedValue(workingSet())
    const container = makeAttachedContainer(
      '<div data-embed="map" data-embed-slug="memphis-redevelopment">map:memphis-redevelopment</div>',
    )
    await hydrateEmbeds(container)

    const text = container.textContent!
    expect(text).toContain('is a working set, not a view')
    expect(text).toContain('Memphis map')
    expect(text).toContain('Memphis sites by distance')
    // Nothing was mounted, so nothing map-shaped was fetched either.
    expect(block.imports).toBe(0)
  })

  it('says a set has no views yet rather than printing an empty list', async () => {
    mockFetchView.mockResolvedValue(null)
    mockFetchWorkingSet.mockResolvedValue(workingSet({ views: [] }))
    const container = makeAttachedContainer('<div data-embed="map" data-embed-slug="memphis-redevelopment">m</div>')
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('this set has none yet')
  })

  it('falls back to "not found" when the slug is neither a view nor a set', async () => {
    mockFetchView.mockResolvedValue(null)
    mockFetchWorkingSet.mockResolvedValue(null)
    const container = makeAttachedContainer('<div data-embed="map" data-embed-slug="ghost">map:ghost</div>')
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('Saved view not found: ghost')
    expect(container.querySelector('[data-embed-state]')!.getAttribute('data-embed-state')).toBe('missing')
  })

  it('does not take the page down when the working-set lookup itself fails', async () => {
    mockFetchView.mockResolvedValue(null)
    mockFetchWorkingSet.mockRejectedValue(new Error('offline'))
    const container = makeAttachedContainer('<div data-embed="map" data-embed-slug="ghost">map:ghost</div>')
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('Saved view not found: ghost')
  })

  it('rejects a map block whose slug is not slug-shaped, before anything is fetched', async () => {
    const container = makeAttachedContainer('<div data-embed="map" data-embed-slug="NOT A SLUG">map:bad</div>')
    await hydrateEmbeds(container)
    expect(container.textContent).toContain('Invalid embed: map:')
    expect(mockFetchView).not.toHaveBeenCalled()
    expect(block.imports).toBe(0)
  })
})
