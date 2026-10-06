import { promises as fs } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { callAssistant, hasApiKey, isAssistantError, jsonObjectIn, type AnthropicLike } from '../services/assistantCall.js'
import {
  CATEGORY_IDS,
  TOPICS,
  isPurpose,
  isTopic,
  normalizeCategory,
  normalizeTags,
  topicFor,
} from '../services/taxonomy.js'
import { ORGANIZATION_IDS, isOrganizationId, organizationForMeta, organizationLabel, providerTextOf } from '../services/organizations.js'
import { deriveShape, isShapedKind, type ShapeId } from '../services/shape.js'
import { readCoverage, type Coverage } from '../services/coverage.js'
import { COVERAGE_SCOPE_IDS, coverageScopeLabel, stateNameForCode } from '../services/taxonomy.js'

/**
 * `npm run library -- retag --dir <path> [--apply]` (P5-63).
 *
 * The taxonomy was written to fit what the library already holds, but the
 * manifests were written before it existed: `demographics` beside
 * `demographic`, `primary-sources` where `research` was meant, `Flooding` and
 * `flood` on neighbouring entries. This is the migration, and it is explicit
 * on purpose — Nick reads the report, then applies it.
 *
 *  - **Dry run (the default)** prints a table and writes
 *    `<dir>/retag-report.md`. Nothing on disk changes.
 *  - **`--apply`** rewrites the `category` and `tags` of each manifest that
 *    needs it. Wiki pages and saved views are never touched: a page has no
 *    manifest and a view's category is a machine word.
 *
 * P6-1 and P6-2 add two more passes to the same tool, each behind its own
 * flag, because they are the same job on the same tree:
 *
 *  - **`--organizations`** folds every manifest's publisher — a source
 *    block's `provider`, or the free `source` prose a dataset carries —
 *    through the organization vocabulary, and writes
 *    `<dir>/retag-organizations.md`. With `--apply` the resolved id is written
 *    into the manifest as `organization`. A publisher the vocabulary does not
 *    know is reported and NOT written: the fix is an alias, not a manifest.
 *  - **`--shapes`** works out what kind of thing each dataset and source is
 *    (areas · points · statistics · records) and writes
 *    `<dir>/retag-shapes.md`. Report only, never applied: the shape is derived
 *    at every reindex, and freezing today's derivation into a manifest would
 *    stop it ever improving. `shape:` in a manifest is for correcting one.
 *  - **`--coverage`** (P6-19) works out how much ground each dataset and
 *    source covers — national, several states, one state, local, or nothing
 *    determinable — and writes `<dir>/retag-coverage.md` with the distribution
 *    and the state counts. Report only, for the same reason as `--shapes`,
 *    and more so: coverage improves every time a table gains a GEOID column.
 *
 * Purely local: no bucket, no database, no network unless a key is set and
 * there are entries whose topic has to be guessed from a title. Which is the
 * point — the push tree on a laptop is the thing being fixed.
 */

/** Manifests we rewrite. Flat wiki `.md` and view `.json` files have no
 *  manifest to rewrite, and the taxonomy has nothing to say about them. */
const MANIFEST = 'meta.json'

/** Entry kinds, from the folder the manifest sits in. */
const KIND_BY_FOLDER: Record<string, string> = {
  datasets: 'dataset',
  documents: 'document',
  incoming: 'incoming',
  notes: 'note',
  sources: 'source',
}

export interface RetagRow {
  slug: string
  kind: string
  path: string
  category: string
  newCategory: string
  tags: string[]
  newTags: string[]
  /** The topic the entry ends up with, or null when nothing names one. */
  topic: string | null
  /** A topic nobody has stated, worked out here. Never applied silently — it
   *  becomes a tag, which is what the derived topic reads. */
  proposedTopic: string | null
  proposedFrom: 'tags' | 'title' | null
  /** A category the taxonomy has never heard of. Kept, flagged, never guessed
   *  away: the vocabulary is allowed to grow and this is how we find out. */
  unknownCategory: boolean
  /** P6-1: what the manifest's `organization` field says today ('' when it
   *  has none). */
  organization: string
  /** The publisher prose the proposal was read out of, shown in the report so
   *  a wrong reading is obvious without opening the manifest. */
  providerText: string
  /** What the entry would be filed under: a vocabulary id, or an unknown
   *  publisher's own text. '' when the manifest names nobody at all. */
  proposedOrganization: string
  /** P6-2: the manifest's `shape:` today, and what the derivation makes of the
   *  entry. Null on a kind the browser does not group by shape. */
  shape: string
  proposedShape: ShapeId | null
  /** P6-19: the manifest's `coverage:` today, what the derivation makes of the
   *  entry, and the one phrase naming what that reading was made from. */
  coverage: string
  proposedCoverage: Coverage | null
  coverageFrom: string
}

