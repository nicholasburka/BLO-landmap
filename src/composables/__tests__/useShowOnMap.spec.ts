import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

// `sharedManifest` is the seam `loadInternalLayers` calls, and the only thing
// here that reaches the network. Everything else — the registry routing, the
// scoring query, the subset, the frame — is the real code running over the
// fake, because that is what this ticket is about getting right.
vi.mock('@/lib/internalLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/internalLayers')>()
  return { ...actual, sharedManifest: vi.fn() }
})

import {
  sharedManifest,
  clearInternalLayerCache,
  type InternalLayerManifestEntry,
} from '@/lib/internalLayers'
import { useShowOnMap, type MapSelection, type ShowOnMap } from '../useShowOnMap'
import { stubViewportWidth, restoreViewport } from '@/testing/viewport'

/**
 * P6-14. The substance of the ticket: a page hands the map what it is
 * showing, and `query.only` carries the one thing a `?layers=…&fit=…` link
 * never could — *this subset is the answer*.
 */

const mockedManifest = vi.mocked(sharedManifest)

const COUNTY_LAYER: InternalLayerManifestEntry = {
  id: 'internal-flood',
  slug: 'flood',
  name: 'Flood risk',
  geometry: 'county',
  dataType: 'index',
  unit: '',
  direction: 'higher_better',
  range: { min: 0, max: 1 },
  description: 'Where the water goes.',
  source: '',
  year: 2026,
  file: null,
  color: null,
  popupFields: [],
  bbox: null,
  updatedAt: '2026-10-03T10:00:00.000Z',
}

const LINE_LAYER: InternalLayerManifestEntry = {
  ...COUNTY_LAYER,
  id: 'internal-transmission',
  slug: 'transmission',
  name: 'Transmission lines (345 kV+)',
  geometry: 'line',
}

const POINT_LAYER: InternalLayerManifestEntry = {
  ...COUNTY_LAYER,
  id: 'internal-orgs',
  slug: 'orgs',
  name: 'Organizations (HQ)',
  geometry: 'point',
}

beforeEach(() => {
  mockedManifest.mockReset()
  mockedManifest.mockResolvedValue([])
  clearInternalLayerCache()
  stubViewportWidth(1280)
})

afterEach(() => {
  restoreViewport()
  clearInternalLayerCache()
})

/** Mount a host holding one of these and hand it back, settled. */
async function host(selection: MapSelection): Promise<ShowOnMap> {
  let map!: ShowOnMap
  mount(
    defineComponent({
      setup() {
        map = useShowOnMap(selection)
        return () => h('span', String(map.isOpen.value))
      },
    }),
  )
  await nextTick()
  return map
}

