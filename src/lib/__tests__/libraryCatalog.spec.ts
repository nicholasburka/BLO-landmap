import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  // The catalog cache clears itself on logout, and a logout clears the CSRF
  // token — so the mock has to offer that too (P5-89).
  setInternalCsrfToken: vi.fn(),
  API_URL: 'http://api.test',
}))

import { internalFetch } from '../apiBase'
import {
  buildCatalogQuery,
  coverageChipsOf,
  coverageGroupOf,
  coverageKeysOf,
  coverageLabelOf,
  coverageOf,
  topicOf,
  purposeOf,
  topicLabelOf,
  purposeLabelOf,
  topicFacets,
  purposeFacets,
  formatBytes,
  type CatalogEntry,
  fetchCatalog,
  fetchCatalogEntry,
  requestReindex,
  uploadLibraryFile,
  fileCatalogEntry,
  createNoteEntry,
  libraryFileUrl,
  fetchCatalogPage,
  layerIdForEntry,
  createLinkEntry,
  linkOf,
  hostOf,
  readinessLine,
  looksLikeEndpointUrl,
  modelPassGap,
  UPLOAD_MAX_BYTES,
  canRegisterAsSource,
  droppedLinkCount,
  LINK_ROLE_LABELS,
  invalidateCatalogCache,
  refetchLink as refetchLinkEntry,
  inspectEntryLink,
  setIngestPlan,
  replicateEntryNow,
} from '../libraryCatalog'
import { clearInternalSession } from '@/composables/useAuth'
import { saveView } from '../views'
import { saveWikiPage } from '../wiki'
import { pullDocuments } from '../documentPull'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mockedFetch.mockReset()
  // The cache is module state: without this, one test's answer is the next
  // test's cache hit.
  invalidateCatalogCache()
})

/** One turn of the microtask queue — long enough for a background refresh. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('buildCatalogQuery', () => {
  it('returns empty string for no filters', () => {
    expect(buildCatalogQuery({})).toBe('')
  })

  it('drops empty and whitespace-only values', () => {
    expect(buildCatalogQuery({ q: '  ', category: '', kind: undefined })).toBe('')
  })

  it('combines filters and URL-encodes values', () => {
    expect(buildCatalogQuery({ q: 'heirs property', kind: 'dataset' })).toBe(
      '?q=heirs+property&kind=dataset',
    )
  })

  it('trims values before encoding', () => {
    expect(buildCatalogQuery({ tag: ' tennessee ' })).toBe('?tag=tennessee')
  })

  // P5-64: the list is held-first by default; a caller that means "recently
  // updated" has to say so, and the server refuses any other word.
  it('passes the sort through, and sends nothing when it is not set', () => {
    expect(buildCatalogQuery({ sort: 'recent' })).toBe('?sort=recent')
    expect(buildCatalogQuery({ kind: 'wiki', sort: 'held-first' })).toBe('?kind=wiki&sort=held-first')
    expect(buildCatalogQuery({ kind: 'wiki' })).toBe('?kind=wiki')
  })

  // P6-19: both spellings of "where does this apply" reach the server.
  it('sends the coverage filters', () => {
    expect(buildCatalogQuery({ coverage: 'national' })).toBe('?coverage=national')
    expect(buildCatalogQuery({ state: ' GA ' })).toBe('?state=GA')
    expect(buildCatalogQuery({ coverage: 'none', kind: 'dataset' })).toBe('?kind=dataset&coverage=none')
  })
})

/**
 * P6-19: the chips, the heading and the filter keys, all read off the one
 * `coverage` field the server puts on the row.
 */
describe('coverage on a row (P6-19)', () => {
  const row = (coverage?: CatalogEntry['coverage']) => ({ coverage })

  it('puts a nationwide row under National and under no single state', () => {
    const national = row({ scope: 'national', states: [], label: 'National' })
    expect(coverageChipsOf(national)).toEqual([{ id: 'national', label: 'National' }])
    expect(coverageGroupOf(national)).toEqual({ id: 'national', label: 'National' })
    expect(coverageKeysOf(national)).toEqual(['national'])
    expect(coverageLabelOf(national)).toBe('National')
  })

  it('puts a one-state row under that state’s own name, chip and heading alike', () => {
    const georgia = row({ scope: 'state', states: ['GA'], label: 'Georgia' })
    expect(coverageChipsOf(georgia)).toEqual([{ id: 'GA', label: 'Georgia' }])
    expect(coverageGroupOf(georgia)).toEqual({ id: 'GA', label: 'Georgia' })
    // The scope rides in the filter keys so a link in the server's grammar
    // works, without adding a chip beside the state it duplicates.
    expect(coverageKeysOf(georgia)).toEqual(['GA', 'state'])
  })

  it('puts a multi-state row under EVERY state’s chip, and under ONE heading', () => {
    const memphis = row({ scope: 'multi-state', states: ['GA', 'MS', 'TN'], label: 'Georgia, Mississippi and Tennessee' })
    expect(coverageChipsOf(memphis)).toEqual([
      { id: 'GA', label: 'Georgia' },
      { id: 'MS', label: 'Mississippi' },
      { id: 'TN', label: 'Tennessee' },
    ])
    // A heading has to total the list, so three chips become one heading.
    expect(coverageGroupOf(memphis)).toEqual({ id: 'multi-state', label: 'Several states' })
    expect(coverageKeysOf(memphis)).toEqual(['GA', 'MS', 'TN', 'multi-state'])
  })

  it('names a scope that names no state in that scope’s own words', () => {
    const local = row({ scope: 'local', states: [], label: 'Local area' })
    expect(coverageChipsOf(local)).toEqual([{ id: 'local', label: 'Local area' }])
    expect(coverageGroupOf(local)).toEqual({ id: 'local', label: 'Local area' })
  })

  it('reads a row nothing could place as the gap, and never as national', () => {
    expect(coverageOf({})).toBeNull()
    expect(coverageOf({ coverage: null })).toBeNull()
    expect(coverageLabelOf({})).toBe('')
    expect(coverageChipsOf({})).toEqual([{ id: '', label: 'No coverage' }])
    expect(coverageGroupOf({})).toEqual({ id: '', label: 'No coverage' })
    // An empty id is what `FilterChips` turns into `none` and pins last.
    expect(coverageKeysOf({})).toEqual([''])
  })

  it('falls back to the code when the state table has never heard of it', () => {
    const odd = row({ scope: 'state', states: ['ZZ'], label: 'ZZ' })
    expect(coverageChipsOf(odd)).toEqual([{ id: 'ZZ', label: 'ZZ' }])
  })
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1536, '1.5 KB'],
    [3.4 * 1024 * 1024, '3.4 MB'],
    [200 * 1024 * 1024, '200 MB'], // whole values drop the trailing .0
    [1.1 * 1024 ** 3, '1.1 GB'],
    [-1, '—'],
    [NaN, '—'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatBytes(input as number)).toBe(expected)
  })
})

