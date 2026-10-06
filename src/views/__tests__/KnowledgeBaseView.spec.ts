import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalog: vi.fn() }
})

vi.mock('@/lib/kbConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/kbConfig')>()
  return { ...actual, fetchKbConfig: vi.fn(), fetchActivity: vi.fn() }
})

vi.mock('@/lib/recentlyEdited', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/recentlyEdited')>()
  return { ...actual, fetchRecentEdits: vi.fn() }
})

vi.mock('@/lib/placeReport', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/placeReport')>()
  return { ...actual, fetchPlaceReports: vi.fn() }
})

import { ref } from 'vue'

// The landing reads the caller's name (for "yours") and role (for the admin
// blocks at the foot). A controllable ref lets each test pick who is looking.
const roleRef = ref<{ username: string; role: 'admin' | 'internal' } | null>({ username: 'dev', role: 'admin' })
// KbNav reaches the shortlist (P5-55), which registers a logout hook.
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: roleRef }),
  registerLogoutHook: vi.fn(),
}))

import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { fetchKbConfig, fetchActivity, KB_CONFIG_DEFAULTS, type KbConfig } from '@/lib/kbConfig'
import { fetchRecentEdits, type EditRow } from '@/lib/recentlyEdited'
import { fetchPlaceReports } from '@/lib/placeReport'
import { publicLayers } from '@/lib/publicLayers'
import FirstRunChecklist from '@/components/FirstRunChecklist.vue'
import { FIRST_RUN_KEY, loadFirstRun, type FirstRunStepId } from '@/lib/firstRun'
import { helpDrawerOpen, closeHelpDrawer } from '@/lib/helpRecipes'
import KnowledgeBaseView from '../KnowledgeBaseView.vue'

const mocked = vi.mocked(fetchCatalog)
const mockedConfig = vi.mocked(fetchKbConfig)
const mockedActivity = vi.mocked(fetchActivity)
const mockedEdits = vi.mocked(fetchRecentEdits)
const mockedReports = vi.mocked(fetchPlaceReports)

const e = (over: Partial<CatalogEntry>): CatalogEntry => ({ slug: 'x', kind: 'document', title: 'X', category: '', status: 'published', tags: [], meta: {}, files: [], bytes: 0, ...over })

const config = (over: Partial<KbConfig> = {}): KbConfig => ({ ...KB_CONFIG_DEFAULTS, ...over })

const edit = (slug: string, actor: string, at: string, kind = 'wiki'): EditRow => ({
  at,
  actor,
  target: { slug, title: slug, kind, href: kind === 'wiki' ? `/wiki/${slug}` : `/library/${slug}` },
})

/** Puts the checklist away the way a person who finished it would have. */
function finishFirstRun(): void {
  const done: FirstRunStepId[] = ['data', 'read', 'map', 'ask', 'add', 'search']
  localStorage.setItem(FIRST_RUN_KEY, JSON.stringify({ done, dismissed: false }))
  loadFirstRun()
}

