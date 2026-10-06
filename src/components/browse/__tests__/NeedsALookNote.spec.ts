import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('@/lib/remediation', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/remediation')>()
  return { ...actual, verifyField: vi.fn() }
})

import { verifyField } from '@/lib/remediation'
import { WHAT_IT_ANSWERS_MAX_CHARS } from '@/lib/provenance'
import { needsALookNote } from '@/lib/kb'
import type { CatalogEntry } from '@/lib/libraryCatalog'
import NeedsALookNote from '../NeedsALookNote.vue'

const mocked = vi.mocked(verifyField)

/**
 * P6-33's list and P6-34's three actions.
 *
 * The component is the whole reason one attention row in place of four loses
 * nothing: it is where the list says which field, which case, what the value
 * says and the sentence a model read it from.
 */

const e = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
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
})

const MODEL_TOPIC = {
  mechanism: 'model',
  at: '2026-10-05T09:00:00.000Z',
  value: 'land',
  evidence: 'Black landowners held fifteen million acres in 1910.',
  via: 'category',
}

const fields = (w: ReturnType<typeof mount>) =>
  w.findAll('[data-testid="needs-a-look-field"]').map(p => ({
    field: p.attributes('data-field'),
    state: p.attributes('data-state'),
    text: p.text().replace(/\s+/g, ' ').trim(),
  }))

beforeEach(() => {
  mocked.mockReset()
  mocked.mockResolvedValue({ entry: null, provenance: {} })
})

describe('what it says', () => {
  it('names every gap on an entry nothing could fill', () => {
    // A dataset with no topic, no publisher, no coverage, no answers line and
    // (P7-10) neither date: six of the old attention rows, one job. The case
    // gets stronger with every field, which is what P6-33's roll-up is for.
    const w = mount(NeedsALookNote, { props: { entry: e({ kind: 'dataset' }) } })
    expect(fields(w).map(f => [f.field, f.state])).toEqual([
      ['topic', 'missing'],
      ['organization', 'missing'],
      ['coverage', 'missing'],
      ['whatItAnswers', 'missing'],
      ['covers', 'missing'],
      ['published', 'missing'],
    ])
    expect(fields(w)[0].text).toContain('nothing could fill this')
    // Nothing to keep and nothing to clear — only an offer to write it.
    expect(w.find('[data-testid="needs-a-look-keep"]').exists()).toBe(false)
    expect(w.find('[data-testid="needs-a-look-clear"]').exists()).toBe(false)
    expect(w.find('[data-testid="needs-a-look-edit"]').exists()).toBe(true)
  })

  it('shows the field, the value, the mechanism and the evidence for a model’s reading', () => {
    const w = mount(NeedsALookNote, { props: { entry: e({ category: 'land', meta: { provenance: { topic: MODEL_TOPIC } } }) } })
    expect(fields(w).map(f => [f.field, f.state])).toEqual([['topic', 'unverified']])
    // The label from the taxonomy, not the raw id.
    expect(w.get('[data-testid="needs-a-look-value"]').text()).toBe('Land')
    expect(w.get('[data-testid="needs-a-look-mechanism"]').text()).toBe('read by the model')
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toContain('fifteen million acres')
    // All three actions, because there is something to decide about.
    for (const action of ['keep', 'edit', 'clear']) {
      expect(w.find(`[data-testid="needs-a-look-${action}"]`).exists()).toBe(true)
    }
  })

  it('says so when a model left no sentence behind', () => {
    const w = mount(NeedsALookNote, {
      props: { entry: e({ category: 'land', meta: { provenance: { topic: { mechanism: 'model', value: 'land' } } } }) },
    })
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toBe('no sentence was recorded')
  })

  it('narrows to one field for an old deep link, and shows nothing for a clean entry', () => {
    // P6-23's invariant: a count must never disagree with the list it opens,
    // so `?attention=no-coverage` shows the coverage gap and not the others.
    const dataset = e({ kind: 'dataset' })
    const narrowed = mount(NeedsALookNote, { props: { entry: dataset, queueKey: 'no-coverage' } })
    expect(fields(narrowed).map(f => f.field)).toEqual(['coverage'])

    const clean = e({
      kind: 'dataset',
      category: 'land',
      organization: 'epa',
      coverage: { scope: 'national', states: [], label: 'National' },
      dates: { covers: '2024', published: '2024-03' },
      meta: { whatItAnswers: 'Answers: who owns what, by county.' },
    })
    const empty = mount(NeedsALookNote, { props: { entry: clean } })
    expect(empty.find('[data-testid="needs-a-look"]').exists()).toBe(false)
  })
})

