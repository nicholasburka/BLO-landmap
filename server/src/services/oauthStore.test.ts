import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P5-51 store + validators. The validators are pure and get exhaustive cases
 * (they are the rules an attacker probes); the store half runs against pg-mem
 * so the SQL that hashes, claims and revokes is the SQL production runs.
 */

process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const store = await import('./oauthStore.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const RESOURCE = 'https://api.example.com/mcp'
let userId = 0

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  const res = await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role) VALUES ('maria', 'x', 'internal') RETURNING id`,
  )
  userId = Number((res.rows[0] as { id: unknown }).id)
  store.clearOAuthTouchCache()
})

afterEach(async () => {
  await closeLibraryDb()
})

async function aClient(overrides: Partial<Parameters<typeof store.registerClient>[0]> = {}) {
  return store.registerClient({
    clientName: 'ChatGPT',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
    grantTypes: ['authorization_code', 'refresh_token'],
    scopes: ['read', 'write'],
    ...overrides,
  })
}

describe('oauthIssuer', () => {
  const original = process.env.OAUTH_ISSUER
  afterEach(() => {
    if (original === undefined) delete process.env.OAUTH_ISSUER
    else process.env.OAUTH_ISSUER = original
  })

  it('is null when unset — OAuth stays off rather than guessing an origin', () => {
    delete process.env.OAUTH_ISSUER
    expect(store.oauthIssuer()).toBeNull()
  })

  it('accepts an https origin and strips any path', () => {
    process.env.OAUTH_ISSUER = 'https://api.example.com/ignored?q=1'
    expect(store.oauthIssuer()).toBe('https://api.example.com')
  })

  it('accepts http only on the loopback (dev)', () => {
    process.env.OAUTH_ISSUER = 'http://localhost:3007'
    expect(store.oauthIssuer()).toBe('http://localhost:3007')
    process.env.OAUTH_ISSUER = 'http://127.0.0.1:3007'
    expect(store.oauthIssuer()).toBe('http://127.0.0.1:3007')
  })

  it('refuses plain http on a public host — codes would travel in the clear', () => {
    process.env.OAUTH_ISSUER = 'http://api.example.com'
    expect(store.oauthIssuer()).toBeNull()
  })

  it('refuses a non-URL', () => {
    process.env.OAUTH_ISSUER = 'not a url'
    expect(store.oauthIssuer()).toBeNull()
  })

  it('derives the MCP resource and the RFC 9728 metadata URL from it', () => {
    expect(store.mcpResource('https://api.example.com')).toBe('https://api.example.com/mcp')
    expect(store.protectedResourceMetadataUrl('https://api.example.com')).toBe(
      'https://api.example.com/.well-known/oauth-protected-resource/mcp',
    )
  })
})

describe('validateRedirectUri', () => {
  it('accepts https', () => {
    expect(store.validateRedirectUri('https://chatgpt.com/cb')).toEqual({
      uri: 'https://chatgpt.com/cb',
    })
  })

  it('accepts http on the loopback with a port', () => {
    expect(store.validateRedirectUri('http://127.0.0.1:33418/callback')).toEqual({
      uri: 'http://127.0.0.1:33418/callback',
    })
    expect(store.validateRedirectUri('http://localhost:6274/oauth/callback')).toEqual({
      uri: 'http://localhost:6274/oauth/callback',
    })
  })

  it('refuses plain http anywhere else', () => {
    expect(store.validateRedirectUri('http://evil.example/cb')).toHaveProperty('error')
  })

  it('refuses a non-http scheme', () => {
    expect(store.validateRedirectUri('javascript:alert(1)')).toHaveProperty('error')
    expect(store.validateRedirectUri('data:text/html,x')).toHaveProperty('error')
  })

  it('refuses a fragment — the query we append would be lost behind it', () => {
    expect(store.validateRedirectUri('https://chatgpt.com/cb#frag')).toHaveProperty('error')
  })

  it('refuses userinfo — https://evil@good.example reads as good.example', () => {
    expect(store.validateRedirectUri('https://evil@good.example/cb')).toHaveProperty('error')
  })

  it('refuses a relative URL and a non-string', () => {
    expect(store.validateRedirectUri('/callback')).toHaveProperty('error')
    expect(store.validateRedirectUri(42)).toHaveProperty('error')
  })

  it('refuses an absurdly long URI', () => {
    expect(store.validateRedirectUri(`https://x.example/${'a'.repeat(3000)}`)).toHaveProperty('error')
  })
})

