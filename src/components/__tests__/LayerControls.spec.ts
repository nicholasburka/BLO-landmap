import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LayerControls from '../LayerControls.vue'
import type { LayerDefinition } from '@/config/layerRegistry'

/** P5-18: the Internal section exists only when the (logged-in-only) prop is
 *  non-empty; toggling emits `toggle-internal` with the layer id. */
const internalDef: LayerDefinition = {
  id: 'internal-target-index',
  name: 'Target index',
  category: 'internal',
  dataType: 'index',
  direction: 'higher_better',
  unit: '',
  range: { min: 0, max: 100 },
  description: 'Where to look first.',
  source: 'BLO internal',
  year: 2026,
  dataPath: '',
  dataKey: 'target-index',
  gradient: { css: '', lowLabel: 'Lower', highLabel: 'Higher' },
  formatValue: v => String(v),
}

const RouterLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }
const mountOpts = { global: { stubs: { RouterLink: RouterLinkStub } } }

const baseProps = {
  demographicLayers: [],
  selectedDemographicLayers: [],
  showContaminationLayers: false,
  showContaminationChoropleth: false,
}

describe('LayerControls — internal section (P5-18)', () => {
  it('renders nothing internal when the prop is absent or empty (public map)', () => {
    for (const props of [baseProps, { ...baseProps, internalLayers: [] }]) {
      const w = mount(LayerControls, { props, ...mountOpts })
      expect(w.find('[data-testid="internal-layers-header"]').exists()).toBe(false)
      expect(w.text()).not.toContain('Internal')
    }
  })

  it('lists internal layers with their description tooltip and emits toggle-internal', async () => {
    const w = mount(LayerControls, {
      props: { ...baseProps, internalLayers: [internalDef], selectedInternalLayers: [] },
      ...mountOpts,
    })
    expect([...w.get('[data-testid="internal-layer-links"]').findAll('a')].map(a => a.attributes('href'))).toEqual(['/library/target-index', '/library/target-index?tab=data'])
    expect(w.get('[data-testid="internal-layers-header"]').text()).toContain('Internal')
    const box = w.get('#internal-target-index')
    expect((box.element as HTMLInputElement).checked).toBe(false)
    expect(w.get('#tooltip-internal-target-index').text()).toContain('Where to look first. (BLO internal)')
    await box.trigger('change')
    expect(w.emitted('toggle-internal')).toEqual([['internal-target-index']])
  })

  it('reflects selection and shows scoring controls for a selected internal layer', () => {
    const w = mount(LayerControls, {
      props: {
        ...baseProps,
        internalLayers: [internalDef],
        selectedInternalLayers: ['internal-target-index'],
        showScoringControls: true,
        layerWeights: { 'internal-target-index': 7 },
      },
      ...mountOpts,
    })
    expect((w.get('#internal-target-index').element as HTMLInputElement).checked).toBe(true)
    // LayerScoringControls mounts for selected layers (weight slider present)
    expect(w.find('[data-testid="internal-layers"] input[type="range"]').exists()).toBe(true)
  })

  it('lists point layers with a swatch inside the Internal section and emits toggle-internal-point (P5-24)', async () => {
    const w = mount(LayerControls, {
      props: {
        ...baseProps,
        internalPointLayers: [{ geometry: 'point', width: null, id: 'internal-orgs-hq', slug: 'orgs-hq', name: 'Organizations (HQ)', description: 'HQ points', source: 'BLO research', color: '#123456', popupFields: ['Tier'], detailFields: [] }],
        selectedInternalFeatureLayers: [],
      },
      ...mountOpts,
    })
    expect(w.get('[data-testid="internal-layers-header"]').text()).toContain('Internal')
    const item = w.get('[data-testid="internal-point-layer"]')
    expect(item.findAll('[data-testid="internal-layer-links"] a').map(a => a.attributes('href'))).toEqual(['/library/orgs-hq', '/library/orgs-hq?tab=data'])
    expect(item.text()).toContain('Organizations (HQ)')
    expect(item.get('.point-swatch').attributes('style')).toContain('rgb(18, 52, 86)')
    expect(item.find('input[type="range"]').exists()).toBe(false) // overlays don't score
    await item.get('input[type="checkbox"]').trigger('change')
    expect(w.emitted('toggle-internal-point')).toEqual([['internal-orgs-hq']])
  })

  // P7-9: a state layer's swatch is the third shape — an area, drawn at the
  // wash's own opacity inside a solid border, which is the two paint layers
  // the map draws for it.
  it('draws a state layer\'s swatch as an area', () => {
    const w = mount(LayerControls, {
      props: {
        ...baseProps,
        internalPointLayers: [
          { geometry: 'state', width: null, id: 'internal-permits', slug: 'permits', name: 'Permitting by state', description: '', source: '', color: '#2f855a', popupFields: [], detailFields: ['Process'] },
        ],
        selectedInternalFeatureLayers: ['internal-permits'],
      },
      ...mountOpts,
    })
    const swatch = w.get('[data-testid="internal-point-layer"] .point-swatch')
    expect(swatch.classes()).toContain('state-swatch')
    expect(swatch.classes()).not.toContain('line-swatch')
    expect(swatch.attributes('style')).toContain('rgb(47, 133, 90)')
    // Still an overlay: no weight slider.
    expect(w.find('[data-testid="internal-point-layer"] input[type="range"]').exists()).toBe(false)
  })

  // P7-3: the swatch is the only thing in the panel that says which overlay
  // will draw as a corridor rather than as dots, so it is drawn as a stroke.
  it('draws a line layer\'s swatch as a stroke, beside a point layer\'s dot', () => {
    const w = mount(LayerControls, {
      props: {
        ...baseProps,
        internalPointLayers: [
          { geometry: 'point', width: null, id: 'internal-orgs-hq', slug: 'orgs-hq', name: 'Organizations (HQ)', description: '', source: '', color: '#123456', popupFields: [], detailFields: [] },
          { geometry: 'line', width: 3, id: 'internal-transmission', slug: 'transmission', name: 'Transmission lines', description: '', source: '', color: '#2b6cb0', popupFields: [], detailFields: [] },
        ],
        selectedInternalFeatureLayers: ['internal-transmission'],
      },
      ...mountOpts,
    })
    const items = w.findAll('[data-testid="internal-point-layer"]')
    expect(items).toHaveLength(2)
    expect(items[0].get('.point-swatch').classes()).not.toContain('line-swatch')
    expect(items[1].get('.point-swatch').classes()).toContain('line-swatch')
    expect(items[1].text()).toContain('Transmission lines')
    // An overlay is an overlay: a line gets no weight slider either.
    expect(items[1].find('input[type="range"]').exists()).toBe(false)
    expect((items[1].get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('puts the Internal section above the public categories (UX pass)', () => {
    const w = mount(LayerControls, {
      props: {
        ...baseProps,
        demographicLayers: [{ id: 'pct_Black', name: 'Percent Black', category: 'Demographics', visible: false }],
        internalLayers: [internalDef],
        selectedInternalLayers: [],
      },
      ...mountOpts,
    })
    const headers = w.findAll('.category-header').map(h => h.text().replace('▶', '').trim())
    expect(headers[0]).toBe('Internal')
    expect(headers).toContain('Demographics')
  })
})

/**
 * P5-74: a contamination GeoJSON is fetched the first time its checkbox goes
 * on, so the row has to say what is happening — and give the user a way back
 * in when the download fails.
 */
describe('LayerControls — contamination rows load on demand (P5-74)', () => {
  const site = (status?: 'loading' | 'loaded' | 'error', visible = false) => ({
    id: 'superfund_sites',
    name: 'Superfund Sites',
    file: '/datasets/epa-contamination/superfund_sites.geojson',
    color: '#FFFF00',
    visible,
    status,
  })

  const withSites = (layer: ReturnType<typeof site>) =>
    mount(LayerControls, { props: { ...baseProps, contaminationLayers: [layer] }, ...mountOpts })

  it('shows nothing extra on a layer nobody has asked for', () => {
    const w = withSites(site())
    expect(w.find('[data-testid="contamination-loading"]').exists()).toBe(false)
    expect(w.find('[data-testid="contamination-error"]').exists()).toBe(false)
    expect((w.get('#superfund_sites').element as HTMLInputElement).disabled).toBe(false)
    w.unmount()
  })

  it('says "Loading…" on the row, checkbox on but held, while the GeoJSON is on the way', () => {
    const w = withSites(site('loading', true))
    expect(w.get('[data-testid="contamination-loading"]').text()).toBe('Loading…')
    const box = w.get('#superfund_sites').element as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    w.unmount()
  })

  it('offers a retry when the download failed, with the layer back off', async () => {
    const w = withSites(site('error'))
    const retry = w.get('[data-testid="contamination-error"]')
    expect(retry.text()).toBe('Could not load — try again')
    expect((w.get('#superfund_sites').element as HTMLInputElement).checked).toBe(false)
    await retry.trigger('click')
    expect(w.emitted('retry-contamination')).toEqual([['superfund_sites']])
    expect(w.emitted('toggle-contamination')).toBeUndefined()
    w.unmount()
  })

  it('is a plain row again once the layer is loaded, and toggling emits toggle-contamination', async () => {
    const w = withSites(site('loaded', true))
    expect(w.find('[data-testid="contamination-loading"]').exists()).toBe(false)
    expect(w.find('[data-testid="contamination-error"]').exists()).toBe(false)
    await w.get('#superfund_sites').trigger('change')
    expect(w.emitted('toggle-contamination')).toEqual([['superfund_sites']])
    w.unmount()
  })
})
