import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import type { CountyValueRow } from '@/lib/publicLayers'

// P5-55: the shortlist column is internal-only, so the session is the switch.
const internalUser = ref<{ username: string; role: 'internal' } | null>(null)
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser }),
  registerLogoutHook: vi.fn(),
}))

import { MAX_COMPARE_COUNTIES, clearShortlist, shortlist } from '@/lib/compare'
import CountyTable from '../CountyTable.vue'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

const layer = LAYER_REGISTRY.median_home_value

const row = (geoId: string, county: string, state: string, value: number | null): CountyValueRow => ({
  geoId,
  county,
  state,
  value,
  display: value == null ? '—' : layer.formatValue(value),
})

const ROWS: CountyValueRow[] = [
  row('01001', 'Autauga County', 'Alabama', 150000),
  row('13121', 'Fulton County', 'Georgia', 380000),
  row('36061', 'New York County', 'New York', 900000),
  row('48001', 'Anderson County', 'Texas', 90000),
]

function mountTable(props: Record<string, unknown> = {}) {
  return mount(CountyTable, { props: { layer, rows: ROWS, loading: false, ...props } })
}

const rowText = (w: ReturnType<typeof mountTable>) => w.findAll('[data-testid="county-row"]').map(r => r.text())

/** jsdom's Blob has no `.text()`; FileReader is how you read one there. */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

describe('CountyTable (P5-45)', () => {
  it('shows every county with its value, sorted by county name to start', () => {
    const w = mountTable()
    const rows = rowText(w)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('Anderson County')
    expect(rows[0]).toContain('$90,000')
    expect(rows[3]).toContain('New York County')
    expect(w.get('[data-testid="county-showing"]').text()).toContain('4 counties')
  })

  it('names the value column after the layer', () => {
    expect(mountTable().get('[data-testid="sort-value"]').text()).toContain('Median Home Value')
  })

  it('searches by county and state name', async () => {
    const w = mountTable()
    await w.get('[data-testid="county-search"]').setValue('georgia')
    expect(rowText(w)).toHaveLength(1)
    expect(rowText(w)[0]).toContain('Fulton County')
    expect(w.get('[data-testid="county-showing"]').text()).toContain('1 of 4 counties')
    await w.get('[data-testid="county-search"]').setValue('zzz')
    expect(w.get('[data-testid="county-empty"]').text()).toContain('No county matches')
  })

  it('sorts by value both ways, and back to county name', async () => {
    const w = mountTable()
    await w.get('[data-testid="sort-value"]').trigger('click')
    expect(rowText(w)[0]).toContain('Anderson County') // lowest value first
    await w.get('[data-testid="sort-value"]').trigger('click')
    expect(rowText(w)[0]).toContain('New York County') // highest first
    await w.get('[data-testid="sort-name"]').trigger('click')
    expect(rowText(w)[0]).toContain('Anderson County')
  })

  it('pages, and a new search goes back to page one', async () => {
    const w = mountTable({ pageSize: 2 })
    expect(rowText(w)).toHaveLength(2)
    expect(w.get('[data-testid="county-page"]').text()).toContain('Page 1 of 2')
    await w.get('[data-testid="county-next"]').trigger('click')
    expect(rowText(w)[0]).toContain('Fulton County')
    await w.get('[data-testid="county-search"]').setValue('county')
    expect(w.get('[data-testid="county-page"]').text()).toContain('Page 1 of 2')
    expect(rowText(w)[0]).toContain('Anderson County')
  })

  it('shows skeleton rows while the data loads, and an error instead of an empty table', () => {
    const loadingTable = mount(CountyTable, { props: { layer, rows: [], loading: true } })
    expect(loadingTable.findAll('[data-testid="county-skeleton"]').length).toBeGreaterThan(0)
    const failed = mount(CountyTable, { props: { layer, rows: [], loading: false, error: 'network down' } })
    expect(failed.get('[data-testid="county-error"]').text()).toContain('network down')
  })

  describe('Download as CSV', () => {
    const created: Blob[] = []
    let clicked = 0

    beforeEach(() => {
      created.length = 0
      clicked = 0
      // jsdom has no object URLs and no real downloads — stub both so the
      // wiring (what goes in the file, what it is called) is still testable.
      ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
        created.push(b)
        return 'blob:county-table'
      }
      ;(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {}
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicked++
        expect(this.download).toBe('median_home_value-by-county.csv')
      })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('downloads exactly the rows the search left on screen', async () => {
      const w = mountTable()
      await w.get('[data-testid="county-search"]').setValue('georgia')
      await w.get('[data-testid="county-download"]').trigger('click')
      expect(clicked).toBe(1)
      expect(created).toHaveLength(1)
      expect(created[0].type).toContain('text/csv')
      expect(await readBlob(created[0])).toBe('GEOID,County,State,median_home_value\n13121,Fulton County,Georgia,380000')
    })
  })
})


