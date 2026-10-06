import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * P5-31: tabular service — pure parsing/schema/query functions, plus the
 * catalog-backed `readDataset` cache. The HTTP surface is covered by
 * routes/libraryData.test.ts against the real app.
 */

// Set before the import: the budget is read once, at module load. A tiny
// budget lets eviction be exercised with files of a realistic size.
process.env.TABULAR_CACHE_MAX_BYTES = '2048'
process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const {
  parseTabular,
  queryRows,
  selectRows,
  filterRows,
  parseRowsQuery,
  pickTabularFile,
  readDataset,
  clearTabularCache,
  tabularCacheStats,
  summarizeColumn,
  overviewColumns,
  csvCell,
  toCsv,
  TabularError,
  TABULAR_MAX_ROWS,
  SUMMARY_TOP_N,
  SUMMARY_GROUP_TOP_N,
  HISTOGRAM_BINS,
  DATE_BUCKETS_MAX,
} = await import('./libraryTabular.js')
const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')

const csv = (s: string) => Buffer.from(s, 'utf8')

describe('parseTabular — CSV', () => {
  it('parses a header row + rows, keeps cells as strings, counts rows', () => {
    const ds = parseTabular(csv('name,score\nAlpha,12\nBeta,7\n'), 'x.csv')
    expect(ds.rowCount).toBe(2)
    expect(ds.rows[0]).toEqual({ name: 'Alpha', score: '12' })
    expect(ds.columns.map(c => c.name)).toEqual(['name', 'score'])
  })

  it('strips a UTF-8 BOM and trims header names', () => {
    const ds = parseTabular(csv('﻿ name , value\nA,1\n'), 'x.csv')
    expect(ds.columns.map(c => c.name)).toEqual(['name', 'value'])
    expect(ds.rows[0]).toEqual({ name: 'A', value: '1' })
  })

  it('handles quoted commas, quoted newlines, and escaped quotes', () => {
    const ds = parseTabular(csv('org,notes\n"Black Farmer Fund, Inc.","line one\nline two"\n"Say ""hi""",x\n'), 'x.csv')
    expect(ds.rows[0].org).toBe('Black Farmer Fund, Inc.')
    expect(ds.rows[0].notes).toBe('line one\nline two')
    expect(ds.rows[1].org).toBe('Say "hi"')
  })

  it('pads ragged rows and drops trailing blank lines', () => {
    const ds = parseTabular(csv('a,b,c\n1,2\n3,4,5,6\n\n\n'), 'x.csv')
    expect(ds.rowCount).toBe(2)
    expect(ds.rows[0]).toEqual({ a: '1', b: '2', c: '' })
    expect(ds.rows[1]).toEqual({ a: '3', b: '4', c: '5' })
  })

  it('names blank or duplicate headers so every column is addressable', () => {
    const ds = parseTabular(csv('#,name,,name\n1,A,x,B\n'), 'x.csv')
    expect(ds.columns.map(c => c.name)).toEqual(['#', 'name', 'column_3', 'name_2'])
    expect(ds.rows[0]).toEqual({ '#': '1', name: 'A', column_3: 'x', name_2: 'B' })
  })

  it('accepts tab-separated files', () => {
    const ds = parseTabular(csv('a\tb\n1\t2\n'), 'x.tsv')
    expect(ds.rows[0]).toEqual({ a: '1', b: '2' })
  })

  it('rejects a file with no header / no rows as non-tabular (415)', () => {
    expect(() => parseTabular(csv(''), 'x.csv')).toThrow(TabularError)
    try {
      parseTabular(csv('\n\n'), 'x.csv')
    } catch (err) {
      expect((err as InstanceType<typeof TabularError>).status).toBe(415)
    }
  })

  it('caps the row count (413)', () => {
    const big = 'a\n' + Array.from({ length: TABULAR_MAX_ROWS + 1 }, (_, i) => String(i)).join('\n') + '\n'
    try {
      parseTabular(csv(big), 'x.csv')
      throw new Error('expected throw')
    } catch (err) {
      expect((err as InstanceType<typeof TabularError>).status).toBe(413)
    }
  })
})

