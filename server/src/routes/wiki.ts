import { Router, text } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { isLibraryEnabled, libraryQuery, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { getCatalogEntry, getWikiPage, upsertWikiPage, WIKI_SLUG } from '../services/libraryCatalog.js'

/**
 * Wiki CRUD API (P5-14). Pages are flat markdown files in the bucket
 * (library/wiki/<slug>.md) indexed into library_catalog as kind 'wiki';
 * listing rides the existing GET /api/library/catalog?kind=wiki.
 *
 * PUT takes the RAW markdown body (text/plain or text/markdown), not JSON:
 * pages can exceed the app-wide 64kb express.json limit, and raw text means
 * the guard rejects unauthenticated requests before any body is parsed.
 * Client renders + sanitizes (existing marked + DOMPurify stack) — the
 * server stores markdown verbatim.
 */

const WIKI_MAX_BYTES = 1024 * 1024 // 1 MB of markdown is a very long page

const router = Router()
router.use('/api/wiki', requireInternalUser)
router.use('/api/wiki', text({ type: ['text/plain', 'text/markdown'], limit: WIKI_MAX_BYTES }))

/**
 * Lost-update guard (P5-49). Two people can have the same page open; the
 * second Save must not silently erase the first. GET hands back the catalog
 * row's `updated_at`, the editor echoes it as `If-Unmodified-Since`, and a
 * PUT whose page has moved on since then is refused with 412 so the client
 * can offer "reload, or save anyway" (retry without the header).
 *
 * The timestamp is read here rather than added to getWikiPage() so this
 * ticket touches one route file — the extra row read costs a primary-key
 * lookup on a page save.
 */
async function wikiUpdatedAt(slug: string): Promise<string | null> {
  const entry = await getCatalogEntry(slug)
  return entry && entry.kind === 'wiki' ? entry.updatedAt ?? null : null
}

/** Who saved the page last, for the conflict notice. Best-effort: the notice
 *  reads fine without a name, so a failed lookup is never fatal. */
async function lastWikiEditor(slug: string): Promise<string | null> {
  try {
    const { rows } = await libraryQuery(
      `SELECT actor FROM library_audit
        WHERE target = $1 AND action IN ('wiki.create', 'wiki.update')
        ORDER BY id DESC LIMIT 1`,
      [slug],
    )
    const actor = (rows[0] as { actor?: unknown } | undefined)?.actor
    return typeof actor === 'string' && actor ? actor : null
  } catch {
    return null
  }
}

router.get('/api/wiki/:slug', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const page = await getWikiPage(req.params.slug)
    if (!page) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const updatedAt = await wikiUpdatedAt(req.params.slug)
    res.json({ ...page, ...(updatedAt ? { updatedAt } : {}) })
  } catch (err: any) {
    console.error('[wiki] read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/api/wiki/:slug', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const slug = req.params.slug
    if (!WIKI_SLUG.test(slug)) {
      res.status(400).json({
        error: 'slug must be lowercase letters, numbers, and hyphens (max 80 chars)',
      })
      return
    }
    if (typeof req.body !== 'string') {
      res.status(400).json({ error: 'send the page as raw text/markdown, not JSON' })
      return
    }
    const markdown = req.body
    if (!markdown.trim()) {
      res.status(400).json({ error: 'the page body is required' })
      return
    }

    // The client echoes the exact ISO `updatedAt` it loaded, so an exact
    // "the row is newer than what you read" comparison is right. An absent
    // or unparseable header means "no baseline" — save without the guard.
    const since = Date.parse(req.get('If-Unmodified-Since') ?? '')
    if (!Number.isNaN(since)) {
      const current = await wikiUpdatedAt(slug)
      const currentMs = current ? Date.parse(current) : NaN
      if (!Number.isNaN(currentMs) && currentMs > since) {
        const actor = await lastWikiEditor(slug)
        res.status(412).json({
          error: 'this page changed while you were editing',
          updatedAt: current,
          ...(actor ? { actor } : {}),
        })
        return
      }
    }

    const result = await upsertWikiPage(slug, markdown)
    if (result.error === 'slug-taken') {
      res.status(409).json({ error: 'this slug is taken by a non-wiki catalog entry' })
      return
    }
    const user = res.locals.internalUser
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: result.created ? 'wiki.create' : 'wiki.update',
      target: slug,
      detail: { title: result.title, bytes: Buffer.byteLength(markdown) },
    })
    // The new baseline goes back with the response so the editor can stay
    // open and save again without conflicting with its own previous save.
    const updatedAt = await wikiUpdatedAt(slug)
    res.status(result.created ? 201 : 200).json({
      slug: result.slug,
      title: result.title,
      created: result.created,
      ...(updatedAt ? { updatedAt } : {}),
    })
  } catch (err: any) {
    console.error('[wiki] write failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// body-parser's over-limit rejection surfaces here (router-scoped) so the
// client gets a JSON 413 naming the limit instead of the generic handler.
router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'wiki pages are limited to 1 MB of markdown' })
    return
  }
  next(err)
})

export default router
