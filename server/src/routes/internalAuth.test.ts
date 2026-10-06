import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import rateLimit from 'express-rate-limit'
import type { Pool as PgPool } from 'pg'

process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { createInternalAuthRouter } = await import('./internalAuth.js')
const { requireInternalUser, requireAdmin } = await import('../middleware/requireInternalUser.js')
const { SESSION_COOKIE, createSession, revokeSession, pruneExpiredSessions } = await import(
  '../services/internalSessions.js'
)

/** argon2 is deliberately slow — hash the fixture passwords once, at
 *  minimum cost: this suite verifies dozens of times (the per-username
 *  throttle test alone burns 20+), and verify cost comes from the hash's
 *  embedded params, so cheap params here change nothing about production. */
const CHEAP = { timeCost: 2, memoryCost: 2048, parallelism: 1 }
let adminHash: string
let internalHash: string
beforeAll(async () => {
  adminHash = await argon2.hash('admin-pass-123', CHEAP)
  internalHash = await argon2.hash('internal-pass-123', CHEAP)
})

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

/** Test app mirroring app.ts's wiring: one trusted proxy hop, cookie-parser,
 *  the auth router (login limiter defaults to pass-through), and guarded
 *  probe routes. No CORS layer, so the login handler's own Origin check is
 *  what's under test here. */
function makeApp(loginLimiter?: express.RequestHandler) {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(cookieParser())
  app.use(createInternalAuthRouter(loginLimiter ?? ((_req, _res, next) => next())))
  app.get('/api/library/ping', requireInternalUser, (_req, res) => res.json({ status: 'ok' }))
  app.post('/api/library/mutate', requireInternalUser, (_req, res) => res.json({ status: 'ok' }))
  app.get('/api/admin/probe', requireAdmin, (_req, res) => res.json({ status: 'ok' }))
  return app
}

async function seedUsers() {
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('boss', $1, 'admin')`,
    [adminHash],
  )
  await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', $1, 'internal')`,
    [internalHash],
  )
}

function rawSessionCookie(res: request.Response): string {
  const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
  const cookie = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
  if (!cookie) throw new Error('no session cookie set')
  return cookie
}

function sessionCookie(res: request.Response): string {
  return rawSessionCookie(res).split(';')[0]
}

const NICK = { username: 'nick', password: 'internal-pass-123' }

async function login(app: express.Express, username: string, password: string) {
  const res = await request(app).post('/api/login').send({ username, password })
  expect(res.status).toBe(200)
  return { cookie: sessionCookie(res), csrfToken: res.body.csrfToken as string }
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await seedUsers()
})

