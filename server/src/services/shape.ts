import { SHAPE_IDS, isShape } from './taxonomy.js'

/**
 * What KIND OF THING a dataset is (P6-2).
 *
 * The vocabulary is the taxonomy's (`shapes` in the generated table); this is
 * the derivation: how an entry that has never been asked the question answers
 * it from what it already carries.
 *
 * Read in this order, and stop at the first answer:
 *
 *  1. the manifest said so — `shape: areas` wins over everything;
 *  2. it is a map layer — a layer block's `geometry` already says `point`,
 *     `line` or `county`, which is exactly this question in the map's words;
 *  3. it is a source — `placeQuery.by` says what you can ask it FOR, which is
 *     the same thing as what its rows ARE (parcels, points, counties), and an
 *     access note naming polygons or boundaries says areas outright;
 *  4. it is a table we hold — its columns say: a GEOID/FIPS column means the
 *     rows are areas' statistics, lat/lng means sites, a GeoJSON of polygons
 *     means areas, and a table with none of those has no location at all.
 *
 * Pure, with the one file read injected, so the whole thing is testable
 * without a bucket and reusable by the push CLI over a local tree.
 */

export type ShapeId = 'areas' | 'points' | 'statistics' | 'lines' | 'records'

export const AREAS: ShapeId = 'areas'
export const POINTS: ShapeId = 'points'
export const STATISTICS: ShapeId = 'statistics'
export const LINES: ShapeId = 'lines'
export const RECORDS: ShapeId = 'records'

/** Public map layers are county values, every one of them (P6-2, spec B.9). */
export const PUBLIC_LAYER_SHAPE: ShapeId = STATISTICS

/** What a derivation is run over: one entry, as a manifest plus file names. */
export interface ShapeInput {
  kind: string
  meta: Record<string, unknown> | undefined | null
  /** Basenames inside the entry folder ("organizations.csv"), not bucket keys. */
  files?: string[]
  /** The entry's slug, for the one warning an unusable `shape:` earns. */
  slug?: string
}

/**
 * The two kinds the datasets browser holds: a table we have, and a dataset we
 * only index. A shape is a real question for these and a category error for a
 * page, a note or a saved view — and so, for the same reason, is "who
 * published it", which is why P6-1's admin queue asks this same question.
 */
const SHAPED_KINDS = new Set(['dataset', 'source'])

export function isShapedKind(kind: string): boolean {
  return SHAPED_KINDS.has(kind)
}

// --- 1. The manifest's own word -------------------------------------------

const warnedShape = new Set<string>()

/**
 * The `shape:` a manifest states, when it states one we know.
 *
 * A word outside the vocabulary is DROPPED rather than kept — unlike a
 * category, a shape is a closed four-value question, and an entry filed under
 * "geospatial" would simply be missing from all four groups. One warning per
 * entry, naming what was written, so it can be fixed in the manifest.
 */
export function statedShape(input: ShapeInput): ShapeId | null {
  const raw = input.meta?.shape
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = raw.trim().toLowerCase()
  if (isShape(value)) return value as ShapeId
  const key = input.slug ?? value
  if (!warnedShape.has(key)) {
    warnedShape.add(key)
    console.warn(`[library] "${key}" has shape "${raw}", which is not one of ${SHAPE_IDS.join(', ')} — ignored, deriving instead`)
  }
  return null
}

/** Tests only: forget which entries have already been warned about. */
export function resetShapeWarnings(): void {
  warnedShape.clear()
}

// --- 2. A map layer -------------------------------------------------------

/** `geometry` off a layer block, without importing the layer parser (which
 *  reads the catalog, which reads this). One string is all we need. */
function layerGeometry(meta: Record<string, unknown> | undefined | null): string {
  const layer = meta?.layer
  if (!layer || typeof layer !== 'object' || Array.isArray(layer)) return ''
  const geometry = (layer as { geometry?: unknown }).geometry
  // A county layer is the default in the layer parser too, so a block that
  // never says means county — the same rule, written once more rather than
  // imported through a cycle.
  return typeof geometry === 'string' ? geometry.trim().toLowerCase() : 'county'
}

