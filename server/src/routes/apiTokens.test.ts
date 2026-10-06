import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P5-50: personal API tokens, minted from the account page.
 *
 * Runs against the real createApp() with a pg-mem library store, so the guard
 * chain under test (session, CSRF, per-user limiter, audit) is production's.
 * The bucket is deliberately NOT initialized — token administration must not
 * depend on it, which is exactly what "no isBucketEnabled() check" means.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { recentActivity } = await import('../services/libraryActivity.js')
const { API_TOKEN_PREFIX, TOKEN_NAME_MAX, getApiTokenPrincipal, clearApiTokenTouchCache } = await import(
  '../services/apiTokens.js'
)

let passwordHash: string
beforeAll(async () => {
  // Cheap params: this suite logs in per test. Verify cost lives in the hash,
  // so nothing about production wiring changes.
  passwordHash = await argon2.hash('token-pass-123', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', $1, 'internal'), ('nick', $1, 'admin')`,
    [passwordHash],
  )
  await resetInternalRateLimit()
  clearApiTokenTouchCache()
})

afterEach(async () => {
  await closeLibraryDb()
})

// One login per test, each from its own address: the login limiter is 10/hr
// per IP and the app trusts one proxy hop.
let loginIp = 0
async function login(username: string): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.98.0.${++loginIp}`)
    .send({ username, password: 'token-pass-123' })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function mint(auth: { cookie: string; csrf: string }, name: string) {
  return request(app)
    .post('/api/library/tokens')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send({ name })
}

describe('minting a token', () => {
  it('returns the secret exactly once, keeps only its hash, and lists it without secrets', async () => {
    const auth = await login('maria')
    const created = await mint(auth, 'Claude Desktop — laptop')
    expect(created.status).toBe(201)
    expect(created.body.token.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect(created.body).toMatchObject({ name: 'Claude Desktop — laptop', scopes: ['read'] })
    expect(typeof created.body.id).toBe('number')
    expect(Date.parse(created.body.createdAt)).toBeGreaterThan(0)

    // The plaintext must exist nowhere in the row.
    const { rows } = await libraryQuery(`SELECT token_hash, name, revoked_at FROM library_api_tokens`)
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).not.toBe(created.body.token)
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0].revoked_at).toBeFalsy()

    const list = await request(app).get('/api/library/tokens').set('Cookie', auth.cookie)
    expect(list.status).toBe(200)
    expect(list.body.tokens).toHaveLength(1)
    expect(list.body.tokens[0]).toEqual({
      id: created.body.id,
      name: 'Claude Desktop — laptop',
      scopes: ['read'],
      createdAt: created.body.createdAt,
      lastUsedAt: null,
    })
    expect(JSON.stringify(list.body)).not.toContain(created.body.token)
  })

  it('mints a working credential — the resolved principal is the minting user', async () => {
    const auth = await login('maria')
    const created = await mint(auth, 'cli')
    const principal = await getApiTokenPrincipal(created.body.token)
    expect(principal?.user.username).toBe('maria')
    expect(principal?.scopes).toEqual(['read'])
    expect(await getApiTokenPrincipal('blo_not-a-real-token')).toBeNull()
    // A string that isn't even shaped like one of ours never reaches the DB.
    expect(await getApiTokenPrincipal('whatever')).toBeNull()
  })

  it('refuses a blank name and one longer than the cap', async () => {
    const auth = await login('maria')
    expect((await mint(auth, '   ')).status).toBe(400)
    expect((await mint(auth, 'x'.repeat(TOKEN_NAME_MAX + 1))).status).toBe(400)
    expect((await mint(auth, 'x'.repeat(TOKEN_NAME_MAX))).status).toBe(201)
  })

  it('refuses without a session, and without a CSRF header', async () => {
    expect((await request(app).post('/api/library/tokens').send({ name: 'x' })).status).toBe(401)
    expect((await request(app).get('/api/library/tokens')).status).toBe(401)
    const auth = await login('maria')
    const noCsrf = await request(app).post('/api/library/tokens').set('Cookie', auth.cookie).send({ name: 'x' })
    expect(noCsrf.status).toBe(403)
  })
})

describe('revoking a token', () => {
  it('revokes your own, drops it from the list, and stops the credential working', async () => {
    const auth = await login('maria')
    const created = await mint(auth, 'laptop')
    expect(await getApiTokenPrincipal(created.body.token)).not.toBeNull()

    const revoked = await request(app)
      .delete(`/api/library/tokens/${created.body.id}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(revoked.status).toBe(200)
    expect(revoked.body).toEqual({ revoked: true })

    expect(await getApiTokenPrincipal(created.body.token)).toBeNull()
    const list = await request(app).get('/api/library/tokens').set('Cookie', auth.cookie)
    expect(list.body.tokens).toEqual([])
    // The row survives for the incident trail, stamped with when it was cut.
    const { rows } = await libraryQuery(`SELECT revoked_at FROM library_api_tokens`)
    expect(rows[0].revoked_at).toBeTruthy()
  })

  it('is idempotent and reads as missing for an unknown id', async () => {
    const auth = await login('maria')
    const created = await mint(auth, 'laptop')
    const del = () =>
      request(app)
        .delete(`/api/library/tokens/${created.body.id}`)
        .set('Cookie', auth.cookie)
        .set('X-CSRF-Token', auth.csrf)
    expect((await del()).status).toBe(200)
    expect((await del()).status).toBe(404)
    const unknown = await request(app)
      .delete('/api/library/tokens/9999')
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    expect(unknown.status).toBe(404)
  })

  it("hides someone else's token from a non-admin but lets an admin cut it off", async () => {
    const maria = await login('maria')
    const nick = await login('nick')
    const mariasToken = await mint(maria, 'marias laptop')
    const nicksToken = await mint(nick, 'nicks laptop')

    // maria cannot even tell nick's id exists
    const denied = await request(app)
      .delete(`/api/library/tokens/${nicksToken.body.id}`)
      .set('Cookie', maria.cookie)
      .set('X-CSRF-Token', maria.csrf)
    expect(denied.status).toBe(404)
    expect(await getApiTokenPrincipal(nicksToken.body.token)).not.toBeNull()

    // the admin can revoke maria's
    const byAdmin = await request(app)
      .delete(`/api/library/tokens/${mariasToken.body.id}`)
      .set('Cookie', nick.cookie)
      .set('X-CSRF-Token', nick.csrf)
    expect(byAdmin.status).toBe(200)
    expect(await getApiTokenPrincipal(mariasToken.body.token)).toBeNull()
  })

  it('lists only your own tokens', async () => {
    const maria = await login('maria')
    const nick = await login('nick')
    await mint(maria, 'marias')
    await mint(nick, 'nicks')
    const mine = await request(app).get('/api/library/tokens').set('Cookie', maria.cookie)
    expect(mine.body.tokens.map((t: any) => t.name)).toEqual(['marias'])
  })
})

