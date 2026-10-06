import { Router } from 'express'
import type { Response } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { privateNoCache } from '../middleware/privateCache.js'
import { dailyBudgetMiddleware, settleReservation } from '../middleware/budget.js'
import { isLibraryEnabled } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { recordUsage, hashIp } from '../services/usageStore.js'
import type { InternalUser } from '../services/internalSessions.js'
import {
  appendMessage,
  archiveChat,
  contextMessages,
  createChat,
  getChat,
  listChats,
  listMessages,
  renameChat,
  titleFromMessage,
  CHAT_TITLE_MAX,
  MESSAGE_MAX_CHARS,
  UNTITLED_CHAT,
  type ChatMessageRow,
  type ChatRow,
} from '../services/libraryChat.js'
import { compactIfNeeded, confirmAction, runChatTurn, MODEL_UNAVAILABLE, type ChatEvent } from '../services/chatLoop.js'

/**
 * Chat (P6-7a): conversations with the library's own tools.
 *
 * Everything is internal-tier — session cookie, CSRF header on the writes,
 * the per-user limiter — and every thread is looked up by (id, owner), so
 * another account's thread is a 404 rather than a 403 that confirms it
 * exists. Only the message route spends model tokens, so only it carries the
 * daily budget, exactly as Ask does.
 *
 * The answer streams as newline-delimited JSON (one event object per line,
 * `application/x-ndjson`). See docs/CHAT.md for the wire protocol.
 */
const router = Router()

export const PATH_PREFIX = '/api/chats'

function notFound(res: Response): void {
  res.status(404).json({ error: 'not found' })
}

function chatIdOf(raw: unknown): number | null {
  const id = Number(Array.isArray(raw) ? raw[0] : raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

function userOf(res: Response): InternalUser {
  return res.locals.internalUser as InternalUser
}

/** What the client is told about a thread. The owner is not echoed: a thread
 *  can only ever be read by them. */
export function publicChat(chat: ChatRow): Record<string, unknown> {
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt }
}

/** A message as the page renders it. `meta` stays server-side — the only
 *  thing in it a person is shown is the admin reason code, which travels on
 *  the error event of the turn that produced it. */
export function publicMessage(message: ChatMessageRow): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    toolCalls: message.toolCalls,
    citations: message.citations,
    createdAt: message.createdAt,
  }
}

export function validateTitle(value: unknown): { title: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'title is required' }
  const title = value.trim().slice(0, CHAT_TITLE_MAX)
  if (!title) return { error: 'Give the conversation a name.' }
  return { title }
}

export function validateMessageText(body: unknown): { text: string } | { error: string } {
  const value = (body ?? {}) as Record<string, unknown>
  if (typeof value.text !== 'string') return { error: 'text is required' }
  const text = value.text.trim()
  if (!text) return { error: 'Type something to send.' }
  if (text.length > MESSAGE_MAX_CHARS) {
    return { error: `That message is too long (${MESSAGE_MAX_CHARS} characters max). Send it in pieces.` }
  }
  return { text }
}

/** Library off (no database, no bucket) is a 503 everywhere here, because
 *  every route reads or writes the library store. */
function libraryDown(res: Response, needsBucket = false): boolean {
  if (isLibraryEnabled() && (!needsBucket || isBucketEnabled())) return false
  res.status(503).json({ error: 'library unavailable' })
  return true
}

// --- Threads -------------------------------------------------------------------

router.get(PATH_PREFIX, requireInternalUser, internalRateLimit, privateNoCache, async (_req, res) => {
  if (libraryDown(res)) return
  const chats = await listChats(userOf(res).id)
  res.json({ chats: chats.map(publicChat) })
})

/**
 * A new thread. `message` is optional and is used ONLY to name the thread —
 * sending it is a separate call, so there is exactly one path by which a
 * message reaches the model and one place it is stored.
 */
router.post(PATH_PREFIX, requireInternalUser, internalRateLimit, async (req, res) => {
  if (libraryDown(res)) return
  const body = (req.body ?? {}) as { title?: unknown; message?: unknown }
  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title.trim().slice(0, CHAT_TITLE_MAX)
      : typeof body.message === 'string' && body.message.trim()
        ? titleFromMessage(body.message)
        : UNTITLED_CHAT
  const chat = await createChat(userOf(res).id, title)
  res.status(201).json({ chat: publicChat(chat) })
})

router.get(`${PATH_PREFIX}/:id`, requireInternalUser, internalRateLimit, privateNoCache, async (req, res) => {
  if (libraryDown(res)) return
  const chatId = chatIdOf(req.params.id)
  const chat = chatId === null ? null : await getChat(chatId, userOf(res).id)
  if (!chat) return notFound(res)
  const messages = await listMessages(chat.id)
  res.json({ chat: publicChat(chat), messages: messages.map(publicMessage) })
})

router.patch(`${PATH_PREFIX}/:id`, requireInternalUser, internalRateLimit, async (req, res) => {
  if (libraryDown(res)) return
  const parsed = validateTitle((req.body as { title?: unknown } | undefined)?.title)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  const chatId = chatIdOf(req.params.id)
  const chat = chatId === null ? null : await renameChat(chatId, userOf(res).id, parsed.title)
  if (!chat) return notFound(res)
  res.json({ chat: publicChat(chat) })
})

