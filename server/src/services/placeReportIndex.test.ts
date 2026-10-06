import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P6-4: the index over the cached place reports.
 *
 * The reports themselves are one JSON blob per place under
 * `library/derived/place/`, each with up to fifty sections of rows in it.
 * Listing "recent analyses" by reading all of them would be tens of megabytes
 * for six lines of text, so a small index is written beside them.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery, writeAudit } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const {
  PLACE_REPORT_INDEX_KEY,
  PLACE_REPORT_INDEX_MAX,
  listPlaceReports,
  readPlaceReportIndex,
  rebuildPlaceReportIndex,
  recordPlaceReport,
  placeReportIndexSettled,
} = await import('./placeReportIndex.js')

type StoredPlaceReport = import('./placeReportIndex.js').StoredPlaceReport

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const PREFIX = 'library/derived/place/'

let fake: FakeS3
let dataDir: string

/** A stored report as the index reads it: a label, a time, and statuses. */
function report(label: string, generatedAt: string, statuses: string[] = ['found', 'none']): StoredPlaceReport {
  return { place: { label }, generatedAt, sections: statuses.map(status => ({ status })) }
}

function seedReport(placeKey: string, doc: StoredPlaceReport): void {
  fake.seed(`${PREFIX}${placeKey}.json`, JSON.stringify(doc))
}

