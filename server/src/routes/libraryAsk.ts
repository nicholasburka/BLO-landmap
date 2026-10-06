import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { dailyBudgetMiddleware, settleReservation } from '../middleware/budget.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { recordUsage, hashIp } from '../services/usageStore.js'
import { askKb, AskModelError } from '../services/askKb.js'
import { failureOf } from '../services/assistantCall.js'

/**
 * POST /api/library/ask (P5-41) — a cited answer from the library, plus the
 * real dataset queries the model ran to get its numbers.
 *
 * Internal-tier only: this streams internal content into a model prompt and
 * back to a browser, so the session guard runs FIRST (bare 401 logged out,
 * 403 without a CSRF header on this POST), then the per-user limiter, then
 * the daily token budget with the same reserve/settle pattern as /api/chat.
 */
const router = Router()

/** What everybody is told when the model could not be reached. Admins get the
 *  `reason` code alongside it and a sharper sentence in the browser (P5-75);
 *  a member can only wait, so a member is only told to wait. */
export const MODEL_UNAVAILABLE =
  'The answering service is unavailable right now. Please try again in a minute.'

/** Long enough for a real research question, short enough that the prompt
 *  cost stays bounded and a pasted document is refused as what it is. */
export const QUESTION_MAX_CHARS = 500
const QUESTION_MIN_CHARS = 3
/** Characters of the question kept in the audit trail (spec: 200). */
export const AUDIT_QUESTION_CHARS = 200

export function validateAskBody(body: unknown): { question: string; dataset?: string } | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.question !== 'string') return { error: 'question is required' }
  const question = b.question.trim()
  if (question.length < QUESTION_MIN_CHARS) return { error: 'Ask a question — a few words at least.' }
  if (question.length > QUESTION_MAX_CHARS) {
    return { error: `That question is too long (${QUESTION_MAX_CHARS} characters max). Try asking one thing at a time.` }
  }
  if (b.dataset !== undefined && b.dataset !== null && b.dataset !== '') {
    if (typeof b.dataset !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(b.dataset)) {
      return { error: 'dataset must be a slug' }
    }
    return { question, dataset: b.dataset }
  }
  return { question }
}

router.post(
  '/api/library/ask',
  requireInternalUser,
  internalRateLimit,
  dailyBudgetMiddleware,
  async (req, res) => {
    const clientIp = (res.locals.clientIp as string) || 'unknown'
    const reserved = (res.locals.budgetReservation as number) || 0
    const user = res.locals.internalUser as { id: number; username: string; role?: string } | undefined

    if (!isLibraryEnabled() || !isBucketEnabled()) {
      settleReservation(clientIp, reserved, 0)
      res.status(503).json({ error: 'library unavailable' })
      return
    }

    const parsed = validateAskBody(req.body)
    if ('error' in parsed) {
      settleReservation(clientIp, reserved, 0)
      res.status(400).json({ error: parsed.error })
      return
    }

    const start = Date.now()
    try {
      const result = await askKb({ question: parsed.question, dataset: parsed.dataset })
      settleReservation(clientIp, reserved, result.usedTokens)
      recordUsage({
        ts: start,
        path: '/api/library/ask',
        status: 200,
        durationMs: Date.now() - start,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        tier: 'internal',
        themes: [],
        ipHash: hashIp(clientIp),
      })
      void writeAudit({
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        action: 'library.ask',
        detail: {
          questionLength: parsed.question.length,
          question: parsed.question.slice(0, AUDIT_QUESTION_CHARS),
          sources: result.sources.length,
          tools: result.toolCalls,
        },
      })
      res.json({
        answer: result.answer,
        sources: result.sources,
        queries: result.queries,
        read: result.counts,
      })
    } catch (err: unknown) {
      settleReservation(clientIp, reserved, 0)
      // A model that could not be called is 503 "come back in a minute"; a
      // failure in our own retrieval is still 502, because that one is a bug.
      const modelDown = err instanceof AskModelError
      recordUsage({
        ts: start,
        path: '/api/library/ask',
        status: modelDown ? 503 : 502,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        tier: 'internal',
        themes: [],
        ipHash: hashIp(clientIp),
      })
      if (modelDown) {
        const { reason, code } = failureOf(err.modelError)
        console.warn('[library] ask: the model is unavailable —', reason)
        res.status(503).json({
          error: MODEL_UNAVAILABLE,
          // Admins only: "the key was refused" is a billing job somebody can
          // go and do, and it is nobody else's business that we have a key.
          ...(user?.role === 'admin' ? { reason: code } : {}),
        })
        return
      }
      console.error('[library] ask failed:', (err as Error)?.message || err)
      res.status(502).json({ error: MODEL_UNAVAILABLE })
    }
  },
)

export default router