describe('parseTabular — JSON', () => {
  it('parses an array of objects; nested values are JSON-stringified, null is empty', () => {
    const ds = parseTabular(Buffer.from(JSON.stringify([{ a: 1, b: 'x', c: null, d: { k: 1 } }, { a: 2, e: true }])), 'x.json')
    expect(ds.columns.map(c => c.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(ds.rows[0]).toEqual({ a: '1', b: 'x', c: '', d: '{"k":1}', e: '' })
    expect(ds.rows[1].e).toBe('true')
  })

  it('parses a GeoJSON FeatureCollection: properties + _lng/_lat for points', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-90.05, 35.15] }, properties: { NAME: 'A' } },
        { type: 'Feature', geometry: null, properties: { NAME: 'B' } },
      ],
    }
    const ds = parseTabular(Buffer.from(JSON.stringify(fc)), 'x.geojson')
    expect(ds.rows[0]).toEqual({ NAME: 'A', _lng: '-90.05', _lat: '35.15' })
    expect(ds.rows[1]).toEqual({ NAME: 'B', _lng: '', _lat: '' })
  })

  // P7-3: a LineString's coordinates used to be thrown away here — the
  // FeatureCollection branch kept `_lng`/`_lat` for Points and nothing else,
  // so nothing downstream could ever have drawn a line. `_path` carries the
  // vertices through, as compact JSON, and the column appears ONLY when the
  // collection actually holds line geometry — every point/polygon geojson
  // dataset in the library keeps the exact columns it had.
  it('keeps a LineString/MultiLineString path as _path, and still has no _path without one', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] }, properties: { NAME: 'A' } },
        { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-90, 35], [-89, 35]], [[-88, 34], [-87, 34]]] }, properties: { NAME: 'B' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [-90.05, 35.15] }, properties: { NAME: 'C' } },
      ],
    }
    const ds = parseTabular(Buffer.from(JSON.stringify(fc)), 'lines.geojson')
    expect(ds.columns.map(c => c.name)).toEqual(['NAME', '_lng', '_lat', '_path'])
    expect(ds.rows[0]._path).toBe('[[-90.05,35.15],[-89.9,35.2]]')
    expect(ds.rows[1]._path).toBe('[[[-90,35],[-89,35]],[[-88,34],[-87,34]]]')
    // A point in a line file has no path, and keeps its own coordinates.
    expect(ds.rows[2]).toEqual({ NAME: 'C', _lng: '-90.05', _lat: '35.15', _path: '' })

    const pointsOnly = parseTabular(
      Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [fc.features[2]] })),
      'points.geojson',
    )
    expect(pointsOnly.columns.map(c => c.name)).toEqual(['NAME', '_lng', '_lat'])
  })

  it('rejects JSON that is not an array of objects or a FeatureCollection (415)', () => {
    for (const body of ['{"a":1}', '[1,2,3]', '"str"', 'not json']) {
      try {
        parseTabular(Buffer.from(body), 'x.json')
        throw new Error('expected throw')
      } catch (err) {
        expect((err as InstanceType<typeof TabularError>).status).toBe(415)
      }
    }
  })
})

describe('schema inference + stats', () => {
  const ds = parseTabular(
    csv(
      'name,tier,amount,when,flag,blank\n' +
        'A,Tier 1,"$1,200",2024-01-05,yes,\n' +
        'B,Tier 2,300,2023-12-31,no,\n' +
        'C,Tier 1,,2024-02-10,yes,\n' +
        'D,Tier 1,50%,,TRUE,\n',
    ),
    'x.csv',
  )
  const col = (n: string) => ds.columns.find(c => c.name === n)!

  it('types columns: string / number (tolerating $ , %) / date / boolean / empty', () => {
    expect(col('name').type).toBe('string')
    expect(col('amount').type).toBe('number')
    expect(col('when').type).toBe('date')
    expect(col('flag').type).toBe('boolean')
    expect(col('blank').type).toBe('empty')
  })

  it('counts filled + distinct, numeric min/max/mean, and top values for low-cardinality columns', () => {
    expect(col('amount').filled).toBe(3)
    expect(col('amount').min).toBe(50)
    expect(col('amount').max).toBe(1200)
    expect(col('amount').mean).toBeCloseTo((1200 + 300 + 50) / 3, 6)
    expect(col('tier').distinct).toBe(2)
    expect(col('tier').topValues).toEqual([
      { value: 'Tier 1', count: 3 },
      { value: 'Tier 2', count: 1 },
    ])
    expect(col('blank').filled).toBe(0)
    expect(col('blank').distinct).toBe(0)
  })

  it('omits top values for high-cardinality columns', () => {
    const many = 'id\n' + Array.from({ length: 300 }, (_, i) => `v${i}`).join('\n') + '\n'
    const d2 = parseTabular(csv(many), 'x.csv')
    expect(d2.columns[0].distinct).toBe(300)
    expect(d2.columns[0].topValues).toBeUndefined()
  })
})

