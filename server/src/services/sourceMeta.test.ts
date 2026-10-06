import { describe, it, expect } from 'vitest'
import {
  fipsMatchOf,
  fipsTypeOf,
  parseSourceMeta,
  sourceDropWarning,
  SOURCE_ACCESS_MAX,
  SOURCE_FIELDS_MAX,
  SOURCE_LIST_MAX,
  SOURCE_SLICES_MAX,
  SOURCE_TOPICS_MAX,
  SOURCE_STRING_MAX,
} from './sourceMeta.js'

/** P5-56: the `source` block is hand-written, so every rule here exists to
 *  keep one typo from costing the whole entry. */

const FULL = {
  provider: 'US EPA',
  program: 'Superfund / CERCLIS',
  homepage: 'https://www.epa.gov/superfund/search-superfund-sites-where-you-live',
  geography: 'point',
  coverage: 'national',
  granularity: ['point', 'county'],
  topics: ['contamination', 'hazardous waste'],
  fields: [
    { name: 'SITE_NAME', description: 'Site name' },
    { name: 'NPL_STATUS', description: 'Proposed, final, deleted' },
  ],
  access: [
    { type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0', docs: 'https://epa.gov/docs', auth: 'none', notes: 'query by envelope' },
    { type: 'download', url: 'https://epa.gov/npl.csv', format: 'csv' },
  ],
  placeQuery: { by: ['point', 'county'], radiusMiles: 5 },
  license: 'public domain',
  updateCadence: 'monthly',
  lastChecked: '2026-09-05',
  relevance: 'Any NPL site within a few miles of a candidate parcel is a red flag.',
  replication: { status: 'indexed' },
}

describe('parseSourceMeta — the shape from the ticket', () => {
  it('keeps a complete, valid block verbatim and drops nothing', () => {
    const { source, dropped } = parseSourceMeta(FULL)
    expect(dropped).toEqual([])
    expect(source).toEqual(FULL)
  })

  it('says nothing about a missing block, and refuses a non-object one', () => {
    expect(parseSourceMeta(undefined)).toEqual({ source: null, dropped: [] })
    expect(parseSourceMeta(null)).toEqual({ source: null, dropped: [] })
    // Datasets carry a plain-string `source` ("DC Open Data, 2024") — that is
    // not this block, and the caller must not mistake one for the other.
    expect(parseSourceMeta('DC Open Data, 2024')).toEqual({
      source: null,
      dropped: ['source (expected an object)'],
    })
    expect(parseSourceMeta([{ provider: 'EPA' }]).source).toBeNull()
  })

  it('requires provider — everything else is optional', () => {
    expect(parseSourceMeta({ geography: 'county', topics: ['flood'] })).toEqual({
      source: null,
      dropped: ['source (provider is required)'],
    })
    expect(parseSourceMeta({ provider: '   ' }).source).toBeNull()
    expect(parseSourceMeta({ provider: 'FEMA' })).toEqual({ source: { provider: 'FEMA' }, dropped: [] })
  })
})

describe('parseSourceMeta — enums', () => {
  it('drops a bad geography and keeps the rest of the block', () => {
    const { source, dropped } = parseSourceMeta({ provider: 'FEMA', geography: 'zipcode', coverage: 'national' })
    expect(source).toEqual({ provider: 'FEMA', coverage: 'national' })
    expect(dropped).toEqual(['geography "zipcode"'])
  })

  /** P5-59: a table keyed below the county needs a prefix match, and the
   *  manifest has to be able to say so — silently in the block, and out loud
   *  through `fipsMatchOf` for every adapter that reads it. */
  it('keeps placeQuery.fipsMatch, defaults it to exact, and refuses anything else', () => {
    const prefix = parseSourceMeta({
      provider: 'CDC',
      geography: 'tract',
      placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' },
    })
    expect(prefix.dropped).toEqual([])
    expect(prefix.source?.placeQuery).toEqual({ by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' })
    expect(fipsMatchOf(prefix.source?.placeQuery)).toBe('prefix')

    // A block written before P5-59 means what it always meant.
    const old = parseSourceMeta({ provider: 'EPA', placeQuery: { by: ['county'], fipsField: 'STCOFIPS' } })
    expect(old.source?.placeQuery?.fipsMatch).toBeUndefined()
    expect(fipsMatchOf(old.source?.placeQuery)).toBe('exact')
    expect(fipsMatchOf(undefined)).toBe('exact')

    const bad = parseSourceMeta({ provider: 'EPA', placeQuery: { fipsField: 'f', fipsMatch: 'startswith' } })
    expect(bad.dropped).toEqual(['placeQuery.fipsMatch "startswith"'])
    expect(bad.source?.placeQuery).toEqual({ fipsField: 'f' })
  })

  it('keeps placeQuery.fipsType, defaults it to text, and refuses anything else', () => {
    const numeric = parseSourceMeta({
      provider: 'CDC',
      geography: 'tract',
      placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix', fipsType: 'number' },
    })
    expect(numeric.dropped).toEqual([])
    expect(fipsTypeOf(numeric.source?.placeQuery)).toBe('number')

    const old = parseSourceMeta({ provider: 'EPA', placeQuery: { by: ['county'], fipsField: 'STCOFIPS' } })
    expect(old.source?.placeQuery?.fipsType).toBeUndefined()
    expect(fipsTypeOf(old.source?.placeQuery)).toBe('text')
    expect(fipsTypeOf(undefined)).toBe('text')

    const bad = parseSourceMeta({ provider: 'EPA', placeQuery: { fipsField: 'f', fipsType: 'integer' } })
    expect(bad.dropped).toEqual(['placeQuery.fipsType "integer"'])
    expect(bad.source?.placeQuery).toEqual({ fipsField: 'f' })
  })

  it('accepts a block-group geography, which sub-county keys need', () => {
    expect(parseSourceMeta({ provider: 'X', geography: 'blockgroup' }).source?.geography).toBe('blockgroup')
  })

  it('accepts every geography in the ticket, case-insensitively', () => {
    for (const g of ['point', 'parcel', 'tract', 'county', 'state', 'national']) {
      expect(parseSourceMeta({ provider: 'X', geography: g }).source?.geography).toBe(g)
    }
    expect(parseSourceMeta({ provider: 'X', geography: 'County' }).source?.geography).toBe('county')
  })

  it('drops an access method with an unknown or missing type, keeping the good ones', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'EPA',
      access: [
        { type: 'graphql', url: 'https://x.org/gql' },
        { type: 'socrata', url: 'https://data.x.gov/resource/abc.json' },
        { url: 'https://x.org/nope' },
      ],
    })
    expect(source?.access).toEqual([{ type: 'socrata', url: 'https://data.x.gov/resource/abc.json' }])
    expect(dropped).toEqual(['access[0].type "graphql"', 'access[2] (no type)'])
  })

  it('accepts every access type in the ticket', () => {
    for (const t of ['arcgis', 'socrata', 'rest', 'download', 'wfs', 'manual']) {
      expect(parseSourceMeta({ provider: 'X', access: [{ type: t }] }).source?.access).toEqual([{ type: t }])
    }
  })

  it('drops a bad replication status (the block then means nothing) and keeps a good one with its slices', () => {
    const bad = parseSourceMeta({ provider: 'X', replication: { status: 'cached' } })
    expect(bad.source?.replication).toBeUndefined()
    expect(bad.dropped).toEqual(['replication.status "cached"'])

    const good = parseSourceMeta({
      provider: 'X',
      replication: { status: 'partial', slices: ['shelby-npl-2026', 'shelby-npl-2026'] },
    })
    expect(good.source?.replication).toEqual({ status: 'partial', slices: ['shelby-npl-2026'] })
    expect(good.dropped).toEqual([])

    expect(parseSourceMeta({ provider: 'X', replication: { status: 'replicated', dataset: 'npl-sites' } }).source?.replication)
      .toEqual({ status: 'replicated', dataset: 'npl-sites' })
  })
})

