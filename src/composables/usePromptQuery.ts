/**
 * Phase 2 compatibility shim.
 *
 * The original usePromptQuery offered a one-shot /api/query call and auth
 * state. Phase 3 replaces the one-shot query with multi-turn chat via useChat.
 * Authentication moved to useAuth (module-level shared state).
 *
 * This file now re-exports the auth pieces for PromptInput.vue and keeps
 * the QueryResponse type for any lingering callers.
 */

import { useAuth } from '@/composables/useAuth'

export interface LayerSelection {
  layerId: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

export interface ScoringFilter {
  layerId: string
  operator: 'greater_than' | 'less_than' | 'between'
  value: number
  max?: number
}

export interface QueryResponse {
  layers: LayerSelection[]
  filters?: ScoringFilter[]
  limit?: number
  explanation: string
}

export function usePromptQuery() {
  const { isAuthenticated, authError, authenticate, clearAuth } = useAuth()
  return {
    isAuthenticated,
    error: authError,
    authenticate,
    signOut: () => clearAuth(),
  }
}
