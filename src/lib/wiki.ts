/**
 * Client helpers for the internal wiki (P5-15).
 *
 * Pages live server-side as flat markdown files (`library/wiki/<slug>.md`);
 * the API is GET/PUT /api/wiki/:slug. PUT sends the RAW markdown body with a
 * text/markdown content type — not JSON — because the server parses wiki
 * bodies with a dedicated 1 MB text parser (the app-wide JSON limit is 64 KB).
 */

import { internalFetch } from './apiBase'
import { invalidateCatalogCache } from './libraryCatalog'

export interface WikiPage {
  slug: string
  title: string
  markdown: string
  /** When the server last stored this page. The editor holds on to it and
   *  echoes it back on save so a page that moved underneath is caught
   *  instead of silently overwritten (P5-49). */
  updatedAt?: string
}

export interface WikiSaveResult {
  slug: string
  title: string
  created: boolean
  /** The new baseline, so the editor can stay open and save again. */
  updatedAt?: string
}

/** The page moved on while this browser was editing it (server 412). Carries
 *  who moved it, when they did, and the sentence the editor shows. */
export class WikiConflictError extends Error {
  constructor(
    public readonly actor?: string,
    public readonly updatedAt?: string,
  ) {
    super(
      `This page changed while you were editing${actor ? ` (by ${actor})` : ''}. ` +
        'Reload to see the latest, or save anyway (overwrites).',
    )
    this.name = 'WikiConflictError'
  }
}

/** Mirrors the server's WIKI_MAX_BYTES (1 MB raw-text parser limit). */
export const WIKI_PAGE_MAX_BYTES = 1024 * 1024

/** Mirrors the server's WIKI_SLUG rule: /^[a-z0-9][a-z0-9-]{0,79}$/ */
const MAX_SLUG_LENGTH = 80

/**
 * Turn a human title into a server-valid slug: lowercase, ASCII letters,
 * digits, and single hyphens; capped at 80 chars. Returns '' when nothing
 * survives — callers must treat that as "ask for a different title".
 */
export function slugifyWikiTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD') // split accents off so é → e survives the strip
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '') // the length cap can leave a trailing hyphen
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // non-JSON body — fall through
  }
  return fallback
}

/** Fetch a wiki page. Returns null on 404 (page doesn't exist yet). */
export async function fetchWikiPage(slug: string): Promise<WikiPage | null> {
  const res = await internalFetch(`/api/wiki/${encodeURIComponent(slug)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load wiki page (${res.status})`))
  }
  return (await res.json()) as WikiPage
}

export interface WikiSaveOptions {
  /** The page's `updatedAt` when it was loaded. Sent as If-Unmodified-Since:
   *  the server refuses the save (412) if the page has moved on since. Leave
   *  it out to overwrite deliberately — that is the "save anyway" path. */
  ifUnmodifiedSince?: string
}

/** Create or update a wiki page. The server derives the title from the first # heading. */
export async function saveWikiPage(
  slug: string,
  markdown: string,
  options: WikiSaveOptions = {},
): Promise<WikiSaveResult> {
  if (new Blob([markdown]).size > WIKI_PAGE_MAX_BYTES) {
    throw new Error('This page is too large: wiki pages are limited to 1 MB of markdown')
  }
  const headers: Record<string, string> = { 'Content-Type': 'text/markdown' }
  if (options.ifUnmodifiedSince) headers['If-Unmodified-Since'] = options.ifUnmodifiedSince
  const res = await internalFetch(`/api/wiki/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers,
    body: markdown,
  })
  if (res.status === 412) {
    const body = await res.json().catch(() => ({}))
    throw new WikiConflictError(
      typeof body?.actor === 'string' ? body.actor : undefined,
      typeof body?.updatedAt === 'string' ? body.updatedAt : undefined,
    )
  }
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to save wiki page (${res.status})`))
  }
  // A wiki page is a catalog row too, and saving one rewrites the `mentionedBy`
  // lists of everything it links (P5-89). Here rather than at each caller: the
  // page editor, Ask and the place report all write through this function.
  invalidateCatalogCache()
  return (await res.json()) as WikiSaveResult
}
