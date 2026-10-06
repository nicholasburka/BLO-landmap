/**
 * Chat with the library (P6-7b) — the client half of `docs/CHAT.md`.
 *
 * Seven routes and one stream. Everything goes through `internalFetch`, so
 * the session cookie, the CSRF header and the API base URL are the same ones
 * the rest of the internal app uses; nothing here knows where the server is.
 *
 * Two shapes are worth reading before the code:
 *
 *  - **The answer is a stream.** `POST /api/chats/:id/messages` answers 200
 *    with newline-delimited JSON, one event object per line. `sendMessage`
 *    hands each event to a callback as it lands and resolves on `done`.
 *  - **Writes are proposals.** The model never changes the library; it emits
 *    a `proposed_action` and waits. `confirmAction` is the only thing that
 *    runs one, and it runs the arguments the person was shown.
 *
 * Failures reuse Ask's own error type and sentences (`lib/ask.ts`): the two
 * pages answer the same kinds of question against the same budget and the
 * same model, so a reader should get the same words when either is down.
 */
import { internalFetch } from './apiBase'
import {
  AskRequestError,
  askErrorMessage,
  ADMIN_REASON_TEXT,
  type AskErrorOptions,
  type AskFailureReason,
  type AskSource,
} from './ask'

// --- Shapes (docs/CHAT.md §4) ----------------------------------------------

export interface Chat {
  id: number
  title: string
  createdAt: string
  updatedAt: string
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'summary'

/** The server's caps, mirrored so the page can stop a message the route
 *  would only refuse (docs/CHAT.md §1). */
export const MESSAGE_MAX_CHARS = 2_000
export const CHAT_TITLE_MAX = 120

/** `running` exists only on the wire, while a read is in flight. */
export type ChatToolStatus = 'running' | 'done' | 'failed' | 'proposed' | 'confirmed'

export interface ChatToolCall {
  /** What the confirm route addresses. */
  id: string
  tool: string
  kind: 'read' | 'write'
  status: ChatToolStatus
  /** One line, already written for a reader. */
  summary: string
  /** Writes: what would run / did run. */
  args?: Record<string, unknown>
  /** Writes: what running it returned. */
  result?: Record<string, unknown>
}

/** The same numbered source Ask cites with — one shape, one renderer. */
export type ChatCitation = AskSource

export interface ChatMessage {
  id: number
  role: ChatRole
  text: string
  toolCalls: ChatToolCall[]
  citations: ChatCitation[]
  createdAt: string
}

// --- The stream's events (docs/CHAT.md §3) ---------------------------------

export interface ChatTextEvent {
  type: 'text'
  text: string
}

export interface ChatToolCallEvent {
  type: 'tool_call'
  phase: 'started' | 'finished'
  call: ChatToolCall
}

export interface ChatProposedActionEvent {
  type: 'proposed_action'
  action: ChatToolCall
}

export interface ChatCitationsEvent {
  type: 'citations'
  citations: ChatCitation[]
}

export interface ChatDoneEvent {
  type: 'done'
  chatId: number
  messageId: number
  userMessageId?: number
}

export interface ChatErrorEvent {
  type: 'error'
  error: string
  /** Admins only (P5-75): which failure it was, so they can go and fix it. */
  reason?: AskFailureReason
  /** Present when the turn was still stored — the honesty line is an answer. */
  messageId?: number
}

export type ChatEvent =
  | ChatTextEvent
  | ChatToolCallEvent
  | ChatProposedActionEvent
  | ChatCitationsEvent
  | ChatDoneEvent
  | ChatErrorEvent

const EVENT_TYPES = new Set(['text', 'tool_call', 'proposed_action', 'citations', 'done', 'error'])

/** A line that is not one of our events is skipped rather than fatal: a new
 *  server event type must never break an old page mid-answer. */
function asEvent(value: unknown): ChatEvent | null {
  const type = (value as { type?: unknown } | null)?.type
  return typeof type === 'string' && EVENT_TYPES.has(type) ? (value as ChatEvent) : null
}

// --- Failures ---------------------------------------------------------------

/** The four reasons, taken from Ask's own table so the two cannot drift. */
const FAILURE_REASONS = Object.keys(ADMIN_REASON_TEXT) as AskFailureReason[]

function failureReasonIn(body: unknown): AskFailureReason | undefined {
  const reason = (body as { reason?: unknown } | null)?.reason
  return FAILURE_REASONS.find(known => known === reason)
}

/** The server's word for "no database, no bucket". True, and not a sentence
 *  anybody can act on, so it is replaced once, here. */
const LIBRARY_DOWN = 'library unavailable'
export const LIBRARY_DOWN_TEXT = 'The library is not available right now. Please try again in a minute.'
export const CHAT_NOT_FOUND_TEXT = 'That conversation is not there any more.'
export const STREAM_CUT_TEXT = 'The answer stopped before it finished. Please ask again.'

/**
 * An `error` event on an otherwise healthy stream. It is an `AskRequestError`
 * so `askErrorMessage` reads it exactly as it reads Ask's, and carries the id
 * of the message the server stored — its absence means nothing was stored and
 * the question can simply be sent again (docs/CHAT.md §3).
 */
export class ChatStreamError extends AskRequestError {
  constructor(message: string, reason?: AskFailureReason, public readonly messageId?: number) {
    super(503, message, reason)
    this.name = 'ChatStreamError'
  }
}

async function refusalOf(res: Response): Promise<AskRequestError> {
  let message = ''
  let reason: AskFailureReason | undefined
  try {
    const body: unknown = await res.json()
    const raw = (body as { error?: unknown } | null)?.error
    if (typeof raw === 'string') message = raw === LIBRARY_DOWN ? LIBRARY_DOWN_TEXT : raw
    reason = failureReasonIn(body)
  } catch {
    /* non-JSON body — the status is all we have */
  }
  return new AskRequestError(res.status, message, reason)
}

/**
 * The sentence to show for a failed chat call. Ask's helper does the work —
 * budget, session, rate limit, and the admin-only "why the model is down" —
 * and the one status it has never seen is added here.
 */
export function chatErrorMessage(err: unknown, options: AskErrorOptions = {}): string {
  if (err instanceof AskRequestError && err.status === 404) return CHAT_NOT_FOUND_TEXT
  return askErrorMessage(err, options)
}

/** True when a promise rejected because the caller aborted it (Stop, or
 *  leaving the page), which is not a failure worth a sentence. */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as Error | null)?.name === 'AbortError'
}

