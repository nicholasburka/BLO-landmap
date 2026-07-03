import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.SESSION_HMAC_SECRET = 'test-secret-0123456789abcdef0123456789abcdef'
// No DATABASE_URL → in-memory path.

const store = await import('./usageStore.js')

function entry(over: Partial<import('./usageStore.js').UsageEntry> = {}) {
  return {
    ts: Date.parse('2026-07-03T12:00:00Z'),
    path: '/api/chat',
    status: 200,
    durationMs: 900,
    inputTokens: 800,
    outputTokens: 200,
    tier: 'normal',
    themes: ['housing'],
    ipHash: 'abc123',
    ...over,
  }
}

beforeEach(() => {
  store._resetMemory()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('persistence mode', () => {
  it('is memory without DATABASE_URL', () => {
    expect(store.persistenceMode()).toBe('memory')
  })
})

describe('hashIp', () => {
  it('is deterministic and never returns the raw ip', () => {
    const h = store.hashIp('203.0.113.7')
    expect(h).toBe(store.hashIp('203.0.113.7'))
    expect(h).not.toContain('203.0.113.7')
    expect(h).toHaveLength(16)
  })
  it('differs by ip', () => {
    expect(store.hashIp('1.1.1.1')).not.toBe(store.hashIp('2.2.2.2'))
  })
})

describe('daily aggregation', () => {
  it('sums tokens and requests per day and splits by path', async () => {
    store.recordUsage(entry({ path: '/api/chat', inputTokens: 800, outputTokens: 200 }))
    store.recordUsage(entry({ path: '/api/query', inputTokens: 100, outputTokens: 50 }))
    const daily = await store.getDailyAggregates(30)
    expect(daily).toHaveLength(1)
    expect(daily[0].requests).toBe(2)
    expect(daily[0].totalTokens).toBe(800 + 200 + 100 + 50)
    expect(daily[0].chat).toBe(1)
    expect(daily[0].query).toBe(1)
  })

  it('counts unique ips', async () => {
    store.recordUsage(entry({ ipHash: 'a' }))
    store.recordUsage(entry({ ipHash: 'a' }))
    store.recordUsage(entry({ ipHash: 'b' }))
    const daily = await store.getDailyAggregates(30)
    expect(daily[0].uniqueIps).toBe(2)
  })

  it('excludes entries outside the window', async () => {
    store.recordUsage(entry({ ts: Date.now() })) // today
    store.recordUsage(entry({ ts: Date.now() - 40 * 24 * 3600 * 1000 })) // 40 days ago
    const daily = await store.getDailyAggregates(7)
    expect(daily).toHaveLength(1)
  })
})

describe('themes', () => {
  it('counts theme occurrences, sorted desc', async () => {
    store.recordUsage(entry({ ts: Date.now(), themes: ['housing', 'affordable'] }))
    store.recordUsage(entry({ ts: Date.now(), themes: ['housing'] }))
    const themes = await store.getThemeCounts(30)
    expect(themes[0]).toEqual({ theme: 'housing', count: 2 })
    expect(themes.find(t => t.theme === 'affordable')?.count).toBe(1)
  })
})

describe('recent', () => {
  it('returns newest first with total tokens', async () => {
    store.recordUsage(entry({ ts: 1000, inputTokens: 10, outputTokens: 5 }))
    store.recordUsage(entry({ ts: 2000, inputTokens: 20, outputTokens: 5 }))
    const recent = await store.getRecent(10)
    expect(recent[0].ts).toBe(2000)
    expect(recent[0].totalTokens).toBe(25)
  })

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i++) store.recordUsage(entry({ ts: 1000 + i }))
    expect(await store.getRecent(3)).toHaveLength(3)
  })
})
