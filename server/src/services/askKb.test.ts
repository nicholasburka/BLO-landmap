import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import type Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-41 answer generation. The Anthropic client is a stub whose
 * messages.create returns scripted turns, so the tool loop, the query
 * validation, the deep links and the token accounting are all asserted
 * without spending a token or touching the network.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { buildKbIndex, clearKbIndex } = await import('./kbSearch.js')
const {
  askKb,
  AskModelError,
  runQueryDataset,
  groupByColumn,
  sourcesFor,
  tableHref,
  mapHref,
  askModel,
  askMaxTokens,
  MAX_TOOL_ROUNDS,
  QUERY_DATASET_TOOL,
  FETCH_FOR_PLACE_TOOL,
  MAX_PLACE_FETCHES,
  MAX_LINK_INSPECTIONS,
  runInspectLink,
  INSPECT_LINK_TOOL,
  PLACE_SAMPLE_ROWS,
  runFetchForPlace,
  placeHref,
  placeChunk,
} = await import('./askKb.js')

type AnthropicLike = import('./askKb.js').AnthropicLike

type KbIndexType = Awaited<ReturnType<typeof buildKbIndex>>

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

// --- Scripted model turns --------------------------------------------------

let usageCounter = 0
function textTurn(text: string): Anthropic.Messages.Message {
  usageCounter++
  return {
    id: `msg_${usageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as unknown as Anthropic.Messages.Message
}

function toolTurn(input: Record<string, unknown>, id = 't1'): Anthropic.Messages.Message {
  usageCounter++
  return {
    id: `msg_${usageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'tool_use', id, name: 'query_dataset', input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 30 },
  } as unknown as Anthropic.Messages.Message
}

function stubClient(...turns: Anthropic.Messages.Message[]): { client: AnthropicLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn()
  for (const turn of turns) create.mockResolvedValueOnce(turn)
  // Anything beyond the script is a plain answer, so a runaway loop still ends.
  create.mockResolvedValue(textTurn('Fallback answer.'))
  return { client: { messages: { create } } as unknown as AnthropicLike, create }
}

const ORGS_CSV = [
  'Organization,HQ State,Tier',
  'Black Farmer Fund,NY,Tier 1',
  'Southwest Georgia Project,GA,Tier 1',
  'Truly Living Well,GA,Tier 2',
  'Land Loss Prevention,NC,',
].join('\n')

let fake: FakeS3
let dataDir: string
let index: KbIndexType

beforeEach(async () => {
  clearKbIndex()
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-askkb-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/datasets/organizations/organizations.csv', ORGS_CSV)
  fake.seed(
    'library/datasets/organizations/meta.json',
    JSON.stringify({
      title: 'Organizations',
      category: 'network',
      status: 'published',
      tags: ['network'],
      description: 'Organizations doing land work, one row each.',
      layer: {
        geometry: 'point',
        name: 'Organizations (HQ)',
        description: '',
        source: 'staff',
        year: 2026,
        latKey: '_lat',
        lngKey: '_lng',
        labelKey: 'Organization',
      },
    }),
  )
  fake.seed('library/wiki/funding-strategy.md', '# Funding strategy\n\n## Year two\n\nYear two moves to stewardship.\n')
  await reindexCatalog()
  index = await buildKbIndex()
})

