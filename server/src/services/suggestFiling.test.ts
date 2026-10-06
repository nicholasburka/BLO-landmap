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
 * P5-47 suggestions. The Anthropic client is a stub, so what is asserted here
 * is the half that has to be right whatever the model says: what it is shown,
 * what survives validation, and — above all — that a suggestion is only ever
 * stored as a proposal.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { indexFileBackedEntry } = await import('./libraryCatalog.js')
const { CATEGORY_IDS, TOPIC_IDS, PURPOSE_IDS } = await import('./taxonomy.js')
const { getUsageSnapshot } = await import('../middleware/budget.js')
const {
  suggestForEntry,
  parseSuggestion,
  cleanTag,
  knownCategories,
  buildSuggestUserMessage,
  suggestMaxTokens,
  isSuggestionError,
  categoryMenu,
  SUGGEST_TEXT_CHARS,
  TITLE_MAX_CHARS,
  SUMMARY_MAX_CHARS,
} = await import('./suggestFiling.js')

type AnthropicLike = import('./askKb.js').AnthropicLike

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

function textTurn(text: string, usage = { input_tokens: 300, output_tokens: 40 }): Anthropic.Messages.Message {
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

const GOOD = JSON.stringify({
  title: 'Heirs property in the Black Belt',
  category: 'research',
  tags: ['heirs-property', 'land-loss'],
  summary: 'A 40-page study of heirs property across seven states.',
})

let fake: FakeS3
let dataDir: string

/** One incoming drop with a readable file, as a fetch or an upload leaves it. */
async function seedDrop(slug: string, file: string, body: string, meta: Record<string, unknown> = {}): Promise<void> {
  const fileKey = `library/incoming/${slug}/${file}`
  const metaKey = `library/incoming/${slug}/meta.json`
  const manifest = {
    title: 'example.org/report',
    category: '',
    status: 'needs-cataloging',
    tags: [],
    url: 'https://example.org/report',
    originalFilename: file,
    ...meta,
  }
  fake.seed(fileKey, body)
  fake.seed(metaKey, JSON.stringify(manifest, null, 2))
  await indexFileBackedEntry('incoming', slug, manifest, [
    { key: fileKey, size: Buffer.byteLength(body) },
    { key: metaKey, size: 100 },
  ])
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-suggest-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('validation', () => {
  const categories = [...CATEGORY_IDS]

  it('keeps a well-formed suggestion, stamped with when and by which model', () => {
    expect(parseSuggestion(GOOD, categories, 'claude-sonnet-5', 'T')).toEqual({
      title: 'Heirs property in the Black Belt',
      category: 'research',
      tags: ['heirs-property', 'land-loss'],
      summary: 'A 40-page study of heirs property across seven states.',
      at: 'T',
      model: 'claude-sonnet-5',
    })
  })

  it('reads the object out of a fenced or chatty answer', () => {
    const fenced = '```json\n' + GOOD + '\n```'
    expect(parseSuggestion(fenced, categories, 'm', 'T')?.category).toBe('research')
    expect(parseSuggestion(`Sure! ${GOOD} Hope that helps.`, categories, 'm', 'T')?.title).toBe('Heirs property in the Black Belt')
  })

  it('returns nothing at all for output that is not a JSON object', () => {
    for (const bad of ['', 'I could not read that document.', '[1,2,3]', '{oops', '{"title": }']) {
      expect(parseSuggestion(bad, categories, 'm', 'T'), bad).toBeNull()
    }
  })

  it('drops an unknown category rather than inventing one, keeping the rest', () => {
    const raw = JSON.stringify({ title: 'A study', category: 'miscellaneous', summary: 'Words.' })
    const parsed = parseSuggestion(raw, categories, 'm', 'T')
    expect(parsed).toMatchObject({ title: 'A study', summary: 'Words.' })
    expect(parsed?.category).toBeUndefined()
  })

  it('reads a category through the taxonomy aliases rather than dropping it on a spelling (P5-63)', () => {
    expect(parseSuggestion(JSON.stringify({ category: 'primary-sources' }), categories, 'm', 'T')?.category).toBe('research')
    expect(parseSuggestion(JSON.stringify({ category: 'Demographics' }), categories, 'm', 'T')?.category).toBe('demographic')
    // A caller that allows a narrower list still gets that list enforced.
    expect(parseSuggestion(JSON.stringify({ category: 'land' }), ['research'], 'm', 'T')).toBeNull()
  })

  it('normalises tags through the taxonomy aliases (P5-63)', () => {
    const raw = JSON.stringify({ tags: ['Flooding', 'flood', 'Environmental Risk'] })
    // `environmental-risk` is a cross-cutting tag, not an alias of the Environment topic.
    expect(parseSuggestion(raw, categories, 'm', 'T')?.tags).toEqual(['flood', 'environmental-risk'])
  })

  it('drops an over-long title or summary field by field', () => {
    const raw = JSON.stringify({
      title: 'x'.repeat(TITLE_MAX_CHARS + 1),
      summary: 'y'.repeat(SUMMARY_MAX_CHARS + 1),
      category: 'land',
    })
    expect(parseSuggestion(raw, categories, 'm', 'T')).toEqual({ category: 'land', at: 'T', model: 'm' })
  })

  it('normalises tags to lowercase kebab, drops the unusable, dedupes, and stops at six', () => {
    expect(cleanTag('Flood Risk')).toBe('flood-risk')
    expect(cleanTag('  land_loss  ')).toBe('land-loss')
    expect(cleanTag('já')).toBeNull()
    expect(cleanTag(42)).toBeNull()
    const raw = JSON.stringify({ tags: ['One', 'one', 'Two Words', 'th!ee', 'a', 'b', 'c', 'd', 'e', 'f'] })
    expect(parseSuggestion(raw, categories, 'm', 'T')?.tags).toEqual(['one', 'two-words', 'a', 'b', 'c', 'd'])
  })

  it('is null when nothing survived — an empty proposal is not a proposal', () => {
    expect(parseSuggestion(JSON.stringify({ category: 'nope', tags: ['!!'] }), categories, 'm', 'T')).toBeNull()
  })
})

describe('knownCategories', () => {
  it('is the taxonomy, and only the taxonomy (P5-63)', async () => {
    // It used to be a fixed list UNION whatever the catalog happened to hold,
    // which is how three vocabularies grew. A word somebody typed into a
    // manifest last week is no longer a category a model may choose.
    await indexFileBackedEntry('document', 'd1', { title: 'D', category: 'kitchen-sink' }, [])
    const categories = await knownCategories()
    expect(categories).toEqual(CATEGORY_IDS)
    expect(categories).not.toContain('kitchen-sink')
    expect(new Set(categories).size).toBe(categories.length)
  })
})

describe('the prompt', () => {
  it('names the file, the categories to choose from, and the rules the parser enforces', () => {
    const message = buildSuggestUserMessage({
      file: 'report.pdf',
      text: 'Body text.',
      categories: ['research', 'land'],
      currentTitle: 'example.org/report',
      url: 'https://example.org/report',
    })
    expect(message).toContain('report.pdf')
    expect(message).toContain('land (Land)')
    expect(message).toContain('research (Research)')
    expect(message).toContain('example.org/report')
    expect(message).toContain('Body text.')
    expect(message).toContain(String(TITLE_MAX_CHARS))
  })

  it('splits the vocabulary into what a document is about and what it is for (P5-63)', () => {
    const lines = categoryMenu(CATEGORY_IDS)
    expect(lines.join('\n')).toContain('What it is ABOUT')
    expect(lines.join('\n')).toContain('What it is FOR')
    for (const id of TOPIC_IDS) expect(lines[0]).toContain(id)
    for (const id of PURPOSE_IDS) expect(lines[1]).toContain(id)
    // A word the caller allows that the taxonomy does not name is still offered.
    expect(categoryMenu(['land', 'kitchen-sink']).join('\n')).toContain('Also in use: kitchen-sink')
  })

  it('offers the taxonomy’s suggested tags first, without forbidding a free one', () => {
    const message = buildSuggestUserMessage({ file: 'r.pdf', text: 'x', categories: [...CATEGORY_IDS] })
    expect(message).toContain('Use these words where they fit')
    expect(message).toContain('heirs-property')
    expect(message).toMatch(/A word of your own is fine/)
  })
})

describe('suggestForEntry', () => {
  it('reads the document, asks the model, and hands back a proposal', async () => {
    await seedDrop('drop', 'report.txt', 'Heirs property is land passed down without a will.')
    const { client, create } = stubClient(textTurn(GOOD))
    const outcome = await suggestForEntry('drop', { client, categories: ['research', 'land'] })
    expect(outcome).toMatchObject({ title: 'Heirs property in the Black Belt', category: 'research', model: expect.any(String) })
    const params = create.mock.calls[0][0]
    expect(params.max_tokens).toBe(suggestMaxTokens())
    expect(String(params.messages[0].content)).toContain('Heirs property is land passed down without a will.')
    expect(String(params.messages[0].content)).toContain('land (Land)')
    expect(String(params.messages[0].content)).toContain('research (Research)')
  })

  it('shows the model only the first pages, however long the document is', async () => {
    // A letter the prompt's own wording never uses, so the count measures the
    // document and not the instructions around it.
    await seedDrop('long', 'long.txt', 'Z'.repeat(SUGGEST_TEXT_CHARS * 2))
    const { client, create } = stubClient(textTurn(GOOD))
    await suggestForEntry('long', { client })
    const body = String(create.mock.calls[0][0].messages[0].content)
    expect((body.match(/Z/g) ?? []).length).toBe(SUGGEST_TEXT_CHARS)
  })

  it('says "unavailable" when the model cannot be asked, or answers with nothing usable', async () => {
    await seedDrop('down', 'report.txt', 'Some text.')
    const failing = stubClient(new Error('401 authentication_error'))
    const outcome = await suggestForEntry('down', { client: failing.client })
    // P5-75: the pass is asynchronous, so WHY is recorded on the entry rather
    // than returned in a response — a refused key must not read as an outage.
    expect(outcome).toEqual({ error: 'unavailable', at: expect.any(String), reason: 'refused' })
    expect(isSuggestionError(outcome!)).toBe(true)

    const junk = stubClient(textTurn('I am not able to help with that.'))
    const unusable = await suggestForEntry('down', { client: junk.client })
    expect(unusable).toMatchObject({ error: 'unavailable' })
    // The model answered; it just answered badly. That is not a reason code.
    expect((unusable as Record<string, unknown>).reason).toBeUndefined()
  })

  it('names a missing key as a missing key, not as a refusal (P5-75)', async () => {
    await seedDrop('keyless', 'report.txt', 'Some text.')
    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const failing = stubClient(new Error('401 authentication_error'))
      expect(await suggestForEntry('keyless', { client: failing.client })).toMatchObject({ reason: 'no-key' })
    } finally {
      process.env.ANTHROPIC_API_KEY = key
    }
  })

  it('skips quietly when there is nothing to read: no readable file, or an empty one', async () => {
    await seedDrop('zip', 'archive.zip', 'PKbinary')
    const { client, create } = stubClient(textTurn(GOOD))
    expect(await suggestForEntry('zip', { client })).toBeNull()

    await seedDrop('empty', 'blank.txt', '   ')
    expect(await suggestForEntry('empty', { client })).toBeNull()
    expect(create).not.toHaveBeenCalled()

    expect(await suggestForEntry('missing-entirely', { client })).toBeNull()
  })

  /**
   * P5-59, found live: a 26.5 MB `export.csv` from a data.gov portal downloaded
   * fine and got no suggestion at all — extraction skips anything over
   * EXTRACT_MAX_BYTES, and the suggester was handed nothing. It only ever needs
   * the first few thousand characters.
   */
  describe('a file too large to extract', () => {
    /** The catalog row says 25 MB; the bucket holds a few bytes, so no test
     *  ever writes a 25 MB file to disk. */
    async function seedHugeCsv(slug: string, body: string, meta: Record<string, unknown> = {}): Promise<void> {
      const fileKey = `library/incoming/${slug}/export.csv`
      const metaKey = `library/incoming/${slug}/meta.json`
      const manifest = { title: 'catalog.data.gov/dataset/wwi', status: 'needs-cataloging', url: 'https://catalog.data.gov/x', ...meta }
      fake.seed(fileKey, body)
      fake.seed(metaKey, JSON.stringify(manifest, null, 2))
      await indexFileBackedEntry('incoming', slug, manifest, [
        { key: fileKey, size: 25 * 1024 * 1024 },
        { key: metaKey, size: 100 },
      ])
    }

    it('reads the head of the file instead of skipping, and says that is what it read', async () => {
      await seedHugeCsv('huge', 'geo_id,ct_fips,wellpop_pcnt2\n1400000US13001950100,13001950100,41.2\n')
      const { client, create } = stubClient(textTurn(GOOD))
      const outcome = await suggestForEntry('huge', { client })
      expect(outcome).toMatchObject({ title: 'Heirs property in the Black Belt', basis: 'head' })
      const body = String(create.mock.calls[0][0].messages[0].content)
      expect(body).toContain('geo_id,ct_fips,wellpop_pcnt2')
      expect(body).toContain('File name: export.csv')
    })

    it('shows the inspection beside the head when the probe already read the columns', async () => {
      await seedHugeCsv('huge-inspected', 'a,b\n1,2\n', {
        inspection: {
          kind: 'file',
          confidence: 'high',
          url: 'https://catalog.data.gov/x',
          title: 'Nationally-normed Well Water Index',
          geometry: 'table',
          fields: [{ name: 'ct_fips', alias: 'Census tract FIPS' }, { name: 'wellpop_pcnt2' }],
          checkedAt: 'T',
        },
      })
      const { client, create } = stubClient(textTurn(GOOD))
      await suggestForEntry('huge-inspected', { client })
      const body = String(create.mock.calls[0][0].messages[0].content)
      expect(body).toContain('Nationally-normed Well Water Index')
      expect(body).toContain('Census tract FIPS')
      expect(body).toContain('a,b')
    })

    it('a file under the cap is still read properly, not from its head', async () => {
      await seedDrop('normal', 'report.txt', 'Heirs property is land passed down without a will.')
      const { client } = stubClient(textTurn(GOOD))
      const outcome = await suggestForEntry('normal', { client })
      expect((outcome as any).basis).toBeUndefined()
    })
  })

  it('bills the tokens to the dropping user, reserving before and settling after', async () => {
    await seedDrop('bill', 'report.txt', 'Some text to read.')
    const before = getUsageSnapshot().totalTokens
    const { client } = stubClient(textTurn(GOOD, { input_tokens: 300, output_tokens: 40 }))
    await suggestForEntry('bill', { client, clientIp: '203.0.113.9' })
    // Settled to what the call actually cost, not to the estimate.
    expect(getUsageSnapshot().totalTokens - before).toBe(340)

    // A failed call releases the reservation entirely.
    const after = getUsageSnapshot().totalTokens
    await suggestForEntry('bill', { client: stubClient(new Error('boom')).client, clientIp: '203.0.113.9' })
    expect(getUsageSnapshot().totalTokens).toBe(after)
  })
})
