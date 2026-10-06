import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'
import { makePdf, makeDocx } from '../testutils/fixtures/documents.js'

/**
 * P5-41 retrieval: tokenising, heading chunking, the index build over a real
 * (fake-bucket) library, BM25 scoring with the title boost, and the context
 * budget. No model involved — this is the half of "ask" that has to be right
 * before the prompt is even written.
 */

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { extractPending, derivedKey } = await import('./textExtract.js')
const {
  tokenise,
  chunkMarkdown,
  buildKbIndex,
  getKbIndex,
  clearKbIndex,
  scoreChunks,
  selectContext,
  hrefForEntry,
  layerIdForEntry,
  publicLayerChunkText,
  PUBLIC_LAYERS,
  CHUNK_MAX_CHARS,
} = await import('./kbSearch.js')

type KbIndexType = Awaited<ReturnType<typeof buildKbIndex>>

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: FakeS3
let dataDir: string

const PAGE = `# Funding strategy

The initiative asks for five million dollars over three years.

## Year two

Year two moves from acquisition to stewardship, with a land trust cohort in Georgia.

## Year three

Year three is evaluation only.
`

beforeEach(async () => {
  clearKbIndex()
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-kbsearch-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })

  fake.seed('library/wiki/funding-strategy.md', PAGE)
  fake.seed('library/datasets/organizations/organizations.csv', 'Organization,HQ State,Tier\nBlack Farmer Fund,NY,Tier 1\nSouthwest Georgia Project,GA,Tier 1\n')
  fake.seed('library/datasets/organizations/README.md', '# About this table\n\nOne row per organization we have contact with. Tier is our own ranking.\n')
  fake.seed(
    'library/datasets/organizations/meta.json',
    JSON.stringify({
      title: 'Organizations',
      category: 'network',
      status: 'published',
      tags: ['network', 'georgia'],
      description: 'Organizations doing land work, one row each.',
      layer: { geometry: 'point', name: 'Organizations (HQ)', description: 'HQ points', source: 'staff', year: 2026, latKey: '_lat', lngKey: '_lng', labelKey: 'Organization' },
    }),
  )
  fake.seed('library/documents/old-comparison/table.pdf', '%PDF-secret-bytes')
  fake.seed(
    'library/documents/old-comparison/meta.json',
    JSON.stringify({ title: 'Landowner comparison table', category: 'research', status: 'archived', tags: [], supersededBy: 'landholders' }),
  )
  fake.seed(
    'library/notes/call-with-maria/meta.json',
    JSON.stringify({ title: 'Call with Maria', body: 'Maria wants heirs property counts for Tennessee before the board meeting.', category: 'ideas', status: 'open', tags: [] }),
  )
  await reindexCatalog()
})

afterEach(async () => {
  // The reindex hook sweeps for new document text detached from the request
  // (P5-46). Join it before the bucket goes away, so one test's sweep can
  // never still be running during the next.
  await extractPending()
  clearKbIndex()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('tokenise', () => {
  it('lowercases, splits on punctuation, and drops stopwords and single characters', () => {
    expect(tokenise('Which organizations in Georgia do land trusts?')).toEqual([
      'organizations',
      'georgia',
      'land',
      'trusts',
    ])
  })

  it('keeps numbers — years, FIPS codes and dollar figures are what people search for', () => {
    expect(tokenise('$5,000,000 in 2026 for county 47157')).toEqual(['000', '000', '2026', 'county', '47157'])
  })

  it('returns nothing for punctuation-only input', () => {
    expect(tokenise('??? — ...')).toEqual([])
  })
})

describe('chunkMarkdown', () => {
  it('splits at headings and keeps each heading with its section', () => {
    const chunks = chunkMarkdown(PAGE)
    expect(chunks.map(c => c.heading)).toEqual(['Funding strategy', 'Year two', 'Year three'])
    expect(chunks[1].text).toContain('stewardship')
    expect(chunks[0].text).not.toContain('Year two')
  })

  it('hard-splits a section longer than the cap, on paragraph boundaries', () => {
    const para = 'x'.repeat(600)
    const chunks = chunkMarkdown(`# Big\n\n${para}\n\n${para}\n\n${para}\n\n${para}`, CHUNK_MAX_CHARS)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS)
      expect(chunk.heading).toBe('Big')
    }
  })

  it('splits a single oversized paragraph rather than emitting one huge chunk', () => {
    const chunks = chunkMarkdown('y'.repeat(4_000), 1_000)
    expect(chunks.length).toBe(4)
    expect(Math.max(...chunks.map(c => c.text.length))).toBeLessThanOrEqual(1_000)
  })

  it('returns nothing for an empty page', () => {
    expect(chunkMarkdown('   \n\n  ')).toEqual([])
  })
})

