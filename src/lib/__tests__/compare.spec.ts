import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LayerDefinition } from '@/config/layerRegistry'

vi.mock('@/lib/publicLayers', () => ({ loadCountyRows: vi.fn(), publicLayers: vi.fn(() => []) }))
vi.mock('@/lib/internalLayers', () => ({
  fetchInternalLayerValues: vi.fn(),
  // P5-89: every surface reads the one shared manifest now.
  sharedManifest: vi.fn(),
  toLayerDefinition: vi.fn(),
}))
vi.mock('@/lib/countyLookup', () => ({
  initCountyLookup: vi.fn(),
  getCountyByGeoId: vi.fn(),
  getAllCounties: vi.fn(),
}))

import { loadCountyRows, publicLayers } from '@/lib/publicLayers'
import { fetchInternalLayerValues, sharedManifest, toLayerDefinition } from '@/lib/internalLayers'
import { initCountyLookup, getCountyByGeoId, getAllCounties } from '@/lib/countyLookup'
import {
  COMPARE_CSV_FILENAME,
  MAX_COMPARE_COUNTIES,
  MAX_COMPARE_LAYERS,
  NO_VALUE,
  SHORTLIST_KEY,
  addToShortlist,
  buildCompareRows,
  clearCompareLayerIndex,
  clearShortlist,
  compareCsv,
  compareLayerIndex,
  compareHeading,
  compareQuestion,
  compareUrl,
  extremesOf,
  isShortlisted,
  listPhrase,
  loadCompareCounties,
  loadLayerColumn,
  parseCompareUrl,
  reloadShortlist,
  removeFromShortlist,
  searchCounties,
  shortlist,
  sortCompareRows,
  type CompareCounty,
  type LayerColumn,
} from '../compare'

const mockedLoadRows = vi.mocked(loadCountyRows)
const mockedPublicLayers = vi.mocked(publicLayers)
const mockedManifest = vi.mocked(sharedManifest)
const mockedToDefinition = vi.mocked(toLayerDefinition)
const mockedInternalValues = vi.mocked(fetchInternalLayerValues)
const mockedInit = vi.mocked(initCountyLookup)
const mockedByGeoId = vi.mocked(getCountyByGeoId)
const mockedAll = vi.mocked(getAllCounties)

const layer = (over: Partial<LayerDefinition> = {}): LayerDefinition => ({
  id: 'median_home_value',
  name: 'Median Home Value',
  category: 'housing',
  dataType: 'currency',
  direction: 'lower_better',
  unit: '$',
  range: { min: 0, max: 1_000_000 },
  description: 'What a home costs.',
  source: 'Census',
  year: 2023,
  dataPath: '/datasets/housing.csv',
  dataKey: 'median_home_value',
  gradient: { css: '', lowLabel: 'Lower', highLabel: 'Higher' },
  formatValue: v => (v == null ? NO_VALUE : `$${v}`),
  ...over,
})

const HOMES = layer()
const LIFE = layer({
  id: 'life_expectancy',
  name: 'Life Expectancy',
  dataType: 'years',
  direction: 'higher_better',
  dataKey: 'life_expectancy',
  formatValue: v => (v == null ? NO_VALUE : `${v} yrs`),
})

const COUNTIES: CompareCounty[] = [
  { geoId: '47157', county: 'Shelby County', state: 'Tennessee' },
  { geoId: '13121', county: 'Fulton County', state: 'Georgia' },
  { geoId: '28033', county: 'DeSoto County', state: 'Mississippi' },
]

const COLUMNS: Record<string, LayerColumn> = {
  median_home_value: {
    '47157': { value: 180000, display: '$180000' },
    '13121': { value: 380000, display: '$380000' },
    '28033': { value: 250000, display: '$250000' },
  },
  life_expectancy: {
    '47157': { value: 74.2, display: '74.2 yrs' },
    '13121': { value: 79.1, display: '79.1 yrs' },
    // DeSoto has no number for this layer
  },
}

