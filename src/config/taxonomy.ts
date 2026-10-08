/**
 * One taxonomy for the whole system (P5-63).
 *
 * Nick, 2026-09-07: *"we should be categorizing datasets / tagging them, we
 * already do this on the public layers so we should be building on that."*
 *
 * Before this file there were three vocabularies. The public map had
 * `LayerCategory` with plain labels ("People", "Jobs and income"); the library
 * had a free-word `category` that mixed subject with purpose (`strategy`,
 * `land`, `ideas`); sources had their own `topics` plus free tags. Nothing
 * mapped between them, so "what do we have on water" had three answers.
 *
 * There are now three kinds of word, and each one answers a different
 * question:
 *
 *  - **Topic** — what a thing is ABOUT. The eight public layer categories are
 *    members of this list (`layerCategory` says which), joined by the subjects
 *    the library carries that the map does not.
 *  - **Purpose** — what a document or a note is FOR. A plan is `strategy`
 *    whatever it is about. Purposes live in the same `category` field as
 *    topics for backward compatibility; this module is what says which is
 *    which.
 *  - **Tag** — anything else, kebab-case, free. An alias table folds the
 *    spellings we have collected into one, and a tag that plainly names a
 *    topic (`environmental`) folds into the topic; `environmental-risk` is a
 *    cross-cutting screening tag and stays as it is.
 *
 * An entry's topic is DERIVED, never stored twice: its `category` when that is
 * a topic, otherwise the first of its tags that is one (`topicFor`). That is
 * why a `research` brief tagged `land` files under Land without anybody
 * editing a manifest.
 *
 * ## This module ships in the PUBLIC bundle
 *
 * `src/lib/publicLayers.ts` reads its labels from here, and the public map
 * reaches that. So everything below is deliberately generic: topic ids,
 * plain-word labels, and tags that are ordinary English. No dataset name, no
 * entry slug and no initiative name belongs in this file — the bundle-leak
 * gate (`scripts/check-bundle-leaks.mjs`) enforces the ones we have named, and
 * the rule is wider than the gate.
 *
 * The server reads the same table from `server/src/prompt/taxonomy.generated.json`,
 * written by `npm run export:layers`. A stale export fails a test on both
 * sides.
 */
import type { LayerCategory } from './layerRegistry'

// --- Topics ---------------------------------------------------------------

export interface Topic {
  id: string
  /** Plain words, shown to a reader. Never the id. */
  label: string
  /** One line: what belongs under this topic. */
  description: string
  /** Set when this topic IS one of the public map's layer categories. */
  layerCategory?: LayerCategory
  /** Offered as chips on the filing forms and to the model as a first choice. */
  suggestedTags: string[]
}

/**
 * The subject spine, in reading order: the map's own categories first (the
 * headline index, then the ones people ask about most), then the subjects the
 * library carries that the map has no layer for.
 */
export const TOPICS: Topic[] = [
  {
    id: 'composite',
    label: 'Overall index',
    description: 'The combined livability score and the rankings built from it.',
    layerCategory: 'composite',
    suggestedTags: ['index', 'score', 'ranking'],
  },
  {
    id: 'demographic',
    label: 'People',
    description: 'Who lives somewhere: population, race, age, households.',
    layerCategory: 'demographic',
    suggestedTags: ['population', 'race', 'households', 'migration'],
  },
  {
    id: 'economic',
    label: 'Jobs and income',
    description: 'Work, wages, income, poverty and local business.',
    layerCategory: 'economic',
    suggestedTags: ['wages', 'jobs', 'income', 'poverty', 'business'],
  },
  {
    id: 'housing',
    label: 'Housing',
    description: 'Homes: what they cost, who owns them, what they are taxed.',
    layerCategory: 'housing',
    suggestedTags: ['home-values', 'ownership', 'rent', 'property-tax'],
  },
  {
    id: 'equity',
    label: 'Equity',
    description: 'Gaps between groups, and who is carrying them.',
    layerCategory: 'equity',
    suggestedTags: ['disparity', 'access', 'environmental-justice'],
  },
  {
    id: 'transportation',
    label: 'Getting to work',
    description: 'Commutes, transit and how people travel.',
    layerCategory: 'transportation',
    suggestedTags: ['commute', 'transit', 'roads'],
  },
  {
    id: 'environment',
    label: 'Environment',
    description: 'Pollution, contamination, cleanups and environmental risk.',
    layerCategory: 'environment',
    suggestedTags: ['air', 'contamination', 'pollution', 'cleanup'],
  },
  {
    id: 'health',
    label: 'Health',
    description: 'Health outcomes and getting to care.',
    layerCategory: 'health',
    suggestedTags: ['life-expectancy', 'access-to-care', 'chronic-disease'],
  },
  {
    id: 'land',
    label: 'Land',
    description: 'Parcels, ownership, conservation and tangled title.',
    suggestedTags: ['ownership', 'parcels', 'conservation', 'public-land'],
  },
  {
    id: 'water',
    label: 'Water',
    description: 'Rivers, groundwater, wetlands and drinking water.',
    suggestedTags: ['groundwater', 'wells', 'watershed', 'wetlands', 'drinking-water'],
  },
  {
    id: 'hazards',
    label: 'Hazards',
    description: 'Flood, fire, storm and the other things that can go wrong.',
    suggestedTags: ['flood', 'wildfire', 'storm', 'pipelines'],
  },
  {
    id: 'agriculture',
    label: 'Agriculture and food',
    description: 'Farms, soil, crops and food.',
    suggestedTags: ['soil', 'food', 'farms', 'crops', 'seeds'],
  },
  {
    id: 'places',
    label: 'Places',
    description: 'Places on the ground: gardens, green resources, sibling maps.',
    suggestedTags: ['gardens', 'sites', 'facilities'],
  },
  {
    id: 'network',
    label: 'Network',
    description: 'Organizations, individuals and the people we work with.',
    suggestedTags: ['organizations', 'funders', 'partners', 'contacts'],
  },
]

