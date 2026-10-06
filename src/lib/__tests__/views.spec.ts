import { describe, it, expect, vi, beforeEach } from 'vitest'

// P5-55: views.ts now reaches compare.ts, which registers a logout hook —
// so useAuth loads here too and reads API_URL. An empty one keeps its boot
// requests from firing at all, which is what this spec wants anyway.
vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: '',
  setInternalCsrfToken: vi.fn(),
}))

import { internalFetch } from '../apiBase'
import {
  saveView,
  fetchView,
  fetchViews,
  compareStateOf,
  compareViewUrl,
  describesAMap,
  mapStateOf,
  tableStateOf,
  tableViewUrl,
  viewOpenUrl,
  interfaceForViewType,
  parseSetInterface,
  workingSetViewHref,
  readSiteLayers,
  siteLayerRestore,
  VIEW_RESULTS_MAX,
  type SavedView,
} from '../views'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mockedFetch.mockReset()
})

const SAMPLE_STATE = {
  layers: [{ layerId: 'combined_scores_v2', weight: 1, direction: 'high' }],
  filters: [],
  limit: 20,
  regionStates: ['TN'],
  prompt: 'top 20 counties by land value',
  viewport: { center: [-86.7, 35.8] as [number, number], zoom: 6.5 },
}

const SAMPLE_RESULTS = [
  { rank: 1, geoId: '47157', name: 'Shelby County', state: 'Tennessee', score: 91.2 },
]

describe('saveView', () => {
  it('POSTs the snapshot as JSON to /api/views and returns the slug', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'tn-target-counties', name: 'TN target counties' }, 201))
    const result = await saveView({
      name: 'TN target counties',
      state: SAMPLE_STATE,
      results: SAMPLE_RESULTS,
    })
    expect(result).toEqual({ slug: 'tn-target-counties', name: 'TN target counties' })

    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/views')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    const body = JSON.parse(String(init?.body))
    expect(body.name).toBe('TN target counties')
    expect(body.state).toEqual(SAMPLE_STATE)
    expect(body.results).toEqual(SAMPLE_RESULTS)
  })

  it('trims the results snapshot to the server cap before sending', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'big', name: 'big' }, 201))
    const results = Array.from({ length: 150 }, (_, i) => ({
      rank: i + 1,
      geoId: String(i),
      name: `County ${i}`,
      state: 'TN',
      score: i,
    }))
    await saveView({ name: 'big', state: SAMPLE_STATE, results })
    const body = JSON.parse(String(mockedFetch.mock.calls[0][1]?.body))
    expect(body.results).toHaveLength(VIEW_RESULTS_MAX)
    expect(body.results[0].rank).toBe(1)
  })

  it('surfaces the server error message on failure', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'a view name is required' }, 400))
    await expect(
      saveView({ name: '', state: SAMPLE_STATE, results: [] }),
    ).rejects.toThrow('a view name is required')
  })
})

describe('fetchView', () => {
  it('GETs /api/views/:slug and returns the full snapshot', async () => {
    const doc = {
      slug: 'tn-target-counties',
      name: 'TN target counties',
      savedBy: 'maria',
      savedAt: '2026-09-03T12:00:00.000Z',
      state: SAMPLE_STATE,
      results: SAMPLE_RESULTS,
    }
    mockedFetch.mockResolvedValue(jsonResponse(doc))
    const view = await fetchView('tn-target-counties')
    // P5-54: a document written before saved table views existed is a map view.
    expect(view).toEqual({ ...doc, type: 'map' })
    expect(mockedFetch).toHaveBeenCalledWith('/api/views/tn-target-counties')
  })

  it('encodes the slug into the path', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    await fetchView('weird/slug')
    expect(mockedFetch).toHaveBeenCalledWith('/api/views/weird%2Fslug')
  })

  it('returns null on 404 (view was deleted or never existed)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    expect(await fetchView('nope')).toBeNull()
  })

  it('throws the server message on other failures', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(fetchView('tn-target-counties')).rejects.toThrow('library unavailable')
  })
})

// --- Saved table views (P5-54) ---------------------------------------------

