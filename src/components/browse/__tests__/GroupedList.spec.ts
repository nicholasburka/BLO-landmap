import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { h } from 'vue'
import GroupedList from '../GroupedList.vue'
import { groupRows, type GroupKey } from '@/lib/browse'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

interface Row {
  id: string
  title: string
  organization: string
  organizationLabel: string
}

const row = (id: string, organization: string, organizationLabel = organization): Row => ({
  id,
  title: `Row ${id}`,
  organization,
  organizationLabel,
})

const byOrganization = (r: Row): GroupKey => ({ id: r.organization, label: r.organizationLabel || 'No organization' })

// `mount` cannot infer the component's generic from a props object, so the
// row type is asserted once here rather than at every call site.
function mountList(rows: Row[]) {
  return mount(GroupedList, {
    props: {
      groups: groupRows(rows, byOrganization),
      noun: 'dataset',
      nounPlural: 'datasets',
      rowKey: (row: unknown) => (row as Row).id,
    },
    slots: { row: (({ row }: { row: unknown }) => h('span', { class: 'row-title' }, (row as Row).title)) as never },
  })
}

const ROWS = [row('1', 'epa', 'US EPA'), row('2', 'epa', 'US EPA'), row('3', 'usgs', 'USGS'), row('4', '')]

describe('GroupedList (P6-3)', () => {
  it('heads each group with its name and count, in the order it was given', () => {
    const w = mountList(ROWS)
    expect(w.findAll('[data-testid="group-label"]').map(g => g.text())).toEqual(['US EPA', 'USGS', 'No organization'])
    expect(w.findAll('[data-testid="group-count"]').map(g => g.text())).toEqual([
      '· 2 datasets',
      '· 1 dataset',
      '· 1 dataset',
    ])
  })

  it('renders every row through the slot', () => {
    const w = mountList(ROWS)
    expect(w.findAll('.row-title').map(r => r.text())).toEqual(['Row 1', 'Row 2', 'Row 3', 'Row 4'])
  })

  it('opens every group to begin with, and folds one away when its head is pressed', async () => {
    const w = mountList(ROWS)
    const epa = w.get('[data-group="epa"]')
    expect(epa.attributes('aria-expanded')).toBe('true')
    await epa.trigger('click')
    expect(w.get('[data-group="epa"]').attributes('aria-expanded')).toBe('false')
    expect(w.findAll('.row-title').map(r => r.text())).toEqual(['Row 3', 'Row 4'])
    await w.get('[data-group="epa"]').trigger('click')
    expect(w.findAll('.row-title')).toHaveLength(4)
  })

  it('draws nothing at all for no groups', () => {
    const w = mountList([])
    expect(w.findAll('[data-testid="browse-group"]')).toHaveLength(0)
  })

  it('has the phone rules the P5-60 pass asks for', () => {
    const phone = mediaBlock(readStyles('src/components/browse/GroupedList.vue'), 640)
    expect(ruleFor(phone, '.group-toggle')).toContain('min-height: 44px')
  })
})
