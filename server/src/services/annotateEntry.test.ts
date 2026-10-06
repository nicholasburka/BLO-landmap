import { describe, it, expect, vi, afterEach } from 'vitest'
import type { CatalogEntryRow } from './libraryCatalog.js'
import {
  ANNOTATE_COST_CENTS,
  EVIDENCE_MAX_CHARS,
  annotateEntry,
  annotateMaxTokens,
  buildAnnotateSystemPrompt,
  buildAnnotateUserMessage,
  isAnnotateError,
  organizationMenu,
  parseAnnotation,
  shapeMenu,
} from './annotateEntry.js'
import { resetAssistantClient, type AnthropicLike } from './assistantCall.js'
import { WHAT_IT_ANSWERS_MAX_CHARS } from './provenance.js'

/**
 * P6-8: the wider read of a bulk-dropped document.
 *
 * Every test here proves one half of the ticket's rule — the model may propose
 * seven things, and only from vocabularies the server already knows.
 */

const AT = '2026-09-23T10:00:00.000Z'

afterEach(() => {
  resetAssistantClient()
  delete process.env.LIBRARY_ANNOTATE_MAX_TOKENS
})

/** A stub Anthropic that answers once with `text`. */
function stubClient(text: string, usage = { input_tokens: 1200, output_tokens: 180 }): AnthropicLike {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text }],
        usage,
        stop_reason: 'end_turn',
      }),
    },
  } as unknown as AnthropicLike
}

function failingClient(err: unknown): AnthropicLike {
  return { messages: { create: vi.fn().mockRejectedValue(err) } } as unknown as AnthropicLike
}

const ENTRY = { slug: 'drop-1', title: 'field notes.pdf', kind: 'incoming' } as unknown as CatalogEntryRow
const PAGES = { file: 'field-notes.pdf', text: 'Heirs property in the Black Belt, 2024.' }

describe('the prompt', () => {
  it('offers only vocabularies the server knows', () => {
    const user = buildAnnotateUserMessage({ file: 'a.pdf', text: 'words', currentTitle: 'a.pdf' })
    expect(organizationMenu()).toContain('epa (US EPA)')
    expect(shapeMenu()).toContain('statistics (Statistics by county or tract)')
    for (const field of ['title', 'summary', 'organization', 'topic', 'purpose', 'tags', 'shape', 'whatItAnswers', 'covers', 'published', 'evidence']) {
      expect(user).toContain(`"${field}"`)
    }
    // P6-34: the topic is APPLIED rather than proposed, so it has to arrive
    // with the sentence it was read from — a value nobody can check is a value
    // nobody can verify.
    expect(user).toContain('one short sentence copied from the text above')
    // P7-7: the one CAPABILITY field, asked for as a question rather than a
    // restatement — which is the only place that rule can live, because a
    // line everybody fills with the title is worse than no line (§F.4d).
    expect(user).toContain('naming a question this data can answer')
    expect(user).toContain('Never restate the title')
    expect(user).toContain(`at most ${WHAT_IT_ANSWERS_MAX_CHARS} characters`)
    expect(user).toContain('Currently filed as: a.pdf')
    expect(user).toContain('words')
  })

  it('tells the model to leave a field out rather than invent one', () => {
    expect(buildAnnotateSystemPrompt()).toContain('Leave a field out rather than inventing a value for it.')
  })

  it('takes its answer cap from the environment', () => {
    // 1,500, raised from 600 after a measured failure: the Ask model reasons
    // before it answers and the thinking block is spent out of the same
    // budget, so 600 left nothing for the answer. See `annotateMaxTokens`.
    expect(annotateMaxTokens()).toBe(1_500)
    process.env.LIBRARY_ANNOTATE_MAX_TOKENS = '250'
    expect(annotateMaxTokens()).toBe(250)
    // A nonsense override falls back rather than capping at zero.
    process.env.LIBRARY_ANNOTATE_MAX_TOKENS = 'wide'
    expect(annotateMaxTokens()).toBe(1_500)
  })
})

