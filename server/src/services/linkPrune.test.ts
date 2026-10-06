import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * P5-61's model pass. The client is a stub, so what is asserted is the half
 * that has to be right whatever the model says: what it is shown, what
 * survives validation, and — the rule that matters most — that a stored URL is
 * always one WE harvested, never text the model wrote.
 *
 * The page is somebody else's writing, so the answer about it is data, not an
 * instruction, and it is validated exactly as strictly as any other input.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'

const {
  pruneLinks,
  unrankedLinks,
  roleForCandidate,
  parseKeptLinks,
  buildPruneUserMessage,
  cleanProse,
  foldAccessNotes,
  isEvidenceSentence,
  looksLikeMachineEndpoint,
  correctedRole,
  isDirectoryListing,
  isGeographyFolder,
  rankDirectoryLinks,
  finishSelection,
  preferenceWords,
  matchesPreference,
  parseProse,
  KEPT_LINKS_MAX,
  UNRANKED_LINKS_MAX,
  PRUNE_TEXT_CHARS,
  REASON_MAX_CHARS,
  DROPPED_MAX,
} = await import('./linkPrune.js')
type AnthropicLike = import('./askKb.js').AnthropicLike
type LinkCandidate = import('./linkHarvest.js').LinkCandidate

function textTurn(text: string, usage = { input_tokens: 900, output_tokens: 120 }): Anthropic.Messages.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Messages.Message
}

function stubClient(turn: Anthropic.Messages.Message | Error): { client: AnthropicLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn()
  if (turn instanceof Error) create.mockRejectedValue(turn)
  else create.mockResolvedValue(turn)
  return { client: { messages: { create } } as unknown as AnthropicLike, create }
}

/** A page's worth of candidates: one real file, one API, and four that are
 *  navigation dressed up enough to have been harvested. */
const CANDIDATES: LinkCandidate[] = [
  { url: 'https://epd.example.gov/share?u=wells', label: 'Share this data', via: 'anchor-text' },
  { url: 'https://epd.example.gov/files/wells-2024.csv', label: 'county-level CSV file', kind: 'file', via: 'anchor', context: 'The full set of results is available as a county-level CSV file.' },
  { url: 'https://epd.example.gov/developers/wells', label: 'API documentation', via: 'anchor-text' },
  { url: 'https://api.example.gov/v1/wells', label: 'Query endpoint', via: 'anchor' },
  { url: 'https://epd.example.gov/data.json', label: 'data.json', via: 'dcat' },
  { url: 'https://epd.example.gov/programs/air', label: 'Air data', via: 'anchor-text' },
]

const GOOD = JSON.stringify({
  isDataset: true,
  links: [
    { index: 1, role: 'data-file', reason: 'The annual results file the page calls the full set of results.' },
    { index: 3, role: 'api', reason: 'The query endpoint the API paragraph points at.' },
    { index: 2, role: 'docs', reason: 'Documentation for that endpoint.' },
  ],
  provider: 'Georgia Environmental Protection Division',
  program: 'Private Well Testing Program',
  updateCadence: 'Once a year, each spring',
  license: 'Public domain',
  coverage: '2016 to 2024',
  geography: 'One row per sampled well',
  accessNotes: [
    { kind: 'download', text: 'A county-level CSV of every sampled well.', url: 'https://epd.example.gov/files/wells-2024.csv' },
    { kind: 'request', text: 'County health departments can email wells@epd.example.gov for raw lab reports.' },
  ],
  evidence: {
    updateCadence: 'Results are published once a year, each spring, covering the previous calendar year.',
    license: 'The codes are a work of the United States Government and are in the public domain.',
  },
})

const input = (over: Partial<Parameters<typeof pruneLinks>[0]> = {}) => ({
  url: 'https://epd.example.gov/programs/wells',
  title: 'Private Well Testing Program',
  text: 'The Environmental Protection Division has sampled private drinking-water wells since 2016.',
  candidates: CANDIDATES,
  ...over,
})

