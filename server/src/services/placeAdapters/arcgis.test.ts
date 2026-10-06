import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchArcgis, layerUrl, PAGE_CAP, PAGE_SIZE, queryUrl, readPage } from './arcgis.js'
import { resetRateLimits } from '../placeHttp.js'
import { ARCGIS_ERROR, ARCGIS_ESRI_JSON, ARCGIS_GEOJSON, ATLANTA, jsonResponse, publicLookup } from '../../testutils/fixtures/place/index.js'
import type { AdapterContext } from './shared.js'

/** P5-57: the adapter behind 23 of the 40 seed sources. */

const POINT = {
  point: ATLANTA,
  geoid: null,
  radiusMiles: 5,
  bbox: [-84.475, 33.677, -84.301, 33.821] as [number, number, number, number],
  label: 'Atlanta',
  key: 'p33.7490_-84.3880_r5',
}
const COUNTY = { ...POINT, point: null, geoid: '13121', bbox: null, key: 'g13121' }

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    slug: 'epa-superfund-npl',
    access: { type: 'arcgis', url: 'https://services.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0' },
    place: POINT,
    http: { lookup: publicLookup as any },
    ...overrides,
  }
}

beforeEach(() => resetRateLimits())

describe('the URL', () => {
  it('buffers a point in metres, asks for GeoJSON, and pages', () => {
    const url = queryUrl(ctx(), PAGE_SIZE)
    expect(url.pathname.endsWith('/FeatureServer/0/query')).toBe(true)
    const p = url.searchParams
    expect(p.get('geometry')).toBe('-84.388,33.749')
    expect(p.get('geometryType')).toBe('esriGeometryPoint')
    expect(p.get('inSR')).toBe('4326')
    // 5 statute miles, as metres — the unit every layer agrees on.
    expect(p.get('distance')).toBe('8047')
    expect(p.get('units')).toBe('esriSRUnit_Meter')
    expect(p.get('outFields')).toBe('*')
    expect(p.get('f')).toBe('geojson')
    expect(p.get('where')).toBe('1=1')
    expect(p.get('resultOffset')).toBe(String(PAGE_SIZE))
    expect(p.get('resultRecordCount')).toBe(String(PAGE_SIZE))
  })

  it('filters by the FIPS column when the place is a county and the manifest names one', () => {
    const url = queryUrl(ctx({ place: COUNTY, placeQuery: { by: ['county'], fipsField: 'STCOFIPS' } }), 0)
    expect(url.searchParams.get('where')).toBe("STCOFIPS='13121'")
    expect(url.searchParams.get('geometry')).toBeNull()
  })

  it('matches a tract-keyed layer by the county prefix when the manifest says so', () => {
    // P5-59: `13121` is a county and `13121010101` a tract inside it, so LIKE
    // with a trailing % is the only clause that answers the question.
    const url = queryUrl(
      ctx({ place: COUNTY, placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' } }),
      0,
    )
    expect(url.searchParams.get('where')).toBe("ct_fips LIKE '13121%'")
  })

  it('asks a numeric sub-county layer for a range, which is the only clause that can match', () => {
    // P5-59: a number column has no leading zero, so LIKE cannot work on it.
    const url = queryUrl(
      ctx({
        place: COUNTY,
        geography: 'tract',
        placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix', fipsType: 'number' },
      }),
      0,
    )
    expect(url.searchParams.get('where')).toBe('ct_fips >= 13121000000 AND ct_fips < 13122000000')
  })

  it('drops the quotes for a numeric county column', () => {
    const url = queryUrl(ctx({ place: COUNTY, placeQuery: { by: ['county'], fipsField: 'fips', fipsType: 'number' } }), 0)
    expect(url.searchParams.get('where')).toBe('fips=13121')
  })

  it('refuses a place code that is not five digits rather than pasting it in', () => {
    expect(() =>
      queryUrl(
        ctx({
          place: { ...COUNTY, geoid: "13121%' OR 1=1--" },
          placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' },
        }),
        0,
      ),
    ).toThrowError(/5-digit county code/)
  })

  it('asks about the point, not its county, when it has both', () => {
    // Geocoding an address gives a county as well; filtering by that county
    // would answer about somewhere thirty miles away.
    const url = queryUrl(ctx({ place: { ...POINT, geoid: '13121' }, placeQuery: { by: ['county'], fipsField: 'STCOFIPS' } }), 0)
    expect(url.searchParams.get('where')).toBe('1=1')
    expect(url.searchParams.get('geometry')).toBe('-84.388,33.749')
  })

  it('reads the FIPS column out of the researcher’s note when placeQuery is silent', () => {
    const access = {
      type: 'arcgis' as const,
      url: 'https://services.arcgis.com/x/arcgis/rest/services/NRI/FeatureServer/0',
      notes: "Query by point intersect, or by county FIPS: ?where=STCOFIPS=%2713089%27&outFields=*&f=json",
    }
    expect(queryUrl(ctx({ access, place: COUNTY }), 0).searchParams.get('where')).toBe("STCOFIPS='13121'")
  })

  it('does not take a field name out of prose unless it names a FIPS column', () => {
    const access = { type: 'arcgis' as const, url: 'https://x.test/FeatureServer/0', notes: '?where=SITE_NAME=%27x%27' }
    // No usable county filter, so a county-only place has nothing to ask with.
    expect(() => queryUrl(ctx({ access, place: COUNTY }), 0)).toThrowError(/point/)
  })

  it('adds layer 0 to a FeatureServer that was given without one', () => {
    expect(layerUrl(new URL('https://x.test/rest/services/A/FeatureServer')).pathname).toBe('/rest/services/A/FeatureServer/0')
    expect(layerUrl(new URL('https://x.test/rest/services/A/MapServer/28')).pathname).toBe('/rest/services/A/MapServer/28')
  })

  it('encodes everything it substitutes, and nothing free-text ever reaches it', () => {
    // The place is numbers by the time it arrives; a slug is never in the URL.
    const url = queryUrl(ctx({ place: { ...POINT, point: { lat: 33.7, lng: -84.4 } } }), 0)
    expect(url.toString()).toContain('geometry=-84.4%2C33.7')
    expect(url.toString()).not.toContain(' ')
  })
})

describe('reading an answer', () => {
  it('reads GeoJSON properties and keeps the shapes for the map', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ARCGIS_GEOJSON))
    const result = await fetchArcgis(ctx({ http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }))
    expect(result.count).toBe(3)
    expect(result.columns).toEqual(['Site_Name', 'Site_EPA_ID', 'Status', 'Site_Score'])
    expect(result.rows[0]).toEqual({ Site_Name: 'Lakewood Landfill', Site_EPA_ID: 'GAD000000001', Status: 'Final', Site_Score: '51.9' })
    // The third site has no coordinates; it stays a row but not a dot.
    expect(result.geometry?.features).toHaveLength(2)
    expect(result.geometry?.features[0].geometry).toEqual({ type: 'Point', coordinates: [-84.39, 33.75] })
    expect(result.truncated).toBe(false)
  })

  it('reads Esri JSON too, because MapServer layers ignore f=geojson', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ARCGIS_ESRI_JSON))
    const result = await fetchArcgis(ctx({ slug: 'fema-nfhl', http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }))
    expect(result.columns).toEqual(['FLD_ZONE', 'SFHA_TF', 'STATIC_BFE'])
    expect(result.rows[0].FLD_ZONE).toBe('AE')
    expect(result.geometry?.features[0].geometry).toEqual({ type: 'Point', coordinates: [-84.39, 33.75] })
  })

  it('turns the layer’s own error into a refusal, not a crash', () => {
    expect(() => readPage(ARCGIS_ERROR)).toThrowError(/Invalid field/)
  })

  it('stops after the page cap and says the answer was cut short', async () => {
    const page = {
      type: 'FeatureCollection',
      features: Array.from({ length: PAGE_SIZE }, (_, i) => ({ properties: { id: i }, geometry: null })),
    }
    const fetchImpl = vi.fn(async () => jsonResponse(page))
    const result = await fetchArcgis(ctx({ slug: 'big-layer', http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }))
    expect(fetchImpl).toHaveBeenCalledTimes(PAGE_CAP)
    expect(result.truncated).toBe(true)
    // ROWS_MAX rows kept, no more — a slice is an answer, not a replica.
    expect(result.rows).toHaveLength(5_000)
  })

  it('refuses a host that is not public before it asks anything', async () => {
    const fetchImpl = vi.fn()
    await expect(
      fetchArcgis(ctx({ slug: 'inside', http: { fetchImpl: fetchImpl as any, lookup: async () => [{ address: '10.0.0.5', family: 4 }] } })),
    ).rejects.toMatchObject({ code: 'not-public' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
