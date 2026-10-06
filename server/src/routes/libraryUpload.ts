import { Router } from 'express'
import busboy from 'busboy'
import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled, putFile, putFileFromPath } from '../services/libraryBucket.js'
import { indexIncomingEntry } from '../services/libraryCatalog.js'
import { contentTypeFor } from '../services/contentTypes.js'
import { queueSuggestion } from '../services/linkFetchQueue.js'
import {
  fieldError,
  maxUploadBytes,
  parseTags,
  prettyBytes,
  sanitizeFilename,
} from '../services/uploadFields.js'

/**
 * Upload API (P5-10): POST /api/library/upload → library/incoming/<uuid>/.
 *
 * Spec ground rules:
 *  - Streamed, never buffered in memory: busboy pipes the file part to a
 *    temp file, which then streams to the bucket (Example 8 is a 300 MB
 *    video — the limit is configurable, the memory footprint is not).
 *  - Any file type is accepted; only SIZE is rejected, with a clear message
 *    (Example 8: the .zip goes in as-is).
 *  - The upload manifest is the entry's meta.json: uploader, timestamp,
 *    original filename, plus whatever filing-form fields came along. Filed
 *    uploads catalog as needs-review (Example 1); bare quick drops as
 *    needs-cataloging (Example 5). Either way the bucket tree alone can
 *    reproduce the catalog row on reindex — files stay the truth.
 */

const router = Router()
router.use('/api/library/upload', requireInternalUser)

interface ReceivedFile {
  tempPath: string
  originalFilename: string
  contentType: string
  size: number
  truncated: boolean
}

