/**
 * "Recently edited" — the first block of the landing (P6-5, spec decision
 * "Recently edited").
 *
 * One short list, not two: the current user's last three, marked **yours**,
 * then the last few by anyone, with no second heading. Somebody coming back to
 * the knowledge base is nearly always coming back to their own half-finished
 * thing, and a new colleague — who has edited nothing — sees the same block
 * reading as "recently updated by anyone" with no empty state to explain.
 *
 * The catalog cannot answer this: `updatedAt` is the newest object in the
 * bucket with no name on it. The audit log has the name, so the rows come
 * from `GET /api/library/recent-edits` (one row per entry, edit actions only).
 */
import { internalFetch } from './apiBase'

export interface EditTarget {
  slug: string
  title: string
  kind: string
  href: string
}

export interface EditRow {
  /** ISO time of the last edit to this entry. */
  at: string
  /** Who made it, by username. */
  actor: string
  target: EditTarget
}

/** A row as the landing renders it. */
export interface RecentEdit extends EditRow {
  /** Whether to mark it "yours". */
  mine: boolean
}

/** How many of the person's own edits lead the list, and how long it gets. */
export const MINE_COUNT = 3
export const EDITS_TOTAL = 6

/** Asked for more rows than the list shows, because the first few may all be
 *  one person's and the "by anyone" half still has to find something. */
const FETCH_LIMIT = 24

function asTarget(value: unknown): EditTarget | null {
  if (!value || typeof value !== 'object') return null
  const t = value as Partial<EditTarget>
  if (typeof t.slug !== 'string' || !t.slug || typeof t.href !== 'string' || !t.href) return null
  return { slug: t.slug, title: typeof t.title === 'string' && t.title ? t.title : t.slug, kind: String(t.kind ?? ''), href: t.href }
}

/** Like the activity feed, a failed call throws: the block is its own panel
 *  and says so, rather than pretending the library has never been touched. */
export async function fetchRecentEdits(limit: number = FETCH_LIMIT): Promise<EditRow[]> {
  const res = await internalFetch(`/api/library/recent-edits?limit=${encodeURIComponent(String(limit))}`)
  if (!res.ok) throw new Error(`recent edits request failed (${res.status})`)
  const body = await res.json()
  const rows = Array.isArray(body?.rows) ? (body.rows as unknown[]) : []
  return rows
    .map(row => {
      const r = (row ?? {}) as Partial<EditRow>
      const target = asTarget(r.target)
      return target ? { at: String(r.at ?? ''), actor: String(r.actor ?? ''), target } : null
    })
    .filter((row): row is EditRow => row !== null)
}

/**
 * Mine first, then anyone — one list.
 *
 * The rows arrive newest first and already carry one row per entry, so the
 * only work here is the split. An entry the person edited most recently is
 * never repeated in the second half: it is the same thing, and seeing it
 * twice would read as two edits.
 */
export function recentlyEdited(
  rows: EditRow[],
  username: string | null | undefined,
  { mine = MINE_COUNT, total = EDITS_TOTAL }: { mine?: number; total?: number } = {},
): RecentEdit[] {
  const me = (username ?? '').trim()
  const ownRows = me ? rows.filter(row => row.actor === me).slice(0, mine) : []
  const taken = new Set(ownRows.map(row => row.target.slug))
  const others = rows.filter(row => !taken.has(row.target.slug)).slice(0, Math.max(0, total - ownRows.length))
  return [...ownRows.map(row => ({ ...row, mine: true })), ...others.map(row => ({ ...row, mine: false }))]
}
