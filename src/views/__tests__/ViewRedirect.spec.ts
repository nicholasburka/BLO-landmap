import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

vi.mock('@/lib/views', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/views')>()),
  fetchView: vi.fn(),
}))

import { fetchView, type SavedView } from '@/lib/views'
import ViewRedirect from '../ViewRedirect.vue'
import WorkingSetWorkspace from '@/components/WorkingSetWorkspace.vue'

const mockFetchView = vi.mocked(fetchView)

/**
 * The /views/:slug shim (P5-16, extended by P5-54): a shared link is guarded
 * here, then sent on to whichever surface restores that kind of view.
 */
let router: Router
async function openViewLink(slug: string, query: Record<string, string> = {}) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>map</div>' } },
      { path: '/views/:slug', component: ViewRedirect },
      // P11-2: where a set-backed view now lands. Stubbed, because this file
      // is about the FORK — which branch a document takes — and
      // `WorkingSetWorkspace.spec.ts` is where the set page is exercised.
      { path: '/sets/:slug', component: { template: '<div data-testid="set-stub">set</div>' } },
      { path: '/library', component: { template: '<div>library</div>' } },
      { path: '/library/:slug', component: { template: '<div>table</div>' } },
      { path: '/compare', component: { template: '<div>compare</div>' } },
    ],
  })
  await router.push({ path: `/views/${slug}`, query })
  await router.isReady()
  const wrapper = mount(ViewRedirect, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

function mapView(): SavedView {
  return {
    slug: 'tn-target-counties',
    name: 'TN target counties',
    type: 'map',
    savedBy: 'maria',
    savedAt: '2026-09-03T12:00:00.000Z',
    state: { layers: [], filters: [], limit: null, regionStates: [], prompt: '', viewport: null },
    results: [],
  }
}

function tableView(state: Record<string, unknown> = {}): SavedView {
  return {
    ...mapView(),
    slug: 'georgia-orgs',
    name: 'Georgia orgs',
    type: 'table',
    state: {
      dataset: 'orgs',
      filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
      sort: 'Score',
      dir: 'desc',
      savedRowCount: 13,
      ...state,
    },
  } as unknown as SavedView
}

function compareView(state: Record<string, unknown> = {}): SavedView {
  return {
    ...mapView(),
    slug: 'delta-shortlist',
    name: 'Delta shortlist',
    type: 'compare',
    state: {
      counties: ['47157', '28033'],
      layers: ['median_home_value', 'life_expectancy'],
      notes: { '47157': 'River port.' },
      ...state,
    },
  } as unknown as SavedView
}

beforeEach(() => {
  mockFetchView.mockReset()
})

describe('ViewRedirect', () => {
  it('sends a map view to the map, which restores it from ?view=', async () => {
    mockFetchView.mockResolvedValue(mapView())
    await openViewLink('tn-target-counties')
    expect(router.currentRoute.value.path).toBe('/')
    expect(router.currentRoute.value.query).toEqual({ view: 'tn-target-counties' })
  })

  it('sends a table view to its table, with the saved query and the view slug', async () => {
    mockFetchView.mockResolvedValue(tableView({ layers: ['median_home_value'] }))
    await openViewLink('georgia-orgs')
    const route = router.currentRoute.value
    expect(route.path).toBe('/library/orgs')
    expect(route.query).toEqual({
      tab: 'data',
      sort: 'Score',
      dir: 'desc',
      filter: JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]),
      layers: 'median_home_value',
      view: 'georgia-orgs',
    })
  })

  it('says so when the view is gone, instead of a silent plain map (P5-69)', async () => {
    mockFetchView.mockResolvedValue(null)
    const w = await openViewLink('deleted')
    expect(router.currentRoute.value.path).toBe('/views/deleted')
    const panel = w.get('[data-testid="view-missing"]')
    expect(panel.text()).toContain('There is no saved view called \u201Cdeleted\u201D.')
    expect(panel.findAll('a').map(a => a.attributes('href'))).toEqual(['/analysis', '/'])
    expect(w.find('[data-testid="view-redirect"]').exists()).toBe(false)
  })

  it('falls back to the map when the fetch fails (a logged-out link 401s here)', async () => {
    mockFetchView.mockRejectedValue(new Error('unauthorized'))
    await openViewLink('tn-target-counties')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('falls back to the map when a table document names no dataset', async () => {
    mockFetchView.mockResolvedValue(tableView({ dataset: '' }))
    await openViewLink('georgia-orgs')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('sends a compare view to /compare, with its counties, layers and the view slug (P5-55)', async () => {
    mockFetchView.mockResolvedValue(compareView())
    await openViewLink('delta-shortlist')
    const route = router.currentRoute.value
    expect(route.path).toBe('/compare')
    expect(route.query).toEqual({
      counties: '47157,28033',
      layers: 'median_home_value,life_expectancy',
      view: 'delta-shortlist',
    })
  })

  it('falls back to the map when a compare document has nothing left to compare', async () => {
    mockFetchView.mockResolvedValue(compareView({ layers: [] }))
    await openViewLink('delta-shortlist')
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('replaces itself rather than pushing, so Back does not bounce through the shim', async () => {
    mockFetchView.mockResolvedValue(mapView())
    router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div>map</div>' } },
        { path: '/views/:slug', component: ViewRedirect },
      ],
    })
    await router.push('/views/tn-target-counties')
    await router.isReady()
    const replace = vi.spyOn(router, 'replace')
    const push = vi.spyOn(router, 'push')
    mount(ViewRedirect, { global: { plugins: [router] } })
    await flushPromises()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })
})

/**
 * P7-2: the one document that does NOT get redirected.
 *
 * A view presenting a working set is already at the URL its two interfaces
 * live at, so this route renders them instead of replacing itself. The point of
 * this block is the other half: every ad-hoc view above still takes exactly the
 * path it took before, because a view with no set is permanent and
 * first-class — ad-hoc, not legacy (spec §F.1).
 */
describe('ViewRedirect — a view that presents a working set (P11-2)', () => {
  // P7-2 rendered the workspace right here, because `/views/<slug>` was the
  // only address a set's interfaces had. P11-2 gives the SET an address, so
  // this file is a shim again and the set-backed branch redirects like every
  // other branch does.
  it('redirects to the set’s own page', async () => {
    mockFetchView.mockResolvedValue({ ...mapView(), workingSet: 'memphis-redevelopment' })
    const w = await openViewLink('tn-target-counties')
    expect(router.currentRoute.value.path).toBe('/sets/memphis-redevelopment')
    // Not the missing panel: the view resolved, it just lives elsewhere now.
    expect(w.find('[data-testid="view-missing"]').exists()).toBe(false)
  })

  it('carries the link’s query across, so a shared deep link keeps its tab', async () => {
    mockFetchView.mockResolvedValue({ ...mapView(), workingSet: 'memphis-redevelopment' })
    await openViewLink('tn-target-counties', { tab: 'counties' })
    expect(router.currentRoute.value.path).toBe('/sets/memphis-redevelopment')
    expect(router.currentRoute.value.query.tab).toBe('counties')
  })

  it('sends a set-backed TABLE view to the set too, not to the explorer', async () => {
    mockFetchView.mockResolvedValue({ ...tableView(), workingSet: 'memphis-redevelopment' } as SavedView)
    await openViewLink('georgia-orgs')
    expect(router.currentRoute.value.path).toBe('/sets/memphis-redevelopment')
  })

  it('redirects a view whose pointer is empty — absent and blank both mean ad-hoc', async () => {
    mockFetchView.mockResolvedValue({ ...mapView(), workingSet: '' })
    await openViewLink('tn-target-counties')
    expect(router.currentRoute.value.path).toBe('/')
  })
})
