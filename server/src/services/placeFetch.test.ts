import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog, getCatalogEntry } = await import('./libraryCatalog.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')
const { resetRateLimits } = await import('./placeHttp.js')
const {
  cleanRadius,
  fetchForPlace,
  isFresh,
  listSlices,
  placeKeyFor,
  pickAccess,
  promoteSlice,
  readSlice,
  namePlace,
  resolvePlace,
  sliceCsv,
  sliceKey,
  isSourceFault,
} = await import('./placeFetch.js')
const { ARCGIS_GEOJSON, ATLANTA, COUNTY_CSV, jsonResponse, publicLookup, textResponse } = await import(
  '../testutils/fixtures/place/index.js'
)

/**
 * P5-57: the lazy-replication service. These tests drive the REAL bucket and
 * catalog (FakeS3 + pg-mem) with a faked network, because the parts most worth
 * proving — the cache, the place key, what the source entry ends up saying —
 * are exactly the parts a mocked bucket would hide.
 */

let fake: InstanceType<typeof FakeS3>
let dataDir: string

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const SUPERFUND = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  category: 'environment',
  source: {
    provider: 'US EPA',
    program: 'Superfund / SEMS',
    access: [
      { type: 'arcgis', url: 'https://services.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0' },
    ],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
    updateCadence: 'weekly',
    replication: { status: 'indexed' },
  },
}

async function seedSource(slug = 'epa-superfund-npl', meta: Record<string, unknown> = SUPERFUND): Promise<void> {
  fake.seed(`library/sources/${slug}/meta.json`, JSON.stringify(meta, null, 2))
  await reindexCatalog()
}

const geoJsonFetch = () => vi.fn(async () => jsonResponse(ARCGIS_GEOJSON))
const http = (fetchImpl: any) => ({ fetchImpl, lookup: publicLookup as any })

