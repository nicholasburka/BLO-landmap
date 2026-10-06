import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * Working sets (P7-1).
 *
 * The real catalog, the real bucket and the real report service; only the
 * per-source fetch, the county reader and the model are injected. That keeps
 * the thing this file is judged on real — **a place report run inside a
 * working set asks that set's sources and no others**, which is the entire
 * reason the object exists.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog, getCatalogEntry, searchCatalog, createSavedView, getSavedView, setViewWorkingSet } =
  await import('./libraryCatalog.js')
const {
  createWorkingSet,
  getWorkingSet,
  listWorkingSets,
  updateWorkingSet,
  workingSetMemberSlugs,
  workingSetMembers,
} = await import('./libraryWorkingSets.js')
const { describeWorkingSet, readWorkingSet, workingSetKey, workingSetManifest, WORKING_SET_KIND } =
  await import('./workingSetMeta.js')
const { clearCountyIndex, runPlaceReport, PlaceScopeError } = await import('./placeReport.js')
const { placeReportIndexSettled } = await import('./placeReportIndex.js')
const { ATLANTA } = await import('../testutils/fixtures/place/index.js')

type FetchResult = import('./placeFetch.js').FetchForPlaceResult
type SlicePlace = import('./placeFetch.js').SlicePlace

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

// --- A library with four sources and one held table --------------------------
// Four is enough to make "and no others" mean something: the set below names
// two of them, so a scoped run that asked three would fail this suite.

function arcgisSource(provider: string, title: string) {
  return {
    title,
    status: 'published',
    category: 'environment',
    source: {
      provider,
      access: [{ type: 'arcgis', url: `https://services.arcgis.com/x/rest/services/${title}/FeatureServer/0` }],
      placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
      updateCadence: 'weekly',
    },
  }
}

const SITES_META = {
  title: 'Memphis candidate sites',
  status: 'published',
  category: 'land',
}
const SITES_CSV = ['Name,GEOID,lat,lng', 'Old Rail Yard,47157,35.1495,-90.0490'].join('\n')

let fake: FakeS3
let dataDir: string

async function seedLibrary(): Promise<void> {
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(arcgisSource('US EPA', 'NPL')))
  fake.seed('library/sources/epa-brownfields/meta.json', JSON.stringify(arcgisSource('US EPA', 'ACRES')))
  fake.seed('library/sources/fema-nri/meta.json', JSON.stringify(arcgisSource('FEMA', 'NRI')))
  fake.seed('library/sources/tn-transmission/meta.json', JSON.stringify(arcgisSource('EIA', 'Transmission')))
  fake.seed('library/datasets/memphis-sites/meta.json', JSON.stringify(SITES_META))
  fake.seed('library/datasets/memphis-sites/sites.csv', SITES_CSV)
  await reindexCatalog()
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-working-sets-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  clearCountyIndex()
  await seedLibrary()
})