describe('validateCodeChallenge', () => {
  it('accepts an S256 challenge with the method named', () => {
    const challenge = createHash('sha256').update('a'.repeat(64)).digest('base64url')
    expect(store.validateCodeChallenge(challenge, 'S256')).toEqual({ challenge })
  })

  it('refuses the plain method — PKCE would be decorative', () => {
    const challenge = createHash('sha256').update('a'.repeat(64)).digest('base64url')
    expect(store.validateCodeChallenge(challenge, 'plain')).toHaveProperty('error')
  })

  it('refuses a missing challenge', () => {
    expect(store.validateCodeChallenge(undefined, 'S256')).toHaveProperty('error')
    expect(store.validateCodeChallenge('', 'S256')).toHaveProperty('error')
  })

  it('refuses a too-short or non-base64url challenge', () => {
    expect(store.validateCodeChallenge('short', 'S256')).toHaveProperty('error')
    expect(store.validateCodeChallenge(`${'a'.repeat(42)}+`, 'S256')).toHaveProperty('error')
  })
})

describe('verifyCodeVerifier', () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  it('accepts the matching verifier', () => {
    expect(store.verifyCodeVerifier(verifier, challenge)).toBe(true)
  })

  it('rejects a different verifier', () => {
    expect(store.verifyCodeVerifier(randomBytes(32).toString('base64url'), challenge)).toBe(false)
  })

  it('rejects a verifier outside RFC 7636 length bounds', () => {
    expect(store.verifyCodeVerifier('a'.repeat(42), challenge)).toBe(false)
    expect(store.verifyCodeVerifier('a'.repeat(129), challenge)).toBe(false)
  })

  it('rejects the challenge presented as the verifier (a plain-PKCE downgrade)', () => {
    expect(store.verifyCodeVerifier(challenge, challenge)).toBe(false)
  })

  it('rejects a non-string', () => {
    expect(store.verifyCodeVerifier(undefined, challenge)).toBe(false)
  })
})

describe('parseScopes', () => {
  it('defaults when absent', () => {
    expect(store.parseScopes(undefined)).toEqual({ scopes: ['read'] })
    expect(store.parseScopes('')).toEqual({ scopes: ['read'] })
  })

  it('splits on whitespace and de-duplicates', () => {
    expect(store.parseScopes('read write read')).toEqual({ scopes: ['read', 'write'] })
  })

  it('refuses an unknown scope rather than silently dropping it', () => {
    expect(store.parseScopes('read admin')).toHaveProperty('error')
  })
})

describe('resourceMatches', () => {
  it('tolerates exactly one trailing slash', () => {
    expect(store.resourceMatches(RESOURCE, `${RESOURCE}/`)).toBe(true)
  })

  it('rejects a different resource', () => {
    expect(store.resourceMatches('https://evil.example/mcp', RESOURCE)).toBe(false)
  })
})

describe('consent CSRF token', () => {
  it('is bound to both the session and the request', () => {
    const a = store.consentCsrfToken('session-a', 'pending-1')
    expect(store.consentCsrfMatches('session-a', 'pending-1', a)).toBe(true)
    // A token from another session, or for another request, does not work.
    expect(store.consentCsrfMatches('session-b', 'pending-1', a)).toBe(false)
    expect(store.consentCsrfMatches('session-a', 'pending-2', a)).toBe(false)
    expect(store.consentCsrfMatches('session-a', 'pending-1', '')).toBe(false)
    expect(store.consentCsrfMatches('session-a', 'pending-1', undefined)).toBe(false)
  })
})

