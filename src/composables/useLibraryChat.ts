/**
 * The state behind `/chat` (P6-7b).
 *
 * One page, one conversation at a time. Everything the view renders lives
 * here: the thread list, the messages of the open thread, the answer being
 * written as it streams, and the proposals waiting for a person to press Run.
 *
 * The interesting part is the turn. A message sent is three things at once —
 * a question that should appear the instant it is typed, an answer assembled
 * from `text` deltas, and a list of tool calls that fill in as they finish —
 * so both halves go into `messages` straight away with temporary ids and are
 * filled in by the stream. `done` stamps the real ids; an `error` decides
 * whether the turn survives:
 *
 *  - with a `messageId`, the server stored an answer (the honesty line is a
 *    real answer), so the pair stays and the sentence goes in the banner;
 *  - without one, nothing was stored, so the pair is removed and the text is
 *    handed back for the composer to restore — the question can just be
 *    asked again (docs/CHAT.md §3).
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import {
  archiveChat,
  chatErrorMessage,
  confirmAction,
  createChat,
  getChat,
  isAbortError,
  listChats,
  renameChat,
  sendMessage,
  type Chat,
  type ChatEvent,
  type ChatMessage,
  type ChatToolCall,
} from '@/lib/libraryChat'
import { useAuth } from '@/composables/useAuth'

/** The server's name for a thread nobody has titled yet. */
export const UNTITLED_CHAT = 'New chat'

export interface ChatMessageView extends ChatMessage {
  /** Still being written — the view shows a cursor and disables the composer. */
  pending?: boolean
  /** The reader pressed Stop; what is above is all that arrived here. */
  stopped?: boolean
}

/** What a proposed write is doing right now, for the card's four states. */
export type ActionState = 'proposed' | 'running' | 'done' | 'failed'

export function actionStateOf(call: ChatToolCall, running: readonly string[]): ActionState {
  if (running.includes(call.id)) return 'running'
  if (call.status === 'confirmed') return 'done'
  if (call.status === 'failed') return 'failed'
  return 'proposed'
}

export interface LibraryChat {
  threads: Ref<Chat[]>
  threadsLoading: Ref<boolean>
  threadsError: Ref<string>
  currentChatId: Ref<number | null>
  currentChat: ComputedRef<Chat | null>
  messages: Ref<ChatMessageView[]>
  messagesLoading: Ref<boolean>
  streaming: Ref<boolean>
  error: Ref<string>
  actionError: Ref<string>
  runningActions: Ref<string[]>
  /** A turn the server never stored, given back so the composer can refill. */
  unsentText: Ref<string>
  loadThreads: () => Promise<void>
  openThread: (chatId: number) => Promise<void>
  startThread: () => Promise<void>
  send: (text: string) => Promise<void>
  stop: () => void
  rename: (chatId: number, title: string) => Promise<void>
  archive: (chatId: number) => Promise<void>
  runAction: (actionId: string) => Promise<void>
}

/** What a page can be told about a turn as it happens (P6-10). */
export interface LibraryChatHooks {
  /**
   * A tool the server ran, or one it is asking *this page* to run. Library
   * tools run on the server and arrive here as news; the map tools
   * (`show_layer`, `zoom_to_county`, `show_county_details`,
   * `set_query_state`) can only run where the map is, so a page with a map
   * pane executes those itself against its canvas's `ToolContext`.
   */
  onToolCall?: (call: ChatToolCall) => void
}

