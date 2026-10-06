import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * P6-34: remediation applies by default and flags what a model wrote.
 *
 * The manifest write is the one side effect, so it is the seam: `patch` is
 * captured, applied to a starting manifest, and asserted on. Everything else
 * — the derivation, the attention predicates — is already tested next door.
 */

/**
 * The manifest seam. `patchEntryManifest` hands the patch the manifest as it
 * is on disk and the row it belongs to, so the stub has to do the same — the
 * applied-fields list is built inside the patch, which is the whole point of
 * writing once rather than field by field.
 */
let patchStart: Record<string, unknown> = {}
let patchRow: unknown = null
let written: Array<Record<string, unknown> | null> = []
let patchFails = false

vi.mock('./entryManifest.js', () => ({
  patchEntryManifest: vi.fn(async (_slug: string, patch: (meta: Record<string, unknown>, entry: unknown) => Record<string, unknown> | null) => {
    const next = patch(patchStart, patchRow)
    written.push(next)
    return patchFails ? null : next
  }),
}))

vi.mock('./kbSearch.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./kbSearch.js')>()),
  clearKbIndex: vi.fn(),
}))

const searchCatalog = vi.fn()
vi.mock('./libraryCatalog.js', () => ({
  searchCatalog: (...args: unknown[]) => searchCatalog(...args),
  getCatalogEntry: vi.fn(async () => null),
  onReindex: vi.fn(),
}))

import type { CatalogEntryRow } from './libraryCatalog.js'
import type { Annotation } from './annotateEntry.js'
import {
  applyInferredFromInspection,
  applyInferredValues,
  inferredRemediationEnabled,
  ownWords,
  remediateBatchMax,
  remediateEntry,
  remediateLibrary,
  remediationSummary,
} from './remediate.js'
import { mechanismOf, unverifiedFields } from './provenance.js'

const AT = '2026-10-05T10:00:00.000Z'

const entry = (over: Partial<CatalogEntryRow> = {}): CatalogEntryRow =>
  ({
    slug: 'why-five-million-memo',
    kind: 'document',
    title: 'Why five million',
    category: '',
    status: 'published',
    tags: [],
    meta: {},
    files: [],
    bytes: 0,
    ...over,
  }) as CatalogEntryRow

const annotation = (over: Partial<Annotation> = {}): Annotation => ({
  at: AT,
  model: 'claude-x',
  topic: 'land',
  summary: 'A memo about five million acres.',
  evidence: { topic: 'Black landowners held fifteen million acres in 1910.' },
  ...over,
})

/** The manifest as the last write left it. */
function manifestAfter(): Record<string, unknown> {
  expect(written.at(-1), 'nothing was written').toBeTruthy()
  return written.at(-1) as Record<string, unknown>
}

/** What the patch will be shown: the manifest on disk, and the row. */
function onDisk(meta: Record<string, unknown>, row: CatalogEntryRow): CatalogEntryRow {
  patchStart = meta
  patchRow = row
  return row
}

beforeEach(() => {
  written = []
  patchStart = {}
  patchRow = entry()
  patchFails = false
  searchCatalog.mockReset()
})

afterEach(() => {
  delete process.env.LIBRARY_REMEDIATE
  delete process.env.LIBRARY_REMEDIATE_MAX
})