beforeEach(async () => {
  resetRateLimits()
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-place-fetch-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// --- Places ------------------------------------------------------------------

describe('place keys', () => {
  it('names a county by its FIPS and a point by its rounded coordinates and radius', () => {
    expect(placeKeyFor({ label: 'Fulton', lat: null, lng: null, geoid: '13121', radiusMiles: 5 })).toBe('g13121')
    expect(placeKeyFor({ label: 'x', lat: 33.749, lng: -84.388, geoid: '13121', radiusMiles: 5 })).toBe('p33.7490_-84.3880_r5')
    // A fractional radius is part of the key — 0.25 mi and 5 mi are different
    // questions about the same point.
    expect(placeKeyFor({ label: 'x', lat: 33.749, lng: -84.388, geoid: null, radiusMiles: 0.25 })).toBe('p33.7490_-84.3880_r0.25')
    // Four decimals ≈ 11 m: the same address twice is the same slice.
    expect(placeKeyFor({ label: 'x', lat: 33.74901, lng: -84.38804, geoid: null, radiusMiles: 5 })).toBe('p33.7490_-84.3880_r5')
  })

  it('builds a key the bucket will accept', () => {
    expect(sliceKey('epa-superfund-npl', 'p33.7490_-84.3880_r5')).toBe(
      'library/derived/sources/epa-superfund-npl/p33.7490_-84.3880_r5.json',
    )
  })
})

describe('resolvePlace', () => {
  it('takes a point as given', async () => {
    const place = await resolvePlace({ point: { lat: 33.749, lng: -84.388 } }, 5)
    expect(place).toMatchObject({ lat: 33.749, lng: -84.388, radiusMiles: 5 })
  })

  // P6-15: naming is `namePlace`, called once per report — NOT `resolvePlace`,
  // which runs once per source and must stay free of network calls.
  it('leaves resolvePlace free of any lookup, so forty sources cost none', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}))
    const place = await resolvePlace({ point: { lat: 35.1495, lng: -90.049 } }, 5, http(fetchImpl))
    expect(place.label).toBe('35.1495, -90.0490')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('names a point when asked, keeping the coordinates on the place', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/reverse')
        ? jsonResponse({ address: { city: 'Memphis', county: 'Shelby County', state: 'Tennessee' } })
        : jsonResponse({}),
    )
    const place = await namePlace(await resolvePlace({ point: { lat: 35.1495, lng: -90.049 } }, 5), http(fetchImpl))
    expect(place.label).toBe('Memphis, Shelby County, Tennessee')
    expect(place).toMatchObject({ lat: 35.1495, lng: -90.049 })
  })

  it('keeps the coordinates when the lookup knows nothing or fails', async () => {
    const base = await resolvePlace({ point: { lat: 35.1495, lng: -90.049 } }, 5)
    const empty = vi.fn(async () => jsonResponse({}))
    await expect(namePlace(base, http(empty))).resolves.toMatchObject({ label: '35.1495, -90.0490' })
    const broken = vi.fn(async () => {
      throw new Error('nominatim is down')
    })
    await expect(namePlace(base, http(broken))).resolves.toMatchObject({ label: '35.1495, -90.0490' })
  })

  it('leaves an address and a county alone — both already carry a name', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ address: { city: 'Nope' } }))
    const typed = { label: '123 Main St, Memphis', lat: 35.1, lng: -90.0, geoid: null, radiusMiles: 5, address: '123 Main St' }
    await expect(namePlace(typed, http(fetchImpl))).resolves.toMatchObject({ label: '123 Main St, Memphis' })
    const county = { label: 'Shelby County, TN', lat: null, lng: null, geoid: '47157', radiusMiles: 5 }
    await expect(namePlace(county, http(fetchImpl))).resolves.toMatchObject({ label: 'Shelby County, TN' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('geocodes an address through the Census, then Nominatim', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('onelineaddress')) return jsonResponse({ result: { addressMatches: [] } })
      if (url.includes('nominatim')) return jsonResponse([{ lat: '33.749', lon: '-84.388', display_name: 'Atlanta, GA' }])
      return jsonResponse({ result: { geographies: { Counties: [{ GEOID: '13121' }] } } })
    })
    const place = await resolvePlace({ address: 'Atlanta' }, 5, http(fetchImpl))
    expect(place).toMatchObject({ lat: 33.749, lng: -84.388, geoid: '13121', label: 'Atlanta, GA', address: 'Atlanta' })
  })

  it('says so plainly when nobody knows the place', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('nominatim') ? jsonResponse([]) : jsonResponse({ result: { addressMatches: [] } }),
    )
    await expect(resolvePlace({ address: 'nowhere at all' }, 5, http(fetchImpl))).rejects.toMatchObject({ code: 'bad-place' })
  })

  it('needs one of the three ways to say where', async () => {
    await expect(resolvePlace({}, 5)).rejects.toMatchObject({ code: 'bad-place' })
  })

  it('takes the radius from the request, then the source, then five miles', () => {
    expect(cleanRadius(2, 10)).toBe(2)
    expect(cleanRadius(undefined, 10)).toBe(10)
    expect(cleanRadius(undefined, undefined)).toBe(5)
    expect(cleanRadius(-4, undefined)).toBe(5)
    // Nobody gets to ask for the whole country as a "radius".
    expect(cleanRadius(9_000, undefined)).toBe(100)
  })
})

describe('picking an adapter', () => {
  it('takes the first access method we can actually run', () => {
    expect(
      pickAccess({ provider: 'X', access: [{ type: 'wfs', url: 'https://x.test/wfs' }, { type: 'arcgis', url: 'https://x.test/a' }] })
        .type,
    ).toBe('arcgis')
  })

  it('explains a source that is only ever fetched by hand', () => {
    expect(() => pickAccess({ provider: 'Georgia EPD', access: [{ type: 'manual' }] })).toThrowError(/by hand/)
    expect(() => pickAccess({ provider: 'X' })).toThrowError(/by hand/)
  })
})

// --- The fetch ---------------------------------------------------------------

