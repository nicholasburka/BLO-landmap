import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalog: vi.fn() }
})
vi.mock('@/lib/apiBase', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apiBase')>()
  return { ...actual, internalFetch: vi.fn() }
})

import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { internalFetch } from '@/lib/apiBase'
import {
  searchEverything,
  searchInsideDocuments,
  documentPageHref,
  searchUrl,
  filtersFromQuery,
  GROUPS,
  INSIDE_DOCUMENTS,
  TEXT_SEARCH_BELOW,
  type TextHit,
} from '@/lib/search'

const mockedCatalog = vi.mocked(fetchCatalog)
const mockedFetch = vi.mocked(internalFetch)

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: 'organizations',
    kind: 'dataset',
    title: 'Organizations',
    category: 'network',
    status: 'published',
    tags: [],
    meta: {},
    files: [],
    bytes: 0,
    ...overrides,
  }
}

/** One row of every kind, in an order the groups must NOT preserve. */
const ONE_OF_EACH: CatalogEntry[] = [
  entry({ slug: 'epa-npl', kind: 'source', title: 'EPA Superfund NPL sites', meta: { source: { provider: 'US EPA' } } }),
  entry({ slug: 'org-drop', kind: 'incoming', title: 'example.org/orgs.csv' }),
  entry({ slug: 'org-idea', kind: 'note', title: 'An idea about orgs' }),
  entry({ slug: 'org-view', kind: 'view', title: 'Org view' }),
  entry({ slug: 'funding-network', kind: 'wiki', title: 'Funding network' }),
  entry({ slug: 'field-notes', kind: 'document', title: 'Field notes' }),
  entry({ slug: 'organizations', kind: 'dataset', title: 'Organizations' }),
  entry({ slug: 'poverty', kind: 'layer', title: 'Poverty rate' }),
]

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

const HIT: TextHit = {
  entryId: 'plan',
  title: 'Strategic plan',
  file: 'Five_Year_Plan.pdf',
  page: 12,
  snippet: '…the cohort counties in Alabama and Mississippi…',
  score: 4.2,
}

beforeEach(() => {
  mockedCatalog.mockReset()
  mockedFetch.mockReset()
  mockedCatalog.mockResolvedValue([])
  mockedFetch.mockResolvedValue(jsonResponse(200, { results: [] }))
})

