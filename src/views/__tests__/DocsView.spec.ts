import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { ref } from 'vue'

/**
 * /docs (P6-4): pages, documents, notes and the to-file queue.
 *
 * Only the catalog request is faked; the taxonomy, the grouping and the
 * queue's visibility rule are the real code. The role is a controllable ref
 * so each case can be an admin or a member.
 */
vi.mock('@/lib/libraryCatalog', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/libraryCatalog')>()),
  fetchCatalog: vi.fn(),
}))

const roleRef = ref<{ username: string; role: 'admin' | 'internal' } | null>({ username: 'nick', role: 'admin' })
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: roleRef }),
  registerLogoutHook: vi.fn(),
}))

import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import DocsView from '../DocsView.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const mockedCatalog = vi.mocked(fetchCatalog)

const GROUP_KEY = 'blo:docs-group'

const e = (over: Partial<CatalogEntry>): CatalogEntry => ({
  slug: 'x',
  kind: 'document',
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
  e({ slug: 'five-year-plan', kind: 'document', title: 'The 5-5-5 plan', category: 'strategy', updatedAt: '2026-09-20T10:00:00Z', meta: { description: 'Five counties, five years.' } }),
  e({ slug: 'budget', kind: 'document', title: 'Budget notes', category: 'strategy', updatedAt: '2026-09-22T10:00:00Z' }),
  e({ slug: 'home', kind: 'wiki', title: 'Start here', category: 'strategy', updatedAt: '2026-09-21T10:00:00Z' }),
  e({ slug: 'tele-brief', kind: 'document', title: 'TELE landowner brief', category: 'research', tags: ['land'], updatedAt: '2026-09-18T10:00:00Z' }),
  e({ slug: 'heirs-property', kind: 'wiki', title: 'Heirs property', category: 'research', tags: ['land'], updatedAt: '2026-09-19T10:00:00Z' }),
  e({ slug: 'one-pager', kind: 'document', title: 'Outreach one-pager', category: 'outreach', updatedAt: '2026-09-17T10:00:00Z' }),
  e({ slug: 'idea-map', kind: 'note', title: 'An idea about the map', category: 'ideas', status: 'open', updatedAt: '2026-09-16T10:00:00Z' }),
  e({ slug: 'unfiled-doc', kind: 'document', title: 'A document nobody filed', updatedAt: '2026-09-15T10:00:00Z' }),
  // The queue: one uploaded by maria, one link dropped by nick. P6-5a folds
  // `uploadedBy` and `linkedBy` into one key on the list row, so both doors
  // name their owner the same way.
  e({ slug: 'drop-a', kind: 'incoming', title: 'census link', status: 'needs-cataloging', meta: { uploadedBy: 'maria' }, updatedAt: '2026-09-23T10:00:00Z' }),
  e({ slug: 'drop-b', kind: 'incoming', title: 'a PDF from the county', status: 'needs-cataloging', meta: { uploadedBy: 'nick' }, updatedAt: '2026-09-23T09:00:00Z' }),
  // A drop from before either field was written: admin-only, for good.
  e({ slug: 'drop-old', kind: 'incoming', title: 'an unsigned drop', status: 'needs-cataloging', updatedAt: '2026-09-23T08:00:00Z' }),
  // Neither of these belongs on a docs page.
  e({ slug: 'epa-sites', kind: 'dataset', title: 'EPA sites' }),
  e({ slug: 'a-view', kind: 'view', title: 'A saved view' }),
  e({ slug: 'old-brief', kind: 'document', title: 'Superseded brief', category: 'research', status: 'archived' }),
]

let router: Router
async function mountAt(url = '/docs') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.replace(url)
  await router.isReady()
  const w = mount(DocsView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

type Wrapper = Awaited<ReturnType<typeof mountAt>>

const groupLines = (w: Wrapper) =>
  w.findAll('[data-testid="browse-group"]').map(g => `${g.get('[data-testid="group-label"]').text()} ${g.get('[data-testid="group-count"]').text()}`)

const rowTitles = (w: Wrapper) => w.findAll('[data-testid="doc-row"]').map(r => r.get('.row-title').text())

const rowsInGroup = (w: Wrapper, label: string) =>
  w
    .findAll('[data-testid="browse-group"]')
    .find(g => g.get('[data-testid="group-label"]').text() === label)!
    .findAll('[data-testid="doc-row"]')
    .map(r => r.get('.row-title').text())

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  roleRef.value = { username: 'nick', role: 'admin' }
  mockedCatalog.mockResolvedValue(CATALOG)
})

