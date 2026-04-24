import { Router } from 'express'
import type Anthropic from '@anthropic-ai/sdk'
import { chatHaiku, type ClientChatContext } from '../services/haiku.js'

const router = Router()

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

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array is required and must be non-empty' })
    return
  }

  if (messages.length > 40) {
    res.status(400).json({ error: 'Conversation too long. Please start a new chat.' })
    return
  }

  // Basic shape validation
  for (const m of messages) {
    if (!m.role || !('content' in m)) {
      res.status(400).json({ error: 'Each message requires role and content' })
      return
    }
  }

  try {
    const clientIp = (res.locals.clientIp as string) || 'unknown'
    const result = await chatHaiku(messages, clientIp, context)
    res.json({
      message: result.message,
      stopReason: result.stopReason,
    })
  } catch (err: any) {
    console.error('Chat error:', err?.message || err)
    res.status(502).json({ error: 'Service temporarily unavailable' })
  }
})

export default router
