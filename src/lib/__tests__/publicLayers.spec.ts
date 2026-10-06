import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LAYER_REGISTRY, getAllLayerIds, type LayerDefinition } from '@/config/layerRegistry'

vi.mock('@/composables/useMapData', () => ({ useMapData: vi.fn() }))
vi.mock('@/lib/countyLookup', () => ({ initCountyLookup: vi.fn(), getCountyByGeoId: vi.fn() }))

import { useMapData } from '@/composables/useMapData'
import { initCountyLookup, getCountyByGeoId } from '@/lib/countyLookup'
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  SOURCE_NOT_RECORDED,
  askQuestionFor,
  buildCountyRows,
  csvFilename,
  dataTypeLabel,
  directionLabel,
  filterCountyRows,
  getPublicLayer,
  groupLayers,
  isPublicLayerId,
  LAYER_DATA_SOURCES,
  layerAboutHref,
  loadCountyRows,
  pageOf,
  publicLayers,
  rangeLine,
  rowsToCsv,
  searchLayers,
  sortCountyRows,
  PUBLISHER_NOT_RECORDED,
  publisherLine,
  sourceLine,
  type CountyValueRow,
} from '../publicLayers'

const mockedMapData = vi.mocked(useMapData)
const mockedInit = vi.mocked(initCountyLookup)
const mockedCounty = vi.mocked(getCountyByGeoId)

const layer = (over: Partial<LayerDefinition> = {}): LayerDefinition => ({
  id: 'test_layer',
  name: 'Test layer',
  category: 'housing',
  dataType: 'currency',
  direction: 'lower_better',
  unit: '$',
  range: { min: 100, max: 900 },
  description: 'A test layer.',
  source: 'Test source',
  year: 2024,
  dataPath: '/datasets/test.csv',
  dataKey: 'test_value',
  gradient: { css: '', lowLabel: 'Lower', highLabel: 'Higher' },
  formatValue: v => (v == null ? '?' : `$${v}`),
  ...over,
})

describe('publicLayers — the registry as a browsable list', () => {
  it('lists every public registry layer and leaves runtime internal ones out', () => {
    LAYER_REGISTRY['internal-secret'] = layer({ id: 'internal-secret', name: 'Secret', category: 'internal' })
    try {
      const ids = publicLayers().map(l => l.id)
      expect(ids).toContain('pct_Black')
      expect(ids).toContain('combined_scores_v2')
      expect(ids).not.toContain('internal-secret')
      expect(isPublicLayerId('pct_Black')).toBe(true)
      expect(isPublicLayerId('internal-secret')).toBe(false)
      expect(isPublicLayerId('nope')).toBe(false)
    } finally {
      delete LAYER_REGISTRY['internal-secret']
    }
  })

  it('groups by category in a fixed reading order, with a plain-language label per group', () => {
    const groups = groupLayers(publicLayers())
    expect(groups.length).toBeGreaterThan(3)
    const order = groups.map(g => g.category)
    expect(order).toEqual(CATEGORY_ORDER.filter(c => order.includes(c)))
    expect(groups[0].category).toBe('composite')
    for (const group of groups) {
      expect(group.label).toBe(CATEGORY_LABELS[group.category])
      expect(group.layers.length).toBeGreaterThan(0)
    }
  })

  it('searches on name and description, ignoring case, and returns everything for an empty query', () => {
    const all = publicLayers()
    expect(searchLayers(all, '').length).toBe(all.length)
    expect(searchLayers(all, '   ').length).toBe(all.length)
    expect(searchLayers(all, 'life expectancy').map(l => l.id)).toEqual(['life_expectancy'])
    // description-only match: no layer is NAMED for poverty lines
    expect(searchLayers(all, 'federal poverty line').map(l => l.id)).toEqual(['poverty_by_race'])
    expect(searchLayers(all, 'zzzz')).toEqual([])
  })

  /**
   * P5-64: "housing" could not find Median Home Value, because the word is in
   * neither its name nor its description — it is the name of the group the
   * layer sits in. The subject a person types is usually the category label,
   * so the matcher reads it too, from the same taxonomy /layers labels with.
   */
  it('matches the category label as well, so a subject word finds its group', () => {
    const all = publicLayers()
    const housing = searchLayers(all, 'housing').map(l => l.id)
    expect(housing).toContain('median_home_value')
    expect(housing).toContain('median_property_tax')
    // "People" is the plain word for the demographic category.
    const people = searchLayers(all, 'people').map(l => l.id)
    expect(people).toContain('pct_Black')
    expect(people).toContain('diversity_index')
    // Every layer of a matched category comes back, and nothing else does.
    expect(searchLayers(all, 'getting to work').map(l => l.id).sort()).toEqual(
      all.filter(l => l.category === 'transportation').map(l => l.id).sort(),
    )
  })

  it('finds one layer by id and refuses an internal or unknown id', () => {
    expect(getPublicLayer('pct_Black')?.name).toBe('Percent Black')
    expect(getPublicLayer('internal-anything')).toBeNull()
    expect(getPublicLayer('nope')).toBeNull()
  })
})

