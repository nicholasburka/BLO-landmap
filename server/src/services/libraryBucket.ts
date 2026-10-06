import type { S3Client } from '@aws-sdk/client-s3'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, sep } from 'node:path'

/**
 * Object-storage layer for the internal data library (phase 5, P5-7).
 *
 * Backblaze B2 via the S3-compatible API (P5-6 decision) — but this module
 * only ever speaks generic S3, with the endpoint from env, so swapping to
 * R2/S3 later is an env change, not a code change.
 *
 * Design (per the P5-6 spike):
 *  - The bucket is the source of truth for library FILES; Postgres holds the
 *    queryable index (libraryDb.ts). The local mirror under LIBRARY_DATA_DIR
 *    is a rebuildable cache — the API host is assumed to have EPHEMERAL disk.
 *  - Writes go bucket-first, then mirror. A failed bucket write must never
 *    leave a mirror-only file that a restart would silently drop.
 *  - syncMirror() runs at boot: download what's missing, prune local strays.
 *    Fine while the library is ≤ a few GB; if cold-start sync ever hurts,
 *    the escape hatches are a host volume or lazy per-file fetch (getFile
 *    already caches on miss, so the lazy path is mostly built).
 *  - Missing LIBRARY_BUCKET_* envs → features disabled with a logged warning.
 *    The public map's routes never depend on this module.
 */

const KEY_PREFIX = 'library/'
// Conservative allowlist: the library tree is slugs, filenames, and uuids.
const SAFE_KEY = /^library\/[A-Za-z0-9][A-Za-z0-9._/-]*$/
// Keys become mirror file paths, so they inherit filesystem limits: ~255
// bytes per component on ext4/APFS, and a full path that mkdir can create.
const MAX_KEY_BYTES = 1024
const MAX_SEGMENT_BYTES = 200

let client: S3Client | null = null
let bucket = ''
let dataDir = ''

interface InjectedBucket {
  client: S3Client
  bucket: string
  dataDir?: string
}

/** Initialize the bucket client. Call once at boot (or from tests with an
 *  injected fake client). Returns true when file features are available. */
