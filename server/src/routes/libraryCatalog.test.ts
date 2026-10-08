import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-8: catalog index + read API. Runs against the real createApp() with a
 * pg-mem library store and an injected fake bucket client, so the wiring
 * (auth guard, CSRF, audit) under test is production's.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, listFiles } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')

let passwordHash: string
beforeAll(async () => {
  // Minimum-cost hash: this suite logs in per-test (~15 argon2 verifies), and
  // production-cost verifies under parallel vitest workers starve other
  // suites' 5s timeouts. Verify cost comes from the hash's embedded params,
  // so cheap params here change nothing about production wiring.
  passwordHash = await argon2.hash('catalog-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
  dataDir = mkdtempSync(join(tmpdir(), 'blo-catalog-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  // A small but representative library tree.
  fake.seed('library/datasets/tn-heirs/data.csv', 'fips,share\n47157,0.31\n')
  fake.seed(
    'library/datasets/tn-heirs/meta.json',
    JSON.stringify({
      title: "Heirs' property share — TN",
      category: 'land',
      status: 'published',
      tags: ['tennessee', 'land'],
      source: 'county assessor scrape',
    }),
  )
  fake.seed('library/datasets/raw-drop/data.csv', 'a,b\n1,2\n')
  fake.seed('library/documents/field-notes/notes.pdf', '%PDF-fake')
  fake.seed(
    'library/documents/field-notes/meta.json',
    JSON.stringify({
      title: 'Field notes — heirs interviews',
      category: 'research',
      status: 'published',
      tags: ['tennessee'],
    }),
  )
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// The login limiter is 10/hr per IP and this suite logs in per-test; the app
// trusts one proxy hop, so a unique X-Forwarded-For per login keeps each
// test in its own rate-limit bucket without touching production wiring.
let loginIp = 0
async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.99.0.${++loginIp}`)
    .send({ username: 'maria', password: 'catalog-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

async function reindex(auth: { cookie: string; csrf: string }) {
  return request(app)
    .post('/api/library/reindex')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
}

describe('slug collisions across kinds', () => {
  it('keeps the first-walked entry, skips the other with a warning, and still indexes everything else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.seed('library/documents/why-five-million/memo.rtf', 'memo')
    fake.seed('library/documents/why-five-million/meta.json', JSON.stringify({ title: 'Memo', category: 'strategy', status: 'published' }))
    fake.seed('library/wiki/why-five-million.md', '# Why five million\n\ntext\n')
    const auth = await login()
    const res = await reindex(auth)
    expect(res.status).toBe(200)
    expect(res.body.collisions).toBe(1)
    const list = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    const dup = list.body.entries.filter((e: any) => e.slug === 'why-five-million')
    expect(dup).toHaveLength(1)
    expect(dup[0].kind).toBe('document')
    expect(list.body.entries.map((e: any) => e.slug)).toContain('tn-heirs')
    expect(warn.mock.calls.some(c => String(c[0]).includes('slug collision') && String(c[0]).includes('why-five-million'))).toBe(true)
    warn.mockRestore()
  })
})

describe('updatedAt (UX pass)', () => {
  it('list and detail rows carry an ISO updatedAt', async () => {
    const auth = await login()
    await reindex(auth)
    const list = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    for (const e of list.body.entries) expect(new Date(e.updatedAt).toISOString()).toBe(e.updatedAt)
    const one = await request(app).get('/api/library/catalog/tn-heirs').set('Cookie', auth.cookie)
    expect(typeof one.body.entry.updatedAt).toBe('string')
    expect(one.body.entry).not.toHaveProperty('updated_at')
  })

  it('updatedAt is the newest bucket object among the entry files, not the reindex time', async () => {
    const older = new Date('2026-05-01T12:00:00.000Z')
    const newer = new Date('2026-06-15T09:30:00.000Z')
    fake.seed('library/documents/old-memo/meta.json', JSON.stringify({ title: 'Old memo', status: 'published' }), older)
    fake.seed('library/documents/old-memo/memo.pdf', 'pdf', newer)
    fake.seed('library/wiki/old-page.md', '# Old page\n', older)
    const auth = await login()
    await reindex(auth)
    const memo = await request(app).get('/api/library/catalog/old-memo').set('Cookie', auth.cookie)
    expect(memo.body.entry.updatedAt).toBe(newer.toISOString())
    const page = await request(app).get('/api/library/catalog/old-page').set('Cookie', auth.cookie)
    expect(page.body.entry.updatedAt).toBe(older.toISOString())
    // Asked for by recency (P5-64 made held-first the default), the freshly
    // seeded fixture entries (stamped "now") come before both.
    const list = await request(app).get('/api/library/catalog?sort=recent').set('Cookie', auth.cookie)
    const order = list.body.entries.map((e: any) => e.slug)
    expect(order.indexOf('tn-heirs')).toBeLessThan(order.indexOf('old-memo'))
    expect(order.indexOf('old-memo')).toBeLessThan(order.indexOf('old-page'))
  })

  it('falls back to the index time when the bucket reports no modification time', async () => {
    fake.seed('library/wiki/unstamped.md', '# Unstamped\n', null)
    const auth = await login()
    const before = Date.now()
    await reindex(auth)
    const page = await request(app).get('/api/library/catalog/unstamped').set('Cookie', auth.cookie)
    expect(Date.parse(page.body.entry.updatedAt)).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('list order (P5-64)', () => {
  it('lists what we hold before what we only index, and takes sort=recent for the other order', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify({ title: 'EPA NPL sites', source: { provider: 'US EPA' } }))
    fake.seed('library/wiki/land-loss.md', '# Land loss\n')
    const auth = await login()
    await reindex(auth)

    const held = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    const kinds = held.body.entries.map((e: any) => e.kind)
    // Every source sits after every dataset, page and document.
    expect(kinds.indexOf('source')).toBe(kinds.length - 1)
    expect(kinds[0]).toBe('dataset')

    const recent = await request(app).get('/api/library/catalog?sort=recent').set('Cookie', auth.cookie)
    expect(recent.body.entries.map((e: any) => e.slug).sort()).toEqual(
      held.body.entries.map((e: any) => e.slug).sort(),
    )
  })

  it('refuses a sort it does not know, naming the two it does', async () => {
    const auth = await login()
    const res = await request(app).get('/api/library/catalog?sort=alphabetical').set('Cookie', auth.cookie)
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('held-first')
    expect(res.body.error).toContain('recent')
  })
})

describe('search fields (P5-38)', () => {
  it('q matches tags, category, and description as well as title/slug', async () => {
    const auth = await login()
    await reindex(auth)
    const byTag = await request(app).get('/api/library/catalog?q=tennessee').set('Cookie', auth.cookie)
    expect(byTag.body.entries.map((e: any) => e.slug).sort()).toEqual(['field-notes', 'tn-heirs'])
    const byCategory = await request(app).get('/api/library/catalog?q=LAND').set('Cookie', auth.cookie)
    expect(byCategory.body.entries.map((e: any) => e.slug)).toContain('tn-heirs')
    const none = await request(app).get('/api/library/catalog?q=zzz-nothing').set('Cookie', auth.cookie)
    expect(none.body.entries).toEqual([])
  })
})

describe('backlinks + view layers (P5-37)', () => {
  it('indexes which wiki pages mention an entry (links + embeds, de-duplicated) into meta.mentionedBy', async () => {
    fake.seed('library/wiki/heirs-notes.md', '# Heirs notes\n\nSee [the dataset](/library/tn-heirs) and again [here](/library/tn-heirs?tab=data).\n\n```entry:field-notes\n```\n')
    fake.seed('library/wiki/other.md', '# Other\n\n```entry:tn-heirs\n```\nNothing about /library/nope-not-a-link-here\n')
    const auth = await login()
    await reindex(auth)
    const heirs = await request(app).get('/api/library/catalog/tn-heirs').set('Cookie', auth.cookie)
    expect(heirs.body.entry.meta.mentionedBy).toEqual([
      { slug: 'heirs-notes', title: 'Heirs notes' },
      { slug: 'other', title: 'Other' },
    ])
    const notes = await request(app).get('/api/library/catalog/field-notes').set('Cookie', auth.cookie)
    expect(notes.body.entry.meta.mentionedBy).toEqual([{ slug: 'heirs-notes', title: 'Heirs notes' }])
    const raw = await request(app).get('/api/library/catalog/raw-drop').set('Cookie', auth.cookie)
    expect(raw.body.entry.meta.mentionedBy).toEqual([])
  })
})

describe('supersession (P5-35)', () => {
  beforeEach(() => {
    fake.seed('library/documents/old-manual/old.docx', 'old')
    fake.seed('library/documents/old-manual/meta.json', JSON.stringify({ title: 'Old manual', category: 'research', status: 'archived', supersededBy: 'tn-heirs' }))
    fake.seed('library/documents/orphan/x.pdf', 'x')
    fake.seed('library/documents/orphan/meta.json', JSON.stringify({ title: 'Orphan', category: 'research', status: 'archived', supersededBy: 'does-not-exist' }))
  })

  it('hides archived rows by default and reports how many were hidden', async () => {
    const auth = await login()
    await reindex(auth)
    const res = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.entries.map((e: any) => e.slug)).not.toContain('old-manual')
    expect(res.body.archivedCount).toBe(2)
    const research = await request(app).get('/api/library/catalog?category=research').set('Cookie', auth.cookie)
    expect(research.body.archivedCount).toBe(2)
    const land = await request(app).get('/api/library/catalog?category=land').set('Cookie', auth.cookie)
    expect(land.body.archivedCount).toBe(0)
  })

  it('includes archived rows with ?archived=1 or an explicit status filter', async () => {
    const auth = await login()
    await reindex(auth)
    const all = await request(app).get('/api/library/catalog?archived=1').set('Cookie', auth.cookie)
    expect(all.body.entries.map((e: any) => e.slug)).toContain('old-manual')
    expect(all.body.archivedCount).toBe(0)
    const only = await request(app).get('/api/library/catalog?status=archived').set('Cookie', auth.cookie)
    expect(only.body.entries.map((e: any) => e.slug).sort()).toEqual(['old-manual', 'orphan'])
  })

  it('resolves supersededBy on the archived entry and supersedes on the current one; warns on a broken pointer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const auth = await login()
    await reindex(auth)
    expect(warn.mock.calls.some(c => String(c[0]).includes('"orphan" is supersededBy "does-not-exist"'))).toBe(true)
    warn.mockRestore()
    const old = await request(app).get('/api/library/catalog/old-manual').set('Cookie', auth.cookie)
    expect(old.body.entry.supersededBy).toEqual({ slug: 'tn-heirs', title: "Heirs' property share — TN" })
    expect(old.body.entry.supersedes).toEqual([])
    const current = await request(app).get('/api/library/catalog/tn-heirs').set('Cookie', auth.cookie)
    expect(current.body.entry.supersededBy).toBeNull()
    expect(current.body.entry.supersedes).toEqual([{ slug: 'old-manual', title: 'Old manual' }])
    const orphan = await request(app).get('/api/library/catalog/orphan').set('Cookie', auth.cookie)
    expect(orphan.body.entry.supersededBy).toEqual({ slug: 'does-not-exist', title: 'does-not-exist' })
  })
})

describe('auth boundary', () => {
  it('catalog list, detail, and reindex all bare-401 without a session', async () => {
    for (const req of [
      request(app).get('/api/library/catalog'),
      request(app).get('/api/library/catalog/tn-heirs'),
      request(app).post('/api/library/reindex'),
    ]) {
      const res = await req
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
  })

  it('reindex without a CSRF token is refused', async () => {
    const { cookie } = await login()
    const res = await request(app).post('/api/library/reindex').set('Cookie', cookie)
    expect(res.status).toBe(403)
  })
})

describe('POST /api/library/reindex', () => {
  it('builds the index from the bucket tree and reports counts', async () => {
    const auth = await login()
    const res = await reindex(auth)
    expect(res.status).toBe(200)
    expect(res.body.indexed).toBe(3)
  })

  it('writes an audit entry', async () => {
    const auth = await login()
    await reindex(auth)
    const audit = await libraryQuery(
      `SELECT actor, action FROM library_audit WHERE action = 'catalog.reindex'`,
    )
    expect(audit.rows.length).toBe(1)
    expect(audit.rows[0].actor).toBe('maria')
  })

  it('drops entries whose files vanished from the bucket', async () => {
    const auth = await login()
    await reindex(auth)
    fake.objects.delete('library/datasets/raw-drop/data.csv')
    await reindex(auth)
    const res = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    expect(res.body.entries.map((e: any) => e.slug).sort()).toEqual(['field-notes', 'tn-heirs'])
  })

  it('tolerates malformed meta.json (indexes with defaults, does not crash)', async () => {
    fake.seed('library/datasets/broken/meta.json', '{not json')
    fake.seed('library/datasets/broken/data.csv', 'x')
    const auth = await login()
    const res = await reindex(auth)
    expect(res.status).toBe(200)
    const detail = await request(app)
      .get('/api/library/catalog/broken')
      .set('Cookie', auth.cookie)
    expect(detail.status).toBe(200)
    expect(detail.body.entry.title).toBe('broken')
    expect(detail.body.entry.status).toBe('needs-review')
  })

  it('picks up an external CLI push even when the mirror caches stale files (P5-13)', async () => {
    const auth = await login()
    // First reindex caches every manifest into the server's local mirror.
    expect((await reindex(auth)).status).toBe(200)

    // A dev pushes from the sync CLI: the bucket changes, the running
    // server's mirror does not (it only hears about it via Reindex).
    fake.seed(
      'library/datasets/tn-heirs/meta.json',
      JSON.stringify({
        title: "Heirs' property share — TN",
        category: 'land',
        status: 'archived',
        tags: ['tennessee', 'land'],
      }),
    )
    fake.seed('library/datasets/tn-heirs/data.csv', 'fips,share\n47157,0.32\n47047,0.18\n')

    expect((await reindex(auth)).status).toBe(200)
    const res = await request(app)
      .get('/api/library/catalog/tn-heirs')
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.entry.status).toBe('archived')
    // Reindex also resyncs the mirror, so size-changed files are refreshed.
    expect(readFileSync(join(dataDir, 'library/datasets/tn-heirs/data.csv'), 'utf8')).toContain(
      '47047',
    )
  })
})

describe('GET /api/library/catalog', () => {
  it('lists indexed entries with catalog fields', async () => {
    const auth = await login()
    await reindex(auth)
    const res = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.entries.length).toBe(3)
    const tn = res.body.entries.find((e: any) => e.slug === 'tn-heirs')
    expect(tn).toMatchObject({
      kind: 'dataset',
      title: "Heirs' property share — TN",
      category: 'land',
      status: 'published',
      tags: ['tennessee', 'land'],
    })
    expect(tn.bytes).toBeGreaterThan(0)
    // a dataset with no meta.json gets sensible defaults
    const raw = res.body.entries.find((e: any) => e.slug === 'raw-drop')
    expect(raw).toMatchObject({ title: 'raw-drop', status: 'needs-review' })
  })

  it.each([
    ['category=land', ['tn-heirs']],
    ['status=needs-review', ['raw-drop']],
    ['kind=document', ['field-notes']],
    ['tag=tennessee', ['field-notes', 'tn-heirs']],
    ['q=heirs', ['field-notes', 'tn-heirs']],
    ['q=heirs&kind=dataset', ['tn-heirs']],
    // P6-1/P6-2. `tn-heirs` says "county assessor scrape" — a publisher the
    // vocabulary does not know, so its own words head its own group — and its
    // table is keyed by a county FIPS.
    ['organization=county assessor scrape', ['tn-heirs']],
    ['organization=epa', []],
    ['shape=statistics', ['tn-heirs']],
    ['shape=points', []],
    // P6-19. `tn-heirs`' table is keyed by a Shelby County FIPS, so it is
    // Tennessee; `raw-drop` is a two-column table nothing can place.
    ['coverage=state', ['tn-heirs']],
    ['coverage=national', []],
    ['state=TN', ['tn-heirs']],
    ['state=Tennessee', ['tn-heirs']],
    ['state=GA', []],
    // The gap, and only among the kinds that can have one — the document is
    // not an entry with missing coverage.
    ['coverage=none', ['raw-drop']],
    ['attention=no-coverage', ['raw-drop']],
  ])('filters by %s', async (query, expected) => {
    const auth = await login()
    await reindex(auth)
    const res = await request(app)
      .get(`/api/library/catalog?${query}`)
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.entries.map((e: any) => e.slug).sort()).toEqual(expected)
  })
})

describe('GET /api/library/catalog/:slug', () => {
  it('returns the full entry including meta and file list', async () => {
    const auth = await login()
    await reindex(auth)
    const res = await request(app)
      .get('/api/library/catalog/tn-heirs')
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.entry.meta.source).toBe('county assessor scrape')
    expect(res.body.entry.files.map((f: any) => f.key).sort()).toEqual([
      'library/datasets/tn-heirs/data.csv',
      'library/datasets/tn-heirs/meta.json',
    ])
  })

  it('404s (bare) on an unknown slug', async () => {
    const auth = await login()
    await reindex(auth)
    const res = await request(app)
      .get('/api/library/catalog/nope')
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })
})

// --- P5-56: filing an already-dropped link as a data source ----------------

describe('PATCH /api/library/catalog/:slug with a source block', () => {
  const SOURCE = { provider: 'FEMA', program: 'National Flood Hazard Layer', geography: 'parcel', topics: ['flooding'] }

  /** A quick-dropped link, sitting in the needs-cataloging queue. */
  async function dropLink(auth: { cookie: string; csrf: string }): Promise<string> {
    const res = await request(app)
      .post('/api/library/links')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ url: 'https://msc.fema.gov/portal/home' })
    expect(res.status).toBe(201)
    return res.body.slug
  }

  function patch(auth: { cookie: string; csrf: string }, slug: string, body: unknown) {
    return request(app)
      .patch(`/api/library/catalog/${slug}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send(body)
  }

  it('moves the entry from incoming/ to sources/ in the bucket and flips the kind', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    const res = await patch(auth, slug, { title: 'FEMA flood zones (NFHL)', category: 'environment', source: SOURCE })
    expect(res.status).toBe(200)
    expect(res.body.entry).toMatchObject({ kind: 'source', title: 'FEMA flood zones (NFHL)', status: 'needs-review' })
    expect(res.body.entry.meta.source).toEqual(SOURCE)
    expect(res.body.entry.meta.url).toBe('https://msc.fema.gov/portal/home') // the drop survives

    // Bucket-first: the old manifest is GONE, so a reindex cannot resurrect
    // the incoming entry beside the source.
    expect(await listFiles(`library/incoming/${slug}/`)).toEqual([])
    expect((await listFiles(`library/sources/${slug}/`)).map(f => f.key)).toEqual([`library/sources/${slug}/meta.json`])

    await reindex(auth)
    const after = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(after.body.entry.kind).toBe('source')
    expect(after.body.entry.meta.source).toEqual(SOURCE)
  })

  it('records the kind change in the library.file audit row', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    await patch(auth, slug, { source: SOURCE })
    const audit = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'library.file' AND target = $1`, [slug])
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].detail).toMatchObject({ kindChangedFrom: 'incoming', kindChangedTo: 'source' })
  })

  it('re-files a source in place — the rest of the block can be filled in later, without demoting it', async () => {
    // A published source pushed by the CLI: editing it must not knock it back
    // to needs-review the way filing an upload does.
    fake.seed('library/sources/fema-nfhl/meta.json', JSON.stringify({ title: 'FEMA flood zones', status: 'published', source: SOURCE }))
    const auth = await login()
    await reindex(auth)
    const res = await patch(auth, 'fema-nfhl', {
      source: { ...SOURCE, access: [{ type: 'arcgis', url: 'https://hazards.fema.gov/arcgis/FeatureServer/0' }], relevance: 'Flood zone for the parcel.' },
    })
    expect(res.status).toBe(200)
    expect(res.body.entry).toMatchObject({ kind: 'source', status: 'published' })
    expect(res.body.entry.meta.source.access).toEqual([{ type: 'arcgis', url: 'https://hazards.fema.gov/arcgis/FeatureServer/0' }])
    expect(res.body.entry.meta.source.relevance).toBe('Flood zone for the parcel.')
    expect((await listFiles('library/sources/fema-nfhl/')).map(f => f.key)).toEqual(['library/sources/fema-nfhl/meta.json'])
    const audit = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'library.file' AND target = 'fema-nfhl'`)
    expect(audit.rows.at(-1)!.detail.kindChangedTo).toBeUndefined() // already a source
  })

  it('400s a block with no provider and 409s an entry that has a file attached', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    const bad = await patch(auth, slug, { source: { geography: 'county' } })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/provider/)
    expect((await listFiles(`library/incoming/${slug}/`)).length).toBe(1) // untouched

    // An upload IS held data — that's a document, not a pointer to one.
    fake.seed('library/incoming/held/meta.json', JSON.stringify({ title: 'Held', status: 'needs-cataloging' }))
    fake.seed('library/incoming/held/parcels.csv', 'a,b\n')
    await reindex(auth)
    const held = await patch(auth, 'held', { source: SOURCE })
    expect(held.status).toBe(409)
    expect(held.body.error).toMatch(/file attached/)
    expect((await listFiles('library/sources/held/')).length).toBe(0)
  })

  it('files without a source block exactly as before', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    const res = await patch(auth, slug, { title: 'FEMA portal', category: 'environment', tags: ['flood'] })
    expect(res.status).toBe(200)
    expect(res.body.entry).toMatchObject({ kind: 'incoming', status: 'needs-review', title: 'FEMA portal' })
    expect((await listFiles(`library/incoming/${slug}/`)).map(f => f.key)).toEqual([`library/incoming/${slug}/meta.json`])
  })
})

