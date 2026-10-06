import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-59 "Replicate now". Real bucket (FakeS3), real catalog (pg-mem), real
 * manifests — only the agency at the far end is a fake fetch, because the
 * things this can get wrong (a half-written dataset, a lineage that does not
 * match, a cap that is not enforced) are invisible against a mock.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, getFile } = await import('./libraryBucket.js')
const { indexFileBackedEntry, getCatalogEntry, reindexCatalog } = await import('./libraryCatalog.js')
const { replicateEntry, replicateMaxBytes, replicateMaxRows } = await import('./replicate.js')
const { resetRateLimits } = await import('./placeHttp.js')
const { resetLinkFetchQueue, whenQueueIdle } = await import('./linkFetchQueue.js')
const { publicLookup } = await import('../testutils/fixtures/inspect/index.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: FakeS3
let dataDir: string

const ACTOR = { userId: 1, actor: 'nick' }

/** An ArcGIS page of point features, `resultOffset`-aware. */
function arcgisPages(total: number, pageSize: number) {
  return vi.fn(async (input: any) => {
    const url = new URL(String(input))
    const offset = Number(url.searchParams.get('resultOffset') ?? 0)
    const asked = Number(url.searchParams.get('resultRecordCount') ?? pageSize)
    // Real servers hand back fewer than asked and flag that there is more —
    // the paging loop must not read a short page as "the end".
    const size = Math.min(pageSize, asked, Math.max(0, total - offset))
    const features = Array.from({ length: size }, (_, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.4 + (offset + i) / 1000, 33.7] },
      properties: {
        SITE_NAME: `Site ${offset + i}`,
        STCOFIPS: '13121',
        SITE_SCORE: 40 + ((offset + i) % 10),
      },
    }))
    return new Response(
      JSON.stringify({ type: 'FeatureCollection', features, exceededTransferLimit: offset + size < total }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
}

async function seedSource(slug: string, over: Record<string, unknown> = {}): Promise<void> {
  const meta = {
    title: 'EPA Superfund NPL sites',
    category: 'environment',
    status: 'needs-review',
    tags: [],
    source: {
      provider: 'US EPA',
      access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0' }],
      placeQuery: { fipsField: 'STCOFIPS' },
      replication: { status: 'indexed' },
    },
    ingest: { plan: 'replicate', mode: 'auto', decidedBy: 'nick', decidedAt: '2026-09-06T00:00:00.000Z' },
    ...over,
  }
  const key = `library/sources/${slug}/meta.json`
  const json = JSON.stringify(meta, null, 2)
  fake.seed(key, json)
  await indexFileBackedEntry('source', slug, meta, [{ key, size: Buffer.byteLength(json) }])
}

async function seedFetchedLink(slug: string, csv: string): Promise<void> {
  const fileKey = `library/incoming/${slug}/nri_counties.csv`
  const metaKey = `library/incoming/${slug}/meta.json`
  const meta = {
    title: 'FEMA National Risk Index counties',
    category: 'hazards',
    status: 'needs-review',
    tags: [],
    url: 'https://hazards.fema.gov/downloads/nri_counties.csv',
    originalFilename: 'nri_counties.csv',
    contentType: 'text/csv',
    fetch: { status: 'fetched', at: '2026-09-06T00:00:00.000Z', bytes: csv.length, name: 'nri_counties.csv' },
    inspection: { kind: 'file', confidence: 'high', url: 'https://hazards.fema.gov/downloads/nri_counties.csv', checkedAt: 'x' },
    ingest: { plan: 'replicate', mode: 'auto', decidedBy: 'nick', decidedAt: '2026-09-06T00:00:00.000Z' },
  }
  const json = JSON.stringify(meta, null, 2)
  fake.seed(fileKey, csv)
  fake.seed(metaKey, json)
  await indexFileBackedEntry('incoming', slug, meta, [
    { key: fileKey, size: Buffer.byteLength(csv) },
    { key: metaKey, size: Buffer.byteLength(json) },
  ])
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-replicate-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  resetRateLimits()
  resetLinkFetchQueue()
})

afterEach(async () => {
  await whenQueueIdle()
  resetLinkFetchQueue()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('replicateEntry - an ArcGIS source', () => {
  it('pages the whole layer, writes CSV and GeoJSON, and marks the source replicated', async () => {
    await seedSource('epa-npl')
    const fetchImpl = arcgisPages(2_500, 1_000)
    const result = await replicateEntry({ slug: 'epa-npl', ...ACTOR, http: { fetchImpl: fetchImpl as any, lookup: publicLookup } })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toBe(2_500)
    expect(result.truncated).toBe(false)

    const dataset = await getCatalogEntry(result.dataset)
    expect(dataset?.kind).toBe('dataset')
    expect(dataset?.status).toBe('needs-review')
    expect(dataset?.meta.lineage).toMatchObject({ from: 'source:epa-npl', rows: 2_500 })
    // Datasets live under library/datasets/, not in the incoming queue.
    expect(dataset?.files.every(f => f.key.startsWith('library/datasets/'))).toBe(true)

    const csv = (await getFile(dataset!.files.find(f => f.key.endsWith('.csv'))!.key)).toString('utf8')
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(2_501)
    expect(lines[0]).toContain('SITE_NAME')
    // Points get their coordinates as columns so the layer block can name them.
    expect(lines[0]).toContain('latitude')

    const geojsonFile = dataset!.files.find(f => f.key.endsWith('.geojson'))
    expect(geojsonFile).toBeTruthy()

    const source = await getCatalogEntry('epa-npl')
    expect((source!.meta.source as any).replication).toEqual({ status: 'replicated', dataset: result.dataset })
  })

  it('proposes a point layer block, ready for an admin to publish', async () => {
    await seedSource('epa-npl')
    const result = await replicateEntry({
      slug: 'epa-npl',
      ...ACTOR,
      http: { fetchImpl: arcgisPages(10, 1_000) as any, lookup: publicLookup },
    })
    if (!result.ok) throw new Error('expected a replication')
    const dataset = await getCatalogEntry(result.dataset)
    expect(dataset?.meta.layer).toMatchObject({
      geometry: 'point',
      latKey: 'latitude',
      lngKey: 'longitude',
      labelKey: 'SITE_NAME',
    })
  })

  it('stops at the row cap and says the copy is partial', async () => {
    await seedSource('epa-npl')
    const result = await replicateEntry({
      slug: 'epa-npl',
      ...ACTOR,
      maxRows: 1_500,
      http: { fetchImpl: arcgisPages(9_000, 1_000) as any, lookup: publicLookup },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.fallback).toBe('fetch-on-demand')
    expect(result.reason).toMatch(/too big|more than/i)
  })

  it('keeps paging while the server flags more, even when a page comes back short', async () => {
    await seedSource('epa-npl')
    // 3 features per page though 1,000 were asked for: exactly the NC OneMap
    // behaviour. Trusting the requested count would stop after one page.
    const result = await replicateEntry({
      slug: 'epa-npl',
      ...ACTOR,
      http: { fetchImpl: arcgisPages(11, 3) as any, lookup: publicLookup },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toBe(11)
  })

  it('writes an audit row naming what was copied', async () => {
    await seedSource('epa-npl')
    await replicateEntry({ slug: 'epa-npl', ...ACTOR, http: { fetchImpl: arcgisPages(5, 1_000) as any, lookup: publicLookup } })
    await new Promise(r => setTimeout(r, 30))
    const rows = await libraryQuery(`SELECT action, target, detail FROM library_audit WHERE action = 'library.replicate'`)
    expect(rows.rows).toHaveLength(1)
    expect((rows.rows[0] as any).detail).toMatchObject({ from: 'epa-npl', rows: 5 })
  })
})

describe('replicateEntry - a fetched file', () => {
  const CSV = 'GEOID,COUNTY,RISK_SCORE\n13121,Fulton,88.4\n13089,DeKalb,71.2\n'

  it('turns the downloaded file into a dataset entry with its lineage', async () => {
    await seedFetchedLink('link-1', CSV)
    const result = await replicateEntry({ slug: 'link-1', ...ACTOR })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.rows).toBe(2)

    const dataset = await getCatalogEntry(result.dataset)
    expect(dataset?.kind).toBe('dataset')
    expect(dataset?.meta.lineage).toMatchObject({
      from: 'https://hazards.fema.gov/downloads/nri_counties.csv',
      rows: 2,
    })
    expect(dataset?.meta.layer).toMatchObject({ geometry: 'county', geoKey: 'GEOID', valueKey: 'RISK_SCORE' })
  })

  it('marks the link plan done, so the queue stops asking', async () => {
    await seedFetchedLink('link-1', CSV)
    const result = await replicateEntry({ slug: 'link-1', ...ACTOR })
    if (!result.ok) throw new Error('expected a replication')
    const link = await getCatalogEntry('link-1')
    expect((link!.meta.ingest as any).done).toMatchObject({ dataset: result.dataset })
  })

  it('refuses an entry with nothing to copy, in words a person can act on', async () => {
    const metaKey = 'library/incoming/bare/meta.json'
    const meta = { title: 'A page', status: 'needs-review', url: 'https://example.org/report' }
    fake.seed(metaKey, JSON.stringify(meta, null, 2))
    await indexFileBackedEntry('incoming', 'bare', meta, [{ key: metaKey, size: 50 }])
    const result = await replicateEntry({ slug: 'bare', ...ACTOR })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/nothing to copy/i)
  })
})

describe('replicateEntry - coordinates', () => {
  it('reprojects Web Mercator rather than writing metres as latitudes', async () => {
    await seedSource('ga-lands', {
      title: 'Georgia conservation lands',
      source: {
        provider: 'Georgia DNR',
        access: [{ type: 'download', url: 'https://hub.arcgis.com/api/download/v1/items/d18/geojson', format: 'geojson' }],
      },
    })
    const body = JSON.stringify({
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'EPSG:3857' } },
      features: [
        {
          type: 'Feature',
          properties: { name: 'BARROW EASEMENT', gisacres: 412.6 },
          geometry: { type: 'Point', coordinates: [-9400000, 3990000] },
        },
      ],
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await replicateEntry({
      slug: 'ga-lands',
      ...ACTOR,
      http: { fetchImpl: fetchImpl as any, lookup: publicLookup },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const dataset = await getCatalogEntry(result.dataset)
    const csv = (await getFile(dataset!.files.find(f => f.key.endsWith('.csv'))!.key)).toString('utf8')
    const [, row] = csv.trim().split('\n')
    const lat = Number(row.split(',').at(-1))
    const lng = Number(row.split(',').at(-2))
    expect(lng).toBeCloseTo(-84.44, 1)
    expect(lat).toBeCloseTo(33.66, 0)
  })

  it('refuses a projection it cannot convert instead of writing nonsense', async () => {
    await seedSource('nc-parcels', {
      title: 'NC parcels',
      source: {
        provider: 'NCCGIA',
        access: [{ type: 'download', url: 'https://example.org/parcels.geojson', format: 'geojson' }],
      },
    })
    const body = JSON.stringify({
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'EPSG:2264' } },
      features: [{ type: 'Feature', properties: { parno: '1' }, geometry: { type: 'Point', coordinates: [407567, 35548] } }],
    })
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    const result = await replicateEntry({
      slug: 'nc-parcels',
      ...ACTOR,
      http: { fetchImpl: fetchImpl as any, lookup: publicLookup },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/EPSG:2264/)
  })
})

/**
 * P5-59, found live: a dropped link is titled with its own URL until somebody
 * files it, so the copy came out as
 * `www-ers-usda-gov-sites-default-files-laserfiche-datafiles-53251-ruralurban…`.
 */
describe('what the copy is called', () => {
  const CSV = 'GEOID,COUNTY,RISK_SCORE\n13121,Fulton,88.4\n'

  async function seedUrlTitledLink(slug: string, url: string, over: Record<string, unknown> = {}): Promise<void> {
    const fileKey = `library/incoming/${slug}/download`
    const metaKey = `library/incoming/${slug}/meta.json`
    const meta = { title: url, status: 'needs-cataloging', url, ...over }
    const json = JSON.stringify(meta, null, 2)
    fake.seed(fileKey, CSV)
    fake.seed(metaKey, json)
    await indexFileBackedEntry('incoming', slug, meta, [
      { key: fileKey, size: Buffer.byteLength(CSV) },
      { key: metaKey, size: Buffer.byteLength(json) },
    ])
  }

  it('names the dataset (and its file) from the suggestion, not the URL', async () => {
    await seedUrlTitledLink('drop-1', 'https://www.ers.usda.gov/sites/default/files/laserfiche/DataFiles/53251/ruralurbancontinuumcodes2013.xls', {
      suggested: { at: 'T', model: 'stub', title: 'USDA Rural-Urban Continuum Codes 2013' },
    })
    const result = await replicateEntry({ slug: 'drop-1', ...ACTOR })
    if (!result.ok) throw new Error(result.reason)
    expect(result.dataset).toBe('usda-rural-urban-continuum-codes-2013')
    const dataset = await getCatalogEntry(result.dataset)
    expect(dataset?.title).toBe('USDA Rural-Urban Continuum Codes 2013 (copied)')
    expect(dataset?.files.some(f => f.key.endsWith('/usda-rural-urban-continuum-codes-2013.csv'))).toBe(true)
  })

  it('falls back to the inspection title, then to a readable piece of the address', async () => {
    await seedUrlTitledLink('drop-2', 'https://data.example.gov/x/y.csv', {
      inspection: {
        kind: 'file',
        confidence: 'high',
        url: 'https://data.example.gov/x/y.csv',
        title: 'Georgia conservation lands',
        checkedAt: 'T',
      },
    })
    const withInspection = await replicateEntry({ slug: 'drop-2', ...ACTOR })
    if (!withInspection.ok) throw new Error(withInspection.reason)
    expect(withInspection.dataset).toBe('georgia-conservation-lands')

    // Nothing to go on: host plus the last part of the path that is a name.
    await seedUrlTitledLink('drop-3', 'https://hub.arcgis.com/api/download/v1/items/d1817e58f0e5460fbbc2b1ec5d4b0e2c/geojson')
    const bare = await replicateEntry({ slug: 'drop-3', ...ACTOR })
    if (!bare.ok) throw new Error(bare.reason)
    expect(bare.dataset).toBe('hub-arcgis-com')
    expect(bare.dataset.length).toBeLessThanOrEqual(80)
  })

  it('keeps an entry that has a real title, and de-duplicates a repeat copy', async () => {
    await seedSource('epa-npl')
    const first = await replicateEntry({
      slug: 'epa-npl',
      ...ACTOR,
      http: { fetchImpl: arcgisPages(3, 1_000) as any, lookup: publicLookup },
    })
    await seedSource('epa-npl-2')
    const second = await replicateEntry({
      slug: 'epa-npl-2',
      ...ACTOR,
      http: { fetchImpl: arcgisPages(3, 1_000) as any, lookup: publicLookup },
    })
    expect(first.ok && first.dataset).toBe('epa-superfund-npl-sites')
    expect(second.ok && second.dataset).toBe('epa-superfund-npl-sites-2')
  })
})

/**
 * P5-59, found live: the Georgia conservation-lands copy wrote 4,254 polygon
 * rows with no lat/lng and no layer block, so it could neither go on the map
 * nor be given county context.
 */
describe('replicateEntry - polygons', () => {
  const POLYGON = {
    type: 'Polygon',
    coordinates: [[[-84.5, 33.6], [-84.3, 33.6], [-84.3, 33.8], [-84.5, 33.8], [-84.5, 33.6]]],
  }

  async function seedGeoJsonSource(slug: string, body: string): Promise<() => any> {
    await seedSource(slug, {
      title: 'Georgia conservation lands',
      source: {
        provider: 'Georgia DNR',
        access: [{ type: 'download', url: 'https://example.org/lands.geojson', format: 'geojson' }],
      },
    })
    return vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
  }

  const featureCollection = (crs: Record<string, unknown> | null, geometry: unknown) =>
    JSON.stringify({
      type: 'FeatureCollection',
      ...(crs ? { crs } : {}),
      features: [
        {
          type: 'Feature',
          properties: { name: 'BARROW EASEMENT', ownr_categ: 'private', gisacres: 412.6, stcntyfips: '13013' },
          geometry,
        },
      ],
    })

  it('gives every polygon a centroid, a GEOID and a point layer to draw it with', async () => {
    const fetchImpl = await seedGeoJsonSource('ga-lands', featureCollection(null, POLYGON))
    const result = await replicateEntry({
      slug: 'ga-lands',
      ...ACTOR,
      http: { fetchImpl: fetchImpl as any, lookup: publicLookup },
    })
    if (!result.ok) throw new Error(result.reason)
    const dataset = await getCatalogEntry(result.dataset)
    const csv = (await getFile(dataset!.files.find(f => f.key.endsWith('.csv'))!.key)).toString('utf8')
    const [header, row] = csv.trim().split('\n')
    expect(header).toContain('longitude')
    expect(header).toContain('latitude')
    // County context: the FIPS column copied under the name everything looks for.
    expect(header).toContain('GEOID')
    const cells = Object.fromEntries(header.split(',').map((name, i) => [name, row.split(',')[i]]))
    expect(Number(cells.longitude)).toBeCloseTo(-84.4, 5)
    expect(Number(cells.latitude)).toBeCloseTo(33.7, 5)
    expect(cells.GEOID).toBe('13013')

    expect(dataset?.meta.layer).toMatchObject({
      geometry: 'point',
      latKey: 'latitude',
      lngKey: 'longitude',
      labelKey: 'name',
    })
    expect((dataset!.meta.layer as any).popupFields.length).toBeLessThanOrEqual(6)
    expect((dataset!.meta.layer as any).popupFields).toContain('gisacres')
    // The shapes are kept as they were, for a polygon layer later.
    expect(dataset?.files.some(f => f.key.endsWith('.geojson'))).toBe(true)
  })

  /**
   * P5-59, second walk: the live layer came out as `labelKey: "owner_code"`
   * with popups of FID, rowid and four internal codes — every one of them
   * useless to a reader — while a `name` column sat there unused.
   */
  it('labels by the name column and fills the popup with words, not ids', async () => {
    const columns = {
      FID: 1,
      rowid: 17,
      source: 'GA DNR 2020',
      managing_a: 'Georgia DNR',
      manager_co: 'State',
      mgr_categ: 'state agency',
      name: 'BARROW EASEMENT',
      ownr_categ: 'private conservation land with easement',
      owner_code: 'PVT',
      gisacres: 412.6,
      stcntyfips: '13013',
    }
    const body = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: columns, geometry: POLYGON },
        { type: 'Feature', properties: { ...columns, FID: 2, rowid: 18, name: 'JONES TRACT' }, geometry: POLYGON },
      ],
    })
    const fetchImpl = await seedGeoJsonSource('ga-lands-labels', body)
    const result = await replicateEntry({
      slug: 'ga-lands-labels',
      ...ACTOR,
      http: { fetchImpl: fetchImpl as any, lookup: publicLookup },
    })
    if (!result.ok) throw new Error(result.reason)
    const layer = (await getCatalogEntry(result.dataset))!.meta.layer as any

    expect(layer.labelKey).toBe('name')
    expect(layer.popupFields).toHaveLength(6)
    for (const wanted of ['ownr_categ', 'mgr_categ', 'managing_a', 'source']) {
      expect(layer.popupFields).toContain(wanted)
    }
    // Keys, codes, coordinates and the label itself are not popup material.
    for (const unwanted of ['FID', 'rowid', 'owner_code', 'GEOID', 'latitude', 'longitude', 'name']) {
      expect(layer.popupFields).not.toContain(unwanted)
    }
    // File order among the ones it kept.
    expect(layer.popupFields.indexOf('source')).toBeLessThan(layer.popupFields.indexOf('mgr_categ'))
  })

  it('takes the centroid after reprojecting Web Mercator, not before', async () => {
    const mercator = {
      type: 'Polygon',
      coordinates: [[[-9400000, 3990000], [-9390000, 3990000], [-9390000, 4000000], [-9400000, 3990000]]],
    }
    const fetchImpl = await seedGeoJsonSource(
      'ga-lands-3857',
      featureCollection({ type: 'name', properties: { name: 'EPSG:3857' } }, mercator),
    )
    const result = await replicateEntry({
      slug: 'ga-lands-3857',
      ...ACTOR,
      http: { fetchImpl: fetchImpl as any, lookup: publicLookup },
    })
    if (!result.ok) throw new Error(result.reason)
    const dataset = await getCatalogEntry(result.dataset)
    const csv = (await getFile(dataset!.files.find(f => f.key.endsWith('.csv'))!.key)).toString('utf8')
    const [header, row] = csv.trim().split('\n')
    const cells = Object.fromEntries(header.split(',').map((name, i) => [name, row.split(',')[i]]))
    // Degrees, in Georgia — not metres, and not half a metre value.
    expect(Number(cells.longitude)).toBeCloseTo(-84.35, 1)
    expect(Number(cells.latitude)).toBeCloseTo(33.7, 0)
  })
})

describe('replicate caps', () => {
  it('reads its ceilings from the environment', () => {
    expect(replicateMaxBytes()).toBe(100 * 1024 * 1024)
    expect(replicateMaxRows()).toBeGreaterThan(0)
  })
})

describe('the plan flips itself when a dataset turns up', () => {
  it('a hand-pushed dataset whose lineage names the entry closes the plan at reindex', async () => {
    await seedSource('epa-npl')
    const datasetMeta = {
      title: 'EPA NPL sites (cleaned)',
      status: 'published',
      category: 'environment',
      lineage: { from: 'source:epa-npl', fetchedAt: '2026-09-07T00:00:00.000Z', rows: 1337 },
    }
    const key = 'library/datasets/epa-npl-clean/meta.json'
    fake.seed(key, JSON.stringify(datasetMeta, null, 2))
    fake.seed('library/datasets/epa-npl-clean/sites.csv', 'a,b\n1,2\n')

    await reindexCatalog()
    const source = await getCatalogEntry('epa-npl')
    expect((source!.meta.ingest as any).done).toEqual({ at: '2026-09-07T00:00:00.000Z', dataset: 'epa-npl-clean' })
  })
})
