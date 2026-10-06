import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'
import { FakeS3 } from '../../testutils/fakeS3.js'
import { initLibraryBucket, closeLibraryBucket } from '../libraryBucket.js'
import { resetRateLimits } from '../placeHttp.js'
import { extensionFor, fetchDownload, filterCsv, filterGeoJson, fullKey, loadFullFile } from './download.js'
import { ttlDaysFor } from './shared.js'
import { ATLANTA, COUNTY_CSV, POINT_CSV, POLYGON_GEOJSON, publicLookup, textResponse } from '../../testutils/fixtures/place/index.js'
import type { AdapterContext } from './shared.js'

/**
 * P5-57: a source that publishes one file. Pull it once, keep it as a derived
 * object, and cut every place out of the copy.
 */

let fake: FakeS3
let dataDir: string

function ctx(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    slug: 'fema-nri',
    access: { type: 'download', url: 'https://www.fema.gov/nri/counties.csv', format: 'csv' },
    place: { point: null, geoid: '13121', radiusMiles: 5, bbox: null, label: 'Fulton County, GA', key: 'g13121' },
    updateCadence: 'annual versioned releases',
    http: { lookup: publicLookup as any },
    ...overrides,
  }
}

beforeEach(async () => {
  resetRateLimits()
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-place-download-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('the cached copy', () => {
  it('pulls once, parks it under library/derived/, and reads the copy next time', async () => {
    const fetchImpl = vi.fn(async () => textResponse(COUNTY_CSV))
    const options = { fetchImpl: fetchImpl as any, lookup: publicLookup as any }
    const first = await fetchDownload(ctx({ http: options }))
    expect(first.count).toBe(1)
    expect(fake.objects.has('library/derived/sources/fema-nri/full.csv')).toBe(true)

    const second = await fetchDownload(ctx({ http: options, place: { ...ctx().place, geoid: '47157', key: 'g47157' } }))
    expect(second.rows[0].COUNTY).toBe('Shelby County')
    // One download served both places — the point of caching the file.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('pulls again once the copy is older than the source’s cadence', async () => {
    const fetchImpl = vi.fn(async () => textResponse(COUNTY_CSV))
    const key = fullKey('weekly-source', 'csv')
    fake.seed(key, COUNTY_CSV, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
    const result = await loadFullFile(
      ctx({ slug: 'weekly-source', updateCadence: 'weekly', http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }),
    )
    expect(result.cached).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // A fresh copy of the same file is read, not re-fetched.
    fetchImpl.mockClear()
    const again = await loadFullFile(
      ctx({ slug: 'weekly-source', updateCadence: 'weekly', http: { fetchImpl: fetchImpl as any, lookup: publicLookup as any } }),
    )
    expect(again.cached).toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the cadence the manifests actually use', () => {
    expect(ttlDaysFor('weekly')).toBe(7)
    expect(ttlDaysFor('annual, published each July for the prior reporting year')).toBe(365)
    expect(ttlDaysFor('continuous, with NPL rulemakings roughly twice a year')).toBe(1)
    expect(ttlDaysFor('quarterly')).toBe(90)
    expect(ttlDaysFor('monthly')).toBe(30)
    expect(ttlDaysFor('when someone remembers')).toBe(30)
    expect(ttlDaysFor(undefined)).toBe(30)
  })

  it('reads the file kind from the manifest, the url, then the answer', () => {
    expect(extensionFor(ctx())).toBe('csv')
    expect(extensionFor(ctx({ access: { type: 'download', url: 'https://x.test/zones.geojson' } }))).toBe('geojson')
    expect(extensionFor(ctx({ access: { type: 'download', url: 'https://x.test/download' } }), 'application/json')).toBe('geojson')
  })
})

describe('cutting a place out of a CSV', () => {
  it('matches the county column, including a tract code inside that county', () => {
    const tracts = 'GEOID,NAME\n13121011100,Tract 111\n13089010100,Other county\n'
    const result = filterCsv(tracts, ctx())
    expect(result.count).toBe(1)
    expect(result.rows[0].NAME).toBe('Tract 111')
  })

  it('falls back to the box around the point, then the exact radius', () => {
    const result = filterCsv(POINT_CSV, ctx({ place: { point: ATLANTA, geoid: null, radiusMiles: 5, bbox: null, label: 'Atlanta', key: 'p' } }))
    expect(result.rows.map(r => r.name)).toEqual(['Near well'])
    expect(result.geometry?.features[0].geometry).toEqual({ type: 'Point', coordinates: [-84.39, 33.75] })
  })

  it('says so plainly when a file has neither a county column nor coordinates', () => {
    expect(() => filterCsv('a,b\n1,2\n', ctx({ place: { ...ctx().place, geoid: null } }))).toThrowError(/by hand/)
  })
})

describe('cutting a place out of GeoJSON', () => {
  it('keeps a polygon that touches the box, and drops the one that does not', () => {
    const result = filterGeoJson(
      JSON.stringify(POLYGON_GEOJSON),
      ctx({
        access: { type: 'download', url: 'https://x.test/nfhl.geojson', format: 'geojson' },
        place: { point: ATLANTA, geoid: null, radiusMiles: 1, bbox: null, label: 'Atlanta', key: 'p' },
      }),
    )
    expect(result.count).toBe(1)
    expect(result.rows[0].FLD_ZONE).toBe('AE')
    expect(result.geometry?.features[0].geometry).toMatchObject({ type: 'Polygon' })
  })

  it('refuses a file that is not GeoJSON', () => {
    expect(() => filterGeoJson('<html>404</html>', ctx())).toThrowError(/GeoJSON/)
  })
})
