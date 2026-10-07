import { describe, it, expect } from 'vitest'

/**
 * P5-18: internal layer manifest — pure validation + projection. The
 * catalog-backed listing and values endpoints are covered by
 * routes/layers.test.ts against the real app.
 */
const {
  parseLayerBlock,
  parseMeasures,
  projectCountyValues,
  projectPointFeatures,
  pointLayerBounds,
  projectLineFeatures,
  lineLayerBounds,
  parseLinePath,
  projectStateRows,
  LAYER_MAX_VALUES,
  LAYER_MAX_FEATURES,
  LAYER_MAX_VERTICES,
  LAYER_MAX_POPUP_CHARS,
} = await import('./internalLayers.js')
const { parseTabular, TabularError } = await import('./libraryTabular.js')

const valid = {
  geometry: 'county',
  geoKey: 'GEOID',
  valueKey: 'score',
  name: 'Target index',
  dataType: 'index',
  unit: '',
  direction: 'higher_better',
  range: { min: 0, max: 100 },
  description: 'Where the plan should look first.',
  source: 'BLO internal',
  year: 2026,
}

describe('parseLayerBlock', () => {
  it('accepts a full block and normalises optional fields', () => {
    const r = parseLayerBlock({ layer: valid })
    expect('block' in r).toBe(true)
    if ('block' in r) {
      expect(r.block).toMatchObject({ geometry: 'county', geoKey: 'GEOID', valueKey: 'score', name: 'Target index', direction: 'higher_better' })
      expect(r.block.range).toEqual({ min: 0, max: 100 })
    }
  })

  it('applies defaults: dataType index, direction higher_better, empty unit/description/source', () => {
    const r = parseLayerBlock({ layer: { geoKey: 'fips', valueKey: 'v', name: 'X' } })
    expect(r).toEqual({
      block: {
        geometry: 'county',
        file: undefined,
        geoKey: 'fips',
        valueKey: 'v',
        name: 'X',
        dataType: 'index',
        unit: '',
        direction: 'higher_better',
        range: null,
        description: '',
        source: '',
        year: '',
      },
    })
  })

  it.each([
    [{}, /no layer block/],
    [{ layer: 'nope' }, /layer block must be an object/],
    [{ layer: { ...valid, geometry: 'point' } }, /latKey/], // a county block re-labelled as point lacks point keys
    [{ layer: { ...valid, geometry: 'line' } }, /pathKey/], // P7-3: a county block re-labelled as line lacks a path column
    [{ layer: { ...valid, geometry: 'polygon' } }, /geometry/],
    [{ layer: { ...valid, geoKey: '' } }, /geoKey/],
    [{ layer: { ...valid, valueKey: 3 } }, /valueKey/],
    [{ layer: { ...valid, name: '   ' } }, /name/],
    [{ layer: { ...valid, dataType: 'money' } }, /dataType/],
    [{ layer: { ...valid, direction: 'up' } }, /direction/],
    [{ layer: { ...valid, range: { min: 5, max: 1 } } }, /range/],
    [{ layer: { ...valid, range: { min: 'a', max: 1 } } }, /range/],
    [{ layer: { ...valid, file: 42 } }, /file/],
  ])('rejects %j naming the field', (meta, re) => {
    const r = parseLayerBlock(meta as Record<string, unknown>)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(re)
  })
})

