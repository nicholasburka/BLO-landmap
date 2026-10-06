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
 * P6-7a loop: the conversation, its tools, its compaction and its
 * propose-then-confirm write path.
 *
 * The Anthropic client is a stub returning scripted turns, so every round,
 * every tool result and every failure is asserted without spending a token or
 * touching the network. Everything else — the catalog, the bucket, the audit
 * log, the MCP handlers — is the real thing.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog, getCatalogEntry } = await import('./libraryCatalog.js')
const { buildKbIndex, clearKbIndex } = await import('./kbSearch.js')
const { createChat, appendMessage, listMessages, contextMessages } = await import('./libraryChat.js')
const {
  chatTools,
  chatToolByName,
  compactIfNeeded,
  confirmAction,
  runChatTurn,
  toModelMessages,
  toolSummary,
  buildChatSystemPrompt,
  CHAT_TURNS_BEFORE_COMPACTION,
  CHAT_VIA,
  MAX_CHAT_ROUNDS,
  MODEL_UNAVAILABLE,
} = await import('./chatLoop.js')
const { MODEL_UNAVAILABLE: ASK_MODEL_UNAVAILABLE } = await import('../routes/libraryAsk.js')

type AnthropicLike = import('./askKb.js').AnthropicLike
type KbIndexType = Awaited<ReturnType<typeof buildKbIndex>>
type ChatEvent = import('./chatLoop.js').ChatEvent

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let turnId = 0
function textTurn(text: string): Anthropic.Messages.Message {
  return {
    id: `msg_${++turnId}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  } as unknown as Anthropic.Messages.Message
}

function toolTurn(name: string, input: Record<string, unknown>, id = `t${++turnId}`): Anthropic.Messages.Message {
  return {
    id: `msg_${++turnId}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 30 },
  } as unknown as Anthropic.Messages.Message
}

function stubClient(...turns: Anthropic.Messages.Message[]): { client: AnthropicLike; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn()
  for (const turn of turns) create.mockResolvedValueOnce(turn)
  create.mockResolvedValue(textTurn('Fallback answer.'))
  return { client: { messages: { create } } as unknown as AnthropicLike, create }
}

const USER = { id: 1, username: 'maria', role: 'internal' as const }

let fake: FakeS3
let dataDir: string
let index: KbIndexType

async function auditRows(action?: string) {
  await new Promise(resolve => setTimeout(resolve, 30))
  const { rows } = await libraryQuery(
    action
      ? `SELECT actor, action, target, detail FROM library_audit WHERE action = $1 ORDER BY id`
      : `SELECT actor, action, target, detail FROM library_audit ORDER BY id`,
    action ? [action] : [],
  )
  return rows as { actor: string; action: string; target: string | null; detail: any }[]
}

/** A thread owned by `maria`, with the user row the foreign key needs. */
async function newChat(title = 'Land loss') {
  return createChat(USER.id, title)
}

