import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

// P5-73: the `npm run library -- fetch` sentence is admin-only, so the role
// is a controllable ref rather than whatever the real session happens to be.
const roleRef = ref<{ username: string; role: 'admin' | 'internal' } | null>({ username: 'dev', role: 'admin' })
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: roleRef }),
  registerLogoutHook: vi.fn(),
}))

// P5-70: the Overview preview reads the same extraction the viewer's "Text"
// mode does. P5-71: the checklist ticks when the viewer opens.
vi.mock('@/lib/documentView', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/documentView')>()
  return { ...actual, loadDocumentText: vi.fn() }
})
vi.mock('@/lib/firstRun', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/firstRun')>()
  return { ...actual, completeFirstRunStep: vi.fn() }
})

// P5-77: "Show on map" asks the manifest for the layer's frame. The helper has
// its own spec; here it is faked so the page's two links can be checked.
vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, mapHrefForInternalLayerId: vi.fn() }
})

// P6-8: a dropped FILE has nothing to re-fetch, so its "Look again" is the
// annotate route instead.
vi.mock('@/lib/bulkDrop', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/bulkDrop')>()
  return { ...actual, annotateAgain: vi.fn() }
})

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return {
    ...actual,
    fetchCatalogEntry: vi.fn(),
    fetchCatalog: vi.fn(),
    fetchViewsUsingLayer: vi.fn(),
    fileCatalogEntry: vi.fn(),
    refetchLink: vi.fn(),
    // P5-59
    inspectEntryLink: vi.fn(),
    fetchSourceProposal: vi.fn(),
    setIngestPlan: vi.fn(),
    replicateEntryNow: vi.fn(),
    createLinkEntry: vi.fn(),
  }
})

import {
  fetchCatalog,
  fetchCatalogEntry,
  fetchViewsUsingLayer,
  fileCatalogEntry,
  refetchLink,
  fetchSourceProposal,
  createLinkEntry,
  type CatalogEntry,
} from '@/lib/libraryCatalog'
import { annotateAgain } from '@/lib/bulkDrop'
import { mapHrefForInternalLayerId } from '@/lib/internalLayers'
import { loadDocumentText } from '@/lib/documentView'
import { completeFirstRunStep } from '@/lib/firstRun'
import LibraryEntryView from '../LibraryEntryView.vue'
// P6-24: the parity assertion mounts the browser the reader came FROM, so the
// row and the page are compared as rendered rather than through a shared
// helper that could be wrong in both places at once.
import DatasetsView from '../DatasetsView.vue'
import { readStyles, ruleFor } from '@/testing/sfcStyles'

const mockedEntry = vi.mocked(fetchCatalogEntry)
const mockedCatalog = vi.mocked(fetchCatalog)
const mockedViews = vi.mocked(fetchViewsUsingLayer)
const mockedText = vi.mocked(loadDocumentText)
const mockedFirstRun = vi.mocked(completeFirstRunStep)
const mockedMapHref = vi.mocked(mapHrefForInternalLayerId)
const mockedAnnotate = vi.mocked(annotateAgain)

const DatasetViewStub = { template: '<div data-testid="dataset-view-stub">table</div>' }
/** P5-57: the panel has its own spec; here we only care that it appears, for
 *  the right entry, pointed at the place the link named. */
const PlaceFetchPanelStub = {
  props: ['slug', 'source', 'openPlace'],
  template: '<div data-testid="place-fetch-panel" :data-slug="slug" :data-open-place="openPlace" />',
}
const DocumentViewerStub = { props: ['slug', 'name'], emits: ['close'], template: '<div data-testid="doc-viewer-stub">{{ name }}<button data-testid="stub-close" @click="$emit(\'close\')">x</button></div>' }

function entry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    slug: 'organizations',
    kind: 'dataset',
    title: 'Organizations',
    category: 'network',
    status: 'published',
    tags: ['homesteading'],
    meta: { description: 'Who we know.', layer: { geometry: 'point', name: 'Organizations (HQ)', description: 'HQ points' }, mentionedBy: [{ slug: 'funding-network', title: 'Funding network' }, { slug: 'homesteading-initiative', title: 'Hub' }] },
    files: [{ key: 'library/datasets/organizations/organizations.csv', size: 100 }, { key: 'library/datasets/organizations/meta.json', size: 10 }],
    bytes: 110,
    supersededBy: null,
    supersedes: [],
    ...overrides,
  }
}

let router: Router
async function mountAt(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/library/:slug', component: LibraryEntryView },
      { path: '/library/:slug/data', redirect: to => ({ path: `/library/${String(to.params.slug)}`, query: { ...to.query, tab: 'data' } }) },
      { path: '/wiki/:slug', component: { template: '<div />' } },
      { path: '/views/:slug', component: { template: '<div />' } },
      { path: '/', component: { template: '<div />' } },
      { path: '/library', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const w = mount(LibraryEntryView, { global: { plugins: [router], stubs: { DatasetView: DatasetViewStub, DocumentViewer: DocumentViewerStub, PlaceFetchPanel: PlaceFetchPanelStub } } })
  await flushPromises()
  return w
}

beforeEach(() => {
  mockedEntry.mockReset()
  mockedViews.mockReset()
  mockedText.mockReset()
  mockedFirstRun.mockReset()
  mockedMapHref.mockReset()
  mockedMapHref.mockResolvedValue('/?layers=internal-organizations&fit=bbox%3A-90.31%2C34.99%2C-89.6%2C35.35')
  roleRef.value = { username: 'dev', role: 'admin' }
  // Most entries hold no extraction; the ones that do say so per test.
  mockedText.mockRejectedValue(new Error('No text was found in this file.'))
  mockedEntry.mockResolvedValue(entry())
  mockedViews.mockResolvedValue([{ slug: 'org-hq-view', title: 'Org HQ view', savedBy: 'nick', savedAt: '2026-09-04T00:00:00.000Z' }])
})

describe('LibraryEntryView hub (P5-37)', () => {
  it('shows the tabs the entry supports, with counts, and Overview by default', async () => {
    const w = await mountAt('/library/organizations')
    expect(w.findAll('[data-testid="entry-tabs"] [role="tab"]').map(t => t.attributes('data-tab'))).toEqual(['overview', 'data', 'map', 'mentions', 'files'])
    expect(w.get('[role="tab"][data-tab="mentions"]').text()).toContain('3') // 2 pages + 1 view
    // P5-70: meta.json is the manifest, not a file — the count is the CSV alone.
    expect(w.get('[role="tab"][data-tab="files"]').text()).toContain('1')
    expect(w.find('[data-testid="tab-overview"]').exists()).toBe(true)
    expect(w.get('[data-testid="tab-overview"]').text()).toContain('Who we know.')
    expect(w.get('[data-testid="browse-data"]').attributes('href')).toBe('/library/organizations?tab=data')
    expect(mockedMapHref).toHaveBeenCalledWith('internal-organizations')
    expect(w.get('[data-testid="show-on-map"]').attributes('href')).toContain('fit=bbox%3A')
  })

  it('a plain document gets Overview / Mentions / Files only', async () => {
    mockedEntry.mockResolvedValue(entry({ slug: 'plan', kind: 'document', meta: { mentionedBy: [] }, files: [{ key: 'library/documents/plan/plan.pdf', size: 5 }] }))
    const w = await mountAt('/library/plan')
    expect(w.findAll('[role="tab"]').map(t => t.attributes('data-tab'))).toEqual(['overview', 'mentions', 'files'])
    expect(mockedViews).not.toHaveBeenCalled()
  })

  it('tab clicks write ?tab= and render the matching panel; the Data tab hosts the table', async () => {
    const w = await mountAt('/library/organizations')
    await w.get('[role="tab"][data-tab="data"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.tab).toBe('data')
    expect(w.find('[data-testid="dataset-view-stub"]').exists()).toBe(true)
    await w.get('[role="tab"][data-tab="files"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-testid="file-download"]')).toHaveLength(1)
    await w.get('[role="tab"][data-tab="overview"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('Mentions lists wiki pages and saved views; Map lists views and the show-on-map action', async () => {
    const w = await mountAt('/library/organizations?tab=mentions')
    expect(w.findAll('[data-testid="mention-pages"] a').map(a => a.attributes('href'))).toEqual(['/wiki/funding-network', '/wiki/homesteading-initiative'])
    expect(w.findAll('[data-testid="mention-views"] a').map(a => a.attributes('href'))).toEqual(['/views/org-hq-view'])
    expect(mockedViews).toHaveBeenCalledWith('internal-organizations')
    await router.push('/library/organizations?tab=map')
    await flushPromises()
    expect(w.get('[data-testid="tab-map"]').text()).toContain('Organizations (HQ)')
    expect(w.get('[data-testid="map-open"]').attributes('href')).toContain('fit=bbox%3A')
    expect(w.findAll('[data-testid="layer-views"] a')).toHaveLength(1)
  })

  it('old /library/:slug/data links redirect into the Data tab with their table state', async () => {
    await mountAt('/library/organizations/data?q=georgia&sort=Tier')
    expect(router.currentRoute.value.path).toBe('/library/organizations')
    expect(router.currentRoute.value.query).toEqual({ q: 'georgia', sort: 'Tier', tab: 'data' })
  })

  it('a link drop shows its URL, note, and the fetch hint on Overview (P5-34)', async () => {
    mockedEntry.mockResolvedValue(entry({ slug: 'abc', kind: 'incoming', status: 'needs-cataloging', meta: { url: 'https://example.org/parcels', note: 'needs login', originalFilename: null }, files: [{ key: 'library/incoming/abc/meta.json', size: 1 }] }))
    const w = await mountAt('/library/abc')
    const block = w.get('[data-testid="entry-link-block"]')
    expect(block.get('a').attributes('href')).toBe('https://example.org/parcels')
    expect(block.get('a').attributes('rel')).toBe('noopener noreferrer')
    expect(block.text()).toContain('needs login')
    expect(block.text()).toContain('npm run library -- fetch abc')
  })

  it('an unknown tab falls back to Overview', async () => {
    const w = await mountAt('/library/organizations?tab=nope')
    expect(w.find('[data-testid="tab-overview"]').exists()).toBe(true)
  })
})

describe('in-app document viewing (P5-44)', () => {
  const doc = () => entry({ slug: 'plan', kind: 'document', meta: { mentionedBy: [] }, files: [{ key: 'library/documents/plan/Five_Year_Plan.pdf', size: 500 }, { key: 'library/documents/plan/data.xlsx', size: 20 }] })

  it('offers View for a viewable file and Download for one that is not', async () => {
    mockedEntry.mockResolvedValue(doc())
    const w = await mountAt('/library/plan?tab=files')
    const view = w.get('[data-testid="file-view"]')
    expect(view.text()).toBe('Five_Year_Plan.pdf')
    // the xlsx is not viewable → download link, no view button for it
    const dls = w.findAll('[data-testid="file-download"]').map(a => a.text())
    expect(dls.some(t => t.includes('data.xlsx'))).toBe(true)
  })

  it('opens the viewer via ?view= and closes back to the list', async () => {
    mockedEntry.mockResolvedValue(doc())
    const w = await mountAt('/library/plan?tab=files')
    await w.get('[data-testid="file-view"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="doc-viewer-stub"]').exists()).toBe(true)
    expect(w.get('[data-testid="doc-viewer-stub"]').text()).toContain('Five_Year_Plan.pdf')
    expect(router.currentRoute.value.query.view).toBe('Five_Year_Plan.pdf')

    await w.get('[data-testid="stub-close"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="doc-viewer-stub"]').exists()).toBe(false)
    expect(w.find('[data-testid="file-view"]').exists()).toBe(true)
    expect(router.currentRoute.value.query.view).toBeUndefined()
  })

  it('ignores a ?view= that names a non-viewable or missing file', async () => {
    mockedEntry.mockResolvedValue(doc())
    const w = await mountAt('/library/plan?tab=files&view=data.xlsx')
    expect(w.find('[data-testid="doc-viewer-stub"]').exists()).toBe(false)
    const w2 = await mountAt('/library/plan?tab=files&view=ghost.pdf')
    expect(w2.find('[data-testid="doc-viewer-stub"]').exists()).toBe(false)
  })
})

