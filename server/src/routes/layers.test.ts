import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-18: internal layer manifest + values against the real createApp().
 * The manifest is built from the catalog index; values come from the shared
 * tabular parser (P5-31) projected to { GEOID → number }.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { clearTabularCache } = await import('../services/libraryTabular.js')
const { clearInternalLayerBounds } = await import('../services/internalLayers.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('layers-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

const TARGET_CSV = 'GEOID,score,label\n1001,12.5,Autauga\n01003,"1,200",Baldwin\n0500000US01005,7,Barbour\nbad,9,Nope\n01007,,Bibb\n'
const LAYER = {
  geometry: 'county',
  geoKey: 'GEOID',
  valueKey: 'score',
  name: 'Target index',
  dataType: 'index',
  direction: 'higher_better',
  description: 'Where the plan should look first.',
  source: 'BLO internal',
  year: 2026,
}

function meta(extra: Record<string, unknown>): string {
  return JSON.stringify({ title: 'x', category: 'strategy', tags: [], ...extra })
}

beforeEach(async () => {
  clearTabularCache()
  clearInternalLayerBounds()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-layers-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  // published + valid block (no declared range → computed)
  fake.seed('library/datasets/target-index/data.csv', TARGET_CSV)
  fake.seed('library/datasets/target-index/meta.json', meta({ title: 'Target index', status: 'published', layer: LAYER }))
  // published + valid block + explicit file + declared range + two csvs
  fake.seed('library/datasets/two-files/other.csv', 'GEOID,score\n99999,1\n')
  fake.seed('library/datasets/two-files/values.csv', 'fips,pct\n01001,55\n01003,45\n')
  fake.seed(
    'library/datasets/two-files/meta.json',
    meta({
      title: 'Two files',
      status: 'published',
      layer: { ...LAYER, name: 'Percent thing', file: 'values.csv', geoKey: 'fips', valueKey: 'pct', dataType: 'percentage', unit: '%', direction: 'lower_better', range: { min: 0, max: 100 } },
    }),
  )
  // published, no block
  fake.seed('library/datasets/no-block/data.csv', TARGET_CSV)
  fake.seed('library/datasets/no-block/meta.json', meta({ title: 'No block', status: 'published' }))
  // block but not published
  fake.seed('library/datasets/draft/data.csv', TARGET_CSV)
  fake.seed('library/datasets/draft/meta.json', meta({ title: 'Draft', status: 'in-cleaning', layer: LAYER }))
  // published, invalid block (missing valueKey)
  fake.seed('library/datasets/bad-block/data.csv', TARGET_CSV)
  fake.seed('library/datasets/bad-block/meta.json', meta({ title: 'Bad block', status: 'published', layer: { ...LAYER, valueKey: '' } }))
  // published, point geometry (P5-24) — properties are allow-listed
  fake.seed(
    'library/datasets/orgs-hq/organizations.csv',
    'Organization,Tier,HQ City,secret,lat,lng\nBlack Farmer Fund,Tier 1,New York,hidden,40.73,-73.99\nNo coords,Tier 2,Nowhere,hidden,,\n',
  )
  fake.seed(
    'library/datasets/orgs-hq/meta.json',
    meta({
      title: 'Organizations (HQ)',
      status: 'published',
      layer: { geometry: 'point', latKey: 'lat', lngKey: 'lng', labelKey: 'Organization', popupFields: ['Tier', 'HQ City'], color: '#ff6b1c', name: 'Organizations (HQ)', description: 'HQ points', source: 'BLO research', year: 2026 },
    }),
  )
  // published, point geometry, but not one row has a coordinate (P5-77)
  fake.seed('library/datasets/orgs-nowhere/organizations.csv', 'Organization,lat,lng\nUnplaced Fund,,\nOff Earth,95,-73\n')
  fake.seed(
    'library/datasets/orgs-nowhere/meta.json',
    meta({
      title: 'Organizations (unplaced)',
      status: 'published',
      layer: { geometry: 'point', latKey: 'lat', lngKey: 'lng', labelKey: 'Organization', name: 'Organizations (unplaced)', description: '', source: '', year: 2026 },
    }),
  )
  // published, point block missing its keys → invalid, skipped
  fake.seed('library/datasets/points/pts.csv', 'lat,lng\n1,2\n')
  fake.seed('library/datasets/points/meta.json', meta({ title: 'Points', status: 'published', layer: { ...LAYER, geometry: 'point' } }))

  // published, line geometry (P7-3) — a GeoJSON file, whose `_path` column the
  // tabular parser writes, with the same allow-listed properties a point gets.
  fake.seed(
    'library/datasets/transmission/transmission.geojson',
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] },
          properties: { NAME: 'Allen tie', OWNER: 'TVA', secret: 'hidden' },
        },
        {
          type: 'Feature',
          geometry: { type: 'MultiLineString', coordinates: [[[-91, 34], [-90.5, 34.5]], [[-88, 36.4], [-87.6, 36.2]]] },
          properties: { NAME: 'Nucor spur', OWNER: 'MLGW', secret: 'hidden' },
        },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-90, 35] }, properties: { NAME: 'Substation', OWNER: 'TVA', secret: 'hidden' } },
      ],
    }),
  )
  fake.seed(
    'library/datasets/transmission/meta.json',
    meta({
      title: 'Transmission lines',
      status: 'published',
      layer: { geometry: 'line', file: 'transmission.geojson', pathKey: '_path', labelKey: 'NAME', popupFields: ['OWNER'], color: '#2B6CB0', width: 3, name: 'Transmission lines', description: 'Lines carrying load', source: 'HIFLD', year: 2026 },
    }),
  )
  // published, line block with no path column named → invalid, skipped
  fake.seed('library/datasets/lines-bad/lines.csv', 'NAME,geom\nA,"LINESTRING (-90 35, -89 36)"\n')
  fake.seed('library/datasets/lines-bad/meta.json', meta({ title: 'Lines (bad)', status: 'published', layer: { geometry: 'line', labelKey: 'NAME', name: 'Lines (bad)' } }))

  // published, state geometry (P7-9) — one row per state in three spellings,
  // a short fact and a paragraph, and no labelKey because a state has a name.
  fake.seed(
    'library/datasets/permits/permits.csv',
    'State,Authority,Process,secret\n' +
      'GA,Georgia EPD,"Apply to EPD.\n\nThen a hearing.",hidden\n' +
      'Tennessee,TDEC,Apply to TDEC.,hidden\n' +
      '28,MDEQ,Apply to MDEQ.,hidden\n' +
      'Freedonia,Nobody,Not a state.,hidden\n',
  )
  fake.seed(
    'library/datasets/permits/meta.json',
    meta({
      title: 'Permitting by state',
      status: 'published',
      layer: { geometry: 'state', file: 'permits.csv', stateKey: 'State', popupFields: ['Authority'], detailFields: ['Process'], color: '#2F855A', name: 'Permitting by state', description: 'Who issues the permit', source: 'BLO research', year: 2026 },
    }),
  )
  // published, state block with no state column named → invalid, skipped
  fake.seed('library/datasets/states-bad/states.csv', 'ST,v\nGA,1\n')
  fake.seed('library/datasets/states-bad/meta.json', meta({ title: 'States (bad)', status: 'published', layer: { geometry: 'state', name: 'States (bad)' } }))
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.97.0.${++loginIp}`)
    .send({ username: 'maria', password: 'layers-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

async function ready(): Promise<{ cookie: string; csrf: string }> {
  const auth = await login()
  const res = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  expect(res.status).toBe(200)
  return auth
}

describe('auth boundary', () => {
  it('manifest and values bare-401 without a session', async () => {
    for (const path of ['/api/layers/internal', '/api/layers/internal/target-index']) {
      const res = await request(app).get(path)
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
  })
})

describe('GET /api/layers/internal (manifest)', () => {
  it('lists only published datasets with a valid county layer block, skipping invalid ones with a log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.layers.map((l: any) => l.slug)).toEqual(['orgs-hq', 'orgs-nowhere', 'permits', 'target-index', 'transmission', 'two-files'])
    const target = res.body.layers.find((l: any) => l.slug === 'target-index')
    expect(target).toMatchObject({
      id: 'internal-target-index',
      geometry: 'county',
      name: 'Target index',
      dataType: 'index',
      unit: '',
      direction: 'higher_better',
      range: null,
      description: 'Where the plan should look first.',
      source: 'BLO internal',
      year: 2026,
      file: null,
    })
    const pts = res.body.layers.find((l: any) => l.slug === 'orgs-hq')
    expect(pts).toMatchObject({ id: 'internal-orgs-hq', geometry: 'point', name: 'Organizations (HQ)', color: '#ff6b1c', popupFields: ['Tier', 'HQ City'], range: null })
    expect(JSON.stringify(res.body)).not.toContain('hidden')
    const two = res.body.layers.find((l: any) => l.slug === 'two-files')
    expect(two).toMatchObject({ id: 'internal-two-files', dataType: 'percentage', unit: '%', direction: 'lower_better', range: { min: 0, max: 100 }, file: 'values.csv' })
    // never leaks the data or the geoKey/valueKey plumbing
    expect(JSON.stringify(res.body)).not.toContain('Autauga')
    expect(target.values).toBeUndefined()
    expect(warn.mock.calls.some(c => String(c[0]).includes('bad-block'))).toBe(true)
    expect(warn.mock.calls.some(c => String(c[0]).includes('points'))).toBe(true)
    warn.mockRestore()
  })

  // P6-1: the datasets browser lists internal layers beside everything else,
  // grouped by publisher — so the row has to say who published it, read off
  // the DATASET's manifest rather than the layer block's prose.
  it('says who published each layer, from the dataset’s manifest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.seed('library/datasets/epa-sites/data.csv', TARGET_CSV)
    fake.seed(
      'library/datasets/epa-sites/meta.json',
      meta({ title: 'EPA sites', status: 'published', source: { provider: 'US EPA' }, layer: { ...LAYER, name: 'EPA sites' } }),
    )
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const bySlug = (slug: string) => res.body.layers.find((l: any) => l.slug === slug)
    expect(bySlug('epa-sites')).toMatchObject({ organization: 'epa', organizationLabel: 'US EPA' })
    // A dataset whose manifest names nobody says so rather than guessing from
    // the layer block's own source line.
    expect(bySlug('target-index')).toMatchObject({ organization: '', organizationLabel: '', source: 'BLO internal' })
    warn.mockRestore()
  })

  // P5-77: "Show on map" reads the frame off the manifest, so the map opens on
  // the layer's own points instead of animating there a beat later.
  it('carries each point layer\'s bbox, null when no row has coordinates and null for county layers', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const bySlug = (slug: string) => res.body.layers.find((l: any) => l.slug === slug)
    expect(bySlug('orgs-hq').bbox).toEqual([-73.99, 40.73, -73.99, 40.73])
    expect(bySlug('orgs-nowhere').bbox).toBeNull()
    expect(bySlug('target-index').bbox).toBeNull()
  })

  // P7-3's second acceptance criterion: all three geometries in one manifest,
  // each carrying what its own geometry needs and nothing it does not.
  it('lists county, point and line layers together, each with its own fields', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const bySlug = (slug: string) => res.body.layers.find((l: any) => l.slug === slug)
    expect(bySlug('target-index')).toMatchObject({ geometry: 'county', color: null, popupFields: [], width: null, bbox: null })
    expect(bySlug('orgs-hq')).toMatchObject({ geometry: 'point', color: '#ff6b1c', popupFields: ['Tier', 'HQ City'], width: null })
    expect(bySlug('transmission')).toMatchObject({
      geometry: 'line',
      name: 'Transmission lines',
      color: '#2b6cb0',
      popupFields: ['OWNER'],
      width: 3,
      // The frame is the union of every vertex, so "Show on map" opens on the
      // whole corridor rather than on one end of it.
      bbox: [-91, 34, -87.6, 36.4],
    })
    // A line block that names no path column is skipped like any other
    // invalid block — it never reaches the map half-built.
    // (the message naming `pathKey` is asserted in the validator's own
    // tests; the skip is logged once per process, so a spy installed by a
    // later test in this file sees nothing.)
    expect(bySlug('lines-bad')).toBeUndefined()
    // P7-9: and a state layer beside them, with its own two fields.
    expect(bySlug('permits')).toMatchObject({
      geometry: 'state',
      name: 'Permitting by state',
      color: '#2f855a',
      popupFields: ['Authority'],
      detailFields: ['Process'],
      width: null,
      // Null and not for want of trying: the outlines are the client's, and
      // "state by state" opens on the national view anyway.
      bbox: null,
    })
    expect(bySlug('states-bad')).toBeUndefined()
    warn.mockRestore()
  })

  it('reframes a point layer after an external push + reindex', async () => {
    const auth = await ready()
    await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    fake.seed(
      'library/datasets/orgs-hq/organizations.csv',
      'Organization,Tier,HQ City,secret,lat,lng\nBlack Farmer Fund,Tier 1,New York,hidden,40.73,-73.99\nTruly Living Well,Tier 2,Atlanta,hidden,33.75,-84.42\n',
    )
    await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    const res = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(res.body.layers.find((l: any) => l.slug === 'orgs-hq').bbox).toEqual([-84.42, 33.75, -73.99, 40.73])
  })
})

describe('GET /api/layers/internal/:slug (values)', () => {
  it('projects the file to zero-padded GEOID → number, skipping bad rows, with a computed range', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal/target-index').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: 'internal-target-index',
      slug: 'target-index',
      geometry: 'county',
      values: { '01001': 12.5, '01003': 1200, '01005': 7 },
      count: 3,
      range: { min: 7, max: 1200 },
    })
  })

  it('honours layer.file, custom keys, and a declared range', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal/two-files').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.values).toEqual({ '01001': 55, '01003': 45 })
    expect(res.body.range).toEqual({ min: 0, max: 100 })
  })

  it('404s identically for unknown, unpublished, blockless, and invalid-block slugs', async () => {
    const auth = await ready()
    for (const slug of ['nope', 'draft', 'no-block', 'bad-block', 'points']) {
      const res = await request(app).get(`/api/layers/internal/${slug}`).set('Cookie', auth.cookie)
      expect(res.status, slug).toBe(404)
      expect(res.body).toEqual({ error: 'not found' })
    }
  })

  it('serves a point layer as a FeatureCollection with only the label + popupFields (P5-24)', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal/orgs-hq').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', type: 'FeatureCollection', count: 1, skipped: 1, bbox: [-73.99, 40.73, -73.99, 40.73] })
    expect(res.body.features).toEqual([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-73.99, 40.73] }, properties: { _label: 'Black Farmer Fund', Tier: 'Tier 1', 'HQ City': 'New York' } },
    ])
    expect(JSON.stringify(res.body)).not.toContain('hidden')
  })

  it('serves a line layer as a FeatureCollection of LineStrings with only the label + popupFields (P7-3)', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal/transmission').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'internal-transmission',
      slug: 'transmission',
      geometry: 'line',
      type: 'FeatureCollection',
      count: 2,
      // The point in the file has no path, so it is skipped rather than drawn
      // as a zero-length line.
      skipped: 1,
      bbox: [-91, 34, -87.6, 36.4],
    })
    expect(res.body.features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] },
        properties: { _label: 'Allen tie', OWNER: 'TVA' },
      },
      {
        type: 'Feature',
        geometry: { type: 'MultiLineString', coordinates: [[[-91, 34], [-90.5, 34.5]], [[-88, 36.4], [-87.6, 36.2]]] },
        properties: { _label: 'Nucor spur', OWNER: 'MLGW' },
      },
    ])
    // The same canary the point route carries.
    expect(JSON.stringify(res.body)).not.toContain('hidden')
  })

  it('serves a state layer as UNLOCATED features — rows only, the outlines being the client\'s (P7-9)', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/layers/internal/permits').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'internal-permits',
      slug: 'permits',
      geometry: 'state',
      type: 'FeatureCollection',
      count: 3,
      // Freedonia names no state and is skipped rather than guessed at.
      skipped: 1,
      bbox: null,
    })
    // In state-name order, titled from the canonical table — no label column
    // in the file at all — and keyed by the FIPS the county GEOIDs begin with.
    expect(res.body.features).toEqual([
      { type: 'Feature', geometry: null, properties: { _state: '13', _label: 'Georgia', Authority: 'Georgia EPD', Process: 'Apply to EPD.\n\nThen a hearing.' } },
      { type: 'Feature', geometry: null, properties: { _state: '28', _label: 'Mississippi', Authority: 'MDEQ', Process: 'Apply to MDEQ.' } },
      { type: 'Feature', geometry: null, properties: { _state: '47', _label: 'Tennessee', Authority: 'TDEC', Process: 'Apply to TDEC.' } },
    ])
    // The same canary the point and line routes carry.
    expect(JSON.stringify(res.body)).not.toContain('hidden')
  })

  it('415s when the block names a column the file lacks', async () => {
    const auth = await ready()
    fake.seed('library/datasets/target-index/meta.json', meta({ title: 'Target index', status: 'published', layer: { ...LAYER, valueKey: 'missing' } }))
    await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    const res = await request(app).get('/api/layers/internal/target-index').set('Cookie', auth.cookie)
    expect(res.status).toBe(415)
    expect(res.body.error).toMatch(/missing/)
  })

  it('serves new values after an external push + reindex', async () => {
    const auth = await ready()
    fake.seed('library/datasets/target-index/data.csv', TARGET_CSV + '01009,99,Blount\n')
    await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    const res = await request(app).get('/api/layers/internal/target-index').set('Cookie', auth.cookie)
    expect(res.body.values['01009']).toBe(99)
    expect(res.body.count).toBe(4)
  })
})

/**
 * P5-88. The manifest is fetched on every page that can show a layer (and,
 * before P5-89, twice on the layers page). It changes only when a dataset is
 * published or its block is edited, so an unchanged one should cost a 304.
 */
describe('conditional requests (P5-88)', () => {
  it('sends Cache-Control: private, no-cache and an ETag, and 304s an unchanged manifest', async () => {
    const auth = await ready()
    const first = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('private, no-cache')
    expect(first.headers.etag).toBeTruthy()

    const again = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie).set('If-None-Match', first.headers.etag)
    expect(again.status).toBe(304)
    expect(again.text).toBeFalsy()
    expect(again.headers['cache-control']).toBe('private, no-cache')
  })

  it('gives a new ETag once a layer is published, so the map never revalidates a stale manifest into place', async () => {
    const auth = await ready()
    const before = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    const beforeIds = before.body.layers.map((l: any) => l.id)

    fake.seed('library/datasets/newly-published/data.csv', TARGET_CSV)
    fake.seed('library/datasets/newly-published/meta.json', meta({ title: 'Newly published', status: 'published', layer: LAYER }))
    await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)

    const after = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie).set('If-None-Match', before.headers.etag)
    expect(after.status).toBe(200)
    expect(after.headers.etag).not.toBe(before.headers.etag)
    expect(after.body.layers.map((l: any) => l.id)).not.toEqual(beforeIds)
  })
})

// --- P7-8: a composite index is a layer, over the same two routes ------------

describe('a derived index as a layer', () => {
  /** The set's manifest, written the way `putDerivedColumns` writes it — one
   *  composite column and one proximity column, so the manifest's rule (a
   *  composite is a layer, a measurement is not) is tested on both. */
  const SET_META = {
    title: 'Political efficacy',
    category: 'working-sets',
    status: 'published',
    tags: [],
    purpose: 'Where engagement is strongest',
    datasets: ['target-index'],
    layers: ['internal-target-index'],
    sites: null,
    savedBy: 'maria',
    savedById: 1,
    savedAt: '2026-10-06T00:00:00.000Z',
    derived: [
      {
        id: 'efficacy',
        label: 'Political efficacy',
        unit: 'index',
        method: 'Weighted index of 2 county layers…',
        computedAt: '2026-10-06T12:00:00.000Z',
        values: { '01001': 100, '01003': 42.5, '1005': 0 },
        analysis: {
          type: 'composite',
          terms: [
            { layer: 'internal-target-index', weight: 6, direction: 'higher_better' },
            { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
          ],
          columns: ['efficacy'],
          by: 'maria',
          at: '2026-10-06T12:00:00.000Z',
        },
      },
      {
        id: 'miles-to-lines',
        label: 'Miles to nearest Lines',
        unit: 'miles',
        method: 'Great-circle miles…',
        computedAt: '2026-10-06T12:00:00.000Z',
        values: { '01001': 2.4 },
        analysis: {
          type: 'proximity',
          from: 'sites',
          to: 'internal-lines',
          within: null,
          columns: ['miles-to-lines'],
          by: 'maria',
          at: '2026-10-06T12:00:00.000Z',
        },
      },
    ],
  }

  async function seedSet(): Promise<{ cookie: string; csrf: string }> {
    fake.seed('library/working-sets/efficacy/meta.json', JSON.stringify(SET_META, null, 2))
    return ready()
  }

  it('lists the composite in the manifest and leaves the measurement out', async () => {
    const auth = await seedSet()
    const res = await request(app).get('/api/layers/internal').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const ids = res.body.layers.map((l: any) => l.id)
    expect(ids).toContain('internal-efficacy~efficacy')
    // Nothing in a proximity record says which end of "miles away" is good, so
    // it is not offered as a layer (P6-19's rule, applied).
    expect(ids).not.toContain('internal-efficacy~miles-to-lines')

    const layer = res.body.layers.find((l: any) => l.id === 'internal-efficacy~efficacy')
    expect(layer).toMatchObject({
      slug: 'efficacy~efficacy',
      geometry: 'county',
      name: 'Political efficacy',
      dataType: 'index',
      direction: 'higher_better',
      range: { min: 0, max: 100 },
      source: 'Derived from Political efficacy',
      file: null,
      bbox: null,
    })
  })

  it('serves its stored values, with the `~` surviving the URL', async () => {
    const auth = await seedSet()
    const res = await request(app)
      .get(`/api/layers/internal/${encodeURIComponent('efficacy~efficacy')}`)
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'internal-efficacy~efficacy',
      slug: 'efficacy~efficacy',
      geometry: 'county',
      count: 3,
      // Declared, so two sets' indices are drawn on one scale.
      range: { min: 0, max: 100 },
    })
    // The same GEOID forgiveness every county layer gets.
    expect(res.body.values).toEqual({ '01001': 100, '01003': 42.5, '01005': 0 })
  })

  it('404s a measurement, an unknown column and an unknown set identically', async () => {
    const auth = await seedSet()
    for (const slug of ['efficacy~miles-to-lines', 'efficacy~nope', 'nope~efficacy', 'target-index~x']) {
      const res = await request(app).get(`/api/layers/internal/${encodeURIComponent(slug)}`).set('Cookie', auth.cookie)
      expect(res.status, slug).toBe(404)
      expect(res.body, slug).toEqual({ error: 'not found' })
    }
  })

  it('bare-401s without a session, like every other layer route', async () => {
    const res = await request(app).get(`/api/layers/internal/${encodeURIComponent('efficacy~efficacy')}`)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})
