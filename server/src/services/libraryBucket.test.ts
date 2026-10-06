import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { S3Client } from '@aws-sdk/client-s3'
import {
  initLibraryBucket,
  isBucketEnabled,
  closeLibraryBucket,
  putFile,
  getFile,
  deleteFile,
  listFiles,
  syncMirror,
  isSafeKey,
} from './libraryBucket.js'

import { FakeS3 } from '../testutils/fakeS3.js'

let fake: FakeS3
let dataDir: string

beforeEach(async () => {
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-library-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  rmSync(dataDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('init / enablement', () => {
  it('is enabled with an injected client', () => {
    expect(isBucketEnabled()).toBe(true)
  })

  it('is disabled (with a warning, not a crash) when env vars are absent', async () => {
    await closeLibraryBucket()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    delete process.env.LIBRARY_BUCKET_ENDPOINT
    delete process.env.LIBRARY_BUCKET_NAME
    const ok = await initLibraryBucket()
    expect(ok).toBe(false)
    expect(isBucketEnabled()).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('operations throw when not initialized (guard misuse loudly)', async () => {
    await closeLibraryBucket()
    await expect(putFile('library/datasets/x/data.csv', 'x')).rejects.toThrow(/not initialized/)
  })
})

describe('key safety', () => {
  it.each([
    '../etc/passwd',
    'library/../../etc/passwd',
    '/library/abs.txt',
    'datasets/outside-tree.csv',
    'library/bad\0null.txt',
  ])('rejects unsafe key %s', async key => {
    await expect(putFile(key, 'x')).rejects.toThrow(/invalid library key/i)
  })

  // Keys become mirror FILE PATHS, so every segment has to survive the
  // filesystem: a 300-character name blows past NAME_MAX on ext4/APFS and
  // an empty one ("//", or a trailing slash) is a directory, not a file.
  it('rejects keys and path segments that are too long, and empty segments', () => {
    expect(isSafeKey(`library/datasets/${'a'.repeat(200)}.csv`)).toBe(false)
    expect(isSafeKey(`library/${'a'.repeat(300)}/x.csv`)).toBe(false)
    expect(isSafeKey(`library/${'a/'.repeat(600)}x.csv`)).toBe(false) // > 1024 total
    expect(isSafeKey('library//double.csv')).toBe(false)
    expect(isSafeKey('library/trailing/')).toBe(false)
    expect(isSafeKey(`library/datasets/${'a'.repeat(180)}.csv`)).toBe(true)
  })
})

describe('putFile (bucket-first, then mirror)', () => {
  it('writes the bucket and the local mirror', async () => {
    await putFile('library/datasets/tn/data.csv', 'a,b\n1,2\n', 'text/csv')
    expect(fake.objects.get('library/datasets/tn/data.csv')?.toString()).toBe('a,b\n1,2\n')
    expect(readFileSync(join(dataDir, 'library/datasets/tn/data.csv'), 'utf8')).toBe('a,b\n1,2\n')
  })

  it('does not touch the mirror when the bucket write fails', async () => {
    fake.failNext = true
    await expect(putFile('library/datasets/tn/data.csv', 'x')).rejects.toThrow('bucket down')
    expect(existsSync(join(dataDir, 'library/datasets/tn/data.csv'))).toBe(false)
  })
})

describe('getFile (mirror cache with bucket fallback)', () => {
  it('serves from the mirror without a bucket round-trip', async () => {
    await putFile('library/documents/note/readme.md', 'hello')
    fake.calls = []
    const buf = await getFile('library/documents/note/readme.md')
    expect(buf.toString()).toBe('hello')
    expect(fake.calls).toEqual([]) // no bucket call
  })

  it('on mirror miss, fetches from the bucket and caches locally', async () => {
    fake.objects.set('library/wiki/home.md', Buffer.from('# home'))
    const buf = await getFile('library/wiki/home.md')
    expect(buf.toString()).toBe('# home')
    expect(readFileSync(join(dataDir, 'library/wiki/home.md'), 'utf8')).toBe('# home')
  })

  it('throws when the key exists nowhere', async () => {
    await expect(getFile('library/wiki/missing.md')).rejects.toThrow()
  })

  it('{ fresh: true } bypasses a stale mirror and repairs it (P5-13)', async () => {
    // A CLI push (or rclone) updates the bucket behind the running server's
    // back — the mirror still holds the old bytes.
    await putFile('library/datasets/x/meta.json', '{"status":"needs-review"}')
    fake.objects.set('library/datasets/x/meta.json', Buffer.from('{"status":"published"}'))

    // Default read serves the stale mirror copy (that's the cache working).
    expect((await getFile('library/datasets/x/meta.json')).toString()).toContain('needs-review')

    // Fresh read must come from the bucket AND repair the mirror.
    const buf = await getFile('library/datasets/x/meta.json', { fresh: true })
    expect(buf.toString()).toBe('{"status":"published"}')
    expect(readFileSync(join(dataDir, 'library/datasets/x/meta.json'), 'utf8')).toBe(
      '{"status":"published"}',
    )
  })
})

describe('deleteFile', () => {
  it('removes from bucket and mirror', async () => {
    await putFile('library/views/v1.json', '{}')
    await deleteFile('library/views/v1.json')
    expect(fake.objects.has('library/views/v1.json')).toBe(false)
    expect(existsSync(join(dataDir, 'library/views/v1.json'))).toBe(false)
  })
})

describe('listFiles', () => {
  it('lists keys and sizes under a prefix', async () => {
    await putFile('library/datasets/a/data.csv', '123')
    await putFile('library/datasets/b/data.csv', '12345')
    await putFile('library/wiki/home.md', 'x')
    const files = await listFiles('library/datasets/')
    expect(files.map(f => f.key).sort()).toEqual([
      'library/datasets/a/data.csv',
      'library/datasets/b/data.csv',
    ])
    expect(files.find(f => f.key === 'library/datasets/b/data.csv')?.size).toBe(5)
  })

  it('surfaces the object modification time as ISO when the listing reports one', async () => {
    const stamped = new Date('2026-04-02T08:00:00.000Z')
    fake.seed('library/datasets/c/data.csv', 'abc', stamped)
    fake.seed('library/datasets/d/data.csv', 'abc', null)
    const files = await listFiles('library/datasets/')
    expect(files.find(f => f.key === 'library/datasets/c/data.csv')?.lastModified).toBe(stamped.toISOString())
    expect(files.find(f => f.key === 'library/datasets/d/data.csv')).not.toHaveProperty('lastModified')
  })
})

describe('syncMirror (boot-time: mirror is a rebuildable cache of the bucket)', () => {
  it('downloads bucket objects missing locally and prunes strays', async () => {
    fake.objects.set('library/datasets/tn/data.csv', Buffer.from('a,b\n'))
    fake.objects.set('library/datasets/tn/meta.json', Buffer.from('{}'))
    // stray local file not present in the bucket (e.g. leftover from a
    // previous deploy) must be pruned — bucket is the source of truth
    mkdirSync(join(dataDir, 'library/datasets/old'), { recursive: true })
    writeFileSync(join(dataDir, 'library/datasets/old/data.csv'), 'stale')

    const result = await syncMirror()
    expect(result.downloaded).toBe(2)
    expect(result.removed).toBe(1)
    expect(readFileSync(join(dataDir, 'library/datasets/tn/data.csv'), 'utf8')).toBe('a,b\n')
    expect(existsSync(join(dataDir, 'library/datasets/old/data.csv'))).toBe(false)
  })

  it('skips files already present with matching size', async () => {
    fake.objects.set('library/wiki/home.md', Buffer.from('# home'))
    await syncMirror()
    const second = await syncMirror()
    expect(second.downloaded).toBe(0)
    expect(second.kept).toBe(1)
  })

  // A boot-time sync that throws leaves the server with no mirror at all.
  // One bad object must cost that object, not the whole library.
  it('warns and continues past an object it cannot download or safely name', async () => {
    fake.objects.set('library/datasets/tn/data.csv', Buffer.from('a,b\n'))
    fake.objects.set('library/datasets/tn/broken.csv', Buffer.from('boom'))
    fake.objects.set('library/datasets/trailing/', Buffer.from('')) // unsafe: empty segment
    fake.objects.set('library/wiki/home.md', Buffer.from('# home'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const send = fake.send.bind(fake)
    vi.spyOn(fake, 'send').mockImplementation(async (cmd: any) => {
      if (cmd.constructor.name === 'GetObjectCommand' && cmd.input.Key.endsWith('broken.csv')) {
        throw new Error('bucket down')
      }
      return send(cmd)
    })

    const result = await syncMirror()
    expect(result.downloaded).toBe(2)
    expect(readFileSync(join(dataDir, 'library/datasets/tn/data.csv'), 'utf8')).toBe('a,b\n')
    expect(readFileSync(join(dataDir, 'library/wiki/home.md'), 'utf8')).toBe('# home')
    expect(existsSync(join(dataDir, 'library/datasets/tn/broken.csv'))).toBe(false)
    const warned = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(warned).toContain('broken.csv')
    expect(warned).toContain('library/datasets/trailing/')
  })

  it('is a no-op when the bucket is disabled', async () => {
    await closeLibraryBucket()
    const result = await syncMirror()
    expect(result).toEqual({ downloaded: 0, removed: 0, kept: 0 })
  })
})
