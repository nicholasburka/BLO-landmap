import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type express from 'express'
import argon2 from 'argon2'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * Auth sweep (P5-5, inverted): walk the REAL app's Express router table and
 * demand that every route NOT on the explicit PUBLIC list (a) refuses an
 * anonymous request with a bare 401 and (b), for mutating methods, refuses a
 * logged-in request that lacks X-CSRF-Token with 403. Guarded-by-default:
 * a new route that forgets requireInternalUser fails this suite instead of
 * shipping open; making a route public is a deliberate edit to PUBLIC.
 */

// Env needed to *import* the app graph (haiku.ts constructs an Anthropic
// client at module load; sessions derive HMACs from this secret).
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { SESSION_COOKIE } = await import('../services/internalSessions.js')

/** The only routes an anonymous client may reach. Each is verified to exist
 *  below, so a renamed or removed route can't leave a stale entry here. */
const PUBLIC = new Set([
  'GET /api/health', // bare liveness probe (app.ts)
  'POST /api/session', // anonymous map-token mint (session.ts)
  'POST /api/auth', // legacy password → map token (auth.ts)
  'POST /api/login', // the internal login itself (internalAuth.ts)
  'GET /dashboard', // page shell + assets hold no data (usage.ts)
  'GET /dashboard.css',
  'GET /dashboard.js',

  // OAuth 2.1 for remote MCP clients (P5-51, oauth.ts). These are public by
  // specification — a connector that has never seen this server has to be
  // able to discover it, register, and be sent to a login page — so each is
  // listed deliberately rather than swept:
  'GET /.well-known/oauth-protected-resource', // RFC 9728 metadata, no user data
  'GET /.well-known/oauth-protected-resource/mcp', // the path-inserted form MCP clients fetch
  'GET /.well-known/oauth-authorization-server', // RFC 8414 metadata, no user data
  'POST /oauth/register', // RFC 7591 registration; 10/hour/IP, stores a name and redirect URIs
  'GET /oauth/authorize', // browser entry point; anonymous → 302 to the SPA login
  'GET /oauth/authorize/continue/:id', // same, resumed after login; renders consent only with a session
  // The consent form post. Not swept because a browser form cannot send
  // X-CSRF-Token — it is guarded instead by the session cookie plus a CSRF
  // token derived from that session AND the request id (see oauth.ts), and
  // its own tests cover the missing-session (401) and bad-token (403) paths.
  'POST /oauth/authorize/decision',
  'POST /oauth/token', // credential exchange; the code/PKCE pair is the credential
  'POST /oauth/revoke', // RFC 7009; always 200, never an oracle
])

/** Public-map routes gated by the Bearer token rather than the session
 *  cookie. Anonymously they 401 like everything else; in the CSRF sweep a
 *  session cookie alone must still not open them, so they expect 401 there. */
const BEARER_GATED = new Set([
  'POST /api/query',
  'POST /api/chat',
  // The MCP endpoint (P5-50) is reached by desktop apps and scripts holding a
  // personal API token, never by a browser holding a cookie — so there is no
  // CSRF header to demand, and a session cookie alone must not open it.
  'POST /mcp',
  'DELETE /mcp',
])

/** Canaries proving the router walk still sees each mount style: app-level
 *  route, router mounted at '/', router with router.use() guard, Bearer chain. */
const EXPECTED_ROUTES = [
  'GET /api/library/ping',
  'GET /api/me',
  'GET /api/usage',
  'GET /api/health/usage',
  'POST /api/library/reindex',
  'POST /api/library/catalog/:slug/documents', // P5-80: pulls files from the outside world — swept both ways
  'PUT /api/wiki/:slug',
  'POST /api/account/password', // P5-76: swept anonymously (401) and without CSRF (403)
  'GET /api/library/file/:slug/:filename',
  // P6-4: the index over the cached place reports — who ran what, and where.
  'GET /api/library/place/reports',
  // P6-6: the text search behind /search — internal-tier like every other read.
  'GET /api/library/search-text',
  // P6-5: "recently edited" on the landing — the audit log, internal-tier.
  'GET /api/library/recent-edits',
  'POST /api/query',
  // P6-7: chat threads — the list, the streamed message route (session +
  // CSRF + budget) and the confirm-a-write route, all swept both ways.
  'GET /api/chats',
  'POST /api/chats',
  'POST /api/chats/:id/messages',
  'POST /api/chats/:id/actions/:actionId/confirm',
  // P6-8: the bulk drop, its status route and the one-entry re-run — every
  // one of them internal-tier, and the two POSTs swept for CSRF as well.
  'POST /api/library/bulk',
  'GET /api/library/bulk/:dropId',
  'POST /api/library/entries/:id/annotate',
]

