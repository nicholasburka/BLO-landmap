/**
 * Counting points into counties, in the browser (P9-7, spec §E).
 *
 * "Done by hand for CEJST; generalise it." A point layer answers *where
 * things are*; a county layer answers *how many are here*, and the second is
 * what an index can weigh. This is the bridge, and it is the one free
 * analysis that MAKES a measure rather than describing one.
 *
 * Point features carry coordinates and no GEOID — checked on
 * `redevelopment-sites`, whose properties are a label and an address — so
 * this is a real point-in-polygon pass against the county geometry the map
 * has already downloaded. Nothing is fetched and nothing is written: the
 * numbers come back and the caller decides what they are for.
 */
import type { CountyFeature } from '@/types/mapTypes'
import type { LayerValues } from '@/lib/layerStats'

export interface Rollup {
  /** GEOID → how many points landed in it. Counties with none are absent,
   *  which is NOT the same as zero — see `rollupLine`. */
  values: LayerValues
  /** Points that landed in a county. */
  placed: number
  /** Points inside no county at all: offshore, a bad coordinate, or a
   *  territory the geometry does not carry. Counted, never dropped (P6-23). */
  unplaced: number
  /** Counties holding at least one. */
  counties: number
}

type Ring = number[][]

/** A county, reduced to what the test needs: its rings and a bounding box. */
interface Shape {
  geoId: string
  rings: Ring[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function ringsOf(feature: CountyFeature): Ring[] {
  const geometry = feature.geometry
  if (!geometry) return []
  if (geometry.type === 'Polygon') return geometry.coordinates as Ring[]
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Ring[][]).flat()
  return []
}

/**
 * Is the point inside the ring? Ray casting, counting crossings of a
 * half-open edge so a point exactly on a shared boundary lands in exactly one
 * of the two counties rather than both or neither.
 */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Inside the county, holes excluded.
 *
 * A polygon's first ring is its outline and the rest are holes, but a
 * MultiPolygon flattened here loses which is which — so the parity rule is
 * used instead: an odd number of containing rings is inside, an even number
 * (outline plus hole) is out. That is the same answer for both shapes.
 */
function inShape(x: number, y: number, shape: Shape): boolean {
  if (x < shape.minX || x > shape.maxX || y < shape.minY || y > shape.maxY) return false
  let crossings = 0
  for (const ring of shape.rings) if (inRing(x, y, ring)) crossings++
  return crossings % 2 === 1
}

/**
 * Counties bucketed by whole degree, so a point tests against the handful
 * near it instead of all 3,144.
 *
 * Worth the twenty lines: the feature cap is 20,000 points, and 20,000 ×
 * 3,144 bounding-box tests is tens of millions of comparisons for an answer
 * that should land in the same frame as the question.
 */
function indexCounties(counties: readonly CountyFeature[]): Map<string, Shape[]> {
  const grid = new Map<string, Shape[]>()
  for (const county of counties) {
    const geoId = String(county.properties?.GEOID ?? '')
    if (!geoId) continue
    const rings = ringsOf(county)
    if (!rings.length) continue
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const shape: Shape = { geoId, rings, minX, minY, maxX, maxY }
    for (let cx = Math.floor(minX); cx <= Math.floor(maxX); cx++) {
      for (let cy = Math.floor(minY); cy <= Math.floor(maxY); cy++) {
        const key = `${cx}:${cy}`
        const cell = grid.get(key)
        if (cell) cell.push(shape)
        else grid.set(key, [shape])
      }
    }
  }
  return grid
}

/** The [lng, lat] of a feature, or null for anything that is not a point. */
function pointOf(feature: GeoJSON.Feature): [number, number] | null {
  const geometry = feature.geometry
  if (!geometry || geometry.type !== 'Point') return null
  const [x, y] = geometry.coordinates as number[]
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

/** How many of these points are in each county. */
export function countPointsByCounty(
  features: readonly GeoJSON.Feature[],
  counties: readonly CountyFeature[],
): Rollup {
  const grid = indexCounties(counties)
  const values: LayerValues = {}
  let placed = 0
  let unplaced = 0
  for (const feature of features) {
    const point = pointOf(feature)
    if (!point) {
      unplaced++
      continue
    }
    const [x, y] = point
    const candidates = grid.get(`${Math.floor(x)}:${Math.floor(y)}`) ?? []
    const hit = candidates.find(shape => inShape(x, y, shape))
    if (!hit) {
      unplaced++
      continue
    }
    values[hit.geoId] = (values[hit.geoId] ?? 0) + 1
    placed++
  }
  return { values, placed, unplaced, counties: Object.keys(values).length }
}

/**
 * Which county contains this point — the other direction (P9-11).
 *
 * A geocoded address gives coordinates; what makes it "in the context of the
 * data" is the county GEOID, because every layer in a set is keyed on one.
 * Same machinery as the rollup, so an address and a rolled-up point agree
 * about which county they are in, and no second network call is needed to
 * ask anybody.
 *
 * The index is cached against the county array it was built from: 3,144
 * shapes is real work, and a reader typing an address will ask several times
 * against the same geometry.
 */
const indexCache = new WeakMap<object, Map<string, Shape[]>>()

export function countyAt(lng: number, lat: number, counties: readonly CountyFeature[]): string | null {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !counties.length) return null
  let grid = indexCache.get(counties as object)
  if (!grid) {
    grid = indexCounties(counties)
    indexCache.set(counties as object, grid)
  }
  const candidates = grid.get(`${Math.floor(lng)}:${Math.floor(lat)}`) ?? []
  return candidates.find(shape => inShape(lng, lat, shape))?.geoId ?? null
}

/**
 * What the rollup did, including what it could not place.
 *
 * The shortfall is never folded into a tidier number (P6-23): a point in no
 * county is a thing to go and look at, not a row to quietly lose.
 */
export function rollupLine(rollup: Rollup): string {
  const points = (k: number) => `${k.toLocaleString()} ${k === 1 ? 'point' : 'points'}`
  const counties = (k: number) => `${k.toLocaleString()} ${k === 1 ? 'county' : 'counties'}`
  if (!rollup.placed && !rollup.unplaced) return 'Nothing to count.'
  const line = `${points(rollup.placed)} in ${counties(rollup.counties)}`
  if (!rollup.unplaced) return `${line}.`
  return `${line} · ${points(rollup.unplaced)} fell in no county`
}
