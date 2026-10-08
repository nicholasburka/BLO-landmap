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
    expect(r.shift).toEqual({ moved: 0, median: 0, far: 0, farThreshold: 1 })
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

  it('counts how many moved and how far, rather than naming which', () => {
    //      a   b   c   d
    // one: 4   3   2   1   (d best)
    // two: 1   3   2   4   (a best) → a and d swap ends, b and c sit still
    const r = compareIndices(
      { a: 1, b: 2, c: 3, d: 4 },
      { a: 4, b: 2, c: 3, d: 1 },
    )
    expect(r.shift).toEqual({ moved: 2, median: 3, far: 2, farThreshold: 1 })
  })

  /**
   * The reason this is counts and not a list (P9-6c).
   *
   * In a browser, "the twenty counties that moved furthest" was the same eight
   * US territories every single time, whatever was re-weighted: they are
   * missing most of an index's layers, so under `penalise` any change swings
   * them the length of the table. Here, three such counties swing end to end
   * while two hundred real ones shuffle by a place or two — and the median is
   * the small number, which is the honest summary.
   */
  it('is not owned by a handful of counties that swing end to end', () => {
    const one: Record<string, number> = {}
    const two: Record<string, number> = {}
    for (let i = 0; i < 200; i++) {
      one[`real-${i}`] = i
      // Neighbours swap: everybody real moves exactly one place.
      two[`real-${i}`] = i % 2 ? i - 1 : i + 1
    }
    for (let i = 0; i < 3; i++) {
      one[`sparse-${i}`] = 1000 + i // top of the table
      two[`sparse-${i}`] = -1000 + i // bottom of it
    }
    const r = compareIndices(one, two)
    expect(r.shift!.moved).toBe(203)
    // 4, not 1: three counties crossing from the top of the table to the
    // bottom push everyone else up three places, on top of the one-place swap.
    // The number that matters is that it is FOUR and not four hundred — a mean
    // over these deltas is 34, which would read as "the whole map moved".
    expect(r.shift!.median).toBe(4)
    expect(r.shift!.far).toBe(3)
    expect(r.shift!.farThreshold).toBe(21)
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
