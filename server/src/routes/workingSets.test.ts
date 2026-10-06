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
 * Working sets API (P7-1), against the real `createApp()` — auth guard, CSRF,
 * audit wiring.
 *
 * What this file is judged on is the object model holding at the edge: a set
 * cannot name something the library does not have, a set holds no framing
 * however hard a caller pushes it in, a view with no set is untouched, and the
 * promote action makes exactly one set and points the view at it.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { reindexCatalog } = await import('../services/libraryCatalog.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { clearTabularCache } = await import('../services/libraryTabular.js')
const { clearAnalysisInputMemo, fingerprintOf } = await import('../services/analysisInputs.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('sets-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

const SOURCE_META = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  category: 'environment',
  source: {
    provider: 'US EPA',
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/rest/services/NPL/FeatureServer/0' }],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5 },
  },
}
const SITES_META = { title: 'Memphis candidate sites', status: 'published', category: 'land' }
const SITES_CSV = ['Name,GEOID', 'Old Rail Yard,47157'].join('\n')
const DOC_META = { title: 'A workbook PDF', status: 'published', category: 'land' }

beforeEach(async () => {
  clearTabularCache()
  clearAnalysisInputMemo()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-working-sets-route-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(SOURCE_META))
  fake.seed('library/datasets/memphis-sites/meta.json', JSON.stringify(SITES_META))
  fake.seed('library/datasets/memphis-sites/sites.csv', SITES_CSV)
  fake.seed('library/documents/the-workbook/meta.json', JSON.stringify(DOC_META))
  fake.seed('library/documents/the-workbook/book.txt', 'notes')
  await reindexCatalog()
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
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username: 'maria', password: 'sets-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function post(auth: { cookie: string; csrf: string }, path: string, body: unknown) {
  return request(app).post(path).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body as object)
}
function put(auth: { cookie: string; csrf: string }, path: string, body: unknown) {
  return request(app).put(path).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body as object)
}
function get(auth: { cookie: string; csrf: string }, path: string) {
  return request(app).get(path).set('Cookie', auth.cookie)
}

async function makeSet(auth: { cookie: string; csrf: string }, over: Record<string, unknown> = {}) {
  const res = await post(auth, '/api/working-sets', {
    name: 'Memphis redevelopment',
    purpose: 'What bears on siting',
    datasets: ['epa-superfund-npl'],
    sites: 'memphis-sites',
    ...over,
  })
  expect(res.status).toBe(201)
  return res.body.slug as string
}

describe('the working-set routes', () => {
  it('needs a session', async () => {
    expect((await request(app).get('/api/working-sets')).status).toBe(401)
    expect((await request(app).post('/api/working-sets').send({ name: 'x' })).status).toBe(401)
  })

  it('creates a set, lists it, and reads it back with its members resolved', async () => {
    const auth = await login()
    const slug = await makeSet(auth)

    const list = await get(auth, '/api/working-sets')
    expect(list.status).toBe(200)
    expect(list.body.sets).toHaveLength(1)
    expect(list.body.sets[0]).toMatchObject({
      slug,
      name: 'Memphis redevelopment',
      purpose: 'What bears on siting',
      sites: 'memphis-sites',
      derivedCount: 0,
      savedBy: 'maria',
      views: [],
    })

    const one = await get(auth, `/api/working-sets/${slug}`)
    expect(one.status).toBe(200)
    expect(one.body.members.map((m: any) => [m.slug, m.kind])).toEqual([
      ['memphis-sites', 'dataset'],
      ['epa-superfund-npl', 'source'],
    ])
    expect(one.body.missing).toEqual([])
    // The readiness verdict rides along — the progress a set tracks is the
    // attention state of its own members, not a second vocabulary.
    expect(one.body.members[1].readiness.placeReport).toBe('runs')
  })

  it('refuses a member the library does not have, naming it', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets', { name: 'Bad set', datasets: ['never-ingested'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('never-ingested')
  })

  it('refuses a member that is not a dataset or a source', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets', { name: 'Bad set', datasets: ['the-workbook'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not a dataset or a source')
  })

  it('refuses an anchor we do not hold — a pointer has no rows to anchor on', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets', { name: 'Bad anchor', sites: 'epa-superfund-npl' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('anchored on have to be a dataset we hold')
  })

  it('refuses a layer that does not exist', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets', { name: 'Bad layer', layers: ['no_such_layer'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('no layer called')
  })

  it('takes a real registry layer id', async () => {
    const auth = await login()
    const slug = await makeSet(auth, { layers: ['combined_scores_v2'] })
    const one = await get(auth, `/api/working-sets/${slug}`)
    expect(one.body.layers).toEqual(['combined_scores_v2'])
  })

  it('refuses a name with nothing in it', async () => {
    const auth = await login()
    expect((await post(auth, '/api/working-sets', { name: '  ' })).status).toBe(400)
    expect((await post(auth, '/api/working-sets', { name: '—' })).status).toBe(400)
  })

  /** §F.1's load-bearing line. Framing belongs to a view; if a viewport can
   *  get in here the two objects have collapsed into one. */
  it('stores no framing, however it is offered', async () => {
    const auth = await login()
    const slug = await makeSet(auth, {
      viewport: { center: [-90, 35], zoom: 9 },
      sort: 'distance',
      palette: 'viridis',
      filters: [{ column: 'x', op: 'eq', value: 'y' }],
      limit: 20,
      prompt: 'show me the brownfields',
    })
    const one = await get(auth, `/api/working-sets/${slug}`)
    for (const framing of ['viewport', 'sort', 'palette', 'filters', 'limit', 'prompt']) {
      expect(one.body[framing]).toBeUndefined()
    }
  })

  it('edits the fields it is given and leaves the rest', async () => {
    const auth = await login()
    const slug = await makeSet(auth)
    const res = await put(auth, `/api/working-sets/${slug}`, { purpose: 'Narrowed to Shelby County' })
    expect(res.status).toBe(200)
    expect(res.body.purpose).toBe('Narrowed to Shelby County')
    expect(res.body.datasets).toEqual(['memphis-sites', 'epa-superfund-npl'])
    expect(res.body.name).toBe('Memphis redevelopment')
  })

  it('an edit to something that is not a set is a 404, not a new set', async () => {
    const auth = await login()
    expect((await put(auth, '/api/working-sets/memphis-sites', { purpose: 'x' })).status).toBe(404)
    expect((await put(auth, '/api/working-sets/nothing-here', { purpose: 'x' })).status).toBe(404)
    expect((await get(auth, '/api/working-sets')).body.sets).toHaveLength(0)
  })

  it('records who made it', async () => {
    const auth = await login()
    const slug = await makeSet(auth)
    const { rows } = await libraryQuery(
      `SELECT actor, action, target FROM library_audit WHERE action = 'workingset.create'`,
    )
    expect(rows).toEqual([{ actor: 'maria', action: 'workingset.create', target: slug }])
  })
})

