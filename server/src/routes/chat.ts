import { Router } from 'express'
import type Anthropic from '@anthropic-ai/sdk'
import { chatHaiku } from '../services/haiku.js'

const router = Router()

/**
 * POST /api/chat
 *
 * Body: { messages: Anthropic message history }
 *
 * The client sends the full conversation history (capped at last ~20 messages
 * by the client). Server forwards to Claude with tool definitions. If Claude
 * calls tools, the response contains tool_use blocks for the client to execute;
 * the client then sends the next request with tool_result blocks appended.
 *
 * Server is stateless — no conversation storage.
 */
router.post('/api/chat', async (req, res) => {
  const { messages } = req.body as { messages?: Anthropic.Messages.MessageParam[] }

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
    const result = await chatHaiku(messages)
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