describe('publicLayers — plain-language descriptions of a layer', () => {
  it('says which way is better and what kind of number it is', () => {
    expect(directionLabel('higher_better')).toBe('higher is better')
    expect(directionLabel('lower_better')).toBe('lower is better')
    expect(dataTypeLabel('currency')).toBe('dollars')
    expect(dataTypeLabel('percentage')).toBe('percentage')
    expect(dataTypeLabel('ordinal')).toBe('category')
  })

  it('names the source and year, and is honest when the registry has neither', () => {
    expect(sourceLine(layer())).toBe('Test source · 2024')
    expect(sourceLine(layer({ year: '' }))).toBe('Test source')
    expect(sourceLine(layer({ source: '', year: '' }))).toBe(SOURCE_NOT_RECORDED)
  })

  it('publisherLine is the knowledge base’s word for the same line (P5-67)', () => {
    expect(publisherLine(layer())).toBe('Test source · 2024')
    expect(publisherLine(layer({ source: '', year: '' }))).toBe(PUBLISHER_NOT_RECORDED)
    expect(PUBLISHER_NOT_RECORDED).toBe('Publisher: not recorded')
    expect(SOURCE_NOT_RECORDED).toBe('Source: not recorded')
    expect(sourceLine(layer({ source: '   ', year: 2024 }))).toBe(SOURCE_NOT_RECORDED)
  })

  it('formats the range with the layer own formatter', () => {
    expect(rangeLine(layer())).toBe('$100 to $900')
  })

  it('writes the question the Ask box starts with', () => {
    expect(askQuestionFor(layer())).toBe('What does the Test layer layer measure and where does it come from?')
  })

  it('sends public ids to their about page and internal ids to their library entry', () => {
    expect(layerAboutHref('pct_Black')).toBe('/layers/pct_Black')
    expect(layerAboutHref('internal-organizations')).toBe('/library/organizations')
  })
})

