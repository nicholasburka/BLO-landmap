import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import argon2 from 'argon2'
import { createHash, randomBytes } from 'node:crypto'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P5-51: the OAuth 2.1 authorization server, end to end through the REAL
 * createApp() — helmet, CORS, cookie parsing and all — so the chain under
 * test is production's: metadata → register → authorize → login detour →
 * consent → code → token → /mcp → refresh → reuse detection → revoke.
 *
 * Every rejection path gets a case, because in an authorization server the
 * rejections ARE the feature: a redirect that should have been an error page,
 * a code that could be spent twice, or a refresh token that survives a replay
 * is the whole vulnerability.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'
process.env.OAUTH_ISSUER = 'https://api.example.com'
process.env.PUBLIC_SITE_URL = 'https://blacklandownership.org'

const { createApp } = await import('../app.js')
const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { SESSION_COOKIE, createSession, csrfTokenFor } = await import('../services/internalSessions.js')
const { resetInternalRateLimit } = await import('../middleware/internalRateLimit.js')
const { resetOAuthRateLimits } = await import('../middleware/rateLimit.js')
const oauthStore = await import('../services/oauthStore.js')
const { clearApiTokenTouchCache } = await import('../services/apiTokens.js')

const ISSUER = 'https://api.example.com'
const RESOURCE = `${ISSUER}/mcp`
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'
const CREDS = { username: 'maria', password: 'oauth-pass-123' }

const app = createApp()

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let passwordHash: string
beforeAll(async () => {
  passwordHash = await argon2.hash(CREDS.password, { timeCost: 2, memoryCost: 2048, parallelism: 1 })
})

let cookie = ''
let csrfToken = ''
let userId = 0

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  await resetInternalRateLimit()
  await resetOAuthRateLimits()
  oauthStore.clearOAuthTouchCache()
  clearApiTokenTouchCache()
  process.env.OAUTH_ISSUER = ISSUER
  process.env.PUBLIC_SITE_URL = 'https://blacklandownership.org'

  const res = await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ($1, $2, 'internal') RETURNING id`,
    [CREDS.username, passwordHash],
  )
  userId = Number((res.rows[0] as { id: unknown }).id)

  // Mint the session directly rather than through POST /api/login: that
  // endpoint's 10/hour brute-force limiter is shared process state and would
  // lock this suite out after ten cases. The cookie is byte-identical.
  const session = await createSession(userId)
  cookie = `${SESSION_COOKIE}=${session.token}`
  csrfToken = csrfTokenFor(session.token)
})

afterEach(async () => {
  await closeLibraryDb()
})

// --- helpers ----------------------------------------------------------------

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Register through the store rather than the endpoint, so the 10/hour
 *  registration limiter only counts the cases that are actually about it. */
async function client(overrides: Partial<Parameters<typeof oauthStore.registerClient>[0]> = {}) {
  return oauthStore.registerClient({
    clientName: 'ChatGPT',
    redirectUris: [REDIRECT],
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: ['read', 'write'],
    ...overrides,
  })
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: 'read',
    state: 'state-abc',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    ...extra,
  }
}

/** Walk authorize → consent → Allow and return the code from the redirect. */
async function grantCode(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const consent = await request(app)
    .get('/oauth/authorize')
    .set('Cookie', cookie)
    .query(authorizeQuery(clientId, challenge, extra))
  expect(consent.status).toBe(200)
  const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
  expect(pendingId).toBeTruthy()
  const decision = await request(app)
    .post('/oauth/authorize/decision')
    .set('Cookie', cookie)
    .type('form')
    .send({ pending_id: pendingId, csrf, decision: 'allow' })
  expect(decision.status).toBe(302)
  const url = new URL(decision.headers.location)
  return { code: url.searchParams.get('code') ?? '', state: url.searchParams.get('state'), pendingId, csrf }
}

async function exchange(clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) {
  return request(app).post('/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    ...extra,
  })
}

/** A full authorization, for the tests that start from "already connected". */
async function connected() {
  const c = await client()
  const { verifier, challenge } = pkce()
  const { code } = await grantCode(c.clientId, challenge)
  const token = await exchange(c.clientId, code, verifier)
  expect(token.status).toBe(200)
  return { client: c, tokens: token.body as Record<string, string> }
}

// --- metadata ---------------------------------------------------------------

describe('metadata (RFC 9728 / RFC 8414)', () => {
  it('publishes protected-resource metadata at both well-known paths, unauthenticated', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await request(app).get(path)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['read', 'write'],
        bearer_methods_supported: ['header'],
      })
      expect(res.headers['cache-control']).toContain('max-age=3600')
    }
  })

  it('publishes authorization-server metadata: code + PKCE S256, public clients only', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      revocation_endpoint: `${ISSUER}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
    })
    // No implicit grant, no password grant, no client secrets — ever.
    expect(res.body.grant_types_supported).not.toContain('implicit')
    expect(res.body.grant_types_supported).not.toContain('password')
  })

  it('reports itself unavailable when no issuer is configured', async () => {
    delete process.env.OAUTH_ISSUER
    const res = await request(app).get('/.well-known/oauth-authorization-server')
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('temporarily_unavailable')
  })
})

// --- registration -----------------------------------------------------------

