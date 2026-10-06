/**
 * Keep / Edit / Clear on one remediated value (P6-34).
 *
 * The API client for `POST /api/library/catalog/:slug/verify`. The server does
 * everything that matters — the vocabulary gate, which manifest key carries a
 * topic, the audit — so this file is the call and the words a reader sees.
 */
import { internalFetch } from './apiBase'
import { invalidateCatalogCache, type CatalogEntry } from './libraryCatalog'
import type { FieldProvenance, RemediableField } from './provenance'

/** The three answers to "a model wrote this". */
export const VERIFY_ACTIONS = ['keep', 'edit', 'clear'] as const
export type VerifyAction = (typeof VERIFY_ACTIONS)[number]

/** What each action is called on the button, and what it does. */
export const VERIFY_LABELS: Record<VerifyAction, string> = {
  keep: 'Keep',
  edit: 'Edit',
  clear: 'Clear',
}

export const VERIFY_ERROR_FALLBACK = 'that did not save. Try again in a moment.'

async function failureOf(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    /* not JSON — fall through to the generic sentence */
  }
  if (res.status === 429) return 'that was a lot at once. Wait a moment and try again.'
  if (res.status === 503) return 'the library is not available right now.'
  return VERIFY_ERROR_FALLBACK
}

export interface VerifyResult {
  entry: CatalogEntry | null
  provenance: Partial<Record<string, FieldProvenance>>
}

/**
 * Keep a model's value, replace it with your own, or clear it.
 *
 * `clear` returns the field to EMPTY, which puts the entry back on the
 * needs-a-look list — a rejected value must never silently stay.
 */
export async function verifyField(
  slug: string,
  field: RemediableField,
  action: VerifyAction,
  value?: string,
): Promise<VerifyResult> {
  const res = await internalFetch(`/api/library/catalog/${encodeURIComponent(slug)}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, action, ...(action === 'edit' ? { value: value ?? '' } : {}) }),
  })
  if (!res.ok) throw new Error(await failureOf(res))
  // The row's category, tags and provenance are all different from a moment
  // ago, and every list on the page reads them (P5-89).
  invalidateCatalogCache()
  const body = await res.json()
  return { entry: (body.entry ?? null) as CatalogEntry | null, provenance: body.provenance ?? {} }
}
