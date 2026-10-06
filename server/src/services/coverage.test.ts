import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  coverageFromGeoids,
  coverageFromManifest,
  coverageFromSignals,
  coverageFromSource,
  coverageLabel,
  deriveCoverage,
  parseCoverage,
  pickCoverageFile,
  readCoverageSignals,
  resetCoverageWarnings,
  splitRow,
  statedCoverage,
  stateNamingPublisher,
  COUNTY_DETAIL_MAX,
  LOCAL,
  NATIONAL,
  NATIONAL_STATE_COUNT,
  PUBLIC_LAYER_COVERAGE,
} from './coverage.js'
import { US_STATES } from './taxonomy.js'

/**
 * P6-19. One test per rule in the derivation, the 45-state threshold at its
 * boundary, and the two things a derivation has to get right to be trusted:
 * the manifest's own word wins, and nothing determinable produces NO coverage
 * rather than a quiet "national".
 */

beforeEach(() => resetCoverageWarnings())
afterEach(() => vi.restoreAllMocks())

const dataset = (meta: Record<string, unknown>, files: string[] = []) => ({ kind: 'dataset', meta, files, slug: 'x' })
const source = (block: Record<string, unknown>) => ({ kind: 'source', meta: { source: block }, files: [], slug: 'x' })
const read = (files: Record<string, string>) => async (name: string) => files[name] ?? null

/** Every state's code, for the threshold tests. */
const CODES = US_STATES.filter(s => s.fips <= '56').map(s => s.code)