describe('compare URL state (P5-55)', () => {
  it('reads counties and layers out of the query, in the order given', () => {
    expect(parseCompareUrl({ counties: '47157,13121', layers: 'median_home_value,life_expectancy' })).toEqual({
      counties: ['47157', '13121'],
      layers: ['median_home_value', 'life_expectancy'],
      view: '',
    })
  })

  it('drops anything that is not a five-digit GEOID or a layer id, rather than erroring', () => {
    const state = parseCompareUrl({ counties: '47157,4715,../etc,,13121', layers: 'median_home_value, bad id ' })
    expect(state.counties).toEqual(['47157', '13121'])
    expect(state.layers).toEqual(['median_home_value'])
  })

  it('de-duplicates and caps both lists', () => {
    const many = Array.from({ length: 20 }, (_, i) => String(20000 + i)).join(',')
    const state = parseCompareUrl({ counties: `47157,47157,${many}`, layers: Array.from({ length: 20 }, (_, i) => `layer_${i}`).join(',') })
    expect(state.counties).toHaveLength(MAX_COMPARE_COUNTIES)
    expect(state.counties[0]).toBe('47157')
    expect(new Set(state.counties).size).toBe(MAX_COMPARE_COUNTIES)
    expect(state.layers).toHaveLength(MAX_COMPARE_LAYERS)
  })

  it('accepts repeated params and carries a saved-view slug', () => {
    expect(parseCompareUrl({ counties: ['47157', '13121'], layers: 'life_expectancy', view: 'delta-shortlist' })).toEqual({
      counties: ['47157', '13121'],
      layers: ['life_expectancy'],
      view: 'delta-shortlist',
    })
  })

  it('ignores a view slug that is not slug-shaped', () => {
    expect(parseCompareUrl({ view: '../secrets' }).view).toBe('')
  })

  it('builds the URL back, round-tripping through the parser', () => {
    const url = compareUrl({ counties: ['47157', '13121'], layers: ['median_home_value'], view: 'delta-shortlist' })
    expect(url).toBe('/compare?counties=47157%2C13121&layers=median_home_value&view=delta-shortlist')
    const params = Object.fromEntries(new URL(url, 'http://x').searchParams)
    expect(parseCompareUrl(params)).toEqual({
      counties: ['47157', '13121'],
      layers: ['median_home_value'],
      view: 'delta-shortlist',
    })
  })

  it('is the bare page when nothing has been picked', () => {
    expect(compareUrl({ counties: [], layers: [] })).toBe('/compare')
  })
})

describe('best and worst of these (P5-55)', () => {
  it('reads the layer direction: lowest wins when lower is better', () => {
    expect(extremesOf([180000, 380000, 250000], 'lower_better')).toEqual({ best: 180000, worst: 380000 })
    expect(extremesOf([180000, 380000, 250000], 'higher_better')).toEqual({ best: 380000, worst: 180000 })
  })

  it('ignores blanks and unparseable values', () => {
    expect(extremesOf([74.2, null, '79.1', 'n/a'], 'higher_better')).toEqual({ best: 79.1, worst: 74.2 })
  })

  it('marks nothing when there is only one number, or every number is the same', () => {
    expect(extremesOf([5, null], 'higher_better')).toEqual({ best: null, worst: null })
    expect(extremesOf([5, 5, 5], 'higher_better')).toEqual({ best: null, worst: null })
    expect(extremesOf([], 'lower_better')).toEqual({ best: null, worst: null })
  })
})

