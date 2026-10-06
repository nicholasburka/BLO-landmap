import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../apiBase', () => ({
  internalFetch: vi.fn(),
  API_URL: 'http://api.test',
}))

import { internalFetch } from '../apiBase'
import {
  parseRowsState,
  buildRowsQuery,
  rowsStateToQuery,
  fetchDatasetSchema,
  fetchDatasetRows,
  fetchColumnSummary,
  fetchColumnOverview,
  datasetExportUrl,
  csvCell,
  groupByCsv,
  sharePct,
  formatNumber,
  hasTabularFile,
  isHttpUrl,
  describeColumn,
  DatasetRequestError,
  type RowsState,
} from '../libraryData'

const mockedFetch = vi.mocked(internalFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  mockedFetch.mockReset()
})

describe('parseRowsState ↔ buildRowsQuery', () => {
  it('round-trips a full state through the URL', () => {
    const state: RowsState = {
      file: 'orgs.csv',
      q: 'georgia',
      sort: 'Score',
      dir: 'desc',
      filter: [{ column: 'Tier', op: 'eq', value: 'Tier 1' }, { column: 'EIN', op: 'notEmpty' }],
      page: 3,
      limit: 100,
    }
    const qs = buildRowsQuery(state)
    const query = Object.fromEntries(new URLSearchParams(qs.slice(1)).entries())
    expect(parseRowsState(query)).toEqual(state)
  })

  it('omits defaults so the canonical URL is empty', () => {
    expect(buildRowsQuery({})).toBe('')
    expect(buildRowsQuery({ page: 1, limit: 50, dir: 'asc', q: '  ' })).toBe('')
    expect(buildRowsQuery({ sort: 'x', dir: 'asc' })).toBe('?sort=x')
  })

  it('drops invalid URL values instead of throwing', () => {
    expect(
      parseRowsState({
        dir: 'sideways',
        page: '0',
        limit: '9999',
        filter: '{not json',
        sort: ['A', 'B'],
      }),
    ).toEqual({ sort: 'A' })
    expect(parseRowsState({ filter: JSON.stringify([{ column: 'x', op: 'between', value: '1' }, { column: 'y', op: 'eq' }, 5]) })).toEqual({})
    expect(parseRowsState({ filter: JSON.stringify([{ column: 'y', op: 'empty', value: 'ignored' }]) })).toEqual({
      filter: [{ column: 'y', op: 'empty' }],
    })
  })

  it('rowsStateToQuery yields a plain object for router.replace', () => {
    expect(rowsStateToQuery({ q: 'a b', page: 2 })).toEqual({ q: 'a b', page: '2' })
  })
})

describe('fetchers', () => {
  it('fetchDatasetSchema hits the schema route (with ?file=) and returns the body', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ entry: { slug: 'orgs' }, columns: [], rowCount: 0 }))
    const schema = await fetchDatasetSchema('orgs', 'a b.csv')
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/data/orgs?file=a%20b.csv')
    expect(schema.entry.slug).toBe('orgs')
  })

  it('fetchDatasetRows serialises the state into the query string', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ rows: [], total: 0, page: 2, limit: 50 }))
    await fetchDatasetRows('orgs', { q: 'x', sort: 'Score', dir: 'desc', page: 2 })
    expect(mockedFetch).toHaveBeenCalledWith('/api/library/data/orgs/rows?q=x&sort=Score&dir=desc&page=2')
  })

  it('surfaces the server message with its status (413 download hint, 404, 415)', async () => {
    mockedFetch.mockResolvedValueOnce(jsonResponse({ error: 'big.csv is 40.0 MB — download it instead' }, 413))
    await expect(fetchDatasetSchema('big')).rejects.toMatchObject({ status: 413, message: /download/ })
    mockedFetch.mockResolvedValueOnce(new Response('nope', { status: 404 }))
    const err = await fetchDatasetRows('gone', {}).catch(e => e)
    expect(err).toBeInstanceOf(DatasetRequestError)
    expect(err.status).toBe(404)
    expect(err.message).toMatch(/404/)
  })
})

describe('helpers', () => {
  it('hasTabularFile ignores manifests and non-tabular extensions', () => {
    expect(hasTabularFile([{ key: 'library/datasets/x/meta.json' }])).toBe(false)
    expect(hasTabularFile([{ key: 'library/documents/x/notes.pdf' }])).toBe(false)
    expect(hasTabularFile([{ key: 'library/datasets/x/meta.json' }, { key: 'library/datasets/x/orgs.CSV' }])).toBe(true)
    expect(hasTabularFile([{ key: 'library/incoming/uuid/upload.meta.json' }, { key: 'library/incoming/uuid/pts.geojson' }])).toBe(true)
  })

  it('isHttpUrl only accepts absolute http(s) URLs', () => {
    expect(isHttpUrl('https://saafon.org/contact/')).toBe(true)
    expect(isHttpUrl(' http://x.org ')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('www.x.org')).toBe(false)
    expect(isHttpUrl('https://x.org and more')).toBe(false)
  })

  it('describeColumn summarises numbers with a range and others with distinct counts', () => {
    expect(describeColumn({ name: 'Score', type: 'number', filled: 73, distinct: 40, min: 50, max: 1200 }, 100)).toBe(
      'number · 73/100 filled · 50 – 1,200',
    )
    expect(describeColumn({ name: 'Tier', type: 'string', filled: 100, distinct: 3 }, 100)).toBe('string · 100/100 filled · 3 distinct')
    expect(describeColumn({ name: 'blank', type: 'empty', filled: 0, distinct: 0 }, 100)).toBe('empty · 0/100 filled')
  })
})

