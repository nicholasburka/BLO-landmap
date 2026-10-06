import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalogPage: vi.fn() }
})
vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  // P5-89: every surface reads the one shared manifest now.
  return { ...actual, sharedManifest: vi.fn() }
})

import { fetchCatalogPage } from '@/lib/libraryCatalog'
import { sharedManifest } from '@/lib/internalLayers'
import GlobalSearch from '../GlobalSearch.vue'
import { resetBodyScrollLock } from '@/lib/scrollLock'

const mockedPage = vi.mocked(fetchCatalogPage)
const mockedLayers = vi.mocked(sharedManifest)

const ENTRIES = [
  { slug: 'funding-network', kind: 'wiki', title: 'Funding network', category: '', status: 'published', tags: [], meta: {}, files: [], bytes: 0 },
  { slug: 'organizations', kind: 'dataset', title: 'Organizations', category: 'network', status: 'published', tags: [], meta: { layer: { geometry: 'point' } }, files: [{ key: 'library/datasets/organizations/organizations.csv', size: 1 }], bytes: 1 },
  { slug: 'funding-strategy', kind: 'document', title: 'Initiative overview with funding strategy', category: 'strategy', status: 'published', tags: [], meta: {}, files: [], bytes: 0 },
  // P5-54: a saved table view — its row says so, and what it holds.
  { slug: 'org-view', kind: 'view', title: 'Org view', category: 'views', status: 'published', tags: [], meta: { type: 'table', dataset: 'organizations', description: 'Organizations · HQ State is Georgia · 13 rows' }, files: [], bytes: 0 },
  // P5-56: a data source — a dataset we point at rather than hold.
  { slug: 'epa-npl', kind: 'source', title: 'EPA Superfund NPL sites', category: 'environment', status: 'published', tags: [], meta: { source: { provider: 'US EPA' } }, files: [], bytes: 0 },
  // P5-64: a note and a dropped link, so the group order is exercised whole.
  { slug: 'org-idea', kind: 'note', title: 'An idea about orgs', category: 'ideas', status: 'open', tags: [], meta: {}, files: [], bytes: 0 },
  { slug: 'org-drop', kind: 'incoming', title: 'example.org/orgs.csv', category: '', status: 'needs-cataloging', tags: [], meta: { url: 'https://example.org/orgs.csv' }, files: [], bytes: 0 },
]
const LAYERS = [{ id: 'internal-organizations', slug: 'organizations', geometry: 'point', name: 'Organizations (HQ)', dataType: 'count', unit: '', direction: 'higher_better', range: null, description: '', source: '', year: '', file: null, color: null, popupFields: [], bbox: [-90.31, 34.99, -89.6, 35.35], updatedAt: null }]

let router: Router
async function mountIt() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/')
  await router.isReady()
  const w = mount(GlobalSearch, { global: { plugins: [router] }, attachTo: document.body })
  return w
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mockedPage.mockReset()
  mockedLayers.mockReset()
  mockedPage.mockResolvedValue({ entries: ENTRIES as any, archivedCount: 0 })
  mockedLayers.mockResolvedValue(LAYERS as any)
})

afterEach(() => {
  vi.useRealTimers()
  resetBodyScrollLock()
  document.body.innerHTML = ''
})

async function typeQuery(w: ReturnType<typeof mount>, text: string) {
  await w.get('.palette-input').setValue(text)
  await vi.advanceTimersByTimeAsync(250)
  await flushPromises()
}