describe('buildKbIndex', () => {
  let index: KbIndexType
  beforeEach(async () => {
    index = await buildKbIndex()
  })

  it('indexes a catalog chunk per entry plus the wiki page, note body, dataset schema and README', () => {
    const sources = (slug: string) => index.chunks.filter(c => c.slug === slug).map(c => c.source)
    expect(sources('funding-strategy')).toEqual(['entry', 'page', 'page', 'page'])
    expect(sources('organizations').sort()).toEqual(['entry', 'readme', 'schema'])
    expect(sources('call-with-maria')).toEqual(['entry', 'note'])
  })

  it('describes a dataset by its columns, types and row count', () => {
    const schema = index.schemaBySlug.get('organizations')
    expect(schema?.text).toContain('2 rows')
    expect(schema?.text).toContain('Organization (string)')
    expect(schema?.text).toContain('HQ State (string)')
    expect(schema?.href).toBe('/library/organizations?tab=data')
  })

  it('never reads the bytes of a non-text file', () => {
    for (const chunk of index.chunks) expect(chunk.text).not.toContain('%PDF')
  })

  it('leaves archived entries out — superseded material must not be quoted as current', () => {
    expect(index.chunks.some(c => c.slug === 'old-comparison')).toBe(false)
  })

  it('records the map layer id for entries that power one', () => {
    expect(index.entryBySlug.get('organizations')?.layerId).toBe('internal-organizations')
    expect(index.entryBySlug.get('funding-strategy')?.layerId).toBeNull()
  })

  it('counts what it read, for the loading line', () => {
    expect(index.counts).toMatchObject({ pages: 1, datasets: 1, notes: 1 })
  })

  it('caches, and the reindex hook drops the cache', async () => {
    const first = await getKbIndex()
    expect(await getKbIndex()).toBe(first)
    await reindexCatalog()
    expect(await getKbIndex()).not.toBe(first)
  })
})

describe('document pages (P5-46)', () => {
  const PLAN_PDF = makePdf([
    'Page one sets out the acquisition budget for the land trust.',
    'Page two names the cohort counties in Alabama and Mississippi.',
  ])
  const MANUAL_DOCX = makeDocx(['Heirs property is defined here, in the fact manual.'])
  let index: KbIndexType

  beforeEach(async () => {
    fake.seed('library/documents/plan/Five_Year_Plan.pdf', PLAN_PDF)
    fake.seed('library/documents/plan/Fact_Manual.docx', MANUAL_DOCX)
    fake.seed(
      'library/documents/plan/meta.json',
      JSON.stringify({ title: 'Strategic plan', category: 'strategy', status: 'published', tags: [] }),
    )
    await reindexCatalog()
    await extractPending()
    clearKbIndex()
    index = await buildKbIndex()
  })

  const pageChunks = () => index.chunks.filter(c => c.slug === 'plan' && c.source === 'document')

  it('adds one chunk per page, labelled "p. N" and linked to that page', () => {
    const pdf = pageChunks().filter(c => c.href.includes('Five_Year_Plan.pdf'))
    expect(pdf.map(c => c.heading)).toEqual(['p. 1', 'p. 2'])
    expect(pdf[0].text).toContain('acquisition budget')
    expect(pdf[1].text).toContain('cohort counties')
    expect(pdf[0].href).toBe('/library/plan?tab=files&view=Five_Year_Plan.pdf#page=1')
    expect(pdf[1].href).toBe('/library/plan?tab=files&view=Five_Year_Plan.pdf#page=2')
    // The chunk still belongs to its entry, so it counts as a document read.
    expect(pdf[0].kind).toBe('document')
    expect(pdf[0].title).toBe('Strategic plan')
  })

  it('labels a format with no pages by its file name and links without a page anchor', () => {
    const docx = pageChunks().filter(c => c.href.includes('Fact_Manual.docx'))
    expect(docx).toHaveLength(1)
    expect(docx[0].heading).toBe('Fact_Manual.docx')
    expect(docx[0].href).toBe('/library/plan?tab=files&view=Fact_Manual.docx')
    expect(docx[0].text).toContain('Heirs property is defined here')
  })

  it('keeps the entry\'s own catalog chunk alongside the pages', () => {
    const sources = index.chunks.filter(c => c.slug === 'plan').map(c => c.source)
    expect(sources.filter(s => s === 'entry')).toHaveLength(1)
    expect(sources.filter(s => s === 'document')).toHaveLength(3)
  })

  it('finds a document page by its words, and the page wins over the filing', () => {
    const top = scoreChunks(index, 'which cohort counties are in Mississippi?')[0]
    expect(top.chunk.source).toBe('document')
    expect(top.chunk.heading).toBe('p. 2')
  })

  it('counts a cited document page as a document read', () => {
    const selection = selectContext(index, 'acquisition budget for the land trust')
    expect(selection.chunks.some(c => c.source === 'document')).toBe(true)
    expect(selection.counts.documents).toBeGreaterThan(0)
  })

  it('never extracts during an index build — it reads only what the sweep stored', async () => {
    const { deleteFile } = await import('./libraryBucket.js')
    await deleteFile(derivedKey('plan', 'Five_Year_Plan.pdf'))
    clearKbIndex()
    fake.calls.length = 0

    const rebuilt = await buildKbIndex()
    expect(fake.calls.some(c => c.startsWith('PutObjectCommand:library/derived/'))).toBe(false)
    // The file simply has no pages until the sweep catches up again.
    expect(rebuilt.chunks.some(c => c.href.includes('Five_Year_Plan.pdf'))).toBe(false)
    expect(rebuilt.chunks.some(c => c.href.includes('Fact_Manual.docx'))).toBe(true)
  })

  it('has no page chunks for a document whose text could not be read', () => {
    // old-comparison holds "%PDF-secret-bytes"; it is archived AND unreadable.
    expect(index.chunks.some(c => c.slug === 'old-comparison')).toBe(false)
  })
})

