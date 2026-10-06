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
 * P5-31: dataset explorer API (schema + paged rows) against the real
 * createApp() with pg-mem + a fake bucket. The browse-size cap is lowered
 * for this file (env read at import) so the 413 path is testable with a
 * few KB instead of 25 MB.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'
process.env.TABULAR_MAX_BYTES = '4000'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { clearTabularCache } = await import('../services/libraryTabular.js')
const { resetInternalRateLimit, INTERNAL_RATE_LIMIT_MAX } = await import('../middleware/internalRateLimit.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('data-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

const ORGS_CSV =
  '#,Organization,Tier,HQ State,Score\n' +
  '1,Black Farmer Fund,Tier 1,NY,90\n' +
  '2,Southwest Georgia Project,Tier 1,GA,75\n' +
  '3,Proud Ground,Tier 2,OR,\n' +
  '4,Truly Living Well,Tier 2,GA,60\n' +
  '5,HEAL Food Alliance,Tier 3,CA,88\n'

beforeEach(async () => {
  clearTabularCache()
  // The limiter's store is module state shared by every case in this file.
  await resetInternalRateLimit()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-data-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/datasets/orgs/organizations.csv', ORGS_CSV)
  fake.seed('library/datasets/orgs/states.csv', 'state,count\nGA,2\nNY,1\n')
  fake.seed(
    'library/datasets/orgs/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'network', status: 'published', tags: ['homesteading'] }),
  )
  fake.seed('library/documents/notes/notes.pdf', '%PDF-fake')
  fake.seed('library/documents/notes/meta.json', JSON.stringify({ title: 'Notes', category: 'research', status: 'published' }))
  fake.seed('library/datasets/big/big.csv', 'a,b\n' + 'x,y\n'.repeat(1500))
  fake.seed('library/datasets/big/meta.json', JSON.stringify({ title: 'Big', category: 'research', status: 'published' }))
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
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username: 'maria', password: 'data-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

async function ready(): Promise<{ cookie: string; csrf: string }> {
  const auth = await login()
  const res = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
  expect(res.status).toBe(200)
  return auth
}

describe('auth boundary', () => {
  it('schema, rows, summary and export bare-401 without a session', async () => {
    for (const path of [
      '/api/library/data/orgs',
      '/api/library/data/orgs/rows',
      '/api/library/data/orgs/summary',
      '/api/library/data/orgs/summary?column=Tier',
      '/api/library/data/orgs/export.csv',
    ]) {
      const res = await request(app).get(path)
      expect(res.status, path).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
      // never a half-written CSV or a summary body on the way out
      expect(res.headers['content-disposition']).toBeUndefined()
    }
  })

  it('the summary and export routes sit behind the same per-user limiter as rows', async () => {
    const auth = await ready()
    const seen: number[] = []
    for (const path of ['/api/library/data/orgs/rows', '/api/library/data/orgs/summary', '/api/library/data/orgs/export.csv']) {
      const res = await request(app).get(path).set('Cookie', auth.cookie)
      expect(res.status, path).toBe(200)
      expect(Number(res.headers['ratelimit-limit']), path).toBe(INTERNAL_RATE_LIMIT_MAX)
      seen.push(Number(res.headers['ratelimit-remaining']))
    }
    // One shared bucket keyed by the account: each call spends from the same
    // allowance, so a summary/export loop cannot dodge the rows ceiling.
    expect(seen[1]).toBe(seen[0] - 1)
    expect(seen[2]).toBe(seen[1] - 1)
  })
})

describe('GET /api/library/data/:slug (schema)', () => {
  it('returns entry, file choice, columns with types + stats, and row count — never rows', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.entry).toEqual({ slug: 'orgs', title: 'Organizations', kind: 'dataset' })
    expect(res.body.file).toBe('organizations.csv')
    expect(res.body.files).toEqual(['organizations.csv', 'states.csv'])
    expect(res.body.rowCount).toBe(5)
    expect(res.body.rows).toBeUndefined()
    const byName = Object.fromEntries(res.body.columns.map((c: any) => [c.name, c]))
    expect(byName['Score'].type).toBe('number')
    expect(byName['Score'].filled).toBe(4)
    expect(byName['Score'].min).toBe(60)
    expect(byName['Tier'].topValues[0]).toEqual({ value: 'Tier 1', count: 2 })
    expect(typeof res.body.parsedAt).toBe('string')
  })

  it('summarises the entry\'s layer block for show-on-map (P5-36), null when there is none', async () => {
    fake.seed('library/datasets/orgs-hq/organizations.csv', 'Organization,lat,lng\nA,40,-73\n')
    fake.seed('library/datasets/orgs-hq/meta.json', JSON.stringify({ title: 'Orgs HQ', category: 'network', status: 'published', layer: { geometry: 'point', latKey: 'lat', lngKey: 'lng', labelKey: 'Organization', popupFields: [], name: 'Organizations (HQ)' } }))
    const auth = await ready()
    const pts = await request(app).get('/api/library/data/orgs-hq').set('Cookie', auth.cookie)
    expect(pts.body.layer).toEqual({ id: 'internal-orgs-hq', geometry: 'point', name: 'Organizations (HQ)', labelKey: 'Organization' })
    expect(JSON.stringify(pts.body.layer)).not.toContain('latKey')
    const plain = await request(app).get('/api/library/data/orgs').set('Cookie', auth.cookie)
    expect(plain.body.layer).toBeNull()
  })

  it('?file= selects another tabular file in the entry', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs?file=states.csv').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.file).toBe('states.csv')
    expect(res.body.columns.map((c: any) => c.name)).toEqual(['state', 'count'])
    expect(res.body.rowCount).toBe(2)
  })

  it('404 for an unknown slug and for an unknown ?file=', async () => {
    const auth = await ready()
    expect((await request(app).get('/api/library/data/nope').set('Cookie', auth.cookie)).status).toBe(404)
    const res = await request(app).get('/api/library/data/orgs?file=missing.csv').set('Cookie', auth.cookie)
    expect(res.status).toBe(404)
  })

  it('415 for an entry with no tabular file, 413 over the browse cap (message says download)', async () => {
    const auth = await ready()
    const pdf = await request(app).get('/api/library/data/notes').set('Cookie', auth.cookie)
    expect(pdf.status).toBe(415)
    expect(pdf.body.error).toMatch(/no tabular file/)
    const big = await request(app).get('/api/library/data/big').set('Cookie', auth.cookie)
    expect(big.status).toBe(413)
    expect(big.body.error).toMatch(/download/)
  })
})

