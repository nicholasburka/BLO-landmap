import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * The place report (P5-58).
 *
 * The real catalog, the real bucket and the real report service run here;
 * only the three things that would reach out are injected — the per-source
 * fetch (P5-57), the county-values reader (P5-45) and the model. That keeps
 * the things this file is judged on real: which sources are applicable,
 * how many run at once, what happens at the deadline, the section order, the
 * cache, and the excerpt block the summary is written from.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { PlaceFetchError } = await import('./placeFetch.js')
const {
  applicableSources,
  clearCountyIndex,
  compareHref,
  countyCard,
  findPointDataset,
  fitsPlace,
  formatLayerValue,
  foundCount,
  isReportFresh,
  nearbyOrganizations,
  readPlaceReport,
  reportKey,
  reportMaxSources,
  reportTimeoutMs,
  runBounded,
  runPlaceReport,
  sortSections,
  summaryExcerpts,
  summaryQuestion,
  ORGANIZATIONS_MAX,
  REPORT_CONCURRENCY,
  REPORT_ROWS,
  REPORT_TTL_DAYS,
  SUMMARY_ROWS,
} = await import('./placeReport.js')
const { listPlaceReports, placeReportIndexSettled } = await import('./placeReportIndex.js')
const { ATLANTA } = await import('../testutils/fixtures/place/index.js')

type PlaceReport = import('./placeReport.js').PlaceReport
type ReportSection = import('./placeReport.js').ReportSection
type SlicePlace = import('./placeFetch.js').SlicePlace
type FetchResult = import('./placeFetch.js').FetchForPlaceResult

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

// --- The library this report runs against ------------------------------------

/** ArcGIS, answers by point or county — the ordinary case. */
const NPL = {
  title: 'EPA Superfund NPL sites',
  status: 'published',
  category: 'environment',
  source: {
    provider: 'US EPA',
    access: [{ type: 'arcgis', url: 'https://services.arcgis.com/x/rest/services/NPL/FeatureServer/0' }],
    placeQuery: { by: ['point', 'county'], radiusMiles: 5, fipsField: 'STCOFIPS' },
    updateCadence: 'weekly',
  },
}

/** Socrata, answers by point only — no row exists for "Fulton County". */
const USTS = {
  title: 'Georgia underground storage tanks',
  status: 'published',
  source: {
    provider: 'Georgia EPD',
    access: [{ type: 'socrata', url: 'https://data.georgia.gov/resource/abcd-1234.json' }],
    placeQuery: { by: ['point'], geoField: 'location_1' },
  },
}

/** Spreadsheets and phone calls: listed, never fetched. */
const ASSESSOR = {
  title: 'County assessor parcels',
  status: 'published',
  source: {
    provider: 'Fulton County',
    homepage: 'https://example.gov/assessor',
    access: [{ type: 'manual', notes: 'Request a parcel export from the assessor’s office.' }],
    placeQuery: { by: ['parcel', 'county'] },
  },
}

/** A source whose manifest never said how it is queried, but which names a
 *  FIPS column — the "unknown but county-shaped" case. */
const RISK = {
  title: 'FEMA National Risk Index',
  status: 'published',
  source: {
    provider: 'FEMA',
    access: [{ type: 'download', url: 'https://example.gov/nri.csv' }],
    placeQuery: { fipsField: 'STCOFIPS' },
  },
}

/** A published dataset drawn as points — the organizations card's source. */
const ORGS_META = {
  title: 'Organizations',
  status: 'published',
  category: 'organizations',
  layer: {
    geometry: 'point',
    name: 'Organizations (HQ)',
    latKey: 'lat',
    lngKey: 'lng',
    labelKey: 'Name',
    popupFields: ['Tier'],
    color: '#1f7a2e',
  },
}

/** Two inside fifty miles of Atlanta City Hall, one in Memphis, one unmapped. */
const ORGS_CSV = [
  'Name,Tier,lat,lng',
  'Peachtree Land Trust,Tier 1,33.7600,-84.3900',
  'South Fulton Coop,Tier 2,33.6000,-84.5000',
  'Delta Farmers Union,Tier 1,35.1495,-90.0490',
  'No Coordinates Inc,Tier 3,,',
].join('\n')

let fake: FakeS3
let dataDir: string

