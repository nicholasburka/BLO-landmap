import { createHmac } from 'crypto'
import type { Request, Response, NextFunction } from 'express'

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000 // 24 hours

function getSecret(): string {
  return `blo-session-${process.env.BETA_PASSWORD || 'default'}`
}

/** Create a signed session token encoding the current timestamp */
export function createToken(): string {
  const timestamp = Date.now().toString()
  const hmac = createHmac('sha256', getSecret()).update(timestamp).digest('hex')
  const payload = Buffer.from(timestamp).toString('base64')
  return `${payload}.${hmac}`
}

/** Validate a session token: check signature and expiry */
export function validateToken(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 2) return false

  const [payload, signature] = parts
  let timestamp: number

  try {
    timestamp = parseInt(Buffer.from(payload, 'base64').toString(), 10)
    if (isNaN(timestamp)) return false
  } catch {
    return false
  }

  // Check expiry
  if (Date.now() - timestamp > TOKEN_EXPIRY_MS) return false

  // Check signature
  const expectedHmac = createHmac('sha256', getSecret()).update(timestamp.toString()).digest('hex')
  return signature === expectedHmac
}

/** Express middleware: require valid auth token */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  const token = authHeader.slice(7)
  if (!validateToken(token)) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  next()
}
