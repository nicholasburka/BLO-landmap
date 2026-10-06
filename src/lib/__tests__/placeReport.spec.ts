import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The place report's client half (P5-58): URL state, the plain-language
 * status of a section, the report as markdown and as a CSV, and where a `[n]`
 * in the summary points. All of it is pure except the four functions that
 * talk to the server, which are exercised against a stubbed `internalFetch`.
 */
vi.mock('@/lib/apiBase', () => ({ internalFetch: vi.fn() }))
vi.mock('@/lib/libraryCatalog', () => ({ createNoteEntry: vi.fn() }))
vi.mock('@/lib/wiki', () => ({
  fetchWikiPage: vi.fn(),
  saveWikiPage: vi.fn(),
  WikiConflictError: class WikiConflictError extends Error {},
}))

import { internalFetch } from '@/lib/apiBase'
import { createNoteEntry } from '@/lib/libraryCatalog'
import { fetchWikiPage, saveWikiPage } from '@/lib/wiki'
import {
  addReportToPage,
  citationTarget,
  compareUrlFor,
  describeTally,
  directionCue,
  fetchPlaceReport,
  fetchPlaceReports,
  mapUrlFor,
  parsePlaceUrl,
  placeErrorMessage,
  placeUrl,
  placeUrlFor,
  placeUrlForKey,
  PlaceReportError,
  advanceProgress,
  freshnessPhrase,
  groupCountLine,
  initialProgress,
  progressNote,
  progressSentence,
  readMapCentre,
  reportCsv,
  reportCsvFilename,
  reportGroups,
  reportNoteMarkdown,
  reportSectionMarkdown,
  reportTally,
  reportVerdict,
  requestFromUrl,
  runPlaceReport,
  saveReportAsNote,
  statusPhrase,
  MAP_CENTRE_KEY,
  NDJSON_TYPE,
  QUIET_NONE,
  QUIET_UNCHECKED,
  STREAM_CUT_TEXT,
  type PlaceProgress,
  type PlaceProgressEvent,
  type PlaceReport,
  type ReportSection,
} from '@/lib/placeReport'

const mockedFetch = vi.mocked(internalFetch)
const mockedNote = vi.mocked(createNoteEntry)
const mockedPage = vi.mocked(fetchWikiPage)
const mockedSave = vi.mocked(saveWikiPage)

function section(over: Partial<ReportSection> = {}): ReportSection {
  return {
    slug: 'epa-superfund-npl',
    title: 'EPA Superfund NPL sites',
    provider: 'US EPA',
    status: 'found',
    count: 3,
    rows: [{ Site_Name: 'Lakewood Landfill', Status: 'Final' }],
    columns: ['Site_Name', 'Status'],
    cacheKey: 'p33.7490_-84.3880_r5',
    href: '/library/epa-superfund-npl?place=p33.7490_-84.3880_r5',
    ...over,
  }
}