describe('GET /api/library/data/:slug/rows', () => {
  it('pages rows with _row indexes and a total', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs/rows?limit=2&page=2').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body.total).toBe(5)
    expect(res.body.page).toBe(2)
    expect(res.body.limit).toBe(2)
    expect(res.body.rows.map((r: any) => r.Organization)).toEqual(['Proud Ground', 'Truly Living Well'])
    expect(res.body.rows[0]._row).toBe(2)
  })

  it('searches, filters, and sorts', async () => {
    const auth = await ready()
    const q = await request(app).get('/api/library/data/orgs/rows?q=georgia').set('Cookie', auth.cookie)
    expect(q.body.rows.map((r: any) => r.Organization)).toEqual(['Southwest Georgia Project'])

    const filter = encodeURIComponent(JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]))
    const f = await request(app)
      .get(`/api/library/data/orgs/rows?filter=${filter}&sort=Score&dir=desc`)
      .set('Cookie', auth.cookie)
    expect(f.body.total).toBe(2)
    expect(f.body.rows.map((r: any) => r.Score)).toEqual(['75', '60'])

    const s = await request(app).get('/api/library/data/orgs/rows?sort=Score').set('Cookie', auth.cookie)
    expect(s.body.rows.map((r: any) => r.Score)).toEqual(['60', '75', '88', '90', ''])
  })

  it('400s name the offending field', async () => {
    const auth = await ready()
    for (const [qs, re] of [
      ['sort=Nope', /unknown column/],
      ['filter=%7Bnot-json', /filter/],
      ['limit=501', /limit/],
      ['page=0', /page/],
      ['dir=up', /dir/],
    ] as const) {
      const res = await request(app).get(`/api/library/data/orgs/rows?${qs}`).set('Cookie', auth.cookie)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(re)
    }
  })

  it('respects ?file= and 404s unknown slugs', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs/rows?file=states.csv&sort=count&dir=desc').set('Cookie', auth.cookie)
    expect(res.body.rows.map((r: any) => r.state)).toEqual(['GA', 'NY'])
    expect((await request(app).get('/api/library/data/nope/rows').set('Cookie', auth.cookie)).status).toBe(404)
  })
})

describe('cache', () => {
  it('serves the parsed file from cache, and reindex picks up a changed file', async () => {
    const auth = await ready()
    const first = await request(app).get('/api/library/data/orgs').set('Cookie', auth.cookie)
    expect(first.body.rowCount).toBe(5)
    // Same request again → same parsedAt (cache hit, no re-parse).
    const again = await request(app).get('/api/library/data/orgs').set('Cookie', auth.cookie)
    expect(again.body.parsedAt).toBe(first.body.parsedAt)

    // An external push changes the file behind the server's back; the rule
    // is "hit Reindex" (sync mirror + clear caches) — after that, new rows.
    fake.seed('library/datasets/orgs/organizations.csv', ORGS_CSV + '6,Seed Commons,Tier 1,NY,70\n')
    const re = await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    expect(re.status).toBe(200)
    const after = await request(app).get('/api/library/data/orgs').set('Cookie', auth.cookie)
    expect(after.body.rowCount).toBe(6)
    expect(after.body.parsedAt).not.toBe(first.body.parsedAt)
  })
})