async function seedLibrary(): Promise<void> {
  fake.seed('library/sources/epa-superfund-npl/meta.json', JSON.stringify(NPL))
  fake.seed('library/sources/georgia-epd-ust/meta.json', JSON.stringify(USTS))
  fake.seed('library/sources/fulton-assessor/meta.json', JSON.stringify(ASSESSOR))
  fake.seed('library/sources/fema-nri/meta.json', JSON.stringify(RISK))
  fake.seed('library/datasets/organizations/meta.json', JSON.stringify(ORGS_META))
  fake.seed('library/datasets/organizations/organizations.csv', ORGS_CSV)
  await reindexCatalog()
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-place-report-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  clearCountyIndex()
  await seedLibrary()
})

afterEach(async () => {
  // Every reindex above launched a detached index rebuild (P6-4). Let it
  // finish before the bucket and its mirror directory are taken away.
  await placeReportIndexSettled()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.PLACE_REPORT_TIMEOUT_MS
  delete process.env.PLACE_REPORT_MAX_SOURCES
})

// --- Fakes -------------------------------------------------------------------

const POINT_PLACE: SlicePlace = { label: 'Atlanta', lat: ATLANTA.lat, lng: ATLANTA.lng, geoid: '13121', radiusMiles: 5 }
const COUNTY_PLACE: SlicePlace = { label: 'Fulton County, GA', lat: null, lng: null, geoid: '13121', radiusMiles: 5 }

function fetchResult(slug: string, count: number): FetchResult {
  const rows = Array.from({ length: count }, (_, i) => ({ Site_Name: `Site ${i + 1}`, Status: 'Final' }))
  return {
    slug,
    rows,
    columns: ['Site_Name', 'Status'],
    count,
    truncated: false,
    fetchedAt: new Date().toISOString(),
    cacheKey: 'p33.7490_-84.3880_r5',
    cached: false,
    adapter: 'arcgis',
    place: POINT_PLACE,
  }
}

/** A fetch that answers per slug, recording how many were in flight at once. */
function fakeFetcher(answers: Record<string, number | Error>, delayMs = 0) {
  let live = 0
  let peak = 0
  const calls: string[] = []
  const fn = vi.fn(async (input: { slug: string }) => {
    calls.push(input.slug)
    live++
    peak = Math.max(peak, live)
    try {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
      const answer = answers[input.slug]
      if (answer instanceof Error) throw answer
      return fetchResult(input.slug, typeof answer === 'number' ? answer : 0)
    } finally {
      live--
    }
  })
  return { fn: fn as any, calls, peak: () => peak }
}

const fakeCountyValues = vi.fn(async ({ layerId, geoids }: { layerId: string; geoids: string[] }) => ({
  layerId,
  counties: [{ geoid: geoids[0], value: layerId === 'pct_Black' ? 44.5 : null }],
}))

const fakeAsk = vi.fn(async (options: any) => ({
  answer: 'Two Superfund sites sit within five miles [1]. The county is 44.5% Black [3].',
  sources: [
    { n: 1, slug: 'epa-superfund-npl', kind: 'place', title: 'EPA Superfund NPL sites', href: '/library/epa-superfund-npl?place=x', snippet: '', cited: true },
    { n: 3, slug: 'county:13121', kind: 'place', title: 'Fulton County', href: '/compare?counties=13121', snippet: '', cited: true },
  ],
  queries: [],
  places: [],
  counts: { pages: 0, datasets: 0, documents: 0, notes: 0 },
  toolCalls: 0,
  usedTokens: 10,
  inputTokens: 8,
  outputTokens: 2,
  __options: options,
})) as any

beforeEach(() => {
  fakeCountyValues.mockClear()
  fakeAsk.mockClear()
})

// --- Which sources apply -----------------------------------------------------

describe('applicability', () => {
  it('takes every fitting source for a point, and marks the hand-only one skipped', async () => {
    const found = await applicableSources(POINT_PLACE)
    const bySlug = Object.fromEntries(found.map(c => [c.entry.slug, c]))
    expect(Object.keys(bySlug).sort()).toEqual(['epa-superfund-npl', 'fema-nri', 'fulton-assessor', 'georgia-epd-ust'])
    expect(bySlug['epa-superfund-npl'].manualReason).toBeNull()
    expect(bySlug['fulton-assessor'].manualReason).toContain('assessor’s office')
    // The hand instructions carry where to go, not just that it is manual.
    expect(bySlug['fulton-assessor'].manualReason).toContain('https://example.gov/assessor')
  })

  it('drops point-only sources when all we have is a county', async () => {
    const found = await applicableSources(COUNTY_PLACE)
    expect(found.map(c => c.entry.slug).sort()).toEqual(['epa-superfund-npl', 'fema-nri', 'fulton-assessor'])
  })

  it('honours an explicit sources filter', async () => {
    const found = await applicableSources(POINT_PLACE, ['epa-superfund-npl'])
    expect(found.map(c => c.entry.slug)).toEqual(['epa-superfund-npl'])
  })

  it('never returns more than the cap', async () => {
    process.env.PLACE_REPORT_MAX_SOURCES = '2'
    expect(reportMaxSources()).toBe(2)
    expect((await applicableSources(POINT_PLACE)).length).toBe(2)
  })

  it('fitsPlace: a point takes anything; a county needs a county query', () => {
    expect(fitsPlace({ provider: 'x', placeQuery: { by: ['point'] } }, POINT_PLACE)).toBe(true)
    expect(fitsPlace({ provider: 'x', placeQuery: { by: ['point'] } }, COUNTY_PLACE)).toBe(false)
    expect(fitsPlace({ provider: 'x', placeQuery: { by: ['County'] } }, COUNTY_PLACE)).toBe(true)
    // No declaration at all: only when a county column is actually named.
    expect(fitsPlace({ provider: 'x' }, COUNTY_PLACE)).toBe(false)
    expect(fitsPlace({ provider: 'x', placeQuery: { fipsField: 'GEOID' } }, COUNTY_PLACE)).toBe(true)
  })
})

