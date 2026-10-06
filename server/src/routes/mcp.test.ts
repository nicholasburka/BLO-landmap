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
 * P5-50: the MCP endpoint and its read tools.
 *
 * Runs against the real createApp() with a pg-mem store and a fake bucket, so
 * the chain under test — bearer guard → per-user limiter → Streamable HTTP
 * transport → tool → audit — is production's. Tools are exercised BOTH over
 * the wire (real JSON-RPC through the transport) and by calling their `run`
 * directly, because the wire proves the wiring and the direct calls prove the
 * data without a JSON round trip in the way.
 *
 * `askKb` is the one dependency stubbed: it is the only tool that would call
 * Anthropic. Everything else in askKb.js (the dataset query tool) stays real.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const askKbStub = vi.hoisted(() => vi.fn())
vi.mock('../services/askKb.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/askKb.js')>()
  return { ...actual, askKb: askKbStub }
})

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { resetInternalRateLimit, INTERNAL_RATE_LIMIT_MAX } = await import('../middleware/internalRateLimit.js')
const { clearApiTokenTouchCache } = await import('../services/apiTokens.js')
const {
  MCP_TOOLS,
  PUBLIC_LAYERS,
  clearLayerValueCache,
  countyValues,
  parseLayerCsv,
  parseLayerJson,
  normalizeGeoid,
  DOCUMENT_MAX_CHARS,
  COUNTY_VALUES_MAX,
} = await import('../services/mcpTools.js')
const { MCP_WRITE_TOOLS } = await import('../services/mcpWriteTools.js')
const { registerClient, issueTokenPair, mcpResource } = await import('../services/oauthStore.js')
const { recentActivity } = await import('../services/libraryActivity.js')
const { auditArgs } = await import('./mcp.js')
const { setInspectDefaults, resetInspectDefaults } = await import('../services/linkInspect.js')
const inspectFixtures = await import('../testutils/fixtures/inspect/index.js')

const WRITE_TOOL_NAMES = MCP_WRITE_TOOLS.map(t => t.name)

const tool = (name: string) => {
  const found = MCP_TOOLS.find(t => t.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}
const run = (name: string, args: unknown = {}) => tool(name).run(args as never)

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('mcp-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

const VIEW_DOC = {
  name: 'Tennessee shortlist',
  savedBy: 'maria',
  savedById: 1,
  savedAt: '2026-09-01T10:00:00.000Z',
  state: { layers: [{ layerId: 'pct_Black', weight: 1 }], filters: [], limit: 10, regionStates: ['TN'], prompt: '', viewport: null },
  results: [{ rank: 1, geoId: '47157', name: 'Shelby County', state: 'Tennessee', score: 0.9 }],
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal'), ('nick', $1, 'admin'), ('ghost', $1, 'internal')`,
    [passwordHash],
  )
  await libraryQuery(`UPDATE library_users SET disabled = TRUE WHERE username = 'ghost'`)
  await resetInternalRateLimit()
  clearApiTokenTouchCache()
  clearLayerValueCache()
  askKbStub.mockReset()

  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-mcp-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/datasets/tn-heirs/data.csv', 'fips,county,tier\n47157,Shelby,A\n47037,Davidson,B\n47001,Anderson,A\n')
  fake.seed(
    'library/datasets/tn-heirs/meta.json',
    JSON.stringify({
      title: "Heirs' property share — TN",
      category: 'land',
      status: 'published',
      tags: ['tennessee'],
      description: 'County-level heirs property estimates for Tennessee.',
      source: 'county assessor scrape',
    }),
  )
  fake.seed('library/documents/field-notes/notes.pdf', '%PDF-fake')
  fake.seed('library/documents/field-notes/summary.txt', 'Interviews with twelve landowners in Shelby County.')
  fake.seed(
    'library/documents/field-notes/meta.json',
    JSON.stringify({ title: 'Field notes — heirs interviews', category: 'research', status: 'published', tags: [] }),
  )
  fake.seed('library/wiki/land-loss.md', '# Land loss\n\nPartition sales are the mechanism most often named.\n')
  fake.seed('library/views/tn-shortlist.json', JSON.stringify(VIEW_DOC))
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.PUBLIC_SITE_URL
})

let loginIp = 0
async function login(username = 'maria'): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.97.0.${++loginIp}`)
    .send({ username, password: 'mcp-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))!.split(';')[0]
  return { cookie, csrf: res.body.csrfToken }
}

/** Log in, reindex the seeded tree, and mint a token to call /mcp with.
 *  `write` mints one that also carries the write scope (P5-52). */
async function ready(
  username = 'maria',
  options: { write?: boolean; name?: string } = {},
): Promise<{ token: string; id: number; name: string; scopes: string[] }> {
  const auth = await login(username)
  const reindexed = await request(app)
    .post('/api/library/reindex')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
  expect(reindexed.status).toBe(200)
  const name = options.name ?? `${username} desktop`
  const minted = await request(app)
    .post('/api/library/tokens')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send({ name, ...(options.write ? { write: true } : {}) })
  expect(minted.status).toBe(201)
  return { token: minted.body.token, id: minted.body.id, name: minted.body.name, scopes: minted.body.scopes }
}

let rpcId = 0
function rpc(token: string, method: string, params?: unknown, client = 'ClaudeDesktop/1.2') {
  return request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    // The Streamable HTTP spec requires a client to accept both.
    .set('Accept', 'application/json, text/event-stream')
    .set('User-Agent', client)
    .send({ jsonrpc: '2.0', id: ++rpcId, method, params })
}

/** One tools/call over the wire → the parsed JSON the tool produced. */
async function callTool(token: string, name: string, args: unknown = {}, client?: string) {
  const res = await rpc(token, 'tools/call', { name, arguments: args }, client)
  expect(res.status).toBe(200)
  expect(res.body.error, JSON.stringify(res.body)).toBeUndefined()
  const result = res.body.result
  return {
    isError: result.isError === true,
    text: result.content[0].text as string,
    data: result.isError ? null : JSON.parse(result.content[0].text),
  }
}

/** Audit writes are fire-and-forget; let them land before asserting. */
async function auditRows(like = 'mcp.%') {
  await new Promise(resolve => setTimeout(resolve, 40))
  const { rows } = await libraryQuery(
    `SELECT actor, action, target, detail FROM library_audit WHERE action LIKE $1 ORDER BY id`,
    [like],
  )
  return rows as { actor: string; action: string; target: string | null; detail: any }[]
}

// --- Auth ---------------------------------------------------------------------

describe('bearer-token auth', () => {
  it('refuses a request with no token, a malformed header, or an unknown token', async () => {
    await ready()
    for (const headers of [{}, { Authorization: 'Basic abc' }, { Authorization: 'Bearer blo_nope' }, { Authorization: 'Bearer ' }]) {
      const res = await request(app)
        .post('/mcp')
        .set(headers as Record<string, string>)
        .set('Accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(res.status, JSON.stringify(headers)).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
  })

  it('refuses a revoked token and a token whose user has been disabled', async () => {
    const auth = await login()
    const minted = await request(app)
      .post('/api/library/tokens')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ name: 'laptop' })
    expect((await rpc(minted.body.token, 'tools/list')).status).toBe(200)

    await request(app)
      .delete(`/api/library/tokens/${minted.body.id}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect((await rpc(minted.body.token, 'tools/list')).status).toBe(401)

    // Disabling the account kills its live tokens too, with the same bare 401.
    const ghostAuth = await login('nick')
    const ghostToken = await request(app)
      .post('/api/library/tokens')
      .set('Cookie', ghostAuth.cookie)
      .set('X-CSRF-Token', ghostAuth.csrf)
      .send({ name: 'nicks laptop' })
    expect((await rpc(ghostToken.body.token, 'tools/list')).status).toBe(200)
    await libraryQuery(`UPDATE library_users SET disabled = TRUE WHERE username = 'nick'`)
    expect((await rpc(ghostToken.body.token, 'tools/list')).status).toBe(401)
  })

  it('stamps last_used_at once the token is exercised', async () => {
    const { token, id } = await ready()
    await rpc(token, 'tools/list')
    await new Promise(resolve => setTimeout(resolve, 20))
    const { rows } = await libraryQuery(`SELECT last_used_at FROM library_api_tokens WHERE id = $1`, [id])
    expect(rows[0].last_used_at).toBeTruthy()
  })

  it('keys the per-user limiter on the account, not the address', async () => {
    const maria = await ready('maria')
    const nick = await ready('nick')
    // Minting the tokens already spent from each bucket; start both clean so
    // the counts below mean only what this test did.
    await resetInternalRateLimit()
    const remaining = (res: any) => Number(res.headers['ratelimit-remaining'])

    expect(remaining(await rpc(maria.token, 'tools/list'))).toBe(INTERNAL_RATE_LIMIT_MAX - 1)
    expect(remaining(await rpc(maria.token, 'tools/list'))).toBe(INTERNAL_RATE_LIMIT_MAX - 2)

    // A different account starts from a full bucket even though every request
    // in this suite comes from the same address.
    expect(remaining(await rpc(nick.token, 'tools/list'))).toBe(INTERNAL_RATE_LIMIT_MAX - 1)
  })
})

