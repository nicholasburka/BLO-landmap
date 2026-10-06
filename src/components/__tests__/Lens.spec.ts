import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Lens from '../Lens.vue'

/**
 * P5-74. "Save view" moved off the map and into the panel, as a row under the
 * tabs — internal users only. The public map's panel has to be unchanged by
 * that, so this file does for the Lens what `App.spec.ts` does for the header:
 * it pins the logged-out markup as a string. Any tag, class, attribute or text
 * that appears in the panel for a visitor breaks this test on purpose.
 *
 * Two kinds of noise are stripped first, because a byte-contract must not
 * depend on them: the scoped-style hash (it changes whenever the file's
 * contents change) and authored HTML comments (they are documentation). Vue's
 * own `<!--v-if-->` placeholders stay — where a conditional node would be is
 * part of the contract, exactly as it is for the header.
 */
function panelMarkup(html: string): string {
  return html
    .replace(/ data-v-[0-9a-f]+=""/g, '')
    .replace(/<!--(?!v-if-->)[\s\S]*?-->/g, '')
}

const LOGGED_OUT_PANEL =
  '<aside class="lens blo-panel" role="region" aria-label="Map context — what you\'re looking at">' +
  '<header class="lens-header" tabindex="-1"><!--v-if--><span class="lens-header-fallback">Context</span>' +
  '</header><div id="lens-tabs-and-body" class="lens-tabs-and-body">' +
  '<div class="lens-tabs" role="tablist" aria-label="Lens views">' +
  '<button id="lens-tab-legend" type="button" role="tab" aria-selected="true" aria-controls="lens-panel-legend" tabindex="0" class="lens-tab lens-tab--active">Legend' +
  '</button>' +
  '<button id="lens-tab-layers" type="button" role="tab" aria-selected="false" aria-controls="lens-panel-layers" tabindex="-1" class="lens-tab">Layers' +
  '</button>' +
  '<button id="lens-tab-context" type="button" role="tab" aria-selected="false" aria-controls="lens-panel-context" tabindex="-1" class="lens-tab">Context' +
  '</button></div><!--v-if--><div class="lens-body">' +
  '<transition-stub name="lens-fade" mode="out-in" appear="false" persisted="false" css="true">' +
  '<section id="lens-panel-legend" role="tabpanel" aria-labelledby="lens-tab-legend" class="lens-panel">' +
  '<p class="lens-placeholder">Legend content here.</p></section></transition-stub></div></div></aside>'

const actionsSlot = { actions: '<button data-testid="save-view">Save view</button>' }

describe('Lens panel (P5-74)', () => {
  it('leaves the logged-out panel byte-for-byte unchanged', () => {
    const w = mount(Lens)
    expect(panelMarkup(w.get('aside').element.outerHTML)).toBe(LOGGED_OUT_PANEL)
    w.unmount()
  })

  it('renders no action row — not even its wrapper — when the host has none', () => {
    // Map.vue always passes the slot and gates it with `:actions`, so "the
    // slot exists" must not be enough to put a bordered strip in the panel.
    const w = mount(Lens, { slots: actionsSlot })
    expect(w.find('[data-testid="lens-actions"]').exists()).toBe(false)
    expect(w.find('[data-testid="save-view"]').exists()).toBe(false)
    expect(panelMarkup(w.get('aside').element.outerHTML)).toBe(LOGGED_OUT_PANEL)
    w.unmount()
  })

  it('puts the action row between the tabs and the body for an internal user', () => {
    const w = mount(Lens, { props: { actions: true }, slots: actionsSlot })
    const row = w.get('[data-testid="lens-actions"]')
    expect(row.get('[data-testid="save-view"]').text()).toBe('Save view')
    const children = [...w.get('.lens-tabs-and-body').element.children].map(el => el.className)
    expect(children).toEqual(['lens-tabs', 'lens-actions', 'lens-body'])
    w.unmount()
  })
})