const REPORT: PlaceReport = {
  place: {
    label: '55 Trinity Ave SW, Atlanta, GA',
    lat: 33.749,
    lng: -84.388,
    geoid: '13121',
    county: 'Fulton County',
    state: 'Georgia',
  },
  radiusMiles: 5,
  sections: [
    section(),
    section({ slug: 'georgia-epd-ust', title: 'USTs', provider: 'Georgia EPD', status: 'none', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/georgia-epd-ust' }),
    section({ slug: 'fulton-assessor', title: 'Parcels', provider: 'Fulton County', status: 'skipped', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/fulton-assessor', reason: 'Ask the assessor for a parcel export.' }),
    section({ slug: 'fema-nri', title: 'Risk Index', provider: 'FEMA', status: 'failed', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/fema-nri', reason: 'the agency’s server refused the request.' }),
    section({ slug: 'slow-one', title: 'Slow One', provider: 'State', status: 'timeout', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/slow-one', reason: 'we ran out of time.' }),
  ],
  county: {
    geoid: '13121',
    name: 'Fulton County',
    state: 'Georgia',
    layers: [
      { id: 'pct_Black', name: 'Percent Black', value: 44.5, formatted: '44.5%', direction: 'higher_better' },
      { id: 'median_home_value', name: 'Median home value', value: 380000, formatted: '$380,000', direction: 'lower_better' },
    ],
  },
  organizations: [{ name: 'Peachtree Land Trust', distanceMiles: 1.2, href: '/library/organizations?tab=data&q=Peachtree%20Land%20Trust' }],
  summary: {
    text: 'Three Superfund sites sit within five miles [1]. The county is 44.5% Black [6].',
    sources: [
      { n: 1, title: 'EPA Superfund NPL sites', href: '/library/epa-superfund-npl?place=p33.7490_-84.3880_r5' },
      { n: 6, title: 'Fulton County, Georgia — county numbers', href: '/compare?counties=13121&layers=pct_Black,median_home_value' },
      { n: 9, title: 'Heirs property in Georgia', href: '/wiki/heirs-property' },
    ],
  },
  generatedAt: '2026-09-06T12:00:00.000Z',
  placeKey: 'p33.7490_-84.3880_r5',
  cached: false,
}

beforeEach(() => {
  mockedFetch.mockReset()
  mockedNote.mockReset()
  mockedPage.mockReset()
  mockedSave.mockReset()
})

// --- The URL -----------------------------------------------------------------

describe('the URL is the state', () => {
  it('reads all three ways of naming a place, plus the radius', () => {
    expect(parsePlaceUrl({ address: '55 Trinity Ave' })).toMatchObject({ address: '55 Trinity Ave', lat: null, geoid: '' })
    expect(parsePlaceUrl({ lat: '33.749', lng: '-84.388', radius: '10' })).toMatchObject({ lat: 33.749, lng: -84.388, radius: 10 })
    expect(parsePlaceUrl({ geoid: '13121' }).geoid).toBe('13121')
  })

  it('drops anything malformed rather than throwing — a hand-edited link opens the form', () => {
    const state = parsePlaceUrl({ lat: 'north', lng: '-84.388', geoid: '131', radius: '-3' })
    expect(state).toEqual({ address: '', lat: null, lng: -84.388, geoid: '', radius: null, set: '' })
    expect(parsePlaceUrl({ lat: '900', lng: '0' }).lat).toBeNull()
    expect(parsePlaceUrl({ radius: '5000' }).radius).toBeNull()
    expect(requestFromUrl(state)).toBeNull()
  })

  it('takes the first value when a param is repeated', () => {
    expect(parsePlaceUrl({ geoid: ['13121', '47157'] }).geoid).toBe('13121')
  })

  it('writes the URL back, one way of naming a place at a time', () => {
    expect(placeUrl({ address: '55 Trinity Ave', radius: 5 })).toBe('/place?address=55+Trinity+Ave&radius=5')
    expect(placeUrl({ lat: 33.749, lng: -84.388 })).toBe('/place?lat=33.749&lng=-84.388')
    expect(placeUrl({ geoid: '13121' })).toBe('/place?geoid=13121')
    expect(placeUrl({})).toBe('/place')
  })

  it('turns a URL into the request the server takes', () => {
    expect(requestFromUrl(parsePlaceUrl({ address: 'x', radius: '3' }))).toEqual({ address: 'x', radiusMiles: 3 })
    expect(requestFromUrl(parsePlaceUrl({ lat: '1', lng: '2' }))).toEqual({ point: { lat: 1, lng: 2 } })
    expect(requestFromUrl(parsePlaceUrl({ geoid: '13121' }))).toEqual({ geoid: '13121' })
  })

  /**
   * P7-1: the scope is part of the URL, so a report asked inside a working set
   * is a link somebody can be sent — and the scope survives changing the
   * place, because which datasets to ask is a different question from where.
   */
  it('reads and writes the working set the run is scoped to', () => {
    expect(parsePlaceUrl({ geoid: '13121', set: 'memphis-redevelopment' }).set).toBe('memphis-redevelopment')
    expect(placeUrl({ geoid: '13121', set: 'memphis-redevelopment' })).toBe(
      '/place?geoid=13121&set=memphis-redevelopment',
    )
    // Not a slug: dropped to the whole library rather than sent on to the
    // report route, like everything else read out of this URL.
    expect(parsePlaceUrl({ geoid: '13121', set: 'Not A Slug!' }).set).toBe('')
    expect(parsePlaceUrl({ geoid: '13121' }).set).toBe('')
  })

  it('puts the scope on the request, however the place was named', () => {
    const scope = { workingSet: 'memphis-redevelopment' }
    expect(requestFromUrl(parsePlaceUrl({ address: 'x', set: 'memphis-redevelopment' }))).toEqual({
      address: 'x',
      ...scope,
    })
    expect(requestFromUrl(parsePlaceUrl({ lat: '1', lng: '2', set: 'memphis-redevelopment' }))).toEqual({
      point: { lat: 1, lng: 2 },
      ...scope,
    })
    expect(requestFromUrl(parsePlaceUrl({ geoid: '13121', set: 'memphis-redevelopment' }))).toEqual({
      geoid: '13121',
      ...scope,
    })
    // And an unscoped run still sends no scope at all, exactly as before.
    expect(requestFromUrl(parsePlaceUrl({ geoid: '13121' }))).toEqual({ geoid: '13121' })
  })

  it('reopens a report at its own URL', () => {
    expect(placeUrlFor(REPORT)).toBe('/place?lat=33.749&lng=-84.388&radius=5')
    expect(placeUrlFor({ ...REPORT, place: { ...REPORT.place, lat: null, lng: null } })).toBe('/place?geoid=13121&radius=5')
  })
})

// --- Talking to the server ---------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

describe('the API client', () => {
  it('posts the request and returns the report', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(REPORT))
    const result = await runPlaceReport({ geoid: '13121', refresh: true })
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/place/report', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((mockedFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({ geoid: '13121', refresh: true })
    expect(result.placeKey).toBe('p33.7490_-84.3880_r5')
  })

  it('reads the last report back, and treats "none yet" as null rather than an error', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(REPORT))
    expect((await fetchPlaceReport('g13121'))?.place.geoid).toBe('13121')
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, 404))
    expect(await fetchPlaceReport('g99999')).toBeNull()
  })

  it('keeps the server’s own sentence and never shows a status code', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'A county code is five digits.' }, 400))
    await expect(runPlaceReport({ geoid: '1' })).rejects.toBeInstanceOf(PlaceReportError)
    expect(placeErrorMessage(new PlaceReportError(400, 'A county code is five digits.'))).toBe('A county code is five digits.')
    expect(placeErrorMessage(new PlaceReportError(0, 'offline'))).toContain('No connection')
    expect(placeErrorMessage(new PlaceReportError(401, ''))).toContain('Sign in again')
    expect(placeErrorMessage(new PlaceReportError(429, ''))).toContain('Wait a minute')
    expect(placeErrorMessage(new PlaceReportError(504, ''))).toContain('smaller radius')
    expect(placeErrorMessage(new Error('boom'))).toBe('Something went wrong. Please try again.')
    for (const status of [0, 400, 401, 403, 429, 503, 504, 502]) {
      expect(placeErrorMessage(new PlaceReportError(status, ''))).not.toMatch(/\d{3}/)
    }
  })

  it('reports a dropped connection as offline, not as a crash', async () => {
    mockedFetch.mockRejectedValue(new TypeError('failed to fetch'))
    await expect(runPlaceReport({ geoid: '13121' })).rejects.toMatchObject({ status: 0 })
  })

  // P6-4: the list behind "recent analyses" on /analysis.
  it('lists the reports we hold, and honours a limit', async () => {
    const rows = [{ placeKey: 'g13121', label: 'Fulton County, GA', by: 'nick', at: '2026-09-21T10:00:00Z', found: 4, sources: 12 }]
    mockedFetch.mockResolvedValue(jsonResponse({ reports: rows }))
    expect(await fetchPlaceReports()).toEqual(rows)
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/place/reports')
    await fetchPlaceReports(5)
    expect(mockedFetch).toHaveBeenLastCalledWith('/api/library/place/reports?limit=5')
  })

  it('treats a body with no reports in it as an empty list', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({}))
    expect(await fetchPlaceReports()).toEqual([])
  })
})

