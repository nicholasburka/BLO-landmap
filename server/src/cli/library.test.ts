import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'

process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('../services/libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('../services/libraryBucket.js')
const { getCatalogEntry } = await import('../services/libraryCatalog.js')
const { pullLibrary, pushLibrary, statusLibrary } = await import('./library.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')

/**
 * The pull/push CLI (P5-13). Each test models one or more "CLI runs": a run
 * always starts with a FRESH temp mirror (exactly what main() does), so the
 * bucket service's mirror-first getFile can never serve stale bytes.
 */

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: InstanceType<typeof FakeS3>
let localDir: string
const tempDirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Start a fresh "CLI run": re-init the bucket service with a new mirror. */
async function freshRun(): Promise<void> {
  await closeLibraryBucket()
  const mirror = await tempDir('blo-cli-mirror-')
  expect(
    await initLibraryBucket({ client: fake as never, bucket: 'test-bucket', dataDir: mirror }),
  ).toBe(true)
}

async function writeLocal(relKey: string, body: string): Promise<string> {
  const path = join(localDir, relKey)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
  return path
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  localDir = await tempDir('blo-cli-local-')
  await freshRun()
})

afterEach(async () => {
  await closeLibraryDb()
  await closeLibraryBucket()
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

describe('pullLibrary', () => {
  it('downloads the whole library tree into the local folder', async () => {
    fake.seed('library/incoming/u1/data.csv', 'a,b\n1,2\n')
    fake.seed('library/incoming/u1/meta.json', '{"title":"Raw drop"}')
    fake.seed('library/datasets/tn-heirs/data.csv', 'fips,share\n47001,0.4\n')

    const result = await pullLibrary(localDir)

    expect(result.downloaded.sort()).toEqual([
      'library/datasets/tn-heirs/data.csv',
      'library/incoming/u1/data.csv',
      'library/incoming/u1/meta.json',
    ])
    expect(await readFile(join(localDir, 'library/incoming/u1/data.csv'), 'utf8')).toBe('a,b\n1,2\n')
    expect(await readFile(join(localDir, 'library/datasets/tn-heirs/data.csv'), 'utf8')).toBe(
      'fips,share\n47001,0.4\n',
    )
  })

  it('is idempotent: a second pull downloads nothing', async () => {
    fake.seed('library/datasets/d1/data.csv', 'x\n')
    fake.seed('library/datasets/d1/meta.json', '{"title":"D1"}')
    await pullLibrary(localDir)

    await freshRun()
    const again = await pullLibrary(localDir)
    expect(again.downloaded).toEqual([])
    expect(again.skipped).toBe(2)
  })

  it('re-downloads size-changed files AND same-size meta.json edits', async () => {
    fake.seed('library/datasets/d1/data.csv', 'v1\n')
    fake.seed('library/datasets/d1/meta.json', '{"status":"aa"}')
    await pullLibrary(localDir)

    // Remote moves on: data grows, meta.json changes at the SAME byte length.
    fake.seed('library/datasets/d1/data.csv', 'v2 longer\n')
    fake.seed('library/datasets/d1/meta.json', '{"status":"bb"}')

    await freshRun()
    const result = await pullLibrary(localDir)
    expect(result.downloaded.sort()).toEqual([
      'library/datasets/d1/data.csv',
      'library/datasets/d1/meta.json',
    ])
    expect(await readFile(join(localDir, 'library/datasets/d1/meta.json'), 'utf8')).toBe(
      '{"status":"bb"}',
    )
  })

  it('reports local strays without deleting them unless prune is set', async () => {
    fake.seed('library/datasets/d1/data.csv', 'x\n')
    const strayPath = await writeLocal('library/datasets/gone/data.csv', 'old\n')

    const result = await pullLibrary(localDir)
    expect(result.localStrays).toEqual(['library/datasets/gone/data.csv'])
    expect(result.pruned).toEqual([])
    await expect(stat(strayPath)).resolves.toBeTruthy() // still there

    await freshRun()
    const pruned = await pullLibrary(localDir, { prune: true })
    expect(pruned.pruned).toEqual(['library/datasets/gone/data.csv'])
    await expect(stat(strayPath)).rejects.toThrow()
  })
})

describe('pushLibrary', () => {
  it('uploads new local files and leaves the local copies in place', async () => {
    const dataPath = await writeLocal('library/datasets/tn-heirs/data.csv', 'fips,share\n47001,0.4\n')
    await writeLocal(
      'library/datasets/tn-heirs/meta.json',
      JSON.stringify({ title: 'TN heirs', status: 'published' }),
    )

    const result = await pushLibrary(localDir)
    expect(result.uploaded.sort()).toEqual([
      'library/datasets/tn-heirs/data.csv',
      'library/datasets/tn-heirs/meta.json',
    ])
    expect(fake.objects.get('library/datasets/tn-heirs/data.csv')?.toString()).toBe(
      'fips,share\n47001,0.4\n',
    )
    // keepSource: push must never move/delete the dev's working files.
    await expect(stat(dataPath)).resolves.toBeTruthy()
  })

  it('is idempotent, but pushes same-size meta.json edits', async () => {
    await writeLocal('library/datasets/d1/data.csv', 'x\n')
    await writeLocal('library/datasets/d1/meta.json', '{"status":"aa"}')
    await pushLibrary(localDir)

    await freshRun()
    const again = await pushLibrary(localDir)
    expect(again.uploaded).toEqual([])
    expect(again.skipped).toBe(2)

    // Same-length status flip still syncs (content compare on manifests).
    await writeLocal('library/datasets/d1/meta.json', '{"status":"bb"}')
    await freshRun()
    const third = await pushLibrary(localDir)
    expect(third.uploaded).toEqual(['library/datasets/d1/meta.json'])
    expect(fake.objects.get('library/datasets/d1/meta.json')?.toString()).toBe('{"status":"bb"}')
  })

  it('skips unsafe filenames with a warning instead of uploading them', async () => {
    await writeLocal('library/datasets/d1/bad name.csv', 'x\n')
    await writeLocal('library/datasets/d1/good.csv', 'x\n')

    const result = await pushLibrary(localDir)
    expect(result.uploaded).toEqual(['library/datasets/d1/good.csv'])
    expect(result.warnings.some(w => /bad name\.csv/.test(w))).toBe(true)
    expect(fake.objects.has('library/datasets/d1/bad name.csv')).toBe(false)
  })

  it('warns on malformed meta.json and unknown statuses but still uploads (files are the truth)', async () => {
    await writeLocal('library/datasets/d1/meta.json', 'not json {')
    await writeLocal('library/datasets/d2/meta.json', '{"status":"totally-done"}')

    const result = await pushLibrary(localDir)
    expect(result.uploaded.sort()).toEqual([
      'library/datasets/d1/meta.json',
      'library/datasets/d2/meta.json',
    ])
    expect(result.warnings.some(w => /d1\/meta\.json/.test(w) && /json/i.test(w))).toBe(true)
    expect(
      result.warnings.some(w => /totally-done/.test(w) && /published/.test(w)),
    ).toBe(true)
  })

  it('reindexes after upload: the published dataset (with lineage) is in the catalog, audited', async () => {
    await writeLocal('library/datasets/tn-heirs/data.csv', 'fips,share\n47001,0.4\n')
    await writeLocal(
      'library/datasets/tn-heirs/meta.json',
      JSON.stringify({
        title: 'TN heirs property',
        category: 'land',
        status: 'published',
        tags: ['tennessee'],
        lineage: { from: 'u1', cleaning: 'normalized FIPS, dropped empty rows' },
      }),
    )

    const result = await pushLibrary(localDir)
    expect(result.indexed).toBe(1)

    const entry = await getCatalogEntry('tn-heirs')
    expect(entry?.kind).toBe('dataset')
    expect(entry?.status).toBe('published')
    expect(entry?.title).toBe('TN heirs property')
    expect((entry?.meta as any)?.lineage?.cleaning).toMatch(/normalized FIPS/)

    const audit = (await libraryQuery(`SELECT actor, action FROM library_audit`)).rows
    expect(audit).toEqual([{ actor: 'cli', action: 'library.push' }])
  })

  it('reports remote strays without deleting unless the delete flag is set', async () => {
    fake.seed('library/datasets/old/data.csv', 'x\n')
    await writeLocal('library/datasets/new/data.csv', 'y\n')

    const result = await pushLibrary(localDir)
    expect(result.remoteStrays).toEqual(['library/datasets/old/data.csv'])
    expect(result.deleted).toEqual([])
    expect(fake.objects.has('library/datasets/old/data.csv')).toBe(true)

    await freshRun()
    const destructive = await pushLibrary(localDir, { delete: true })
    expect(destructive.deleted).toEqual(['library/datasets/old/data.csv'])
    expect(fake.objects.has('library/datasets/old/data.csv')).toBe(false)
  })

  // Uploads land in library/incoming/ between a teammate's drop and the
  // dev's next pull, so a --delete run from a stale folder would silently
  // destroy work nobody has seen yet.
  it('keeps incoming/ strays on --delete unless --delete-incoming is given too', async () => {
    fake.seed('library/incoming/fresh-drop/data.csv', 'x\n')
    fake.seed('library/incoming/fresh-drop/meta.json', '{"title":"drop"}')
    fake.seed('library/datasets/old/data.csv', 'x\n')
    await writeLocal('library/datasets/new/data.csv', 'y\n')

    const guarded = await pushLibrary(localDir, { delete: true })
    expect(guarded.deleted).toEqual(['library/datasets/old/data.csv'])
    expect(guarded.skippedIncoming).toEqual([
      'library/incoming/fresh-drop/data.csv',
      'library/incoming/fresh-drop/meta.json',
    ])
    expect(guarded.warnings.some(w => /--delete-incoming/.test(w))).toBe(true)
    expect(fake.objects.has('library/incoming/fresh-drop/data.csv')).toBe(true)

    await freshRun()
    const deliberate = await pushLibrary(localDir, { delete: true, deleteIncoming: true })
    expect(deliberate.deleted).toEqual([
      'library/incoming/fresh-drop/data.csv',
      'library/incoming/fresh-drop/meta.json',
    ])
    expect(deliberate.skippedIncoming).toEqual([])
    expect(fake.objects.has('library/incoming/fresh-drop/data.csv')).toBe(false)
  })

  // Editor droppings and the geocoder's resume cache are working files of the
  // local folder, not library content — pushing them publishes noise (and, in
  // the cache's case, a large file nobody asked for).
  it('ignores dotfiles and .geocode-cache.json in the local tree', async () => {
    await writeLocal('library/datasets/d1/data.csv', 'x\n')
    await writeLocal('library/datasets/d1/.DS_Store', 'junk')
    await writeLocal('library/datasets/d1/.hidden.csv', 'junk')
    await writeLocal('library/datasets/d1/addresses.geocode-cache.json', '{}')

    const result = await pushLibrary(localDir)
    expect(result.uploaded).toEqual(['library/datasets/d1/data.csv'])
    expect(result.warnings).toEqual([])
    expect([...fake.objects.keys()]).toEqual(['library/datasets/d1/data.csv'])
  })

  it('warns "pushed but not reindexed" when the catalog DB is unavailable', async () => {
    await closeLibraryDb()
    await writeLocal('library/datasets/d1/data.csv', 'x\n')

    const result = await pushLibrary(localDir)
    expect(result.uploaded).toEqual(['library/datasets/d1/data.csv'])
    expect(result.indexed).toBeNull()
    expect(result.warnings.some(w => /not reindexed/i.test(w))).toBe(true)
  })

  it('errors clearly when there is no local library/ tree to push', async () => {
    await expect(pushLibrary(localDir)).rejects.toThrow(/nothing to push/i)
  })
})

describe('statusLibrary', () => {
  it('diffs both directions without writing anything', async () => {
    fake.seed('library/datasets/both/data.csv', 'same\n')
    fake.seed('library/datasets/both/other.csv', 'remote version\n')
    fake.seed('library/datasets/remote-only/data.csv', 'x\n')
    await writeLocal('library/datasets/both/data.csv', 'same\n')
    await writeLocal('library/datasets/both/other.csv', 'local!\n') // size differs
    await writeLocal('library/datasets/local-only/data.csv', 'y\n')

    const callsBefore = fake.calls.length
    const result = await statusLibrary(localDir)
    expect(result.changed).toEqual(['library/datasets/both/other.csv'])
    expect(result.remoteOnly).toEqual(['library/datasets/remote-only/data.csv'])
    expect(result.localOnly).toEqual(['library/datasets/local-only/data.csv'])

    // Read-only: nothing was uploaded, deleted, or downloaded.
    const newCalls = fake.calls.slice(callsBefore)
    expect(newCalls.every(c => c.startsWith('ListObjectsV2Command'))).toBe(true)
    expect(fake.objects.get('library/datasets/both/other.csv')?.toString()).toBe('remote version\n')
  })
})

describe('derived text is the server\'s, not the dev folder\'s (P5-46)', () => {
  const DERIVED = 'library/derived/plan/Five_Year_Plan.pdf.txt.json'

  it('pull never downloads library/derived/ and never calls it a stray', async () => {
    fake.seed('library/documents/plan/Five_Year_Plan.pdf', '%PDF-1.4 pretend\n')
    fake.seed('library/documents/plan/meta.json', '{"title":"Plan"}')
    fake.seed(DERIVED, JSON.stringify({ pages: [{ n: 1, text: 'pretend' }], chars: 7 }))

    const result = await pullLibrary(localDir)
    expect(result.downloaded).toEqual([
      'library/documents/plan/Five_Year_Plan.pdf',
      'library/documents/plan/meta.json',
    ])
    await expect(stat(join(localDir, DERIVED))).rejects.toThrow()
    expect(result.localStrays).toEqual([])
  })

  it('status ignores derived objects instead of reporting them as remote-only', async () => {
    fake.seed('library/documents/plan/meta.json', '{"title":"Plan"}')
    fake.seed(DERIVED, '{"pages":[]}')
    await writeLocal('library/documents/plan/meta.json', '{"title":"Plan"}')

    const result = await statusLibrary(localDir)
    expect(result.remoteOnly).toEqual([])
    expect(result.changed).toEqual([])
    expect(result.localOnly).toEqual([])
  })

  it('push --delete leaves derived objects alone — they are not strays', async () => {
    fake.seed(DERIVED, '{"pages":[]}')
    await writeLocal('library/documents/plan/meta.json', '{"title":"Plan"}')
    await freshRun()

    const result = await pushLibrary(localDir, { delete: true })
    expect(result.remoteStrays).toEqual([])
    expect(result.deleted).toEqual([])
    expect(fake.objects.has(DERIVED)).toBe(true)
  })
})
