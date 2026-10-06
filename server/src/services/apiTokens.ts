import { createHash, randomBytes } from 'crypto'
import { isLibraryEnabled, libraryQuery } from './libraryDb.js'
import { ACCESS_TOKEN_PREFIX, getOAuthAccessPrincipal, touchOAuthToken } from './oauthStore.js'
import type { InternalUser } from './internalSessions.js'

/**
 * Personal API tokens (P5-50) — the credential a non-browser client (Claude
 * Desktop, Claude Code, a script) presents to the MCP endpoint.
 *
 * Deliberately the same shape as internalSessions.ts: the DB stores only the
 * sha256 of the token, so a database leak yields nothing that can be replayed.
 * The differences from a session are all consequences of who holds it:
 *  - it lives in a config file on someone's laptop, so it is NAMED ("Claude
 *    Desktop — laptop") and revocable one at a time from the account page;
 *  - it has no expiry, because a desktop client cannot re-log-in on its own —
 *    revocation is the whole safety mechanism, which is why `revoked_at` is a
 *    timestamp rather than a flag;
 *  - it carries SCOPES. Only `read` is issued today; `write` is reserved for
 *    the write tools (P5-52) so that ticket needs no schema change and no
 *    re-minting of already-issued read tokens.
 *
 * CSRF is not a concern here: the token never rides in a cookie, so a browser
 * cannot be tricked into attaching it. Minting/revoking, which DO go through
 * the cookie session, are CSRF-guarded by requireInternalUser as usual.
 */

/** Prefix so a leaked string is recognisable in a log or a paste — secret
 *  scanners key off exactly this kind of marker. */
export const API_TOKEN_PREFIX = 'blo_'
/** 32 bytes of randomness, base64url — 256 bits, same as a session token. */
const TOKEN_BYTES = 32
export const TOKEN_NAME_MAX = 60
/** Scopes a token may hold. `write` is granted only when the person minting
 *  the token ticks "Allow writes" (P5-52); every token carries `read`. */
export const API_TOKEN_SCOPES = ['read', 'write'] as const
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number]
/** What the account page mints unless writes were asked for. */
export const DEFAULT_SCOPES: ApiTokenScope[] = ['read']
/** A token that may also use the MCP write tools. `read` rides along because
 *  /mcp gates the whole endpoint on `read` — a write-only token could not
 *  reach a tool at all, and no assistant writes without reading first. */
export const WRITE_SCOPES: ApiTokenScope[] = ['read', 'write']

export interface ApiTokenSummary {
  id: number
  name: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
}

/** A freshly minted token. `token` is the one and only copy of the secret;
 *  it is returned once and never retrievable again. */
export interface MintedApiToken extends ApiTokenSummary {
  token: string
}

/** Who a valid bearer token resolves to. */
export interface ApiTokenPrincipal {
  user: InternalUser
  tokenId: number
  scopes: string[]
  /** The name the person gave this token ("Claude Desktop — laptop"). It is
   *  the only human label a personal token has, so it is what a write is
   *  attributed to — "via Claude Desktop — laptop" (P5-52). */
  name: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
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

function asScopes(value: unknown): string[] {
  const raw = typeof value === 'string' ? safeParse(value) : value
  if (!Array.isArray(raw)) return [...DEFAULT_SCOPES]
  const scopes = raw.filter((v): v is string => typeof v === 'string')
  return scopes.length ? scopes : [...DEFAULT_SCOPES]
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** The name is user-supplied and shows up on the account page and nowhere
 *  else, so the only rules are "present" and "not a pasted document". */
export function validateTokenName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'a token name is required' }
  const name = raw.trim()
  if (!name) return { error: 'a token name is required' }
  if (name.length > TOKEN_NAME_MAX) {
    return { error: `token names are limited to ${TOKEN_NAME_MAX} characters` }
  }
  return { name }
}

