import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/apiBase', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apiBase')>()
  return { ...actual, internalFetch: vi.fn() }
})

import { internalFetch } from '@/lib/apiBase'
import { AskRequestError } from '@/lib/ask'
import {
  listChats,
  createChat,
  getChat,
  renameChat,
  archiveChat,
  confirmAction,
  sendMessage,
  chatErrorMessage,
  isAbortError,
  openTargetFor,
  toAppPath,
  ChatStreamError,
  LIBRARY_DOWN_TEXT,
  CHAT_NOT_FOUND_TEXT,
  STREAM_CUT_TEXT,
  type ChatEvent,
  type ChatMessage,
} from '@/lib/libraryChat'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

/** A 200 whose body hands back exactly these chunks — split wherever the
 *  caller chose, including mid-line, which is the point of the parser. */
function streamResponse(chunks: string[]): { res: Response; released: () => boolean } {
  const encoder = new TextEncoder()
  let sent = 0
  let released = false
  const reader = {
    read: async () =>
      sent < chunks.length
        ? { value: encoder.encode(chunks[sent++]), done: false }
        : { value: undefined, done: true },
    releaseLock: () => {
      released = true
    },
  }
  return {
    res: { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response,
    released: () => released,
  }
}

const CITATION = {
  n: 1,
  slug: 'georgia',
  kind: 'wiki',
  title: 'Georgia',
  href: '/wiki/georgia',
  snippet: 'Land trusts in Georgia.',
  cited: true,
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe('thread routes', () => {
  it('lists threads', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, { chats: [{ id: 1, title: 'Shelby', createdAt: 'a', updatedAt: 'b' }] }))
    await expect(listChats()).resolves.toEqual([{ id: 1, title: 'Shelby', createdAt: 'a', updatedAt: 'b' }])
    expect(mockedFetch).toHaveBeenCalledWith('/api/chats', {})
  })

  it('creates a thread, passing the message only to name it', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(201, { chat: { id: 7, title: 'Shelby follow-up' } }))
    const chat = await createChat({ message: 'what is in Shelby?' })
    expect(chat.id).toBe(7)
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/chats')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ message: 'what is in Shelby?' })
  })

  it('reads a thread with its messages', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, { chat: { id: 3 }, messages: [{ id: 1, role: 'user' }] }))
    const { chat, messages } = await getChat(3)
    expect(chat.id).toBe(3)
    expect(messages).toHaveLength(1)
    expect(mockedFetch).toHaveBeenCalledWith('/api/chats/3', {})
  })

  it('renames and archives', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, { chat: { id: 3, title: 'Renamed' } }))
    await expect(renameChat(3, 'Renamed')).resolves.toMatchObject({ title: 'Renamed' })
    expect(mockedFetch.mock.calls[0][1]?.method).toBe('PATCH')

    mockedFetch.mockResolvedValue(jsonResponse(200, { archived: true }))
    await expect(archiveChat(3)).resolves.toBeUndefined()
    expect(mockedFetch.mock.calls[1][1]?.method).toBe('DELETE')
  })

  it("turns the server's bare 'library unavailable' into a sentence", async () => {
    mockedFetch.mockResolvedValue(jsonResponse(503, { error: 'library unavailable' }))
    await expect(listChats()).rejects.toMatchObject({ status: 503, message: LIBRARY_DOWN_TEXT })
  })

  it('reports a request that never left the building as offline', async () => {
    mockedFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(listChats()).rejects.toMatchObject({ status: 0 })
  })
})

describe('chatErrorMessage', () => {
  it('says a missing thread is gone rather than "not found"', () => {
    expect(chatErrorMessage(new AskRequestError(404, 'not found'))).toBe(CHAT_NOT_FOUND_TEXT)
  })

  it("passes the budget refusal's own sentence through (Ask's helper)", () => {
    const err = new AskRequestError(503, "We've hit today's usage cap. Please try again tomorrow.")
    expect(chatErrorMessage(err)).toBe("We've hit today's usage cap. Please try again tomorrow.")
  })

  it('tells an admin which failure it was, and a member only the sentence', () => {
    const err = new ChatStreamError('The answering service is unavailable right now. Please try again in a minute.', 'no-key')
    expect(chatErrorMessage(err, { isAdmin: true })).toBe('The answering model is not configured on the server.')
    expect(chatErrorMessage(err)).toContain('unavailable right now')
  })

  it('says something plain for an error it has never seen', () => {
    expect(chatErrorMessage(new Error('kaboom'))).toBe('Something went wrong. Please try again.')
  })
})

