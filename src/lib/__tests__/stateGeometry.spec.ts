import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/** The shared county download, stubbed: the point of the cache test below is
 *  that a state layer fetches nothing of its own. */
const fetchCounties = vi.hoisted(() => vi.fn())
vi.mock('@/composables/useMapData', () => ({ fetchCountiesGeoJSON: fetchCounties }))

import { dissolveStateOutlines, stateOutlines, clearStateOutlines, type StateOutlineGeometry } from '../stateGeometry'
import type { CountiesGeoJSON } from '@/types/mapTypes'

/**
 * P7-9: where state geometry comes from. Nowhere new — the county polygons
 * the map has already downloaded, dissolved by edge cancellation.
 *
 * The fixture is a 2×3 grid of unit-square counties: two states side by side,
 * each three counties tall, sharing the x=1 meridian. Small enough to assert
 * the exact ring, which is the only way to know the cancellation worked rather
 * than happened to look plausible.
 *
 *     y=3  +---+---+
 *          |10 |20 |     state 10 = three squares, x in [0,1]
 *     y=2  +---+---+     state 20 = three squares, x in [1,2]
 *          |10 |20 |
 *     y=1  +---+---+
 *          |10 |20 |
 *     y=0  +---+---+
 *          x=0 x=1 x=2
 */
function square(x: number, y: number): [number, number][] {
  // Counter-clockwise, closed — the winding GeoJSON asks for an outer ring.
  return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]
}

function county(geoId: string, x: number, y: number) {
  return {
    type: 'Feature' as const,
    properties: { GEOID: geoId, NAME: geoId, STATEFP: geoId.slice(0, 2) },
    geometry: { type: 'Polygon' as const, coordinates: [square(x, y)] },
  }
}

const grid: CountiesGeoJSON = {
  type: 'FeatureCollection',
  features: [
    county('10001', 0, 0), county('10003', 0, 1), county('10005', 0, 2),
    county('20001', 1, 0), county('20003', 1, 1), county('20005', 1, 2),
  ],
} as unknown as CountiesGeoJSON

/** A ring as a set of vertices, so an assertion does not depend on which
 *  vertex the walk happened to start at. */
function ringsOf(geometry: StateOutlineGeometry): string[][] {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat()
  return rings.map(ring => [...new Set(ring.map(v => v.join(',')))].sort())
}

