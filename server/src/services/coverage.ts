import { COVERAGE_SCOPE_IDS, coverageScopeLabel, isCoverageScope, stateCodeFor, stateCodeForFips, stateNameForCode, US_STATES } from './taxonomy.js'
import { isShapedKind } from './shape.js'

/**
 * HOW MUCH GROUND a dataset covers (P6-19).
 *
 * `shape.ts`'s sibling, deliberately: the vocabulary is the taxonomy's
 * (`coverageScopes` in the generated table), and this is the derivation — how
 * an entry that has never been asked "where does this apply?" answers it from
 * what it already carries. The catalog could not answer "what do we hold for
 * Georgia?", which is the most natural question a place-based organization
 * asks of its own library, and the signal was there the whole time: a held
 * table's GEOIDs say exactly which states its rows are in, and a state
 * agency's register says so in its own source block.
 *
 * Read in this order, and stop at the first answer:
 *
 *  1. the manifest said so — `coverage: state:GA` wins over everything;
 *  2. it is a source — its block's own `coverage` field is a human's or the
 *     link inspector's statement of exactly this question, and failing that
 *     the publisher's own name ("Georgia Environmental Protection Division")
 *     or a `national` place query says it;
 *  3. it is a table we hold — a GEOID/FIPS column gives the distinct states
 *     its rows are in; coordinates with no area code give `local`;
 *  4. nothing determinable — **no coverage at all**, which the admin queue
 *     counts as "Datasets with no coverage".
 *
 * That last rule is the important one. A dataset whose ground nobody can work
 * out must never be quietly called national: it would then answer "what is
 * nationwide?" with a lie, and disappear from the one queue that would get it
 * fixed. A public registry layer is national (`PUBLIC_LAYER_COVERAGE`)
 * because every layer the map draws is county values for the whole country —
 * that is a fact about the registry, not a fallback.
 *
 * **Why the source block is read before the held table**, where P6-2 reads the
 * table first: a source is manifest-only by nature — it points at data we do
 * NOT hold — so the two can only meet when a source ships a sample or a data
 * dictionary beside its manifest, and a sample's rows are a terrible witness
 * for the whole dataset's extent (a national register sampled for one county
 * would read as that one state). The block's own word about the whole thing
 * wins. Nothing in the push tree has both.
 *
 * Pure, with the one file read injected, so the whole thing is testable
 * without a bucket and reusable by the push CLI over a local tree.
 */

export type CoverageScopeId = 'national' | 'multi-state' | 'state' | 'county' | 'local'

/** What a row's coverage is: how much ground, which states, and the words. */
export interface Coverage {
  scope: CoverageScopeId
  /** Postal codes, sorted. Empty for `national` — a nationwide dataset is
   *  under the National chip and under no single state's, which is what makes
   *  "what do we hold for Georgia?" a question about Georgia. */
  states: string[]
  /** 5-digit county GEOIDs, when there are few enough to be worth naming. */
  counties?: string[]
  label: string
  /**
   * P6-32: the qualifier a human wrote in parentheses after the scope —
   * "coastal states and territories only". The scope in front of it is still
   * the right reading (a NOAA national product IS national), so this is not a
   * correction; it is the note that says a more precise answer exists and
   * nobody has written it yet. Kept rather than discarded so the imprecision
   * is visible instead of silently flattened.
   */
  note?: string
}

export const NATIONAL: Coverage = { scope: 'national', states: [], label: 'National' }

/**
 * Points we hold whose state we cannot name.
 *
 * P6-19 rule 3 wanted the states a table's coordinates fall in. Working that
 * out properly is point-in-polygon against county geometry, and the ticket's
 * own out-of-scope line says to degrade rather than grow a geometry service
 * here. State bounding boxes were the cheap alternative and they are not
 * sound: DC's box is inside Maryland's and Virginia's, so a Bethesda garden
 * would be filed under DC. Inventing a state is worse than declining to name
 * one, so a coordinate table is `local` with no states claimed, and a reader
 * who knows better writes `coverage:` in the manifest.
 */
