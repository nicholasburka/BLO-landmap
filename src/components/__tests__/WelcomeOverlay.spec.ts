import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, RouterLinkStub, flushPromises } from '@vue/test-utils'
import WelcomeOverlay from '../WelcomeOverlay.vue'
import { lockBodyScroll, unlockBodyScroll, resetBodyScrollLock } from '@/lib/scrollLock'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'
import { readStyles, ruleFor, mediaBlock } from '@/testing/sfcStyles'

/**
 * P15-3 — the public map's welcome.
 *
 * Three doors, each of which DOES the thing rather than describing it. The
 * component only says which was pressed; `Map.vue` owns what each means.
 */
/** Rendered copy as a reader sees it: the template's line breaks collapsed. */
const copyOf = (text: string) => text.replace(/\s+/g, ' ').trim()

async function mountOverlay(width = 1280) {
  stubViewportWidth(width)
  const w = mount(WelcomeOverlay, {
    attachTo: document.body,
    global: { stubs: { RouterLink: RouterLinkStub } },
  })
  await flushPromises()
  return w
}

describe('WelcomeOverlay (P15-3)', () => {
  beforeEach(() => resetBodyScrollLock())
  afterEach(() => {
    restoreViewport()
    resetBodyScrollLock()
    document.body.innerHTML = ''
  })

  it('says the words that were signed off', async () => {
    const w = await mountOverlay()
    expect(w.get('[data-testid="welcome-title"]').text()).toBe(
      "Welcome to BLO's Black Livability Data Map",
    )
    expect(w.get('[data-testid="welcome-door-rankings"]').text()).toBe('See the rankings')
    expect(w.get('[data-testid="welcome-door-ask"]').text()).toBe('Try this question')
    expect(w.get('[data-testid="welcome-door-measures"]').text()).toBe('Choose your measures')
    expect(w.get('[data-testid="welcome-skip"]').text()).toBe('Just show me the map')
    expect(w.get('[data-testid="welcome-about"]').text()).toBe('How the score works \u2192')
    w.unmount()
  })

  /**
   * The seeded question is the whole reason door ② exists — the placeholder's
   * own examples understate what the server will take — so it is signed-off
   * copy too, and the quote marks are part of it. They are literal text
   * rather than a `<q>` element's generated content for exactly this reason:
   * `::before` content is not in `textContent`, so copy rendered that way is
   * copy no test can read back.
   */
  it('seeds the worked question, quote marks and all', async () => {
    const w = await mountOverlay()
    const bodies = w.findAll('.welcome-door-body')
    expect(copyOf(bodies[1].text())).toBe(
      '\u201ctop 10 affordable Southeast counties with high Black population\u201d' +
        ' \u2014 the map answers by redrawing itself.',
    )
    w.unmount()
  })

  it('links to the methodology rather than explaining it here', async () => {
    const w = await mountOverlay()
    expect(w.findComponent(RouterLinkStub).props('to')).toBe('/about')
    w.unmount()
  })

  /**
   * The second rule P15-3 pins as a test, because it is the one most likely
   * to drift: nothing in the copy may promise a layer the public map has not
   * got. There is no heirs'-property layer, no flood-risk layer and no
   * Black-land-ownership acreage layer — "Black Land Ownership" is the
   * publisher name on the composite, not a measured layer.
   */
  it('promises no layer the public map does not have', async () => {
    const w = await mountOverlay()
    const copy = copyOf(w.get('[data-testid="welcome"]').text()).toLowerCase()
    for (const absent of ['heirs', 'flood', 'acre', 'land ownership', 'title']) {
      expect(copy, absent).not.toContain(absent)
    }
    // And every measure door ③ does name, with the layer that backs it. A
    // renamed registry entry fails here rather than in a visitor's face.
    const named: [string, string][] = [
      ['homeownership', 'homeownership_by_race'],
      ['wages', 'avg_weekly_wage'],
      ['pollution', 'contamination'],
      ['life expectancy', 'life_expectancy'],
    ]
    for (const [word, layerId] of named) {
      expect(copy, word).toContain(word)
      expect(LAYER_REGISTRY[layerId], layerId).toBeTruthy()
    }
    w.unmount()
  })

  it('offers the doors in the signed-off order: least setup first', async () => {
    const w = await mountOverlay()
    const order = w.findAll('.welcome-door button').map(b => b.attributes('data-testid'))
    expect(order).toEqual([
      'welcome-door-rankings',
      'welcome-door-ask',
      'welcome-door-measures',
    ])
    w.unmount()
  })

  it('names which door was pressed, and decides nothing itself', async () => {
    const w = await mountOverlay()
    await w.get('[data-testid="welcome-door-rankings"]').trigger('click')
    await w.get('[data-testid="welcome-door-ask"]').trigger('click')
    await w.get('[data-testid="welcome-door-measures"]').trigger('click')
    expect(w.emitted('door')).toEqual([['rankings'], ['ask'], ['measures']])
    w.unmount()
  })

  /**
   * P9-13: "FILL MEANS CONSEQUENCE, and nothing else may use it." These
   * doors change this screen and write nothing anybody else sees. The card
   * this replaces got it wrong — a solid ink pill with no `.blo-act` at all.
   */
  it('wears no fill, because none of it is a write', async () => {
    const w = await mountOverlay()
    for (const id of ['rankings', 'ask', 'measures']) {
      const classes = w.get(`[data-testid="welcome-door-${id}"]`).classes()
      expect(classes, id).toContain('blo-act')
      expect(classes, id).toContain('blo-act--lg')
      expect(classes, id).not.toContain('blo-act--write')
    }
    w.unmount()
  })

  it('closes on Escape, on the backdrop, and on the skip', async () => {
    let w = await mountOverlay()
    await w.get('[data-testid="welcome-skip"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()

    w = await mountOverlay()
    await w.get('[data-testid="welcome-backdrop"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()

    w = await mountOverlay()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })

  it('is a dialog, and takes focus without shouting a control first', async () => {
    const w = await mountOverlay()
    const panel = w.get('[data-testid="welcome"]')
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(panel.attributes('aria-labelledby')).toBe('welcome-title')
    // The title is read before any button.
    expect(document.activeElement).toBe(panel.element)
    w.unmount()
  })

  /**
   * P15-1 landed before this component, and its own docstring names P15-3 as
   * the third copy it exists to prevent. `aria-modal` without a trap is worse
   * than neither: it hides the page from a screen reader while Tab still
   * walks a keyboard out onto a map nothing is announcing.
   */
  it('keeps Tab inside the dialog', async () => {
    const w = await mountOverlay()
    const dialog = w.get('[data-testid="welcome"]')
    const panel = dialog.element

    // Focus starts on the panel itself, and `contains` answers "inside" about
    // an element's own self — so a Shift+Tab from here is precisely the
    // keystroke that leaves a modal that only claims to be one.
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).not.toBe(panel)
    expect(panel.contains(document.activeElement)).toBe(true)

    // And a Tab off the last stop comes round to the first door.
    const stops = [...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
    stops[stops.length - 1].focus()
    await dialog.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(w.get('[data-testid="welcome-door-rankings"]').element)
    w.unmount()
  })

  it('hands focus back on close, and leaves a door to hand it on', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    let w = await mountOverlay()
    expect(document.activeElement).toBe(w.get('[data-testid="welcome"]').element)
    await w.get('[data-testid="welcome-skip"]').trigger('click')
    expect(document.activeElement).toBe(trigger)
    w.unmount()

    // A door is a hand-off, not a close: the host focuses the prompt box, the
    // first layer checkbox or the rankings rail next (P15-3), so returning
    // focus to the trigger first would be a fight it has to win back on the
    // next tick.
    trigger.focus()
    w = await mountOverlay()
    await w.get('[data-testid="welcome-door-ask"]').trigger('click')
    expect(document.activeElement).not.toBe(trigger)
    w.unmount()
  })

  it('locks the page behind it, and lets go on unmount', async () => {
    const w = await mountOverlay()
    expect(document.body.style.overflow).toBe('hidden')
    w.unmount()
    await flushPromises()
    expect(document.body.style.overflow).toBe('')
  })

  it('leaves a lock something else is holding alone when it unmounts', async () => {
    // `scrollLock` is reference-counted for layered sheets, and an overlay
    // that unlocked unconditionally would hand the page back to the scroll
    // wheel underneath whatever is still open.
    lockBodyScroll()
    const w = await mountOverlay()
    w.unmount()
    await flushPromises()
    expect(document.body.style.overflow).toBe('hidden')

    unlockBodyScroll()
    expect(document.body.style.overflow).toBe('')
  })

  it('becomes a sheet on a phone, with a handle', async () => {
    const w = await mountOverlay(390)
    expect(w.get('[data-testid="welcome"]').classes()).toContain('welcome--sheet')
    expect(w.get('[data-testid="welcome-backdrop"]').classes()).toContain('welcome-backdrop--sheet')
    expect(w.find('.welcome-handle').exists()).toBe(true)
    w.unmount()
  })

  it('is a box, not a sheet, on a desktop', async () => {
    const w = await mountOverlay(1280)
    expect(w.get('[data-testid="welcome"]').classes()).not.toContain('welcome--sheet')
    expect(w.find('.welcome-handle').exists()).toBe(false)
    w.unmount()
  })

  /** jsdom computes no layout, so the stylesheet itself is the assertion. */
  describe('the surface it wears', () => {
    const css = readStyles('src/components/WelcomeOverlay.vue')

    it('uses the frosted tier that already exists rather than a new glass', async () => {
      const w = await mountOverlay()
      const classes = w.get('[data-testid="welcome"]').classes()
      expect(classes).toContain('blo-panel')
      expect(classes).toContain('blo-panel--reference')
      w.unmount()
    })

    it('dims with the value both other overlays use', () => {
      expect(ruleFor(css, '.welcome-backdrop')).toContain('rgba(20, 18, 14, 0.35)')
    })

    it('sits above the county loader, which is not a modal', () => {
      expect(ruleFor(css, '.welcome-backdrop')).toMatch(/z-index:\s*1100/)
    })

    it('is two thirds of the window, capped at a readable column', () => {
      expect(ruleFor(css, '.welcome')).toContain('min(720px, 66vw)')
    })

    it('honours reduced motion — the first overlay in the repo to', () => {
      expect(css).toContain('prefers-reduced-motion')
      const reduced = css.slice(css.indexOf('prefers-reduced-motion'))
      expect(reduced).toMatch(/animation:\s*none/)
    })

    it('gives the phone sheet a real height cap', () => {
      expect(ruleFor(css, '.welcome--sheet')).toContain('85svh')
    })

    it('scales the title down on a phone rather than letting it wrap to four lines', () => {
      expect(mediaBlock(css, 640)).toContain('clamp(20px, 6.5vw, 1.7rem)')
    })

    /**
     * The spec's cap is "the doors scrolling inside", not "the panel
     * scrolling". Three doors already pass an 80vh cap on a laptop, and a
     * panel that scrolls as one takes "Just show me the map" — the one
     * guaranteed way out of a modal — below the fold with them.
     */
    it('scrolls the doors, not the whole panel', () => {
      const doors = ruleFor(css, '.welcome-doors')
      expect(doors).toMatch(/overflow-y:\s*auto/)
      // A flex child will not shrink below its content without this, and the
      // overflow walks straight back up to the panel.
      expect(doors).toMatch(/min-height:\s*0/)
    })

    /** `.blo-act` buys the 44px target for the three doors and for nothing in
     *  the footer, because a Show in running text is not a `.blo-act`. */
    it('gives the footer controls a thumb-sized target too', () => {
      const phone = mediaBlock(css, 640)
      expect(phone).toContain('.welcome-skip')
      expect(phone).toContain('.welcome-about')
      expect(phone).toMatch(/min-height:\s*44px/)
    })
  })
})
