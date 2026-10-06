import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  // A fixed base so the continue-URL assertions below are about the path we
  // build, not about how the real module resolves VITE_API_URL.
  API_URL: 'https://api.example.com',
}))

import { internalFetch } from '../apiBase'
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  validateTokenName,
  TOKEN_NAME_MAX,
  WRITE_SCOPE,
  authorizationContinueUrl,
  getPendingAuthorization,
  listOAuthGrants,
  revokeOAuthGrant,
  type ApiTokenSummary,
  type OAuthGrantSummary,
} from '../apiTokens'

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

const SUMMARY: ApiTokenSummary = {
  id: 7,
  name: 'Claude Desktop — laptop',
  scopes: ['library:read'],
  createdAt: '2026-09-05T12:00:00.000Z',
  lastUsedAt: null,
}

describe('validateTokenName', () => {
  it('rejects an empty name', () => {
    expect(validateTokenName('')).toBe('Give the token a name so you can tell it apart later.')
  })

  it('rejects a whitespace-only name', () => {
    expect(validateTokenName('   ')).toBe('Give the token a name so you can tell it apart later.')
  })

  it('rejects a name longer than the server limit and names the limit', () => {
    const problem = validateTokenName('a'.repeat(TOKEN_NAME_MAX + 1))
    expect(problem).toContain(String(TOKEN_NAME_MAX))
  })

  it('accepts a name exactly at the limit', () => {
    expect(validateTokenName('a'.repeat(TOKEN_NAME_MAX))).toBeNull()
  })

  it('accepts an ordinary name', () => {
    expect(validateTokenName('Claude Desktop — laptop')).toBeNull()
  })
})

describe('listApiTokens', () => {
  it('GETs /api/library/tokens and returns the summaries', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ tokens: [SUMMARY] }))
    expect(await listApiTokens()).toEqual([SUMMARY])
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/tokens')
  })

  it('returns an empty list when the server omits the field', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({}))
    expect(await listApiTokens()).toEqual([])
  })

  it('surfaces the server error message on failure', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(listApiTokens()).rejects.toThrow('library unavailable')
  })

  it('falls back to a status message when the body is not JSON', async () => {
    mockedFetch.mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(listApiTokens()).rejects.toThrow('Failed to load tokens (500)')
  })
})

describe('createApiToken', () => {
  it('POSTs the name as JSON and returns the one-time secret', async () => {
    const minted = {
      token: 'blo_abc123',
      id: 7,
      name: 'Claude Desktop — laptop',
      createdAt: SUMMARY.createdAt,
      scopes: ['library:read'],
    }
    mockedFetch.mockResolvedValue(jsonResponse(minted, 201))
    expect(await createApiToken('Claude Desktop — laptop')).toEqual(minted)

    expect(mockedFetch).toHaveBeenCalledTimes(1)
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/tokens')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
    // No `write` field at all unless it was asked for (P5-52).
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Claude Desktop — laptop' })
  })

  it('sends the trimmed name the client validated', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ token: 'blo_x', id: 8, name: 'laptop', createdAt: SUMMARY.createdAt, scopes: [] }, 201))
    await createApiToken('  laptop  ')
    expect(JSON.parse(String(mockedFetch.mock.calls[0][1]?.body))).toEqual({ name: 'laptop' })
  })

  it('asks for the write scope only when the caller says so (P5-52)', async () => {
    const minted = { token: 'blo_w', id: 9, name: 'writer', createdAt: SUMMARY.createdAt, scopes: ['read', WRITE_SCOPE] }
    mockedFetch.mockResolvedValue(jsonResponse(minted, 201))
    expect((await createApiToken('writer', true)).scopes).toContain(WRITE_SCOPE)
    expect(JSON.parse(String(mockedFetch.mock.calls[0][1]?.body))).toEqual({ name: 'writer', write: true })

    mockedFetch.mockResolvedValue(jsonResponse({ ...minted, scopes: ['read'] }, 201))
    await createApiToken('reader', false)
    expect(JSON.parse(String(mockedFetch.mock.calls[1][1]?.body))).toEqual({ name: 'reader' })
  })

  it('surfaces the server error message on a rejected name', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'a token name is required' }, 400))
    await expect(createApiToken('x')).rejects.toThrow('a token name is required')
  })
})

describe('revokeApiToken', () => {
  it('DELETEs /api/library/tokens/:id', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ revoked: true }))
    await expect(revokeApiToken(7)).resolves.toBeUndefined()
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/library/tokens/7')
    expect(init?.method).toBe('DELETE')
  })

  it('surfaces the server error message when the token is gone', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    await expect(revokeApiToken(7)).rejects.toThrow('not found')
  })
})

// --- OAuth connections (P5-51) ----------------------------------------------

const GRANT: OAuthGrantSummary = {
  id: 'family-1',
  clientName: 'ChatGPT',
  scopes: ['read'],
  createdAt: '2026-09-05T12:00:00.000Z',
  lastUsedAt: null,
}

describe('listOAuthGrants', () => {
  it('returns the grants the server lists', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ grants: [GRANT] }))
    await expect(listOAuthGrants()).resolves.toEqual([GRANT])
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/oauth/grants')
  })

  it('treats a body with no grants key as none connected', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({}))
    await expect(listOAuthGrants()).resolves.toEqual([])
  })

  it('surfaces the server error message', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(listOAuthGrants()).rejects.toThrow('library unavailable')
  })
})

describe('revokeOAuthGrant', () => {
  it('DELETEs the grant by id', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ revoked: true }))
    await revokeOAuthGrant('family-1')
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/oauth/grants/family-1', { method: 'DELETE' })
  })

  it('escapes an id rather than letting it shape the path', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ revoked: true }))
    await revokeOAuthGrant('a/../b')
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/oauth/grants/a%2F..%2Fb', { method: 'DELETE' })
  })

  it('throws on failure', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    await expect(revokeOAuthGrant('nope')).rejects.toThrow('not found')
  })
})

describe('getPendingAuthorization', () => {
  it('returns the waiting app', async () => {
    const pending = { clientName: 'ChatGPT', scopes: ['read'], scopeDescriptions: ['Read the library'] }
    mockedFetch.mockResolvedValue(jsonResponse(pending))
    await expect(getPendingAuthorization('abc')).resolves.toEqual(pending)
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/oauth/pending/abc')
  })

  it('returns null for an expired request instead of throwing', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    await expect(getPendingAuthorization('abc')).resolves.toBeNull()
  })

  it('still throws on a real failure', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(getPendingAuthorization('abc')).rejects.toThrow('library unavailable')
  })
})

describe('authorizationContinueUrl', () => {
  it('points back at the API, not at anything from the page', () => {
    expect(authorizationContinueUrl('abc')).toBe('https://api.example.com/oauth/authorize/continue/abc')
  })

  it('encodes the id, so a crafted one cannot bend the URL', () => {
    expect(authorizationContinueUrl('../../evil')).toBe(
      'https://api.example.com/oauth/authorize/continue/..%2F..%2Fevil',
    )
  })
})
