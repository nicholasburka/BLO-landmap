import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

/**
 * /datasets (P6-3): every dataset-shaped thing in one list.
 *
 * Only the catalog request is faked. The registry, the taxonomy, the
 * organization vocabulary and all the grouping are the real code — which is
 * the point: the page's job is to merge four kinds of thing into one set of
 * rows and put them under the right headings.
 */
vi.mock('@/lib/libraryCatalog', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/libraryCatalog')>()),
  fetchCatalog: vi.fn(),
}))

// P7-1: the working sets are a second request beside the catalog. Faked for
// the same reason — the page's job is the arithmetic over them, not the fetch.
vi.mock('@/lib/workingSets', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/workingSets')>()),
  fetchWorkingSets: vi.fn(),
}))

vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'maria', role: 'internal' } } }),
  registerLogoutHook: vi.fn(),
}))

import { fetchCatalog, type CatalogEntry, type Coverage } from '@/lib/libraryCatalog'
import { fetchWorkingSets, NO_WORKING_SET_LABEL, type WorkingSetSummary } from '@/lib/workingSets'
import { publicLayers } from '@/lib/publicLayers'
import DatasetsView from '../DatasetsView.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const mockedCatalog = vi.mocked(fetchCatalog)
const mockedSets = vi.mocked(fetchWorkingSets)

const GROUP_KEY = 'blo:datasets-group'