describe('GlobalSearch (P5-38)', () => {
  it('opens from the trigger and ⌘K, closes on Esc', async () => {
    const w = await mountIt()
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(false)
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await flushPromises()
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(true)
    w.unmount()
  })

  it('groups results by kind with the actions each supports, and matches layers by name', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'org')
    expect(mockedPage).toHaveBeenCalledWith({ q: 'org' })
    // P5-64: grouped by trust — what we hold, then what is waiting to be
    // filed, then the registry we only point at.
    expect(w.findAll('.palette-group-name').map(g => g.text())).toEqual([
      'Pages',
      'Datasets',
      'Layers',
      'Documents',
      'Notes',
      'Views',
      'To file',
      'Data sources',
    ])
    const dataset = w.get('[data-testid="search-result-datasets"]')
    expect(dataset.get('.palette-primary').attributes('href')).toBe('/library/organizations')
    expect(dataset.findAll('.palette-action').map(a => a.text())).toEqual(['Browse data', 'Show on map'])
    // P5-77: the dataset row's map link carries the layer's frame from the manifest.
    expect(dataset.findAll('.palette-action')[1].attributes('href')).toContain('fit=bbox%3A')
    const page = w.get('[data-testid="search-result-pages"]')
    expect(page.get('.palette-primary').attributes('href')).toBe('/wiki/funding-network')
    expect(page.findAll('.palette-action')).toHaveLength(0)
    const view = w.get('[data-testid="search-result-views"]')
    expect(view.get('.palette-primary').attributes('href')).toBe('/views/org-view')
    expect(view.text()).toContain('table view · Organizations · HQ State is Georgia · 13 rows')
    const layer = w.get('[data-testid="search-result-layers"]')
    expect(layer.text()).toContain('Organizations (HQ)')
    expect(layer.get('.palette-primary').attributes('href')).toContain('fit=bbox%3A')
    w.unmount()
  })

  it('Enter opens the highlighted result and arrows move the highlight; a click routes in-app', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'org')
    // P6-6: the palette opens on no row at all. The first ArrowDown lands on
    // the P5-41 "Ask: …" row, so the first catalog result is the third press.
    for (let i = 0; i < 3; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flushPromises()
    expect(w.findAll('.palette-row')[2].classes()).toContain('active')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/library/organizations')
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(false)
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'org')
    await w.get('[data-testid="search-result-datasets"] .palette-action').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/library/organizations?tab=data')
    w.unmount()
  })

  it('offers "Ask: …" as the first row, before any request, and opens /ask when picked (P5-41)', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    // Typed but not yet searched: the ask row needs no request, so it is there.
    await w.get('.palette-input').setValue('which orgs do land trusts?')
    await flushPromises()
    const ask = w.get('[data-testid="search-result-ask"]')
    expect(ask.text()).toContain('Ask: which orgs do land trusts?')
    expect(w.findAll('.palette-row')[0].attributes('data-testid')).toBe('search-result-ask')
    // P6-6: nothing is highlighted until somebody moves.
    expect(ask.classes()).not.toContain('active')

    await typeQuery(w, 'which orgs do land trusts?')
    expect(w.findAll('.palette-row')[0].attributes('data-testid')).toBe('search-result-ask')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flushPromises()
    expect(w.get('[data-testid="search-result-ask"]').classes()).toContain('active')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/ask?q=which+orgs+do+land+trusts%3F')
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(false)
    w.unmount()
  })

  /**
   * P6-6 (spec §D.13): the palette is the quick version of /search, so Enter
   * on what you typed — with no row picked — is "search everything for this".
   */
  it('Enter with text and no row picked hands the query to /search', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'heirs property')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/search?q=heirs+property')
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(false)

    // ArrowUp from nothing is the last row, not a jump past the end.
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'org')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    await flushPromises()
    const rows = w.findAll('.palette-row')
    expect(rows[rows.length - 1].classes()).toContain('active')
    w.unmount()
  })

  it('Enter with an empty box does nothing at all', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(true)
    w.unmount()
  })

  it('finds the public map layers too, labelled "layer" and linking to their about page (P5-45)', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    // "poverty" matches a public registry layer and nothing in the manifest.
    await typeQuery(w, 'poverty')
    const rows = w.findAll('[data-testid="search-result-layers"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].get('.palette-title').text()).toBe('Poverty Rate (Black)')
    expect(rows[0].get('.palette-meta').text()).toBe('layer · Equity')
    expect(rows[0].get('.palette-primary').attributes('href')).toBe('/layers/poverty_by_race')
    expect(rows[0].findAll('.palette-action').map(a => a.text())).toEqual(['Show on map'])
    w.unmount()
  })

  it('shows an empty state with a link to the library list, and survives a manifest failure', async () => {
    mockedPage.mockResolvedValue({ entries: [], archivedCount: 0 })
    mockedLayers.mockRejectedValue(new Error('401'))
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'zzz')
    expect(w.get('[data-testid="search-empty"]').text()).toContain('Nothing matches “zzz”')
    expect(w.get('[data-testid="search-empty"] a').attributes('href')).toBe('/library?q=zzz')
    w.unmount()
  })
})

