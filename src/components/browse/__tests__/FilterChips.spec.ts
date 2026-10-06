import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FilterChips from '../FilterChips.vue'
import { NONE_VALUE } from '@/lib/browse'

const FACETS = [
  { id: 'epa', label: 'US EPA', count: 13 },
  { id: 'usgs', label: 'USGS', count: 3 },
  { id: '', label: 'No organization', count: 2 },
]

function mountChips(modelValue = '') {
  return mount(FilterChips, {
    props: { modelValue, facets: FACETS, label: 'Filter by publisher', allLabel: 'All publishers' },
  })
}

describe('FilterChips (P6-3)', () => {
  it('shows an "all" chip and one per facet, with its count', () => {
    const w = mountChips()
    expect(w.findAll('.chip').map(c => c.text())).toEqual([
      'All publishers',
      'US EPA 13',
      'USGS 3',
      'No organization 2',
    ])
    expect(w.get('[data-chip=""]').attributes('aria-pressed')).toBe('true')
  })

  it('asks for the value the chip stands for', async () => {
    const w = mountChips()
    await w.get('[data-chip="epa"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['epa']])
  })

  it('files the "nothing said" bucket under a word, not an empty string', async () => {
    const w = mountChips()
    await w.get(`[data-chip="${NONE_VALUE}"]`).trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([[NONE_VALUE]])
  })

  it('pressing the chip you are on clears it', async () => {
    const w = mountChips('epa')
    expect(w.get('[data-chip="epa"]').attributes('aria-pressed')).toBe('true')
    await w.get('[data-chip="epa"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['']])
  })

  it('draws nothing when there is nothing to filter by', () => {
    const w = mount(FilterChips, { props: { modelValue: '', facets: [], label: 'x', allLabel: 'All' } })
    expect(w.find('[data-testid="filter-chips"]').exists()).toBe(false)
  })
})

describe('FilterChips — folding a long row (P6-18)', () => {
  const many = Array.from({ length: 29 }, (_, i) => ({
    id: `pub-${i}`,
    label: `Publisher ${i}`,
    count: 29 - i,
  }))

  const mountMany = (modelValue = '') =>
    mount(FilterChips, {
      props: { modelValue, facets: many, label: 'Filter by publisher', allLabel: 'All publishers' },
    })

  it('draws the heaviest eight and offers the rest behind a count', () => {
    const w = mountMany()
    expect(w.findAll('[data-chip]').map(c => c.attributes('data-chip'))).toEqual([
      '',
      ...Array.from({ length: 8 }, (_, i) => `pub-${i}`),
    ])
    expect(w.get('[data-testid="chips-toggle"]').text()).toBe('+21 more')
  })

  it('expands to every value and folds back', async () => {
    const w = mountMany()
    await w.get('[data-testid="chips-toggle"]').trigger('click')
    expect(w.findAll('[data-chip]')).toHaveLength(30)
    expect(w.get('[data-testid="chips-toggle"]').text()).toBe('Show fewer')
    expect(w.get('[data-testid="chips-toggle"]').attributes('aria-expanded')).toBe('true')
    await w.get('[data-testid="chips-toggle"]').trigger('click')
    expect(w.findAll('[data-chip]')).toHaveLength(9)
  })

  it('offers no fold when everything already fits', () => {
    const w = mount(FilterChips, {
      props: { modelValue: '', facets: many.slice(0, 8), label: 'l', allLabel: 'all' },
    })
    expect(w.find('[data-testid="chips-toggle"]').exists()).toBe(false)
  })

  // The one that matters: a filter you cannot see is a filter you cannot clear.
  it('pulls a chosen value into the folded row however far down the order it sits', () => {
    const w = mountMany('pub-22')
    const chips = w.findAll('[data-chip]').map(c => c.attributes('data-chip'))
    expect(chips).toContain('pub-22')
    expect(w.get('[data-chip="pub-22"]').attributes('aria-pressed')).toBe('true')
    // Still folded — the pulled-in chip is extra, not a licence to show all 29.
    expect(w.findAll('[data-chip]')).toHaveLength(10)
    expect(w.get('[data-testid="chips-toggle"]').text()).toBe('+20 more')
  })

  it('clears a pulled-in chip without expanding first', async () => {
    const w = mountMany('pub-22')
    await w.get('[data-chip="pub-22"]').trigger('click')
    expect(w.emitted('update:modelValue')?.[0]).toEqual([''])
  })

  it('keeps a zero-count chosen chip visible (P6-22, the empty-combination case)', () => {
    const w = mount(FilterChips, {
      props: {
        modelValue: 'epa',
        facets: [{ id: 'epa', label: 'US EPA', count: 0 }, { id: 'blo', label: 'BLO', count: 3 }],
        label: 'Filter by publisher',
        allLabel: 'All publishers',
      },
    })
    expect(w.get('[data-chip="epa"]').text()).toBe('US EPA 0')
    expect(w.get('[data-chip="epa"]').attributes('aria-pressed')).toBe('true')
  })
})