// --- Protocol -----------------------------------------------------------------

describe('the MCP endpoint', () => {
  it('lists every tool with a model-readable description and honest annotations', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'tools/list')
    expect(res.status).toBe(200)
    const names = res.body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(
      [
        'append_to_page',
        'ask',
        'build_index',
        'county_values',
        'create_note',
        'drop_link',
        'fetch_for_place',
        'get_entry',
        'get_layer',
        'get_view',
        'inspect_link',
        'list_layers',
        'list_place_slices',
        'list_topics',
        'list_views',
        'measure_proximity',
        'place_report',
        'query_dataset',
        'read_document',
        'read_page',
        'save_view',
        'search_library',
        'update_page',
      ].sort(),
    )
    // No delete tool exists, on any surface.
    expect(names.some((n: string) => /delete|remove|purge/.test(n))).toBe(false)

    const writeNames = new Set(WRITE_TOOL_NAMES)
    // P5-57: fetching a source for a place reaches the outside world and
    // records a cache slice on the entry, so it is honestly not read-only —
    // and it is still allowed on a read-scope connection, because the slice
    // is a cache, not content.
    // P5-58: a place report is the same thing done to every applicable source
    // at once, so it carries the same honest annotations.
    const recordsSomething = new Set(['fetch_for_place', 'place_report'])
    // P5-59: inspect_link reaches the outside world too, but it creates
    // nothing at all — no entry, no manifest, not even a cache slice — so it
    // is open-world AND honestly read-only.
    const openWorld = new Set([...recordsSomething, 'inspect_link'])
    for (const t of res.body.result.tools) {
      expect(t.description.length, t.name).toBeGreaterThan(40)
      expect(t.annotations?.readOnlyHint, t.name).toBe(!writeNames.has(t.name) && !recordsSomething.has(t.name))
      expect(t.annotations?.openWorldHint ?? false, t.name).toBe(openWorld.has(t.name))
      // Nothing here destroys: there is no delete, and the page writes refuse
      // a stale baseline rather than overwrite one.
      expect(t.annotations?.destructiveHint, t.name).toBe(false)
      expect(t.inputSchema.type, t.name).toBe('object')
    }
    const hint = (name: string) =>
      res.body.result.tools.find((t: any) => t.name === name).annotations.idempotentHint
    // A whole-page replace lands on the same page twice; the rest add a thing per call.
    expect(hint('update_page')).toBe(true)
    expect(hint('create_note')).toBe(false)
    expect(hint('append_to_page')).toBe(false)
    expect(hint('drop_link')).toBe(false)
    expect(hint('save_view')).toBe(false)
    expect(hint('read_page')).toBe(true)
  })

  it('tells the host, in its own instructions, that library text is data', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    })
    expect(res.body.result.instructions).toMatch(/never an instruction/i)
    expect(res.body.result.instructions).toMatch(/no delete tool/i)
  })

  it('answers an unknown tool with an error rather than a crash', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'tools/call', { name: 'delete_everything', arguments: {} })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toMatch(/not found|unknown|invalid/i)
  })

  it('rejects arguments that do not match a tool schema, without touching the handler', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'tools/call', { name: 'read_page', arguments: { slug: 42 } })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).toMatch(/invalid|expected/i)
  })

  it('serves pages and entries as resources', async () => {
    const { token } = await ready()
    const list = await rpc(token, 'resources/list')
    expect(list.status).toBe(200)
    const uris = list.body.result.resources.map((r: any) => r.uri)
    expect(uris).toContain('library://page/land-loss')
    expect(uris).toContain('library://entry/tn-heirs')

    const page = await rpc(token, 'resources/read', { uri: 'library://page/land-loss' })
    expect(page.body.result.contents[0].text).toContain('Partition sales')
    expect(page.body.result.contents[0].mimeType).toBe('text/markdown')

    const entry = await rpc(token, 'resources/read', { uri: 'library://entry/tn-heirs' })
    expect(JSON.parse(entry.body.result.contents[0].text).title).toBe("Heirs' property share — TN")
  })

  it('answers GET and DELETE from the transport rather than 404ing the path', async () => {
    const { token } = await ready()
    const get = await request(app).get('/mcp').set('Authorization', `Bearer ${token}`).set('Accept', 'text/event-stream')
    expect(get.status).toBe(405)
    const del = await request(app).delete('/mcp').set('Authorization', `Bearer ${token}`)
    expect(del.status).toBe(405)
    // Both still refuse an anonymous caller first.
    expect((await request(app).get('/mcp')).status).toBe(401)
  })
})

// --- Tools --------------------------------------------------------------------

