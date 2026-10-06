import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { getCatalogEntry } from '../services/libraryCatalog.js'
import { createLinkEntry } from '../services/libraryLinks.js'
import { queueLinkFetch, writeFetchState, type FetchState } from '../services/linkFetchQueue.js'

/**
 * Link drops (P5-34): teammates find datasets and sources they can't export
 * in the right format — they drop the LINK instead of a file. It lands in
 * the same incoming queue as a quick drop (manifest only, no file), gets
 * filed the same way, and the P5-47 fetch job attaches the download shortly
 * afterwards with the URL recorded as lineage.
 *
 * P5-56: the same form can say "this is a data source" — a dataset we index
 * but do NOT hold. That drop carries a `source` block, is filed under
 * library/sources/<uuid>/ instead of the incoming queue, and needs nothing
 * but a provider; the rest can be filled in later on the entry page.
 *
 * P5-52: the creation itself lives in services/libraryLinks.ts so the MCP
 * `drop_link` tool walks the same path. What stays here is HTTP: the guard,
 * the status codes, the audit row, and the response shape.
 */
const router = Router()
router.use('/api/library', requireInternalUser)

router.post('/api/library/links', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  try {
    const result = await createLinkEntry({
      url: body.url,
      title: body.title,
      note: body.note,
      category: body.category,
      tags: body.tags,
      source: body.source,
      fetch: body.fetch !== false,
      actor: user?.username ?? 'unknown',
      userId: user?.id ?? null,
      clientIp: req.ip,
    })
    if (result.error === 'bad-url') {
      res.status(400).json({ error: 'url must be a public http(s) link' })
      return
    }
    if (result.error === 'bad-source') {
      res.status(400).json({ error: 'a data source needs a provider — who publishes it', dropped: result.dropped })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.link',
      target: result.slug,
      detail: { url: result.url, quickDrop: result.status === 'needs-cataloging', kind: result.kind },
    })
    res.status(201).json({
      slug: result.slug,
      status: result.status,
      kind: result.kind,
      title: result.title,
      fetch: result.fetch,
      ...(result.dropped.length ? { dropped: result.dropped } : {}),
    })
  } catch (err: any) {
    console.error('[library] link drop failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * P5-47: try the fetch again. Reached from the entry page's "Try again" after
 * a failure, and from a link that was dropped while the queue was full. Not a
 * public action and not idempotent work — it spends bandwidth and a model
 * call — so it carries the per-user limiter on top of the session + CSRF gate
 * every /api/library route already has.
 */
router.post('/api/library/catalog/:slug/refetch', internalRateLimit, async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const slug = String(req.params.slug)
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  try {
    const entry = await getCatalogEntry(slug)
    if (!entry || entry.kind !== 'incoming') {
      res.status(404).json({ error: 'not found' })
      return
    }
    if (typeof entry.meta.url !== 'string' || !entry.meta.url) {
      res.status(400).json({ error: 'This entry has no link to fetch.' })
      return
    }
    // Already on its way: say so rather than queue the same download twice.
    const current = entry.meta.fetch as FetchState | undefined
    if (current && (current.status === 'queued' || current.status === 'fetching')) {
      res.json({ fetch: current.status })
      return
    }
    const state = queueLinkFetch({
      slug,
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      clientIp: req.ip,
    })
    await writeFetchState(slug, state)
    res.json({ fetch: state.status })
  } catch (err: any) {
    console.error('[library] refetch failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
