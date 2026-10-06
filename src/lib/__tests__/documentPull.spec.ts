import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'http://api.test',
}))

import { internalFetch } from '../apiBase'
import { pullDocuments, pullSummary, PULL_STATUS_TEXT, PULL_ERROR_FALLBACK } from '../documentPull'

/** P5-80: the browser half of "pull these documents in". */

const mockedFetch = vi.mocked(internalFetch)

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}
function bad(status: number, body?: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => {
      if (body === undefined) throw new Error('not json')
      return body
    },
  } as unknown as Response
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe('pulling documents in', () => {
  it('posts the chosen URLs and hands back the per-file results', async () => {
    mockedFetch.mockResolvedValue(ok({ results: [{ url: 'https://x.example/a.pdf', status: 'stored', file: 'a.pdf' }] }))
    const results = await pullDocuments('entry slug', ['https://x.example/a.pdf'])

    expect(results).toEqual([{ url: 'https://x.example/a.pdf', status: 'stored', file: 'a.pdf' }])
    const [path, init] = mockedFetch.mock.calls[0]
    // The slug reaches a URL and is not ours to trust.
    expect(path).toBe('/api/library/catalog/entry%20slug/documents')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ urls: ['https://x.example/a.pdf'] })
  })

  it('surfaces the server’s sentence when it refuses', async () => {
    mockedFetch.mockResolvedValue(bad(400, { error: '"https://evil.example/x.pdf" is not one of the documents on this page.' }))
    await expect(pullDocuments('a', ['https://evil.example/x.pdf'])).rejects.toThrow(/not one of the documents/)
  })

  it('has a sentence of its own when the server sends none', async () => {
    mockedFetch.mockResolvedValue(bad(502))
    await expect(pullDocuments('a', ['https://x.example/a.pdf'])).rejects.toThrow(PULL_ERROR_FALLBACK)
  })

  it('answers an empty results list rather than undefined', async () => {
    mockedFetch.mockResolvedValue(ok({}))
    expect(await pullDocuments('a', [])).toEqual([])
  })
})

describe('what a person is told afterwards', () => {
  const stored = (url: string) => ({ url, status: 'stored' as const, file: 'x.pdf' })

  it('says where the files went when everything worked', () => {
    expect(pullSummary([stored('a'), stored('b')])).toMatch(/Pulled in 2 documents.*under Files/)
    expect(pullSummary([stored('a')])).toMatch(/Pulled in 1 document\./)
  })

  it('counts the ones that did not, and points at the reasons', () => {
    const mixed = [stored('a'), { url: 'b', status: 'unreachable' as const, error: 'could not reach the site' }]
    expect(pullSummary(mixed)).toMatch(/Pulled in 1 of 2/)
    expect(pullSummary([{ url: 'b', status: 'too-large' as const }])).toMatch(/None of those/)
    expect(pullSummary([])).toBe('')
  })

  it('names every outcome in words', () => {
    expect(Object.values(PULL_STATUS_TEXT).every(text => text.length > 0)).toBe(true)
    expect(PULL_STATUS_TEXT['not-a-document']).toBe('was not a document')
  })
})
