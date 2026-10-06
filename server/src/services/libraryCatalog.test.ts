import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, getFile } = await import('./libraryBucket.js')
const {
  reindexCatalog,
  slugify,
  searchCatalog,
  searchCatalogPage,
  getCatalogEntry,
  KIND_RANK,
  listRowMeta,
  LIST_ROW_META_KEYS,
} = await import('./libraryCatalog.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')

let fake: InstanceType<typeof FakeS3>
let dataDir: string
let sql: string[]

/** pg-mem pool that records the SQL it is asked to run. */
function recordingPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  const pool = new Pool() as unknown as PgPool
  const query = pool.query.bind(pool)
  pool.query = ((text: any, params: any) => {
    sql.push(typeof text === 'string' ? text : String(text?.text ?? ''))
    return query(text, params)
  }) as typeof pool.query
  return pool
}

beforeEach(async () => {
  sql = []
  expect(await initLibraryDb(recordingPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-catalog-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const deleteCount = () => sql.filter(s => s.includes('DELETE FROM library_catalog')).length

describe('slugify', () => {
  it('caps the slug so it cannot outgrow a key segment or a URL', () => {
    expect(slugify('Shelby County Tax Sales 2025')).toBe('shelby-county-tax-sales-2025')
    const long = slugify('word '.repeat(60))
    expect(long.length).toBeLessThanOrEqual(80)
    // Capping must not leave a dangling separator.
    expect(long.endsWith('-')).toBe(false)
    expect(slugify('a'.repeat(200))).toBe('a'.repeat(80))
  })
})

describe('reindexCatalog single-flight', () => {
  it('shares one run between concurrent callers', async () => {
    fake.seed('library/datasets/tn-parcels/meta.json', JSON.stringify({ title: 'TN parcels', status: 'published' }))
    fake.seed('library/datasets/tn-parcels/data.csv', 'a,b\n1,2\n')
    fake.seed('library/wiki/home.md', '# Home\n')

    // Reindex walks the whole bucket and rewrites every row; two overlapping
    // runs (a CLI push while someone hits Reindex) would double the work and
    // race the delete against the other run's inserts.
    const [a, b] = await Promise.all([reindexCatalog(), reindexCatalog()])
    expect(a).toBe(b)
    expect(a.indexed).toBe(2)
    expect(deleteCount()).toBe(1)
    expect((await libraryQuery(`SELECT slug FROM library_catalog ORDER BY slug`)).rows.map(r => r.slug)).toEqual([
      'home',
      'tn-parcels',
    ])
  })

  it('starts a fresh run once the in-flight one has settled', async () => {
    fake.seed('library/wiki/home.md', '# Home\n')
    const first = await reindexCatalog()
    const second = await reindexCatalog()
    expect(second).not.toBe(first)
    expect(deleteCount()).toBe(2)
  })

  it('does not wedge after a failed run', async () => {
    fake.seed('library/wiki/home.md', '# Home\n')
    fake.failNext = true
    await expect(reindexCatalog()).rejects.toThrow()
    await expect(reindexCatalog()).resolves.toMatchObject({ indexed: 1 })
  })
})

// --- P5-56: the source kind ------------------------------------------------

const NPL = {
  title: 'EPA Superfund National Priorities List (NPL) sites',
  category: 'environment',
  status: 'published',
  tags: ['environmental-risk'],
  description: 'Every site on or proposed for the NPL.',
  source: {
    provider: 'US EPA',
    program: 'Superfund / CERCLIS',
    geography: 'point',
    coverage: 'national',
    topics: ['contamination', 'hazardous waste'],
    fields: [{ name: 'NPL_STATUS', description: 'Proposed, final, deleted' }],
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0', auth: 'none' }],
    relevance: 'A red flag within a few miles of a candidate parcel.',
    replication: { status: 'indexed' },
  },
}

describe('reindexCatalog — sources (P5-56)', () => {
  it('indexes library/sources/ as kind source and exposes the cleaned block', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    fake.seed('library/sources/epa-npl/data-dictionary.csv', 'name,desc\n')

    expect((await reindexCatalog()).indexed).toBe(1)
    const entry = await getCatalogEntry('epa-npl')
    expect(entry).toMatchObject({ kind: 'source', status: 'published', category: 'environment' })
    expect(entry!.meta.source).toEqual(NPL.source)
    // A source needs no file at all, but one may sit beside the manifest.
    expect(entry!.files).toHaveLength(2)
  })

  it('drops bad values one by one, warns ONCE, and still indexes the entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.seed(
      'library/sources/fema-nfhl/meta.json',
      JSON.stringify({
        title: 'FEMA flood zones',
        source: {
          provider: 'FEMA',
          geography: 'zipcode',
          homepage: 'http://msc.fema.gov',
          cost: 'free',
          access: [{ type: 'esri' }, { type: 'wfs', url: 'https://hazards.fema.gov/wfs' }],
        },
      }),
    )
    await reindexCatalog()
    const entry = await getCatalogEntry('fema-nfhl')
    expect(entry!.kind).toBe('source')
    expect(entry!.meta.source).toEqual({ provider: 'FEMA', access: [{ type: 'wfs', url: 'https://hazards.fema.gov/wfs' }] })

    const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('source block'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"fema-nfhl"')
    expect(lines[0]).toContain('geography "zipcode"')
    expect(lines[0]).toContain('homepage (not https)')
    expect(lines[0]).toContain('unknown key "cost"')
    expect(lines[0]).toContain('access[0].type "esri"')
    warn.mockRestore()
  })

  it('drops a block with no provider but keeps the entry, and leaves a plain-string source alone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.seed('library/sources/nameless/meta.json', JSON.stringify({ title: 'Nameless', source: { geography: 'county' } }))
    // Datasets have carried provenance prose in `source` since the first
    // content load — that string must survive untouched.
    fake.seed('library/datasets/gardens/meta.json', JSON.stringify({ title: 'Gardens', source: 'DC Open Data, 2024' }))
    await reindexCatalog()
    expect((await getCatalogEntry('nameless'))!.meta.source).toBeUndefined()
    expect((await getCatalogEntry('gardens'))!.meta.source).toBe('DC Open Data, 2024')
    expect(warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('source block'))).toHaveLength(1)
    warn.mockRestore()
  })

  it('loses a slug collision to a wiki page, like every other kind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.seed('library/sources/flood/meta.json', JSON.stringify({ title: 'Flood source', source: { provider: 'FEMA' } }))
    fake.seed('library/wiki/flood.md', '# Flood\n')
    const result = await reindexCatalog()
    expect(result.collisions).toBe(1)
    expect((await getCatalogEntry('flood'))!.kind).toBe('source') // walked before wiki
    expect(warn.mock.calls.map(c => String(c[0])).some(l => l.includes('slug collision'))).toBe(true)
    warn.mockRestore()
  })
})

describe('searchCatalog — source fields (P5-56)', () => {
  beforeEach(async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    fake.seed('library/datasets/tn-parcels/meta.json', JSON.stringify({ title: 'TN parcels' }))
    await reindexCatalog()
  })

  const slugs = async (q: string) => (await searchCatalog({ q })).map(r => r.slug)

  it('matches provider, program, topics and field names — none of which are in the title', async () => {
    expect(await slugs('US EPA')).toEqual(['epa-npl'])
    expect(await slugs('cerclis')).toEqual(['epa-npl'])
    expect(await slugs('contamination')).toEqual(['epa-npl'])
    expect(await slugs('NPL_STATUS')).toEqual(['epa-npl'])
  })

  it('still matches title, slug, tags and description, and misses what is absent', async () => {
    expect(await slugs('parcels')).toEqual(['tn-parcels'])
    expect(await slugs('environmental-risk')).toEqual(['epa-npl'])
    expect(await slugs('pipelines')).toEqual([])
  })
})

