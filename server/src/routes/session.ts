import { Router } from 'express'
import { createToken } from '../middleware/auth.js'

const router = Router()

/**
 * POST /api/session
 *
 * Anonymous session mint — no password required. Intentionally lightweight:
 * the endpoint exists so the browser can hold an HMAC-signed token, which lets
 * the rate-limit-per-IP + daily-budget middleware still function without
 * exposing the Anthropic key or a password prompt to users.
 *
 * The old /api/auth (password-gated) endpoint stays mounted for any clients
 * that still carry a previously-issued password-backed token.
 */
router.post('/api/session', (_req, res) => {
  const token = createToken()
  res.json({ token })
})

export default router