describe('grouping (P6-4)', () => {
  it('groups by purpose by default, the queue first, the unfiled last', async () => {
    const w = await mountAt('/docs')
    expect(groupLines(w)).toEqual([
      'To file · 3 items',
      'Strategy · 3 items',
      'Research · 2 items',
      'Ideas · 1 item',
      'Outreach · 1 item',
      'No purpose · 1 item',
    ])
  })

  it('puts the most recently updated first inside a group', async () => {
    const w = await mountAt('/docs')
    expect(rowsInGroup(w, 'Strategy')).toEqual(['Budget notes', 'Start here', 'The 5-5-5 plan'])
  })

  it('regroups by topic', async () => {
    const w = await mountAt('/docs?group=topic')
    expect(groupLines(w)).toEqual(['To file · 3 items', 'Land · 2 items', 'No topic · 6 items'])
  })

  it('regroups by kind, in the plural', async () => {
    const w = await mountAt('/docs?group=kind')
    expect(groupLines(w)).toEqual(['To file · 3 items', 'Documents · 5 items', 'Pages · 2 items', 'Notes · 1 item'])
  })

  it('remembers a pressed grouping and lets a link override it', async () => {
    const first = await mountAt('/docs')
    await first.get('[data-group-by="kind"]').trigger('click')
    await flushPromises()
    expect(localStorage.getItem(GROUP_KEY)).toBe('kind')
    expect(router.currentRoute.value.query.group).toBe('kind')

    const remembered = await mountAt('/docs')
    expect(groupLines(remembered)[1]).toBe('Documents · 5 items')

    const linked = await mountAt('/docs?group=topic')
    expect(groupLines(linked)[1]).toBe('Land · 2 items')
    expect(localStorage.getItem(GROUP_KEY)).toBe('kind')
  })
})

describe('the to-file queue (P6-4)', () => {
  it('shows an admin the whole queue as its own group', async () => {
    const w = await mountAt('/docs')
    expect(rowsInGroup(w, 'To file')).toEqual(['census link', 'a PDF from the county', 'an unsigned drop'])
  })

  it('shows a member only what they dropped themselves', async () => {
    roleRef.value = { username: 'maria', role: 'internal' }
    const w = await mountAt('/docs')
    expect(rowsInGroup(w, 'To file')).toEqual(['census link'])
    expect(rowTitles(w)).not.toContain('a PDF from the county')
  })

  it('shows a member nothing when the drops name somebody else', async () => {
    roleRef.value = { username: 'sam', role: 'internal' }
    const w = await mountAt('/docs')
    expect(groupLines(w).some(line => line.startsWith('To file'))).toBe(false)
    expect(rowTitles(w)).not.toContain('census link')
  })

  it('keeps a hidden drop out of the counts too, not just out of the list', async () => {
    roleRef.value = { username: 'sam', role: 'internal' }
    const w = await mountAt('/docs?group=kind')
    expect(groupLines(w)).toEqual(['Documents · 5 items', 'Pages · 2 items', 'Notes · 1 item'])
  })

  it('shows the owner of a dropped LINK their row too (P6-5a)', async () => {
    // The two doors into the queue write different manifest fields; the list
    // row publishes one, so the rule does not care which was used.
    roleRef.value = { username: 'nick', role: 'internal' }
    const w = await mountAt('/docs')
    expect(rowsInGroup(w, 'To file')).toEqual(['a PDF from the county'])
  })

  it('keeps a drop with no owner on it admin-only (P6-5a)', async () => {
    roleRef.value = { username: 'maria', role: 'internal' }
    const w = await mountAt('/docs')
    expect(rowTitles(w)).not.toContain('an unsigned drop')
  })
})

describe('one attention queue, opened from the landing (P6-5)', () => {
  it('narrows to exactly the rows that queue counted, and says which queue', async () => {
    const w = await mountAt('/docs?attention=to-file')
    expect(rowTitles(w)).toEqual(['census link', 'a PDF from the county', 'an unsigned drop'])
    expect(w.get('[data-testid="docs-queue-note"]').text()).toContain('Waiting to be filed')
  })

  it('answers the topic queue with the entries that name no topic', async () => {
    const w = await mountAt('/docs?attention=uncategorised')
    // A PURPOSE is not a topic: a strategy document says what it is FOR, not
    // what it is ABOUT, so it is on this queue too. Pages are never on it —
    // a wiki page IS the knowledge base rather than a category of it.
    expect(rowTitles(w)).toEqual([
      'census link',
      'a PDF from the county',
      'an unsigned drop',
      'Budget notes',
      'The 5-5-5 plan',
      'An idea about the map',
      'Outreach one-pager',
      'A document nobody filed',
    ])
  })

  it('shows nothing, and names no queue, for a key nobody has heard of', async () => {
    const w = await mountAt('/docs?attention=not-a-queue')
    expect(rowTitles(w)).toEqual([])
    expect(w.find('[data-testid="docs-queue-note"]').exists()).toBe(false)
    expect(w.get('[data-testid="docs-empty"]').text()).toContain('Nothing matches these filters')
  })

  it('leaves the queue behind when the reader asks to see everything', async () => {
    const w = await mountAt('/docs?attention=to-file')
    await w.get('[data-testid="docs-queue-note"] button').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.attention).toBeUndefined()
    expect(rowTitles(w).length).toBeGreaterThan(4)
  })

  it('shows no queue note at all on the plain page', async () => {
    const w = await mountAt('/docs')
    expect(w.find('[data-testid="docs-queue-note"]').exists()).toBe(false)
  })
})