/**
 * P5-59: the admin "to ingest" queue counts rows in the browser and opens the
 * list from the server. If these two ever disagree, a row says "3" and shows
 * seven — so each filter gets a test against the same fixtures.
 */
describe('searchCatalog - the ingest filters (P5-59)', () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    plan: 'replicate',
    decidedBy: 'nick',
    decidedAt: '2026-09-06T00:00:00.000Z',
    ...over,
  })

  beforeEach(async () => {
    // A dropped link with no plan yet.
    fake.seed('library/incoming/link-bare/meta.json', JSON.stringify({ title: 'bare link', url: 'https://a/b.csv' }))
    // A source with no plan yet.
    fake.seed('library/sources/src-bare/meta.json', JSON.stringify({ title: 'bare source', source: { provider: 'EPA' } }))
    // A quick drop with no URL: not waiting on an ingest decision.
    fake.seed('library/incoming/upload/meta.json', JSON.stringify({ title: 'an upload' }))
    // A page: never waiting on one either.
    fake.seed('library/wiki/land-loss.md', '# Land loss\n')
    // Decided and waiting.
    fake.seed(
      'library/incoming/copy-todo/meta.json',
      JSON.stringify({ title: 'to copy', url: 'https://a/c.csv', ingest: plan({ mode: 'manual' }) }),
    )
    // Decided and arrived.
    fake.seed(
      'library/incoming/copy-done/meta.json',
      JSON.stringify({ title: 'copied', url: 'https://a/d.csv', ingest: plan({ done: { at: 'T', dataset: 'x' } }) }),
    )
    // Looked at and unreachable.
    fake.seed(
      'library/incoming/broken/meta.json',
      JSON.stringify({
        title: 'broken',
        url: 'https://gone/x',
        ingest: plan({ plan: 'index' }),
        inspection: { kind: 'unreachable', confidence: 'high', url: 'https://gone/x', checkedAt: 'T' },
      }),
    )
    // A source whose adapter is failing.
    fake.seed(
      'library/sources/src-failing/meta.json',
      JSON.stringify({
        title: 'failing source',
        ingest: plan({ plan: 'fetch-on-demand' }),
        source: { provider: 'FEMA', lastError: { at: 'T', code: 'http-error', text: 'the agency refused' } },
      }),
    )
    await reindexCatalog()
  })

  const slugsFor = async (filters: Record<string, string>) =>
    (await searchCatalog(filters)).map(r => r.slug).sort()

  /**
   * P5-59, found live: this counted every seeded source too — 47 rows of
   * "work" for 7 real links. A source is already indexed and already fetched
   * on demand, so nobody is waiting on a decision about one.
   */
  it('no-plan is dropped links with no plan, and only those', async () => {
    expect(await slugsFor({ attention: 'no-plan' })).toEqual(['link-bare'])
  })

  it('a source with no ingest block is not waiting on anybody', async () => {
    const rows = await searchCatalog({ attention: 'no-plan' })
    expect(rows.some(r => r.kind === 'source')).toBe(false)
    // It is still findable by the plan filter, which is the literal question.
    expect(await slugsFor({ plan: 'none' })).toContain('src-bare')
  })

  it('replicate-todo is a copy decided on and not arrived', async () => {
    expect(await slugsFor({ attention: 'replicate-todo' })).toEqual(['copy-todo'])
  })

  it('unreachable is the links the last look could not reach', async () => {
    expect(await slugsFor({ attention: 'unreachable' })).toEqual(['broken'])
  })

  it('source-failing is the sources whose adapter errored and has not recovered', async () => {
    expect(await slugsFor({ attention: 'source-failing' })).toEqual(['src-failing'])
  })

  it('plan= browses by the decision itself', async () => {
    expect(await slugsFor({ plan: 'replicate' })).toEqual(['copy-done', 'copy-todo'])
    expect(await slugsFor({ plan: 'index' })).toEqual(['broken'])
    // `none` is the literal reading: no plan block, whatever the kind.
    expect(await slugsFor({ plan: 'none' })).toEqual(['land-loss', 'link-bare', 'src-bare', 'upload'])
  })
})

/**
 * P5-63 — one taxonomy, applied where the words are stored.
 *
 * Manifests are hand-written and have been for months, so the words in them
 * are the words people typed. Reindex is where they are folded into one
 * spelling; a category the taxonomy has never heard of is KEPT (the vocabulary
 * is allowed to grow) and warned about exactly once.
 */
