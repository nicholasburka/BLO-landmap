/**
 * `npm run library -- proximity` (P7-5) — the **bulk tier**.
 *
 * Spec §F.4b: *"the thing that decides where an analysis belongs is not the
 * operation, it is the cardinality. Proximity over 13 sites × 1 layer is
 * microseconds. Proximity over 190,000 brownfields × 1 layer is a batch job.
 * Same primitive, different home."* This is the batch home, and it is the
 * same primitive — `measureProximity` from `services/proximity.ts`, byte for
 * byte the function the request uses, so a number computed here and a number
 * computed on the server cannot differ.
 *
 * What is different is everything around it:
 *
 *  - **No ceiling.** `proximityRefusal` is not called. A request has to refuse
 *    190,000 rows because it would block the single instance for minutes; a
 *    local pass has all afternoon.
 *  - **No bucket and no database.** It reads a tree already pulled with
 *    `npm run library -- pull` and writes manifests back into it, exactly like
 *    `retag`. The dev then pushes, and a reindex picks the result up — §F.4b's
 *    *"internal analysis outputs go to the library bucket and are picked up by
 *    a reindex — no build, no deploy"*.
 *  - **Dry run by default**, `--apply` to write, following `retag` rather than
 *    `geocode`: this rewrites a manifest, and the report should be read before
 *    that happens.
 *  - **The layer's geometry is read uncapped** (`featureGeometryOf`), because
 *    `LAYER_MAX_VERTICES` bounds what the API ships and this ships nothing.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseTabular, type ParsedDataset } from '../services/libraryTabular.js'
import {
  INTERNAL_LAYER_ID_PREFIX,
  featureGeometryOf,
  normalizeGeoId,
  parseLayerBlock,
} from '../services/internalLayers.js'
import { GEOID_COLUMN_RE, LAT_COLUMN_RE, LNG_COLUMN_RE, findColumn } from '../services/placeAdapters/shared.js'
import { fingerprintOf, layerKeysOf, type AnalysisInput } from '../services/analysisInputs.js'
import {
  measureProximity,
  prepareTargets,
  proximityMethod,
  type ProximityRowResult,
  type ProximityStats,
} from '../services/proximity.js'

export interface ProximityCliArgs {
  /** The working set's slug — the directory under `library/working-sets/`. */
  set: string
  /** Layer B: `internal-<slug>` or the bare dataset slug. */
  to: string
  /** Dataset A. Defaults to the set's own `sites` anchor. */
  from?: string
  within?: number | null
  id?: string
  apply?: boolean
}

const TABULAR = /\.(csv|tsv|json|geojson)$/i
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** `proximity <set> --to <layer> …`, in the same shape `parseGeocodeArgs`
 *  returns: the arguments, or one sentence saying what is missing. */
export function parseProximityArgs(args: string[]): ProximityCliArgs | { error: string } {
  const val = (flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at !== -1 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : undefined
  }
  const set = args.find(a => !a.startsWith('--') && a !== 'proximity' && args[args.indexOf(a) - 1] !== '--dir')
  if (!set) return { error: 'proximity: missing <working-set> slug' }
  const to = val('--to')
  if (!to) return { error: 'proximity: give --to <layer>, the layer to measure distances to' }

  const id = val('--id')
  if (id !== undefined && !ID_RE.test(id)) return { error: `proximity: "${id}" is not a column id (lower case, digits, dashes)` }

  let within: number | null = null
  const rawWithin = val('--within')
  if (rawWithin !== undefined) {
    within = Number(rawWithin)
    if (!Number.isFinite(within) || within <= 0) return { error: `proximity: --within "${rawWithin}" is not a number of miles` }
  }

  return {
    set,
    to,
    ...(val('--from') ? { from: val('--from') } : {}),
    ...(id !== undefined ? { id } : {}),
    within,
    apply: args.includes('--apply'),
  }
}

// --- Reading a pulled tree ---------------------------------------------------

