import { describe, it, expect, vi, beforeEach } from 'vitest'

// `fetchWorkingSetColumns` is the ONE read both interfaces share, so its
// behaviour at the edges belongs here with the arithmetic it feeds. Everything
// else in this file is pure and never touches it.
vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'https://api.example.com',
}))

import { internalFetch } from '../apiBase'
import {
  compositeLine,
  compositeServedLine,
  compositeTermLine,
  fetchWorkingSetColumns,
  indexableLayersOf,
  runComposite,
  measurableLayersOf,
  proximityLine,
  proximityServedLine,
  rerunDerivedColumn,
  runProximity,
  derivedColumnValues,
  derivedFreshnessBadge,
  derivedFreshnessLine,
  derivedRange,
  derivedRangeLine,
  derivedTableColumns,
  formatDerivedValue,
  NO_WORKING_SET_LABEL,
  progressLine,
  workingSetDatasetsHref,
  workingSetHref,
  workingSetIdsOf,
  workingSetKeysOf,
  workingSetPlaceHref,
  workingSetProgress,
  type CompositeRun,
  type DerivedColumn,
  type ProximityRun,
  type WorkingSetSummary,
} from '../workingSets'
import { facetsFor, matchesAnyFilter, NONE_VALUE } from '../browse'
import { contextCell, contextValue, sortRowsByContext } from '../countyJoin'
import type { CatalogEntry } from '../libraryCatalog'

/**
 * Working sets (P7-1) — the arithmetic the browsers do over a set.
 *
 * Two things are being pinned down here. The chips, because a dataset can be
 * in several sets at once and the browse kit has to be handed multi-valued
 * keys for that to work. And the progress line, because its denominator is
 * what the set NAMES — "9 of 11 held" has to stay 11 when one of the eleven
 * has gone missing, or the number stops being the one worth acting on.
 */

const set = (over: Partial<WorkingSetSummary>): WorkingSetSummary => ({
  slug: 'memphis-redevelopment',
  name: 'Memphis redevelopment',
  purpose: '',
  description: '',
  datasets: [],
  layers: [],
  sites: null,
  derivedCount: 0,
  savedBy: 'maria',
  savedAt: '2026-10-05T10:00:00Z',
  updatedAt: '2026-10-05T10:00:00Z',
  views: [],
  ...over,
})

const entry = (over: Partial<CatalogEntry>): CatalogEntry => ({
  slug: 'x',
  kind: 'dataset',
  title: 'X',
  category: '',
  status: 'published',
  tags: [],
  meta: {},
  files: [],
  bytes: 0,
  ...over,
})

const MEMPHIS = set({ datasets: ['memphis-sites', 'epa-superfund-npl'] })
const TRANSMISSION = set({
  slug: 'transmission-corridors',
  name: 'Transmission corridors',
  datasets: ['epa-superfund-npl', 'eia-transmission'],
})
const SETS = [MEMPHIS, TRANSMISSION]

describe('which sets a dataset is in', () => {
  it('is multi-valued — a dataset two projects depend on is under both chips', () => {
    expect(workingSetKeysOf('epa-superfund-npl', SETS)).toEqual([
      { id: 'memphis-redevelopment', label: 'Memphis redevelopment' },
      { id: 'transmission-corridors', label: 'Transmission corridors' },
    ])
  })

  it('answers with the "no set" chip rather than silence, so it can be pressed', () => {
    expect(workingSetKeysOf('mystery-table', SETS)).toEqual([{ id: '', label: NO_WORKING_SET_LABEL }])
    // '' travels in a URL as `none`, which is how the browse kit spells it.
    expect(matchesAnyFilter(workingSetIdsOf('mystery-table', SETS), NONE_VALUE)).toBe(true)
    expect(matchesAnyFilter(workingSetIdsOf('epa-superfund-npl', SETS), NONE_VALUE)).toBe(false)
  })

  it('narrows to one set, and to no set, through the same filter', () => {
    expect(matchesAnyFilter(workingSetIdsOf('memphis-sites', SETS), 'memphis-redevelopment')).toBe(true)
    expect(matchesAnyFilter(workingSetIdsOf('memphis-sites', SETS), 'transmission-corridors')).toBe(false)
    // '' is "not narrowed at all" and lets everything through.
    expect(matchesAnyFilter(workingSetIdsOf('memphis-sites', SETS), '')).toBe(true)
  })

  it('is in no set when there are no sets at all', () => {
    expect(workingSetKeysOf('anything', [])).toEqual([{ id: '', label: NO_WORKING_SET_LABEL }])
  })

  /**
   * P6-22's rule, which matters more for this chip row than any other: a set
   * whose last visible member was filtered out from under it must still be
   * un-narrowable, so the chosen chip survives at its true count of 0.
   */
  it('keeps the chosen set visible when the combination matches nothing', () => {
    const rows = [{ slug: 'epa-superfund-npl' }, { slug: 'mystery-table' }]
    const keyOf = (row: { slug: string }) => workingSetKeysOf(row.slug, SETS)
    const facets = facetsFor(rows, [], keyOf, 'transmission-corridors')
    expect(facets).toEqual([{ id: 'transmission-corridors', label: 'Transmission corridors', count: 0 }])
  })

  it('counts each set once per row, so a chip is never bigger than its list', () => {
    const rows = [{ slug: 'epa-superfund-npl' }, { slug: 'memphis-sites' }]
    const keyOf = (row: { slug: string }) => workingSetKeysOf(row.slug, SETS)
    expect(facetsFor(rows, rows, keyOf, '')).toEqual([
      { id: 'memphis-redevelopment', label: 'Memphis redevelopment', count: 2 },
      { id: 'transmission-corridors', label: 'Transmission corridors', count: 1 },
    ])
  })
})