describe('parseAnnotation', () => {
  it('keeps every field the vocabularies allow', () => {
    const annotation = parseAnnotation(
      JSON.stringify({
        title: 'Heirs property in the Black Belt',
        summary: 'A 2024 survey of heirs property across twelve counties.',
        organization: 'usda',
        topic: 'land',
        purpose: 'research',
        tags: ['Heirs Property', 'black-belt'],
        shape: 'statistics',
      }),
      'model-x',
      AT,
    )
    expect(annotation).toMatchObject({
      title: 'Heirs property in the Black Belt',
      organization: 'usda',
      topic: 'land',
      purpose: 'research',
      shape: 'statistics',
      at: AT,
      model: 'model-x',
    })
    expect(annotation?.tags).toEqual(['heirs-property', 'black-belt'])
  })

  it('files the topic as the category, because a subject beats a use', () => {
    expect(parseAnnotation('{"topic":"housing","purpose":"strategy"}', 'm', AT)?.category).toBe('housing')
    expect(parseAnnotation('{"purpose":"strategy"}', 'm', AT)?.category).toBe('strategy')
  })

  it('drops a word no vocabulary knows rather than minting one', () => {
    const annotation = parseAnnotation(
      '{"title":"A report","organization":"ministry-of-land","topic":"vibes","shape":"geospatial"}',
      'm',
      AT,
    )
    expect(annotation?.title).toBe('A report')
    expect(annotation?.organization).toBeUndefined()
    expect(annotation?.topic).toBeUndefined()
    expect(annotation?.category).toBeUndefined()
    expect(annotation?.shape).toBeUndefined()
  })

  it('folds an alias instead of dropping it on a spelling', () => {
    expect(parseAnnotation('{"topic":"Demographics"}', 'm', AT)?.topic).toBe('demographic')
  })

  it('reads the object out of a fenced answer', () => {
    expect(parseAnnotation('```json\n{"title":"Fenced"}\n```', 'm', AT)?.title).toBe('Fenced')
  })

  it('returns null when nothing survived', () => {
    expect(parseAnnotation('{"topic":"vibes"}', 'm', AT)).toBeNull()
    expect(parseAnnotation('not json at all', 'm', AT)).toBeNull()
  })

  it('drops an over-long title and summary on their own', () => {
    const annotation = parseAnnotation(
      JSON.stringify({ title: 'x'.repeat(200), summary: 'y'.repeat(900), topic: 'water' }),
      'm',
      AT,
    )
    expect(annotation?.title).toBeUndefined()
    expect(annotation?.summary).toBeUndefined()
    expect(annotation?.topic).toBe('water')
  })
})

describe('annotateEntry', () => {
  it('asks once and returns the proposal', async () => {
    const client = stubClient('{"title":"Land loss, 1910-2020","topic":"land","organization":"usda"}')
    const outcome = await annotateEntry('drop-1', { entry: ENTRY, text: PAGES, client })
    expect(outcome && isAnnotateError(outcome)).toBe(false)
    expect(outcome).toMatchObject({ title: 'Land loss, 1910-2020', topic: 'land', organization: 'usda' })
    expect((client.messages.create as any).mock.calls).toHaveLength(1)
  })

  it('records why when the model refused the key, rather than throwing', async () => {
    const client = failingClient(Object.assign(new Error('credit balance is too low'), { status: 400 }))
    const outcome = await annotateEntry('drop-1', { entry: ENTRY, text: PAGES, client })
    expect(outcome).toMatchObject({ error: 'unavailable', reason: 'refused' })
  })

  it('records "unavailable" when the answer holds nothing usable', async () => {
    const outcome = await annotateEntry('drop-1', { entry: ENTRY, text: PAGES, client: stubClient('sorry, no') })
    expect(outcome).toMatchObject({ error: 'unavailable' })
    expect((outcome as { reason?: string }).reason).toBeUndefined()
  })

  it('is null when there is nothing to read', async () => {
    const entry = { ...ENTRY, files: [], meta: {} } as unknown as CatalogEntryRow
    expect(await annotateEntry('drop-1', { entry, client: stubClient('{"title":"x"}') })).toBeNull()
  })

  it('prices one file at a cent', () => {
    expect(ANNOTATE_COST_CENTS).toBe(1)
  })
})

/**
 * P6-34: the evidence map. The same pair P5-61 put on a `SourceProposal` —
 * `inferred` paths plus an `evidence` map, the claim travelling with its
 * evidence — asked here of a document, because remediation APPLIES the topic
 * and an applied value has to be checkable without re-reading the file.
 */