router.post('/api/library/upload', internalRateLimit, (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const limit = maxUploadBytes()

  let bb: ReturnType<typeof busboy>
  try {
    // defParamCharset utf8: browsers send raw UTF-8 filenames in the
    // Content-Disposition header; busboy's latin1 default mangles them.
    bb = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      // The filing form is five short fields and one file. Everything beyond
      // that is either a bug or someone probing what the parser will hold in
      // memory, so busboy stops reading rather than us noticing afterwards.
      limits: { fileSize: limit, files: 1, fields: 8, fieldSize: 4 * 1024, fieldNameSize: 64, parts: 10 },
    })
  } catch {
    res.status(400).json({ error: 'multipart/form-data body required' })
    return
  }

  const fields: Record<string, string> = {}
  // Hoisted out of the promise: whatever happens to the request, the path we
  // opened has to be reachable from the cleanup below.
  let tempPath: string | null = null
  let fileStream: Readable | null = null
  let filePromise: Promise<ReceivedFile> | null = null
  let responded = false
  let finished = false

  function respond(status: number, body: unknown): void {
    if (responded) return
    responded = true
    res.status(status).json(body)
  }

  bb.on('field', (name, value) => {
    fields[name] = value
  })

  bb.on('file', (_name, stream, info) => {
    // A limit can trip while the FIELDS are still arriving, so the file part
    // can reach us after we have already answered and cleaned up. Opening a
    // temp file for it would leak one nobody is left to remove.
    if (finished) {
      stream.resume()
      return
    }
    const path = join(tmpdir(), `blo-upload-${randomUUID()}`)
    tempPath = path
    fileStream = stream
    let size = 0
    let truncated = false
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
    })
    // busboy cuts the stream at limits.fileSize and signals here; the rest
    // of the request body is drained and discarded, never written.
    stream.on('limit', () => {
      truncated = true
    })
    // pipeline (not pipe) so a dead request tears the file descriptor down
    // with it — a hand-rolled pipe leaks one fd per abandoned upload.
    filePromise = pipeline(stream, createWriteStream(path)).then(() => ({
      tempPath: path,
      originalFilename: info.filename || 'upload.bin',
      contentType: info.mimeType || 'application/octet-stream',
      size,
      truncated,
    }))
    // The failure paths below never await this; keep Node from calling the
    // rejection unhandled.
    filePromise.catch(() => {})
  })

  /** One exit for every ending — success, malformed body, client hang-up.
   *  A reason means nothing is stored and only the cleanup runs. */
  function finish(reason?: Error): void {
    if (finished) return
    finished = true
    // A half-read part keeps its pipeline (and fd) alive forever; destroying
    // it makes filePromise settle so finalize can reach its cleanup.
    if (reason) fileStream?.destroy(reason)
    void finalize(reason)
  }

  bb.on('error', () => {
    respond(400, { error: 'malformed multipart body' })
    finish(new Error('malformed multipart body'))
  })
  bb.on('fieldsLimit', () => {
    respond(400, { error: 'too many form fields' })
    finish(new Error('too many form fields'))
  })
  bb.on('partsLimit', () => {
    respond(400, { error: 'too many parts in the form' })
    finish(new Error('too many parts in the form'))
  })
  bb.on('close', () => finish())
  // busboy emits nothing when the client vanishes mid-body, so without this
  // every abandoned upload leaves its temp file (and fd) behind for good.
  req.on('close', () => {
    if (!req.complete) bb.destroy(new Error('client aborted'))
  })
  req.pipe(bb)

  async function finalize(reason?: Error): Promise<void> {
    try {
      if (reason) return
      const file = filePromise ? await filePromise : null
      if (!file) {
        respond(400, { error: 'a file part is required' })
        return
      }
      if (file.truncated) {
        respond(413, { error: `File too large: the upload limit is ${prettyBytes(limit)}` })
        return
      }

      const slug = randomUUID()
      const storedName = sanitizeFilename(file.originalFilename)
      const key = `library/incoming/${slug}/${storedName}`
      const metaKey = `library/incoming/${slug}/meta.json`
      const user = res.locals.internalUser as { id: number; username: string } | undefined

      const title = (fields.title ?? '').trim()
      const category = (fields.category ?? '').trim()
      const description = (fields.description ?? '').trim()
      const tags = parseTags(fields.tags)
      const bad = fieldError(fields, tags)
      if (bad) {
        respond(400, { error: bad })
        return
      }
      const quickDrop = !title && !category && !description && tags.length === 0
      const status = quickDrop ? 'needs-cataloging' : 'needs-review'

      // The upload manifest doubles as the entry's meta.json so a reindex
      // rebuilds this catalog row from the bucket alone.
      const meta: Record<string, unknown> = {
        title: title || file.originalFilename,
        category,
        status,
        tags,
        ...(description ? { description } : {}),
        uploadedBy: user?.username ?? 'unknown',
        uploadedById: user?.id ?? null,
        uploadedAt: new Date().toISOString(),
        originalFilename: file.originalFilename,
        contentType: file.contentType,
        size: file.size,
      }

      // Bucket-first: file (streamed from the temp path), then manifest,
      // then the catalog row for immediate visibility.
      // The object is labelled from the name it is STORED under, never from
      // the client's declaration — meta.contentType keeps that as a claim.
      await putFileFromPath(key, file.tempPath, file.size, contentTypeFor(storedName))
      const metaJson = JSON.stringify(meta, null, 2)
      await putFile(metaKey, metaJson, 'application/json')
      await indexIncomingEntry(slug, meta, [
        { key, size: file.size },
        { key: metaKey, size: Buffer.byteLength(metaJson) },
      ])

      // P5-47: propose a filing for what was just dropped. Queued, not
      // awaited — reading a 300-page PDF and asking a model must never be
      // something an uploader watches a spinner for.
      queueSuggestion({
        slug,
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        clientIp: req.ip,
      })

      void writeAudit({
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        action: 'library.upload',
        target: slug,
        detail: { filename: file.originalFilename, size: file.size, quickDrop },
      })
      respond(201, { slug, key, size: file.size, status })
    } catch (err: any) {
      console.error('[library] upload failed:', err?.message || err)
      respond(500, { error: 'Internal server error' })
    } finally {
      // putFileFromPath renames the temp file into the mirror on success, so
      // this is a no-op then; every other path — rejection, truncated body,
      // client hang-up — depends on it.
      if (tempPath) await fs.rm(tempPath, { force: true }).catch(() => {})
    }
  }
})

export default router
