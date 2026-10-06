import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P5-76: change your own password.
 *
 * Runs against the real createApp() with a pg-mem library store, so the guard
 * chain under test (session, CSRF, the per-user limiters, the audit trail) is
 * production's. The bucket is deliberately NOT initialized — account hygiene
 * must not depend on it.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { resetPasswordChangeRateLimit, PASSWORD_CHANGE_LIMIT } = await import('./account.js')
const { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = await import('../services/passwords.js')

const OLD_PASSWORD = 'old-password-123'
const NEW_PASSWORD = 'new-password-456'

let passwordHash: string
beforeAll(async () => {
  // Cheap params: this suite logs in repeatedly. Verify cost lives in the
  // hash string, so nothing about production wiring changes.
  passwordHash = await argon2.hash(OLD_PASSWORD, { timeCost: 2, memoryCost: 2048, parallelism: 1 })
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
  await resetPasswordChangeRateLimit()
})

afterEach(async () => {
  await closeLibraryDb()
})

// One login per call, each from its own address: the login limiter is 10/hr
// per IP and the app trusts one proxy hop.
let loginIp = 0
async function login(
  username: string,
  password = OLD_PASSWORD,
): Promise<{ cookie: string; csrf: string }> {
  const res = await request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.99.0.${++loginIp}`)
    .send({ username, password })
  expect(res.status).toBe(200)
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return { cookie: cookie.split(';')[0], csrf: res.body.csrfToken }
}

function loginStatus(username: string, password: string): Promise<number> {
  return request(app)
    .post('/api/login')
    .set('X-Forwarded-For', `10.99.1.${++loginIp}`)
    .send({ username, password })
    .then(res => res.status)
}

function change(auth: { cookie: string; csrf: string }, body: Record<string, unknown>) {
  return request(app)
    .post('/api/account/password')
    .set('Cookie', auth.cookie)
    .set('X-CSRF-Token', auth.csrf)
    .send(body)
}

/** Audit writes are fire-and-forget; let the microtask queue drain. */
async function auditRows(): Promise<any[]> {
  await new Promise(resolve => setTimeout(resolve, 30))
  const { rows } = await libraryQuery(
    `SELECT actor, action, detail FROM library_audit WHERE action LIKE 'account.%' ORDER BY id`,
  )
  return rows
}

describe('changing your password', () => {
  it('replaces the hash: the old password stops working and the new one logs in', async () => {
    const auth = await login('maria')
    const before = (await libraryQuery(`SELECT password_hash FROM library_users WHERE username='maria'`))
      .rows[0].password_hash

    const res = await change(auth, { current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, signedOutOthers: 0 })

    const after = (await libraryQuery(`SELECT password_hash FROM library_users WHERE username='maria'`))
      .rows[0].password_hash
    expect(after).not.toBe(before)
    // Stored hashed, never in plaintext, and it is a real argon2 hash.
    expect(after).not.toContain(NEW_PASSWORD)
    expect(await argon2.verify(after, NEW_PASSWORD)).toBe(true)

    expect(await loginStatus('maria', OLD_PASSWORD)).toBe(401)
    expect(await loginStatus('maria', NEW_PASSWORD)).toBe(200)
  })

  it('keeps the session that changed it and signs every other one out', async () => {
    const other = await login('maria')
    const another = await login('maria')
    const auth = await login('maria')

    const res = await change(auth, { current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.signedOutOthers).toBe(2)

    // The session that did it still works — the CSRF token is derived from
    // the same (unchanged) session token, so writes keep working too.
    expect((await request(app).get('/api/library/ping').set('Cookie', auth.cookie)).status).toBe(200)
    for (const dead of [other, another]) {
      expect((await request(app).get('/api/library/ping').set('Cookie', dead.cookie)).status).toBe(401)
    }
  })

  it('leaves other people’s sessions alone', async () => {
    const nick = await login('nick')
    const maria = await login('maria')
    const res = await change(maria, { current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(res.body.signedOutOthers).toBe(0)
    expect((await request(app).get('/api/library/ping').set('Cookie', nick.cookie)).status).toBe(200)
    expect(await loginStatus('nick', OLD_PASSWORD)).toBe(200)
  })
})

describe('what it refuses', () => {
  it('refuses a wrong current password with a sentence, changing nothing', async () => {
    const other = await login('maria')
    const auth = await login('maria')
    const res = await change(auth, { current: 'not-my-password', next: NEW_PASSWORD })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'That is not your current password.' })

    expect(await loginStatus('maria', OLD_PASSWORD)).toBe(200)
    // A failed attempt must not sign anybody out either.
    expect((await request(app).get('/api/library/ping').set('Cookie', other.cookie)).status).toBe(200)
  })

  it('refuses a new password under the shared minimum and names the number', async () => {
    const auth = await login('maria')
    const res = await change(auth, { current: OLD_PASSWORD, next: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: `Use at least ${MIN_PASSWORD_LENGTH} characters.` })
    expect(await loginStatus('maria', OLD_PASSWORD)).toBe(200)
  })

  it('accepts a new password exactly at the minimum', async () => {
    const auth = await login('maria')
    const atLimit = 'a'.repeat(MIN_PASSWORD_LENGTH)
    expect((await change(auth, { current: OLD_PASSWORD, next: atLimit })).status).toBe(200)
    expect(await loginStatus('maria', atLimit)).toBe(200)
  })

  it('refuses one past the maximum rather than hashing it', async () => {
    const auth = await login('maria')
    const res = await change(auth, { current: OLD_PASSWORD, next: 'a'.repeat(MAX_PASSWORD_LENGTH + 1) })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: `Use at most ${MAX_PASSWORD_LENGTH} characters.` })
  })

  it('refuses a new password identical to the current one', async () => {
    const auth = await login('maria')
    const res = await change(auth, { current: OLD_PASSWORD, next: OLD_PASSWORD })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Your new password must be different from your current one.' })
  })

  it('refuses missing or non-string fields', async () => {
    const auth = await login('maria')
    expect((await change(auth, {})).status).toBe(400)
    expect((await change(auth, { current: OLD_PASSWORD })).status).toBe(400)
    expect((await change(auth, { current: '', next: NEW_PASSWORD })).status).toBe(400)
    expect((await change(auth, { current: 1, next: NEW_PASSWORD })).status).toBe(400)
    expect(await loginStatus('maria', OLD_PASSWORD)).toBe(200)
  })

  it('refuses without a session, and without the CSRF header', async () => {
    const anonymous = await request(app)
      .post('/api/account/password')
      .send({ current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toEqual({ error: 'unauthorized' })

    const auth = await login('maria')
    const noCsrf = await request(app)
      .post('/api/account/password')
      .set('Cookie', auth.cookie)
      .send({ current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(noCsrf.status).toBe(403)
    expect(await loginStatus('maria', OLD_PASSWORD)).toBe(200)
  })
})

describe('the per-user cap', () => {
  it('stops after a handful of attempts an hour, per account rather than per address', async () => {
    const maria = await login('maria')
    // Wrong current every time — this is the guessing case the cap exists for.
    for (let i = 0; i < PASSWORD_CHANGE_LIMIT; i++) {
      expect((await change(maria, { current: `guess-${i}`, next: NEW_PASSWORD })).status).toBe(400)
    }
    const blocked = await change(maria, { current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(blocked.status).toBe(429)
    // Even a correct attempt is refused once the budget is spent.
    expect(await loginStatus('maria', OLD_PASSWORD)).toBe(200)

    // Another account's budget is untouched.
    const nick = await login('nick')
    expect((await change(nick, { current: OLD_PASSWORD, next: NEW_PASSWORD })).status).toBe(200)
  })
})

describe('the audit trail', () => {
  it('records the change with the number signed out, and never a password', async () => {
    await login('maria')
    const auth = await login('maria')
    const res = await change(auth, { current: OLD_PASSWORD, next: NEW_PASSWORD })
    expect(res.status).toBe(200)

    const rows = await auditRows()
    expect(rows.map(r => r.action)).toEqual(['account.password'])
    expect(rows[0].actor).toBe('maria')
    expect(rows[0].detail).toMatchObject({ signedOutOthers: 1 })
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(OLD_PASSWORD)
    expect(serialized).not.toContain(NEW_PASSWORD)
  })

  it('records a wrong current password too — that is the incident signal', async () => {
    const auth = await login('maria')
    await change(auth, { current: 'not-my-password', next: NEW_PASSWORD })
    const rows = await auditRows()
    expect(rows.map(r => r.action)).toEqual(['account.password.failure'])
    expect(rows[0].detail).toMatchObject({ reason: 'bad-current' })
    expect(JSON.stringify(rows)).not.toContain('not-my-password')
  })
})
