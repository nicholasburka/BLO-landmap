/**
 * Markdown editing primitives for the page editor (P5-49).
 *
 * The markdown source stays the single truth: every toolbar button is a pure
 * string transform over (text, selectionStart, selectionEnd) and hands back
 * where the selection should land afterwards. No contenteditable, no WYSIWYG
 * library — which is why all of this is testable without a DOM.
 *
 * The caller (PageEditor.vue) is responsible for writing the result back into
 * the textarea and restoring focus + selection.
 */

import { askUrl, type AskAnswer } from './ask'

export interface EditResult {
  text: string
  /** Where the caret (or selection anchor) belongs after the edit. */
  selectionStart: number
  selectionEnd: number
}

// --- Inline marks ----------------------------------------------------------

/**
 * Bold/italic. Toggling is symmetric: wrapping a selection that is already
 * wrapped removes the markers instead of nesting them, whether the markers
 * sit inside the selection or just outside it (both happen depending on how
 * the user dragged). With nothing selected it drops an empty pair and parks
 * the caret between them, so typing continues in the new style.
 */
export function toggleWrap(text: string, start: number, end: number, marker: string): EditResult {
  const selected = text.slice(start, end)
  const len = marker.length

  if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(len, -len)
    return {
      text: text.slice(0, start) + inner + text.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    }
  }

  if (text.slice(start - len, start) === marker && text.slice(end, end + len) === marker) {
    return {
      text: text.slice(0, start - len) + selected + text.slice(end + len),
      selectionStart: start - len,
      selectionEnd: start - len + selected.length,
    }
  }

  const wrapped = marker + selected + marker
  return {
    text: text.slice(0, start) + wrapped + text.slice(end),
    selectionStart: start + len,
    selectionEnd: start + len + selected.length,
  }
}

// --- Line-based marks ------------------------------------------------------

function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf('\n', index - 1) + 1
}

function lineEndOf(text: string, index: number): number {
  const next = text.indexOf('\n', index)
  return next === -1 ? text.length : next
}

/**
 * Section headings only: plain → H2 → H3 → plain. The page's `# Title` is
 * what the server reads as the page title, so the toolbar never *makes* an
 * H1; a stray one demotes to H2 rather than leaving the button feeling dead.
 * Acts on the line the caret is on — headings are a one-line idea.
 */
export function cycleHeading(text: string, start: number, end: number): EditResult {
  const from = lineStartOf(text, start)
  const to = lineEndOf(text, start)
  const line = text.slice(from, to)
  const match = /^(#{1,6})[ \t]+/.exec(line)

  let replacement: string
  if (!match) replacement = `## ${line}`
  else if (match[1].length === 2) replacement = `### ${line.slice(match[0].length)}`
  else if (match[1].length === 3) replacement = line.slice(match[0].length)
  else replacement = `## ${line.slice(match[0].length)}`

  const delta = replacement.length - line.length
  return {
    text: text.slice(0, from) + replacement + text.slice(to),
    selectionStart: Math.max(from, start + delta),
    selectionEnd: Math.max(from, end + delta),
  }
}

const BULLET = /^[-*+][ \t]+/
const NUMBER = /^\d+\.[ \t]+/

/**
 * Bulleted / numbered lists over every line the selection touches (a bare
 * caret counts as its own line). Already-a-list toggles back off; numbers are
 * always rewritten 1..n so a re-ordered list doesn't keep stale numbers.
 * Blank lines are skipped — they separate list items, they aren't items.
 */
export function toggleList(
  text: string,
  start: number,
  end: number,
  kind: 'bullet' | 'number',
): EditResult {
  const from = lineStartOf(text, start)
  const to = lineEndOf(text, end)
  const lines = text.slice(from, to).split('\n')
  const pattern = kind === 'bullet' ? BULLET : NUMBER
  const content = lines.filter(line => line.trim() !== '')
  const allMarked = content.length > 0 && content.every(line => pattern.test(line))

  let n = 0
  const next = lines.map(line => {
    if (line.trim() === '') return line
    if (allMarked) return line.replace(pattern, '')
    const bare = line.replace(BULLET, '').replace(NUMBER, '')
    n += 1
    return kind === 'bullet' ? `- ${bare}` : `${n}. ${bare}`
  })

  const block = next.join('\n')
  return {
    text: text.slice(0, from) + block + text.slice(to),
    selectionStart: from,
    selectionEnd: from + block.length,
  }
}

// --- Links, blocks, embeds -------------------------------------------------

/** Square brackets would end the link text early; backslash-escape them. */
function escapeLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
}