describe('parseSourceMeta — URLs', () => {
  it('drops http (and junk) URLs with a warning, keeping https ones', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'EPA',
      homepage: 'http://epa.gov/superfund',
      access: [
        { type: 'rest', url: 'http://api.epa.gov/v1', docs: 'https://epa.gov/docs' },
        { type: 'download', url: 'not a url' },
      ],
    })
    expect(source?.homepage).toBeUndefined()
    expect(source?.access).toEqual([{ type: 'rest', docs: 'https://epa.gov/docs' }, { type: 'download' }])
    expect(dropped).toEqual(['homepage (not https)', 'access[0].url (not https)', 'access[1].url (not https)'])
  })
})

describe('parseSourceMeta — caps', () => {
  it('caps fields at 40, access at 8 and topics at 20, reporting each cap once', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'X',
      fields: Array.from({ length: 45 }, (_, i) => ({ name: `F${i}` })),
      access: Array.from({ length: 10 }, () => ({ type: 'manual' })),
      topics: Array.from({ length: 25 }, (_, i) => `topic-${i}`),
    })
    expect(source?.fields).toHaveLength(SOURCE_FIELDS_MAX)
    expect(source?.access).toHaveLength(SOURCE_ACCESS_MAX)
    expect(source?.topics).toHaveLength(SOURCE_TOPICS_MAX)
    expect(dropped).toEqual([
      'topics (kept 20 of 25)',
      'fields (kept 40 of 45)',
      'access (kept 8 of 10)',
    ])
  })

  it('caps the short lists and the length of any single string', () => {
    const { source } = parseSourceMeta({
      provider: 'X',
      granularity: Array.from({ length: 12 }, (_, i) => `g${i}`),
      relevance: 'a'.repeat(SOURCE_STRING_MAX + 500),
    })
    expect(source?.granularity).toHaveLength(SOURCE_LIST_MAX)
    expect(source?.relevance).toHaveLength(SOURCE_STRING_MAX)
  })

  it('drops nameless or non-object field rows', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'X',
      fields: [{ description: 'no name here' }, 'SITE_NAME', { name: 'OK' }],
    })
    expect(source?.fields).toEqual([{ name: 'OK' }])
    expect(dropped).toEqual(['fields[0] (no name)', 'fields[1] (expected an object)'])
  })
})

