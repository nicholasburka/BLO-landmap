/**
 * Pulling a page's documents into the entry, from the browser (P5-80).
 *
 * The server does everything that matters — the subset rule, the host guard,
 * the caps, the naming, the extraction — so this file is the API client and
 * the words a reader sees for each per-file outcome. Types mirror the route's
 * answer in server/src/routes/libraryIngest.ts.
 */
import { internalFetch } from './apiBase'
import { invalidateCatalogCache } from './libraryCatalog'

export type PullStatus = 'stored' | 'too-large' | 'unreachable' | 'not-a-document'

export interface PullResult {
  url: string
  status: PullStatus
  /** What it was stored as, when it was stored. */
  file?: string
  /** Why it was not, in the server's own words. */
  error?: string
}

/** What each outcome is called on the page. Plain, and never blaming the
 *  person who ticked the box. */
export const PULL_STATUS_TEXT: Record<PullStatus, string> = {
  stored: 'pulled in',
  'too-large': 'too large to pull in',
  unreachable: 'could not be reached',
  'not-a-document': 'was not a document',
}

/** Most documents in one pull — the server refuses more, so the panel does
 *  not offer more. Keep in sync with PULL_MAX_FILES on the server. */
export const PULL_MAX_FILES = 30

export const PULL_ERROR_FALLBACK = 'we could not pull those documents in. Try again in a moment.'

async function failureOf(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    /* not JSON — fall through to the generic sentence */
  }
  if (res.status === 429) return 'that was a lot at once. Wait a moment and try again.'
  if (res.status === 503) return 'the library is not available right now.'
  return PULL_ERROR_FALLBACK
}

/** Pull the chosen documents into the entry. The URLs must be ones the entry's
 *  own inspection found on the page; anything else is refused by the server. */
export async function pullDocuments(slug: string, urls: string[]): Promise<PullResult[]> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  })
  if (!res.ok) throw new Error(await failureOf(res))
  // The entry now holds files it did not hold a moment ago (P5-89).
  invalidateCatalogCache()
  const body = await res.json()
  return (body.results ?? []) as PullResult[]
}

/** "Pulled in 12 of 14." — the sentence under the button when it is done. */
export function pullSummary(results: PullResult[]): string {
  const stored = results.filter(r => r.status === 'stored').length
  if (!results.length) return ''
  if (stored === results.length) {
    return `Pulled in ${stored} document${stored === 1 ? '' : 's'}. They are under Files on this entry.`
  }
  if (stored === 0) return 'None of those could be pulled in — the reasons are below.'
  return `Pulled in ${stored} of ${results.length}. The rest are listed below with the reason.`
}
