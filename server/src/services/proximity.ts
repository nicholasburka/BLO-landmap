/**
 * Proximity between two layers (P7-5) — the primitive, and nothing that knows
 * about a bucket.
 *
 * Spec §F.2. **Nothing in the system related two datasets to each other**
 * before this: every analysis was single-dataset or single-place, and the
 * Siting Criteria sheet is almost entirely proximity questions — *"distance
 * from site to development"*, *"brownfields in connection to transmission
 * lines"*, *"greenfields + their capacity + proximity"*.
 *
 * For each row of dataset A: the miles to the nearest feature of layer B, and
 * optionally how many features of B lie within *n* miles. The output is a
 * derived column on a **working set** — never a mutation of either source, so
 * provenance stays clean and the source stays re-fetchable.
 *
 * **This file is pure on purpose**, because §F.4b's rule is that *cardinality
 * decides where an analysis runs, not the operation*: proximity over 13 sites
 * is microseconds, over 190,000 brownfields it is a batch job. Both homes —
 * the request (`workingSetProximity.ts`) and the local CLI pass
 * (`cli/proximity.ts`) — call exactly these functions, so a number computed
 * in a batch and a number computed in a request cannot differ. The **ceiling
 * belongs to the request, not to the maths**: `proximityRefusal` is exported
 * beside the primitive and the CLI deliberately does not call it.
 *
 * ## Why the geometry is here and not in `@turf/turf`
 *
 * `@turf/turf` is a dependency of the **root** package, for the browser. The
 * API deploys with Root Directory = `server` (DEPLOY.md), and every bare
 * import under `server/src` is declared in `server/package.json` — there is
 * no exception. A `@turf/turf` import here would resolve in dev and in the
 * test run by node's upward walk to the root `node_modules` and be **absent
 * in production**: green gates, a module-not-found on Railway. The maths that
 * was wanted is `nearestPointOnLine`, which is forty lines of exact spherical
 * trigonometry, and the bulk pass wants it allocation-free anyway.
 */

import { distanceMiles, type PlacePoint } from './placeAdapters/shared.js'

const RAD = Math.PI / 180

/** The same sphere `distanceMiles` uses, so a degenerate target (a point) and
 *  the place report's organization list cannot answer differently. */
export const EARTH_MILES = 3958.7613

/**
 * Most rows of A the on-demand tier will measure.
 *
 * §F.4b: *"build tier 2 for small-N only, with an explicit row-count ceiling
 * that refuses rather than crawls, and keep tier 1 as the answer for
 * everything above it."* The API is one small Railway instance whose
 * rate-limit and budget counters are in-memory, and DEPLOY.md's scaling note
 * says not to scale it horizontally yet — so an analysis that takes minutes
 * does not belong in a request at all.
 *
 * 5,000 is the same order as `ROWS_MAX`, the place-report slice cap, and it is
 * far past any curated working set: the workbook's is eleven rows. What it
 * refuses is a whole-layer derivation — 190,000 brownfields — which is what
 * the local pass is for.
 */
export const PROXIMITY_ROWS_MAX = 5_000

/**
 * Most point-to-segment tests the on-demand tier will run, counted before any
 * are run.
 *
 * **The row cap cannot see the work**, which is P7-3's lesson and cost a stack
 * overflow to learn: a few hundred transmission corridors is a few hundred
 * features and can be millions of vertices, so a thousand rows against a
 * dense national layer is a billion segment tests while every declared cap
 * reads green.
 *
 * **Measured, not guessed: ~10 million tests per second**, in the case where
 * the box prefilter can skip nothing (one feature whose extent is the whole
 * country). 20 million is therefore about **two seconds**, and two seconds is
 * the number that matters because this is *synchronous* work on a single
 * Node event loop: a forty-second proximity run does not make one request
 * slow, it makes the whole API unresponsive — the health check included —
 * which is a worse failure than refusing. The same instance whose rate-limit
 * and budget counters DEPLOY.md says are in-memory is the one that would
 * stop answering.
 *
 * This is deliberately a **nominal** bound, counted as rows × vertices with
 * no credit for the prefilter. The prefilter usually skips 98% of that (5,000
 * rows against a real 200,000-vertex transmission layer measures in 1.2s, not
 * 100s), so the bound refuses some work that would in fact have been fast.
 * That is the right direction to be wrong in: §F.4b says build tier 2 for
 * small-N only and keep tier 1 as the answer for everything above it, and the
 * local pass has no ceiling at all.
 */