describe('queryRows', () => {
  const ds = parseTabular(
    csv(
      'org,state,tier,score,updated\n' +
        'Black Farmer Fund,NY,Tier 1,90,2024-03-01\n' +
        'Southwest Georgia Project,GA,Tier 1,75,2023-11-20\n' +
        'Proud Ground,OR,Tier 2,,2024-01-15\n' +
        'Truly Living Well,GA,Tier 2,60,\n' +
        'HEAL Food Alliance,CA,Tier 3,88,2022-06-30\n',
    ),
    'x.csv',
  )

  it('returns page 1 with defaults and stable _row indexes', () => {
    const r = queryRows(ds, {})
    expect(r.total).toBe(5)
    expect(r.page).toBe(1)
    expect(r.limit).toBe(50)
    expect(r.rows.map(x => x._row)).toEqual([0, 1, 2, 3, 4])
  })

  it('q is a case-insensitive substring match across all cells', () => {
    expect(queryRows(ds, { q: 'georgia' }).rows.map(x => x.org)).toEqual(['Southwest Georgia Project'])
    expect(queryRows(ds, { q: 'tier 2' }).total).toBe(2)
    expect(queryRows(ds, { q: 'zzz' }).total).toBe(0)
  })

  it('filters: eq / contains / gte / lte / empty / notEmpty with typed comparisons', () => {
    expect(queryRows(ds, { filter: [{ column: 'state', op: 'eq', value: 'ga' }] }).total).toBe(2)
    expect(queryRows(ds, { filter: [{ column: 'org', op: 'contains', value: 'food' }] }).total).toBe(1)
    expect(queryRows(ds, { filter: [{ column: 'score', op: 'gte', value: '80' }] }).rows.map(x => x.org)).toEqual([
      'Black Farmer Fund',
      'HEAL Food Alliance',
    ])
    expect(queryRows(ds, { filter: [{ column: 'score', op: 'lte', value: '75' }] }).total).toBe(2)
    expect(queryRows(ds, { filter: [{ column: 'score', op: 'empty' }] }).rows.map(x => x.org)).toEqual(['Proud Ground'])
    expect(queryRows(ds, { filter: [{ column: 'updated', op: 'notEmpty' }] }).total).toBe(4)
    expect(queryRows(ds, { filter: [{ column: 'updated', op: 'gte', value: '2024-01-01' }] }).total).toBe(2)
    // filters AND together
    expect(
      queryRows(ds, {
        filter: [
          { column: 'state', op: 'eq', value: 'GA' },
          { column: 'tier', op: 'eq', value: 'Tier 1' },
        ],
      }).total,
    ).toBe(1)
  })

  it('sorts numerically for number columns, empties last, and reverses for desc', () => {
    expect(queryRows(ds, { sort: 'score', dir: 'asc' }).rows.map(x => x.score)).toEqual(['60', '75', '88', '90', ''])
    expect(queryRows(ds, { sort: 'score', dir: 'desc' }).rows.map(x => x.score)).toEqual(['90', '88', '75', '60', ''])
    expect(queryRows(ds, { sort: 'org' }).rows[0].org).toBe('Black Farmer Fund')
    expect(queryRows(ds, { sort: 'updated', dir: 'desc' }).rows.map(x => x.updated)).toEqual([
      '2024-03-01',
      '2024-01-15',
      '2023-11-20',
      '2022-06-30',
      '',
    ])
  })

  it('pages with total unaffected by page/limit', () => {
    const r = queryRows(ds, { page: 2, limit: 2 })
    expect(r.total).toBe(5)
    expect(r.rows.map(x => x._row)).toEqual([2, 3])
    expect(queryRows(ds, { page: 9, limit: 2 }).rows).toEqual([])
  })
})

