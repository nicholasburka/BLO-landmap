import { Router } from 'express'
import type Anthropic from '@anthropic-ai/sdk'
import { chatHaiku, type ClientChatContext } from '../services/haiku.js'
import { settleReservation } from '../middleware/budget.js'
import { recordUsage, hashIp } from '../services/usageStore.js'
import { themesFromMessages } from '../prompt/themes.js'

const router = Router()

/** Ceiling on the serialized history sent to the model. ~12k tokens at
 *  4 chars/token — comfortably under the per-IP daily cap so a single
 *  request can never exhaust a whole day's allowance. */
const MAX_HISTORY_CHARS = 48_000

/** Only roles a client is allowed to submit. Anything else (or a
 *  role field of the wrong type) is rejected outright. */
const ALLOWED_ROLES = new Set(['user', 'assistant'])

/** Content blocks the client legitimately produces: plain text, and the
 *  tool_use/tool_result pairs from the map-tool loop. */
const ALLOWED_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result'])

export function validateMessages(messages: unknown): string | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages array is required and must be non-empty'
  }
  if (messages.length > 40) {
    return 'Conversation too long. Please start a new chat.'
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') return 'Each message must be an object'
    const msg = m as { role?: unknown; content?: unknown }
    if (typeof msg.role !== 'string' || !ALLOWED_ROLES.has(msg.role)) {
      return 'Each message requires role "user" or "assistant"'
    }
    if (typeof msg.content === 'string') continue
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const type = (block as { type?: unknown })?.type
        if (typeof type !== 'string' || !ALLOWED_BLOCK_TYPES.has(type)) {
          return 'Unsupported message content block'
        }
      }
      continue
    }
    return 'Each message requires role and content'
  }
  let serializedLength: number
  try {
    serializedLength = JSON.stringify(messages).length
  } catch {
    return 'Messages are not serializable'
  }
  if (serializedLength > MAX_HISTORY_CHARS) {
    return 'Conversation too large. Please start a new chat.'
  }
  return null
}

/**
 * POST /api/chat
 *
 * Body: { messages, context? }
 *   - messages: Anthropic message history
 *   - context.activeFilters: threshold filters currently applied on the map
 *     (Phase 4b). Server includes them in the system prompt so the LLM
 *     knows not to clobber user-set filters unless asked.
 *
 * Server is stateless — no conversation storage.
 */
router.post('/api/chat', async (req, res) => {
  const { messages, context } = req.body as {
    messages?: Anthropic.Messages.MessageParam[]
    context?: ClientChatContext
  }

  const validationError = validateMessages(messages)
  if (validationError) {
    res.status(400).json({ error: validationError })
    return
  }

  const clientIp = (res.locals.clientIp as string) || 'unknown'
  const reserved = (res.locals.budgetReservation as number) || 0
  const tier = (res.locals.authTier as string) || 'normal'
  const themes = themesFromMessages(messages)
  const start = Date.now()
  try {
    const result = await chatHaiku(messages!, context)
    settleReservation(clientIp, reserved, result.usedTokens)
    recordUsage({
      ts: start,
      path: '/api/chat',
      status: 200,
      durationMs: Date.now() - start,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      tier,
      themes,
      ipHash: hashIp(clientIp),
    })
    res.json({
      message: result.message,
      stopReason: result.stopReason,
    })
  } catch (err: any) {
    settleReservation(clientIp, reserved, 0)
    recordUsage({
      ts: start,
      path: '/api/chat',
      status: 502,
      durationMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      tier,
      themes,
      ipHash: hashIp(clientIp),
    })
    console.error('Chat error:', err?.message || err)
    res.status(502).json({ error: 'Service temporarily unavailable' })
  }
})

export default router
