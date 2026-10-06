/**
 * Proximity over a working set (P7-5) — the **on-demand tier**.
 *
 * Spec §F.4b's three tiers, and this is tier 2: small-N, parameterised,
 * user-triggered, server-side, result written back to the set. The maths is
 * `proximity.ts` and is shared verbatim with the local CLI pass
 * (`cli/proximity.ts`), because *cardinality decides where an analysis runs,
 * not the operation* — so the only difference between the two homes is where
 * the bytes come from and whether the ceiling applies.
 *
 * What this file owns is the resolution and the refusals:
 *
 *  - **The set is the scope.** A dataset or a layer this set does not name is
 *    refused by name. P7-1 established that a shortlist inside a set cannot
 *    reach outside it; a proximity run that quietly measured against something
 *    outside the set would be answering a different question from the one the
 *    set's title claims, and a story would quote it anyway.
 *  - **The county comes from a column, never from a reverse geocode.** P7-2's
 *    reader is keyed on the county GEOID, and `countyForPoint` is one Census
 *    HTTP request per row. `coverage.ts` already refuses to grow a geometry
 *    service on the server for exactly this reason. So a county column is an
 *    INPUT, and a set anchored on a table that has not been geocoded is told
 *    to run the pass that makes one.
 *  - **The ceiling refuses rather than crawls**, naming the local pass.
 *
 * Neither source dataset is touched. The output is a derived column on the
 * set, which is what keeps provenance clean and the sources re-fetchable.
 *
 * **P7-6 inverted the default here.** P7-5 reused a stored result when the
 * question matched; this now SERVES one whenever its inputs still hold, says
 * `served: 'stored'` so a caller can tell, and recomputes only when an input
 * has actually changed — the sentence naming which one riding back with the
 * new number. That is the whole of "batch by default, the API as the
 * exception": the cheapest proximity run is the one that reads nothing, and it
 * is only safe to make it the default because `analysisInputs.ts` can answer
 * whether the bytes underneath have moved.
 */

import { getCatalogEntry } from './libraryCatalog.js'
import { getFile } from './libraryBucket.js'
import { pickTabularFile, readDataset, type ParsedDataset } from './libraryTabular.js'
import {
  INTERNAL_LAYER_ID_PREFIX,
  normalizeGeoId,
  parseLayerBlock,
  readInternalLayerValues,
} from './internalLayers.js'
import { GEOID_COLUMN_RE, LAT_COLUMN_RE, LNG_COLUMN_RE, findColumn } from './placeAdapters/shared.js'
import { getWorkingSet, putDerivedColumns, type DerivedColumnWrite, type WorkingSet } from './libraryWorkingSets.js'
import { workingSetPrefix } from './workingSetMeta.js'
import { DERIVED_COLUMNS_MAX, readDerivedColumns } from './workingSetColumns.js'
import {
  captureAnalysisInput,
  checkAnalysisInputs,
  type AnalysisInput,
  type Freshness,
  type InputVerdict,
} from './analysisInputs.js'
import {
  measureProximity,
  prepareTargets,
  proximityMethod,
  proximityRefusal,
  targetsFromFeatures,
  type ProximityRow,
  type ProximityRowResult,
  type ProximityStats,
} from './proximity.js'

/** A refusal with the status it deserves. 413 is the ceiling, the same status
 *  `TabularError` uses for every other "too big to do here" in the library. */
export class ProximityError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'ProximityError'
  }
}

/** The column names a table must offer before anything can be measured. */
const LABEL_COLUMN_RE = /^(name|title|label|site|site_name|sitename|facility|facility_name|project)$/i