/** The rebuild's reader: the bucket object for one place key, or null. */
async function read(placeKey: string): Promise<StoredPlaceReport | null> {
  const raw = fake.objects.get(`${PREFIX}${placeKey}.json`)
  return raw ? (JSON.parse(raw.toString('utf8')) as StoredPlaceReport) : null
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-place-index-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await placeReportIndexSettled()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('recording a report (P6-4)', () => {
  it('writes one small object beside the reports, not inside them', async () => {
    await recordPlaceReport({ placeKey: 'g13121', label: 'Fulton County, GA', by: 'maria', at: '2026-09-20T10:00:00Z', found: 4, sources: 12 })
    expect([...fake.objects.keys()]).toEqual([PLACE_REPORT_INDEX_KEY])
    expect(PLACE_REPORT_INDEX_KEY.startsWith(PREFIX)).toBe(false)
    expect(await readPlaceReportIndex()).toEqual([
      { placeKey: 'g13121', label: 'Fulton County, GA', by: 'maria', at: '2026-09-20T10:00:00Z', found: 4, sources: 12 },
    ])
  })

  it('puts the newest first and keeps one entry per place', async () => {
    await recordPlaceReport({ placeKey: 'g13121', label: 'Fulton County, GA', by: 'maria', at: '2026-09-20T10:00:00Z', found: 4, sources: 12 })
    await recordPlaceReport({ placeKey: 'p33.7490_-84.3880_r5', label: '55 Trinity Ave SW', by: 'nick', at: '2026-09-21T10:00:00Z', found: 6, sources: 12 })
    await recordPlaceReport({ placeKey: 'g13121', label: 'Fulton County, GA', by: 'nick', at: '2026-09-22T10:00:00Z', found: 5, sources: 12 })
    const entries = await readPlaceReportIndex()
    expect(entries.map(e => [e.placeKey, e.by, e.found])).toEqual([
      ['g13121', 'nick', 5],
      ['p33.7490_-84.3880_r5', 'nick', 6],
    ])
  })

  it('keeps the index bounded', async () => {
    for (let i = 0; i <= PLACE_REPORT_INDEX_MAX; i += 1) {
      await recordPlaceReport({
        placeKey: `g${String(10000 + i)}`,
        label: `County ${i}`,
        by: 'maria',
        at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        found: 1,
        sources: 1,
      })
    }
    const entries = await readPlaceReportIndex()
    expect(entries).toHaveLength(PLACE_REPORT_INDEX_MAX)
    // The oldest fell off the end, not the newest.
    expect(entries[0].label).toBe(`County ${PLACE_REPORT_INDEX_MAX}`)
    expect(entries.map(e => e.label)).not.toContain('County 0')
  })

  it('never throws when the bucket is unhappy — a lost index entry must not lose a report', async () => {
    fake.failNext = true
    await expect(recordPlaceReport({ placeKey: 'g13121', label: 'Fulton County, GA', by: 'maria', at: '2026-09-20T10:00:00Z', found: 1, sources: 2 })).resolves.toBeUndefined()
  })
})

describe('listing (P6-4)', () => {
  it('answers with nothing at all when no index has been written', async () => {
    expect(await listPlaceReports()).toEqual([])
  })

  it('returns the newest N without reading a single report', async () => {
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z'))
    for (const [i, key] of ['g13121', 'g13089', 'g01073'].entries()) {
      await recordPlaceReport({ placeKey: key, label: `Place ${i}`, by: 'maria', at: `2026-09-2${i}T10:00:00Z`, found: i, sources: 3 })
    }
    fake.calls.length = 0
    const rows = await listPlaceReports(2)
    expect(rows.map(r => r.label)).toEqual(['Place 2', 'Place 1'])
    // One GetObject, for the index — no report was opened.
    expect(fake.calls.filter(c => c.startsWith('GetObjectCommand'))).toEqual([`GetObjectCommand:${PLACE_REPORT_INDEX_KEY}`])
  })
})

describe('rebuilding at reindex (P6-4)', () => {
  it('walks the reports we still hold and writes the index over them, newest first', async () => {
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z', ['found', 'found', 'none']))
    seedReport('p33.7490_-84.3880_r5', report('55 Trinity Ave SW, Atlanta', '2026-09-22T10:00:00Z', ['none']))
    const entries = await rebuildPlaceReportIndex(PREFIX, read)
    expect(entries.map(e => [e.placeKey, e.label, e.found, e.sources])).toEqual([
      ['p33.7490_-84.3880_r5', '55 Trinity Ave SW, Atlanta', 0, 1],
      ['g13121', 'Fulton County, GA', 2, 3],
    ])
    expect(await readPlaceReportIndex()).toEqual(entries)
  })

  it('recovers who ran each report from the audit log', async () => {
    await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('maria', 'x', 'internal')`)
    await writeAudit({ actor: 'maria', action: 'place.report', target: 'g13121', detail: {} })
    await writeAudit({ actor: 'nick', action: 'place.report', target: 'p33.7490_-84.3880_r5', detail: {} })
    // A later run of the same place is the one the list should name.
    await writeAudit({ actor: 'nick', action: 'place.report', target: 'g13121', detail: {} })
    // Another action against the same target must not be mistaken for a run.
    await writeAudit({ actor: 'someone-else', action: 'catalog.reindex', target: 'g13089', detail: {} })
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z'))
    seedReport('g13089', report('DeKalb County, GA', '2026-09-19T10:00:00Z'))
    const entries = await rebuildPlaceReportIndex(PREFIX, read)
    const byKey = Object.fromEntries(entries.map(e => [e.placeKey, e.by]))
    expect(byKey['g13121']).toBe('nick')
    expect(byKey['g13089']).toBe('')
  })

  it('drops an entry whose report has gone, and skips one that will not read', async () => {
    await recordPlaceReport({ placeKey: 'g99999', label: 'Gone', by: 'maria', at: '2026-09-01T10:00:00Z', found: 1, sources: 1 })
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z'))
    fake.seed(`${PREFIX}broken.json`, 'not json at all')
    const entries = await rebuildPlaceReportIndex(PREFIX, async key => {
      try {
        return await read(key)
      } catch {
        return null
      }
    })
    expect(entries.map(e => e.placeKey)).toEqual(['g13121'])
  })

  it('ignores anything under the prefix that is not a report document', async () => {
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z'))
    fake.seed(`${PREFIX}notes.txt`, 'scratch')
    const entries = await rebuildPlaceReportIndex(PREFIX, read)
    expect(entries.map(e => e.placeKey)).toEqual(['g13121'])
  })

  /**
   * P6-27: `/analysis` attributed nine of eleven recent analyses to "someone".
   * The recovery below works and the join key is right — but the walk was
   * writing `actors.get(placeKey) ?? ''` over the whole object, so a rebuild
   * that could not reach a matching audit row ERASED the name the live write
   * had already stored. In dev that is every boot: the audit store is pg-mem,
   * and the restart that empties it is the one that triggers the rebuild.
   */
  it('keeps the name the live write stored when the audit log cannot account for it', async () => {
    await recordPlaceReport({
      placeKey: 'g13121',
      label: 'Fulton County, GA',
      by: 'dev-admin',
      at: '2026-09-20T10:00:00Z',
      // Deliberately wrong numbers: only "who" survives from the old entry.
      found: 9,
      sources: 9,
    })
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z'))
    // No audit rows at all — a wiped dev store, or a report run through MCP,
    // which writes its own action against its own target.
    expect((await libraryQuery(`SELECT count(*)::int AS n FROM library_audit`)).rows[0].n).toBe(0)

    const once = await rebuildPlaceReportIndex(PREFIX, read)
    expect(once[0].by).toBe('dev-admin')
    // And again: the loop that de-attributed the real index ran on every save.
    const twice = await rebuildPlaceReportIndex(PREFIX, read)
    expect(twice[0].by).toBe('dev-admin')
    // Everything else still comes from the report file, not from the old entry.
    expect([twice[0].label, twice[0].found, twice[0].sources]).toEqual(['Fulton County, GA', 1, 2])
  })

  it('lets the audit log correct a stored name, and leaves a blank blank', async () => {
    await libraryQuery(`INSERT INTO library_users (username, password_hash, role) VALUES ('nick', 'x', 'internal')`)
    await writeAudit({ actor: 'nick', action: 'place.report', target: 'g13121', detail: {} })
    await recordPlaceReport({ placeKey: 'g13121', label: 'Fulton County, GA', by: 'maria', at: '2026-09-20T10:00:00Z', found: 1, sources: 1 })
    await recordPlaceReport({ placeKey: 'g13089', label: 'DeKalb County, GA', by: '', at: '2026-09-19T10:00:00Z', found: 1, sources: 1 })
    seedReport('g13121', report('Fulton County, GA', '2026-09-20T10:00:00Z'))
    seedReport('g13089', report('DeKalb County, GA', '2026-09-19T10:00:00Z'))
    const byKey = Object.fromEntries((await rebuildPlaceReportIndex(PREFIX, read)).map(e => [e.placeKey, e.by]))
    // The audit row knows the newest run; the stored entry is only the fallback.
    expect(byKey['g13121']).toBe('nick')
    // Nothing recorded it anywhere, so the list says the date alone (P6-27).
    expect(byKey['g13089']).toBe('')
  })
})
