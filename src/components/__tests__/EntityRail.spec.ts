import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EntityRail from '../EntityRail.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { ENTITY_ROWS_MAX, type EntityRailLayer } from '@/lib/entityRail'

const RouterLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }
const mountOpts = { global: { stubs: { RouterLink: RouterLinkStub } } }

function feature(label: string, extra: Record<string, string> = {}) {
  return { type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [-84, 33] as [number, number] }, properties: { _label: label, ...extra } }
}

const orgs: EntityRailLayer = {
  geometry: 'point',
  id: 'internal-organizations',
  slug: 'organizations',
  name: 'Organizations (HQ)',
  color: '#ff6b1c',
  popupFields: ['Tier', 'HQ City'],
  features: [
    feature('Truly Living Well', { Tier: 'Tier 2', 'HQ City': 'Atlanta' }),
    feature('Black Farmer Fund', { Tier: 'Tier 1', 'HQ City': 'New York' }),
    feature('Athens Land Trust', { Tier: 'Tier 3', 'HQ City': 'Athens' }),
  ],
}

describe('EntityRail (P5-28)', () => {
  it('renders nothing when hidden and a sorted list with subtitles when visible', () => {
    expect(mount(EntityRail, { ...mountOpts, props: { visible: false, layers: [orgs], active: null } }).find('[data-testid="entity-rail"]').exists()).toBe(false)
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs], active: null } })
    expect(w.get('.rail-title').text()).toBe('Organizations (HQ)')
    expect(w.get('[data-testid="entity-count"]').text()).toBe('3 entities')
    expect(w.findAll('[data-testid="entity-rail-links"] a').map(a => a.attributes('href'))).toEqual(['/library/organizations', '/library/organizations?tab=data'])
    expect(w.findAll('.rail-row-label').map(e => e.text())).toEqual(['Athens Land Trust', 'Black Farmer Fund', 'Truly Living Well'])
    expect(w.findAll('.rail-row-sub')[1].text()).toBe('Tier 1 · New York')
    expect(w.findAll('.rail-swatch')[0].attributes('style')).toContain('rgb(255, 107, 28)')
  })

  it('searches across the label and popup fields', async () => {
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs], active: null } })
    await w.get('input[type="search"]').setValue('new york')
    expect(w.findAll('.rail-row-label').map(e => e.text())).toEqual(['Black Farmer Fund'])
    expect(w.get('[data-testid="entity-count"]').text()).toBe('1 of 3 match')
    await w.get('input[type="search"]').setValue('zzz')
    expect(w.text()).toContain('No entities match.')
  })

  it('emits select with the layer id + feature index on click and Enter, and dismiss on ×', async () => {
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs], active: null } })
    await w.findAll('.rail-row')[0].trigger('click') // Athens Land Trust = original index 2
    expect(w.emitted('select')).toEqual([[{ layerId: 'internal-organizations', index: 2 }]])
    await w.findAll('.rail-row')[1].trigger('keydown.enter')
    expect(w.emitted('select')![1]).toEqual([{ layerId: 'internal-organizations', index: 1 }])
    await w.get('.rail-exit').trigger('click')
    expect(w.emitted('dismiss')).toHaveLength(1)
  })

  it('highlights the active entity and shows layer names when several layers are on', async () => {
    const gardens: EntityRailLayer = { geometry: 'point', id: 'internal-gardens', slug: 'gardens', name: 'Gardens', color: null, popupFields: [], features: [feature('Zeta Garden')] }
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs, gardens], active: { layerId: 'internal-gardens', index: 0 } } })
    expect(w.get('.rail-title').text()).toBe('2 point layers')
    expect(w.find('[data-testid="entity-rail-links"]').exists()).toBe(false)
    const active = w.get('.rail-row--active')
    expect(active.text()).toContain('Zeta Garden')
    expect(active.text()).toContain('Gardens')
    expect(w.findAll('.rail-row-layer')).toHaveLength(4)
  })

  // P7-3: the rail lists lines as readily as points, and names what it is
  // listing — "3 point layers" over a set that includes a corridor is wrong.
  it('says what geometry it is listing, and "overlay" for a mixed set', () => {
    const lines: EntityRailLayer = {
      geometry: 'line', id: 'internal-transmission', slug: 'transmission', name: 'Transmission lines', color: '#2b6cb0', popupFields: [],
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90, 35], [-89, 36]] }, properties: { _label: 'Allen tie' } },
        { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-91, 34], [-90, 35]]] }, properties: { _label: 'Nucor spur' } },
      ],
    }
    const only = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [lines], active: null } })
    expect(only.get('.rail-eyebrow').text()).toBe('Lines')
    expect(only.get('.rail-title').text()).toBe('Transmission lines')
    expect(only.text()).toContain('Allen tie')
    expect(only.text()).toContain('Nucor spur')

    const both = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs, lines], active: null } })
    expect(both.get('.rail-eyebrow').text()).toBe('Overlays')
    expect(both.get('.rail-title').text()).toBe('2 overlay layers')
  })

  // P7-9: and lists states, by the name each popup is headed with.
  it('lists a state layer as "States", searchable by the state name', async () => {
    const permits: EntityRailLayer = {
      geometry: 'state', id: 'internal-permits', slug: 'permits', name: 'Permitting by state', color: '#2f855a', popupFields: ['Authority'],
      features: [
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-85, 31], [-81, 31], [-81, 35], [-85, 31]]] }, properties: { _state: '13', _label: 'Georgia', Authority: 'Georgia EPD' } },
        { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: [[[[-90, 35], [-82, 35], [-82, 36], [-90, 35]]]] }, properties: { _state: '47', _label: 'Tennessee', Authority: 'TDEC' } },
      ],
    }
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [permits], active: null } })
    expect(w.get('.rail-eyebrow').text()).toBe('States')
    expect(w.findAll('.rail-row-label').map(e => e.text())).toEqual(['Georgia', 'Tennessee'])
    expect(w.findAll('.rail-row-sub')[0].text()).toBe('Georgia EPD')
    const mixed = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs, permits], active: null } })
    expect(mixed.get('.rail-eyebrow').text()).toBe('Overlays')
  })

  it('caps the rendered rows and says so', () => {
    const big: EntityRailLayer = { ...orgs, features: Array.from({ length: ENTITY_ROWS_MAX + 20 }, (_, i) => feature(`E${String(i).padStart(4, '0')}`)) }
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [big], active: null } })
    expect(w.findAll('.rail-row')).toHaveLength(ENTITY_ROWS_MAX)
    expect(w.get('[data-testid="entity-count"]').text()).toContain(`showing the first ${ENTITY_ROWS_MAX}`)
  })

  it('shows a loading state while a layer\'s features are still downloading (UX pass)', () => {
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [{ ...orgs, features: [] }], active: null, loading: true } })
    expect(w.get('[data-testid="entity-loading"]').text()).toBe('Loading entities…')
    expect(w.find('.rail-empty').exists()).toBe(false)
    const done = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [{ ...orgs, features: [] }], active: null, loading: false } })
    expect(done.find('[data-testid="entity-loading"]').exists()).toBe(false)
    expect(done.find('.rail-empty').exists()).toBe(true)
  })
})