describe('coverage — the manifest’s own word', () => {
  it('wins over everything the entry would otherwise be read as', async () => {
    // A national source that a person says is really Georgia only.
    const input = {
      kind: 'source',
      meta: { coverage: 'state:GA', source: { provider: 'US EPA', coverage: 'national' } },
      files: [],
      slug: 'x',
    }
    expect(statedCoverage(input)).toMatchObject({ scope: 'state', states: ['GA'] })
    expect(await deriveCoverage(input)).toMatchObject({ scope: 'state', states: ['GA'], label: 'Georgia' })
    // And a held table whose GEOIDs say Tennessee.
    const held = dataset({ coverage: 'national' }, ['t.csv'])
    expect(await deriveCoverage(held, read({ 't.csv': 'GEOID\n47157\n' }))).toEqual(NATIONAL)
  })

  it('reads the spellings a hand-typed manifest uses', () => {
    expect(parseCoverage(' National ')).toEqual(NATIONAL)
    expect(parseCoverage('nationwide')).toEqual(NATIONAL)
    expect(parseCoverage('state:ga')).toMatchObject({ scope: 'state', states: ['GA'] })
    expect(parseCoverage('Georgia')).toMatchObject({ scope: 'state', states: ['GA'], label: 'Georgia' })
    expect(parseCoverage('13')).toMatchObject({ scope: 'state', states: ['GA'] })
    expect(parseCoverage('state:GA,AL,SC')).toMatchObject({ scope: 'multi-state', states: ['AL', 'GA', 'SC'] })
    expect(parseCoverage('Georgia and Alabama')).toMatchObject({ scope: 'multi-state', states: ['AL', 'GA'] })
    expect(parseCoverage('local')).toEqual(LOCAL)
  })

  it('names counties when a manifest names them', () => {
    expect(parseCoverage('county:13121,13089')).toMatchObject({
      scope: 'county',
      states: ['GA'],
      counties: ['13089', '13121'],
      label: 'Georgia',
    })
  })

  it('reads the scope through a human’s qualifier, and keeps the qualifier (P6-32)', () => {
    // Both of these are in the real tree, on the two NOAA sources. A national
    // product whose extent is coastal IS national — imprecise, not wrong — so
    // the scope is read and the qualifier rides along saying a more precise
    // answer exists. Dropping to "no coverage" would trade a good-enough
    // answer for none.
    expect(parseCoverage('national (coastal states and territories only)')).toEqual({
      ...NATIONAL,
      note: 'coastal states and territories only',
    })
    expect(parseCoverage('national (Gulf and Atlantic coasts, Hawaii, Puerto Rico)')).toMatchObject({
      scope: 'national',
      note: 'Gulf and Atlantic coasts, Hawaii, Puerto Rico',
    })
  })

  it('carries a qualifier onto a stated list too, not just a scope word', () => {
    expect(parseCoverage('state:GA (pilot counties only)')).toMatchObject({
      scope: 'state',
      states: ['GA'],
      note: 'pilot counties only',
    })
  })

  it('refuses prose it cannot read, rather than finding a state in a sentence', () => {
    // The shape `source.coverage` takes when the model wrote it. A parser loose
    // enough to answer this would answer it wrong.
    expect(parseCoverage('2013 to 2023, all 50 states and Puerto Rico')).toBeNull()
    expect(parseCoverage('the Southeast')).toBeNull()
    expect(parseCoverage('counties in the Black Belt')).toBeNull()
    // A scope word that names no state says no more than "somewhere in the US".
    expect(parseCoverage('state')).toBeNull()
    expect(parseCoverage('')).toBeNull()
  })

  it('drops an unreadable `coverage:` with one warning naming it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const input = { kind: 'dataset', meta: { coverage: 'the Southeast' }, files: [], slug: 'soil-map' }
    expect(await deriveCoverage(input)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('the Southeast')
    expect(warn.mock.calls[0][0]).toContain('soil-map')
    // One per entry, not one per read.
    expect(await deriveCoverage(input)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('reads back the object a previous reindex stored, and rebuilds a broken one', () => {
    expect(statedCoverage(dataset({ coverage: { scope: 'state', states: ['GA'], label: 'Georgia' } }))).toMatchObject({
      scope: 'state',
      states: ['GA'],
    })
    // A scope nobody knows, with usable states: rebuilt from the states.
    expect(statedCoverage(dataset({ coverage: { scope: 'the-southeast', states: ['GA', 'AL'] } }))).toMatchObject({
      scope: 'multi-state',
      states: ['AL', 'GA'],
    })
    // Nothing usable at all is no coverage, the same as never having been read.
    expect(statedCoverage(dataset({ coverage: { states: [] } }))).toBeNull()
  })
})

describe('coverage — a source block', () => {
  it('reads the block’s own `coverage` field first, because it was written to answer this', () => {
    expect(coverageFromSource({ provider: 'US EPA', coverage: 'national' })).toEqual(NATIONAL)
    expect(coverageFromSource({ provider: 'Georgia EPD', coverage: 'state:GA' })).toMatchObject({ scope: 'state', states: ['GA'] })
    // `extentLabel`'s own words, which is what writes this field automatically.
    expect(coverageFromSource({ provider: 'x', coverage: 'Tennessee' })).toMatchObject({ scope: 'state', states: ['TN'] })
    expect(coverageFromSource({ provider: 'x', coverage: 'regional' })).toMatchObject({ scope: 'multi-state', states: [] })
  })

  it('falls back to the state the publisher’s own name begins with', () => {
    expect(stateNamingPublisher('Georgia Environmental Protection Division')).toBe('GA')
    expect(stateNamingPublisher('North Carolina Department of Environmental Quality')).toBe('NC')
    expect(stateNamingPublisher('Alabama Department of Environmental Management')).toBe('AL')
    expect(coverageFromSource({ provider: 'Georgia Environmental Protection Division' })).toMatchObject({
      scope: 'state',
      states: ['GA'],
    })
  })

  it('does not read a city’s address as a state', () => {
    // The comma is the tell: the name was a place inside a longer address, not
    // the publisher's own state. Washington the state has no comma after it.
    expect(stateNamingPublisher('Washington, DC Office of Planning')).toBe('')
    expect(stateNamingPublisher('Washington State Department of Ecology')).toBe('WA')
    expect(stateNamingPublisher('US EPA')).toBe('')
    expect(stateNamingPublisher('Virginia Tech')).toBe('VA')
  })

  it('reads a `national` place query, and nothing weaker', () => {
    expect(coverageFromSource({ provider: 'x', geography: 'national' })).toEqual(NATIONAL)
    expect(coverageFromSource({ provider: 'x', placeQuery: { by: ['county', 'national'] } })).toEqual(NATIONAL)
    // `by: ['county','state']` says what you can ASK it for, not how much
    // ground it covers — every state agency's block says that too.
    expect(coverageFromSource({ provider: 'x', placeQuery: { by: ['county', 'state'] } })).toBeNull()
    expect(coverageFromSource({ provider: 'x', geography: 'point' })).toBeNull()
  })

  it('is read before a sample file sitting beside the manifest', async () => {
    // A national register sampled for one county must not read as that state.
    const input = { kind: 'source', meta: { source: { provider: 'US EPA', coverage: 'national' } }, files: ['sample.csv'], slug: 'x' }
    expect(await deriveCoverage(input, read({ 'sample.csv': 'GEOID\n13121\n' }))).toEqual(NATIONAL)
  })
})

describe('coverage — a table we hold', () => {
  it('reads the distinct states off a GEOID column', async () => {
    const files = { 'x.csv': 'name,GEOID\na,47157\nb,47157\nc,28033\n' }
    expect(await deriveCoverage(dataset({}, ['x.csv']), read(files))).toMatchObject({
      scope: 'multi-state',
      states: ['MS', 'TN'],
      counties: ['28033', '47157'],
      label: 'Mississippi and Tennessee',
    })
  })

  it('reads one state as that state, and names its counties', async () => {
    const files = { 'x.csv': 'GEOID\n13121\n13089\n13121\n' }
    expect(await deriveCoverage(dataset({}, ['x.csv']), read(files))).toMatchObject({
      scope: 'state',
      states: ['GA'],
      counties: ['13089', '13121'],
      label: 'Georgia',
    })
  })

  it('leaves the counties off when there are too many to take in', () => {
    const many = Array.from({ length: COUNTY_DETAIL_MAX + 1 }, (_, i) => `13${String(i + 1).padStart(3, '0')}`)
    const read = coverageFromGeoids(many)
    expect(read).toMatchObject({ scope: 'state', states: ['GA'] })
    expect(read?.counties).toBeUndefined()
  })

  it('reads a nationwide county table as national, at the threshold', () => {
    const atThreshold = CODES.slice(0, NATIONAL_STATE_COUNT)
    const belowIt = CODES.slice(0, NATIONAL_STATE_COUNT - 1)
    expect(coverageFromGeoids(atThreshold.map(code => fipsFor(code) + '001'))).toEqual(NATIONAL)
    const below = coverageFromGeoids(belowIt.map(code => fipsFor(code) + '001'))
    expect(below?.scope).toBe('multi-state')
    expect(below?.states).toHaveLength(NATIONAL_STATE_COUNT - 1)
    // A multi-state reading never claims the National chip, which is what makes
    // "what do we hold for Georgia?" a question about Georgia.
    expect(below?.states).toContain('GA')
  })

  it('accepts the Census widths, including a code that lost its leading zero', () => {
    // Alabama county 01001 written as a number, an 11-digit tract, a bare state.
    expect(coverageFromGeoids(['1001'])).toMatchObject({ states: ['AL'], counties: ['01001'] })
    expect(coverageFromGeoids(['13121011100'])).toMatchObject({ states: ['GA'], counties: ['13121'] })
    expect(coverageFromGeoids(['13'])).toMatchObject({ scope: 'state', states: ['GA'] })
  })

  it('drops a value that is not a state’s prefix rather than inventing one', () => {
    // A column of row ids called `GIS_FIPS`, a placeholder, a blank.
    expect(coverageFromGeoids(['00000', '99999', '', '  ', 'n/a'])).toBeNull()
    // And it keeps the real ones beside the junk.
    expect(coverageFromGeoids(['00000', '13121'])).toMatchObject({ scope: 'state', states: ['GA'] })
  })

  it('degrades to local for coordinates with no area code, claiming no state', async () => {
    const csv = 'name,lat,lng\na,38.9,-77.0\n'
    expect(await deriveCoverage(dataset({}, ['x.csv']), read({ 'x.csv': csv }))).toEqual(LOCAL)
    expect(LOCAL.states).toEqual([])
  })

  it('reads a GeoJSON’s properties, and its point geometry as coordinates', () => {
    const points = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-77, 38.9] }, properties: { NAME: 'a' } }],
    })
    expect(coverageFromSignals(readCoverageSignals('x.geojson', points))).toEqual(LOCAL)
    const withGeoids = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-84, 33] }, properties: { GEOID: '13121' } }],
    })
    expect(coverageFromSignals(readCoverageSignals('x.geojson', withGeoids))).toMatchObject({ scope: 'state', states: ['GA'] })
  })

  it('reads the right column when a cell in front of it contains a comma', () => {
    // The enriched tables have prose in them; one comma inside one quoted cell
    // shifts every later column and the GEOID read becomes a read of its
    // neighbour. This is the case that made `splitRow` necessary.
    expect(splitRow('a,"b, c",d', ',')).toEqual(['a', 'b, c', 'd'])
    expect(splitRow('a,"she said ""hi""",13121', ',')).toEqual(['a', 'she said "hi"', '13121'])
    const csv = 'name,members,GEOID\nA,"Smith, Jones",13121\n'
    expect(readCoverageSignals('x.csv', csv).geoids).toEqual(['13121'])
  })

  it('never throws, and answers nothing when it cannot read the file', async () => {
    const boom = async () => {
      throw new Error('too big')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await deriveCoverage(dataset({}, ['x.csv']), boom)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    // A read that declines (over the cap) says nothing, quietly.
    expect(await deriveCoverage(dataset({}, ['x.csv']), async () => null)).toBeNull()
    // And so does a file too broken to parse.
    expect(await deriveCoverage(dataset({}, ['x.json']), read({ 'x.json': '{ not json' }))).toBeNull()
  })

  it('picks the same file the shape derivation picks, so one read serves both', () => {
    expect(pickCoverageFile(['meta.json', 'strategic-table.pdf', 'landholders.csv'])).toBe('landholders.csv')
    expect(pickCoverageFile(['meta.json', 'notes.pdf'])).toBeNull()
    expect(pickCoverageFile(undefined)).toBeNull()
  })
})

