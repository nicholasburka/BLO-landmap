import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-57 over MCP. The tools are registered on a real McpServer and driven by a
 * real client over an in-memory transport, so the schema a desktop assistant
 * sees and the answer it gets are the ones under test — not a stub of them.
 *
 * The lead wires `registerPlaceTools` into the tool table once P5-52 lands;
 * this suite proves the registration function on its own.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { registerPlaceTools, MCP_PLACE_ROWS, MCP_REPORT_ROWS } = await import('./mcpPlaceTools.js')
const { setPlaceReportDefaults, resetPlaceReportDefaults, clearCountyIndex } = await import('./placeReport.js')
const { setPlaceFetchDefaults, resetPlaceFetchDefaults } = await import('./placeFetch.js')
const { resetRateLimits } = await import('./placeHttp.js')
const { ARCGIS_GEOJSON, ATLANTA, jsonResponse, publicLookup } = await import('../testutils/fixtures/place/index.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const CTX = { user: { id: 7, username: 'nick' }, client: 'ClaudeDesktop/1.2' }

const NPL_SOURCE = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  source: {
    provider: 'US EPA',
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0' }],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
    updateCadence: 'weekly',
  },
}

let fake: FakeS3
let dataDir: string
let client: Client

async function connected(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } })
  registerPlaceTools(server as any, CTX)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const c = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([c.connect(clientTransport), server.connect(serverTransport)])
  return c
}

async function call(name: string, args: Record<string, unknown>) {
  const res: any = await client.callTool({ name, arguments: args })
  const text = res.content[0].text as string
  return { isError: res.isError === true, text, data: res.isError ? null : JSON.parse(text) }
}

/** Audit writes are fire-and-forget; let them land before asserting. */
async function auditRows() {
  await new Promise(resolve => setTimeout(resolve, 40))
  const { rows } = await libraryQuery(
    `SELECT actor, action, target, detail FROM library_audit WHERE action LIKE 'mcp.%' ORDER BY id`,
  )
  return rows as { actor: string; action: string; target: string | null; detail: any }[]
}

beforeEach(async () => {
  resetRateLimits()
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-mcp-place-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(NPL_SOURCE))
  fake.seed(
    'library/sources/georgia-epd-ust/meta.json',
    JSON.stringify({ title: 'Georgia EPD USTs', source: { provider: 'Georgia EPD', access: [{ type: 'manual' }] } }),
  )
  await reindexCatalog()
  setPlaceFetchDefaults({ fetchImpl: (async () => jsonResponse(ARCGIS_GEOJSON)) as any, lookup: publicLookup as any })
  // The report's model and county-file reads are not what this suite is
  // about; P5-58's own suites cover both.
  clearCountyIndex()
  setPlaceReportDefaults({
    ask: (async () => ({
      answer: 'Three Superfund sites sit in the county [1].',
      sources: [{ n: 1, slug: 'epa-superfund-npl', kind: 'place', title: 'EPA Superfund NPL sites', href: '/library/epa-superfund-npl?place=g13121', snippet: '', cited: true }],
      queries: [],
      places: [],
      counts: { pages: 0, datasets: 0, documents: 0, notes: 0 },
      toolCalls: 0,
      usedTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    })) as any,
    countyValues: (async ({ layerId, geoids }: any) => ({
      layerId,
      counties: [{ geoid: geoids[0], value: layerId === 'pct_Black' ? 44.5 : null }],
    })) as any,
  })
  client = await connected()
})

afterEach(async () => {
  resetPlaceFetchDefaults()
  resetPlaceReportDefaults()
  await client.close().catch(() => {})
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.PUBLIC_SITE_URL
})

describe('registration', () => {
  it('offers both tools with a schema and honest annotations', async () => {
    const listed = await client.listTools()
    const names = listed.tools.map(t => t.name).sort()
    expect(names).toEqual(['fetch_for_place', 'list_place_slices', 'place_report'])

    const fetchTool = listed.tools.find(t => t.name === 'fetch_for_place')!
    expect(fetchTool.inputSchema.type).toBe('object')
    expect(Object.keys(fetchTool.inputSchema.properties ?? {}).sort()).toEqual([
      'address',
      'geoid',
      'point',
      'radiusMiles',
      'source',
    ])
    // The one MCP tool that reaches outside this library says so.
    expect(fetchTool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true })
    expect(listed.tools.find(t => t.name === 'list_place_slices')!.annotations).toMatchObject({ readOnlyHint: true })

    const reportTool = listed.tools.find(t => t.name === 'place_report')!
    // P7-1 adds `workingSet`: the assistant can run the report INSIDE a
    // working set and ask that set's sources only, which is the scoped
    // question chat has to be able to put.
    expect(Object.keys(reportTool.inputSchema.properties ?? {}).sort()).toEqual([
      'address',
      'geoid',
      'point',
      'radiusMiles',
      'workingSet',
    ])
    // It runs every source at once, so it reaches outside too.
    expect(reportTool.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true })
  })
})