/** What the server stores for a saved table view. */
const TABLE_DOC = {
  slug: 'georgia-orgs',
  name: 'Georgia orgs',
  type: 'table' as const,
  savedBy: 'maria',
  savedAt: '2026-09-05T12:00:00.000Z',
  description: 'Organizations · HQ State is Georgia · 13 rows',
  state: {
    dataset: 'orgs',
    datasetTitle: 'Organizations',
    file: 'organizations.csv',
    q: 'farm',
    filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
    sort: 'Score',
    dir: 'desc',
    columns: ['Organization', 'Tier'],
    layers: ['median_home_value'],
    summary: { column: 'Tier', chart: 'bars' },
    savedRowCount: 13,
  },
  results: [],
}

function tableView(state: Record<string, unknown>): SavedView {
  return { ...TABLE_DOC, state } as unknown as SavedView
}

describe('saveView — table views', () => {
  it('sends the type and the table state, with no result rows to snapshot', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'georgia-orgs', name: 'Georgia orgs' }, 201))
    await saveView({ name: 'Georgia orgs', type: 'table', state: TABLE_DOC.state as never })
    const body = JSON.parse(String(mockedFetch.mock.calls[0][1]?.body))
    expect(body.type).toBe('table')
    expect(body.state.dataset).toBe('orgs')
    expect(body.results).toEqual([])
  })
})

describe('tableStateOf', () => {
  it('reads a saved table view back, defaults and all', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(TABLE_DOC))
    const view = (await fetchView('georgia-orgs'))!
    expect(view.type).toBe('table')
    expect(tableStateOf(view)).toEqual(TABLE_DOC.state)
  })

  it('is null for a map view', () => {
    const map = { ...TABLE_DOC, type: 'map' as const } as unknown as SavedView
    expect(tableStateOf(map)).toBeNull()
  })

  it('drops what a hand-edited document got wrong instead of throwing', () => {
    const state = tableStateOf(
      tableView({
        dataset: 'orgs',
        filters: [
          { column: 'Tier', op: 'eq', value: 'Tier 1' },
          { column: 'Tier', op: 'nonsense', value: 'x' },
          { column: 'Score', op: 'gte' },
          'not-a-filter',
        ],
        dir: 'sideways',
        columns: ['ok', 7],
        layers: [],
        summary: { column: 'Tier', chart: 'pie' },
        savedRowCount: -4,
      }),
    )
    expect(state).toEqual({
      dataset: 'orgs',
      filters: [{ column: 'Tier', op: 'eq', value: 'Tier 1' }],
      columns: ['ok'],
      savedRowCount: 0,
    })
  })

  it('is null when the document names no dataset at all', () => {
    expect(tableStateOf(tableView({ filters: [] }))).toBeNull()
  })
})

describe('tableViewUrl / viewOpenUrl', () => {
  it('rebuilds the explorer URL: Data tab, saved query, county layers, and the view slug', () => {
    const url = tableViewUrl(tableStateOf(tableView(TABLE_DOC.state))!, 'georgia-orgs')
    expect(url.startsWith('/library/orgs?')).toBe(true)
    const params = new URLSearchParams(url.split('?')[1])
    expect(Object.fromEntries(params)).toEqual({
      tab: 'data',
      file: 'organizations.csv',
      q: 'farm',
      sort: 'Score',
      dir: 'desc',
      filter: JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]),
      layers: 'median_home_value',
      view: 'georgia-orgs',
    })
  })

  it('leaves out everything that is at its default', () => {
    const url = tableViewUrl({ dataset: 'orgs', filters: [], savedRowCount: 0 })
    expect(url).toBe('/library/orgs?tab=data')
  })

  it('sends a map view to the map shim and a table view to its table', () => {
    const map = { ...TABLE_DOC, type: 'map' as const, slug: 'tn' } as unknown as SavedView
    expect(viewOpenUrl(map)).toBe('/?view=tn')
    expect(viewOpenUrl(tableView(TABLE_DOC.state))).toContain('/library/orgs?tab=data')
  })

  /**
   * P7-2: a view presenting a working set opens on the set's two interfaces,
   * which is where that view's framing now lives. Same rule as the rest of
   * this function — send a view to the surface that can show what it is of.
   */
  it('sends a set-backed view to its two interfaces, in the one its own kind names', () => {
    const map = { ...TABLE_DOC, type: 'map' as const, slug: 'tn', workingSet: 'memphis' } as unknown as SavedView
    expect(viewOpenUrl(map)).toBe('/views/tn')
    const table = { ...tableView(TABLE_DOC.state), workingSet: 'memphis' }
    expect(viewOpenUrl(table)).toBe('/views/georgia-orgs')
  })

  it('leaves an ad-hoc view exactly where it was — absent and blank both mean ad-hoc', () => {
    const map = { ...TABLE_DOC, type: 'map' as const, slug: 'tn', workingSet: '' } as unknown as SavedView
    expect(viewOpenUrl(map)).toBe('/?view=tn')
  })
})