describe('CountyTable — add to shortlist (P5-55)', () => {
  beforeEach(() => {
    localStorage.clear()
    clearShortlist()
    internalUser.value = null
  })

  it('shows nothing about shortlists to a logged-out visitor', () => {
    const w = mountTable()
    expect(w.findAll('[data-testid="county-shortlist"]')).toHaveLength(0)
    expect(w.text()).not.toContain('Add to shortlist')
  })

  it('offers one button per row once someone is signed in', () => {
    internalUser.value = { username: 'maria', role: 'internal' }
    const w = mountTable()
    expect(w.findAll('[data-testid="county-shortlist"]')).toHaveLength(4)
  })

  it('adds the county GEOID to the shared shortlist and says so', async () => {
    internalUser.value = { username: 'maria', role: 'internal' }
    const w = mountTable()
    // Rows start sorted by name: Anderson County, Texas is first.
    const button = w.findAll('[data-testid="county-shortlist"]')[0]
    expect(button.text()).toBe('Add to shortlist')
    await button.trigger('click')
    expect(shortlist.value).toEqual(['48001'])
    expect(w.findAll('[data-testid="county-shortlist"]')[0].text()).toBe('On shortlist')
    expect(w.findAll('[data-testid="county-shortlist"]')[0].attributes('disabled')).toBeDefined()
  })

  it('stops offering more once the comparison is full, and says why', async () => {
    internalUser.value = { username: 'maria', role: 'internal' }
    const w = mountTable()
    for (let i = 0; i < MAX_COMPARE_COUNTIES; i++) shortlist.value = [...shortlist.value, String(20000 + i)]
    await w.vm.$nextTick()
    const button = w.findAll('[data-testid="county-shortlist"]')[0]
    expect(button.text()).toBe('Shortlist full')
    expect(button.attributes('title')).toContain('at most 12')
    await button.trigger('click')
    expect(shortlist.value).toHaveLength(MAX_COMPARE_COUNTIES)
  })
})

/**
 * P5-60: 3,000 counties on a 375 px screen. The audit found 19 px sort
 * buttons here. The table scrolls inside its own box with the county name
 * pinned, and sort, paging and "Add to shortlist" are all 44 px.
 */
const TABLE_SFC = readStyles('src/components/CountyTable.vue')
const TABLE_PHONE = mediaBlock(TABLE_SFC, 640)

describe('CountyTable — phone layout (P5-60)', () => {
  it('keeps the table’s width inside its scroll box', () => {
    const scroll = ruleFor(TABLE_SFC, '.table-scroll')
    expect(scroll).toContain('overflow-x: auto')
    expect(scroll).toContain('max-width: 100%')
  })

  it('pins the county name and drops the state column', () => {
    expect(ruleFor(TABLE_PHONE, '.state-col')).toContain('display: none')
    const pinned = ruleFor(TABLE_PHONE, '.data-table th:first-child')
    expect(pinned).toContain('position: sticky')
    expect(pinned).toContain('left: 0')
    expect(pinned).toContain('background: #fff')
  })

  it('makes the header cell the sort control, and the pager tappable', () => {
    expect(ruleFor(TABLE_PHONE, '.data-table thead th')).toContain('height: 44px')
    expect(ruleFor(TABLE_PHONE, '.sort-btn')).toContain('height: 44px')
    expect(ruleFor(TABLE_PHONE, '.tool-btn')).toContain('min-height: 44px')
    expect(ruleFor(TABLE_PHONE, '.page-size')).toContain('min-height: 44px')
    expect(ruleFor(TABLE_PHONE, '.shortlist-btn')).toContain('min-height: 44px')
  })

  it('carries the tap-target class on every control it renders', () => {
    const w = mountTable()
    expect(w.get('[data-testid="sort-name"]').classes()).toContain('touch-target')
    expect(w.get('[data-testid="county-prev"]').classes()).toContain('touch-target')
    expect(w.get('[data-testid="county-download"]').classes()).toContain('touch-target')
  })
})
