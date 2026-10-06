import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'

/**
 * The county modal's one internal action (P5-55): "Add to shortlist".
 *
 * The modal itself is the PUBLIC map's county detail panel, so the rule
 * under test is mostly a negative one — a logged-out visitor must not see
 * one extra pixel of it.
 */
const internalUser = ref<{ username: string; role: 'internal' } | null>(null)
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser }),
  registerLogoutHook: vi.fn(),
}))

import { MAX_COMPARE_COUNTIES, clearShortlist, shortlist } from '@/lib/compare'
import CountyModal from '../CountyModal.vue'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

async function mountModal(countyId = '47157') {
  const wrapper = mount(CountyModal, {
    props: { show: true, countyId, countyName: 'Shelby County' },
    global: { plugins: [router] },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  localStorage.clear()
  clearShortlist()
  internalUser.value = null
  // The modal fetches national averages on mount; it already tolerates a
  // failure, so a rejection keeps the test from touching the network.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('CountyModal — add to shortlist (P5-55)', () => {
  it('renders nothing about shortlists on the public map', async () => {
    const w = await mountModal()
    expect(w.find('[data-testid="modal-shortlist"]').exists()).toBe(false)
    expect(w.find('.shortlist-row').exists()).toBe(false)
    expect(w.text()).not.toContain('shortlist')
  })

  it('offers the button once someone is signed in, and adds this county', async () => {
    internalUser.value = { username: 'maria', role: 'internal' }
    const w = await mountModal('47157')
    const button = w.get('[data-testid="modal-shortlist"]')
    expect(button.text()).toBe('Add to shortlist')
    // Nothing to compare yet, so no link out.
    expect(w.find('[data-testid="modal-compare-link"]').exists()).toBe(false)

    await button.trigger('click')
    expect(shortlist.value).toEqual(['47157'])
    expect(w.get('[data-testid="modal-shortlist"]').text()).toBe('On shortlist')
    expect(w.get('[data-testid="modal-compare-link"]').text()).toContain('Compare 1 county')
    expect(w.get('[data-testid="modal-compare-link"]').attributes('href')).toBe('/compare')
  })

  it('counts the counties waiting in the link, and stops at twelve', async () => {
    internalUser.value = { username: 'maria', role: 'internal' }
    shortlist.value = Array.from({ length: MAX_COMPARE_COUNTIES }, (_, i) => String(20000 + i))
    const w = await mountModal('47157')
    expect(w.get('[data-testid="modal-compare-link"]').text()).toContain('Compare 12 counties')
    const button = w.get('[data-testid="modal-shortlist"]')
    expect(button.text()).toBe('Shortlist full')
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(shortlist.value).toHaveLength(MAX_COMPARE_COUNTIES)
  })
})

describe('CountyModal — place report (P5-58)', () => {
  it('is not on the public map at all', async () => {
    const w = await mountModal()
    expect(w.find('[data-testid="modal-place-report"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Place report')
  })

  it('links a signed-in user to this county’s report', async () => {
    internalUser.value = { username: 'maria', role: 'internal' }
    const w = await mountModal('13121')
    const link = w.get('[data-testid="modal-place-report"]')
    expect(link.text()).toContain('Place report')
    expect(link.attributes('href')).toBe('/place?geoid=13121')
  })
})