describe('data sources (P5-56)', () => {
  it('indexes a source entry with its provider, topics, field names, access and place query, and counts it as a source', async () => {
    fake.seed(
      'library/sources/fema-nfhl/meta.json',
      JSON.stringify({
        title: 'FEMA flood zones',
        status: 'published',
        tags: ['flood'],
        description: 'Digital flood insurance rate maps.',
        source: {
          provider: 'FEMA',
          program: 'NFHL',
          geography: 'parcel',
          coverage: 'national',
          topics: ['flooding'],
          fields: [{ name: 'FLD_ZONE', description: 'Flood zone code' }],
          access: [{ type: 'arcgis', url: 'https://hazards.fema.gov/x/FeatureServer/28', auth: 'none' }],
          placeQuery: { by: ['point', 'county'] },
          relevance: 'A parcel in zone A cannot hold the campus buildings.',
          notes: 'No feature means no digital FIRM, not safe.',
          replication: { status: 'indexed' },
        },
      }),
    )
    await reindexCatalog()
    const index = await buildKbIndex()
    const chunk = index.chunks.find(c => c.slug === 'fema-nfhl' && c.source === 'entry')
    expect(chunk?.kind).toBe('source')
    for (const needle of ['Provider: FEMA — NFHL', 'parcel, national', 'Topics: flooding', 'FLD_ZONE (Flood zone code)', 'Access: arcgis (none)', 'by: point, county', 'cannot hold the campus', 'no digital FIRM', 'Held here: indexed', 'indexed, not copied']) {
      expect(chunk?.text).toContain(needle)
    }
    expect(index.counts.sources).toBe(1)
    // A question about what data exists for a place finds it.
    const scored = scoreChunks(index, 'what datasets tell me about flooding risk for a parcel?')
    expect(scored[0]?.chunk.slug).toBe('fema-nfhl')
  })

  /** P5-59: "by county" against a tract-keyed source returns the tracts inside
   *  the county. Saying so is the difference between a useful answer and a
   *  reader deciding the fetch is broken. */
  it('says what a county query returns when the rows are smaller than a county', async () => {
    fake.seed(
      'library/sources/cdc-wwi/meta.json',
      JSON.stringify({
        title: 'CDC Well Water Index',
        status: 'published',
        source: {
          provider: 'CDC/ATSDR',
          geography: 'tract',
          placeQuery: { by: ['county'], fipsField: 'ct_fips', fipsMatch: 'prefix' },
          access: [{ type: 'socrata', url: 'https://data.cdc.gov/resource/fxwg-3udm.json' }],
        },
      }),
    )
    await reindexCatalog()
    const index = await buildKbIndex()
    const chunk = index.chunks.find(c => c.slug === 'cdc-wwi' && c.source === 'entry')
    expect(chunk?.text).toContain('Query for a place by: county (tract rows within the county)')
  })
})

