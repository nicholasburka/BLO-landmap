import { describe, it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useMapPane, type MapPaneToggle } from '../useMapPane'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'

/**
 * P6-14. The switch behind every "Show on map" pane, tested on its own so the
 * four pages that mount one do not each have to re-prove the breakpoint.
 */

afterEach(restoreViewport)

/** Mount something that holds a pane toggle and hand the toggle back. */
function probe(onClose?: () => void): { pane: MapPaneToggle; unmount: () => void } {
  let pane!: MapPaneToggle
  const wrapper = mount(
    defineComponent({
      setup() {
        pane = useMapPane({ onClose })
        return () => h('span', String(pane.isOpen.value))
      },
    }),
  )
  return { pane, unmount: () => wrapper.unmount() }
}

describe('useMapPane (P6-14)', () => {
  it('opens on a desktop', () => {
    stubViewportWidth(1280)
    const { pane } = probe()
    expect(pane.canOpen.value).toBe(true)
    pane.open()
    expect(pane.isOpen.value).toBe(true)
  })

  it('refuses to open below the breakpoint — a phone keeps the link it has', () => {
    stubViewportWidth(390)
    const { pane } = probe()
    expect(pane.canOpen.value).toBe(false)
    pane.open()
    expect(pane.isOpen.value).toBe(false)
    // And `toggle` cannot sneak one open either.
    pane.toggle()
    expect(pane.isOpen.value).toBe(false)
  })

  it('closes when the window narrows past the breakpoint, rather than hiding a live map', async () => {
    const viewport = stubViewportWidth(1280)
    const onClose = vi.fn()
    const { pane } = probe(onClose)
    // `useMediaQuery` reads the width in `onMounted`, so let that settle
    // first — a real page has always flushed by the time anyone resizes it.
    await nextTick()
    pane.open()
    expect(pane.isOpen.value).toBe(true)

    viewport.resize(800)
    expect(pane.canOpen.value).toBe(false)
    // The watcher is a normal pre-flush one: it runs before the next render,
    // so the pane is gone before a frame could show a map it should not.
    await nextTick()
    expect(pane.isOpen.value).toBe(false)
    // One way out, so a host letting go of the canvas's context does it
    // whether a person pressed the X or dragged the window narrower.
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens again when the room comes back', async () => {
    // Seen in a real browser: narrow the window once and widen it again, and
    // the page says "There is not room for a map here" on a 1,440px screen
    // with no map under it. Nothing reopened the pane, because the hosts only
    // call `open()` from a watcher on their own state and widening changes
    // none of it — so the only way back was a reload.
    const viewport = stubViewportWidth(1280)
    const { pane } = probe()
    await nextTick()
    pane.open()
    expect(pane.isOpen.value).toBe(true)

    viewport.resize(800)
    await nextTick()
    expect(pane.isOpen.value).toBe(false)

    viewport.resize(1280)
    await nextTick()
    expect(pane.isOpen.value).toBe(true)
  })

  it('leaves a pane the READER closed closed, however the window is resized', async () => {
    // The width may undo what the width did. It may not undo a decision.
    const viewport = stubViewportWidth(1280)
    const { pane } = probe()
    await nextTick()
    pane.open()
    pane.close()
    expect(pane.isOpen.value).toBe(false)

    viewport.resize(800)
    await nextTick()
    viewport.resize(1280)
    await nextTick()
    expect(pane.isOpen.value).toBe(false)
  })

  it('does not open a pane nobody ever asked for when the window widens', async () => {
    const viewport = stubViewportWidth(800)
    const { pane } = probe()
    await nextTick()
    expect(pane.isOpen.value).toBe(false)
    viewport.resize(1280)
    await nextTick()
    expect(pane.isOpen.value).toBe(false)
  })

  it('opens a pane that was ASKED for while the window was too narrow', async () => {
    // The other half of the same defect, and the one a reader meets first:
    // open the page on a small window, widen it, and the map never arrives.
    // The host called `open()` once, at mount, and nothing calls it again —
    // widening changes none of the state its watcher is on.
    const viewport = stubViewportWidth(800)
    const { pane } = probe()
    await nextTick()
    pane.open()
    expect(pane.isOpen.value).toBe(false)

    viewport.resize(1280)
    await nextTick()
    expect(pane.isOpen.value).toBe(true)
  })

  it('forgets the ask once the reader closes it', async () => {
    const viewport = stubViewportWidth(800)
    const { pane } = probe()
    await nextTick()
    pane.open()
    pane.close()
    viewport.resize(1280)
    await nextTick()
    expect(pane.isOpen.value).toBe(false)
  })

  it('runs onClose once, and not for a close that closes nothing', () => {
    stubViewportWidth(1280)
    const onClose = vi.fn()
    const { pane } = probe(onClose)

    pane.close()
    expect(onClose).not.toHaveBeenCalled()

    pane.open()
    pane.close()
    pane.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('toggles', () => {
    stubViewportWidth(1280)
    const { pane } = probe()
    pane.toggle()
    expect(pane.isOpen.value).toBe(true)
    pane.toggle()
    expect(pane.isOpen.value).toBe(false)
  })

  it('starts closed, so no host downloads a county file for a pane nobody asked for', () => {
    stubViewportWidth(1280)
    const { pane } = probe()
    expect(pane.isOpen.value).toBe(false)
  })
})
