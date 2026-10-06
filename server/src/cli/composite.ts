/**
 * `npm run library -- index` (P7-8) — the **bulk tier** for a weighted index.
 *
 * The same split P7-5 made for proximity, for the same reason (§F.4b: *"the
 * thing that decides where an analysis belongs is not the operation, it is the
 * cardinality"*). The arithmetic is `services/composite.ts`, byte for byte the
 * function the request uses, so an index computed here and one computed on the
 * server cannot differ. What is different is everything around it:
 *
 *  - **No ceiling.** `compositeRefusal` is not called. A request has to refuse
 *    a hundred megabytes of source tables because parsing them would block the
 *    single instance; a local pass has all afternoon.
 *  - **No bucket and no database.** It reads a tree already pulled with
 *    `npm run library -- pull` and writes manifests back into it, exactly like
 *    `retag` and `proximity`. The dev pushes, a reindex picks the result up.
 *  - **County values are read uncapped** (`countyValuesOf`), because
 *    `LAYER_MAX_VALUES` bounds what the API ships and this ships nothing.
 *  - **Public registry layers come off the disk**, from `public/datasets/`,
 *    which is where they already live in a checkout — so the pass that needs
 *    the `pct_Black` column needs no network at all.
 *  - **Dry run by default**, `--apply` to write: this rewrites a manifest, so
 *    the report should be read before that happens.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTabular, type ParsedDataset } from '../services/libraryTabular.js'
import { INTERNAL_LAYER_ID_PREFIX, countyValuesOf, parseLayerBlock } from '../services/internalLayers.js'
import { fingerprintOf, layerKeysOf, type AnalysisInput } from '../services/analysisInputs.js'
import {
  isPublicLayerId,
  publicLayerKeys,
  readPublicCountyLayer,
} from '../services/publicLayerValues.js'
import {
  canonicalTerms,
  compositeMethod,
  computeComposite,
  readCompositeTerms,
  type CompositeScale,
  type CompositeTerm,
  type CompositeTermValues,
} from '../services/composite.js'

export interface CompositeCliArgs {
  /** The working set's slug — the directory under `library/working-sets/`. */
  set: string
  /** What the index is called. */
  name: string
  /** `<layer>:<weight>:<direction>`, already parsed. */
  terms: CompositeTerm[]
  id?: string
  apply?: boolean
}

const TABULAR = /\.(csv|tsv|json|geojson)$/i
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** `higher`/`lower` as well as the full spellings — the shorthand is what
 *  anybody actually types on a command line, and the stored formula is the
 *  canonical word either way. */
function directionOf(raw: string): 'higher_better' | 'lower_better' | null {
  const word = raw.trim().toLowerCase()
  if (word === 'higher' || word === 'higher_better' || word === 'up') return 'higher_better'
  if (word === 'lower' || word === 'lower_better' || word === 'down') return 'lower_better'
  return null
}

/** `index <set> --name <label> --layer <layer>:<weight>:<direction> …`, in the
 *  same shape `parseProximityArgs` returns: the arguments, or one sentence. */
export function parseCompositeArgs(args: string[]): CompositeCliArgs | { error: string } {
  const val = (flag: string): string | undefined => {
    const at = args.indexOf(flag)
    return at !== -1 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : undefined
  }
  const set = args.find(a => !a.startsWith('--') && a !== 'index' && args[args.indexOf(a) - 1] !== '--dir')
  if (!set) return { error: 'index: missing <working-set> slug' }
  const name = val('--name')
  if (!name) return { error: 'index: give --name "<what the index is called>"' }

  const id = val('--id')
  if (id !== undefined && !ID_RE.test(id)) {
    return { error: `index: "${id}" is not a column id (lower case, digits, dashes)` }
  }

  // Every --layer, in order. `indexOf` finds only the first, so this walks.
  const raw: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--layer') continue
    const next = args[i + 1]
    if (!next || next.startsWith('--')) return { error: 'index: --layer needs <layer>:<weight>:<direction>' }
    raw.push(next)
  }
  if (!raw.length) {
    return { error: 'index: give at least two --layer <layer>:<weight>:<direction> terms' }
  }

  const terms: CompositeTerm[] = []
  for (const spec of raw) {
    // Split from the RIGHT: a layer id may contain a colon, a weight and a
    // direction may not.
    const parts = spec.split(':')
    if (parts.length < 3) return { error: `index: "${spec}" is not <layer>:<weight>:<direction>` }
    const direction = directionOf(parts[parts.length - 1])
    if (!direction) {
      return { error: `index: "${parts[parts.length - 1]}" is not a direction — say higher or lower` }
    }
    const weight = Number(parts[parts.length - 2])
    if (!Number.isFinite(weight) || weight <= 0) {
      return { error: `index: "${parts[parts.length - 2]}" is not a weight above zero` }
    }
    terms.push({ layer: parts.slice(0, -2).join(':'), weight, direction })
  }

  const read = readCompositeTerms(terms)
  if ('error' in read) return { error: `index: ${read.error}` }

  return {
    set,
    name,
    terms: read.terms,
    ...(id !== undefined ? { id } : {}),
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
    throw new Error(`index: no ${kind.replace(/s$/, '')} at ${join(dir, 'meta.json')} — pull the tree first?`)
  }
}