describe('how far a set’s sourcing has got', () => {
  const ELEVEN = set({
    datasets: [
      'held-1',
      'held-2',
      'held-3',
      'held-4',
      'held-5',
      'held-6',
      'held-7',
      'held-8',
      'held-9',
      'source-ok',
      'source-failing',
    ],
  })

  const CATALOG: CatalogEntry[] = [
    ...Array.from({ length: 9 }, (_, i) => entry({ slug: `held-${i + 1}`, kind: 'dataset' })),
    entry({ slug: 'source-ok', kind: 'source', meta: { source: { provider: 'US EPA' } } }),
    // P5-57 records the failure on the source block; `source-failing` is the
    // attention key that reads it, and it is the one this line reports.
    entry({
      slug: 'source-failing',
      kind: 'source',
      meta: { source: { provider: 'FEMA', lastError: { code: 'timeout', at: '2026-10-01T00:00:00Z' } } },
    }),
  ]

  it('is the spec’s own sentence — 9 of 11 held, and what could not be reached', () => {
    const progress = workingSetProgress(ELEVEN, CATALOG)
    expect(progress).toEqual({ total: 11, held: 9, indexed: 2, missing: 0, unreached: 1 })
    expect(progressLine(progress)).toBe('9 of 11 held · 2 indexed · 1 could not be reached')
  })

  /**
   * The denominator is what the set NAMES. A member archived out from under a
   * set is reported, never folded away into a tidier number — P6-23's rule
   * that a count may not disagree with the list it opens, and the honest
   * reading of "we lost one" rather than "we only ever wanted ten".
   */
  it('keeps a member the library no longer has in the denominator, and says so', () => {
    const progress = workingSetProgress(
      set({ datasets: ['held-1', 'gone-away'] }),
      CATALOG,
    )
    expect(progress).toEqual({ total: 2, held: 1, indexed: 0, missing: 1, unreached: 0 })
    expect(progressLine(progress)).toBe('1 of 2 held · 1 no longer in the library')
  })

  it('does not count a member that is in the catalog as something else', () => {
    const progress = workingSetProgress(set({ datasets: ['a-page'] }), [entry({ slug: 'a-page', kind: 'wiki' })])
    expect(progress.missing).toBe(1)
    expect(progress.held).toBe(0)
  })

  it('says nothing it does not have to — a clean set carries no zero clauses', () => {
    expect(progressLine(workingSetProgress(set({ datasets: ['held-1', 'held-2'] }), CATALOG))).toBe('2 of 2 held')
  })

  it('an empty set says it is empty rather than "0 of 0 held"', () => {
    expect(progressLine(workingSetProgress(set({}), CATALOG))).toBe('Nothing in this set yet')
  })

  it('counts an unreachable dropped link too — the other half of "could not be reached"', () => {
    const progress = workingSetProgress(set({ datasets: ['bad-link'] }), [
      entry({ slug: 'bad-link', kind: 'source', meta: { inspection: { kind: 'unreachable', checkedAt: '2026-10-01' } } }),
    ])
    expect(progress.unreached).toBe(1)
  })
})

describe('where a set goes', () => {
  it('opens as a catalog entry — a set holds no framing, so its interfaces are on a view (P7-2)', () => {
    expect(workingSetHref('memphis-redevelopment')).toBe('/library/memphis-redevelopment')
  })

  it('links to exactly the list its progress line counts', () => {
    expect(workingSetDatasetsHref('memphis-redevelopment')).toBe('/datasets?workingSet=memphis-redevelopment')
  })

  it('links to a place report scoped to it', () => {
    expect(workingSetPlaceHref('memphis-redevelopment')).toBe('/place?set=memphis-redevelopment')
  })

  it('encodes a slug rather than trusting it', () => {
    expect(workingSetDatasetsHref('a b')).toBe('/datasets?workingSet=a%20b')
  })
})