/**
 * P6-33: one row in place of four, which only works if the LIST says which
 * fields and which case. P6-34 adds the three things you can do about it.
 */
describe('the needs-a-look queue (P6-33, P6-34)', () => {
  it('opens the roll-up with every entry that is on any of the field queues, once', async () => {
    const rolled = await mountAt('/docs?attention=needs-a-look')
    const parts = new Set<string>()
    for (const key of ['uncategorised', 'no-organization', 'no-coverage', 'no-summary', 'unverified']) {
      for (const title of rowTitles(await mountAt(`/docs?attention=${key}`))) parts.add(title)
    }
    // P6-23's invariant, asked of the roll-up: the list a row opens is exactly
    // the set its count came from, and nobody is listed twice.
    expect([...rowTitles(rolled)].sort()).toEqual([...parts].sort())
    expect(new Set(rowTitles(rolled)).size).toBe(rowTitles(rolled).length)
    expect(rolled.get('[data-testid="docs-queue-note"]').text()).toContain('Needs a look')
  })

  it('says on every row which fields it is, and which case', async () => {
    const w = await mountAt('/docs?attention=needs-a-look')
    const lines = w.findAll('[data-testid="row-needs-a-look"]').map(p => p.text())
    expect(lines.length).toBe(rowTitles(w).length)
    expect(lines).toContain('no topic')
    // And the field detail with its actions is there to decide with.
    expect(w.findAll('[data-testid="needs-a-look-field"]').length).toBeGreaterThan(0)
  })

  it('accounts for the rows that live in the other browser (P6-23)', async () => {
    // The landing can only link a queue to ONE browser, and the roll-up mixes
    // datasets and documents — so "3 Needs a look" opening a list of 2 has to
    // say where the third went rather than quietly showing fewer rows than
    // the panel counted.
    mockedCatalog.mockResolvedValue([
      e({ slug: 'memo', kind: 'document', title: 'A memo', status: 'published' }),
      e({ slug: 'note', kind: 'note', title: 'A note', status: 'open' }),
      // Same queue, other browser.
      e({ slug: 'landholders', kind: 'dataset', title: 'Landholders', status: 'published' }),
    ])
    const w = await mountAt('/docs?attention=needs-a-look')
    expect(rowTitles(w)).toEqual(['A memo', 'A note'])
    const elsewhere = w.get('[data-testid="docs-queue-elsewhere"]')
    expect(elsewhere.text()).toContain('1 more is in the datasets browser')
    expect(elsewhere.attributes('href')).toBe('/datasets?attention=needs-a-look')
  })

  it('says nothing about another browser on a queue that does not span one', async () => {
    const w = await mountAt('/docs?attention=to-file')
    expect(w.find('[data-testid="docs-queue-elsewhere"]').exists()).toBe(false)
  })

  it('keeps the deciding off the plain browse page', async () => {
    // A browse list is not a place to be asked to decide things — the actions
    // belong on the list the queue opens.
    const plain = await mountAt('/docs')
    expect(plain.find('[data-testid="needs-a-look-field"]').exists()).toBe(false)
    // The per-row line is not a decision, so it stays: it is what the row says
    // about itself, the same as its topic chip.
    expect(plain.findAll('[data-testid="row-needs-a-look"]').length).toBeGreaterThan(0)
    const other = await mountAt('/docs?attention=to-file')
    expect(other.find('[data-testid="needs-a-look-field"]').exists()).toBe(false)
  })
})

