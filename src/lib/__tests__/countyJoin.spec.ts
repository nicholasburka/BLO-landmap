import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/publicLayers', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/publicLayers')>()
  return { ...actual, loadCountyRows: vi.fn() }
})

import { loadCountyRows, LAYER_DATA_SOURCES, publicLayers, type CountyValueRow } from '@/lib/publicLayers'
import type { DatasetRow } from '@/lib/libraryData'
import {
  MAX_CONTEXT_LAYERS,
  MISSING_VALUE,
  contextCell,
  contextLayerGroups,
  contextLayerName,
  contextLayers,
  contextLayersParam,
  contextValue,
  findGeoIdColumn,
  isContextLayerId,
  loadContextValues,
  normalizeGeoId,
  parseContextLayers,
  rowGeoId,
  sortRowsByContext,
  tableCsv,
  type CountyValues,
} from '../countyJoin'

const mockedLoad = vi.mocked(loadCountyRows)

const row = (over: Partial<DatasetRow> = {}): DatasetRow => ({ _row: 0, ...over }) as DatasetRow

/** Three organizations: two in counties we have numbers for, one nowhere. */
const ROWS: DatasetRow[] = [
  row({ _row: 0, Organization: 'Black Farmer Fund', GEOID: '36061' }),
  row({ _row: 1, Organization: 'Southwest Georgia Project', GEOID: '13321' }),
  row({ _row: 2, Organization: 'Truly Living Well', GEOID: '' }),
]

const county = (geoId: string, value: number | string | null, display: string): CountyValueRow => ({
  geoId,
  county: 'Somewhere',
  state: 'ST',
  value,
  display,
})

const VALUES: CountyValues = new Map([
  ['36061', county('36061', 900000, '$900,000')],
  ['13321', county('13321', 84500, '$84,500')],
])

beforeEach(() => {
  mockedLoad.mockReset()
})

describe('normalizeGeoId', () => {
  it.each([
    ['13321', '13321'],
    ['  13321  ', '13321'],
    // a spreadsheet ate the leading zero — 1001 is Autauga County, Alabama
    ['1001', '01001'],
    // written out of a float column
    ['01001.0', '01001'],
  ])('reads %j as %j', (input, expected) => {
    expect(normalizeGeoId(input)).toBe(expected)
  })

  it.each([['', '13'], ['1310100', 'Fulton County'], ['13321-1', '  ']])(
    'refuses %j — a wrong county is worse than none',
    (input: string) => {
      expect(normalizeGeoId(input)).toBeNull()
    },
  )

  it('accepts a number cell as well as a string', () => {
    expect(normalizeGeoId(13321)).toBe('13321')
    expect(normalizeGeoId(1001)).toBe('01001')
    expect(normalizeGeoId(null)).toBeNull()
  })
})

describe('findGeoIdColumn', () => {
  it('finds the column P5-23 geocoding writes next to lat/lng', () => {
    const columns = [{ name: 'Organization' }, { name: 'lat' }, { name: 'lng' }, { name: 'GEOID' }]
    expect(findGeoIdColumn(columns, ROWS)).toBe('GEOID')
  })

  it.each([['geoid'], ['GEOID'], ['fips'], ['FIPS'], ['County FIPS'], ['county_fips']])(
    'accepts a column named %j',
    name => {
      expect(findGeoIdColumn([{ name: 'Organization' }, { name }], [row({ [name]: '13321' })])).toBe(name)
    },
  )

  it('prefers GEOID when a file carries both spellings', () => {
    const columns = [{ name: 'fips' }, { name: 'GEOID' }]
    expect(findGeoIdColumn(columns, [row({ fips: '13', GEOID: '13321' })])).toBe('GEOID')
  })

  it('returns null when no column is named like a county key', () => {
    expect(findGeoIdColumn([{ name: 'Organization' }, { name: 'Zip' }], ROWS)).toBeNull()
  })

  it('returns null when the named column holds something else (state codes)', () => {
    const columns = [{ name: 'FIPS' }]
    expect(findGeoIdColumn(columns, [row({ FIPS: '13' }), row({ FIPS: '01' })])).toBeNull()
  })

  it('trusts the name when there are no rows to check yet', () => {
    expect(findGeoIdColumn([{ name: 'GEOID' }])).toBe('GEOID')
  })
})

describe('which layers can be joined', () => {
  it('offers every public layer that has a county loader behind it', () => {
    const ids = contextLayers().map(l => l.id)
    expect(ids.length).toBeGreaterThan(0)
    expect(ids).toEqual(publicLayers().filter(l => l.id in LAYER_DATA_SOURCES).map(l => l.id))
    expect(ids).toContain('median_home_value')
    // internal library layers are never public county layers
    expect(ids.every(id => !id.startsWith('internal-'))).toBe(true)
  })

  it('groups them the way /layers does, and searches by subject', () => {
    const groups = contextLayerGroups('home value')
    expect(groups.map(g => g.label)).toEqual(['Housing'])
    expect(groups[0].layers.map(l => l.id)).toEqual(['median_home_value'])
  })

  it('names a layer for the column header', () => {
    expect(contextLayerName('median_home_value')).toBe('Median Home Value')
    expect(contextLayerName('nope')).toBe('nope')
  })

  it('knows an unjoinable id when it sees one', () => {
    expect(isContextLayerId('median_home_value')).toBe(true)
    expect(isContextLayerId('internal-orgs')).toBe(false)
    expect(isContextLayerId('made_up')).toBe(false)
  })
})

