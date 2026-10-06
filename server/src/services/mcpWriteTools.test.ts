import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * P5-52: the MCP write tools, exercised directly.
 *
 * The wire (scope gate, audit rows, annotations) is covered in
 * routes/mcp.test.ts; this file is about what each tool DOES — the validators
 * it shares with the app's own forms, the caps, the conflict handling, and
 * the attribution that lands in the audit log.
 *
 * Real pg-mem, real FakeS3, real services: a note written here is a note the
 * catalog can find, not a mock's return value.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')
const { reindexCatalog, getCatalogEntry, getWikiPage, getSavedView, upsertWikiPage } =
  await import('./libraryCatalog.js')
const { resetLinkFetchQueue, whenQueueIdle } = await import('./linkFetchQueue.js')
const { viaLabel, recentActivity } = await import('./libraryActivity.js')
const { McpToolError, PUBLIC_LAYERS } = await import('./mcpTools.js')
const {
  MCP_WRITE_TOOLS,
  WRITE_BODY_MAX,
  WRITE_TITLE_MAX,
  WRITE_TAGS_MAX,
  appendHeading,
  appendedMarkdown,
  setAppendRaceHook,
} = await import('./mcpWriteTools.js')

const CTX = { user: { id: 1, username: 'maria', role: 'internal' as const }, via: 'ChatGPT' }

const tool = (name: string) => {
  const found = MCP_WRITE_TOOLS.find(t => t.name === name)
  if (!found) throw new Error(`no write tool named ${name}`)
  return found
}
/** Call a tool the way the endpoint does, minus the JSON-RPC round trip. */
const run = (name: string, args: unknown = {}, ctx = CTX) => tool(name).run(args as never, ctx)

/** The JSON Schema clients actually see, as a parser — so the caps can be
 *  asserted where they are enforced (the SDK validates before `run` is hit). */
const schema = (name: string) => z.object(tool(name).inputSchema)

let fake: InstanceType<typeof FakeS3>
let dataDir: string

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

async function auditRows(action?: string) {
  // Entity audit rows are fire-and-forget; let them land.
  await new Promise(resolve => setTimeout(resolve, 30))
  const { rows } = await libraryQuery(
    action
      ? `SELECT actor, action, target, detail FROM library_audit WHERE action = $1 ORDER BY id`
      : `SELECT actor, action, target, detail FROM library_audit ORDER BY id`,
    action ? [action] : [],
  )
  return rows as { actor: string; action: string; target: string | null; detail: any }[]
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-mcp-write-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  resetLinkFetchQueue()
  setAppendRaceHook(null)

  fake.seed('library/wiki/land-loss.md', '# Land loss\n\nPartition sales are the mechanism most often named.\n')
  fake.seed('library/wiki/home.md', '# Home\n\nStart here.\n')
  fake.seed('library/datasets/orgs/data.csv', 'Name,HQ State,Tier\nAcme,GA,Tier 1\nBeta,TN,Tier 2\n')
  fake.seed(
    'library/datasets/orgs/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'orgs', status: 'published', tags: [] }),
  )
  await reindexCatalog()
})

afterEach(async () => {
  setAppendRaceHook(null)
  await whenQueueIdle()
  resetLinkFetchQueue()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// --- create_note --------------------------------------------------------------

describe('create_note', () => {
  it('writes a note the catalog can find, with the UI form default status', async () => {
    const result = (await run('create_note', {
      title: 'Shelby follow-up',
      body: 'Call the assessor about the 2019 partition sales.',
      tags: [' shelby ', ''],
    })) as any
    expect(result).toMatchObject({ slug: 'shelby-follow-up', href: '/library/shelby-follow-up' })

    const entry = await getCatalogEntry('shelby-follow-up')
    expect(entry?.kind).toBe('note')
    expect(entry?.meta.body).toContain('partition sales')
    // No category given → 'ideas', which the note service opens as 'open'.
    expect(entry?.category).toBe('ideas')
    expect(entry?.status).toBe('open')
    // Blank tags are dropped, the rest trimmed — the form's own rule.
    expect(entry?.tags).toEqual(['shelby'])
  })

  it('files into a named category, which changes the status the same way the form does', async () => {
    const result = (await run('create_note', {
      title: 'Heirs property definitions',
      body: 'Working definitions used across the pages.',
      category: 'research',
    })) as any
    expect(result.status).toBe('needs-review')
    expect((await getCatalogEntry(result.slug))?.category).toBe('research')
  })

  it('refuses an empty title or body, and a title with nothing sluggable in it', async () => {
    await expect(run('create_note', { title: '   ', body: 'x' })).rejects.toThrow(/needs a title/i)
    await expect(run('create_note', { title: 'ok', body: '   ' })).rejects.toThrow(/at least a sentence/i)
    await expect(run('create_note', { title: '???', body: 'x' })).rejects.toThrow(/letters or numbers/i)
  })

  it('records library.note with the actor and the assistant it came through', async () => {
    await run('create_note', { title: 'Attribution check', body: 'A note.' })
    const rows = await auditRows('library.note')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'maria', target: 'attribution-check' })
    expect(rows[0].detail.via).toBe('ChatGPT')
  })
})