describe('suggested filings (P5-47)', () => {
  it("indexes a drop's proposed title and summary the moment they land, labelled as proposals", async () => {
    fake.seed(
      'library/incoming/fresh-drop/meta.json',
      JSON.stringify({
        title: 'example.org/report.pdf',
        category: '',
        status: 'needs-cataloging',
        tags: [],
        url: 'https://example.org/report.pdf',
        originalFilename: 'report.pdf',
        suggested: {
          title: 'Heirs property and land loss in the Black Belt',
          category: 'research',
          tags: ['heirs-property'],
          summary: 'A study of tangled titles across seven southern states, with county tables.',
          at: '2026-09-05T00:00:00.000Z',
          model: 'stub',
        },
      }),
    )
    await reindexCatalog()
    const index = await buildKbIndex()
    const chunk = index.entryBySlug.get('fresh-drop')
    expect(chunk?.text).toContain('Suggested title: Heirs property and land loss in the Black Belt')
    expect(chunk?.text).toContain('Suggested summary: A study of tangled titles')

    // The point of indexing it immediately: a link dropped this morning is
    // findable this morning, before anyone has filed it.
    const scored = scoreChunks(index, 'tangled titles heirs property')
    expect(scored[0]?.chunk.slug).toBe('fresh-drop')
  })

  it('says nothing when the assistant could not suggest anything', async () => {
    fake.seed(
      'library/incoming/quiet-drop/meta.json',
      JSON.stringify({ title: 'a drop', status: 'needs-cataloging', category: '', tags: [], suggested: { error: 'unavailable', at: '2026-09-05T00:00:00.000Z' } }),
    )
    await reindexCatalog()
    const index = await buildKbIndex()
    expect(index.entryBySlug.get('quiet-drop')?.text).not.toContain('Suggested')
  })
})

describe('hrefForEntry / layerIdForEntry', () => {
  it('sends each kind to its own route', () => {
    expect(hrefForEntry({ kind: 'wiki', slug: 'home', meta: {} })).toBe('/wiki/home')
    expect(hrefForEntry({ kind: 'view', slug: 'tn', meta: {} })).toBe('/views/tn')
    expect(hrefForEntry({ kind: 'dataset', slug: 'orgs', meta: {} })).toBe('/library/orgs')
  })

  it('only gives a layer id to a published entry with a valid block', () => {
    const block = { geometry: 'point', name: 'x', description: '', source: '', year: 2026, latKey: '_lat', lngKey: '_lng', labelKey: 'Organization' }
    expect(layerIdForEntry({ slug: 'a', status: 'published', meta: { layer: block } })).toBe('internal-a')
    expect(layerIdForEntry({ slug: 'a', status: 'needs-review', meta: { layer: block } })).toBeNull()
    expect(layerIdForEntry({ slug: 'a', status: 'published', meta: { layer: { geometry: 'nope' } } })).toBeNull()
    expect(layerIdForEntry({ slug: 'a', status: 'published', meta: {} })).toBeNull()
  })
})

describe('public map layers (P5-45)', () => {
  let index: KbIndexType
  beforeEach(async () => {
    index = await buildKbIndex()
  })

  it('adds one chunk per public layer, whatever the library happens to hold', () => {
    const layerChunks = index.chunks.filter(c => c.source === 'layer')
    expect(layerChunks).toHaveLength(PUBLIC_LAYERS.length)
    expect(new Set(layerChunks.map(c => c.slug)).size).toBe(PUBLIC_LAYERS.length)
    expect(index.counts.layers).toBe(PUBLIC_LAYERS.length)
  })

  it('says what a layer measures, which way is better, and who published it — with a link to its about page', () => {
    const chunk = index.chunks.find(c => c.slug === 'median_home_value')!
    expect(chunk.kind).toBe('layer')
    expect(chunk.href).toBe('/layers/median_home_value')
    expect(chunk.layerId).toBe('median_home_value')
    expect(chunk.title).toBe('Median Home Value')
    expect(chunk.text).toContain('Median value of owner-occupied homes')
    expect(chunk.text).toContain('lower is better')
    expect(chunk.text).toContain('Urban Institute - Diversity Data Kids (2022)')
  })

  it('is honest when a layer records no source', () => {
    const text = publicLayerChunkText({
      id: 'x_layer',
      name: 'X layer',
      category: 'housing',
      dataType: 'count',
      direction: 'higher_better',
      unit: 'homes',
      range: { min: 0, max: 10 },
      description: 'Counts homes.',
      source: '',
      sourceUrl: '',
      year: '',
    })
    expect(text).toContain('Source: not recorded')
  })

  it('is what a question about a layer retrieves, so the answer can name the source', () => {
    const top = scoreChunks(index, 'what does the median home value layer measure?')[0]
    expect(top.chunk.slug).toBe('median_home_value')
    expect(top.chunk.source).toBe('layer')
  })

  it('counts as data, not as a document, in the "what I read" line', () => {
    const selection = selectContext(index, 'median home value layer')
    expect(selection.chunks.some(c => c.source === 'layer')).toBe(true)
    expect(selection.counts.datasets).toBeGreaterThan(0)
    expect(selection.counts.documents).toBe(0)
  })
})

