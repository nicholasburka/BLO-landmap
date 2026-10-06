import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
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
 * P5-16: saved data views. A view is a flat JSON snapshot of map+query state
 * (library/views/<slug>.json) indexed into library_catalog as kind 'view'.
 * The server slugifies the user's view name (collisions auto-suffix -2/-3…),
 * stamps savedBy/savedAt, and stores the document verbatim otherwise.
 * Runs against the real createApp() (auth guard, CSRF, audit wiring).
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { clearTabularCache } = await import('../services/libraryTabular.js')

let passwordHash: string
beforeAll(async () => {
  // Cheap argon2 params: per-test logins at production cost starve parallel
  // vitest workers (see libraryCatalog.test.ts). Verify cost is embedded in
  // the hash, so production wiring is unaffected.
  passwordHash = await argon2.hash('views-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

beforeEach(async () => {
  // Parsed datasets are module state; a table view validated against a stale
  // parse would pass on columns the file no longer has.
  clearTabularCache()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-views-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// Unique X-Forwarded-For per login keeps each test inside its own
// login-rate-limit bucket (10/hr/IP; app trusts one proxy hop).
let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.99.0.${++loginIp}`)
    .send({ username: 'maria', password: 'views-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

/** A realistic Example-6 snapshot: layers+weights, filters, prompt, viewport. */
const SAMPLE_STATE = {
  layers: [
    { layerId: 'combined_scores_v2', weight: 1, direction: 'high' },
    { layerId: 'median_home_value', weight: 0.5, direction: 'low' },
  ],
  filters: [{ layerId: 'pct_black_population', op: '>=', value: 20 }],
  limit: 20,
  regionStates: ['TN'],
  prompt: 'top 20 counties by land value + Black population share',
  viewport: { center: [-86.7, 35.8], zoom: 6.5 },
}

const SAMPLE_RESULTS = [
  { geoid: '47157', name: 'Shelby County', state: 'TN', score: 91.2 },
  { geoid: '47037', name: 'Davidson County', state: 'TN', score: 88.7 },
]

function postView(
  auth: { cookie: string; csrf: string },
  body: Record<string, unknown>,
) {
  return request(app)
    .post('/api/views')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send(body)
}

async function reindex(auth: { cookie: string; csrf: string }) {
  return request(app)
    .post('/api/library/reindex')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
}

describe('auth boundary', () => {
  it('list, read, and create all bare-401 without a session', async () => {
    for (const req of [
      request(app).get('/api/views'),
      request(app).get('/api/views/tn-target-counties'),
      request(app).post('/api/views').send({ name: 'X', state: {}, results: [] }),
    ]) {
      const res = await req
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
  })

  it('POST without a CSRF token is refused', async () => {
    const { cookie } = await login()
    const res = await request(app)
      .post('/api/views')
      .set('Cookie', cookie)
      .send({ name: 'X', state: SAMPLE_STATE, results: [] })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/views', () => {
  it('creates a view: bucket JSON, 201 with the slug, and a catalog row', async () => {
    const auth = await login()
    const res = await postView(auth, {
      name: 'TN target counties',
      state: SAMPLE_STATE,
      results: SAMPLE_RESULTS,
    })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ slug: 'tn-target-counties', name: 'TN target counties' })

    // Bucket is truth: the snapshot landed as a flat JSON file with
    // server-stamped attribution.
    const raw = fake.objects.get('library/views/tn-target-counties.json')
    expect(raw).toBeDefined()
    const doc = JSON.parse(raw!.toString('utf8'))
    expect(doc).toMatchObject({
      name: 'TN target counties',
      savedBy: 'maria',
      state: SAMPLE_STATE,
      results: SAMPLE_RESULTS,
    })
    expect(new Date(doc.savedAt).getTime()).toBeGreaterThan(0)

    // Indexed for listing via the existing catalog API.
    const list = await request(app)
      .get('/api/library/catalog?kind=view')
      .set('Cookie', auth.cookie)
    expect(list.status).toBe(200)
    expect(list.body.entries).toHaveLength(1)
    expect(list.body.entries[0]).toMatchObject({
      slug: 'tn-target-counties',
      kind: 'view',
      title: 'TN target counties',
    })
    expect(list.body.entries[0].meta).toMatchObject({ savedBy: 'maria', resultCount: 2 })
  })

  it('records the layers a view uses (scoring + point) in its catalog meta (P5-37)', async () => {
    const auth = await login()
    const res = await request(app)
      .post('/api/views')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({
        name: 'Layer users',
        state: { layers: [{ layerId: 'pct_Black', weight: 5 }, { layerId: 'internal-target-index', weight: 3 }], pointLayers: [{ id: 'internal-orgs', name: 'Orgs' }], filters: [], limit: null, regionStates: [], prompt: '', viewport: null },
        results: [],
      })
    expect(res.status).toBe(201)
    const list = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    const row = list.body.entries.find((e: any) => e.slug === 'layer-users')
    expect(row.meta.layers).toEqual(['pct_Black', 'internal-target-index', 'internal-orgs'])
    // survives a reindex from the bucket document alone
    await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    const again = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    expect(again.body.entries.find((e: any) => e.slug === 'layer-users').meta.layers).toEqual(['pct_Black', 'internal-target-index', 'internal-orgs'])
  })

  it('auto-suffixes -2 when the name collides with an existing slug', async () => {
    const auth = await login()
    await postView(auth, { name: 'TN target counties', state: SAMPLE_STATE, results: [] })
    const res = await postView(auth, { name: 'TN Target Counties!', state: SAMPLE_STATE, results: [] })
    expect(res.status).toBe(201)
    expect(res.body.slug).toBe('tn-target-counties-2')
  })

  it('audits view.create attributed to the saver', async () => {
    const auth = await login()
    await postView(auth, { name: 'TN target counties', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    const audit = await libraryQuery(
      `SELECT actor, action, target FROM library_audit WHERE action = 'view.create'`,
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].actor).toBe('maria')
    expect(audit.rows[0].target).toBe('tn-target-counties')
  })

  it.each([
    [{ state: SAMPLE_STATE, results: [] }, /name/i],
    [{ name: '   ', state: SAMPLE_STATE, results: [] }, /name/i],
    [{ name: '§§§', state: SAMPLE_STATE, results: [] }, /name/i],
    [{ name: 'ok', results: [] }, /state/i],
    [{ name: 'ok', state: 'not-an-object', results: [] }, /state/i],
    [{ name: 'ok', state: SAMPLE_STATE }, /results/i],
    [{ name: 'ok', state: SAMPLE_STATE, results: 'nope' }, /results/i],
  ])('rejects invalid body %j with a 400', async (body, message) => {
    const auth = await login()
    const res = await postView(auth, body as Record<string, unknown>)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(message)
    expect(fake.objects.size).toBe(0)
  })

  it('rejects more than 100 result rows with a 400 naming the cap', async () => {
    const auth = await login()
    const results = Array.from({ length: 101 }, (_, i) => ({ geoid: String(i), score: i }))
    const res = await postView(auth, { name: 'big', state: SAMPLE_STATE, results })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/100/)
    expect(fake.objects.size).toBe(0)
  })
})

describe('GET /api/views (list)', () => {
  it('returns summaries newest-first without the heavy state/results payload', async () => {
    const auth = await login()
    await postView(auth, { name: 'First view', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    await postView(auth, { name: 'Second view', state: SAMPLE_STATE, results: [] })

    const res = await request(app).get('/api/views').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.views).toHaveLength(2)
    expect(res.body.views.map((v: any) => v.slug)).toEqual(['second-view', 'first-view'])
    expect(res.body.views[1]).toMatchObject({
      slug: 'first-view',
      name: 'First view',
      savedBy: 'maria',
      resultCount: 2,
    })
    expect(typeof res.body.views[1].savedAt).toBe('string')
    expect(res.body.views[1].state).toBeUndefined()
    expect(res.body.views[1].results).toBeUndefined()
  })
})

describe('GET /api/views/:slug', () => {
  it('returns the full snapshot document', async () => {
    const auth = await login()
    await postView(auth, { name: 'TN target counties', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    const res = await request(app).get('/api/views/tn-target-counties').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      slug: 'tn-target-counties',
      name: 'TN target counties',
      savedBy: 'maria',
      state: SAMPLE_STATE,
      results: SAMPLE_RESULTS,
    })
  })

  it('404s (bare) on an unknown view', async () => {
    const auth = await login()
    const res = await request(app).get('/api/views/nope').set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })

  it('404s when the slug belongs to a different catalog kind', async () => {
    const auth = await login()
    // A wiki page occupies the slug (slugs are globally unique in the catalog).
    await request(app)
      .put('/api/wiki/tn-strategy')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .set('Content-Type', 'text/markdown')
      .send('# TN Strategy')
    const res = await request(app).get('/api/views/tn-strategy').set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
  })
})

describe('reindex integration (files are the truth)', () => {
  it('rebuilds view rows from the bucket alone, including external pushes', async () => {
    const auth = await login()
    await postView(auth, { name: 'TN target counties', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    // A dev pushes a view from the CLI: bucket only, no catalog row yet.
    fake.seed(
      'library/views/pushed-view.json',
      JSON.stringify({
        name: 'Pushed View',
        savedBy: 'devon',
        savedAt: '2026-09-01T12:00:00.000Z',
        state: { layers: [] },
        results: [{ geoid: '01001', score: 1 }],
      }),
    )

    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app)
      .get('/api/library/catalog?kind=view')
      .set('Cookie', auth.cookie)
    expect(list.body.entries.map((e: any) => [e.slug, e.title]).sort()).toEqual([
      ['pushed-view', 'Pushed View'],
      ['tn-target-counties', 'TN target counties'],
    ])
    const pushed = list.body.entries.find((e: any) => e.slug === 'pushed-view')
    expect(pushed.meta).toMatchObject({ savedBy: 'devon', resultCount: 1 })

    // And the snapshot is servable (external push readable without a POST).
    const read = await request(app).get('/api/views/pushed-view').set('Cookie', auth.cookie)
    expect(read.status).toBe(200)
    expect(read.body.results).toHaveLength(1)
  })

  it('drops view rows whose files vanished from the bucket', async () => {
    const auth = await login()
    await postView(auth, { name: 'TN target counties', state: SAMPLE_STATE, results: [] })
    fake.objects.delete('library/views/tn-target-counties.json')
    await reindex(auth)
    const res = await request(app)
      .get('/api/views/tn-target-counties')
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
  })

  it('indexes a malformed view JSON with slug-fallback title instead of crashing', async () => {
    const auth = await login()
    fake.seed('library/views/broken-view.json', 'not json {{{')
    fake.seed('library/views/.DS_Store', 'junk')
    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app)
      .get('/api/library/catalog?kind=view')
      .set('Cookie', auth.cookie)
    expect(list.body.entries.map((e: any) => e.slug)).toEqual(['broken-view'])
    expect(list.body.entries[0].title).toBe('broken-view')
  })
})


/**
 * P5-54: saved TABLE views. The same document and the same route, with
 * `type: 'table'` and a state that names a dataset instead of the map. The
 * state is no longer opaque for these: it is validated with the rows route's
 * own parser against the columns the dataset really has, so a view that would
 * 400 on open cannot be saved in the first place.
 */
const ORGS_CSV =
  'Organization,Tier,HQ State,Score,Joined\n' +
  'Black Farmer Fund,Tier 1,NY,90,2023-04-02\n' +
  'Southwest Georgia Project,Tier 1,GA,75,2023-11-20\n' +
  'Truly Living Well,Tier 2,GA,60,2024-01-15\n'

/** The saved state the explorer sends: dataset + exactly the table's URL. */
const TABLE_STATE = {
  dataset: 'orgs',
  file: 'organizations.csv',
  filters: [{ column: 'HQ State', op: 'eq', value: 'Georgia' }],
  sort: 'Score',
  dir: 'desc',
  columns: ['Organization', 'Tier', 'HQ State'],
  layers: ['median_home_value'],
  summary: { column: 'Tier', chart: 'bars' },
  savedRowCount: 13,
}

async function seedOrgs(auth: { cookie: string; csrf: string }): Promise<void> {
  fake.seed('library/datasets/orgs/organizations.csv', ORGS_CSV)
  fake.seed('library/datasets/orgs/regions.csv', 'region,count\nSouth,2\n')
  fake.seed(
    'library/datasets/orgs/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'network', status: 'published' }),
  )
  expect((await reindex(auth)).status).toBe(200)
}

function viewFiles(): string[] {
  return [...fake.objects.keys()].filter(k => k.startsWith('library/views/'))
}

describe('POST /api/views — table views (P5-54)', () => {
  it('saves the table state, stamps the dataset title, and describes it in one line', async () => {
    const auth = await login()
    await seedOrgs(auth)
    const res = await postView(auth, { name: 'Georgia orgs', type: 'table', state: TABLE_STATE, results: [] })
    expect(res.status).toBe(201)
    expect(res.body.slug).toBe('georgia-orgs')

    const doc = JSON.parse(fake.objects.get('library/views/georgia-orgs.json')!.toString('utf8'))
    expect(doc.type).toBe('table')
    expect(doc.savedBy).toBe('maria')
    expect(doc.state).toEqual({
      ...TABLE_STATE,
      // stamped server-side so a reindex can describe the view from the file
      datasetTitle: 'Organizations',
    })

    const list = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    expect(list.body.entries[0].meta).toMatchObject({
      type: 'table',
      dataset: 'orgs',
      description: 'Organizations · HQ State is Georgia · chart of Tier · 13 rows',
    })
  })

  it('reads out a search, a group-by, and extra filters in plain words', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, {
      name: 'Counted',
      type: 'table',
      state: {
        dataset: 'orgs',
        q: 'farm',
        filters: [
          { column: 'Tier', op: 'eq', value: 'Tier 1' },
          { column: 'Score', op: 'gte', value: '60' },
          { column: 'HQ State', op: 'notEmpty' },
          { column: 'Organization', op: 'contains', value: 'a' },
        ],
        summary: { groupBy: 'Tier' },
        savedRowCount: 2,
      },
      results: [],
    })
    const list = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    expect(list.body.entries[0].meta.description).toBe(
      'Organizations · search “farm” · Tier is Tier 1 · Score at least 60 · HQ State has a value · +1 more filters · counted by Tier · 2 rows',
    )
  })

  it('records the county-context layers a table view carries (P5-48 join)', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, { name: 'Joined', type: 'table', state: TABLE_STATE, results: [] })
    const list = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    expect(list.body.entries[0].meta.layers).toEqual(['median_home_value'])
  })

  it.each([
    [{ dataset: 'orgs', filters: [{ column: 'Nope', op: 'eq', value: 'x' }] }, /unknown column: Nope/],
    [{ dataset: 'orgs', filters: [], sort: 'Nope' }, /unknown column: Nope/],
    [{ dataset: 'orgs', filters: [], dir: 'sideways' }, /dir must be/],
    [{ dataset: 'orgs', filters: [], columns: ['Tier', 'Nope'] }, /unknown column: Nope/],
    [{ dataset: 'orgs', filters: [], summary: { column: 'Nope', chart: 'bars' } }, /unknown column: Nope/],
    [{ dataset: 'orgs', filters: [], summary: { column: 'Tier', chart: 'pie' } }, /chart/i],
    [{ dataset: 'orgs', filters: [], summary: { groupBy: 'Nope' } }, /unknown column: Nope/],
    [{ dataset: 'orgs', filters: [], savedRowCount: -1 }, /savedRowCount/],
    [{ dataset: 'orgs', filters: [], layers: [{ id: 'x' }] }, /layers/],
    [{ dataset: 'orgs', filters: [], file: 'not-a-file.csv' }, /file not found/],
    [{ dataset: 'no-such-dataset', filters: [] }, /not found/],
    [{ filters: [] }, /dataset/],
  ])('refuses a table view whose state would not open: %j', async (state, message) => {
    const auth = await login()
    await seedOrgs(auth)
    const res = await postView(auth, { name: 'Bad view', type: 'table', state, results: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(message)
    expect(viewFiles()).toEqual([])
  })

  it('refuses an unknown view type', async () => {
    const auth = await login()
    const res = await postView(auth, { name: 'Weird', type: 'chart', state: SAMPLE_STATE, results: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/type/)
    expect(viewFiles()).toEqual([])
  })

  it('leaves map views exactly as they were: no type sent, no validation, opaque state', async () => {
    const auth = await login()
    const res = await postView(auth, { name: 'Map still works', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    expect(res.status).toBe(201)
    const doc = JSON.parse(fake.objects.get('library/views/map-still-works.json')!.toString('utf8'))
    expect(doc.type).toBe('map')
    expect(doc.state).toEqual(SAMPLE_STATE)
  })
})

describe('GET /api/views — types and the per-dataset strip (P5-54)', () => {
  it('lists both kinds with their type, dataset, and description', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, { name: 'Map one', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    await postView(auth, { name: 'Table one', type: 'table', state: TABLE_STATE, results: [] })

    const res = await request(app).get('/api/views').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const byName = Object.fromEntries(res.body.views.map((v: any) => [v.name, v]))
    expect(byName['Map one']).toMatchObject({ type: 'map', dataset: '', resultCount: 2 })
    expect(byName['Map one'].description).toMatch(/^Map view/)
    expect(byName['Table one']).toMatchObject({ type: 'table', dataset: 'orgs' })
    expect(byName['Table one'].description).toContain('Organizations')
  })

  it('?dataset= narrows the list to that table\'s saved views', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, { name: 'Map one', state: SAMPLE_STATE, results: [] })
    await postView(auth, { name: 'Table one', type: 'table', state: TABLE_STATE, results: [] })
    await postView(auth, { name: 'Other file', type: 'table', state: { dataset: 'orgs', file: 'regions.csv', filters: [], savedRowCount: 1 }, results: [] })

    const res = await request(app).get('/api/views?dataset=orgs').set('Cookie', auth.cookie)
    expect(res.body.views.map((v: any) => v.slug).sort()).toEqual(['other-file', 'table-one'])
    const none = await request(app).get('/api/views?dataset=nothing-here').set('Cookie', auth.cookie)
    expect(none.body.views).toEqual([])
  })
})

describe('GET /api/views/:slug — table views (P5-54)', () => {
  it('returns the type, the state to restore, and the one-line description', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, { name: 'Georgia orgs', type: 'table', state: TABLE_STATE, results: [] })
    const res = await request(app).get('/api/views/georgia-orgs').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      slug: 'georgia-orgs',
      type: 'table',
      description: 'Organizations · HQ State is Georgia · chart of Tier · 13 rows',
    })
    expect(res.body.state.dataset).toBe('orgs')
    expect(res.body.state.summary).toEqual({ column: 'Tier', chart: 'bars' })
  })

  it('a document written before P5-54 reads as a map view', async () => {
    const auth = await login()
    fake.seed(
      'library/views/old-view.json',
      JSON.stringify({
        name: 'Old View',
        savedBy: 'devon',
        savedAt: '2026-09-01T12:00:00.000Z',
        state: { layers: [], prompt: 'where is cheap land' },
        results: [{ geoid: '01001', score: 1 }],
      }),
    )
    expect((await reindex(auth)).status).toBe(200)
    const res = await request(app).get('/api/views/old-view').set('Cookie', auth.cookie)
    expect(res.body.type).toBe('map')
    const list = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    expect(list.body.entries[0].meta).toMatchObject({
      type: 'map',
      dataset: '',
      description: 'Map view · where is cheap land · 1 county',
    })
  })

  it('rebuilds a table view row from the bucket alone', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, { name: 'Georgia orgs', type: 'table', state: TABLE_STATE, results: [] })
    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app).get('/api/views?dataset=orgs').set('Cookie', auth.cookie)
    expect(list.body.views).toHaveLength(1)
    expect(list.body.views[0]).toMatchObject({
      slug: 'georgia-orgs',
      type: 'table',
      dataset: 'orgs',
      description: 'Organizations · HQ State is Georgia · chart of Tier · 13 rows',
    })
  })
})


/**
 * P5-55: saved COMPARE views. The same document and the same route, with
 * `type: 'compare'` and a state that names counties and layers instead of a
 * dataset. Like a table view it is a recipe — the page re-reads today's
 * numbers when it opens — so what is validated here is that the two
 * vocabularies still resolve: five-digit GEOIDs, and layer ids that exist
 * (public ones from the generated registry export, internal ones from the
 * live layer manifest).
 */
const COMPARE_STATE = {
  counties: ['47157', '28033', '13121'],
  layers: ['combined_scores_v2', 'median_home_value', 'life_expectancy', 'pct_Black'],
  notes: { '47157': 'Closest to the river port.' },
}

/** An internal county layer, so `internal-<slug>` ids can be checked too. */
const INTERNAL_LAYER = {
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

async function seedInternalLayer(auth: { cookie: string; csrf: string }): Promise<void> {
  fake.seed('library/datasets/target-index/data.csv', 'GEOID,score\n47157,12.5\n28033,7\n')
  fake.seed(
    'library/datasets/target-index/meta.json',
    JSON.stringify({ title: 'Target index', category: 'land', status: 'published', layer: INTERNAL_LAYER }),
  )
  expect((await reindex(auth)).status).toBe(200)
}

describe('POST /api/views — compare views (P5-55)', () => {
  it('saves the shortlist, its layers and its notes, and describes it in one line', async () => {
    const auth = await login()
    const res = await postView(auth, { name: 'Delta shortlist', type: 'compare', state: COMPARE_STATE, results: [] })
    expect(res.status).toBe(201)
    expect(res.body.slug).toBe('delta-shortlist')

    const doc = JSON.parse(fake.objects.get('library/views/delta-shortlist.json')!.toString('utf8'))
    expect(doc.type).toBe('compare')
    expect(doc.savedBy).toBe('maria')
    expect(doc.state).toEqual(COMPARE_STATE)

    const read = await request(app).get('/api/views/delta-shortlist').set('Cookie', auth.cookie)
    expect(read.body.description).toBe('3 counties × 4 layers')
  })

  it('accepts an internal layer id that the manifest really has', async () => {
    const auth = await login()
    await seedInternalLayer(auth)
    const res = await postView(auth, {
      name: 'With internal',
      type: 'compare',
      state: { counties: ['47157'], layers: ['median_home_value', 'internal-target-index'] },
      results: [],
    })
    expect(res.status).toBe(201)
  })

  it('rejects an internal layer id that no library entry publishes', async () => {
    const auth = await login()
    const res = await postView(auth, {
      name: 'Ghost layer',
      type: 'compare',
      state: { counties: ['47157'], layers: ['internal-not-a-thing'] },
      results: [],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown layer: internal-not-a-thing')
    expect(viewFiles()).toEqual([])
  })

  it('refuses anything that is not a county GEOID', async () => {
    const auth = await login()
    for (const counties of [['4715'], ['471577'], ['47a57'], ['']]) {
      const res = await postView(auth, { name: 'Bad geoid', type: 'compare', state: { counties, layers: ['pct_Black'] }, results: [] })
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('not a county GEOID')
    }
    expect(viewFiles()).toEqual([])
  })

  it('refuses a layer the public registry does not have', async () => {
    const auth = await login()
    const res = await postView(auth, {
      name: 'Bad layer',
      type: 'compare',
      state: { counties: ['47157'], layers: ['median_home_value', 'made_up_layer'] },
      results: [],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unknown layer: made_up_layer')
  })

  it('refuses a comparison with nothing in it, and one that is too big either way', async () => {
    const auth = await login()
    const empty = await postView(auth, { name: 'Empty', type: 'compare', state: { counties: [], layers: ['pct_Black'] }, results: [] })
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe('a comparison needs at least one county')

    const noLayers = await postView(auth, { name: 'No layers', type: 'compare', state: { counties: ['47157'], layers: [] }, results: [] })
    expect(noLayers.status).toBe(400)
    expect(noLayers.body.error).toBe('a comparison needs at least one layer')

    const tooMany = await postView(auth, {
      name: 'Too many',
      type: 'compare',
      state: { counties: Array.from({ length: 13 }, (_, i) => String(47000 + i)), layers: ['pct_Black'] },
      results: [],
    })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.error).toBe('counties: at most 12')
  })

  it('refuses a note longer than 500 characters, or one about a county that is not here', async () => {
    const auth = await login()
    const long = await postView(auth, {
      name: 'Long note',
      type: 'compare',
      state: { counties: ['47157'], layers: ['pct_Black'], notes: { '47157': 'x'.repeat(501) } },
      results: [],
    })
    expect(long.status).toBe(400)
    expect(long.body.error).toBe('notes: at most 500 characters per county')

    const orphan = await postView(auth, {
      name: 'Orphan note',
      type: 'compare',
      state: { counties: ['47157'], layers: ['pct_Black'], notes: { '13121': 'about someone else' } },
      results: [],
    })
    expect(orphan.status).toBe(400)
    expect(orphan.body.error).toBe('notes: 13121 is not one of these counties')
    expect(viewFiles()).toEqual([])
  })

  it('drops blank notes rather than storing empty strings', async () => {
    const auth = await login()
    await postView(auth, {
      name: 'Blank notes',
      type: 'compare',
      state: { counties: ['47157', '28033'], layers: ['pct_Black'], notes: { '47157': '   ', '28033': '  keep me ' } },
      results: [],
    })
    const doc = JSON.parse(fake.objects.get('library/views/blank-notes.json')!.toString('utf8'))
    expect(doc.state.notes).toEqual({ '28033': 'keep me' })
  })

  it('de-duplicates a shortlist that arrives with the same county twice', async () => {
    const auth = await login()
    await postView(auth, {
      name: 'Dupes',
      type: 'compare',
      state: { counties: ['47157', '47157', '28033'], layers: ['pct_Black', 'pct_Black'] },
      results: [],
    })
    const doc = JSON.parse(fake.objects.get('library/views/dupes.json')!.toString('utf8'))
    expect(doc.state).toEqual({ counties: ['47157', '28033'], layers: ['pct_Black'] })
  })

  it('rejects a type it has never heard of', async () => {
    const auth = await login()
    const res = await postView(auth, { name: 'Weird', type: 'chart', state: COMPARE_STATE, results: [] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('type must be one of map, table, compare')
  })
})

describe('GET /api/views?type= (P5-55)', () => {
  it('narrows the list to one kind, and matches nothing for an unknown one', async () => {
    const auth = await login()
    await seedOrgs(auth)
    await postView(auth, { name: 'Georgia orgs', type: 'table', state: TABLE_STATE, results: [] })
    await postView(auth, { name: 'Delta shortlist', type: 'compare', state: COMPARE_STATE, results: [] })
    await postView(auth, { name: 'Map one', state: SAMPLE_STATE, results: SAMPLE_RESULTS })

    const compare = await request(app).get('/api/views?type=compare').set('Cookie', auth.cookie)
    expect(compare.body.views.map((v: any) => v.name)).toEqual(['Delta shortlist'])
    expect(compare.body.views[0]).toMatchObject({ type: 'compare', dataset: '', description: '3 counties × 4 layers' })

    const maps = await request(app).get('/api/views?type=map').set('Cookie', auth.cookie)
    expect(maps.body.views.map((v: any) => v.name)).toEqual(['Map one'])

    const all = await request(app).get('/api/views').set('Cookie', auth.cookie)
    expect(all.body.views).toHaveLength(3)

    const unknown = await request(app).get('/api/views?type=chart').set('Cookie', auth.cookie)
    expect(unknown.body.views).toEqual([])
  })

  it('rebuilds a compare view row from the bucket alone', async () => {
    const auth = await login()
    await postView(auth, { name: 'Delta shortlist', type: 'compare', state: COMPARE_STATE, results: [] })
    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app).get('/api/views?type=compare').set('Cookie', auth.cookie)
    expect(list.body.views).toHaveLength(1)
    expect(list.body.views[0]).toMatchObject({
      slug: 'delta-shortlist',
      type: 'compare',
      description: '3 counties × 4 layers',
    })
  })
})

// --- P5-78: the contamination site layers a map view remembers ---------------

describe('POST /api/views — site layers on a map view (P5-78)', () => {
  it('stores the site layers, names them in the description, and counts them as layers used', async () => {
    const auth = await login()
    const res = await postView(auth, {
      name: 'Superfund over equity',
      state: { ...SAMPLE_STATE, siteLayers: ['superfund_sites', 'acres_brownfields'] },
      results: SAMPLE_RESULTS,
    })
    expect(res.status).toBe(201)
    const doc = JSON.parse(fake.objects.get('library/views/superfund-over-equity.json')!.toString('utf8'))
    expect(doc.state.siteLayers).toEqual(['superfund_sites', 'acres_brownfields'])

    const list = await request(app).get('/api/views').set('Cookie', auth.cookie)
    expect(list.body.views[0].description).toContain('Superfund Sites, Brownfields')

    const catalog = await request(app).get('/api/library/catalog?kind=view').set('Cookie', auth.cookie)
    expect(catalog.body.entries[0].meta.layers).toContain('superfund_sites')
    expect(catalog.body.entries[0].meta.layers).toContain('acres_brownfields')
  })

  it('drops an id no contamination layer has, and saves the view anyway', async () => {
    const auth = await login()
    const res = await postView(auth, {
      name: 'Half known',
      state: { ...SAMPLE_STATE, siteLayers: ['superfund_sites', 'lead_pipes', 7] },
      results: [],
    })
    expect(res.status).toBe(201)
    const doc = JSON.parse(fake.objects.get('library/views/half-known.json')!.toString('utf8'))
    expect(doc.state.siteLayers).toEqual(['superfund_sites'])
  })

  it('drops the field entirely when nothing in it is a site layer', async () => {
    const auth = await login()
    await postView(auth, { name: 'None known', state: { ...SAMPLE_STATE, siteLayers: ['lead_pipes'] }, results: [] })
    const doc = JSON.parse(fake.objects.get('library/views/none-known.json')!.toString('utf8'))
    expect(doc.state).not.toHaveProperty('siteLayers')
    expect(doc.state.layers).toEqual(SAMPLE_STATE.layers)
  })

  it('leaves a document written before P5-78 exactly as it was', async () => {
    const auth = await login()
    await postView(auth, { name: 'Older view', state: SAMPLE_STATE, results: SAMPLE_RESULTS })
    const doc = JSON.parse(fake.objects.get('library/views/older-view.json')!.toString('utf8'))
    expect(doc.state).toEqual(SAMPLE_STATE)
    const list = await request(app).get('/api/views').set('Cookie', auth.cookie)
    expect(list.body.views[0].description).toBe(
      'Map view · top 20 counties by land value + Black population share · 2 counties',
    )
  })

  it('hands the site layers back to the map, and survives a reindex from the bucket alone', async () => {
    const auth = await login()
    await postView(auth, {
      name: 'Sites restored',
      state: { ...SAMPLE_STATE, siteLayers: ['toxic_release_inventory'] },
      results: [],
    })
    const read = await request(app).get('/api/views/sites-restored').set('Cookie', auth.cookie)
    expect(read.status).toBe(200)
    expect(read.body.state.siteLayers).toEqual(['toxic_release_inventory'])
    expect(read.body.description).toContain('Toxic Release Inventory')

    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app).get('/api/views').set('Cookie', auth.cookie)
    expect(list.body.views[0].description).toContain('Toxic Release Inventory')
  })
})
