import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  BUILT_FILE_PATTERN,
  COUNTY_DATA_VERSION,
  DEFAULT_GEOMETRY,
  SOURCE_FILES,
  buildCountyData,
  buildDatasets,
  hashOf,
  parseArgs,
 roundGeometry, DEFAULT_PRECISION } from '../build-datasets.mjs'

/**
 * P5-90. The map's startup used to be thirteen fetches and ten main-thread
 * Papa parses. `scripts/build-datasets.mjs` folds them into one content-hashed
 * JSON file plus the geometry, and writes the manifest the bundle imports.
 *
 * These run the real script against a miniature dataset tree, so the field
 * names the app's refs expose are pinned here: renaming one breaks the test,
 * not the map.
 */

// --- A two-county dataset tree -------------------------------------------------

const CSV_FIXTURES: Record<string, string> = {
  diversity: [
    'STATE,COUNTY,STNAME,CTYNAME,diversity_index,total_population,pct_nhBlack,pct_Black,total_Black,NH_White,NH_Black,NH_AmIndian,NH_Asian,NH_PacIslander,NH_TwoOrMore,Hispanic,GEOID',
    '1,1,Alabama,Autauga County,0.4445,60342,20.99,21.4,12917,43062,12666,242,770,52,1225,2325,01001',
    '6,37,California,Los Angeles County,0.7,9829544,7.6,8.4,825000,2500000,800000,20000,1400000,25000,200000,4800000,06037',
    '',
  ].join('\n'),
  lifeExpectancy: [
    'GEOID,STATE2KX,CNTY2KX,e(0),se(e(0))',
    '01001,1,1,75.3,1.835',
    '06037,6,37,80.1,0.21',
    '',
  ].join('\n'),
  wages: [
    'GEOID,county_name,state_name,year,avg_weekly_wage,quarterly_establishments',
    '01001,"Autauga County, Alabama",Alabama,2025,900,51',
    '',
  ].join('\n'),
  income: [
    'GEOID,county_name,state_name,year,median_income,median_income_black,median_income_white,median_income_hispanic,median_income_asian',
    '01001,"Autauga County, Alabama",Alabama,2023,63423,41000,67426,40192,0',
    // Only in the income file: proves the merge creates the record with a zero wage.
    '06037,"Los Angeles County, California",California,2023,80000,55000,90000,60000,0',
    '',
  ].join('\n'),
  homeValue: [
    'GEOID,county_name,state_name,year,median_home_value_with_mortgage,median_home_value_without_mortgage,pct_homeownership_black',
    '01001,"Autauga County, Alabama",Alabama,2023,225000,150000,0',
    '',
  ].join('\n'),
  propertyTax: [
    'GEOID,county_name,state_name,year,median_property_tax_with_mortgage,median_property_tax_without_mortgage',
    '01001,"Autauga County, Alabama",Alabama,2023,821,504',
    '06037,"Los Angeles County, California",California,2023,5000,3000',
    '',
  ].join('\n'),
  homeownership: [
    'GEOID,county_name,state_name,year,black_population,homeownership_rate,homeownership_rate_black,homeownership_rate_white',
    '01001,"Autauga County, Alabama",Alabama,2023,12917,38.3,36,51.9',
    '',
  ].join('\n'),
  poverty: [
    'GEOID,county_name,state_name,year,poverty_rate,poverty_rate_black,poverty_rate_white',
    '01001,"Autauga County, Alabama",Alabama,2023,12.1,16.6,9.4',
    '',
  ].join('\n'),
  blackProgress: [
    'GEOID,county_name,state,black_progress_index,black_progress_index_centile,pct_black',
    '01001,Autauga County,Alabama,72.802681,39,0.195',
    '06037,Los Angeles County,California,60.5,20,0.084',
    '',
  ].join('\n'),
  commute: [
    'GEOID,county_name,state_name,year,most_frequent_commute_time,commute_time_ordinal,pct_drove_alone,pct_carpooled,pct_public_transit,pct_black',
    '01001,Autauga County,Alabama,2023,30 to 34 minutes,7,19.5,23,51.6,20',
    '',
  ].join('\n'),
}

