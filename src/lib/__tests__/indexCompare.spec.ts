import { describe, it, expect } from 'vitest'
import { rankOf, compareIndices } from '../indexCompare'

/**
 * P9-6. The question the whole phase exists to answer: *how does re-weighting
 * change the analysis?* Two indices over the same counties, and what moved.
 *
 * Free and client-side: 3,144 counties is nothing, so this costs no request
 * and no money (spec §E).
 */

describe('rankOf', () => {
  it('ranks highest first, 1-based', () => {
    expect(rankOf({ a: 10, b: 30, c: 20 })).toEqual({ b: 1, c: 2, a: 3 })
  })

  /** Ties must share the AVERAGE rank, or the correlation below is wrong —
   *  two counties on 50 are not first and second, they are both 1.5. */
  it('gives tied values the average of the ranks they span', () => {
    expect(rankOf({ a: 50, b: 50, c: 10 })).toEqual({ a: 1.5, b: 1.5, c: 3 })
  })

  it('ignores a county with no usable number', () => {
    const r = rankOf({ a: 10, b: Number.NaN, c: 20 } as Record<string, number>)
    expect(Object.keys(r).sort()).toEqual(['a', 'c'])
  })
})

describe('compareIndices', () => {
  it('reports perfect agreement when the order is unchanged', () => {
    const a = { x: 1, y: 2, z: 3 }
    const b = { x: 10, y: 20, z: 30 } // different numbers, same ORDER
    const r = compareIndices(a, b)
    expect(r.spearman).toBe(1)
    expect(r.n).toBe(3)
    expect(r.movers).toEqual([])
  })

  it('reports perfect disagreement when the order is reversed', () => {
    const r = compareIndices({ x: 1, y: 2, z: 3 }, { x: 3, y: 2, z: 1 })
    expect(r.spearman).toBe(-1)
  })

  /** The number nobody should read without: two indices agreeing across four
   *  counties is not evidence of anything. */
  it('always says how many counties it compared', () => {
    const r = compareIndices({ x: 1, y: 2, p: 9 }, { x: 2, y: 1, q: 9 })
    expect(r.n).toBe(2) // only x and y are in both
  })

  it('names the biggest movers, worst first, with both ranks', () => {
    //      a   b   c   d
    // one: 4   3   2   1   (d best)
    // two: 1   3   2   4   (a best) → a and d swap ends
    const r = compareIndices(
      { a: 1, b: 2, c: 3, d: 4 },
      { a: 4, b: 2, c: 3, d: 1 },
    )
    expect(r.movers[0].geoId).toBe('a')
    expect(r.movers[0].from).toBe(4)
    expect(r.movers[0].to).toBe(1)
    expect(r.movers[0].delta).toBe(3)
    expect(r.movers.map(m => m.geoId)).toContain('d')
  })

  it('caps the movers list rather than handing back three thousand rows', () => {
    const one: Record<string, number> = {}
    const two: Record<string, number> = {}
    for (let i = 0; i < 500; i++) {
      one[String(i)] = i
      two[String(i)] = 500 - i
    }
    const r = compareIndices(one, two, { movers: 10 })
    expect(r.movers).toHaveLength(10)
  })

  it('refuses to correlate when almost nothing overlaps, instead of printing a number', () => {
    const r = compareIndices({ a: 1, b: 2 }, { a: 1, z: 2 })
    expect(r.n).toBe(1)
    expect(r.spearman).toBeNull()
    expect(r.note).toMatch(/1 county|too few/i)
  })

  /** A flat index has no order to compare, so a correlation against it is
   *  undefined rather than zero. */
  it('says so when one side has no spread at all', () => {
    const r = compareIndices({ a: 5, b: 5, c: 5 }, { a: 1, b: 2, c: 3 })
    expect(r.spearman).toBeNull()
    expect(r.note).toMatch(/same value|no spread/i)
  })
})