describe('parseMeasures (P9-0) — one file, many measures', () => {
  /**
   * A dataset is a FILE; a measure is one number per geography. CEJST is one
   * file with ~22 measures — the eight burden categories, the redlining
   * share, twelve percentiles — and a manifest that declares one `layer`
   * exposes exactly one of them. The other 21 are readable as a table and
   * invisible to the map and to any index.
   *
   * A measure inherits WHERE the data is (file, geoKey, geometry, source,
   * year) from the primary block, and declares only what differs: its column
   * and what that column means.
   */
  it('inherits the primary block\'s file and key, and overrides the column', () => {
    const r = parseMeasures({
      layer: { ...valid, file: 'cejst.csv' },
      measures: [
        { valueKey: 'pct_pop_energy', name: 'Energy burden', unit: '%', direction: 'lower_better', dataType: 'percentage' },
      ],
    })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.measures).toHaveLength(1)
    expect(r.measures[0].valueKey).toBe('pct_pop_energy')
    expect(r.measures[0].file).toBe('cejst.csv')
    expect(r.measures[0].geoKey).toBe('GEOID')
    expect(r.measures[0].geometry).toBe('county')
    expect(r.measures[0].name).toBe('Energy burden')
    expect(r.measures[0].direction).toBe('lower_better')
  })

  it('is empty when a manifest declares none, which is every manifest today', () => {
    const r = parseMeasures({ layer: valid })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.measures).toEqual([])
  })

  /** A measure is a column of numbers per county. A point or line layer's
   *  extra columns are popup fields, not measures, and saying so here stops
   *  a confusing half-working state later. */
  it('refuses measures on a layer that is not county-shaped', () => {
    const r = parseMeasures({
      layer: { ...valid, geometry: 'point', latKey: 'lat', lngKey: 'lng', labelKey: 'name' },
      measures: [{ valueKey: 'x', name: 'X', unit: '', direction: 'higher_better', dataType: 'index' }],
    })
    expect('error' in r).toBe(true)
  })

  it('refuses a measure that names no column, and says which one', () => {
    const r = parseMeasures({
      layer: valid,
      measures: [{ name: 'Nameless', unit: '', direction: 'higher_better', dataType: 'index' }],
    })
    expect('error' in r).toBe(true)
    if (!('error' in r)) return
    expect(r.error).toMatch(/valueKey/i)
  })

  it('refuses a measure that repeats the primary column — it would shadow it', () => {
    const r = parseMeasures({
      layer: valid,
      measures: [{ valueKey: 'score', name: 'Again', unit: '', direction: 'higher_better', dataType: 'index' }],
    })
    expect('error' in r).toBe(true)
    if (!('error' in r)) return
    expect(r.error).toMatch(/score/)
  })

  it('refuses two measures on the same column', () => {
    const r = parseMeasures({
      layer: valid,
      measures: [
        { valueKey: 'a', name: 'A', unit: '', direction: 'higher_better', dataType: 'index' },
        { valueKey: 'a', name: 'B', unit: '', direction: 'higher_better', dataType: 'index' },
      ],
    })
    expect('error' in r).toBe(true)
  })
})

describe('projectCountyValues', () => {
  const block = (parseLayerBlock({ layer: { ...valid, range: undefined } }) as any).block
  const ds = parseTabular(
    Buffer.from(
      'GEOID,score,name\n' +
        '1001,12.5,Autauga\n' + // needs zero-padding
        '01003,"1,200",Baldwin\n' + // thousands comma
        '0500000US01005,7,Barbour\n' + // census affgeoid form
        'bad,9,Nope\n' + // unparseable geoid → skipped
        '01007,,Bibb\n' + // blank value → skipped
        '01009,n/a,Blount\n' + // non-numeric → skipped
        '01011,3,Bullock\n' +
        '01011,4,Bullock again\n', // duplicate → last wins
    ),
    'data.csv',
  )

  it('normalises GEOIDs, parses numbers loosely, skips bad rows, last duplicate wins, computes range', () => {
    const out = projectCountyValues(ds, block)
    expect(out.values).toEqual({ '01001': 12.5, '01003': 1200, '01005': 7, '01011': 4 })
    expect(out.count).toBe(4)
    expect(out.skipped).toBe(3)
    expect(out.range).toEqual({ min: 4, max: 1200 })
  })

  it('prefers the declared range over the computed one', () => {
    const declared = (parseLayerBlock({ layer: valid }) as any).block
    expect(projectCountyValues(ds, declared).range).toEqual({ min: 0, max: 100 })
  })

  it('415s when geoKey or valueKey is not a column', () => {
    const wrong = (parseLayerBlock({ layer: { ...valid, valueKey: 'missing' } }) as any).block
    try {
      projectCountyValues(ds, wrong)
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(TabularError)
      expect((err as any).status).toBe(415)
      expect((err as Error).message).toMatch(/missing/)
    }
  })

  it('413s over the values cap', () => {
    const rows = Array.from({ length: LAYER_MAX_VALUES + 1 }, (_, i) => `${String(i).padStart(5, '0')},1`).join('\n')
    const big = parseTabular(Buffer.from('GEOID,score\n' + rows + '\n'), 'big.csv')
    try {
      projectCountyValues(big, block)
      throw new Error('expected throw')
    } catch (err) {
      expect((err as any).status).toBe(413)
    }
  })

  it('returns an empty projection (null range) when nothing parses', () => {
    const empty = parseTabular(Buffer.from('GEOID,score\nx,y\n'), 'e.csv')
    expect(projectCountyValues(empty, block)).toEqual({ values: {}, count: 0, skipped: 1, range: null })
  })
})