// --- mapStateOf (P7-4) -------------------------------------------------------

/** A map view document, with only the state fields a case cares about. */
function mapView(state: Record<string, unknown>): SavedView {
  return {
    slug: 'memphis-siting',
    name: 'Memphis siting',
    type: 'map',
    savedBy: 'maria',
    savedAt: '2026-10-06T00:00:00.000Z',
    state: state as unknown as SavedView['state'],
    results: [],
  }
}

describe('mapStateOf (P7-4)', () => {
  it('reads a map view\'s own state back: layers with their weights, filters, limit, region, points and viewport', () => {
    expect(
      mapStateOf(
        mapView({
          layers: [
            { layerId: 'pct_Black', weight: 7, direction: 'higher_better' },
            { layerId: 'internal-brownfields', weight: 3 },
          ],
          filters: [{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }],
          limit: 25,
          regionStates: ['TN', 'MS'],
          prompt: 'brownfields near Memphis',
          viewport: { center: [-90.05, 35.15], zoom: 8.5 },
          pointLayers: [{ id: 'internal-organizations', name: 'Organizations' }],
          siteLayers: ['superfund_sites'],
        }),
      ),
    ).toEqual({
      layers: [
        { layerId: 'pct_Black', weight: 7, direction: 'higher_better' },
        { layerId: 'internal-brownfields', weight: 3, direction: undefined },
      ],
      filters: [{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }],
      limit: 25,
      regionStates: ['TN', 'MS'],
      pointLayers: ['internal-organizations'],
      siteLayers: ['superfund_sites'],
      viewport: { center: [-90.05, 35.15], zoom: 8.5 },
    })
  })

  it('is null for a table view and for a comparison — a map view is the only thing with a map state', () => {
    expect(mapStateOf({ ...mapView({}), type: 'table' })).toBeNull()
    expect(mapStateOf({ ...mapView({}), type: 'compare' })).toBeNull()
  })

  it('reads a view that saved nothing as a view that says nothing', () => {
    expect(mapStateOf(mapView({}))).toEqual({
      layers: [],
      filters: [],
      limit: null,
      regionStates: [],
      pointLayers: [],
      siteLayers: [],
      viewport: null,
    })
  })

  it('drops what a hand-edited document got wrong instead of throwing', () => {
    const state = mapStateOf(
      mapView({
        layers: [
          { layerId: 'pct_Black', weight: 5 },
          { layerId: 'no-weight' },
          { weight: 2 },
          'not-a-layer',
          null,
        ],
        filters: [{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }, { layerId: 'x' }, 'nope'],
        limit: 'twenty',
        regionStates: ['TN', 7],
        pointLayers: [{ name: 'no id' }, { id: 'internal-organizations', name: 'Organizations' }],
        siteLayers: ['not-a-site-layer'],
      }),
    )
    expect(state).toEqual({
      layers: [{ layerId: 'pct_Black', weight: 5, direction: undefined }],
      filters: [{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }],
      limit: null,
      regionStates: ['TN'],
      pointLayers: ['internal-organizations'],
      siteLayers: [],
      viewport: null,
    })
  })

  it('keeps only a direction the scoring engine knows, so an unknown one falls back to the registry default', () => {
    // SAMPLE_STATE's own `direction: 'high'` is exactly this case.
    const state = mapStateOf(mapView(SAMPLE_STATE))
    expect(state?.layers).toEqual([{ layerId: 'combined_scores_v2', weight: 1, direction: undefined }])
  })

  it('refuses a half-written viewport rather than jumping somewhere arbitrary', () => {
    expect(mapStateOf(mapView({ viewport: { center: [-90.05], zoom: 8 } }))?.viewport).toBeNull()
    expect(mapStateOf(mapView({ viewport: { center: [-90.05, 35.15] } }))?.viewport).toBeNull()
    expect(mapStateOf(mapView({ viewport: { center: ['west', 35.15], zoom: 8 } }))?.viewport).toBeNull()
    expect(mapStateOf(mapView({ viewport: null }))?.viewport).toBeNull()
  })
})

