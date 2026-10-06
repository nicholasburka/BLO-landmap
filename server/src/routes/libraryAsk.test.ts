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
 * P5-41 route: POST /api/library/ask against the real createApp() — the auth
 * guard, the CSRF gate, the per-user limiter, the daily budget and the audit
 * write are production's wiring. Only the Anthropic client is a stub, so the
 * whole retrieval → prompt → tool loop → response path really runs.
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
const { reindexCatalog } = await import('../services/libraryCatalog.js')
const { clearKbIndex } = await import('../services/kbSearch.js')
const { resetInternalRateLimit, INTERNAL_RATE_LIMIT_MAX } = await import('../middleware/internalRateLimit.js')
const { QUESTION_MAX_CHARS, AUDIT_QUESTION_CHARS, MODEL_UNAVAILABLE, validateAskBody } = await import('./libraryAsk.js')

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

function toolTurn(input: Record<string, unknown>) {
  return {
    id: 'msg_0',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'tool_use', id: 't1', name: 'query_dataset', input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 800, output_tokens: 50 },
  }
}

const app = createApp()
let passwordHash: string
let fake: FakeS3
let dataDir: string

beforeAll(async () => {
  // Minimum-cost hash: this suite logs in per-test. Verify cost comes from the
  // hash's embedded params, so cheap params here change nothing in production.
  passwordHash = await argon2.hash('ask-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

beforeEach(async () => {
  mockCreate.mockReset()
  mockCreate.mockResolvedValue(textTurn('Two organizations are based in Georgia [1].'))
  clearKbIndex()
  await resetInternalRateLimit()
  // Keep the wallet gate open for every test but the one that closes it.
  process.env.DAILY_BUDGET_TOKENS = '10000000'
  process.env.DAILY_BUDGET_TOKENS_PER_IP = '10000000'

  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  // P5-75: the reason a model call failed is admin-only, so the suite needs
  // one of each role signing in against the same route.
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', $1, 'admin')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-ask-route-test-'))
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
      description: 'Organizations doing land work in Georgia and elsewhere.',
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
async function login(username = 'maria'): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username, password: 'ask-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function ask(auth: { cookie: string; csrf: string }, body: unknown) {
  return request(app).post('/api/library/ask').set('Cookie', auth.cookie).set('X-CSRF-Token', auth.csrf).send(body)
}

describe('validateAskBody', () => {
  it('takes a real question and an optional dataset slug', () => {
    expect(validateAskBody({ question: '  who does land trusts?  ' })).toEqual({ question: 'who does land trusts?' })
    expect(validateAskBody({ question: 'how many?', dataset: 'organizations' })).toEqual({
      question: 'how many?',
      dataset: 'organizations',
    })
    expect(validateAskBody({ question: 'how many?', dataset: '' })).toEqual({ question: 'how many?' })
  })

  it('refuses a missing, empty, oversized question or a bogus dataset slug', () => {
    expect(validateAskBody({})).toEqual({ error: expect.any(String) })
    expect(validateAskBody({ question: 42 })).toEqual({ error: expect.any(String) })
    expect(validateAskBody({ question: ' a ' })).toEqual({ error: expect.any(String) })
    expect(validateAskBody({ question: 'x'.repeat(QUESTION_MAX_CHARS + 1) })).toEqual({ error: expect.any(String) })
    expect(validateAskBody({ question: 'ok question', dataset: '../etc/passwd' })).toEqual({ error: expect.any(String) })
  })
})

describe('POST /api/library/ask — the guard', () => {
  it('is a bare 401 when logged out, and never calls the model', async () => {
    const res = await request(app).post('/api/library/ask').send({ question: 'what is in the library?' })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is 403 for a logged-in session with no CSRF header, and never calls the model', async () => {
    const auth = await login()
    const res = await request(app).post('/api/library/ask').set('Cookie', auth.cookie).send({ question: 'what is in the library?' })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'forbidden' })
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is 400 for a question the validator refuses', async () => {
    const auth = await login()
    const res = await ask(auth, { question: '' })
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/library/ask — the answer', () => {
  it('returns the answer, numbered sources with hrefs, and what it read', async () => {
    const auth = await login()
    const res = await ask(auth, { question: 'what does the funding strategy say about year two?' })
    expect(res.status).toBe(200)
    expect(res.body.answer).toBe('Two organizations are based in Georgia [1].')
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        n: 1,
        slug: expect.any(String),
        kind: expect.any(String),
        title: expect.any(String),
        href: expect.stringMatching(/^\//),
        snippet: expect.any(String),
      }),
    ])
    expect(res.body.queries).toEqual([])
    expect(res.body.read).toEqual({ pages: expect.any(Number), datasets: expect.any(Number), documents: expect.any(Number), notes: expect.any(Number), sources: expect.any(Number) })
  })

  it('runs the query tool and returns a card with the table and map deep links', async () => {
    mockCreate
      .mockResolvedValueOnce(toolTurn({ slug: 'organizations', filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] }))
      .mockResolvedValueOnce(textTurn('Two organizations are headquartered in Georgia [1].'))
    const auth = await login()
    const res = await ask(auth, { question: 'how many organizations are in Georgia?', dataset: 'organizations' })
    expect(res.status).toBe(200)
    expect(res.body.queries).toEqual([
      expect.objectContaining({
        slug: 'organizations',
        rowCount: 2,
        filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
        href: expect.stringContaining('tab=data'),
        mapHref: '/?layers=internal-organizations',
      }),
    ])
  })

  it('audits library.ask with the truncated question, source count and tool count', async () => {
    const auth = await login()
    const question = `how many organizations ${'x'.repeat(400)}`
    await ask(auth, { question })
    const rows = await libraryQuery(`SELECT actor, action, detail FROM library_audit WHERE action = 'library.ask'`)
    expect(rows.rows).toHaveLength(1)
    const detail = typeof rows.rows[0].detail === 'string' ? JSON.parse(rows.rows[0].detail) : rows.rows[0].detail
    expect(rows.rows[0].actor).toBe('maria')
    expect(detail.questionLength).toBe(question.length)
    expect(detail.question).toHaveLength(AUDIT_QUESTION_CHARS)
    expect(detail.sources).toBeGreaterThan(0)
    expect(detail.tools).toBe(0)
  })

})

