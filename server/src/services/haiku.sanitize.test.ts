import { describe, it, expect } from 'vitest'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
const { sanitizeQueryResponse, validLayerIdsFor } = await import('./haiku.js')
const { VALID_LAYER_IDS } = await import('../prompt/systemPrompt.js')

const county = { id: 'internal-target-index', slug: 'target-index', geometry: 'county' as const, name: 'Target', dataType: 'index' as const, unit: '', direction: 'higher_better' as const, range: null, description: '', source: '', year: '', file: null, color: null, popupFields: [], updatedAt: null }
const point = { ...county, id: 'internal-orgs', slug: 'orgs', geometry: 'point' as const }

describe('sanitizeQueryResponse (P5-26)', () => {
  it('drops unknown ids for anonymous sessions but keeps internal county ids for internal ones; point ids never score', () => {
    const parsed = { layers: [{ layerId: 'pct_Black', weight: 5, direction: 'higher_better' }, { layerId: 'internal-target-index', weight: 30, direction: 'lower_better' }, { layerId: 'internal-orgs', weight: 3, direction: 'higher_better' }, { layerId: 'evil', weight: 1 }], filters: [{ layerId: 'internal-target-index', operator: 'greater_than', value: 50 }], limit: 500, explanation: 'x' } as any
    const anon = sanitizeQueryResponse(parsed, VALID_LAYER_IDS)
    expect(anon.layers.map(l => l.layerId)).toEqual(['pct_Black'])
    expect(anon.filters).toBeUndefined()
    const internal = sanitizeQueryResponse(parsed, validLayerIdsFor([county, point]))
    expect(internal.layers.map(l => [l.layerId, l.weight, l.direction])).toEqual([['pct_Black', 5, 'higher_better'], ['internal-target-index', 10, 'lower_better']])
    expect(internal.filters).toEqual([{ layerId: 'internal-target-index', operator: 'greater_than', value: 50 }])
    expect(internal.limit).toBe(50)
  })

  it('validLayerIdsFor never adds point layers and never mutates the public set', () => {
    const ids = validLayerIdsFor([point])
    expect(ids.has('internal-orgs')).toBe(false)
    expect(ids.size).toBe(VALID_LAYER_IDS.size)
    expect(VALID_LAYER_IDS.has('internal-target-index')).toBe(false)
  })
})
