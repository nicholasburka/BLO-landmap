import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Internal-session state transitions (phase 5, P5-4), with fetch mocked.
 *
 * useAuth fires two requests on module load (anonymous POST /api/session
 * and internal GET /api/me boot hydration), so every test installs its
 * fetch mock first, then dynamically imports a fresh module instance.
 */

type RouteHandler = (init?: RequestInit) => { status: number; body?: unknown }

function installFetchMock(routes: Record<string, RouteHandler>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const path = new URL(url).pathname
      const handler = routes[path]
      if (!handler) throw new Error(`unmocked fetch: ${path}`)
      const { status, body } = handler(init)
      return new Response(body === undefined ? null : JSON.stringify(body), { status })
    }),
  )
  return calls
}

async function freshUseAuth() {
  vi.resetModules()
  const mod = await import('../useAuth')
  return mod.useAuth()
}

// The anonymous session mint runs on every module load — keep it happy.
const anonSession: Record<string, RouteHandler> = {
  '/api/session': () => ({ status: 200, body: { token: 'anon-token' } }),
}

beforeEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('boot hydration', () => {
  it('a 200 from /api/me hydrates internalUser silently', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => ({
        status: 200,
        body: { username: 'nick', role: 'internal', csrfToken: 'csrf-1' },
      }),
    })
    const auth = await freshUseAuth()
    await auth.internalAuthReady
    expect(auth.internalUser.value).toEqual({ username: 'nick', role: 'internal' })
  })

  it('a 401 from /api/me means logged out — no error, no user', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => ({ status: 401, body: { error: 'unauthorized' } }),
    })
    const auth = await freshUseAuth()
    await auth.internalAuthReady
    expect(auth.internalUser.value).toBeNull()
  })

  it('a network failure on /api/me also means logged out', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => {
        throw new Error('network down')
      },
    })
    const auth = await freshUseAuth()
    await auth.internalAuthReady
    expect(auth.internalUser.value).toBeNull()
  })
})

describe('loginInternal', () => {
  it('success sets internalUser and wires the CSRF token onto mutating calls', async () => {
    let signedIn = false
    const calls = installFetchMock({
      ...anonSession,
      // 401 until the login lands, then 200: the post-login check must see the cookie.
      '/api/me': () => (signedIn ? { status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } } : { status: 401 }),
      '/api/login': () => {
        signedIn = true
        return { status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } }
      },
      '/api/logout': () => ({ status: 204 }),
    })
    const auth = await freshUseAuth()
    await auth.internalAuthReady

    const result = await auth.loginInternal('nick', 'hunter2hunter2')
    expect(result.ok).toBe(true)
    expect(auth.internalUser.value).toEqual({ username: 'nick', role: 'internal' })

    const loginCall = calls.find(c => c.url.endsWith('/api/login'))!
    expect(loginCall.init?.credentials).toBe('include')

    // The very next mutating call must carry the CSRF header from login.
    await auth.logoutInternal()
    const logoutCall = calls.find(c => c.url.endsWith('/api/logout'))!
    expect(new Headers(logoutCall.init?.headers).get('X-CSRF-Token')).toBe('csrf-abc')
  })

  it('a login the browser did not keep (Safari, third-party cookie) is reported, not celebrated', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => ({ status: 401 }),
      '/api/login': () => ({ status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } }),
    })
    const auth = await freshUseAuth()
    await auth.internalAuthReady
    const result = await auth.loginInternal('nick', 'hunter2hunter2')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/did not keep the session cookie/)
    expect(auth.internalUser.value).toBeNull()
  })

  it('a 401 yields exactly "Invalid credentials" and leaves the user logged out', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => ({ status: 401 }),
      '/api/login': () => ({ status: 401, body: { error: 'unauthorized' } }),
    })
    const auth = await freshUseAuth()
    const result = await auth.loginInternal('nick', 'wrong')
    expect(result).toEqual({ ok: false, error: 'Invalid credentials' })
    expect(auth.internalUser.value).toBeNull()
  })

  it('a 429 surfaces the rate-limit message', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => ({ status: 401 }),
      '/api/login': () => ({ status: 429, body: { error: 'Too many attempts' } }),
    })
    const auth = await freshUseAuth()
    const result = await auth.loginInternal('nick', 'hunter2hunter2')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/too many attempts/i)
  })
})

describe('logoutInternal', () => {
  it('wipes internal residue from localStorage and runs registered hooks (P5-19 audit)', async () => {
    installFetchMock({
      ...anonSession,
      '/api/me': () => ({ status: 401 }),
      '/api/login': () => ({ status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } }),
      '/api/logout': () => ({ status: 204 }),
    })
    vi.resetModules()
    const mod = await import('../useAuth')
    const auth = mod.useAuth()
    const hook = vi.fn()
    mod.registerLogoutHook(hook)
    await auth.loginInternal('nick', 'hunter2hunter2')
    localStorage.setItem('blo:conversation', '{"thread":"names internal layers"}')
    localStorage.setItem('blo.dataset.hidden.organizations.data.csv', '["EIN"]')
    localStorage.setItem('blo:draft:tn-strategy', '# Unsaved page text') // P5-49 editor draft
    localStorage.setItem('blo:shortlist', '["47157"]') // P5-55 pending comparison shortlist
    localStorage.setItem('blo:welcome-dismissed', '1') // public preference — must survive
    await auth.logoutInternal()
    expect(localStorage.getItem('blo:conversation')).toBeNull()
    expect(localStorage.getItem('blo.dataset.hidden.organizations.data.csv')).toBeNull()
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBeNull()
    // Which counties someone is weighing is research too (P5-55).
    expect(localStorage.getItem('blo:shortlist')).toBeNull()
    expect(localStorage.getItem('blo:welcome-dismissed')).toBe('1')
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it('clears local state even when the network call fails', async () => {
    let signedIn = false
    installFetchMock({
      ...anonSession,
      // 401 until the login lands, then 200: the post-login check must see the cookie.
      '/api/me': () => (signedIn ? { status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } } : { status: 401 }),
      '/api/login': () => {
        signedIn = true
        return { status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } }
      },
      '/api/logout': () => {
        throw new Error('network down')
      },
    })
    const auth = await freshUseAuth()
    await auth.loginInternal('nick', 'hunter2hunter2')
    expect(auth.internalUser.value).not.toBeNull()
    await auth.logoutInternal()
    expect(auth.internalUser.value).toBeNull()
  })
})

describe('separation from the anonymous session', () => {
  it('internal auth never touches localStorage', async () => {
    let signedIn = false
    installFetchMock({
      ...anonSession,
      // 401 until the login lands, then 200: the post-login check must see the cookie.
      '/api/me': () => (signedIn ? { status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } } : { status: 401 }),
      '/api/login': () => {
        signedIn = true
        return { status: 200, body: { username: 'nick', role: 'internal', csrfToken: 'csrf-abc' } }
      },
    })
    const auth = await freshUseAuth()
    await auth.internalAuthReady
    await auth.loginInternal('nick', 'hunter2hunter2')
    // Only the anonymous session's keys — nothing internal persisted.
    expect(Object.keys(localStorage)).toEqual(
      expect.arrayContaining(['blo-session-token', 'blo-session-tier']),
    )
    expect(Object.keys(localStorage)).toHaveLength(2)
  })
})
