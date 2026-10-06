import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-80: pulling the documents ON a page into the entry.
 *
 * The bucket is FakeS3, Postgres is pg-mem, DNS is a fake resolver and the
 * agency is a fake fetch — so the subset rule, the caps, the naming, the
 * per-file failures and the local extraction are all asserted without a byte
 * leaving the machine. Nothing here may ask a model anything.
 */

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, getFile } = await import('./libraryBucket.js')
const { indexFileBackedEntry, getCatalogEntry } = await import('./libraryCatalog.js')
const { readDerived, isFailure } = await import('./textExtract.js')
const {
  pullDocuments,
  documentFilename,
  uniqueFilename,
  setDocumentPullDefaults,
  resetDocumentPullDefaults,
  PULL_MAX_FILES,
} = await import('./documentPull.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: FakeS3
let dataDir: string

const lookup = async (host: string) =>
  host === 'intranet.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]

const PAGE = 'https://land.example.org/profiles/'
const JONES = 'https://land.example.org/files/jones-farm.pdf'
const SMITH = 'https://land.example.org/files/smith-woodlot.pdf'
const MINUTES = 'https://land.example.org/files/minutes.rtf'
const HUGE = 'https://land.example.org/files/atlas.pdf'
const GONE = 'https://land.example.org/files/missing.pdf'
const LOGIN = 'https://land.example.org/files/members-only.pdf'

const RTF = '{\\rtf1\\ansi The trustees met on the ninth of September.}'

/** One agency: a PDF for the profiles, an RTF for the minutes, a login page
 *  where a document was promised, a 404, and an atlas that declares itself
 *  enormous without sending a byte. */
function agency(): typeof fetch {
  return vi.fn(async (input: any) => {
    const url = String(input)
    if (url === GONE) return new Response('nope', { status: 404 })
    if (url === LOGIN) return new Response('<html><body>Sign in</body></html>', { headers: { 'content-type': 'text/html' } })
    if (url === HUGE) {
      return new Response('x', {
        headers: { 'content-type': 'application/pdf', 'content-length': String(500 * 1024 * 1024) },
      })
    }
    if (url.endsWith('.rtf')) return new Response(RTF, { headers: { 'content-type': 'application/rtf' } })
    return new Response(`%PDF-1.4 ${url}`, { headers: { 'content-type': 'application/pdf' } })
  }) as unknown as typeof fetch
}

/** A dropped link whose inspection found documents on the page. */
async function seedEntry(
  slug: string,
  documents: { url: string; label: string }[],
  over: { kind?: string; meta?: Record<string, unknown>; files?: { name: string; body: string }[] } = {},
): Promise<void> {
  const meta = {
    title: 'Landowner profiles',
    category: '',
    status: 'needs-cataloging',
    tags: [],
    url: PAGE,
    inspection: { kind: 'page', confidence: 'high', url: PAGE, documents },
    ...over.meta,
  }
  const kind = over.kind ?? 'incoming'
  const folder = `library/${kind === 'document' ? 'documents' : 'incoming'}/${slug}/`
  const key = `${folder}meta.json`
  const json = JSON.stringify(meta, null, 2)
  fake.seed(key, json)
  const files = [{ key, size: Buffer.byteLength(json) }]
  for (const file of over.files ?? []) {
    fake.seed(`${folder}${file.name}`, file.body)
    files.push({ key: `${folder}${file.name}`, size: Buffer.byteLength(file.body) })
  }
  await indexFileBackedEntry(kind, slug, meta, files)
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-pull-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  setDocumentPullDefaults({ fetchImpl: agency(), lookup, tmpDir: dataDir })
})

