/**
 * Browsing one list of things under one of several groupings (P6-3, P6-4).
 *
 * The datasets browser and the docs browser ask the same question of
 * different rows: "put these under headings, count each heading, and let me
 * narrow the list by a word and a few chips, with every choice in the URL so
 * the result is a link". That question is answered here once, in plain
 * functions with no Vue in them, and drawn once by
 * `components/browse/GroupedList.vue`.
 *
 * Nothing here knows what a dataset or a document is. A caller hands in rows
 * and a `keyOf` that says which heading a row belongs under; the labels come
 * from the caller's vocabulary (the taxonomy, the organizations, the kinds),
 * so a heading reads in the same words as the chip that filters to it.
 */

/** Which heading a row belongs under, and what that heading is called. */
export interface GroupKey {
  /** The value, as it travels in a URL. '' means the row has none. */
  id: string
  /** Plain words for the heading — including the words for having none. */
  label: string
}

/** One heading with its rows. */
export interface BrowseGroup<T> {
  id: string
  label: string
  count: number
  rows: T[]
}

/** One chip: a value, its words, and how many rows carry it. */
export interface Facet {
  id: string
  label: string
  count: number
}

/**
 * How a caller says which value(s) a row carries.
 *
 * One `GroupKey` for the ordinary case — a row has one publisher, one topic,
 * one shape. A LIST for a facet a row can be under more than one of at once:
 * P6-19's coverage, where a table whose rows are in four states belongs under
 * all four state chips, because "what do we hold for Georgia?" has to find it.
 *
 * Only the chips take a list. A GROUPING stays one key per row — a row that
 * appeared under four headings would be counted four times in a list of
 * twelve — so `groupRows` asks for a single key and a caller that chips by
 * several values heads its groups with the one that reads best.
 */
export type FacetKeyOf<T> = (row: T) => GroupKey | GroupKey[]

/** A row's facet values as a list, with repeats dropped: counting one row
 *  twice under the same chip would make a chip bigger than the list. */
function keysOf<T>(row: T, keyOf: FacetKeyOf<T>): GroupKey[] {
  const key = keyOf(row)
  if (!Array.isArray(key)) return [key]
  const seen = new Set<string>()
  return key.filter(k => !seen.has(k.id) && (seen.add(k.id), true))
}

/**
 * By count, then by name, with the "has none of these" value pinned last.
 *
 * Shared by the groupings and the chips so a heading and the chip that filters
 * to it cannot come out in different orders.
 */
function byCountThenName(a: Facet | BrowseGroup<unknown>, b: Facet | BrowseGroup<unknown>): number {
  if (!a.id !== !b.id) return a.id ? -1 : 1
  return b.count - a.count || a.label.localeCompare(b.label)
}

/**
 * Rows under headings, counted.
 *
 * Order is the spec's: **by count, then by name**. The one exception is the
 * group for rows that carry no value at all ("No organization", "No topic"),
 * which is pinned last however big it is — it is housekeeping rather than a
 * publisher or a subject, the same reading the library list's "No topic"
 * facet button already takes.
 *
 * Inside a group the incoming order is kept, so a caller that sorted its rows
 * (docs: recently updated first) keeps that sort.
 */
export function groupRows<T>(rows: readonly T[], keyOf: (row: T) => GroupKey): BrowseGroup<T>[] {
  const groups = new Map<string, BrowseGroup<T>>()
  for (const row of rows) {
    const key = keyOf(row)
    let group = groups.get(key.id)
    if (!group) {
      group = { id: key.id, label: key.label, count: 0, rows: [] }
      groups.set(key.id, group)
    }
    group.rows.push(row)
    group.count += 1
  }
  return [...groups.values()].sort(byCountThenName)
}

/**
 * The same counts, in the same order, without carrying the rows — the chips.
 *
 * Counts each VALUE rather than each row, which is the one way this differs
 * from `groupRows`: a row carrying four states adds one to each of four
 * chips, so the chips can total more than the list they describe. That is
 * correct for a chip ("4 here") and would be wrong for a heading.
 */
export function facetsOf<T>(rows: readonly T[], keyOf: FacetKeyOf<T>): Facet[] {
  const counts = new Map<string, Facet>()
  for (const row of rows) {
    for (const key of keysOf(row, keyOf)) {
      const facet = counts.get(key.id)
      if (facet) facet.count += 1
      else counts.set(key.id, { id: key.id, label: key.label, count: 1 })
    }
  }
  return [...counts.values()].sort(byCountThenName)
}