describe('a set and the views that present it', () => {
  async function saveView(auth: { cookie: string; csrf: string }, name: string, workingSet?: string) {
    const res = await post(auth, '/api/views', {
      name,
      state: { layers: [{ layerId: 'combined_scores_v2', weight: 1 }], viewport: { center: [-90, 35], zoom: 8 } },
      results: [],
      ...(workingSet ? { workingSet } : {}),
    })
    expect(res.status).toBe(201)
    return res.body.slug as string
  }

  it('carries several views, and `?workingSet=` is the list of them', async () => {
    const auth = await login()
    const slug = await makeSet(auth)
    const framed = await saveView(auth, 'Memphis cluster', slug)
    const sorted = await saveView(auth, 'Memphis by distance', slug)
    await saveView(auth, 'Something else entirely')

    const list = await get(auth, `/api/views?workingSet=${slug}`)
    expect(list.body.views.map((v: any) => v.slug).sort()).toEqual([framed, sorted].sort())

    // And the set's own row knows, without a read per document.
    const sets = await get(auth, '/api/working-sets')
    expect(sets.body.sets[0].views.map((v: any) => v.name)).toEqual(['Memphis by distance', 'Memphis cluster'])
  })

  /**
   * Spec §F.1, approved and not negotiable: no backfill. An existing view
   * keeps a null pointer and behaves exactly as it does today — ad-hoc, not
   * legacy — and shows no broken or empty working-set affordance.
   */
  it('leaves an ad-hoc view exactly as it was', async () => {
    const auth = await login()
    const adhoc = await saveView(auth, 'Just exploring')
    const doc = await get(auth, `/api/views/${adhoc}`)
    expect(doc.status).toBe(200)
    expect(doc.body.workingSet).toBeUndefined()
    expect(doc.body.state.viewport).toEqual({ center: [-90, 35], zoom: 8 })

    const list = await get(auth, '/api/views')
    expect(list.body.views.find((v: any) => v.slug === adhoc).workingSet).toBe('')
    // And it is not in any set's list of views.
    expect((await get(auth, '/api/views?workingSet=anything')).body.views).toEqual([])
  })

  it('refuses to save a view pointing at a set that does not exist', async () => {
    const auth = await login()
    const res = await post(auth, '/api/views', {
      name: 'Pointing nowhere',
      state: {},
      results: [],
      workingSet: 'no-such-set',
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('no working set called')
  })

  it('points an existing view at a set, and un-points it again', async () => {
    const auth = await login()
    const slug = await makeSet(auth)
    const adhoc = await saveView(auth, 'Just exploring')

    const pointed = await put(auth, `/api/views/${adhoc}/working-set`, { workingSet: slug })
    expect(pointed.status).toBe(200)
    expect((await get(auth, `/api/views/${adhoc}`)).body.workingSet).toBe(slug)

    const cleared = await put(auth, `/api/views/${adhoc}/working-set`, { workingSet: null })
    expect(cleared.status).toBe(200)
    expect((await get(auth, `/api/views/${adhoc}`)).body.workingSet).toBeUndefined()
  })

  it('a pointer on something that is not a view is a 404', async () => {
    const auth = await login()
    const slug = await makeSet(auth)
    expect((await put(auth, `/api/views/memphis-sites/working-set`, { workingSet: slug })).status).toBe(404)
  })
})

describe('making a working set from a view', () => {
  async function saveMapView(auth: { cookie: string; csrf: string }, name: string) {
    const res = await post(auth, '/api/views', {
      name,
      state: {
        layers: [{ layerId: 'combined_scores_v2', weight: 1 }],
        pointLayers: [{ id: 'internal-memphis-sites', name: 'Memphis candidate sites' }],
        viewport: { center: [-90, 35], zoom: 8 },
        prompt: 'brownfields near transmission',
      },
      results: [],
    })
    expect(res.status).toBe(201)
    return res.body.slug as string
  }

  it('creates the set, points the view at it, and says what it took', async () => {
    const auth = await login()
    const view = await saveMapView(auth, 'Memphis exploring')

    const res = await post(auth, `/api/working-sets/from-view/${view}`, {})
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ fromView: view, name: 'Memphis exploring' })
    // The layers the view DRAWS become the set's layers; the internal layer id
    // names a held dataset, so the set gains a real member rather than only an
    // id. Everything else the view stored is framing and stays behind.
    expect(res.body.took.layers.sort()).toEqual(['combined_scores_v2', 'internal-memphis-sites'])
    expect(res.body.took.datasets).toEqual(['memphis-sites'])

    expect((await get(auth, `/api/views/${view}`)).body.workingSet).toBe(res.body.slug)
    const set = await get(auth, `/api/working-sets/${res.body.slug}`)
    expect(set.body.fromView).toBe(view)
    expect(set.body.viewport).toBeUndefined()
    expect(set.body.prompt).toBeUndefined()
  })

  it('takes a name when one is given', async () => {
    const auth = await login()
    const view = await saveMapView(auth, 'Memphis exploring')
    const res = await post(auth, `/api/working-sets/from-view/${view}`, {
      name: 'Memphis redevelopment',
      purpose: 'Which parcels can be redeveloped',
    })
    expect(res.status).toBe(201)
    expect(res.body.slug).toBe('memphis-redevelopment')
    expect((await get(auth, `/api/working-sets/${res.body.slug}`)).body.purpose).toBe(
      'Which parcels can be redeveloped',
    )
  })

  it('refuses a second set from the same view rather than leaving two claiming it', async () => {
    const auth = await login()
    const view = await saveMapView(auth, 'Memphis exploring')
    const first = await post(auth, `/api/working-sets/from-view/${view}`, {})
    expect(first.status).toBe(201)
    const again = await post(auth, `/api/working-sets/from-view/${view}`, {})
    expect(again.status).toBe(409)
    expect(again.body.workingSet).toBe(first.body.slug)
    expect((await get(auth, '/api/working-sets')).body.sets).toHaveLength(1)
  })

  it('a view that is not there is a 404 and makes nothing', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets/from-view/no-such-view', {})
    expect(res.status).toBe(404)
    expect((await get(auth, '/api/working-sets')).body.sets).toEqual([])
  })

  it('records the promotion as its own action', async () => {
    const auth = await login()
    const view = await saveMapView(auth, 'Memphis exploring')
    await post(auth, `/api/working-sets/from-view/${view}`, {})
    const { rows } = await libraryQuery(`SELECT action FROM library_audit WHERE action = 'workingset.promote'`)
    expect(rows).toHaveLength(1)
  })
})

