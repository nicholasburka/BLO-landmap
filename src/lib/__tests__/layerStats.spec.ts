import { describe, it, expect } from 'vitest'
import {
  coverageOf,
  coverageLine,
  spreadOf,
  spreadChart,
  spreadLine,
  correlationOf,
  correlationVerdict,
  tieNote,
  topAndBottom,
  readable,
} from '@/lib/layerStats'

/**
 * The free analyses (P9-7, spec §E).
 *
 * Every one runs in the browser over numbers the page already holds, so the
 * tests are the same shape: a handful of counties in, a sentence or a chart
 * out. What is actually being checked is the judgement in each — what a
 * refusal looks like, which end of a layer gets named, and whether a number
 * can reach the screen without the thing that makes it readable.
 */

describe('coverage', () => {
  it('counts against the universe it was given, not against itself', () => {
    const values = { '01001': 1, '01003': 2 }
    // Three counties on the map, two with numbers.
    const c = coverageOf(values, ['01001', '01003', '01005'])
    expect(c).toEqual({ withValue: 2, total: 3, share: 2 / 3 })
    expect(coverageLine(c)).toBe('2 counties of 3 have a number — 67%, so 1 county is blank.')
  })

  it('says so plainly when nothing is missing', () => {
    expect(coverageLine(coverageOf({ a: 1, b: 2 }, ['a', 'b']))).toBe('Every one of 2 counties has a number.')
  })

  it('ignores values that are not numbers, rather than counting them as covered', () => {
    const values = { a: 1, b: NaN, c: undefined as unknown as number }
    expect(coverageOf(values, ['a', 'b', 'c']).withValue).toBe(1)
  })

  it('measures against the layer itself when no universe is given', () => {
    // Which can only ever be 100%, and the sentence says as much.
    expect(coverageOf({ a: 1, b: 2 })).toEqual({ withValue: 2, total: 2, share: 1 })
  })
})

describe('spread', () => {
  const values: Record<string, number> = {}
  for (let i = 1; i <= 100; i++) values[`c${i}`] = i

  it('reports the ends, the middle and the middle half', () => {
    const s = spreadOf(values)!
    expect(s.n).toBe(100)
    expect(s.min).toBe(1)
    expect(s.max).toBe(100)
    expect(s.median).toBeCloseTo(50.5, 5)
    expect(s.q1).toBeCloseTo(25.75, 5)
    expect(s.q3).toBeCloseTo(75.25, 5)
    expect(spreadLine(s)).toBe(
      '100 counties, from 1 to 100. The middle one is 50.5, and half of them sit between 25.8 and 75.3.',
    )
  })

  it('bins every county exactly once, with no one lost at an edge', () => {
    const s = spreadOf(values)!
    expect(s.bins.reduce((sum, b) => sum + b.count, 0)).toBe(100)
    expect(s.bins.length).toBeGreaterThan(1)
  })

  it('names no outliers when there are none', () => {
    // An even ramp has tails but no county outside 1.5 IQRs.
    expect(spreadOf(values)!.outliers).toEqual([])
  })

  it('names the ones that really are out, and which end', () => {
    const withTail = { ...values, far: 1000, low: -500 }
    const out = spreadOf(withTail)!.outliers
    expect(out.map(o => o.geoId)).toEqual(expect.arrayContaining(['far', 'low']))
    expect(out.find(o => o.geoId === 'far')!.end).toBe('high')
    expect(out.find(o => o.geoId === 'low')!.end).toBe('low')
  })

  it('survives a layer where every county is identical', () => {
    const flat = spreadOf({ a: 5, b: 5, c: 5 })!
    expect(flat.bins).toEqual([{ from: 5, to: 5, count: 3 }])
    expect(flat.outliers).toEqual([])
    expect(spreadChart(flat, 'Flat').note).toBe('Every county here has the same value.')
  })

  it('is nothing at all for a layer with no numbers', () => {
    expect(spreadOf({})).toBeNull()
  })

  it('draws through the same ChartSpec the explorer histogram uses', () => {
    const spec = spreadChart(spreadOf(values)!, 'Poverty rate')
    expect(spec.kind).toBe('histogram')
    expect(spec.title).toBe('How Poverty rate spreads out')
    expect(spec.valueAxis).toBe('Number of counties')
    expect(spec.max).toBe(Math.max(...spec.points.map(p => p.value)))
    expect(spec.points[0].valueLabel).toMatch(/counties|county/)
  })
})

