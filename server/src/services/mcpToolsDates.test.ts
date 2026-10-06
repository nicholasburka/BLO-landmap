import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * P7-10: what the MCP tools say about WHEN a dataset is from.
 *
 * `search_library`'s row and `get_entry`'s record are built by one function
 * (`summarize`), so the two cannot disagree — that is the thing worth
 * asserting, and it is asserted from both ends. The catalog is mocked rather
 * than stood up: this file is about the SHAPE of the answer, and the derivation
 * behind it has its own tests in `dataDates.test.ts` and `routes/
 * libraryCatalog.test.ts`. No bucket, no temp dir, nothing to tear down.
 */

const searchCatalogPage = vi.fn()
const getCatalogEntry = vi.fn()

vi.mock('./libraryCatalog.js', () => ({
  searchCatalog: vi.fn(async () => []),
  searchCatalogPage: (...args: unknown[]) => searchCatalogPage(...args),
  getCatalogEntry: (...args: unknown[]) => getCatalogEntry(...args),
  getSavedView: vi.fn(async () => null),
  getWikiPage: vi.fn(async () => null),
  onReindex: vi.fn(),
}))

vi.mock('./libraryDb.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./libraryDb.js')>()),
  isLibraryEnabled: () => true,
}))

vi.mock('./libraryBucket.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./libraryBucket.js')>()),
  isBucketEnabled: () => true,
}))

const { searchLibrary, getEntry } = await import('./mcpTools.js')
const { MCP_TOOLS } = await import('./mcpTools.js')

type Row = Record<string, unknown>

const row = (over: Row = {}): Row => ({
  slug: 'acs-renters',
  kind: 'dataset',
  title: 'Renter households',
  category: 'housing',
  status: 'published',
  tags: [],
  meta: { description: 'Renter households by county.' },
  files: [],
  bytes: 0,
  updatedAt: '2026-10-06T12:00:00.000Z',
  ...over,
})

/**
 * The same row with a `dates` block in its MANIFEST, which is where the server
 * reads them from — `row.dates` is a promotion of `meta.dates`, never the
 * other way round, exactly as `coverage` works.
 */
const dated = (dates: Record<string, string>, over: Row = {}): Row =>
  row({ meta: { description: 'Renter households by county.', dates }, ...over })

beforeEach(() => {
  searchCatalogPage.mockReset()
  getCatalogEntry.mockReset()
})

describe('search_library rows', () => {
  it('carries the three dates as three separate facts', async () => {
    searchCatalogPage.mockResolvedValue({ entries: [dated({ covers: '2019/2023', published: '2024-03', fetched: '2026-09-29' })], total: 1 })
    const out = (await searchLibrary({ query: 'renters' })) as { results: Row[] }
    expect(out.results[0].dates).toEqual({ covers: '2019/2023', published: '2024-03', fetched: '2026-09-29' })
  })

  it("answers '' per field for an entry nobody has dated, never a guess", async () => {
    // A caller has to be able to tell "nobody wrote one" from "it is from no
    // particular time", which is the same rule `whatItAnswers` and `coverage`
    // follow.
    searchCatalogPage.mockResolvedValue({ entries: [row()], total: 1 })
    const out = (await searchLibrary({ query: 'renters' })) as { results: Row[] }
    expect(out.results[0].dates).toEqual({ covers: '', published: '', fetched: '' })
  })

  it('never folds the updatedAt into them', async () => {
    // `updatedAt` rides beside the dates and means something else entirely:
    // when the bytes last moved in our own storage. Re-pushing a 2019 file
    // moves it to today, which is why it is not a date about the data.
    searchCatalogPage.mockResolvedValue({ entries: [dated({ fetched: '2024-01-02' })], total: 1 })
    const out = (await searchLibrary({ query: 'renters' })) as { results: Row[] }
    expect(out.results[0].dates).toEqual({ covers: '', published: '', fetched: '2024-01-02' })
    expect(out.results[0].updatedAt).toBe('2026-10-06T12:00:00.000Z')
  })

  it('is not asked of a wiki page', async () => {
    searchCatalogPage.mockResolvedValue({ entries: [dated({ covers: '2019/2023' }, { kind: 'wiki' })], total: 1 })
    const out = (await searchLibrary({ query: 'land' })) as { results: Row[] }
    expect(out.results[0].dates).toEqual({ covers: '', published: '', fetched: '' })
  })
})

describe('get_entry', () => {
  it('says the same thing the search row said, from the one function', async () => {
    const one = dated({ covers: '2026-10' }, { readiness: { as: 'dataset' } })
    getCatalogEntry.mockResolvedValue(one)
    searchCatalogPage.mockResolvedValue({ entries: [one], total: 1 })
    const entry = (await getEntry({ slug: 'acs-renters' })) as Row
    const search = (await searchLibrary({ query: 'renters' })) as { results: Row[] }
    expect(entry.dates).toEqual({ covers: '2026-10', published: '', fetched: '' })
    expect(entry.dates).toEqual(search.results[0].dates)
  })

  it('lists a model-read date as unverified, with its evidence', async () => {
    getCatalogEntry.mockResolvedValue(
      dated(
        { published: '2024-03-12' },
        {
          meta: {
            description: 'Renter households by county.',
            dates: { published: '2024-03-12' },
            provenance: {
              published: { mechanism: 'model', value: '2024-03-12', evidence: 'This dataset was last updated on March 12, 2024.' },
            },
          },
          readiness: { as: 'dataset' },
        },
      ),
    )
    const entry = (await getEntry({ slug: 'acs-renters' })) as { unverified: string[]; provenance: Record<string, { evidence?: string }> }
    expect(entry.unverified).toContain('published')
    expect(entry.provenance.published.evidence).toContain('March 12, 2024')
  })

  it('does NOT list a derived date, because a re-run is the only verification it needs', async () => {
    getCatalogEntry.mockResolvedValue(dated({ covers: '2024', fetched: '2026-09-29' }, { readiness: { as: 'dataset' } }))
    const entry = (await getEntry({ slug: 'acs-renters' })) as { unverified: string[]; provenance: Record<string, { mechanism: string }> }
    expect(entry.unverified).not.toContain('covers')
    expect(entry.unverified).not.toContain('fetched')
    expect(entry.provenance.covers.mechanism).toBe('derived')
    expect(entry.provenance.fetched.mechanism).toBe('derived')
  })
})

describe('what the tools tell the model', () => {
  const describing = (name: string) => MCP_TOOLS.find(t => t.name === name)?.description ?? ''

  it('teaches search_library the difference between the three, and warns off updatedAt', () => {
    const text = describing('search_library')
    expect(text).toContain('the period the data DESCRIBES')
    expect(text).toContain('when the publisher put it out')
    expect(text).toContain('never read "updatedAt" as a date about the data')
  })

  it('tells get_entry that the dates are part of how each value got there', () => {
    expect(describing('get_entry')).toContain('"dates"')
    expect(describing('get_entry')).toContain('the two dates got onto the entry')
  })
})
