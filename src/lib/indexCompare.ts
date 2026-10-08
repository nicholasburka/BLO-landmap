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

/**
 * How much the order moved, as counts rather than as a list of counties.
 *
 * It used to be a list — the twenty counties that moved furthest — and in a
 * browser that list was the same eight US territories every single time,
 * whatever anyone re-weighted. They are missing most of an index's layers, so
 * under `missing: 'penalise'` any change to the weights swings them the length
 * of the table. The card's payoff was answering "which counties have the least
 * data" dressed as "what did your re-weighting do".
 *
 * Counts cannot do that. "How many moved, and how far" is the question
 * (Nick, 2026-10-08), and it is robust to a handful of sparse outliers in a
 * way that "here are the biggest movers" can never be.
 */
export interface IndexShift {
  /** Counties whose rank changed at all. */
  moved: number
  /** Places moved by the MEDIAN county that moved — not the mean, which a few
   *  table-length swings would own. 0 when nothing moved. */
  median: number
  /** How many moved further than `farThreshold`. */
  far: number
  /** A tenth of the table, rounded up: "a long way" has to scale with how many
   *  counties there are to move past. */
  farThreshold: number
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
  /** How much the order moved. Null when there were too few counties to say. */
  shift: IndexShift | null
}

export interface CompareOptions {
  /** Below this many shared counties, a correlation is not reported. */
  minCounties?: number
}

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
      shift: null,
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

  const deltas = shared
    .map(geoId => Math.abs(rankOne[geoId] - rankTwo[geoId]))
    .filter(d => d > 0)
    .sort((a, b) => a - b)
  const farThreshold = Math.ceil(n / 10)

  return {
    n,
    spearman: r === null ? null : tidy(r),
    note:
      r === null
        ? 'One of these indices gives every county the same value, so there is no order to compare.'
        : '',
    shift: {
      moved: deltas.length,
      median: deltas.length ? median(deltas) : 0,
      far: deltas.filter(d => d > farThreshold).length,
      farThreshold,
    },
  }
}

/**
 * "1,842 of 3,215 counties changed place, half of them by 12 or fewer."
 *
 * One sentence, because the question a reader has after re-weighting an index
 * is how much of the map this moved and by how much — not which eight places
 * moved most, which is a different and (for sparse counties) misleading
 * question.
 */
export function shiftLineOf(result: Pick<IndexComparison, 'n' | 'shift'>): string {
  const shift = result.shift
  if (!shift) return ''
  if (!shift.moved) return 'No county changed place between them.'
  const places = (k: number) => `${k.toLocaleString()} ${k === 1 ? 'place' : 'places'}`
  const n = result.n.toLocaleString()

  // NOT "how many counties changed place at all", which was the first draft and
  // read "3,215 of 3,215" on a real comparison — of course it did: move one
  // county and everything below it shifts by one, so that count is always
  // about `n` and tells a reader nothing. How FAR the middle county moved is
  // the number that separates a nudge from a reordering.
  if (shift.moved === 1) return `One county moved, by ${places(shift.median)}.`
  const line = `Half of these ${n} counties moved more than ${places(shift.median)}.`
  if (!shift.far) return line
  return `${line} ${shift.far.toLocaleString()} moved more than a tenth of the table.`
}

/** The middle of a SORTED list; the mean of the middle two when it is even. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return Math.round(value * 10) / 10
}
