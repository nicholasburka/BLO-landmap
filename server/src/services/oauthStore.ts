import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { libraryQuery } from './libraryDb.js'
import type { InternalUser } from './internalSessions.js'

/**
 * OAuth 2.1 store and validators (P5-51) — the credential half of the remote
 * MCP flow. ChatGPT's custom connectors and Claude's remote connectors will
 * not carry a personal token: they discover an authorization server, register
 * themselves, and walk an authorization-code + PKCE flow. This module owns
 * every secret in that flow and every rule about what a client may ask for.
 *
 * Shape follows internalSessions.ts / apiTokens.ts deliberately:
 *  - nothing replayable is stored. Codes, access tokens and refresh tokens go
 *    into the DB as sha256 hashes; the raw value exists once, in the response;
 *  - revocation is a timestamp, because "when was this cut off" is the
 *    question an incident asks;
 *  - every SQL statement is parameterised.
 *
 * The three rules that carry most of the weight, and why:
 *  - EVERY client is public (no client secret can be stored, so none is), so
 *    PKCE S256 is mandatory — the code alone must be useless to a thief.
 *  - redirect_uri is matched EXACTLY against what the client registered. No
 *    prefix, no wildcards, no "same origin is close enough": redirect
 *    matching is where authorization-code flows are stolen.
 *  - refresh tokens rotate, and a rotated token presented a second time
 *    revokes the entire family. A replay means the token leaked; the only
 *    safe reading is that both copies are suspect.
 */

// --- vocabulary -------------------------------------------------------------

/** Scopes this server understands. `write` is minted only when a client asks
 *  for it; the write tools that honour it arrive with P5-52. */
export const OAUTH_SCOPES = ['read', 'write'] as const
export type OAuthScope = (typeof OAUTH_SCOPES)[number]

/** Plain words for the consent screen. A human approving a connector should
 *  not have to know what a "scope" is. */
export const SCOPE_DESCRIPTIONS: Record<OAuthScope, string> = {
  read: 'Read the library — pages, documents, datasets, map layers and saved views',
  write: 'Add notes, pages, links and saved views — it cannot delete anything',
}

export const GRANT_TYPES = ['authorization_code', 'refresh_token'] as const

/** Distinct prefixes so a leaked string is identifiable on sight, and so the
 *  bearer check can route a token to the right table before hashing it. */
export const ACCESS_TOKEN_PREFIX = 'blo_at_'
export const REFRESH_TOKEN_PREFIX = 'blo_rt_'

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes
export const PENDING_TTL_MS = 10 * 60 * 1000 // 10 minutes

export const CLIENT_NAME_MAX = 120
export const MAX_REDIRECT_URIS = 5
export const REDIRECT_URI_MAX = 2048
/** RFC 7636 §4.1 bounds the verifier; anything outside them is a broken or
 *  hostile client, never a real one. */
export const CODE_VERIFIER_MIN = 43
export const CODE_VERIFIER_MAX = 128

// --- primitives -------------------------------------------------------------

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Constant-time string compare. Used wherever a caller-supplied value is
 *  checked against a stored one, so response timing never leaks a prefix. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function getSecret(): string {
  const secret = process.env.SESSION_HMAC_SECRET
  if (!secret) {
    throw new Error('SESSION_HMAC_SECRET is not set — server should have refused to boot')
  }
  return secret
}

/**
 * CSRF token for the consent form. Derived rather than stored (same trick as
 * internalSessions.csrfTokenFor) and bound to BOTH the session and this one
 * authorization request, so a token lifted from one consent page cannot
 * approve a different app's request.
 *
 * A separate derivation from the API's session CSRF token on purpose: the
 * consent page is HTML rendered for a human, and nothing in it should be a
 * value the SPA also uses as an API credential.
 */
export function consentCsrfToken(sessionToken: string, pendingId: string): string {
  return createHmac('sha256', getSecret()).update(`oauth-consent.${sessionToken}.${pendingId}`).digest('hex')
}