describe('one entry', () => {
  it('applies a model’s topic, records the evidence, and queues it', async () => {
    const row = entry()
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => annotation() })
    expect(result?.filled.map(f => [f.field, f.mechanism, f.written])).toEqual([['topic', 'model', true]])
    expect(result?.filled[0].evidence).toBe('Black landowners held fifteen million acres in 1910.')
    expect(result?.unfilled).not.toContain('topic')

    const meta = manifestAfter()
    expect(meta.category).toBe('land')
    expect(meta.provenance).toEqual({
      topic: { mechanism: 'model', at: AT, value: 'land', evidence: 'Black landowners held fifteen million acres in 1910.', via: 'category' },
    })
    // And the row that comes back out of that manifest is on the queue.
    const after = entry({ category: 'land', meta })
    expect(mechanismOf(after, 'topic')).toBe('model')
    expect(unverifiedFields(after)).toEqual(['topic'])
  })

  it('leaves the rest of the same answer a PROPOSAL (the P5-83 carve-out)', async () => {
    // A wrong topic is a bad filter; a wrong summary is a false statement in
    // the library's own voice. So the summary is suggested, not written.
    const row = entry()
    await remediateEntry(row.slug, { entry: row, annotate: async () => annotation() })
    const meta = manifestAfter()
    expect(meta.description).toBeUndefined()
    expect((meta.suggested as Annotation).summary).toBe('A memo about five million acres.')
  })

  it('never overwrites a value that is already there — derivation beats the model', async () => {
    // A document that already says what it is about: no gap, no model call,
    // nothing queued. The same rule protects a derived coverage and a
    // person's edit, because all three are "a value, and a value is not
    // missing".
    const row = entry({ category: 'housing' })
    const annotate = vi.fn(async () => annotation())
    const result = await remediateEntry(row.slug, { entry: row, annotate })
    expect(annotate).not.toHaveBeenCalled()
    expect(written).toHaveLength(0)
    expect(result?.filled.map(f => [f.field, f.mechanism])).toEqual([['topic', 'person']])
  })

  it('refuses to overwrite even when asked directly', async () => {
    // `applyInferredValues` is also called straight from the ingest job, where
    // the entry may have been filed between the read and the write.
    onDisk({ category: 'housing' }, entry({ category: 'housing' }))
    const applied = await applyInferredValues('x', annotation())
    expect(applied).toEqual([])
    const meta = manifestAfter()
    expect(meta.category).toBe('housing')
    expect(meta.provenance).toBeUndefined()
  })

  it('writes a topic as a tag when a purpose holds the category', async () => {
    const row = onDisk({ category: 'strategy' }, entry({ category: 'strategy' }))
    await remediateEntry(row.slug, { entry: row, annotate: async () => annotation() })
    const meta = manifestAfter()
    expect(meta.category).toBe('strategy')
    expect(meta.tags).toEqual(['land'])
    expect((meta.provenance as Record<string, Record<string, unknown>>).topic.via).toBe('tag')
  })

  it('still reports every derived value when the model is unavailable (P6-34)', async () => {
    const row = entry({
      kind: 'dataset',
      meta: { coverage: { scope: 'state', states: ['GA'], label: 'Georgia' }, shape: 'statistics', source: { provider: 'US EPA' } },
    })
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => ({ error: 'unavailable', at: AT, reason: 'no-key' }) })
    // The derived half ran at index time and its answers stand regardless.
    expect(result?.filled.map(f => [f.field, f.mechanism])).toEqual([
      ['organization', 'derived'],
      ['coverage', 'derived'],
      ['shape', 'derived'],
    ])
    expect(result?.note).toBe('the model could not be asked (no-key) — only the derived fields were filled')
    expect(written).toHaveLength(0)
  })

  it('says so when there was nothing readable to read', async () => {
    const row = entry()
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => null })
    expect(result?.note).toContain('nothing readable')
    expect(written).toHaveLength(0)
  })

  it('keeps only the derived half when the inferred half is switched off', async () => {
    // P6-34's own recorded fallback for the day the queue grows faster than it
    // drains: it costs nothing and is always correct.
    process.env.LIBRARY_REMEDIATE = '0'
    expect(inferredRemediationEnabled()).toBe(false)
    const row = entry()
    const annotate = vi.fn(async () => annotation())
    const result = await remediateEntry(row.slug, { entry: row, annotate })
    expect(annotate).not.toHaveBeenCalled()
    expect(result?.note).toContain('switched off')
    expect(result?.unfilled).toContain('topic')
  })

  it('survives an unreadable entry rather than stopping the run', async () => {
    const row = entry()
    const result = await remediateEntry(row.slug, {
      entry: row,
      annotate: async () => {
        throw new Error('the file is a scan')
      },
    })
    expect(result?.note).toContain('nothing readable')
  })

  it('says when the model read it and had nothing to say', async () => {
    const row = entry()
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => annotation({ topic: undefined }) })
    expect(result?.note).toContain('nothing to say')
    expect(result?.unfilled).toContain('topic')
  })
})

