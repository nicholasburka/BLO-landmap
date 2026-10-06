import { Router } from 'express'
import { requireInternalUser, requireAdmin } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled } from '../services/libraryBucket.js'
import { getCatalogEntry } from '../services/libraryCatalog.js'
import { inspectUrl, parseInspection, inspectionSummary, type Inspection } from '../services/linkInspect.js'
import { writeInspection, writeIngestPlan } from '../services/entryManifest.js'
import { proposeSource } from '../services/sourceProposal.js'
import { applyInferredFromInspection } from '../services/remediate.js'
import {
  INGEST_PLANS,
  INGEST_MODES,
  parseIngestPlan,
  proposeIngestPlan,
  type IngestPlan,
  type IngestPlanName,
  type IngestMode,
} from '../services/ingestPlan.js'
import { queueReplicate } from '../services/linkFetchQueue.js'
import { pullDocuments } from '../services/documentPull.js'
import type { Suggestion } from '../services/suggestFiling.js'

/**
 * Working out what a dropped link is, and deciding how it comes in (P5-59).
 *
 * Three verbs with three different audiences, so three different guards:
 *  - INSPECT is research. Any internal user may re-run it; it reaches the
 *    outside world, so it carries the per-user limiter on top of the session.
 *  - PLAN is a decision about our work. Admin only — the entry's plan is the
 *    thing the "to ingest" queue is built on, and it is Nick's call.
 *  - REPLICATE spends real bandwidth and disk. Admin only, limited, and queued
 *    through the P5-47 queue so no request ever waits for it.
 *
 * Session and CSRF come from `requireInternalUser` / `requireAdmin`; the guards
 * are per route rather than a `router.use`, so nothing here resolves a session
 * twice and nothing is admin-gated by accident.
 */
const router = Router()

function unavailable(res: any): boolean {
  if (isLibraryEnabled() && isBucketEnabled()) return false
  res.status(503).json({ error: 'library unavailable' })
  return true
}

/** The P5-47 filing suggestion already on the entry, when it worked. */
function suggestionOf(meta: Record<string, unknown>): Suggestion | null {
  const raw = meta.suggested
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const suggested = raw as Record<string, unknown>
  if (suggested.error) return null
  return suggested as unknown as Suggestion
}

/** Everything the entry page needs to offer "Register as a data source". */
function proposalFor(meta: Record<string, unknown>, inspection: Inspection) {
  const proposal = proposeSource(inspection, suggestionOf(meta))
  return {
    inspection,
    summary: inspectionSummary(inspection),
    proposal,
    suggestedPlan: proposeIngestPlan(inspection),
  }
}

/**
 * Look at this link again.
 *
 * Runs on the request rather than the queue: the person pressed a button and
 * is waiting for the answer, and a probe is bounded by INSPECT_TIMEOUT_MS.
 */