// --- Purposes -------------------------------------------------------------

export interface Purpose {
  id: string
  label: string
  description: string
}

/**
 * What a document or a note is FOR. A five-year plan is `strategy` whether it
 * is about land or about money, so this is a second axis, not more topics.
 */
export const PURPOSES: Purpose[] = [
  { id: 'strategy', label: 'Strategy', description: 'Plans, budgets and the case for doing something.' },
  { id: 'research', label: 'Research', description: 'Evidence: briefs, fact manuals, studies, primary sources.' },
  { id: 'outreach', label: 'Outreach', description: 'What we send out: invitations, one-pagers, catalogs, images.' },
  { id: 'ideas', label: 'Ideas', description: 'Improvement requests and ideas, open → planned → done.' },
]

// --- Shapes ---------------------------------------------------------------

export interface Shape {
  id: string
  label: string
  description: string
}

/**
 * What KIND OF THING a dataset is (P6-2) — the third cut on the datasets
 * browser, beside organization and topic.
 *
 * Not a subject and not a purpose: a reader asking "where are the parcel
 * boundaries" and a reader asking "what can I chart by county" are asking
 * about the same fourteen subjects in two different shapes, and the answer
 * used to require opening every entry.
 *
 * Five cuts, in plain words, because the reader is a researcher and not a GIS
 * analyst. `lines` is the fifth and was added by P9-8: a transmission corridor
 * is drawn geometry but it is not an area, and with four cuts it fell through
 * every branch to `records` — so the map drew 3,477 LineStrings while the
 * entry page called them "Records without a location". Folding them into
 * `areas` instead would have been a second lie, to anyone filtering for
 * parcels and flood zones. Derived once at reindex from what an entry already carries — its
 * layer block, a source's `placeQuery.by`, a held table's columns — and
 * overridable with `shape:` in the manifest when the derivation reads it
 * wrong.
 */
export const SHAPES: Shape[] = [
  {
    id: 'areas',
    label: 'Areas and boundaries',
    description: 'Shapes on the ground: parcels, flood zones, wetlands, easements, service areas.',
  },
  {
    id: 'points',
    label: 'Sites and points',
    description: 'Individual sites or facilities with coordinates: contaminated sites, tanks, mines, organizations.',
  },
  {
    id: 'statistics',
    label: 'Statistics by county or tract',
    description: 'Values aggregated by area: the public map layers, survey estimates, an index.',
  },
  {
    id: 'lines',
    label: 'Lines and networks',
    description: 'Infrastructure that runs between places: transmission lines, pipelines, rail, roads.',
  },
  {
    id: 'records',
    label: 'Records without a location',
    description: 'A directory, a survey extract, a table with no coordinates and no area codes.',
  },
]

// --- Coverage -------------------------------------------------------------

export interface CoverageScope {
  id: string
  label: string
  description: string
}

/**
 * HOW MUCH GROUND a dataset covers (P6-19) — the fourth cut on the datasets
 * browser, beside organization, topic and shape.
 *
 * Shape's sibling, and derived the same way: a closed vocabulary of scopes,
 * worked out at every reindex from what the entry already carries (its held
 * table's GEOIDs, a source block's own `coverage`, its publisher's name) and
 * overridable with `coverage:` in the manifest when a reading is wrong.
 *
 * The scope is only half the answer — the other half is WHICH states, which
 * is a fact about the United States rather than a vocabulary, and lives in
 * `stateFips.ts`. A dataset covering one state is filed under that state's own
 * name; the scopes below are what a reader is offered when no single state
 * names it.
 *
 * Nothing determinable is deliberately NOT a scope. A dataset whose ground
 * nobody can work out carries no coverage at all and is counted on the admin
 * queue as "Datasets with no coverage" — the one thing we must never do is
 * quietly call it national.
 */