export interface ProximityInput {
  /** The working set the column lands on. */
  set: string
  /** Dataset A. Defaults to the set's anchor (`sites`). */
  from?: string
  /** Layer B: `internal-<slug>` or the bare slug of a member with a layer. */
  to: string
  /** Also count features within this many miles. A route hands this over
   *  straight from a JSON body, so a string is one of the shapes it arrives in. */
  within?: number | string | null
  /** The column id. Defaults to `miles-to-<layer slug>`. */
  id?: string
  /** Recompute even when an identical analysis is already stored. */
  recompute?: boolean
  by?: string
  byId?: number | null
}

/**
 * What produced a column, written onto the manifest beside it.
 *
 * Provenance first — §F.4c wants *"what produced it, from which inputs, when,
 * and by whom"* — and reuse falls out of it: a re-run compares these fields
 * and finds it has already been asked.
 *
 * **P7-6 added `inputs` to this record and nothing beside it.** There is still
 * one results store (the set's manifest) and one key (the analysis definition
 * plus the working set); the versions live in the record that already said
 * which inputs they are. Reuse is still field equality a person can read in
 * the manifest — `from`, `to`, `within` — and staleness is the same comparison
 * one level down, on the bytes those slugs named. No clock, no TTL, and no
 * second keying scheme for a later ticket to undo.
 */
export interface ProximityAnalysis {
  type: 'proximity'
  from: string
  to: string
  within: number | null
  /** Column ids this run wrote: the distance, then the count when asked. */
  columns: string[]
  /** The per-row numbers, beside the manifest. The county column is a
   *  projection of these; these are what a story quotes about one site. */
  rowsFile: string
  rows: number
  measured: number
  targets: number
  /**
   * P7-6: the two inputs and the version of each the run actually read — the
   * file, its size, the columns it was read with, and a fingerprint of its
   * bytes. This is what makes "has an input changed?" answerable, and so what
   * makes serving a stored column instead of recomputing it safe.
   *
   * Optional on the TYPE because a column written before P7-6 has none, and
   * such a column still renders — labelled as uncheckable rather than quietly
   * passed off as current.
   */
  inputs?: AnalysisInput[]
  by: string
  at: string
}

export interface ProximityRun {
  set: string
  from: string
  /** The layer id, as a set names one. */
  to: string
  within: number | null
  /** True when an identical analysis was stored and nothing was computed. */
  reused: boolean
  /**
   * P7-6, and the answer the owner asked for: **did this serve a stored column
   * or compute one?**
   *
   * `'stored'` means not one byte was read and not one distance measured — the
   * stored result answered. `'computed'` means it ran. Said in the response
   * rather than inferred from a timestamp, because "minimise Railway
   * computation" is only a claim you can check if the response says which it
   * did.
   */
  served: 'stored' | 'computed'
  /** The standing of the result being returned: whether its inputs still hold. */
  freshness: InputVerdict
  /**
   * Why it is not simply fresh, in a sentence. Two different things, both
   * worth saying: on a served result, that a stored number's input has moved
   * underneath it; on a computed one, that a changed input is the REASON it
   * recomputed rather than serving.
   */
  staleNote: string
  columns: { id: string; label: string; unit: string; counties: number }[]
  perRow: ProximityRowResult[]
  stats: ProximityStats
  method: string
  computedAt: string
}

// --- Resolution --------------------------------------------------------------

function columnNames(ds: ParsedDataset): string[] {
  return ds.columns.map(c => c.name)
}

/**
 * The table file an entry's layer block names, when the entry actually holds
 * one by that name.
 *
 * Returning `undefined` rather than the name means `readDataset` falls back to
 * its own first-tabular-file rule, which is what it did before P7-6 — a
 * declaration pointing at a file that is no longer there must not turn a
 * working measurement into a 404.
 */
function declaredFileOf(meta: Record<string, unknown>, files: { key: string; size: number }[]): string | undefined {
  const block = meta.layer === undefined ? null : parseLayerBlock(meta)
  const named = block && !('error' in block) ? (block.block.file ?? '') : ''
  if (!named) return undefined
  return pickTabularFile(files ?? [], named).chosen ? named : undefined
}