export const LOCAL: Coverage = { scope: 'local', states: [], label: 'Local area' }

/** Public map layers are county values for the whole country, every one of
 *  them (P6-19 rule 5, spec B.9). */
export const PUBLIC_LAYER_COVERAGE: Coverage = NATIONAL

/**
 * Distinct states at which a table stops being "several states" and becomes
 * nationwide.
 *
 * 45 of the 51 (the states plus DC), not 51: a national table routinely
 * misses a handful — a programme with no facilities in Vermont, a survey that
 * suppresses small cells, a register whose territories are published
 * separately — and calling that "44 states" would bury it under a chip nobody
 * presses instead of the National one it belongs to.
 */
export const NATIONAL_STATE_COUNT = 45

/** Counties are carried on the row only when a reader could take them in. A
 *  single-state table with 60 counties is a statement about the state. */
export const COUNTY_DETAIL_MAX = 12

/** What a derivation is run over: one entry, as a manifest plus file names. */
export interface CoverageInput {
  kind: string
  meta: Record<string, unknown> | undefined | null
  /** Basenames inside the entry folder ("organizations.csv"), not bucket keys. */
  files?: string[]
  /** The entry's slug, for the one warning an unusable `coverage:` earns. */
  slug?: string
}

/** The same two kinds `shape` is asked of, and for the same reason: "where
 *  does this apply" is a real question for a dataset and a source, and a
 *  category error for a page, a note or a saved view. */
export { isShapedKind }

// --- The words ------------------------------------------------------------

/** Plain words for a coverage: the state's own name when one state names it,
 *  the scope's words when none does. */