describe('the taxonomy at reindex (P5-63)', () => {
  const warnings: string[] = []

  beforeEach(() => {
    warnings.length = 0
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const seedAll = () => {
    fake.seed(
      'library/sources/census-acs/meta.json',
      JSON.stringify({ title: 'ACS', status: 'published', category: 'Demographics', tags: ['demographics', 'Flooding', 'site_selection'] }),
    )
    fake.seed(
      'library/documents/homestead-acts/meta.json',
      JSON.stringify({ title: 'Homestead Acts', status: 'published', category: 'primary-sources', tags: ['history', 'land'] }),
    )
    fake.seed(
      'library/documents/plan/meta.json',
      JSON.stringify({ title: 'Five-year plan', status: 'published', category: 'strategy', tags: ['funding'] }),
    )
    fake.seed('library/wiki/home.md', '# Home\n')
    fake.seed('library/views/v.json', JSON.stringify({ name: 'V', type: 'map' }))
  }

  it('folds every manifest onto one spelling', async () => {
    seedAll()
    await reindexCatalog()
    const acs = (await getCatalogEntry('census-acs'))!
    expect(acs.category).toBe('demographic')
    expect(acs.tags).toEqual(['demographic', 'flood', 'site-selection'])
    expect((await getCatalogEntry('homestead-acts'))!.category).toBe('research')
  })

  it('keeps a category it does not know, and warns once, naming the entry and the fix', async () => {
    fake.seed('library/documents/odd/meta.json', JSON.stringify({ title: 'Odd', category: 'kitchen sink' }))
    await reindexCatalog()
    expect((await getCatalogEntry('odd'))!.category).toBe('kitchen-sink')
    const mine = warnings.filter(w => w.includes('"odd"'))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toContain('kitchen-sink')
    expect(mine[0]).toContain('library -- retag')
  })

  it('says nothing about a wiki page or a saved view — neither carries a manifest category', async () => {
    seedAll()
    await reindexCatalog()
    expect(warnings.filter(w => w.includes('not one of'))).toEqual([])
  })

  it('folds a source’s topics where they name a taxonomy word and leaves the publisher’s prose alone', async () => {
    fake.seed(
      'library/sources/epa-npl/meta.json',
      JSON.stringify({
        title: 'NPL',
        category: 'environment',
        source: { provider: 'US EPA', topics: ['Environmental Risk', 'superfund', 'hazardous waste'] },
      }),
    )
    await reindexCatalog()
    const entry = (await getCatalogEntry('epa-npl'))!
    // 'Environmental Risk' is the cross-cutting screening tag, kept as itself.
    expect((entry.meta.source as { topics: string[] }).topics).toEqual(['environmental-risk', 'superfund', 'hazardous waste'])
  })

  it('filters by topic, by purpose, and by tag — through the aliases on both sides', async () => {
    seedAll()
    await reindexCatalog()
    const slugs = async (filters: Record<string, string>) => (await searchCatalog(filters)).map(r => r.slug).sort()

    // The category IS the topic.
    expect(await slugs({ topic: 'demographic' })).toEqual(['census-acs'])
    expect(await slugs({ topic: 'demographics' })).toEqual(['census-acs'])
    // The category is a purpose; the topic comes off the tags.
    expect(await slugs({ topic: 'land' })).toEqual(['homestead-acts'])
    expect(await slugs({ purpose: 'research' })).toEqual(['homestead-acts'])
    expect(await slugs({ purpose: 'strategy' })).toEqual(['plan'])
    // A tag, in either spelling.
    expect(await slugs({ tag: 'flood' })).toEqual(['census-acs'])
    expect(await slugs({ tag: 'Flooding' })).toEqual(['census-acs'])
  })

  it('keeps ?category= working as an alias for whichever question the word asks', async () => {
    seedAll()
    await reindexCatalog()
    const slugs = async (category: string) => (await searchCatalog({ category })).map(r => r.slug).sort()
    expect(await slugs('land')).toEqual(['homestead-acts'])
    expect(await slugs('strategy')).toEqual(['plan'])
    expect(await slugs('demographics')).toEqual(['census-acs'])
    // A word the taxonomy has never heard of is still matched literally.
    fake.seed('library/documents/odd/meta.json', JSON.stringify({ title: 'Odd', category: 'kitchen-sink' }))
    await reindexCatalog()
    expect(await slugs('kitchen-sink')).toEqual(['odd'])
  })

  it('counts the entries nothing has filed under a subject, and only for the kinds that carry one', async () => {
    seedAll()
    await reindexCatalog()
    const rows = await searchCatalog({ attention: 'uncategorised' })
    // `plan` is a purpose with no subject anywhere on it. The page and the
    // view are not asked the question at all.
    expect(rows.map(r => r.slug)).toEqual(['plan'])
  })

  it('still finds an entry by a spelling it folded away', async () => {
    seedAll()
    await reindexCatalog()
    expect((await searchCatalog({ q: 'flooding' })).map(r => r.slug)).toEqual(['census-acs'])
  })
})

/**
 * P5-64 — held before indexed.
 *
 * The 40 indexed-only sources outnumber everything the team actually holds, so
 * ordering by recency alone buried the five datasets under two screens of
 * pointers. Every list that mixes kinds now ranks by what we hold first and
 * uses recency inside each rank; `sort=recent` is the old order, for the
 * lists that say "recently updated" and mean it.
 */
describe('held before indexed (P5-64)', () => {
  /** Newest at the top of this list, so recency alone would REVERSE it — the
   *  order the assertions expect can only come from the kind rank. */
  const at = (iso: string) => new Date(iso)

  beforeEach(async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL), at('2026-09-07T00:00:00.000Z'))
    fake.seed('library/incoming/drop/meta.json', JSON.stringify({ title: 'a drop', url: 'https://a/b.csv' }), at('2026-09-06T00:00:00.000Z'))
    fake.seed('library/notes/idea/meta.json', JSON.stringify({ title: 'An idea', category: 'ideas', body: 'x' }), at('2026-09-05T00:00:00.000Z'))
    fake.seed('library/documents/memo/meta.json', JSON.stringify({ title: 'A memo', category: 'strategy' }), at('2026-09-04T00:00:00.000Z'))
    fake.seed('library/wiki/home.md', '# Home\n', at('2026-09-03T00:00:00.000Z'))
    fake.seed('library/views/tn.json', JSON.stringify({ name: 'TN', type: 'map' }), at('2026-09-02T00:00:00.000Z'))
    fake.seed('library/datasets/parcels/meta.json', JSON.stringify({ title: 'TN parcels', category: 'land' }), at('2026-09-01T00:00:00.000Z'))
    await reindexCatalog()
  })

  it('ranks dataset · view · page · document · note · to file · source, whatever the dates say', async () => {
    expect((await searchCatalog({})).map(r => r.kind)).toEqual([
      'dataset',
      'view',
      'wiki',
      'document',
      'note',
      'incoming',
      'source',
    ])
  })

  it('keeps newest-first inside a rank', async () => {
    fake.seed('library/datasets/older/meta.json', JSON.stringify({ title: 'Older set' }), at('2026-08-01T00:00:00.000Z'))
    fake.seed('library/datasets/newer/meta.json', JSON.stringify({ title: 'Newer set' }), at('2026-09-06T00:00:00.000Z'))
    await reindexCatalog()
    const datasets = (await searchCatalog({})).filter(r => r.kind === 'dataset').map(r => r.slug)
    expect(datasets).toEqual(['newer', 'parcels', 'older'])
  })

  it('sort=recent is pure recency — the order every "recently updated" list means', async () => {
    expect((await searchCatalog({ sort: 'recent' })).map(r => r.kind)).toEqual([
      'source',
      'incoming',
      'note',
      'document',
      'wiki',
      'view',
      'dataset',
    ])
  })

  it('a free-text search shows what we hold before what we point at', async () => {
    fake.seed(
      'library/sources/fema-nfhl/meta.json',
      JSON.stringify({ title: 'FEMA flood zones', source: { provider: 'FEMA' } }),
      at('2026-09-07T00:00:00.000Z'),
    )
    fake.seed(
      'library/datasets/flood-claims/meta.json',
      JSON.stringify({ title: 'Flood claims, TN' }),
      at('2026-01-01T00:00:00.000Z'),
    )
    await reindexCatalog()
    expect((await searchCatalog({ q: 'flood' })).map(r => r.slug)).toEqual(['flood-claims', 'fema-nfhl'])
    // P5-84: every word must be found, in any field — the phrase need not sit in one.
    expect((await searchCatalog({ q: 'nfhl flood' })).map(r => r.slug)).toEqual(['fema-nfhl'])
    expect((await searchCatalog({ q: 'flood nowhere-such-word' })).map(r => r.slug)).toEqual([])
    expect((await searchCatalog({ q: 'flood', sort: 'recent' })).map(r => r.slug)).toEqual(['fema-nfhl', 'flood-claims'])
  })

  it('names every kind the catalog indexes, so nothing sorts by accident', async () => {
    const kinds = (await searchCatalog({})).map(r => r.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const kind of kinds) expect(KIND_RANK).toHaveProperty(kind)
  })
})

// --- P5-82: the readiness verdict on every row ------------------------------

describe('readiness on catalog rows (P5-82)', () => {
  it('the no-summary queue is exactly the entries that were read and not summarised', async () => {
    // Read, and the pass said it could not run.
    fake.seed(
      'library/incoming/pass-failed/meta.json',
      JSON.stringify({ title: 'a', url: 'https://a/b', suggested: { error: 'unavailable', at: 'T', reason: 'refused' } }),
    )
    // Read by the fetcher, no suggestion ever written.
    fake.seed('library/incoming/no-pass/meta.json', JSON.stringify({ title: 'b', url: 'https://a/c', fetch: { status: 'fetched', at: 'T' } }))
    // A pass that worked, and a link nobody has read yet.
    fake.seed(
      'library/incoming/summarised/meta.json',
      JSON.stringify({ title: 'c', url: 'https://a/d', fetch: { status: 'fetched', at: 'T' }, suggested: { summary: 'A page.', at: 'T', model: 'm' } }),
    )
    fake.seed('library/incoming/unread/meta.json', JSON.stringify({ title: 'd', url: 'https://a/e' }))
    await reindexCatalog()

    expect((await searchCatalog({ attention: 'no-summary' })).map(r => r.slug).sort()).toEqual(['no-pass', 'pass-failed'])
  })

  it('every row a search returns carries a verdict, and the entry read agrees', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    fake.seed('library/datasets/flood-claims/meta.json', JSON.stringify({ title: 'Flood claims, TN' }))
    fake.seed('library/datasets/flood-claims/claims.csv', 'a,b\n1,2\n')
    fake.seed(
      'library/incoming/landowner-page/meta.json',
      JSON.stringify({
        title: 'Engaging landowners',
        url: 'http://www.engaginglandowners.org/',
        inspection: { kind: 'page', page: { insecure: true }, documents: [{ url: 'http://x.org/a.pdf', label: 'A' }] },
      }),
    )
    await reindexCatalog()

    const rows = await searchCatalog({})
    const by = (slug: string) => rows.find(r => r.slug === slug)!.readiness!
    expect(by('epa-npl')).toEqual({ as: 'source', placeReport: 'runs', notes: ['answers a point, not a whole county'] })
    expect(by('flood-claims')).toMatchObject({ as: 'dataset', placeReport: 'never' })
    expect(by('landowner-page')).toEqual({
      as: 'page',
      placeReport: 'never',
      notes: ['1 document on the page can be pulled in', 'served over http'],
    })

    // Read at read time, never stored: nothing in the index holds it.
    const stored = (await libraryQuery(`SELECT meta FROM library_catalog WHERE slug = $1`, ['epa-npl'])).rows[0] as { meta: any }
    expect(JSON.stringify(stored.meta)).not.toContain('readiness')
    expect((await getCatalogEntry('epa-npl'))!.readiness).toEqual(by('epa-npl'))
  })
})