/**
 * The cap, after a measured failure (P6-34).
 *
 * 600 was sized for the answer and not for the thinking block spent out of
 * the same budget. Measured on the real request: 2 of 4 runs at 600 came back
 * with no text at all and all four hit `max_tokens`; at 1,500, none did.
 */
describe('the output cap leaves room to answer', () => {
  it('reads an answer that is only a thinking block as unavailable, not as a filing', async () => {
    // What a cap too tight actually produces, and the shape that reached the
    // queue as "the model could not be asked".
    const thinkingOnly = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'thinking', thinking: '', signature: 'x' }],
          usage: { input_tokens: 2700, output_tokens: 600 },
          stop_reason: 'max_tokens',
        }),
      },
    } as unknown as AnthropicLike
    const outcome = await annotateEntry('drop-1', { client: thinkingOnly, entry: ENTRY, text: PAGES })
    expect(outcome).toBeTruthy()
    expect(isAnnotateError(outcome!)).toBe(true)
  })

  it('reads an answer cut off mid-JSON as unavailable rather than half a filing', async () => {
    const truncated = stubClient('{"title": "Why five million", "summary": "A line-item justif')
    const outcome = await annotateEntry('drop-1', { client: truncated, entry: ENTRY, text: PAGES })
    expect(isAnnotateError(outcome!)).toBe(true)
  })
})

describe('the evidence a claim travels with (P6-34)', () => {
  it('keeps a sentence for a field remediation can apply, and nothing else', () => {
    const annotation = parseAnnotation(
      JSON.stringify({
        topic: 'land',
        summary: 'A memo.',
        evidence: {
          topic: 'Black landowners held fifteen million acres in 1910.',
          // Not an inferred field: the derivation answers it, so a sentence
          // about it would be a claim over data the rows already hold.
          coverage: 'All fifty states.',
          organization: 'Published by USDA.',
        },
      }),
      'm',
      AT,
    )
    expect(annotation?.evidence).toEqual({ topic: 'Black landowners held fifteen million acres in 1910.' })
  })

  it('trims an over-long quote rather than losing it', () => {
    const long = 'a'.repeat(EVIDENCE_MAX_CHARS + 50)
    const annotation = parseAnnotation(JSON.stringify({ topic: 'land', evidence: { topic: long } }), 'm', AT)
    // A truncated quote still points at the paragraph.
    expect(annotation?.evidence?.topic).toHaveLength(EVIDENCE_MAX_CHARS)
  })

  it('leaves the field off entirely when there is no usable sentence', () => {
    expect(parseAnnotation(JSON.stringify({ topic: 'land', evidence: { topic: '   ' } }), 'm', AT)?.evidence).toBeUndefined()
    expect(parseAnnotation(JSON.stringify({ topic: 'land', evidence: 'a sentence' }), 'm', AT)?.evidence).toBeUndefined()
    expect(parseAnnotation(JSON.stringify({ topic: 'land', evidence: ['a sentence'] }), 'm', AT)?.evidence).toBeUndefined()
    expect(parseAnnotation(JSON.stringify({ topic: 'land' }), 'm', AT)?.evidence).toBeUndefined()
  })

  it('is never enough on its own to make an annotation', () => {
    // Evidence for nothing is not an answer.
    expect(parseAnnotation(JSON.stringify({ evidence: { topic: 'A sentence.' } }), 'm', AT)).toBeNull()
  })
})

