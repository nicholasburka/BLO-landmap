import { getFile, putFile, isBucketEnabled, isSafeKey } from './libraryBucket.js'
import { searchCatalog, onReindex, type CatalogEntryRow } from './libraryCatalog.js'
import { reportsDetachedWork } from './detachedWork.js'

/**
 * Document text extraction (P5-46).
 *
 * Ask (P5-41) could read manifests and wiki pages but not the documents
 * themselves, so the PDFs and Word files that hold most of what the team
 * actually knows were opaque. This module pulls their text out once, per
 * page, and parks it in the bucket beside everything else.
 *
 * Why a derived object rather than a column or an in-memory cache:
 *  - the API host has ephemeral disk and may restart mid-day; re-parsing
 *    every PDF on every boot would be minutes of CPU for an identical result;
 *  - the bucket is already the source of truth and is versioned, so derived
 *    text survives, restores and rolls back like the files it came from;
 *  - `library/derived/` is not one of the catalog's kind prefixes, so a
 *    reindex walks straight past it — no phantom entries (pinned by a test).
 *
 * Storage: `library/derived/<slug>/<file>.txt.json`, holding either
 *   { pages: [{ n, text }], chars, extractedAt, tool, sourceSize, sourceKey }
 * or, when the file cannot be read,
 *   { error, extractedAt, sourceSize }
 * A failure is recorded rather than retried forever: an encrypted or scanned
 * PDF will not become readable on the next reindex, and OCR is out of scope
 * for v1.
 *
 * When it runs: after every reindex (fire-and-forget, one file at a time so a
 * rebuild cannot pin the box), and on demand from GET /api/library/text/...
 * when a reader opens a file we have not seen yet.
 */

// --- Configuration -------------------------------------------------------------

/** Files bigger than this are recorded as too large rather than parsed. A
 *  200 MB scan would hold the event loop for minutes and yield nothing. */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
/** Pages read from one document. Past this a "document" is a data dump. */
export const DEFAULT_MAX_PAGES = 400

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback
}

export function extractMaxBytes(): number {
  return envInt('EXTRACT_MAX_BYTES', DEFAULT_MAX_BYTES)
}

export function extractMaxPages(): number {
  return envInt('EXTRACT_MAX_PAGES', DEFAULT_MAX_PAGES)
}

/** Characters kept per page. Real prose does not exceed this; text that does
 *  is a parser artefact (a font table read as glyphs, say). */
const MAX_CHARS_PER_PAGE = 20_000
/** Characters kept per document, so one file cannot produce a derived object
 *  much larger than the file it came from. */
const MAX_CHARS_TOTAL = 1_500_000

// --- What we can read ----------------------------------------------------------

export type ExtractTool = 'pdfjs' | 'mammoth' | 'rtf' | 'text'

const TOOL_BY_EXT: Record<string, ExtractTool> = {
  pdf: 'pdfjs',
  docx: 'mammoth',
  rtf: 'rtf',
  txt: 'text',
  md: 'text',
  markdown: 'text',
  csv: 'text',
}

/** Which reader handles this filename, or null when we hold no text for it
 *  (.xlsx, .zip, images, meta.json ...). */
export function toolFor(name: string): ExtractTool | null {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return null
  return TOOL_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null
}

export function isExtractable(name: string): boolean {
  return toolFor(name) !== null
}

// --- Storage layout ------------------------------------------------------------

export const DERIVED_PREFIX = 'library/derived/'

/** Where a file's text lives. Deliberately NOT under the entry's own folder:
 *  derived bytes must never look like content a dev pushed, and the catalog
 *  must never index them. */
export function derivedKey(slug: string, file: string): string {
  return `${DERIVED_PREFIX}${slug}/${file}.txt.json`
}

export function isDerivedKey(key: string): boolean {
  return key.startsWith(DERIVED_PREFIX)
}

export interface ExtractedPage {
  n: number
  text: string
}

export interface ExtractedText {
  pages: ExtractedPage[]
  chars: number
  extractedAt: string
  tool: ExtractTool
  /** Size of the source file when this was extracted — the staleness check. */
  sourceSize: number
  sourceKey: string
  /** Set when pages were dropped at the page or character cap. */
  truncated?: boolean
}

