import taxonomy from '../prompt/taxonomy.generated.json' with { type: 'json' }

/**
 * The server's half of the one taxonomy (P5-63).
 *
 * The vocabulary itself lives in `src/config/taxonomy.ts` on the client, which
 * is where a person edits it; `npm run export:layers` writes it here as plain
 * data. The server cannot import the client's TypeScript at runtime, and a
 * second hand-kept copy would drift within a week — the same reason
 * `publicLayers.generated.json` exists. A stale export fails a test on both
 * sides.
 *
 * Everything below is the same handful of helpers the client has, reading the
 * generated table. Nothing here decides what the vocabulary IS.
 */

export interface Topic {
  id: string
  label: string
  description: string
  layerCategory?: string
  suggestedTags: string[]
}

export interface Purpose {
  id: string
  label: string
  description: string
}

/** P6-2: what kind of thing a dataset is — areas, points, statistics, records. */
export interface Shape {
  id: string
  label: string
  description: string
}

/** P6-19: how much ground a dataset covers — national, multi-state, state,
 *  county, local. Shape's sibling; the derivation is in `coverage.ts`. */
export interface CoverageScope {
  id: string
  label: string
  description: string
}

/**
 * P6-19: the United States, as the three spellings a coverage reading needs —
 * the 2-digit FIPS that begins a county GEOID, the postal code a person
 * writes, and the name a heading reads. A fact table rather than a
 * vocabulary, and the client's `src/config/stateFips.ts` is where it is
 * edited.
 */
export interface UsState {
  fips: string
  code: string
  name: string
}

export const TOPICS: Topic[] = taxonomy.topics as Topic[]
export const PURPOSES: Purpose[] = taxonomy.purposes as Purpose[]
export const SHAPES: Shape[] = taxonomy.shapes as Shape[]
export const COVERAGE_SCOPES: CoverageScope[] = taxonomy.coverageScopes as CoverageScope[]
export const US_STATES: UsState[] = taxonomy.states as UsState[]
export const TAG_ALIASES: Record<string, string> = taxonomy.tagAliases as Record<string, string>
export const CROSS_TAGS: string[] = taxonomy.crossTags as string[]

export const TOPIC_IDS: string[] = TOPICS.map(t => t.id)
export const PURPOSE_IDS: string[] = PURPOSES.map(p => p.id)
export const SHAPE_IDS: string[] = SHAPES.map(s => s.id)
export const COVERAGE_SCOPE_IDS: string[] = COVERAGE_SCOPES.map(s => s.id)
/** Every id a `category` field is allowed to hold. */
export const CATEGORY_IDS: string[] = [...TOPIC_IDS, ...PURPOSE_IDS]

const TOPIC_BY_ID = new Map(TOPICS.map(t => [t.id, t]))
const PURPOSE_BY_ID = new Map(PURPOSES.map(p => [p.id, p]))
const SHAPE_BY_ID = new Map(SHAPES.map(s => [s.id, s]))
const COVERAGE_SCOPE_BY_ID = new Map(COVERAGE_SCOPES.map(s => [s.id, s]))
const STATE_BY_FIPS = new Map(US_STATES.map(s => [s.fips, s]))
const STATE_BY_CODE = new Map(US_STATES.map(s => [s.code, s]))
const STATE_BY_FOLDED_NAME = new Map(US_STATES.map(s => [s.name.toLowerCase(), s]))

export function isTopic(id: string): boolean {
  return TOPIC_BY_ID.has(id)
}

export function isPurpose(id: string): boolean {
  return PURPOSE_BY_ID.has(id)
}

export function isShape(id: string): boolean {
  return SHAPE_BY_ID.has(id)
}

/** Plain words for a shape, or the word itself when we do not know it. */
export function shapeLabel(id: string): string {
  return SHAPE_BY_ID.get(id)?.label ?? id
}

export function isCoverageScope(id: string): boolean {
  return COVERAGE_SCOPE_BY_ID.has(id)
}

/** Plain words for a coverage scope, or the word itself when we do not know it. */
export function coverageScopeLabel(id: string): string {
  return COVERAGE_SCOPE_BY_ID.get(id)?.label ?? id
}

/** The postal code for a 2-digit FIPS prefix, or '' when it names no state. */
export function stateCodeForFips(fips: string): string {
  return STATE_BY_FIPS.get(fips.trim())?.code ?? ''
}

/** The name for a postal code, or '' when it names no state. */
export function stateNameForCode(code: string): string {
  return STATE_BY_CODE.get(code.trim().toUpperCase())?.name ?? ''
}

/**
 * A state's postal code, from however it was written: a code (`ga`, `GA`), a
 * name (`Georgia`) or a FIPS prefix (`13`). '' when nothing matches — never a
 * guess, because a wrong state is worse than no state.
 */
export function stateCodeFor(text: string): string {
  const value = text.trim()
  if (!value) return ''
  if (/^\d{2}$/.test(value)) return stateCodeForFips(value)
  const upper = value.toUpperCase()
  if (STATE_BY_CODE.has(upper)) return upper
  return STATE_BY_FOLDED_NAME.get(value.toLowerCase())?.code ?? ''
}