// --- The pool and the deadline ----------------------------------------------

describe('runBounded', () => {
  it('runs at most `limit` tasks at once and keeps every answer in order', async () => {
    let live = 0
    let peak = 0
    const tasks = Array.from({ length: 9 }, (_, i) => async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, 5))
      live--
      return i
    })
    const { results, timedOut } = await runBounded(tasks, 3, Date.now() + 10_000)
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(peak).toBeLessThanOrEqual(3)
    expect(timedOut).toBe(false)
  })

  it('stops handing out work at the deadline and says so', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => async () => {
      await new Promise(r => setTimeout(r, 20))
      return i
    })
    const { results, timedOut } = await runBounded(tasks, 1, Date.now() + 30)
    expect(timedOut).toBe(true)
    expect(results.filter(r => r !== undefined).length).toBeLessThan(6)
  })
})

describe('the deadline in a report', () => {
  it('reports sources that never got their turn as "could not check in time"', async () => {
    process.env.PLACE_REPORT_TIMEOUT_MS = '40'
    expect(reportTimeoutMs()).toBe(40)
    const fetcher = fakeFetcher({ 'epa-superfund-npl': 2, 'georgia-epd-ust': 1, 'fema-nri': 3 }, 60)
    const { report } = await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: { fetchForPlace: fetcher.fn, countyValues: fakeCountyValues, ask: fakeAsk },
    })
    const timedOut = report.sections.filter(s => s.status === 'timeout')
    expect(timedOut.length).toBeGreaterThan(0)
    expect(timedOut[0].reason).toContain('ran out of time')
    // Even at the deadline the report is whole: every applicable source has a
    // section, so nothing silently disappears from the answer.
    expect(report.sections).toHaveLength(4)
  })

  it('never has more than three sources in flight', async () => {
    const fetcher = fakeFetcher({ 'epa-superfund-npl': 1, 'georgia-epd-ust': 1, 'fema-nri': 1 }, 15)
    await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: { fetchForPlace: fetcher.fn, countyValues: fakeCountyValues, ask: fakeAsk },
    })
    expect(fetcher.peak()).toBeLessThanOrEqual(REPORT_CONCURRENCY)
  })
})

// --- The report --------------------------------------------------------------

