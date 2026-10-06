import { describe, it, expect, beforeEach } from 'vitest'

/**
 * County values for a public map layer, read server-side (P7-8).
 *
 * Against the **real files in `public/datasets/`**, deliberately: the point of
 * this module is that the registry's own numbers can be a term in a saved
 * index, and a fixture CSV would prove only that the parser works. These are
 * the files the public map paints, so if a layer's `valueColumn` ever stops
 * matching its file this suite says so — which is the same guarantee
 * `publicLayers.spec.ts` gives for the registry's shape.
 */

const {
  clearPublicLayerCache,
  isPublicLayerId,
  publicLayerBytes,
  publicLayerKeys,
  publicLayerRecord,
  readPublicCountyLayer,
} = await import('./publicLayerValues.js')

beforeEach(() => {
  clearPublicLayerCache()
})

describe('identifying a public layer', () => {
  it('knows the registry’s own ids, and nothing else', () => {
    expect(isPublicLayerId('pct_Black')).toBe(true)
    expect(isPublicLayerId('poverty_by_race')).toBe(true)
    // An internal layer is not one of these, which is what lets the composite
    // service route a term by its id alone.
    expect(isPublicLayerId('internal-votes')).toBe(false)
    expect(isPublicLayerId('nonsense')).toBe(false)
    expect(publicLayerRecord('nonsense')).toBeNull()
  })

  it('names the file and column it reads, and NOT the range or direction', () => {
    const keys = publicLayerKeys('pct_Black')
    expect(keys).toContain('/datasets/demographics/')
    expect(keys).toContain('pct_nhBlack')
    // The index normalises against the data's own min and max and carries its
    // own directions, so neither can move a stored number — and folding them
    // in would mark an index stale when somebody edited a legend.
    expect(keys).not.toContain('higher_better')
    expect(keys).not.toContain('100')
    expect(publicLayerKeys('nonsense')).toBe('')
  })
})

describe('reading the values', () => {
  it('reads every county, not the 200 a place lookup needs', async () => {
    const layer = await readPublicCountyLayer('pct_Black')
    expect(layer.id).toBe('pct_Black')
    expect(layer.name).toBeTruthy()
    // An index normalises against the whole column, so `county_values`'s
    // 200-county cap is the wrong shape for this.
    expect(layer.count).toBeGreaterThan(3000)
    expect(Object.keys(layer.values).every(k => /^\d{5}$/.test(k))).toBe(true)
    expect(layer.bytes).toBeGreaterThan(0)
    expect(layer.content).toMatch(/^[0-9a-f]{16}$/)
  })

  it('drops a cell that is not a number rather than coercing it', async () => {
    const layer = await readPublicCountyLayer('poverty_by_race')
    for (const value of Object.values(layer.values)) {
      expect(typeof value).toBe('number')
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('reads a JSON-keyed layer as well as a CSV one', async () => {
    // `contamination` ships as a JSON file keyed by GEOID with object records,
    // which is a different parser entirely.
    const layer = await readPublicCountyLayer('contamination')
    expect(layer.count).toBeGreaterThan(100)
  })

  it('refuses an id that is not a public layer, by name', async () => {
    await expect(readPublicCountyLayer('internal-votes')).rejects.toThrow(
      '“internal-votes” is not a public map layer.',
    )
  })

  it('is the same answer twice, and the second costs no read', async () => {
    const first = await readPublicCountyLayer('pct_Black')
    const second = await readPublicCountyLayer('pct_Black')
    expect(second.content).toBe(first.content)
    expect(second.bytes).toBe(first.bytes)
  })
})

describe('the size, without a read', () => {
  it('answers from the filesystem, which is what makes the ceiling pre-flight', async () => {
    // Nothing cached: this has to be a `stat`, not a parse. The composite's
    // byte budget is checked before any term is opened, so a refusal costs
    // nothing — the one way it improves on the proximity ceiling, which could
    // only count vertices after the layer had been read.
    const bytes = await publicLayerBytes('pct_Black')
    expect(bytes).toBeGreaterThan(0)
    const layer = await readPublicCountyLayer('pct_Black')
    expect(bytes).toBe(layer.bytes)
  })

  it('says null for a layer it cannot size, rather than guessing at one', async () => {
    expect(await publicLayerBytes('nonsense')).toBeNull()
  })
})