interface LocalEntry {
  slug: string
  dir: string
  meta: Record<string, unknown>
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readEntry(localDir: string, kind: string, slug: string): Promise<LocalEntry> {
  const dir = join(localDir, 'library', kind, slug)
  try {
    return { slug, dir, meta: await readJson(join(dir, 'meta.json')) }
  } catch {
    throw new Error(`proximity: no ${kind.replace(/s$/, '')} at ${join(dir, 'meta.json')} — pull the tree first?`)
  }
}

/** A table as read off the local tree, with the facts P7-6 records about it. */
interface LocalTable {
  parsed: ParsedDataset
  /** The file read, by basename inside the entry — what the version names. */
  file: string
  bytes: number
  /** The fingerprint of its bytes, from the same function the server uses. */
  content: string
}

/** The entry's tabular file: the one the layer block names, else the first
 *  one there is. `pickTabularFile`'s rule, over a directory instead of a
 *  catalog row. */
async function readTable(entry: LocalEntry, named?: string): Promise<LocalTable> {
  const files = (await readdir(entry.dir)).filter(f => TABULAR.test(f) && f !== 'meta.json').sort()
  const file = named && files.includes(named) ? named : files[0]
  if (!file) throw new Error(`proximity: ${entry.slug} has no csv/tsv/json/geojson file in ${entry.dir}`)
  const path = join(entry.dir, file)
  const body = await readFile(path)
  // Fingerprinted here, off the bytes this pass actually parsed, with the same
  // function the request tier uses — so a column written locally and pushed is
  // checkable by the server without the server re-deriving anything.
  return { parsed: parseTabular(body, path), file, bytes: body.byteLength, content: fingerprintOf(body) }
}

/**
 * The input version this pass records, as the server will read it back.
 *
 * `at` is deliberately empty: that field is the entry's catalog stamp, and a
 * local pass over a pulled tree has no catalog to ask. It is only ever a short
 * circuit — "nothing was written, so skip the hash" — so leaving it out costs a
 * content read on the first check and never changes a verdict. A batch result
 * is verified by its bytes, full stop, which is the right way round for the
 * tier that produces the big ones.
 */
function localInput(slug: string, role: string, entry: LocalEntry, table: LocalTable): AnalysisInput {
  return {
    slug,
    role,
    file: table.file,
    bytes: table.bytes,
    keys: layerKeysOf(entry.meta),
    content: table.content,
    at: '',
  }
}

// --- The pass ----------------------------------------------------------------

export interface ProximityCliReport {
  set: string
  from: string
  to: string
  within: number | null
  columnId: string
  countColumnId: string | null
  label: string
  method: string
  rows: ProximityRowResult[]
  stats: ProximityStats
  /** Files it wrote, relative to the local tree. Empty on a dry run. */
  written: string[]
  elapsedMs: number
}

export async function runProximity(
  cli: ProximityCliArgs,
  localDir: string,
  log: (s: string) => void = console.log,
): Promise<ProximityCliReport> {
  const started = Date.now()
  const set = await readEntry(localDir, 'working-sets', cli.set)

  const fromSlug = cli.from ?? (typeof set.meta.sites === 'string' ? set.meta.sites : '')
  if (!fromSlug) {
    throw new Error(`proximity: ${cli.set} is not anchored on a dataset — name one with --from <dataset>`)
  }
  const toSlug = cli.to.startsWith(INTERNAL_LAYER_ID_PREFIX) ? cli.to.slice(INTERNAL_LAYER_ID_PREFIX.length) : cli.to
  const layerId = `${INTERNAL_LAYER_ID_PREFIX}${toSlug}`

  // Dataset A.
  const fromEntry = await readEntry(localDir, 'datasets', fromSlug)
  const fromBlock = fromEntry.meta.layer === undefined ? null : parseLayerBlock(fromEntry.meta)
  const declared = fromBlock && !('error' in fromBlock) && fromBlock.block.geometry === 'point' ? fromBlock.block : null
  const fromTable = await readTable(fromEntry, declared?.file)
  const table = fromTable.parsed
  const names = table.columns.map(c => c.name)
  const latKey = findColumn(names, LAT_COLUMN_RE, declared?.latKey)
  const lngKey = findColumn(names, LNG_COLUMN_RE, declared?.lngKey)
  const geoKey = findColumn(names, GEOID_COLUMN_RE)
  if (!latKey || !lngKey) {
    throw new Error(
      `proximity: ${fromSlug} has no latitude/longitude columns (has: ${names.join(', ')})\n` +
        `         add them first: npm run library -- geocode <csv> --address <column>`,
    )
  }
  if (!geoKey) {
    throw new Error(
      `proximity: ${fromSlug} has no county FIPS column, and a derived column is keyed on the county\n` +
        `         add one first: npm run library -- geocode <csv> --lat ${latKey} --lng ${lngKey}`,
    )
  }
  const labelKey =
    findColumn(names, /^(name|title|label|site|site_name|sitename|facility|facility_name|project)$/i, declared?.labelKey) ??
    names[0]

  const rows = table.rows.map((row, index) => {
    const lat = Number(row[latKey])
    const lng = Number(row[lngKey])
    const placed = (row[latKey] ?? '').trim() !== '' && (row[lngKey] ?? '').trim() !== ''
    return {
      index,
      label: (row[labelKey] ?? '').trim() || `Row ${index + 1}`,
      lat: placed && Number.isFinite(lat) ? lat : null,
      lng: placed && Number.isFinite(lng) ? lng : null,
      geoid: normalizeGeoId(row[geoKey] ?? ''),
    }
  })

  // Layer B — uncapped, which is the point of running locally.
  const toEntry = await readEntry(localDir, 'datasets', toSlug)
  const toBlock = parseLayerBlock(toEntry.meta)
  if ('error' in toBlock) throw new Error(`proximity: ${toSlug} has no usable layer block (${toBlock.error})`)
  // P7-9: a state layer is refused here by name, exactly as a county layer is,
  // and for the same reason — neither carries a coordinate to measure to. The
  // client's `measurableLayersOf` already offers only points and lines, so this
  // is the server saying the same thing rather than a second opinion.
  if (toBlock.block.geometry === 'county' || toBlock.block.geometry === 'state') {
    throw new Error(
      `proximity: ${toSlug} is a ${toBlock.block.geometry} layer — it is drawn on geometry it does not carry. Proximity needs points or lines.`,
    )
  }
  const layerTable = await readTable(toEntry, toBlock.block.file)
  const targets = prepareTargets(featureGeometryOf(layerTable.parsed, toBlock.block))
  if (!targets.length) throw new Error(`proximity: ${toSlug} has no drawable features to measure to`)

  const toName = typeof toEntry.meta.title === 'string' ? toEntry.meta.title : toSlug
  const fromName = typeof fromEntry.meta.title === 'string' ? fromEntry.meta.title : fromSlug
  const columnId = cli.id ?? `miles-to-${toSlug}`.slice(0, 64).replace(/-+$/, '')
  const within = cli.within ?? null
  const countColumnId = within === null ? null : `${columnId}-within-${String(within).replace('.', '-')}mi`.slice(0, 64)

  log(
    `Proximity · ${typeof set.meta.title === 'string' ? set.meta.title : cli.set}\n` +
      `From ${fromName} (${table.rowCount.toLocaleString()} rows) → ${toName} ` +
      `(${targets.length.toLocaleString()} features, ${targets.reduce((n, t) => n + t.vertices, 0).toLocaleString()} vertices)` +
      (within === null ? '' : `, counting within ${within} miles`),
  )

  const result = measureProximity(rows, targets, { within })
  const method = proximityMethod({ from: fromName, to: toName, stats: result.stats, within })
  const computedAt = new Date().toISOString()

  const written: string[] = []
  if (cli.apply) {
    const rowsFile = `derived/${columnId}.rows.json`
    const analysis = {
      type: 'proximity' as const,
      from: fromSlug,
      to: layerId,
      within,
      columns: countColumnId ? [columnId, countColumnId] : [columnId],
      rowsFile,
      rows: result.stats.rows,
      measured: result.stats.measured,
      targets: result.stats.targets,
      // P7-6: the version of each input, in the same shape the request tier
      // writes. Tier 1 and tier 2 write to one store (§F.4c), so they have to
      // write one record — a staleness check must not need to know which tier
      // produced the number it is checking.
      inputs: [
        localInput(fromSlug, 'from', fromEntry, fromTable),
        localInput(toSlug, 'to', toEntry, layerTable),
      ],
      // Named, not a person: this is the batch tier, so the provenance §F.4c
      // asks for is the pass that ran rather than a user who pressed a button.
      by: 'npm run library -- proximity',
      at: computedAt,
    }

    const columns: Record<string, unknown>[] = [
      { id: columnId, label: `Miles to nearest ${toName}`, unit: 'miles', method, computedAt, analysis, values: result.values },
    ]
    if (countColumnId && result.counts) {
      columns.push({
        id: countColumnId,
        label: `${toName} within ${within} ${within === 1 ? 'mile' : 'miles'}`,
        unit: 'count',
        method,
        computedAt,
        analysis,
        values: result.counts,
      })
    }

    await mkdir(join(set.dir, 'derived'), { recursive: true })
    await writeFile(
      join(set.dir, rowsFile),
      JSON.stringify({ analysis, method, stats: result.stats, rows: result.perRow }),
      'utf8',
    )
    written.push(`library/working-sets/${cli.set}/${rowsFile}`)

    // A column too big for a manifest goes in a file beside it, the same
    // threshold the server uses — so the two tiers write the same shape and
    // P7-2's one reader resolves both.
    const INLINE_MAX = 64 * 1024
    for (const column of columns) {
      const inline = JSON.stringify(column.values)
      if (Buffer.byteLength(inline) <= INLINE_MAX) continue
      const file = `derived/${column.id}.json`
      await writeFile(join(set.dir, file), inline, 'utf8')
      delete column.values
      column.file = file
      written.push(`library/working-sets/${cli.set}/${file}`)
    }

    // The manifest is re-serialised from the parsed object, so every field
    // this pass does not touch comes back byte-identical (retag's rule).
    const derived = Array.isArray(set.meta.derived) ? [...set.meta.derived] : []
    for (const column of columns) {
      const at = derived.findIndex(
        item => item && typeof item === 'object' && (item as { id?: unknown }).id === column.id,
      )
      if (at >= 0) derived[at] = column
      else derived.push(column)
    }
    set.meta.derived = derived
    await writeFile(join(set.dir, 'meta.json'), `${JSON.stringify(set.meta, null, 2)}\n`, 'utf8')
    written.push(`library/working-sets/${cli.set}/meta.json`)
  }

  return {
    set: cli.set,
    from: fromSlug,
    to: layerId,
    within,
    columnId,
    countColumnId,
    label: `Miles to nearest ${toName}`,
    method,
    rows: result.perRow,
    stats: result.stats,
    written,
    elapsedMs: Date.now() - started,
  }
}

// --- The report --------------------------------------------------------------

/** The nearest and furthest rows, which is what a reader checks first — a
 *  190,000-row table cannot be printed and its two ends can. */
const SAMPLE = 10

export function formatProximityReport(report: ProximityCliReport): string {
  const pad = (v: string, w: number) => v.padEnd(w)
  const lines: string[] = ['']

  const measured = report.rows.filter(r => r.miles !== null).sort((a, b) => (a.miles ?? 0) - (b.miles ?? 0))
  const shown = measured.length <= SAMPLE * 2 ? measured : [...measured.slice(0, SAMPLE), ...measured.slice(-SAMPLE)]
  lines.push(`${pad('row', 38)}${pad('county', 8)}${pad('miles', 9)}${report.within === null ? '' : pad('within', 8)}nearest`)
  lines.push('-'.repeat(report.within === null ? 92 : 100))
  let last = -1
  for (const row of shown) {
    // One gap line where the middle was skipped, so nobody reads the two ends
    // as the whole table.
    if (last >= 0 && row.index !== last && measured.length > SAMPLE * 2 && shown.indexOf(row) === SAMPLE) {
      lines.push(`… ${(measured.length - SAMPLE * 2).toLocaleString()} more rows`)
    }
    last = row.index
    lines.push(
      pad(row.label.slice(0, 37), 38) +
        pad(row.geoid ?? '—', 8) +
        pad((row.miles as number).toFixed(2), 9) +
        (report.within === null ? '' : pad(String(row.within ?? '—'), 8)) +
        row.nearest.slice(0, 40),
    )
  }

  const s = report.stats
  lines.push('')
  const counts = [
    `${s.rows.toLocaleString()} rows`,
    `${s.measured.toLocaleString()} measured`,
    `${s.counties.toLocaleString()} ${s.counties === 1 ? 'county' : 'counties'}`,
  ]
  // Only said when true — a run with nothing missing should not carry a "0
  // unplaced" clause for somebody to read past.
  if (s.withoutPoint) counts.push(`${s.withoutPoint.toLocaleString()} with no coordinates`)
  if (s.withoutCounty) counts.push(`${s.withoutCounty.toLocaleString()} measured but not in a county`)
  lines.push(counts.join(' · '))
  lines.push(`Took ${(report.elapsedMs / 1000).toFixed(1)}s · ${s.targets.toLocaleString()} features, ${s.vertices.toLocaleString()} vertices`)
  lines.push('')
  lines.push(`Column: ${report.columnId} (miles)${report.countColumnId ? ` · ${report.countColumnId} (count)` : ''}`)
  lines.push(`Method: ${report.method}`)
  lines.push('')

  if (report.written.length) {
    for (const file of report.written) lines.push(`Wrote ${file}`)
    lines.push('Push and reindex when you are happy: npm run library -- push')
  } else {
    lines.push('Nothing was written. Rerun with --apply once the report reads right.')
  }
  return lines.join('\n')
}

/** Does the local tree look like one? `retag`'s own check, so the message is
 *  the same one a dev has already seen. */
export async function isLibraryTree(localDir: string): Promise<boolean> {
  try {
    return (await stat(join(resolve(localDir), 'library'))).isDirectory()
  } catch {
    return false
  }
}