export interface RetagResult {
  rows: RetagRow[]
  changed: RetagRow[]
  proposed: RetagRow[]
  unknown: RetagRow[]
  applied: string[]
  reportPath: string
  /** Set when a title-based proposal was wanted and could not be made. */
  modelNote?: string
  /** P6-1, when `--organizations` ran: where the report went, the entries
   *  whose manifest would gain or change an `organization`, and the ones whose
   *  publisher the vocabulary does not know. */
  organizationReportPath?: string
  organizationChanged?: RetagRow[]
  organizationUnknown?: RetagRow[]
  /** P6-2, when `--shapes` ran: where the report went, and the rows it
   *  covers (datasets and sources). */
  shapeReportPath?: string
  shaped?: RetagRow[]
  /** P6-19, when `--coverage` ran: where the report went, and the rows it
   *  covers (datasets and sources). */
  coverageReportPath?: string
  covered?: RetagRow[]
}

/** Every `<kind>/<slug>/meta.json` under `<dir>/library/`. */
export async function findManifests(localDir: string): Promise<string[]> {
  const root = join(localDir, 'library')
  const out: string[] = []
  for (const folder of Object.keys(KIND_BY_FOLDER)) {
    const base = join(root, folder)
    let slugs: string[]
    try {
      slugs = await fs.readdir(base)
    } catch {
      continue // a tree need not hold every kind
    }
    for (const slug of slugs.sort()) {
      if (slug.startsWith('.')) continue
      const path = join(base, slug, MANIFEST)
      try {
        await fs.stat(path)
        out.push(path)
      } catch {
        /* a folder with no manifest is somebody's work in progress */
      }
    }
  }
  return out
}

function kindOf(path: string, localDir: string): string {
  const parts = relative(join(localDir, 'library'), path).split(sep)
  return KIND_BY_FOLDER[parts[0]] ?? parts[0]
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Read one manifest and work out what it should say. No writing here. */
export async function planOne(path: string, localDir: string): Promise<RetagRow | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8'))
  } catch {
    console.warn(`[retag] ${path}: not valid JSON — skipped`)
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const meta = parsed as Record<string, unknown>
  const slug = dirname(path).split(sep).pop() ?? ''
  const category = typeof meta.category === 'string' ? meta.category : ''
  const tags = asStringArray(meta.tags)
  const newCategory = normalizeCategory(category)
  const newTags = normalizeTags(tags)
  const topic = topicFor(newCategory, newTags)
  return {
    slug,
    kind: kindOf(path, localDir),
    path,
    category,
    newCategory,
    tags,
    newTags,
    topic,
    proposedTopic: null,
    proposedFrom: null,
    unknownCategory: !!newCategory && !isTopic(newCategory) && !isPurpose(newCategory),
    // P6-1: free, and read from the same manifest we already have open, so it
    // is worked out on every run and reported only when asked for.
    organization: typeof meta.organization === 'string' ? meta.organization.trim() : '',
    providerText: providerTextOf(meta),
    proposedOrganization: organizationForMeta(meta),
    // P6-2: the manifest's own word now; the derivation needs the entry's
    // table, so it runs in its own pass (`--shapes`).
    shape: typeof meta.shape === 'string' ? meta.shape.trim() : '',
    proposedShape: null,
    // P6-19: same again — a stated `coverage:` is free to read here; the
    // derivation needs the entry's table, so it runs in `--coverage`.
    coverage: typeof meta.coverage === 'string' ? meta.coverage.trim() : '',
    proposedCoverage: null,
    coverageFrom: '—',
  }
}

