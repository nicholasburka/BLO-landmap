import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useFocusTrap } from '../useFocusTrap'

/**
 * P15-1. The focus trap the Help drawer and the phone nav menu each used to
 * carry a copy of, proved once here so the third surface to want one (the
 * welcome overlay, P15-3) inherits the proof rather than the fifteen lines.
 *
 * Every case attaches to the document: jsdom only moves `activeElement` for
 * elements that are actually in it, so a detached mount would pass by failing
 * to focus anything.
 */

/**
 * A panel with a trigger outside it, which is the shape every caller has: a
 * button in the page, a dialog over it, focus owed back to the button.
 */
const Panel = defineComponent({
  props: { hideMiddle: { type: Boolean, default: false } },
  setup(props) {
    const panelEl = ref<HTMLElement | null>(null)
    const triggerEl = ref<HTMLButtonElement | null>(null)
    const trap = useFocusTrap(panelEl)

    function openPanel(): void {
      trap.capture(triggerEl.value)
      trap.focusFirst()
    }

    return { panelEl, triggerEl, trap, openPanel, props }
  },
  template: `
    <button ref="triggerEl" data-testid="trigger" @click="openPanel">Open</button>
    <div ref="panelEl" data-testid="panel" tabindex="-1" @keydown="trap.onKeydown">
      <button data-testid="first">First</button>
      <button v-if="props.hideMiddle" data-testid="hidden" style="display: none">Hidden</button>
      <button v-else data-testid="middle">Middle</button>
      <a href="/somewhere" data-testid="last">Last</a>
    </div>
  `,
})

function mountPanel(props: { hideMiddle?: boolean } = {}) {
  return mount(Panel, { props, attachTo: document.body })
}

const el = (w: ReturnType<typeof mountPanel>, testId: string) =>
  w.get(`[data-testid="${testId}"]`).element as HTMLElement

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useFocusTrap (P15-1)', () => {
  it('takes focus to the first tab stop when the panel opens', async () => {
    const w = mountPanel()
    await w.get('[data-testid="trigger"]').trigger('click')
    expect(document.activeElement).toBe(el(w, 'first'))
    w.unmount()
  })

  it('wraps a Tab off the last tab stop round to the first', async () => {
    const w = mountPanel()
    el(w, 'last').focus()

    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(el(w, 'first'))

    // A Tab anywhere else is the browser's business, not ours.
    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(el(w, 'first'))
    w.unmount()
  })

  it('wraps a Shift+Tab off the first tab stop round to the last', async () => {
    const w = mountPanel()
    el(w, 'first').focus()
    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(el(w, 'last'))
    w.unmount()
  })

  it('wraps a Shift+Tab to the last stop even when focus never entered the panel', async () => {
    // What happens when a panel opens without taking focus: the keystroke
    // would otherwise walk backwards out of a modal.
    const w = mountPanel()
    el(w, 'trigger').focus()
    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(el(w, 'last'))
    w.unmount()
  })

  it('wraps a Shift+Tab off the container, where a capped dialog puts focus', async () => {
    // The welcome overlay's shape (P15-3): a dialog that is a scroller focuses
    // its own `tabindex="-1"` panel so the title is not scrolled past before
    // it is read. `contains` says yes to that element, so it has to be counted
    // as "at the start" or the first Shift+Tab leaves the modal.
    const w = mountPanel()
    el(w, 'panel').focus()
    expect(document.activeElement).toBe(el(w, 'panel'))

    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(el(w, 'last'))
    w.unmount()
  })

  it('hands focus back to the recorded trigger on release', async () => {
    const w = mountPanel()
    await w.get('[data-testid="trigger"]').trigger('click')
    expect(document.activeElement).toBe(el(w, 'first'))

    w.vm.trap.release()
    expect(document.activeElement).toBe(el(w, 'trigger'))
    w.unmount()
  })

  it('falls back to whatever had focus when nothing was handed to capture', async () => {
    // The welcome overlay's case (P15-3): it appears on load, so there is no
    // trigger to name.
    const w = mountPanel()
    el(w, 'trigger').focus()
    w.vm.trap.capture()
    el(w, 'first').focus()

    w.vm.trap.release()
    expect(document.activeElement).toBe(el(w, 'trigger'))
    w.unmount()
  })

  it('steps over a hidden focusable instead of parking a Tab on it', async () => {
    // The difference from the drawer's copy, which could skip the visibility
    // check because a collapsed recipe is `v-if`'d out rather than hidden.
    const w = mountPanel({ hideMiddle: true })
    expect(w.vm.trap.focusables().map(node => node.dataset.testid)).toEqual(['first', 'last'])

    el(w, 'first').focus()
    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(el(w, 'last'))

    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(el(w, 'first'))
    w.unmount()
  })

  it('leaves an empty panel alone rather than throwing at it', async () => {
    const empty = defineComponent({
      setup() {
        const panelEl = ref<HTMLElement | null>(null)
        const trap = useFocusTrap(panelEl)
        return { panelEl, trap }
      },
      template: '<div ref="panelEl" data-testid="panel" @keydown="trap.onKeydown"></div>',
    })
    const w = mount(empty, { attachTo: document.body })
    expect(w.vm.trap.focusables()).toEqual([])
    await w.get('[data-testid="panel"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(document.body)
    w.unmount()
  })
})
