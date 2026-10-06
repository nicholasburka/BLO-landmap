import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/apiBase', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/apiBase')>()
  return { ...actual, internalFetch: vi.fn() }
})

import { internalFetch } from '@/lib/apiBase'
import {
  askLibrary,
  askErrorMessage,
  AskRequestError,
  askUrl,
  describeRead,
  describeFilter,
  describeQuery,
  recentQuestions,
  rememberQuestion,
  clearRecentQuestions,
  RECENT_KEY,
  RECENT_MAX,
  noteTitleFromQuestion,
  answerNoteMarkdown,
  answerSectionMarkdown,
  saveAnswerAsNote,
  addAnswerToPage,
  NOTE_TITLE_MAX,
  ANSWER_NOTE_CATEGORY,
  ANSWER_NOTE_TAG,
  type AskQuery,
  type AskAnswer,
} from '@/lib/ask'
import { WikiConflictError } from '@/lib/wiki'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

const ANSWER = {
  answer: 'Two organizations are based in Georgia [1].',
  sources: [{ n: 1, slug: 'organizations', kind: 'dataset', title: 'Organizations', href: '/library/organizations', snippet: 'One row each.', cited: true }],
  queries: [],
  read: { pages: 1, datasets: 1, documents: 0, notes: 0 },
}

beforeEach(() => {
  mockedFetch.mockReset()
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('askLibrary', () => {
  it('POSTs the question and returns the answer', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, ANSWER))
    const result = await askLibrary('  how many orgs in Georgia?  ')
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '  how many orgs in Georgia?  ' }),
    })
    expect(result).toEqual(ANSWER)
  })

  it('carries the dataset hint only when there is one', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(200, ANSWER))
    await askLibrary('how many?', 'organizations')
    expect(JSON.parse((mockedFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      question: 'how many?',
      dataset: 'organizations',
    })
  })

  it('throws an AskRequestError carrying the status and the server message', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(503, { error: "We've hit today's usage cap.", code: 'daily_budget_exceeded' }))
    await expect(askLibrary('anything')).rejects.toMatchObject({ status: 503, message: "We've hit today's usage cap." })
  })

  it('turns a network failure into status 0', async () => {
    mockedFetch.mockRejectedValue(new Error('boom'))
    await expect(askLibrary('anything')).rejects.toMatchObject({ status: 0 })
  })

  it('carries the admin-only reason code, and only when it is one we know', async () => {
    mockedFetch.mockResolvedValue(jsonResponse(503, { error: 'unavailable', reason: 'refused' }))
    await expect(askLibrary('anything')).rejects.toMatchObject({ status: 503, reason: 'refused' })

    // The reason comes off the wire, so anything unrecognised is dropped
    // rather than shown — the same rule every other server value follows.
    mockedFetch.mockResolvedValue(jsonResponse(503, { error: 'unavailable', reason: 'something-new' }))
    await expect(askLibrary('anything')).rejects.toMatchObject({ reason: undefined })

    mockedFetch.mockResolvedValue(jsonResponse(503, { error: 'unavailable' }))
    await expect(askLibrary('anything')).rejects.toMatchObject({ reason: undefined })
  })
})