describe('free-text search across fields and wiki backlinks (P5-84)', async () => {
  const { extractWikiMentions } = await import('./libraryCatalog.js')

  it('keeps every link when several sit on one line, even inside parentheses', () => {
    const md = 'see [Georgia](/library/tele-profiles-georgia) (and for [Alabama](/library/tele-profiles-alabama), [Mississippi](/library/tele-profiles-mississippi) and the [US](/library/tele-profiles-us)) say'
    expect(extractWikiMentions(md)).toEqual(['tele-profiles-georgia', 'tele-profiles-alabama', 'tele-profiles-mississippi', 'tele-profiles-us'])
    expect(extractWikiMentions('[a](/library/one?tab=data) and [b](/library/two#files)')).toEqual(['one', 'two'])
  })
})

/**
 * P5-88: the list projection.
 *
 * The rule the tests below hold to is "whatever a LIST reads, a list row
 * carries". So the second test is a copy of the CLIENT's predicates — the
 * attention panel's and the cards' — run twice: once over a full manifest and
 * once over the projection of it. Anything the projection drops that a
 * predicate reads shows up as a disagreement, here, rather than as a chip
 * that stopped appearing in production.
 */
describe('listRowMeta (P5-88)', () => {
  /** Everything a manifest can hold, in the shapes the real ones use. */
  const FULL_META: Record<string, unknown> = {
    // Filing that lives in its own column on the row, duplicated in the file.
    title: 'Georgia EPD — UST/LUST portal',
    category: 'environment',
    status: 'needs-cataloging',
    tags: ['contamination'],
    createdBy: 'maria',
    createdAt: '2026-09-01T00:00:00.000Z',
    // Kept.
    description: 'Underground storage tanks, by site.',
    url: 'https://epd.georgia.gov/ust',
    layer: { name: 'UST sites', geometry: 'point', description: 'Tank sites' },
    supersededBy: 'ga-ust-2025',
    source: {
      provider: 'Georgia EPD',
      program: 'UST/LUST',
      access: [{ type: 'arcgis', url: 'https://x/FeatureServer/0' }],
      fields: [{ name: 'SiteName' }],
      license: 'public domain',
      placeQuery: { by: ['county'] },
      replication: { status: 'indexed' },
      lastError: { at: '2026-09-01T00:00:00.000Z', code: 'http', text: '503' },
    },
    fetch: { status: 'fetched', at: '2026-09-02T10:00:00.000Z', bytes: 84213, name: 'ust.html' },
    suggested: {
      title: 'Georgia UST sites',
      category: 'environment',
      tags: ['contamination'],
      summary: 'Tanks and leaks by site.',
      error: undefined,
      reason: undefined,
      at: '2026-09-02T10:01:00.000Z',
    },
    inspection: {
      kind: 'portal',
      checkedAt: '2026-09-02T10:00:30.000Z',
      links: [{ url: 'https://epd.georgia.gov/a' }],
      documents: [{ url: 'https://epd.georgia.gov/b.pdf' }],
      dropped: ['https://epd.georgia.gov/c'],
      prose: { isDataset: true },
      summary: 'A portal.',
      page: { insecure: false },
    },
    ingest: { plan: 'replicate', done: false, mode: 'by-hand', owner: 'maria', note: 'ask the agency' },
    whatItAnswers: 'Answers: which tanks sit within N miles of an address.',
    // Dropped.
    body: 'A long note body.',
    lineage: { files: ['library/incoming/x/part-0.csv'] },
    pulledDocuments: [{ url: 'https://epd.georgia.gov/b.pdf', name: 'b.pdf' }],
    mentionedBy: [{ slug: 'land-loss', title: 'Land loss' }],
    originalFilename: 'ust.html',
  }

  it('keeps exactly the documented set of keys', () => {
    const projected = listRowMeta(FULL_META)
    // The kept keys, written down in one place. Changing this list is a
    // decision about what a list can read — make it on purpose.
    expect([...LIST_ROW_META_KEYS]).toEqual([
      'description',
      // P7-7: the capability line. On a list row because `search_library` is
      // assembled from one — a model choosing between a dozen candidates has
      // to read it in the rows rather than after a `get_entry` each.
      'whatItAnswers',
      'url',
      'layer',
      'supersededBy',
      'type',
      'dataset',
      'resultCount',
      'layers',
      'savedBy',
      'savedAt',
      // P7-1: the working set a VIEW presents (one slug; '' is the ad-hoc
      // view), and a WORKING SET's own members — so the datasets browser can
      // answer "which sets is this dataset in?" off the one catalog query it
      // already makes, rather than a request per set.
      'workingSet',
      'datasets',
      'sites',
      'purpose',
      // P6-34: how each remediated value got there. A list row has to be able
      // to say "a model wrote this and nobody has looked" — the `unverified`
      // half of P6-33's one attention row.
      'provenance',
      'source',
      'fetch',
      'suggested',
      'inspection',
      'ingest',
    ])
    expect(Object.keys(projected).sort()).toEqual(
      // `suggestedTitle` (P6-8) is derived here rather than copied from a
      // manifest key — it is the proposed title while it is still outstanding.
      ['description', 'whatItAnswers', 'url', 'layer', 'supersededBy', 'source', 'fetch', 'suggested', 'suggestedTitle', 'inspection', 'ingest'].sort(),
    )
    for (const gone of ['body', 'lineage', 'pulledDocuments', 'mentionedBy', 'originalFilename', 'title', 'createdBy']) {
      expect(projected[gone]).toBeUndefined()
    }
  })

  it('carries the suggested title only while nobody has accepted it (P6-8)', () => {
    const suggested = { title: 'Underground storage tanks in Georgia', at: 'now', model: 'm' }
    expect(listRowMeta({ title: 'ust.html', suggested }).suggestedTitle).toBe('Underground storage tanks in Georgia')
    // Accepted: the entry's own title IS the proposal, so there is nothing
    // outstanding for a card to grey out.
    expect(listRowMeta({ title: 'Underground storage tanks in Georgia', suggested }).suggestedTitle).toBeUndefined()
    // A proposal that never produced a title, and a failed pass.
    expect(listRowMeta({ title: 'ust.html', suggested: { summary: 'x', at: 'now', model: 'm' } }).suggestedTitle).toBeUndefined()
    expect(listRowMeta({ title: 'ust.html', suggested: { error: 'unavailable', at: 'now' } }).suggestedTitle).toBeUndefined()
    expect(listRowMeta({ title: 'ust.html' }).suggestedTitle).toBeUndefined()
  })

  it('trims the nested blocks to the fields the list reads', () => {
    const projected = listRowMeta(FULL_META) as any
    expect(projected.source).toEqual({
      provider: 'Georgia EPD',
      lastError: { at: '2026-09-01T00:00:00.000Z', code: 'http', text: '503' },
    })
    expect(projected.fetch).toEqual({ status: 'fetched', at: '2026-09-02T10:00:00.000Z' })
    expect(projected.inspection).toEqual({ kind: 'portal', checkedAt: '2026-09-02T10:00:30.000Z' })
    expect(projected.ingest).toEqual({ plan: 'replicate', done: false })
    // The whole suggestion: every field in it is read by hasSuggestion or
    // modelPassGap.
    expect(projected.suggested).toEqual(FULL_META.suggested)
    // Presence is all `layerIdForEntry` asks of the layer block.
    expect(typeof projected.layer).toBe('object')
  })

  it('survives the shapes a hand-written manifest actually takes', () => {
    expect(listRowMeta(undefined)).toEqual({})
    expect(listRowMeta(null)).toEqual({})
    expect(listRowMeta({})).toEqual({})
    // Datasets have carried plain provenance prose in `source` since the
    // first content load. No list consumer reads it, and it must not throw.
    expect(listRowMeta({ source: 'county assessor scrape' })).toEqual({})
    // A block with nothing a list reads leaves no empty husk behind.
    expect(listRowMeta({ source: { license: 'public domain' }, inspection: { summary: 'x' } })).toEqual({})
    expect(listRowMeta({ description: '' })).toEqual({ description: '' })
  })

  it('answers every list predicate the same way as the full manifest', () => {
    // --- The client's readers, copied from src/lib/libraryCatalog.ts and
    // src/lib/kb.ts. Field names are the contract; keep them spelled the same.
    type Row = { kind: string; status: string; category: string; tags: string[]; meta: Record<string, any>; files: { key: string }[] }
    const sourceOf = (e: Row) => {
      const raw = e.meta?.source
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      return typeof raw.provider === 'string' && raw.provider ? raw : null
    }
    const INSPECT_KINDS = ['arcgis-layer', 'arcgis-service', 'socrata', 'file', 'page', 'portal', 'unreachable']
    const inspectionOf = (e: Row) => {
      const raw = e.meta?.inspection
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      return INSPECT_KINDS.includes(raw.kind) ? raw : null
    }
    const FETCH_STATUSES = ['queued', 'later', 'fetching', 'fetched', 'failed']
    const fetchStateOf = (e: Row) => {
      const raw = e.meta?.fetch
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      return FETCH_STATUSES.includes(raw.status) ? raw : null
    }
    const INGEST_PLANS = ['replicate', 'link-only', 'drop']
    const ingestOf = (e: Row) => {
      const raw = e.meta?.ingest
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
      return INGEST_PLANS.includes(raw.plan) ? raw : null
    }
    const linkOf = (e: Row) => {
      const url = e.meta?.url
      return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim() : null
    }
    const layerIdForEntry = (e: Row & { slug?: string }) => {
      const layer = e.meta?.layer
      if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return null
      return e.status === 'published' ? `internal-${e.slug ?? 'x'}` : null
    }
    const hasSuggestion = (e: Row) => {
      const s = e.meta?.suggested
      if (!s || typeof s !== 'object' || Array.isArray(s) || s.error) return false
      return !!(s.title || s.category || s.summary || s.tags?.length)
    }
    const modelPassGap = (e: Row) => {
      if (hasSuggestion(e)) return null
      const s = e.meta?.suggested
      const fetch = fetchStateOf(e)
      const failed = s?.error === 'unavailable'
      const readWithNothingToShow = !s && fetch?.status === 'fetched'
      if (!failed && !readWithNothingToShow) return null
      const readAt = inspectionOf(e)?.checkedAt || fetch?.at || s?.at
      return { ...(readAt ? { readAt } : {}), ...(s?.reason ? { reason: s.reason } : {}) }
    }
    // The attention panel and the card, as booleans and strings.
    const verdicts = (e: Row & { slug?: string }) => ({
      provider: sourceOf(e)?.provider ?? null,
      sourceFailing: !!sourceOf(e)?.lastError,
      inspectionFailed: inspectionOf(e)?.kind === 'unreachable',
      fetchStatus: fetchStateOf(e)?.status ?? null,
      fetchPending: ['queued', 'fetching'].includes(fetchStateOf(e)?.status ?? ''),
      link: linkOf(e),
      unfetchedLink: e.kind === 'incoming' && !!linkOf(e) && !['queued', 'fetching'].includes(fetchStateOf(e)?.status ?? '') && e.files.every(f => f.key.endsWith('/meta.json')),
      needsPlan: e.kind === 'incoming' && !!linkOf(e) && !ingestOf(e),
      replicatePending: ingestOf(e)?.plan === 'replicate' && !ingestOf(e)?.done,
      hasSuggestion: hasSuggestion(e),
      modelPassGap: modelPassGap(e),
      layerId: layerIdForEntry(e),
      description: e.meta?.description ?? null,
      supersededBy: e.meta?.supersededBy ?? null,
      // Saved views: ⌘K's line and "which views use this layer?".
      viewType: e.meta?.type ?? null,
      viewLayers: e.meta?.layers ?? null,
      savedBy: e.meta?.savedBy ?? null,
      savedAt: e.meta?.savedAt ?? null,
    })

    const rowWith = (meta: Record<string, unknown>, over: Partial<Row> = {}): Row & { slug: string } => ({
      slug: 'ga-ust',
      kind: 'incoming',
      status: 'needs-cataloging',
      category: 'environment',
      tags: ['contamination'],
      files: [{ key: 'library/incoming/ga-ust/meta.json' }],
      meta,
      ...over,
    })

    // Every manifest shape the predicates branch on.
    const cases: Array<[string, Record<string, unknown>, Partial<Row>?]> = [
      ['the fat link', FULL_META],
      ['a published layer dataset', { layer: { name: 'x' }, description: 'A layer.' }, { kind: 'dataset', status: 'published' }],
      ['an unreachable link', { url: 'https://gone.example/x', inspection: { kind: 'unreachable', checkedAt: '2026-09-02T00:00:00.000Z', links: [] } }],
      ['a failing source', { source: { provider: 'US EPA', lastError: { at: 'now', code: 'http', text: '503' }, access: [{ type: 'rest' }] } }, { kind: 'source' }],
      ['a read link the model could not summarise', { url: 'https://x.example/a', suggested: { error: 'unavailable', reason: 'budget', at: '2026-09-02T00:00:00.000Z' }, fetch: { status: 'fetched', at: '2026-09-02T00:00:00.000Z' } }],
      ['a read link with no suggestion at all', { url: 'https://x.example/b', fetch: { status: 'fetched', at: '2026-09-02T00:00:00.000Z', bytes: 12 } }],
      ['a link still being fetched', { url: 'https://x.example/c', fetch: { status: 'fetching', at: '2026-09-02T00:00:00.000Z' } }],
      ['a saved view', { type: 'table', description: '3 counties × 4 layers', savedBy: 'maria', savedAt: '2026-09-02T00:00:00.000Z', layers: ['internal-tn-heirs'], dataset: 'landholders', resultCount: 12 }, { kind: 'view', status: 'published' }],
      ['a plain note', { body: 'text', description: '' }, { kind: 'note', status: 'open' }],
    ]

    for (const [name, meta, over] of cases) {
      const full = rowWith(meta, over)
      const list = rowWith(listRowMeta(meta), over)
      expect(verdicts(list), `${name}: a list row must answer like the manifest it came from`).toEqual(verdicts(full))
    }
  })
})