describe('pruneLinks with a model', () => {
  it('keeps only the data links, with the reason and role for each', async () => {
    const { client } = stubClient(textTurn(GOOD))
    const result = await pruneLinks(input(), { client })

    expect(result.pruned).toBe('model')
    expect(result.candidates).toBe(6)
    expect(result.links).toEqual([
      {
        url: 'https://epd.example.gov/files/wells-2024.csv',
        label: 'county-level CSV file',
        kind: 'file',
        role: 'data-file',
        // P5-62: the access note pointed at THIS link, so its words were
        // folded in here rather than stored a second time beside it.
        reason: 'The annual results file the page calls the full set of results. A county-level CSV of every sampled well.',
      },
      {
        url: 'https://api.example.gov/v1/wells',
        label: 'Query endpoint',
        role: 'api',
        reason: 'The query endpoint the API paragraph points at.',
      },
      {
        url: 'https://epd.example.gov/developers/wells',
        label: 'API documentation',
        role: 'docs',
        reason: 'Documentation for that endpoint.',
      },
    ])
    // The share link, the catalogue and the sibling programme are gone: this
    // is the whole reason the pass exists.
    expect(result.links.some(l => l.url.includes('/share'))).toBe(false)
    expect(result.links.some(l => l.url.includes('data.json'))).toBe(false)
  })

  it('reads the prose beside the links, keeping the sentence each field came from', async () => {
    const { client } = stubClient(textTurn(GOOD))
    const { prose } = await pruneLinks(input(), { client })

    expect(prose).toMatchObject({
      isDataset: true,
      provider: 'Georgia Environmental Protection Division',
      updateCadence: 'Once a year, each spring',
      license: 'Public domain',
      coverage: '2016 to 2024',
    })
    expect(prose!.evidence?.updateCadence).toMatch(/published once a year/)
    // P5-62: the download note named a link we kept, so it lives on that
    // link's reason now; only the "email us" note has nowhere else to be.
    expect(prose!.accessNotes).toEqual([
      { kind: 'request', text: 'County health departments can email wells@epd.example.gov for raw lab reports.' },
    ])
  })

  it('shows the model the page and the numbered candidates, and nothing else', async () => {
    const { client, create } = stubClient(textTurn(GOOD))
    await pruneLinks(input({ text: 'Z'.repeat(PRUNE_TEXT_CHARS * 2) }), { client })
    const body = String(create.mock.calls[0][0].messages[0].content)

    expect(body).toContain('[1] https://epd.example.gov/files/wells-2024.csv')
    expect(body).toContain('nearby text: "The full set of results is available as a county-level CSV file."')
    expect(body).toContain('looks like: file')
    // Capped, however long the page is.
    expect((body.match(/Z/g) ?? []).length).toBe(PRUNE_TEXT_CHARS)
    // And told, in the prompt, to answer with indexes rather than addresses.
    expect(body).toMatch(/do not write URLs/i)
  })

  describe('the answer is validated as strictly as any other input', () => {
    const prune = async (payload: unknown) => {
      const { client } = stubClient(textTurn(typeof payload === 'string' ? payload : JSON.stringify(payload)))
      return pruneLinks(input(), { client })
    }

    it('drops an index that is not in the candidate set', async () => {
      const result = await prune({
        links: [
          { index: 1, role: 'data-file', reason: 'real' },
          { index: 99, role: 'data-file', reason: 'not a candidate' },
          { index: -1, role: 'api', reason: 'not a candidate either' },
          { index: 'two', role: 'api', reason: 'not even a number' },
        ],
      })
      expect(result.links.map(l => l.url)).toEqual(['https://epd.example.gov/files/wells-2024.csv'])
    })

    it('never stores a URL the model wrote, only one we harvested', async () => {
      const result = await prune({
        links: [{ index: 1, url: 'https://evil.example/steal.csv', role: 'data-file', reason: 'swapped' }],
      })
      // The index decides the address; a `url` in the answer is ignored.
      expect(result.links[0].url).toBe('https://epd.example.gov/files/wells-2024.csv')
    })

    it('drops an entry with an unknown role, a missing reason or an over-long one', async () => {
      const result = await prune({
        links: [
          { index: 0, role: 'the-good-one', reason: 'invented role' },
          { index: 2, role: 'docs' },
          { index: 3, role: 'api', reason: 'x'.repeat(REASON_MAX_CHARS + 50) },
          { index: 1, role: 'data-file', reason: 'kept' },
        ],
      })
      // The over-long reason is TRIMMED (it is the model's own words about a
      // link we harvested); the other two lose the entry. P5-63 then stores
      // them most-queryable-first, so the file leads and the api follows.
      expect(result.links.map(l => l.role)).toEqual(['data-file', 'api'])
      expect(result.links.find(l => l.role === 'api')!.reason).toHaveLength(REASON_MAX_CHARS)
    })

    it('keeps one entry per link and stops at the cap', async () => {
      const many = Array.from({ length: 30 }, (_, i) => ({ url: `https://x.example/${i}.csv`, via: 'anchor' as const }))
      const { client } = stubClient(
        textTurn(JSON.stringify({ links: many.map((_, i) => ({ index: i, role: 'data-file', reason: `file ${i}` })) })),
      )
      const result = await pruneLinks(input({ candidates: many }), { client })
      expect(result.links).toHaveLength(KEPT_LINKS_MAX)

      const twice = await prune({
        links: [
          { index: 1, role: 'data-file', reason: 'once' },
          { index: 1, role: 'api', reason: 'twice' },
        ],
      })
      expect(twice.links).toHaveLength(1)
      expect(twice.links[0].reason).toBe('once')
    })

    it('drops an access note pointing somewhere the page never linked', async () => {
      const result = await prune({
        accessNotes: [
          { kind: 'download', text: 'Get the file', url: 'https://elsewhere.example/file.csv' },
          { kind: 'nonsense', text: 'Unknown kind' },
          { kind: 'viewer', text: 'A map viewer', url: 'https://epd.example.gov/data.json' },
        ],
      })
      // The invented address is dropped; the note itself survives without one.
      expect(result.prose?.accessNotes).toEqual([
        { kind: 'download', text: 'Get the file' },
        { kind: 'viewer', text: 'A map viewer', url: 'https://epd.example.gov/data.json' },
      ])
    })

    it('drops evidence for a field it did not fill in', async () => {
      const sentence = 'The data are a work of the US Government and are in the public domain.'
      const result = await prune({ license: 'Public domain', evidence: { license: sentence, coverage: 'nowhere' } })
      expect(result.prose?.evidence).toEqual({ license: sentence })
    })

    it('keeps "none of these is the data" as an answer, rather than falling back', async () => {
      const result = await prune({ isDataset: false, links: [] })
      expect(result.links).toEqual([])
      expect(result.pruned).toBe('model')
      expect(result.prose?.isDataset).toBe(false)
    })

    it('falls back when the answer is not JSON at all', async () => {
      const result = await prune('I am not able to help with that.')
      expect(result.pruned).toBe('unranked')
    })
  })
})

describe('with no model to ask', () => {
  it('keeps the candidates by URL shape, capped, and says they were not ranked', async () => {
    const { client } = stubClient(new Error('401 authentication_error'))
    const result = await pruneLinks(input(), { client })

    expect(result.pruned).toBe('unranked')
    expect(result.candidates).toBe(6)
    expect(result.links.length).toBeLessThanOrEqual(UNRANKED_LINKS_MAX)
    expect(result.links[0].reason).toMatch(/nobody read the page/i)
  })

  it('ranks service layers over files over APIs over docs', () => {
    const candidates: LinkCandidate[] = [
      { url: 'https://x.example/docs/guide', via: 'anchor-text' },
      { url: 'https://x.example/api/rows.json', kind: 'socrata', via: 'anchor' },
      { url: 'https://x.example/f/data.csv', kind: 'file', via: 'anchor' },
      { url: 'https://x.example/rest/services/A/FeatureServer/0', kind: 'arcgis-layer', via: 'anchor' },
      { url: 'https://x.example/about', via: 'anchor-text' },
    ]
    expect(unrankedLinks(candidates).map(l => l.role)).toEqual(['service-layer', 'data-file', 'api', 'docs', 'landing'])
  })

  it('reads a role off a URL shape when nobody has classified it', () => {
    expect(roleForCandidate({ url: 'https://x.example/a/FeatureServer/2', kind: 'arcgis-layer', via: 'anchor' })).toBe('service-layer')
    expect(roleForCandidate({ url: 'https://x.example/resource/ab12-cd34.json', via: 'anchor' })).toBe('api')
    expect(roleForCandidate({ url: 'https://x.example/download/2024', via: 'anchor' })).toBe('data-file')
    expect(roleForCandidate({ url: 'https://x.example/developer/guide', via: 'anchor-text' })).toBe('docs')
    expect(roleForCandidate({ url: 'https://x.example/programs/wells', via: 'anchor-text' })).toBe('landing')
  })

  it('has nothing to say about a page with no candidates', async () => {
    const { client } = stubClient(textTurn(GOOD))
    expect(await pruneLinks(input({ candidates: [] }), { client })).toEqual({ links: [], candidates: 0, pruned: 'unranked' })
  })
})