describe('askErrorMessage', () => {
  it('says something a person can act on for every failure we expect', () => {
    expect(askErrorMessage(new AskRequestError(0, 'offline'))).toMatch(/no connection/i)
    expect(askErrorMessage(new AskRequestError(429, ''))).toMatch(/wait a minute/i)
    expect(askErrorMessage(new AskRequestError(503, "We've hit today's usage cap."))).toBe("We've hit today's usage cap.")
    expect(askErrorMessage(new AskRequestError(503, ''))).toMatch(/budget/i)
    expect(askErrorMessage(new AskRequestError(401, ''))).toMatch(/sign in/i)
    expect(askErrorMessage(new AskRequestError(502, ''))).toMatch(/try again/i)
    expect(askErrorMessage(new Error('other'))).toMatch(/something went wrong/i)
  })

  it('never puts a status code on the screen', () => {
    for (const status of [0, 400, 401, 403, 429, 500, 502, 503]) {
      expect(askErrorMessage(new AskRequestError(status, ''))).not.toMatch(/\b\d{3}\b/)
    }
  })

  // P5-75. Four reasons, four different things to go and do — but only for the
  // person who can do them.
  it('tells an admin which of the four it was', () => {
    const generic = 'The answering service is unavailable right now. Please try again in a minute.'
    const admin = { isAdmin: true }
    expect(askErrorMessage(new AskRequestError(503, generic, 'no-key'), admin)).toBe(
      'The answering model is not configured on the server.',
    )
    expect(askErrorMessage(new AskRequestError(503, generic, 'refused'), admin)).toBe(
      'The model refused the key — check billing or the key.',
    )
    expect(askErrorMessage(new AskRequestError(503, generic, 'rate-limited'), admin)).toBe(
      'The model is rate-limiting us — try again in a minute.',
    )
    expect(askErrorMessage(new AskRequestError(503, generic, 'model-error'), admin)).toBe(
      'The model returned an error — try again in a minute.',
    )
  })

  it('gives a member the generic sentence, never the reason', () => {
    const generic = 'The answering service is unavailable right now. Please try again in a minute.'
    for (const reason of ['no-key', 'refused', 'rate-limited', 'model-error'] as const) {
      const error = new AskRequestError(503, generic, reason)
      expect(askErrorMessage(error)).toBe(generic)
      expect(askErrorMessage(error, { isAdmin: false })).toBe(generic)
      expect(askErrorMessage(error)).not.toMatch(/key|billing|rate-limiting/i)
    }
  })

  it('leaves every other failure alone for an admin too', () => {
    expect(askErrorMessage(new AskRequestError(0, 'offline'), { isAdmin: true })).toMatch(/no connection/i)
    expect(askErrorMessage(new AskRequestError(503, "We've hit today's usage cap."), { isAdmin: true })).toBe(
      "We've hit today's usage cap.",
    )
  })
})

describe('askUrl', () => {
  it('encodes the question, and the dataset hint when present', () => {
    expect(askUrl('  who does land trusts?  ')).toBe('/ask?q=who+does+land+trusts%3F')
    expect(askUrl('how many?', 'organizations')).toBe('/ask?q=how+many%3F&dataset=organizations')
  })
})

describe('recent questions', () => {
  it('remembers newest first, de-duplicates, and caps the list', () => {
    rememberQuestion('first question')
    rememberQuestion('second question')
    rememberQuestion('first question')
    expect(recentQuestions().map(r => r.q)).toEqual(['first question', 'second question'])

    for (let i = 0; i < RECENT_MAX + 5; i++) rememberQuestion(`question ${i}`)
    expect(recentQuestions()).toHaveLength(RECENT_MAX)
    expect(recentQuestions()[0].q).toBe(`question ${RECENT_MAX + 4}`)
  })

  it('keeps the dataset hint, and treats the same words on another table as a separate question', () => {
    rememberQuestion('how many?', 'organizations')
    rememberQuestion('how many?', 'landholders')
    expect(recentQuestions().map(r => r.dataset)).toEqual(['landholders', 'organizations'])
  })

  it('ignores blanks and survives junk in storage', () => {
    rememberQuestion('   ')
    expect(recentQuestions()).toEqual([])
    localStorage.setItem(RECENT_KEY, 'not json')
    expect(recentQuestions()).toEqual([])
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ nope: 1 }, { q: 'ok', at: 1 }]))
    expect(recentQuestions().map(r => r.q)).toEqual(['ok'])
  })

  it('stores under the blo:ask key that logout wipes', () => {
    rememberQuestion('a question')
    expect(localStorage.getItem(RECENT_KEY)).toBeTruthy()
    expect(RECENT_KEY).toBe('blo:ask')
    clearRecentQuestions()
    expect(recentQuestions()).toEqual([])
  })
})

