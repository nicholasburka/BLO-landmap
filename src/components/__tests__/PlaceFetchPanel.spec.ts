import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'

vi.mock('@/lib/placeFetch', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/placeFetch')>()
  return { ...actual, fetchForPlace: vi.fn(), fetchSlices: vi.fn(), promoteSlice: vi.fn() }
})
vi.mock('@/lib/countyLookup', () => ({
  initCountyLookup: vi.fn(async () => {}),
  findCounty: vi.fn(),
}))

import { fetchForPlace, fetchSlices, promoteSlice } from '@/lib/placeFetch'
import { findCounty, initCountyLookup } from '@/lib/countyLookup'
import PlaceFetchPanel from '../PlaceFetchPanel.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { resetBodyScrollLock } from '@/lib/scrollLock'
import type { SourceMeta } from '@/lib/libraryCatalog'

/** P5-57: the panel a person actually presses. */

const mockedFetch = vi.mocked(fetchForPlace)
const mockedSlices = vi.mocked(fetchSlices)
const mockedPromote = vi.mocked(promoteSlice)
const mockedCounty = vi.mocked(findCounty)

const SOURCE: SourceMeta = {
  provider: 'US EPA',
  access: [{ type: 'arcgis', url: 'https://x.test/FeatureServer/0' }],
  placeQuery: { by: ['point', 'county'], radiusMiles: 3 },
}

const RESULT = {
  rows: [
    { Site_Name: 'Beta', Score: '9' },
    { Site_Name: 'alpha', Score: '10' },
  ],
  columns: ['Site_Name', 'Score'],
  count: 2,
  truncated: false,
  fetchedAt: new Date().toISOString(),
  cacheKey: 'g13121',
  cached: false,
  adapter: 'arcgis',
  place: { label: 'Fulton County, GA', lat: null, lng: null, geoid: '13121', radiusMiles: 3 },
}

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/library/:slug', component: { template: '<div />' } },
  ],
})

async function mountPanel(props: Record<string, unknown> = {}) {
  const w = mount(PlaceFetchPanel, {
    props: { slug: 'epa-superfund-npl', source: SOURCE, ...props },
    global: { plugins: [router] },
  })
  await flushPromises()
  return w
}

beforeEach(() => {
  mockedFetch.mockReset()
  mockedSlices.mockReset()
  mockedPromote.mockReset()
  mockedCounty.mockReset()
  mockedSlices.mockResolvedValue([])
  mockedFetch.mockResolvedValue(RESULT as never)
})

describe('saying where', () => {
  it('offers an address and a county, and the map centre only when there is one', async () => {
    const w = await mountPanel()
    expect(w.findAll('[data-testid^="mode-"]').map(b => b.attributes('data-testid'))).toEqual(['mode-address', 'mode-county'])

    const withMap = await mountPanel({ mapCenter: { lat: 33.749, lng: -84.388 } })
    expect(withMap.find('[data-testid="mode-center"]').exists()).toBe(true)
    await withMap.get('[data-testid="mode-center"]').trigger('click')
    expect(withMap.get('[data-testid="center-note"]').text()).toContain('33.7490, -84.3880')
  })

  it('starts with the radius the source recommends', async () => {
    const w = await mountPanel()
    expect((w.get('[data-testid="place-radius"]').element as HTMLInputElement).value).toBe('3')
    const noRadius = await mountPanel({ source: { provider: 'X', access: [{ type: 'rest' }] } })
    expect((noRadius.get('[data-testid="place-radius"]').element as HTMLInputElement).value).toBe('5')
  })

  it('will not run until it has a place', async () => {
    const w = await mountPanel()
    expect(w.get('[data-testid="place-run"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="place-address"]').setValue('1040 Westview Dr SW, Atlanta')
    expect(w.get('[data-testid="place-run"]').attributes('disabled')).toBeUndefined()
  })

  it('searches counties by name, takes "Fulton, GA", and hides the radius for a county', async () => {
    mockedCounty.mockReturnValue([
      { geoId: '13121', name: 'Fulton County', baseName: 'Fulton', stateName: 'Georgia', stateAbbr: 'GA' },
    ])
    const w = await mountPanel()
    await w.get('[data-testid="mode-county"]').trigger('click')
    // A county is a whole area, not a circle.
    expect(w.find('[data-testid="place-radius"]').exists()).toBe(false)

    await w.get('[data-testid="place-county"]').setValue('Fulton, GA')
    await w.get('[data-testid="find-county"]').trigger('click')
    await flushPromises()
    expect(initCountyLookup).toHaveBeenCalled()
    expect(mockedCounty).toHaveBeenCalledWith('Fulton', 'GA')

    await w.get('[data-testid="county-matches"] button').trigger('click')
    expect(w.get('[data-testid="county-chosen"]').text()).toBe('Fulton County, GA')

    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(mockedFetch).toHaveBeenCalledWith('epa-superfund-npl', { geoid: '13121' })
  })

  it('says so when there is no county by that name', async () => {
    mockedCounty.mockReturnValue([])
    const w = await mountPanel()
    await w.get('[data-testid="mode-county"]').trigger('click')
    await w.get('[data-testid="place-county"]').setValue('Nowhere')
    await w.get('[data-testid="find-county"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="county-error"]').text()).toContain('No county called "Nowhere"')
  })
})

