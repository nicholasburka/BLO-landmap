import { libraryQuery } from './libraryDb.js'
import { entryHref } from './kbConfig.js'

/**
 * The activity feed behind the operations home (P5-40).
 *
 * `library_audit` is a security log first: it records logins, failed logins,
 * and account administration alongside library work. The feed is a DISPLAY
 * surface, so it works from an explicit allowlist — an action nobody mapped
 * to a verb simply never appears. That way a new audit action (say, a future
 * `user.impersonate`) cannot leak onto the landing page by default.
 */

/** action → the verb the feed prints after the actor's name. This map IS the
 *  allowlist: `login.success`, `login.failure`, `logout`, and every `user.*`
 *  action are absent on purpose. */
export const ACTIVITY_VERBS: Readonly<Record<string, string>> = Object.freeze({
  'library.upload': 'uploaded',
  'library.link': 'dropped the link',
  'library.file': 'filed',
  'library.note': 'wrote the note',
  'library.note.update': 'updated the note',
  'library.download': 'downloaded',
  'library.export': 'exported',
  // P5-47 / P5-57: a link's file arriving, and a slice of an outside source
  // fetched for a place, are both things a teammate wants to see happen.
  'library.fetch': 'fetched the file for',
  'source.fetch': 'fetched a place from',
  // P5-58: a whole place checked against every source at once. The target is
  // a place key, not a catalog slug, so the line reads on its own.
  'place.report': 'ran a place report',
  'library.push': 'pushed files from the command line',
  'catalog.reindex': 'reindexed the library',
  'wiki.create': 'created the page',
  'wiki.update': 'updated the page',
  'view.create': 'saved the map view',
})

export const ACTIVITY_LIMIT_DEFAULT = 12
export const ACTIVITY_LIMIT_MAX = 100

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

/** `?limit=` → a number we are willing to query with. Junk falls back to the
 *  default; out-of-range values clamp rather than 400, because a clamped feed
 *  is a better answer than an error page on the front door. */
export function activityLimit(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  if (!Number.isFinite(n)) return ACTIVITY_LIMIT_DEFAULT
  return Math.min(ACTIVITY_LIMIT_MAX, Math.max(1, Math.trunc(n)))
}

interface AuditRow {
  actor: string
  action: string
  target: string | null
  detail: unknown
  created_at: unknown
}

function detailOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      /* not JSON — treat as empty */
    }
  }
  return {}
}

/** How long a "via" label may be on the feed. A personal token's name is
 *  capped at 60 by the mint form and an OAuth client_name at its own limit;
 *  this is the display guard, not the validation. */
const VIA_MAX = 60

/**
 * The program a write came through, when it came through one (P5-52). MCP
 * writes stamp `detail.via` with the assistant's name — the registered OAuth
 * client_name, or a personal token's own name — and the feed prints it so
 * "maria wrote the note" and "maria wrote the note via ChatGPT" are visibly
 * different things. Work done in the browser has no `via` and reads as before.
 *
 * The value is a name somebody chose, so control characters and bidi marks
 * (which could reorder the rest of the line when rendered) come out first.
 */
export function viaLabel(detail: Record<string, unknown>): string | null {
  const raw = typeof detail.via === 'string' ? detail.via : ''
  const clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
  if (!clean) return null
  return clean.length > VIA_MAX ? `${clean.slice(0, VIA_MAX)}…` : clean
}

/** The catalog slug an audit row points at, or null. `target` is a slug for
 *  most actions but a BUCKET KEY for downloads (which carry the slug in
 *  `detail`), so detail wins and anything path-shaped is refused. */
function targetSlug(row: AuditRow): string | null {
  const detail = detailOf(row.detail)
  const fromDetail = typeof detail.slug === 'string' ? detail.slug.trim() : ''
  if (fromDetail) return fromDetail
  const target = typeof row.target === 'string' ? row.target.trim() : ''
  if (!target || target.includes('/')) return null
  return target
}

function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return new Date(0).toISOString()
}

/** Titles/kinds for a batch of slugs, in one query — the feed shows up to
 *  100 rows and per-row lookups would be 100 round trips. */