describe('search_library', () => {
  it('finds entries by name and by contents, with links and descriptions', async () => {
    await ready()
    const byName = (await run('search_library', { query: 'heirs' })) as any
    expect(byName.results.map((r: any) => r.slug)).toContain('tn-heirs')
    const hit = byName.results.find((r: any) => r.slug === 'tn-heirs')
    expect(hit).toMatchObject({
      kind: 'dataset',
      title: "Heirs' property share — TN",
      category: 'land',
      description: 'County-level heirs property estimates for Tennessee.',
      href: '/library/tn-heirs',
    })

    // "partition" appears only in the BODY of the wiki page, never in a title.
    const byContent = (await run('search_library', { query: 'partition sales' })) as any
    expect(byContent.results.map((r: any) => r.slug)).toContain('land-loss')
  })

  it('filters by kind and honours the limit', async () => {
    await ready()
    const pages = (await run('search_library', { query: 'land', kind: 'wiki' })) as any
    expect(pages.results.every((r: any) => r.kind === 'wiki')).toBe(true)
    const one = (await run('search_library', { query: 'land', limit: 1 })) as any
    expect(one.results).toHaveLength(1)
  })
})

/**
 * P6-1 / P6-2: the other two vocabularies, exposed the same way the topic is —
 * on every result, and as a way to narrow one.
 */
describe('search_library — organization and shape (P6-1, P6-2)', () => {
  it('says who published each result and what kind of thing it is', async () => {
    fake.seed(
      'library/sources/epa-npl/meta.json',
      JSON.stringify({
        title: 'EPA Superfund NPL sites',
        category: 'environment',
        status: 'published',
        description: 'Every site on or proposed for the NPL.',
        source: { provider: 'US EPA', placeQuery: { by: ['point', 'county'] } },
      }),
    )
    await ready()
    const result = (await run('search_library', { query: 'superfund' })) as any
    expect(result.results[0]).toMatchObject({
      slug: 'epa-npl',
      organization: 'epa',
      organizationLabel: 'US EPA',
      shape: 'points',
      shapeLabel: 'Sites and points',
    })
  })

  it('narrows to one publisher and to one shape', async () => {
    fake.seed(
      'library/sources/epa-npl/meta.json',
      JSON.stringify({
        title: 'EPA Superfund NPL sites — land',
        category: 'land',
        status: 'published',
        source: { provider: 'US EPA', placeQuery: { by: ['point'] } },
      }),
    )
    await ready()
    const mine = (await run('search_library', { query: 'land', organization: 'epa' })) as any
    expect(mine.results.map((r: any) => r.slug)).toEqual(['epa-npl'])

    const none = (await run('search_library', { query: 'land', organization: 'usgs' })) as any
    expect(none.results).toEqual([])

    // tn-heirs' table is keyed by a county FIPS, so it is statistics.
    const stats = (await run('search_library', { query: 'heirs', shape: 'statistics' })) as any
    expect(stats.results.map((r: any) => r.slug)).toEqual(['tn-heirs'])
    const points = (await run('search_library', { query: 'heirs', shape: 'points' })) as any
    expect(points.results).toEqual([])
  })

  it('refuses a shape that is not one', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'tools/call', { name: 'search_library', arguments: { query: 'x', shape: 'geospatial' } })
    expect(JSON.stringify(res.body)).toMatch(/geospatial|invalid|Invalid/)
  })
})

/**
 * P6-19: so the chat can answer "what do we have for Georgia?" in words. The
 * fixture's one held table is keyed by three Tennessee county FIPS codes.
 */
describe('search_library — coverage (P6-19)', () => {
  it('says how much ground each result covers, in words and in state codes', async () => {
    await ready()
    const result = (await run('search_library', { query: 'heirs' })) as any
    const row = result.results.find((r: any) => r.slug === 'tn-heirs')
    expect(row).toMatchObject({ coverage: 'state', coverageLabel: 'Tennessee', coverageStates: ['TN'] })
    // A document has no ground to cover, and says so as '' rather than as a
    // scope the caller might read as an answer.
    const notes = result.results.find((r: any) => r.slug === 'field-notes')
    expect(notes).toMatchObject({ coverage: '', coverageLabel: '', coverageStates: [] })
  })

  it('narrows to one state, however it is written, and to a scope', async () => {
    await ready()
    for (const state of ['TN', 'tn', 'Tennessee', '47']) {
      const hits = (await run('search_library', { query: 'heirs', state })) as any
      expect(hits.results.map((r: any) => r.slug)).toEqual(['tn-heirs'])
    }
    const elsewhere = (await run('search_library', { query: 'heirs', state: 'GA' })) as any
    expect(elsewhere.results).toEqual([])
    const scoped = (await run('search_library', { query: 'heirs', coverage: 'state' })) as any
    expect(scoped.results.map((r: any) => r.slug)).toEqual(['tn-heirs'])
    const nationwide = (await run('search_library', { query: 'heirs', coverage: 'national' })) as any
    expect(nationwide.results).toEqual([])
  })

  it('refuses a coverage that is not a scope — a STATE goes in `state`', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'tools/call', { name: 'search_library', arguments: { query: 'x', coverage: 'GA' } })
    expect(JSON.stringify(res.body)).toMatch(/GA|invalid|Invalid/)
  })
})

describe('get_entry / read_page / read_document', () => {
  it('returns a catalog record with its files', async () => {
    await ready()
    const entry = (await run('get_entry', { slug: 'field-notes' })) as any
    expect(entry.title).toBe('Field notes — heirs interviews')
    expect(entry.files.map((f: any) => f.file).sort()).toEqual(['meta.json', 'notes.pdf', 'summary.txt'])
    expect(entry.supersedes).toEqual([])
    // P5-82: what the entry is ready as travels with the record — two
    // readable files is a document; three would make it a collection.
    expect(entry.readiness).toEqual({ as: 'document', placeReport: 'never', notes: ['text extracted from 2 of 2 files'] })
    await expect(run('get_entry', { slug: 'nope' })).rejects.toThrow(/no library entry/i)
  })

  it('returns a wiki page as markdown', async () => {
    await ready()
    const page = (await run('read_page', { slug: 'land-loss' })) as any
    expect(page.title).toBe('Land loss')
    expect(page.markdown).toContain('Partition sales')
    await expect(run('read_page', { slug: 'tn-heirs' })).rejects.toThrow(/no wiki page/i)
  })

  it('reads a text file, and says plainly when a PDF yields no text', async () => {
    await ready()
    const text = (await run('read_document', { slug: 'field-notes', file: 'summary.txt' })) as any
    expect(text.textAvailable).toBe(true)
    expect(text.text).toContain('twelve landowners')
    expect(text.truncated).toBe(false)

    // '%PDF-fake' is not a real PDF: extraction fails and the tool says so
    // (with a download link) instead of inventing text.
    const pdf = (await run('read_document', { slug: 'field-notes', file: 'notes.pdf' })) as any
    expect(pdf.textAvailable).toBe(false)
    expect(pdf.text).toBeNull()
    expect(pdf.note).toMatch(/could not be extracted/i)

    await expect(run('read_document', { slug: 'field-notes', file: 'ghost.txt' })).rejects.toThrow(/no file named/i)
  })

  it('returns extracted text for a real PDF, page by page (P5-46 wiring)', async () => {
    const { makePdf } = await import('../testutils/fixtures/documents.js')
    fake.seed('library/documents/field-notes/real.pdf', makePdf(['Heirs property in Shelby County.', 'Second page about partition sales.']))
    await ready()
    const doc = (await run('read_document', { slug: 'field-notes', file: 'real.pdf' })) as any
    expect(doc.textAvailable).toBe(true)
    expect(doc.pages).toBe(2)
    expect(doc.text).toContain('— page 1 —')
    expect(doc.text).toContain('Heirs property')
    expect(doc.text).toContain('partition sales')
  })

  it('defaults to the entry content, not its meta.json manifest', async () => {
    await ready()
    const fallback = (await run('read_document', { slug: 'field-notes' })) as any
    expect(fallback.file).not.toBe('meta.json')
    expect(['notes.pdf', 'summary.txt']).toContain(fallback.file)
  })

  it('truncates a very long text file and says so', async () => {
    await ready()
    fake.seed('library/documents/field-notes/big.txt', 'x'.repeat(DOCUMENT_MAX_CHARS + 500))
    const auth = await login()
    await request(app).post('/api/library/reindex').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)
    const doc = (await run('read_document', { slug: 'field-notes', file: 'big.txt' })) as any
    expect(doc.truncated).toBe(true)
    expect(doc.text).toHaveLength(DOCUMENT_MAX_CHARS)
    expect(doc.note).toMatch(/Truncated/)
  })
})