const JSON_FIXTURES: Record<string, unknown> = {
  contamination: {
    // Both shapes the counts file has used.
    '01001': { total: 15, layers: { superfund_sites: 6, acres_brownfields: 2 } },
    '06037': 40,
  },
  combinedScores: {
    '01001': {
      rawValues: { contamination: 15 },
      scores: { contaminationScore: 3 },
      combinedScore: 4.333,
      rankScore: 30,
      stdDevsFromMean: 2.28,
      countiesWithSameRank: 69,
    },
  },
  combinedScoresV2: {
    '01001': {
      fips: '01001',
      county_name: 'Autauga County',
      state_name: 'Alabama',
      blo_score_v2: 2.83,
      components: { diversity: 0.58 },
      raw: { diversity_index: 0.58 },
      missing_data: [],
    },
  },
}

const GEOMETRY = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { GEOID: '01001', NAME: 'Autauga' }, geometry: null },
  ],
})

let root: string

function writeTree(overrides: Record<string, string> = {}) {
  for (const [key, rel] of Object.entries(SOURCE_FILES as Record<string, string>)) {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    const content =
      overrides[key] ??
      (rel.endsWith('.json') ? JSON.stringify(JSON_FIXTURES[key]) : CSV_FIXTURES[key])
    writeFileSync(full, content)
  }
  const geometryPath = join(root, DEFAULT_GEOMETRY)
  mkdirSync(dirname(geometryPath), { recursive: true })
  writeFileSync(geometryPath, overrides.geometry ?? GEOMETRY)
}

const readManifest = () =>
  JSON.parse(readFileSync(join(root, 'src/config/datasetsManifest.generated.json'), 'utf8'))

const builtFiles = () => readdirSync(join(root, 'public/datasets/build')).sort()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blo-build-datasets-'))
  writeTree()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('buildCountyData — one file, the field names the refs expose', () => {
  const build = () => buildCountyData({ ...CSV_FIXTURES, ...JSON_FIXTURES })

  it('keys every section by 5-digit GEOID, zero-padded', () => {
    const data = build()
    expect(data.version).toBe(COUNTY_DATA_VERSION)
    for (const section of [
      'diversity',
      'lifeExpectancy',
      'contamination',
      'combinedScores',
      'combinedScoresV2',
      'economic',
      'housing',
      'equity',
      'transportation',
    ]) {
      for (const geoId of Object.keys(data[section])) {
        expect(geoId).toMatch(/^\d{5}$/)
      }
    }
    expect(Object.keys(data.diversity)).toEqual(['01001', '06037'])
  })

  it('carries the demographic fields the tooltip, modal and choropleth read', () => {
    expect(build().diversity['01001']).toEqual({
      diversityIndex: 0.4445,
      totalPopulation: 60342,
      pct_nhBlack: 20.99,
      pct_Black: 21.4,
      total_Black: 12917,
      nhWhite: 43062,
      nhBlack: 12666,
      nhAmIndian: 242,
      nhAsian: 770,
      nhPacIslander: 52,
      nhTwoOrMore: 1225,
      hispanic: 2325,
      countyName: 'Autauga County',
      stateName: 'Alabama',
    })
  })

  it('rebuilds the life-expectancy GEOID from its state and county columns', () => {
    expect(build().lifeExpectancy['01001']).toEqual({ lifeExpectancy: 75.3, standardError: 1.835 })
    expect(build().lifeExpectancy['06037']).toEqual({ lifeExpectancy: 80.1, standardError: 0.21 })
  })

  it('merges the two economic files, inventing a zero wage for income-only counties', () => {
    const economic = build().economic
    expect(economic['01001']).toEqual({
      GEOID: '01001',
      county_name: 'Autauga County, Alabama',
      state_name: 'Alabama',
      year: 2025,
      avg_weekly_wage: 900,
      median_income_black: 41000,
    })
    expect(economic['06037'].avg_weekly_wage).toBe(0)
    expect(economic['06037'].median_income_black).toBe(55000)
  })

  it('merges the three housing files into one record per county', () => {
    const housing = build().housing
    expect(housing['01001']).toEqual({
      GEOID: '01001',
      county_name: 'Autauga County, Alabama',
      state_name: 'Alabama',
      year: 2023,
      median_home_value: 225000,
      median_property_tax: 821,
      homeownership_rate_black: 36,
    })
    // Property-tax-only county: the record exists with just that field.
    expect(housing['06037']).toEqual({
      GEOID: '06037',
      county_name: 'Los Angeles County, California',
      state_name: 'California',
      year: 2023,
      median_property_tax: 5000,
    })
  })

  it('merges poverty and the Black Progress Index into equity', () => {
    const equity = build().equity
    expect(equity['01001']).toMatchObject({
      GEOID: '01001',
      poverty_rate_black: 16.6,
      black_progress_index: 72.802681,
    })
    // Index-only county keeps the index file's `state` column, as the loader did.
    expect(equity['06037']).toEqual({
      GEOID: '06037',
      county_name: 'Los Angeles County',
      state: 'California',
      black_progress_index: 60.5,
    })
  })

  it('carries every commute field the transportation layers read', () => {
    expect(build().transportation['01001']).toEqual({
      GEOID: '01001',
      county_name: 'Autauga County',
      state_name: 'Alabama',
      year: 2023,
      most_frequent_commute_time: '30 to 34 minutes',
      commute_time_ordinal: 7,
      pct_drove_alone: 19.5,
      pct_carpooled: 23,
      pct_public_transit: 51.6,
      pct_black: 20,
    })
  })

  it('reduces the counts and score files to the fields anything actually reads', () => {
    const data = build()
    // Contamination: the total, both from the object form and the bare number.
    expect(data.contamination).toEqual({ '01001': { total: 15 }, '06037': { total: 40 } })
    // v1 scores: score + rank (the modal's fields); no rawValues/scores blob.
    expect(data.combinedScores['01001']).toEqual({ combinedScore: 4.333, rankScore: 30 })
    // v2 scores: the one number the default layer paints with.
    expect(data.combinedScoresV2['01001']).toEqual({ blo_score_v2: 2.83 })
  })

  it('skips trailing blank rows rather than keying data under "undefined"', () => {
    const data = build()
    for (const section of Object.values(data)) {
      if (typeof section === 'object') expect(Object.keys(section)).not.toContain('undefined')
    }
  })
})

