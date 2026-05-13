import { createHmac } from 'crypto'
import type { Request, Response, NextFunction } from 'express'

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Auth tier baked into the signed token.
 *   - normal:   subject to the daily token cap.
 *   - staging:  exempt from the cap so PM testing on the staging
 *               site doesn't burn the prod quota. Granted only when
 *               the user authenticates with STAGING_PASSWORD. */
export type AuthTier = 'normal' | 'staging'

function getSecret(): string {
  return `blo-session-${process.env.BETA_PASSWORD || 'default'}`
}

/** Create a signed session token encoding timestamp + tier. The tier
 *  is part of the signed payload so a normal user can't self-promote
 *  to staging by tampering with their token. */
export function createToken(tier: AuthTier = 'normal'): string {
  const timestamp = Date.now().toString()
  const body = `${timestamp}.${tier}`
  const hmac = createHmac('sha256', getSecret()).update(body).digest('hex')
  const payload = Buffer.from(body).toString('base64')
  return `${payload}.${hmac}`
}

/** Decoded validation result. Includes the tier so downstream
 *  middleware (e.g. the budget gate) can branch on it. */
export interface TokenValidation {
  valid: boolean
  tier: AuthTier
}

/** Validate a session token: signature, expiry, and decode tier. */
export function validateToken(token: string): TokenValidation {
  const fail: TokenValidation = { valid: false, tier: 'normal' }
  const parts = token.split('.')
  if (parts.length !== 2) return fail

  const [payload, signature] = parts
  let body: string
  try {
    body = Buffer.from(payload, 'base64').toString()
  } catch {
    return fail
  }

  // Body is "timestamp.tier". Tokens issued before tier support had
  // just "timestamp" — accept those as normal-tier so an in-flight
  // session doesn't bounce across the rollout.
  const bodyParts = body.split('.')
  const timestamp = parseInt(bodyParts[0], 10)
  if (isNaN(timestamp)) return fail
  const tier: AuthTier = bodyParts[1] === 'staging' ? 'staging' : 'normal'

  if (Date.now() - timestamp > TOKEN_EXPIRY_MS) return fail

  // Recompute against the exact body sent — legacy tokens still verify
  // because their signed body is the bare timestamp string.
  const expectedHmac = createHmac('sha256', getSecret()).update(body).digest('hex')
  if (signature !== expectedHmac) return fail

  return { valid: true, tier }
}

/** Express middleware: require a valid auth token. Stashes the tier
 *  on res.locals so downstream middleware (notably the budget gate)
 *  can read it without re-parsing. */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const token = authHeader.slice(7)
  const result = validateToken(token)
  if (!result.valid) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  res.locals.authTier = result.tier
  next()
}