export async function initLibraryBucket(injected?: InjectedBucket): Promise<boolean> {
  try {
    if (injected) {
      client = injected.client
      bucket = injected.bucket
      dataDir = injected.dataDir ?? process.env.LIBRARY_DATA_DIR ?? './library-data'
      return true
    }
    const endpoint = process.env.LIBRARY_BUCKET_ENDPOINT
    const region = process.env.LIBRARY_BUCKET_REGION
    const name = process.env.LIBRARY_BUCKET_NAME
    const keyId = process.env.LIBRARY_BUCKET_KEY_ID
    const secret = process.env.LIBRARY_BUCKET_SECRET
    if (!endpoint || !region || !name || !keyId || !secret) {
      console.warn(
        '[library] LIBRARY_BUCKET_* env vars not set — library file features disabled, public map unaffected.',
      )
      client = null
      return false
    }
    const { S3Client: RealS3Client } = await import('@aws-sdk/client-s3')
    client = new RealS3Client({
      endpoint,
      region,
      credentials: { accessKeyId: keyId, secretAccessKey: secret },
      // B2's S3 layer rejects the SDK's default aws-chunked trailing
      // checksums on streaming bodies (P5-10 uploads). WHEN_REQUIRED keeps
      // checksums for operations that mandate them and plain puts otherwise.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    bucket = name
    dataDir = process.env.LIBRARY_DATA_DIR ?? './library-data'
    console.log(`[library] bucket "${name}" ready (mirror: ${dataDir}).`)
    return true
  } catch (err: any) {
    console.warn(
      `[library] bucket init failed (${err?.message || err}) — library file features disabled, public map unaffected.`,
    )
    client = null
    return false
  }
}

export function isBucketEnabled(): boolean {
  return client !== null
}

/** Test hook + graceful shutdown. */
export async function closeLibraryBucket(): Promise<void> {
  const c = client as { destroy?: () => void } | null
  client = null
  bucket = ''
  try {
    c?.destroy?.()
  } catch {
    /* destroy is best-effort */
  }
}

function requireClient(): S3Client {
  if (!client) throw new Error('library bucket is not initialized')
  return client
}

/** Every key must live under library/ and be path-traversal-proof — keys
 *  become mirror file paths, so this is a security boundary, not a lint.
 *  Exported for the sync CLI (P5-13), which screens local filenames before
 *  attempting an upload so it can warn-and-skip instead of aborting. */
export function isSafeKey(key: string): boolean {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.includes('\0')) return false
  if (Buffer.byteLength(key) > MAX_KEY_BYTES) return false
  // Every segment is one path component: it must be non-empty (which also
  // rules out "//" and a trailing "/") and short enough to actually create.
  return key.split('/').every(seg => seg.length > 0 && Buffer.byteLength(seg) <= MAX_SEGMENT_BYTES)
}

function assertSafeKey(key: string): void {
  if (!isSafeKey(key)) {
    throw new Error(`invalid library key: ${JSON.stringify(key)}`)
  }
}

function mirrorPath(key: string): string {
  return join(dataDir, key)
}

/** Scratch space for atomic mirror writes. Deliberately NOT under the
 *  `library/` tree: syncMirror() prunes everything under it that the bucket
 *  does not hold, and that sweep runs concurrently with these writes. Same
 *  filesystem as the mirror, so the rename below cannot fall back to a copy. */
const MIRROR_TMP_DIR = '.mirror-tmp'

/** A mirror path nothing else will claim, inside MIRROR_TMP_DIR. Not derived
 *  from the key: keys run to 1 KB, and a temp name has the same per-component
 *  filesystem limit to respect as a real one. */
function mirrorTempPath(): string {
  return join(dataDir, MIRROR_TMP_DIR, `${process.pid}-${randomUUID()}`)
}

/**
 * Write the mirror copy atomically: whole file into a temp, then rename over
 * the destination.
 *
 * P6-35: `fs.writeFile(dest, body)` opens the destination with O_TRUNC and
 * only then writes the bytes, so for as long as the write takes a concurrent
 * reader sees the file EMPTY or half-written — getFile()'s mirror read
 * returning '' (which is how this was caught), ensureMirrored() stat'ing a
 * size of 0 and streaming nothing to a download. The readers and the writers
 * are ordinary neighbours here: the post-reindex extraction sweep refetches
 * `fresh: true` copies of the very files MCP, the text route and the ask
 * index are reading, and syncMirror() rewrites them again underneath.
 * rename(2) is atomic within a filesystem, so a reader now sees either the
 * previous complete copy or the new one, never a torn one.
 */
async function writeMirrorFile(key: string, body: Buffer): Promise<void> {
  const path = mirrorPath(key)
  const tmp = mirrorTempPath()
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.mkdir(dirname(tmp), { recursive: true })
  try {
    await fs.writeFile(tmp, body)
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/** Promote a file that already exists on disk into the mirror, atomically.
 *  `keepSource` leaves the source where it is (the P5-13 sync CLI hands us a
 *  dev's working file, not a disposable upload temp). */
async function promoteIntoMirror(key: string, srcPath: string, keepSource: boolean): Promise<void> {
  const dest = mirrorPath(key)
  await fs.mkdir(dirname(dest), { recursive: true })
  if (!keepSource) {
    try {
      // Already atomic, and it moves the bytes without reading them.
      await fs.rename(srcPath, dest)
      return
    } catch {
      /* cross-device (the upload temp lives in the OS temp dir) — copy below */
    }
  }
  const tmp = mirrorTempPath()
  await fs.mkdir(dirname(tmp), { recursive: true })
  try {
    await fs.copyFile(srcPath, tmp)
    await fs.rename(tmp, dest)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
  if (!keepSource) await fs.rm(srcPath, { force: true })
}

/** Bucket-first write, then mirror. */
export async function putFile(
  key: string,
  body: Buffer | string,
  contentType?: string,
): Promise<void> {
  assertSafeKey(key)
  const c = requireClient()
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf, ContentType: contentType }))
  await writeMirrorFile(key, buf)
}

/** Bucket-first STREAMING write from a local file (P5-10 uploads): the body
 *  never sits in memory. On bucket success the source file is promoted into
 *  the mirror (rename, with a copy fallback for cross-device temp dirs), so
 *  a failed bucket write leaves no mirror-only file.
 *
 *  `keepSource` (P5-13 sync CLI): copy into the mirror instead of renaming —
 *  the source is the dev's working file, not a disposable upload temp. Either
 *  way the destination appears whole, never mid-copy (P6-35). */
export async function putFileFromPath(
  key: string,
  srcPath: string,
  size: number,
  contentType?: string,
  options: { keepSource?: boolean } = {},
): Promise<void> {
  assertSafeKey(key)
  const c = requireClient()
  const { createReadStream } = await import('node:fs')
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  await c.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(srcPath),
      ContentLength: size,
      ContentType: contentType,
    }),
  )
  await promoteIntoMirror(key, srcPath, options.keepSource === true)
}