// --- P5-56: the Source block ------------------------------------------------

const mockedFile = vi.mocked(fileCatalogEntry)

const EPA_SOURCE = {
  provider: 'US EPA',
  program: 'Superfund / CERCLIS',
  homepage: 'https://www.epa.gov/superfund/sites',
  geography: 'point',
  coverage: 'national',
  granularity: ['point', 'county'],
  topics: ['contamination', 'hazardous waste'],
  fields: Array.from({ length: 8 }, (_, i) => ({ name: `FIELD_${i}`, description: `Column ${i}` })),
  access: [
    { type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0', auth: 'none', notes: 'query by envelope' },
    { type: 'manual', auth: 'login', notes: 'email the county' },
  ],
  license: 'public domain',
  updateCadence: 'monthly',
  lastChecked: '2026-09-05',
  relevance: 'A red flag within a few miles of a candidate parcel.',
  replication: { status: 'indexed' },
}

function sourceEntry(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): CatalogEntry {
  return entry({
    slug: 'epa-npl',
    kind: 'source',
    title: 'EPA Superfund NPL sites',
    category: 'environment',
    status: 'published',
    tags: ['environmental-risk'],
    files: [{ key: 'library/sources/epa-npl/meta.json', size: 900 }],
    meta: { description: 'Every site on or proposed for the NPL.', mentionedBy: [], source: EPA_SOURCE, ...meta },
    ...overrides,
  })
}

describe('LibraryEntryView Source block (P5-56)', () => {
  it('answers who, what, how, terms and why — on Overview', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')
    const block = w.get('[data-testid="source-block"]')
    expect(block.text()).toContain('US EPA')
    expect(block.text()).toContain('Superfund / CERCLIS')
    expect(w.get('[data-testid="source-covers"]').text()).toContain('point · national · point, county')
    expect(w.get('[data-testid="source-topics"]').text()).toContain('contamination')
    expect(w.get('[data-testid="source-terms"]').text()).toContain('public domain · monthly · checked 2026-09-05')
    expect(w.get('[data-testid="source-relevance"]').text()).toContain('red flag')
    // notes are optional; the fixture has none, so the line is absent
    expect(w.find('[data-testid="source-notes"]').exists()).toBe(false)
    expect(w.get('[data-testid="source-homepage"]').attributes('href')).toBe('https://www.epa.gov/superfund/sites')
  })

  it('shows the first six fields with a "Show all" that reveals the rest', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')
    expect(w.findAll('[data-testid="source-fields"] dt')).toHaveLength(6)
    expect(w.get('[data-testid="show-all-fields"]').text()).toContain('Show all 8')
    await w.get('[data-testid="show-all-fields"]').trigger('click')
    expect(w.findAll('[data-testid="source-fields"] dt')).toHaveLength(8)
    expect(w.find('[data-testid="show-all-fields"]').exists()).toBe(false)
  })

  it('lists each way to get it with a type badge, the link, and whether a key is needed', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')
    const rows = w.findAll('[data-testid="source-access"] li')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('ArcGIS')
    expect(rows[0].get('a').attributes('href')).toBe('https://services.arcgis.com/x/FeatureServer/0')
    expect(rows[0].text()).toContain('no key needed')
    expect(rows[0].text()).toContain('query by envelope')
    expect(rows[1].text()).toContain('Manual')
    expect(rows[1].text()).toContain('key needed')
  })

  it('says what we actually hold, in each replication state', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    let w = await mountAt('/library/epa-npl')
    expect(w.get('[data-testid="source-replication"]').text()).toContain('Indexed — not copied here')

    mockedEntry.mockResolvedValue(sourceEntry({}, { source: { ...EPA_SOURCE, replication: { status: 'partial', slices: ['npl-shelby', 'npl-davidson'] } } }))
    w = await mountAt('/library/epa-npl')
    const partial = w.get('[data-testid="source-replication"]')
    expect(partial.text()).toContain('Partly copied: 2 slices')
    expect(partial.findAll('a').map(a => a.attributes('href'))).toEqual(['/library/npl-shelby', '/library/npl-davidson'])

    mockedEntry.mockResolvedValue(sourceEntry({}, { source: { ...EPA_SOURCE, replication: { status: 'replicated', dataset: 'npl-sites' } } }))
    w = await mountAt('/library/epa-npl')
    expect(w.get('[data-testid="source-replication"]').text()).toContain('Copied as')
    expect(w.get('[data-testid="source-replication"] a').attributes('href')).toBe('/library/npl-sites')
  })

  it('offers Ask about this source, prefilled, and gates Fetch for a place on an adapter', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')
    expect((w.get('[data-testid="ask-input"]').element as HTMLInputElement).value).toBe(
      'What does EPA Superfund NPL sites cover and how do I query it for a place?',
    )
    const fetchBtn = w.get('[data-testid="fetch-for-place"]')
    // P5-57: the button is live now, and it opens the panel rather than a page.
    expect(fetchBtn.attributes('disabled')).toBeUndefined()
    expect(fetchBtn.text()).toBe('Fetch for a place')
    expect(w.find('[data-testid="place-fetch-panel"]').exists()).toBe(false)

    await fetchBtn.trigger('click')
    expect(w.find('[data-testid="place-fetch-panel"]').exists()).toBe(true)
    expect(w.get('[data-testid="fetch-for-place"]').text()).toBe('Hide the place fetcher')

    // Nothing to automate: no button rather than a permanently dead one.
    mockedEntry.mockResolvedValue(sourceEntry({}, { source: { ...EPA_SOURCE, access: [{ type: 'manual' }] } }))
    const manual = await mountAt('/library/epa-npl')
    expect(manual.find('[data-testid="fetch-for-place"]').exists()).toBe(false)
  })

  it('opens the panel already, and on the named place, when a link says ?place=', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl?place=g13121')
    const panel = w.get('[data-testid="place-fetch-panel"]')
    expect(panel.attributes('data-open-place')).toBe('g13121')
  })

  it('renders a bare block — provider only — which is what a link drop produces', async () => {
    mockedEntry.mockResolvedValue(sourceEntry({}, { source: { provider: 'Shelby County Assessor' } }))
    const w = await mountAt('/library/epa-npl')
    const block = w.get('[data-testid="source-block"]')
    expect(block.text()).toContain('Shelby County Assessor')
    expect(block.text()).toContain('Indexed — not copied here')
    for (const id of ['source-covers', 'source-topics', 'source-fields', 'source-access', 'source-terms', 'source-relevance', 'fetch-for-place']) {
      expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(false)
    }
    // Still askable — that is the point of registering it at all.
    expect(w.find('[data-testid="ask-input"]').exists()).toBe(true)
  })

  it('shows no block for an entry without one, and keeps a plain-string source as prose', async () => {
    mockedEntry.mockResolvedValue(entry({ meta: { description: 'Who we know.', source: 'DC Open Data, 2024', mentionedBy: [] } }))
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="source-block"]').exists()).toBe(false)
    // P5-65 called this line "Publisher:". P6-24 took that word away from it:
    // the prose is where the material came from, and the publisher is the
    // curated organization in the meta row.
    expect(w.get('.entry-source').text()).toBe('Where it came from: DC Open Data, 2024')
  })
})

