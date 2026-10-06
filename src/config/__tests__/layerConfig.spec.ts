import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CONTAMINATION_LAYERS,
  addContaminationToMap,
  ensureContaminationLayer,
  setContaminationVisibility,
  contaminationSourceId,
  contaminationMapLayerId,
  type ContaminationHost,
  type ContaminationLayer,
  type ContaminationMapLike,
} from '../layerConfig'
import { SITE_LAYERS, SITE_LAYER_IDS, isSiteLayerId, siteLayerName } from '../siteLayers'

/**
 * P5-74: the contamination sources are added on demand, so the plumbing lives
 * behind a minimal map interface and is exercised here without Mapbox — the
 * same shape `lib/internalPointLayers.spec.ts` uses for point layers.
 */
function fakeMap() {
  const sources = new Map<string, unknown>()
  const layers = new Map<string, Record<string, unknown>>()
  const visibility: string[] = []
  const map: ContaminationMapLike = {
    getSource: id => sources.get(id),
    addSource: (id, source) => sources.set(id, source),
    getLayer: id => layers.get(id),
    addLayer: layer => layers.set(layer.id, layer),
    setLayoutProperty: (id, name, value) => visibility.push(`${id} ${name}=${String(value)}`),
  }
  return { map, sources, layers, visibility }
}

const superfund = CONTAMINATION_LAYERS.find(l => l.id === 'superfund_sites')!

describe('contamination layers on demand (P5-74)', () => {
  it('ships every EPA layer off, and none of them carries a load state at rest', () => {
    // The public map's first paint must not depend on 24 MB of GeoJSON: if a
    // layer were `visible: true` here, startup would fetch it again.
    expect(CONTAMINATION_LAYERS.every(l => l.visible === false)).toBe(true)
    expect(CONTAMINATION_LAYERS.every(l => l.file.endsWith('.geojson'))).toBe(true)
  })

  it('adds the source and a hidden circle layer under ids of its own', () => {
    const { map, sources, layers } = fakeMap()
    addContaminationToMap(map, superfund, { type: 'FeatureCollection', features: [] })

    const sourceId = contaminationSourceId('superfund_sites')
    const mapLayerId = contaminationMapLayerId('superfund_sites')
    expect(sourceId).toBe('contamination-source-superfund_sites')
    expect(mapLayerId).toBe('contamination-layer-superfund_sites')
    expect(sources.get(sourceId)).toMatchObject({ type: 'geojson' })
    expect(String((sources.get(sourceId) as { attribution: string }).attribution)).toContain('epa.gov/frs')
    // Hidden on arrival: the caller reveals it once it knows the user still
    // wants it — a fetch can outlive the click that started it.
    expect(layers.get(mapLayerId)).toMatchObject({
      type: 'circle',
      source: sourceId,
      layout: { visibility: 'none' },
      paint: { 'circle-color': superfund.color },
    })
  })

  it('is idempotent, so a retry after a half-finished add is safe', () => {
    const { map, sources, layers } = fakeMap()
    addContaminationToMap(map, superfund, { type: 'FeatureCollection', features: [] })
    addContaminationToMap(map, superfund, { type: 'FeatureCollection', features: [{}] })
    expect(sources.size).toBe(1)
    expect(layers.size).toBe(1)
  })

  it('shows and hides an added layer, and stays quiet about one that is not there yet', () => {
    const { map, visibility } = fakeMap()
    setContaminationVisibility(map, 'superfund_sites', true)
    expect(visibility).toEqual([]) // still downloading — nothing to show

    addContaminationToMap(map, superfund, { type: 'FeatureCollection', features: [] })
    setContaminationVisibility(map, 'superfund_sites', true)
    setContaminationVisibility(map, 'superfund_sites', false)
    expect(visibility).toEqual([
      'contamination-layer-superfund_sites visibility=visible',
      'contamination-layer-superfund_sites visibility=none',
    ])
  })
})

/**
 * The on-demand load itself: what the checkbox row reads, and the promise the
 * deep link and the chat tool wait on.
 */