afterEach(async () => {
  clearKbIndex()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// --- Configuration ---------------------------------------------------------

describe('model configuration', () => {
  afterEach(() => {
    delete process.env.LIBRARY_ASK_MODEL
    delete process.env.LIBRARY_ASK_MAX_TOKENS
  })

  it('defaults to claude-sonnet-5 and ~1000 output tokens, both overridable', () => {
    expect(askModel()).toBe('claude-sonnet-5')
    expect(askMaxTokens()).toBe(1_500)
    process.env.LIBRARY_ASK_MODEL = 'claude-haiku-4-5'
    process.env.LIBRARY_ASK_MAX_TOKENS = '400'
    expect(askModel()).toBe('claude-haiku-4-5')
    expect(askMaxTokens()).toBe(400)
    process.env.LIBRARY_ASK_MAX_TOKENS = 'nonsense'
    expect(askMaxTokens()).toBe(1_500)
  })
})

// --- Deep links ------------------------------------------------------------

describe('deep links', () => {
  it('builds a table link the explorer understands — tab=data plus buildRowsQuery filter JSON', () => {
    const href = tableHref('organizations', [{ column: 'HQ State', op: 'eq', value: 'GA' }])
    expect(href).toBe('/library/organizations?tab=data&filter=%5B%7B%22column%22%3A%22HQ+State%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22GA%22%7D%5D')
    const parsed = new URLSearchParams(href.split('?')[1])
    expect(parsed.get('tab')).toBe('data')
    expect(JSON.parse(parsed.get('filter')!)).toEqual([{ column: 'HQ State', op: 'eq', value: 'GA' }])
  })

  it('omits the filter param when there are no filters', () => {
    expect(tableHref('organizations', [])).toBe('/library/organizations?tab=data')
  })

  it('builds the map link from the internal layer id', () => {
    expect(mapHref('internal-organizations')).toBe('/?layers=internal-organizations')
  })
})

// --- Group-by --------------------------------------------------------------

describe('groupByColumn', () => {
  const rows = [
    { _row: 0, State: 'GA' },
    { _row: 1, State: 'GA' },
    { _row: 2, State: 'NY' },
    { _row: 3, State: '  ' },
  ]

  it('counts rows per value, biggest first, with blanks named', () => {
    expect(groupByColumn(rows, 'State')).toEqual({
      groups: [
        { value: 'GA', count: 2 },
        { value: '(blank)', count: 1 },
        { value: 'NY', count: 1 },
      ],
      counted: 4,
      distinct: 3,
      truncated: false,
    })
  })

  it('caps the number of groups but still reports how many distinct values there were', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ _row: i, State: `S${i}` }))
    const result = groupByColumn(many, 'State', 5)
    expect(result.groups).toHaveLength(5)
    expect(result.distinct).toBe(40)
  })
})

// --- The tool --------------------------------------------------------------

describe('runQueryDataset', () => {
  it('runs a validated filter and returns a card with both deep links', async () => {
    const outcome = await runQueryDataset({ slug: 'organizations', filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] }, index)
    expect('error' in outcome).toBe(false)
    if ('error' in outcome) return
    expect(outcome.card.rowCount).toBe(2)
    expect(outcome.card.filters).toEqual([{ column: 'HQ State', op: 'eq', value: 'GA' }])
    expect(outcome.card.href).toContain('tab=data')
    expect(outcome.card.mapHref).toBe('/?layers=internal-organizations')
    expect(outcome.text).toContain('2 rows match')
    expect(outcome.text).toContain('Southwest Georgia Project')
  })

  it('groups by a column and returns counts only', async () => {
    const outcome = await runQueryDataset({ slug: 'organizations', groupBy: 'HQ State' }, index)
    if ('error' in outcome) throw new Error(outcome.error)
    expect(outcome.card.groupBy).toBe('HQ State')
    expect(outcome.card.groups).toEqual([
      { value: 'GA', count: 2 },
      { value: 'NC', count: 1 },
      { value: 'NY', count: 1 },
    ])
    expect(outcome.text).toContain('GA: 2')
  })

  it('refuses an unknown slug with an error string, not a crash, and names the tables it has', async () => {
    const outcome = await runQueryDataset({ slug: 'not-a-dataset' }, index)
    expect(outcome).toEqual({ error: expect.stringContaining('Cannot query "not-a-dataset"') })
    expect((outcome as { error: string }).error).toContain('organizations')
  })

  it('refuses an unknown filter column and lists the real ones', async () => {
    const outcome = await runQueryDataset({ slug: 'organizations', filters: [{ column: 'State', op: 'eq', value: 'GA' }] }, index)
    expect(outcome).toEqual({ error: expect.stringContaining('unknown column: State') })
    expect((outcome as { error: string }).error).toContain('HQ State')
  })

  it('refuses an unknown groupBy column', async () => {
    const outcome = await runQueryDataset({ slug: 'organizations', groupBy: 'Region' }, index)
    expect(outcome).toEqual({ error: expect.stringContaining('unknown column: Region') })
  })

  it('refuses an unsupported operator', async () => {
    const outcome = await runQueryDataset({ slug: 'organizations', filters: [{ column: 'Tier', op: 'regex', value: '.*' }] }, index)
    expect(outcome).toEqual({ error: expect.stringContaining('filter op must be one of') })
  })

  it('refuses a call with no slug', async () => {
    expect(await runQueryDataset({}, index)).toEqual({ error: expect.stringContaining('needs a "slug"') })
    expect(await runQueryDataset(null, index)).toEqual({ error: expect.stringContaining('needs a "slug"') })
  })
})