/**
 * A state's **2-digit FIPS**, from however it was written — the direction
 * P6-19's table did not yet expose, and the one a state-level layer needs
 * (P7-9): the geometry is keyed by the FIPS prefix of a county GEOID, and a
 * dataset keyed by `GA`, `Georgia` or `13` has to reach it.
 *
 * One spelling is forgiven here that `stateCodeFor` does not forgive, and only
 * here: a FIPS written as `1` or `1.0`, which is what a spreadsheet does to
 * `01` the moment it decides the column is a number. That is P7-5's lesson
 * about `normalizeGeoId` — a leading zero a tool dropped is not a different
 * state. A fraction that is not zeros is a real fraction and still not an id.
 */
export function stateFipsFor(text: string): string {
  const value = text.trim().replace(/\.0+$/, '')
  if (!value) return ''
  const padded = /^\d{1,2}$/.test(value) ? value.padStart(2, '0') : value
  if (STATE_BY_FIPS.has(padded)) return padded
  const code = stateCodeFor(padded)
  return code ? STATE_BY_CODE.get(code)?.fips ?? '' : ''
}

function kebab(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** One tag, written the one way. An unknown word comes back cleaned but
 *  unchanged — a free tag is still a tag. */
export function normalizeTag(tag: string): string {
  const clean = kebab(tag)
  return TAG_ALIASES[clean] ?? clean
}

/** Tags normalised, de-duplicated, blanks dropped, order preserved. */
export function normalizeTags(tags: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const tag = normalizeTag(raw)
    if (tag && !out.includes(tag)) out.push(tag)
  }
  return out
}

export function normalizeCategory(id: string): string {
  return normalizeTag(id)
}

/**
 * A data source's `topics` are the publisher's own words — "underground
 * storage tanks", "303(d) list", "PFAS" — and they earn their place by being
 * searchable prose, not tags. So only the ones that plainly name a taxonomy
 * word are folded into it; everything else is left exactly as it was written.
 *
 * Kebab-casing them all would turn "impaired waters" into
 * `impaired-waters` and make the entry read like a machine wrote it.
 */
export function normalizeSourceTopic(word: string): string {
  const clean = kebab(word)
  const folded = TAG_ALIASES[clean] ?? clean
  if (isTopic(folded) || isPurpose(folded) || CROSS_TAGS.includes(folded)) return folded
  return word.trim()
}

/** Source topics folded where they name a taxonomy word, de-duplicated. */
export function normalizeSourceTopics(topics: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of topics) {
    if (typeof raw !== 'string') continue
    const topic = normalizeSourceTopic(raw)
    if (topic && !out.includes(topic)) out.push(topic)
  }
  return out
}

export function topicLabel(id: string): string {
  return TOPIC_BY_ID.get(id)?.label ?? id
}

export function purposeLabel(id: string): string {
  return PURPOSE_BY_ID.get(id)?.label ?? id
}

export function categoryLabel(id: string): string {
  return TOPIC_BY_ID.get(id)?.label ?? PURPOSE_BY_ID.get(id)?.label ?? id
}

export function topicForLayerCategory(category: string): string | null {
  return TOPICS.find(t => t.layerCategory === category)?.id ?? null
}

export function suggestedTagsFor(topicId: string): string[] {
  return TOPIC_BY_ID.get(topicId)?.suggestedTags ?? []
}

export function topicById(id: string): Topic | undefined {
  return TOPIC_BY_ID.get(id)
}

/**
 * What an entry is ABOUT: its category when that is a topic, otherwise the
 * first of its tags that is one. Null means nobody has said — which is what
 * the admin queue's "Entries with no topic" row counts.
 */
export function topicFor(category: string | undefined | null, tags: readonly string[] = []): string | null {
  const normalised = normalizeCategory(category ?? '')
  if (isTopic(normalised)) return normalised
  for (const tag of tags) {
    const candidate = normalizeTag(tag)
    if (isTopic(candidate)) return candidate
  }
  return null
}

/** What an entry is FOR, when its category says so. */
export function purposeFor(category: string | undefined | null): string | null {
  const normalised = normalizeCategory(category ?? '')
  return isPurpose(normalised) ? normalised : null
}

/** Every tag worth offering under one topic: its own, then the cross-cutting
 *  ones, de-duplicated and in that order. */
export function tagChoicesFor(topicId: string): string[] {
  return [...new Set([...suggestedTagsFor(topicId), ...CROSS_TAGS])]
}

/**
 * The kinds an entry's topic is a real question for.
 *
 * A wiki page IS the knowledge base rather than a category of it (P5-14), and
 * a saved view's category is the machine word `views`. Counting either as
 * "uncategorised" would put rows on the admin queue that nobody can clear.
 */
export const TOPICABLE_KINDS = ['dataset', 'document', 'incoming', 'note', 'source'] as const

export function isTopicable(kind: string): boolean {
  return (TOPICABLE_KINDS as readonly string[]).includes(kind)
}

/** One line for the Ask system prompt: the topics the library files by. */
export function topicsSentence(): string {
  return `Topics the library files by: ${TOPICS.map(t => `${t.id} (${t.label})`).join(', ')}.`
}