export const PROXIMITY_SEGMENT_BUDGET = 20_000_000

/**
 * Decimal places a stored distance keeps.
 *
 * Four is about half a foot, which is already far finer than either input: a
 * Census-geocoded address point is good to tens of feet and a digitised
 * corridor no better. Writing `1.2313338134965632` into a manifest would
 * claim a precision that does not exist, and it would also make the stored
 * number depend on float formatting — so a measurement is rounded ONCE, here,
 * at the boundary where it becomes a stored value. `distanceToTargetMiles`
 * stays exact for anyone comparing two of them.
 */
export const PROXIMITY_DECIMALS = 4

function stored(miles: number): number {
  return Math.round(miles * 1e4) / 1e4
}

/** The widest *n* a "within n miles" count may ask for. Past the width of the
 *  country the count is every feature in the layer, which is not a question
 *  about proximity. */
export const PROXIMITY_WITHIN_MAX = 500

// --- What goes in -----------------------------------------------------------

/** One row of dataset A, already read out of the table. */
export interface ProximityRow {
  /** The row's index in the table, 0-based — a CSV's only stable identity. */
  index: number
  label: string
  lat: number | null
  lng: number | null
  /** 5-digit county FIPS, or null when the table does not place this row. */
  geoid: string | null
}

/**
 * One feature of layer B, as either geometry the pipeline can hold.
 *
 * `path` is P7-3's `_path` in either of its two nestings — one part is a
 * `LineString`, several a `MultiLineString` — because that is how the layer
 * payload spells them and a reader inspecting a simple line should not find it
 * wrapped in a Multi.
 */
export interface ProximityTarget {
  label: string
  lat?: number
  lng?: number
  path?: unknown
}

export interface ProximityOptions {
  /** Count features within this many miles as well as measuring the nearest.
   *  Null/undefined asks only for the distance. */
  within?: number | null
}

// --- The prepared target ----------------------------------------------------

/**
 * A target with its geometry converted once.
 *
 * Latitude/longitude are converted to 3D unit vectors **up front and into a
 * flat `Float64Array`**, because the inner loop runs rows × vertices times:
 * for the bulk pass that is hundreds of millions of iterations, and a
 * per-iteration `Math.cos` or a per-vertex object allocation is the difference
 * between a batch job and an afternoon.
 */