describe('parseSourceMeta — unknown keys and odd types', () => {
  it('drops unknown keys at every level, naming them', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'X',
      cost: '$$$',
      access: [{ type: 'manual', phone: '555-1234' }],
      fields: [{ name: 'A', unit: 'ft' }],
      replication: { status: 'indexed', copiedAt: 'yesterday' },
      placeQuery: { by: ['county'], bbox: [1, 2, 3, 4] },
    })
    expect(source).toEqual({
      provider: 'X',
      access: [{ type: 'manual' }],
      fields: [{ name: 'A' }],
      replication: { status: 'indexed' },
      placeQuery: { by: ['county'] },
    })
    expect(dropped).toEqual([
      'unknown key "cost"',
      'unknown key "fields[0].unit"',
      'unknown key "access[0].phone"',
      'unknown key "placeQuery.bbox"',
      'unknown key "replication.copiedAt"',
    ])
  })

  it('drops lists and objects given as the wrong type, and a non-positive radius', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'X',
      topics: 'flooding',
      fields: 'lots',
      access: 'download',
      placeQuery: 'by county',
      replication: 'indexed',
    })
    expect(source).toEqual({ provider: 'X' })
    expect(dropped).toEqual([
      'topics (expected a list)',
      'fields (expected a list)',
      'access (expected a list)',
      'placeQuery (expected an object)',
      'replication (expected an object)',
    ])
    expect(parseSourceMeta({ provider: 'X', placeQuery: { radiusMiles: -2 } }).dropped).toEqual([
      'placeQuery.radiusMiles (expected a positive number)',
    ])
  })
})

describe('sourceDropWarning', () => {
  it('is one plain line naming the entry and everything dropped', () => {
    expect(sourceDropWarning('epa-npl', ['geography "zipcode"', 'homepage (not https)'])).toBe(
      '[library] source block for "epa-npl": dropped geography "zipcode", homepage (not https) — the entry is indexed without them; fix the manifest and reindex.',
    )
  })
})

describe('notes (P5-56 seed content)', () => {
  it('keeps a top-level notes caveat and does not report it as unknown', () => {
    const { source, dropped } = parseSourceMeta({ provider: 'FEMA', notes: 'No feature means no digital FIRM, not safe.' })
    expect(source?.notes).toBe('No feature means no digital FIRM, not safe.')
    expect(dropped).toEqual([])
  })
})

