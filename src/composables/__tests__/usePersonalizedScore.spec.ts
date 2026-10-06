import { describe, it, expect, afterEach } from 'vitest'
import { ref } from 'vue'
import { usePersonalizedScore, type DataMaps } from '../usePersonalizedScore'
import { registerInternalLayers, unregisterInternalLayers, applyLayerRange } from '@/lib/internalLayers'
import type { ScoringQuery } from '@/types/mapTypes'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

/** P5-18: an internal layer registered at runtime scores like any public
 *  layer — values come from its own { GEOID → number } map, and its GEOIDs
 *  join the county universe even when no public map is loaded. */
function maps(internal: Record<string, Record<string, number>>, pctBlack: Record<string, number> = {}): DataMaps {
  return {
    diversityData: ref(
      Object.fromEntries(Object.entries(pctBlack).map(([g, v]) => [g, { [LAYER_REGISTRY.pct_Black.dataKey]: v }])) as any,
    ),
    lifeExpectancyData: ref({} as any),
    countyContaminationCounts: {} as any,
    economicData: ref({} as any),
    housingData: ref({} as any),
    equityData: ref({} as any),
    transportationData: ref({} as any),
    internalLayerValues: ref(internal),
  }
}

afterEach(() => unregisterInternalLayers())

describe('usePersonalizedScore with internal layers', () => {
  it('ranks counties by an internal layer alone', () => {
    registerInternalLayers([
      { id: 'internal-t', slug: 't', geometry: 'county', name: 'T', dataType: 'index', unit: '', direction: 'higher_better', range: null, description: '', source: '', year: '', file: null, color: null, popupFields: [], bbox: null, updatedAt: null },
    ])
    applyLayerRange('internal-t', { min: 0, max: 100 })
    const query = ref<ScoringQuery>([{ layerId: 'internal-t', weight: 5, direction: 'higher_better' }])
    const { rankedCounties, scores } = usePersonalizedScore(query, maps({ 'internal-t': { '01001': 10, '01003': 90, '01005': 50 } }))
    expect(rankedCounties.value.map(c => c.geoId)).toEqual(['01003', '01005', '01001'])
    expect(scores.value.get('01003')?.score).toBeGreaterThan(scores.value.get('01001')?.score ?? 0)
  })

  it('respects lower_better and combines with a public layer', () => {
    registerInternalLayers([
      { id: 'internal-t', slug: 't', geometry: 'county', name: 'T', dataType: 'index', unit: '', direction: 'lower_better', range: { min: 0, max: 100 }, description: '', source: '', year: '', file: null, color: null, popupFields: [], bbox: null, updatedAt: null },
    ])
    const query = ref<ScoringQuery>([
      { layerId: 'internal-t', weight: 5, direction: 'lower_better' },
      { layerId: 'pct_Black', weight: 5, direction: 'higher_better' },
    ])
    const { rankedCounties, scores } = usePersonalizedScore(
      query,
      maps({ 'internal-t': { '01001': 10, '01003': 90 } }, { '01001': 40, '01003': 40 }),
    )
    // equal pct_Black → the internal layer decides; lower_better favours 01001
    expect(rankedCounties.value[0].geoId).toBe('01001')
    expect(scores.value.get('01001')?.components.map(c => c.layerId).sort()).toEqual(['internal-t', 'pct_Black'])
  })

  it('reports the internal layer as missing for counties it does not cover', () => {
    registerInternalLayers([
      { id: 'internal-t', slug: 't', geometry: 'county', name: 'T', dataType: 'index', unit: '', direction: 'higher_better', range: { min: 0, max: 100 }, description: '', source: '', year: '', file: null, color: null, popupFields: [], bbox: null, updatedAt: null },
    ])
    const query = ref<ScoringQuery>([{ layerId: 'internal-t', weight: 5, direction: 'higher_better' }])
    const { scores } = usePersonalizedScore(query, maps({ 'internal-t': { '01001': 10 } }, { '01001': 1, '01003': 1 }))
    expect(scores.value.get('01003')?.missingLayers).toEqual(['internal-t'])
    expect(scores.value.get('01003')?.score).toBeNull()
  })

  it('an unregistered internal id contributes nothing (logged-out replay of a saved view)', () => {
    const query = ref<ScoringQuery>([{ layerId: 'internal-ghost', weight: 5, direction: 'higher_better' }])
    const { rankedCounties } = usePersonalizedScore(query, maps({}, { '01001': 1 }))
    expect(rankedCounties.value).toEqual([])
  })
})
