import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import {
  createApiToken,
  DEFAULT_SCOPES,
  listApiTokens,
  revokeApiToken,
  validateTokenName,
  WRITE_SCOPES,
} from '../services/apiTokens.js'

/**
 * Personal API tokens (P5-50): mint / list / revoke, from the account page.
 *
 * Internal-tier, cookie-session only — a token can never mint another token.
 * That is deliberate: a leaked MCP token must not be able to bootstrap fresh
 * credentials, so the escalation path stops at what its own scopes allow
 * (P5-52: reading, and writing only if the person ticked "Allow writes").
 *
 * `token.create` / `token.revoke` are audited but are NOT in the activity
 * feed's verb allowlist (services/libraryActivity.ts), so account hygiene
 * never shows up as library work on the operations home.
 */
const router = Router()
router.use('/api/library/tokens', requireInternalUser, internalRateLimit)

function unavailable(res: import('express').Response): boolean {
  if (!isLibraryEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return true
  }
  return false
}

router.get('/api/library/tokens', async (_req, res) => {
  if (unavailable(res)) return
  try {
    const user = res.locals.internalUser
    res.json({ tokens: await listApiTokens(user.id) })
  } catch (err: any) {
    console.error('[tokens] list failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/api/library/tokens', async (req, res) => {
  if (unavailable(res)) return
  try {
    const parsed = validateTokenName((req.body ?? {}).name)
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error })
      return
    }
    // P5-52: "Allow writes" on the mint form. Absent or false keeps the
    // read-only token this endpoint has always minted — an existing caller
    // that never heard of the flag cannot accidentally get a writing token.
    const write = (req.body ?? {}).write === true
    const user = res.locals.internalUser
    const minted = await createApiToken(user.id, parsed.name, write ? WRITE_SCOPES : DEFAULT_SCOPES)
    void writeAudit({
      userId: user.id,
      actor: user.username,
      action: 'token.create',
      target: String(minted.id),
      // The name and scopes, never the secret or its hash — an audit row is
      // read by more people than the token itself ever should be.
      detail: { name: minted.name, scopes: minted.scopes },
    })
    res.status(201).json(minted)
  } catch (err: any) {
    console.error('[tokens] create failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/api/library/tokens/:id', async (req, res) => {
  if (unavailable(res)) return
  try {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const user = res.locals.internalUser
    const result = await revokeApiToken(id, user)
    if (!result.revoked) {
      // Someone else's token reads as missing to a non-admin (see the service)
      // so ids cannot be probed for existence.
      res.status(404).json({ error: 'not found' })
      return
    }
    void writeAudit({
      userId: user.id,
      actor: user.username,
      action: 'token.revoke',
      target: String(id),
      // ownerId matters when an admin revokes someone else's token — the
      // actor and the affected account are then different people.
      detail: { name: result.name, ownerId: result.ownerId },
    })
    res.json({ revoked: true })
  } catch (err: any) {
    console.error('[tokens] revoke failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
