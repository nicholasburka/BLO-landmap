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
import { API_URL } from '@/lib/apiBase'
import type { ScoringFilter } from '@/types/mapTypes'

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
  /** True for synthetic error messages we surface inline in the chat
   *  thread (instead of a detached banner). When set, the UI styles the
   *  bubble as a warning so the user knows their request didn't go
   *  through. */
  isError?: boolean
  /** Phase 4g: live state captured at the *end* of the turn this user
   *  message kicked off. Only populated on user-role messages. Drives
   *  reload-persistence (most-recent snapshot rehydrates the map) and
   *  click-to-rewind (clicking a user bubble re-applies its snapshot). */
  snapshot?: TurnSnapshot
}

/** Phase 4g: the full reproducible map state at a turn boundary. Small
 *  enough to JSON-stringify into localStorage (≈200 bytes typical). */
export interface TurnSnapshot {
  // direction is optional to mirror ScoringQueryLayer — layers selected via
  // the UI (not the LLM) may carry no explicit direction, and the scoring
  // pipeline falls back to the registry default in that case.
  layers: { layerId: string; weight: number; direction?: 'higher_better' | 'lower_better' }[]
  filters: ScoringFilter[]
  limit: number | null
  regionStates: string[]
  currentCountyId: string | null
  currentCountyName: string | null
  listingsCount: number
}

interface ChatResponse {
  message: {
    content: ContentBlock[]
    stop_reason: string
  }
  stopReason: string
}

const MAX_MESSAGES_SENT = 20
const MAX_TOOL_CALLS_PER_TURN = 10

export interface ChatOptions {
  /** Return the currently-active threshold filters so the server can
   *  instruct the LLM to preserve them across turns. */
  getActiveFilters?: () => ScoringFilter[]
  /** Phase 4g: capture the full live map state at a turn boundary.
   *  Used both for snapshot persistence and click-to-rewind. */
  getSnapshot?: () => TurnSnapshot
  /** Phase 4g: replay a snapshot onto live map state. Same code path
   *  the LLM tool dispatcher uses (no rewind-specific branch). */
  applySnapshot?: (snap: TurnSnapshot) => void
}

const STORAGE_KEY = 'blo:conversation'
const STORAGE_VERSION = 1
/** 7 days in ms. Beyond this, persisted state is dropped on hydration. */
const STORAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface PersistedConversation {
  v: number
  savedAt: number
  messages: ChatMessage[]
  /** Phase 4g click-to-rewind: which user-message the map currently
   *  reflects. Restored on hydration so refresh-while-rewound stays
   *  rewound. Defaults to -1 (tail) if missing for backward compat. */
  activeTurnIndex?: number
}

