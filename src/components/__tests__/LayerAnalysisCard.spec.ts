import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LayerAnalysisCard from '../LayerAnalysisCard.vue'

/**
 * The free analyses, as a reader meets them (P9-7).
 *
 * The maths is `lib/layerStats`; this is about what reaches the screen — in
 * particular the two rules §E sets: a correlation is never a bare r, and
 * nothing anywhere says where the work ran or what it cost.
 */

const CHOICES = [
  { id: 'poverty', name: 'Poverty rate' },
  { id: 'income', name: 'Median income' },
  { id: 'flat', name: 'A flat layer' },
]

const DATA: Record<string, Record<string, number>> = {
  poverty: {},
  income: {},
  flat: {},
}
for (let i = 1; i <= 40; i++) {
  DATA.poverty[`c${i}`] = i
  DATA.income[`c${i}`] = 100 - i
  DATA.flat[`c${i}`] = 7
}

function mountCard(over: Partial<Record<string, unknown>> = {}) {
  return mount(LayerAnalysisCard, {
    props: {
      choices: CHOICES,
      valuesFor: (id: string) => ({ values: DATA[id] ?? {} }),
      universe: Object.keys(DATA.poverty),
      ...over,
    },
  })
}

describe('the free analyses', () => {
  it('describes the first layer without being asked', () => {
    const w = mountCard()
    expect(w.get('[data-testid="analysis-coverage"]').text()).toContain('40 counties')
    expect(w.get('[data-testid="analysis-spread"]').text()).toContain('The middle one is')
    expect(w.find('[data-testid="analysis-ends"]').exists()).toBe(true)
  })

  it('never says where it ran or what it cost', () => {
    // §E, and Nick's correction that made it a rule: it is product and
    // architecture leaking onto the screen. A person presses a button and
    // gets the answer.
    const text = mountCard().text().toLowerCase()
    for (const leak of ['cost', 'free', 'server', 'browser', 'in your browser', 'no request', 'cheap']) {
      expect(text, leak).not.toContain(leak)
    }
  })

  it('will not offer to correlate a layer with itself', () => {
    const w = mountCard()
    const against = w.get('[data-testid="analysis-against"]')
    const offered = against.findAll('option').map(o => o.text())
    expect(offered).not.toContain('Poverty rate')
    expect(offered).toContain('Median income')
  })

  it('shows the count and the scatter with the number, never r alone', async () => {
    const w = mountCard()
    await w.get('[data-testid="analysis-against"]').setValue('income')
    const verdict = w.get('[data-testid="analysis-correlation-verdict"]').text()
    expect(verdict).toContain('-1.00')
    expect(verdict).toContain('40 counties')
    // One mark per shared county: the shape is part of the claim.
    expect(w.get('[data-testid="analysis-scatter"]').findAll('circle')).toHaveLength(40)
  })

  it('refuses a correlation against a flat layer instead of calling it zero', async () => {
    const w = mountCard()
    await w.get('[data-testid="analysis-against"]').setValue('flat')
    expect(w.find('[data-testid="analysis-correlation-verdict"]').exists()).toBe(false)
    expect(w.get('[data-testid="analysis-correlation-note"]').text()).toMatch(/same value/i)
  })

  it('counts a tie rather than letting five names imply a ranking', async () => {
    const tied: Record<string, number> = {}
    for (let i = 0; i < 30; i++) tied[`t${i}`] = 100
    for (let i = 0; i < 20; i++) tied[`m${i}`] = i
    const w = mountCard({
      choices: [{ id: 'capped', name: 'Capped rate' }],
      valuesFor: () => ({ values: tied }),
      universe: Object.keys(tied),
    })
    expect(w.get('[data-testid="analysis-tie-top"]').text()).toBe('30 counties are tied at 100.')
  })

  it('says so plainly when a layer has no numbers here', () => {
    const w = mountCard({ choices: [{ id: 'empty', name: 'Nothing yet' }], valuesFor: () => ({ values: {} }) })
    expect(w.get('[data-testid="analysis-empty"]').text()).toContain('no numbers on this map yet')
    expect(w.find('[data-testid="analysis-spread"]').exists()).toBe(false)
  })

  it('is not there at all for a set with no county layers', () => {
    expect(mountCard({ choices: [] }).find('[data-testid="layer-analysis"]').exists()).toBe(false)
  })

  it('says what the host did to get the numbers, beside them', () => {
    // A point-in-county rollup's unplaced points belong next to its counts,
    // not nowhere (P6-23). The host returns the sentence with the values, in
    // one call — an earlier draft had it write the note into a ref from
    // inside this getter, which is a reactive write during a computed and
    // hung the page.
    const w = mountCard({
      choices: [{ id: 'sites', name: 'Sites — counted by county' }],
      valuesFor: () => ({ values: { a: 2, b: 1, c: 1 }, note: '4 points in 3 counties · 1 point fell in no county' }),
      universe: ['a', 'b', 'c'],
    })
    expect(w.get('[data-testid="analysis-note"]').text()).toBe('4 points in 3 counties · 1 point fell in no county')
  })
})