export function consentCsrfMatches(sessionToken: string, pendingId: string, given: unknown): boolean {
  if (typeof given !== 'string' || given.length === 0) return false
  return safeEqual(given, consentCsrfToken(sessionToken, pendingId))
}

function asArray(value: unknown): unknown[] {
  const raw = typeof value === 'string' ? safeParse(value) : value
  return Array.isArray(raw) ? raw : []
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((v): v is string => typeof v === 'string')
}

function isoTime(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const t = Date.parse(value)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return new Date(0).toISOString()
}

function isoTimeOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : isoTime(value)
}

// --- issuer / resource ------------------------------------------------------

/**
 * The public origin of THIS API, which is both the OAuth issuer and the base
 * of the MCP resource identifier. It must be configured rather than derived
 * from the request: a Host header is attacker-controlled, and deriving an
 * issuer from it would let a forged Host point a connector's whole flow at
 * someone else's server.
 *
 * Unset → the OAuth endpoints report themselves unavailable and /mcp keeps
 * working exactly as it did with personal tokens.
 */
export function oauthIssuer(): string | null {
  const raw = (process.env.OAUTH_ISSUER || '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  // Anything but https is refused off the loopback: an issuer is where a
  // client will send an authorization code, and http there is a wiretap.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
  // Origin only — no path, query or fragment, so metadata URLs concatenate
  // predictably and no trailing slash sneaks into a resource comparison.
  return url.origin
}

/** The MCP endpoint's resource identifier (RFC 8707). A token is issued FOR
 *  this and is rejected anywhere else, so a token phished by another server
 *  cannot be replayed here — and ours cannot be replayed there. */
export function mcpResource(issuer: string): string {
  return `${issuer}/mcp`
}

/** RFC 9728 puts the resource's path after the well-known segment; a resource
 *  with no path uses the bare form. Both are served. */
export function protectedResourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource/mcp`
}

/** Compare a caller's `resource` to ours. A single trailing slash is the one
 *  difference tolerated — clients disagree about it and it changes nothing. */
export function resourceMatches(given: string, expected: string): boolean {
  const trim = (v: string) => (v.endsWith('/') ? v.slice(0, -1) : v)
  return trim(given) === trim(expected)
}

// --- validators (pure) ------------------------------------------------------

/**
 * A registered redirect URI must be somewhere a code can be delivered safely:
 * https anywhere, or plain http on the loopback for a desktop client that
 * listens on a local port. Fragments are refused because the fragment is
 * where the browser would silently drop our query parameters, and userinfo
 * because `https://evil@good.example` reads as "good.example" to a human.
 */
export function validateRedirectUri(raw: unknown): { uri: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: 'redirect_uris must be strings' }
  if (raw.length > REDIRECT_URI_MAX) return { error: 'redirect_uri is too long' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: 'redirect_uri must be an absolute URL' }
  }
  if (url.hash) return { error: 'redirect_uri must not contain a fragment' }
  if (url.username || url.password) return { error: 'redirect_uri must not contain userinfo' }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1'
  if (url.protocol === 'https:') return { uri: url.href }
  if (url.protocol === 'http:' && loopback) return { uri: url.href }
  return { error: 'redirect_uri must be https, or http on 127.0.0.1 / localhost' }
}

/**
 * A client name is the ONE thing a human reads on the consent screen when
 * deciding whether to trust an app that registered itself, so it is cleaned
 * rather than merely escaped:
 *  - NFC first, so two spellings of the same name are the same name;
 *  - control and format characters (\p{Cc}\p{Cf}) removed. A right-to-left
 *    override (U+202E) makes one name render as another, and zero-width
 *    joiners hide inside a name that looks identical to a real one. Neither
 *    carries meaning in a name; both are only ever spoofing tools;
 *  - whitespace collapsed, so padding cannot push the visible name off-screen.
 * The length rule runs LAST, on what a human will actually see.
 */
export function validateClientName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'client_name is required' }
  const name = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!name) return { error: 'client_name is required' }
  if (name.length > CLIENT_NAME_MAX) return { error: `client_name is limited to ${CLIENT_NAME_MAX} characters` }
  return { name }
}

