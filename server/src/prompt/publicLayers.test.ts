import { describe, it, expect } from 'vitest'
import layers from './publicLayers.generated.json' with { type: 'json' }

/**
 * P5-45: the server's copy of the public map layer registry. It is generated
 * (`npm run export:layers` at the repo root) and committed, because the
 * server has no way to read the client's TypeScript registry at runtime —
 * and a hand-maintained second copy would drift within a week.
 *
 * The client half of this contract is src/lib/__tests__/publicLayers.spec.ts,
 * which fails when the export is stale.
 */
describe('publicLayers.generated.json', () => {
  it('describes every layer well enough to answer a question about it', () => {
    expect(layers.length).toBeGreaterThan(5)
    for (const layer of layers) {
      expect(layer.id, JSON.stringify(layer)).toMatch(/^[A-Za-z0-9_]+$/)
      expect(layer.name.trim().length).toBeGreaterThan(0)
      expect(layer.description.trim().length).toBeGreaterThan(0)
      expect(layer.category.trim().length).toBeGreaterThan(0)
      expect(layer).toHaveProperty('source')
      expect(layer).toHaveProperty('year')
      expect(layer).toHaveProperty('unit')
      expect(layer).toHaveProperty('direction')
      expect(layer.range.max).toBeGreaterThan(layer.range.min)
    }
  })

  it('holds no internal layers — internal material is served from the library, never from a file in the repo', () => {
    for (const layer of layers) {
      expect(layer.category).not.toBe('internal')
      expect(layer.id.startsWith('internal-')).toBe(false)
    }
  })

  it('has one entry per id', () => {
    const ids = layers.map(l => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
