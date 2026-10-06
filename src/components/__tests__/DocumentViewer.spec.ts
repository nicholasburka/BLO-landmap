import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

// Only the two network calls are stubbed; the pure helpers (highlighting,
// page anchors) are the real ones, so what the viewer renders is what the
// reader would see.
vi.mock('@/lib/documentView', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/documentView')>()),
  loadDocument: vi.fn(),
  loadDocumentText: vi.fn(),
}))
vi.mock('@/lib/libraryCatalog', () => ({ libraryFileUrl: (s: string, n: string) => `http://api/api/library/file/${s}/${n}` }))

import { loadDocument, loadDocumentText, pageSeparator } from '@/lib/documentView'
import DocumentViewer from '../DocumentViewer.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const mockedLoad = vi.mocked(loadDocument)
const mockedLoadText = vi.mocked(loadDocumentText)

beforeEach(() => {
  mockedLoad.mockReset()
  mockedLoadText.mockReset()
  ;(URL as any).revokeObjectURL = vi.fn()
  window.location.hash = ''
})

afterEach(() => {
  window.location.hash = ''
})

async function mountWith(name: string, result: any) {
  mockedLoad.mockResolvedValue(result)
  const w = mount(DocumentViewer, { props: { slug: 'plan', name } })
  await flushPromises()
  return w
}