describe('dynamic client registration (RFC 7591)', () => {
  const good = { client_name: 'ChatGPT', redirect_uris: [REDIRECT] }

  it('registers a public client and returns no secret', async () => {
    const res = await request(app).post('/oauth/register').send(good)
    expect(res.status).toBe(201)
    expect(res.body.client_id).toBeTruthy()
    expect(res.body.token_endpoint_auth_method).toBe('none')
    expect(res.body.redirect_uris).toEqual([REDIRECT])
    expect(res.body).not.toHaveProperty('client_secret')
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('accepts an http loopback redirect (a desktop client on a local port)', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'Local', redirect_uris: ['http://127.0.0.1:33418/callback'] })
    expect(res.status).toBe(201)
  })

  it('refuses plain http anywhere but the loopback', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'Sketchy', redirect_uris: ['http://evil.example/cb'] })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_redirect_uri')
  })

  it('refuses a redirect with a fragment', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'X', redirect_uris: ['https://x.example/cb#frag'] })
    expect(res.status).toBe(400)
  })

  it('refuses more than five redirect URIs', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'X', redirect_uris: Array.from({ length: 6 }, (_, i) => `https://x.example/${i}`) })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_redirect_uri')
  })

  it('refuses no redirect URIs and no name', async () => {
    expect((await request(app).post('/oauth/register').send({ client_name: 'X' })).status).toBe(400)
    expect((await request(app).post('/oauth/register').send({ redirect_uris: [REDIRECT] })).status).toBe(400)
  })

  it('refuses a client that wants to authenticate with a secret', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ ...good, token_endpoint_auth_method: 'client_secret_post' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_client_metadata')
  })

  it('refuses unsupported grant and response types', async () => {
    expect(
      (await request(app).post('/oauth/register').send({ ...good, grant_types: ['implicit'] })).status,
    ).toBe(400)
    expect(
      (await request(app).post('/oauth/register').send({ ...good, response_types: ['token'] })).status,
    ).toBe(400)
  })

  it('is rate limited to 10 per hour per address', async () => {
    // Nine more (this suite's earlier cases are reset per test).
    for (let i = 0; i < 10; i++) await request(app).post('/oauth/register').send(good)
    const res = await request(app).post('/oauth/register').send(good)
    expect(res.status).toBe(429)
  })
})

// --- authorize --------------------------------------------------------------

describe('authorize: client and redirect failures render a page, never a redirect', () => {
  it('an unknown client gets an error page', async () => {
    const { challenge } = pkce()
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery('made-up', challenge))
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers.location).toBeUndefined()
  })

  it('a redirect_uri the client never registered gets an error page — not an open redirect', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .query(authorizeQuery(c.clientId, challenge, { redirect_uri: 'https://evil.example/steal' }))
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
    expect(res.text).not.toContain('evil.example')
  })

  it('a near-miss redirect (extra path segment) is still a mismatch', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .query(authorizeQuery(c.clientId, challenge, { redirect_uri: `${REDIRECT}/extra` }))
    expect(res.status).toBe(400)
    expect(res.headers.location).toBeUndefined()
  })
})

describe('authorize: parameter failures redirect with error and state', () => {
  async function reject(extra: Record<string, string>, expected: string) {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge, extra))
    expect(res.status).toBe(302)
    const url = new URL(res.headers.location)
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('error')).toBe(expected)
    // state is echoed so the client can match the answer to its request.
    expect(url.searchParams.get('state')).toBe('state-abc')
    expect(url.searchParams.get('code')).toBeNull()
  }

  it('rejects a response_type other than code', () => reject({ response_type: 'token' }, 'unsupported_response_type'))

  it('rejects a missing code_challenge — PKCE is mandatory', async () => {
    const c = await client()
    const res = await request(app).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: REDIRECT,
      state: 'state-abc',
      resource: RESOURCE,
    })
    expect(res.status).toBe(302)
    expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_request')
  })

  it('rejects code_challenge_method=plain', () => reject({ code_challenge_method: 'plain' }, 'invalid_request'))

  it('rejects a resource that is not this MCP server', () =>
    reject({ resource: 'https://evil.example/mcp' }, 'invalid_target'))

  it('rejects an unknown scope', () => reject({ scope: 'read admin' }, 'invalid_scope'))

  it('rejects a scope the client never registered for', async () => {
    const c = await client({ scopes: ['read'] })
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .query(authorizeQuery(c.clientId, challenge, { scope: 'read write' }))
    expect(new URL(res.headers.location).searchParams.get('error')).toBe('invalid_scope')
  })

  it('rejects a repeated parameter (parameter pollution)', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .query(`${new URLSearchParams(authorizeQuery(c.clientId, challenge)).toString()}&scope=write`)
    expect(res.status).toBe(302)
    expect(new URL(res.headers.location).searchParams.get('error')).toBeTruthy()
  })
})