afterEach(async () => {
  await closeLibraryDb()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('POST /api/login', () => {
  it('sets an httpOnly session cookie and returns username/role/csrfToken — never the token', async () => {
    const res = await request(makeApp()).post('/api/login').send(NICK)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ username: 'nick', role: 'internal' })
    expect(typeof res.body.csrfToken).toBe('string')

    const rawCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).join(';')
    expect(rawCookie).toContain(`${SESSION_COOKIE}=`)
    expect(rawCookie.toLowerCase()).toContain('httponly')
    const token = sessionCookie(res).split('=')[1]
    expect(JSON.stringify(res.body)).not.toContain(token)
  })

  it('rejects a wrong password and an unknown user with identical bare 401s', async () => {
    const app = makeApp()
    const wrongPw = await request(app).post('/api/login').send({ username: 'nick', password: 'nope' })
    const unknown = await request(app).post('/api/login').send({ username: 'ghost', password: 'nope' })
    expect(wrongPw.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrongPw.body).toEqual(unknown.body)
    expect(wrongPw.body).toEqual({ error: 'unauthorized' })
  })

  it('rejects a disabled user even with the correct password', async () => {
    await libraryQuery(`UPDATE library_users SET disabled = TRUE WHERE username = 'nick'`)
    const res = await request(makeApp()).post('/api/login').send(NICK)
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('rejects malformed bodies without touching the database', async () => {
    const app = makeApp()
    for (const body of [{}, { username: 'nick' }, { username: 42, password: 'x' }, { username: 'x'.repeat(65), password: 'x' }]) {
      const res = await request(app).post('/api/login').send(body)
      expect(res.status).toBe(401)
    }
  })

  it('returns 503 when the library store is disabled', async () => {
    await closeLibraryDb()
    const res = await request(makeApp()).post('/api/login').send(NICK)
    expect(res.status).toBe(503)
  })

  it('audits successes and failures', async () => {
    const app = makeApp()
    await request(app).post('/api/login').send(NICK)
    await request(app).post('/api/login').send({ username: 'nick', password: 'wrong' })
    await request(app).post('/api/login').send({ username: 'ghost', password: 'wrong' })
    await vi.waitFor(async () => {
      const res = await libraryQuery(`SELECT actor, action FROM library_audit ORDER BY id`)
      expect(res.rows).toEqual([
        { actor: 'nick', action: 'login.success' },
        { actor: 'nick', action: 'login.failure' },
        { actor: 'ghost', action: 'login.failure' },
      ])
    })
  })

  it('audit detail carries a hashed IP and a bounded user-agent — never the raw IP or password', async () => {
    const app = makeApp()
    await request(app)
      .post('/api/login')
      .set('User-Agent', 'blo-test-agent/1.0')
      .set('X-Forwarded-For', '203.0.113.9')
      .send(NICK)
    await request(app)
      .post('/api/login')
      .set('User-Agent', 'u'.repeat(300))
      .send({ username: 'nick', password: 'wrong-pass-xyz' })
    await vi.waitFor(async () => {
      const res = await libraryQuery(`SELECT action, detail FROM library_audit ORDER BY id`)
      expect(res.rows).toHaveLength(2)
      const [ok, bad] = res.rows.map(r => ({
        action: r.action,
        detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail,
      }))
      expect(ok.action).toBe('login.success')
      expect(ok.detail.ipHash).toMatch(/^[0-9a-f]{16}$/)
      expect(ok.detail.ua).toBe('blo-test-agent/1.0')
      expect(bad.action).toBe('login.failure')
      expect(bad.detail.reason).toBe('bad-password')
      expect(bad.detail.ipHash).toMatch(/^[0-9a-f]{16}$/)
      expect(bad.detail.ipHash).not.toBe(ok.detail.ipHash) // different client IPs
      expect(bad.detail.ua).toHaveLength(200)
      const dump = JSON.stringify(res.rows)
      for (const secret of ['203.0.113.9', '127.0.0.1', 'internal-pass-123', 'wrong-pass-xyz']) {
        expect(dump).not.toContain(secret)
      }
    })
  })

  it('returns 429 after 10 attempts within the window (fresh limiter)', async () => {
    const app = makeApp(
      rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false }),
    )
    for (let i = 0; i < 10; i++) {
      const res = await request(app).post('/api/login').send({ username: 'ghost', password: 'x' })
      expect(res.status).toBe(401)
    }
    const eleventh = await request(app).post('/api/login').send({ username: 'ghost', password: 'x' })
    expect(eleventh.status).toBe(429)
  })

  it('throttles a username after 20 failures in an hour — even with the right password — and other users are unaffected', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'))
    const app = makeApp()
    for (let i = 0; i < 20; i++) {
      const res = await request(app).post('/api/login').send({ username: 'nick', password: `wrong-${i}` })
      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'unauthorized' })
    }
    const blocked = await request(app).post('/api/login').send(NICK)
    expect(blocked.status).toBe(401)
    expect(blocked.body).toEqual({ error: 'unauthorized' }) // same body as any other failure
    expect(blocked.headers['set-cookie']).toBeUndefined()

    const other = await request(app).post('/api/login').send({ username: 'boss', password: 'admin-pass-123' })
    expect(other.status).toBe(200)

    vi.setSystemTime(new Date('2026-09-04T13:00:01Z'))
    const afterWindow = await request(app).post('/api/login').send(NICK)
    expect(afterWindow.status).toBe(200)
  })

  it('a successful login resets the failure count for that username', async () => {
    const app = makeApp()
    for (let i = 0; i < 19; i++) {
      await request(app).post('/api/login').send({ username: 'nick', password: 'wrong' })
    }
    expect((await request(app).post('/api/login').send(NICK)).status).toBe(200)
    // Counter is back to zero: 19 more failures still leave the account usable.
    for (let i = 0; i < 19; i++) {
      await request(app).post('/api/login').send({ username: 'nick', password: 'wrong' })
    }
    expect((await request(app).post('/api/login').send(NICK)).status).toBe(200)
  })

  it('re-login with a live session cookie revokes the old session', async () => {
    const app = makeApp()
    const first = await login(app, 'nick', 'internal-pass-123')
    const res = await request(app).post('/api/login').set('Cookie', first.cookie).send(NICK)
    expect(res.status).toBe(200)
    const second = sessionCookie(res)
    expect(second).not.toBe(first.cookie)
    expect((await request(app).get('/api/library/ping').set('Cookie', first.cookie)).status).toBe(401)
    expect((await request(app).get('/api/library/ping').set('Cookie', second)).status).toBe(200)
  })

  it('a failed login leaves the current session untouched', async () => {
    const app = makeApp()
    const { cookie } = await login(app, 'nick', 'internal-pass-123')
    const res = await request(app)
      .post('/api/login')
      .set('Cookie', cookie)
      .send({ username: 'nick', password: 'wrong' })
    expect(res.status).toBe(401)
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(200)
  })
})