// --- Sources ---------------------------------------------------------------

describe('sourcesFor', () => {
  const chunks = [
    { slug: 'a', kind: 'wiki', title: 'A', href: '/wiki/a', text: 'alpha' },
    { slug: 'b', kind: 'dataset', title: 'B', heading: 'Cols', href: '/library/b', text: 'beta' },
    { slug: 'c', kind: 'note', title: 'C', href: '/library/c', text: 'gamma' },
    { slug: 'd', kind: 'note', title: 'D', href: '/library/d', text: 'delta' },
  ] as unknown as Parameters<typeof sourcesFor>[0]

  it('returns only the excerpts the answer cited, keeping their numbers so [n] resolves', () => {
    const sources = sourcesFor(chunks, 'Yes [2], and also [4].')
    expect(sources.map(s => s.n)).toEqual([2, 4])
    expect(sources[0].title).toBe('B › Cols')
    expect(sources[0].href).toBe('/library/b')
    expect(sources.every(s => s.cited)).toBe(true)
  })

  it('falls back to the top three as leads when the answer cites nothing', () => {
    const sources = sourcesFor(chunks, 'The library does not cover that.')
    expect(sources.map(s => s.n)).toEqual([1, 2, 3])
    expect(sources.every(s => s.cited)).toBe(false)
  })

  it('cites a document page as "Title \u203a p. N" and keeps its deep link verbatim (P5-46)', () => {
    const pageChunk = [
      {
        slug: 'plan',
        kind: 'document',
        title: 'Strategic plan',
        heading: 'p. 12',
        href: '/library/plan?tab=files&view=Five_Year_Plan.pdf#page=12',
        text: 'The acquisition budget runs to five million dollars.',
      },
    ] as unknown as Parameters<typeof sourcesFor>[0]
    const [source] = sourcesFor(pageChunk, 'Five million [1].')
    expect(source.title).toBe('Strategic plan \u203a p. 12')
    // The page anchor is what makes the citation openable — it must survive.
    expect(source.href).toBe('/library/plan?tab=files&view=Five_Year_Plan.pdf#page=12')
    expect(source.kind).toBe('document')
  })
})

// --- The loop --------------------------------------------------------------

