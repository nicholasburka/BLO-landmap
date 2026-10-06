import { libraryQuery } from './libraryDb.js'
import type { AskSource } from './askKb.js'

/**
 * The store behind Chat (P6-7a): threads and their messages.
 *
 * Everything here is keyed by (chat id, user id). A thread belongs to one
 * person — nobody else can read it, admins included in this phase — and the
 * only way to reach one is through a lookup that carries the owner, so an id
 * guessed from another account's URL is a 404 rather than a leak.
 *
 * The loop that answers a message lives in services/chatLoop.ts; this file
 * knows only how a conversation is written down.
 */

/**
 * `summary` is the compaction message (services/chatLoop.ts): one message
 * standing in for the turns before it once a thread runs long. It is a role
 * rather than a flag because the client renders it as its own thing — "what
 * came before, in short" — and the model reads it in place of what it covers.
 */
export type ChatRole = 'user' | 'assistant' | 'tool' | 'summary'

/**
 * One thing the assistant did in a turn, as the thread remembers it.
 *
 * A read is recorded after it ran. A write is recorded BEFORE it runs, as
 * `proposed`, with the arguments the model asked for — that record is what
 * the confirm route executes, so the write that happens is the write the
 * person was shown and nothing else.
 */
export interface ChatToolCall {
  /** Stable within the thread; the confirm route addresses an action by it. */
  id: string
  tool: string
  kind: 'read' | 'write'
  status: 'done' | 'failed' | 'proposed' | 'confirmed'
  /** One line for the reader: "Searched the library for … · 6 results". */
  summary: string
  /** Writes only: what would run. Kept so confirming cannot change it. */
  args?: Record<string, unknown>
  /** Writes only: what running it returned (slug, url, …). */
  result?: Record<string, unknown>
}

/** The numbered sources of one answer — the same shape Ask cites with. */
export type ChatCitation = AskSource

export interface ChatRow {
  id: number
  userId: number
  title: string
  createdAt: string
  updatedAt: string
  archived: boolean
}

export interface ChatMessageRow {
  id: number
  chatId: number
  role: ChatRole
  text: string
  toolCalls: ChatToolCall[]
  citations: ChatCitation[]
  meta: Record<string, unknown>
  createdAt: string
}

/** Thread titles are a line, not a paragraph. */
export const CHAT_TITLE_MAX = 120
/** What a person may type in one message. Longer than Ask's question cap
 *  (500) because a chat turn can carry a pasted paragraph to work from, and
 *  far short of anything that would blow the prompt budget on its own. */
export const MESSAGE_MAX_CHARS = 2_000
/** Threads listed on the left of the page. */
export const CHAT_LIST_LIMIT = 100

export const UNTITLED_CHAT = 'New chat'

/** A thread's name, from the first thing asked in it: one line, clipped on a
 *  word where possible so it reads as a title rather than a cut sentence. */
export function titleFromMessage(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return UNTITLED_CHAT
  if (flat.length <= CHAT_TITLE_MAX) return flat
  const cut = flat.slice(0, CHAT_TITLE_MAX)
  const space = cut.lastIndexOf(' ')
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function asJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function toChat(row: Record<string, any>): ChatRow {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    title: row.title ?? '',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archived: row.archived === true,
  }
}

function toMessage(row: Record<string, any>): ChatMessageRow {
  return {
    id: Number(row.id),
    chatId: Number(row.chat_id),
    role: row.role as ChatRole,
    text: row.text ?? '',
    toolCalls: asJson<ChatToolCall[]>(row.tool_calls, []),
    citations: asJson<ChatCitation[]>(row.citations, []),
    meta: asJson<Record<string, unknown>>(row.meta, {}),
    createdAt: new Date(row.created_at).toISOString(),
  }
}

const CHAT_COLUMNS = 'id, user_id, title, created_at, updated_at, archived'
const MESSAGE_COLUMNS = 'id, chat_id, role, text, tool_calls, citations, meta, created_at'

export async function createChat(userId: number, title: string): Promise<ChatRow> {
  const res = await libraryQuery(
    `INSERT INTO library_chats (user_id, title) VALUES ($1, $2) RETURNING ${CHAT_COLUMNS}`,
    [userId, title.slice(0, CHAT_TITLE_MAX)],
  )
  return toChat(res.rows[0])
}

/** The person's own threads, most recently used first. */
export async function listChats(userId: number, limit = CHAT_LIST_LIMIT): Promise<ChatRow[]> {
  const res = await libraryQuery(
    `SELECT ${CHAT_COLUMNS} FROM library_chats
      WHERE user_id = $1 AND archived = FALSE
      ORDER BY updated_at DESC, id DESC
      LIMIT $2`,
    [userId, limit],
  )
  return res.rows.map(toChat)
}