describe('parseKeptLinks and cleanProse, read back off a manifest', () => {
  it('re-validates a stored prose block the way it was written', () => {
    expect(
      cleanProse({
        provider: '  Georgia EPD  ',
        license: 'Public domain',
        coverage: 12345,
        accessNotes: [
          { kind: 'api', text: 'An endpoint', url: 'http://insecure.example/x' },
          { kind: 'api', text: '' },
        ],
        evidence: { license: 'These data are in the public domain and may be reused freely.', provider: '' },
        isDataset: true,
      }),
    ).toEqual({
      provider: 'Georgia EPD',
      license: 'Public domain',
      accessNotes: [{ kind: 'api', text: 'An endpoint' }],
      evidence: { license: 'These data are in the public domain and may be reused freely.' },
      isDataset: true,
    })
    expect(cleanProse(null)).toBeNull()
    expect(cleanProse({ nonsense: 1 })).toBeNull()
  })

  it('turns an index into the candidate at that index and nothing else', () => {
    expect(parseKeptLinks({ links: [{ index: 1, role: 'data-file', reason: 'the file' }] }, CANDIDATES)).toEqual([
      {
        url: 'https://epd.example.gov/files/wells-2024.csv',
        label: 'county-level CSV file',
        kind: 'file',
        role: 'data-file',
        reason: 'the file',
      },
    ])
    expect(parseKeptLinks({}, CANDIDATES)).toEqual([])
    expect(parseKeptLinks({ links: 'nope' }, CANDIDATES)).toEqual([])
  })
})

describe('the budget', () => {
  it('bills the tokens to whoever caused the look, and releases them on failure', async () => {
    const { getUsageSnapshot } = await import('../middleware/budget.js')
    const before = getUsageSnapshot().totalTokens
    const { client } = stubClient(textTurn(GOOD, { input_tokens: 900, output_tokens: 120 }))
    await pruneLinks(input(), { client, clientIp: '203.0.113.7' })
    expect(getUsageSnapshot().totalTokens - before).toBe(1020)

    const after = getUsageSnapshot().totalTokens
    await pruneLinks(input(), { client: stubClient(new Error('boom')).client, clientIp: '203.0.113.7' })
    expect(getUsageSnapshot().totalTokens).toBe(after)
  })
})

/**
 * Why a fallback happened — the round-two fix.
 *
 * Found live on 2026-09-06: an EPA page came back `unranked` on a server with
 * a key configured, and NOTHING was logged. "Unranked" with no reason is a bug
 * report nobody can act on, so every path that ends at the static fallback now
 * names itself once in the log and once on the result.
 */
describe('every fallback says why', () => {
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})

  it('names the token cap when the answer was cut off mid-JSON', async () => {
    const spy = warn()
    // Exactly what the live failure looked like: a well-formed answer that
    // stops in the middle, so the JSON never closes.
    const truncated = '{"isDataset": true, "links": [{"index": 1, "role": "data-file", "reason": "The annual res'
    const message = textTurn(truncated)
    ;(message as any).stop_reason = 'max_tokens'
    const result = await pruneLinks(input(), { client: stubClient(message).client, label: 'epa-frs' })

    expect(result.pruned).toBe('unranked')
    expect(result.pruneError).toMatch(/cut off at the \d+-token cap/)
    expect(result.pruneError).toMatch(/LIBRARY_PRUNE_MAX_TOKENS/)
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[link-prune\] epa-frs: the answer was cut off/))
    spy.mockRestore()
  })

  it('tells a truncated answer apart from one that ignored the schema', async () => {
    const spy = warn()
    const result = await pruneLinks(input(), { client: stubClient(textTurn('I cannot help with that.')).client, label: 'x' })
    expect(result.pruneError).toBe('the answer was not JSON')
    // P5-75: the model was there and answered, so this is not an availability
    // problem and must not send an admin to the billing page.
    expect(result.pruneErrorCode).toBeUndefined()
    expect(spy).toHaveBeenCalledWith('[link-prune] x: the answer was not JSON')
    spy.mockRestore()
  })

  it('passes an SDK failure through in words, not as a stack', async () => {
    const spy = warn()
    const rateLimited: any = new Error('429 rate_limit_error')
    rateLimited.status = 429
    const result = await pruneLinks(input(), { client: stubClient(rateLimited).client, label: 'y' })
    expect(result.pruneError).toBe('the model was rate-limited')
    expect(result.pruneErrorCode).toBe('rate-limited')
    expect(spy).toHaveBeenCalledWith('[link-prune] y: the model was rate-limited')
    spy.mockRestore()
  })

  it('says so when no key is configured at all', async () => {
    const spy = warn()
    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const result = await pruneLinks(input(), { label: 'z' })
      expect(result.pruneError).toBe('no ANTHROPIC_API_KEY is configured')
      expect(result.pruneErrorCode).toBe('no-key')
      expect(spy).toHaveBeenCalledWith('[link-prune] z: no ANTHROPIC_API_KEY is configured')
    } finally {
      process.env.ANTHROPIC_API_KEY = key
      spy.mockRestore()
    }
  })

  it('a successful pass carries no reason at all', async () => {
    const result = await pruneLinks(input(), { client: stubClient(textTurn(GOOD)).client })
    expect(result.pruneError).toBeUndefined()
    expect(result.pruneErrorCode).toBeUndefined()
  })

  it('tells a refused key apart from a missing one, on the entry (P5-75)', async () => {
    const spy = warn()
    const refused: any = new Error('authentication_error')
    refused.status = 401
    const result = await pruneLinks(input(), { client: stubClient(refused).client, label: 'billing' })
    expect(result.pruneError).toBe('the API key was refused')
    expect(result.pruneErrorCode).toBe('refused')
    spy.mockRestore()
  })
})