// --- P5-57 --------------------------------------------------------------

describe('placeQuery for the fetchers (P5-57)', () => {
  it('keeps the column names and the template an adapter needs', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'FEMA',
      placeQuery: {
        by: ['county'],
        radiusMiles: 5,
        fipsField: 'STCOFIPS',
        geoField: 'location_1',
        template: 'https://data.epa.gov/efservice/tri/fips/{geoid}/JSON',
      },
    })
    expect(source?.placeQuery).toEqual({
      by: ['county'],
      radiusMiles: 5,
      fipsField: 'STCOFIPS',
      geoField: 'location_1',
      template: 'https://data.epa.gov/efservice/tri/fips/{geoid}/JSON',
    })
    expect(dropped).toEqual([])
  })

  it('refuses a column name that could close our WHERE clause and write its own', () => {
    // The manifest is hand-typed; these names are pasted into a query we build.
    for (const bad of ["FIPS' OR '1'='1", 'within_circle(x', 'a b', '1st_field', '']) {
      const { source, dropped } = parseSourceMeta({ provider: 'X', placeQuery: { by: ['county'], fipsField: bad } })
      expect(source?.placeQuery?.fipsField, bad).toBeUndefined()
      if (bad) expect(dropped, bad).toEqual([`placeQuery.fipsField "${bad}" (not a plain column name)`])
    }
  })

  it('refuses an http template — the fetcher would follow it in plaintext', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'X',
      placeQuery: { by: ['point'], template: 'http://example.com/{lat}/{lng}' },
    })
    expect(source?.placeQuery).toEqual({ by: ['point'] })
    expect(dropped).toEqual(['placeQuery.template (not https)'])
  })

  it('keeps a placeQuery that is nothing but a template', () => {
    expect(parseSourceMeta({ provider: 'X', placeQuery: { template: 'https://x.test/{geoid}' } }).source?.placeQuery)
      .toEqual({ template: 'https://x.test/{geoid}' })
  })
})

describe('replication.slices (P5-57)', () => {
  it('keeps place slices whole, and still accepts the plain slugs P5-56 wrote', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'EPA',
      replication: {
        status: 'partial',
        slices: [
          { cacheKey: 'g13089', place: 'DeKalb County, GA', count: 4, fetchedAt: '2026-09-06T00:00:00.000Z', adapter: 'arcgis' },
          'npl-shelby-2026',
        ],
      },
    })
    expect(source?.replication).toEqual({
      status: 'partial',
      slices: [
        { cacheKey: 'g13089', place: 'DeKalb County, GA', count: 4, fetchedAt: '2026-09-06T00:00:00.000Z', adapter: 'arcgis' },
        'npl-shelby-2026',
      ],
    })
    expect(dropped).toEqual([])
  })

  it('drops a slice with no cacheKey, an unknown key, and a duplicate place', () => {
    const { source, dropped } = parseSourceMeta({
      provider: 'EPA',
      replication: {
        status: 'partial',
        slices: [
          { cacheKey: 'g13089' },
          { cacheKey: 'g13089', count: 9 },
          { place: 'somewhere' },
          { cacheKey: 'p33.7490_-84.3880_r5', rows: [1, 2] },
          42,
        ],
      },
    })
    expect(source?.replication?.slices).toEqual([{ cacheKey: 'g13089' }, { cacheKey: 'p33.7490_-84.3880_r5' }])
    expect(dropped).toEqual([
      'replication.slices[2] (no cacheKey)',
      'unknown key "replication.slices[3].rows"',
      'replication.slices[4] (expected a slice or a slug)',
    ])
  })

  it('caps the list rather than letting one source grow the catalog row without limit', () => {
    const slices = Array.from({ length: SOURCE_SLICES_MAX + 5 }, (_, i) => ({ cacheKey: `g${10000 + i}` }))
    const { source, dropped } = parseSourceMeta({ provider: 'X', replication: { status: 'partial', slices } })
    expect(source?.replication?.slices).toHaveLength(SOURCE_SLICES_MAX)
    expect(dropped).toEqual([`replication.slices (kept ${SOURCE_SLICES_MAX} of ${SOURCE_SLICES_MAX + 5})`])
  })
})