export function useLibraryChat(hooks: LibraryChatHooks = {}): LibraryChat {
  const { internalUser } = useAuth()
  // P5-75: an admin is told WHY the model is down; a member cannot act on it.
  const errorOptions = computed(() => ({ isAdmin: internalUser.value?.role === 'admin' }))

  const threads = ref<Chat[]>([])
  const threadsLoading = ref(false)
  const threadsError = ref('')
  const currentChatId = ref<number | null>(null)
  const messages = ref<ChatMessageView[]>([])
  const messagesLoading = ref(false)
  const streaming = ref(false)
  const error = ref('')
  const actionError = ref('')
  const runningActions = ref<string[]>([])
  const unsentText = ref('')

  const currentChat = computed(() => threads.value.find(thread => thread.id === currentChatId.value) ?? null)

  /** Temporary ids for the two messages a turn shows before the server has
   *  named them. Negative, so they can never collide with a stored id. */
  let nextTempId = -1
  const tempId = (): number => nextTempId--

  let inFlight: AbortController | null = null
  /** Only the newest turn may write to the page. */
  let turnId = 0

  function say(err: unknown, target: Ref<string>): void {
    target.value = chatErrorMessage(err, errorOptions.value)
  }

  // --- Threads ---------------------------------------------------------------

  async function loadThreads(): Promise<void> {
    threadsLoading.value = true
    threadsError.value = ''
    try {
      threads.value = await listChats()
    } catch (err: unknown) {
      say(err, threadsError)
    } finally {
      threadsLoading.value = false
    }
  }

  /** Most recently used first, which is the order the server lists them in. */
  function touchThread(chatId: number): void {
    const index = threads.value.findIndex(thread => thread.id === chatId)
    if (index < 0) return
    const [thread] = threads.value.splice(index, 1)
    threads.value.unshift({ ...thread, updatedAt: new Date().toISOString() })
  }

  async function openThread(chatId: number): Promise<void> {
    stop()
    const id = ++turnId
    currentChatId.value = chatId
    messages.value = []
    error.value = ''
    actionError.value = ''
    messagesLoading.value = true
    try {
      const { chat, messages: stored } = await getChat(chatId)
      if (id !== turnId) return
      messages.value = stored
      // The stored title wins: the server renames an untitled thread from its
      // first question, and the list may predate that.
      const index = threads.value.findIndex(thread => thread.id === chat.id)
      if (index >= 0) threads.value[index] = chat
    } catch (err: unknown) {
      if (id !== turnId) return
      say(err, error)
    } finally {
      if (id === turnId) messagesLoading.value = false
    }
  }

  async function startThread(): Promise<void> {
    stop()
    error.value = ''
    try {
      const chat = await createChat()
      threads.value = [chat, ...threads.value]
      currentChatId.value = chat.id
      messages.value = []
      actionError.value = ''
    } catch (err: unknown) {
      say(err, error)
    }
  }

  async function rename(chatId: number, title: string): Promise<void> {
    const trimmed = title.trim()
    if (!trimmed) return
    try {
      const chat = await renameChat(chatId, trimmed)
      const index = threads.value.findIndex(thread => thread.id === chatId)
      if (index >= 0) threads.value[index] = chat
    } catch (err: unknown) {
      say(err, threadsError)
    }
  }

  async function archive(chatId: number): Promise<void> {
    try {
      await archiveChat(chatId)
      threads.value = threads.value.filter(thread => thread.id !== chatId)
      if (currentChatId.value === chatId) {
        stop()
        currentChatId.value = null
        messages.value = []
      }
    } catch (err: unknown) {
      say(err, threadsError)
    }
  }

  // --- A turn ----------------------------------------------------------------

  function applyEvent(answer: ChatMessageView, event: ChatEvent): void {
    switch (event.type) {
      case 'text':
        // One delta per model round today; joined with a blank line, exactly
        // as the server joins them for the stored message.
        answer.text = answer.text ? `${answer.text}\n\n${event.text}` : event.text
        break
      case 'tool_call': {
        const index = answer.toolCalls.findIndex(call => call.id === event.call.id)
        if (index >= 0) answer.toolCalls[index] = event.call
        else answer.toolCalls.push(event.call)
        // A page with a map runs the map tools itself; everything else is
        // already done by the time the line arrives. Only the opening phase
        // fires, so a tool runs once per call.
        if (event.phase === 'started') hooks.onToolCall?.(event.call)
        break
      }
      case 'proposed_action':
        answer.toolCalls.push(event.action)
        break
      case 'citations':
        answer.citations = event.citations
        break
      default:
        break
    }
  }

  async function send(text: string): Promise<void> {
    const body = text.trim()
    if (!body || streaming.value) return
    error.value = ''
    unsentText.value = ''

    if (currentChatId.value === null) {
      try {
        // A thread has to exist before a message can be sent to it. The text
        // is passed only to NAME it (docs/CHAT.md §2).
        const chat = await createChat({ message: body })
        threads.value = [chat, ...threads.value]
        currentChatId.value = chat.id
        messages.value = []
      } catch (err: unknown) {
        say(err, error)
        unsentText.value = body
        return
      }
    }

    const chatId = currentChatId.value
    const firstTurn = messages.value.length === 0
    const now = new Date().toISOString()
    const questionId = tempId()
    const answerId = tempId()
    const at = messages.value.length
    messages.value.push(
      { id: questionId, role: 'user', text: body, toolCalls: [], citations: [], createdAt: now },
      { id: answerId, role: 'assistant', text: '', toolCalls: [], citations: [], createdAt: now, pending: true },
    )
    // The reactive copies, not the literals above: `messages` is a deep ref,
    // so only what it hands back triggers a re-render when it is written to.
    const question = messages.value[at]
    const answer = messages.value[at + 1]

    const id = ++turnId
    const controller = new AbortController()
    inFlight = controller
    streaming.value = true
    try {
      const done = await sendMessage(chatId, body, event => applyEvent(answer, event), controller.signal)
      if (id !== turnId) return
      question.id = done.userMessageId ?? question.id
      answer.id = done.messageId
      answer.pending = false
      touchThread(chatId)
      // The server names an untitled thread from its first question; only
      // then is the list worth re-reading.
      if (firstTurn) void loadThreads()
    } catch (err: unknown) {
      if (id !== turnId) return
      answer.pending = false
      if (isAbortError(err)) {
        answer.stopped = true
        touchThread(chatId)
        return
      }
      say(err, error)
      const storedId = (err as { messageId?: number } | null)?.messageId
      if (typeof storedId === 'number') {
        // The turn was stored — the honesty line already arrived as `text`
        // and is a real answer. Keep it.
        answer.id = storedId
        touchThread(chatId)
        return
      }
      // Nothing was stored. Take the question back and let them send it again.
      messages.value = messages.value.filter(message => message.id !== questionId && message.id !== answerId)
      unsentText.value = body
    } finally {
      if (id === turnId) {
        streaming.value = false
        inFlight = null
      }
    }
  }

  function stop(): void {
    inFlight?.abort()
    inFlight = null
  }

  // --- Proposals -------------------------------------------------------------

  function replaceAction(action: ChatToolCall): void {
    for (const message of messages.value) {
      const index = message.toolCalls.findIndex(call => call.id === action.id)
      if (index >= 0) message.toolCalls[index] = action
    }
  }

  /**
   * Run a write the person confirmed. The server runs the STORED proposal, so
   * nothing is passed but its id — the arguments shown are the ones that run.
   */
  async function runAction(actionId: string): Promise<void> {
    const chatId = currentChatId.value
    if (chatId === null || runningActions.value.includes(actionId)) return
    actionError.value = ''
    runningActions.value = [...runningActions.value, actionId]
    try {
      const outcome = await confirmAction(chatId, actionId)
      if (outcome.action) replaceAction(outcome.action)
      // A refused write leaves a message in the thread too: the assistant
      // reads it next turn and can talk about it instead of repeating itself.
      if (outcome.message) messages.value.push(outcome.message)
      if (!outcome.ok) actionError.value = outcome.error ?? 'That could not be run. Please try again.'
      else touchThread(chatId)
    } catch (err: unknown) {
      say(err, actionError)
    } finally {
      runningActions.value = runningActions.value.filter(id => id !== actionId)
    }
  }

  return {
    threads,
    threadsLoading,
    threadsError,
    currentChatId,
    currentChat,
    messages,
    messagesLoading,
    streaming,
    error,
    actionError,
    runningActions,
    unsentText,
    loadThreads,
    openThread,
    startThread,
    send,
    stop,
    rename,
    archive,
    runAction,
  }
}