// --- append_to_page -----------------------------------------------------------

describe('append_to_page', () => {
  it('adds a section under a heading and leaves everything above it alone', async () => {
    const result = (await run('append_to_page', {
      slug: 'land-loss',
      markdown: 'Tax sales are the second mechanism.',
      heading: 'Tax sales',
    })) as any
    expect(result).toMatchObject({ slug: 'land-loss', heading: 'Tax sales', href: '/wiki/land-loss' })
    expect(result.updatedAt).toBeTruthy()

    const page = await getWikiPage('land-loss')
    expect(page?.markdown).toContain('Partition sales are the mechanism most often named.')
    expect(page?.markdown).toContain('## Tax sales\n\nTax sales are the second mechanism.')
    // The title still comes from the first "# " line, so the page keeps its name.
    expect(page?.title).toBe('Land loss')
  })

  it('names the assistant in the heading when the caller gives none', async () => {
    await run('append_to_page', { slug: 'land-loss', markdown: 'Another paragraph.' })
    expect((await getWikiPage('land-loss'))?.markdown).toContain('## From ChatGPT')
  })

  it('refuses a page that does not exist, and points at the tool that would make one', async () => {
    await expect(run('append_to_page', { slug: 'nope', markdown: 'x' })).rejects.toThrow(/No wiki page.*create: true/s)
  })

  it('refuses the home page unless the caller says so out loud', async () => {
    await expect(run('append_to_page', { slug: 'home', markdown: 'x' })).rejects.toThrow(/front page/i)
    expect((await getWikiPage('home'))?.markdown).not.toContain('x')

    await run('append_to_page', { slug: 'home', markdown: 'Approved addition.', allowHome: true })
    expect((await getWikiPage('home'))?.markdown).toContain('Approved addition.')
  })

  it('retries once when somebody saves the page mid-append, and keeps both edits', async () => {
    let fired = false
    setAppendRaceHook(async () => {
      if (fired) return
      fired = true
      await upsertWikiPage('land-loss', '# Land loss\n\nSomeone else rewrote this while we composed.\n')
    })
    await run('append_to_page', { slug: 'land-loss', markdown: 'The assistant paragraph.', heading: 'Notes' })

    const page = await getWikiPage('land-loss')
    // The retry appended to the OTHER writer's text rather than over it.
    expect(page?.markdown).toContain('Someone else rewrote this while we composed.')
    expect(page?.markdown).toContain('## Notes\n\nThe assistant paragraph.')
    expect(page?.markdown).not.toContain('Partition sales are the mechanism most often named.')
  })

  it('gives up after a second collision rather than looping', async () => {
    let n = 0
    setAppendRaceHook(async () => {
      await upsertWikiPage('land-loss', `# Land loss\n\nEdit ${++n}.\n`)
    })
    await expect(run('append_to_page', { slug: 'land-loss', markdown: 'x' })).rejects.toThrow(/changed twice/i)
    expect(n).toBe(2)
    expect((await getWikiPage('land-loss'))?.markdown).not.toContain('x')
  })

  it('records wiki.update with the assistant it came through', async () => {
    await run('append_to_page', { slug: 'land-loss', markdown: 'A paragraph.' })
    const rows = await auditRows('wiki.update')
    expect(rows[0]).toMatchObject({ actor: 'maria', target: 'land-loss' })
    expect(rows[0].detail.via).toBe('ChatGPT')
    expect(rows[0].detail.heading).toBe('From ChatGPT')
  })
})

// --- update_page ---------------------------------------------------------------