/** Angle-bracket a destination that would otherwise end at a space or paren. */
function escapeHref(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href}>` : href
}

export function markdownLink(label: string, href: string): string {
  return `[${escapeLinkText(label)}](${escapeHref(href)})`
}

/**
 * `[selection](url)`. With nothing selected the link gets placeholder text
 * that comes back selected, so the next keystroke replaces it.
 */
export function insertLink(text: string, start: number, end: number, url: string): EditResult {
  const label = text.slice(start, end)
  const link = markdownLink(label || 'link text', url)
  const inserted = text.slice(0, start) + link + text.slice(end)
  if (label) {
    const caret = start + link.length
    return { text: inserted, selectionStart: caret, selectionEnd: caret }
  }
  return { text: inserted, selectionStart: start + 1, selectionEnd: start + 1 + 'link text'.length }
}

/**
 * Drop a whole block (table, embed fence, citation) on its own line, adding
 * only the blank lines that aren't already there — markdown needs the
 * separation, and the writer shouldn't end up with a gap-riddled page.
 */
export function insertBlock(text: string, start: number, end: number, block: string): EditResult {
  const before = text.slice(0, start)
  const after = text.slice(end)
  const prefix = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  const suffix = after.startsWith('\n\n') ? '' : after === '' || after.startsWith('\n') ? '\n' : '\n\n'
  const caret = before.length + prefix.length + block.length
  return {
    text: before + prefix + block + suffix + after,
    selectionStart: caret,
    selectionEnd: caret,
  }
}

/** A starter table: 3 columns, 2 empty rows to type into. */
export const TABLE_SNIPPET = [
  '| Column | Column | Column |',
  '| --- | --- | --- |',
  '|  |  |  |',
  '|  |  |  |',
].join('\n')

/**
 * The fenced block renderWikiMarkdown turns into an embed (P5-17).
 *
 * `entry` and `view` are cards. `map` (P7-4) is the same saved view as a LIVE
 * canvas — one keyword, one placeholder shape, so the sanitizer's allowlist and
 * this helper both stayed where they were.
 */
export function embedFence(kind: 'entry' | 'view' | 'map', slug: string): string {
  // The opening fence has to END the line. A one-line ```view:x``` is NOT a
  // fenced block — CommonMark forbids backticks in an info string, so the
  // paragraph parser takes over and it comes out as an inline code span. Every
  // embed the picker inserted since P5-49 therefore rendered as the literal
  // text `view:x` instead of a card; found while adding `map:` (P7-4), which
  // would have shipped a button that produced a dead block.
  return '```' + `${kind}:${slug}` + '\n```'
}

// --- Citations from Ask ----------------------------------------------------

/** The answer's opening claim, without the `[1]` markers (the sources are
 *  listed right underneath) and capped so a citation stays a citation. */
const SENTENCE_MAX = 300

export function firstSentence(text: string): string {
  const trimmed = text.trim()
  const match = /[.!?](\s|$)/.exec(trimmed)
  const sentence = match ? trimmed.slice(0, match.index + 1) : trimmed
  if (sentence.length <= SENTENCE_MAX) return sentence
  return `${sentence.slice(0, SENTENCE_MAX).trimEnd()}…`
}

/**
 * A quotable citation: the answer's first sentence as a blockquote, the
 * sources it actually cited as links, and a link back to the live /ask page
 * so a reader can re-run the question and see the full answer.
 */
export function citationMarkdown(question: string, answer: AskAnswer, dataset?: string): string {
  const sentence = firstSentence(answer.answer.replace(/\s*\[\d+\]/g, ''))
  const cited = answer.sources.filter(source => source.cited)
  const sources = cited.length ? cited : answer.sources
  const answerLink = markdownLink(`Asked: "${question}"`, askUrl(question, dataset))
  const sourceLinks = sources.map(source => markdownLink(source.title, source.href)).join(', ')
  const tail = sourceLinks ? `Sources: ${sourceLinks} · ${answerLink}` : answerLink
  const quote = (block: string) => block.split('\n').map(line => `> ${line}`.trimEnd()).join('\n')
  return `${quote(sentence)}\n>\n${quote(tail)}`
}

// --- Draft autosave --------------------------------------------------------
// Unsaved page text is internal content sitting in a browser, so it lives
// under a prefix useAuth wipes at logout (P5-19: nothing internal survives).

export const DRAFT_PREFIX = 'blo:draft:'

export function draftKey(slug: string): string {
  return `${DRAFT_PREFIX}${slug}`
}

export function readDraft(slug: string): string | null {
  try {
    return localStorage.getItem(draftKey(slug))
  } catch {
    return null // private mode — editing still works, just without a safety net
  }
}

export function writeDraft(slug: string, markdown: string): void {
  try {
    localStorage.setItem(draftKey(slug), markdown)
  } catch {
    // storage full or unavailable — never break typing over a draft copy
  }
}

export function clearDraft(slug: string): void {
  try {
    localStorage.removeItem(draftKey(slug))
  } catch {
    /* nothing to clear */
  }
}
