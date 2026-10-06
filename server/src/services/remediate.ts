/**
 * Remediation: fill what is fillable, and flag what a model wrote (P6-34).
 *
 * This inverts P6-8's propose-then-accept, and it is the right call here for a
 * reason the codebase already demonstrates: `coverage` (P6-19) and `shape`
 * (P6-2) are *already* applied by default. They are derived at every reindex
 * and written without anyone being asked, and a hand-written manifest value
 * overrides them. Nobody has ever proposed a shape. So apply-then-verify is
 * not a new posture — it is the posture two of the five fields already have,
 * and the proposal flow is the exception.
 *
 * The practical argument is stronger still: **absent metadata is invisible
 * metadata.** An entry with no topic cannot be found by the topic facet,
 * cannot be narrowed to by Chat, and does not appear in a working set scoped
 * by subject. A machine-written topic that is mostly right makes eleven of
 * twelve entries findable *and leaves the twelfth visibly wrong where somebody
 * can fix it*. A proposal nobody got round to accepting leaves all twelve
 * invisible.
 *
 * ## What runs where
 *
 * - **Derived** (coverage, shape, organization) runs inside the index walk —
 *   `applyOrganization` and `applyShapeAndCoverage` in `libraryCatalog.ts`,
 *   unchanged by this ticket. Nothing here re-does it; this module only
 *   REPORTS what derivation answered, so a run can say so.
 * - **Inferred** (topic, and P7-7's `whatItAnswers`) runs here, through the
 *   existing annotation pass, and is the only half that writes a manifest. It
 *   has two more doors: a document drop applies as soon as it is read, and a
 *   dropped LINK applies what the page-reading pass already read, because that
 *   pass had the page and a later re-read would only have the manifest.
 *
 * ## One model call, two postures
 *
 * `annotateEntry` already answers seven questions in one metered call. The
 * topic is APPLIED (with its evidence sentence, and queued for verification);
 * everything else in the same answer is stored as the entry's suggestion and
 * still waits to be accepted. That is deliberate: a wrong topic is a bad
 * filter, a wrong summary is a false statement in the library's own voice, so
 * P5-83's "Look again" keeps its posture until Nick says otherwise (P6-34
 * records that as an open question, not a decision).
 */
import { annotateEntry, isAnnotateError, type Annotation, type AnnotateOutcome } from './annotateEntry.js'
import type { Pages } from './suggestFiling.js'
import { hasApiKey } from './assistantCall.js'
import { patchEntryManifest } from './entryManifest.js'
import { parseInspection, type Inspection } from './linkInspect.js'
import { clearKbIndex, sourceBlockText } from './kbSearch.js'
import { normalizeDataDate } from './dataDates.js'
import { getCatalogEntry, onReindex, searchCatalog, type CatalogEntryRow } from './libraryCatalog.js'
import {
  FIELD_RULES,
  INFERRED_FIELDS,
  fieldAppliesTo,
  fieldRule,
  fieldValueOf,
  mechanismOf,
  withFieldValue,
  withProvenance,
  type FieldProvenance,
  type Mechanism,
  type RemediableField,
} from './provenance.js'

/**
 * What a mechanism answered, as little of it as applying needs.
 *
 * Narrower than `Annotation` on purpose (P7-7): the document pass answers
 * seven questions about a file, the page-reading pass answers a different set
 * about a URL, and both end at the same two or three fields remediation may
 * APPLY. Typing the apply path to the answer rather than to one of its
 * producers is what lets the link door reuse it instead of faking an
 * annotation — and `Annotation` is assignable to this, so nothing changed for
 * the document door.
 */
export interface InferredAnswer {
  /** ISO, when the mechanism ran — it becomes the provenance record's `at`. */
  at: string
  /** Field name -> the sentence the claim was read from (P5-61). */
  evidence?: Record<string, string>
  topic?: string
  whatItAnswers?: string
  /** P7-10: the two dates a publisher STATES rather than we compute. `fetched`
   *  is not here and cannot be: we wrote it, so it is derived, and a model
   *  telling us when we downloaded something would be a guess about our own
   *  records. */
  covers?: string
  published?: string
  /** In the field table with no mechanism (P5-83's carve-out), so this is
   *  never read today. Here so that flipping that one array is the whole
   *  change if Nick ever decides it. */
  summary?: string
}

