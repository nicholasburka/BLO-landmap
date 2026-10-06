import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

// The account card only renders for a signed-in internal user; a controllable
// ref stands in for the real session so no network hydration runs.
const userRef = ref<{ id: number; username: string; role: 'admin' | 'internal' } | null>({
  id: 1,
  username: 'dev-admin',
  role: 'admin',
})
const logoutInternal = vi.fn()
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: userRef, logoutInternal }),
}))

const replace = vi.fn()
/** The route's query drives the OAuth "finish connecting" card (P5-51). */
const routeQuery = ref<Record<string, string>>({})
vi.mock('vue-router', () => ({
  useRouter: () => ({ replace }),
  useRoute: () => ({ get query() { return routeQuery.value } }),
}))

// validateTokenName stays real: the view's inline validation is part of what
// these tests exercise. The three network calls are stubbed.
vi.mock('@/lib/apiTokens', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apiTokens')>()
  return {
    ...actual,
    listApiTokens: vi.fn(),
    createApiToken: vi.fn(),
    revokeApiToken: vi.fn(),
    listOAuthGrants: vi.fn(),
    revokeOAuthGrant: vi.fn(),
    getPendingAuthorization: vi.fn(),
    // Not stubbed as a URL builder would be pointless to assert against a
    // mock; the real one is pure and the spec checks the href it produces.
    authorizationContinueUrl: (id: string) => `https://api.example.com/oauth/authorize/continue/${id}`,
  }
})

// validatePasswordChange stays real for the same reason validateTokenName
// does: the form's client-side checks are part of what these tests exercise.
vi.mock('@/lib/account', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/account')>()
  return { ...actual, changePassword: vi.fn() }
})

import { changePassword, MIN_PASSWORD_LENGTH } from '@/lib/account'
import {
  listApiTokens,
  createApiToken,
  revokeApiToken,
  listOAuthGrants,
  revokeOAuthGrant,
  getPendingAuthorization,
  type ApiTokenSummary,
  type MintedApiToken,
  type OAuthGrantSummary,
} from '@/lib/apiTokens'
import AccountView from '../AccountView.vue'

const mockedList = vi.mocked(listApiTokens)
const mockedCreate = vi.mocked(createApiToken)
const mockedRevoke = vi.mocked(revokeApiToken)
const mockedGrants = vi.mocked(listOAuthGrants)
const mockedRevokeGrant = vi.mocked(revokeOAuthGrant)
const mockedPending = vi.mocked(getPendingAuthorization)
const mockedChangePassword = vi.mocked(changePassword)

const GRANTS: OAuthGrantSummary[] = [
  {
    id: 'family-1',
    clientName: 'ChatGPT',
    scopes: ['read'],
    createdAt: '2026-09-01T12:00:00.000Z',
    lastUsedAt: '2026-09-05T09:00:00.000Z',
  },
  {
    id: 'family-2',
    clientName: 'Claude',
    scopes: ['read'],
    createdAt: '2026-08-20T12:00:00.000Z',
    lastUsedAt: null,
  },
]

const TOKENS: ApiTokenSummary[] = [
  {
    id: 7,
    name: 'Claude Desktop — laptop',
    scopes: ['library:read'],
    createdAt: '2026-09-04T12:00:00.000Z',
    lastUsedAt: '2026-09-05T09:00:00.000Z',
  },
  {
    id: 4,
    name: 'Old CLI',
    scopes: ['library:read', 'library:search'],
    createdAt: '2026-08-01T12:00:00.000Z',
    lastUsedAt: null,
  },
]

const MINTED: MintedApiToken = {
  token: 'blo_secret_value_123',
  id: 11,
  name: 'New client',
  createdAt: '2026-09-05T12:00:00.000Z',
  scopes: ['library:read'],
}

async function mountView() {
  const w = mount(AccountView)
  await flushPromises()
  return w
}

async function mint(w: Awaited<ReturnType<typeof mountView>>, name: string, allowWrites = false) {
  await w.get('[data-testid="token-name-input"]').setValue(name)
  if (allowWrites) await w.get('[data-testid="token-allow-writes"]').setValue(true)
  // Scoped: the page has more than one form (P5-76 added change-password).
  await w.get('.token-card form').trigger('submit')
  await flushPromises()
}