/**
 * Bodies a personal token may not have. `blo_at_…` and `blo_rt_…` are the
 * OAuth prefixes, and getBearerPrincipal routes on them BEFORE it consults
 * the personal-token table — so a personal token whose random body began
 * `at_` would be looked up in the wrong table and could never authenticate.
 * One draw in 2^18 lands there: rare enough that nobody would ever diagnose
 * it, common enough to happen. Cheaper to design out than to support.
 */
const RESERVED_BODIES = ['at_', 'rt_']
/** A real RNG clears the check on the first draw essentially always; the cap
 *  exists so a broken injected source fails loudly instead of hanging. */
const MAX_DRAWS = 8

/** `blo_` + 256 bits, base64url so it survives a config file, a shell
 *  variable, and an Authorization header untouched. The randomness source is
 *  a parameter only so a test can force the collision path. */
export function generateApiToken(random: (size: number) => Buffer = randomBytes): string {
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const body = random(TOKEN_BYTES).toString('base64url')
    if (!RESERVED_BODIES.some(reserved => body.startsWith(reserved))) {
      return `${API_TOKEN_PREFIX}${body}`
    }
  }
  throw new Error('could not generate an API token: the random source keeps returning reserved prefixes')
}

interface TokenRow {
  id: unknown
  name: string
  scopes: unknown
  created_at: unknown
  last_used_at: unknown
}

function toSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: Number(row.id),
    name: row.name,
    scopes: asScopes(row.scopes),
    createdAt: isoTime(row.created_at),
    lastUsedAt: isoTimeOrNull(row.last_used_at),
  }
}

/** Mint a token for a user. The raw secret is returned here and nowhere
 *  else — the caller must hand it to the human immediately. */
export async function createApiToken(
  userId: number,
  name: string,
  scopes: ApiTokenScope[] = DEFAULT_SCOPES,
): Promise<MintedApiToken> {
  const token = generateApiToken()
  const res = await libraryQuery(
    `INSERT INTO library_api_tokens (user_id, name, token_hash, scopes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, scopes, created_at, last_used_at`,
    [userId, name, hashToken(token), JSON.stringify(scopes)],
  )
  return { ...toSummary(res.rows[0] as TokenRow), token }
}

/** A user's live tokens, newest first. Revoked rows are kept in the table
 *  (an incident wants the history) but never listed — the account page is a
 *  "what can reach my library right now" screen. */
export async function listApiTokens(userId: number): Promise<ApiTokenSummary[]> {
  const res = await libraryQuery(
    `SELECT id, name, scopes, created_at, last_used_at
     FROM library_api_tokens
     WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY id DESC`,
    [userId],
  )
  return (res.rows as TokenRow[]).map(toSummary)
}

export type RevokeResult = { revoked: true; name: string; ownerId: number } | { revoked: false }

/**
 * Revoke one token. Non-admins may only revoke their own; an admin can cut
 * off anyone's (the "a laptop walked off" case). A token that does not exist
 * and a token belonging to someone else are the SAME answer to a non-admin,
 * so probing ids tells them nothing.
 */
export async function revokeApiToken(id: number, actor: InternalUser): Promise<RevokeResult> {
  const scope = actor.role === 'admin' ? '' : ' AND user_id = $2'
  const params: unknown[] = actor.role === 'admin' ? [id] : [id, actor.id]
  const res = await libraryQuery(
    `UPDATE library_api_tokens SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL${scope}
     RETURNING name, user_id`,
    params,
  )
  const row = res.rows[0] as { name: string; user_id: unknown } | undefined
  return row ? { revoked: true, name: row.name, ownerId: Number(row.user_id) } : { revoked: false }
}

/**
 * Resolve a bearer token to its user, or null for anything not currently
 * usable: unknown, revoked, or belonging to a disabled account. Mirrors
 * getSessionUser() — one definition of "this credential is live".
 */