describe('publicLayers — county rows', () => {
  const names: Record<string, { county: string; state: string }> = {
    '01001': { county: 'Autauga County', state: 'Alabama' },
    '13121': { county: 'Fulton County', state: 'Georgia' },
  }
  const nameFor = (geoId: string) => names[geoId] ?? null

  it('joins values to county names, formats each value, and drops counties with no value', () => {
    const rows = buildCountyRows(
      layer(),
      { '01001': { test_value: 250 }, '13121': { test_value: 700 }, '99999': { test_value: null } },
      nameFor,
    )
    expect(rows).toEqual([
      { geoId: '01001', county: 'Autauga County', state: 'Alabama', value: 250, display: '$250' },
      { geoId: '13121', county: 'Fulton County', state: 'Georgia', value: 700, display: '$700' },
    ])
  })

  it('falls back to the record own county name, then to the GEOID, when the lookup has no entry', () => {
    const rows = buildCountyRows(
      layer(),
      { '48001': { test_value: 1, county_name: 'Anderson County', state_name: 'Texas' }, '48002': { test_value: 2 } },
      nameFor,
    )
    expect(rows[0]).toMatchObject({ county: 'Anderson County', state: 'Texas' })
    expect(rows[1]).toMatchObject({ county: '48002', state: '' })
  })

  it('reads a bare number record (the contamination counts are keyed straight to a number)', () => {
    const rows = buildCountyRows(layer({ dataKey: 'total' }), { '01001': 12 }, nameFor)
    expect(rows[0]).toMatchObject({ geoId: '01001', value: 12, display: '$12' })
  })

  it('searches county and state names, not the numbers', () => {
    const rows = buildCountyRows(layer(), { '01001': { test_value: 250 }, '13121': { test_value: 700 } }, nameFor)
    expect(filterCountyRows(rows, 'fulton').map(r => r.geoId)).toEqual(['13121'])
    expect(filterCountyRows(rows, 'alabama').map(r => r.geoId)).toEqual(['01001'])
    expect(filterCountyRows(rows, '').map(r => r.geoId)).toEqual(['01001', '13121'])
    expect(filterCountyRows(rows, '250')).toEqual([])
  })

  it('sorts by name or value in either direction, with text values compared as text', () => {
    const rows: CountyValueRow[] = [
      { geoId: '2', county: 'Bibb County', state: 'Georgia', value: 30, display: '30' },
      { geoId: '1', county: 'Autauga County', state: 'Alabama', value: 200, display: '200' },
      { geoId: '3', county: 'Clay County', state: 'Alabama', value: null, display: '—' },
    ]
    expect(sortCountyRows(rows, 'name', 'asc').map(r => r.geoId)).toEqual(['1', '2', '3'])
    expect(sortCountyRows(rows, 'name', 'desc').map(r => r.geoId)).toEqual(['3', '2', '1'])
    expect(sortCountyRows(rows, 'value', 'asc').map(r => r.geoId)).toEqual(['2', '1', '3'])
    // blanks stay last whichever way the column is pointed — they are not "the biggest"
    expect(sortCountyRows(rows, 'value', 'desc').map(r => r.geoId)).toEqual(['1', '2', '3'])
  })

  it('pages', () => {
    const rows = [1, 2, 3, 4, 5]
    expect(pageOf(rows, 1, 2)).toEqual([1, 2])
    expect(pageOf(rows, 3, 2)).toEqual([5])
    expect(pageOf(rows, 9, 2)).toEqual([])
  })

  it('writes a CSV of the rows it is given, quoting names that contain commas', () => {
    const rows: CountyValueRow[] = [
      { geoId: '01001', county: 'Autauga County', state: 'Alabama', value: 250, display: '$250' },
      { geoId: '24510', county: 'Baltimore, city of', state: 'Maryland', value: null, display: '—' },
    ]
    expect(rowsToCsv(layer(), rows)).toBe(
      ['GEOID,County,State,test_value', '01001,Autauga County,Alabama,250', '24510,"Baltimore, city of",Maryland,'].join('\n'),
    )
    expect(csvFilename(layer())).toBe('test_layer-by-county.csv')
  })
})

