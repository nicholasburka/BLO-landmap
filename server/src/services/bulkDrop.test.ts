import { describe, it, expect, afterEach } from 'vitest'
import {
  BULK_MAX_DROP_BYTES,
  BULK_MAX_FILES,
  BULK_MAX_FILE_BYTES,
  bulkDropStatus,
  bulkMaxDropBytes,
  bulkMaxFileBytes,
  bulkMaxFiles,
  createBulkDrop,
  getBulkDrop,
  resetBulkDrops,
  shapeOfFile,
  titleFromFilename,
} from './bulkDrop.js'

/**
 * P6-8: the parts of a bulk drop that need neither a bucket nor a model —
 * the caps, the deterministic floor, and the in-process drop registry the New
 * page polls. The state machine and the storing itself are exercised
 * end-to-end in `routes/libraryBulk.test.ts`, against the real queue.
 */

afterEach(() => {
  resetBulkDrops()
  delete process.env.LIBRARY_BULK_MAX_FILES
  delete process.env.LIBRARY_BULK_MAX_FILE_BYTES
  delete process.env.LIBRARY_BULK_MAX_DROP_BYTES
})

describe('the caps', () => {
  it('are the spec’s: 50 files, 100 MB each, 500 MB per drop', () => {
    expect(BULK_MAX_FILES).toBe(50)
    expect(BULK_MAX_FILE_BYTES).toBe(100 * 1024 * 1024)
    expect(BULK_MAX_DROP_BYTES).toBe(500 * 1024 * 1024)
    expect(bulkMaxFiles()).toBe(BULK_MAX_FILES)
    expect(bulkMaxFileBytes()).toBe(BULK_MAX_FILE_BYTES)
    expect(bulkMaxDropBytes()).toBe(BULK_MAX_DROP_BYTES)
  })

  it('can be lowered for a test box', () => {
    process.env.LIBRARY_BULK_MAX_FILES = '2'
    process.env.LIBRARY_BULK_MAX_FILE_BYTES = '1024'
    process.env.LIBRARY_BULK_MAX_DROP_BYTES = '4096'
    expect(bulkMaxFiles()).toBe(2)
    expect(bulkMaxFileBytes()).toBe(1024)
    expect(bulkMaxDropBytes()).toBe(4096)
  })

  it('ignores nonsense and keeps the default', () => {
    process.env.LIBRARY_BULK_MAX_FILES = 'lots'
    expect(bulkMaxFiles()).toBe(BULK_MAX_FILES)
  })
})

describe('the deterministic floor', () => {
  it('turns a filename into a title', () => {
    expect(titleFromFilename('2024_land-loss REPORT.pdf')).toBe('2024 land-loss REPORT')
    expect(titleFromFilename('reports/2024/plan.docx')).toBe('plan')
    expect(titleFromFilename('README')).toBe('README')
    expect(titleFromFilename('.hidden')).toBe('.hidden')
  })

  it('reads a table’s shape off its own header row', async () => {
    const head = (text: string) => async () => text
    expect(await shapeOfFile('counties.csv', head('GEOID,share\n47157,0.3'))).toBe('statistics')
    expect(await shapeOfFile('sites.csv', head('name,lat,lng\nA,33.7,-84.4'))).toBe('points')
    expect(await shapeOfFile('people.csv', head('name,owner\nA,B'))).toBe('records')
    expect(await shapeOfFile('parcels.geojson', head('{"features":[{"geometry":{"type":"Polygon"}}]}'))).toBe('areas')
  })

  it('says nothing about a document that has no columns', async () => {
    // Guessing "records" for a PDF would file a report under "Records without
    // a location" in the datasets browser, which is worse than not knowing.
    expect(await shapeOfFile('report.pdf', async () => 'not a table')).toBeNull()
    expect(await shapeOfFile('meta.json', async () => '{}')).toBeNull()
  })

  it('leaves the shape unknown when the file cannot be read', async () => {
    expect(
      await shapeOfFile('counties.csv', async () => {
        throw new Error('gone')
      }),
    ).toBeNull()
  })
})

describe('the drop registry', () => {
  it('hands back the drop it made, and nothing for an id it never made', () => {
    const drop = createBulkDrop(7, 'maria')
    expect(getBulkDrop(drop.id)).toBe(drop)
    expect(getBulkDrop('not-a-drop')).toBeNull()
    expect(drop.userId).toBe(7)
    expect(drop.actor).toBe('maria')
  })

  it('reports an empty drop as finished and free', () => {
    const status = bulkDropStatus(createBulkDrop(null, 'dev'))
    expect(status.running).toBe(false)
    expect(status.rows).toEqual([])
    expect(status.spentCents).toBe(0)
    expect(status.counts).toEqual({ queued: 0, reading: 0, suggested: 0, failed: 0 })
  })

  it('forgets everything on reset, because tests share one process', () => {
    const drop = createBulkDrop(1, 'dev')
    resetBulkDrops()
    expect(getBulkDrop(drop.id)).toBeNull()
  })
})
