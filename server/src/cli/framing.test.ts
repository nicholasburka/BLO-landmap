import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * P11-3: folding a saved view's framing into the set it presents.
 *
 * Run once against prod, so the cases that matter are the ones that must not
 * happen twice and the ones that must not guess.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')
const { reindexCatalog } = await import('../services/libraryCatalog.js')
const { createWorkingSet, getWorkingSet } = await import('../services/libraryWorkingSets.js')
const { foldViewsIntoSets } = await import('./framing.js')


function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: FakeS3
let dataDir: string

const STATE = {
  layers: [{ layerId: 'combined_scores_v2', weight: 4, direction: 'higher_better' }],
  filters: [],
  limit: null,
  regionStates: ['MS'],
  prompt: 'the question that made this view',
  viewport: { center: [-90, 33], zoom: 6 },
}

function writeView(slug: string, workingSet: string, over: Record<string, unknown> = {}): void {
  fake.seed(
    `library/views/${slug}.json`,
    JSON.stringify({
      name: slug,
      type: 'map',
      workingSet,
      state: STATE,
      results: [],
      savedBy: 'maria',
      savedById: 1,
      savedAt: '2026-10-01T00:00:00.000Z',
      ...over,
    }),
  )
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'framing-'))
  process.env.LIBRARY_DATA_DIR = dataDir
  fake = new FakeS3()
  await initLibraryDb(memPool())
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryDb()
  await closeLibraryBucket()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('folding a view into its set (P11-3)', () => {
  it('copies the framing across and leaves the view alone', async () => {
    const made = await createWorkingSet({ name: 'Memphis', savedBy: 'maria', savedById: 1 })
    writeView('memphis-map', made.slug!)
    await reindexCatalog()

    const dry = await foldViewsIntoSets(false)
    expect(dry.folded).toBe(1)
    // A dry run writes nothing — that is the whole point of running it first.
    expect((await getWorkingSet(made.slug!))?.framing).toBeUndefined()

    const done = await foldViewsIntoSets(true)
    expect(done.folded).toBe(1)
    const set = await getWorkingSet(made.slug!)
    expect(set?.framing?.layers).toEqual([
      { layerId: 'combined_scores_v2', weight: 4, direction: 'higher_better' },
    ])
    expect(set?.framing?.viewport).toEqual({ center: [-90, 33], zoom: 6 })
    // A set is a resting state, not the question that produced a view.
    expect(set?.framing?.prompt).toBeUndefined()
  })

  it('is re-runnable: a set already framed is left alone', async () => {
    const made = await createWorkingSet({ name: 'Memphis', savedBy: 'maria', savedById: 1 })
    writeView('memphis-map', made.slug!)
    await reindexCatalog()
    await foldViewsIntoSets(true)

    const again = await foldViewsIntoSets(true)
    expect(again.folded).toBe(0)
    expect(again.skipped).toBe(1)
    expect(again.lines.join(' ')).toContain('already framed')
  })

  it('refuses to guess when a set has two map views', async () => {
    const made = await createWorkingSet({ name: 'Memphis', savedBy: 'maria', savedById: 1 })
    writeView('memphis-one', made.slug!)
    writeView('memphis-two', made.slug!)
    await reindexCatalog()

    const got = await foldViewsIntoSets(true)
    expect(got.ambiguous).toBe(1)
    expect(got.folded).toBe(0)
    expect((await getWorkingSet(made.slug!))?.framing).toBeUndefined()
    expect(got.lines.join(' ')).toContain('pick one by hand')
  })

  it('says so when a set has no view to fold', async () => {
    await createWorkingSet({ name: 'Bare', savedBy: 'maria', savedById: 1 })
    await reindexCatalog()
    const got = await foldViewsIntoSets(true)
    expect(got.folded).toBe(0)
    expect(got.lines.join(' ')).toContain('no map view to fold')
  })
})