let router: Router
async function mountAt(path = '/kb') {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }, { path: '/kb', component: KnowledgeBaseView }] })
  await router.push(path)
  await router.isReady()
  const w = mount(KnowledgeBaseView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

const blocks = (w: Awaited<ReturnType<typeof mountAt>>) =>
  w.findAll('[data-testid="kb-blocks"] > *').map(b => b.attributes('data-testid'))

const rowTexts = (w: Awaited<ReturnType<typeof mountAt>>, testid: string) =>
  w.findAll(`[data-testid="${testid}"] li`).map(li => li.text().replace(/\s+/g, ' ').trim())

beforeEach(() => {
  mocked.mockReset()
  mockedConfig.mockReset()
  mockedActivity.mockReset()
  mockedEdits.mockReset()
  mockedReports.mockReset()
  mocked.mockResolvedValue([
    e({ slug: 'home', kind: 'wiki', title: 'Start here', updatedAt: '2026-09-04T10:00:00Z' }),
    e({ slug: 'organizations', kind: 'dataset', title: 'Organizations', category: 'network', updatedAt: '2026-09-04T12:00:00Z' }),
    e({ slug: 'plan', kind: 'document', title: 'Plan', updatedAt: '2026-09-03T00:00:00Z' }),
    e({ slug: 'drop', kind: 'incoming', title: 'census link', status: 'needs-cataloging' }),
    e({ slug: 'idea', kind: 'note', title: 'An idea', category: 'ideas', status: 'open' }),
    // P5-64: the registry — indexed, not held.
    e({ slug: 'epa-superfund-npl', kind: 'source', title: 'Superfund NPL', category: 'environment' }),
    e({ slug: 'census-acs', kind: 'source', title: 'ACS 5-year', category: 'people' }),
  ])
  mockedConfig.mockResolvedValue(config())
  mockedActivity.mockResolvedValue([])
  mockedEdits.mockResolvedValue([])
  mockedReports.mockResolvedValue([])
  roleRef.value = { username: 'dev', role: 'admin' }
  // P5-43: most of these cases are about the settled landing, not a first
  // day on the job. Start with the checklist already put away; the cases
  // that care about it clear this themselves.
  localStorage.setItem(FIRST_RUN_KEY, JSON.stringify({ done: [], dismissed: true }))
  loadFirstRun()
  closeHelpDrawer()
})

afterEach(() => {
  localStorage.clear()
  loadFirstRun()
  closeHelpDrawer()
})

describe('KnowledgeBaseView — the front door (P6-5)', () => {
  it('lays the page out in the spec order, one column', async () => {
    mockedConfig.mockResolvedValue(config({ pinned: [{ slug: 'plan', kind: 'document', title: 'The 5-5-5 plan', category: 'strategy', description: '', href: '/library/plan' }] }))
    const w = await mountAt()
    expect(blocks(w)).toEqual(['kb-recent-edited', 'kb-pinned', 'kb-counts', 'kb-recent-block'])
    // The admin's own view comes after all of them.
    const order = w.findAll('[data-testid="kb-blocks"], [data-testid="kb-admin"]').map(b => b.attributes('data-testid'))
    expect(order).toEqual(['kb-blocks', 'kb-admin'])
  })

  it('leaves the pinned block out entirely when nothing is pinned', async () => {
    const w = await mountAt()
    expect(blocks(w)).toEqual(['kb-recent-edited', 'kb-counts', 'kb-recent-block'])
  })

  it('shows the library strip — both axes — and none of the old eight-item one', async () => {
    const w = await mountAt()
    // P6-13 brought Search, Chat and New down from the sitewide header into
    // the library's own strip, beside the three resources.
    expect(w.findAll('[data-testid="kb-nav"] a').map(a => a.text().trim())).toEqual([
      'Datasets',
      'Docs',
      'Analysis',
      'Search',
      'Chat',
      'New',
    ])
  })

  it('has dropped the P5-68 flow cards', async () => {
    const w = await mountAt()
    expect(w.find('[data-testid="kb-flows"]').exists()).toBe(false)
    expect(w.find('[data-testid="ask-box"]').exists()).toBe(false)
    expect(w.find('[data-testid="kb-add"]').exists()).toBe(false)
  })

  it('keeps the how-do-I drawer at the foot', async () => {
    const w = await mountAt()
    const link = w.get('[data-testid="kb-help-link"]')
    expect(link.text()).toContain('How do I')
    expect(helpDrawerOpen.value).toBe(false)
    await link.trigger('click')
    expect(helpDrawerOpen.value).toBe(true)
  })

  it('asks the catalog through the shared cache, once', async () => {
    await mountAt()
    // P5-89: the shared cache's key, plus the handler the fresh rows land in.
    expect(mocked).toHaveBeenCalledWith({ archived: true }, expect.any(Function))
    expect(mocked).toHaveBeenCalledTimes(1)
  })
})

describe('recently edited (P6-5)', () => {
  const FEED: EditRow[] = [
    edit('field-notes', 'dev', '2026-09-23T12:00:00Z'),
    edit('funding', 'nick', '2026-09-23T11:00:00Z'),
    edit('organizations', 'dev', '2026-09-23T10:00:00Z', 'dataset'),
    edit('evidence-base', 'omar', '2026-09-23T09:00:00Z'),
    edit('seed-catalog', 'dev', '2026-09-23T08:00:00Z'),
    edit('why-five-million', 'nick', '2026-09-23T07:00:00Z'),
    edit('home', 'omar', '2026-09-23T06:00:00Z'),
  ]

  it('is ONE list: my last three marked "yours", then the last few by anyone', async () => {
    mockedEdits.mockResolvedValue(FEED)
    const w = await mountAt()
    expect(w.findAll('[data-testid="kb-edits"] a').map(a => a.text())).toEqual([
      'field-notes',
      'organizations',
      'seed-catalog',
      'funding',
      'evidence-base',
      'why-five-million',
    ])
    // Exactly three are mine, and they are the first three.
    const marks = w.findAll('[data-testid="kb-edits"] li').map(li => li.find('[data-testid="kb-edit-yours"]').exists())
    expect(marks).toEqual([true, true, true, false, false, false])
    // No second heading — one list, as the spec decided.
    expect(w.findAll('[data-testid="kb-recent-edited"] h2')).toHaveLength(1)
  })

  it('names whoever else made the edit', async () => {
    mockedEdits.mockResolvedValue(FEED)
    const w = await mountAt()
    expect(rowTexts(w, 'kb-edits')[3]).toContain('nick')
    expect(rowTexts(w, 'kb-edits')[0]).toContain('yours')
    expect(rowTexts(w, 'kb-edits')[0]).not.toContain('dev')
  })

  it('is just "recently updated by anyone" for a new colleague', async () => {
    roleRef.value = { username: 'newcomer', role: 'internal' }
    mockedEdits.mockResolvedValue(FEED)
    const w = await mountAt()
    expect(w.find('[data-testid="kb-edit-yours"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="kb-edits"] a').map(a => a.text())).toEqual([
      'field-notes',
      'funding',
      'organizations',
      'evidence-base',
      'seed-catalog',
      'why-five-million',
    ])
  })

  it('links each row at the entry it names', async () => {
    mockedEdits.mockResolvedValue(FEED)
    const w = await mountAt()
    expect(w.findAll('[data-testid="kb-edits"] a').map(a => a.attributes('href'))).toContain('/library/organizations')
    expect(w.findAll('[data-testid="kb-edits"] a').map(a => a.attributes('href'))).toContain('/wiki/funding')
  })

  it('says so plainly when nothing has been edited', async () => {
    const w = await mountAt()
    expect(w.get('[data-testid="kb-recent-edited"]').text()).toContain('Nothing edited yet')
  })

  it('says what went wrong without leaking the status code, and leaves the rest of the page alone', async () => {
    mockedEdits.mockRejectedValue(new Error('recent edits request failed (503)'))
    const w = await mountAt()
    const block = w.get('[data-testid="kb-recent-edited"]').text()
    expect(block).toContain('Recent edits did not load')
    expect(block).not.toContain('503')
    expect(w.findAll('[data-testid="kb-tiles"] .tile')).toHaveLength(3)
  })
})

describe('the three resource tiles (P6-5)', () => {
  it('counts datasets as what we hold, what we index, and what the map draws', async () => {
    const w = await mountAt()
    const tile = w.get('[data-testid="kb-tile-datasets"]')
    expect(tile.attributes('href')).toBe('/datasets')
    expect(tile.get('.tile-label').text()).toBe('Datasets')
    // 1 held dataset + 2 sources + the public registry, which ships in the
    // bundle and so needs no request.
    expect(tile.get('.tile-count').text()).toBe(String(1 + 2 + publicLayers().length))
  })

  it('counts docs as pages, documents and notes', async () => {
    const w = await mountAt()
    const tile = w.get('[data-testid="kb-tile-docs"]')
    expect(tile.attributes('href')).toBe('/docs')
    // 1 page + (1 document + 1 to-file) + 1 note.
    expect(tile.get('.tile-count').text()).toBe('4')
  })

  it('counts analyses as saved views plus the cached place reports', async () => {
    mocked.mockResolvedValue([
      e({ slug: 'a-view', kind: 'view', title: 'A view' }),
      e({ slug: 'b-view', kind: 'view', title: 'Another view' }),
    ])
    mockedReports.mockResolvedValue([
      { placeKey: 'g13121', label: 'Fulton', by: 'dev', at: '2026-09-20T00:00:00Z', found: 3, sources: 9 },
    ])
    const w = await mountAt()
    const tile = w.get('[data-testid="kb-tile-analysis"]')
    expect(tile.attributes('href')).toBe('/analysis')
    expect(tile.get('.tile-count').text()).toBe('3')
  })

  it('shows three tiles and no more', async () => {
    const w = await mountAt()
    expect(w.findAll('[data-testid="kb-tiles"] .tile').map(t => t.get('.tile-label').text())).toEqual([
      'Datasets',
      'Docs',
      'Analysis',
    ])
  })

  it('counts nothing when the report index is unreachable, rather than breaking the tile', async () => {
    mockedReports.mockRejectedValue(new Error('nope'))
    const w = await mountAt()
    expect(w.get('[data-testid="kb-tile-analysis"] .tile-count').text()).toBe('0')
  })
})

describe('pinned items (P6-5)', () => {
  it('lists the pinned entries from the kb config, each a link', async () => {
    mockedConfig.mockResolvedValue(
      config({
        pinned: [
          { slug: 'plan', kind: 'document', title: 'The 5-5-5 plan', category: 'strategy', description: '', href: '/library/plan' },
          { slug: 'home', kind: 'wiki', title: 'Start here', category: '', description: '', href: '/wiki/home' },
        ],
      }),
    )
    const w = await mountAt()
    const links = w.findAll('[data-testid="kb-pinned-list"] a')
    expect(links.map(a => a.text())).toEqual(['The 5-5-5 plan', 'Start here'])
    expect(links.map(a => a.attributes('href'))).toEqual(['/library/plan', '/wiki/home'])
    expect(rowTexts(w, 'kb-pinned-list')[1]).toContain('page')
  })
})

describe('most recent items (P6-5)', () => {
  it('shows five of any kind, newest first, whatever order the catalog returns', async () => {
    mocked.mockResolvedValue([
      e({ slug: 'dataset-first', kind: 'dataset', title: 'Held dataset', updatedAt: '2026-01-01T00:00:00Z' }),
      e({ slug: 'old-page', kind: 'wiki', title: 'Old page', updatedAt: '2026-05-01T00:00:00Z' }),
      e({ slug: 'newest-doc', kind: 'document', title: 'Newest document', updatedAt: '2026-09-06T00:00:00Z' }),
      e({ slug: 'a-view', kind: 'view', title: 'A saved view', updatedAt: '2026-09-05T00:00:00Z' }),
      e({ slug: 'a-note', kind: 'note', title: 'A note', status: 'open', updatedAt: '2026-09-04T00:00:00Z' }),
      e({ slug: 'a-source', kind: 'source', title: 'A source', updatedAt: '2026-09-03T00:00:00Z' }),
    ])
    const w = await mountAt()
    expect(w.findAll('[data-testid="kb-recent"] a').map(a => a.text())).toEqual([
      'Newest document',
      'A saved view',
      'A note',
      'A source',
      'Old page',
    ])
  })

  it('says so plainly when there is nothing in the library yet', async () => {
    mocked.mockResolvedValue([])
    const w = await mountAt()
    expect(w.get('[data-testid="kb-recent-block"]').text()).toContain('Nothing here yet')
  })

  it('only tells an admin to press Reindex — it is an admin button (P5-73)', async () => {
    mocked.mockResolvedValue([])
    roleRef.value = { username: 'boss', role: 'admin' }
    const admin = await mountAt()
    expect(admin.get('[data-testid="kb-recent-block"]').text()).toContain(
      'Add a page, drop a file, or push a dataset and press Reindex.',
    )

    roleRef.value = { username: 'phd', role: 'internal' }
    const member = await mountAt()
    const note = member.get('[data-testid="kb-recent-block"]').text()
    expect(note).toContain('Add a page or drop a file.')
    expect(note).not.toContain('Reindex')
  })
})

describe('the first-run checklist on the landing', () => {
  it('sits above the list on a first day, and points at the new surfaces', async () => {
    localStorage.clear()
    loadFirstRun()
    const w = await mountAt()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 0 of 6')
    expect(w.findAll('[data-testid="firstrun-item"] a').map(a => a.attributes('href'))).toEqual([
      '/datasets',
      '/docs',
      '/analysis',
      '/chat',
      '/new',
      '/search',
    ])
    // It is not one of the spec's blocks — it is above them, and gone for
    // good once it is finished.
    expect(blocks(w)).toEqual(['kb-recent-edited', 'kb-counts', 'kb-recent-block'])
  })

  it('is not on the page at all once it is finished', async () => {
    finishFirstRun()
    const w = await mountAt()
    expect(w.findComponent(FirstRunChecklist).exists()).toBe(false)
    expect(w.find('[data-testid="firstrun"]').exists()).toBe(false)
  })
})

describe('the admin blocks, last and admin-only', () => {
  it('shows needs attention and what happened to an admin, each row pointing where its rows live', async () => {
    roleRef.value = { username: 'boss', role: 'admin' }
    const w = await mountAt()
    expect(w.get('[data-testid="kb-admin"]').find('[data-testid="attention"]').exists()).toBe(true)
    expect(w.get('[data-testid="kb-admin"]').find('[data-testid="activity"]').exists()).toBe(true)

    // One quick drop in the catalog → one attention row. P6-33 gives the
    // metadata gaps ONE more between them: the drop has no topic and neither
    // source names a publisher or says where it applies, which used to be
    // three rows reading 1 / 2 / 2 over the same three entries.
    const rows = w.findAll('[data-testid="attention-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].attributes('href')).toBe('/docs?attention=to-file')
    expect(rows[0].text()).toContain('Waiting to be filed')
    expect(rows[1].attributes('href')).toBe('/docs?attention=needs-a-look')
    expect(rows[1].text()).toContain('Needs a look')
  })

  it('hides both from a member, and asks the activity feed for nothing', async () => {
    roleRef.value = { username: 'phd', role: 'internal' }
    const w = await mountAt()
    expect(w.find('[data-testid="kb-admin"]').exists()).toBe(false)
    expect(w.find('[data-testid="attention"]').exists()).toBe(false)
    expect(w.find('[data-testid="activity"]').exists()).toBe(false)
    expect(mockedActivity).not.toHaveBeenCalled()
    // The rest of the front door is untouched by role.
    expect(w.findAll('[data-testid="kb-tiles"] .tile')).toHaveLength(3)
  })

  it('says all clear when nothing needs attention', async () => {
    mocked.mockResolvedValue([e({ slug: 'plan', kind: 'document', title: 'Plan', status: 'published', category: 'strategy', tags: ['land'] })])
    const w = await mountAt()
    expect(w.findAll('[data-testid="attention-row"]')).toHaveLength(0)
    expect(w.get('[data-testid="attention-clear"]').text()).toContain('All clear')
  })
})

describe('when the requests do not land', () => {
  it('hides the initiative panel when nothing is configured, and shows the rest anyway', async () => {
    const w = await mountAt()
    expect(w.find('[data-testid="initiative"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="kb-tiles"] .tile')).toHaveLength(3)
  })

  it('shows the initiative when there is one, above the list', async () => {
    mockedConfig.mockResolvedValue(
      config({
        links: [{ label: 'Library guide', href: '/wiki/library-guide' }],
        initiative: { name: 'Initiative', tagline: 'One line.', facts: [{ label: 'Acres', value: '5,000' }], nextStep: { text: 'Read the initiative hub', href: '/wiki/hub' } },
      }),
    )
    const w = await mountAt()
    expect(w.get('[data-testid="initiative"]').text()).toContain('One line.')
    expect(w.get('[data-testid="initiative-next"]').attributes('href')).toBe('/wiki/hub')
    expect(w.get('[data-testid="initiative-links"]').text()).toContain('Library guide')
    // Above the spec's blocks, not one of them.
    expect(blocks(w)).not.toContain('initiative')
  })

  it('keeps working when the catalog request fails, and shows no invented zeroes', async () => {
    mocked.mockRejectedValue(new Error('catalog request failed (503)'))
    const w = await mountAt()
    // P5-72: the status code was never the reader's problem.
    const counts = w.get('[data-testid="kb-counts"]').text()
    expect(counts).toContain('The library did not load. Try again in a moment.')
    expect(counts).not.toContain('503')
    expect(w.findAll('[data-testid="kb-tiles"] .tile')[0].get('.tile-count').text()).toBe('—')
    expect(w.get('[data-testid="kb-recent-block"]').text()).toContain('the library did not load')
  })
})

describe('the landing does not scroll sideways at 375 px (P5-60)', () => {
  // Measured live: /kb overflowed by 203 px because the KbNav strip's sections
  // were the min-content width of `.kb-view`, a flex item of <main> whose
  // `min-width` defaults to `auto`. jsdom computes no layout, so the rules that
  // stop it are asserted where they are written.
  const KB = readStyles('src/views/KnowledgeBaseView.vue')
  const KB_PHONE = mediaBlock(KB, 640)
  /** Comments explain the pixel floors these rules removed; only the
   *  declarations are being searched. */
  const declarations = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

  it('lets every box in the page chain shrink below its content', () => {
    for (const selector of ['.kb-view', '.kb-panel', '.kb-header', '.kb-blocks', '.block', '.kb-admin']) {
      const rule = ruleFor(KB_PHONE, selector)
      expect(rule, selector).toContain('min-width: 0')
      expect(rule, selector).toContain('max-width: 100%')
    }
  })

  // P5-60 asked that the hint claim no width of its own, and kept it `inline`
  // to get that. P6-28 goes further and hides it: the concern was width, and a
  // hint that is not rendered claims none.
  it('lets the keyboard hint claim no width of its own', () => {
    expect(ruleFor(KB_PHONE, '.kbd-hint')).toContain('display: none')
  })

  it('gives no phone grid a pixel floor', () => {
    // `minmax(180px, 1fr)` × 2 is a 370 px minimum the page has to honour;
    // `minmax(0, 1fr)` is not.
    expect(declarations(KB_PHONE)).not.toMatch(/minmax\(\s*\d+px/)
    expect(ruleFor(KB_PHONE, '.tiles')).toContain('minmax(0, 1fr)')
    // The one column the admin grid collapses into, above 640 px.
    expect(ruleFor(mediaBlock(KB, 900), '.kb-admin')).toContain('minmax(0, 1fr)')
  })

  it('has the same guard in every panel it hosts', () => {
    const phone = mediaBlock(readStyles('src/components/InitiativePanel.vue'), 640)
    expect(declarations(phone)).not.toMatch(/minmax\(\s*\d+px/)
    expect(ruleFor(phone, '.facts')).toContain('minmax(0, 1fr)')
    expect(ruleFor(mediaBlock(readStyles('src/components/AttentionPanel.vue'), 640), '.row')).toContain('min-width: 0')
    expect(ruleFor(mediaBlock(readStyles('src/components/ActivityFeed.vue'), 640), '.line')).toContain('min-width: 0')
  })

  /**
   * P6-5: the check that used to live in the retired WikiView's spec. The bug
   * it caught was one view missing what the others had, so it has to survive
   * the view that happened to host it.
   */
  it('has the guard on every internal page container, not just this one', () => {
    const containers: Record<string, string> = {
      'src/views/KnowledgeBaseView.vue': '.kb-view',
      'src/views/DatasetsView.vue': '.datasets-view',
      'src/views/DocsView.vue': '.docs-view',
      'src/views/WikiPageView.vue': '.wiki-page-view',
      'src/views/LibraryEntryView.vue': '.entry-view',
      'src/views/AccountView.vue': '.account-view',
      'src/views/LoginView.vue': '.login-view',
    }
    for (const [path, selector] of Object.entries(containers)) {
      const rule = ruleFor(mediaBlock(readStyles(path), 640), selector)
      expect(rule, `${path} ${selector}`).toContain('min-width: 0')
      expect(rule, `${path} ${selector}`).toContain('max-width: 100%')
    }
  })
})

describe('keyboard hints are not shown to a reader who has no keyboard (P6-28)', () => {
  // jsdom computes no layout, so the rule is the behaviour here.
  const phone = () => mediaBlock(readStyles('src/views/KnowledgeBaseView.vue'), 640)

  it('hides both hints on a phone — ⌘K on the hero and ? at the foot', () => {
    expect(ruleFor(phone(), '.kbd-hint')).toContain('display: none')
  })

  it('still renders both hints in the markup, so a laptop keeps them', async () => {
    const w = await mountAt()
    const hints = w.findAll('.kbd-hint').map(h => h.text())
    expect(hints).toHaveLength(2)
    expect(hints[0]).toContain('Searchable with')
    expect(hints[1]).toContain('any time')
  })
})
