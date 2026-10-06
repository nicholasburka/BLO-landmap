import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { privateNoCache } from '../middleware/privateCache.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { listInternalLayers, readInternalLayerValues } from '../services/internalLayers.js'
import { TabularError } from '../services/libraryTabular.js'

/**
 * Internal map layers (P5-18): manifest + per-layer county values.
 * Internal-tier throughout — the guard runs before any handler, so the
 * public map never learns that these routes, or any layer, exist.
 */
const router = Router()
router.use('/api/layers', requireInternalUser)

function unavailable(res: import('express').Response): boolean {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return true
  }
  return false
}

function fail(res: import('express').Response, err: unknown, what: string): void {
  if (err instanceof TabularError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(`[layers] ${what} failed:`, (err as any)?.message || err)
  res.status(500).json({ error: 'Internal server error' })
}

router.get('/api/layers/internal', privateNoCache, async (_req, res) => {
  if (unavailable(res)) return
  try {
    res.json({ layers: await listInternalLayers() })
  } catch (err) {
    fail(res, err, 'manifest')
  }
})

router.get<{ slug: string }>('/api/layers/internal/:slug', internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  try {
    res.json(await readInternalLayerValues(req.params.slug))
  } catch (err) {
    fail(res, err, 'values')
  }
})

export default router
