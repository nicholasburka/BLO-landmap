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
 * P6-5 "Recently edited": the landing's first block, against the real app
 * with a pg-mem store and a fake bucket — the guard, the audit query and the
 * catalog resolution under test are production's.
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
  passwordHash = await argon2.hash('edits-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
  dataDir = mkdtempSync(join(tmpdir(), 'blo-edits-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/wiki/home.md', '# Start here\n\nThe front door.\n')
  fake.seed('library/datasets/organizations/organizations.csv', 'name\nBlack Farmer Fund\n')
  fake.seed(
    'library/datasets/organizations/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'network', status: 'published' }),
  )
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
    .send({ username: 'maria', password: 'edits-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

async function reindex(auth: { cookie: string; csrf: string }) {
  const res = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  expect(res.status).toBe(200)
}

async function clearAudit() {
  await libraryQuery(`DELETE FROM library_audit`)
}

async function audit(action: string, target: string | null, at: string, actor = 'maria') {
  await libraryQuery(
    `INSERT INTO library_audit (actor, action, target, detail, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, target, JSON.stringify({}), at],
  )
}

const get = (cookie: string, query = '') =>
  request(app).get(`/api/library/recent-edits${query}`).set('Cookie', cookie)

describe('GET /api/library/recent-edits', () => {
  it('refuses anonymous callers with a bare 401', async () => {
    const res = await request(app).get('/api/library/recent-edits')
    expect(res.status).toBe(401)
  })

  it('answers a member — every member sees what the team edited', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('wiki.update', 'home', '2026-09-04T10:00:00Z', 'nick')
    await audit('library.upload', 'organizations', '2026-09-04T11:00:00Z', 'maria')

    const res = await get(auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.rows.map((r: any) => [r.actor, r.target.slug, r.target.href])).toEqual([
      ['maria', 'organizations', '/library/organizations'],
      ['nick', 'home', '/wiki/home'],
    ])
  })

  it('counts only edits — a download, a report, a push and a reindex are not', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('library.download', 'organizations', '2026-09-04T10:00:00Z')
    await audit('place.report', 'atlanta', '2026-09-04T10:01:00Z')
    await audit('library.push', null, '2026-09-04T10:02:00Z', 'cli')
    await audit('catalog.reindex', null, '2026-09-04T10:03:00Z', 'cli')
    await audit('login.success', null, '2026-09-04T10:04:00Z')
    await audit('wiki.update', 'home', '2026-09-04T09:00:00Z')

    const res = await get(auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.rows.map((r: any) => r.target.slug)).toEqual(['home'])
  })

  it('shows one row per entry — three saves of a page is one thing that changed', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('wiki.create', 'home', '2026-09-04T08:00:00Z', 'nick')
    await audit('wiki.update', 'home', '2026-09-04T09:00:00Z', 'maria')
    await audit('wiki.update', 'home', '2026-09-04T10:00:00Z', 'nick')
    await audit('library.file', 'organizations', '2026-09-04T09:30:00Z', 'maria')

    const res = await get(auth.cookie)
    const rows = res.body.rows as any[]
    expect(rows.map(r => [r.target.slug, r.actor, r.at])).toEqual([
      ['home', 'nick', '2026-09-04T10:00:00.000Z'],
      ['organizations', 'maria', '2026-09-04T09:30:00.000Z'],
    ])
  })

  it('never links at something that is not in the catalog any more', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('library.file', 'deleted-last-week', '2026-09-04T10:00:00Z')
    await audit('wiki.update', 'home', '2026-09-04T09:00:00Z')

    const res = await get(auth.cookie)
    expect(res.body.rows.map((r: any) => r.target.slug)).toEqual(['home'])
  })

  it('clamps the limit rather than erroring on junk', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    await audit('wiki.update', 'home', '2026-09-04T09:00:00Z')
    await audit('library.file', 'organizations', '2026-09-04T10:00:00Z')

    expect((await get(auth.cookie, '?limit=1')).body.rows).toHaveLength(1)
    expect((await get(auth.cookie, '?limit=1')).body.limit).toBe(1)
    expect((await get(auth.cookie, '?limit=abc')).body.limit).toBe(12)
    expect((await get(auth.cookie, '?limit=-4')).body.limit).toBe(1)
    expect((await get(auth.cookie, '?limit=9999')).body.limit).toBe(100)
  })

  it('is empty, not broken, when nothing has been edited', async () => {
    const auth = await login()
    await reindex(auth)
    await clearAudit()
    const res = await get(auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.rows).toEqual([])
  })
})