describe('parseRowsQuery (URL params → validated query)', () => {
  const columns = ['org', 'score']

  it('accepts a full valid query', () => {
    const q = parseRowsQuery(
      { q: ' farm ', sort: 'score', dir: 'desc', filter: JSON.stringify([{ column: 'org', op: 'contains', value: 'x' }]), page: '2', limit: '10' },
      columns,
    )
    expect(q).toEqual({
      q: 'farm',
      sort: 'score',
      dir: 'desc',
      filter: [{ column: 'org', op: 'contains', value: 'x' }],
      page: 2,
      limit: 10,
    })
  })

  it.each([
    [{ sort: 'nope' }, /unknown column/],
    [{ dir: 'sideways' }, /dir/],
    [{ filter: '{not json' }, /filter/],
    [{ filter: JSON.stringify([{ column: 'org', op: 'between', value: '1' }]) }, /op/],
    [{ filter: JSON.stringify([{ column: 'zzz', op: 'eq', value: '1' }]) }, /unknown column/],
    [{ filter: JSON.stringify([{ column: 'org', op: 'eq' }]) }, /value/],
    [{ page: '0' }, /page/],
    [{ limit: '501' }, /limit/],
    [{ limit: 'abc' }, /limit/],
  ])('rejects %j with a message naming the field', (params, re) => {
    const q = parseRowsQuery(params as Record<string, unknown>, columns)
    expect('error' in q).toBe(true)
    if ('error' in q) expect(q.error).toMatch(re)
  })

  it('caps filters at 20 and treats an empty filter list as no filter', () => {
    const q = parseRowsQuery({ filter: '[]' }, columns)
    expect(q).toEqual({})
    const tooMany = JSON.stringify(Array.from({ length: 21 }, () => ({ column: 'org', op: 'empty' })))
    const bad = parseRowsQuery({ filter: tooMany }, columns)
    expect('error' in bad).toBe(true)
  })
})

describe('pickTabularFile', () => {
  const files = [
    { key: 'library/datasets/orgs/meta.json', size: 10 },
    { key: 'library/datasets/orgs/README.md', size: 10 },
    { key: 'library/datasets/orgs/organizations.csv', size: 10 },
    { key: 'library/datasets/orgs/extra.geojson', size: 10 },
  ]
  it('lists tabular candidates (csv/tsv/json/geojson) by basename, never meta.json', () => {
    expect(pickTabularFile(files).candidates).toEqual(['organizations.csv', 'extra.geojson'])
  })
  it('defaults to the first candidate and honours an explicit basename', () => {
    expect(pickTabularFile(files).chosen?.key).toBe('library/datasets/orgs/organizations.csv')
    expect(pickTabularFile(files, 'extra.geojson').chosen?.key).toBe('library/datasets/orgs/extra.geojson')
  })
  it('returns no choice for an unknown name or a non-tabular entry', () => {
    expect(pickTabularFile(files, 'nope.csv').chosen).toBeNull()
    expect(pickTabularFile([{ key: 'library/documents/x/notes.pdf', size: 1 }]).chosen).toBeNull()
  })
})