describe('what the data answers (P7-7)', () => {
  const ANSWER = 'Answers: which parcels sit within N miles of a transmission line.'

  it('is parsed, and travels with its own evidence sentence', () => {
    const annotation = parseAnnotation(
      JSON.stringify({
        topic: 'land',
        whatItAnswers: ANSWER,
        evidence: {
          topic: 'Black landowners held fifteen million acres in 1910.',
          whatItAnswers: 'Each parcel record includes the distance to the nearest transmission corridor.',
        },
      }),
      'm',
      AT,
    )
    expect(annotation?.whatItAnswers).toBe(ANSWER)
    // `evidenceField` asks `INFERRED_FIELDS`, so the second applied field got
    // its evidence slot by being added to the table and nowhere else.
    expect(Object.keys(annotation?.evidence ?? {}).sort()).toEqual(['topic', 'whatItAnswers'])
  })

  it('drops a line longer than the cap rather than storing half a sentence', () => {
    // The title and the summary are dropped the same way, and for the reason:
    // the field rides on every `search_library` row, and half a claim is not a
    // claim anybody can check.
    const long = `Answers: ${'a'.repeat(WHAT_IT_ANSWERS_MAX_CHARS)}`
    expect(parseAnnotation(JSON.stringify({ topic: 'land', whatItAnswers: long }), 'm', AT)?.whatItAnswers).toBeUndefined()
    const fits = `Answers: ${'a'.repeat(WHAT_IT_ANSWERS_MAX_CHARS - 10)}`
    expect(parseAnnotation(JSON.stringify({ topic: 'land', whatItAnswers: fits }), 'm', AT)?.whatItAnswers).toBe(fits)
  })

  it('is enough on its own to be an answer worth keeping', () => {
    // A dataset whose page says what it holds and nothing a filing needs is
    // still worth the call: the one field this ticket is about survived.
    const annotation = parseAnnotation(JSON.stringify({ whatItAnswers: ANSWER }), 'm', AT)
    expect(annotation?.whatItAnswers).toBe(ANSWER)
  })

  it('restating the title is parsed exactly like any other answer', () => {
    // Deliberately no detection: that is a review problem, and the
    // verification queue is what keeps the field honest (§F.4d's caveat).
    const annotation = parseAnnotation(JSON.stringify({ title: 'Parcel boundaries', whatItAnswers: 'Parcel boundaries' }), 'm', AT)
    expect(annotation?.whatItAnswers).toBe('Parcel boundaries')
  })
})

/**
 * P7-10: two dates asked separately, in a grammar that can be checked.
 */
describe('when the data is from', () => {
  it('asks for the two dates as two different facts, and says which is which', () => {
    const user = buildAnnotateUserMessage({ file: 'a.pdf', text: 'words' })
    expect(user).toContain('- covers: the period the DATA describes')
    expect(user).toContain('- published: when the publisher released or last updated it')
    // The grammar, once, in both bullets — so the prompt and the parser cannot
    // describe two different shapes.
    expect(user.match(/"YYYY-MM-DD"/g)?.length).toBe(2)
    // A cadence must never come back as a date (`updateCadence` keeps its own
    // meaning: a promise is not a date).
    expect(user).toContain('"every five years" is a schedule, not a date')
    // And a date's evidence is where the source's own spelling lives.
    expect(user).toContain("the source's own spelling belongs")
  })

  it('keeps both dates, canonicalised, with the sentence each came from', () => {
    const annotation = parseAnnotation(
      JSON.stringify({
        covers: '2019–2023',
        published: 'March 12, 2024',
        evidence: {
          covers: 'American Community Survey 2019-2023 5-year estimates.',
          published: 'Last updated March 12, 2024.',
        },
      }),
      'm',
      AT,
    )
    expect(annotation?.covers).toBe('2019/2023')
    expect(annotation?.published).toBe('2024-03-12')
    expect(annotation?.evidence?.covers).toContain('5-year estimates')
    expect(annotation?.evidence?.published).toContain('Last updated')
  })

  it('refuses a cadence, a paraphrase and anything else that is not a date', () => {
    const refused = (value: string) => parseAnnotation(JSON.stringify({ topic: 'land', published: value, covers: value }), 'm', AT)
    for (const value of ['every five years', 'recent', 'annually', 'the 2020s', 'unknown']) {
      expect(refused(value)?.covers, value).toBeUndefined()
      expect(refused(value)?.published, value).toBeUndefined()
    }
  })

  it('refuses an interval that runs backwards rather than swapping it round', () => {
    expect(parseAnnotation(JSON.stringify({ topic: 'land', covers: '2023/2019' }), 'm', AT)?.covers).toBeUndefined()
  })

  it('is enough on its own to be an answer worth keeping', () => {
    // A page that says only when its data is from is still worth the call.
    const annotation = parseAnnotation(JSON.stringify({ covers: '2026-10' }), 'm', AT)
    expect(annotation?.covers).toBe('2026-10')
  })

  it('keeps an evidence sentence for a date, which the queue is going to show', () => {
    // `evidenceField` loops INFERRED_FIELDS, so the two new fields are
    // accepted by the one list rather than by a second rule here.
    const annotation = parseAnnotation(JSON.stringify({ covers: '2024', evidence: { covers: 'Data year: 2024.' } }), 'm', AT)
    expect(Object.keys(annotation?.evidence ?? {})).toEqual(['covers'])
  })
})