interface PointColumns {
  lat: string
  lng: string
  label: string
  geoid: string
}

/**
 * Which columns of A hold a point, a name and a county.
 *
 * The manifest's own layer block wins when there is one — P7-3's rule that a
 * layer says what it reads, rather than a guess being made beside a
 * declaration. Otherwise the same name regexes the download adapter already
 * uses for a county fetch, so "which column is the latitude" has one answer
 * on this server and not two.
 */
function pointColumnsOf(meta: Record<string, unknown>, ds: ParsedDataset, slug: string): PointColumns {
  const names = columnNames(ds)
  const block = meta.layer === undefined ? null : parseLayerBlock(meta)
  const declared = block && !('error' in block) && block.block.geometry === 'point' ? block.block : null

  const lat = findColumn(names, LAT_COLUMN_RE, declared?.latKey)
  const lng = findColumn(names, LNG_COLUMN_RE, declared?.lngKey)
  if (!lat || !lng) {
    throw new ProximityError(
      400,
      `“${slug}” has no latitude and longitude columns, so there is nothing to measure from. ` +
        `Add them with: npm run library -- geocode <csv> --address <column>`,
    )
  }

  // The county is an INPUT, not something this works out. The alternative is a
  // Census request per row, which is a geometry service this server has
  // deliberately never grown (coverage.ts, P6-19).
  const geoid = findColumn(names, GEOID_COLUMN_RE)
  if (!geoid) {
    throw new ProximityError(
      400,
      `“${slug}” has no county FIPS column, so a measurement over it cannot be drawn on the map or ` +
        `sorted in the table — both are keyed on the county. Add one with: ` +
        `npm run library -- geocode <csv> --lat ${lat} --lng ${lng}`,
    )
  }

  return { lat, lng, geoid, label: findColumn(names, LABEL_COLUMN_RE, declared?.labelKey) ?? names[0] ?? '' }
}

/** Dataset A's rows, as the primitive takes them. */
function rowsOf(ds: ParsedDataset, cols: PointColumns): ProximityRow[] {
  return ds.rows.map((row, index) => {
    const lat = Number(row[cols.lat])
    const lng = Number(row[cols.lng])
    const placed = (row[cols.lat] ?? '').trim() !== '' && (row[cols.lng] ?? '').trim() !== ''
    return {
      index,
      label: (row[cols.label] ?? '').trim() || `Row ${index + 1}`,
      lat: placed && Number.isFinite(lat) ? lat : null,
      lng: placed && Number.isFinite(lng) ? lng : null,
      geoid: normalizeGeoId(row[cols.geoid] ?? ''),
    }
  })
}

/** Dataset A: the set's anchor unless the caller named a member. */
function datasetAFor(set: WorkingSet, from: string | undefined): string {
  const slug = (from ?? set.sites ?? '').trim()
  if (!slug) {
    throw new ProximityError(
      400,
      `“${set.title}” is not anchored on a dataset, so there are no rows to measure from. ` +
        `Anchor it on the table of sites, or name one with “from”.`,
    )
  }
  if (!set.datasets.includes(slug)) {
    throw new ProximityError(400, `“${slug}” is not in this working set. Add it to the set first.`)
  }
  return slug
}

/**
 * Layer B's slug, checked against what the set names.
 *
 * Accepts either spelling a caller naturally has — the `internal-<slug>` id a
 * view and the canvas use, or the bare member slug — and refuses anything the
 * set does not reach.
 */
