/**
 * Chart shaping (P5-54) — the arithmetic behind the pictures, with no DOM in
 * sight. SummaryChart.vue draws whatever comes out of here, and the wiki
 * embed draws the same thing, so a chart looks identical wherever it appears.
 *
 * Every chart is built from a column summary the server already computed
 * (src/lib/libraryData.ts → ColumnSummary), because the summary describes the
 * CURRENT filtered set. Three shapes cover what a researcher asks of a
 * column: which values are most common (bars), how the numbers spread out
 * (histogram), and how the count moves over time (line).
 *
 * Labels are plain words on purpose: "Number of rows", not "count(*)".
 */

import { formatNumber, sharePct, type ColumnSummary } from './libraryData'

export type ChartKind = 'bars' | 'histogram' | 'line'

/** One bar or point, already labelled the way it will be drawn. */
export interface ChartPoint {
  /** The mark's name on the category axis ("Tier 1", "60 to 63", "Mar 2024"). */
  label: string
  value: number
  /** The number as a reader sees it beside the mark ("2 rows · 67%"). */
  valueLabel: string
}

export interface ChartSpec {
  kind: ChartKind
  /** Plain-words heading, e.g. "Most common values in Tier". */
  title: string
  /** What the lengths mean. */
  valueAxis: string
  /** What the marks are. */
  categoryAxis: string
  points: ChartPoint[]
  /** The largest value drawn — the scale every mark is measured against. */
  max: number
  /** Set when the picture shows less than the whole story. */
  note?: string
}

/** Bars past this many stop being readable on a phone; the rest are counted
 *  in the note instead. */
export const CHART_BARS_MAX = 12
/** Monthly points past this many are rolled up into years — a 5-year line
 *  with 60 ticks is a smear, not a trend. */
export const CHART_MONTHS_MAX = 36

/** Month names in the chart's own words; a fixed list rather than the
 *  browser's locale so a label never depends on where the reader is. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2024-03" → "Mar 2024"; "2024" → "2024". Anything else is passed through
 *  unchanged (a hand-written bucket must not become "NaN undefined"). */
export function bucketLabel(from: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(from)
  if (month) {
    const index = Number(month[2]) - 1
    return index >= 0 && index < 12 ? `${MONTH_NAMES[index]} ${month[1]}` : from
  }
  return from
}

function rows(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`
}

/**
 * Most common values as bars. Sorted commonest first with ties broken by
 * value, so the same data always draws the same picture (the server sorts
 * this way too — doing it again here means a hand-built list cannot make the
 * bars jump around).
 */
export function barsChart(
  summary: ColumnSummary,
  options: { matched: number; max?: number } = { matched: 0 },
): ChartSpec | null {
  const max = options.max ?? CHART_BARS_MAX
  const sorted = [...summary.top].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  if (sorted.length === 0) return null
  const shown = sorted.slice(0, max)
  return {
    kind: 'bars',
    title: `Most common values in ${summary.column}`,
    valueAxis: 'Number of rows',
    categoryAxis: summary.column,
    points: shown.map(v => ({
      label: v.value,
      value: v.count,
      valueLabel: options.matched > 0 ? `${rows(v.count)} · ${sharePct(v.count, options.matched)}` : rows(v.count),
    })),
    max: shown.reduce((m, v) => Math.max(m, v.count), 0),
    ...(sorted.length > shown.length
      ? { note: `Showing the ${shown.length} most common of ${summary.distinct.toLocaleString()} values.` }
      : {}),
  }
}

/** A bin's range in words: "60 to 63". Rounded to two decimals — a bin edge
 *  of 61.33333333 tells a reader nothing the shorter one does not. */
function binLabel(from: number, to: number): string {
  const round = (n: number) => Math.round(n * 100) / 100
  return from === to ? formatNumber(round(from)) : `${formatNumber(round(from))} to ${formatNumber(round(to))}`
}

/** How the numbers spread out: the summary's ten bins (or the single bin the
 *  server collapses to when every value is the same). */
export function histogramChart(summary: ColumnSummary): ChartSpec | null {
  const bins = summary.numbers?.histogram ?? []
  if (bins.length === 0) return null
  return {
    kind: 'histogram',
    title: `How ${summary.column} spreads out`,
    valueAxis: 'Number of rows',
    categoryAxis: summary.column,
    points: bins.map(b => ({ label: binLabel(b.from, b.to), value: b.count, valueLabel: rows(b.count) })),
    max: bins.reduce((m, b) => Math.max(m, b.count), 0),
    ...(bins.length === 1 ? { note: 'Every row has the same value here.' } : {}),
  }
}

/** Roll monthly buckets up into whole years, keeping the gaps. */
function toYears(buckets: { from: string; count: number }[]): { from: string; count: number }[] {
  const byYear = new Map<string, number>()
  for (const b of buckets) {
    const year = b.from.slice(0, 4)
    byYear.set(year, (byYear.get(year) ?? 0) + b.count)
  }
  return [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([from, count]) => ({ from, count }))
}

/**
 * How many rows fall in each period — the count-over-time line.
 *
 * The server buckets by month while months fit, and by year beyond that
 * (see libraryTabular.dateBuckets). The remaining choice is this one: a run
 * of months longer than CHART_MONTHS_MAX is rolled up into years here, where
 * the width of the drawing is known.
 */
export function timelineChart(summary: ColumnSummary): ChartSpec | null {
  const buckets = summary.dates?.byMonth ?? []
  if (buckets.length === 0) return null
  const monthly = summary.dates?.unit !== 'year'
  const useYears = !monthly || buckets.length > CHART_MONTHS_MAX
  const points = useYears && monthly ? toYears(buckets) : buckets
  const unitWord = useYears ? 'year' : 'month'
  return {
    kind: 'line',
    title: `${summary.column} over time`,
    valueAxis: 'Number of rows',
    categoryAxis: `${summary.column}, by ${unitWord}`,
    points: points.map(b => ({
      label: bucketLabel(b.from),
      value: b.count,
      valueLabel: `${bucketLabel(b.from)}: ${rows(b.count)}`,
    })),
    max: points.reduce((m, b) => Math.max(m, b.count), 0),
  }
}

/** The charts this column can actually draw, best first — which is also the
 *  order the toggle shows them in, so the default is `[0]`. */
export function chartKindsFor(summary: ColumnSummary | null): ChartKind[] {
  if (!summary) return []
  const kinds: ChartKind[] = []
  if (summary.numbers && summary.numbers.histogram.length > 0) kinds.push('histogram')
  if (summary.dates?.byMonth?.length) kinds.push('line')
  if (summary.top.length > 0) kinds.push('bars')
  return kinds
}

/** Build one chart, or null when this column cannot draw that kind. */
export function buildChart(
  summary: ColumnSummary | null,
  kind: ChartKind,
  options: { matched: number; max?: number } = { matched: 0 },
): ChartSpec | null {
  if (!summary) return null
  if (kind === 'histogram') return histogramChart(summary)
  if (kind === 'line') return timelineChart(summary)
  return barsChart(summary, options)
}

/** Plain-words name for the toggle button. */
export const CHART_LABELS: Record<ChartKind, string> = {
  bars: 'Bars',
  histogram: 'Spread',
  line: 'Over time',
}
