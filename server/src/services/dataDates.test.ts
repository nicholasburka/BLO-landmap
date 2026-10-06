import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { datesFromManifest, deriveDates, isDataDate, normalizeDataDate, readDates, readYearColumn } from './dataDates.js'

/**
 * P7-10. Two halves: the grammar (mirrored on the client, checked here) and
 * the DERIVATION, which is this file's real subject — `coverage.ts`'s sibling,
 * pure with the one file read injected.
 */

const input = (meta: Record<string, unknown>, files: string[] = []) => ({ kind: 'dataset', meta, files, slug: 'x' })

describe('the grammar matches the client half', () => {
  it('is the same regex, the same window and the same canonical shape', () => {
    // The server cannot read the client's TypeScript, so the grammar is
    // written twice — the contract `provenance.ts` has with its field table,
    // for the same reason: the model writes a date here and the LEGEND reads
    // it there, so a drift would show up as a layer that cannot say when it
    // is from.
    const here = dirname(fileURLToPath(import.meta.url))
    const client = readFileSync(join(here, '../../../src/lib/dataDates.ts'), 'utf8')
    expect(client).toContain('const PART = /^(\\d{4})(?:-(\\d{2})(?:-(\\d{2}))?)?$/')
    expect(client).toContain('const MIN_YEAR = 1790')
    expect(client).toContain('const MAX_YEAR = 2200')
    // The epoch ranges and the sentinel list are part of the grammar too: a
    // drift there would have one side read an ArcGIS export as a date and the
    // other read it as nothing.
    expect(client).toContain('const EPOCH_SECONDS_MIN = 1e8')
    expect(client).toContain('const EPOCH_MILLIS_MIN = 1e11')
    expect(client).toContain("const SENTINEL_DAYS = new Set(['1899-12-30', '1899-12-31', '1900-01-01', '1970-01-01'])")
  })

  it('reads and writes the same values the client does', () => {
    expect(isDataDate('2019/2023')).toBe(true)
    expect(isDataDate('2019-2023')).toBe(false)
    expect(normalizeDataDate('2019–2023')).toBe('2019/2023')
    expect(normalizeDataDate('October 2026')).toBe('2026-10')
    expect(normalizeDataDate('every five years')).toBe('')
    // The LABELS are deliberately not mirrored: nothing on this side renders
    // words for a person, so they live only in the client file where the
    // legend and the entry page read them. What has to agree is the grammar —
    // what a stored value may BE — and that is what is checked above.
    expect(normalizeDataDate(1710201600000)).toBe('2024-03-12')
  })
})