describe('ensureContaminationLayer (P5-74)', () => {
  /** A copy, so a test never leaves runtime state on the shared config. */
  const aLayer = (): ContaminationLayer => ({ ...superfund })

  // The loader reports a failure rather than throwing; keep the run quiet.
  beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function host(fetchGeoJson: ContaminationHost['fetchGeoJson'], map: ContaminationMapLike | null) {
    return { map: async () => map, fetchGeoJson }
  }

  it('fetches the layer\'s own file and leaves it loaded on the map', async () => {
    const { map, layers } = fakeMap()
    const fetchGeoJson = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }))
    const layer = aLayer()

    const done = ensureContaminationLayer(layer, host(fetchGeoJson, map), new Map())
    expect(layer.status).toBe('loading') // the row says "Loading…" straight away
    expect(await done).toBe(true)

    expect(fetchGeoJson).toHaveBeenCalledWith('/datasets/epa-contamination/superfund_sites.geojson')
    expect(layer.status).toBe('loaded')
    expect(layers.has(contaminationMapLayerId('superfund_sites'))).toBe(true)
  })

  it('downloads once, however many callers ask', async () => {
    // A checkbox click and a ?layers= deep link landing together must not
    // pull the same 5 MB twice.
    const { map } = fakeMap()
    const fetchGeoJson = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }))
    const layer = aLayer()
    const inflight = new Map<string, Promise<boolean>>()

    const [a, b] = await Promise.all([
      ensureContaminationLayer(layer, host(fetchGeoJson, map), inflight),
      ensureContaminationLayer(layer, host(fetchGeoJson, map), inflight),
    ])
    expect([a, b]).toEqual([true, true])
    expect(await ensureContaminationLayer(layer, host(fetchGeoJson, map), inflight)).toBe(true)
    expect(fetchGeoJson).toHaveBeenCalledTimes(1)
    expect(inflight.size).toBe(0)
  })

  it('records the failure without throwing, and loads again when the user retries', async () => {
    const { map, layers } = fakeMap()
    const fetchGeoJson = vi
      .fn<[string], Promise<unknown>>()
      .mockRejectedValueOnce(new Error('HTTP 502'))
      .mockResolvedValueOnce({ type: 'FeatureCollection', features: [] })
    const layer = aLayer()
    const inflight = new Map<string, Promise<boolean>>()

    expect(await ensureContaminationLayer(layer, host(fetchGeoJson, map), inflight)).toBe(false)
    expect(layer.status).toBe('error')
    expect(layers.size).toBe(0)

    // "Could not load — try again": an errored layer is not cached as failed.
    expect(await ensureContaminationLayer(layer, host(fetchGeoJson, map), inflight)).toBe(true)
    expect(layer.status).toBe('loaded')
    expect(fetchGeoJson).toHaveBeenCalledTimes(2)
  })

  it('fails rather than throws when the map never becomes ready', async () => {
    const layer = aLayer()
    const fetchGeoJson = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }))
    expect(await ensureContaminationLayer(layer, host(fetchGeoJson, null), new Map())).toBe(false)
    expect(layer.status).toBe('error')
  })
})

// --- P5-78: the site layers a saved view can name ----------------------------

describe('site layers as a vocabulary (P5-78)', () => {
  it('is the map\'s own contamination list — one source, two readers', () => {
    expect(CONTAMINATION_LAYERS.map(l => l.id)).toEqual(SITE_LAYER_IDS)
    expect(CONTAMINATION_LAYERS.map(l => l.name)).toEqual(SITE_LAYERS.map(l => l.name))
  })

  it('knows its five ids and nothing else', () => {
    expect(SITE_LAYER_IDS).toEqual([
      'acres_brownfields',
      'air_pollution_sources',
      'hazardous_waste_sites',
      'superfund_sites',
      'toxic_release_inventory',
    ])
    expect(isSiteLayerId('superfund_sites')).toBe(true)
    expect(isSiteLayerId('lead_pipes')).toBe(false)
    expect(isSiteLayerId(undefined)).toBe(false)
  })

  it('names a layer the way a person reads it, and falls back to the id', () => {
    expect(siteLayerName('superfund_sites')).toBe('Superfund Sites')
    expect(siteLayerName('lead_pipes')).toBe('lead_pipes')
  })

  it('matches the exported JSON the server validates and describes views with (run `npm run export:layers`)', () => {
    const path = resolve(process.cwd(), 'server/src/prompt/siteLayers.generated.json')
    const exported = JSON.parse(readFileSync(path, 'utf8')) as { id: string; name: string }[]
    expect(exported).toEqual(SITE_LAYERS.map(l => ({ id: l.id, name: l.name })))
  })
})