export interface ExtractionFailure {
  /** Plain language, shown to the reader as-is. */
  error: string
  extractedAt: string
  sourceSize: number
}

export type DerivedText = ExtractedText | ExtractionFailure

export function isFailure(derived: DerivedText): derived is ExtractionFailure {
  return typeof (derived as ExtractionFailure).error === 'string'
}

// --- Readers -------------------------------------------------------------------

/** One pass of tidying that every reader's output goes through: no CRLF, no
 *  trailing spaces, no runs of blank lines. Chunking and find-in-document
 *  both get simpler when whitespace is boring. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** RTF groups that describe the document rather than say anything: the font,
 *  colour and style tables, embedded pictures, and every `\*` destination
 *  (generator strings, revision tables, custom XML). */
const RTF_NON_TEXT_GROUP =
  /^\\(?:\*|(?:fonttbl|colortbl|stylesheet|listtable|listoverridetable|revtbl|info|pict|themedata|latentstyles|datastore|xmlnstbl)\b)/

/** Escaped characters survive the control-word sweep as these placeholders —
 *  private-use code points, so nothing in a real document collides. */
const LITERAL: Record<string, string> = { '{': '\uE000', '}': '\uE001', '\\': '\uE002' }

/**
 * RTF without an RTF parser: the format is control words, groups, and the
 * text between them. One pass drops the groups that hold no prose (they
 * nest, which is why this scans rather than pattern-matches); a handful of
 * replacements then turn the escapes into characters and delete the control
 * words, leaving the document's words in order — which is all the index and
 * the reader need. Exported for its own test.
 */
export function stripRtf(rtf: string): string {
  let text = ''
  let depth = 0
  // The depth of the non-text group we are inside, or -1 when we are in prose.
  let skipDepth = -1
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i]
    const next = rtf[i + 1]
    if (ch === '\\' && (next === '{' || next === '}' || next === '\\')) {
      // An escaped brace or backslash is a character, not markup.
      if (skipDepth === -1) text += LITERAL[next]
      i++
      continue
    }
    if (ch === '{') {
      depth++
      if (skipDepth === -1 && RTF_NON_TEXT_GROUP.test(rtf.slice(i + 1, i + 24))) skipDepth = depth
      continue
    }
    if (ch === '}') {
      if (skipDepth === depth) skipDepth = -1
      depth--
      continue
    }
    if (skipDepth === -1) text += ch
  }

  // Escapes that carry a character: \'hh (a code-page byte) and \uNNNN, whose
  // trailing ASCII fallback character has to go with it.
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  text = text.replace(/\\u(-?\d+) ?\??/g, (_m, code: string) => {
    const n = Number(code)
    return String.fromCharCode(n < 0 ? n + 65536 : n)
  })
  // Breaks, then every remaining control word (optional numeric argument, one
  // optional trailing space) and control symbol.
  text = text.replace(/\\(?:par|line|sect|page)\b/g, '\n').replace(/\\tab\b/g, '\t')
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, '')
  text = text.replace(/\\[^a-zA-Z]/g, '')
  for (const [literal, placeholder] of Object.entries(LITERAL)) {
    text = text.split(placeholder).join(literal)
  }
  return tidy(text)
}

/** Text pdf.js found on one page. Items are runs of glyphs in reading order;
 *  `hasEOL` is the only line information the format gives us. */
function pageTextFromItems(items: unknown[]): string {
  let out = ''
  for (const item of items) {
    const run = item as { str?: unknown; hasEOL?: unknown }
    if (typeof run.str !== 'string') continue
    out += run.str
    if (run.hasEOL === true) out += '\n'
  }
  return out
}

