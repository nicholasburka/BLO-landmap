import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { isLibraryEnabled, libraryQuery } from './libraryDb.js'

/**
 * Internal (per-user) session primitives, backing the phase-5 login.
 *
 * Entirely separate from the anonymous HMAC-token path in middleware/auth.ts —
 * that one is the public map's and must stay byte-compatible. These sessions
 * are server-side rows in library_sessions; the browser holds only a random
 * opaque token in an httpOnly cookie, and the DB stores only its sha256 hash
 * (a DB leak must not yield usable session tokens).
 *
 * CSRF: the frontend is served cross-origin from the API (Netlify → API host),
 * so the classic readable-cookie double-submit doesn't work — JS can't read
 * cross-site cookies. Instead the CSRF token is *derived* from the session
 * token via HMAC and returned once in the login response body; the client
 * echoes it in X-CSRF-Token on mutating requests. No extra storage, and it
 * dies with the session.
 */

export const SESSION_COOKIE = 'blo_internal_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

export interface InternalUser {
  id: number
  username: string
  role: 'admin' | 'internal'
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function getSecret(): string {
  const secret = process.env.SESSION_HMAC_SECRET
  if (!secret) {
    throw new Error('SESSION_HMAC_SECRET is not set — server should have refused to boot')
  }
  return secret
}

/** Derive the CSRF token for a session token. Deterministic, so the server
 *  can recompute it on every request without storing anything. */
export function csrfTokenFor(sessionToken: string): string {
  return createHmac('sha256', getSecret()).update(`internal-csrf.${sessionToken}`).digest('hex')
}

/** Constant-time check of an X-CSRF-Token header against the session. */
export function csrfHeaderMatches(sessionToken: string, header: unknown): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const expected = Buffer.from(csrfTokenFor(sessionToken))
  const got = Buffer.from(header)
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** Mint a session for a user. Returns the raw token (for the cookie) —
 *  the only copy; the DB keeps just the hash. */
export async function createSession(userId: number): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex')
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
  await libraryQuery(
    `INSERT INTO library_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expiresAt],
  )
  return { token, expiresAt }
}

/** Resolve a session token to its user, or null for anything not currently
 *  valid: unknown, revoked, expired, or a disabled user. */
export async function getSessionUser(token: string): Promise<InternalUser | null> {
  if (!isLibraryEnabled()) return null
  const res = await libraryQuery(
    `SELECT u.id, u.username, u.role
     FROM library_sessions s
     JOIN library_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked = FALSE
       AND s.expires_at > $2
       AND u.disabled = FALSE`,
    [hashToken(token), new Date()],
  )
  const row = res.rows[0]
  if (!row) return null
  return { id: Number(row.id), username: row.username, role: row.role }
}

/** Revoke a session (logout, or superseded by a fresh login). Idempotent:
 *  the `revoked = FALSE` guard means a second call is a no-op rather than
 *  re-stamping revoked_at and pushing the prune grace period out again. */
export async function revokeSession(token: string): Promise<void> {
  await libraryQuery(
    `UPDATE library_sessions SET revoked = TRUE, revoked_at = $2
     WHERE token_hash = $1 AND revoked = FALSE`,
    [hashToken(token), new Date()],
  )
}

/**
 * Sign the user out everywhere except the session holding `keepToken`
 * (P5-76: changing your password ends every other login).
 *
 * Returns how many live sessions were ended, which is what the account page
 * reports back — so only rows that were still usable are touched. An expired
 * row already authenticates nobody; counting it would overstate the number to
 * the person reading the message, and pruneExpiredSessions() removes it.
 *
 * `keepToken` is compared by hash, the same form the table stores, so the
 * caller's raw cookie value never has to be trusted for anything but this.
 */
export async function revokeOtherSessions(userId: number, keepToken: string): Promise<number> {
  const now = new Date()
  const res = await libraryQuery(
    `UPDATE library_sessions SET revoked = TRUE, revoked_at = $3
     WHERE user_id = $1
       AND token_hash <> $2
       AND revoked = FALSE
       AND expires_at > $3`,
    [userId, hashToken(keepToken), now],
  )
  return res.rowCount ?? 0
}

/** How long a dead session row is kept before deletion. The rows are useless
 *  for authentication the moment they expire or are revoked; the window
 *  exists only so an incident investigation still has the recent history. */
export const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Delete session rows that have been dead longer than the retention window.
 * Called once at boot (index.ts) — the table only grows otherwise, and a
 * long-lived pile of session hashes is needless exposure in a DB leak.
 *
 * Returns the number of rows removed; 0 when the library store is disabled,
 * which is the normal no-DB deployment rather than an error.
 */
export async function pruneExpiredSessions(): Promise<number> {
  if (!isLibraryEnabled()) return 0
  const cutoff = new Date(Date.now() - SESSION_RETENTION_MS)
  const res = await libraryQuery(
    `DELETE FROM library_sessions
      WHERE expires_at < $1
         OR (revoked = TRUE AND COALESCE(revoked_at, created_at) < $1)`,
    // COALESCE: rows revoked before revoked_at existed have no revocation
    // timestamp, so their creation time is the most conservative stand-in.
    [cutoff],
  )
  return res.rowCount ?? 0
}