describe('compare rows (P5-55)', () => {
  it('puts counties in rows and layers in columns, formatted by the layer', () => {
    const rows = buildCompareRows(COUNTIES, [HOMES, LIFE], COLUMNS)
    expect(rows.map(r => r.county)).toEqual(['Shelby County', 'Fulton County', 'DeSoto County'])
    expect(rows[0].cells.map(c => c.display)).toEqual(['$180000', '74.2 yrs'])
  })

  it('marks the best and worst value in each column by that layer own direction', () => {
    const rows = buildCompareRows(COUNTIES, [HOMES, LIFE], COLUMNS)
    const rank = (geoId: string, layerId: string) =>
      rows.find(r => r.geoId === geoId)!.cells.find(c => c.layerId === layerId)!.rank
    // Homes: lower is better, so the cheapest county is best of these.
    expect(rank('47157', 'median_home_value')).toBe('best')
    expect(rank('13121', 'median_home_value')).toBe('worst')
    expect(rank('28033', 'median_home_value')).toBeNull()
    // Life expectancy: higher is better.
    expect(rank('13121', 'life_expectancy')).toBe('best')
    expect(rank('47157', 'life_expectancy')).toBe('worst')
  })

  it('shows a dash for a county the layer has no number for, and never ranks it', () => {
    const rows = buildCompareRows(COUNTIES, [HOMES, LIFE], COLUMNS)
    const cell = rows.find(r => r.geoId === '28033')!.cells.find(c => c.layerId === 'life_expectancy')!
    expect(cell.display).toBe(NO_VALUE)
    expect(cell.value).toBeNull()
    expect(cell.rank).toBeNull()
  })

  it('handles a layer whose data never arrived', () => {
    const rows = buildCompareRows(COUNTIES, [HOMES, LIFE], {})
    expect(rows[0].cells.every(c => c.display === NO_VALUE)).toBe(true)
  })
})

describe('sorting a comparison (P5-55)', () => {
  const rows = buildCompareRows(COUNTIES, [HOMES, LIFE], COLUMNS)

  it('sorts by county name both ways', () => {
    expect(sortCompareRows(rows, 'name', 'asc').map(r => r.county)).toEqual([
      'DeSoto County',
      'Fulton County',
      'Shelby County',
    ])
    expect(sortCompareRows(rows, 'name', 'desc')[0].county).toBe('Shelby County')
  })

  it('sorts by any layer column', () => {
    expect(sortCompareRows(rows, 'median_home_value', 'asc').map(r => r.geoId)).toEqual(['47157', '28033', '13121'])
    expect(sortCompareRows(rows, 'median_home_value', 'desc').map(r => r.geoId)).toEqual(['13121', '28033', '47157'])
  })

  it('sinks blanks to the bottom whichever way the column is pointed', () => {
    expect(sortCompareRows(rows, 'life_expectancy', 'asc').map(r => r.geoId).at(-1)).toBe('28033')
    expect(sortCompareRows(rows, 'life_expectancy', 'desc').map(r => r.geoId).at(-1)).toBe('28033')
  })

  it('does not mutate the rows it was handed', () => {
    const before = rows.map(r => r.geoId)
    sortCompareRows(rows, 'median_home_value', 'desc')
    expect(rows.map(r => r.geoId)).toEqual(before)
  })
})

describe('compare CSV (P5-55)', () => {
  const rows = buildCompareRows(COUNTIES, [HOMES, LIFE], COLUMNS)

  it('writes raw values under the layer names, one row per county', () => {
    const csv = compareCsv(rows, [HOMES, LIFE])
    expect(csv.split('\n')[0]).toBe('GEOID,County,State,Median Home Value,Life Expectancy')
    expect(csv.split('\n')[1]).toBe('47157,Shelby County,Tennessee,180000,74.2')
    // A missing value is an empty cell, not a dash a spreadsheet cannot add up.
    expect(csv.split('\n')[3]).toBe('28033,DeSoto County,Mississippi,250000,')
  })

  it('adds a notes column only when there are notes, and quotes what needs it', () => {
    expect(compareCsv(rows, [HOMES]).includes('Notes')).toBe(false)
    const csv = compareCsv(rows, [HOMES], { '47157': 'Closest to the "delta", and cheap' })
    expect(csv.split('\n')[0]).toBe('GEOID,County,State,Median Home Value,Notes')
    expect(csv.split('\n')[1]).toBe('47157,Shelby County,Tennessee,180000,"Closest to the ""delta"", and cheap"')
    expect(csv.split('\n')[2].endsWith(',')).toBe(true)
  })

  it('names the file something a download folder can live with', () => {
    expect(COMPARE_CSV_FILENAME).toBe('county-comparison.csv')
  })
})