describe('runPlaceReport', () => {
  const deps = () => ({
    fetchForPlace: fakeFetcher({
      'epa-superfund-npl': 12,
      'georgia-epd-ust': 0,
      'fema-nri': new Error('boom'),
    }).fn,
    countyValues: fakeCountyValues,
    ask: fakeAsk,
  })

  it('sections a point report found → none → skipped → failed, with rows capped', async () => {
    const { report, placeKey, cached } = await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: deps() })
    expect(cached).toBe(false)
    expect(placeKey).toBe('p33.7490_-84.3880_r5')
    expect(report.sections.map(s => [s.slug, s.status])).toEqual([
      ['epa-superfund-npl', 'found'],
      ['georgia-epd-ust', 'none'],
      ['fulton-assessor', 'skipped'],
      ['fema-nri', 'failed'],
    ])
    const npl = report.sections[0]
    expect(npl.count).toBe(12)
    expect(npl.rows).toHaveLength(REPORT_ROWS)
    expect(npl.provider).toBe('US EPA')
    expect(npl.href).toBe('/library/epa-superfund-npl?place=p33.7490_-84.3880_r5')
    expect(npl.cacheKey).toBe('p33.7490_-84.3880_r5')
    expect(report.sections[3].reason).toBeTruthy()
    expect(foundCount(report)).toBe(1)
  })

  it('carries each source’s topic, so the report can group its sections (P5-63)', async () => {
    const { report } = await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: deps() })
    const byslug = Object.fromEntries(report.sections.map(s => [s.slug, s.topic]))
    // From the manifest's own category…
    expect(byslug['epa-superfund-npl']).toBe('environment')
    // …and null when nothing on the entry names a subject, which is honest
    // rather than a guess: the client groups those under one last heading.
    expect(byslug['georgia-epd-ust']).toBeNull()
    // A skipped section carries it too — grouping must not lose the
    // check-by-hand rows.
    expect(report.sections.find(s => s.status === 'skipped')).toHaveProperty('topic')
  })

  it('lists a source that turns out to have nothing queryable as check-by-hand, not as a failure', async () => {
    // A download-only spreadsheet or a REST template with no placeholder is
    // only discovered when the adapter runs; the reader should get "where to
    // look", not "something broke".
    const fetcher = fakeFetcher({
      'epa-superfund-npl': 1,
      'georgia-epd-ust': new PlaceFetchError('no access method for this source can be fetched automatically', 'no-endpoint'),
      'fema-nri': new PlaceFetchError('the agency refused', 'bad-response'),
    })
    const { report } = await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: { fetchForPlace: fetcher.fn, countyValues: fakeCountyValues, ask: fakeAsk },
    })
    const bySlug = Object.fromEntries(report.sections.map(s => [s.slug, s]))
    expect(bySlug['georgia-epd-ust'].status).toBe('skipped')
    expect(bySlug['georgia-epd-ust'].reason).toMatch(/by hand|https?:\/\//)
    expect(bySlug['fema-nri'].status).toBe('failed')
  })

  it('geocodes once: every source is asked for the same coordinates, not the address', async () => {
    const fetcher = fakeFetcher({ 'epa-superfund-npl': 1, 'georgia-epd-ust': 1, 'fema-nri': 1 })
    await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: { fetchForPlace: fetcher.fn, countyValues: fakeCountyValues, ask: fakeAsk },
    })
    for (const call of fetcher.fn.mock.calls) {
      expect(call[0].address).toBeUndefined()
      expect(call[0].point).toEqual({ lat: ATLANTA.lat, lng: ATLANTA.lng })
      expect(call[0].geoid).toBe('13121')
    }
  })

  it('carries the county card with the layers that have a number', async () => {
    const { report } = await runPlaceReport({ geoid: '13121', deps: deps() })
    expect(report.county).toMatchObject({ geoid: '13121', name: 'Fulton County', state: 'Georgia' })
    expect(report.county?.layers).toEqual([
      { id: 'pct_Black', name: expect.any(String), value: 44.5, formatted: '44.5%', direction: expect.any(String) },
    ])
    expect(report.place.county).toBe('Fulton County')
    expect(report.place.state).toBe('Georgia')
  })

  it('lists the organizations within fifty miles, nearest first', async () => {
    const { report } = await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: deps() })
    expect(report.organizations.map(o => o.name)).toEqual(['Peachtree Land Trust', 'South Fulton Coop'])
    expect(report.organizations[0].distanceMiles).toBeLessThan(2)
    expect(report.organizations[0].href).toBe('/library/organizations?tab=data&q=Peachtree%20Land%20Trust')
  })

  it('has no organizations card for a county-only place', async () => {
    const { report } = await runPlaceReport({ geoid: '13121', deps: deps() })
    expect(report.organizations).toEqual([])
  })

  it('refuses a place it cannot make sense of', async () => {
    await expect(runPlaceReport({ deps: deps() })).rejects.toThrow(/address, a point, or a county/)
  })
})

// --- Progress (P6-16) --------------------------------------------------------

