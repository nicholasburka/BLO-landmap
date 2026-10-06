import { Router, type Request } from 'express'
import rateLimit, { MemoryStore } from 'express-rate-limit'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, libraryQuery, writeAudit } from '../services/libraryDb.js'
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
} from '../services/passwords.js'
import { SESSION_COOKIE, revokeOtherSessions } from '../services/internalSessions.js'

/**
 * Your own account (P5-76): change your password.
 *
 * Until now the admin CLI was the only way a password could change, so
 * "I want a new one" meant asking an admin. This is the same operation,
 * self-service, behind the session the user already holds — cookie + CSRF
 * like every internal write, and the identical hash the login verifies.
 *
 * Changing the password ends every OTHER session (the current one stays, so
 * the user is not logged out of the page they just used). That is the point
 * of the feature as much as the new password is: the reason to change one is
 * usually that somebody else may be holding the old one.
 */

/**
 * Per-user cap for this endpoint alone: 5/hour.
 *
 * internalRateLimit's 120/min is the ceiling for ordinary library work and is
 * far too generous here — this route confirms a password on request, so a
 * borrowed laptop with a live session is a free oracle to guess against. Five
 * an hour is more than anyone legitimately needs (a password change is a
 * once-a-year act) and turns guessing into a multi-year exercise.
 *
 * Counting every request, not just failures, is deliberate: a limiter that
 * skips successes lets the correct-guess case through unmetered.
 */
export const PASSWORD_CHANGE_LIMIT = 5
const passwordChangeStore = new MemoryStore()
const passwordChangeRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: PASSWORD_CHANGE_LIMIT,
  store: passwordChangeStore,
  standardHeaders: true,
  legacyHeaders: false,
  // Runs after requireInternalUser, so the account is always available; the
  // address is a fallback that should never be reached.
  keyGenerator: (req, res) => {
    const user = res.locals.internalUser as { id: number } | undefined
    return user ? `user:${user.id}` : `ip:${req.ip ?? 'unknown'}`
  },
  message: { error: 'Too many attempts. Please try again later.' },
})

/** Drop the bucket. For tests, which share one process and one store. */
export async function resetPasswordChangeRateLimit(): Promise<void> {
  await passwordChangeStore.resetAll()
}

/** The copy the account page shows verbatim — one plain sentence per case,
 *  the same shape as the login form's "Invalid credentials". */
const WRONG_CURRENT = 'That is not your current password.'
const TOO_SHORT = `Use at least ${MIN_PASSWORD_LENGTH} characters.`
const TOO_LONG = `Use at most ${MAX_PASSWORD_LENGTH} characters.`
const SAME_AS_CURRENT = 'Your new password must be different from your current one.'

const router = Router()

router.post(
  '/api/account/password',
  requireInternalUser,
  internalRateLimit,
  passwordChangeRateLimit,
  async (req: Request, res) => {
    if (!isLibraryEnabled()) {
      res.status(503).json({ error: 'library unavailable' })
      return
    }
    const user = res.locals.internalUser as { id: number; username: string }
    try {
      const { current, next } = (req.body ?? {}) as Record<string, unknown>
      if (typeof current !== 'string' || typeof next !== 'string' || current.length === 0) {
        res.status(400).json({ error: WRONG_CURRENT })
        return
      }

      // Shape checks first: they are free, and they keep a junk request from
      // buying an argon2 verify. A password longer than the cap the login
      // route accepts could never have been used to log in anyway.
      if (next.length < MIN_PASSWORD_LENGTH) {
        res.status(400).json({ error: TOO_SHORT })
        return
      }
      if (next.length > MAX_PASSWORD_LENGTH) {
        res.status(400).json({ error: TOO_LONG })
        return
      }
      if (next === current) {
        res.status(400).json({ error: SAME_AS_CURRENT })
        return
      }

      const found = await libraryQuery(`SELECT password_hash FROM library_users WHERE id = $1`, [
        user.id,
      ])
      const row = found.rows[0]
      if (!row || !(await verifyPassword(row.password_hash, current))) {
        // Worth a row of its own: on an authenticated session this is either
        // a typo or somebody at a logged-in machine trying to take the
        // account over, and only the audit trail can tell those apart later.
        void writeAudit({
          userId: user.id,
          actor: user.username,
          action: 'account.password.failure',
          detail: { reason: 'bad-current' },
        })
        res.status(400).json({ error: WRONG_CURRENT })
        return
      }

      const hash = await hashPassword(next)
      await libraryQuery(`UPDATE library_users SET password_hash = $1 WHERE id = $2`, [hash, user.id])

      // requireInternalUser proved this cookie resolves to a live session, so
      // it is present and it is the one to keep.
      const token = (req as Request & { cookies: Record<string, string> }).cookies[SESSION_COOKIE]
      const signedOutOthers = await revokeOtherSessions(user.id, token)

      void writeAudit({
        userId: user.id,
        actor: user.username,
        action: 'account.password',
        detail: { signedOutOthers },
      })
      res.json({ ok: true, signedOutOthers })
    } catch (err: any) {
      console.error('[account] password change failed:', err?.message || err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

export default router