describe('the audit trail', () => {
  it('records token.create and token.revoke, with the name but never the secret', async () => {
    const auth = await login('maria')
    const created = await mint(auth, 'Claude Code')
    await request(app)
      .delete(`/api/library/tokens/${created.body.id}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)

    // Audit writes are fire-and-forget; let the microtask queue drain.
    await new Promise(resolve => setTimeout(resolve, 30))
    const { rows } = await libraryQuery(
      `SELECT actor, action, target, detail FROM library_audit WHERE action LIKE 'token.%' ORDER BY id`,
    )
    expect(rows.map((r: any) => r.action)).toEqual(['token.create', 'token.revoke'])
    expect(rows.every((r: any) => r.actor === 'maria')).toBe(true)
    expect(rows[0].target).toBe(String(created.body.id))
    expect(JSON.stringify(rows)).toContain('Claude Code')
    expect(JSON.stringify(rows)).not.toContain(created.body.token)
  })

  it('keeps account hygiene out of the activity feed', async () => {
    const auth = await login('maria')
    const created = await mint(auth, 'Claude Code')
    await request(app)
      .delete(`/api/library/tokens/${created.body.id}`)
      .set('Cookie', auth.cookie)
      .set('X-CSRF-Token', auth.csrf)
    await new Promise(resolve => setTimeout(resolve, 30))
    // The feed works from an allowlist of verbs; token actions are not on it,
    // so minting a token never reads as library work on the front door.
    expect(await recentActivity(50)).toEqual([])
  })
})