describe('authorize: the login detour', () => {
  it('sends an anonymous visitor to the SPA login with an opaque pending id and no URL', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))
    expect(res.status).toBe(302)
    const url = new URL(res.headers.location)
    expect(url.origin).toBe('https://blacklandownership.org')
    expect(url.pathname).toBe('/login')
    const redirect = url.searchParams.get('redirect') ?? ''
    // A fixed path on the SPA's own origin plus an id — nothing to redirect to.
    expect(redirect).toMatch(/^\/account\?oauth=[A-Za-z0-9_-]+$/)
    expect(redirect).not.toContain('http')
    // The pending id in the URL is not the id stored: the row keeps a hash.
    const id = redirect.split('=')[1]
    const rows = await libraryQuery(`SELECT id_hash FROM library_oauth_pending`)
    expect((rows.rows[0] as { id_hash: string }).id_hash).toBe(createHash('sha256').update(id).digest('hex'))
  })

  it('the account page can name the waiting app, and only to a logged-in user', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))
    const id = (new URL(res.headers.location).searchParams.get('redirect') ?? '').split('=')[1]

    expect((await request(app).get(`/api/library/oauth/pending/${id}`)).status).toBe(401)
    const named = await request(app).get(`/api/library/oauth/pending/${id}`).set('Cookie', cookie)
    expect(named.status).toBe(200)
    expect(named.body.clientName).toBe('ChatGPT')
    expect(named.body.scopeDescriptions[0]).toContain('Read the library')
  })

  it('continue re-renders the consent screen after login, and 404s an expired request', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))
    const id = (new URL(res.headers.location).searchParams.get('redirect') ?? '').split('=')[1]

    const consent = await request(app).get(`/oauth/authorize/continue/${id}`).set('Cookie', cookie)
    expect(consent.status).toBe(200)
    expect(consent.text).toContain('ChatGPT')

    await libraryQuery(`UPDATE library_oauth_pending SET expires_at = $1`, [new Date(Date.now() - 1000)])
    const gone = await request(app).get(`/oauth/authorize/continue/${id}`).set('Cookie', cookie)
    expect(gone.status).toBe(400)
  })

  it('continue without a session goes back to the login page, not to the client', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))
    const id = (new URL(res.headers.location).searchParams.get('redirect') ?? '').split('=')[1]
    const again = await request(app).get(`/oauth/authorize/continue/${id}`)
    expect(again.status).toBe(302)
    expect(new URL(again.headers.location).origin).toBe('https://blacklandownership.org')
  })
})

describe('consent screen', () => {
  it('names the app, says what it may do in plain words, and carries a CSRF token', async () => {
    const c = await client()
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge))
    expect(res.status).toBe(200)
    expect(res.text).toContain('ChatGPT')
    expect(res.text).toContain('Read the library')
    expect(res.text).toMatch(/name="csrf" value="[0-9a-f]{64}"/)
    // Same-origin, no script anywhere — it must survive the strict helmet CSP.
    expect(res.text).not.toMatch(/<script/i)
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('escapes a hostile client name rather than rendering it', async () => {
    const c = await client({ clientName: '<script>alert(1)</script>' })
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge))
    expect(res.status).toBe(200)
    expect(res.text).not.toContain('<script>alert(1)</script>')
    expect(res.text).toContain('&lt;script&gt;')
  })

  it('Allow issues a single-use code and echoes state', async () => {
    const c = await client()
    const { challenge } = pkce()
    const { code, state } = await grantCode(c.clientId, challenge)
    expect(code).toBeTruthy()
    expect(state).toBe('state-abc')
    // Stored hashed, never in the clear.
    const rows = await libraryQuery(`SELECT code_hash FROM library_oauth_codes`)
    expect((rows.rows[0] as { code_hash: string }).code_hash).toBe(createHash('sha256').update(code).digest('hex'))
  })

  it('Deny returns access_denied and mints nothing', async () => {
    const c = await client()
    const { challenge } = pkce()
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge))
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'deny' })
    expect(res.status).toBe(302)
    const url = new URL(res.headers.location)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('state-abc')
    expect((await libraryQuery(`SELECT id FROM library_oauth_codes`)).rows).toHaveLength(0)
  })

  it('a forged or missing CSRF token cannot approve anything', async () => {
    const c = await client()
    const { challenge } = pkce()
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge))
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]

    for (const csrf of [undefined, '', 'a'.repeat(64)]) {
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .set('Cookie', cookie)
        .type('form')
        .send({ pending_id: pendingId, ...(csrf === undefined ? {} : { csrf }), decision: 'allow' })
      expect(res.status).toBe(403)
      expect(res.headers.location).toBeUndefined()
    }
    expect((await libraryQuery(`SELECT id FROM library_oauth_codes`)).rows).toHaveLength(0)
  })

  it('a CSRF token from one request cannot approve another', async () => {
    const c = await client()
    const first = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    const second = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    const firstCsrf = /name="csrf" value="([^"]+)"/.exec(first.text)?.[1]
    const secondId = /name="pending_id" value="([^"]+)"/.exec(second.text)?.[1]
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: secondId, csrf: firstCsrf, decision: 'allow' })
    expect(res.status).toBe(403)
  })

  it('refuses an approval posted from another origin', async () => {
    const c = await client()
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    // CORS rejects first (403); the handler's own Origin check is the backstop
    // if CORS is ever loosened. Either way nothing is approved.
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(res.status).toBe(403)
    expect((await libraryQuery(`SELECT id FROM library_oauth_codes`)).rows).toHaveLength(0)
  })

  it('the authorize endpoint is rate limited — a parked request writes a row', async () => {
    const c = await client()
    const { challenge } = pkce()
    let last = 0
    for (let i = 0; i < 31; i++) {
      last = (await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))).status
    }
    expect(last).toBe(429)
  })

  it('an approval without a session is refused', async () => {
    const c = await client()
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(res.status).toBe(401)
  })

  it('one approval mints one code: a resubmit finds the request already spent', async () => {
    const c = await client()
    const { challenge } = pkce()
    const { pendingId, csrf } = await grantCode(c.clientId, challenge)
    const again = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(again.status).toBe(400)
    expect((await libraryQuery(`SELECT id FROM library_oauth_codes`)).rows).toHaveLength(1)
  })
})

