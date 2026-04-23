import Anthropic from '@anthropic-ai/sdk'
import { buildSystemPrompt, VALID_LAYER_IDS } from '../prompt/systemPrompt.js'
import { buildChatPrompt } from '../prompt/chatPrompt.js'
import { TOOL_DEFINITIONS } from '../prompt/toolDefinitions.js'

export interface LayerSelection {
  layerId: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

export interface QueryResponse {
  layers: LayerSelection[]
  explanation: string
}

const client = new Anthropic()
const systemPrompt = buildSystemPrompt()
const chatSystemPrompt = buildChatPrompt()

const MODEL = 'claude-haiku-4-5-20251001'

export async function queryHaiku(userPrompt: string): Promise<QueryResponse> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })

  // Extract text content
  const textBlock = message.content.find(block => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    return { layers: [], explanation: 'Unable to process query.' }
  }

  // Parse JSON from response
  let parsed: QueryResponse
  try {
    parsed = JSON.parse(textBlock.text)
  } catch {
    // Try to extract JSON from markdown code blocks
    const jsonMatch = textBlock.text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[1])
      } catch {
        return { layers: [], explanation: 'Unable to parse response. Please try rephrasing your query.' }
      }
    } else {
      return { layers: [], explanation: 'Unable to parse response. Please try rephrasing your query.' }
    }
  }

  // Validate structure
  if (!parsed.layers || !Array.isArray(parsed.layers)) {
    return { layers: [], explanation: parsed.explanation || 'Invalid response format.' }
  }

  // Filter to valid layer IDs and clamp weights
  const validLayers = parsed.layers
    .filter(l => VALID_LAYER_IDS.has(l.layerId))
    .map(l => ({
      layerId: l.layerId,
      weight: Math.max(1, Math.min(10, Math.round(l.weight))),
      direction: l.direction === 'lower_better' ? 'lower_better' as const : 'higher_better' as const,
    }))

  return {
    layers: validLayers,
    explanation: parsed.explanation || 'Query processed.',
  }
}

// ============= Phase 3: Chat with tool use =============

export interface ChatResponse {
  /** The full assistant message (content blocks) — forwarded to client as-is */
  message: Anthropic.Messages.Message
  /** Whether Claude stopped to call tools (vs finished the turn) */
  stopReason: Anthropic.Messages.Message['stop_reason']
}

/**
 * Send a multi-turn conversation to Haiku with tool use enabled.
 * The caller passes in message history (user messages + assistant messages with
 * tool_use blocks + user messages with tool_result blocks) and this function
 * returns the next assistant message.
 */
export async function chatHaiku(
  messages: Anthropic.Messages.MessageParam[]
): Promise<ChatResponse> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: chatSystemPrompt,
    tools: TOOL_DEFINITIONS,
    messages,
  })

  return {
    message,
    stopReason: message.stop_reason,
  }
}