/** One field, after a run. */
export interface RemediatedField {
  field: RemediableField
  value: string
  mechanism: Mechanism
  evidence?: string
  /** True when THIS run wrote it, false when it was already there. */
  written: boolean
}

export interface RemediationResult {
  slug: string
  /** What the run (or an earlier derivation) could answer. */
  filled: RemediatedField[]
  /** Fields nothing could fill — the entry stays on the needs-a-look list. */
  unfilled: RemediableField[]
  /**
   * Why the inferred half did not run, in words a person can act on. The
   * derived half is never affected: it ran at index time and its answers are
   * in `filled` regardless.
   */
  note?: string
}

/** How many entries one automatic pass will read. A library of 83 has a dozen
 *  gaps; a library of twelve hundred is the risk P6-34 names out loud, and a
 *  cap is the cheap half of watching the ratio. */
export function remediateBatchMax(): number {
  const raw = Number(process.env.LIBRARY_REMEDIATE_MAX)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25
}

/**
 * Is the inferred half switched on? Default yes — "remediation runs by
 * default" is the whole point of the ticket. `LIBRARY_REMEDIATE=0` keeps only
 * the derived half, which is P6-34's own recorded fallback for the day the
 * verification queue grows faster than it drains: it costs nothing and is
 * always correct.
 */
export function inferredRemediationEnabled(): boolean {
  return process.env.LIBRARY_REMEDIATE !== '0'
}

export interface RemediateOptions {
  /** Tests pass a stub annotation; nothing else passes anything. */
  annotate?: (slug: string, entry: CatalogEntryRow) => Promise<AnnotateOutcome | null>
  entry?: CatalogEntryRow
  clientIp?: string
  /** Who to credit a value to when a person is driving. Absent for the
   *  automatic pass — nobody is. */
  actor?: string
}

/** Which inferred fields this entry is still missing — kind-gated, so a wiki
 *  page is never asked for a topic it does not carry. */
function missingInferredFields(row: CatalogEntryRow): RemediableField[] {
  return INFERRED_FIELDS.filter(field => fieldAppliesTo(row.kind, field) && !fieldValueOf(row, field))
}

/** What derivation (and anybody's earlier edit) has already answered. */
function alreadyFilled(row: CatalogEntryRow): RemediatedField[] {
  const out: RemediatedField[] = []
  for (const rule of FIELD_RULES) {
    const value = fieldValueOf(row, rule.field)
    if (!value) continue
    const mechanism = mechanismOf(row, rule.field)
    if (!mechanism) continue
    out.push({ field: rule.field, value, mechanism, written: false })
  }
  return out
}

/**
 * Fill one entry's gaps.
 *
 * Returns null when there is no such entry. Never throws: a remediation run
 * over the whole library must not be stopped by one unreadable file, exactly
 * as a reindex is not.
 */
