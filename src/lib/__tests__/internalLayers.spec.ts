import { describe, it, expect, vi, beforeEach } from 'vitest'

/** The dissolved outlines, stubbed: the join is what is under test here, not
 *  the dissolve (which `stateGeometry.spec.ts` owns). */
const outlines = vi.hoisted(() => vi.fn())
vi.mock('../stateGeometry', () => ({ stateOutlines: outlines }))

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  // The layer cache empties itself on logout, and a logout clears the CSRF
  // token — so the mock has to offer that too (P5-89). An empty API_URL keeps
  // useAuth's boot hydration off the network entirely.
  setInternalCsrfToken: vi.fn(),
  API_URL: '',
}))

import { internalFetch } from '../apiBase'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import {
  fetchInternalLayerManifest,
  fetchInternalLayerValues,
  fetchInternalLayerFeatures,
  featureLayersFrom,
  clearInternalLayerCache,
  mapHrefForInternalLayer,
  mapHrefForInternalLayerId,
  toLayerDefinition,
  registerInternalLayers,
  unregisterInternalLayers,
  applyLayerRange,
  colorForRegistryValue,
  isInternalLayerId,
  slugFromLayerId,
  sharedManifest,
  type InternalLayerManifestEntry,
} from '../internalLayers'
import { clearInternalSession } from '@/composables/useAuth'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const entry: InternalLayerManifestEntry = {
  id: 'internal-target-index',
  slug: 'target-index',
  geometry: 'county',
  name: 'Target index',
  dataType: 'index',
  unit: '',
  direction: 'higher_better',
  range: null,
  description: 'Where to look first.',
  source: '',
  year: 2026,
  file: null,
  color: null,
  popupFields: [],
  detailFields: [],
  bbox: null,
  updatedAt: null,
}

beforeEach(() => {
  mockedFetch.mockReset()
  clearInternalLayerCache()
  unregisterInternalLayers()
})

describe('ids', () => {
  it('recognises the internal prefix and recovers the slug', () => {
    expect(isInternalLayerId('internal-target-index')).toBe(true)
    expect(isInternalLayerId('poverty_by_race')).toBe(false)
    expect(slugFromLayerId('internal-target-index')).toBe('target-index')
    expect(slugFromLayerId('pct_Black')).toBe('pct_Black')
  })
})

describe('toLayerDefinition', () => {
  it('maps a manifest entry to a registry definition in the internal category', () => {
    const def = toLayerDefinition(entry)
    expect(def).toMatchObject({ id: 'internal-target-index', category: 'internal', dataKey: 'target-index', dataPath: '', source: 'Internal library' })
    expect(def.range).toEqual({ min: 0, max: 1 }) // placeholder until values arrive
    expect(def.gradient.css).toContain('31, 122, 46')
  })

  it('formats values by dataType', () => {
    expect(toLayerDefinition({ ...entry, dataType: 'percentage' }).formatValue(12.345)).toBe('12.3%')
    expect(toLayerDefinition({ ...entry, dataType: 'currency' }).formatValue('1234.6')).toBe('$1,235')
    expect(toLayerDefinition({ ...entry, dataType: 'count' }).formatValue(1500)).toBe('1,500')
    expect(toLayerDefinition({ ...entry, dataType: 'years' }).formatValue(72.25)).toBe('72.3 yrs')
    expect(toLayerDefinition({ ...entry, dataType: 'index', unit: 'pts' }).formatValue(7)).toBe('7 pts')
    expect(toLayerDefinition(entry).formatValue(null)).toBe('?')
    expect(toLayerDefinition(entry).formatValue('abc')).toBe('?')
  })

  it('uses the green→red gradient for lower_better', () => {
    expect(toLayerDefinition({ ...entry, direction: 'lower_better' }).gradient.css).toContain('200, 0, 0')
  })
})