export interface PreparedTarget {
  index: number
  label: string
  /** x,y,z per vertex, every part end to end. */
  xyz: Float64Array
  /** Vertex offset where each part starts, with a terminator, so a part
   *  boundary is never walked as if it were a segment. */
  partStarts: number[]
  vertices: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

type Vertex = [number, number]

/** `_path` in either nesting, plus the degenerate spellings a hand-written
 *  file arrives in. A part with fewer than two surviving vertices is not a
 *  segment and is dropped rather than measured as a point — `projectLineFeatures`
 *  already made the same call upstream. */
function partsOf(path: unknown): Vertex[][] {
  if (!Array.isArray(path) || path.length === 0) return []
  const first = path[0]
  const nested = Array.isArray(first) && Array.isArray(first[0])
  const raw = (nested ? path : [path]) as unknown[]
  const parts: Vertex[][] = []
  for (const candidate of raw) {
    if (!Array.isArray(candidate)) continue
    const part: Vertex[] = []
    for (const vertex of candidate) {
      if (!Array.isArray(vertex)) continue
      const lng = Number(vertex[0])
      const lat = Number(vertex[1])
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue
      part.push([lng, lat])
    }
    if (part.length >= 2) parts.push(part)
  }
  return parts
}

/**
 * Convert each target's geometry once.
 *
 * A target whose geometry cannot be read at all is **dropped**, not kept as a
 * zero: a feature we cannot locate is not a feature at distance nothing. The
 * caller reports the difference between the features a layer declared and the
 * targets that came back.
 */
export function prepareTargets(targets: readonly ProximityTarget[]): PreparedTarget[] {
  const out: PreparedTarget[] = []
  for (const target of targets) {
    const parts =
      Number.isFinite(target.lat) && Number.isFinite(target.lng)
        ? [[[target.lng as number, target.lat as number] as Vertex]]
        : partsOf(target.path)
    const count = parts.reduce((n, part) => n + part.length, 0)
    if (!count) continue

    const xyz = new Float64Array(count * 3)
    const partStarts: number[] = []
    let v = 0
    let minLat = 90
    let maxLat = -90
    let minLng = 180
    let maxLng = -180
    for (const part of parts) {
      partStarts.push(v)
      for (const [lng, lat] of part) {
        const phi = lat * RAD
        const lam = lng * RAD
        const cosPhi = Math.cos(phi)
        xyz[v * 3] = cosPhi * Math.cos(lam)
        xyz[v * 3 + 1] = cosPhi * Math.sin(lam)
        xyz[v * 3 + 2] = Math.sin(phi)
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        if (lng < minLng) minLng = lng
        if (lng > maxLng) maxLng = lng
        v++
      }
    }
    partStarts.push(v)
    out.push({ index: out.length, label: target.label, xyz, partStarts, vertices: count, minLat, maxLat, minLng, maxLng })
  }
  return out
}

/**
 * The features of a point or line layer, as targets.
 *
 * Reads the payload `readInternalLayerValues` and `projectLineFeatures`
 * already produce, so the on-demand tier and the local pass take their
 * geometry from the same projection the map draws — there is no second reading
 * of what a layer's features are.
 */
export function targetsFromFeatures(
  features: readonly { geometry?: unknown; properties?: Record<string, string> }[],
): ProximityTarget[] {
  const out: ProximityTarget[] = []
  features.forEach((feature, i) => {
    const geometry = (feature.geometry ?? {}) as { type?: string; coordinates?: unknown }
    // `_label` is what the layer drew; a feature the manifest gave no label
    // gets its position in the layer rather than an empty popup title.
    const label = (feature.properties?._label ?? '').trim() || `Feature ${i + 1}`
    if (geometry.type === 'Point' && Array.isArray(geometry.coordinates)) {
      const [lng, lat] = geometry.coordinates as number[]
      if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ label, lat, lng })
      return
    }
    if (geometry.type === 'LineString' || geometry.type === 'MultiLineString') {
      out.push({ label, path: geometry.coordinates })
    }
  })
  return out
}

// --- The maths --------------------------------------------------------------

/**
 * A rigorous LOWER bound on the miles from a point to a target's box.
 *
 * This is the only reason the bulk pass is tractable: with it, a row skips
 * every feature whose box is already further away than the nearest one found
 * so far, so 190,000 rows against a national layer walk a handful of corridors
 * each instead of all of them. `bboxAround` in `placeAdapters/shared.ts` is
 * the same idea for the place fetch.
 *
 * It has to be a **true** lower bound, because over-estimating does not make
 * the answer slow, it makes it wrong — a skipped feature that was nearest
 * returns somebody else's number with no error anywhere. Both terms are
 * therefore the exact haversine components rather than a miles-per-degree
 * approximation:
 *
 *  - the latitude gap, because the central angle between two points is at
 *    least their latitude difference;
 *  - the longitude gap at the **larger** |latitude| of the span, because
 *    `cos φ₁ · cos φ₂ ≥ cos²(max |φ|)` and the haversine's longitude term
 *    carries exactly that product.
 */
function boxLowerBoundMiles(lat: number, lng: number, t: PreparedTarget): number {
  const dLat = lat < t.minLat ? t.minLat - lat : lat > t.maxLat ? lat - t.maxLat : 0
  let dLng = lng < t.minLng ? t.minLng - lng : lng > t.maxLng ? lng - t.maxLng : 0
  // The Aleutian wrap. A naive gap of 358° would skip a feature four miles
  // away, and the symptom would be a plausible wrong number rather than an
  // error — so the wrap is folded rather than clamped.
  if (dLng > 180) dLng = 360 - dLng
  if (dLat === 0 && dLng === 0) return 0
  const absLat = Math.max(Math.abs(lat), Math.abs(t.minLat), Math.abs(t.maxLat))
  const cosLat = Math.cos(absLat * RAD)
  const sLat = Math.sin((dLat * RAD) / 2)
  const sLng = Math.sin((dLng * RAD) / 2)
  const h = sLat * sLat + cosLat * cosLat * sLng * sLng
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Angular distance between two unit vectors. `atan2` of the cross magnitude
 *  over the dot, never `acos`, which loses all its precision for the small
 *  angles every real site-to-wire distance is. */
function angleBetween(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const cx = ay * bz - az * by
  const cy = az * bx - ax * bz
  const cz = ax * by - ay * bx
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz)
}

