import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  browseQuery,
  facetsFor,
  facetsOf,
  groupRows,
  matchesAnyFilter,
  matchesFilter,
  matchesQuery,
  NONE_VALUE,
  queryValue,
  readStoredChoice,
  resolveChoice,
  writeStoredChoice,
  type GroupKey,
} from '../browse'

interface Row {
  title: string
  organization: string
  organizationLabel: string
}

const row = (title: string, organization: string, organizationLabel = organization): Row => ({
  title,
  organization,
  organizationLabel,
})

const byOrganization = (r: Row): GroupKey => ({ id: r.organization, label: r.organizationLabel || 'No organization' })

describe('groupRows (P6-3)', () => {
  it('groups rows by the key, counts them, and keeps the incoming order inside a group', () => {
    const groups = groupRows(
      [row('a', 'epa', 'US EPA'), row('b', 'usgs', 'USGS'), row('c', 'epa', 'US EPA')],
      byOrganization,
    )
    expect(groups.map(g => [g.id, g.label, g.count])).toEqual([
      ['epa', 'US EPA', 2],
      ['usgs', 'USGS', 1],
    ])
    expect(groups[0].rows.map(r => r.title)).toEqual(['a', 'c'])
  })

  it('sorts by count, then by name', () => {
    const groups = groupRows(
      [
        row('1', 'usgs', 'USGS'),
        row('2', 'epa', 'US EPA'),
        row('3', 'epa', 'US EPA'),
        row('4', 'fema', 'FEMA'),
        row('5', 'fema', 'FEMA'),
      ],
      byOrganization,
    )
    // Two twos: FEMA before US EPA on the name. USGS's one comes last.
    expect(groups.map(g => g.label)).toEqual(['FEMA', 'US EPA', 'USGS'])
  })

  it('keeps an unknown publisher as its own group, headed by its own text', () => {
    const groups = groupRows(
      [row('a', 'Memphis Horticulture Society'), row('b', 'epa', 'US EPA')],
      byOrganization,
    )
    expect(groups.map(g => g.label)).toEqual(['Memphis Horticulture Society', 'US EPA'])
    expect(groups.find(g => g.id === 'Memphis Horticulture Society')?.count).toBe(1)
  })

  it('puts the group for rows with no value last, however many are in it', () => {
    const groups = groupRows(
      [row('a', ''), row('b', ''), row('c', ''), row('d', 'epa', 'US EPA')],
      byOrganization,
    )
    expect(groups.map(g => [g.label, g.count])).toEqual([
      ['US EPA', 1],
      ['No organization', 3],
    ])
  })

  it('returns nothing for no rows', () => {
    expect(groupRows([], byOrganization)).toEqual([])
  })
})

describe('facetsOf (P6-3)', () => {
  it('counts each value in the same order the groups take, without the rows', () => {
    const facets = facetsOf([row('a', 'epa', 'US EPA'), row('b', 'epa', 'US EPA'), row('c', '')], byOrganization)
    expect(facets).toEqual([
      { id: 'epa', label: 'US EPA', count: 2 },
      { id: '', label: 'No organization', count: 1 },
    ])
  })
})

describe('matchesQuery (P6-3)', () => {
  it('matches when every word is found somewhere, in any order', () => {
    expect(matchesQuery('TELE landowner profiles — Georgia', 'georgia landowner')).toBe(true)
    expect(matchesQuery('TELE landowner profiles — Georgia', 'georgia alabama')).toBe(false)
  })

  it('is case-insensitive and ignores extra whitespace', () => {
    expect(matchesQuery('Superfund NPL sites', '  SUPERFUND   sites ')).toBe(true)
  })

  it('matches everything when the query is empty', () => {
    expect(matchesQuery('anything at all', '')).toBe(true)
    expect(matchesQuery('anything at all', '   ')).toBe(true)
  })
})