describe('LibraryEntryView "This is a data source" (P5-56)', () => {
  beforeEach(() => {
    mockedFile.mockReset()
  })

  it('files an incoming link as a source with the block from the form', async () => {
    mockedEntry.mockResolvedValue(
      entry({ slug: 'abc-uuid', kind: 'incoming', title: 'msc.fema.gov/portal', status: 'needs-cataloging', category: '', tags: [], meta: { url: 'https://msc.fema.gov/portal', mentionedBy: [] }, files: [{ key: 'library/incoming/abc-uuid/meta.json', size: 10 }] }),
    )
    mockedFile.mockResolvedValue(sourceEntry({ slug: 'abc-uuid' }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.find('[data-testid="source-form"]').exists()).toBe(false)

    await w.get('[data-testid="filing-is-source"]').setValue(true)
    await w.get('[data-testid="source-form-provider"]').setValue('FEMA')
    await w.get('[data-testid="source-form-geography"]').setValue('parcel')
    await w.get('[data-testid="source-form-topics"]').setValue('flooding, hazard')
    await w.get('[data-testid="source-form-access-type"]').setValue('arcgis')
    await w.get('[data-testid="source-form-access-url"]').setValue('https://hazards.fema.gov/FeatureServer/0')
    await w.get('form.filing-form').trigger('submit')
    await flushPromises()

    expect(mockedFile).toHaveBeenCalledWith('abc-uuid', expect.objectContaining({
      source: {
        provider: 'FEMA',
        geography: 'parcel',
        topics: ['flooding', 'hazard'],
        access: [{ type: 'arcgis', url: 'https://hazards.fema.gov/FeatureServer/0' }],
      },
    }))
    expect(w.get('.filing-note').text()).toContain('Filed as a data source')
  })

  it('refuses to send a block with no provider, without calling the API', async () => {
    mockedEntry.mockResolvedValue(entry({ slug: 'abc-uuid', kind: 'incoming', title: 'x', meta: { mentionedBy: [] }, files: [] }))
    const w = await mountAt('/library/abc-uuid')
    await w.get('[data-testid="filing-is-source"]').setValue(true)
    await w.get('form.filing-form').trigger('submit')
    await flushPromises()
    expect(mockedFile).not.toHaveBeenCalled()
    expect(w.get('.filing-note').text()).toContain('needs a provider')
  })

  it('opens an existing source ticked and prefilled so the rest can be filled in later', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    mockedFile.mockResolvedValue(sourceEntry())
    // P5-67: a source's form lives behind Edit; `?edit=1` is that same door.
    const w = await mountAt('/library/epa-npl?edit=1')
    expect((w.get('[data-testid="filing-is-source"]').element as HTMLInputElement).checked).toBe(true)
    expect((w.get('[data-testid="source-form-provider"]').element as HTMLInputElement).value).toBe('US EPA')
    expect((w.get('[data-testid="source-form-access-type"]').element as HTMLSelectElement).value).toBe('arcgis')
    expect(w.get('form.filing-form h2').text()).toBe('Edit this source')

    await w.get('[data-testid="source-form-license"]').setValue('public domain')
    await w.get('form.filing-form').trigger('submit')
    await flushPromises()
    expect(mockedFile.mock.calls[0][1].source).toMatchObject({ provider: 'US EPA', license: 'public domain' })
  })
})

// --- P5-47: fetch on drop + the suggestion panel -----------------------------

const mockedRefetch = vi.mocked(refetchLink)

const SUGGESTION = {
  title: 'County parcel export, Shelby County',
  category: 'places',
  tags: ['parcels', 'tennessee'],
  summary: 'One row per parcel with owner, acreage and assessed value.',
  at: '2026-09-05T00:00:00.000Z',
  model: 'claude-sonnet-5',
}

/** A dropped link, as the entry looks once the server has been at it. */
function drop(meta: Record<string, unknown> = {}, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return entry({
    slug: 'abc-uuid',
    kind: 'incoming',
    title: 'example.org/parcels.csv',
    category: '',
    status: 'needs-cataloging',
    tags: [],
    meta: { url: 'https://example.org/parcels.csv', mentionedBy: [], ...meta },
    files: [{ key: 'library/incoming/abc-uuid/meta.json', size: 10 }],
    ...over,
  })
}

describe('LibraryEntryView fetch status (P5-47)', () => {
  beforeEach(() => {
    mockedRefetch.mockReset()
  })

  it('says the link is being fetched, and offers nothing to do about it', async () => {
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'fetching', at: '2026-09-05T00:00:00.000Z' } }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('[data-testid="fetch-status"]').text()).toContain('Fetching the link…')
    expect(w.find('[data-testid="fetch-retry"]').exists()).toBe(false)
    // The old "a dev can run the CLI" hint is gone once the server is on it.
    expect(w.get('[data-testid="entry-link-block"]').text()).not.toContain('npm run library')
  })

  it('names the file it fetched, its size and when', async () => {
    mockedEntry.mockResolvedValue(
      drop(
        { fetch: { status: 'fetched', at: new Date(Date.now() - 3 * 60_000).toISOString(), bytes: 2048, name: 'parcels.csv' }, originalFilename: 'parcels.csv' },
        { files: [{ key: 'library/incoming/abc-uuid/meta.json', size: 10 }, { key: 'library/incoming/abc-uuid/parcels.csv', size: 2048 }] },
      ),
    )
    const w = await mountAt('/library/abc-uuid')
    const line = w.get('[data-testid="fetch-status"]').text()
    expect(line).toContain('Fetched parcels.csv')
    expect(line).toContain('2 KB')
    expect(line).toContain('3m ago')
    expect(w.find('[data-testid="fetch-retry"]').exists()).toBe(false)
  })

  it('says why it could not, and Try again re-queues the fetch and re-reads the entry', async () => {
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'failed', at: '2026-09-05T00:00:00.000Z', reason: 'the site refused the request' } }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('[data-testid="fetch-status"]').text()).toContain('Could not fetch: the site refused the request')

    mockedRefetch.mockResolvedValue('queued')
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'queued', at: '2026-09-05T01:00:00.000Z' } }))
    await w.get('[data-testid="fetch-retry"]').trigger('click')
    await flushPromises()
    expect(mockedRefetch).toHaveBeenCalledWith('abc-uuid')
    expect(w.get('[data-testid="fetch-status"]').text()).toContain('Fetching the link…')
  })

  it('offers Try again for a drop the queue was too busy to take', async () => {
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'later', at: '2026-09-05T00:00:00.000Z', reason: 'the fetch queue is busy' } }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('[data-testid="fetch-status"]').text()).toContain('Not fetched yet')
    expect(w.find('[data-testid="fetch-retry"]').exists()).toBe(true)
  })

  it('says why a page was not downloaded instead of blaming the queue (P5-79)', async () => {
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'later', at: '2026-09-05T00:00:00.000Z', reason: 'a web page — its text was read for the summary; nothing to download' } }))
    const w = await mountAt('/library/drop-1')
    expect(w.get('[data-testid="fetch-status"]').text()).toContain('Not downloaded: a web page — its text was read for the summary; nothing to download.')
    expect(w.get('[data-testid="fetch-status"]').text()).not.toContain('queue')
  })

  it('shows the failure in words on the card list too — via the chip helper', async () => {
    mockedEntry.mockResolvedValue(drop())
    const w = await mountAt('/library/abc-uuid')
    // No fetch block at all: nothing to say, and the CLI hint still stands.
    expect(w.find('[data-testid="fetch-status"]').exists()).toBe(false)
    expect(w.get('[data-testid="entry-link-block"]').text()).toContain('npm run library -- fetch abc-uuid')
  })
})

describe('LibraryEntryView back-link (P6-5)', () => {
  it('goes to the browser the entry lives in, not the retired /library', async () => {
    mockedEntry.mockResolvedValue(drop({}))
    const w = await mountAt('/library/abc-uuid')
    const link = w.get('.back-link')
    expect(link.text()).toBe('← Docs')
    expect(link.attributes('href')).toBe('/docs')
  })
})

describe('LibraryEntryView suggestion panel (P5-47)', () => {
  beforeEach(() => {
    mockedFile.mockReset()
  })

  it('shows and applies the proposed organization and type, and the filing carries them (P6-8a)', async () => {
    const proposal = { ...SUGGESTION, organization: 'regrid', shape: 'areas' }
    mockedEntry.mockResolvedValue(drop({ suggested: proposal, originalFilename: 'parcels.csv' }))
    mockedFile.mockResolvedValue(drop({ suggested: proposal }, { status: 'needs-review' }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('[data-testid="suggested-organization"]').text()).toBe('Regrid')
    expect(w.get('[data-testid="suggested-shape"]').text()).toBe('Areas and boundaries')
    expect((w.get('[data-testid="filing-organization"]').element as HTMLSelectElement).value).toBe('')

    await w.get('[data-testid="apply-suggestion"]').trigger('click')
    expect((w.get('[data-testid="filing-organization"]').element as HTMLSelectElement).value).toBe('regrid')
    expect((w.get('[data-testid="filing-shape"]').element as HTMLSelectElement).value).toBe('areas')

    await w.get('form.filing-form').trigger('submit')
    await flushPromises()
    expect(mockedFile).toHaveBeenCalledWith('abc-uuid', expect.objectContaining({ organization: 'regrid', shape: 'areas' }))
  })

  it('shows what the assistant proposed and why, without touching the form', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: SUGGESTION, originalFilename: 'parcels.csv' }))
    const w = await mountAt('/library/abc-uuid')
    const panel = w.get('[data-testid="suggestion-panel"]')
    expect(panel.text()).toContain('Suggested by the assistant')
    expect(w.get('[data-testid="suggested-title"]').text()).toBe('County parcel export, Shelby County')
    expect(w.get('[data-testid="suggested-category"]').text()).toBe('places')
    expect(w.get('[data-testid="suggested-tags"]').text()).toBe('parcels, tennessee')
    expect(w.get('[data-testid="suggested-summary"]').text()).toContain('One row per parcel')
    expect(w.get('[data-testid="suggestion-why"]').text()).toContain('Based on the first pages of parcels.csv')

    // Nothing is applied until the button is pressed.
    expect((w.get('input[aria-label="Title"]').element as HTMLInputElement).value).toBe('example.org/parcels.csv')
    expect((w.get('select[aria-label="Category"]').element as HTMLSelectElement).value).toBe('')
  })

  it('Apply fills the form — and files nothing until the person presses File', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: SUGGESTION, originalFilename: 'parcels.csv' }))
    mockedFile.mockResolvedValue(drop({ suggested: SUGGESTION }, { status: 'needs-review' }))
    const w = await mountAt('/library/abc-uuid')

    await w.get('[data-testid="apply-suggestion"]').trigger('click')
    expect(mockedFile).not.toHaveBeenCalled()
    expect((w.get('input[aria-label="Title"]').element as HTMLInputElement).value).toBe('County parcel export, Shelby County')
    expect((w.get('select[aria-label="Category"]').element as HTMLSelectElement).value).toBe('places')
    expect((w.get('input[aria-label="Tags"]').element as HTMLInputElement).value).toBe('parcels, tennessee')
    expect((w.get('textarea[aria-label="Description"]').element as HTMLTextAreaElement).value).toContain('One row per parcel')

    // The user edits before filing, which is the whole point of Apply.
    await w.get('input[aria-label="Title"]').setValue('Shelby County parcels (2026 export)')
    await w.get('form.filing-form').trigger('submit')
    await flushPromises()
    expect(mockedFile).toHaveBeenCalledWith('abc-uuid', expect.objectContaining({
      title: 'Shelby County parcels (2026 export)',
      category: 'places',
      tags: ['parcels', 'tennessee'],
    }))
  })

  it('says quietly when the assistant could not suggest anything', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: { error: 'unavailable', at: '2026-09-05T00:00:00.000Z' } }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.find('[data-testid="suggestion-panel"]').exists()).toBe(false)
    expect(w.get('[data-testid="suggestion-unavailable"]').text()).toContain('could not suggest')
  })

  it('shows no panel at all when nothing was proposed', async () => {
    mockedEntry.mockResolvedValue(drop())
    const w = await mountAt('/library/abc-uuid')
    expect(w.find('[data-testid="suggestion-panel"]').exists()).toBe(false)
    expect(w.find('[data-testid="suggestion-unavailable"]').exists()).toBe(false)
  })
})