export async function remediateEntry(slug: string, options: RemediateOptions = {}): Promise<RemediationResult | null> {
  const row = options.entry ?? (await getCatalogEntry(slug))
  if (!row) return null

  const filled = alreadyFilled(row)
  // `unfilled` is the run's own report — the INFERRED gaps it could not close.
  // What belongs on the attention row is a separate question, answered by the
  // per-field predicates in `attentionMatches`, which are kind-gated and (for
  // the summary) not about emptiness at all.
  let missing = missingInferredFields(row)

  // P7-7: before spending a call, the page-reading pass may already have
  // answered — and from the PAGE, which is better material than the manifest
  // a re-read would get. This is the path a dropped LINK takes: at inspection
  // time it is `incoming`, a kind this field is never asked of, so the reading
  // waits on the manifest until the entry becomes a source and then lands here
  // for free.
  const fromPage = (await applyInferredFromStoredInspection(row)) ?? []
  if (fromPage.length) {
    filled.push(...fromPage)
    missing = missing.filter(field => !fromPage.some(f => f.field === field))
  }
  const unfilled = missing

  if (!missing.length) return { slug, filled, unfilled }
  if (!inferredRemediationEnabled()) {
    return { slug, filled, unfilled, note: 'the model pass is switched off — only the derived fields were filled' }
  }
  if (!options.annotate && !hasApiKey()) {
    return { slug, filled, unfilled, note: 'the model was unavailable — only the derived fields were filled' }
  }

  const outcome = await runAnnotation(slug, row, options)
  if (!outcome) {
    return { slug, filled, unfilled, note: 'there was nothing readable to read — only the derived fields were filled' }
  }
  if (isAnnotateError(outcome)) {
    // Two different failures that used to read the same, which is why a zero
    // run was illegible: the call did not happen (`reason` is the assistant's
    // own code — no key, refused, rate-limited) versus the call happened and
    // came back with nothing we could use. The second is usually the answer
    // overrunning `annotateMaxTokens()` mid-JSON, so `jsonObjectIn` gets
    // invalid JSON and `parseAnnotation` returns null — P5-62's lesson, that
    // a model does not know about our caps and writes what it likes.
    return {
      slug,
      filled,
      unfilled,
      note: outcome.reason
        ? `the model could not be asked (${outcome.reason}) — only the derived fields were filled`
        : 'the model answered with nothing we could use — only the derived fields were filled',
    }
  }

  // The rest of the same answer stays a PROPOSAL, in the one field every
  // surface already reads for "suggested, not applied" — EXCEPT where the
  // answer was read off the entry's own filing (P7-7). The applied half still
  // applies; only the echo is dropped.
  const applied = await applyInferredValues(slug, outcome, { ...(readsItsOwnFiling(row) ? {} : { alsoSuggest: outcome }) })
  if (applied === null) return { slug, filled, unfilled, note: 'the entry has no manifest to write to' }

  const appliedFields = new Set(applied.map(f => f.field))
  return {
    slug,
    filled: [...filled, ...applied],
    unfilled: unfilled.filter(field => !appliedFields.has(field)),
    ...(applied.length ? {} : { note: 'the model read it and had nothing to say about the gaps' }),
  }
}

/**
 * Apply the inferred half of one annotation — the topic — and record how it
 * got there.
 *
 * Called both by `remediateEntry` (the library-wide pass) and straight from
 * the ingest annotation job, so a dropped document is remediated the moment it
 * is read rather than waiting for the next reindex.
 *
 * Only ever fills a field that is EMPTY. That is where "derivation still beats
 * the model" is enforced: a derived answer is a value, a value is not empty,
 * and so the model never overwrites one. A person's value is equally safe.
 *
 * Null when the entry has no manifest to write to; [] when the model had
 * nothing to say about the gaps.
 */
export async function applyInferredValues(
  slug: string,
  annotation: InferredAnswer,
  options: { alsoSuggest?: Annotation } = {},
): Promise<RemediatedField[] | null> {
  const applied: RemediatedField[] = []
  const stored = await patchEntryManifest(slug, (meta, entry) => {
    let next = { ...meta }
    for (const field of INFERRED_FIELDS) {
      if (!fieldAppliesTo((entry as CatalogEntryRow).kind, field)) continue
      if (fieldValueOf(entry, field)) continue
      const value = valueFromAnnotation(annotation, field)
      if (!value) continue
      const written = withFieldValue(next, field, value)
      const record: FieldProvenance = {
        mechanism: 'model',
        at: annotation.at,
        value,
        ...(annotation.evidence?.[field] ? { evidence: annotation.evidence[field] } : {}),
        ...(written.via ? { via: written.via } : {}),
      }
      next = withProvenance(written.meta, field, record)
      applied.push({ field, value, mechanism: 'model', written: true, ...(record.evidence ? { evidence: record.evidence } : {}) })
    }
    if (options.alsoSuggest) next = { ...next, suggested: options.alsoSuggest }
    return next
  })
  if (!stored) return null
  // Ask reads a cached index otherwise rebuilt only at reindex, and a topic
  // written this minute has to be findable this minute (P5-47's rule).
  if (applied.length) clearKbIndex()
  return applied
}