describe('clients', () => {
  it('round-trips a registration and matches redirects exactly', async () => {
    const client = await aClient()
    expect(client.clientId).toBeTruthy()
    const loaded = await store.getClient(client.clientId)
    expect(loaded?.clientName).toBe('ChatGPT')
    expect(store.clientAllowsRedirect(loaded!, 'https://chatgpt.com/connector_platform_oauth_redirect')).toBe(true)
    // No prefix matching, no "same origin is close enough".
    expect(store.clientAllowsRedirect(loaded!, 'https://chatgpt.com/connector_platform_oauth_redirect/x')).toBe(false)
    expect(store.clientAllowsRedirect(loaded!, 'https://chatgpt.com/')).toBe(false)
    expect(store.clientAllowsRedirect(loaded!, 'https://evil.example/cb')).toBe(false)
  })

  it('never stores a client secret (no column exists to hold one)', async () => {
    const client = await aClient()
    const row = await libraryQuery(`SELECT * FROM library_oauth_clients WHERE client_id = $1`, [client.clientId])
    expect(Object.keys(row.rows[0] as object)).not.toContain('client_secret')
  })

  it('returns null for an unknown or non-string client id', async () => {
    expect(await store.getClient('nope')).toBeNull()
    expect(await store.getClient(undefined)).toBeNull()
  })
})

describe('authorization codes', () => {
  it('stores only a hash and can be claimed exactly once', async () => {
    const client = await aClient()
    const code = await store.createAuthorizationCode({
      clientId: client.clientId,
      userId,
      redirectUri: client.redirectUris[0],
      codeChallenge: 'c'.repeat(43),
      scopes: ['read'],
      resource: RESOURCE,
    })
    const stored = await libraryQuery(`SELECT code_hash FROM library_oauth_codes`)
    expect((stored.rows[0] as { code_hash: string }).code_hash).toBe(
      createHash('sha256').update(code).digest('hex'),
    )
    expect((stored.rows[0] as { code_hash: string }).code_hash).not.toContain(code)

    const record = await store.findAuthorizationCode(code)
    expect(record?.userId).toBe(userId)
    expect(await store.claimAuthorizationCode(record!.id)).toBe(true)
    // Second claim loses the race — this is what makes a code single-use.
    expect(await store.claimAuthorizationCode(record!.id)).toBe(false)
  })

  it('returns null for an unknown code', async () => {
    expect(await store.findAuthorizationCode('made-up')).toBeNull()
  })
})

describe('tokens', () => {
  async function grant() {
    const client = await aClient()
    const issued = await store.issueTokenPair({
      userId,
      clientId: client.clientId,
      scopes: ['read'],
      resource: RESOURCE,
    })
    return { client, issued }
  }

  it('issues a hashed pair in one family with the documented prefixes', async () => {
    const { issued } = await grant()
    expect(issued.accessToken.startsWith(store.ACCESS_TOKEN_PREFIX)).toBe(true)
    expect(issued.refreshToken.startsWith(store.REFRESH_TOKEN_PREFIX)).toBe(true)
    expect(issued.expiresIn).toBe(3600)
    const rows = await libraryQuery(`SELECT kind, token_hash, family_id FROM library_oauth_tokens ORDER BY kind`)
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows as { token_hash: string; family_id: string }[]) {
      expect(row.family_id).toBe(issued.familyId)
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.token_hash).not.toContain('blo_')
    }
  })

  it('resolves an access token to its user, and only for the right resource', async () => {
    const { issued } = await grant()
    const principal = await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)
    expect(principal?.user.username).toBe('maria')
    expect(principal?.scopes).toEqual(['read'])
    // Audience check: a token minted for us is not a token for someone else.
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, 'https://other.example/mcp')).toBeNull()
  })

  it('refuses a refresh token presented at the access endpoint and vice versa', async () => {
    const { issued } = await grant()
    expect(await store.getOAuthAccessPrincipal(issued.refreshToken, RESOURCE)).toBeNull()
    expect(await store.findToken(issued.accessToken, 'refresh')).toBeNull()
  })

  it('stops resolving once the family is revoked', async () => {
    const { issued } = await grant()
    expect(await store.revokeFamily(issued.familyId)).toBe(2)
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()
  })

  it('stops resolving once expired', async () => {
    const { issued } = await grant()
    await libraryQuery(`UPDATE library_oauth_tokens SET expires_at = $1`, [new Date(Date.now() - 1000)])
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()
  })

  it('stops resolving for a disabled account', async () => {
    const { issued } = await grant()
    await libraryQuery(`UPDATE library_users SET disabled = TRUE WHERE id = $1`, [userId])
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()
  })

  it('claims a refresh token once — a second claim is the replay signal', async () => {
    const { issued } = await grant()
    const record = await store.findToken(issued.refreshToken, 'refresh')
    expect(await store.claimRefreshToken(record!.id)).toBe(true)
    expect(await store.claimRefreshToken(record!.id)).toBe(false)
  })
})