export function coverageLabel(scope: CoverageScopeId, states: readonly string[]): string {
  if (scope === 'national') return 'National'
  if (!states.length) return coverageScopeLabel(scope)
  const names = states.map(code => stateNameForCode(code) || code)
  if (names.length === 1) return names[0]
  // Four is as many as a chip or a heading can carry before it stops being
  // readable; past that the count is the useful fact.
  if (names.length <= 4) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.length} states`
}

/**
 * A coverage from the states (and counties) it covers.
 *
 * The one place the thresholds live, so a manifest that lists 45 states and a
 * table whose rows are in 45 states read identically.
 */
export function coverageFor(states: readonly string[], counties: readonly string[] = [], scopeHint?: CoverageScopeId): Coverage | null {
  const codes = [...new Set(states.filter(Boolean))].sort()
  if (!codes.length) return null
  if (codes.length >= NATIONAL_STATE_COUNT) return NATIONAL
  const scope: CoverageScopeId = scopeHint ?? (codes.length === 1 ? 'state' : 'multi-state')
  const geoids = [...new Set(counties.filter(Boolean))].sort()
  return {
    scope,
    states: codes,
    ...(geoids.length && geoids.length <= COUNTY_DETAIL_MAX ? { counties: geoids } : {}),
    label: coverageLabel(scope, codes),
  }
}

/**
 * The word for "nothing could place it" in a filter. `''` already means "not
 * filtered at all", and `none` is the word `plan=none` and the browsers'
 * chip rows already use for the same question.
 */
export const NO_COVERAGE = 'none'

/**
 * Does a row's coverage pass one filter value?
 *
 * ONE function for three questions, because they are one question asked of
 * one field: `national` and `local` are scopes, `GA` / `Georgia` / `13` are
 * states, and `none` is the rows nothing could place. That is what lets the
 * Coverage chip row be a single row with a single URL key — "National" and
 * "Georgia" sit side by side because they are answers to the same question —
 * and it is why the list, the chip count and the group count cannot drift
 * apart: all three read this.
 *
 * A state the vocabulary does not know matches NOTHING. A filter naming a
 * place we have never heard of has no rows, and saying so is better than
 * silently showing everything.
 */
export function coverageMatches(coverage: Coverage | null, value: string): boolean {
  const asked = value.trim()
  if (!asked) return true
  if (asked.toLowerCase() === NO_COVERAGE) return !coverage
  if (!coverage) return false
  const scope = asked.toLowerCase()
  if (isCoverageScope(scope)) return coverage.scope === scope
  const code = stateCodeFor(asked)
  return !!code && coverage.states.includes(code)
}

// --- 1. The manifest's own word -------------------------------------------

/** Scope words a person or the link inspector writes in prose. `regional`
 *  is `extentLabel`'s word for "more than one state, less than the country",
 *  which is what `multi-state` means. */
const SCOPE_ALIASES: Record<string, CoverageScopeId> = {
  national: 'national',
  nationwide: 'national',
  'multi-state': 'multi-state',
  multistate: 'multi-state',
  regional: 'multi-state',
  state: 'state',
  county: 'county',
  local: 'local',
}

/**
 * One written coverage, parsed — or null when the words do not say.
 *
 * Deliberately strict. `source.coverage` is partly model-written prose
 * ("2013 to 2023, all 50 states and Puerto Rico") and a parser loose enough
 * to find a state in any sentence would find the wrong one; a reading nobody
 * can trust is worse than the honest "we do not know" that puts the entry on
 * the attention queue. So: a scope word, a `scope:value` pair, or a `,`/`;`
 * list in which EVERY item is a state. Anything else is not an answer.
 *
 * P6-32 narrowed this, on Nick's instruction that coverage should be stated by
 * a person or a model and never inferred by a parser:
 *
 *  - The separators stay as they were (`,` `;` `/` `and` `+`). An attempt to
 *    narrow them to `,`/`;` was reverted: "Georgia and Alabama" is a person
 *    writing a list by hand, which is precisely the input this should serve,
 *    and widening the separators cannot cause a misreading anyway — the safety
 *    is `fromList`'s rule that EVERY item must resolve to a state, so a
 *    sentence fails on its first non-state word rather than yielding one.
 *  - **A trailing parenthetical is kept rather than discarded.** It used to be
 *    stripped, so `national (coastal states and territories only)` read as a
 *    bare `national` and the qualifier vanished. Nick (2026-10-05): *"coastal
 *    only being national isnt necessarily fully a bug, but its true it could
 *    be more precise to only coastal states"* — which is right, and corrects
 *    an earlier reading here that called it a wrong answer. A NOAA national
 *    product IS national; it is imprecise, not incorrect, and dropping it to
 *    "no coverage" would trade a good-enough answer for none. So the scope is
 *    still read and the qualifier rides along as `coverage.note`, where it
 *    says a more precise answer exists and nobody has written it yet.
 *
 * Where the derivation cannot tell, the answer is a hand-written `coverage:`
 * on the entry — which `statedCoverage` already accepts as a structured
 * `{ scope, states }` object, validated by `asCoverage`. That is the path a
 * person or a model should use; this function only reads what is already
 * unambiguous.
 */
export function parseCoverage(raw: string): Coverage | null {
  const trimmed = raw.trim()
  // A trailing parenthetical qualifies the scope in front of it rather than
  // replacing it; read the scope, and carry the qualifier on the result.
  const qualifier = /\s*\(([^)]*)\)\s*$/.exec(trimmed)
  const text = qualifier ? trimmed.slice(0, qualifier.index).trim() : trimmed
  if (!text) return null
  const withNote = (c: Coverage | null): Coverage | null =>
    c && qualifier ? { ...c, note: qualifier[1].trim() } : c
  const colon = text.indexOf(':')
  if (colon > 0) {
    const scope = SCOPE_ALIASES[text.slice(0, colon).trim().toLowerCase()]
    const rest = text.slice(colon + 1).trim()
    if (scope === 'national') return withNote(NATIONAL)
    if (scope === 'local') return withNote(LOCAL)
    if (scope) return withNote(fromList(rest, scope === 'county' ? 'county' : undefined))
    return null
  }
  const scope = SCOPE_ALIASES[text.toLowerCase()]
  if (scope === 'national') return withNote(NATIONAL)
  if (scope === 'local') return withNote(LOCAL)
  if (scope === 'multi-state') return withNote({ scope: 'multi-state', states: [], label: coverageScopeLabel('multi-state') })
  // A bare `state` or `county` with nothing after it names no state, so it
  // says no more than "somewhere in the US" — which is not an answer.
  if (scope) return null
  return withNote(fromList(text))
}

/** A list of states, or a list of GEOIDs — and only when EVERY item is one. */
function fromList(text: string, scopeHint?: CoverageScopeId): Coverage | null {
  const items = text
    .split(/\s*(?:,|;|\/|\band\b|\+)\s*/i)
    .map(item => item.trim())
    .filter(Boolean)
  if (!items.length) return null
  if (items.every(item => /^\d+$/.test(item))) return coverageFromGeoids(items, scopeHint)
  const codes = items.map(item => stateCodeFor(item))
  if (codes.some(code => !code)) return null
  return coverageFor(codes, [], scopeHint)
}

const warnedCoverage = new Set<string>()

/**
 * The `coverage:` a manifest states, when it states one we can read.
 *
 * Unreadable words are DROPPED rather than kept, exactly like a `shape:`
 * outside the vocabulary: a coverage is what the state chips are built from,
 * and an entry carrying `coverage: "the Southeast"` would be filed under a
 * chip nobody else is under. One warning per entry, naming what was written,
 * so it can be fixed in the manifest.
 */
export function statedCoverage(input: CoverageInput): Coverage | null {
  const raw = input.meta?.coverage
  // Already-derived coverage, read back off a row: the reindex before this one
  // wrote an object here, and it is the same answer.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return asCoverage(raw as Record<string, unknown>)
  if (typeof raw !== 'string' || !raw.trim()) return null
  const parsed = parseCoverage(raw)
  if (parsed) return parsed
  const key = input.slug ?? raw
  if (!warnedCoverage.has(key)) {
    warnedCoverage.add(key)
    console.warn(
      `[library] "${key}" has coverage "${raw}", which is not a scope (${COVERAGE_SCOPE_IDS.join(', ')}) ` +
        'or a list of states — ignored, deriving instead',
    )
  }
  return null
}

/** Tests only: forget which entries have already been warned about. */
export function resetCoverageWarnings(): void {
  warnedCoverage.clear()
}

/**
 * A stored coverage object, validated.
 *
 * The value in the manifest came from a previous reindex, so it is normally
 * well formed — but it is JSON on disk that a person can edit, so a scope we
 * do not know or states that are not states are rebuilt from whatever IS
 * usable rather than trusted. A row with no usable state and no known scope
 * has no coverage, which is the same answer as never having been read.
 */
export function asCoverage(raw: Record<string, unknown>): Coverage | null {
  const scope = typeof raw.scope === 'string' && isCoverageScope(raw.scope) ? (raw.scope as CoverageScopeId) : null
  const states = Array.isArray(raw.states)
    ? raw.states.filter((v): v is string => typeof v === 'string').map(v => stateCodeFor(v)).filter(Boolean)
    : []
  const counties = Array.isArray(raw.counties) ? raw.counties.filter((v): v is string => typeof v === 'string') : []
  if (!scope) return coverageFor(states, counties)
  if (scope === 'national') return NATIONAL
  if (!states.length) return scope === 'local' ? LOCAL : { scope, states: [], label: coverageScopeLabel(scope) }
  return coverageFor(states, counties, scope === 'county' ? 'county' : undefined)
}

// --- 2. A source ----------------------------------------------------------

function sourceBlock(meta: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  const raw = meta?.source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

/**
 * State names as provider-name prefixes, longest first.
 *
 * A state agency's name begins with its state — "Georgia Environmental
 * Protection Division", "North Carolina Department of Environmental Quality",
 * "Alabama Department of Environmental Management" — which is the same trick
 * `organizations.ts` plays with publisher aliases, and longest-first for the
 * same reason ("North Carolina" before any shorter name it contains).
 */
const STATE_NAME_PREFIXES: { name: string; code: string }[] = [...US_STATES]
  .map(state => ({ name: state.name.toLowerCase(), code: state.code }))
  .sort((a, b) => b.name.length - a.name.length)

/**
 * The state a publisher's own name begins with, or ''.
 *
 * The character after the name must be whitespace, which is what keeps
 * "Washington State Department of Ecology" (the state) apart from
 * "Washington, DC Office of Planning" (the city) — a comma means the name was
 * a place in a longer address, not the publisher's state.
 */
export function stateNamingPublisher(provider: string): string {
  const text = provider.trim().toLowerCase()
  for (const { name, code } of STATE_NAME_PREFIXES) {
    if (!text.startsWith(name)) continue
    const next = text.charAt(name.length)
    if (next === '' || /\s/.test(next)) return code
  }
  return ''
}

function placeQueryBy(source: Record<string, unknown>): string[] {
  const pq = source.placeQuery
  if (!pq || typeof pq !== 'object' || Array.isArray(pq)) return []
  const by = (pq as { by?: unknown }).by
  return Array.isArray(by) ? by.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()) : []
}

/** What a source block says about its own extent. */
export function coverageFromSource(source: Record<string, unknown>): Coverage | null {
  return readCoverageFromSource(source).coverage
}

function readCoverageFromSource(source: Record<string, unknown>): CoverageReading {
  // The block has a field for exactly this question, written by hand or by the
  // link inspector's `extentLabel`. It is the best witness we will ever have.
  if (typeof source.coverage === 'string') {
    const stated = parseCoverage(source.coverage)
    if (stated) return { coverage: stated, from: `the source block’s coverage, “${source.coverage}”` }
  }
  const provider = typeof source.provider === 'string' ? stateNamingPublisher(source.provider) : ''
  if (provider) return { coverage: coverageFor([provider]), from: `the publisher’s name, “${source.provider}”` }
  // A place query or a `geography` that says `national` is a statement about
  // the whole register. Any other scope word says what you can ASK it for, not
  // how much ground it covers, so it is not an answer to this question.
  const geography = typeof source.geography === 'string' ? source.geography.trim().toLowerCase() : ''
  if (geography === 'national' || placeQueryBy(source).includes('national')) {
    return { coverage: NATIONAL, from: 'a national place query' }
  }
  return NOTHING
}

// --- 3. A table we hold ---------------------------------------------------

const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'geojson'])

/** Shared with `dataDates.ts` (P7-10), which asks a third question of the
 *  same file this picks. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The file the explorer would open — the same rule, and the same file, that
 *  `pickShapeFile` picks, so the two derivations share one read. */
export function pickCoverageFile(files: readonly string[] | undefined): string | null {
  return (files ?? []).find(name => name !== 'meta.json' && TABULAR_EXTENSIONS.has(extensionOf(name))) ?? null
}

const GEO_CODE_COLUMN = /geoid|fips/i
const LAT_COLUMN = /^_?(?:lat|latitude)$/i
const LNG_COLUMN = /^_?(?:lng|lon|long|longitude)$/i

export interface CoverageSignals {
  /** Every value of the first GEOID/FIPS column, exactly as written. */
  geoids: string[]
  /** The table carries coordinates: lat and lng columns, or point features. */
  coordinates: boolean
}

/**
 * One CSV row, split on commas that are not inside quotes.
 *
 * Shape only needed the header line, where a naive split is fine. Coverage
 * needs one COLUMN out of every row, and the enriched tables have prose in
 * them ("Known Board Members / Leadership") — one comma inside one quoted cell
 * shifts every later column by one and the GEOID read becomes a read of
 * whatever sits beside it. Minimal on purpose: no escapes beyond the doubled
 * quote, because this is reading one numeric column and not parsing a corpus.
 */
export function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char !== '"') cell += char
      else if (line[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === delimiter) {
      cells.push(cell)
      cell = ''
    } else cell += char
  }
  cells.push(cell)
  return cells.map(value => value.trim())
}

/**
 * Where a table's rows are, read from one column of it.
 *
 * Every row is looked at — not a sample. A 25 MB table sorted by GEOID whose
 * first ten thousand rows are all in Alabama is not an Alabama dataset, and a
 * cap would have made exactly that mistake on the tables most worth getting
 * right. One column out of each line is cheap enough that the 25 MB read cap
 * is the only limit that needs to exist.
 */
export function readCoverageSignals(fileName: string, text: string): CoverageSignals {
  const ext = extensionOf(fileName)
  if (ext === 'json' || ext === 'geojson') return jsonSignals(text)
  const delimiter = ext === 'tsv' ? '\t' : ','
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const header = splitRow(lines[0] ?? '', delimiter).map(cell => cell.replace(/^"(.*)"$/s, '$1').trim())
  const index = header.findIndex(column => GEO_CODE_COLUMN.test(column))
  const coordinates = header.some(c => LAT_COLUMN.test(c)) && header.some(c => LNG_COLUMN.test(c))
  if (index === -1) return { geoids: [], coordinates }
  const geoids: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    const value = splitRow(lines[i], delimiter)[index]
    if (value) geoids.push(value)
  }
  return { geoids, coordinates }
}

function jsonSignals(text: string): CoverageSignals {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { geoids: [], coordinates: false }
  }
  const rows: Record<string, unknown>[] = []
  let coordinates = false
  if (Array.isArray(parsed)) {
    for (const row of parsed) if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row as Record<string, unknown>)
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { features?: unknown }).features)) {
    for (const feature of (parsed as { features: unknown[] }).features) {
      if (!feature || typeof feature !== 'object' || Array.isArray(feature)) continue
      const f = feature as { properties?: unknown; geometry?: unknown }
      if (f.properties && typeof f.properties === 'object' && !Array.isArray(f.properties)) rows.push(f.properties as Record<string, unknown>)
      const type = f.geometry && typeof f.geometry === 'object' ? (f.geometry as { type?: unknown }).type : undefined
      // A point feature's coordinates ARE the table's lat/lng — the explorer
      // lifts them into `_lng`/`_lat` columns and a reader sees them there.
      if (type === 'Point') coordinates = true
    }
  }
  const keys = rows.length ? Object.keys(rows[0]) : []
  const column = keys.find(key => GEO_CODE_COLUMN.test(key))
  if (!coordinates) {
    coordinates = keys.some(k => LAT_COLUMN.test(k)) && keys.some(k => LNG_COLUMN.test(k))
  }
  if (!column) return { geoids: [], coordinates }
  const geoids: string[] = []
  for (const row of rows) {
    const value = row[column]
    if (typeof value === 'string' && value.trim()) geoids.push(value.trim())
    else if (typeof value === 'number' && Number.isFinite(value)) geoids.push(String(value))
  }
  return { geoids, coordinates }
}

/** The widths a Census geography code comes in: state, county, tract, block
 *  group. A code written as a NUMBER has lost its leading zero, so the width
 *  is rounded up to the next real one before the prefix is taken. */
const GEOID_WIDTHS = [2, 5, 11, 12]

/**
 * The states (and counties) a column of GEOIDs names.
 *
 * A prefix that is not a state's is dropped rather than guessed at: it is how
 * a column of row ids that happens to be called `GIS_FIPS`, or a blank, or a
 * `00000` placeholder, fails to invent a state.
 */
export function coverageFromGeoids(values: readonly string[], scopeHint?: CoverageScopeId): Coverage | null {
  const states = new Set<string>()
  const counties = new Set<string>()
  for (const raw of values) {
    const digits = String(raw).replace(/\D/g, '')
    if (!digits) continue
    const width = GEOID_WIDTHS.find(w => digits.length <= w)
    if (!width) continue
    const padded = digits.padStart(width, '0')
    const code = stateCodeForFips(padded.slice(0, 2))
    if (!code) continue
    states.add(code)
    if (width >= 5) counties.add(padded.slice(0, 5))
  }
  return coverageFor([...states], [...counties], scopeHint)
}

/** The table rules, in the order the spec states them. */
export function coverageFromSignals(signals: CoverageSignals): Coverage | null {
  const fromGeoids = coverageFromGeoids(signals.geoids)
  if (fromGeoids) return fromGeoids
  return signals.coordinates ? LOCAL : null
}

// --- The derivation -------------------------------------------------------

/**
 * A coverage, and one phrase naming what it was read off.
 *
 * The evidence is not decoration: the whole point of `retag --coverage` being
 * report-only is that a human reads each reading and corrects the wrong ones,
 * and "is this right?" is only answerable beside the thing the derivation
 * looked at. It comes out of the derivation itself rather than being
 * reconstructed by the report, so the two cannot drift.
 */
export interface CoverageReading {
  coverage: Coverage | null
  from: string
}

const NOTHING: CoverageReading = { coverage: null, from: '—' }

/**
 * Everything that can be answered from the manifest alone: a stated
 * `coverage:`, a source block. Null when only the entry's own table can say.
 *
 * Used where reading a file is not on the table — an upload indexed the moment
 * it lands, a row read back before the next reindex — so those rows carry what
 * is knowable now and the next reindex fills in the rest.
 */
export function coverageFromManifest(input: CoverageInput): Coverage | null {
  return readCoverageFromManifest(input).coverage
}

function readCoverageFromManifest(input: CoverageInput): CoverageReading {
  const stated = statedCoverage(input)
  if (stated) return { coverage: stated, from: 'the manifest’s `coverage:`' }
  const source = sourceBlock(input.meta)
  return source ? readCoverageFromSource(source) : NOTHING
}

/** Read one of the entry's files as text. Returns null when it cannot be read
 *  (too big, gone, not ours) — the derivation falls back rather than throwing. */
export type CoverageFileReader = (fileName: string) => Promise<string | null>

/**
 * Where this entry applies, reading its table when the manifest cannot say.
 *
 * Never throws, and never answers when it does not know: a file that will not
 * download or will not parse leaves the entry with NO coverage, which is the
 * honest answer and the one that puts it on the attention queue.
 */
export async function deriveCoverage(input: CoverageInput, readFile?: CoverageFileReader): Promise<Coverage | null> {
  return (await readCoverage(input, readFile)).coverage
}

/** The same derivation, with the phrase naming what it read — what
 *  `retag --coverage` prints beside each reading. */
export async function readCoverage(input: CoverageInput, readFile?: CoverageFileReader): Promise<CoverageReading> {
  const fromManifest = readCoverageFromManifest(input)
  if (fromManifest.coverage) return fromManifest
  const file = pickCoverageFile(input.files)
  if (!file || !readFile) return NOTHING
  let text: string | null = null
  try {
    text = await readFile(file)
  } catch (err: any) {
    console.warn(`[library] could not read "${file}" to work out what ground "${input.slug ?? ''}" covers: ${err?.message || err}`)
  }
  if (text === null) return { coverage: null, from: `${file} (could not be read)` }
  const signals = readCoverageSignals(file, text)
  const coverage = coverageFromSignals(signals)
  if (!coverage) return { coverage: null, from: `${file} — no GEOID column and no coordinates` }
  return {
    coverage,
    from: signals.geoids.length ? `${signals.geoids.length} GEOIDs in ${file}` : `coordinates in ${file}, no area code`,
  }
}
