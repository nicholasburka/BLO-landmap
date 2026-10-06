import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import FirstRunChecklist from '../FirstRunChecklist.vue'
import { FIRST_RUN_KEY, completeFirstRunStep, loadFirstRun, recordFirstRunVisit } from '@/lib/firstRun'

let router: Router

async function mountChecklist() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/kb')
  await router.isReady()
  const w = mount(FirstRunChecklist, { global: { plugins: [router] } })
  await flushPromises()
  return w
}

function items(w: Awaited<ReturnType<typeof mountChecklist>>) {
  return w.findAll('[data-testid="firstrun-item"]')
}

beforeEach(() => {
  localStorage.clear()
  loadFirstRun()
})

afterEach(() => {
  localStorage.clear()
  loadFirstRun()
})

describe('FirstRunChecklist (P5-43, re-pointed by P6-5)', () => {
  it('lists the six steps, none done, each linking to the surface it happens on', async () => {
    const w = await mountChecklist()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 0 of 6')
    expect(items(w)).toHaveLength(6)
    expect(items(w).map(i => i.attributes('data-step'))).toEqual(['data', 'read', 'map', 'ask', 'add', 'search'])
    expect(items(w).map(i => i.get('a').attributes('href'))).toEqual([
      '/datasets',
      '/docs',
      '/analysis',
      '/chat',
      '/new',
      '/search',
    ])
    expect(items(w).some(i => i.classes().includes('done'))).toBe(false)
    w.unmount()
  })

  it('calls each step what the app now calls it', async () => {
    const w = await mountChecklist()
    expect(items(w).map(i => i.get('a').text())).toEqual([
      'Find a dataset',
      'Open a page or a document',
      'Run an analysis',
      'Ask Chat a question',
      'Add something',
      'Search for something',
    ])
    w.unmount()
  })

  it('tells the reader what ticks each step', async () => {
    const w = await mountChecklist()
    expect(w.get('.firstrun-lede').text()).toBe(
      'Six things worth doing once, one on each page. Each ticks itself off the moment you do it — each line says what does it.',
    )
    const hints = items(w).map(i => i.get('.firstrun-hint').text())
    expect(hints[0]).toContain('it ticks when you filter, sort or summarise a table')
    expect(hints[3]).toContain('it ticks when you open Chat')
    expect(hints[5]).toContain('it ticks when you search')
    w.unmount()
  })

  it('ticks a step off when a route proves it, and counts it', async () => {
    const w = await mountChecklist()

    recordFirstRunVisit('/search', { q: 'who owns this land' })
    await flushPromises()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 1 of 6')
    expect(items(w)[5].classes()).toContain('done')
    expect(items(w)[5].text()).toContain('(done)')
    expect(items(w)[0].classes()).not.toContain('done')
    w.unmount()
  })

  it('ticks the action steps off when the surfaces report the action (P5-71)', async () => {
    const w = await mountChecklist()

    // Opening the browser is no longer enough — using a table is what reports in.
    recordFirstRunVisit('/datasets', { group: 'topic' })
    await flushPromises()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 0 of 6')

    completeFirstRunStep('data')
    await flushPromises()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 1 of 6')
    expect(items(w)[0].classes()).toContain('done')
    w.unmount()
  })

  it('picks up progress made in an earlier session', async () => {
    localStorage.setItem(FIRST_RUN_KEY, JSON.stringify({ done: ['data', 'map'], dismissed: false }))
    const w = await mountChecklist()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 2 of 6')
    expect(items(w).filter(i => i.classes().includes('done')).map(i => i.attributes('data-step'))).toEqual(['data', 'map'])
    w.unmount()
  })

  it('disappears for good when dismissed, and stays gone on the next visit', async () => {
    const w = await mountChecklist()
    await w.get('[data-testid="firstrun-dismiss"]').trigger('click')
    expect(w.find('[data-testid="firstrun"]').exists()).toBe(false)
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_KEY)!).dismissed).toBe(true)
    w.unmount()

    const again = await mountChecklist()
    expect(again.find('[data-testid="firstrun"]').exists()).toBe(false)
    again.unmount()
  })

  it('disappears once all six are done', async () => {
    const w = await mountChecklist()
    recordFirstRunVisit('/search', { q: 'x' })
    recordFirstRunVisit('/chat')
    recordFirstRunVisit('/place', { address: 'Atlanta' })
    completeFirstRunStep('data')
    completeFirstRunStep('add')
    await flushPromises()
    expect(w.get('[data-testid="firstrun-progress"]').text()).toBe('Getting started — 5 of 6')

    completeFirstRunStep('read')
    await flushPromises()
    expect(w.find('[data-testid="firstrun"]').exists()).toBe(false)
    w.unmount()
  })
})
