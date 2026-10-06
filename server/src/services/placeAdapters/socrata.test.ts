import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchSocrata, queryUrl, soqlWhere, SOQL_LIMIT } from './socrata.js'
import { resetRateLimits } from '../placeHttp.js'
import { ATLANTA, SOCRATA_ROWS, jsonResponse, publicLookup } from '../../testutils/fixtures/place/index.js'
import type { AdapterContext } from './shared.js'

/** P5-57: SoQL. Both filters are built from numbers and validated column
 *  names — the point of the tests below is that nothing else can get in. */

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    slug: 'state-permits',
    access: { type: 'socrata', url: 'https://data.example.gov/resource/abcd-1234.json' },
    placeQuery: { by: ['point', 'county'], geoField: 'location_1', fipsField: 'fips' },
    place: {
      point: ATLANTA,
      geoid: null,
      radiusMiles: 3,
      bbox: null,
      label: 'Atlanta',
      key: 'p33.7490_-84.3880_r3',
    },
    http: { lookup: publicLookup as any },
    ...overrides,
  }
}

beforeEach(() => resetRateLimits())

describe('the SoQL clause', () => {
  it('draws a circle around a point in metres', () => {
    expect(soqlWhere(ctx())).toBe('within_circle(location_1,33.749,-84.388,4828)')
  })

  it('uses the county filter when the place is a county and not a point', () => {
    expect(soqlWhere(ctx({ place: { ...ctx().place, point: null, geoid: '13121', key: 'g13121' } }))).toBe("fips='13121'")
    // An address gives a point AND its county; the point is the question.
    expect(soqlWhere(ctx({ place: { ...ctx().place, geoid: '13121' } }))).toContain('within_circle')
  })

  it('encodes the whole clause into $where and caps $limit', () => {
    const url = queryUrl(ctx())
    expect(url.searchParams.get('$where')).toBe('within_circle(location_1,33.749,-84.388,4828)')
    expect(url.searchParams.get('$limit')).toBe(String(SOQL_LIMIT))
    // Encoded, so the parentheses and commas cannot end the parameter early.
    expect(url.toString()).toContain('%24where=within_circle%28location_1%2C33.749')
  })

  it('says what the manifest is missing rather than guessing a column', () => {
    expect(() => soqlWhere(ctx({ placeQuery: { by: ['point'] } }))).toThrowError(/geoField/)
  })

  /** P5-59: a tract-keyed table answers "rows in this county" by prefix. An
   *  equality filter on an 11-digit id matched nothing, silently. */
  describe('a sub-county key', () => {
    const county = { ...ctx().place, point: null, geoid: '13121', key: 'g13121' }

    it('matches the county code as a prefix when the manifest says so', () => {
      const where = soqlWhere(
        ctx({ place: county, placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' } }),
      )
      expect(where).toBe("starts_with(ct_fips, '13121')")
    })

    it('leaves an exact match exactly as it was', () => {
      expect(soqlWhere(ctx({ place: county, placeQuery: { by: ['county'], fipsField: 'fips' } }))).toBe("fips='13121'")
      expect(
        soqlWhere(ctx({ place: county, placeQuery: { by: ['county'], fipsField: 'fips', fipsMatch: 'exact' } })),
      ).toBe("fips='13121'")
    })

    /** P5-59, second walk: the CDC set stores `ct_fips` as a NUMBER, so its
     *  ids have no leading zero and `starts_with` can never match one. The
     *  question becomes a range: every tract in 13121 is 13121·10⁶ upward. */
    it('asks a numeric tract column for the range of ids inside the county', () => {
      const where = soqlWhere(
        ctx({
          place: county,
          geography: 'tract',
          placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix', fipsType: 'number' },
        }),
      )
      expect(where).toBe('ct_fips >= 13121000000 AND ct_fips < 13122000000')
    })

    it('widens the range by a digit for a block group', () => {
      const where = soqlWhere(
        ctx({
          place: county,
          geography: 'blockgroup',
          placeQuery: { by: ['county'], fipsField: 'bg_fips', fipsMatch: 'prefix', fipsType: 'number' },
        }),
      )
      expect(where).toBe('bg_fips >= 131210000000 AND bg_fips < 131220000000')
    })

    it('drops the quotes for a numeric county column', () => {
      const where = soqlWhere(
        ctx({ place: county, placeQuery: { by: ['county'], fipsField: 'fips', fipsType: 'number' } }),
      )
      expect(where).toBe('fips = 13121')
    })

    it('loses the leading zero exactly as the column did', () => {
      const alabama = { ...county, geoid: '01001', key: 'g01001' }
      expect(
        soqlWhere(ctx({ place: alabama, placeQuery: { by: ['county'], fipsField: 'fips', fipsType: 'number' } })),
      ).toBe('fips = 1001')
      expect(
        soqlWhere(
          ctx({
            place: alabama,
            geography: 'tract',
            placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix', fipsType: 'number' },
          }),
        ),
      ).toBe('ct_fips >= 1001000000 AND ct_fips < 1002000000')
    })

    it('refuses a place code that is not five digits before it reaches the clause', () => {
      expect(() =>
        soqlWhere(
          ctx({
            place: { ...county, geoid: "13121' OR 1=1--" },
            placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' },
          }),
        ),
      ).toThrowError(/5-digit county code/)
    })
  })
})

/**
 * The whole path the live walk broke on: what the inspection saw → the
 * proposal → the manifest parser → the clause the portal is actually sent.
 * Every step of it was individually reasonable and the answer was 0 rows.
 */
describe('the CDC well-water set, end to end', () => {
  it('turns numeric tract samples into a range query the portal can answer', async () => {
    const { proposeSource } = await import('../sourceProposal.js')
    const { parseSourceMeta } = await import('../sourceMeta.js')
    const proposal = proposeSource({
      kind: 'socrata',
      confidence: 'high',
      url: 'https://data.cdc.gov/d/fxwg-3udm',
      finalUrl: 'https://data.cdc.gov/resource/fxwg-3udm.json',
      title: 'Nationally-normed Well Water Index (WWI)',
      geometry: 'table',
      fields: [
        { name: 'geo_id', type: 'text', sample: '1400000US39017011131' },
        { name: 'state', type: 'number', sample: '6.0' },
        { name: 'county', type: 'number', sample: '3.0' },
        { name: 'tract', type: 'number', sample: '950100.0' },
        { name: 'ct_fips', type: 'number', sample: '36119002000.0' },
      ],
      checkedAt: 'x',
    })
    const { source } = parseSourceMeta(proposal.source)
    const url = queryUrl(
      ctx({
        slug: 'cdc-wwi',
        access: source!.access![0],
        placeQuery: source!.placeQuery,
        geography: source!.geography,
        place: { ...ctx().place, point: null, geoid: '13121', key: 'g13121' },
      }),
    )
    expect(url.searchParams.get('$where')).toBe('ct_fips >= 13121000000 AND ct_fips < 13122000000')
    expect(url.pathname).toBe('/resource/fxwg-3udm.json')
  })
})

describe('reading rows', () => {
  it('normalises the rows and builds points from the location column', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(SOCRATA_ROWS))
    const result = await fetchSocrata(ctx({ http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }))
    expect(result.count).toBe(2)
    expect(result.columns).toEqual(['facility_name', 'permit_number', 'fips', 'location_1'])
    // A nested value becomes its JSON rather than "[object Object]".
    expect(result.rows[0].location_1).toContain('"coordinates"')
    expect(result.geometry?.features).toHaveLength(2)
    expect(result.geometry?.features[1].geometry).toEqual({ type: 'Point', coordinates: [-84.4012, 33.7551] })
  })

  it('calls a portal error page bad-response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: true, message: 'Invalid SoQL query' }))
    await expect(
      fetchSocrata(ctx({ http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } })),
    ).rejects.toMatchObject({ code: 'bad-response' })
  })
})