// --- token ------------------------------------------------------------------

describe('token: authorization_code grant', () => {
  it('exchanges a code for a Bearer pair with the granted scope', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const res = await exchange(c.clientId, code, verifier)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read' })
    expect(res.body.access_token).toMatch(/^blo_at_/)
    expect(res.body.refresh_token).toMatch(/^blo_rt_/)
    expect(res.headers['cache-control']).toContain('no-store')
  })

  it('accepts a matching resource parameter and refuses a different one', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const wrong = await exchange(c.clientId, code, verifier, { resource: 'https://evil.example/mcp' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toBe('invalid_target')
    // The code survived the rejection, so the honest client can still use it.
    const ok = await exchange(c.clientId, code, verifier, { resource: RESOURCE })
    expect(ok.status).toBe(200)
  })

  it('refuses a wrong PKCE verifier', async () => {
    const c = await client()
    const { challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const res = await exchange(c.clientId, code, randomBytes(32).toString('base64url'))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
    expect(JSON.stringify(res.body)).not.toContain(code)
  })

  it('refuses a missing verifier — a stolen code alone is worthless', async () => {
    const c = await client()
    const { challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: c.clientId, code, redirect_uri: REDIRECT })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_request')
  })

  it('refuses a different redirect_uri than the one the code was bound to', async () => {
    const c = await client({ redirectUris: [REDIRECT, 'https://chatgpt.com/other'] })
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const res = await exchange(c.clientId, code, verifier, { redirect_uri: 'https://chatgpt.com/other' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('refuses another client presenting the code', async () => {
    const c = await client()
    const other = await client({ clientName: 'Impostor' })
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const res = await exchange(other.clientId, code, verifier)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('refuses an unknown client with invalid_client', async () => {
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: 'made-up',
      code: 'x',
      redirect_uri: REDIRECT,
      code_verifier: 'y'.repeat(43),
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_client')
  })

  it('refuses an expired code', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    await libraryQuery(`UPDATE library_oauth_codes SET expires_at = $1`, [new Date(Date.now() - 1000)])
    const res = await exchange(c.clientId, code, verifier)
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('a reused code fails AND revokes everything the first exchange produced', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const first = await exchange(c.clientId, code, verifier)
    expect(first.status).toBe(200)

    const replay = await exchange(c.clientId, code, verifier)
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe('invalid_grant')

    // The tokens from the honest exchange are dead too: one of the two copies
    // of that code was a thief's, and we cannot tell which.
    expect(await oauthStore.getOAuthAccessPrincipal(first.body.access_token, RESOURCE)).toBeNull()
    const refresh = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: first.body.refresh_token,
    })
    expect(refresh.status).toBe(400)

    const audit = await libraryQuery(`SELECT action FROM library_audit WHERE action = 'oauth.reuse'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('refuses an unsupported grant type', async () => {
    const c = await client()
    const res = await request(app)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'password', client_id: c.clientId, username: 'maria', password: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('unsupported_grant_type')
  })

  it('audits the grant with the client and scopes, and no secret', async () => {
    const c = await client()
    const { challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const rows = await libraryQuery(`SELECT actor, action, target, detail FROM library_audit WHERE action = 'oauth.grant'`)
    expect(rows.rows).toHaveLength(1)
    const row = rows.rows[0] as { actor: string; target: string; detail: unknown }
    expect(row.actor).toBe('maria')
    expect(row.target).toBe(c.clientId)
    const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail
    expect(detail).toEqual({ client: 'ChatGPT', scopes: ['read'] })
    expect(JSON.stringify(rows.rows)).not.toContain(code)
  })
})

describe('token: refresh_token grant', () => {
  it('rotates: a new pair is issued and the old refresh token stops working', async () => {
    const { client: c, tokens } = await connected()
    const rotated = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    expect(rotated.status).toBe(200)
    expect(rotated.body.refresh_token).not.toBe(tokens.refresh_token)
    expect(rotated.body.access_token).not.toBe(tokens.access_token)
    // The new access token works.
    expect(await oauthStore.getOAuthAccessPrincipal(rotated.body.access_token, RESOURCE)).not.toBeNull()
  })

  it('a replayed refresh token revokes the entire family', async () => {
    const { client: c, tokens } = await connected()
    const rotated = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    expect(rotated.status).toBe(200)

    const replay = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe('invalid_grant')

    // Everything in the family is dead, including the pair just rotated in.
    expect(await oauthStore.getOAuthAccessPrincipal(rotated.body.access_token, RESOURCE)).toBeNull()
    const after = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: rotated.body.refresh_token,
    })
    expect(after.status).toBe(400)
  })

  it('refuses another client’s refresh token', async () => {
    const { tokens } = await connected()
    const other = await client({ clientName: 'Impostor' })
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: other.clientId,
      refresh_token: tokens.refresh_token,
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('refuses a revoked or expired refresh token', async () => {
    const { client: c, tokens } = await connected()
    await libraryQuery(`UPDATE library_oauth_tokens SET revoked_at = now() WHERE kind = 'refresh'`)
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    expect(res.status).toBe(400)
  })

  it('may narrow scope but never widen it', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge, { scope: 'read write' })
    const first = await exchange(c.clientId, code, verifier)
    expect(first.body.scope).toBe('read write')

    const narrowed = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: first.body.refresh_token,
      scope: 'read',
    })
    expect(narrowed.status).toBe(200)
    expect(narrowed.body.scope).toBe('read')

    const widened = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: narrowed.body.refresh_token,
      scope: 'read write',
    })
    expect(widened.status).toBe(400)
    expect(widened.body.error).toBe('invalid_scope')
  })

  it('audits the refresh', async () => {
    const { client: c, tokens } = await connected()
    await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    const rows = await libraryQuery(`SELECT id FROM library_audit WHERE action = 'oauth.refresh'`)
    expect(rows.rows).toHaveLength(1)
  })
})

// --- revocation -------------------------------------------------------------

describe('revocation (RFC 7009)', () => {
  it('revokes an access token and answers 200', async () => {
    const { client: c, tokens } = await connected()
    const res = await request(app)
      .post('/oauth/revoke')
      .type('form')
      .send({ token: tokens.access_token, client_id: c.clientId })
    expect(res.status).toBe(200)
    expect(await oauthStore.getOAuthAccessPrincipal(tokens.access_token, RESOURCE)).toBeNull()
  })

  it('revoking a refresh token takes the whole family with it', async () => {
    const { client: c, tokens } = await connected()
    await request(app).post('/oauth/revoke').type('form').send({ token: tokens.refresh_token, client_id: c.clientId })
    expect(await oauthStore.getOAuthAccessPrincipal(tokens.access_token, RESOURCE)).toBeNull()
  })

  it('answers 200 for an unknown token — never an oracle', async () => {
    const res = await request(app).post('/oauth/revoke').type('form').send({ token: 'blo_at_made-up' })
    expect(res.status).toBe(200)
    expect(res.text).toBe('')
  })

  it('ignores a revocation from a client the token was not issued to', async () => {
    const { tokens } = await connected()
    const other = await client({ clientName: 'Impostor' })
    await request(app).post('/oauth/revoke').type('form').send({ token: tokens.access_token, client_id: other.clientId })
    expect(await oauthStore.getOAuthAccessPrincipal(tokens.access_token, RESOURCE)).not.toBeNull()
  })
})

// --- the resource server ----------------------------------------------------

describe('/mcp as an OAuth resource server', () => {
  const RPC = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  const ACCEPT = 'application/json, text/event-stream'

  it('a 401 points at the protected-resource metadata so a connector can self-serve', async () => {
    const res = await request(app).post('/mcp').set('Accept', ACCEPT).send(RPC)
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    )
  })

  it('a bad token gets error="invalid_token" alongside the pointer', async () => {
    const res = await request(app).post('/mcp').set('Authorization', 'Bearer blo_at_nope').set('Accept', ACCEPT).send(RPC)
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"')
    expect(res.headers['www-authenticate']).toContain('resource_metadata=')
  })

  it('an OAuth access token reaches the tools', async () => {
    const { tokens } = await connected()
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(res.status).toBe(200)
    expect(res.body.result.tools.length).toBeGreaterThan(0)
  })

  it('a personal token still reaches the tools (P5-50 unchanged)', async () => {
    const { createApiToken } = await import('../services/apiTokens.js')
    const minted = await createApiToken(userId, 'Claude Desktop')
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${minted.token}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(res.status).toBe(200)
  })

  it('a token without the read scope is 403, with the scope named', async () => {
    const c = await client({ scopes: ['write'] })
    const issued = await oauthStore.issueTokenPair({
      userId,
      clientId: c.clientId,
      scopes: ['write'],
      resource: RESOURCE,
    })
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${issued.accessToken}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(res.status).toBe(403)
    expect(res.headers['www-authenticate']).toContain('error="insufficient_scope"')
    expect(res.headers['www-authenticate']).toContain('scope="read"')
  })

  it('a token minted for another resource is not accepted here', async () => {
    const c = await client()
    const issued = await oauthStore.issueTokenPair({
      userId,
      clientId: c.clientId,
      scopes: ['read'],
      resource: 'https://evil.example/mcp',
    })
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${issued.accessToken}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(res.status).toBe(401)
  })

  it('a revoked grant closes the door on the next request', async () => {
    const { tokens } = await connected()
    const grants = await request(app).get('/api/library/oauth/grants').set('Cookie', cookie)
    await request(app)
      .delete(`/api/library/oauth/grants/${encodeURIComponent(grants.body.grants[0].id)}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(res.status).toBe(401)
  })
})

// --- the account page's connected apps --------------------------------------

describe('connected apps (account page)', () => {
  it('lists a grant with its client, scopes and dates', async () => {
    await connected()
    const res = await request(app).get('/api/library/oauth/grants').set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body.grants).toHaveLength(1)
    expect(res.body.grants[0]).toMatchObject({ clientName: 'ChatGPT', scopes: ['read'] })
    expect(res.body.grants[0].createdAt).toBeTruthy()
  })

  it('needs a session, and a CSRF header to revoke', async () => {
    await connected()
    expect((await request(app).get('/api/library/oauth/grants')).status).toBe(401)
    const grants = await request(app).get('/api/library/oauth/grants').set('Cookie', cookie)
    const id = grants.body.grants[0].id
    const noCsrf = await request(app).delete(`/api/library/oauth/grants/${encodeURIComponent(id)}`).set('Cookie', cookie)
    expect(noCsrf.status).toBe(403)
  })

  it('revoke removes the grant and audits it', async () => {
    await connected()
    const grants = await request(app).get('/api/library/oauth/grants').set('Cookie', cookie)
    const id = grants.body.grants[0].id
    const res = await request(app)
      .delete(`/api/library/oauth/grants/${encodeURIComponent(id)}`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
    expect(res.status).toBe(200)
    expect((await request(app).get('/api/library/oauth/grants').set('Cookie', cookie)).body.grants).toEqual([])
    const audit = await libraryQuery(`SELECT id FROM library_audit WHERE action = 'oauth.revoke'`)
    expect(audit.rows).toHaveLength(1)
  })

  it('an unknown grant id is a 404, not a hint', async () => {
    const res = await request(app)
      .delete('/api/library/oauth/grants/made-up')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrfToken)
    expect(res.status).toBe(404)
  })
})

// --- no secrets anywhere they shouldn't be ---------------------------------

describe('nothing replayable is stored or logged', () => {
  it('no raw code or token appears in any table', async () => {
    const { tokens } = await connected()
    for (const table of ['library_oauth_codes', 'library_oauth_tokens', 'library_oauth_pending', 'library_audit']) {
      const rows = await libraryQuery(`SELECT * FROM ${table}`)
      const dump = JSON.stringify(rows.rows)
      expect(dump).not.toContain(tokens.access_token)
      expect(dump).not.toContain(tokens.refresh_token)
      expect(dump).not.toContain('blo_at_')
      expect(dump).not.toContain('blo_rt_')
    }
  })
})

// --- security review follow-ups (P5-51 hardening) --------------------------

describe('consent screen: what a human needs to judge a self-registered app (finding 3)', () => {
  async function consentPage(overrides: Partial<Parameters<typeof oauthStore.registerClient>[0]> = {}) {
    const c = await client(overrides)
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge))
    expect(res.status).toBe(200)
    return { client: c, res }
  }

  it('says which account is about to be connected', async () => {
    const { res } = await consentPage()
    // Without this, a person who is signed in as someone else (a shared
    // machine, a second account) hands over the wrong library.
    expect(res.text).toContain('You are signed in as')
    expect(res.text).toContain('maria')
  })

  it('shows the redirect HOST on its own line, not buried in a full URL', async () => {
    const { res } = await consentPage()
    // The host is the only part of the redirect that says WHERE the code goes;
    // a long path can push it out of sight.
    expect(res.text).toMatch(/class="host"[^>]*>[\s\S]*?chatgpt\.com/)
  })

  it('warns on every consent page that the app registered itself and is unreviewed', async () => {
    const { res } = await consentPage()
    expect(res.text).toContain('registered itself')
    expect(res.text).toMatch(/not.{0,40}reviewed/i)
    expect(res.text).toContain('Only continue if you set this connection up yourself just now')
    expect(res.text).toMatch(/class="warning"/)
  })

  it('dates the registration in words a human can act on', async () => {
    const { client: c, res } = await consentPage()
    expect(res.text).toMatch(/registered .* ago/)

    await libraryQuery(`UPDATE library_oauth_clients SET created_at = $1 WHERE client_id = $2`, [
      new Date(Date.now() - 2 * 60 * 1000),
      c.clientId,
    ])
    const { challenge } = pkce()
    const later = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge))
    expect(later.text).toContain('registered 2 minutes ago')
  })

  it('escapes the host and the username like everything else', async () => {
    const c = await client({ clientName: 'X', redirectUris: ['https://xn--evil-<script>.example/cb'] })
    // (An unregisterable name would have been refused; this asserts the page
    // never interpolates raw.)
    expect(c.clientId).toBeTruthy()
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge, { redirect_uri: c.redirectUris[0] }))
    expect(res.text).not.toContain('<script>')
  })

  it('only uses the redirect origin in form-action when it is a bare origin (finding 8)', async () => {
    // A ';' is legal in a URL host and would open a second CSP directive.
    const c = await client({ redirectUris: ['https://a;b/cb'] })
    const { challenge } = pkce()
    const res = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, challenge, { redirect_uri: 'https://a;b/cb' }))
    expect(res.status).toBe(200)
    const csp = res.headers['content-security-policy']
    expect(csp).toContain("form-action 'self'")
    expect(csp).not.toContain('a;b')

    // An ordinary origin is still widened, or the POST's 302 would be blocked.
    const ok = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery((await client()).clientId, pkce().challenge))
    expect(ok.headers['content-security-policy']).toContain("form-action 'self' https://chatgpt.com")
  })
})

