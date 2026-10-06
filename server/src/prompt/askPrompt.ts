import type { KbChunk } from '../services/kbSearch.js'
import { topicsSentence } from '../services/taxonomy.js'

/**
 * System prompt + excerpt rendering for "Ask the knowledge base" (P5-41).
 *
 * The audience is a research team, not engineers: answers are short, plain,
 * and cited, and "the library doesn't say" is a correct answer we ask for
 * explicitly rather than hoping the model volunteers it.
 *
 * The system prompt is STATIC (no question, no excerpts) so it caches across
 * asks; the retrieved excerpts ride in the user turn. That also keeps
 * library text — which anyone on the team can author — out of the system
 * role, where it would read as instructions rather than as material.
 */

export function buildAskSystemPrompt(): string {
  return [
    'You answer questions about an internal research library for a team studying Black land ownership and livability.',
    'Your readers are researchers and organizers, not engineers.',
    '',
    '## Rules',
    '',
    '1. Answer ONLY from the excerpts and tool results in this conversation. Never use outside knowledge about the world, and never guess.',
    '2. If the excerpts do not answer the question, say so plainly — "The library does not cover that" — and name the closest thing it does have.',
    '3. Cite every claim with the bracketed number of the excerpt it came from, like [1] or [2][3]. Put the citation right after the sentence it supports.',
    '4. Keep it short: two to five sentences, or a short bulleted list. No preamble, no restating the question, no closing offer to help further.',
    '5. Write in plain words. Say "columns" not "fields", "rows" not "records", "table" not "dataset schema". Never mention excerpts, chunks, indexes, prompts, or tools by name.',
    '6. For questions about counts, totals, or "how many" over a data table, call the `query_dataset` tool and answer from the number it returns rather than estimating from an excerpt.',
    '7. Numbers you report must come from an excerpt or a tool result. Never do arithmetic the sources do not support.',
    '8. A "data source" excerpt describes a dataset held somewhere else — a pointer, not data in the library. When asked what data exists for a place or a topic, list the matching data sources by name with their provider, what each covers, how it is queried for a place (by point, county, or parcel) and how to get it. Never claim results from a data source that was not actually queried; say it would need to be fetched.',
    '',
    '## Sources',
    '',
    'Each excerpt is introduced by a numbered header naming its title and what kind of thing it is (page, dataset, document, note, data source). Those numbers are what you cite.',
    // P5-63: one line, so "what do we have on water" is understood as a
    // subject the library files by rather than as a word to match.
    `Everything in the library is filed under one of these subjects. ${topicsSentence()}`,
  ].join('\n')
}

/** A human label for the kind of thing an excerpt came from. */
export function sourceLabel(chunk: KbChunk): string {
  switch (chunk.source) {
    case 'page':
      return 'wiki page'
    case 'schema':
      return 'data table'
    case 'readme':
      return 'dataset readme'
    case 'note':
      return 'note'
    default:
      return chunk.kind === 'wiki' ? 'wiki page' : chunk.kind === 'incoming' ? 'document (to file)' : chunk.kind === 'source' ? 'data source' : chunk.kind
  }
}

/** The numbered excerpt block sent in the user turn. Numbering here is the
 *  numbering the model cites and the client renders — one list, one order. */
export function renderExcerpts(chunks: KbChunk[]): string {
  if (chunks.length === 0) return 'No excerpts matched this question.'
  return chunks
    .map((chunk, i) => {
      const heading = chunk.heading ? ` › ${chunk.heading}` : ''
      return [`[${i + 1}] ${chunk.title}${heading} (${sourceLabel(chunk)})`, chunk.text].join('\n')
    })
    .join('\n\n')
}

/** The full user turn: excerpts, then the question, then the dataset hint. */
export function buildAskUserMessage(question: string, chunks: KbChunk[], dataset?: { slug: string; title: string }): string {
  const parts = ['## Excerpts from the library', '', renderExcerpts(chunks), '']
  if (dataset) {
    parts.push(
      `The reader is looking at the "${dataset.title}" table (slug \`${dataset.slug}\`). Prefer it when the question is about data, and use \`query_dataset\` with that slug for counts.`,
      '',
    )
  }
  parts.push('## Question', '', question)
  return parts.join('\n')
}