describe('reopening a cached report from its key (P6-4)', () => {
  it('turns a county key back into the /place URL that reopens it', () => {
    expect(placeUrlForKey('g13121')).toBe('/place?geoid=13121')
  })

  it('turns a point key back into its coordinates and radius', () => {
    expect(placeUrlForKey('p33.7490_-84.3880_r5')).toBe('/place?lat=33.749&lng=-84.388&radius=5')
    expect(placeUrlForKey('p-33.75_-84.39_r2.5')).toBe('/place?lat=-33.75&lng=-84.39&radius=2.5')
  })

  it('answers with nothing for a key that is not one', () => {
    for (const key of ['', 'nonsense', 'g131', '../../secrets']) expect(placeUrlForKey(key)).toBe('')
  })
})

// --- Saying what happened ----------------------------------------------------

describe('plain-language status', () => {
  it('says how many, or how far we looked, or what to do instead', () => {
    expect(statusPhrase(section({ count: 3 }), 5)).toBe('3 results within 5 miles')
    expect(statusPhrase(section({ count: 1 }), 5)).toBe('1 result within 5 miles')
    expect(statusPhrase(section({ status: 'none', count: 0 }), 5)).toBe('Nothing within 5 miles')
    expect(statusPhrase(section({ status: 'skipped', reason: 'Ask the assessor.' }), 5)).toBe('Check by hand: Ask the assessor.')
    expect(statusPhrase(section({ status: 'failed', reason: 'the server refused.' }), 5)).toBe('Could not check: the server refused.')
    expect(statusPhrase(section({ status: 'timeout' }), 5)).toBe('Could not check in time')
  })

  it('counts up the report in one line', () => {
    expect(reportTally(REPORT)).toEqual({ found: 1, none: 1, unchecked: 3 })
    expect(describeTally(REPORT)).toBe('1 of 5 sources found something · 1 found nothing · 3 could not be checked.')
  })


  it('uses the compare table’s words for direction', () => {
    expect(directionCue('lower_better')).toBe('lower is better')
    expect(directionCue('higher_better')).toBe('higher is better')
  })
})