beforeEach(async () => {
  turnId = 0
  clearKbIndex()
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('maria', 'x', 'internal')`)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-chatloop-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed(
    'library/datasets/organizations/organizations.csv',
    'Organization,HQ State\nBlack Farmer Fund,NY\nSouthwest Georgia Project,GA\nTruly Living Well,GA\n',
  )
  fake.seed(
    'library/datasets/organizations/meta.json',
    JSON.stringify({
      title: 'Organizations',
      category: 'network',
      status: 'published',
      tags: ['network'],
      description: 'Organizations doing land work, one row each.',
    }),
  )
  fake.seed('library/wiki/land-loss.md', '# Land loss\n\nPartition sales are the mechanism most often named.\n')
  await reindexCatalog()
  index = await buildKbIndex()
})

afterEach(async () => {
  clearKbIndex()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// --- The tool table ------------------------------------------------------------

describe('the tool table', () => {
  it('offers the library’s read tools, the place tools and the write tools', () => {
    const names = chatTools().map(t => t.name)
    for (const expected of [
      'search_library',
      'list_topics',
      'get_entry',
      'read_page',
      'read_document',
      'query_dataset',
      'county_values',
      'fetch_for_place',
      'place_report',
      'create_note',
      'append_to_page',
      'drop_link',
      'save_view',
    ]) {
      expect(names).toContain(expected)
    }
    // `ask` is this loop; nesting one model call inside another buys nothing.
    expect(names).not.toContain('ask')
    expect(chatToolByName('create_note')?.write).toBe(true)
    expect(chatToolByName('search_library')?.write).toBe(false)
  })

  it('hands the model a plain JSON Schema for every tool', () => {
    for (const tool of chatTools()) {
      expect(tool.definition.name).toBe(tool.name)
      expect(tool.definition.input_schema.type).toBe('object')
      // The dialect marker zod adds is not part of the API's schema.
      expect((tool.definition.input_schema as Record<string, unknown>).$schema).toBeUndefined()
      expect(tool.definition.description.length).toBeGreaterThan(20)
    }
  })

  it('checks the model’s arguments against the same shape MCP validates with', () => {
    const search = chatToolByName('search_library')!
    expect(search.parse({ query: 'heirs property' })).toEqual({ ok: true, value: { query: 'heirs property' } })
    const bad = search.parse({ query: '' })
    expect(bad.ok).toBe(false)
    expect('error' in bad && bad.error).toMatch(/query/)
  })
})

describe('the system prompt and the summaries', () => {
  it('carries the subjects and the cite-what-you-used rule', () => {
    const prompt = buildChatSystemPrompt()
    expect(prompt).toMatch(/Cite what you used/i)
    expect(prompt).toMatch(/do not run when you call them/i)
    // The taxonomy line Ask carries (P5-63).
    expect(prompt).toMatch(/filed under one of these subjects/)
  })

  it('says in one line what a tool did, and what a write would do', () => {
    expect(toolSummary('search_library', { query: 'heirs property' }, { count: 6 })).toBe(
      'Searched the library for “heirs property” · 6 results',
    )
    expect(toolSummary('query_dataset', { slug: 'organizations' }, { rowCount: 2 })).toBe(
      'Queried the “organizations” table · 2 rows',
    )
    expect(toolSummary('create_note', { title: 'Shelby follow-up' })).toBe('Write a note “Shelby follow-up”')
    expect(toolSummary('place_report', { address: '55 Trinity Ave SW' })).toBe('Ran a place report for 55 Trinity Ave SW')
  })

  it('is the same honesty line Ask shows', () => {
    expect(MODEL_UNAVAILABLE).toBe(ASK_MODEL_UNAVAILABLE)
  })
})

// --- History -------------------------------------------------------------------

describe('toModelMessages', () => {
  it('labels tool results and summaries, and starts the conversation with the person', () => {
    const at = new Date().toISOString()
    const base = { chatId: 1, toolCalls: [], citations: [], meta: {}, createdAt: at }
    const messages = toModelMessages([
      { ...base, id: 1, role: 'summary', text: 'Earlier they asked about Macon County.' },
      { ...base, id: 2, role: 'user', text: 'and the parcels?' },
      { ...base, id: 3, role: 'assistant', text: 'There are 12 [1].' },
      { ...base, id: 4, role: 'tool', text: 'note written: shelby-follow-up' },
      { ...base, id: 5, role: 'user', text: 'thanks' },
    ])
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toContain('Earlier in this conversation')
    // Summary and question merge into one user turn; the answer stays its own.
    expect(messages).toHaveLength(3)
    expect(messages[1]).toEqual({ role: 'assistant', content: 'There are 12 [1].' })
    expect(String(messages[2].content)).toContain('Result of an action the person confirmed')
  })
})

// --- A turn --------------------------------------------------------------------

async function runTurn(question: string, client: AnthropicLike, history: Awaited<ReturnType<typeof listMessages>> = []) {
  const chat = await newChat()
  const events: ChatEvent[] = []
  const result = await runChatTurn({
    chat,
    user: USER,
    question,
    history,
    emit: event => void events.push(event),
    client,
    index,
  })
  return { chat, events, result }
}

describe('runChatTurn', () => {
  it('answers, streams the text and cites what it used', async () => {
    const { client, create } = stubClient(textTurn('Partition sales are the mechanism most often named [1].'))
    const { events, result } = await runTurn('what causes land loss?', client)

    expect(result.answer).toBe('Partition sales are the mechanism most often named [1].')
    expect(result.citations[0]).toMatchObject({ n: 1, href: expect.stringMatching(/^\//) })
    expect(events).toEqual([{ type: 'text', text: result.answer }])
    expect(result.usedTokens).toBe(120)

    const params = create.mock.calls[0][0]
    expect(params.tools.map((t: any) => t.name)).toContain('search_library')
    expect(params.messages).toHaveLength(1)
    expect(String(params.messages[0].content)).toContain('what causes land loss?')
  })

  it('carries the conversation so far into the prompt', async () => {
    const { client, create } = stubClient(textTurn('Two of them are in Georgia [1].'))
    const at = new Date().toISOString()
    const base = { chatId: 1, toolCalls: [], citations: [], meta: {}, createdAt: at }
    await runTurn('and how many of those are in Georgia?', client, [
      { ...base, id: 1, role: 'user', text: 'who is in the organizations table?' },
      { ...base, id: 2, role: 'assistant', text: 'Three organizations [1].' },
    ])
    const params = create.mock.calls[0][0]
    expect(params.messages).toHaveLength(3)
    expect(params.messages[1]).toEqual({ role: 'assistant', content: 'Three organizations [1].' })
  })

  it('runs a read tool, shows it as a line, and answers from the result', async () => {
    const { client, create } = stubClient(
      toolTurn('query_dataset', { slug: 'organizations', filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] }, 'tu1'),
      textTurn('Two organizations are based in Georgia [1].'),
    )
    const { events, result } = await runTurn('how many organizations are in Georgia?', client)

    const calls = events.filter(e => e.type === 'tool_call')
    expect(calls.map(e => (e as any).phase)).toEqual(['started', 'finished'])
    expect((calls[1] as any).call).toMatchObject({ tool: 'query_dataset', kind: 'read', status: 'done' })
    expect((calls[1] as any).call.summary).toContain('2 rows')
    expect(result.toolCalls).toHaveLength(1)

    // The result really went back to the model as a tool_result.
    const second = create.mock.calls[1][0]
    const toolResult = second.messages[2].content[0]
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'tu1' })
    expect(String(toolResult.content)).toContain('"rowCount": 2')
  })

  it('turns a tool failure into something the model can read, never a crashed turn', async () => {
    const { client, create } = stubClient(
      toolTurn('query_dataset', { slug: 'no-such-table' }, 'tu1'),
      textTurn('There is no table by that name [1].'),
    )
    const { events, result } = await runTurn('how many in the ghost table?', client)

    expect(result.answer).toBe('There is no table by that name [1].')
    expect(result.toolCalls[0].status).toBe('failed')
    expect((events.find(e => e.type === 'tool_call' && (e as any).phase === 'finished') as any).call.status).toBe('failed')
    const toolResult = create.mock.calls[1][0].messages[2].content[0]
    expect(toolResult.is_error).toBe(true)
    expect(String(toolResult.content)).toMatch(/no-such-table/)
  })

  it('refuses a tool it does not have, and bad arguments, as readable text', async () => {
    const { client, create } = stubClient(
      toolTurn('delete_everything', { slug: 'organizations' }, 'tu1'),
      toolTurn('query_dataset', { limit: 4 }, 'tu2'),
      textTurn('I could not do that [1].'),
    )
    await runTurn('delete the library', client)
    expect(String(create.mock.calls[1][0].messages[2].content[0].content)).toContain('Unknown tool')
    expect(String(create.mock.calls[2][0].messages[4].content[0].content)).toMatch(/do not fit this tool/)
  })

  it('proposes a write instead of running it', async () => {
    const { client, create } = stubClient(
      toolTurn('create_note', { title: 'Shelby follow-up', body: 'Call the assessor.' }, 'tu1'),
      textTurn('I can write that note down — confirm it and I will.'),
    )
    const { result, events } = await runTurn('write that down as a note', client)

    const proposed = events.find(e => e.type === 'proposed_action') as any
    expect(proposed.action).toMatchObject({
      tool: 'create_note',
      kind: 'write',
      status: 'proposed',
      summary: 'Write a note “Shelby follow-up”',
      args: { title: 'Shelby follow-up', body: 'Call the assessor.' },
    })
    expect(result.toolCalls[0].id).toBe(proposed.action.id)
    // Nothing was written.
    expect(await getCatalogEntry('shelby-follow-up')).toBeNull()
    expect(String(create.mock.calls[1][0].messages[2].content[0].content)).toMatch(/Not run/)
  })

  it('withdraws the tools on the last round so a turn always ends in prose', async () => {
    const { client, create } = stubClient(
      ...Array.from({ length: MAX_CHAT_ROUNDS - 1 }, () => toolTurn('list_topics', {})),
    )
    const { result } = await runTurn('what subjects are there?', client)
    expect(create).toHaveBeenCalledTimes(MAX_CHAT_ROUNDS)
    expect(create.mock.calls[MAX_CHAT_ROUNDS - 1][0].tools).toBeUndefined()
    expect(result.answer).toBe('Fallback answer.')
  })

  it('reports an unreachable model rather than throwing', async () => {
    const error: any = new Error('rate_limit_error')
    error.status = 429
    const client = { messages: { create: vi.fn().mockRejectedValue(error) } } as unknown as AnthropicLike
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { result, events } = await runTurn('what causes land loss?', client)
    warn.mockRestore()

    expect(result.failure).toEqual({ reason: 'the model was rate-limited', code: 'rate-limited' })
    expect(result.citations).toEqual([])
    expect(events).toEqual([])
  })
})

// --- Compaction ----------------------------------------------------------------

describe('compactIfNeeded', () => {
  async function threadOf(turns: number) {
    const chat = await newChat()
    for (let i = 0; i < turns; i++) {
      await appendMessage({ chatId: chat.id, role: 'user', text: `question ${i}` })
      await appendMessage({ chatId: chat.id, role: 'assistant', text: `answer ${i}` })
    }
    return chat
  }

  it('leaves a short thread alone', async () => {
    const chat = await threadOf(CHAT_TURNS_BEFORE_COMPACTION - 1)
    const { client, create } = stubClient(textTurn('unused'))
    expect(await compactIfNeeded(chat.id, { client })).toBeNull()
    expect(create).not.toHaveBeenCalled()
  })

  it('folds the older turns into one summary the model reads instead', async () => {
    const chat = await threadOf(CHAT_TURNS_BEFORE_COMPACTION)
    const before = await listMessages(chat.id)
    const { client, create } = stubClient(textTurn('They worked through thirty questions about land loss.'))

    const summary = await compactIfNeeded(chat.id, { client })
    expect(summary?.role).toBe('summary')
    expect(summary?.text).toBe('They worked through thirty questions about land loss.')
    expect(summary?.meta.throughMessageId).toBe(before[before.length - 1].id)
    expect(summary?.meta.summarised).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
    expect(String(create.mock.calls[0][0].messages[0].content)).toContain('question 29')

    // The model now sees one message where it saw sixty.
    const context = await contextMessages(chat.id)
    expect(context.map(m => m.id)).toEqual([summary!.id])
    // Nothing was thrown away.
    expect(await listMessages(chat.id)).toHaveLength(before.length + 1)
  })

  it('still compacts when the model is unavailable, and says that is what happened', async () => {
    const chat = await threadOf(CHAT_TURNS_BEFORE_COMPACTION)
    const error: any = new Error('rate_limit_error')
    error.status = 429
    const client = { messages: { create: vi.fn().mockRejectedValue(error) } } as unknown as AnthropicLike
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const summary = await compactIfNeeded(chat.id, { client })
    warn.mockRestore()

    expect(summary?.meta.summarised).toBe(false)
    expect(summary?.meta.reason).toBe('rate-limited')
    expect(summary?.text).toMatch(/could not be summarised/)
    expect(summary?.text).toContain('question 29')
  })
})

// --- Confirming a write --------------------------------------------------------

describe('confirmAction', () => {
  async function proposal(tool: string, args: Record<string, unknown>) {
    const chat = await newChat()
    const message = await appendMessage({
      chatId: chat.id,
      role: 'assistant',
      text: 'Confirm and I will.',
      toolCalls: [{ id: 'act-1', tool, kind: 'write', status: 'proposed', summary: `Write a note “${args.title}”`, args }],
    })
    return { chat, message }
  }

  it('runs the stored proposal through the MCP handler and records it twice', async () => {
    const { chat, message } = await proposal('create_note', { title: 'Shelby follow-up', body: 'Call the assessor.' })
    const outcome = await confirmAction({ chat, user: USER, actionId: 'act-1' })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.action.status).toBe('confirmed')
    expect(outcome.action.result).toMatchObject({ slug: 'shelby-follow-up' })
    expect((await getCatalogEntry('shelby-follow-up'))?.kind).toBe('note')

    // The thread keeps the result as a message the model reads next turn.
    expect(outcome.message.role).toBe('tool')
    expect(outcome.message.text).toContain('shelby-follow-up')
    const stored = await listMessages(chat.id)
    expect(stored.find(m => m.id === message.id)?.toolCalls[0].status).toBe('confirmed')

    // Two rows: what happened to the library, and which conversation asked.
    const chatRow = (await auditRows('chat.create_note'))[0]
    expect(chatRow.detail).toMatchObject({ chatId: chat.id, messageId: message.id, client: CHAT_VIA })
    expect(chatRow.target).toBe('shelby-follow-up')
    expect((await auditRows('library.note'))[0].detail.via).toBe(CHAT_VIA)
  })

  it('runs once: a second confirm is refused', async () => {
    const { chat } = await proposal('create_note', { title: 'Twice', body: 'Only once, please.' })
    expect((await confirmAction({ chat, user: USER, actionId: 'act-1' })).ok).toBe(true)
    const again = await confirmAction({ chat, user: USER, actionId: 'act-1' })
    expect(again).toMatchObject({ ok: false, status: 409 })
  })

  it('is a 404 for an action that is not in this conversation', async () => {
    const { chat } = await proposal('create_note', { title: 'X', body: 'y' })
    expect(await confirmAction({ chat, user: USER, actionId: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })

  it('records a write that fails as a message in the thread', async () => {
    const chat = await newChat()
    await appendMessage({
      chatId: chat.id,
      role: 'assistant',
      text: 'Confirm and I will.',
      toolCalls: [
        {
          id: 'act-2',
          tool: 'append_to_page',
          kind: 'write',
          status: 'proposed',
          summary: 'Add a section to the page “no-such-page”',
          args: { slug: 'no-such-page', markdown: 'text' },
        },
      ],
    })
    const outcome = await confirmAction({ chat, user: USER, actionId: 'act-2' })
    expect(outcome.ok).toBe(false)
    expect(outcome.message?.role).toBe('tool')
    expect(outcome.message?.text).toMatch(/did not run/)
    expect((await auditRows('chat.append_to_page'))[0].detail.failed).toBe(true)
    expect((await listMessages(chat.id))[0].toolCalls[0].status).toBe('failed')
  })
})
