import { describe, it, expect } from 'vitest'
import { mount, RouterLinkStub } from '@vue/test-utils'
import ChatResultTable from '../ChatResultTable.vue'

/**
 * P14-5 — the rows behind a tool line.
 *
 * `query_dataset` returning 412 rows rendered as "Queried the organizations
 * table · 412 rows": the model read the sample and the reader got a number.
 * Collapsed by default on purpose — a transcript is a conversation, and a
 * table is a detour the reader should choose rather than be handed.
 */
const mountIt = (result: Record<string, unknown>) =>
  mount(ChatResultTable, {
    props: { result },
    global: { stubs: { RouterLink: RouterLinkStub } },
  })

const RESULT = {
  columns: ['Name', 'HQ State'],
  rows: [
    { Name: 'Land Loss Prevention Project', 'HQ State': 'NC' },
    { Name: 'Federation of Southern Cooperatives', 'HQ State': 'GA' },
  ],
  total: 412,
  href: '/library/organizations/data',
}

describe('ChatResultTable (P14-5)', () => {
  it('stays shut until it is asked for', () => {
    const w = mountIt(RESULT)
    expect(w.find('[data-testid="chat-result-rows"]').exists()).toBe(false)
    expect(w.get('[data-testid="chat-result-toggle"]').text()).toBe('Show 2 rows')
  })

  it('renders the rows, in the columns the server sent', async () => {
    const w = mountIt(RESULT)
    await w.get('[data-testid="chat-result-toggle"]').trigger('click')
    expect(w.findAll('th').map(h => h.text())).toEqual(['Name', 'HQ State'])
    expect(w.findAll('tbody tr')).toHaveLength(2)
    expect(w.get('tbody tr').text()).toContain('Land Loss Prevention Project')
  })

  it('says how much of the match it is showing', () => {
    expect(mountIt(RESULT).get('[data-testid="chat-result-count"]').text()).toBe('showing 2 of 412')
  })

  it('says nothing about the count when it is showing all of them', () => {
    expect(mountIt({ ...RESULT, total: 2 }).find('[data-testid="chat-result-count"]').exists()).toBe(false)
  })

  it('offers the table explorer, where sorting and filtering live', () => {
    expect(mountIt(RESULT).getComponent(RouterLinkStub).props('to')).toBe('/library/organizations/data')
  })

  it('renders an empty cell as a dash rather than a gap', async () => {
    const w = mountIt({ columns: ['a', 'b'], rows: [{ a: '', b: null }], total: 1 })
    await w.get('[data-testid="chat-result-toggle"]').trigger('click')
    expect(w.findAll('td').map(c => c.text())).toEqual(['—', '—'])
  })

  it('renders nothing at all with no rows', () => {
    expect(mountIt({ columns: ['a'], rows: [], total: 0 }).find('[data-testid="chat-result"]').exists()).toBe(false)
  })
})