describe('point layers (P5-24)', () => {
  const pointBlock = {
    geometry: 'point',
    latKey: 'lat',
    lngKey: 'lng',
    labelKey: 'Organization',
    popupFields: ['Tier', 'HQ City', ' Tier '],
    color: '#FF6B1C',
    name: 'Organizations (HQ)',
    description: 'Headquarters',
    source: 'BLO research',
    year: 2026,
  }

  it('parseLayerBlock accepts a point block, dedupes popupFields, lowercases color', () => {
    const r = parseLayerBlock({ layer: pointBlock })
    expect(r).toEqual({
      block: {
        geometry: 'point',
        file: undefined,
        name: 'Organizations (HQ)',
        description: 'Headquarters',
        source: 'BLO research',
        year: 2026,
        latKey: 'lat',
        lngKey: 'lng',
        labelKey: 'Organization',
        popupFields: ['Tier', 'HQ City'],
        color: '#ff6b1c',
      },
    })
    expect((parseLayerBlock({ layer: { ...pointBlock, popupFields: undefined, color: undefined } }) as any).block).toMatchObject({ popupFields: [], color: null })
  })

  it.each([
    [{ ...pointBlock, latKey: '' }, /latKey/],
    [{ ...pointBlock, lngKey: 3 }, /lngKey/],
    [{ ...pointBlock, labelKey: undefined }, /labelKey/],
    [{ ...pointBlock, popupFields: 'Tier' }, /popupFields/],
    [{ ...pointBlock, popupFields: ['Tier', 7] }, /popupFields/],
    [{ ...pointBlock, color: 'orange' }, /color/],
    [{ ...pointBlock, geometry: 'line' }, /pathKey/],
    [{ ...pointBlock, geometry: 'polygon' }, /geometry/],
  ])('rejects %j naming the field', (layer, re) => {
    const r = parseLayerBlock({ layer } as any)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(re)
  })

  const block = (parseLayerBlock({ layer: pointBlock }) as any).block
  const ds = parseTabular(
    Buffer.from(
      'Organization,Tier,HQ City,secret,lat,lng\n' +
        'Black Farmer Fund,Tier 1,New York,hidden-1,40.73,-73.99\n' +
        'Bad coords,Tier 2,Nowhere,hidden-2,95,-73\n' +
        'Missing,Tier 2,Nowhere,hidden-3,,\n' +
        'Truly Living Well,Tier 2,Atlanta,hidden-4,"33.75","-84.42"\n',
    ),
    'orgs.csv',
  )

  it('projects rows to Point features with ONLY the label + popupFields, skipping bad coordinates, with a bbox', () => {
    const out = projectPointFeatures(ds, block)
    expect(out.count).toBe(2)
    expect(out.skipped).toBe(2)
    expect(out.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-73.99, 40.73] },
      properties: { _label: 'Black Farmer Fund', Tier: 'Tier 1', 'HQ City': 'New York' },
    })
    expect(JSON.stringify(out)).not.toContain('hidden')
    expect(out.bbox).toEqual([-84.42, 33.75, -73.99, 40.73])
  })

  it('415s when a popup field or coordinate column is missing', () => {
    const wrong = (parseLayerBlock({ layer: { ...pointBlock, popupFields: ['Nope'] } }) as any).block
    expect(() => projectPointFeatures(ds, wrong)).toThrow(/Nope/)
  })

  it('413s over the feature cap', () => {
    const rows = Array.from({ length: LAYER_MAX_FEATURES + 1 }, (_, i) => `p${i},T,C,x,${(i % 80) - 40},${(i % 300) - 150}`).join('\n')
    const big = parseTabular(Buffer.from('Organization,Tier,HQ City,secret,lat,lng\n' + rows + '\n'), 'big.csv')
    expect(() => projectPointFeatures(big, block)).toThrow(/cap/)
  })

  // P5-77: the manifest carries the same frame the payload does, so "Show on
  // map" opens on the layer's own points — without building the features.
  describe('pointLayerBounds', () => {
    it('reads the same box the payload reports, from the rows alone', () => {
      expect(pointLayerBounds(ds, block)).toEqual([-84.42, 33.75, -73.99, 40.73])
      expect(pointLayerBounds(ds, block)).toEqual(projectPointFeatures(ds, block).bbox)
    })

    it('is null when no row has a usable coordinate', () => {
      const none = parseTabular(
        Buffer.from('Organization,Tier,HQ City,secret,lat,lng\nNo coords,Tier 2,Nowhere,hidden,,\nOff Earth,Tier 2,Nowhere,hidden,95,-73\n'),
        'orgs.csv',
      )
      expect(pointLayerBounds(none, block)).toBeNull()
      expect(projectPointFeatures(none, block).bbox).toBeNull()
    })

    it('is null, not a throw, when the block names a column the file lacks', () => {
      const wrong = (parseLayerBlock({ layer: { ...pointBlock, latKey: 'nope' } }) as any).block
      expect(pointLayerBounds(ds, wrong)).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// P7-3: line layers. Deliberately the same shape as the point block above —
// a path column instead of a lat/lng pair, and the same label + popupFields
// allowlist. If these two describe blocks ever stop looking alike, something
// has grown a second pipeline.
// ---------------------------------------------------------------------------
describe('line layers (P7-3)', () => {
  const lineBlock = {
    geometry: 'line',
    pathKey: '_path',
    labelKey: 'NAME',
    popupFields: ['OWNER', 'VOLTAGE', ' OWNER '],
    color: '#2B6CB0',
    width: 3,
    name: 'Transmission lines',
    description: 'Lines carrying load to the site.',
    source: 'HIFLD',
    year: 2026,
  }

  it('parseLayerBlock accepts a line block, dedupes popupFields, lowercases color', () => {
    const r = parseLayerBlock({ layer: lineBlock })
    expect(r).toEqual({
      block: {
        geometry: 'line',
        file: undefined,
        name: 'Transmission lines',
        description: 'Lines carrying load to the site.',
        source: 'HIFLD',
        year: 2026,
        pathKey: '_path',
        labelKey: 'NAME',
        popupFields: ['OWNER', 'VOLTAGE'],
        color: '#2b6cb0',
        width: 3,
      },
    })
    expect((parseLayerBlock({ layer: { ...lineBlock, popupFields: undefined, color: undefined, width: undefined } }) as any).block)
      .toMatchObject({ popupFields: [], color: null, width: null })
  })

  it.each([
    [{ ...lineBlock, pathKey: '' }, /pathKey/],
    [{ ...lineBlock, pathKey: 3 }, /pathKey/],
    [{ ...lineBlock, labelKey: undefined }, /labelKey/],
    [{ ...lineBlock, popupFields: 'OWNER' }, /popupFields/],
    [{ ...lineBlock, color: 'blue' }, /color/],
    [{ ...lineBlock, width: 0 }, /width/],
    [{ ...lineBlock, width: 99 }, /width/],
    [{ ...lineBlock, width: 'thick' }, /width/],
  ])('rejects %j naming the field', (layer, re) => {
    const r = parseLayerBlock({ layer } as any)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(re)
  })

  // The two spellings a path can arrive in: the compact JSON `parseJson`
  // writes into `_path` from a GeoJSON file, and the WKT an ArcGIS/Socrata
  // CSV export carries. Both become the same array of parts.
  describe('parseLinePath', () => {
    it('reads a JSON LineString, a JSON MultiLineString, and WKT of each', () => {
      expect(parseLinePath('[[-90,35],[-89,36]]')).toEqual([[[-90, 35], [-89, 36]]])
      expect(parseLinePath('[[[-90,35],[-89,36]],[[-88,34],[-87,33]]]')).toEqual([
        [[-90, 35], [-89, 36]],
        [[-88, 34], [-87, 33]],
      ])
      expect(parseLinePath('LINESTRING (-90 35, -89 36)')).toEqual([[[-90, 35], [-89, 36]]])
      expect(parseLinePath('MULTILINESTRING ((-90 35, -89 36), (-88 34, -87 33))')).toEqual([
        [[-90, 35], [-89, 36]],
        [[-88, 34], [-87, 33]],
      ])
    })

    it('is null for anything that is not a drawable path', () => {
      for (const cell of [
        '',
        '   ',
        'nonsense',
        '[]',
        '[[-90,35]]', // a single vertex is a point, not a line
        '[[-900,35],[-89,36]]', // off the earth
        'POINT (-90 35)',
        'LINESTRING (-90 35)',
        '{"type":"LineString"}',
      ]) {
        expect(parseLinePath(cell)).toBeNull()
      }
    })

    it('drops unusable vertices but keeps a part that still has two', () => {
      expect(parseLinePath('[[-90,35],[null,2],[-89,36]]')).toEqual([[[-90, 35], [-89, 36]]])
    })
  })

  const block = (parseLayerBlock({ layer: lineBlock }) as any).block
  const ds = parseTabular(
    Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] },
            properties: { NAME: 'Allen tie', OWNER: 'TVA', VOLTAGE: '500', secret: 'hidden-1' },
          },
          {
            type: 'Feature',
            geometry: { type: 'MultiLineString', coordinates: [[[-91, 34], [-90.5, 34.5]], [[-88, 36.4], [-87.6, 36.2]]] },
            properties: { NAME: 'Nucor spur', OWNER: 'MLGW', VOLTAGE: '161', secret: 'hidden-2' },
          },
          { type: 'Feature', geometry: null, properties: { NAME: 'No shape', OWNER: '', VOLTAGE: '', secret: 'hidden-3' } },
        ],
      }),
    ),
    'lines.geojson',
  )

  it('projects rows to LineString/MultiLineString with ONLY the label + popupFields, and a bbox over every vertex', () => {
    const out = projectLineFeatures(ds, block)
    expect(out.count).toBe(2)
    expect(out.skipped).toBe(1)
    // One part stays a LineString; several become a MultiLineString. Both are
    // what a Mapbox `line` layer draws, and what the payload claims it is.
    expect(out.features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] },
      properties: { _label: 'Allen tie', OWNER: 'TVA', VOLTAGE: '500' },
    })
    expect(out.features[1].geometry).toEqual({
      type: 'MultiLineString',
      coordinates: [[[-91, 34], [-90.5, 34.5]], [[-88, 36.4], [-87.6, 36.2]]],
    })
    // The same canary the point projection carries: a column the block does
    // not name never leaves the server.
    expect(JSON.stringify(out)).not.toContain('hidden')
    expect(out.bbox).toEqual([-91, 34, -87.6, 36.4])
  })

  it('415s when a popup field or the path column is missing', () => {
    const wrongField = (parseLayerBlock({ layer: { ...lineBlock, popupFields: ['Nope'] } }) as any).block
    expect(() => projectLineFeatures(ds, wrongField)).toThrow(/Nope/)
    const wrongPath = (parseLayerBlock({ layer: { ...lineBlock, pathKey: 'geom' } }) as any).block
    expect(() => projectLineFeatures(ds, wrongPath)).toThrow(/geom/)
  })

  it('413s over the feature cap', () => {
    const features = Array.from({ length: LAYER_MAX_FEATURES + 1 }, (_, i) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[-90, 35], [-89 + (i % 10) * 0.01, 36]] },
      properties: { NAME: `l${i}`, OWNER: 'x', VOLTAGE: '1' },
    }))
    const big = parseTabular(Buffer.from(JSON.stringify({ type: 'FeatureCollection', features })), 'big.geojson')
    expect(() => projectLineFeatures(big, block)).toThrow(/cap/)
  })

  // A line file can be small in rows and enormous in vertices — a few hundred
  // transmission lines is a few hundred rows and can be millions of points.
  // The row cap cannot see that, so the vertex cap is its own ceiling.
  it('413s over the vertex cap, which the feature cap cannot see', () => {
    const long = Array.from({ length: Math.ceil(LAYER_MAX_VERTICES / 2) + 2 }, (_, i) => [-90 + i * 1e-5, 35])
    const features = [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: long }, properties: { NAME: 'a', OWNER: 'x', VOLTAGE: '1' } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: long }, properties: { NAME: 'b', OWNER: 'x', VOLTAGE: '1' } },
    ]
    const dense = parseTabular(Buffer.from(JSON.stringify({ type: 'FeatureCollection', features })), 'dense.geojson')
    expect(dense.rows.length).toBeLessThan(LAYER_MAX_FEATURES)
    expect(() => projectLineFeatures(dense, block)).toThrow(/vert/)
  })

  // The manifest frame, from the rows alone — the point layer's P5-77 rule,
  // applied to lines so "Show on map" opens on the corridor.
  describe('lineLayerBounds', () => {
    it('reads the same box the payload reports, from the rows alone', () => {
      expect(lineLayerBounds(ds, block)).toEqual([-91, 34, -87.6, 36.4])
      expect(lineLayerBounds(ds, block)).toEqual(projectLineFeatures(ds, block).bbox)
    })

    it('is null when no row has a drawable path', () => {
      const none = parseTabular(
        Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90, 35]] }, properties: { NAME: 'stub' } }] })),
        'none.geojson',
      )
      // A one-vertex "line" has a path cell but nothing drawable in it.
      expect(none.columns.map(c => c.name)).toContain('_path')
      expect(lineLayerBounds(none, block)).toBeNull()
    })

    it('is null, not a throw, when the block names a column the file lacks', () => {
      const wrong = (parseLayerBlock({ layer: { ...lineBlock, pathKey: 'nope' } }) as any).block
      expect(lineLayerBounds(ds, wrong)).toBeNull()
    })
  })

  // A CSV that carries WKT in a column of its own, which is how an ArcGIS or
  // Socrata export spells a path. Same block, different file.
  it('draws a CSV whose path column holds WKT', () => {
    const csv = parseTabular(
      Buffer.from('NAME,OWNER,VOLTAGE,geom\nAllen tie,TVA,500,"LINESTRING (-90.05 35.15, -89.9 35.2)"\n'),
      'lines.csv',
    )
    const wkt = (parseLayerBlock({ layer: { ...lineBlock, pathKey: 'geom' } }) as any).block
    const out = projectLineFeatures(csv, wkt)
    expect(out.count).toBe(1)
    expect(out.features[0].geometry).toEqual({ type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] })
    expect(out.bbox).toEqual([-90.05, 35.15, -89.9, 35.2])
  })
})

