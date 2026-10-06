import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

/**
 * /place (P5-58): one address, every source that covers it.
 *
 * Only the network is faked — the report request, the catalog (for the
 * progress line and the page picker), the county lookup, and the two ways of
 * keeping a report. Everything the page is judged on (which URL runs what,
 * the order of the sections, the status wording, the citation anchors, the
 * CSV) is the real code running over those fakes.
 */
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: { value: { username: 'maria', role: 'internal' } } }),
  registerLogoutHook: vi.fn(),
}))

vi.mock('@/lib/placeReport', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/placeReport')>()),
  runPlaceReport: vi.fn(),
  saveReportAsNote: vi.fn(),
  addReportToPage: vi.fn(),
  readMapCentre: vi.fn(),
}))

vi.mock('@/lib/libraryCatalog', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/libraryCatalog')>()),
  fetchCatalog: vi.fn(),
}))

vi.mock('@/lib/compare', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/compare')>()),
  searchCounties: vi.fn(),
}))

// P7-1: the scope's name and its members, for the "11 instead of 40" line.
vi.mock('@/lib/workingSets', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/workingSets')>()),
  fetchWorkingSet: vi.fn(),
}))

import {
  addReportToPage,
  readMapCentre,
  reportCsv,
  runPlaceReport,
  saveReportAsNote,
  PlaceReportError,
  QUIET_NONE,
  QUIET_UNCHECKED,
  type PlaceProgressEvent,
  type PlaceReport,
  type ReportSection,
} from '@/lib/placeReport'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { searchCounties } from '@/lib/compare'
import { fetchWorkingSet, type WorkingSetDetail } from '@/lib/workingSets'
import PlaceView from '../PlaceView.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const mockedRun = vi.mocked(runPlaceReport)
const mockedNote = vi.mocked(saveReportAsNote)
const mockedAdd = vi.mocked(addReportToPage)
const mockedCentre = vi.mocked(readMapCentre)
const mockedCatalog = vi.mocked(fetchCatalog)
const mockedCounties = vi.mocked(searchCounties)
const mockedSet = vi.mocked(fetchWorkingSet)

function section(over: Partial<ReportSection> = {}): ReportSection {
  return {
    slug: 'epa-superfund-npl',
    title: 'EPA Superfund NPL sites',
    provider: 'US EPA',
    status: 'found',
    count: 3,
    rows: [
      { Site_Name: 'Lakewood Landfill', Status: 'Final' },
      { Site_Name: 'Peachtree Solvents', Status: 'Deleted' },
    ],
    columns: ['Site_Name', 'Status'],
    cacheKey: 'p33.7490_-84.3880_r5',
    href: '/library/epa-superfund-npl?place=p33.7490_-84.3880_r5',
    ...over,
  }
}

