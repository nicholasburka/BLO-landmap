import { Router } from 'express'
import { createToken } from '../middleware/auth.js'
import { authRateLimit } from '../middleware/rateLimit.js'

const router = Router()

/** Constant-time string compare so the choice between BETA_PASSWORD
 *  and STAGING_PASSWORD doesn't leak via timing. Cheap and explicit. */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

router.post('/api/auth', authRateLimit, (req, res) => {
  const { password } = req.body
  if (typeof password !== 'string' || password.length === 0) {
    res.status(401).json({ error: 'Invalid password' })
    return
  }

  const betaPw = process.env.BETA_PASSWORD || ''
  const stagingPw = process.env.STAGING_PASSWORD || ''

  // Staging tier first — if both passwords are configured AND happen to
  // be identical (misconfig), staging wins; better to grant the broader
  // capability than silently downgrade a PM tester.
  if (stagingPw && timingSafeEq(password, stagingPw)) {
    const token = createToken('staging')
    res.json({ token, tier: 'staging' })
    return
  }
  if (betaPw && timingSafeEq(password, betaPw)) {
    const token = createToken('normal')
    res.json({ token, tier: 'normal' })
    return
  }

  res.status(401).json({ error: 'Invalid password' })
})

export default router