/** Degenerate segments — a repeated vertex in a hand-drawn path — are real in
 *  shipped geometry, and `n` is zero for them. */
const DEGENERATE = 1e-18

/**
 * Angular distance from a point to the great-circle arc A→B, all unit vectors.
 *
 * `n = A × B` is the normal of the arc's plane. The nearest point on the great
 * *circle* is P projected into that plane, and its angular distance from P is
 * `asin(|P·n| / |n|)` — no normalisation, no square roots in the common case.
 * Whether that foot lies **on the arc** rather than on the far side of the
 * planet is the two sign tests: the foot q must be rotationally between A and
 * B about n. When it is not, the honest answer is the nearer endpoint — the
 * distance to the end of the wire.
 */
function angleToSegment(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const nx = ay * bz - az * by
  const ny = az * bx - ax * bz
  const nz = ax * by - ay * bx
  const nn = nx * nx + ny * ny + nz * nz
  if (nn < DEGENERATE) return angleBetween(px, py, pz, ax, ay, az)

  const pn = px * nx + py * ny + pz * nz
  const k = pn / nn
  const qx = px - k * nx
  const qy = py - k * ny
  const qz = pz - k * nz
  // P sits on the pole of the arc's own circle: every point of the arc is a
  // quarter-turn away, which is exactly what the cross-track angle says.
  if (qx * qx + qy * qy + qz * qz < DEGENERATE) return Math.PI / 2

  const aq = (ay * qz - az * qy) * nx + (az * qx - ax * qz) * ny + (ax * qy - ay * qx) * nz
  const qb = (qy * bz - qz * by) * nx + (qz * bx - qx * bz) * ny + (qx * by - qy * bx) * nz
  if (aq >= 0 && qb >= 0) return Math.asin(Math.min(1, Math.abs(pn) / Math.sqrt(nn)))

  const toA = angleBetween(px, py, pz, ax, ay, az)
  const toB = angleBetween(px, py, pz, bx, by, bz)
  return toA < toB ? toA : toB
}

/** Miles from a point to a prepared target — a point, a line, or a line of
 *  several parts, whichever the target holds. */
export function distanceToTargetMiles(point: PlacePoint, target: PreparedTarget): number {
  const phi = point.lat * RAD
  const lam = point.lng * RAD
  const cosPhi = Math.cos(phi)
  return (
    EARTH_MILES *
    angleToTarget(cosPhi * Math.cos(lam), cosPhi * Math.sin(lam), Math.sin(phi), target)
  )
}

function angleToTarget(px: number, py: number, pz: number, t: PreparedTarget): number {
  const { xyz, partStarts } = t
  let best = Math.PI
  for (let p = 0; p + 1 < partStarts.length; p++) {
    const from = partStarts[p]
    const to = partStarts[p + 1]
    // A single-vertex part is a point target; everything else is segments.
    if (to - from === 1) {
      const a = from * 3
      const angle = angleBetween(px, py, pz, xyz[a], xyz[a + 1], xyz[a + 2])
      if (angle < best) best = angle
      continue
    }
    for (let v = from; v + 1 < to; v++) {
      const a = v * 3
      const b = a + 3
      const angle = angleToSegment(px, py, pz, xyz[a], xyz[a + 1], xyz[a + 2], xyz[b], xyz[b + 1], xyz[b + 2])
      if (angle < best) best = angle
    }
  }
  return best
}

// --- What comes out ---------------------------------------------------------

export interface ProximityRowResult {
  index: number
  label: string
  geoid: string | null
  /** Miles to the nearest target, or null when the row has no coordinates. */
  miles: number | null
  /** The nearest target's label; '' when the row could not be measured. */
  nearest: string
  /** Distinct targets within the radius, or null when none was asked for. */
  within: number | null
}

