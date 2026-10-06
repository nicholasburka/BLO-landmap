import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { privateNoCache } from '../middleware/privateCache.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { activityLimit, recentEdits, RECENT_EDITS_LIMIT_DEFAULT } from '../services/libraryActivity.js'

/**
 * "Recently edited" (P6-5), the first block of the knowledge-base landing.
 *
 * The landing asks the catalog what EXISTS; this answers who last changed
 * what, which the catalog cannot say — `updated_at` is the newest bucket
 * object, with no name on it. The audit log has the name, so the list comes
 * from there, through the edit-action allowlist in services/libraryActivity.
 *
 * Internal-tier, like every other /api/library route: the guard runs before
 * the handler, so an anonymous request gets the same bare 401. Every member
 * sees the same list — "the last few by anyone" is the spec's own wording,
 * and the rows are titles of entries every member can already open.
 */
const router = Router()
router.use('/api/library', requireInternalUser)

router.get('/api/library/recent-edits', privateNoCache, async (req, res) => {
  if (!isLibraryEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  // The same clamp the feed uses: a junk or out-of-range `limit` is a shorter
  // list, never an error page on the front door.
  const limit = activityLimit(req.query.limit === undefined ? RECENT_EDITS_LIMIT_DEFAULT : req.query.limit)
  try {
    res.json({ limit, rows: await recentEdits(limit) })
  } catch (err: any) {
    console.error('[kb] recent edits read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
