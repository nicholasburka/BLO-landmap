import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'

/**
 * "Show on map" that builds a set (P9-12).
 *
 * `MapPane` is stubbed: this is about which layers are offered, that none of
 * them starts on, and that a named selection becomes a working set. The pane
 * itself is P6-14's and has its own tests.
 */

vi.mock('@/components/MapPane.vue', () => ({
  default: {
    name: 'MapPane',
    props: ['layers', 'query', 'data', 'title', 'note', 'testid', 'label'],
    template: '<div data-testid="explore-pane"><slot name="overlay" /></div>',
  },
}))

vi.mock('@/lib/workingSets', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/workingSets')>()
  return { ...actual, createWorkingSet: vi.fn() }
})

vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, sharedManifest: vi.fn() }
})

import { createWorkingSet } from '@/lib/workingSets'
import { sharedManifest, clearInternalLayerCache } from '@/lib/internalLayers'
import ExploreMapPane from '../ExploreMapPane.vue'

const mockedCreate = vi.mocked(createWorkingSet)
const mockedManifest = vi.mocked(sharedManifest)

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/library/:slug', component: { template: '<div />' } },
  ],
})

beforeEach(async () => {
  stubViewportWidth(1280)
  clearInternalLayerCache()
  mockedCreate.mockReset()
  mockedManifest.mockReset()
  mockedManifest.mockResolvedValue([
    {
      id: 'internal-sites',
      slug: 'sites',
      name: 'Candidate sites',
      geometry: 'county',
      dataType: 'count',
      unit: '',
      direction: 'higher_better',
      range: { min: 0, max: 10 },
      description: '',
      source: '',
      year: 2026,
      file: null,
    } as never,
  ])
  await router.push('/')
  await router.isReady()
})

afterEach(() => {
  restoreViewport()
  clearInternalLayerCache()
})

async function mountPane() {
  const w = mount(ExploreMapPane, { global: { plugins: [router] } })
  await flushPromises()
  await flushPromises()
  return w
}

describe('exploring every layer', () => {
  it('offers the library’s layers and the public map’s, with none of them on', async () => {
    const w = await mountPane()
    const rows = w.findAll('[data-testid="set-layer"]')
    expect(rows.length).toBeGreaterThan(5)
    // The library's own first — the reason somebody is here and not on `/`.
    expect(rows[0].text()).toContain('Candidate sites')
    // A picker that pre-selects has made the choice the reader came to make.
    expect(w.findAll('[data-testid="set-layer"] input:checked')).toHaveLength(0)
    expect(w.get('[data-testid="explore-empty"]').text()).toContain('Nothing is switched on')
    expect(w.find('[data-testid="explore-chosen"]').exists()).toBe(false)
  })

  it('will not make a set out of nothing, or out of something unnamed', async () => {
    const w = await mountPane()
    expect(w.find('[data-testid="explore-create"]').exists()).toBe(false)

    await w.findAll('[data-testid="set-layer"] input[type="checkbox"]')[0].setValue(true)
    expect(w.get('[data-testid="explore-chosen"]').text()).toContain('Candidate sites')
    // Named is the missing half, and it says so rather than greying in silence.
    expect((w.get('[data-testid="explore-create"]').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.get('[data-testid="explore-why"]').text()).toContain('Give it a name')
  })

  it('turns what is switched on into a working set', async () => {
    mockedCreate.mockResolvedValue({ slug: 'sites-and-burden', name: 'Sites and burden' })
    const w = await mountPane()
    await w.findAll('[data-testid="set-layer"] input[type="checkbox"]')[0].setValue(true)
    await w.get('[data-testid="explore-name"]').setValue('Sites and burden')
    // Submit the form, not the button: a click on a submit button does not
              // submit in jsdom.
    await w.get('[data-testid="explore-save"]').trigger('submit')
    await flushPromises()

    expect(mockedCreate).toHaveBeenCalledWith({
      name: 'Sites and burden',
      layers: ['internal-sites'],
    })
    // The set is the point, so the way into it is the answer.
    const made = w.get('[data-testid="explore-made"]')
    expect(made.text()).toContain('Sites and burden')
    expect(made.get('a').attributes('href')).toBe('/library/sites-and-burden')
  })

  it('keeps the selection when the set cannot be made', async () => {
    mockedCreate.mockRejectedValue(new Error('A set called that already exists.'))
    const w = await mountPane()
    await w.findAll('[data-testid="set-layer"] input[type="checkbox"]')[0].setValue(true)
    await w.get('[data-testid="explore-name"]').setValue('Taken')
    // Submit the form, not the button: a click on a submit button does not
              // submit in jsdom.
    await w.get('[data-testid="explore-save"]').trigger('submit')
    await flushPromises()

    expect(w.get('[data-testid="explore-error"]').text()).toContain('already exists')
    // Losing the layers somebody just picked because the name clashed would
    // make them do the whole job again.
    expect(w.get('[data-testid="explore-chosen"]').text()).toContain('Candidate sites')
  })

  it('offers the old link instead when there is no room for a map', async () => {
    restoreViewport()
    stubViewportWidth(600)
    const w = await mountPane()
    expect(w.find('[data-testid="explore-pane"]').exists()).toBe(false)
    expect(w.get('[data-testid="explore-too-narrow"]').get('a').attributes('href')).toBe('/')
  })
})
