import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/** P5-34: link drops against the real createApp() with pg-mem + fake bucket. */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, listFiles } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { parseLinkUrl, defaultLinkTitle } = await import('../services/libraryLinks.js')
const { setLinkFetchDefaults, resetLinkFetchQueue, whenQueueIdle, writeFetchState } = await import('../services/linkFetchQueue.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('link-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-links-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
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
    .set('X-Forwarded-For', `10.95.0.${++loginIp}`)
    .send({ username: 'maria', password: 'link-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function post(auth: { cookie: string; csrf: string }, body: unknown) {
  return request(app).post('/api/library/links').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body)
}

describe('helpers', () => {
  it('accepts only http(s) URLs and titles them by host + path', () => {
    expect(parseLinkUrl('https://data.census.gov/table/ACSDT5Y2022.B25003?q=x')?.hostname).toBe('data.census.gov')
    expect(parseLinkUrl(' http://example.org ')?.href).toBe('http://example.org/')
    for (const bad of ['javascript:alert(1)', 'ftp://x.org/f', 'data:text/plain,hi', 'example.org', '', 'https://', 42, 'https://' + 'a'.repeat(2100)]) {
      expect(parseLinkUrl(bad as any)).toBeNull()
    }
    expect(defaultLinkTitle(new URL('https://data.census.gov/table/ACSDT5Y2022.B25003/'))).toBe('data.census.gov/table/ACSDT5Y2022.B25003')
    expect(defaultLinkTitle(new URL('https://example.org/'))).toBe('example.org')
  })

  it('refuses userinfo, literal IPs (any form), localhost, and reserved suffixes — the fetch CLI must never be pointed inward', () => {
    for (const bad of [
      'http://user:pw@example.org/x',
      'http://user@example.org/x',
      'http://127.0.0.1/x',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f000001/', // hex 127.0.0.1
      'http://[::1]/x',
      'http://[::ffff:127.0.0.1]/x',
      'http://10.0.0.5/',
      'http://169.254.169.254/latest/meta-data/',
      'http://93.184.216.34/', // even a public literal: links are names, not addresses
      'http://localhost/',
      'http://api.localhost:3000/',
      'http://db.internal/',
      'http://printer.local/',
      'http://nas.home.arpa/',
    ]) {
      expect(parseLinkUrl(bad), bad).toBeNull()
    }
  })
})

describe('POST /api/library/links', () => {
  it('bare-401s without a session and 403s without CSRF', async () => {
    expect((await request(app).post('/api/library/links').send({ url: 'https://x.org' })).status).toBe(401)
    const { cookie } = await login()
    expect((await request(app).post('/api/library/links').set('Cookie', cookie).send({ url: 'https://x.org' })).status).toBe(403)
  })

  it('a bare link becomes a needs-cataloging incoming entry with a manifest, no file, and an audit row', async () => {
    const auth = await login()
    const res = await post(auth, { url: 'https://data.census.gov/table/ACSDT5Y2022.B25003', note: 'county parcel export, needs login' })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ status: 'needs-cataloging', title: 'data.census.gov/table/ACSDT5Y2022.B25003' })
    const slug = res.body.slug
    expect((await listFiles(`library/incoming/${slug}/`)).map(f => f.key)).toEqual([`library/incoming/${slug}/meta.json`])
    const entry = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry).toMatchObject({ kind: 'incoming', status: 'needs-cataloging', title: 'data.census.gov/table/ACSDT5Y2022.B25003' })
    expect(entry.body.entry.meta).toMatchObject({ url: 'https://data.census.gov/table/ACSDT5Y2022.B25003', note: 'county parcel export, needs login', linkedBy: 'maria', originalFilename: null })
    expect(entry.body.entry.files).toHaveLength(1)
    const audit = await libraryQuery(`SELECT action, target, detail FROM library_audit WHERE action = 'library.link'`)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].target).toBe(slug)
  })

  it('a titled or tagged link is filed straight to needs-review; filing later works like any incoming entry', async () => {
    const auth = await login()
    const res = await post(auth, { url: 'https://example.org/parcels.zip', title: 'County parcels', category: 'places', tags: ['gis', ' land '] })
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('needs-review')
    const slug = res.body.slug
    const filed = await request(app).patch(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send({ title: 'County parcels (GIS portal)', category: 'places', tags: ['gis'] })
    expect(filed.status).toBe(200)
    const entry = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.title).toBe('County parcels (GIS portal)')
    expect(entry.body.entry.meta.url).toBe('https://example.org/parcels.zip') // filing keeps the link
  })

  it('rejects non-http(s), malformed, or non-public urls with a 400 naming the field, writing nothing', async () => {
    const auth = await login()
    for (const url of ['javascript:alert(1)', 'not a url', 'ftp://x.org/f', '', 'http://127.0.0.1/', 'http://localhost/', 'http://u:p@example.org/']) {
      const res = await post(auth, { url })
      expect(res.status, url).toBe(400)
      expect(res.body.error).toMatch(/url/)
    }
    expect(await listFiles('library/incoming/')).toEqual([])
  })

  // --- P5-56: "This is a data source" -------------------------------------

  const SOURCE = {
    provider: 'US EPA',
    program: 'Superfund / CERCLIS',
    geography: 'point',
    coverage: 'national',
    topics: ['contamination'],
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0' }],
    license: 'public domain',
    relevance: 'A red flag near a candidate parcel.',
  }

  it('a link with a source block is filed as kind source under library/sources/, keeping the URL as the homepage', async () => {
    const auth = await login()
    const res = await post(auth, { url: 'https://www.epa.gov/superfund/sites', source: SOURCE })
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ kind: 'source', status: 'needs-cataloging' })
    const slug = res.body.slug
    // The bucket tree is the truth: nothing is left in the incoming queue.
    expect((await listFiles(`library/sources/${slug}/`)).map(f => f.key)).toEqual([`library/sources/${slug}/meta.json`])
    expect(await listFiles('library/incoming/')).toEqual([])

    const entry = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.kind).toBe('source')
    expect(entry.body.entry.meta.source).toEqual({ ...SOURCE, homepage: 'https://www.epa.gov/superfund/sites' })
    expect(entry.body.entry.meta.url).toBe('https://www.epa.gov/superfund/sites')
    const audit = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'library.link'`)
    expect(audit.rows[0].detail).toMatchObject({ kind: 'source' })
  })

  it('keeps a homepage that came with the block, and quick-drop rules still set the status', async () => {
    const auth = await login()
    const res = await post(auth, {
      url: 'https://example.gov/portal',
      title: 'FEMA National Risk Index',
      source: { provider: 'FEMA', homepage: 'https://hazards.fema.gov/nri/' },
    })
    expect(res.body.status).toBe('needs-review') // a title files it straight away
    const entry = await request(app).get(`/api/library/catalog/${res.body.slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.meta.source.homepage).toBe('https://hazards.fema.gov/nri/')
  })

  it('400s a source block with no provider, writing nothing', async () => {
    const auth = await login()
    const res = await post(auth, { url: 'https://example.gov/x', source: { geography: 'county' } })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/provider/)
    expect(await listFiles('library/sources/')).toEqual([])
    expect(await listFiles('library/incoming/')).toEqual([])
  })

  it('files the entry anyway when only some fields are bad, and reports what was dropped', async () => {
    const auth = await login()
    const res = await post(auth, {
      url: 'https://example.gov/x',
      source: { provider: 'USDA', geography: 'zipcode', access: [{ type: 'sftp' }] },
    })
    expect(res.status).toBe(201)
    expect(res.body.dropped).toEqual(['geography "zipcode"', 'access[0].type "sftp"'])
    const entry = await request(app).get(`/api/library/catalog/${res.body.slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.meta.source).toEqual({ provider: 'USDA', homepage: 'https://example.gov/x' })
  })

  it('reindex rebuilds a source entry from the bucket manifest alone', async () => {
    const auth = await login()
    const slug = (await post(auth, { url: 'https://example.gov/x', source: SOURCE })).body.slug
    expect((await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)).status).toBe(200)
    const entry = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.kind).toBe('source')
    expect(entry.body.entry.meta.source.provider).toBe('US EPA')
  })

  it('reindex rebuilds a link entry from the bucket manifest alone', async () => {
    const auth = await login()
    const slug = (await post(auth, { url: 'https://example.org/data.csv', note: 'n' })).body.slug
    const re = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    expect(re.status).toBe(200)
    const entry = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry).toMatchObject({ kind: 'incoming', status: 'needs-cataloging' })
    expect(entry.body.entry.meta.url).toBe('https://example.org/data.csv')
  })
})

// --- P5-47: fetch and suggest on the drop ----------------------------------

describe('fetch on drop', () => {
  /** Fake resolver: every name is public except the ones named here. */
  const ADDRESSES: Record<string, string[]> = { 'intranet.example': ['10.1.2.3'] }
  const lookup = async (host: string) =>
    (ADDRESSES[host] ?? ['93.184.216.34']).map(address => ({ address, family: 4 }))

  function serving(body: string, headers: Record<string, string> = { 'content-type': 'text/csv' }, status = 200): typeof fetch {
    return (async () => new Response(body, { status, headers })) as unknown as typeof fetch
  }

  const suggestion = { title: 'County parcel export', category: 'places', tags: ['parcels'], summary: 'One row per parcel.', at: '2026-09-05T00:00:00.000Z', model: 'stub' }

  /** The queue is real here — only the network and the model are fakes. */
  function install(fetchImpl: typeof fetch, suggest: () => Promise<unknown> = async () => suggestion): void {
    setLinkFetchDefaults({ fetchImpl, lookup, suggest: suggest as never })
  }

  afterEach(async () => {
    await whenQueueIdle()
    resetLinkFetchQueue()
  })

  it('downloads the link into the entry and proposes a filing that nobody has applied', async () => {
    install(serving('id,acres\n1,40\n'))
    const auth = await login()
    const res = await post(auth, { url: 'https://example.org/exports/parcels.csv' })
    expect(res.status).toBe(201)
    expect(res.body.fetch).toBe('queued')
    const slug = res.body.slug

    await whenQueueIdle()
    expect((await listFiles(`library/incoming/${slug}/`)).map(f => f.key).sort()).toEqual([
      `library/incoming/${slug}/meta.json`,
      `library/incoming/${slug}/parcels.csv`,
    ])
    const entry = (await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)).body.entry
    expect(entry.meta.fetch).toMatchObject({ status: 'fetched', name: 'parcels.csv', bytes: 14 })
    expect(entry.meta.lineage.from).toBe('https://example.org/exports/parcels.csv')
    expect(entry.meta.suggested).toMatchObject({ title: 'County parcel export', category: 'places' })
    // The proposal is a proposal: the entry is still an unfiled quick drop.
    expect(entry.title).toBe('example.org/exports/parcels.csv')
    expect(entry.category).toBe('')
    expect(entry.status).toBe('needs-cataloging')

    const audit = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'library.fetch'`)
    expect(audit.rows[0].detail).toMatchObject({ ok: true, name: 'parcels.csv' })
  })

  it('says in plain words when the site would not give it up, and leaves the drop intact', async () => {
    install(serving('', {}, 403))
    const auth = await login()
    const slug = (await post(auth, { url: 'https://example.org/private.csv', note: 'needs login' })).body.slug
    await whenQueueIdle()
    const entry = (await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)).body.entry
    expect(entry.meta.fetch).toMatchObject({ status: 'failed', reason: 'the site refused the request' })
    expect(entry.meta.note).toBe('needs login')
    expect(entry.files).toHaveLength(1)
  })

  it('never fetches a data source — a source is a pointer, not held data', async () => {
    const fetchImpl = vi.fn()
    install(fetchImpl as unknown as typeof fetch)
    const auth = await login()
    const res = await post(auth, { url: 'https://www.epa.gov/superfund/sites', source: { provider: 'US EPA' } })
    expect(res.body).toMatchObject({ kind: 'source', fetch: 'skipped' })
    await whenQueueIdle()
    expect(fetchImpl).not.toHaveBeenCalled()
    const entry = (await request(app).get(`/api/library/catalog/${res.body.slug}`).set('Cookie', auth.cookie)).body.entry
    expect(entry.meta.fetch).toBeUndefined()
  })

  it('honours fetch: false — record the link, download nothing', async () => {
    const fetchImpl = vi.fn()
    install(fetchImpl as unknown as typeof fetch)
    const auth = await login()
    const res = await post(auth, { url: 'https://example.org/huge.zip', fetch: false })
    expect(res.body.fetch).toBe('skipped')
    await whenQueueIdle()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('POST /api/library/catalog/:slug/refetch', () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const serving: typeof fetch = (async () => new Response('id\n1\n', { status: 200, headers: { 'content-type': 'text/csv' } })) as unknown as typeof fetch

  afterEach(async () => {
    await whenQueueIdle()
    resetLinkFetchQueue()
  })

  async function droppedWithoutFetch(auth: { cookie: string; csrf: string }, url = 'https://example.org/later.csv'): Promise<string> {
    return (await post(auth, { url, fetch: false })).body.slug
  }

  function refetch(auth: { cookie: string; csrf: string }, slug: string) {
    return request(app).post(`/api/library/catalog/${slug}/refetch`).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  }

  it('bare-401s without a session and 403s without CSRF', async () => {
    const auth = await login()
    const slug = await droppedWithoutFetch(auth)
    expect((await request(app).post(`/api/library/catalog/${slug}/refetch`)).status).toBe(401)
    expect((await request(app).post(`/api/library/catalog/${slug}/refetch`).set('Cookie', auth.cookie)).status).toBe(403)
  })

  it('queues the fetch again, and this time the file lands', async () => {
    setLinkFetchDefaults({ fetchImpl: serving, lookup, suggest: async () => null })
    const auth = await login()
    const slug = await droppedWithoutFetch(auth)
    const res = await refetch(auth, slug)
    expect(res.status).toBe(200)
    expect(res.body.fetch).toBe('queued')
    await whenQueueIdle()
    const entry = (await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)).body.entry
    expect(entry.meta.fetch.status).toBe('fetched')
    expect(entry.meta.originalFilename).toBe('later.csv')
  })

  it('does not queue a second download for a fetch already on its way', async () => {
    const fetchImpl = vi.fn()
    setLinkFetchDefaults({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup, suggest: async () => null })
    const auth = await login()
    const slug = await droppedWithoutFetch(auth)
    await writeFetchState(slug, { status: 'fetching', at: new Date().toISOString() })
    const res = await refetch(auth, slug)
    expect(res.body.fetch).toBe('fetching')
    await whenQueueIdle()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('404s a slug that is not an incoming entry, and 400s an entry with no link', async () => {
    const auth = await login()
    expect((await refetch(auth, 'no-such-entry')).status).toBe(404)
    const source = (await post(auth, { url: 'https://example.gov/x', source: { provider: 'FEMA' } })).body.slug
    expect((await refetch(auth, source)).status).toBe(404) // a source is never fetched

    const note = await request(app)
      .post('/api/library/entries')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'An idea', body: 'Something to try.' })
    expect((await refetch(auth, note.body.entry.slug)).status).toBe(404)
  })
})