afterEach(async () => {
  resetDocumentPullDefaults()
  delete process.env.LIBRARY_PULL_MAX_BYTES
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('pulling the documents in', () => {
  it('stores them under the entry, named from what the page called them', async () => {
    await seedEntry('a', [
      { url: JONES, label: 'The Jones farm, 2024' },
      { url: SMITH, label: 'Smith woodlot' },
    ])

    const outcome = await pullDocuments('a', [JONES, SMITH])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results).toEqual([
      { url: JONES, status: 'stored', file: 'the-jones-farm-2024.pdf' },
      { url: SMITH, status: 'stored', file: 'smith-woodlot.pdf' },
    ])
    expect(fake.objects.has('library/incoming/a/the-jones-farm-2024.pdf')).toBe(true)
    expect(fake.contentTypes.get('library/incoming/a/smith-woodlot.pdf')).toBe('application/pdf')
  })

  it('shows them in the entry’s files, so the Files tab and Ask see them', async () => {
    await seedEntry('a', [{ url: JONES, label: 'The Jones farm, 2024' }])
    await pullDocuments('a', [JONES])

    const entry = await getCatalogEntry('a')
    expect(entry!.files.map(f => f.key)).toContain('library/incoming/a/the-jones-farm-2024.pdf')
    expect(entry!.bytes).toBeGreaterThan(0)
    // Lineage: which page each file came off, per file.
    expect((entry!.meta.pulledDocuments as any[])[0]).toMatchObject({ file: 'the-jones-farm-2024.pdf', from: JONES })
  })

  it('leaves the entry’s own filing alone — a pull is not a suggestion', async () => {
    await seedEntry('a', [{ url: JONES, label: 'Jones' }])
    await pullDocuments('a', [JONES])

    const entry = await getCatalogEntry('a')
    expect(entry!.title).toBe('Landowner profiles')
    expect(entry!.status).toBe('needs-cataloging')
    // No model pass runs here, so nothing wrote a suggestion.
    expect(entry!.meta.suggested).toBeUndefined()
  })

  it('pulls the text out locally, with no model anywhere near it', async () => {
    await seedEntry('a', [{ url: MINUTES, label: 'September minutes' }])
    await pullDocuments('a', [MINUTES])

    const derived = await readDerived('a', 'september-minutes.rtf')
    expect(derived).not.toBeNull()
    expect(isFailure(derived!)).toBe(false)
    expect((derived as any).pages[0].text).toContain('trustees met')
  })

  it('works on a document entry too, storing beside what is already there', async () => {
    await seedEntry('d', [{ url: JONES, label: 'Jones' }], { kind: 'document' })
    const outcome = await pullDocuments('d', [JONES])
    expect(outcome.ok && outcome.stored).toBe(1)
    expect(fake.objects.has('library/documents/d/jones.pdf')).toBe(true)
  })
})

describe('nothing arbitrary is ever fetched', () => {
  it('refuses a URL the page never offered, naming the first offender', async () => {
    await seedEntry('a', [{ url: JONES, label: 'Jones' }])
    const fetchImpl = vi.fn()
    setDocumentPullDefaults({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup, tmpDir: dataDir })

    const outcome = await pullDocuments('a', [JONES, 'https://evil.example/payload.pdf'])
    expect(outcome).toEqual({
      ok: false,
      status: 400,
      error: '"https://evil.example/payload.pdf" is not one of the documents on this page.',
    })
    // Not one request, not even for the URL that WAS on the list.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses everything when the entry has no document list at all', async () => {
    await seedEntry('a', [])
    const outcome = await pullDocuments('a', [JONES])
    expect(outcome).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a kind that does not hold documents', async () => {
    await seedEntry('s', [{ url: JONES, label: 'Jones' }], { kind: 'source' })
    const outcome = await pullDocuments('s', [JONES])
    expect(outcome).toMatchObject({ ok: false, status: 409 })
  })

  it('404s an entry that is not there, and 400s an empty or oversized ask', async () => {
    await seedEntry('a', [{ url: JONES, label: 'Jones' }])
    expect(await pullDocuments('gone', [JONES])).toMatchObject({ ok: false, status: 404 })
    expect(await pullDocuments('a', [])).toMatchObject({ ok: false, status: 400 })
    expect(await pullDocuments('a', 'not-a-list')).toMatchObject({ ok: false, status: 400 })
    const many = Array.from({ length: PULL_MAX_FILES + 1 }, (_, i) => `${JONES}?n=${i}`)
    expect(await pullDocuments('a', many)).toMatchObject({ ok: false, status: 400 })
  })
})

describe('when one document does not work', () => {
  it('records the reason per file and keeps the rest', async () => {
    await seedEntry('a', [
      { url: JONES, label: 'Jones' },
      { url: GONE, label: 'Missing' },
      { url: LOGIN, label: 'Members only' },
      { url: HUGE, label: 'Atlas' },
    ])

    const outcome = await pullDocuments('a', [JONES, GONE, LOGIN, HUGE])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results.map(r => [r.url, r.status])).toEqual([
      [JONES, 'stored'],
      [GONE, 'unreachable'],
      [LOGIN, 'not-a-document'],
      [HUGE, 'too-large'],
    ])
    expect(outcome.stored).toBe(1)
    // Only the one that worked is on the entry.
    const entry = await getCatalogEntry('a')
    expect(entry!.files.filter(f => f.key.endsWith('.pdf'))).toHaveLength(1)
    expect(fake.objects.has('library/incoming/a/members-only.pdf')).toBe(false)
  })

  it('refuses an address that is not a document at all, without fetching it', async () => {
    // The list is stored data — a hand-edited manifest must not be a way in.
    const installer = 'https://land.example.org/files/setup.exe'
    await seedEntry('a', [{ url: installer, label: 'Setup' }])
    const fetchImpl = vi.fn()
    setDocumentPullDefaults({ fetchImpl: fetchImpl as unknown as typeof fetch, lookup, tmpDir: dataDir })

    const outcome = await pullDocuments('a', [installer])
    expect(outcome.ok && outcome.results[0].status).toBe('not-a-document')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a document on a private address, through the same guard as the fetch', async () => {
    const inside = 'http://intranet.example/staff/salaries.pdf'
    await seedEntry('a', [{ url: inside, label: 'Salaries' }])
    const outcome = await pullDocuments('a', [inside])
    expect(outcome.ok && outcome.results[0]).toMatchObject({ status: 'unreachable', error: 'not a public address' })
  })

  it('stops at the byte budget for one pull rather than copying a shelf', async () => {
    // 60 bytes: room for the first fake PDF and not the second.
    process.env.LIBRARY_PULL_MAX_BYTES = '60'
    await seedEntry('a', [
      { url: JONES, label: 'Jones' },
      { url: SMITH, label: 'Smith' },
    ])
    const outcome = await pullDocuments('a', [JONES, SMITH])
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.results[0].status).toBe('stored')
    expect(outcome.results[1].status).toBe('too-large')
    expect(outcome.bytes).toBeLessThanOrEqual(60)
  })
})