/**
 * Shapes a model really produces. Refusing these cost a page its whole prune
 * down a path that said nothing, so each is now accepted on its own terms.
 */
describe('the answer is read however the model wrapped it', () => {
  const prune = async (raw: string) => pruneLinks(input(), { client: stubClient(textTurn(raw)).client })

  it('unwraps a single-key wrapper', async () => {
    const wrapped = JSON.stringify({ result: JSON.parse(GOOD) })
    const result = await prune(wrapped)
    expect(result.pruned).toBe('model')
    expect(result.links.map(l => l.role)).toEqual(['data-file', 'api', 'docs'])
    expect(result.prose?.provider).toBe('Georgia Environmental Protection Division')
  })

  it('accepts a bare array of link entries', async () => {
    const result = await prune(JSON.stringify([{ index: 1, role: 'data-file', reason: 'the file' }]))
    expect(result.pruned).toBe('model')
    expect(result.links.map(l => l.url)).toEqual(['https://epd.example.gov/files/wells-2024.csv'])
  })

  it('still reads a plain object with no wrapper', async () => {
    expect((await prune(GOOD)).links).toHaveLength(3)
  })

  it('does not unwrap a real answer that happens to have one key', async () => {
    // `{"links": [...]}` is the answer, not a wrapper around one.
    const result = await prune(JSON.stringify({ links: [{ index: 1, role: 'data-file', reason: 'kept' }] }))
    expect(result.links).toHaveLength(1)
  })
})

describe('what the pass left out', () => {
  it('records the dropped URLs so the next reviewer can audit it', async () => {
    const result = await pruneLinks(input(), { client: stubClient(textTurn(GOOD)).client })
    expect(result.dropped).toEqual([
      'https://epd.example.gov/share?u=wells',
      'https://epd.example.gov/data.json',
      'https://epd.example.gov/programs/air',
    ])
  })

  it('caps the dropped list rather than storing a link tree after all', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ url: `https://x.example/${i}.csv`, via: 'anchor' as const }))
    const result = await pruneLinks(input({ candidates: many }), {
      client: stubClient(textTurn(JSON.stringify({ links: [{ index: 0, role: 'data-file', reason: 'the one' }] }))).client,
    })
    expect(result.dropped).toHaveLength(DROPPED_MAX)
  })
})

describe('a directory of data files is a data endpoint', () => {
  it('ranks a directory just below a file, above an API', () => {
    const candidates: LinkCandidate[] = [
      { url: 'https://x.example/docs/guide', via: 'anchor-text' },
      { url: 'https://x.example/api/rows.json', kind: 'socrata', via: 'anchor' },
      { url: 'https://www2.census.gov/geo/tiger/TIGER2025/', label: 'FTP Archive', via: 'directory' },
      { url: 'https://x.example/f/data.csv', kind: 'file', via: 'anchor' },
    ]
    expect(unrankedLinks(candidates).map(l => l.role)).toEqual(['data-file', 'directory', 'api', 'docs'])
  })

  it('reads a directory off its URL shape as well as its harvest source', () => {
    expect(roleForCandidate({ url: 'https://www2.census.gov/geo/tiger/TIGER2025/', via: 'anchor-text' })).toBe('directory')
    expect(roleForCandidate({ url: 'https://x.example/pub/shapefiles/', via: 'anchor' })).toBe('directory')
    // Not every trailing slash is a folder of data.
    expect(roleForCandidate({ url: 'https://x.example/about/', via: 'anchor-text' })).toBe('landing')
  })

  it('tells the model that a directory is the data, not navigation', () => {
    const body = buildPruneUserMessage(input())
    expect(body).toMatch(/directory.*folder, FTP archive, bulk-download index/i)
    expect(body).toMatch(/If the only route to the actual data is a listing of files, keep it/i)
  })
})

/**
 * P5-62: the five defects the hand-eval found, each with the fixture that
 * reproduces it.
 *
 * The eval was four real pages judged by eye, once. What it found was that
 * link SELECTION was good and everything downstream of it was not: roles
 * confused documentation with endpoints and viewers with APIs, `coverage`
 * repeated the cadence sentence, evidence was sometimes a table row, and the
 * access notes said again what the kept links already said. These are those
 * five, held still.
 */
