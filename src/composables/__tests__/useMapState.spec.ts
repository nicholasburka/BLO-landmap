import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/apiBase', () => ({
  internalFetch: vi.fn(),
  setInternalCsrfToken: vi.fn(),
  API_URL: '',
}))

import { useMapState } from '../useMapState'
import {
  DEMOGRAPHIC_LAYERS,
  CONTAMINATION_LAYERS,
  ECONOMIC_LAYERS,
} from '@/config/layerConfig'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import {
  registerInternalLayers,
  unregisterInternalLayers,
  type InternalLayerManifestEntry,
} from '@/lib/internalLayers'

/**
 * P6-10. Two maps can be alive in one session now — the public map, the chat
 * page's pane, and (next) a submap opened inside a page that is showing its
 * own filtered rows. Everything in this file is about the two of them not
 * lying to each other, which is what the module-level state used to do.
 */

const ENTRY: InternalLayerManifestEntry = {
  id: 'internal-target-index',
  slug: 'target-index',
  name: 'Target index',
  geometry: 'county',
  dataType: 'index',
  unit: '',
  direction: 'higher_better',
  range: { min: 0, max: 1 },
  description: 'Where to look first.',
  source: '',
  year: 2026,
  file: null,
  color: null,
  popupFields: [],
  bbox: null,
  updatedAt: '2026-09-23T10:00:00.000Z',
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  unregisterInternalLayers()
})

describe('useMapState — one map, one answer', () => {
  it('gives each instance its own layer definitions, so neither can report the other\'s', () => {
    const a = useMapState()
    const b = useMapState()

    a.toggleDemographicLayer('pct_Black')

    expect(a.layers.demographic.value).toContain('pct_Black')
    expect(b.layers.demographic.value).not.toContain('pct_Black')
    expect(a.layers.definitions.demographic.find(l => l.id === 'pct_Black')?.visible).toBe(true)
    expect(b.layers.definitions.demographic.find(l => l.id === 'pct_Black')?.visible).toBe(false)
  })

  it('never writes `visible` or `status` back onto the shared config arrays', () => {
    const state = useMapState()

    state.toggleEconomicLayer('avg_weekly_wage')
    state.layers.definitions.contamination[0].status = 'loaded'
    state.layers.definitions.contamination[0].visible = true

    expect(ECONOMIC_LAYERS.find(l => l.id === 'avg_weekly_wage')?.visible).toBe(false)
    expect(CONTAMINATION_LAYERS.every(l => l.visible === false)).toBe(true)
    expect(CONTAMINATION_LAYERS.every(l => l.status === undefined)).toBe(true)
    // The BLO default is still the default for the next map to be built.
    expect(DEMOGRAPHIC_LAYERS.find(l => l.id === 'combined_scores_v2')?.visible).toBe(true)
  })

  it('starts on the BLO Livability Index, whichever instance it is', () => {
    const a = useMapState()
    a.toggleDemographicLayer('combined_scores_v2') // a turns it off
    const b = useMapState()

    expect(a.layers.demographic.value).toEqual([])
    expect(b.layers.demographic.value).toEqual(['combined_scores_v2'])
    expect(b.layers.activeName.value).toBe('BLO Livability Index')
  })

  it('holds its internal layer registration under its own name', () => {
    const a = useMapState()
    const b = useMapState()
    registerInternalLayers([ENTRY], a.instanceId)
    registerInternalLayers([ENTRY], b.instanceId)

    // One map going away (a route change, a pane closing) must not take the
    // definition the other is still scoring against.
    a.teardownInternalLayers(false)
    expect(LAYER_REGISTRY['internal-target-index']).toBeDefined()

    b.teardownInternalLayers(false)
    expect(LAYER_REGISTRY['internal-target-index']).toBeUndefined()
  })

  it('tells every canvas drawing it to repaint, and stops when one unsubscribes', () => {
    const state = useMapState()
    const first = vi.fn()
    const second = vi.fn()
    const release = state.onRepaint(first)
    state.onRepaint(second)

    state.toggleHousingLayer('median_home_value')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    release()
    state.toggleHousingLayer('median_home_value')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
  })
})