// --- 3. A source ----------------------------------------------------------

/** A note or a format that says the rows are shapes, not dots. `geojson` on
 *  its own is a file format and says nothing — a GeoJSON of points is points. */
const POLYGON_WORDS = /\bpolygons?\b|\bboundar(?:y|ies)\b/i

function sourceBlock(meta: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  const raw = meta?.source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function placeQueryBy(source: Record<string, unknown>): string[] {
  const pq = source.placeQuery
  if (!pq || typeof pq !== 'object' || Array.isArray(pq)) return []
  const by = (pq as { by?: unknown }).by
  return Array.isArray(by) ? by.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()) : []
}

/** True when any access method's declared format or notes name polygons or
 *  boundaries — "soil polygons", "boundary polygons", "point-in-polygon". */
export function accessNamesAreas(source: Record<string, unknown>): boolean {
  const access = source.access
  if (!Array.isArray(access)) return false
  return access.some(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const a = entry as { format?: unknown; notes?: unknown }
    const words = [typeof a.format === 'string' ? a.format : '', typeof a.notes === 'string' ? a.notes : ''].join(' ')
    return POLYGON_WORDS.test(words)
  })
}

/** Area codes: a row keyed by one of these is a statistic about an area. */
const AREA_CODES = new Set(['county', 'tract', 'blockgroup', 'state', 'national'])

function shapeOfSource(source: Record<string, unknown>): ShapeId {
  // `placeQuery.by` is what the block was written to say: the places this
  // source can be asked about, which is the same thing as what its rows are.
  const by = placeQueryBy(source)
  if (by.includes('parcel') || accessNamesAreas(source)) return AREAS
  if (by.includes('point')) return POINTS
  if (by.some(b => AREA_CODES.has(b))) return STATISTICS
  // A block with no place query at all — one read by hand, or one somebody
  // registered before filling that in — still declares its `geography`, which
  // is the same question in one word. Only consulted when `by` says nothing,
  // so it can never argue with a block that does.
  const geography = typeof source.geography === 'string' ? source.geography.trim().toLowerCase() : ''
  if (geography === 'parcel') return AREAS
  if (geography === 'point') return POINTS
  if (AREA_CODES.has(geography)) return STATISTICS
  return RECORDS
}

// --- 4. A table we hold ---------------------------------------------------

const TABULAR_EXTENSIONS = new Set(['csv', 'tsv', 'json', 'geojson'])

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The file the explorer would open: the first browsable table in the entry.
 *  Same rule as `pickTabularFile`, written here so this module stays free of
 *  the bucket and the catalog. */
export function pickShapeFile(files: readonly string[] | undefined): string | null {
  return (files ?? []).find(name => name !== 'meta.json' && TABULAR_EXTENSIONS.has(extensionOf(name))) ?? null
}

/** A column naming an area code, so the rows are statistics BY an area. */
const GEO_CODE_COLUMN = /geoid|fips/i
const LAT_COLUMN = /^_?(?:lat|latitude)$/i
const LNG_COLUMN = /^_?(?:lng|lon|long|longitude)$/i

export interface ShapeSignals {
  columns: string[]
  /** The file is a GeoJSON whose features carry Polygon or MultiPolygon. */
  polygons: boolean
}

/**
 * The columns a file holds, and whether it draws polygons — read from the
 * header line of a delimited file, or the first features of a GeoJSON.
 *
 * Deliberately shallow: nothing here parses every row, because the question is
 * about the SCHEMA and a 25 MB table would answer it identically from its
 * first line.
 */
export function readShapeSignals(fileName: string, text: string): ShapeSignals {
  const ext = extensionOf(fileName)
  if (ext === 'json' || ext === 'geojson') return jsonSignals(text)
  const firstLine = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? ''
  const delimiter = ext === 'tsv' ? '\t' : ','
  const columns = firstLine
    .split(delimiter)
    .map(cell => cell.trim().replace(/^"(.*)"$/s, '$1').trim())
    .filter(Boolean)
  return { columns, polygons: false }
}

