/**
 * Operations-home helpers (P5-40). The hub page slug is a content
 * convention, not code: it now comes from `library/kb.json` via
 * GET /api/library/kb (see kbConfig.ts), so the landing never hard-codes
 * which page is "Start here". If the configured page doesn't exist, the
 * tile simply isn't shown.
 */
import {
  linkOf,
  isFetchPending,
  inspectionOf,
  ingestOf,
  modelPassGap,
  sourceOf,
  purposeOf,
  topicOf,
  organizationOf,
  coverageOf,
  type CatalogEntry,
} from './libraryCatalog'
import { isOrganizationId } from '@/config/organizations'
import {
  FIELD_RULES,
  fieldValueOf,
  hasUnverifiedValue,
  provenanceOf,
  unverifiedFieldsOf,
  type FieldProvenance,
  type RemediableField,
} from './provenance'

export interface KbCounts {
  pages: number
  datasets: number
  documents: number
  notes: number
  views: number
  queue: number
  ideas: number
  /** P5-64: the registry — datasets we index and fetch on demand rather than
   *  hold. It was counted nowhere, so the landing said "22 Data & documents"
   *  over a list of 72. */
  sources: number
}

export function kbCounts(entries: CatalogEntry[]): KbCounts {
  // Archived entries are hidden from every list, so the tiles must not count
  // them either — a tile that says 17 over a list that shows 14 is a lie.
  const live = entries.filter(e => e.status !== 'archived')
  const by = (kind: string) => live.filter(e => e.kind === kind).length
  return {
    pages: by('wiki'),
    datasets: by('dataset'),
    documents: by('document') + by('incoming'),
    notes: by('note'),
    views: by('view'),
    queue: entries.filter(e => e.status === 'needs-cataloging').length,
    // P5-63: through the taxonomy, so an idea filed as `idea` counts too.
    ideas: entries.filter(e => purposeOf(e) === 'ideas').length,
    sources: by('source'),
  }
}

/** Most recently changed entries first (the catalog's updatedAt is the
 *  newest bucket object per entry); ties keep catalog order. */