export const COVERAGE_SCOPES: CoverageScope[] = [
  {
    id: 'national',
    label: 'National',
    description: 'The whole country: a nationwide table, or a federal programme that publishes for every state.',
  },
  {
    id: 'multi-state',
    label: 'Several states',
    description: 'More than one state and less than the country — a regional dataset, or a table whose rows span a handful of states.',
  },
  {
    id: 'state',
    label: 'One state',
    description: 'A single state: a state agency’s own register, or a table whose rows are all in one state.',
  },
  {
    id: 'county',
    label: 'Named counties',
    description: 'Particular counties inside one state, named rather than implied.',
  },
  {
    id: 'local',
    label: 'Local area',
    description: 'A city or a neighbourhood: points we hold without being able to say which state they fall in.',
  },
]

// --- Tags -----------------------------------------------------------------

/**
 * Spellings we have collected, folded into one word each.
 *
 * Two kinds live here and both are deliberate:
 *  - plurals and variants (`flooding` → `flood`), which are the same word;
 *  - tags that plainly name a topic (`environmental` → `environment`,
 *    `demographics` → `demographic`), which is what makes a tagged entry file
 *    under the right topic without a manifest edit.
 *
 * Every value must itself be a canonical word — normalising twice must not
 * move it again. A test asserts that, and that no suggested or cross-cutting
 * tag is also a key here (a tag we recommend and then rewrite is a bug).
 */
export const TAG_ALIASES: Record<string, string> = {
  // Plurals and spellings of the same word.
  flooding: 'flood',
  floods: 'flood',
  wildfires: 'wildfire',
  hazard: 'hazards',
  soils: 'soil',
  farm: 'farms',
  farmland: 'farms',
  parcel: 'parcels',
  well: 'wells',
  watersheds: 'watershed',
  garden: 'gardens',
  site: 'sites',
  organisations: 'organizations',
  orgs: 'organizations',
  idea: 'ideas',
  // Words that name a topic we already have.
  demographics: 'demographic',
  demography: 'demographic',
  economy: 'economic',
  economics: 'economic',
  transport: 'transportation',
  environmental: 'environment',
  'water-quality': 'water',
  farming: 'agriculture',
  agricultural: 'agriculture',
  ag: 'agriculture',
  place: 'places',
  'land-ownership': 'ownership',
  // Category spellings the library grew before this table existed. Verbatim
  // historical texts are research material — what they are FOR — and their
  // subject rides in the tags.
  'primary-sources': 'research',
}

/**
 * Tags that mean something under any topic, so they are worth offering
 * everywhere rather than under one heading.
 *
 * `sensitive` is a handling instruction, not a subject; the other two are
 * questions we ask of material across the whole library.
 */
export const CROSS_TAGS: string[] = [
  // Nick's screening question is literally "environmental risks": the tag spans
  // environment, water and hazards, so it is cross-cutting, not a topic alias.
  'environmental-risk',
  'site-selection',
  'heirs-property',
  'sensitive',
]

// --- Helpers ---------------------------------------------------------------

const TOPIC_BY_ID = new Map(TOPICS.map(t => [t.id, t]))
const PURPOSE_BY_ID = new Map(PURPOSES.map(p => [p.id, p]))
const SHAPE_BY_ID = new Map(SHAPES.map(s => [s.id, s]))
const COVERAGE_SCOPE_BY_ID = new Map(COVERAGE_SCOPES.map(s => [s.id, s]))

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

/** Kebab-case, lowercase, nothing but letters, digits and single hyphens. */
function kebab(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * One tag, written the one way. Unknown words come back cleaned but
 * unchanged — a free tag is still a tag, and refusing it would lose what
 * somebody meant.
 */
export function normalizeTag(tag: string): string {
  const clean = kebab(tag)
  return TAG_ALIASES[clean] ?? clean
}

/**
 * One category id, written the one way. The result is a topic id, a purpose
 * id, or — when we have never seen the word — the cleaned word itself, kept
 * so nothing is silently thrown away.
 */
export function normalizeCategory(id: string): string {
  return normalizeTag(id)
}

export function topicLabel(id: string): string {
  return TOPIC_BY_ID.get(id)?.label ?? id
}

export function purposeLabel(id: string): string {
  return PURPOSE_BY_ID.get(id)?.label ?? id
}

/** The label for a topic OR a purpose, for the one place that shows either. */
export function categoryLabel(id: string): string {
  return TOPIC_BY_ID.get(id)?.label ?? PURPOSE_BY_ID.get(id)?.label ?? id
}

export function topicForLayerCategory(category: string): string | null {
  return TOPICS.find(t => t.layerCategory === category)?.id ?? null
}

export function suggestedTagsFor(topicId: string): string[] {
  return TOPIC_BY_ID.get(topicId)?.suggestedTags ?? []
}

export const TOPIC_IDS: string[] = TOPICS.map(t => t.id)
export const PURPOSE_IDS: string[] = PURPOSES.map(p => p.id)
export const SHAPE_IDS: string[] = SHAPES.map(s => s.id)
export const COVERAGE_SCOPE_IDS: string[] = COVERAGE_SCOPES.map(s => s.id)

/**
 * What an entry is ABOUT, from what it already carries.
 *
 * Its category when that is a topic; otherwise the first of its tags that is
 * one — which is how a `research` brief tagged `land` lands under Land with
 * no manifest edit. Null means nobody has said, and the admin queue counts it.
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