function layerBFor(set: WorkingSet, to: string): { slug: string; layerId: string } {
  const asked = (to ?? '').trim()
  if (!asked) throw new ProximityError(400, 'Name the layer to measure to.')
  const slug = asked.startsWith(INTERNAL_LAYER_ID_PREFIX) ? asked.slice(INTERNAL_LAYER_ID_PREFIX.length) : asked
  const layerId = `${INTERNAL_LAYER_ID_PREFIX}${slug}`
  if (!set.layers.includes(layerId) && !set.datasets.includes(slug)) {
    throw new ProximityError(
      400,
      `“${asked}” is not a layer this working set names. Add it to the set first — a measurement ` +
        `against something outside the set would not be the question the set is asking.`,
    )
  }
  return { slug, layerId }
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

function columnIdFor(input: ProximityInput, layerSlug: string): string {
  const asked = (input.id ?? '').trim().toLowerCase()
  if (asked) {
    if (!ID_RE.test(asked)) throw new ProximityError(400, `“${asked}” is not a column id: lower case, digits and dashes.`)
    return asked
  }
  return `miles-to-${layerSlug}`.slice(0, 64).replace(/-+$/, '')
}

function withinFor(input: ProximityInput): number | null {
  if (input.within === undefined || input.within === null) return null
  if (typeof input.within === 'string' && !input.within.trim()) return null
  const miles = Number(input.within)
  if (!Number.isFinite(miles)) throw new ProximityError(400, 'A “within” radius has to be a number of miles.')
  return miles
}

// --- Reuse -------------------------------------------------------------------

function analysisOf(doc: unknown): ProximityAnalysis | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const analysis = (doc as { analysis?: unknown }).analysis
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) return null
  const record = analysis as Record<string, unknown>
  return record.type === 'proximity' ? (record as unknown as ProximityAnalysis) : null
}

/**
 * The stored analysis answering exactly this question, or null.
 *
 * Field equality on the record the column already carries for provenance —
 * the same dataset, the same layer, the same radius. A re-run of a question
 * already asked is not recomputed, which is the acceptance criterion, and the
 * comparison is readable in the manifest rather than hidden in a digest.
 */
export function storedProximity(
  derived: unknown,
  match: { from: string; to: string; within: number | null },
): ProximityAnalysis | null {
  if (!Array.isArray(derived)) return null
  for (const doc of derived) {
    const analysis = analysisOf(doc)
    if (!analysis) continue
    if (analysis.from !== match.from || analysis.to !== match.to) continue
    if ((analysis.within ?? null) !== match.within) continue
    return analysis
  }
  return null
}

interface StoredRows {
  rows: ProximityRowResult[]
  stats: ProximityStats
  method: string
}

async function readStoredRows(set: string, file: string): Promise<StoredRows | null> {
  try {
    const body = JSON.parse((await getFile(`${workingSetPrefix(set)}${file}`)).toString('utf8'))
    if (!body || !Array.isArray(body.rows)) return null
    return { rows: body.rows, stats: body.stats, method: typeof body.method === 'string' ? body.method : '' }
  } catch {
    return null
  }
}

// --- The run -----------------------------------------------------------------

/**
 * Measure dataset A against layer B and write the result onto the set.
 *
 * One or two columns: the distance always, the count when a radius was asked
 * for. Both GEOID-keyed, so `GET /api/working-sets/:slug/columns` serves them
 * to both interfaces with no second read surface and no second computation —
 * the explorer sorts the column and the map reports it the moment this
 * returns.
 */