describe('a derived column, read once and used twice', () => {
  const column = (over: Partial<DerivedColumn> = {}): DerivedColumn => ({
    id: 'transmission-miles',
    label: 'Miles to nearest transmission line',
    unit: 'miles',
    method: 'Nearest point on EPRI transmission lines, 2024',
    computedAt: '2026-10-05T09:00:00.000Z',
    values: { '47157': 1.4, '28033': 6.2, '38103': 3 },
    rows: 3,
    storedAt: 'manifest',
    type: 'proximity',
    by: 'maria',
    freshness: 'fresh',
    staleNote: '',
    inputs: [],
    rerun: { type: 'proximity', from: 'memphis-sites', to: 'internal-transmission', within: null },
    layerId: '',
    ...over,
  })

  it('lands in exactly the shape the explorer’s county join already consumes', () => {
    const values = derivedColumnValues(column())
    // The table's own helpers, unchanged, over a derived column.
    expect(contextCell(values, '47157')).toBe('1.4 mi')
    expect(contextCell(values, '13121')).toBe('—')
    expect(contextValue(values, '28033')).toBe(6.2)
  })

  it('sorts in the table through the join that already existed — no new sort', () => {
    const values = derivedColumnValues(column())
    const rows = [
      { _row: 0, GEOID: '28033' },
      { _row: 1, GEOID: '47157' },
      { _row: 2, GEOID: '13121' },
      { _row: 3, GEOID: '38103' },
    ]
    expect(sortRowsByContext(rows, 'GEOID', values, 'asc').map(r => r.GEOID)).toEqual([
      '47157',
      '38103',
      '28033',
      // No number sinks to the bottom whichever way the column points.
      '13121',
    ])
    expect(sortRowsByContext(rows, 'GEOID', values, 'desc').map(r => r.GEOID)).toEqual([
      '28033',
      '38103',
      '47157',
      '13121',
    ])
  })

  it('prefixes its table id so a derived column and a layer column cannot collide', () => {
    const [joined] = derivedTableColumns([column()])
    expect(joined.id).toBe('derived:transmission-miles')
    expect(joined.name).toBe('Miles to nearest transmission line')
    expect(joined.values.get('47157')?.display).toBe('1.4 mi')
  })

  it('prints by its unit, and carries a unit it has never heard of rather than swallowing it', () => {
    expect(formatDerivedValue(1.44, 'miles')).toBe('1.4 mi')
    expect(formatDerivedValue(1234.6, 'count')).toBe('1,235')
    expect(formatDerivedValue(12.34, 'percent')).toBe('12.3%')
    expect(formatDerivedValue(1234.6, 'dollars')).toBe('$1,235')
    expect(formatDerivedValue(1.23456, '')).toBe('1.23')
    expect(formatDerivedValue(3.5, 'acres')).toBe('3.5 acres')
    expect(formatDerivedValue(Number.NaN, 'miles')).toBe('—')
  })

  it('reports its spread over the counties the map is drawing — the map’s reading of the same values', () => {
    const c = column()
    expect(derivedRange(c, ['47157', '28033'])).toEqual({ count: 2, min: 1.4, max: 6.2 })
    // A county with no number is not counted, and does not widen the range.
    expect(derivedRange(c, ['47157', '13121'])).toEqual({ count: 1, min: 1.4, max: 1.4 })
    // Nothing to say rather than a range of nothing.
    expect(derivedRange(c, ['13121'])).toBeNull()
  })

  it('reads the whole column when the map is not narrowing — the same meaning `query.only` gives an empty list', () => {
    expect(derivedRange(column(), [])).toEqual({ count: 3, min: 1.4, max: 6.2 })
  })

  it('says the spread in words, and says one value as one value', () => {
    const c = column()
    expect(derivedRangeLine(c, derivedRange(c, ['47157', '28033'])!)).toBe('1.4 mi to 6.2 mi across 2 counties')
    expect(derivedRangeLine(c, derivedRange(c, ['47157'])!)).toBe('1.4 mi across 1 county')
  })
})

