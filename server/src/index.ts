import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import authRouter from './routes/auth.js'
import sessionRouter from './routes/session.js'
import queryRouter from './routes/query.js'
import chatRouter from './routes/chat.js'
import { authMiddleware, requireAuthEnv } from './middleware/auth.js'
import { queryRateLimit } from './middleware/rateLimit.js'
import { requestLogger } from './middleware/requestLogger.js'
import { dailyBudgetMiddleware, getUsageSnapshot } from './middleware/budget.js'

// Refuse to boot without the secrets the security model depends on.
requireAuthEnv()
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is not set.')
  process.exit(1)
}

const app = express()
const port = process.env.PORT || 3001

// Honor X-Forwarded-For from Railway / proxies so req.ip is the real client.
// Without this, all per-IP rate-limit + budget checks collapse onto the
// proxy's IP. The hop count MUST match the real topology: 1 for a single
// proxy (Railway/Render direct), 2 if a CDN sits in front of that. Too
// high a value lets clients spoof X-Forwarded-For and dodge per-IP caps.
// Never use `true`. Override via TRUST_PROXY_HOPS when the topology changes.
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10)
app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1)

// Security headers. This is a JSON API — no cross-origin embedding needed.
app.use(helmet())

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
}))

// Body parsing. 64 KB comfortably fits the largest legitimate chat window
// (route-level MAX_HISTORY_CHARS is the tighter cost gate) while keeping
// megabyte-scale junk out of the JSON parser.
app.use(express.json({ limit: '64kb' }))

// Request logging
app.use(requestLogger)

// Health check (no auth). Deliberately bare — budget state, caps, and IP
// counts are operational intel and live behind auth below.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Usage snapshot for operators: requires a staging-tier token.
app.get('/api/health/usage', authMiddleware, (_req, res) => {
  if (res.locals.authTier !== 'staging') {
    res.status(403).json({ error: 'Forbidden' })
    return
  }
  res.json({ status: 'ok', usage: getUsageSnapshot() })
})

// Session mint + legacy password auth (rate-limited in their route files)
app.use(sessionRouter)
app.use(authRouter)

// Query + chat routes (auth + rate limiting + daily budget)
app.use(authMiddleware, queryRateLimit, dailyBudgetMiddleware, queryRouter)
app.use(authMiddleware, queryRateLimit, dailyBudgetMiddleware, chatRouter)

// Terminal error handler: malformed JSON, CORS rejections, anything thrown.
// Express's default handler would leak stack traces when NODE_ENV isn't
// "production"; this one never does.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.message === 'Not allowed by CORS') {
    res.status(403).json({ error: 'Origin not allowed' })
    return
  }
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 600 ? err.status : 500
  if (status >= 500) console.error('Unhandled error:', err?.message || err)
  res.status(status).json({ error: status < 500 ? 'Bad request' : 'Internal server error' })
})

app.listen(port, () => {
  console.log(`BLO API server listening on port ${port}`)
})

export default app
