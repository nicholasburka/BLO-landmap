import { describe, it, expect, vi } from 'vitest'
import {
  geocodeRows,
  cachedResolver,
  memoryCache,
  FipsIndex,
  normalizeCountyName,
  normalizeStateAbbr,
  parseAltLocation,
  detectConflictField,
  parseCsv,
  toCsv,
  parseGeocodeArgs,
  formatReport,
  liveResolver,
  type Resolver,
  type CountyLookupEntry,
} from './geocode.js'

/** P5-23: enrichment pathway. Unit tests never touch the network — the
 *  resolver is a fake keyed by input; one gated test hits the real Census API. */

const LOOKUP: CountyLookupEntry[] = [
  { geoId: '13121', name: 'Fulton County', baseName: 'Fulton', stateName: 'Georgia', stateAbbr: 'GA' },
  { geoId: '22071', name: 'Orleans Parish', baseName: 'Orleans', stateName: 'Louisiana', stateAbbr: 'LA' },
  { geoId: '29510', name: 'St. Louis city', baseName: 'St. Louis', stateName: 'Missouri', stateAbbr: 'MO' },
  { geoId: '29189', name: 'St. Louis County', baseName: 'St. Louis', stateName: 'Missouri', stateAbbr: 'MO' },
  { geoId: '02020', name: 'Anchorage Municipality', baseName: 'Anchorage', stateName: 'Alaska', stateAbbr: 'AK' },
  { geoId: '01001', name: 'Autauga County', baseName: 'Autauga', stateName: 'Alabama', stateAbbr: 'AL' },
]

function fakeResolver(): Resolver & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async address(line) {
      calls.push(`address:${line}`)
      if (/westview/i.test(line)) return { lat: 33.7478, lng: -84.4212, geoId: '13121', matched: '1040 WESTVIEW DR SW', exact: true }
      if (/vague/i.test(line)) return { lat: 1, lng: 2, geoId: null, matched: 'VAGUE', exact: false }
      return null
    },
    async place(city, state) {
      calls.push(`place:${city},${state}`)
      if (/atlanta/i.test(city)) return { lat: 33.7545, lng: -84.3898, label: 'Atlanta, Fulton County, Georgia' }
      if (/east point/i.test(city)) return { lat: 33.6796, lng: -84.4394, label: 'East Point, Fulton County, Georgia' }
      if (/oakland/i.test(city)) return { lat: 37.8044, lng: -122.2712, label: 'Oakland, Alameda County, California' }
      if (/sacramento/i.test(city)) return { lat: 38.5816, lng: -121.4944, label: 'Sacramento, California' }
      return null
    },
    async county(lat, lng) {
      calls.push(`county:${lat},${lng}`)
      if (lat > 33 && lat < 34 && lng < -84) return '13121'
      if (lat > 37 && lat < 38) return '06001'
      if (lat > 38 && lat < 39) return '06067'
      if (lat === 1 && lng === 2) return '99999'
      return null
    },
  }
}

describe('helpers', () => {
  it('normalises state names/abbreviations and county spellings', () => {
    expect(normalizeStateAbbr('ga')).toBe('GA')
    expect(normalizeStateAbbr('Georgia')).toBe('GA')
    expect(normalizeStateAbbr('District of Columbia')).toBe('DC')
    expect(normalizeStateAbbr('Narnia')).toBeNull()
    expect(normalizeCountyName('St. Louis')).toBe('saint louis')
    expect(normalizeCountyName("Prince George's County")).toBe('prince georges county')
  })

  it('FIPS join handles Parish / Municipality / St. variants and refuses ambiguity', () => {
    const idx = new FipsIndex(LOOKUP)
    expect(idx.find('Fulton', 'GA')).toBe('13121')
    expect(idx.find('Fulton County', 'Georgia')).toBe('13121')
    expect(idx.find('Orleans', 'LA')).toBe('22071')
    expect(idx.find('Orleans Parish', 'LA')).toBe('22071')
    expect(idx.find('Anchorage', 'AK')).toBe('02020')
    expect(idx.find('Saint Louis city', 'MO')).toBe('29510')
    expect(idx.find('St. Louis County', 'MO')).toBe('29189')
    expect(idx.find('St. Louis', 'MO')).toBeNull() // city vs county — ambiguous without the type word
    expect(idx.find('Fulton', 'NY')).toBeNull()
    expect(idx.find('', 'GA')).toBeNull()
  })

  it('parses the first "City, ST" out of alternate-location text', () => {
    expect(parseAltLocation('Atlanta, GA (IRS BMF)')).toEqual({ city: 'Atlanta', state: 'GA' })
    expect(parseAltLocation('Sacramento, CA (IRS 990 mailbox); Chicago, IL (IRS BMF)')).toEqual({ city: 'Sacramento', state: 'CA' })
    expect(parseAltLocation('East Point, Georgia')).toEqual({ city: 'East Point', state: 'GA' })
    expect(parseAltLocation('Delaware registered-agent mailbox (IRS)')).toBeNull()
    expect(parseAltLocation('')).toBeNull()
  })

  it('detects the provenance prefix from _conflict + _alt_location columns', () => {
    expect(detectConflictField(['Organization', 'hq_conflict', 'hq_alt_location'])).toBe('hq')
    expect(detectConflictField(['Organization', 'hq_conflict'])).toBeNull()
  })
})