describe('the result', () => {
  it('says how many rows, for where, and whether it was already held', async () => {
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(mockedFetch).toHaveBeenCalledWith('epa-superfund-npl', { address: 'Atlanta', radiusMiles: 3 })
    expect(w.get('[data-testid="place-result-line"]').text()).toBe('2 rows for Fulton County, GA — fetched just now.')
    expect(w.findAll('.data-table tbody tr')).toHaveLength(2)
    expect(w.findAll('.data-table th').map(th => th.text().trim())).toEqual(['Site_Name', 'Score'])
  })

  it('sorts a column in the browser without asking again', async () => {
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()

    await w.get('[data-testid="sort-Site_Name"]').trigger('click')
    expect(w.findAll('.data-table tbody tr td:first-child').map(td => td.text())).toEqual(['alpha', 'Beta'])
    await w.get('[data-testid="sort-Site_Name"]').trigger('click')
    expect(w.findAll('.data-table tbody tr td:first-child').map(td => td.text())).toEqual(['Beta', 'alpha'])
    // Sorting is in memory: the server was asked exactly once.
    expect(mockedFetch).toHaveBeenCalledTimes(1)
  })

  it('reads a cached answer as one, and can ask again on purpose', async () => {
    mockedFetch.mockResolvedValue({ ...RESULT, cached: true } as never)
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="place-result-line"]').text()).toContain('already had')

    await w.get('[data-testid="place-refresh"]').trigger('click')
    await flushPromises()
    expect(mockedFetch).toHaveBeenLastCalledWith('epa-superfund-npl', { address: 'Atlanta', radiusMiles: 3, refresh: true })
  })

  it('says plainly when a place has nothing, without pretending that means safe', async () => {
    mockedFetch.mockResolvedValue({ ...RESULT, rows: [], count: 0 } as never)
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="place-empty"]').text()).toContain('never mapped it')
    expect(w.find('[data-testid="place-save"]').exists()).toBe(false)
  })

  it('shows the server’s sentence when a fetch fails', async () => {
    mockedFetch.mockRejectedValue(new Error('the agency’s server took too long. Try a smaller radius.'))
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="place-error"]').text()).toContain('took too long')
    expect(w.find('[data-testid="place-result"]').exists()).toBe(false)
  })

  it('offers a note rather than a dead "Show on map" button', async () => {
    mockedFetch.mockResolvedValue({ ...RESULT, geometry: { type: 'FeatureCollection', features: [{}] } } as never)
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="place-map-note"]').text()).toContain('Map preview coming')
  })
})

