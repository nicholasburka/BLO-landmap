import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MapAddressSearch from '../MapAddressSearch.vue'
import { clearAddressCache } from '@/lib/addressSearch'

/**
 * The address box over a set's map (P9-11).
 *
 * The point of it is the half below the input: a map search moves the map,
 * and this one has to say what THIS SET holds where you landed. The county
 * comes from the host, because that is the set's business.
 */

const HIT = { place_name: '3231 Paul R Lowry Rd, Memphis, Tennessee', center: [-90.1, 35.07] }

interface Resolved {
  geoId: string | null
  countyLabel: string
  values: { id: string; name: string; value: number | null }[]
}

function resolver(over: Partial<Resolved> = {}) {
  return (): Resolved => ({
    geoId: '47157',
    countyLabel: 'Shelby County, TN',
    values: [
      { id: 'pov', name: 'Poverty rate', value: 23.6 },
      { id: 'gap', name: 'A layer with no number here', value: null },
    ],
    ...over,
  })
}

beforeEach(() => {
  clearAddressCache()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ features: [HIT] }) }) as unknown as Response),
  )
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function type(w: ReturnType<typeof mount>, text: string) {
  await w.get('[data-testid="address-input"]').setValue(text)
  vi.advanceTimersByTime(500)
  await flushPromises()
}

describe('the address box', () => {
  it('waits for a real query before asking anyone', async () => {
    const w = mount(MapAddressSearch, { props: { resolve: resolver() } })
    await type(w, '32')
    expect(fetch).not.toHaveBeenCalled()
    expect(w.find('[data-testid="address-hits"]').exists()).toBe(false)
  })

  it('suggests, and says what the set holds where you land', async () => {
    const w = mount(MapAddressSearch, { props: { resolve: resolver() } })
    await type(w, '3231 Paul R Lowry')
    expect(w.findAll('[data-testid="address-hit"]').map(h => h.text())).toEqual([HIT.place_name])

    await w.get('[data-testid="address-hit"]').trigger('click')
    expect(w.get('[data-testid="address-county"]').text()).toBe('Shelby County, TN')
    const values = w.get('[data-testid="address-values"]').text()
    expect(values).toContain('Poverty rate')
    expect(values).toContain('23.6')
    // A layer with nothing here says so rather than showing a blank cell.
    expect(values).toContain('no number here')
    // And the host is told where to fly.
    expect(w.emitted('found')?.[0]).toEqual([{ center: [-90.1, 35.07], geoId: '47157' }])
  })

  it('says plainly when a point is outside every county it draws', async () => {
    const w = mount(MapAddressSearch, {
      props: { resolve: resolver({ geoId: null, countyLabel: '', values: [] }) },
    })
    await type(w, 'somewhere at sea')
    await w.get('[data-testid="address-hit"]').trigger('click')
    expect(w.find('[data-testid="address-no-county"]').exists()).toBe(true)
    expect(w.find('[data-testid="address-values"]').exists()).toBe(false)
  })

  it('throws the result away on Clear, and tells the host to as well', async () => {
    const w = mount(MapAddressSearch, { props: { resolve: resolver() } })
    await type(w, '3231 Paul R Lowry')
    await w.get('[data-testid="address-hit"]').trigger('click')
    await w.get('[data-testid="address-clear"]').trigger('click')
    expect(w.find('[data-testid="address-found"]').exists()).toBe(false)
    expect(w.emitted('cleared')).toHaveLength(1)
  })

  it('says when it found nothing, rather than sitting silent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }) as unknown as Response),
    )
    const w = mount(MapAddressSearch, { props: { resolve: resolver() } })
    await type(w, 'not a place at all')
    expect(w.get('[data-testid="address-none"]').text()).toContain('Nothing found')
  })

  it('is drivable from the keyboard', async () => {
    const w = mount(MapAddressSearch, { props: { resolve: resolver() } })
    await type(w, '3231 Paul R Lowry')
    await w.get('[data-testid="address-input"]').trigger('keydown.enter')
    expect(w.emitted('found')).toHaveLength(1)
  })
})
