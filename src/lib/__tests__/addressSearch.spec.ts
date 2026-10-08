import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MIN_QUERY, cachedAddresses, clearAddressCache, suggestAddresses } from '@/lib/addressSearch'

/**
 * Address suggestions (P9-11).
 *
 * Mapbox is metered, so what is actually under test is the restraint: when a
 * request is NOT made, and that an answer already known is never bought
 * twice. Nick's "we should just remember to monitor that cost" is served by
 * spending less of it in the first place.
 */

const reply = (features: unknown[]) => ({
  ok: true,
  json: async () => ({ features }),
})

const HIT = { place_name: '1 Main St, Memphis, Tennessee, United States', center: [-90.05, 35.1] }

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
      expect(await suggestAddresses(tooShort)).toEqual([])
    }
    expect('1234'.length).toBe(MIN_QUERY)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('asks once, then answers from memory', async () => {
    const first = await suggestAddresses('1 Main St Memphis')
    expect(first).toEqual([{ name: HIT.place_name, center: [-90.05, 35.1] }])
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

  it('leads with addresses, which is the whole reason it is not the Census one', async () => {
    await suggestAddresses('1 Main St Memphis')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('types=address')
    expect(url).toContain('autocomplete=true')
    expect(url).toContain('country=us')
    expect(url).toMatch(/limit=\d/)
  })

  it('drops a result with no usable coordinates rather than placing it at 0,0', async () => {
    fetchMock.mockResolvedValueOnce(
      reply([{ place_name: 'Nowhere', center: ['x', 'y'] }, HIT]) as unknown as Response,
    )
    expect(await suggestAddresses('somewhere odd')).toEqual([
      { name: HIT.place_name, center: [-90.05, 35.1] },
    ])
  })

  it('finds nothing rather than exploding when the network does', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    expect(await suggestAddresses('1 Main St Memphis')).toEqual([])
    // And a failure is not cached as an answer.
    expect(cachedAddresses('1 Main St Memphis')).toBeNull()
  })

  it('finds nothing when the service refuses', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as unknown as Response)
    expect(await suggestAddresses('1 Main St Memphis')).toEqual([])
  })
})