/**
 * P5-64: the registry ranks behind vetted data. Sources leave the Datasets
 * group for one of their own, last; the per-row badge goes with them, because
 * the group name now says what the badge did.
 */
describe('GlobalSearch sources (P5-56, P5-64)', () => {
  it('lists a source in its own last group, unbadged, and names the provider', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'epa')
    const groups = w.findAll('.palette-group-name').map(g => g.text())
    expect(groups[groups.length - 1]).toBe('Data sources')
    const row = w.get('[data-testid="search-result-data-sources"]')
    expect(row.text()).toContain('EPA Superfund')
    expect(row.text()).toContain('US EPA')
    expect(row.find('[data-testid="search-result-badge"]').exists()).toBe(false)
    // A dataset we hold is not in there.
    expect(w.findAll('[data-testid="search-result-datasets"]').map(r => r.text()).join()).toContain('Organizations')
  })

  it('files a dropped link under "To file" rather than with the documents', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'org')
    const toFile = w.get('[data-testid="search-result-to-file"]')
    expect(toFile.text()).toContain('example.org/orgs.csv')
    const documents = w.findAll('[data-testid="search-result-documents"]').map(r => r.text()).join()
    expect(documents).not.toContain('example.org/orgs.csv')
  })

  it('matches a public layer on its category label, so "housing" finds the Housing layers', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await typeQuery(w, 'housing')
    const housing = w.findAll('[data-testid="search-result-layers"]').map(r => r.get('.palette-title').text())
    expect(housing).toContain('Median Home Value')
    expect(housing).toContain('Median Property Tax')

    await typeQuery(w, 'people')
    const people = w.findAll('[data-testid="search-result-layers"]').map(r => r.get('.palette-title').text())
    expect(people).toContain('Percent Black')
    expect(people).toContain('Diversity Index')
    w.unmount()
  })
})

describe('the palette on a phone (P5-60)', () => {
  it('is full-screen, with a close button and the input at the top', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await flushPromises()

    const panel = w.get('[data-testid="search-palette"] [role="dialog"]')
    // jsdom computes no layout: the classes are what the phone rules hang off.
    expect(panel.classes()).toEqual(expect.arrayContaining(['sheet', 'sheet--full']))
    // Esc is the way out on a keyboard; a phone has none, hence the button.
    expect(w.find('[data-testid="search-close"]').exists()).toBe(true)
    // The input comes before the results so the keyboard pushes them down
    // rather than covering what is being typed.
    const top = panel.element.firstElementChild as HTMLElement
    expect(top.querySelector('.palette-input')).not.toBeNull()

    await w.get('[data-testid="search-close"]').trigger('click')
    expect(w.find('[data-testid="search-palette"]').exists()).toBe(false)
    w.unmount()
  })

  it('locks the page behind it and unlocks it on close', async () => {
    const w = await mountIt()
    await w.get('[data-testid="search-trigger"]').trigger('click')
    await flushPromises()
    expect(document.body.style.overflow).toBe('hidden')
    await w.get('[data-testid="search-close"]').trigger('click')
    expect(document.body.style.overflow).toBe('')
    w.unmount()
  })
})