describe('what the run says about itself (P6-16)', () => {
  type Event = import('./placeReport.js').PlaceProgressEvent

  const deps = () => ({
    fetchForPlace: fakeFetcher({
      'epa-superfund-npl': 12,
      'georgia-epd-ust': 0,
      'fema-nri': new Error('boom'),
    }).fn,
    countyValues: fakeCountyValues,
    ask: fakeAsk,
  })

  it('reports every source as it goes out and as it comes back', async () => {
    const events: Event[] = []
    const { report } = await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: deps(),
      onProgress: e => events.push(e),
    })

    // It opens by saying how many, and closes by saying it is writing up.
    expect(events[0]).toEqual({ type: 'start', total: 4 })
    expect(events.at(-1)).toEqual({ type: 'summary' })

    // Every section in the finished report was reported exactly once, and the
    // status it was reported with is the status it ended up with.
    const settled = events.filter((e): e is Extract<Event, { type: 'section' }> => e.type === 'section')
    expect(settled).toHaveLength(report.sections.length)
    expect(Object.fromEntries(settled.map(e => [e.slug, e.status]))).toEqual(
      Object.fromEntries(report.sections.map(s => [s.slug, s.status])),
    )

    // The count climbs one at a time to the total, never past it.
    expect(settled.map(e => e.done)).toEqual([1, 2, 3, 4])
    expect(settled.every(e => e.total === 4)).toBe(true)

    // A source that went out was named before it answered.
    const started = events.filter((e): e is Extract<Event, { type: 'source' }> => e.type === 'source')
    expect(started.map(e => e.slug).sort()).toEqual(['epa-superfund-npl', 'fema-nri', 'georgia-epd-ust'])
    for (const out of started) {
      const back = settled.findIndex(e => e.slug === out.slug)
      expect(events.indexOf(out)).toBeLessThan(events.indexOf(settled[back]))
    }
  })

  it('counts a check-by-hand source as done before anything goes out', async () => {
    const events: Event[] = []
    await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: deps(), onProgress: e => events.push(e) })
    // `fulton-assessor` is published by hand: it is already decided, so it is
    // already counted. Leaving it until the end would make "1 of 4" a lie.
    expect(events[1]).toMatchObject({ type: 'section', slug: 'fulton-assessor', status: 'skipped', done: 1 })
    expect(events.findIndex(e => e.type === 'source')).toBeGreaterThan(1)
  })

  it('says a source failed rather than leaving it out', async () => {
    const events: Event[] = []
    await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: deps(), onProgress: e => events.push(e) })
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'section', slug: 'fema-nri', status: 'failed' })]),
    )
  })

  it('reports a source the deadline passed over as one that could not be checked', async () => {
    process.env.PLACE_REPORT_TIMEOUT_MS = '40'
    const events: Event[] = []
    const fetcher = fakeFetcher({ 'epa-superfund-npl': 2, 'georgia-epd-ust': 1, 'fema-nri': 3 }, 60)
    const { report } = await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: { fetchForPlace: fetcher.fn, countyValues: fakeCountyValues, ask: fakeAsk },
      onProgress: e => events.push(e),
    })
    const settled = events.filter((e): e is Extract<Event, { type: 'section' }> => e.type === 'section')
    // Whatever the deadline did, the stream accounted for every section once.
    // `runBounded` stops WAITING for what is in flight rather than cancelling
    // it, so a source already reported as "could not check in time" can still
    // answer afterwards — and must not be counted twice.
    expect(settled).toHaveLength(report.sections.length)
    expect(new Set(settled.map(e => e.slug)).size).toBe(report.sections.length)
    expect(settled.map(e => e.done)).toEqual([1, 2, 3, 4])
    expect(Math.max(...settled.map(e => e.done))).toBeLessThanOrEqual(4)
    expect(events.filter(e => e.type === 'summary')).toHaveLength(1)

    // And nothing arrives after the report is finished, either.
    const before = events.length
    await new Promise(r => setTimeout(r, 80))
    expect(events.length).toBe(before)
  })

  it('says nothing at all for a report that came back from the cache', async () => {
    await runPlaceReport({ geoid: '13121', deps: deps() })
    const events: Event[] = []
    const { cached } = await runPlaceReport({ geoid: '13121', deps: deps(), onProgress: e => events.push(e) })
    // There is no run to report on: the answer was already written.
    expect(cached).toBe(true)
    expect(events).toEqual([])
  })

  it('runs exactly as before when nobody is listening', async () => {
    const { report } = await runPlaceReport({ point: ATLANTA, geoid: '13121', deps: deps() })
    expect(report.sections).toHaveLength(4)
  })
})

// --- The cache ---------------------------------------------------------------

