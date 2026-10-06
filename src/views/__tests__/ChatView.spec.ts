import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

import { mapboxStubModule, lastStubMap, resetMapboxStub, StubMap } from '@/testing/mapboxStub'

// P6-10: the map pane is a real map now. mapbox-gl needs a WebGL canvas, so
// the page gets the stand-in and the county files get a stubbed `fetch`.
vi.mock('mapbox-gl', () => mapboxStubModule())

vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, sharedManifest: vi.fn().mockResolvedValue([]) }
})

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

vi.mock('@/lib/ask', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ask')>()
  return { ...actual, saveAnswerAsNote: vi.fn(), addAnswerToPage: vi.fn() }
})

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalog: vi.fn() }
})

// KbNav sits at the top of every internal page and reaches the shortlist,
// which registers a logout hook.
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'dev', role: 'admin' } } }),
  registerLogoutHook: vi.fn(),
}))

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
import { saveAnswerAsNote } from '@/lib/ask'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { resetCountyDataCache } from '@/composables/useMapData'
import { stubCountyDataFetch, type CountyDataFetchStub } from '@/testing/countyData'
import DATASETS from '@/config/datasetsManifest.generated.json'
import ChatView from '../ChatView.vue'
// jsdom has no matchMedia; `usePhoneLayout` reads it to decide whether the
// thread list is a column or one select, and `MAP_PANE_QUERY` reads it to
// decide whether this viewport can hold a map pane at all (P6-10). The stub
// is shared with the "Show on map" pages (P6-14).
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'

const mockedList = vi.mocked(listChats)
const mockedCreate = vi.mocked(createChat)
const mockedGet = vi.mocked(getChat)
const mockedRename = vi.mocked(renameChat)
const mockedArchive = vi.mocked(archiveChat)
const mockedConfirm = vi.mocked(confirmAction)
const mockedSend = vi.mocked(sendMessage)
const mockedSaveNote = vi.mocked(saveAnswerAsNote)
const mockedCatalog = vi.mocked(fetchCatalog)

