import { describe, it, expect } from 'vitest'

/**
 * P5-59 proposal. Pure mapping: an inspection (and the P5-47 suggestion, when
 * there is one) in, a source block a person can read and press Save on out.
 *
 * The rule the tests keep honest is "nothing is guessed silently" — every
 * field the machine filled in has to be named in `inferred`, and the block has
 * to survive `parseSourceMeta` unchanged, because that is what the filing
 * route will run on it.
 */

const { proposeSource, countyFipsField, fipsColumnIn, rowGeography } = await import('./sourceProposal.js')
const { parseSourceMeta } = await import('./sourceMeta.js')
import type { Inspection } from './linkInspect.js'

const ARCGIS: Inspection = {
  kind: 'arcgis-layer',
  confidence: 'high',
  url: 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0',
  finalUrl: 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0',
  title: 'Superfund National Priorities List (NPL) Sites',
  description: 'Point locations of Superfund sites.',
  geometry: 'point',
  extent: { xmin: -124.73, ymin: 24.5, xmax: -66.95, ymax: 49.38 },
  fields: [
    { name: 'OBJECTID', type: 'id' },
    { name: 'SITE_NAME', type: 'string', alias: 'Site name' },
    { name: 'STCOFIPS', type: 'string', alias: 'State/county FIPS' },
    { name: 'SITE_SCORE', type: 'number', alias: 'HRS score' },
  ],
  license: 'US EPA. Public domain.',
  rowCount: 1337,
  checkedAt: '2026-09-06T00:00:00.000Z',
}

const SOCRATA: Inspection = {
  kind: 'socrata',
  confidence: 'high',
  url: 'https://data.georgia.gov/d/spb7-eyx7',
  finalUrl: 'https://data.georgia.gov/resource/spb7-eyx7.json',
  title: 'Hazardous Site Inventory',
  provider: 'Georgia Environmental Protection Division',
  geometry: 'point',
  fields: [
    { name: 'site_name', type: 'text', alias: 'Site name' },
    { name: 'county_fips', type: 'text', alias: 'County FIPS' },
    { name: 'location_1', type: 'point', alias: 'Location' },
  ],
  cadence: 'Quarterly',
  license: 'Public Domain',
  rowCount: 764,
  checkedAt: '2026-09-06T00:00:00.000Z',
}

const CSV: Inspection = {
  kind: 'file',
  confidence: 'high',
  url: 'https://hazards.fema.gov/downloads/nri_counties.csv',
  finalUrl: 'https://hazards.fema.gov/downloads/nri_counties.csv',
  title: undefined,
  formats: ['csv'],
  contentType: 'text/csv',
  bytes: 4_211_234,
  geometry: 'table',
  fields: [{ name: 'GEOID' }, { name: 'COUNTY' }, { name: 'RISK_SCORE' }],
  checkedAt: '2026-09-06T00:00:00.000Z',
}

describe('field readers', () => {
  it('finds the column a county filter would use, and refuses the ones that would lie', () => {
    expect(countyFipsField([{ name: 'STCOFIPS' }])).toBe('STCOFIPS')
    expect(countyFipsField([{ name: 'GEOID' }])).toBe('GEOID')
    expect(countyFipsField([{ name: 'county_fips' }])).toBe('county_fips')
    // A state FIPS is not a county FIPS: filtering on it would answer about
    // the wrong place rather than about nowhere.
    expect(countyFipsField([{ name: 'STATEFP' }])).toBeNull()
    expect(countyFipsField([{ name: 'tract_geoid' }])).toBeNull()
    // Not a plain column name: it would have to be pasted into a where clause.
    expect(countyFipsField([{ name: 'county fips!' }])).toBeNull()
    expect(countyFipsField([{ name: 'site_name' }])).toBeNull()
  })

  it('reads what one row IS from the geometry and the columns', () => {
    expect(rowGeography([{ name: 'x' }], 'point')).toBe('point')
    expect(rowGeography([{ name: 'tract_geoid' }], 'polygon')).toBe('tract')
    expect(rowGeography([{ name: 'parcel_id' }], 'polygon')).toBe('parcel')
    expect(rowGeography([{ name: 'GEOID' }], 'polygon')).toBe('county')
    expect(rowGeography([{ name: 'notes' }], 'polygon')).toBeUndefined()
  })
})

