import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-10: upload API → incoming/<uuid>/. Runs against the real createApp()
 * with a pg-mem library store and an injected fake bucket, so the wiring
 * under test (auth guard, CSRF, busboy streaming, bucket-first write,
 * catalog insert, audit) is production's.
 *
 * Spec anchors: Example 1 (filed upload → needs-review + manifest + audit),
 * Example 5 (quick drop → needs-cataloging, attributed), Example 8 (reject
 * only on SIZE with a clear message — never on file type).
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { setLinkFetchDefaults, resetLinkFetchQueue, whenQueueIdle } = await import('../services/linkFetchQueue.js')

let passwordHash: string
beforeAll(async () => {
  // Minimum-cost hash: verify cost is embedded in the hash, so cheap params
  // here keep parallel vitest workers responsive without touching prod wiring.
  passwordHash = await argon2.hash('upload-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
  dataDir = mkdtempSync(join(tmpdir(), 'blo-upload-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  delete process.env.LIBRARY_UPLOAD_MAX_BYTES
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// Unique X-Forwarded-For per login keeps each test inside its own
// rate-limit bucket (limiter is 10/hr/IP; app trusts one proxy hop).
let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.99.1.${++loginIp}`)
    .send({ username: 'maria', password: 'upload-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function upload(auth: { cookie: string; csrf: string }) {
  return request(app)
    .post('/api/library/upload')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
}

const CSV = Buffer.from('fips,share\n47157,0.31\n')

const tempUploads = () => readdirSync(tmpdir()).filter(n => n.startsWith('blo-upload-'))

/** Raw HTTP against a listening app: supertest cannot hang up mid-body. */
async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn((server.address() as AddressInfo).port)
  } finally {
    await new Promise<void>(resolve => void server.close(() => resolve()))
  }
}

const BOUNDARY = 'blotestboundary'

/** The opening of a multipart body, up to (not including) the file bytes. */
function partHeader(filename = 'big.csv'): string {
  return (
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    'Content-Type: text/csv\r\n\r\n'
  )
}

/** POST a deliberately incomplete multipart body: either declaring more
 *  bytes than we send and hanging up (`abort`), or sending exactly what we
 *  declared but stopping mid-part so the closing boundary never arrives. */
function sendPartial(
  port: number,
  auth: { cookie: string; csrf: string },
  mode: 'abort' | 'truncate',
): Promise<void> {
  const head = partHeader()
  const bytes = Buffer.from('a'.repeat(2048))
  const body = Buffer.concat([Buffer.from(head), bytes])
  return new Promise(resolve => {
    const req = httpRequest({
      port,
      host: '127.0.0.1',
      method: 'POST',
      path: '/api/library/upload',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
        // The abort case promises far more than it delivers, then vanishes.
        'Content-Length': String(body.length + (mode === 'abort' ? 10_000 : 0)),
        Cookie: auth.cookie,
        'X-CSRF-Token': auth.csrf,
      },
    })
    req.on('error', () => resolve())
    req.on('response', res => {
      res.resume()
      res.on('end', () => resolve())
    })
    req.write(body, () => {
      if (mode === 'abort') {
        req.destroy()
        resolve()
      } else {
        req.end()
      }
    })
  })
}

/** Wait for the server's cleanup to settle (it runs off the request). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 10))
}

describe('auth boundary', () => {
  it('bare-401s without a session', async () => {
    const res = await request(app)
      .post('/api/library/upload')
      .attach('file', CSV, 'data.csv')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('403s a logged-in upload without a CSRF token', async () => {
    const { cookie } = await login()
    const res = await request(app)
      .post('/api/library/upload')
      .set('Cookie', cookie)
      .attach('file', CSV, 'data.csv')
    expect(res.status).toBe(403)
  })
})

describe('filed upload (Example 1)', () => {
  it('stores the file + manifest under incoming/<uuid>/ and catalogs it needs-review', async () => {
    const auth = await login()
    const res = await upload(auth)
      .field('title', 'Shelby County tax sales 2025')
      .field('category', 'land')
      .field('tags', 'tennessee, tax-sale')
      .field('description', 'Raw scrape from the assessor site')
      .attach('file', CSV, { filename: 'tax-sales.csv', contentType: 'text/csv' })

    expect(res.status).toBe(201)
    const { slug, key, status, size } = res.body
    expect(slug).toMatch(/^[0-9a-f-]{36}$/)
    expect(status).toBe('needs-review')
    expect(key).toBe(`library/incoming/${slug}/tax-sales.csv`)
    expect(size).toBe(CSV.length)

    // Bucket holds the file byte-identical plus a manifest meta.json.
    expect(fake.objects.get(key)).toEqual(CSV)
    const meta = JSON.parse(fake.objects.get(`library/incoming/${slug}/meta.json`)!.toString('utf8'))
    expect(meta).toMatchObject({
      title: 'Shelby County tax sales 2025',
      category: 'land',
      status: 'needs-review',
      tags: ['tennessee', 'tax-sale'],
      description: 'Raw scrape from the assessor site',
      uploadedBy: 'maria',
      originalFilename: 'tax-sales.csv',
      size: CSV.length,
    })
    expect(typeof meta.uploadedAt).toBe('string')
    expect(new Date(meta.uploadedAt).toString()).not.toBe('Invalid Date')

    // Visible in the catalog immediately — no reindex required.
    const detail = await request(app)
      .get(`/api/library/catalog/${slug}`)
      .set('Cookie', auth.cookie)
    expect(detail.status).toBe(200)
    expect(detail.body.entry).toMatchObject({
      kind: 'incoming',
      title: 'Shelby County tax sales 2025',
      category: 'land',
      status: 'needs-review',
      tags: ['tennessee', 'tax-sale'],
    })
    expect(detail.body.entry.files.map((f: { key: string }) => f.key).sort()).toEqual([
      `library/incoming/${slug}/meta.json`,
      `library/incoming/${slug}/tax-sales.csv`,
    ])
  })

  it('writes an attributed audit entry', async () => {
    const auth = await login()
    const res = await upload(auth)
      .field('title', 'Audit me')
      .attach('file', CSV, 'data.csv')
    expect(res.status).toBe(201)
    const audit = await libraryQuery(
      `SELECT actor, action, target FROM library_audit WHERE action = 'library.upload'`,
    )
    expect(audit.rows.length).toBe(1)
    expect(audit.rows[0].actor).toBe('maria')
    expect(audit.rows[0].target).toBe(res.body.slug)
  })

  it('survives a reindex: the bucket tree reproduces the same catalog entry', async () => {
    const auth = await login()
    const res = await upload(auth)
      .field('title', 'Reindex survivor')
      .field('category', 'research')
      .attach('file', CSV, 'data.csv')
    expect(res.status).toBe(201)

    const re = await request(app)
      .post('/api/library/reindex')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(re.status).toBe(200)
    expect(re.body.indexed).toBe(1)

    const detail = await request(app)
      .get(`/api/library/catalog/${res.body.slug}`)
      .set('Cookie', auth.cookie)
    expect(detail.status).toBe(200)
    expect(detail.body.entry).toMatchObject({
      kind: 'incoming',
      title: 'Reindex survivor',
      category: 'research',
      status: 'needs-review',
    })
  })
})

describe('quick drop (Example 5)', () => {
  it('accepts a bare file, queues it needs-cataloging, attributed to the uploader', async () => {
    const auth = await login()
    const res = await upload(auth).attach('file', CSV, 'mystery-drop.csv')
    expect(res.status).toBe(201)
    expect(res.body.status).toBe('needs-cataloging')

    const meta = JSON.parse(
      fake.objects.get(`library/incoming/${res.body.slug}/meta.json`)!.toString('utf8'),
    )
    expect(meta.status).toBe('needs-cataloging')
    expect(meta.title).toBe('mystery-drop.csv')
    expect(meta.uploadedBy).toBe('maria')

    const list = await request(app)
      .get('/api/library/catalog?status=needs-cataloging')
      .set('Cookie', auth.cookie)
    expect(list.body.entries.map((e: { slug: string }) => e.slug)).toEqual([res.body.slug])
  })
})

describe('size limit (Example 8)', () => {
  it('rejects an oversize file with a clear message and leaves nothing in the bucket', async () => {
    process.env.LIBRARY_UPLOAD_MAX_BYTES = '1024'
    const auth = await login()
    const res = await upload(auth)
      .field('title', 'Too big')
      .attach('file', Buffer.alloc(4096, 0x61), 'big.bin')
    expect(res.status).toBe(413)
    expect(res.body.error).toContain('1024')
    expect([...fake.objects.keys()].filter(k => k.startsWith('library/incoming/'))).toEqual([])
    const rows = await libraryQuery(`SELECT slug FROM library_catalog`)
    expect(rows.rows.length).toBe(0)
  })

  it('never rejects on file type: a zip is stored exactly as received', async () => {
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f])
    const auth = await login()
    const res = await upload(auth).attach('file', zipBytes, {
      filename: 'annie-drive-backup.zip',
      contentType: 'application/zip',
    })
    expect(res.status).toBe(201)
    expect(fake.objects.get(res.body.key)).toEqual(zipBytes)
    const meta = JSON.parse(
      fake.objects.get(`library/incoming/${res.body.slug}/meta.json`)!.toString('utf8'),
    )
    expect(meta.contentType).toBe('application/zip')
  })
})

describe('PATCH /api/library/catalog/:slug — filing the queue (P5-11, Example 5)', () => {
  it('files a quick-dropped entry: meta.json rewritten, status → needs-review, audited', async () => {
    const auth = await login()
    const up = await upload(auth).attach('file', CSV, 'mystery-drop.csv')
    expect(up.status).toBe(201)
    expect(up.body.status).toBe('needs-cataloging')
    const slug = up.body.slug

    const res = await request(app)
      .patch(`/api/library/catalog/${slug}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({
        title: 'Mystery solved',
        category: 'research',
        tags: ['tennessee'],
        description: 'It was tax parcels all along',
      })
    expect(res.status).toBe(200)
    expect(res.body.entry).toMatchObject({
      slug,
      kind: 'incoming',
      title: 'Mystery solved',
      category: 'research',
      status: 'needs-review',
      tags: ['tennessee'],
    })

    // The bucket manifest is the truth: rewritten with the filing fields,
    // upload attribution preserved.
    const meta = JSON.parse(
      fake.objects.get(`library/incoming/${slug}/meta.json`)!.toString('utf8'),
    )
    expect(meta).toMatchObject({
      title: 'Mystery solved',
      category: 'research',
      status: 'needs-review',
      description: 'It was tax parcels all along',
      uploadedBy: 'maria',
      originalFilename: 'mystery-drop.csv',
    })

    // A reindex reproduces the filed entry from the bucket alone.
    await request(app)
      .post('/api/library/reindex')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    const detail = await request(app)
      .get(`/api/library/catalog/${slug}`)
      .set('Cookie', auth.cookie)
    expect(detail.body.entry).toMatchObject({ title: 'Mystery solved', status: 'needs-review' })

    const audit = await libraryQuery(
      `SELECT actor, target FROM library_audit WHERE action = 'library.file'`,
    )
    expect(audit.rows.length).toBe(1)
    expect(audit.rows[0]).toMatchObject({ actor: 'maria', target: slug })
  })

  it('guards: 401 anon, 403 without CSRF, 404 unknown slug, 409 non-incoming kind', async () => {
    const anon = await request(app).patch('/api/library/catalog/nope').send({ title: 'x' })
    expect(anon.status).toBe(401)

    const auth = await login()
    const noCsrf = await request(app)
      .patch('/api/library/catalog/nope')
      .set('Cookie', auth.cookie)
      .send({ title: 'x' })
    expect(noCsrf.status).toBe(403)

    const missing = await request(app)
      .patch('/api/library/catalog/nope')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'x' })
    expect(missing.status).toBe(404)

    // A dataset entry (not incoming) cannot be filed through this endpoint.
    fake.seed('library/datasets/tn-heirs/data.csv', 'a,b\n1,2\n')
    await request(app)
      .post('/api/library/reindex')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    const wrongKind = await request(app)
      .patch('/api/library/catalog/tn-heirs')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'x' })
    expect(wrongKind.status).toBe(409)
  })
})