describe('saving and re-opening', () => {
  it('saves the slice as a dataset and links to it', async () => {
    mockedPromote.mockResolvedValue({ slug: 'new-uuid', rows: 2 })
    const w = await mountPanel()
    await w.get('[data-testid="place-address"]').setValue('Atlanta')
    await w.get('[data-testid="place-run"]').trigger('click')
    await flushPromises()
    await w.get('[data-testid="place-save"]').trigger('click')
    await flushPromises()
    expect(mockedPromote).toHaveBeenCalledWith('epa-superfund-npl', 'g13121')
    expect(w.get('[data-testid="place-saved"] a').attributes('href')).toBe('/library/new-uuid')
    expect(w.emitted('promoted')).toEqual([['new-uuid']])
  })

  it('opens the slice a deep link named, straight from the cache', async () => {
    mockedSlices.mockResolvedValue([
      {
        cacheKey: 'g13121',
        place: { label: 'Fulton County, GA', lat: null, lng: null, geoid: '13121', radiusMiles: 3 },
        count: 2,
        truncated: false,
        adapter: 'arcgis',
        fetchedAt: new Date().toISOString(),
        ttlDays: 7,
      },
    ])
    const w = await mountPanel({ openPlace: 'g13121' })
    await flushPromises()
    expect(mockedFetch).toHaveBeenCalledWith('epa-superfund-npl', { geoid: '13121' })
    expect(w.find('[data-testid="place-result"]').exists()).toBe(true)

    // A place we do not hold is not fetched behind the reader's back.
    mockedFetch.mockClear()
    await mountPanel({ openPlace: 'g99999' })
    await flushPromises()
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('lists the places we already hold, with their age, and re-opens one from the cache', async () => {
    mockedSlices.mockResolvedValue([
      {
        cacheKey: 'g13121',
        place: { label: 'Fulton County, GA', lat: null, lng: null, geoid: '13121', radiusMiles: 3 },
        count: 2,
        truncated: false,
        adapter: 'arcgis',
        fetchedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        ttlDays: 7,
      },
    ])
    const w = await mountPanel()
    const row = w.get('[data-testid="place-slices"] .slice-row')
    expect(row.text()).toContain('Fulton County, GA')
    expect(row.text()).toContain('2 rows')
    expect(row.text()).toContain('3h ago')

    await w.get('[data-testid="open-g13121"]').trigger('click')
    await flushPromises()
    expect(mockedFetch).toHaveBeenCalledWith('epa-superfund-npl', { geoid: '13121' })
  })
})

/**
 * P5-60: the fetch panel on a phone. It becomes a bottom sheet over the entry
 * page — three modes as a segmented control, 44 px inputs and buttons, the
 * results table scrolling inside itself — with a handle that drops it to a
 * title strip so the page behind it is reachable again.
 */
const PANEL_SFC = readStyles('src/components/PlaceFetchPanel.vue')
const PANEL_PHONE = mediaBlock(PANEL_SFC, 640)

/** Make the panel think it is (or is not) on a phone. */
function fakeMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

describe('PlaceFetchPanel — phone layout (P5-60)', () => {
  afterEach(() => {
    resetBodyScrollLock()
    Reflect.deleteProperty(window, 'matchMedia')
  })

  it('is a bottom sheet with a handle that collapses it to a strip', async () => {
    const w = await mountPanel()
    const panel = w.get('[data-testid="place-fetch-panel"]')
    expect(panel.classes()).toContain('sheet')

    const handle = w.get('[data-testid="place-sheet-handle"]')
    expect(handle.attributes('aria-expanded')).toBe('true')
    await handle.trigger('click')
    expect(panel.classes()).toContain('sheet--collapsed')
    expect(handle.attributes('aria-expanded')).toBe('false')

    const sheet = ruleFor(PANEL_PHONE, '.place-panel.sheet')
    expect(sheet).toContain('bottom: 0')
    expect(sheet).toContain('max-height: 85svh')
    expect(sheet).toContain('env(safe-area-inset-bottom')
    expect(ruleFor(PANEL_PHONE, '.sheet--collapsed .sheet-body')).toContain('display: none')
  })

  it('holds the page still while the sheet is open on a phone', async () => {
    fakeMatchMedia(true)
    const w = await mountPanel()
    expect(document.body.style.overflow).toBe('hidden')
    await w.get('[data-testid="place-sheet-handle"]').trigger('click')
    expect(document.body.style.overflow).toBe('')
  })

  it('leaves the page alone on a desktop, where it is just a card', async () => {
    fakeMatchMedia(false)
    await mountPanel()
    expect(document.body.style.overflow).toBe('')
  })

  it('shows the three modes as one segmented control', async () => {
    const w = await mountPanel({ mapCenter: { lat: 33.7, lng: -84.4 } })
    const modes = w.findAll('.mode-btn')
    expect(modes).toHaveLength(3)
    expect(modes.every(m => m.classes('touch-target'))).toBe(true)
    expect(modes[0].attributes('aria-pressed')).toBe('true')
    expect(modes[1].attributes('aria-pressed')).toBe('false')

    const row = ruleFor(PANEL_PHONE, '.mode-row')
    expect(row).toContain('grid-auto-columns: 1fr')
    expect(row).toContain('border-radius: 999px')
    expect(ruleFor(PANEL_PHONE, '.mode-btn')).toContain('min-height: 44px')
  })

  it('gives the inputs, Run and the actions room to be tapped', () => {
    expect(ruleFor(PANEL_PHONE, ".field input[type='text']")).toContain('min-height: 44px')
    expect(ruleFor(PANEL_PHONE, '.run-btn')).toContain('min-height: 44px')
    expect(ruleFor(PANEL_PHONE, '.link-btn')).toContain('min-height: 44px')
    expect(ruleFor(PANEL_PHONE, '.result-actions')).toContain('overflow-x: auto')
    expect(ruleFor(PANEL_SFC, '.table-scroll')).toContain('max-width: 100%')
  })
})
