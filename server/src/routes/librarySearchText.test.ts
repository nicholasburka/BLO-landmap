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
import { makePdf, makeDocx } from '../testutils/fixtures/documents.js'

/**
 * P6-6 "Inside documents": GET /api/library/search-text searches the Ask
 * index's page chunks with the same BM25 the answer path uses, and hands back
 * the page a match is on so /search can link straight into the viewer.
 *
 * Runs against the real createApp() with a pg-mem store and a fake bucket, so
 * the guard, the limiter and the index build under test are production's. No
 * model is involved — this route never calls one.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { reindexCatalog } = await import('../services/libraryCatalog.js')
const { extractPending } = await import('../services/textExtract.js')
const { clearKbIndex } = await import('../services/kbSearch.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { MAX_LIMIT, snippetFor } = await import('./librarySearchText.js')

let passwordHash: string
beforeAll(async () => {
  // Minimum-cost hash: this suite logs in per test, and production-cost
  // verifies under parallel workers starve other suites' timeouts.
  passwordHash = await argon2.hash('search-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

/** A file long enough to be chunked more than once (CHUNK_MAX_CHARS is
 *  1,500), so the dedupe rule has something to dedupe. A .docx also has no
 *  pages of its own, which is the other case a row has to get right. */
const LONG_PARAGRAPHS = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i}: partition sale risk runs through heirs property case number ${i}.`,
)

beforeEach(async () => {
  clearKbIndex()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-searchtext-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed(
    'library/documents/plan/Five_Year_Plan.pdf',
    makePdf([
      'Page one sets out the acquisition budget for the land trust.',
      'Page two names the cohort counties in Alabama and Mississippi.',
    ]),
  )
  fake.seed(
    'library/documents/plan/meta.json',
    JSON.stringify({ title: 'Strategic plan', category: 'strategy', status: 'published', tags: [] }),
  )
  // A format with no pages of its own — the viewer cannot be opened at a page
  // that does not exist, so the row must say so rather than invent page 1.
  fake.seed('library/documents/manual/Fact_Manual.docx', makeDocx(LONG_PARAGRAPHS))
  fake.seed(
    'library/documents/manual/meta.json',
    JSON.stringify({ title: 'Fact manual', category: 'research', status: 'published', tags: [] }),
  )
  // A wiki page that talks about the same thing: its chunks are filing and
  // markdown, not document pages, so they must never answer here.
  fake.seed('library/wiki/heirs-property.md', '# Heirs property\n\nPartition sale risk is described on this page.\n')

  await reindexCatalog()
  await extractPending()
  clearKbIndex()
})

afterEach(async () => {
  clearKbIndex()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// The login limiter is per IP and this suite logs in per test; a unique
// X-Forwarded-For keeps each case in its own bucket.
let loginIp = 0
async function login(): Promise<string> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username: 'maria', password: 'search-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return cookie.split(';')[0]
}

interface TextHitBody {
  entryId: string
  title: string
  file: string
  page: number | null
  snippet: string
  score: number
}

async function search(cookie: string, query: string): Promise<{ status: number; results: TextHitBody[]; error?: string }> {
  const res = await request(app).get(`/api/library/search-text${query}`).set('Cookie', cookie)
  return { status: res.status, results: (res.body?.results ?? []) as TextHitBody[], error: res.body?.error }
}

describe('GET /api/library/search-text', () => {
  it('answers with the page a match is on, ranked by the catalog\'s own BM25', async () => {
    const cookie = await login()
    const { status, results } = await search(cookie, '?q=cohort+counties+Mississippi')
    expect(status).toBe(200)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toMatchObject({
      entryId: 'plan',
      title: 'Strategic plan',
      file: 'Five_Year_Plan.pdf',
      page: 2,
    })
    expect(results[0].snippet).toContain('cohort counties')
    expect(results[0].score).toBeGreaterThan(0)
    // Ranked: every row scores no better than the one above it.
    const scores = results.map(r => r.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
  })

  it('returns one row per file and page, however many chunks that page was cut into', async () => {
    const cookie = await login()
    const { results } = await search(cookie, '?q=partition+sale+risk')
    // The manual is three chunks in the index; it is one place to read, and
    // it has no pages of its own, so there is no page to open it at.
    const manual = results.filter(r => r.entryId === 'manual')
    expect(manual).toHaveLength(1)
    expect(manual[0]).toMatchObject({ file: 'Fact_Manual.docx', page: null })

    // Two different pages of one document are still two places to read.
    const plan = await search(cookie, '?q=acquisition+budget+cohort+counties')
    expect(plan.results.filter(r => r.entryId === 'plan').map(r => r.page).sort()).toEqual([1, 2])
  })

  it('answers with document pages only — never a filing or a wiki page', async () => {
    const cookie = await login()
    const { results } = await search(cookie, '?q=partition+sale+risk')
    // The wiki page says the same words; it is not a document page.
    expect(results.some(r => r.entryId === 'heirs-property')).toBe(false)
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => !!r.file)).toBe(true)
  })

  it('does not show a page from an entry the catalog has stopped showing', async () => {
    const cookie = await login()
    const before = await search(cookie, '?q=cohort+counties+Mississippi')
    expect(before.results.some(r => r.entryId === 'plan')).toBe(true)
    // Superseded between index builds: the chunks are still in memory, but the
    // catalog no longer shows the entry, so neither may this route.
    await libraryQuery(`UPDATE library_catalog SET status = 'archived' WHERE slug = 'plan'`)
    const after = await search(cookie, '?q=cohort+counties+Mississippi')
    expect(after.results.some(r => r.entryId === 'plan')).toBe(false)
  })

  it('refuses a query with nothing in it', async () => {
    const cookie = await login()
    const missing = await search(cookie, '')
    expect(missing.status).toBe(400)
    expect(missing.error).toMatch(/search for/i)
    const blank = await search(cookie, '?q=%20%20')
    expect(blank.status).toBe(400)
  })

  it('honours limit, and caps it', async () => {
    const cookie = await login()
    const one = await search(cookie, '?q=partition+sale+risk&limit=1')
    expect(one.results).toHaveLength(1)
    const silly = await search(cookie, '?q=partition+sale+risk&limit=9999')
    expect(silly.status).toBe(200)
    expect(silly.results.length).toBeLessThanOrEqual(MAX_LIMIT)
  })
})

describe('snippetFor', () => {
  it('opens on the first matching word and marks where it cut', () => {
    const text = `${'filler words go here. '.repeat(30)}the cohort counties are named here.${' tail text.'.repeat(30)}`
    const snippet = snippetFor(text, new Set(['cohort']), 80)
    expect(snippet).toContain('cohort')
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet.length).toBeLessThanOrEqual(82)
  })

  it('hands back a short chunk whole', () => {
    expect(snippetFor('  Page two names the cohort counties.  ', new Set(['cohort']))).toBe(
      'Page two names the cohort counties.',
    )
  })
})
