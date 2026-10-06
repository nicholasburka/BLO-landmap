import { describe, it, expect } from 'vitest'
import {
  barsChart,
  histogramChart,
  timelineChart,
  chartKindsFor,
  buildChart,
  bucketLabel,
  CHART_BARS_MAX,
  CHART_MONTHS_MAX,
} from '../charts'
import type { ColumnSummary } from '../libraryData'

/** A column summary as the server sends it (P5-42 + P5-54 date buckets). */
function summary(overrides: Partial<ColumnSummary> = {}): ColumnSummary {
  return {
    column: 'Tier',
    type: 'string',
    filled: 3,
    empty: 0,
    distinct: 2,
    top: [
      { value: 'Tier 1', count: 2 },
      { value: 'Tier 2', count: 1 },
    ],
    numbers: null,
    dates: null,
    ...overrides,
  }
}

describe('barsChart', () => {
  it('labels each bar with the count and its share of the filtered set', () => {
    const chart = barsChart(summary(), { matched: 3 })!
    expect(chart.kind).toBe('bars')
    expect(chart.title).toBe('Most common values in Tier')
    expect(chart.valueAxis).toBe('Number of rows')
    expect(chart.max).toBe(2)
    expect(chart.points).toEqual([
      { label: 'Tier 1', value: 2, valueLabel: '2 rows · 67%' },
      { label: 'Tier 2', value: 1, valueLabel: '1 row · 33%' },
    ])
    expect(chart.note).toBeUndefined()
  })

  it('breaks ties by value, so the same data always draws the same picture', () => {
    const chart = barsChart(
      summary({ top: [{ value: 'Zeta', count: 4 }, { value: 'Alpha', count: 4 }, { value: 'Mid', count: 9 }] }),
      { matched: 17 },
    )!
    expect(chart.points.map(p => p.label)).toEqual(['Mid', 'Alpha', 'Zeta'])
  })

  it('draws at most CHART_BARS_MAX bars and says how many values were left out', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, count: 30 - i }))
    const chart = barsChart(summary({ top: many, distinct: 40 }), { matched: 100 })!
    expect(chart.points).toHaveLength(CHART_BARS_MAX)
    expect(chart.note).toBe(`Showing the ${CHART_BARS_MAX} most common of 40 values.`)
  })

  it('drops the share when nothing matched, rather than printing 0%', () => {
    const chart = barsChart(summary(), { matched: 0 })!
    expect(chart.points[0].valueLabel).toBe('2 rows')
  })

  it('is null when the column has no values at all', () => {
    expect(barsChart(summary({ top: [] }), { matched: 0 })).toBeNull()
  })
})

describe('histogramChart', () => {
  const numbers = summary({
    column: 'Score',
    type: 'number',
    numbers: {
      min: 60,
      max: 90,
      mean: 75,
      median: 75,
      histogram: [
        { from: 60, to: 70, count: 1 },
        { from: 70, to: 80, count: 0 },
        { from: 80, to: 90, count: 3 },
      ],
    },
  })

  it('labels each bin with its range in plain words', () => {
    const chart = histogramChart(numbers)!
    expect(chart.kind).toBe('histogram')
    expect(chart.title).toBe('How Score spreads out')
    expect(chart.points.map(p => p.label)).toEqual(['60 to 70', '70 to 80', '80 to 90'])
    expect(chart.points[2].valueLabel).toBe('3 rows')
    expect(chart.max).toBe(3)
  })

  it('rounds long bin edges instead of printing them in full', () => {
    const chart = histogramChart(
      summary({ numbers: { min: 0, max: 1, mean: 0.5, median: 0.5, histogram: [{ from: 0.333333333, to: 0.666666666, count: 2 }] } }),
    )!
    expect(chart.points[0].label).toBe('0.33 to 0.67')
  })

  it('says so when the server collapsed the spread to a single bin', () => {
    const chart = histogramChart(
      summary({ numbers: { min: 7, max: 7, mean: 7, median: 7, histogram: [{ from: 7, to: 7, count: 3 }] } }),
    )!
    expect(chart.points).toEqual([{ label: '7', value: 3, valueLabel: '3 rows' }])
    expect(chart.note).toBe('Every row has the same value here.')
  })

  it('is null for a column with no numbers', () => {
    expect(histogramChart(summary())).toBeNull()
  })
})

