import Anthropic from '@anthropic-ai/sdk'
import { buildSystemPrompt, VALID_LAYER_IDS } from '../prompt/systemPrompt.js'
import { buildChatPrompt } from '../prompt/chatPrompt.js'
import { TOOL_DEFINITIONS } from '../prompt/toolDefinitions.js'

export interface LayerSelection {
  layerId: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

export interface ScoringFilter {
  layerId: string
  operator: 'greater_than' | 'less_than' | 'between'
  value: number
  max?: number
}

export interface QueryResponse {
  layers: LayerSelection[]
  filters?: ScoringFilter[]
  limit?: number
  explanation: string
}

const VALID_OPERATORS = new Set(['greater_than', 'less_than', 'between'])

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
    .filter((l: any) => VALID_LAYER_IDS.has(l.layerId))
    .map((l: any) => ({
      layerId: l.layerId,
      weight: Math.max(1, Math.min(10, Math.round(l.weight))),
      direction: l.direction === 'lower_better' ? 'lower_better' as const : 'higher_better' as const,
    }))

  // Validate and clean filters
  let validFilters: ScoringFilter[] | undefined
  if (Array.isArray(parsed.filters)) {
    validFilters = parsed.filters
      .filter((f: any) =>
        f &&
        typeof f.layerId === 'string' &&
        VALID_LAYER_IDS.has(f.layerId) &&
        typeof f.operator === 'string' &&
        VALID_OPERATORS.has(f.operator) &&
        typeof f.value === 'number' &&
        !isNaN(f.value)
      )
      .map((f: any) => {
        const out: ScoringFilter = {
          layerId: f.layerId,
          operator: f.operator,
          value: f.value,
        }
        if (f.operator === 'between' && typeof f.max === 'number' && !isNaN(f.max)) {
          out.max = f.max
        }
        return out
      })
    if (validFilters.length === 0) validFilters = undefined
  }

  // Clamp limit to 1-50
  let validLimit: number | undefined
  if (typeof parsed.limit === 'number' && !isNaN(parsed.limit)) {
    validLimit = Math.max(1, Math.min(50, Math.round(parsed.limit)))
  }

  return {
    layers: validLayers,
    filters: validFilters,
    limit: validLimit,
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