/** Split an OAuth scope string and check every entry is one we support. An
 *  unknown scope is refused rather than dropped: silently narrowing a request
 *  hands the client a token that does less than it believes it does. */
export function parseScopes(raw: unknown, fallback: OAuthScope[] = ['read']): { scopes: OAuthScope[] } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { scopes: [...fallback] }
  if (typeof raw !== 'string') return { error: 'invalid scope' }
  const parts = raw.split(/\s+/).filter(Boolean)
  if (!parts.length) return { scopes: [...fallback] }
  const out: OAuthScope[] = []
  for (const part of parts) {
    if (!(OAUTH_SCOPES as readonly string[]).includes(part)) return { error: 'invalid scope' }
    if (!out.includes(part as OAuthScope)) out.push(part as OAuthScope)
  }
  return { scopes: out }
}

/** S256 only. `plain` is removed in OAuth 2.1 and would make PKCE decorative:
 *  anyone who can see the challenge could produce the verifier. */
export function validateCodeChallenge(
  challenge: unknown,
  method: unknown,
): { challenge: string } | { error: string } {
  if (method !== undefined && method !== 'S256') return { error: 'code_challenge_method must be S256' }
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(challenge)) {
    return { error: 'code_challenge must be a base64url-encoded S256 challenge' }
  }
  return { challenge }
}

/** Verify a PKCE verifier against a stored challenge, constant-time. */
export function verifyCodeVerifier(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string') return false
  if (verifier.length < CODE_VERIFIER_MIN || verifier.length > CODE_VERIFIER_MAX) return false
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false
  const computed = createHash('sha256').update(verifier).digest('base64url')
  return safeEqual(computed, challenge)
}

// --- clients ----------------------------------------------------------------

export interface OAuthClient {
  clientId: string
  clientName: string
  redirectUris: string[]
  grantTypes: string[]
  scopes: OAuthScope[]
  createdAt: string
}

interface ClientRow {
  client_id: string
  client_name: string
  redirect_uris: unknown
  grant_types: unknown
  scopes: unknown
  created_at: unknown
}

function toClient(row: ClientRow): OAuthClient {
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris: asStrings(row.redirect_uris),
    grantTypes: asStrings(row.grant_types),
    scopes: asStrings(row.scopes).filter((s): s is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(s)),
    createdAt: isoTime(row.created_at),
  }
}

export async function registerClient(input: {
  clientName: string
  redirectUris: string[]
  grantTypes: string[]
  scopes: OAuthScope[]
}): Promise<OAuthClient> {
  // 128 bits of randomness. A client_id is an identifier, not a credential —
  // it is unguessable only so that registrations cannot be enumerated.
  const clientId = randomBytes(16).toString('base64url')
  const res = await libraryQuery(
    `INSERT INTO library_oauth_clients (client_id, client_name, redirect_uris, grant_types, scopes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING client_id, client_name, redirect_uris, grant_types, scopes, created_at`,
    [
      clientId,
      input.clientName,
      JSON.stringify(input.redirectUris),
      JSON.stringify(input.grantTypes),
      JSON.stringify(input.scopes),
    ],
  )
  return toClient(res.rows[0] as ClientRow)
}

export async function getClient(clientId: unknown): Promise<OAuthClient | null> {
  if (typeof clientId !== 'string' || !clientId) return null
  const res = await libraryQuery(
    `SELECT client_id, client_name, redirect_uris, grant_types, scopes, created_at
     FROM library_oauth_clients
     WHERE client_id = $1 AND disabled_at IS NULL`,
    [clientId],
  )
  const row = res.rows[0] as ClientRow | undefined
  return row ? toClient(row) : null
}

/**
 * Turn a client off. Two writes, deliberately in one call:
 *  - `disabled_at` stops every future authorization and every future bearer
 *    lookup (see getOAuthAccessPrincipal);
 *  - every token the client holds, for EVERY user, is revoked, because the
 *    flag alone would leave already-issued access tokens working for their
 *    full hour. Disabling a client is an incident action; an hour is not an
 *    acceptable answer to "cut it off now".
 * Returns null for a client that does not exist, so a typo at the CLI is not
 * reported as a successful disable.
 */