describe('sendMessage', () => {
  it('posts the text and reassembles events split across chunk boundaries', async () => {
    // The `text` event is deliberately cut in half by the chunk boundary.
    const { res, released } = streamResponse([
      '{"type":"text","text":"Two orga',
      'nizations [1]."}\n{"type":"citations","citations":[',
      JSON.stringify(CITATION),
      ']}\n{"type":"done","chatId":4,"messageId":9,"userMessageId":8}\n',
    ])
    mockedFetch.mockResolvedValue(res)

    const events: ChatEvent[] = []
    const done = await sendMessage(4, 'what is in Shelby?', e => events.push(e))

    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/chats/4/messages')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'what is in Shelby?' })

    expect(events.map(e => e.type)).toEqual(['text', 'citations', 'done'])
    expect(events[0]).toEqual({ type: 'text', text: 'Two organizations [1].' })
    expect(done).toEqual({ type: 'done', chatId: 4, messageId: 9, userMessageId: 8 })
    expect(released()).toBe(true)
  })

  it('reads a terminal event that arrives without a trailing newline', async () => {
    const { res } = streamResponse(['{"type":"done","chatId":1,"messageId":2}'])
    mockedFetch.mockResolvedValue(res)
    await expect(sendMessage(1, 'hi', () => {})).resolves.toMatchObject({ messageId: 2 })
  })

  it('passes tool calls and proposals through in order', async () => {
    const started = { id: 'c1', tool: 'search_library', kind: 'read', status: 'running', summary: 'Searched the library for “land”' }
    const finished = { ...started, status: 'done', summary: 'Searched the library for “land” · 6 results' }
    const action = { id: 'a1', tool: 'create_note', kind: 'write', status: 'proposed', summary: 'Write a note “Shelby”', args: { title: 'Shelby' } }
    const { res } = streamResponse([
      `${JSON.stringify({ type: 'tool_call', phase: 'started', call: started })}\n`,
      `${JSON.stringify({ type: 'tool_call', phase: 'finished', call: finished })}\n`,
      `${JSON.stringify({ type: 'proposed_action', action })}\n`,
      '{"type":"done","chatId":1,"messageId":2}\n',
    ])
    mockedFetch.mockResolvedValue(res)
    const events: ChatEvent[] = []
    await sendMessage(1, 'hi', e => events.push(e))
    expect(events.map(e => e.type)).toEqual(['tool_call', 'tool_call', 'proposed_action', 'done'])
  })

  it('skips a blank line and an event type it has never heard of', async () => {
    const { res } = streamResponse(['\n{"type":"heartbeat"}\nnot json\n{"type":"done","chatId":1,"messageId":2}\n'])
    mockedFetch.mockResolvedValue(res)
    const events: ChatEvent[] = []
    await expect(sendMessage(1, 'hi', e => events.push(e))).resolves.toMatchObject({ messageId: 2 })
    expect(events.map(e => e.type)).toEqual(['done'])
  })

  it('rejects on an error event, keeping the reason and the stored message id', async () => {
    const { res } = streamResponse([
      '{"type":"text","text":"The answering service is unavailable right now. Please try again in a minute."}\n',
      '{"type":"error","error":"The answering service is unavailable right now. Please try again in a minute.","reason":"rate-limited","messageId":12}\n',
    ])
    mockedFetch.mockResolvedValue(res)
    const events: ChatEvent[] = []
    // The honesty line arrives as text FIRST and is a real answer — the page
    // keeps it and the rejection only tells it why.
    await expect(sendMessage(1, 'hi', e => events.push(e))).rejects.toMatchObject({
      name: 'ChatStreamError',
      status: 503,
      reason: 'rate-limited',
      messageId: 12,
    })
    expect(events.map(e => e.type)).toEqual(['text'])
  })

  it('rejects a non-2xx with the server sentence before the stream starts', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(400, { error: 'That message is too long (2000 characters max). Send it in pieces.' }))
    await expect(sendMessage(1, 'x'.repeat(3000), () => {})).rejects.toMatchObject({
      status: 400,
      message: 'That message is too long (2000 characters max). Send it in pieces.',
    })
  })

  it('rejects a stream that ends with neither done nor error', async () => {
    const { res } = streamResponse(['{"type":"text","text":"half an ans"}\n'])
    mockedFetch.mockResolvedValue(res)
    await expect(sendMessage(1, 'hi', () => {})).rejects.toMatchObject({ status: 502, message: STREAM_CUT_TEXT })
  })

  it('passes the abort signal through and lets an abort reject as itself', async () => {
    const abort = new DOMException('The user aborted a request.', 'AbortError')
    mockedFetch.mockRejectedValue(abort)
    const controller = new AbortController()
    await expect(sendMessage(1, 'hi', () => {}, controller.signal)).rejects.toBe(abort)
    expect(mockedFetch.mock.calls[0][1]?.signal).toBe(controller.signal)
    expect(isAbortError(abort)).toBe(true)
    expect(isAbortError(new Error('nope'))).toBe(false)
  })
})

