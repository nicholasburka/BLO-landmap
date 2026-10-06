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
import { makePdf, makeDocx, BROKEN_PDF } from '../testutils/fixtures/documents.js'

/** P5-46: the extracted-text route against the real createApp() with pg-mem
 *  and a fake bucket. */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, deleteFile, putFile } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { extractPending, derivedKey } = await import('../services/textExtract.js')
const { resetInternalRateLimit, INTERNAL_RATE_LIMIT_MAX } = await import('../middleware/internalRateLimit.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('text-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

const PDF = makePdf(['Page one is about land loss.', 'Page two names the counties.'])
const DOCX = makeDocx(['The fact manual, in Word.'])

beforeEach(async () => {
  await resetInternalRateLimit()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-text-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  fake.seed('library/documents/plan/Five_Year_Plan.pdf', PDF)
  fake.seed('library/documents/plan/Fact_Manual.docx', DOCX)
  fake.seed('library/documents/plan/Scan.pdf', BROKEN_PDF)
  fake.seed('library/documents/plan/deck.pptx', 'binary slides')
  fake.seed(
    'library/documents/plan/meta.json',
    JSON.stringify({ title: 'Plan', category: 'strategy', status: 'published' }),
  )
})

afterEach(async () => {
  // The reindex hook sweeps detached from the request; join it before the
  // bucket goes away.
  await extractPending()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.97.0.${++loginIp}`)
    .send({ username: 'maria', password: 'text-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

/** Log in, reindex, and wait for the extraction the reindex kicked off. */
async function ready() {
  const auth = await login()
  const res = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  expect(res.status).toBe(200)
  await extractPending()
  return auth
}

describe('GET /api/library/text/:slug/:filename', () => {
  it('bare-401s without a session', async () => {
    const res = await request(app).get('/api/library/text/plan/Five_Year_Plan.pdf')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('returns the text a reindex already extracted, page by page', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/text/plan/Five_Year_Plan.pdf').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.body.tool).toBe('pdfjs')
    expect(res.body.sourceSize).toBe(PDF.length)
    expect(res.body.pages.map((p: { n: number }) => p.n)).toEqual([1, 2])
    expect(res.body.pages[0].text).toContain('land loss')
    expect(res.body.pages[1].text).toContain('counties')
  })

  it('returns a Word file as one page of text', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/text/plan/Fact_Manual.docx').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.tool).toBe('mammoth')
    expect(res.body.pages).toHaveLength(1)
    expect(res.body.pages[0].text).toContain('The fact manual, in Word.')
  })

  it('extracts on the spot when nothing has been stored yet', async () => {
    const auth = await ready()
    // Drop the derived object the reindex wrote — the state a file uploaded
    // since the last reindex is in.
    await deleteFile(derivedKey('plan', 'Five_Year_Plan.pdf'))
    fake.calls.length = 0

    const res = await request(app).get('/api/library/text/plan/Five_Year_Plan.pdf').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.pages).toHaveLength(2)
    // ... and it stored what it read, so the next open is a plain read.
    expect(fake.calls).toContain(`PutObjectCommand:${derivedKey('plan', 'Five_Year_Plan.pdf')}`)
  })

  it('re-extracts when the stored text is older than the file', async () => {
    const auth = await ready()
    const replacement = makePdf(['The plan was rewritten and now says something else.'])
    expect(replacement.length).not.toBe(PDF.length)
    fake.seed('library/documents/plan/Five_Year_Plan.pdf', replacement)
    const re = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    expect(re.status).toBe(200)
    await extractPending()

    // Put the OLD text back, as it would still be if the sweep had not yet
    // reached this file: same key, but a sourceSize from the previous version.
    await putFile(
      derivedKey('plan', 'Five_Year_Plan.pdf'),
      JSON.stringify({
        pages: [{ n: 1, text: 'the text of the file this used to be' }],
        chars: 35,
        tool: 'pdfjs',
        sourceSize: PDF.length,
        sourceKey: 'library/documents/plan/Five_Year_Plan.pdf',
        extractedAt: new Date().toISOString(),
      }),
      'application/json',
    )

    const res = await request(app).get('/api/library/text/plan/Five_Year_Plan.pdf').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.sourceSize).toBe(replacement.length)
    expect(res.body.pages[0].text).toContain('rewritten')
  })

  it('passes an unreadable file through as { error } rather than failing the request', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/text/plan/Scan.pdf').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.error).toMatch(/could not be read/i)
    expect(res.body.pages).toBeUndefined()
  })

  it('404s identically for an unknown slug, an unknown file, and traversal attempts', async () => {
    const auth = await ready()
    for (const path of [
      '/api/library/text/nope/Five_Year_Plan.pdf',
      '/api/library/text/plan/missing.pdf',
      '/api/library/text/plan/..%2F..%2Fdocuments%2Fplan%2Fmeta.json',
      '/api/library/text/plan/Five_Year_Plan.pdf%00',
    ]) {
      const res = await request(app).get(path).set('Cookie', auth.cookie)
      expect(res.status, path).toBe(404)
      expect(res.body).toEqual({ error: 'not found' })
    }
  })

  it('415s a real file we hold no reader for', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/text/plan/deck.pptx').set('Cookie', auth.cookie)
    expect(res.status).toBe(415)
    expect(res.body.error).toMatch(/no text/i)
  })

  it('spends the shared per-user allowance', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/text/plan/Five_Year_Plan.pdf').set('Cookie', auth.cookie)
    expect(Number(res.headers['ratelimit-limit'])).toBe(INTERNAL_RATE_LIMIT_MAX)
  })
})