export interface DisabledClient {
  clientName: string
  /** True when the flag was already set — the token sweep still runs. */
  alreadyDisabled: boolean
  tokensRevoked: number
}

export async function disableClient(clientId: unknown): Promise<DisabledClient | null> {
  if (typeof clientId !== 'string' || !clientId) return null
  const found = await libraryQuery(
    `SELECT client_name, disabled_at FROM library_oauth_clients WHERE client_id = $1`,
    [clientId],
  )
  const row = found.rows[0] as { client_name: string; disabled_at: unknown } | undefined
  if (!row) return null
  const alreadyDisabled = row.disabled_at !== null && row.disabled_at !== undefined
  if (!alreadyDisabled) {
    await libraryQuery(
      `UPDATE library_oauth_clients SET disabled_at = now() WHERE client_id = $1 AND disabled_at IS NULL`,
      [clientId],
    )
  }
  const revoked = await libraryQuery(
    `UPDATE library_oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND revoked_at IS NULL`,
    [clientId],
  )
  return { clientName: row.client_name, alreadyDisabled, tokensRevoked: revoked.rowCount ?? 0 }
}

/** What an operator needs to decide whether a self-registered client is one
 *  of ours: who it says it is, when it appeared, whether anyone is using it. */
export interface OAuthClientSummary {
  clientId: string
  clientName: string
  createdAt: string
  disabledAt: string | null
  /** Access + refresh rows that are neither revoked nor expired. */
  liveTokens: number
}

/**
 * Every registered client, newest first. Two small queries rather than one
 * grouped join: the set is tiny (this is a CLI listing) and "count the live
 * tokens" stays a sentence anyone can check.
 */
export async function listClientSummaries(): Promise<OAuthClientSummary[]> {
  const clients = await libraryQuery(
    `SELECT client_id, client_name, created_at, disabled_at
     FROM library_oauth_clients ORDER BY created_at DESC, client_id`,
  )
  const counts = await libraryQuery(
    `SELECT client_id, COUNT(*) AS live
     FROM library_oauth_tokens
     WHERE revoked_at IS NULL AND expires_at > $1
     GROUP BY client_id`,
    [new Date()],
  )
  const live = new Map<string, number>()
  for (const row of counts.rows as { client_id: string; live: unknown }[]) {
    live.set(row.client_id, Number(row.live))
  }
  return (
    clients.rows as { client_id: string; client_name: string; created_at: unknown; disabled_at: unknown }[]
  ).map(row => ({
    clientId: row.client_id,
    clientName: row.client_name,
    createdAt: isoTime(row.created_at),
    disabledAt: isoTimeOrNull(row.disabled_at),
    liveTokens: live.get(row.client_id) ?? 0,
  }))
}

/** Exact match, and the only redirect check there is. */
export function clientAllowsRedirect(client: OAuthClient, redirectUri: unknown): boolean {
  return typeof redirectUri === 'string' && client.redirectUris.includes(redirectUri)
}

// --- pending authorize requests --------------------------------------------

/** The validated authorize request, parked while the human logs in. */
export interface PendingAuthorize {
  clientId: string
  redirectUri: string
  scopes: OAuthScope[]
  state: string | null
  codeChallenge: string
  resource: string
}

export async function createPendingAuthorize(params: PendingAuthorize): Promise<string> {
  const id = randomBytes(16).toString('base64url')
  await libraryQuery(
    `INSERT INTO library_oauth_pending (id_hash, params, expires_at) VALUES ($1, $2, $3)`,
    [sha256(id), JSON.stringify(params), new Date(Date.now() + PENDING_TTL_MS)],
  )
  return id
}

