/**
 * An unsaved index formula, kept across a page leave (P9-6a).
 *
 * The weight editor is a sandbox — nothing it does is written until somebody
 * names a version and saves it, which is the right default. But a formula
 * somebody spent five minutes dragging must not vanish because they clicked a
 * link, and this is the answer `PageEditor` already gives unfinished page
 * text: autosave it locally, restore it with a note saying what it is, and a
 * button that throws it away. No `window.confirm` — a browser dialog blocks
 * the page, cannot be styled, and reads nothing like the rest of the app
 * (`ChatThreadList`'s rule).
 *
 * A formula names internal layers, so a draft is internal residue: the prefix
 * is one `useAuth` wipes at logout (P5-19 — nothing internal survives).
 *
 * **Only the terms carrying weight are stored.** A term at zero is OUT of the
 * index, so a saved formula's term that the draft does not mention reads back
 * as zero — which is how `WorkingSetWorkspace` rebuilds the editor's rows.
 */
import type { CompositeTerm } from '@/lib/workingSets'

export const INDEX_DRAFT_PREFIX = 'blo:index-draft:'

/** One draft per index, not per set: two indices on the same set are two
 *  formulas, and editing one must not overwrite the other's draft. */
export function indexDraftKey(slug: string, columnId: string): string {
  return `${INDEX_DRAFT_PREFIX}${slug}:${columnId}`
}

/**
 * The stored formula, or null.
 *
 * Tolerant in exactly one direction, like `readColumn`: anything that is not a
 * list of complete terms reads as **null** — no draft, the saved index — never
 * as a half-formula that would put weights on screen nobody chose.
 */
export function readIndexDraft(slug: string, columnId: string): CompositeTerm[] | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(indexDraftKey(slug, columnId))
  } catch {
    return null // private mode — editing still works, just without a safety net
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.length) return null
    const terms: CompositeTerm[] = []
    for (const item of parsed) {
      const row = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
      const layer = typeof row.layer === 'string' ? row.layer.trim() : ''
      const weight = typeof row.weight === 'number' ? row.weight : NaN
      const direction = row.direction === 'lower_better' ? 'lower_better' : 'higher_better'
      if (!layer || !Number.isFinite(weight) || weight <= 0) return null
      terms.push({ layer, weight, direction })
    }
    return terms
  } catch {
    return null
  }
}

export function writeIndexDraft(slug: string, columnId: string, terms: readonly CompositeTerm[]): void {
  try {
    localStorage.setItem(indexDraftKey(slug, columnId), JSON.stringify(terms))
  } catch {
    // storage full or unavailable — never break a slider over a draft copy
  }
}

export function clearIndexDraft(slug: string, columnId: string): void {
  try {
    localStorage.removeItem(indexDraftKey(slug, columnId))
  } catch {
    /* nothing to clear */
  }
}