describe('fetchForPlace', () => {
  it('fetches, caches the slice, and answers the second question from the cache', async () => {
    await seedSource()
    const fetchImpl = geoJsonFetch()
    const first = await fetchForPlace({ slug: 'epa-superfund-npl', point: ATLANTA, http: http(fetchImpl) })
    expect(first.cached).toBe(false)
    expect(first.count).toBe(3)
    expect(first.adapter).toBe('arcgis')
    expect(first.cacheKey).toBe('p33.7490_-84.3880_r5')
    expect(first.geometry?.features).toHaveLength(2)
    expect(fake.objects.has('library/derived/sources/epa-superfund-npl/p33.7490_-84.3880_r5.json')).toBe(true)

    const second = await fetchForPlace({ slug: 'epa-superfund-npl', point: ATLANTA, http: http(fetchImpl) })
    expect(second.cached).toBe(true)
    expect(second.count).toBe(3)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('asks again when the slice is older than the source’s cadence, or when told to', async () => {
    await seedSource()
    const fetchImpl = geoJsonFetch()
    await fetchForPlace({ slug: 'epa-superfund-npl', point: ATLANTA, http: http(fetchImpl) })

    const key = 'library/derived/sources/epa-superfund-npl/p33.7490_-84.3880_r5.json'
    const doc = JSON.parse(fake.objects.get(key)!.toString())
    expect(doc.ttlDays).toBe(7) // "weekly"
    expect(isFresh(doc)).toBe(true)
    expect(isFresh({ ...doc, fetchedAt: new Date(Date.now() - 8 * 864e5).toISOString() })).toBe(false)

    fake.seed(key, JSON.stringify({ ...doc, fetchedAt: new Date(Date.now() - 8 * 864e5).toISOString() }))
    const stale = await fetchForPlace({ slug: 'epa-superfund-npl', point: ATLANTA, http: http(fetchImpl) })
    expect(stale.cached).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    await fetchForPlace({ slug: 'epa-superfund-npl', point: ATLANTA, refresh: true, http: http(fetchImpl) })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('records the slice on the source entry and moves it to partly copied', async () => {
    await seedSource()
    await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '13121', http: http(geoJsonFetch()) })

    const manifest = JSON.parse(fake.objects.get('library/sources/epa-superfund-npl/meta.json')!.toString())
    expect(manifest.source.replication.status).toBe('partial')
    expect(manifest.source.replication.slices).toEqual([
      { cacheKey: 'g13121', place: 'Fulton County, GA', count: 3, fetchedAt: expect.any(String), adapter: 'arcgis' },
    ])

    // Bucket first, then the row — the catalog agrees without a reindex.
    const entry = await getCatalogEntry('epa-superfund-npl')
    expect((entry!.meta.source as any).replication.status).toBe('partial')
    expect((entry!.meta.source as any).replication.slices[0].cacheKey).toBe('g13121')
  })

  it('replaces a place’s row rather than piling up duplicates', async () => {
    await seedSource()
    const fetchImpl = geoJsonFetch()
    await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '13121', http: http(fetchImpl) })
    await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '13121', refresh: true, http: http(fetchImpl) })
    await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '47157', http: http(fetchImpl) })

    const manifest = JSON.parse(fake.objects.get('library/sources/epa-superfund-npl/meta.json')!.toString())
    expect(manifest.source.replication.slices.map((s: any) => s.cacheKey)).toEqual(['g47157', 'g13121'])
  })

  it('lists what we hold for a source, newest first and without the rows', async () => {
    await seedSource()
    const fetchImpl = geoJsonFetch()
    await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '13121', http: http(fetchImpl) })
    await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '47157', http: http(fetchImpl) })
    const slices = await listSlices('epa-superfund-npl')
    expect(slices.map(s => s.cacheKey).sort()).toEqual(['g13121', 'g47157'])
    expect(slices[0].rows).toEqual([])
    expect(slices[0].count).toBe(3)
  })

  it('writes a source.fetch audit line with the place, the count and how long it took', async () => {
    await seedSource()
    await fetchForPlace({
      slug: 'epa-superfund-npl',
      geoid: '13121',
      http: http(geoJsonFetch()),
      actor: { id: 7, username: 'nick' },
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    const { rows } = await libraryQuery(`SELECT actor, action, target, detail FROM library_audit WHERE action = 'source.fetch'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'nick', action: 'source.fetch', target: 'epa-superfund-npl' })
    expect(rows[0].detail).toMatchObject({ placeKey: 'g13121', count: 3, adapter: 'arcgis' })
    expect(typeof rows[0].detail.ms).toBe('number')
  })

  it('refuses a source that is not a source, and one nobody can fetch', async () => {
    fake.seed('library/datasets/organizations/meta.json', JSON.stringify({ title: 'Organizations' }))
    fake.seed('library/datasets/organizations/organizations.csv', 'a,b\n1,2\n')
    await seedSource('georgia-epd-ust', {
      title: 'Georgia EPD USTs',
      source: { provider: 'Georgia EPD', access: [{ type: 'manual' }] },
    })
    await expect(fetchForPlace({ slug: 'organizations', geoid: '13121' })).rejects.toMatchObject({ code: 'no-endpoint' })
    await expect(fetchForPlace({ slug: 'nope', geoid: '13121' })).rejects.toMatchObject({ code: 'no-endpoint' })
    await expect(fetchForPlace({ slug: 'georgia-epd-ust', geoid: '13121' })).rejects.toMatchObject({ code: 'manual-only' })
    // Neither refusal is the source's fault, so neither lands it in the
    // "last fetch failed" queue.
    const manual = await getCatalogEntry('georgia-epd-ust')
    expect((manual?.meta?.source as { lastError?: unknown })?.lastError).toBeUndefined()
  })

  it('records a failure only when it is the source’s fault', () => {
    expect(isSourceFault('no-endpoint')).toBe(false)
    expect(isSourceFault('manual-only')).toBe(false)
    expect(isSourceFault('bad-place')).toBe(false)
    for (const code of ['http-error', 'timeout', 'network', 'bad-response', 'too-large', 'rate-limited'] as const) {
      expect(isSourceFault(code)).toBe(true)
    }
  })

  it('does not call out at all when the host is not public', async () => {
    await seedSource()
    const fetchImpl = vi.fn()
    await expect(
      fetchForPlace({
        slug: 'epa-superfund-npl',
        geoid: '13121',
        http: { fetchImpl: fetchImpl as any, lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      }),
    ).rejects.toMatchObject({ code: 'not-public' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// --- Promotion ---------------------------------------------------------------

describe('promoteSlice', () => {
  it('turns a cached slice into an incoming dataset with its lineage', async () => {
    await seedSource()
    const fetched = await fetchForPlace({
      slug: 'epa-superfund-npl',
      geoid: '13121',
      http: http(geoJsonFetch()),
      actor: { id: 7, username: 'nick' },
    })
    const promoted = await promoteSlice({
      slug: 'epa-superfund-npl',
      cacheKey: fetched.cacheKey,
      actor: { id: 7, username: 'nick' },
    })

    const entry = await getCatalogEntry(promoted.slug)
    expect(entry!.kind).toBe('incoming')
    expect(entry!.status).toBe('needs-review')
    expect(entry!.title).toBe('EPA Superfund NPL sites — Fulton County, GA')
    expect(entry!.meta.lineage).toMatchObject({
      from: 'source:epa-superfund-npl',
      fetchedAt: fetched.fetchedAt,
      place: { geoid: '13121', label: 'Fulton County, GA' },
    })

    const csv = fake.objects.get(`library/incoming/${promoted.slug}/epa-superfund-npl-g13121.csv`)!.toString()
    expect(csv.split('\n')[0]).toBe('Site_Name,Site_EPA_ID,Status,Site_Score')
    expect(csv).toContain('Lakewood Landfill')

    // The source now says which dataset this place became.
    const manifest = JSON.parse(fake.objects.get('library/sources/epa-superfund-npl/meta.json')!.toString())
    expect(manifest.source.replication.slices[0].dataset).toBe(promoted.slug)
  })

  it('takes a title when it is given one', async () => {
    await seedSource()
    const fetched = await fetchForPlace({ slug: 'epa-superfund-npl', geoid: '13121', http: http(geoJsonFetch()) })
    const promoted = await promoteSlice({ slug: 'epa-superfund-npl', cacheKey: fetched.cacheKey, title: 'NPL near the farm' })
    expect((await getCatalogEntry(promoted.slug))!.title).toBe('NPL near the farm')
  })

  it('refuses a place that is no longer cached', async () => {
    await seedSource()
    await expect(promoteSlice({ slug: 'epa-superfund-npl', cacheKey: 'g99999' })).rejects.toMatchObject({ code: 'bad-place' })
  })

  it('writes a CSV even when a later row has a column the first one lacked', async () => {
    const doc = {
      slug: 'x',
      cacheKey: 'g1',
      place: { label: 'x', lat: null, lng: null, geoid: '13121', radiusMiles: 5 },
      adapter: 'arcgis' as const,
      fetchedAt: '2026-09-06T00:00:00.000Z',
      ttlDays: 7,
      columns: ['a', 'b'],
      rows: [{ a: '1', b: '' }, { a: '2', b: 'two, with a comma' }],
      count: 2,
      truncated: false,
    }
    expect(sliceCsv(doc)).toBe('a,b\n1,\n2,"two, with a comma"\n')
  })
})

// --- The other adapters, end to end through the service ----------------------

describe('a download source, through the service', () => {
  it('pulls the file once and cuts the county out of it', async () => {
    await seedSource('fema-nri', {
      title: 'FEMA National Risk Index',
      source: {
        provider: 'FEMA',
        access: [{ type: 'download', url: 'https://www.fema.gov/nri/counties.csv', format: 'csv' }],
        placeQuery: { by: ['county'] },
        updateCadence: 'annual versioned releases',
      },
    })
    const fetchImpl = vi.fn(async () => textResponse(COUNTY_CSV))
    const result = await fetchForPlace({ slug: 'fema-nri', geoid: '13089', http: http(fetchImpl) })
    expect(result.count).toBe(1)
    expect(result.rows[0].COUNTY).toBe('DeKalb County')
    expect(result.adapter).toBe('download')
    expect(await readSlice('fema-nri', 'g13089')).toMatchObject({ count: 1 })
  })
})

// --- Live, opt-in ------------------------------------------------------------

/**
 * Two real endpoints from the P5-56 seed manifests, off by default:
 *
 *   PLACE_FETCH_LIVE=1 npx vitest run src/services/placeFetch.test.ts
 *
 * They are the only tests here that touch the network, and they exist because
 * a fixture cannot tell us whether FEMA still answers on layer 28.
 */
describe('LIVE against the seed manifests (PLACE_FETCH_LIVE=1)', () => {
  it.skipIf(!process.env.PLACE_FETCH_LIVE)(
    'reads FEMA flood zones at a point in Atlanta',
    async () => {
      await seedSource('fema-nfhl-flood-zones', {
        title: 'FEMA National Flood Hazard Layer (flood zones)',
        source: {
          provider: 'FEMA',
          access: [{ type: 'arcgis', url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28' }],
          placeQuery: { by: ['point', 'parcel', 'county'], radiusMiles: 0.25 },
          updateCadence: 'continuous (map revisions and LOMRs as they become effective)',
        },
      })
      const result = await fetchForPlace({ slug: 'fema-nfhl-flood-zones', point: ATLANTA })
      expect(result.adapter).toBe('arcgis')
      // A point with no digital FIRM legitimately returns nothing; what must
      // hold is that the layer answered in a shape we can read.
      expect(Array.isArray(result.rows)).toBe(true)
      if (result.count > 0) expect(result.columns).toContain('FLD_ZONE')
    },
    60_000,
  )

  it.skipIf(!process.env.PLACE_FETCH_LIVE)(
    'geocodes a real address and reads EPA Superfund sites around it',
    async () => {
      await seedSource('epa-superfund-npl', {
        ...SUPERFUND,
        source: {
          ...SUPERFUND.source,
          // The real NPL point layer has no county FIPS column — the address
          // is answered as a point, which is what was asked anyway.
          fipsField: undefined,
          access: [
            {
              type: 'arcgis',
              url: 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Superfund_National_Priorities_List_(NPL)_Sites_with_Status_Information/FeatureServer/0',
            },
          ],
        },
      })
      const result = await fetchForPlace({
        slug: 'epa-superfund-npl',
        address: '1040 Westview Dr SW, Atlanta, GA',
        radiusMiles: 25,
      })
      expect(result.place.geoid).toBe('13121')
      expect(result.adapter).toBe('arcgis')
      expect(result.count).toBeGreaterThan(0)
      expect(result.columns.some(c => /site.?name/i.test(c))).toBe(true)
    },
    60_000,
  )
})