describe('fetchWorkingSetColumns — the one read', () => {
  const mockedFetch = vi.mocked(internalFetch)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    mockedFetch.mockReset()
  })

  it('asks the set’s own columns route once and hands back what it said', async () => {
    mockedFetch.mockResolvedValue(
      json({
        slug: 'memphis-redevelopment',
        name: 'Memphis redevelopment',
        columns: [{ id: 'dist', label: 'Distance', unit: 'miles', values: { '47157': 1.4 }, rows: 1 }],
        unreadable: [],
      }),
    )
    const result = await fetchWorkingSetColumns('memphis-redevelopment')
    expect(mockedFetch).toHaveBeenCalledTimes(1)
    expect(mockedFetch).toHaveBeenCalledWith('/api/working-sets/memphis-redevelopment/columns')
    expect(result.columns[0].label).toBe('Distance')
    expect(result.unreadable).toEqual([])
  })

  /**
   * P7-6, and the one direction the tolerance may not go.
   *
   * A column whose verdict did not arrive reads as UNCHECKED, never as fresh.
   * Defaulting the other way would draw a possibly-drifted number as current
   * on the strength of a missing field — a failure that looks like nothing at
   * all, which is the failure this ticket exists to prevent.
   */
  it('reads a column with no verdict as unchecked, never as fresh', async () => {
    mockedFetch.mockResolvedValue(json({ columns: [{ id: 'dist', values: { '47157': 1.4 } }] }))
    const result = await fetchWorkingSetColumns('memphis')
    expect(result.columns[0]).toMatchObject({
      id: 'dist',
      label: 'dist',
      freshness: 'unknown',
      staleNote: '',
      type: '',
      by: '',
      inputs: [],
      rerun: null,
      layerId: '',
    })
  })

  it('refuses a nonsense verdict rather than passing it through', async () => {
    mockedFetch.mockResolvedValue(json({ columns: [{ id: 'dist', freshness: 'probably fine' }] }))
    expect((await fetchWorkingSetColumns('memphis')).columns[0].freshness).toBe('unknown')
  })

  it('keeps a re-run only when it names what it would re-run', async () => {
    mockedFetch.mockResolvedValue(
      json({
        columns: [
          { id: 'a', freshness: 'stale', rerun: { type: 'proximity', from: 'sites', to: 'internal-x', within: 5 } },
          { id: 'b', freshness: 'stale', rerun: { type: 'proximity', from: 'sites' } },
          { id: 'c', freshness: 'stale', rerun: 'yes' },
        ],
      }),
    )
    const columns = (await fetchWorkingSetColumns('memphis')).columns
    expect(columns[0].rerun).toEqual({ type: 'proximity', from: 'sites', to: 'internal-x', within: 5 })
    // A button that cannot say what it would run is not offered.
    expect(columns[1].rerun).toBeNull()
    expect(columns[2].rerun).toBeNull()
  })

  /**
   * A set can be renamed out from under an open page. The view is still worth
   * drawing — both interfaces work without columns, because today every set
   * has none — so this answers "no columns" rather than throwing the page away.
   */
  it('reads a vanished set as “no columns”, not as an error', async () => {
    mockedFetch.mockResolvedValue(json({ error: 'not found' }, 404))
    await expect(fetchWorkingSetColumns('gone')).resolves.toEqual({
      slug: 'gone',
      name: '',
      columns: [],
      unreadable: [],
    })
  })

  it('throws with the server’s own sentence on a real failure', async () => {
    mockedFetch.mockResolvedValue(json({ error: 'library unavailable' }, 503))
    await expect(fetchWorkingSetColumns('memphis')).rejects.toThrow('library unavailable')
  })

  it('survives a body that is not the shape it expected', async () => {
    mockedFetch.mockResolvedValue(json({}))
    const result = await fetchWorkingSetColumns('memphis')
    expect(result).toEqual({ slug: 'memphis', name: '', columns: [], unreadable: [] })
  })
})

// --- P7-6: does a stored column still stand? --------------------------------

describe('what a reader is told about a column’s standing', () => {
  const column = (over: Partial<DerivedColumn> = {}): DerivedColumn => ({
    id: 'transmission-miles',
    label: 'Miles to nearest transmission line',
    unit: 'miles',
    method: 'Great-circle miles from 11 rows…',
    computedAt: '2026-10-05T09:00:00.000Z',
    values: { '47157': 1.4 },
    rows: 1,
    storedAt: 'manifest',
    type: 'proximity',
    by: 'maria',
    freshness: 'fresh',
    staleNote: '',
    inputs: [],
    rerun: { type: 'proximity', from: 'memphis-sites', to: 'internal-transmission', within: null },
    layerId: '',
    ...over,
  })

  const NOW = Date.parse('2026-10-06T09:00:00.000Z')

  it('says who measured it and when, and nothing more, when it is fresh', () => {
    expect(derivedFreshnessLine(column(), NOW)).toBe('Measured 1d ago by maria')
    expect(derivedFreshnessBadge(column())).toBe('')
  })

  it('says nothing about a person nobody recorded (P6-27)', () => {
    // "by someone" reads as a fact about a person. A date with no name reads
    // as a date.
    const line = derivedFreshnessLine(column({ by: '' }), NOW)
    expect(line).toBe('Measured 1d ago')
    expect(line).not.toContain('someone')
  })

  it('adds the server’s own sentence when an input has moved', () => {
    const line = derivedFreshnessLine(
      column({
        freshness: 'stale',
        staleNote: '“memphis-sites” has changed since this ran — 4,821 bytes, now 5,002, so this number may have drifted.',
      }),
      NOW,
    )
    // When it was measured, by whom, and what has changed since — in that
    // order, the shape the explorer's own saved-view note already uses.
    expect(line).toBe(
      'Measured 1d ago by maria · “memphis-sites” has changed since this ran — 4,821 bytes, now 5,002, so this number may have drifted.',
    )
  })

  it('flags a stale and an unchecked column differently, because they are', () => {
    expect(derivedFreshnessBadge(column({ freshness: 'stale' }))).toBe('Out of date')
    expect(derivedFreshnessBadge(column({ freshness: 'unknown' }))).toBe('Unchecked')
  })

  it('still prints a line for a column with no timestamp at all', () => {
    expect(derivedFreshnessLine(column({ computedAt: '', by: '' }), NOW)).toBe('Measured')
  })
})

