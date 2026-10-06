import { Router, type Request, type RequestHandler } from 'express'
import argon2 from 'argon2'
import { verifyPassword } from '../services/passwords.js'
import { makeInternalLoginRateLimit } from '../middleware/rateLimit.js'
import { isAllowedOrigin } from '../middleware/origins.js'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { isLibraryEnabled, libraryQuery, writeAudit } from '../services/libraryDb.js'
import { hashIp } from '../services/usageStore.js'
import {
  SESSION_COOKIE,
  createSession,
  csrfTokenFor,
  revokeSession,
  type InternalUser,
} from '../services/internalSessions.js'

/**
 * Internal login/logout/me — the per-user auth entry points (phase 5).
 * Parallel to, and fully independent of, the anonymous token routes in
 * session.ts/auth.ts, which remain the public map's path.
 */

/** Verified for unknown usernames so response timing doesn't reveal whether
 *  an account exists (argon2 verify dominates the request time). Lazily
 *  computed once. */
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = argon2.hash('dummy-timing-equalizer')
  return dummyHashPromise
}

/** Cookie flags. Production runs cross-origin (Netlify frontend → API host),
 *  where SameSite=Strict cookies are never attached to fetches — so prod
 *  must use SameSite=None + Secure. CSRF exposure from None is covered by
 *  the X-CSRF-Token requirement on every mutating internal route. Dev is
 *  plain http, where Secure cookies would be dropped → Lax without Secure.
 *
 *  Secure also follows the actual scheme: req.secure honours X-Forwarded-Proto
 *  from the trusted proxy, so any HTTPS deployment gets a Secure cookie even
 *  if NODE_ENV was never set (staging, a preview host, a mislabelled box). */
function cookieOptions(req: Request, expiresAt?: Date) {
  const prod = process.env.NODE_ENV === 'production'
  return {
    httpOnly: true,
    secure: prod || req.secure,
    sameSite: sessionSameSite(prod),
    path: '/',
    ...(expiresAt ? { expires: expiresAt } : {}),
  }
}

function unauthorized(res: { status: (n: number) => { json: (b: unknown) => unknown } }): void {
  res.status(401).json({ error: 'unauthorized' })
}

/** Client fingerprint attached to every login audit row. The raw IP is never
 *  stored (same salted hash the usage store uses) and the user-agent is
 *  truncated so a client can't inflate the audit table with a huge header. */
const MAX_AUDITED_UA = 200
function auditContext(req: Request): { ipHash: string; ua: string } {
  return {
    ipHash: hashIp(req.ip ?? 'unknown'),
    ua: String(req.headers['user-agent'] ?? '').slice(0, MAX_AUDITED_UA),
  }
}

/**
 * Per-username login throttle.
 *
 * The IP limiter (rateLimit.ts) stops one address hammering the endpoint; it
 * cannot see a slow distributed guess spread across many addresses against
 * ONE account, which is the attack that actually gets in. 20 failures in an
 * hour locks that username — including attempts with the correct password,
 * so a guesser who lands on it still learns nothing.
 *
 * In-memory: one API process owns the login surface, and a restart reopening
 * the window is a fair trade for zero DB writes on an unauthenticated path.
 * Timestamps outside the window are dropped on read, which is also what
 * bounds the map.
 */
const USERNAME_FAILURE_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const USERNAME_FAILURE_LIMIT = 20
const USERNAME_TRACKING_CAP = 10_000
const failuresByUsername = new Map<string, number[]>()

/** Failure timestamps still inside the window, pruning the rest in place. */
function recentFailures(username: string, now: number): number[] {
  const cutoff = now - USERNAME_FAILURE_WINDOW_MS
  const kept = (failuresByUsername.get(username) ?? []).filter(at => at > cutoff)
  if (kept.length === 0) failuresByUsername.delete(username)
  else failuresByUsername.set(username, kept)
  return kept
}

function isUsernameThrottled(username: string): boolean {
  return recentFailures(username, Date.now()).length >= USERNAME_FAILURE_LIMIT
}

function recordUsernameFailure(username: string): void {
  const now = Date.now()
  const kept = recentFailures(username, now)
  // At the limit the window is frozen: if blocked attempts kept extending it,
  // an attacker could keep a real user locked out forever by guessing on.
  if (kept.length >= USERNAME_FAILURE_LIMIT) return
  kept.push(now)
  failuresByUsername.set(username, kept)

  // Guessers cycling usernames only ever touch their own entries, so sweep
  // the whole map when it grows past what a real user base could produce.
  if (failuresByUsername.size > USERNAME_TRACKING_CAP) {
    for (const name of [...failuresByUsername.keys()]) recentFailures(name, now)
  }
}

/** Router factory — tests inject a fresh (or pass-through) login limiter so
 *  the 10/hour brute-force gate doesn't leak state across test cases. */
/**
 * SameSite for the session cookie. Cross-site deployments (the API on a
 * railway.app address, the site on blacklandownership.com) need `None`,
 * which iOS Safari refuses outright as a third-party cookie; once the API
 * answers on a subdomain of the site (api.blacklandownership.com) the two are
 * same-site and `Lax` works everywhere. `SESSION_COOKIE_SAMESITE=lax|none`
 * chooses; the default keeps today's behaviour.
 */