describe('a request parked by one session and approved by another (accepted behaviour)', () => {
  it('approves as the session that clicks Allow, and tells that person who they are', async () => {
    // The pending row holds no user: it is a validated REQUEST, not a
    // decision. Whoever completes it grants their own library, which is why
    // the consent page names the signed-in account and carries the
    // "this app registered itself" band — those are the mitigation.
    const c = await client()
    const { verifier, challenge } = pkce()
    const parked = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))
    const pendingId = (new URL(parked.headers.location).searchParams.get('redirect') ?? '').split('=')[1]

    const other = await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'x', 'admin') RETURNING id`,
    )
    const otherId = Number((other.rows[0] as { id: unknown }).id)
    const { createSession } = await import('../services/internalSessions.js')
    const otherSession = await createSession(otherId)
    const otherCookie = `${SESSION_COOKIE}=${otherSession.token}`

    const consent = await request(app).get(`/oauth/authorize/continue/${pendingId}`).set('Cookie', otherCookie)
    expect(consent.status).toBe(200)
    expect(consent.text).toContain('nick')
    expect(consent.text).toContain('You are signed in as')
    expect(consent.text).toContain('Only continue if you set this connection up yourself just now')

    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const decision = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', otherCookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(decision.status).toBe(302)
    const code = new URL(decision.headers.location).searchParams.get('code') ?? ''
    const token = await exchange(c.clientId, code, verifier)
    expect(token.status).toBe(200)
    // The token belongs to the approver, not to whoever started the flow.
    const principal = await oauthStore.getOAuthAccessPrincipal(token.body.access_token, RESOURCE)
    expect(principal?.user.username).toBe('nick')
  })
})

describe('the pending endpoint tells the account page what it needs (findings 3 and 10)', () => {
  it('returns the registration time and the redirect host alongside the name', async () => {
    const c = await client()
    const { challenge } = pkce()
    const parked = await request(app).get('/oauth/authorize').query(authorizeQuery(c.clientId, challenge))
    const id = (new URL(parked.headers.location).searchParams.get('redirect') ?? '').split('=')[1]

    const res = await request(app).get(`/api/library/oauth/pending/${id}`).set('Cookie', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ clientName: 'ChatGPT', redirectHost: 'chatgpt.com' })
    expect(Date.parse(res.body.registeredAt)).toBeGreaterThan(0)
    // Still nothing replayable in the JSON.
    expect(JSON.stringify(res.body)).not.toContain('blo_')
  })
})

describe('RFC 9207: the issuer identifies itself in every redirect (finding 12)', () => {
  it('adds iss to a successful authorization redirect', async () => {
    const c = await client()
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(new URL(res.headers.location).searchParams.get('iss')).toBe(ISSUER)
  })

  it('adds iss to an error redirect and to a denial', async () => {
    const c = await client()
    const bad = await request(app)
      .get('/oauth/authorize')
      .query(authorizeQuery(c.clientId, pkce().challenge, { response_type: 'token' }))
    const errorUrl = new URL(bad.headers.location)
    expect(errorUrl.searchParams.get('error')).toBe('unsupported_response_type')
    expect(errorUrl.searchParams.get('iss')).toBe(ISSUER)

    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const denied = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'deny' })
    expect(new URL(denied.headers.location).searchParams.get('iss')).toBe(ISSUER)
  })
})

describe('state edge cases', () => {
  it('omits state entirely when the client sent none, and still sends iss', async () => {
    const c = await client()
    const { challenge } = pkce()
    const query = authorizeQuery(c.clientId, challenge)
    delete (query as Record<string, string>).state
    const consent = await request(app).get('/oauth/authorize').set('Cookie', cookie).query(query)
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    const url = new URL(res.headers.location)
    expect(url.searchParams.get('code')).toBeTruthy()
    expect(url.searchParams.has('state')).toBe(false)
    expect(url.searchParams.get('iss')).toBe(ISSUER)
  })

  it('treats an empty state as no state rather than echoing a blank', async () => {
    const c = await client()
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge, { state: '' }))
    expect(consent.status).toBe(200)
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const res = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(new URL(res.headers.location).searchParams.get('state')).toBeNull()
  })

  it('echoes a 512-character state byte for byte, and refuses 513', async () => {
    const c = await client()
    const long = 'z'.repeat(512)
    const consent = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge, { state: long }))
    expect(consent.status).toBe(200)
    const pendingId = /name="pending_id" value="([^"]+)"/.exec(consent.text)?.[1]
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)?.[1]
    const allowed = await request(app)
      .post('/oauth/authorize/decision')
      .set('Cookie', cookie)
      .type('form')
      .send({ pending_id: pendingId, csrf, decision: 'allow' })
    expect(new URL(allowed.headers.location).searchParams.get('state')).toBe(long)

    const tooLong = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge, { state: 'z'.repeat(513) }))
    expect(tooLong.status).toBe(302)
    const url = new URL(tooLong.headers.location)
    expect(url.searchParams.get('error')).toBe('invalid_request')
    // An over-long state is not echoed — it is the thing being refused.
    expect(url.searchParams.has('state')).toBe(false)
  })
})

describe('registration hardening (findings 2 and 7)', () => {
  it('grants only read when the client asks for no scope', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'Quiet', redirect_uris: [REDIRECT] })
    expect(res.status).toBe(201)
    // Silence is not a request for everything: write is granted only on ask.
    expect(res.body.scope).toBe('read')
  })

  it('still honours an explicit scope request', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'Loud', redirect_uris: [REDIRECT], scope: 'read write' })
    expect(res.body.scope).toBe('read write')
  })

  it('audits a registration without archiving the redirect URIs', async () => {
    await request(app)
      .post('/oauth/register')
      .send({
        client_name: 'Noisy',
        redirect_uris: [REDIRECT, 'https://chatgpt.com/second?token=abc'],
      })
    const rows = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'oauth.register'`)
    expect(rows.rows).toHaveLength(1)
    const raw = (rows.rows[0] as { detail: unknown }).detail
    const detail = typeof raw === 'string' ? JSON.parse(raw) : raw
    expect(detail).toEqual({ client: 'Noisy', redirectUris: 2, redirectHost: 'chatgpt.com' })
    // A full URI can carry a query string an attacker chose; the host is the
    // part an operator actually reads.
    expect(JSON.stringify(detail)).not.toContain('token=abc')
  })

  it('cleans a hostile client name at registration, not just at render time', async () => {
    const res = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'Chat‮GPT', redirect_uris: [REDIRECT] })
    expect(res.status).toBe(201)
    expect(res.body.client_name).toBe('ChatGPT')
    const rows = await libraryQuery(`SELECT client_name FROM library_oauth_clients`)
    expect((rows.rows[0] as { client_name: string }).client_name).not.toContain('‮')
  })
})