describe('fetchCatalog', () => {
  it('requests the catalog with the built query and returns entries', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ entries: [{ slug: 'a' }] }))
    const entries = await fetchCatalog({ status: 'published' })
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/catalog?status=published')
    expect(entries).toEqual([{ slug: 'a' }])
  })

  it('throws on a non-OK response', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(fetchCatalog()).rejects.toThrow('503')
  })
})

describe('fetchCatalogEntry', () => {
  it('URL-encodes the slug and returns the entry', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ entry: { slug: 'tn-heirs' } }))
    const entry = await fetchCatalogEntry('tn-heirs')
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/catalog/tn-heirs')
    expect(entry).toEqual({ slug: 'tn-heirs' })
  })

  it('returns null on 404 instead of throwing', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    expect(await fetchCatalogEntry('nope')).toBeNull()
  })
})

describe('requestReindex', () => {
  it('POSTs and returns the indexed count', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ indexed: 4 }))
    expect(await requestReindex()).toBe(4)
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/reindex', { method: 'POST' })
  })

  it('throws on failure (e.g. CSRF 403)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'invalid csrf token' }, 403))
    await expect(requestReindex()).rejects.toThrow('403')
  })
})

describe('uploadLibraryFile', () => {
  it('POSTs multipart form data with metadata fields and the file', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'u1', key: 'library/incoming/u1/a.csv', size: 4, status: 'needs-review' }),
    )
    const file = new File(['a,b\n'], 'a.csv', { type: 'text/csv' })
    const result = await uploadLibraryFile(file, { title: 'Test', tags: ' tn, land ' })
    expect(result.status).toBe('needs-review')
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/upload')
    expect(init?.method).toBe('POST')
    const form = init?.body as FormData
    expect(form.get('title')).toBe('Test')
    expect(form.get('tags')).toBe('tn, land')
    expect(form.get('category')).toBeNull() // empty fields omitted
    expect(form.get('file')).toBeInstanceOf(File)
  })

  it('quick drop: no metadata fields at all', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'u2', key: 'k', size: 4, status: 'needs-cataloging' }),
    )
    const result = await uploadLibraryFile(new File(['x'], 'drop.bin'))
    expect(result.status).toBe('needs-cataloging')
    const form = mockedFetch.mock.calls[0][1]?.body as FormData
    expect([...form.keys()]).toEqual(['file'])
  })

  it('rejects an oversize file client-side without any network call', async () => {
    const big = new File([''], 'big.bin')
    Object.defineProperty(big, 'size', { value: UPLOAD_MAX_BYTES + 1 })
    await expect(uploadLibraryFile(big)).rejects.toThrow(/too large/)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('surfaces the server error message (e.g. 413)', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ error: 'File too large: the upload limit is 200 MB' }, 413),
    )
    await expect(uploadLibraryFile(new File(['x'], 'a.bin'))).rejects.toThrow('200 MB')
  })
})

describe('createNoteEntry', () => {
  it('POSTs JSON to /api/library/entries and returns the created entry', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ entry: { slug: 'water-rights', kind: 'note', status: 'open' } }),
    )
    const entry = await createNoteEntry({ title: 'Water rights', body: 'An idea.', tags: ['land'] })
    expect(entry.slug).toBe('water-rights')
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/entries')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      title: 'Water rights',
      body: 'An idea.',
      tags: ['land'],
    })
  })

  it('surfaces the server validation message', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'a body is required' }, 400))
    await expect(createNoteEntry({ title: 'x', body: '' })).rejects.toThrow('a body is required')
  })
})

describe('fileCatalogEntry', () => {
  it('PATCHes the entry and returns the updated row', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ entry: { slug: 'u1', status: 'needs-review', title: 'Filed' } }),
    )
    const entry = await fileCatalogEntry('u1', { title: 'Filed', tags: ['tn'] })
    expect(entry.title).toBe('Filed')
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/catalog/u1')
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ title: 'Filed', tags: ['tn'] })
  })

  it('surfaces the server error message on failure', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ error: 'only incoming entries can be filed here' }, 409),
    )
    await expect(fileCatalogEntry('tn-heirs', { title: 'x' })).rejects.toThrow('only incoming')
  })
})

describe('libraryFileUrl (P5-25)', () => {
  it('builds an encoded download URL on the API host', () => {
    expect(libraryFileUrl('organizations', 'organizations.csv')).toBe('http://api.test/api/library/file/organizations/organizations.csv')
    expect(libraryFileUrl('a b', 'notes (final).pdf')).toBe('http://api.test/api/library/file/a%20b/notes%20(final).pdf')
  })
})

