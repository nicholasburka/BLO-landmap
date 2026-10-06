/**
 * Shared session state.
 *
 * Default: anonymous auto-session. On first page load (or when the stored
 * token is missing/expired), POST /api/session mints an HMAC-signed token
 * with `normal` tier. Server's per-IP cap still applies.
 *
 * Optional upgrade: a PM with the staging password can POST it to
 * /api/auth to receive a `staging`-tier token, which bypasses the daily
 * cap. Used to share a single backend across prod + a staging Netlify
 * deploy without one set of testers eating the other's quota.
 */

import { ref } from 'vue'
import { API_URL, internalFetch, setInternalCsrfToken } from '@/lib/apiBase'

const TOKEN_KEY = 'blo-session-token'
const TIER_KEY = 'blo-session-tier'

// Module-level shared state
const isAuthenticated = ref(!!localStorage.getItem(TOKEN_KEY))
const authError = ref<string | null>(null)
/** Tier of the current session, mirroring the server-side AuthTier.
 *  'staging' = cap-bypassed. Persisted in localStorage alongside the
 *  token so a refresh doesn't drop the user back to normal tier. */
const sessionTier = ref<'normal' | 'staging'>(
  (localStorage.getItem(TIER_KEY) as 'normal' | 'staging') || 'normal',
)

/** Ensure we have a token; mint a new anonymous session if needed. */
async function ensureSession(): Promise<boolean> {
  if (localStorage.getItem(TOKEN_KEY)) {
    isAuthenticated.value = true
    return true
  }
  if (!API_URL) {
    // Misconfigured prod build (no VITE_API_URL) — apiBase already
    // logged the loud console error; don't fetch a dead localhost URL.
    authError.value = "AI features aren't configured on this deployment."
    return false
  }
  try {
    const res = await fetch(`${API_URL}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
      authError.value = "Couldn't start a session. Try refreshing."
      return false
    }
    const data = await res.json()
    localStorage.setItem(TOKEN_KEY, data.token)
    localStorage.setItem(TIER_KEY, 'normal')
    sessionTier.value = 'normal'
    isAuthenticated.value = true
    authError.value = null
    return true
  } catch {
    authError.value = "Couldn't reach the server. Try again."
    return false
  }
}

/** Upgrade the current session to staging tier by POSTing the staging
 *  password to /api/auth. Returns true on success; on failure the
 *  existing anonymous session is left untouched. */
async function upgradeWithPassword(password: string): Promise<{ ok: boolean; error?: string }> {
  if (!API_URL) {
    return { ok: false, error: "AI features aren't configured on this deployment." }
  }
  try {
    const res = await fetch(`${API_URL}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.status === 401) {
      return { ok: false, error: 'Invalid password.' }
    }
    if (!res.ok) {
      return { ok: false, error: "Couldn't verify the password. Try again." }
    }
    const data = await res.json() as { token: string; tier?: 'normal' | 'staging' }
    if (!data.token) return { ok: false, error: 'Server returned no token.' }
    localStorage.setItem(TOKEN_KEY, data.token)
    const tier = data.tier === 'staging' ? 'staging' : 'normal'
    localStorage.setItem(TIER_KEY, tier)
    sessionTier.value = tier
    isAuthenticated.value = true
    authError.value = null
    return { ok: true }
  } catch {
    return { ok: false, error: "Couldn't reach the server. Try again." }
  }
}

// ---------------------------------------------------------------------------
// Internal library session (phase 5). Entirely separate from the anonymous
// token above: the session travels in an httpOnly cookie the client never
// reads — the app only tracks "who am I" via GET /api/me. Nothing internal
// touches localStorage.
// ---------------------------------------------------------------------------

export interface InternalUser {
  username: string
  role: 'admin' | 'internal'
}

const internalUser = ref<InternalUser | null>(null)

/** Silent boot hydration: a 401 just means "not logged in". */
async function hydrateInternalUser(): Promise<void> {
  if (!API_URL) return
  try {
    const res = await internalFetch('/api/me')
    if (!res.ok) {
      internalUser.value = null
      return
    }
    const data = (await res.json()) as InternalUser & { csrfToken?: string }
    internalUser.value = { username: data.username, role: data.role }
    setInternalCsrfToken(data.csrfToken ?? null)
  } catch {
    internalUser.value = null
  }
}

