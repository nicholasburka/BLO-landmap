import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import IndexCompareCard from '../IndexCompareCard.vue'
import type { DerivedColumn } from '@/lib/workingSets'

/**
 * P9-6. Two versions of an index, and what re-weighting did to the order.
 * The set already holds both columns' values, so this fetches nothing.
 */
function col(id: string, label: string, values: Record<string, number>): DerivedColumn {
  return {
    id, label, unit: '', method: '', computedAt: '2026-10-08T00:00:00.000Z',
    values, rows: Object.keys(values).length, storedAt: 'manifest',
    type: 'composite', by: 'nick',
  } as DerivedColumn
}

const SAME_ORDER = [
  col('a', 'Index A', { '01001': 1, '01003': 2, '01005': 3, '01007': 4 }),
  col('b', 'Index B', { '01001': 10, '01003': 20, '01005': 30, '01007': 40 }),
]
const SWAPPED = [
  col('a', 'Index A', { '01001': 1, '01003': 2, '01005': 3, '01007': 4 }),
  col('b', 'Index B', { '01001': 4, '01003': 2, '01005': 3, '01007': 1 }),
]

describe('IndexCompareCard (P9-6)', () => {
  it('says nothing at all when there is only one index to compare', () => {
    const w = mount(IndexCompareCard, { props: { columns: [SAME_ORDER[0]] } })
    expect(w.find('[data-testid="index-compare"]').exists()).toBe(false)
  })

  it('compares the first two by default and says how many counties', () => {
    const w = mount(IndexCompareCard, { props: { columns: SAME_ORDER } })
    const text = w.get('[data-testid="index-compare"]').text()
    expect(text).toContain('4 counties')
  })

  /** Never a bare correlation: the number, what it means in words, and the
   *  count it is over, together or not at all. */
  it('puts the statistic in words as well as a number', () => {
    const w = mount(IndexCompareCard, { props: { columns: SAME_ORDER } })
    const text = w.get('[data-testid="index-compare"]').text()
    expect(text).toMatch(/same ranking/i)
    expect(text).toContain('1')
  })

  it('lists the counties that moved, with both ranks', () => {
    const w = mount(IndexCompareCard, { props: { columns: SWAPPED } })
    const movers = w.get('[data-testid="index-movers"]').text()
    expect(movers).toContain('01001')
    expect(movers).toContain('01007')
  })

  it('says plainly when nothing moved, rather than showing an empty list', () => {
    const w = mount(IndexCompareCard, { props: { columns: SAME_ORDER } })
    expect(w.find('[data-testid="index-movers"]').exists()).toBe(false)
    expect(w.get('[data-testid="index-compare"]').text()).toMatch(/no county|nothing moved/i)
  })

  it('lets a reader pick which two', async () => {
    const three = [...SWAPPED, col('c', 'Index C', { '01001': 2, '01003': 1, '01005': 4, '01007': 3 })]
    const w = mount(IndexCompareCard, { props: { columns: three } })
    const selects = w.findAll('select')
    expect(selects).toHaveLength(2)
    await selects[1].setValue('c')
    expect(w.get('[data-testid="index-compare"]').text()).toContain('Index C')
  })
})
