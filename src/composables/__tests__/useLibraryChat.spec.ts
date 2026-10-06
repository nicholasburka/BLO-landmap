import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'

vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'dev', role: 'admin' } } }),
  registerLogoutHook: vi.fn(),
}))

vi.mock('@/lib/libraryChat', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryChat')>()
  return {
    ...actual,
    listChats: vi.fn(),
    createChat: vi.fn(),
    getChat: vi.fn(),
    renameChat: vi.fn(),
    archiveChat: vi.fn(),
    confirmAction: vi.fn(),
    sendMessage: vi.fn(),
  }
})

import {
  listChats,
  createChat,
  getChat,
  renameChat,
  archiveChat,
  confirmAction,
  sendMessage,
  ChatStreamError,
  type Chat,
  type ChatEvent,
  type ChatMessage,
  type ChatToolCall,
} from '@/lib/libraryChat'
import { AskRequestError } from '@/lib/ask'
import { useLibraryChat, actionStateOf } from '../useLibraryChat'

const mockedList = vi.mocked(listChats)
const mockedCreate = vi.mocked(createChat)
const mockedGet = vi.mocked(getChat)
const mockedRename = vi.mocked(renameChat)
const mockedArchive = vi.mocked(archiveChat)
const mockedConfirm = vi.mocked(confirmAction)
const mockedSend = vi.mocked(sendMessage)