describe('geocodeRows', () => {
  const fips = new FipsIndex(LOOKUP)

  it('uses the street address (high), falls back to the place (medium), and reports unresolved rows', async () => {
    const r = fakeResolver()
    const { rows, columns, report } = await geocodeRows(
      [
        { Organization: 'TLW', 'HQ Street Address': '1040 Westview Dr SW', 'HQ City': 'Atlanta', 'HQ State': 'GA' },
        { Organization: 'NoStreet', 'HQ Street Address': '', 'HQ City': 'Atlanta', 'HQ State': 'GA' },
        { Organization: 'BadStreet', 'HQ Street Address': '1 Nowhere Rd', 'HQ City': 'Oakland', 'HQ State': 'CA' },
        { Organization: 'Lost', 'HQ Street Address': '', 'HQ City': 'Nowhere', 'HQ State': 'ZZ' },
        { Organization: 'Blank', 'HQ Street Address': '', 'HQ City': '', 'HQ State': '' },
      ],
      { address: 'HQ Street Address', city: 'HQ City', state: 'HQ State' },
      r,
      fips,
    )
    expect(columns.slice(-5)).toEqual(['lat', 'lng', 'GEOID', 'geocode_method', 'geocode_confidence'])
    expect(rows[0]).toMatchObject({ lat: '33.7478', lng: '-84.4212', GEOID: '13121', geocode_method: 'census-address', geocode_confidence: 'high' })
    expect(rows[1]).toMatchObject({ GEOID: '13121', geocode_method: 'nominatim-place+census-county', geocode_confidence: 'medium' })
    expect(rows[2]).toMatchObject({ GEOID: '06001', geocode_method: 'nominatim-place+census-county' })
    expect(rows[3]).toMatchObject({ lat: '', lng: '', GEOID: '', geocode_method: '', geocode_confidence: '' })
    expect(report.geocoded).toBe(3)
    expect(report.unmatched.map(u => u.key)).toEqual(['Lost', 'Blank'])
    expect(report.unmatched[1].reason).toMatch(/no location columns/)
    expect(report.methods).toEqual({ 'census-address': 1, 'nominatim-place+census-county': 2 })
  })

  it('a non-exact address match is medium and gets its county from coordinates', async () => {
    const { rows } = await geocodeRows([{ name: 'V', addr: 'vague street' }], { address: 'addr' }, fakeResolver(), fips)
    expect(rows[0]).toMatchObject({ GEOID: '99999', geocode_method: 'census-address', geocode_confidence: 'medium' })
  })

  it('existing coordinates only get the county join; existing complete rows are kept unless --force', async () => {
    const r = fakeResolver()
    const { rows, report } = await geocodeRows(
      [
        { name: 'A', latitude: '33.5', longitude: '-84.5' },
        { name: 'B', latitude: '33.5', longitude: '-84.5', lat: '33.5', lng: '-84.5', GEOID: '13121', geocode_method: 'manual', geocode_confidence: 'high' },
      ],
      { lat: 'latitude', lng: 'longitude' },
      r,
      fips,
    )
    expect(rows[0]).toMatchObject({ GEOID: '13121', geocode_method: 'existing-latlng+census-county', geocode_confidence: 'high' })
    expect(rows[1].geocode_method).toBe('manual')
    expect(report.kept).toBe(1)
    expect(r.calls).toEqual(['county:33.5,-84.5'])

    const forced = await geocodeRows([rows[1]], { lat: 'latitude', lng: 'longitude', force: true }, fakeResolver(), fips)
    expect(forced.rows[0].geocode_method).toBe('existing-latlng+census-county')
    expect(forced.report.kept).toBe(0)
  })

  it('joins county + state names offline (no resolver calls)', async () => {
    const r = fakeResolver()
    const { rows, report } = await geocodeRows(
      [
        { name: 'x', county: 'Orleans Parish', st: 'LA' },
        { name: 'y', county: 'Nowhere', st: 'LA' },
      ],
      { county: 'county', state: 'st' },
      r,
      fips,
    )
    expect(rows[0]).toMatchObject({ GEOID: '22071', geocode_method: 'fips-join', geocode_confidence: 'high', lat: '', lng: '' })
    expect(rows[1].GEOID).toBe('')
    expect(report.unmatched[0].reason).toMatch(/no unique county/)
    expect(r.calls).toEqual([])
  })

  it('geocodes city-level conflicts and says whether the alternate lands in the same county', async () => {
    const r = fakeResolver()
    const { rows, columns, report } = await geocodeRows(
      [
        { Organization: 'FSC', 'HQ City': 'East Point', 'HQ State': 'GA', hq_conflict: 'city', hq_alt_location: 'Atlanta, GA (IRS BMF)' },
        { Organization: 'HEAL', 'HQ City': 'Oakland', 'HQ State': 'CA', hq_conflict: 'city', hq_alt_location: 'Sacramento, CA (IRS 990 mailbox); Chicago, IL' },
        { Organization: 'Plain', 'HQ City': 'Atlanta', 'HQ State': 'GA', hq_conflict: '', hq_alt_location: '' },
        { Organization: 'Street', 'HQ City': 'Atlanta', 'HQ State': 'GA', hq_conflict: 'street', hq_alt_location: '123 Old St' },
      ],
      { city: 'HQ City', state: 'HQ State' },
      r,
      fips,
    )
    expect(columns.slice(-2)).toEqual(['hq_alt_geoid', 'hq_same_county'])
    expect(rows[0]).toMatchObject({ GEOID: '13121', hq_alt_geoid: '13121', hq_same_county: 'yes' })
    expect(rows[1]).toMatchObject({ GEOID: '06001', hq_alt_geoid: '06067', hq_same_county: 'no' })
    expect(rows[2]).toMatchObject({ hq_alt_geoid: '', hq_same_county: '' })
    expect(rows[3]).toMatchObject({ hq_alt_geoid: '', hq_same_county: '' })
    expect(report.conflicts).toEqual([
      { row: 1, key: 'FSC', geoId: '13121', altGeoId: '13121', sameCounty: true },
      { row: 2, key: 'HEAL', geoId: '06001', altGeoId: '06067', sameCounty: false },
    ])
  })

  it('the cache makes re-runs offline: duplicate inputs and second passes cost no resolver calls', async () => {
    const r = fakeResolver()
    const cache = memoryCache()
    const cached = cachedResolver(r, cache)
    const rows = [
      { name: 'a', city: 'Atlanta', st: 'GA' },
      { name: 'b', city: 'atlanta ', st: 'ga' },
    ]
    const first = await geocodeRows(rows, { city: 'city', state: 'st' }, cached, fips)
    expect(first.rows.map(x => x.GEOID)).toEqual(['13121', '13121'])
    // place lookups are keyed case/space-insensitively; county keyed by rounded coords
    expect(r.calls.filter(c => c.startsWith('place:'))).toHaveLength(1)
    expect(r.calls.filter(c => c.startsWith('county:'))).toHaveLength(1)
    const before = r.calls.length
    const again = await geocodeRows(rows, { city: 'city', state: 'st', force: true }, cachedResolver(fakeResolver(), cache), fips)
    expect(again.rows.map(x => x.GEOID)).toEqual(['13121', '13121'])
    expect(r.calls.length).toBe(before)
    // negative answers are cached too
    await cached.place('Nowhere', 'ZZ')
    await cached.place('Nowhere', 'ZZ')
    expect(r.calls.filter(c => c.includes('Nowhere'))).toHaveLength(1)
    expect(cache.size()).toBe(3)
  })
})