describe('proposeSource - ArcGIS', () => {
  const proposal = proposeSource(ARCGIS)

  it('points the access method at the exact layer, with nothing invented', () => {
    expect(proposal.source.access).toEqual([
      {
        type: 'arcgis',
        url: ARCGIS.finalUrl,
        auth: 'none',
        notes: 'inferred from the service',
      },
    ])
  })

  it('takes the provider from the host and the program from the layer name', () => {
    expect(proposal.source.provider).toBe('services1.arcgis.com')
    expect(proposal.source.program).toBe('Superfund National Priorities List (NPL) Sites')
    expect(proposal.source.homepage).toBe(ARCGIS.url)
  })

  it('reads geography, coverage and the place query off the metadata', () => {
    expect(proposal.source.geography).toBe('point')
    expect(proposal.source.coverage).toBe('national')
    expect(proposal.source.placeQuery).toEqual({ by: ['point', 'county'], fipsField: 'STCOFIPS' })
  })

  it('carries the columns and the licence across', () => {
    expect(proposal.source.fields?.map(f => f.name)).toEqual(['OBJECTID', 'SITE_NAME', 'STCOFIPS', 'SITE_SCORE'])
    expect(proposal.source.fields?.find(f => f.name === 'SITE_NAME')?.description).toBe('Site name')
    expect(proposal.source.license).toBe('US EPA. Public domain.')
  })

  it('names every field it filled in, so the form can mark them', () => {
    expect(proposal.inferred).toEqual(
      expect.arrayContaining([
        'provider',
        'program',
        'homepage',
        'geography',
        'coverage',
        'fields',
        'access',
        'placeQuery.by',
        'placeQuery.fipsField',
        'license',
      ]),
    )
  })

  it('produces a block the filing route accepts unchanged', () => {
    const { source, dropped } = parseSourceMeta(proposal.source)
    expect(dropped).toEqual([])
    expect(source).toEqual(proposal.source)
  })
})

describe('proposeSource - Socrata', () => {
  const proposal = proposeSource(SOCRATA)

  it('uses the resource endpoint and the portal attribution', () => {
    expect(proposal.source.provider).toBe('Georgia Environmental Protection Division')
    expect(proposal.source.access).toEqual([
      { type: 'socrata', url: SOCRATA.finalUrl, format: 'json', auth: 'none', notes: 'inferred from the service' },
    ])
  })

  it('names the location column so a point query can be built', () => {
    expect(proposal.source.placeQuery).toEqual({
      by: ['point', 'county'],
      fipsField: 'county_fips',
      geoField: 'location_1',
    })
    expect(proposal.inferred).toContain('placeQuery.geoField')
  })

  it('keeps the cadence the portal reported', () => {
    expect(proposal.source.updateCadence).toBe('Quarterly')
    expect(proposal.inferred).toContain('updateCadence')
  })

  it('produces a block the filing route accepts unchanged', () => {
    const { source, dropped } = parseSourceMeta(proposal.source)
    expect(dropped).toEqual([])
    expect(source).toEqual(proposal.source)
  })
})

describe('proposeSource - a direct file', () => {
  const proposal = proposeSource(CSV)

  it('is a download with the format the probe saw', () => {
    expect(proposal.source.access).toEqual([
      { type: 'download', url: CSV.url, format: 'csv', auth: 'none', notes: 'inferred from the link' },
    ])
  })

  it('is county-shaped because of its GEOID column, and can only be asked by county', () => {
    expect(proposal.source.geography).toBe('county')
    expect(proposal.source.placeQuery).toEqual({ by: ['county'], fipsField: 'GEOID' })
  })

  it('falls back to the file name for the program when there is no title', () => {
    expect(proposal.source.program).toBe('nri_counties.csv')
  })
})