/**
 * P5-60 verifies what P5-39 built: the rail really is a bottom sheet on a
 * phone, and the things a thumb has to hit are big enough — the grab handle,
 * the exit, the rows — with the bottom inset clearing a notched phone's home
 * bar. (This is the one map-adjacent component in the mobile pass; it is
 * internal-only, so the public map is untouched.)
 */
const RAIL_SFC = readStyles('src/components/EntityRail.vue')
const RAIL_PHONE = mediaBlock(RAIL_SFC, 768)

describe('EntityRail — bottom sheet (P5-60)', () => {
  it('has a handle that collapses the sheet and says so', async () => {
    const w = mount(EntityRail, { ...mountOpts, props: { visible: true, layers: [orgs], active: null } })
    const handle = w.get('.rail-handle')
    expect(handle.classes()).toContain('touch-target')
    expect(handle.attributes('aria-expanded')).toBe('true')
    await handle.trigger('click')
    expect(w.get('[data-testid="entity-rail"]').classes()).toContain('entity-rail--collapsed')
    expect(handle.attributes('aria-expanded')).toBe('false')
    // Collapsed leaves the handle and the title, and hides the list.
    expect(ruleFor(RAIL_PHONE, '.entity-rail--collapsed .rail-search')).toContain('display: none')
  })

  it('sits on the bottom edge, clear of the home bar', () => {
    const rail = ruleFor(RAIL_PHONE, '.entity-rail')
    expect(rail).toContain('bottom: max(12px, env(safe-area-inset-bottom, 0px))')
    expect(rail).toContain('env(safe-area-inset-bottom')
    // `svh`: measured against the small viewport, so the browser's own bars
    // appearing never push the sheet off screen.
    expect(rail).toContain('max-height: 45svh')
  })

  it('gives the handle, the exit and every row a 44 px target', () => {
    expect(ruleFor(RAIL_PHONE, '.rail-handle')).toContain('min-height: 44px')
    expect(ruleFor(RAIL_PHONE, '.rail-exit')).toContain('min-height: 44px')
    expect(ruleFor(RAIL_PHONE, '.rail-exit')).toContain('min-width: 44px')
    expect(ruleFor(RAIL_PHONE, '.rail-row')).toContain('min-height: 44px')
    expect(ruleFor(RAIL_PHONE, '.rail-links a')).toContain('min-height: 44px')
  })

  it('reads at 14 px and never pushes itself wider than the screen', () => {
    expect(ruleFor(RAIL_PHONE, '.rail-count')).toContain('font-size: 14px')
    expect(ruleFor(RAIL_PHONE, '.rail-search')).toContain('font-size: 16px')
    expect(ruleFor(RAIL_PHONE, '.rail-row-label')).toContain('overflow-wrap: anywhere')
    expect(ruleFor(RAIL_SFC, '.rail-row-text')).toContain('min-width: 0')
  })
})