describe('the whole library', () => {
  it('reads the gap the server’s own predicate names, capped', async () => {
    searchCatalog.mockResolvedValue([
      entry({ slug: 'a' }),
      entry({ slug: 'b' }),
      // Already filed — not a candidate even though the search returned it.
      entry({ slug: 'c', category: 'land' }),
      // Archived rows are not work waiting on anybody (P6-23).
      entry({ slug: 'd', status: 'archived' }),
    ])
    const result = await remediateLibrary({ limit: 1, annotate: async () => annotation() })
    expect(searchCatalog).toHaveBeenCalledWith({ attention: 'uncategorised' })
    expect(result).toEqual({ entries: 1, applied: 1, stillEmpty: 0, notes: [], declined: [] })
  })

  it('caps a run and lets the cap be set', async () => {
    expect(remediateBatchMax()).toBe(25)
    process.env.LIBRARY_REMEDIATE_MAX = '3'
    expect(remediateBatchMax()).toBe(3)
    searchCatalog.mockResolvedValue([entry({ slug: 'a' }), entry({ slug: 'b' }), entry({ slug: 'c' }), entry({ slug: 'd' })])
    const result = await remediateLibrary({ annotate: async () => annotation() })
    expect(result.entries).toBe(3)
  })

  it('collects each honesty line once', async () => {
    searchCatalog.mockResolvedValue([entry({ slug: 'a' }), entry({ slug: 'b' })])
    const result = await remediateLibrary({ annotate: async () => ({ error: 'unavailable', at: AT, reason: 'refused' }) })
    expect(result.notes).toEqual(['the model could not be asked (refused) — only the derived fields were filled'])
    // Deduplicated for the log line; per entry for whoever has to diagnose it.
    expect(result.declined.map(d => d.slug)).toEqual(['a', 'b'])
    expect(result.applied).toBe(0)
    expect(result.stillEmpty).toBe(2)
  })

  it('answers an empty run rather than throwing when the catalog is down', async () => {
    searchCatalog.mockRejectedValue(new Error('no database'))
    expect(await remediateLibrary()).toEqual({ entries: 0, applied: 0, stillEmpty: 0, notes: [], declined: [] })
  })
})

/**
 * The zero run, found live.
 *
 * A reindex printed "0 value(s) applied across 7 entries — every one of them
 * is on the verification queue", which was false twice over: nothing had
 * joined the queue, and the `notes` that would have explained the zero were
 * collected and thrown away. A log line nobody can act on is worse than none,
 * because it reads like success.
 */
describe('saying what a run actually did', () => {
  it('never claims a queue gained rows when nothing was applied', () => {
    const line = remediationSummary({
      entries: 7,
      applied: 0,
      stillEmpty: 7,
      notes: ['the model answered with nothing we could use — only the derived fields were filled'],
      declined: [],
    })
    expect(line).toContain('read 7 entries and applied nothing')
    expect(line).toContain('the verification queue is unchanged')
    expect(line).toContain('7 still empty')
    // The one diagnostic that explains a zero has to be IN the line.
    expect(line).toContain('nothing we could use')
    expect(line).not.toContain('every one of them')
  })

  it('says what joined the queue when something did', () => {
    const line = remediationSummary({ entries: 7, applied: 5, stillEmpty: 2, notes: [], declined: [] })
    expect(line).toBe('remediation: applied 5 values across 7 entries — they are on the verification queue; 2 still empty')
  })

  it('reads in the singular, and says nothing at all about an empty run', () => {
    expect(remediationSummary({ entries: 1, applied: 1, stillEmpty: 0, notes: [], declined: [] })).toBe(
      'remediation: applied 1 value across 1 entry — it is on the verification queue',
    )
    expect(remediationSummary({ entries: 0, applied: 0, stillEmpty: 0, notes: [], declined: [] })).toBe('remediation: nothing to fill')
  })
})

describe('why a run declined, in words that distinguish', () => {
  it('tells "could not be asked" apart from "answered with nothing we could use"', async () => {
    // These two read identically before, which is exactly why a zero run was
    // illegible. The first is the assistant's own code; the second is almost
    // always the answer overrunning the token cap mid-JSON.
    const refused = await remediateEntry('x', { entry: entry(), annotate: async () => ({ error: 'unavailable', at: AT, reason: 'refused' }) })
    expect(refused?.note).toBe('the model could not be asked (refused) — only the derived fields were filled')
    const unusable = await remediateEntry('x', { entry: entry(), annotate: async () => ({ error: 'unavailable', at: AT }) })
    expect(unusable?.note).toBe('the model answered with nothing we could use — only the derived fields were filled')
  })
})