// --- Documents an entry holds (P5-85) --------------------------------------------

describe('documents over MCP: held copies only (P5-85)', () => {
  const PAGE = 'https://county.example.gov/profiles'
  const JONES = 'https://county.example.gov/docs/jones-farm.pdf'
  const SMITH = 'https://county.example.gov/docs/smith-farm.pdf'
  const BROWN = 'https://county.example.gov/docs/brown-farm.pdf'
  const NOTE = 'Pulling documents in is done in the app; MCP reads only what the library already holds.'

  /** A link drop whose page offered three landowner profiles, holding
   *  whatever copies of them `files` says it holds. */
  function seedProfiles(files: Record<string, string>, pulledDocuments: unknown[] = []) {
    for (const [name, body] of Object.entries(files)) fake.seed(`library/incoming/county-profiles/${name}`, body)
    fake.seed(
      'library/incoming/county-profiles/meta.json',
      JSON.stringify({
        title: 'County landowner profiles',
        category: 'land',
        url: PAGE,
        inspection: {
          kind: 'page',
          documents: [
            { url: JONES, label: 'The Jones farm, 2024' },
            { url: SMITH, label: 'The Smith farm' },
            { url: BROWN, label: 'The Brown farm' },
          ],
        },
        ...(pulledDocuments.length ? { pulledDocuments } : {}),
      }),
    )
  }

  const byName = (held: any[]) => [...held].sort((a, b) => a.file.localeCompare(b.file))

  it('lists the files it holds and counts the documents the page still offers', async () => {
    seedProfiles({ 'the-jones-farm-2024.pdf': '%PDF-jones', 'map.png': 'PNG-data' })
    await ready()
    const entry = (await run('get_entry', { slug: 'county-profiles' })) as any
    expect(byName(entry.documents.held)).toEqual([
      { file: 'map.png', bytes: 8, readable: false },
      { file: 'the-jones-farm-2024.pdf', bytes: 10, readable: true },
    ])
    // The Jones profile is held under the name a pull stores it as, so only
    // the other two are on the page and nowhere in the library.
    expect(entry.documents.offered).toBe(2)
    expect(entry.documents.note).toBe(NOTE)
  })

  it('never lists the manifest as a document', async () => {
    await ready()
    const entry = (await run('get_entry', { slug: 'field-notes' })) as any
    expect(entry.files.map((f: any) => f.file)).toContain('meta.json')
    expect(entry.documents.held.map((h: any) => h.file).sort()).toEqual(['notes.pdf', 'summary.txt'])
  })

  it('offers nothing for an entry whose page was never read', async () => {
    await ready()
    const entry = (await run('get_entry', { slug: 'tn-heirs' })) as any
    expect(entry.documents).toEqual({ held: [{ file: 'data.csv', bytes: 66, readable: true }], offered: 0, note: NOTE })
  })

  /**
   * P6-34: a surface that carries a claim outward has to be able to say a
   * value is unverified. A number quoted in a data story should not silently
   * rest on a model's guess.
   */
  it('says how each value got there, and which of them nobody has checked', async () => {
    fake.seed('library/documents/why-five-million/memo.rtf', 'memo')
    fake.seed(
      'library/documents/why-five-million/meta.json',
      JSON.stringify({
        title: 'Why five million',
        category: 'land',
        status: 'published',
        provenance: {
          topic: { mechanism: 'model', at: 'T', value: 'land', evidence: 'Black landowners held fifteen million acres in 1910.' },
        },
      }),
    )
    await ready()
    const guessed = (await run('get_entry', { slug: 'why-five-million' })) as any
    expect(guessed.provenance.topic.mechanism).toBe('model')
    expect(guessed.provenance.topic.evidence).toContain('fifteen million acres')
    expect(guessed.unverified).toEqual(['topic'])

    // A hand-written category and a derived shape are not a model's reading,
    // so nothing on this one is waiting on a person.
    const curated = (await run('get_entry', { slug: 'tn-heirs' })) as any
    expect(curated.provenance.topic.mechanism).toBe('person')
    expect(curated.provenance.shape.mechanism).toBe('derived')
    expect(curated.unverified).toEqual([])
  })

  it('offers nothing once every document on the page is held', async () => {
    seedProfiles(
      { 'the-jones-farm-2024.pdf': '%PDF-jones', 'smith-2019.pdf': '%PDF-smith', 'the-brown-farm.pdf': '%PDF-brown' },
      // Stored under a different name than the label would give it: the
      // lineage record, not the filename, is what says this one is held.
      [{ file: 'smith-2019.pdf', from: SMITH, bytes: 10, at: '2026-09-01T10:00:00.000Z' }],
    )
    await ready()
    const entry = (await run('get_entry', { slug: 'county-profiles' })) as any
    expect(byName(entry.documents.held).map(h => h.file)).toEqual([
      'smith-2019.pdf',
      'the-brown-farm.pdf',
      'the-jones-farm-2024.pdf',
    ])
    expect(entry.documents.offered).toBe(0)
  })
})

