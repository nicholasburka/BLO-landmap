import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MIN_QUERY, cachedAddresses, clearAddressCache, suggestAddresses } from '@/lib/addressSearch'

/**
 * Address suggestions (P9-11).
 *
 * Mapbox is metered, so what is under test is the restraint: when a request
 * is NOT made, and that an answer already known is never bought twice.
 * Monitoring is the server's job (`/api/geocode/suggest` is a path
 * `recordUsage` counts); spending less in the first place is this file's.
 */

const reply = (hits: unknown[], extra: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({ hits, ...extra }),
})

const HIT = { name: '1 Main St, Memphis, Tennessee, United States', center: [-90.05, 35.1] }

let fetchMock: ReturnType<typeof vi.fn<[input: unknown, init?: unknown], Promise<Response>>>

beforeEach(() => {
  clearAddressCache()
  fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => reply([HIT]) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('address suggestions', () => {
  it('asks for nothing below the minimum query length', async () => {
    for (const tooShort of ['', ' ', '1', '12', '123']) {
      expect((await suggestAddresses(tooShort)).hits).toEqual([])
    }
    expect('1234'.length).toBe(MIN_QUERY)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks once, then answers from memory', async () => {
    const first = await suggestAddresses('1 Main St Memphis')
    expect(first.hits).toEqual([{ name: HIT.name, center: [-90.05, 35.1] }])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await suggestAddresses('1 Main St Memphis')
    // Backspacing and retyping the same thing is free.
    await suggestAddresses('  1 MAIN   st memphis ')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('offers what it already knows without a request at all', async () => {
    expect(cachedAddresses('1 Main St Memphis')).toBeNull()
    await suggestAddresses('1 Main St Memphis')
    expect(cachedAddresses('1 Main St Memphis')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('goes through OUR api, so the calls can be counted', async () => {
    // The point of the proxy. It buys no secrecy — the same token is in the
    // bundle for map tiles — it buys a path `recordUsage` keys on.
    await suggestAddresses('1 Main St Memphis')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/api/geocode/suggest')
    expect(url).toContain('q=1%20main%20st%20memphis')
    expect(url).not.toContain('api.mapbox.com')
    expect(url).not.toContain('access_token')
  })

  it('tells "not switched on" apart from "not found"', async () => {
    fetchMock.mockResolvedValueOnce(reply([], { unavailable: true }) as unknown as Response)
    const answer = await suggestAddresses('1 Main St Memphis')
    expect(answer).toEqual({ hits: [], unavailable: true })
    // And an unconfigured server is not cached as "nothing here" forever.
    expect(cachedAddresses('1 Main St Memphis')).toBeNull()
  })

  it('drops a result with no usable coordinates rather than placing it at 0,0', async () => {
    fetchMock.mockResolvedValueOnce(
      reply([{ name: 'Nowhere', center: ['x', 'y'] }, HIT]) as unknown as Response,
    )
    expect((await suggestAddresses('somewhere odd')).hits).toEqual([
      { name: HIT.name, center: [-90.05, 35.1] },
    ])
  })

  it('finds nothing rather than exploding when the network does', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect((await suggestAddresses('1 Main St Memphis')).hits).toEqual([])
    // And a failure is not cached as an answer.
    expect(cachedAddresses('1 Main St Memphis')).toBeNull()
  })

  it('finds nothing when the service refuses', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
    expect((await suggestAddresses('1 Main St Memphis')).hits).toEqual([])
  })
})