describe('the derived cache', () => {
  const deps = () => ({
    fetchForPlace: fakeFetcher({ 'epa-superfund-npl': 2, 'georgia-epd-ust': 0, 'fema-nri': 1 }).fn,
    countyValues: fakeCountyValues,
    ask: fakeAsk,
  })

  it('writes one document per place, under library/derived/place/', async () => {
    await runPlaceReport({ geoid: '13121', deps: deps() })
    expect(reportKey('g13121')).toBe('library/derived/place/g13121.json')
    expect(fake.objects.has('library/derived/place/g13121.json')).toBe(true)
    const back = await readPlaceReport('g13121')
    expect(back?.place.geoid).toBe('13121')
  })

  it('answers the same place from the cache without running anything again', async () => {
    const first = deps()
    await runPlaceReport({ geoid: '13121', deps: first })
    const asksBefore = fakeAsk.mock.calls.length
    const second = deps()
    const again = await runPlaceReport({ geoid: '13121', deps: second })
    expect(again.cached).toBe(true)
    // Nothing ran the second time: no agency, no model, no tokens.
    expect(second.fetchForPlace).not.toHaveBeenCalled()
    expect(fakeAsk.mock.calls.length).toBe(asksBefore)
  })

  it('refresh: true runs it again and refreshes the slices too', async () => {
    await runPlaceReport({ geoid: '13121', deps: deps() })
    const second = deps()
    const again = await runPlaceReport({ geoid: '13121', refresh: true, deps: second })
    expect(again.cached).toBe(false)
    expect(second.fetchForPlace).toHaveBeenCalled()
    expect((second.fetchForPlace as any).mock.calls[0][0].refresh).toBe(true)
  })

  it('a report narrowed to some sources is neither served from nor saved to the cache', async () => {
    const filtered = deps()
    const one = await runPlaceReport({ geoid: '13121', sources: ['epa-superfund-npl'], deps: filtered })
    expect(one.report.sections).toHaveLength(1)
    expect(fake.objects.has('library/derived/place/g13121.json')).toBe(false)
    const full = deps()
    const all = await runPlaceReport({ geoid: '13121', deps: full })
    expect(all.cached).toBe(false)
    expect(all.report.sections.length).toBeGreaterThan(1)
  })

  // P6-4: the index beside the cache — the six lines "recent analyses" reads.
  it('records who ran it and when, beside the cache rather than inside it', async () => {
    await runPlaceReport({ geoid: '13121', actor: { id: 1, username: 'maria' }, deps: deps() })
    const entries = await listPlaceReports()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ placeKey: 'g13121', by: 'maria', found: 2 })
    expect(entries[0].label).toContain('Fulton')
    expect(entries[0].at).toBe((await readPlaceReport('g13121'))?.generatedAt)
  })

  it('does not record a report narrowed to some sources — that is a slice, not an analysis', async () => {
    await runPlaceReport({ geoid: '13121', sources: ['epa-superfund-npl'], actor: { id: 1, username: 'maria' }, deps: deps() })
    expect(await listPlaceReports()).toEqual([])
  })

  it('rebuilds the index at reindex, so a report that has gone leaves the list', async () => {
    await runPlaceReport({ geoid: '13121', actor: { id: 1, username: 'maria' }, deps: deps() })
    expect(await listPlaceReports()).toHaveLength(1)
    fake.objects.delete('library/derived/place/g13121.json')
    await reindexCatalog()
    // The hook is launched detached; this is the handle on it.
    await placeReportIndexSettled()
    expect(await listPlaceReports()).toEqual([])
  })

  it('is stale after a week', () => {
    const now = Date.now()
    const doc = { generatedAt: new Date(now).toISOString(), sections: [] } as unknown as PlaceReport
    expect(isReportFresh(doc, now)).toBe(true)
    expect(isReportFresh(doc, now + (REPORT_TTL_DAYS * 24 - 1) * 3600_000)).toBe(true)
    expect(isReportFresh(doc, now + (REPORT_TTL_DAYS * 24 + 1) * 3600_000)).toBe(false)
    expect(isReportFresh({ generatedAt: 'nonsense', sections: [] } as unknown as PlaceReport, now)).toBe(false)
  })
})

// --- What the model is shown -------------------------------------------------