describe('covers — what the data is about', () => {
  it('takes a hand-written block over everything else', async () => {
    const read = datesFromManifest(input({ dates: { covers: '2019/2023' }, layer: { year: 2026 } }))
    expect(read.covers).toBe('2019/2023')
  })

  it('normalises what a person wrote rather than refusing it', async () => {
    expect(datesFromManifest(input({ dates: { covers: '2019 to 2023' } })).covers).toBe('2019/2023')
  })

  it("reads the layer block's declared year, which three real entries already carry", () => {
    expect(datesFromManifest(input({ layer: { name: 'Organizations', year: 2026 } })).covers).toBe('2026')
  })

  it('refuses a layer year it cannot read instead of inventing one', () => {
    expect(datesFromManifest(input({ layer: { year: 'recent' } })).covers).toBe('')
  })

  it("reads the table's own year column when the manifest cannot say", async () => {
    const dates = await deriveDates(input({}, ['sites.csv']), async () => 'GEOID,year,value\n13001,2021,4\n13002,2023,7\n')
    expect(dates.covers).toBe('2021/2023')
  })

  it('reads a single-year column as a year, not as an interval of one', async () => {
    const dates = await deriveDates(input({}, ['sites.csv']), async () => 'GEOID,year\n13001,2024\n13002,2024\n')
    expect(dates.covers).toBe('2024')
  })

  it('names what it read off, so a reading can be checked without re-running it', async () => {
    const reading = await readDates(input({}, ['sites.csv']), async () => 'year\n2024\n')
    expect(reading.from.covers).toContain('sites.csv')
    expect(reading.from.covers).toContain('year')
  })

  it('takes a year column under any of its usual spellings', () => {
    expect(readYearColumn('a.csv', 'Data Year\n2020\n')).toBe('2020')
    expect(readYearColumn('a.csv', 'survey_year\n2020\n')).toBe('2020')
    expect(readYearColumn('a.csv', 'VINTAGE\n2020\n')).toBe('2020')
    expect(readYearColumn('a.csv', 'reference year\n2020\n')).toBe('2020')
  })

  it('refuses a column that merely CONTAINS the word year', () => {
    // `year_built` is a fact about each house, not about the dataset, and a
    // derivation that read it would declare a housing table to be "about
    // 1890-2015". The allowlist is the whole defence: a reading nobody can
    // trust is worse than the queue row (P6-19).
    expect(readYearColumn('a.csv', 'GEOID,year_built\n13001,1890\n13002,2015\n')).toBe('')
    expect(readYearColumn('a.csv', 'years_in_operation\n12\n')).toBe('')
    expect(readYearColumn('a.csv', 'fiscal_year\n2024\n')).toBe('')
  })

  it('refuses a year column with anything in it that is not a plain year', () => {
    expect(readYearColumn('a.csv', 'year\n2019-2023\n')).toBe('')
    expect(readYearColumn('a.csv', 'year\n2020\nunknown\n')).toBe('')
    expect(readYearColumn('a.csv', 'year\n99\n')).toBe('')
    expect(readYearColumn('a.csv', 'year\n\n\n')).toBe('')
  })

  it('reads a year column out of a JSON table too', () => {
    expect(readYearColumn('a.json', JSON.stringify([{ year: 2019 }, { year: 2022 }]))).toBe('2019/2022')
  })

  it('reads one out of GeoJSON feature properties', () => {
    const geo = JSON.stringify({ type: 'FeatureCollection', features: [{ properties: { year: '2024' } }] })
    expect(readYearColumn('a.geojson', geo)).toBe('2024')
  })

  it('answers nothing when there is no file to read and nothing in the manifest', async () => {
    expect((await deriveDates(input({}, []))).covers).toBeUndefined()
  })

  it('answers nothing when the file will not download, and never throws', async () => {
    const dates = await deriveDates(input({}, ['sites.csv']), async () => {
      throw new Error('too big')
    })
    expect(dates.covers).toBeUndefined()
  })

  it('answers nothing for a kind the question is not asked of', async () => {
    const dates = await deriveDates({ kind: 'page', meta: { layer: { year: 2024 } }, files: [], slug: 'p' })
    expect(dates.covers).toBeUndefined()
  })
})

describe('published — when the publisher put it out', () => {
  it('is read off the manifest when somebody wrote one', () => {
    expect(datesFromManifest(input({ dates: { published: 'March 2024' } })).published).toBe('2024-03')
  })

  it('is NOT derived from anything, because a release date is not in the bytes', async () => {
    // Every other signal we hold is about the data's period or about us. A
    // filename year was considered and rejected: `sites_2024.csv` is as likely
    // to be the vintage as the release, and nothing can tell which.
    const dates = await deriveDates(input({ layer: { year: 2024 }, lineage: { fetchedAt: '2026-01-01T00:00:00.000Z' } }, ['sites_2024.csv']), async () => 'year\n2024\n')
    expect(dates.published).toBeUndefined()
  })
})

describe('fetched — the only one that is about us', () => {
  it('reads a replicated dataset’s lineage', () => {
    expect(datesFromManifest(input({ lineage: { from: 'x', fetchedAt: '2026-09-29T23:22:13.610Z' } })).fetched).toBe('2026-09-29')
  })

  it('reads a dropped link’s own fetch record', () => {
    expect(datesFromManifest(input({ fetch: { status: 'fetched', at: '2026-10-05T18:22:04.000Z' } })).fetched).toBe('2026-10-05')
  })

  it('ignores a fetch record that did not fetch anything', () => {
    expect(datesFromManifest(input({ fetch: { status: 'failed', at: '2026-10-05T18:22:04.000Z' } })).fetched).toBe('')
    expect(datesFromManifest(input({ fetch: { status: 'queued', at: '2026-10-05T18:22:04.000Z' } })).fetched).toBe('')
  })

  it('reads the NEWEST slice a source’s API was pulled for', () => {
    const meta = {
      source: {
        replication: {
          slices: [{ fetchedAt: '2026-09-15T22:59:49.536Z' }, { fetchedAt: '2026-09-29T23:22:13.610Z' }],
        },
      },
    }
    expect(datesFromManifest({ kind: 'source', meta, files: [], slug: 's' }).fetched).toBe('2026-09-29')
  })

  it('is NEVER the updatedAt, which is when the bytes last moved', () => {
    // The ticket's own point: re-pushing a 2019 file makes `updatedAt` read as
    // 2026. Nothing here looks at it — there is no row stamp in a manifest to
    // look at, and that is by design.
    expect(datesFromManifest(input({ updatedAt: '2026-10-06T00:00:00.000Z', updated_at: '2026-10-06' })).fetched).toBe('')
  })

  it('takes a hand-written fetch date over the record, like every other field', () => {
    const meta = { dates: { fetched: '2024-01-02' }, lineage: { fetchedAt: '2026-09-29T23:22:13.610Z' } }
    expect(datesFromManifest(input(meta)).fetched).toBe('2024-01-02')
  })
})