/** Resolves when boot hydration has settled — the router guard awaits this
 *  so a direct load of an internal route doesn't misfire to /login. */
const internalAuthReady: Promise<void> = hydrateInternalUser()

async function loginInternal(
  username: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!API_URL) {
    return { ok: false, error: 'This deployment has no API configured.' }
  }
  try {
    const res = await internalFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (res.status === 401) return { ok: false, error: 'Invalid credentials' }
    if (res.status === 429) return { ok: false, error: 'Too many attempts. Try again later.' }
    if (!res.ok) return { ok: false, error: "Couldn't log in. Try again." }
    const data = (await res.json()) as InternalUser & { csrfToken: string }
    // The password was right — but did the browser keep the session cookie?
    // iOS Safari drops a third-party cookie outright when the API lives on a
    // different site from the page, and the failure used to look like a
    // login that silently went nowhere. Ask the API who we are before
    // saying "signed in".
    const me = await internalFetch('/api/me')
    if (!me.ok) {
      internalUser.value = null
      setInternalCsrfToken(null)
      return { ok: false, error: COOKIE_NOT_KEPT }
    }
    internalUser.value = { username: data.username, role: data.role }
    setInternalCsrfToken(data.csrfToken)
    return { ok: true }
  } catch {
    return { ok: false, error: "Couldn't reach the server. Try again." }
  }
}

/** Shown when the login succeeded but the next request came back signed out. */
export const COOKIE_NOT_KEPT =
  'Signed in, but your browser did not keep the session cookie. Safari blocks it while the API is on a different domain from this site — try Chrome, or wait for the api.blacklandownership.com address.'

/** Local state is cleared even if the network call fails — the server-side
 *  session still expires on its own. */
/** Modules that cache internal content register a cleanup here (the wiki
 *  embed cache, for one) so logout can wipe them without useAuth importing
 *  internal-only modules into the public bundle. */
const logoutHooks: Array<() => void> = []
export function registerLogoutHook(hook: () => void): void {
  logoutHooks.push(hook)
}

/** localStorage keys that hold internal residue: the chat thread (assistant
 *  text names internal layers) and per-dataset column preferences. Public
 *  preferences (welcome card, etc.) are left alone. */
const INTERNAL_STORAGE_PREFIXES = ['blo:conversation', 'blo.dataset.hidden.', 'blo:ask', 'blo:draft:', 'blo:shortlist']

function clearInternalLocalStorage(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && INTERNAL_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) doomed.push(key)
    }
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // storage unavailable (private mode) — nothing to clear
  }
}

/**
 * Everything a logout does in this browser, without telling the server.
 * Shared with the expired-session handler (P5-72): when the cookie has
 * already gone there is nothing to log out of, but the page is still holding
 * a username, a CSRF token and cached internal content.
 */
export function clearInternalSession(): void {
  internalUser.value = null
  setInternalCsrfToken(null)
  // P5-19 audit: nothing internal survives in this browser after logout.
  clearInternalLocalStorage()
  for (const hook of logoutHooks) {
    try {
      hook()
    } catch {
      // one failing hook must not block the others
    }
  }
}

async function logoutInternal(): Promise<void> {
  try {
    await internalFetch('/api/logout', { method: 'POST' })
  } catch {
    // ignore — clearing local state below is what matters to the UI
  }
  clearInternalSession()
}

// Kick off silent auto-session on module load
void ensureSession()

export function useAuth() {
  function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY)
  }

  function clearAuth(reason?: string): void {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(TIER_KEY)
    sessionTier.value = 'normal'
    isAuthenticated.value = false
    if (reason) authError.value = reason
    // Immediately re-mint a fresh session so the user isn't left stuck
    void ensureSession()
  }

  return {
    isAuthenticated,
    authError,
    sessionTier,
    getToken,
    clearAuth,
    ensureSession,
    upgradeWithPassword,
    // Internal library session (phase 5)
    internalUser,
    internalAuthReady,
    loginInternal,
    logoutInternal,
  }
}