describe('matchesFilter (P6-3)', () => {
  it('lets everything through when nothing is chosen', () => {
    expect(matchesFilter('epa', '')).toBe(true)
    expect(matchesFilter('', '')).toBe(true)
  })

  it('matches one value exactly', () => {
    expect(matchesFilter('epa', 'epa')).toBe(true)
    expect(matchesFilter('usgs', 'epa')).toBe(false)
  })

  it('finds the rows with nothing at all under the "none" chip', () => {
    expect(matchesFilter('', NONE_VALUE)).toBe(true)
    expect(matchesFilter('epa', NONE_VALUE)).toBe(false)
  })
})

describe('the remembered choice (P6-3)', () => {
  const KEY = 'blo:test-group'

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads back what was written', () => {
    writeStoredChoice(KEY, 'topic')
    expect(readStoredChoice(KEY, ['organization', 'topic', 'type'], 'organization')).toBe('topic')
  })

  it('falls back when nothing was stored, or when the stored word is not one of the choices', () => {
    expect(readStoredChoice(KEY, ['organization', 'topic'], 'organization')).toBe('organization')
    localStorage.setItem(KEY, 'publisher')
    expect(readStoredChoice(KEY, ['organization', 'topic'], 'organization')).toBe('organization')
  })

  it('survives storage that throws — a private window is not an error page', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => writeStoredChoice(KEY, 'topic')).not.toThrow()
    expect(readStoredChoice(KEY, ['organization', 'topic'], 'organization')).toBe('organization')
  })
})

describe('resolveChoice (P6-3)', () => {
  const ALLOWED = ['organization', 'topic', 'type']

  it('lets the URL win over what was remembered', () => {
    expect(resolveChoice('topic', 'type', ALLOWED, 'organization')).toBe('topic')
  })

  it('uses the remembered choice when the URL says nothing', () => {
    expect(resolveChoice('', 'type', ALLOWED, 'organization')).toBe('type')
  })

  it('falls back when neither is a choice we offer', () => {
    expect(resolveChoice('publisher', 'agency', ALLOWED, 'organization')).toBe('organization')
  })
})

describe('the URL keys (P6-3)', () => {
  it('reads one trimmed string out of a route query', () => {
    expect(queryValue({ q: ' superfund ' }, 'q')).toBe('superfund')
    expect(queryValue({ q: ['first', 'second'] }, 'q')).toBe('first')
    expect(queryValue({ q: null }, 'q')).toBe('')
    expect(queryValue({}, 'q')).toBe('')
  })

  it('writes only the keys that have something in them, so a bare page is a bare URL', () => {
    expect(browseQuery({ q: 'epa', topic: '', group: 'topic' })).toEqual({ q: 'epa', group: 'topic' })
    expect(browseQuery({ q: '', topic: '' })).toEqual({})
  })
})

describe('facetsFor — the chosen chip survives a combination that matches nothing (P6-22)', () => {
  const all = [row('EPA air', 'epa', 'US EPA'), row('EPA water', 'epa', 'US EPA'), row('BLO homestead', 'blo', 'Black Land Ownership (BLO)')]
  // What a search for "homestead" leaves: no EPA row survives.
  const filtered = [all[2]]

  it('counts off the filtered rows when the chosen value is still among them', () => {
    expect(facetsFor(all, all, byOrganization, 'epa')).toEqual([
      { id: 'epa', label: 'US EPA', count: 2 },
      { id: 'blo', label: 'Black Land Ownership (BLO)', count: 1 },
    ])
  })

  it('re-inserts the chosen value at a true count of zero, with its real label', () => {
    const facets = facetsFor(all, filtered, byOrganization, 'epa')
    expect(facets[0]).toEqual({ id: 'epa', label: 'US EPA', count: 0 })
    expect(facets.map(f => f.id)).toContain('blo')
  })

  it('never advertises a count the empty list would contradict', () => {
    const facets = facetsFor(all, [], byOrganization, 'epa')
    expect(facets).toEqual([{ id: 'epa', label: 'US EPA', count: 0 }])
  })

  it('leaves the facets alone when nothing is chosen', () => {
    expect(facetsFor(all, filtered, byOrganization, '')).toEqual(facetsOf(filtered, byOrganization))
  })

  it('handles the "has none" chip, which travels as NONE_VALUE but groups as an empty id', () => {
    const withBlank = [...all, row('orphan', '', '')]
    const facets = facetsFor(withBlank, [withBlank[2]], byOrganization, NONE_VALUE)
    expect(facets[0]).toEqual({ id: '', label: 'No organization', count: 0 })
  })

  it('falls back to the value itself when the whole set has never seen it', () => {
    const facets = facetsFor(all, [], byOrganization, 'ministry-of-nothing')
    expect(facets[0]).toEqual({ id: 'ministry-of-nothing', label: 'ministry-of-nothing', count: 0 })
  })
})