describe('archived handling (P5-35)', () => {
  it('sends the organization and shape filters as URL keys (P6-1, P6-2)', () => {
    expect(buildCatalogQuery({ organization: 'usda-fs', shape: 'areas' })).toBe('?organization=usda-fs&shape=areas')
    // An unknown publisher's group heading IS its filter value, prose and all.
    expect(buildCatalogQuery({ organization: 'Shelby County Register of Deeds' })).toBe(
      '?organization=Shelby+County+Register+of+Deeds',
    )
    expect(buildCatalogQuery({ organization: '  ', shape: '' })).toBe('')
  })

  it('buildCatalogQuery adds archived=1 only when asked', () => {
    expect(buildCatalogQuery({ archived: true })).toBe('?archived=1')
    expect(buildCatalogQuery({ q: 'x', archived: false })).toBe('?q=x')
  })

  it('fetchCatalogPage returns entries + archivedCount (0 when absent)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ entries: [{ slug: 'a' }], archivedCount: 3 }))
    expect(await fetchCatalogPage({ category: 'research' })).toEqual({ entries: [{ slug: 'a' }], archivedCount: 3 })
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/catalog?category=research')
    mockedFetch.mockResolvedValueOnce(jsonResponse({ entries: [] }))
    expect((await fetchCatalogPage()).archivedCount).toBe(0)
  })
})

describe('layerIdForEntry (P5-36)', () => {
  it('returns internal-<slug> only for published entries with a layer block', () => {
    expect(layerIdForEntry({ slug: 'orgs', status: 'published', meta: { layer: { geometry: 'point' } } })).toBe('internal-orgs')
    expect(layerIdForEntry({ slug: 'orgs', status: 'in-cleaning', meta: { layer: { geometry: 'point' } } })).toBeNull()
    expect(layerIdForEntry({ slug: 'orgs', status: 'published', meta: {} })).toBeNull()
    expect(layerIdForEntry({ slug: 'orgs', status: 'published', meta: { layer: 'nope' } })).toBeNull()
  })
})

describe('link drops (P5-34)', () => {
  it('createLinkEntry posts JSON and returns the slug/status/title, surfacing server messages', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ slug: 'abc', status: 'needs-cataloging', title: 'example.org/data' }, 201))
    expect(await createLinkEntry({ url: 'https://example.org/data', note: 'n' })).toEqual({ slug: 'abc', status: 'needs-cataloging', title: 'example.org/data' })
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/links')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ url: 'https://example.org/data', note: 'n' })
    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: 'url must be an http(s) link' }, 400))
    await expect(createLinkEntry({ url: 'nope' })).rejects.toThrow('url must be an http(s) link')
  })

  it('linkOf / hostOf read a safe URL off the manifest', () => {
    expect(linkOf({ meta: { url: ' https://data.census.gov/table/x ' } })).toBe('https://data.census.gov/table/x')
    expect(linkOf({ meta: { url: 'javascript:alert(1)' } })).toBeNull()
    expect(linkOf({ meta: {} })).toBeNull()
    expect(hostOf('https://data.census.gov/table/x')).toBe('data.census.gov')
    expect(hostOf('nope')).toBe('nope')
  })
})

// --- P5-56: data sources ----------------------------------------------------

import {
  sourceOf,
  sourceBadge,
  accessTypeLabel,
  accessAuthLabel,
  coversLine,
  canFetchForPlace,
  replicationSummary,
  slicesOf,
  replicationDatasets,
  radiusLabel,
  askQuestionForSource,
  SOURCE_BADGE,
  type SourceMeta,
} from '../libraryCatalog'

