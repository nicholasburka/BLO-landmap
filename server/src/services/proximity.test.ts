import { describe, it, expect } from 'vitest'
import { distanceMiles } from './placeAdapters/shared.js'
import { normalizeGeoId } from './internalLayers.js'
import {
  PROXIMITY_ROWS_MAX,
  PROXIMITY_SEGMENT_BUDGET,
  PROXIMITY_WITHIN_MAX,
  distanceToTargetMiles,
  measureProximity,
  prepareTargets,
  proximityRefusal,
  targetsFromFeatures,
} from './proximity.js'

/** A due-north/south line through Memphis, one degree of latitude long. */
const MERIDIAN = { label: 'Meridian', path: [[-90, 34.5], [-90, 35.5]] }

function rows(...entries: { lat?: number; lng?: number; geoid?: string; label?: string }[]) {
  return entries.map((e, i) => ({
    index: i,
    label: e.label ?? `row ${i}`,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    geoid: e.geoid ?? null,
  }))
}

describe('point-to-point distance', () => {
  it('agrees with the place report’s own haversine, exactly', () => {
    // One primitive, one answer: a degenerate target (a point) must not give a
    // number the organization list beside it would disagree with.
    const [target] = prepareTargets([{ label: 'Valero', lat: 35.081, lng: -90.078 }])
    const site = { lat: 35.06, lng: -90.152 }
    expect(distanceToTargetMiles(site, target)).toBeCloseTo(distanceMiles(site, { lat: 35.081, lng: -90.078 }), 10)
  })

  it('is zero at the target itself', () => {
    const [target] = prepareTargets([{ label: 'here', lat: 35, lng: -90 }])
    expect(distanceToTargetMiles({ lat: 35, lng: -90 }, target)).toBe(0)
  })
})

describe('point-to-line distance', () => {
  it('measures perpendicular to the segment, not to its nearest vertex', () => {
    // The whole reason P7-3 refused to give a line a centroid. A point due
    // east of the middle of a meridian is 1 degree of longitude away from the
    // LINE and much further from either end.
    const [line] = prepareTargets([MERIDIAN])
    const abeam = { lat: 35, lng: -89 }
    const perpendicular = distanceToTargetMiles(abeam, line)
    const toNearestVertex = Math.min(
      distanceMiles(abeam, { lat: 34.5, lng: -90 }),
      distanceMiles(abeam, { lat: 35.5, lng: -90 }),
    )
    expect(perpendicular).toBeCloseTo(distanceMiles(abeam, { lat: 35, lng: -90 }), 1)
    expect(perpendicular).toBeLessThan(toNearestVertex)
  })

  it('is zero on the line itself', () => {
    const [line] = prepareTargets([MERIDIAN])
    expect(distanceToTargetMiles({ lat: 35, lng: -90 }, line)).toBeCloseTo(0, 6)
  })

  it('falls back to the endpoint once past the end of the segment', () => {
    // Beyond the end there is no perpendicular foot on the arc, and the honest
    // answer is the distance to the end of the wire.
    const [line] = prepareTargets([MERIDIAN])
    const beyond = { lat: 36.5, lng: -90 }
    expect(distanceToTargetMiles(beyond, line)).toBeCloseTo(distanceMiles(beyond, { lat: 35.5, lng: -90 }), 6)
  })

  it('takes the nearest part of a MultiLineString', () => {
    const [multi] = prepareTargets([
      { label: 'Two corridors', path: [[[-90, 34.5], [-90, 35.5]], [[-88, 34.5], [-88, 35.5]]] },
    ])
    const nearTheSecond = { lat: 35, lng: -88.1 }
    expect(distanceToTargetMiles(nearTheSecond, multi)).toBeCloseTo(
      distanceMiles(nearTheSecond, { lat: 35, lng: -88 }),
      1,
    )
  })

  it('survives a repeated vertex rather than dividing by zero', () => {
    const [line] = prepareTargets([{ label: 'Doubled', path: [[-90, 35], [-90, 35], [-90, 35.5]] }])
    expect(distanceToTargetMiles({ lat: 35.25, lng: -89.9 }, line)).toBeGreaterThan(0)
    expect(Number.isFinite(distanceToTargetMiles({ lat: 35.25, lng: -89.9 }, line))).toBe(true)
  })

  it('reads a one-part path and a multi-part path the same way', () => {
    const [flat] = prepareTargets([{ label: 'a', path: [[-90, 34.5], [-90, 35.5]] }])
    const [nested] = prepareTargets([{ label: 'a', path: [[[-90, 34.5], [-90, 35.5]]] }])
    const site = { lat: 35, lng: -89.5 }
    expect(distanceToTargetMiles(site, flat)).toBeCloseTo(distanceToTargetMiles(site, nested), 10)
  })

  it('drops a target with no usable geometry rather than measuring to nothing', () => {
    expect(prepareTargets([{ label: 'empty', path: [] }])).toEqual([])
    expect(prepareTargets([{ label: 'one vertex', path: [[-90, 35]] }])).toEqual([])
    expect(prepareTargets([{ label: 'no geometry' }])).toEqual([])
  })
})