describe('the summary', () => {
  const base = {
    place: { label: '123 Peach St', lat: ATLANTA.lat, lng: ATLANTA.lng, geoid: '13121', county: 'Fulton County', state: 'Georgia' },
    radiusMiles: 5,
    county: {
      geoid: '13121',
      name: 'Fulton County',
      state: 'Georgia',
      layers: [{ id: 'pct_Black', name: 'Percent Black', value: 44.5, formatted: '44.5%', direction: 'higher_better' }],
    },
    organizations: [{ name: 'Peachtree Land Trust', distanceMiles: 1.2, href: '/library/organizations?tab=data&q=x' }],
    generatedAt: new Date().toISOString(),
  }

  const sections: ReportSection[] = [
    {
      slug: 'epa-superfund-npl',
      title: 'EPA Superfund NPL sites',
      provider: 'US EPA',
      status: 'found',
      count: 9,
      columns: ['Site_Name', 'Status'],
      rows: Array.from({ length: REPORT_ROWS }, (_, i) => ({ Site_Name: `Site ${i + 1}`, Status: 'Final' })),
      cacheKey: 'p1',
      href: '/library/epa-superfund-npl?place=p1',
    },
    { slug: 'georgia-epd-ust', title: 'USTs', provider: 'Georgia EPD', status: 'none', count: 0, columns: [], rows: [], href: '/library/georgia-epd-ust' },
    { slug: 'fulton-assessor', title: 'Parcels', provider: 'Fulton County', status: 'skipped', count: 0, columns: [], rows: [], href: '/library/fulton-assessor', reason: 'Ask the assessor.' },
    { slug: 'fema-nri', title: 'NRI', provider: 'FEMA', status: 'failed', count: 0, columns: [], rows: [], href: '/library/fema-nri', reason: 'the agency’s server refused the request.' },
  ]

  it('numbers every section, empty ones included, with five rows on the found one', () => {
    const excerpts = summaryExcerpts({ ...base, sections })
    expect(excerpts.map(e => e.slug)).toEqual([
      'epa-superfund-npl',
      'georgia-epd-ust',
      'fulton-assessor',
      'fema-nri',
      'county:13121',
      'organizations',
    ])
    const npl = excerpts[0]
    expect(npl.text).toContain('9 results within 5 miles of 123 Peach St')
    expect(npl.text.match(/Site_Name:/g)).toHaveLength(SUMMARY_ROWS)
    expect(npl.href).toBe('/library/epa-superfund-npl?place=p1')
    // "Nothing here" is half the answer to "what are the risks".
    expect(excerpts[1].text).toContain('nothing within 5 miles')
    expect(excerpts[2].text).toContain('Ask the assessor.')
    expect(excerpts[3].text).toContain('refused the request')
    expect(excerpts[4].text).toContain('Percent Black: 44.5%')
    expect(excerpts[4].href).toBe('/compare?counties=13121&layers=pct_Black')
    expect(excerpts[5].text).toContain('Peachtree Land Trust — 1.2 miles')
  })

  it('asks the question the ticket words, with the tool loop off', async () => {
    const { report } = await runPlaceReport({
      point: ATLANTA,
      geoid: '13121',
      deps: {
        fetchForPlace: fakeFetcher({ 'epa-superfund-npl': 2, 'georgia-epd-ust': 0, 'fema-nri': 1 }).fn,
        countyValues: fakeCountyValues,
        ask: fakeAsk,
      },
    })
    expect(fakeAsk).toHaveBeenCalledTimes(1)
    const options = fakeAsk.mock.calls[0][0]
    expect(options.question).toBe(summaryQuestion(report.place.label))
    expect(options.question).toMatch(/^What are the environmental and land risks for .+\? Answer as a short report\.$/)
    // placeContext is what turns the tool loop off in askKb — passing it IS
    // the switch, so its presence is the assertion.
    expect(options.placeContext.length).toBeGreaterThan(0)
    expect(options.dataset).toBeUndefined()
    expect(report.summary?.text).toContain('Two Superfund sites')
    expect(report.summary?.sources).toEqual([
      { n: 1, title: 'EPA Superfund NPL sites', href: '/library/epa-superfund-npl?place=x' },
      { n: 3, title: 'Fulton County', href: '/compare?counties=13121' },
    ])
  })

  it('still returns the findings when the model is unavailable', async () => {
    const broken = vi.fn(async () => {
      throw new Error('no api key')
    }) as any
    const { report } = await runPlaceReport({
      geoid: '13121',
      deps: { fetchForPlace: fakeFetcher({ 'epa-superfund-npl': 1 }).fn, countyValues: fakeCountyValues, ask: broken },
    })
    expect(report.summary).toBeNull()
    expect(report.sections.length).toBeGreaterThan(0)
  })
})

// --- The small pieces --------------------------------------------------------