describe('confirmAction', () => {
  it('runs a proposal and returns the action and the message to append', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse(200, { action: { id: 'a1', status: 'confirmed' }, message: { id: 20, role: 'tool', text: 'done.' } }),
    )
    const result = await confirmAction(5, 'a1')
    expect(result).toMatchObject({ ok: true, action: { status: 'confirmed' }, message: { id: 20 } })
    expect(mockedFetch).toHaveBeenCalledWith('/api/chats/5/actions/a1/confirm', { method: 'POST' })
  })

  it('keeps the message a refused write left in the thread (400)', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse(400, { error: 'There is no page by that slug.', action: { id: 'a1', status: 'failed' }, message: { id: 21 } }),
    )
    const result = await confirmAction(5, 'a1')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('There is no page by that slug.')
    expect(result.action).toMatchObject({ status: 'failed' })
    expect(result.message).toMatchObject({ id: 21 })
  })

  it('reports a proposal that is already dealt with (409) without a message', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(409, { error: 'That action has already been dealt with.', action: { id: 'a1', status: 'confirmed' } }))
    const result = await confirmAction(5, 'a1')
    expect(result).toMatchObject({ ok: false, error: 'That action has already been dealt with.' })
    expect(result.message).toBeUndefined()
  })

  it('says a 404 plainly rather than "not found"', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(404, { error: 'not found' }))
    await expect(confirmAction(5, 'gone')).resolves.toMatchObject({
      ok: false,
      error: 'That proposal is not in this conversation any more.',
    })
  })
})

describe('openTargetFor', () => {
  const base: Pick<ChatMessage, 'text' | 'toolCalls' | 'citations'> = { text: '', toolCalls: [], citations: [] }

  it('offers nothing when the answer produced no analysis', () => {
    expect(openTargetFor({ ...base, text: 'Two organizations [1].', citations: [CITATION] })).toBeNull()
  })

  it('prefers a saved view a confirmed write just created', () => {
    const target = openTargetFor({
      ...base,
      text: 'Saved it. See also [the page](/wiki/georgia).',
      toolCalls: [
        { id: 'a1', tool: 'save_view', kind: 'write', status: 'confirmed', summary: 'Save the map view', result: { href: `${window.location.origin}/?view=shelby` } },
      ],
    })
    expect(target).toEqual({ href: '/?view=shelby', label: 'Open the saved view' })
  })

  it('takes a cited place report', () => {
    const target = openTargetFor({
      ...base,
      citations: [{ ...CITATION, kind: 'place', href: '/place?address=55+Trinity+Ave+SW' }],
    })
    expect(target).toEqual({ href: '/place?address=55+Trinity+Ave+SW', label: 'Open the report' })
  })

  it('falls back to a link the answer itself wrote, skipping ordinary pages', () => {
    const target = openTargetFor({
      ...base,
      text: 'I read [the page](/wiki/georgia) and ran [the comparison](/compare?geoids=13121,13089).',
    })
    expect(target).toEqual({ href: '/compare?geoids=13121,13089', label: 'Open the comparison' })
  })

  it('never offers an off-site link, however its path reads', () => {
    expect(openTargetFor({ ...base, text: 'See [this](https://example.com/place?a=1).' })).toBeNull()
    expect(toAppPath('https://example.com/place')).toBeNull()
    expect(toAppPath('//evil.example/place')).toBeNull()
    expect(toAppPath('/place?a=1')).toBe('/place?a=1')
  })

  it('ignores a write that was only proposed — nothing has happened yet', () => {
    expect(
      openTargetFor({
        ...base,
        toolCalls: [{ id: 'a1', tool: 'save_view', kind: 'write', status: 'proposed', summary: 'Save the map view', args: { name: 'Shelby' } }],
      }),
    ).toBeNull()
  })
})
