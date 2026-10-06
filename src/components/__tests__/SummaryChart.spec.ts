import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SummaryChart from '../SummaryChart.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { barsChart, histogramChart, timelineChart } from '@/lib/charts'
import type { ColumnSummary } from '@/lib/libraryData'

function summary(overrides: Partial<ColumnSummary> = {}): ColumnSummary {
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

const BARS = barsChart(summary(), { matched: 3 })!

const HISTOGRAM = histogramChart(
  summary({
    column: 'Score',
    type: 'number',
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
  }),
)!

const LINE = timelineChart(
  summary({
    column: 'Joined',
    type: 'date',
    dates: {
      min: '2024-01-01',
      max: '2024-03-01',
      unit: 'month',
      byMonth: [
        { from: '2024-01', count: 2 },
        { from: '2024-02', count: 0 },
        { from: '2024-03', count: 5 },
      ],
    },
  }),
)!

describe('SummaryChart — drawing', () => {
  it('draws one labelled bar per value, scaled against the largest', () => {
    const w = mount(SummaryChart, { props: { spec: BARS } })
    const svg = w.get('[data-testid="chart-svg"]')
    // No fixed width: the viewBox is what makes it readable at 360px.
    expect(svg.attributes('width')).toBeUndefined()
    expect(svg.attributes('viewBox')).toBe('0 0 320 60')
    const bars = w.get('[data-testid="chart-bars"]')
    expect(bars.text()).toContain('Tier 1')
    expect(bars.text()).toContain('2 rows · 67%')
    // Two rects per row (track + fill); the fill is half of the full-width
    // track for a value of 1 against a max of 2.
    const rects = bars.findAll('rect')
    expect(rects).toHaveLength(4)
    expect(rects[1].attributes('width')).toBe('320')
    expect(rects[3].attributes('width')).toBe('160')
  })

  it('names the chart and its axes in plain words, for eyes and screen readers', () => {
    const w = mount(SummaryChart, { props: { spec: BARS } })
    expect(w.text()).toContain('Most common values in Tier')
    expect(w.text()).toContain('Number of rows · Tier')
    expect(w.get('[data-testid="chart-svg"]').attributes('aria-label')).toBe(
      'Most common values in Tier. Number of rows. Tier 1: 2, Tier 2: 1',
    )
  })

  it('draws a histogram as columns with counts above them and the range beneath', () => {
    const w = mount(SummaryChart, { props: { spec: HISTOGRAM } })
    const columns = w.get('[data-testid="chart-columns"]')
    expect(columns.findAll('rect')).toHaveLength(2)
    expect(columns.text()).toContain('3')
    expect(w.get('[data-testid="chart-ticks"]').text()).toContain('60 to 75')
    expect(w.find('[data-testid="chart-bars"]').exists()).toBe(false)
  })

  it('draws a timeline as one line through every period, labelling the ends and the peak', () => {
    const w = mount(SummaryChart, { props: { spec: LINE } })
    const line = w.get('[data-testid="chart-line"]')
    expect(line.findAll('circle')).toHaveLength(3)
    expect(line.get('polyline').attributes('points')).toBe('0.0,79.2 160.0,132.0 320.0,0.0')
    expect(w.get('[data-testid="chart-ticks"]').text()).toContain('Jan 2024')
    expect(w.get('[data-testid="chart-ticks"]').text()).toContain('Mar 2024')
  })

  it('shows the shaping note when the picture is not the whole story', () => {
    const many = barsChart(
      summary({ top: Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, count: 30 - i })), distinct: 30 }),
      { matched: 100 },
    )!
    const w = mount(SummaryChart, { props: { spec: many } })
    expect(w.get('[data-testid="chart-note"]').text()).toContain('Showing the 12 most common')
  })

  it('shortens a very long value name but keeps it in full for hover and screen readers', () => {
    const long = 'A'.repeat(60)
    const spec = barsChart(summary({ top: [{ value: long, count: 1 }] }), { matched: 1 })!
    const w = mount(SummaryChart, { props: { spec } })
    expect(w.get('[data-testid="chart-bars"] text').text()).toBe(`${'A'.repeat(29)}…`)
    expect(w.get('[data-testid="chart-bars"] title').text()).toContain(long)
  })
})

