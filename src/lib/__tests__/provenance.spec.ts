import { describe, it, expect } from 'vitest'
import {
  FIELD_RULES,
  INFERRED_FIELDS,
  REMEDIABLE_FIELDS,
  fieldLabel,
  fieldValueOf,
  hasUnverifiedValue,
  isUnverified,
  mechanismLabel,
  mechanismOf,
  provenanceOf,
  unverifiedFieldsOf,
} from '../provenance'
import type { CatalogEntry } from '../libraryCatalog'

/**
 * P6-34: derived vs inferred is the whole ticket. The server half of this is
 * `server/src/services/provenance.test.ts`, which also fails when the two
 * field tables drift.
 */

const e = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  slug: 'x',
  kind: 'dataset',
  title: 'X',
  category: '',
  status: 'published',
  tags: [],
  meta: {},
  files: [],
  bytes: 0,
  ...over,
})

describe('the field table', () => {
  it('names the nine fields and lets a model fill the four that are read out of prose', () => {
    expect(REMEDIABLE_FIELDS).toEqual([
      'topic',
      'organization',
      'coverage',
      'shape',
      'summary',
      'whatItAnswers',
      'covers',
      'published',
      'fetched',
    ])
    // `summary` carries no mechanism on purpose: P5-83's propose-then-accept
    // stands until Nick decides otherwise (recorded as an open question in
    // P6-34), so remediation must not write it.
    // P7-7's `whatItAnswers` is the second INFERRED field: a model's reading of
    // prose, applied by default and queued, exactly as the topic is.
    // P7-10 adds the two dates a publisher STATES. `fetched` is ours, so it
    // is derived and is not on this list.
    expect(INFERRED_FIELDS).toEqual(['topic', 'whatItAnswers', 'covers', 'published'])
    expect(fieldLabel('covers')).toBe('Period covered')
    expect(fieldLabel('published')).toBe('Published')
    expect(FIELD_RULES.find(r => r.field === 'covers')?.mechanisms).toEqual(['derived', 'model'])
    expect(FIELD_RULES.find(r => r.field === 'fetched')?.mechanisms).toEqual(['derived'])
    // Most of the library was never fetched from anywhere, so a gap row for
    // "no record of fetching this" would never drain.
    expect(FIELD_RULES.find(r => r.field === 'fetched')?.missingKey).toBeNull()
    expect(FIELD_RULES.find(r => r.field === 'whatItAnswers')?.missingKey).toBe('no-answers-line')
    expect(fieldLabel('whatItAnswers')).toBe('Answers')
    expect(FIELD_RULES.find(r => r.field === 'summary')?.mechanisms).toEqual([])
    // `shape` can never be missing — `records` is the floor — so it has no
    // attention key, and nothing can ask a person to fill it.
    expect(FIELD_RULES.find(r => r.field === 'shape')?.missingKey).toBeNull()
    expect(fieldLabel('coverage')).toBe('Coverage')
    expect(fieldLabel('nonsense')).toBe('nonsense')
  })

  it('says each mechanism in plain words', () => {
    expect(mechanismLabel('derived')).toBe('worked out from the data')
    expect(mechanismLabel('model')).toBe('read by the model')
    expect(mechanismLabel('person')).toBe('written by a person')
  })
})