const MUTATING = new Set(['post', 'put', 'patch', 'delete'])

interface DiscoveredRoute {
  method: string // lowercase, as supertest wants it
  path: string
  key: string // 'GET /api/x' — the form PUBLIC/BEARER_GATED use
}

/** Walk Express 4's router stack, recursing into mounted routers. All of
 *  our routers register absolute paths and mount at '/', so layer.route.path
 *  is the full request path. */
function collectRoutes(app: express.Express): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = []
  const walk = (stack: any[]): void => {
    for (const layer of stack) {
      if (layer.route) {
        const path = layer.route.path as string
        for (const method of Object.keys(layer.route.methods).filter(m => m !== '_all')) {
          routes.push({ method, path, key: `${method.toUpperCase()} ${path}` })
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack)
      }
    }
  }
  walk((app as any)._router.stack)
  return routes
}

/** ':slug' → 'x' so the request hits the route rather than a literal colon path. */
function concretePath(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'x')
}

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const app = createApp()
const allRoutes = collectRoutes(app)
const guardedRoutes = allRoutes.filter(r => !PUBLIC.has(r.key))

describe('router walk', () => {
  it('discovers the app’s routes at all (walk not broken by a refactor)', () => {
    expect(allRoutes.length).toBeGreaterThan(5)
    const keys = allRoutes.map(r => r.key)
    for (const expected of EXPECTED_ROUTES) expect(keys).toContain(expected)
  })

  it('every PUBLIC and BEARER_GATED entry is a real route (no stale allowlist)', () => {
    const keys = allRoutes.map(r => r.key)
    for (const key of [...PUBLIC, ...BEARER_GATED]) expect(keys).toContain(key)
  })
})

describe('unauthenticated sweep: every non-public route → bare 401', () => {
  for (const route of guardedRoutes) {
    it(`${route.key}`, async () => {
      const res = await (request(app) as any)[route.method](concretePath(route.path))
      expect(res.status).toBe(401)
      // Bare body: no content hints for probing clients (spec Example 3).
      // 'unauthorized' is the session guard, 'Unauthorized' the Bearer guard.
      expect([{ error: 'unauthorized' }, { error: 'Unauthorized' }]).toContainEqual(res.body)
    })
  }

  it('a forged session cookie is also a bare 401', async () => {
    const res = await request(app)
      .get('/api/library/ping')
      .set('Cookie', 'blo_internal_session=forged-token-000')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })
})

describe('logged-in sweep: mutating routes without X-CSRF-Token → 403', () => {
  const CREDS = { username: 'sweeper', password: 'sweep-pass-123' }
  let cookie = ''
  let dataDir = ''

  beforeAll(async () => {
    expect(await initLibraryDb(memPool())).toBe(true)
    // Minimum-cost hash (see libraryCatalog.test.ts): verify cost comes from
    // the hash's params, so this changes nothing about production wiring.
    const hash = await argon2.hash(CREDS.password, { timeCost: 2, memoryCost: 2048, parallelism: 1 })
    await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ($1, $2, 'admin')`,
      [CREDS.username, hash],
    )
    dataDir = mkdtempSync(join(tmpdir(), 'blo-sweep-test-'))
    await initLibraryBucket({ client: new FakeS3() as unknown as S3Client, bucket: 'test-bucket', dataDir })

    const res = await request(app).post('/api/login').send(CREDS)
    expect(res.status).toBe(200)
    const setCookie: string[] = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
    const raw = setCookie.find(c => c.startsWith(`${SESSION_COOKIE}=`))
    if (!raw) throw new Error('no session cookie set')
    cookie = raw.split(';')[0]
  })

  afterAll(async () => {
    await closeLibraryBucket()
    await closeLibraryDb()
    rmSync(dataDir, { recursive: true, force: true })
  })

  for (const route of guardedRoutes.filter(r => MUTATING.has(r.method))) {
    it(`${route.key}`, async () => {
      const res = await (request(app) as any)[route.method](concretePath(route.path)).set('Cookie', cookie)
      if (BEARER_GATED.has(route.key)) {
        // A session cookie is not a Bearer token.
        expect(res.status).toBe(401)
        return
      }
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: 'forbidden' })
    })
  }

  it('login with a disallowed Origin never emits a session cookie, even with correct credentials', async () => {
    // CORS rejects before routing (403); the login handler's own Origin check
    // is the backstop should CORS ever be loosened. Either way: no cookie.
    const res = await request(app).post('/api/login').set('Origin', 'https://evil.example').send(CREDS)
    expect([401, 403]).toContain(res.status)
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})