describe('list rows over the wire (P5-88)', () => {
  it('searchCatalogPage projects, and full: true does not', async () => {
    fake.seed(
      'library/sources/epa-npl/meta.json',
      JSON.stringify({
        title: 'EPA NPL',
        status: 'published',
        description: 'Superfund sites.',
        source: { provider: 'US EPA', access: [{ type: 'arcgis', url: 'https://x/0' }], fields: [{ name: 'Site' }] },
      }),
    )
    fake.seed('library/notes/a-note/meta.json', JSON.stringify({ title: 'A note', status: 'open', body: 'the body' }))
    await reindexCatalog()

    const list = await searchCatalogPage({})
    const npl = list.entries.find(e => e.slug === 'epa-npl')!
    expect((npl.meta as any).source).toEqual({ provider: 'US EPA' })
    expect(list.entries.find(e => e.slug === 'a-note')!.meta.body).toBeUndefined()
    // The verdict is computed from the FULL manifest before the cut, so a
    // source that can be queried still says so on a list row.
    expect(npl.readiness).toMatchObject({ as: 'source', placeReport: 'runs' })

    const full = await searchCatalogPage({ full: true })
    expect((full.entries.find(e => e.slug === 'epa-npl')!.meta as any).source.access).toHaveLength(1)
    expect(full.entries.find(e => e.slug === 'a-note')!.meta.body).toBe('the body')

    // searchCatalog is the SERVER's reader — the place report wants
    // source.access, the kb index wants a note's body. It is never projected.
    const rows = await searchCatalog({})
    expect((rows.find(r => r.slug === 'epa-npl')!.meta as any).source.access).toHaveLength(1)
    expect(rows.find(r => r.slug === 'a-note')!.meta.body).toBe('the body')
  })

  it('filters, counts and sorts still read the full manifest', async () => {
    fake.seed(
      'library/incoming/no-plan/meta.json',
      JSON.stringify({ title: 'A link', status: 'needs-cataloging', url: 'https://x.example/a', inspection: { kind: 'unreachable', checkedAt: 'now', links: [{ url: 'https://x.example/b' }] } }),
    )
    await reindexCatalog()
    const unreachable = await searchCatalogPage({ attention: 'unreachable' })
    expect(unreachable.entries.map(e => e.slug)).toEqual(['no-plan'])
    // …and the row it hands back is still a list row.
    expect((unreachable.entries[0].meta as any).inspection.links).toBeUndefined()
  })
})