describe('askKb', () => {
  it('answers from excerpts alone when the model calls no tool', async () => {
    const { client, create } = stubClient(textTurn('Year two moves to stewardship [1].'))
    const result = await askKb({ question: 'what does the funding strategy say about year two?', client, index })
    expect(create).toHaveBeenCalledTimes(1)
    expect(result.answer).toBe('Year two moves to stewardship [1].')
    expect(result.queries).toEqual([])
    expect(result.toolCalls).toBe(0)
    expect(result.sources[0].slug).toBe('funding-strategy')
    expect(result.usedTokens).toBe(120)
  })

  it('marks a failed model call as AskModelError, keeping the original error (P5-75)', async () => {
    // The route has to tell "the model could not be called" (503, and an admin
    // is told which of the four reasons) apart from a bug in our retrieval.
    const sdk: any = new Error('rate_limit_error')
    sdk.status = 429
    const client = { messages: { create: vi.fn().mockRejectedValue(sdk) } } as unknown as AnthropicLike
    await expect(askKb({ question: 'what does the funding strategy say?', client, index })).rejects.toBeInstanceOf(
      AskModelError,
    )
    await expect(askKb({ question: 'what does the funding strategy say?', client, index })).rejects.toMatchObject({
      modelError: sdk,
      message: 'rate_limit_error',
    })
  })

  it('runs the tool, feeds the result back, and returns the query card with its links', async () => {
    const { client, create } = stubClient(
      toolTurn({ slug: 'organizations', filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] }),
      textTurn('Two organizations are based in Georgia [1].'),
    )
    const result = await askKb({ question: 'how many organizations are in Georgia?', client, index })

    expect(create).toHaveBeenCalledTimes(2)
    const first = create.mock.calls[0][0]
    expect(first.model).toBe('claude-sonnet-5')
    expect(first.max_tokens).toBe(1_500)
    expect(first.tools).toEqual([QUERY_DATASET_TOOL, FETCH_FOR_PLACE_TOOL, INSPECT_LINK_TOOL])

    // Round two carries the assistant turn verbatim plus one user message of
    // tool results — parallel calls must never be split across messages.
    const second = create.mock.calls[1][0]
    expect(second.messages).toHaveLength(3)
    expect(second.messages[1].role).toBe('assistant')
    expect(second.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' })
    expect(second.messages[2].content[0].content).toContain('2 rows match')

    expect(result.answer).toBe('Two organizations are based in Georgia [1].')
    expect(result.toolCalls).toBe(1)
    expect(result.queries).toHaveLength(1)
    expect(result.queries[0]).toMatchObject({
      slug: 'organizations',
      rowCount: 2,
      filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
      mapHref: '/?layers=internal-organizations',
    })
    expect(result.usedTokens).toBe(350)
  })

  it('hands a rejected query back to the model as a tool error and records no card', async () => {
    const { client } = stubClient(
      toolTurn({ slug: 'organizations', filters: [{ column: 'State', op: 'eq', value: 'GA' }] }),
      textTurn('The table has no State column [1].'),
    )
    const result = await askKb({ question: 'how many in Georgia?', client, index })
    expect(result.queries).toEqual([])
    expect(result.toolCalls).toBe(1)
    expect(result.answer).toContain('no State column')
  })

  it('stops after three tool rounds and withdraws the tools so the last turn must be prose', async () => {
    const turns = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => toolTurn({ slug: 'organizations' }, `t${i}`))
    const { client, create } = stubClient(...turns, textTurn('Four organizations in all [1].'))
    const result = await askKb({ question: 'how many organizations are there?', client, index })
    expect(create).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1)
    expect(create.mock.calls.at(-1)![0].tools).toBeUndefined()
    expect(result.toolCalls).toBe(MAX_TOOL_ROUNDS)
    expect(result.answer).toBe('Four organizations in all [1].')
  })

  it('pins the hinted dataset into the prompt, and ignores a hint the catalog does not know', async () => {
    const { client, create } = stubClient(textTurn('It has four rows [1].'))
    await askKb({ question: 'what is in here?', dataset: 'organizations', client, index })
    expect(create.mock.calls[0][0].messages[0].content).toContain('Organizations')
    expect(create.mock.calls[0][0].messages[0].content).toContain('slug `organizations`')

    const bogus = stubClient(textTurn('No idea [1].'))
    await askKb({ question: 'what is in here?', dataset: 'made-up-slug', client: bogus.client, index })
    expect(bogus.create.mock.calls[0][0].messages[0].content).not.toContain('made-up-slug')
  })

  it('says the library has nothing rather than inventing an answer, when nothing matches', async () => {
    const { client } = stubClient(textTurn(''))
    const result = await askKb({ question: 'photosynthesis chlorophyll', client, index })
    expect(result.sources).toEqual([])
    expect(result.answer).toContain('does not have anything on that yet')
  })

  it('falls back to a plain message when the model returns no text at all', async () => {
    const { client } = stubClient(textTurn(''))
    const result = await askKb({ question: 'year two funding strategy', client, index })
    expect(result.answer).toContain('could not put an answer together')
  })
})

// --- P5-57: fetch_for_place ---------------------------------------------------