const THREAD: Chat = { id: 1, title: 'Shelby follow-up', createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' }
const OTHER: Chat = { id: 2, title: 'Flood risk', createdAt: '2026-09-19T10:00:00Z', updatedAt: '2026-09-19T10:00:00Z' }

const PROPOSAL: ChatToolCall = {
  id: 'a1',
  tool: 'create_note',
  kind: 'write',
  status: 'proposed',
  summary: 'Write a note “Shelby follow-up”',
  args: { title: 'Shelby follow-up', body: 'Three parcels.' },
}

/** `sendMessage` as the page sees it: a scripted list of events, then done. */
function streams(events: ChatEvent[], done = { type: 'done' as const, chatId: 1, messageId: 9, userMessageId: 8 }) {
  mockedSend.mockImplementation(async (_chatId, _text, onEvent) => {
    for (const event of events) onEvent(event)
    return done
  })
}

/** An open thread with nothing said in it yet. */
async function openThread(chat = THREAD, messages: ChatMessage[] = []) {
  mockedList.mockResolvedValue([chat])
  mockedGet.mockResolvedValue({ chat, messages })
  const chat$ = useLibraryChat()
  await chat$.loadThreads()
  await chat$.openThread(chat.id)
  return chat$
}

beforeEach(() => {
  for (const mock of [mockedList, mockedCreate, mockedGet, mockedRename, mockedArchive, mockedConfirm, mockedSend]) mock.mockReset()
  mockedList.mockResolvedValue([])
})

describe('threads', () => {
  it('lists threads and opens one with its stored messages', async () => {
    const stored: ChatMessage[] = [
      { id: 1, role: 'user', text: 'what is in Shelby?', toolCalls: [], citations: [], createdAt: 'a' },
      { id: 2, role: 'assistant', text: 'Three parcels [1].', toolCalls: [], citations: [], createdAt: 'b' },
    ]
    const chat$ = await openThread(THREAD, stored)
    expect(chat$.threads.value).toEqual([THREAD])
    expect(chat$.currentChat.value).toEqual(THREAD)
    expect(chat$.messages.value).toHaveLength(2)
    expect(chat$.messagesLoading.value).toBe(false)
  })

  it('starts a new thread and puts it at the top of the list', async () => {
    mockedList.mockResolvedValue([OTHER])
    mockedCreate.mockResolvedValue(THREAD)
    const chat$ = useLibraryChat()
    await chat$.loadThreads()
    await chat$.startThread()
    expect(mockedCreate).toHaveBeenCalledWith()
    expect(chat$.threads.value.map(t => t.id)).toEqual([1, 2])
    expect(chat$.currentChatId.value).toBe(1)
    expect(chat$.messages.value).toEqual([])
  })

  it('renames a thread in place', async () => {
    const chat$ = await openThread()
    mockedRename.mockResolvedValue({ ...THREAD, title: 'Shelby parcels' })
    await chat$.rename(1, '  Shelby parcels  ')
    expect(mockedRename).toHaveBeenCalledWith(1, 'Shelby parcels')
    expect(chat$.threads.value[0].title).toBe('Shelby parcels')
  })

  it('will not rename to nothing', async () => {
    const chat$ = await openThread()
    await chat$.rename(1, '   ')
    expect(mockedRename).not.toHaveBeenCalled()
  })

  it('archives a thread and closes it when it was the open one', async () => {
    const chat$ = await openThread()
    mockedArchive.mockResolvedValue(undefined)
    await chat$.archive(1)
    expect(chat$.threads.value).toEqual([])
    expect(chat$.currentChatId.value).toBeNull()
    expect(chat$.messages.value).toEqual([])
  })

  it('says something a person can read when the library is down', async () => {
    mockedList.mockRejectedValue(new AskRequestError(503, 'The library is not available right now. Please try again in a minute.'))
    const chat$ = useLibraryChat()
    await chat$.loadThreads()
    expect(chat$.threadsError.value).toContain('not available right now')
  })
})

describe('a turn', () => {
  it('shows the question at once and assembles the answer from text deltas', async () => {
    const chat$ = await openThread()
    streams([
      { type: 'text', text: 'Three parcels are in Shelby [1].' },
      { type: 'text', text: 'Two are wooded.' },
      {
        type: 'citations',
        citations: [{ n: 1, slug: 'parcels', kind: 'dataset', title: 'Parcels', href: '/library/parcels', snippet: 'One row per parcel.', cited: true }],
      },
    ])
    await chat$.send('  what is in Shelby?  ')

    expect(mockedSend).toHaveBeenCalledWith(1, 'what is in Shelby?', expect.any(Function), expect.any(Object))
    const [question, answer] = chat$.messages.value
    expect(question).toMatchObject({ id: 8, role: 'user', text: 'what is in Shelby?' })
    // Joined with a blank line, exactly as the server stores it.
    expect(answer.text).toBe('Three parcels are in Shelby [1].\n\nTwo are wooded.')
    expect(answer).toMatchObject({ id: 9, role: 'assistant', pending: false })
    expect(answer.citations).toHaveLength(1)
    expect(chat$.streaming.value).toBe(false)
  })

  it('renders the live text while the answer is still streaming', async () => {
    const chat$ = await openThread()
    let emit!: (event: ChatEvent) => void
    let finish!: () => void
    mockedSend.mockImplementation(
      (_chatId, _text, onEvent) =>
        new Promise(resolve => {
          emit = onEvent
          finish = () => resolve({ type: 'done', chatId: 1, messageId: 9, userMessageId: 8 })
        }),
    )
    const turn = chat$.send('what is in Shelby?')
    await nextTick()
    expect(chat$.streaming.value).toBe(true)
    expect(chat$.messages.value[1]).toMatchObject({ role: 'assistant', text: '', pending: true })

    emit({ type: 'text', text: 'Three parcels' })
    expect(chat$.messages.value[1].text).toBe('Three parcels')
    finish()
    await turn
    expect(chat$.streaming.value).toBe(false)
    expect(chat$.messages.value[1].pending).toBe(false)
  })

  it('turns a tool call from running into its finished one-line summary', async () => {
    const chat$ = await openThread()
    const started: ChatToolCall = { id: 'c1', tool: 'search_library', kind: 'read', status: 'running', summary: 'Searched the library for “Shelby”' }
    streams([
      { type: 'tool_call', phase: 'started', call: started },
      { type: 'tool_call', phase: 'finished', call: { ...started, status: 'done', summary: 'Searched the library for “Shelby” · 6 results' } },
      { type: 'text', text: 'Three parcels.' },
    ])
    await chat$.send('what is in Shelby?')
    const calls = chat$.messages.value[1].toolCalls
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ id: 'c1', status: 'done', summary: 'Searched the library for “Shelby” · 6 results' })
  })

  it('hangs a proposed write on the answer without running anything', async () => {
    const chat$ = await openThread()
    streams([{ type: 'proposed_action', action: PROPOSAL }, { type: 'text', text: 'I can write that note.' }])
    await chat$.send('note that down')
    expect(chat$.messages.value[1].toolCalls[0]).toMatchObject({ status: 'proposed' })
    expect(mockedConfirm).not.toHaveBeenCalled()
  })

  it('creates the thread when there is not one yet, naming it from the message', async () => {
    mockedCreate.mockResolvedValue(THREAD)
    streams([{ type: 'text', text: 'Three parcels.' }])
    const chat$ = useLibraryChat()
    await chat$.send('what is in Shelby?')
    expect(mockedCreate).toHaveBeenCalledWith({ message: 'what is in Shelby?' })
    expect(chat$.currentChatId.value).toBe(1)
    expect(chat$.messages.value).toHaveLength(2)
    // The first turn names an untitled thread server-side, so the list is re-read.
    expect(mockedList).toHaveBeenCalled()
  })

  it('ignores an empty message and a second send while one is streaming', async () => {
    const chat$ = await openThread()
    mockedSend.mockReturnValue(new Promise(() => {}))
    await chat$.send('   ')
    expect(mockedSend).not.toHaveBeenCalled()
    void chat$.send('first')
    await nextTick()
    await chat$.send('second')
    expect(mockedSend).toHaveBeenCalledTimes(1)
  })

  it('keeps the honesty line as the answer and tells an admin why (P5-75)', async () => {
    const chat$ = await openThread()
    const honesty = 'The answering service is unavailable right now. Please try again in a minute.'
    mockedSend.mockImplementation(async (_chatId, _text, onEvent) => {
      onEvent({ type: 'text', text: honesty })
      throw new ChatStreamError(honesty, 'no-key', 12)
    })
    await chat$.send('what is in Shelby?')
    expect(chat$.messages.value).toHaveLength(2)
    expect(chat$.messages.value[1]).toMatchObject({ id: 12, text: honesty, pending: false })
    expect(chat$.error.value).toBe('The answering model is not configured on the server.')
    expect(chat$.streaming.value).toBe(false)
  })

  it('takes the question back when the server stored nothing', async () => {
    const chat$ = await openThread()
    mockedSend.mockRejectedValue(new ChatStreamError('That answer could not be put together. Try again.'))
    await chat$.send('what is in Shelby?')
    expect(chat$.messages.value).toEqual([])
    expect(chat$.unsentText.value).toBe('what is in Shelby?')
    expect(chat$.error.value).toContain('could not be put together')
  })

  it('aborts on Stop, keeping what had already arrived', async () => {
    const chat$ = await openThread()
    let seen: AbortSignal | undefined
    mockedSend.mockImplementation(
      (_chatId, _text, onEvent, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal
          onEvent({ type: 'text', text: 'Three parcels' })
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const turn = chat$.send('what is in Shelby?')
    await nextTick()
    chat$.stop()
    await turn
    expect(seen?.aborted).toBe(true)
    expect(chat$.streaming.value).toBe(false)
    expect(chat$.messages.value[1]).toMatchObject({ text: 'Three parcels', pending: false, stopped: true })
    expect(chat$.error.value).toBe('')
  })
})

describe('proposed writes', () => {
  async function threadWithProposal() {
    const chat$ = await openThread()
    streams([{ type: 'proposed_action', action: PROPOSAL }, { type: 'text', text: 'I can write that note.' }])
    await chat$.send('note that down')
    return chat$
  }

  it('runs the stored proposal and appends what came back', async () => {
    const chat$ = await threadWithProposal()
    const confirmed: ChatToolCall = { ...PROPOSAL, status: 'confirmed', result: { slug: 'shelby-follow-up', href: '/library/shelby-follow-up' } }
    const outcome: ChatMessage = { id: 20, role: 'tool', text: 'Write a note “Shelby follow-up” — done.', toolCalls: [confirmed], citations: [], createdAt: 'c' }
    mockedConfirm.mockResolvedValue({ ok: true, action: confirmed, message: outcome })

    await chat$.runAction('a1')
    expect(mockedConfirm).toHaveBeenCalledWith(1, 'a1')
    expect(chat$.messages.value[1].toolCalls[0].status).toBe('confirmed')
    expect(chat$.messages.value[2]).toMatchObject({ id: 20, role: 'tool' })
    expect(chat$.actionError.value).toBe('')
    expect(chat$.runningActions.value).toEqual([])
  })

  it('reports a refused write and keeps the message it left in the thread', async () => {
    const chat$ = await threadWithProposal()
    const failed: ChatToolCall = { ...PROPOSAL, status: 'failed' }
    mockedConfirm.mockResolvedValue({
      ok: false,
      error: 'There is no page by that slug.',
      action: failed,
      message: { id: 21, role: 'tool', text: 'did not run', toolCalls: [failed], citations: [], createdAt: 'c' },
    })
    await chat$.runAction('a1')
    expect(chat$.actionError.value).toBe('There is no page by that slug.')
    expect(chat$.messages.value[1].toolCalls[0].status).toBe('failed')
    expect(chat$.messages.value).toHaveLength(3)
  })

  it('marks the action running while the confirm is in flight, and only once', async () => {
    const chat$ = await threadWithProposal()
    mockedConfirm.mockReturnValue(new Promise(() => {}))
    void chat$.runAction('a1')
    await nextTick()
    expect(chat$.runningActions.value).toEqual(['a1'])
    void chat$.runAction('a1')
    expect(mockedConfirm).toHaveBeenCalledTimes(1)
  })

  it('names the four states a proposal can be in', () => {
    expect(actionStateOf(PROPOSAL, [])).toBe('proposed')
    expect(actionStateOf(PROPOSAL, ['a1'])).toBe('running')
    expect(actionStateOf({ ...PROPOSAL, status: 'confirmed' }, [])).toBe('done')
    expect(actionStateOf({ ...PROPOSAL, status: 'failed' }, [])).toBe('failed')
  })
})
