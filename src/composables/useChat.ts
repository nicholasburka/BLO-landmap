/**
 * Phase 3 Chat Composable
 *
 * Manages client-side conversation state for multi-turn LLM chat with tool use.
 * Executes tool calls against the ToolContext, loops until the LLM returns a
 * final text response (stop_reason: "end_turn"), and appends results to the
 * conversation history for display.
 */

import { ref, type Ref } from 'vue'
import { executeTool, type ToolContext } from '@/lib/mapTools'
import { useAuth } from '@/composables/useAuth'

// Anthropic content block types (minimal subset we need)
export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  /** Derived text for display in the UI */
  displayText?: string
  /** Tool calls made in this message (for UI rendering) */
  toolCalls?: { name: string; input: any; result?: string }[]
}

interface ChatResponse {
  message: {
    content: ContentBlock[]
    stop_reason: string
  }
  stopReason: string
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const MAX_MESSAGES_SENT = 20
const MAX_TOOL_CALLS_PER_TURN = 10

export function useChat(toolCtx: ToolContext) {
  const messages: Ref<ChatMessage[]> = ref([])
  const isThinking = ref(false)
  const error: Ref<string | null> = ref(null)
  const { getToken, clearAuth } = useAuth()

  /** Build the message array to send to the server (last N, in Anthropic format) */
  function buildRequestMessages(): any[] {
    const recent = messages.value.slice(-MAX_MESSAGES_SENT)
    return recent.map((m) => ({
      role: m.role,
      content: m.content,
    }))
  }

  /** POST to /api/chat and return the response */
  async function postChat(): Promise<ChatResponse | null> {
    const token = getToken()
    if (!token) {
      error.value = 'Please sign in first'
      return null
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ messages: buildRequestMessages() }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (res.status === 401) {
        clearAuth('Session expired. Please sign in again.')
        error.value = null
        // Clear conversation on auth loss so stale messages don't show
        messages.value = []
        return null
      }
      if (res.status === 429) {
        error.value = 'Too many requests. Please wait a moment.'
        return null
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        error.value = data.error || 'Something went wrong. Try again.'
        return null
      }

      return (await res.json()) as ChatResponse
    } catch (err: any) {
      if (err.name === 'AbortError') {
        error.value = 'Request timed out. Try again.'
      } else {
        error.value = "Couldn't reach the server. Try again."
      }
      return null
    }
  }

  /** Send a user message and loop through tool calls until end_turn */
  async function sendMessage(text: string): Promise<void> {
    if (!text.trim() || isThinking.value) return

    error.value = null
    isThinking.value = true

    // Append the user message
    messages.value.push({
      role: 'user',
      content: text.trim(),
      displayText: text.trim(),
    })

    let toolCallCount = 0

    while (toolCallCount < MAX_TOOL_CALLS_PER_TURN) {
      const response = await postChat()
      if (!response) {
        isThinking.value = false
        return
      }

      const assistantBlocks = response.message.content

      // Extract text and tool calls for display
      const textBlocks = assistantBlocks.filter((b): b is TextBlock => b.type === 'text')
      const toolUseBlocks = assistantBlocks.filter((b): b is ToolUseBlock => b.type === 'tool_use')

      const displayText = textBlocks.map((t) => t.text).join('\n').trim()
      const toolCalls = toolUseBlocks.map((t) => ({ name: t.name, input: t.input }))

      // Append assistant message with full content blocks (for next turn's context)
      messages.value.push({
        role: 'assistant',
        content: assistantBlocks,
        displayText: displayText || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      })

      // If Claude is done (no more tool calls), break
      if (response.stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
        break
      }

      // Execute each tool call and collect results
      const toolResults: ToolResultBlock[] = []
      for (const toolUse of toolUseBlocks) {
        toolCallCount++
        const result = await executeTool(toolUse.name, toolUse.input, toolCtx)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
        })
        // Annotate the tool call in the message we just appended
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg.toolCalls) {
          const matching = lastMsg.toolCalls.find(
            (tc) => tc.name === toolUse.name && JSON.stringify(tc.input) === JSON.stringify(toolUse.input)
          )
          if (matching) matching.result = result
        }
      }

      // Append a user message with tool results so Claude can continue
      messages.value.push({
        role: 'user',
        content: toolResults,
      })

      if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
        error.value = 'Too many tool calls in one turn. Stopping.'
        break
      }
    }

    isThinking.value = false
  }

  function clearConversation(): void {
    messages.value = []
    error.value = null
  }

  return {
    messages,
    isThinking,
    error,
    sendMessage,
    clearConversation,
  }
}
