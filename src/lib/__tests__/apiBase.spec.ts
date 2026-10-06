import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  internalFetch,
  setInternalCsrfToken,
  setSessionExpiredHandler,
  resetSessionExpiry,
} from '../apiBase'

function respond(status: number): Response {
  return new Response(status === 204 ? null : '{}', { status })
}

const fetchMock = vi.fn<[RequestInfo | URL, RequestInit?], Promise<Response>>()
const redirects: string[] = []

function goTo(path: string): void {
  window.history.replaceState({}, '', path)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(respond(200))
  vi.stubGlobal('fetch', fetchMock)
  redirects.length = 0
  setSessionExpiredHandler(to => redirects.push(to))
  resetSessionExpiry()
  setInternalCsrfToken(null)
  goTo('/library?tab=data')
})

afterEach(() => {
  vi.unstubAllGlobals()
  setSessionExpiredHandler(null)
  goTo('/')
})

describe('internalFetch — a session that expires under the page (P5-72)', () => {
  it('sends the reader to login with the page they were on', async () => {
    fetchMock.mockResolvedValue(respond(401))
    const res = await internalFetch('/api/library/entries')

    // The caller still gets its response: nothing about its error path changes.
    expect(res.status).toBe(401)
    expect(redirects).toEqual(['/login?redirect=%2Flibrary%3Ftab%3Ddata'])
  })

  it('redirects once, however many requests were in flight', async () => {
    fetchMock.mockResolvedValue(respond(401))
    await Promise.all([
      internalFetch('/api/library/entries'),
      internalFetch('/api/wiki/home'),
      internalFetch('/api/activity'),
    ])
    expect(redirects).toHaveLength(1)
  })

  it('re-arms once the reader is back in, so a later expiry is caught too', async () => {
    fetchMock.mockResolvedValue(respond(401))
    await internalFetch('/api/library/entries')
    expect(redirects).toHaveLength(1)

    fetchMock.mockResolvedValue(respond(200))
    await internalFetch('/api/me')

    fetchMock.mockResolvedValue(respond(401))
    await internalFetch('/api/library/entries')
    expect(redirects).toHaveLength(2)
  })

  it('never redirects off the login page — that is the loop', async () => {
    goTo('/login?redirect=%2Flibrary')
    fetchMock.mockResolvedValue(respond(401))
    await internalFetch('/api/library/entries')
    expect(redirects).toEqual([])
  })

  it('never redirects on the boot question, or on logging in and out', async () => {
    fetchMock.mockResolvedValue(respond(401))
    // GET /api/me answering "nobody is logged in" is the whole point of the
    // call; /api/login's 401 is a wrong password.
    await internalFetch('/api/me')
    await internalFetch('/api/login', { method: 'POST' })
    await internalFetch('/api/logout', { method: 'POST' })
    expect(redirects).toEqual([])
  })

  it('leaves every other status alone', async () => {
    for (const status of [200, 403, 404, 429, 500]) {
      resetSessionExpiry()
      fetchMock.mockResolvedValue(respond(status))
      await internalFetch('/api/library/entries')
    }
    expect(redirects).toEqual([])
  })
})

describe('internalFetch — what it still does', () => {
  it('sends the session cookie and the CSRF token on a write', async () => {
    setInternalCsrfToken('token-abc')
    await internalFetch('/api/library/entries', { method: 'POST' })

    const [, init] = fetchMock.mock.calls[0]
    expect(init?.credentials).toBe('include')
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('token-abc')
  })

  it('leaves reads without a CSRF header', async () => {
    setInternalCsrfToken('token-abc')
    await internalFetch('/api/library/entries')
    const [, init] = fetchMock.mock.calls[0]
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBeNull()
  })
})