describe('the place report, scoped to a set', () => {
  it('refuses a scope that is not a working set, with words rather than a code', async () => {
    const auth = await login()
    const res = await post(auth, '/api/library/place/report', { geoid: '13121', workingSet: 'no-such-set' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('no working set called')
  })

  it('refuses a scope that is not even a slug before it reaches the library', async () => {
    const auth = await login()
    const res = await post(auth, '/api/library/place/report', { geoid: '13121', workingSet: 'Not A Slug!' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not the name of a working set')
  })

  it('refuses a set that names nothing yet, rather than answering "nothing found"', async () => {
    const auth = await login()
    const made = await post(auth, '/api/working-sets', { name: 'Empty so far' })
    expect(made.status).toBe(201)
    const res = await post(auth, '/api/library/place/report', { geoid: '13121', workingSet: made.body.slug })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('names no datasets yet')
  })
})

/**
 * The derived columns (P7-2).
 *
 * `derived` is never written through a route — P7-5 writes it — so these seed a
 * manifest and reindex, which also checks the thing P7-1 promised: the columns
 * survive a rebuild from the bucket alone, and a route-written row and a
 * rebuilt one are the same row.
 *
 * What this block is judged on is that there is ONE read path for a stored
 * column, and that it is honest about a column it cannot open.
 */
describe('a working set’s derived columns', () => {
  const SET_SLUG = 'memphis-redevelopment'

  function manifest(derived: unknown[]): string {
    return JSON.stringify({
      title: 'Memphis redevelopment',
      category: 'working-sets',
      status: 'published',
      purpose: 'What bears on siting',
      datasets: ['memphis-sites', 'epa-superfund-npl'],
      layers: [],
      sites: 'memphis-sites',
      derived,
      savedBy: 'maria',
      savedById: null,
      savedAt: '2026-10-04T10:00:00.000Z',
    })
  }

  const COLUMN = {
    id: 'transmission-miles',
    label: 'Miles to nearest transmission line',
    unit: 'miles',
    method: 'Nearest point on EPRI transmission lines, 2024',
    computedAt: '2026-10-05T09:00:00.000Z',
  }

  async function seed(derived: unknown[]): Promise<void> {
    fake.seed(`library/working-sets/${SET_SLUG}/meta.json`, manifest(derived))
    await reindexCatalog()
  }

  it('needs a session', async () => {
    expect((await request(app).get(`/api/working-sets/${SET_SLUG}/columns`)).status).toBe(401)
  })

  it('serves a column stored on the manifest, keyed by county', async () => {
    const auth = await login()
    await seed([{ ...COLUMN, values: { '47157': 1.4, '28033': 6.2 } }])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.status).toBe(200)
    expect(res.body.slug).toBe(SET_SLUG)
    expect(res.body.unreadable).toEqual([])
    expect(res.body.columns).toHaveLength(1)
    expect(res.body.columns[0]).toMatchObject({
      id: 'transmission-miles',
      label: 'Miles to nearest transmission line',
      unit: 'miles',
      method: 'Nearest point on EPRI transmission lines, 2024',
      computedAt: '2026-10-05T09:00:00.000Z',
      values: { '47157': 1.4, '28033': 6.2 },
      rows: 2,
      storedAt: 'manifest',
    })
  })

  it('serves a column stored as a FILE beside the manifest — the reason a set is a directory', async () => {
    const auth = await login()
    fake.seed(
      `library/working-sets/${SET_SLUG}/derived/transmission-miles.json`,
      JSON.stringify({ '47157': 1.4, '1001': 9 }),
    )
    await seed([{ ...COLUMN, file: 'derived/transmission-miles.json' }])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.status).toBe(200)
    expect(res.body.columns[0].values).toEqual({ '47157': 1.4, '01001': 9 })
    expect(res.body.columns[0].rows).toBe(2)
    expect(res.body.columns[0].storedAt).toBe(
      `library/working-sets/${SET_SLUG}/derived/transmission-miles.json`,
    )
    expect(res.body.unreadable).toEqual([])
  })

  it('reports a column it cannot open rather than dropping it', async () => {
    const auth = await login()
    await seed([{ ...COLUMN, file: 'derived/never-written.json' }])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.status).toBe(200)
    expect(res.body.unreadable).toEqual(['transmission-miles'])
    // Still listed, with its name and a count of 0 — P6-23's rule.
    expect(res.body.columns[0].label).toBe('Miles to nearest transmission line')
    expect(res.body.columns[0].rows).toBe(0)
  })

  it('refuses a column pointing outside the set’s own directory', async () => {
    const auth = await login()
    await seed([{ ...COLUMN, file: '../../documents/the-workbook/book.txt' }])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.status).toBe(200)
    expect(res.body.unreadable).toEqual(['transmission-miles'])
    expect(res.body.columns[0].rows).toBe(0)
  })

  it('answers with no columns for a set that has none, which is every set today', async () => {
    const auth = await login()
    const slug = await makeSet(auth)
    const res = await get(auth, `/api/working-sets/${slug}/columns`)
    expect(res.status).toBe(200)
    expect(res.body.columns).toEqual([])
    expect(res.body.unreadable).toEqual([])
  })

  it('404s for a slug that is not a working set', async () => {
    const auth = await login()
    expect((await get(auth, '/api/working-sets/no-such-set/columns')).status).toBe(404)
    // A real entry of another kind is still not a set.
    expect((await get(auth, '/api/working-sets/memphis-sites/columns')).status).toBe(404)
  })

  it('counts the same columns the list row counts — one object, two readings', async () => {
    const auth = await login()
    await seed([
      { ...COLUMN, values: { '47157': 1.4 } },
      { id: 'brownfields-5mi', label: 'Brownfields within 5 miles', unit: 'count', values: { '47157': 3 } },
    ])

    const list = await get(auth, '/api/working-sets')
    const row = list.body.sets.find((s: any) => s.slug === SET_SLUG)
    const columns = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(row.derivedCount).toBe(2)
    expect(columns.body.columns).toHaveLength(row.derivedCount)
  })

  it('keeps the columns through an EDIT of the set — adding a dataset must not discard a number', async () => {
    const auth = await login()
    await seed([{ ...COLUMN, values: { '47157': 1.4 } }])

    const edited = await put(auth, `/api/working-sets/${SET_SLUG}`, {
      datasets: ['memphis-sites', 'epa-superfund-npl', 'the-workbook'].slice(0, 2),
    })
    expect(edited.status).toBe(200)
    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.body.columns[0].values).toEqual({ '47157': 1.4 })
  })
})

