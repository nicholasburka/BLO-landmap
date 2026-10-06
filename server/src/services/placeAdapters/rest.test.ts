import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchRest, fillTemplate, findRecords, templateValues } from './rest.js'
import { resetRateLimits } from '../placeHttp.js'
import { ATLANTA, REST_ENVELOPE, jsonResponse, publicLookup } from '../../testutils/fixtures/place/index.js'
import type { AdapterContext } from './shared.js'

/**
 * P5-57: the documented URL template. The security property worth a test each:
 * only five placeholders exist, each is filled with a number or five digits,
 * and everything else in the template is left exactly as the manifest wrote it.
 */

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    slug: 'epa-tri',
    access: { type: 'rest', url: 'https://data.epa.gov/efservice/tri_facility' },
    placeQuery: { by: ['county'], template: 'https://data.epa.gov/efservice/tri_facility/fips/{geoid}/rows/0:999/JSON' },
    place: { point: ATLANTA, geoid: '13121', radiusMiles: 5, bbox: [-84.5, 33.6, -84.2, 33.8], label: 'Fulton County, GA', key: 'g13121' },
    http: { lookup: publicLookup as any },
    ...overrides,
  }
}

beforeEach(() => resetRateLimits())

describe('the template', () => {
  it('substitutes only the five placeholders, each from a number we made', () => {
    expect(templateValues(ctx())).toEqual({
      lat: '33.749',
      lng: '-84.388',
      geoid: '13121',
      radiusMiles: '5',
      bbox: '-84.5,33.6,-84.2,33.8',
    })
  })

  it('leaves anything that is not one of the five alone', () => {
    const url = fillTemplate('https://x.test/{geoid}/{apiKey}/{lat}', ctx())
    expect(url.toString()).toBe('https://x.test/13121/%7BapiKey%7D/33.749')
  })

  it('encodes what it substitutes, so a value can never add a path or a parameter', () => {
    const url = fillTemplate('https://x.test/q?bbox={bbox}', ctx())
    expect(url.searchParams.get('bbox')).toBe('-84.5,33.6,-84.2,33.8')
    expect(url.toString()).toContain('bbox=-84.5%2C33.6')
  })

  it('says which part of the place it is missing', () => {
    const noCounty = ctx({ place: { ...ctx().place, geoid: null, point: null } })
    expect(() => fillTemplate('https://x.test/{geoid}', noCounty)).toThrowError(/geoid/)
  })

  it('refuses a source whose template does not vary by place', async () => {
    await expect(
      fetchRest(ctx({ placeQuery: { by: ['county'], template: 'https://x.test/everything.json' } })),
    ).rejects.toMatchObject({ code: 'no-endpoint' })
  })
})

describe('finding the rows', () => {
  it('takes a bare array', () => {
    expect(findRecords([{ a: 1 }, { a: 2 }])).toHaveLength(2)
  })

  it('digs the rows out of an envelope, which is what EPA answers with', () => {
    expect(findRecords(REST_ENVELOPE)?.[0]).toMatchObject({ facility_name: 'Southside Plating' })
  })

  it('returns nothing for an answer that is not a table', () => {
    expect(findRecords({ status: 'ok', count: 3 })).toBeNull()
    expect(findRecords(['a', 'b'])).toBeNull()
  })

  it('normalises what it found', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(REST_ENVELOPE))
    const result = await fetchRest(ctx({ http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }))
    expect(result.count).toBe(2)
    expect(result.columns).toEqual(['tri_facility_id', 'facility_name', 'state_county_fips_code'])
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://data.epa.gov/efservice/tri_facility/fips/13121/rows/0:999/JSON')
  })

  it('refuses an answer that is not a table of rows', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'ok' }))
    await expect(
      fetchRest(ctx({ http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } })),
    ).rejects.toMatchObject({ code: 'bad-response' })
  })
})