const REPORT: PlaceReport = {
  place: { label: '55 Trinity Ave SW', lat: 33.749, lng: -84.388, geoid: '13121', county: 'Fulton County', state: 'Georgia' },
  radiusMiles: 5,
  sections: [
    section(),
    section({ slug: 'georgia-epd-ust', title: 'USTs', provider: 'Georgia EPD', status: 'none', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/georgia-epd-ust' }),
    section({ slug: 'fulton-assessor', title: 'Parcels', provider: 'Fulton County', status: 'skipped', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/fulton-assessor', reason: 'Ask the assessor.' }),
    section({ slug: 'fema-nri', title: 'Risk Index', provider: 'FEMA', status: 'failed', count: 0, rows: [], columns: [], cacheKey: undefined, href: '/library/fema-nri', reason: 'the server refused.' }),
  ],
  county: {
    geoid: '13121',
    name: 'Fulton County',
    state: 'Georgia',
    layers: [{ id: 'pct_Black', name: 'Percent Black', value: 44.5, formatted: '44.5%', direction: 'higher_better' }],
  },
  organizations: [{ name: 'Peachtree Land Trust', distanceMiles: 1.2, href: '/library/organizations?tab=data&q=Peachtree' }],
  summary: {
    text: 'Three Superfund sites sit within five miles [1].',
    sources: [
      { n: 1, title: 'EPA Superfund NPL sites', href: '/library/epa-superfund-npl?place=p33.7490_-84.3880_r5' },
      { n: 9, title: 'Heirs property', href: '/wiki/heirs-property' },
    ],
  },
  generatedAt: '2026-09-06T12:00:00.000Z',
  placeKey: 'p33.7490_-84.3880_r5',
  cached: false,
}

let router: Router
async function mountPlace(query = 'address=55+Trinity+Ave+SW') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.replace(`/place${query ? `?${query}` : ''}`)
  await router.isReady()
  const wrapper = mount(PlaceView, { global: { plugins: [router] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedRun.mockResolvedValue(REPORT)
  mockedCatalog.mockResolvedValue([])
  mockedCounties.mockResolvedValue([])
  mockedCentre.mockReturnValue(null)
  mockedSet.mockResolvedValue(null)
})

describe('the form', () => {
  it('opens empty with nothing checked, and runs nothing', async () => {
    const wrapper = await mountPlace('')
    expect(wrapper.find('[data-testid="place-empty"]').text()).toContain('Nothing checked yet')
    expect(mockedRun).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="place-address"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="place-county-search"]').exists()).toBe(true)
  })

  it('seeds itself from the URL, so a link opens with its own values in it', async () => {
    const wrapper = await mountPlace('address=55+Trinity+Ave+SW&radius=12')
    expect((wrapper.find('[data-testid="place-address"]').element as HTMLInputElement).value).toBe('55 Trinity Ave SW')
    expect((wrapper.find('[data-testid="place-radius"]').element as HTMLInputElement).value).toBe('12')
  })

  it('runs an ?address= link on load without anyone pressing Run (P5-65)', async () => {
    // The landing's address box submits to /place?address=… (P5-68): the page
    // opens with the address in the box and the report already running.
    const wrapper = await mountPlace('address=55+Trinity+Ave+SW')
    expect((wrapper.find('[data-testid="place-address"]').element as HTMLInputElement).value).toBe('55 Trinity Ave SW')
    expect(mockedRun).toHaveBeenCalledTimes(1)
    expect(mockedRun).toHaveBeenCalledWith({ address: '55 Trinity Ave SW' }, expect.any(Function))
    expect(wrapper.find('[data-testid="place-empty"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="place-sections"]').exists()).toBe(true)
  })

  it('runs from an address, a point and a county alike', async () => {
    await mountPlace('address=55+Trinity+Ave+SW')
    expect(mockedRun).toHaveBeenCalledWith({ address: '55 Trinity Ave SW' }, expect.any(Function))
    await mountPlace('lat=33.749&lng=-84.388&radius=10')
    expect(mockedRun).toHaveBeenLastCalledWith({ point: { lat: 33.749, lng: -84.388 }, radiusMiles: 10 }, expect.any(Function))
    await mountPlace('geoid=13121')
    expect(mockedRun).toHaveBeenLastCalledWith({ geoid: '13121' }, expect.any(Function))
  })

  it('typing an address and pressing Run puts it in the URL', async () => {
    const wrapper = await mountPlace('')
    await wrapper.find('[data-testid="place-address"]').setValue('123 Peach St')
    await wrapper.find('[data-testid="place-form"] form').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/place?address=123+Peach+St&radius=5')
  })

  it('picking a county from the search puts its GEOID in the URL', async () => {
    mockedCounties.mockResolvedValue([{ geoId: '13121', county: 'Fulton County', state: 'Georgia' }])
    const wrapper = await mountPlace('')
    await wrapper.find('[data-testid="place-county-search"]').setValue('Fulton')
    await flushPromises()
    const match = wrapper.find('[data-testid="place-county-match"]')
    expect(match.text()).toContain('Fulton County, Georgia')
    await match.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/place?geoid=13121&radius=5')
  })

  it('hides "use the map\'s centre" when the map has not said where it is', async () => {
    expect((await mountPlace('')).find('[data-testid="place-map-centre"]').exists()).toBe(false)
    mockedCentre.mockReturnValue({ lat: 33.7, lng: -84.4 })
    const wrapper = await mountPlace('')
    expect(wrapper.find('[data-testid="place-map-centre"]').exists()).toBe(true)
    await wrapper.find('[data-testid="place-map-centre"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/place?lat=33.7&lng=-84.4&radius=5')
  })
})

describe('while it runs', () => {
  it('says how many sources it is checking', async () => {
    mockedCatalog.mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({ slug: `s${i}` }) as never))
    let release: (r: PlaceReport) => void = () => {}
    mockedRun.mockReturnValue(new Promise<PlaceReport>(resolve => { release = resolve }))
    const wrapper = await mountPlace()
    expect(wrapper.find('[data-testid="place-progress"]').text()).toBe('Checking 14 sources…')
    release(REPORT)
    await flushPromises()
    expect(wrapper.find('[data-testid="place-progress"]').exists()).toBe(false)
  })

  /**
   * P6-16: the page used to show a seconds counter and nothing else. It now
   * reports what the run reports — the source in flight, a done-of-total count
   * and what has been found — because the run has always known all three.
   */
  it('says what it is doing as the run says it', async () => {
    let say: (e: PlaceProgressEvent) => void = () => {}
    let release: (r: PlaceReport) => void = () => {}
    mockedRun.mockImplementation((_req, onProgress) => {
      say = onProgress ?? (() => {})
      return new Promise<PlaceReport>(resolve => { release = resolve })
    })
    const wrapper = await mountPlace()
    const line = () => wrapper.find('[data-testid="place-progress"]').text()

    say({ type: 'start', total: 40 })
    await flushPromises()
    expect(line()).toContain('Checking 40 sources…')

    say({ type: 'source', slug: 'echo', title: 'EPA ECHO' })
    await flushPromises()
    expect(line()).toContain('EPA ECHO')

    say({ type: 'section', slug: 'echo', title: 'EPA ECHO', status: 'found', done: 14, total: 40 })
    await flushPromises()
    expect(line()).toContain('14 of 40 checked')
    expect(line()).toContain('1 found so far')

    // A source that fails says so, and the run carries on.
    say({ type: 'section', slug: 'nri', title: 'FEMA NRI', status: 'failed', done: 15, total: 40 })
    await flushPromises()
    expect(wrapper.find('[data-testid="place-progress-note"]').text()).toContain('FEMA NRI could not be checked')
    expect(line()).toContain('15 of 40 checked')

    say({ type: 'summary' })
    await flushPromises()
    expect(line()).toContain('Writing the summary')

    // And when it is done the progress area is gone, counter and all.
    release(REPORT)
    await flushPromises()
    expect(wrapper.find('[data-testid="place-progress"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="place-verdict"]').exists()).toBe(true)
  })

  it('reads the progress aloud without stealing focus', async () => {
    mockedRun.mockReturnValue(new Promise<PlaceReport>(() => {}))
    const wrapper = await mountPlace()
    const progress = wrapper.get('[data-testid="place-progress"]')
    expect(progress.attributes('role')).toBe('status')
    expect(progress.attributes('aria-live')).toBe('polite')
  })

  it('counts only the sources a report can run or list, when the rows say so', async () => {
    mockedCatalog.mockResolvedValue([
      { slug: 'a', readiness: { as: 'source', placeReport: 'runs', notes: [] } },
      { slug: 'b', readiness: { as: 'source', placeReport: 'by-hand', notes: [] } },
      { slug: 'c', readiness: { as: 'source', placeReport: 'never', notes: [] } },
    ] as never)
    mockedRun.mockReturnValue(new Promise<PlaceReport>(() => {}))
    const wrapper = await mountPlace()
    expect(wrapper.find('[data-testid="place-progress"]').text()).toBe('Checking 2 sources…')
  })

  it('disables Run while a report is in flight, so a second press cannot restart the clock', async () => {
    mockedRun.mockReturnValue(new Promise<PlaceReport>(() => {}))
    const wrapper = await mountPlace()
    expect(wrapper.find('[data-testid="place-run"]').attributes('disabled')).toBeDefined()
  })

  it('keeps the clock as a second line, and leaves none running afterwards', async () => {
    vi.useFakeTimers()
    try {
      mockedCatalog.mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({ slug: `s${i}` }) as never))
      let release: (r: PlaceReport) => void = () => {}
      mockedRun.mockReturnValue(new Promise<PlaceReport>(resolve => { release = resolve }))
      const wrapper = await mountPlace()
      await vi.advanceTimersByTimeAsync(3000)
      // The first line says what it is doing; the clock is underneath it.
      expect(wrapper.find('[data-testid="place-progress"]').text()).toContain('Checking 14 sources…')
      expect(wrapper.find('[data-testid="place-progress-note"]').text()).toBe('3s')
      await vi.advanceTimersByTimeAsync(9000)
      expect(wrapper.find('[data-testid="place-progress-note"]').text()).toContain('12s · slow sources get up to 30 seconds each')
      release(REPORT)
      await vi.advanceTimersByTimeAsync(0)
      await flushPromises()
      expect(wrapper.find('[data-testid="place-progress"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="place-rerun"]').attributes('disabled')).toBeUndefined()
      // No counter is left running once the report is on the page.
      await vi.advanceTimersByTimeAsync(5000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says a failure in plain words, with no status code', async () => {
    mockedRun.mockRejectedValue(new PlaceReportError(504, 'the agency’s server took too long. Try a smaller radius.'))
    const wrapper = await mountPlace()
    const text = wrapper.find('[data-testid="place-error"]').text()
    expect(text).toContain('smaller radius')
    expect(text).not.toMatch(/504/)
  })
})

describe('the report', () => {
  it('shows the summary with citations that point at the cards on this page', async () => {
    const wrapper = await mountPlace()
    expect(wrapper.find('[data-testid="place-summary"]').text()).toContain('Three Superfund sites')
    const cites = wrapper.findAll('[data-testid="place-summary-source"]')
    expect(cites).toHaveLength(2)
    expect(cites[0].attributes('href')).toBe('#section-epa-superfund-npl')
    // A page retrieval found is not on this page, so it keeps its own link.
    expect(cites[1].attributes('href')).toBe('/wiki/heirs-property')
  })

  it('shows the county card with its values, direction cues and a Compare link', async () => {
    const wrapper = await mountPlace()
    const county = wrapper.find('[data-testid="place-county"]')
    expect(county.text()).toContain('Fulton County, Georgia')
    expect(county.text()).toContain('44.5%')
    expect(county.text()).toContain('higher is better')
    expect(county.find('[data-testid="place-compare"]').attributes('href')).toBe('/compare?counties=13121&layers=pct_Black')
    expect(county.find('[data-testid="place-county-map"]').attributes('href')).toBe('/?fit=13121')
  })

  it('heads the evidence "Data sources checked" (P5-65)', async () => {
    // "Sources" means the citations under an Ask answer; what a place report
    // runs is the data-source registry, and the heading now says so.
    const wrapper = await mountPlace()
    expect(wrapper.get('[data-testid="place-sections"]').get('h3').text()).toBe('Data sources checked')
  })

  it('sits under the resource tabs, with Analysis marked current (P6-5)', async () => {
    const wrapper = await mountPlace()
    const currentLink = wrapper.get('[data-testid="kb-nav"]').findAll('a').find(a => a.attributes('aria-current') === 'page')
    expect(currentLink?.text().trim()).toBe('Analysis')
  })

  /**
   * P6-17. Measured before this ticket, on a cached report for
   * `/place?lat=40.7785&lng=-73.9572&radius=5`: 40 sections, 10,350 px at
   * 1440 and 14,950 px at 390, and not one collapse control on the page. Two
   * thirds of it was sources that found nothing or could not be checked.
   */
  it('opens what was found under its topic and folds the rest behind a row each (P6-17)', async () => {
    mockedRun.mockResolvedValue({
      ...REPORT,
      sections: [
        section({ slug: 'npl', topic: 'environment', count: 5 }),
        section({ slug: 'echo', topic: 'environment', count: 90 }),
        section({ slug: 'nfhl', topic: 'hazards', count: 7 }),
        // Nothing on the entry says what it is about — it still appears.
        section({ slug: 'mystery', topic: null, count: 1 }),
        section({ slug: 'ust', topic: 'environment', status: 'none', count: 0, rows: [], columns: [], cacheKey: undefined }),
        section({ slug: 'assessor', topic: 'land', status: 'skipped', count: 0, rows: [], columns: [], cacheKey: undefined, reason: 'Ask the assessor.' }),
        section({ slug: 'nri', topic: 'land', status: 'failed', count: 0, rows: [], columns: [], cacheKey: undefined, reason: 'the server refused.' }),
      ],
    })
    const wrapper = await mountPlace()
    const headings = wrapper.findAll('[data-testid="place-topic-heading"]')
    expect(headings.map(h => `${h.get('.fold-label').text()} ${h.get('.fold-count').text()}`)).toEqual([
      'Environment · 2 sources',
      'Hazards · 1 source',
      'Everything else · 1 source',
      'Nothing within 5 miles · 1 source',
      'Could not be checked · 2 sources',
    ])
    // Open: only what was found. Four cards instead of seven, and inside a
    // group the server's own order is kept — ranking belongs to the verdict,
    // not to the evidence.
    expect(wrapper.findAll('[data-testid="place-section"]').map(sec => sec.attributes('id'))).toEqual([
      'section-npl',
      'section-echo',
      'section-nfhl',
      'section-mystery',
    ])
    // Every heading is a real disclosure, and says which way it is facing.
    expect(headings.map(h => h.attributes('aria-expanded'))).toEqual(['true', 'true', 'true', 'false', 'false'])
  })

  it('gives back every row that was in the flat list when a group is opened (P6-17)', async () => {
    const wrapper = await mountPlace()
    // The default report: 1 found, 1 none, 1 skipped, 1 failed.
    expect(wrapper.findAll('[data-testid="place-section"]')).toHaveLength(1)
    const quiet = wrapper
      .findAll('[data-testid="place-topic-heading"]')
      .filter(h => [QUIET_NONE, QUIET_UNCHECKED].includes(h.attributes('data-topic') ?? ''))
    expect(quiet).toHaveLength(2)
    for (const head of quiet) await head.trigger('click')
    await flushPromises()
    const ids = wrapper.findAll('[data-testid="place-section"]').map(sec => sec.attributes('id'))
    expect(ids).toHaveLength(REPORT.sections.length)
    expect([...ids].sort()).toEqual(REPORT.sections.map(sec => `section-${sec.slug}`).sort())
  })

  it('folds a group the reader presses, and unfolds it again', async () => {
    const wrapper = await mountPlace()
    const head = wrapper.get('[data-testid="place-topic-heading"]')
    expect(head.attributes('aria-expanded')).toBe('true')
    await head.trigger('click')
    expect(wrapper.findAll('[data-testid="place-section"]')).toHaveLength(0)
    expect(wrapper.get('[data-testid="place-topic-heading"]').attributes('aria-expanded')).toBe('false')
    await wrapper.get('[data-testid="place-topic-heading"]').trigger('click')
    expect(wrapper.findAll('[data-testid="place-section"]')).toHaveLength(1)
  })

  it('opens the group a citation points into, so the link cannot land on nothing', async () => {
    mockedRun.mockResolvedValue({
      ...REPORT,
      summary: {
        text: 'The assessor has the parcels [1].',
        sources: [{ n: 1, title: 'Parcels', href: '/library/fulton-assessor' }],
      },
    })
    const wrapper = await mountPlace()
    const cite = wrapper.get('[data-testid="place-summary-source"]')
    expect(cite.attributes('href')).toBe('#section-fulton-assessor')
    // That card is inside the folded "Could not be checked" row.
    expect(wrapper.find('#section-fulton-assessor').exists()).toBe(false)
    await cite.trigger('click')
    await flushPromises()
    expect(wrapper.find('#section-fulton-assessor').exists()).toBe(true)
  })

  it('says each status in plain words, found first', async () => {
    const wrapper = await mountPlace()
    expect(wrapper.get('[data-testid="place-section-status"]').text()).toBe('3 results within 5 miles')
    for (const head of wrapper.findAll('[data-testid="place-topic-heading"]')) await head.trigger('click')
    await flushPromises()
    const statuses = wrapper.findAll('[data-testid="place-section-status"]').map(st => st.text())
    expect(statuses).toEqual([
      'Nothing within 5 miles',
      'Check by hand: Ask the assessor.',
      'Could not check: the server refused.',
    ])
  })

  it('shows the first rows of a source that found something, and links to the whole slice', async () => {
    const wrapper = await mountPlace()
    const first = wrapper.findAll('[data-testid="place-section"]')[0]
    expect(first.findAll('tbody tr')).toHaveLength(2)
    expect(first.text()).toContain('Lakewood Landfill')
    expect(first.find('[data-testid="place-section-slice"]').attributes('href')).toBe(
      '/library/epa-superfund-npl?place=p33.7490_-84.3880_r5',
    )
    expect(first.find('[data-testid="place-section-about"]').attributes('href')).toBe('/library/epa-superfund-npl')
    // An empty source has no table and no slice to open — only "About". It is
    // behind the "Nothing within 5 miles" row, so open that first.
    const noneRow = wrapper
      .findAll('[data-testid="place-topic-heading"]')
      .find(h => h.attributes('data-topic') === QUIET_NONE)
    await noneRow?.trigger('click')
    await flushPromises()
    const empty = wrapper.get('#section-georgia-epd-ust')
    expect(empty.find('[data-testid="place-section-table"]').exists()).toBe(false)
    expect(empty.find('[data-testid="place-section-slice"]').exists()).toBe(false)
  })

  it('lists the organizations nearby with their distance', async () => {
    const wrapper = await mountPlace()
    const orgs = wrapper.find('[data-testid="place-organizations"]')
    expect(orgs.find('[data-testid="place-organization"]').text()).toContain('Peachtree Land Trust')
    expect(orgs.text()).toContain('1.2 miles')
  })

  it('leads with a verdict rather than a list (P6-17)', async () => {
    const wrapper = await mountPlace()
    expect(wrapper.find('[data-testid="place-result-label"]').text()).toBe('55 Trinity Ave SW')
    expect(wrapper.get('[data-testid="place-verdict-headline"]').text()).toBe(
      '1 of 4 sources found something within 5 miles.',
    )
    const standouts = wrapper.findAll('[data-testid="place-standout"]')
    expect(standouts.map(a => a.text())).toEqual(['EPA Superfund NPL sites'])
    expect(standouts[0].attributes('href')).toBe('#section-epa-superfund-npl')
    expect(wrapper.get('[data-testid="place-verdict-rest"]').text()).toBe('1 found nothing · 2 could not be checked')
  })

  it('says when the report was made, and whether it is the cached copy (P6-26)', async () => {
    const wrapper = await mountPlace()
    const fresh = wrapper.get('[data-testid="place-generated"]')
    expect(fresh.text()).toContain('Checked')
    expect(fresh.text()).not.toContain('Cached')
    expect(fresh.classes()).not.toContain('cached')
    // The header also still says where and how far.
    expect(wrapper.get('[data-testid="place-sub"]').text()).toContain('Fulton County, Georgia')
    expect(wrapper.get('[data-testid="place-sub"]').text()).toContain('5 miles')

    mockedRun.mockResolvedValue({ ...REPORT, cached: true })
    const reopened = await mountPlace('geoid=13121')
    const cached = reopened.get('[data-testid="place-generated"]')
    expect(cached.text()).toContain('Cached copy')
    expect(cached.text()).toContain(new Date(REPORT.generatedAt).toLocaleDateString())
    expect(cached.classes()).toContain('cached')
  })

  it('leaves out the cards it has nothing for', async () => {
    mockedRun.mockResolvedValue({ ...REPORT, summary: null, county: null, organizations: [] })
    const wrapper = await mountPlace()
    expect(wrapper.find('[data-testid="place-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="place-county"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="place-organizations"]').exists()).toBe(false)
    // One found source is open; the other three are behind their summary rows.
    expect(wrapper.findAll('[data-testid="place-section"]').length).toBe(1)
    expect(wrapper.findAll('[data-testid="place-topic-heading"]').length).toBe(3)
  })
})

describe('the actions', () => {
  it('runs it again with refresh, so the cached copy is not what comes back', async () => {
    const wrapper = await mountPlace()
    await wrapper.find('[data-testid="place-rerun"]').trigger('click')
    await flushPromises()
    expect(mockedRun).toHaveBeenLastCalledWith({ address: '55 Trinity Ave SW', refresh: true }, expect.any(Function))
  })

  it('saves the report as a note, once', async () => {
    mockedNote.mockResolvedValue({ slug: 'place-report-x', title: 'Place report' } as never)
    const wrapper = await mountPlace()
    const button = wrapper.find('[data-testid="place-save-note"]')
    await button.trigger('click')
    await flushPromises()
    expect(mockedNote).toHaveBeenCalledWith(REPORT)
    expect(wrapper.find('[data-testid="place-note-saved"]').text()).toContain('Saved')
    expect(wrapper.find('[data-testid="place-note-link"]').attributes('href')).toBe('/library/place-report-x')
    // The button locks so a double click cannot leave two copies.
    await button.trigger('click')
    await flushPromises()
    expect(mockedNote).toHaveBeenCalledTimes(1)
  })

  it('adds the report to a page picked from the list', async () => {
    mockedCatalog.mockResolvedValue([{ slug: 'georgia', title: 'Georgia' } as never])
    mockedAdd.mockResolvedValue({ slug: 'georgia', title: 'Georgia' })
    const wrapper = await mountPlace()
    await wrapper.find('[data-testid="place-add-to-page"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="place-page-option"]').trigger('click')
    await flushPromises()
    expect(mockedAdd).toHaveBeenCalledWith('georgia', REPORT)
    expect(wrapper.find('[data-testid="place-page-added"]').text()).toContain('Added')
  })

  it('downloads the sections as a CSV named after the place', async () => {
    const blobs: Blob[] = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob)
        return 'blob:report'
      }),
      revokeObjectURL: vi.fn(),
    })
    const click = vi.fn()
    let downloadName = ''
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation(tag => {
      const el = realCreate(tag)
      if (tag === 'a') {
        ;(el as HTMLAnchorElement).click = () => {
          downloadName = (el as HTMLAnchorElement).download
          click()
        }
      }
      return el
    })

    const wrapper = await mountPlace()
    await wrapper.find('[data-testid="place-download"]').trigger('click')

    expect(click).toHaveBeenCalledTimes(1)
    expect(downloadName).toBe('place-report-55-Trinity-Ave-SW.csv')
    expect(blobs[0].type).toContain('text/csv')
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(blobs[0])
    })
    expect(text).toBe(reportCsv(REPORT))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})

