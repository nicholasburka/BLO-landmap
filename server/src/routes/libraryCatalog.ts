import { Router } from 'express'
import { requireInternalUser } from '../middleware/requireInternalUser.js'
import { internalRateLimit } from '../middleware/internalRateLimit.js'
import { privateNoCache } from '../middleware/privateCache.js'
import { isLibraryEnabled, writeAudit } from '../services/libraryDb.js'
import { isBucketEnabled, syncMirror } from '../services/libraryBucket.js'
import {
  reindexCatalog,
  searchCatalog,
  searchCatalogPage,
  CATALOG_SORTS,
  type CatalogSort,
  getCatalogEntry,
  fileIncomingEntry,
  createNoteEntry,
  updateNoteEntry,
  NOTE_STATUSES,
} from '../services/libraryCatalog.js'
import { parseSourceMeta } from '../services/sourceMeta.js'
import { isOrganizationId } from '../services/organizations.js'
import { isShape, SHAPE_IDS } from '../services/taxonomy.js'
import { clearTabularCache } from '../services/libraryTabular.js'
import { patchEntryManifest } from '../services/entryManifest.js'
import { clearKbIndex } from '../services/kbSearch.js'
import { dailyBudgetMiddleware } from '../middleware/budget.js'
import { installRemediationHook, remediateBatchMax, remediateLibrary } from '../services/remediate.js'
import {
  REMEDIABLE_FIELDS,
  WHAT_IT_ANSWERS_MAX_CHARS,
  isRemediableField,
  provenanceOf,
  provenanceReport,
  withFieldValue,
  withProvenance,
  withVerification,
  withoutFieldValue,
} from '../services/provenance.js'
import { isDateField, normalizeDataDate } from '../services/dataDates.js'

/** P6-34's three answers to "a model wrote this". */
export const VERIFY_ACTIONS = ['keep', 'edit', 'clear'] as const
export type VerifyAction = (typeof VERIFY_ACTIONS)[number]

/**
 * Catalog read API (P5-8). Everything here is internal-tier: the guard runs
 * before any handler, so unauthenticated requests get the same bare 401 as
 * every other /api/library/* route (auth-sweep enforced).
 */

/** P6-8a: `organization` (a publisher id) and `shape` (one of SHAPE_IDS) as a
 *  filing form sends them. '' clears the field so a reindex derives it again;
 *  a value the vocabulary does not know is refused with a readable reason. */
export function parseVocabularyFields(
  body: Record<string, unknown>,
): { fields: { organization?: string; shape?: string } } | { error: string } {
  const fields: { organization?: string; shape?: string } = {}
  if (body.organization !== undefined && body.organization !== null) {
    if (typeof body.organization !== 'string') return { error: 'organization must be a publisher id' }
    const id = body.organization.trim()
    if (id && !isOrganizationId(id)) return { error: `organization must be one of the library's publishers, not "${id}"` }
    fields.organization = id
  }
  if (body.shape !== undefined && body.shape !== null) {
    if (typeof body.shape !== 'string') return { error: `shape must be one of: ${SHAPE_IDS.join(', ')}` }
    const id = body.shape.trim()
    if (id && !isShape(id)) return { error: `shape must be one of: ${SHAPE_IDS.join(', ')}, not "${id}"` }
    fields.shape = id
  }
  return { fields }
}

const router = Router()
router.use('/api/library', requireInternalUser)

// P6-34: remediation follows every reindex. Installed here, where the reindex
// route lives, so the CLI's own `reindexCatalog()` is not dragged into it.
installRemediationHook()

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