afterEach(async () => {
  await placeReportIndexSettled()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const POINT_PLACE: SlicePlace = { label: 'Atlanta', lat: ATLANTA.lat, lng: ATLANTA.lng, geoid: '13121', radiusMiles: 5 }

function fetchResult(slug: string, count: number): FetchResult {
  return {
    slug,
    rows: Array.from({ length: count }, (_, i) => ({ Site_Name: `Site ${i + 1}` })),
    columns: ['Site_Name'],
    count,
    truncated: false,
    fetchedAt: new Date().toISOString(),
    cacheKey: 'p33.7490_-84.3880_r5',
    cached: false,
    adapter: 'arcgis',
    place: POINT_PLACE,
  }
}

function fakeFetcher() {
  const calls: string[] = []
  const fn = vi.fn(async (input: { slug: string }) => {
    calls.push(input.slug)
    return fetchResult(input.slug, 1)
  })
  return { fn: fn as any, calls }
}

const fakeCountyValues = vi.fn(async ({ layerId, geoids }: { layerId: string; geoids: string[] }) => ({
  layerId,
  counties: [{ geoid: geoids[0], value: null }],
}))

const fakeAsk = vi.fn(async () => ({
  answer: 'One site within five miles [1].',
  sources: [],
  queries: [],
  places: [],
  counts: { pages: 0, datasets: 0, documents: 0, notes: 0 },
  toolCalls: 0,
})) as any

function deps() {
  const fetcher = fakeFetcher()
  return { fetcher, deps: { fetchForPlace: fetcher.fn, countyValues: fakeCountyValues, ask: fakeAsk } }
}

async function aSet(over: Record<string, unknown> = {}) {
  const made = await createWorkingSet({
    name: 'Memphis redevelopment',
    purpose: 'Which parcels can be redeveloped, and what bears on siting',
    datasets: ['epa-superfund-npl', 'epa-brownfields'],
    layers: ['combined_scores_v2'],
    sites: 'memphis-sites',
    savedBy: 'maria',
    savedById: 1,
    ...over,
  })
  if (made.error) throw new Error(made.error)
  return made
}

// --- The object ---------------------------------------------------------------

describe('the working set as an object', () => {
  it('is a catalog row of its own kind, bucket-first, with the manifest as its meta', async () => {
    const { slug } = await aSet()
    expect(slug).toBe('memphis-redevelopment')
    expect(fake.objects.has(workingSetKey(slug))).toBe(true)

    const entry = await getCatalogEntry(slug)
    expect(entry?.kind).toBe(WORKING_SET_KIND)
    expect(entry?.title).toBe('Memphis redevelopment')
    expect(entry?.meta.datasets).toEqual(['memphis-sites', 'epa-superfund-npl', 'epa-brownfields'])
    expect(entry?.meta.sites).toBe('memphis-sites')
  })

  /** The load-bearing half of §F.1: a set is the data, a view is the framing.
   *  If a viewport ever lands in here the two objects have collapsed. */
  it('holds no framing — no viewport, no sort, no palette, whatever is offered', async () => {
    const { slug } = await aSet({
      // Deliberately pushed in as if a caller had confused the two objects.
      viewport: { center: [0, 0], zoom: 4 },
      sort: 'distance',
      palette: 'viridis',
      filters: [{ column: 'x', op: 'eq', value: 'y' }],
    } as Record<string, unknown>)
    const entry = await getCatalogEntry(slug)
    for (const framing of ['viewport', 'sort', 'palette', 'filters', 'limit', 'regionStates', 'prompt']) {
      expect(entry?.meta[framing]).toBeUndefined()
    }
  })

  it('anchors on a sites dataset, which is a member by definition', async () => {
    const { slug } = await aSet({ datasets: ['epa-superfund-npl'], sites: 'memphis-sites' })
    const set = await getWorkingSet(slug)
    expect(set?.sites).toBe('memphis-sites')
    expect(set?.datasets).toContain('memphis-sites')
  })

  it('survives a reindex unchanged — the bucket is the truth', async () => {
    const { slug } = await aSet()
    const before = await getWorkingSet(slug)
    await reindexCatalog()
    const after = await getWorkingSet(slug)
    // `updatedAt` is derived from the bucket object rather than stored, so it
    // is the one field a rebuild is allowed to re-read.
    expect({ ...after, updatedAt: '' }).toEqual({ ...before, updatedAt: '' })
  })

  it('names what the library no longer has rather than quietly shrinking', async () => {
    const { slug } = await aSet({ datasets: ['epa-superfund-npl', 'never-ingested'], sites: null })
    const set = await getWorkingSet(slug)
    const { entries, missing } = await workingSetMembers(set!)
    expect(entries.map(e => e.slug)).toEqual(['epa-superfund-npl'])
    expect(missing).toEqual(['never-ingested'])
  })

  it('lists its sets, and a non-set slug reads as no set at all', async () => {
    await aSet()
    await createWorkingSet({ name: 'Transmission corridors', datasets: ['tn-transmission'], savedBy: 'maria', savedById: 1 })
    expect((await listWorkingSets()).map(s => s.slug).sort()).toEqual(['memphis-redevelopment', 'transmission-corridors'])
    // A held dataset's slug is not a working set, even though it is a row.
    expect(await getWorkingSet('memphis-sites')).toBeNull()
    expect(await workingSetMemberSlugs('memphis-sites')).toBeNull()
  })

  it('auto-suffixes a repeated name instead of overwriting the first set', async () => {
    const first = await aSet()
    const second = await aSet()
    expect(first.slug).toBe('memphis-redevelopment')
    expect(second.slug).toBe('memphis-redevelopment-2')
  })

  it('refuses a name with no letters or digits in it', async () => {
    expect(await createWorkingSet({ name: '—', savedBy: 'maria', savedById: 1 })).toEqual({ error: 'bad-name' })
  })
})

describe('editing a set', () => {
  it('replaces the named fields and leaves the rest alone', async () => {
    const { slug } = await aSet()
    const updated = await updateWorkingSet(slug, { datasets: ['epa-superfund-npl', 'fema-nri', 'tn-transmission'] })
    // The anchor leads: a set is "these sites, and what bears on them".
    expect(updated?.datasets).toEqual(['memphis-sites', 'epa-superfund-npl', 'fema-nri', 'tn-transmission'])
    // Untouched fields are still there, and the anchor came back with them.
    expect(updated?.purpose).toContain('redeveloped')
    expect(updated?.layers).toEqual(['combined_scores_v2'])
    expect(updated?.savedBy).toBe('maria')
  })

  /**
   * P7-6 keys a stored analysis result on its inputs. Adding a twelfth dataset
   * must not silently discard a proximity column somebody is already quoting,
   * so an edit never touches `derived` — which is also the whole reason the
   * field is declared in P7-1 rather than invented later.
   */
  it('never touches the derived columns analysis wrote onto the set', async () => {
    const { slug } = await aSet()
    const key = workingSetKey(slug)
    const manifest = JSON.parse(fake.objects.get(key)!.toString('utf8'))
    fake.seed(
      key,
      JSON.stringify({ ...manifest, derived: [{ id: 'miles-to-transmission', computedBy: 'proximity' }] }),
    )
    await reindexCatalog()
    expect((await getWorkingSet(slug))?.derived).toHaveLength(1)

    const updated = await updateWorkingSet(slug, { purpose: 'narrowed to two counties' })
    expect(updated?.derived).toEqual([{ id: 'miles-to-transmission', computedBy: 'proximity' }])
    expect(updated?.purpose).toBe('narrowed to two counties')
    // And the count reaches the sentence the catalog shows.
    expect(describeWorkingSet(updated!)).toContain('1 derived column')
  })

  it('reads a hand-edited manifest tolerantly instead of throwing', async () => {
    const doc = readWorkingSet(
      { title: '  ', datasets: ['a', 'a', 42, ' b '], layers: 'not-a-list', sites: 'c', purpose: 7 },
      'fallback-slug',
    )
    expect(doc.title).toBe('fallback-slug')
    expect(doc.datasets).toEqual(['c', 'a', 'b'])
    expect(doc.layers).toEqual([])
    expect(doc.purpose).toBe('')
  })

  it('an update to a slug that is not a set is a miss, not a new set', async () => {
    expect(await updateWorkingSet('memphis-sites', { purpose: 'x' })).toBeNull()
    expect(await updateWorkingSet('nothing-here', { purpose: 'x' })).toBeNull()
    expect((await searchCatalog({ kind: WORKING_SET_KIND })).length).toBe(0)
  })

  it('describes itself by counting, with the purpose leading', async () => {
    const { slug } = await aSet()
    const line = describeWorkingSet((await getWorkingSet(slug))!)
    expect(line).toBe(
      'Working set · Which parcels can be redeveloped, and what bears on siting · 3 datasets · 1 layer · anchored on memphis-sites',
    )
  })

  it('writes a manifest a reindex can rebuild the row from, and nothing more', async () => {
    const doc = readWorkingSet((await getCatalogEntry((await aSet()).slug))!.meta, 'memphis-redevelopment')
    expect(Object.keys(workingSetManifest(doc)).sort()).toEqual([
      'category',
      'datasets',
      'description',
      'layers',
      'purpose',
      'savedAt',
      'savedBy',
      'savedById',
      'sites',
      'status',
      'tags',
      'title',
    ])
  })
})

// --- A set and its views ------------------------------------------------------

describe('a set and the views that present it', () => {
  async function view(name: string, workingSet?: string) {
    const made = await createSavedView({
      name,
      type: 'map',
      state: { layers: [{ layerId: 'combined_scores_v2', weight: 1 }], viewport: { center: [-90, 35], zoom: 8 } },
      results: [],
      savedBy: 'maria',
      savedById: 1,
      ...(workingSet ? { workingSet } : {}),
    })
    if (made.error) throw new Error(made.error)
    return made.slug
  }

  it('carries more than one view, each pointing at the same set', async () => {
    const { slug } = await aSet()
    const framed = await view('Memphis cluster', slug)
    const sorted = await view('Memphis by distance', slug)

    expect((await getSavedView(framed))?.workingSet).toBe(slug)
    expect((await getSavedView(sorted))?.workingSet).toBe(slug)

    const presenting = (await searchCatalog({ kind: 'view' })).filter(v => v.meta.workingSet === slug)
    expect(presenting.map(v => v.slug).sort()).toEqual([sorted, framed].sort())

    // Two framings, one set — and so one answer about what the rows are.
    const sets = await Promise.all(presenting.map(v => workingSetMemberSlugs(String(v.meta.workingSet))))
    expect(sets[0]).toEqual(sets[1])
  })

  /**
   * Spec §F.1, approved and not negotiable: an existing view keeps a null
   * pointer and behaves exactly as it does today. Ad-hoc, not legacy.
   */
  it('leaves an ad-hoc view with no pointer at all — not an empty one', async () => {
    const adhoc = await view('Just exploring')
    const doc = await getSavedView(adhoc)
    expect(doc?.workingSet).toBeUndefined()
    expect('workingSet' in JSON.parse(fake.objects.get(`library/views/${adhoc}.json`)!.toString('utf8'))).toBe(false)
    // The row says '' — a stated absence that matches no set, the same way a
    // map view's `dataset` is ''.
    expect((await getCatalogEntry(adhoc))?.meta.workingSet).toBe('')
  })

  it('promotes an ad-hoc view: the set is created and the view points at it', async () => {
    const adhoc = await view('Just exploring')
    const made = await createWorkingSet({
      name: 'Promoted from exploring',
      layers: ['combined_scores_v2'],
      fromView: adhoc,
      savedBy: 'maria',
      savedById: 1,
    })
    if (made.error) throw new Error(made.error)
    const pointed = await setViewWorkingSet(adhoc, made.slug)
    expect(pointed.error).toBeUndefined()

    expect((await getSavedView(adhoc))?.workingSet).toBe(made.slug)
    expect((await getWorkingSet(made.slug))?.fromView).toBe(adhoc)
    // The view's own state is untouched by being promoted.
    expect((await getSavedView(adhoc))?.state.viewport).toEqual({ center: [-90, 35], zoom: 8 })
  })

  it('un-points a view back to exactly the document it was before', async () => {
    const { slug } = await aSet()
    const pointed = await view('Memphis cluster', slug)
    await setViewWorkingSet(pointed, null)
    const raw = JSON.parse(fake.objects.get(`library/views/${pointed}.json`)!.toString('utf8'))
    expect('workingSet' in raw).toBe(false)
    expect((await getCatalogEntry(pointed))?.meta.workingSet).toBe('')
  })

  it('pointing something that is not a view is a miss', async () => {
    const { slug } = await aSet()
    expect(await setViewWorkingSet('memphis-sites', slug)).toEqual({ error: 'not-found' })
  })

  it('survives a reindex: the pointer is in the document, not only the row', async () => {
    const { slug } = await aSet()
    const pointed = await view('Memphis cluster', slug)
    await reindexCatalog()
    expect((await getCatalogEntry(pointed))?.meta.workingSet).toBe(slug)
    expect((await getSavedView(pointed))?.workingSet).toBe(slug)
  })
})

// --- The reason the object exists --------------------------------------------

describe('a place report run inside a working set', () => {
  /**
   * THE acceptance test. `applicableSources` filters candidates with
   * `fitsPlace` and nothing else — a question about *where*, never about
   * *what was asked*. Four sources fit this place; the set names two.
   */
  it('asks that set’s sources and no others', async () => {
    const { slug } = await aSet()
    const { fetcher, deps: d } = deps()

    const { report } = await runPlaceReport({ point: ATLANTA, geoid: '13121', workingSet: slug, deps: d })

    expect(fetcher.calls.sort()).toEqual(['epa-brownfields', 'epa-superfund-npl'])
    expect(report.sections.map(s => s.slug).sort()).toEqual(['epa-brownfields', 'epa-superfund-npl'])
    // The held table and the anchor are in the set but are not sources, so
    // they are not asked — a set of five does not become five agency requests.
    expect(fetcher.calls).not.toContain('memphis-sites')
  })

  it('and the same place unscoped still asks all of them', async () => {
    const { slug } = await aSet()
    const scoped = deps()
    await runPlaceReport({ point: ATLANTA, geoid: '13121', workingSet: slug, deps: scoped.deps })
    const everything = deps()
    const { report } = await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: everything.deps })
    expect(everything.fetcher.calls).toHaveLength(4)
    expect(report.sections).toHaveLength(4)
    expect(scoped.fetcher.calls).toHaveLength(2)
  })

  it('refuses a set that does not exist rather than running all of them', async () => {
    const { fetcher, deps: d } = deps()
    await expect(
      runPlaceReport({ point: ATLANTA, geoid: '13121', workingSet: 'no-such-set', deps: d }),
    ).rejects.toThrow(PlaceScopeError)
    expect(fetcher.calls).toEqual([])
  })

  it('refuses a set that names nothing yet, rather than reporting "nothing found"', async () => {
    const made = await createWorkingSet({ name: 'Empty so far', savedBy: 'maria', savedById: 1 })
    if (made.error) throw new Error(made.error)
    const { fetcher, deps: d } = deps()
    await expect(
      runPlaceReport({ point: ATLANTA, geoid: '13121', workingSet: made.slug, deps: d }),
    ).rejects.toThrow(/names no datasets yet/)
    expect(fetcher.calls).toEqual([])
  })

  it('narrows within a set rather than reaching outside it', async () => {
    const { slug } = await aSet()
    const { fetcher, deps: d } = deps()
    await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      workingSet: slug,
      // `fema-nri` is not in the set, so naming it cannot add it.
      sources: ['epa-superfund-npl', 'fema-nri'],
      deps: d,
    })
    expect(fetcher.calls).toEqual(['epa-superfund-npl'])
  })

  /**
   * The existing rule, unchanged and deliberately so: a scoped report is a
   * different document and must never be served as, or saved over, the full
   * one. Storing a scoped result under its own key is P7-6's job, where it is
   * keyed on inputs rather than on a clock.
   */
  it('is neither served from nor saved to the whole-place cache', async () => {
    const { slug } = await aSet()
    await runPlaceReport({ point: ATLANTA, geoid: '13121', workingSet: slug, deps: deps().deps })
    expect(fake.objects.has('library/derived/place/p33.7490_-84.3880_r5.json')).toBe(false)
  })
})