describe('plain-language descriptions', () => {
  it('says what was read', () => {
    expect(describeRead({ pages: 7, datasets: 2, documents: 0, notes: 0 })).toBe('7 pages and 2 datasets')
    expect(describeRead({ pages: 1, datasets: 0, documents: 0, notes: 0 })).toBe('1 page')
    expect(describeRead({ pages: 0, datasets: 0, documents: 0, notes: 0, sources: 3 })).toBe('3 data sources')
    expect(describeRead({ pages: 1, datasets: 1, documents: 1, notes: 0 })).toBe('1 page, 1 dataset and 1 document')
    expect(describeRead({ pages: 0, datasets: 0, documents: 0, notes: 0 })).toBe('')
    expect(describeRead(undefined)).toBe('')
  })

  it('says filters in words, never operator names', () => {
    expect(describeFilter({ column: 'HQ State', op: 'eq', value: 'GA' })).toBe('HQ State is GA')
    expect(describeFilter({ column: 'Score', op: 'gte', value: '50' })).toBe('Score is at least 50')
    expect(describeFilter({ column: 'Score', op: 'lte', value: '50' })).toBe('Score is at most 50')
    expect(describeFilter({ column: 'Notes', op: 'empty' })).toBe('Notes is empty')
    expect(describeFilter({ column: 'Notes', op: 'notEmpty' })).toBe('Notes is filled in')
  })

  it('describes a whole query card', () => {
    const base: AskQuery = { slug: 's', title: 'T', filters: [], rowCount: 3, href: '/library/s?tab=data' }
    expect(describeQuery(base)).toBe('the whole table')
    expect(describeQuery({ ...base, groupBy: 'Tier' })).toBe('the whole table, counted by Tier')
    expect(describeQuery({ ...base, filters: [{ column: 'HQ State', op: 'eq', value: 'GA' }] })).toBe('HQ State is GA')
  })
})

/**
 * P5-48: keeping an answer — as a note of its own, or appended to a page.
 */