describe('coverage — nothing determinable', () => {
  it('is no coverage at all, and never a quiet "national"', async () => {
    // A directory of people: no GEOID, no coordinates, nothing in the manifest.
    const files = { 'individuals.csv': 'Name,Affiliations,Roles,Total\nA,B,C,9\n' }
    expect(await deriveCoverage(dataset({}, ['individuals.csv']), read(files))).toBeNull()
    // A manifest with nothing in it and no file to read.
    expect(await deriveCoverage(dataset({}))).toBeNull()
    expect(coverageFromManifest(dataset({}))).toBeNull()
  })

  it('is what a public registry layer is NOT — those are national by fact', () => {
    expect(PUBLIC_LAYER_COVERAGE).toEqual(NATIONAL)
  })
})

describe('coverage — the words a reader sees', () => {
  it('names the state when one state names it, and counts them when too many do', () => {
    expect(coverageLabel('national', [])).toBe('National')
    expect(coverageLabel('state', ['GA'])).toBe('Georgia')
    expect(coverageLabel('multi-state', ['GA', 'AL'])).toBe('Georgia and Alabama')
    expect(coverageLabel('multi-state', ['TN', 'MS', 'GA', 'AR'])).toBe('Tennessee, Mississippi, Georgia and Arkansas')
    expect(coverageLabel('multi-state', CODES.slice(0, 26))).toBe('26 states')
    expect(coverageLabel('local', [])).toBe('Local area')
  })
})

/** The FIPS prefix for a postal code — the test's own small reverse lookup. */
function fipsFor(code: string): string {
  return US_STATES.find(s => s.code === code)!.fips
}
