import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ColumnSummary from '../ColumnSummary.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import type { ColumnSummary as ColumnSummaryData } from '@/lib/libraryData'

/**
 * The summary panel (P5-42) and its chart (P5-54). The chart is a picture of
 * the same numbers the facts and bars already show — what matters here is
 * that the right shape is offered for the column's type, and that the choice
 * is announced so a saved view can remember it.
 */
function summary(overrides: Partial<ColumnSummaryData> = {}): ColumnSummaryData {
  return {
    column: 'Tier',
    type: 'string',
    filled: 3,
    empty: 0,
    distinct: 2,
    top: [
      { value: 'Tier 1', count: 2 },
      { value: 'Tier 2', count: 1 },
    ],
    numbers: null,
    dates: null,
    ...overrides,
  }
}

const NUMBERS = summary({
  column: 'Score',
  type: 'number',
  top: [{ value: '90', count: 1 }],
  numbers: {
    min: 60,
    max: 90,
    mean: 75,
    median: 75,
    histogram: [
      { from: 60, to: 75, count: 1 },
      { from: 75, to: 90, count: 3 },
    ],
  },
})

const DATES = summary({
  column: 'Joined',
  type: 'date',
  top: [{ value: '2024-01-15', count: 1 }],
  dates: {
    min: '2024-01-15',
    max: '2024-03-02',
    unit: 'month',
    byMonth: [
      { from: '2024-01', count: 1 },
      { from: '2024-02', count: 0 },
      { from: '2024-03', count: 2 },
    ],
  },
})

function mountPanel(data: ColumnSummaryData, props: Record<string, unknown> = {}) {
  return mount(ColumnSummary, {
    props: { column: data.column, summary: data, loading: false, matched: 3, slug: 'orgs', ...props },
  })
}

describe('ColumnSummary chart (P5-54)', () => {
  it('draws bars for a text column, with no toggle to make (there is one shape)', () => {
    const w = mountPanel(summary())
    expect(w.get('[data-testid="column-chart"]').text()).toContain('Most common values in Tier')
    expect(w.find('.chart-toggle').exists()).toBe(false)
    // The clickable list is still there — the chart is the picture, not the control.
    expect(w.find('[data-testid="distribution-bars"]').exists()).toBe(true)
  })

  it('offers the spread first for a number column, and bars as the other choice', () => {
    const w = mountPanel(NUMBERS)
    const toggle = w.get('.chart-toggle')
    expect(toggle.findAll('button').map(b => b.text())).toEqual(['Spread', 'Bars'])
    expect(w.get('[data-testid="chart-columns"]').findAll('rect')).toHaveLength(2)
    expect(w.find('[data-testid="chart-bars"]').exists()).toBe(false)
  })

  it('switches to bars when asked, and says which chart is showing', async () => {
    const w = mountPanel(NUMBERS)
    await w.get('.chart-toggle').findAll('button')[1].trigger('click')
    expect(w.find('[data-testid="chart-bars"]').exists()).toBe(true)
    expect(w.emitted('update:chart')).toEqual([['bars']])
    expect(w.get('.chart-toggle').findAll('button')[1].attributes('aria-pressed')).toBe('true')
  })

  it('opens on the chart a saved view asked for', () => {
    const w = mountPanel(NUMBERS, { chart: 'bars' })
    expect(w.find('[data-testid="chart-bars"]').exists()).toBe(true)
  })

  it('falls back to the best chart when the saved one makes no sense for this column', () => {
    const w = mountPanel(summary(), { chart: 'line' })
    expect(w.find('[data-testid="chart-bars"]').exists()).toBe(true)
  })

  it('offers a count-over-time line for a date column', () => {
    const w = mountPanel(DATES)
    expect(w.get('.chart-toggle').findAll('button').map(b => b.text())).toEqual(['Over time', 'Bars'])
    expect(w.get('[data-testid="chart-line"]').findAll('circle')).toHaveLength(3)
    expect(w.get('[data-testid="column-chart"]').text()).toContain('Joined over time')
    // The plain date range stays above it.
    expect(w.get('[data-testid="date-summary"]').text()).toContain('2024-01-15')
  })

  it('shows no chart at all for a column with nothing in it', () => {
    const w = mountPanel(summary({ top: [], filled: 0, empty: 3, distinct: 0 }))
    expect(w.find('[data-testid="column-chart"]').exists()).toBe(false)
    expect(w.text()).toContain('Nothing is filled in here')
  })
})

/**
 * P5-60: the summary panel is the full width of a phone, so its facts read at
 * 14 px and its three controls — back, the chart toggle, group by — are 44 px.
 */
const SUMMARY_SFC = readStyles('src/components/ColumnSummary.vue')
const SUMMARY_PHONE = mediaBlock(SUMMARY_SFC, 640)

describe('ColumnSummary — phone layout (P5-60)', () => {
  it('reads at 14 px', () => {
    expect(ruleFor(SUMMARY_PHONE, '.column-summary')).toContain('font-size: 14px')
    expect(ruleFor(SUMMARY_PHONE, '.cs-facts dt')).toContain('font-size: 13px')
  })

  it('gives back, the chart toggle and group-by 44 px targets', () => {
    expect(ruleFor(SUMMARY_PHONE, '.back-btn')).toContain('min-height: 44px')
    expect(ruleFor(SUMMARY_PHONE, '.chart-toggle-btn')).toContain('min-height: 44px')
    expect(ruleFor(SUMMARY_PHONE, '.group-btn')).toContain('min-height: 44px')
  })
})
