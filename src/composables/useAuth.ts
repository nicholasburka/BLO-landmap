/**
 * Shared authentication state.
 *
 * A single module-level ref so that usePromptQuery (for auth UI) and useChat
 * (which consumes the token) both observe the same authentication state.
 * When either detects a 401, clearing the token here updates the whole app.
 */

import { ref } from 'vue'

const TOKEN_KEY = 'blo-session-token'
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

// Module-level shared state
const isAuthenticated = ref(!!localStorage.getItem(TOKEN_KEY))
const authError = ref<string | null>(null)

export function useAuth() {
  function getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY)
  }

  function clearAuth(reason?: string): void {
    localStorage.removeItem(TOKEN_KEY)
    isAuthenticated.value = false
    if (reason) authError.value = reason
  }

  async function authenticate(password: string): Promise<boolean> {
    authError.value = null
    try {
      const res = await fetch(`${API_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        authError.value = 'Invalid password'
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

  return {
    isAuthenticated,
    authError,
    getToken,
    clearAuth,
    authenticate,
  }
}
