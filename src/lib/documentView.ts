/**
 * In-app document viewing (P5-44, extended by P5-46). Files are fetched
 * through the internal API (so the session cookie and API base are handled,
 * and it works under dev's SameSite=Lax where a cross-origin <iframe src>
 * would not) and rendered from a same-origin blob: URL. Only types a browser
 * renders WITHOUT running page script are framed; everything else is
 * download-only, mirroring the server's inline allowlist in
 * routes/libraryFile.ts.
 *
 * P5-46 adds the text the server extracted from a document: a Word or RTF
 * file the browser cannot render is shown as its text instead of "Preview
 * isn't available", and a PDF gets a "Text" view that can be searched.
 */
import { internalFetch } from './apiBase'
import { renderWikiMarkdown } from './renderMarkdown'

/** Whole file is pulled into memory to build the blob, so cap it. Bigger
 *  files fall back to a download link. */
export const VIEW_MAX_BYTES = 25 * 1024 * 1024

export type ViewKind = 'pdf' | 'image' | 'markdown' | 'text' | 'unsupported'

const EXT_KIND: Record<string, ViewKind> = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  md: 'markdown', markdown: 'markdown',
  txt: 'text', csv: 'text', tsv: 'text', json: 'text', geojson: 'text', log: 'text',
}

/** Formats a browser cannot render but the server can read the text of
 *  (P5-46). They stay `unsupported` as far as framing goes — we show their
 *  words, never the file itself. */
const TEXT_ONLY_EXT = new Set(['docx', 'rtf'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** How a file would render in-app, from its name alone. `unsupported` covers
 *  docx/xlsx/zip and anything a browser cannot show without a plugin. */
export function viewKind(name: string): ViewKind {
  return EXT_KIND[extensionOf(name)] ?? 'unsupported'
}

/** Whether the server holds extracted text for this file (P5-46). */
export function hasTextView(name: string): boolean {
  return TEXT_ONLY_EXT.has(extensionOf(name))
}

/** Whether opening this file in the viewer shows the reader anything at all —
 *  either the file itself, or the text pulled out of it. */
export function isViewable(name: string): boolean {
  return viewKind(name) !== 'unsupported' || hasTextView(name)
}

/** The entry's own manifest, not one of its files (P5-70). `meta.json` is
 *  what the reindexer reads; a `*.manifest.json` is the same thing under an
 *  older name. Neither is a document anybody asked to read, so they are kept
 *  out of the Files list and out of the counts. */
export function isManifestFile(name: string): boolean {
  const base = (name.split('/').pop() ?? name).toLowerCase()
  return base === 'meta.json' || base.endsWith('.manifest.json')
}

/** Reading order for the file a "Read" action opens: the document itself
 *  first (a PDF), then a file we can only show the words of, then plain text,
 *  and an image last — it is viewable, but it is rarely the thing the entry
 *  is about. */
function readingRank(name: string): number {
  const kind = viewKind(name)
  if (kind === 'pdf') return 0
  if (hasTextView(name)) return 1
  if (kind === 'markdown' || kind === 'text') return 2
  if (kind === 'image') return 3
  return Number.POSITIVE_INFINITY
}

/**
 * The file a "Read" action should open: the first viewable non-manifest file,
 * preferring PDF, then docx/rtf, then text (P5-70). Ties keep the order the
 * entry lists them in, so a two-PDF entry opens the first one.
 *
 * Takes the names the caller already computed rather than catalog rows, so
 * both the entry page and its tests can hand it plain strings.
 */
export function primaryViewableFile(files: string[]): string | null {
  let best: { name: string; rank: number } | null = null
  for (const name of files) {
    if (isManifestFile(name)) continue
    const rank = readingRank(name)
    if (!Number.isFinite(rank)) continue
    if (!best || rank < best.rank) best = { name, rank }
  }
  return best ? best.name : null
}

export interface LoadedDocument {
  kind: ViewKind
  /** Object URL for pdf/image kinds; caller must revoke it. */
  url?: string
  /** Rendered HTML (markdown) or raw text (text kinds). */
  text?: string
  html?: string
  /** Pages behind `text`, when it came from extraction. 1 for a format with
   *  no pages; absent when the text is the file itself. */
  pages?: number
  /** Set when the file is too big or the type isn't viewable. */
  fallback?: 'too-large' | 'unsupported'
  bytes?: number
}

function fileHref(slug: string, name: string): string {
  return `/api/library/file/${encodeURIComponent(slug)}/${encodeURIComponent(name)}?disposition=inline`
}

function textHref(slug: string, name: string): string {
  return `/api/library/text/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`
}

/** The line that separates one page from the next in a joined text view. It
 *  is also the scroll target for a `#page=N` link, so both sides of that
 *  contract are built from this one function. */
export function pageSeparator(page: number): string {
  return `— page ${page} —`
}

/** Matches a separator line and captures its page number. */
export const PAGE_SEPARATOR_RE = /^— page (\d+) —$/

export interface DocumentText {
  /** Pages the server found. 1 for a format that has no pages of its own. */
  pages: number
  /** Every page, joined. Separators appear only when there is more than one
   *  page — labelling a Word file "page 1" would invent a page it has not
   *  got. */
  text: string
}

/**
 * The text the server extracted from a document (P5-46). Rejects with a
 * reader-facing message when there is none: an unreadable scan, a file too
 * large to parse, or a format we hold no reader for.
 */
export async function loadDocumentText(slug: string, name: string): Promise<DocumentText> {
  const res = await internalFetch(textHref(slug, name))
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(
      (body && typeof body.error === 'string' && res.status === 415 ? body.error : '') ||
        `Could not load the text of this file (${res.status}).`,
    )
  }
  // A stored extraction failure comes back 200 with the reason in it — the
  // server records why a file could not be read rather than retrying forever.
  if (body && typeof body.error === 'string') throw new Error(body.error)
  const pages: { n: number; text: string }[] = Array.isArray(body?.pages) ? body.pages : []
  if (pages.length === 0) throw new Error('No text was found in this file.')
  const text =
    pages.length === 1
      ? pages[0].text
      : pages.map(page => `${pageSeparator(page.n)}\n${page.text}`).join('\n\n')
  return { pages: pages.length, text }
}

/** Fetch a file and prepare it for display. Never throws for an ordinary
 *  "can't preview this" case — those come back as a `fallback`. Real network
 *  or auth failures reject so the caller can show an error. */
export async function loadDocument(slug: string, name: string): Promise<LoadedDocument> {
  const kind = viewKind(name)
  if (kind === 'unsupported') {
    // A Word or RTF file: the browser cannot render it, but the server has
    // its words. Showing those beats "Preview isn't available".
    if (hasTextView(name)) {
      try {
        const extracted = await loadDocumentText(slug, name)
        return { kind: 'text', text: extracted.text, pages: extracted.pages }
      } catch {
        // No text either (a scan, or extraction failed) — fall through to the
        // download prompt, which is the only honest thing left to offer.
      }
    }
    return { kind, fallback: 'unsupported' }
  }

  const res = await internalFetch(fileHref(slug, name))
  if (!res.ok) throw new Error(`Could not load this file (${res.status}).`)

  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > VIEW_MAX_BYTES) {
    return { kind, fallback: 'too-large', bytes: declared }
  }

  if (kind === 'text' || kind === 'markdown') {
    const text = await res.text()
    if (text.length > VIEW_MAX_BYTES) return { kind, fallback: 'too-large', bytes: text.length }
    return kind === 'markdown' ? { kind, html: renderWikiMarkdown(text) } : { kind, text }
  }

  const blob = await res.blob()
  if (blob.size > VIEW_MAX_BYTES) return { kind, fallback: 'too-large', bytes: blob.size }
  return { kind, url: URL.createObjectURL(blob), bytes: blob.size }
}