/**
 * P6-2 and P6-19: what each dataset and source would be called, and how much
 * ground it covers.
 *
 * Reads the entry's own table when the manifest cannot say — locally, off the
 * disk the tree is on, which is the whole point of running this before a push.
 *
 * One pass for both questions because they are the same disk work: the same
 * folder listing, the same manifest, and the same data file, which the reader
 * below hands out once however many derivations ask for it. Returns the rows
 * it looked at, which are the dataset-shaped kinds — a page or a note is
 * neither shaped nor covered.
 */
export async function planEntries(rows: RetagRow[], options: { shapes?: boolean; coverage?: boolean }): Promise<RetagRow[]> {
  const looked: RetagRow[] = []
  for (const row of rows) {
    if (!isShapedKind(row.kind)) continue
    const folder = dirname(row.path)
    let files: string[] = []
    try {
      files = await fs.readdir(folder)
    } catch {
      /* the manifest was there a moment ago; treat it as an entry with no files */
    }
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(await fs.readFile(row.path, 'utf8')) as Record<string, unknown>
    } catch {
      /* planOne already warned; an unreadable manifest derives from nothing */
    }
    const input = { kind: row.kind, meta, files, slug: row.slug }
    const read = readOnce(folder)
    if (options.shapes) row.proposedShape = await deriveShape(input, read)
    if (options.coverage) {
      const reading = await readCoverage(input, read)
      row.proposedCoverage = reading.coverage
      row.coverageFrom = reading.from
    }
    looked.push(row)
  }
  return looked
}

/** One file, read once, however many derivations ask for it. Both passes pick
 *  the same table, and a 20 MB CSV is not worth pulling off the disk twice. */
function readOnce(folder: string): (name: string) => Promise<string | null> {
  const seen = new Map<string, Promise<string | null>>()
  return name => {
    const cached = seen.get(name)
    if (cached) return cached
    const reading = fs.readFile(join(folder, name), 'utf8').catch(() => null)
    seen.set(name, reading)
    return reading
  }
}

/**
 * A topic for an entry that has none, from the words it already carries.
 *
 * Tried before the model, because it costs nothing and it is checkable: a tag
 * or a title word that IS a topic's own suggested tag says what the entry is
 * about at least as well as a guess would. Returns null when the words say
 * nothing.
 */
export function topicFromWords(row: RetagRow): string | null {
  const haystack = ` ${[...row.newTags, row.slug.replace(/-/g, ' ')].join(' ').toLowerCase()} `
  for (const topic of TOPICS) {
    for (const tag of topic.suggestedTags) {
      if (haystack.includes(` ${tag} `) || haystack.includes(` ${tag.replace(/-/g, ' ')} `)) return topic.id
    }
  }
  return null
}

// --- Asking the model for the hard ones --------------------------------------

const TOPIC_PROMPT_MAX = 40

export function buildRetagSystemPrompt(): string {
  return [
    'You help a small research team file documents into their internal library.',
    'You are given a list of document titles and the subjects the library files by.',
    'Answer with a single JSON object and nothing else.',
  ].join(' ')
}

export function buildRetagUserMessage(rows: RetagCandidate[]): string {
  return [
    'Subjects, with what each covers:',
    ...TOPICS.map(t => `- ${t.id} (${t.label}): ${t.description}`),
    '',
    'Documents, with the tags they already carry:',
    ...rows.map(r => `- ${r.slug}: ${r.title}${r.tags?.length ? ` [tags: ${r.tags.join(', ')}]` : ''}`),
    '',
    'Reply with only a JSON object mapping each slug to ONE subject id from the list above.',
    'Answer for every document whose title or tags point at a subject, even loosely — a document about a campus of farms and homes is land, a document about who funds the work is network.',
    'Leave a slug out ONLY when nothing about it names a subject at all (an invitation, a set of illustrations, a budget).',
    '{"some-slug": "land"}',
  ].join('\n')
}

/**
 * One call for every entry that needs a guess, rather than one per entry.
 *
 * Titles are short and the subject list is fixed, so the whole job fits in a
 * single message — which makes the pass cheap enough to run on a whole tree
 * and, more usefully, consistent across it: the model sees the entries beside
 * each other and files them as a set.
 */
export interface RetagCandidate {
  slug: string
  title: string
  tags?: string[]
}