/**
 * P5-42: analysis for researchers who do not write code — per-column
 * summaries of the current filtered set, and a CSV of it.
 */
const FORMULA_CSV =
  'label,note,amount\n' +
  '=SUM(A1:A9),plain,-5\n' +
  '"Doe, Jane","say ""hi""",10\n' +
  '@import,+1,20\n' +
  '"=HYPERLINK(""x"",""y"")",z,30\n'

describe('GET /api/library/data/:slug/summary (P5-42)', () => {
  it('without ?column= describes every column of the whole file', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs/summary').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    const byName = Object.fromEntries(res.body.map((c: any) => [c.column, c]))
    expect(Object.keys(byName)).toEqual(['#', 'Organization', 'Tier', 'HQ State', 'Score'])
    expect(byName['Tier']).toEqual({ column: 'Tier', type: 'string', filledPct: 100, distinct: 3 })
    expect(byName['Score']).toEqual({ column: 'Score', type: 'number', filledPct: 80, distinct: 4 })
  })

  it('with ?column= gives filled / empty / different values / most common', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs/summary?column=Tier').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      column: 'Tier',
      type: 'string',
      filled: 5,
      empty: 0,
      distinct: 3,
      top: [
        { value: 'Tier 1', count: 2 },
        { value: 'Tier 2', count: 2 },
        { value: 'Tier 3', count: 1 },
      ],
      numbers: null,
      dates: null,
    })
  })

  it('describes numbers with smallest / middle / largest and ten bins', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs/summary?column=Score').set('Cookie', auth.cookie)
    expect(res.body.filled).toBe(4)
    expect(res.body.empty).toBe(1)
    expect(res.body.numbers).toMatchObject({ min: 60, max: 90, median: 81.5 })
    expect(res.body.numbers.mean).toBeCloseTo(78.25, 6)
    expect(res.body.numbers.histogram).toHaveLength(10)
    expect(res.body.dates).toBeNull()
  })

  it('summarises the CURRENT filtered set, taking the same q/filter params as /rows', async () => {
    const auth = await ready()
    const filter = encodeURIComponent(JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]))
    const res = await request(app).get(`/api/library/data/orgs/summary?column=Tier&filter=${filter}`).set('Cookie', auth.cookie)
    expect(res.body.filled).toBe(2)
    expect(res.body.top).toEqual([
      { value: 'Tier 1', count: 1 },
      { value: 'Tier 2', count: 1 },
    ])
    const q = await request(app).get('/api/library/data/orgs/summary?column=HQ+State&q=tier+1').set('Cookie', auth.cookie)
    expect(q.body.top).toEqual([
      { value: 'GA', count: 1 },
      { value: 'NY', count: 1 },
    ])
    // the overview follows the same filtered set
    const over = await request(app).get(`/api/library/data/orgs/summary?filter=${filter}`).set('Cookie', auth.cookie)
    expect(over.body.find((c: any) => c.column === 'HQ State').filledPct).toBe(100)
    expect(over.body.find((c: any) => c.column === 'Score').filledPct).toBe(100)
  })

  it('?groupBy=1 raises the most-common cap to 200 (that IS the group-by table)', async () => {
    fake.seed('library/datasets/many/data.csv', 'id\n' + Array.from({ length: 250 }, (_, i) => `v${i}`).join('\n') + '\n')
    fake.seed('library/datasets/many/meta.json', JSON.stringify({ title: 'Many', category: 'research', status: 'published' }))
    const auth = await ready()
    const capped = await request(app).get('/api/library/data/many/summary?column=id').set('Cookie', auth.cookie)
    expect(capped.body.top).toHaveLength(20)
    expect(capped.body.distinct).toBe(250)
    const grouped = await request(app).get('/api/library/data/many/summary?column=id&groupBy=1').set('Cookie', auth.cookie)
    expect(grouped.body.top).toHaveLength(200)
  })

  it('honours ?file= and 400s an unknown column or a malformed filter', async () => {
    const auth = await ready()
    const other = await request(app).get('/api/library/data/orgs/summary?file=states.csv&column=state').set('Cookie', auth.cookie)
    expect(other.body.top).toEqual([
      { value: 'GA', count: 1 },
      { value: 'NY', count: 1 },
    ])
    const bad = await request(app).get('/api/library/data/orgs/summary?column=Nope').set('Cookie', auth.cookie)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/unknown column/)
    const badFilter = await request(app).get('/api/library/data/orgs/summary?filter=%7Bnot-json').set('Cookie', auth.cookie)
    expect(badFilter.status).toBe(400)
    expect((await request(app).get('/api/library/data/nope/summary').set('Cookie', auth.cookie)).status).toBe(404)
  })
})