describe('CSV + CLI plumbing', () => {
  it('parses and re-serialises CSV with quoting, BOM, and appended columns', () => {
    const { rows, columns } = parseCsv('﻿name,notes\n"Fund, Inc.","multi\nline"\nB,plain\n')
    expect(columns).toEqual(['name', 'notes'])
    expect(rows[0].name).toBe('Fund, Inc.')
    const out = toCsv([{ ...rows[0], GEOID: '13121' }, { ...rows[1], GEOID: '' }], ['name', 'notes', 'GEOID'])
    expect(out).toBe('name,notes,GEOID\n"Fund, Inc.","multi\nline",13121\nB,plain,\n')
    expect(parseCsv(out).rows[0].GEOID).toBe('13121')
  })

  it('parses args and rejects a run with no location columns', () => {
    const ok = parseGeocodeArgs(['geocode', 'orgs.csv', '--city', 'HQ City', '--state', 'HQ State', '--address', 'HQ Street Address', '--dry-run'])
    expect('error' in ok).toBe(false)
    if (!('error' in ok)) {
      expect(ok.input.endsWith('/orgs.csv')).toBe(true)
      expect(ok.dryRun).toBe(true)
      expect(ok.options).toMatchObject({ city: 'HQ City', state: 'HQ State', address: 'HQ Street Address', force: false })
    }
    expect(parseGeocodeArgs(['geocode', 'orgs.csv'])).toMatchObject({ error: /--address/ as any })
    expect(parseGeocodeArgs(['geocode'])).toMatchObject({ error: /missing/ as any })
  })

  it('formats a report with methods, conflicts needing review, and unmatched warnings', () => {
    const text = formatReport(
      {
        rows: 3, geocoded: 2, kept: 0, resolverCalls: 4,
        methods: { 'census-address': 2 },
        unmatched: [{ row: 3, key: 'Lost', reason: 'place unresolved: X, ZZ' }],
        conflicts: [{ row: 1, key: 'HEAL', geoId: '06001', altGeoId: '06067', sameCounty: false }, { row: 2, key: 'FSC', geoId: '13121', altGeoId: '13121', sameCounty: true }],
      },
      '/tmp/out.csv',
    )
    expect(text).toContain('geocoded now: 2')
    expect(text).toContain('census-address: 2')
    expect(text).toContain('different county: 1')
    expect(text).toContain('row 1 HEAL: 06001 vs alt 06067 — review')
    expect(text).toContain('WARNING: 1 unmatched')
    expect(text).toContain('Wrote /tmp/out.csv')
  })

  it('live resolver parses Census + Nominatim shapes (fetch faked)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('onelineaddress')) return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { x: -84.42, y: 33.75 }, matchedAddress: '1040 WESTVIEW DR SW', geographies: { Counties: [{ GEOID: '13121' }] } }] } }))
      if (url.includes('/coordinates')) return new Response(JSON.stringify({ result: { geographies: { Counties: [{ GEOID: '13121' }] } } }))
      if (url.includes('nominatim')) return new Response(JSON.stringify([{ lat: '33.75', lon: '-84.39', display_name: 'Atlanta, Fulton County, Georgia' }]))
      return new Response('[]', { status: 404 })
    })
    const r = liveResolver(fetchImpl as unknown as typeof fetch)
    expect(await r.address('1040 Westview Dr SW, Atlanta, GA')).toEqual({ lat: 33.75, lng: -84.42, geoId: '13121', matched: '1040 WESTVIEW DR SW', exact: true })
    expect(await r.place('Atlanta', 'GA')).toEqual({ lat: 33.75, lng: -84.39, label: 'Atlanta, Fulton County, Georgia' })
    expect(await r.county(33.75, -84.39)).toBe('13121')
    const nominatimCall = fetchImpl.mock.calls.find(c => String(c[0]).includes('nominatim'))!
    expect((nominatimCall[1] as any).headers['User-Agent']).toMatch(/BLO-library-geocode/)
  })

  // The coordinates come straight out of a remote JSON body and are pasted
  // into the next request's URL, so a string value would let the geocoder
  // choose our query string (or our path) for us.
  it('coerces Census coordinates to numbers before they reach the next URL', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.includes('onelineaddress')) {
        return new Response(
          JSON.stringify({
            result: {
              addressMatches: [
                { coordinates: { x: '-84.42&benchmark=evil', y: '33.75' }, matchedAddress: 'X', geographies: {} },
              ],
            },
          }),
        )
      }
      return new Response(JSON.stringify({ result: { geographies: { Counties: [{ GEOID: '13121' }] } } }))
    })
    const r = liveResolver(fetchImpl as unknown as typeof fetch)
    const match = await r.address('somewhere')
    expect(match?.lat).toBe(33.75)
    expect(Number.isNaN(match!.lng)).toBe(true)

    await r.county('33.75' as unknown as number, '-84.39&x=0' as unknown as number)
    const followUp = calls.find(u => u.includes('/coordinates'))!
    expect(followUp).toContain('x=NaN')
    expect(followUp).not.toContain('&x=0')
  })

  it.skipIf(!process.env.GEOCODE_LIVE)('LIVE: Census resolves a real address to Fulton County', async () => {
    const r = liveResolver()
    const m = await r.address('1040 Westview Dr SW, Atlanta, GA')
    expect(m?.geoId).toBe('13121')
    expect(await r.county(33.75, -84.39)).toBe('13121')
  })
})
