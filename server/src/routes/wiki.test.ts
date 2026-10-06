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
 * P5-14: wiki CRUD API. Pages are flat markdown files (library/wiki/<slug>.md)
 * indexed into library_catalog as kind 'wiki'; title = first `# Heading`.
 * Runs against the real createApp() (auth guard, CSRF, audit wiring).
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')

let passwordHash: string
beforeAll(async () => {
  // Cheap argon2 params: per-test logins at production cost starve parallel
  // vitest workers (see libraryCatalog.test.ts). Verify cost is embedded in
  // the hash, so production wiring is unaffected.
  passwordHash = await argon2.hash('wiki-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
  dataDir = mkdtempSync(join(tmpdir(), 'blo-wiki-test-'))
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
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username: 'maria', password: 'wiki-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function putPage(auth: { cookie: string; csrf: string }, slug: string, markdown: string) {
  return request(app)
    .put(`/api/wiki/${slug}`)
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .set('Content-Type', 'text/markdown')
    .send(markdown)
}

async function reindex(auth: { cookie: string; csrf: string }) {
  return request(app)
    .post('/api/library/reindex')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
}

describe('auth boundary', () => {
  it('read and write both bare-401 without a session', async () => {
    for (const req of [
      request(app).get('/api/wiki/strategy'),
      request(app).put('/api/wiki/strategy').set('Content-Type', 'text/markdown').send('# X'),
    ]) {
      const res = await req
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
  })

  it('PUT without a CSRF token is refused', async () => {
    const { cookie } = await login()
    const res = await request(app)
      .put('/api/wiki/strategy')
      .set('Cookie', cookie)
      .set('Content-Type', 'text/markdown')
      .send('# X')
    expect(res.status).toBe(403)
  })
})

describe('PUT /api/wiki/:slug', () => {
  it('creates a page: bucket file, 201, and a catalog row with the H1 title', async () => {
    const auth = await login()
    const res = await putPage(auth, 'tn-strategy', '# TN Strategy\n\nWhere we focus and why.')
    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({ slug: 'tn-strategy', title: 'TN Strategy', created: true })

    // Bucket is truth: the markdown landed as a flat file.
    expect(fake.objects.get('library/wiki/tn-strategy.md')?.toString('utf8')).toBe(
      '# TN Strategy\n\nWhere we focus and why.',
    )

    // Indexed for listing via the existing catalog API.
    const list = await request(app)
      .get('/api/library/catalog?kind=wiki')
      .set('Cookie', auth.cookie)
    expect(list.status).toBe(200)
    expect(list.body.entries).toHaveLength(1)
    expect(list.body.entries[0]).toMatchObject({
      slug: 'tn-strategy',
      kind: 'wiki',
      title: 'TN Strategy',
      status: 'published',
    })
  })

  it('updates an existing page in place (200, not created)', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nv1')
    const res = await putPage(auth, 'tn-strategy', '# TN Strategy, revised\n\nv2')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ title: 'TN Strategy, revised', created: false })

    const read = await request(app).get('/api/wiki/tn-strategy').set('Cookie', auth.cookie)
    expect(read.body.markdown).toContain('v2')
    // Still exactly one catalog row.
    const list = await request(app)
      .get('/api/library/catalog?kind=wiki')
      .set('Cookie', auth.cookie)
    expect(list.body.entries).toHaveLength(1)
    expect(list.body.entries[0].title).toBe('TN Strategy, revised')
  })

  it('audits wiki.create then wiki.update', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# One')
    await putPage(auth, 'tn-strategy', '# Two')
    const audit = await libraryQuery(
      `SELECT actor, action, target FROM library_audit WHERE action LIKE 'wiki.%' ORDER BY id`,
    )
    expect(audit.rows.map((r: any) => r.action)).toEqual(['wiki.create', 'wiki.update'])
    expect(audit.rows[0].actor).toBe('maria')
    expect(audit.rows[0].target).toBe('tn-strategy')
  })

  it('falls back to the slug as title when there is no heading', async () => {
    const auth = await login()
    const res = await putPage(auth, 'scratch-notes', 'just some text, no heading')
    expect(res.status).toBe(201)
    expect(res.body.title).toBe('scratch-notes')
  })

  it.each(['Bad Slug', 'UPPER', 'dot.dot', 'sl/ash', '-leading'])(
    'rejects invalid slug %j with a 400',
    async (slug) => {
      const auth = await login()
      const res = await request(app)
        .put(`/api/wiki/${encodeURIComponent(slug)}`)
        .set('Cookie', auth.cookie)
        .set('X-CSRF-Token', auth.csrf)
        .set('Content-Type', 'text/markdown')
        .send('# X')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/slug/i)
      expect(fake.objects.size).toBe(0)
    },
  )

  it('409s when the slug is already taken by a non-wiki catalog entry', async () => {
    const auth = await login()
    // A note occupies the slug (slugs are globally unique in library_catalog).
    const note = await request(app)
      .post('/api/library/entries')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'tn strategy', body: 'an idea about strategy' })
    expect(note.status).toBe(201)
    const res = await putPage(auth, note.body.entry.slug, '# Clash')
    expect(res.status).toBe(409)
    expect(res.body.error).toMatch(/taken/i)
  })

  it('rejects an empty body with a 400', async () => {
    const auth = await login()
    const res = await putPage(auth, 'empty-page', '   \n  ')
    expect(res.status).toBe(400)
    expect(fake.objects.size).toBe(0)
  })

  it('rejects a non-text content type with a helpful 400', async () => {
    const auth = await login()
    const res = await request(app)
      .put('/api/wiki/strategy')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ markdown: '# X' }) // JSON, not raw text
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/text/i)
  })

  it('rejects a page over 1 MB with a 413 naming the limit', async () => {
    const auth = await login()
    const res = await putPage(auth, 'huge', '#'.repeat(1024 * 1024 + 10))
    expect(res.status).toBe(413)
    expect(res.body.error).toMatch(/1 MB/i)
    expect(fake.objects.size).toBe(0)
  })
})