// --- Threads ----------------------------------------------------------------

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await internalFetch(path, init)
  } catch {
    throw new AskRequestError(0, 'offline')
  }
  if (!res.ok) throw await refusalOf(res)
  return (await res.json()) as T
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }
}

export async function listChats(): Promise<Chat[]> {
  const { chats } = await request<{ chats: Chat[] }>('/api/chats')
  return chats ?? []
}

/** `message` only NAMES the thread (docs/CHAT.md §2) — it is not stored and
 *  not sent to the model. Send it separately. */
export async function createChat(options: { title?: string; message?: string } = {}): Promise<Chat> {
  const { chat } = await request<{ chat: Chat }>('/api/chats', jsonInit('POST', options))
  return chat
}

export async function getChat(chatId: number): Promise<{ chat: Chat; messages: ChatMessage[] }> {
  const body = await request<{ chat: Chat; messages: ChatMessage[] }>(`/api/chats/${chatId}`)
  return { chat: body.chat, messages: body.messages ?? [] }
}

export async function renameChat(chatId: number, title: string): Promise<Chat> {
  const { chat } = await request<{ chat: Chat }>(`/api/chats/${chatId}`, jsonInit('PATCH', { title }))
  return chat
}

/** Archive: the thread stops being listed and stops being readable, and the
 *  record of what was run from it survives. */
export async function archiveChat(chatId: number): Promise<void> {
  await request<{ archived: true }>(`/api/chats/${chatId}`, jsonInit('DELETE'))
}

// --- Confirming a write -----------------------------------------------------

/**
 * A confirm has four honest outcomes and only one of them is an exception, so
 * it returns a result rather than throwing: a write that RAN and was refused
 * (400) still leaves a message in the thread, and the page has to show it.
 */
export interface ConfirmResult {
  ok: boolean
  /** The sentence to show when `ok` is false. */
  error?: string
  /** The action in its new state — replace the proposal with it. */
  action?: ChatToolCall
  /** Append to the thread when present; the assistant reads it next turn. */
  message?: ChatMessage
}

export async function confirmAction(chatId: number, actionId: string): Promise<ConfirmResult> {
  const path = `/api/chats/${chatId}/actions/${encodeURIComponent(actionId)}/confirm`
  let res: Response
  try {
    res = await internalFetch(path, { method: 'POST' })
  } catch {
    throw new AskRequestError(0, 'offline')
  }
  let body: { error?: string; action?: ChatToolCall; message?: ChatMessage } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    /* non-JSON body */
  }
  if (res.ok) return { ok: true, action: body.action, message: body.message }
  const error =
    res.status === 404
      ? 'That proposal is not in this conversation any more.'
      : body.error || 'That could not be run. Please try again.'
  return { ok: false, error, action: body.action, message: body.message }
}

