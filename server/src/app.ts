import express from 'express'
import compression from 'compression'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import authRouter from './routes/auth.js'
import sessionRouter from './routes/session.js'
import queryRouter from './routes/query.js'
import chatRouter from './routes/chat.js'
import usageRouter from './routes/usage.js'
import internalAuthRouter from './routes/internalAuth.js'
import accountRouter from './routes/account.js'
import libraryCatalogRouter from './routes/libraryCatalog.js'
import libraryUploadRouter from './routes/libraryUpload.js'
import libraryBulkRouter from './routes/libraryBulk.js'
import libraryDataRouter from './routes/libraryData.js'
import layersRouter from './routes/layers.js'
import libraryFileRouter from './routes/libraryFile.js'
import libraryTextRouter from './routes/libraryText.js'
import librarySearchTextRouter from './routes/librarySearchText.js'
import libraryLinksRouter from './routes/libraryLinks.js'
import libraryIngestRouter from './routes/libraryIngest.js'
import librarySourcesRouter from './routes/librarySources.js'
import libraryPlaceRouter from './routes/libraryPlace.js'
import libraryAskRouter from './routes/libraryAsk.js'
import libraryChatRouter from './routes/libraryChat.js'
import kbRouter from './routes/kb.js'
import libraryActivityRouter from './routes/libraryActivity.js'
import wikiRouter from './routes/wiki.js'
import viewsRouter from './routes/views.js'
import workingSetsRouter from './routes/workingSets.js'
import apiTokensRouter from './routes/apiTokens.js'
import mcpRouter from './routes/mcp.js'
import oauthRouter from './routes/oauth.js'
import { authMiddleware } from './middleware/auth.js'
import { isAllowedOrigin } from './middleware/origins.js'
import { requireInternalUser, attachInternalUser } from './middleware/requireInternalUser.js'
import { queryRateLimit } from './middleware/rateLimit.js'
import { requestLogger } from './middleware/requestLogger.js'
import { dailyBudgetMiddleware, getUsageSnapshot } from './middleware/budget.js'

/**
 * Build the Express app — everything except env validation and boot
 * (dotenv, store init, listen), which live in index.ts. Split out so the
 * auth-sweep test (P5-5) can walk the REAL production router table
 * instead of a hand-maintained route list.
 */
