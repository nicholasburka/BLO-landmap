import { describe, it, expect, beforeEach } from 'vitest'
import {
  INDEX_DRAFT_PREFIX,
  indexDraftKey,
  readIndexDraft,
  writeIndexDraft,
  clearIndexDraft,
} from '@/lib/indexDraft'
import type { CompositeTerm } from '@/lib/workingSets'

/**
 * An unsaved index formula, kept across a page leave (P9-6a).
 *
 * The thing being judged here is what happens to five minutes of dragging when
 * somebody clicks a link: it survives, and it comes back as *itself* or not at
 * all. A half-read formula would put weights on screen nobody chose, which is
 * worse than losing them — so every malformed shape below reads as "no draft".
 */

const TERMS: CompositeTerm[] = [
  { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
  { layer: 'poverty_by_race', weight: 3, direction: 'lower_better' },
]

beforeEach(() => {
  localStorage.clear()
})

describe('an index draft', () => {
  it('comes back exactly as it went in', () => {
    writeIndexDraft('memphis', 'efficacy', TERMS)
    expect(readIndexDraft('memphis', 'efficacy')).toEqual(TERMS)
  })

  it('is per index, not per set — two formulas on one set are two drafts', () => {
    writeIndexDraft('memphis', 'efficacy', TERMS)
    expect(readIndexDraft('memphis', 'opportunity')).toBeNull()
    expect(readIndexDraft('nashville', 'efficacy')).toBeNull()
    expect(indexDraftKey('memphis', 'efficacy')).not.toBe(indexDraftKey('memphis', 'opportunity'))
  })

  it('lives under a prefix logout wipes — a formula names internal layers', () => {
    // P5-19: nothing internal survives a logout. `useAuth.spec` holds the other
    // half of this claim; this one is that the key is in that family at all.
    expect(INDEX_DRAFT_PREFIX).toBe('blo:index-draft:')
    writeIndexDraft('memphis', 'efficacy', TERMS)
    expect(indexDraftKey('memphis', 'efficacy').startsWith(INDEX_DRAFT_PREFIX)).toBe(true)
  })

  it('is nothing when nothing was stored', () => {
    expect(readIndexDraft('memphis', 'efficacy')).toBeNull()
  })

  it('is discarded by clearing it', () => {
    writeIndexDraft('memphis', 'efficacy', TERMS)
    clearIndexDraft('memphis', 'efficacy')
    expect(readIndexDraft('memphis', 'efficacy')).toBeNull()
  })

  it('reads an unknown direction as the default rather than refusing', () => {
    // Direction has exactly two values and one of them is the default, so a
    // third is a value to narrow, not a formula to throw away.
    localStorage.setItem(
      indexDraftKey('memphis', 'efficacy'),
      JSON.stringify([{ layer: 'internal-votes', weight: 6, direction: 'sideways' }]),
    )
    expect(readIndexDraft('memphis', 'efficacy')).toEqual([
      { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
    ])
  })

  describe('reads as no draft at all', () => {
    const bad: Record<string, string> = {
      'text that is not JSON': 'not json {',
      'an empty list': '[]',
      'an object': '{"layer":"internal-votes"}',
      'a term with no layer': '[{"weight":6,"direction":"higher_better"}]',
      'a term with no weight': '[{"layer":"internal-votes","direction":"higher_better"}]',
      'a weight that is not a number': '[{"layer":"internal-votes","weight":"6"}]',
      // A term at zero is OUT of the index, so it is never stored — reading one
      // back means the stored shape is not one this wrote.
      'a term at zero': '[{"layer":"internal-votes","weight":0}]',
    }
    for (const [what, raw] of Object.entries(bad)) {
      it(what, () => {
        localStorage.setItem(indexDraftKey('memphis', 'efficacy'), raw)
        expect(readIndexDraft('memphis', 'efficacy')).toBeNull()
      })
    }

    it('and one bad term spoils the formula, rather than being dropped', () => {
      // Silently dropping a term changes the index. Half a formula is not a
      // formula, and the saved one is right there to fall back to.
      localStorage.setItem(
        indexDraftKey('memphis', 'efficacy'),
        JSON.stringify([TERMS[0], { layer: '', weight: 4 }]),
      )
      expect(readIndexDraft('memphis', 'efficacy')).toBeNull()
    })
  })
})
