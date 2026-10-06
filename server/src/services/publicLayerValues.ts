/**
 * County values for a PUBLIC map layer, read server-side (P7-8).
 *
 * The workbook's political efficacy layer is "class and race based
 * indicators", and in this codebase those indicators — `pct_Black`,
 * `poverty_by_race`, `median_income_by_race`, `homeownership_by_race` — are
 * **public registry layers**, not library datasets. So a composite index that
 * cannot take a registry layer as a term cannot build the thing the ticket
 * exists for. "Arbitrary layers rather than the registry" means the registry
 * stops being the boundary, not that it stops being a source.
 *
 * The registry's server-side mirror is `prompt/publicLayers.generated.json`
 * (written by `npm run export:layers`, CI-gated for staleness by
 * `src/lib/__tests__/publicLayers.spec.ts`), and `mcpTools.ts` already parses
 * these files for its `county_values` tool. This module reuses that tool's
 * exported, pure halves — `PUBLIC_LAYERS`, `parseLayerCsv`, `parseLayerJson`,
 * `normalizeGeoid`, `publicSiteUrl` — and adds the two things a composite
 * needs and a 200-county lookup did not:
 *
 * 1. **A fingerprint**, so a registry layer can be an analysis input under
 *    P7-6's rules. A public layer has no catalog row, so there are no `bytes`
 *    on an index to compare; the file itself has to supply them.
 * 2. **A size without a read**, so the byte ceiling can refuse before anything
 *    is parsed.
 *
 * The one piece genuinely duplicated from `mcpTools.ts` is its private
 * `loadLayerFile` — disk first, deployed site second. That file is being
 * edited by another ticket right now, so folding the two into this module is
 * left as the obvious follow-up rather than done here.
 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  PUBLIC_LAYERS,
  normalizeGeoid,
  parseLayerCsv,
  parseLayerJson,
  publicSiteUrl,
  type PublicLayerRecord,
} from './mcpTools.js'

/** Thrown for a layer this cannot read. The services turn it into a 400. */
export class PublicLayerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicLayerError'
  }
}

/**
 * Raw text held per `dataPath` for the life of the process.
 *
 * These files are static per deploy — they ship in the build — so this is a
 * correctness-neutral cache, and it is what keeps a derived column's freshness
 * check from re-reading six CSVs on every read of the column. Capped at the
 * term ceiling, so one index's worth.
 */
const MAX_CACHED_FILES = 12
const fileCache = new Map<string, { text: string; bytes: number; content: string }>()

/** For the suite, and for a local pass that has just rewritten a file. */
export function clearPublicLayerCache(): void {
  fileCache.clear()
}

/** The registry record, or null. Public layer ids are the registry's own. */
export function publicLayerRecord(layerId: string): PublicLayerRecord | null {
  return PUBLIC_LAYERS.find(l => l.id === layerId) ?? null
}

export function isPublicLayerId(layerId: string): boolean {
  return publicLayerRecord(layerId) !== null
}

function localPathFor(dataPath: string): string {
  return fileURLToPath(new URL(`../../../public/${dataPath.replace(/^\/+/, '')}`, import.meta.url))
}

/**
 * The file's text, size and fingerprint.
 *
 * Disk first — no network, and always current with the repo — then the
 * deployed site, which is how a container built from `server/` alone still
 * answers. Same order and same reasoning as `mcpTools.ts`'s own loader.
 */
async function loadFile(dataPath: string): Promise<{ text: string; bytes: number; content: string }> {
  const hit = fileCache.get(dataPath)
  if (hit) return hit
  const relative = dataPath.replace(/^\/+/, '')
  let text: string | null = null
  try {
    text = await readFile(localPathFor(dataPath), 'utf8')
  } catch {
    /* not in this deployment — try the site */
  }
  if (text === null) {
    const site = publicSiteUrl()
    if (!site) {
      throw new PublicLayerError(
        `The public layer file for ${relative} is not on this server and PUBLIC_SITE_URL is not set, ` +
          `so its numbers cannot be read.`,
      )
    }
    const res = await fetch(`${site}/${relative}`)
    if (!res.ok) throw new PublicLayerError(`The public layer file ${relative} could not be fetched (${res.status}).`)
    text = await res.text()
  }
  const record = {
    text,
    bytes: Buffer.byteLength(text),
    content: createHash('sha256').update(text).digest('hex').slice(0, 16),
  }
  if (fileCache.size >= MAX_CACHED_FILES) {
    const oldest = fileCache.keys().next().value
    if (oldest !== undefined) fileCache.delete(oldest)
  }
  fileCache.set(dataPath, record)
  return record
}