describe('buildDatasets — hashed output, manifest, pruning', () => {
  it('writes both files under a content hash and a manifest pointing at them', () => {
    const result = buildDatasets({ root, quiet: true })

    const files = builtFiles()
    expect(files).toHaveLength(2)
    for (const f of files) expect(f).toMatch(BUILT_FILE_PATTERN)

    const manifest = readManifest()
    expect(manifest).toEqual({ countyData: result.countyData, counties: result.counties })
    expect(manifest.countyData).toBe(`/datasets/build/${files.find(f => f.startsWith('county-data'))}`)
    expect(manifest.counties).toBe(`/datasets/build/${files.find(f => f.startsWith('counties.'))}`)
    // The manifest's paths are what the browser fetches: absolute, no origin.
    for (const url of Object.values(manifest) as string[]) expect(url.startsWith('/datasets/build/')).toBe(true)
  })

  it('names the county file by the hash of its own bytes', () => {
    const result = buildDatasets({ root, quiet: true })
    const written = readFileSync(join(root, 'public/datasets', result.countyData.replace('/datasets/', '')), 'utf8')
    expect(result.countyData).toContain(hashOf(written))
    expect(JSON.parse(written).diversity['01001'].countyName).toBe('Autauga County')
  })

  it('is deterministic: the same inputs give the same names and bytes', () => {
    const first = buildDatasets({ root, quiet: true })
    const firstBytes = readFileSync(join(root, 'public/datasets/build', first.countyData.split('/').pop()!))
    const second = buildDatasets({ root, quiet: true })
    expect(second.countyData).toBe(first.countyData)
    expect(second.counties).toBe(first.counties)
    expect(builtFiles()).toHaveLength(2)
    expect(readFileSync(join(root, 'public/datasets/build', second.countyData.split('/').pop()!))).toEqual(firstBytes)
  })

  it('renames on a data change and deletes the hash it replaced', () => {
    const before = buildDatasets({ root, quiet: true })
    writeTree({ commute: CSV_FIXTURES.commute.replace('19.5', '42.5') })
    const after = buildDatasets({ root, quiet: true })

    expect(after.countyData).not.toBe(before.countyData)
    expect(after.counties).toBe(before.counties) // geometry untouched
    expect(builtFiles()).toHaveLength(2)
    expect(builtFiles()).not.toContain(before.countyData.split('/').pop())
    expect(readManifest().countyData).toBe(after.countyData)
  })

  it('sweeps out anything else left in the build directory', () => {
    buildDatasets({ root, quiet: true })
    writeFileSync(join(root, 'public/datasets/build', 'stray-internal-data.csv'), 'GEOID\n01001\n')
    buildDatasets({ root, quiet: true })
    expect(builtFiles()).toHaveLength(2)
    expect(builtFiles()).not.toContain('stray-internal-data.csv')
  })

  it('takes a simplified outline file via --geometry, and hashes that instead', () => {
    const full = buildDatasets({ root, quiet: true })
    const lighter = join(root, 'candidate.geojson')
    writeFileSync(lighter, JSON.stringify({ type: 'FeatureCollection', features: [] }))

    const result = buildDatasets({ root, geometry: lighter, quiet: true })
    expect(result.counties).not.toBe(full.counties)
    expect(result.countyData).toBe(full.countyData) // data is unaffected by geometry
    const copied = readFileSync(join(root, 'public/datasets/build', result.counties.split('/').pop()!), 'utf8')
    expect(JSON.parse(copied).features).toEqual([])
    expect(builtFiles()).toHaveLength(2)
  })

  it('reports the byte sizes so a build log shows the payload', () => {
    const result = buildDatasets({ root, quiet: true })
    expect(result.countyDataBytes).toBeGreaterThan(0)
    expect(result.countiesBytes).toBe(Buffer.byteLength(GEOMETRY))
  })
})