describe('P5-62 · roles: an API is something a program can call', () => {
  /** The EPA FRS page, in miniature: three API DOCUMENTATION pages, one real
   *  query endpoint, one form. All five were kept as `api` by eye. */
  const EPA: LinkCandidate[] = [
    { url: 'https://www.epa.gov/frs/frs-rest-services', label: 'FRS REST Services', via: 'anchor-text' },
    { url: 'https://www.epa.gov/frs/frs-api-documentation', label: 'API documentation', via: 'anchor-text' },
    { url: 'https://data.epa.gov/efservice/frs_program_facility/state_code/GA/JSON', label: 'Envirofacts query', via: 'anchor' },
    { url: 'https://www.census.gov/cgi-bin/geo/shapefiles/index.php', label: 'Web interface', via: 'anchor-text' },
    { url: 'https://services.arcgis.com/org/arcgis/rest/services/FRS/FeatureServer/0', label: 'Feature layer', kind: 'arcgis-layer', via: 'anchor' },
  ]

  it('demotes an "api" that no program could call to docs, and keeps the real one', async () => {
    const { client } = stubClient(
      textTurn(
        JSON.stringify({
          links: [
            { index: 0, role: 'api', reason: 'The page calls this the REST service.' },
            { index: 1, role: 'api', reason: 'The API, according to the page.' },
            { index: 2, role: 'api', reason: 'The Envirofacts query endpoint.' },
            { index: 4, role: 'service-layer', reason: 'The hosted feature layer.' },
          ],
        }),
      ),
    )
    const result = await pruneLinks(input({ candidates: EPA }), { client })
    // P5-63 stores them in the order they are useful to us — service layer,
    // api, then the pages that merely describe them — rather than in whatever
    // order the model happened to write. The roles are the point of this test
    // and they are unchanged.
    expect(result.links.map(l => [l.url, l.role])).toEqual([
      ['https://services.arcgis.com/org/arcgis/rest/services/FRS/FeatureServer/0', 'service-layer'],
      // A URL a program really can call keeps the role it was given.
      ['https://data.epa.gov/efservice/frs_program_facility/state_code/GA/JSON', 'api'],
      // A page that DESCRIBES an endpoint is documentation, whatever it is called.
      ['https://www.epa.gov/frs/frs-rest-services', 'docs'],
      ['https://www.epa.gov/frs/frs-api-documentation', 'docs'],
    ])
  })

  it('knows a machine endpoint from a page about one', () => {
    const machine = [
      'https://data.example.gov/api/wells',
      'https://data.cdc.gov/resource/snkv-n8f6.json',
      'https://services.arcgis.com/x/arcgis/rest/services/A/FeatureServer/0/query?where=1%3D1',
      'https://api.census.gov/data/2023/acs/acs5',
      'https://gis.example.gov/geoserver/wfs?service=WFS&request=GetFeature',
      'https://www.ers.usda.gov/files/rucc2023.csv',
    ]
    for (const url of machine) expect([url, looksLikeMachineEndpoint(url)]).toEqual([url, true])

    const pages = [
      'https://www.epa.gov/frs/frs-rest-services',
      'https://www.epa.gov/frs/geospatial-data-download-service',
      'https://www.census.gov/programs-surveys/geography.html',
    ]
    for (const url of pages) expect([url, looksLikeMachineEndpoint(url)]).toEqual([url, false])
  })

  it('gives a query form the viewer role, not api', async () => {
    const { client } = stubClient(
      textTurn(JSON.stringify({ links: [{ index: 3, role: 'api', reason: 'Pick a state and download the shapefile.' }] })),
    )
    const result = await pruneLinks(input({ candidates: EPA }), { client })
    expect(result.links[0].role).toBe('viewer')
  })

  it('ranks a viewer above docs when nobody read the page', () => {
    const candidates: LinkCandidate[] = [
      { url: 'https://x.example/developer/guide', via: 'anchor-text' },
      { url: 'https://www.census.gov/cgi-bin/geo/shapefiles/index.php', label: 'Web interface', via: 'anchor-text' },
      { url: 'https://x.example/f/data.csv', kind: 'file', via: 'anchor' },
    ]
    expect(unrankedLinks(candidates).map(l => l.role)).toEqual(['data-file', 'viewer', 'docs'])
  })

  it('tells the model what an api is and what a viewer is', () => {
    const body = buildPruneUserMessage(input())
    expect(body).toMatch(/a MACHINE endpoint: calling the address returns data/i)
    expect(body).toMatch(/A page ABOUT an endpoint is docs, never api/i)
    expect(body).toMatch(/"viewer" — a query form, map viewer, search tool or web interface/i)
  })
})

describe('P5-62 · coverage must not repeat the cadence sentence', () => {
  const cadence = 'The codes are updated once every ten years, after each decennial census.'

  it('drops a coverage that is the cadence sentence again', async () => {
    const { client } = stubClient(textTurn(JSON.stringify({ updateCadence: cadence, coverage: cadence })))
    const { prose } = await pruneLinks(input(), { client })
    expect(prose?.updateCadence).toBe(cadence)
    expect(prose?.coverage).toBeUndefined()
  })

  it('folds whitespace and case before deciding it is the same claim', async () => {
    const { client } = stubClient(
      textTurn(JSON.stringify({ updateCadence: 'Updated annually', coverage: '  updated   ANNUALLY.  ' })),
    )
    const { prose } = await pruneLinks(input(), { client })
    expect(prose?.coverage).toBeUndefined()
  })

  it('drops a coverage that just repeats the geography', async () => {
    const { client } = stubClient(textTurn(JSON.stringify({ geography: 'One row per county', coverage: 'one row per county' })))
    const { prose } = await pruneLinks(input(), { client })
    expect(prose?.coverage).toBeUndefined()
    expect(prose?.geography).toBe('One row per county')
  })

  it('keeps a coverage that really says something else', async () => {
    const { client } = stubClient(
      textTurn(JSON.stringify({ updateCadence: cadence, coverage: '2023 codes for all 3,143 US counties.' })),
    )
    const { prose } = await pruneLinks(input(), { client })
    expect(prose?.coverage).toBe('2023 codes for all 3,143 US counties.')
  })

  it('drops the repeat on the way back off a manifest too', () => {
    expect(cleanProse({ updateCadence: 'Weekly', coverage: 'weekly' })).toEqual({ updateCadence: 'Weekly' })
  })

  it('tells the model the four fields are different things', () => {
    const body = buildPruneUserMessage(input())
    expect(body).toMatch(/These four are DIFFERENT things and must not repeat each other/i)
    expect(body).toMatch(/coverage — the years or the extent the data spans\. Example:/i)
    expect(body).toMatch(/Do not put the update sentence in coverage/i)
  })
})