/**
 * P5-59 on the entry page: the panel is here, and "Register as a data source"
 * fills the filing form in with everything marked so nothing looks typed.
 */
describe('the ingest panel on an entry (P5-59)', () => {
  const mockedProposal = vi.mocked(fetchSourceProposal)
  const mockedDrop = vi.mocked(createLinkEntry)

  const INSPECTION = {
    kind: 'arcgis-layer',
    confidence: 'high',
    url: 'https://services.example/rest/services/NPL/FeatureServer/0',
    finalUrl: 'https://services.example/rest/services/NPL/FeatureServer/0',
    title: 'NPL sites',
    summary: 'ArcGIS point layer · 12 fields · Georgia extent',
    checkedAt: '2026-09-06T00:00:00.000Z',
  }

  const link = (meta: Record<string, unknown> = {}) =>
    entry({
      slug: 'dropped',
      kind: 'incoming',
      status: 'needs-cataloging',
      title: 'services.example/…/FeatureServer/0',
      category: '',
      tags: [],
      files: [{ key: 'library/incoming/dropped/meta.json', size: 10 }],
      meta: { url: 'https://services.example/rest/services/NPL/FeatureServer/0', ...meta },
    })

  beforeEach(() => {
    mockedProposal.mockReset()
    mockedDrop.mockReset()
  })

  it('appears for a dropped link and shows what the link turned out to be', async () => {
    mockedEntry.mockResolvedValue(link({ inspection: INSPECTION }))
    const w = await mountAt('/library/dropped')
    expect(w.find('[data-testid="ingest-panel"]').exists()).toBe(true)
    expect(w.get('[data-testid="inspection-summary"]').text()).toContain('ArcGIS point layer')
  })

  it('does not appear on a cleaned dataset, which is past this question', async () => {
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="ingest-panel"]').exists()).toBe(false)
  })

  it('never dumps the inspection or the plan as raw JSON in the meta list', async () => {
    mockedEntry.mockResolvedValue(link({ inspection: INSPECTION, ingest: { plan: 'index', decidedBy: 'nick', decidedAt: 'T' } }))
    const w = await mountAt('/library/dropped')
    const text = w.text()
    expect(text).not.toContain('"checkedAt"')
    expect(text).not.toContain('"decidedBy"')
  })

  it('fills the source form from a proposal and marks every inferred value', async () => {
    mockedEntry.mockResolvedValue(link({ inspection: INSPECTION }))
    mockedProposal.mockResolvedValue({
      inspection: INSPECTION,
      summary: INSPECTION.summary,
      proposal: {
        title: 'EPA Superfund sites',
        category: 'environment',
        tags: ['contamination'],
        description: 'Point locations of Superfund sites.',
        source: {
          provider: 'services.example',
          program: 'NPL sites',
          geography: 'point',
          coverage: 'Georgia',
          access: [{ type: 'arcgis', url: INSPECTION.finalUrl, auth: 'none' }],
          fields: [{ name: 'SITE_NAME' }],
          placeQuery: { by: ['point', 'county'], fipsField: 'STCOFIPS' },
        },
        inferred: ['provider', 'program', 'geography', 'coverage', 'access', 'placeQuery.by'],
      },
      suggestedPlan: { plan: 'fetch-on-demand', why: 'queryable' },
    } as never)

    const w = await mountAt('/library/dropped')
    await w.get('[data-testid="register-source"]').trigger('click')
    await flushPromises()

    // The form is open and filled in.
    expect(w.find('[data-testid="source-form"]').exists()).toBe(true)
    expect((w.get('[data-testid="source-form-provider"]').element as HTMLInputElement).value).toBe('services.example')
    expect((w.get('[data-testid="source-form-access-url"]').element as HTMLInputElement).value).toBe(INSPECTION.finalUrl)

    // Every value the machine worked out carries a chip.
    expect(w.get('[data-testid="inferred-provider"]').text()).toBe('inferred')
    expect(w.find('[data-testid="inferred-geography"]').exists()).toBe(true)
    expect(w.find('[data-testid="inferred-accessUrl"]').exists()).toBe(true)
    // A field the proposal did not fill in is not chipped.
    expect(w.find('[data-testid="inferred-topics"]').exists()).toBe(false)

    // Editing a field means a person said it, so its chip goes.
    await w.get('[data-testid="source-form-provider"]').setValue('US EPA')
    expect(w.find('[data-testid="inferred-provider"]').exists()).toBe(false)
  })

  it('saving keeps the columns and the place query the form never showed', async () => {
    mockedEntry.mockResolvedValue(link({ inspection: INSPECTION }))
    mockedProposal.mockResolvedValue({
      inspection: INSPECTION,
      summary: INSPECTION.summary,
      proposal: {
        source: {
          provider: 'services.example',
          access: [{ type: 'arcgis', url: INSPECTION.finalUrl, auth: 'none', notes: 'inferred from the service' }],
          fields: [{ name: 'SITE_NAME' }, { name: 'STCOFIPS' }],
          placeQuery: { by: ['point', 'county'], fipsField: 'STCOFIPS' },
        },
        inferred: ['provider', 'access'],
      },
      suggestedPlan: null,
    } as never)
    vi.mocked(fileCatalogEntry).mockResolvedValue(link({ inspection: INSPECTION }))

    const w = await mountAt('/library/dropped')
    await w.get('[data-testid="register-source"]').trigger('click')
    await flushPromises()
    await w.get('form.filing-form').trigger('submit')
    await flushPromises()

    const sent = vi.mocked(fileCatalogEntry).mock.calls[0][1] as { source?: Record<string, unknown> }
    expect(sent.source).toMatchObject({
      provider: 'services.example',
      fields: [{ name: 'SITE_NAME' }, { name: 'STCOFIPS' }],
      placeQuery: { by: ['point', 'county'], fipsField: 'STCOFIPS' },
    })
    // The access method keeps what the probe worked out about it.
    expect((sent.source!.access as Record<string, unknown>[])[0]).toMatchObject({
      type: 'arcgis',
      url: INSPECTION.finalUrl,
      notes: 'inferred from the service',
    })
  })

  it('"Drop this link" on a portal download makes a new entry and goes there', async () => {
    mockedEntry.mockResolvedValue(
      link({
        inspection: {
          ...INSPECTION,
          kind: 'portal',
          links: [{ url: 'https://data.cdc.gov/api/v3/views/x/export.csv', label: 'CSV', kind: 'file' }],
        },
      }),
    )
    mockedDrop.mockResolvedValue({ slug: 'new-one', status: 'needs-cataloging', title: 'CSV' } as never)

    const w = await mountAt('/library/dropped')
    await w.get('[data-testid="drop-portal-link"]').trigger('click')
    await flushPromises()
    expect(mockedDrop).toHaveBeenCalledWith({ url: 'https://data.cdc.gov/api/v3/views/x/export.csv' })
    expect(router.currentRoute.value.path).toBe('/library/new-one')
  })
})

describe('the entry hub on a phone (P5-60)', () => {
  it('puts the tab bar in a scroll strip instead of wrapping it onto two rows', async () => {
    const w = await mountAt('/library/organizations')
    // jsdom computes no layout: `.strip` is what the phone rules hang off, and
    // the tabs are the one control on this page that cannot afford to wrap.
    expect(w.get('[data-testid="entry-tabs"]').classes()).toContain('strip')
  })
})

/**
 * P5-67: a source page is something to read. The fifteen-field form is the
 * filer's tool, so it waits behind an Edit button — the same affordance a wiki
 * page uses — and everything the assistant might be asked waits with it.
 */
describe('a source page reads first (P5-67)', () => {
  const mockedProposalCall = vi.mocked(fetchSourceProposal)

  beforeEach(() => {
    mockedFile.mockReset()
    mockedProposalCall.mockReset()
  })

  it('opens closed, with the whole source still readable and Edit beside the title', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')

    expect(w.find('form.filing-form').exists()).toBe(false)
    expect(w.find('[data-testid="source-form"]').exists()).toBe(false)
    // Nothing a reader came for is behind the button.
    expect(w.get('[data-testid="tab-overview"]').text()).toContain('Every site on or proposed for the NPL.')
    expect(w.find('[data-testid="source-access"]').exists()).toBe(true)
    expect(w.find('[data-testid="source-fields"]').exists()).toBe(true)
    expect(w.find('[data-testid="fetch-for-place"]').exists()).toBe(true)

    // Not admin-gated: nobody is logged in as an admin in this test.
    await w.get('[data-testid="edit-source"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.edit).toBe('1')
    expect(w.get('form.filing-form h2').text()).toBe('Edit this source')
    expect(w.find('[data-testid="edit-source"]').exists()).toBe(false)
  })

  it('lands open on ?edit=1 — where a dropped link that became a source arrives', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl?edit=1')
    expect(w.find('form.filing-form').exists()).toBe(true)
    expect((w.get('[data-testid="source-form-provider"]').element as HTMLInputElement).value).toBe('US EPA')
  })

  it('Cancel shuts it again and takes ?edit with it', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl?edit=1&place=g13121')
    await w.get('[data-testid="cancel-source-edit"]').trigger('click')
    await flushPromises()
    expect(w.find('form.filing-form').exists()).toBe(false)
    expect(w.find('[data-testid="edit-source"]').exists()).toBe(true)
    // Only `edit` goes: the rest of the link a reader followed still stands.
    expect(router.currentRoute.value.query).toEqual({ place: 'g13121' })
  })

  it('asks the assistant nothing while the form is closed', async () => {
    mockedEntry.mockResolvedValue(sourceEntry({}, { url: 'https://www.epa.gov/superfund/sites', suggested: SUGGESTION }))
    const w = await mountAt('/library/epa-npl')
    expect(w.find('[data-testid="suggestion-panel"]').exists()).toBe(false)
    expect(w.find('[data-testid="ingest-panel"]').exists()).toBe(false)
    expect(mockedProposalCall).not.toHaveBeenCalled()

    await w.get('[data-testid="edit-source"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="suggestion-panel"]').exists()).toBe(true)
    expect(w.find('[data-testid="ingest-panel"]').exists()).toBe(true)
    // Still nothing asked: a suggestion is read off the entry, not fetched.
    expect(mockedProposalCall).not.toHaveBeenCalled()
  })

  it('an incoming entry keeps its form open, and has no Edit button to press', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: SUGGESTION, originalFilename: 'parcels.csv' }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('form.filing-form h2').text()).toBe('File this entry')
    expect(w.find('[data-testid="suggestion-panel"]').exists()).toBe(true)
    expect(w.find('[data-testid="edit-source"]').exists()).toBe(false)
    expect(w.find('[data-testid="cancel-source-edit"]').exists()).toBe(false)
  })

  it('reads description → How to get it → Key fields → Fetch for a place → the publisher', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')
    const text = w.get('[data-testid="tab-overview"]').text()
    const at = (needle: string) => {
      const i = text.indexOf(needle)
      expect(i, needle).toBeGreaterThan(-1)
      return i
    }
    expect(at('Every site on or proposed for the NPL.')).toBeLessThan(at('How to get it'))
    expect(at('How to get it')).toBeLessThan(at('Key fields'))
    expect(at('Key fields')).toBeLessThan(at('Fetch for a place'))
    expect(at('Fetch for a place')).toBeLessThan(at('Publisher'))
    // P5-65: "Source" is the entry kind, so the provenance line says Publisher.
    expect(w.get('[data-testid="source-publisher"]').text()).toBe('Publisher US EPA · Superfund / CERCLIS')
  })

  it('filing an incoming link AS a source leaves the form — and its answer — up', async () => {
    mockedEntry.mockResolvedValue(
      entry({ slug: 'abc-uuid', kind: 'incoming', title: 'epa.gov', status: 'needs-cataloging', category: '', tags: [], meta: { mentionedBy: [] }, files: [] }),
    )
    mockedFile.mockResolvedValue(sourceEntry({ slug: 'abc-uuid' }))
    const w = await mountAt('/library/abc-uuid')

    await w.get('[data-testid="filing-is-source"]').setValue(true)
    await w.get('[data-testid="source-form-provider"]').setValue('US EPA')
    await w.get('form.filing-form').trigger('submit')
    await flushPromises()

    expect(w.get('.filing-note').text()).toContain('Filed as a data source')
    expect(router.currentRoute.value.query.edit).toBe('1')
  })
})