describe('saying what is being compared (P5-55)', () => {
  it('lists things the way a person would say them', () => {
    expect(listPhrase([])).toBe('')
    expect(listPhrase(['A'])).toBe('A')
    expect(listPhrase(['A', 'B'])).toBe('A and B')
    expect(listPhrase(['A', 'B', 'C'])).toBe('A, B and C')
  })

  it('prefills Ask with the counties and the layers', () => {
    expect(compareQuestion(['Shelby County, Tennessee', 'Fulton County, Georgia'], ['Median Home Value'])).toBe(
      'Compare Shelby County, Tennessee and Fulton County, Georgia on Median Home Value',
    )
  })

  it('trims a question that runs past what Ask accepts', () => {
    const q = compareQuestion(Array.from({ length: 12 }, (_, i) => `A very long county name number ${i}, Somewhere`), [
      'Median Home Value',
      'Life Expectancy',
    ])
    expect(q.length).toBeLessThanOrEqual(500)
    expect(q.endsWith('…')).toBe(true)
  })

  it('counts the header in plain words', () => {
    expect(compareHeading(3, 4)).toBe('Comparing 3 counties across 4 layers')
    expect(compareHeading(1, 1)).toBe('Comparing 1 county across 1 layer')
  })
})

describe('the pending shortlist (P5-55)', () => {
  beforeEach(() => {
    localStorage.clear()
    reloadShortlist()
  })

  it('starts empty and accumulates GEOIDs, persisting them', () => {
    expect(shortlist.value).toEqual([])
    expect(addToShortlist('47157')).toBe(true)
    expect(addToShortlist('13121')).toBe(true)
    expect(shortlist.value).toEqual(['47157', '13121'])
    expect(JSON.parse(localStorage.getItem(SHORTLIST_KEY)!)).toEqual(['47157', '13121'])
  })

  it('never stores anything but GEOIDs', () => {
    expect(addToShortlist('not-a-geoid')).toBe(false)
    expect(shortlist.value).toEqual([])
    expect(localStorage.getItem(SHORTLIST_KEY)).toBeNull()
  })

  it('adding the same county twice is a no-op that still reports success', () => {
    addToShortlist('47157')
    expect(addToShortlist('47157')).toBe(true)
    expect(shortlist.value).toEqual(['47157'])
    expect(isShortlisted('47157')).toBe(true)
  })

  it('refuses the thirteenth county', () => {
    for (let i = 0; i < MAX_COMPARE_COUNTIES; i++) expect(addToShortlist(String(10000 + i))).toBe(true)
    expect(addToShortlist('47157')).toBe(false)
    expect(shortlist.value).toHaveLength(MAX_COMPARE_COUNTIES)
  })

  it('removes and clears', () => {
    addToShortlist('47157')
    addToShortlist('13121')
    removeFromShortlist('47157')
    expect(shortlist.value).toEqual(['13121'])
    clearShortlist()
    expect(shortlist.value).toEqual([])
    expect(localStorage.getItem(SHORTLIST_KEY)).toBeNull()
  })

  it('survives a reload, and shrugs off a corrupted key', () => {
    localStorage.setItem(SHORTLIST_KEY, JSON.stringify(['47157', 'junk', '13121']))
    reloadShortlist()
    expect(shortlist.value).toEqual(['47157', '13121'])
    localStorage.setItem(SHORTLIST_KEY, 'not json')
    reloadShortlist()
    expect(shortlist.value).toEqual([])
  })
})

