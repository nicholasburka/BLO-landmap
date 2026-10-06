import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { privateNoCache } from '../middleware/privateCache.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { getKbConfig } from '../services/kbConfig.js'
import { activityLimit, recentActivity } from '../services/libraryActivity.js'

/**
 * Operations home API (P5-40): what the /kb landing features (kb.json,
 * resolved) and what has happened lately (the audit log, allowlisted).
 * Internal-tier throughout — the guard runs before either handler, so an
 * anonymous request gets the same bare 401 as every other /api/library route.
 */
const router = Router()
router.use('/api/library', requireInternalUser)

router.get('/api/library/kb', privateNoCache, async (_req, res) => {
  if (!isLibraryEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    res.json(await getKbConfig())
  } catch (err: any) {
    console.error('[kb] config read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/api/library/activity', async (req, res) => {
  if (!isLibraryEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const limit = activityLimit(req.query.limit)
  try {
    res.json({ limit, rows: await recentActivity(limit) })
  } catch (err: any) {
    console.error('[kb] activity read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