describe('a note is its body (found live)', () => {
  const note = (body: string) =>
    entry({ slug: 'for-william-idea', kind: 'note', status: 'open', meta: { body } })

  it('hands a note’s body over to be read, because it has no file to extract', async () => {
    // `firstPages` looks for an extractable FILE and a note has only its
    // meta.json, so every note came back "nothing readable" however much it
    // said — several hundred words of real content no model was ever shown.
    const seen: unknown[] = []
    const row = note('Beginning in 2027 we are planning a five-year, $5 million homesteading campus.')
    await remediateEntry(row.slug, {
      entry: row,
      annotate: async (_slug, entryArg) => {
        seen.push(entryArg)
        return annotation()
      },
    })
    const meta = manifestAfter()
    expect(meta.category).toBe('land')
    expect(seen).toHaveLength(1)
  })

  it('declines a note with an empty body rather than pretending', async () => {
    const result = await remediateEntry('blank', { entry: note('   '), annotate: async () => null })
    expect(result?.note).toContain('nothing readable')
    expect(written).toHaveLength(0)
  })
})

/**
 * P7-7: the capability line, through the same apply-then-verify path.
 *
 * Nothing here re-tests the discipline — that a model's value is queued, that
 * a person's beats it, that a re-run is idempotent — because the field joined
 * `INFERRED_FIELDS` rather than bringing its own rules. What is its own: which
 * door read it, what the model was shown, and what is NOT written back.
 */
