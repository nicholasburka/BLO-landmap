import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

/**
 * P6-7a store: threads, messages and the two things the loop asks of them —
 * which messages the model still has to read after a compaction, and which
 * proposed action a confirm request is talking about.
 *
 * Ownership is asserted on every path that takes a chat id, because "another
 * account's thread is a 404" is the whole security model of this feature.
 */

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const {
  appendMessage,
  archiveChat,
  contextMessages,
  countTurns,
  createChat,
  findAction,
  getChat,
  listChats,
  listMessages,
  renameChat,
  setToolCalls,
  titleFromMessage,
  CHAT_TITLE_MAX,
  UNTITLED_CHAT,
} = await import('./libraryChat.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let maria = 0
let nick = 0

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  const users = await libraryQuery(
    `INSERT INTO library_users (username, password_hash, role)
     VALUES ('maria', 'x', 'internal'), ('nick', 'x', 'admin') RETURNING id, username`,
  )
  maria = Number(users.rows.find(r => r.username === 'maria').id)
  nick = Number(users.rows.find(r => r.username === 'nick').id)
})

afterEach(async () => {
  await closeLibraryDb()
})

describe('titleFromMessage', () => {
  it('names a thread after the first thing asked in it', () => {
    expect(titleFromMessage('  who owns   land in Macon County?  ')).toBe('who owns land in Macon County?')
  })

  it('clips a long one on a word and marks the cut', () => {
    const title = titleFromMessage(`${'word '.repeat(60)}end`)
    expect(title.length).toBeLessThanOrEqual(CHAT_TITLE_MAX + 1)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/ …$/)
  })

  it('falls back to a plain name for an empty message', () => {
    expect(titleFromMessage('   ')).toBe(UNTITLED_CHAT)
  })
})

describe('threads', () => {
  it('lists mine, most recently used first, and never anybody else’s', async () => {
    const first = await createChat(maria, 'Land loss')
    const second = await createChat(maria, 'Flood risk')
    await createChat(nick, 'Not yours')

    const mine = await listChats(maria)
    expect(mine.map(c => c.title)).toEqual(['Flood risk', 'Land loss'])

    // Using the older thread moves it to the top.
    await appendMessage({ chatId: first.id, role: 'user', text: 'and the parcels?' })
    expect((await listChats(maria)).map(c => c.title)).toEqual(['Land loss', 'Flood risk'])
    expect((await listChats(nick)).map(c => c.title)).toEqual(['Not yours'])
    expect(second.userId).toBe(maria)
  })

  it('is a null lookup for another account, a bad id, and an archived thread', async () => {
    const chat = await createChat(maria, 'Land loss')
    expect(await getChat(chat.id, nick)).toBeNull()
    expect(await getChat(1.5, maria)).toBeNull()
    expect(await getChat(999_999, maria)).toBeNull()
    expect((await getChat(chat.id, maria))?.title).toBe('Land loss')

    expect(await archiveChat(chat.id, nick)).toBe(false)
    expect(await archiveChat(chat.id, maria)).toBe(true)
    expect(await getChat(chat.id, maria)).toBeNull()
    expect(await listChats(maria)).toEqual([])
    // Archived, not deleted: the record of what was run from it survives.
    const rows = await libraryQuery(`SELECT archived FROM library_chats WHERE id = $1`, [chat.id])
    expect(rows.rows[0].archived).toBe(true)
  })

  it('renames only my own thread', async () => {
    const chat = await createChat(maria, 'Land loss')
    expect(await renameChat(chat.id, nick, 'Hijacked')).toBeNull()
    expect((await renameChat(chat.id, maria, 'Heirs property'))?.title).toBe('Heirs property')
  })
})

describe('messages', () => {
  it('round-trips tool calls, citations and meta, oldest first', async () => {
    const chat = await createChat(maria, 'Land loss')
    await appendMessage({ chatId: chat.id, role: 'user', text: 'how many organizations in Georgia?' })
    const assistant = await appendMessage({
      chatId: chat.id,
      role: 'assistant',
      text: 'Two [1].',
      toolCalls: [{ id: 'a1', tool: 'query_dataset', kind: 'read', status: 'done', summary: 'Queried the table · 2 rows' }],
      citations: [{ n: 1, slug: 'organizations', kind: 'dataset', title: 'Organizations', href: '/library/organizations', snippet: 'x', cited: true }],
      meta: { failed: 'rate-limited' },
    })

    const messages = await listMessages(chat.id)
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].toolCalls[0].summary).toBe('Queried the table · 2 rows')
    expect(messages[1].citations[0].slug).toBe('organizations')
    expect(messages[1].meta.failed).toBe('rate-limited')

    await setToolCalls(assistant.id, [
      { id: 'a1', tool: 'create_note', kind: 'write', status: 'confirmed', summary: 'Write a note', result: { slug: 'n' } },
    ])
    expect((await listMessages(chat.id))[1].toolCalls[0].status).toBe('confirmed')
  })

  it('counts turns and finds a proposed action by its id', async () => {
    const chat = await createChat(maria, 'Land loss')
    await appendMessage({ chatId: chat.id, role: 'user', text: 'one' })
    await appendMessage({
      chatId: chat.id,
      role: 'assistant',
      text: 'I can write that down.',
      toolCalls: [{ id: 'act-1', tool: 'create_note', kind: 'write', status: 'proposed', summary: 'Write a note “X”', args: { title: 'X' } }],
    })
    await appendMessage({ chatId: chat.id, role: 'user', text: 'two' })

    const messages = await listMessages(chat.id)
    expect(countTurns(messages)).toBe(2)
    expect(findAction(messages, 'act-1')?.action.tool).toBe('create_note')
    expect(findAction(messages, 'act-1')?.message.role).toBe('assistant')
    expect(findAction(messages, 'nope')).toBeNull()
  })
})

describe('contextMessages', () => {
  it('is the whole thread until it has been compacted', async () => {
    const chat = await createChat(maria, 'Land loss')
    await appendMessage({ chatId: chat.id, role: 'user', text: 'one' })
    await appendMessage({ chatId: chat.id, role: 'assistant', text: 'first answer' })
    expect((await contextMessages(chat.id)).map(m => m.text)).toEqual(['one', 'first answer'])
  })

  it('after a compaction is the summary plus what came after it', async () => {
    const chat = await createChat(maria, 'Land loss')
    const first = await appendMessage({ chatId: chat.id, role: 'user', text: 'one' })
    const second = await appendMessage({ chatId: chat.id, role: 'assistant', text: 'first answer' })
    await appendMessage({ chatId: chat.id, role: 'summary', text: 'They asked about one.', meta: { throughMessageId: second.id } })
    await appendMessage({ chatId: chat.id, role: 'user', text: 'two' })

    const context = await contextMessages(chat.id)
    expect(context.map(m => m.text)).toEqual(['They asked about one.', 'two'])
    expect(countTurns(context)).toBe(1)
    // The thread itself still holds everything — only the model's view shrank.
    expect((await listMessages(chat.id)).map(m => m.id)).toContain(first.id)
  })
})