const { setPlaceFetchDefaults, resetPlaceFetchDefaults } = await import('./placeFetch.js')
const { resetRateLimits } = await import('./placeHttp.js')
const { ARCGIS_GEOJSON, jsonResponse, publicLookup } = await import('../testutils/fixtures/place/index.js')

const NPL_SOURCE = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  category: 'environment',
  source: {
    provider: 'US EPA',
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0' }],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
    updateCadence: 'weekly',
  },
}

/** Seed a source entry (and optionally a manual-only one) and rebuild the index. */
async function withSources(): Promise<KbIndexType> {
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(NPL_SOURCE))
  fake.seed(
    'library/sources/georgia-epd-ust/meta.json',
    JSON.stringify({ title: 'Georgia EPD USTs', status: 'published', source: { provider: 'Georgia EPD', access: [{ type: 'manual' }] } }),
  )
  clearKbIndex()
  await reindexCatalog()
  return buildKbIndex()
}

function placeToolTurn(input: Record<string, unknown>, id = 'p1'): Anthropic.Messages.Message {
  usageCounter++
  return {
    id: `msg_${usageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'tool_use', id, name: 'fetch_for_place', input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 30 },
  } as unknown as Anthropic.Messages.Message
}

describe('runFetchForPlace (P5-57)', () => {
  beforeEach(() => {
    resetRateLimits()
    setPlaceFetchDefaults({ fetchImpl: (async () => jsonResponse(ARCGIS_GEOJSON)) as any, lookup: publicLookup as any })
  })
  afterEach(() => resetPlaceFetchDefaults())

  it('fetches a source for a county and hands back the count, rows and deep link', async () => {
    const withSource = await withSources()
    const outcome = await runFetchForPlace({ source: 'epa-superfund-npl', geoid: '13121' }, withSource)
    expect('error' in outcome).toBe(false)
    if ('error' in outcome) return
    expect(outcome.card).toMatchObject({ slug: 'epa-superfund-npl', count: 3, adapter: 'arcgis', cacheKey: 'g13121' })
    expect(outcome.text).toContain('3 rows for Fulton County, GA')
    expect(outcome.text).toContain('Site_Name: Lakewood Landfill')
    expect(outcome.text).toContain(placeHref('epa-superfund-npl', 'g13121'))
    expect(placeHref('epa-superfund-npl', 'g13121')).toBe('/library/epa-superfund-npl?place=g13121')
  })

  it('names the sources it does know when handed one it does not', async () => {
    const withSource = await withSources()
    const outcome = await runFetchForPlace({ source: 'epa-nope', geoid: '13121' }, withSource)
    expect(outcome).toEqual({ error: expect.stringContaining('epa-superfund-npl') })
  })

  it('sends the model to query_dataset when it points the tool at a dataset', async () => {
    const withSource = await withSources()
    expect(await runFetchForPlace({ source: 'organizations', geoid: '13121' }, withSource)).toEqual({
      error: expect.stringContaining('query_dataset'),
    })
  })

  it('explains a spreadsheets-only source rather than erroring at the model', async () => {
    const withSource = await withSources()
    const outcome = await runFetchForPlace({ source: 'georgia-epd-ust', geoid: '13121' }, withSource)
    // Not an error: "open it by hand" IS the answer, and the model relays it.
    expect('error' in outcome).toBe(false)
    if ('error' in outcome) return
    expect(outcome.text).toContain('by hand')
    expect(outcome.card).toBeUndefined()
  })

  it('needs a place, and says which three ways there are to give one', async () => {
    const withSource = await withSources()
    expect(await runFetchForPlace({ source: 'epa-superfund-npl' }, withSource)).toEqual({
      error: expect.stringContaining('address, a point, or a 5-digit county geoid'),
    })
    expect(await runFetchForPlace({}, withSource)).toEqual({ error: expect.stringContaining('"source"') })
  })

  it('turns an agency that will not answer into words, not a crash', async () => {
    const withSource = await withSources()
    setPlaceFetchDefaults({ fetchImpl: (async () => new Response('nope', { status: 503 })) as any, lookup: publicLookup as any })
    expect(await runFetchForPlace({ source: 'epa-superfund-npl', geoid: '13121' }, withSource)).toEqual({
      error: expect.stringContaining('refused'),
    })
  })
})

describe('the Ask loop with fetch_for_place (P5-57)', () => {
  beforeEach(() => {
    resetRateLimits()
    setPlaceFetchDefaults({ fetchImpl: (async () => jsonResponse(ARCGIS_GEOJSON)) as any, lookup: publicLookup as any })
  })
  afterEach(() => resetPlaceFetchDefaults())

  it('runs the fetch, cites the source entry, and returns the slice as a card', async () => {
    const withSource = await withSources()
    const { client } = stubClient(
      placeToolTurn({ source: 'epa-superfund-npl', geoid: '13121' }),
      textTurn('Three NPL sites sit in Fulton County. [1]'),
    )
    const result = await askKb({ question: 'any Superfund sites in Fulton County?', client, index: withSource })
    expect(result.places).toHaveLength(1)
    expect(result.places[0]).toMatchObject({ slug: 'epa-superfund-npl', count: 3, place: 'Fulton County, GA' })
    expect(result.toolCalls).toBe(1)
    // The source we actually read is in the list whether or not it was cited.
    expect(result.sources.some(s => s.slug === 'epa-superfund-npl' && s.kind === 'source')).toBe(true)
  })

  it('allows one fetch per question and tells the model to answer with what it has', async () => {
    const withSource = await withSources()
    const { client } = stubClient(
      placeToolTurn({ source: 'epa-superfund-npl', geoid: '13121' }, 'p1'),
      placeToolTurn({ source: 'epa-superfund-npl', geoid: '47157' }, 'p2'),
      textTurn('Three sites. [1]'),
    )
    const result = await askKb({ question: 'superfund near two counties?', client, index: withSource })
    expect(result.places).toHaveLength(1)
    expect(MAX_PLACE_FETCHES).toBe(1)
    expect(result.toolCalls).toBe(2) // the refused one still counted as a call
  })

  it('shows the model at most twenty rows of a slice', () => {
    expect(PLACE_SAMPLE_ROWS).toBe(20)
  })
})

// --- Place context (P5-58) ---------------------------------------------------

describe('askKb with placeContext (P5-58)', () => {
  const FINDINGS = [
    {
      slug: 'epa-superfund-npl',
      title: 'EPA Superfund NPL sites',
      href: '/library/epa-superfund-npl?place=g13121',
      text: 'US EPA — 3 results within 5 miles of 123 Peach St.',
    },
    {
      slug: 'county:13121',
      title: 'Fulton County, Georgia — county numbers',
      href: '/compare?counties=13121&layers=pct_Black',
      text: 'Percent Black: 44.5% (higher better)',
    },
  ]

  it('numbers the findings first, ahead of everything retrieval found', async () => {
    const { client, create } = stubClient(textTurn('Three sites are within five miles [1], in a county that is 44.5% Black [2].'))
    const result = await askKb({
      question: 'What are the environmental and land risks for 123 Peach St? Answer as a short report.',
      client,
      index,
      placeContext: FINDINGS,
    })
    const sent = create.mock.calls[0][0].messages[0].content as string
    expect(sent).toContain('[1] EPA Superfund NPL sites (place)')
    expect(sent).toContain('[2] Fulton County, Georgia — county numbers (place)')
    expect(sent).toContain('3 results within 5 miles')
    // Citations resolve to the report's own sections, with the hrefs the page
    // uses for its anchors.
    expect(result.sources.slice(0, 2)).toEqual([
      expect.objectContaining({ n: 1, slug: 'epa-superfund-npl', href: '/library/epa-superfund-npl?place=g13121', cited: true }),
      expect.objectContaining({ n: 2, slug: 'county:13121', href: '/compare?counties=13121&layers=pct_Black', cited: true }),
    ])
  })

  it('turns the tool loop off: the report already ran every fetch', async () => {
    const { client, create } = stubClient(
      // A model that tried to query anyway would get a second round without
      // placeContext; with the tools withdrawn it never gets the chance.
      toolTurn({ slug: 'organizations' }),
      textTurn('Never reached.'),
    )
    await askKb({ question: 'risks?', client, index, placeContext: FINDINGS })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].tools).toBeUndefined()
  })

  it('leaves the ordinary ask alone — tools are still offered without it', async () => {
    const { client, create } = stubClient(textTurn('Year two moves to stewardship [1].'))
    await askKb({ question: 'what does the funding strategy say about year two?', client, index })
    expect(create.mock.calls[0][0].tools).toHaveLength(3)
  })

  it('still counts what retrieval read, so the page can say so', async () => {
    const { client } = stubClient(textTurn('Nothing much [1].'))
    const result = await askKb({ question: 'risks near the farm?', client, index, placeContext: FINDINGS })
    expect(result.counts).toBeDefined()
    expect(result.toolCalls).toBe(0)
  })
})

describe('placeChunk', () => {
  it('makes a finding look exactly like a retrieved excerpt, kind "place"', () => {
    const chunk = placeChunk({ slug: 'x', title: 'T', href: '/h', text: 'body' }, 0)
    expect(chunk).toMatchObject({ slug: 'x', kind: 'place', title: 'T', href: '/h', text: 'body', layerId: null })
    // Never scored: it was given, not retrieved.
    expect(chunk.tf.size).toBe(0)
    expect(chunk.titleTerms.size).toBe(0)
  })
})

// --- Looking at a link (P5-59) -----------------------------------------------

const { setInspectDefaults, resetInspectDefaults } = await import('./linkInspect.js')
const inspectFixtures = await import('../testutils/fixtures/inspect/index.js')

/** A turn that calls inspect_link, in the shape the loop reads. */
function inspectToolTurn(input: Record<string, unknown>, id = 'i1'): Anthropic.Messages.Message {
  usageCounter++
  return {
    id: `msg_${usageCounter}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'tool_use', id, name: 'inspect_link', input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 30 },
  } as unknown as Anthropic.Messages.Message
}