describe('searchEverything (P6-6)', () => {
  it('groups every kind in the held-first order, keeping the server\'s order inside a group', async () => {
    mockedCatalog.mockResolvedValue(ONE_OF_EACH)
    const { groups } = await searchEverything('org')
    expect(groups.map(g => g.name)).toEqual([...GROUPS])
    // Docs holds two: the dropped link and the document.
    expect(groups.map(g => g.items.length)).toEqual([1, 1, 1, 2, 1, 1, 1])
    // A saved view is an analysis; a dropped link is a document to file.
    expect(groups.find(g => g.name === 'Analyses')!.items[0].title).toBe('Org view')
    expect(groups.find(g => g.name === 'Docs')!.items.map(i => i.title)).toEqual(['example.org/orgs.csv', 'Field notes'])
  })

  it('leaves out a group nothing matched, and counts what did', async () => {
    mockedCatalog.mockResolvedValue([entry(), entry({ slug: 'tn-heirs', title: 'Heirs share' })])
    const { groups, matched } = await searchEverything('heirs')
    expect(groups.map(g => g.name)).toEqual(['Datasets'])
    expect(matched).toBe(2)
  })

  it('carries each row\'s badge, verdict and link', async () => {
    mockedCatalog.mockResolvedValue([
      entry({ readiness: { as: 'dataset', placeReport: 'runs', notes: ['county column'] } }),
      entry({ slug: 'funding-network', kind: 'wiki', title: 'Funding network' }),
      entry({ slug: 'epa-npl', kind: 'source', title: 'EPA NPL', meta: { source: { provider: 'US EPA' } } }),
    ])
    const { groups } = await searchEverything('org')
    const dataset = groups.find(g => g.name === 'Datasets')!.items[0]
    expect(dataset.badge).toBe('dataset')
    expect(dataset.verdict).toBe('Ready as: a table we hold · Place report: runs · county column')
    expect(dataset.href).toBe('/library/organizations')
    // A page opens at its own route, and its filing says nothing about a page.
    const page = groups.find(g => g.name === 'Pages')!.items[0]
    expect(page.badge).toBe('page')
    expect(page.verdict).toBe('')
    expect(page.href).toBe('/wiki/funding-network')
    expect(groups.find(g => g.name === 'Sources')!.items[0].badge).toBe('Source')
  })

  it('sends the five filters to the catalog, with `type` asking the catalog\'s `shape`', async () => {
    await searchEverything('  land  ', { kind: 'dataset', organization: 'epa', topic: 'land', type: 'areas', purpose: 'research' })
    expect(mockedCatalog).toHaveBeenCalledWith({
      q: 'land',
      kind: 'dataset',
      organization: 'epa',
      topic: 'land',
      shape: 'areas',
      purpose: 'research',
    })
  })

  it('asks nothing at all for a blank query', async () => {
    const { groups, matched } = await searchEverything('   ')
    expect(groups).toEqual([])
    expect(matched).toBe(0)
    expect(mockedCatalog).not.toHaveBeenCalled()
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})

describe('inside documents (spec §D.14)', () => {
  const four = Array.from({ length: TEXT_SEARCH_BELOW - 1 }, (_, i) => entry({ slug: `d${i}`, title: `Dataset ${i}` }))
  const five = Array.from({ length: TEXT_SEARCH_BELOW }, (_, i) => entry({ slug: `d${i}`, title: `Dataset ${i}` }))

  it('searches the documents when the catalog found fewer than five rows', async () => {
    mockedCatalog.mockResolvedValue(four)
    mockedFetch.mockResolvedValue(jsonResponse(200, { results: [HIT] }))
    const { groups, searchedInsideDocuments } = await searchEverything('cohort counties')
    expect(searchedInsideDocuments).toBe(true)
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/search-text?q=cohort+counties')
    // Last, under the filed rows — a second place to look, not the answer.
    expect(groups[groups.length - 1].name).toBe(INSIDE_DOCUMENTS)
  })

  it('does not when five rows came back', async () => {
    mockedCatalog.mockResolvedValue(five)
    const { groups, searchedInsideDocuments } = await searchEverything('cohort counties')
    expect(searchedInsideDocuments).toBe(false)
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(groups.some(g => g.name === INSIDE_DOCUMENTS)).toBe(false)
  })

  it('does not when a chip is narrowing the list — the text search cannot honour it', async () => {
    mockedCatalog.mockResolvedValue(four)
    const { searchedInsideDocuments } = await searchEverything('cohort counties', { topic: 'land' })
    expect(searchedInsideDocuments).toBe(false)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('opens the viewer at the page, and at the file when the format has no pages', async () => {
    mockedCatalog.mockResolvedValue(four)
    mockedFetch.mockResolvedValue(
      jsonResponse(200, { results: [HIT, { ...HIT, entryId: 'manual', file: 'Fact_Manual.docx', page: null }] }),
    )
    const { groups } = await searchEverything('cohort counties')
    const items = groups[groups.length - 1].items
    expect(items[0].href).toBe('/library/plan?view=Five_Year_Plan.pdf&tab=files#page=12')
    expect(items[0].page).toBe(12)
    expect(items[0].snippet).toContain('cohort counties')
    expect(items[0].badge).toBe('page 12')
    expect(items[1].href).toBe('/library/manual?view=Fact_Manual.docx&tab=files')
    expect(items[1].badge).toBe('Fact_Manual.docx')
  })

  it('keeps the filed rows when the document search fails', async () => {
    mockedCatalog.mockResolvedValue(four)
    mockedFetch.mockResolvedValue(jsonResponse(500, { error: 'nope' }))
    const { groups } = await searchEverything('cohort counties')
    expect(groups.map(g => g.name)).toEqual(['Datasets'])
  })

  it('throws on its own when asked directly', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(500, { error: 'nope' }))
    await expect(searchInsideDocuments('cohort')).rejects.toThrow(/500/)
  })
})

describe('chips', () => {
  /**
   * These cases are about the facet arithmetic over the rows below, so they
   * ask a word the real layer registry cannot answer (P6-20 merges matching
   * registry rows into the same counts). Keeping the registry out of the
   * fixture is deliberate: a new public layer must not be able to break the
   * maths. The layers' own contribution is covered in its own describe.
   */
  const NO_LAYER_MATCHES = 'zzzznotalayer'

  const ROWS = [
    entry({ slug: 'a', kind: 'dataset', category: 'land', organization: 'epa', organizationLabel: 'US EPA', shape: 'areas' }),
    entry({ slug: 'b', kind: 'dataset', category: 'land', organization: 'epa', organizationLabel: 'US EPA', shape: 'points' }),
    entry({ slug: 'c', kind: 'source', category: 'environment', organization: 'usgs', organizationLabel: 'USGS', shape: 'points' }),
    entry({ slug: 'd', kind: 'note', category: 'ideas' }),
  ]

  it('counts what the rows are filed under, biggest first, and leaves out what nothing carries', async () => {
    mockedCatalog.mockResolvedValue(ROWS)
    const { facets } = await searchEverything(NO_LAYER_MATCHES)
    expect(facets.organization).toEqual([
      { id: 'epa', label: 'US EPA', count: 2 },
      { id: 'usgs', label: 'USGS', count: 1 },
    ])
    expect(facets.kind.map(f => `${f.label}:${f.count}`)).toEqual(['dataset:2', 'note:1', 'source:1'])
    expect(facets.type).toEqual([
      { id: 'points', label: 'Sites and points', count: 2 },
      { id: 'areas', label: 'Areas and boundaries', count: 1 },
    ])
    expect(facets.purpose).toEqual([{ id: 'ideas', label: 'Ideas', count: 1 }])
    // The note carries no publisher, and nothing here is filed under a shape
    // it does not have: an absent value is not a chip.
    expect(facets.organization.some(f => !f.id)).toBe(false)
  })

  it('counts them off the whole query, so a chosen chip does not hide the others', async () => {
    mockedCatalog.mockImplementation(async (filters = {}) =>
      filters.organization === 'epa' ? ROWS.filter(r => r.organization === 'epa') : ROWS,
    )
    const { facets, groups } = await searchEverything(NO_LAYER_MATCHES, { organization: 'epa' })
    expect(groups.flatMap(g => g.items)).toHaveLength(2)
    expect(facets.organization.map(f => f.id)).toEqual(['epa', 'usgs'])
  })
})

describe('urls', () => {
  it('writes the query and the five filter keys, dropping the empty ones', () => {
    expect(searchUrl('heirs property', { topic: 'land', type: 'areas' })).toBe(
      '/search?q=heirs+property&topic=land&type=areas',
    )
    expect(searchUrl('heirs', {})).toBe('/search?q=heirs')
    expect(searchUrl('  ', {})).toBe('/search')
  })

  it('reads them back off a route, ignoring repeated and unknown keys', () => {
    expect(filtersFromQuery({ q: 'heirs', kind: 'dataset', type: 'areas', junk: 'x', topic: ['a', 'b'] })).toEqual({
      kind: 'dataset',
      type: 'areas',
    })
  })

  it('builds a page link the entry hub and the viewer both understand', () => {
    expect(documentPageHref('plan', 'Five Year Plan.pdf', 3)).toBe(
      '/library/plan?view=Five+Year+Plan.pdf&tab=files#page=3',
    )
    expect(documentPageHref('plan', 'notes.docx', null)).toBe('/library/plan?view=notes.docx&tab=files')
  })
})

describe('map layers in the results (P6-20)', () => {
  // The audit's repro: the palette finds a layer, the page it escalates to did not.
  it('finds a public map layer by its own name, under Layers', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('median home')
    const layers = out.groups.find(g => g.name === 'Layers')
    expect(layers, 'the Layers group the spec reserves must actually fill').toBeTruthy()
    expect(layers!.items.some(i => /median home/i.test(i.title))).toBe(true)
  })

  it('sends a layer row to its about page, not into /library', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('median home')
    const item = out.groups.find(g => g.name === 'Layers')!.items[0]
    expect(item.href).toMatch(/^\/layers\//)
  })

  it('keeps the held-first group order with layers present', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('median home')
    const names = out.groups.map(g => g.name).filter(n => n !== INSIDE_DOCUMENTS)
    expect(names).toEqual([...names].sort((a, b) => GROUPS.indexOf(a as never) - GROUPS.indexOf(b as never)))
  })

  it('counts layers in the chips, so a chip cannot disagree with its own rows', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('median home')
    const layerCount = out.groups.find(g => g.name === 'Layers')!.items.length
    expect(out.facets.kind.find(f => f.id === 'layer')?.count).toBe(layerCount)
  })

  it('drops every layer when a purpose is asked for, because no layer has one', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('median home', { purpose: 'research' })
    expect(out.groups.find(g => g.name === 'Layers')).toBeUndefined()
  })

  it('honours a kind filter that names layers', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('median home', { kind: 'layer' })
    expect(out.groups.find(g => g.name === 'Layers')!.items.length).toBeGreaterThan(0)
  })

  it('matches nothing for a word no layer carries', async () => {
    mockedCatalog.mockResolvedValue([])
    const out = await searchEverything('zzzznotalayer')
    expect(out.groups.find(g => g.name === 'Layers')).toBeUndefined()
  })
})