describe('login cookie flags', () => {
  it('test env: HttpOnly + SameSite=Lax, no Secure', async () => {
    const cookie = rawSessionCookie(await request(makeApp()).post('/api/login').send(NICK))
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).not.toMatch(/Secure/i)
  })

  it('production: Secure + SameSite=None', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const cookie = rawSessionCookie(await request(makeApp()).post('/api/login').send(NICK))
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=None/i)
  })

  it('an HTTPS request (via the trusted proxy) gets Secure even outside production', async () => {
    const cookie = rawSessionCookie(
      await request(makeApp()).post('/api/login').set('X-Forwarded-Proto', 'https').send(NICK),
    )
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
  })
})

describe('login origin check (login-CSRF)', () => {
  it('a disallowed Origin gets a generic 401 with no cookie; allowed and absent Origins log in', async () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example')
    const app = makeApp()
    const evil = await request(app).post('/api/login').set('Origin', 'https://evil.example').send(NICK)
    expect(evil.status).toBe(401)
    expect(evil.body).toEqual({ error: 'unauthorized' })
    expect(evil.headers['set-cookie']).toBeUndefined()

    const allowed = await request(app).post('/api/login').set('Origin', 'https://app.example').send(NICK)
    expect(allowed.status).toBe(200)
    expect(() => sessionCookie(allowed)).not.toThrow()

    const none = await request(app).post('/api/login').send(NICK)
    expect(none.status).toBe(200)
  })
})

describe('requireInternalUser / requireAdmin', () => {
  it('allows a logged-in user through and rejects no/garbage cookies bare', async () => {
    const app = makeApp()
    const { cookie } = await login(app, 'nick', 'internal-pass-123')
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(200)

    const noCookie = await request(app).get('/api/library/ping')
    const garbage = await request(app).get('/api/library/ping').set('Cookie', `${SESSION_COOKIE}=deadbeef`)
    expect(noCookie.status).toBe(401)
    expect(garbage.status).toBe(401)
    expect(noCookie.body).toEqual({ error: 'unauthorized' })
    expect(garbage.body).toEqual(noCookie.body)
  })

  it('rejects expired sessions', async () => {
    const app = makeApp()
    const { cookie } = await login(app, 'nick', 'internal-pass-123')
    await libraryQuery(`UPDATE library_sessions SET expires_at = $1`, [new Date(Date.now() - 1000)])
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(401)
  })

  it('rejects sessions of users disabled after login', async () => {
    const app = makeApp()
    const { cookie } = await login(app, 'nick', 'internal-pass-123')
    await libraryQuery(`UPDATE library_users SET disabled = TRUE WHERE username = 'nick'`)
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(401)
  })

  it('requires a matching CSRF header on mutating routes', async () => {
    const app = makeApp()
    const { cookie, csrfToken } = await login(app, 'nick', 'internal-pass-123')

    const missing = await request(app).post('/api/library/mutate').set('Cookie', cookie)
    const wrong = await request(app)
      .post('/api/library/mutate')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'f'.repeat(64))
    const right = await request(app)
      .post('/api/library/mutate')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
    expect(missing.status).toBe(403)
    expect(wrong.status).toBe(403)
    expect(right.status).toBe(200)
  })

  it('requireAdmin admits admins and bare-401s internal users', async () => {
    const app = makeApp()
    const admin = await login(app, 'boss', 'admin-pass-123')
    const internal = await login(app, 'nick', 'internal-pass-123')
    expect((await request(app).get('/api/admin/probe').set('Cookie', admin.cookie)).status).toBe(200)
    const denied = await request(app).get('/api/admin/probe').set('Cookie', internal.cookie)
    expect(denied.status).toBe(401)
    expect(denied.body).toEqual({ error: 'unauthorized' })
  })
})

