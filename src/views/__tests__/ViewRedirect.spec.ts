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
async function openViewLink(slug: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div>map</div>' } },
      { path: '/views/:slug', component: ViewRedirect },
      { path: '/library', component: { template: '<div>library</div>' } },
      { path: '/library/:slug', component: { template: '<div>table</div>' } },
      { path: '/compare', component: { template: '<div>compare</div>' } },
    ],
  })
  await router.push(`/views/${slug}`)
  await router.isReady()
  const wrapper = mount(ViewRedirect, {
    global: {
      plugins: [router],
      // P7-2: the workspace is the explorer plus a map. This file is about the
      // FORK — which branch a document takes — so the heavy half is stubbed
      // and `WorkingSetWorkspace.spec.ts` is where it is really exercised.
      stubs: { WorkingSetWorkspace: { props: ['view'], template: '<div data-testid="workspace-stub">{{ view.slug }}</div>' } },
    },
  })
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
describe('ViewRedirect — a view that presents a working set (P7-2)', () => {
  it('stays put and renders the set’s two interfaces', async () => {
    mockFetchView.mockResolvedValue({ ...mapView(), workingSet: 'memphis-redevelopment' })
    const w = await openViewLink('tn-target-counties')
    expect(router.currentRoute.value.path).toBe('/views/tn-target-counties')
    expect(w.get('[data-testid="workspace-stub"]').text()).toBe('tn-target-counties')
    // Not the shim's line, and not the missing panel.
    expect(w.find('[data-testid="view-redirect"]').exists()).toBe(false)
    expect(w.find('[data-testid="view-missing"]').exists()).toBe(false)
  })

  it('hands the workspace the view, because the view is the framing', async () => {
    const view = { ...mapView(), workingSet: 'memphis-redevelopment' }
    mockFetchView.mockResolvedValue(view)
    const w = await openViewLink('tn-target-counties')
    expect(w.findComponent(WorkingSetWorkspace).props('view')).toEqual(view)
  })

  it('does not redirect a set-backed TABLE view to the explorer any more', async () => {
    mockFetchView.mockResolvedValue({ ...tableView(), workingSet: 'memphis-redevelopment' } as SavedView)
    const w = await openViewLink('georgia-orgs')
    expect(router.currentRoute.value.path).toBe('/views/georgia-orgs')
    expect(w.find('[data-testid="workspace-stub"]').exists()).toBe(true)
  })

  it('redirects a view whose pointer is empty — absent and blank both mean ad-hoc', async () => {
    mockFetchView.mockResolvedValue({ ...mapView(), workingSet: '' })
    await openViewLink('tn-target-counties')
    expect(router.currentRoute.value.path).toBe('/')
  })
})