beforeEach(() => {
  userRef.value = { id: 1, username: 'dev-admin', role: 'admin' }
  routeQuery.value = {}
  logoutInternal.mockReset()
  replace.mockReset()
  mockedList.mockReset()
  mockedCreate.mockReset()
  mockedRevoke.mockReset()
  mockedGrants.mockReset()
  mockedRevokeGrant.mockReset()
  mockedPending.mockReset()
  mockedChangePassword.mockReset()
  mockedChangePassword.mockResolvedValue({ ok: true, signedOutOthers: 2 })
  mockedList.mockResolvedValue(TOKENS)
  mockedCreate.mockResolvedValue(MINTED)
  mockedRevoke.mockResolvedValue(undefined)
  mockedGrants.mockResolvedValue(GRANTS)
  mockedRevokeGrant.mockResolvedValue(undefined)
  mockedPending.mockResolvedValue(null)
})

describe('AccountView (P5-50)', () => {
  it('keeps the identity card and log out working', async () => {
    const w = await mountView()
    expect(w.text()).toContain('dev-admin')
    expect(w.text()).toContain('admin')
    await w.get('.account-card button').trigger('click')
    await flushPromises()
    expect(logoutInternal).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/')
    w.unmount()
  })

  it('lists the tokens on mount with scopes and last-used', async () => {
    const w = await mountView()
    expect(mockedList).toHaveBeenCalledTimes(1)
    const rows = w.findAll('[data-testid="token-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].get('[data-testid="token-row-name"]').text()).toBe('Claude Desktop — laptop')
    expect(rows[1].text()).toContain('library:read, library:search')
    expect(rows[1].text()).toContain('never used')
    expect(w.find('[data-testid="token-loading"]').exists()).toBe(false)
    w.unmount()
  })

  it('shows a quiet empty state when there are no tokens', async () => {
    mockedList.mockResolvedValue([])
    const w = await mountView()
    expect(w.get('[data-testid="token-empty"]').text()).toBe('No tokens yet.')
    w.unmount()
  })

  it('shows the load error instead of staying stuck on loading', async () => {
    mockedList.mockRejectedValue(new Error('library unavailable'))
    const w = await mountView()
    expect(w.get('[data-testid="token-error"]').text()).toBe('library unavailable')
    expect(w.find('[data-testid="token-loading"]').exists()).toBe(false)
    w.unmount()
  })

  it('reveals the minted secret once, out of the list, and clears the input', async () => {
    const w = await mountView()
    await mint(w, 'New client')

    expect(mockedCreate).toHaveBeenCalledWith('New client', false)
    const secretBoxes = w.findAll('[data-testid="token-secret"]')
    expect(secretBoxes).toHaveLength(1)
    expect(secretBoxes[0].get('[data-testid="token-secret-value"]').text()).toBe(MINTED.token)
    expect(secretBoxes[0].text()).toContain('only time this token is shown')

    const rows = w.findAll('[data-testid="token-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0].get('[data-testid="token-row-name"]').text()).toBe('New client')
    // The secret must live in the highlighted box alone, never in a row.
    for (const row of rows) expect(row.text()).not.toContain(MINTED.token)

    expect((w.get('[data-testid="token-name-input"]').element as HTMLInputElement).value).toBe('')
    w.unmount()
  })

  it('dismisses the secret box without touching the list', async () => {
    const w = await mountView()
    await mint(w, 'New client')
    await w.get('[data-testid="token-done"]').trigger('click')
    expect(w.find('[data-testid="token-secret"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="token-row"]')).toHaveLength(3)
    w.unmount()
  })

  it('survives a clipboard that is unavailable in this context', async () => {
    const w = await mountView()
    await mint(w, 'New client')
    await w.get('[data-testid="token-copy"]').trigger('click')
    await flushPromises()
    // jsdom has no navigator.clipboard: the secret stays readable either way.
    expect(w.get('[data-testid="token-secret-value"]').text()).toBe(MINTED.token)
    w.unmount()
  })

  it('rejects a blank name inline without calling the server', async () => {
    const w = await mountView()
    await mint(w, '   ')
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(w.get('[data-testid="token-error"]').text()).toBe(
      'Give the token a name so you can tell it apart later.',
    )
    expect(w.findAll('[data-testid="token-row"]')).toHaveLength(2)
    w.unmount()
  })

  it('shows a failed mint as an error and adds no row', async () => {
    mockedCreate.mockRejectedValue(new Error('library unavailable'))
    const w = await mountView()
    await mint(w, 'New client')
    expect(w.get('[data-testid="token-error"]').text()).toBe('library unavailable')
    expect(w.findAll('[data-testid="token-row"]')).toHaveLength(2)
    expect(w.find('[data-testid="token-secret"]').exists()).toBe(false)
    w.unmount()
  })

  it('removes the row it revokes', async () => {
    const w = await mountView()
    await w.findAll('[data-testid="token-revoke"]')[1].trigger('click')
    await flushPromises()
    expect(mockedRevoke).toHaveBeenCalledWith(4)
    const rows = w.findAll('[data-testid="token-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].get('[data-testid="token-row-name"]').text()).toBe('Claude Desktop — laptop')
    w.unmount()
  })

  it('disables only the row being revoked while its request is in flight', async () => {
    let finish!: () => void
    mockedRevoke.mockReturnValue(new Promise<void>(resolve => (finish = resolve)))
    const w = await mountView()
    await w.findAll('[data-testid="token-revoke"]')[0].trigger('click')
    const buttons = w.findAll('[data-testid="token-revoke"]')
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeUndefined()
    finish()
    await flushPromises()
    expect(w.findAll('[data-testid="token-row"]')).toHaveLength(1)
    w.unmount()
  })

  it('keeps a failed revoke visible and the row in place', async () => {
    mockedRevoke.mockRejectedValue(new Error('not found'))
    const w = await mountView()
    await w.findAll('[data-testid="token-revoke"]')[0].trigger('click')
    await flushPromises()
    // 'not found' is an HTTP status phrase, not a sentence for people — the friendly fallback shows instead (P5-72).
    expect(w.get('[data-testid="token-error"]').text()).toBe('Failed to revoke token.')
    expect(w.findAll('[data-testid="token-row"]')).toHaveLength(2)
    w.unmount()
  })

  it('renders nothing for an anonymous visitor and never asks for tokens', async () => {
    userRef.value = null
    const w = await mountView()
    expect(w.find('.account-card').exists()).toBe(false)
    expect(mockedList).not.toHaveBeenCalled()
    expect(mockedGrants).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('AccountView — the write scope (P5-52)', () => {
  it('mints read-only by default and says plainly what ticking the box gives away', async () => {
    const w = await mountView()
    const box = w.get('[data-testid="token-allow-writes"]')
    expect((box.element as HTMLInputElement).checked).toBe(false)
    const label = w.get('.token-writes').text()
    expect(label).toContain('Allow writes')
    expect(label).toContain('add notes, append to pages, drop links and save views as you')
    expect(label).toContain('cannot delete anything')
    expect(label).toContain('recorded in the activity feed')

    await mint(w, 'Read only client')
    expect(mockedCreate).toHaveBeenCalledWith('Read only client', false)
    w.unmount()
  })

  it('asks for writes when the box is ticked, then goes back to the safe default', async () => {
    mockedCreate.mockResolvedValue({ ...MINTED, scopes: ['read', 'write'] })
    const w = await mountView()
    await mint(w, 'ChatGPT', true)
    expect(mockedCreate).toHaveBeenCalledWith('ChatGPT', true)
    // The minted row shows the scopes the server granted, so a writing token
    // is visible in the list forever after.
    expect(w.findAll('[data-testid="token-row"]')[0].text()).toContain('read, write')
    // The next token starts unticked rather than inheriting the decision.
    expect((w.get('[data-testid="token-allow-writes"]').element as HTMLInputElement).checked).toBe(false)
    w.unmount()
  })

  it('leaves the tick alone when minting failed, so the retry keeps the intent', async () => {
    mockedCreate.mockRejectedValue(new Error('library unavailable'))
    const w = await mountView()
    await mint(w, 'ChatGPT', true)
    expect(w.get('[data-testid="token-error"]').text()).toBe('library unavailable')
    expect((w.get('[data-testid="token-allow-writes"]').element as HTMLInputElement).checked).toBe(true)
    w.unmount()
  })
})

describe('AccountView — connected apps (P5-51)', () => {
  it('lists each OAuth connection with its scopes, dates and a disconnect button', async () => {
    const w = await mountView()
    const rows = w.findAll('[data-testid="grant-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].get('[data-testid="grant-row-name"]').text()).toBe('ChatGPT')
    expect(rows[0].text()).toContain('read')
    expect(rows[1].text()).toContain('never used')
    w.unmount()
  })

  it('shows a quiet empty state when nothing is connected', async () => {
    mockedGrants.mockResolvedValue([])
    const w = await mountView()
    expect(w.get('[data-testid="grant-empty"]').text()).toBe('No apps are connected.')
    w.unmount()
  })

  it('removes the app it disconnects', async () => {
    const w = await mountView()
    await w.findAll('[data-testid="grant-revoke"]')[0].trigger('click')
    await flushPromises()
    expect(mockedRevokeGrant).toHaveBeenCalledWith('family-1')
    const rows = w.findAll('[data-testid="grant-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].get('[data-testid="grant-row-name"]').text()).toBe('Claude')
    w.unmount()
  })

  it('keeps a failed disconnect visible and the app connected', async () => {
    mockedRevokeGrant.mockRejectedValue(new Error('not found'))
    const w = await mountView()
    await w.findAll('[data-testid="grant-revoke"]')[0].trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="grant-error"]').text()).toBe('Failed to disconnect.')
    expect(w.findAll('[data-testid="grant-row"]')).toHaveLength(2)
    w.unmount()
  })

  it('shows the load error rather than a stuck spinner', async () => {
    mockedGrants.mockRejectedValue(new Error('library unavailable'))
    const w = await mountView()
    expect(w.get('[data-testid="grant-error"]').text()).toBe('library unavailable')
    expect(w.find('[data-testid="grant-loading"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('AccountView — finishing an OAuth authorization (P5-51)', () => {
  it('offers Continue for the app named by ?oauth=', async () => {
    routeQuery.value = { oauth: 'pending-abc' }
    mockedPending.mockResolvedValue({
      clientName: 'ChatGPT',
      scopes: ['read'],
      scopeDescriptions: ['Read the library — pages, documents, datasets'],
    })
    const w = await mountView()
    expect(mockedPending).toHaveBeenCalledWith('pending-abc')
    const card = w.get('[data-testid="oauth-pending"]')
    expect(card.text()).toContain('ChatGPT')
    expect(card.text()).toContain('Read the library')
    const link = w.get('[data-testid="oauth-continue"]')
    expect(link.text()).toContain('Continue to ChatGPT authorization')
    // Back to the API's own consent screen, built from the API base — never
    // from anything else in the query string.
    expect(link.attributes('href')).toBe('https://api.example.com/oauth/authorize/continue/pending-abc')
    w.unmount()
  })

  it('shows no card at all without an ?oauth= id', async () => {
    const w = await mountView()
    expect(mockedPending).not.toHaveBeenCalled()
    expect(w.find('[data-testid="oauth-pending"]').exists()).toBe(false)
    w.unmount()
  })

  it('stays silent for an expired request rather than showing an error', async () => {
    routeQuery.value = { oauth: 'pending-abc' }
    mockedPending.mockResolvedValue(null)
    const w = await mountView()
    expect(w.find('[data-testid="oauth-pending"]').exists()).toBe(false)
    w.unmount()
  })

  it('ignores an id that is not the shape the server issues', async () => {
    // Nothing here is trusted enough to be pasted into a URL unchecked.
    routeQuery.value = { oauth: 'https://evil.example/steal' }
    const w = await mountView()
    expect(mockedPending).not.toHaveBeenCalled()
    expect(w.find('[data-testid="oauth-pending"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('AccountView — changing your password (P5-76)', () => {
  const CURRENT = 'old-password-123'
  const NEXT = 'new-password-456'

  async function submitPassword(
    w: Awaited<ReturnType<typeof mountView>>,
    current: string,
    next: string,
    confirm = next,
  ) {
    await w.get('[data-testid="password-current"]').setValue(current)
    await w.get('[data-testid="password-next"]').setValue(next)
    await w.get('[data-testid="password-confirm"]').setValue(confirm)
    await w.get('[data-testid="password-form"]').trigger('submit')
    await flushPromises()
  }

  function valueOf(w: Awaited<ReturnType<typeof mountView>>, testid: string): string {
    return (w.get(`[data-testid="${testid}"]`).element as HTMLInputElement).value
  }

  it('changes the password, reports the other sessions, and empties the fields', async () => {
    const w = await mountView()
    await submitPassword(w, CURRENT, NEXT)

    expect(mockedChangePassword).toHaveBeenCalledWith(CURRENT, NEXT)
    expect(w.get('[data-testid="password-success"]').text()).toBe(
      'Password changed. Other sessions were signed out.',
    )
    expect(w.find('[data-testid="password-error"]').exists()).toBe(false)
    // Nothing typed stays on screen once it has been used.
    for (const field of ['password-current', 'password-next', 'password-confirm']) {
      expect(valueOf(w, field)).toBe('')
    }
    w.unmount()
  })

  it('says only what happened when there were no other sessions', async () => {
    mockedChangePassword.mockResolvedValue({ ok: true, signedOutOthers: 0 })
    const w = await mountView()
    await submitPassword(w, CURRENT, NEXT)
    expect(w.get('[data-testid="password-success"]').text()).toBe('Password changed.')
    w.unmount()
  })

  it('catches a confirm box that does not match, without calling the server', async () => {
    const w = await mountView()
    await submitPassword(w, CURRENT, NEXT, 'new-password-457')
    expect(mockedChangePassword).not.toHaveBeenCalled()
    expect(w.get('[data-testid="password-error"]').text()).toBe('The new passwords do not match.')
    expect(w.find('[data-testid="password-success"]').exists()).toBe(false)
    // What was typed survives, so the fix is one field away.
    expect(valueOf(w, 'password-current')).toBe(CURRENT)
    w.unmount()
  })

  it('catches a too-short new password inline and names the minimum', async () => {
    const w = await mountView()
    await submitPassword(w, CURRENT, 'a'.repeat(MIN_PASSWORD_LENGTH - 1))
    expect(mockedChangePassword).not.toHaveBeenCalled()
    expect(w.get('[data-testid="password-error"]').text()).toBe(
      `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
    w.unmount()
  })

  it('shows the server’s own sentence for a wrong current password', async () => {
    mockedChangePassword.mockRejectedValue(new Error('That is not your current password.'))
    const w = await mountView()
    await submitPassword(w, 'wrong', NEXT)
    expect(w.get('[data-testid="password-error"]').text()).toBe('That is not your current password.')
    expect(w.find('[data-testid="password-success"]').exists()).toBe(false)
    // A failed attempt keeps the new password typed, so only the wrong field
    // has to be retyped.
    expect(valueOf(w, 'password-next')).toBe(NEXT)
    w.unmount()
  })

  it('drops the success message as soon as another attempt starts', async () => {
    const w = await mountView()
    await submitPassword(w, CURRENT, NEXT)
    expect(w.find('[data-testid="password-success"]').exists()).toBe(true)
    mockedChangePassword.mockRejectedValue(new Error('That is not your current password.'))
    await submitPassword(w, 'wrong', NEXT)
    expect(w.find('[data-testid="password-success"]').exists()).toBe(false)
    expect(w.get('[data-testid="password-error"]').text()).toBe('That is not your current password.')
    w.unmount()
  })

  it('disables the button while the change is in flight', async () => {
    let finish!: (result: { ok: true; signedOutOthers: number }) => void
    mockedChangePassword.mockReturnValue(new Promise(resolve => (finish = resolve)))
    const w = await mountView()
    await w.get('[data-testid="password-current"]').setValue(CURRENT)
    await w.get('[data-testid="password-next"]').setValue(NEXT)
    await w.get('[data-testid="password-confirm"]').setValue(NEXT)
    await w.get('[data-testid="password-form"]').trigger('submit')

    const button = w.get('[data-testid="password-submit"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.text()).toBe('Changing…')

    finish({ ok: true, signedOutOthers: 1 })
    await flushPromises()
    expect(w.get('[data-testid="password-submit"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('is not offered to an anonymous visitor', async () => {
    userRef.value = null
    const w = await mountView()
    expect(w.find('[data-testid="password-form"]').exists()).toBe(false)
    w.unmount()
  })
})
