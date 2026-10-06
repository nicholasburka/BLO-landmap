import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'http://api.test',
}))

import { internalFetch } from '../apiBase'
import {
  csvFilename,
  defaultRadius,
  fetchForPlace,
  fetchSlices,
  placeLabel,
  PLACE_ERROR_FALLBACK,
  promoteSlice,
  sortRows,
  toCsv,
} from '../placeFetch'

/** P5-57: the browser half of "fetch this source for a place". */

const mockedFetch = vi.mocked(internalFetch)

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}
function bad(status: number, body?: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json')
      return body
    },
  } as unknown as Response
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe('the API calls', () => {
  it('posts the place and returns the slice', async () => {
    mockedFetch.mockResolvedValue(ok({ rows: [{ a: '1' }], columns: ['a'], count: 1, cacheKey: 'g13121' }))
    const result = await fetchForPlace('epa npl', { geoid: '13121', radiusMiles: 5 })
    expect(result.cacheKey).toBe('g13121')
    const [path, init] = mockedFetch.mock.calls[0]
    // The slug is encoded — it reaches the URL, and it is not ours to trust.
    expect(path).toBe('/api/library/sources/epa%20npl/fetch')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ geoid: '13121', radiusMiles: 5 })
  })

  it('lists the slices, and promotes one', async () => {
    mockedFetch.mockResolvedValue(ok({ slices: [{ cacheKey: 'g13121', count: 3 }] }))
    expect(await fetchSlices('epa-npl')).toEqual([{ cacheKey: 'g13121', count: 3 }])

    mockedFetch.mockResolvedValue(ok({ slug: 'new-uuid', rows: 3 }))
    expect(await promoteSlice('epa-npl', 'g13121', 'NPL near the farm')).toEqual({ slug: 'new-uuid', rows: 3 })
    expect(JSON.parse(String(mockedFetch.mock.calls[1][1]?.body))).toEqual({ cacheKey: 'g13121', title: 'NPL near the farm' })
  })

  it('hands the server’s own sentence to the reader', async () => {
    mockedFetch.mockResolvedValue(bad(400, { error: 'this source is spreadsheets only — open it by hand.', code: 'manual-only' }))
    await expect(fetchForPlace('georgia-epd-ust', { geoid: '13121' })).rejects.toThrow(/spreadsheets only/)
  })

  it('has words of its own for the failures the server cannot describe', async () => {
    mockedFetch.mockResolvedValue(bad(401))
    await expect(fetchForPlace('x', { geoid: '13121' })).rejects.toThrow(/session expired/)
    mockedFetch.mockResolvedValue(bad(429))
    await expect(fetchForPlace('x', { geoid: '13121' })).rejects.toThrow(/lot of questions/)
    mockedFetch.mockResolvedValue(bad(503))
    await expect(fetchForPlace('x', { geoid: '13121' })).rejects.toThrow(/not available/)
    mockedFetch.mockResolvedValue(bad(502))
    await expect(fetchForPlace('x', { geoid: '13121' })).rejects.toThrow(PLACE_ERROR_FALLBACK)
  })
})

describe('sorting the rows in the browser', () => {
  const rows = [
    { site: 'Beta', score: '9' },
    { site: 'alpha', score: '10' },
    { site: 'Gamma', score: '' },
  ]

  it('sorts a numeric column as numbers, not as text', () => {
    expect(sortRows(rows, 'score', 'asc').map(r => r.score)).toEqual(['9', '10', ''])
    expect(sortRows(rows, 'score', 'desc').map(r => r.score)).toEqual(['10', '9', ''])
  })

  it('sorts text case-insensitively and keeps blanks at the bottom either way', () => {
    expect(sortRows(rows, 'site', 'asc').map(r => r.site)).toEqual(['alpha', 'Beta', 'Gamma'])
    const withBlank = [...rows, { site: '', score: '1' }]
    expect(sortRows(withBlank, 'site', 'desc').map(r => r.site)).toEqual(['Gamma', 'Beta', 'alpha', ''])
  })

  it('does not mutate what it was given', () => {
    const original = [...rows]
    sortRows(rows, 'site', 'desc')
    expect(rows).toEqual(original)
  })
})

describe('the CSV', () => {
  it('quotes the fields that would otherwise break a row', () => {
    const csv = toCsv(['name', 'note'], [
      { name: 'Lakewood, GA', note: 'said "final"' },
      { name: 'Two\nlines', note: '' },
    ])
    expect(csv).toBe('name,note\n"Lakewood, GA","said ""final"""\n"Two\nlines",\n')
  })

  it('names the file after the source and the place', () => {
    expect(csvFilename('epa-superfund-npl', 'p33.7490_-84.3880_r5')).toBe('epa-superfund-npl-p33.7490_-84.3880_r5.csv')
    expect(csvFilename('a/b', 'g13121')).toBe('a-b-g13121.csv')
  })
})

describe('saying where', () => {
  it('prefers the label, then the county, then the coordinates', () => {
    expect(placeLabel({ label: 'Fulton County, GA', lat: null, lng: null, geoid: '13121', radiusMiles: 5 })).toBe('Fulton County, GA')
    expect(placeLabel({ label: '', lat: null, lng: null, geoid: '13121', radiusMiles: 5 })).toBe('County 13121')
    expect(placeLabel({ label: '', lat: 33.749, lng: -84.388, geoid: null, radiusMiles: 5 })).toBe('33.7490, -84.3880')
    expect(placeLabel(null)).toBe('this place')
  })

  it('takes the radius the source recommends, else five miles', () => {
    expect(defaultRadius(0.25)).toBe(0.25)
    expect(defaultRadius(undefined)).toBe(5)
    expect(defaultRadius(0)).toBe(5)
  })
})
