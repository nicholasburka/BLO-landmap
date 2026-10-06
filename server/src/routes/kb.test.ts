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
 * P5-40: operations home. Both endpoints run against the real createApp()
 * with a pg-mem store and an injected fake bucket, so the auth guard, the
 * kb.json read, and the catalog resolution under test are production's.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { clearKbConfigCache } = await import('../services/kbConfig.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')

let passwordHash: string
beforeAll(async () => {
  // Cheap params: this suite logs in per test and production-cost argon2
  // under parallel workers starves other suites' timeouts.
  passwordHash = await argon2.hash('kb-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

/** P5-88 records the SQL the request path runs, so "the landing no longer
 *  asks the catalog once per pinned slug" is an assertion and not a hope. */
let sql: string[] = []

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  const pool = new Pool() as unknown as PgPool
  const query = pool.query.bind(pool)
  pool.query = ((text: any, params: any) => {
    sql.push(typeof text === 'string' ? text : String(text?.text ?? ''))
    return query(text, params)
  }) as typeof pool.query
  return pool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

const KB_JSON = {
  homeSlug: 'home',
  pinned: ['home', 'organizations', 'ghost-entry'],
  initiative: {
    name: 'Black Homesteading Initiative (5-5-5)',
    tagline: 'Five years, $5 million, 5,000 acres.',
    facts: [
      { label: 'Years', value: '2027–2032', href: '/library/plan' },
      { label: 'To raise', value: '$5 million' },
    ],
    nextStep: { text: 'Read the hub page', href: '/wiki/home' },
  },
  links: [{ label: 'Library guide', href: '/wiki/home' }],
}

beforeEach(async () => {
  clearKbConfigCache()
  sql = []
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-kb-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/wiki/home.md', '# Start here\n\nThe front door.\n')
  fake.seed('library/datasets/organizations/organizations.csv', 'name\nBlack Farmer Fund\n')
  fake.seed(
    'library/datasets/organizations/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'network', status: 'published', description: '100 network organizations, geocoded.' }),
  )
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
  clearKbConfigCache()
})

let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username: 'maria', password: 'kb-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

async function reindex(auth: { cookie: string; csrf: string }) {
  const res = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  expect(res.status).toBe(200)
  return res
}

/** Reindex writes its own `catalog.reindex` row (correctly — it is on the
 *  allowlist). These tests assert on exact feeds, so they start from empty. */
async function clearAudit() {
  await libraryQuery(`DELETE FROM library_audit`)
}

async function audit(action: string, target: string | null, detail: Record<string, unknown>, at: string, actor = 'maria') {
  await libraryQuery(
    `INSERT INTO library_audit (actor, action, target, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, target, JSON.stringify(detail), at],
  )
}

describe('GET /api/library/kb', () => {
  it('refuses anonymous callers', async () => {
    const res = await request(app).get('/api/library/kb')
    expect(res.status).toBe(401)
  })

  it('returns sensible defaults when no kb.json has been pushed', async () => {
    const auth = await login()
    await reindex(auth)
    const res = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ homeSlug: 'home', pinned: [], initiative: null, links: [] })
  })

  it('resolves pinned slugs against the catalog and drops the ones that do not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.seed('library/kb.json', JSON.stringify(KB_JSON))
    const auth = await login()
    await reindex(auth)
    const res = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.homeSlug).toBe('home')
    expect(res.body.pinned).toEqual([
      { slug: 'home', kind: 'wiki', title: 'Start here', category: '', description: '', href: '/wiki/home' },
      {
        slug: 'organizations',
        kind: 'dataset',
        title: 'Organizations',
        category: 'network',
        description: '100 network organizations, geocoded.',
        href: '/library/organizations',
      },
    ])
    expect(warn.mock.calls.flat().join(' ')).toContain('ghost-entry')
    expect(res.body.initiative).toEqual(KB_JSON.initiative)
    expect(res.body.links).toEqual(KB_JSON.links)
    warn.mockRestore()
  })

  it('re-reads kb.json after a reindex and caches it in between', async () => {
    fake.seed('library/kb.json', JSON.stringify({ homeSlug: 'home' }))
    const auth = await login()
    await reindex(auth)
    const first = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(first.body.homeSlug).toBe('home')

    // Same content pushed with a new hub slug. Without a reindex the cached
    // file still wins; the reindex is what makes the bucket truth again.
    fake.seed('library/kb.json', JSON.stringify({ homeSlug: 'front-door' }))
    const cachedRead = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(cachedRead.body.homeSlug).toBe('home')

    await reindex(auth)
    const fresh = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(fresh.body.homeSlug).toBe('front-door')
  })

  it('falls back to defaults when kb.json is not valid JSON', async () => {
    fake.seed('library/kb.json', '{ not json at all')
    const auth = await login()
    await reindex(auth)
    const res = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ homeSlug: 'home', pinned: [], initiative: null, links: [] })
  })
})

describe('GET /api/library/activity', () => {
  it('refuses anonymous callers', async () => {
    const res = await request(app).get('/api/library/activity')
    expect(res.status).toBe(401)
  })

  it('never shows logins or user administration, whatever the audit log holds', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('login.success', null, { ip: '1.2.3.4' }, '2026-09-04T09:00:00Z')
    await audit('login.failure', 'maria', { ip: '1.2.3.4' }, '2026-09-04T09:01:00Z')
    await audit('logout', null, {}, '2026-09-04T09:02:00Z')
    await audit('user.create', 'nick', { role: 'admin' }, '2026-09-04T09:03:00Z', 'cli')
    await audit('user.reset-password', 'nick', {}, '2026-09-04T09:04:00Z', 'cli')
    await audit('user.disable', 'nick', {}, '2026-09-04T09:05:00Z', 'cli')
    await audit('library.upload', 'organizations', { filename: 'organizations.csv' }, '2026-09-04T10:00:00Z')

    const res = await request(app).get('/api/library/activity').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.rows.map((r: any) => r.verb)).toEqual(['uploaded'])
    expect(JSON.stringify(res.body)).not.toContain('maria@')
    expect(JSON.stringify(res.body)).not.toContain('1.2.3.4')
  })

  it('resolves targets from the catalog, newest first, with kind and href', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('wiki.update', 'home', { title: 'Start here' }, '2026-09-04T10:00:00Z')
    await audit('library.upload', 'organizations', { filename: 'organizations.csv' }, '2026-09-04T11:00:00Z')
    // Downloads record the bucket KEY as the target; the slug is in detail.
    await audit('library.download', 'library/datasets/organizations/organizations.csv', { slug: 'organizations', name: 'organizations.csv' }, '2026-09-04T12:00:00Z')
    // A reindex and a CLI push have no target at all.
    await audit('catalog.reindex', null, { indexed: 2 }, '2026-09-04T13:00:00Z')
    await audit('library.push', null, { uploaded: 3 }, '2026-09-04T14:00:00Z', 'cli')

    const res = await request(app).get('/api/library/activity').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const rows = res.body.rows as any[]
    expect(rows.map(r => [r.actor, r.verb, r.target?.slug ?? null])).toEqual([
      ['cli', 'pushed files from the command line', null],
      ['maria', 'reindexed the library', null],
      ['maria', 'downloaded', 'organizations'],
      ['maria', 'uploaded', 'organizations'],
      ['maria', 'updated the page', 'home'],
    ])
    expect(rows[2].target).toEqual({ slug: 'organizations', title: 'Organizations', kind: 'dataset', href: '/library/organizations' })
    expect(rows[4].target).toEqual({ slug: 'home', title: 'Start here', kind: 'wiki', href: '/wiki/home' })
    expect(rows[0].at).toBe('2026-09-04T14:00:00.000Z')
  })

  it('drops a target that is no longer in the catalog rather than linking to a 404', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('library.file', 'deleted-entry', { title: 'Gone' }, '2026-09-04T10:00:00Z')
    const res = await request(app).get('/api/library/activity').set('Cookie', auth.cookie)
    expect(res.body.rows).toEqual([{ at: '2026-09-04T10:00:00.000Z', actor: 'maria', verb: 'filed', target: null }])
  })

  it('defaults to 12 rows and clamps limit to 1..100', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    for (let i = 0; i < 30; i++) {
      await audit('library.upload', 'organizations', {}, `2026-09-0${(i % 9) + 1}T10:00:0${i % 10}Z`)
    }
    const def = await request(app).get('/api/library/activity').set('Cookie', auth.cookie)
    expect(def.body.rows).toHaveLength(12)

    const more = await request(app).get('/api/library/activity?limit=50').set('Cookie', auth.cookie)
    expect(more.body.rows).toHaveLength(30)

    const huge = await request(app).get('/api/library/activity?limit=9999').set('Cookie', auth.cookie)
    expect(huge.body.limit).toBe(100)

    const junk = await request(app).get('/api/library/activity?limit=-4').set('Cookie', auth.cookie)
    expect(junk.body.limit).toBe(1)

    const nonsense = await request(app).get('/api/library/activity?limit=abc').set('Cookie', auth.cookie)
    expect(nonsense.body.limit).toBe(12)
  })
})

/**
 * P5-88. The landing's own call was the slowest thing on it: 1.1 s, spent
 * reading kb.json from the bucket and then resolving every pinned slug
 * against the catalog — one lookup per pin, each one scanning the archived
 * rows. The answer only changes when the catalog does, so it is computed when
 * the catalog does.
 */
describe('GET /api/library/kb — caching (P5-88)', () => {
  const kbReads = () => fake.calls.filter(c => c === 'GetObjectCommand:library/kb.json').length
  const catalogReads = () => sql.filter(s => s.includes('FROM library_catalog')).length

  it('reads the bucket and the catalog on the first call and neither on the second', async () => {
    fake.seed('library/kb.json', JSON.stringify(KB_JSON))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auth = await login()
    await reindex(auth)

    // From here on, only the two GETs below touch the bucket — the reindex's
    // own mirror sync reads kb.json like any other file.
    sql = []
    fake.calls.length = 0
    const first = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(first.status).toBe(200)
    expect(first.body.pinned.map((p: any) => p.slug)).toEqual(['home', 'organizations'])
    expect(kbReads()).toBe(1)
    expect(catalogReads()).toBeGreaterThan(0)

    sql = []
    const second = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(second.body).toEqual(first.body)
    expect(kbReads()).toBe(1)
    expect(catalogReads()).toBe(0)
    warn.mockRestore()
  })

  it('rebuilds after a reindex, and after any write that changes a pinned entry', async () => {
    fake.seed('library/kb.json', JSON.stringify({ homeSlug: 'home', pinned: ['organizations'] }))
    const auth = await login()
    await reindex(auth)
    const first = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(first.body.pinned[0].title).toBe('Organizations')

    // A retitled manifest, pushed and reindexed: the bucket is truth again.
    fake.seed(
      'library/datasets/organizations/meta.json',
      JSON.stringify({ title: 'Network organizations', category: 'network', status: 'published', description: 'Renamed.' }),
    )
    await reindex(auth)
    const afterReindex = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(afterReindex.body.pinned[0].title).toBe('Network organizations')

    // And a write that is not a reindex — filing a note here — still moves
    // the catalog on, so the landing cannot serve a card from before it.
    const created = await request(app)
      .post('/api/library/entries')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'A new idea', body: 'Worth trying.' })
    expect(created.status).toBe(201)
    sql = []
    const afterWrite = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(afterWrite.body.pinned[0].title).toBe('Network organizations')
    expect(catalogReads()).toBeGreaterThan(0)
  })

  it('sends Cache-Control: private, no-cache and 304s an unchanged config', async () => {
    fake.seed('library/kb.json', JSON.stringify(KB_JSON))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auth = await login()
    await reindex(auth)

    const first = await request(app).get('/api/library/kb').set('Cookie', auth.cookie)
    expect(first.headers['cache-control']).toBe('private, no-cache')
    expect(first.headers.etag).toBeTruthy()

    const again = await request(app).get('/api/library/kb').set('Cookie', auth.cookie).set('If-None-Match', first.headers.etag)
    expect(again.status).toBe(304)
    expect(again.text).toBeFalsy()
    warn.mockRestore()
  })
})
