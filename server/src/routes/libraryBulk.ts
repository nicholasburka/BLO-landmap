import { Router } from 'express'
import busboy from 'busboy'
import { randomUUID } from 'node:crypto'
import { createWriteStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { dailyBudgetMiddleware, settleReservation } from '../middleware/budget.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { getCatalogEntry } from '../services/libraryCatalog.js'
import { prettyBytes } from '../services/uploadFields.js'
import { ANNOTATE_COST_CENTS } from '../services/annotateEntry.js'
import {
  bulkDropStatus,
  bulkMaxDropBytes,
  bulkMaxFileBytes,
  bulkMaxFiles,
  createBulkDrop,
  getBulkDrop,
  queueAnnotate,
  storeBulkDrop,
  type DroppedFile,
} from '../services/bulkDrop.js'

/**
 * Many documents at once (P6-8).
 *
 * `POST /api/library/bulk` takes a folder or a multi-file selection, stores
 * every file with the same checks a single upload passes, and answers with a
 * drop id. `GET /api/library/bulk/:dropId` is what the New page polls while
 * the annotation queue works through them. `POST
 * /api/library/entries/:id/annotate` re-runs one file's pass — the row's and
 * the entry page's "Look again".
 *
 * What this route does NOT do is file anything. Every row lands `needs-review`
 * with its deterministic floor and a proposal beside it; applying the proposal
 * is the ordinary `PATCH /api/library/catalog/:slug` a person presses Accept
 * for, with the ordinary `library.file` audit row. No file is fetched from a
 * URL anywhere on this path.
 */

const router = Router()
router.use('/api/library/bulk', requireInternalUser)
router.use('/api/library/entries/:id/annotate', requireInternalUser)

interface ReceivedFile extends DroppedFile {
  truncated: boolean
}

router.post('/api/library/bulk', internalRateLimit, (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const maxFiles = bulkMaxFiles()
  const maxFileBytes = bulkMaxFileBytes()
  const maxDropBytes = bulkMaxDropBytes()

  let bb: ReturnType<typeof busboy>
  try {
    bb = busboy({
      headers: req.headers,
      // Browsers send raw UTF-8 filenames; busboy's latin1 default mangles them.
      defParamCharset: 'utf8',
      // One more file than the cap, so the extra one TRIPS the limit and the
      // answer can say what the cap is instead of silently dropping it.
      limits: {
        fileSize: maxFileBytes,
        files: maxFiles + 1,
        fields: 8,
        fieldSize: 4 * 1024,
        fieldNameSize: 64,
        parts: maxFiles + 10,
      },
    })
  } catch {
    res.status(400).json({ error: 'multipart/form-data body required' })
    return
  }

  const fields: Record<string, string> = {}
  const tempPaths: string[] = []
  const filePromises: Promise<ReceivedFile>[] = []
  /** The part being written right now, so an abort can tear its fd down. */
  let currentStream: NodeJS.ReadableStream & { destroy(err?: Error): void } | null = null
  let responded = false
  let finished = false
  let fileCount = 0
  let tooMany = false
  let totalBytes = 0
  let overDrop = false

  function respond(status: number, body: unknown): void {
    if (responded) return
    responded = true
    res.status(status).json(body)
  }

  bb.on('field', (name, value) => {
    fields[name] = value
  })

  bb.on('file', (_name, stream, info) => {
    if (finished || tooMany || overDrop) {
      stream.resume()
      return
    }
    // Counted here rather than left to busboy's own `filesLimit`, so the cap
    // is the one the message names and the 51st file is never written.
    if (++fileCount > maxFiles) {
      tooMany = true
      stream.resume()
      respond(400, { error: `That is more than ${maxFiles} files. Drop them in a few smaller batches.` })
      finish(new Error('too many files'))
      return
    }
    currentStream = stream as typeof currentStream
    // A part that has already finished still throws if it is destroyed with a
    // reason and nothing is listening — `pipeline` removes its own handler
    // when it resolves. This one is inert and outlives it.
    stream.on('error', () => {})
    const path = join(tmpdir(), `blo-bulk-${randomUUID()}`)
    tempPaths.push(path)
    let size = 0
    let truncated = false
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      totalBytes += chunk.length
      // The whole-drop cap is the only one busboy cannot enforce for us: it
      // counts per file. Tripping it stops the parse rather than letting a
      // 40 GB folder stream through one 90 MB file at a time.
      if (totalBytes > maxDropBytes && !overDrop) {
        overDrop = true
        respond(413, {
          error: `That drop is too large: at most ${prettyBytes(maxDropBytes)} in one go. Send it in a few smaller batches.`,
        })
        finish(new Error('drop too large'))
      }
    })
    stream.on('limit', () => {
      truncated = true
    })
    const promise = pipeline(stream, createWriteStream(path)).then(() => ({
      tempPath: path,
      originalFilename: info.filename || 'upload.bin',
      contentType: info.mimeType || 'application/octet-stream',
      size,
      truncated,
    }))
    // Finished parts are nobody's to tear down, and nothing here may leave a
    // rejection for Node to call unhandled.
    promise
      .catch(() => {})
      .finally(() => {
        if (currentStream === (stream as typeof currentStream)) currentStream = null
      })
    filePromises.push(promise)
  })

  /** One exit for every ending — success, a cap, a malformed body, a client
   *  hang-up. A reason means nothing is stored and only the cleanup runs. */
  function finish(reason?: Error): void {
    if (finished) return
    finished = true
    // A half-read part keeps its pipeline (and its fd) alive forever;
    // destroying it makes the promise settle so finalize reaches its cleanup.
    // The parser itself is left alone and the rest of the body is drained by
    // the guard at the top of the file handler — tearing busboy down mid-part
    // raises an error nobody is left to catch, and the answer has already gone.
    if (reason) currentStream?.destroy(reason)
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
  req.on('close', () => {
    if (!req.complete) bb.destroy(new Error('client aborted'))
  })
  req.pipe(bb)

  async function finalize(reason?: Error): Promise<void> {
    try {
      if (reason) return
      const files: ReceivedFile[] = []
      for (const promise of filePromises) {
        try {
          files.push(await promise)
        } catch {
          // A part that never finished arriving: the rest of the drop stands.
        }
      }
      if (!files.length) {
        respond(400, { error: 'at least one file is required' })
        return
      }
      const oversize = files.find(f => f.truncated)
      if (oversize) {
        respond(413, {
          error: `"${oversize.originalFilename}" is too large: the limit is ${prettyBytes(maxFileBytes)} per file.`,
        })
        return
      }

      const user = res.locals.internalUser as { id: number; username: string } | undefined
      const collection = fields.collection === '1' || fields.collection === 'true'
      const drop = createBulkDrop(user?.id ?? null, user?.username ?? 'unknown')
      const status = await storeBulkDrop(
        drop,
        files,
        {
          userId: user?.id ?? null,
          actor: user?.username ?? 'unknown',
          collection,
          collectionTitle: fields.collectionTitle,
        },
        { clientIp: req.ip },
      )

      void writeAudit({
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        action: 'library.bulk',
        target: drop.id,
        detail: { files: files.length, bytes: totalBytes, collection, entries: status.rows.length },
      })
      respond(201, { ...status, estimateCents: status.rows.length * ANNOTATE_COST_CENTS })
    } catch (err: any) {
      console.error('[library] bulk drop failed:', err?.message || err)
      respond(500, { error: 'Internal server error' })
    } finally {
      // putFileFromPath renames a temp file into the mirror on success, so
      // this is a no-op then; every other path depends on it.
      for (const path of tempPaths) await fs.rm(path, { force: true }).catch(() => {})
    }
  }
})