export async function getPendingAuthorize(id: unknown): Promise<PendingAuthorize | null> {
  if (typeof id !== 'string' || !id) return null
  const res = await libraryQuery(
    `SELECT params FROM library_oauth_pending WHERE id_hash = $1 AND expires_at > $2`,
    [sha256(id), new Date()],
  )
  const row = res.rows[0] as { params: unknown } | undefined
  if (!row) return null
  const params = typeof row.params === 'string' ? safeParse(row.params) : row.params
  return (params as PendingAuthorize | null) ?? null
}

/** Consume the pending row so one approval cannot mint two codes. */
export async function deletePendingAuthorize(id: string): Promise<void> {
  await libraryQuery(`DELETE FROM library_oauth_pending WHERE id_hash = $1`, [sha256(id)])
}

// --- authorization codes ----------------------------------------------------

export interface AuthorizationCodeRecord {
  id: number
  clientId: string
  userId: number
  redirectUri: string
  codeChallenge: string
  scopes: OAuthScope[]
  resource: string
  familyId: string | null
  usedAt: string | null
  expiresAt: string
}

export async function createAuthorizationCode(input: {
  clientId: string
  userId: number
  redirectUri: string
  codeChallenge: string
  scopes: OAuthScope[]
  resource: string
}): Promise<string> {
  const code = randomBytes(32).toString('base64url')
  await libraryQuery(
    `INSERT INTO library_oauth_codes
       (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      sha256(code),
      input.clientId,
      input.userId,
      input.redirectUri,
      input.codeChallenge,
      JSON.stringify(input.scopes),
      input.resource,
      new Date(Date.now() + CODE_TTL_MS),
    ],
  )
  return code
}

/** Look a code up without consuming it — the caller checks the client, the
 *  redirect and the verifier before anything is marked used. */
export async function findAuthorizationCode(code: unknown): Promise<AuthorizationCodeRecord | null> {
  if (typeof code !== 'string' || !code) return null
  const res = await libraryQuery(
    `SELECT id, client_id, user_id, redirect_uri, code_challenge, scopes, resource, family_id, used_at, expires_at
     FROM library_oauth_codes WHERE code_hash = $1`,
    [sha256(code)],
  )
  const row = res.rows[0] as
    | {
        id: unknown
        client_id: string
        user_id: unknown
        redirect_uri: string
        code_challenge: string
        scopes: unknown
        resource: string
        family_id: string | null
        used_at: unknown
        expires_at: unknown
      }
    | undefined
  if (!row) return null
  return {
    id: Number(row.id),
    clientId: row.client_id,
    userId: Number(row.user_id),
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scopes: asStrings(row.scopes) as OAuthScope[],
    resource: row.resource,
    familyId: row.family_id,
    usedAt: isoTimeOrNull(row.used_at),
    expiresAt: isoTime(row.expires_at),
  }
}

/**
 * Mark a code used, and say whether THIS caller is the one that used it.
 * The `used_at IS NULL` guard makes the claim atomic: two exchanges racing
 * on the same code can only both succeed if the database lets them, and it
 * does not. false means the code was already spent — a replay.
 */
export async function claimAuthorizationCode(codeId: number): Promise<boolean> {
  const res = await libraryQuery(
    `UPDATE library_oauth_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [codeId],
  )
  return (res.rowCount ?? 0) > 0
}

async function stampCodeFamily(codeId: number, familyId: string): Promise<void> {
  await libraryQuery(`UPDATE library_oauth_codes SET family_id = $2 WHERE id = $1`, [codeId, familyId])
}

// --- tokens -----------------------------------------------------------------

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  scopes: OAuthScope[]
  familyId: string
}

