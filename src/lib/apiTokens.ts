/**
 * Client helpers for personal API tokens (P5-50).
 *
 * A token is what an MCP client (Claude Desktop, etc.) presents instead of the
 * browser session cookie, so the read tools can reach the library from outside
 * the app. The server owns minting, hashing and scopes — the client only ever
 * names a token, lists the ones it already has, and revokes one.
 *
 * The secret itself is returned exactly once, by POST; nothing here stores it.
 * These calls ride the internal session cookie + CSRF (internalFetch), so an
 * anonymous visitor cannot mint a token by hitting the endpoint directly.
 */

import { API_URL, internalFetch } from './apiBase'

/** A token as the server is willing to describe it after minting: everything
 *  except the secret, which is unrecoverable once the POST response is gone. */
export interface ApiTokenSummary {
  id: number
  name: string
  scopes: string[]
  createdAt: string
  /** null until an MCP client actually authenticates with it. */
  lastUsedAt: string | null
}

/** The scope a token needs before an assistant can change anything (P5-52).
 *  Read-only tokens carry `read` alone. */
export const WRITE_SCOPE = 'write'

/** The one-time mint response — `token` is the only copy of the secret. */
export interface MintedApiToken {
  token: string
  id: number
  name: string
  createdAt: string
  scopes: string[]
}

/** Mirrors the server's name limit so a too-long name is caught before the
 *  round trip; the server still enforces it. */
export const TOKEN_NAME_MAX = 60

/**
 * Client-side mirror of the server's name rule. Returns the message to show,
 * or null when the name is acceptable. Names are the only way to tell tokens
 * apart later (the secret is never shown again), hence the hard requirement.
 */
export function validateTokenName(raw: string): string | null {
  const name = raw.trim()
  if (!name) return 'Give the token a name so you can tell it apart later.'
  if (name.length > TOKEN_NAME_MAX) {
    return `Keep the name under ${TOKEN_NAME_MAX} characters.`
  }
  return null
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // non-JSON body — fall through
  }
  return fallback
}

/** Active (non-revoked) tokens for the signed-in user, newest first. */
export async function listApiTokens(): Promise<ApiTokenSummary[]> {
  const res = await internalFetch('/api/library/tokens')
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load tokens (${res.status})`))
  }
  const body = (await res.json()) as { tokens?: ApiTokenSummary[] }
  return body.tokens ?? []
}

/**
 * Mint a token. The returned `token` is the only time the secret exists
 * client-side — callers must show it immediately or lose it.
 *
 * `allowWrites` asks the server for the `write` scope as well (P5-52), which
 * is what lets an assistant add notes, append to pages, drop links and save
 * views. It is a separate argument rather than a default because a token that
 * can only read is the safer thing to hand out, and the person minting one
 * should have to say they want more.
 */
export async function createApiToken(name: string, allowWrites = false): Promise<MintedApiToken> {
  const res = await internalFetch('/api/library/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Send the same trimmed string validateTokenName measured, so a name that
    // passed here can't fail the server's length check on stray whitespace.
    // `write` is omitted unless asked for: the server treats absent as false,
    // and an omitted field cannot be misread as a request for it.
    body: JSON.stringify({ name: name.trim(), ...(allowWrites ? { write: true } : {}) }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to create token (${res.status})`))
  }
  return (await res.json()) as MintedApiToken
}

/** Revoke a token by id. Revocation is immediate and irreversible. */
export async function revokeApiToken(id: number): Promise<void> {
  const res = await internalFetch(`/api/library/tokens/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to revoke token (${res.status})`))
  }
}

// --- OAuth connections (P5-51) ----------------------------------------------

/**
 * "Connected apps": one row per app the user has authorized over OAuth —
 * ChatGPT's custom connector, Claude's remote connector. Distinct from the
 * personal tokens above in who holds the credential: a token lives in a config
 * file the user pasted it into, a grant lives inside somebody else's product,
 * which is exactly why it needs its own revoke button.
 *
 * `id` is the grant's family id — the whole authorization, access tokens and
 * rotating refresh tokens together — so revoking it disconnects the app rather
 * than expiring one token it would immediately replace.
 */
export interface OAuthGrantSummary {
  id: string
  clientName: string
  scopes: string[]
  createdAt: string
  /** null until the app actually calls the MCP endpoint. */
  lastUsedAt: string | null
}

/** An authorization request parked while the user logged in. The account page
 *  shows it so they can finish what the connector started. */
export interface PendingAuthorization {
  clientName: string
  scopes: string[]
  /** Plain-words scope labels, rendered as-is — the server owns the wording. */
  scopeDescriptions: string[]
}

/** Live OAuth connections for the signed-in user. */
export async function listOAuthGrants(): Promise<OAuthGrantSummary[]> {
  const res = await internalFetch('/api/library/oauth/grants')
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load connected apps (${res.status})`))
  }
  const body = (await res.json()) as { grants?: OAuthGrantSummary[] }
  return body.grants ?? []
}

/** Disconnect an app: revokes its access AND refresh tokens at once, so it
 *  cannot quietly refresh its way back in. */
export async function revokeOAuthGrant(id: string): Promise<void> {
  const res = await internalFetch(`/api/library/oauth/grants/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to disconnect (${res.status})`))
  }
}

/** Look up the app waiting on an authorization. Returns null when the request
 *  has expired or was already finished — a stale `?oauth=` in the URL is the
 *  normal case, not an error worth showing. */
export async function getPendingAuthorization(id: string): Promise<PendingAuthorization | null> {
  const res = await internalFetch(`/api/library/oauth/pending/${encodeURIComponent(id)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to load the pending request (${res.status})`))
  }
  return (await res.json()) as PendingAuthorization
}

/**
 * Where "Continue" sends the browser: back to the API's own consent screen,
 * which re-validates the request from scratch. Built from API_URL rather than
 * from anything in the page, so the destination can never be influenced by the
 * query string that brought the user here.
 */
export function authorizationContinueUrl(id: string): string {
  return `${API_URL}/oauth/authorize/continue/${encodeURIComponent(id)}`
}