/**
 * P5-42: summaries and export. Everything here describes the CURRENT
 * filtered set, so the request carries file + q + filter and nothing else
 * (sort/page/limit move rows around; they do not change which rows).
 */
const STATE: RowsState = {
  file: 'organizations.csv',
  q: 'farm',
  sort: 'Score',
  dir: 'desc',
  filter: [{ column: 'HQ State', op: 'eq', value: 'GA' }],
  page: 3,
  limit: 25,
}

describe('fetchColumnSummary / fetchColumnOverview (P5-42)', () => {
  it('asks about one column with the filters that made the current view — never the sort or page', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ column: 'Tier', type: 'string', filled: 2, empty: 0, distinct: 2, top: [], numbers: null, dates: null }))
    const summary = await fetchColumnSummary('orgs', STATE, 'Tier')
    expect(summary.column).toBe('Tier')
    const url = new URL(mockedFetch.mock.calls[0][0], 'http://x')
    expect(url.pathname).toBe('/api/library/data/orgs/summary')
    expect(url.searchParams.get('column')).toBe('Tier')
    expect(url.searchParams.get('file')).toBe('organizations.csv')
    expect(url.searchParams.get('q')).toBe('farm')
    expect(JSON.parse(url.searchParams.get('filter')!)).toEqual([{ column: 'HQ State', op: 'eq', value: 'GA' }])
    expect(url.searchParams.get('sort')).toBeNull()
    expect(url.searchParams.get('page')).toBeNull()
    expect(url.searchParams.get('limit')).toBeNull()
    expect(url.searchParams.get('groupBy')).toBeNull()
  })

  it('adds groupBy=1 when the caller wants the full value list', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ column: 'Tier', top: [] }))
    await fetchColumnSummary('orgs', {}, 'Tier', { groupBy: true })
    expect(mockedFetch.mock.calls[0][0]).toContain('groupBy=1')
  })

  it('fetches the per-column overview with no column param at all', async () => {
    mockedFetch.mockResolvedValue(jsonResponse([{ column: 'Tier', type: 'string', filledPct: 100, distinct: 3 }]))
    const overview = await fetchColumnOverview('orgs', {})
    expect(overview).toHaveLength(1)
    expect(mockedFetch.mock.calls[0][0]).toBe('/api/library/data/orgs/summary')
  })

  it('surfaces the server refusal with its status', async () => {
    mockedFetch.mockResolvedValue(jsonResponse({ error: 'unknown column: Nope' }, 400))
    await expect(fetchColumnSummary('orgs', {}, 'Nope')).rejects.toMatchObject({
      name: 'DatasetRequestError',
      status: 400,
      message: 'unknown column: Nope',
    })
    expect(DatasetRequestError).toBeDefined()
  })
})

describe('datasetExportUrl (P5-42)', () => {
  it('is an absolute link carrying the filters AND the sort (the order the file is written in)', () => {
    const url = new URL(datasetExportUrl('orgs', STATE))
    expect(url.origin).toBe('http://api.test')
    expect(url.pathname).toBe('/api/library/data/orgs/export.csv')
    expect(url.searchParams.get('q')).toBe('farm')
    expect(url.searchParams.get('sort')).toBe('Score')
    expect(url.searchParams.get('dir')).toBe('desc')
    expect(JSON.parse(url.searchParams.get('filter')!)).toHaveLength(1)
    // paging is about the screen, not the file
    expect(url.searchParams.get('page')).toBeNull()
    expect(url.searchParams.get('limit')).toBeNull()
    expect(url.searchParams.get('columns')).toBeNull()
  })

  it('names the visible columns when the table is hiding some, and escapes the slug', () => {
    expect(new URL(datasetExportUrl('orgs', {}, ['Organization', 'Score'])).searchParams.get('columns')).toBe(
      '["Organization","Score"]',
    )
    expect(datasetExportUrl('a b', {})).toBe('http://api.test/api/library/data/a%20b/export.csv')
  })

  it('omits dir for the default ascending sort', () => {
    expect(datasetExportUrl('orgs', { sort: 'Score' })).toBe('http://api.test/api/library/data/orgs/export.csv?sort=Score')
  })
})

describe('client-side CSV of a group-by table (P5-42)', () => {
  it('escapes formulas and quotes the RFC 4180 way, exactly as the server does', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)")
    expect(csvCell('-5')).toBe("'-5")
    expect(csvCell('@x')).toBe("'@x")
    expect(csvCell('=1,2')).toBe(`"'=1,2"`)
  })

  it('writes value / count / percent with a header naming the column', () => {
    const csv = groupByCsv('Tier', [{ value: 'Tier 1', count: 3 }, { value: 'Tier 2', count: 1 }], 4)
    expect(csv).toBe('Tier,Count,Percent\r\nTier 1,3,75.0\r\nTier 2,1,25.0\r\n')
  })

  it('never divides by zero', () => {
    expect(groupByCsv('Tier', [{ value: 'x', count: 0 }], 0)).toBe('Tier,Count,Percent\r\nx,0,0.0\r\n')
  })
})

describe('plain-language formatting (P5-42)', () => {
  it('rounds a share to whole percents, keeps one decimal under 1%, and never says NaN', () => {
    expect(sharePct(1, 4)).toBe('25%')
    expect(sharePct(2, 3)).toBe('67%')
    expect(sharePct(1, 1000)).toBe('0.1%')
    expect(sharePct(0, 100)).toBe('0%')
    expect(sharePct(5, 0)).toBe('0%')
  })

  it('formats numbers the way a reader expects', () => {
    expect(formatNumber(1200)).toBe('1,200')
    expect(formatNumber(78.253)).toBe('78.25')
    expect(formatNumber(Number.NaN)).toBe('—')
  })
})
