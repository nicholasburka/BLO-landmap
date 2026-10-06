/**
 * Where a value came from (P6-34).
 *
 * Remediation runs by default now: coverage and shape have been derived at
 * every reindex since P6-2/P6-19, organization since P6-1, and P6-34 adds the
 * topic a model reads out of prose. Applying by default is only honest if a
 * reader can tell the three apart, so **every remediated value carries its
 * mechanism** — and one of the three needs a person to look at it once.
 *
 * ## Derived vs inferred — the distinction that decides the behaviour
 *
 * - **Derived** — computed deterministically from data we already hold:
 *   coverage from a table's GEOIDs, shape from its columns, organization from
 *   the provider string through the alias vocabulary. Applied, and NOT queued:
 *   it is re-derived at every reindex, it is as correct as the data, and a
 *   person "verifying" it adds nothing a re-run would not.
 * - **Inferred** — a model's reading of prose: the topic, (P7-7) the one line
 *   saying what the data ANSWERS, and (P7-10) the two dates a publisher states
 *   rather than computes. Applied, AND queued, because it can be wrong in ways
 *   re-running will not fix.
 *
 * P7-10's `covers` is the first field to list BOTH, which is what the ordered
 * `mechanisms` array was built for: when a layer block's year or a table's own
 * year column answers, the value is derived and never queues; when only a
 * model could read it off a page, the same field applies AND queues.
 *
 * So the queue is not "missing metadata"; it is **unverified** metadata, and
 * P6-33's one attention row covers both — an entry nothing could fill and an
 * entry a model filled are the same action: open it, decide.
 *
 * ## The vocabulary is P5-61's, not a new one
 *
 * `sourceProposal.ts` has carried `inferred` paths and an `evidence` map since
 * P5-61 — *the claim travels with its evidence*. A `FieldProvenance` is the
 * same pair per field, stored rather than recomputed, plus the mechanism and
 * the date.
 *
 * ## Mechanism is READ, never migrated
 *
 * Nothing in the library carries a provenance block today, and nothing needed
 * to be backfilled. `mechanismOf` answers from what is already there:
 *
 * 1. a stored record whose `value` still matches the value on the row — its
 *    mechanism (this is the only way `model` is ever reported, so a library
 *    no remediation has touched has an empty verification queue);
 * 2. otherwise, for a field something derives — `derived`;
 * 3. otherwise — `person`, because the only other way a topic or a summary
 *    gets onto an entry is that somebody wrote it.
 *
 * The server mirrors this file at `server/src/services/provenance.ts` (the
 * server cannot read the client's TypeScript); `provenance.test.ts` there
 * fails when the two field tables disagree.
 */
import { coverageOf, organizationOf, topicOf, type CatalogEntry } from './libraryCatalog'
import { resolveDates } from './dataDates'

/** How a value got onto an entry. */
export const MECHANISMS = ['derived', 'model', 'person'] as const
export type Mechanism = (typeof MECHANISMS)[number]

/** Plain words for the mechanism, for a row that has to say which it is. */
export function mechanismLabel(mechanism: Mechanism): string {
  switch (mechanism) {
    case 'derived':
      return 'worked out from the data'
    case 'model':
      return 'read by the model'
    case 'person':
      return 'written by a person'
    default:
      return mechanism
  }
}

/** The fields remediation knows how to fill. */
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

/** P7-7: one or two sentences, not a paragraph — the cap is set by where the
 *  line is READ, a dozen of them in one `search_library` answer. Mirrors
 *  `WHAT_IT_ANSWERS_MAX_CHARS` on the server. */
export const WHAT_IT_ANSWERS_MAX_CHARS = 240

export interface FieldRule {
  field: RemediableField
  /** What the field is called where a person reads it. */
  label: string
  /**
   * The mechanisms that can answer, IN ORDER — the first that produces a value
   * wins. This is where "derivation still beats the model" lives: a field
   * listing both takes the derived answer and never queues, and adding a model
   * fallback later is appending to this array rather than a new rule.
   */
  mechanisms: readonly Mechanism[]
  /**
   * The `ATTENTION_RULES` key that counts this field MISSING (P6-33 rolls them
   * all into one row; the keys stay as the filter vocabulary). `null` for a
   * field that can never be missing — `shape` always answers `records`.
   */
  missingKey: string | null
  /** The words the per-row line uses for a gap: "no topic · no coverage". */
  gapWord: string
}