describe('rows with dangerous header names', () => {
  // A column literally called __proto__ is not an attack so much as a
  // spreadsheet accident, but on a plain object it silently vanishes and
  // every later read hands back Object.prototype instead of a string —
  // which is a 500 on a dataset the user can browse.
  it('parses, infers, and queries a table whose headers are __proto__ / constructor', () => {
    const ds = parseTabular(csv('__proto__,constructor,name\nalpha,beta,gamma\nx,y,z\n'), 'x.csv')
    expect(ds.columns.map(c => c.name)).toEqual(['__proto__', 'constructor', 'name'])
    expect(ds.rows[0]['__proto__']).toBe('alpha')
    expect(ds.rows[0]['constructor']).toBe('beta')
    expect(ds.columns[0].type).toBe('string')
    expect(ds.columns[0].filled).toBe(2)
    const page = queryRows(ds, { q: 'alpha' })
    expect(page.total).toBe(1)
    expect(page.rows[0]['__proto__']).toBe('alpha')
    expect(queryRows(ds, { sort: '__proto__', dir: 'desc' }).rows[0]['__proto__']).toBe('x')
    expect(queryRows(ds, { filter: [{ column: 'constructor', op: 'eq', value: 'beta' }] }).total).toBe(1)
  })

  it('does the same for JSON objects', () => {
    const ds = parseTabular(csv('[{"__proto__":"a","id":"1"},{"__proto__":"b","id":"2"}]'), 'x.json')
    expect(ds.rows.map(r => r['__proto__'])).toEqual(['a', 'b'])
    expect(queryRows(ds, { q: 'b' }).total).toBe(1)
  })
})

