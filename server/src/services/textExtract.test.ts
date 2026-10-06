import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'
import { makePdf, makeDocx, makeRtf, BROKEN_PDF } from '../testutils/fixtures/documents.js'

/**
 * P5-46 extraction: reading each format, the derived object's shape and key,
 * failure records, the size and page caps, the pending sweep's staleness
 * rule, and the reindex hook that drives it.
 */

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, getFile } = await import('./libraryBucket.js')
const { reindexCatalog, searchCatalog } = await import('./libraryCatalog.js')
const {
  toolFor,
  isExtractable,
  derivedKey,
  isDerivedKey,
  extractPages,
  extractFile,
  extractableFiles,
  extractPending,
  extractionSettled,
  installExtractionHook,
  readDerived,
  stripRtf,
  isFailure,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_PAGES,
  extractMaxBytes,
  extractMaxPages,
} = await import('./textExtract.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const PDF = makePdf([
  'Page one describes land loss across the Black Belt.',
  'Page two lists the cohort counties in Georgia.',
])
const DOCX = makeDocx(['The fact manual opens here.', 'Heirs property is the second paragraph.'])
const RTF = makeRtf(['Notes from the field visit.', 'Second paragraph of the notes.'])
const TXT = 'A plain note.\r\n\r\n\r\nWith  padded   spacing.  \n'

let fake: FakeS3
let dataDir: string

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-extract-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/documents/plan/Five_Year_Plan.pdf', PDF)
  fake.seed('library/documents/plan/Fact_Manual.docx', DOCX)
  fake.seed('library/documents/plan/Field_Notes.rtf', RTF)
  fake.seed('library/documents/plan/summary.txt', TXT)
  fake.seed('library/documents/plan/slides.pptx', 'not text we can read')
  fake.seed(
    'library/documents/plan/meta.json',
    JSON.stringify({ title: 'Strategic plan', category: 'strategy', status: 'published' }),
  )
  fake.seed('library/datasets/orgs/organizations.csv', 'Organization,State\nBlack Farmer Fund,NY\n')
  fake.seed('library/datasets/orgs/README.md', '# About this table\n\nOne row per organization.\n')
  fake.seed(
    'library/datasets/orgs/meta.json',
    JSON.stringify({ title: 'Organizations', category: 'network', status: 'published' }),
  )
})