const EPA: SourceMeta = {
  provider: 'US EPA',
  program: 'Superfund / CERCLIS',
  geography: 'point',
  coverage: 'national',
  granularity: ['point', 'county'],
  topics: ['contamination'],
  access: [
    { type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0', auth: 'none' },
    { type: 'download', url: 'https://epa.gov/npl.csv', format: 'csv' },
  ],
}

describe('sourceOf / sourceBadge (P5-56)', () => {
  it('reads a block with a provider and ignores everything else', () => {
    expect(sourceOf({ meta: { source: EPA } })).toEqual(EPA)
    // Datasets carry provenance prose in `source` — that is not a block.
    expect(sourceOf({ meta: { source: 'DC Open Data, 2024' } })).toBeNull()
    expect(sourceOf({ meta: { source: { geography: 'county' } } })).toBeNull()
    expect(sourceOf({ meta: { source: [{ provider: 'X' }] } })).toBeNull()
    expect(sourceOf({ meta: {} })).toBeNull()
  })

  it('badges only source entries, and says "Source" without asking kindLabel', () => {
    expect(sourceBadge({ kind: 'source' })).toBe(SOURCE_BADGE)
    expect(SOURCE_BADGE).toBe('Source')
    expect(sourceBadge({ kind: 'dataset' })).toBeNull()
    expect(sourceBadge({ kind: 'incoming' })).toBeNull()
  })
})

describe('source presentation helpers (P5-56)', () => {
  it('names each access type in plain language and falls back to the raw value', () => {
    expect(accessTypeLabel('arcgis')).toBe('ArcGIS')
    expect(accessTypeLabel('socrata')).toBe('Socrata')
    expect(accessTypeLabel('rest')).toBe('REST API')
    expect(accessTypeLabel('download')).toBe('Download')
    expect(accessTypeLabel('wfs')).toBe('WFS')
    expect(accessTypeLabel('manual')).toBe('Manual')
    expect(accessTypeLabel('sftp')).toBe('sftp')
  })

  it('turns auth into "no key needed" / "key needed", or nothing when unsaid', () => {
    expect(accessAuthLabel({ auth: 'none' })).toBe('no key needed')
    expect(accessAuthLabel({ auth: 'None' })).toBe('no key needed')
    expect(accessAuthLabel({ auth: 'api key' })).toBe('key needed')
    expect(accessAuthLabel({})).toBeNull()
    expect(accessAuthLabel({ auth: '  ' })).toBeNull()
  })

  it('builds the Covers line from whichever of geography/coverage/granularity are set', () => {
    expect(coversLine(EPA)).toBe('point · national · point, county')
    expect(coversLine({ provider: 'X', coverage: 'Tennessee' })).toBe('Tennessee')
    expect(coversLine({ provider: 'X' })).toBe('')
  })

  it('offers "Fetch for a place" only when P5-57 will have an adapter', () => {
    expect(canFetchForPlace(EPA)).toBe(true)
    expect(canFetchForPlace({ provider: 'X', access: [{ type: 'socrata' }] })).toBe(true)
    expect(canFetchForPlace({ provider: 'X', access: [{ type: 'rest' }] })).toBe(true)
    // Nothing to automate: a WFS endpoint or a phone call to the county.
    expect(canFetchForPlace({ provider: 'X', access: [{ type: 'manual' }, { type: 'wfs' }] })).toBe(false)
    expect(canFetchForPlace({ provider: 'X' })).toBe(false)
    expect(canFetchForPlace(null)).toBe(false)
  })

  it('reads the place slices P5-57 records, and leaves the old plain slugs alone', () => {
    const partial = {
      provider: 'EPA',
      replication: {
        status: 'partial' as const,
        slices: [
          { cacheKey: 'g13121', place: 'Fulton County, GA', count: 3, fetchedAt: '2026-09-06T00:00:00.000Z', adapter: 'arcgis' as const },
          { cacheKey: 'p33.7490_-84.3880_r5', place: '33.7490, -84.3880', count: 1, dataset: 'npl-near-the-farm' },
          'npl-shelby-2026',
        ],
      },
    }
    expect(slicesOf(partial).map(s => s.cacheKey)).toEqual(['g13121', 'p33.7490_-84.3880_r5'])
    // A bare string is a dataset, not a place — and a promoted slice names one too.
    expect(replicationDatasets(partial)).toEqual(['npl-near-the-farm', 'npl-shelby-2026'])
    expect(slicesOf({ provider: 'X' })).toEqual([])
    expect(slicesOf(null)).toEqual([])
    expect(replicationDatasets(null)).toEqual([])
  })

  it('says a radius the way a person would', () => {
    expect(radiusLabel(5)).toBe('5 miles')
    expect(radiusLabel(1)).toBe('1 mile')
    expect(radiusLabel(0.25)).toBe('0.25 of a mile')
  })

  it('says what we actually hold', () => {
    expect(replicationSummary({ provider: 'X' })).toEqual({ text: 'Indexed — not copied here', datasetSlug: null })
    expect(replicationSummary({ provider: 'X', replication: { status: 'indexed' } }).text).toBe('Indexed — not copied here')
    expect(replicationSummary({ provider: 'X', replication: { status: 'partial', slices: ['a', 'b'] } })).toEqual({
      text: 'Partly copied: 2 slices',
      datasetSlug: null,
    })
    expect(replicationSummary({ provider: 'X', replication: { status: 'partial', slices: ['a'] } }).text).toBe('Partly copied: 1 slice')
    expect(replicationSummary({ provider: 'X', replication: { status: 'replicated', dataset: 'npl-sites' } })).toEqual({
      text: 'Copied as',
      datasetSlug: 'npl-sites',
    })
  })

  it('prefills the Ask box with the question a source is for', () => {
    expect(askQuestionForSource('EPA Superfund NPL sites')).toBe(
      'What does EPA Superfund NPL sites cover and how do I query it for a place?',
    )
  })
})

import { emptySourceForm, sourceFormFrom, sourceFromForm } from '../libraryCatalog'

describe('the "This is a data source" form (P5-56)', () => {
  it('needs only a provider, and sends nothing it was not given', () => {
    const form = { ...emptySourceForm(), provider: '  US EPA  ' }
    expect(sourceFromForm(form)).toEqual({ provider: 'US EPA' })
    expect(sourceFromForm(emptySourceForm())).toBeNull()
    expect(sourceFromForm({ ...emptySourceForm(), coverage: 'national' })).toBeNull()
  })

  it('builds the block a teammate can fill in without knowing the schema', () => {
    expect(
      sourceFromForm({
        provider: 'US EPA',
        program: 'Superfund',
        geography: 'point',
        coverage: 'national',
        topics: 'contamination, hazardous waste, ',
        accessType: 'arcgis',
        accessUrl: 'https://services.arcgis.com/x/FeatureServer/0',
        license: 'public domain',
        notes: 'A red flag near a candidate parcel.',
      }),
    ).toEqual({
      provider: 'US EPA',
      program: 'Superfund',
      geography: 'point',
      coverage: 'national',
      topics: ['contamination', 'hazardous waste'],
      access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/FeatureServer/0' }],
      license: 'public domain',
      relevance: 'A red flag near a candidate parcel.',
    })
  })

  it('keeps an access method with no URL (a manual one still counts)', () => {
    expect(sourceFromForm({ ...emptySourceForm(), provider: 'Shelby County', accessType: 'manual' })).toEqual({
      provider: 'Shelby County',
      access: [{ type: 'manual' }],
    })
    // A URL with no type is not an access method — it is the dropped link.
    expect(sourceFromForm({ ...emptySourceForm(), provider: 'X', accessUrl: 'https://x.org/a' })).toEqual({ provider: 'X' })
  })

  it('round-trips a block back into the form for editing', () => {
    expect(sourceFormFrom(EPA)).toEqual({
      provider: 'US EPA',
      program: 'Superfund / CERCLIS',
      geography: 'point',
      coverage: 'national',
      topics: 'contamination',
      accessType: 'arcgis',
      accessUrl: 'https://services.arcgis.com/x/FeatureServer/0',
      license: '',
      notes: '',
    })
    expect(sourceFormFrom(null)).toEqual(emptySourceForm())
  })
})

// --- P5-47: fetch on drop + suggested filing --------------------------------

import { fetchStateOf, isFetchPending, fetchChip, suggestionOf, hasSuggestion, refetchLink } from '../libraryCatalog'

describe('fetch state (P5-47)', () => {
  it('reads a fetch block off the manifest and ignores anything that is not one', () => {
    expect(fetchStateOf({ meta: { fetch: { status: 'fetched', at: 'T', bytes: 12, name: 'x.csv' } } })).toMatchObject({ status: 'fetched', name: 'x.csv' })
    expect(fetchStateOf({ meta: { fetch: { status: 'made-up', at: 'T' } } })).toBeNull()
    expect(fetchStateOf({ meta: { fetch: 'yes' } })).toBeNull()
    expect(fetchStateOf({ meta: {} })).toBeNull()
  })

  it('knows when the server is still on its way', () => {
    expect(isFetchPending({ meta: { fetch: { status: 'queued', at: 'T' } } })).toBe(true)
    expect(isFetchPending({ meta: { fetch: { status: 'fetching', at: 'T' } } })).toBe(true)
    for (const status of ['fetched', 'failed', 'later']) {
      expect(isFetchPending({ meta: { fetch: { status, at: 'T' } } }), status).toBe(false)
    }
    expect(isFetchPending({ meta: {} })).toBe(false)
  })

  it('chips a card only while there is something to say', () => {
    expect(fetchChip({ meta: { fetch: { status: 'queued', at: 'T' } } })).toBe('Fetching…')
    expect(fetchChip({ meta: { fetch: { status: 'fetching', at: 'T' } } })).toBe('Fetching…')
    expect(fetchChip({ meta: { fetch: { status: 'fetched', at: 'T' } } })).toBe('Fetched')
    expect(fetchChip({ meta: { fetch: { status: 'failed', at: 'T' } } })).toBe('Fetch failed')
    expect(fetchChip({ meta: { fetch: { status: 'later', at: 'T' } } })).toBeNull()
    expect(fetchChip({ meta: {} })).toBeNull()
  })

  it('refetchLink posts to the entry and hands back the new status', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ fetch: 'queued' }))
    expect(await refetchLink('a b')).toBe('queued')
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/catalog/a%20b/refetch')
    expect(init?.method).toBe('POST')
    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: 'This entry has no link to fetch.' }, 400))
    await expect(refetchLink('x')).rejects.toThrow('This entry has no link to fetch.')
  })
})

