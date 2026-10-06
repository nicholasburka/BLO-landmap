import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

vi.mock('@/lib/wikiEmbeds', () => ({ hydrateEmbeds: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/ask', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/ask')>()
  return { ...actual, askLibrary: vi.fn() }
})
vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalog: vi.fn().mockResolvedValue([]) }
})

import { askLibrary, RECENT_KEY, type AskAnswer } from '@/lib/ask'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { hydrateEmbeds } from '@/lib/wikiEmbeds'
import PageEditor from '../PageEditor.vue'

const mockedHydrate = vi.mocked(hydrateEmbeds)
const mockedAsk = vi.mocked(askLibrary)
const mockedCatalog = vi.mocked(fetchCatalog)

/** Hosting the editor under a real v-model keeps the multi-step tests honest. */
const Host = defineComponent({
  components: { PageEditor },
  props: {
    slug: { type: String, default: 'tn-strategy' },
    saved: { type: String, default: '' },
    initial: { type: String, default: '' },
  },
  data() {
    return { text: this.initial }
  },
  template: `<PageEditor v-model="text" :slug="slug" :saved="saved" />`,
})

function stubMatchMedia(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((media: string) => ({
    matches,
    media,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

/** Every mount is tracked and unmounted after the test: a live editor keeps a
 *  pending 500ms autosave timer, which would otherwise fire into the next
 *  test's localStorage and come back as a restored draft. */
const mounted: VueWrapper<any>[] = []

function mountHost(props: Record<string, unknown> = {}) {
  const w = mount(Host, { props, attachTo: document.body })
  mounted.push(w)
  return w
}

async function editor(props: Record<string, unknown> = {}) {
  const w = mountHost(props)
  await flushPromises()
  return w
}

function textarea(w: VueWrapper<any>): HTMLTextAreaElement {
  return w.get('[data-testid="editor-textarea"]').element as HTMLTextAreaElement
}

/** Put the caret/selection where a person would have it, then click a button. */
async function select(w: VueWrapper<any>, start: number, end = start): Promise<void> {
  const el = textarea(w)
  el.focus()
  el.setSelectionRange(start, end)
  await w.vm.$nextTick()
}

beforeEach(() => {
  localStorage.clear()
  stubMatchMedia(false)
  mockedAsk.mockReset()
  mockedCatalog.mockReset()
  mockedCatalog.mockResolvedValue([])
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('toolbar', () => {
  it('bolds the selection and leaves it selected in a focused textarea', async () => {
    const w = await editor({ initial: 'the soil survey' })
    await select(w, 4, 8)
    await w.get('[data-testid="tb-bold"]').trigger('click')
    expect(w.vm.text).toBe('the **soil** survey')
    const el = textarea(w)
    expect(document.activeElement).toBe(el)
    expect([el.selectionStart, el.selectionEnd]).toEqual([6, 10])
  })

  it('italicises with the same wrap-and-restore behaviour', async () => {
    const w = await editor({ initial: 'the soil survey' })
    await select(w, 4, 8)
    await w.get('[data-testid="tb-italic"]').trigger('click')
    expect(w.vm.text).toBe('the _soil_ survey')
  })

  it('cycles the heading on the caret line', async () => {
    const w = await editor({ initial: '# Title\n\nFindings' })
    await select(w, 12)
    await w.get('[data-testid="tb-heading"]').trigger('click')
    expect(w.vm.text).toBe('# Title\n\n## Findings')
    await w.get('[data-testid="tb-heading"]').trigger('click')
    expect(w.vm.text).toBe('# Title\n\n### Findings')
  })

  it('makes bulleted and numbered lists out of the selected lines', async () => {
    const w = await editor({ initial: 'one\ntwo' })
    await select(w, 0, 7)
    await w.get('[data-testid="tb-bullet"]').trigger('click')
    expect(w.vm.text).toBe('- one\n- two')

    const n = await editor({ initial: 'one\ntwo' })
    await select(n, 0, 7)
    await n.get('[data-testid="tb-number"]').trigger('click')
    expect(n.vm.text).toBe('1. one\n2. two')
  })

  it('inserts a 3-column, 2-row table', async () => {
    const w = await editor({ initial: 'Intro' })
    await select(w, 5)
    await w.get('[data-testid="tb-table"]').trigger('click')
    expect(w.vm.text).toContain('| Column | Column | Column |')
    expect(w.vm.text.split('\n').filter((l: string) => l.startsWith('|'))).toHaveLength(4)
  })
})

describe('link popover', () => {
  it('asks for the URL in a popover, never window.prompt', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
    const w = await editor({ initial: 'see the guide here' })
    await select(w, 4, 13)
    await w.get('[data-testid="tb-link"]').trigger('click')
    expect(w.find('[data-testid="link-popover"]').exists()).toBe(true)
    expect(prompt).not.toHaveBeenCalled()

    await w.get('[data-testid="link-url"]').setValue('/wiki/guide')
    await w.get('[data-testid="link-form"]').trigger('submit')
    expect(w.vm.text).toBe('see [the guide](/wiki/guide) here')
    expect(w.find('[data-testid="link-popover"]').exists()).toBe(false)
  })

  it('closes without touching the page when cancelled', async () => {
    const w = await editor({ initial: 'text' })
    await w.get('[data-testid="tb-link"]').trigger('click')
    await w.get('[data-testid="link-cancel"]').trigger('click')
    expect(w.find('[data-testid="link-popover"]').exists()).toBe(false)
    expect(w.vm.text).toBe('text')
  })
})

describe('keyboard shortcuts', () => {
  it('⌘B bolds, ⌘I italicises, ⌘K opens the link popover', async () => {
    const w = await editor({ initial: 'the soil survey' })
    await select(w, 4, 8)
    await w.get('[data-testid="editor-textarea"]').trigger('keydown', { key: 'b', metaKey: true })
    expect(w.vm.text).toBe('the **soil** survey')

    await select(w, 6, 10)
    await w.get('[data-testid="editor-textarea"]').trigger('keydown', { key: 'i', metaKey: true })
    expect(w.vm.text).toBe('the **_soil_** survey')

    await w.get('[data-testid="editor-textarea"]').trigger('keydown', { key: 'k', metaKey: true })
    await flushPromises()
    expect(w.find('[data-testid="link-popover"]').exists()).toBe(true)
    // The caret must land in the URL box, or ⌘K still needs the mouse.
    expect(document.activeElement).toBe(w.get('[data-testid="link-url"]').element)
  })

  it('works with Ctrl for the same keys', async () => {
    const w = await editor({ initial: 'the soil survey' })
    await select(w, 4, 8)
    await w.get('[data-testid="editor-textarea"]').trigger('keydown', { key: 'b', ctrlKey: true })
    expect(w.vm.text).toBe('the **soil** survey')
  })
})

describe('preview', () => {
  it('shows source and preview side by side on a wide screen, with no Write/Preview toggle', async () => {
    stubMatchMedia(true)
    const w = await editor({ initial: '## Findings' })
    expect(w.find('[data-testid="editor-textarea"]').exists()).toBe(true)
    expect(w.get('[data-testid="editor-preview"]').html()).toContain('<h2>Findings</h2>')
    expect(w.find('[data-testid="toggle-preview"]').exists()).toBe(false)
  })

  it('keeps the Write/Preview toggle on a narrow screen', async () => {
    const w = await editor({ initial: '## Findings' })
    expect(w.find('[data-testid="editor-preview"]').exists()).toBe(false)
    await w.get('[data-testid="toggle-preview"]').trigger('click')
    expect(w.find('[data-testid="editor-textarea"]').exists()).toBe(false)
    expect(w.get('[data-testid="editor-preview"]').html()).toContain('<h2>Findings</h2>')
    await w.get('[data-testid="toggle-write"]').trigger('click')
    expect(w.find('[data-testid="editor-textarea"]').exists()).toBe(true)
  })

  it('scrolls the preview proportionally with the source', async () => {
    stubMatchMedia(true)
    const w = await editor({ initial: '## Findings' })
    const source = textarea(w)
    const preview = w.get('[data-testid="editor-preview"]').element as HTMLElement
    // jsdom has no layout, so the scrollable geometry is stubbed in.
    Object.defineProperty(source, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(source, 'clientHeight', { value: 500, configurable: true })
    Object.defineProperty(preview, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(preview, 'clientHeight', { value: 400, configurable: true })
    source.scrollTop = 250 // half way down the source
    await w.get('[data-testid="editor-textarea"]').trigger('scroll')
    expect(preview.scrollTop).toBe(800) // half way down the preview
  })
})

describe('draft autosave', () => {
  it('saves the draft to blo:draft:<slug> after a 500ms pause', async () => {
    vi.useFakeTimers()
    const w = mountHost({ slug: 'tn-strategy', saved: '# Saved' })
    await w.get('[data-testid="editor-textarea"]').setValue('# Saved\n\nNew paragraph.')
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBeNull()
    await vi.advanceTimersByTimeAsync(500)
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBe('# Saved\n\nNew paragraph.')
  })

  it('drops the draft once the text matches the saved page again', async () => {
    vi.useFakeTimers()
    localStorage.setItem('blo:draft:tn-strategy', '# Saved\n\nstray')
    const w = mountHost({ slug: 'tn-strategy', saved: '# Saved' })
    await w.get('[data-testid="editor-textarea"]').setValue('# Saved')
    await vi.advanceTimersByTimeAsync(500)
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBeNull()
  })

  it('restores a draft that differs from the saved page and offers Discard', async () => {
    localStorage.setItem('blo:draft:tn-strategy', '# Saved\n\nUnfinished thought.')
    const w = await editor({ slug: 'tn-strategy', saved: '# Saved', initial: '# Saved' })
    expect(w.vm.text).toBe('# Saved\n\nUnfinished thought.')
    expect(w.get('[data-testid="draft-restored"]').text()).toMatch(/draft restored/i)

    await w.get('[data-testid="draft-discard"]').trigger('click')
    expect(w.vm.text).toBe('# Saved')
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBeNull()
    expect(w.find('[data-testid="draft-restored"]').exists()).toBe(false)
  })

  it('says nothing when the stored draft matches the saved page', async () => {
    localStorage.setItem('blo:draft:tn-strategy', '# Saved')
    const w = await editor({ slug: 'tn-strategy', saved: '# Saved', initial: '# Saved' })
    expect(w.find('[data-testid="draft-restored"]').exists()).toBe(false)
    expect(w.vm.text).toBe('# Saved')
  })
})

const ANSWER: AskAnswer = {
  answer: 'Twelve counties clear the threshold [1]. More detail follows.',
  sources: [
    { n: 1, slug: 'organizations', kind: 'dataset', title: 'Organizations', href: '/library/organizations', snippet: '', cited: true },
  ],
  queries: [],
  read: { pages: 0, datasets: 1, documents: 0, notes: 0 },
}

describe('insert citation', () => {
  function rememberAsked(count: number): void {
    const items = Array.from({ length: count }, (_, i) => ({ q: `question ${i}`, at: 1000 + i }))
    localStorage.setItem(RECENT_KEY, JSON.stringify(items))
  }

  it('lists the last ten Ask questions', async () => {
    rememberAsked(14)
    const w = await editor({ initial: 'Intro' })
    await w.get('[data-testid="tb-cite"]').trigger('click')
    const items = w.findAll('[data-testid="cite-item"]')
    expect(items).toHaveLength(10)
    expect(items[0].text()).toContain('question 0')
  })

  it('inserts a blockquote with the first sentence, the sources, and a link back to Ask', async () => {
    rememberAsked(1)
    mockedAsk.mockResolvedValue(ANSWER)
    const w = await editor({ initial: 'Intro' })
    await select(w, 5)
    await w.get('[data-testid="tb-cite"]').trigger('click')
    await w.get('[data-testid="cite-item"]').trigger('click')
    await flushPromises()

    expect(mockedAsk).toHaveBeenCalledWith('question 0', undefined)
    expect(w.vm.text).toBe(
      'Intro\n\n> Twelve counties clear the threshold.\n>\n' +
        '> Sources: [Organizations](/library/organizations) · [Asked: "question 0"](/ask?q=question+0)\n',
    )
    expect(w.find('[data-testid="cite-popover"]').exists()).toBe(false)
  })

  it('explains a failed answer in plain language and leaves the page alone', async () => {
    rememberAsked(1)
    mockedAsk.mockRejectedValue(new Error('boom'))
    const w = await editor({ initial: 'Intro' })
    await w.get('[data-testid="tb-cite"]').trigger('click')
    await w.get('[data-testid="cite-item"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="cite-error"]').text()).toMatch(/went wrong|try again/i)
    expect(w.vm.text).toBe('Intro')
  })

  it('points at Ask when there is nothing to cite yet', async () => {
    const w = await editor({ initial: 'Intro' })
    await w.get('[data-testid="tb-cite"]').trigger('click')
    expect(w.get('[data-testid="cite-empty"]').text()).toMatch(/ask/i)
  })
})

describe('embed picker', () => {
  it('inserts the fence for the chosen entry and closes', async () => {
    const view: CatalogEntry = {
      slug: 'tn-target-counties', kind: 'view', title: 'TN target counties',
      category: '', status: 'published', tags: [], meta: {}, files: [], bytes: 0,
    }
    mockedCatalog.mockResolvedValue([view])
    const w = await editor({ initial: 'Intro' })
    await select(w, 5)
    await w.get('[data-testid="tb-embed"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="embed-result"]').trigger('click')
    expect(w.vm.text).toBe('Intro\n\n```view:tn-target-counties\n```\n')
    expect(w.find('[data-testid="embed-picker"]').exists()).toBe(false)
  })

  // P7-4: the same saved view, as a map rather than a card.
  it('inserts a map fence when a saved map view is added as a map', async () => {
    const view: CatalogEntry = {
      slug: 'tn-target-counties', kind: 'view', title: 'TN target counties',
      category: '', status: 'published', tags: [],
      meta: { type: 'map', layers: ['pct_Black'] }, files: [], bytes: 0,
    }
    mockedCatalog.mockResolvedValue([view])
    const w = await editor({ initial: 'Intro' })
    await select(w, 5)
    await w.get('[data-testid="tb-embed"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="embed-as-map"]').trigger('click')
    expect(w.vm.text).toBe('Intro\n\n```map:tn-target-counties\n```\n')
  })
})

describe('the preview and a map block (P7-4)', () => {
  it('never lets the preview mount a canvas: it re-renders on every keystroke', async () => {
    const w = await editor({ initial: '```map:tn-target-counties```' })
    await flushPromises()
    expect(mockedHydrate).toHaveBeenCalled()
    for (const [, options] of mockedHydrate.mock.calls) {
      expect(options?.liveMaps).toBe(false)
    }
  })
})

describe('the editor on a phone (P5-60)', () => {
  /** Per-query, unlike the blanket stub above: the editor asks both
   *  "(min-width: 1100px)" and "(max-width: 640px)", and a phone answers no to
   *  the first and yes to the second. */
  function stubWidth(width: number): void {
    window.matchMedia = vi.fn().mockImplementation((media: string) => {
      const max = /max-width:\s*(\d+)px/.exec(media)
      const min = /min-width:\s*(\d+)px/.exec(media)
      const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false
      return { matches, media, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }
    }) as unknown as typeof window.matchMedia
  }

  it('puts the format buttons in a scroll strip and the toggle in a segmented control', async () => {
    stubWidth(375)
    const w = await editor()
    expect(w.get('[data-testid="tb-format-group"]').classes()).toContain('strip')
    const toggle = w.get('[data-testid="tb-write-preview"]')
    expect(toggle.classes()).toContain('segmented')
    expect(toggle.attributes('role')).toBe('group')
    // A segmented control says which half is on; two loose buttons do not.
    expect(w.get('[data-testid="toggle-write"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-testid="toggle-preview"]').attributes('aria-pressed')).toBe('false')
    await w.get('[data-testid="toggle-preview"]').trigger('click')
    expect(w.get('[data-testid="toggle-preview"]').attributes('aria-pressed')).toBe('true')
  })

  it('opens the link, embed and citation popovers as bottom sheets', async () => {
    stubWidth(375)
    const w = await editor({ initial: 'Intro' })

    await w.get('[data-testid="tb-link"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="popover-host"]').classes()).toContain('sheet-backdrop')
    expect(w.get('[data-testid="link-popover"]').classes()).toContain('sheet')

    await w.get('[data-testid="tb-embed"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="embed-popover"]').classes()).toContain('sheet')

    await w.get('[data-testid="tb-cite"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="cite-popover"]').classes()).toContain('sheet')
  })

  it('tapping the backdrop closes the sheet', async () => {
    stubWidth(375)
    const w = await editor({ initial: 'Intro' })
    await w.get('[data-testid="tb-link"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="popover-host"]').trigger('click')
    expect(w.find('[data-testid="link-popover"]').exists()).toBe(false)
  })

  it('leaves the popovers inline on a wider screen', async () => {
    stubWidth(900)
    const w = await editor({ initial: 'Intro' })
    await w.get('[data-testid="tb-link"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="popover-host"]').classes()).not.toContain('sheet-backdrop')
    expect(w.get('[data-testid="link-popover"]').classes()).not.toContain('sheet')
  })
})

describe('the editor does not scroll sideways at 375 px (P5-60)', () => {
  // Measured live: /wiki/<slug> in edit mode overflowed by 260 px. The toolbar
  // strip scrolls, but its nine buttons were still the intrinsic minimum width
  // of every ancestor, so the page grew to fit them instead.
  const EDITOR = readStyles('src/components/PageEditor.vue')
  const EDITOR_PHONE = mediaBlock(EDITOR, 640)
  const PAGE = mediaBlock(readStyles('src/views/WikiPageView.vue'), 640)

  it('lets every box from the page down to the panes shrink below its content', () => {
    for (const selector of ['.wiki-page-view', '.wiki-page-panel', '.wiki-page-panel.editing', '.editor']) {
      const rule = ruleFor(PAGE, selector)
      expect(rule, selector).toContain('min-width: 0')
      expect(rule, selector).toContain('max-width: 100%')
    }
    for (const selector of ['.page-editor', '.toolbar', '.panes']) {
      const rule = ruleFor(EDITOR_PHONE, selector)
      expect(rule, selector).toContain('min-width: 0')
      expect(rule, selector).toContain('max-width: 100%')
    }
  })

  it('makes the format strip scroll inside its own width', () => {
    const strip = ruleFor(EDITOR_PHONE, '.tool-group.strip')
    expect(strip).toContain('width: 100%')
    expect(strip).toContain('min-width: 0')
    expect(strip).toContain('overflow-x: auto')
    expect(strip).toContain('flex-wrap: nowrap')
    // Its children keep their size and are scrolled past, not squashed.
    expect(ruleFor(EDITOR_PHONE, '.tool')).toContain('flex: 0 0 auto')
  })

  it('gives the segmented toggle the full width in two equal halves', () => {
    expect(ruleFor(EDITOR_PHONE, '.tool-group.segmented')).toContain('width: 100%')
    expect(ruleFor(EDITOR_PHONE, '.tool-group.segmented .tool')).toContain('flex: 1 1 0')
  })

  it('keeps the textarea inside the pane', () => {
    expect(ruleFor(EDITOR_PHONE, '.panes')).toContain('minmax(0, 1fr)')
    const source = ruleFor(EDITOR_PHONE, '.source')
    expect(source).toContain('width: 100%')
    expect(source).toContain('max-width: 100%')
  })
})