describe('query_dataset', () => {
  it('counts matching rows and groups by a column, with a link to the same query', async () => {
    await ready()
    const all = (await run('query_dataset', { slug: 'tn-heirs' })) as any
    expect(all.rowCount).toBe(3)
    expect(all.href).toBe('/library/tn-heirs?tab=data')

    const filtered = (await run('query_dataset', { slug: 'tn-heirs', filters: [{ column: 'tier', op: 'eq', value: 'A' }] })) as any
    expect(filtered.rowCount).toBe(2)

    const grouped = (await run('query_dataset', { slug: 'tn-heirs', groupBy: 'tier' })) as any
    expect(grouped.groups).toEqual([
      { value: 'A', count: 2 },
      { value: 'B', count: 1 },
    ])
  })

  it('refuses an unknown slug or column with the message the P5-41 validator writes', async () => {
    await ready()
    await expect(run('query_dataset', { slug: 'nope' })).rejects.toThrow(/Cannot query "nope"/)
    await expect(run('query_dataset', { slug: 'tn-heirs', groupBy: 'ghost' })).rejects.toThrow(/unknown column: ghost/)
  })
})

describe('layers', () => {
  it('lists every public layer and reads one by id', async () => {
    const list = (await run('list_layers')) as any
    expect(list.count).toBe(PUBLIC_LAYERS.length)
    expect(list.layers.map((l: any) => l.id)).toContain('pct_Black')

    const one = (await run('get_layer', { id: 'pct_Black' })) as any
    expect(one.name).toBe('Percent Black')
    expect(one.mapHref).toBe('/?layers=pct_Black')
    await expect(run('get_layer', { id: 'internal-anything' })).rejects.toThrow(/No public map layer/)
  })

  it('holds no internal layer — internal material is never in the committed registry', async () => {
    for (const layer of PUBLIC_LAYERS) {
      expect(layer.category).not.toBe('internal')
      expect(layer.id.startsWith('internal-')).toBe(false)
    }
  })
})

describe('county_values', () => {
  it('normalises the GEOID spellings the public files use', () => {
    expect(normalizeGeoid('1001')).toBe('01001')
    expect(normalizeGeoid('47157')).toBe('47157')
    expect(normalizeGeoid('0500000US01001')).toBe('01001')
    expect(normalizeGeoid('Shelby')).toBeNull()
  })

  it('reads a CSV keyed by GEOID and refuses one missing the columns it needs', () => {
    const csv = 'GEOID,county_name,median_home_value\n1001,Autauga,150000\n47157,Shelby,210000\n47037,Davidson,\n'
    expect(parseLayerCsv(csv, 'median_home_value')).toEqual({ '01001': 150000, '47157': 210000 })
    expect(() => parseLayerCsv('a,b\n1,2\n', 'median_home_value')).toThrow(/no GEOID column/)
    expect(() => parseLayerCsv(csv, 'ghost')).toThrow(/no "ghost" column/)
  })

  it('reads a JSON file keyed by GEOID, whether records are objects or bare numbers', () => {
    expect(parseLayerJson('{"01001":{"total":12},"47157":{"total":3}}', 'total')).toEqual({ '01001': 12, '47157': 3 })
    expect(parseLayerJson('{"01001":7}', 'total')).toEqual({ '01001': 7 })
    expect(() => parseLayerJson('not json', 'total')).toThrow(/could not be read/)
  })

  it('returns a layer value per county from the real dataset file on disk', async () => {
    const result = (await countyValues({ layerId: 'median_home_value', geoids: ['47157', '1001', 'not-a-geoid'] })) as any
    expect(result.layer).toBe('Median Home Value')
    expect(result.counties[0].geoid).toBe('47157')
    expect(typeof result.counties[0].value).toBe('number')
    // A short GEOID is padded, not dropped.
    expect(result.counties[1].geoid).toBe('01001')
    // Junk is reported as junk rather than silently matching nothing.
    expect(result.counties[2]).toMatchObject({ value: null, note: expect.stringContaining('GEOID') })
    expect(result.found).toBe(2)
  })

  it('has a resolvable value column in every layer file — a registry edit cannot ship broken', async () => {
    // Reads only the header (or the first record) of each file: this is a
    // drift guard on `npm run export:layers`, not a parse test.
    const { readFileSync } = await import('node:fs')
    for (const layer of PUBLIC_LAYERS) {
      const path = `${process.cwd()}/../public${layer.dataPath}`
      const raw = readFileSync(path, 'utf8')
      if (layer.dataPath.endsWith('.json')) {
        const first = Object.values(JSON.parse(raw))[0]
        const ok = typeof first === 'number' || (!!first && typeof first === 'object' && layer.valueColumn in (first as object))
        expect(ok, `${layer.id} → ${layer.valueColumn}`).toBe(true)
      } else {
        const header = raw.slice(0, raw.indexOf('\n')).replace(/\r$/, '').split(',')
        expect(header, `${layer.id} → ${layer.valueColumn}`).toContain(layer.valueColumn)
      }
    }
  })

  it('caps the number of counties and refuses an unknown layer', async () => {
    await expect(countyValues({ layerId: 'median_home_value', geoids: [] })).rejects.toThrow(/at least one/)
    await expect(
      countyValues({ layerId: 'median_home_value', geoids: new Array(COUNTY_VALUES_MAX + 1).fill('47157') }),
    ).rejects.toThrow(new RegExp(`${COUNTY_VALUES_MAX} counties`))
    await expect(countyValues({ layerId: 'made_up', geoids: ['47157'] })).rejects.toThrow(/No public map layer/)
  })

  it('says so plainly when the files are absent and no site URL is configured, and fetches them when one is', async () => {
    // A layer whose file cannot exist on disk exercises the fallback path
    // without touching the real registry entries.
    const phantom = { ...PUBLIC_LAYERS[0], id: 'phantom_layer', dataPath: '/datasets/nowhere/phantom.csv', valueColumn: 'v' }
    PUBLIC_LAYERS.push(phantom)
    try {
      await expect(countyValues({ layerId: 'phantom_layer', geoids: ['47157'] })).rejects.toThrow(/PUBLIC_SITE_URL/)

      process.env.PUBLIC_SITE_URL = 'https://blo.example/'
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('GEOID,v\n47157,42\n', { status: 200 }) as never)
      const result = (await countyValues({ layerId: 'phantom_layer', geoids: ['47157'] })) as any
      expect(fetchSpy).toHaveBeenCalledWith('https://blo.example/datasets/nowhere/phantom.csv')
      expect(result.counties[0].value).toBe(42)
      fetchSpy.mockRestore()
    } finally {
      PUBLIC_LAYERS.pop()
    }
  })
})

/**
 * P5-63 — the library's own vocabulary, exposed. "What do we have on water?"
 * used to be a text search; it is now a question with an answer before any
 * searching happens.
 */