export async function getApiTokenPrincipal(token: string): Promise<ApiTokenPrincipal | null> {
  if (!isLibraryEnabled()) return null
  if (typeof token !== 'string' || !token.startsWith(API_TOKEN_PREFIX)) return null
  const res = await libraryQuery(
    `SELECT t.id AS token_id, t.name, t.scopes, u.id, u.username, u.role
     FROM library_api_tokens t
     JOIN library_users u ON u.id = t.user_id
     WHERE t.token_hash = $1
       AND t.revoked_at IS NULL
       AND u.disabled = FALSE`,
    [hashToken(token)],
  )
  const row = res.rows[0] as
    | { token_id: unknown; name: string; scopes: unknown; id: unknown; username: string; role: 'admin' | 'internal' }
    | undefined
  if (!row) return null
  return {
    user: { id: Number(row.id), username: row.username, role: row.role },
    tokenId: Number(row.token_id),
    scopes: asScopes(row.scopes),
    name: row.name,
  }
}

/**
 * "Last used" is for the human deciding which stale token to revoke, so
 * minute-level accuracy is plenty — and a write on every MCP call would turn
 * a read-only tool into a write per request. The throttle map is per-process
 * and unbounded only in the number of live tokens, which is tiny.
 */
export const TOUCH_INTERVAL_MS = 60_000
const lastTouched = new Map<number, number>()

export function touchApiToken(tokenId: number): void {
  const now = Date.now()
  const previous = lastTouched.get(tokenId) ?? 0
  if (now - previous < TOUCH_INTERVAL_MS) return
  lastTouched.set(tokenId, now)
  libraryQuery(`UPDATE library_api_tokens SET last_used_at = now() WHERE id = $1`, [tokenId]).catch(err =>
    // Never fail a tool call over a usage stamp; silence would hide a broken
    // column, so it is logged.
    console.error('[library] token touch failed:', err?.message || err),
  )
}

/** Tests share one process and one throttle map. */
export function clearApiTokenTouchCache(): void {
  lastTouched.clear()
}

/**
 * The two credentials /mcp accepts, resolved by one function (P5-51).
 *
 * A personal token is a laptop's long-lived key; an OAuth access token is a
 * remote connector's hour-long one. Everything downstream — the limiter, the
 * audit rows, the tools — should not care which arrived, so the difference is
 * flattened here into a user plus a set of scopes. `kind` survives only for
 * the "last used" stamp, which lives in a different table for each.
 */
export interface BearerPrincipal {
  user: InternalUser
  scopes: string[]
  kind: 'personal' | 'oauth'
  /** Which program is calling, in words: the registered `client_name` for an
   *  OAuth token, the token's own name for a personal one. P5-52 stamps it on
   *  every write as `via <clientName>`, so it is never absent. */
  clientName: string
}

/**
 * Resolve an Authorization: Bearer value.
 *
 * The OAuth prefix is checked FIRST because it is a longer prefix of the same
 * namespace (`blo_at_…` also starts with `blo_`), and an OAuth token must
 * never be looked up in the personal-token table.
 *
 * `expectedResource` is the audience check: null means OAuth is not
 * configured on this server, in which case only personal tokens are accepted
 * — a server with no issuer has no business honouring tokens minted for one.
 */
export async function getBearerPrincipal(
  token: string,
  expectedResource: string | null,
): Promise<BearerPrincipal | null> {
  if (!isLibraryEnabled() || typeof token !== 'string' || !token) return null
  if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
    if (!expectedResource) return null
    const principal = await getOAuthAccessPrincipal(token, expectedResource)
    if (!principal) return null
    touchOAuthToken(principal.tokenId)
    return {
      user: principal.user,
      scopes: principal.scopes,
      kind: 'oauth',
      clientName: principal.clientName,
    }
  }
  const personal = await getApiTokenPrincipal(token)
  if (!personal) return null
  touchApiToken(personal.tokenId)
  return { user: personal.user, scopes: personal.scopes, kind: 'personal', clientName: personal.name }
}

/** Does this credential carry the scope a tool needs? Read tools ask for
 *  `read`; the write tools (P5-52) ask for `write`. */
export function hasScope(scopes: string[] | undefined, required: string): boolean {
  return Array.isArray(scopes) && scopes.includes(required)
}