describe('correlation', () => {
  it('finds a perfect relationship and keeps the scatter with it', () => {
    const a = { x: 1, y: 2, z: 3, w: 4 }
    const b = { x: 2, y: 4, z: 6, w: 8 }
    const c = correlationOf(a, b)
    expect(c.r).toBe(1)
    expect(c.n).toBe(4)
    // §E: never a bare r. The points come back so the caller CAN draw it.
    expect(c.points).toHaveLength(4)
    expect(c.points[0]).toEqual({ geoId: 'x', x: 1, y: 2 })
  })

  it('compares only the counties in both', () => {
    const c = correlationOf({ a: 1, b: 2, c: 3, only: 9 }, { a: 1, b: 2, c: 3, other: 9 })
    expect(c.n).toBe(3)
    expect(c.points.map(p => p.geoId)).toEqual(['a', 'b', 'c'])
  })

  it('refuses rather than printing a number nobody should trust', () => {
    const c = correlationOf({ a: 1, b: 2 }, { a: 1, z: 2 })
    expect(c.r).toBeNull()
    expect(c.note).toMatch(/too few/i)
  })

  it('says so when one layer is flat, instead of calling it zero', () => {
    const c = correlationOf({ a: 5, b: 5, c: 5 }, { a: 1, b: 2, c: 3 })
    expect(c.r).toBeNull()
    expect(c.note).toMatch(/same value/i)
  })

  it('puts the statistic in words that match its sign and size', () => {
    expect(correlationVerdict(0.9)).toContain('closely')
    expect(correlationVerdict(-0.9)).toContain('opposite directions')
    expect(correlationVerdict(0.6)).toContain('loosely')
    expect(correlationVerdict(0.05)).toMatch(/barely/)
  })
})

describe('ranking', () => {
  const values: Record<string, number> = {}
  for (let i = 1; i <= 50; i++) values[`c${i}`] = i

  it('gives both ends, highest first and lowest first', () => {
    const { top, bottom } = topAndBottom(values, 3)
    expect(top.map(r => r.geoId)).toEqual(['c50', 'c49', 'c48'])
    expect(top.map(r => r.rank)).toEqual([1, 2, 3])
    // Bottom reads outwards from the end too, so "worst" is first.
    expect(bottom.map(r => r.geoId)).toEqual(['c1', 'c2', 'c3'])
    expect(bottom[0].rank).toBe(50)
  })

  it('shows one list rather than two overlapping ones when the layer is short', () => {
    // Five counties and "top five" would print every county twice.
    const { top, bottom } = topAndBottom({ a: 1, b: 2, c: 3 }, 5)
    expect(top.map(r => r.geoId)).toEqual(['c', 'b', 'a'])
    expect(bottom).toEqual([])
  })

  it('breaks ties by geoid so the same data always ranks the same way', () => {
    const { top } = topAndBottom({ b: 1, a: 1, c: 1 }, 2)
    expect(top.map(r => r.geoId)).toEqual(['a', 'b', 'c'])
  })

  it('counts a tie rather than implying a ranking that does not exist', () => {
    // Real data, real trap: the Black poverty rate caps at 100 in every county
    // with a tiny Black population, so "Highest: Marion County, AR — 100"
    // named one of thirty-one counties holding that exact number. The list
    // cannot show a tie, so it has to say there is one.
    const capped: Record<string, number> = { low: 1 }
    for (let i = 0; i < 31; i++) capped[`cap${i}`] = 100
    for (let i = 0; i < 20; i++) capped[`mid${i}`] = 40 + i
    const ends = topAndBottom(capped, 5)
    expect(ends.top).toHaveLength(5)
    expect(ends.tiedAtTop).toBe(31)
    expect(tieNote(ends.tiedAtTop, 100)).toBe('31 counties are tied at 100.')
    // One county at the bottom is not a tie and earns no sentence.
    expect(ends.tiedAtBottom).toBe(1)
    expect(tieNote(ends.tiedAtBottom, 1)).toBe('')
  })
})

describe('readable numbers', () => {
  it('spends precision where the number needs it', () => {
    expect(readable(1234.567)).toBe('1,235')
    expect(readable(12.345)).toBe('12.3')
    expect(readable(0.04213)).toBe('0.042')
  })
})
