/**
 * Recent analyses (P6-4).
 *
 * Two different things are an "analysis" in this library and they are kept in
 * two different places: a **saved view** is a catalog document (a map view, a
 * table view, a comparison), and a **place report** is a cached JSON blob
 * indexed by the server. Both answer the same question for a reader on
 * `/analysis` — what has been run here lately, by whom — so this module folds
 * them into one shape and one ordering, and nothing else has to know there
 * were ever two lists.
 *
 * Every row opens in one press: a saved view through `/views/<slug>`, which is
 * the guarded shim that already knows whether a view restores on the map, in
 * the explorer or on /compare; a place report through its own `/place?…` URL,
 * which the report service answers from cache.
 */
import { placeUrlForKey, type PlaceReportRow } from './placeReport'
import type { SavedViewSummary, SavedViewType } from './views'

export type AnalysisKind = SavedViewType | 'place'

/** What each kind is called on screen. */
export const ANALYSIS_KIND_LABELS: Record<AnalysisKind, string> = {
  map: 'Map view',
  table: 'Table view',
  compare: 'Comparison',
  place: 'Place report',
}

export interface Analysis {
  /** Stable across both sources, so one list can be keyed. */
  key: string
  kind: AnalysisKind
  kindLabel: string
  title: string
  /** Where one press opens it. '' when we cannot work out where it lives. */
  href: string
  /** Who ran it, by username. '' when nothing recorded one. */
  by: string
  /** When it was run (ISO). */
  at: string
  /** The one line under the title. */
  line: string
}

/** What a place report actually turned up — the honest number for a list. */
export function foundLine(found: number, sources: number): string {
  if (sources <= 0) return 'No sources ran'
  return `${found} of ${sources} ${sources === 1 ? 'source' : 'sources'} found something`
}

export function analysisFromView(view: SavedViewSummary): Analysis {
  return {
    key: `view:${view.slug}`,
    kind: view.type,
    kindLabel: ANALYSIS_KIND_LABELS[view.type] ?? view.type,
    title: view.name,
    href: `/views/${encodeURIComponent(view.slug)}`,
    by: view.savedBy ?? '',
    at: view.savedAt ?? '',
    line: view.description ?? '',
  }
}

export function analysisFromReport(row: PlaceReportRow): Analysis {
  return {
    key: `place:${row.placeKey}`,
    kind: 'place',
    kindLabel: ANALYSIS_KIND_LABELS.place,
    title: row.label || row.placeKey,
    href: placeUrlForKey(row.placeKey),
    by: row.by ?? '',
    at: row.at ?? '',
    line: foundLine(row.found ?? 0, row.sources ?? 0),
  }
}

/**
 * Both kinds in one list, newest first.
 *
 * Anything with no time on it sorts last rather than to 1970 — a document
 * somebody hand-edited should not head the list of what just happened.
 */
export function recentAnalyses(
  views: SavedViewSummary[],
  reports: PlaceReportRow[],
  limit = 12,
): Analysis[] {
  const rows = [...views.map(analysisFromView), ...reports.map(analysisFromReport)]
  return rows
    .map((row, i) => ({ row, i, t: row.at ? Date.parse(row.at) : Number.NaN }))
    .sort((a, b) => {
      const at = Number.isFinite(a.t) ? a.t : -Infinity
      const bt = Number.isFinite(b.t) ? b.t : -Infinity
      return bt - at || a.i - b.i
    })
    .slice(0, Math.max(0, limit))
    .map(x => x.row)
}
