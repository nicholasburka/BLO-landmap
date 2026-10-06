/**
 * Where a value came from (P6-34) — the server half.
 *
 * The client's copy is `src/lib/provenance.ts` and its header carries the
 * reasoning: derived values are applied and never queued, a model's reading of
 * prose is applied AND queued (the topic, and P7-7's `whatItAnswers`), and a
 * person's edit beats both. The server
 * cannot read the client's TypeScript, so the field table is written twice;
 * `provenance.test.ts` reads the client file and fails when the two disagree,
 * the same contract `taxonomy.generated.json` has.
 *
 * This file is also where the records are WRITTEN. It stays a pure data module
 * — `remediate.ts` and the verify route do the bucket I/O through
 * `patchEntryManifest` — so nothing here imports the catalog, and the catalog
 * can import this.
 */
import { shapeFromManifest } from './shape.js'
import { asCoverage, coverageFromManifest, isShapedKind } from './coverage.js'
import { organizationForMeta } from './organizations.js'
import { isShape, isTopicable, topicFor } from './taxonomy.js'
import { datesFromManifest, isDateField, normalizeDataDate, type DataDates, type DateField } from './dataDates.js'

export const MECHANISMS = ['derived', 'model', 'person'] as const
export type Mechanism = (typeof MECHANISMS)[number]

export type RemediableField =
  | 'topic'
  | 'organization'
  | 'coverage'
  | 'shape'
  | 'summary'
  | 'whatItAnswers'
  | 'covers'
  | 'published'
  | 'fetched'

/**
 * P7-7: one or two sentences, not a paragraph.
 *
 * §F.4d asks for "one or two sentences in the manifest, surfaced in
 * `search_library` rows and `get_entry`" — so the cap is set by where it is
 * READ: a dozen of these ride in one search answer a model has to choose
 * from, and a paragraph each would crowd out the results. 240 characters is
 * about two plain sentences.
 */
export const WHAT_IT_ANSWERS_MAX_CHARS = 240

export interface FieldRule {
  field: RemediableField
  label: string
  /** In order — the first mechanism that answers wins, which is where
   *  "derivation still beats the model" lives. */
  mechanisms: readonly Mechanism[]
  /** The `attentionMatches` key that counts this field MISSING. */
  missingKey: string | null
}

/**
 * One row per field — the same five, in the same order, as the client's
 * `FIELD_RULES`.
 *
 * `summary` carries no mechanism on purpose: P5-83's "Look again" keeps
 * proposing a summary and waiting to be accepted, because prose is read as a
 * claim rather than filtered on as a chip. P6-34 records that as Nick's open
 * question and does not pre-empt it.
 */
export const FIELD_RULES: readonly FieldRule[] = [
  { field: 'topic', label: 'Topic', mechanisms: ['model'], missingKey: 'uncategorised' },
  { field: 'organization', label: 'Organization', mechanisms: ['derived'], missingKey: 'no-organization' },
  { field: 'coverage', label: 'Coverage', mechanisms: ['derived'], missingKey: 'no-coverage' },
  { field: 'shape', label: 'Type', mechanisms: ['derived'], missingKey: null },
  { field: 'summary', label: 'Summary', mechanisms: [], missingKey: 'no-summary' },
  { field: 'whatItAnswers', label: 'Answers', mechanisms: ['model'], missingKey: 'no-answers-line' },
  // P7-10: two dates, never one. `covers` is the period the data DESCRIBES and
  // ages into being historical; `published` is when the publisher put it out
  // and ages into being STALE. `covers` is the first field to list both
  // mechanisms, which is what the ordered array was built for — a derived
  // reading never queues, a model's reading of the same field always does.
  { field: 'covers', label: 'Period covered', mechanisms: ['derived', 'model'], missingKey: 'no-period-covered' },
  { field: 'published', label: 'Published', mechanisms: ['model'], missingKey: 'no-published-date' },
  { field: 'fetched', label: 'Fetched', mechanisms: ['derived'], missingKey: null },
]

export const REMEDIABLE_FIELDS: readonly RemediableField[] = FIELD_RULES.map(rule => rule.field)

