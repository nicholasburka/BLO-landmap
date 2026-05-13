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

const TOKEN_KEY = 'blo-session-token'
const TIER_KEY = 'blo-session-tier'
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

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
  }
}