describe('suggested filing (P5-47)', () => {
  const suggestion = { title: 'Heirs property', category: 'research', tags: ['land-loss'], summary: 'A study.', at: 'T', model: 'stub' }

  it('reads a proposal off the manifest', () => {
    expect(suggestionOf({ meta: { suggested: suggestion } })).toEqual(suggestion)
    expect(suggestionOf({ meta: { suggested: 'nope' } })).toBeNull()
    expect(suggestionOf({ meta: {} })).toBeNull()
  })

  it('only counts a proposal that actually proposes something', () => {
    expect(hasSuggestion({ meta: { suggested: suggestion } })).toBe(true)
    expect(hasSuggestion({ meta: { suggested: { summary: 'Just a summary.' } } })).toBe(true)
    expect(hasSuggestion({ meta: { suggested: { error: 'unavailable', at: 'T' } } })).toBe(false)
    expect(hasSuggestion({ meta: { suggested: { at: 'T', model: 'stub' } } })).toBe(false)
    expect(hasSuggestion({ meta: {} })).toBe(false)
  })
})

describe('readiness (P5-82)', () => {
  it('writes the line the entry page shows, notes and all', () => {
    expect(readinessLine({ as: 'collection', placeReport: 'never', notes: ['served over http'] })).toBe(
      'Ready as: a document collection · Place report: never · served over http',
    )
    expect(readinessLine({ as: 'source', placeReport: 'runs', notes: [] })).toBe('Ready as: a data source · Place report: runs')
    expect(readinessLine({ as: 'link', placeReport: 'candidate', notes: ['not read yet'] })).toBe(
      'Ready as: a link · Place report: could run if registered as a source · not read yet',
    )
  })

  it('knows an endpoint-shaped URL from a plain page', () => {
    expect(looksLikeEndpointUrl('https://services1.arcgis.com/x/arcgis/rest/services/NPL/FeatureServer/0')).toBe(true)
    expect(looksLikeEndpointUrl('https://gis.example.gov/arcgis/rest/services/Parcels/MapServer')).toBe(true)
    expect(looksLikeEndpointUrl('https://data.example.gov/resource/abcd-1234.json')).toBe(true)
    expect(looksLikeEndpointUrl('https://data.example.gov/d/abcd-1234')).toBe(true)
    expect(looksLikeEndpointUrl('https://example.gov/downloads/parcels.csv')).toBe(true)
    expect(looksLikeEndpointUrl('http://www.engaginglandowners.org/')).toBe(false)
    expect(looksLikeEndpointUrl('https://example.gov/data/about-this-programme')).toBe(false)
    expect(looksLikeEndpointUrl('not a url')).toBe(false)
  })
})