describe('keeping an answer (P5-48)', () => {
  const ANSWER_WITH_SOURCES: AskAnswer = {
    answer: 'Two organizations are based in Georgia [1], per the funding page [2].',
    sources: [
      { n: 1, slug: 'organizations', kind: 'dataset', title: 'Organizations', href: '/library/organizations', snippet: '', cited: true },
      { n: 2, slug: 'funding', kind: 'wiki', title: 'Funding [draft]', href: '/wiki/funding', snippet: '', cited: true },
    ],
    queries: [],
    read: { pages: 1, datasets: 1, documents: 0, notes: 0 },
  }

  describe('noteTitleFromQuestion', () => {
    it('uses the question as written, on one line', () => {
      expect(noteTitleFromQuestion('  which\n orgs   are in Georgia?  ')).toBe('which orgs are in Georgia?')
    })

    it('caps a long question at the list limit, cutting between words', () => {
      const title = noteTitleFromQuestion(`${'word '.repeat(60)}end`)
      expect(title.length).toBeLessThanOrEqual(NOTE_TITLE_MAX)
      expect(title.endsWith('…')).toBe(true)
      expect(title).not.toContain('wor…')
    })
  })

  describe('the markdown', () => {
    it('writes the question, the answer, the sources and a way back to Ask', () => {
      const md = answerNoteMarkdown('which orgs are in Georgia?', ANSWER_WITH_SOURCES)
      expect(md).toBe(
        [
          '# which orgs are in Georgia?',
          '',
          'Two organizations are based in Georgia [1], per the funding page [2].',
          '',
          '## Where this came from',
          '- [Organizations](/library/organizations)',
          // brackets in a title would close the link early
          '- [Funding \\[draft\\]](/wiki/funding)',
          '',
          '[Ask this question again](/ask?q=which+orgs+are+in+Georgia%3F)',
          '',
        ].join('\n'),
      )
    })

    it('carries the dataset scope into the Ask link', () => {
      expect(answerNoteMarkdown('how many rows?', ANSWER_WITH_SOURCES, 'orgs')).toContain(
        '(/ask?q=how+many+rows%3F&dataset=orgs)',
      )
    })

    it('leaves the sources list out when the answer cited nothing', () => {
      const md = answerNoteMarkdown('q?', { ...ANSWER_WITH_SOURCES, sources: [] })
      expect(md).not.toContain('Where this came from')
      expect(md).toContain('[Ask this question again]')
    })

    it('starts a page section one level down, so it does not fight the page title', () => {
      const md = answerSectionMarkdown('which orgs are in Georgia?', ANSWER_WITH_SOURCES)
      expect(md.startsWith('## From Ask: which orgs are in Georgia?\n')).toBe(true)
      expect(md).toContain('**Where this came from**')
      expect(md).not.toContain('## Where this came from')
      // same body as the note, so a kept answer reads the same either way
      expect(md).toContain('Two organizations are based in Georgia [1]')
      expect(md).toContain('- [Organizations](/library/organizations)')
    })
  })

  describe('saveAnswerAsNote', () => {
    it('creates a research note tagged ask, titled from the question', async () => {
      mockedFetch.mockResolvedValue(jsonResponse(201, { entry: { slug: 'which-orgs-are-in-georgia', title: 'which orgs are in Georgia?' } }))
      const entry = await saveAnswerAsNote('which orgs are in Georgia?', ANSWER_WITH_SOURCES)
      expect(entry.slug).toBe('which-orgs-are-in-georgia')
      const [path, init] = mockedFetch.mock.calls[0]
      expect(path).toBe('/api/library/entries')
      const body = JSON.parse(String(init!.body))
      expect(body.title).toBe('which orgs are in Georgia?')
      expect(body.category).toBe(ANSWER_NOTE_CATEGORY)
      expect(body.tags).toEqual([ANSWER_NOTE_TAG])
      expect(body.body).toBe(answerNoteMarkdown('which orgs are in Georgia?', ANSWER_WITH_SOURCES))
    })
  })

  describe('addAnswerToPage', () => {
    const page = { slug: 'georgia', title: 'Georgia', markdown: '# Georgia\n\nNotes so far.\n', updatedAt: '2026-09-04T10:00:00.000Z' }

    it('reads the page, appends the section, and saves against the version it read', async () => {
      mockedFetch
        .mockResolvedValueOnce(jsonResponse(200, page))
        .mockResolvedValueOnce(jsonResponse(200, { slug: 'georgia', title: 'Georgia', created: false, updatedAt: '2026-09-05T00:00:00.000Z' }))
      const saved = await addAnswerToPage('georgia', 'which orgs are in Georgia?', ANSWER_WITH_SOURCES)
      expect(saved).toEqual({ slug: 'georgia', title: 'Georgia' })
      const [path, init] = mockedFetch.mock.calls[1]
      expect(path).toBe('/api/wiki/georgia')
      expect(init!.method).toBe('PUT')
      expect((init!.headers as Record<string, string>)['If-Unmodified-Since']).toBe('2026-09-04T10:00:00.000Z')
      const body = String(init!.body)
      expect(body.startsWith('# Georgia\n\nNotes so far.\n\n## From Ask:')).toBe(true)
      expect(body).toContain('- [Organizations](/library/organizations)')
    })

    it('refuses a page that is no longer there instead of creating one', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse(404, {}))
      await expect(addAnswerToPage('gone', 'q?', ANSWER_WITH_SOURCES)).rejects.toThrow(/no page named/)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it('raises a conflict when the page moved on, and a retry re-reads and succeeds', async () => {
      mockedFetch
        .mockResolvedValueOnce(jsonResponse(200, page))
        .mockResolvedValueOnce(jsonResponse(412, { actor: 'nick', updatedAt: '2026-09-04T11:00:00.000Z' }))
      await expect(addAnswerToPage('georgia', 'q?', ANSWER_WITH_SOURCES)).rejects.toBeInstanceOf(WikiConflictError)

      const moved = { ...page, markdown: '# Georgia\n\nNotes so far.\n\nSomeone else wrote this.\n', updatedAt: '2026-09-04T11:00:00.000Z' }
      mockedFetch
        .mockResolvedValueOnce(jsonResponse(200, moved))
        .mockResolvedValueOnce(jsonResponse(200, { slug: 'georgia', title: 'Georgia', created: false }))
      await expect(addAnswerToPage('georgia', 'q?', ANSWER_WITH_SOURCES)).resolves.toEqual({ slug: 'georgia', title: 'Georgia' })
      const [, init] = mockedFetch.mock.calls[3]
      // the retry keeps the other person's paragraph and sends THEIR version
      expect(String(init!.body)).toContain('Someone else wrote this.')
      expect((init!.headers as Record<string, string>)['If-Unmodified-Since']).toBe('2026-09-04T11:00:00.000Z')
    })
  })
})
