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
 * P5-12: text-only entries + ideas category. Runs against the real
 * createApp() with a pg-mem library store and an injected fake bucket.
 *
 * Design under test (resolves P5-8's hedge): notes are BUCKET-backed at
 * library/notes/<slug>/meta.json with the body inside the manifest — so
 * reindex reproduces them, and the sync CLI (P5-13) sees them for free.
 *
 * Spec anchors: Example 7 (New idea → title + body → ideas entry, status
 * open, attributed, shows in the filtered list), spec line 93 (ideas get
 * open/planned/done + a filtered list view).
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
  // Minimum-cost hash: verify cost is embedded in the hash, so cheap params
  // here keep parallel vitest workers responsive without touching prod wiring.
  passwordHash = await argon2.hash('notes-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
  dataDir = mkdtempSync(join(tmpdir(), 'blo-notes-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
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
    .set('X-Forwarded-For', `10.99.2.${++loginIp}`)
    .send({ username: 'maria', password: 'notes-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function createEntry(auth: { cookie: string; csrf: string }, body: Record<string, unknown>) {
  return request(app)
    .post('/api/library/entries')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send(body)
}

function patchEntry(auth: { cookie: string; csrf: string }, slug: string, body: Record<string, unknown>) {
  return request(app)
    .patch(`/api/library/catalog/${slug}`)
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send(body)
}

describe('auth boundary', () => {
  it('bare-401s without a session', async () => {
    const res = await request(app)
      .post('/api/library/entries')
      .send({ title: 'x', body: 'y' })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('403s a logged-in create without a CSRF token', async () => {
    const { cookie } = await login()
    const res = await request(app)
      .post('/api/library/entries')
      .set('Cookie', cookie)
      .send({ title: 'x', body: 'y' })
    expect(res.status).toBe(403)
  })
})

describe('POST /api/library/entries — new idea (Example 7)', () => {
  it('creates a bucket-backed ideas entry with status open and attribution', async () => {
    const auth = await login()
    const res = await createEntry(auth, {
      title: 'Track heirs outreach follow-ups',
      body: 'We keep losing the thread after first contact. A shared checklist per county would fix it.',
      tags: [' outreach ', 'process'],
    })
    expect(res.status).toBe(201)
    expect(res.body.entry).toMatchObject({
      slug: 'track-heirs-outreach-follow-ups',
      kind: 'note',
      title: 'Track heirs outreach follow-ups',
      category: 'ideas', // defaults when omitted
      status: 'open', // ideas open by default
      tags: ['outreach', 'process'],
    })
    expect(res.body.entry.meta.body).toContain('shared checklist')

    // The bucket manifest is the truth: body + attribution live inside it.
    const raw = fake.objects.get('library/notes/track-heirs-outreach-follow-ups/meta.json')
    expect(raw).toBeDefined()
    const meta = JSON.parse(raw!.toString('utf8'))
    expect(meta).toMatchObject({
      title: 'Track heirs outreach follow-ups',
      body: 'We keep losing the thread after first contact. A shared checklist per county would fix it.',
      category: 'ideas',
      status: 'open',
      createdBy: 'maria',
    })
    expect(typeof meta.createdById).toBe('number')
    expect(new Date(meta.createdAt).getTime()).toBeGreaterThan(0)

    // Visible in the ideas list immediately (no reindex needed).
    const list = await request(app)
      .get('/api/library/catalog?category=ideas&status=open')
      .set('Cookie', auth.cookie)
    expect(list.body.entries.map((e: any) => e.slug)).toEqual([
      'track-heirs-outreach-follow-ups',
    ])

    const audit = await libraryQuery(
      `SELECT actor, target FROM library_audit WHERE action = 'library.note'`,
    )
    expect(audit.rows.length).toBe(1)
    expect(audit.rows[0]).toMatchObject({
      actor: 'maria',
      target: 'track-heirs-outreach-follow-ups',
    })
  })

  it('non-ideas notes get status needs-review', async () => {
    const auth = await login()
    const res = await createEntry(auth, {
      title: 'Assessor call notes',
      body: 'Shelby assessor confirmed the parcel export cadence.',
      category: 'research',
    })
    expect(res.status).toBe(201)
    expect(res.body.entry).toMatchObject({
      kind: 'note',
      category: 'research',
      status: 'needs-review',
    })
  })

  it('suffixes the slug on title collision (-2, -3…)', async () => {
    const auth = await login()
    const first = await createEntry(auth, { title: 'Water rights', body: 'one' })
    const second = await createEntry(auth, { title: 'Water Rights!', body: 'two' })
    const third = await createEntry(auth, { title: 'water rights', body: 'three' })
    expect(first.body.entry.slug).toBe('water-rights')
    expect(second.body.entry.slug).toBe('water-rights-2')
    expect(third.body.entry.slug).toBe('water-rights-3')
    expect(fake.objects.has('library/notes/water-rights-2/meta.json')).toBe(true)
    expect(fake.objects.has('library/notes/water-rights-3/meta.json')).toBe(true)
  })

  it.each([
    [{ body: 'no title' }, /title/i],
    [{ title: '   ', body: 'blank title' }, /title/i],
    [{ title: 'no body' }, /body/i],
    [{ title: 'blank body', body: '   ' }, /body/i],
    [{ title: '!!!', body: 'unsluggable title' }, /title/i],
  ])('400s invalid input %j with a clear message', async (payload, message) => {
    const auth = await login()
    const res = await createEntry(auth, payload)
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(message)
    // Nothing written to the bucket on rejection.
    expect([...fake.objects.keys()].filter(k => k.startsWith('library/notes/'))).toEqual([])
  })
})

describe('reindex round-trip', () => {
  it('rebuilds note entries (body included) from the bucket alone', async () => {
    const auth = await login()
    await createEntry(auth, {
      title: 'Parcel data idea',
      body: 'Cross-reference parcel vacancy with heirs share.',
      tags: ['land'],
    })
    // Wipe the index the hard way, then reindex from the bucket.
    await libraryQuery(`DELETE FROM library_catalog`)
    const re = await request(app)
      .post('/api/library/reindex')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(re.status).toBe(200)
    expect(re.body.indexed).toBe(1)

    const detail = await request(app)
      .get('/api/library/catalog/parcel-data-idea')
      .set('Cookie', auth.cookie)
    expect(detail.status).toBe(200)
    expect(detail.body.entry).toMatchObject({
      kind: 'note',
      category: 'ideas',
      status: 'open',
      tags: ['land'],
    })
    expect(detail.body.entry.meta.body).toContain('parcel vacancy')
    expect(detail.body.entry.meta.createdBy).toBe('maria')
  })
})

describe('PATCH /api/library/catalog/:slug — editing a note', () => {
  async function makeIdea(auth: { cookie: string; csrf: string }): Promise<string> {
    const res = await createEntry(auth, { title: 'Idea to edit', body: 'v1' })
    expect(res.status).toBe(201)
    return res.body.entry.slug
  }

  it('updates body and moves an idea through its lifecycle (open → planned)', async () => {
    const auth = await login()
    const slug = await makeIdea(auth)
    const res = await patchEntry(auth, slug, { body: 'v2 with more detail', status: 'planned' })
    expect(res.status).toBe(200)
    expect(res.body.entry).toMatchObject({ slug, kind: 'note', status: 'planned' })
    expect(res.body.entry.meta.body).toBe('v2 with more detail')

    // Bucket-first: the manifest is rewritten, attribution preserved.
    const meta = JSON.parse(
      fake.objects.get(`library/notes/${slug}/meta.json`)!.toString('utf8'),
    )
    expect(meta).toMatchObject({ body: 'v2 with more detail', status: 'planned', createdBy: 'maria' })

    const audit = await libraryQuery(
      `SELECT actor, target FROM library_audit WHERE action = 'library.note.update'`,
    )
    expect(audit.rows.length).toBe(1)
    expect(audit.rows[0]).toMatchObject({ actor: 'maria', target: slug })
  })

  it('rejects a status outside open/planned/done with a 400', async () => {
    const auth = await login()
    const slug = await makeIdea(auth)
    const res = await patchEntry(auth, slug, { status: 'published' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/status/i)
    // Unchanged.
    const detail = await request(app)
      .get(`/api/library/catalog/${slug}`)
      .set('Cookie', auth.cookie)
    expect(detail.body.entry.status).toBe('open')
  })

  it('can retitle and retag without touching the slug', async () => {
    const auth = await login()
    const slug = await makeIdea(auth)
    const res = await patchEntry(auth, slug, { title: 'Sharper title', tags: ['focus'] })
    expect(res.status).toBe(200)
    expect(res.body.entry).toMatchObject({ slug, title: 'Sharper title', tags: ['focus'] })
    expect(fake.objects.has(`library/notes/${slug}/meta.json`)).toBe(true)
  })

  it('still 409s on kinds that are neither incoming nor note', async () => {
    const auth = await login()
    fake.seed('library/datasets/tn-heirs/data.csv', 'a,b\n1,2\n')
    await request(app)
      .post('/api/library/reindex')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    const res = await patchEntry(auth, 'tn-heirs', { title: 'x' })
    expect(res.status).toBe(409)
  })
})