describe('logout', () => {
  it('revokes the session: login → ping 200 → logout 204 → ping 401', async () => {
    const app = makeApp()
    const loginRes = await request(app).post('/api/login').send(NICK)
    const cookie = sessionCookie(loginRes)
    const csrfToken = loginRes.body.csrfToken as string

    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(200)
    const logout = await request(app)
      .post('/api/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
    expect(logout.status).toBe(204)
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(401)
    expect((await request(app).get('/api/me').set('Cookie', cookie)).status).toBe(401)
  })

  it('rejects logout without the CSRF header (403), leaving the session live', async () => {
    const app = makeApp()
    const loginRes = await request(app).post('/api/login').send(NICK)
    const cookie = sessionCookie(loginRes)
    expect((await request(app).post('/api/logout').set('Cookie', cookie)).status).toBe(403)
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(200)
  })
})

describe('GET /api/me', () => {
  it('returns username, role, and the CSRF token for a valid session; 401 otherwise', async () => {
    const app = makeApp()
    const loginRes = await request(app).post('/api/login').send({ username: 'boss', password: 'admin-pass-123' })
    const me = await request(app).get('/api/me').set('Cookie', sessionCookie(loginRes))
    expect(me.status).toBe(200)
    expect(me.body).toEqual({
      username: 'boss',
      role: 'admin',
      csrfToken: loginRes.body.csrfToken,
    })
    expect((await request(app).get('/api/me')).status).toBe(401)
  })

  it('csrfToken recovered from /api/me authorizes mutating calls (hard-refresh path)', async () => {
    // Simulates a page reload: the cookie survives but the login-response
    // CSRF token is gone — /api/me must hand back a working one.
    const app = makeApp()
    const loginRes = await request(app).post('/api/login').send(NICK)
    const cookie = sessionCookie(loginRes)
    const me = await request(app).get('/api/me').set('Cookie', cookie)
    const mutate = await request(app)
      .post('/api/library/mutate')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', me.body.csrfToken)
    expect(mutate.status).toBe(200)
  })
})

describe('session lifecycle: pruneExpiredSessions', () => {
  const DAY = 24 * 60 * 60 * 1000

  async function nickId(): Promise<number> {
    const res = await libraryQuery(`SELECT id FROM library_users WHERE username = 'nick'`)
    return Number(res.rows[0].id)
  }

  it('deletes sessions expired or revoked more than 7 days ago and keeps the rest', async () => {
    const userId = await nickId()
    const tokens: string[] = []
    for (let i = 0; i < 5; i++) tokens.push((await createSession(userId)).token)
    const ids = (await libraryQuery(`SELECT id FROM library_sessions ORDER BY id`)).rows.map(r => Number(r.id))
    const now = Date.now()
    // ids[0]: live. ids[1]: expired yesterday (inside grace). ids[2]: expired
    // 10 days ago. ids[3]: revoked yesterday. ids[4]: revoked 10 days ago.
    await libraryQuery(`UPDATE library_sessions SET expires_at = $1 WHERE id = $2`, [new Date(now - DAY), ids[1]])
    await libraryQuery(`UPDATE library_sessions SET expires_at = $1 WHERE id = $2`, [new Date(now - 10 * DAY), ids[2]])
    await libraryQuery(`UPDATE library_sessions SET revoked = TRUE, revoked_at = $1 WHERE id = $2`, [new Date(now - DAY), ids[3]])
    await libraryQuery(`UPDATE library_sessions SET revoked = TRUE, revoked_at = $1 WHERE id = $2`, [new Date(now - 10 * DAY), ids[4]])

    expect(await pruneExpiredSessions()).toBe(2)
    const remaining = (await libraryQuery(`SELECT id FROM library_sessions ORDER BY id`)).rows.map(r => Number(r.id))
    expect(remaining).toEqual([ids[0], ids[1], ids[3]])

    // The live session still authenticates after the prune.
    const app = makeApp()
    const ping = await request(app).get('/api/library/ping').set('Cookie', `${SESSION_COOKIE}=${tokens[0]}`)
    expect(ping.status).toBe(200)
  })

  it('revokeSession stamps revoked_at so the grace period counts from revocation', async () => {
    const { token } = await createSession(await nickId())
    await revokeSession(token)
    const res = await libraryQuery(`SELECT revoked, revoked_at FROM library_sessions`)
    expect(res.rows[0].revoked).toBe(true)
    expect(res.rows[0].revoked_at).toBeInstanceOf(Date)
  })

  it('legacy revoked rows without revoked_at fall back to created_at', async () => {
    await createSession(await nickId())
    await libraryQuery(`UPDATE library_sessions SET revoked = TRUE, revoked_at = NULL, created_at = $1`, [
      new Date(Date.now() - 10 * DAY),
    ])
    expect(await pruneExpiredSessions()).toBe(1)
  })

  it('is a no-op when the library store is disabled', async () => {
    await closeLibraryDb()
    expect(await pruneExpiredSessions()).toBe(0)
  })
})

describe('SESSION_COOKIE_SAMESITE', async () => {
  const { sessionSameSite } = await import('./internalAuth.js')
  it('defaults to None in production and Lax elsewhere, and honours the override', () => {
    delete process.env.SESSION_COOKIE_SAMESITE
    expect(sessionSameSite(true)).toBe('none')
    expect(sessionSameSite(false)).toBe('lax')
    process.env.SESSION_COOKIE_SAMESITE = 'lax'
    expect(sessionSameSite(true)).toBe('lax')
    process.env.SESSION_COOKIE_SAMESITE = 'bogus'
    expect(sessionSameSite(true)).toBe('none')
    delete process.env.SESSION_COOKIE_SAMESITE
  })
})