describe('presentation helpers', () => {
  it('formats a layer value by its data type', () => {
    const layer = (dataType: string) => ({ dataType, id: 'x', name: 'X' }) as any
    expect(formatLayerValue(layer('currency'), 380000)).toBe('$380,000')
    expect(formatLayerValue(layer('percentage'), 44.53)).toBe('44.5%')
    expect(formatLayerValue(layer('years'), 74.24)).toBe('74.2 yrs')
    expect(formatLayerValue(layer('index'), 3.276)).toBe('3.28')
    expect(formatLayerValue(layer('count'), 12345)).toBe('12,345')
    expect(formatLayerValue(layer('count'), null)).toBe('—')
    expect(formatLayerValue(layer('count'), 'n/a')).toBe('n/a')
  })

  it('builds the compare link for the county card', () => {
    expect(compareHref('13121', ['pct_Black', 'life_expectancy'])).toBe('/compare?counties=13121&layers=pct_Black%2Clife_expectancy')
    expect(compareHref('13121', [])).toBe('/compare?counties=13121')
  })

  it('sorts sections found → none → skipped → timeout → failed, then by title', () => {
    const s = (title: string, status: ReportSection['status']): ReportSection => ({
      slug: title, title, provider: 'p', status, count: 0, rows: [], columns: [], href: '/x',
    })
    expect(
      sortSections([s('b', 'failed'), s('a', 'none'), s('d', 'found'), s('c', 'found'), s('e', 'timeout'), s('f', 'skipped')]).map(x => x.title),
    ).toEqual(['c', 'd', 'a', 'f', 'e', 'b'])
  })

  it('refuses a place key that would escape the derived folder', () => {
    expect(() => reportKey('../../secrets')).toThrow()
  })

  it('finds the point dataset by its layer block, not by slug', async () => {
    const dataset = await findPointDataset()
    expect(dataset).toMatchObject({ slug: 'organizations', latKey: 'lat', lngKey: 'lng', labelKey: 'Name' })
  })

  it('caps the organizations list', async () => {
    const many = ['Name,Tier,lat,lng']
    for (let i = 0; i < ORGANIZATIONS_MAX + 5; i++) many.push(`Org ${i},Tier 1,${33.75 + i / 1000},-84.39`)
    fake.seed('library/datasets/organizations/organizations.csv', many.join('\n'))
    await reindexCatalog()
    const dataset = await findPointDataset()
    const near = await nearbyOrganizations(ATLANTA, dataset!)
    expect(near).toHaveLength(ORGANIZATIONS_MAX)
    expect(near[0].name).toBe('Org 0')
  })

  it('reads county values through the county_values reader', async () => {
    const card = await countyCard('13121', fakeCountyValues)
    expect(fakeCountyValues).toHaveBeenCalled()
    expect(card.name).toBe('Fulton County')
    expect(card.layers.every(l => l.value !== null)).toBe(true)
  })
})

// --- The real readers --------------------------------------------------------

describe('the county card against the real registry', () => {
  it('reads a real county through the same reader county_values uses', async () => {
    // No fake here on purpose: this is the wiring between P5-45's registry +
    // CSV/JSON reader and the report's card. Fulton County is in every file.
    const card = await countyCard('13121')
    expect(card).toMatchObject({ geoid: '13121', name: 'Fulton County', state: 'Georgia' })
    expect(card.layers.length).toBeGreaterThan(3)
    for (const layer of card.layers) {
      expect(layer.value).not.toBeNull()
      expect(layer.formatted).not.toBe('')
      expect(['higher_better', 'lower_better']).toContain(layer.direction)
    }
    // The layer ids are the map's own, so "Compare" opens the same columns.
    expect(card.layers.map(l => l.id)).toContain('pct_Black')
  })
})

/**
 * The one test that talks to the real internet, and only when asked:
 *
 *   PLACE_FETCH_LIVE=1 npx vitest run src/services/placeReport.test.ts
 *
 * It runs a real report for an Atlanta address against the real bucket and
 * the real agencies. It asserts the SHAPE, not the contents — a public
 * agency's row count is not ours to pin — and it skips the model, because a
 * live check of the fetch pipeline should not depend on an API key.
 */
const live = process.env.PLACE_FETCH_LIVE === '1' ? describe : describe.skip
live('live (PLACE_FETCH_LIVE=1)', () => {
  it('reports on a real Atlanta address', { timeout: 180_000 }, async () => {
    const { report } = await runPlaceReport({
      address: '55 Trinity Ave SW, Atlanta, GA 30303',
      radiusMiles: 5,
      deps: { ask: (async () => { throw new Error('summary skipped in the live check') }) as any },
    })
    expect(report.place.lat).toBeCloseTo(33.75, 1)
    expect(report.place.geoid).toBe('13121')
    expect(report.place.state).toBe('Georgia')
    expect(report.sections.length).toBeGreaterThan(0)
    for (const section of report.sections) {
      expect(['found', 'none', 'skipped', 'failed', 'timeout']).toContain(section.status)
      expect(section.href).toMatch(/^\/library\//)
      if (section.status === 'found') expect(section.rows.length).toBeGreaterThan(0)
      else expect(section.rows).toEqual([])
    }
    expect(report.county?.layers.length).toBeGreaterThan(0)
    // eslint-disable-next-line no-console
    console.log(
      `[live] ${report.sections.filter(s => s.status === 'found').length} of ${report.sections.length} sources found something for ${report.place.label}`,
    )
  })
})