export function createApp(): express.Express {
  const app = express()

  // Honor X-Forwarded-For from Railway / proxies so req.ip is the real client.
  // Without this, all per-IP rate-limit + budget checks collapse onto the
  // proxy's IP. The hop count MUST match the real topology: 1 for a single
  // proxy (Railway/Render direct), 2 if a CDN sits in front of that. Too
  // high a value lets clients spoof X-Forwarded-For and dodge per-IP caps.
  // Never use `true`. Override via TRUST_PROXY_HOPS when the topology changes.
  const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS || '1', 10)
  app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1)

  // Weak ETags on every JSON answer (P5-88). This IS Express's default, and
  // it is set out loud here because the conditional-request behaviour of four
  // routes now depends on it: `res.json` hashes the body, the browser echoes
  // it back in `If-None-Match`, and an unchanged answer costs a 304 with no
  // body instead of 214 KB of catalog.
  app.set('etag', 'weak')

  // Security headers. This is a JSON API — no cross-origin embedding needed.
  app.use(helmet())

  // Gzip, JSON only (P5-88). The catalog list is 214 KB raw and 50 KB
  // gzipped, and every list answer on the internal side is the same shape of
  // repetitive JSON.
  //
  // JSON only, deliberately: `compression`'s default filter also takes
  // `text/*`, which would wrap the file-download stream (routes/libraryFile),
  // the CSV export written chunk by chunk (routes/libraryData) and anything
  // that ever streams `text/event-stream`. Those are either already
  // compressed, or want their bytes to leave as they are written. The JSON
  // responses are the ones that are big, repetitive, and buffered whole.
  //
  // Threshold: 1 KB — below that the gzip header and the CPU cost buy
  // nothing. `x-no-compression` still opts a caller out, via the default filter.
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        const type = res.getHeader('Content-Type')
        if (!/^application\/json\b/i.test(Array.isArray(type) ? type.join(',') : String(type ?? ''))) return false
        return compression.filter(req, res)
      },
    }),
  )

  // CORS. Allow: requests with no Origin (curl, server-to-server), configured
  // frontend origins, and same-origin requests (the /dashboard page calling
  // /api/* on this same host — its origin is never in ALLOWED_ORIGINS).
  // The allowlist decision itself lives in middleware/origins.ts because the
  // login route applies the same rule as its own CSRF gate.
  const corsDelegate: cors.CorsOptionsDelegate<express.Request> = (req, callback) => {
    const origin = req.headers.origin
    if (!origin) return callback(null, { origin: true })
    // credentials: true lets the browser attach the internal-session cookie on
    // cross-origin fetches (Netlify frontend → this host). Harmless for the
    // Bearer-token flows, which never relied on cookies.
    if (isAllowedOrigin(origin, req)) return callback(null, { origin: true, credentials: true })
    callback(new Error('Not allowed by CORS'))
  }
  app.use(cors(corsDelegate))

  // Body parsing. 64 KB comfortably fits the largest legitimate chat window
  // (route-level MAX_HISTORY_CHARS is the tighter cost gate) while keeping
  // megabyte-scale junk out of the JSON parser.
  app.use(express.json({ limit: '64kb' }))

  // Cookie parsing — only the internal (per-user) session path reads cookies;
  // the anonymous map flows stay header-token based.
  app.use(cookieParser())

  // Request logging
  app.use(requestLogger)

  // Health check (no auth). Deliberately bare — budget state, caps, and IP
  // counts are operational intel and live behind auth below.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  // Usage snapshot for operators: internal-tier (P5-20) — requires a
  // logged-in internal user's session cookie, same gate as /api/usage.
  app.get('/api/health/usage', requireInternalUser, (_req, res) => {
    res.json({ status: 'ok', usage: getUsageSnapshot() })
  })

  // Session mint + legacy password auth (rate-limited in their route files)
  app.use(sessionRouter)
  app.use(authRouter)

  // Internal per-user login/logout/me (phase 5; rate-limited in its route file)
  app.use(internalAuthRouter)

  // Change your own password (P5-76) — session + CSRF, and its own tight
  // per-user cap on top of the shared internal limiter.
  app.use(accountRouter)

  // Placeholder guarded route proving the internal-session middleware
  // end-to-end; kept as the auth-sweep's canary path.
  app.get('/api/library/ping', requireInternalUser, (_req, res) => {
    res.json({ status: 'ok' })
  })

  // Library catalog index + reindex (P5-8) — internal-tier throughout.
  app.use(libraryCatalogRouter)

  // Library upload → incoming/ (P5-10) — streaming multipart, internal-tier.
  app.use(libraryUploadRouter)

  // Many documents at once (P6-8) — the same streaming multipart write as a
  // single upload, plus the queued annotation pass and its status route.
  app.use(libraryBulkRouter)

  // Dataset explorer: schema + paged rows for tabular files (P5-31), internal-tier.
  app.use(libraryDataRouter)

  // Internal map layers: manifest + county values (P5-18), internal-tier.
  app.use(layersRouter)

  // Library file downloads (P5-25) — streamed from the mirror, internal-tier.
  app.use(libraryFileRouter)

  // Extracted document text (P5-46) — the viewer's text view, internal-tier.
  app.use(libraryTextRouter)

  // "Inside documents" (P6-6): BM25 over the Ask index's page chunks, so
  // /search can say which page of which document says the thing. Internal-tier.
  app.use(librarySearchTextRouter)

  // Link drops into the incoming queue (P5-34), internal-tier.
  app.use(libraryLinksRouter)

  // Link inspection, the ingest plan and "Replicate now" (P5-59). Inspection
  // is internal-tier; the plan and the copy are admin-only, gated inside the
  // route file so the guard sits next to the handler it protects.
  app.use(libraryIngestRouter)

  // Fetch a source for a place (P5-57) — internal-tier; the route file mounts
  // its own limiter on the two paths that reach an outside agency.
  app.use(librarySourcesRouter)

  // The place report (P5-58) — every applicable source for one place, the
  // county's numbers and a cited summary; internal-tier, with its own limiter
  // on the POST that reaches the agencies.
  app.use(libraryPlaceRouter)

  // Operations home (P5-40): kb.json config + the activity feed, internal-tier.
  app.use(kbRouter)

  // P6-5: "recently edited" on the landing — the audit log's edit actions,
  // one row per entry, internal-tier like the feed it reads beside.
  app.use(libraryActivityRouter)

  // Ask the knowledge base (P5-41) — internal-tier; the route file mounts its
  // own limiter + daily budget, since it is the only library route that spends
  // Anthropic tokens.
  app.use(libraryAskRouter)

  // Chat (P6-7): threads with the library's own tool set, internal-tier. The
  // message route carries the daily budget (it is the only one that spends
  // model tokens) and streams its answer as newline-delimited JSON.
  app.use(libraryChatRouter)

  // Wiki pages (P5-14) — flat markdown files in the bucket, internal-tier.
  app.use(wikiRouter)

  // Saved data views (P5-16) — flat JSON snapshots, internal-tier.
  app.use(viewsRouter)
  // P7-1: working sets — the compound data object a saved view presents.
  app.use(workingSetsRouter)

  // Personal API tokens (P5-50) — minted from the account page with the
  // cookie session; a token can never mint another token.
  app.use(apiTokensRouter)

  // OAuth 2.1 for remote MCP clients (P5-51) — metadata, dynamic client
  // registration, the consent screen, token and revocation. Mounted BEFORE
  // the MCP router only for readability; the paths do not overlap. Its public
  // endpoints carry their own IP limiters, and the account-page grant routes
  // inside it are cookie + CSRF gated like every other /api/library route.
  app.use(oauthRouter)

  // MCP server (P5-50) — bearer-token read tools for assistants. Its own
  // router carries the token guard and the per-user limiter.
  app.use(mcpRouter)

  // Internal usage dashboard + /api/usage (data is internal-session gated;
  // the page's same-origin assets are public and hold no data).
  app.use(usageRouter)

  // Query + chat routes (auth + rate limiting + daily budget)
  // P5-26: attachInternalUser never denies — it only lets the prompt include
  // internal layers when a valid session cookie rides along.
  app.use(authMiddleware, queryRateLimit, dailyBudgetMiddleware, attachInternalUser, queryRouter)
  app.use(authMiddleware, queryRateLimit, dailyBudgetMiddleware, attachInternalUser, chatRouter)

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

  return app
}