describe('what a dataset answers (P7-7)', () => {
  const ANSWER = 'Answers: which parcels sit within N miles of a transmission line.'
  const EVIDENCE = 'Each parcel record includes the distance to the nearest transmission corridor.'

  /** A filed dataset: the only inferred gap it has is the answers line. */
  const dataset = (over: Partial<CatalogEntryRow> = {}) =>
    entry({ slug: 'parcels', kind: 'dataset', title: 'Parcels', category: 'land', ...over })

  const source = (meta: Record<string, unknown> = {}) =>
    entry({
      slug: 'airnow-air-quality',
      kind: 'source',
      title: 'AirNow air quality observations',
      category: 'environment',
      meta: {
        description: 'Current and forecast Air Quality Index for ozone and fine particulates.',
        source: {
          provider: 'US EPA',
          program: 'AirNow / AirNowAPI',
          geography: 'point',
          coverage: 'national',
          fields: [{ name: 'AQI', description: 'Air Quality Index value for that pollutant and hour' }],
        },
        ...meta,
      },
    })

  it('applies the line a model read, with its evidence, and queues it', async () => {
    const row = dataset()
    onDisk({ category: 'land' }, row)
    const result = await remediateEntry(row.slug, {
      entry: row,
      annotate: async () => annotation({ topic: undefined, whatItAnswers: ANSWER, evidence: { whatItAnswers: EVIDENCE } }),
    })
    expect(result?.filled.map(f => [f.field, f.mechanism, f.written])).toEqual([
      // Already filed by hand, reported rather than rewritten…
      ['topic', 'person', false],
      // …and the one gap, written by this run.
      ['whatItAnswers', 'model', true],
    ])

    const meta = manifestAfter()
    expect(meta.whatItAnswers).toBe(ANSWER)
    expect(meta.provenance).toEqual({
      whatItAnswers: { mechanism: 'model', at: AT, value: ANSWER, evidence: EVIDENCE, via: 'field' },
    })
    // The row that comes back out of that manifest is on the queue.
    const after = dataset({ meta })
    expect(mechanismOf(after, 'whatItAnswers')).toBe('model')
    expect(unverifiedFields(after)).toEqual(['whatItAnswers'])
  })

  it('never overwrites a line somebody wrote', async () => {
    // One guard, three rules: a person's words beat the model's, a re-run is
    // idempotent, and a filled field is no longer a gap so nothing is spent.
    // Every inferred field has to be filled for "nothing is spent" to be the
    // claim — P7-10's two dates are gaps on this row too, and a run that still
    // has one gap still pays for a call.
    const row = dataset({ meta: { whatItAnswers: 'Answers: who owns each parcel.', dates: { covers: '2024', published: '2024-03' } } })
    const annotate = vi.fn(async () => annotation({ whatItAnswers: ANSWER }))
    const result = await remediateEntry(row.slug, { entry: row, annotate })
    expect(annotate).not.toHaveBeenCalled()
    expect(written).toHaveLength(0)
    expect(result?.filled.find(f => f.field === 'whatItAnswers')?.mechanism).toBe('person')
  })

  it('is not asked of a document — its "what it answers" is its summary', async () => {
    const row = entry({ category: 'land' })
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => annotation({ whatItAnswers: ANSWER }) })
    // No gap at all on a document whose topic is filed, so nothing is written
    // and the model is never asked.
    expect(written).toHaveLength(0)
    expect(result?.unfilled).toEqual([])
  })

  describe('a source IS its block', () => {
    it('hands over the words the search index is built from', () => {
      // A registry source is a POINTER: forty of them hold no file, so
      // `firstPages` returns null for every one and the gap would have been
      // unfillable on forty entries — a queue that never drains. The material
      // was there the whole time.
      const pages = ownWords(source())
      expect(pages?.file).toContain('data source record')
      expect(pages?.text).toContain('AirNow air quality observations')
      expect(pages?.text).toContain('Current and forecast Air Quality Index')
      expect(pages?.text).toContain('Provider: US EPA — AirNow / AirNowAPI')
      expect(pages?.text).toContain('Fields: AQI (Air Quality Index value for that pollutant and hour)')
    })

    it('declines a source with no block rather than sending a bare title', () => {
      expect(ownWords(entry({ kind: 'source', meta: {} }))).toBeNull()
    })

    it('still hands a note its body, and reads nothing for a document', () => {
      expect(ownWords(entry({ kind: 'note', meta: { body: 'Several hundred words.' } }))?.text).toBe('Several hundred words.')
      // A document has a file, and `firstPages` is what reads it.
      expect(ownWords(entry({ kind: 'document' }))).toBeNull()
    })

    it('does not propose a source’s own filing back to it', async () => {
      // The model was shown the entry's own title, description and block, so a
      // "suggested title" would be its own title read back by a machine.
      const row = source()
      onDisk(row.meta, row)
      await remediateEntry(row.slug, { entry: row, annotate: async () => annotation({ whatItAnswers: ANSWER }) })
      const meta = manifestAfter()
      expect(meta.whatItAnswers).toBe(ANSWER)
      expect(meta.suggested).toBeUndefined()
    })
  })

  describe('the link door', () => {
    const inspection = (over: Record<string, unknown> = {}) =>
      ({
        kind: 'page',
        confidence: 'medium',
        url: 'https://example.gov/parcels',
        checkedAt: AT,
        prose: { whatItAnswers: ANSWER, topic: 'land', evidence: { whatItAnswers: EVIDENCE } },
        ...over,
      }) as any

    it('applies what the page-reading pass already read, with no model call', async () => {
      // The inspection pass had the PAGE. A remediation run later would have
      // only the manifest, so re-asking would spend a call to learn less.
      onDisk({}, entry({ slug: 'dropped', kind: 'source', category: 'land' }))
      const applied = await applyInferredFromInspection('dropped', inspection())
      expect(applied?.map(f => [f.field, f.mechanism, f.evidence])).toEqual([['whatItAnswers', 'model', EVIDENCE]])
      const meta = manifestAfter()
      expect(meta.whatItAnswers).toBe(ANSWER)
      expect((meta.provenance as Record<string, Record<string, unknown>>).whatItAnswers.at).toBe(AT)
    })

    it('applies the answers line and NOT the topic', async () => {
      // `prose.topic` rides to the proposal as the form's category and a
      // person accepts it there. Applying it here would quietly change what
      // P6-34 decided for links.
      onDisk({}, entry({ slug: 'dropped', kind: 'source', category: '' }))
      await applyInferredFromInspection('dropped', inspection())
      const meta = manifestAfter()
      expect(meta.category).toBeUndefined()
      expect(Object.keys(meta.provenance as Record<string, unknown>)).toEqual(['whatItAnswers'])
    })

    it('spends nothing when the stored inspection already answers', async () => {
      // The reading a dropped LINK got at inspection time: it was `incoming`
      // then, a kind this field is never asked of, so the sentence waited on
      // the manifest. The moment the entry is a source, remediation applies it
      // for free rather than paying a model to re-read the manifest.
      const row = entry({
        slug: 'dropped',
        kind: 'source',
        category: 'land',
        meta: { inspection: inspection(), source: { provider: 'US EPA' }, dates: { covers: '2024', published: '2024-03' } },
      })
      onDisk(row.meta, row)
      const annotate = vi.fn(async () => annotation())
      const result = await remediateEntry(row.slug, { entry: row, annotate })
      expect(annotate).not.toHaveBeenCalled()
      expect(result?.filled.map(f => [f.field, f.mechanism, f.written])).toContainEqual(['whatItAnswers', 'model', true])
      expect(result?.unfilled).toEqual([])
      expect(manifestAfter().whatItAnswers).toBe(ANSWER)
    })

    it('writes nothing when the page said nothing that is an answer', async () => {
      expect(await applyInferredFromInspection('dropped', inspection({ prose: { provider: 'US EPA' } }))).toEqual([])
      expect(await applyInferredFromInspection('dropped', inspection({ prose: undefined }))).toEqual([])
      expect(written).toHaveLength(0)
    })
  })

  it('asks every inferred field’s own queue, not just the topic’s', async () => {
    // A pass that still asked only `uncategorised` would never visit the forty
    // sources missing an answers line. The queues come from the field table, so
    // the next inferred field is found by adding its rule and nothing else.
    searchCatalog.mockImplementation(async (args: { attention?: string }) =>
      args.attention === 'uncategorised' ? [entry({ slug: 'no-topic' })] : [dataset({ slug: 'no-answer' })],
    )
    const seen: string[] = []
    const result = await remediateLibrary({
      annotate: async slug => {
        seen.push(slug)
        return annotation({ whatItAnswers: ANSWER })
      },
    })
    expect(searchCatalog).toHaveBeenCalledWith({ attention: 'uncategorised' })
    expect(searchCatalog).toHaveBeenCalledWith({ attention: 'no-answers-line' })
    expect(seen).toEqual(['no-topic', 'no-answer'])
    expect(result.entries).toBe(2)
  })

  it('reads an entry on two queues once', async () => {
    // A dataset with neither a topic nor an answers line is one entry of work,
    // not two — the same distinct-entry rule P6-33's row is built on.
    const row = entry({ slug: 'both', kind: 'dataset' })
    onDisk({}, row)
    searchCatalog.mockResolvedValue([row])
    const result = await remediateLibrary({ annotate: async () => annotation({ whatItAnswers: ANSWER }) })
    expect(result.entries).toBe(1)
    expect(result.applied).toBe(2)
  })
})