describe('edge cases', () => {
  it('sanitizes unsafe filenames for the stored key but preserves the original in the manifest', async () => {
    const auth = await login()
    const res = await upload(auth).attach('file', CSV, 'My Data (final)…v2.csv')
    expect(res.status).toBe(201)
    // Stored key obeys the SAFE_KEY charset (no spaces/parens/unicode).
    expect(res.body.key).toMatch(/^library\/incoming\/[0-9a-f-]{36}\/[A-Za-z0-9][A-Za-z0-9._-]*$/)
    const meta = JSON.parse(
      fake.objects.get(`library/incoming/${res.body.slug}/meta.json`)!.toString('utf8'),
    )
    expect(meta.originalFilename).toBe('My Data (final)…v2.csv')
  })

  it('400s when no file part is present', async () => {
    const auth = await login()
    const res = await upload(auth).field('title', 'No file here')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/file/i)
  })

  it('400s a non-multipart POST', async () => {
    const auth = await login()
    const res = await upload(auth).send({ title: 'json body' })
    expect(res.status).toBe(400)
  })

  it('caps the stored filename but keeps its extension', async () => {
    const auth = await login()
    const res = await upload(auth).attach('file', CSV, `${'n'.repeat(300)}.csv`)
    expect(res.status).toBe(201)
    const stored = res.body.key.split('/').pop()
    expect(stored.length).toBeLessThanOrEqual(120)
    expect(stored.endsWith('.csv')).toBe(true)
  })
})