describe('askKb can look at a link (P5-59)', () => {
  afterEach(() => resetInspectDefaults())

  function fixtureNetwork(): void {
    setInspectDefaults({
      fetchImpl: (async (input: any) =>
        String(input).includes('returnCountOnly')
          ? inspectFixtures.jsonProbe({ count: 1337 })
          : inspectFixtures.jsonProbe(inspectFixtures.ARCGIS_LAYER)) as unknown as typeof fetch,
      lookup: inspectFixtures.publicLookup,
    })
  }

  it('hands the model the classification, the columns and the plan', async () => {
    fixtureNetwork()
    const outcome = await runInspectLink({
      url: 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0',
    })
    expect('text' in outcome).toBe(true)
    if (!('text' in outcome)) return
    expect(outcome.text).toContain('ArcGIS point layer')
    expect(outcome.text).toContain('STCOFIPS')
    expect(outcome.text).toContain('fetch-on-demand')
  })

  it('returns a readable error rather than throwing', async () => {
    expect(await runInspectLink({})).toEqual({ error: 'Give a public http(s) URL to look at.' })
    setInspectDefaults({ fetchImpl: (async () => { throw new Error('nope') }) as unknown as typeof fetch, lookup: inspectFixtures.publicLookup })
    const outcome = await runInspectLink({ url: 'https://gone.example/x.csv' })
    // An unreachable link is an ANSWER, not a tool failure.
    expect('text' in outcome).toBe(true)
  })

  it('allows one link per question and says so on the second', async () => {
    fixtureNetwork()
    const url = 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0'
    const { client } = stubClient(
      inspectToolTurn({ url }, 'i1'),
      inspectToolTurn({ url }, 'i2'),
      textTurn('It is an ArcGIS point layer. [1]'),
    )
    const result = await askKb({ question: 'what is this link?', client, index: await withSources() })
    expect(MAX_LINK_INSPECTIONS).toBe(1)
    // Both calls counted; the second was refused rather than run.
    expect(result.toolCalls).toBe(2)
  })

  it('is offered to the model alongside the other tools', () => {
    expect(INSPECT_LINK_TOOL.name).toBe('inspect_link')
    expect(INSPECT_LINK_TOOL.description).toMatch(/creates nothing/i)
  })
})