describe('rerunDerivedColumn', () => {
  const mockedFetch = vi.mocked(internalFetch)
  beforeEach(() => {
    mockedFetch.mockReset()
  })

  const stale: DerivedColumn = {
    id: 'miles-to-transmission',
    label: 'Miles',
    unit: 'miles',
    method: '',
    computedAt: '2026-10-05T09:00:00.000Z',
    values: {},
    rows: 0,
    storedAt: 'manifest',
    type: 'proximity',
    by: 'maria',
    freshness: 'stale',
    staleNote: 'changed',
    inputs: [],
    rerun: { type: 'proximity', from: 'memphis-sites', to: 'internal-transmission', within: 10 },
    layerId: '',
  }

  it('re-runs with the arguments the stored record already holds, nothing retyped', async () => {
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ served: 'computed', freshness: 'fresh', staleNote: '' }), { status: 200 }),
    )
    await rerunDerivedColumn('memphis-redevelopment', stale)
    expect(mockedFetch).toHaveBeenCalledWith('/api/working-sets/memphis-redevelopment/proximity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `recompute` because the caller is looking at a number it has been told
      // is out of date; the column id because the replacement must land in the
      // same column rather than beside it.
      body: JSON.stringify({
        from: 'memphis-sites',
        to: 'internal-transmission',
        within: 10,
        id: 'miles-to-transmission',
        recompute: true,
      }),
    })
  })

  it('refuses a column that does not record what produced it', async () => {
    await expect(rerunDerivedColumn('memphis', { ...stale, rerun: null })).rejects.toThrow('cannot be re-run')
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})

describe('proximityServedLine', () => {
  const run = (over: Partial<ProximityRun> = {}): ProximityRun => ({
    set: 'memphis-redevelopment',
    from: 'memphis-sites',
    to: 'internal-transmission',
    within: null,
    reused: false,
    served: 'computed',
    freshness: 'fresh',
    staleNote: '',
    columns: [],
    perRow: [],
    stats: { rows: 11, measured: 9, withoutPoint: 2, withoutCounty: 0, counties: 6, targets: 4, vertices: 164 },
    method: '',
    computedAt: '2026-10-06T00:00:00Z',
    ...over,
  })

  it('says outright that nothing was recomputed — the feature, stated', () => {
    expect(proximityServedLine(run({ served: 'stored', reused: true }))).toContain('Nothing was recomputed')
  })

  it('distinguishes a re-measurement from a first one, and gives the reason', () => {
    expect(proximityServedLine(run())).toBe('Measured.')
    expect(proximityServedLine(run({ staleNote: '“x” has changed.' }))).toBe('Measured again — “x” has changed.')
  })

  it('does not let “nothing ran” hide a caveat on the stored number', () => {
    const line = proximityServedLine(
      run({ served: 'stored', reused: true, freshness: 'unknown', staleNote: 'It cannot be checked.' }),
    )
    expect(line).toContain('It cannot be checked.')
    expect(line).not.toContain('Nothing was recomputed')
  })
})

// --- P7-5: proximity --------------------------------------------------------

describe('measurableLayersOf', () => {
  const lineLayer = entry({
    slug: 'transmission',
    title: 'Transmission lines',
    meta: { layer: { geometry: 'line', name: 'Transmission corridors' } },
  })
  const pointLayer = entry({
    slug: 'brownfields',
    title: 'Brownfields',
    meta: { layer: { geometry: 'point', name: 'ACRES brownfields' } },
  })
  const countyLayer = entry({
    slug: 'target-index',
    title: 'Target index',
    meta: { layer: { geometry: 'county', name: 'Target index' } },
  })

  it('offers the point and line layers a set names, by the layer’s own name', () => {
    const subject = set({ layers: ['internal-transmission', 'internal-brownfields'] })
    expect(measurableLayersOf(subject, [lineLayer, pointLayer])).toEqual([
      { id: 'internal-transmission', name: 'Transmission corridors', geometry: 'line' },
      { id: 'internal-brownfields', name: 'ACRES brownfields', geometry: 'point' },
    ])
  })

  it('leaves out a county layer — it has values, not features to measure to', () => {
    // The server refuses one by name; an option that can only ever be refused
    // is not an option.
    const subject = set({ layers: ['internal-target-index', 'internal-transmission'] })
    expect(measurableLayersOf(subject, [countyLayer, lineLayer]).map(l => l.id)).toEqual(['internal-transmission'])
  })

  it('leaves out a registry layer, which is not a dataset we hold', () => {
    expect(measurableLayersOf(set({ layers: ['combined_scores_v2'] }), [lineLayer])).toEqual([])
  })

  it('leaves out a layer whose dataset the library no longer has', () => {
    expect(measurableLayersOf(set({ layers: ['internal-gone'] }), [lineLayer])).toEqual([])
  })

  it('falls back to the entry’s title when the layer block names nothing', () => {
    const unnamed = entry({ slug: 'lines', title: 'EIA transmission', meta: { layer: { geometry: 'line' } } })
    expect(measurableLayersOf(set({ layers: ['internal-lines'] }), [unnamed])[0].name).toBe('EIA transmission')
  })

  it('survives a manifest with no layer block at all', () => {
    const plain = entry({ slug: 'plain', title: 'Plain table' })
    expect(measurableLayersOf(set({ layers: ['internal-plain'] }), [plain])).toEqual([])
  })
})

