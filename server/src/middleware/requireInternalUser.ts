import type { Request, Response, NextFunction } from 'express'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { SESSION_COOKIE, csrfHeaderMatches, getSessionUser } from '../services/internalSessions.js'

/**
 * Guards for internal (per-user) routes. Requires cookie-parser to be
 * mounted upstream (index.ts does this app-wide).
 *
 * Rejections are deliberately bare — a probing client learns nothing about
 * whether a session existed, expired, was revoked, or the user was disabled
 * (spec Example 3). CSRF failures return 403 so a logged-in client can tell
 * "re-fetch your CSRF token" apart from "you are logged out".
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function deny(res: Response): void {
  res.status(401).json({ error: 'unauthorized' })
}

/** Attach the internal user when a valid session cookie is present, but
 *  never deny (P5-26): public routes such as chat/query use this to decide
 *  whether internal layers may appear in the prompt. */
export function attachInternalUser(req: Request, _res: Response, next: NextFunction): void {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE]
  if (!isLibraryEnabled() || typeof token !== 'string' || token.length === 0) {
    next()
    return
  }
  getSessionUser(token)
    .then(user => {
      if (user) _res.locals.internalUser = user
      next()
    })
    .catch(() => next())
}

/** Require a valid internal session. On success, res.locals.internalUser
 *  holds { id, username, role }. Mutating methods must also carry a
 *  matching X-CSRF-Token header. */
export function requireInternalUser(req: Request, res: Response, next: NextFunction): void {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE]
  if (!isLibraryEnabled() || typeof token !== 'string' || token.length === 0) {
    deny(res)
    return
  }
  getSessionUser(token)
    .then(user => {
      if (!user) {
        deny(res)
        return
      }
      if (MUTATING_METHODS.has(req.method) && !csrfHeaderMatches(token, req.headers['x-csrf-token'])) {
        res.status(403).json({ error: 'forbidden' })
        return
      }
      res.locals.internalUser = user
      next()
    })
    .catch(next)
}

/** Like requireInternalUser, but only for role 'admin'. Non-admins get the
 *  same bare 401 as the unauthenticated — admin routes shouldn't even
 *  confirm they exist to non-admin sessions. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  requireInternalUser(req, res, (err?: unknown) => {
    if (err) {
      next(err)
      return
    }
    if (res.locals.internalUser?.role !== 'admin') {
      deny(res)
      return
    }
    next()
  })
}