/** The fields a model may fill — the only ones that can enter the queue. */
export const INFERRED_FIELDS: readonly RemediableField[] = FIELD_RULES.filter(r => r.mechanisms.includes('model')).map(r => r.field)

export function fieldRule(field: string): FieldRule | null {
  return FIELD_RULES.find(rule => rule.field === field) ?? null
}

export function isRemediableField(field: string): field is RemediableField {
  return !!fieldRule(field)
}

/**
 * Is this field a question worth asking of this KIND?
 *
 * The same gates the attention predicates use, and for the same reason: a wiki
 * page IS the knowledge base rather than a category of it, and a note has no
 * publisher and no ground to be missing. Asking anyway would put work on the
 * queue that nobody could clear.
 */
export function fieldAppliesTo(kind: string, field: RemediableField): boolean {
  if (field === 'topic') return isTopicable(kind)
  // P7-7 asks the same of `whatItAnswers` as P6-1 and P6-19 ask of its
  // neighbours: a dataset and a source can answer a question, and a document's
  // "what it answers" is its summary. Asking a wiki page would put a row on
  // the queue nobody could clear.
  // P7-10 joins them: "when is this from?" is a real question about a dataset,
  // a source and a layer, and a category error for a wiki page or a note —
  // both of which have an edit history already (the ticket's own out-of-scope
  // line).
  if (
    field === 'organization' ||
    field === 'coverage' ||
    field === 'shape' ||
    field === 'whatItAnswers' ||
    isDateField(field)
  ) {
    return isShapedKind(kind)
  }
  return true
}

export interface FieldProvenance {
  mechanism: Mechanism
  at?: string
  /** The value the mechanism wrote. A record speaks for THIS value and no
   *  other — see `mechanismOf`. */
  value?: string
  /** For a model reading prose: the sentence the claim came from (P5-61). */
  evidence?: string
  /** Which manifest key carried it. A topic is not a stored field. */
  via?: 'category' | 'tag' | 'field'
  verifiedAt?: string
  verifiedBy?: string
}

export type ProvenanceMap = Partial<Record<string, FieldProvenance>>

/** A row, or a bare manifest, to ask about. Deliberately narrower than
 *  `CatalogEntryRow` so this module stays a leaf. */
export interface ProvenanceRow {
  kind: string
  slug?: string
  category?: string
  tags?: string[]
  meta?: Record<string, unknown> | null
  files?: { key: string }[]
}

export function provenanceMapOf(meta: Record<string, unknown> | undefined | null): ProvenanceMap {
  const raw = meta?.provenance
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ProvenanceMap = {}
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const record = value as FieldProvenance
    if (!(MECHANISMS as readonly string[]).includes(record.mechanism)) continue
    out[field] = record
  }
  return out
}

function fileNames(row: ProvenanceRow): string[] {
  return (row.files ?? []).map(f => f.key.split('/').slice(3).join('/') || f.key)
}

/** What the field says today, as one comparable string. '' means empty. */
export function fieldValueOf(row: ProvenanceRow, field: string): string {
  const meta = row.meta ?? {}
  switch (field) {
    case 'topic':
      return topicFor(row.category ?? '', row.tags ?? []) ?? ''
    case 'organization':
      return organizationForMeta(meta)
    case 'coverage': {
      if (!isShapedKind(row.kind)) return ''
      const raw = meta.coverage
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return asCoverage(raw as Record<string, unknown>)?.label ?? ''
      return coverageFromManifest({ kind: row.kind, meta, files: fileNames(row), slug: row.slug })?.label ?? ''
    }
    case 'shape': {
      if (!isShapedKind(row.kind)) return ''
      const stated = meta.shape
      if (typeof stated === 'string' && isShape(stated)) return stated
      return shapeFromManifest({ kind: row.kind, meta, files: fileNames(row), slug: row.slug }) ?? ''
    }
    case 'summary':
      return typeof meta.description === 'string' ? meta.description.trim() : ''
    case 'whatItAnswers': {
      // P7-7: a plain manifest string — `meta` JSONB, no schema change
      // (§F.4d). Kind-gated here as well as in `fieldAppliesTo`, so a wiki
      // page with a stray key in its manifest cannot answer a question the
      // field was never asked of it.
      if (!isShapedKind(row.kind)) return ''
      return typeof meta.whatItAnswers === 'string' ? meta.whatItAnswers.trim() : ''
    }
    case 'covers':
    case 'published':
    case 'fetched':
      // P7-10. The manifest-only fold, exactly as `coverage` does it above: a
      // stated `dates:` block, the layer block's year, and our own fetch
      // records. A held table's own year column is the one reading that needs
      // the file, so the reindex stores it into `meta.dates` and it arrives
      // here as a stated value.
      return datesFromManifest({ kind: row.kind, meta, files: fileNames(row), slug: row.slug })[field]
    default:
      return ''
  }
}