describe('the bounding-box prefilter', () => {
  it('never skips a feature that is actually nearer — checked against the brute force', () => {
    // The prefilter is the only reason the bulk pass is tractable, and a
    // prefilter that over-estimates silently returns the wrong nearest
    // feature. So the bound is checked against the answer it is allowed to
    // skip, over a spread of real-ish geometry.
    const targets = prepareTargets(
      Array.from({ length: 40 }, (_, i) => ({
        label: `line ${i}`,
        path: [
          [-124 + i * 1.4, 26 + (i % 7) * 2.5],
          [-124 + i * 1.4 + 0.9, 26 + (i % 7) * 2.5 + 1.3],
        ] as [number, number][],
      })),
    )
    for (let n = 0; n < 60; n++) {
      const point = { lat: 25 + (n * 37) % 24, lng: -125 + (n * 53) % 58 }
      const brute = Math.min(...targets.map(t => distanceToTargetMiles(point, t)))
      const measured = measureProximity(rows({ ...point, geoid: '47157' }), targets, {})
      // Exact equality against the rounded brute force: anything the prefilter
      // wrongly skipped would be out by miles, not by a rounding place.
      expect(measured.perRow[0].miles).toBe(Math.round(brute * 1e4) / 1e4)
    }
  })

  it('does not skip across the antimeridian, where a naive gap reads 358°', () => {
    // The Aleutians are the only US geometry this can bite, and the failure
    // mode is a silent wrong answer rather than an error.
    const [line] = prepareTargets([{ label: 'Attu', path: [[179.5, 52.8], [179.9, 52.9]] }])
    const point = { lat: 52.85, lng: -179.8 }
    expect(distanceToTargetMiles(point, line)).toBeLessThan(30)
  })
})