describe('GET /api/library/data/:slug/export.csv (P5-42)', () => {
  it('sends the filtered rows in the current sort as an attachment that is never cached', async () => {
    const auth = await ready()
    const filter = encodeURIComponent(JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]))
    const res = await request(app)
      .get(`/api/library/data/orgs/export.csv?filter=${filter}&sort=Score&dir=desc`)
      .set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe('attachment; filename="orgs-filtered.csv"')
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(res.text).toBe(
      '#,Organization,Tier,HQ State,Score\r\n' +
        '2,Southwest Georgia Project,Tier 1,GA,75\r\n' +
        '4,Truly Living Well,Tier 2,GA,60\r\n',
    )
  })

  it('exports every row when nothing is filtered, header first', async () => {
    const auth = await ready()
    const res = await request(app).get('/api/library/data/orgs/export.csv').set('Cookie', auth.cookie)
    const lines = res.text.trimEnd().split('\r\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('#,Organization,Tier,HQ State,Score')
    expect(lines[3]).toBe('3,Proud Ground,Tier 2,OR,')
  })

  it('?columns= picks the visible columns and 400s an unknown one', async () => {
    const auth = await ready()
    const json = await request(app)
      .get(`/api/library/data/orgs/export.csv?columns=${encodeURIComponent(JSON.stringify(['Organization', 'Score']))}&q=georgia`)
      .set('Cookie', auth.cookie)
    expect(json.text).toBe('Organization,Score\r\nSouthwest Georgia Project,75\r\n')
    // a comma-separated list works too (what a hand-written link looks like)
    const csvList = await request(app).get('/api/library/data/orgs/export.csv?columns=Tier&q=heal').set('Cookie', auth.cookie)
    expect(csvList.text).toBe('Tier\r\nTier 3\r\n')
    const bad = await request(app).get('/api/library/data/orgs/export.csv?columns=Nope').set('Cookie', auth.cookie)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/unknown column/)
  })

  it('neutralises formulas and quotes commas / quotes so a spreadsheet reads text, not code', async () => {
    fake.seed('library/datasets/risky/data.csv', FORMULA_CSV)
    fake.seed('library/datasets/risky/meta.json', JSON.stringify({ title: 'Risky', category: 'research', status: 'published' }))
    const auth = await ready()
    const res = await request(app).get('/api/library/data/risky/export.csv').set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    expect(res.text).toBe(
      'label,note,amount\r\n' +
        `'=SUM(A1:A9),plain,'-5\r\n` +
        `"Doe, Jane","say ""hi""",10\r\n` +
        `'@import,'+1,20\r\n` +
        // escaped first, then quoted — the apostrophe survives the quoting
        `"'=HYPERLINK(""x"",""y"")",z,30\r\n`,
    )
  })

  it('audits the export as library.export with the row count and the filters', async () => {
    const auth = await ready()
    const filter = encodeURIComponent(JSON.stringify([{ column: 'HQ State', op: 'eq', value: 'GA' }]))
    const res = await request(app).get(`/api/library/data/orgs/export.csv?filter=${filter}`).set('Cookie', auth.cookie)
    expect(res.status).toBe(200)
    const audit = await libraryQuery(`SELECT actor, action, target, detail FROM library_audit WHERE action = 'library.export'`)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].actor).toBe('maria')
    expect(audit.rows[0].target).toBe('orgs/organizations.csv')
    const detail = typeof audit.rows[0].detail === 'string' ? JSON.parse(audit.rows[0].detail) : audit.rows[0].detail
    expect(detail).toEqual({ slug: 'orgs', rows: 2, filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] })
  })

  it('does not audit a summary or a row read — only what leaves the building', async () => {
    const auth = await ready()
    await request(app).get('/api/library/data/orgs/summary?column=Tier').set('Cookie', auth.cookie)
    await request(app).get('/api/library/data/orgs/rows').set('Cookie', auth.cookie)
    const audit = await libraryQuery(`SELECT action FROM library_audit WHERE action LIKE 'library.%'`)
    expect(audit.rows.map((r: any) => r.action)).not.toContain('library.export')
  })
})