async function extractPdf(
  buffer: Buffer,
  maxPages: number,
): Promise<{ pages: ExtractedPage[]; truncated: boolean }> {
  // The legacy build is the one that runs under Node without a DOM. Imported
  // lazily so a boot that never opens a PDF never pays for it.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdf.js takes ownership of the array it is handed, so give it a copy —
  // the caller still needs the Buffer.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // Nothing stored in the library may run script in this process.
    isEvalSupported: false,
  }).promise
  try {
    const pages: ExtractedPage[] = []
    let chars = 0
    const limit = Math.min(doc.numPages, maxPages)
    for (let n = 1; n <= limit; n++) {
      const page = await doc.getPage(n)
      try {
        const content = await page.getTextContent()
        const text = tidy(pageTextFromItems(content.items)).slice(0, MAX_CHARS_PER_PAGE)
        pages.push({ n, text })
        chars += text.length
      } finally {
        page.cleanup()
      }
      if (chars > MAX_CHARS_TOTAL) break
    }
    // Truncated only when pages were actually left unread — a document that
    // is exactly EXTRACT_MAX_PAGES long is complete, not cut off.
    return { pages, truncated: pages.length < doc.numPages }
  } finally {
    await doc.destroy()
  }
}

async function extractDocx(buffer: Buffer): Promise<ExtractedPage[]> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer })
  // A .docx has no pages until something lays it out, so it is one page.
  return [{ n: 1, text: tidy(result.value).slice(0, MAX_CHARS_TOTAL) }]
}

/** Read a file's text, page by page where the format has pages. Throws with a
 *  reader-facing message when the file cannot be read at all. */
export async function extractPages(
  buffer: Buffer,
  name: string,
  maxPages = extractMaxPages(),
): Promise<{ pages: ExtractedPage[]; tool: ExtractTool; truncated: boolean }> {
  const tool = toolFor(name)
  if (!tool) throw new Error('There is no text to pull out of this kind of file.')

  let pages: ExtractedPage[]
  // Only a paginated format can be cut short by the page cap.
  let truncated = false
  if (tool === 'pdfjs') {
    try {
      ;({ pages, truncated } = await extractPdf(buffer, maxPages))
    } catch (err: any) {
      if (err?.name === 'PasswordException') {
        throw new Error('This PDF is password-protected, so its text cannot be read.')
      }
      throw new Error(`This PDF could not be read (${err?.message || 'damaged or unsupported'}).`)
    }
  } else if (tool === 'mammoth') {
    try {
      pages = await extractDocx(buffer)
    } catch (err: any) {
      throw new Error(`This Word file could not be read (${err?.message || 'damaged or unsupported'}).`)
    }
  } else if (tool === 'rtf') {
    pages = [{ n: 1, text: stripRtf(buffer.toString('latin1')).slice(0, MAX_CHARS_TOTAL) }]
  } else {
    pages = [{ n: 1, text: tidy(buffer.toString('utf8')).slice(0, MAX_CHARS_TOTAL) }]
  }

  const chars = pages.reduce((sum, page) => sum + page.text.length, 0)
  if (chars === 0) {
    // Almost always a scan: pages of images with no text layer. Say so, in
    // the words the reader needs, rather than storing empty pages that would
    // make the file look indexed when it is not.
    throw new Error(
      'No text was found in this file. It is most likely a scan — reading scanned pages needs OCR, which is not available yet.',
    )
  }
  return { pages, tool, truncated }
}

// --- Derived objects -----------------------------------------------------------

async function writeDerived(slug: string, file: string, record: DerivedText): Promise<void> {
  const key = derivedKey(slug, file)
  if (!isSafeKey(key)) throw new Error(`unsafe derived key: ${JSON.stringify(key)}`)
  await putFile(key, JSON.stringify(record), 'application/json')
}

/** The stored text for a file, or null when we have never extracted it.
 *  Never extracts: callers that want that call extractFile() explicitly, so
 *  an index build can never turn into a parsing job. */
