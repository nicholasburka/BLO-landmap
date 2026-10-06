import { describe, it, expect, beforeEach } from 'vitest'
import {
  toggleWrap,
  cycleHeading,
  toggleList,
  insertLink,
  insertBlock,
  embedFence,
  citationMarkdown,
  firstSentence,
  TABLE_SNIPPET,
  DRAFT_PREFIX,
  draftKey,
  readDraft,
  writeDraft,
  clearDraft,
} from '../editor'
import { renderWikiMarkdown } from '../renderMarkdown'
import type { AskAnswer } from '../ask'

/** Readable fixture: `|` marks the caret, `[…]` marks a selection. */
function edit(
  marked: string,
  run: (text: string, start: number, end: number) => { text: string; selectionStart: number; selectionEnd: number },
): string {
  const start = marked.indexOf('[')
  let text: string
  let from: number
  let to: number
  if (start >= 0) {
    const end = marked.indexOf(']')
    text = marked.slice(0, start) + marked.slice(start + 1, end) + marked.slice(end + 1)
    from = start
    to = end - 1
  } else {
    from = to = marked.indexOf('|')
    text = marked.replace('|', '')
  }
  const result = run(text, from, to)
  // Re-mark the result so assertions read like the input.
  if (result.selectionStart === result.selectionEnd) {
    return result.text.slice(0, result.selectionStart) + '|' + result.text.slice(result.selectionStart)
  }
  return (
    result.text.slice(0, result.selectionStart) +
    '[' +
    result.text.slice(result.selectionStart, result.selectionEnd) +
    ']' +
    result.text.slice(result.selectionEnd)
  )
}

describe('toggleWrap (bold / italic)', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(edit('the [soil] survey', (t, s, e) => toggleWrap(t, s, e, '**'))).toBe('the **[soil]** survey')
  })

  it('unwraps a selection that is already wrapped', () => {
    expect(edit('the **[soil]** survey', (t, s, e) => toggleWrap(t, s, e, '**'))).toBe('the [soil] survey')
  })

  it('unwraps when the markers are inside the selection', () => {
    expect(edit('the [**soil**] survey', (t, s, e) => toggleWrap(t, s, e, '**'))).toBe('the [soil] survey')
  })

  it('with no selection drops empty markers and puts the caret between them', () => {
    expect(edit('start |', (t, s, e) => toggleWrap(t, s, e, '_'))).toBe('start _|_')
  })
})

describe('cycleHeading', () => {
  it('turns a plain line into an H2', () => {
    expect(edit('Findings|', cycleHeading)).toBe('## Findings|')
  })

  it('cycles H2 to H3 and H3 back to plain', () => {
    expect(edit('## Find|ings', cycleHeading)).toBe('### Find|ings')
    expect(edit('### Find|ings', cycleHeading)).toBe('Find|ings')
  })

  it('demotes a stray H1 to H2 rather than leaving the button dead', () => {
    expect(edit('# Ti|tle', cycleHeading)).toBe('## Ti|tle')
  })

  it('only touches the line the caret is on', () => {
    expect(edit('intro\nFind|ings\noutro', cycleHeading)).toBe('intro\n## Find|ings\noutro')
  })
})

describe('toggleList', () => {
  it('bullets every selected line', () => {
    expect(edit('[one\ntwo]', (t, s, e) => toggleList(t, s, e, 'bullet'))).toBe('[- one\n- two]')
  })

  it('numbers every selected line, renumbering from 1', () => {
    expect(edit('[one\ntwo\nthree]', (t, s, e) => toggleList(t, s, e, 'number'))).toBe(
      '[1. one\n2. two\n3. three]',
    )
  })

  it('removes the markers when every line already has them', () => {
    expect(edit('[- one\n- two]', (t, s, e) => toggleList(t, s, e, 'bullet'))).toBe('[one\ntwo]')
  })

  it('expands a caret to the whole line it sits on', () => {
    expect(edit('one\ntw|o', (t, s, e) => toggleList(t, s, e, 'bullet'))).toBe('one\n[- two]')
  })

  it('leaves blank lines alone', () => {
    expect(edit('[one\n\ntwo]', (t, s, e) => toggleList(t, s, e, 'bullet'))).toBe('[- one\n\n- two]')
  })
})

describe('insertLink', () => {
  it('wraps the selection and leaves the caret after the link', () => {
    expect(edit('see [the guide] here', (t, s, e) => insertLink(t, s, e, '/wiki/guide'))).toBe(
      'see [the guide](/wiki/guide)| here',
    )
  })

  it('with no selection inserts placeholder text and selects it for typing over', () => {
    expect(edit('see |', (t, s, e) => insertLink(t, s, e, 'https://x.test'))).toBe(
      'see [[link text]](https://x.test)',
    )
  })
})

describe('insertBlock', () => {
  it('puts the block on its own line with blank lines around it', () => {
    const result = insertBlock('Intro text', 10, 10, '```entry:soil```')
    expect(result.text).toBe('Intro text\n\n```entry:soil```\n')
    // Caret lands after the block so the writer keeps going below it.
    expect(result.selectionStart).toBe(result.text.indexOf('```entry:soil```') + '```entry:soil```'.length)
    expect(result.selectionEnd).toBe(result.selectionStart)
  })

  it('does not pile up blank lines that are already there', () => {
    const result = insertBlock('Intro\n\nOutro', 7, 7, 'BLOCK')
    expect(result.text).toBe('Intro\n\nBLOCK\n\nOutro')
  })

  it('replaces the selection', () => {
    expect(insertBlock('a\n\nold\n\nb', 3, 6, 'NEW').text).toBe('a\n\nNEW\n\nb')
  })

  it('the table snippet is 3 columns wide with 2 body rows', () => {
    const rows = TABLE_SNIPPET.trim().split('\n')
    expect(rows).toHaveLength(4) // header, separator, 2 body rows
    for (const row of rows) expect(row.split('|').filter(cell => cell !== '')).toHaveLength(3)
  })
})