async function resolveTargets(slugs: string[]): Promise<Map<string, ActivityTarget>> {
  const found = new Map<string, ActivityTarget>()
  if (slugs.length === 0) return found
  const placeholders = slugs.map((_, i) => `$${i + 1}`).join(', ')
  const res = await libraryQuery(
    `SELECT slug, kind, title FROM library_catalog WHERE slug IN (${placeholders})`,
    slugs,
  )
  for (const row of res.rows as { slug: string; kind: string; title: string }[]) {
    found.set(row.slug, {
      slug: row.slug,
      title: row.title || row.slug,
      kind: row.kind,
      href: entryHref(row.kind, row.slug),
    })
  }
  return found
}

/** The most recent allowlisted audit rows, newest first, with targets
 *  resolved. A target that no longer exists in the catalog comes back null:
 *  the row still says what happened, but never links to a 404. */
export async function recentActivity(limit: number = ACTIVITY_LIMIT_DEFAULT): Promise<ActivityRow[]> {
  const actions = Object.keys(ACTIVITY_VERBS)
  const placeholders = actions.map((_, i) => `$${i + 1}`).join(', ')
  const res = await libraryQuery(
    `SELECT actor, action, target, detail, created_at
     FROM library_audit
     WHERE action IN (${placeholders})
     ORDER BY created_at DESC, id DESC
     LIMIT $${actions.length + 1}`,
    [...actions, limit],
  )
  const rows = res.rows as AuditRow[]
  const slugs = [...new Set(rows.map(targetSlug).filter((s): s is string => !!s))]
  const targets = await resolveTargets(slugs)
  return rows.map(row => {
    const slug = targetSlug(row)
    const via = viaLabel(detailOf(row.detail))
    return {
      at: isoTime(row.created_at),
      actor: row.actor,
      // The attribution rides in the verb rather than a new field so every
      // surface that already prints a feed line prints it, with no client
      // change: "maria wrote the note via ChatGPT".
      verb: via ? `${ACTIVITY_VERBS[row.action]} via ${via}` : ACTIVITY_VERBS[row.action],
      target: (slug && targets.get(slug)) || null,
    }
  })
}

/**
 * P6-5 "Recently edited", the landing's first block.
 *
 * A narrower allowlist than the feed's: only the actions that CHANGED
 * something a person can open. Downloads, exports, place reports, pushes and
 * reindexes are activity but not edits, and the landing asks "what did we
 * work on lately", not "what happened".
 */
export const EDIT_ACTIONS: readonly string[] = Object.freeze([
  'library.upload',
  'library.link',
  'library.file',
  'library.note',
  'library.note.update',
  'wiki.create',
  'wiki.update',
  'view.create',
])

/** A row of the landing's list: always an entry that still exists, because
 *  the whole row is a link. */
export interface EditRow {
  at: string
  actor: string
  target: ActivityTarget
}

export const RECENT_EDITS_LIMIT_DEFAULT = 12

/**
 * The last edit per entry, newest first.
 *
 * One row per entry rather than per audit line: three saves of the same page
 * in a row is one thing that changed, and a list of three identical titles
 * tells a reader nothing. The audit rows are read at a multiple of the limit
 * so that deduplication still has enough to fill the list.
 */
export async function recentEdits(limit: number = RECENT_EDITS_LIMIT_DEFAULT): Promise<EditRow[]> {
  const placeholders = EDIT_ACTIONS.map((_, i) => `$${i + 1}`).join(', ')
  const res = await libraryQuery(
    `SELECT actor, action, target, detail, created_at
     FROM library_audit
     WHERE action IN (${placeholders})
     ORDER BY created_at DESC, id DESC
     LIMIT $${EDIT_ACTIONS.length + 1}`,
    [...EDIT_ACTIONS, Math.min(ACTIVITY_LIMIT_MAX, limit * 5)],
  )
  const rows = res.rows as AuditRow[]
  const slugs = [...new Set(rows.map(targetSlug).filter((s): s is string => !!s))]
  const targets = await resolveTargets(slugs)
  const out: EditRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const slug = targetSlug(row)
    const target = slug ? targets.get(slug) : undefined
    // An entry that has since been deleted (or a row whose target is a bucket
    // key we refused) would be a link to a 404, so it is simply not an edit
    // this list can offer.
    if (!slug || !target || seen.has(slug)) continue
    seen.add(slug)
    out.push({ at: isoTime(row.created_at), actor: row.actor, target })
    if (out.length >= limit) break
  }
  return out
}
