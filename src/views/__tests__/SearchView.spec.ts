import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

// KbNav registers a logout hook and reads the user on mount.
const roleRef = ref<{ username: string; role: 'admin' | 'internal' } | null>({ username: 'dev', role: 'internal' })
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: roleRef }),
  registerLogoutHook: vi.fn(),
}))

vi.mock('@/lib/search', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/search')>()
  return { ...actual, searchEverything: vi.fn() }
})

import { searchEverything, facetsFor, INSIDE_DOCUMENTS, type SearchOutcome } from '@/lib/search'
import SearchView from '../SearchView.vue'

/**
 * P6-6: the search page. The searching itself is `lib/search.spec.ts`'s job —
 * this is about what the page does with an answer: the groups in order, the
 * chips as URL keys, the pages inside documents, and what it says when
 * nothing matched.
 */
const mockedSearch = vi.mocked(searchEverything)

function outcome(partial: Partial<SearchOutcome> = {}): SearchOutcome {
  return {
    groups: [],
    facets: facetsFor([]),
    matched: 0,
    searchedInsideDocuments: false,
    ...partial,
  }
}

const FULL = outcome({
  matched: 4,
  groups: [
    { name: 'Datasets', items: [{ key: 'dataset:organizations', title: 'Organizations', href: '/library/organizations', badge: 'dataset', verdict: 'Ready as: a table we hold · Place report: runs' }] },
    { name: 'Pages', items: [{ key: 'wiki:funding-network', title: 'Funding network', href: '/wiki/funding-network', badge: 'page', verdict: '' }] },
    { name: 'Analyses', items: [{ key: 'view:org-view', title: 'Org view', href: '/views/org-view', badge: 'view', verdict: '' }] },
    { name: 'Sources', items: [{ key: 'source:epa-npl', title: 'EPA NPL', href: '/library/epa-npl', badge: 'Source', verdict: '' }] },
  ],
  facets: {
    kind: [{ id: 'dataset', label: 'dataset', count: 1 }],
    organization: [{ id: 'epa', label: 'US EPA', count: 2 }],
    topic: [{ id: 'land', label: 'Land', count: 3 }],
    type: [{ id: 'areas', label: 'Areas and boundaries', count: 1 }],
    purpose: [],
  },
})

let router: Router
async function mountAt(path = '/search') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push(path)
  await router.isReady()
  const w = mount(SearchView, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

beforeEach(() => {
  mockedSearch.mockReset()
  mockedSearch.mockResolvedValue(outcome())
})

describe('SearchView (P6-6)', () => {
  it('searches what the URL asked for and renders the groups held-first, with counts', async () => {
    mockedSearch.mockResolvedValue(FULL)
    const w = await mountAt('/search?q=organizations')
    expect(mockedSearch).toHaveBeenCalledWith('organizations', {})
    expect(w.findAll('.group-name').map(h => h.text().replace(/\s+/g, ' '))).toEqual([
      'Datasets 1',
      'Pages 1',
      'Analyses 1',
      'Sources 1',
    ])
    const first = w.get('[data-testid="search-group-datasets"] .result')
    expect(first.attributes('href')).toBe('/library/organizations')
    expect(first.get('.badge').text()).toBe('dataset')
    expect(first.get('.result-verdict').text()).toContain('Ready as: a table we hold')
    expect((w.get('[data-testid="search-box"]').element as HTMLInputElement).value).toBe('organizations')
    w.unmount()
  })

  it('puts what was typed in the URL, and searches it', async () => {
    const w = await mountAt('/search')
    expect(mockedSearch).not.toHaveBeenCalled()
    expect(w.find('[data-testid="search-start"]').exists()).toBe(true)
    await w.get('[data-testid="search-box"]').setValue('heirs property')
    await w.get('form.search-box').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/search?q=heirs+property')
    expect(mockedSearch).toHaveBeenCalledWith('heirs property', {})
    w.unmount()
  })

  it('writes a chip as its own URL key, and pressing it again clears it', async () => {
    mockedSearch.mockResolvedValue(FULL)
    const w = await mountAt('/search?q=organizations')
    await w.get('[data-testid="search-chip-topic-land"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/search?q=organizations&topic=land')
    expect(mockedSearch).toHaveBeenLastCalledWith('organizations', { topic: 'land' })
    expect(w.get('[data-testid="search-chip-topic-land"]').classes()).toContain('active')

    // A second filter rides alongside the first (the five keys are independent).
    await w.get('[data-testid="search-chip-type-areas"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/search?q=organizations&topic=land&type=areas')

    await w.get('[data-testid="search-chip-topic-land"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/search?q=organizations&type=areas')
    w.unmount()
  })

  it('reads the filters out of the URL on arrival, and clears them all at once', async () => {
    mockedSearch.mockResolvedValue(FULL)
    const w = await mountAt('/search?q=organizations&organization=epa&kind=dataset')
    expect(mockedSearch).toHaveBeenCalledWith('organizations', { organization: 'epa', kind: 'dataset' })
    expect(w.get('[data-testid="search-chip-organization-epa"]').classes()).toContain('active')
    await w.get('[data-testid="search-clear"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/search?q=organizations')
    w.unmount()
  })

  it('shows the pages inside documents last, each opening the document at its page', async () => {
    mockedSearch.mockResolvedValue(
      outcome({
        matched: 1,
        searchedInsideDocuments: true,
        groups: [
          { name: 'Docs', items: [{ key: 'document:plan', title: 'Strategic plan', href: '/library/plan', badge: 'document', verdict: '' }] },
          {
            name: INSIDE_DOCUMENTS,
            items: [
              {
                key: 'text:plan:Five_Year_Plan.pdf:12',
                title: 'Strategic plan',
                href: '/library/plan?view=Five_Year_Plan.pdf&tab=files#page=12',
                badge: 'page 12',
                verdict: '',
                page: 12,
                snippet: '…the cohort counties in Alabama and Mississippi…',
              },
            ],
          },
        ],
      }),
    )
    const w = await mountAt('/search?q=cohort+counties')
    const names = w.findAll('.group-name').map(h => h.text().replace(/\s+/g, ' '))
    expect(names[names.length - 1]).toBe('Inside documents 1')
    const row = w.get('[data-testid="search-group-inside-documents"] .result')
    expect(row.attributes('href')).toBe('/library/plan?view=Five_Year_Plan.pdf&tab=files#page=12')
    expect(row.get('.badge').text()).toBe('page 12')
    expect(row.get('.result-snippet').text()).toContain('cohort counties')
    w.unmount()
  })

  it('says so when nothing matched, and offers Chat', async () => {
    const w = await mountAt('/search?q=nothing+at+all')
    const empty = w.get('[data-testid="search-empty"]')
    expect(empty.text()).toContain('Nothing matched — try fewer words')
    expect(empty.get('a').attributes('href')).toBe('/chat')
    expect(w.find('[data-testid="search-chips"]').exists()).toBe(false)
    w.unmount()
  })

  it('keeps the page usable when the search fails', async () => {
    mockedSearch.mockRejectedValue(new Error('boom'))
    const w = await mountAt('/search?q=organizations')
    expect(w.get('[data-testid="search-error"]').text()).toBeTruthy()
    expect(w.find('[data-testid="search-box"]').exists()).toBe(true)
    w.unmount()
  })
})