describe('update_page', () => {
  it('replaces the page whole and hands back the new baseline', async () => {
    const before = await getCatalogEntry('land-loss')
    const result = (await run('update_page', {
      slug: 'land-loss',
      markdown: '# Land loss\n\nRewritten in one pass.\n',
      expectedUpdatedAt: before?.updatedAt,
    })) as any
    expect(result).toMatchObject({ slug: 'land-loss', title: 'Land loss', created: false })
    expect((await getWikiPage('land-loss'))?.markdown).toBe('# Land loss\n\nRewritten in one pass.')
    expect(result.updatedAt).toBeTruthy()
  })

  it('refuses a stale baseline instead of overwriting somebody', async () => {
    const stale = new Date(Date.now() - 60_000).toISOString()
    await expect(
      run('update_page', { slug: 'land-loss', markdown: '# Land loss\n\nMine.\n', expectedUpdatedAt: stale }),
    ).rejects.toThrow(/changed after you read it/i)
    // Nothing was written.
    expect((await getWikiPage('land-loss'))?.markdown).toContain('Partition sales')
  })

  it('refuses a baseline that is not a timestamp at all', async () => {
    await expect(
      run('update_page', { slug: 'land-loss', markdown: '# x\n\ny\n', expectedUpdatedAt: 'yesterday' }),
    ).rejects.toThrow(/ISO timestamp/i)
  })

  it('creates a missing page only when asked, and audits the creation as such', async () => {
    await expect(run('update_page', { slug: 'new-page', markdown: '# New page\n\nBody.\n' })).rejects.toThrow(
      /create: true/,
    )
    expect(await getWikiPage('new-page')).toBeNull()

    const created = (await run('update_page', {
      slug: 'new-page',
      markdown: '# New page\n\nBody.\n',
      create: true,
    })) as any
    expect(created.created).toBe(true)
    expect((await getWikiPage('new-page'))?.title).toBe('New page')
    const rows = await auditRows('wiki.create')
    expect(rows[0]).toMatchObject({ target: 'new-page' })
    expect(rows[0].detail.via).toBe('ChatGPT')
  })

  it('refuses a slug that is not a slug, and the home page without permission', async () => {
    await expect(run('update_page', { slug: 'Not A Slug', markdown: '# x\n\ny\n' })).rejects.toThrow(/lowercase/i)
    await expect(run('update_page', { slug: 'home', markdown: '# Home\n\nMine now.\n' })).rejects.toThrow(/front page/i)
    expect((await getWikiPage('home'))?.markdown).toContain('Start here.')
  })

  it('refuses a slug held by something that is not a page', async () => {
    await expect(run('update_page', { slug: 'orgs', markdown: '# Orgs\n\nx\n', create: true })).rejects.toThrow(
      /not a wiki page/i,
    )
  })
})

// --- drop_link -------------------------------------------------------------------

describe('drop_link', () => {
  it('files a link into the incoming queue and queues the fetch', async () => {
    const result = (await run('drop_link', {
      url: 'https://data.census.gov/table/ACSDT5Y2022.B25003',
      note: 'Tenure by county.',
    })) as any
    expect(result).toMatchObject({ kind: 'incoming', status: 'needs-cataloging', fetch: 'queued' })
    expect(result.href).toBe(`/library/${result.slug}`)

    const entry = await getCatalogEntry(result.slug)
    expect(entry?.meta.url).toBe('https://data.census.gov/table/ACSDT5Y2022.B25003')
    expect(entry?.meta.note).toBe('Tenure by county.')
    expect(entry?.meta.linkedBy).toBe('maria')
    // A title makes it a filed drop rather than a quick one — same rule as the form.
    const titled = (await run('drop_link', { url: 'https://example.org/data', title: 'Example data' })) as any
    expect(titled.status).toBe('needs-review')
    expect(titled.title).toBe('Example data')
  })

  it('refuses anything that is not a public http(s) link', async () => {
    for (const url of ['javascript:alert(1)', 'http://127.0.0.1/admin', 'http://user:pw@example.org/', 'not a url']) {
      await expect(run('drop_link', { url }), url).rejects.toThrow(/public http\(s\) URL/i)
    }
  })

  it('records a data source from a source block, and never downloads it', async () => {
    const result = (await run('drop_link', {
      url: 'https://echo.epa.gov/tools/web-services',
      title: 'ECHO facility search',
      isSource: { provider: 'EPA', geography: 'point', access: [{ type: 'rest', url: 'https://echo.epa.gov/api' }] },
    })) as any
    expect(result).toMatchObject({ kind: 'source', fetch: 'skipped' })
    const entry = await getCatalogEntry(result.slug)
    expect((entry?.meta.source as any).provider).toBe('EPA')
    expect(entry?.meta.fetch).toBeUndefined()
  })

  it('refuses a source block with no provider — the one field we cannot guess', async () => {
    await expect(run('drop_link', { url: 'https://example.org/x', isSource: { geography: 'county' } })).rejects.toThrow(
      /needs a provider/i,
    )
  })

  it('records library.link with the assistant it came through', async () => {
    const result = (await run('drop_link', { url: 'https://example.org/data.csv' })) as any
    const rows = await auditRows('library.link')
    expect(rows[0]).toMatchObject({ actor: 'maria', target: result.slug })
    expect(rows[0].detail.via).toBe('ChatGPT')
  })
})