describe('read, but not summarised (P5-83)', () => {
  it('spots a failed pass and a read with nothing to show, and keeps quiet otherwise', () => {
    expect(modelPassGap({ meta: { suggested: { error: 'unavailable', at: 'T', reason: 'refused' } } })).toEqual({
      readAt: 'T',
      reason: 'refused',
    })
    // Read by the fetcher, no suggestion ever written.
    expect(modelPassGap({ meta: { fetch: { status: 'fetched', at: 'F' } } })).toEqual({ readAt: 'F' })
    // The inspection's own time wins — it is when the page was read.
    expect(
      modelPassGap({ meta: { fetch: { status: 'fetched', at: 'F' }, inspection: { kind: 'page', checkedAt: 'I' } } }),
    ).toEqual({ readAt: 'I' })
    // A pass that produced something, and a link nobody has read yet.
    expect(modelPassGap({ meta: { suggested: { summary: 'A study.' } } })).toBeNull()
    expect(modelPassGap({ meta: { fetch: { status: 'queued', at: 'F' } } })).toBeNull()
    expect(modelPassGap({ meta: {} })).toBeNull()
  })
})

/**
 * P5-61: the two rules the panel reads off an inspection.
 *
 * Both are about honesty rather than display: what counts as "worth
 * registering", and how many links the page had that we chose not to keep.
 */
describe('reading a pruned inspection (P5-61)', () => {
  const page = (over: Record<string, unknown> = {}) =>
    ({ kind: 'page', confidence: 'medium', url: 'https://x', checkedAt: 'T', ...over }) as never

  it('offers a source for a service, a file, or a page that describes one', () => {
    expect(canRegisterAsSource(page({ kind: 'arcgis-layer' }))).toBe(true)
    expect(canRegisterAsSource(page({ kind: 'socrata' }))).toBe(true)
    expect(canRegisterAsSource(page({ kind: 'file' }))).toBe(true)
    expect(canRegisterAsSource(page({ prose: { isDataset: true }, links: [{ url: 'https://x/a.csv' }] }))).toBe(true)
    // An access route the page described counts too, even with no link.
    expect(
      canRegisterAsSource(page({ prose: { isDataset: true, accessNotes: [{ kind: 'request', text: 'Email us.' }] } })),
    ).toBe(true)
  })

  it('does not offer one for an article, or for confidence with nothing behind it', () => {
    expect(canRegisterAsSource(page())).toBe(false)
    expect(canRegisterAsSource(page({ prose: { isDataset: true } }))).toBe(false)
    expect(canRegisterAsSource(page({ prose: { isDataset: false }, links: [{ url: 'https://x/a.csv' }] }))).toBe(false)
    expect(canRegisterAsSource(page({ kind: 'unreachable' }))).toBe(false)
    expect(canRegisterAsSource(null)).toBe(false)
  })

  it('a portal listing downloads is still registerable without a prose read', () => {
    expect(canRegisterAsSource(page({ kind: 'portal', links: [{ url: 'https://x/a.csv' }] }))).toBe(true)
    expect(canRegisterAsSource(page({ kind: 'portal' }))).toBe(false)
  })

  it('counts the links left out, and nothing when the count is missing', () => {
    expect(droppedLinkCount(page({ candidates: 46, links: [{ url: 'a' }, { url: 'b' }] }))).toBe(2 + 42)
    expect(droppedLinkCount(page({ candidates: 2, links: [{ url: 'a' }, { url: 'b' }] }))).toBe(0)
    // A portal's typed list carries no count: nothing was thrown away.
    expect(droppedLinkCount(page({ links: [{ url: 'a' }] }))).toBe(0)
    expect(droppedLinkCount(null)).toBe(0)
  })

  it('names every role in words a researcher would use', () => {
    // `directory` was added after the live check: on the Census TIGER page the
    // only route to the shapefiles is an FTP archive, and "page" buried it.
    // `viewer` came out of P5-62's eval: the same page's "Web Interface" is a
    // FORM, and calling it an API points an adapter at something that answers
    // with HTML. Every role has to say what a person would do with the link.
    expect(Object.values(LINK_ROLE_LABELS)).toEqual([
      'file',
      'folder of files',
      'API',
      'map layer',
      'query form / viewer',
      'docs',
      'page',
    ])
  })
})

/**
 * P5-63 — one taxonomy, read the same way on both sides. Nothing here is
 * stored on a row: an entry's topic is its category when that is a topic,
 * otherwise the first of its tags that is one, and the server answers
 * `?topic=` by exactly the same rule.
 */
describe('topic and purpose (P5-63)', () => {
  const row = (category: string, tags: string[] = [], kind = 'document') =>
    ({ slug: 's', kind, title: 'T', category, status: 'published', tags, meta: {}, files: [], bytes: 0 }) as CatalogEntry

  it('reads the topic off the category, then the tags, through the aliases', () => {
    expect(topicOf(row('water'))).toBe('water')
    expect(topicOf(row('demographics'))).toBe('demographic')
    expect(topicOf(row('research', ['history', 'land']))).toBe('land')
    // 'environmental-risk' is a cross-cutting screening tag, not a topic alias.
    expect(topicOf(row('outreach', ['environmental-risk']))).toBeNull()
    expect(topicOf(row('outreach', ['environmental']))).toBe('environment')
    expect(topicOf(row('strategy', ['funding']))).toBeNull()
  })

  it('reads the purpose off the same field, and labels both in plain words', () => {
    expect(purposeOf(row('research'))).toBe('research')
    expect(purposeOf(row('land'))).toBeNull()
    expect(topicLabelOf(row('transportation'))).toBe('Getting to work')
    expect(purposeLabelOf(row('ideas'))).toBe('Ideas')
    // A word the taxonomy has never heard of gets no label — the card falls
    // back to showing the raw category, which is a thing to fix.
    expect(topicLabelOf(row('kitchen-sink'))).toBe('')
  })

  it('counts a facet per topic in use, in taxonomy order, and leaves empty ones out', () => {
    expect(
      topicFacets([row('water'), row('research', ['land']), row('water'), row('strategy', ['funding'])]),
    ).toEqual([
      { id: 'land', label: 'Land', count: 1 },
      { id: 'water', label: 'Water', count: 2 },
    ])
    expect(purposeFacets([row('research', ['land']), row('strategy'), row('water')])).toEqual([
      { id: 'strategy', label: 'Strategy', count: 1 },
      { id: 'research', label: 'Research', count: 1 },
    ])
  })

  it('sends topic, purpose and tag on the query, keeping category as the old key', () => {
    expect(buildCatalogQuery({ topic: 'water', purpose: 'research', tag: 'wells' })).toBe(
      '?topic=water&purpose=research&tag=wells',
    )
    expect(buildCatalogQuery({ category: 'kitchen-sink' })).toBe('?category=kitchen-sink')
  })
})

