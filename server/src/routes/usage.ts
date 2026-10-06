import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { getUsageSnapshot } from '../middleware/budget.js'
import {
  getDailyAggregates,
  getThemeCounts,
  getRecent,
  persistenceMode,
} from '../services/usageStore.js'
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from './dashboardAssets.js'

const router = Router()

function clampDays(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n)) return 14
  return Math.max(1, Math.min(90, n))
}

// Usage data is internal-tier (P5-20): a logged-in internal user's session
// cookie is required — the staging password's deploy-gating role no longer
// opens operational data.
router.get('/api/usage', requireInternalUser, async (req, res) => {
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
// strict helmet CSP (script-src 'self'). The page shell is public (it holds
// no data); its JS logs in with an internal account via /api/login and
// calls the cookie-gated /api/usage above.
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