// --- save_view --------------------------------------------------------------------

describe('save_view (map)', () => {
  const layerId = PUBLIC_LAYERS[0].id

  it('saves a map view against the real layer registry and links to the map', async () => {
    const result = (await run('save_view', {
      name: 'Delta counties',
      type: 'map',
      state: { layers: [{ layerId, weight: 2 }], regionStates: ['tn', 'MS'], limit: 25 },
    })) as any
    expect(result).toMatchObject({ slug: 'delta-counties', type: 'map', href: '/?view=delta-counties' })

    const view = await getSavedView('delta-counties')
    expect(view?.type).toBe('map')
    expect(view?.state.layers).toEqual([{ layerId, weight: 2 }])
    // Codes are normalised so a view saved from a chat matches one saved from the map.
    expect(view?.state.regionStates).toEqual(['TN', 'MS'])
    expect(view?.state.limit).toBe(25)
    expect(view?.savedBy).toBe('maria')
    // An assistant has no screen, so there is no snapshot to store.
    expect(view?.results).toEqual([])
  })

  it('refuses a layer id, weight, filter or region the map could not use', async () => {
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ layers: [] }, /at least one layer/i],
      [{ layers: [{ layerId: 'made_up', weight: 1 }] }, /unknown layer/i],
      [{ layers: [{ layerId, weight: 0 }] }, /positive number/i],
      [{ layers: [{ layerId, weight: 1 }], filters: [{ layerId: 'nope', operator: 'greater_than', value: 1 }] }, /unknown layer in a filter/i],
      [{ layers: [{ layerId, weight: 1 }], filters: [{ layerId, operator: 'roughly', value: 1 }] }, /filter operator/i],
      [{ layers: [{ layerId, weight: 1 }], filters: [{ layerId, operator: 'between', value: 1 }] }, /numeric max/i],
      [{ layers: [{ layerId, weight: 1 }], regionStates: ['Tennessee'] }, /two-letter state code/i],
    ]
    for (const [state, message] of bad) {
      await expect(run('save_view', { name: 'x', type: 'map', state }), JSON.stringify(state)).rejects.toThrow(message)
    }
  })

  it('carries the contamination overlays a view opens with (P5-78)', async () => {
    await run('save_view', {
      name: 'Superfund shortlist',
      type: 'map',
      state: { layers: [{ layerId, weight: 1 }], siteLayers: ['superfund_sites', 'superfund_sites'] },
    })
    const view = await getSavedView('superfund-shortlist')
    expect(view?.state.siteLayers).toEqual(['superfund_sites'])
  })

  it('refuses a site layer that is not one of the five, rather than dropping it silently', async () => {
    await expect(
      run('save_view', {
        name: 'x',
        type: 'map',
        state: { layers: [{ layerId, weight: 1 }], siteLayers: ['lead_pipes'] },
      }),
    ).rejects.toThrow(/unknown site layer/i)
  })

  it('records view.create with the assistant it came through', async () => {
    await run('save_view', { name: 'Audited view', type: 'map', state: { layers: [{ layerId, weight: 1 }] } })
    const rows = await auditRows('view.create')
    expect(rows[0]).toMatchObject({ actor: 'maria', target: 'audited-view' })
    expect(rows[0].detail).toMatchObject({ type: 'map', resultCount: 0, via: 'ChatGPT' })
  })
})

