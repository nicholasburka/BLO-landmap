import { describe, it, expect, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import {
  initLibraryDb,
  isLibraryEnabled,
  libraryQuery,
  closeLibraryDb,
  writeAudit,
} from './libraryDb.js'

/** Fresh in-memory Postgres pool (pg-mem) compatible with pg's Pool API.
 *  noAstCoverageCheck: pg-mem skips `CREATE TABLE IF NOT EXISTS` for existing
 *  tables and then (wrongly) flags the unexecuted AST as unsupported. */
function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

afterEach(async () => {
  await closeLibraryDb()
  vi.unstubAllEnvs()
})

describe('initLibraryDb', () => {
  it('applies the schema on a fresh database and enables the library', async () => {
    expect(await initLibraryDb(memPool())).toBe(true)
    expect(isLibraryEnabled()).toBe(true)
    // Prove each table exists and is queryable (pg-mem's information_schema
    // emits duplicate rows, so probe the tables directly).
    for (const table of ['library_users', 'library_sessions', 'library_audit']) {
      const res = await libraryQuery(`SELECT count(*) AS n FROM ${table}`)
      expect(Number(res.rows[0].n)).toBe(0)
    }
  })

  it('is idempotent and preserves data across re-init on the same database', async () => {
    const pool = memPool()
    expect(await initLibraryDb(pool)).toBe(true)
    await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'x', 'admin')`,
    )
    // Re-run schema application against the same DB (simulates a restart).
    expect(await initLibraryDb(pool)).toBe(true)
    const res = await libraryQuery(`SELECT username, role FROM library_users WHERE username = 'nick'`)
    expect(res.rows).toEqual([{ username: 'nick', role: 'admin' }])
  })

  it('enforces the role CHECK constraint', async () => {
    await initLibraryDb(memPool())
    await expect(
      libraryQuery(
        `INSERT INTO library_users (username, password_hash, role) VALUES ('x', 'x', 'superuser')`,
      ),
    ).rejects.toThrow()
  })

  it('rejects duplicate usernames', async () => {
    await initLibraryDb(memPool())
    await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'x', 'admin')`,
    )
    await expect(
      libraryQuery(
        `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'y', 'internal')`,
      ),
    ).rejects.toThrow()
  })

  it('disables library mode when DATABASE_URL is unset instead of throwing', async () => {
    vi.stubEnv('DATABASE_URL', '')
    expect(await initLibraryDb()).toBe(false)
    expect(isLibraryEnabled()).toBe(false)
    expect(() => libraryQuery('SELECT 1')).toThrow()
  })

  it('disables library mode when the schema cannot be applied', async () => {
    const broken = {
      query: () => Promise.reject(new Error('connection refused')),
      end: () => Promise.resolve(),
    } as unknown as PgPool
    expect(await initLibraryDb(broken)).toBe(false)
    expect(isLibraryEnabled()).toBe(false)
  })
})

describe('writeAudit', () => {
  it('records entries with and without a user id', async () => {
    await initLibraryDb(memPool())
    writeAudit({ actor: 'cli', action: 'user.create', target: 'nick' })
    writeAudit({ userId: 1, actor: 'nick', action: 'login.success', detail: { ip: '1.2.3.4' } })
    await vi.waitFor(async () => {
      const res = await libraryQuery('SELECT actor, action, user_id, target FROM library_audit ORDER BY id')
      expect(res.rows).toHaveLength(2)
      expect(res.rows[0]).toMatchObject({ actor: 'cli', action: 'user.create', user_id: null, target: 'nick' })
      expect(res.rows[1]).toMatchObject({ actor: 'nick', action: 'login.success', target: null })
    })
  })

  it('is a no-op when the library is disabled', async () => {
    await closeLibraryDb()
    expect(() => writeAudit({ actor: 'cli', action: 'noop' })).not.toThrow()
  })
})
