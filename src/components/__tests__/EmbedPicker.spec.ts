import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('@/lib/libraryCatalog', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/libraryCatalog')>()
  return { ...actual, fetchCatalog: vi.fn() }
})

import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import EmbedPicker from '../EmbedPicker.vue'

const mockedCatalog = vi.mocked(fetchCatalog)

function entry(slug: string, kind: string, title: string): CatalogEntry {
  return { slug, kind, title, category: '', status: 'published', tags: [], meta: {}, files: [], bytes: 0 }
}

const CATALOG = [
  entry('organizations', 'dataset', 'Organizations'),
  entry('tn-target-counties', 'view', 'TN target counties'),
  entry('land-loss-brief', 'document', 'Land loss brief'),
]

beforeEach(() => {
  mockedCatalog.mockReset()
  mockedCatalog.mockResolvedValue(CATALOG)
})

async function open() {
  const w = mount(EmbedPicker)
  await flushPromises()
  return w
}

function results(w: Awaited<ReturnType<typeof open>>) {
  return w.findAll('[data-testid="embed-result"]')
}

describe('EmbedPicker (P5-49)', () => {
  it('lists entries and saved views with a kind badge each', async () => {
    const w = await open()
    expect(results(w).map(r => r.attributes('data-slug'))).toEqual([
      'organizations',
      'tn-target-counties',
      'land-loss-brief',
    ])
    expect(results(w).map(r => r.get('[data-testid="embed-kind"]').text())).toEqual([
      'dataset',
      'saved view',
      'document',
    ])
  })

  it('emits the embed kind the fence needs: view for saved views, entry for everything else', async () => {
    const w = await open()
    await results(w)[1].trigger('click')
    expect(w.emitted('select')?.[0]).toEqual([{ kind: 'view', slug: 'tn-target-counties' }])

    await results(w)[0].trigger('click')
    expect(w.emitted('select')?.[1]).toEqual([{ kind: 'entry', slug: 'organizations' }])
  })

  it('searches the catalog on submit', async () => {
    const w = await open()
    await w.get('[data-testid="embed-query"]').setValue('land')
    await w.get('[data-testid="embed-search"]').trigger('submit')
    await flushPromises()
    expect(mockedCatalog).toHaveBeenLastCalledWith({ q: 'land' })
  })

  it('debounces typing into one search', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(EmbedPicker)
      await flushPromises()
      mockedCatalog.mockClear()
      const input = w.get('[data-testid="embed-query"]')
      await input.setValue('l')
      await input.setValue('la')
      await input.setValue('land')
      expect(mockedCatalog).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)
      expect(mockedCatalog).toHaveBeenCalledTimes(1)
      expect(mockedCatalog).toHaveBeenCalledWith({ q: 'land' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('says so in plain language when nothing matches', async () => {
    mockedCatalog.mockResolvedValue([])
    const w = await open()
    expect(w.get('[data-testid="embed-empty"]').text()).toMatch(/nothing/i)
    expect(results(w)).toHaveLength(0)
  })

  it('explains a failed search instead of showing an empty list', async () => {
    mockedCatalog.mockRejectedValue(new Error('catalog request failed (500)'))
    const w = await open()
    expect(w.get('[data-testid="embed-error"]').text()).toMatch(/could not|couldn't/i)
  })

  it('closes on the close button and on Escape', async () => {
    const w = await open()
    await w.get('[data-testid="embed-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    await w.get('[data-testid="embed-query"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close')).toHaveLength(2)
  })

  it('ignores an out-of-order response so the newest search wins', async () => {
    let resolveSlow: (v: CatalogEntry[]) => void = () => {}
    mockedCatalog.mockReturnValueOnce(new Promise<CatalogEntry[]>(r => (resolveSlow = r)))
    const w = mount(EmbedPicker)
    await w.get('[data-testid="embed-query"]').setValue('land')
    await w.get('[data-testid="embed-search"]').trigger('submit')
    await flushPromises()
    // The initial (slow) load lands late — it must not replace the search.
    resolveSlow([entry('stale', 'note', 'Stale')])
    await flushPromises()
    expect(results(w).map(r => r.attributes('data-slug'))).not.toContain('stale')
  })
})
