import { ref, type Ref } from 'vue'

export interface LayerSelection {
  layerId: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

export interface QueryResponse {
  layers: LayerSelection[]
  explanation: string
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const TOKEN_KEY = 'blo-session-token'

export function usePromptQuery() {
  const isAuthenticated = ref(!!localStorage.getItem(TOKEN_KEY))
  const isLoading = ref(false)
  const error: Ref<string | null> = ref(null)
  const explanation: Ref<string | null> = ref(null)

  async function authenticate(password: string): Promise<boolean> {
    error.value = null
    try {
      const res = await fetch(`${API_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        error.value = 'Invalid password'
        return false
      }
      const data = await res.json()
      localStorage.setItem(TOKEN_KEY, data.token)
      isAuthenticated.value = true
      return true
    } catch {
      error.value = "Couldn't reach the server. Try again."
      return false
    }
  }

  async function submitQuery(prompt: string): Promise<QueryResponse | null> {
    error.value = null
    explanation.value = null
    isLoading.value = true

    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) {
      isAuthenticated.value = false
      error.value = 'Please sign in first'
      isLoading.value = false
      return null
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10000)

      const res = await fetch(`${API_URL}/api/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      })

      clearTimeout(timeout)

      if (res.status === 401) {
        localStorage.removeItem(TOKEN_KEY)
        isAuthenticated.value = false
        error.value = 'Session expired. Please sign in again.'
        isLoading.value = false
        return null
      }

      if (res.status === 429) {
        error.value = 'Too many requests. Please wait a moment.'
        isLoading.value = false
        return null
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        error.value = data.error || 'Something went wrong. Try again.'
        isLoading.value = false
        return null
      }

      const data: QueryResponse = await res.json()
      explanation.value = data.explanation
      isLoading.value = false
      return data
    } catch (err: any) {
      if (err.name === 'AbortError') {
        error.value = 'Request timed out. Try a shorter query.'
      } else {
        error.value = "Couldn't reach the server. Try again."
      }
      isLoading.value = false
      return null
    }
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY)
    isAuthenticated.value = false
  }

  return {
    isAuthenticated,
    isLoading,
    error,
    explanation,
    authenticate,
    submitQuery,
    signOut,
  }
}
