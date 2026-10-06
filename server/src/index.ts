import 'dotenv/config'
import { createApp } from './app.js'
import { requireAuthEnv } from './middleware/auth.js'
import { initUsageStore } from './services/usageStore.js'
import { isLibraryEnabled, initLibraryDb } from './services/libraryDb.js'
import { pruneExpiredSessions } from './services/internalSessions.js'
import { pruneOAuth } from './services/oauthStore.js'
import { isBucketEnabled, initLibraryBucket, syncMirror } from './services/libraryBucket.js'

// Refuse to boot without the secrets the security model depends on.
requireAuthEnv()
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set.')
  process.exit(1)
}

// App construction lives in app.ts so the auth-sweep test (P5-5) can walk
// the real router table; this file owns env validation and boot only.
const app = createApp()
const port = process.env.PORT || 3001

// With the in-memory dev store (LIBRARY_DEV_PGMEM=1), the CLI can't reach
// this process's database — seed a known dev account instead so login can
// be exercised locally. Guarded twice (flag + non-production).
async function seedDevUser(): Promise<void> {
  if (process.env.LIBRARY_DEV_PGMEM !== '1' || process.env.NODE_ENV === 'production') return
  const { createUser } = await import('./cli/users.js')
  await createUser('dev-admin', 'admin', 'dev-password-123')
  console.warn('[library] dev store seeded: user "dev-admin" / password "dev-password-123"')
}

// Dead session rows are useless for authentication but still hold a token
// hash and a user link, so they are cleared out once per boot (deploys are
// frequent enough that no scheduler is warranted). Best-effort: a failure
// here is housekeeping, never a reason to refuse traffic.
async function pruneSessions(): Promise<void> {
  try {
    const removed = await pruneExpiredSessions()
    if (removed > 0) console.log(`[library] pruned ${removed} expired/revoked session rows.`)
  } catch (err: any) {
    console.warn(`[library] session prune failed (${err?.message || err}) — rows kept, login unaffected.`)
  }
  // Same reasoning for the OAuth tables (P5-51): spent codes, abandoned
  // authorize requests and dead tokens authenticate nobody, but each row still
  // holds a hash and a user link. Separately caught so a failure in one prune
  // never skips the other.
  try {
    const removed = await pruneOAuth()
    if (removed > 0) console.log(`[library] pruned ${removed} expired OAuth rows.`)
  } catch (err: any) {
    console.warn(`[library] oauth prune failed (${err?.message || err}) — rows kept, connections unaffected.`)
  }
}

// Boot is not often enough for the OAuth tables (P5-51 security review,
// finding 9): a parked authorize request lives 10 minutes and an unattended
// instance can run for weeks, so the pending table would hold every abandoned
// request in between. One small DELETE a quarter of an hour costs nothing and
// keeps the window bounded. unref() so this timer never holds the process
// open, and the catch is deliberate — housekeeping never takes the server
// down, and the boot prune above already logs when the store is unreachable.
setInterval(() => void pruneOAuth().catch(() => {}), 15 * 60_000).unref()

// Initialize both Postgres-backed stores before accepting traffic:
// usage store falls back to in-memory, library store disables its features —
// the public map's routes never depend on either succeeding.
Promise.allSettled([
  initUsageStore(),
  initLibraryDb().then(ok => (ok ? seedDevUser().then(pruneSessions) : undefined)),
  // Bucket mirror rebuild (P5-7): the host disk is assumed ephemeral, so the
  // local library tree is re-synced from the bucket on every boot. Failures
  // log inside and never block the listen below.
  initLibraryBucket().then(async ok => {
    if (!ok) return
    const { downloaded, removed, kept } = await syncMirror()
    console.log(`[library] mirror synced: ${downloaded} downloaded, ${kept} kept, ${removed} pruned.`)
  }).catch(err => console.warn(`[library] mirror sync failed (${err?.message || err}) — file serving degraded until next restart.`)),
]).then(async results => {
  // Dev store only (LIBRARY_DEV_PGMEM=1): the in-memory catalog starts empty
  // every boot, and `npm run demo` should come up with the library already
  // there rather than asking for a press of Reindex first. Production and any
  // real Postgres keep their index across restarts and are left alone.
  const [, db, bucket] = results
  if (process.env.LIBRARY_DEV_PGMEM !== '1' || process.env.NODE_ENV === 'production') return
  // The settled values are housekeeping results, not readiness — ask the stores.
  if (db.status !== 'fulfilled' || bucket.status !== 'fulfilled' || !isLibraryEnabled() || !isBucketEnabled()) return
  try {
    const { reindexCatalog } = await import('./services/libraryCatalog.js')
    const { indexed } = await reindexCatalog()
    console.warn(`[library] dev store indexed from the bucket: ${indexed} entries`)
  } catch (err) {
    console.warn(`[library] dev index failed (${(err as Error)?.message || err}) — press Reindex in the app`)
  }
}).finally(() => {
  app.listen(port, () => {
    console.log(`BLO API server listening on port ${port}`)
  })
})

export default app