const e = (over: Partial<CatalogEntry>): CatalogEntry => ({
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

const tele = (slug: string, title: string, coverage?: Coverage): CatalogEntry =>
  e({
    slug,
    title,
    category: 'land',
    organization: 'tele',
    organizationLabel: 'TELE (Yale / UMass)',
    shape: 'records',
    shapeLabel: 'Records without a location',
    ...(coverage ? { coverage } : {}),
  })

const CATALOG: CatalogEntry[] = [
  // Held, and drawn on the map: one row with two badges, never two rows.
  e({
    slug: 'epa-sites',
    title: 'EPA sites in the delta',
    category: 'environment',
    organization: 'epa',
    organizationLabel: 'US EPA',
    shape: 'points',
    shapeLabel: 'Sites and points',
    coverage: { scope: 'national', states: [], label: 'National' },
    meta: { layer: { geometry: 'point' }, description: 'Every site the EPA lists.' },
    readiness: { as: 'dataset', placeReport: 'runs', notes: [] },
  }),
  // Indexed, not held.
  e({
    slug: 'epa-superfund-npl',
    kind: 'source',
    title: 'Superfund NPL sites',
    category: 'environment',
    organization: 'epa',
    organizationLabel: 'US EPA',
    shape: 'areas',
    shapeLabel: 'Areas and boundaries',
    coverage: { scope: 'national', states: [], label: 'National' },
    meta: { source: { provider: 'US EPA' } },
    readiness: { as: 'source', placeReport: 'runs', notes: ['not copied here'] },
  }),
  // P6-19: three one-state tables, one table covering three states at once,
  // two nationwide rows, and three nobody could place.
  tele('tele-georgia', 'TELE landowner profiles — Georgia', { scope: 'state', states: ['GA'], label: 'Georgia' }),
  tele('tele-alabama', 'TELE landowner profiles — Alabama', { scope: 'state', states: ['AL'], label: 'Alabama' }),
  tele('tele-mississippi', 'TELE landowner profiles — Mississippi', { scope: 'state', states: ['MS'], label: 'Mississippi' }),
  e({
    slug: 'memphis-gardens',
    title: 'Community gardens',
    category: 'land',
    organization: 'Memphis Horticulture Society',
    organizationLabel: 'Memphis Horticulture Society',
    shape: 'points',
    shapeLabel: 'Sites and points',
    // The real reading of the real Memphis directory: a regional table whose
    // rows cross three state lines.
    coverage: { scope: 'multi-state', states: ['GA', 'MS', 'TN'], label: 'Georgia, Mississippi and Tennessee' },
  }),
  e({
    slug: 'nced-easements',
    title: 'Conservation easements',
    category: 'land',
    organization: 'nced',
    organizationLabel: 'NCED partnership',
    shape: 'areas',
    shapeLabel: 'Areas and boundaries',
    coverage: { scope: 'national', states: [], label: 'National' },
  }),
  // Nobody has said who published these two.
  e({ slug: 'land-notes-a', title: 'Parcel notes A', category: 'land', shape: 'records', shapeLabel: 'Records without a location' }),
  e({ slug: 'land-notes-b', title: 'Parcel notes B', category: 'land', shape: 'records', shapeLabel: 'Records without a location' }),
  // No topic either.
  e({ slug: 'mystery-table', title: 'A table nobody filed', shape: 'records', shapeLabel: 'Records without a location' }),
  // Neither of these is a dataset, and neither may appear.
  e({ slug: 'home', kind: 'wiki', title: 'Start here' }),
  e({ slug: 'an-idea', kind: 'note', title: 'An idea', category: 'ideas' }),
  // Archived rows are hidden from every list, so they are hidden here too.
  e({ slug: 'old-table', title: 'Superseded table', status: 'archived', organization: 'epa', organizationLabel: 'US EPA' }),
]

let router: Router
async function mountAt(url = '/datasets') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.replace(url)
  await router.isReady()
  const w = mount(DatasetsView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

type Wrapper = Awaited<ReturnType<typeof mountAt>>

const groupLines = (w: Wrapper) =>
  w.findAll('[data-testid="browse-group"]').map(g => `${g.get('[data-testid="group-label"]').text()} ${g.get('[data-testid="group-count"]').text()}`)

const rowTitles = (w: Wrapper) => w.findAll('[data-testid="dataset-row"]').map(r => r.get('.row-title').text())

/**
 * P7-1 fixtures. The Memphis set is the workbook's shape in miniature: an
 * anchoring sites table, a source that answers, a source whose last fetch
 * failed, and one member the library no longer has.
 */
const workingSet = (over: Partial<WorkingSetSummary>): WorkingSetSummary => ({
  slug: 'memphis-redevelopment',
  name: 'Memphis redevelopment',
  purpose: 'What bears on siting',
  description: '',
  datasets: [],
  layers: [],
  sites: null,
  derivedCount: 0,
  savedBy: 'maria',
  savedAt: '2026-10-05T10:00:00Z',
  updatedAt: '2026-10-05T10:00:00Z',
  views: [],
  ...over,
})

const SETS: WorkingSetSummary[] = [
  workingSet({ datasets: ['epa-sites', 'epa-superfund-npl', 'gone-away'], sites: 'epa-sites' }),
  workingSet({
    slug: 'transmission-corridors',
    name: 'Transmission corridors',
    purpose: '',
    datasets: ['epa-superfund-npl'],
  }),
]

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockedCatalog.mockResolvedValue(CATALOG)
  mockedSets.mockResolvedValue(SETS)
})

describe('grouping (P6-3)', () => {
  it('groups by organization by default, by count then name, with the unfiled group last', async () => {
    const w = await mountAt('/datasets?topic=land')
    expect(groupLines(w)).toEqual([
      'TELE (Yale / UMass) · 3 datasets',
      'Memphis Horticulture Society · 1 dataset',
      'NCED partnership · 1 dataset',
      // Two of them, and still last: "nobody said" is housekeeping, not a publisher.
      'No organization · 2 datasets',
    ])
  })

  it('heads an unknown publisher’s group with the words somebody wrote', async () => {
    const w = await mountAt('/datasets?topic=land')
    expect(groupLines(w)).toContain('Memphis Horticulture Society · 1 dataset')
  })

  it('regroups by topic', async () => {
    const w = await mountAt('/datasets?readiness=held&group=topic')
    expect(groupLines(w)).toEqual(['Land · 7 datasets', 'Environment · 1 dataset', 'No topic · 1 dataset'])
  })

  it('regroups by type', async () => {
    const w = await mountAt('/datasets?readiness=held&group=type')
    expect(groupLines(w)).toEqual([
      'Records without a location · 6 datasets',
      'Sites and points · 2 datasets',
      'Areas and boundaries · 1 dataset',
    ])
  })

  it('pressing a grouping changes the list and puts it in the URL', async () => {
    const w = await mountAt('/datasets?readiness=held')
    await w.get('[data-group-by="type"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.group).toBe('type')
    expect(groupLines(w)[0]).toBe('Records without a location · 6 datasets')
  })
})

describe('remembering the grouping (P6-3)', () => {
  it('remembers a grouping that was pressed, and opens that way next time', async () => {
    const first = await mountAt('/datasets')
    await first.get('[data-group-by="topic"]').trigger('click')
    await flushPromises()
    expect(localStorage.getItem(GROUP_KEY)).toBe('topic')

    const again = await mountAt('/datasets?readiness=held')
    expect(groupLines(again)[0]).toBe('Land · 7 datasets')
  })

  it('lets a link win over what this browser remembers, without changing it', async () => {
    localStorage.setItem(GROUP_KEY, 'type')
    const w = await mountAt('/datasets?readiness=held&group=topic')
    expect(groupLines(w)[0]).toBe('Land · 7 datasets')
    expect(localStorage.getItem(GROUP_KEY)).toBe('type')
  })

  it('does not fall over when storage refuses to answer', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const w = await mountAt('/datasets?topic=land')
    expect(groupLines(w)[0]).toBe('TELE (Yale / UMass) · 3 datasets')
    vi.restoreAllMocks()
  })
})

describe('the filters, each as a URL key (P6-3)', () => {
  it('q matches every word, in any field', async () => {
    const w = await mountAt('/datasets?q=georgia+landowner')
    expect(rowTitles(w)).toEqual(['TELE landowner profiles — Georgia'])
  })

  it('readiness=held shows what we hold', async () => {
    const w = await mountAt('/datasets?readiness=held')
    expect(rowTitles(w)).toContain('EPA sites in the delta')
    expect(rowTitles(w)).not.toContain('Superfund NPL sites')
  })

  it('readiness=indexed shows what we only point at', async () => {
    const w = await mountAt('/datasets?readiness=indexed')
    expect(rowTitles(w)).toEqual(['Superfund NPL sites'])
  })

  it('readiness=layers shows the registry AND a held dataset that is drawn', async () => {
    const w = await mountAt('/datasets?readiness=layers')
    const titles = rowTitles(w)
    expect(titles).toContain('EPA sites in the delta')
    for (const layer of publicLayers()) expect(titles).toContain(layer.name)
    expect(titles).not.toContain('Superfund NPL sites')
  })

  it('organization narrows to one publisher, and `none` to the ones with no publisher', async () => {
    const one = await mountAt('/datasets?organization=tele')
    expect(rowTitles(one)).toHaveLength(3)
    const missing = await mountAt('/datasets?organization=none')
    expect(rowTitles(missing).sort()).toEqual(['A table nobody filed', 'Parcel notes A', 'Parcel notes B'])
  })

  it('topic and type narrow the list', async () => {
    const byTopic = await mountAt('/datasets?topic=environment&readiness=held')
    expect(rowTitles(byTopic)).toEqual(['EPA sites in the delta'])
    const byType = await mountAt('/datasets?type=areas')
    expect(rowTitles(byType).sort()).toEqual(['Conservation easements', 'Superfund NPL sites'])
  })

  it('writes a pressed chip into the URL, so the narrowed list is a link', async () => {
    const w = await mountAt('/datasets')
    await w.get('[data-testid="organization-chips"] [data-chip="tele"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.organization).toBe('tele')
    expect(rowTitles(w)).toHaveLength(3)
  })
})

describe('the rows (P6-3)', () => {
  it('shows a held dataset once, badged held AND map layer, with its type, topic and verdict', async () => {
    const w = await mountAt('/datasets?q=delta')
    const rows = w.findAll('[data-testid="dataset-row"]')
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.get('[data-testid="row-badge"]').text()).toBe('Held')
    expect(row.get('[data-testid="row-layer-badge"]').text()).toBe('Map layer')
    expect(row.get('[data-testid="row-type"]').text()).toBe('Sites and points')
    expect(row.get('[data-testid="row-topic"]').text()).toBe('Environment')
    expect(row.get('[data-testid="row-organization"]').text()).toBe('US EPA')
    expect(row.get('[data-testid="row-line"]').text()).toBe('Ready as: a table we hold · Place report: runs')
    expect(row.attributes('href')).toBe('/library/epa-sites')
  })

  it('badges an indexed source as a Source and says it is not copied here', async () => {
    const w = await mountAt('/datasets?readiness=indexed')
    const row = w.get('[data-testid="dataset-row"]')
    expect(row.get('[data-testid="row-badge"]').text()).toBe('Source')
    expect(row.find('[data-testid="row-layer-badge"]').exists()).toBe(false)
    expect(row.get('[data-testid="row-line"]').text()).toContain('not copied here')
  })

  it('lists a public map layer as a row of its own, with its publisher and its about page', async () => {
    const w = await mountAt('/datasets?q=contamination')
    const rows = w.findAll('[data-testid="dataset-row"]')
    expect(rows.length).toBeGreaterThan(0)
    const layer = rows.find(r => r.get('[data-testid="row-badge"]').text() === 'Map layer')!
    expect(layer.get('[data-testid="row-type"]').text()).toBe('Statistics by county or tract')
    expect(layer.get('[data-testid="row-organization"]').text()).toBe('US EPA')
    expect(layer.attributes('href')).toBe('/layers/contamination')
  })

  it('leaves out anything that is not a dataset, and anything archived', async () => {
    const w = await mountAt('/datasets')
    const titles = rowTitles(w)
    expect(titles).not.toContain('Start here')
    expect(titles).not.toContain('An idea')
    expect(titles).not.toContain('Superseded table')
  })
})

describe('the page’s states (P6-3)', () => {
  it('shows a skeleton while the catalog is on its way', async () => {
    let release = (_: CatalogEntry[]) => {}
    mockedCatalog.mockReturnValue(new Promise(resolve => (release = resolve)) as never)
    const w = await mountAt('/datasets')
    expect(w.find('[data-testid="datasets-loading"]').exists()).toBe(true)
    release(CATALOG)
    await flushPromises()
    expect(w.find('[data-testid="datasets-loading"]').exists()).toBe(false)
  })

  it('says so when a filter matches nothing, and offers to clear it', async () => {
    const w = await mountAt('/datasets?q=nothing-matches-this')
    expect(w.get('[data-testid="datasets-empty"]').text()).toContain('Nothing matches these filters')
    await w.get('[data-testid="datasets-empty"] .link-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBeUndefined()
  })

  it('says so when the catalog will not load', async () => {
    mockedCatalog.mockRejectedValue(new Error('nope'))
    const w = await mountAt('/datasets')
    expect(w.get('[data-testid="datasets-error"]').text()).toContain('did not load')
  })
})

describe('phone layout (P5-60 guards)', () => {
  const css = readStyles('src/views/DatasetsView.vue')
  const phone = mediaBlock(css, 640)

  it('keeps the page from setting its own width off a long title', () => {
    expect(ruleFor(css, '.datasets-view')).toContain('min-width: 0')
    expect(ruleFor(phone, '.datasets-view')).toContain('max-width: 100%')
  })

  it('gives the search box a thumb-sized target that does not zoom iOS', () => {
    expect(ruleFor(phone, '.search-input')).toContain('min-height: 44px')
    expect(ruleFor(phone, '.search-input')).toContain('font-size: 16px')
  })
})

describe('one attention queue, opened from the landing (P6-5)', () => {
  it('answers the publisher queue with the datasets that name nobody the vocabulary knows', async () => {
    const w = await mountAt('/datasets?attention=no-organization')
    // Memphis Horticulture Society is a real publisher but not a vocabulary
    // id, so it is on the queue too — somebody has to add the alias, which is
    // exactly what the row is for. (Rows keep the page's own grouping order.)
    expect(rowTitles(w)).toEqual(['Community gardens', 'Parcel notes A', 'Parcel notes B', 'A table nobody filed'])
    expect(w.get('[data-testid="datasets-queue-note"]').text()).toContain('Datasets with no organization')
  })

  it('answers the topic queue with the datasets that say nothing about what they are', async () => {
    const w = await mountAt('/datasets?attention=uncategorised')
    expect(rowTitles(w)).toEqual(['A table nobody filed'])
  })

  it('never puts a registry layer on a queue — it has no manifest to be missing anything', async () => {
    const w = await mountAt('/datasets?attention=no-organization')
    expect(rowTitles(w).some(title => publicLayers().some(layer => layer.name === title))).toBe(false)
  })

  it('shows nothing, and names no queue, for a key nobody has heard of', async () => {
    const w = await mountAt('/datasets?attention=not-a-queue')
    expect(rowTitles(w)).toEqual([])
    expect(w.find('[data-testid="datasets-queue-note"]').exists()).toBe(false)
  })

  it('leaves the queue behind when the reader asks to see everything', async () => {
    const w = await mountAt('/datasets?attention=uncategorised')
    await w.get('[data-testid="datasets-queue-note"] button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.attention).toBeUndefined()
    expect(rowTitles(w).length).toBeGreaterThan(5)
  })

  it('shows no queue note at all on the plain page', async () => {
    const w = await mountAt('/datasets')
    expect(w.find('[data-testid="datasets-queue-note"]').exists()).toBe(false)
  })
})

/**
 * P6-33: one row in place of four. The count being distinct ENTRIES rather
 * than summed gaps is the case this browser shows most clearly — a dataset
 * with no publisher and no coverage was two rows of work and is one.
 */
describe('the needs-a-look queue (P6-33, P6-34)', () => {
  it('lists each entry once however many of its fields are blank', async () => {
    const rolled = await mountAt('/datasets?attention=needs-a-look')
    const titles = rowTitles(rolled)
    expect(new Set(titles).size).toBe(titles.length)
    const parts = new Set<string>()
    for (const key of ['uncategorised', 'no-organization', 'no-coverage', 'no-answers-line', 'no-summary', 'unverified']) {
      for (const title of rowTitles(await mountAt(`/datasets?attention=${key}`))) parts.add(title)
    }
    // P6-23's invariant: the list a row opens is exactly the set its count
    // came from.
    expect([...titles].sort()).toEqual([...parts].sort())
    expect(rolled.get('[data-testid="datasets-queue-note"]').text()).toContain('Needs a look')
  })

  it('names the fields on the row, so the collapse loses nothing', async () => {
    const w = await mountAt('/datasets?attention=needs-a-look')
    const lines = w.findAll('[data-testid="row-needs-a-look"]').map(p => p.text())
    // "A table nobody filed" is missing all six — one row, six fields named.
    expect(lines).toContain('no topic · no organization · no coverage · no answers line · no period covered · no published date')
    expect(w.findAll('[data-testid="needs-a-look-field"]').length).toBeGreaterThan(0)
  })

  it('never offers the actions on a public map layer, which has no manifest', async () => {
    const w = await mountAt('/datasets?attention=needs-a-look')
    expect(rowTitles(w).some(title => publicLayers().some(layer => layer.name === title))).toBe(false)
  })

  it('keeps the deciding off the plain browse page', async () => {
    const plain = await mountAt('/datasets')
    expect(plain.find('[data-testid="needs-a-look-field"]').exists()).toBe(false)
  })

  it('accounts for the rows that live in the other browser (P6-23)', async () => {
    // The landing links a queue to ONE browser, by majority, and the roll-up
    // mixes kinds — so the list has to say where the rest went rather than
    // quietly showing fewer rows than the panel counted.
    mockedCatalog.mockResolvedValue([
      e({ slug: 'landholders', kind: 'dataset', title: 'Landholders', status: 'published' }),
      e({ slug: 'memo', kind: 'document', title: 'A memo', status: 'published' }),
      e({ slug: 'note', kind: 'note', title: 'A note', status: 'open' }),
    ])
    const w = await mountAt('/datasets?attention=needs-a-look')
    expect(rowTitles(w)).toEqual(['Landholders'])
    const elsewhere = w.get('[data-testid="datasets-queue-elsewhere"]')
    expect(elsewhere.text()).toContain('2 more are in the docs browser')
    expect(elsewhere.attributes('href')).toBe('/docs?attention=needs-a-look')
  })

  it('says nothing about another browser on a queue that does not span one', async () => {
    // `no-coverage` asks only `dataset` and `source` (PUBLISHED_KINDS), and both
    // of those live here — so there is no elsewhere to point at. NOT
    // `uncategorised`, which asks documents, notes and incoming too
    // (TOPICABLE_KINDS) and therefore really does span the two browsers.
    const w = await mountAt('/datasets?attention=no-coverage')
    expect(w.find('[data-testid="datasets-queue-elsewhere"]').exists()).toBe(false)
  })
})

describe('publisher roll-up (P6-25)', () => {
  const usda = (slug: string, title: string, organization: string, organizationLabel: string): CatalogEntry =>
    e({ slug, title, category: 'land', organization, organizationLabel, shape: 'records', shapeLabel: 'Records without a location' })

  const SUB_UNITS: CatalogEntry[] = [
    usda('nass-a', 'Cropland layer', 'usda-nass', 'USDA · NASS'),
    usda('nass-b', 'Census of agriculture', 'usda-nass', 'USDA · NASS'),
    usda('nrcs-a', 'Soil survey', 'usda-nrcs', 'USDA · NRCS'),
    usda('fs-a', 'Heirs property research', 'usda-fs', 'USDA · Forest Service'),
  ]

  beforeEach(() => mockedCatalog.mockResolvedValue(SUB_UNITS))

  it('files every sub-unit under one USDA heading, counted as their sum', async () => {
    const w = await mountAt('/datasets?topic=land')
    expect(groupLines(w)).toEqual(['USDA · 4 datasets'])
  })

  it('still names the sub-unit on the row', async () => {
    const w = await mountAt('/datasets?topic=land')
    expect(w.findAll('[data-testid="row-organization"]').map(r => r.text())).toEqual([
      'USDA · NASS',
      'USDA · NASS',
      'USDA · NRCS',
      'USDA · Forest Service',
    ])
  })

  it('offers one USDA chip, and filtering by it keeps every sub-unit', async () => {
    const w = await mountAt('/datasets?topic=land')
    const chips = w.get('[data-testid="organization-chips"]').findAll('[data-chip]')
    expect(chips.map(c => c.attributes('data-chip'))).toEqual(['', 'usda'])
    expect(chips[1].text()).toBe('USDA 4')
    const filtered = await mountAt('/datasets?topic=land&organization=usda')
    expect(rowTitles(filtered)).toHaveLength(4)
  })

  it('leaves a publisher with no parent exactly where it was', async () => {
    mockedCatalog.mockResolvedValue([...SUB_UNITS, tele('tele-a', 'Landowner profiles')])
    const w = await mountAt('/datasets?topic=land')
    expect(groupLines(w)).toEqual(['USDA · 4 datasets', 'TELE (Yale / UMass) · 1 dataset'])
  })
})

describe('a chosen chip survives a combination that matches nothing (P6-22)', () => {
  it('keeps the publisher chip, at zero, when the query excludes every one of its rows', async () => {
    // The audit's repro: pick US EPA, then search for a word only a BLO row has.
    const w = await mountAt('/datasets?organization=epa&q=nobody')
    const chips = w.get('[data-testid="organization-chips"]').findAll('[data-chip]')
    const epa = chips.find(c => c.attributes('data-chip') === 'epa')
    expect(epa, 'the chip you pressed must still be there to un-press').toBeTruthy()
    expect(epa!.text()).toBe('US EPA 0')
    expect(epa!.attributes('aria-pressed')).toBe('true')
  })

  // The sibling counts are not a contradiction, they are the way out: "EPA 0,
  // BLO 3" reads as "nothing here, but three next door". That only works once
  // the 0 is visible — which is the whole of this fix.
  it('keeps the other publishers countable, so the empty state has an exit', async () => {
    const w = await mountAt('/datasets?organization=epa&q=nobody')
    expect(rowTitles(w)).toHaveLength(0)
    const chips = w.get('[data-testid="organization-chips"]').findAll('[data-chip]:not([data-chip=""])')
    expect(chips.find(c => c.attributes('data-chip') === 'epa')!.text()).toBe('US EPA 0')
    expect(chips.some(c => !c.text().endsWith(' 0')), 'at least one chip offers somewhere to go').toBe(true)
  })
})

/**
 * P6-19. The question the page could not answer: what do we hold for Georgia?
 *
 * The fixture is the real library's shape in miniature — nationwide rows, one
 * table per state, one table whose rows cross three state lines, and three
 * nobody could place — plus the fifteen public layers, every one of which is
 * a county value for the whole country.
 */
describe('coverage, as a chip row and a grouping (P6-19)', () => {
  const chips = (w: Wrapper) =>
    w
      .get('[data-testid="coverage-chips"]')
      .findAll('[data-chip]')
      .map(c => ({ value: c.attributes('data-chip'), text: c.text() }))

  it('offers National and the states actually present, count-ordered, with the gap last', async () => {
    const w = await mountAt()
    expect(chips(w)).toEqual([
      { value: '', text: 'Anywhere' },
      // 15 registry layers + the two EPA rows + the easements.
      { value: 'national', text: 'National 18' },
      // Georgia and Mississippi are each named by a one-state table AND by the
      // Memphis directory; Alabama and Tennessee by one row each.
      { value: 'GA', text: 'Georgia 2' },
      { value: 'MS', text: 'Mississippi 2' },
      { value: 'AL', text: 'Alabama 1' },
      { value: 'TN', text: 'Tennessee 1' },
      // Housekeeping, so pinned last however big it is.
      { value: 'none', text: 'No coverage 3' },
    ])
  })

  it('answers "what do we hold for Georgia?" — including a table that covers it among others', async () => {
    const w = await mountAt('/datasets?coverage=GA')
    expect(rowTitles(w).sort()).toEqual(['Community gardens', 'TELE landowner profiles — Georgia'])
  })

  it('does not put a nationwide dataset under any single state', async () => {
    const w = await mountAt('/datasets?coverage=GA')
    expect(rowTitles(w)).not.toContain('EPA sites in the delta')
    expect(rowTitles(w)).not.toContain('Conservation easements')
    // It is under National, where it belongs, with every registry layer.
    const national = await mountAt('/datasets?coverage=national')
    expect(rowTitles(national)).toContain('EPA sites in the delta')
    expect(rowTitles(national)).toHaveLength(18)
  })

  it('lists the ones nothing could place, rather than calling them national', async () => {
    const w = await mountAt('/datasets?coverage=none')
    expect(rowTitles(w).sort()).toEqual(['A table nobody filed', 'Parcel notes A', 'Parcel notes B'])
    // And the same set through the attention queue the landing counts.
    const queue = await mountAt('/datasets?attention=no-coverage')
    expect(rowTitles(queue).sort()).toEqual(['A table nobody filed', 'Parcel notes A', 'Parcel notes B'])
  })

  it('makes the list, the group counts and the facet counts agree under a state filter', async () => {
    const w = await mountAt('/datasets?coverage=GA&group=geography')
    // Two rows, two groups of one, and the chip says two.
    expect(rowTitles(w)).toHaveLength(2)
    expect(groupLines(w)).toEqual(['Georgia · 1 dataset', 'Several states · 1 dataset'])
    const ga = chips(w).find(c => c.value === 'GA')
    expect(ga!.text).toBe('Georgia 2')
  })

  it('groups by geography under one heading per row, naming the state when one names it', async () => {
    const w = await mountAt('/datasets?group=geography')
    expect(groupLines(w)).toEqual([
      'National · 18 datasets',
      // A row covering three states is headed once, not three times — a
      // heading has to total the list.
      'Alabama · 1 dataset',
      'Georgia · 1 dataset',
      'Mississippi · 1 dataset',
      'Several states · 1 dataset',
      'No coverage · 3 datasets',
    ])
  })

  it('offers Geography as the fourth grouping, and remembers it when pressed', async () => {
    const w = await mountAt()
    await w.get('[data-group-by="geography"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.group).toBe('geography')
    expect(localStorage.getItem(GROUP_KEY)).toBe('geography')
  })

  it('honours the `state=` spelling a link from the chat or MCP uses', async () => {
    const w = await mountAt('/datasets?state=GA')
    expect(rowTitles(w)).toHaveLength(2)
    // Reading a link does not rewrite it, exactly as every other filter here
    // behaves — but the page's own key is what a chip press writes.
    await w.get('[data-testid="coverage-chips"] [data-chip="AL"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.coverage).toBe('AL')
    expect(rowTitles(w)).toEqual(['TELE landowner profiles — Alabama'])
  })

  it('narrows by a scope word the chips do not offer, which is what MCP sends', async () => {
    const w = await mountAt('/datasets?coverage=multi-state')
    expect(rowTitles(w)).toEqual(['Community gardens'])
  })

  it('keeps the chosen state chip at zero when the combination matches nothing (P6-22)', async () => {
    const w = await mountAt('/datasets?coverage=AL&q=nobody')
    expect(rowTitles(w)).toHaveLength(0)
    const al = chips(w).find(c => c.value === 'AL')
    expect(al, 'the chip you pressed must still be there to un-press').toBeTruthy()
    expect(al!.text).toBe('Alabama 0')
  })

  it('is cleared by Clear filters, like every other chip', async () => {
    const w = await mountAt('/datasets?coverage=AL&q=nobody')
    expect(w.get('[data-testid="datasets-empty"]').text()).toContain('Nothing matches these filters')
    await w.get('[data-testid="datasets-empty"] .link-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.coverage).toBeUndefined()
    expect(rowTitles(w).length).toBeGreaterThan(2)
  })

  it('finds a state by typing its name, including through a multi-state table', async () => {
    const w = await mountAt('/datasets?q=tennessee')
    // Nothing in this title says Tennessee — the coverage reading does.
    expect(rowTitles(w)).toEqual(['Community gardens'])
  })
})

/**
 * P7-1. The question the page could not answer: *which datasets is this
 * project still missing?*
 *
 * A working set is "these datasets, together, for this purpose", so narrowing
 * to one turns this list into that project's sourcing checklist — and the
 * progress line counts the set's own member list, which is exactly what the
 * chip opened.
 */
describe('in a working set, as a chip row and a progress line (P7-1)', () => {
  const chips = (w: Wrapper) =>
    w
      .get('[data-testid="working-set-chips"]')
      .findAll('[data-chip]')
      .map(c => ({ value: c.attributes('data-chip'), text: c.text() }))

  it('offers a chip per set, plus the datasets no set names', async () => {
    const w = await mountAt('/datasets')
    expect(chips(w)).toEqual([
      { value: '', text: 'Every dataset' },
      // Counted by VALUE, so a dataset in two sets adds one to each.
      { value: 'memphis-redevelopment', text: 'Memphis redevelopment 2' },
      { value: 'transmission-corridors', text: 'Transmission corridors 1' },
      { value: 'none', text: `${NO_WORKING_SET_LABEL} 23` },
    ])
  })

  it('narrows to one set’s members', async () => {
    const w = await mountAt('/datasets?workingSet=memphis-redevelopment')
    expect(rowTitles(w)).toEqual(['EPA sites in the delta', 'Superfund NPL sites'])
  })

  it('narrows to the datasets no set names', async () => {
    const w = await mountAt('/datasets?workingSet=none')
    expect(rowTitles(w)).not.toContain('EPA sites in the delta')
    expect(rowTitles(w)).toContain('A table nobody filed')
  })

  it('says how far the set’s sourcing has got, counting what it NAMES', async () => {
    const w = await mountAt('/datasets?workingSet=memphis-redevelopment')
    const note = w.get('[data-testid="working-set-note"]')
    expect(note.text()).toContain('Memphis redevelopment')
    expect(note.text()).toContain('What bears on siting')
    // Three named: one held, one indexed, one the library no longer has. The
    // denominator stays 3 — P6-23's rule, and the honest number to act on.
    expect(w.get('[data-testid="working-set-progress"]').text()).toBe(
      '1 of 3 held · 1 indexed · 1 no longer in the library',
    )
  })

  it('offers a place report scoped to the set — the whole point of the object', async () => {
    const w = await mountAt('/datasets?workingSet=memphis-redevelopment')
    expect(w.get('[data-testid="working-set-place"]').attributes('href')).toBe('/place?set=memphis-redevelopment')
  })

  it('says nothing about a set when the page is not narrowed to one', async () => {
    const w = await mountAt('/datasets')
    expect(w.find('[data-testid="working-set-note"]').exists()).toBe(false)
  })

  it('keeps the chosen set chip at zero when the combination matches nothing (P6-22)', async () => {
    const w = await mountAt('/datasets?workingSet=memphis-redevelopment&q=nobody')
    expect(rowTitles(w)).toHaveLength(0)
    const chosen = chips(w).find(c => c.value === 'memphis-redevelopment')
    expect(chosen, 'the chip you pressed must still be there to un-press').toBeTruthy()
    expect(chosen!.text).toBe('Memphis redevelopment 0')
  })

  it('is cleared by Clear filters, like every other chip', async () => {
    const w = await mountAt('/datasets?workingSet=memphis-redevelopment&q=nobody')
    await w.get('[data-testid="datasets-empty"] .link-btn').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.workingSet).toBeUndefined()
  })

  /** A chip row offering nothing but "Every dataset" is a control that does
   *  nothing — and it is what every library looks like before the first set. */
  it('draws no chip row at all when there are no working sets', async () => {
    mockedSets.mockResolvedValue([])
    const w = await mountAt('/datasets')
    expect(w.find('[data-testid="working-set-chips"]').exists()).toBe(false)
    expect(rowTitles(w).length).toBeGreaterThan(5)
  })

  /** The catalog IS this page; the sets are one filter row on it. */
  it('still lists every dataset when the working sets could not be loaded', async () => {
    mockedSets.mockRejectedValue(new Error('bucket unhappy'))
    const w = await mountAt('/datasets')
    expect(w.find('[data-testid="datasets-error"]').exists()).toBe(false)
    expect(w.find('[data-testid="working-set-chips"]').exists()).toBe(false)
    expect(rowTitles(w).length).toBeGreaterThan(5)
  })
})