// --- P5-69: a saved view's entry page ---------------------------------------

describe('LibraryEntryView — saved views open (P5-69)', () => {
  function viewEntry(meta: Record<string, unknown>, slug = 'tn-target-counties'): CatalogEntry {
    return entry({
      slug,
      kind: 'view',
      title: 'TN target counties',
      category: 'views',
      tags: [],
      meta: { savedBy: 'maria', savedAt: '2026-09-03T12:00:00.000Z', mentionedBy: [], ...meta },
      files: [{ key: `library/views/${slug}.json`, size: 900 }],
      bytes: 900,
    })
  }

  it('says what a map view is and what it holds, and opens it in one press', async () => {
    mockedEntry.mockResolvedValue(
      viewEntry({
        type: 'map',
        description: 'Map view · counties near the Delta · 12 counties',
        layers: ['median_home_value', 'internal-organizations', 'superfund_sites'],
        resultCount: 12,
      }),
    )
    const w = await mountAt('/library/tn-target-counties')
    const block = w.get('[data-testid="view-block"]')
    expect(block.get('[data-testid="view-kind"]').text()).toContain('Saved map view')
    expect(block.get('[data-testid="view-kind"]').text()).toContain('saved by maria')
    // The kind line already said "Map view"; the holds line says the rest.
    expect(block.get('[data-testid="view-holds"]').text()).toBe('counties near the Delta · 12 counties')
    expect(block.get('[data-testid="view-layers"]').text()).toContain('Median Home Value')
    expect(block.get('[data-testid="view-layers"]').text()).toContain('internal-organizations')
    // P5-78: a contamination site layer is named, not keyed.
    expect(block.get('[data-testid="view-layers"]').text()).toContain('Superfund Sites')
    // The view block is the whole story: no raw meta list, no Data tab for a snapshot file.
    expect(w.find('.meta-list').exists()).toBe(false)
    expect(w.findAll('button').map(b => b.text()).some(t => /^Data\b/.test(t))).toBe(false)
    expect(block.get('[data-testid="view-open"]').attributes('href')).toBe('/views/tn-target-counties')
    expect(block.get('[data-testid="view-open"]').text()).toContain('Open this view')
    expect(block.get('[data-testid="view-embed"]').text()).toContain('view:tn-target-counties')
  })

  it('names a table view its table, and links to it', async () => {
    mockedEntry.mockResolvedValue(
      viewEntry(
        { type: 'table', dataset: 'organizations', description: 'Organizations · HQ State is “GA” · 13 rows', layers: [] },
        'georgia-orgs',
      ),
    )
    const w = await mountAt('/library/georgia-orgs')
    const block = w.get('[data-testid="view-block"]')
    expect(block.get('[data-testid="view-kind"]').text()).toContain('Saved table view')
    expect(block.get('[data-testid="view-holds"]').text()).toBe('Organizations · HQ State is “GA” · 13 rows')
    expect(block.get('[data-testid="view-dataset"] a').attributes('href')).toBe('/library/organizations')
    expect(block.get('[data-testid="view-open"]').attributes('href')).toBe('/views/georgia-orgs')
  })

  it('calls a saved comparison what it is', async () => {
    mockedEntry.mockResolvedValue(
      viewEntry({ type: 'compare', description: '3 counties × 2 layers', layers: [] }, 'delta-shortlist'),
    )
    const w = await mountAt('/library/delta-shortlist')
    expect(w.get('[data-testid="view-kind"]').text()).toContain('Saved comparison')
    expect(w.get('[data-testid="view-holds"]').text()).toBe('3 counties × 2 layers')
  })

  it('never offers Read for a view — its one file is the snapshot itself', async () => {
    mockedEntry.mockResolvedValue(viewEntry({ type: 'map', description: 'Map view', layers: [] }))
    const w = await mountAt('/library/tn-target-counties')
    expect(w.find('[data-testid="read-entry"]').exists()).toBe(false)
    expect(w.find('[data-testid="read-quick"]').exists()).toBe(false)
  })

  it('shows no view block for an ordinary entry', async () => {
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="view-block"]').exists()).toBe(false)
  })
})

// --- P5-70: documents open on the document -----------------------------------