describe('loading a comparison (P5-55)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads a public layer through the map own per-layer loader', async () => {
    mockedLoadRows.mockResolvedValue([
      { geoId: '47157', county: 'Shelby County', state: 'Tennessee', value: 180000, display: '$180,000' },
    ])
    const column = await loadLayerColumn(HOMES)
    expect(mockedLoadRows).toHaveBeenCalledWith(HOMES)
    expect(column).toEqual({ '47157': { value: 180000, display: '$180,000' } })
  })

  it('loads an internal county layer from the authenticated layer API', async () => {
    mockedInternalValues.mockResolvedValue({
      id: 'internal-parcels',
      slug: 'parcels',
      geometry: 'county',
      values: { '47157': 42 },
      count: 1,
      range: { min: 42, max: 42 },
    })
    const internal = layer({ id: 'internal-parcels', name: 'Parcels', category: 'internal', formatValue: v => `${v}` })
    const column = await loadLayerColumn(internal)
    expect(mockedInternalValues).toHaveBeenCalledWith('parcels')
    expect(mockedLoadRows).not.toHaveBeenCalled()
    expect(column).toEqual({ '47157': { value: 42, display: '42' } })
  })

  it('treats an internal point layer as an empty column rather than an error', async () => {
    mockedInternalValues.mockResolvedValue({ geometry: 'point' } as never)
    const column = await loadLayerColumn(layer({ id: 'internal-orgs', category: 'internal' }))
    expect(column).toEqual({})
  })

  it('names the shortlisted counties, keeping the order they were picked in', async () => {
    mockedInit.mockResolvedValue(undefined)
    mockedByGeoId.mockImplementation(geoId =>
      geoId === '47157'
        ? { geoId, name: 'Shelby County', baseName: 'Shelby', stateName: 'Tennessee', stateAbbr: 'TN' }
        : undefined,
    )
    expect(await loadCompareCounties(['47157', '99999'])).toEqual([
      { geoId: '47157', county: 'Shelby County', state: 'Tennessee' },
      // Unknown to the lookup, but still part of the comparison.
      { geoId: '99999', county: '99999', state: '' },
    ])
  })

  it('still returns rows when the county lookup cannot load', async () => {
    mockedInit.mockRejectedValue(new Error('offline'))
    expect(await loadCompareCounties(['47157'])).toEqual([{ geoId: '47157', county: '47157', state: '' }])
  })

  it('searches counties by name, state name or abbreviation', async () => {
    mockedInit.mockResolvedValue(undefined)
    mockedAll.mockReturnValue([
      { geoId: '47157', name: 'Shelby County', baseName: 'Shelby', stateName: 'Tennessee', stateAbbr: 'TN' },
      { geoId: '13121', name: 'Fulton County', baseName: 'Fulton', stateName: 'Georgia', stateAbbr: 'GA' },
    ])
    expect((await searchCounties('shelby')).map(c => c.geoId)).toEqual(['47157'])
    expect((await searchCounties('georgia')).map(c => c.geoId)).toEqual(['13121'])
    expect(await searchCounties('   ')).toEqual([])
  })
})


describe('which layers a comparison can use (P5-55)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearCompareLayerIndex()
    mockedPublicLayers.mockReturnValue([HOMES, LIFE])
  })

  it('is the public registry plus the internal COUNTY layers this session can see', async () => {
    const internal = layer({ id: 'internal-target-index', name: 'Target index', category: 'internal' })
    mockedManifest.mockResolvedValue([
      { id: 'internal-target-index', geometry: 'county' },
      // A point layer has no value per county, so it can never be a column.
      { id: 'internal-orgs', geometry: 'point' },
    ] as never)
    mockedToDefinition.mockReturnValue(internal)

    const index = await compareLayerIndex()
    expect([...index.keys()]).toEqual(['median_home_value', 'life_expectancy', 'internal-target-index'])
    expect(mockedToDefinition).toHaveBeenCalledTimes(1)
  })

  it('is just the public layers when the manifest will not answer (logged out)', async () => {
    mockedManifest.mockRejectedValue(new Error('unauthorized'))
    const index = await compareLayerIndex()
    expect([...index.keys()]).toEqual(['median_home_value', 'life_expectancy'])
  })

  it('asks once per session, and again after it is cleared', async () => {
    mockedManifest.mockResolvedValue([])
    await compareLayerIndex()
    await compareLayerIndex()
    expect(mockedManifest).toHaveBeenCalledTimes(1)
    clearCompareLayerIndex()
    await compareLayerIndex()
    expect(mockedManifest).toHaveBeenCalledTimes(2)
  })
})