describe('proposeSource - pages and services', () => {
  it('a portal page proposes no access method: there is no one endpoint to call', () => {
    const proposal = proposeSource({
      kind: 'portal',
      confidence: 'high',
      url: 'https://opendata.georgia.gov/datasets/water-systems',
      title: 'Community Water Systems',
      provider: 'Georgia EPD',
      links: [{ url: 'https://opendata.georgia.gov/datasets/water-systems.csv', kind: 'file' }],
      checkedAt: 'x',
    })
    expect(proposal.source.access).toBeUndefined()
    expect(proposal.source.provider).toBe('Georgia EPD')
    expect(proposal.source.notes).toMatch(/pick one of the downloads/i)
  })

  it('an ArcGIS service with many layers proposes none of them', () => {
    const proposal = proposeSource({
      kind: 'arcgis-service',
      confidence: 'high',
      url: 'https://hazards.fema.gov/arcgis/rest/services/NFHL/MapServer',
      title: 'National Flood Hazard Layer',
      layers: [
        { id: 0, name: 'Zones', url: 'https://hazards.fema.gov/arcgis/rest/services/NFHL/MapServer/0', geometry: 'polygon' },
      ],
      checkedAt: 'x',
    })
    expect(proposal.source.access).toBeUndefined()
    expect(proposal.source.notes).toMatch(/pick a layer/i)
  })

  it('an http-only file keeps the source but says why the endpoint is missing', () => {
    const proposal = proposeSource({ ...CSV, url: 'http://old.example/data.csv', finalUrl: 'http://old.example/data.csv' })
    expect(proposal.source.access).toBeUndefined()
    expect(proposal.source.homepage).toBeUndefined()
    expect(proposal.source.notes).toMatch(/not https/i)
  })
})

describe('proposeSource - the filing suggestion', () => {
  const proposal = proposeSource(ARCGIS, {
    at: '2026-09-06T00:00:00.000Z',
    model: 'test-model',
    title: 'EPA Superfund sites',
    category: 'environment',
    tags: ['contamination', 'superfund'],
    summary: 'Every Superfund site on the National Priorities List, with its score.',
  })

  it('fills title, category, tags, topics and relevance from the model', () => {
    expect(proposal.title).toBe('EPA Superfund sites')
    expect(proposal.category).toBe('environment')
    expect(proposal.tags).toEqual(['contamination', 'superfund'])
    expect(proposal.source.topics).toEqual(['contamination', 'superfund'])
    expect(proposal.source.relevance).toContain('Superfund site')
    expect(proposal.inferred).toEqual(expect.arrayContaining(['title', 'category', 'tags', 'topics', 'relevance']))
  })

  it('keeps the service description as the entry description, not the model summary', () => {
    expect(proposal.description).toBe('Point locations of Superfund sites.')
  })
})

describe('proposeSource - caps', () => {
  it('keeps at most 40 fields, the same ceiling the manifest parser enforces', () => {
    const many = Array.from({ length: 90 }, (_, i) => ({ name: `col_${i}` }))
    const proposal = proposeSource({ ...ARCGIS, fields: many })
    expect(proposal.source.fields).toHaveLength(40)
    const { dropped } = parseSourceMeta(proposal.source)
    expect(dropped).toEqual([])
  })

  it('an unreachable link proposes nothing but the host', () => {
    const proposal = proposeSource({ kind: 'unreachable', confidence: 'high', url: 'https://gone.example/x', checkedAt: 'x' })
    expect(proposal.source.provider).toBe('gone.example')
    expect(proposal.source.access).toBeUndefined()
    expect(proposal.source.fields).toBeUndefined()
  })
})

