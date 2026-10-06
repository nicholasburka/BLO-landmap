import { askModel } from './askKb.js'
import {
  callAssistant,
  isAssistantError,
  jsonObjectIn,
  type AnthropicLike,
} from './assistantCall.js'
import { patchEntryManifest } from './entryManifest.js'
import { clearKbIndex } from './kbSearch.js'
import { getCatalogEntry, type CatalogEntryRow } from './libraryCatalog.js'
import { ORGANIZATIONS, isOrganizationId } from './organizations.js'
import { INFERRED_FIELDS, WHAT_IT_ANSWERS_MAX_CHARS } from './provenance.js'
import { normalizeDataDate } from './dataDates.js'
import {
  MAX_TAGS,
  SUMMARY_MAX_CHARS,
  TITLE_MAX_CHARS,
  cleanTag,
  firstPages,
  type Pages,
  type SuggestionError,
} from './suggestFiling.js'
import { PURPOSES, SHAPES, TOPICS, isPurpose, isShape, isTopic, normalizeCategory, normalizeTag } from './taxonomy.js'

/**
 * Read one dropped document and propose the whole filing (P6-8).
 *
 * P5-47's pass asks four questions — title, category, tags, summary. A bulk
 * drop of a folder needs three more before the entry is worth anything in the
 * new browsers: WHO published it (P6-1's organization), WHAT KIND OF THING it
 * is (P6-2's shape), and what it is FOR as distinct from what it is ABOUT.
 * Same document, same first ~6,000 characters, same single metered call — a
 * wider answer.
 *
 * The rule from P5-47 is untouched and is the whole point: **the answer is
 * stored as the entry's suggestion and never applied.** The person sees it on
 * the New page (and on the entry) greyed, and Accept is what writes it. A
 * model that misreads fifty files costs fifty clicks, not fifty mis-filed
 * records.
 *
 * **P6-34 narrows that rule rather than replacing it.** The whole annotation
 * is still stored as the suggestion and still waits to be accepted — title,
 * summary, tags, organization, shape. Two fields of it, the TOPIC and (P7-7)
 * `whatItAnswers`, are applied by `remediate.ts` the moment they arrive,
 * because an entry with no topic is invisible to the topic facet, to Chat and
 * to any working set scoped by subject, and a proposal nobody got round to
 * accepting leaves it invisible for good. So both arrive with `evidence` — the
 * sentence each was read from — and land on the verification queue rather than
 * in a proposal. Which fields those are is not decided here: `INFERRED_FIELDS`
 * decides, and `evidenceField` asks it.
 */

/**
 * The output cap — **1,500, raised from 600 after a measured failure.**
 *
 * 600 was sized for the answer alone: seven fields, not an essay, a little
 * wider than the P5-47 cap because three more of them had to fit. That
 * arithmetic was about the JSON we store, and it is the wrong arithmetic,
 * because the Ask model reasons before it answers and **a thinking block is
 * spent out of the same budget.**
 *
 * Found live (P6-34), and measured rather than guessed. The same annotate
 * request for `why-five-million-memo`, four runs at each cap:
 *
 * | cap | answers with NO text | stop_reason |
 * | --- | --- | --- |
 * | 600 | **2 of 4** | `max_tokens` on all four |
 * | 1,500 | 0 of 4 | `end_turn` on all four, 562–1,058 tokens out |
 *
 * At 600 the call fails every time in one of two ways: the thinking block
 * eats the whole budget and `textOf` gets nothing (`model-error`), or text
 * starts and is cut mid-JSON so `jsonObjectIn` returns null. Both reached the
 * queue as "the model could not be asked", which is how a reindex came to
 * report `0 value(s) applied across 7 entries`.
 *
 * 1,500 clears the worst observed answer by ~440 tokens. **An output cap is
 * not a spend** — only tokens actually written are billed — which is the same
 * reasoning P5-62 used to raise `LIBRARY_PRUNE_MAX_TOKENS` 3,000 → 6,000, and
 * for the same underlying reason: the model does not know about our caps.
 *
 * Worth knowing: `askMaxTokens()` is 1,000 and shares this exposure. Left
 * alone deliberately — it is a different feature with its own budget line and
 * its own tests — but it is the next one to measure.
 */
