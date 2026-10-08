import { describe, it, expect } from 'vitest'
// From `libraryDb`, not `index`: importing boot code to test a predicate
// would start a listening server as a side effect of a unit test.
import { usingInMemoryLibraryStore } from '../services/libraryDb.js'

/**
 * The guard on the dev account seeder.
 *
 * `npm run demo` sets `LIBRARY_DEV_PGMEM=1`, and the seeder used to take that
 * as proof the library was running in memory. It is not: `initLibraryDb`
 * honours the flag only when `DATABASE_URL` is unset, so a laptop with one
 * configured connected to that Postgres and then had `dev-admin` /
 * `dev-password-123`, role ADMIN, inserted into it — a known-credential
 * administrator in whatever the URL pointed at. `docs/RUN-LOCAL.md` suggests
 * that might be a hosted Neon database the team shares.
 *
 * Caught by running the documented demo command during a review and reading
 * the boot log: "[library] Postgres store ready" where the in-memory warning
 * should have been, followed by the seeding line.
 */
describe('usingInMemoryLibraryStore', () => {
  it('is true only for the dev store it is named after', () => {
    expect(usingInMemoryLibraryStore({ LIBRARY_DEV_PGMEM: '1' })).toBe(true)
  })

  it('is FALSE when a DATABASE_URL is configured, flag or no flag', () => {
    // The whole bug: the flag is ignored by `initLibraryDb` here, so the
    // seeder must be ignored too.
    expect(
      usingInMemoryLibraryStore({ LIBRARY_DEV_PGMEM: '1', DATABASE_URL: 'postgresql://x/y' }),
    ).toBe(false)
  })

  it('is false without the flag', () => {
    expect(usingInMemoryLibraryStore({})).toBe(false)
  })

  it('is false in production, both guards independently', () => {
    expect(usingInMemoryLibraryStore({ LIBRARY_DEV_PGMEM: '1', NODE_ENV: 'production' })).toBe(false)
    expect(
      usingInMemoryLibraryStore({
        LIBRARY_DEV_PGMEM: '1',
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://x/y',
      }),
    ).toBe(false)
  })
})