/**
 * "Copy as image": the SVG is rasterised through a canvas. jsdom has no
 * canvas and no clipboard, so both are stubbed — what is under test is the
 * path, not the pixels.
 */
describe('SummaryChart — copy as image', () => {
  let written: unknown[]

  beforeEach(() => {
    written = []
    const png = new Blob(['png'], { type: 'image/png' })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(png)
    } as typeof HTMLCanvasElement.prototype.toBlob
    // An Image that "loads" as soon as a src is set.
    class FakeImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_value: string) {
        setTimeout(() => this.onload?.(), 0)
      }
    }
    vi.stubGlobal('Image', FakeImage)
    vi.stubGlobal('ClipboardItem', class {
      constructor(public items: Record<string, Blob>) {}
    })
    vi.stubGlobal('URL', Object.assign(Object.create(URL), URL, {
      createObjectURL: vi.fn(() => 'blob:chart'),
      revokeObjectURL: vi.fn(),
    }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write: vi.fn(async (items: unknown[]) => void written.push(...items)) },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('puts a PNG of the chart on the clipboard and says so', async () => {
    const w = mount(SummaryChart, { props: { spec: BARS } })
    await w.get('[data-testid="chart-copy"]').trigger('click')
    await vi.waitFor(() => expect(written).toHaveLength(1))
    await flushPromises()
    expect(w.get('[data-testid="chart-copy"]').text()).toBe('Copied ✓')
    expect(w.find('[data-testid="chart-download"]').exists()).toBe(false)
  })

  it('offers the image as a download when the clipboard will not take it', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const w = mount(SummaryChart, { props: { spec: BARS, fileName: 'orgs-tier' } })
    await w.get('[data-testid="chart-copy"]').trigger('click')
    await vi.waitFor(() => expect(w.find('[data-testid="chart-download"]').exists()).toBe(true))
    const link = w.get('[data-testid="chart-download"] a')
    expect(link.attributes('href')).toBe('blob:chart')
    expect(link.attributes('download')).toBe('orgs-tier.png')
  })

  it('degrades quietly when the browser cannot draw to a canvas at all', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const w = mount(SummaryChart, { props: { spec: BARS } })
    await w.get('[data-testid="chart-copy"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="chart-copy"]').text()).toBe('Copy as image')
    expect(w.find('[data-testid="chart-download"]').exists()).toBe(false)
  })
})

/**
 * P5-60: the chart at 360 px. The drawing already scales — a viewBox with no
 * fixed width, and every label clipped with the full text in a <title> — so
 * what was missing was a copy button a thumb could hit and type big enough
 * to read.
 */
const CHART_SFC = readStyles('src/components/SummaryChart.vue')
const CHART_PHONE = mediaBlock(CHART_SFC, 640)

describe('SummaryChart — phone layout (P5-60)', () => {
  it('keeps every long label reachable through its mark title', () => {
    const long = {
      ...BARS,
      points: [{ label: 'A very long value name that will not fit', value: 2, valueLabel: '2 rows' }],
    }
    const w = mount(SummaryChart, { props: { spec: long } })
    const text = w.get('[data-testid="chart-bars"] text').text()
    expect(text.length).toBeLessThanOrEqual(30)
    expect(text.endsWith('\u2026')).toBe(true)
    expect(w.get('[data-testid="chart-bars"] title').text()).toContain('A very long value name that will not fit')
  })

  it('gives "Copy as image" a 44 px target and readable captions', () => {
    const w = mount(SummaryChart, { props: { spec: BARS } })
    expect(w.get('[data-testid="chart-copy"]').classes()).toContain('touch-target')
    expect(ruleFor(CHART_PHONE, '.copy-btn')).toContain('min-height: 44px')
    expect(ruleFor(CHART_PHONE, '.axis-note')).toContain('font-size: 14px')
    expect(ruleFor(CHART_PHONE, '.chart-title')).toContain('font-size: 13px')
  })
})