export function sessionSameSite(prod: boolean): 'lax' | 'none' {
  const raw = (process.env.SESSION_COOKIE_SAMESITE || '').trim().toLowerCase()
  if (raw === 'lax' || raw === 'none') return raw
  return prod ? 'none' : 'lax'
}

export function createInternalAuthRouter(
  loginRateLimit: RequestHandler = makeInternalLoginRateLimit(),
): Router {
  const router = Router()

  router.post('/api/login', loginRateLimit, async (req, res, next) => {
    try {
      // Login-CSRF control: a cross-site page must not be able to silently
      // log the victim's browser into an ATTACKER's account (every later
      // action then lands in the attacker's audit trail and library). This
      // must live here and not rely on CORS alone — CORS rejects the
      // *response*, but a simple form/no-preflight POST still reaches the
      // handler and would still set the cookie. Absent Origin (curl,
      // server-to-server) is allowed; a present-but-disallowed one is not.
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0 && !isAllowedOrigin(origin, req)) {
        // No audit row: a cross-site attacker can trigger this endlessly, and
        // an attacker-controlled firehose into the audit table is its own
        // problem. The generic 401 leaks nothing about why.
        unauthorized(res)
        return
      }

      const { username, password } = req.body ?? {}
      if (
        typeof username !== 'string' ||
        typeof password !== 'string' ||
        username.length === 0 ||
        username.length > 64 ||
        password.length === 0 ||
        password.length > 256
      ) {
        unauthorized(res)
        return
      }
      if (!isLibraryEnabled()) {
        res.status(503).json({ error: 'unavailable' })
        return
      }

      // Checked before the DB lookup and the (deliberately expensive) argon2
      // verify, so a throttled username costs an attacker everything and us
      // nothing. Same bare 401 as any other failure — a guesser must not be
      // able to tell "locked out" from "wrong password", which would confirm
      // the account exists. The 20 login.failure rows already in the audit
      // log are the record of the lockout.
      if (isUsernameThrottled(username)) {
        unauthorized(res)
        return
      }

      const result = await libraryQuery(
        `SELECT id, username, password_hash, role, disabled FROM library_users WHERE username = $1`,
        [username],
      )
      const user = result.rows[0]
      if (!user) {
        // Burn comparable time to a real verify; never log the password.
        await verifyPassword(await dummyHash(), password)
        recordUsernameFailure(username)
        writeAudit({
          actor: username,
          action: 'login.failure',
          detail: { reason: 'unknown-user', ...auditContext(req) },
        })
        unauthorized(res)
        return
      }

      const passwordOk = await verifyPassword(user.password_hash, password)
      if (!passwordOk || user.disabled) {
        recordUsernameFailure(username)
        writeAudit({
          userId: Number(user.id),
          actor: username,
          action: 'login.failure',
          detail: { reason: passwordOk ? 'disabled' : 'bad-password', ...auditContext(req) },
        })
        unauthorized(res)
        return
      }

      // Proven ownership of the account clears its lockout — otherwise a
      // guessing campaign against a name would deny its real owner service.
      failuresByUsername.delete(username)

      // A live cookie on a fresh login is the old session being replaced (a
      // re-login after switching accounts, or on a shared machine). Revoke it
      // rather than leaving a second usable session behind the user's back.
      // Only on success: a failed login must not log anyone out.
      const previousToken = req.cookies?.[SESSION_COOKIE]
      if (typeof previousToken === 'string' && previousToken.length > 0) {
        await revokeSession(previousToken)
      }

      const { token, expiresAt } = await createSession(Number(user.id))
      writeAudit({
        userId: Number(user.id),
        actor: username,
        action: 'login.success',
        detail: auditContext(req),
      })
      res.cookie(SESSION_COOKIE, token, cookieOptions(req, expiresAt))
      // The session token travels only in the httpOnly cookie; the body
      // carries the derived CSRF token for the X-CSRF-Token header.
      res.json({ username: user.username, role: user.role, csrfToken: csrfTokenFor(token) })
    } catch (err) {
      next(err)
    }
  })

  // POST → requireInternalUser also enforces the CSRF header here.
  router.post('/api/logout', requireInternalUser, async (req, res, next) => {
    try {
      const user = res.locals.internalUser as InternalUser
      const token = (req as typeof req & { cookies: Record<string, string> }).cookies[SESSION_COOKIE]
      await revokeSession(token)
      writeAudit({ userId: user.id, actor: user.username, action: 'logout' })
      res.clearCookie(SESSION_COOKIE, cookieOptions(req))
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  })

  // Also returns the CSRF token: after a hard refresh the client still has
  // the httpOnly session cookie but no CSRF token (it only ever travels in
  // response bodies), and without it logout/mutations would be impossible.
  // Safe cross-site: attackers can trigger this request but CORS blocks
  // them from reading the response body.
  router.get('/api/me', requireInternalUser, (req, res) => {
    const user = res.locals.internalUser as InternalUser
    const token = (req as typeof req & { cookies: Record<string, string> }).cookies[SESSION_COOKIE]
    res.json({ username: user.username, role: user.role, csrfToken: csrfTokenFor(token) })
  })

  return router
}

export default createInternalAuthRouter()