async function insertToken(input: {
  kind: 'access' | 'refresh'
  token: string
  familyId: string
  userId: number
  clientId: string
  scopes: OAuthScope[]
  resource: string
  ttlMs: number
}): Promise<void> {
  await libraryQuery(
    `INSERT INTO library_oauth_tokens (kind, token_hash, family_id, user_id, client_id, scopes, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.kind,
      sha256(input.token),
      input.familyId,
      input.userId,
      input.clientId,
      JSON.stringify(input.scopes),
      input.resource,
      new Date(Date.now() + input.ttlMs),
    ],
  )
}

/**
 * Issue an access/refresh pair. `familyId` ties them together for the life of
 * the authorization: every rotation stays in the family, "revoke this app"
 * kills the family, and a replayed refresh token kills the family.
 */
export async function issueTokenPair(input: {
  userId: number
  clientId: string
  scopes: OAuthScope[]
  resource: string
  familyId?: string
  fromCodeId?: number
}): Promise<IssuedTokens> {
  const familyId = input.familyId ?? randomBytes(16).toString('base64url')
  const accessToken = `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const common = { familyId, userId: input.userId, clientId: input.clientId, scopes: input.scopes, resource: input.resource }
  await insertToken({ ...common, kind: 'access', token: accessToken, ttlMs: ACCESS_TOKEN_TTL_MS })
  await insertToken({ ...common, kind: 'refresh', token: refreshToken, ttlMs: REFRESH_TOKEN_TTL_MS })
  if (input.fromCodeId !== undefined) await stampCodeFamily(input.fromCodeId, familyId)
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scopes: input.scopes,
    familyId,
  }
}

export interface TokenRecord {
  id: number
  kind: 'access' | 'refresh'
  familyId: string
  userId: number
  clientId: string
  scopes: OAuthScope[]
  resource: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
}

interface TokenRow {
  id: unknown
  kind: 'access' | 'refresh'
  family_id: string
  user_id: unknown
  client_id: string
  scopes: unknown
  resource: string
  expires_at: unknown
  used_at: unknown
  revoked_at: unknown
}

function toTokenRecord(row: TokenRow): TokenRecord {
  return {
    id: Number(row.id),
    kind: row.kind,
    familyId: row.family_id,
    userId: Number(row.user_id),
    clientId: row.client_id,
    scopes: asStrings(row.scopes) as OAuthScope[],
    resource: row.resource,
    expiresAt: isoTime(row.expires_at),
    usedAt: isoTimeOrNull(row.used_at),
    revokedAt: isoTimeOrNull(row.revoked_at),
  }
}

/** Raw lookup, including spent and revoked rows — reuse detection needs to
 *  see exactly those, so filtering here would hide the attack. */
export async function findToken(token: unknown, kind: 'access' | 'refresh'): Promise<TokenRecord | null> {
  if (typeof token !== 'string' || !token) return null
  const res = await libraryQuery(
    `SELECT id, kind, family_id, user_id, client_id, scopes, resource, expires_at, used_at, revoked_at
     FROM library_oauth_tokens WHERE token_hash = $1 AND kind = $2`,
    [sha256(token), kind],
  )
  const row = res.rows[0] as TokenRow | undefined
  return row ? toTokenRecord(row) : null
}

/** Atomically spend a refresh token. false = it was already rotated away or
 *  revoked, which the caller must treat as a replay. */
export async function claimRefreshToken(tokenId: number): Promise<boolean> {
  const res = await libraryQuery(
    `UPDATE library_oauth_tokens SET used_at = now()
     WHERE id = $1 AND kind = 'refresh' AND used_at IS NULL AND revoked_at IS NULL
     RETURNING id`,
    [tokenId],
  )
  return (res.rowCount ?? 0) > 0
}

/** Kill every token in one authorization. Used by "revoke this app", by
 *  RFC 7009 revocation of a refresh token, and by reuse detection. */
export async function revokeFamily(familyId: string): Promise<number> {
  const res = await libraryQuery(
    `UPDATE library_oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  )
  return res.rowCount ?? 0
}

/**
 * Has anything in this family been revoked? The claim of a code or a refresh
 * token and the issue of the next pair are two statements, not one
 * transaction, and a racing replay can revoke the family in between. Asking
 * this right after issuing is what stops the new pair from outliving the
 * revocation that was meant to kill it.
 */
export async function isFamilyRevoked(familyId: string): Promise<boolean> {
  const res = await libraryQuery(
    `SELECT 1 FROM library_oauth_tokens WHERE family_id = $1 AND revoked_at IS NOT NULL LIMIT 1`,
    [familyId],
  )
  return (res.rowCount ?? 0) > 0
}

export async function revokeTokenById(tokenId: number): Promise<void> {
  await libraryQuery(
    `UPDATE library_oauth_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [tokenId],
  )
}