router.delete(`${PATH_PREFIX}/:id`, requireInternalUser, internalRateLimit, async (req, res) => {
  if (libraryDown(res)) return
  const chatId = chatIdOf(req.params.id)
  const archived = chatId === null ? false : await archiveChat(chatId, userOf(res).id)
  if (!archived) return notFound(res)
  res.json({ archived: true })
})

// --- Sending a message ---------------------------------------------------------

router.post(
  `${PATH_PREFIX}/:id/messages`,
  requireInternalUser,
  internalRateLimit,
  dailyBudgetMiddleware,
  async (req, res) => {
    const clientIp = (res.locals.clientIp as string) || 'unknown'
    const reserved = (res.locals.budgetReservation as number) || 0
    const user = userOf(res)
    const start = Date.now()

    if (libraryDown(res, true)) {
      settleReservation(clientIp, reserved, 0)
      return
    }
    const parsed = validateMessageText(req.body)
    if ('error' in parsed) {
      settleReservation(clientIp, reserved, 0)
      res.status(400).json({ error: parsed.error })
      return
    }
    const chatId = chatIdOf(req.params.id)
    const chat = chatId === null ? null : await getChat(chatId, user.id)
    if (!chat) {
      settleReservation(clientIp, reserved, 0)
      return notFound(res)
    }

    let history
    let userMessage
    try {
      // Compaction first, so the summary covers what came BEFORE this
      // question and the question itself is never summarised away.
      await compactIfNeeded(chat.id, { clientIp })
      history = await contextMessages(chat.id)
      userMessage = await appendMessage({ chatId: chat.id, role: 'user', text: parsed.text })
      if (!chat.title || chat.title === UNTITLED_CHAT) {
        await renameChat(chat.id, user.id, titleFromMessage(parsed.text))
      }
    } catch (err) {
      settleReservation(clientIp, reserved, 0)
      console.error('[chat] could not open the turn:', (err as Error)?.message || err)
      res.status(502).json({ error: 'That message could not be sent. Try again.' })
      return
    }

    // From here the answer streams: the request has succeeded, and anything
    // that goes wrong is an event in the stream rather than a status code.
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'private, no-store')
    // Never let a proxy hold the stream back waiting for a full buffer.
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const send = (event: ChatEvent | Record<string, unknown>): void => {
      if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`)
    }

    const record = (status: number, inputTokens: number, outputTokens: number): void =>
      recordUsage({
        ts: start,
        path: `${PATH_PREFIX}/:id/messages`,
        status,
        durationMs: Date.now() - start,
        inputTokens,
        outputTokens,
        tier: 'internal',
        themes: [],
        ipHash: hashIp(clientIp),
      })

    let result
    try {
      result = await runChatTurn({ chat, user, question: parsed.text, history, emit: send, clientIp })
    } catch (err) {
      // Not the model — our own retrieval or store. Ask calls this a 502 and
      // so do we; here it is the last event on the stream.
      settleReservation(clientIp, reserved, 0)
      record(502, 0, 0)
      console.error('[chat] turn failed:', (err as Error)?.message || err)
      send({ type: 'error', error: 'That answer could not be put together. Try again.' })
      res.end()
      return
    }

    settleReservation(clientIp, reserved, result.usedTokens)
    record(result.failure ? 503 : 200, result.inputTokens, result.outputTokens)

    const answer = result.failure ? MODEL_UNAVAILABLE : result.answer
    const assistant = await appendMessage({
      chatId: chat.id,
      role: 'assistant',
      text: answer,
      toolCalls: result.toolCalls,
      citations: result.citations,
      meta: result.failure ? { failed: result.failure.code } : {},
    })

    if (result.failure) {
      // The honesty line is the answer, and it is stored as one so the thread
      // reads truthfully later. Only an admin is told which of the four
      // failures it was — nobody else can act on it (P5-75).
      send({ type: 'text', text: answer })
      send({
        type: 'error',
        error: MODEL_UNAVAILABLE,
        ...(user.role === 'admin' ? { reason: result.failure.code } : {}),
        messageId: assistant.id,
      })
      res.end()
      return
    }

    if (result.citations.length) send({ type: 'citations', citations: result.citations })
    send({ type: 'done', chatId: chat.id, messageId: assistant.id, userMessageId: userMessage.id })
    res.end()
  },
)

// --- Confirming a proposed write -----------------------------------------------

router.post(
  `${PATH_PREFIX}/:id/actions/:actionId/confirm`,
  requireInternalUser,
  internalRateLimit,
  async (req, res) => {
    if (libraryDown(res, true)) return
    const user = userOf(res)
    const chatId = chatIdOf(req.params.id)
    const chat = chatId === null ? null : await getChat(chatId, user.id)
    if (!chat) return notFound(res)

    const actionId = String(req.params.actionId ?? '')
    if (!actionId || actionId.length > 64) return notFound(res)

    const outcome = await confirmAction({ chat, user, actionId, clientIp: req.ip })
    if (!outcome.ok) {
      res.status(outcome.status).json({
        error: outcome.error,
        ...(outcome.action ? { action: outcome.action } : {}),
        ...(outcome.message ? { message: publicMessage(outcome.message) } : {}),
      })
      return
    }
    res.json({ action: outcome.action, message: publicMessage(outcome.message) })
  },
)

export default router