describe('useShowOnMap (P6-14)', () => {
  it('puts the page\'s layer on and draws the page\'s own rows as the answer', async () => {
    const shown = ref(['01001', '13121', '28033'])
    const map = await host({ layers: () => ['pct_Black'], only: () => shown.value })

    // Nothing is applied before anyone asks: a page that never opens a pane
    // pays for none of this.
    expect(map.state.query.only.value).toBeNull()

    map.open()
    expect(map.state.layers.demographic.value).toEqual(['pct_Black'])
    expect(map.state.query.only.value).toEqual(['01001', '13121', '28033'])
    // `only` IS the answer: these are the saturated counties, everything else
    // dims behind them — with no limit and no scoring query needed.
    expect([...map.state.query.topNGeoIds.value]).toEqual(['01001', '13121', '28033'])
  })

  /**
   * P9-1. The bug this ticket exists for: `apply()` split ids into "is it a
   * known point layer" and "everything else gets scored at weight 5". A line
   * layer is not a point, so it was scored as though it were a column of
   * county numbers — and a working set's map drew a choropleth with no legend
   * instead of the set's own layers.
   */
  it('draws a line layer instead of scoring it', async () => {
    mockedManifest.mockResolvedValue([LINE_LAYER])
    const map = await host({ layers: () => ['internal-transmission'] })
    map.open()
    await flushPromises()
    await nextTick()

    expect(map.state.layers.points.value).toContain('internal-transmission')
    // and emphatically NOT a scoring term
    expect(map.state.query.scoring.value.map(l => l.layerId)).not.toContain('internal-transmission')
  })

  it('still scores an internal COUNTY layer — that one really is a column of numbers', async () => {
    mockedManifest.mockResolvedValue([COUNTY_LAYER])
    const map = await host({ layers: () => ['internal-flood'] })
    map.open()
    await flushPromises()
    await nextTick()

    expect(map.state.query.scoring.value.map(l => l.layerId)).toContain('internal-flood')
    expect(map.state.layers.points.value).not.toContain('internal-flood')
  })

  /**
   * The failure was a race, not only a mis-split: `apply()` ran once before
   * the manifest landed, when every internal id is unclassifiable, and the
   * old code's default for "unknown" was *score it*. Holding an unclassified
   * id back means the wrong thing is never drawn, even for a moment.
   */
  it('holds an unclassified internal id back rather than guessing it is scorable', async () => {
    let resolve!: (v: InternalLayerManifestEntry[]) => void
    mockedManifest.mockReturnValue(new Promise(r => { resolve = r }))
    const map = await host({ layers: () => ['internal-transmission'] })
    map.open()
    await nextTick()

    // manifest still in flight — nothing is scored on a guess
    expect(map.state.query.scoring.value.map(l => l.layerId)).not.toContain('internal-transmission')

    resolve([LINE_LAYER])
    await flushPromises()
    await nextTick()

    expect(map.state.layers.points.value).toContain('internal-transmission')
  })

  it('re-applies when the manifest lands, without depending on sync() ordering', async () => {
    mockedManifest.mockResolvedValue([LINE_LAYER, POINT_LAYER, COUNTY_LAYER])
    const map = await host({ layers: () => ['internal-transmission', 'internal-orgs', 'internal-flood'] })
    map.open()
    await flushPromises()
    await nextTick()

    expect([...map.state.layers.points.value].sort()).toEqual(['internal-orgs', 'internal-transmission'])
    expect(map.state.query.scoring.value.map(l => l.layerId)).toEqual(['internal-flood'])
  })

  it('a public registry layer is scored, manifest or no manifest', async () => {
    const map = await host({ layers: () => ['pct_Black'] })
    map.open()
    await nextTick()
    expect(map.state.layers.demographic.value).toEqual(['pct_Black'])
  })

  it('frames the subset, which is what the deep link could only approximate', async () => {
    const map = await host({ layers: () => ['pct_Black'], only: () => ['13121', '13089'] })
    map.open()
    expect(map.fit.value).toEqual({ geoIds: ['13121', '13089'] })
  })

  it('follows the page while it is open — filter the table and the map narrows', async () => {
    const shown = ref(['01001', '13121', '28033'])
    const map = await host({ layers: () => ['pct_Black'], only: () => shown.value })
    map.open()
    expect(map.state.query.only.value).toHaveLength(3)

    shown.value = ['13121']
    await nextTick()
    await flushPromises()

    expect(map.state.query.only.value).toEqual(['13121'])
    expect(map.fit.value).toEqual({ geoIds: ['13121'] })
  })

  it('follows a layer the page toggles, too', async () => {
    const layers = ref(['pct_Black'])
    const map = await host({ layers: () => layers.value })
    map.open()
    expect(map.state.layers.demographic.value).toEqual(['pct_Black'])

    layers.value = ['median_home_value']
    await nextTick()
    await flushPromises()

    expect(map.state.layers.demographic.value).toEqual([])
    expect(map.state.layers.housing.value).toEqual(['median_home_value'])
  })

  it('leaves the map alone while it is shut — a closed pane is not a live view', async () => {
    const shown = ref(['01001'])
    const map = await host({ layers: () => ['pct_Black'], only: () => shown.value })
    shown.value = ['13121', '28033']
    await nextTick()
    await flushPromises()
    expect(map.state.query.only.value).toBeNull()
  })

  it('treats an empty subset as "the whole layer", not "nothing"', async () => {
    // A page with no county key column, or a table whose rows are not
    // counties at all: the layer is still worth drawing.
    const map = await host({ layers: () => ['pct_Black'], only: () => [] })
    map.open()
    expect(map.state.query.only.value).toBeNull()
    expect(map.fit.value).toBeNull()
    expect(map.state.layers.demographic.value).toEqual(['pct_Black'])
  })

  it('waits for the manifest before an internal county layer can resolve', async () => {
    mockedManifest.mockResolvedValue([COUNTY_LAYER])
    const map = await host({ layers: () => ['internal-flood'], only: () => ['13121'] })

    map.open()
    // The registry is empty at this instant, so the id is dropped — the
    // synchronous pass is only there to get the obvious part right at once.
    expect(map.state.layers.internal.value).toEqual([])

    await flushPromises()
    expect(mockedManifest).toHaveBeenCalled()
    expect(map.state.layers.internal.value).toEqual(['internal-flood'])
    expect(map.state.query.only.value).toEqual(['13121'])
  })

  it('routes a point layer to the overlay list, never into the scoring query', async () => {
    mockedManifest.mockResolvedValue([POINT_LAYER])
    const map = await host({ layers: () => ['internal-orgs'] })

    map.open()
    await flushPromises()

    expect(map.state.layers.points.value).toEqual(['internal-orgs'])
    // A point overlay has its own source and its own markers; scoring it
    // would be a category error.
    expect(map.state.layers.internal.value).toEqual([])
    expect(map.state.query.scoring.value).toEqual([])
  })

  it('fetches no manifest for a page showing only public layers', async () => {
    const map = await host({ layers: () => ['pct_Black'] })
    map.open()
    await flushPromises()
    expect(mockedManifest).not.toHaveBeenCalled()
  })

  it('lets the page override the frame — a point layer has no county polygons', async () => {
    const map = await host({
      layers: () => ['pct_Black'],
      only: () => ['13121'],
      fit: () => ({ bbox: [-85, 30, -80, 35] }),
    })
    map.open()
    expect(map.fit.value).toEqual({ bbox: [-85, 30, -80, 35] })
  })

  it('does not open below the breakpoint, and applies nothing when it cannot', async () => {
    restoreViewport()
    stubViewportWidth(390)
    const map = await host({ layers: () => ['pct_Black'], only: () => ['13121'] })
    map.open()
    expect(map.isOpen.value).toBe(false)
    expect(map.state.query.only.value).toBeNull()
    expect(map.state.layers.demographic.value).toEqual(['combined_scores_v2'])
  })

  it('is this page\'s map and nobody else\'s', async () => {
    const one = await host({ layers: () => ['pct_Black'], only: () => ['13121'] })
    const two = await host({ layers: () => ['median_home_value'], only: () => ['28033'] })
    one.open()
    two.open()
    expect(one.state.query.only.value).toEqual(['13121'])
    expect(two.state.query.only.value).toEqual(['28033'])
    expect(one.state.instanceId).not.toBe(two.state.instanceId)
  })

  it('stops following the page once it is closed', async () => {
    const shown = ref(['13121'])
    const map = await host({ layers: () => ['pct_Black'], only: () => shown.value })
    map.open()
    expect(map.state.query.only.value).toEqual(['13121'])

    map.close()
    shown.value = ['01001']
    await nextTick()
    await flushPromises()
    // Whatever it last drew is still in the state; the point is that a shut
    // pane does no work, and re-opening re-reads the page.
    expect(map.state.query.only.value).toEqual(['13121'])

    map.open()
    expect(map.state.query.only.value).toEqual(['01001'])
  })
})
