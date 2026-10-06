import { getFile, isBucketEnabled, listFiles, putFile } from './libraryBucket.js'
import { isLibraryEnabled, libraryQuery } from './libraryDb.js'
import { reportsDetachedWork } from './detachedWork.js'

/**
 * The index over the cached place reports (P6-4).
 *
 * A place report is one JSON blob per place under `library/derived/place/`,
 * and a big one: up to fifty sections with ten rows each. The Analysis page
 * wants six lines — the place, who ran it, when, and how much was found — so
 * reading every report to build that list would move tens of megabytes to
 * print a few hundred characters.
 *
 * So a small object beside them holds exactly those lines. It is written when
 * a report is stored and rebuilt from scratch at reindex, which is also how
 * a report that has expired or been deleted leaves the list.
 *
 * It lives at `library/derived/place-index.json` — deliberately OUTSIDE the
 * report prefix, so the rebuild's own walk cannot trip over it and it cannot
 * be mistaken for a place called "index". Like everything under
 * `library/derived/`, it is not a catalog kind and reindex walks past it.
 *
 * This module knows nothing about what a report contains beyond the three
 * fields below: the reader is handed in, so `placeReport.ts` keeps ownership
 * of the document shape and there is no import cycle between them.
 */

/** Where the index lives. */
export const PLACE_REPORT_INDEX_KEY = 'library/derived/place-index.json'

/** How many places the index remembers. The list shows a handful; this is the
 *  bound that keeps one object small however long the library runs. */
export const PLACE_REPORT_INDEX_MAX = 100

/** One line of "recent analyses". */
export interface PlaceReportIndexEntry {
  /** The report key — `g13121`, or `p33.7490_-84.3880_r5`. Reopens the cache. */
  placeKey: string
  /** What the report calls the place. */
  label: string
  /** Who ran it, by username. '' when nothing recorded it. */
  by: string
  /** When the report was generated (ISO). */
  at: string
  /** How many sources found something — the one honest number for a list. */
  found: number
  /** How many sources ran at all. */
  sources: number
}

/** As much of a stored report as the index reads. */
export interface StoredPlaceReport {
  place: { label: string }
  sections: { status: string }[]
  generatedAt: string
}

/** Reads one stored report, or null when it is gone or unreadable. */
export type StoredReportReader = (placeKey: string) => Promise<StoredPlaceReport | null>

function newestFirst(entries: PlaceReportIndexEntry[]): PlaceReportIndexEntry[] {
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
}

function isEntry(value: unknown): value is PlaceReportIndexEntry {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<PlaceReportIndexEntry>
  return typeof row.placeKey === 'string' && !!row.placeKey && typeof row.at === 'string'
}

/** The index as it stands. An index nobody has written yet is not an error —
 *  it is an empty list, and the next report (or reindex) writes one. */
export async function readPlaceReportIndex(): Promise<PlaceReportIndexEntry[]> {
  if (!isBucketEnabled()) return []
  try {
    const raw = await getFile(PLACE_REPORT_INDEX_KEY, { fresh: true })
    const doc = JSON.parse(raw.toString('utf8')) as { reports?: unknown }
    return Array.isArray(doc?.reports) ? doc.reports.filter(isEntry) : []
  } catch {
    return []
  }
}

async function writeIndex(entries: PlaceReportIndexEntry[]): Promise<void> {
  await putFile(PLACE_REPORT_INDEX_KEY, JSON.stringify({ reports: entries }), 'application/json')
}

/**
 * One writer at a time.
 *
 * Both paths below are read-modify-write over a single object: a report
 * stored while a reindex is walking the bucket would otherwise have the
 * rebuild write straight over its entry. Serialising them costs nothing —
 * the index is written once per report and once per reindex — and makes
 * `placeReportIndexSettled` a complete answer rather than a hopeful one.
 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  // A failed job must not poison the queue for the next one.
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Resolves when nothing is left to write.
 *
 * A reindex fires its hooks synchronously and ignores what they return, so
 * the rebuild runs detached; this is the only handle on it — for a test, or
 * for a CLI that pushes and then wants to print the list.
 */
export function placeReportIndexSettled(): Promise<void> {
  return queue.then(
    () => undefined,
    () => undefined,
  )
}

// P7-11: and the same handle, offered to the harness, so the suites that
// never heard of this module are not the ones its rebuild lands in.
reportsDetachedWork(placeReportIndexSettled)

/**
 * Remember that this report was just stored.
 *
 * One entry per place — running the same place again replaces the old line
 * rather than adding a second — and best-effort throughout: a report that was
 * cached but not indexed is a missing row on one list, and failing the
 * request over it would lose the whole report instead.
 */
