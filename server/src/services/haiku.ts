import Anthropic from '@anthropic-ai/sdk'
import { buildSystemPrompt, VALID_LAYER_IDS } from '../prompt/systemPrompt.js'

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

export async function queryHaiku(userPrompt: string): Promise<QueryResponse> {
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
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
