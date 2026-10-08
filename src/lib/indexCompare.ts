/**
 * Comparing two indices over the same counties (P9-6).
 *
 * The question the phase exists to answer: *how does re-weighting change the
 * analysis?* Not "are the numbers different" — they always are — but **did
 * the ordering change, and for whom**.
 *
 * Pure, and cheap enough to run in the browser on every weight change: 3,144
 * counties is nothing, so this costs no request and no money (spec §E). Where
 * an analysis runs is our problem, not the reader's, and the answer here is
 * "here, instantly".
 *
 * Not to be confused with `compare.ts`, which puts a handful of COUNTIES side
 * by side (P5-55). This puts two INDICES side by side.
 */

/** A county whose rank moved between the two indices. */
export interface IndexMover {
  geoId: string
  /** Rank in the first index, 1 = highest. */
  from: number
  /** Rank in the second. */
  to: number
  /** How far it moved, in places. Always positive. */
  delta: number
}

export interface IndexComparison {
  /** Counties present in BOTH indices — the only ones comparable. */
  n: number
  /**
   * Spearman rank correlation: 1 the same order, -1 reversed, 0 unrelated.
   *
   * **Null when it would be meaningless** rather than a number nobody should
   * trust — too few counties, or one side with no spread to order.
   */
  spearman: number | null
  /** Why `spearman` is null, in a sentence a reader can act on. Empty when it is not. */
  note: string
  /** The counties that moved most, furthest first. */
  movers: IndexMover[]
}

export interface CompareOptions {
  /** How many movers to return. Default 20 — a list, not a dataset. */
  movers?: number
  /** Below this many shared counties, a correlation is not reported. */
  minCounties?: number
}

const DEFAULT_MOVERS = 20
const DEFAULT_MIN_COUNTIES = 3

function usable(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * County → rank, 1 being the highest value.
 *
 * Tied values share the AVERAGE of the ranks they span — two counties on the
 * same score are both 1.5, not first and second. Without that the
 * correlation below is quietly wrong whenever an index has ties, and an
 * index built from a handful of banded layers has a great many.
 */
export function rankOf(values: Record<string, number>): Record<string, number> {
  const entries = Object.entries(values).filter(([, v]) => usable(v))
  entries.sort((a, b) => b[1] - a[1])
  const ranks: Record<string, number> = {}
  let i = 0
  while (i < entries.length) {
    let j = i
    while (j + 1 < entries.length && entries[j + 1][1] === entries[i][1]) j++
    // positions i..j (0-based) are tied → they share the mean 1-based rank
    const shared = (i + 1 + j + 1) / 2
    for (let k = i; k <= j; k++) ranks[entries[k][0]] = shared
    i = j + 1
  }
  return ranks
}

/** Pearson over two equal-length series; the rank version IS Spearman. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  const mx = xs.reduce((s, v) => s + v, 0) / n
  const my = ys.reduce((s, v) => s + v, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

/** Round away the floating-point fuzz that makes a perfect 1 read as 0.9999999. */
function tidy(r: number): number {
  const rounded = Math.round(r * 1e10) / 1e10
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Compare two indices over the counties they share.
 *
 * Only shared counties are compared: an index that covers more ground is not
 * thereby better correlated, and silently scoring the gaps would make it look
 * that way.
 */
export function compareIndices(
  one: Record<string, number>,
  two: Record<string, number>,
  options: CompareOptions = {},
): IndexComparison {
  const limit = options.movers ?? DEFAULT_MOVERS
  const min = options.minCounties ?? DEFAULT_MIN_COUNTIES

  const shared = Object.keys(one).filter(g => usable(one[g]) && usable(two[g]))
  const n = shared.length

  if (n < min) {
    return {
      n,
      spearman: null,
      note:
        `Only ${n} ${n === 1 ? 'county is' : 'counties are'} in both indices — too few to say ` +
        `whether they agree.`,
      movers: [],
    }
  }

  // Rank within the shared set, not within each index's own coverage: a
  // county's rank among counties the other index cannot see is not comparable.
  const onlyShared = (src: Record<string, number>) =>
    Object.fromEntries(shared.map(g => [g, src[g]]))
  const rankOne = rankOf(onlyShared(one))
  const rankTwo = rankOf(onlyShared(two))

  const xs = shared.map(g => rankOne[g])
  const ys = shared.map(g => rankTwo[g])
  const r = pearson(xs, ys)

  const movers: IndexMover[] = shared
    .map(geoId => ({
      geoId,
      from: rankOne[geoId],
      to: rankTwo[geoId],
      delta: Math.abs(rankOne[geoId] - rankTwo[geoId]),
    }))
    .filter(m => m.delta > 0)
    .sort((a, b) => b.delta - a.delta || a.geoId.localeCompare(b.geoId))
    .slice(0, limit)

  return {
    n,
    spearman: r === null ? null : tidy(r),
    note:
      r === null
        ? 'One of these indices gives every county the same value, so there is no order to compare.'
        : '',
    movers,
  }
}