describe('LibraryEntryView — documents open on the document (P5-70)', () => {
  function doc(files: { key: string; size: number }[], overrides: Partial<CatalogEntry> = {}): CatalogEntry {
    return entry({
      slug: 'plan',
      kind: 'document',
      title: 'Five year plan',
      meta: { description: 'The plan.', mentionedBy: [] },
      files,
      bytes: files.reduce((n, f) => n + f.size, 0),
      ...overrides,
    })
  }

  it('offers Read in the header and first in Quick actions, on the primary file', async () => {
    mockedEntry.mockResolvedValue(
      doc([
        { key: 'library/documents/plan/meta.json', size: 10 },
        { key: 'library/documents/plan/notes.txt', size: 20 },
        { key: 'library/documents/plan/Five_Year_Plan.pdf', size: 500 },
      ]),
    )
    const w = await mountAt('/library/plan')
    expect(w.get('[data-testid="read-entry"]').text()).toBe('Read')
    // First action in the row, ahead of Files.
    expect(w.findAll('.files-actions > *')[0].attributes('data-testid')).toBe('read-quick')

    await w.get('[data-testid="read-entry"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ tab: 'files', view: 'Five_Year_Plan.pdf' })
    expect(w.get('[data-testid="doc-viewer-stub"]').text()).toContain('Five_Year_Plan.pdf')
    // P5-71: the checklist ticks because the viewer actually opened.
    expect(mockedFirstRun).toHaveBeenCalledWith('read')
  })

  it('offers no Read when nothing in the entry can be shown', async () => {
    mockedEntry.mockResolvedValue(
      doc([
        { key: 'library/documents/plan/meta.json', size: 10 },
        { key: 'library/documents/plan/rows.xlsx', size: 20 },
      ]),
    )
    const w = await mountAt('/library/plan')
    expect(w.find('[data-testid="read-entry"]').exists()).toBe(false)
    expect(w.find('[data-testid="read-quick"]').exists()).toBe(false)
  })

  it('previews the first 600 characters of the extraction, with a way through to the rest', async () => {
    mockedText.mockResolvedValue({ pages: 4, text: 'A'.repeat(900) })
    mockedEntry.mockResolvedValue(doc([{ key: 'library/documents/plan/Five_Year_Plan.pdf', size: 500 }]))
    const w = await mountAt('/library/plan')
    expect(mockedText).toHaveBeenCalledWith('plan', 'Five_Year_Plan.pdf')
    const preview = w.get('[data-testid="doc-preview"]')
    expect(preview.get('.preview-text').text()).toBe(`${'A'.repeat(600)}…`)

    await preview.get('[data-testid="read-whole"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ tab: 'files', view: 'Five_Year_Plan.pdf' })
  })

  it('shows the description alone when there is no extraction', async () => {
    mockedEntry.mockResolvedValue(doc([{ key: 'library/documents/plan/scan.pdf', size: 500 }]))
    const w = await mountAt('/library/plan')
    expect(w.find('[data-testid="doc-preview"]').exists()).toBe(false)
    expect(w.get('[data-testid="tab-overview"]').text()).toContain('The plan.')
  })

  it('does not ask for an extraction of a dataset — a CSV is not a document', async () => {
    const w = await mountAt('/library/organizations')
    expect(mockedText).not.toHaveBeenCalled()
    expect(w.find('[data-testid="doc-preview"]').exists()).toBe(false)
  })

  it('hides manifests from the Files list, the counts and the total', async () => {
    mockedEntry.mockResolvedValue(
      doc([
        { key: 'library/documents/plan/meta.json', size: 10 },
        { key: 'library/documents/plan/plan.manifest.json', size: 5 },
        { key: 'library/documents/plan/Five_Year_Plan.pdf', size: 500 },
      ]),
    )
    const w = await mountAt('/library/plan?tab=files')
    const names = w.findAll('.file-name').map(n => n.text())
    expect(names).toEqual(['Five_Year_Plan.pdf'])
    expect(w.get('.total').text()).toBe('Total: 500 B')
    expect(w.get('[role="tab"][data-tab="files"]').text()).toContain('1')
    await router.push('/library/plan')
    await flushPromises()
    expect(w.get('.files-actions').text()).toContain('Files (1)')
  })

  it('ignores a ?view= that names a manifest', async () => {
    mockedEntry.mockResolvedValue(
      doc([
        { key: 'library/documents/plan/meta.json', size: 10 },
        { key: 'library/documents/plan/Five_Year_Plan.pdf', size: 500 },
      ]),
    )
    const w = await mountAt('/library/plan?tab=files&view=meta.json')
    expect(w.find('[data-testid="doc-viewer-stub"]').exists()).toBe(false)
  })
})

// --- P5-73: vocabulary -------------------------------------------------------

describe('LibraryEntryView — vocabulary (P5-73)', () => {
  it('says nothing in the library is called that, rather than "no catalog entry"', async () => {
    mockedEntry.mockResolvedValue(null as unknown as CatalogEntry)
    const w = await mountAt('/library/ghost')
    expect(w.get('.state-note').text()).toBe('Nothing in the library is called “ghost”.')
  })

  it('keeps the CLI fetch sentence for admins, and tells everyone else what they can do', async () => {
    const link = entry({
      slug: 'abc',
      kind: 'incoming',
      status: 'needs-cataloging',
      meta: { url: 'https://example.org/parcels', mentionedBy: [] },
      files: [{ key: 'library/incoming/abc/meta.json', size: 1 }],
    })
    mockedEntry.mockResolvedValue(link)
    const admin = await mountAt('/library/abc')
    expect(admin.get('[data-testid="entry-link-block"]').text()).toContain('npm run library -- fetch abc')

    roleRef.value = { username: 'maria', role: 'internal' }
    const member = await mountAt('/library/abc')
    const text = member.get('[data-testid="entry-link-block"]').text()
    expect(text).not.toContain('npm run library')
    expect(text).toContain('download it and add the file to this entry')
  })
})

// --- P5-82 / P5-83 -----------------------------------------------------------

describe('the readiness line (P5-82)', () => {
  it('says what the entry is ready as, whether a report runs, and the reasons', async () => {
    mockedEntry.mockResolvedValue(
      drop(
        { inspection: { kind: 'page', checkedAt: '2026-09-08T00:00:00.000Z', page: { insecure: true } } },
        { readiness: { as: 'collection', placeReport: 'never', notes: ['text extracted from 3 of 30 files', 'served over http'] } },
      ),
    )
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('[data-testid="readiness"]').text()).toBe(
      'Ready as: a document collection · Place report: never · text extracted from 3 of 30 files · served over http',
    )
  })

  it('says nothing for a row with no verdict, or for a kind the question is not about', async () => {
    mockedEntry.mockResolvedValue(entry())
    expect((await mountAt('/library/organizations')).find('[data-testid="readiness"]').exists()).toBe(false)
    // A saved view carries a verdict like every row; it is not shown one.
    mockedEntry.mockResolvedValue(
      entry({ slug: 'v', kind: 'view', category: 'views', meta: { mentionedBy: [] }, files: [], readiness: { as: 'document', placeReport: 'never', notes: [] } }),
    )
    expect((await mountAt('/library/v')).find('[data-testid="readiness"]').exists()).toBe(false)
  })
})

describe('read, but not summarised (P5-83)', () => {
  beforeEach(() => {
    mockedRefetch.mockReset()
  })

  const readNoPass = (over: Record<string, unknown> = {}) =>
    drop({
      fetch: { status: 'fetched', at: '2026-09-07T00:00:00.000Z', name: 'index.html' },
      inspection: { kind: 'page', checkedAt: '2026-09-08T00:00:00.000Z' },
      suggested: { error: 'unavailable', at: '2026-09-08T00:00:00.000Z', reason: 'refused' },
      ...over,
    })

  it('tells an admin what was not done and why, and a member only that it was unavailable', async () => {
    mockedEntry.mockResolvedValue(readNoPass())
    const admin = await mountAt('/library/abc-uuid')
    const line = admin.get('[data-testid="model-pass"]').text()
    expect(line).toContain('No model pass — the model refused the key')
    expect(line).toContain(`Read on ${new Date('2026-09-08T00:00:00.000Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.`)

    roleRef.value = { username: 'maria', role: 'internal' }
    const member = await mountAt('/library/abc-uuid')
    expect(member.get('[data-testid="model-pass"]').text()).toContain('No model pass — the model was unavailable.')
    expect(member.get('[data-testid="model-pass"]').text()).not.toContain('billing')
  })

  it('says it for a page that was read with no suggestion written at all', async () => {
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'fetched', at: '2026-09-07T00:00:00.000Z', name: 'index.html' } }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.get('[data-testid="model-pass"]').text()).toContain('No model pass — the model was unavailable.')
  })

  it('Look again re-runs the pass and re-reads the entry', async () => {
    mockedEntry.mockResolvedValue(readNoPass())
    const w = await mountAt('/library/abc-uuid')
    mockedRefetch.mockResolvedValue('queued')
    mockedEntry.mockResolvedValue(readNoPass({ fetch: { status: 'queued', at: '2026-09-09T00:00:00.000Z' } }))
    await w.get('[data-testid="look-again"]').trigger('click')
    await flushPromises()
    expect(mockedRefetch).toHaveBeenCalledWith('abc-uuid')
    expect(w.get('[data-testid="look-again-note"]').text()).toContain('Looking again')
    // A pass already on its way is not something to ask for twice.
    expect(w.find('[data-testid="look-again"]').exists()).toBe(false)
  })

  it('keeps quiet when the pass produced a suggestion, and when nothing was read', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: { title: 'Parcels', summary: 'A table.', at: 'T', model: 'stub' } }))
    expect((await mountAt('/library/abc-uuid')).find('[data-testid="model-pass"]').exists()).toBe(false)
    mockedEntry.mockResolvedValue(drop())
    expect((await mountAt('/library/abc-uuid')).find('[data-testid="model-pass"]').exists()).toBe(false)
  })
})

describe('a title the assistant proposed (P6-8)', () => {
  it('is shown greyed with a "suggested" badge while nobody has accepted it', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: SUGGESTION }))
    const w = await mountAt('/library/abc-uuid')
    const line = w.get('[data-testid="suggested-title-line"]')
    expect(line.text()).toContain('County parcel export, Shelby County')
    expect(w.get('[data-testid="suggested-badge"]').text()).toBe('suggested')
    // The entry's own name is untouched: the proposal is not its title yet.
    expect(w.get('h1').text()).toBe('example.org/parcels.csv')
  })

  it('goes once the proposal has been accepted', async () => {
    // "Accepted" has one meaning: the entry's title IS the proposal.
    mockedEntry.mockResolvedValue(drop({ suggested: SUGGESTION }, { title: SUGGESTION.title }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.find('[data-testid="suggested-title-line"]').exists()).toBe(false)
  })

  it('is absent when the pass proposed no title at all', async () => {
    mockedEntry.mockResolvedValue(drop({ suggested: { error: 'unavailable', at: '2026-09-05T00:00:00.000Z' } }))
    const w = await mountAt('/library/abc-uuid')
    expect(w.find('[data-testid="suggested-title-line"]').exists()).toBe(false)
  })
})

describe('looking again at a dropped FILE (P6-8)', () => {
  /** A bulk-dropped document: no url to re-fetch, and a pass that produced
   *  nothing. Before P6-8 there was no way back from here at all. */
  function upload(meta: Record<string, unknown> = {}): CatalogEntry {
    return entry({
      slug: 'file-uuid',
      kind: 'incoming',
      title: 'land loss 2024',
      category: '',
      status: 'needs-review',
      tags: [],
      meta: { originalFilename: 'land loss 2024.pdf', suggested: { error: 'unavailable', at: '2026-09-23T00:00:00.000Z' }, ...meta },
      files: [{ key: 'library/incoming/file-uuid/land-loss-2024.pdf', size: 900 }, { key: 'library/incoming/file-uuid/meta.json', size: 10 }],
    })
  }

  beforeEach(() => {
    mockedAnnotate.mockReset()
    mockedRefetch.mockReset()
  })

  it('re-reads it in place rather than asking for a fetch there is none of', async () => {
    mockedEntry.mockResolvedValue(upload())
    mockedAnnotate.mockResolvedValue(undefined)
    const w = await mountAt('/library/file-uuid')
    expect(w.get('[data-testid="model-pass"]').text()).toContain('No model pass')

    await w.get('[data-testid="look-again"]').trigger('click')
    await flushPromises()
    expect(mockedAnnotate).toHaveBeenCalledWith('file-uuid')
    expect(mockedRefetch).not.toHaveBeenCalled()
    expect(w.get('[data-testid="look-again-note"]').text()).toContain('Looking again')
  })

  it('leaves a dropped LINK on the fetch path it has always used', async () => {
    mockedEntry.mockResolvedValue(drop({ fetch: { status: 'fetched', at: '2026-09-05T00:00:00.000Z' } }))
    mockedRefetch.mockResolvedValue('queued')
    const w = await mountAt('/library/abc-uuid')
    await w.get('[data-testid="look-again"]').trigger('click')
    await flushPromises()
    expect(mockedRefetch).toHaveBeenCalledWith('abc-uuid')
    expect(mockedAnnotate).not.toHaveBeenCalled()
  })
})

describe('tag chips go somewhere that answers (P6-21)', () => {
  it('searches for the tag instead of a retired filter nothing reads', async () => {
    mockedEntry.mockResolvedValue(sourceEntry())
    const w = await mountAt('/library/epa-npl')
    const chip = w.findAll('a.tag').find(a => a.text() === 'environmental-risk')
    expect(chip, 'the entry should still show its tags').toBeTruthy()
    expect(chip!.attributes('href')).toBe('/search?q=environmental-risk')
    // The old target forwarded to /search and had `tag` dropped on the floor.
    expect(chip!.attributes('href')).not.toContain('tag=')
  })
})

/**
 * P6-24: an entry page shows the organization and the shape its browser row
 * showed, from the same helpers.
 *
 * The repro: `/datasets` grouped **Organizations** under "Black Land Ownership
 * (BLO)" with the type chip "Sites and points", and the entry page had neither
 * — while printing "Publisher: final folder for Homesteading plan / (Nick,
 * 2026-09)", an internal filing note where the browser showed a publisher.
 *
 * So the assertion is parity between the two surfaces as RENDERED: the browser
 * is mounted for the same entry and its row's words are compared with the
 * page's. A shared helper asserted twice could be wrong in both places at
 * once; two mounted views cannot drift apart without this failing.
 */
