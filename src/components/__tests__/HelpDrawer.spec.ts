import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import HelpDrawer from '../HelpDrawer.vue'
import { HELP_RECIPES, closeHelpDrawer, openHelpDrawer, helpDrawerOpen } from '@/lib/helpRecipes'
import { resetBodyScrollLock } from '@/lib/scrollLock'

let router: Router

async function mountDrawer() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/')
  await router.isReady()
  const w = mount(HelpDrawer, { global: { plugins: [router] }, attachTo: document.body })
  await flushPromises()
  return w
}

async function openDrawer(w: Awaited<ReturnType<typeof mountDrawer>>) {
  await w.get('[data-testid="help-trigger"]').trigger('click')
  await flushPromises()
  return w
}

function recipes(w: Awaited<ReturnType<typeof mountDrawer>>) {
  return w.findAll('[data-testid="help-recipe"]')
}

beforeEach(() => {
  closeHelpDrawer()
  resetBodyScrollLock()
})

afterEach(() => {
  closeHelpDrawer()
  resetBodyScrollLock()
  document.body.innerHTML = ''
})

describe('HelpDrawer (P5-43)', () => {
  it('shows a Help button and opens the drawer from it', async () => {
    const w = await mountDrawer()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)
    await openDrawer(w)

    const panel = w.get('[data-testid="help-drawer"]')
    expect(panel.attributes('role')).toBe('dialog')
    expect(panel.attributes('aria-modal')).toBe('true')
    expect(panel.attributes('aria-label')).toBe('How do I…')
    expect(recipes(w)).toHaveLength(HELP_RECIPES.length)
    w.unmount()
  })

  it('opens on ? and closes on Esc, but leaves ? alone while someone is typing', async () => {
    const w = await mountDrawer()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }))
    await flushPromises()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)

    // A question mark typed into a box is a question mark.
    const box = document.createElement('input')
    document.body.appendChild(box)
    box.focus()
    box.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
    await flushPromises()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)

    // A modified ? (⌘?) belongs to the browser, not to us.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', metaKey: true }))
    await flushPromises()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)
    w.unmount()
  })

  it('also opens when something else asks for it — the landing page link', async () => {
    const w = await mountDrawer()
    openHelpDrawer()
    await flushPromises()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(true)
    // …and the search box is ready to type into.
    expect(document.activeElement).toBe(w.get('[data-testid="help-search"]').element)
    w.unmount()
  })

  it('filters recipes by title and by the words inside their steps', async () => {
    const w = await mountDrawer()
    await openDrawer(w)

    await w.get('[data-testid="help-search"]').setValue('save a map view')
    await flushPromises()
    expect(recipes(w).map(r => r.attributes('data-recipe'))).toEqual(['save-view'])

    // A step-only phrase still finds its recipe.
    await w.get('[data-testid="help-search"]').setValue('Download filtered CSV')
    await flushPromises()
    expect(recipes(w).map(r => r.attributes('data-recipe'))).toContain('download-csv')

    await w.get('[data-testid="help-search"]').setValue('kubernetes')
    await flushPromises()
    expect(recipes(w)).toHaveLength(0)
    expect(w.get('[data-testid="help-empty"]').text()).toContain('kubernetes')
    w.unmount()
  })

  it('expands one recipe at a time to its steps and a link to the surface', async () => {
    const w = await mountDrawer()
    await openDrawer(w)
    expect(w.find('[data-testid="help-steps"]').exists()).toBe(false)

    const first = recipes(w)[0]
    const firstId = first.attributes('data-recipe')!
    const source = HELP_RECIPES.find(r => r.id === firstId)!
    await first.get('[data-testid="help-recipe-toggle"]').trigger('click')

    const steps = w.get('[data-testid="help-steps"]').findAll('li')
    expect(steps.map(s => s.text())).toEqual(source.steps)
    expect(first.get('[data-testid="help-recipe-toggle"]').attributes('aria-expanded')).toBe('true')
    expect(w.get('[data-testid="help-goto"]').attributes('href')).toBe(source.href)

    // Opening another closes the first.
    await recipes(w)[1].get('[data-testid="help-recipe-toggle"]').trigger('click')
    expect(w.findAll('[data-testid="help-steps"]')).toHaveLength(1)
    expect(recipes(w)[1].get('[data-testid="help-recipe-toggle"]').attributes('aria-expanded')).toBe('true')

    // Clicking it again collapses it.
    await recipes(w)[1].get('[data-testid="help-recipe-toggle"]').trigger('click')
    expect(w.find('[data-testid="help-steps"]').exists()).toBe(false)
    w.unmount()
  })

  it('opens the steps straight away when a search narrows to one recipe', async () => {
    const w = await mountDrawer()
    await openDrawer(w)
    await w.get('[data-testid="help-search"]').setValue('save a map view')
    await flushPromises()
    expect(w.find('[data-testid="help-steps"]').exists()).toBe(true)
    w.unmount()
  })

  it('forgets the last search when it closes, so the next person gets the whole manual', async () => {
    const w = await mountDrawer()
    await openDrawer(w)
    await w.get('[data-testid="help-search"]').setValue('save a map view')
    await flushPromises()
    expect(recipes(w)).toHaveLength(1)

    await w.get('[data-testid="help-close"]').trigger('click')
    await openDrawer(w)
    expect((w.get('[data-testid="help-search"]').element as HTMLInputElement).value).toBe('')
    expect(recipes(w)).toHaveLength(HELP_RECIPES.length)
    expect(w.find('[data-testid="help-steps"]').exists()).toBe(false)
    w.unmount()
  })

  it('closes when "Take me there" is used, so the person lands on the page not the drawer', async () => {
    const w = await mountDrawer()
    await openDrawer(w)
    await recipes(w)[0].get('[data-testid="help-recipe-toggle"]').trigger('click')
    await w.get('[data-testid="help-goto"]').trigger('click')
    await flushPromises()
    expect(helpDrawerOpen.value).toBe(false)
    w.unmount()
  })

  it('closes on the backdrop and on the ✕, returning focus to the Help button', async () => {
    const w = await mountDrawer()
    await openDrawer(w)
    await w.get('[data-testid="help-close"]').trigger('click')
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.get('[data-testid="help-trigger"]').element)

    await openDrawer(w)
    await w.get('[data-testid="help-backdrop"]').trigger('click')
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)
    w.unmount()
  })

  it('keeps Tab inside the drawer', async () => {
    const w = await mountDrawer()
    await openDrawer(w)
    const panel = w.get('[data-testid="help-drawer"]')
    const stops = panel.element.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input')
    const first = stops[0]
    const last = stops[stops.length - 1]
    expect(stops.length).toBeGreaterThan(2)

    last.focus()
    await panel.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    await panel.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    w.unmount()
  })
})

describe('the help drawer on a phone (P5-60)', () => {
  it('is a bottom sheet rather than a side drawer', async () => {
    const w = await openDrawer(await mountDrawer())
    // jsdom computes no layout: the classes are what the phone rules hang off.
    expect(w.get('[data-testid="help-backdrop"]').classes()).toContain('sheet-backdrop')
    expect(w.get('[data-testid="help-drawer"]').classes()).toContain('sheet')
    w.unmount()
  })

  it('locks the page behind it and unlocks it on close', async () => {
    const w = await openDrawer(await mountDrawer())
    expect(document.body.style.overflow).toBe('hidden')
    await w.get('[data-testid="help-close"]').trigger('click')
    await flushPromises()
    expect(document.body.style.overflow).toBe('')
    w.unmount()
  })

  it('keeps the "press ?" hint in its own element so touch devices can hide it', async () => {
    const w = await openDrawer(await mountDrawer())
    // `@media (hover: none)` is the rule; this is the hook it needs.
    expect(w.get('[data-testid="help-kbd-hint"]').classes()).toContain('kbd-hint')
    w.unmount()
  })
})