/**
 * P6-19: a facet a row can be under more than one of at once. Coverage is the
 * first — a table whose rows are in four states belongs under all four state
 * chips, because "what do we hold for Georgia?" has to find it.
 */
describe('a facet with several values per row (P6-19)', () => {
  interface Placed {
    title: string
    states: string[]
  }
  const placed = (title: string, ...states: string[]): Placed => ({ title, states })
  const byState = (r: Placed): GroupKey[] =>
    r.states.length ? r.states.map(code => ({ id: code, label: code })) : [{ id: '', label: 'No coverage' }]

  const ROWS = [placed('a', 'GA'), placed('b', 'GA', 'MS', 'TN'), placed('c', 'MS'), placed('d')]

  it('counts each VALUE, so one row can add to several chips', () => {
    expect(facetsOf(ROWS, byState)).toEqual([
      { id: 'GA', label: 'GA', count: 2 },
      { id: 'MS', label: 'MS', count: 2 },
      { id: 'TN', label: 'TN', count: 1 },
      // "Has none of these" is pinned last, as it is for a single-valued facet.
      { id: '', label: 'No coverage', count: 1 },
    ])
  })

  it('counts a row once per chip even when it repeats a value', () => {
    // A derivation that handed back the same state twice must not make a chip
    // bigger than the list it describes.
    expect(facetsOf([placed('a', 'GA', 'GA')], byState)).toEqual([{ id: 'GA', label: 'GA', count: 1 }])
  })

  it('still guarantees the chosen chip survives a combination matching nothing (P6-22)', () => {
    const facets = facetsFor(ROWS, [], byState, 'TN')
    expect(facets[0]).toEqual({ id: 'TN', label: 'TN', count: 0 })
  })

  it('reads `none` as the rows with no values at all', () => {
    const facets = facetsFor(ROWS, [], byState, NONE_VALUE)
    expect(facets[0]).toEqual({ id: '', label: 'No coverage', count: 0 })
  })

  it('matches a row on ANY of its values, which is what keeps a chip and its list one set', () => {
    expect(matchesAnyFilter(['GA', 'MS', 'TN'], 'MS')).toBe(true)
    expect(matchesAnyFilter(['GA', 'MS', 'TN'], 'AL')).toBe(false)
    // No filter is every row, in both shapes.
    expect(matchesAnyFilter([], '')).toBe(true)
    expect(matchesAnyFilter(['GA'], '')).toBe(true)
    // And a row with no values at all is the `none` row.
    expect(matchesAnyFilter([], NONE_VALUE)).toBe(true)
    expect(matchesAnyFilter(['GA'], NONE_VALUE)).toBe(false)
    expect(matchesAnyFilter([], 'GA')).toBe(false)
  })

  it('leaves every existing single-valued caller alone', () => {
    // The generalisation is in the chips only; one key per row still works and
    // still reads identically.
    expect(facetsOf([row('a', 'epa', 'US EPA'), row('b', 'epa', 'US EPA')], byOrganization)).toEqual([
      { id: 'epa', label: 'US EPA', count: 2 },
    ])
  })
})