describe('temp file hygiene', () => {
  it('leaves no temp file when the client hangs up mid-upload', async () => {
    const auth = await login()
    const before = tempUploads()
    await withServer(port => sendPartial(port, auth, 'abort'))
    await settle()
    expect(tempUploads()).toEqual(before)
  })

  it('leaves no temp file when the multipart body ends mid-part', async () => {
    const auth = await login()
    const before = tempUploads()
    await withServer(port => sendPartial(port, auth, 'truncate'))
    await settle()
    expect(tempUploads()).toEqual(before)
  })
})

describe('form limits', () => {
  it('400s a body with more parts than the form has', async () => {
    const auth = await login()
    let req = upload(auth)
    for (let i = 0; i < 12; i++) req = req.field(`extra${i}`, 'x')
    const res = await req.attach('file', CSV, 'data.csv')
    expect(res.status).toBe(400)
    expect([...fake.objects.keys()].filter(k => k.startsWith('library/incoming/'))).toEqual([])
  })

  // The limit trips while the fields are still arriving, so the file part
  // reaches busboy AFTER we have answered and cleaned up.
  it('opens no temp file for a part that arrives after the limit was hit', async () => {
    const auth = await login()
    const before = tempUploads()
    // Nine fields trips the field limit while staying under the part limit,
    // so busboy keeps parsing and still hands us the file part.
    let req = upload(auth)
    for (let i = 0; i < 9; i++) req = req.field(`extra${i}`, 'x')
    expect((await req.attach('file', CSV, 'data.csv')).status).toBe(400)
    await settle()
    expect(tempUploads()).toEqual(before)
  })

  it('400s an oversized title, description, category, or tag list', async () => {
    const auth = await login()
    const long = await upload(auth).field('title', 'x'.repeat(200)).attach('file', CSV, 'data.csv')
    expect(long.status).toBe(400)
    expect(long.body.error).toMatch(/title/i)

    const desc = await upload(auth).field('description', 'x'.repeat(2100)).attach('file', CSV, 'data.csv')
    expect(desc.status).toBe(400)

    const cat = await upload(auth).field('category', 'x'.repeat(100)).attach('file', CSV, 'data.csv')
    expect(cat.status).toBe(400)

    const manyTags = await upload(auth)
      .field('tags', Array.from({ length: 25 }, (_, i) => `t${i}`).join(','))
      .attach('file', CSV, 'data.csv')
    expect(manyTags.status).toBe(400)

    const longTag = await upload(auth).field('tags', 'y'.repeat(50)).attach('file', CSV, 'data.csv')
    expect(longTag.status).toBe(400)

    expect([...fake.objects.keys()].filter(k => k.startsWith('library/incoming/'))).toEqual([])
  })
})

