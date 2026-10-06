import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import OrganizationShapeFields from '../OrganizationShapeFields.vue'
import { ORGANIZATIONS } from '@/config/organizations'
import { SHAPES } from '@/config/taxonomy'

describe('OrganizationShapeFields (P6-8a)', () => {
  it('offers every publisher and every shape, with "Not set" first', () => {
    const w = mount(OrganizationShapeFields, { props: { organization: '', shape: '' } })
    const orgOptions = w.get('[data-testid="filing-organization"]').findAll('option')
    expect(orgOptions[0].text()).toBe('Not set')
    expect(orgOptions).toHaveLength(ORGANIZATIONS.length + 1)
    const shapeOptions = w.get('[data-testid="filing-shape"]').findAll('option')
    expect(shapeOptions[0].text()).toBe('Not set')
    expect(shapeOptions.map(o => o.attributes('value'))).toEqual(['', ...SHAPES.map(s => s.id)])
    expect(shapeOptions[1].text()).toBe(SHAPES[0].label)
  })

  it('shows the given values and emits a change per field', async () => {
    const w = mount(OrganizationShapeFields, { props: { organization: 'fema', shape: 'areas' } })
    expect((w.get('[data-testid="filing-organization"]').element as HTMLSelectElement).value).toBe('fema')
    expect((w.get('[data-testid="filing-shape"]').element as HTMLSelectElement).value).toBe('areas')

    await w.get('[data-testid="filing-organization"]').setValue('epa')
    await w.get('[data-testid="filing-shape"]').setValue('')
    expect(w.emitted('update:organization')).toEqual([['epa']])
    expect(w.emitted('update:shape')).toEqual([['']])
  })

  it('disables both selects together', () => {
    const w = mount(OrganizationShapeFields, { props: { organization: '', shape: '', disabled: true } })
    expect(w.get('[data-testid="filing-organization"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid="filing-shape"]').attributes('disabled')).toBeDefined()
  })
})