describe('dissolveStateOutlines', () => {
  it('cancels the shared county edges and closes one ring per state', () => {
    const { byFips, dropped } = dissolveStateOutlines(grid)
    expect(dropped).toBe(0)
    expect([...byFips.keys()].sort()).toEqual(['10', '20'])

    // State 10 is the 1×3 rectangle x∈[0,1], y∈[0,3]. The two interior
    // edges at y=1 and y=2 are gone; the shared meridian at x=1 is NOT — it
    // is interior to the pair of states, not to either one.
    const ten = byFips.get('10')!
    expect(ten.type).toBe('Polygon')
    expect(ringsOf(ten)).toEqual([['0,0', '0,1', '0,2', '0,3', '1,0', '1,1', '1,2', '1,3']])
    expect(ringsOf(byFips.get('20')!)).toEqual([['1,0', '1,1', '1,2', '1,3', '2,0', '2,1', '2,2', '2,3']])
  })

  it('keeps the vertices of the counties exactly — no simplification, no rounding', () => {
    const precise: CountiesGeoJSON = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { GEOID: '13121' },
        geometry: { type: 'Polygon', coordinates: [[[-84.5512, 33.7489], [-84.3881, 33.7489], [-84.3881, 33.8871], [-84.5512, 33.7489]]] },
      }],
    } as unknown as CountiesGeoJSON
    const outline = dissolveStateOutlines(precise).byFips.get('13')!
    expect(outline.coordinates[0]).toEqual([[-84.5512, 33.7489], [-84.3881, 33.7489], [-84.3881, 33.8871], [-84.5512, 33.7489]])
  })

  it('reads the state off the GEOID, which is the required field, and skips a county without one', () => {
    const odd: CountiesGeoJSON = {
      type: 'FeatureCollection',
      features: [
        // STATEFP disagrees with the GEOID; the GEOID wins, because it is the
        // key every other county number in this app is filed under.
        { ...county('10001', 0, 0), properties: { GEOID: '10001', NAME: 'x', STATEFP: '99' } },
        { ...county('10003', 0, 1), properties: { GEOID: '', NAME: 'nowhere' } },
      ],
    } as unknown as CountiesGeoJSON
    const { byFips } = dissolveStateOutlines(odd)
    expect([...byFips.keys()]).toEqual(['10'])
    // Only the one square survived, so the ring is that square.
    expect(ringsOf(byFips.get('10')!)).toEqual([['0,0', '0,1', '1,0', '1,1']])
  })

  it('gives a state with detached parts a MultiPolygon, every ring its own part', () => {
    const islands: CountiesGeoJSON = {
      type: 'FeatureCollection',
      features: [county('15001', 0, 0), county('15003', 5, 5)],
    } as unknown as CountiesGeoJSON
    const outline = dissolveStateOutlines(islands).byFips.get('15')!
    expect(outline.type).toBe('MultiPolygon')
    expect(outline.coordinates).toHaveLength(2)
    // Each part has exactly one ring, so nothing can be read as a hole.
    for (const part of outline.coordinates as [number, number][][][]) expect(part).toHaveLength(1)
  })

  it('counts boundary edges it cannot close rather than drawing an open ring', () => {
    // One lone edge: a "county" that is not a closed ring at all.
    const broken: CountiesGeoJSON = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { GEOID: '10001' },
        geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0]]] },
      }],
    } as unknown as CountiesGeoJSON
    const { byFips, dropped } = dissolveStateOutlines(broken)
    expect(dropped).toBe(1)
    expect(byFips.size).toBe(0)
  })

  it('takes rings from a MultiPolygon county and ignores a geometry it cannot read', () => {
    const mixed: CountiesGeoJSON = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { GEOID: '10001' }, geometry: { type: 'MultiPolygon', coordinates: [[square(0, 0)], [square(0, 1)]] } },
        { type: 'Feature', properties: { GEOID: '10003' }, geometry: { type: 'Point', coordinates: [0, 0] } },
        { type: 'Feature', properties: { GEOID: '10005' }, geometry: null },
      ],
    } as unknown as CountiesGeoJSON
    const { byFips, dropped } = dissolveStateOutlines(mixed)
    expect(dropped).toBe(0)
    expect(ringsOf(byFips.get('10')!)).toEqual([['0,0', '0,1', '0,2', '1,0', '1,1', '1,2']])
  })

  it('is empty, not a throw, for a collection with nothing in it', () => {
    expect(dissolveStateOutlines({ type: 'FeatureCollection', features: [] } as unknown as CountiesGeoJSON))
      .toEqual({ byFips: new Map(), dropped: 0 })
    expect(dissolveStateOutlines(undefined as unknown as CountiesGeoJSON).byFips.size).toBe(0)
  })
})

/**
 * The cache. This is the whole payload argument: the dissolve asks for the
 * counties through the SAME shared promise the canvas uses, so a state layer
 * downloads nothing of its own and a second state layer dissolves nothing
 * twice.
 */
describe('stateOutlines', () => {
  beforeEach(() => {
    clearStateOutlines()
    fetchCounties.mockReset()
    fetchCounties.mockResolvedValue(grid)
  })
  afterEach(() => clearStateOutlines())

  it('dissolves once per session however many layers ask', async () => {
    const first = await stateOutlines()
    const second = await stateOutlines()
    expect(second).toBe(first)
    expect(fetchCounties).toHaveBeenCalledTimes(1)
    expect(first.byFips.size).toBe(2)
  })

  it('retries after a failed county download rather than caching the error', async () => {
    fetchCounties.mockRejectedValueOnce(new Error('offline'))
    await expect(stateOutlines()).rejects.toThrow('offline')
    fetchCounties.mockResolvedValueOnce(grid)
    expect((await stateOutlines()).byFips.size).toBe(2)
    expect(fetchCounties).toHaveBeenCalledTimes(2)
  })
})