describe('measureProximity — the per-row result', () => {
  const targets = prepareTargets([
    { label: 'Line A', path: [[-90, 34.5], [-90, 35.5]] },
    { label: 'Substation', lat: 35.2, lng: -89.5 },
  ])

  it('names the nearest target for every row that has a point', () => {
    const result = measureProximity(rows({ lat: 35, lng: -89.95, geoid: '47157' }), targets, {})
    expect(result.perRow[0]).toMatchObject({ nearest: 'Line A', geoid: '47157' })
    expect(result.perRow[0].miles).toBeLessThan(4)
  })

  it('reports a row with no coordinates rather than scoring it zero', () => {
    const result = measureProximity(rows({ geoid: '47157' }, { lat: 35, lng: -90, geoid: '47157' }), targets, {})
    expect(result.perRow[0]).toMatchObject({ miles: null, nearest: '' })
    expect(result.stats).toMatchObject({ rows: 2, measured: 1, withoutPoint: 1 })
  })

  it('measures a row with no county and says so, rather than dropping it', () => {
    // The row still gets its number — "distance from site to development" is a
    // fact about the site. It just cannot reach a county-keyed column, and a
    // count that disagreed with the rows it measured would be the P6-23 sin.
    const result = measureProximity(rows({ lat: 35, lng: -90 }), targets, {})
    expect(result.perRow[0].miles).toBeCloseTo(0, 5)
    expect(result.stats).toMatchObject({ measured: 1, withoutCounty: 1, counties: 0 })
    expect(result.values).toEqual({})
  })

  it('counts targets within n miles, and only when a radius was asked', () => {
    const near = measureProximity(rows({ lat: 35, lng: -89.9, geoid: '47157' }), targets, { within: 60 })
    expect(near.perRow[0].within).toBe(2)
    // 0.1° of longitude at 35°N is 5.7 miles, so a 6-mile radius reaches the
    // line and not the substation 26 miles away.
    const tight = measureProximity(rows({ lat: 35, lng: -89.9, geoid: '47157' }), targets, { within: 6 })
    expect(tight.perRow[0].within).toBe(1)
    const none = measureProximity(rows({ lat: 35, lng: -89.9, geoid: '47157' }), targets, {})
    expect(none.perRow[0].within).toBeNull()
    expect(none.counts).toBeUndefined()
  })
})

describe('measureProximity — the county projection', () => {
  const targets = prepareTargets([
    { label: 'Line A', path: [[-90, 34.5], [-90, 35.5]] },
    { label: 'Line B', path: [[-89, 34.5], [-89, 35.5]] },
  ])

  it('keys on the 5-digit county GEOID, which is what both interfaces read', () => {
    const result = measureProximity(rows({ lat: 35, lng: -89.9, geoid: '47157' }), targets, {})
    expect(Object.keys(result.values)).toEqual(['47157'])
  })

  it('takes the NEAREST of several rows in one county', () => {
    // The Memphis cluster is four sites in 47157, which is why this is not an
    // edge case. "How close does this county get" is the only reading of a
    // county-keyed distance that is not an average of unrelated things.
    const result = measureProximity(
      rows(
        { lat: 35, lng: -89.2, geoid: '47157', label: 'far' },
        { lat: 35, lng: -89.95, geoid: '47157', label: 'near' },
      ),
      targets,
      {},
    )
    expect(result.values['47157']).toBeCloseTo(
      Math.min(
        distanceMiles({ lat: 35, lng: -89.2 }, { lat: 35, lng: -89 }),
        distanceMiles({ lat: 35, lng: -89.95 }, { lat: 35, lng: -90 }),
      ),
      1,
    )
    expect(result.stats.counties).toBe(1)
  })

  it('counts DISTINCT targets across a county’s rows, never the sum', () => {
    // Two sites each within reach of both lines is two lines in that county,
    // not four. A sum would double-count the same wire.
    const result = measureProximity(
      rows({ lat: 35, lng: -89.5, geoid: '47157' }, { lat: 35.1, lng: -89.5, geoid: '47157' }),
      targets,
      { within: 40 },
    )
    expect(result.perRow[0].within).toBe(2)
    expect(result.perRow[1].within).toBe(2)
    expect(result.counts?.['47157']).toBe(2)
  })

  it('writes a zero count for a county whose rows reach nothing', () => {
    // Zero is a measurement here, not a gap: "no transmission line within 5
    // miles of this site" is the finding. It must not read as "not computed".
    const result = measureProximity(rows({ lat: 40, lng: -75, geoid: '42101' }), targets, { within: 5 })
    expect(result.counts?.['42101']).toBe(0)
    expect(result.values['42101']).toBeGreaterThan(500)
  })
})