describe('readDataset cache', () => {
  let fake: InstanceType<typeof FakeS3>
  let dataDir: string

  const memPool = (): PgPool => {
    const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
    return new Pool() as unknown as PgPool
  }

  /** A CSV of roughly `bytes` bytes. */
  const bulk = (bytes: number) => 'id,value\n' + '1,abcdefgh\n'.repeat(Math.ceil(bytes / 11))

  const seedEntry = (slug: string, body: string) => {
    fake.seed(`library/datasets/${slug}/meta.json`, JSON.stringify({ title: slug, status: 'published' }))
    fake.seed(`library/datasets/${slug}/data.csv`, body)
  }

  const gets = (slug: string) =>
    fake.calls.filter(c => c === `GetObjectCommand:library/datasets/${slug}/data.csv`).length

  beforeEach(async () => {
    expect(await initLibraryDb(memPool())).toBe(true)
    fake = new FakeS3()
    dataDir = mkdtempSync(join(tmpdir(), 'blo-tabular-test-'))
    await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
    clearTabularCache()
  })

  afterEach(async () => {
    await closeLibraryBucket()
    await closeLibraryDb()
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('holds parsed files up to a byte budget, evicting the oldest first', async () => {
    seedEntry('one', bulk(1200))
    seedEntry('two', bulk(1200))
    await reindexCatalog()

    await readDataset('one')
    expect(tabularCacheStats().entries).toBe(1)
    await readDataset('two')
    // Both together are over the 2048-byte budget, so the older one goes.
    const stats = tabularCacheStats()
    expect(stats.entries).toBe(1)
    expect(stats.bytes).toBeLessThanOrEqual(2048)
    // The evicted file is still readable — it is a cache, not the truth.
    expect((await readDataset('one')).parsed.rowCount).toBeGreaterThan(0)
    expect(tabularCacheStats().entries).toBe(1)
  })

  it('parses once when two readers ask for the same file at the same time', async () => {
    seedEntry('shared', bulk(300))
    await reindexCatalog()

    const [a, b] = await Promise.all([readDataset('shared'), readDataset('shared')])
    expect(a.parsed).toBe(b.parsed)
    expect(gets('shared')).toBe(1)
  })
})

/**
 * P5-42: analysis for non-technical researchers — column summaries over
 * the CURRENT filtered set, the per-column overview, and CSV export.
 */
describe('summarizeColumn (P5-42)', () => {
  const ds = parseTabular(
    csv(
      'org,state,tier,score,updated\n' +
        'Black Farmer Fund,NY,Tier 1,90,2024-03-01\n' +
        'Southwest Georgia Project,GA,Tier 1,75,2023-11-20\n' +
        'Proud Ground,OR,Tier 2,,2024-01-15\n' +
        'Truly Living Well,GA,Tier 2,60,\n' +
        'HEAL Food Alliance,CA,Tier 3,88,2022-06-30\n',
    ),
    'x.csv',
  )

  it('counts filled / empty / different values and the most common values, ties broken by value', () => {
    const s = summarizeColumn(ds, 'tier')
    expect(s.column).toBe('tier')
    expect(s.type).toBe('string')
    expect(s.filled).toBe(5)
    expect(s.empty).toBe(0)
    expect(s.distinct).toBe(3)
    // Tier 1 and Tier 2 both appear twice — the tie is broken by value, so
    // the list is the same on every request (and every server).
    expect(s.top).toEqual([
      { value: 'Tier 1', count: 2 },
      { value: 'Tier 2', count: 2 },
      { value: 'Tier 3', count: 1 },
    ])
    expect(s.numbers).toBeNull()
    expect(s.dates).toBeNull()
  })

  it('counts blanks as empty, never as a value', () => {
    const s = summarizeColumn(ds, 'score')
    expect(s.filled).toBe(4)
    expect(s.empty).toBe(1)
    expect(s.distinct).toBe(4)
    expect(s.top.some(t => t.value === '')).toBe(false)
  })

  it('describes a number column with smallest / middle / largest and a mean', () => {
    const n = summarizeColumn(ds, 'score').numbers!
    expect(n.min).toBe(60)
    expect(n.max).toBe(90)
    expect(n.mean).toBeCloseTo((90 + 75 + 60 + 88) / 4, 6)
    // Even count: the middle is the average of the two central values.
    expect(n.median).toBe(81.5)
  })

  it('takes the median of an odd count as the middle value itself', () => {
    const odd = parseTabular(csv('n\n1\n5\n100\n'), 'x.csv')
    expect(summarizeColumn(odd, 'n').numbers!.median).toBe(5)
  })

  it('buckets numbers into ten equal bins that cover min..max and count every value', () => {
    const n = summarizeColumn(ds, 'score').numbers!
    expect(n.histogram).toHaveLength(HISTOGRAM_BINS)
    expect(n.histogram[0].from).toBe(60)
    expect(n.histogram[HISTOGRAM_BINS - 1].to).toBe(90)
    expect(n.histogram.reduce((sum, b) => sum + b.count, 0)).toBe(4)
    // 60 → first bin, 75 → the middle, 88 and 90 → the last.
    expect(n.histogram.map(b => b.count)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 2])
    // bins touch: every bin's `to` is the next bin's `from`
    for (let i = 1; i < n.histogram.length; i++) expect(n.histogram[i].from).toBeCloseTo(n.histogram[i - 1].to, 9)
  })

  it('collapses the histogram to one bar when every value is the same (ten zero-width bars are a lie)', () => {
    const flat = parseTabular(csv('n\n7\n7\n7\n'), 'x.csv')
    const n = summarizeColumn(flat, 'n').numbers!
    expect(n.histogram).toEqual([{ from: 7, to: 7, count: 3 }])
    expect(n.median).toBe(7)
  })

  it('gives a date column its range as the file spells it, and no numbers', () => {
    const s = summarizeColumn(ds, 'updated')
    expect(s.type).toBe('date')
    expect(s.dates).toMatchObject({ min: '2022-06-30', max: '2024-03-01' })
    expect(s.numbers).toBeNull()
    expect(s.filled).toBe(4)
    expect(s.empty).toBe(1)
  })

  // P5-54: the count-over-time chart needs per-period counts, which only the
  // server can produce (it holds the rows). Empty periods are kept so a gap
  // in the data reads as a gap and not as a straight line.
  it('buckets a date column by month, oldest first, empty months included', () => {
    const dates = summarizeColumn(ds, 'updated').dates!
    expect(dates.unit).toBe('month')
    expect(dates.byMonth).toHaveLength(22) // 2022-06 … 2024-03
    expect(dates.byMonth[0]).toEqual({ from: '2022-06', count: 1 })
    expect(dates.byMonth.at(-1)).toEqual({ from: '2024-03', count: 1 })
    expect(dates.byMonth.filter(b => b.count > 0)).toEqual([
      { from: '2022-06', count: 1 },
      { from: '2023-11', count: 1 },
      { from: '2024-01', count: 1 },
      { from: '2024-03', count: 1 },
    ])
    expect(dates.byMonth.reduce((n, b) => n + b.count, 0)).toBe(4)
  })

  it('switches to whole years once months would exceed the bucket cap', () => {
    const long = parseTabular(csv('d\n2000-01-01\n2000-07-04\n2011-05-05\n2019-12-31\n'), 'x.csv')
    const dates = summarizeColumn(long, 'd').dates!
    expect(dates.unit).toBe('year')
    expect(dates.byMonth).toHaveLength(20) // 2000 … 2019
    expect(dates.byMonth[0]).toEqual({ from: '2000', count: 2 })
    expect(dates.byMonth.at(-1)).toEqual({ from: '2019', count: 1 })
  })

  it('never returns more than the bucket cap, however wild the range', () => {
    const wild = parseTabular(csv('d\n1500-01-01\n2024-01-01\n'), 'x.csv')
    const dates = summarizeColumn(wild, 'd').dates!
    expect(dates.unit).toBe('year')
    expect(dates.byMonth).toHaveLength(DATE_BUCKETS_MAX)
    // The newest end is the one a reader cares about, so that is what is kept.
    expect(dates.byMonth.at(-1)).toEqual({ from: '2024', count: 1 })
  })

  it('buckets only the filtered set', () => {
    const dates = summarizeColumn(ds, 'updated', { filter: [{ column: 'state', op: 'eq', value: 'GA' }] }).dates!
    expect(dates.byMonth.filter(b => b.count > 0)).toEqual([{ from: '2023-11', count: 1 }])
  })

  it('summarises the FILTERED set, not the whole file', () => {
    const filter = { filter: [{ column: 'state', op: 'eq' as const, value: 'GA' }] }
    const tier = summarizeColumn(ds, 'tier', filter)
    expect(tier.filled).toBe(2)
    expect(tier.empty).toBe(0)
    expect(tier.distinct).toBe(2)
    expect(tier.top).toEqual([
      { value: 'Tier 1', count: 1 },
      { value: 'Tier 2', count: 1 },
    ])
    const score = summarizeColumn(ds, 'score', filter).numbers!
    expect(score.min).toBe(60)
    expect(score.max).toBe(75)
    expect(score.median).toBe(67.5)
  })

  it('honours ?q= the same way the table does', () => {
    const s = summarizeColumn(ds, 'state', { q: 'tier 1' })
    expect(s.filled).toBe(2)
    expect(s.top).toEqual([
      { value: 'GA', count: 1 },
      { value: 'NY', count: 1 },
    ])
  })

  it('reports an all-empty filtered set without dividing by zero', () => {
    const s = summarizeColumn(ds, 'score', { q: 'no-such-thing' })
    expect(s).toMatchObject({ filled: 0, empty: 0, distinct: 0, top: [], numbers: null, dates: null })
  })

  it('caps the most-common list at 20, and at 200 when grouping by the column', () => {
    const many = parseTabular(csv('id\n' + Array.from({ length: 250 }, (_, i) => `v${i}`).join('\n') + '\n'), 'x.csv')
    expect(summarizeColumn(many, 'id').top).toHaveLength(SUMMARY_TOP_N)
    expect(summarizeColumn(many, 'id', {}, { topLimit: SUMMARY_GROUP_TOP_N }).top).toHaveLength(SUMMARY_GROUP_TOP_N)
    expect(summarizeColumn(many, 'id').distinct).toBe(250)
  })

  it('caches per (parse, filters, cap) and forgets everything when the parse is dropped', () => {
    clearTabularCache()
    const a = summarizeColumn(ds, 'tier')
    expect(summarizeColumn(ds, 'tier')).toBe(a)
    // a different filtered set is a different answer
    expect(summarizeColumn(ds, 'tier', { filter: [{ column: 'state', op: 'eq', value: 'GA' }] })).not.toBe(a)
    // a different cap is a different answer
    expect(summarizeColumn(ds, 'tier', {}, { topLimit: SUMMARY_GROUP_TOP_N })).not.toBe(a)
    clearTabularCache()
    expect(summarizeColumn(ds, 'tier')).not.toBe(a)
  })
})

describe('overviewColumns (P5-42)', () => {
  const ds = parseTabular(csv('org,state,score\nA,NY,90\nB,GA,\nC,GA,60\nD,,\n'), 'x.csv')

  it('gives every column a type, a filled percentage, and a distinct count', () => {
    expect(overviewColumns(ds)).toEqual([
      { column: 'org', type: 'string', filledPct: 100, distinct: 4 },
      { column: 'state', type: 'string', filledPct: 75, distinct: 2 },
      { column: 'score', type: 'number', filledPct: 50, distinct: 2 },
    ])
  })

  it('recomputes against the filtered set', () => {
    const over = overviewColumns(ds, { filter: [{ column: 'state', op: 'eq', value: 'GA' }] })
    expect(over.find(c => c.column === 'score')).toEqual({ column: 'score', type: 'number', filledPct: 50, distinct: 1 })
    expect(over.find(c => c.column === 'state')!.filledPct).toBe(100)
  })

  it('reports 0% rather than NaN when nothing matches', () => {
    const over = overviewColumns(ds, { q: 'zzz' })
    expect(over.every(c => c.filledPct === 0 && c.distinct === 0)).toBe(true)
  })

  it('is cached per filter signature', () => {
    clearTabularCache()
    const first = overviewColumns(ds)
    expect(overviewColumns(ds)).toBe(first)
    expect(overviewColumns(ds, { q: 'ny' })).not.toBe(first)
  })
})

describe('filterRows / selectRows (shared with queryRows)', () => {
  const ds = parseTabular(csv('org,score\nA,90\nB,75\nC,\nD,60\n'), 'x.csv')

  it('filterRows keeps file order and the row index', () => {
    expect(filterRows(ds, { filter: [{ column: 'score', op: 'gte', value: '75' }] }).map(r => r.i)).toEqual([0, 1])
    expect(filterRows(ds, {}).map(r => r.i)).toEqual([0, 1, 2, 3])
  })

  it('selectRows is exactly what queryRows pages, in the same order', () => {
    const query = { sort: 'score', dir: 'desc' as const }
    expect(selectRows(ds, query).map(r => r.row.org)).toEqual(['A', 'B', 'D', 'C'])
    expect(queryRows(ds, query).rows.map(r => r.org)).toEqual(['A', 'B', 'D', 'C'])
    expect(queryRows(ds, { ...query, page: 2, limit: 2 }).rows.map(r => r.org)).toEqual(
      selectRows(ds, query).slice(2, 4).map(r => r.row.org),
    )
  })
})

describe('toCsv (P5-42 export)', () => {
  it('writes a header and CRLF rows for the chosen columns only', () => {
    const rows = [
      { a: '1', b: 'x', c: 'skip' },
      { a: '2', b: 'y', c: 'skip' },
    ]
    expect(toCsv(['a', 'b'], rows)).toBe('a,b\r\n1,x\r\n2,y\r\n')
  })

  it('writes rows without a header when asked (streaming in chunks)', () => {
    expect(toCsv(['a'], [{ a: '1' }], { header: false })).toBe('1\r\n')
    expect(toCsv(['a'], [], { header: true })).toBe('a\r\n')
    expect(toCsv(['a'], [], { header: false })).toBe('')
  })

  it('leaves a missing cell empty rather than writing undefined', () => {
    expect(toCsv(['a', 'b'], [{ a: '1' }])).toBe('a,b\r\n1,\r\n')
  })

  it('quotes commas, quotes, and newlines the RFC 4180 way', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"')
  })

  it('neutralises cells that a spreadsheet would run as a formula', () => {
    expect(csvCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-5')).toBe("'-5")
    expect(csvCell('@import')).toBe("'@import")
    // escape first, then quote: the apostrophe must survive the quoting
    expect(csvCell('=1,2')).toBe(`"'=1,2"`)
    expect(csvCell('=cmd|"/c calc"!A1')).toBe(`"'=cmd|""/c calc""!A1"`)
    // a value that merely CONTAINS one of those characters is untouched
    expect(csvCell('a=b')).toBe('a=b')
  })

  it('escapes header names too — a column can be called "=1+1"', () => {
    expect(toCsv(['=1+1'], [{ '=1+1': '@x' }])).toBe("'=1+1\r\n'@x\r\n")
  })
})