describe('list_topics (P5-63)', () => {
  it('lists every subject with its plain-word label and a count of what is filed under it', async () => {
    await ready()
    const result = (await run('list_topics')) as any
    const byId = Object.fromEntries(result.topics.map((t: any) => [t.id, t]))
    expect(byId.land).toMatchObject({ label: 'Land', entries: 1 })
    expect(byId.transportation).toMatchObject({ label: 'Getting to work', entries: 0 })
    expect(byId.land.description).toContain('Parcels')
    // The purposes ride along, because they answer the other question.
    expect(result.purposes.map((p: any) => p.id)).toEqual(['strategy', 'research', 'outreach', 'ideas'])
    // The research document has no subject on it at all, which is a real gap.
    expect(result.uncategorised).toBe(1)
  })

  it('narrows search_library to one subject, and says the topic on every result', async () => {
    await ready()
    const hit = (await run('search_library', { query: 'heirs', topic: 'land' })) as any
    expect(hit.results.map((r: any) => r.slug)).toEqual(['tn-heirs'])
    expect(hit.results[0]).toMatchObject({ topic: 'land', purpose: null })

    // The same words under a subject the entry is not filed under: nothing,
    // including from the content matches.
    const miss = (await run('search_library', { query: 'heirs', topic: 'water' })) as any
    expect(miss.results).toEqual([])
  })

  it('refuses a topic that is not one', async () => {
    const { token } = await ready()
    const res = await rpc(token, 'tools/call', { name: 'search_library', arguments: { query: 'x', topic: 'kitchen-sink' } })
    expect(JSON.stringify(res.body)).toMatch(/kitchen-sink|invalid|Invalid/)
  })
})

describe('saved views', () => {
  it('lists views and reads one, each with a link that restores the map', async () => {
    await ready()
    const list = (await run('list_views')) as any
    expect(list.views).toHaveLength(1)
    expect(list.views[0]).toMatchObject({ slug: 'tn-shortlist', name: 'Tennessee shortlist', href: '/?view=tn-shortlist' })

    const view = (await run('get_view', { slug: 'tn-shortlist' })) as any
    expect(view.state.regionStates).toEqual(['TN'])
    expect(view.results).toHaveLength(1)
    await expect(run('get_view', { slug: 'nope' })).rejects.toThrow(/No saved view/)
  })

  it('makes links absolute once the site URL is configured', async () => {
    await ready()
    process.env.PUBLIC_SITE_URL = 'https://blo.example'
    const list = (await run('list_views')) as any
    expect(list.views[0].href).toBe('https://blo.example/?view=tn-shortlist')
    const entry = (await run('get_entry', { slug: 'tn-heirs' })) as any
    expect(entry.href).toBe('https://blo.example/library/tn-heirs')
  })
})

describe('ask', () => {
  it('hands back the cited answer and its sources', async () => {
    await ready()
    askKbStub.mockResolvedValue({
      answer: 'Partition sales are the mechanism most often named [1].',
      sources: [{ n: 1, slug: 'land-loss', kind: 'wiki', title: 'Land loss', href: '/wiki/land-loss', snippet: '…', cited: true }],
      queries: [],
      counts: { pages: 1, datasets: 0, documents: 0, notes: 0 },
      toolCalls: 0,
      usedTokens: 10,
      inputTokens: 8,
      outputTokens: 2,
    })
    const result = (await run('ask', { question: 'How does land loss happen?' })) as any
    expect(result.answer).toContain('Partition sales')
    expect(result.sources[0].href).toBe('/wiki/land-loss')
    expect(result.read.pages).toBe(1)
  })

  it('turns a model-service failure into a plain sentence, never a stack', async () => {
    await ready()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    askKbStub.mockRejectedValue(new Error('anthropic exploded: at Object.<anonymous> (/srv/app.js:1:1)'))
    const { token } = await ready()
    const call = await callTool(token, 'ask', { question: 'anything at all' })
    expect(call.isError).toBe(true)
    expect(call.text).toBe('The answering service is unavailable right now.')
    expect(call.text).not.toContain('/srv/app.js')
    err.mockRestore()
  })
})

// --- Audit --------------------------------------------------------------------

describe('the audit trail', () => {
  it('records mcp.<tool> per call with the calling program and the argument keys', async () => {
    const { token } = await ready()
    await callTool(token, 'read_page', { slug: 'land-loss' }, 'ClaudeDesktop/1.2')
    await callTool(token, 'list_layers', {}, 'ClaudeDesktop/1.2')
    const rows = await auditRows()
    expect(rows.map(r => r.action)).toEqual(['mcp.read_page', 'mcp.list_layers'])
    expect(rows[0].actor).toBe('maria')
    expect(rows[0].target).toBe('land-loss')
    expect(rows[0].detail.client).toBe('ClaudeDesktop/1.2')
    expect(rows[0].detail.args).toEqual({ slug: 'land-loss' })
  })

  it('records a failed call too, marked as failed', async () => {
    const { token } = await ready()
    const call = await callTool(token, 'read_page', { slug: 'nope' })
    expect(call.isError).toBe(true)
    expect(call.text).toMatch(/No wiki page/)
    const rows = await auditRows()
    expect(rows[0]).toMatchObject({ action: 'mcp.read_page' })
    expect(rows[0].detail.failed).toBe(true)
  })

  it('clips a long argument value rather than archiving it', () => {
    const long = 'x'.repeat(500)
    const clipped = auditArgs({ question: long, limit: 5, filters: [{ column: 'tier' }] }) as Record<string, string>
    expect(clipped.question).toHaveLength(201) // 200 chars + the ellipsis
    expect(clipped.question.endsWith('…')).toBe(true)
    expect(clipped.limit).toBe('5')
    expect(clipped.filters).toBe('[{"column":"tier"}]')
    expect(auditArgs(undefined)).toEqual({})
  })
})

// --- Write tools (P5-52) ---------------------------------------------------------

