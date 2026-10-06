import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import LensLegend from '../LensLegend.vue'
import { registerInternalLayers, unregisterInternalLayers } from '@/lib/internalLayers'

/** P5-18: a single active internal layer drives the legend like any public
 *  layer; with a second layer it falls back to the composite score. */
const base = {
  selectedDemographicLayers: [] as string[],
  selectedEconomicLayers: [] as string[],
  selectedHousingLayers: [] as string[],
  selectedEquityLayers: [] as string[],
  selectedTransportationLayers: [] as string[],
  showContaminationChoropleth: false,
  layerDirections: {},
  layerWeights: {},
  hasActiveFilters: false,
}

afterEach(() => unregisterInternalLayers())

describe('LensLegend with internal layers', () => {
  it('titles the legend with the internal layer when it is the only scoring layer', () => {
    registerInternalLayers([
      { id: 'internal-t', slug: 't', geometry: 'county', name: 'Plan target index', dataType: 'index', unit: 'pts', direction: 'lower_better', range: { min: 0, max: 100 }, description: '', source: '', year: '', dates: {}, file: null, color: null, popupFields: [], bbox: null, updatedAt: null },
    ])
    const w = mount(LensLegend, { props: { ...base, selectedInternalLayers: ['internal-t'] } })
    expect(w.get('.lens-legend-title').text()).toBe('Plan target index')
    // (the gradient itself is an inline background style that jsdom's CSS
    // parser drops, so the title is the observable contract here)
  })

  it('shows the composite scale when an internal layer is combined with a public one', () => {
    registerInternalLayers([
      { id: 'internal-t', slug: 't', geometry: 'county', name: 'Plan target index', dataType: 'index', unit: '', direction: 'higher_better', range: null, description: '', source: '', year: '', dates: {}, file: null, color: null, popupFields: [], bbox: null, updatedAt: null },
    ])
    const w = mount(LensLegend, { props: { ...base, selectedDemographicLayers: ['pct_Black'], selectedInternalLayers: ['internal-t'] } })
    expect(w.get('.lens-legend-title').text()).toContain('Custom score')
    expect(w.text()).toContain('Plan target index') // listed in the score breakdown
  })

  it('ignores the prop when absent (public map)', () => {
    const w = mount(LensLegend, { props: base })
    expect(w.text()).toContain('BLO Livability Index')
  })
})

/**
 * P7-10: a layer says when it is from, in the one place a reader is looking at
 * it — the legend. This is the whole point of the ticket: a date that only
 * exists in a manifest does not answer the complaint.
 */
describe('LensLegend says when the data is from', () => {
  const internal = (over: Record<string, unknown>) =>
    ({
      id: 'internal-t',
      slug: 't',
      geometry: 'county',
      name: 'Data centres',
      dataType: 'count',
      unit: '',
      direction: 'higher_better',
      range: { min: 0, max: 100 },
      description: '',
      source: '',
      year: '',
      dates: {},
      file: null,
      color: null,
      popupFields: [],
      bbox: null,
      updatedAt: null,
      ...over,
    }) as never

  it('says the period a research dataset covers', () => {
    registerInternalLayers([internal({ name: 'Renter households', dates: { covers: '2019/2023' } })])
    const w = mount(LensLegend, { props: { ...base, selectedInternalLayers: ['internal-t'] } })
    expect(w.get('[data-testid="legend-when"]').text()).toBe('Data from 2019–2023')
  })

  it('says AS OF for a living inventory, which is the other of Nick’s two cases', () => {
    // "either a last updated (in the case of data centers) or published date
    // (in the case of research datasets)" — one field, and the value's own
    // grammar decides which sentence it earns.
    registerInternalLayers([internal({ dates: { covers: '2026-10' } })])
    const w = mount(LensLegend, { props: { ...base, selectedInternalLayers: ['internal-t'] } })
    expect(w.get('[data-testid="legend-when"]').text()).toBe('As of October 2026')
  })

  it('falls back to a release date, which is the one that goes stale', () => {
    registerInternalLayers([internal({ dates: { published: '2019-06' } })])
    const w = mount(LensLegend, { props: { ...base, selectedInternalLayers: ['internal-t'] } })
    expect(w.get('[data-testid="legend-when"]').text()).toBe('Published June 2019')
  })

  it('says nothing at all for a layer that says nothing — an untagged layer is not a defect', () => {
    registerInternalLayers([internal({})])
    const w = mount(LensLegend, { props: { ...base, selectedInternalLayers: ['internal-t'] } })
    expect(w.find('[data-testid="legend-when"]').exists()).toBe(false)
  })

  it('reads a public registry layer’s declared year with nothing added to the registry', () => {
    // All 26 public layers have declared a `year` since long before this
    // ticket, and a declared vintage IS the period the data describes.
    const w = mount(LensLegend, { props: { ...base, selectedDemographicLayers: ['pct_Black'] } })
    expect(w.get('[data-testid="legend-when"]').text()).toMatch(/^Data from \d{4}/)
  })

  it('never shows an updatedAt as the layer’s date', () => {
    // It says when the bytes last moved in our storage; a re-push of a 2019
    // file would make the legend read 2026. `toLayerDefinition` has always
    // dropped it, so the legend cannot read it even by accident.
    registerInternalLayers([internal({ updatedAt: '2026-10-06T00:00:00.000Z' })])
    const w = mount(LensLegend, { props: { ...base, selectedInternalLayers: ['internal-t'] } })
    expect(w.find('[data-testid="legend-when"]').exists()).toBe(false)
    expect(w.text()).not.toContain('2026')
  })

  /**
   * The case the ticket exists for: two layers drawn together, a decade apart,
   * and the reader could not tell. The composite breakdown already enumerates
   * the contributing layers, so one date per row makes both legible.
   */
  it('gives every layer in a composite its own date, so two periods are both legible', () => {
    registerInternalLayers([internal({ name: 'Data centres', dates: { covers: '2026-10' } })])
    const w = mount(LensLegend, {
      props: { ...base, selectedDemographicLayers: ['pct_Black'], selectedInternalLayers: ['internal-t'] },
    })
    // No single date over a composite — that would be a claim about neither.
    expect(w.find('[data-testid="legend-when"]').exists()).toBe(false)
    const dates = w.findAll('[data-testid="legend-breakdown-when"]').map(el => el.text())
    expect(dates).toHaveLength(2)
    expect(dates).toContain('October 2026')
    // The public layer's own vintage is the other one, and it is a different
    // year — which is exactly what a reader has to be able to see.
    expect(dates.filter(d => d !== 'October 2026')[0]).toMatch(/^\d{4}$/)
    // The full sentence is on hover, so the compact form cannot mislead.
    expect(w.findAll('[data-testid="legend-breakdown-when"]').map(el => el.attributes('title'))).toContain('As of October 2026')
  })

  it('leaves a row blank rather than guessing when one layer says nothing', () => {
    registerInternalLayers([internal({ dates: {} })])
    const w = mount(LensLegend, {
      props: { ...base, selectedDemographicLayers: ['pct_Black'], selectedInternalLayers: ['internal-t'] },
    })
    expect(w.findAll('[data-testid="legend-breakdown-when"]')).toHaveLength(1)
  })
})