/**
 * P5-60: the place report on a phone. The form stacks, the county's numbers
 * go two-up, every section is a full-width card whose "Open the full slice"
 * is a real button, the compact tables scroll inside their cards, and the
 * action row becomes a strip.
 */
const PLACE_SFC = readStyles('src/views/PlaceView.vue')
const PLACE_PHONE = mediaBlock(PLACE_SFC, 640)

describe('PlaceView — phone layout (P5-60)', () => {
  it('stacks the form: address + Run on one 44 px row, county and radius under it', async () => {
    const w = await mountPlace()
    // Run stays beside the address — it is what the field is for.
    const addressRow = w.get('[data-testid="place-form"]').get('.address-row .field-row')
    expect(addressRow.find('[data-testid="place-address"]').exists()).toBe(true)
    expect(addressRow.get('[data-testid="place-run"]').classes()).toContain('touch-target')

    // The two halves under it go one above the other at 720 px already.
    expect(ruleFor(mediaBlock(PLACE_SFC, 720), '.split')).toMatch(/grid-template-columns: (minmax\(0, 1fr\)|1fr);/)
    expect(ruleFor(PLACE_PHONE, '.text-input')).toContain('min-height: 44px')
    expect(ruleFor(PLACE_PHONE, '.text-input.narrow')).toContain('min-height: 44px')
    expect(ruleFor(PLACE_PHONE, '.tool-btn')).toContain('min-height: 44px')
  })

  /**
   * P6-28. Measured at 390 px before this fix: the toolbar was a `.strip` of
   * 625 px inside a 366 px box, so "Download CSV" and "Show on map" sat
   * entirely off-screen. The shared `.strip` edge fade was already computed on
   * this element and the audit still found them undiscoverable, so the fix is
   * to stop hiding them rather than to hint harder — two rows of 46 px.
   */
  it('wraps the actions so none of them is off-screen', async () => {
    const w = await mountPlace()
    await flushPromises()
    // Not a swipe strip any more: nothing is reachable only by scrolling.
    expect(w.get('.toolbar').classes()).not.toContain('strip')
    const phoneToolbar = ruleFor(PLACE_PHONE, '.toolbar')
    expect(phoneToolbar).toContain('flex-wrap: wrap')
    expect(phoneToolbar).not.toContain('overflow-x: auto')
    // And it still cannot widen the page past its card (P5-60).
    expect(phoneToolbar).toContain('max-width: 100%')
    expect(phoneToolbar).toContain('min-width: 0')
    // Every action is on the page, buttons and links alike.
    const labels = w.get('.toolbar').findAll('.tool-btn').map(b => b.text())
    expect(labels).toEqual(['Run again', 'Save as note', 'Add to page…', 'Download CSV', 'Show on map'])
    expect(ruleFor(PLACE_PHONE, '.toolbar > .tool-btn')).toContain('flex: 0 0 auto')
  })

  it('makes the fold controls 44 px rows (P6-17)', async () => {
    const w = await mountPlace()
    expect(ruleFor(PLACE_PHONE, '.fold-toggle')).toContain('min-height: 44px')
    expect(w.get('[data-testid="place-topic-heading"]').element.tagName).toBe('BUTTON')
  })

  it('reads the verdict and the progress note at 14 px', () => {
    expect(ruleFor(PLACE_PHONE, '.verdict-headline')).toContain('font-size: 16px')
    for (const selector of ['.standouts li', '.standout-count', '.verdict-rest', '.progress-note']) {
      expect(ruleFor(PLACE_PHONE, selector)).toContain('font-size: 14px')
    }
    // A standout is a 44 px row of its own, title over count.
    expect(ruleFor(PLACE_PHONE, '.standouts li')).toContain('min-height: 44px')
  })

  it('lays the county card’s numbers out two to a row', () => {
    expect(ruleFor(PLACE_PHONE, '.county-card .layer-list')).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(ruleFor(PLACE_PHONE, '.county-card .layer-list li')).toContain('font-size: 14px')
  })

  it('makes "Open the full slice" and its neighbours 44 px buttons', async () => {
    const w = await mountPlace()
    await flushPromises()
    expect(w.get('[data-testid="place-section-slice"]').classes()).toContain('touch-target')
    const links = ruleFor(PLACE_PHONE, '.card-links a')
    expect(links).toContain('min-height: 44px')
  })

  it('keeps the compact tables inside their cards, and off the page', () => {
    expect(ruleFor(PLACE_SFC, '.table-scroll')).toContain('overflow-x: auto')
    expect(ruleFor(PLACE_SFC, '.table-scroll')).toContain('max-width: 100%')
    expect(ruleFor(PLACE_SFC, '.place-panel')).toContain('min-width: 0')
    // The route root is a flex item of App.vue's `main`; without this the
    // widest table on the page becomes the page's own width.
    expect(ruleFor(PLACE_SFC, '.place-view')).toContain('min-width: 0')
  })

  it('scales the heading and reads at 14 px', () => {
    expect(ruleFor(PLACE_PHONE, '.place-header h1')).toContain('clamp(')
    expect(ruleFor(PLACE_PHONE, '.lede')).toContain('font-size: 14px')
    expect(ruleFor(PLACE_PHONE, '.rows-table')).toContain('font-size: 14px')
  })
})