// --- P5-75: say why the model is unavailable -------------------------------
// The reason is a code, not a sentence: the browser owns the wording, and the
// server owns which of the four it was. Admins only — a member cannot act on
// "the key was refused" and would only be alarmed by it.

describe('POST /api/library/ask — an unavailable model', () => {
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

  it('is 503 with the plain sentence and NO reason for a member', async () => {
    rejectWith('rate_limit_error', 429)
    const res = await ask(await login('maria'), { question: 'what does the funding strategy say?' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: MODEL_UNAVAILABLE })
    expect(res.body.error).toMatch(/unavailable/i)
  })

  it('is 503 with the same sentence plus the reason code for an admin', async () => {
    rejectWith('rate_limit_error', 429)
    const res = await ask(await login('nick'), { question: 'what does the funding strategy say?' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: MODEL_UNAVAILABLE, reason: 'rate-limited' })
  })

  it('tells a refused key apart from a server with no key at all', async () => {
    rejectWith('authentication_error', 401)
    const refused = await ask(await login('nick'), { question: 'what does the funding strategy say?' })
    expect(refused.body.reason).toBe('refused')

    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      rejectWith('authentication_error', 401)
      const noKey = await ask(await login('nick'), { question: 'what does the funding strategy say?' })
      expect(noKey.body.reason).toBe('no-key')
    } finally {
      process.env.ANTHROPIC_API_KEY = key
    }
  })

  it('calls anything else from the model a model-error, and says so once in the log', async () => {
    rejectWith('upstream on fire')
    const res = await ask(await login('nick'), { question: 'what does the funding strategy say?' })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBe('model-error')
    expect(warned.some(args => String(args[0]).includes('[library] ask: the model is unavailable'))).toBe(true)
  })

  it('never says "reason" on a failure that is not the model', async () => {
    // A budget refusal is our own 503 and carries `code`, not `reason`.
    const auth = await login('nick')
    process.env.DAILY_BUDGET_TOKENS = '1'
    const res = await ask(auth, { question: 'what does the funding strategy say?' })
    expect(res.status).toBe(503)
    expect(res.body.reason).toBeUndefined()
    expect(res.body.code).toBe('daily_budget_exceeded')
  })
})

describe('POST /api/library/ask — limits and budget', () => {
  it('sits behind the per-user limiter (its headers ride on every answer)', async () => {
    const auth = await login()
    const first = await ask(auth, { question: 'what does the funding strategy say?' })
    expect(first.headers['ratelimit-limit']).toBe(String(INTERNAL_RATE_LIMIT_MAX))
    const second = await ask(auth, { question: 'what does the funding strategy say?' })
    expect(Number(second.headers['ratelimit-remaining'])).toBe(Number(first.headers['ratelimit-remaining']) - 1)
  })

  it('is 503 daily_budget_exceeded once the day\'s token cap is spent, without calling the model', async () => {
    const auth = await login()
    process.env.DAILY_BUDGET_TOKENS = '1'
    mockCreate.mockClear()
    const res = await ask(auth, { question: 'what does the funding strategy say?' })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('daily_budget_exceeded')
    expect(res.body.error).toMatch(/usage cap/i)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('is 503 per-IP once that device\'s cap is spent', async () => {
    const auth = await login()
    process.env.DAILY_BUDGET_TOKENS_PER_IP = '1'
    const res = await ask(auth, { question: 'what does the funding strategy say?' })
    expect(res.status).toBe(503)
    expect(res.body.code).toBe('daily_budget_exceeded_per_ip')
  })
})