describe('an entry speaks the browser’s vocabulary (P6-24)', () => {
  const PROSE = 'final folder for Homesteading plan / (Nick, 2026-09)'

  const blo = (over: Partial<CatalogEntry> = {}) =>
    entry({
      organization: 'blo',
      organizationLabel: 'Black Land Ownership (BLO)',
      shape: 'points',
      shapeLabel: 'Sites and points',
      meta: { description: 'Who we know.', source: PROSE, mentionedBy: [] },
      ...over,
    })

  /** The row `/datasets` draws for one entry — the thing the reader clicked. */
  async function browserRow(e: CatalogEntry) {
    mockedCatalog.mockResolvedValue([e])
    const browseRouter = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
    })
    await browseRouter.replace('/datasets')
    await browseRouter.isReady()
    const w = mount(DatasetsView, { global: { plugins: [browseRouter] } })
    await flushPromises()
    // The public map layers are rows here too, so pick ours by its title.
    const row = w.findAll('[data-testid="dataset-row"]').find(r => r.get('.row-title').text() === e.title)
    expect(row, `${e.title} should have a row in the datasets browser`).toBeTruthy()
    return row!
  }

  it('shows the canonical publisher and type the browser row showed', async () => {
    const e = blo()
    const row = await browserRow(e)
    mockedEntry.mockResolvedValue(e)
    const page = await mountAt('/library/organizations')

    expect(page.get('[data-testid="entry-organization"]').text()).toBe(row.get('[data-testid="row-organization"]').text())
    expect(page.get('[data-testid="entry-type"]').text()).toBe(row.get('[data-testid="row-type"]').text())
    // Spelled out, so two blanks cannot agree their way to a pass.
    expect(page.get('[data-testid="entry-organization"]').text()).toBe('Black Land Ownership (BLO)')
    expect(page.get('[data-testid="entry-type"]').text()).toBe('Sites and points')
  })

  it('shows an unknown publisher as the words somebody wrote, the way the browser does', async () => {
    const e = blo({
      slug: 'memphis-gardens',
      title: 'Community gardens',
      organization: 'Memphis Horticulture Society',
      organizationLabel: 'Memphis Horticulture Society',
    })
    const row = await browserRow(e)
    mockedEntry.mockResolvedValue(e)
    const page = await mountAt('/library/memphis-gardens')

    expect(page.get('[data-testid="entry-organization"]').text()).toBe('Memphis Horticulture Society')
    expect(page.get('[data-testid="entry-organization"]').text()).toBe(row.get('[data-testid="row-organization"]').text())
  })

  it('stops printing the raw ids in the leftover-meta block', async () => {
    mockedEntry.mockResolvedValue(
      blo({ meta: { description: 'Who we know.', mentionedBy: [], organization: 'blo', shape: 'points', rowCount: 412 } }),
    )
    const w = await mountAt('/library/organizations')
    const extra = w.findAll('.tab-panel .meta-list dt').map(dt => dt.text())
    // The words are in the meta row now, so the ids below are noise.
    expect(extra).not.toContain('organization')
    expect(extra).not.toContain('shape')
    // Anything nobody has given a first-class home still shows.
    expect(extra).toContain('rowCount')
  })

  it('keeps the source prose as provenance, and stops calling it the publisher', async () => {
    mockedEntry.mockResolvedValue(blo())
    const w = await mountAt('/library/organizations')
    const line = w.get('[data-testid="entry-provenance"]')
    expect(line.text()).toContain(PROSE)
    // The one word it must not use about a filing note.
    expect(line.text()).not.toContain('Publisher')
    expect(w.get('[data-testid="entry-organization"]').text()).toBe('Black Land Ownership (BLO)')
  })

  it('says nothing where nothing is known — no blank chip, no empty publisher', async () => {
    mockedEntry.mockResolvedValue(entry({ meta: { description: 'Who we know.', mentionedBy: [] } }))
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="entry-organization"]').exists()).toBe(false)
    expect(w.find('[data-testid="entry-type"]').exists()).toBe(false)
    expect(w.find('[data-testid="entry-provenance"]').exists()).toBe(false)
  })

  it('still shows a source’s own provider line, which is a real publisher name', async () => {
    mockedEntry.mockResolvedValue(sourceEntry({ organization: 'epa', organizationLabel: 'US EPA', shape: 'areas', shapeLabel: 'Areas and boundaries' }))
    const w = await mountAt('/library/epa-npl')
    expect(w.get('[data-testid="entry-organization"]').text()).toBe('US EPA')
    expect(w.get('[data-testid="entry-type"]').text()).toBe('Areas and boundaries')
    // P5-65's line is untouched: `source.provider` IS the publisher's name,
    // and it carries the programme the canonical label does not.
    expect(w.get('[data-testid="source-publisher"]').text()).toBe('Publisher US EPA · Superfund / CERCLIS')
  })
})

/**
 * P6-31: a URL somebody pasted must not widen the page.
 *
 * Measured in Chromium at 390×844 on `/library/epa-echo-facilities`:
 * `documentElement.scrollWidth` 788px, from a 120-character ArcGIS query
 * string in `p.access-notes` — a flex item inside `.access-row`, whose
 * min-content width became the whole string. jsdom computes no layout, so the
 * rule is the behaviour here and the measurement is recorded on the ticket.
 */
describe('a pasted URL does not widen the page (P6-31)', () => {
  const css = readStyles('src/views/LibraryEntryView.vue')
  /** Every field on this page that prints text a URL can be pasted into. */
  const WRAPPED = [
    '.link-url',
    '.link-note',
    '.access-notes',
    '.source-line',
    '.source-replication',
    '.entry-source',
    '.entry-description',
    '.tab-lede',
    '.preview-text',
    '.suggestion-list dd',
    // Lineage and extra-meta rows; wrapped since P5-13.
    '.meta-list dd',
  ]

  it.each(WRAPPED)('breaks an unbreakable string in %s', selector => {
    const rule = ruleFor(css, selector)
    expect(rule, selector).toContain('overflow-wrap: anywhere')
  })

  it('does not leave the wrapping to word-break alone', () => {
    // `word-break: break-word` is the fallback for engines older than
    // `anywhere`; on its own it does not shrink min-content, which is what a
    // flex item's automatic minimum is computed from — the actual bug.
    expect(ruleFor(css, '.link-url')).not.toContain('break-all')
  })

  it('covers every URL-bearing element a URL-heavy entry actually renders', async () => {
    const URL_IN_NOTES =
      '?geometry=<lon>,<lat>&geometryType=esriGeometryPoint&distance=3&units=esriSRUnit_StatuteMile&inSR=4326&outFields=*&f=json'
    const LONG =
      'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/ECHO_All_Media_Facilities/FeatureServer/0'
    mockedEntry.mockResolvedValue(
      sourceEntry({}, {
        source: {
          provider: 'US EPA',
          access: [{ type: 'arcgis', url: LONG, docs: LONG, auth: 'none', notes: `Buffer query at a lat/lon: ${URL_IN_NOTES}` }],
          notes: `See ${LONG}`,
          license: LONG,
        },
        lineage: { from: LONG },
      }),
    )
    const w = await mountAt('/library/epa-echo-facilities')

    // Every element that PRINTS one of the long strings itself — a direct
    // text node, not one inherited from a child — has to be covered by a rule
    // above. That is what stops one sibling field being fixed and its
    // neighbour left broken.
    const printers = [...w.element.querySelectorAll('*')].filter(el =>
      [...el.childNodes].some(
        node => node.nodeType === 3 && [LONG, URL_IN_NOTES].some(needle => (node.textContent || '').includes(needle)),
      ),
    )
    expect(
      printers.map(el => [el.tagName.toLowerCase(), ...el.classList].join('.')).sort(),
    ).toEqual(['a.link-url', 'dd', 'p.access-notes', 'p.source-line', 'p.source-line'])
    for (const el of printers) {
      const classes = [...el.classList]
      const covered = WRAPPED.some(sel => {
        const own = sel.split(' ').pop()!.replace('.', '')
        if (classes.includes(own)) return true
        // A descendant rule (`.meta-list dd`): the tag under its ancestor.
        return sel.includes(' ') && el.tagName.toLowerCase() === own && !!el.closest(sel.split(' ')[0])
      })
      expect(covered, `${el.tagName}.${classes.join('.')} prints a URL with no wrapping rule`).toBe(true)
    }
  })
})

/**
 * P6-34: a surface that carries a claim outward has to be able to say a value
 * is unverified. The entry page is where a claim leaves the library — somebody
 * reading it, quoting it in a story or handing it to a funder — so an
 * unverified value must never be indistinguishable from a curated one.
 */
describe('saying what a model wrote (P6-34)', () => {
  const guessed = (over: Partial<CatalogEntry> = {}) =>
    entry({
      category: 'land',
      meta: {
        description: 'Who we know.',
        mentionedBy: [],
        provenance: {
          topic: {
            mechanism: 'model',
            at: '2026-10-05T09:00:00.000Z',
            value: 'land',
            evidence: 'Black landowners held fifteen million acres in 1910.',
            via: 'category',
          },
        },
      },
      organization: 'blo',
      organizationLabel: 'Black Land Ownership (BLO)',
      coverage: { scope: 'national', states: [], label: 'National' },
      shape: 'points',
      shapeLabel: 'Sites and points',
      ...over,
    })

  it('badges an unverified value in the meta row, beside the chip it is about', async () => {
    mockedEntry.mockResolvedValue(guessed())
    const w = await mountAt('/library/organizations')
    expect(w.get('[data-testid="entry-unverified"]').text()).toBe('Topic unverified')
    // And offers the decision, with the sentence the model read it from.
    expect(w.get('[data-testid="needs-a-look-mechanism"]').text()).toBe('read by the model')
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toContain('fifteen million acres')
    for (const action of ['keep', 'edit', 'clear']) {
      expect(w.find(`[data-testid="needs-a-look-${action}"]`).exists()).toBe(true)
    }
  })

  it('says nothing of the kind about a curated or a derived value', async () => {
    // A hand-written category, a derived coverage and a derived shape, plus a
    // hand-written answers line (P7-7) and hand-written dates (P7-10):
    // nothing here rests on a machine's reading, so there is nothing to badge
    // and nothing to decide.
    mockedEntry.mockResolvedValue(
      guessed({
        meta: { description: 'Who we know.', mentionedBy: [], whatItAnswers: 'Answers: who we know, and where.' },
        dates: { covers: '2026', published: '2026-01' },
      }),
    )
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="entry-unverified"]').exists()).toBe(false)
    expect(w.find('[data-testid="needs-a-look"]').exists()).toBe(false)
  })

  it('names the gap on an entry nothing could fill, where the queue used to lead nowhere', async () => {
    // P6-19's "no coverage" row sent people to an entry page that never
    // mentioned coverage at all. Now the page says so and offers the fix.
    mockedEntry.mockResolvedValue(entry({ category: 'network', meta: { description: 'Who we know.', mentionedBy: [] } }))
    const w = await mountAt('/library/organizations')
    const fields = w.findAll('[data-testid="needs-a-look-field"]').map(p => p.attributes('data-field'))
    expect(fields).toContain('coverage')
    expect(fields).toContain('organization')
  })
})

