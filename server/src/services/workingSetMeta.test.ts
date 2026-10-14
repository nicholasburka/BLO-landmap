import { describe, it, expect } from 'vitest'
import { readWorkingSet, workingSetManifest, describeWorkingSet } from './workingSetMeta.js'

/**
 * The working-set manifest, read and written.
 *
 * This module is pure — no imports, no storage — so it takes no harness. It
 * had no test file before P11-1 added `framing` to it; the round-trip cases
 * below cover the new field and pin the tolerance rules the older fields
 * already relied on.
 */

const BASE = {
  title: 'Redevelopment dashboard',
  purpose: 'Where development is being pushed, and who absorbs it.',
  datasets: ['redevelopment-sites', 'cejst-county-burden'],
  layers: ['internal-redevelopment-sites', 'internal-cejst-county-burden'],
  sites: 'redevelopment-sites',
  savedBy: 'nick',
  savedById: 1,
  savedAt: '2026-10-13T00:00:00.000Z',
}

const FRAMING = {
  layers: [{ layerId: 'pct_Black', weight: 5, direction: 'higher_better' }],
  filters: [],
  limit: null,
  regionStates: ['MS'],
  viewport: { center: [-90.1, 32.3], zoom: 6 },
}

describe('a set carries its own framing (P11-1)', () => {
  it('round-trips a framing through read and write', () => {
    const doc = readWorkingSet({ ...BASE, framing: FRAMING }, 'redevelopment-dashboard')
    expect(doc.framing).toEqual(FRAMING)
    expect(workingSetManifest(doc).framing).toEqual(FRAMING)
  })

  it('treats an absent framing as absent, not as an empty one', () => {
    // The stated-absence rule `derived` already follows: a set written before
    // P11-1 must round-trip byte-identical, so the key cannot appear.
    const doc = readWorkingSet(BASE, 'redevelopment-dashboard')
    expect(doc.framing).toBeUndefined()
    expect('framing' in workingSetManifest(doc)).toBe(false)
  })

  it('drops a framing that is not an object rather than refusing the set', () => {
    // `readWorkingSet` is deliberately tolerant — a hand-edited manifest has
    // to keep opening. The ROUTE is where a bad framing gets refused with
    // something a person can act on.
    for (const bad of ['a string', 42, [], null, true]) {
      const doc = readWorkingSet({ ...BASE, framing: bad }, 'x')
      expect(doc.framing, `framing: ${JSON.stringify(bad)}`).toBeUndefined()
    }
  })

  it('preserves a framing verbatim, including keys it does not know', () => {
    // Same contract as `derived`: this module stores, it does not interpret.
    // A field added by a later phase must survive a read/write cycle.
    const odd = { ...FRAMING, somethingLater: { nested: true } }
    const doc = readWorkingSet({ ...BASE, framing: odd }, 'x')
    expect(workingSetManifest(doc).framing).toEqual(odd)
  })

  it('leaves the description alone — a framing is not a member', () => {
    const without = describeWorkingSet(readWorkingSet(BASE, 'x'))
    const with_ = describeWorkingSet(readWorkingSet({ ...BASE, framing: FRAMING }, 'x'))
    expect(with_).toBe(without)
  })
})

describe('the fields P11-1 had to not break', () => {
  it('still puts the anchor back when a manifest drops it from datasets', () => {
    const doc = readWorkingSet({ ...BASE, datasets: ['cejst-county-burden'] }, 'x')
    expect(doc.datasets[0]).toBe('redevelopment-sites')
  })

  it('still preserves derived verbatim', () => {
    const derived = [{ id: 'livability', analysis: { type: 'composite' } }]
    const doc = readWorkingSet({ ...BASE, derived }, 'x')
    expect(workingSetManifest(doc).derived).toEqual(derived)
  })
})