describe('describesAMap (P7-4)', () => {
  it('is true for a map view that names at least one layer', () => {
    expect(describesAMap(mapView({ layers: [{ layerId: 'pct_Black', weight: 5 }] }))).toBe(true)
  })

  it('is false for a map view that names none, so a block can say so instead of drawing nothing', () => {
    expect(describesAMap(mapView({ layers: [] }))).toBe(false)
  })

  it('is false for a table view', () => {
    expect(describesAMap({ ...mapView({ layers: [{ layerId: 'pct_Black', weight: 5 }] }), type: 'table' })).toBe(false)
  })

  it('is true for a map view with no layers but a point overlay — the points ARE the map', () => {
    expect(
      describesAMap(mapView({ layers: [], pointLayers: [{ id: 'internal-organizations', name: 'Orgs' }] })),
    ).toBe(true)
  })
})

describe('fetchViews', () => {
  it('lists every view, and narrows to one dataset when asked', async () => {
    const rows = [{ slug: 'a', name: 'A', type: 'table', dataset: 'orgs', description: 'x', savedBy: 'm', savedAt: '', resultCount: 0 }]
    mockedFetch.mockResolvedValue(jsonResponse({ views: rows }))
    expect(await fetchViews()).toEqual(rows)
    expect(mockedFetch).toHaveBeenLastCalledWith('/api/views')

    mockedFetch.mockResolvedValue(jsonResponse({ views: rows }))
    await fetchViews({ dataset: 'orgs/1' })
    expect(mockedFetch).toHaveBeenLastCalledWith('/api/views?dataset=orgs%2F1')
  })

  it('is an empty list, not a crash, when the server sends something else', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({}))
    expect(await fetchViews()).toEqual([])
  })

  it('throws the server message on failure', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(fetchViews()).rejects.toThrow('library unavailable')
  })
})

// --- Compare views (P5-55) --------------------------------------------------

const COMPARE_DOC = {
  slug: 'delta-shortlist',
  name: 'Delta shortlist',
  type: 'compare' as const,
  savedBy: 'maria',
  savedAt: '2026-09-05T12:00:00.000Z',
  state: {
    counties: ['47157', '28033'],
    layers: ['median_home_value', 'life_expectancy'],
    notes: { '47157': 'Closest to the river port.' },
  },
  results: [],
}

function compareView(state: Record<string, unknown>): SavedView {
  return { ...COMPARE_DOC, state } as unknown as SavedView
}

describe('compareStateOf', () => {
  it('reads the counties, layers and notes a comparison was saved with', () => {
    expect(compareStateOf(compareView(COMPARE_DOC.state))).toEqual({
      counties: ['47157', '28033'],
      layers: ['median_home_value', 'life_expectancy'],
      notes: { '47157': 'Closest to the river port.' },
    })
  })

  it('is null for any other kind of view', () => {
    expect(compareStateOf({ ...COMPARE_DOC, type: 'map' } as unknown as SavedView)).toBeNull()
    expect(compareStateOf({ ...COMPARE_DOC, type: 'table' } as unknown as SavedView)).toBeNull()
  })

  it('drops junk from a hand-edited document instead of throwing', () => {
    const state = compareStateOf(
      compareView({
        counties: ['47157', '471', 42, '28033'],
        layers: ['median_home_value', '../etc', ''],
        notes: { '47157': '   ', '99999': 'orphan note', '28033': 'x'.repeat(700) },
      }),
    )
    expect(state).toEqual({
      counties: ['47157', '28033'],
      layers: ['median_home_value'],
      // Blank notes and notes for counties that are gone are dropped; a long
      // one is cut to the same 500 characters the server enforces.
      notes: { '28033': 'x'.repeat(500) },
    })
  })

  it('is null when nothing is left to compare', () => {
    expect(compareStateOf(compareView({ counties: [], layers: ['median_home_value'] }))).toBeNull()
    expect(compareStateOf(compareView({ counties: ['47157'], layers: [] }))).toBeNull()
  })
})

