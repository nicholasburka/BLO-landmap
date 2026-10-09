import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  accessNamesAreas,
  deriveShape,
  isShapedKind,
  pickShapeFile,
  readShapeSignals,
  resetShapeWarnings,
  shapeFromManifest,
  shapeFromSignals,
  statedShape,
  PUBLIC_LAYER_SHAPE,
} from './shape.js'

/**
 * P6-2. One test per rule in the derivation, plus the two things a derivation
 * has to get right to be trusted: the manifest's own word wins, and a word the
 * vocabulary does not know is dropped loudly rather than kept quietly.
 */

beforeEach(() => resetShapeWarnings())
afterEach(() => vi.restoreAllMocks())

const dataset = (meta: Record<string, unknown>, files: string[] = []) => ({ kind: 'dataset', meta, files, slug: 'x' })
const source = (block: Record<string, unknown>) => ({ kind: 'source', meta: { source: block }, files: [], slug: 'x' })

describe('shape — the manifest’s own word', () => {
  it('wins over everything the entry would otherwise be read as', async () => {
    // A point layer that a person says is really areas.
    const input = dataset({ shape: 'areas', layer: { geometry: 'point' } })
    expect(statedShape(input)).toBe('areas')
    expect(await deriveShape(input)).toBe('areas')
    // And a source that would derive as points.
    expect(await deriveShape(source({ provider: 'x', placeQuery: { by: ['point'] } }))).toBe('points')
    expect(
      await deriveShape({ kind: 'source', meta: { shape: 'statistics', source: { provider: 'x', placeQuery: { by: ['point'] } } }, files: [] }),
    ).toBe('statistics')
  })

  it('is read case-insensitively and trimmed, because manifests are hand-typed', async () => {
    expect(await deriveShape(dataset({ shape: '  Records ' }))).toBe('records')
  })

  it('drops a word outside the vocabulary, with one warning naming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = { kind: 'dataset', meta: { shape: 'geospatial', layer: { geometry: 'county' } }, files: [], slug: 'soil-map' }
    expect(await deriveShape(input)).toBe('statistics')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('geospatial')
    expect(warn.mock.calls[0][0]).toContain('soil-map')
    // One per entry, not one per read.
    expect(await deriveShape(input)).toBe('statistics')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('shape — a map layer says it outright', () => {
  it('reads a point layer as points and a county layer as statistics', async () => {
    expect(await deriveShape(dataset({ layer: { geometry: 'point', file: 'sites.csv' } }))).toBe('points')
    expect(await deriveShape(dataset({ layer: { geometry: 'county', valueKey: 'rate' } }))).toBe('statistics')
    // A block that never says means county, exactly as the layer parser reads it.
    expect(await deriveShape(dataset({ layer: { valueKey: 'rate' } }))).toBe('statistics')
  })

  it('reads a line layer as lines, not as records with no location (P9-8)', async () => {
    // `transmission-345kv` holds 3,477 LineStrings the map draws every day,
    // and the entry page chipped it "Records without a location": `line` was
    // the one geometry with no branch here, so it fell past the manifest to
    // the file sniffer, which saw a GeoJSON with no lat/lng columns.
    expect(shapeFromManifest(dataset({ layer: { geometry: 'line', pathKey: '_path' } }))).toBe('lines')
    expect(await deriveShape(dataset({ layer: { geometry: 'line', file: 'lines.geojson' } }))).toBe('lines')
    // And the manifest still wins over the geometry, as it does for every
    // other shape.
    expect(shapeFromManifest(dataset({ shape: 'areas', layer: { geometry: 'line' } }))).toBe('areas')
  })
})

describe('shape — a source says what you can ask it for', () => {
  it('is areas when it answers by parcel', async () => {
    expect(await deriveShape(source({ provider: 'x', placeQuery: { by: ['point', 'parcel', 'county'] } }))).toBe('areas')
  })

  it('is areas when an access note names polygons or boundaries', async () => {
    const withNote = source({
      provider: 'x',
      placeQuery: { by: ['point', 'county'] },
      access: [{ type: 'wfs', notes: 'GetFeature on mapunitpolyextended returns soil polygons with the attributes joined' }],
    })
    expect(accessNamesAreas({ access: [{ type: 'wfs', notes: 'soil polygons' }] })).toBe(true)
    expect(await deriveShape(withNote)).toBe('areas')
    expect(
      await deriveShape(source({ provider: 'x', placeQuery: { by: ['county'] }, access: [{ type: 'arcgis', notes: 'watershed boundaries' }] })),
    ).toBe('areas')
  })

  it('does not read a GeoJSON format as polygons — a GeoJSON of points is points', async () => {
    const geojsonOfPoints = source({
      provider: 'x',
      placeQuery: { by: ['point', 'county'] },
      access: [{ type: 'arcgis', notes: "County filter works server-side: ?where=COUNTY='DUPLIN'&f=geojson" }],
    })
    expect(accessNamesAreas({ access: [{ type: 'download', format: 'geojson' }] })).toBe(false)
    expect(await deriveShape(geojsonOfPoints)).toBe('points')
  })

  it('is points when it answers by point and nothing says areas', async () => {
    expect(await deriveShape(source({ provider: 'x', placeQuery: { by: ['point', 'county', 'state'] } }))).toBe('points')
  })

  it('is statistics when it only answers by an area code', async () => {
    expect(await deriveShape(source({ provider: 'x', placeQuery: { by: ['county', 'state'] } }))).toBe('statistics')
    expect(await deriveShape(source({ provider: 'x', placeQuery: { by: ['tract', 'county'] } }))).toBe('statistics')
  })

  it('falls back to the block’s own geography when it has no place query', async () => {
    expect(await deriveShape(source({ provider: 'x', geography: 'point' }))).toBe('points')
    expect(await deriveShape(source({ provider: 'x', geography: 'parcel' }))).toBe('areas')
    expect(await deriveShape(source({ provider: 'x', geography: 'tract' }))).toBe('statistics')
    // Never against a place query that does say: `by` is the field the block
    // was written to answer with.
    expect(await deriveShape(source({ provider: 'x', geography: 'parcel', placeQuery: { by: ['point'] } }))).toBe('points')
  })

  it('is records when the block says nothing about place at all', async () => {
    expect(await deriveShape(source({ provider: 'x' }))).toBe('records')
    expect(await deriveShape(source({ provider: 'x', placeQuery: { by: [] } }))).toBe('records')
  })
})

describe('shape — a table we hold', () => {
  const read = (files: Record<string, string>) => async (name: string) => files[name] ?? null

  it('is statistics when a column holds an area code', async () => {
    const files = { 'acs.csv': 'GEOID,county,median_income\n13089,DeKalb,65000\n' }
    expect(await deriveShape(dataset({}, Object.keys(files)), read(files))).toBe('statistics')
    expect(shapeFromSignals({ columns: ['STCOFIPS', 'value'], polygons: false })).toBe('statistics')
  })

  it('is points when it carries a latitude and a longitude', async () => {
    const files = { 'orgs.csv': 'name,lat,lng,city\nA,33.7,-84.4,Atlanta\n' }
    expect(await deriveShape(dataset({}, Object.keys(files)), read(files))).toBe('points')
    // One of the pair is not a location.
    expect(shapeFromSignals({ columns: ['name', 'lat'], polygons: false })).toBe('records')
  })

  it('is areas when a GeoJSON draws polygons', async () => {
    const polygons = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'Zone A' }, geometry: { type: 'MultiPolygon', coordinates: [] } }],
    })
    const files = { 'zones.geojson': polygons }
    expect(await deriveShape(dataset({}, Object.keys(files)), read(files))).toBe('areas')
  })

  it('is points when a GeoJSON draws points, because the explorer lifts the coordinates into columns', async () => {
    const points = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { NAME: 'Garden' }, geometry: { type: 'Point', coordinates: [-77, 38.9] } }],
    })
    const files = { 'gardens.geojson': points }
    expect(await deriveShape(dataset({}, Object.keys(files)), read(files))).toBe('points')
  })

  it('is records when the columns say nothing about where', async () => {
    const files = { 'people.csv': 'Name,Affiliations,Roles,Capacity,Notes\nA,B,C,D,E\n' }
    expect(await deriveShape(dataset({}, Object.keys(files)), read(files))).toBe('records')
  })

  it('is records when there is no table, no reader, or nothing readable', async () => {
    expect(await deriveShape(dataset({}, ['notes.pdf', 'meta.json']))).toBe('records')
    expect(await deriveShape(dataset({}, ['data.csv']))).toBe('records')
    expect(await deriveShape(dataset({}, ['data.csv']), async () => null)).toBe('records')
  })

  it('survives a file that will not download', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const boom = async () => {
      throw new Error('bucket said no')
    }
    expect(await deriveShape(dataset({}, ['data.csv']), boom)).toBe('records')
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('shape — reading a file’s signals', () => {
  it('takes a delimited file’s header line and nothing else', () => {
    expect(readShapeSignals('a.csv', 'one, two ,"three"\n1,2,3\n4,5,6\n')).toEqual({ columns: ['one', 'two', 'three'], polygons: false })
    expect(readShapeSignals('a.tsv', 'one\ttwo\n1\t2\n').columns).toEqual(['one', 'two'])
    // A byte-order mark is not a column name.
    expect(readShapeSignals('a.csv', '﻿GEOID,value\n').columns).toEqual(['GEOID', 'value'])
  })

  it('takes a JSON array’s first object’s keys', () => {
    expect(readShapeSignals('a.json', '[{"lat":1,"lng":2}]').columns).toEqual(['lat', 'lng'])
  })

  it('still says whether a broken GeoJSON draws polygons', () => {
    expect(readShapeSignals('a.geojson', '{"features":[{"geometry":{"type":"Polygon"')).toEqual({ columns: [], polygons: true })
  })
})

describe('shape — which entries are asked', () => {
  it('asks the two dataset-shaped kinds and nothing else', () => {
    expect(isShapedKind('dataset')).toBe(true)
    expect(isShapedKind('source')).toBe(true)
    for (const kind of ['document', 'note', 'wiki', 'view', 'incoming']) expect(isShapedKind(kind), kind).toBe(false)
  })

  it('answers from the manifest alone where a file read is not on the table', () => {
    expect(shapeFromManifest(dataset({ layer: { geometry: 'point' } }))).toBe('points')
    // P7-9: a state layer draws a boundary, so `areas` — not `statistics`,
    // which is for values keyed by an area code. A permitting table is prose.
    expect(shapeFromManifest(dataset({ layer: { geometry: 'state', stateKey: 'State' } }))).toBe('areas')
    expect(shapeFromManifest(source({ provider: 'x', placeQuery: { by: ['county'] } }))).toBe('statistics')
    // A held table cannot be answered without opening it.
    expect(shapeFromManifest(dataset({}, ['data.csv']))).toBeNull()
  })

  it('picks the file the table explorer would open', () => {
    expect(pickShapeFile(['meta.json', 'strategic-prospect-table.pdf', 'landholders.csv'])).toBe('landholders.csv')
    expect(pickShapeFile(['meta.json', 'notes.pdf'])).toBeNull()
    expect(pickShapeFile(undefined)).toBeNull()
  })

  it('calls every public map layer statistics, because that is what one is', () => {
    expect(PUBLIC_LAYER_SHAPE).toBe('statistics')
  })
})
