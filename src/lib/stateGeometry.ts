/**
 * State outlines (P7-9), dissolved from the county polygons the map already
 * has.
 *
 * ## Where state geometry comes from, and what it costs
 *
 * Nowhere new. The public map's first load is already 3.5 MB and P5-90 went
 * to real trouble to prebuild and content-hash it, so this ticket adds **no
 * bytes to any payload**: no third build artifact, no manifest key, no second
 * fetch. `fetchCountiesGeoJSON()` is a shared, cached download that every map
 * makes anyway — the county source is what the choropleths and the hover
 * outline are drawn from — and a state is the union of its counties.
 *
 * The cost is one dissolve, on the main thread, the first time a state layer
 * goes on in a session, over a result that is then cached for the session.
 * The alternative considered was a build-time `states.<hash>.geojson`: ~300 kB
 * of CDN bytes and a lazy fetch for geometry we already hold, a third file in
 * `datasets/build/` (which means the bundle-leak gate's filename pattern, kept
 * deliberately in two places, plus the build spec's "exactly two files"
 * assertions), and a second copy of the same boundaries that could drift from
 * the counties drawn under it. Deriving instead means a state can never
 * disagree with its own counties, including about the 4-decimal rounding
 * P5-90 ships them at.
 *
 * ## How the dissolve works
 *
 * Not a polygon union — **edge cancellation**, which a county tessellation
 * makes exact. Every county ring is a closed loop of directed edges. Where two
 * counties of the same state meet, they traverse the shared boundary in
 * opposite directions, so that edge appears twice and in both directions; an
 * edge on the state line appears once. Drop every edge whose reverse is also
 * present and the survivors are precisely the state's boundary. Stitch them
 * head-to-tail and they close into rings.
 *
 * This needs shared county edges to be written with identical vertices, which
 * is a property of the Census file the map ships (and survives P5-90's
 * rounding, because both copies round the same way). It is not assumed: the
 * result reports how many boundary edges it could NOT close into a ring, a
 * test asserts that is zero for a fixture, and the number is the thing to
 * look at if a future `--geometry` candidate ever draws a ragged state.
 */
import { fetchCountiesGeoJSON } from '@/composables/useMapData'
import type { CountiesGeoJSON } from '@/types/mapTypes'

/** A state's outline. One closed ring is a `Polygon`, several a
 *  `MultiPolygon` — the same "say what it is" rule P7-3 applied to lines. */
export type StateOutlineGeometry =
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] }

export interface StateOutlines {
  /** 2-digit FIPS → outline. The key every county GEOID begins with. */
  byFips: Map<string, StateOutlineGeometry>
  /** Boundary edges that closed into no ring. Zero for the shipped counties;
   *  anything else means the county file's shared edges stopped matching. */
  dropped: number
}

/** A vertex as a map key. The coordinates are compared, never computed on,
 *  so their own spelling is the identity — no epsilon, no rounding. */
function keyOf(vertex: readonly number[]): string {
  return `${vertex[0]},${vertex[1]}`
}

function vertexOf(key: string): [number, number] {
  const comma = key.indexOf(',')
  return [Number(key.slice(0, comma)), Number(key.slice(comma + 1))]
}

/** Every linear ring of a Polygon or MultiPolygon, as raw coordinate arrays. */
function ringsOf(geometry: unknown): number[][][] {
  const g = geometry as { type?: string; coordinates?: unknown } | null
  if (!g || !Array.isArray(g.coordinates)) return []
  if (g.type === 'Polygon') return g.coordinates as number[][][]
  if (g.type === 'MultiPolygon') return (g.coordinates as number[][][][]).flat()
  return []
}

/**
 * The state outlines of a county collection.
 *
 * Pure, and the whole of the geometry decision: the counties go in, 50-odd
 * state boundaries come out, and nothing is fetched or cached here.
 */
export function dissolveStateOutlines(counties: CountiesGeoJSON): StateOutlines {
  /** state FIPS → directed edge keys ("from|to"). */
  const edgesByState = new Map<string, Set<string>>()
  for (const feature of counties?.features ?? []) {
    // The 2-digit prefix of the GEOID, which is the definition of a state's
    // FIPS. `STATEFP` is only ever the same two digits and is optional on the
    // type, so the required field is the one read.
    const geoId = String(feature?.properties?.GEOID ?? '')
    const fips = geoId.length >= 2 ? geoId.slice(0, 2) : ''
    if (!fips) continue
    let edges = edgesByState.get(fips)
    if (!edges) edgesByState.set(fips, (edges = new Set()))
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 0; i + 1 < ring.length; i++) {
        const from = keyOf(ring[i])
        const to = keyOf(ring[i + 1])
        if (from !== to) edges.add(`${from}|${to}`)
      }
    }
  }

  const byFips = new Map<string, StateOutlineGeometry>()
  let dropped = 0
  for (const [fips, edges] of edgesByState) {
    // An interior edge is one whose reverse is also there. What is left is
    // the state line.
    const next = new Map<string, string[]>()
    let boundary = 0
    for (const edge of edges) {
      const bar = edge.indexOf('|')
      const from = edge.slice(0, bar)
      const to = edge.slice(bar + 1)
      if (edges.has(`${to}|${from}`)) continue
      boundary++
      const out = next.get(from)
      if (out) out.push(to)
      else next.set(from, [to])
    }

    const rings: [number, number][][] = []
    const used = new Set<string>()
    for (const [start, firsts] of next) {
      for (const first of firsts) {
        if (used.has(`${start}|${first}`)) continue
        const ring: string[] = [start, first]
        used.add(`${start}|${first}`)
        let at = first
        // Bounded by the edge count: every step consumes one unused edge.
        while (at !== start) {
          const candidates = next.get(at)
          const step = candidates?.find(c => !used.has(`${at}|${c}`))
          if (step === undefined) break
          used.add(`${at}|${step}`)
          ring.push(step)
          at = step
        }
        if (at === start && ring.length > 3) rings.push(ring.map(vertexOf))
      }
    }
    // Boundary edges that are in no closed ring: a walk that ran into a dead
    // end, or a fragment nothing reached.
    dropped += boundary - rings.reduce((n, r) => n + r.length - 1, 0)
    if (rings.length === 0) continue
    // Every closed ring is its own polygon, so none of them is read as a hole
    // in another: a state's interior is fully covered by its counties, so the
    // dissolve leaves no void for a hole to be.
    byFips.set(
      fips,
      rings.length === 1 ? { type: 'Polygon', coordinates: [rings[0]] } : { type: 'MultiPolygon', coordinates: rings.map(r => [r]) },
    )
  }
  return { byFips, dropped }
}

/** In-flight or settled dissolve, shared by every caller and every map in the
 *  page — the same rule the county download itself follows (P6-10). */
let outlinesRequest: Promise<StateOutlines> | null = null

/**
 * The state outlines, dissolved once per session.
 *
 * Fetches nothing of its own: it asks for the county polygons through the
 * same shared, cached promise the canvas uses, so in a map that has already
 * started this is pure CPU over an object already in memory. A failed county
 * download evicts the cached promise, so the next state layer retries rather
 * than replaying the error.
 */
export function stateOutlines(): Promise<StateOutlines> {
  outlinesRequest ??= fetchCountiesGeoJSON()
    .then(dissolveStateOutlines)
    .catch(error => {
      outlinesRequest = null
      throw error
    })
  return outlinesRequest
}

/** Test seam: forget the dissolve. */
export function clearStateOutlines(): void {
  outlinesRequest = null
}