describe('the archived scan behind getCatalogEntry (P5-88)', () => {
  const ARCHIVED_SCAN = /status = 'archived'/

  it('reads the archived rows once per catalog generation, not once per entry', async () => {
    fake.seed('library/documents/old-memo/meta.json', JSON.stringify({ title: 'Old memo', status: 'archived', supersededBy: 'new-memo' }))
    fake.seed('library/documents/new-memo/meta.json', JSON.stringify({ title: 'New memo', status: 'published' }))
    fake.seed('library/wiki/home.md', '# Home\n')
    await reindexCatalog()

    sql.length = 0
    const first = await getCatalogEntry('new-memo')
    expect(first!.supersedes).toEqual([{ slug: 'old-memo', title: 'Old memo' }])
    expect(sql.filter(s => ARCHIVED_SCAN.test(s))).toHaveLength(1)

    // The kb landing resolves one pinned slug after another; before this
    // ticket each of those scanned every archived row again.
    for (let i = 0; i < 5; i++) await getCatalogEntry('new-memo')
    await getCatalogEntry('home')
    expect(sql.filter(s => ARCHIVED_SCAN.test(s))).toHaveLength(1)
  })

  it('re-reads them as soon as the catalog changes', async () => {
    fake.seed('library/documents/new-memo/meta.json', JSON.stringify({ title: 'New memo', status: 'published' }))
    await reindexCatalog()
    expect((await getCatalogEntry('new-memo'))!.supersedes).toEqual([])

    sql.length = 0
    fake.seed('library/documents/old-memo/meta.json', JSON.stringify({ title: 'Old memo', status: 'archived', supersededBy: 'new-memo' }))
    await reindexCatalog()
    const after = await getCatalogEntry('new-memo')
    expect(after!.supersedes).toEqual([{ slug: 'old-memo', title: 'Old memo' }])
    expect(sql.filter(s => ARCHIVED_SCAN.test(s)).length).toBeGreaterThanOrEqual(1)
  })

  it('hands each caller its own list, so one cannot rewrite the next one', async () => {
    fake.seed('library/documents/old-memo/meta.json', JSON.stringify({ title: 'Old memo', status: 'archived', supersededBy: 'new-memo' }))
    fake.seed('library/documents/new-memo/meta.json', JSON.stringify({ title: 'New memo', status: 'published' }))
    await reindexCatalog()
    const first = await getCatalogEntry('new-memo')
    first!.supersedes.push({ slug: 'invented', title: 'Invented' })
    expect((await getCatalogEntry('new-memo'))!.supersedes).toEqual([{ slug: 'old-memo', title: 'Old memo' }])
  })
})

// --- P6-1 / P6-2: who published it, and what kind of thing it is -----------

describe('reindexCatalog — organization (P6-1)', () => {
  it('files a source under the publisher its provider names', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    await reindexCatalog()
    const entry = await getCatalogEntry('epa-npl')
    expect(entry).toMatchObject({ organization: 'epa', organizationLabel: 'US EPA' })
    // Stored in the manifest the row carries, so a filter compares one word.
    expect(entry!.meta.organization).toBe('epa')
  })

  it('files a dataset under the publisher its free source prose names', async () => {
    fake.seed(
      'library/datasets/gardens/meta.json',
      JSON.stringify({ title: 'Gardens', source: 'DC Open Data — Community Gardens (ArcGIS export, EDITED 2024-11-19)' }),
    )
    await reindexCatalog()
    expect(await getCatalogEntry('gardens')).toMatchObject({ organization: 'dc-open-data', organizationLabel: 'DC Open Data' })
  })

  it('lets a manifest field win over the provider string', async () => {
    fake.seed(
      'library/sources/odd/meta.json',
      JSON.stringify({ title: 'Odd', organization: 'usda-fs', source: { provider: 'US EPA' } }),
    )
    await reindexCatalog()
    expect(await getCatalogEntry('odd')).toMatchObject({ organization: 'usda-fs', organizationLabel: 'USDA · Forest Service' })
  })

  it('keeps an unknown publisher’s own text as its own group', async () => {
    fake.seed('library/sources/deeds/meta.json', JSON.stringify({ title: 'Deeds', source: { provider: 'Shelby County Register of Deeds' } }))
    await reindexCatalog()
    const entry = await getCatalogEntry('deeds')
    // Shown as written — the group heading is the publisher's own words.
    expect(entry!.organization).toBe('Shelby County Register of Deeds')
    expect(entry!.organizationLabel).toBe('Shelby County Register of Deeds')
  })

  it('leaves the field off an entry that names nobody', async () => {
    fake.seed('library/documents/memo/meta.json', JSON.stringify({ title: 'Memo' }))
    await reindexCatalog()
    const entry = await getCatalogEntry('memo')
    expect(entry!.organization).toBeUndefined()
    expect(entry!.meta.organization).toBeUndefined()
  })

  it('filters on it, and counts the gap on the admin queue', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    fake.seed('library/sources/deeds/meta.json', JSON.stringify({ title: 'Deeds', source: { provider: 'Shelby County Register of Deeds' } }))
    fake.seed('library/datasets/nameless/meta.json', JSON.stringify({ title: 'Nameless' }))
    // A document with no publisher is NOT work waiting on anyone.
    fake.seed('library/documents/memo/meta.json', JSON.stringify({ title: 'Memo' }))
    await reindexCatalog()

    expect((await searchCatalog({ organization: 'epa' })).map(r => r.slug)).toEqual(['epa-npl'])
    expect((await searchCatalog({ organization: 'Shelby County Register of Deeds' })).map(r => r.slug)).toEqual(['deeds'])
    expect((await searchCatalog({ organization: 'usda' })).map(r => r.slug)).toEqual([])
    expect((await searchCatalog({ attention: 'no-organization' })).map(r => r.slug).sort()).toEqual(['deeds', 'nameless'])
  })
})