describe('proximityLine', () => {
  const run = (over: Partial<ProximityRun['stats']>): ProximityRun => ({
    set: 'memphis-redevelopment',
    from: 'redevelopment-sites',
    to: 'internal-transmission',
    within: null,
    reused: false,
    served: 'computed',
    freshness: 'fresh',
    staleNote: '',
    columns: [],
    perRow: [],
    method: '',
    computedAt: '2026-10-06T00:00:00Z',
    stats: {
      rows: 11,
      measured: 9,
      withoutPoint: 2,
      withoutCounty: 0,
      counties: 6,
      targets: 4,
      vertices: 164,
      ...over,
    },
  })

  it('leads with the measured count over what the table NAMES', () => {
    expect(proximityLine(run({}))).toBe('9 of 11 rows measured · 6 counties · 2 with no coordinates')
  })

  it('says nothing about a shortfall there is none of', () => {
    expect(proximityLine(run({ rows: 9, measured: 9, withoutPoint: 0 }))).toBe('9 of 9 rows measured · 6 counties')
  })

  it('pluralises one row and one county', () => {
    expect(proximityLine(run({ rows: 1, measured: 1, withoutPoint: 0, counties: 1 }))).toBe(
      '1 of 1 row measured · 1 county',
    )
  })

  it('reports a measured row that reached no county', () => {
    expect(proximityLine(run({ withoutCounty: 1 }))).toContain('1 not in a county')
  })
})

describe('runProximity', () => {
  const mocked = vi.mocked(internalFetch)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const body = (over: Record<string, unknown> = {}) => ({
    set: 'memphis-redevelopment',
    from: 'redevelopment-sites',
    to: 'internal-transmission',
    within: null,
    reused: false,
    columns: [{ id: 'miles-to-transmission', label: 'Miles to nearest Transmission lines', unit: 'miles', counties: 6 }],
    perRow: [],
    stats: { rows: 11, measured: 9, withoutPoint: 2, withoutCounty: 0, counties: 6, targets: 4, vertices: 164 },
    method: 'Great-circle miles…',
    computedAt: '2026-10-06T00:00:00Z',
    ...over,
  })

  beforeEach(() => {
    mocked.mockReset()
  })

  it('posts to the set’s own route and returns the run', async () => {
    mocked.mockResolvedValue(json(body()))
    const run = await runProximity('memphis-redevelopment', { to: 'internal-transmission', within: 5 })
    expect(mocked).toHaveBeenCalledWith('/api/working-sets/memphis-redevelopment/proximity', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'internal-transmission', within: 5 }),
    })
    expect(run.columns[0].id).toBe('miles-to-transmission')
  })

  it('carries the ceiling’s own sentence out, naming the local pass', async () => {
    // The 413 is the interesting response: its message is the instruction, so
    // it must not be replaced with a status code.
    mocked.mockResolvedValue(
      json({ error: '190,000 rows is a batch job, not a request — run npm run library -- proximity' }, 413),
    )
    await expect(runProximity('memphis-redevelopment', { to: 'internal-transmission' })).rejects.toThrow(
      /npm run library -- proximity/,
    )
  })

  it('says when nothing was recomputed', async () => {
    mocked.mockResolvedValue(json(body({ reused: true })))
    const run = await runProximity('memphis-redevelopment', { to: 'internal-transmission' })
    expect(run.reused).toBe(true)
  })
})

// --- P7-8: the weighted index -----------------------------------------------

describe('reading a composite column back', () => {
  const mockedFetch = vi.mocked(internalFetch)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    mockedFetch.mockReset()
  })

  const TERMS = [
    { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
    { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
  ]

  async function read(rerun: unknown, layerId = 'internal-efficacy~political-efficacy') {
    mockedFetch.mockResolvedValue(
      json({
        slug: 'efficacy',
        name: 'Political efficacy',
        columns: [
          {
            id: 'political-efficacy',
            label: 'Political efficacy',
            unit: 'index',
            values: { '47157': 71.4 },
            rows: 1,
            type: 'composite',
            freshness: 'fresh',
            rerun,
            layerId,
          },
        ],
      }),
    )
    return (await fetchWorkingSetColumns('efficacy')).columns[0]
  }

  it('reads a composite rerun as its formula, and the layer it draws as', async () => {
    const column = await read({ type: 'composite', terms: TERMS })
    expect(column.rerun).toEqual({ type: 'composite', terms: TERMS })
    expect(column.layerId).toBe('internal-efficacy~political-efficacy')
  })

  it('still reads a proximity rerun exactly as P7-6 did', async () => {
    const column = await read({ type: 'proximity', from: 'sites', to: 'internal-transmission', within: 10 })
    expect(column.rerun).toEqual({ type: 'proximity', from: 'sites', to: 'internal-transmission', within: 10 })
  })

  it('offers no re-run for a formula that is not one, rather than one that would guess', async () => {
    // A single term, a missing direction, a zero weight, a string: each would
    // make the button re-run something other than what produced the number.
    expect((await read({ type: 'composite', terms: [TERMS[0]] })).rerun).toBeNull()
    expect((await read({ type: 'composite', terms: [{ layer: 'a', weight: 1 }, TERMS[1]] })).rerun).toBeNull()
    expect(
      (await read({ type: 'composite', terms: [{ layer: 'a', weight: 0, direction: 'higher_better' }, TERMS[1]] })).rerun,
    ).toBeNull()
    expect((await read({ type: 'composite', terms: 'internal-votes' })).rerun).toBeNull()
  })

  it('claims no layer when the server named none', async () => {
    expect((await read({ type: 'composite', terms: TERMS }, '')).layerId).toBe('')
    // And a missing field is not a layer either.
    mockedFetch.mockResolvedValue(json({ slug: 'efficacy', columns: [{ id: 'x' }] }))
    expect((await fetchWorkingSetColumns('efficacy')).columns[0].layerId).toBe('')
  })

  it('prints an index as a bare number to one decimal', () => {
    expect(formatDerivedValue(71.4321, 'index')).toBe('71.4')
    // A whole number keeps its decimal so a column of them lines up.
    expect(formatDerivedValue(71, 'index')).toBe('71.0')
    expect(formatDerivedValue(100, 'index')).toBe('100.0')
    expect(formatDerivedValue(Number.NaN, 'index')).toBe('—')
  })
})