describe('token endpoint: check order and races (findings 5 and 6)', () => {
  it('a stale code with a junk verifier cannot burn a live family', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const first = await exchange(c.clientId, code, verifier)
    expect(first.status).toBe(200)

    // The code is now used AND expired. A thief holding the spent code but not
    // the verifier must not be able to revoke the honest client's tokens.
    await libraryQuery(`UPDATE library_oauth_codes SET expires_at = $1`, [new Date(Date.now() - 1000)])
    const replay = await exchange(c.clientId, code, randomBytes(32).toString('base64url'))
    expect(replay.status).toBe(400)
    expect(replay.body.error).toBe('invalid_grant')

    expect(await oauthStore.getOAuthAccessPrincipal(first.body.access_token, RESOURCE)).not.toBeNull()
    expect((await libraryQuery(`SELECT id FROM library_audit WHERE action = 'oauth.reuse'`)).rows).toHaveLength(0)
  })

  it('a used code presented with the RIGHT verifier still revokes the family', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const first = await exchange(c.clientId, code, verifier)
    const replay = await exchange(c.clientId, code, verifier)
    expect(replay.status).toBe(400)
    expect(await oauthStore.getOAuthAccessPrincipal(first.body.access_token, RESOURCE)).toBeNull()
    expect((await libraryQuery(`SELECT id FROM library_audit WHERE action = 'oauth.reuse'`)).rows).toHaveLength(1)
  })

  it('a wrong verifier on a live code is still invalid_grant and still spends nothing', async () => {
    const c = await client()
    const { verifier, challenge } = pkce()
    const { code } = await grantCode(c.clientId, challenge)
    const wrong = await exchange(c.clientId, code, randomBytes(32).toString('base64url'))
    expect(wrong.status).toBe(400)
    // The honest client can still complete: a failed guess must not burn a code.
    expect((await exchange(c.clientId, code, verifier)).status).toBe(200)
  })

  it('a family revoked between the claim and the issue does not come back to life', async () => {
    const { client: c, tokens } = await connected()
    const record = await oauthStore.findToken(tokens.refresh_token, 'refresh')

    // Simulate the interleaving: the claim succeeds, and before the new pair
    // is issued another request revokes the family (a replay elsewhere, or
    // Disconnect on the account page).
    const realClaim = oauthStore.claimRefreshToken
    const spy = vi.spyOn(oauthStore, 'claimRefreshToken').mockImplementation(async (tokenId: number) => {
      const claimed = await realClaim(tokenId)
      await oauthStore.revokeFamily(record!.familyId)
      return claimed
    })

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    spy.mockRestore()

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
    expect(res.body.access_token).toBeUndefined()
    // Nothing in that family is alive — including whatever was minted before
    // the revocation was noticed.
    const live = await libraryQuery(
      `SELECT id FROM library_oauth_tokens WHERE family_id = $1 AND revoked_at IS NULL`,
      [record!.familyId],
    )
    expect(live.rows).toHaveLength(0)
  })
})

