import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  // Saving a page drops the catalog cache (P5-89), which pulls useAuth in: an
  // empty API_URL keeps its boot hydration off the network, and the logout hook
  // it registers clears the CSRF token.
  setInternalCsrfToken: vi.fn(),
  API_URL: '',
}))

import { internalFetch } from '../apiBase'
import { slugifyWikiTitle, fetchWikiPage, saveWikiPage, WikiConflictError, WIKI_PAGE_MAX_BYTES } from '../wiki'

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

describe('slugifyWikiTitle', () => {
  it.each([
    ['Heirs Property Guide', 'heirs-property-guide'],
    ['  Land   Loss — 1910–1970  ', 'land-loss-1910-1970'],
    ['USDA §2501 (Outreach)', 'usda-2501-outreach'],
    ['already-a-slug', 'already-a-slug'],
    ['---leading and trailing---', 'leading-and-trailing'],
  ])('turns %j into %j', (input, expected) => {
    expect(slugifyWikiTitle(input)).toBe(expected)
  })

  it('caps the slug at the server limit of 80 chars', () => {
    const slug = slugifyWikiTitle('x'.repeat(200))
    expect(slug.length).toBeLessThanOrEqual(80)
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]*$/)
  })

  it('returns an empty string when nothing survives (caller must handle)', () => {
    expect(slugifyWikiTitle('!!! ¿¿¿ ***')).toBe('')
  })
})

describe('fetchWikiPage', () => {
  it('GETs the page and returns slug/title/markdown', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'field-guide', title: 'Field Guide', markdown: '# Field Guide\n\nHello.' }),
    )
    const page = await fetchWikiPage('field-guide')
    expect(mockedFetch).toHaveBeenCalledWith('/api/wiki/field-guide')
    expect(page).toEqual({ slug: 'field-guide', title: 'Field Guide', markdown: '# Field Guide\n\nHello.' })
  })

  it('returns null on 404 (page does not exist yet)', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'not found' }, 404))
    expect(await fetchWikiPage('nope')).toBeNull()
  })

  it('throws with the server message on other failures', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'library unavailable' }, 503))
    await expect(fetchWikiPage('field-guide')).rejects.toThrow('library unavailable')
  })
})

describe('saveWikiPage', () => {
  it('PUTs the raw markdown body with a markdown content type', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'field-guide', title: 'Field Guide', created: true }, 201),
    )
    const result = await saveWikiPage('field-guide', '# Field Guide\n\nHello.')
    expect(result).toEqual({ slug: 'field-guide', title: 'Field Guide', created: true })
    const [path, init] = mockedFetch.mock.calls[0]
    expect(path).toBe('/api/wiki/field-guide')
    expect(init?.method).toBe('PUT')
    expect(init?.body).toBe('# Field Guide\n\nHello.')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('text/markdown')
  })

  it('reports created: false on an update', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'field-guide', title: 'Field Guide v2', created: false }, 200),
    )
    const result = await saveWikiPage('field-guide', '# Field Guide v2')
    expect(result.created).toBe(false)
  })

  it('rejects an oversize page client-side without any network call', async () => {
    const big = 'x'.repeat(WIKI_PAGE_MAX_BYTES + 1)
    await expect(saveWikiPage('big', big)).rejects.toThrow(/1 MB/)
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('surfaces server validation messages (e.g. slug taken)', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ error: 'this slug is taken by a non-wiki catalog entry' }, 409),
    )
    await expect(saveWikiPage('tn-heirs', '# x')).rejects.toThrow('non-wiki catalog entry')
  })
})

describe('conflict handling (P5-49)', () => {
  it('reads updatedAt off the page so the editor has a baseline', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'p', title: 'P', markdown: '# P', updatedAt: '2026-09-05T10:00:00.000Z' }),
    )
    expect((await fetchWikiPage('p'))?.updatedAt).toBe('2026-09-05T10:00:00.000Z')
  })

  it('sends the baseline as If-Unmodified-Since and returns the new one', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ slug: 'p', title: 'P', created: false, updatedAt: '2026-09-05T11:00:00.000Z' }),
    )
    const result = await saveWikiPage('p', '# P', { ifUnmodifiedSince: '2026-09-05T10:00:00.000Z' })
    const [, init] = mockedFetch.mock.calls[0]
    expect(new Headers(init?.headers).get('If-Unmodified-Since')).toBe('2026-09-05T10:00:00.000Z')
    expect(result.updatedAt).toBe('2026-09-05T11:00:00.000Z')
  })

  it('omits the header when there is no baseline — that is the "save anyway" path', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ slug: 'p', title: 'P', created: false }))
    await saveWikiPage('p', '# P')
    const [, init] = mockedFetch.mock.calls[0]
    expect(new Headers(init?.headers).has('If-Unmodified-Since')).toBe(false)
  })

  it('turns a 412 into a WikiConflictError naming the actor, in plain language', async () => {
    mockedFetch.mockResolvedValue(
      jsonResponse({ error: 'this page changed while you were editing', actor: 'maria', updatedAt: '2026-09-05T11:00:00.000Z' }, 412),
    )
    const error = await saveWikiPage('p', '# P', { ifUnmodifiedSince: '2026-09-05T10:00:00.000Z' }).catch(e => e)
    expect(error).toBeInstanceOf(WikiConflictError)
    expect(error.actor).toBe('maria')
    expect(error.updatedAt).toBe('2026-09-05T11:00:00.000Z')
    expect(error.message).toBe(
      'This page changed while you were editing (by maria). Reload to see the latest, or save anyway (overwrites).',
    )
  })

  it('leaves the actor out of the sentence when the server does not know who', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'this page changed while you were editing' }, 412))
    const error = await saveWikiPage('p', '# P', { ifUnmodifiedSince: 'x' }).catch(e => e)
    expect(error.message).toBe(
      'This page changed while you were editing. Reload to see the latest, or save anyway (overwrites).',
    )
  })
})
