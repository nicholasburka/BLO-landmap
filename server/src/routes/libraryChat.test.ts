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
 * P6-7a routes: /api/chats against the real createApp() — the session guard,
 * the CSRF gate, the per-user limiter, the daily budget, the audit trail and
 * the NDJSON stream are production's wiring. Only the Anthropic client is a
 * stub, so the whole retrieval → tools → answer path really runs.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { reindexCatalog, getCatalogEntry } = await import('../services/libraryCatalog.js')
const { clearKbIndex } = await import('../services/kbSearch.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { appendMessage, listMessages, MESSAGE_MAX_CHARS, UNTITLED_CHAT } = await import('../services/libraryChat.js')
const { CHAT_TURNS_BEFORE_COMPACTION, MODEL_UNAVAILABLE } = await import('../services/chatLoop.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

function textTurn(text: string) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 900, output_tokens: 100 },
  }
}

function toolTurn(name: string, input: Record<string, unknown>) {
  return {
    id: 'msg_0',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'tool_use', id: 'tu1', name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 800, output_tokens: 50 },
  }
}

const app = createApp()
let passwordHash: string
let fake: FakeS3
let dataDir: string

beforeAll(async () => {
  passwordHash = await argon2.hash('chat-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

beforeEach(async () => {
  mockCreate.mockReset()
  mockCreate.mockResolvedValue(textTurn('Partition sales are the mechanism most often named [1].'))
  clearKbIndex()
  await resetInternalRateLimit()
  process.env.DAILY_BUDGET_TOKENS = '10000000'
  process.env.DAILY_BUDGET_TOKENS_PER_IP = '10000000'

  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role)
     VALUES ('maria', $1, 'internal'), ('nick', $1, 'admin')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-chat-route-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed(
    'library/datasets/organizations/organizations.csv',
    'Organization,HQ State\nBlack Farmer Fund,NY\nSouthwest Georgia Project,GA\nTruly Living Well,GA\n',
  )
  fake.seed(
    'library/datasets/organizations/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'network', status: 'published', tags: ['network'], description: 'Organizations doing land work.' }),
  )
  fake.seed('library/wiki/land-loss.md', '# Land loss\n\nPartition sales are the mechanism most often named.\n')
  await reindexCatalog()
})

afterEach(async () => {
  delete process.env.DAILY_BUDGET_TOKENS
  delete process.env.DAILY_BUDGET_TOKENS_PER_IP
  clearKbIndex()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
interface Auth {
  cookie: string
  csrf: string
}

async function login(username = 'maria'): Promise<Auth> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.97.0.${++loginIp}`)
    .send({ username, password: 'chat-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

const get = (auth: Auth, path: string) => request(app).get(path).set('Cookie', auth.cookie)
const post = (auth: Auth, path: string, body?: unknown) =>
  request(app).post(path).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body as object)
const patch = (auth: Auth, path: string, body?: unknown) =>
  request(app).patch(path).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body as object)
const del = (auth: Auth, path: string) =>
  request(app).delete(path).set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf)

async function newChat(auth: Auth, body: unknown = {}): Promise<number> {
  const res = await post(auth, '/api/chats', body)
  expect(res.status).toBe(201)
  return res.body.chat.id as number
}

/** The stream, as the client reads it: one JSON event per line. */
function events(res: { text?: string; body?: unknown }): any[] {
  const raw =
    typeof res.text === 'string' && res.text
      ? res.text
      : Buffer.isBuffer(res.body)
        ? res.body.toString('utf8')
        : ''
  return raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
}

function send(auth: Auth, chatId: number, text: string) {
  return request(app)
    .post(`/api/chats/${chatId}/messages`)
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .buffer(true)
    .send({ text })
}

async function auditRows(action: string) {
  await new Promise(resolve => setTimeout(resolve, 30))
  const { rows } = await libraryQuery(`SELECT actor, action, target, detail FROM library_audit WHERE action = $1`, [action])
  return rows as { actor: string; action: string; target: string | null; detail: any }[]
}

// --- The guard -----------------------------------------------------------------

describe('the guard', () => {
  it('is a bare 401 logged out, on every route, and never calls the model', async () => {
    for (const call of [
      request(app).get('/api/chats'),
      request(app).post('/api/chats').send({}),
      request(app).get('/api/chats/1'),
      request(app).patch('/api/chats/1').send({ title: 'x' }),
      request(app).delete('/api/chats/1'),
      request(app).post('/api/chats/1/messages').send({ text: 'hello' }),
      request(app).post('/api/chats/1/actions/a/confirm').send({}),
    ]) {
      const res = await call
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is 403 for a logged-in session with no CSRF header', async () => {
    const auth = await login()
    const res = await request(app).post('/api/chats/1/messages').set('Cookie', auth.cookie).send({ text: 'hello' })
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// --- Threads -------------------------------------------------------------------

describe('threads', () => {
  it('creates, lists, renames and archives my own threads', async () => {
    const auth = await login()
    const created = await post(auth, '/api/chats', { message: 'what causes land loss in Macon County?' })
    expect(created.status).toBe(201)
    expect(created.body.chat).toMatchObject({
      id: expect.any(Number),
      title: 'what causes land loss in Macon County?',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    })
    const id = created.body.chat.id

    const empty = await post(auth, '/api/chats', {})
    expect(empty.body.chat.title).toBe(UNTITLED_CHAT)

    const list = await get(auth, '/api/chats')
    expect(list.status).toBe(200)
    expect(list.body.chats.map((c: any) => c.id)).toEqual([empty.body.chat.id, id])

    const renamed = await patch(auth, `/api/chats/${id}`, { title: '  Macon County  ' })
    expect(renamed.body.chat.title).toBe('Macon County')
    expect((await patch(auth, `/api/chats/${id}`, { title: '  ' })).status).toBe(400)

    expect((await del(auth, `/api/chats/${id}`)).body).toEqual({ archived: true })
    expect((await get(auth, `/api/chats/${id}`)).status).toBe(404)
    expect((await get(auth, '/api/chats')).body.chats.map((c: any) => c.id)).toEqual([empty.body.chat.id])
  })

  it('returns the thread with its messages', async () => {
    const auth = await login()
    const id = await newChat(auth, { title: 'Land loss' })
    await appendMessage({ chatId: id, role: 'user', text: 'what causes land loss?' })
    await appendMessage({
      chatId: id,
      role: 'assistant',
      text: 'Partition sales [1].',
      toolCalls: [{ id: 'a1', tool: 'search_library', kind: 'read', status: 'done', summary: 'Searched the library' }],
      citations: [{ n: 1, slug: 'land-loss', kind: 'wiki', title: 'Land loss', href: '/wiki/land-loss', snippet: 'x', cited: true }],
      meta: { failed: 'rate-limited' },
    })

    const res = await get(auth, `/api/chats/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.chat.title).toBe('Land loss')
    expect(res.body.messages).toHaveLength(2)
    expect(res.body.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Partition sales [1].',
      toolCalls: [expect.objectContaining({ tool: 'search_library' })],
      citations: [expect.objectContaining({ n: 1 })],
    })
    // `meta` is server-side: the admin reason code never rides on a message.
    expect(res.body.messages[1].meta).toBeUndefined()
  })

  it('is a 404 on somebody else’s thread, whatever is asked of it', async () => {
    const maria = await login('maria')
    const nick = await login('nick')
    const id = await newChat(maria, { title: 'Mine' })

    expect((await get(nick, `/api/chats/${id}`)).status).toBe(404)
    expect((await patch(nick, `/api/chats/${id}`, { title: 'Hijacked' })).status).toBe(404)
    expect((await del(nick, `/api/chats/${id}`)).status).toBe(404)
    expect((await send(nick, id, 'hello')).status).toBe(404)
    expect((await post(nick, `/api/chats/${id}/actions/act-1/confirm`)).status).toBe(404)
    expect((await get(nick, '/api/chats')).body.chats).toEqual([])
    // Still mine, untouched, and the model was never asked.
    expect((await get(maria, `/api/chats/${id}`)).body.chat.title).toBe('Mine')
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

// --- Sending a message ---------------------------------------------------------

describe('POST /api/chats/:id/messages', () => {
  it('streams the answer as newline-delimited JSON and stores both messages', async () => {
    const auth = await login()
    const id = await newChat(auth)
    const res = await send(auth, id, 'what causes land loss?')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
    expect(res.headers['cache-control']).toBe('private, no-store')

    const stream = events(res)
    expect(stream.map(e => e.type)).toEqual(['text', 'citations', 'done'])
    expect(stream[0].text).toBe('Partition sales are the mechanism most often named [1].')
    expect(stream[1].citations[0]).toMatchObject({ n: 1, href: expect.stringMatching(/^\//) })
    expect(stream[2]).toMatchObject({ chatId: id, messageId: expect.any(Number), userMessageId: expect.any(Number) })

    const stored = await listMessages(id)
    expect(stored.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(stored[1].text).toBe('Partition sales are the mechanism most often named [1].')
    expect(stored[1].citations.length).toBeGreaterThan(0)
    // The first message names the thread.
    expect((await get(auth, `/api/chats/${id}`)).body.chat.title).toBe('what causes land loss?')
  })

  it('shows a read tool as a started/finished pair and answers from it', async () => {
    mockCreate
      .mockResolvedValueOnce(toolTurn('query_dataset', { slug: 'organizations', filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] }))
      .mockResolvedValueOnce(textTurn('Two organizations are based in Georgia [1].'))
    const auth = await login()
    const id = await newChat(auth)
    const stream = events(await send(auth, id, 'how many organizations are in Georgia?'))

    const calls = stream.filter(e => e.type === 'tool_call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ phase: 'started', call: { tool: 'query_dataset', status: 'running' } })
    expect(calls[1].call).toMatchObject({ tool: 'query_dataset', status: 'done' })
    expect(calls[1].call.summary).toContain('2 rows')
    expect(stream[stream.length - 1].type).toBe('done')
    expect((await listMessages(id))[1].toolCalls[0].status).toBe('done')
  })

  it('refuses an empty or oversized message before the model is called', async () => {
    const auth = await login()
    const id = await newChat(auth)
    expect((await send(auth, id, '  ')).status).toBe(400)
    expect((await send(auth, id, 'x'.repeat(MESSAGE_MAX_CHARS + 1))).status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is 503 when the day’s token budget is gone, and never calls the model', async () => {
    const auth = await login()
    const id = await newChat(auth)
    process.env.DAILY_BUDGET_TOKENS = '1'
    const res = await send(auth, id, 'what causes land loss?')
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('daily_budget_exceeded')
    expect(mockCreate).not.toHaveBeenCalled()
    expect(await listMessages(id)).toEqual([])
  })

  it('compacts a thread past thirty turns before answering the next one', async () => {
    const auth = await login()
    const id = await newChat(auth, { title: 'Long one' })
    for (let i = 0; i < CHAT_TURNS_BEFORE_COMPACTION; i++) {
      await appendMessage({ chatId: id, role: 'user', text: `question ${i}` })
      await appendMessage({ chatId: id, role: 'assistant', text: `answer ${i}` })
    }
    mockCreate
      .mockResolvedValueOnce(textTurn('They worked through thirty questions about land loss.'))
      .mockResolvedValueOnce(textTurn('Partition sales, still [1].'))

    const stream = events(await send(auth, id, 'and one more thing?'))
    expect(stream[stream.length - 1].type).toBe('done')

    const stored = await listMessages(id)
    const summary = stored.find(m => m.role === 'summary')
    expect(summary?.text).toBe('They worked through thirty questions about land loss.')
    expect(summary?.meta.throughMessageId).toBe(stored[stored.length - 4].id)

    // The answering call saw the summary, not sixty messages.
    const answering = mockCreate.mock.calls[1][0]
    expect(answering.messages).toHaveLength(1)
    expect(String(answering.messages[0].content)).toContain('Earlier in this conversation')
    expect(String(answering.messages[0].content)).toContain('and one more thing?')
    expect(String(answering.messages[0].content)).not.toContain('question 0')
  })
})

// --- The model is unavailable --------------------------------------------------

describe('an unavailable model', () => {
  const warned: unknown[][] = []
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warned.length = 0
    warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void warned.push(args))
  })

  afterEach(() => warn.mockRestore())

  function rejectWith(message: string, status?: number): void {
    const err: any = new Error(message)
    if (status !== undefined) err.status = status
    mockCreate.mockRejectedValue(err)
  }

  it('answers with the honesty line, stores it, and tells a member nothing more', async () => {
    rejectWith('rate_limit_error', 429)
    const auth = await login('maria')
    const id = await newChat(auth)
    const res = await send(auth, id, 'what causes land loss?')

    // The turn itself succeeded — the answer is that there is no answer.
    expect(res.status).toBe(200)
    const stream = events(res)
    expect(stream.map(e => e.type)).toEqual(['text', 'error'])
    expect(stream[0].text).toBe(MODEL_UNAVAILABLE)
    expect(stream[1]).toEqual({ type: 'error', error: MODEL_UNAVAILABLE, messageId: expect.any(Number) })
    expect(stream[1].reason).toBeUndefined()

    const stored = await listMessages(id)
    expect(stored[1].text).toBe(MODEL_UNAVAILABLE)
    expect(warned.some(args => String(args[0]).includes('[chat] the model is unavailable'))).toBe(true)
  })

  it('tells an admin which of the four failures it was', async () => {
    rejectWith('authentication_error', 401)
    const auth = await login('nick')
    const id = await newChat(auth)
    const stream = events(await send(auth, id, 'what causes land loss?'))
    expect(stream[1]).toMatchObject({ type: 'error', reason: 'refused' })
  })
})

// --- Proposing and confirming a write ------------------------------------------

describe('a write the model proposes', () => {
  async function propose(auth: Auth): Promise<{ id: number; action: any }> {
    mockCreate
      .mockResolvedValueOnce(toolTurn('create_note', { title: 'Shelby follow-up', body: 'Call the assessor about the 2019 partition sales.' }))
      .mockResolvedValueOnce(textTurn('I can write that note — confirm it and I will.'))
    const id = await newChat(auth)
    const stream = events(await send(auth, id, 'write that down as a note'))
    const proposed = stream.find(e => e.type === 'proposed_action')
    expect(proposed).toBeTruthy()
    return { id, action: proposed.action }
  }

  it('is a proposal on the stream and on the message, and nothing is written', async () => {
    const auth = await login()
    const { id, action } = await propose(auth)

    expect(action).toMatchObject({
      id: expect.any(String),
      tool: 'create_note',
      kind: 'write',
      status: 'proposed',
      summary: 'Write a note “Shelby follow-up”',
      args: { title: 'Shelby follow-up' },
    })
    expect(await getCatalogEntry('shelby-follow-up')).toBeNull()
    expect((await get(auth, `/api/chats/${id}`)).body.messages[1].toolCalls[0].status).toBe('proposed')
  })

  it('runs only on confirm, and audits it as a chat write', async () => {
    const auth = await login()
    const { id, action } = await propose(auth)

    const res = await post(auth, `/api/chats/${id}/actions/${action.id}/confirm`)
    expect(res.status).toBe(200)
    expect(res.body.action).toMatchObject({ status: 'confirmed', result: { slug: 'shelby-follow-up' } })
    expect(res.body.message).toMatchObject({ role: 'tool', text: expect.stringContaining('shelby-follow-up') })

    const entry = await getCatalogEntry('shelby-follow-up')
    expect(entry?.kind).toBe('note')

    const rows = await auditRows('chat.create_note')
    expect(rows).toHaveLength(1)
    expect(rows[0].actor).toBe('maria')
    expect(rows[0].target).toBe('shelby-follow-up')
    const detail = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail
    expect(detail).toMatchObject({ chatId: id, client: 'chat', messageId: expect.any(Number) })
    // The entry's own row says the work came in through chat.
    expect((await auditRows('library.note'))[0].detail.via).toBe('chat')

    // Confirming again changes nothing.
    expect((await post(auth, `/api/chats/${id}/actions/${action.id}/confirm`)).status).toBe(409)
  })

  it('is a 404 for an action id this conversation does not hold', async () => {
    const auth = await login()
    const id = await newChat(auth)
    expect((await post(auth, `/api/chats/${id}/actions/made-up/confirm`)).status).toBe(404)
  })
})