describe('P5-62 · evidence has to be a sentence', () => {
  /** What the EPA page really produced for `geography`: a row out of the
   *  download table, with no verb and no full stop in it. */
  const TABLE_ROW = 'National FRS Interests File FRS_Interests_Download ZIP 47 MB'

  it('drops a table-row dump, a fragment and a bare heading', () => {
    expect(isEvidenceSentence(TABLE_ROW)).toBe(false)
    expect(isEvidenceSentence('in the public domain')).toBe(false)
    expect(isEvidenceSentence('Geospatial Data Download Service')).toBe(false)
  })

  it('keeps a real sentence, proper nouns and all', () => {
    expect(isEvidenceSentence('The Environmental Protection Agency publishes this file every week.')).toBe(true)
    expect(isEvidenceSentence('Rural-urban continuum codes are updated after each decennial census.')).toBe(true)
  })

  it('leaves the field but drops its unusable evidence', async () => {
    const { client } = stubClient(
      textTurn(
        JSON.stringify({
          geography: 'One row per facility',
          updateCadence: 'Weekly',
          evidence: {
            geography: TABLE_ROW,
            updateCadence: 'The FRS geospatial files are refreshed weekly and posted here.',
          },
        }),
      ),
    )
    const { prose } = await pruneLinks(input(), { client })
    // The claim survives — it is still marked inferred on the proposal — but
    // it goes to the reviewer without a quotation rather than with a fake one.
    expect(prose?.geography).toBe('One row per facility')
    expect(prose?.evidence).toEqual({ updateCadence: 'The FRS geospatial files are refreshed weekly and posted here.' })
  })

  it('holds a hand-edited manifest to the same rule', () => {
    expect(cleanProse({ license: 'Public domain', evidence: { license: 'Public Domain US Government Work' } })).toEqual({
      license: 'Public domain',
    })
  })

  it('asks the model for one complete sentence', () => {
    const body = buildPruneUserMessage(input())
    expect(body).toMatch(/ONE COMPLETE SENTENCE quoted from the page/i)
    expect(body).toMatch(/Never a table row, a heading, a file name or a fragment/i)
  })
})

describe('P5-62 · an access note that repeats a kept link is folded into it', () => {
  const answer = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      links: [{ index: 1, role: 'data-file', reason: 'The county-level results file.' }],
      accessNotes: [
        { kind: 'download', text: 'A CSV of every sampled well, by county.', url: 'https://epd.example.gov/files/wells-2024.csv' },
        { kind: 'request', text: 'Raw lab reports are available on request.' },
      ],
      ...over,
    })

  it('stores the claim once, on the link', async () => {
    const { client } = stubClient(textTurn(answer()))
    const result = await pruneLinks(input(), { client })
    expect(result.links[0].reason).toBe('The county-level results file. A CSV of every sampled well, by county.')
    expect(result.prose?.accessNotes).toEqual([{ kind: 'request', text: 'Raw lab reports are available on request.' }])
  })

  it('does not say the same words twice on one link', async () => {
    const { client } = stubClient(
      textTurn(
        JSON.stringify({
          links: [{ index: 1, role: 'data-file', reason: 'A CSV of every sampled well, by county.' }],
          accessNotes: [
            { kind: 'download', text: 'A CSV of every sampled well, by county.', url: 'https://epd.example.gov/files/wells-2024.csv' },
          ],
        }),
      ),
    )
    const result = await pruneLinks(input(), { client })
    expect(result.links[0].reason).toBe('A CSV of every sampled well, by county.')
    expect(result.prose?.accessNotes).toBeUndefined()
  })

  it('keeps a note that names a link the pass did NOT keep', async () => {
    const { client } = stubClient(
      textTurn(
        JSON.stringify({
          links: [{ index: 1, role: 'data-file', reason: 'The results file.' }],
          accessNotes: [{ kind: 'viewer', text: 'A map viewer.', url: 'https://epd.example.gov/data.json' }],
        }),
      ),
    )
    const result = await pruneLinks(input(), { client })
    expect(result.links[0].reason).toBe('The results file.')
    expect(result.prose?.accessNotes).toEqual([{ kind: 'viewer', text: 'A map viewer.', url: 'https://epd.example.gov/data.json' }])
  })

  it('trims the folded reason to the same cap as any other', async () => {
    const { client } = stubClient(
      textTurn(
        JSON.stringify({
          links: [{ index: 1, role: 'data-file', reason: 'x'.repeat(REASON_MAX_CHARS - 20) }],
          accessNotes: [{ kind: 'download', text: 'y'.repeat(200), url: 'https://epd.example.gov/files/wells-2024.csv' }],
        }),
      ),
    )
    const result = await pruneLinks(input(), { client })
    expect(result.links[0].reason).toHaveLength(REASON_MAX_CHARS)
  })

  it('tells the model not to say it twice', () => {
    expect(buildPruneUserMessage(input())).toMatch(/Do not repeat in a note what you already said in a link’s reason/i)
  })
})

/**
 * P5-62, round two: what the first scored run itself turned up.
 *
 * Precision came back at 69% against a recall of 92% — the pass was keeping
 * plenty, including things the labels call distractors. Four kinds, all of
 * them addressable in the prompt: navigation whose text says "Data", a file
 * the page itself calls a sample, the same file listing re-sorted, and — the
 * one worth two extra sentences — a programme overview that NAMES datasets
 * being read as a dataset (isDataset was 10.7 of 14).
 */
describe('P5-62 · what the first scored run said to fix', () => {
  const body = () => buildPruneUserMessage(input())

  it('says a page that only points at datasets is not one', () => {
    expect(body()).toMatch(/A page that merely names or links to datasets published elsewhere is not itself a dataset/i)
    expect(body()).toMatch(/a press release, a programme overview/i)
  })

  it('says an empty answer is a good answer', () => {
    expect(body()).toMatch(/Keeping NOTHING is a good answer/i)
  })

  it('names the three distractors the run kept', () => {
    expect(body()).toMatch(/Do not keep a link because its text contains the word "data"/i)
    expect(body()).toMatch(/calls a sample, an example or a template/i)
    expect(body()).toMatch(/the same listing again under a different sort or view/i)
  })
})

/**
 * P5-63 — the taxonomy in the page-reading pass, and the determinism the
 * P5-62 eval said was missing.
 *
 * The eval's clearest defect: the Census TIGER directory offered fifty-odd
 * equally good folders against a twelve-link cap, and the model kept a
 * different dozen on each of three runs (agreement 0.60). There is nothing to
 * READ on that page — it is `<a href="COUNTY/">COUNTY/</a>` fifty times — so
 * the ranking IS the answer, and it is the same answer every time.
 */