describe('register / unregister', () => {
  it('adds definitions to the live registry, is idempotent, and removes them all on unregister', () => {
    const before = Object.keys(LAYER_REGISTRY).length
    registerInternalLayers([entry, { ...entry, id: 'internal-b', slug: 'b', name: 'B' }])
    expect(Object.keys(LAYER_REGISTRY).length).toBe(before + 2)
    expect(LAYER_REGISTRY['internal-target-index'].name).toBe('Target index')
    registerInternalLayers([entry])
    expect(Object.keys(LAYER_REGISTRY).length).toBe(before + 1)
    unregisterInternalLayers()
    expect(Object.keys(LAYER_REGISTRY).length).toBe(before)
    expect(LAYER_REGISTRY['poverty_by_race']).toBeDefined() // public entries untouched
  })

  /**
   * P6-10. Two maps can live in one page now (the home map and the chat
   * pane), and each registers the manifest for itself. One unmounting must
   * not deregister the definitions the other is still scoring against.
   */
  it('keeps a definition two owners hold until the last one lets go', () => {
    const before = Object.keys(LAYER_REGISTRY).length
    const b = { ...entry, id: 'internal-b', slug: 'b', name: 'B' }

    registerInternalLayers([entry, b], 'canvas-1')
    registerInternalLayers([entry], 'canvas-2')
    expect(Object.keys(LAYER_REGISTRY).length).toBe(before + 2)

    // canvas-1 goes away: its own layer goes, the shared one stays.
    unregisterInternalLayers('canvas-1')
    expect(LAYER_REGISTRY['internal-target-index']).toBeDefined()
    expect(LAYER_REGISTRY['internal-b']).toBeUndefined()

    unregisterInternalLayers('canvas-2')
    expect(Object.keys(LAYER_REGISTRY).length).toBe(before)
  })

  it('leaves another owner alone when one re-registers a shorter manifest', () => {
    const b = { ...entry, id: 'internal-b', slug: 'b', name: 'B' }
    registerInternalLayers([entry, b], 'canvas-1')
    registerInternalLayers([entry, b], 'canvas-2')
    registerInternalLayers([entry], 'canvas-1')
    expect(LAYER_REGISTRY['internal-b']).toBeDefined()
    unregisterInternalLayers('canvas-2')
    expect(LAYER_REGISTRY['internal-b']).toBeUndefined()
    unregisterInternalLayers('canvas-1')
  })

  it('skips non-county geometries (v1)', () => {
    const defs = registerInternalLayers([{ ...entry, geometry: 'point' as any }])
    expect(defs).toEqual([])
  })

  it('applyLayerRange patches a registered definition, ignores junk', () => {
    registerInternalLayers([entry])
    applyLayerRange('internal-target-index', { min: 3, max: 90 })
    expect(LAYER_REGISTRY['internal-target-index'].range).toEqual({ min: 3, max: 90 })
    applyLayerRange('internal-target-index', { min: 5, max: 5 })
    expect(LAYER_REGISTRY['internal-target-index'].range).toEqual({ min: 3, max: 90 })
    applyLayerRange('internal-nope', { min: 0, max: 1 })
  })
})

/** P5-77: one helper behind every "Show on map", so a point layer's link
 *  opens the map on its own points and everything else keeps the plain link. */