/** Column sets copied off the live candidate services on 2026-09-06. */
describe('picking the county key out of a real layer', () => {
  const NC_PARCEL_FIELDS = [
    { name: 'parno' },
    { name: 'ownname' },
    { name: 'cntyfips' },
    { name: 'stfips' },
    { name: 'stcntyfips' },
    { name: 'parval' },
  ]

  it('prefers the 5-digit state+county code over the 3-digit one beside it', () => {
    expect(countyFipsField(NC_PARCEL_FIELDS)).toBe('stcntyfips')
  })

  it('reads the USGS spelling of the same idea', () => {
    expect(countyFipsField([{ name: 'STATE_FIPSCODE' }, { name: 'COUNTY_FIPSCODE' }, { name: 'STCO_FIPSCODE' }])).toBe(
      'STCO_FIPSCODE',
    )
  })

  it('takes the plain FIPS column of a county table', () => {
    expect(countyFipsField([{ name: 'FIPS' }, { name: 'State' }, { name: 'County_Name' }])).toBe('FIPS')
  })

  it('says a tract key is a tract key, and will not filter a county with it', () => {
    const wellWater = [{ name: 'geo_id' }, { name: 'state' }, { name: 'county' }, { name: 'ct_fips' }]
    expect(fipsColumnIn(wellWater)).toEqual({ field: 'geo_id', unit: 'county', valueType: 'text' })
    // Without the generic geo_id, the tract key is all there is.
    expect(fipsColumnIn([{ name: 'ct_fips' }, { name: 'wellpop_pcnt2' }])).toEqual({
      field: 'ct_fips',
      unit: 'tract',
      valueType: 'text',
    })
    expect(countyFipsField([{ name: 'ct_fips' }])).toBeNull()
    expect(rowGeography([{ name: 'ct_fips' }], 'table')).toBe('tract')
  })

  it('a tract-keyed Socrata set is asked about a county by prefix', () => {
    const proposal = proposeSource({
      kind: 'socrata',
      confidence: 'high',
      url: 'https://data.cdc.gov/d/fxwg-3udm',
      finalUrl: 'https://data.cdc.gov/resource/fxwg-3udm.json',
      title: 'Nationally-normed Well Water Index (WWI)',
      geometry: 'table',
      fields: [{ name: 'ct_fips', type: 'text' }, { name: 'wellpop_pcnt2', type: 'number' }],
      checkedAt: 'x',
    })
    expect(proposal.source.geography).toBe('tract')
    expect(proposal.source.placeQuery).toEqual({ by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' })
    expect(proposal.source.notes).toMatch(/first five digits/i)
  })
})

/**
 * P5-59, from the live walk: the CDC Well Water Index was proposed as a COUNTY
 * query on `geo_id`, and the county fetch that followed returned 0 rows
 * without saying why. The column names alone cannot tell those two ids apart —
 * the sample values can.
 */
describe('sample values decide what a FIPS column is', () => {
  const WELL_WATER = [
    { name: 'geo_id', type: 'text', sample: '1400000US13001950100' },
    { name: 'state', type: 'text', sample: 'Georgia' },
    { name: 'county', type: 'text', sample: 'Appling County' },
    { name: 'ct_fips', type: 'text', sample: '13001950100' },
    { name: 'wellpop_pcnt2', type: 'number', sample: '41.2' },
  ]

  it('refuses an id with a prefix on it and takes the one that is only digits', () => {
    expect(fipsColumnIn(WELL_WATER)).toEqual({ field: 'ct_fips', unit: 'tract', valueType: 'text' })
    expect(countyFipsField(WELL_WATER)).toBeNull()
  })

  it('reads the three census lengths and nothing else', () => {
    expect(fipsColumnIn([{ name: 'geoid', sample: '13089' }])).toEqual({ field: 'geoid', unit: 'county', valueType: 'text' })
    expect(fipsColumnIn([{ name: 'geoid', sample: '13001950100' }])).toEqual({ field: 'geoid', unit: 'tract', valueType: 'text' })
    // 12 digits is a block group, 15 a block; both are prefix-matched the same.
    expect(fipsColumnIn([{ name: 'geoid', sample: '130019501001' }])).toEqual({
      field: 'geoid',
      unit: 'blockgroup',
      valueType: 'text',
    })
    expect(fipsColumnIn([{ name: 'geoid', sample: '130019501001000' }])).toEqual({
      field: 'geoid',
      unit: 'blockgroup',
      valueType: 'text',
    })
    // A 3-digit within-state code is not a key we can filter a county with.
    expect(fipsColumnIn([{ name: 'cnty_fips', sample: '089' }])).toBeNull()
  })

  it('prefers a county key when one of the sampled columns really is one', () => {
    const both = [
      { name: 'geo_id', sample: '1400000US13001950100' },
      { name: 'county_fips', sample: '13001' },
      { name: 'ct_fips', sample: '13001950100' },
    ]
    expect(fipsColumnIn(both)).toEqual({ field: 'county_fips', unit: 'county', valueType: 'text' })
  })

  it('falls back to the names when the metadata carried no samples', () => {
    expect(fipsColumnIn([{ name: 'stcntyfips' }, { name: 'cntyfips' }])).toEqual({
      field: 'stcntyfips',
      unit: 'county',
      valueType: 'text',
    })
  })

  it('proposes the CDC shape as a prefix county query on the tract key', () => {
    const proposal = proposeSource({
      kind: 'socrata',
      confidence: 'high',
      url: 'https://data.cdc.gov/d/fxwg-3udm',
      finalUrl: 'https://data.cdc.gov/resource/fxwg-3udm.json',
      title: 'Nationally-normed Well Water Index (WWI)',
      geometry: 'table',
      fields: WELL_WATER,
      checkedAt: 'x',
    })
    expect(proposal.source.geography).toBe('tract')
    expect(proposal.source.placeQuery).toEqual({ by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' })
    expect(proposal.source.notes).toMatch(/Rows are census tracts, keyed by ct_fips/)
    // Still a block the filing route takes as it stands.
    const { source, dropped } = parseSourceMeta(proposal.source)
    expect(dropped).toEqual([])
    expect(source).toEqual(proposal.source)
  })

  /**
   * P5-59, second walk: the CDC set's samples came back NUMERIC —
   * `ct_fips` type `number`, sample "36119002000.0" — and a trailing `.0` read
   * as part of the code left the proposal with no place query at all.
   */
  describe('a numeric FIPS column', () => {
    const CDC_NUMERIC = [
      { name: 'geo_id', type: 'text', sample: '1400000US39017011131' },
      { name: 'state', type: 'number', sample: '6.0' },
      { name: 'county', type: 'number', sample: '3.0' },
      { name: 'tract', type: 'number', sample: '950100.0' },
      { name: 'ct_fips', type: 'number', sample: '36119002000.0' },
    ]

    it('reads through the float formatting to the id underneath', () => {
      expect(fipsColumnIn(CDC_NUMERIC)).toEqual({ field: 'ct_fips', unit: 'tract', valueType: 'number' })
      // The within-county tract number, the state and the county number are
      // none of them codes we can filter a county with.
      expect(countyFipsField(CDC_NUMERIC)).toBeNull()
    })

    it('accepts a code one digit short, because a number lost its leading zero', () => {
      // Alabama's 01001 is stored as 1001.
      expect(fipsColumnIn([{ name: 'fips', type: 'number', sample: '1001.0' }])).toEqual({
        field: 'fips',
        unit: 'county',
        valueType: 'number',
      })
      expect(fipsColumnIn([{ name: 'geoid', type: 'number', sample: '1001000100' }])).toEqual({
        field: 'geoid',
        unit: 'tract',
        valueType: 'number',
      })
      // A text column keeps its zeros, so four digits there is not a county.
      expect(fipsColumnIn([{ name: 'fips', type: 'text', sample: '1001' }])).toBeNull()
    })

    it('is still not fooled by a real fraction', () => {
      expect(fipsColumnIn([{ name: 'fips', type: 'number', sample: '41.25' }])).toBeNull()
    })

    it('proposes the CDC shape with the type on it, and the block survives filing', () => {
      const proposal = proposeSource({
        kind: 'socrata',
        confidence: 'high',
        url: 'https://data.cdc.gov/d/fxwg-3udm',
        finalUrl: 'https://data.cdc.gov/resource/fxwg-3udm.json',
        title: 'Nationally-normed Well Water Index (WWI)',
        geometry: 'table',
        fields: CDC_NUMERIC,
        checkedAt: 'x',
      })
      expect(proposal.source.geography).toBe('tract')
      expect(proposal.source.placeQuery).toEqual({
        by: ['county'],
        fipsField: 'ct_fips',
        fipsMatch: 'prefix',
        fipsType: 'number',
      })
      expect(proposal.inferred).toEqual(expect.arrayContaining(['placeQuery.fipsMatch', 'placeQuery.fipsType']))
      const { source, dropped } = parseSourceMeta(proposal.source)
      expect(dropped).toEqual([])
      expect(source).toEqual(proposal.source)
    })

    it('leaves a text column exactly as it was', () => {
      const proposal = proposeSource({
        kind: 'socrata',
        confidence: 'high',
        url: 'https://data.example.gov/d/aaaa-bbbb',
        finalUrl: 'https://data.example.gov/resource/aaaa-bbbb.json',
        title: 'Text-keyed tracts',
        geometry: 'table',
        fields: [{ name: 'ct_fips', type: 'text', sample: '13001950100' }],
        checkedAt: 'x',
      })
      expect(proposal.source.placeQuery).toEqual({ by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' })
      expect(proposal.source.placeQuery?.fipsType).toBeUndefined()
    })
  })

  it('a block-group table says block group, not tract', () => {
    const proposal = proposeSource({
      kind: 'socrata',
      confidence: 'high',
      url: 'https://data.example.gov/d/aaaa-bbbb',
      finalUrl: 'https://data.example.gov/resource/aaaa-bbbb.json',
      title: 'Something by block group',
      geometry: 'table',
      fields: [{ name: 'bg_fips', sample: '130019501001' }, { name: 'value', sample: '3' }],
      checkedAt: 'x',
    })
    expect(proposal.source.geography).toBe('blockgroup')
    expect(proposal.source.placeQuery).toEqual({ by: ['county'], fipsField: 'bg_fips', fipsMatch: 'prefix' })
  })
})

/**
 * P5-61: the half of a proposal that came out of a page's PROSE.
 *
 * Everything here is a weaker claim than a service describing itself — a model
 * read a paragraph — so the rules are: it fills gaps rather than overriding
 * facts, every field it fills is inferred, and each carries the sentence it
 * was read from so a person can check it without reading the page.
 */
describe('proposeSource - what a page said (P5-61)', () => {
  const PAGE: Inspection = {
    kind: 'page',
    confidence: 'medium',
    url: 'https://epd.example.gov/programs/wells',
    finalUrl: 'https://epd.example.gov/programs/wells',
    title: 'Private Well Testing Program',
    links: [
      {
        url: 'https://epd.example.gov/files/wells-2024.csv',
        label: 'county-level CSV file',
        kind: 'file',
        role: 'data-file',
        reason: 'The annual results file.',
      },
      { url: 'https://epd.example.gov/developers/wells', label: 'API documentation', role: 'docs', reason: 'Documents the endpoint.' },
    ],
    candidates: 46,
    pruned: 'model',
    prose: {
      isDataset: true,
      provider: 'Georgia Environmental Protection Division',
      program: 'Private Well Testing Program',
      updateCadence: 'Once a year, each spring',
      license: 'Public domain',
      coverage: '2016 to 2024',
      geography: 'One row per sampled well',
      accessNotes: [
        { kind: 'download', text: 'A county-level CSV of every sampled well.', url: 'https://epd.example.gov/files/wells-2024.csv' },
        { kind: 'request', text: 'County health departments can email wells@epd.example.gov for raw lab reports.' },
      ],
      evidence: {
        updateCadence: 'Results are published once a year, each spring, covering the previous calendar year.',
        license: 'and are in the public domain.',
        coverage: 'has sampled private drinking-water wells across Georgia since 2016',
      },
    },
    checkedAt: '2026-09-06T00:00:00.000Z',
  }

  it('fills provider, cadence, licence and coverage from the words, all inferred', () => {
    const proposal = proposeSource(PAGE)
    expect(proposal.source.provider).toBe('Georgia Environmental Protection Division')
    expect(proposal.source.updateCadence).toBe('Once a year, each spring')
    expect(proposal.source.license).toBe('Public domain')
    expect(proposal.source.coverage).toBe('2016 to 2024')
    expect(proposal.inferred).toEqual(
      expect.arrayContaining(['provider', 'updateCadence', 'license', 'coverage', 'geography', 'access']),
    )
  })

  it('keeps the sentence each field was read from', () => {
    const { evidence } = proposeSource(PAGE)
    expect(evidence).toEqual({
      updateCadence: 'Results are published once a year, each spring, covering the previous calendar year.',
      license: 'and are in the public domain.',
      coverage: 'has sampled private drinking-water wells across Georgia since 2016',
    })
  })

  it('turns an access note with a kept URL into an endpoint, and the rest into notes', () => {
    const { source } = proposeSource(PAGE)
    expect(source.access).toEqual([
      {
        type: 'download',
        url: 'https://epd.example.gov/files/wells-2024.csv',
        auth: 'none',
        notes: 'A county-level CSV of every sampled well.',
        // The docs link documents the endpoint rather than serving it.
        docs: 'https://epd.example.gov/developers/wells',
      },
    ])
    expect(source.notes).toContain('wells@epd.example.gov')
    expect(source.notes).toMatch(/ask for it/i)
  })

  it('never lets a service’s own words be overridden by a model’s reading', () => {
    const declared = proposeSource({
      ...PAGE,
      provider: 'US EPA Office of Land and Emergency Management',
      cadence: 'Quarterly',
      license: 'CC0 1.0',
    })
    expect(declared.source.provider).toBe('US EPA Office of Land and Emergency Management')
    expect(declared.source.updateCadence).toBe('Quarterly')
    expect(declared.source.license).toBe('CC0 1.0')
    // Declared values need no evidence — the endpoint IS the evidence.
    expect(declared.evidence?.updateCadence).toBeUndefined()
    expect(declared.evidence?.license).toBeUndefined()
  })

  it('maps geography words onto the schema, and keeps the rest as a note', () => {
    expect(proposeSource(PAGE).source.geography).toBe('point')
    expect(proposeSource({ ...PAGE, prose: { ...PAGE.prose, geography: 'one row per census tract' } }).source.geography).toBe('tract')
    // Words that match nothing filterable must not be forced into the enum.
    const vague = proposeSource({ ...PAGE, prose: { ...PAGE.prose, geography: 'it varies by programme year' } })
    expect(vague.source.geography).toBeUndefined()
    expect(vague.source.notes).toContain('it varies by programme year')
  })

  it('drops an access note whose URL is not one of the kept links', () => {
    const { source } = proposeSource({
      ...PAGE,
      prose: {
        ...PAGE.prose,
        accessNotes: [{ kind: 'download', text: 'Somewhere else entirely.', url: 'https://elsewhere.example/x.csv' }],
      },
    })
    // It never becomes an endpoint — only the kept links can — but what the
    // page said is not thrown away either.
    expect(source.access?.some(a => a.url?.includes('elsewhere'))).toBe(false)
    expect(source.notes).toContain('Somewhere else entirely.')
  })

  it('still survives the filing route’s own parser, unchanged', () => {
    const { source } = proposeSource(PAGE)
    const parsed = parseSourceMeta(source)
    expect(parsed.dropped).toEqual([])
    expect(parsed.source).toEqual(source)
  })

  it('says nothing extra about a page that turned out to hold no data', () => {
    const bare: Inspection = { ...PAGE, links: undefined, prose: { isDataset: false }, candidates: 46 }
    const proposal = proposeSource(bare)
    expect(proposal.evidence).toBeUndefined()
    expect(proposal.source.access).toBeUndefined()
    expect(proposal.source.notes).toMatch(/not a dataset/i)
  })
})

/**
 * P5-63 — the drop-a-link path files itself in the same vocabulary as
 * everything else. Before this ticket the page-reading pass and the library
 * list spoke different words, so a dropped link arrived under a category the
 * facet had never heard of.
 */
describe('the taxonomy in a proposal (P5-63)', () => {
  const page: Inspection = {
    ...CSV,
    prose: { provider: 'USGS', topic: 'water', tags: ['watershed', 'wells'] },
  }

  it('takes the category and tags from the page’s own topic when no filing pass ran', () => {
    const proposal = proposeSource(page)
    expect(proposal.category).toBe('water')
    expect(proposal.tags).toEqual(['watershed', 'wells'])
    expect(proposal.source.topics).toEqual(['watershed', 'wells'])
    // Marked as inferred, like every other field a machine filled in.
    expect(proposal.inferred).toEqual(expect.arrayContaining(['category', 'tags', 'topics']))
  })

  it('lets the filing pass win, because it read the document rather than the page around it', () => {
    const proposal = proposeSource(page, {
      at: 'T',
      model: 'm',
      category: 'hazards',
      tags: ['flood'],
    })
    expect(proposal.category).toBe('hazards')
    expect(proposal.tags).toEqual(['flood'])
    expect(proposal.source.topics).toEqual(['flood'])
  })

  it('folds a portal’s own keywords where they name a taxonomy word, and keeps the rest as prose', () => {
    const proposal = proposeSource({ ...CSV, topics: ['Demographics', 'Environmental Risk', 'impaired waters'] })
    // `demographics` folds to the People topic; `environmental-risk` stays a cross-cutting tag.
    expect(proposal.source.topics).toEqual(['demographic', 'environmental-risk', 'impaired waters'])
  })
})

describe('coverage is proposed as structure, not only as a sentence (P6-32)', () => {
  /** Minimal, local: PAGE belongs to another describe. */
  const base: Inspection = {
    kind: 'page',
    confidence: 'medium',
    url: 'https://example.gov/program',
    finalUrl: 'https://example.gov/program',
    title: 'A program page',
  }

  it('carries the structured claim beside the readable one', () => {
    const p = proposeSource({ ...base, extent: { xmin: -125, ymin: 25, xmax: -67, ymax: 49 } })
    expect(p.source.coverage).toBe('national')
    expect(p.coverage).toMatchObject({ scope: 'national' })
  })

  it('declines rather than guessing when the reading is not unambiguous', () => {
    // The shape source.coverage takes when the model read it off prose. The
    // sentence is kept for a person to read; nothing structured is claimed.
    const p = proposeSource({ ...base, prose: { coverage: '2013 to 2023, all 50 states and Puerto Rico' } })
    expect(p.source.coverage).toBe('2013 to 2023, all 50 states and Puerto Rico')
    expect(p.coverage).toBeUndefined()
  })

  it('keeps a qualifier on the structured value rather than dropping it', () => {
    const p = proposeSource({ ...base, prose: { coverage: 'national (coastal states only)' } })
    expect(p.coverage).toMatchObject({ scope: 'national', note: 'coastal states only' })
  })

  it('marks it inferred, so the form shows it as a machine claim', () => {
    const p = proposeSource({ ...base, prose: { coverage: 'Georgia' } })
    expect(p.coverage).toMatchObject({ scope: 'state', states: ['GA'] })
    expect(p.inferred).toContain('coverage')
  })
})

describe('what the data answers rides the proposal (P7-7)', () => {
  const base: Inspection = {
    kind: 'page',
    confidence: 'medium',
    url: 'https://example.gov/parcels',
    finalUrl: 'https://example.gov/parcels',
    title: 'Parcel boundaries',
    checkedAt: 'T',
  }
  const ANSWER = 'Answers: which parcels sit within N miles of a transmission line.'
  const EVIDENCE = 'Each parcel record includes the distance to the nearest transmission corridor.'

  it('carries the line with the sentence it was read from', () => {
    // P6-32's shape for the structured coverage, and P5-61's rule underneath
    // it: a value a model inferred from words is a weaker claim than one a
    // service declared, so the claim travels with its evidence.
    const p = proposeSource({ ...base, prose: { whatItAnswers: ANSWER, evidence: { whatItAnswers: EVIDENCE } } })
    expect(p.whatItAnswers).toBe(ANSWER)
    expect(p.inferred).toContain('whatItAnswers')
    expect(p.evidence?.whatItAnswers).toBe(EVIDENCE)
  })

  it('is not a field of the source block', () => {
    // Coverage is the service's own claim about itself and belongs in the
    // block; this is a claim about the dataset as the library holds it, and
    // `meta.whatItAnswers` is where every reader looks for it.
    const p = proposeSource({ ...base, prose: { whatItAnswers: ANSWER } })
    expect((p.source as Record<string, unknown>).whatItAnswers).toBeUndefined()
  })

  it('proposes nothing when the page said nothing that is an answer', () => {
    // There is no deterministic half for this field: no extent, no column
    // names, nothing to fall back on. A page that does not say leaves the
    // entry on the needs-a-look row, which is the honest answer.
    const p = proposeSource({ ...base, prose: { provider: 'US EPA' } })
    expect(p.whatItAnswers).toBeUndefined()
    expect(p.inferred).not.toContain('whatItAnswers')
  })
})