export interface ProximityStats {
  /** Rows of A the table held — the denominator, always. */
  rows: number
  /** Rows with usable coordinates, which are the ones that got a number. */
  measured: number
  /** Rows with no usable coordinates. */
  withoutPoint: number
  /** Rows measured but with no county, so they reach no county-keyed column.
   *  Reported rather than folded away: a number that disagreed with the rows
   *  behind it is the P6-23 sin. */
  withoutCounty: number
  /** Counties the column covers. */
  counties: number
  /** Targets actually measured against. */
  targets: number
  /** Vertices walked per row — what the segment budget is spent on. */
  vertices: number
}

export interface ProximityResult {
  perRow: ProximityRowResult[]
  /** GEOID → miles to the nearest target, over the county's nearest row. */
  values: Record<string, number>
  /** GEOID → distinct targets within the radius, when one was asked for. */
  counts?: Record<string, number>
  stats: ProximityStats
}

/**
 * For each row of A: the nearest target, and optionally how many are within
 * *n* miles. Plus the county projection both interfaces can read.
 *
 * **The projection is the one compromise and it is deliberate.** P7-2's reader
 * is keyed on the county GEOID because county polygons are what the canvas
 * draws, so a GEOID is the only key *both* interfaces can read; a column keyed
 * on a row of the anchor table would be readable by the table alone. The
 * per-row numbers are the analysis and are kept in full beside the manifest;
 * the county column is the projection of them, and the two aggregations are
 * the only honest ones:
 *
 *  - **distance: the NEAREST row's.** The Memphis cluster is four sites in
 *    47157, so this is not an edge case. "How close does this county get to
 *    the wire" is a fact; a mean of four unrelated sites is not.
 *  - **count: DISTINCT targets across the county's rows.** Two sites each near
 *    both corridors is two corridors in that county, not four — a sum would
 *    count the same wire twice.
 *
 * A county whose rows reach nothing gets a count of **0**, not an absence:
 * "no transmission line within five miles of this site" is the finding.
 */
export function measureProximity(
  rows: readonly ProximityRow[],
  targets: readonly PreparedTarget[],
  options: ProximityOptions = {},
): ProximityResult {
  const within = typeof options.within === 'number' && options.within > 0 ? options.within : null
  const perRow: ProximityRowResult[] = []
  const values: Record<string, number> = {}
  const counts: Record<string, number> | undefined = within === null ? undefined : {}
  // One set per county, holding target indices. Bounded by the target count,
  // and only for counties that have rows — the bulk pass's memory lives here.
  const reached = new Map<string, Set<number>>()
  const stats: ProximityStats = {
    rows: rows.length,
    measured: 0,
    withoutPoint: 0,
    withoutCounty: 0,
    counties: 0,
    targets: targets.length,
    vertices: targets.reduce((n, t) => n + t.vertices, 0),
  }

  for (const row of rows) {
    if (row.lat === null || row.lng === null || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)) {
      stats.withoutPoint += 1
      perRow.push({ index: row.index, label: row.label, geoid: row.geoid, miles: null, nearest: '', within: null })
      continue
    }
    stats.measured += 1
    if (!row.geoid) stats.withoutCounty += 1

    const phi = row.lat * RAD
    const lam = row.lng * RAD
    const cosPhi = Math.cos(phi)
    const px = cosPhi * Math.cos(lam)
    const py = cosPhi * Math.sin(lam)
    const pz = Math.sin(phi)

    let bestMiles = Infinity
    let bestLabel = ''
    let near: Set<number> | null = within === null ? null : new Set<number>()

    for (const target of targets) {
      const bound = boxLowerBoundMiles(row.lat, row.lng, target)
      // Skippable only when the box is already further than both questions
      // need. With a radius asked for, the count needs every feature inside it
      // even once the nearest is known.
      if (bound >= bestMiles && (within === null || bound > within)) continue
      const miles = EARTH_MILES * angleToTarget(px, py, pz, target)
      if (miles < bestMiles) {
        bestMiles = miles
        bestLabel = target.label
      }
      if (near && miles <= within!) near.add(target.index)
    }

    const miles = Number.isFinite(bestMiles) ? stored(bestMiles) : null
    perRow.push({
      index: row.index,
      label: row.label,
      geoid: row.geoid,
      miles,
      nearest: miles === null ? '' : bestLabel,
      within: near ? near.size : null,
    })

    if (!row.geoid) continue
    if (miles !== null && (values[row.geoid] === undefined || miles < values[row.geoid])) {
      values[row.geoid] = miles
    }
    if (near) {
      const union = reached.get(row.geoid)
      if (union) for (const i of near) union.add(i)
      else reached.set(row.geoid, new Set(near))
    }
  }

  if (counts) for (const [geoid, union] of reached) counts[geoid] = union.size
  stats.counties = Object.keys(values).length
  return { perRow, values, ...(counts ? { counts } : {}), stats }
}