describe('links out', () => {
  it('compares this county on the layers actually shown', () => {
    expect(compareUrlFor(REPORT.county!)).toBe('/compare?counties=13121&layers=pct_Black%2Cmedian_home_value')
    expect(compareUrlFor({ ...REPORT.county!, layers: [] })).toBe('/compare?counties=13121')
  })

  it('frames the map on the county the place sits in', () => {
    expect(mapUrlFor(REPORT)).toBe('/?fit=13121')
    expect(mapUrlFor({ ...REPORT, place: { ...REPORT.place, geoid: null } })).toBe('/')
  })

  it('points a citation at the card on this page, and only otherwise at a link', () => {
    expect(citationTarget(REPORT.summary!.sources[0], REPORT)).toEqual({ anchor: '#section-epa-superfund-npl' })
    // The server encodes the layer comma as %2C; matching on the county
    // rather than the whole string keeps the anchor working either way.
    expect(citationTarget(REPORT.summary!.sources[1], REPORT)).toEqual({ anchor: '#county' })
    expect(citationTarget({ title: 'c', href: compareUrlFor(REPORT.county!) }, REPORT)).toEqual({ anchor: '#county' })
    expect(citationTarget({ title: 'Orgs', href: REPORT.organizations[0].href }, REPORT)).toEqual({ anchor: '#organizations' })
    // A page retrieval found keeps its own link — it is not on this page.
    expect(citationTarget(REPORT.summary!.sources[2], REPORT)).toEqual({ href: '/wiki/heirs-property' })
  })
})

// --- Keeping it --------------------------------------------------------------

describe('the report as markdown', () => {
  it('writes the heading, the summary, a line per source, the county and the organizations', () => {
    const md = reportNoteMarkdown(REPORT)
    expect(md).toContain('# Place report: 55 Trinity Ave SW, Atlanta, GA')
    expect(md).toContain('## Summary')
    expect(md).toContain('Three Superfund sites sit within five miles [1].')
    expect(md).toContain('## Data sources checked')
    expect(md).toContain('- [EPA Superfund NPL sites](/library/epa-superfund-npl?place=p33.7490_-84.3880_r5) — 3 results within 5 miles')
    expect(md).toContain('— Nothing within 5 miles')
    expect(md).toContain('— Check by hand: Ask the assessor for a parcel export.')
    expect(md).toContain('## Fulton County, Georgia')
    expect(md).toContain('- Percent Black: 44.5% (higher is better)')
    expect(md).toContain('- Median home value: $380,000 (lower is better)')
    expect(md).toContain('[Compare this county](/compare?counties=13121&layers=pct_Black%2Cmedian_home_value)')
    expect(md).toContain('## Organizations nearby')
    expect(md).toContain('- [Peachtree Land Trust](/library/organizations?tab=data&q=Peachtree%20Land%20Trust) — 1.2 miles')
    // A snapshot needs a one-click way back to today's numbers.
    expect(md).toContain('[Run this report again](/place?lat=33.749&lng=-84.388&radius=5)')
  })

  it('drops to bold subheadings when it lands on somebody else’s page', () => {
    const md = reportSectionMarkdown(REPORT)
    expect(md.startsWith('## Place report:')).toBe(true)
    expect(md).toContain('**Summary**')
    expect(md).toContain('**Data sources checked**')
    expect(md).not.toContain('\n## Summary')
  })

  it('escapes brackets in a title so a link cannot close early', () => {
    const md = reportNoteMarkdown({ ...REPORT, sections: [section({ title: 'NPL [draft]' })] })
    expect(md).toContain('[NPL \\[draft\\]]')
  })

  it('leaves out the summary and the cards it has nothing for', () => {
    const md = reportNoteMarkdown({ ...REPORT, summary: null, county: null, organizations: [] })
    expect(md).not.toContain('Summary')
    expect(md).not.toContain('Organizations nearby')
    expect(md).toContain('Data sources checked')
  })

  it('files a saved report the way a saved answer is filed', async () => {
    mockedNote.mockResolvedValue({ slug: 'place-report-x', title: 'Place report' } as never)
    await saveReportAsNote(REPORT)
    expect(mockedNote).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'research', tags: ['ask'], title: expect.stringContaining('Place report:') }),
    )
    expect((mockedNote.mock.calls[0][0] as { body: string }).body).toContain('# Place report:')
  })

  it('appends to a page with the version it read, so a concurrent save is refused', async () => {
    mockedPage.mockResolvedValue({ slug: 'georgia', title: 'Georgia', markdown: '# Georgia\n\nNotes.', updatedAt: 'THEN' } as never)
    mockedSave.mockResolvedValue({ slug: 'georgia', title: 'Georgia' } as never)
    const result = await addReportToPage('georgia', REPORT)
    expect(mockedSave).toHaveBeenCalledWith('georgia', expect.stringContaining('## Place report:'), { ifUnmodifiedSince: 'THEN' })
    expect((mockedSave.mock.calls[0][1] as string).startsWith('# Georgia\n\nNotes.\n\n')).toBe(true)
    expect(result).toEqual({ slug: 'georgia', title: 'Georgia' })
  })

  it('refuses to append to a page that is gone', async () => {
    mockedPage.mockResolvedValue(null)
    await expect(addReportToPage('gone', REPORT)).rejects.toThrow(/no page named/)
    expect(mockedSave).not.toHaveBeenCalled()
  })
})

