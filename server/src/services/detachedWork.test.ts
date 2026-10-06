import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P7-11: no detached write outlives the test that armed it.
 *
 * The suite's moving single failure was never cross-file module state —
 * vitest's forks pool gives every FILE its own process and its own module
 * registry (`isolate`, on by default), which a probe confirms. What leaked
 * was work in flight: `onReindex` hands its hooks to a registry that is
 * never unsubscribed, two of them launch detached writers, and those writers
 * resolve `libraryBucket`'s `dataDir` and `libraryDb`'s `pool` at USE time.
 * So a sweep armed by one test writes into the next test's mirror, or races
 * the `rmSync` in the afterEach of the test that started it (ENOTEMPTY).
 *
 * Two invariants, one per layer of the fix:
 *  - under the test runner the extraction hook arms nothing unless the suite
 *    asked for it — the only cure for a race inside ONE test, because a
 *    setup file's afterEach runs after the test file's own;
 *  - whatever a suite does arm, `detachedWorkSettled()` joins, so nothing
 *    crosses into the next test.
 */

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { installExtractionHook, readDerived } = await import('./textExtract.js')
const { detachedWorkSettled } = await import('./detachedWork.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: FakeS3
let dataDir: string

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-detached-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  // A .txt document: extractable without a parser, so these cases cost a read
  // rather than a PDF parse.
  fake.seed('library/documents/plan/summary.txt', 'The plan, in one plain paragraph.\n')
  fake.seed(
    'library/documents/plan/meta.json',
    JSON.stringify({ title: 'Strategic plan', category: 'strategy', status: 'published' }),
  )
})

afterEach(async () => {
  await detachedWorkSettled()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('detached work under the test runner (P7-11)', () => {
  it('arms no extraction sweep: a reindex in a test leaves nothing running', async () => {
    installExtractionHook()
    await reindexCatalog()
    // If the hook had launched its sweep, this is what it would have written.
    await detachedWorkSettled()
    expect(await readDerived('plan', 'summary.txt')).toBeNull()
  })

  it('still runs the sweep for a suite that asks for it, and the drain joins it', async () => {
    installExtractionHook({ detachedUnderTest: true })
    await reindexCatalog()
    // Nothing here calls extractPending(): finding the text proves the hook is
    // wired, and finding it right after the drain proves the drain waits.
    await detachedWorkSettled()
    expect(await readDerived('plan', 'summary.txt')).not.toBeNull()
  })

  it('leaves the mirror quiet, so a teardown can remove it without racing a writer', async () => {
    installExtractionHook({ detachedUnderTest: true })
    await reindexCatalog()
    await detachedWorkSettled()
    // No `force`: this throws ENOTEMPTY if a detached writer is still
    // recreating directories underneath the walk — the original symptom.
    expect(() => rmSync(dataDir, { recursive: true })).not.toThrow()
    expect(existsSync(dataDir)).toBe(false)
    dataDir = mkdtempSync(join(tmpdir(), 'blo-detached-test-'))
  })

  it('settles when no module has registered any detached work', async () => {
    await expect(detachedWorkSettled()).resolves.toBeUndefined()
  })
})