/**
 * P5-88: the list answer is compressed, revalidated, and cut to what a list
 * reads. The measured baseline this replaces: 214 KB raw, no compression, no
 * Cache-Control, no conditional request — 91 KB of it `meta.source`, which no
 * card, facet or attention row has ever looked at.
 */
describe('P5-88 — compression, conditional requests, list rows', () => {
  /** A source manifest the size of a real one: two access methods, a field
   *  dictionary, a licence, a cadence, a paragraph of relevance. */
  const FAT_SOURCE = {
    title: 'EPA Superfund National Priorities List (NPL) sites',
    category: 'environment',
    status: 'published',
    tags: ['environmental-risk', 'contamination'],
    description: 'Every site on, proposed for, or deleted from the National Priorities List.',
    source: {
      provider: 'US EPA',
      program: 'Superfund / SEMS',
      homepage: 'https://www.epa.gov/superfund/search-superfund-sites-where-you-live',
      geography: 'point',
      coverage: 'national',
      granularity: ['point', 'parcel', 'county', 'state'],
      topics: ['superfund', 'contamination', 'remediation', 'hazardous waste'],
      fields: Array.from({ length: 8 }, (_, i) => ({
        name: `Field_${i}`,
        description: 'One column of the published table, described for whoever reads it next.',
      })),
      access: [
        { type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0', auth: 'none', notes: 'Buffer query at a point.' },
        { type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/1', auth: 'none', notes: 'Site boundary polygons.' },
      ],
      placeQuery: { by: ['point', 'county', 'state'], radiusMiles: 5 },
      license: 'public domain',
      updateCadence: 'continuous, with NPL rulemakings roughly twice a year',
      lastChecked: '2026-09-05',
      relevance: 'Any NPL site within a few miles of a candidate parcel is a red flag. '.repeat(6),
      notes: 'The point service is owned by an individual EPA account rather than the institutional one. '.repeat(3),
      replication: { status: 'indexed' },
      lastError: { at: '2026-09-01T00:00:00.000Z', code: 'http', text: 'the agency returned 503' },
    },
  }

  /** A dropped link that has been fetched, inspected and run past the model:
   *  the other shape that makes a manifest big. */
  const FAT_LINK = {
    title: 'Georgia EPD — UST/LUST portal',
    status: 'needs-cataloging',
    url: 'https://epd.georgia.gov/ust',
    fetch: { status: 'fetched', at: '2026-09-02T10:00:00.000Z', bytes: 84213, name: 'ust.html' },
    suggested: {
      title: 'Georgia UST/LUST sites',
      category: 'environment',
      tags: ['contamination'],
      summary: 'Underground storage tanks and leaking tanks, by site. '.repeat(4),
      at: '2026-09-02T10:01:00.000Z',
    },
    inspection: {
      kind: 'portal',
      confidence: 'high',
      url: 'https://epd.georgia.gov/ust',
      checkedAt: '2026-09-02T10:00:30.000Z',
      summary: 'A state agency portal listing tank sites.',
      links: Array.from({ length: 20 }, (_, i) => ({
        url: `https://epd.georgia.gov/page-${i}`,
        label: `Some linked page number ${i} on the portal`,
        kind: 'page',
        role: 'related',
      })),
      documents: Array.from({ length: 6 }, (_, i) => ({ url: `https://epd.georgia.gov/doc-${i}.pdf`, label: `Report ${i}` })),
      dropped: Array.from({ length: 10 }, (_, i) => `https://epd.georgia.gov/dropped-${i}`),
      prose: { isDataset: true, accessNotes: ['Download requires accepting the terms page.'] },
      page: { title: 'UST/LUST', provider: 'Georgia EPD', insecure: false },
      notes: ['Two of the tables are images.'],
    },
    ingest: { plan: 'replicate', mode: 'by-hand', owner: 'maria', note: 'Ask the agency for the raw extract.', decidedBy: 'maria', decidedAt: '2026-09-03T00:00:00.000Z' },
    lineage: { files: Array.from({ length: 12 }, (_, i) => `library/incoming/ga-ust/part-${i}.csv`), tool: 'rclone' },
    mentionedBy: [{ slug: 'land-loss', title: 'Land loss' }],
    // P6-5a: a dropped link records who dropped it, and the to-file queue is
    // scoped to that person (and to admins). The route's caller is maria, so
    // without this the fixture's own row would be hidden from her.
    linkedBy: 'maria',
  }

  async function seedFatLibrary(auth: { cookie: string; csrf: string }) {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(FAT_SOURCE))
    fake.seed('library/incoming/ga-ust/meta.json', JSON.stringify(FAT_LINK))
    fake.seed(
      'library/notes/long-note/meta.json',
      JSON.stringify({
        title: 'What we learned in Hancock County',
        category: 'research',
        status: 'open',
        body: 'A paragraph of field notes that nobody reads from a list. '.repeat(40),
        createdBy: 'maria',
      }),
    )
    await reindex(auth)
  }

  it('gzips the catalog list for a caller that accepts it, and sends it plain for one that does not', async () => {
    const auth = await login()
    await seedFatLibrary(auth)

    const gzipped = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie).set('Accept-Encoding', 'gzip')
    expect(gzipped.status).toBe(200)
    expect(gzipped.headers['content-encoding']).toBe('gzip')
    // Compressed in transit, identical on arrival.
    expect(gzipped.body.entries.map((e: any) => e.slug)).toContain('epa-npl')
    // A shared cache must never key this answer on the wrong request.
    expect(String(gzipped.headers.vary)).toMatch(/accept-encoding/i)

    const plain = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie).set('Accept-Encoding', 'identity')
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.entries.map((e: any) => e.slug).sort()).toEqual(gzipped.body.entries.map((e: any) => e.slug).sort())
  })

  it('does not gzip an answer below the threshold', async () => {
    const auth = await login()
    // The health check is ~20 bytes; compressing it would cost more than it saves.
    const res = await request(app).get('/api/health').set('Accept-Encoding', 'gzip')
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBeUndefined()
    expect(auth.cookie).toBeTruthy()
  })

  it('sends Cache-Control: private, no-cache and an ETag, and answers 304 to If-None-Match', async () => {
    const auth = await login()
    await seedFatLibrary(auth)

    for (const path of ['/api/library/catalog', '/api/library/catalog/epa-npl']) {
      const first = await request(app).get(path).set('Cookie', auth.cookie)
      expect(first.status).toBe(200)
      expect(first.headers['cache-control']).toBe('private, no-cache')
      expect(first.headers.etag).toBeTruthy()

      const again = await request(app).get(path).set('Cookie', auth.cookie).set('If-None-Match', first.headers.etag)
      expect(again.status).toBe(304)
      expect(again.text).toBeFalsy()
      expect(again.headers['cache-control']).toBe('private, no-cache')
    }
  })

  it('gives a new ETag once the catalog changes, so a stale copy is never revalidated into place', async () => {
    const auth = await login()
    await seedFatLibrary(auth)
    const before = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)

    fake.seed('library/wiki/brand-new-page.md', '# Brand new page\n')
    await reindex(auth)

    const after = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie).set('If-None-Match', before.headers.etag)
    expect(after.status).toBe(200)
    expect(after.headers.etag).not.toBe(before.headers.etag)
    expect(after.body.entries.map((e: any) => e.slug)).toContain('brand-new-page')
  })

  it('sends list rows: the fields a list reads, without the manifest behind them', async () => {
    const auth = await login()
    await seedFatLibrary(auth)
    const res = await request(app).get('/api/library/catalog?archived=1').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const bySlug = Object.fromEntries(res.body.entries.map((e: any) => [e.slug, e]))

    // What the cards and ⌘K read survives.
    expect(bySlug['epa-npl'].meta.source.provider).toBe('US EPA')
    expect(bySlug['epa-npl'].meta.source.lastError.code).toBe('http')
    expect(bySlug['epa-npl'].meta.description).toContain('National Priorities List')
    expect(bySlug['ga-ust'].meta.url).toBe('https://epd.georgia.gov/ust')
    expect(bySlug['ga-ust'].meta.fetch).toEqual({ status: 'fetched', at: '2026-09-02T10:00:00.000Z' })
    expect(bySlug['ga-ust'].meta.inspection).toEqual({ kind: 'portal', checkedAt: '2026-09-02T10:00:30.000Z' })
    expect(bySlug['ga-ust'].meta.ingest).toEqual({ plan: 'replicate' })
    expect(bySlug['ga-ust'].meta.suggested.summary).toBeTruthy()
    // Top-level row fields are untouched — the cards read all of these.
    expect(bySlug['epa-npl']).toMatchObject({ kind: 'source', status: 'published', title: expect.any(String) })
    expect(bySlug['epa-npl'].readiness.as).toBe('source')
    expect(Array.isArray(bySlug['epa-npl'].files)).toBe(true)
    expect(typeof bySlug['epa-npl'].bytes).toBe('number')

    // What only the entry page reads is gone.
    expect(bySlug['epa-npl'].meta.source.access).toBeUndefined()
    expect(bySlug['epa-npl'].meta.source.fields).toBeUndefined()
    expect(bySlug['epa-npl'].meta.source.license).toBeUndefined()
    expect(bySlug['ga-ust'].meta.inspection.links).toBeUndefined()
    expect(bySlug['ga-ust'].meta.inspection.documents).toBeUndefined()
    expect(bySlug['ga-ust'].meta.inspection.dropped).toBeUndefined()
    expect(bySlug['ga-ust'].meta.inspection.prose).toBeUndefined()
    expect(bySlug['ga-ust'].meta.lineage).toBeUndefined()
    expect(bySlug['ga-ust'].meta.mentionedBy).toBeUndefined()
    expect(bySlug['ga-ust'].meta.ingest.note).toBeUndefined()
    expect(bySlug['long-note'].meta.body).toBeUndefined()
  })

  it('keeps the whole manifest on one entry, and on the list when asked for full=1', async () => {
    const auth = await login()
    await seedFatLibrary(auth)

    const one = await request(app).get('/api/library/catalog/epa-npl').set('Cookie', auth.cookie)
    expect(one.body.entry.meta.source.access).toHaveLength(2)
    expect(one.body.entry.meta.source.fields).toHaveLength(8)

    const full = await request(app).get('/api/library/catalog?full=1').set('Cookie', auth.cookie)
    const npl = full.body.entries.find((e: any) => e.slug === 'epa-npl')
    expect(npl.meta.source.access).toHaveLength(2)
    const link = full.body.entries.find((e: any) => e.slug === 'ga-ust')
    expect(link.meta.inspection.links).toHaveLength(20)
    expect(full.body.entries.find((e: any) => e.slug === 'long-note').meta.body).toContain('field notes')
  })

  it('measures what the projection and gzip actually save on this list', async () => {
    const auth = await login()
    await seedFatLibrary(auth)
    const full = await request(app).get('/api/library/catalog?full=1&archived=1').set('Cookie', auth.cookie)
    const list = await request(app).get('/api/library/catalog?archived=1').set('Cookie', auth.cookie)

    const size = (body: unknown) => {
      const raw = Buffer.from(JSON.stringify(body))
      return { raw: raw.byteLength, gz: gzipSync(raw).byteLength }
    }
    const before = size(full.body)
    const after = size(list.body)
    console.log(
      `[P5-88] catalog list (${list.body.entries.length} entries): ` +
        `full manifests ${before.raw} B raw / ${before.gz} B gz → ` +
        `list rows ${after.raw} B raw / ${after.gz} B gz`,
    )
    // The manifests are the bulk of a list answer, so cutting them to what a
    // list reads has to be a large win, not a rounding error.
    expect(after.raw).toBeLessThan(before.raw * 0.55)
    expect(after.gz).toBeLessThan(before.gz)
  })
})

