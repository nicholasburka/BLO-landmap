import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'https://api.example.com',
}))

import { internalFetch } from '../apiBase'
import { changePassword, validatePasswordChange, MIN_PASSWORD_LENGTH } from '../account'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mockedFetch.mockReset()
})

const GOOD = 'new-password-456'

describe('validatePasswordChange', () => {
  it('asks for the current password first', () => {
    expect(validatePasswordChange('', GOOD, GOOD)).toBe('Enter your current password.')
  })

  it('rejects a new password under the minimum and names the number', () => {
    const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1)
    expect(validatePasswordChange('old-password-123', short, short)).toBe(
      `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    )
  })

  it('accepts one exactly at the minimum', () => {
    const atLimit = 'a'.repeat(MIN_PASSWORD_LENGTH)
    expect(validatePasswordChange('old-password-123', atLimit, atLimit)).toBeNull()
  })

  it('rejects a new password identical to the current one', () => {
    expect(validatePasswordChange(GOOD, GOOD, GOOD)).toBe(
      'Your new password must be different from your current one.',
    )
  })

  it('catches a confirm box that does not match — the server never sees it', () => {
    expect(validatePasswordChange('old-password-123', GOOD, 'new-password-457')).toBe(
      'The new passwords do not match.',
    )
  })

  it('accepts an ordinary change', () => {
    expect(validatePasswordChange('old-password-123', GOOD, GOOD)).toBeNull()
  })
})

describe('changePassword', () => {
  it('POSTs both passwords as JSON and returns how many sessions were signed out', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ ok: true, signedOutOthers: 2 }))
    expect(await changePassword('old-password-123', GOOD)).toEqual({ ok: true, signedOutOthers: 2 })

    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/account/password')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(init?.body))).toEqual({ current: 'old-password-123', next: GOOD })
  })

  it('treats a missing count as none', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ ok: true }))
    expect(await changePassword('old-password-123', GOOD)).toEqual({ ok: true, signedOutOthers: 0 })
  })

  it('surfaces the server’s own sentence on a wrong current password', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'That is not your current password.' }, 400))
    await expect(changePassword('nope', GOOD)).rejects.toThrow('That is not your current password.')
  })

  it('falls back to a status message when the body is not JSON', async () => {
    mockedFetch.mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(changePassword('old-password-123', GOOD)).rejects.toThrow(
      'Failed to change the password (500)',
    )
  })
})
