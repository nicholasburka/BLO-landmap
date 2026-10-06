import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/apiBase', () => ({ internalFetch: vi.fn() }))
vi.mock('@/lib/renderMarkdown', () => ({ renderWikiMarkdown: (md: string) => `<rendered>${md}</rendered>` }))

import { internalFetch } from '@/lib/apiBase'
import {
  viewKind,
  isViewable,
  hasTextView,
  loadDocument,
  loadDocumentText,
  pageSeparator,
  pageFromHash,
  primaryViewableFile,
  isManifestFile,
  renderDocumentText,
  VIEW_MAX_BYTES,
} from '../documentView'

const mockFetch = vi.mocked(internalFetch)

function res(body: { blob?: Blob; text?: string }, headers: Record<string, string> = {}, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body.text ?? '',
    blob: async () => body.blob ?? new Blob([]),
  } as unknown as Response
}

/** A JSON response from the text route. */
function jsonRes(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response
}

beforeEach(() => {
  mockFetch.mockReset()
  // jsdom lacks createObjectURL/revokeObjectURL
  ;(URL as any).createObjectURL = vi.fn(() => 'blob:mock')
  ;(URL as any).revokeObjectURL = vi.fn()
})
afterEach(() => { vi.restoreAllMocks() })

describe('viewKind', () => {
  it('classifies by extension', () => {
    expect(viewKind('a.pdf')).toBe('pdf')
    expect(viewKind('b.PNG')).toBe('image')
    expect(viewKind('c.md')).toBe('markdown')
    expect(viewKind('d.csv')).toBe('text')
    expect(viewKind('e.json')).toBe('text')
    expect(viewKind('f.docx')).toBe('unsupported')
    expect(viewKind('g.zip')).toBe('unsupported')
    expect(viewKind('noext')).toBe('unsupported')
  })

  it('opens the formats whose text the server extracts, though it cannot frame them (P5-46)', () => {
    expect(hasTextView('a.docx')).toBe(true)
    expect(hasTextView('a.rtf')).toBe(true)
    expect(hasTextView('a.pdf')).toBe(false)
    expect(hasTextView('a.zip')).toBe(false)
    expect(isViewable('a.pdf')).toBe(true)
    expect(isViewable('a.docx')).toBe(true)
    expect(isViewable('a.rtf')).toBe(true)
    expect(isViewable('a.zip')).toBe(false)
    expect(isViewable('a.xlsx')).toBe(false)
  })
})

describe('isManifestFile (P5-70)', () => {
  it('knows the entry manifest from the entry\u2019s own files', () => {
    expect(isManifestFile('meta.json')).toBe(true)
    expect(isManifestFile('META.JSON')).toBe(true)
    expect(isManifestFile('organizations.manifest.json')).toBe(true)
    expect(isManifestFile('sub/meta.json')).toBe(true)
    expect(isManifestFile('data.json')).toBe(false)
    expect(isManifestFile('metadata.json')).toBe(false)
    expect(isManifestFile('plan.pdf')).toBe(false)
  })
})

describe('primaryViewableFile (P5-70)', () => {
  it('prefers a PDF, then a Word/RTF file, then text', () => {
    expect(primaryViewableFile(['notes.txt', 'plan.pdf'])).toBe('plan.pdf')
    expect(primaryViewableFile(['notes.txt', 'plan.docx'])).toBe('plan.docx')
    expect(primaryViewableFile(['notes.txt', 'plan.rtf'])).toBe('plan.rtf')
    expect(primaryViewableFile(['cover.png', 'notes.md'])).toBe('notes.md')
  })

  it('keeps list order between files of the same rank', () => {
    expect(primaryViewableFile(['a.pdf', 'b.pdf'])).toBe('a.pdf')
  })

  it('never opens a manifest, and gives up when nothing is readable', () => {
    expect(primaryViewableFile(['meta.json', 'plan.pdf'])).toBe('plan.pdf')
    expect(primaryViewableFile(['meta.json'])).toBeNull()
    expect(primaryViewableFile(['deck.pptx', 'rows.xlsx'])).toBeNull()
    expect(primaryViewableFile([])).toBeNull()
  })
})