router.get<{ dropId: string }>('/api/library/bulk/:dropId', (req, res) => {
  const drop = getBulkDrop(req.params.dropId)
  const user = res.locals.internalUser as { id: number; username: string; role?: string } | undefined
  // A drop belongs to whoever made it. Not a secret worth an oracle: an id
  // nobody made and an id somebody else made answer the same way.
  if (!drop || (drop.userId !== (user?.id ?? null) && user?.role !== 'admin')) {
    res.status(404).json({ error: 'not found' })
    return
  }
  res.json(bulkDropStatus(drop))
})

/**
 * Re-run one file's pass — "Look again".
 *
 * The daily budget middleware guards it, because spending model tokens is the
 * only thing this request does. Its reservation is released at once: the pass
 * runs in the queue, where `callAssistant` makes its own reservation against
 * the same counters when it actually asks.
 */
router.post<{ id: string }>('/api/library/entries/:id/annotate', internalRateLimit, dailyBudgetMiddleware, async (req, res) => {
  const clientIp = (res.locals.clientIp as string) || 'unknown'
  const reserved = (res.locals.budgetReservation as number) || 0
  settleReservation(clientIp, reserved, 0)

  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const entry = await getCatalogEntry(req.params.id)
    if (!entry) {
      res.status(404).json({ error: 'not found' })
      return
    }
    if (entry.kind !== 'incoming' && entry.kind !== 'document') {
      res.status(409).json({ error: 'only a dropped document can be read again' })
      return
    }
    const user = res.locals.internalUser as { id: number; username: string } | undefined
    const queued = queueAnnotate({
      slug: entry.slug,
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      clientIp: req.ip,
    })
    if (queued === 'full') {
      res.status(503).json({ error: 'the queue is busy — try again in a minute' })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.annotate',
      target: entry.slug,
      detail: { title: entry.title },
    })
    res.json({ slug: entry.slug, state: 'queued' })
  } catch (err: any) {
    console.error('[library] annotate failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