function jsonSignals(text: string): ShapeSignals {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A file too broken to parse still says whether it draws polygons.
    return { columns: [], polygons: /"(?:Multi)?Polygon"/.test(text) }
  }
  if (Array.isArray(parsed)) {
    const first = parsed.find(row => !!row && typeof row === 'object' && !Array.isArray(row))
    return { columns: first ? Object.keys(first as object) : [], polygons: false }
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { features?: unknown }).features)) {
    const features = (parsed as { features: unknown[] }).features
    const columns = new Set<string>()
    let polygons = false
    let points = false
    for (const feature of features) {
      if (!feature || typeof feature !== 'object' || Array.isArray(feature)) continue
      const f = feature as { properties?: unknown; geometry?: unknown }
      if (f.properties && typeof f.properties === 'object' && !Array.isArray(f.properties)) {
        for (const key of Object.keys(f.properties as object)) columns.add(key)
      }
      const type = f.geometry && typeof f.geometry === 'object' ? (f.geometry as { type?: unknown }).type : undefined
      if (type === 'Polygon' || type === 'MultiPolygon') polygons = true
      if (type === 'Point') points = true
    }
    // The table explorer lifts a point feature's coordinates into `_lng`/`_lat`
    // columns, so a reader of these columns sees what the explorer would.
    if (points) {
      columns.add('_lng')
      columns.add('_lat')
    }
    return { columns: [...columns], polygons }
  }
  return { columns: [], polygons: false }
}

/** The table rules, in the order the spec states them. */
export function shapeFromSignals(signals: ShapeSignals): ShapeId {
  const columns = signals.columns
  if (columns.some(c => GEO_CODE_COLUMN.test(c))) return STATISTICS
  if (columns.some(c => LAT_COLUMN.test(c)) && columns.some(c => LNG_COLUMN.test(c))) return POINTS
  if (signals.polygons) return AREAS
  return RECORDS
}

// --- The derivation -------------------------------------------------------

/**
 * Everything that can be answered from the manifest alone: the stated shape,
 * a layer block, a source block. Null when only the entry's own table can say.
 *
 * Used where reading a file is not on the table — an upload indexed the moment
 * it lands, a note created from a form — so those rows carry what is knowable
 * now and the next reindex fills in the rest.
 */
export function shapeFromManifest(input: ShapeInput): ShapeId | null {
  const stated = statedShape(input)
  if (stated) return stated
  const geometry = layerGeometry(input.meta)
  if (geometry === 'point') return POINTS
  if (geometry === 'county') return STATISTICS
  // P9-8: a declared line geometry has already answered this question. It used
  // to fall past every branch to the file sniffer, which saw a GeoJSON with no
  // lat/lng columns and said `records` — so `transmission-345kv`, 3,477
  // LineStrings the map draws, was chipped "Records without a location".
  if (geometry === 'line') return LINES
  // P7-9: a state layer draws a boundary, which is what `areas` means.
  // `statistics` is for values keyed by an area code, and a state layer's
  // content is prose — the permitting rules, not a number per state.
  if (geometry === 'state') return AREAS
  const source = sourceBlock(input.meta)
  if (source) return shapeOfSource(source)
  return null
}

/** Read one of the entry's files as text. Returns null when it cannot be read
 *  (too big, gone, not ours) — the derivation falls back rather than throwing. */
export type ShapeFileReader = (fileName: string) => Promise<string | null>

/**
 * What shape this entry is, reading its table when the manifest cannot say.
 *
 * Never throws: a file that will not download or will not parse leaves the
 * entry as `records`, which is the honest answer for a table nothing could be
 * read out of.
 */
export async function deriveShape(input: ShapeInput, readFile?: ShapeFileReader): Promise<ShapeId> {
  const fromManifest = shapeFromManifest(input)
  if (fromManifest) return fromManifest
  const file = pickShapeFile(input.files)
  if (!file || !readFile) return RECORDS
  let text: string | null = null
  try {
    text = await readFile(file)
  } catch (err: any) {
    console.warn(`[library] could not read "${file}" to work out what shape "${input.slug ?? ''}" is: ${err?.message || err}`)
  }
  if (text === null) return RECORDS
  return shapeFromSignals(readShapeSignals(file, text))
}
