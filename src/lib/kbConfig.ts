/**
 * Operations-home config + activity feed (P5-40). Types mirror the server's
 * services/kbConfig.ts and services/libraryActivity.ts; keep in sync by hand
 * — the shapes are small and the server already validated them.
 */
import { internalFetch } from './apiBase'

export interface KbFact {
  label: string
  value: string
  href?: string
}

export interface KbNextStep {
  text: string
  href: string
}

export interface KbInitiative {
  name: string
  tagline: string
  facts: KbFact[]
  nextStep: KbNextStep | null
}

export interface KbLink {
  label: string
  href: string
}

export interface KbPinnedRef {
  slug: string
  kind: string
  title: string
  category: string
  description: string
  href: string
}

export interface KbConfig {
  homeSlug: string
  pinned: KbPinnedRef[]
  initiative: KbInitiative | null
  links: KbLink[]
}

/** Mirror of the server's defaults, used when the call fails. The landing is
 *  the front door: a missing config must degrade to the plain directory, not
 *  to an error page. */
export const KB_CONFIG_DEFAULTS: KbConfig = { homeSlug: 'home', pinned: [], initiative: null, links: [] }

export async function fetchKbConfig(): Promise<KbConfig> {
  try {
    const res = await internalFetch('/api/library/kb')
    if (!res.ok) return { ...KB_CONFIG_DEFAULTS }
    const body = await res.json()
    return {
      homeSlug: typeof body?.homeSlug === 'string' && body.homeSlug ? body.homeSlug : KB_CONFIG_DEFAULTS.homeSlug,
      pinned: Array.isArray(body?.pinned) ? (body.pinned as KbPinnedRef[]) : [],
      initiative: (body?.initiative as KbInitiative | null) ?? null,
      links: Array.isArray(body?.links) ? (body.links as KbLink[]) : [],
    }
  } catch {
    return { ...KB_CONFIG_DEFAULTS }
  }
}

export interface ActivityTarget {
  slug: string
  title: string
  kind: string
  href: string
}

export interface ActivityRow {
  at: string
  actor: string
  verb: string
  target: ActivityTarget | null
}

export const ACTIVITY_PAGE = 12
export const ACTIVITY_MORE = 50

/** Unlike the config, a failed activity call throws: the feed is its own
 *  panel and says so, rather than silently pretending nothing happened. */
export async function fetchActivity(limit: number = ACTIVITY_PAGE): Promise<ActivityRow[]> {
  const res = await internalFetch(`/api/library/activity?limit=${encodeURIComponent(String(limit))}`)
  if (!res.ok) throw new Error(`activity request failed (${res.status})`)
  const body = await res.json()
  return Array.isArray(body?.rows) ? (body.rows as ActivityRow[]) : []
}
