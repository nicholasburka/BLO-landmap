import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('@/lib/apiBase', () => ({
  internalFetch: vi.fn(),
  setInternalCsrfToken: vi.fn(),
  API_URL: '',
}))

import MapPane from '../MapPane.vue'
import { useMapState, type MapState } from '@/composables/useMapState'

/**
 * P6-14. The chrome around the canvas — the header, the X, the box that gives
 * mapbox-gl a height — lifted out of `ChatView` so four pages can mount a
 * pane without copying the chat page's markup.
 *
 * `MapCanvas` is an async component inside this one, so an un-awaited mount
 * renders the chrome and a placeholder: every test here is about the chrome,
 * and none of them needs a WebGL context.
 */

let state: MapState

beforeEach(() => {
  state = useMapState()
})

function paneWith(props: Record<string, unknown> = {}) {
  return mount(MapPane, {
    props: { layers: state.layers, query: state.query, data: state.data, ...props },
  })
}

describe('MapPane (P6-14)', () => {
  it('names the layer it is drawing', () => {
    const w = paneWith()
    expect(w.get('[data-testid="map-pane-layer"]').text()).toBe('BLO Livability Index')
  })

  it('takes a title when the layer name is not what the page means', () => {
    const w = paneWith({ title: 'Median Home Value · Life Expectancy' })
    expect(w.get('[data-testid="map-pane-layer"]').text()).toBe('Median Home Value · Life Expectancy')
  })

  it('says what it is framed on when the page gives it a note', () => {
    const w = paneWith({ note: '18 of 3,142 counties' })
    expect(w.get('[data-testid="map-pane-note"]').text()).toBe('18 of 3,142 counties')
  })

  it('leaves the note out rather than printing an empty line', () => {
    expect(paneWith().find('[data-testid="map-pane-note"]').exists()).toBe(false)
  })

  it('asks to be closed and does not close itself — the host owns whether it exists', async () => {
    const w = paneWith()
    await w.get('[data-testid="map-pane-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    // Still mounted: a component that removed itself would leave the host
    // thinking a pane was open.
    expect(w.find('[data-testid="map-pane"]').exists()).toBe(true)
  })

  it('derives every test id from one, so a host can name its own pane', () => {
    const w = paneWith({ testid: 'dataset-map-pane', note: '50 of 3,142 rows' })
    expect(w.find('[data-testid="dataset-map-pane"]').exists()).toBe(true)
    expect(w.find('[data-testid="dataset-map-pane-layer"]').exists()).toBe(true)
    expect(w.find('[data-testid="dataset-map-pane-close"]').exists()).toBe(true)
    expect(w.find('[data-testid="dataset-map-pane-note"]').exists()).toBe(true)
  })

  it('is a landmark with a name, and its X says what it closes', () => {
    const w = paneWith({ label: 'These rows on the map' })
    const pane = w.get('[data-testid="map-pane"]')
    expect(pane.element.tagName).toBe('ASIDE')
    expect(pane.attributes('aria-label')).toBe('These rows on the map')
    expect(w.get('[data-testid="map-pane-close"]').attributes('aria-label')).toBe('Close the map')
  })

  it('loads the canvas on demand, so mounting the chrome costs no mapbox-gl', () => {
    const w = paneWith()
    // The async component has not resolved, so there is no canvas yet — which
    // is the same reason no county file has been asked for.
    expect(w.find('[data-testid="map-canvas"]').exists()).toBe(false)
    expect(w.find('.pane-map').exists()).toBe(true)
  })
})
