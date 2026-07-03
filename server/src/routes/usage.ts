import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { getUsageSnapshot } from '../middleware/budget.js'
import {
  getDailyAggregates,
  getThemeCounts,
  getRecent,
  persistenceMode,
} from '../services/usageStore.js'
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from './dashboardAssets.js'

const router = Router()

/** Usage data is operator-only: a valid staging-tier token is required, the
 *  same gate as /api/health/usage. */
function requireStaging(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.authTier !== 'staging') {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  next()
}

function clampDays(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return 14
  return Math.max(1, Math.min(90, n))
}

router.get('/api/usage', authMiddleware, requireStaging, async (req, res) => {
  const days = clampDays(req.query.days)
  try {
    const [daily, themes, recent] = await Promise.all([
      getDailyAggregates(days),
      getThemeCounts(days),
      getRecent(50),
    ])
    res.json({
      generatedAt: new Date().toISOString(),
      windowDays: days,
      persistence: persistenceMode(),
      today: getUsageSnapshot(),
      daily,
      themes,
      recent,
    })
  } catch (err: any) {
    console.error('[usage] query failed:', err?.message || err)
    res.status(500).json({ error: 'Failed to load usage data' })
  }
})

// Dashboard is served as same-origin HTML/CSS/JS so it complies with the
// strict helmet CSP (script-src 'self'); the page itself prompts for the
// staging password and calls the gated /api/usage above.
router.get('/dashboard', (_req, res) => {
  res.type('html').send(DASHBOARD_HTML)
})
router.get('/dashboard.css', (_req, res) => {
  res.type('css').send(DASHBOARD_CSS)
})
router.get('/dashboard.js', (_req, res) => {
  res.type('js').send(DASHBOARD_JS)
})

export default router