// --- Find in document ----------------------------------------------------------

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, ch => ESCAPES[ch])
}

export interface RenderedText {
  /** HTML for the text pane: escaped text, `<mark>` per match, and a span per
   *  page separator so `#page=N` has something to scroll to. */
  html: string
  /** How many times the query appears. */
  count: number
}

interface Span {
  start: number
  end: number
  kind: 'page' | 'match'
  /** Page number, or the match's 0-based index. */
  value: number
}

/**
 * The text pane's HTML: matches wrapped in `<mark>` (the active one carries
 * `id="doc-hit"` so the viewer can scroll to it) and each page separator
 * wrapped in `<span id="doc-page-N">`.
 *
 * Built in one pass over disjoint spans rather than by chaining replaces:
 * escaping first would move every offset, and marking first would let a
 * search for "page" cut a separator line in half.
 */
export function renderDocumentText(
  text: string,
  options: { query?: string; active?: number } = {},
): RenderedText {
  const spans: Span[] = []
  // A search always has a current hit — "1 of 12" with nothing highlighted
  // would be a lie about where the reader is.
  const active = options.active ?? 0

  // Page separators first — they own their line, and a match inside one is
  // dropped below rather than allowed to break the anchor.
  const separators = new RegExp(PAGE_SEPARATOR_RE.source, 'gm')
  for (const match of text.matchAll(separators)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: 'page', value: Number(match[1]) })
  }

  const query = (options.query ?? '').trim()
  let count = 0
  if (query) {
    const needle = query.toLowerCase()
    const haystack = text.toLowerCase()
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      from = at + needle.length
      const overlapsSeparator = spans.some(s => s.kind === 'page' && at < s.end && at + needle.length > s.start)
      if (!overlapsSeparator) {
        spans.push({ start: at, end: at + needle.length, kind: 'match', value: count })
      }
      count++
    }
  }

  spans.sort((a, b) => a.start - b.start)
  let html = ''
  let cursor = 0
  for (const span of spans) {
    if (span.start < cursor) continue
    html += escapeHtml(text.slice(cursor, span.start))
    const inner = escapeHtml(text.slice(span.start, span.end))
    if (span.kind === 'page') {
      html += `<span class="doc-page-mark" id="doc-page-${span.value}">${inner}</span>`
    } else if (span.value === active) {
      html += `<mark class="doc-hit-active" id="doc-hit">${inner}</mark>`
    } else {
      html += `<mark>${inner}</mark>`
    }
    cursor = span.end
  }
  html += escapeHtml(text.slice(cursor))
  return { html, count }
}

/** The page a `#page=N` hash asks for, or null. Deep links from Ask (P5-46)
 *  carry it, and both the PDF frame and the text pane honour it. */
export function pageFromHash(hash: string): number | null {
  const match = /#?page=(\d+)/.exec(hash)
  if (!match) return null
  const page = Number(match[1])
  return page > 0 ? page : null
}