describe('reindexCatalog — shape (P6-2)', () => {
  const seedDataset = (slug: string, meta: Record<string, unknown>, files: Record<string, string> = {}) => {
    fake.seed(`library/datasets/${slug}/meta.json`, JSON.stringify(meta))
    for (const [name, body] of Object.entries(files)) fake.seed(`library/datasets/${slug}/${name}`, body)
  }

  it('reads a layer block, a source block and a held table, and stores each', async () => {
    seedDataset('sites', { title: 'Sites', layer: { geometry: 'point', file: 'sites.csv', latKey: 'lat', lngKey: 'lng' } }, { 'sites.csv': 'name,lat,lng\nA,1,2\n' })
    seedDataset('acs', { title: 'ACS' }, { 'acs.csv': 'GEOID,median_income\n13089,65000\n' })
    seedDataset('people', { title: 'People' }, { 'people.csv': 'Name,Roles\nA,B\n' })
    fake.seed('library/sources/parcels/meta.json', JSON.stringify({ title: 'Parcels', source: { provider: 'Regrid', placeQuery: { by: ['point', 'parcel'] } } }))
    await reindexCatalog()

    expect(await getCatalogEntry('sites')).toMatchObject({ shape: 'points', shapeLabel: 'Sites and points' })
    expect(await getCatalogEntry('acs')).toMatchObject({ shape: 'statistics', shapeLabel: 'Statistics by county or tract' })
    expect(await getCatalogEntry('people')).toMatchObject({ shape: 'records', shapeLabel: 'Records without a location' })
    expect(await getCatalogEntry('parcels')).toMatchObject({ shape: 'areas', shapeLabel: 'Areas and boundaries' })
    expect((await getCatalogEntry('acs'))!.meta.shape).toBe('statistics')
  })

  it('lets the manifest override the reading', async () => {
    seedDataset('zones', { title: 'Zones', shape: 'areas' }, { 'zones.csv': 'GEOID,zone\n13089,A\n' })
    await reindexCatalog()
    expect(await getCatalogEntry('zones')).toMatchObject({ shape: 'areas' })
  })

  it('leaves the field off a document — only datasets and sources have one', async () => {
    fake.seed('library/documents/memo/meta.json', JSON.stringify({ title: 'Memo' }))
    await reindexCatalog()
    expect((await getCatalogEntry('memo'))!.shape).toBeUndefined()
  })

  it('filters on it', async () => {
    seedDataset('sites', { title: 'Sites', layer: { geometry: 'point', file: 'sites.csv', latKey: 'lat', lngKey: 'lng' } }, { 'sites.csv': 'name,lat,lng\nA,1,2\n' })
    seedDataset('acs', { title: 'ACS' }, { 'acs.csv': 'GEOID,median_income\n13089,65000\n' })
    await reindexCatalog()
    expect((await searchCatalog({ shape: 'points' })).map(r => r.slug)).toEqual(['sites'])
    expect((await searchCatalog({ shape: 'statistics' })).map(r => r.slug)).toEqual(['acs'])
    expect((await searchCatalog({ shape: 'records' })).map(r => r.slug)).toEqual([])
  })

  it('survives a table it cannot read and leaves the entry as records', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedDataset('broken', { title: 'Broken' }, { 'broken.geojson': '{"features":[' })
    await reindexCatalog()
    expect(await getCatalogEntry('broken')).toMatchObject({ shape: 'records' })
    warn.mockRestore()
  })
})