describe('embedFence', () => {
  /**
   * The assertion that used to live here claimed the one-line form was "the
   * fenced block hydrateEmbeds understands" and it was not: CommonMark forbids
   * backticks in a fence's info string, so ```view:x``` parses as an inline
   * code span and renders as literal text. The opening fence has to end the
   * line. Found while adding `map:` (P7-4) — so this now checks what it always
   * said it checked, by rendering it.
   */
  it('writes a block the renderer turns into a placeholder, for all three kinds', () => {
    for (const [kind, slug] of [
      ['entry', 'organizations'],
      ['view', 'tn-target-counties'],
      ['map', 'tn-target-counties'],
    ] as const) {
      expect(embedFence(kind, slug)).toBe('```' + `${kind}:${slug}` + '\n```')
      const html = renderWikiMarkdown(`Intro\n\n${embedFence(kind, slug)}\n`)
      expect(html).toContain(`data-embed="${kind}"`)
      expect(html).toContain(`data-embed-slug="${slug}"`)
      expect(html).not.toContain('<code>')
    }
  })
})

describe('firstSentence', () => {
  it('stops at the first sentence end', () => {
    expect(firstSentence('Six counties qualify. The rest are close.')).toBe('Six counties qualify.')
    expect(firstSentence('How many? Twelve.')).toBe('How many?')
  })

  it('returns the whole thing when there is no sentence end', () => {
    expect(firstSentence('no terminator here')).toBe('no terminator here')
  })

  it('caps a runaway sentence', () => {
    const long = `${'word '.repeat(200)}end.`
    const cut = firstSentence(long)
    expect(cut.length).toBeLessThanOrEqual(303)
    expect(cut.endsWith('…')).toBe(true)
  })
})

function answer(overrides: Partial<AskAnswer> = {}): AskAnswer {
  return {
    answer: 'Twelve counties clear the threshold [1][2]. Three more are within a point.',
    sources: [
      { n: 1, slug: 'organizations', kind: 'dataset', title: 'Organizations', href: '/library/organizations', snippet: '', cited: true },
      { n: 2, slug: 'tn-strategy', kind: 'wiki', title: 'TN Strategy', href: '/wiki/tn-strategy', snippet: '', cited: true },
      { n: 3, slug: 'unread', kind: 'document', title: 'Unread lead', href: '/library/unread', snippet: '', cited: false },
    ],
    queries: [],
    read: { pages: 1, datasets: 1, documents: 0, notes: 0 },
    ...overrides,
  }
}

describe('citationMarkdown', () => {
  it('quotes the first sentence, lists the cited sources, and links back to the answer', () => {
    const md = citationMarkdown('which counties qualify?', answer())
    expect(md).toBe(
      '> Twelve counties clear the threshold.\n' +
        '>\n' +
        '> Sources: [Organizations](/library/organizations), [TN Strategy](/wiki/tn-strategy) · ' +
        '[Asked: "which counties qualify?"](/ask?q=which+counties+qualify%3F)',
    )
  })

  it('falls back to every source when the answer cited none', () => {
    const md = citationMarkdown('q', answer({ sources: [{ n: 1, slug: 'a', kind: 'note', title: 'A note', href: '/library/a', snippet: '', cited: false }] }))
    expect(md).toContain('[A note](/library/a)')
  })

  it('keeps the dataset on the answer link and drops the Sources line when there are none', () => {
    const md = citationMarkdown('q', answer({ sources: [] }), 'organizations')
    expect(md).not.toContain('Sources:')
    expect(md).toContain('dataset=organizations')
  })

  it('escapes brackets in a source title so the link cannot break', () => {
    const md = citationMarkdown('q', answer({ sources: [{ n: 1, slug: 'a', kind: 'note', title: 'A [draft] note', href: '/library/a', snippet: '', cited: true }] }))
    expect(md).toContain('[A \\[draft\\] note](/library/a)')
  })
})

describe('draft storage', () => {
  beforeEach(() => localStorage.clear())

  it('keys drafts under the prefix logout wipes', () => {
    expect(DRAFT_PREFIX).toBe('blo:draft:')
    expect(draftKey('tn-strategy')).toBe('blo:draft:tn-strategy')
  })

  it('round-trips a draft and clears it', () => {
    writeDraft('tn-strategy', '# Work in progress')
    expect(localStorage.getItem('blo:draft:tn-strategy')).toBe('# Work in progress')
    expect(readDraft('tn-strategy')).toBe('# Work in progress')
    clearDraft('tn-strategy')
    expect(readDraft('tn-strategy')).toBeNull()
  })

  it('survives storage being unavailable', () => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = () => {
      throw new Error('private mode')
    }
    Storage.prototype.setItem = () => {
      throw new Error('private mode')
    }
    try {
      expect(() => writeDraft('x', 'y')).not.toThrow()
      expect(readDraft('x')).toBeNull()
    } finally {
      Storage.prototype.getItem = getItem
      Storage.prototype.setItem = setItem
    }
  })
})