describe('naming', () => {
  it('retries a same-site https document over http when the page itself is served over http (P5-81)', async () => {
    const httpsDead = vi.fn(async (input: any) => {
      const url = String(input)
      if (url.startsWith('https://')) throw new TypeError('fetch failed')
      return new Response(`%PDF-1.4 ${url}`, { headers: { 'content-type': 'application/pdf' } })
    })
    setDocumentPullDefaults({ fetchImpl: httpsDead as unknown as typeof fetch, lookup, tmpDir: dataDir })
    const page = 'http://land.example.org/profiles/'
    await seedEntry('tele', [], { meta: { url: page, inspection: { kind: 'page', confidence: 'high', url: page, page: { insecure: true }, documents: [{ url: JONES, label: 'Jones farm' }] } } })
    const out = await pullDocuments('tele', [JONES])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.results[0]).toMatchObject({ url: JONES, status: 'stored', via: 'http' })
    const calls = httpsDead.mock.calls.map(c => String(c[0]))
    expect(calls).toEqual([JONES, JONES.replace('https://', 'http://')])
  })

  it('does not fall back to http for a page that is served over https', async () => {
    const httpsDead = vi.fn(async (input: any) => {
      if (String(input).startsWith('https://')) throw new TypeError('fetch failed')
      return new Response('%PDF-1.4', { headers: { 'content-type': 'application/pdf' } })
    })
    setDocumentPullDefaults({ fetchImpl: httpsDead as unknown as typeof fetch, lookup, tmpDir: dataDir })
    await seedEntry('secure', [{ url: JONES, label: 'Jones farm' }])
    const out = await pullDocuments('secure', [JONES])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.results[0]).toMatchObject({ url: JONES, status: 'unreachable' })
    expect(httpsDead).toHaveBeenCalledTimes(1)
  })

  it('kebab-cases the label and keeps the URL’s extension', () => {
    expect(documentFilename('The Jones farm, 2024', JONES)).toBe('the-jones-farm-2024.pdf')
    expect(documentFilename('Ancienne Forêt', 'https://x.example/a/b.DOCX')).toBe('ancienne-foret.docx')
    // No words in the anchor: the file's own name, minus its extension.
    expect(documentFilename('', 'https://x.example/files/2024%20Jones%20Farm.pdf')).toBe('2024-jones-farm.pdf')
    expect(documentFilename('!!!', 'https://x.example/files/!!!.pdf')).toBe('document.pdf')
  })

  it('never lets one document overwrite another', async () => {
    const first = 'https://land.example.org/a/profile.pdf'
    const second = 'https://land.example.org/b/profile.pdf'
    await seedEntry('a', [
      { url: first, label: 'Profile' },
      { url: second, label: 'Profile' },
    ])
    const outcome = await pullDocuments('a', [first, second])
    expect(outcome.ok && outcome.results.map(r => r.file)).toEqual(['profile.pdf', 'profile-2.pdf'])

    expect(uniqueFilename('profile.pdf', new Set(['profile.pdf', 'profile-2.pdf']))).toBe('profile-3.pdf')
    // Case is not a difference a mirror on a case-insensitive disk can keep.
    expect(uniqueFilename('Profile.pdf', new Set(['profile.pdf']))).toBe('Profile-2.pdf')
  })

  it('does not collide with a file the entry already holds', async () => {
    const key = 'library/incoming/a/jones-farm.pdf'
    await seedEntry('a', [{ url: JONES, label: 'Jones farm' }], { files: [{ name: 'jones-farm.pdf', body: 'older' }] })

    const outcome = await pullDocuments('a', [JONES])
    expect(outcome.ok && outcome.results[0].file).toBe('jones-farm-2.pdf')
    expect((await getFile(key)).toString('utf8')).toBe('older')
  })
})
