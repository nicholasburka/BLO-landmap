import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import RetiredRedirect from '../RetiredRedirect.vue'

/**
 * P6-5: the component half of the retired routes. `lib/retiredRoutes` decides
 * where each link goes (and is tested case by case there); this proves the
 * decision is actually carried out — on the real router, with `replace` so a
 * retired URL leaves no step in history.
 */
const stub = { template: '<div />' }

let router: Router

async function visit(path: string) {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/library', component: RetiredRedirect },
      { path: '/wiki', component: RetiredRedirect },
      { path: '/layers', component: RetiredRedirect },
      { path: '/ask', component: RetiredRedirect },
      { path: '/:pathMatch(.*)*', component: stub },
    ],
  })
  await router.push(path)
  await router.isReady()
  const w = mount(RetiredRedirect, { global: { plugins: [router] } })
  await flushPromises()
  await flushPromises()
  return w
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('RetiredRedirect (P6-5)', () => {
  it('lands a bare /library on search', async () => {
    const w = await visit('/library?q=absentee%20owners')
    expect(router.currentRoute.value.path).toBe('/search')
    expect(router.currentRoute.value.query).toEqual({ q: 'absentee owners' })
    w.unmount()
  })

  it('lands /library?kind=dataset on the datasets browser', async () => {
    const w = await visit('/library?kind=dataset&topic=water')
    expect(router.currentRoute.value.fullPath).toBe('/datasets?topic=water&readiness=held')
    w.unmount()
  })

  it('lands /wiki on the docs browser, and /layers on the datasets browser', async () => {
    const pages = await visit('/wiki?new=1')
    expect(pages.vm).toBeTruthy()
    expect(router.currentRoute.value.fullPath).toBe('/docs?new=1&kind=wiki')
    pages.unmount()

    const layers = await visit('/layers')
    expect(router.currentRoute.value.fullPath).toBe('/datasets?type=statistics')
    layers.unmount()
  })

  it('lands /ask on chat', async () => {
    const w = await visit('/ask?q=who%20owns%20this%20land')
    expect(router.currentRoute.value.path).toBe('/chat')
    w.unmount()
  })

  it('leaves no step in history — Back goes past it, not through it', async () => {
    const w = await visit('/library?kind=view')
    expect(router.currentRoute.value.path).toBe('/analysis')
    // `replace` means the retired URL is gone from the stack: going back from
    // here leaves the app rather than bouncing through the redirect again.
    expect(router.options.history.state.back).not.toBe('/library?kind=view')
    w.unmount()
  })

  it('says something while it is moving, rather than showing a blank page', async () => {
    const w = await visit('/library')
    expect(w.find('[data-testid="retired-redirect"]').exists()).toBe(true)
    w.unmount()
  })
})