describe('save_view (table)', () => {
  it('reuses the views route validator, so a saved query is checked against the real columns', async () => {
    const result = (await run('save_view', {
      name: 'Georgia orgs',
      type: 'table',
      state: { dataset: 'orgs', filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }], summary: { groupBy: 'Tier' } },
    })) as any
    expect(result).toMatchObject({ slug: 'georgia-orgs', type: 'table', href: '/views/georgia-orgs' })

    const view = await getSavedView('georgia-orgs')
    expect(view?.type).toBe('table')
    // parseTableState stamps the dataset title and normalises the filters.
    expect(view?.state.datasetTitle).toBe('Organizations')
    expect(view?.state.filters).toEqual([{ column: 'HQ State', op: 'eq', value: 'GA' }])
    expect(view?.state.summary).toEqual({ groupBy: 'Tier' })
  })

  it("passes the route validator's refusals straight through", async () => {
    await expect(run('save_view', { name: 'x', type: 'table', state: {} })).rejects.toThrow(/needs a dataset/i)
    await expect(
      run('save_view', { name: 'x', type: 'table', state: { dataset: 'orgs', sort: 'Nope' } }),
    ).rejects.toThrow(/unknown column/i)
    await expect(run('save_view', { name: 'x', type: 'table', state: { dataset: 'ghost' } })).rejects.toThrow(
      /not found/i,
    )
  })

  it('refuses a name with nothing sluggable in it', async () => {
    await expect(run('save_view', { name: '   ', type: 'map', state: {} })).rejects.toThrow(/needs a name/i)
  })
})

// --- Caps, shapes and posture --------------------------------------------------------

describe('the write tool table', () => {
  it('caps bodies, titles and tags in the schema clients are validated against', () => {
    const note = schema('create_note')
    expect(note.safeParse({ title: 'x', body: 'a'.repeat(WRITE_BODY_MAX + 1) }).success).toBe(false)
    expect(note.safeParse({ title: 'x'.repeat(WRITE_TITLE_MAX + 1), body: 'y' }).success).toBe(false)
    expect(note.safeParse({ title: 'x', body: 'y', tags: Array(WRITE_TAGS_MAX + 1).fill('t') }).success).toBe(false)
    expect(note.safeParse({ title: 'x', body: 'y', tags: ['a', 'b'] }).success).toBe(true)

    for (const name of ['append_to_page', 'update_page']) {
      expect(
        schema(name).safeParse({ slug: 'land-loss', markdown: 'm'.repeat(WRITE_BODY_MAX + 1) }).success,
        name,
      ).toBe(false)
    }
    // A source block must name its provider before it ever reaches the parser.
    expect(schema('drop_link').safeParse({ url: 'https://a.example', isSource: {} }).success).toBe(false)
    expect(schema('drop_link').safeParse({ url: 'https://a.example', isSource: { provider: 'EPA' } }).success).toBe(true)
    // save_view only accepts the two types that exist.
    expect(schema('save_view').safeParse({ name: 'n', type: 'compare', state: {} }).success).toBe(false)
  })

  it('is exactly the seven tools, all marked as writes, none of them deletes', () => {
    expect(MCP_WRITE_TOOLS.map(t => t.name).sort()).toEqual(
      // P7-5's `measure_proximity` was the sixth and the first write that is
      // an ANALYSIS rather than a filing — the spec's own reason for the
      // analysis being server-side is that chat has to be able to ask for it.
      // P7-8's `build_index` is the seventh and the second analysis, which is
      // §F.5's "Build an index" card reaching chat as well as the page.
      ['append_to_page', 'build_index', 'create_note', 'drop_link', 'measure_proximity', 'save_view', 'update_page'].sort(),
    )
    for (const t of MCP_WRITE_TOOLS) {
      expect(t.write, t.name).toBe(true)
      expect(t.description.length, t.name).toBeGreaterThan(40)
      expect(t.name, 'no delete tool exists').not.toMatch(/delete|remove|purge/)
    }
    // Only a whole-page replace is idempotent; the rest add a thing per call.
    expect(MCP_WRITE_TOOLS.filter(t => t.idempotent).map(t => t.name)).toEqual(['update_page'])
  })

  it('tells a model what a served result is, and to relay the caveat (P7-6)', async () => {
    // The description is the model's only instruction, so the two things it
    // must not get wrong are said in it: asking twice costs nothing, and a
    // number whose input has moved is never quoted bare.
    const description = MCP_WRITE_TOOLS.find(t => t.name === 'measure_proximity')!.description
    expect(description).toContain('"served": "stored"')
    expect(description).toContain('staleNote')
    expect(description).toMatch(/computes nothing/i)
  })

  it('tells a model that an index needs its directions stated, not guessed (P7-8)', async () => {
    const tool = MCP_WRITE_TOOLS.find(t => t.name === 'build_index')!
    // The one thing a model must not do here is default a direction: an index
    // whose directions were guessed is a confident wrong number, not an error.
    expect((tool.inputSchema as any).layers).toBeDefined()
    expect(tool.description).toContain('"served": "stored"')
    expect(tool.description).toContain('staleNote')
    expect(tool.description).toMatch(/weights are RELATIVE/)
    expect(tool.description).toMatch(/must be a COUNTY layer/)
    expect(tool.description).toMatch(/refuses for size, the sentence names a local batch pass/)
  })

  it('turns an expected refusal into an McpToolError, which is what crosses the wire', async () => {
    await expect(run('append_to_page', { slug: 'ghost', markdown: 'x' })).rejects.toBeInstanceOf(McpToolError)
  })
})