/** Who a bearer access token resolves to, or null for anything not currently
 *  usable. Mirrors getApiTokenPrincipal(): one definition of "live". */
export interface OAuthPrincipal {
  user: InternalUser
  tokenId: number
  clientId: string
  clientName: string
  familyId: string
  scopes: OAuthScope[]
}

export async function getOAuthAccessPrincipal(
  token: string,
  expectedResource: string,
): Promise<OAuthPrincipal | null> {
  if (typeof token !== 'string' || !token.startsWith(ACCESS_TOKEN_PREFIX)) return null
  const res = await libraryQuery(
    `SELECT t.id AS token_id, t.scopes, t.resource, t.family_id, t.client_id,
            COALESCE(c.client_name, '') AS client_name,
            u.id, u.username, u.role
     FROM library_oauth_tokens t
     JOIN library_users u ON u.id = t.user_id
     LEFT JOIN library_oauth_clients c ON c.client_id = t.client_id
     WHERE t.token_hash = $1
       AND t.kind = 'access'
       AND t.revoked_at IS NULL
       AND t.expires_at > $2
       AND u.disabled = FALSE
       -- A disabled client is cut off IMMEDIATELY, not when its hour-long
       -- access tokens happen to expire. NULL passes because the LEFT JOIN
       -- yields NULL for a client row that has been pruned away, and an
       -- orphaned token is judged by its own revoked_at, not by a missing row.
       AND c.disabled_at IS NULL`,
    [sha256(token), new Date()],
  )
  const row = res.rows[0] as
    | {
        token_id: unknown
        scopes: unknown
        resource: string
        family_id: string
        client_id: string
        client_name: string
        id: unknown
        username: string
        role: 'admin' | 'internal'
      }
    | undefined
  if (!row) return null
  // Audience check (RFC 8707): a token minted for another resource is not a
  // token for this one, however valid its signature-equivalent looks.
  if (!resourceMatches(row.resource, expectedResource)) return null
  return {
    user: { id: Number(row.id), username: row.username, role: row.role },
    tokenId: Number(row.token_id),
    clientId: row.client_id,
    clientName: row.client_name,
    familyId: row.family_id,
    scopes: asStrings(row.scopes) as OAuthScope[],
  }
}

/**
 * "Last used" for the connected-apps list. Same once-a-minute throttle as
 * personal tokens: a read-only tool call must not become a write per request.
 */
export const TOUCH_INTERVAL_MS = 60_000
const lastTouched = new Map<number, number>()

export function touchOAuthToken(tokenId: number): void {
  const now = Date.now()
  if (now - (lastTouched.get(tokenId) ?? 0) < TOUCH_INTERVAL_MS) return
  lastTouched.set(tokenId, now)
  libraryQuery(`UPDATE library_oauth_tokens SET last_used_at = now() WHERE id = $1`, [tokenId]).catch(err =>
    console.error('[oauth] token touch failed:', err?.message || err),
  )
}

/** Tests share one process and one throttle map. */
export function clearOAuthTouchCache(): void {
  lastTouched.clear()
}

// --- grants (the account page's "connected apps") ---------------------------

export interface OAuthGrantSummary {
  /** The family id: one authorization, one row on the account page. */
  id: string
  clientName: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
}

/**
 * One row per live authorization. Grouped in JS rather than SQL because the
 * set is tiny (a person has a handful of connected apps) and the aggregate
 * shape is easier to read — and to be sure of — than a GROUP BY here.
 */