// --- The stream -------------------------------------------------------------

/**
 * Send a message and read the answer as it arrives.
 *
 * The body is NDJSON: complete JSON objects separated by newlines, flushed as
 * they happen. A chunk can end anywhere, including mid-line, so the tail of
 * each chunk is carried into the next one and only whole lines are parsed.
 *
 * Resolves on `done`. Rejects on `error`, on a non-2xx (the refusal arrives
 * as JSON before the stream starts), and on a stream that ends with neither —
 * exactly one terminal event ends every healthy stream.
 */
export async function sendMessage(
  chatId: number,
  text: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<ChatDoneEvent> {
  let res: Response
  try {
    res = await internalFetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new AskRequestError(0, 'offline')
  }
  if (!res.ok) throw await refusalOf(res)
  if (!res.body) throw new AskRequestError(502, STREAM_CUT_TEXT)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done: ChatDoneEvent | null = null

  /** One line in, the terminal event out when this was it. Throws on `error`. */
  const handle = (line: string): ChatDoneEvent | null => {
    const trimmed = line.trim()
    if (!trimmed) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return null // a line we cannot read is skipped, never fatal
    }
    const event = asEvent(parsed)
    if (!event) return null
    if (event.type === 'error') throw new ChatStreamError(event.error, event.reason, event.messageId)
    onEvent(event)
    return event.type === 'done' ? event : null
  }

  try {
    while (!done) {
      const { value, done: finished } = await reader.read()
      if (finished) {
        done = handle(buffer)
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) done = handle(line) ?? done
    }
  } finally {
    // Nothing more will be read from this body, whether we finished, threw or
    // were aborted; releasing the lock lets the connection be reclaimed.
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }

  if (!done) throw new AskRequestError(502, STREAM_CUT_TEXT)
  return done
}

// --- "Open" (spec E.17) -----------------------------------------------------
// An answer that ran an analysis should offer the analysis, not a description
// of it. Three places carry that link, in the order they are trusted:
// a write the person confirmed, a cited source that IS an analysis, and a
// link the answer itself wrote.

/** The routes that are an analysis rather than a piece of the library. */
const ANALYSIS_ROUTES: Array<{ test: RegExp; label: string }> = [
  { test: /^\/views\/[^\s)]+/, label: 'Open the saved view' },
  { test: /^\/\?view=[^\s)]+/, label: 'Open the saved view' },
  { test: /^\/place(\/|\?|$)/, label: 'Open the report' },
  { test: /^\/compare(\/|\?|$)/, label: 'Open the comparison' },
]

/** Citation kinds that are themselves an analysis. */
const ANALYSIS_KINDS = new Set(['view', 'place', 'report'])

export interface ChatOpenTarget {
  /** A same-origin path — Open is always a link inside this app. */
  href: string
  label: string
}

/**
 * This app's path for a link, or null when the link points somewhere else.
 *
 * The server writes absolute links (`appUrl`) into tool results; a citation
 * href is already a path. Both should open in the app when they can, and an
 * off-site link is never one of our analyses however its path reads.
 */
export function toAppPath(href: string): string | null {
  if (href.startsWith('//') || href.includes('\\')) return null
  if (href.startsWith('/')) return href
  try {
    const url = new URL(href)
    const origin = typeof window === 'undefined' ? '' : window.location.origin
    return origin && url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : null
  } catch {
    return null
  }
}

function routeLabel(path: string): string | null {
  return ANALYSIS_ROUTES.find(route => route.test.test(path))?.label ?? null
}

/** Every link in a piece of markdown, in the order they were written. */
function linksIn(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1])
}

/**
 * What this answer's **Open** button opens, or null when the answer did not
 * produce an analysis. Pure, so the view has nothing to decide.
 */
export function openTargetFor(message: Pick<ChatMessage, 'text' | 'toolCalls' | 'citations'>): ChatOpenTarget | null {
  const candidates: string[] = []

  for (const call of message.toolCalls) {
    if (call.status !== 'confirmed') continue
    const href = call.result?.href
    if (typeof href === 'string' && href) candidates.push(href)
  }
  for (const citation of message.citations) {
    if (ANALYSIS_KINDS.has(citation.kind) && citation.href) candidates.push(citation.href)
  }
  candidates.push(...linksIn(message.text))

  for (const candidate of candidates) {
    const href = toAppPath(candidate)
    const label = href && routeLabel(href)
    if (href && label) return { href, label }
  }
  return null
}
