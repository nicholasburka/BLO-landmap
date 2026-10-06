import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import cookieParser from 'cookie-parser'
import request from 'supertest'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { createUser, resetPassword, setDisabled, listUsers, generatePassword } = await import(
  './users.js'
)
const { createInternalAuthRouter } = await import('../routes/internalAuth.js')
const { requireInternalUser } = await import('../middleware/requireInternalUser.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
})

afterEach(async () => {
  await closeLibraryDb()
})

describe('createUser', () => {
  it('creates an account whose password verifies and logs an audit entry', async () => {
    await createUser('nick', 'admin', 'hunter2hunter2')
    const row = (
      await libraryQuery(`SELECT password_hash, role, disabled FROM library_users WHERE username='nick'`)
    ).rows[0]
    expect(row.role).toBe('admin')
    expect(row.disabled).toBe(false)
    expect(await argon2.verify(row.password_hash, 'hunter2hunter2')).toBe(true)

    const audit = (await libraryQuery(`SELECT actor, action, target FROM library_audit`)).rows
    expect(audit).toEqual([{ actor: 'cli', action: 'user.create', target: 'nick' }])
  })

  it('rejects duplicates, bad usernames, bad roles, and short passwords', async () => {
    await createUser('nick', 'internal', 'hunter2hunter2')
    await expect(createUser('nick', 'internal', 'hunter2hunter2')).rejects.toThrow(/already exists/)
    await expect(createUser('bad name!', 'internal', 'hunter2hunter2')).rejects.toThrow(/invalid username/)
    await expect(createUser('ok', 'superuser' as any, 'hunter2hunter2')).rejects.toThrow(/invalid role/)
    await expect(createUser('ok', 'internal', 'short')).rejects.toThrow(/at least 8/)
  })
})

describe('resetPassword', () => {
  it('replaces the hash and revokes existing sessions', async () => {
    await createUser('nick', 'internal', 'old-password-1')
    const userId = Number(
      (await libraryQuery(`SELECT id FROM library_users WHERE username='nick'`)).rows[0].id,
    )
    await libraryQuery(
      `INSERT INTO library_sessions (user_id, token_hash, expires_at) VALUES ($1, 'live-hash', $2)`,
      [userId, new Date(Date.now() + 60_000)],
    )

    await resetPassword('nick', 'new-password-1')
    const row = (await libraryQuery(`SELECT password_hash FROM library_users WHERE username='nick'`)).rows[0]
    expect(await argon2.verify(row.password_hash, 'new-password-1')).toBe(true)
    expect(await argon2.verify(row.password_hash, 'old-password-1')).toBe(false)
    const session = (await libraryQuery(`SELECT revoked FROM library_sessions WHERE user_id=$1`, [userId])).rows[0]
    expect(session.revoked).toBe(true)
  })

  it('errors clearly on unknown users', async () => {
    await expect(resetPassword('ghost', 'whatever-123')).rejects.toThrow(/no such user/)
  })
})

describe('disable / enable', () => {
  it('disable revokes live sessions so the very next request 401s (P5-2 integration)', async () => {
    await createUser('nick', 'internal', 'hunter2hunter2')

    const app = express()
    app.use(express.json())
    app.use(cookieParser())
    app.use(createInternalAuthRouter((_req, _res, next) => next()))
    app.get('/api/library/ping', requireInternalUser, (_req, res) => res.json({ status: 'ok' }))

    const login = await request(app)
      .post('/api/login')
      .send({ username: 'nick', password: 'hunter2hunter2' })
    expect(login.status).toBe(200)
    const cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find(c => c.startsWith(`${SESSION_COOKIE}=`))!
      .split(';')[0]
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(200)

    await setDisabled('nick', true)
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(401)
    const sessions = (await libraryQuery(`SELECT revoked FROM library_sessions`)).rows
    expect(sessions.every(s => s.revoked === true)).toBe(true)

    // Re-enabling restores login (old revoked session stays dead).
    await setDisabled('nick', false)
    expect((await request(app).get('/api/library/ping').set('Cookie', cookie)).status).toBe(401)
    const relogin = await request(app)
      .post('/api/login')
      .send({ username: 'nick', password: 'hunter2hunter2' })
    expect(relogin.status).toBe(200)
  })

  it('audits disable and enable', async () => {
    await createUser('nick', 'internal', 'hunter2hunter2')
    await setDisabled('nick', true)
    await setDisabled('nick', false)
    const actions = (await libraryQuery(`SELECT action FROM library_audit ORDER BY id`)).rows.map(
      r => r.action,
    )
    expect(actions).toEqual(['user.create', 'user.disable', 'user.enable'])
  })
})

describe('listUsers', () => {
  it('lists username/role/status/created and never exposes hashes', async () => {
    await createUser('boss', 'admin', 'hunter2hunter2')
    await createUser('nick', 'internal', 'hunter2hunter2')
    await setDisabled('nick', true)
    const users = await listUsers()
    expect(users.map(u => u.username)).toEqual(['boss', 'nick'])
    expect(users[0]).toMatchObject({ role: 'admin', disabled: false })
    expect(users[1]).toMatchObject({ role: 'internal', disabled: true })
    expect(users[0].created_at).toBeInstanceOf(Date)
    for (const u of users) expect(JSON.stringify(u)).not.toMatch(/\$argon2/)
  })
})

describe('generatePassword', () => {
  it('produces distinct passwords of at least 16 chars', () => {
    const a = generatePassword()
    const b = generatePassword()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(16)
  })
})
