import { describe, it, expect } from 'vitest'
import { buildAskSystemPrompt, renderExcerpts, buildAskUserMessage, sourceLabel } from './askPrompt.js'
import type { KbChunk } from '../services/kbSearch.js'

/** P5-41 prompt shape. The numbering here is what the model cites and what
 *  the client renders, so it is worth pinning down. */

function chunk(over: Partial<KbChunk>): KbChunk {
  return {
    id: 'x',
    slug: 'slug',
    kind: 'wiki',
    title: 'Title',
    source: 'page',
    text: 'body text',
    href: '/wiki/slug',
    layerId: null,
    tf: new Map(),
    titleTerms: new Set(),
    length: 2,
    ...over,
  } as KbChunk
}

describe('buildAskSystemPrompt', () => {
  it('is static, so it caches across every ask', () => {
    expect(buildAskSystemPrompt()).toBe(buildAskSystemPrompt())
  })

  it('tells the model a data source is a pointer, not held data (P5-56)', () => {
    const prompt = buildAskSystemPrompt()
    expect(prompt).toContain('pointer, not data in the library')
    expect(prompt).toContain('how it is queried for a place')
  })

  it('carries the rules that make an answer trustworthy', () => {
    const prompt = buildAskSystemPrompt()
    expect(prompt).toContain('ONLY from the excerpts')
    expect(prompt).toContain('The library does not cover that')
    expect(prompt).toContain('[1]')
    expect(prompt).toContain('query_dataset')
  })

  it('never carries the question or any library text — that is what the user turn is for', () => {
    expect(buildAskSystemPrompt()).not.toContain('Excerpts from the library')
  })
})

describe('sourceLabel', () => {
  it('names each kind of excerpt in words a reader recognises', () => {
    expect(sourceLabel(chunk({ source: 'page' }))).toBe('wiki page')
    expect(sourceLabel(chunk({ source: 'schema' }))).toBe('data table')
    expect(sourceLabel(chunk({ source: 'readme' }))).toBe('dataset readme')
    expect(sourceLabel(chunk({ source: 'note' }))).toBe('note')
    expect(sourceLabel(chunk({ source: 'entry', kind: 'source' }))).toBe('data source')
    expect(sourceLabel(chunk({ source: 'entry', kind: 'dataset' }))).toBe('dataset')
    expect(sourceLabel(chunk({ source: 'entry', kind: 'wiki' }))).toBe('wiki page')
    expect(sourceLabel(chunk({ source: 'entry', kind: 'incoming' }))).toBe('document (to file)')
  })
})

describe('renderExcerpts', () => {
  it('numbers from one and labels each excerpt with its title, heading and kind', () => {
    const rendered = renderExcerpts([
      chunk({ title: 'Funding strategy', heading: 'Year two', text: 'Stewardship.' }),
      chunk({ title: 'Organizations', source: 'schema', kind: 'dataset', text: '3 rows.' }),
    ])
    expect(rendered).toContain('[1] Funding strategy › Year two (wiki page)\nStewardship.')
    expect(rendered).toContain('[2] Organizations (data table)\n3 rows.')
  })

  it('says so plainly when nothing matched', () => {
    expect(renderExcerpts([])).toBe('No excerpts matched this question.')
  })
})

describe('buildAskUserMessage', () => {
  it('puts the excerpts first and the question last', () => {
    const message = buildAskUserMessage('what about year two?', [chunk({ text: 'Stewardship.' })])
    expect(message.indexOf('Stewardship.')).toBeLessThan(message.indexOf('what about year two?'))
    expect(message.trimEnd().endsWith('what about year two?')).toBe(true)
  })

  it('names the pinned table only when there is one', () => {
    const withHint = buildAskUserMessage('how many?', [chunk({})], { slug: 'organizations', title: 'Organizations' })
    expect(withHint).toContain('"Organizations" table')
    expect(withHint).toContain('slug `organizations`')
    expect(buildAskUserMessage('how many?', [chunk({})])).not.toContain('slug `')
  })
})