afterEach(async () => {
  // The reindex hook starts a sweep detached from the request. Join it before
  // the bucket goes away, so no test's sweep can still be running during the
  // next one — and join it with `extractionSettled()`, which waits for a
  // sweep in flight, where `extractPending()` STARTED one when none was
  // running: a drain that re-parsed every fixture into the directory the next
  // line removes (P7-11).
  await extractionSettled()
  // The opt-in above lasts one test, so the seam goes back to its default:
  // under the runner, a reindex arms nothing.
  installExtractionHook({ detachedUnderTest: false })
  delete process.env.EXTRACT_MAX_BYTES
  delete process.env.EXTRACT_MAX_PAGES
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('which files we can read', () => {
  it('maps extensions to a reader and refuses the rest', () => {
    expect(toolFor('a.pdf')).toBe('pdfjs')
    expect(toolFor('a.DOCX')).toBe('mammoth')
    expect(toolFor('a.rtf')).toBe('rtf')
    expect(toolFor('a.txt')).toBe('text')
    expect(toolFor('a.md')).toBe('text')
    expect(toolFor('a.csv')).toBe('text')
    expect(toolFor('a.xlsx')).toBeNull()
    expect(toolFor('a.zip')).toBeNull()
    expect(toolFor('meta.json')).toBeNull()
    expect(toolFor('noext')).toBeNull()
    expect(isExtractable('a.pdf')).toBe(true)
    expect(isExtractable('a.png')).toBe(false)
  })

  it('names the derived object under library/derived/, outside every catalog prefix', () => {
    expect(derivedKey('plan', 'Five_Year_Plan.pdf')).toBe('library/derived/plan/Five_Year_Plan.pdf.txt.json')
    expect(isDerivedKey(derivedKey('plan', 'a.pdf'))).toBe(true)
    expect(isDerivedKey('library/documents/plan/a.pdf')).toBe(false)
  })

  it('reads the env caps with documented defaults', () => {
    expect(extractMaxBytes()).toBe(DEFAULT_MAX_BYTES)
    expect(extractMaxPages()).toBe(DEFAULT_MAX_PAGES)
    process.env.EXTRACT_MAX_BYTES = '1024'
    process.env.EXTRACT_MAX_PAGES = '2'
    expect(extractMaxBytes()).toBe(1024)
    expect(extractMaxPages()).toBe(2)
    process.env.EXTRACT_MAX_BYTES = 'nonsense'
    expect(extractMaxBytes()).toBe(DEFAULT_MAX_BYTES)
  })
})

describe('extractPages, per format', () => {
  it('reads a PDF one page at a time', async () => {
    const out = await extractPages(PDF, 'Five_Year_Plan.pdf')
    expect(out.tool).toBe('pdfjs')
    expect(out.pages.map(p => p.n)).toEqual([1, 2])
    expect(out.pages[0].text).toContain('land loss across the Black Belt')
    expect(out.pages[1].text).toContain('cohort counties in Georgia')
    expect(out.truncated).toBe(false)
  })

  it('stops at EXTRACT_MAX_PAGES and says it truncated', async () => {
    const out = await extractPages(makePdf(['One.', 'Two.', 'Three.']), 'long.pdf', 2)
    expect(out.pages).toHaveLength(2)
    expect(out.truncated).toBe(true)
  })

  it('does not call a document truncated when it ends exactly at the cap', async () => {
    const out = await extractPages(makePdf(['One.', 'Two.']), 'exact.pdf', 2)
    expect(out.pages).toHaveLength(2)
    expect(out.truncated).toBe(false)
  })

  it('reads a Word file as a single page (a .docx has no pages until it is laid out)', async () => {
    const out = await extractPages(DOCX, 'Fact_Manual.docx')
    expect(out.tool).toBe('mammoth')
    expect(out.pages).toHaveLength(1)
    expect(out.pages[0].n).toBe(1)
    expect(out.pages[0].text).toContain('The fact manual opens here.')
    expect(out.pages[0].text).toContain('Heirs property is the second paragraph.')
  })

  it('reads RTF by stripping its control words', async () => {
    const out = await extractPages(RTF, 'Field_Notes.rtf')
    expect(out.tool).toBe('rtf')
    expect(out.pages[0].text).toContain('Notes from the field visit.')
    expect(out.pages[0].text).toContain('Second paragraph of the notes.')
    // Nothing from the font table, colour table or generator destination.
    expect(out.pages[0].text).not.toMatch(/rtf1|fonttbl|Helvetica|Riched20|\\/)
  })

  it('passes plain text through, tidied', async () => {
    const out = await extractPages(Buffer.from(TXT, 'utf8'), 'summary.txt')
    expect(out.tool).toBe('text')
    expect(out.pages[0].text).toBe('A plain note.\n\nWith padded spacing.')
  })

  it('refuses a type it holds no reader for', async () => {
    await expect(extractPages(Buffer.from('x'), 'deck.pptx')).rejects.toThrow(/no text to pull out/i)
  })

  it('fails in plain language on a damaged PDF', async () => {
    await expect(extractPages(BROKEN_PDF, 'broken.pdf')).rejects.toThrow(/could not be read/i)
  })

  it('calls an empty result a scan rather than storing empty pages', async () => {
    await expect(extractPages(Buffer.from('   \n  '), 'blank.txt')).rejects.toThrow(/scan.*OCR/i)
  })
})

describe('stripRtf', () => {
  it('keeps the words and drops the markup', () => {
    const rtf = String.raw`{\rtf1\ansi{\fonttbl{\f0\fswiss Times;}}{\*\generator X;}\pard\f0\fs24 Caf\'e9 study\par Second line\par}`
    expect(stripRtf(rtf)).toBe('Café study\nSecond line')
  })

  it('unescapes literal braces and \\uNNNN characters (dropping their ASCII fallback)', () => {
    expect(stripRtf(String.raw`{\rtf1 a \{b\} c \u8212? d}`)).toBe('a {b} c — d')
  })
})

describe('extractFile — the derived object', () => {
  it('stores pages, chars, tool and the source size under the derived key', async () => {
    const record = await extractFile('plan', 'Five_Year_Plan.pdf', 'library/documents/plan/Five_Year_Plan.pdf', PDF.length)
    expect(isFailure(record)).toBe(false)
    if (isFailure(record)) throw new Error('unreachable')
    expect(record.tool).toBe('pdfjs')
    expect(record.pages).toHaveLength(2)
    expect(record.chars).toBe(record.pages[0].text.length + record.pages[1].text.length)
    expect(record.sourceSize).toBe(PDF.length)
    expect(record.sourceKey).toBe('library/documents/plan/Five_Year_Plan.pdf')
    expect(Date.parse(record.extractedAt)).not.toBeNaN()

    const stored = JSON.parse(
      (await getFile('library/derived/plan/Five_Year_Plan.pdf.txt.json')).toString('utf8'),
    )
    expect(stored).toEqual(record)
  })

  it('records { error } for a file it cannot read, so it is not retried forever', async () => {
    fake.seed('library/documents/plan/Five_Year_Plan.pdf', BROKEN_PDF)
    const record = await extractFile('plan', 'Five_Year_Plan.pdf', 'library/documents/plan/Five_Year_Plan.pdf', BROKEN_PDF.length)
    expect(isFailure(record)).toBe(true)
    if (!isFailure(record)) throw new Error('unreachable')
    expect(record.error).toMatch(/could not be read/i)
    expect(record.sourceSize).toBe(BROKEN_PDF.length)
    expect(await readDerived('plan', 'Five_Year_Plan.pdf')).toEqual(record)
  })

  it('records the size cap without ever reading the file', async () => {
    process.env.EXTRACT_MAX_BYTES = '10'
    fake.calls.length = 0
    const record = await extractFile('plan', 'Five_Year_Plan.pdf', 'library/documents/plan/Five_Year_Plan.pdf', 5_000_000)
    expect(isFailure(record)).toBe(true)
    if (!isFailure(record)) throw new Error('unreachable')
    expect(record.error).toMatch(/too large/i)
    expect(fake.calls.filter(c => c.startsWith('GetObjectCommand'))).toHaveLength(0)
  })

  it('readDerived returns null for a file never extracted', async () => {
    expect(await readDerived('plan', 'Five_Year_Plan.pdf')).toBeNull()
  })
})

describe('extractableFiles', () => {
  it('takes every readable file in a document entry and only the README of a dataset', async () => {
    await reindexCatalog()
    const entries = await searchCatalog({})
    const plan = entries.find(e => e.slug === 'plan')!
    const orgs = entries.find(e => e.slug === 'orgs')!
    expect(extractableFiles(plan).map(f => f.file).sort()).toEqual([
      'Fact_Manual.docx',
      'Field_Notes.rtf',
      'Five_Year_Plan.pdf',
      'summary.txt',
    ])
    // meta.json and .pptx hold no text we can read.
    expect(extractableFiles(plan).some(f => f.file === 'meta.json' || f.file === 'slides.pptx')).toBe(false)
    // A dataset's rows are searchable in the explorer; only its prose is here.
    expect(extractableFiles(orgs).map(f => f.file)).toEqual(['README.md'])
  })
})

describe('extractPending, and the reindex hook that drives it', () => {
  it('runs once per readable file on reindex and stores each result', async () => {
    await reindexCatalog()
    const summary = await extractPending()
    expect(summary.checked).toBe(5) // 4 in the document entry + the dataset README
    expect(summary.extracted + summary.skipped).toBe(5)

    for (const file of ['Five_Year_Plan.pdf', 'Fact_Manual.docx', 'Field_Notes.rtf', 'summary.txt']) {
      const derived = await readDerived('plan', file)
      expect(derived, file).not.toBeNull()
      expect(isFailure(derived!), file).toBe(false)
    }
    expect(await readDerived('orgs', 'README.md')).not.toBeNull()

    // One write per file, not one per sweep.
    const writes = fake.calls.filter(c => c.startsWith('PutObjectCommand:library/derived/'))
    expect(new Set(writes).size).toBe(writes.length)
    expect(writes).toHaveLength(5)
  })

  it('skips files already extracted at their current size', async () => {
    await reindexCatalog()
    await extractPending()
    fake.calls.length = 0
    const second = await extractPending()
    expect(second.skipped).toBe(5)
    expect(second.extracted).toBe(0)
    expect(fake.calls.filter(c => c.startsWith('PutObjectCommand'))).toHaveLength(0)
  })

  it('re-extracts a file whose size changed behind us', async () => {
    await reindexCatalog()
    await extractPending()
    const replacement = makePdf(['The replaced plan says something else entirely.'])
    expect(replacement.length).not.toBe(PDF.length)
    fake.seed('library/documents/plan/Five_Year_Plan.pdf', replacement)
    await reindexCatalog()

    const sweep = await extractPending()
    expect(sweep.extracted).toBe(1)
    expect(sweep.skipped).toBe(4)
    const derived = await readDerived('plan', 'Five_Year_Plan.pdf')
    if (!derived || isFailure(derived)) throw new Error('expected text')
    expect(derived.pages).toHaveLength(1)
    expect(derived.pages[0].text).toContain('replaced plan')
    expect(derived.sourceSize).toBe(replacement.length)
  })

  it('leaves derived objects out of the catalog — library/derived/ is not a kind prefix', async () => {
    await reindexCatalog()
    await extractPending()
    const before = (await searchCatalog({})).map(e => `${e.kind}:${e.slug}`).sort()
    await reindexCatalog()
    const entries = await searchCatalog({})
    const after = entries.map(e => `${e.kind}:${e.slug}`).sort()
    expect(after).toEqual(before)
    expect(after).toEqual(['dataset:orgs', 'document:plan'])
    // ... and the derived bytes never became one of the entry's own files.
    expect(entries.find(e => e.slug === 'plan')!.files.some(f => f.key.startsWith('library/derived/'))).toBe(false)
  })

  it('a reindex on its own extracts everything, once the hook is installed', async () => {
    // P7-11: the detached sweep is off under the runner unless a suite asks,
    // and this is the suite that tests the wiring, so it asks.
    installExtractionHook({ detachedUnderTest: true })
    await reindexCatalog()
    // Nothing below calls extractPending(): only the reindex hook can do this
    // work, so finding the text proves the hook is wired. `extractionSettled`
    // joins the sweep the hook launched without starting one of its own —
    // deterministic, where polling for twenty seconds was a guess at how long
    // a PDF parse takes on a loaded box.
    await extractionSettled()
    expect(await readDerived('plan', 'summary.txt')).not.toBeNull()
    expect(await readDerived('plan', 'Five_Year_Plan.pdf')).not.toBeNull()
  })

  it('is a no-op when the bucket is disabled', async () => {
    await reindexCatalog()
    await extractionSettled() // join any sweep in flight before closing
    await closeLibraryBucket()
    const summary = await extractPending()
    expect(summary).toMatchObject({ checked: 0, extracted: 0, skipped: 0 })
    // Re-open so afterEach's close is symmetric.
    await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  })
})