export async function runWorkingSetProximity(input: ProximityInput): Promise<ProximityRun> {
  const set = await getWorkingSet(input.set)
  if (!set) throw new ProximityError(404, `There is no working set called “${input.set}”.`)

  const from = datasetAFor(set, input.from)
  const { slug: toSlug, layerId } = layerBFor(set, input.to)
  const within = withinFor(input)
  const id = columnIdFor(input, toSlug)

  // Reuse before any reading: the point of storing a result is that an
  // unchanged question costs nothing at all, not that it costs less.
  //
  // **P7-6 makes this the default rather than a shortcut.** A stored result
  // whose inputs still hold is SERVED — nothing parsed, nothing measured, no
  // Railway compute — and the response says so. A stored result whose input
  // has changed is a wrong number, so it recomputes and says that too. The
  // only thing that cannot be served is a question nobody has asked yet.
  let staleBefore = ''
  if (!input.recompute) {
    const stored = storedProximity(set.derived, { from, to: layerId, within })
    if (stored) {
      const freshness = await checkAnalysisInputs(stored.inputs)
      if (freshness.verdict === 'stale') {
        // Recompute, and carry the reason into the response: "it recomputed"
        // is not the interesting half, "because the sites table changed" is.
        staleBefore = freshness.note
      } else {
        const rows = await readStoredRows(set.slug, stored.rowsFile)
        const columns = readDerivedColumns(set.derived).filter(c => stored.columns.includes(c.id))
        return {
          set: set.slug,
          from,
          to: layerId,
          within,
          reused: true,
          served: 'stored',
          // 'unknown' when the stored result records no input versions: it is
          // still served, because recomputing every pre-P7-6 column on sight
          // is exactly the Railway compute this ticket exists to avoid, and
          // the label says it could not be checked.
          freshness: freshness.verdict,
          staleNote: freshness.note,
          columns: columns.map(c => ({ id: c.id, label: c.label ?? c.id, unit: c.unit ?? '', counties: 0 })),
          perRow: rows?.rows ?? [],
          stats: rows?.stats ?? {
            rows: stored.rows,
            measured: stored.measured,
            withoutPoint: stored.rows - stored.measured,
            withoutCounty: 0,
            counties: 0,
            targets: stored.targets,
            vertices: 0,
          },
          method: rows?.method ?? '',
          computedAt: stored.at,
        }
      }
    }
  }

  const entry = await getCatalogEntry(from)
  if (!entry || entry.kind !== 'dataset') {
    throw new ProximityError(400, `“${from}” is not a dataset we hold, so it has no rows to measure.`)
  }
  // The file the manifest's layer block NAMES, which is the file the local
  // pass has always read (`readTable(fromEntry, declared?.file)`). The request
  // tier read "whichever table came first" instead, so an entry holding two
  // tables could be measured differently by the two tiers — and P7-5's own
  // rule is that they can never disagree about a number, one of them declines.
  // It also makes the recorded input version name the file that was read.
  //
  // A block naming a file the entry does not hold falls back to "whichever
  // came first" rather than 404ing: the manifest is hand-editable, and a
  // declaration that has gone wrong must not take the measurement down with
  // it when there is still a table to read.
  const { parsed } = await readDataset(from, declaredFileOf(entry.meta, entry.files))
  const cols = pointColumnsOf(entry.meta, parsed, from)
  const rows = rowsOf(parsed, cols)

  const layer = await readInternalLayerValues(toSlug)
  if (layer.geometry === 'county') {
    throw new ProximityError(
      400,
      `“${layerId}” is a county layer: it has values, not features, so there is nothing to measure a ` +
        `distance to. Proximity needs a point or line layer.`,
    )
  }
  const targets = prepareTargets(targetsFromFeatures(layer.features))
  const vertices = targets.reduce((n, t) => n + t.vertices, 0)

  const refusal = proximityRefusal(rows.length, vertices, within)
  if (refusal) throw new ProximityError(413, refusal)

  const toEntry = await getCatalogEntry(toSlug)
  const toName = toEntry?.title ?? toSlug
  const result = measureProximity(rows, targets, { within })
  const method = proximityMethod({ from: entry.title, to: toName, stats: result.stats, within })
  const computedAt = new Date().toISOString()

  // P7-6: the version of each input, recorded at the moment it was read. The
  // bytes are warm — both files were parsed moments ago — so this is a mirror
  // read and a hash, not a download. `parsed.file` is the file that was
  // actually read rather than the one the manifest asked for, which is what
  // the check will look for later.
  const inputs: AnalysisInput[] = [
    await captureAnalysisInput({ slug: from, role: 'from', file: parsed.file }),
    await captureAnalysisInput({
      slug: toSlug,
      role: 'to',
      file: toEntry ? (declaredFileOf(toEntry.meta, toEntry.files) ?? '') : '',
    }),
  ]

  const countId = within === null ? null : `${id}-within-${String(within).replace('.', '-')}mi`.slice(0, 64)
  const rowsFile = `derived/${id}.rows.json`
  const analysis: ProximityAnalysis = {
    type: 'proximity',
    from,
    to: layerId,
    within,
    columns: countId ? [id, countId] : [id],
    rowsFile,
    rows: result.stats.rows,
    measured: result.stats.measured,
    targets: result.stats.targets,
    inputs,
    by: input.by ?? '',
    at: computedAt,
  }

  const writes: DerivedColumnWrite[] = [
    { id, label: `Miles to nearest ${toName}`, unit: 'miles', method, values: result.values, analysis },
  ]
  if (countId && result.counts) {
    writes.push({
      id: countId,
      label: `${toName} within ${within} ${within === 1 ? 'mile' : 'miles'}`,
      unit: 'count',
      method,
      values: result.counts,
      analysis,
    })
  }

  const already = readDerivedColumns(set.derived).filter(c => !writes.some(w => w.id === c.id)).length
  if (already + writes.length > DERIVED_COLUMNS_MAX) {
    throw new ProximityError(
      400,
      `This set already carries ${already} derived columns, and ${DERIVED_COLUMNS_MAX} is the most it holds. ` +
        `Nothing was computed.`,
    )
  }

  const written = await putDerivedColumns(set.slug, writes, [
    {
      key: rowsFile,
      // The per-row numbers in full. The county column is a projection of
      // these; these are what "the xAI site is 1.8 miles from the nearest
      // transmission line" is quoting, and they outlive the response.
      body: JSON.stringify({ analysis, method, stats: result.stats, rows: result.perRow }),
    },
  ])
  if (!written) throw new ProximityError(404, `There is no working set called “${input.set}”.`)

  return {
    set: set.slug,
    from,
    to: layerId,
    within,
    reused: false,
    served: 'computed',
    // A result just measured against the versions it just recorded is fresh by
    // construction; there is nothing to check it against that is not itself.
    freshness: 'fresh',
    // Empty on a first run, and the reason on a recompute: a reader who asked
    // for a measurement and got a NEW number is owed the sentence saying which
    // input moved underneath the old one.
    staleNote: staleBefore,
    columns: writes.map(w => ({
      id: w.id,
      label: w.label,
      unit: w.unit,
      counties: Object.keys(w.values).length,
    })),
    perRow: result.perRow,
    stats: result.stats,
    method,
    computedAt,
  }
}

/**
 * The proximity analyses a set carries, newest write last — the read side of
 * what this wrote, so a stored per-row number is citable after the response
 * that computed it has gone.
 *
 * **Each one carries its standing** (P7-6): a per-row number a story is about
 * to quote is exactly where "stale must be visible, never silent" has to hold.
 * Nothing is recomputed and nothing is hidden — a stale analysis comes back
 * with all its rows and a sentence saying what moved.
 */
export async function listWorkingSetProximity(
  slug: string,
): Promise<{ analysis: ProximityAnalysis; rows: ProximityRowResult[]; freshness: Freshness }[]> {
  const set = await getWorkingSet(slug)
  if (!set) return []
  const out: { analysis: ProximityAnalysis; rows: ProximityRowResult[]; freshness: Freshness }[] = []
  const seen = new Set<string>()
  for (const doc of Array.isArray(set.derived) ? set.derived : []) {
    const analysis = analysisOf(doc)
    if (!analysis || seen.has(analysis.rowsFile)) continue
    seen.add(analysis.rowsFile)
    const stored = await readStoredRows(slug, analysis.rowsFile)
    out.push({ analysis, rows: stored?.rows ?? [], freshness: await checkAnalysisInputs(analysis.inputs) })
  }
  return out
}