export function useChat(toolCtx: ToolContext, options: ChatOptions = {}) {
  const messages: Ref<ChatMessage[]> = ref([])
  const isThinking = ref(false)
  const error: Ref<string | null> = ref(null)
  /** Phase 4g: index of the user-message the map state currently
   *  reflects. -1 means "tail / latest" — every new message advances
   *  the active turn to the new latest user message. Click-to-rewind
   *  sets this to an earlier index. */
  const activeTurnIndex: Ref<number> = ref(-1)
  const { getToken, clearAuth, ensureSession } = useAuth()

  /** Build the message array to send to the server (last N, in Anthropic format) */
  function buildRequestMessages(): any[] {
    let recent = messages.value.slice(-MAX_MESSAGES_SENT)
    // The naive slice can start mid-tool-exchange (a tool_result user
    // message, or an assistant message) — Anthropic rejects that with a
    // 400 because tool_use/tool_result pairs must stay together. Walk
    // forward to the first real user turn (plain string content) and
    // send from there; the window stays bounded, just possibly shorter.
    const firstUserTurn = recent.findIndex(
      (m) => m.role === 'user' && typeof m.content === 'string'
    )
    if (firstUserTurn > 0) recent = recent.slice(firstUserTurn)
    return recent.map((m) => ({
      role: m.role,
      content: m.content,
    }))
  }

  /** Push a synthetic error message into the chat thread so the user
   *  sees it visually attached to the query they just sent (instead of a
   *  detached banner above the input). Also sets error.value for any
   *  external listeners that still care, but the canonical surface is
   *  the inline bubble. */
  function pushError(text: string): void {
    error.value = text
    messages.value.push({
      role: 'assistant',
      content: '',
      displayText: text,
      isError: true,
    })
  }

  /** POST to /api/chat and return the response */
  async function postChat(): Promise<ChatResponse | null> {
    if (!API_URL) {
      // Misconfigured prod build (no VITE_API_URL) — apiBase already
      // logged the loud console error; don't fetch a dead localhost URL.
      pushError("AI features aren't configured on this deployment.")
      return null
    }

    let token = getToken()
    if (!token) {
      // Sessions are anonymous and minted silently — there is no
      // sign-in UI. The module-load mint may have failed (server down,
      // offline), so retry once here before giving up.
      await ensureSession()
      token = getToken()
    }
    if (!token) {
      pushError("Couldn't start a session — check your connection and try again.")
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
        body: JSON.stringify({
          messages: buildRequestMessages(),
          context: {
            activeFilters: options.getActiveFilters?.() ?? [],
          },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (res.status === 401) {
        // Token was rejected. Sessions are anonymous and auto-minted,
        // so "sign in again" is meaningless — clear the stale token,
        // mint a fresh session right away, and keep the user's message
        // visible with an inline bubble asking them to re-send
        // (auto-retry is a future enhancement).
        clearAuth()
        await ensureSession()
        pushError('Session refreshed — please send that again.')
        return null
      }
      if (res.status === 429) {
        pushError('Too many requests. Please wait a moment.')
        return null
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        // Daily token cap: the server returns 503 with a code and a
        // user-appropriate message ("We've hit today's usage cap…").
        // Show it verbatim — retrying won't help until tomorrow.
        if (
          res.status === 503 &&
          (data.code === 'daily_budget_exceeded' || data.code === 'daily_budget_exceeded_per_ip')
        ) {
          pushError(data.error || "We've hit today's usage cap. Please come back tomorrow.")
          return null
        }
        pushError(data.error || 'Something went wrong. Try again.')
        return null
      }

      return (await res.json()) as ChatResponse
    } catch (err: any) {
      if (err.name === 'AbortError') {
        pushError('Request timed out. Try again.')
      } else {
        pushError("Couldn't reach the server. Try again.")
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
        pushError(
          "I started doing this in pieces and ran out of steps. " +
            "Want me to try a different approach — like filtering by region " +
            "instead of state-by-state, or focusing on one thing at a time?",
        )
        break
      }
    }

    // Phase 4g: capture turn-end snapshot and attach it to the most
    // recent user-role message. Persist the whole thread so a refresh
    // restores the conversation + the map state from this turn.
    captureSnapshotForLastUserTurn()
    // A fresh send always advances the view-pointer to the new latest
    // turn (any prior rewind is discarded — sending IS committing).
    activeTurnIndex.value = lastUserMessageIndex()
    persist()

    isThinking.value = false
  }

  /** Index in messages.value of the most recent user-role message,
   *  or -1 if none. */
  function lastUserMessageIndex(): number {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'user') return i
    }
    return -1
  }

  /** Phase 4g: replay a prior turn's snapshot. Sets activeTurnIndex
   *  so the UI can render messages ahead of the rewound turn as
   *  "ahead-of-current". Sending a new message resets to tail. */
  function rewindToTurn(messageIndex: number): void {
    const m = messages.value[messageIndex]
    if (!m || m.role !== 'user' || !m.snapshot) return
    if (activeTurnIndex.value === messageIndex) return // already there
    if (options.applySnapshot) {
      try { options.applySnapshot(m.snapshot) } catch {}
    }
    activeTurnIndex.value = messageIndex
    persist()
  }

  /** Walk back from the end of messages to find the latest user message
   *  and stamp the current snapshot onto it. Called at every turn end. */
  function captureSnapshotForLastUserTurn(): void {
    if (!options.getSnapshot) return
    let snap: TurnSnapshot
    try {
      snap = options.getSnapshot()
    } catch {
      return // snapshot capture failures must not break chat
    }
    for (let i = messages.value.length - 1; i >= 0; i--) {
      if (messages.value[i].role === 'user') {
        messages.value[i].snapshot = snap
        return
      }
    }
  }

  /** Serialize messages to localStorage. Failures (quota, private
   *  mode) are caught silently — chat itself must not break. We still
   *  warn once so a developer can spot it in the console. */
  let persistFailureLogged = false
  function persist(): void {
    if (typeof window === 'undefined' || !window.localStorage) return
    try {
      const payload: PersistedConversation = {
        v: STORAGE_VERSION,
        savedAt: Date.now(),
        messages: messages.value,
        activeTurnIndex: activeTurnIndex.value,
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch (err) {
      if (!persistFailureLogged) {
        persistFailureLogged = true
        // eslint-disable-next-line no-console
        console.warn('[useChat] localStorage persist failed:', err)
      }
    }
  }

  /** Read prior conversation from localStorage if it's fresh and the
   *  schema matches. Otherwise clears the key and returns null. */
  function loadPersisted(): PersistedConversation | null {
    if (typeof window === 'undefined' || !window.localStorage) return null
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw) as PersistedConversation
      const fresh = typeof parsed.savedAt === 'number'
        && Date.now() - parsed.savedAt <= STORAGE_TTL_MS
      const schemaOk = parsed.v === STORAGE_VERSION
      if (!fresh || !schemaOk || !Array.isArray(parsed.messages)) {
        window.localStorage.removeItem(STORAGE_KEY)
        return null
      }
      // Drop any entries that aren't well-formed messages (null, plain
      // strings, wrong role) — a single corrupt entry would otherwise
      // throw during component setup and white-screen the app on every
      // load until site data is cleared.
      parsed.messages = parsed.messages.filter(
        (m): m is ChatMessage =>
          !!m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant')
      )
      return parsed
    } catch {
      try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
      return null
    }
  }

  /** On mount, restore the thread and apply the appropriate snapshot:
   *  - If the persisted activeTurnIndex points to a valid user message
   *    with a snapshot, replay that one (refresh-while-rewound stays
   *    rewound).
   *  - Otherwise replay the most recent snapshot.
   *  Idempotent. */
  function hydrate(): void {
    try {
      const persisted = loadPersisted()
      if (!persisted) return
      messages.value = persisted.messages
      const persistedIdx = typeof persisted.activeTurnIndex === 'number'
        ? persisted.activeTurnIndex
        : -1
      let replayIdx = -1
      if (persistedIdx >= 0 && persistedIdx < messages.value.length) {
        const m = messages.value[persistedIdx]
        if (m.role === 'user' && m.snapshot) replayIdx = persistedIdx
      }
      if (replayIdx === -1) {
        for (let i = messages.value.length - 1; i >= 0; i--) {
          const m = messages.value[i]
          if (m.role === 'user' && m.snapshot) { replayIdx = i; break }
        }
      }
      if (replayIdx === -1) return
      activeTurnIndex.value = replayIdx
      if (options.applySnapshot) {
        try { options.applySnapshot(messages.value[replayIdx].snapshot!) } catch {}
      }
    } catch {
      // Corrupt persisted state must never white-screen the app —
      // clear it and start with a fresh thread.
      messages.value = []
      activeTurnIndex.value = -1
      try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
    }
  }

  hydrate()

  function clearConversation(): void {
    messages.value = []
    error.value = null
    activeTurnIndex.value = -1
    if (typeof window !== 'undefined' && window.localStorage) {
      try { window.localStorage.removeItem(STORAGE_KEY) } catch {}
    }
  }

  return {
    messages,
    isThinking,
    error,
    activeTurnIndex,
    sendMessage,
    clearConversation,
    rewindToTurn,
  }
}