describe('reindexCatalog — coverage (P6-19)', () => {
  const seedDataset = (slug: string, meta: Record<string, unknown>, files: Record<string, string> = {}) => {
    fake.seed(`library/datasets/${slug}/meta.json`, JSON.stringify(meta))
    for (const [name, body] of Object.entries(files)) fake.seed(`library/datasets/${slug}/${name}`, body)
  }

  it('reads a held table’s GEOIDs, a source block and a state agency’s name, and stores each', async () => {
    seedDataset('georgia', { title: 'Georgia parcels' }, { 'g.csv': 'GEOID,value\n13121,1\n13089,2\n' })
    seedDataset('memphis', { title: 'Memphis' }, { 'm.csv': 'GEOID,name\n47157,a\n28033,b\n' })
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    fake.seed(
      'library/sources/adem/meta.json',
      JSON.stringify({ title: 'ADEM', source: { provider: 'Alabama Department of Environmental Management' } }),
    )
    await reindexCatalog()

    // Georgia only, with its counties named — the ticket's first criterion.
    expect((await getCatalogEntry('georgia'))!.coverage).toMatchObject({
      scope: 'state',
      states: ['GA'],
      counties: ['13089', '13121'],
      label: 'Georgia',
    })
    expect((await getCatalogEntry('memphis'))!.coverage).toMatchObject({ scope: 'multi-state', states: ['MS', 'TN'] })
    // A nationwide register claims NO single state.
    expect((await getCatalogEntry('epa-npl'))!.coverage).toMatchObject({ scope: 'national', states: [] })
    expect((await getCatalogEntry('adem'))!.coverage).toMatchObject({ scope: 'state', states: ['AL'] })
    // Stored in the manifest, like the shape, so no ALTER TABLE was needed.
    expect((await getCatalogEntry('georgia'))!.meta.coverage).toMatchObject({ states: ['GA'] })
  })

  it('lets the manifest override the reading', async () => {
    seedDataset('zones', { title: 'Zones', coverage: 'state:AL' }, { 'zones.csv': 'GEOID,zone\n13089,A\n' })
    await reindexCatalog()
    expect((await getCatalogEntry('zones'))!.coverage).toMatchObject({ scope: 'state', states: ['AL'] })
  })

  it('leaves the field off entirely when nothing can place it — never "national"', async () => {
    seedDataset('people', { title: 'People' }, { 'people.csv': 'Name,Roles\nA,B\n' })
    await reindexCatalog()
    const entry = await getCatalogEntry('people')
    expect(entry!.coverage).toBeUndefined()
    expect(entry!.meta.coverage).toBeUndefined()
  })

  it('leaves the field off a document — only datasets and sources have one', async () => {
    fake.seed('library/documents/memo/meta.json', JSON.stringify({ title: 'Memo' }))
    await reindexCatalog()
    expect((await getCatalogEntry('memo'))!.coverage).toBeUndefined()
  })

  it('filters on a scope, on a state however it is spelled, and counts the gap on the queue', async () => {
    seedDataset('georgia', { title: 'Georgia parcels' }, { 'g.csv': 'GEOID\n13121\n' })
    seedDataset('memphis', { title: 'Memphis' }, { 'm.csv': 'GEOID\n47157\n13121\n' })
    seedDataset('people', { title: 'People' }, { 'people.csv': 'Name\nA\n' })
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    // A document with no coverage is NOT work waiting on anyone.
    fake.seed('library/documents/memo/meta.json', JSON.stringify({ title: 'Memo' }))
    await reindexCatalog()

    expect((await searchCatalog({ coverage: 'national' })).map(r => r.slug)).toEqual(['epa-npl'])
    // "What do we hold for Georgia?" — the one-state table AND the table that
    // covers it among others, and NOT the nationwide register.
    for (const spelling of ['GA', 'ga', 'Georgia', '13']) {
      expect((await searchCatalog({ state: spelling })).map(r => r.slug).sort()).toEqual(['georgia', 'memphis'])
      expect((await searchCatalog({ coverage: spelling })).map(r => r.slug).sort()).toEqual(['georgia', 'memphis'])
    }
    expect((await searchCatalog({ state: 'AK' })).map(r => r.slug)).toEqual([])
    // A place the vocabulary has never heard of matches nothing, rather than
    // quietly matching everything.
    expect((await searchCatalog({ state: 'Atlantis' })).map(r => r.slug)).toEqual([])
    expect((await searchCatalog({ coverage: 'none' })).map(r => r.slug)).toEqual(['people'])
    expect((await searchCatalog({ attention: 'no-coverage' })).map(r => r.slug)).toEqual(['people'])
  })

  it('survives a table it cannot read and simply has no coverage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedDataset('broken', { title: 'Broken' }, { 'broken.geojson': '{"features":[' })
    await reindexCatalog()
    const entry = await getCatalogEntry('broken')
    expect(entry).toBeTruthy()
    expect(entry!.coverage).toBeUndefined()
    warn.mockRestore()
  })

  it('re-reads a table that was pushed over its old self, so a geocode pass shows up', async () => {
    // The reindex read is `fresh` for exactly this: the local mirror is a
    // cache of whole objects by key and cannot know a push replaced one, so a
    // cleaned table would otherwise be re-indexed from the copy already on
    // disk and its coverage derived from the GEOIDs it had BEFORE the
    // geocoder ran.
    seedDataset('acs', { title: 'ACS' }, { 'acs.csv': 'name,value\nA,1\n' })
    await reindexCatalog()
    expect((await getCatalogEntry('acs'))!.coverage).toBeUndefined()
    fake.seed('library/datasets/acs/acs.csv', 'name,value,GEOID\nA,1,13121\n')
    await reindexCatalog()
    expect((await getCatalogEntry('acs'))!.coverage).toMatchObject({ states: ['GA'] })
  })

  it('is never frozen into the bucket manifest, so every reindex re-derives it', async () => {
    // The reading goes into the catalog row's meta, NOT back into the file the
    // tree is the truth for. That is the whole reason `retag --coverage` is
    // report-only: a coverage improves the moment a table gains a GEOID
    // column, and a value written into the manifest would stop improving.
    seedDataset('acs', { title: 'ACS' }, { 'acs.csv': 'GEOID,value\n13121,1\n' })
    await reindexCatalog()
    expect((await getCatalogEntry('acs'))!.coverage).toMatchObject({ states: ['GA'] })
    const manifest = JSON.parse((await getFile('library/datasets/acs/meta.json', { fresh: true })).toString('utf8'))
    expect(manifest.coverage).toBeUndefined()
    // And it is derived again, identically, on the next run.
    await reindexCatalog()
    expect((await getCatalogEntry('acs'))!.coverage).toMatchObject({ states: ['GA'] })
  })
})

describe('list rows carry the new words (P6-1, P6-2, P6-19)', () => {
  it('sends them on a LIST row, where the manifest itself is cut down', async () => {
    fake.seed('library/sources/epa-npl/meta.json', JSON.stringify(NPL))
    await reindexCatalog()
    const { entries } = await searchCatalogPage({})
    const row = entries.find(e => e.slug === 'epa-npl')!
    expect(row).toMatchObject({ organization: 'epa', organizationLabel: 'US EPA', shape: 'points', shapeLabel: 'Sites and points' })
    expect(row.coverage).toMatchObject({ scope: 'national', label: 'National' })
    // The projection really did cut the manifest: the fields above are on the
    // ROW, not fished back out of a full block. `source.coverage`, which the
    // reading was made from, is one of the keys it cuts.
    expect(Object.keys(row.meta.source as object)).toEqual(['provider'])
  })
})

describe('the to-file queue is scoped to its owner (P6-5a)', () => {
  const MARIA = { username: 'maria', role: 'internal' }
  const OMAR = { username: 'omar', role: 'internal' }
  const BOSS = { username: 'boss', role: 'admin' }

  /** One queue row per door into the queue: an upload writes `uploadedBy`,
   *  a dropped link writes `linkedBy`, and an older row writes neither. */
  async function seedQueue(): Promise<void> {
    fake.seed(
      'library/incoming/marias-upload/meta.json',
      JSON.stringify({ title: 'Marias upload', status: 'needs-cataloging', uploadedBy: 'maria' }),
    )
    fake.seed(
      'library/incoming/marias-link/meta.json',
      JSON.stringify({ title: 'Marias link', status: 'needs-cataloging', url: 'https://x.example/a', linkedBy: 'maria' }),
    )
    fake.seed(
      'library/incoming/omars-upload/meta.json',
      JSON.stringify({ title: 'Omars upload', status: 'needs-cataloging', uploadedBy: 'omar' }),
    )
    fake.seed('library/incoming/nameless/meta.json', JSON.stringify({ title: 'From before', status: 'needs-cataloging' }))
    fake.seed('library/documents/plan/meta.json', JSON.stringify({ title: 'The plan', status: 'published' }))
    await reindexCatalog()
  }

  const slugs = (rows: { slug: string }[]) => rows.map(r => r.slug).sort()

  it('shows a member their own drops — whichever door they came through — and nobody else’s', async () => {
    await seedQueue()
    expect(slugs(await searchCatalog({ viewer: MARIA }))).toEqual(['marias-link', 'marias-upload', 'plan'])
    expect(slugs(await searchCatalog({ viewer: OMAR }))).toEqual(['omars-upload', 'plan'])
  })

  it('shows an admin the whole queue, legacy rows included', async () => {
    await seedQueue()
    expect(slugs(await searchCatalog({ viewer: BOSS }))).toEqual([
      'marias-link',
      'marias-upload',
      'nameless',
      'omars-upload',
      'plan',
    ])
  })

  it('treats a row with no dropper on it as admin-only', async () => {
    await seedQueue()
    const rows = await searchCatalog({ viewer: MARIA })
    expect(rows.find(r => r.slug === 'nameless')).toBeUndefined()
  })

  it('shows an anonymous viewer no queue at all', async () => {
    await seedQueue()
    expect(slugs(await searchCatalog({ viewer: null }))).toEqual(['plan'])
  })

  it('leaves the server’s own readers alone — no viewer, no scoping', async () => {
    // The Ask index, text extraction, the place report and MCP all call
    // `searchCatalog({})`; scoping those would silently drop material from
    // answers rather than protect anything.
    await seedQueue()
    expect(slugs(await searchCatalog({}))).toEqual([
      'marias-link',
      'marias-upload',
      'nameless',
      'omars-upload',
      'plan',
    ])
  })

  it('hides the rows from the count and the filters too, not just the list', async () => {
    await seedQueue()
    const page = await searchCatalogPage({ kind: 'incoming', viewer: OMAR })
    expect(slugs(page.entries)).toEqual(['omars-upload'])
    // A free-text search cannot reach past the scope either.
    expect(slugs(await searchCatalog({ q: 'Marias', viewer: OMAR }))).toEqual([])
  })

  it('names the dropper on the list row, under one key', async () => {
    await seedQueue()
    const page = await searchCatalogPage({ viewer: BOSS })
    const by = (slug: string) => (page.entries.find(e => e.slug === slug)!.meta as any).uploadedBy
    expect(by('marias-upload')).toBe('maria')
    // `linkedBy` is the other spelling of the same fact — the list publishes
    // one key so a browser does not have to know which door it came through.
    expect(by('marias-link')).toBe('maria')
    expect(by('omars-upload')).toBe('omar')
    expect(by('nameless')).toBeUndefined()
  })
})

describe('entryOwner (P6-5a)', () => {
  it('reads either field, trims it, and says nothing when there is nothing to say', async () => {
    const { entryOwner } = await import('./libraryCatalog.js')
    expect(entryOwner({ uploadedBy: 'maria' })).toBe('maria')
    expect(entryOwner({ linkedBy: ' omar ' })).toBe('omar')
    // An upload that was later re-filed keeps both; the upload wins.
    expect(entryOwner({ uploadedBy: 'maria', linkedBy: 'omar' })).toBe('maria')
    expect(entryOwner({ uploadedBy: '' })).toBe('')
    expect(entryOwner({ uploadedBy: 42 })).toBe('')
    expect(entryOwner({})).toBe('')
    expect(entryOwner(undefined)).toBe('')
    expect(entryOwner(null)).toBe('')
  })
})