describe('runComposite', () => {
  const mockedFetch = vi.mocked(internalFetch)
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    mockedFetch.mockReset()
  })

  const TERMS = [
    { layer: 'internal-votes', weight: 6, direction: 'higher_better' as const },
    { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' as const },
  ]

  it('posts the formula and the name to the set’s own route', async () => {
    mockedFetch.mockResolvedValue(json({ set: 'efficacy', column: 'political-efficacy', served: 'computed', freshness: 'fresh' }))
    await runComposite('efficacy', { label: 'Political efficacy', terms: TERMS })
    expect(mockedFetch).toHaveBeenCalledWith('/api/working-sets/efficacy/composite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Political efficacy', terms: TERMS }),
    })
  })

  it('reads a reply that does not say what it did as computed and uncheckable', async () => {
    // Never as a free serve: an answer that forgot to say is not evidence that
    // nothing ran, and it is certainly not evidence the inputs still hold.
    mockedFetch.mockResolvedValue(json({ set: 'efficacy', column: 'x' }))
    const run = await runComposite('efficacy', { label: 'x', terms: TERMS })
    expect(run.served).toBe('computed')
    expect(run.freshness).toBe('unknown')
    expect(run.staleNote).toBe('')
    expect(run.terms).toEqual([])
    expect(run.scales).toEqual([])
  })

  it('shows the ceiling’s own sentence rather than a generic failure', async () => {
    mockedFetch.mockResolvedValue(
      json({ error: '3 layers over 90.0 MB of source tables is past the 32.0 MB this parses in a request.' }, 413),
    )
    await expect(runComposite('efficacy', { label: 'x', terms: TERMS })).rejects.toThrow(/past the 32.0 MB/)
  })

  it('encodes the slug rather than trusting it', async () => {
    mockedFetch.mockResolvedValue(json({ set: 'a b', column: 'x', served: 'computed' }))
    await runComposite('a b', { label: 'x', terms: TERMS })
    expect(mockedFetch).toHaveBeenCalledWith('/api/working-sets/a%20b/composite', expect.anything())
  })
})