/**
 * The chips for one filter row: counted off `filtered` (the rows the OTHER
 * filters have left), but **always containing the value that is currently
 * chosen** (P6-22).
 *
 * Counting off the other filters is deliberate — a chip must never promise
 * rows that are not there. The cost, left alone, is that choosing a value
 * whose combination matches nothing erases its own chip: the only thing that
 * said what you had narrowed to, and the only way to un-narrow it, both
 * vanish, and the page offers a count that its own "nothing matches" line
 * contradicts. `SearchView` already guards this; the two browsers did not, so
 * the rule lives here now and all three share it.
 *
 * The missing chip is re-inserted at its **true** count of 0, with its real
 * label read from `all` — the unfiltered rows still know what `usda-nass` is
 * called, even when nothing currently matches it.
 */
export function facetsFor<T>(
  all: readonly T[],
  filtered: readonly T[],
  keyOf: FacetKeyOf<T>,
  active: string,
): Facet[] {
  const facets = facetsOf(filtered, keyOf)
  if (!active || facets.some(facet => (facet.id || NONE_VALUE) === active)) return facets
  const id = active === NONE_VALUE ? '' : active
  // The label comes from the whole set; if even that has never seen the value
  // (a stale URL naming a publisher nobody holds any more) the value itself is
  // the honest label — it is what the person asked for.
  const known = facetsOf(all, keyOf).find(facet => (facet.id || NONE_VALUE) === active)
  return [{ id, label: known?.label ?? active, count: 0 }, ...facets]
}

/**
 * The chip for "has none of these" — a dataset nobody has given a publisher,
 * a document nobody has said what is for.
 *
 * A filter key holds either a value or this word, because '' already means
 * "not filtered at all". `none` is the word the catalog's own `plan=none`
 * already uses for the same question, so a reader meeting it in one URL has
 * met it in the other. (A publisher whose own name is the word "none" would
 * collide; nothing in the vocabulary is, and a group headed "none" would be a
 * thing to fix in the manifest rather than to work around here.)
 */
export const NONE_VALUE = 'none'

/** Does a row's value pass one chip? '' is every row; `none` is the rows with
 *  no value at all; anything else is an exact match. */
export function matchesFilter(value: string, filter: string): boolean {
  if (!filter) return true
  if (filter === NONE_VALUE) return !value
  return value === filter
}

/**
 * The same question of a row carrying SEVERAL values (P6-19).
 *
 * `matchesFilter` over any one of them, which is what makes a chip's count and
 * the list it opens the same set: both read the row's values through one
 * function. A row with no values at all answers `none`, exactly as an empty
 * string does in the single-valued case.
 */
export function matchesAnyFilter(values: readonly string[], filter: string): boolean {
  if (!filter) return true
  if (!values.length) return matchesFilter('', filter)
  return values.some(value => matchesFilter(value, filter))
}

/**
 * The catalog's own search rule (P5-84), applied client-side: every word must
 * be found somewhere in the row's text, in any order, rather than the whole
 * phrase in one field. "georgia landowner" finds "TELE landowner profiles —
 * Georgia"; "georgia alabama" finds nothing.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = haystack.toLowerCase()
  return words.every(word => text.includes(word))
}

/**
 * The grouping choice, remembered per browser.
 *
 * Storage can throw outright — a private window, a browser set to block site
 * data — so both halves swallow everything. A remembered choice is a
 * convenience; losing it must never be an error on the page.
 */
export function readStoredChoice(key: string, allowed: readonly string[], fallback: string): string {
  try {
    const stored = localStorage.getItem(key) ?? ''
    return allowed.includes(stored) ? stored : fallback
  } catch {
    return fallback
  }
}

export function writeStoredChoice(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* nothing to do: the page works without the memory */
  }
}

/**
 * Which grouping to draw: **the URL wins when it names one**, so a link
 * someone was sent opens the way they meant it to; otherwise what this
 * browser remembers; otherwise the default.
 *
 * Reading a link does NOT overwrite the memory — only pressing the control
 * does (the view writes it there). A colleague's link is a visit, not a
 * change of mind.
 */
export function resolveChoice(fromUrl: string, stored: string, allowed: readonly string[], fallback: string): string {
  if (allowed.includes(fromUrl)) return fromUrl
  if (allowed.includes(stored)) return stored
  return fallback
}

/** One trimmed string out of a route query — the first, when a key repeats. */
export function queryValue(query: Record<string, unknown>, key: string): string {
  const raw = query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}

/** The query to write back: only the keys that hold something, so a browser
 *  with nothing narrowed has a bare URL and its link says as much. */
export function browseQuery(state: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(state)) {
    const trimmed = value?.trim()
    if (trimmed) out[key] = trimmed
  }
  return out
}