/**
 * One row per field.
 *
 * `summary` is deliberately listed with NO mechanism. P5-83's "Look again"
 * keeps proposing a summary and waiting to be accepted, because prose gets
 * *read as a claim* rather than filtered on as a chip: a wrong topic is a bad
 * filter, a wrong summary is a false statement in the library's own voice.
 * Whether it inverts too is Nick's call, recorded in P6-34 — so the field is
 * here, to be counted and shown, and remediation does not write it.
 */
export const FIELD_RULES: readonly FieldRule[] = [
  { field: 'topic', label: 'Topic', mechanisms: ['model'], missingKey: 'uncategorised', gapWord: 'no topic' },
  { field: 'organization', label: 'Organization', mechanisms: ['derived'], missingKey: 'no-organization', gapWord: 'no organization' },
  { field: 'coverage', label: 'Coverage', mechanisms: ['derived'], missingKey: 'no-coverage', gapWord: 'no coverage' },
  { field: 'shape', label: 'Type', mechanisms: ['derived'], missingKey: null, gapWord: 'no type' },
  { field: 'summary', label: 'Summary', mechanisms: [], missingKey: 'no-summary', gapWord: 'no summary' },
  // P7-7: the one CAPABILITY field — what question this data answers, as
  // against the four descriptive ones above it. Inferred, so it applies and
  // queues: §F.4d's own caveat is that a line everybody fills with the title
  // restated is worse than no line, and the queue is what keeps it honest.
  { field: 'whatItAnswers', label: 'Answers', mechanisms: ['model'], missingKey: 'no-answers-line', gapWord: 'no answers line' },
  // P7-10: WHEN the data is from — two facts, never one. `covers` is the
  // period the data describes and ages into being historical; `published` is
  // when the publisher put it out and ages into being STALE, which is a
  // different and worse thing. Folding them into one `date` would make a 2019
  // study indistinguishable from a 2019-stale inventory, which is exactly the
  // distinction Nick was pointing at.
  { field: 'covers', label: 'Period covered', mechanisms: ['derived', 'model'], missingKey: 'no-period-covered', gapWord: 'no period covered' },
  { field: 'published', label: 'Published', mechanisms: ['model'], missingKey: 'no-published-date', gapWord: 'no published date' },
  // The only one that is about US — we wrote it, so it is derived and never
  // queues. `missingKey: null` beside `shape`'s: most of the library was never
  // fetched from anywhere, and a gap row for "no record of fetching this"
  // would be a queue nobody could ever drain (P5-59's lesson, found three
  // times now).
  { field: 'fetched', label: 'Fetched', mechanisms: ['derived'], missingKey: null, gapWord: 'no fetch date' },
]

export const REMEDIABLE_FIELDS: readonly RemediableField[] = FIELD_RULES.map(rule => rule.field)

export function fieldRule(field: string): FieldRule | null {
  return FIELD_RULES.find(rule => rule.field === field) ?? null
}

export function fieldLabel(field: string): string {
  return fieldRule(field)?.label ?? field
}

/** The fields a model is allowed to fill — the ones that enter the queue. */
export const INFERRED_FIELDS: readonly RemediableField[] = FIELD_RULES.filter(r => r.mechanisms.includes('model')).map(r => r.field)

/**
 * One remediated value's record, stored in the manifest at
 * `meta.provenance.<field>`.
 *
 * Only `model` and `person` records are ever written. `derived` is not stored
 * — it is re-derived at every reindex and storing it would be a cache of a
 * pure function that a push could make stale.
 */
