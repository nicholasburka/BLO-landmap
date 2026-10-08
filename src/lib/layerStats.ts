/**
 * The free analyses (P9-7, spec §E).
 *
 * Four questions a researcher asks of a county layer, all answered here in the
 * browser over numbers the page already holds: how much of the country it
 * covers, how it spreads out, how it relates to another layer, and who is at
 * the ends of it. 3,144 counties is nothing — none of this needs a request, so
 * none of it costs anything, and **where it runs is not the reader's concern**
 * (§E). There is no cost disclosure here and there should never be one.
 *
 * Pure functions over `GEOID → number`, which is the shape both the internal
 * layer values and a derived column arrive in.
 */
import { median, pearson, quantile } from '@/lib/stats'
import type { ChartSpec } from '@/lib/charts'

/** One county layer's numbers, as every caller already holds them. */
export type LayerValues = Record<string, number>

function usable(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** The GEOIDs with a real number, in no particular order. */
function covered(values: LayerValues): string[] {
  return Object.keys(values).filter(geoId => usable(values[geoId]))
}

// --- Coverage ---------------------------------------------------------------

export interface Coverage {
  /** Counties carrying a usable number. */
  withValue: number
  /** Counties this was measured against. */
  total: number
  /** 0–1. */
  share: number
}

/**
 * How much of the country a layer actually has numbers for.
 *
 * The cheapest analysis and often the most load-bearing: an index built on a
 * layer covering a third of the country is an index about that third, and
 * nothing else on the page says so.
 *
 * `universe` is what to measure against — the counties on the map, or the
 * set's own subset. Empty means "whatever this layer mentions", which can
 * only ever report 100% and says so by returning a share of 1 over its own
 * size.
 */
export function coverageOf(values: LayerValues, universe: readonly string[] = []): Coverage {
  const have = new Set(covered(values))
  const total = universe.length ? universe.length : have.size
  const withValue = universe.length ? universe.filter(geoId => have.has(geoId)).length : have.size
  return { withValue, total, share: total ? withValue / total : 0 }
}

export function coverageLine(coverage: Coverage): string {
  if (!coverage.total) return 'No counties to measure.'
  const pct = Math.round(coverage.share * 100)
  const counties = (k: number) => `${k.toLocaleString()} ${k === 1 ? 'county' : 'counties'}`
  if (coverage.withValue === coverage.total) return `Every one of ${counties(coverage.total)} has a number.`
  const missing = coverage.total - coverage.withValue
  const blank = `${counties(missing)} ${missing === 1 ? 'is' : 'are'} blank`
  return `${counties(coverage.withValue)} of ${coverage.total.toLocaleString()} have a number — ${pct}%, so ${blank}.`
}

// --- Distribution -----------------------------------------------------------

export interface Bin {
  from: number
  to: number
  count: number
}

export interface Spread {
  n: number
  min: number
  max: number
  median: number
  /** The middle half sits between these. */
  q1: number
  q3: number
  bins: Bin[]
  /** Counties more than 1.5 IQRs outside the middle half, fewest first. */
  outliers: { geoId: string; value: number; end: 'low' | 'high' }[]
}

/** Sturges, capped: enough bars to show a shape, few enough to read on a
 *  phone. */
function binCountFor(n: number): number {
  return Math.max(1, Math.min(12, Math.ceil(Math.log2(n || 1) + 1)))
}

/**
 * How a layer spreads out, and who is at the tails.
 *
 * Outliers are named by the ordinary 1.5×IQR rule rather than by "the top
 * ten", because a layer with no outliers should say so rather than produce
 * ten anyway — which is the same mistake P9-6c took out of the index
 * comparison.
 */
export function spreadOf(values: LayerValues, outlierLimit = 8): Spread | null {
  const geoIds = covered(values)
  if (!geoIds.length) return null
  const sorted = geoIds.map(geoId => values[geoId]).sort((a, b) => a - b)
  const n = sorted.length
  const min = sorted[0]
  const max = sorted[n - 1]
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const lowFence = q1 - 1.5 * iqr
  const highFence = q3 + 1.5 * iqr

  const bins: Bin[] = []
  const count = binCountFor(n)
  const width = (max - min) / count
  if (width === 0) {
    bins.push({ from: min, to: max, count: n })
  } else {
    for (let i = 0; i < count; i++) {
      const from = min + width * i
      const to = i === count - 1 ? max : from + width
      // The last bin owns its upper edge; every other is half-open, so no
      // county is counted twice and none falls through.
      const inBin = sorted.filter(v => (i === count - 1 ? v >= from && v <= to : v >= from && v < to))
      bins.push({ from, to, count: inBin.length })
    }
  }

  const outliers = geoIds
    .filter(geoId => iqr > 0 && (values[geoId] < lowFence || values[geoId] > highFence))
    .map(geoId => ({
      geoId,
      value: values[geoId],
      end: (values[geoId] < lowFence ? 'low' : 'high') as 'low' | 'high',
    }))
    .sort((a, b) => Math.abs(b.value - median(sorted)) - Math.abs(a.value - median(sorted)))
    .slice(0, outlierLimit)

  return { n, min, max, median: median(sorted), q1, q3, bins, outliers }
}

/** A number as a reader reads it: no more precision than the spread earns. */
export function readable(value: number): string {
  const size = Math.abs(value)
  const places = size >= 100 ? 0 : size >= 1 ? 1 : 3
  return Number(value.toFixed(places)).toLocaleString()
}

/** The spread as a `SummaryChart` can draw it — no charting library, the same
 *  `ChartSpec` the dataset explorer's histogram uses. */
export function spreadChart(spread: Spread, layerName: string): ChartSpec {
  return {
    kind: 'histogram',
    title: `How ${layerName} spreads out`,
    valueAxis: 'Number of counties',
    categoryAxis: layerName,
    points: spread.bins.map(bin => ({
      label: `${readable(bin.from)} to ${readable(bin.to)}`,
      value: bin.count,
      valueLabel: `${bin.count.toLocaleString()} ${bin.count === 1 ? 'county' : 'counties'}`,
    })),
    max: spread.bins.reduce((m, bin) => Math.max(m, bin.count), 0),
    ...(spread.bins.length === 1 ? { note: 'Every county here has the same value.' } : {}),
  }
}

export function spreadLine(spread: Spread): string {
  return (
    `${spread.n.toLocaleString()} ${spread.n === 1 ? 'county' : 'counties'}, ` +
    `from ${readable(spread.min)} to ${readable(spread.max)}. ` +
    `The middle one is ${readable(spread.median)}, and half of them sit between ` +
    `${readable(spread.q1)} and ${readable(spread.q3)}.`
  )
}

// --- Correlation ------------------------------------------------------------

export interface Correlation {
  /** Counties with a number in BOTH layers — the only ones comparable. */
  n: number
  /** Pearson's r over those counties, or null when it would mean nothing. */
  r: number | null
  /** Why `r` is null, in a sentence. Empty when it is not. */
  note: string
  /** Every shared county, for the scatter. */
  points: { geoId: string; x: number; y: number }[]
}

/**
 * How two layers move together — **never a bare r** (§E).
 *
 * The caller is required to be able to draw the scatter and say the count,
 * which is why both come back with the number: a correlation without its n is
 * unfalsifiable, and one without its shape hides every curve, cluster and
 * single point that produced it.
 */
export function correlationOf(a: LayerValues, b: LayerValues, minCounties = 3): Correlation {
  const shared = covered(a).filter(geoId => usable(b[geoId]))
  const points = shared.map(geoId => ({ geoId, x: a[geoId], y: b[geoId] }))
  const n = points.length
  if (n < minCounties) {
    return {
      n,
      r: null,
      note: `Only ${n} ${n === 1 ? 'county has' : 'counties have'} a number in both — too few to compare.`,
      points,
    }
  }
  const r = pearson(points.map(p => p.x), points.map(p => p.y))
  return {
    n,
    r: r === null ? null : Math.round(r * 100) / 100,
    note: r === null ? 'One of these layers gives every county the same value, so there is nothing to relate.' : '',
    points,
  }
}

/** The statistic in words. A correlation is a number most readers cannot
 *  place, and the word has to carry the same meaning the number does. */
export function correlationVerdict(r: number): string {
  const size = Math.abs(r)
  const direction = r > 0 ? 'together' : 'in opposite directions'
  if (size >= 0.8) return `These move ${direction}, closely`
  if (size >= 0.5) return `These move ${direction}, loosely`
  if (size >= 0.3) return `A weak tendency to move ${direction}`
  return 'These two barely track each other'
}

// --- Ranking ----------------------------------------------------------------

export interface Ranked {
  geoId: string
  value: number
  /** 1 is the highest value. */
  rank: number
}

export interface Ends {
  top: Ranked[]
  bottom: Ranked[]
  /** How many counties share the highest value, when that is more than one. */
  tiedAtTop: number
  /** And the lowest. */
  tiedAtBottom: number
}

/**
 * The top and bottom of a layer.
 *
 * Both ends, always: "the worst ten counties for X" is a different claim from
 * "the best ten", and showing one without the other invites the reader to
 * assume the other end is unremarkable.
 *
 * **Ties are counted, because a list cannot show them and will lie by
 * omission.** Seen on real data: the Black poverty rate caps at 100 in every
 * county with a tiny Black population, so "Highest: Marion County, AR — 100"
 * named one of THIRTY-ONE counties holding that exact value and implied a
 * ranking that does not exist. The list still shows five; the count says how
 * many it is standing in for.
 */
export function topAndBottom(values: LayerValues, howMany = 5): Ends {
  const ranked = covered(values)
    .map(geoId => ({ geoId, value: values[geoId], rank: 0 }))
    .sort((x, y) => y.value - x.value || x.geoId.localeCompare(y.geoId))
    .map((row, i) => ({ ...row, rank: i + 1 }))
  const tiedWith = (value: number) => ranked.filter(row => row.value === value).length
  const tiedAtTop = ranked.length ? tiedWith(ranked[0].value) : 0
  const tiedAtBottom = ranked.length ? tiedWith(ranked[ranked.length - 1].value) : 0
  if (ranked.length <= howMany * 2) return { top: ranked, bottom: [], tiedAtTop, tiedAtBottom }
  return {
    top: ranked.slice(0, howMany),
    bottom: ranked.slice(-howMany).reverse(),
    tiedAtTop,
    tiedAtBottom,
  }
}

/** "31 counties are tied at 100." — or nothing, when the end is a single
 *  county and the list is already the whole truth. */
export function tieNote(count: number, value: number): string {
  if (count < 2) return ''
  return `${count.toLocaleString()} counties are tied at ${readable(value)}.`
}