// --- P7-5: proximity between two layers -------------------------------------

/**
 * Whether a stored column still stands (P7-6).
 *
 * Seeded onto a manifest, like the block above, because a result is a stored
 * document and the question is what a READER is told about it. The thing this
 * block is judged on: a stale column comes back with its values and a sentence,
 * never hidden and never silently refreshed, and it carries the arguments a
 * re-run needs so the offer can be made where the number is read.
 */
describe('a derived column says whether it still stands (P7-6)', () => {
  const SET_SLUG = 'memphis-redevelopment'

  function manifest(derived: unknown[]): string {
    return JSON.stringify({
      title: 'Memphis redevelopment',
      category: 'working-sets',
      status: 'published',
      purpose: 'What bears on siting',
      datasets: ['memphis-sites', 'epa-superfund-npl'],
      layers: [],
      sites: 'memphis-sites',
      derived,
      savedBy: 'maria',
      savedById: null,
      savedAt: '2026-10-04T10:00:00.000Z',
    })
  }

  /** A column as P7-6 writes one, over the fixture's own sites table. */
  function column(over: Record<string, unknown> = {}, inputs?: unknown) {
    return {
      id: 'transmission-miles',
      label: 'Miles to nearest transmission line',
      unit: 'miles',
      method: 'Great-circle miles from 1 row to the nearest of 2 features',
      computedAt: '2026-10-05T09:00:00.000Z',
      values: { '47157': 1.4 },
      analysis: {
        type: 'proximity',
        from: 'memphis-sites',
        to: 'internal-transmission',
        within: 10,
        columns: ['transmission-miles'],
        rowsFile: 'derived/transmission-miles.rows.json',
        rows: 1,
        measured: 1,
        targets: 2,
        by: 'maria',
        at: '2026-10-05T09:00:00.000Z',
        inputs,
      },
      ...over,
    }
  }

  async function seed(derived: unknown[]): Promise<void> {
    fake.seed(`library/working-sets/${SET_SLUG}/meta.json`, manifest(derived))
    await reindexCatalog()
  }

  /** The version of the fixture's sites table as it actually stands. */
  function sitesInput(over: Record<string, unknown> = {}) {
    return {
      slug: 'memphis-sites',
      role: 'from',
      file: 'sites.csv',
      bytes: Buffer.byteLength(SITES_CSV),
      keys: '',
      content: fingerprintOf(SITES_CSV),
      at: '',
      ...over,
    }
  }

  it('says FRESH, with no note, when the input is byte-identical', async () => {
    const auth = await login()
    await seed([column({}, [sitesInput()])])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.status).toBe(200)
    expect(res.body.columns[0]).toMatchObject({ freshness: 'fresh', staleNote: '', type: 'proximity', by: 'maria' })
    expect(res.body.columns[0].inputs).toEqual([
      { slug: 'memphis-sites', role: 'from', verdict: 'fresh', reason: '' },
    ])
  })

  it('says STALE and STILL SERVES THE VALUES when the input has changed', async () => {
    const auth = await login()
    await seed([column({}, [sitesInput({ content: 'ffffffffffffffff' })])])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.status).toBe(200)
    const col = res.body.columns[0]
    expect(col.freshness).toBe('stale')
    expect(col.staleNote).toContain('“memphis-sites”')
    expect(col.staleNote).toContain('may have drifted')
    // The load-bearing half: labelled, not withheld. A published story quoting
    // 1.4 miles must still find 1.4 miles here, with the caveat beside it.
    expect(col.values).toEqual({ '47157': 1.4 })
    expect(col.rows).toBe(1)
    expect(res.body.unreadable).toEqual([])
  })

  it('offers the re-run, with the arguments the stored record already holds', async () => {
    const auth = await login()
    await seed([column({}, [sitesInput({ bytes: 1 })])])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.body.columns[0].rerun).toEqual({
      type: 'proximity',
      from: 'memphis-sites',
      to: 'internal-transmission',
      within: 10,
    })
  })

  it('says UNKNOWN for a column written before versions were recorded', async () => {
    const auth = await login()
    await seed([column()])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.body.columns[0].freshness).toBe('unknown')
    expect(res.body.columns[0].staleNote).toContain('before its inputs were recorded')
    expect(res.body.columns[0].values).toEqual({ '47157': 1.4 })
  })

  it('says UNKNOWN, and offers no re-run, for a column with no analysis at all', async () => {
    const auth = await login()
    await seed([{ id: 'hand-written', label: 'By hand', unit: '', values: { '47157': 2 } }])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.body.columns[0]).toMatchObject({ freshness: 'unknown', type: '', by: '', rerun: null })
    expect(res.body.columns[0].values).toEqual({ '47157': 2 })
  })

  it('is STALE when the input has left the library, naming it', async () => {
    const auth = await login()
    await seed([column({}, [sitesInput({ slug: 'archived-away' })])])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.body.columns[0].freshness).toBe('stale')
    expect(res.body.columns[0].staleNote).toContain('no longer in the library')
  })

  it('checks one run once, however many columns it wrote', async () => {
    const auth = await login()
    // Two columns, one analysis — the distance and the count. Asking the same
    // question of the bucket twice per page load is the cost this avoids.
    const analysis = column({}, [sitesInput()]).analysis
    await seed([
      { ...column({}, [sitesInput()]) },
      { ...column({ id: 'transmission-within-10mi', unit: 'count', values: { '47157': 1 } }, [sitesInput()]), analysis },
    ])

    const res = await get(auth, `/api/working-sets/${SET_SLUG}/columns`)
    expect(res.body.columns).toHaveLength(2)
    expect(res.body.columns.map((c: any) => c.freshness)).toEqual(['fresh', 'fresh'])
  })
})