describe('starting a page (P6-5, from the retired pages index)', () => {
  it('offers the new-page form, and routes a title to its slug', async () => {
    const w = await mountAt('/docs')
    await w.get('[data-testid="new-page-title"]').setValue('Heirs property in Georgia')
    expect(w.get('[data-testid="new-page-slug"]').text()).toBe('→ /wiki/heirs-property-in-georgia')
    await w.get('[data-testid="new-page"] form').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/wiki/heirs-property-in-georgia')
    expect(router.currentRoute.value.query.title).toBe('Heirs property in Georgia')
  })

  it('refuses a title with nothing to make a name from', async () => {
    const w = await mountAt('/docs')
    await w.get('[data-testid="new-page-title"]').setValue('!!! ???')
    await w.get('[data-testid="new-page"] form').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/docs')
    expect(w.get('[data-testid="new-page-error"]').text()).toContain('no letters or numbers')
  })
})

describe('the filters, each as a URL key (P6-4)', () => {
  it('q matches every word in any field', async () => {
    const w = await mountAt('/docs?q=landowner+brief')
    expect(rowTitles(w)).toEqual(['TELE landowner brief'])
  })

  it('purpose narrows the list — ideas is a chip here, not a page of its own', async () => {
    const w = await mountAt('/docs?purpose=ideas')
    expect(rowTitles(w)).toEqual(['An idea about the map'])
    expect(w.find('[data-testid="purpose-chips"] [data-chip="ideas"]').exists()).toBe(true)
  })

  it('topic and kind narrow the list', async () => {
    const byTopic = await mountAt('/docs?topic=land')
    expect(rowTitles(byTopic).sort()).toEqual(['Heirs property', 'TELE landowner brief'])
    const byKind = await mountAt('/docs?kind=wiki')
    expect(rowTitles(byKind).sort()).toEqual(['Heirs property', 'Start here'])
  })

  it('purpose=none finds what nobody has said is for anything', async () => {
    const w = await mountAt('/docs?purpose=none&kind=document')
    expect(rowTitles(w)).toEqual(['A document nobody filed'])
  })

  it('writes a pressed chip into the URL', async () => {
    const w = await mountAt('/docs')
    await w.get('[data-testid="purpose-chips"] [data-chip="research"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.purpose).toBe('research')
  })
})

describe('the rows (P6-4)', () => {
  it('shows the kind, the purpose, the topic, when it changed and a link to the page', async () => {
    const w = await mountAt('/docs?q=heirs')
    const row = w.get('[data-testid="doc-row"]')
    expect(row.get('[data-testid="row-kind"]').text()).toBe('page')
    expect(row.get('[data-testid="row-purpose"]').text()).toBe('Research')
    expect(row.get('[data-testid="row-topic"]').text()).toBe('Land')
    expect(row.get('[data-testid="row-when"]').text()).toBeTruthy()
    expect(row.attributes('href')).toBe('/wiki/heirs-property')
  })

  it('leaves out datasets, saved views and archived rows', async () => {
    const w = await mountAt('/docs')
    const titles = rowTitles(w)
    expect(titles).not.toContain('EPA sites')
    expect(titles).not.toContain('A saved view')
    expect(titles).not.toContain('Superseded brief')
  })
})

describe('the page’s states (P6-4)', () => {
  it('shows a skeleton while the catalog is on its way', async () => {
    let release = (_: CatalogEntry[]) => {}
    mockedCatalog.mockReturnValue(new Promise(resolve => (release = resolve)) as never)
    const w = await mountAt('/docs')
    expect(w.find('[data-testid="docs-loading"]').exists()).toBe(true)
    release(CATALOG)
    await flushPromises()
    expect(w.find('[data-testid="docs-loading"]').exists()).toBe(false)
  })

  it('says so when a filter matches nothing', async () => {
    const w = await mountAt('/docs?q=nothing-matches-this')
    expect(w.get('[data-testid="docs-empty"]').text()).toContain('Nothing matches these filters')
  })

  it('says so when the catalog will not load', async () => {
    mockedCatalog.mockRejectedValue(new Error('nope'))
    const w = await mountAt('/docs')
    expect(w.get('[data-testid="docs-error"]').text()).toContain('did not load')
  })
})

describe('phone layout (P5-60 guards)', () => {
  const css = readStyles('src/views/DocsView.vue')
  const phone = mediaBlock(css, 640)

  it('keeps the page from setting its own width off a long title', () => {
    expect(ruleFor(css, '.docs-view')).toContain('min-width: 0')
    expect(ruleFor(phone, '.docs-view')).toContain('max-width: 100%')
  })

  it('gives the search box a thumb-sized target that does not zoom iOS', () => {
    expect(ruleFor(phone, '.search-input')).toContain('min-height: 44px')
    expect(ruleFor(phone, '.search-input')).toContain('font-size: 16px')
  })
})
