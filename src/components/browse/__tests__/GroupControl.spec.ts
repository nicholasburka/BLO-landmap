import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GroupControl from '../GroupControl.vue'

const OPTIONS = [
  { id: 'organization', label: 'Organization' },
  { id: 'topic', label: 'Topic' },
  { id: 'type', label: 'Type' },
]

function mountControl(modelValue = 'organization') {
  return mount(GroupControl, { props: { modelValue, options: OPTIONS, label: 'Group the datasets by' } })
}

describe('GroupControl (P6-3)', () => {
  it('offers every grouping and marks the one in use', () => {
    const w = mountControl()
    expect(w.findAll('.group-btn').map(b => b.text())).toEqual(['Organization', 'Topic', 'Type'])
    expect(w.get('[data-group-by="organization"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-group-by="topic"]').attributes('aria-pressed')).toBe('false')
  })

  it('asks for the grouping that was pressed', async () => {
    const w = mountControl()
    await w.get('[data-group-by="topic"]').trigger('click')
    expect(w.emitted('update:modelValue')).toEqual([['topic']])
  })

  it('says what it is choosing, for a screen reader', () => {
    expect(mountControl().get('[data-testid="group-control"]').attributes('aria-label')).toBe('Group the datasets by')
  })
})