describe('the three actions', () => {
  const unverified = () => e({ category: 'land', meta: { provenance: { topic: MODEL_TOPIC } } })

  it('Keep vouches for the model’s value', async () => {
    const w = mount(NeedsALookNote, { props: { entry: unverified() } })
    await w.get('[data-testid="needs-a-look-keep"]').trigger('click')
    await flushPromises()
    expect(mocked).toHaveBeenCalledWith('why-five-million-memo', 'topic', 'keep', undefined)
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('Clear empties the field so the entry rejoins the list', async () => {
    const w = mount(NeedsALookNote, { props: { entry: unverified() } })
    await w.get('[data-testid="needs-a-look-clear"]').trigger('click')
    await flushPromises()
    expect(mocked).toHaveBeenCalledWith('why-five-million-memo', 'topic', 'clear', undefined)
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('Edit offers the closed vocabulary, saves the pick, and can be cancelled', async () => {
    const w = mount(NeedsALookNote, { props: { entry: unverified() } })
    expect(w.find('[data-testid="needs-a-look-edit-box"]').exists()).toBe(false)
    await w.get('[data-testid="needs-a-look-edit"]').trigger('click')
    const input = w.get('[data-testid="needs-a-look-input"]')
    // A topic is a word from one closed vocabulary, so it is chosen, not typed.
    expect(input.element.tagName).toBe('SELECT')
    expect(input.findAll('option').map(o => o.attributes('value'))).toContain('housing')
    await input.setValue('housing')
    await w.get('[data-testid="needs-a-look-save"]').trigger('click')
    await flushPromises()
    expect(mocked).toHaveBeenCalledWith('why-five-million-memo', 'topic', 'edit', 'housing')

    await w.get('[data-testid="needs-a-look-edit"]').trigger('click')
    await w.get('[data-testid="needs-a-look-cancel"]').trigger('click')
    expect(w.find('[data-testid="needs-a-look-edit-box"]').exists()).toBe(false)
  })

  it('says why a save did not land, and does not pretend it did', async () => {
    mocked.mockRejectedValue(new Error('the library is not available right now.'))
    const w = mount(NeedsALookNote, { props: { entry: unverified() } })
    await w.get('[data-testid="needs-a-look-keep"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="needs-a-look-error"]').text()).toContain('not available right now')
    expect(w.emitted('changed')).toBeUndefined()
  })
})

/**
 * P7-7: the answers line through the same row. It needed no new component —
 * the row reads the field table — but it is the first field whose value is a
 * SENTENCE rather than a chip, which is what the box and the cap are about.
 */
describe('the answers line (P7-7)', () => {
  const ANSWER = 'Answers: which parcels sit within five miles of a transmission line.'
  const unverifiedAnswer = () =>
    e({
      kind: 'dataset',
      category: 'land',
      organization: 'epa',
      coverage: { scope: 'national', states: [], label: 'National' },
      dates: { covers: '2024', published: '2024-03' },
      meta: {
        whatItAnswers: ANSWER,
        provenance: {
          whatItAnswers: {
            mechanism: 'model',
            at: 'T',
            value: ANSWER,
            evidence: 'Each parcel record includes the distance to the nearest transmission corridor.',
            via: 'field',
          },
        },
      },
    })

  it('shows the line, how it got there, and the sentence behind it', () => {
    const w = mount(NeedsALookNote, { props: { entry: unverifiedAnswer() } })
    expect(fields(w).map(f => [f.field, f.state])).toEqual([['whatItAnswers', 'unverified']])
    expect(w.get('[data-testid="needs-a-look-value"]').text()).toBe(ANSWER)
    expect(w.get('[data-testid="needs-a-look-mechanism"]').text()).toBe('read by the model')
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toContain('transmission corridor')
  })

  it('edits in a sentence-sized box, capped at what a search row can carry', async () => {
    const w = mount(NeedsALookNote, { props: { entry: unverifiedAnswer() } })
    await w.get('[data-testid="needs-a-look-edit"]').trigger('click')
    const input = w.get('[data-testid="needs-a-look-input"]')
    expect(input.attributes('maxlength')).toBe(String(WHAT_IT_ANSWERS_MAX_CHARS))
    expect(input.classes()).toContain('wide')
    await input.setValue('Answers: which counties lost the most land.')
    await w.get('[data-testid="needs-a-look-save"]').trigger('click')
    expect(mocked).toHaveBeenCalledWith('why-five-million-memo', 'whatItAnswers', 'edit', 'Answers: which counties lost the most land.')
  })

  it('says "answers unverified" rather than leaking the field name', () => {
    // The per-row line is read by a person: `whatItAnswers unverified` is a
    // key in a sentence.
    expect(needsALookNote(unverifiedAnswer())).toBe('answers unverified')
  })
})

/**
 * P7-10: the two dates through the same row, with no new component — the row
 * reads the field table, which is the whole point of the table.
 */
describe('when the data is from (P7-10)', () => {
  const dated = () =>
    e({
      kind: 'dataset',
      category: 'land',
      organization: 'epa',
      coverage: { scope: 'national', states: [], label: 'National' },
      dates: { covers: '2024', published: '2024-03-12' },
      meta: {
        whatItAnswers: 'Answers: who owns what, by county.',
        provenance: {
          published: {
            mechanism: 'model',
            at: 'T',
            value: '2024-03-12',
            evidence: 'This dataset was last updated on March 12, 2024.',
            via: 'field',
          },
        },
      },
    })

  it('shows the date, how it got there, and the sentence behind it', () => {
    const w = mount(NeedsALookNote, { props: { entry: dated() } })
    expect(fields(w).map(f => [f.field, f.state])).toEqual([['published', 'unverified']])
    expect(w.get('[data-testid="needs-a-look-value"]').text()).toBe('2024-03-12')
    expect(w.get('[data-testid="needs-a-look-mechanism"]').text()).toBe('read by the model')
    expect(w.get('[data-testid="needs-a-look-evidence"]').text()).toContain('March 12, 2024')
  })

  it('says the two gaps in words a person reads, never the field names', () => {
    expect(needsALookNote(e({ kind: 'dataset', category: 'land', organization: 'epa', coverage: { scope: 'national', states: [], label: 'National' }, meta: { whatItAnswers: 'Answers: who owns what.' } }))).toBe(
      'no period covered · no published date',
    )
    expect(needsALookNote(dated())).toBe('published unverified')
  })

  it('narrows to one date for a deep link, so the two facts stay apart', () => {
    const w = mount(NeedsALookNote, { props: { entry: e({ kind: 'dataset' }), queueKey: 'no-published-date' } })
    expect(fields(w).map(f => f.field)).toEqual(['published'])
  })

  it('never asks a person to verify the fetch date, because we wrote it', () => {
    const w = mount(NeedsALookNote, { props: { entry: dated() } })
    expect(fields(w).map(f => f.field)).not.toContain('fetched')
  })
})
