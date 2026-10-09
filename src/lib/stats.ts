/**
 * The small statistics two or more features need (P9-7).
 *
 * Extracted rather than written twice: `indexCompare` had the only Pearson in
 * the codebase and grew a median of its own in P9-6c, and the free analyses
 * need both over a different shape entirely. One implementation means one
 * place to be right about ties, empty inputs and a flat series.
 *
 * Everything here is pure and takes plain arrays, so it is testable without a
 * county in sight.
 */

/**
 * Pearson's r, or **null when it would be meaningless**.
 *
 * Null rather than 0 or NaN when either side is flat: a series with no spread
 * has no direction to agree or disagree with, and "0" would read as "no
 * relationship" when the truth is "not a question".
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n < 2 || ys.length !== n) return null
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

/**
 * The value at `p` (0–1) of a SORTED ascending list, interpolating between
 * neighbours. `quantile(xs, 0.5)` is the median.
 *
 * Sorted is the caller's job and is asserted by nothing: every caller here
 * sorts once and asks several questions of the same list, and re-sorting
 * inside would make that quietly quadratic.
 */
export function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return NaN
  if (sorted.length === 1) return sorted[0]
  const at = (sorted.length - 1) * Math.min(Math.max(p, 0), 1)
  const low = Math.floor(at)
  const high = Math.ceil(at)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low)
}

/** The middle of a SORTED ascending list. */
export function median(sorted: readonly number[]): number {
  return quantile(sorted, 0.5)
}