export function recentlyUpdated(entries: CatalogEntry[], limit = 8, kinds?: string[]): CatalogEntry[] {
  return entries
    .filter(e => (kinds ? kinds.includes(e.kind) : true) && e.status !== 'archived')
    .map((e, i) => ({ e, i, t: e.updatedAt ? Date.parse(e.updatedAt) : 0 }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .slice(0, limit)
    .map(x => x.e)
}

/** One row of the "needs attention" panel: a count and where to go fix it. */
export interface AttentionItem {
  key: string
  label: string
  count: number
  href: string
  /**
   * P9-8: what a rolled-up row is MADE of, biggest first.
   *
   * "66 — Needs a look" against a 97-entry library is not a queue, it is the
   * background: a reader cannot start on it, so they start on nothing. The
   * rules behind it were already there, each with its own key and its own
   * deep link — they were simply not shown. "12 datasets with no period
   * covered" is a morning's work.
   */
  breakdown?: AttentionItem[]
}

/** A dropped link whose file nobody has fetched yet: the entry still holds
 *  nothing but its manifest, and the server is not already on its way to
 *  getting it (P5-47). A fetch in progress is not work waiting on a person,
 *  so counting it here would put a job on the panel that no one can do. */
function isUnfetchedLink(entry: CatalogEntry): boolean {
  if (entry.kind !== 'incoming' || !linkOf(entry)) return false
  if (isFetchPending(entry)) return false
  return entry.files.every(f => f.key.endsWith('/meta.json'))
}

/**
 * P5-59 "to ingest": a DROPPED LINK with no plan on it yet.
 *
 * Only dropped links. A registered source's plan is already implicit — it is
 * indexed, and fetched on demand when it has an adapter — and counting the
 * seeded sources here showed 47 rows of work for 7 real links.
 */
function isPlannable(entry: CatalogEntry): boolean {
  return entry.kind === 'incoming' && !!linkOf(entry)
}

function needsPlan(entry: CatalogEntry): boolean {
  return isPlannable(entry) && !ingestOf(entry)
}

/** A copy that was decided on and has not arrived — the manual pull Nick does,
 *  or one the server could not finish. */
function replicatePending(entry: CatalogEntry): boolean {
  const ingest = ingestOf(entry)
  return ingest?.plan === 'replicate' && !ingest.done
}

/** The last look at the link failed: a typo, a dead link, or a site that is
 *  down. Either way a person has to look at it. */
function inspectionFailed(entry: CatalogEntry): boolean {
  return inspectionOf(entry)?.kind === 'unreachable'
}

/** A source whose adapter errored and has not worked since (P5-57 records it,
 *  a successful fetch clears it). */
function sourceFailing(entry: CatalogEntry): boolean {
  return !!sourceOf(entry)?.lastError
}

/** P5-83: read, and left with an empty summary. Different work from "nobody
 *  has filed it": the reading happened, the model pass did not, and pressing
 *  Look again is all it takes. */
function readWithNoSummary(entry: CatalogEntry): boolean {
  return !!modelPassGap(entry)
}

/** Kinds whose manifest carries a category, so "no topic" is a real gap
 *  rather than a question nobody asked. */
const TOPICABLE_KINDS = ['dataset', 'document', 'incoming', 'note', 'source']

/**
 * A note the library GENERATED and somebody kept: a saved Ask answer (P5-48)
 * or a kept place report, both written with `category: research` and the `ask`
 * tag by `saveAnswerAsNote` / `saveReportAsNote`.
 *
 * Found live, and it is the worse half of the bug that found it: two kept
 * place reports sat on the needs-a-look queue with no description, no
 * extractable file and nothing a model could read, so they could never be
 * filled and nobody was ever going to assign a topic to the library's own
 * output. **A queue that counts what it generates never drains** — the same
 * mistake P5-59 made counting 47 seeded sources as "no ingest plan yet".
 *
 * Their subject is the question that was asked and their purpose is already
 * `research`. Nothing is waiting on a person, so nothing goes on the row.
 */
const GENERATED_NOTE_TAG = 'ask'

function isGeneratedNote(entry: CatalogEntry): boolean {
  return entry.kind === 'note' && entry.tags.includes(GENERATED_NOTE_TAG)
}

function hasNoTopic(entry: CatalogEntry): boolean {
  if (isGeneratedNote(entry)) return false
  return TOPICABLE_KINDS.includes(entry.kind) && !topicOf(entry)
}

/** Kinds the datasets browser groups by publisher and by geography, so "no
 *  organization" and "no coverage" are real gaps. A page, a note and a saved
 *  view have neither a publisher nor a coverage to be missing. */
const PUBLISHED_KINDS = ['dataset', 'source']

/**
 * P6-1: nothing on the entry names a publisher the vocabulary knows — either
 * it names none at all, or it names one in words we have never met, which the
 * browser then heads a one-entry group with. Either way somebody has to add
 * the alias or the manifest field.
 */
function hasNoOrganization(entry: CatalogEntry): boolean {
  return PUBLISHED_KINDS.includes(entry.kind) && !isOrganizationId(organizationOf(entry))
}

/**
 * P6-19: nothing on the entry says where it applies — no GEOIDs in its table,
 * no coordinates, no source block that says, and nobody has written
 * `coverage:`.
 *
 * This row is the reason the derivation is allowed to decline. The alternative
 * to counting the gap is calling such an entry national, which would put it in
 * the answer to "what is nationwide?" and take it out of the one list that
 * would get it fixed. Only the two kinds that can have a coverage are asked.
 */
function hasNoCoverage(entry: CatalogEntry): boolean {
  return PUBLISHED_KINDS.includes(entry.kind) && !coverageOf(entry)
}

/**
 * P7-7: nothing on the entry says what QUESTION it can answer.
 *
 * The gap that is not like its four neighbours: they are descriptive and this
 * one is a capability, which is why `applicableSources` could filter forty
 * sources by place and none of them by what was asked (§F.4d). Counted for the
 * same two kinds — a document's "what it answers" is its summary.
 *
 * There is deliberately no check for a line that merely restates the title.
 * That is a review problem, and a heuristic that half-worked would be worse
 * than the queue, which is what the ticket says and what the queue is for.
 */
function hasNoAnswersLine(entry: CatalogEntry): boolean {
  return PUBLISHED_KINDS.includes(entry.kind) && !fieldValueOf(entry, 'whatItAnswers')
}

/**
 * P7-10: nothing on the entry says WHEN its data is from.
 *
 * Two predicates, not one, because the two dates are two facts and a row that
 * read "no dates" would hide which is missing. `covers` is the period the data
 * describes — a dataset with none cannot answer "what do we hold that is
 * current?". `published` is when the publisher put it out, which is the one
 * that goes STALE: a list of data centres last published in 2019 is actively
 * misleading rather than merely dated.
 *
 * Neither is a defect. Tagging increases gradually (Nick, 2026-10-05) and
 * nothing is backfilled — these are gaps on the row like every other missing
 * field, and on the real library they fall on the same shaped entries
 * `no-answers-line` already counts, so the ROW's number does not move. What
 * grows is the per-row line, which is the honest place for it.
 */
function hasNoPeriodCovered(entry: CatalogEntry): boolean {
  return PUBLISHED_KINDS.includes(entry.kind) && !fieldValueOf(entry, 'covers')
}

function hasNoPublishedDate(entry: CatalogEntry): boolean {
  return PUBLISHED_KINDS.includes(entry.kind) && !fieldValueOf(entry, 'published')
}

/**
 * P6-33's one row, and P6-34's reason for it.
 *
 * `uncategorised`, `no-organization`, `no-coverage`, `no-summary`, (P7-7)
 * `no-answers-line` and (P7-10) `no-period-covered` / `no-published-date` ask
 * the same question of seven fields, and three rows reading 12 / 2 / 0 implied
 * three jobs where there is one: open the entry and
 * decide. They roll up here, and
 * `unverified` joins them — once remediation applies by default, "a model
 * filled this and nobody has read it" is the same action as "nothing could
 * fill this". Hence **"Needs a look"** rather than "missing" or "unverified":
 * the row covers both and the per-row line says which.
 *
 * `no-plan` stays its own row. A plan is a decision about what to DO with a
 * source, not a label on it, and it sits with the broken/lifecycle work.
 */
const ROLLED_UP_KEY = 'needs-a-look'

/**
 * The rules, in the order the panel lists them. One row = one predicate, and
 * the browsers filter by the same predicate through `matchesAttention`, so a
 * count and the list it opens can never disagree.
 *
 * `rolledUp` rules keep their keys — old deep links (`?attention=uncategorised`
 * and friends) still open exactly their own field, and the browsers still
 * filter by the same predicates, which is the invariant P6-23 had to repair.
 * The collapse is in the PANEL, not in the vocabulary.
 */
const ATTENTION_RULES: ReadonlyArray<{ key: string; label: string; test: (e: CatalogEntry) => boolean; rolledUp?: true }> = [
  { key: 'to-file', label: 'Waiting to be filed', test: e => e.status === 'needs-cataloging' },
  { key: 'needs-review', label: 'Needs review', test: e => e.status === 'needs-review' },
  { key: 'in-cleaning', label: 'Datasets in cleaning', test: e => e.kind === 'dataset' && e.status === 'in-cleaning' },
  { key: 'unfetched-links', label: 'Dropped links with no file yet', test: isUnfetchedLink },
  // P5-59 "To ingest".
  { key: 'no-plan', label: 'No ingest plan yet', test: needsPlan },
  { key: 'replicate-todo', label: 'Copies waiting to happen', test: replicatePending },
  { key: 'unreachable', label: 'Could not reach it — check the link', test: inspectionFailed },
  { key: 'source-failing', label: 'Sources whose last fetch failed', test: sourceFailing },
  // P6-33: the one row, where the first of the four used to sit. Everything
  // below it is still its own queue for a link that names one.
  { key: ROLLED_UP_KEY, label: 'Needs a look', test: e => needsALook(e) },
  // P5-63: nothing on the entry says what it is ABOUT, so the topic facet
  // cannot show it and Ask cannot retrieve it by subject. Only kinds that
  // carry a manifest category are counted — a wiki page IS the knowledge
  // base, and a saved view's category is a machine word.
  { key: 'uncategorised', label: 'Entries with no topic', test: hasNoTopic, rolledUp: true },
  // P6-1: the same question about the third vocabulary — who published it.
  { key: 'no-organization', label: 'Datasets with no organization', test: hasNoOrganization, rolledUp: true },
  // P6-19: and the fourth — where it applies. Beside its sibling deliberately:
  // they are the same kind of gap and the same kind of fix.
  { key: 'no-coverage', label: 'Datasets with no coverage', test: hasNoCoverage, rolledUp: true },
  // P7-7: and the fifth — what question it answers. P6-33 collapsed these four
  // into one row specifically so this one could land without a near-identical
  // fifth row beside them ("the phase-7 spec proposes `whatItAnswers`").
  { key: 'no-answers-line', label: 'Datasets with no answers line', test: hasNoAnswersLine, rolledUp: true },
  // P7-10: and the sixth and seventh — WHEN it is from. Two keys for two
  // facts, both rolled into the one row, because "open it and decide" is still
  // one job however many of its fields are blank. `fetched` has no key: we
  // work it out ourselves, and most of the library was never fetched from
  // anywhere.
  { key: 'no-period-covered', label: 'Datasets with no period covered', test: hasNoPeriodCovered, rolledUp: true },
  { key: 'no-published-date', label: 'Datasets with no published date', test: hasNoPublishedDate, rolledUp: true },
  // P5-83: read, but no summary yet — the model was out when the pass ran.
  { key: 'no-summary', label: 'Read, but no summary yet', test: readWithNoSummary, rolledUp: true },
  // P6-34: a model wrote a value and nobody has looked at it. Not a gap — the
  // entry IS findable now — but a claim standing on nobody's authority, which
  // is why it shares a row with the gaps rather than being invisible.
  { key: 'unverified', label: 'Unverified metadata', test: hasUnverifiedValue, rolledUp: true },
]

/** The per-field rules P6-33 rolls into one row. */
const ROLLED_UP_RULES = ATTENTION_RULES.filter(rule => rule.rolledUp)

/**
 * Is anything on this entry waiting to be looked at — a field nothing could
 * fill, or a field a model filled? One predicate over the per-field ones, so
 * the row, the list and `?attention=needs-a-look` are one set by construction.
 */
function needsALook(entry: CatalogEntry): boolean {
  return ROLLED_UP_RULES.some(rule => rule.test(entry))
}

/** Every queue key, for anything that needs to validate one off a URL. */
export const ATTENTION_KEYS: readonly string[] = ATTENTION_RULES.map(rule => rule.key)

/** What a queue is called, for the banner a browser shows while it is
 *  narrowed to one. An unknown key comes back '' — the browser then says
 *  nothing rather than naming a queue that does not exist. */
export function attentionLabel(key: string): string {
  return ATTENTION_RULES.find(rule => rule.key === key)?.label ?? ''
}

/** Does this entry belong on that queue? The browsers ask this of every row
 *  when a link arrives carrying `?attention=…`. An unknown key matches
 *  nothing, so a mistyped link shows an empty list rather than the whole one. */
export function matchesAttention(entry: CatalogEntry, key: string): boolean {
  const rule = ATTENTION_RULES.find(r => r.key === key)
  return rule ? rule.test(entry) : false
}

/** Every queue this entry is on — what a browser row carries so filtering is
 *  one array lookup rather than eleven predicates per row per keystroke. */
export function attentionKeysFor(entry: CatalogEntry): string[] {
  return ATTENTION_RULES.filter(rule => rule.test(entry)).map(rule => rule.key)
}

/** The two kinds the datasets browser lists. Everything else — pages,
 *  documents, notes, the to-file queue — is in the docs browser. */
const DATASET_KINDS = ['dataset', 'source']

/**
 * P6-5: where the rows of a queue now live.
 *
 * The Library list they all used to point at is gone, and the two browsers
 * that replaced it hold different kinds. Rather than guess per queue — most
 * of these predicates can match either kind — the href is decided by what the
 * rows ACTUALLY are: a majority of datasets and sources opens `/datasets`,
 * anything else opens `/docs`. Both browsers honour `?attention=`, so a link
 * saved before the mix changed still opens a correct (if shorter) list.
 */
function attentionHref(key: string, matched: CatalogEntry[]): string {
  const datasetish = matched.filter(e => DATASET_KINDS.includes(e.kind)).length
  return datasetish * 2 > matched.length ? `/datasets?attention=${key}` : `/docs?attention=${key}`
}

/** What is waiting on a person, computed from the catalog the landing has
 *  already fetched — no extra request. Zero-count rows are dropped so the
 *  panel only ever shows real work. A bare link drop legitimately appears in
 *  two rows (file it, and fetch it): they are different jobs. */
export function attentionItems(entries: CatalogEntry[]): AttentionItem[] {
  // P6-23: archived rows are counted out here, because the lists these counts
  // open exclude them (`DatasetsView` and `DocsView` both drop
  // `status === 'archived'`). The landing asks the catalog for archived rows
  // too — the tiles want them — so without this an attention row offered 14
  // and opened a list of 12, and the promise that "a count and the list it
  // opens cannot drift" held only for the predicate, not for the row set.
  //
  // Open, deliberately: an archived entry is now reachable from no browse
  // surface at all, yet still holds files. Either the browsers gain a way to
  // show them or the landing should stop counting them — that is a question
  // for Nick, not something a count fix should settle. See P6-23.
  const live = entries.filter(entry => entry.status !== 'archived')
  const itemFor = (rule: { key: string; label: string; test: (e: CatalogEntry) => boolean }): AttentionItem => {
    const matched = live.filter(rule.test)
    return { key: rule.key, label: rule.label, count: matched.length, href: attentionHref(rule.key, matched) }
  }
  return ATTENTION_RULES.filter(rule => !rule.rolledUp)
    .map(rule => {
      const item = itemFor(rule)
      if (rule.key !== ROLLED_UP_KEY) return item
      // The reasons behind the one row, so a reader can pick one off instead
      // of facing two thirds of the library at once. Counts here overlap —
      // one entry can be missing a topic AND a period — so they are not
      // summed and the roll-up stays the honest total.
      const breakdown = ROLLED_UP_RULES.map(itemFor)
        .filter(part => part.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      return { ...item, breakdown }
    })
    .filter(item => item.count > 0)
}

/**
 * One field of one entry on the needs-a-look list: what it is, what it says,
 * how it got there, and the sentence it was read from.
 *
 * `state` is the whole point of the row: `missing` is an entry nothing could
 * fill, `unverified` is an entry a model filled. Both open the same way.
 */
export interface NeedsALookField {
  field: RemediableField
  label: string
  state: 'missing' | 'unverified'
  /** What the field says now. '' for a gap. */
  value: string
  /** The gap/claim in the per-row line's words: "no topic", "topic unverified". */
  note: string
  provenance?: FieldProvenance
}

/**
 * Which fields of this entry need a look, in the field table's order.
 *
 * This is what the list a row opens shows, and what the per-row line is built
 * from, so the collapse loses nothing: four rows reading 12 / 2 / 0 / 0 became
 * one row of 14 entries, each saying which fields it is and which case.
 */
export function needsALookFields(entry: CatalogEntry): NeedsALookField[] {
  const out: NeedsALookField[] = []
  const unverified = new Set<string>(unverifiedFieldsOf(entry))
  for (const rule of FIELD_RULES) {
    const missing = !!rule.missingKey && matchesAttention(entry, rule.missingKey)
    if (missing) {
      out.push({ field: rule.field, label: rule.label, state: 'missing', value: '', note: rule.gapWord })
      continue
    }
    if (!unverified.has(rule.field)) continue
    const record = provenanceOf(entry, rule.field)
    out.push({
      field: rule.field,
      label: rule.label,
      state: 'unverified',
      value: record?.value ?? '',
      // The LABEL lowercased, not the field name: `whatItAnswers unverified`
      // is a key leaking into a sentence a person reads. Identical for every
      // field that can actually be unverified today (`topic` → "topic").
      note: `${rule.label.toLowerCase()} unverified`,
      ...(record ? { provenance: record } : {}),
    })
  }
  return out
}

/** The per-row line: "no topic · no coverage", "topic unverified". '' when
 *  the entry is on none of the rolled-up queues. */
export function needsALookNote(entry: CatalogEntry): string {
  return needsALookFields(entry)
    .map(f => f.note)
    .join(' · ')
}

/** Whether a queue key is one of the ones P6-33 rolled up — what the browsers
 *  ask before showing the field detail and the Keep / Edit / Clear actions. */
export function isNeedsALookKey(key: string): boolean {
  return key === ROLLED_UP_KEY || ROLLED_UP_RULES.some(rule => rule.key === key)
}

/** The fields a given rolled-up key is about: `needs-a-look` means all of
 *  them, an old deep link means its own one. A count must never disagree with
 *  the list it opens (P6-23), so the list narrows exactly as the key does. */
export function needsALookFieldsFor(entry: CatalogEntry, key: string): NeedsALookField[] {
  const all = needsALookFields(entry)
  if (key === ROLLED_UP_KEY) return all
  if (key === 'unverified') return all.filter(f => f.state === 'unverified')
  const rule = FIELD_RULES.find(r => r.missingKey === key)
  if (!rule) return []
  return all.filter(f => f.field === rule.field)
}

/** Where an entry opens: pages and views have their own routes. */
export function entryHref(entry: Pick<CatalogEntry, 'kind' | 'slug'>): string {
  if (entry.kind === 'wiki') return `/wiki/${entry.slug}`
  if (entry.kind === 'view') return `/views/${entry.slug}`
  // P5-45: a public map layer is not a catalog row — it has no slug in the
  // library — but it appears in the same result lists, and its home is its
  // about page.
  if (entry.kind === 'layer') return `/layers/${entry.slug}`
  return `/library/${entry.slug}`
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'wiki':
      return 'page'
    case 'incoming':
      return 'to file'
    // P7-1. The hyphen is the slug's, not the vocabulary's.
    case 'working-set':
      return 'working set'
    default:
      return kind
  }
}

/** Short relative time for lists: "just now", "3h ago", "2d ago", else a date. */
export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 14) return `${d}d ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
