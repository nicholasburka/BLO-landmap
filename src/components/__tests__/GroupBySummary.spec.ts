import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GroupBySummary from '../GroupBySummary.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import type { ColumnSummary } from '@/lib/libraryData'

/** "Rows counted by <column>" (P5-42) with its bar chart (P5-54). */
const COUNTS: ColumnSummary = {
  column: 'Tier',
  type: 'string',
  filled: 3,
  empty: 1,
  distinct: 2,
  top: [
    { value: 'Tier 1', count: 2 },
    { value: 'Tier 2', count: 1 },
  ],
  numbers: null,
  dates: null,
}

function mountPanel(summary: ColumnSummary = COUNTS) {
  return mount(GroupBySummary, {
    props: { column: 'Tier', summary, loading: false, matched: 4, slug: 'orgs' },
  })
}

describe('GroupBySummary chart (P5-54)', () => {
  it('draws the counts as bars above the table, sharing its numbers', () => {
    const w = mountPanel()
    const chart = w.get('[data-testid="summary-chart"]')
    expect(chart.text()).toContain('Most common values in Tier')
    expect(chart.text()).toContain('2 rows · 50%')
    // The table is still the interactive half.
    expect(w.get('[data-testid="group-by-table"]').findAll('tbody tr')).toHaveLength(3)
  })

  it('offers the chart as an image without touching the CSV download', () => {
    const w = mountPanel()
    expect(w.get('[data-testid="chart-copy"]').text()).toBe('Copy as image')
    expect(w.get('[data-testid="group-by-csv"]').text()).toBe('Download this table as CSV')
  })

  it('draws a readable head of a long list and says what it left out', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ value: `v${i}`, count: 40 - i }))
    const w = mountPanel({ ...COUNTS, top: many, distinct: 200 })
    expect(w.get('[data-testid="chart-bars"]').findAll('title')).toHaveLength(12)
    expect(w.get('[data-testid="chart-note"]').text()).toBe('Showing the 12 most common of 200 values.')
    // …while the table still lists every value it was given.
    expect(w.get('[data-testid="group-by-table"]').findAll('tbody tr')).toHaveLength(41)
  })

  it('shows no chart when nothing is filled in', () => {
    const w = mountPanel({ ...COUNTS, top: [], distinct: 0, filled: 0 })
    expect(w.find('[data-testid="summary-chart"]').exists()).toBe(false)
    expect(w.text()).toContain('Nothing is filled in here')
  })
})

/**
 * P5-60: the counted table scrolls inside its own card rather than pushing
 * the page sideways, and each value — which is a filter — is a 44 px row.
 */
const GROUP_SFC = readStyles('src/components/GroupBySummary.vue')
const GROUP_PHONE = mediaBlock(GROUP_SFC, 640)

describe('GroupBySummary — phone layout (P5-60)', () => {
  it('scrolls the table inside the card', () => {
    const scroll = ruleFor(GROUP_SFC, '.gb-scroll')
    expect(scroll).toContain('overflow-x: auto')
    expect(scroll).toContain('max-width: 100%')
  })

  it('makes each value a 44 px row and reads at 14 px', () => {
    expect(ruleFor(GROUP_PHONE, '.value-btn')).toContain('min-height: 44px')
    expect(ruleFor(GROUP_PHONE, '.gb-table')).toContain('font-size: 14px')
    expect(ruleFor(GROUP_PHONE, '.csv-btn')).toContain('min-height: 44px')
    expect(ruleFor(GROUP_PHONE, '.back-btn')).toContain('min-height: 44px')
  })
})