describe('fetch_for_place', () => {
  it('fetches a county and hands back the rows and a link', async () => {
    process.env.PUBLIC_SITE_URL = 'https://map.example.org/'
    const { data } = await call('fetch_for_place', { source: 'epa-superfund-npl', geoid: '13121' })
    expect(data).toMatchObject({
      source: 'epa-superfund-npl',
      place: 'Fulton County, GA',
      count: 3,
      adapter: 'arcgis',
      cacheKey: 'g13121',
      cached: false,
      url: 'https://map.example.org/library/epa-superfund-npl?place=g13121',
    })
    expect(data.rows).toHaveLength(3)
    expect(data.rows.length).toBeLessThanOrEqual(MCP_PLACE_ROWS)
  })

  it('takes a point and a radius', async () => {
    const { data } = await call('fetch_for_place', { source: 'epa-superfund-npl', point: ATLANTA, radiusMiles: 2 })
    expect(data.cacheKey).toBe('p33.7490_-84.3880_r2')
    expect(data.radiusMiles).toBe(2)
  })

  it('refuses a request with no place, in words', async () => {
    const res = await call('fetch_for_place', { source: 'epa-superfund-npl' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('address, a point, or a 5-digit county geoid')
  })

  it('explains a spreadsheets-only source', async () => {
    const res = await call('fetch_for_place', { source: 'georgia-epd-ust', geoid: '13121' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('by hand')
  })

  it('rejects a geoid that is not five digits before anything is fetched', async () => {
    // The schema does this, not the adapter: a value that is not five digits
    // must never reach a URL we build.
    const res = await call('fetch_for_place', { source: 'epa-superfund-npl', geoid: '13' })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('geoid')
  })

  it('audits the call as mcp.fetch_for_place, naming the source and the assistant', async () => {
    await call('fetch_for_place', { source: 'epa-superfund-npl', geoid: '13121' })
    await call('fetch_for_place', { source: 'georgia-epd-ust', geoid: '13121' })
    const rows = await auditRows()
    expect(rows.map(r => r.action)).toEqual(['mcp.fetch_for_place', 'mcp.fetch_for_place'])
    expect(rows[0]).toMatchObject({ actor: 'nick', target: 'epa-superfund-npl' })
    expect(rows[0].detail).toMatchObject({ client: 'ClaudeDesktop/1.2', args: { source: 'epa-superfund-npl', geoid: '13121' } })
    expect(rows[0].detail.failed).toBeUndefined()
    expect(rows[1].detail.failed).toBe(true)
  })
})

describe('list_place_slices', () => {
  it('lists what has already been fetched, with links', async () => {
    await call('fetch_for_place', { source: 'epa-superfund-npl', geoid: '13121' })
    const { data } = await call('list_place_slices', { source: 'epa-superfund-npl' })
    expect(data.slices).toHaveLength(1)
    expect(data.slices[0]).toMatchObject({ cacheKey: 'g13121', place: 'Fulton County, GA', count: 3 })
    expect(data.slices[0].url).toBe('/library/epa-superfund-npl?place=g13121')
  })

  it('is empty for a source nobody has asked about', async () => {
    const { data } = await call('list_place_slices', { source: 'georgia-epd-ust' })
    expect(data.slices).toEqual([])
  })
})

describe('place_report (P5-58)', () => {
  it('runs every applicable source for one place and returns the whole report', async () => {
    process.env.PUBLIC_SITE_URL = 'https://map.example.org'
    const { data } = await call('place_report', { geoid: '13121' })
    expect(data.placeKey).toBe('g13121')
    expect(data.place).toMatchObject({ geoid: '13121', county: 'Fulton County', state: 'Georgia' })
    // The manual EPD source declares no placeQuery, so a bare county is not
    // something it can answer — it is left out rather than reported empty.
    expect(data.sections.map((s: any) => [s.slug, s.status])).toEqual([['epa-superfund-npl', 'found']])
    expect(data.sections[0].count).toBe(3)
    expect(data.sections[0].url).toBe('https://map.example.org/library/epa-superfund-npl?place=g13121')
    expect(data.county).toMatchObject({ geoid: '13121', name: 'Fulton County' })
    expect(data.summary.text).toContain('Three Superfund sites')
    expect(data.url).toBe('https://map.example.org/place?geoid=13121')
  })

  it('trims a section to five rows — a desktop assistant reads all of them', async () => {
    const { data } = await call('place_report', { point: ATLANTA, radiusMiles: 25 })
    expect(MCP_REPORT_ROWS).toBe(5)
    for (const section of data.sections) expect(section.rows.length).toBeLessThanOrEqual(MCP_REPORT_ROWS)
    // A point can be asked of anything, so the hand-only source is listed too.
    expect(data.sections.map((s: any) => s.status)).toContain('skipped')
    expect(data.url).toContain('/place?lat=33.749')
  })

  it('refuses a report with no place, in words', async () => {
    const res = await call('place_report', {})
    expect(res.isError).toBe(true)
    expect(res.text).toContain('address, a point, or a 5-digit county geoid')
  })

  it('reads the second identical request out of the cache', async () => {
    expect((await call('place_report', { geoid: '13121' })).data.cached).toBe(false)
    expect((await call('place_report', { geoid: '13121' })).data.cached).toBe(true)
  })

  it('audits the call as mcp.place_report', async () => {
    await call('place_report', { geoid: '13121' })
    const rows = await auditRows()
    expect(rows.map(r => r.action)).toEqual(['mcp.place_report'])
    expect(rows[0]).toMatchObject({ actor: 'nick', target: '13121' })
    expect(rows[0].detail).toMatchObject({ client: 'ClaudeDesktop/1.2' })
  })
})