describe('scoreChunks', () => {
  let index: KbIndexType
  beforeEach(async () => {
    index = await buildKbIndex()
  })

  it('ranks the section that answers the question first', () => {
    const top = scoreChunks(index, 'what does the funding strategy say about year two?')[0]
    expect(top.chunk.slug).toBe('funding-strategy')
    expect(top.chunk.heading).toBe('Year two')
  })

  it('boosts a title match over a body mention', () => {
    const scored = scoreChunks(index, 'organizations')
    expect(scored[0].chunk.slug).toBe('organizations')
    expect(scored[0].score).toBeGreaterThan(0)
  })

  it('drops chunks that share no term with the question, and returns nothing for a question of stopwords', () => {
    expect(scoreChunks(index, 'photosynthesis chlorophyll')).toEqual([])
    expect(scoreChunks(index, 'what is the')).toEqual([])
  })
})

describe('selectContext', () => {
  let index: KbIndexType
  beforeEach(async () => {
    index = await buildKbIndex()
  })

  it('stays inside the character budget', () => {
    const selection = selectContext(index, 'year two georgia land trust organizations', { budget: 200 })
    expect(selection.chars).toBeLessThanOrEqual(Math.max(200, selection.chunks[0].text.length))
    expect(selection.chunks.length).toBeGreaterThan(0)
  })

  it('always returns at least the top chunk even when it alone exceeds the budget', () => {
    const selection = selectContext(index, 'year two', { budget: 1 })
    expect(selection.chunks).toHaveLength(1)
  })

  it('pins the hinted dataset schema into context even when its words do not match', () => {
    const selection = selectContext(index, 'year two stewardship', { dataset: 'organizations' })
    expect(selection.chunks[0].source).toBe('schema')
    expect(selection.chunks[0].slug).toBe('organizations')
  })

  it('ignores a dataset hint that names nothing in the catalog', () => {
    const selection = selectContext(index, 'year two stewardship', { dataset: 'not-a-thing' })
    expect(selection.chunks.every(c => c.slug !== 'not-a-thing')).toBe(true)
  })

  it('reserves context for data-source entries when the question asks what data exists (P5-56)', async () => {
    const mk = (slug: string, title: string, topics: string[], relevance: string) =>
      fake.seed(
        `library/sources/${slug}/meta.json`,
        JSON.stringify({ title, status: 'published', tags: ['environmental-risk'], source: { provider: 'US EPA', topics, geography: 'point', placeQuery: { by: ['point'] }, access: [{ type: 'arcgis', url: 'https://x/FeatureServer/0' }], relevance } }),
      )
    mk('npl', 'Superfund NPL sites', ['contamination'], 'A listed site near a parcel is a red flag.')
    mk('tri', 'Toxics Release Inventory', ['air', 'contamination'], 'Releases upwind matter for a campus.')
    // A page that merely LISTS the sources outscores any single entry.
    fake.seed('library/wiki/data-sources.md', '# Data sources\n\n## Environmental risk\n\n- Superfund NPL sites — contamination risk near a property\n- Toxics Release Inventory — environmental risk from releases\n- and many more environmental risk datasets for any property\n')
    await reindexCatalog()
    const fresh = await buildKbIndex()
    const withIntent = selectContext(fresh, 'what datasets tell me about environmental risk for a property?')
    const sourceSlugs = withIntent.chunks.filter(c => c.kind === 'source').map(c => c.slug)
    expect(sourceSlugs).toEqual(expect.arrayContaining(['npl', 'tri']))
    expect(withIntent.counts.sources).toBe(2)
    // Ordinary questions are not reshuffled.
    const plain = selectContext(fresh, 'year two stewardship evaluation')
    expect(plain.chunks[0].kind).not.toBe('source')
  })

  it('caps how much of one entry can fill the context', () => {
    const selection = selectContext(index, 'year two three funding strategy stewardship evaluation')
    expect(selection.chunks.filter(c => c.slug === 'funding-strategy').length).toBeLessThanOrEqual(3)
  })

  it('reports what it read so the page can say "reading 1 page and 1 dataset"', () => {
    const selection = selectContext(index, 'organizations georgia funding strategy')
    expect(selection.counts.pages + selection.counts.datasets).toBeGreaterThan(0)
  })

  it('returns nothing when the question matches nothing', () => {
    expect(selectContext(index, 'photosynthesis').chunks).toEqual([])
  })
})