describe('URL persistence (?layers=)', () => {
  it('round-trips the selection', () => {
    const ids = ['median_home_value', 'life_expectancy']
    expect(parseContextLayers(contextLayersParam(ids))).toEqual(ids)
  })

  it('drops unknown ids and duplicates instead of throwing', () => {
    expect(parseContextLayers('median_home_value,made_up,median_home_value,internal-orgs')).toEqual([
      'median_home_value',
    ])
  })

  it('caps a hand-edited link so one page cannot pull every dataset', () => {
    const many = publicLayers().map(l => l.id).join(',')
    expect(parseContextLayers(many)).toHaveLength(MAX_CONTEXT_LAYERS)
    expect(contextLayersParam(publicLayers().map(l => l.id)).split(',')).toHaveLength(MAX_CONTEXT_LAYERS)
  })

  it('reads nothing out of a missing or empty param', () => {
    expect(parseContextLayers(undefined)).toEqual([])
    expect(parseContextLayers('')).toEqual([])
    expect(parseContextLayers(['median_home_value', 'life_expectancy'])).toEqual([
      'median_home_value',
      'life_expectancy',
    ])
    expect(contextLayersParam([])).toBe('')
  })
})

describe('loadContextValues', () => {
  it('loads one layer through the shared county loader and keys it by GEOID', async () => {
    mockedLoad.mockResolvedValue([county('13321', 84500, '$84,500')])
    const values = await loadContextValues('median_home_value')
    expect(mockedLoad).toHaveBeenCalledTimes(1)
    expect(mockedLoad.mock.calls[0][0].id).toBe('median_home_value')
    expect(values.get('13321')?.display).toBe('$84,500')
  })

  it('refuses an unknown layer rather than loading nothing', async () => {
    await expect(loadContextValues('made_up')).rejects.toThrow(/made_up/)
    expect(mockedLoad).not.toHaveBeenCalled()
  })
})

describe('the join', () => {
  it('shows the layer’s own formatted value against the row’s county', () => {
    expect(contextCell(VALUES, rowGeoId(ROWS[0], 'GEOID'))).toBe('$900,000')
    expect(contextCell(VALUES, rowGeoId(ROWS[1], 'GEOID'))).toBe('$84,500')
  })

  it('reads “—” when the row has no GEOID, the county is missing, or nothing is loaded yet', () => {
    expect(contextCell(VALUES, rowGeoId(ROWS[2], 'GEOID'))).toBe(MISSING_VALUE)
    expect(contextCell(VALUES, '99999')).toBe(MISSING_VALUE)
    expect(contextCell(undefined, '13321')).toBe(MISSING_VALUE)
    expect(contextCell(VALUES, rowGeoId(ROWS[0], null))).toBe(MISSING_VALUE)
  })

  it('joins through a padded GEOID', () => {
    const values: CountyValues = new Map([['01001', county('01001', 1, 'one')]])
    expect(contextCell(values, rowGeoId(row({ fips: '1001' }), 'fips'))).toBe('one')
  })

  it('hands back the raw number for sorting, not the formatted string', () => {
    expect(contextValue(VALUES, '36061')).toBe(900000)
    expect(contextValue(VALUES, '99999')).toBeNull()
  })
})

describe('sortRowsByContext', () => {
  it('sorts the page by the joined value, with unmatched rows last both ways', () => {
    const asc = sortRowsByContext(ROWS, 'GEOID', VALUES, 'asc')
    expect(asc.map(r => r._row)).toEqual([1, 0, 2])
    const desc = sortRowsByContext(ROWS, 'GEOID', VALUES, 'desc')
    expect(desc.map(r => r._row)).toEqual([0, 1, 2])
  })

  it('leaves the rows themselves alone (a copy is sorted)', () => {
    const before = ROWS.map(r => r._row)
    sortRowsByContext(ROWS, 'GEOID', VALUES, 'desc')
    expect(ROWS.map(r => r._row)).toEqual(before)
  })

  it('sorts text values alphabetically', () => {
    const values: CountyValues = new Map([
      ['36061', county('36061', 'High', 'High')],
      ['13321', county('13321', 'Low', 'Low')],
    ])
    expect(sortRowsByContext(ROWS, 'GEOID', values, 'asc').map(r => r._row)).toEqual([0, 1, 2])
  })
})

describe('tableCsv', () => {
  it('writes the columns on screen plus the joined ones', () => {
    const csv = tableCsv(ROWS, ['Organization', 'GEOID'], 'GEOID', [
      { name: 'Median Home Value', values: VALUES },
    ])
    expect(csv.split('\r\n')).toEqual([
      'Organization,GEOID,Median Home Value',
      'Black Farmer Fund,36061,"$900,000"',
      'Southwest Georgia Project,13321,"$84,500"',
      'Truly Living Well,,—',
      '',
    ])
  })

  it('escapes a cell that would open as a spreadsheet formula (server rule)', () => {
    const csv = tableCsv([row({ Organization: '=cmd()' })], ['Organization'], null, [])
    expect(csv).toBe("Organization\r\n'=cmd()\r\n")
  })
})