describe('DocumentViewer', () => {
  it('frames a pdf blob url', async () => {
    const w = await mountWith('plan.pdf', { kind: 'pdf', url: 'blob:x' })
    expect(w.get('[data-testid="doc-pdf"]').attributes('src')).toBe('blob:x')
  })

  it('renders sanitized markdown html', async () => {
    const w = await mountWith('readme.md', { kind: 'markdown', html: '<h1>Hi</h1>' })
    expect(w.get('[data-testid="doc-markdown"]').html()).toContain('<h1>Hi</h1>')
  })

  it('shows text in a pre', async () => {
    const w = await mountWith('data.csv', { kind: 'text', text: 'a,b\n1,2' })
    expect(w.get('[data-testid="doc-text"]').text()).toContain('a,b')
  })

  it('shows the unsupported fallback with a download link', async () => {
    const w = await mountWith('deck.pptx', { kind: 'unsupported', fallback: 'unsupported' })
    expect(w.get('[data-testid="doc-fallback"]').text()).toContain("isn't available")
    expect(w.get('[data-testid="doc-download"]').attributes('href')).toContain('/deck.pptx')
  })

  it('shows the too-large fallback', async () => {
    const w = await mountWith('huge.pdf', { kind: 'pdf', fallback: 'too-large' })
    expect(w.get('[data-testid="doc-fallback"]').text()).toContain('too large')
  })

  it('surfaces a load error', async () => {
    mockedLoad.mockRejectedValue(new Error('Could not load this file (401).'))
    const w = mount(DocumentViewer, { props: { slug: 'plan', name: 'plan.pdf' } })
    await flushPromises()
    expect(w.get('[data-testid="doc-error"]').text()).toContain('Could not load')
  })

  it('emits close and revokes the blob on unmount', async () => {
    const w = await mountWith('plan.pdf', { kind: 'pdf', url: 'blob:x' })
    await w.get('[data-testid="doc-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})

describe('a Word file shows its extracted text (P5-46)', () => {
  it('renders the text and offers Find in document, with no Text toggle to press', async () => {
    const w = await mountWith('Fact_Manual.docx', {
      kind: 'text',
      text: 'Heirs property is land passed down without a will.',
      pages: 1,
    })
    expect(w.get('[data-testid="doc-text"]').text()).toContain('Heirs property')
    expect(w.find('[data-testid="doc-fallback"]').exists()).toBe(false)
    expect(w.find('[data-testid="doc-find"]').exists()).toBe(true)
    expect(w.find('[data-testid="doc-text-toggle"]').exists()).toBe(false)
  })
})

describe('the PDF Text toggle (P5-46)', () => {
  const twoPages = `${pageSeparator(1)}\nLand loss on page one.\n\n${pageSeparator(2)}\nMore land on page two.`

  async function openPdfText() {
    mockedLoadText.mockResolvedValue({ pages: 2, text: twoPages })
    const w = await mountWith('plan.pdf', { kind: 'pdf', url: 'blob:x' })
    await w.get('[data-testid="doc-text-toggle"]').trigger('click')
    await flushPromises()
    return w
  }

  it('swaps the frame for the text, and back again', async () => {
    const w = await openPdfText()
    expect(mockedLoadText).toHaveBeenCalledWith('plan', 'plan.pdf')
    expect(w.find('[data-testid="doc-pdf"]').exists()).toBe(false)
    expect(w.get('[data-testid="doc-text"]').text()).toContain('Land loss on page one')
    expect(w.get('[data-testid="doc-text-toggle"]').text()).toBe('Original')

    await w.get('[data-testid="doc-text-toggle"]').trigger('click')
    expect(w.find('[data-testid="doc-pdf"]').exists()).toBe(true)
    expect(w.find('[data-testid="doc-text"]').exists()).toBe(false)
  })

  it('fetches the text once, however often the reader flips', async () => {
    const w = await openPdfText()
    await w.get('[data-testid="doc-text-toggle"]').trigger('click')
    await w.get('[data-testid="doc-text-toggle"]').trigger('click')
    await flushPromises()
    expect(mockedLoadText).toHaveBeenCalledTimes(1)
  })

  it('says why when there is no text to show', async () => {
    mockedLoadText.mockRejectedValue(new Error('It is most likely a scan.'))
    const w = await mountWith('scan.pdf', { kind: 'pdf', url: 'blob:x' })
    await w.get('[data-testid="doc-text-toggle"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="doc-text-error"]').text()).toContain('most likely a scan')
  })

  it('highlights matches, counts them, and cycles on Enter', async () => {
    const w = await openPdfText()
    const input = w.get('[data-testid="doc-find-input"]')
    await input.setValue('land')
    await flushPromises()

    expect(w.get('[data-testid="doc-find-count"]').text()).toBe('1 of 2')
    const html = w.get('[data-testid="doc-text"]').html()
    expect(html).toContain('<mark class="doc-hit-active" id="doc-hit">Land</mark>')
    expect(html).toContain('<mark>land</mark>')

    await input.trigger('keydown.enter')
    await flushPromises()
    expect(w.get('[data-testid="doc-find-count"]').text()).toBe('2 of 2')
    // ... and it wraps around rather than sticking at the end.
    await input.trigger('keydown.enter')
    expect(w.get('[data-testid="doc-find-count"]').text()).toBe('1 of 2')
  })

  it('says so plainly when nothing matches', async () => {
    const w = await openPdfText()
    await w.get('[data-testid="doc-find-input"]').setValue('zebra')
    await flushPromises()
    expect(w.get('[data-testid="doc-find-count"]').text()).toBe('no matches')
    expect(w.find('[data-testid="doc-find-next"]').exists()).toBe(false)
  })
})

describe('#page=N deep links from Ask (P5-46)', () => {
  it('opens the PDF frame at that page', async () => {
    window.location.hash = '#page=2'
    const w = await mountWith('plan.pdf', { kind: 'pdf', url: 'blob:x' })
    expect(w.get('[data-testid="doc-pdf"]').attributes('src')).toBe('blob:x#page=2')
  })

  it('leaves the frame alone when the link names no page', async () => {
    const w = await mountWith('plan.pdf', { kind: 'pdf', url: 'blob:x' })
    expect(w.get('[data-testid="doc-pdf"]').attributes('src')).toBe('blob:x')
  })

  it('scrolls the text view to that page separator', async () => {
    window.location.hash = '#page=2'
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView

    mockedLoadText.mockResolvedValue({
      pages: 2,
      text: `${pageSeparator(1)}\nOne.\n\n${pageSeparator(2)}\nTwo.`,
    })
    const w = await mountWith('plan.pdf', { kind: 'pdf', url: 'blob:x' })
    await w.get('[data-testid="doc-text-toggle"]').trigger('click')
    await flushPromises()

    // The anchor the scroll aimed at is in the rendered text.
    expect(w.get('[data-testid="doc-text"]').html()).toContain('id="doc-page-2"')
    expect(scrollIntoView).toHaveBeenCalled()
  })
})

/**
 * P5-60: reading a document on a phone. A PDF in an iframe cannot reflow, so
 * it gets a tall frame measured against the SMALL viewport (`svh`) — the
 * browser's chrome appearing must not crop it — and the reading tools (the
 * toggle, the find box, download and close) become 44 px controls.
 */
const VIEWER_SFC = readStyles('src/components/DocumentViewer.vue')
const VIEWER_PHONE = mediaBlock(VIEWER_SFC, 640)

describe('DocumentViewer — phone layout (P5-60)', () => {
  it('gives the PDF frame and the text pane 70svh', () => {
    expect(ruleFor(VIEWER_PHONE, '.doc-pdf')).toContain('height: 70svh')
    expect(ruleFor(VIEWER_PHONE, '.doc-text')).toContain('max-height: 70svh')
  })

  it('gives the find box the whole width and a readable counter', () => {
    const input = ruleFor(VIEWER_PHONE, '.doc-find-input')
    expect(input).toContain('flex: 1 1 100%')
    expect(input).toContain('min-height: 44px')
    // 16 px: anything smaller and iOS zooms the page when the field is tapped.
    expect(input).toContain('font-size: 16px')
    expect(ruleFor(VIEWER_PHONE, '.doc-find-count')).toContain('font-size: 0.95rem')
  })

  it('makes the bar’s controls 44 px targets', () => {
    const bar = ruleFor(VIEWER_PHONE, '.doc-back')
    expect(bar).toContain('min-height: 44px')
    expect(ruleFor(VIEWER_PHONE, '.doc-find-next')).toContain('min-height: 44px')
    expect(ruleFor(VIEWER_PHONE, '.doc-bar')).toContain('flex-wrap: wrap')
  })
})
