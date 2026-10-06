import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DistributionBars from '../DistributionBars.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

/**
 * The clickable half of a column summary (P5-42): bars sized against the
 * biggest value, labelled with the honest count and share, each one a
 * filter. (The picture beside it is SummaryChart — see P5-54.)
 */
const VALUES = [
  { value: 'Tier 1', count: 6 },
  { value: 'Tier 2', count: 3 },
  { value: 'Tier 3', count: 1 },
]

function mountBars(values = VALUES, matched = 12) {
  return mount(DistributionBars, { props: { values, matched, column: 'Tier' } })
}

describe('DistributionBars', () => {
  it('sizes each bar against the largest value, not the whole set', () => {
    const w = mountBars()
    expect(w.findAll('.bar-fill').map(b => b.attributes('style'))).toEqual([
      'width: 100%;',
      'width: 50%;',
      'width: 16.666666666666664%;',
    ])
  })

  it('shows the count and the share of the filtered set beside each bar', () => {
    const w = mountBars()
    const first = w.findAll('.bar-row')[0]
    expect(first.get('.bar-label').text()).toBe('Tier 1')
    expect(first.get('.bar-count').text()).toBe('6')
    expect(first.get('.bar-share').text()).toBe('50%')
    expect(w.findAll('.bar-share')[2].text()).toBe('8%')
  })

  it('says in words what clicking a bar will do', () => {
    const w = mountBars()
    expect(w.findAll('.bar-row')[1].attributes('title')).toBe('Show only rows where Tier is Tier 2')
  })

  it('asks for that value when a bar is clicked', async () => {
    const w = mountBars()
    await w.findAll('.bar-row')[2].trigger('click')
    expect(w.emitted('pick')).toEqual([['Tier 3']])
  })

  it('draws nothing rather than dividing by zero when there is nothing to show', () => {
    const w = mountBars([], 0)
    expect(w.findAll('.bar-row')).toHaveLength(0)
  })

  it('keeps a share readable when it rounds below one percent', () => {
    const w = mountBars([{ value: 'Rare', count: 1 }], 1000)
    expect(w.get('.bar-share').text()).toBe('0.1%')
  })
})

/**
 * P5-60: every bar is a filter, so every bar is a tap target — and at 360 px
 * the track gives up width so the label keeps some, with the full value in
 * the label's own title.
 */
const BARS_SFC = readStyles('src/components/DistributionBars.vue')
const BARS_PHONE = mediaBlock(BARS_SFC, 640)

describe('DistributionBars — phone layout (P5-60)', () => {
  it('puts the whole value in the label title, however long it is', () => {
    const w = mount(DistributionBars, {
      props: {
        values: [{ value: 'A very long value name indeed', count: 3 }],
        matched: 10,
        column: 'Tier',
      },
    })
    expect(w.get('.bar-label').attributes('title')).toBe('A very long value name indeed')
    expect(ruleFor(BARS_SFC, '.bar-label')).toContain('text-overflow: ellipsis')
  })

  it('makes each bar a 44 px row at 14 px', () => {
    const row = ruleFor(BARS_PHONE, '.bar-row')
    expect(row).toContain('min-height: 44px')
    expect(row).toContain('font-size: 14px')
    // The track shrinks so the label keeps its width at 360 px.
    expect(row).toContain('grid-template-columns: minmax(0, 1fr) 48px auto 42px')
  })
})