// --- The client-side catalog cache (P5-89) ----------------------------------

describe('the catalog cache (P5-89)', () => {
  const row = (slug: string): CatalogEntry => ({
    slug,
    kind: 'dataset',
    title: slug,
    category: 'land',
    status: 'published',
    tags: [],
    meta: {},
    files: [],
    bytes: 0,
  })
  const listOf = (...slugs: string[]) => jsonResponse({ entries: slugs.map(row), archivedCount: 0 })

  it('answers concurrent asks for the same query with one request', async () => {
    mockedFetch.mockImplementation(async () => listOf('a'))
    const [first, second] = await Promise.all([fetchCatalog({ archived: true }), fetchCatalog({ archived: true })])
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(first.map(e => e.slug)).toEqual(['a'])
    expect(second).toEqual(first)
  })

  it('still asks separately for a different query', async () => {
    mockedFetch.mockImplementation(async () => listOf('a'))
    await Promise.all([fetchCatalog(), fetchCatalog({ kind: 'view' })])
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })

  it('answers a repeat ask from memory and delivers the refreshed rows after', async () => {
    mockedFetch.mockResolvedValueOnce(listOf('old'))
    expect((await fetchCatalog()).map(e => e.slug)).toEqual(['old'])

    mockedFetch.mockResolvedValueOnce(listOf('new'))
    const delivered: string[][] = []
    const again = await fetchCatalog({}, fresh => delivered.push(fresh.map(e => e.slug)))
    // Stale, immediately…
    expect(again.map(e => e.slug)).toEqual(['old'])
    await settle()
    // …then the server's answer.
    expect(delivered).toEqual([['new']])
    expect(mockedFetch).toHaveBeenCalledTimes(2)

    // And the refreshed rows are what the next ask is answered with.
    mockedFetch.mockResolvedValueOnce(listOf('newer'))
    expect((await fetchCatalog()).map(e => e.slug)).toEqual(['new'])
  })

  it('keeps the last answer when a background refresh fails', async () => {
    mockedFetch.mockResolvedValueOnce(listOf('held'))
    await fetchCatalog()
    mockedFetch.mockRejectedValueOnce(new Error('offline'))
    const delivered: unknown[] = []
    expect((await fetchCatalog({}, fresh => delivered.push(fresh))).map(e => e.slug)).toEqual(['held'])
    await settle()
    expect(delivered).toEqual([])
    mockedFetch.mockResolvedValueOnce(listOf('held'))
    expect((await fetchCatalog()).map(e => e.slug)).toEqual(['held'])
  })

  it('caches single entries by slug too', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse({ entry: row('one') }))
    await Promise.all([fetchCatalogEntry('one'), fetchCatalogEntry('one')])
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    await fetchCatalogEntry('two')
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })

  /** Every write the app can make, and how to make it against the mock. */
  const writes: Array<[string, () => Promise<unknown>]> = [
    ['an upload', () => uploadLibraryFile(new File(['a,b'], 'rows.csv'))],
    ['a note', () => createNoteEntry({ title: 'An idea', body: 'about land' })],
    ['a filing', () => fileCatalogEntry('one', { category: 'land' })],
    ['a reindex', () => requestReindex()],
    ['a link drop', () => createLinkEntry({ url: 'https://example.test/a' })],
    ['a refetch', () => refetchLinkEntry('one')],
    ['an inspection', () => inspectEntryLink('one')],
    ['an ingest plan', () => setIngestPlan('one', { plan: 'replicate' })],
    ['a replication', () => replicateEntryNow('one')],
    ['a saved view', () => saveView({ name: 'South', state: { layers: [] } as never })],
    ['a wiki save', () => saveWikiPage('georgia', '# Georgia')],
    ['documents pulled in', () => pullDocuments('one', ['https://example.test/a.pdf'])],
  ]

  it.each(writes)('drops what it knows after %s', async (_what, write) => {
    mockedFetch.mockImplementation(async () => listOf('before'))
    await fetchCatalog({ archived: true })
    await fetchCatalogEntry('one')
    expect(mockedFetch).toHaveBeenCalledTimes(2)

    mockedFetch.mockImplementation(async () => jsonResponse({ entry: row('one'), indexed: 1, results: [], slug: 's', name: 'n', fetch: 'queued' }))
    await write()
    const afterWrite = mockedFetch.mock.calls.length

    // Nothing is served from memory now: both reads go back to the server.
    mockedFetch.mockImplementation(async () => listOf('after'))
    expect((await fetchCatalog({ archived: true })).map(e => e.slug)).toEqual(['after'])
    await fetchCatalogEntry('one')
    expect(mockedFetch).toHaveBeenCalledTimes(afterWrite + 2)
  })

  it('does not let a request that started before a write land in the cache', async () => {
    let answer: (res: Response) => void = () => {}
    mockedFetch.mockReturnValueOnce(new Promise<Response>(resolve => { answer = resolve }))
    const inFlight = fetchCatalog({ archived: true })

    invalidateCatalogCache()
    answer(listOf('stale'))
    expect((await inFlight).map(e => e.slug)).toEqual(['stale'])
    await settle()

    // The asker got its answer, but the cache kept none of it.
    mockedFetch.mockResolvedValueOnce(listOf('fresh'))
    expect((await fetchCatalog({ archived: true })).map(e => e.slug)).toEqual(['fresh'])
  })

  it('forgets everything on logout', async () => {
    mockedFetch.mockImplementation(async () => listOf('internal-only'))
    await fetchCatalog({ archived: true })
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    clearInternalSession()

    await fetchCatalog({ archived: true })
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })
})