export async function listGrants(userId: number): Promise<OAuthGrantSummary[]> {
  const res = await libraryQuery(
    `SELECT t.family_id, t.client_id, COALESCE(c.client_name, '') AS client_name,
            t.scopes, t.created_at, t.last_used_at
     FROM library_oauth_tokens t
     LEFT JOIN library_oauth_clients c ON c.client_id = t.client_id
     WHERE t.user_id = $1 AND t.revoked_at IS NULL AND t.expires_at > $2
     ORDER BY t.id DESC`,
    [userId, new Date()],
  )
  const byFamily = new Map<string, OAuthGrantSummary>()
  for (const raw of res.rows as {
    family_id: string
    client_name: string
    scopes: unknown
    created_at: unknown
    last_used_at: unknown
  }[]) {
    const createdAt = isoTime(raw.created_at)
    const lastUsedAt = isoTimeOrNull(raw.last_used_at)
    const existing = byFamily.get(raw.family_id)
    if (!existing) {
      byFamily.set(raw.family_id, {
        id: raw.family_id,
        clientName: raw.client_name || 'Unknown application',
        scopes: asStrings(raw.scopes),
        createdAt,
        lastUsedAt,
      })
      continue
    }
    // A family spans rotations: the grant began at the OLDEST token and was
    // last used at the NEWEST use.
    if (createdAt < existing.createdAt) existing.createdAt = createdAt
    if (lastUsedAt && (!existing.lastUsedAt || lastUsedAt > existing.lastUsedAt)) {
      existing.lastUsedAt = lastUsedAt
    }
  }
  return [...byFamily.values()]
}

/**
 * Revoke one grant. Scoped to the owner in SQL, so a family id belonging to
 * someone else is indistinguishable from one that does not exist — ids cannot
 * be probed. Returns the client name for the audit row, or null.
 */
export async function revokeGrant(userId: number, familyId: unknown): Promise<{ clientName: string } | null> {
  if (typeof familyId !== 'string' || !familyId) return null
  const res = await libraryQuery(
    `UPDATE library_oauth_tokens SET revoked_at = now()
     WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING client_id`,
    [familyId, userId],
  )
  if ((res.rowCount ?? 0) === 0) return null
  const clientId = (res.rows[0] as { client_id: string }).client_id
  const client = await getClient(clientId)
  return { clientName: client?.clientName ?? 'Unknown application' }
}

// --- housekeeping -----------------------------------------------------------

/** How long a dead OAuth row is kept: long enough for an incident to read the
 *  history, short enough that the table is not an archive of hashes. */
export const OAUTH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Delete expired codes, pending requests and tokens, plus revoked tokens past
 * the retention window. Called once at boot alongside the session prune —
 * these tables only grow otherwise. Never throws for a missing store: the
 * caller treats housekeeping as best effort.
 */
export async function pruneOAuth(): Promise<number> {
  const now = new Date()
  const cutoff = new Date(Date.now() - OAUTH_RETENTION_MS)
  let removed = 0
  const codes = await libraryQuery(`DELETE FROM library_oauth_codes WHERE expires_at < $1`, [cutoff])
  removed += codes.rowCount ?? 0
  const pending = await libraryQuery(`DELETE FROM library_oauth_pending WHERE expires_at < $1`, [now])
  removed += pending.rowCount ?? 0
  const tokens = await libraryQuery(
    `DELETE FROM library_oauth_tokens
      WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)`,
    [cutoff],
  )
  removed += tokens.rowCount ?? 0
  // Registration is unauthenticated by design (RFC 7591), so this is the one
  // table an anonymous caller can grow. A client past the retention window
  // that nobody ever completed a flow with is junk; one with a token, a live
  // code or a parked authorize request is still someone's connection and is
  // left alone. Runs LAST so the deletes above have already cleared the dead
  // rows that would otherwise pin a client in place.
  const clients = await libraryQuery(
    `DELETE FROM library_oauth_clients
      WHERE created_at < $1
        AND client_id NOT IN (SELECT client_id FROM library_oauth_tokens)
        AND client_id NOT IN (SELECT client_id FROM library_oauth_codes)
        AND client_id NOT IN (
          SELECT params->>'clientId' FROM library_oauth_pending WHERE params->>'clientId' IS NOT NULL
        )`,
    [cutoff],
  )
  removed += clients.rowCount ?? 0
  return removed
}
