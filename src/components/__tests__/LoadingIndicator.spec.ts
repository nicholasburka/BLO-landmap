import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LoadingIndicator from '../LoadingIndicator.vue'
import { readStyles, ruleFor } from '@/testing/sfcStyles'

/**
 * P5-74. The overlay used to sit over the map until all five contamination
 * GeoJSONs (24 MB) had been fetched and parsed — 38 s in Nick's Chrome — and
 * it swallowed every click for that whole time. It now reports the county
 * dataset and nothing else, and it never takes a click.
 */
describe('LoadingIndicator (P5-74)', () => {
  it('never blocks the map underneath it', () => {
    const css = readStyles('src/components/LoadingIndicator.vue')
    expect(ruleFor(css, '.loading-overlay')).toContain('pointer-events: none')
  })

  it('reports the county data, not "layers"', () => {
    const w = mount(LoadingIndicator, { props: { loaded: false, progress: 50 } })
    expect(w.get('.loading-text').text()).toBe('Loading counties…')
    expect(w.text()).not.toContain('layers')
    expect(w.get('.progress').attributes('style')).toContain('width: 50%')
    w.unmount()
  })

  it('is gone once the choropleth can paint', () => {
    const w = mount(LoadingIndicator, { props: { loaded: true, progress: 100 } })
    expect(w.find('.loading-overlay').exists()).toBe(false)
    w.unmount()
  })
})