describe('a disabled client is cut off immediately (finding 1)', () => {
  const RPC = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  const ACCEPT = 'application/json, text/event-stream'

  it('a live access token 401s the moment its client is disabled', async () => {
    const { client: c, tokens } = await connected()
    const before = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(before.status).toBe(200)

    await oauthStore.disableClient(c.clientId)

    const after = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Accept', ACCEPT)
      .send(RPC)
    expect(after.status).toBe(401)
    // And it cannot start over: authorize refuses a disabled client outright.
    const authorize = await request(app)
      .get('/oauth/authorize')
      .set('Cookie', cookie)
      .query(authorizeQuery(c.clientId, pkce().challenge))
    expect(authorize.status).toBe(400)
    expect(authorize.headers.location).toBeUndefined()
  })

  it('a refresh from a disabled client is refused', async () => {
    const { client: c, tokens } = await connected()
    await oauthStore.disableClient(c.clientId)
    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      client_id: c.clientId,
      refresh_token: tokens.refresh_token,
    })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('invalid_client')
  })
})

describe('logging out of the website does not disconnect an app (locked behaviour)', () => {
  it('leaves OAuth tokens alive — a grant is a standing delegation, not a browser session', async () => {
    const { tokens } = await connected()
    const logout = await request(app).post('/api/logout').set('Cookie', cookie).set('X-CSRF-Token', csrfToken)
    expect(logout.status).toBe(204)
    // The cookie is dead...
    expect((await request(app).get('/api/library/oauth/grants').set('Cookie', cookie)).status).toBe(401)
    // ...and the connected app keeps working, deliberately. Disconnect on the
    // account page (or disabling the account) is the lever that cuts it off;
    // if this test ever fails, that decision changed and MCP.md must change
    // with it.
    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(200)
  })
})