/** The document drop's half: the drop has already stored the suggestion, so
 *  this only applies what remediation applies. */
export async function applyInferredAtDrop(slug: string, annotation: Annotation): Promise<RemediatedField[] | null> {
  return applyInferredValues(slug, annotation)
}

/**
 * The LINK's half (P7-7): apply what the page-reading pass already read.
 *
 * The inspection pass reads a source's page and writes its reading to
 * `meta.inspection.prose` with the sentence each claim came from — so a
 * `whatItAnswers` on a dropped link is already paid for, and asking a model
 * again at the next reindex would spend a second call to learn less (the
 * manifest is not the page). This is the same shape `applyInferredAtDrop` has
 * on the document path: one call right after the pass that read it, through
 * the one apply path, so provenance, the never-overwrite rule and the
 * verification queue are not written twice.
 *
 * Deliberately NOT the topic. `prose.topic` rides to the proposal as the
 * form's category and a person accepts it there; applying it here would quietly
 * change what P6-34 decided for links.
 *
 * Writes nothing for a kind the field is not asked of (an unfiled `incoming`
 * drop is one), because it goes through `applyInferredValues` like everything
 * else. That is not a hole: the reading stays on the manifest in
 * `meta.inspection.prose`, and `applyInferredFromStoredInspection` picks it up
 * the moment the entry is a source — free, and from the same sentence. The one field this applies is the one
 * nothing else can carry.
 */