describe('the write tools', () => {
  /** Issue an OAuth access token for `username` the way the token endpoint
   *  does, so a connector's call can be exercised without walking the whole
   *  authorization flow (which oauth.test.ts already covers end to end). */
  async function oauthToken(clientName: string, scopes: ('read' | 'write')[], username = 'maria') {
    process.env.OAUTH_ISSUER = 'https://api.example.com'
    const { rows } = await libraryQuery(`SELECT id FROM library_users WHERE username = $1`, [username])
    const client = await registerClient({
      clientName,
      redirectUris: ['https://chat.example.com/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes,
    })
    const pair = await issueTokenPair({
      userId: Number((rows[0] as { id: unknown }).id),
      clientId: client.clientId,
      scopes,
      resource: mcpResource('https://api.example.com'),
    })
    return pair.accessToken
  }

  afterEach(() => {
    delete process.env.OAUTH_ISSUER
  })

  it('writes a note over the wire and attributes it to the token that did it', async () => {
    const { token, name } = await ready('maria', { write: true, name: 'Claude Desktop — laptop' })
    const call = await callTool(token, 'create_note', {
      title: 'Assessor follow-up',
      body: 'Ask Shelby County about the 2019 partition sales.',
      category: 'research',
    })
    expect(call.isError, call.text).toBe(false)
    expect(call.data).toMatchObject({ slug: 'assessor-follow-up', status: 'needs-review' })

    // TWO rows: what happened to the library, and which credential asked.
    const entity = await auditRows('library.note')
    expect(entity[0]).toMatchObject({ actor: 'maria', target: 'assessor-follow-up' })
    expect(entity[0].detail.via).toBe(name)
    const call_ = await auditRows('mcp.create_note')
    expect(call_[0].detail.client).toBe('ClaudeDesktop/1.2')
    expect(call_[0].detail.via).toBe(name)
    expect(call_[0].detail.args.title).toBe('Assessor follow-up')
  })

  it('refuses every write tool on a read-only personal token, and audits the refusal', async () => {
    const { token } = await ready('maria')
    for (const name of WRITE_TOOL_NAMES) {
      const call = await callTool(token, name, {
        title: 'x',
        body: 'y',
        name: 'x',
        type: 'map',
        state: {},
        slug: 'land-loss',
        markdown: 'x',
        url: 'https://example.org/x',
        workingSet: 'memphis-redevelopment',
        to: 'internal-transmission',
        // P7-8's build_index: valid args, so the refusal under test is the
        // scope check and not the schema.
        layers: [
          { layer: 'internal-a', weight: 1, direction: 'higher_better' },
          { layer: 'internal-b', weight: 1, direction: 'lower_better' },
        ],
      })
      expect(call.isError, name).toBe(true)
      expect(call.text, name).toMatch(/insufficient_scope/)
    }
    // Nothing was written.
    expect((await run('read_page', { slug: 'land-loss' })) as any).toMatchObject({ title: 'Land loss' })
    const refused = await auditRows('mcp.create_note')
    expect(refused[0].detail.refused).toBe('insufficient_scope')
    expect(refused[0].detail.failed).toBe(true)
  })

  it('refuses a read-only OAuth token and allows a write-scoped one, attributed to the app', async () => {
    await ready()
    const readOnly = await oauthToken('ChatGPT (read only)', ['read'])
    const denied = await callTool(readOnly, 'create_note', { title: 'Nope', body: 'Body.' }, 'ChatGPT/1.0')
    expect(denied.isError).toBe(true)
    expect(denied.text).toMatch(/insufficient_scope/)

    const writer = await oauthToken('ChatGPT', ['read', 'write'])
    const allowed = await callTool(writer, 'create_note', { title: 'From the connector', body: 'Body.' }, 'ChatGPT/1.0')
    expect(allowed.isError, allowed.text).toBe(false)

    // An OAuth write is attributed to the REGISTERED APP, not the User-Agent.
    const rows = await auditRows('library.note')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'maria', target: 'from-the-connector' })
    expect(rows[0].detail.via).toBe('ChatGPT')
  })

  it('puts "via <app>" on the activity feed, and leaves browser work reading as before', async () => {
    const { token, name } = await ready('maria', { write: true, name: 'ChatGPT' })
    await callTool(token, 'create_note', { title: 'Feed check', body: 'Body.' })
    // The same account, working in the browser.
    const auth = await login('maria')
    const posted = await request(app)
      .post('/api/library/entries')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
      .send({ title: 'Typed by hand', body: 'Body.' })
    expect(posted.status).toBe(201)

    await new Promise(resolve => setTimeout(resolve, 40))
    const verbs = Object.fromEntries((await recentActivity(20)).map(r => [r.target?.slug, r.verb]))
    expect(verbs['feed-check']).toBe(`wrote the note via ${name}`)
    expect(verbs['typed-by-hand']).toBe('wrote the note')
  })

  it('appends to a page, drops a link and saves a view, all over the wire', async () => {
    const { token } = await ready('maria', { write: true })

    const appended = await callTool(token, 'append_to_page', {
      slug: 'land-loss',
      markdown: 'Tax sales are the second mechanism.',
      heading: 'Tax sales',
    })
    expect(appended.isError, appended.text).toBe(false)
    const page = (await run('read_page', { slug: 'land-loss' })) as any
    expect(page.markdown).toContain('## Tax sales')
    expect(page.markdown).toContain('Partition sales are the mechanism most often named.')

    const dropped = await callTool(token, 'drop_link', { url: 'https://example.org/heirs.pdf', note: 'Worth reading.' })
    expect(dropped.isError, dropped.text).toBe(false)
    expect(dropped.data).toMatchObject({ kind: 'incoming', fetch: 'queued' })

    const saved = await callTool(token, 'save_view', {
      name: 'Wire view',
      type: 'map',
      state: { layers: [{ layerId: PUBLIC_LAYERS[0].id, weight: 1 }] },
    })
    expect(saved.isError, saved.text).toBe(false)
    expect(saved.data).toMatchObject({ slug: 'wire-view', href: '/?view=wire-view' })
    const views = (await run('list_views')) as any
    expect(views.views.map((v: any) => v.slug)).toContain('wire-view')

    const actions = (await auditRows('mcp.%')).map(r => r.action)
    expect(actions).toEqual(['mcp.append_to_page', 'mcp.drop_link', 'mcp.save_view'])
  })

  it('saves a table view through the views route validator, refusals and all', async () => {
    const { token } = await ready('maria', { write: true })
    const bad = await callTool(token, 'save_view', {
      name: 'Bad table',
      type: 'table',
      state: { dataset: 'tn-heirs', sort: 'Nope' },
    })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/unknown column/i)

    const good = await callTool(token, 'save_view', {
      name: 'Tier A counties',
      type: 'table',
      state: { dataset: 'tn-heirs', filters: [{ column: 'tier', op: 'eq', value: 'A' }] },
    })
    expect(good.isError, good.text).toBe(false)
    expect(good.data).toMatchObject({ slug: 'tier-a-counties', type: 'table', href: '/views/tier-a-counties' })
    const view = (await run('get_view', { slug: 'tier-a-counties' })) as any
    expect(view.state.datasetTitle).toBe("Heirs' property share — TN")
    expect(view.state.filters).toEqual([{ column: 'tier', op: 'eq', value: 'A' }])
  })

  it('refuses the home page from an assistant unless it says so out loud', async () => {
    fake.seed('library/wiki/home.md', '# Home\n\nStart here.\n')
    const { token } = await ready('maria', { write: true })

    const refused = await callTool(token, 'append_to_page', { slug: 'home', markdown: 'Injected.' })
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/front page/i)
    expect(((await run('read_page', { slug: 'home' })) as any).markdown).not.toContain('Injected.')

    const allowed = await callTool(token, 'append_to_page', {
      slug: 'home',
      markdown: 'Deliberate.',
      allowHome: true,
    })
    expect(allowed.isError, allowed.text).toBe(false)
    expect(((await run('read_page', { slug: 'home' })) as any).markdown).toContain('Deliberate.')
  })

  it('refuses a stale baseline on update_page rather than overwriting somebody', async () => {
    const { token } = await ready('maria', { write: true })
    const stale = new Date(Date.now() - 60_000).toISOString()
    const conflict = await callTool(token, 'update_page', {
      slug: 'land-loss',
      markdown: '# Land loss\n\nMine.\n',
      expectedUpdatedAt: stale,
    })
    expect(conflict.isError).toBe(true)
    expect(conflict.text).toMatch(/changed after you read it/i)
    expect(((await run('read_page', { slug: 'land-loss' })) as any).markdown).toContain('Partition sales')

    // With the page's real baseline, the same write lands.
    const current = (await run('read_page', { slug: 'land-loss' })) as any
    const entry = await libraryQuery(`SELECT updated_at FROM library_catalog WHERE slug = 'land-loss'`)
    const updatedAt = new Date(entry.rows[0].updated_at as string | Date).toISOString()
    const ok = await callTool(token, 'update_page', {
      slug: 'land-loss',
      markdown: `${current.markdown}\n\nRewritten.\n`,
      expectedUpdatedAt: updatedAt,
    })
    expect(ok.isError, ok.text).toBe(false)
    expect(((await run('read_page', { slug: 'land-loss' })) as any).markdown).toContain('Rewritten.')
  })
})