describe('the catalog cache stays bounded (P5-89)', () => {
  it('drops the least recently used query, never the one every page shares', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse({ entries: [], archivedCount: 0 }))
    await fetchCatalog({ archived: true })
    // Enough distinct searches to push past the cap, with the shared catalog
    // touched along the way as every page touches it.
    for (let i = 0; i < 40; i++) {
      await fetchCatalogPage({ q: `search ${i}` })
      await fetchCatalog({ archived: true })
    }
    await settle()
    const before = mockedFetch.mock.calls.length

    // The shared catalog is still in memory: one refresh, no more.
    await fetchCatalog({ archived: true })
    expect(mockedFetch).toHaveBeenCalledTimes(before + 1)
    await settle()

    // The oldest search fell out, so asking again is a real request…
    await fetchCatalogPage({ q: 'search 0' })
    expect(mockedFetch).toHaveBeenCalledTimes(before + 2)
    await settle()

    // …while the newest is still there, and still just a refresh.
    await fetchCatalogPage({ q: 'search 39' })
    expect(mockedFetch).toHaveBeenCalledTimes(before + 3)
  })
})

/**
 * P6-1 / P6-2 — the two words a row CARRIES, as opposed to the topic, which is
 * derived from words it already had. The server works both out at reindex (a
 * held table's shape needs its columns read, and a publisher is folded out of
 * prose the list projection does not carry), so these helpers read the row
 * rather than recomputing anything.
 */
import { organizationOf, organizationLabelOf, shapeOf, shapeLabelOf, SHAPE_CHOICES } from '../libraryCatalog'

describe('organization and shape on a row (P6-1, P6-2)', () => {
  const row = (over: Partial<CatalogEntry>) =>
    ({ slug: 's', kind: 'dataset', title: 'T', category: '', status: 'published', tags: [], meta: {}, files: [], bytes: 0, ...over }) as CatalogEntry

  it('reads both off the row, with the plain words the server sent', () => {
    const entry = row({ organization: 'usda-fs', organizationLabel: 'USDA · Forest Service', shape: 'areas', shapeLabel: 'Areas and boundaries' })
    expect(organizationOf(entry)).toBe('usda-fs')
    expect(organizationLabelOf(entry)).toBe('USDA · Forest Service')
    expect(shapeOf(entry)).toBe('areas')
    expect(shapeLabelOf(entry)).toBe('Areas and boundaries')
  })

  it('labels from the vocabulary when the row carried only the id', () => {
    expect(organizationLabelOf(row({ organization: 'epa' }))).toBe('US EPA')
    expect(shapeLabelOf(row({ shape: 'points' }))).toBe('Sites and points')
  })

  it('shows an unknown publisher as it was written, never as a blank', () => {
    const entry = row({ organization: 'Shelby County Register of Deeds' })
    expect(organizationLabelOf(entry)).toBe('Shelby County Register of Deeds')
  })

  it('says nothing for a row that carries neither — a page has no publisher', () => {
    const page = row({ kind: 'wiki' })
    expect(organizationOf(page)).toBe('')
    expect(organizationLabelOf(page)).toBe('')
    expect(shapeOf(page)).toBe('')
    expect(shapeLabelOf(page)).toBe('')
  })

  it('offers the five shapes in reading order, for a filter row', () => {
    expect(SHAPE_CHOICES).toEqual([
      { id: 'areas', label: 'Areas and boundaries' },
      { id: 'points', label: 'Sites and points' },
      { id: 'statistics', label: 'Statistics by county or tract' },
      { id: 'lines', label: 'Lines and networks' },
      { id: 'records', label: 'Records without a location' },
    ])
  })
})

describe('the suggested title (P6-8)', () => {
  it('comes straight off a list row, where the server already worked it out', async () => {
    const { suggestedTitleOf } = await import('../libraryCatalog')
    expect(suggestedTitleOf({ title: 'scan.pdf', meta: { suggestedTitle: 'Heirs property survey' } })).toBe(
      'Heirs property survey',
    )
    // The server sends the key only while it stands, so an empty one means
    // "nothing outstanding" and must not fall through to the full manifest.
    expect(suggestedTitleOf({ title: 'scan.pdf', meta: { suggestedTitle: '', suggested: { title: 'x' } } })).toBeNull()
  })

  it('is worked out from a full entry, against the one meaning of "accepted"', async () => {
    const { suggestedTitleOf } = await import('../libraryCatalog')
    const suggested = { title: 'Heirs property survey', at: 'now', model: 'm' }
    expect(suggestedTitleOf({ title: 'scan.pdf', meta: { suggested } })).toBe('Heirs property survey')
    expect(suggestedTitleOf({ title: 'Heirs property survey', meta: { suggested } })).toBeNull()
    expect(suggestedTitleOf({ title: 'scan.pdf', meta: { suggested: { error: 'unavailable' } } })).toBeNull()
    expect(suggestedTitleOf({ title: 'scan.pdf', meta: {} })).toBeNull()
  })
})