router.post('/api/library/catalog/:slug/inspect', requireInternalUser, internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  const slug = String(req.params.slug)
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  try {
    const entry = await getCatalogEntry(slug)
    if (!entry) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const url = typeof entry.meta.url === 'string' ? entry.meta.url.trim() : ''
    if (!url) {
      res.status(400).json({ error: 'This entry has no link to look at.' })
      return
    }
    // P5-61: `clientIp` bills the link prune to whoever pressed the button,
    // and `label` puts the entry's slug in its log line.
    const inspection = await inspectUrl(url, { clientIp: req.ip, label: slug })
    await writeInspection(slug, inspection)
    // P7-7: the page-reading pass has just said what this data answers, with
    // its evidence sentence. Applied here rather than waiting for the next
    // reindex, for the reason the whole field exists: a source nobody can tell
    // apart by capability is a source a place report runs anyway.
    //
    // This is "Look again" on a registered SOURCE. An unfiled drop is
    // `incoming`, a kind the field is never asked of, so nothing is written
    // then — remediation applies the stored reading once the entry becomes a
    // source, from the same sentence and with no second call.
    await applyInferredFromInspection(slug, inspection)
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.inspect',
      target: slug,
      detail: { url, kind: inspection.kind, confidence: inspection.confidence },
    })
    res.json(proposalFor(entry.meta, inspection))
  } catch (err: any) {
    console.error('[library] inspect failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Pull the documents this page offered into the entry (P5-80).
 *
 * Same guard as INSPECT — any internal user may do it, and it reaches the
 * outside world, so the per-user limiter rides on top of the session. It is
 * research, not a decision about our work: the files land under the entry the
 * person is already looking at, inherit its filing, and no model is asked
 * anything.
 *
 * The urls must be a subset of what the entry's own inspection found on the
 * page. That rule is the whole safety story of this route, and it is enforced
 * in the service rather than here so it cannot be skipped by another caller.
 */
router.post('/api/library/catalog/:slug/documents', requireInternalUser, internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  const slug = String(req.params.slug)
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    const outcome = await pullDocuments(slug, body.urls)
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'entry.pull-documents',
      target: slug,
      detail: {
        asked: outcome.results.length,
        stored: outcome.stored,
        failed: outcome.results.length - outcome.stored,
        bytes: outcome.bytes,
      },
    })
    res.json({ results: outcome.results })
  } catch (err: any) {
    console.error('[library] pulling documents failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * The source block we would propose from what we already know.
 *
 * A read, computed from the stored inspection — pressing "Register as a data
 * source" must not send another request to the agency.
 */
router.get('/api/library/catalog/:slug/proposal', requireInternalUser, async (req, res) => {
  if (unavailable(res)) return
  try {
    const entry = await getCatalogEntry(String(req.params.slug))
    if (!entry) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const inspection = parseInspection(entry.meta.inspection)
    if (!inspection) {
      res.status(409).json({ error: 'This link has not been looked at yet. Press "Inspect this link" first.' })
      return
    }
    res.json(proposalFor(entry.meta, inspection))
  } catch (err: any) {
    console.error('[library] proposal failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Record how this comes in. Admin only: it is a decision about our work. */
router.post('/api/library/catalog/:slug/plan', requireAdmin, async (req, res) => {
  if (unavailable(res)) return
  const slug = String(req.params.slug)
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  const body = (req.body ?? {}) as Record<string, unknown>
  const plan = INGEST_PLANS.find(p => p === body.plan) as IngestPlanName | undefined
  if (!plan) {
    res.status(400).json({ error: `plan must be one of: ${INGEST_PLANS.join(', ')}` })
    return
  }
  const mode = INGEST_MODES.find(m => m === body.mode) as IngestMode | undefined
  try {
    const entry = await getCatalogEntry(slug)
    if (!entry) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const existing = parseIngestPlan(entry.meta.ingest)
    const ingest: IngestPlan = {
      plan,
      ...(mode ? { mode } : {}),
      ...(typeof body.owner === 'string' && body.owner.trim() ? { owner: body.owner.trim() } : {}),
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      decidedBy: user?.username ?? 'unknown',
      decidedAt: new Date().toISOString(),
      // Changing the plan does not un-copy anything that already arrived.
      ...(existing?.done ? { done: existing.done } : {}),
    }
    const meta = await writeIngestPlan(slug, ingest)
    if (!meta) {
      res.status(404).json({ error: 'not found' })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.plan',
      target: slug,
      detail: { plan, ...(mode ? { mode } : {}), ...(existing ? { from: existing.plan } : {}) },
    })
    res.json({ ingest })
  } catch (err: any) {
    console.error('[library] plan failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Copy the whole thing in. Queued: it can take minutes. */
router.post('/api/library/catalog/:slug/replicate', requireAdmin, internalRateLimit, async (req, res) => {
  if (unavailable(res)) return
  const slug = String(req.params.slug)
  const user = res.locals.internalUser as { id: number; username: string } | undefined
  try {
    const entry = await getCatalogEntry(slug)
    if (!entry) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const queued = queueReplicate({
      slug,
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      clientIp: req.ip,
    })
    if (queued === 'full') {
      res.status(503).json({ error: 'The copy queue is busy right now — try again in a few minutes.' })
      return
    }
    // 202: the answer is "it started", and the entry is where the result
    // appears. Nothing about a copy of a national dataset fits in a response.
    res.status(202).json({ replicate: 'queued' })
  } catch (err: any) {
    console.error('[library] replicate failed to queue:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
