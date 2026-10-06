import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FIELD_RULES,
  INFERRED_FIELDS,
  MECHANISMS,
  REMEDIABLE_FIELDS,
  fieldAppliesTo,
  fieldValueOf,
  hasUnverifiedValue,
  isUnverified,
  mechanismOf,
  provenanceOf,
  provenanceReport,
  unverifiedFields,
  withFieldValue,
  withProvenance,
  withVerification,
  withoutFieldValue,
  withoutProvenance,
  type ProvenanceRow,
} from './provenance.js'

/**
 * P6-34: derived vs inferred is the whole ticket, so most of what is asserted
 * here is which of the two a value reads as — and that a library nothing has
 * remediated reads as neither `model` nor empty-but-queued.
 */

const row = (over: Partial<ProvenanceRow> = {}): ProvenanceRow => ({
  kind: 'dataset',
  slug: 'x',
  category: '',
  tags: [],
  meta: {},
  files: [],
  ...over,
})

describe('the vocabulary', () => {
  it('is the same six fields, in the same order, as the client half', () => {
    // The server cannot read the client's TypeScript, so the table is written
    // twice. This fails when the two drift — the contract
    // `taxonomy.generated.json` has, done with a read rather than an export
    // because the table is five lines and a build step would be the heavier
    // half of the deal.
    const here = dirname(fileURLToPath(import.meta.url))
    const client = readFileSync(join(here, '../../../src/lib/provenance.ts'), 'utf8')
    for (const rule of FIELD_RULES) {
      const line = new RegExp(`\\{ field: '${rule.field}',[^\\n]*\\}`).exec(client)?.[0]
      expect(line, `src/lib/provenance.ts has no rule for "${rule.field}"`).toBeTruthy()
      expect(line).toContain(`label: '${rule.label}'`)
      expect(line).toContain(`mechanisms: [${rule.mechanisms.map(m => `'${m}'`).join(', ')}]`)
      expect(line).toContain(rule.missingKey ? `missingKey: '${rule.missingKey}'` : 'missingKey: null')
    }
    // And no field exists on one side only. The character class is not
    // `[a-z]+`: `whatItAnswers` (P7-7) is the first field whose name is
    // camelCase, and a regex that could not see it would have let the two
    // tables drift by exactly the field this check exists for.
    const clientFields = [...client.matchAll(/\{ field: '([a-zA-Z]+)',/g)].map(m => m[1])
    expect(clientFields).toEqual([...REMEDIABLE_FIELDS])
    expect(MECHANISMS).toEqual(['derived', 'model', 'person'])
  })

  it('lets only a model-filled field enter the queue', () => {
    // `summary` carries no mechanism on purpose: P5-83's propose-then-accept
    // stands until Nick decides otherwise, so remediation must not write it.
    // P7-7 adds the second inferred field: a model's reading of prose, applied
    // by default and queued, exactly as the topic is. P7-10 adds the two
    // dates a publisher STATES — and not `fetched`, which we work out
    // ourselves.
    expect(INFERRED_FIELDS).toEqual(['topic', 'whatItAnswers', 'covers', 'published'])
  })

  it('asks the dates only of a dataset, a source or a layer', () => {
    // A wiki page and a note have an edit history already (P7-10's own
    // out-of-scope line), and asking them would put a row on the queue nobody
    // could ever clear.
    for (const field of ['covers', 'published', 'fetched'] as const) {
      expect(fieldAppliesTo('dataset', field)).toBe(true)
      expect(fieldAppliesTo('source', field)).toBe(true)
      expect(fieldAppliesTo('page', field)).toBe(false)
      expect(fieldAppliesTo('note', field)).toBe(false)
    }
  })
})

/**
 * P7-10: the two dates and the one that is about us. The derive/infer
 * discipline is the whole ticket, and `covers` is the first field in the table
 * to carry BOTH mechanisms — so the same field never queues when derivation
 * answered and always queues when the model did.
 */
describe('when a dataset is from', () => {
  const dated = (dates: Record<string, string>, over: Partial<ProvenanceRow> = {}) =>
    row({ meta: { dates }, ...over })

  it('reads the three dates off the manifest block', () => {
    const entry = dated({ covers: '2019/2023', published: '2024-03', fetched: '2026-10-05' })
    expect(fieldValueOf(entry, 'covers')).toBe('2019/2023')
    expect(fieldValueOf(entry, 'published')).toBe('2024-03')
    expect(fieldValueOf(entry, 'fetched')).toBe('2026-10-05')
  })

  it('reads an untagged dataset as empty on all three, and breaks nothing', () => {
    expect(fieldValueOf(row(), 'covers')).toBe('')
    expect(fieldValueOf(row(), 'published')).toBe('')
    expect(fieldValueOf(row(), 'fetched')).toBe('')
    expect(unverifiedFields(row())).toEqual([])
    expect(hasUnverifiedValue(row())).toBe(false)
  })

  it('never queues a DERIVED covers, however it was derived', () => {
    // The layer block's year, and the year column a reindex stored. Both are
    // re-derived as often as anybody likes, so a person "verifying" one adds
    // nothing a re-run would not.
    const fromLayer = row({ meta: { layer: { name: 'Sites', year: 2024 } } })
    expect(fieldValueOf(fromLayer, 'covers')).toBe('2024')
    expect(mechanismOf(fromLayer, 'covers')).toBe('derived')
    expect(isUnverified(fromLayer, 'covers')).toBe(false)
    expect(mechanismOf(dated({ covers: '2021/2023' }), 'covers')).toBe('derived')
  })

  it('always queues a MODEL-read covers — the same field, the other mechanism', () => {
    const entry = dated({ covers: '2019/2023' }, {
      meta: {
        dates: { covers: '2019/2023' },
        provenance: { covers: { mechanism: 'model', value: '2019/2023', evidence: '2019-2023 5-year estimates.' } },
      },
    })
    expect(mechanismOf(entry, 'covers')).toBe('model')
    expect(isUnverified(entry, 'covers')).toBe(true)
    expect(unverifiedFields(entry)).toEqual(['covers'])
    expect(provenanceOf(entry, 'covers')?.evidence).toBe('2019-2023 5-year estimates.')
  })

  it('always queues a model-read published, which nothing can derive', () => {
    const entry = row({
      meta: { dates: { published: '2024-03' }, provenance: { published: { mechanism: 'model', value: '2024-03' } } },
    })
    expect(isUnverified(entry, 'published')).toBe(true)
  })

  it('never queues `fetched`, because we wrote it', () => {
    const entry = row({ meta: { lineage: { from: 'x', fetchedAt: '2026-09-29T23:22:13.610Z' } } })
    expect(fieldValueOf(entry, 'fetched')).toBe('2026-09-29')
    expect(mechanismOf(entry, 'fetched')).toBe('derived')
    expect(isUnverified(entry, 'fetched')).toBe(false)
    expect(hasUnverifiedValue(entry)).toBe(false)
  })

  it('reads a hand-written published as a person’s, so it never queues either', () => {
    // Nothing derives a release date, so step 3 of `mechanismOf` applies: the
    // only other way one gets onto an entry is that somebody wrote it.
    expect(mechanismOf(dated({ published: '2024-03' }), 'published')).toBe('person')
    expect(isUnverified(dated({ published: '2024-03' }), 'published')).toBe(false)
  })

  it('writes a date into the one block, normalising what it was given', () => {
    const written = withFieldValue({ title: 'X' }, 'covers', '2019–2023')
    expect(written.meta.dates).toEqual({ covers: '2019/2023' })
    expect(written.via).toBe('field')
    const second = withFieldValue(written.meta, 'published', 'March 2024')
    expect(second.meta.dates).toEqual({ covers: '2019/2023', published: '2024-03' })
  })

  it('takes one date back out and leaves the others alone', () => {
    const meta = { dates: { covers: '2019/2023', published: '2024-03' } }
    expect(withoutFieldValue(meta, 'published').dates).toEqual({ covers: '2019/2023' })
  })

  it('drops the block entirely when the last date goes', () => {
    const meta = { title: 'X', dates: { covers: '2019/2023' } }
    expect(withoutFieldValue(meta, 'covers')).toEqual({ title: 'X' })
  })

  it('reports both dates in the outward provenance record', () => {
    const entry = row({
      meta: {
        dates: { covers: '2019/2023', published: '2024-03' },
        provenance: { published: { mechanism: 'model', value: '2024-03' } },
      },
    })
    const report = provenanceReport(entry)
    expect(report.covers.mechanism).toBe('derived')
    expect(report.published.mechanism).toBe('model')
  })
})

describe('reading how a value got there', () => {
  it('reports nothing for a field with no value', () => {
    expect(mechanismOf(row(), 'topic')).toBeNull()
    expect(provenanceOf(row(), 'topic')).toBeNull()
    expect(isUnverified(row(), 'topic')).toBe(false)
  })

  it('reads a derived value as derived, and never queues it (P6-34)', () => {
    // A dataset whose table placed it: coverage is the derived exemplar, and
    // nothing about it needs a person — it is re-derived at every reindex.
    const placed = row({ meta: { coverage: { scope: 'state', states: ['GA'], label: 'Georgia' } } })
    expect(mechanismOf(placed, 'coverage')).toBe('derived')
    expect(isUnverified(placed, 'coverage')).toBe(false)
    expect(hasUnverifiedValue(placed)).toBe(false)
    // Same for a publisher folded out of the provider string.
    const published = row({ meta: { source: { provider: 'US EPA (decommissioned)' } } })
    expect(fieldValueOf(published, 'organization')).toBe('epa')
    expect(mechanismOf(published, 'organization')).toBe('derived')
    expect(isUnverified(published, 'organization')).toBe(false)
  })

  it('reads an unremediated library as nobody-queued, with nothing backfilled', () => {
    // The real library the day this lands: hand-written categories, derived
    // coverage, no provenance block anywhere. Nothing may read as `model`.
    const real = row({ kind: 'document', category: 'land', tags: ['landowners'] })
    expect(mechanismOf(real, 'topic')).toBe('person')
    expect(unverifiedFields(real)).toEqual([])
  })

  it('reads a model-filled field as unverified until somebody looks (P6-34)', () => {
    const filled = row({
      kind: 'document',
      category: 'land',
      meta: {
        provenance: {
          topic: { mechanism: 'model', at: 'T', value: 'land', evidence: 'Heirs property in the Black Belt, 2024.' },
        },
      },
    })
    expect(mechanismOf(filled, 'topic')).toBe('model')
    expect(isUnverified(filled, 'topic')).toBe(true)
    expect(unverifiedFields(filled)).toEqual(['topic'])
    expect(provenanceOf(filled, 'topic')?.evidence).toBe('Heirs property in the Black Belt, 2024.')
  })

  it('stops believing a record once the value has moved under it', () => {
    // The claim travels WITH its value (P5-61). A record that was written
    // about `land` says nothing about `housing`, so the field reads as
    // whatever it is now rather than inheriting a stale mechanism.
    const moved = row({
      kind: 'document',
      category: 'housing',
      meta: { provenance: { topic: { mechanism: 'model', at: 'T', value: 'land' } } },
    })
    expect(mechanismOf(moved, 'topic')).toBe('person')
    expect(isUnverified(moved, 'topic')).toBe(false)
  })

  it('drops a record that is not one', () => {
    const junk = row({ kind: 'document', category: 'land', meta: { provenance: { topic: { mechanism: 'vibes' } } } })
    expect(mechanismOf(junk, 'topic')).toBe('person')
    const alsoJunk = row({ kind: 'document', category: 'land', meta: { provenance: 'yes' } })
    expect(mechanismOf(alsoJunk, 'topic')).toBe('person')
  })

  it('reports every field that has a value, for a surface that carries a claim outward', () => {
    const entry = row({
      kind: 'dataset',
      category: 'land',
      meta: {
        description: 'Twenty large private landowners with acreage.',
        coverage: { scope: 'national', states: [], label: 'National' },
        // Written by `applyShapeAndCoverage` at index time, as on every row.
        shape: 'records',
        provenance: { topic: { mechanism: 'model', at: 'T', value: 'land' } },
      },
    })
    const report = provenanceReport(entry)
    expect(report.topic.mechanism).toBe('model')
    expect(report.coverage.mechanism).toBe('derived')
    expect(report.summary.mechanism).toBe('person')
    // `shape` always answers (`records` is the floor), `organization` does not.
    expect(report.shape.mechanism).toBe('derived')
    expect(report.organization).toBeUndefined()
  })
})

describe('writing a record', () => {
  it('never stores a derived record — it is a cache of a pure function', () => {
    const meta = withProvenance({ title: 'x' }, 'coverage', { mechanism: 'derived', at: 'T' })
    expect(meta.provenance).toBeUndefined()
  })

  it('keeps a person’s record and removes it cleanly', () => {
    const written = withProvenance({ title: 'x' }, 'topic', { mechanism: 'person', at: 'T', value: 'land' })
    expect(written.provenance).toEqual({ topic: { mechanism: 'person', at: 'T', value: 'land' } })
    // The last record out takes the block with it, rather than leaving `{}`.
    expect(withoutProvenance(written, 'topic')).toEqual({ title: 'x' })
  })

  it('records a Keep as the model’s words and a person’s vouching', () => {
    const written = withProvenance({}, 'topic', { mechanism: 'model', at: 'T', value: 'land', evidence: 'A sentence.' })
    const kept = withVerification(written, 'topic', 'nick', 'T2')
    const record = (kept.provenance as Record<string, Record<string, unknown>>).topic
    // NOT rewritten to `person`: that would claim somebody wrote what a model
    // wrote. The evidence survives, and the field leaves the queue.
    expect(record.mechanism).toBe('model')
    expect(record.evidence).toBe('A sentence.')
    expect(record.verifiedAt).toBe('T2')
    expect(record.verifiedBy).toBe('nick')
    expect(isUnverified(row({ kind: 'document', category: 'land', meta: kept }), 'topic')).toBe(false)
  })
})

describe('writing and clearing a value', () => {
  it('writes a topic onto the category when nothing is there', () => {
    const { meta, via } = withFieldValue({}, 'topic', 'land')
    expect(meta).toEqual({ category: 'land' })
    expect(via).toBe('category')
  })

  it('writes a topic as a TAG when a purpose already holds the category', () => {
    // A topic is not a stored field — it is the category when that is a topic,
    // else the first tag that is one. `category: 'strategy'` is a PURPOSE, so
    // overwriting it would throw away what the document is FOR.
    const { meta, via } = withFieldValue({ category: 'strategy', tags: ['funding'] }, 'topic', 'land')
    expect(meta).toEqual({ category: 'strategy', tags: ['funding', 'land'] })
    expect(via).toBe('tag')
  })

  it('returns a cleared field to EMPTY, not to its rejected value (P6-34)', () => {
    // The whole point of Clear: a value somebody rejected must not silently
    // stay, and the entry has to rejoin the needs-a-look list.
    const written = withProvenance({ category: 'land' }, 'topic', { mechanism: 'model', at: 'T', value: 'land', via: 'category' })
    const cleared = withoutFieldValue(written, 'topic', { mechanism: 'model', at: 'T', value: 'land', via: 'category' })
    expect(cleared).toEqual({ category: '' })
    expect(fieldValueOf(row({ kind: 'document', ...cleared, meta: cleared }), 'topic')).toBe('')
  })

  it('clears a topic that rode on a tag without touching the purpose or the other tags', () => {
    const start = { category: 'strategy', tags: ['funding', 'land'] }
    const record = { mechanism: 'model' as const, at: 'T', value: 'land', via: 'tag' as const }
    const cleared = withoutFieldValue(withProvenance(start, 'topic', record), 'topic', record)
    expect(cleared).toEqual({ category: 'strategy', tags: ['funding'] })
  })

  it('clears a hand-written topic even with no record to go on', () => {
    // Every tag that IS a topic has to go, or the field is "cleared" and still
    // answers — the exact silent-keep this criterion forbids.
    const cleared = withoutFieldValue({ category: 'strategy', tags: ['funding', 'land', 'water'] }, 'topic', null)
    expect(cleared).toEqual({ category: 'strategy', tags: ['funding'] })
  })

  it('clears coverage and the summary by their own manifest keys', () => {
    expect(withoutFieldValue({ coverage: 'state:GA', title: 'x' }, 'coverage', null)).toEqual({ title: 'x' })
    expect(withoutFieldValue({ description: 'A guess.', title: 'x' }, 'summary', null)).toEqual({ title: 'x' })
  })
})

/**
 * P7-7: the one CAPABILITY field. It is an INFERRED field in P6-34's sense, so
 * almost everything about it is already covered above — these are the parts
 * that are its own: where it is stored, which kinds are asked, and the thing
 * the ticket forbids.
 */
describe('what a dataset answers (P7-7)', () => {
  const ANSWER = 'Answers: which parcels sit within N miles of a transmission line.'

  it('is a plain manifest string — `meta` JSONB, no schema change', () => {
    expect(fieldValueOf(row({ meta: { whatItAnswers: ANSWER } }), 'whatItAnswers')).toBe(ANSWER)
    expect(fieldValueOf(row({ meta: { whatItAnswers: `  ${ANSWER}  ` } }), 'whatItAnswers')).toBe(ANSWER)
    expect(fieldValueOf(row({ meta: {} }), 'whatItAnswers')).toBe('')
    // Not a string is not a value — this is JSON out of a bucket.
    expect(fieldValueOf(row({ meta: { whatItAnswers: 42 } }), 'whatItAnswers')).toBe('')
  })

  it('is asked of a dataset and a source, and of nothing else', () => {
    // The same gate P6-1 and P6-19 use. A document's "what it answers" is its
    // summary, and asking a wiki page would put a row on the queue nobody
    // could clear.
    expect(fieldAppliesTo('dataset', 'whatItAnswers')).toBe(true)
    expect(fieldAppliesTo('source', 'whatItAnswers')).toBe(true)
    expect(fieldAppliesTo('document', 'whatItAnswers')).toBe(false)
    expect(fieldAppliesTo('wiki', 'whatItAnswers')).toBe(false)
    // And a stray key on a kind nothing asks does not answer either.
    expect(fieldValueOf(row({ kind: 'wiki', meta: { whatItAnswers: ANSWER } }), 'whatItAnswers')).toBe('')
  })

  it('queues what a model wrote, with the sentence it was read from', () => {
    const meta = withProvenance({ whatItAnswers: ANSWER }, 'whatItAnswers', {
      mechanism: 'model',
      at: 'T',
      value: ANSWER,
      evidence: 'Each parcel record includes the distance to the nearest transmission corridor.',
      via: 'field',
    })
    const entry = row({ meta })
    expect(mechanismOf(entry, 'whatItAnswers')).toBe('model')
    expect(isUnverified(entry, 'whatItAnswers')).toBe(true)
    expect(unverifiedFields(entry)).toEqual(['whatItAnswers'])
    expect(provenanceOf(entry, 'whatItAnswers')?.evidence).toContain('transmission corridor')
    // And it is reportable outward — `get_entry` reads exactly this.
    expect(provenanceReport(entry).whatItAnswers?.mechanism).toBe('model')
  })

  it('reads a hand-written line as a person’s and never queues it', () => {
    // There is no derivation for this field, so the second step of
    // `mechanismOf` cannot answer: a line with no record is somebody's words.
    const entry = row({ meta: { whatItAnswers: ANSWER } })
    expect(mechanismOf(entry, 'whatItAnswers')).toBe('person')
    expect(isUnverified(entry, 'whatItAnswers')).toBe(false)
    expect(hasUnverifiedValue(entry)).toBe(false)
  })

  it('leaves the queue for good once a person keeps it', () => {
    const written = withProvenance({ whatItAnswers: ANSWER }, 'whatItAnswers', { mechanism: 'model', at: 'T', value: ANSWER })
    const kept = withVerification(written, 'whatItAnswers', 'nick', 'T2')
    const entry = row({ meta: kept })
    // The words stay the model's; the vouching is the person's.
    expect(mechanismOf(entry, 'whatItAnswers')).toBe('model')
    expect(isUnverified(entry, 'whatItAnswers')).toBe(false)
    expect(provenanceOf(entry, 'whatItAnswers')?.verifiedBy).toBe('nick')
  })

  it('writes and clears by its own manifest key', () => {
    const { meta, via } = withFieldValue({ title: 'Parcels' }, 'whatItAnswers', ANSWER)
    expect(meta).toEqual({ title: 'Parcels', whatItAnswers: ANSWER })
    expect(via).toBe('field')
    expect(withoutFieldValue(meta, 'whatItAnswers', null)).toEqual({ title: 'Parcels' })
  })

  it('does NOTHING SPECIAL about a line that restates the title', () => {
    // The ticket is explicit, and so is §F.4d's caveat: a `whatItAnswers`
    // everyone fills with the title restated is worse than no field because it
    // LOOKS like signal — and the answer to that is the verification queue, not
    // a detector. A heuristic that half-worked would be worse than the queue,
    // so a restatement reads exactly like any other model value: applied,
    // unverified, queued, and visible to the person who can fix it.
    const restated = 'Parcel boundaries of Macon County'
    const meta = withProvenance({ whatItAnswers: restated }, 'whatItAnswers', {
      mechanism: 'model',
      at: 'T',
      value: restated,
    })
    const entry = row({ title: 'Parcel boundaries of Macon County', meta } as Partial<ProvenanceRow>)
    expect(fieldValueOf(entry, 'whatItAnswers')).toBe(restated)
    expect(isUnverified(entry, 'whatItAnswers')).toBe(true)
    expect(unverifiedFields(entry)).toEqual(['whatItAnswers'])
  })
})