describe('P5-63 · the page’s topic and tags', () => {
  it('asks for a topic from the taxonomy and tags from the suggested list', () => {
    const message = buildPruneUserMessage({ url: 'https://x.gov', text: 'A page.', candidates: CANDIDATES })
    expect(message).toContain('"topic": "…", "tags": ["…"]')
    expect(message).toContain('water (Water)')
    expect(message).toContain('transportation (Getting to work)')
    expect(message).toContain('heirs-property')
    // And the order to work down when more links deserve a place than fit.
    expect(message).toMatch(/prefer them IN THIS ORDER/)
  })

  it('keeps a topic only when it is one, and normalises tags through the aliases', () => {
    const prose = parseProse(
      { topic: 'Water', tags: ['Flooding', 'flood', 'environmental-risk', 'brand-new-word'] },
      CANDIDATES,
    )
    expect(prose.topic).toBe('water')
    expect(prose.tags).toEqual(['flood', 'environmental-risk', 'brand-new-word'])
  })

  it('drops a topic that is a purpose, or a word the taxonomy does not know', () => {
    // "research" is what a document is FOR. A page on somebody's website is
    // not for anything of ours, so it is the wrong answer to this question.
    expect(parseProse({ topic: 'research' }, CANDIDATES).topic).toBeUndefined()
    expect(parseProse({ topic: 'kitchen-sink' }, CANDIDATES).topic).toBeUndefined()
  })

  it('reads them back off a stored manifest with the same rules', () => {
    expect(cleanProse({ topic: 'Hazards', tags: ['Flooding'] })).toMatchObject({ topic: 'hazards', tags: ['flood'] })
    expect(cleanProse({ topic: 'ideas' })).toBeNull()
  })
})

describe('P5-63 · a file index is ranked, not read', () => {
  const tiger = (name: string): LinkCandidate => ({
    url: `https://www2.census.gov/geo/tiger/TIGER2025/${name}/`,
    label: `${name}/`,
    via: 'directory',
  })
  const TIGER: LinkCandidate[] = [
    // The distractors: the page itself under four different sorts, and the
    // parent directory.
    { url: 'https://www2.census.gov/geo/tiger/TIGER2025/?C=N;O=D', label: 'Name', via: 'directory' },
    { url: 'https://www2.census.gov/geo/tiger/', label: 'Parent Directory', via: 'directory' },
    ...['ADDR', 'ADDRFEAT', 'AIANNH', 'AREAWATER', 'EDGES', 'FACES', 'RAILS', 'ROADS', 'TBG', 'TTRACT'].map(tiger),
    ...['COUNTY', 'TRACT', 'BG', 'STATE', 'PLACE', 'COUSUB', 'ZCTA520', 'TABBLOCK20'].map(tiger),
  ]

  it('knows a folder that names a geography we file by from one that does not', () => {
    for (const name of ['COUNTY', 'TRACT', 'BG', 'STATE', 'PLACE', 'COUSUB', 'ZCTA520', 'TABBLOCK20']) {
      expect(isGeographyFolder(`https://x.gov/T/${name}/`), name).toBe(true)
    }
    // Tribal variants are not the thing itself; neither is a road, point
    // landmarks (`POINTLM`) or a block-suffix lookup (`TABBLOCKSUFX`).
    for (const name of ['TBG', 'TTRACT', 'ROADS', 'AREAWATER', 'EDGES', 'POINTLM', 'TABBLOCKSUFX']) {
      expect(isGeographyFolder(`https://x.gov/T/${name}/`), name).toBe(false)
    }
  })

  it('recognises a page whose links are mostly folders, and not a prose page with a download section', () => {
    expect(isDirectoryListing(TIGER)).toBe(true)
    expect(isDirectoryListing(CANDIDATES)).toBe(false)
  })

  it('keeps exactly the geography folders, alphabetically, and drops the page’s own sort links', () => {
    const links = rankDirectoryLinks(TIGER, 'https://www2.census.gov/geo/tiger/TIGER2025/')
    expect(links.map(l => l.url.split('/').filter(Boolean).pop())).toEqual([
      'BG',
      'COUNTY',
      'COUSUB',
      'PLACE',
      'STATE',
      'TABBLOCK20',
      'TRACT',
      'ZCTA520',
    ])
    expect(links.every(l => l.role === 'directory')).toBe(true)
    expect(links.some(l => l.url.includes('?C='))).toBe(false)
    expect(links.some(l => l.url === 'https://www2.census.gov/geo/tiger/')).toBe(false)
  })

  it('falls back to page order when a listing names no geography at all', () => {
    const plain: LinkCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      url: `https://x.gov/pub/folder${i}/`,
      via: 'directory' as const,
    }))
    const links = rankDirectoryLinks(plain, 'https://x.gov/pub/')
    expect(links).toHaveLength(10)
    expect(links[0].url).toBe('https://x.gov/pub/folder0/')
  })

  it('answers the same thing every run, and still reads the page’s prose', async () => {
    // Two different model answers about the links; the stored links are the
    // same, because the model was never asked about them.
    const answers = [
      JSON.stringify({ isDataset: true, provider: 'U.S. Census Bureau', links: [{ index: 2, role: 'directory', reason: 'whim' }] }),
      JSON.stringify({ isDataset: true, provider: 'U.S. Census Bureau', links: [{ index: 5, role: 'directory', reason: 'a different whim' }] }),
    ]
    const runs = []
    for (const answer of answers) {
      const { client, create } = stubClient(textTurn(answer))
      const result = await pruneLinks(
        { url: 'https://www2.census.gov/geo/tiger/TIGER2025/', text: 'Index of /geo/tiger/TIGER2025', candidates: TIGER },
        { client },
      )
      runs.push(result)
      // The candidate list is not serialised at all — the TIGER page alone was
      // twelve thousand input tokens of addresses nobody would pick from.
      const body = String(create.mock.calls[0][0].messages[0].content)
      expect(body).not.toContain('TABBLOCK20')
      expect(body).toContain('have already been chosen')
    }
    expect(runs[0].links.map(l => l.url)).toEqual(runs[1].links.map(l => l.url))
    expect(runs[0].linkSelection).toBe('ranked')
    // The pass still ran, and the prose still came back.
    expect(runs[0].pruned).toBe('model')
    expect(runs[0].prose?.provider).toBe('U.S. Census Bureau')
    // Everything not kept is recorded, so a reviewer can see what was left out.
    expect(runs[0].dropped?.length).toBeGreaterThan(0)
  })
})