/**
 * One thread, or null. The owner is part of the lookup, not a check made
 * afterwards — there is no way to call this and forget it.
 */
export async function getChat(chatId: number, userId: number): Promise<ChatRow | null> {
  if (!Number.isInteger(chatId)) return null
  const res = await libraryQuery(
    `SELECT ${CHAT_COLUMNS} FROM library_chats WHERE id = $1 AND user_id = $2 AND archived = FALSE`,
    [chatId, userId],
  )
  return res.rows[0] ? toChat(res.rows[0]) : null
}

export async function renameChat(chatId: number, userId: number, title: string): Promise<ChatRow | null> {
  const res = await libraryQuery(
    `UPDATE library_chats SET title = $3, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND archived = FALSE
      RETURNING ${CHAT_COLUMNS}`,
    [chatId, userId, title.slice(0, CHAT_TITLE_MAX)],
  )
  return res.rows[0] ? toChat(res.rows[0]) : null
}

/** Archive, never delete: the thread holds the record of every write that
 *  was run from it. It stops being listed and stops being readable. */
export async function archiveChat(chatId: number, userId: number): Promise<boolean> {
  const res = await libraryQuery(
    `UPDATE library_chats SET archived = TRUE, updated_at = now()
      WHERE id = $1 AND user_id = $2 AND archived = FALSE
      RETURNING id`,
    [chatId, userId],
  )
  return res.rows.length > 0
}

/** Bump the thread so the list orders by "last used". */
export async function touchChat(chatId: number): Promise<void> {
  await libraryQuery(`UPDATE library_chats SET updated_at = now() WHERE id = $1`, [chatId])
}

export interface NewChatMessage {
  chatId: number
  role: ChatRole
  text: string
  toolCalls?: ChatToolCall[]
  citations?: ChatCitation[]
  meta?: Record<string, unknown>
}

export async function appendMessage(message: NewChatMessage): Promise<ChatMessageRow> {
  const res = await libraryQuery(
    `INSERT INTO library_chat_messages (chat_id, role, text, tool_calls, citations, meta)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      message.chatId,
      message.role,
      message.text,
      JSON.stringify(message.toolCalls ?? []),
      JSON.stringify(message.citations ?? []),
      JSON.stringify(message.meta ?? {}),
    ],
  )
  await touchChat(message.chatId)
  return toMessage(res.rows[0])
}

/** Every message in a thread, oldest first — what the page shows. */
export async function listMessages(chatId: number): Promise<ChatMessageRow[]> {
  const res = await libraryQuery(
    `SELECT ${MESSAGE_COLUMNS} FROM library_chat_messages WHERE chat_id = $1 ORDER BY id ASC`,
    [chatId],
  )
  return res.rows.map(toMessage)
}

/** Rewrite one message's tool calls — how a proposed write becomes a run one. */
export async function setToolCalls(messageId: number, toolCalls: ChatToolCall[]): Promise<void> {
  await libraryQuery(`UPDATE library_chat_messages SET tool_calls = $2 WHERE id = $1`, [
    messageId,
    JSON.stringify(toolCalls),
  ])
}

/**
 * The messages the MODEL sees, which is not always the whole thread: once a
 * thread has been compacted, the last `summary` stands in for everything it
 * covers, and only what came after it is replayed in full.
 */
export async function contextMessages(chatId: number): Promise<ChatMessageRow[]> {
  const all = await listMessages(chatId)
  for (let i = all.length - 1; i >= 0; i--) {
    const message = all[i]
    if (message.role !== 'summary') continue
    const through = Number(message.meta.throughMessageId ?? 0)
    return [message, ...all.filter(m => m.id > through && m.id !== message.id)]
  }
  return all
}

/** Turns since the last compaction — a "turn" being one thing the person
 *  said, which is what the thirty-turn ceiling counts. */
export function countTurns(messages: ChatMessageRow[]): number {
  return messages.filter(m => m.role === 'user').length
}

/** Find a proposed action anywhere in the thread, with the message holding
 *  it: the confirm route takes an action id and nothing else. */
export function findAction(
  messages: ChatMessageRow[],
  actionId: string,
): { message: ChatMessageRow; action: ChatToolCall } | null {
  for (const message of messages) {
    const action = message.toolCalls.find(call => call.id === actionId)
    if (action) return { message, action }
  }
  return null
}
