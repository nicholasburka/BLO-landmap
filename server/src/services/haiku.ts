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

export interface QueryResult {
  response: QueryResponse
  /** input + output tokens for this call — routes settle the budget reservation with it */
  usedTokens: number
}

export async function queryHaiku(userPrompt: string): Promise<QueryResult> {
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const usedTokens = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0)

  // Extract text content
  const textBlock = message.content.find(block => block.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    return { response: { layers: [], explanation: 'Unable to process query.' }, usedTokens }
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
        return { response: { layers: [], explanation: 'Unable to parse response. Please try rephrasing your query.' }, usedTokens }
      }
    } else {
      return { response: { layers: [], explanation: 'Unable to parse response. Please try rephrasing your query.' }, usedTokens }
    }
  }

  // Validate structure
  if (!parsed.layers || !Array.isArray(parsed.layers)) {
    return { response: { layers: [], explanation: parsed.explanation || 'Invalid response format.' }, usedTokens }
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
    response: {
      layers: validLayers,
      filters: validFilters,
      limit: validLimit,
      explanation: parsed.explanation || 'Query processed.',
    },
    usedTokens,
  }
}

// ============= Phase 3: Chat with tool use =============

export interface ChatResponse {
  /** The full assistant message (content blocks) — forwarded to client as-is */
  message: Anthropic.Messages.Message
  /** Whether Claude stopped to call tools (vs finished the turn) */
  stopReason: Anthropic.Messages.Message['stop_reason']
  /** input + output tokens for this call — routes settle the budget reservation with it */
  usedTokens: number
}

/** Context the client sends alongside the message history.
 *  Used to let the LLM know about map state it couldn't otherwise see. */
export interface ClientChatContext {
  /** Currently-applied threshold filters. LLM is instructed to preserve
   *  them across tool calls unless the user asks to change them. */
  activeFilters?: ScoringFilter[]
}

function renderActiveFiltersContext(ctx?: ClientChatContext): string {
  const raw = ctx?.activeFilters
  if (!Array.isArray(raw) || raw.length === 0) return ''
  // Everything rendered here lands in the SYSTEM prompt, so client-supplied
  // strings must not pass through verbatim — an attacker-crafted layerId is
  // a prompt injection. Only known layer ids, known operators, and finite
  // numbers survive.
  const filters = raw.filter(
    (f): f is ScoringFilter =>
      !!f &&
      typeof f.layerId === 'string' &&
      VALID_LAYER_IDS.has(f.layerId) &&
      typeof f.operator === 'string' &&
      VALID_OPERATORS.has(f.operator) &&
      typeof f.value === 'number' &&
      Number.isFinite(f.value) &&
      (f.max === undefined || (typeof f.max === 'number' && Number.isFinite(f.max))),
  )
  if (filters.length === 0) return ''
  const rendered = filters.map(f => {
    const op = f.operator
    if (op === 'between') return `${f.layerId} between ${f.value} and ${f.max ?? '?'}`
    const symbol = op === 'greater_than' ? '>' : op === 'less_than' ? '<' : '?'
    return `${f.layerId} ${symbol} ${f.value}`
  }).join(', ')
  return [
    '',
    '## Active filters on the map right now',
    '',
    `The user has these threshold filters applied: ${rendered}.`,
    '',
    'Rules for `filters` in set_layer_selection calls:',
    '- **Preserve** (include exact same filter objects in your `filters` field) when the user is refining scoring, adding layers, or asking anything that does not mention the filter.',
    '- **Replace** (emit a new array with different thresholds) when the user asks to change a threshold (e.g. "use 40% instead").',
    '- **Clear** (emit an empty array `"filters": []` — NOT omit the field, NOT say "done" without emitting) when the user asks to clear, remove, or drop a filter. Omitting the field means "keep as-is" in this system.',
    '- **Add** (include old filters plus the new one) when the user adds a new criterion alongside existing ones.',
  ].join('\n')
}

/**
 * Send a multi-turn conversation to Haiku with tool use enabled.
 */
export async function chatHaiku(
  messages: Anthropic.Messages.MessageParam[],
  context?: ClientChatContext,
): Promise<ChatResponse> {
  const systemWithContext = chatSystemPrompt + renderActiveFiltersContext(context)
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemWithContext,
    tools: TOOL_DEFINITIONS,
    messages,
  })

  return {
    message,
    stopReason: message.stop_reason,
    usedTokens: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
  }
}
