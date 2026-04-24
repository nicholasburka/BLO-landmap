/**
 * Shared session state.
 *
 * Silent auto-session: on first page load (or whenever the stored token is
 * missing/expired), the client posts to /api/session and stores an anonymous
 * HMAC-signed token. No password UI anymore. The token still exists so the
 * server's rate-limit + daily-budget middleware can track per-session usage
 * and so the Anthropic key stays server-side.
 *
 * The legacy /api/auth password endpoint is still mounted server-side for
 * backwards compat; old tokens in localStorage continue to work until expiry.
 */

import { ref } from 'vue'

const TOKEN_KEY = 'blo-session-token'
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Module-level shared state
const isAuthenticated = ref(!!localStorage.getItem(TOKEN_KEY))
const authError = ref<string | null>(null)

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
    isAuthenticated.value = true
    authError.value = null
    return true
  } catch {
    authError.value = "Couldn't reach the server. Try again."
    return false
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
    isAuthenticated.value = false
    if (reason) authError.value = reason
    // Immediately re-mint a fresh session so the user isn't left stuck
    void ensureSession()
  }

  return {
    isAuthenticated,
    authError,
    getToken,
    clearAuth,
    ensureSession,
  }
}