describe('the ceiling', () => {
  it('passes a working set’s worth of sites straight through', () => {
    expect(proximityRefusal(11, 2_400)).toBeNull()
  })

  it('refuses a whole brownfield layer by row count, naming the local pass', () => {
    const refusal = proximityRefusal(190_000, 2_400)
    expect(refusal).toContain('190,000')
    expect(refusal).toContain(PROXIMITY_ROWS_MAX.toLocaleString())
    expect(refusal).toContain('npm run library -- proximity')
  })

  it('refuses work the row count cannot see, naming the same pass', () => {
    // P7-3's lesson, which cost a stack overflow to learn: a few hundred
    // transmission corridors is a few hundred features and can be millions of
    // vertices, so a cap on rows alone waves through a billion segment tests.
    const refusal = proximityRefusal(1_500, 480_000)
    expect(refusal).toBeTruthy()
    expect(refusal).toContain('npm run library -- proximity')
    expect(refusal).toContain(PROXIMITY_SEGMENT_BUDGET.toLocaleString())
  })

  it('refuses nothing to measure, and says which half is empty', () => {
    expect(proximityRefusal(0, 2_400)).toContain('no rows')
    expect(proximityRefusal(11, 0)).toContain('no features')
  })

  it('bounds the radius, because a 3,000-mile “within” is not a question', () => {
    expect(proximityRefusal(11, 2_400, PROXIMITY_WITHIN_MAX + 1)).toContain(String(PROXIMITY_WITHIN_MAX))
    expect(proximityRefusal(11, 2_400, PROXIMITY_WITHIN_MAX)).toBeNull()
    expect(proximityRefusal(11, 2_400, 0)).toContain('more than zero')
  })
})

describe('targetsFromFeatures', () => {
  it('reads a point layer’s features and keeps the label the layer drew', () => {
    const targets = targetsFromFeatures([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-90.078, 35.081] },
        properties: { _label: 'Valero Memphis Refinery' },
      },
    ])
    expect(targets).toEqual([{ label: 'Valero Memphis Refinery', lat: 35.081, lng: -90.078 }])
  })

  it('reads a LineString and a MultiLineString', () => {
    const targets = targetsFromFeatures([
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-90, 34.5], [-90, 35.5]] },
        properties: { _label: 'One' },
      },
      {
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: [[[-88, 34.5], [-88, 35.5]]] },
        properties: { _label: 'Many' },
      },
    ])
    expect(targets).toHaveLength(2)
    expect(prepareTargets(targets)).toHaveLength(2)
  })

  it('counts the vertices a layer would actually make us walk', () => {
    const prepared = prepareTargets([
      { label: 'a', path: [[-90, 34], [-90, 35], [-90, 36]] },
      { label: 'b', lat: 35, lng: -90 },
    ])
    expect(prepared.reduce((n, t) => n + t.vertices, 0)).toBe(4)
  })

  it('falls back to a feature’s index when the layer gave it no label', () => {
    const targets = targetsFromFeatures([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-90, 35] }, properties: {} },
    ])
    expect(targets[0].label).toBe('Feature 1')
  })
})

describe('the row ceiling constant', () => {
  it('is well under the tabular row cap, so the refusal is about time not size', () => {
    expect(PROXIMITY_ROWS_MAX).toBeLessThan(200_000)
    expect(PROXIMITY_ROWS_MAX).toBeGreaterThanOrEqual(1_000)
  })
})

describe('the county cell, read through the server’s own normaliser', () => {
  it('forgives the three ways a GEOID column is written', () => {
    expect(normalizeGeoId('47157')).toBe('47157')
    expect(normalizeGeoId(' 1001 ')).toBe('01001')
    expect(normalizeGeoId('0500000US01001')).toBe('01001')
    // P7-5: a spreadsheet writing a numeric column as a float. Both other
    // normalisers in the codebase already forgave this one; this did not.
    expect(normalizeGeoId('47157.0')).toBe('47157')
    expect(normalizeGeoId('1001.00')).toBe('01001')
  })

  it('still refuses what is not an id', () => {
    expect(normalizeGeoId('')).toBeNull()
    expect(normalizeGeoId('47157.5')).toBeNull()
    expect(normalizeGeoId('Shelby County')).toBeNull()
    expect(normalizeGeoId('47157001100')).toBeNull()
  })
})
