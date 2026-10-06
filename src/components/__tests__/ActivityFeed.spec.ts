import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

vi.mock('@/lib/kbConfig', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/kbConfig')>()
  return { ...actual, fetchActivity: vi.fn() }
})

import { fetchActivity, type ActivityRow } from '@/lib/kbConfig'
import ActivityFeed from '../ActivityFeed.vue'

const mocked = vi.mocked(fetchActivity)

const row = (over: Partial<ActivityRow> = {}): ActivityRow => ({
  at: '2026-09-04T11:00:00Z',
  actor: 'maria',
  verb: 'uploaded',
  target: { slug: 'organizations', title: 'Organizations', kind: 'dataset', href: '/library/organizations' },
  ...over,
})

function mountFeed() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  return mount(ActivityFeed, { global: { plugins: [router] } })
}

beforeEach(() => {
  mocked.mockReset()
  vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))
})

describe('ActivityFeed', () => {
  it('shows a skeleton first, then rows with actor, verb, linked target and relative time', async () => {
    let resolve!: (rows: ActivityRow[]) => void
    mocked.mockReturnValue(new Promise<ActivityRow[]>(r => (resolve = r)))
    const w = mountFeed()
    expect(w.find('[data-testid="activity-skeleton"]').exists()).toBe(true)

    resolve([row(), row({ verb: 'reindexed the library', target: null, at: '2026-09-04T10:00:00Z' })])
    await flushPromises()

    expect(w.find('[data-testid="activity-skeleton"]').exists()).toBe(false)
    const items = w.findAll('[data-testid="activity-row"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('maria')
    expect(items[0].text()).toContain('uploaded')
    expect(items[0].get('a').attributes('href')).toBe('/library/organizations')
    expect(items[0].text()).toContain('1h ago')
    // A row without a target still reads as a sentence, and links nowhere.
    expect(items[1].text()).toContain('reindexed the library')
    expect(items[1].find('a').exists()).toBe(false)
    expect(mocked).toHaveBeenCalledWith(12)
  })

  it('says so in plain words when nothing has happened yet', async () => {
    mocked.mockResolvedValue([])
    const w = mountFeed()
    await flushPromises()
    expect(w.text()).toContain('Nothing yet')
    expect(w.find('[data-testid="activity-more"]').exists()).toBe(false)
  })

  it('offers "Show more" only when the first page was full, and loads 50', async () => {
    mocked.mockResolvedValue(Array.from({ length: 12 }, (_, i) => row({ at: `2026-09-04T0${i % 10}:00:00Z` })))
    const w = mountFeed()
    await flushPromises()
    const more = w.get('[data-testid="activity-more"]')

    mocked.mockResolvedValue(Array.from({ length: 20 }, () => row()))
    await more.trigger('click')
    await flushPromises()
    expect(mocked).toHaveBeenLastCalledWith(50)
    expect(w.findAll('[data-testid="activity-row"]')).toHaveLength(20)
    expect(w.find('[data-testid="activity-more"]').exists()).toBe(false)
  })

  it('shows an error instead of pretending the library is quiet', async () => {
    mocked.mockRejectedValue(new Error('activity request failed (500)'))
    const w = mountFeed()
    await flushPromises()
    // P5-72: a status code tells the reader nothing they can act on.
    expect(w.text()).toContain('Recent activity did not load. Try again in a moment.')
    expect(w.text()).not.toContain('500')
  })

  it('says when the request never left the building', async () => {
    mocked.mockRejectedValue(new TypeError('Failed to fetch'))
    const w = mountFeed()
    await flushPromises()
    expect(w.text()).toContain('No connection — check your network and try again.')
  })
})