export interface FieldProvenance {
  mechanism: Mechanism
  /** ISO, when the mechanism ran. */
  at?: string
  /**
   * The value the mechanism wrote. The record speaks for THIS value and no
   * other: when the value on the row has changed underneath it, the record no
   * longer applies and the field reads as whatever it is now.
   */
  value?: string
  /** For a model reading prose: the sentence the claim came from (P5-61). */
  evidence?: string
  /**
   * Which manifest key carried it. A topic is not a stored field — it is the
   * entry's `category` when that is a topic, otherwise the first of its tags
   * that is one — so Clear has to know which one to take back out.
   */
  via?: 'category' | 'tag' | 'field'
  /** A person looked and kept it. The words stay the model's; the vouching is theirs. */
  verifiedAt?: string
  verifiedBy?: string
}

export type ProvenanceMap = Partial<Record<string, FieldProvenance>>

/** The entry's provenance block, or an empty map. Anything that is not a
 *  record with a known mechanism is dropped rather than guessed at. */
export function provenanceMapOf(entry: Pick<CatalogEntry, 'meta'>): ProvenanceMap {
  const raw = entry.meta?.provenance
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

type ProvenanceEntry = Pick<CatalogEntry, 'meta' | 'category' | 'tags' | 'organization' | 'shape' | 'coverage' | 'dates'>

/**
 * What the field says today, as one comparable string. '' means the field is
 * empty, which is what the missing half of P6-33's row counts.
 */
export function fieldValueOf(entry: ProvenanceEntry, field: string): string {
  switch (field) {
    case 'topic':
      return topicOf(entry) ?? ''
    case 'organization':
      return organizationOf(entry)
    case 'coverage':
      return coverageOf(entry)?.label ?? ''
    case 'shape':
      return entry.shape ?? ''
    case 'summary':
      return typeof entry.meta?.description === 'string' ? entry.meta.description.trim() : ''
    case 'whatItAnswers':
      // P7-7: a plain manifest string (`meta` JSONB, no schema change). The
      // kind gate is the attention predicate's, in `lib/kb` — a page carrying
      // a stray key is not asked the question, and nothing renders one.
      return typeof entry.meta?.whatItAnswers === 'string' ? entry.meta.whatItAnswers.trim() : ''
    case 'covers':
    case 'published':
    case 'fetched':
      // P7-10: read off the row's own promoted `dates`, not out of `meta` —
      // the server folds the manifest, the fetch records and the layer block
      // into one block on every read, exactly as it does for `coverage`, so
      // this side has one place to look and cannot disagree with the queue.
      return resolveDates(entry.dates)[field]
    default:
      return ''
  }
}

/**
 * How this field's value got there, or null when there is no value to explain.
 * See the module header for the three steps — the important one is that a
 * stored record only speaks for the value it wrote.
 */
export function mechanismOf(entry: ProvenanceEntry, field: string): Mechanism | null {
  const value = fieldValueOf(entry, field)
  if (!value) return null
  const record = provenanceMapOf(entry)[field]
  if (record && (record.value === undefined || record.value === value)) return record.mechanism
  return fieldRule(field)?.mechanisms.includes('derived') ? 'derived' : 'person'
}

/** The record that explains the value on the row, or null. */
export function provenanceOf(entry: ProvenanceEntry, field: string): FieldProvenance | null {
  const mechanism = mechanismOf(entry, field)
  if (!mechanism) return null
  const record = provenanceMapOf(entry)[field]
  if (record && (record.value === undefined || record.value === fieldValueOf(entry, field))) return record
  return { mechanism, value: fieldValueOf(entry, field) }
}

/**
 * A model wrote this and nobody has looked at it yet — the one state that
 * earns a place on the verification queue. A derived value never does, and a
 * person's edit or a person's Keep removes it permanently.
 */
export function isUnverified(entry: ProvenanceEntry, field: string): boolean {
  const record = provenanceOf(entry, field)
  if (!record || record.mechanism !== 'model') return false
  return !record.verifiedAt
}

/** Every field on this entry a model filled and nobody has looked at. */
export function unverifiedFieldsOf(entry: ProvenanceEntry): RemediableField[] {
  return REMEDIABLE_FIELDS.filter(field => isUnverified(entry, field))
}

/** Does anything on this entry need verifying? The `unverified` queue's
 *  predicate — see `ATTENTION_RULES` in `lib/kb`. */
export function hasUnverifiedValue(entry: ProvenanceEntry): boolean {
  return REMEDIABLE_FIELDS.some(field => isUnverified(entry, field))
}
