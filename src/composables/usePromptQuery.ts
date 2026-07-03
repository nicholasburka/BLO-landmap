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
  // Optional to mirror mapTools.LayerSelection: the LLM path always supplies
  // a direction, but snapshot replay of UI-selected layers may not — the
  // scoring pipeline falls back to the layer registry's default.
  direction?: 'higher_better' | 'lower_better'
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
  const { isAuthenticated, authError, clearAuth } = useAuth()
  return {
    isAuthenticated,
    error: authError,
    signOut: () => clearAuth(),
  }
}
