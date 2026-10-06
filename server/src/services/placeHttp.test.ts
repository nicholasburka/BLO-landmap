import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  guardedGet,
  guardedJson,
  failureText,
  placeFetchMaxBytes,
  placeFetchTimeoutMs,
  PlaceFetchError,
  RATE_LIMIT_PER_MINUTE,
  resetRateLimits,
  takeRateToken,
} from './placeHttp.js'
import { publicLookup, jsonResponse } from '../testutils/fixtures/place/index.js'

/**
 * P5-57's one door to the outside world. The rules here are the reason a
 * hand-typed manifest URL and a typed address are safe to follow at all, so
 * each of them gets its own test.
 */

const privateLookup = async () => [{ address: '169.254.169.254', family: 4 }]

beforeEach(() => {
  resetRateLimits()
  delete process.env.PLACE_FETCH_MAX_BYTES
  delete process.env.PLACE_FETCH_TIMEOUT_MS
})
afterEach(() => {
  delete process.env.PLACE_FETCH_MAX_BYTES
  delete process.env.PLACE_FETCH_TIMEOUT_MS
})

describe('caps read from the environment', () => {
  it('defaults to 30 s and 25 MB, and takes an operator override', () => {
    expect(placeFetchTimeoutMs()).toBe(30_000)
    expect(placeFetchMaxBytes()).toBe(25 * 1024 * 1024)
    process.env.PLACE_FETCH_TIMEOUT_MS = '5000'
    process.env.PLACE_FETCH_MAX_BYTES = '1024'
    expect(placeFetchTimeoutMs()).toBe(5_000)
    expect(placeFetchMaxBytes()).toBe(1_024)
    // Nonsense falls back rather than disabling the cap.
    process.env.PLACE_FETCH_MAX_BYTES = 'lots'
    expect(placeFetchMaxBytes()).toBe(25 * 1024 * 1024)
  })
})

describe('the host guard, per hop', () => {
  it('refuses a host that resolves inside the network', async () => {
    const fetchImpl = vi.fn()
    await expect(
      guardedGet(new URL('https://metadata.example.com/x'), { fetchImpl: fetchImpl as any, lookup: privateLookup }),
    ).rejects.toMatchObject({ code: 'not-public' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('re-checks every redirect hop, so hop two cannot be the metadata service', async () => {
    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url)
      return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } })
    })
    const lookup = async (hostname: string) =>
      hostname === '169.254.169.254' ? [{ address: '169.254.169.254', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]
    await expect(
      guardedGet(new URL('https://data.example.gov/a'), { fetchImpl: fetchImpl as any, lookup: lookup as any }),
    ).rejects.toMatchObject({ code: 'not-public' })
    expect(seen).toEqual(['https://data.example.gov/a'])
  })

  it('stops a redirect chain that never ends', async () => {
    const fetchImpl = vi.fn(async (url: string) => new Response(null, { status: 302, headers: { location: `${url}/x` } }))
    await expect(
      guardedGet(new URL('https://data.example.gov/a'), { fetchImpl: fetchImpl as any, lookup: publicLookup as any }),
    ).rejects.toMatchObject({ code: 'too-many-redirects' })
  })

  it('refuses a scheme that is not http(s)', async () => {
    await expect(
      guardedGet(new URL('ftp://data.example.gov/a'), { fetchImpl: vi.fn() as any, lookup: publicLookup as any }),
    ).rejects.toMatchObject({ code: 'bad-scheme' })
  })
})

describe('the byte cap', () => {
  it('refuses on the declared length before a byte is read', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }),
    )
    await expect(
      guardedGet(new URL('https://data.example.gov/big.csv'), { fetchImpl: fetchImpl as any, lookup: publicLookup as any }),
    ).rejects.toMatchObject({ code: 'too-large' })
  })

  it('refuses on the bytes that actually arrive, when the header lied', async () => {
    const fetchImpl = vi.fn(async () => new Response('0123456789', { status: 200 }))
    await expect(
      guardedGet(new URL('https://data.example.gov/big.csv'), {
        fetchImpl: fetchImpl as any,
        lookup: publicLookup as any,
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: 'too-large' })
  })
})

describe('failures a reader can act on', () => {
  it('turns a refusal into words, and a bad status into http-error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    await expect(
      guardedGet(new URL('https://data.example.gov/a'), { fetchImpl: fetchImpl as any, lookup: publicLookup as any }),
    ).rejects.toMatchObject({ code: 'http-error' })
    expect(failureText('timeout')).toContain('too long')
    expect(failureText('manual-only')).toContain('by hand')
    expect(failureText('not-public')).toContain('public address')
  })

  it('reports a timeout as a timeout, not a network blip', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    })
    await expect(
      guardedGet(new URL('https://data.example.gov/a'), { fetchImpl: fetchImpl as any, lookup: publicLookup as any }),
    ).rejects.toMatchObject({ code: 'timeout' })
  })

  it('calls an HTML error page bad-response rather than crashing', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>down for maintenance</html>', { status: 200 }))
    await expect(
      guardedJson(new URL('https://data.example.gov/a'), { fetchImpl: fetchImpl as any, lookup: publicLookup as any }),
    ).rejects.toBeInstanceOf(PlaceFetchError)
  })
})

describe('the per-source rate limit', () => {
  it('lets a source through 30 times a minute and then holds it', () => {
    const now = Date.now()
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) expect(takeRateToken('epa-npl', now)).toBe(true)
    expect(takeRateToken('epa-npl', now)).toBe(false)
    // Another source has its own budget.
    expect(takeRateToken('fema-nfhl', now)).toBe(true)
    // And the window rolls.
    expect(takeRateToken('epa-npl', now + 61_000)).toBe(true)
  })

  it('refuses the request itself once the source is over its budget', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }))
    const options = { fetchImpl: fetchImpl as any, lookup: publicLookup as any, source: 'busy-source' }
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) await guardedGet(new URL('https://data.example.gov/a'), options)
    await expect(guardedGet(new URL('https://data.example.gov/a'), options)).rejects.toMatchObject({ code: 'rate-limited' })
    expect(fetchImpl).toHaveBeenCalledTimes(RATE_LIMIT_PER_MINUTE)
  })
})
