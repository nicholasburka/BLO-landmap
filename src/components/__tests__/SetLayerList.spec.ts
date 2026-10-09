import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { useMapState } from '@/composables/useMapState'
import { clearInternalLayerCache, type InternalLayerManifestEntry } from '@/lib/internalLayers'
import SetLayerList from '../SetLayerList.vue'

/**
 * P9-2. Once a set's layers actually drew (P9-1, P9-1b), the map was
 * unreadable: two dense national line networks and thousands of clustered
 * points, with no way to say what any of them were or to turn one off.
 *
 * This is the public map's layer-by-layer display and toggling, scoped to the
 * one set — reusing the state and the toggle semantics rather than the public
 * panel's markup, which carries weights, filters and contamination with it.
 */

const COUNTY: InternalLayerManifestEntry = {
  id: 'internal-cejst', slug: 'cejst', name: 'Disadvantaged share (CEJST)',
  geometry: 'county', dataType: 'percentage', unit: '%', direction: 'lower_better',
  range: { min: 0, max: 100 }, description: '', source: '', year: 2022, file: null,
  color: null, popupFields: [], bbox: null, updatedAt: '2026-10-07T00:00:00.000Z',
}
const LINE: InternalLayerManifestEntry = {
  ...COUNTY, id: 'internal-transmission', slug: 'transmission',
  name: 'Transmission lines (345 kV+)', geometry: 'line', color: '#b45309',
}
const POINT: InternalLayerManifestEntry = {
  ...COUNTY, id: 'internal-plants', slug: 'plants',
  name: 'Power plants', geometry: 'point', color: '#dc2626',
}

beforeEach(() => clearInternalLayerCache())
afterEach(() => { vi.restoreAllMocks(); clearInternalLayerCache() })

/** Mount over a real map state with the manifest already registered. */
function mountList(ids: string[], manifest: InternalLayerManifestEntry[]) {
  const state = useMapState()
  // the shapes the state exposes, populated as loadInternalLayers would
  ;(state.layers.pointDefinitions as { value: unknown }).value = manifest
    .filter(e => e.geometry !== 'county')
    .map(e => ({
      id: e.id, slug: e.slug, geometry: e.geometry, name: e.name, description: '',
      source: '', color: e.color, popupFields: [], detailFields: [], width: null,
    }))
  ;(state.layers.internalDefinitions as { value: unknown }).value = manifest
    .filter(e => e.geometry === 'county')
    .map(e => ({ id: e.id, name: e.name, unit: e.unit, range: e.range }))
  const wrapper = mount(SetLayerList, { props: { layers: state.layers, ids } })
  return { wrapper, state }
}

describe('SetLayerList (P9-2)', () => {
  it('names every layer the set holds, instead of a count', () => {
    const { wrapper } = mountList(
      ['internal-transmission', 'internal-plants', 'internal-cejst'],
      [LINE, POINT, COUNTY],
    )
    const text = wrapper.text()
    expect(text).toContain('Transmission lines (345 kV+)')
    expect(text).toContain('Power plants')
    expect(text).toContain('Disadvantaged share (CEJST)')
  })

  it('says what shape each one is, because that is why they look different', () => {
    const { wrapper } = mountList(['internal-transmission', 'internal-plants'], [LINE, POINT])
    const rows = wrapper.findAll('[data-testid="set-layer"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('line')
    expect(rows[1].text()).toContain('point')
  })

  it('carries each layer\'s own colour, so the list reads against the map', () => {
    const { wrapper } = mountList(['internal-transmission'], [LINE])
    const swatch = wrapper.get('[data-testid="set-layer-swatch"]')
    expect(swatch.attributes('style')).toContain('rgb(180, 83, 9)')
  })

  it('toggles a feature layer through the same state the public map uses', async () => {
    const { wrapper, state } = mountList(['internal-plants'], [POINT])
    expect(state.layers.points.value).not.toContain('internal-plants')

    await wrapper.get('[data-testid="set-layer"] input').setValue(true)

    expect(state.layers.points.value).toContain('internal-plants')
  })

  it('toggles a county layer down the internal path, not the feature path', async () => {
    const { wrapper, state } = mountList(['internal-cejst'], [COUNTY])
    await wrapper.get('[data-testid="set-layer"] input').setValue(true)

    expect(state.layers.internal.value).toContain('internal-cejst')
    expect(state.layers.points.value).not.toContain('internal-cejst')
  })

  /** A set may name a layer the library no longer has (P6-23's rule: a count
   *  may not disagree with the list it opens). Say so rather than drop it. */
  it('names a layer the manifest does not describe rather than hiding it', () => {
    const { wrapper } = mountList(['internal-transmission', 'internal-gone'], [LINE])
    expect(wrapper.text()).toContain('internal-gone')
    expect(wrapper.get('[data-testid="set-layer-missing"]').text()).toContain('not in the library')
  })
})