describe('mapHrefForInternalLayer', () => {
  const points: InternalLayerManifestEntry = { ...entry, id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', bbox: [-90.31, 34.99, -89.6, 35.35] }

  it('frames a point layer on its own bbox', () => {
    expect(mapHrefForInternalLayer(points)).toBe('/?layers=internal-orgs-hq&fit=bbox%3A-90.31%2C34.99%2C-89.6%2C35.35')
  })

  it('frames a line layer on its corridor too (P7-3)', () => {
    const lines: InternalLayerManifestEntry = { ...entry, id: 'internal-transmission', slug: 'transmission', geometry: 'line', bbox: [-91, 34, -87.6, 36.4] }
    expect(mapHrefForInternalLayer(lines)).toBe('/?layers=internal-transmission&fit=bbox%3A-91%2C34%2C-87.6%2C36.4')
  })

  // P7-9: a state layer's bbox is always null — the outlines are the client's
  // — and the national view is the right frame for "state by state" anyway.
  it('keeps the plain link for a state layer, whose frame is the whole country', () => {
    expect(mapHrefForInternalLayer({ id: 'internal-permits', geometry: 'state', bbox: null }))
      .toBe(mapHrefForInternalLayer({ id: 'internal-permits', geometry: 'county', bbox: null }))
  })

  it('keeps the plain link for a county layer, and for a point layer with no bbox', () => {
    expect(mapHrefForInternalLayer(entry)).toBe('/?layers=internal-target-index')
    expect(mapHrefForInternalLayer({ ...entry, bbox: [-90.31, 34.99, -89.6, 35.35] })).toBe('/?layers=internal-target-index')
    expect(mapHrefForInternalLayer({ ...points, bbox: null })).toBe('/?layers=internal-orgs-hq')
  })

  it('resolves the frame from the shared manifest when only the id is in hand, fetching it once', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ layers: [entry, points] }))
    expect(await mapHrefForInternalLayerId('internal-orgs-hq')).toContain('fit=bbox%3A')
    expect(await mapHrefForInternalLayerId('internal-target-index')).toBe('/?layers=internal-target-index')
    expect(mockedFetch).toHaveBeenCalledTimes(1)
  })

  it('falls back to the plain link for an unknown layer, or when the manifest will not answer', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ layers: [points] }))
    expect(await mapHrefForInternalLayerId('internal-nope')).toBe('/?layers=internal-nope')
    clearInternalLayerCache()
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401))
    expect(await mapHrefForInternalLayerId('internal-orgs-hq')).toBe('/?layers=internal-orgs-hq')
    // the failed manifest is evicted, so the next ask retries and gets the frame
    mockedFetch.mockResolvedValue(jsonResponse({ layers: [points] }))
    expect(await mapHrefForInternalLayerId('internal-orgs-hq')).toContain('fit=bbox%3A')
  })
})

describe('fetchers', () => {
  it('manifest: GET /api/layers/internal → layers array (empty on odd bodies)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ layers: [entry] }))
    expect(await fetchInternalLayerManifest()).toEqual([entry])
    expect(mockedFetch).toHaveBeenCalledWith('/api/layers/internal')
    mockedFetch.mockResolvedValueOnce(jsonResponse({}))
    expect(await fetchInternalLayerManifest()).toEqual([])
    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))
    await expect(fetchInternalLayerManifest()).rejects.toThrow(/401/)
  })

  it('values: cached per slug, failures evicted so the next call retries', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: 'internal-x', slug: 'x', geometry: 'county', values: { '01001': 1 }, count: 1, range: { min: 1, max: 1 } }))
    const a = await fetchInternalLayerValues('x')
    const b = await fetchInternalLayerValues('x')
    expect(a).toBe(b)
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(mockedFetch).toHaveBeenCalledWith('/api/layers/internal/x')

    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
    await expect(fetchInternalLayerValues('gone')).rejects.toThrow(/404/)
    mockedFetch.mockResolvedValueOnce(jsonResponse({ id: 'internal-gone', slug: 'gone', geometry: 'county', values: {}, count: 0, range: null }))
    expect((await fetchInternalLayerValues('gone')).count).toBe(0)
    expect(mockedFetch).toHaveBeenCalledTimes(3)
  })
})

describe('colorForRegistryValue', () => {
  const def = toLayerDefinition({ ...entry, range: { min: 0, max: 100 } })
  it('is transparent for missing values and spans pale→green for higher_better', () => {
    expect(colorForRegistryValue(def, null)).toEqual([0, 0, 0, 0])
    expect(colorForRegistryValue(def, 0)).toEqual([230, 230, 230, 0.85])
    expect(colorForRegistryValue(def, 100)).toEqual([31, 122, 46, 0.85])
    const mid = colorForRegistryValue(def, 50)
    expect(mid[0]).toBeLessThan(230)
    expect(mid[0]).toBeGreaterThan(31)
  })
  it('clamps out-of-range values and flips to green→red for lower_better', () => {
    expect(colorForRegistryValue(def, 500)).toEqual([31, 122, 46, 0.85])
    const low = toLayerDefinition({ ...entry, direction: 'lower_better', range: { min: 0, max: 100 } })
    expect(colorForRegistryValue(low, 100)).toEqual([220, 0, 0, 0.85])
    expect(colorForRegistryValue(low, 0)).toEqual([0, 200, 0, 0.85])
  })
})

