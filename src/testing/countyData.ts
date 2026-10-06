/**
 * The two county files a mounted `MapCanvas` fetches, as fixtures.
 *
 * Any page that can open a map pane — `/chat` (P6-10), and the "Show on map"
 * call sites (P6-14) — downloads the county bundle and the county geometry the
 * moment its canvas mounts. Each spec used to carry its own copy of these two
 * objects and its own `fetch` stub; they live here once so a test asserting
 * "nothing was fetched until the pane opened" is asserting against the same
 * fixture everywhere.
 *
 * One county is enough: these tests are about *which* counties a page hands
 * the map, not about the map's arithmetic.
 */
import { vi } from 'vitest'
import DATASETS from '@/config/datasetsManifest.generated.json'

/** Fulton County, Georgia — one square polygon. */
export const COUNTY_GEOMETRY = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { GEOID: '13121', NAME: 'Fulton' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-84.6, 33.6], [-83.6, 33.6], [-83.6, 34.6], [-84.6, 34.6], [-84.6, 33.6]]],
      },
    },
  ],
}

/** The prebuilt bundle, with every section the loader expects present. */
export const COUNTY_BUNDLE = {
  version: 1,
  diversity: {
    '13121': {
      diversityIndex: 0.6,
      pct_Black: 44.5,
      totalPopulation: 1_066_710,
      countyName: 'Fulton County',
      stateName: 'Georgia',
    },
  },
  lifeExpectancy: { '13121': { lifeExpectancy: 78.6 } },
  contamination: { '13121': { total: 21 } },
  combinedScores: { '13121': { combinedScore: 4.1, rankScore: 12 } },
  combinedScoresV2: { '13121': { blo_score_v2: 3.9 } },
  economic: {},
  housing: {},
  equity: {},
  transportation: {},
}

export interface CountyDataFetchStub {
  /** Every URL the page asked for, in order, so a test can prove it did not. */
  readonly urls: string[]
  /** True once either county file has been requested. */
  askedForCountyData(): boolean
  /**
   * True once the county **polygons** have been requested. This is the one a
   * map pane always adds: a page with a county table of its own (a layer page,
   * the compare page) has already downloaded the *numbers* for its table, and
   * only the geometry is the pane's own cost.
   */
  askedForGeometry(): boolean
}

/**
 * Stub `fetch` to serve the two county files and reject everything else — an
 * unexpected URL is a test that has grown a dependency it did not declare.
 * Pair with `vi.unstubAllGlobals()` in `afterEach`.
 */
export function stubCountyDataFetch(extra: Record<string, unknown> = {}): CountyDataFetchStub {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input)
      urls.push(url)
      if (url === DATASETS.countyData) return ok(COUNTY_BUNDLE)
      if (url === DATASETS.counties) return ok(COUNTY_GEOMETRY)
      if (url in extra) return ok(extra[url])
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
  return {
    urls,
    askedForCountyData: () => urls.some(url => url.includes('/datasets/build/')),
    askedForGeometry: () => urls.includes(DATASETS.counties),
  }
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}