export interface TopicProposals {
  topics: Record<string, string>
  /** Why nothing came back, when nothing did. A model that could not be ASKED
   *  and a model that DECLINED are different facts, and a report that says
   *  "their titles do not say" when the request never left the machine is
   *  lying to the person reading it. */
  error?: string
}

export async function proposeTopicsFromTitles(rows: RetagCandidate[], client?: AnthropicLike): Promise<TopicProposals> {
  if (!rows.length) return { topics: {} }
  const answer = await callAssistant({
    label: `retag topics for ${rows.length} entries`,
    system: buildRetagSystemPrompt(),
    user: buildRetagUserMessage(rows.slice(0, TOPIC_PROMPT_MAX)),
    maxTokens: 1_000,
    client,
  })
  if (isAssistantError(answer)) return { topics: {}, error: answer.error }
  const parsed = jsonObjectIn(answer.text)
  if (!parsed) return { topics: {}, error: 'the answer was not JSON' }
  const out: Record<string, string> = {}
  for (const [slug, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue
    const topic = normalizeCategory(value)
    // The validator, same as everywhere else: an id outside the taxonomy is
    // not a proposal, it is a word.
    if (isTopic(topic) && rows.some(r => r.slug === slug)) out[slug] = topic
  }
  return { topics: out }
}

// --- The run ------------------------------------------------------------------

export interface RetagOptions {
  apply?: boolean
  /** P6-1: run the organization pass and write its report. */
  organizations?: boolean
  /** P6-2: run the shape pass and write its report. Never applied. */
  shapes?: boolean
  /** P6-19: run the coverage pass and write its report. Never applied. */
  coverage?: boolean
  /** Injected by the tests; production uses the configured client. */
  client?: AnthropicLike
}

export async function retagLibrary(localDir: string, options: RetagOptions = {}): Promise<RetagResult> {
  const paths = await findManifests(localDir)
  const rows: RetagRow[] = []
  for (const path of paths) {
    const row = await planOne(path, localDir)
    if (row) rows.push(row)
  }
  // No tree, no report. Writing one into a folder that does not exist throws
  // ENOENT and buries the only useful message: --dir is pointing at the wrong
  // place. The caller says so instead.
  if (!rows.length) {
    return { rows, changed: [], proposed: [], unknown: [], applied: [], reportPath: join(localDir, 'retag-report.md') }
  }

  // P6-2 and P6-19: these passes read files, so they only run when asked for —
  // and they share one pass over the disk when both are.
  const looked = options.shapes || options.coverage ? await planEntries(rows, options) : []
  const shaped = options.shapes ? looked : []
  const covered = options.coverage ? looked : []

  // Entries with nothing saying what they are about. The free reading first.
  const needTopic = rows.filter(r => !r.topic)
  for (const row of needTopic) {
    const guess = topicFromWords(row)
    if (guess) {
      row.proposedTopic = guess
      row.proposedFrom = 'tags'
    }
  }

  // Then, only for what is left, and only when a key is configured.
  const stillUnknown = needTopic.filter(r => !r.proposedTopic)
  let modelNote: string | undefined
  if (stillUnknown.length) {
    if (!options.client && !hasApiKey()) {
      modelNote = `${stillUnknown.length} entries need a topic read off their title; set ANTHROPIC_API_KEY to have one proposed.`
    } else {
      const titles = await titlesFor(stillUnknown)
      const { topics, error } = await proposeTopicsFromTitles(titles, options.client)
      for (const row of stillUnknown) {
        const topic = topics[row.slug]
        if (!topic) continue
        row.proposedTopic = topic
        row.proposedFrom = 'title'
      }
      const left = stillUnknown.filter(r => !r.proposedTopic).length
      if (error) {
        modelNote = `${stillUnknown.length} entries could have had a topic read off their title, and the model could not be asked: ${error}`
      } else if (left) {
        modelNote = `${left} entries got no proposal — their titles do not say what they are about.`
      }
    }
  }

  const changed = rows.filter(r => r.category !== r.newCategory || r.tags.join('|') !== r.newTags.join('|'))
  const proposed = rows.filter(r => r.proposedTopic)
  const unknown = rows.filter(r => r.unknownCategory)

  // P6-1. A publisher the vocabulary knows can be written into the manifest;
  // one it does not is reported instead — the fix for that is an alias in
  // src/config/organizations.ts, not a word in somebody's manifest.
  const organizationChanged = rows.filter(r => isOrganizationId(r.proposedOrganization) && r.organization !== r.proposedOrganization)
  const organizationUnknown = rows.filter(r => !!r.providerText && !isOrganizationId(r.proposedOrganization))

  const applied: string[] = []
  if (options.apply) {
    const writes = options.organizations ? [...changed, ...proposed, ...organizationChanged] : [...changed, ...proposed]
    for (const row of [...new Set(writes)]) {
      if (await applyOne(row, options)) applied.push(relative(localDir, row.path))
    }
  }

  const reportPath = join(localDir, 'retag-report.md')
  await fs.writeFile(reportPath, renderReport(rows, { applied: options.apply, modelNote }), 'utf8')

  const extra: Partial<RetagResult> = {}
  if (options.organizations) {
    const path = join(localDir, 'retag-organizations.md')
    await fs.writeFile(path, renderOrganizationReport(rows, { applied: options.apply }), 'utf8')
    extra.organizationReportPath = path
    extra.organizationChanged = organizationChanged
    extra.organizationUnknown = organizationUnknown
  }
  if (options.shapes) {
    const path = join(localDir, 'retag-shapes.md')
    await fs.writeFile(path, renderShapeReport(shaped), 'utf8')
    extra.shapeReportPath = path
    extra.shaped = shaped
  }
  if (options.coverage) {
    const path = join(localDir, 'retag-coverage.md')
    await fs.writeFile(path, renderCoverageReport(covered), 'utf8')
    extra.coverageReportPath = path
    extra.covered = covered
  }

  return { rows, changed, proposed, unknown, applied, reportPath, ...(modelNote ? { modelNote } : {}), ...extra }
}

/** Manifest titles, read once for the entries that need them. */
async function titlesFor(rows: RetagRow[]): Promise<RetagCandidate[]> {
  const out: RetagCandidate[] = []
  for (const row of rows) {
    try {
      const meta = JSON.parse(await fs.readFile(row.path, 'utf8')) as Record<string, unknown>
      out.push({
        slug: row.slug,
        title: typeof meta.title === 'string' && meta.title ? meta.title : row.slug,
        tags: row.newTags,
      })
    } catch {
      out.push({ slug: row.slug, title: row.slug, tags: row.newTags })
    }
  }
  return out
}

/**
 * Rewrite one manifest, minimally.
 *
 * `category` and `tags` only, and the file is re-serialised from the object it
 * was parsed from, so every other field — lineage, source blocks, supersession
 * pointers, a note's body — comes back exactly as it went in.
 *
 * A PROPOSED topic is applied as a TAG, never as the category. The category
 * already says something true (a purpose, usually), the topic is derived from
 * the tags, and a proposal that overwrote a person's filing would be the one
 * unrecoverable thing this tool could do.
 */
async function applyOne(row: RetagRow, options: RetagOptions = {}): Promise<boolean> {
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(await fs.readFile(row.path, 'utf8')) as Record<string, unknown>
  } catch {
    return false
  }
  const tags = [...row.newTags]
  if (row.proposedTopic && !tags.includes(row.proposedTopic)) tags.push(row.proposedTopic)
  const before = JSON.stringify(meta)
  if (row.newCategory) meta.category = row.newCategory
  else delete meta.category
  if (tags.length) meta.tags = tags
  else delete meta.tags
  // P6-1: only an id the vocabulary knows. An unknown publisher's prose is
  // already in the manifest as `source`; copying it into `organization` would
  // enshrine the gap instead of reporting it.
  if (options.organizations && isOrganizationId(row.proposedOrganization)) meta.organization = row.proposedOrganization
  if (JSON.stringify(meta) === before) return false
  await fs.writeFile(row.path, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return true
}

// --- The report ----------------------------------------------------------------

function arrow(from: string, to: string): string {
  return from === to ? to || '—' : `${from || '—'} → **${to || '—'}**`
}

function tagArrow(from: string[], to: string[]): string {
  const a = from.join(', ')
  const b = to.join(', ')
  return a === b ? b || '—' : `${a || '—'} → **${b || '—'}**`
}

export function reasonFor(row: RetagRow): string {
  if (!row.proposedTopic) return ''
  return row.proposedFrom === 'tags'
    ? `proposed **${row.proposedTopic}** (from tags)`
    : `proposed **${row.proposedTopic}** (from title, model)`
}

export function renderReport(rows: RetagRow[], options: { applied?: boolean; modelNote?: string } = {}): string {
  const changed = rows.filter(r => r.category !== r.newCategory || r.tags.join('|') !== r.newTags.join('|'))
  const proposed = rows.filter(r => r.proposedTopic)
  const unknown = rows.filter(r => r.unknownCategory)
  const lines: string[] = [
    '# Retag report',
    '',
    `Generated ${new Date().toISOString()} by \`npm run library -- retag\`.`,
    '',
    options.applied
      ? '**Applied.** The manifests below have been rewritten.'
      : '**Dry run — nothing was written.** Read it, then rerun with `--apply`.',
    '',
    `${rows.length} entries · ${changed.length} would change · ${proposed.length} get a proposed topic · ${unknown.length} carry a category the taxonomy does not know.`,
    '',
    'A **proposed** topic is applied as a TAG, not as the category: the category already says something true (usually a purpose), and the topic is read from the tags.',
    '',
    `Vocabulary: ${CATEGORY_IDS.join(', ')}.`,
    '',
    '| slug | kind | category | tags | topic | notes |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    const notes: string[] = []
    if (row.unknownCategory) notes.push('⚠ category not in the taxonomy')
    const reason = reasonFor(row)
    if (reason) notes.push(reason)
    lines.push(
      `| \`${row.slug}\` | ${row.kind} | ${arrow(row.category, row.newCategory)} | ${tagArrow(row.tags, row.newTags)} | ${
        row.topic ?? (row.proposedTopic ? `_${row.proposedTopic}?_` : '—')
      } | ${notes.join('; ')} |`,
    )
  }
  if (options.modelNote) lines.push('', `> ${options.modelNote}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * P6-1's report: who each entry would be filed under, and what the reading was
 * made from.
 *
 * The `source` column is the point of it. The proposal is a fold of prose
 * somebody typed, so "is this right?" is only answerable beside the prose —
 * and the answer for a wrong one is an alias in the vocabulary, which is why
 * the unknown rows are listed again at the foot with nothing else in the way.
 */
export function renderOrganizationReport(rows: RetagRow[], options: { applied?: boolean } = {}): string {
  const shown = rows.filter(r => r.providerText || r.organization || r.proposedOrganization)
  const changed = rows.filter(r => isOrganizationId(r.proposedOrganization) && r.organization !== r.proposedOrganization)
  const unknown = rows.filter(r => !!r.providerText && !isOrganizationId(r.proposedOrganization))
  const silent = rows.filter(r => !r.providerText && !r.organization)
  const lines: string[] = [
    '# Retag report — organizations',
    '',
    `Generated ${new Date().toISOString()} by \`npm run library -- retag --organizations\`.`,
    '',
    options.applied
      ? '**Applied.** Every entry below whose publisher the vocabulary knows now carries `organization` in its manifest.'
      : '**Dry run — nothing was written.** Read it, then rerun with `--apply`.',
    '',
    `${rows.length} entries · ${changed.length} would gain or change an \`organization\` · ${unknown.length} name a publisher the vocabulary does not know · ${silent.length} name no publisher at all.`,
    '',
    'An unknown publisher is never written into a manifest: the fix is an alias in `src/config/organizations.ts`, then `npm run export:layers`.',
    '',
    `Vocabulary: ${ORGANIZATION_IDS.join(', ')}.`,
    '',
    '| slug | kind | organization | reads as | from the manifest’s source |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const row of shown) {
    const known = isOrganizationId(row.proposedOrganization)
    const reads = known ? organizationLabel(row.proposedOrganization) : row.proposedOrganization ? '⚠ not in the vocabulary' : '—'
    lines.push(
      `| \`${row.slug}\` | ${row.kind} | ${arrow(row.organization, row.proposedOrganization)} | ${reads} | ${escapeCell(row.providerText)} |`,
    )
  }
  if (unknown.length) {
    lines.push('', '## Publishers the vocabulary does not know', '')
    for (const row of unknown) lines.push(`- \`${row.slug}\` — ${escapeCell(row.providerText)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * P6-2's report: what each dataset and source would be called, and why.
 *
 * Report only — see the module comment. The `read from` column names the thing
 * the derivation looked at, so a reading Nick disagrees with is corrected by
 * writing `shape:` on that one entry rather than by arguing with the rules.
 */
export function renderShapeReport(rows: RetagRow[]): string {
  const stated = rows.filter(r => !!r.shape)
  const lines: string[] = [
    '# Retag report — dataset shapes',
    '',
    `Generated ${new Date().toISOString()} by \`npm run library -- retag --shapes\`.`,
    '',
    '**Report only — nothing is ever written.** The shape is derived at every reindex; write `shape:` in a manifest to correct one.',
    '',
    `${rows.length} datasets and sources · ${stated.length} already state a shape.`,
    '',
    'areas = areas and boundaries · points = sites and points · statistics = by county or tract · records = no location.',
    '',
    '| slug | kind | shape | read from |',
    '| --- | --- | --- | --- |',
  ]
  for (const row of rows) {
    const shape = row.shape && row.shape !== row.proposedShape ? `${row.shape} → **${row.proposedShape}**` : (row.proposedShape ?? '—')
    lines.push(`| \`${row.slug}\` | ${row.kind} | ${shape} | ${row.shape ? 'the manifest’s `shape:`' : shapeEvidence(row)} |`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * P6-19's report: how much ground each dataset and source covers, and the
 * distribution across the whole tree.
 *
 * Report only — see the module comment, and more so than shapes: a coverage
 * improves the moment a table gains a GEOID column or somebody fills in a
 * source block, and a reading frozen into a manifest would stop improving.
 *
 * Three things a reader needs and one table cannot give: the **distribution**
 * (how much of the library is national, and how much nobody can place), the
 * **state counts** (which is the answer to "what do we hold for Georgia?"
 * before any UI exists to ask it), and the **rows nobody could place**, listed
 * again at the foot where nothing else is in the way.
 */
export function renderCoverageReport(rows: RetagRow[]): string {
  const scopeOf = (row: RetagRow): string => row.proposedCoverage?.scope ?? 'none'
  const counted = (scope: string) => rows.filter(row => scopeOf(row) === scope).length
  const stated = rows.filter(r => !!r.coverage)
  const placed = rows.filter(r => r.proposedCoverage)
  const unplaced = rows.filter(r => !r.proposedCoverage)
  const byState = new Map<string, number>()
  for (const row of placed) for (const code of row.proposedCoverage!.states) byState.set(code, (byState.get(code) ?? 0) + 1)
  const states = [...byState.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const lines: string[] = [
    '# Retag report — dataset coverage',
    '',
    `Generated ${new Date().toISOString()} by \`npm run library -- retag --coverage\`.`,
    '',
    '**Report only — nothing is ever written.** Coverage is derived at every reindex; write `coverage:` in a manifest to correct one.',
    '',
    `${rows.length} datasets and sources · ${stated.length} already state a coverage · ${unplaced.length} could not be placed.`,
    '',
    '## Distribution',
    '',
    '| scope | entries |',
    '| --- | --- |',
    ...COVERAGE_SCOPE_IDS.map(id => `| ${coverageScopeLabel(id)} (\`${id}\`) | ${counted(id)} |`),
    `| **No coverage** | ${unplaced.length} |`,
    '',
    'A dataset nobody can place carries NO coverage and is counted on the admin queue as “Datasets with no coverage”. It is never quietly called national.',
    '',
  ]

  if (states.length) {
    lines.push(
      '## What we hold, by state',
      '',
      'A national dataset is deliberately under no single state — it answers “what is nationwide?”, not “what do we hold for Georgia?”.',
      '',
      '| state | entries |',
      '| --- | --- |',
      ...states.map(([code, count]) => `| ${stateNameForCode(code) || code} (${code}) | ${count} |`),
      '',
    )
  }

  lines.push('## Every entry', '', '| slug | kind | coverage | states | read from |', '| --- | --- | --- | --- | --- |')
  for (const row of rows) {
    const coverage = row.proposedCoverage
    lines.push(
      `| \`${row.slug}\` | ${row.kind} | ${coverage ? `${coverage.scope} — ${coverage.label}` : '**none**'} | ` +
        `${coverage?.states.join(', ') || '—'} | ${escapeCell(row.coverageFrom)} |`,
    )
  }

  if (unplaced.length) {
    lines.push('', '## Entries nobody could place', '')
    for (const row of unplaced) lines.push(`- \`${row.slug}\` (${row.kind}) — ${escapeCell(row.coverageFrom)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** One phrase naming what the derivation had to go on. */
function shapeEvidence(row: RetagRow): string {
  if (row.kind === 'source') return 'the source block'
  return 'the layer block or the table’s columns'
}

/** A manifest's prose in a markdown table cell: pipes would end the column. */
function escapeCell(text: string): string {
  const clean = text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
  return clean.length > 120 ? `${clean.slice(0, 117)}…` : clean || '—'
}

/** One line per entry, for the terminal. Same information, narrower. */
export function printRetagTable(result: RetagResult): void {
  const pad = (v: string, w: number) => v.padEnd(w)
  console.log(pad('slug', 34) + pad('kind', 10) + pad('category', 30) + pad('tags', 64) + 'topic')
  console.log('-'.repeat(170))
  for (const row of result.rows) {
    const category = row.category === row.newCategory ? row.newCategory || '—' : `${row.category || '—'} → ${row.newCategory || '—'}`
    const tags =
      row.tags.join(',') === row.newTags.join(',')
        ? row.newTags.join(', ') || '—'
        : `${row.tags.join(', ') || '—'} → ${row.newTags.join(', ') || '—'}`
    const topic = row.topic ?? (row.proposedTopic ? `${row.proposedTopic}? (${row.proposedFrom === 'tags' ? 'from tags' : 'from title, proposed'})` : '— NO TOPIC')
    const flag = row.unknownCategory ? '  ⚠ unknown category' : ''
    console.log(pad(row.slug.slice(0, 33), 34) + pad(row.kind, 10) + pad(category.slice(0, 29), 30) + pad(tags.slice(0, 63), 64) + topic + flag)
  }
}

/** P6-1's table for the terminal: the proposal beside the prose it came from. */
export function printOrganizationTable(rows: RetagRow[]): void {
  const pad = (v: string, w: number) => v.padEnd(w)
  console.log(pad('slug', 34) + pad('kind', 10) + pad('organization', 24) + 'from the manifest’s source')
  console.log('-'.repeat(150))
  for (const row of rows) {
    if (!row.providerText && !row.organization) continue
    const organization = row.organization === row.proposedOrganization ? row.proposedOrganization : `${row.organization || '—'} → ${row.proposedOrganization || '—'}`
    const flag = row.providerText && !isOrganizationId(row.proposedOrganization) ? '  ⚠ not in the vocabulary' : ''
    console.log(pad(row.slug.slice(0, 33), 34) + pad(row.kind, 10) + pad(organization.slice(0, 23), 24) + row.providerText.slice(0, 70) + flag)
  }
}

/** P6-2's table for the terminal. */
export function printShapeTable(rows: RetagRow[]): void {
  const pad = (v: string, w: number) => v.padEnd(w)
  console.log(pad('slug', 34) + pad('kind', 10) + pad('shape', 14) + 'stated in the manifest')
  console.log('-'.repeat(90))
  for (const row of rows) {
    console.log(pad(row.slug.slice(0, 33), 34) + pad(row.kind, 10) + pad(row.proposedShape ?? '—', 14) + (row.shape || '—'))
  }
}

/** P6-19's table for the terminal: the reading beside what it was read off. */
export function printCoverageTable(rows: RetagRow[]): void {
  const pad = (v: string, w: number) => v.padEnd(w)
  console.log(pad('slug', 34) + pad('kind', 10) + pad('scope', 13) + pad('states', 22) + 'read from')
  console.log('-'.repeat(160))
  for (const row of rows) {
    const coverage = row.proposedCoverage
    console.log(
      pad(row.slug.slice(0, 33), 34) +
        pad(row.kind, 10) +
        pad(coverage?.scope ?? 'NONE', 13) +
        pad((coverage?.states.join(',') || '—').slice(0, 21), 22) +
        row.coverageFrom.slice(0, 70),
    )
  }
}