/**
 * How this field's value got there, or null when there is no value to explain.
 *
 * 1. A stored record whose `value` still matches — its mechanism. This is the
 *    only way `model` is ever reported, so a library no remediation has
 *    touched has an empty verification queue and nothing was backfilled.
 * 2. Otherwise `derived` for a field something derives.
 * 3. Otherwise `person` — the only other way a topic or a summary gets onto an
 *    entry is that somebody wrote it.
 */
export function mechanismOf(row: ProvenanceRow, field: string): Mechanism | null {
  const value = fieldValueOf(row, field)
  if (!value) return null
  const record = provenanceMapOf(row.meta)[field]
  if (record && (record.value === undefined || record.value === value)) return record.mechanism
  return fieldRule(field)?.mechanisms.includes('derived') ? 'derived' : 'person'
}

export function provenanceOf(row: ProvenanceRow, field: string): FieldProvenance | null {
  const mechanism = mechanismOf(row, field)
  if (!mechanism) return null
  const value = fieldValueOf(row, field)
  const record = provenanceMapOf(row.meta)[field]
  if (record && (record.value === undefined || record.value === value)) return record
  return { mechanism, value }
}

/** A model wrote it and nobody has looked — the one state that queues. */
export function isUnverified(row: ProvenanceRow, field: string): boolean {
  const record = provenanceOf(row, field)
  if (!record || record.mechanism !== 'model') return false
  return !record.verifiedAt
}

export function unverifiedFields(row: ProvenanceRow): RemediableField[] {
  return REMEDIABLE_FIELDS.filter(field => isUnverified(row, field))
}

export function hasUnverifiedValue(row: ProvenanceRow): boolean {
  return REMEDIABLE_FIELDS.some(field => isUnverified(row, field))
}

/**
 * The provenance of every field that has a value, for a surface that carries a
 * claim outward — the entry page and MCP `get_entry`. A number quoted in a
 * data story should not silently rest on a model's guess.
 */
export function provenanceReport(row: ProvenanceRow): Record<string, FieldProvenance> {
  const out: Record<string, FieldProvenance> = {}
  for (const field of REMEDIABLE_FIELDS) {
    const record = provenanceOf(row, field)
    if (record) out[field] = record
  }
  return out
}

/* --- writers --------------------------------------------------------------
 * Each takes a manifest and returns the next one. The bucket write and the
 * reindex are the caller's (`patchEntryManifest`), so these stay testable
 * without a bucket.
 */

/** Record how a value got there. Only `model` and `person` are ever stored —
 *  a `derived` record would be a cache of a pure function. */
export function withProvenance(
  meta: Record<string, unknown>,
  field: RemediableField,
  record: FieldProvenance,
): Record<string, unknown> {
  if (record.mechanism === 'derived') return withoutProvenance(meta, field)
  const next = { ...provenanceMapOf(meta), [field]: record }
  return { ...meta, provenance: next }
}

export function withoutProvenance(meta: Record<string, unknown>, field: RemediableField): Record<string, unknown> {
  const map = { ...provenanceMapOf(meta) }
  if (!(field in map)) return meta
  delete map[field]
  if (Object.keys(map).length === 0) {
    const { provenance: _gone, ...rest } = meta
    return rest
  }
  return { ...meta, provenance: map }
}

/**
 * A person looked at a model's value and kept it. The words stay the model's
 * — `mechanism` is not rewritten to `person`, because that would claim
 * somebody wrote what a model wrote — but the vouching is recorded and the
 * field leaves the queue permanently.
 */