describe('loadDocument', () => {
  it('does not even fetch a type with nothing to show', async () => {
    const out = await loadDocument('plan', 'deck.pptx')
    expect(out).toEqual({ kind: 'unsupported', fallback: 'unsupported' })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('reads text files as text and requests inline', async () => {
    mockFetch.mockResolvedValue(res({ text: 'a,b\n1,2\n' }, { 'content-length': '8' }))
    const out = await loadDocument('orgs', 'data.csv')
    expect(mockFetch).toHaveBeenCalledWith('/api/library/file/orgs/data.csv?disposition=inline')
    expect(out.kind).toBe('text')
    expect(out.text).toBe('a,b\n1,2\n')
  })

  it('renders markdown through the wiki renderer', async () => {
    mockFetch.mockResolvedValue(res({ text: '# Hi' }, {}))
    const out = await loadDocument('guide', 'readme.md')
    expect(out.kind).toBe('markdown')
    expect(out.html).toBe('<rendered># Hi</rendered>')
  })

  it('builds a blob url for pdf and image', async () => {
    mockFetch.mockResolvedValue(res({ blob: new Blob(['%PDF']) }, {}))
    const out = await loadDocument('plan', 'plan.pdf')
    expect(out.kind).toBe('pdf')
    expect(out.url).toBe('blob:mock')
  })

  it('falls back to a download when the file is too large (by header)', async () => {
    mockFetch.mockResolvedValue(res({ blob: new Blob([]) }, { 'content-length': String(VIEW_MAX_BYTES + 1) }))
    const out = await loadDocument('plan', 'huge.pdf')
    expect(out.fallback).toBe('too-large')
    expect(out.url).toBeUndefined()
  })

  it('throws on an auth/network failure', async () => {
    mockFetch.mockResolvedValue(res({}, {}, false, 401))
    await expect(loadDocument('plan', 'plan.pdf')).rejects.toThrow(/could not load/i)
  })

  it('shows a Word file as its extracted text instead of "no preview" (P5-46)', async () => {
    mockFetch.mockResolvedValue(jsonRes({ pages: [{ n: 1, text: 'Heirs property, defined.' }], tool: 'mammoth' }))
    const out = await loadDocument('plan', 'Fact_Manual.docx')
    expect(mockFetch).toHaveBeenCalledWith('/api/library/text/plan/Fact_Manual.docx')
    expect(out.kind).toBe('text')
    expect(out.text).toBe('Heirs property, defined.')
    expect(out.pages).toBe(1)
  })

  it('falls back to the download prompt when a Word file has no text either', async () => {
    mockFetch.mockResolvedValue(jsonRes({ error: 'This file is most likely a scan.' }))
    const out = await loadDocument('plan', 'Scan.docx')
    expect(out).toEqual({ kind: 'unsupported', fallback: 'unsupported' })
  })
})

describe('loadDocumentText', () => {
  it('joins pages with a separator only when there is more than one', async () => {
    mockFetch.mockResolvedValue(
      jsonRes({ pages: [{ n: 1, text: 'One.' }, { n: 2, text: 'Two.' }], tool: 'pdfjs' }),
    )
    const out = await loadDocumentText('plan', 'plan.pdf')
    expect(out.pages).toBe(2)
    expect(out.text).toBe(`${pageSeparator(1)}\nOne.\n\n${pageSeparator(2)}\nTwo.`)
  })

  it('leaves a single page unlabelled — a Word file has no page 1 to name', async () => {
    mockFetch.mockResolvedValue(jsonRes({ pages: [{ n: 1, text: 'Just this.' }] }))
    expect((await loadDocumentText('plan', 'a.docx')).text).toBe('Just this.')
  })

  it('rejects with the stored reason when extraction failed', async () => {
    mockFetch.mockResolvedValue(jsonRes({ error: 'This PDF is password-protected, so its text cannot be read.' }))
    await expect(loadDocumentText('plan', 'locked.pdf')).rejects.toThrow(/password-protected/)
  })

  it('rejects with the server\'s reason for an unreadable type, and a status otherwise', async () => {
    mockFetch.mockResolvedValue(jsonRes({ error: 'There is no text to pull out of this kind of file.' }, false, 415))
    await expect(loadDocumentText('plan', 'deck.pptx')).rejects.toThrow(/no text to pull out/)
    mockFetch.mockResolvedValue(jsonRes(null, false, 500))
    await expect(loadDocumentText('plan', 'plan.pdf')).rejects.toThrow(/\(500\)/)
  })
})

describe('renderDocumentText', () => {
  it('escapes the document — nothing in a file can become markup', () => {
    const { html } = renderDocumentText('<script>alert(1)</script> & "quotes"')
    expect(html).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;')
  })

  it('marks every match case-insensitively and counts them', () => {
    const { html, count } = renderDocumentText('Land loss and more land.', { query: 'LAND' })
    expect(count).toBe(2)
    expect(html).toBe('<mark class="doc-hit-active" id="doc-hit">Land</mark> loss and more <mark>land</mark>.')
  })

  it('moves the active mark, so "3 of 12" points at something', () => {
    const { html } = renderDocumentText('a a a', { query: 'a', active: 2 })
    expect(html).toBe('<mark>a</mark> <mark>a</mark> <mark class="doc-hit-active" id="doc-hit">a</mark>')
  })

  it('gives every page separator an id for #page=N to scroll to', () => {
    const text = `${pageSeparator(1)}\nOne.\n\n${pageSeparator(2)}\nTwo.`
    const { html } = renderDocumentText(text)
    expect(html).toContain('<span class="doc-page-mark" id="doc-page-1">— page 1 —</span>')
    expect(html).toContain('<span class="doc-page-mark" id="doc-page-2">— page 2 —</span>')
  })

  it('counts a match inside a separator but never breaks the anchor open', () => {
    const text = `${pageSeparator(1)}\npage of notes`
    const { html, count } = renderDocumentText(text, { query: 'page' })
    expect(count).toBe(2)
    expect(html).toContain('<span class="doc-page-mark" id="doc-page-1">— page 1 —</span>')
    expect(html).toContain('<mark>page</mark> of notes')
  })

  it('reports no matches for a query the document does not hold', () => {
    expect(renderDocumentText('nothing here', { query: 'zebra' }).count).toBe(0)
  })
})

describe('pageFromHash', () => {
  it('reads the page an Ask citation asked for', () => {
    expect(pageFromHash('#page=12')).toBe(12)
    expect(pageFromHash('page=1')).toBe(1)
    expect(pageFromHash('#page=0')).toBeNull()
    expect(pageFromHash('#tab=files')).toBeNull()
    expect(pageFromHash('')).toBeNull()
  })
})
