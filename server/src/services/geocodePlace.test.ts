import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  censusAddressUrl,
  censusCountyUrl,
  countyForPoint,
  geocodeAddress,
  liveResolver,
  nominatimUrl,
  parseCensusAddress,
  parseCensusCounty,
  parseNominatim,
  parseNominatimReverse,
  nominatimReverseUrl,
  reverseGeocode,
  validGeoid,
  validPoint,
} from './geocodePlace.js'
import { resetRateLimits } from './placeHttp.js'
import { jsonResponse, publicLookup } from '../testutils/fixtures/place/index.js'

/**
 * P5-23's geocoder, now a service (P5-57). The CLI's own suite still covers
 * `liveResolver` end to end; these cover the pieces the request path added —
 * the guarded entry points and the two validators that stand between a typed
 * place and a URL we build.
 */

const http = (fetchImpl: any) => ({ fetchImpl, lookup: publicLookup as any })

beforeEach(() => resetRateLimits())

describe('the URLs', () => {
  it('encodes the address and pins the Census benchmark', () => {
    const url = censusAddressUrl('1040 Westview Dr SW, Atlanta, GA')
    expect(url).toContain('address=1040%20Westview%20Dr%20SW%2C%20Atlanta%2C%20GA')
    expect(url).toContain('benchmark=Public_AR_Current')
    expect(url.startsWith('https://geocoding.geo.census.gov/')).toBe(true)
  })

  it('coerces coordinates to numbers before they reach a URL', () => {
    // The pair comes out of a remote JSON body; a string could otherwise carry
    // a query separator (or a path) into the next request.
    const url = censusCountyUrl('33.75' as unknown as number, '-84.39&x=0' as unknown as number)
    expect(url).toContain('x=NaN')
    expect(url).not.toContain('&x=0&')
  })

  it('asks Nominatim for one US match', () => {
    expect(nominatimUrl('Atlanta, GA')).toBe(
      'https://nominatim.openstreetmap.org/search?q=Atlanta%2C%20GA&format=jsonv2&limit=1&countrycodes=us',
    )
  })
})

describe('the parsers', () => {
  it('reads a Census match, a county, and a Nominatim hit', () => {
    expect(
      parseCensusAddress({
        result: { addressMatches: [{ coordinates: { x: -84.42, y: 33.75 }, matchedAddress: 'X', geographies: { Counties: [{ GEOID: '13121' }] } }] },
      }),
    ).toEqual({ lat: 33.75, lng: -84.42, geoId: '13121', matched: 'X', exact: true })
    expect(parseCensusAddress({ result: { addressMatches: [] } })).toBeNull()
    expect(parseCensusCounty({ result: { geographies: { Counties: [{ GEOID: '13121' }] } } })).toBe('13121')
    expect(parseCensusCounty({})).toBeNull()
    expect(parseNominatim([{ lat: '33.75', lon: '-84.39', display_name: 'Atlanta' }])).toEqual({
      lat: 33.75,
      lng: -84.39,
      label: 'Atlanta',
    })
    expect(parseNominatim([])).toBeNull()
  })
})

describe('geocodeAddress, under the guard', () => {
  it('takes the Census answer and its county in one call', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      return jsonResponse({
        result: { addressMatches: [{ coordinates: { x: -84.42, y: 33.75 }, matchedAddress: '1040 WESTVIEW DR SW', geographies: { Counties: [{ GEOID: '13121' }] } }] },
      })
    })
    expect(await geocodeAddress('1040 Westview Dr SW, Atlanta, GA', http(fetchImpl))).toEqual({
      lat: 33.75,
      lng: -84.42,
      geoid: '13121',
      matched: '1040 WESTVIEW DR SW',
      method: 'census-address',
    })
    // The county came with the match, so there was no second request.
    expect(calls).toHaveLength(1)
  })

  it('falls back to Nominatim, then asks the Census for the county', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('onelineaddress')) return jsonResponse({ result: { addressMatches: [] } })
      if (url.includes('nominatim')) return jsonResponse([{ lat: '33.75', lon: '-84.39', display_name: 'Atlanta, GA' }])
      return jsonResponse({ result: { geographies: { Counties: [{ GEOID: '13121' }] } } })
    })
    expect(await geocodeAddress('Atlanta', http(fetchImpl))).toEqual({
      lat: 33.75,
      lng: -84.39,
      geoid: '13121',
      matched: 'Atlanta, GA',
      method: 'nominatim-place',
    })
    expect(String(fetchImpl.mock.calls[1][1]?.headers?.['User-Agent'])).toMatch(/BLO-library-geocode/)
  })

  it('returns null when neither geocoder knows the place, and for an empty string', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('nominatim') ? jsonResponse([]) : jsonResponse({ result: { addressMatches: [] } }),
    )
    expect(await geocodeAddress('nowhere at all', http(fetchImpl))).toBeNull()
    expect(await geocodeAddress('   ', http(fetchImpl))).toBeNull()
  })

  it('refuses a geocoder host that is not public', async () => {
    const fetchImpl = vi.fn()
    await expect(
      geocodeAddress('Atlanta', { fetchImpl: fetchImpl as any, lookup: async () => [{ address: '127.0.0.1', family: 4 }] }),
    ).rejects.toMatchObject({ code: 'not-public' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads a county straight from a point', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { geographies: { Counties: [{ GEOID: '47157' }] } } }))
    expect(await countyForPoint(35.1, -90.0, http(fetchImpl))).toBe('47157')
  })
})