/**
 * P7-1. A working set arrives here from search and ⌘K, because `entryHref`
 * sends every kind it does not know about to `/library/<slug>`. Small on
 * purpose: the set's own two interfaces are P7-2's, and what this page owes a
 * reader who arrived from a search result is what the set contains and the two
 * things they can do with it.
 */
describe('a working set, read at its own URL (P7-1)', () => {
  const SET = entry({
    slug: 'memphis-redevelopment',
    kind: 'working-set',
    title: 'Memphis redevelopment',
    category: 'working-sets',
    status: 'published',
    meta: {
      title: 'Memphis redevelopment',
      description: 'Working set · Which parcels can be redeveloped · 3 datasets · 1 layer',
      purpose: 'Which parcels can be redeveloped',
      datasets: ['memphis-sites', 'epa-superfund-npl', 'epa-brownfields'],
      layers: ['combined_scores_v2'],
      sites: 'memphis-sites',
      savedBy: 'maria',
      savedAt: '2026-10-05T10:00:00.000Z',
      fromView: 'memphis-exploring',
      mentionedBy: [],
    },
    files: [{ key: 'library/working-sets/memphis-redevelopment/meta.json', size: 400 }],
  })

  it('says what the set holds, and who made it', async () => {
    mockedEntry.mockResolvedValue(SET)
    const w = await mountAt('/library/memphis-redevelopment')
    expect(w.get('[data-testid="working-set-kind"]').text()).toContain('Working set')
    expect(w.get('[data-testid="working-set-kind"]').text()).toContain('made by maria')
    expect(w.get('[data-testid="working-set-purpose"]').text()).toBe('Which parcels can be redeveloped')
    expect(w.get('[data-testid="working-set-holds"]').text()).toBe('3 datasets · 1 layer')
  })

  it('names the anchor and the view it was promoted from', async () => {
    mockedEntry.mockResolvedValue(SET)
    const w = await mountAt('/library/memphis-redevelopment')
    expect(w.get('[data-testid="working-set-sites"] a').attributes('href')).toBe('/library/memphis-sites')
    expect(w.get('[data-testid="working-set-from-view"] a').attributes('href')).toBe('/views/memphis-exploring')
  })

  it('offers the scoped place report and the set’s own datasets', async () => {
    mockedEntry.mockResolvedValue(SET)
    const w = await mountAt('/library/memphis-redevelopment')
    expect(w.get('[data-testid="working-set-place"]').attributes('href')).toBe('/place?set=memphis-redevelopment')
    expect(w.get('[data-testid="working-set-datasets"]').attributes('href')).toBe(
      '/datasets?workingSet=memphis-redevelopment',
    )
  })

  /** The block says what the set holds; `datasets ["a","b"]` underneath would
   *  be the same thing said badly — the rule a saved view already follows. */
  it('does not also dump the set’s own fields as raw meta rows', async () => {
    mockedEntry.mockResolvedValue(SET)
    const w = await mountAt('/library/memphis-redevelopment')
    const text = w.get('[data-testid="tab-overview"]').text()
    expect(text).not.toContain('savedById')
    expect(text).not.toContain('["memphis-sites"')
  })

  it('sends "back" to Analysis, where the sets and their views are', async () => {
    mockedEntry.mockResolvedValue(SET)
    const w = await mountAt('/library/memphis-redevelopment')
    expect(w.get('.back-link').text()).toContain('Analysis')
  })

  it('says nothing of the kind about any other entry', async () => {
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="working-set-block"]').exists()).toBe(false)
  })
})

/**
 * P7-7: the capability line on the page as well as in `search_library`.
 *
 * On the page for the reason P6-34 found with coverage: the queue sent people
 * to an entry page that never mentioned the gap, so there was nothing to act
 * on where they landed.
 */
describe('what this data answers (P7-7)', () => {
  const ANSWER = 'Answers: which parcels sit within five miles of a transmission line.'

  it('shows the line above the description, with its own lead-in', async () => {
    mockedEntry.mockResolvedValue(entry({ meta: { description: 'Parcel boundaries.', mentionedBy: [], whatItAnswers: ANSWER } }))
    const w = await mountAt('/library/organizations')
    const line = w.get('[data-testid="entry-answers"]')
    expect(line.text()).toBe('Answers: which parcels sit within five miles of a transmission line.')
    // A stored line that already begins "Answers:" is not said twice.
    expect(line.text().match(/Answers:/g)).toHaveLength(1)
  })

  it('does not say it twice as a raw manifest row', async () => {
    mockedEntry.mockResolvedValue(entry({ meta: { description: 'Parcel boundaries.', mentionedBy: [], whatItAnswers: ANSWER } }))
    const w = await mountAt('/library/organizations')
    // P6-24's defect, one block lower: the words are upstairs, so the key
    // down here would be the same sentence again.
    const keys = w.findAll('.meta-list dt').map(dt => dt.text())
    expect(keys).not.toContain('whatItAnswers')
    // Found live while verifying this ticket: the provenance record was
    // dumped here as raw JSON on every remediated entry, saying in a wall of
    // braces what `NeedsALookNote` says in words four lines above.
    expect(keys).not.toContain('provenance')
  })

  it('badges it when a model wrote it and nobody has looked', async () => {
    mockedEntry.mockResolvedValue(
      entry({
        category: 'land',
        organization: 'blo',
        coverage: { scope: 'national', states: [], label: 'National' },
        shape: 'points',
        meta: {
          description: 'Parcel boundaries.',
          mentionedBy: [],
          whatItAnswers: ANSWER,
          provenance: {
            whatItAnswers: { mechanism: 'model', at: 'T', value: ANSWER, evidence: 'Each parcel record includes the distance to the nearest corridor.', via: 'field' },
          },
        },
      }),
    )
    const w = await mountAt('/library/organizations')
    // An unverified value must never be indistinguishable from a curated one.
    expect(w.get('[data-testid="entry-unverified"]').text()).toBe('Answers unverified')
    expect(w.get('[data-testid="needs-a-look-value"]').text()).toBe(ANSWER)
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toContain('nearest corridor')
  })

  it('says nothing where there is no line', async () => {
    mockedEntry.mockResolvedValue(entry({ meta: { description: 'Parcel boundaries.', mentionedBy: [] } }))
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="entry-answers"]').exists()).toBe(false)
  })
})

/**
 * P7-10: the entry page says when the data is from — all three facts, named
 * separately, because a 2024 release of 2010 census tracts has all three and
 * they are years apart.
 */
describe('when the data is from (P7-10)', () => {
  it('names the period, the release and the pull as three different facts', async () => {
    mockedEntry.mockResolvedValue(
      entry({
        meta: { description: 'Parcel boundaries.', mentionedBy: [] },
        dates: { covers: '2019/2023', published: '2024-03', fetched: '2026-10-05' },
      }),
    )
    const w = await mountAt('/library/organizations')
    const line = w.get('[data-testid="entry-dates"]').text()
    expect(line).toContain('Data from 2019–2023')
    expect(line).toContain('Published March 2024')
    expect(line).toContain('Fetched Oct 5, 2026')
  })

  it('reads a snapshot as an as-of, which is the living-inventory case', async () => {
    mockedEntry.mockResolvedValue(
      entry({ meta: { description: 'Data centres.', mentionedBy: [] }, dates: { covers: '2026-10' } }),
    )
    const w = await mountAt('/library/organizations')
    expect(w.get('[data-testid="entry-dates"]').text()).toBe('As of October 2026')
  })

  it('says nothing where the entry says nothing — an untagged dataset is not a defect', async () => {
    mockedEntry.mockResolvedValue(entry({ meta: { description: 'Parcel boundaries.', mentionedBy: [] } }))
    const w = await mountAt('/library/organizations')
    expect(w.find('[data-testid="entry-dates"]').exists()).toBe(false)
  })

  it('never presents the updatedAt as a date about the data', async () => {
    // The acceptance criterion, as a test: `updatedAt` says when the bytes
    // last moved, so re-pushing a 2019 file would make it read as 2026 data.
    // The dates line shows the FETCH record and nothing else.
    mockedEntry.mockResolvedValue(
      entry({
        meta: { description: 'Parcel boundaries.', mentionedBy: [] },
        updatedAt: '2026-10-06T12:00:00.000Z',
        dates: { fetched: '2024-01-02' },
      }),
    )
    const w = await mountAt('/library/organizations')
    expect(w.get('[data-testid="entry-dates"]').text()).toBe('Fetched Jan 2, 2024')
    expect(w.get('[data-testid="entry-dates"]').text()).not.toContain('2026')
  })

  it('does not say it again as a raw manifest row', async () => {
    mockedEntry.mockResolvedValue(
      entry({
        meta: { description: 'Parcel boundaries.', mentionedBy: [], dates: { covers: '2019/2023' } },
        dates: { covers: '2019/2023' },
      }),
    )
    const w = await mountAt('/library/organizations')
    const keys = w.findAll('.meta-list dt').map(dt => dt.text())
    expect(keys).not.toContain('dates')
  })

  it('badges an unverified date beside the chips it is about, with its evidence', async () => {
    mockedEntry.mockResolvedValue(
      entry({
        meta: {
          description: 'Parcel boundaries.',
          mentionedBy: [],
          provenance: {
            published: {
              mechanism: 'model',
              at: '2026-10-06T00:00:00.000Z',
              value: '2024-03',
              evidence: 'Last updated March 2024.',
            },
          },
        },
        dates: { published: '2024-03' },
      }),
    )
    const w = await mountAt('/library/organizations')
    expect(w.get('[data-testid="entry-unverified"]').text()).toBe('Published unverified')
    expect(w.get('[data-testid="needs-a-look-value"]').text()).toBe('2024-03')
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toContain('Last updated March 2024.')
  })
})