describe('how a value got there', () => {
  it('reads a derived value as derived and never queues it', () => {
    const placed = e({ coverage: { scope: 'state', states: ['GA'], label: 'Georgia' }, organization: 'epa', shape: 'statistics' })
    expect(fieldValueOf(placed, 'coverage')).toBe('Georgia')
    expect(mechanismOf(placed, 'coverage')).toBe('derived')
    expect(mechanismOf(placed, 'organization')).toBe('derived')
    expect(mechanismOf(placed, 'shape')).toBe('derived')
    expect(hasUnverifiedValue(placed)).toBe(false)
  })

  it('reads the library as it stands today — nothing queued, nothing backfilled', () => {
    const curated = e({ kind: 'document', category: 'land', meta: { description: 'A memo.' } })
    expect(mechanismOf(curated, 'topic')).toBe('person')
    expect(mechanismOf(curated, 'summary')).toBe('person')
    expect(unverifiedFieldsOf(curated)).toEqual([])
  })

  it('reads a model value as unverified, with its evidence, until somebody looks', () => {
    const record = { mechanism: 'model', at: 'T', value: 'land', evidence: 'Fifteen million acres in 1910.' }
    const guessed = e({ kind: 'document', category: 'land', meta: { provenance: { topic: record } } })
    expect(mechanismOf(guessed, 'topic')).toBe('model')
    expect(isUnverified(guessed, 'topic')).toBe(true)
    expect(unverifiedFieldsOf(guessed)).toEqual(['topic'])
    expect(provenanceOf(guessed, 'topic')?.evidence).toBe('Fifteen million acres in 1910.')

    // Keep: the words stay the model's, the vouching is a person's, and the
    // field leaves the queue permanently.
    const kept = e({ kind: 'document', category: 'land', meta: { provenance: { topic: { ...record, verifiedAt: 'T2', verifiedBy: 'nick' } } } })
    expect(mechanismOf(kept, 'topic')).toBe('model')
    expect(isUnverified(kept, 'topic')).toBe(false)
  })

  it('stops believing a record once the value has moved under it', () => {
    // The claim travels with its evidence AND with its value (P5-61): a record
    // written about `land` says nothing about `housing`.
    const moved = e({ kind: 'document', category: 'housing', meta: { provenance: { topic: { mechanism: 'model', value: 'land' } } } })
    expect(mechanismOf(moved, 'topic')).toBe('person')
    expect(isUnverified(moved, 'topic')).toBe(false)
  })

  it('explains nothing about a field with no value', () => {
    expect(mechanismOf(e(), 'topic')).toBeNull()
    expect(provenanceOf(e(), 'coverage')).toBeNull()
    expect(isUnverified(e(), 'coverage')).toBe(false)
  })

  it('ignores a provenance block that is not one', () => {
    expect(mechanismOf(e({ kind: 'document', category: 'land', meta: { provenance: 'yes' } }), 'topic')).toBe('person')
    expect(mechanismOf(e({ kind: 'document', category: 'land', meta: { provenance: { topic: { mechanism: 'vibes' } } } }), 'topic')).toBe('person')
  })
})

/**
 * P7-10. The client half reads the dates off the row's own promoted block —
 * the server folds the manifest, the layer block and our fetch records into
 * one place, so this side has one thing to look at.
 */
describe('when a dataset is from', () => {
  it('reads each of the three off the block', () => {
    const entry = e({ dates: { covers: '2019/2023', published: '2024-03', fetched: '2026-10-05' } })
    expect(fieldValueOf(entry, 'covers')).toBe('2019/2023')
    expect(fieldValueOf(entry, 'published')).toBe('2024-03')
    expect(fieldValueOf(entry, 'fetched')).toBe('2026-10-05')
  })

  it('normalises on the way out, so a hand-edited manifest still reads', () => {
    expect(fieldValueOf(e({ dates: { covers: '2019-2023' } }), 'covers')).toBe('2019/2023')
    expect(fieldValueOf(e({ dates: { covers: 'whenever' } }), 'covers')).toBe('')
  })

  it('reads an untagged dataset as empty, which is not a defect', () => {
    expect(fieldValueOf(e(), 'covers')).toBe('')
    expect(unverifiedFieldsOf(e())).toEqual([])
    expect(hasUnverifiedValue(e())).toBe(false)
  })

  it('reads a derived covers as derived and never queues it', () => {
    const entry = e({ dates: { covers: '2024' } })
    expect(mechanismOf(entry, 'covers')).toBe('derived')
    expect(isUnverified(entry, 'covers')).toBe(false)
  })

  it('reads a model-read covers as unverified — the same field, the other mechanism', () => {
    const entry = e({
      dates: { covers: '2019/2023' },
      meta: { provenance: { covers: { mechanism: 'model', value: '2019/2023', evidence: 'ACS 2019-2023 5-year estimates.' } } },
    })
    expect(mechanismOf(entry, 'covers')).toBe('model')
    expect(isUnverified(entry, 'covers')).toBe(true)
    expect(unverifiedFieldsOf(entry)).toEqual(['covers'])
  })

  it('never queues `fetched`, whatever is on the row', () => {
    const entry = e({ dates: { fetched: '2026-10-05' } })
    expect(mechanismOf(entry, 'fetched')).toBe('derived')
    expect(isUnverified(entry, 'fetched')).toBe(false)
  })

  it('never reads `updatedAt` as a date about the data', () => {
    // Re-pushing a 2019 file moves `updatedAt` to today. Nothing here looks at
    // it, which is the point.
    expect(fieldValueOf(e({ updatedAt: '2026-10-06T00:00:00.000Z' }), 'fetched')).toBe('')
  })
})