describe('parseArgs', () => {
  it('reads --geometry in both spellings and --quiet', () => {
    expect(parseArgs([])).toEqual({})
    expect(parseArgs(['--quiet'])).toEqual({ quiet: true })
    expect(parseArgs(['--geometry', 'a/b.geojson'])).toEqual({ geometry: 'a/b.geojson' })
    expect(parseArgs(['--geometry=a/b.geojson'])).toEqual({ geometry: 'a/b.geojson' })
  })

  it('refuses a --geometry with no path instead of silently using the default', () => {
    expect(() => parseArgs(['--geometry'])).toThrow(/--geometry/)
    expect(() => parseArgs(['--geometry', '--quiet'])).toThrow(/--geometry/)
    expect(() => parseArgs(['--geometry='])).toThrow(/--geometry/)
  })

  it('rejects an argument it does not know rather than ignoring it', () => {
    expect(() => parseArgs(['--simplify'])).toThrow(/unknown argument/)
  })
})

describe('roundGeometry — coordinate rounding only (P5-90, Nick’s choice)', () => {
  const src = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { GEOID: '06075' }, geometry: { type: 'Polygon', coordinates: [[[-122.511983, 37.771129999086256], [-122.465396, 37.800878999086], [-122.5, 37.75], [-122.511983, 37.771129999086256]]] } },
      { type: 'Feature', properties: { GEOID: '13121' }, geometry: { type: 'MultiPolygon', coordinates: [[[[-84.1234567891, 33.9876543219], [-84.2, 33.9], [-84.15, 33.95], [-84.1234567891, 33.9876543219]]]] } },
    ],
  })
  it('keeps every vertex and writes at most four decimals, each within half a step of the source', () => {
    const out = JSON.parse(roundGeometry(src, 4))
    const before = JSON.parse(src)
    const flat = (c: unknown[]): number[][] => (typeof c[0] === 'number' ? [c as number[]] : (c as unknown[][]).flatMap(flat))
    for (let i = 0; i < before.features.length; i++) {
      const a = flat(before.features[i].geometry.coordinates)
      const b = flat(out.features[i].geometry.coordinates)
      expect(b.length).toBe(a.length)
      for (let k = 0; k < a.length; k++) {
        expect(Math.abs(a[k][0] - b[k][0])).toBeLessThanOrEqual(0.00005)
        expect(Math.abs(a[k][1] - b[k][1])).toBeLessThanOrEqual(0.00005)
        expect(String(b[k][1]).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4)
      }
    }
    expect(out.features[0].properties).toEqual({ GEOID: '06075' })
    expect(roundGeometry(src, 4).length).toBeLessThan(src.length)
  })
  it('is the build’s default, and precision null ships the source bytes', () => {
    expect(DEFAULT_PRECISION).toBe(4)
  })
})