describe('grants (the account page)', () => {
  it('lists one row per authorization and revokes the whole family', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({
      userId,
      clientId: client.clientId,
      scopes: ['read'],
      resource: RESOURCE,
    })
    const grants = await store.listGrants(userId)
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ id: issued.familyId, clientName: 'ChatGPT', scopes: ['read'] })

    expect(await store.revokeGrant(userId, issued.familyId)).toEqual({ clientName: 'ChatGPT' })
    expect(await store.listGrants(userId)).toEqual([])
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()
  })

  it('collapses a rotated family into one row, dated from the oldest token', async () => {
    const client = await aClient()
    const first = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    await store.issueTokenPair({
      userId,
      clientId: client.clientId,
      scopes: ['read'],
      resource: RESOURCE,
      familyId: first.familyId,
    })
    const grants = await store.listGrants(userId)
    expect(grants).toHaveLength(1)
  })

  it('will not revoke another user’s grant, and says "not found" rather than "not yours"', async () => {
    const other = await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'x', 'admin') RETURNING id`,
    )
    const otherId = Number((other.rows[0] as { id: unknown }).id)
    const client = await aClient()
    const issued = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    expect(await store.revokeGrant(otherId, issued.familyId)).toBeNull()
    expect(await store.revokeGrant(userId, 'made-up-family')).toBeNull()
    // The real owner's token still works — a foreign revoke changed nothing.
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).not.toBeNull()
  })
})

describe('pending authorize requests', () => {
  it('stores the id hashed and expires it', async () => {
    const id = await store.createPendingAuthorize({
      clientId: 'c1',
      redirectUri: 'https://chatgpt.com/cb',
      scopes: ['read'],
      state: 'xyz',
      codeChallenge: 'c'.repeat(43),
      resource: RESOURCE,
    })
    const rows = await libraryQuery(`SELECT id_hash FROM library_oauth_pending`)
    expect((rows.rows[0] as { id_hash: string }).id_hash).toBe(createHash('sha256').update(id).digest('hex'))

    expect((await store.getPendingAuthorize(id))?.state).toBe('xyz')
    await libraryQuery(`UPDATE library_oauth_pending SET expires_at = $1`, [new Date(Date.now() - 1000)])
    expect(await store.getPendingAuthorize(id)).toBeNull()
  })

  it('is deletable, so one approval cannot mint two codes', async () => {
    const id = await store.createPendingAuthorize({
      clientId: 'c1',
      redirectUri: 'https://chatgpt.com/cb',
      scopes: ['read'],
      state: null,
      codeChallenge: 'c'.repeat(43),
      resource: RESOURCE,
    })
    await store.deletePendingAuthorize(id)
    expect(await store.getPendingAuthorize(id)).toBeNull()
  })
})

describe('pruneOAuth', () => {
  it('clears expired codes, pending rows and dead tokens', async () => {
    const client = await aClient()
    await store.createAuthorizationCode({
      clientId: client.clientId,
      userId,
      redirectUri: client.redirectUris[0],
      codeChallenge: 'c'.repeat(43),
      scopes: ['read'],
      resource: RESOURCE,
    })
    await store.createPendingAuthorize({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scopes: ['read'],
      state: null,
      codeChallenge: 'c'.repeat(43),
      resource: RESOURCE,
    })
    await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })

    // Nothing is dead yet.
    expect(await store.pruneOAuth()).toBe(0)

    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await libraryQuery(`UPDATE library_oauth_codes SET expires_at = $1`, [old])
    await libraryQuery(`UPDATE library_oauth_pending SET expires_at = $1`, [old])
    await libraryQuery(`UPDATE library_oauth_tokens SET expires_at = $1`, [old])
    expect(await store.pruneOAuth()).toBe(4) // 1 code + 1 pending + 2 tokens
  })
})

// --- security review follow-ups (P5-51 hardening) --------------------------

describe('validateClientName (review finding 4)', () => {
  it('keeps an ordinary name', () => {
    expect(store.validateClientName('ChatGPT')).toEqual({ name: 'ChatGPT' })
  })

  it('strips a right-to-left override — a name must read on the consent page as it is stored', () => {
    // U+202E turns "…gpt.com" into "moc.tpg…" on screen; the classic way one
    // app is made to look like another.
    const result = store.validateClientName('Chat‮GPT')
    expect(result).toEqual({ name: 'ChatGPT' })
    expect(JSON.stringify(result)).not.toContain('202e')
  })

  it('strips zero-width joiners and other invisible format characters', () => {
    expect(store.validateClientName('Chat‍G​PT﻿')).toEqual({ name: 'ChatGPT' })
  })

  it('normalises to NFC so two spellings of one name are one name', () => {
    // "Café" composed vs decomposed.
    expect(store.validateClientName('Café')).toEqual({ name: 'Café' })
  })

  it('collapses runs of whitespace and trims', () => {
    expect(store.validateClientName('  Claude   Desktop  ')).toEqual({ name: 'Claude Desktop' })
  })

  it('refuses a name that is nothing but invisible characters', () => {
    expect(store.validateClientName('​‍‮')).toHaveProperty('error')
    expect(store.validateClientName('   ')).toHaveProperty('error')
    expect(store.validateClientName(42)).toHaveProperty('error')
  })

  it('applies the length rule AFTER stripping, so padding cannot fail a legal name', () => {
    const padded = `${'​'.repeat(200)}Real name`
    expect(store.validateClientName(padded)).toEqual({ name: 'Real name' })
    expect(store.validateClientName('a'.repeat(store.CLIENT_NAME_MAX + 1))).toHaveProperty('error')
  })
})

describe('disabled clients (review finding 1)', () => {
  it('a live access token stops resolving the moment its client is disabled', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({
      userId,
      clientId: client.clientId,
      scopes: ['read'],
      resource: RESOURCE,
    })
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).not.toBeNull()

    const result = await store.disableClient(client.clientId)
    expect(result).toMatchObject({ clientName: 'ChatGPT', alreadyDisabled: false })
    // Both halves matter: the flag stops new use, the revocation kills what is
    // already out there. Either alone leaves an hour-long hole.
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()
    expect(result!.tokensRevoked).toBe(2)
    expect(await store.getClient(client.clientId)).toBeNull()
  })

  it('revokes every user’s tokens for that client, not just one', async () => {
    const other = await libraryQuery(
      `INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'x', 'admin') RETURNING id`,
    )
    const otherId = Number((other.rows[0] as { id: unknown }).id)
    const client = await aClient()
    const mine = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    const theirs = await store.issueTokenPair({
      userId: otherId,
      clientId: client.clientId,
      scopes: ['read'],
      resource: RESOURCE,
    })
    await store.disableClient(client.clientId)
    expect(await store.getOAuthAccessPrincipal(mine.accessToken, RESOURCE)).toBeNull()
    expect(await store.getOAuthAccessPrincipal(theirs.accessToken, RESOURCE)).toBeNull()
    expect(await store.listGrants(userId)).toEqual([])
    expect(await store.listGrants(otherId)).toEqual([])
  })

  it('is idempotent and says so; an unknown client id is null', async () => {
    const client = await aClient()
    await store.disableClient(client.clientId)
    const again = await store.disableClient(client.clientId)
    expect(again).toMatchObject({ alreadyDisabled: true, tokensRevoked: 0 })
    expect(await store.disableClient('made-up')).toBeNull()
    expect(await store.disableClient(undefined)).toBeNull()
  })

  it('lists clients with their live token counts and disabled state', async () => {
    const live = await aClient()
    const dead = await aClient({ clientName: 'Retired' })
    await store.issueTokenPair({ userId, clientId: live.clientId, scopes: ['read'], resource: RESOURCE })
    await store.disableClient(dead.clientId)

    const summaries = await store.listClientSummaries()
    expect(summaries).toHaveLength(2)
    const byId = new Map(summaries.map(s => [s.clientId, s]))
    expect(byId.get(live.clientId)).toMatchObject({ clientName: 'ChatGPT', liveTokens: 2, disabledAt: null })
    expect(byId.get(dead.clientId)!.disabledAt).toBeTruthy()
    expect(byId.get(dead.clientId)!.liveTokens).toBe(0)
  })
})

describe('isFamilyRevoked (review finding 6)', () => {
  it('is false for a fresh family and true once anything in it is revoked', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    expect(await store.isFamilyRevoked(issued.familyId)).toBe(false)
    await store.revokeFamily(issued.familyId)
    expect(await store.isFamilyRevoked(issued.familyId)).toBe(true)
    expect(await store.isFamilyRevoked('no-such-family')).toBe(false)
  })
})

describe('revokeTokenById and touchOAuthToken', () => {
  it('revokes exactly one token and leaves the rest of the family alone', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    const access = await store.findToken(issued.accessToken, 'access')
    await store.revokeTokenById(access!.id)
    expect(await store.getOAuthAccessPrincipal(issued.accessToken, RESOURCE)).toBeNull()
    // The refresh token survives: RFC 7009 revocation of an access token is
    // not revocation of the authorization.
    const refresh = await store.findToken(issued.refreshToken, 'refresh')
    expect(refresh?.revokedAt).toBeNull()
  })

  it('stamps last_used_at once per minute, not once per request', async () => {
    const client = await aClient()
    const issued = await store.issueTokenPair({ userId, clientId: client.clientId, scopes: ['read'], resource: RESOURCE })
    const record = await store.findToken(issued.accessToken, 'access')

    store.touchOAuthToken(record!.id)
    // The write is fire-and-forget; give the microtask queue a turn.
    await new Promise(resolve => setTimeout(resolve, 20))
    const first = (await libraryQuery(`SELECT last_used_at FROM library_oauth_tokens WHERE id = $1`, [record!.id]))
      .rows[0] as { last_used_at: unknown }
    expect(first.last_used_at).toBeTruthy()

    await libraryQuery(`UPDATE library_oauth_tokens SET last_used_at = NULL WHERE id = $1`, [record!.id])
    store.touchOAuthToken(record!.id)
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = (await libraryQuery(`SELECT last_used_at FROM library_oauth_tokens WHERE id = $1`, [record!.id]))
      .rows[0] as { last_used_at: unknown }
    // Throttled: the second call inside the same minute wrote nothing.
    expect(second.last_used_at).toBeNull()
  })
})

describe('pruneOAuth: clients and pending rows (review findings 2 and 9)', () => {
  it('deletes an old client with nothing left pointing at it', async () => {
    const stale = await aClient({ clientName: 'Abandoned' })
    const busy = await aClient({ clientName: 'In use' })
    await store.issueTokenPair({ userId, clientId: busy.clientId, scopes: ['read'], resource: RESOURCE })
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await libraryQuery(`UPDATE library_oauth_clients SET created_at = $1`, [old])

    expect(await store.pruneOAuth()).toBe(1)
    expect(await store.getClient(stale.clientId)).toBeNull()
    expect(await store.getClient(busy.clientId)).not.toBeNull()
  })

  it('keeps a client young enough to still be in use', async () => {
    const fresh = await aClient()
    expect(await store.pruneOAuth()).toBe(0)
    expect(await store.getClient(fresh.clientId)).not.toBeNull()
  })

  it('keeps an old client that still has a pending authorize request', async () => {
    const client = await aClient()
    await store.createPendingAuthorize({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scopes: ['read'],
      state: null,
      codeChallenge: 'c'.repeat(43),
      resource: RESOURCE,
    })
    await libraryQuery(`UPDATE library_oauth_clients SET created_at = $1`, [
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    ])
    expect(await store.pruneOAuth()).toBe(0)
    expect(await store.getClient(client.clientId)).not.toBeNull()
  })

  it('deletes an expired pending row', async () => {
    const client = await aClient()
    const id = await store.createPendingAuthorize({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      scopes: ['read'],
      state: null,
      codeChallenge: 'c'.repeat(43),
      resource: RESOURCE,
    })
    await libraryQuery(`UPDATE library_oauth_pending SET expires_at = $1`, [new Date(Date.now() - 1000)])
    expect(await store.pruneOAuth()).toBe(1)
    expect(await store.getPendingAuthorize(id)).toBeNull()
  })
})