// --- The ceiling, which belongs to the request and not to the maths ---------

/**
 * Why this request will not run, or null.
 *
 * §F.4b's recommendation in one function: *"an explicit row-count ceiling that
 * refuses rather than crawls, and keep tier 1 as the answer for everything
 * above it."* **Crawling is the failure mode being avoided** — a request that
 * takes four minutes ties up the single Railway instance whose rate-limit and
 * budget counters are in-memory, and the caller cannot tell it from a hang. So
 * the refusal is a sentence that names the local pass, which is the thing that
 * *can* do the job.
 *
 * The CLI deliberately does not call this. Same primitive, different home.
 */
export function proximityRefusal(rows: number, vertices: number, within?: number | null): string | null {
  if (rows === 0) return 'That table has no rows to measure from.'
  if (vertices === 0) return 'That layer has no features to measure to.'
  if (within !== undefined && within !== null) {
    if (!(within > 0)) return 'A “within” radius has to be more than zero miles.'
    if (within > PROXIMITY_WITHIN_MAX) {
      return `A “within” radius of ${PROXIMITY_WITHIN_MAX} miles is the widest this counts; past that it is counting the whole layer rather than measuring proximity.`
    }
  }
  if (rows > PROXIMITY_ROWS_MAX) {
    return (
      `${rows.toLocaleString()} rows is a batch job, not a request — this runs at most ` +
      `${PROXIMITY_ROWS_MAX.toLocaleString()} rows so it answers rather than crawls. ` +
      `Run it locally instead: npm run library -- proximity <set> --to <layer> [--within <miles>], ` +
      `then push and reindex.`
    )
  }
  if (rows * vertices > PROXIMITY_SEGMENT_BUDGET) {
    return (
      `${rows.toLocaleString()} rows against ${vertices.toLocaleString()} vertices is ` +
      `${(rows * vertices).toLocaleString()} point-to-segment tests, past the ` +
      `${PROXIMITY_SEGMENT_BUDGET.toLocaleString()} this runs in a request. The row count alone cannot ` +
      `see this — a few hundred transmission corridors can be millions of vertices. ` +
      `Run it locally instead: npm run library -- proximity <set> --to <layer> [--within <miles>], ` +
      `then push and reindex.`
    )
  }
  return null
}

/** The sentence a column's `method` carries, so a story quoting the number can
 *  say what made it. One line, because that is what the column has room for
 *  and what a header tooltip can show. */
export function proximityMethod(input: {
  from: string
  to: string
  stats: ProximityStats
  within?: number | null
}): string {
  const { from, to, stats } = input
  const parts = [
    `Great-circle miles from each of ${stats.rows.toLocaleString()} ${stats.rows === 1 ? 'row' : 'rows'} of ${from}` +
      ` to the nearest of ${stats.targets.toLocaleString()} ${stats.targets === 1 ? 'feature' : 'features'} of ${to}`,
  ]
  if (input.within) parts.push(`counting features within ${input.within} miles`)
  parts.push(`point-to-segment where the feature is a line`)
  parts.push(`by county, the nearest row's distance (distinct features for a count)`)
  if (stats.withoutPoint) parts.push(`${stats.withoutPoint} ${stats.withoutPoint === 1 ? 'row has' : 'rows have'} no coordinates`)
  if (stats.withoutCounty) parts.push(`${stats.withoutCounty} measured but not placed in a county`)
  return `${parts.join('; ')}.`
}

/** Exported for the one caller that needs the raw haversine for a point
 *  target and should not re-derive the radius. */
export { distanceMiles }
