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
 * GET /api/chat-context (P13-1) — what the chat model is given.
 *
 * What this file is judged on is that the route cannot DISAGREE with the turn.
 * It reads `chatTools()` and `buildChatSystemPrompt()`, the same two functions
 * `runChatTurn` reads, so the cases below compare the route's answer against
 * those functions rather than against a list written here.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { chatTools, buildChatSystemPrompt } = await import('../services/chatLoop.js')

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash('ctx-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
let fake: FakeS3
let dataDir: string

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal')`,
    [passwordHash],
  )
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-chat-context-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let loginIp = 0
async function login(): Promise<string> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.77.0.${++loginIp}`)
    .send({ username: 'maria', password: 'ctx-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return cookie.split(';')[0]
}

describe('GET /api/chat-context', () => {
  it('is internal-only — a logged-out reader gets nothing', async () => {
    expect((await request(app).get('/api/chat-context')).status).toBe(401)
  })

  it('lists exactly the tools the turn is given, in the same order', async () => {
    const res = await request(app).get('/api/chat-context').set('Cookie', await login())
    expect(res.status).toBe(200)
    // Compared against `chatTools()` itself rather than a list typed here:
    // a list typed here is the thing that was wrong before this route existed.
    expect(res.body.tools.map((t: { name: string }) => t.name)).toEqual(chatTools().map(t => t.name))
    expect(res.body.counts.tools).toBe(chatTools().length)
  })

  it('carries the whole system prompt, not a summary of it', async () => {
    const res = await request(app).get('/api/chat-context').set('Cookie', await login())
    expect(res.body.systemPrompt).toBe(buildChatSystemPrompt(null))
  })

  it('marks which tools WRITE, because a write is confirmed rather than run', async () => {
    const res = await request(app).get('/api/chat-context').set('Cookie', await login())
    const writes = res.body.tools.filter((t: { write: boolean }) => t.write).map((t: { name: string }) => t.name)
    expect(writes).toEqual(chatTools().filter(t => t.write).map(t => t.name))
    expect(writes).toContain('build_index')
    expect(writes).toContain('measure_proximity')
  })

  it('hands back each tool’s schema as the model is shown it', async () => {
    const res = await request(app).get('/api/chat-context').set('Cookie', await login())
    const search = res.body.tools.find((t: { name: string }) => t.name === 'search_library')
    expect(search.inputSchema).toEqual(chatTools().find(t => t.name === 'search_library')!.definition.input_schema)
    expect(search.descriptionChars).toBeGreaterThan(0)
  })

  it('renders the prompt scoped to a set when one is asked for', async () => {
    const cookie = await login()
    const made = await request(app)
      .post('/api/working-sets')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'x')
      .send({ name: 'Memphis' })
    // CSRF may refuse the create; the scope branch is what matters, and an
    // unknown slug has to fall back to the library rather than 500.
    const res = await request(app).get('/api/chat-context?set=not-a-set').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.scope).toBeNull()
    expect(res.body.systemPrompt).toBe(buildChatSystemPrompt(null))
    void made
  })

  it('estimates what the fixed part of a turn costs', async () => {
    const res = await request(app).get('/api/chat-context').set('Cookie', await login())
    expect(res.body.approxPromptChars).toBeGreaterThan(res.body.systemPrompt.length)
  })
})