interface LocalTable {
  parsed: ParsedDataset
  file: string
  bytes: number
  content: string
}

/** The entry's tabular file: the one the layer block names, else the first
 *  one there is — `pickTabularFile`'s rule over a directory. */
async function readTable(entry: LocalEntry, named?: string): Promise<LocalTable> {
  const files = (await readdir(entry.dir)).filter(f => TABULAR.test(f) && f !== 'meta.json').sort()
  const file = named && files.includes(named) ? named : files[0]
  if (!file) throw new Error(`index: ${entry.slug} has no csv/tsv/json/geojson file in ${entry.dir}`)
  const path = join(entry.dir, file)
  const body = await readFile(path)
  return { parsed: parseTabular(body, path), file, bytes: body.byteLength, content: fingerprintOf(body) }
}

/**
 * One term's numbers, name and input record, read off the local tree or off
 * `public/datasets/`.
 *
 * The input records are written in the **same shape the request tier writes**,
 * including `source: 'public'` — §F.4c's one results store means one record,
 * and a staleness check must not need to know which tier produced the number
 * it is checking. `at` is empty for the same reason it is in the proximity
 * pass: it is the entry's catalog stamp, and a pulled tree has no catalog to
 * ask. It is only ever a short circuit, so leaving it out costs one content
 * read on the first check and never changes a verdict.
 */
async function resolveTerm(localDir: string, term: CompositeTerm): Promise<CompositeTermValues & { name: string; input: AnalysisInput }> {
  if (isPublicLayerId(term.layer)) {
    const layer = await readPublicCountyLayer(term.layer)
    return {
      ...term,
      name: layer.name,
      values: layer.values,
      input: {
        slug: term.layer,
        role: 'term',
        file: '',
        bytes: layer.bytes,
        keys: publicLayerKeys(term.layer),
        content: layer.content,
        at: '',
        source: 'public',
      },
    }
  }
  const slug = term.layer.startsWith(INTERNAL_LAYER_ID_PREFIX)
    ? term.layer.slice(INTERNAL_LAYER_ID_PREFIX.length)
    : term.layer
  const entry = await readEntry(localDir, 'datasets', slug)
  const parsedBlock = entry.meta.layer === undefined ? null : parseLayerBlock(entry.meta)
  if (!parsedBlock || 'error' in parsedBlock || parsedBlock.block.geometry !== 'county') {
    throw new Error(
      `index: ${slug} has no county layer block, so it has no values to weigh — an index is over county layers`,
    )
  }
  const block = parsedBlock.block
  const table = await readTable(entry, block.file)
  return {
    ...term,
    name: typeof entry.meta.title === 'string' && entry.meta.title ? entry.meta.title : slug,
    values: countyValuesOf(table.parsed, block),
    input: {
      slug,
      role: 'term',
      file: table.file,
      bytes: table.bytes,
      keys: layerKeysOf(entry.meta),
      content: table.content,
      at: '',
    },
  }
}

// --- The pass ----------------------------------------------------------------

export interface CompositeCliReport {
  set: string
  columnId: string
  label: string
  layerId: string
  terms: CompositeTerm[]
  scales: CompositeScale[]
  names: Record<string, string>
  method: string
  /** The highest and lowest counties, which is what a reader checks first. */
  values: Record<string, number>
  counties: number
  complete: number
  partial: number
  /** Files it wrote, relative to the local tree. Empty on a dry run. */
  written: string[]
  elapsedMs: number
}