describe('P5-63 · the deterministic finish', () => {
  const words = () => preferenceWords({ topic: 'hazards', tags: ['flood'] })

  it('prefers a link whose address or text carries one of the page’s own words', () => {
    expect(words()).toContain('flood')
    expect(words()).toContain('wildfire')
    expect(words()).toContain('site-selection')
    expect(matchesPreference({ url: 'https://x.gov/flood-zones.zip' }, words())).toBe(true)
    expect(matchesPreference({ url: 'https://x.gov/a.zip', label: 'Wildfire risk' }, words())).toBe(true)
    expect(matchesPreference({ url: 'https://x.gov/newsletter' }, words())).toBe(false)
  })

  it('stores the model’s links in one order however it wrote them', () => {
    const kept = [
      { url: CANDIDATES[2].url, role: 'docs' as const, reason: 'r' },
      { url: CANDIDATES[1].url, role: 'data-file' as const, reason: 'r' },
      { url: CANDIDATES[3].url, role: 'api' as const, reason: 'r' },
    ]
    const ordered = finishSelection(kept, CANDIDATES, {})
    expect(ordered.map(l => l.role)).toEqual(['data-file', 'api', 'docs'])
    // Same set in, same order out, whichever order it arrived in.
    expect(finishSelection([...kept].reverse(), CANDIDATES, {}).map(l => l.url)).toEqual(ordered.map(l => l.url))
  })

  it('tops the list up only when the cap was what stopped it, and only with the data the page is about', () => {
    const many: LinkCandidate[] = [
      ...Array.from({ length: 20 }, (_, i) => ({ url: `https://x.gov/flood/zone-${i}.zip`, via: 'anchor' as const })),
      { url: 'https://x.gov/flood/about', label: 'About flooding', via: 'anchor-text' as const },
      { url: 'https://x.gov/newsletter.pdf', via: 'anchor' as const },
    ]
    const one = [{ url: many[0].url, role: 'data-file' as const, reason: 'r' }]
    const filled = finishSelection(one, many, { topic: 'hazards', tags: ['flood'] })
    expect(filled).toHaveLength(KEPT_LINKS_MAX)
    // A page ABOUT flooding is not data, so it does not fill a slot.
    expect(filled.some(l => l.url === 'https://x.gov/flood/about')).toBe(false)
    expect(filled.some(l => l.url === 'https://x.gov/newsletter.pdf')).toBe(false)

    // "Kept nothing" is still a good answer on a navigation page.
    expect(finishSelection([], many, { topic: 'hazards' })).toEqual([])
    // And a short page is left exactly as the model answered it.
    expect(finishSelection(one, many.slice(0, 5), { topic: 'hazards' })).toHaveLength(1)
  })
})

describe('P7-7 · what the page says the data answers', () => {
  const ANSWER = 'Answers: which parcels sit within N miles of a transmission line.'
  const EVIDENCE = 'Each parcel record includes the distance to the nearest transmission corridor.'

  it('is asked for as a question, not as a restatement', () => {
    const message = buildPruneUserMessage({ url: 'https://x.gov', text: 'A page.', candidates: CANDIDATES })
    expect(message).toContain('"whatItAnswers": "Answers: …"')
    expect(message).toContain('naming a question this data can answer')
    expect(message).toContain('Never restate the title')
  })

  it('is kept with its evidence sentence', () => {
    const prose = parseProse({ whatItAnswers: ANSWER, evidence: { whatItAnswers: EVIDENCE } }, CANDIDATES)
    expect(prose.whatItAnswers).toBe(ANSWER)
    expect(prose.evidence).toEqual({ whatItAnswers: EVIDENCE })
  })

  it('is read back off a stored manifest by the same rules', () => {
    // The two key lists are one constant precisely so this cannot drift: a
    // field the write knows about and the read drops is a value that survives
    // a write and vanishes on the next look.
    expect(cleanProse({ whatItAnswers: `  ${ANSWER}  ` })).toEqual({ whatItAnswers: ANSWER })
    // Evidence for a field that did not survive is evidence for nothing.
    expect(cleanProse({ evidence: { whatItAnswers: EVIDENCE } })).toBeNull()
  })

  it('holds the sentence to the same quotation rule as every other claim', () => {
    // P5-62: a fragment is not something a reviewer can check against a page.
    expect(cleanProse({ whatItAnswers: ANSWER, evidence: { whatItAnswers: 'parcels' } })).toEqual({ whatItAnswers: ANSWER })
  })
})

describe('P7-10 · when the page says the data is from', () => {
  it('asks for the two dates, and keeps them apart from the cadence right above them', () => {
    const message = buildPruneUserMessage({ url: 'https://x.gov', text: 'A page.', candidates: CANDIDATES })
    expect(message).toContain('"covers": "…", "published": "…"')
    expect(message).toContain('the period the DATA describes')
    // The distinction this field pair lives or dies on: `updateCadence` is a
    // promise, `published` is a date.
    expect(message).toContain('"Updated annually" is a schedule, not a date')
  })

  it('canonicalises the spellings a portal page actually uses', () => {
    const prose = parseProse({ covers: '2019–2023', published: 'March 12, 2024' }, CANDIDATES)
    expect(prose.covers).toBe('2019/2023')
    expect(prose.published).toBe('2024-03-12')
  })

  it('drops a cadence that came back as a date, and its evidence with it', () => {
    // The model is asked twice not to do this; when it does anyway, a value
    // the grammar cannot read is dropped rather than stored as something a
    // legend would then print.
    const prose = parseProse(
      { updateCadence: 'every five years', published: 'every five years', evidence: { published: 'The data is refreshed every five years.' } },
      CANDIDATES,
    )
    expect(prose.published).toBeUndefined()
    expect(prose.evidence?.published).toBeUndefined()
    expect(prose.updateCadence).toBe('every five years')
  })

  it('is read back off a stored manifest by the same rules', () => {
    expect(cleanProse({ covers: ' 2026-10 ' })).toEqual({ covers: '2026-10' })
    expect(cleanProse({ published: 'recently' })).toBeNull()
  })

  it('keeps the evidence sentence, which is where the source’s own spelling lives', () => {
    const prose = cleanProse({
      published: '2024-03-12',
      evidence: { published: 'This dataset was last updated on March 12, 2024.' },
    })
    expect(prose?.evidence?.published).toBe('This dataset was last updated on March 12, 2024.')
  })
})