/** Read from the mirror; on miss, fetch from the bucket and cache locally.
 *  `fresh: true` skips the mirror read and refetches from the bucket (which
 *  also repairs the mirror copy) — used by reindex, whose whole point is
 *  "files in the bucket are truth", so a stale mirror must never win there. */
export async function getFile(key: string, options: { fresh?: boolean } = {}): Promise<Buffer> {
  assertSafeKey(key)
  const c = requireClient()
  if (!options.fresh) {
    try {
      return await fs.readFile(mirrorPath(key))
    } catch {
      /* mirror miss — fall through to the bucket */
    }
  }
  const { GetObjectCommand } = await import('@aws-sdk/client-s3')
  const res = await c.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const buf = Buffer.from(await res.Body!.transformToByteArray())
  await writeMirrorFile(key, buf)
  return buf
}

/** Make sure the mirror holds `key` and return its on-disk path + size, so a
 *  route can stream the file with createReadStream instead of buffering it
 *  per request (P5-25 downloads). A mirror miss fetches once via getFile. */
export async function ensureMirrored(key: string): Promise<{ path: string; size: number }> {
  assertSafeKey(key)
  const path = mirrorPath(key)
  try {
    const stat = await fs.stat(path)
    if (stat.isFile()) return { path, size: stat.size }
  } catch {
    /* miss — fetch below */
  }
  const buf = await getFile(key)
  return { path, size: buf.length }
}

/** Bucket-first delete, then mirror (missing mirror file is fine). */
export async function deleteFile(key: string): Promise<void> {
  assertSafeKey(key)
  const c = requireClient()
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
  await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  await fs.rm(mirrorPath(key), { force: true })
}

export interface LibraryFile {
  key: string
  size: number
  /** ISO time the object was last written, when the listing reports one.
   *  Reindex takes the newest per entry as that entry's updated time. */
  lastModified?: string
}

/** List bucket objects under a prefix (paginated under the hood). */
export async function listFiles(prefix: string = KEY_PREFIX): Promise<LibraryFile[]> {
  const c = requireClient()
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3')
  const files: LibraryFile[] = []
  let token: string | undefined
  do {
    const res: any = await c.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    )
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue
      const lastModified = obj.LastModified instanceof Date ? obj.LastModified.toISOString() : undefined
      files.push({ key: obj.Key, size: obj.Size ?? 0, ...(lastModified ? { lastModified } : {}) })
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return files
}

export interface SyncResult {
  downloaded: number
  removed: number
  kept: number
}

/** Recursively collect relative file paths (posix-style) under a directory.
 *  Exported for the sync CLI (P5-13), which walks the dev's local tree. */
export async function walkLocal(dir: string, root: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // directory doesn't exist yet — nothing local
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkLocal(full, root, out)
    else out.push(relative(root, full).split(sep).join('/'))
  }
}

/** Boot-time mirror rebuild: download bucket objects missing locally (or
 *  size-mismatched), prune local files the bucket no longer has. No-op when
 *  the bucket is disabled. */
export async function syncMirror(): Promise<SyncResult> {
  if (!client) return { downloaded: 0, removed: 0, kept: 0 }
  const remote = await listFiles(KEY_PREFIX)
  const remoteKeys = new Set(remote.map(f => f.key))
  let downloaded = 0
  let kept = 0

  for (const file of remote) {
    // One unreadable or badly-named object must cost that object, not the
    // whole boot: this runs at startup, and a throw here would leave the
    // server with no mirror at all. getFile() re-fetches on demand anyway.
    try {
      assertSafeKey(file.key)
      let localSize = -1
      try {
        localSize = (await fs.stat(mirrorPath(file.key))).size
      } catch {
        /* missing locally */
      }
      if (localSize === file.size) {
        kept++
        continue
      }
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const res = await requireClient().send(new GetObjectCommand({ Bucket: bucket, Key: file.key }))
      await writeMirrorFile(file.key, Buffer.from(await res.Body!.transformToByteArray()))
      downloaded++
    } catch (err: any) {
      console.warn(`[library] mirror sync skipped ${JSON.stringify(file.key)}: ${err?.message || err}`)
    }
  }

  // Prune strays: the mirror only caches what the bucket holds.
  const localTreeRoot = join(dataDir, KEY_PREFIX)
  const localFiles: string[] = []
  await walkLocal(localTreeRoot, dataDir, localFiles)
  let removed = 0
  for (const rel of localFiles) {
    if (!remoteKeys.has(rel)) {
      await fs.rm(join(dataDir, rel), { force: true })
      removed++
    }
  }
  return { downloaded, removed, kept }
}