describe('PATCH /api/library/catalog/:slug with organization and shape (P6-8a)', () => {
  async function dropLink(auth: { cookie: string; csrf: string }): Promise<string> {
    const res = await request(app)
      .post('/api/library/links')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ url: 'https://msc.fema.gov/portal/home' })
    expect(res.status).toBe(201)
    return res.body.slug
  }

  function patch(auth: { cookie: string; csrf: string }, slug: string, body: unknown) {
    return request(app)
      .patch(`/api/library/catalog/${slug}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send(body)
  }

  it('writes both into the manifest, the row reads them back, and a reindex keeps them', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    const res = await patch(auth, slug, { title: 'FEMA flood zones', category: 'environment', organization: 'fema', shape: 'areas' })
    expect(res.status).toBe(200)
    expect(res.body.entry.meta).toMatchObject({ organization: 'fema', shape: 'areas' })
    expect(res.body.entry).toMatchObject({ organization: 'fema', shape: 'areas' })

    await reindex(auth)
    const after = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(after.body.entry.meta).toMatchObject({ organization: 'fema', shape: 'areas' })
  })

  it('refuses a publisher or a shape the vocabulary does not know, and writes nothing', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    const badOrg = await patch(auth, slug, { organization: 'acme-corp' })
    expect(badOrg.status).toBe(400)
    expect(badOrg.body.error).toMatch(/publishers.*acme-corp/)
    const badShape = await patch(auth, slug, { shape: 'table' })
    expect(badShape.status).toBe(400)
    expect(badShape.body.error).toMatch(/areas, points, statistics, lines, records.*table/)
    const entry = await request(app).get(`/api/library/catalog/${slug}`).set('Cookie', auth.cookie)
    expect(entry.body.entry.meta.organization).toBeUndefined()
    expect(entry.body.entry.meta.shape).toBeUndefined()
  })

  it('an empty string clears a field so the reindex derives it again', async () => {
    const auth = await login()
    const slug = await dropLink(auth)
    await patch(auth, slug, { organization: 'fema', shape: 'areas' })
    const res = await patch(auth, slug, { organization: '', shape: '' })
    expect(res.status).toBe(200)
    expect(res.body.entry.meta.organization).toBeUndefined()
    expect(res.body.entry.meta.shape).toBeUndefined()
  })
})

/**
 * P6-33 / P6-34: one attention row, and Keep / Edit / Clear on what a model
 * wrote.
 *
 * Everything here goes through the real app — the auth guard, CSRF, the
 * manifest write, the re-index of the one row — because the thing being
 * asserted is that a value's provenance survives the round trip. A record
 * that lived only in memory would pass a unit test and fail the first reindex.
 */
describe('provenance and the verification queue (P6-34)', () => {
  /** A document a model filed, with the sentence it read it from. */
  function seedModelFiled(slug = 'why-five-million-memo'): void {
    fake.seed(`library/documents/${slug}/memo.rtf`, 'memo')
    fake.seed(
      `library/documents/${slug}/meta.json`,
      JSON.stringify({
        title: 'Why five million',
        category: 'land',
        status: 'published',
        provenance: {
          topic: {
            mechanism: 'model',
            at: '2026-10-05T09:00:00.000Z',
            value: 'land',
            evidence: 'Black landowners held fifteen million acres in 1910.',
            via: 'category',
          },
        },
      }),
    )
  }

  const verify = (auth: { cookie: string; csrf: string }, slug: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/library/catalog/${slug}/verify`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send(body)

  const attention = async (auth: { cookie: string; csrf: string }, key: string) => {
    const res = await request(app).get(`/api/library/catalog?attention=${key}`).set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    return res.body.entries.map((e: any) => e.slug) as string[]
  }

  it('keeps a model value through a reindex, and lists it as unverified', async () => {
    seedModelFiled()
    const auth = await login()
    await reindex(auth)
    // The record is in the manifest, so the rebuild reads it back rather than
    // losing it — the acceptance criterion "provenance surviving a reindex".
    const one = await request(app).get('/api/library/catalog/why-five-million-memo').set('Cookie', auth.cookie)
    expect(one.body.entry.meta.provenance.topic.mechanism).toBe('model')
    expect(one.body.entry.meta.provenance.topic.evidence).toContain('fifteen million acres')
    expect(await attention(auth, 'unverified')).toEqual(['why-five-million-memo'])
    // A list row carries it too — the browsers compute the queue per row.
    const list = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    const row = list.body.entries.find((e: any) => e.slug === 'why-five-million-memo')
    expect(row.meta.provenance.topic.mechanism).toBe('model')
  })

  it('never queues a derived value, however it got onto the row', async () => {
    const auth = await login()
    await reindex(auth)
    // `tn-heirs` has a hand-written category and a derived shape; the two
    // sources carry derived coverage. None of it is a model's reading.
    expect(await attention(auth, 'unverified')).toEqual([])
  })

  it('Keep records a person vouching and takes the field off the queue for good', async () => {
    seedModelFiled()
    const auth = await login()
    await reindex(auth)
    const res = await verify(auth, 'why-five-million-memo', { field: 'topic', action: 'keep' })
    expect(res.status).toBe(200)
    // The words stay the model's — rewriting the mechanism to `person` would
    // claim somebody wrote what a model wrote.
    expect(res.body.provenance.topic.mechanism).toBe('model')
    expect(res.body.provenance.topic.verifiedBy).toBe('maria')
    expect(res.body.entry.category).toBe('land')
    expect(await attention(auth, 'unverified')).toEqual([])
    expect(await attention(auth, 'needs-a-look')).not.toContain('why-five-million-memo')
  })

  it('Edit marks the value a person’s and leaves the queue', async () => {
    seedModelFiled()
    const auth = await login()
    await reindex(auth)
    const res = await verify(auth, 'why-five-million-memo', { field: 'topic', action: 'edit', value: 'housing' })
    expect(res.status).toBe(200)
    expect(res.body.entry.category).toBe('housing')
    expect(res.body.provenance.topic.mechanism).toBe('person')
    expect(res.body.provenance.topic.evidence).toBeUndefined()
    expect(await attention(auth, 'unverified')).toEqual([])
  })

  it('Clear returns the field to EMPTY so the entry rejoins the list (P6-34)', async () => {
    seedModelFiled()
    const auth = await login()
    await reindex(auth)
    const res = await verify(auth, 'why-five-million-memo', { field: 'topic', action: 'clear' })
    expect(res.status).toBe(200)
    // Not back to its rejected value, and not silently kept: empty.
    expect(res.body.entry.category).toBe('')
    expect(res.body.provenance.topic).toBeUndefined()
    expect(await attention(auth, 'unverified')).toEqual([])
    expect(await attention(auth, 'uncategorised')).toContain('why-five-million-memo')
    expect(await attention(auth, 'needs-a-look')).toContain('why-five-million-memo')
  })

  it('refuses a Keep on something nobody needs to verify, and a word it does not know', async () => {
    const auth = await login()
    await reindex(auth)
    expect((await verify(auth, 'tn-heirs', { field: 'topic', action: 'keep' })).status).toBe(409)
    expect((await verify(auth, 'tn-heirs', { field: 'vibes', action: 'keep' })).status).toBe(400)
    expect((await verify(auth, 'tn-heirs', { field: 'topic', action: 'accept' })).status).toBe(400)
    // Edit with nothing in it is Clear, and has its own word.
    expect((await verify(auth, 'tn-heirs', { field: 'topic', action: 'edit', value: '  ' })).status).toBe(400)
    expect((await verify(auth, 'no-such-entry', { field: 'topic', action: 'clear' })).status).toBe(404)
  })

  it('answers `needs-a-look` with the union of the per-field queues, each entry once', async () => {
    seedModelFiled()
    const auth = await login()
    await reindex(auth)
    const rolled = await attention(auth, 'needs-a-look')
    const parts = new Set<string>()
    for (const key of ['uncategorised', 'no-organization', 'no-coverage', 'no-answers-line', 'no-summary', 'unverified']) {
      for (const slug of await attention(auth, key)) parts.add(slug)
    }
    // P6-23's invariant, asked of the roll-up: the count and the list it opens
    // are one set, and an entry on three of the per-field queues appears once.
    expect([...rolled].sort()).toEqual([...parts].sort())
    expect(new Set(rolled).size).toBe(rolled.length)
    // And the per-field links still narrow to their own field.
    expect(await attention(auth, 'unverified')).toEqual(['why-five-million-memo'])
  })

  it('never puts the library’s own kept output on the queue', async () => {
    // Found live: two kept place reports sat on needs-a-look with nothing a
    // model could read, so they could never be filled. A queue that counts
    // what it generates never drains. Mirrors the client's `isGeneratedNote`.
    fake.seed(
      'library/notes/place-report-40-7785-73-9572/meta.json',
      JSON.stringify({ title: 'Place report: 40.7785, -73.9572', category: 'research', status: 'open', tags: ['ask'], body: '# Place report' }),
    )
    // A note a PERSON wrote, with a purpose but no topic, still counts.
    fake.seed(
      'library/notes/for-william-idea/meta.json',
      JSON.stringify({ title: 'For William', category: 'strategy', status: 'open', tags: ['pitch'], body: 'An idea.' }),
    )
    const auth = await login()
    await reindex(auth)
    const uncategorised = await attention(auth, 'uncategorised')
    expect(uncategorised).not.toContain('place-report-40-7785-73-9572')
    expect(uncategorised).toContain('for-william-idea')
    expect(await attention(auth, 'needs-a-look')).not.toContain('place-report-40-7785-73-9572')
  })

  it('keeps the remediation run to admins', async () => {
    const auth = await login()
    const res = await request(app)
      .post('/api/library/remediate')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({})
    expect(res.status).toBe(403)
  })
})

