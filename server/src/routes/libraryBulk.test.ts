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
 * P6-8: many documents at once.
 *
 * Runs against the real `createApp()` with a pg-mem store, an injected fake
 * bucket and the REAL annotation queue over a stubbed model — so the caps, the
 * deterministic floor, the queue states, the "stored, never applied" rule and
 * the no-credit path are production's wiring, and nothing reaches a network.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, getFile } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { setLinkFetchDefaults, resetLinkFetchQueue, whenQueueIdle } = await import('../services/linkFetchQueue.js')
const { resetBulkDrops } = await import('../services/bulkDrop.js')
const { getCatalogEntry } = await import('../services/libraryCatalog.js')
const { unverifiedFields } = await import('../services/provenance.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('bulk-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal'), ('sam', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-bulk-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  resetBulkDrops()
  resetLinkFetchQueue()
})

afterEach(async () => {
  resetLinkFetchQueue()
  resetBulkDrops()
  delete process.env.LIBRARY_BULK_MAX_FILES
  delete process.env.LIBRARY_BULK_MAX_FILE_BYTES
  delete process.env.LIBRARY_BULK_MAX_DROP_BYTES
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
async function login(username = 'maria'): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.98.1.${++loginIp}`)
    .send({ username, password: 'bulk-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function bulk(auth: { cookie: string; csrf: string }) {
  return request(app).post('/api/library/bulk').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
}

const COUNTIES = Buffer.from('GEOID,share\n47157,0.31\n')
const PEOPLE = Buffer.from('name,owner\nA,B\n')

/** A stub Anthropic answering every call with the same JSON. */
function stubModel(json: string) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: json }],
        usage: { input_tokens: 1400, output_tokens: 160 },
        stop_reason: 'end_turn',
      }),
    },
  }
}

const ANSWER = JSON.stringify({
  title: 'Land loss by county, 1910-2020',
  summary: 'County-level acreage lost, from the 2024 survey.',
  organization: 'usda',
  topic: 'land',
  purpose: 'research',
  tags: ['land-loss'],
  shape: 'statistics',
})

// --- The caps ---------------------------------------------------------------

describe('the caps', () => {
  it('refuses more files than the drop allows, and says what the cap is', async () => {
    // The real cap is 50; lowered here so the test body stays three tiny CSVs
    // instead of fifty-one (the check is `files > cap`, whatever the cap is).
    process.env.LIBRARY_BULK_MAX_FILES = '2'
    const auth = await login()
    const res = await bulk(auth)
      .attach('files', COUNTIES, 'a.csv')
      .attach('files', COUNTIES, 'b.csv')
      .attach('files', COUNTIES, 'c.csv')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('That is more than 2 files. Drop them in a few smaller batches.')
  })

  it('refuses a file over the per-file cap with a readable message', async () => {
    process.env.LIBRARY_BULK_MAX_FILE_BYTES = '32'
    const auth = await login()
    const res = await bulk(auth).attach('files', Buffer.alloc(64, 0x61), 'big.csv')
    expect(res.status).toBe(413)
    expect(res.body.error).toBe('"big.csv" is too large: the limit is 32 bytes per file.')
  })

  it('refuses a drop over the whole-drop cap', async () => {
    process.env.LIBRARY_BULK_MAX_DROP_BYTES = '32'
    const auth = await login()
    const res = await bulk(auth)
      .attach('files', Buffer.alloc(24, 0x61), 'a.csv')
      .attach('files', Buffer.alloc(24, 0x61), 'b.csv')
    expect(res.status).toBe(413)
    expect(res.body.error).toContain('too large')
  })

  it('needs at least one file', async () => {
    const auth = await login()
    const res = await bulk(auth).field('collection', '1')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('at least one file is required')
  })
})

// --- The deterministic floor ------------------------------------------------

describe('the floor', () => {
  it('lands every file filed needs-review before any model runs', async () => {
    // No model seam at all: under a test runner the annotation does nothing,
    // which is exactly the state this asserts — the files are already in.
    const auth = await login()
    const res = await bulk(auth)
      .attach('files', COUNTIES, 'land loss_2024.csv')
      .attach('files', PEOPLE, 'owners.csv')
    expect(res.status).toBe(201)
    expect(res.body.rows).toHaveLength(2)
    expect(res.body.counts.queued).toBe(2)
    expect(res.body.estimateCents).toBe(2)

    const first = await getCatalogEntry(res.body.rows[0].slug)
    expect(first?.kind).toBe('incoming')
    expect(first?.status).toBe('needs-review')
    expect(first?.title).toBe('land loss 2024')
    // Shape read off the file's own header row (GEOID → statistics).
    expect(first?.meta.shape).toBe('statistics')
    expect(first?.meta.suggested).toBeUndefined()

    const second = await getCatalogEntry(res.body.rows[1].slug)
    expect(second?.meta.shape).toBe('records')
    expect(second?.title).toBe('owners')
  })

  it('stores the file itself, not just a row', async () => {
    const auth = await login()
    const res = await bulk(auth).attach('files', COUNTIES, 'counties.csv')
    const slug = res.body.rows[0].slug
    const stored = await getFile(`library/incoming/${slug}/counties.csv`)
    expect(stored.toString('utf8')).toBe(COUNTIES.toString('utf8'))
  })

  it('never fetches anything from a URL', async () => {
    const auth = await login()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await bulk(auth).attach('files', COUNTIES, 'counties.csv')
    await whenQueueIdle()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

// --- The queued pass --------------------------------------------------------

describe('the annotation', () => {
  it('moves each row to suggested, with the proposal and its cost', async () => {
    const model = stubModel(ANSWER)
    setLinkFetchDefaults({ assistant: model as never })
    const auth = await login()
    const res = await bulk(auth).attach('files', COUNTIES, 'counties.csv')
    expect(res.body.rows[0].state).toBe('queued')
    await whenQueueIdle()

    const status = await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', auth.cookie)
    expect(status.status).toBe(200)
    expect(status.body.running).toBe(false)
    expect(status.body.counts).toEqual({ queued: 0, reading: 0, suggested: 1, failed: 0 })
    expect(status.body.spentCents).toBe(1)
    const row = status.body.rows[0]
    expect(row.state).toBe('suggested')
    expect(row.costCents).toBe(1)
    expect(row.suggested).toMatchObject({
      title: 'Land loss by county, 1910-2020',
      organization: 'usda',
      topic: 'land',
      purpose: 'research',
      shape: 'statistics',
      category: 'land',
    })
    // The row's title follows the proposal so the list reads as the person
    // will file it — the ENTRY is what must not move.
    expect(row.title).toBe('Land loss by county, 1910-2020')
  })

  /**
   * P6-34 narrows P6-8's rule rather than replacing it.
   *
   * The whole annotation is still stored as the proposal and still waits to be
   * accepted — title, summary, tags, organization, shape. ONE field of it, the
   * topic, is applied the moment it arrives, because an entry with no topic is
   * invisible to the topic facet, to Chat and to any working set scoped by
   * subject, and a proposal nobody got round to accepting leaves it invisible
   * for good. So it is applied WITH its provenance, and it lands on the
   * verification queue instead of in a proposal nobody reads.
   */
  it('stores the proposal, applies only the topic, and flags that for verification', async () => {
    setLinkFetchDefaults({ assistant: stubModel(ANSWER) as never })
    const auth = await login()
    const res = await bulk(auth).attach('files', COUNTIES, 'counties.csv')
    await whenQueueIdle()

    const entry = await getCatalogEntry(res.body.rows[0].slug)
    // The title, the tags and the status are untouched — that rule stands.
    expect(entry?.title).toBe('counties')
    expect(entry?.tags).toEqual([])
    expect(entry?.status).toBe('needs-review')
    expect(entry?.meta.suggested).toMatchObject({ title: 'Land loss by county, 1910-2020', organization: 'usda' })
    // The topic is applied, and says outright that a model wrote it.
    expect(entry?.category).toBe('land')
    expect(entry?.meta.provenance).toMatchObject({ topic: { mechanism: 'model', value: 'land', via: 'category' } })
    expect(unverifiedFields(entry!)).toEqual(['topic'])
    // The manifest in the bucket says the same thing — the row is rebuilt
    // from it at the next reindex, so the provenance survives one.
    const manifest = JSON.parse(
      (await getFile(`library/incoming/${res.body.rows[0].slug}/meta.json`, { fresh: true })).toString('utf8'),
    )
    expect(manifest.title).toBe('counties')
    expect(manifest.suggested.title).toBe('Land loss by county, 1910-2020')
    expect(manifest.category).toBe('land')
    expect(manifest.provenance.topic.mechanism).toBe('model')
  })

  it('keeps the floor and says why when the account has no credit', async () => {
    const refusing = {
      messages: {
        create: vi.fn().mockRejectedValue(Object.assign(new Error('your credit balance is too low'), { status: 400 })),
      },
    }
    setLinkFetchDefaults({ assistant: refusing as never })
    const auth = await login()
    const res = await bulk(auth).attach('files', COUNTIES, 'counties.csv')
    await whenQueueIdle()

    const status = await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', auth.cookie)
    const row = status.body.rows[0]
    expect(row.state).toBe('failed')
    expect(row.reason).toBe('no model pass')
    expect(row.suggested).toMatchObject({ error: 'unavailable', reason: 'refused' })
    expect(status.body.spentCents).toBe(0)
    // Nothing is lost: the entry is exactly where the floor put it.
    const entry = await getCatalogEntry(res.body.rows[0].slug)
    expect(entry?.title).toBe('counties')
    expect(entry?.status).toBe('needs-review')
  })

  it('says so when there was no text to read', async () => {
    setLinkFetchDefaults({ assistant: stubModel(ANSWER) as never })
    const auth = await login()
    // A .bin holds no text the extractor or the head reader can use.
    const res = await bulk(auth).attach('files', Buffer.from([0, 1, 2, 3]), 'scan.bin')
    await whenQueueIdle()
    const status = await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', auth.cookie)
    expect(status.body.rows[0]).toMatchObject({ state: 'failed', reason: 'no text could be read' })
  })

  it('runs three at a time and finishes them all', async () => {
    let inFlight = 0
    let peak = 0
    const slow = {
      messages: {
        create: vi.fn().mockImplementation(async () => {
          peak = Math.max(peak, ++inFlight)
          await new Promise(resolve => setTimeout(resolve, 5))
          inFlight -= 1
          return { content: [{ type: 'text', text: ANSWER }], usage: {}, stop_reason: 'end_turn' }
        }),
      },
    }
    setLinkFetchDefaults({ assistant: slow as never })
    const auth = await login()
    const res = await bulk(auth)
      .attach('files', COUNTIES, 'a.csv')
      .attach('files', COUNTIES, 'b.csv')
      .attach('files', COUNTIES, 'c.csv')
      .attach('files', COUNTIES, 'd.csv')
    await whenQueueIdle()
    const status = await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', auth.cookie)
    expect(status.body.counts.suggested).toBe(4)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(3)
  })
})

// --- One collection ---------------------------------------------------------

describe('keep as one collection', () => {
  it('makes one entry holding every file', async () => {
    setLinkFetchDefaults({ assistant: stubModel(ANSWER) as never })
    const auth = await login()
    const res = await bulk(auth)
      .field('collection', '1')
      .field('collectionTitle', 'Landowner profiles')
      .attach('files', COUNTIES, 'profiles/a.csv')
      .attach('files', PEOPLE, 'profiles/b.csv')
    expect(res.status).toBe(201)
    expect(res.body.rows).toHaveLength(1)
    expect(res.body.rows[0].file).toBe('2 files')

    const entry = await getCatalogEntry(res.body.rows[0].slug)
    expect(entry?.title).toBe('Landowner profiles')
    expect(entry?.meta.collection).toBe(true)
    const names = (entry?.files ?? []).map(f => f.key.split('/').pop()).sort()
    expect(names).toEqual(['a.csv', 'b.csv', 'meta.json'])
  })

  it('counts the files when nobody named it — a browser never sends the folder', async () => {
    const auth = await login()
    const res = await bulk(auth)
      .field('collection', 'true')
      .attach('files', COUNTIES, 'a.csv')
      .attach('files', PEOPLE, 'b.csv')
    const entry = await getCatalogEntry(res.body.rows[0].slug)
    expect(entry?.title).toBe('2 documents')
  })

  it('never lets two files collide on one name', async () => {
    const auth = await login()
    const res = await bulk(auth)
      .field('collection', '1')
      .attach('files', COUNTIES, 'a/report.csv')
      .attach('files', PEOPLE, 'b/report.csv')
    const entry = await getCatalogEntry(res.body.rows[0].slug)
    const names = (entry?.files ?? []).map(f => f.key.split('/').pop()).sort()
    expect(names).toEqual(['meta.json', 'report-2.csv', 'report.csv'])
  })
})

// --- Status and re-run ------------------------------------------------------

describe('the status route', () => {
  it('is 404 for a drop that is not yours', async () => {
    const maria = await login('maria')
    const res = await bulk(maria).attach('files', COUNTIES, 'counties.csv')
    const sam = await login('sam')
    const status = await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', sam.cookie)
    expect(status.status).toBe(404)
  })

  it('is 404 for an id nobody ever made', async () => {
    const auth = await login()
    const status = await request(app).get('/api/library/bulk/not-a-drop').set('Cookie', auth.cookie)
    expect(status.status).toBe(404)
  })
})

describe('look again', () => {
  it('re-runs one entry and moves its row back to queued', async () => {
    const refusing = {
      messages: { create: vi.fn().mockRejectedValue(Object.assign(new Error('rate limit'), { status: 429 })) },
    }
    setLinkFetchDefaults({ assistant: refusing as never })
    const auth = await login()
    const res = await bulk(auth).attach('files', COUNTIES, 'counties.csv')
    await whenQueueIdle()
    const slug = res.body.rows[0].slug
    expect((await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', auth.cookie)).body.rows[0].state).toBe('failed')

    setLinkFetchDefaults({ assistant: stubModel(ANSWER) as never })
    const again = await request(app)
      .post(`/api/library/entries/${slug}/annotate`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ slug, state: 'queued' })
    await whenQueueIdle()

    const status = await request(app).get(`/api/library/bulk/${res.body.dropId}`).set('Cookie', auth.cookie)
    expect(status.body.rows[0].state).toBe('suggested')
    expect(status.body.rows[0].suggested.title).toBe('Land loss by county, 1910-2020')
  })

  it('is 404 for an entry that does not exist', async () => {
    const auth = await login()
    const res = await request(app)
      .post('/api/library/entries/nope/annotate')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(res.status).toBe(404)
  })

  it('refuses a kind that is not a dropped document', async () => {
    const auth = await login()
    await request(app)
      .post('/api/library/entries')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'An idea', body: 'Try the thing' })
    const res = await request(app)
      .post('/api/library/entries/an-idea/annotate')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(res.status).toBe(409)
  })
})