/**
 * P7-1. Running the report INSIDE a working set — the acceptance criterion the
 * whole ticket exists for, as the page expresses it.
 *
 * Two things are load-bearing. The scope reaches the server as a NAME, so the
 * server dereferences it and a quoted number is citable. And the page's own
 * source count is scoped with it: "40 sources" over a run that asked two would
 * make the point of the object invisible, and would be a number disagreeing
 * with what happened.
 */
describe('scoped to a working set (P7-1)', () => {
  const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
    slug: 'x',
    kind: 'source',
    title: 'X',
    category: '',
    status: 'published',
    tags: [],
    meta: {},
    files: [],
    bytes: 0,
    readiness: { as: 'source', placeReport: 'runs', notes: [] },
    ...over,
  })

  const SOURCES: CatalogEntry[] = [
    entry({ slug: 'epa-superfund-npl', title: 'Superfund NPL sites' }),
    entry({ slug: 'epa-brownfields', title: 'Brownfields' }),
    entry({ slug: 'fema-nri', title: 'FEMA risk index' }),
    entry({ slug: 'tn-transmission', title: 'Transmission lines' }),
  ]

  const SET: WorkingSetDetail = {
    slug: 'memphis-redevelopment',
    name: 'Memphis redevelopment',
    purpose: 'What bears on siting',
    description: '',
    datasets: ['epa-superfund-npl', 'epa-brownfields'],
    layers: [],
    sites: null,
    derivedCount: 0,
    savedBy: 'maria',
    savedAt: '',
    updatedAt: '',
    views: [],
    members: [],
    missing: [],
  }

  it('asks the server for the set by NAME, not as a list of slugs', async () => {
    await mountPlace('geoid=13121&set=memphis-redevelopment')
    expect(mockedRun).toHaveBeenCalledTimes(1)
    expect(mockedRun.mock.calls[0][0]).toEqual({ geoid: '13121', workingSet: 'memphis-redevelopment' })
    expect(mockedRun.mock.calls[0][0]).not.toHaveProperty('sources')
  })

  it('says which set it is inside, before the form', async () => {
    mockedSet.mockResolvedValue(SET)
    const w = await mountPlace('geoid=13121&set=memphis-redevelopment')
    await flushPromises()
    expect(w.get('[data-testid="place-scope"]').text()).toContain('Memphis redevelopment')
    expect(w.get('[data-testid="place-scope"]').text()).toContain('only its sources will be asked')
  })

  it('falls back to the slug when the set itself could not be read', async () => {
    mockedSet.mockResolvedValue(null)
    const w = await mountPlace('geoid=13121&set=memphis-redevelopment')
    await flushPromises()
    expect(w.get('[data-testid="place-scope"]').text()).toContain('memphis-redevelopment')
  })

  it('offers the way out — a scope you cannot see is a scope you cannot leave', async () => {
    mockedSet.mockResolvedValue(SET)
    const w = await mountPlace('geoid=13121&set=memphis-redevelopment')
    await w.get('[data-testid="place-scope-clear"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.set).toBeUndefined()
    expect(mockedRun).toHaveBeenLastCalledWith({ geoid: '13121' }, expect.anything())
  })

  it('keeps the scope when the place changes — a different question from where', async () => {
    mockedSet.mockResolvedValue(SET)
    const w = await mountPlace('geoid=13121&set=memphis-redevelopment')
    await w.get('[data-testid="place-address"]').setValue('55 Trinity Ave SW')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.set).toBe('memphis-redevelopment')
  })

  /**
   * The number on the page has to be the number of the run. "Checking 4
   * sources…" over a run that asked two would make the point of a working set
   * invisible — and a count disagreeing with what happened is the one thing
   * this codebase does not do.
   */
  it('counts the set’s sources, not the library’s — 2 here, 4 unscoped', async () => {
    mockedCatalog.mockResolvedValue(SOURCES)
    mockedSet.mockResolvedValue(SET)
    let release: (r: PlaceReport) => void = () => {}
    mockedRun.mockReturnValue(new Promise<PlaceReport>(resolve => { release = resolve }))

    const scoped = await mountPlace('geoid=13121&set=memphis-redevelopment')
    await flushPromises()
    expect(scoped.get('[data-testid="place-progress"]').text()).toBe('Checking 2 sources…')
    release(REPORT)
    await flushPromises()

    mockedSet.mockResolvedValue(null)
    mockedRun.mockReturnValue(new Promise<PlaceReport>(resolve => { release = resolve }))
    const all = await mountPlace('geoid=13121')
    await flushPromises()
    expect(all.get('[data-testid="place-progress"]').text()).toBe('Checking 4 sources…')
    release(REPORT)
    await flushPromises()
  })

  it('says nothing about a scope when there is none', async () => {
    const w = await mountPlace('geoid=13121')
    expect(w.find('[data-testid="place-scope"]').exists()).toBe(false)
    expect(mockedSet).not.toHaveBeenCalled()
  })
})