describe('compareViewUrl / viewOpenUrl for comparisons', () => {
  it('opens /compare with the saved counties, layers and the view slug', () => {
    const url = compareViewUrl(compareStateOf(compareView(COMPARE_DOC.state))!, 'delta-shortlist')
    const params = new URLSearchParams(url.split('?')[1])
    expect(url.startsWith('/compare?')).toBe(true)
    expect(Object.fromEntries(params)).toEqual({
      counties: '47157,28033',
      layers: 'median_home_value,life_expectancy',
      view: 'delta-shortlist',
    })
  })

  it('is where a compare view opens', () => {
    expect(viewOpenUrl(compareView(COMPARE_DOC.state))).toContain('/compare?counties=47157%2C28033')
  })
})

describe('fetchViews by type', () => {
  it('asks the server for one kind of view (the Saved comparisons strip)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ views: [] }))
    await fetchViews({ type: 'compare' })
    expect(mockedFetch).toHaveBeenLastCalledWith('/api/views?type=compare')
  })
})

// --- P5-78: the contamination site layers a map view remembers ---------------

describe('siteLayers on a map view (P5-78)', () => {
  it('sends the site layers that were on, and reads them back unchanged', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'sites-over-equity', name: 'Sites over equity' }, 201))
    await saveView({
      name: 'Sites over equity',
      state: { ...SAMPLE_STATE, siteLayers: ['superfund_sites', 'acres_brownfields'] },
      results: [],
    })
    const body = JSON.parse((mockedFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.state.siteLayers).toEqual(['superfund_sites', 'acres_brownfields'])

    mockedFetch.mockResolvedValue(
      jsonResponse({
        slug: 'sites-over-equity',
        name: 'Sites over equity',
        savedBy: 'maria',
        savedAt: '2026-09-07T00:00:00.000Z',
        state: { ...SAMPLE_STATE, siteLayers: ['superfund_sites', 'acres_brownfields'] },
        results: [],
      }),
    )
    const view = await fetchView('sites-over-equity')
    expect(view?.state.siteLayers).toEqual(['superfund_sites', 'acres_brownfields'])
    expect(readSiteLayers(view?.state.siteLayers)).toEqual(['superfund_sites', 'acres_brownfields'])
  })

  it('a view saved without site layers stays a view with none', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'plain', name: 'Plain' }, 201))
    await saveView({ name: 'Plain', state: SAMPLE_STATE, results: [] })
    const body = JSON.parse((mockedFetch.mock.calls[0][1] as RequestInit).body as string)
    expect(body.state).not.toHaveProperty('siteLayers')
    expect(readSiteLayers(undefined)).toEqual([])
  })
})

describe('readSiteLayers (P5-78)', () => {
  it('keeps the known ids, in the order they were saved, without duplicates', () => {
    expect(readSiteLayers(['toxic_release_inventory', 'superfund_sites', 'superfund_sites'])).toEqual([
      'toxic_release_inventory',
      'superfund_sites',
    ])
  })

  it('drops an id the map cannot act on, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readSiteLayers(['superfund_sites', 'lead_pipes', 42])).toEqual(['superfund_sites'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/lead_pipes/)
    warn.mockRestore()
  })

  it('ignores a field that is not a list rather than throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readSiteLayers('superfund_sites')).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('siteLayerRestore (P5-78)', () => {
  it('switches on what the view had and off what it did not', () => {
    expect(siteLayerRestore(['superfund_sites', 'acres_brownfields'], ['acres_brownfields', 'hazardous_waste_sites'])).toEqual({
      on: ['superfund_sites'],
      off: ['hazardous_waste_sites'],
    })
  })

  it('leaves a layer that is already on alone — nothing is re-fetched', () => {
    expect(siteLayerRestore(['superfund_sites'], ['superfund_sites'])).toEqual({ on: [], off: [] })
  })

  it('turns everything off for a view saved before P5-78', () => {
    expect(siteLayerRestore(undefined, ['superfund_sites'])).toEqual({ on: [], off: ['superfund_sites'] })
  })
})