const THREAD: Chat = { id: 1, title: 'Shelby follow-up', createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z' }

const CITATION = {
  n: 1,
  slug: 'parcels',
  kind: 'dataset',
  title: 'Parcels',
  href: '/library/parcels',
  snippet: 'One row per parcel.',
  cited: true,
}

const PROPOSAL: ChatToolCall = {
  id: 'a1',
  tool: 'create_note',
  kind: 'write',
  status: 'proposed',
  summary: 'Write a note “Shelby follow-up”',
  args: { title: 'Shelby follow-up', body: 'Three parcels.' },
}

let router: Router

async function mountView(path = '/chat'): Promise<VueWrapper> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat', component: ChatView },
      { path: '/:pathMatch(.*)*', component: { template: '<div />' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(ChatView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

/** `sendMessage` as the page sees it: scripted events, then done. */
function streams(events: ChatEvent[]): void {
  mockedSend.mockImplementation(async (_chatId, _text, onEvent) => {
    for (const event of events) onEvent(event)
    return { type: 'done', chatId: 1, messageId: 9, userMessageId: 8 }
  })
}

async function type(wrapper: VueWrapper, text: string): Promise<void> {
  const box = wrapper.get('[data-testid="chat-input"]')
  await box.setValue(text)
  await wrapper.get('[data-testid="chat-composer"]').trigger('submit')
  await flushPromises()
}

/** What the page asked `fetch` for, so a test can prove it did not. */
let network: CountyDataFetchStub

/**
 * Wait for the canvas to exist. `MapCanvas` is loaded on demand
 * (`defineAsyncComponent`), so the import, the mount and the map all land
 * over a few ticks — then its `load` handler is what adds the counties.
 */
async function settleMap(): Promise<void> {
  // The page's `import()` is real I/O the first time: await it here so the
  // rest is microtasks. (That the page defers it at all is the point — the
  // test above proves nothing is fetched until it does.)
  await import('@/components/MapCanvas.vue')
  for (let i = 0; i < 20 && StubMap.instances.length === 0; i++) await flushPromises()
  await lastStubMap().fire('load')
  await flushPromises()
}

/** Open the pane and let the async component and its county files land. */
async function openPane(wrapper: VueWrapper): Promise<void> {
  await wrapper.get('[data-testid="chat-pane-open"]').trigger('click')
  await settleMap()
}

beforeEach(() => {
  // A phone stub from one case must not decide the layout of the next.
  restoreViewport()
  resetMapboxStub()
  resetCountyDataCache()
  network = stubCountyDataFetch()
  for (const mock of [mockedList, mockedCreate, mockedGet, mockedRename, mockedArchive, mockedConfirm, mockedSend, mockedSaveNote, mockedCatalog]) {
    mock.mockReset()
  }
  mockedList.mockResolvedValue([])
  mockedGet.mockResolvedValue({ chat: THREAD, messages: [] })
  mockedCreate.mockResolvedValue(THREAD)
  mockedCatalog.mockResolvedValue([{ slug: 'georgia', title: 'Georgia', kind: 'wiki' } as CatalogEntry])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * P6-10. The pane is the same `MapCanvas` the public map wraps, mounted here
 * with no chrome around it: closed until asked for, desktop only, and the
 * four map tools run against it client-side while every library tool stays on
 * the server.
 */
describe('ChatView — the map pane (P6-10)', () => {
  it('fetches no county file until the pane is opened', async () => {
    stubViewportWidth(1280)
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(false)
    expect(network.urls.filter(url => url.startsWith('/datasets/build/'))).toEqual([])

    await openPane(wrapper)

    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(true)
    expect(network.urls).toContain(DATASETS.counties)
    expect(network.urls).toContain(DATASETS.countyData)
    wrapper.unmount()
  })

  it('opens and closes, and takes its map with it when it closes', async () => {
    stubViewportWidth(1280)
    const wrapper = await mountView()
    await openPane(wrapper)
    const map = lastStubMap()
    expect(map.getLayer('county-choropleth')).toBeTruthy()

    await wrapper.get('[data-testid="chat-pane-close"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(false)
    expect(map.removed).toBe(true)
    wrapper.unmount()
  })

  it('names the layer the pane is showing', async () => {
    stubViewportWidth(1280)
    const wrapper = await mountView()
    await openPane(wrapper)
    expect(wrapper.get('[data-testid="chat-pane-layer"]').text()).toBe('BLO Livability Index')
    wrapper.unmount()
  })

  it('offers no pane on a phone — two WebGL contexts are not a phone\'s business', async () => {
    stubViewportWidth(390)
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="chat-pane-open"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('runs the assistant\'s show_layer against the pane, opening it if it is shut', async () => {
    stubViewportWidth(1280)
    mockedList.mockResolvedValue([THREAD])
    streams([
      {
        type: 'tool_call',
        phase: 'started',
        call: {
          id: 'm1',
          tool: 'show_layer',
          kind: 'read',
          status: 'running',
          summary: 'Showed Percent Black on the map',
          args: { layerId: 'pct_Black', on: true },
        },
      },
      { type: 'text', text: 'Shelby is in the top decile.' },
    ])
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(false)

    await type(wrapper, 'show me percent Black')
    // The canvas mounts because of the tool call, then runs it.
    await settleMap()

    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="chat-pane-layer"]').text()).toBe('Percent Black')
    expect(lastStubMap().getLayer('county-choropleth')?.visibility).toBe('visible')
    wrapper.unmount()
  })

  it('leaves the library tools alone — they ran on the server already', async () => {
    stubViewportWidth(1280)
    mockedList.mockResolvedValue([THREAD])
    streams([
      {
        type: 'tool_call',
        phase: 'started',
        call: { id: 'r1', tool: 'search_library', kind: 'read', status: 'running', summary: 'Searched the library' },
      },
      { type: 'text', text: 'Six results.' },
    ])
    const wrapper = await mountView()

    await type(wrapper, 'what do we hold on Shelby?')

    // No map was built and no county file was asked for: a read tool is news.
    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(false)
    expect(network.urls.filter(url => url.startsWith('/datasets/build/'))).toEqual([])
    wrapper.unmount()
  })
})

describe('ChatView arriving with ?q= (P6-5: the Ask boxes land here)', () => {
  it('starts a new thread with the question at once and drops the query from the URL', async () => {
    mockedList.mockResolvedValue([THREAD])
    streams([{ type: 'text', text: 'Two sources cover it.' }])
    const w = await mountView('/chat?q=what%20floods%20Shelby')
    expect(mockedCreate).toHaveBeenCalledWith({ message: 'what floods Shelby' })
    expect(mockedSend).toHaveBeenCalledWith(1, 'what floods Shelby', expect.any(Function), expect.anything())
    // The newest existing thread is NOT opened over the top of the new one.
    expect(mockedGet).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/chat')
    expect(w.text()).toContain('Two sources cover it.')
  })

  it('ignores an empty q and opens the newest thread as usual', async () => {
    mockedList.mockResolvedValue([THREAD])
    mockedGet.mockResolvedValue({ chat: THREAD, messages: [] })
    await mountView('/chat?q=%20')
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(mockedGet).toHaveBeenCalledWith(1)
  })
})

describe('ChatView (P6-7b) — the page', () => {
  it('offers New chat when there are no conversations yet', async () => {
    const wrapper = await mountView()
    expect(wrapper.get('[data-testid="chat-threads-empty"]').text()).toContain('No conversations yet')
    expect(mockedGet).not.toHaveBeenCalled()

    await wrapper.get('[data-testid="chat-new"]').trigger('click')
    await flushPromises()
    expect(mockedCreate).toHaveBeenCalled()
    expect(wrapper.findAll('[data-testid="chat-thread"]')).toHaveLength(1)
    expect(wrapper.get('[data-testid="chat-title"]').text()).toBe('Shelby follow-up')
    wrapper.unmount()
  })

  it('opens the most recent conversation on arrival', async () => {
    mockedList.mockResolvedValue([THREAD])
    mockedGet.mockResolvedValue({
      chat: THREAD,
      messages: [
        { id: 1, role: 'user', text: 'what is in Shelby?', toolCalls: [], citations: [], createdAt: 'a' },
        { id: 2, role: 'assistant', text: 'Three parcels [1].', toolCalls: [], citations: [CITATION], createdAt: 'b' },
      ] as ChatMessage[],
    })
    const wrapper = await mountView()
    expect(mockedGet).toHaveBeenCalledWith(1)
    expect(wrapper.findAll('[data-testid="chat-message"]')).toHaveLength(2)
    expect(wrapper.get('[data-testid="chat-user-text"]').text()).toBe('what is in Shelby?')
    wrapper.unmount()
  })

  it('keeps the map pane closed and weightless until it is asked for (P6-10)', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="chat-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows the threads as one select on a phone', async () => {
    mockedList.mockResolvedValue([THREAD, { ...THREAD, id: 2, title: 'Flood risk' }])
    stubViewportWidth(390)
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="chat-thread"]').exists()).toBe(false)
    const select = wrapper.get('[data-testid="chat-threads-select"]')
    expect(select.findAll('option')).toHaveLength(2)

    await select.setValue('2')
    await flushPromises()
    expect(mockedGet).toHaveBeenLastCalledWith(2)
    wrapper.unmount()
  })

  it('renames a thread inline and archives it behind an inline confirm', async () => {
    mockedList.mockResolvedValue([THREAD])
    mockedRename.mockResolvedValue({ ...THREAD, title: 'Shelby parcels' })
    mockedArchive.mockResolvedValue(undefined)
    const wrapper = await mountView()

    await wrapper.get('[data-testid="chat-rename"]').trigger('click')
    await wrapper.get('[data-testid="chat-rename-input"]').setValue('Shelby parcels')
    await wrapper.get('[data-testid="chat-rename-save"]').trigger('click')
    await flushPromises()
    expect(mockedRename).toHaveBeenCalledWith(1, 'Shelby parcels')

    // Archiving asks on the row — never window.confirm.
    await wrapper.get('[data-testid="chat-archive"]').trigger('click')
    expect(wrapper.get('[data-testid="chat-archive-ask"]').text()).toContain('Archive')
    expect(mockedArchive).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="chat-archive-confirm"]').trigger('click')
    await flushPromises()
    expect(mockedArchive).toHaveBeenCalledWith(1)
    expect(wrapper.findAll('[data-testid="chat-thread"]')).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('ChatView (P6-7b) — a turn', () => {
  it('shows the question, the live answer, and its citations', async () => {
    mockedList.mockResolvedValue([THREAD])
    streams([{ type: 'text', text: 'Three parcels are in Shelby **County** [1].' }, { type: 'citations', citations: [CITATION] }])
    const wrapper = await mountView()

    await type(wrapper, 'what is in Shelby?')
    expect(mockedSend).toHaveBeenCalledWith(1, 'what is in Shelby?', expect.any(Function), expect.any(Object))
    expect(wrapper.get('[data-testid="chat-user-text"]').text()).toBe('what is in Shelby?')
    expect(wrapper.get('[data-testid="chat-answer"]').html()).toContain('<strong>County</strong>')
    expect(wrapper.get('[data-testid="chat-citations"]').text()).toContain('Where this came from')
    expect(wrapper.get('[data-testid="chat-citation"]').text()).toContain('Parcels')
    wrapper.unmount()
  })

  it('shows the answer building while it streams, with the composer held', async () => {
    mockedList.mockResolvedValue([THREAD])
    let emit!: (event: ChatEvent) => void
    let finish!: () => void
    mockedSend.mockImplementation(
      (_chatId, _text, onEvent) =>
        new Promise(resolve => {
          emit = onEvent
          finish = () => resolve({ type: 'done', chatId: 1, messageId: 9, userMessageId: 8 })
        }),
    )
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    expect(wrapper.get('[data-testid="chat-thinking"]').text()).toContain('Reading the library')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="chat-input"]').element.disabled).toBe(true)

    emit({ type: 'text', text: 'Three parcels.' })
    await flushPromises()
    expect(wrapper.get('[data-testid="chat-answer"]').text()).toBe('Three parcels.')

    finish()
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="chat-input"]').element.disabled).toBe(false)
    wrapper.unmount()
  })

  it('shows a tool call as a collapsed line that opens', async () => {
    mockedList.mockResolvedValue([THREAD])
    const call: ChatToolCall = { id: 'c1', tool: 'search_library', kind: 'read', status: 'running', summary: 'Searched the library for “Shelby”' }
    streams([
      { type: 'tool_call', phase: 'started', call },
      { type: 'tool_call', phase: 'finished', call: { ...call, status: 'done', summary: 'Searched the library for “Shelby” · 6 results' } },
      { type: 'text', text: 'Three parcels.' },
    ])
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    const line = wrapper.get('[data-testid="chat-tool-summary"]')
    expect(line.text()).toBe('Searched the library for “Shelby” · 6 results')
    expect(wrapper.find('[data-testid="chat-tool-detail"]').exists()).toBe(false)
    await line.trigger('click')
    expect(wrapper.get('[data-testid="chat-tool-detail"]').text()).toContain('search_library')
    wrapper.unmount()
  })

  it('aborts the stream when Stop is pressed, keeping what arrived', async () => {
    mockedList.mockResolvedValue([THREAD])
    mockedSend.mockImplementation(
      (_chatId, _text, onEvent, signal) =>
        new Promise((_resolve, reject) => {
          onEvent({ type: 'text', text: 'Three parcels' })
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    await wrapper.get('[data-testid="chat-stop"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="chat-answer"]').text()).toBe('Three parcels')
    expect(wrapper.get('[data-testid="chat-stopped"]').text()).toBe('Stopped.')
    expect(wrapper.find('[data-testid="chat-stop"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="chat-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders the honesty line as the answer and tells an admin why (P5-75)', async () => {
    mockedList.mockResolvedValue([THREAD])
    const honesty = 'The answering service is unavailable right now. Please try again in a minute.'
    mockedSend.mockImplementation(async (_chatId, _text, onEvent) => {
      onEvent({ type: 'text', text: honesty })
      throw new ChatStreamError(honesty, 'refused', 12)
    })
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    expect(wrapper.get('[data-testid="chat-answer"]').text()).toBe(honesty)
    expect(wrapper.get('[data-testid="chat-error"]').text()).toBe('The model refused the key — check billing or the key.')
    wrapper.unmount()
  })

  it('takes the question back when nothing was stored', async () => {
    mockedList.mockResolvedValue([THREAD])
    mockedSend.mockRejectedValue(new ChatStreamError('That answer could not be put together. Try again.'))
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    expect(wrapper.findAll('[data-testid="chat-message"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="chat-error"]').text()).toContain('could not be put together')
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="chat-input"]').element.value).toBe('what is in Shelby?')
    wrapper.unmount()
  })
})

describe('ChatView (P6-7b) — a proposed write', () => {
  async function withProposal(): Promise<VueWrapper> {
    mockedList.mockResolvedValue([THREAD])
    streams([{ type: 'proposed_action', action: PROPOSAL }, { type: 'text', text: 'I can write that note.' }])
    const wrapper = await mountView()
    await type(wrapper, 'note that down')
    return wrapper
  }

  it('asks before running anything, showing the arguments that would run', async () => {
    const wrapper = await withProposal()
    const card = wrapper.get('[data-testid="chat-proposal"]')
    expect(card.text()).toContain('The assistant wants to:')
    expect(wrapper.get('[data-testid="chat-proposal-summary"]').text()).toBe('Write a note “Shelby follow-up”')
    expect(wrapper.get('[data-testid="chat-proposal-args"]').text()).toContain('Shelby follow-up')
    expect(mockedConfirm).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('runs it on Run and appends the result to the thread', async () => {
    const wrapper = await withProposal()
    const confirmed: ChatToolCall = { ...PROPOSAL, status: 'confirmed', result: { slug: 'shelby', href: '/library/shelby' } }
    mockedConfirm.mockResolvedValue({
      ok: true,
      action: confirmed,
      message: { id: 20, role: 'tool', text: 'Write a note “Shelby follow-up” — done.\n{"slug":"shelby"}', toolCalls: [confirmed], citations: [], createdAt: 'c' },
    })

    await wrapper.get('[data-testid="chat-proposal-run"]').trigger('click')
    await flushPromises()
    expect(mockedConfirm).toHaveBeenCalledWith(1, 'a1')
    expect(wrapper.get('[data-testid="chat-proposal-done"]').text()).toContain('Done.')
    // The outcome is a line, not the JSON the model reads.
    expect(wrapper.get('[data-testid="chat-outcome"]').text()).toBe('Write a note “Shelby follow-up” — done.')
    wrapper.unmount()
  })

  it('leaves the proposal unrun on Dismiss', async () => {
    const wrapper = await withProposal()
    await wrapper.get('[data-testid="chat-proposal-dismiss"]').trigger('click')
    expect(mockedConfirm).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="chat-proposal-dismissed"]').text()).toContain('Left unrun')
    wrapper.unmount()
  })

  it('says why a confirmed write was refused', async () => {
    const wrapper = await withProposal()
    mockedConfirm.mockResolvedValue({ ok: false, error: 'There is no page by that slug.', action: { ...PROPOSAL, status: 'failed' } })
    await wrapper.get('[data-testid="chat-proposal-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="chat-action-error"]').text()).toBe('There is no page by that slug.')
    expect(wrapper.get('[data-testid="chat-proposal-failed"]').text()).toContain('Nothing was changed')
    wrapper.unmount()
  })
})

describe('ChatView (P6-7b) — keeping an answer', () => {
  it("saves an answer as a note through Ask's own helper", async () => {
    mockedList.mockResolvedValue([THREAD])
    mockedSaveNote.mockResolvedValue({ slug: 'what-is-in-shelby', title: 'what is in Shelby?' } as CatalogEntry)
    streams([{ type: 'text', text: 'Three parcels [1].' }, { type: 'citations', citations: [CITATION] }])
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    await wrapper.get('[data-testid="chat-save-note"]').trigger('click')
    await flushPromises()
    // The question titles the note; the citations become its numbered sources.
    expect(mockedSaveNote).toHaveBeenCalledWith(
      'what is in Shelby?',
      expect.objectContaining({ answer: 'Three parcels [1].', sources: [CITATION] }),
    )
    expect(wrapper.get('[data-testid="chat-note-saved"]').text()).toContain('Saved')
    wrapper.unmount()
  })

  it('offers Open only when the answer produced an analysis', async () => {
    mockedList.mockResolvedValue([THREAD])
    streams([{ type: 'text', text: 'Three parcels [1].' }])
    const plain = await mountView()
    await type(plain, 'what is in Shelby?')
    expect(plain.find('[data-testid="chat-open"]').exists()).toBe(false)
    plain.unmount()

    streams([{ type: 'text', text: 'I ran it — [the comparison](/compare?geoids=13121,13089).' }])
    const analysis = await mountView()
    await type(analysis, 'compare Fulton with DeKalb')
    const open = analysis.get('[data-testid="chat-open"]')
    expect(open.attributes('href')).toBe('/compare?geoids=13121,13089')
    expect(open.attributes('aria-label')).toBe('Open the comparison')
    analysis.unmount()
  })

  it('lists pages to add the answer to', async () => {
    mockedList.mockResolvedValue([THREAD])
    streams([{ type: 'text', text: 'Three parcels [1].' }])
    const wrapper = await mountView()
    await type(wrapper, 'what is in Shelby?')

    await wrapper.get('[data-testid="chat-add-to-page"]').trigger('click')
    await flushPromises()
    expect(mockedCatalog).toHaveBeenCalledWith({ kind: 'wiki' })
    expect(wrapper.get('[data-testid="chat-page-option"]').text()).toBe('Georgia')
    wrapper.unmount()
  })
})