describe('rerunDerivedColumn dispatches on the stored type', () => {
  const mockedFetch = vi.mocked(internalFetch)
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

  beforeEach(() => {
    mockedFetch.mockReset()
  })

  const base: DerivedColumn = {
    id: 'political-efficacy',
    label: 'Political efficacy',
    unit: 'index',
    method: '',
    computedAt: '2026-10-06T09:00:00.000Z',
    values: {},
    rows: 0,
    storedAt: 'manifest',
    type: 'composite',
    by: 'maria',
    freshness: 'stale',
    staleNote: '“votes” has changed since this ran',
    inputs: [],
    rerun: {
      type: 'composite',
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
      ],
    },
    layerId: 'internal-efficacy~political-efficacy',
  }

  it('re-runs an index through the composite route, forcing the work', async () => {
    mockedFetch.mockResolvedValue(json({ set: 'efficacy', column: 'political-efficacy', served: 'computed' }))
    await rerunDerivedColumn('efficacy', base)
    const [url, init] = mockedFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/working-sets/efficacy/composite')
    // The column's own id and label, so a re-run replaces the column rather
    // than adding a second one beside it — and `recompute`, because the point
    // is to replace a number already known to be out of date.
    expect(JSON.parse(String(init.body))).toEqual({
      label: 'Political efficacy',
      id: 'political-efficacy',
      terms: base.rerun?.type === 'composite' ? base.rerun.terms : [],
      recompute: true,
    })
  })

  it('still re-runs a measurement through the proximity route', async () => {
    mockedFetch.mockResolvedValue(json({ set: 'memphis', served: 'computed' }))
    await rerunDerivedColumn('memphis', {
      ...base,
      id: 'miles-to-transmission',
      unit: 'miles',
      type: 'proximity',
      layerId: '',
      rerun: { type: 'proximity', from: 'sites', to: 'internal-transmission', within: 10 },
    })
    expect((mockedFetch.mock.calls[0] as [string, RequestInit])[0]).toBe('/api/working-sets/memphis/proximity')
  })

  it('refuses a column that records nothing, rather than guessing', async () => {
    await expect(rerunDerivedColumn('efficacy', { ...base, rerun: null })).rejects.toThrow(
      /does not record what produced it/,
    )
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})

describe('indexableLayersOf', () => {
  const entries = [
    {
      slug: 'votes',
      title: 'Black voter registration',
      meta: { layer: { geometry: 'county', name: 'Black voter registration', direction: 'higher_better' } },
    },
    {
      slug: 'turnout',
      title: 'Local election turnout',
      meta: { layer: { geometry: 'county', name: 'Local election turnout', direction: 'lower_better' } },
    },
    { slug: 'sites', title: 'Sites', meta: { layer: { geometry: 'point', name: 'Sites' } } },
    { slug: 'lines', title: 'Lines', meta: { layer: { geometry: 'line', name: 'Lines' } } },
    { slug: 'plain', title: 'A plain table', meta: {} },
  ] as unknown as CatalogEntry[]

  const registry = {
    pct_Black: { name: 'Black population share', direction: 'higher_better' },
    poverty_by_race: { name: 'Black poverty rate', direction: 'lower_better' },
  }

  it('offers the set’s county layers, internal and public alike', () => {
    const set = {
      layers: ['internal-votes', 'internal-turnout', 'pct_Black', 'poverty_by_race'],
    } as unknown as WorkingSetSummary
    expect(indexableLayersOf(set, entries, registry)).toEqual([
      { id: 'internal-votes', name: 'Black voter registration', direction: 'higher_better', kind: 'internal' },
      { id: 'internal-turnout', name: 'Local election turnout', direction: 'lower_better', kind: 'internal' },
      { id: 'pct_Black', name: 'Black population share', direction: 'higher_better', kind: 'public' },
      { id: 'poverty_by_race', name: 'Black poverty rate', direction: 'lower_better', kind: 'public' },
    ])
  })

  it('leaves out what the server would refuse: features, non-layers, and an index', () => {
    const set = {
      layers: [
        'internal-sites',
        'internal-lines',
        'internal-plain',
        'internal-missing',
        'not_a_registry_layer',
        // A composite's own layer id. An index over an index would need a
        // chain of staleness nothing keeps, so it is not an option.
        'internal-efficacy~political-efficacy',
      ],
    } as unknown as WorkingSetSummary
    expect(indexableLayersOf(set, entries, registry)).toEqual([])
  })

  it('defaults a declared direction to higher_better rather than dropping the layer', () => {
    const set = { layers: ['internal-no-direction'] } as unknown as WorkingSetSummary
    const noDirection = [
      { slug: 'no-direction', title: 'No direction', meta: { layer: { geometry: 'county', name: 'No direction' } } },
    ] as unknown as CatalogEntry[]
    expect(indexableLayersOf(set, noDirection, registry)).toEqual([
      { id: 'internal-no-direction', name: 'No direction', direction: 'higher_better', kind: 'internal' },
    ])
  })

  it('needs no registry at all when the set names no public layers', () => {
    const set = { layers: ['internal-votes'] } as unknown as WorkingSetSummary
    expect(indexableLayersOf(set, entries)).toHaveLength(1)
    expect(indexableLayersOf({ layers: ['pct_Black'] } as unknown as WorkingSetSummary, entries)).toEqual([])
  })
})

describe('what a reader is told about an index', () => {
  const run = (over: Partial<CompositeRun> = {}): CompositeRun => ({
    set: 'efficacy',
    column: 'political-efficacy',
    label: 'Political efficacy',
    terms: [],
    scales: [],
    reused: false,
    served: 'computed',
    freshness: 'fresh',
    staleNote: '',
    counties: 318,
    complete: 290,
    partial: 28,
    layerId: 'internal-efficacy~political-efficacy',
    method: '',
    computedAt: '2026-10-06T09:00:00.000Z',
    ...over,
  })

  it('distinguishes nothing-ran from ran-again-because', () => {
    expect(compositeServedLine(run({ served: 'stored', reused: true }))).toBe(
      'Already built — the stored index, unchanged. Nothing was recomputed.',
    )
    expect(compositeServedLine(run({ served: 'stored', freshness: 'unknown', staleNote: 'It cannot be checked.' }))).toBe(
      'Already built — the stored index. It cannot be checked.',
    )
    expect(compositeServedLine(run())).toBe('Built.')
    // The one a reader must not mistake for a first run: the number moved.
    expect(compositeServedLine(run({ staleNote: '“votes” has changed since this ran.' }))).toBe(
      'Built again — “votes” has changed since this ran.',
    )
  })

  it('never folds the incomplete counties into a tidier number', () => {
    expect(compositeLine(run())).toBe('318 counties · 290 with every layer · 28 missing at least one')
    expect(compositeLine(run({ counties: 1, complete: 1, partial: 0 }))).toBe('1 county · 1 with every layer')
  })

  it('says what each layer’s 0 and 100 meant, which is half the sentence', () => {
    expect(
      compositeTermLine(
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better', min: 3.1, max: 44.2, counties: 3100 },
        'Black poverty rate',
      ),
    ).toBe('Black poverty rate ×4, lower is better, over 3.1 to 44.2')
    // With no name to hand, the layer id rather than nothing.
    expect(
      compositeTermLine({ layer: 'internal-votes', weight: 6, direction: 'higher_better', min: 0, max: 100, counties: 6 }),
    ).toBe('internal-votes ×6, higher is better, over 0 to 100')
  })
})
