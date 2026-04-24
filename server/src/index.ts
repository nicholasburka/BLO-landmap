import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import authRouter from './routes/auth.js'
import sessionRouter from './routes/session.js'
import queryRouter from './routes/query.js'
import chatRouter from './routes/chat.js'
import { authMiddleware } from './middleware/auth.js'
import { queryRateLimit } from './middleware/rateLimit.js'
import { requestLogger } from './middleware/requestLogger.js'
import { dailyBudgetMiddleware, getUsageSnapshot } from './middleware/budget.js'

const app = express()
const port = process.env.PORT || 3001

// Honor X-Forwarded-For from Railway / proxies so req.ip is the real client.
// Without this, all per-IP rate-limit + budget checks collapse onto the
// proxy's IP. "true" = trust the immediate upstream hop.
app.set('trust proxy', 1)

// CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error('Not allowed by CORS'))
  },
}))

// Body parsing
app.use(express.json())

// Request logging
app.use(requestLogger)

// Health check (no auth)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', usage: getUsageSnapshot() })
})

// Session mint + legacy password auth (no auth middleware on these)
app.use(sessionRouter)
app.use(authRouter)

// Query + chat routes (auth + rate limiting + daily budget)
app.use(authMiddleware, queryRateLimit, dailyBudgetMiddleware, queryRouter)
app.use(authMiddleware, queryRateLimit, dailyBudgetMiddleware, chatRouter)

app.listen(port, () => {
  console.log(`BLO API server listening on port ${port}`)
})

export default app