/**
 * P7-7: the answers line, end to end.
 *
 * Through the real app for the reason the P6-34 block above gives: a value's
 * provenance has to survive the manifest write and the re-index of the row,
 * and a record that lived only in memory would pass a unit test and fail the
 * first reindex.
 */
describe('what a dataset answers (P7-7)', () => {
  const ANSWER = 'Answers: which Tennessee counties have the highest share of heirs’ property.'

  const verify = (auth: { cookie: string; csrf: string }, slug: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/library/catalog/${slug}/verify`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send(body)

  const attention = async (auth: { cookie: string; csrf: string }, key: string) => {
    const res = await request(app).get(`/api/library/catalog?attention=${key}`).set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    return res.body.entries.map((e: any) => e.slug) as string[]
  }

  /** The same dataset, with a line a model wrote and its evidence. */
  function seedModelAnswer(): void {
    fake.seed(
      'library/datasets/tn-heirs/meta.json',
      JSON.stringify({
        title: "Heirs' property share — TN",
        category: 'land',
        status: 'published',
        tags: ['tennessee', 'land'],
        whatItAnswers: ANSWER,
        provenance: {
          whatItAnswers: {
            mechanism: 'model',
            at: '2026-10-06T09:00:00.000Z',
            value: ANSWER,
            evidence: 'The table reports the share of parcels held as heirs’ property in each county.',
            via: 'field',
          },
        },
      }),
    )
  }

  it('survives a reindex, rides the list row, and is listed as unverified', async () => {
    seedModelAnswer()
    const auth = await login()
    await reindex(auth)
    const one = await request(app).get('/api/library/catalog/tn-heirs').set('Cookie', auth.cookie)
    expect(one.body.entry.meta.whatItAnswers).toBe(ANSWER)
    expect(one.body.entry.meta.provenance.whatItAnswers.mechanism).toBe('model')
    // A LIST row carries it: `search_library` is assembled from one, and so is
    // the per-row needs-a-look line.
    const list = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    const row = list.body.entries.find((e: any) => e.slug === 'tn-heirs')
    expect(row.meta.whatItAnswers).toBe(ANSWER)
    expect(await attention(auth, 'unverified')).toContain('tn-heirs')
    expect(await attention(auth, 'no-answers-line')).not.toContain('tn-heirs')
  })

  it('counts the gap for datasets and sources only, under the one row', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify({ title: 'EPA NPL sites', source: { provider: 'US EPA' } }))
    const auth = await login()
    await reindex(auth)
    const gap = await attention(auth, 'no-answers-line')
    expect(gap).toEqual(expect.arrayContaining(['tn-heirs', 'epa-npl']))
    // A document's "what it answers" is its summary — it is never asked.
    expect(gap).not.toContain('field-notes')
    // P6-33's row covers it; no new row of its own.
    expect(await attention(auth, 'needs-a-look')).toEqual(expect.arrayContaining(['tn-heirs', 'epa-npl']))
  })

  it('takes Keep, Edit and Clear like any other unverified field', async () => {
    seedModelAnswer()
    const auth = await login()
    await reindex(auth)

    const kept = await verify(auth, 'tn-heirs', { field: 'whatItAnswers', action: 'keep' })
    expect(kept.status).toBe(200)
    expect(kept.body.provenance.whatItAnswers.verifiedBy).toBe('maria')
    expect(await attention(auth, 'unverified')).not.toContain('tn-heirs')

    const edited = await verify(auth, 'tn-heirs', { field: 'whatItAnswers', action: 'edit', value: 'Answers: who inherited what.' })
    expect(edited.status).toBe(200)
    expect(edited.body.entry.meta.whatItAnswers).toBe('Answers: who inherited what.')
    expect(edited.body.provenance.whatItAnswers.mechanism).toBe('person')

    const cleared = await verify(auth, 'tn-heirs', { field: 'whatItAnswers', action: 'clear' })
    expect(cleared.status).toBe(200)
    // Back to EMPTY, so the entry rejoins the list rather than silently
    // keeping a value somebody rejected.
    expect(cleared.body.entry.meta.whatItAnswers).toBeUndefined()
    expect(await attention(auth, 'no-answers-line')).toContain('tn-heirs')
  })

  it('refuses a line too long to ride on a search row', async () => {
    const auth = await login()
    await reindex(auth)
    const res = await verify(auth, 'tn-heirs', { field: 'whatItAnswers', action: 'edit', value: 'a'.repeat(241) })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('one or two sentences')
  })
})

/**
 * P7-10: when a dataset is from, end to end — through a real reindex, onto the
 * row and the list row, into the two queues, and back out through Keep / Edit /
 * Clear.
 */
describe('when a dataset is from (P7-10)', () => {
  const verify = (auth: { cookie: string; csrf: string }, slug: string, body: Record<string, unknown>) =>
    request(app)
      .post(`/api/library/catalog/${slug}/verify`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send(body)

  const attention = async (auth: { cookie: string; csrf: string }, key: string) => {
    const res = await request(app).get(`/api/library/catalog?attention=${key}`).set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    return res.body.entries.map((e: any) => e.slug) as string[]
  }

  it('promotes the three dates onto the row and onto a LIST row, through a real reindex', async () => {
    fake.seed(
      'library/datasets/acs-renters/meta.json',
      JSON.stringify({
        title: 'Renter households',
        category: 'housing',
        status: 'published',
        dates: { covers: '2019 to 2023', published: 'March 2024' },
        lineage: { from: 'https://api.census.gov/x', fetchedAt: '2026-09-29T23:22:13.610Z' },
      }),
    )
    const auth = await login()
    await reindex(auth)

    const one = await request(app).get('/api/library/catalog/acs-renters').set('Cookie', auth.cookie)
    // Normalised on the way through — a person's "2019 to 2023" is stored and
    // read in the one sortable spelling.
    expect(one.body.entry.dates).toEqual({ covers: '2019/2023', published: '2024-03', fetched: '2026-09-29' })

    // A LIST row carries it, like `coverage` and for the same reason: the map
    // legend, `search_library` and the needs-a-look line all read a list row.
    const list = await request(app).get('/api/library/catalog').set('Cookie', auth.cookie)
    const row = list.body.entries.find((e: any) => e.slug === 'acs-renters')
    expect(row.dates).toEqual({ covers: '2019/2023', published: '2024-03', fetched: '2026-09-29' })

    // Dated on both facts, so on neither queue.
    expect(await attention(auth, 'no-period-covered')).not.toContain('acs-renters')
    expect(await attention(auth, 'no-published-date')).not.toContain('acs-renters')
  })

  it('derives the period off a layer block’s year with nobody writing anything', async () => {
    fake.seed(
      'library/datasets/sites/meta.json',
      JSON.stringify({
        title: 'Sites',
        category: 'land',
        status: 'published',
        layer: { geometry: 'point', name: 'Sites', year: 2026, pointKey: 'name' },
      }),
    )
    const auth = await login()
    await reindex(auth)
    const one = await request(app).get('/api/library/catalog/sites').set('Cookie', auth.cookie)
    expect(one.body.entry.dates.covers).toBe('2026')
    // Derived, so it never joins the verification queue.
    expect(one.body.entry.meta.provenance?.covers).toBeUndefined()
    expect(await attention(auth, 'unverified')).not.toContain('sites')
    expect(await attention(auth, 'no-period-covered')).not.toContain('sites')
    // The release date is a different fact and nothing derives it.
    expect(await attention(auth, 'no-published-date')).toContain('sites')
  })

  it('derives the period off the table’s own year column, which needs the file', async () => {
    fake.seed('library/datasets/permits/meta.json', JSON.stringify({ title: 'Permits', category: 'land', status: 'published' }))
    fake.seed('library/datasets/permits/permits.csv', 'GEOID,year,permits\n13001,2021,4\n13002,2023,9\n')
    const auth = await login()
    await reindex(auth)
    const one = await request(app).get('/api/library/catalog/permits').set('Cookie', auth.cookie)
    expect(one.body.entry.dates.covers).toBe('2021/2023')
  })

  it('counts both gaps for datasets and sources only, under the one row', async () => {
    fake.seed('library/datasets/undated/meta.json', JSON.stringify({ title: 'Undated', category: 'land', status: 'published' }))
    const auth = await login()
    await reindex(auth)
    expect(await attention(auth, 'no-period-covered')).toContain('undated')
    expect(await attention(auth, 'no-published-date')).toContain('undated')
    // A wiki page and a document have an edit history already.
    expect(await attention(auth, 'no-period-covered')).not.toContain('field-notes')
    // P6-33's row covers both; no new row of its own.
    expect(await attention(auth, 'needs-a-look')).toContain('undated')
  })

  it('takes Keep, Edit and Clear on a date like any other unverified field', async () => {
    fake.seed(
      'library/datasets/portal-list/meta.json',
      JSON.stringify({
        title: 'Portal list',
        category: 'land',
        status: 'published',
        dates: { published: '2024-03-12' },
        provenance: {
          published: {
            mechanism: 'model',
            at: '2026-10-06T09:00:00.000Z',
            value: '2024-03-12',
            evidence: 'This dataset was last updated on March 12, 2024.',
            via: 'field',
          },
        },
      }),
    )
    const auth = await login()
    await reindex(auth)
    expect(await attention(auth, 'unverified')).toContain('portal-list')

    const kept = await verify(auth, 'portal-list', { field: 'published', action: 'keep' })
    expect(kept.status).toBe(200)
    expect(kept.body.provenance.published.verifiedBy).toBe('maria')
    expect(await attention(auth, 'unverified')).not.toContain('portal-list')

    // A person's own spelling is normalised before it is stored, so the
    // provenance record and the value on the row stay the same string.
    const edited = await verify(auth, 'portal-list', { field: 'published', action: 'edit', value: 'June 2019' })
    expect(edited.status).toBe(200)
    expect(edited.body.entry.dates.published).toBe('2019-06')
    expect(edited.body.provenance.published.mechanism).toBe('person')
    expect(edited.body.provenance.published.value).toBe('2019-06')

    const cleared = await verify(auth, 'portal-list', { field: 'published', action: 'clear' })
    expect(cleared.status).toBe(200)
    expect(cleared.body.entry.dates?.published).toBeUndefined()
    expect(await attention(auth, 'no-published-date')).toContain('portal-list')
  })

  it('refuses to store something that is not a date', async () => {
    fake.seed('library/datasets/undated/meta.json', JSON.stringify({ title: 'Undated', category: 'land', status: 'published' }))
    const auth = await login()
    await reindex(auth)
    const res = await verify(auth, 'undated', { field: 'covers', action: 'edit', value: 'every five years' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('a date must be')
  })

  it('refuses a Keep on a DERIVED date, because there is nothing unverified on it', async () => {
    // The acceptance criterion, as a refusal: a derived value is re-derived at
    // every reindex and a person "verifying" one adds nothing a re-run would
    // not.
    fake.seed(
      'library/datasets/sites/meta.json',
      JSON.stringify({ title: 'Sites', category: 'land', status: 'published', layer: { geometry: 'point', name: 'Sites', year: 2026, pointKey: 'name' } }),
    )
    const auth = await login()
    await reindex(auth)
    const res = await verify(auth, 'sites', { field: 'covers', action: 'keep' })
    expect(res.status).toBe(409)
    expect(res.body.error).toContain('nothing unverified')
  })

  it('leaves an untagged dataset behaving exactly as it did before', async () => {
    fake.seed('library/datasets/undated/meta.json', JSON.stringify({ title: 'Undated', category: 'land', status: 'published' }))
    const auth = await login()
    await reindex(auth)
    const one = await request(app).get('/api/library/catalog/undated').set('Cookie', auth.cookie)
    expect(one.status).toBe(200)
    // No `dates` key at all, rather than a block of empty strings.
    expect(one.body.entry.dates).toBeUndefined()
    expect(one.body.entry.meta.dates).toBeUndefined()
  })
})
