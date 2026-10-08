import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import IndexWeightEditor from '../IndexWeightEditor.vue'

/**
 * P9-6. The point of the phase: drag a weight, watch the map move, keep the
 * version you like.
 *
 * Scoring runs in the browser — a full 3,144-county, 11-term recompute is
 * ~4ms, a quarter of a 60fps frame — so this emits a scoring query on every
 * change and nothing is fetched or saved until a reader asks.
 */
const TERMS = [
  { layer: 'pct_Black', name: 'Black population', weight: 4, direction: 'higher_better' as const },
  { layer: 'poverty_by_race', name: 'Poverty', weight: 4, direction: 'lower_better' as const },
]

describe('IndexWeightEditor (P9-6)', () => {
  it('lists every term by name, with its weight', () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    const rows = w.findAll('[data-testid="weight-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Black population')
    expect((rows[0].find('input[type=range]').element as HTMLInputElement).value).toBe('4')
  })

  it('emits a scoring query the instant a weight moves — nothing is saved', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    await w.findAll('input[type=range]')[0].setValue('9')

    const emitted = w.emitted('score')
    expect(emitted).toBeTruthy()
    const query = emitted![emitted!.length - 1][0] as { layerId: string; weight: number }[]
    expect(query.find(t => t.layerId === 'pct_Black')?.weight).toBe(9)
    expect(w.emitted('save')).toBeUndefined()
  })

  it('a direction is part of the formula, so changing it rescores too', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    await w.findAll('[data-testid="weight-direction"]')[0].setValue('lower_better')
    const emitted = w.emitted('score')!
    const query = emitted[emitted.length - 1][0] as { layerId: string; direction: string }[]
    expect(query.find(t => t.layerId === 'pct_Black')?.direction).toBe('lower_better')
  })

  /** A term at zero is not in the index — the server refuses a zero weight,
   *  so the editor must not offer one that looks saveable. */
  it('drops a term weighted to zero from the query rather than sending it', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    await w.findAll('input[type=range]')[0].setValue('0')
    const emitted = w.emitted('score')!
    const query = emitted[emitted.length - 1][0] as { layerId: string }[]
    expect(query.map(t => t.layerId)).toEqual(['poverty_by_race'])
  })

  it('will not save an index with fewer than two terms, and says why', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    await w.findAll('input[type=range]')[0].setValue('0')
    await w.get('[data-testid="weight-name"]').setValue('One term')
    expect(w.get('[data-testid="weight-save"]').attributes('disabled')).toBeDefined()
    expect(w.text()).toMatch(/two layers|at least two/i)
  })

  it('saves the formula and the name it was given', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    await w.findAll('input[type=range]')[1].setValue('7')
    await w.get('[data-testid="weight-name"]').setValue('Poverty-led')
    await w.get('[data-testid="weight-save"]').trigger('click')

    const saved = w.emitted('save')!
    expect(saved).toHaveLength(1)
    const payload = saved[0][0] as { label: string; terms: { layer: string; weight: number }[] }
    expect(payload.label).toBe('Poverty-led')
    expect(payload.terms.find(t => t.layer === 'poverty_by_race')?.weight).toBe(7)
  })

  it('needs a name before it will save — an index nobody named cannot be cited', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    expect(w.get('[data-testid="weight-save"]').attributes('disabled')).toBeDefined()
  })

  it('puts the weights back', async () => {
    const w = mount(IndexWeightEditor, { props: { terms: TERMS } })
    await w.findAll('input[type=range]')[0].setValue('9')
    await w.get('[data-testid="weight-reset"]').trigger('click')
    expect((w.findAll('input[type=range]')[0].element as HTMLInputElement).value).toBe('4')
  })
})