/**
 * P7-1. A view PRESENTS a working set, and the pointer is beside `state`
 * rather than inside it — `state` is framing, and a working set is the
 * opposite of framing.
 *
 * The case that matters most is the absent one: a view with no pointer is
 * ad-hoc, which is permanent and first-class, so the field must not be sent,
 * stored or read as an empty string anywhere in the document path.
 */
describe('the working set a view presents (P7-1)', () => {
  it('sends the pointer when there is one', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'memphis-cluster', name: 'Memphis cluster' }, 201))
    await saveView({
      name: 'Memphis cluster',
      state: SAMPLE_STATE,
      results: [],
      workingSet: 'memphis-redevelopment',
    })
    const body = JSON.parse(String(mockedFetch.mock.calls[0][1]?.body))
    expect(body.workingSet).toBe('memphis-redevelopment')
    // Beside the state, never inside it.
    expect(body.state.workingSet).toBeUndefined()
  })

  it('sends no pointer at all for an ad-hoc view', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'exploring', name: 'Just exploring' }, 201))
    await saveView({ name: 'Just exploring', state: SAMPLE_STATE, results: [] })
    const body = JSON.parse(String(mockedFetch.mock.calls[0][1]?.body))
    expect('workingSet' in body).toBe(false)
  })

  it('reads the pointer back off the document, and reads its absence as ad-hoc', async () => {
    const doc = {
      slug: 'memphis-cluster',
      name: 'Memphis cluster',
      type: 'map',
      savedBy: 'maria',
      savedAt: '2026-10-05T10:00:00Z',
      state: SAMPLE_STATE,
      results: [],
      workingSet: 'memphis-redevelopment',
    }
    mockedFetch.mockResolvedValue(jsonResponse(doc))
    expect((await fetchView('memphis-cluster'))?.workingSet).toBe('memphis-redevelopment')

    const { workingSet: _none, ...adhoc } = doc
    mockedFetch.mockResolvedValue(jsonResponse(adhoc))
    expect((await fetchView('memphis-cluster'))?.workingSet).toBeUndefined()
  })

  it('lists the views of one set — "a set may carry several views", asked', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ views: [] }))
    await fetchViews({ workingSet: 'memphis-redevelopment' })
    expect(mockedFetch).toHaveBeenLastCalledWith('/api/views?workingSet=memphis-redevelopment')
  })
})

// --- P7-2: two interfaces over one working set -------------------------------

describe('which interface a set-backed view opens in', () => {
  it('is the one the view’s own type names — the view IS the framing', () => {
    expect(interfaceForViewType('map')).toBe('map')
    expect(interfaceForViewType('table')).toBe('data')
    expect(interfaceForViewType('compare')).toBe('map')
  })

  it('reads ?interface= and falls back rather than throwing on a hand-edited link', () => {
    expect(parseSetInterface('data', 'map')).toBe('data')
    expect(parseSetInterface('map', 'data')).toBe('map')
    expect(parseSetInterface(['data'], 'map')).toBe('data')
    expect(parseSetInterface('sideways', 'map')).toBe('map')
    expect(parseSetInterface(undefined, 'data')).toBe('data')
  })

  it('deep-links to either interface, and leaves the default unsaid', () => {
    expect(workingSetViewHref('memphis-map')).toBe('/views/memphis-map')
    expect(workingSetViewHref('memphis-map', 'map', 'map')).toBe('/views/memphis-map')
    expect(workingSetViewHref('memphis-map', 'data', 'map')).toBe('/views/memphis-map?interface=data')
    // A table view's default is the data interface, so the MAP is the one its
    // link has to name.
    expect(workingSetViewHref('memphis-table', 'data', 'table')).toBe('/views/memphis-table')
    expect(workingSetViewHref('memphis-table', 'map', 'table')).toBe('/views/memphis-table?interface=map')
  })

  it('encodes a slug rather than trusting it', () => {
    expect(workingSetViewHref('a b', 'data')).toBe('/views/a%20b?interface=data')
  })
})