export function annotateMaxTokens(): number {
  const raw = Number(process.env.LIBRARY_ANNOTATE_MAX_TOKENS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_500
}

/**
 * What one annotated file costs, in whole cents.
 *
 * Derived, not guessed: the pass sends the document's first 6,000 characters
 * (~1,500 tokens) plus a ~900-token prompt and caps the answer at 600, which
 * on the Ask model's rates lands just under a cent. DEPLOY.md prices a whole
 * Ask question — a far bigger prompt with tool rounds — at about a cent and a
 * half, so a cent is the right order and the right side of it.
 *
 * Stated once here because the New page shows it BEFORE the drop starts
 * ("about 12¢") and totals it afterwards, and those two numbers must come
 * from the same place.
 */
export const ANNOTATE_COST_CENTS = 1

/** One quoted sentence, not a paragraph (P6-34). Long enough for the longest
 *  real sentence in an agency PDF, short enough to read on a list row. */
export const EVIDENCE_MAX_CHARS = 300

/** P7-10: the stored grammar, spelled out for the model once and reused in
 *  both date bullets — so the prompt and `normalizeDataDate` cannot describe
 *  two different shapes. */
const DATE_GRAMMAR = '"YYYY", "YYYY-MM", "YYYY-MM-DD", or two of those separated by a slash for a period ("2019/2023")'

/** What the model may say about a file. Every field is optional: each one is
 *  validated and dropped on its own, so an unknown organization costs that
 *  field and not the whole annotation. */
export interface Annotation {
  title?: string
  summary?: string
  /**
   * P7-7: what question this data ANSWERS, as one line — *"Answers: which
   * parcels sit within N miles of a transmission line"*.
   *
   * Every other field here is descriptive: who published it, what subject
   * bucket it sits in, what shape its rows are. None of them says whether the
   * thing bears on what was asked, which is why a place report ran all forty
   * sources. This one is a CAPABILITY claim, and a model choosing datasets
   * chooses well from exactly this (§F.4d).
   *
   * Asked of a dataset or a source only — a document's "what it answers" is
   * its summary, and `fieldAppliesTo` is where that gate lives.
   */
  whatItAnswers?: string
  /**
   * P7-10: WHEN the data is from — two fields, because they are two facts.
   *
   * `covers` is the period the data DESCRIBES ("ACS 2019-2023", "sites as of
   * October 2026") and `published` is when the publisher put it out. A 2024
   * release of 2010 census tracts has both and they are years apart, so one
   * field could only have been wrong about one of them.
   *
   * Both arrive in the stored grammar and are REFUSED rather than guessed at
   * when they do not — a date the model paraphrased is not a date anybody can
   * check, and `updateCadence` ("every five years") is a promise rather than
   * a date and must never come back as one.
   */
  covers?: string
  published?: string
  /** The one field the existing filing form applies: the topic when there is
   *  one, else the purpose. Kept beside them rather than derived by readers. */
  category?: string
  topic?: string
  purpose?: string
  organization?: string
  shape?: string
  tags?: string[]
  /**
   * P6-34: field name -> the sentence the claim was read from.
   *
   * The same pair P5-61 put on a `SourceProposal` (`inferred` paths plus an
   * `evidence` map) — *the claim travels with its evidence* — asked here of a
   * document rather than a page, because a value remediation APPLIES has to be
   * checkable without re-reading the file. Only the inferred fields are asked
   * for: nothing derived needs a sentence.
   */
  evidence?: Record<string, string>
  at: string
  model: string
  /** P5-59's caveat, carried through: read from the file's first 64 kB. */
  basis?: 'head'
}

export type AnnotateOutcome = Annotation | SuggestionError

export function isAnnotateError(value: AnnotateOutcome): value is SuggestionError {
  return (value as SuggestionError).error === 'unavailable'
}

// --- Prompt ---------------------------------------------------------------

export function buildAnnotateSystemPrompt(): string {
  return [
    'You help a small research team file documents into their internal library.',
    'You are shown the first pages of one document. Describe how it should be filed.',
    'Only describe what the text actually says — never guess at contents you cannot see.',
    'Leave a field out rather than inventing a value for it.',
    'Answer with a single JSON object and nothing else.',
  ].join(' ')
}

export interface AnnotatePromptInput {
  file: string
  text: string
  currentTitle?: string
}

/** Who publishes things, written out for a model: ids with their plain names,
 *  so an answer can only ever be an id we already know. */
export function organizationMenu(): string {
  return ORGANIZATIONS.map(o => `${o.id} (${o.label})`).join(', ')
}

export function topicMenu(): string {
  return TOPICS.map(t => `${t.id} (${t.label})`).join(', ')
}

export function purposeMenu(): string {
  return PURPOSES.map(p => `${p.id} (${p.label})`).join(', ')
}

export function shapeMenu(): string {
  return SHAPES.map(s => `${s.id} (${s.label})`).join(', ')
}

export function buildAnnotateUserMessage(input: AnnotatePromptInput): string {
  return [
    `File name: ${input.file}`,
    input.currentTitle ? `Currently filed as: ${input.currentTitle}` : '',
    '',
    'First pages of the document:',
    '---',
    input.text,
    '---',
    '',
    'Reply with only this JSON object:',
    '{"title": "…", "summary": "…", "organization": "…", "topic": "…", "purpose": "…", "tags": ["…"], "shape": "…", "whatItAnswers": "…", "covers": "…", "published": "…", "evidence": {"topic": "…", "whatItAnswers": "…", "covers": "…", "published": "…"}}',
    `- title: what a person would call this document (at most ${TITLE_MAX_CHARS} characters).`,
    `- summary: two or three plain sentences saying what this is and what is in it (at most ${SUMMARY_MAX_CHARS} characters).`,
    `- organization: who published it, spelled exactly as one of these ids, or null when the document does not say: ${organizationMenu()}.`,
    `- topic: what it is ABOUT, one of: ${topicMenu()}.`,
    `- purpose: what it is FOR, one of these, or leave it out when it is simply about a subject: ${purposeMenu()}.`,
    `- tags: at most ${MAX_TAGS}, lowercase and hyphenated.`,
    `- shape: what kind of thing its data is, one of these, or leave it out when the document is not data at all: ${shapeMenu()}.`,
    // P7-7: the one CAPABILITY field. "Answers: …" is the shape we want
    // because it forces a question rather than a restatement — and the ask is
    // explicit that restating the title is not an answer, because a field
    // everybody fills with the title is worse than no field at all (§F.4d).
    `- whatItAnswers: one sentence naming a question this data can answer, written as "Answers: …" (at most ${WHAT_IT_ANSWERS_MAX_CHARS} characters). Say what could be looked up in it — which things, where, measured how. Never restate the title. Leave it out when the text does not say what the data contains.`,
    // P7-10: two dates, asked separately and in a grammar that can be
    // checked. The ask names the two readings out loud because a model handed
    // one `date` field will happily answer either, and they are years apart on
    // a 2024 release of 2010 tracts.
    `- covers: the period the DATA describes, as ${DATE_GRAMMAR}. A research dataset covers a stretch of time ("2019/2023"); a list of sites is true as of a moment ("2026-10"). Leave it out when the text does not say.`,
    `- published: when the publisher released or last updated it, as ${DATE_GRAMMAR}. This is NOT how often it is refreshed — "every five years" is a schedule, not a date, and must be left out.`,
    // P6-34: the topic is APPLIED rather than proposed, so it has to arrive
    // with the sentence it was read from — a value nobody can check is a value
    // nobody can verify.
    `- evidence: for the topic, for whatItAnswers and for each date, one short sentence copied from the text above that shows it (at most ${EVIDENCE_MAX_CHARS} characters each). Leave one out rather than paraphrasing. For a date this is where the source's own spelling belongs — "American Community Survey 2019-2023 5-year estimates".`,
  ]
    .filter(line => line !== '')
    .join('\n')
}

// --- Validation -----------------------------------------------------------

function stringField(value: unknown, max: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text && text.length <= max ? text : undefined
}

/**
 * P6-34: the evidence map, strictly. Only the fields remediation can APPLY
 * from prose are kept — a sentence for a field the model does not fill is
 * noise, and a sentence for a derived field would be a claim about data the
 * rows already answer. Over-long sentences are trimmed rather than dropped:
 * a truncated quote still points at the paragraph.
 */
function evidenceField(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const field of INFERRED_FIELDS) {
    const sentence = (value as Record<string, unknown>)[field]
    if (typeof sentence !== 'string') continue
    const text = sentence.trim().slice(0, EVIDENCE_MAX_CHARS)
    if (text) out[field] = text
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Model output → an annotation, strictly.
 *
 * Every vocabulary is closed and checked against its own list: an
 * organization, a topic, a purpose and a shape the server does not know are
 * DROPPED, never minted. Returns null when nothing survived, which the caller
 * records as "the model answered with nothing we can use".
 */
export function parseAnnotation(raw: string, model: string, at: string): Annotation | null {
  const parsed = jsonObjectIn(raw)
  if (!parsed) return null
  const annotation: Annotation = { at, model }

  const title = stringField(parsed.title, TITLE_MAX_CHARS)
  if (title) annotation.title = title

  const summary = stringField(parsed.summary, SUMMARY_MAX_CHARS)
  if (summary) annotation.summary = summary

  // P7-7: over-long is DROPPED rather than trimmed, as the title and the
  // summary are, because half a sentence is not a claim anybody can check —
  // and there is deliberately no test for "this restates the title". That is a
  // review problem; the verification queue is what keeps the field honest, and
  // a heuristic that half-worked would be worse than the queue (§F.4d).
  const whatItAnswers = stringField(parsed.whatItAnswers, WHAT_IT_ANSWERS_MAX_CHARS)
  if (whatItAnswers) annotation.whatItAnswers = whatItAnswers

  // P7-10: normalised, then REFUSED if it is still not a date. A model asked
  // for a date will sometimes answer with a cadence, a phrase or a range in
  // prose; the grammar is the whole check, and a value it cannot read is
  // dropped rather than stored as something a legend would then print.
  const covers = normalizeDataDate(parsed.covers)
  if (covers) annotation.covers = covers
  const published = normalizeDataDate(parsed.published)
  if (published) annotation.published = published

  // The same aliasing the P5-47 pass uses, so "demographics" or "Flooding" is
  // filed rather than dropped on a spelling.
  const topic = typeof parsed.topic === 'string' ? normalizeCategory(parsed.topic) : ''
  if (topic && isTopic(topic)) annotation.topic = topic

  const purpose = typeof parsed.purpose === 'string' ? normalizeCategory(parsed.purpose) : ''
  if (purpose && isPurpose(purpose)) annotation.purpose = purpose

  // One category is what the filing form has a field for. A subject beats a
  // use: "this is about housing" is the more useful of the two on a card.
  const category = annotation.topic ?? annotation.purpose
  if (category) annotation.category = category

  const organization = typeof parsed.organization === 'string' ? parsed.organization.trim().toLowerCase() : ''
  if (organization && isOrganizationId(organization)) annotation.organization = organization

  const shape = typeof parsed.shape === 'string' ? parsed.shape.trim().toLowerCase() : ''
  if (shape && isShape(shape)) annotation.shape = shape

  const evidence = evidenceField(parsed.evidence)
  if (evidence) annotation.evidence = evidence

  const tags = Array.isArray(parsed.tags)
    ? [
        ...new Set(
          parsed.tags
            .map(cleanTag)
            .filter((t): t is string => !!t)
            .map(normalizeTag)
            .filter(t => !!t),
        ),
      ].slice(0, MAX_TAGS)
    : []
  if (tags.length) annotation.tags = tags

  const somethingSurvived =
    annotation.title ||
    annotation.summary ||
    annotation.whatItAnswers ||
    annotation.covers ||
    annotation.published ||
    annotation.category ||
    annotation.organization ||
    annotation.shape ||
    annotation.tags
  return somethingSurvived ? annotation : null
}

// --- The pass -------------------------------------------------------------

export interface AnnotateOptions {
  /** Tests pass a stub; nothing else passes anything. */
  client?: AnthropicLike
  /** The dropping user's IP: the spend is attributed to them (P5-41's
   *  reserve/settle), because the pass happens on their behalf. */
  clientIp?: string
  entry?: CatalogEntryRow
  /** Text to read when the entry holds no readable file of its own. */
  text?: Pages
}

/**
 * Read the entry's document and describe how to file it.
 *
 * Null when there is nothing to read — a scanned image with no text layer is
 * the spec's own example, and it is not a failure: the entry still exists with
 * its filename title and the person is told why there is no more than that.
 */
export async function annotateEntry(slug: string, options: AnnotateOptions = {}): Promise<AnnotateOutcome | null> {
  const entry = options.entry ?? (await getCatalogEntry(slug))
  if (!entry) return null
  const pages = options.text ?? (await firstPages(entry))
  if (!pages) return null

  const at = new Date().toISOString()
  const model = askModel()
  const answer = await callAssistant({
    label: `annotation for ${slug}`,
    system: buildAnnotateSystemPrompt(),
    user: buildAnnotateUserMessage({ file: pages.file, text: pages.text, currentTitle: entry.title }),
    maxTokens: annotateMaxTokens(),
    model,
    client: options.client,
    clientIp: options.clientIp,
  })
  if (isAssistantError(answer)) return { error: 'unavailable', at, reason: answer.code }
  const annotation = parseAnnotation(answer.text, model, at)
  if (!annotation) return { error: 'unavailable', at }
  return pages.basis ? { ...annotation, basis: pages.basis } : annotation
}

/**
 * Store the annotation as the entry's suggestion.
 *
 * `meta.suggested` is the field every surface already reads for "proposed, not
 * applied" — the entry page's panel, the list row's badge, P5-83's "no summary
 * yet". Writing the wider answer there rather than beside it means one
 * vocabulary for one idea, and Accept stays the one existing filing call.
 *
 * Title, category, tags and status are NOT touched. That is the rule.
 */
export async function writeAnnotation(slug: string, outcome: AnnotateOutcome): Promise<boolean> {
  const stored = await patchEntryManifest(slug, meta => ({ ...meta, suggested: outcome }))
  // Ask reads a cached index that is otherwise only rebuilt at reindex; a
  // summary written this minute has to be findable this minute (P5-47's rule).
  if (stored) clearKbIndex()
  return !!stored
}