export async function applyInferredFromInspection(slug: string, inspection: Inspection): Promise<RemediatedField[] | null> {
  const prose = inspection.prose
  const line = prose?.whatItAnswers?.trim()
  // P7-10: the dates ride the same door, and this is the one that matters most
  // for them — a data portal's page is where "Last updated: March 12, 2024"
  // actually appears, and the page read has already been paid for. A date
  // read off the page is also better material than a re-read of the manifest
  // would get, which is the same argument P7-7 made for the answers line.
  const covers = normalizeDataDate(prose?.covers)
  const published = normalizeDataDate(prose?.published)
  if (!line && !covers && !published) return []
  const evidence: Record<string, string> = {}
  for (const field of ['whatItAnswers', 'covers', 'published'] as const) {
    const sentence = prose?.evidence?.[field]
    if (sentence) evidence[field] = sentence
  }
  return applyInferredValues(slug, {
    at: inspection.checkedAt,
    ...(line ? { whatItAnswers: line } : {}),
    ...(covers ? { covers } : {}),
    ...(published ? { published } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
  })
}

/** The same reading, off the entry's own manifest — re-validated on the way in
 *  exactly as it was on the way out (`parseInspection` runs `cleanProse`), so a
 *  hand-edited block is held to the same quotation rule. */
async function applyInferredFromStoredInspection(row: CatalogEntryRow): Promise<RemediatedField[] | null> {
  const inspection = parseInspection(row.meta?.inspection)
  const prose = inspection?.prose
  if (!prose || (!prose.whatItAnswers && !prose.covers && !prose.published)) return []
  return applyInferredFromInspection(row.slug, inspection!)
}

async function runAnnotation(slug: string, row: CatalogEntryRow, options: RemediateOptions): Promise<AnnotateOutcome | null> {
  try {
    if (options.annotate) return await options.annotate(slug, row)
    const own = ownWords(row)
    return await annotateEntry(slug, {
      entry: row,
      ...(options.clientIp ? { clientIp: options.clientIp } : {}),
      ...(own ? { text: own } : {}),
    })
  } catch (err: any) {
    console.warn(`[library] remediation could not read "${slug}": ${err?.message || err}`)
    return null
  }
}

/**
 * Was the model shown the entry's own FILING, rather than a document?
 *
 * A source record has no document: its words are its title, its description,
 * its tags and its source block (see `ownWords`). Reading those and storing
 * the answer as a filing suggestion is circular — forty hand-curated registry
 * entries would each gain a greyed "suggested title" that is their own title,
 * read back to them by a model, and a proposal that proposes what is already
 * there is noise on a page somebody has to scan.
 *
 * A NOTE is not this case even though it is also read from the manifest: a
 * note's body is content a person wrote, and proposing a title and a summary
 * for it is exactly what P5-47 is for.
 */
function readsItsOwnFiling(row: CatalogEntryRow): boolean {
  return row.kind === 'source'
}

/**
 * The entry's own words, when it holds no file anybody can read.
 *
 * Two kinds have nothing for `firstPages` to open and plenty to say:
 *
 * - **A note IS its body** (P6-34, found live): `firstPages` looks for an
 *   extractable FILE and a note has only its `meta.json`, so every note came
 *   back "nothing readable to read" however much it said.
 * - **A source IS its block** (P7-7): a registry source is a POINTER — forty
 *   of them hold no file at all — so `firstPages` returns null for every one,
 *   and `whatItAnswers` would have been a gap on forty entries that nothing
 *   could ever fill. That is the queue-that-never-drains mistake twice over
 *   (P5-59's 47 seeded sources, P6-34's kept place reports), and the material
 *   was there the whole time: the provider, the programme, the field
 *   dictionary with its descriptions, the geography, how it is queried.
 *   `sourceBlockText` already renders exactly that for the search index, so
 *   the model is shown the same words the index is built from rather than a
 *   second rendering that could disagree with it.
 *
 * Null for anything else, which leaves `firstPages` in charge.
 */
export function ownWords(row: CatalogEntryRow): Pages | null {
  if (row.kind === 'note') {
    const body = typeof row.meta?.body === 'string' ? row.meta.body.trim() : ''
    return body ? { file: `${row.slug} (note)`, text: body.slice(0, OWN_WORDS_CHARS) } : null
  }
  if (row.kind !== 'source') return null
  const block = sourceBlockText(row.meta?.source)
  if (!block) return null
  const description = typeof row.meta?.description === 'string' ? row.meta.description.trim() : ''
  const text = [row.title, description, block].filter(Boolean).join('\n\n')
  return { file: `${row.slug} (data source record)`, text: text.slice(0, OWN_WORDS_CHARS) }
}

/** The same window `firstPages` gives a document's first pages. */
const OWN_WORDS_CHARS = 6000

/** The annotation's answer for one remediable field. Only the inferred ones
 *  are read: a model's organization and shape stay in the proposal, because
 *  the derivation already answers both and beats it. */
function valueFromAnnotation(annotation: InferredAnswer, field: RemediableField): string {
  if (field === 'topic') return annotation.topic ?? ''
  if (field === 'whatItAnswers') return annotation.whatItAnswers ?? ''
  if (field === 'covers') return annotation.covers ?? ''
  if (field === 'published') return annotation.published ?? ''
  if (field === 'summary') return annotation.summary ?? ''
  return ''
}

export interface LibraryRemediationResult {
  /** Entries looked at. */
  entries: number
  /** Fields a model wrote — every one of them on the verification queue. */
  applied: number
  /** Entries whose gaps nothing could fill. */
  stillEmpty: number
  /** Honesty lines, deduplicated — what did not happen and why. */
  notes: string[]
  /**
   * The same lines, per entry and undeduplicated.
   *
   * `notes` is what the log line can carry; this is what somebody diagnosing a
   * zero run actually needs. A deduplicated list told us "the model could not
   * be asked" and not WHICH of seven entries, which cost a round of guessing —
   * so the route answers with both.
   */
  declined: { slug: string; note: string }[]
}

/**
 * What a run actually did, in one line.
 *
 * Its own function because the hook got this wrong in the way that matters:
 * it claimed "every one of them is on the verification queue" whatever the
 * result, so a run that applied NOTHING announced a queue that had not gained
 * a row — and it threw `notes` away, which was the only thing that could have
 * explained the zero. A log line nobody can act on is worse than no log line,
 * because it reads like success.
 */
export function remediationSummary(result: LibraryRemediationResult): string {
  if (!result.entries) return 'remediation: nothing to fill'
  const entries = `${result.entries} ${result.entries === 1 ? 'entry' : 'entries'}`
  const head = result.applied
    ? `remediation: applied ${result.applied} ${result.applied === 1 ? 'value' : 'values'} across ${entries} — ` +
      `${result.applied === 1 ? 'it is' : 'they are'} on the verification queue`
    : `remediation: read ${entries} and applied nothing — the verification queue is unchanged`
  const still = result.stillEmpty ? `; ${result.stillEmpty} still empty` : ''
  const why = result.notes.length ? ` (${result.notes.join('; ')})` : ''
  return `${head}${still}${why}`
}

/**
 * Fill the library's inferred gaps, capped.
 *
 * Serial on purpose: the pass is metered per call and the budget is a daily
 * one, so twenty-five entries at once is a spend worth doing one at a time
 * where a failure stops the rest cheaply.
 */
export async function remediateLibrary(options: RemediateOptions & { limit?: number } = {}): Promise<LibraryRemediationResult> {
  const limit = options.limit ?? remediateBatchMax()
  // The gaps this pass fills, asked of the server's OWN predicates so the run
  // and P6-33's row are the same set. One query per inferred field rather than
  // the hardcoded `uncategorised` it was: P7-7 adds a second inferred field
  // with its own queue, and a pass that still asked only about topics would
  // never visit the forty sources missing an answers line. Reading the table
  // rather than a second list of keys means the next inferred field is found
  // by adding its rule and nothing else.
  const queues = INFERRED_FIELDS.map(field => fieldRule(field)?.missingKey).filter((key): key is string => !!key)
  const seen = new Set<string>()
  const rows: CatalogEntryRow[] = []
  for (const queue of queues) {
    for (const row of await searchCatalog({ attention: queue }).catch(() => [] as CatalogEntryRow[])) {
      if (seen.has(row.slug)) continue
      seen.add(row.slug)
      rows.push(row)
    }
  }
  const candidates = rows.filter(row => row.status !== 'archived' && missingInferredFields(row).length > 0).slice(0, limit)

  const result: LibraryRemediationResult = { entries: 0, applied: 0, stillEmpty: 0, notes: [], declined: [] }
  for (const row of candidates) {
    const one = await remediateEntry(row.slug, { ...options, entry: row })
    if (!one) continue
    result.entries += 1
    result.applied += one.filled.filter(f => f.written).length
    if (one.unfilled.length) result.stillEmpty += 1
    if (one.note) {
      result.declined.push({ slug: row.slug, note: one.note })
      if (!result.notes.includes(one.note)) result.notes.push(one.note)
    }
  }
  return result
}

let hookInstalled = false

/**
 * Run remediation after every reindex — "remediation runs on ingest and at
 * reindex" (P6-34).
 *
 * Fire-and-forget, like the extraction hook next door and for the same two
 * reasons: a reindex is a request somebody is waiting on, and `library push`
 * must stay a file-transfer command rather than a job that reads every
 * document in the library on somebody's laptop. Capped at
 * `LIBRARY_REMEDIATE_MAX` entries per run, skipped entirely with no API key,
 * and switched off by `LIBRARY_REMEDIATE=0` — which is P6-34's own recorded
 * fallback: keep the derived half, which costs nothing and is always correct.
 *
 * Idempotent, and idempotent in the useful sense too: a field with a
 * provenance record is no longer a gap, so the second run after the first
 * reads nothing and spends nothing.
 */
export function installRemediationHook(): void {
  if (hookInstalled) return
  hookInstalled = true
  onReindex(() => {
    // Under a test runner, a step with no injected seam does nothing at all —
    // `linkFetchQueue.seamMissing`'s rule, and for its reason: every suite
    // that reindexes would otherwise start an Anthropic call, and a test must
    // never reach the network. Suites that exercise this path call
    // `remediateLibrary` with their own `annotate`.
    if (process.env.VITEST) return
    if (!inferredRemediationEnabled() || !hasApiKey()) return
    void remediateLibrary()
      .then(result => {
        if (!result.entries) return
        console.warn(`[library] ${remediationSummary(result)}`)
      })
      .catch(err => console.warn(`[library] remediation failed: ${err?.message || err}`))
  })
}