export function recordPlaceReport(entry: PlaceReportIndexEntry): Promise<void> {
  if (!isBucketEnabled()) return Promise.resolve()
  return enqueue(async () => {
    try {
      const existing = await readPlaceReportIndex()
      const next = newestFirst([entry, ...existing.filter(e => e.placeKey !== entry.placeKey)]).slice(
        0,
        PLACE_REPORT_INDEX_MAX,
      )
      await writeIndex(next)
    } catch (err) {
      console.error(`[place-index] could not record ${entry.placeKey}:`, (err as Error)?.message || err)
    }
  })
}

/** The newest analyses, straight off the index — no report is opened. */
export async function listPlaceReports(limit = 20): Promise<PlaceReportIndexEntry[]> {
  const entries = await readPlaceReportIndex()
  return newestFirst(entries).slice(0, Math.max(0, limit))
}

/**
 * Who ran each place report, from the audit log.
 *
 * The stored report does not record its actor — it is the answer for a place,
 * not for a person — so a rebuild recovers the name from the `place.report`
 * audit rows, newest run per place key.
 *
 * It can come back empty for reasons that have nothing to do with who ran
 * what: the audit row has aged out, the report was run through MCP or the
 * chat (which write their own action and their own target, not a place key),
 * or there is no database to ask — which is every dev boot, where the store
 * is pg-mem and is wiped by the same restart that triggers the rebuild. So an
 * empty answer here means "not recovered", NOT "nobody". The caller keeps the
 * name the index already holds; see `walkAndWrite`.
 */
async function actorsByPlaceKey(): Promise<Map<string, string>> {
  const actors = new Map<string, string>()
  if (!isLibraryEnabled()) return actors
  try {
    const result = await libraryQuery(
      `SELECT target, actor FROM library_audit WHERE action = 'place.report' AND target IS NOT NULL ORDER BY created_at DESC, id DESC`,
    )
    for (const row of result.rows as { target: string; actor: string }[]) {
      if (!actors.has(row.target)) actors.set(row.target, row.actor)
    }
  } catch (err) {
    console.warn(`[place-index] could not read the audit log: ${(err as Error)?.message || err}`)
  }
  return actors
}

/**
 * Build the index again from the reports the bucket actually holds.
 *
 * Run at reindex, which is the moment the file tree is the truth: a report
 * that has been deleted leaves the list here, and one that was written by
 * some path that never recorded an entry joins it.
 */
export function rebuildPlaceReportIndex(
  prefix: string,
  read: StoredReportReader,
): Promise<PlaceReportIndexEntry[]> {
  if (!isBucketEnabled()) return Promise.resolve([])
  return enqueue(() => walkAndWrite(prefix, read))
}

async function walkAndWrite(prefix: string, read: StoredReportReader): Promise<PlaceReportIndexEntry[]> {
  if (!isBucketEnabled()) return []
  const files = await listFiles(prefix)
  const actors = await actorsByPlaceKey()
  // P6-27: what the index already says, so the rebuild can ADD to it rather
  // than replace it. The walk owns everything derived from the report file —
  // the label, the date, the tallies — but "who" is not in the report, so the
  // only copy of it is the entry the live write path already stored. Taking
  // `actors.get(placeKey) ?? ''` and writing the whole object over the top
  // meant every reindex de-attributed every report the audit log could not
  // account for. One read, reused by the empty-library guard below; nothing
  // else can write the index while this runs (see `enqueue`).
  const stored = await readPlaceReportIndex()
  const storedBy = new Map(stored.map(entry => [entry.placeKey, entry.by]))
  const entries: PlaceReportIndexEntry[] = []
  for (const file of files) {
    if (!file.key.endsWith('.json')) continue
    const placeKey = file.key.slice(prefix.length, -'.json'.length)
    if (!placeKey || placeKey.includes('/')) continue
    let report: StoredPlaceReport | null = null
    try {
      report = await read(placeKey)
    } catch {
      report = null
    }
    if (!report || !Array.isArray(report.sections)) continue
    entries.push({
      placeKey,
      label: report.place?.label ?? placeKey,
      // The audit log first (it knows the newest run), then what we already
      // had, and only then a blank — a blank is "nobody recorded it", which
      // the list says by showing the date alone.
      by: actors.get(placeKey) || storedBy.get(placeKey) || '',
      at: report.generatedAt ?? '',
      found: report.sections.filter(s => s.status === 'found').length,
      sources: report.sections.length,
    })
  }
  const next = newestFirst(entries).slice(0, PLACE_REPORT_INDEX_MAX)
  // A library with no place reports in it — which is most of them, and every
  // one before somebody runs the first — should not have an object written
  // saying so at every reindex. Nothing to say, nothing written.
  if (next.length === 0 && stored.length === 0) return next
  await writeIndex(next)
  return next
}