/**
 * P7-10: when a dataset is from.
 *
 * The one ticket so far whose field both DERIVES and INFERS, which is what
 * P6-34's ordered `mechanisms` array was built for — so most of what is
 * asserted here is which of the two answered, and whether it queued.
 */
describe('when the data is from (P7-10)', () => {
  const dataset = (over: Partial<CatalogEntryRow> = {}) =>
    entry({ slug: 'parcels', kind: 'dataset', title: 'Parcels', category: 'land', ...over })

  const dated = (over: Partial<Annotation> = {}) =>
    annotation({
      topic: 'land',
      covers: '2019/2023',
      published: '2024-03',
      evidence: {
        covers: 'American Community Survey 2019-2023 5-year estimates.',
        published: 'Last updated March 2024.',
      },
      ...over,
    })

  it('applies both dates in the one block, each with its own evidence, and queues both', async () => {
    const row = dataset({ meta: { whatItAnswers: 'Answers: who owns each parcel.' } })
    onDisk(row.meta, row)
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => dated() })
    expect(result?.filled.map(f => [f.field, f.mechanism, f.written])).toContainEqual(['covers', 'model', true])
    expect(result?.filled.map(f => [f.field, f.mechanism, f.written])).toContainEqual(['published', 'model', true])

    const meta = manifestAfter()
    // ONE block, not three loose keys.
    expect(meta.dates).toEqual({ covers: '2019/2023', published: '2024-03' })
    const provenance = meta.provenance as Record<string, { mechanism: string; evidence?: string }>
    expect(provenance.covers.mechanism).toBe('model')
    expect(provenance.covers.evidence).toContain('5-year estimates')
    expect(provenance.published.evidence).toContain('Last updated')

    // And the row that comes back out of that manifest is on the queue for both.
    const after = dataset({ meta })
    expect(unverifiedFields(after)).toEqual(['covers', 'published'])
  })

  it('never asks the model for a covers the data itself already declares', async () => {
    // The layer block's year is a derivation, so `covers` is not a gap — the
    // ordered mechanism list means derivation wins and the model is only asked
    // about `published`. This is the first field in the table where the two
    // mechanisms actually meet.
    const row = dataset({ meta: { whatItAnswers: 'Answers: who owns each parcel.', layer: { name: 'Parcels', year: 2024 } } })
    onDisk(row.meta, row)
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => dated() })
    expect(result?.filled.find(f => f.field === 'covers')).toEqual({ field: 'covers', value: '2024', mechanism: 'derived', written: false })
    expect((manifestAfter().dates as Record<string, string>).covers).toBeUndefined()
    expect((manifestAfter().provenance as Record<string, unknown>).covers).toBeUndefined()
    // …and the model's answer for the other date still applied.
    expect((manifestAfter().dates as Record<string, string>).published).toBe('2024-03')
  })

  it('never overwrites a date somebody wrote', async () => {
    const row = dataset({ meta: { whatItAnswers: 'Answers: who owns each parcel.', dates: { covers: '2010', published: '2011-06' } } })
    onDisk(row.meta, row)
    const result = await remediateEntry(row.slug, { entry: row, annotate: async () => dated() })
    expect(result?.filled.find(f => f.field === 'covers')?.written).toBe(false)
    expect(result?.filled.find(f => f.field === 'published')?.mechanism).toBe('person')
    expect(written).toHaveLength(0)
  })

  it('reports `fetched` as derived and never queues it, with no model call for it', async () => {
    const row = dataset({
      meta: {
        whatItAnswers: 'Answers: who owns each parcel.',
        dates: { covers: '2024', published: '2024-03' },
        lineage: { from: 'https://example.gov/x', fetchedAt: '2026-09-29T23:22:13.610Z' },
      },
    })
    onDisk(row.meta, row)
    const annotate = vi.fn(async () => dated())
    const result = await remediateEntry(row.slug, { entry: row, annotate })
    // Nothing left to infer on this entry, so nothing was asked.
    expect(annotate).not.toHaveBeenCalled()
    expect(result?.filled.find(f => f.field === 'fetched')).toEqual({
      field: 'fetched',
      value: '2026-09-29',
      mechanism: 'derived',
      written: false,
    })
    expect(unverifiedFields(row)).toEqual([])
  })

  it('is not asked of a wiki page or a note', async () => {
    const page = entry({ slug: 'homestead', kind: 'wiki', category: 'land' })
    const result = await remediateEntry(page.slug, { entry: page, annotate: async () => dated() })
    expect(result?.unfilled).not.toContain('covers')
    expect(result?.unfilled).not.toContain('published')
  })

  it('applies a date read off the PAGE for free, which is the cheapest door it has', async () => {
    // The inspection pass had the portal page, where "Last updated: March 12,
    // 2024" actually appears. A remediation run later would have only the
    // manifest, so re-asking would spend a call to learn less.
    const row = entry({ slug: 'dropped', kind: 'source', category: 'land' })
    onDisk({}, row)
    const applied = await applyInferredFromInspection('dropped', {
      kind: 'page',
      confidence: 'medium',
      url: 'https://example.gov/parcels',
      checkedAt: AT,
      prose: {
        covers: '2026-10',
        published: '2024-03-12',
        evidence: { published: 'Last updated March 12, 2024.' },
      },
    } as never)
    expect(applied?.map(f => f.field)).toEqual(['covers', 'published'])
    expect(manifestAfter().dates).toEqual({ covers: '2026-10', published: '2024-03-12' })
    const provenance = manifestAfter().provenance as Record<string, { evidence?: string }>
    expect(provenance.published.evidence).toBe('Last updated March 12, 2024.')
  })

  it('finds the two date queues by their own keys off the field table', async () => {
    // P7-7 had to fix `remediateLibrary`, which asked ONE hardcoded queue;
    // it now asks one query per inferred field's own `missingKey`, so this
    // ticket is a table row and nothing else.
    searchCatalog.mockResolvedValue([])
    process.env.LIBRARY_REMEDIATE = '0'
    await remediateLibrary()
    const asked = searchCatalog.mock.calls.map(call => (call[0] as { attention?: string }).attention)
    expect(asked).toContain('no-period-covered')
    expect(asked).toContain('no-published-date')
    expect(asked).toContain('no-answers-line')
    expect(asked).toContain('uncategorised')
  })
})