describe('overlay layers — points (P5-24), lines (P7-3) and states (P7-9)', () => {
  const point: InternalLayerManifestEntry = { ...entry, id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', name: 'Organizations (HQ)', color: '#ff6b1c', popupFields: ['Tier'] }
  const line: InternalLayerManifestEntry = { ...entry, id: 'internal-transmission', slug: 'transmission', geometry: 'line', name: 'Transmission lines', color: '#2b6cb0', popupFields: ['OWNER'], width: 3 }
  const state: InternalLayerManifestEntry = { ...entry, id: 'internal-permits', slug: 'permits', geometry: 'state', name: 'Permitting by state', color: '#2f855a', popupFields: ['Authority'], detailFields: ['Process'] }

  it('featureLayersFrom picks every non-county geometry, carrying it; registerInternalLayers ignores them all', () => {
    expect(featureLayersFrom([entry, point, line, state])).toEqual([
      { id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', name: 'Organizations (HQ)', description: 'Where to look first.', source: '', color: '#ff6b1c', popupFields: ['Tier'], detailFields: [], width: null },
      { id: 'internal-transmission', slug: 'transmission', geometry: 'line', name: 'Transmission lines', description: 'Where to look first.', source: '', color: '#2b6cb0', popupFields: ['OWNER'], detailFields: [], width: 3 },
      { id: 'internal-permits', slug: 'permits', geometry: 'state', name: 'Permitting by state', description: 'Where to look first.', source: '', color: '#2f855a', popupFields: ['Authority'], detailFields: ['Process'], width: null },
    ])
    // An overlay never scores, whichever geometry it is.
    expect(registerInternalLayers([point, line, state]).map(d => d.id)).toEqual([])
  })

  // A browser holding this bundle can meet a newer server. A geometry it has
  // never heard of is left off the map rather than drawn as a point.
  it('ignores a geometry this bundle does not know how to draw', () => {
    const future = { ...entry, id: 'internal-tracts', slug: 'tracts', geometry: 'tract' as unknown as 'point' }
    expect(featureLayersFrom([future, point]).map(l => l.id)).toEqual(['internal-orgs-hq'])
  })

  it('a manifest from before detailFields existed still reads', () => {
    const old = { ...state } as Record<string, unknown>
    delete old.detailFields
    expect(featureLayersFrom([old as unknown as InternalLayerManifestEntry])[0].detailFields).toEqual([])
  })

  it('fetchInternalLayerFeatures caches per slug, takes a line, and rejects a county body', async () => {
    const body = { id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', type: 'FeatureCollection', features: [], count: 0, skipped: 0, bbox: null }
    mockedFetch.mockResolvedValueOnce(jsonResponse(body))
    expect(await fetchInternalLayerFeatures('orgs-hq')).toEqual(body)
    expect(await fetchInternalLayerFeatures('orgs-hq')).toEqual(body)
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    const lines = { id: 'internal-transmission', slug: 'transmission', geometry: 'line', type: 'FeatureCollection', count: 1, skipped: 0, bbox: null, features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90, 35], [-89, 36]] }, properties: { _label: 'x' } }] }
    mockedFetch.mockResolvedValueOnce(jsonResponse(lines))
    expect(await fetchInternalLayerFeatures('transmission')).toEqual(lines)

    mockedFetch.mockResolvedValueOnce(jsonResponse({ geometry: 'county', values: {} }))
    await expect(fetchInternalLayerFeatures('county-one')).rejects.toThrow(/not a point, line or state layer/)
  })

  /**
   * P7-9: the server sends state rows with `geometry: null` and this is where
   * they get a shape. It is the whole reason nothing downstream — the canvas,
   * the rail, the framing, the popup — needs a state-shaped exception.
   */
  describe('locating state rows', () => {
    const ga = { type: 'Polygon', coordinates: [[[-85, 31], [-81, 31], [-81, 35], [-85, 35], [-85, 31]]] }
    const tn = { type: 'Polygon', coordinates: [[[-90, 35], [-82, 35], [-82, 36], [-90, 36], [-90, 35]]] }

    beforeEach(() => {
      outlines.mockReset()
      outlines.mockResolvedValue({ byFips: new Map([['13', ga], ['47', tn]]), dropped: 0 })
    })

    const rows = {
      id: 'internal-permits', slug: 'permits', geometry: 'state', type: 'FeatureCollection', count: 3, skipped: 1, bbox: null,
      features: [
        { type: 'Feature', geometry: null, properties: { _state: '13', _label: 'Georgia', Authority: 'Georgia EPD' } },
        { type: 'Feature', geometry: null, properties: { _state: '47', _label: 'Tennessee', Authority: 'TDEC' } },
        // A state the county polygons do not describe. Dropped, not invented.
        { type: 'Feature', geometry: null, properties: { _state: '99', _label: 'Nowhere', Authority: 'Nobody' } },
      ],
    }

    it('joins each row to its outline and computes the frame the server could not', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse(rows))
      const out = await fetchInternalLayerFeatures('permits')
      expect(out.geometry).toBe('state')
      expect(out.features.map(f => f.properties._label)).toEqual(['Georgia', 'Tennessee'])
      expect(out.features[0].geometry).toEqual(ga)
      expect(out.count).toBe(2)
      // The server's one skipped row plus the one with no outline.
      expect(out.skipped).toBe(2)
      // Computed here, from the outlines — which is why the server sends none.
      expect(out.bbox).toEqual([-90, 31, -81, 36])
      expect(out.id).toBe('internal-permits')
      expect(out.slug).toBe('permits')
    })

    it('dissolves once and caches the joined collection per slug', async () => {
      mockedFetch.mockResolvedValueOnce(jsonResponse(rows))
      const first = await fetchInternalLayerFeatures('permits')
      expect(await fetchInternalLayerFeatures('permits')).toBe(first)
      expect(mockedFetch).toHaveBeenCalledTimes(1)
      expect(outlines).toHaveBeenCalledTimes(1)
    })

    it('does not cache a failed dissolve, so the next toggle retries', async () => {
      outlines.mockRejectedValueOnce(new Error('no counties'))
      mockedFetch.mockResolvedValueOnce(jsonResponse(rows))
      await expect(fetchInternalLayerFeatures('permits')).rejects.toThrow('no counties')
      mockedFetch.mockResolvedValueOnce(jsonResponse(rows))
      expect((await fetchInternalLayerFeatures('permits')).count).toBe(2)
    })
  })
})

describe('the shared manifest (P5-89)', () => {
  it('fetches once however many surfaces ask', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse({ layers: [entry] }))
    const [a, b] = await Promise.all([sharedManifest(), sharedManifest()])
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(a).toEqual([entry])
    expect(b).toBe(a)

    // And a later ask, after it has settled, is still free.
    expect(await sharedManifest()).toBe(a)
    expect(mockedFetch).toHaveBeenCalledTimes(1)
  })

  it('retries after a failure rather than caching it', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('offline'))
    await expect(sharedManifest()).rejects.toThrow('offline')
    mockedFetch.mockImplementation(async () => jsonResponse({ layers: [entry] }))
    expect(await sharedManifest()).toEqual([entry])
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })

  it('is emptied by a logout — no layer name outlives the session', async () => {
    mockedFetch.mockImplementation(async () => jsonResponse({ layers: [entry] }))
    await sharedManifest()
    expect(mockedFetch).toHaveBeenCalledTimes(1)

    clearInternalSession()

    await sharedManifest()
    expect(mockedFetch).toHaveBeenCalledTimes(2)
  })
})