/**
 * P7-9. The geometry this server never sees: a state layer ships ROWS and the
 * client joins them to outlines it dissolves from the county polygons it
 * already holds. So the assertions here are about the rows — the key read in
 * every spelling, the title that needs no column, and the prose.
 */
describe('state layers (P7-9)', () => {
  const stateBlock = {
    geometry: 'state',
    stateKey: 'State',
    popupFields: ['Authority', 'Timeline', ' Authority '],
    detailFields: ['Process', 'Authority'],
    color: '#2F855A',
    name: 'Permitting by state',
    description: 'Who issues the permit and how long it takes.',
    source: 'BLO research',
    year: 2026,
  }

  it('parseLayerBlock accepts a state block, dedupes, and keeps a column out of both lists', () => {
    const r = parseLayerBlock({ layer: stateBlock })
    expect(r).toEqual({
      block: {
        geometry: 'state',
        file: undefined,
        name: 'Permitting by state',
        description: 'Who issues the permit and how long it takes.',
        source: 'BLO research',
        year: 2026,
        stateKey: 'State',
        // No labelKey column: a state's title is its own name.
        labelKey: null,
        popupFields: ['Authority', 'Timeline'],
        // 'Authority' is a popup field, so it is not also prose.
        detailFields: ['Process'],
        color: '#2f855a',
      },
    })
  })

  it('takes a labelKey when one is given, and rejects an empty one', () => {
    expect((parseLayerBlock({ layer: { ...stateBlock, labelKey: 'Jurisdiction' } }) as any).block.labelKey).toBe('Jurisdiction')
    const r = parseLayerBlock({ layer: { ...stateBlock, labelKey: '' } })
    expect('error' in r && r.error).toMatch(/labelKey/)
  })

  it.each([
    [{ ...stateBlock, stateKey: '' }, /stateKey/],
    [{ ...stateBlock, stateKey: undefined }, /stateKey/],
    [{ ...stateBlock, detailFields: 'Process' }, /detailFields/],
    [{ ...stateBlock, detailFields: ['Process', 7] }, /detailFields/],
    [{ ...stateBlock, popupFields: 'Authority' }, /popupFields/],
    [{ ...stateBlock, color: 'green' }, /color/],
  ])('rejects %j naming the field', (layer, re) => {
    const r = parseLayerBlock({ layer } as any)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toMatch(re)
  })

  // The geometry's own column is named FIRST, so a block relabelled from one
  // geometry to another is told what THIS geometry needs (P7-3's rule).
  it('names stateKey, not labelKey, when a point block is relabelled state', () => {
    const r = parseLayerBlock({ layer: { geometry: 'state', labelKey: 'Organization', name: 'X' } })
    expect('error' in r && r.error).toMatch(/stateKey/)
  })

  const block = (parseLayerBlock({ layer: stateBlock }) as any).block
  const ds = parseTabular(
    Buffer.from(
      'State,Authority,Timeline,Process,secret\n' +
        'GA,Georgia EPD,120 days,"Apply to EPD.\n\nThen a hearing.",hidden-1\n' +
        'Tennessee,TDEC,90 days,Apply to TDEC.,hidden-2\n' +
        '28,MDEQ,60 days,Apply to MDEQ.,hidden-3\n' +
        '1.0,ADEM,45 days,Apply to ADEM.,hidden-4\n' +
        'Georgia,A second Georgia,0 days,Never drawn.,hidden-5\n' +
        'Freedonia,Nobody,never,Not a state.,hidden-6\n' +
        'CO,,,,hidden-7\n',
    ),
    'permits.csv',
  )

  it('reads the key in every spelling, titles each state from the canonical table, and ships only the allowlist', () => {
    const out = projectStateRows(ds, block)
    // AL (1.0), GA, MS (28), TN — in state-name order, not file order.
    expect(out.features.map(f => f.properties._label)).toEqual(['Alabama', 'Georgia', 'Mississippi', 'Tennessee'])
    expect(out.features.map(f => f.properties._state)).toEqual(['01', '13', '28', '47'])
    expect(out.count).toBe(4)
    // A duplicate Georgia, a non-state, and a row with nothing to say.
    expect(out.skipped).toBe(3)
    expect(out.features[1].properties).toEqual({
      _state: '13',
      _label: 'Georgia',
      Authority: 'Georgia EPD',
      Timeline: '120 days',
      Process: 'Apply to EPD.\n\nThen a hearing.',
    })
    expect(JSON.stringify(out)).not.toContain('hidden')
    expect(JSON.stringify(out)).not.toContain('A second Georgia')
  })

  it('ships unlocated features and no bbox — the outlines are the client\'s', () => {
    const out = projectStateRows(ds, block)
    expect(out.type).toBe('FeatureCollection')
    for (const f of out.features) expect(f.geometry).toBeNull()
    expect(out.bbox).toBeNull()
  })

  it('415s when the state column or a declared field is not in the file', () => {
    const wrongState = (parseLayerBlock({ layer: { ...stateBlock, stateKey: 'Nope' } }) as any).block
    expect(() => projectStateRows(ds, wrongState)).toThrow(/Nope/)
    const wrongDetail = (parseLayerBlock({ layer: { ...stateBlock, detailFields: ['Missing'] } }) as any).block
    expect(() => projectStateRows(ds, wrongDetail)).toThrow(/Missing/)
    expect(() => projectStateRows(ds, wrongState)).toThrow(TabularError)
  })

  // The row cap cannot see a state layer: 51 rows is always under
  // LAYER_MAX_FEATURES, and its whole payload is prose.
  it('413s over the popup-character cap, which the feature cap cannot reach', () => {
    const essay = 'x'.repeat(Math.ceil(LAYER_MAX_POPUP_CHARS / 4) + 10)
    const rows = ['AL', 'AK', 'AZ', 'AR', 'CA'].map(code => `${code},A,T,${essay},s`).join('\n')
    const big = parseTabular(Buffer.from('State,Authority,Timeline,Process,secret\n' + rows + '\n'), 'big.csv')
    expect(big.rows.length).toBeLessThan(LAYER_MAX_FEATURES)
    expect(() => projectStateRows(big, block)).toThrow(/characters/)
  })

  // A state layer pointed at a county column draws nothing rather than
  // reinterpreting 01001 as Alabama — the block is what needs fixing.
  it('skips a 5-digit county GEOID instead of taking its prefix', () => {
    const counties = parseTabular(
      Buffer.from('State,Authority,Timeline,Process,secret\n01001,A,T,P,s\n01003,A,T,P,s\n'),
      'counties.csv',
    )
    const out = projectStateRows(counties, block)
    expect(out.count).toBe(0)
    expect(out.skipped).toBe(2)
  })
})
