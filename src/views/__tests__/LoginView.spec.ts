import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

/**
 * LoginView's post-login landing (P5-4, hardened in P5-51).
 *
 * `?redirect=` became load-bearing when the OAuth connector flow started
 * sending people through this page: the API parks the authorization request
 * and returns the browser to `/account?oauth=<id>`. That makes the parameter
 * worth its own tests — it is attacker-supplied, and the one thing it must
 * never do is send a freshly logged-in user off-site.
 */

const loginInternal = vi.fn()
vi.mock('@/composables/useAuth', () => ({ useAuth: () => ({ loginInternal }) }))

const replace = vi.fn()
const currentRoute = ref<{ query: Record<string, unknown> }>({ query: {} })
vi.mock('vue-router', () => ({ useRouter: () => ({ replace, currentRoute }) }))

import LoginView from '../LoginView.vue'

async function login(query: Record<string, unknown> = {}) {
  currentRoute.value = { query }
  const w = mount(LoginView)
  await w.get('#login-username').setValue('maria')
  await w.get('#login-password').setValue('pass-123')
  await w.get('form').trigger('submit')
  await flushPromises()
  return w
}

beforeEach(() => {
  loginInternal.mockReset()
  replace.mockReset()
  loginInternal.mockResolvedValue({ ok: true })
})

describe('LoginView redirect', () => {
  it('lands on the knowledge base when no redirect was asked for', async () => {
    const w = await login()
    expect(replace).toHaveBeenCalledWith('/kb')
    w.unmount()
  })

  it('returns to the in-app path it was given — the OAuth consent hand-back', async () => {
    const w = await login({ redirect: '/account?oauth=abc123' })
    expect(replace).toHaveBeenCalledWith('/account?oauth=abc123')
    w.unmount()
  })

  it('refuses an absolute URL to another origin', async () => {
    const w = await login({ redirect: 'https://evil.example/steal' })
    expect(replace).toHaveBeenCalledWith('/kb')
    w.unmount()
  })

  it('refuses a protocol-relative URL, which looks like a path but is not', async () => {
    for (const hostile of ['//evil.example/steal', '/\\evil.example']) {
      replace.mockReset()
      const w = await login({ redirect: hostile })
      expect(replace).toHaveBeenCalledWith('/kb')
      w.unmount()
    }
  })

  it('refuses a repeated redirect parameter (an array, not a path)', async () => {
    const w = await login({ redirect: ['/account', 'https://evil.example'] })
    expect(replace).toHaveBeenCalledWith('/kb')
    w.unmount()
  })

  it('navigates nowhere when the credentials are refused', async () => {
    loginInternal.mockResolvedValue({ ok: false })
    const w = await login({ redirect: '/account?oauth=abc123' })
    expect(replace).not.toHaveBeenCalled()
    expect(w.get('.login-error').text()).toBe('Invalid credentials')
    // The password field is cleared so a retry starts from scratch.
    expect((w.get('#login-password').element as HTMLInputElement).value).toBe('')
    w.unmount()
  })
})
