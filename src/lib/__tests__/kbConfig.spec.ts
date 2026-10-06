import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'http://api.test',
}))

import { internalFetch } from '../apiBase'
import { fetchKbConfig, fetchActivity, KB_CONFIG_DEFAULTS } from '../kbConfig'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe('fetchKbConfig', () => {
  it('reads the config and fills in anything the server left out', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ homeSlug: 'front-door', pinned: [{ slug: 'a', kind: 'wiki', title: 'A', category: '', description: '', href: '/wiki/a' }] }))
    const cfg = await fetchKbConfig()
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/kb')
    expect(cfg.homeSlug).toBe('front-door')
    expect(cfg.pinned).toHaveLength(1)
    expect(cfg.initiative).toBeNull()
    expect(cfg.links).toEqual([])
  })

  it('falls back to defaults rather than breaking the landing when the call fails', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    expect(await fetchKbConfig()).toEqual(KB_CONFIG_DEFAULTS)
    mockedFetch.mockRejectedValue(new Error('offline'))
    expect(await fetchKbConfig()).toEqual(KB_CONFIG_DEFAULTS)
    expect(KB_CONFIG_DEFAULTS.homeSlug).toBe('home')
  })
})

describe('fetchActivity', () => {
  it('asks for the requested number of rows and returns them', async () => {
    const rows = [{ at: '2026-09-04T12:00:00.000Z', actor: 'maria', verb: 'uploaded', target: { slug: 'orgs', title: 'Organizations', kind: 'dataset', href: '/library/orgs' } }]
    mockedFetch.mockResolvedValue(jsonResponse({ limit: 50, rows }))
    expect(await fetchActivity(50)).toEqual(rows)
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/activity?limit=50')
  })

  it('defaults to 12 rows', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ limit: 12, rows: [] }))
    await fetchActivity()
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/activity?limit=12')
  })

  it('throws on a failed request so the feed can show its own error', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, 500))
    await expect(fetchActivity()).rejects.toThrow(/activity/i)
  })
})