/**
 * How big the file is, WITHOUT reading it — null when that cannot be known
 * cheaply.
 *
 * This is what makes the composite's byte ceiling pre-flight: a `stat` on
 * disk, a cached size, or a `HEAD` against the site, in that order. Null is
 * "the budget cannot see this one", and the caller lets it through rather than
 * refusing work it has no evidence against — the same direction
 * `boundsForFeatureLayer` is wrong in.
 */
export async function publicLayerBytes(layerId: string): Promise<number | null> {
  const record = publicLayerRecord(layerId)
  if (!record) return null
  try {
    return (await stat(localPathFor(record.dataPath))).size
  } catch {
    /* not on disk */
  }
  const cached = fileCache.get(record.dataPath)
  if (cached) return cached.bytes
  const site = publicSiteUrl()
  if (!site) return null
  try {
    const res = await fetch(`${site}/${record.dataPath.replace(/^\/+/, '')}`, { method: 'HEAD' })
    const length = Number(res.headers.get('content-length'))
    return Number.isFinite(length) && length > 0 ? length : null
  } catch {
    return null
  }
}

/** The size and fingerprint of what a run actually read — P7-6's `bytes` and
 *  `content`, for a file the catalog knows nothing about. */
export async function publicLayerFingerprint(layerId: string): Promise<{ bytes: number; content: string } | null> {
  const record = publicLayerRecord(layerId)
  if (!record) return null
  try {
    const { bytes, content } = await loadFile(record.dataPath)
    return { bytes, content }
  } catch {
    // Unreadable reads back as `unknown`, never as fresh and never as stale.
    return null
  }
}

/**
 * The declaration fields an index reads off a public layer, as one string.
 *
 * The counterpart of `layerKeysOf` for the registry: which file, which column.
 * `range` and `direction` are deliberately NOT in here — the index normalises
 * against the data's own min and max and carries its own directions, so
 * neither can move a stored number.
 */
export function publicLayerKeys(layerId: string): string {
  const record = publicLayerRecord(layerId)
  if (!record) return ''
  return [record.dataPath, record.valueColumn].join('|')
}

export interface PublicCountyLayer {
  id: string
  name: string
  /** GEOID → number. Non-numeric cells are dropped, not coerced. */
  values: Record<string, number>
  count: number
  bytes: number
  content: string
}

/**
 * One public layer's county numbers, all of them.
 *
 * `county_values` reads at most 200 counties because a model asked about a
 * place; an index needs the whole column to normalise against, so this returns
 * the lot. Text cells are dropped rather than coerced: an ordinal layer whose
 * values are words has nothing for a weighted mean, and a county with no
 * number reads as missing, which the index already handles honestly.
 */
export async function readPublicCountyLayer(layerId: string): Promise<PublicCountyLayer> {
  const record = publicLayerRecord(layerId)
  if (!record) {
    throw new PublicLayerError(`“${layerId}” is not a public map layer.`)
  }
  const file = await loadFile(record.dataPath)
  const raw = record.dataPath.toLowerCase().endsWith('.json')
    ? parseLayerJson(file.text, record.valueColumn)
    : parseLayerCsv(file.text, record.valueColumn)
  const values: Record<string, number> = {}
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    const geoid = normalizeGeoid(key)
    if (geoid === null || typeof value !== 'number' || !Number.isFinite(value)) continue
    values[geoid] = value
    count += 1
  }
  return { id: record.id, name: record.name, values, count, bytes: file.bytes, content: file.content }
}
