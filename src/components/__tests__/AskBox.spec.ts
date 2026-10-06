import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import AskBox from '../AskBox.vue'

let router: Router
async function mountBox(props: Record<string, unknown> = {}) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push('/kb')
  await router.isReady()
  return mount(AskBox, { props, global: { plugins: [router] } })
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('AskBox (P5-41)', () => {
  it('routes to /ask with the typed question when the form is submitted', async () => {
    const w = await mountBox()
    await w.get('[data-testid="ask-input"]').setValue('which organizations in Georgia do land trusts?')
    await w.get('[data-testid="ask-box"]').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/ask')
    expect(router.currentRoute.value.query).toEqual({ q: 'which organizations in Georgia do land trusts?' })
    w.unmount()
  })

  it('carries a dataset hint into the query so the answer knows which table', async () => {
    const w = await mountBox({ dataset: 'organizations' })
    await w.get('[data-testid="ask-input"]').setValue('how many rows?')
    await w.get('[data-testid="ask-box"]').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ q: 'how many rows?', dataset: 'organizations' })
    w.unmount()
  })

  it('trims the question, clears the box, and emits what was asked', async () => {
    const w = await mountBox()
    await w.get('[data-testid="ask-input"]').setValue('  spaced out  ')
    await w.get('[data-testid="ask-box"]').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.query.q).toBe('spaced out')
    expect(w.emitted('ask')).toEqual([['spaced out']])
    expect((w.get('[data-testid="ask-input"]').element as HTMLInputElement).value).toBe('')
    w.unmount()
  })

  it('does nothing for an empty or whitespace-only question, and disables the button', async () => {
    const w = await mountBox()
    expect(w.get('[data-testid="ask-submit"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="ask-box"]').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/kb')
    await w.get('[data-testid="ask-input"]').setValue('   ')
    await w.get('[data-testid="ask-box"]').trigger('submit')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/kb')
    w.unmount()
  })

  it('takes a custom placeholder and label for the host surface', async () => {
    const w = await mountBox({ placeholder: 'Ask about this data…', label: 'Ask about this data' })
    const input = w.get('[data-testid="ask-input"]')
    expect(input.attributes('placeholder')).toBe('Ask about this data…')
    expect(input.attributes('aria-label')).toBe('Ask about this data')
    w.unmount()
  })
})