describe('stored content type', () => {
  it('labels the object from its stored extension, never from the client', async () => {
    const auth = await login()
    const res = await upload(auth).attach('file', CSV, {
      filename: 'notes.csv',
      contentType: 'text/html',
    })
    expect(res.status).toBe(201)
    // What the bucket will hand back on download comes from the extension…
    expect(fake.contentTypes.get(res.body.key)).toBe('text/csv; charset=utf-8')
    // …while the uploader's claim survives only as a record in the manifest.
    const meta = JSON.parse(fake.objects.get(`library/incoming/${res.body.slug}/meta.json`)!.toString('utf8'))
    expect(meta.contentType).toBe('text/html')
  })

  it('falls back to octet-stream for an extension we do not label', async () => {
    const auth = await login()
    const res = await upload(auth).attach('file', CSV, {
      filename: 'page.html',
      contentType: 'text/html',
    })
    expect(res.status).toBe(201)
    expect(fake.contentTypes.get(res.body.key)).toBe('application/octet-stream')
  })
})

// --- P5-47: uploads get the same suggestion pass ---------------------------

describe('the suggestion pass', () => {
  const suggestion = { title: 'Shelby County tax sales, 2025', category: 'land', tags: ['tax-sale'], summary: 'One row per parcel sold at tax sale.', at: '2026-09-05T00:00:00.000Z', model: 'stub' }

  afterEach(async () => {
    await whenQueueIdle()
    resetLinkFetchQueue()
  })

  it('proposes a filing for what was dropped, without applying any of it', async () => {
    const seen: string[] = []
    setLinkFetchDefaults({
      suggest: (async (slug: string) => {
        seen.push(slug)
        return suggestion
      }) as never,
    })
    const auth = await login()
    const res = await upload(auth).attach('file', CSV, { filename: 'tax-sales.csv', contentType: 'text/csv' })
    expect(res.status).toBe(201)
    const slug = res.body.slug

    await whenQueueIdle()
    expect(seen).toEqual([slug])
    const meta = JSON.parse(fake.objects.get(`library/incoming/${slug}/meta.json`)!.toString('utf8'))
    expect(meta.suggested).toMatchObject({ title: 'Shelby County tax sales, 2025', category: 'land' })
    // Untouched: a quick drop is still a quick drop until a person files it.
    expect(meta.title).toBe('tax-sales.csv')
    expect(meta.category).toBe('')
    expect(meta.status).toBe('needs-cataloging')

    const row = await libraryQuery(`SELECT meta FROM library_catalog WHERE slug = $1`, [slug])
    expect(row.rows[0].meta.suggested.summary).toBe('One row per parcel sold at tax sale.')
  })

  it('never makes the uploader wait for it', async () => {
    let release = () => {}
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    setLinkFetchDefaults({
      suggest: (async () => {
        await held
        return suggestion
      }) as never,
    })
    const auth = await login()
    // The pass is stuck on `held`, and the upload answers anyway.
    const res = await upload(auth).attach('file', CSV, { filename: 'tax-sales.csv', contentType: 'text/csv' })
    expect(res.status).toBe(201)
    const metaKey = `library/incoming/${res.body.slug}/meta.json`
    expect(JSON.parse(fake.objects.get(metaKey)!.toString('utf8')).suggested).toBeUndefined()

    release()
    await whenQueueIdle()
    expect(JSON.parse(fake.objects.get(metaKey)!.toString('utf8')).suggested).toMatchObject({ category: 'land' })
  })
})
