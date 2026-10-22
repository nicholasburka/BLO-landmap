import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LensHeader from '../LensHeader.vue'
import { readStyles, ruleFor } from '@/testing/sfcStyles'
import type { ScoringFilter } from '@/types/mapTypes'

/**
 * P15-4 — the way back to the welcome.
 *
 * Dismissal is permanent per browser and `WelcomeCard` left no route back at
 * all, so the overlay that replaced it would have been a screen you can only
 * ever lose: *"click the thing that explains it"* has no referent for anyone
 * recommending the map to a colleague. The Lens header is where that route
 * lives, and these tests pin the three things about it that would otherwise
 * drift — that it is there in both of the header's states, that it is a Show
 * rather than another pill, and that tapping it does not also work the phone
 * drawer it sits inside.
 */

/** The header's own prop shape. LensHeader declares it inline and exports
 *  nothing, and leaving the two fixtures below to inference types the empty
 *  arrays as `never[]` — so the querying case cannot be handed to the same
 *  `mount` call as the resting one. */
interface HeaderProps {
  scoringChips: { id: string; name: string; arrow: string; directionClass: string }[]
  activeFilters: ScoringFilter[]
  limit: number | null
  defaultLayerName: string
}

/** No query yet: the state a first-time visitor's Lens is actually in. */
const AT_REST: HeaderProps = {
  scoringChips: [],
  activeFilters: [],
  limit: null,
  defaultLayerName: 'BLO Livability Index',
}

/** A query running, which swaps the whole header for its two-row layout. */
const QUERYING: HeaderProps = {
  ...AT_REST,
  scoringChips: [
    { id: 'pct_Black', name: 'Black Population Rate', arrow: '↑', directionClass: 'dir-higher' },
  ],
  limit: 10,
}

describe('LensHeader — the way back to the welcome (P15-4)', () => {
  it('offers it whether or not a query is running', () => {
    for (const props of [AT_REST, QUERYING]) {
      const w = mount(LensHeader, { props })
      expect(w.get('[data-testid="lens-what-is-this"]').text()).toBe('What is this?')
      w.unmount()
    }
  })

  it('asks the host to re-open, and decides nothing itself', async () => {
    const w = mount(LensHeader, { props: AT_REST })
    await w.get('[data-testid="lens-what-is-this"]').trigger('click')
    expect(w.emitted('what-is-this')).toHaveLength(1)
    // Emphatically not `clear`: re-opening the welcome must not reset the
    // map, and the two controls sit inches apart.
    expect(w.emitted('clear')).toBeUndefined()
    w.unmount()
  })

  /**
   * "A Show, and a small one" (P15-4). `Clear ×` next to it is a bordered
   * pill because resetting the map and the conversation is a consequence;
   * re-reading an onboarding screen is not, and P9-13's rule is that the
   * heavier vocabulary means something.
   */
  it('wears the quiet text vocabulary, not the pill beside it', () => {
    const w = mount(LensHeader, { props: QUERYING })
    const classes = w.get('[data-testid="lens-what-is-this"]').classes()
    expect(classes).toContain('blo-type-action')
    expect(classes).not.toContain('lens-hd-clear')
    expect(classes).not.toContain('blo-act')
    w.unmount()
  })

  /**
   * On a phone the entire header strip is the drawer's expand target
   * (`Lens.vue`'s `onHeaderClick`), so a control inside it that lets its
   * click through does two things at once — re-opens the welcome AND slides
   * the panel open underneath it. `Clear ×` has carried `@click.stop` for
   * the same reason since it shipped.
   */
  it('does not also work the drawer it sits inside', async () => {
    const bubbled = vi.fn()
    const w = mount(LensHeader, { props: AT_REST, attachTo: document.body })
    w.element.parentElement!.addEventListener('click', bubbled)

    await w.get('[data-testid="lens-what-is-this"]').trigger('click')
    expect(bubbled).not.toHaveBeenCalled()

    // The control case, so this test fails for the right reason: an
    // ordinary click anywhere else in the header does reach the strip.
    await w.get('.lens-hd-default').trigger('click')
    expect(bubbled).toHaveBeenCalledTimes(1)

    w.element.parentElement!.removeEventListener('click', bubbled)
    w.unmount()
  })

  /** jsdom parses no stylesheets, so the reset itself is the assertion. */
  it('resets only the chrome a <button> brings, never the type', () => {
    const rule = ruleFor(readStyles('src/components/LensHeader.vue'), '.lens-hd-what')
    // A UA button's font family, border, padding and background have to go.
    expect(rule).toMatch(/font-family:\s*inherit/)
    expect(rule).toMatch(/border:\s*none/)
    // Size, weight and colour must NOT be restated: scoped styles outrank
    // `.blo-type-action`, so a font-size here would quietly opt this control
    // out of the vocabulary its class says it wears.
    expect(rule).not.toMatch(/font-size:/)
    expect(rule).not.toMatch(/font-weight:/)
    expect(rule).not.toMatch(/(^|[^-])color:/)
  })
})