router.get('/api/library/catalog', privateNoCache, async (req, res) => {
  if (!isLibraryEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  // P5-64: the only enumerated filter on this route, so the one that can be
  // typed wrong. A bad word is a 400 rather than a silent fall back to the
  // default order, which would look like the sort had been ignored.
  const sort = firstString(req.query.sort)
  if (sort && !(CATALOG_SORTS as readonly string[]).includes(sort)) {
    res.status(400).json({ error: `sort must be one of: ${CATALOG_SORTS.join(', ')}` })
    return
  }
  try {
    const { entries, archivedCount } = await searchCatalogPage({
      q: firstString(req.query.q),
      sort: sort as CatalogSort | undefined,
      // P5-63: the topic facet and the purpose filter. `category` stays as an
      // incoming alias so every link written before this ticket still opens
      // the same list.
      topic: firstString(req.query.topic),
      purpose: firstString(req.query.purpose),
      category: firstString(req.query.category),
      // P6-1/P6-2: who published it, and what kind of thing it is. Free
      // strings rather than enums — an unknown publisher's group is headed
      // with its own text, and that text is what a link back to it carries.
      organization: firstString(req.query.organization),
      shape: firstString(req.query.shape),
      // P6-19: where it applies. `coverage` takes a scope, a state or `none`
      // (the Coverage chip row is one row, so it is one key); `state` is the
      // explicit form the chat and MCP ask with.
      coverage: firstString(req.query.coverage),
      state: firstString(req.query.state),
      status: firstString(req.query.status),
      kind: firstString(req.query.kind),
      tag: firstString(req.query.tag),
      plan: firstString(req.query.plan),
      attention: firstString(req.query.attention),
      includeArchived: firstString(req.query.archived) === '1',
      // P5-88: rows carry the list projection of their manifest unless the
      // caller asks for the whole thing. Same data either way — `?full=1` is
      // the bulk version of what GET /catalog/:slug already returns.
      full: firstString(req.query.full) === '1',
      // P6-5a: who is asking. The only thing it changes is the to-file queue,
      // which belongs to whoever dropped it (and to admins). The guard above
      // has already run, so this is always a real user.
      viewer: (res.locals.internalUser as { username: string; role: string } | undefined) ?? null,
    })
    res.json({ entries, archivedCount })
  } catch (err: any) {
    console.error('[library] catalog search failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// The explicit param type is what the router needs to keep `:slug` a string
// once a middleware sits between the path and the handler (same shape as
// routes/layers.ts).
router.get<{ slug: string }>('/api/library/catalog/:slug', privateNoCache, async (req, res) => {
  if (!isLibraryEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const entry = await getCatalogEntry(req.params.slug)
    if (!entry) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ entry })
  } catch (err: any) {
    console.error('[library] catalog read failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function cleanTags(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((t): t is string => typeof t === 'string').map(t => t.trim()).filter(Boolean)
    : undefined
}

// Create a text-only entry — "New idea" and friends (P5-12, Example 7).
router.post('/api/library/entries', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const text = typeof body.body === 'string' ? body.body.trim() : ''
    if (!title) {
      res.status(400).json({ error: 'a title is required' })
      return
    }
    if (!text) {
      res.status(400).json({ error: 'a body is required — write at least a sentence' })
      return
    }
    const category =
      (typeof body.category === 'string' ? body.category.trim() : '') || 'ideas'
    const user = res.locals.internalUser
    const result = await createNoteEntry({
      title,
      body: text,
      category,
      tags: cleanTags(body.tags) ?? [],
      createdBy: user?.username ?? 'unknown',
      createdById: user?.id ?? null,
    })
    if (result.error === 'bad-title') {
      res.status(400).json({ error: 'the title must contain at least one letter or number' })
      return
    }
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.note',
      target: result.entry.slug,
      detail: { title: result.entry.title, category: result.entry.category },
    })
    res.status(201).json({ entry: result.entry })
  } catch (err: any) {
    console.error('[library] note create failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Edit a catalog entry. Dispatches on kind: incoming entries get filed from
// the needs-cataloging queue (P5-11, Example 5); notes get edited in place
// (P5-12); a source is re-filed in place so its block can be filled in later
// (P5-56). Other file-backed kinds are read-only here.
router.patch('/api/library/catalog/:slug', async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    const existing = await getCatalogEntry(req.params.slug)
    if (!existing) {
      res.status(404).json({ error: 'not found' })
      return
    }
    if (existing.kind !== 'incoming' && existing.kind !== 'note' && existing.kind !== 'source') {
      res.status(409).json({ error: 'only incoming entries, sources and notes can be edited here' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const common = {
      title: typeof body.title === 'string' ? body.title.trim() : undefined,
      category: typeof body.category === 'string' ? body.category.trim() : undefined,
      tags: cleanTags(body.tags),
    }
    // P6-8a: the two vocabulary fields Accept / Edit-and-save carry. A word
    // the vocabulary does not know is a 400, never a manifest value.
    const vocabulary = parseVocabularyFields(body)
    if ('error' in vocabulary) {
      res.status(400).json({ error: vocabulary.error })
      return
    }
    const user = res.locals.internalUser
    let entry
    let action: string

    if (existing.kind === 'incoming' || existing.kind === 'source') {
      // P5-56: "This is a data source" on the filing form. A block without a
      // provider is a 400 — the entry would answer nothing without it.
      const { source, dropped } = parseSourceMeta(body.source)
      if (body.source !== undefined && body.source !== null && !source) {
        res.status(400).json({ error: 'a data source needs a provider — who publishes it', dropped })
        return
      }
      const result = await fileIncomingEntry(req.params.slug, {
        ...common,
        ...vocabulary.fields,
        description: typeof body.description === 'string' ? body.description.trim() : undefined,
        ...(source ? { source } : {}),
      })
      if (result.error === 'has-files') {
        res.status(409).json({
          error:
            'this entry has a file attached — a data source points at data we do not hold. File it as a document or a dataset instead.',
        })
        return
      }
      if (result.error) {
        // Raced away between lookup and filing — treat like the lookup miss.
        res.status(404).json({ error: 'not found' })
        return
      }
      void writeAudit({
        userId: user?.id ?? null,
        actor: user?.username ?? 'unknown',
        action: 'library.file',
        target: req.params.slug,
        detail: {
          title: result.entry.title,
          category: result.entry.category,
          // The move from incoming/ to sources/ is the interesting part of
          // this filing — the audit trail says so out loud.
          ...(result.kindChangedTo ? { kindChangedFrom: existing.kind, kindChangedTo: result.kindChangedTo } : {}),
          ...(dropped.length ? { dropped } : {}),
        },
      })
      res.json({ entry: result.entry })
      return
    } else {
      const result = await updateNoteEntry(req.params.slug, {
        ...common,
        body: typeof body.body === 'string' ? body.body.trim() : undefined,
        status: typeof body.status === 'string' ? body.status.trim() : undefined,
      })
      if (result.error === 'bad-status') {
        res.status(400).json({ error: `status must be one of: ${NOTE_STATUSES.join(', ')}` })
        return
      }
      if (result.error) {
        res.status(404).json({ error: 'not found' })
        return
      }
      entry = result.entry
      action = 'library.note.update'
    }

    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action,
      target: req.params.slug,
      detail: { title: entry.title, category: entry.category },
    })
    res.json({ entry })
  } catch (err: any) {
    console.error('[library] entry edit failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/api/library/reindex', internalRateLimit, async (_req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  try {
    // Reindex doubles as the "resync from bucket" action after an external
    // push (dev CLI / rclone): refresh the host mirror first so size-changed
    // files are re-downloaded and deleted files are pruned (P5-13).
    await syncMirror()
    const { indexed, collisions } = await reindexCatalog()
    // Files may have changed behind the running server's back — parsed
    // tables are re-read on the next request (P5-31 dataset explorer).
    clearTabularCache()
    const user = res.locals.internalUser
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'catalog.reindex',
      detail: { indexed, collisions },
    })
    res.json({ indexed, collisions })
  } catch (err: any) {
    console.error('[library] reindex failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * P6-34: Keep / Edit / Clear on one remediated field.
 *
 * The three actions a person takes on the needs-a-look list, and the reason
 * the queue can ever empty:
 *
 * - **keep** — a person looked at a model's value and vouched for it. The
 *   words stay the model's (rewriting the mechanism to `person` would claim
 *   somebody wrote what a model wrote) but the verification is recorded and
 *   the field leaves the queue permanently.
 * - **edit** — a person's own value. Marked `person`, which no mechanism and
 *   no re-derivation can overwrite, and it leaves the queue.
 * - **clear** — the value returns to EMPTY and the entry rejoins the
 *   needs-a-look list. This is the whole point: a rejected value must never
 *   silently stay. `via` on the record says which manifest key carried it,
 *   because a topic rides on `category` or on a tag.
 *
 * Works on any kind, unlike the filing PATCH above: the gaps P6-33 counts are
 * mostly on documents and notes, and a queue nobody can clear from the list it
 * opens is the bug P6-23 was about in a different costume.
 */
router.post<{ slug: string }>('/api/library/catalog/:slug/verify', internalRateLimit, async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const field = typeof body.field === 'string' ? body.field.trim() : ''
  const action = typeof body.action === 'string' ? body.action.trim() : ''
  if (!isRemediableField(field)) {
    res.status(400).json({ error: `field must be one of: ${REMEDIABLE_FIELDS.join(', ')}` })
    return
  }
  if (!VERIFY_ACTIONS.includes(action as VerifyAction)) {
    res.status(400).json({ error: `action must be one of: ${VERIFY_ACTIONS.join(', ')}` })
    return
  }
  let value = typeof body.value === 'string' ? body.value.trim() : ''
  if (action === 'edit' && !value) {
    res.status(400).json({ error: 'edit needs a value — use clear to empty the field' })
    return
  }
  // P7-10: a date is normalised HERE, not after the write, so the provenance
  // record's `value` and the value on the row are the same string. They have
  // to be: `mechanismOf` only believes a record that still matches the value
  // it wrote, so storing a person's "2019–2023" beside a stored "2019/2023"
  // would quietly drop their authorship. Anything the grammar cannot read is
  // refused rather than stored as something a legend would then print.
  if (action === 'edit' && isDateField(field)) {
    const normalised = normalizeDataDate(value)
    if (!normalised) {
      res.status(400).json({
        error: 'a date must be a year, a month or a day — "2024", "2026-10", "2024-03-12" — or two of those for a period, "2019/2023"',
      })
      return
    }
    value = normalised
  }
  // P7-7: the one field with a length of its own, because it is the one field
  // that rides on every LIST row (`LIST_ROW_META_KEYS`) and so on every
  // `search_library` answer. A paragraph here would crowd out the results it
  // is meant to help choose between — P5-88's 214 kB list is what that costs.
  if (field === 'whatItAnswers' && value.length > WHAT_IT_ANSWERS_MAX_CHARS) {
    res.status(400).json({ error: `an answers line is one or two sentences — at most ${WHAT_IT_ANSWERS_MAX_CHARS} characters` })
    return
  }

  try {
    const existing = await getCatalogEntry(req.params.slug)
    if (!existing) {
      res.status(404).json({ error: 'not found' })
      return
    }
    const user = res.locals.internalUser
    const actor = user?.username ?? 'unknown'
    const before = provenanceOf(existing, field)

    if (action === 'keep' && (!before || before.mechanism !== 'model')) {
      // Nothing to vouch for: a derived value is re-derived at every reindex
      // and a person's value is already theirs.
      res.status(409).json({ error: 'there is nothing unverified on this field' })
      return
    }

    const at = new Date().toISOString()
    const next = await patchEntryManifest(req.params.slug, meta => {
      if (action === 'keep') return withVerification(meta, field, actor, at)
      if (action === 'clear') return withoutFieldValue(meta, field, before)
      // A person's own value REPLACES whatever answered before, so the field
      // is emptied first. Without that, editing a topic that rode on the
      // category would add a tag the category still outranks, and the edit
      // would appear to do nothing.
      const written = withFieldValue(withoutFieldValue(meta, field, before), field, value)
      return withProvenance(written.meta, field, {
        mechanism: 'person',
        at,
        value,
        ...(written.via ? { via: written.via } : {}),
        verifiedAt: at,
        verifiedBy: actor,
      })
    })
    if (!next) {
      res.status(409).json({ error: 'this entry has no manifest to write to' })
      return
    }
    // A topic written this minute has to be findable this minute (P5-47).
    clearKbIndex()
    void writeAudit({
      userId: user?.id ?? null,
      actor,
      action: `library.verify.${action}`,
      target: req.params.slug,
      detail: { field, ...(action === 'edit' ? { value } : {}), ...(before?.mechanism ? { was: before.mechanism } : {}) },
    })
    const entry = await getCatalogEntry(req.params.slug)
    res.json({ entry, provenance: entry ? provenanceReport(entry) : {} })
  } catch (err: any) {
    console.error('[library] verify failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * P6-34: run remediation now.
 *
 * Remediation also runs by itself — on ingest, and after every reindex — but
 * the library this lands on already has a dozen gaps that no future ingest
 * will revisit, so there has to be a way to say "go and fill them".
 */
router.post('/api/library/remediate', internalRateLimit, dailyBudgetMiddleware, async (req, res) => {
  if (!isLibraryEnabled() || !isBucketEnabled()) {
    res.status(503).json({ error: 'library unavailable' })
    return
  }
  const user = res.locals.internalUser
  if (user?.role !== 'admin') {
    res.status(403).json({ error: 'admins only' })
    return
  }
  try {
    const raw = Number((req.body ?? {}).limit)
    const result = await remediateLibrary({
      ...(Number.isFinite(raw) && raw > 0 ? { limit: Math.min(Math.floor(raw), remediateBatchMax()) } : {}),
      ...(req.ip ? { clientIp: req.ip } : {}),
    })
    void writeAudit({
      userId: user?.id ?? null,
      actor: user?.username ?? 'unknown',
      action: 'library.remediate',
      detail: { ...result },
    })
    res.json(result)
  } catch (err: any) {
    console.error('[library] remediation failed:', err?.message || err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