export async function readDerived(slug: string, file: string): Promise<DerivedText | null> {
  const key = derivedKey(slug, file)
  if (!isSafeKey(key)) return null
  try {
    const parsed = JSON.parse((await getFile(key)).toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as DerivedText
  } catch {
    /* missing, or written in an older shape — treat as "not extracted" */
  }
  return null
}

/** Extract one file and store the result (text or error). Returns what it
 *  stored. */
export async function extractFile(
  slug: string,
  file: string,
  sourceKey: string,
  sourceSize: number,
): Promise<DerivedText> {
  const extractedAt = new Date().toISOString()
  const maxBytes = extractMaxBytes()
  if (sourceSize > maxBytes) {
    const record: ExtractionFailure = {
      error:
        `This file is too large to pull text from here (${Math.max(1, Math.round(sourceSize / 1024 / 1024))} MB; ` +
        `the limit is ${Math.max(1, Math.round(maxBytes / 1024 / 1024))} MB). Download it to read it.`,
      extractedAt,
      sourceSize,
    }
    await writeDerived(slug, file, record)
    return record
  }
  try {
    // Fresh: the mirror is a cache keyed by name, and this path runs exactly
    // when the catalog says the file's size changed — the mirrored copy may
    // be the very version we already extracted.
    const buffer = await getFile(sourceKey, { fresh: true })
    const { pages, tool, truncated } = await extractPages(buffer, file)
    const record: ExtractedText = {
      pages,
      chars: pages.reduce((sum, page) => sum + page.text.length, 0),
      extractedAt,
      tool,
      sourceSize,
      sourceKey,
      ...(truncated ? { truncated: true } : {}),
    }
    await writeDerived(slug, file, record)
    return record
  } catch (err: any) {
    const record: ExtractionFailure = {
      error: err?.message || 'This file could not be read.',
      extractedAt,
      sourceSize,
    }
    await writeDerived(slug, file, record)
    return record
  }
}

// --- Sweeping the catalog ------------------------------------------------------

const README_NAMES = new Set(['readme.md', 'readme.txt', 'readme'])

/** Basename inside the entry folder (same rule as the file routes). */
export function basenameInEntry(key: string): string {
  return key.split('/').slice(3).join('/') || key
}

export interface ExtractCandidate {
  slug: string
  file: string
  key: string
  size: number
}

/**
 * Files whose text is worth holding: everything readable inside a document
 * entry or an incoming drop, plus a dataset folder's README — the prose that
 * says what the table is. A dataset's data files are already searchable
 * through the table explorer, so parsing them here would only duplicate them.
 */
export function extractableFiles(entry: CatalogEntryRow): ExtractCandidate[] {
  const wholeEntry = entry.kind === 'document' || entry.kind === 'incoming'
  if (!wholeEntry && entry.kind !== 'dataset') return []
  const out: ExtractCandidate[] = []
  for (const file of entry.files ?? []) {
    const name = basenameInEntry(file.key)
    if (!isExtractable(name)) continue
    if (!wholeEntry && !README_NAMES.has(name.toLowerCase())) continue
    if (!isSafeKey(derivedKey(entry.slug, name))) continue
    out.push({ slug: entry.slug, file: name, key: file.key, size: file.size })
  }
  return out
}

export interface ExtractSummary {
  /** Files considered. */
  checked: number
  /** Files whose text we stored this run. */
  extracted: number
  /** Of those, the ones that stored an error instead of text. */
  failed: number
  /** Files already extracted at their current size. */
  skipped: number
  ms: number
}

const EMPTY_SUMMARY: ExtractSummary = { checked: 0, extracted: 0, failed: 0, skipped: 0, ms: 0 }

/** Hooks run after a sweep that stored something new — the ask index holds
 *  document pages, so it has to know they arrived. Registered by the module
 *  that owns the cache, so this one stays ignorant of it. */
const extractedHooks: Array<() => void> = []
export function onExtracted(hook: () => void): void {
  extractedHooks.push(hook)
}

let inFlightSweep: Promise<ExtractSummary> | null = null

/**
 * Extract every document whose text is missing or stale (its stored
 * `sourceSize` no longer matches the catalog's). Sequential on purpose: a PDF
 * parse is CPU- and memory-heavy, and this shares a box with the public map.
 *
 * Never rejects — it runs detached from a reindex, where an unhandled
 * rejection would take the process with it.
 */
export function extractPending(): Promise<ExtractSummary> {
  if (!inFlightSweep) {
    inFlightSweep = runSweep().finally(() => {
      inFlightSweep = null
    })
  }
  return inFlightSweep
}

/**
 * Resolves when a detached sweep is done — and starts nothing if none is
 * running (P7-11). `extractPending()` cannot do this job: called when the
 * sweep is idle it begins one, so a teardown that used it as a drain wrote
 * MORE files into the directory it was about to delete.
 */
export function extractionSettled(): Promise<void> {
  return (inFlightSweep ?? Promise.resolve()).then(
    () => undefined,
    () => undefined,
  )
}

reportsDetachedWork(extractionSettled)

async function runSweep(): Promise<ExtractSummary> {
  if (!isBucketEnabled()) return { ...EMPTY_SUMMARY }
  const started = Date.now()
  const summary: ExtractSummary = { ...EMPTY_SUMMARY }
  try {
    const entries = await searchCatalog({})
    for (const entry of entries) {
      for (const candidate of extractableFiles(entry)) {
        // Checked between files, not just at the start: a sweep outlives the
        // reindex that launched it, and the process may be shutting down.
        if (!isBucketEnabled()) break
        summary.checked++
        try {
          const existing = await readDerived(candidate.slug, candidate.file)
          if (existing && existing.sourceSize === candidate.size) {
            summary.skipped++
            continue
          }
          const record = await extractFile(candidate.slug, candidate.file, candidate.key, candidate.size)
          summary.extracted++
          if (isFailure(record)) summary.failed++
        } catch (err: any) {
          // A bucket hiccup on one file must not end the sweep.
          summary.failed++
          console.warn(`[library] text extraction skipped ${candidate.key}: ${err?.message || err}`)
        }
      }
    }
  } catch (err: any) {
    console.warn(`[library] text extraction sweep failed: ${err?.message || err}`)
  }
  summary.ms = Date.now() - started
  if (summary.extracted > 0) {
    for (const hook of extractedHooks) {
      try {
        hook()
      } catch (err: any) {
        console.warn(`[library] text extraction hook failed: ${err?.message || err}`)
      }
    }
  }
  console.log(
    `[library] text extraction: ${summary.extracted} extracted (${summary.failed} unreadable), ` +
      `${summary.skipped} already current, ${summary.checked} checked in ${summary.ms}ms.`,
  )
  return summary
}

let hookInstalled = false
let sweepDetachedUnderTest = false

/**
 * Sweep after every reindex — a reindex may have brought in new files or
 * replaced old ones. Detached on purpose: reindex answers an HTTP request,
 * and parsing a shelf of PDFs must never be what that request waits for.
 *
 * Called by the text route (the server's extraction entry point) rather than
 * on import, so that importing this module for `readDerived` alone — as the
 * ask index and the sync CLI do — costs nothing. `library push` reindexes
 * too, and it must stay a file-transfer command, not a job that parses every
 * PDF in the library on someone's laptop. Idempotent.
 *
 * P7-11: under a test runner the sweep does NOT start unless the suite asked
 * for it — `linkFetchQueue`'s `seamMissing` rule, and for the same reason
 * turned one step further. Every route suite installs this hook by importing
 * the app, and every reindex then launches a writer that resolves `dataDir`
 * when it writes rather than when it started: it lands in whichever temp
 * mirror is current, which is the next test's, or it is still recreating
 * directories while this test's afterEach removes them (`ENOTEMPTY`). No
 * afterEach can fix that from outside — a setup file's runs AFTER the test
 * file's — so the work must not begin. The suites that mean to exercise
 * extraction already await `extractPending()` themselves, and the one that
 * tests this wiring passes `detachedUnderTest`.
 */
export function installExtractionHook(options: { detachedUnderTest?: boolean } = {}): void {
  // Read before the idempotence guard: the route installs the hook at import,
  // so a suite that asks for detached sweeps is always the second caller.
  if (options.detachedUnderTest !== undefined) sweepDetachedUnderTest = options.detachedUnderTest
  if (hookInstalled) return
  hookInstalled = true
  onReindex(() => {
    if (process.env.VITEST && !sweepDetachedUnderTest) return
    void extractPending()
  })
}