export async function runComposite(
  cli: CompositeCliArgs,
  localDir: string,
  log: (s: string) => void = console.log,
): Promise<CompositeCliReport> {
  const started = Date.now()
  const set = await readEntry(localDir, 'working-sets', cli.set)

  const columnId =
    cli.id ??
    cli.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64)
      .replace(/-+$/, '')
  if (!ID_RE.test(columnId)) {
    throw new Error(`index: "${cli.name}" does not make a column id — pass one with --id`)
  }

  const resolved: (CompositeTermValues & { name: string; input: AnalysisInput })[] = []
  for (const term of cli.terms) resolved.push(await resolveTerm(localDir, term))

  log(
    `Index · ${typeof set.meta.title === 'string' ? set.meta.title : cli.set}\n` +
      `“${cli.name}” over ${resolved.length} county layers: ` +
      resolved
        .map(t => `${t.name} ×${t.weight} ${t.direction === 'lower_better' ? '↓' : '↑'}`)
        .join(', '),
  )

  const result = computeComposite(resolved)
  const names = Object.fromEntries(resolved.map(t => [t.layer, t.name]))
  const method = compositeMethod({ names, scales: result.scales, stats: result.stats })
  const computedAt = new Date().toISOString()

  const written: string[] = []
  if (cli.apply) {
    const analysis = {
      type: 'composite' as const,
      terms: canonicalTerms(cli.terms),
      scales: result.scales,
      columns: [columnId],
      counties: result.stats.counties,
      complete: result.stats.complete,
      partial: result.stats.partial,
      inputs: resolved.map(t => t.input),
      // Named, not a person: this is the batch tier, so the provenance §F.4c
      // asks for is the pass that ran rather than a user who pressed a button.
      by: 'npm run library -- index',
      at: computedAt,
    }

    const column: Record<string, unknown> = {
      id: columnId,
      label: cli.name,
      unit: 'index',
      method,
      computedAt,
      analysis,
      values: result.values,
    }

    // A column too big for a manifest goes in a file beside it, the same
    // threshold the server uses — so the two tiers write the same shape and
    // P7-2's one reader resolves both. A national index is 3,142 entries, so
    // inline is the normal case and the file path is the honest exception.
    const INLINE_MAX = 64 * 1024
    const inline = JSON.stringify(result.values)
    if (Buffer.byteLength(inline) > INLINE_MAX) {
      const file = `derived/${columnId}.json`
      const { mkdir } = await import('node:fs/promises')
      await mkdir(join(set.dir, 'derived'), { recursive: true })
      await writeFile(join(set.dir, file), inline, 'utf8')
      delete column.values
      column.file = file
      written.push(`library/working-sets/${cli.set}/${file}`)
    }

    // The manifest is re-serialised from the parsed object, so every field
    // this pass does not touch comes back byte-identical (retag's rule), and
    // replacement is by id IN PLACE so a re-run does not shuffle the column
    // order a table's headers are drawn in.
    const derived = Array.isArray(set.meta.derived) ? [...set.meta.derived] : []
    const at = derived.findIndex(item => item && typeof item === 'object' && (item as { id?: unknown }).id === columnId)
    if (at >= 0) derived[at] = column
    else derived.push(column)
    set.meta.derived = derived
    await writeFile(join(set.dir, 'meta.json'), `${JSON.stringify(set.meta, null, 2)}\n`, 'utf8')
    written.push(`library/working-sets/${cli.set}/meta.json`)
  }

  return {
    set: cli.set,
    columnId,
    label: cli.name,
    layerId: `${INTERNAL_LAYER_ID_PREFIX}${cli.set}~${columnId}`,
    terms: canonicalTerms(cli.terms),
    scales: result.scales,
    names,
    method,
    values: result.values,
    counties: result.stats.counties,
    complete: result.stats.complete,
    partial: result.stats.partial,
    written,
    elapsedMs: Date.now() - started,
  }
}

// --- The report --------------------------------------------------------------

/** The top and bottom counties — a 3,142-row index cannot be printed and its
 *  two ends can, which is the same choice the proximity report makes. */
const SAMPLE = 10

export function formatCompositeReport(report: CompositeCliReport): string {
  const pad = (v: string, w: number) => v.padEnd(w)
  const lines: string[] = ['']

  lines.push(`${pad('layer', 44)}${pad('weight', 8)}${pad('direction', 11)}${pad('from', 12)}${pad('to', 12)}counties`)
  lines.push('-'.repeat(99))
  for (const scale of report.scales) {
    lines.push(
      pad((report.names[scale.layer] || scale.layer).slice(0, 43), 44) +
        pad(String(scale.weight), 8) +
        pad(scale.direction === 'lower_better' ? 'lower' : 'higher', 11) +
        pad(String(Number(scale.min.toFixed(3))), 12) +
        pad(String(Number(scale.max.toFixed(3))), 12) +
        scale.counties.toLocaleString(),
    )
  }

  const ranked = Object.entries(report.values).sort((a, b) => b[1] - a[1])
  const shown = ranked.length <= SAMPLE * 2 ? ranked : [...ranked.slice(0, SAMPLE), ...ranked.slice(-SAMPLE)]
  lines.push('')
  lines.push(`${pad('county', 10)}index`)
  lines.push('-'.repeat(20))
  shown.forEach(([geoId, value], i) => {
    // One gap line where the middle was skipped, so nobody reads the two ends
    // as the whole index.
    if (i === SAMPLE && ranked.length > SAMPLE * 2) {
      lines.push(`… ${(ranked.length - SAMPLE * 2).toLocaleString()} more counties`)
    }
    lines.push(pad(geoId, 10) + value.toFixed(1))
  })

  lines.push('')
  const counts = [
    `${report.counties.toLocaleString()} ${report.counties === 1 ? 'county' : 'counties'}`,
    `${report.complete.toLocaleString()} with every layer`,
  ]
  // Only said when true — a run with nothing missing should not carry a "0
  // partial" clause for somebody to read past.
  if (report.partial) counts.push(`${report.partial.toLocaleString()} missing at least one`)
  lines.push(counts.join(' · '))
  lines.push(`Took ${(report.elapsedMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push(`Column: ${report.columnId} (index) · draws as ${report.layerId}`)
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
