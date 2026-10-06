import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useMapData, fetchCountyDataBundle, resetCountyDataCache } from '../useMapData'
import DATASETS from '@/config/datasetsManifest.generated.json'

/**
 * P5-87 / P5-90. The map used to await thirteen fetches in a row and parse ten
 * CSVs on the main thread. It now reads two prebuilt, content-hashed files —
 * whose names come from the generated manifest the bundle imports — and the
 * data file is downloaded once per session no matter how many callers want it.
 */

const BUNDLE = {
  version: 1,
  diversity: {
    '01001': {
      diversityIndex: 0.4445,
      pct_Black: 21.4,
      totalPopulation: 60342,
      countyName: 'Autauga County',
      stateName: 'Alabama',
    },
  },
  lifeExpectancy: { '01001': { lifeExpectancy: 75.3, standardError: 1.835 } },
  contamination: { '01001': { total: 15 } },
  combinedScores: { '01001': { combinedScore: 4.333, rankScore: 30 } },
  combinedScoresV2: { '01001': { blo_score_v2: 2.83 } },
  economic: { '01001': { GEOID: '01001', avg_weekly_wage: 900, median_income_black: 41000 } },
  housing: { '01001': { GEOID: '01001', median_home_value: 225000 } },
  equity: { '01001': { GEOID: '01001', poverty_rate_black: 16.6 } },
  transportation: { '01001': { GEOID: '01001', commute_time_ordinal: 7 } },
}

const GEOMETRY = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { GEOID: '01001' }, geometry: null }],
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

const makeFetchMock = () =>
  vi.fn(async (url: string) => {
    if (url === DATASETS.countyData) return ok(BUNDLE)
    if (url === DATASETS.counties) return ok(GEOMETRY)
    throw new Error(`unexpected fetch: ${url}`)
  })
let fetchMock: ReturnType<typeof makeFetchMock>

beforeEach(() => {
  resetCountyDataCache()
  fetchMock = makeFetchMock()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetCountyDataCache()
})

describe('the generated dataset manifest', () => {
  it('names both built files under the immutable build prefix', () => {
    expect(DATASETS.countyData).toMatch(/^\/datasets\/build\/county-data\.[0-9a-f]{10}\.json$/)
    expect(DATASETS.counties).toMatch(/^\/datasets\/build\/counties\.[0-9a-f]{10}\.geojson$/)
  })
})

describe('useMapData — two files, fetched in parallel', () => {
  it('fills every data ref from the one built file', async () => {
    const data = useMapData()
    await data.loadCountyData()

    expect(data.diversityData.value['01001'].countyName).toBe('Autauga County')
    expect(data.lifeExpectancyData.value['01001'].lifeExpectancy).toBe(75.3)
    expect(data.countyContaminationCounts['01001']).toEqual({ total: 15 })
    expect(data.combinedScoresData.value['01001'].combinedScore).toBe(4.333)
    expect(data.combinedScoresV2Data.value['01001'].blo_score_v2).toBe(2.83)
    expect(data.economicData.value['01001'].avg_weekly_wage).toBe(900)
    expect(data.housingData.value['01001'].median_home_value).toBe(225000)
    expect(data.equityData.value['01001'].poverty_rate_black).toBe(16.6)
    expect(data.transportationData.value['01001'].commute_time_ordinal).toBe(7)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(DATASETS.countyData)
  })

  it('loads the geometry from its own hashed file, independently of the data', async () => {
    const data = useMapData()
    await data.loadCountiesGeoJSON()
    expect(data.countiesData.value?.features).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(DATASETS.counties)
    // Geometry alone must not drag the data file in behind it.
    expect(data.diversityData.value).toEqual({})
  })

  it('downloads the data file once however many callers ask for it', async () => {
    const a = useMapData()
    const b = useMapData()
    await Promise.all([
      a.loadCountyData(),
      a.loadDiversityData(),
      b.loadHousingData(),
      fetchCountyDataBundle(),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Both composable instances got the data, not just the one that asked first.
    expect(a.diversityData.value['01001'].pct_Black).toBe(21.4)
    expect(b.housingData.value['01001'].median_home_value).toBe(225000)
  })

  it('downloads the polygons once however many map instances mount (P6-10)', async () => {
    // The chat pane is a second map in the same page. Without this cache it
    // re-fetched and re-parsed 1.86 MB of geometry the home map already had.
    const a = useMapData()
    const b = useMapData()
    await Promise.all([a.loadCountiesGeoJSON(), b.loadCountiesGeoJSON()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a.countiesData.value?.features).toHaveLength(1)
    // The same parsed object, not a second copy: one download, one parse.
    expect(a.countiesData.value).toBe(b.countiesData.value)
  })

  it('lets the next instance retry after a failed geometry download', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    const a = useMapData()
    await expect(a.loadCountiesGeoJSON()).rejects.toThrow(/503/)

    const b = useMapData()
    await b.loadCountiesGeoJSON()
    expect(b.countiesData.value?.features).toHaveLength(1)
  })

  it('runs geometry and data at the same time, not one after the other', async () => {
    const started: string[] = []
    fetchMock.mockImplementation(async (url: string) => {
      started.push(url)
      // Resolve the data file only after the geometry request has been made:
      // a sequential loader would deadlock here, a parallel one will not.
      await new Promise(resolve => setTimeout(resolve, 0))
      return url === DATASETS.countyData ? ok(BUNDLE) : ok(GEOMETRY)
    })
    const data = useMapData()
    await data.loadAllCountyData()
    expect(started).toHaveLength(2)
    expect(new Set(started)).toEqual(new Set([DATASETS.countyData, DATASETS.counties]))
    expect(data.countiesData.value?.features).toHaveLength(1)
    expect(data.diversityData.value['01001']).toBeTruthy()
  })

  it('surfaces an HTTP failure and lets the next attempt retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    const data = useMapData()
    await expect(data.loadCountyData()).rejects.toThrow(/404/)

    fetchMock.mockImplementationOnce(async () => ok(BUNDLE))
    await data.loadCountyData()
    expect(data.diversityData.value['01001'].pct_Black).toBe(21.4)
  })

  it('reports a missing geometry file rather than drawing nothing silently', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    const data = useMapData()
    await expect(data.loadCountiesGeoJSON()).rejects.toThrow(/500/)
    expect(data.countiesData.value).toBeNull()
  })

  it('tolerates a bundle missing a section instead of throwing on undefined', async () => {
    fetchMock.mockImplementation(async () => ok({ version: 1, diversity: BUNDLE.diversity }))
    const data = useMapData()
    await data.loadCountyData()
    expect(data.diversityData.value['01001']).toBeTruthy()
    expect(data.housingData.value).toEqual({})
    expect(data.transportationData.value).toEqual({})
  })

  it('never fetches a raw per-category CSV', async () => {
    const data = useMapData()
    await data.loadAllCountyData()
    for (const [url] of fetchMock.mock.calls) {
      expect(url).not.toMatch(/\.csv$/)
      expect(url.startsWith('/datasets/build/')).toBe(true)
    }
  })
})