/**
 * P5-59: an assistant can ask what a link is without anything being filed.
 * The network is a fixture; the point is the contract, not the classifier
 * (which has its own suite).
 */
describe('inspect_link', () => {
  afterEach(() => resetInspectDefaults())

  it('classifies a link and proposes a source and a plan, creating nothing', async () => {
    setInspectDefaults({
      fetchImpl: (async (input: any) =>
        String(input).includes('returnCountOnly')
          ? inspectFixtures.jsonProbe({ count: 1337 })
          : inspectFixtures.jsonProbe(inspectFixtures.ARCGIS_LAYER)) as unknown as typeof fetch,
      lookup: inspectFixtures.publicLookup,
    })
    const before = await libraryQuery(`SELECT count(*)::int AS n FROM library_catalog`)
    const result = (await run('inspect_link', {
      url: 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0',
    })) as any

    expect(result.kind).toBe('arcgis-layer')
    expect(result.summary).toContain('ArcGIS point layer')
    expect(result.fields).toContain('STCOFIPS')
    expect(result.rowCount).toBe(1337)
    expect(result.suggestedSource.access[0]).toMatchObject({ type: 'arcgis' })
    expect(result.suggestedPlan).toMatchObject({ plan: 'fetch-on-demand' })
    expect(result.suggestedPlan.whatHappensNext).toMatch(/asks the agency/i)
    // P5-82: an endpoint nobody has registered yet is a place-report candidate.
    expect(result.readiness).toEqual({ as: 'link', placeReport: 'candidate', notes: ['not read yet'] })

    const after = await libraryQuery(`SELECT count(*)::int AS n FROM library_catalog`)
    expect((after.rows[0] as any).n).toBe((before.rows[0] as any).n)
  })

  it('says plainly when it could not reach the link', async () => {
    setInspectDefaults({
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND')
      }) as unknown as typeof fetch,
      lookup: inspectFixtures.publicLookup,
    })
    const result = (await run('inspect_link', { url: 'https://gone.example/data.csv' })) as any
    expect(result.kind).toBe('unreachable')
    expect(result.summary).toMatch(/could not reach/i)
    expect(result.suggestedSource).toBeUndefined()
    expect(result.readiness).toEqual({ as: 'link', placeReport: 'never', notes: ['could not be reached'] })
  })

  it('refuses a private address before any request', async () => {
    const fetchImpl = vi.fn()
    setInspectDefaults({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup: inspectFixtures.privateLookup })
    const result = (await run('inspect_link', { url: 'https://intranet.example/x.csv' })) as any
    expect(result.kind).toBe('unreachable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

/**
 * P7-7: the one CAPABILITY field, through the two tools §F.4d names.
 *
 * Everything else `search_library` returns is descriptive — who published it,
 * what subject bucket it sits in, what shape its rows are, how much ground it
 * covers — and none of it says whether a dataset bears on what was asked.
 * That is why `applicableSources` filtered forty sources by place and none of
 * them by question.
 */
describe('search_library / get_entry — what a dataset answers (P7-7)', () => {
  const ANSWER = 'Answers: which Tennessee counties have the highest share of heirs’ property.'
  const EVIDENCE = 'The table reports the share of parcels held as heirs’ property in each county.'

  function seedAnswer(extra: Record<string, unknown> = {}): void {
    fake.seed(
      'library/datasets/tn-heirs/meta.json',
      JSON.stringify({
        title: "Heirs' property share — TN",
        category: 'land',
        status: 'published',
        tags: ['tennessee'],
        description: 'County-level heirs property estimates for Tennessee.',
        source: 'county assessor scrape',
        whatItAnswers: ANSWER,
        ...extra,
      }),
    )
  }

  it('rides every search row, so a model chooses without a second request', async () => {
    seedAnswer()
    await ready()
    const found = (await run('search_library', { query: 'heirs' })) as any
    const hit = found.results.find((r: any) => r.slug === 'tn-heirs')
    expect(hit.whatItAnswers).toBe(ANSWER)
    // '' rather than absent, so a caller can tell "nobody has written one"
    // from "it answers nothing" without special-casing a missing key — and a
    // kind the field is never asked of reads the same way rather than oddly.
    const document = found.results.find((r: any) => r.kind === 'document')
    expect(document.whatItAnswers).toBe('')
  })

  it('is findable by the question it answers, not only by its title', async () => {
    // Indexed as its own line in the entry chunk: nothing in this dataset's
    // title, category, tags or description says "transmission".
    seedAnswer({ whatItAnswers: 'Answers: which parcels sit within five miles of a transmission line.' })
    await ready()
    const found = (await run('search_library', { query: 'transmission line' })) as any
    expect(found.results.map((r: any) => r.slug)).toContain('tn-heirs')
  })

  it('comes back from get_entry, with how it got there and whether anybody checked', async () => {
    seedAnswer({
      provenance: { whatItAnswers: { mechanism: 'model', at: 'T', value: ANSWER, evidence: EVIDENCE, via: 'field' } },
    })
    await ready()
    const entry = (await run('get_entry', { slug: 'tn-heirs' })) as any
    expect(entry.whatItAnswers).toBe(ANSWER)
    expect(entry.provenance.whatItAnswers.mechanism).toBe('model')
    expect(entry.provenance.whatItAnswers.evidence).toBe(EVIDENCE)
    // The caller is told to say so when it quotes this.
    expect(entry.unverified).toEqual(['whatItAnswers'])
  })

  it('reads a hand-written line as a person’s, with nobody waiting', async () => {
    seedAnswer()
    await ready()
    const entry = (await run('get_entry', { slug: 'tn-heirs' })) as any
    expect(entry.provenance.whatItAnswers.mechanism).toBe('person')
    expect(entry.unverified).toEqual([])
  })

  it('tells the caller what the field is for, and what empty means', async () => {
    const search = MCP_TOOLS.find(t => t.name === 'search_library')!
    expect(search.description).toContain('whatItAnswers')
    expect(search.description).toContain('Choose between results on whatItAnswers')
    expect(search.description).toContain('means nobody has written one')
    expect(MCP_TOOLS.find(t => t.name === 'get_entry')!.description).toContain('whatItAnswers')
  })
})