describe('useMapState — applying a query', () => {
  it('routes layer ids to their categories and sets weights and directions', () => {
    const state = useMapState()
    state.query.apply({
      layers: [
        { layerId: 'pct_Black', weight: 7, direction: 'higher_better' },
        { layerId: 'median_home_value', weight: 3, direction: 'lower_better' },
      ],
      filters: [],
      limit: 5,
      regionStates: ['GA'],
    })

    expect(state.layers.demographic.value).toEqual(['pct_Black'])
    expect(state.layers.housing.value).toEqual(['median_home_value'])
    expect(state.query.weights.value).toEqual({ pct_Black: 7, median_home_value: 3 })
    expect(state.query.limit.value).toBe(5)
    expect(state.query.regionStates.value).toEqual(['GA'])
    expect(state.layers.all.value).toEqual(['pct_Black', 'median_home_value'])
  })

  it('tells "the caller said nothing" apart from "the caller cleared it"', () => {
    const state = useMapState()
    state.query.apply({
      layers: [{ layerId: 'pct_Black', weight: 5 }],
      filters: [{ layerId: 'pct_Black', operator: 'greater_than', value: 20 }],
      limit: 10,
      regionStates: ['GA'],
    })

    // No filters mentioned: the ones on screen stay on screen.
    state.query.apply({ layers: [{ layerId: 'pct_Black', weight: 5 }], limit: 10 })
    expect(state.query.filters.value).toHaveLength(1)
    expect(state.query.regionStates.value).toEqual(['GA'])

    // An empty array is an instruction.
    state.query.apply({ layers: [{ layerId: 'pct_Black', weight: 5 }], filters: [], regionStates: [], limit: null })
    expect(state.query.filters.value).toEqual([])
    expect(state.query.regionStates.value).toEqual([])
    expect(state.query.limit.value).toBeNull()
  })

  it('an empty layer list is a reset, and still honours what came with it', () => {
    const state = useMapState()
    state.toggleDemographicLayer('pct_Black')
    state.query.apply({
      layers: [],
      filters: [{ layerId: 'pct_Black', operator: 'less_than', value: 5 }],
      limit: 3,
      regionStates: ['MS'],
    })

    expect(state.layers.demographic.value).toEqual(['combined_scores_v2'])
    expect(state.query.filters.value).toHaveLength(1)
    expect(state.query.limit.value).toBe(3)
    expect(state.query.regionStates.value).toEqual(['MS'])
  })

  it('tells the host when a query was applied, and what it was', () => {
    const state = useMapState()
    const applied: unknown[] = []
    state.onQueryApplied(input => applied.push(input))

    state.query.apply({ layers: [{ layerId: 'pct_Black', weight: 5 }], filters: [], limit: null, regionStates: [] })
    expect(applied).toHaveLength(1)

    state.query.apply({ layers: [], filters: [], limit: null, regionStates: [] })
    expect(applied).toHaveLength(2)
  })
})

describe('useMapState — a page\'s own filtered rows (P6-10)', () => {
  it('takes an explicit subset as the answer, with or without a scoring query', () => {
    const state = useMapState({ layers: ['pct_Black'], only: ['13121', '13089'] })

    expect(state.layers.demographic.value).toEqual(['pct_Black'])
    expect(state.query.only.value).toEqual(['13121', '13089'])
    // A subset is the answer whether or not a limit was set, which is what a
    // page handing over its filtered rows needs: dim everything else.
    expect([...state.query.topNGeoIds.value]).toEqual(['13121', '13089'])
  })

  it('needs no limit and no scoring to frame a subset', () => {
    const state = useMapState({ only: ['01001'] })
    expect(state.query.limit.value).toBeNull()
    expect([...state.query.topNGeoIds.value]).toEqual(['01001'])
  })

  it('leaves the public map exactly as it was: no subset, no dimming', () => {
    const state = useMapState()
    expect(state.query.only.value).toBeNull()
    expect(state.query.topNGeoIds.value.size).toBe(0)

    // …and a limit alone still needs a scoring query, as before.
    state.query.limit.value = 5
    expect(state.query.topNGeoIds.value.size).toBe(0)
  })

  it('clears the subset on a reset', () => {
    const state = useMapState({ only: ['01001'] })
    state.resetQueryScoring()
    expect(state.query.only.value).toBeNull()
  })
})