describe('what may become part of a URL', () => {
  it('takes only a real point on the earth', () => {
    expect(validPoint(33.749, -84.388)).toEqual({ lat: 33.749, lng: -84.388 })
    expect(validPoint('33.749', '-84.388')).toEqual({ lat: 33.749, lng: -84.388 })
    for (const bad of [
      [999, 0],
      [0, 999],
      ['abc', 0],
      [null, null],
      [Infinity, 0],
    ] as const) {
      expect(validPoint(bad[0], bad[1]), String(bad)).toBeNull()
    }
  })

  it('takes only five digits for a county', () => {
    expect(validGeoid('13121')).toBe('13121')
    expect(validGeoid(' 13121 ')).toBe('13121')
    for (const bad of ["13121' OR 1=1", '1312', '131211', 'abcde', '', null, {}]) {
      expect(validGeoid(bad), String(bad)).toBeNull()
    }
  })
})

describe('the CLI still gets its own resolver', () => {
  it('speaks to whatever fetch it is handed, unguarded, as the CLI needs', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: { geographies: { Counties: [{ GEOID: '13121' }] } } })))
    expect(await liveResolver(fetchImpl as unknown as typeof fetch).county(33.75, -84.39)).toBe('13121')
  })
})

describe('reverse lookup (P6-15)', () => {
  it('asks for the area, not the doorstep, and never pastes raw values into the URL', () => {
    const url = nominatimReverseUrl(40.7785, -73.9572)
    expect(url).toContain('lat=40.7785')
    expect(url).toContain('lon=-73.9572')
    expect(url).toContain('zoom=10')
    expect(nominatimReverseUrl('40.7&evil=1' as any, 0)).not.toContain('evil')
  })

  it('reads words a person would use out of the structured address', () => {
    expect(
      parseNominatimReverse({
        address: { neighbourhood: 'Upper East Side', county: 'New York County', state: 'New York', postcode: '10065' },
        display_name: 'Upper East Side, Manhattan, New York County, City of New York, New York, 10065, United States',
      }),
    ).toBe('Upper East Side, New York County, New York')
  })

  it('falls back through the locality names, and never repeats one', () => {
    expect(parseNominatimReverse({ address: { town: 'Eatonton', county: 'Putnam County', state: 'Georgia' } })).toBe(
      'Eatonton, Putnam County, Georgia',
    )
    expect(parseNominatimReverse({ address: { city: 'Georgia', county: 'Georgia', state: 'Georgia' } })).toBe('Georgia')
  })

  it('uses the display name when there is no structure, and null when there is nothing', () => {
    expect(parseNominatimReverse({ display_name: 'Somewhere, USA' })).toBe('Somewhere, USA')
    expect(parseNominatimReverse({ address: {}, display_name: '  ' })).toBeNull()
    expect(parseNominatimReverse(null)).toBeNull()
    expect(parseNominatimReverse({})).toBeNull()
  })

  it('returns the name through the guard', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ address: { city: 'Memphis', county: 'Shelby County', state: 'Tennessee' } }))
    await expect(reverseGeocode(35.1495, -90.049, http(fetchImpl) as any)).resolves.toBe('Memphis, Shelby County, Tennessee')
  })
})