export function withVerification(
  meta: Record<string, unknown>,
  field: RemediableField,
  by: string,
  at = new Date().toISOString(),
): Record<string, unknown> {
  const record = provenanceMapOf(meta)[field]
  if (!record) return meta
  return withProvenance(meta, field, { ...record, verifiedAt: at, verifiedBy: by })
}

/**
 * Put a value on the manifest.
 *
 * `topic` is the awkward one and the reason `via` exists: a topic is not a
 * stored field — it is the entry's `category` when that is a topic, otherwise
 * the first of its tags that is one — so writing one means writing `category`
 * when nothing is there and adding a tag when a PURPOSE already holds the
 * category. Clear has to know which it did.
 */
export function withFieldValue(
  meta: Record<string, unknown>,
  field: RemediableField,
  value: string,
): { meta: Record<string, unknown>; via: FieldProvenance['via'] } {
  if (field === 'topic') {
    const category = typeof meta.category === 'string' ? meta.category.trim() : ''
    if (!category) return { meta: { ...meta, category: value }, via: 'category' }
    const tags = Array.isArray(meta.tags) ? (meta.tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
    if (tags.includes(value)) return { meta, via: 'tag' }
    return { meta: { ...meta, tags: [...tags, value] }, via: 'tag' }
  }
  if (field === 'summary') return { meta: { ...meta, description: value }, via: 'field' }
  if (isDateField(field)) {
    // P7-10: three keys in ONE block, so a manifest reads `dates: { covers,
    // published }` rather than growing three loose top-level keys. Normalised
    // on the way in — the stored grammar is the sortable one, and the source's
    // own spelling rides in the evidence sentence instead.
    return { meta: { ...meta, dates: { ...datesBlock(meta), [field]: normalizeDataDate(value) } }, via: 'field' }
  }
  return { meta: { ...meta, [field]: value }, via: 'field' }
}

/**
 * Take a value back off the manifest, so the field returns to EMPTY and the
 * entry rejoins the needs-a-look list.
 *
 * This is the whole point of Clear: a rejected value must not silently stay.
 * `record.via` says which key carried it; with no record (a person clearing a
 * hand-written value) both candidates are tried.
 */
export function withoutFieldValue(
  meta: Record<string, unknown>,
  field: RemediableField,
  record?: FieldProvenance | null,
): Record<string, unknown> {
  if (field === 'topic') {
    let next = { ...meta }
    const value = record?.value
    if (record?.via !== 'tag') {
      const category = typeof next.category === 'string' ? next.category.trim() : ''
      // Only when the category IS the topic. A category holding a PURPOSE
      // ("strategy") says what the document is FOR, and clearing a topic must
      // not throw that away — the topic rode on a tag in that case.
      const categoryIsTheTopic = !!category && !!topicFor(category, [])
      if (categoryIsTheTopic && (!value || category === value)) next = { ...next, category: '' }
    }
    if (record?.via !== 'category') {
      const tags = Array.isArray(next.tags) ? (next.tags as unknown[]).filter((t): t is string => typeof t === 'string') : []
      // With no record, every tag that IS a topic has to go — otherwise the
      // field is "cleared" and still answers.
      const kept = tags.filter(tag => (value ? tag !== value : !topicFor('', [tag])))
      if (kept.length !== tags.length) next = { ...next, tags: kept }
    }
    return withoutProvenance(next, field)
  }
  if (isDateField(field)) {
    const dates = { ...datesBlock(meta) }
    delete dates[field]
    // The block goes when the last date does, so a cleared entry's manifest
    // looks like one that never had a date rather than carrying an empty husk.
    const next = Object.keys(dates).length ? { ...meta, dates } : dropKey(meta, 'dates')
    return withoutProvenance(next, field)
  }
  const key = field === 'summary' ? 'description' : field
  const { [key]: _cleared, ...rest } = meta
  return withoutProvenance(rest, field)
}

/** The entry's `dates` block, or an empty one. */
function datesBlock(meta: Record<string, unknown>): DataDates {
  const raw = meta.dates
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: DataDates = {}
  for (const field of ['covers', 'published', 'fetched'] as DateField[]) {
    const value = (raw as Record<string, unknown>)[field]
    if (typeof value === 'string' && value) out[field] = value
  }
  return out
}

function dropKey(meta: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _gone, ...rest } = meta
  return rest
}