describe('publicLayers — loading only what the page needs', () => {
  beforeEach(() => {
    mockedMapData.mockReset()
    mockedInit.mockReset()
    mockedCounty.mockReset()
  })

  it('calls only the loader for the layer own data and joins the county lookup', async () => {
    const loadHousingData = vi.fn().mockResolvedValue(undefined)
    const loadAllCountyData = vi.fn()
    mockedMapData.mockReturnValue({
      loadHousingData,
      loadAllCountyData,
      housingData: { value: { '01001': { median_home_value: 150000 } } },
    } as unknown as ReturnType<typeof useMapData>)
    mockedInit.mockResolvedValue(undefined)
    mockedCounty.mockReturnValue({ geoId: '01001', name: 'Autauga County', baseName: 'Autauga', stateName: 'Alabama', stateAbbr: 'AL' })

    const rows = await loadCountyRows(LAYER_REGISTRY.median_home_value)
    expect(loadHousingData).toHaveBeenCalledTimes(1)
    expect(loadAllCountyData).not.toHaveBeenCalled()
    expect(rows).toEqual([{ geoId: '01001', county: 'Autauga County', state: 'Alabama', value: 150000, display: '$150,000' }])
  })

  it('still returns rows when the county-name lookup is unavailable', async () => {
    mockedMapData.mockReturnValue({
      loadContaminationData: vi.fn().mockResolvedValue(undefined),
      countyContaminationCounts: { '01001': { total: 3 } },
    } as unknown as ReturnType<typeof useMapData>)
    mockedInit.mockRejectedValue(new Error('offline'))

    const rows = await loadCountyRows(LAYER_REGISTRY.contamination)
    expect(rows).toEqual([{ geoId: '01001', county: '01001', state: '', value: 3, display: '3 sites' }])
    expect(mockedCounty).not.toHaveBeenCalled()
  })

  it('has a data source for every public layer — a new registry entry cannot ship without one', () => {
    for (const l of publicLayers()) expect(Object.keys(LAYER_DATA_SOURCES)).toContain(l.id)
    expect(Object.keys(LAYER_DATA_SOURCES).sort()).toEqual(publicLayers().map(l => l.id).sort())
  })

  it('refuses a layer nothing knows how to load, rather than showing an empty table', async () => {
    mockedMapData.mockReturnValue({} as unknown as ReturnType<typeof useMapData>)
    await expect(loadCountyRows(layer({ id: 'made_up' }))).rejects.toThrow(/made_up/)
  })
})

describe('publicLayers — the server copy of the registry', () => {
  it('matches the exported JSON the Ask index reads (run `npm run export:layers` after editing the registry)', () => {
    const path = resolve(process.cwd(), 'server/src/prompt/publicLayers.generated.json')
    const exported = JSON.parse(readFileSync(path, 'utf8')) as { id: string }[]
    const publicIds = getAllLayerIds().filter(id => isPublicLayerId(id))
    expect(exported.map(l => l.id)).toEqual(publicIds)
  })
})

/**
 * P6-1 / P6-2 — a public map layer as the datasets browser files it. No UI
 * here yet; this is the pair of fields P6-3 groups the registry rows by,
 * alongside the library's own.
 */
import { layerOrganization, layerOrganizationLabel, publicLayerShapeLabel, PUBLIC_LAYER_SHAPE } from '../publicLayers'

describe('a public layer’s organization and shape (P6-1, P6-2)', () => {
  it('folds the registry’s source prose through the vocabulary', () => {
    expect(layerOrganization({ source: 'US Census Bureau' })).toBe('census')
    expect(layerOrganization({ source: 'Urban Institute - Diversity Data Kids' })).toBe('urban-institute')
    expect(layerOrganization({ source: 'Environmental Protection Agency (EPA)' })).toBe('epa')
    expect(layerOrganizationLabel({ source: 'Black Worker Data Center (BWDC)' })).toBe('Black Worker Data Center')
  })

  it('files every layer that ships publicly under a publisher', () => {
    for (const layer of publicLayers()) {
      expect(layerOrganization(layer), `${layer.id}: "${layer.source}"`).not.toBe('')
      expect(layerOrganizationLabel(layer), layer.id).not.toBe('')
    }
  })

  it('keeps an unrecognised publisher’s own words, and says nothing about none', () => {
    expect(layerOrganization({ source: 'Somebody New' })).toBe('Somebody New')
    expect(layerOrganization({ source: '' })).toBe('')
    expect(layerOrganizationLabel({ source: '' })).toBe('')
  })

  it('calls every public layer statistics, because a county value is what one is', () => {
    expect(PUBLIC_LAYER_SHAPE).toBe('statistics')
    expect(publicLayerShapeLabel()).toBe('Statistics by county or tract')
  })
})