describe('appended markdown', () => {
  it('separates the new section without growing a gap on repeated appends', () => {
    expect(appendedMarkdown('# Page\n\nBody.\n\n\n', 'Notes', '  New text.  ')).toBe(
      '# Page\n\nBody.\n\n## Notes\n\nNew text.\n',
    )
  })

  it('falls back to naming the assistant', () => {
    expect(appendHeading('  Tax sales ', 'ChatGPT')).toBe('Tax sales')
    expect(appendHeading(undefined, 'ChatGPT')).toBe('From ChatGPT')
    expect(appendHeading('   ', 'Claude Desktop — laptop')).toBe('From Claude Desktop — laptop')
  })
})

// --- Attribution on the activity feed -------------------------------------------------

describe('the activity feed', () => {
  it('says which assistant a write came through, and stays unchanged for browser work', async () => {
    await run('create_note', { title: 'From the assistant', body: 'Body.' })
    // A note written in the browser records no `via`.
    const { createNoteEntry } = await import('./libraryCatalog.js')
    const { writeAudit } = await import('./libraryDb.js')
    const made = await createNoteEntry({
      title: 'From the browser',
      body: 'Body.',
      category: 'ideas',
      tags: [],
      createdBy: 'maria',
      createdById: 1,
    })
    await writeAudit({ userId: 1, actor: 'maria', action: 'library.note', target: 'from-the-browser', detail: {} })
    expect(made.error).toBeUndefined()

    await new Promise(resolve => setTimeout(resolve, 30))
    const rows = await recentActivity(10)
    const verbs = Object.fromEntries(rows.map(r => [r.target?.slug, r.verb]))
    expect(verbs['from-the-assistant']).toBe('wrote the note via ChatGPT')
    expect(verbs['from-the-browser']).toBe('wrote the note')
  })

  it('keeps a token name from rewriting the rest of the line', () => {
    expect(viaLabel({ via: 'ChatGPT' })).toBe('ChatGPT')
    expect(viaLabel({})).toBeNull()
    expect(viaLabel({ via: '   ' })).toBeNull()
    expect(viaLabel({ via: 42 })).toBeNull()
    // Newlines and bidi overrides come out; a long name is clipped.
    expect(viaLabel({ via: 'Chat\nGPT‮' })).toBe('ChatGPT')
    expect(viaLabel({ via: 'x'.repeat(100) })).toHaveLength(61)
  })
})

/** P5-59: the plan is an admin decision, on every surface. */
describe('drop_link and the ingest plan', () => {
  const ADMIN = { user: { id: 2, username: 'nick', role: 'admin' as const }, via: 'ChatGPT' }

  it('records a plan the admin gave', async () => {
    const result = (await run(
      'drop_link',
      { url: 'https://hazards.fema.gov/downloads/nri.csv', plan: 'replicate', planMode: 'manual' },
      ADMIN as never,
    )) as any
    expect(result.plan).toBe('replicate')
    const entry = await getCatalogEntry(result.slug)
    expect(entry!.meta.ingest).toMatchObject({ plan: 'replicate', mode: 'manual', decidedBy: 'nick' })
  })

  it('ignores a researcher\u2019s plan and says so, rather than obeying or failing', async () => {
    const result = (await run('drop_link', { url: 'https://hazards.fema.gov/downloads/nri.csv', plan: 'replicate' })) as any
    expect(result.plan).toBeUndefined()
    expect(result.planIgnored).toMatch(/only an admin/i)
    const entry = await getCatalogEntry(result.slug)
    expect(entry!.meta.ingest).toBeUndefined()
  })

  it('a drop with no plan gets none, which is the state the queue lists', async () => {
    const result = (await run('drop_link', { url: 'https://hazards.fema.gov/downloads/nri.csv' })) as any
    expect(result.plan).toBeUndefined()
    expect(result.planIgnored).toBeUndefined()
  })
})
