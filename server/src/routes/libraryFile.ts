import { createReadStream } from 'node:fs'
import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled, isSafeKey, ensureMirrored } from '../services/libraryBucket.js'
import { getCatalogEntry } from '../services/libraryCatalog.js'
import { contentTypeFor } from '../services/contentTypes.js'

/**
 * Library file downloads (P5-25): `GET /api/library/file/:slug/:filename`
 * streams one of an entry's files from the server mirror (lazy bucket fetch
 * on a miss) as an attachment. Internal-tier throughout; unknown slugs and
 * files 404 identically; keys are re-checked against the bucket service's
 * safety regex before touching the disk. Downloads are audited.
 */
const router = Router()
router.use('/api/library', requireInternalUser)

// Stored and served types come from one table (services/contentTypes.ts),
// re-exported here for the route's existing callers.
export { contentTypeFor }

/** Basename inside the entry folder (mirrors the client's fileName helper). */
function basenameInEntry(key: string): string {
  return key.split('/').slice(3).join('/') || key
}

/** RFC 6266 content-disposition header: ASCII fallback + UTF-8 `filename*`. */
export function dispositionHeader(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/** Back-compat alias for the download callers/tests. */
export function attachmentHeader(name: string): string {
  return dispositionHeader('attachment', name)
}

// Types a browser renders WITHOUT running page script. Anything not here —
// docx/xlsx/zip, and crucially text/html and image/svg+xml (which are not in
// the type table, so they resolve to application/octet-stream) — is only ever
// served as an attachment, even when `?disposition=inline` is asked for. This
// keeps the P5-19 rule that nothing stored can render as active content.
const INLINE_SAFE = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain; charset=utf-8',
  'text/markdown; charset=utf-8',
  'text/csv; charset=utf-8',
  'text/tab-separated-values; charset=utf-8',
  'application/json',
  'application/geo+json',
])

/** Whether the file may be served inline for in-app viewing (P5-44). */
export function isInlineSafe(name: string): boolean {
  return INLINE_SAFE.has(contentTypeFor(name))
}

router.get('/api/library/file/:slug/:filename', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const entry = await getCatalogEntry(req.params.slug)
    const name = req.params.filename
    const file = entry?.files?.find(f => basenameInEntry(f.key) === name)
    if (!entry || !file || !isSafeKey(file.key)) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const { path, size } = await ensureMirrored(file.key)
    // In-app viewing (P5-44): serve inline ONLY for render-without-script
    // types; every other file — and any unsafe type asking for inline — is
    // still an attachment. `nosniff` (also set globally by helmet) keeps the
    // browser from second-guessing the declared type.
    const wantsInline = req.query.disposition === 'inline' && isInlineSafe(name)
    res.setHeader('Content-Type', contentTypeFor(name))
    res.setHeader('Content-Disposition', dispositionHeader(wantsInline ? 'inline' : 'attachment', name))
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Length', String(size))
    res.setHeader('Cache-Control', 'private, no-store')
    const user = res.locals.internalUser
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      // Views are recorded separately from downloads and kept out of the
      // activity feed (P5-40), so opening a doc to read it isn't "activity".
      action: wantsInline ? 'library.view' : 'library.download',
      target: file.key,
      detail: { slug: entry.slug, name, bytes: size },
    })
    const stream = createReadStream(path)
    stream.on('error', err => {
      console.error('[library] download stream failed:', err?.message || err)
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
      else res.destroy()
    })
    stream.pipe(res)
  } catch (err: any) {
    console.error('[library] download failed:', err?.message || err)
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