describe('timelineChart', () => {
  const monthly = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      from: `${2020 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`,
      count: 1,
    }))

  it('draws one point per month, keeping the empty ones', () => {
    const chart = timelineChart(
      summary({
        column: 'Joined',
        type: 'date',
        dates: {
          min: '2024-01-15',
          max: '2024-03-02',
          unit: 'month',
          byMonth: [
            { from: '2024-01', count: 2 },
            { from: '2024-02', count: 0 },
            { from: '2024-03', count: 1 },
          ],
        },
      }),
    )!
    expect(chart.kind).toBe('line')
    expect(chart.title).toBe('Joined over time')
    expect(chart.categoryAxis).toBe('Joined, by month')
    expect(chart.points.map(p => p.label)).toEqual(['Jan 2024', 'Feb 2024', 'Mar 2024'])
    expect(chart.points[0].valueLabel).toBe('Jan 2024: 2 rows')
    expect(chart.max).toBe(2)
  })

  it('rolls months up into years once the line would be too crowded to read', () => {
    const chart = timelineChart(
      summary({ column: 'Joined', type: 'date', dates: { min: '2020-01-01', max: '2023-12-31', unit: 'month', byMonth: monthly(CHART_MONTHS_MAX + 12) } }),
    )!
    expect(chart.categoryAxis).toBe('Joined, by year')
    expect(chart.points.map(p => p.label)).toEqual(['2020', '2021', '2022', '2023'])
    expect(chart.points[0].value).toBe(12)
  })

  it('keeps months when the run is short enough to read', () => {
    const chart = timelineChart(
      summary({ column: 'Joined', type: 'date', dates: { min: '2020-01-01', max: '2022-12-31', unit: 'month', byMonth: monthly(CHART_MONTHS_MAX) } }),
    )!
    expect(chart.categoryAxis).toBe('Joined, by month')
    expect(chart.points).toHaveLength(CHART_MONTHS_MAX)
  })

  it('takes the server at its word when it already bucketed by year', () => {
    const chart = timelineChart(
      summary({
        column: 'Filed',
        type: 'date',
        dates: { min: '1990-01-01', max: '1992-01-01', unit: 'year', byMonth: [{ from: '1990', count: 4 }, { from: '1991', count: 0 }, { from: '1992', count: 2 }] },
      }),
    )!
    expect(chart.categoryAxis).toBe('Filed, by year')
    expect(chart.points.map(p => p.label)).toEqual(['1990', '1991', '1992'])
  })

  it('is null when the summary carries no buckets (a column of no dates, or an older server)', () => {
    expect(timelineChart(summary({ dates: { min: 'a', max: 'b' } }))).toBeNull()
    expect(timelineChart(summary())).toBeNull()
  })
})

describe('bucketLabel', () => {
  it('reads months and years, and leaves anything else alone', () => {
    expect(bucketLabel('2024-03')).toBe('Mar 2024')
    expect(bucketLabel('2024')).toBe('2024')
    expect(bucketLabel('2024-13')).toBe('2024-13')
    expect(bucketLabel('whenever')).toBe('whenever')
  })
})

describe('chartKindsFor / buildChart', () => {
  it('offers the spread first for numbers, the timeline first for dates, bars otherwise', () => {
    expect(chartKindsFor(summary())).toEqual(['bars'])
    expect(
      chartKindsFor(summary({ numbers: { min: 1, max: 2, mean: 1.5, median: 1.5, histogram: [{ from: 1, to: 2, count: 2 }] } })),
    ).toEqual(['histogram', 'bars'])
    expect(
      chartKindsFor(summary({ dates: { min: 'a', max: 'b', unit: 'month', byMonth: [{ from: '2024-01', count: 1 }] } })),
    ).toEqual(['line', 'bars'])
    expect(chartKindsFor(null)).toEqual([])
  })

  it('builds the kind it is asked for, and null when that kind has no data', () => {
    expect(buildChart(summary(), 'bars', { matched: 3 })!.kind).toBe('bars')
    expect(buildChart(summary(), 'histogram', { matched: 3 })).toBeNull()
    expect(buildChart(summary(), 'line', { matched: 3 })).toBeNull()
    expect(buildChart(null, 'bars', { matched: 0 })).toBeNull()
  })
})
