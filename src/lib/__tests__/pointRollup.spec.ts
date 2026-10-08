import { describe, it, expect } from 'vitest'
import { countPointsByCounty, countyAt, rollupLine } from '@/lib/pointRollup'
import type { CountyFeature } from '@/types/mapTypes'

/**
 * Counting points into counties (P9-7).
 *
 * The one free analysis that MAKES a measure, so the things worth pinning are
 * the edges: a point on a shared border belongs to one county, a point in a
 * hole belongs to none, and a point in the sea is reported rather than lost.
 */

/** An axis-aligned box as a county, which is all the geometry a test needs. */
function box(geoId: string, x0: number, y0: number, x1: number, y1: number): CountyFeature {
  return {
    type: 'Feature',
    properties: { GEOID: geoId, NAME: geoId },
    geometry: {
      type: 'Polygon',
      coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
    },
  } as CountyFeature
}

function at(x: number, y: number): GeoJSON.Feature {
  return { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [x, y] } }
}

/** Two counties side by side, sharing the edge at x = 1. */
const WEST = box('west', 0, 0, 1, 1)
const EAST = box('east', 1, 0, 2, 1)

describe('counting points by county', () => {
  it('counts each point into the county that contains it', () => {
    const r = countPointsByCounty([at(0.5, 0.5), at(0.6, 0.2), at(1.5, 0.5)], [WEST, EAST])
    expect(r.values).toEqual({ west: 2, east: 1 })
    expect(r.placed).toBe(3)
    expect(r.unplaced).toBe(0)
    expect(r.counties).toBe(2)
  })

  it('puts a point on a shared border in exactly one county, not both', () => {
    // Which side is arbitrary; counting it twice would invent a point.
    const r = countPointsByCounty([at(1, 0.5)], [WEST, EAST])
    expect(r.placed).toBe(1)
    expect(Object.values(r.values).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('reports a point in no county rather than dropping it', () => {
    // P6-23: the shortfall is never folded into a tidier number.
    const r = countPointsByCounty([at(0.5, 0.5), at(50, 50)], [WEST, EAST])
    expect(r.placed).toBe(1)
    expect(r.unplaced).toBe(1)
    expect(rollupLine(r)).toBe('1 point in 1 county · 1 point fell in no county')
  })

  it('leaves a county with no points OUT, rather than writing a zero', () => {
    // Absent and zero are different claims, and P9-9 is open precisely
    // because something once treated them as the same.
    const r = countPointsByCounty([at(0.5, 0.5)], [WEST, EAST])
    expect(r.values).toEqual({ west: 1 })
    expect('east' in r.values).toBe(false)
  })

  it('excludes a hole in a county', () => {
    const donut = {
      type: 'Feature',
      properties: { GEOID: 'donut', NAME: 'donut' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
          [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]],
        ],
      },
    } as unknown as CountyFeature
    const r = countPointsByCounty([at(1, 1), at(5, 5)], [donut])
    expect(r.values).toEqual({ donut: 1 })
    expect(r.unplaced).toBe(1)
  })

  it('handles a county made of several pieces', () => {
    const islands = {
      type: 'Feature',
      properties: { GEOID: 'islands', NAME: 'islands' },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
        ],
      },
    } as unknown as CountyFeature
    const r = countPointsByCounty([at(0.5, 0.5), at(5.5, 5.5)], [islands])
    expect(r.values).toEqual({ islands: 2 })
  })

  it('counts a feature that is not a point as unplaced instead of throwing', () => {
    const line = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    } as GeoJSON.Feature
    const r = countPointsByCounty([line, at(0.5, 0.5)], [WEST])
    expect(r.placed).toBe(1)
    expect(r.unplaced).toBe(1)
  })

  it('finds the county a single point is in (P9-11)', () => {
    // The other direction, for an address search: a geocoder gives
    // coordinates, and the GEOID is what every layer is keyed on.
    expect(countyAt(0.5, 0.5, [WEST, EAST])).toBe('west')
    expect(countyAt(1.5, 0.5, [WEST, EAST])).toBe('east')
    expect(countyAt(80, 80, [WEST, EAST])).toBeNull()
    // A bad coordinate is nowhere, not an exception.
    expect(countyAt(NaN, 0.5, [WEST, EAST])).toBeNull()
    expect(countyAt(0.5, 0.5, [])).toBeNull()
  })

  it('says plainly when there was nothing to count', () => {
    expect(rollupLine(countPointsByCounty([], [WEST]))).toBe('Nothing to count.')
  })

  it('stays fast enough to run in the frame that asked (20,000 points)', () => {
    // The internal feature cap. Without the degree grid this is 20,000 ×
    // every county, which is tens of millions of comparisons.
    const counties: CountyFeature[] = []
    for (let x = 0; x < 50; x++) {
      for (let y = 0; y < 50; y++) counties.push(box(`c${x}-${y}`, x, y, x + 1, y + 1))
    }
    const points: GeoJSON.Feature[] = []
    for (let i = 0; i < 20000; i++) points.push(at((i % 50) + 0.5, (i % 37) + 0.5))

    const started = performance.now()
    const r = countPointsByCounty(points, counties)
    const took = performance.now() - started

    expect(r.placed).toBe(20000)
    expect(took).toBeLessThan(1000)
  })
})