describe('the block as a whole', () => {
  it('answers all three when all three are there', async () => {
    const meta = {
      dates: { covers: '2019/2023', published: '2024-03' },
      lineage: { fetchedAt: '2026-09-29T23:22:13.610Z' },
    }
    expect(await deriveDates(input(meta))).toEqual({ covers: '2019/2023', published: '2024-03', fetched: '2026-09-29' })
  })

  it('answers an empty block for an entry that says nothing — not a defect, just untagged', async () => {
    expect(await deriveDates(input({}))).toEqual({})
  })

  it('drops a key nobody could answer rather than storing an empty string', async () => {
    const dates = await deriveDates(input({ dates: { covers: 'whenever', published: '2024' } }))
    expect(dates).toEqual({ published: '2024' })
    expect('covers' in dates).toBe(false)
  })
})

/**
 * Field evidence, 2026-10-06. Four federal layers downloaded while this ticket
 * was being built, two of which carry exactly the two dates this field pair
 * distinguishes — independently of us:
 *
 * - **HIFLD transmission lines** (94,619 polylines): `SOURCEDATE` and
 *   `VAL_DATE`, beside `VAL_METHOD`. The publisher separates "when the data is
 *   from" from "when it was checked", and records the mechanism — which is
 *   derive-vs-infer provenance, arrived at by somebody else.
 * - **EPA Superfund NPL boundaries** (2,114 polygons):
 *   `ORIGINAL_CREATION_DATE` and `LAST_CHANGE_DATE`. Published and
 *   last-updated, in those words.
 *
 * Both of the parsing notes that came with it are the subject of this block.
 */
describe('dates as federal data actually ships them', () => {
  it('reads an epoch-millisecond integer, which is what an ArcGIS export gives', () => {
    // The failure mode this exists to stop is the quiet one: a date that is
    // there upstream and reads as absent here.
    expect(normalizeDataDate(1710201600000)).toBe('2024-03-12')
    expect(normalizeDataDate(1_767_225_600_000)).toBe('2026-01-01')
  })

  it('reads epoch SECONDS too, because the same service gives either', () => {
    expect(normalizeDataDate(1710201600)).toBe('2024-03-12')
  })

  it('reads an epoch handed over as text, which is the other export path', () => {
    expect(normalizeDataDate('1710201600000')).toBe('2024-03-12')
  })

  it('still reads a four-digit year as a YEAR and never as an epoch', () => {
    // The ranges are chosen so these can never collide: a year is 1790-2200,
    // an epoch starts at 1e8.
    expect(normalizeDataDate(2024)).toBe('2024')
    expect(normalizeDataDate('2024')).toBe('2024')
  })

  it('treats the null-ish sentinels as absent rather than as a date in 1899', () => {
    // HIFLD writes -999999 for an unknown numeric; ArcGIS writes an unknown
    // DATE as epoch 0 or a spreadsheet zero day. Any of them read as a real
    // value would put "Data from 1899" on a legend.
    expect(normalizeDataDate(-999999)).toBe('')
    expect(normalizeDataDate(0)).toBe('')
    expect(normalizeDataDate('1899-12-30')).toBe('')
    expect(normalizeDataDate('1899-12-31')).toBe('')
    expect(normalizeDataDate('1900-01-01')).toBe('')
    expect(normalizeDataDate('1970-01-01')).toBe('')
    expect(normalizeDataDate(-86400000)).toBe('')
  })

  it('keeps a YEAR that happens to be a sentinel year, because that one is real', () => {
    // A census table covering 1900 is a census table covering 1900. Only the
    // day-precision sentinels are refused.
    expect(normalizeDataDate('1900')).toBe('1900')
    expect(normalizeDataDate('1899/1900')).toBe('1899/1900')
  })
})