describe('the CSV', () => {
  it('is one row per source with its status, count, reason and link', () => {
    const csv = reportCsv(REPORT)
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('Source,Provider,Status,Count,Notes,Link')
    expect(lines).toHaveLength(6)
    expect(lines[1]).toBe('EPA Superfund NPL sites,US EPA,found,3,,/library/epa-superfund-npl?place=p33.7490_-84.3880_r5')
    expect(lines[2]).toBe('USTs,Georgia EPD,none,,,/library/georgia-epd-ust')
    expect(lines[3]).toContain('skipped,,Ask the assessor for a parcel export.')
  })

  it('quotes a field that carries a comma or a quote', () => {
    const csv = reportCsv({ ...REPORT, sections: [section({ title: 'NPL, "final"', reason: undefined })] })
    expect(csv).toContain('"NPL, ""final"""')
  })

  it('names the file after the place', () => {
    expect(reportCsvFilename(REPORT)).toBe('place-report-55-Trinity-Ave-SW-Atlanta-GA.csv')
    expect(reportCsvFilename({ ...REPORT, place: { ...REPORT.place, label: '' } })).toBe('place-report-place.csv')
  })
})

// --- The map's centre --------------------------------------------------------

describe('the map centre the form offers', () => {
  const store = (value: string | null) => ({ getItem: () => value }) as Pick<Storage, 'getItem'>

  it('reads a centre the map left behind', () => {
    expect(readMapCentre(store(JSON.stringify({ lat: 33.7, lng: -84.4 })))).toEqual({ lat: 33.7, lng: -84.4 })
    expect(MAP_CENTRE_KEY).toBe('blo:map-centre')
  })

  it('is null for nothing, junk, or a point off the earth — the button then does not appear', () => {
    expect(readMapCentre(store(null))).toBeNull()
    expect(readMapCentre(store('not json'))).toBeNull()
    expect(readMapCentre(store(JSON.stringify({ lat: 'north', lng: 0 })))).toBeNull()
    expect(readMapCentre(store(JSON.stringify({ lat: 900, lng: 0 })))).toBeNull()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- The shape of the report (P6-17) -----------------------------------------

/**
 * The real inventory this was measured against (a cached report for
 * `/place?lat=40.7785&lng=-73.9572&radius=5`, 2026-10-03): 40 sections — 12
 * found, 4 none, 22 skipped, 2 failed — under six topics, of which only five
 * contain anything found at all. The fixture below is that shape in miniature.
 */
function wideReport(): PlaceReport {
  return {
    ...REPORT,
    sections: [
      section({ slug: 'echo', title: 'EPA ECHO', topic: 'environment', count: 5000 }),
      section({ slug: 'npl', title: 'EPA Superfund NPL', topic: 'environment', count: 5 }),
      section({ slug: 'nfhl', title: 'FEMA flood zones', topic: 'hazards', count: 689 }),
      section({ slug: 'nri', title: 'FEMA National Risk Index', topic: 'hazards', count: 6 }),
      section({ slug: 'nwi', title: 'National Wetlands Inventory', topic: 'water', count: 241 }),
      // Nothing on the entry says what it is about — it still appears.
      section({ slug: 'mystery', title: 'Mystery source', topic: null, count: 2 }),
      quiet({ slug: 'ust', title: 'Georgia EPD USTs', topic: 'environment', status: 'none' }),
      quiet({ slug: 'nass', title: 'USDA NASS', topic: 'agriculture-and-food', status: 'none' }),
      quiet({ slug: 'assessor', title: 'Fulton parcels', topic: 'land', status: 'skipped', reason: 'Ask the assessor.' }),
      quiet({ slug: 'hand', title: 'A hand-published list', topic: 'agriculture-and-food', status: 'skipped', reason: 'published by hand.' }),
      quiet({ slug: 'refused', title: 'A refusing agency', topic: 'land', status: 'failed', reason: 'the server refused.' }),
      quiet({ slug: 'slow', title: 'A slow agency', topic: 'water', status: 'timeout' }),
    ],
  }
}

function quiet(over: Partial<ReportSection>): ReportSection {
  return section({ count: 0, rows: [], columns: [], cacheKey: undefined, ...over })
}

describe('the report in groups (P6-17)', () => {
  it('opens what was found under its topic and folds the rest behind one row each', () => {
    const groups = reportGroups(wideReport())
    expect(groups.map(g => [g.id, g.label, g.count, g.open])).toEqual([
      // `groupRows`' rule: heaviest heading first, the no-topic group last.
      ['environment', 'Environment', 2, true],
      ['hazards', 'Hazards', 2, true],
      ['water', 'Water', 1, true],
      ['', 'Everything else', 1, true],
      [QUIET_NONE, 'Nothing within 5 miles', 2, false],
      [QUIET_UNCHECKED, 'Could not be checked', 4, false],
    ])
    // 6 open cards instead of 12 — the whole of the cheap half of the ticket.
    const open = groups.filter(g => g.open).reduce((n, g) => n + g.count, 0)
    expect(open).toBe(6)
  })

  it('drops nothing between the flat list and the groups', () => {
    const report = wideReport()
    const groups = reportGroups(report)
    const grouped = groups.flatMap(g => g.rows.map(r => r.slug))
    expect(grouped.length).toBe(report.sections.length)
    expect([...grouped].sort()).toEqual(report.sections.map(s => s.slug).sort())
    // And each section appears exactly once.
    expect(new Set(grouped).size).toBe(report.sections.length)
    // A group's stated count is the number of rows it actually holds.
    for (const group of groups) expect(group.count).toBe(group.rows.length)
  })

  it('drops a topic that found nothing rather than heading an empty group', () => {
    // Agriculture has two sections in the fixture and neither one found
    // anything, so it is not a heading in the open part at all.
    expect(reportGroups(wideReport()).map(g => g.id)).not.toContain('agriculture-and-food')
  })

  it('heads a one-source report with one group and no summary rows', () => {
    const groups = reportGroups({ ...REPORT, sections: [section({ slug: 'only', topic: 'water' })] })
    expect(groups.map(g => [g.id, g.count])).toEqual([['water', 1]])
    expect(groups.every(g => g.open)).toBe(true)
  })

  it('still groups a report where nothing was found at all', () => {
    const groups = reportGroups({ ...REPORT, sections: [quiet({ slug: 'a', status: 'none' }), quiet({ slug: 'b', status: 'failed' })] })
    expect(groups.map(g => [g.id, g.open])).toEqual([
      [QUIET_NONE, false],
      [QUIET_UNCHECKED, false],
    ])
  })

  it('counts sources in words', () => {
    expect(groupCountLine(1)).toBe('1 source')
    expect(groupCountLine(24)).toBe('24 sources')
  })
})

describe('the verdict (P6-17)', () => {
  it('leads with what was found, from how many, and what stands out', () => {
    const verdict = reportVerdict(wideReport())
    expect(verdict.headline).toBe('6 of 12 sources found something within 5 miles.')
    // Ranked by what each source actually returned, every one a link to its
    // own card on the page.
    expect(verdict.standouts.map(s => s.title)).toEqual([
      'EPA ECHO',
      'FEMA flood zones',
      'National Wetlands Inventory',
      'FEMA National Risk Index',
      'EPA Superfund NPL',
    ])
    expect(verdict.standouts[0]).toMatchObject({ anchor: '#section-echo', phrase: '5,000 results within 5 miles' })
    expect(verdict.rest).toBe('2 found nothing · 4 could not be checked')
  })

  it('shows at most five, so the first screen stays an answer', () => {
    expect(reportVerdict(wideReport()).standouts).toHaveLength(5)
    expect(reportVerdict(wideReport(), 2).standouts.map(s => s.slug)).toEqual(['echo', 'nfhl'])
  })

  it('says so plainly when nothing was found', () => {
    const verdict = reportVerdict({ ...REPORT, sections: [quiet({ slug: 'a', status: 'none' })] })
    expect(verdict.headline).toBe('Nothing found within 5 miles, from 1 source.')
    expect(verdict.standouts).toEqual([])
    expect(verdict.rest).toBe('1 found nothing')
  })

  it('leaves the housekeeping line empty when there is none', () => {
    expect(reportVerdict({ ...REPORT, sections: [section()] }).rest).toBe('')
  })
})

// --- Cached or fresh (P6-26) -------------------------------------------------

describe('when the report was made (P6-26)', () => {
  const NOW = Date.parse('2026-09-10T12:00:00.000Z')

  it('says a cached copy is cached, how old it is, and on what date', () => {
    const phrase = freshnessPhrase({ ...REPORT, cached: true }, NOW)
    expect(phrase).toContain('Cached copy')
    expect(phrase).toContain('4d ago')
    // The same date the "Add to page" markdown prints, in the reader's locale.
    expect(phrase).toContain(new Date(REPORT.generatedAt).toLocaleDateString())
  })

  it('says a fresh run is a fresh run, and never calls it cached', () => {
    const phrase = freshnessPhrase({ ...REPORT, generatedAt: new Date(NOW).toISOString(), cached: false }, NOW)
    expect(phrase).toBe('Checked just now')
    expect(phrase).not.toContain('Cached')
  })

  it('distinguishes a re-run past the TTL from a cache read', () => {
    // A report older than REPORT_TTL_DAYS is re-run by the server, which
    // answers `cached: false` with today's timestamp — so the header reads as
    // a run rather than as a week-old copy.
    const eightDays = Date.parse('2026-09-14T12:00:00.000Z')
    const stale = { ...REPORT, generatedAt: '2026-09-06T12:00:00.000Z', cached: true }
    expect(freshnessPhrase(stale, eightDays)).toContain('Cached copy')
    const reran = { ...REPORT, generatedAt: new Date(eightDays).toISOString(), cached: false }
    expect(freshnessPhrase(reran, eightDays)).toBe('Checked just now')
  })

  it('does not invent a time it cannot read', () => {
    expect(freshnessPhrase({ ...REPORT, generatedAt: 'not a date', cached: true })).toBe('Cached copy')
  })
})

// --- Saying what the run is doing (P6-16) ------------------------------------

describe('the progress of a run (P6-16)', () => {
  const fold = (events: PlaceProgressEvent[], total = 0): PlaceProgress =>
    events.reduce(advanceProgress, initialProgress(total))

  it('names the source in flight, the count done and what has been found', () => {
    const state = fold([
      { type: 'start', total: 40 },
      { type: 'source', slug: 'echo', title: 'EPA ECHO' },
      { type: 'section', slug: 'npl', title: 'EPA Superfund NPL', status: 'found', done: 13, total: 40 },
    ])
    expect(progressSentence(state)).toBe('EPA ECHO · 13 of 40 checked · 1 found so far')
  })

  it('says how many it is about to check before anything has come back', () => {
    expect(progressSentence(fold([{ type: 'start', total: 40 }]))).toBe('Checking 40 sources…')
    expect(progressSentence(initialProgress(14))).toBe('Checking 14 sources…')
    expect(progressSentence(initialProgress())).toBe('Checking every data source we know about…')
  })

  it('only ever counts forward, however the pool settles', () => {
    const state = fold([
      { type: 'start', total: 40 },
      { type: 'section', slug: 'a', title: 'A', status: 'found', done: 14, total: 40 },
      // A straggler from earlier in the pool reports a lower count.
      { type: 'section', slug: 'b', title: 'B', status: 'found', done: 9, total: 40 },
    ])
    expect(state.done).toBe(14)
    expect(state.found).toBe(2)
  })

  it('says a source failed, and keeps going', () => {
    const state = fold([
      { type: 'start', total: 3 },
      { type: 'section', slug: 'nri', title: 'FEMA National Risk Index', status: 'failed', done: 1, total: 3 },
      { type: 'source', slug: 'echo', title: 'EPA ECHO' },
      { type: 'section', slug: 'echo', title: 'EPA ECHO', status: 'found', done: 2, total: 3 },
    ])
    expect(state.unchecked).toBe(1)
    expect(progressNote(state, 4)).toBe('4s · FEMA National Risk Index could not be checked')
    // The run carried on: the count moved and something was found after it.
    expect(progressSentence(state)).toBe('2 of 3 checked · 1 found so far')
  })

  it('counts an empty source as checked rather than as trouble', () => {
    const state = fold([{ type: 'section', slug: 'ust', title: 'USTs', status: 'none', done: 1, total: 2 }])
    expect([state.empty, state.unchecked, state.trouble]).toEqual([1, 0, ''])
  })

  it('says it is writing the summary rather than sitting at 40 of 40', () => {
    const state = fold([
      { type: 'start', total: 40 },
      { type: 'source', slug: 'echo', title: 'EPA ECHO' },
      { type: 'section', slug: 'echo', title: 'EPA ECHO', status: 'found', done: 40, total: 40 },
      { type: 'summary' },
    ])
    expect(progressSentence(state)).toBe('Writing the summary · 40 of 40 checked · 1 found so far')
    expect(state.current).toBe('')
  })

  it('keeps elapsed time as the second line, with the reason it is slow', () => {
    const state = fold([{ type: 'start', total: 40 }])
    expect(progressNote(state, 0)).toBe('')
    expect(progressNote(state, 3)).toBe('3s')
    expect(progressNote(state, 12)).toBe('12s · slow sources get up to 30 seconds each, so this can take a minute')
  })
})

describe('reading the progress stream (P6-16)', () => {
  /** A 200 whose body hands back exactly these chunks — split wherever the
   *  caller chose, including mid-line, which is the point of the parser. */
  function streamResponse(chunks: string[]): { res: Response; released: () => boolean } {
    const encoder = new TextEncoder()
    let sent = 0
    let released = false
    const reader = {
      read: async () =>
        sent < chunks.length ? { value: encoder.encode(chunks[sent++]), done: false } : { value: undefined, done: true },
      releaseLock: () => {
        released = true
      },
    }
    return {
      res: {
        ok: true,
        status: 200,
        headers: { get: () => `${NDJSON_TYPE}; charset=utf-8` },
        body: { getReader: () => reader },
      } as unknown as Response,
      released: () => released,
    }
  }

  it('asks for the stream only when somebody is listening', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(REPORT))
    await runPlaceReport({ geoid: '13121' })
    expect((mockedFetch.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Accept')
    const { res } = streamResponse([`{"type":"report","report":${JSON.stringify(REPORT)}}\n`])
    mockedFetch.mockResolvedValue(res)
    await runPlaceReport({ geoid: '13121' }, () => {})
    expect((mockedFetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({
      Accept: expect.stringContaining(NDJSON_TYPE),
    })
  })

  it('reports each event, then returns the report on the last line', async () => {
    const { res, released } = streamResponse([
      '{"type":"start","total":2}\n{"type":"source","slug":"echo","title":"EPA EC',
      'HO"}\n{"type":"section","slug":"echo","title":"EPA ECHO","status":"found","done":1,"total":2}\n',
      `{"type":"summary"}\n{"type":"report","report":${JSON.stringify(REPORT)}}\n`,
    ])
    mockedFetch.mockResolvedValue(res)
    const events: PlaceProgressEvent[] = []
    const report = await runPlaceReport({ geoid: '13121' }, e => events.push(e))
    expect(events.map(e => e.type)).toEqual(['start', 'source', 'section', 'summary'])
    expect(report.placeKey).toBe('p33.7490_-84.3880_r5')
    expect(released()).toBe(true)
  })

  it('takes a plain JSON answer when the report was cached, stream or not', async () => {
    // A cached report has no progress to report, so the route never opens a
    // stream: the content type decides, not what we asked for.
    mockedFetch.mockResolvedValue(jsonResponse({ ...REPORT, cached: true }))
    const events: PlaceProgressEvent[] = []
    const report = await runPlaceReport({ geoid: '13121' }, e => events.push(e))
    expect(report.cached).toBe(true)
    expect(events).toEqual([])
  })

  it('turns a refusal on the stream back into the status it would have been', async () => {
    const { res } = streamResponse(['{"type":"start","total":2}\n{"type":"error","status":504,"error":"That took too long."}\n'])
    mockedFetch.mockResolvedValue(res)
    await expect(runPlaceReport({ geoid: '13121' }, () => {})).rejects.toMatchObject({ status: 504 })
    expect(placeErrorMessage(new PlaceReportError(504, 'That took too long.'))).toBe('That took too long.')
  })

  it('skips a line it cannot read rather than failing the run', async () => {
    const { res } = streamResponse([
      '\n{not json}\n{"type":"who-knows"}\n{"type":"start","total":1}\n',
      `{"type":"report","report":${JSON.stringify(REPORT)}}`,
    ])
    mockedFetch.mockResolvedValue(res)
    const events: PlaceProgressEvent[] = []
    // The last line has no trailing newline, and is still read.
    await expect(runPlaceReport({ geoid: '13121' }, e => events.push(e))).resolves.toMatchObject({ placeKey: 'p33.7490_-84.3880_r5' })
    expect(events.map(e => e.type)).toEqual(['start'])
  })

  it('says so when the stream ends with neither a report nor a reason', async () => {
    const { res } = streamResponse(['{"type":"start","total":2}\n'])
    mockedFetch.mockResolvedValue(res)
    await expect(runPlaceReport({ geoid: '13121' }, () => {})).rejects.toMatchObject({ status: 502, message: STREAM_CUT_TEXT })
  })
})