describe('POST /api/working-sets/:slug/proximity', () => {
  /** A point table and a line layer, which is the spec's headline case:
   *  "distance from site to development", "brownfields in connection to
   *  transmission lines". Two Memphis rows in one county, one unlocated. */
  const PROX_SITES_CSV = [
    'name,lat,lng,GEOID',
    'xAI supercomputer,35.060080,-90.152192,47157',
    'TVA Allen Plant,35.065000,-90.140000,47157',
    'Coherent Richmond,37.540700,-77.436000,51760',
    'MP Materials Fort Worth,,,',
  ].join('\n')

  const PROX_SITES_META = {
    title: 'Redevelopment sites',
    status: 'published',
    category: 'land',
    layer: {
      geometry: 'point',
      name: 'Redevelopment sites',
      file: 'sites.csv',
      latKey: 'lat',
      lngKey: 'lng',
      labelKey: 'name',
      popupFields: [],
    },
  }

  const LINES_META = {
    title: 'Transmission lines',
    status: 'published',
    category: 'network',
    layer: {
      geometry: 'line',
      name: 'Transmission lines',
      file: 'lines.geojson',
      pathKey: '_path',
      labelKey: 'NAME',
      popupFields: ['OWNER'],
      color: '#2b6cb0',
    },
  }

  const LINES_GEOJSON = JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { NAME: 'Allen–Southaven 500kV', OWNER: 'TVA' },
        geometry: { type: 'LineString', coordinates: [[-90.1, 34.9], [-90.1, 35.3]] },
      },
    ],
  })

  async function seedProximity(): Promise<void> {
    fake.seed('library/datasets/redevelopment-sites/meta.json', JSON.stringify(PROX_SITES_META))
    fake.seed('library/datasets/redevelopment-sites/sites.csv', PROX_SITES_CSV)
    fake.seed('library/datasets/transmission/meta.json', JSON.stringify(LINES_META))
    fake.seed('library/datasets/transmission/lines.geojson', LINES_GEOJSON)
    await reindexCatalog()
    clearTabularCache()
  }

  async function proximitySet(auth: { cookie: string; csrf: string }): Promise<string> {
    await seedProximity()
    return makeSet(auth, {
      datasets: ['transmission'],
      layers: ['internal-transmission'],
      sites: 'redevelopment-sites',
    })
  }

  it('writes a column both interfaces read, from one computation', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)

    const res = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ reused: false, from: 'redevelopment-sites', to: 'internal-transmission' })
    expect(res.body.columns).toEqual([
      { id: 'miles-to-transmission', label: 'Miles to nearest Transmission lines', unit: 'miles', counties: 2 },
    ])
    expect(res.body.stats).toMatchObject({ rows: 4, measured: 3, withoutPoint: 1, counties: 2 })

    // The same column, through the ONE read P7-2 built for both interfaces.
    const columns = await get(auth, `/api/working-sets/${slug}/columns`)
    expect(columns.body.columns).toHaveLength(1)
    expect(columns.body.columns[0].unit).toBe('miles')
    expect(Object.keys(columns.body.columns[0].values).sort()).toEqual(['47157', '51760'])
    expect(columns.body.columns[0].rows).toBe(2)
    expect(columns.body.unreadable).toEqual([])
  })

  it('counts features within n miles as a second column', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)

    const res = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission', within: 5 })
    expect(res.status).toBe(200)
    expect(res.body.columns.map((c: any) => c.id)).toEqual([
      'miles-to-transmission',
      'miles-to-transmission-within-5mi',
    ])

    const columns = await get(auth, `/api/working-sets/${slug}/columns`)
    expect(columns.body.columns.map((c: any) => c.unit)).toEqual(['miles', 'count'])
    expect(columns.body.columns[1].values['47157']).toBe(1)
    // Richmond reaches nothing: zero is the finding, not a missing value.
    expect(columns.body.columns[1].values['51760']).toBe(0)
  })

  it('reuses an unchanged run and says so', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)

    const first = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    const second = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    expect(second.status).toBe(200)
    expect(second.body.reused).toBe(true)
    expect(second.body.computedAt).toBe(first.body.computedAt)
    expect(second.body.perRow).toEqual(first.body.perRow)
  })

  it('says in the response WHICH it did — served or computed (P7-6)', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)

    const first = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    expect(first.body).toMatchObject({ served: 'computed', freshness: 'fresh', staleNote: '' })

    // The claim the owner cares about, in the response rather than inferred:
    // this one cost nothing.
    const second = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    expect(second.body).toMatchObject({ served: 'stored', freshness: 'fresh', staleNote: '' })
  })

  it('recomputes a stale result and carries the reason back (P7-6)', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)
    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })

    // One more site in the table that was measured.
    fake.seed(
      'library/datasets/redevelopment-sites/sites.csv',
      `${PROX_SITES_CSV}\nNew Site,35.07,-90.11,47157`,
    )
    await reindexCatalog()
    clearTabularCache()
    clearAnalysisInputMemo()

    const res = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    expect(res.status).toBe(200)
    expect(res.body.served).toBe('computed')
    expect(res.body.staleNote).toContain('“redevelopment-sites” has changed')
    expect(res.body.stats.rows).toBe(5)
  })

  it('audits a computation and not a serve, and says why it recomputed (P7-6)', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)

    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    const after = await libraryQuery(
      `SELECT detail FROM library_audit WHERE action = 'workingset.proximity' ORDER BY id`,
    )
    // One row, not two: a serve is not an event.
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0].detail.recomputedBecause).toBeUndefined()

    fake.seed('library/datasets/redevelopment-sites/sites.csv', `${PROX_SITES_CSV}\nNew Site,35.07,-90.11,47157`)
    await reindexCatalog()
    clearTabularCache()
    clearAnalysisInputMemo()
    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })

    const forced = await libraryQuery(
      `SELECT detail FROM library_audit WHERE action = 'workingset.proximity' ORDER BY id`,
    )
    expect(forced.rows).toHaveLength(2)
    expect(forced.rows[1].detail.recomputedBecause).toContain('“redevelopment-sites” has changed')
  })

  it('serves the per-row numbers back, which is what a story quotes', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)
    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })

    const res = await get(auth, `/api/working-sets/${slug}/proximity`)
    expect(res.status).toBe(200)
    expect(res.body.analyses).toHaveLength(1)
    expect(res.body.analyses[0].analysis).toMatchObject({
      type: 'proximity',
      from: 'redevelopment-sites',
      to: 'internal-transmission',
      by: 'maria',
    })
    const xai = res.body.analyses[0].rows.find((r: any) => r.label === 'xAI supercomputer')
    expect(xai.nearest).toBe('Allen–Southaven 500kV')
    expect(xai.miles).toBeCloseTo(2.95, 1)
  })

  it('audits the run, and does NOT audit a reuse — nothing happened', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)
    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })

    const { rows } = await libraryQuery<{ action: string; target: string }>(
      `SELECT action, target FROM library_audit WHERE action = 'workingset.proximity'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].target).toBe(slug)
  })

  it('refuses a layer the set does not name, with a sentence', async () => {
    const auth = await login()
    await seedProximity()
    const slug = await makeSet(auth, { datasets: ['epa-superfund-npl'], sites: 'redevelopment-sites', layers: [] })

    const res = await post(auth, `/api/working-sets/${slug}/proximity`, { to: 'internal-transmission' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('is not a layer this working set names')
  })

  it('refuses an unknown set by name, rather than 404 with nothing to read', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets/no-such-set/proximity', { to: 'internal-transmission' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('There is no working set called “no-such-set”.')
  })

  it('refuses past the ceiling with a 413 naming the local pass', async () => {
    const auth = await login()
    await seedProximity()
    const header = 'name,lat,lng,GEOID\n'
    const rows = Array.from(
      { length: 6_000 },
      (_, i) => `Brownfield ${i},${35 + (i % 90) / 1000},${-90 - (i % 90) / 1000},47157`,
    ).join('\n')
    fake.seed(
      'library/datasets/brownfields/meta.json',
      JSON.stringify({ title: 'Brownfields', status: 'published', category: 'land' }),
    )
    fake.seed('library/datasets/brownfields/b.csv', header + rows)
    await reindexCatalog()
    clearTabularCache()
    const slug = await makeSet(auth, {
      datasets: ['transmission', 'brownfields'],
      layers: ['internal-transmission'],
      sites: 'redevelopment-sites',
    })

    const res = await post(auth, `/api/working-sets/${slug}/proximity`, {
      from: 'brownfields',
      to: 'internal-transmission',
    })
    expect(res.status).toBe(413)
    expect(res.body.error).toContain('6,000 rows is a batch job, not a request')
    expect(res.body.error).toContain('npm run library -- proximity')

    // Nothing was written, and nothing was audited.
    const columns = await get(auth, `/api/working-sets/${slug}/columns`)
    expect(columns.body.columns).toEqual([])
  })

  it('needs a session, like every other working-set route', async () => {
    const res = await request(app)
      .post('/api/working-sets/memphis-redevelopment/proximity')
      .send({ to: 'internal-transmission' })
    expect(res.status).toBe(401)
  })

  it('needs the CSRF token', async () => {
    const auth = await login()
    const slug = await proximitySet(auth)
    const res = await request(app)
      .post(`/api/working-sets/${slug}/proximity`)
      .set('Cookie', auth.cookie)
      .send({ to: 'internal-transmission' })
    expect(res.status).toBe(403)
  })
})

// --- P7-8: a weighted index over the set's layers ----------------------------

describe('POST /api/working-sets/:slug/composite', () => {
  /** Two county layers with a real spread and a deliberate gap: the workbook's
   *  political efficacy question in miniature. */
  const VOTES_CSV = ['GEOID,registered_pct', '47157,61.4', '51760,72.8', '04019,44.1', '13121,80.2'].join('\n')
  const TURNOUT_CSV = ['GEOID,turnout_pct', '47157,48.2', '51760,66.0', '13121,70.9'].join('\n')

  function countyMeta(title: string, file: string, valueKey: string) {
    return {
      title,
      status: 'published',
      category: 'equity',
      layer: {
        geometry: 'county',
        name: title,
        file,
        geoKey: 'GEOID',
        valueKey,
        dataType: 'percentage',
        unit: '%',
        direction: 'higher_better',
      },
    }
  }

  const TERMS = [
    { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
    { layer: 'internal-turnout', weight: 4, direction: 'higher_better' },
  ]

  async function indexSet(auth: { cookie: string; csrf: string }): Promise<string> {
    fake.seed('library/datasets/votes/meta.json', JSON.stringify(countyMeta('Black voter registration', 'votes.csv', 'registered_pct')))
    fake.seed('library/datasets/votes/votes.csv', VOTES_CSV)
    fake.seed('library/datasets/turnout/meta.json', JSON.stringify(countyMeta('Local election turnout', 'turnout.csv', 'turnout_pct')))
    fake.seed('library/datasets/turnout/turnout.csv', TURNOUT_CSV)
    await reindexCatalog()
    clearTabularCache()
    clearAnalysisInputMemo()
    return makeSet(auth, {
      datasets: ['votes', 'turnout'],
      layers: ['internal-votes', 'internal-turnout'],
    })
  }

  it('writes one column both interfaces read, and says what it is a layer of', async () => {
    const auth = await login()
    const slug = await indexSet(auth)

    const res = await post(auth, `/api/working-sets/${slug}/composite`, {
      label: 'Political efficacy',
      terms: TERMS,
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      set: slug,
      column: 'political-efficacy',
      label: 'Political efficacy',
      served: 'computed',
      freshness: 'fresh',
      counties: 4,
      complete: 3,
      partial: 1,
      layerId: `internal-${slug}~political-efficacy`,
    })
    // The formula comes back canonical, and the scale each term used with it.
    expect(res.body.terms.map((t: any) => t.layer)).toEqual(['internal-turnout', 'internal-votes'])
    expect(res.body.scales).toHaveLength(2)

    // And it is immediately on the one reader both interfaces use.
    const columns = await get(auth, `/api/working-sets/${slug}/columns`)
    expect(columns.body.columns).toHaveLength(1)
    expect(columns.body.columns[0]).toMatchObject({
      id: 'political-efficacy',
      unit: 'index',
      type: 'composite',
      by: 'maria',
      freshness: 'fresh',
      layerId: `internal-${slug}~political-efficacy`,
    })
    expect(columns.body.columns[0].values['13121']).toBe(100)
  })

  it('offers a re-run whose arguments are the saved formula — P7-6’s widened rerunOf', async () => {
    const auth = await login()
    const slug = await indexSet(auth)
    await post(auth, `/api/working-sets/${slug}/composite`, { label: 'Political efficacy', terms: TERMS })

    const columns = await get(auth, `/api/working-sets/${slug}/columns`)
    // P7-6 shipped `rerun: null` for anything that was not proximity-shaped.
    expect(columns.body.columns[0].rerun).toEqual({
      type: 'composite',
      terms: [
        { layer: 'internal-turnout', weight: 4, direction: 'higher_better' },
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
      ],
    })

    // And pressing it reproduces the same numbers.
    const before = columns.body.columns[0].values
    const again = await post(auth, `/api/working-sets/${slug}/composite`, {
      label: 'Political efficacy',
      id: 'political-efficacy',
      terms: columns.body.columns[0].rerun.terms,
      recompute: true,
    })
    expect(again.status).toBe(200)
    const after = await get(auth, `/api/working-sets/${slug}/columns`)
    expect(after.body.columns[0].values).toEqual(before)
  })

  it('serves the stored index on a second ask, and audits only the computation', async () => {
    const auth = await login()
    const slug = await indexSet(auth)
    const first = await post(auth, `/api/working-sets/${slug}/composite`, { label: 'Political efficacy', terms: TERMS })
    // The same formula typed in the other order is the same formula.
    const second = await post(auth, `/api/working-sets/${slug}/composite`, {
      label: 'Political efficacy',
      terms: [...TERMS].reverse(),
    })
    expect(first.body.served).toBe('computed')
    expect(second.body.served).toBe('stored')
    expect(second.body.reused).toBe(true)

    const rows = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'workingset.composite' ORDER BY id`)
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].detail).toMatchObject({
      column: 'political-efficacy',
      label: 'Political efficacy',
      counties: 4,
    })
    expect(rows.rows[0].detail.terms).toEqual(['internal-turnout:4:higher_better', 'internal-votes:6:higher_better'])
  })

  it('lists the set’s indices with their formulas and their standing', async () => {
    const auth = await login()
    const slug = await indexSet(auth)
    await post(auth, `/api/working-sets/${slug}/composite`, { label: 'Political efficacy', terms: TERMS })

    const res = await get(auth, `/api/working-sets/${slug}/composite`)
    expect(res.status).toBe(200)
    expect(res.body.indices).toHaveLength(1)
    expect(res.body.indices[0]).toMatchObject({ column: 'political-efficacy', label: 'Political efficacy' })
    expect(res.body.indices[0].analysis.scales).toHaveLength(2)
    expect(res.body.indices[0].freshness.verdict).toBe('fresh')
    expect((await get(auth, '/api/working-sets/no-such-set/composite')).status).toBe(404)
  })

  it('relays the definition’s own refusal as a 400, writing nothing', async () => {
    const auth = await login()
    const slug = await indexSet(auth)
    const res = await post(auth, `/api/working-sets/${slug}/composite`, {
      label: 'Political efficacy',
      terms: [{ layer: 'internal-votes', weight: 1, direction: 'higher_better' }],
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('An index needs at least 2 layers')
    expect((await get(auth, `/api/working-sets/${slug}/columns`)).body.columns).toEqual([])
  })

  it('relays the ceiling as a 413 naming the local pass, writing nothing', async () => {
    const auth = await login()
    const slug = await indexSet(auth)
    process.env.COMPOSITE_BYTES_BUDGET = '10'
    try {
      const res = await post(auth, `/api/working-sets/${slug}/composite`, { label: 'Political efficacy', terms: TERMS })
      expect(res.status).toBe(413)
      expect(res.body.error).toContain('npm run library -- index')
      expect(res.body.error).toContain('The layer count alone cannot see this')
    } finally {
      delete process.env.COMPOSITE_BYTES_BUDGET
    }
    expect((await get(auth, `/api/working-sets/${slug}/columns`)).body.columns).toEqual([])
  })

  it('refuses a set that does not exist with a sentence, not a bare 404', async () => {
    const auth = await login()
    const res = await post(auth, '/api/working-sets/no-such-set/composite', { label: 'x', terms: TERMS })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('There is no working set called “no-such-set”.')
  })

  it('needs a session, like every other working-set route', async () => {
    const res = await request(app)
      .post('/api/working-sets/memphis-redevelopment/composite')
      .send({ label: 'x', terms: TERMS })
    expect(res.status).toBe(401)
  })

  it('needs the CSRF token', async () => {
    const auth = await login()
    const slug = await indexSet(auth)
    const res = await request(app)
      .post(`/api/working-sets/${slug}/composite`)
      .set('Cookie', auth.cookie)
      .send({ label: 'x', terms: TERMS })
    expect(res.status).toBe(403)
  })
})
