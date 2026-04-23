import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import authRouter from './routes/auth.js'
import queryRouter from './routes/query.js'
import chatRouter from './routes/chat.js'
import { authMiddleware } from './middleware/auth.js'
import { queryRateLimit } from './middleware/rateLimit.js'
import { requestLogger } from './middleware/requestLogger.js'

const app = express()
const port = process.env.PORT || 3001

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
  res.json({ status: 'ok' })
})

// Auth route (no auth middleware)
app.use(authRouter)

// Query + chat routes (auth + rate limiting)
app.use(authMiddleware, queryRateLimit, queryRouter)
app.use(authMiddleware, queryRateLimit, chatRouter)

app.listen(port, () => {
  console.log(`BLO API server listening on port ${port}`)
})

export default app
