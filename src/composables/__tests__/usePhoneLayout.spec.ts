import { describe, it, expect, afterEach } from 'vitest'
import { defineComponent, ref, h } from 'vue'
import { mount } from '@vue/test-utils'
import { usePhoneLayout, useBodyScrollLock, PHONE_QUERY } from '../usePhoneLayout'
import { resetBodyScrollLock } from '@/lib/scrollLock'

/**
 * P5-60. The two pieces of phone behaviour CSS cannot express, tested on
 * their own so every surface that uses them does not have to re-prove them.
 */

/** A fake `matchMedia` that records what was asked and can fire a change. */
function installMatchMedia(matches: boolean) {
  const listeners: ((e: MediaQueryListEvent) => void)[] = []
  const asked: string[] = []
  const mql = {
    matches,
    media: PHONE_QUERY,
    onchange: null,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => {
      asked.push(query)
      return mql
    },
  })
  return {
    asked,
    listenerCount: () => listeners.length,
    resize(next: boolean) {
      mql.matches = next
      for (const fn of [...listeners]) fn({ matches: next } as MediaQueryListEvent)
    },
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia')
  // The lock is a module-level reference count shared with the help drawer
  // and the palette; a case that leaks one would poison the next.
  resetBodyScrollLock()
})

describe('usePhoneLayout', () => {
  const Probe = defineComponent({
    setup() {
      const isPhone = usePhoneLayout()
      return () => h('span', String(isPhone.value))
    },
  })

  it('asks the one breakpoint the mobile rules are written against', async () => {
    const media = installMatchMedia(true)
    const w = mount(Probe)
    // Read on mount, so the first paint matches on the server and in jsdom.
    await w.vm.$nextTick()
    expect(media.asked).toEqual(['(max-width: 640px)'])
    expect(w.text()).toBe('true')
  })

  it('follows the viewport, and lets go of the listener on unmount', async () => {
    const media = installMatchMedia(false)
    const w = mount(Probe)
    expect(w.text()).toBe('false')
    media.resize(true)
    await w.vm.$nextTick()
    expect(w.text()).toBe('true')
    expect(media.listenerCount()).toBe(1)
    w.unmount()
    expect(media.listenerCount()).toBe(0)
  })

  it('is simply false where there is no matchMedia at all', async () => {
    Reflect.deleteProperty(window, 'matchMedia')
    const w = mount(Probe)
    await w.vm.$nextTick()
    expect(w.text()).toBe('false')
  })
})

describe('useBodyScrollLock', () => {
  const locked = ref(false)
  const Probe = defineComponent({
    setup() {
      useBodyScrollLock(locked)
      return () => h('div')
    },
  })

  it('holds the page still while locked and puts back what was there', async () => {
    // A page that already had an overflow of its own must get it back.
    document.body.style.overflow = 'scroll'
    locked.value = false
    const w = mount(Probe)
    expect(document.body.style.overflow).toBe('scroll')

    locked.value = true
    await w.vm.$nextTick()
    expect(document.body.style.overflow).toBe('hidden')

    locked.value = false
    await w.vm.$nextTick()
    expect(document.body.style.overflow).toBe('scroll')
    w.unmount()
  })

  it('unlocks when the component goes away with the sheet still open', async () => {
    document.body.style.overflow = ''
    locked.value = false
    const w = mount(Probe)
    locked.value = true
    await w.vm.$nextTick()
    expect(document.body.style.overflow).toBe('hidden')
    w.unmount()
    expect(document.body.style.overflow).toBe('')
    locked.value = false
  })
})
