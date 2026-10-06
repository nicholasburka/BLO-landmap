import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/** P5-25: file downloads against the real createApp() with pg-mem + fake bucket. */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { contentTypeFor, attachmentHeader, isInlineSafe, dispositionHeader } = await import('./libraryFile.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('file-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x0a, 0x1a])
const CSV = 'name,score\nÀlpha,1\n'

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-file-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  fake.seed('library/datasets/orgs/organizations.csv', CSV)
  fake.seed('library/datasets/orgs/meta.json', JSON.stringify({ title: 'Organizations', category: 'network', status: 'published', tags: [] }))
  fake.seed('library/documents/plan/Five_Year_Plan.pdf', PDF)
  fake.seed('library/documents/plan/meta.json', JSON.stringify({ title: 'Plan', category: 'strategy', status: 'published' }))
  fake.seed('library/documents/plan/notes.html', '<script>alert(1)</script>')
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
    .set('X-Forwarded-For', `10.96.0.${++loginIp}`)
    .send({ username: 'maria', password: 'file-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

async function ready() {
  const auth = await login()
  const res = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  expect(res.status).toBe(200)
  return auth
}

describe('GET /api/library/file/:slug/:filename', () => {
  it('bare-401s without a session', async () => {
    const res = await request(app).get('/api/library/file/orgs/organizations.csv')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('streams the bytes byte-identical with attachment + content-type headers, and audits', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/file/orgs/organizations.csv').set('Cookie', auth.cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="organizations.csv"; filename*=UTF-8''organizations.csv`)
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(CSV)))
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect((res.body as Buffer).toString('utf8')).toBe(CSV)
    const audit = await libraryQuery(`SELECT action, target, detail FROM library_audit WHERE action = 'library.download'`)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].target).toBe('library/datasets/orgs/organizations.csv')
    // mirror now holds the file (lazy fetch on the first miss)
    expect(existsSync(join(dataDir, 'library/datasets/orgs/organizations.csv'))).toBe(true)
  })

  it('serves binary files byte-identical (keys never contain spaces — the bucket service refuses them)', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/file/plan/Five_Year_Plan.pdf').set('Cookie', auth.cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toContain('filename="Five_Year_Plan.pdf"')
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0)
  })

  it('404s identically for an unknown slug, an unknown file, the manifest of a different entry, and traversal attempts', async () => {
    const auth = await ready()
    for (const path of [
      '/api/library/file/nope/organizations.csv',
      '/api/library/file/orgs/missing.csv',
      '/api/library/file/orgs/..%2F..%2Fdocuments%2Fplan%2Fmeta.json',
      '/api/library/file/orgs/organizations.csv%00',
    ]) {
      const res = await request(app).get(path).set('Cookie', auth.cookie)
      expect(res.status, path).toBe(404)
      expect(res.body).toEqual({ error: 'not found' })
    }
  })
})

describe('helpers', () => {
  it('maps extensions to content types with an octet-stream fallback', () => {
    expect(contentTypeFor('a.CSV')).toBe('text/csv; charset=utf-8')
    expect(contentTypeFor('a.geojson')).toBe('application/geo+json')
    expect(contentTypeFor('a.docx')).toContain('wordprocessingml')
    expect(contentTypeFor('a.unknown')).toBe('application/octet-stream')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
  })

  it('builds an RFC 6266 attachment header with an ASCII fallback and UTF-8 filename*', () => {
    expect(attachmentHeader('Résumé "final".pdf')).toBe(`attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20%22final%22.pdf`)
  })
})

describe('in-app viewing (P5-44, ?disposition=inline)', () => {
  it('serves a PDF inline and audits it as a view, not a download', async () => {
    const auth = await ready()
    const res = await request(app)
      .get('/api/library/file/plan/Five_Year_Plan.pdf?disposition=inline')
      .set('Cookie', auth.cookie)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', c => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe(`inline; filename="Five_Year_Plan.pdf"; filename*=UTF-8''Five_Year_Plan.pdf`)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect((res.body as Buffer).equals(PDF)).toBe(true)
    const views = await libraryQuery(`SELECT action FROM library_audit WHERE action = 'library.view'`)
    expect(views.rows).toHaveLength(1)
    const downloads = await libraryQuery(`SELECT action FROM library_audit WHERE action = 'library.download'`)
    expect(downloads.rows).toHaveLength(0)
  })

  it('serves a text file inline', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/file/orgs/organizations.csv?disposition=inline').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toContain('inline;')
  })

  it('refuses to serve HTML inline — it stays an attachment even when inline is asked for', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/file/plan/notes.html?disposition=inline').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    // .html is not in the type table → octet-stream → never inline
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toContain('attachment;')
    const views = await libraryQuery(`SELECT action FROM library_audit WHERE action = 'library.view'`)
    expect(views.rows).toHaveLength(0)
  })

  it('isInlineSafe allows renderable types and refuses executable/opaque ones', () => {
    for (const ok of ['a.pdf', 'b.png', 'c.jpg', 'd.txt', 'e.md', 'f.csv', 'g.json', 'h.geojson']) {
      expect(isInlineSafe(ok)).toBe(true)
    }
    for (const no of ['a.html', 'b.svg', 'c.docx', 'd.xlsx', 'e.zip', 'f.rtf', 'g.unknown']) {
      expect(isInlineSafe(no)).toBe(false)
    }
  })

  it('dispositionHeader builds inline and attachment forms', () => {
    expect(dispositionHeader('inline', 'a b.pdf')).toBe(`inline; filename="a b.pdf"; filename*=UTF-8''a%20b.pdf`)
    expect(dispositionHeader('attachment', 'a.pdf')).toBe(`attachment; filename="a.pdf"; filename*=UTF-8''a.pdf`)
  })
})