describe('GET /api/wiki/:slug', () => {
  it('returns slug, title, and raw markdown', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nSee [notes](/wiki/scratch-notes).')
    const res = await request(app).get('/api/wiki/tn-strategy').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      slug: 'tn-strategy',
      title: 'TN Strategy',
      markdown: '# TN Strategy\n\nSee [notes](/wiki/scratch-notes).',
      updatedAt: expect.any(String), // P5-49 conflict baseline
    })
  })

  it('404s (bare) on an unknown page', async () => {
    const auth = await login()
    const res = await request(app).get('/api/wiki/nope').set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })
})

describe('reindex integration (files are the truth)', () => {
  it('rebuilds wiki rows from the bucket alone, including external pushes', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nBody.')
    // A dev pushes a page from the CLI: bucket only, no catalog row yet.
    fake.seed('library/wiki/field-guide.md', '# Field Guide\n\nHow we canvass.')

    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app)
      .get('/api/library/catalog?kind=wiki')
      .set('Cookie', auth.cookie)
    expect(list.body.entries.map((e: any) => [e.slug, e.title]).sort()).toEqual([
      ['field-guide', 'Field Guide'],
      ['tn-strategy', 'TN Strategy'],
    ])

    // And the page body is servable (external push readable without a PUT).
    const read = await request(app).get('/api/wiki/field-guide').set('Cookie', auth.cookie)
    expect(read.status).toBe(200)
    expect(read.body.markdown).toContain('canvass')
  })

  it('drops wiki rows whose files vanished from the bucket', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy')
    fake.objects.delete('library/wiki/tn-strategy.md')
    await reindex(auth)
    const res = await request(app).get('/api/wiki/tn-strategy').set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
  })

  it('ignores non-markdown strays under wiki/ instead of crashing', async () => {
    const auth = await login()
    fake.seed('library/wiki/.DS_Store', 'junk')
    fake.seed('library/wiki/real-page.md', '# Real Page')
    expect((await reindex(auth)).status).toBe(200)
    const list = await request(app)
      .get('/api/library/catalog?kind=wiki')
      .set('Cookie', auth.cookie)
    expect(list.body.entries.map((e: any) => e.slug)).toEqual(['real-page'])
  })
})

/**
 * P5-49: two people editing the same page. The client sends back the
 * `updatedAt` it loaded as If-Unmodified-Since; a page that moved on in the
 * meantime is refused with a 412 naming who moved it, and the client can
 * retry without the header to overwrite deliberately.
 */
describe('conflict detection (If-Unmodified-Since)', () => {
  const STALE = '2020-01-01T00:00:00.000Z'

  function putPageIfUnmodified(
    auth: { cookie: string; csrf: string },
    slug: string,
    markdown: string,
    since: string,
  ) {
    return putPage(auth, slug, markdown).set('If-Unmodified-Since', since)
  }

  it('GET hands back the updatedAt the client must send back', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nv1')
    const res = await request(app).get('/api/wiki/tn-strategy').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(typeof res.body.updatedAt).toBe('string')
    expect(Number.isNaN(Date.parse(res.body.updatedAt))).toBe(false)
  })

  it('saves when the page has not moved since it was loaded', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nv1')
    const read = await request(app).get('/api/wiki/tn-strategy').set('Cookie', auth.cookie)
    const res = await putPageIfUnmodified(auth, 'tn-strategy', '# TN Strategy\n\nv2', read.body.updatedAt)
    expect(res.status).toBe(200)
    expect(res.body.created).toBe(false)
  })

  it('412s with the current timestamp and the last editor when it moved underneath', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nv1')
    const res = await putPageIfUnmodified(auth, 'tn-strategy', '# Mine\n\nv2', STALE)
    expect(res.status).toBe(412)
    expect(res.body.error).toMatch(/changed/i)
    expect(res.body.actor).toBe('maria')
    expect(typeof res.body.updatedAt).toBe('string')
    // Nothing was written: the page on disk is still v1.
    expect(fake.objects.get('library/wiki/tn-strategy.md')?.toString('utf8')).toContain('v1')
  })

  it('overwrites when the client retries without the header ("save anyway")', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nv1')
    expect((await putPageIfUnmodified(auth, 'tn-strategy', '# Mine\n\nv2', STALE)).status).toBe(412)
    const res = await putPage(auth, 'tn-strategy', '# Mine\n\nv2')
    expect(res.status).toBe(200)
    expect(fake.objects.get('library/wiki/tn-strategy.md')?.toString('utf8')).toContain('v2')
  })

  it('ignores the header for a page that does not exist yet', async () => {
    const auth = await login()
    const res = await putPageIfUnmodified(auth, 'brand-new', '# Brand New', STALE)
    expect(res.status).toBe(201)
  })

  it('ignores an unparseable header rather than blocking the save', async () => {
    const auth = await login()
    await putPage(auth, 'tn-strategy', '# TN Strategy\n\nv1')
    const res = await putPageIfUnmodified(auth, 'tn-strategy', '# TN Strategy\n\nv2', 'not a date')
    expect(res.status).toBe(200)
  })
})
