import { libraryQuery } from './libraryDb.js'
import { datesFromManifest, normalizeDataDate, type DataDates } from './dataDates.js'
import { getCatalogEntry } from './libraryCatalog.js'
import { getFile } from './libraryBucket.js'
import { organizationForMeta, organizationLabel } from './organizations.js'
import { readDataset, toNumber, TabularError, type ParsedDataset } from './libraryTabular.js'
import { stateCodeForFips, stateFipsFor, stateNameForCode } from './taxonomy.js'
import { WORKING_SET_KIND, readWorkingSet } from './workingSetMeta.js'
import { derivedColumnKey, readDerivedColumns, readDerivedValues } from './workingSetColumns.js'

/**
 * Internal map layers (P5-18): a `published` library dataset whose
 * meta.json carries a `layer` block becomes a county choropleth for
 * logged-in users. The block is the layer's definition (the same fields the
 * client registry needs); the file is parsed by the shared tabular service
 * and projected to `{ GEOID → number }`. Nothing here is reachable without
 * an internal session, and nothing about a layer ships in the client bundle.
 *
 * Geometries: `county` (choropleth values, P5-18), `point` (clustered
 * markers with a strict property allowlist, P5-24), `line` (paths drawn
 * from a geometry column, same allowlist, P7-3) and `state` (one row per
 * state, drawn on the state outline, with a popup that is the point of it —
 * P7-9).
 *
 * A state layer is the one geometry whose shapes this server never sees. A
 * county layer sends values and the client joins them to the county polygons
 * it already holds; a state layer sends ROWS the same way, and the client
 * joins them to state outlines it dissolves from those same counties. So the
 * payload here is unlocated features — `geometry: null`, which GeoJSON allows
 * — and the four numbers of a bbox are the client's to compute.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Values cap per layer — county layers have ~3,200 rows; this is a sanity ceiling. */
export const LAYER_MAX_VALUES = envInt('LAYER_MAX_VALUES', 10_000)
/** Feature cap per point or line layer (P5-24, P7-3). */
export const LAYER_MAX_FEATURES = envInt('LAYER_MAX_FEATURES', 20_000)
/** Vertex cap per line layer (P7-3). A few hundred transmission lines is a
 *  few hundred features and can be millions of coordinates, so the feature
 *  cap cannot see the payload a line layer would actually ship. */
export const LAYER_MAX_VERTICES = envInt('LAYER_MAX_VERTICES', 500_000)
/**
 * Character cap on everything a state layer's popups carry (P7-9), for the
 * same reason `LAYER_MAX_VERTICES` exists: the feature cap cannot see the
 * payload. A state layer is at most 56 rows, so `LAYER_MAX_FEATURES` can
 * never refuse one — and its whole content is prose, which is exactly the
 * axis that can run to megabytes. 400,000 characters is a 7,000-word essay
 * per state.
 */
export const LAYER_MAX_POPUP_CHARS = envInt('LAYER_MAX_POPUP_CHARS', 400_000)
export const INTERNAL_LAYER_ID_PREFIX = 'internal-'

export const LAYER_DATA_TYPES = ['percentage', 'currency', 'count', 'index', 'years', 'ordinal'] as const
export type LayerDataType = (typeof LAYER_DATA_TYPES)[number]
export type LayerDirection = 'higher_better' | 'lower_better'

export interface LayerBlockCommon {
  /** Basename of the file inside the entry; defaults to the first tabular file. */
  file?: string
  name: string
  description: string
  source: string
  year: number | string
}

export interface CountyLayerBlock extends LayerBlockCommon {
  geometry: 'county'
  geoKey: string
  valueKey: string
  dataType: LayerDataType
  unit: string
  direction: LayerDirection
  range: { min: number; max: number } | null
}

export interface PointLayerBlock extends LayerBlockCommon {
  geometry: 'point'
  latKey: string
  lngKey: string
  labelKey: string
  /** Row columns carried in the LAYER payload, besides the label. This
   *  bounds what the map draws, not what the viewer may see: the same
   *  internal user can read every column via /api/library/data/:slug/rows
   *  or download the file. The auth guard is the confidentiality boundary. */
  popupFields: string[]
  color: string | null
}

/**
 * A line layer (P7-3). Deliberately the point block with its coordinate pair
 * replaced by one path column: same label, same popup allowlist, same colour,
 * plus a stroke width because a line has one and a circle does not.
 *
 * `pathKey` names the column holding the path — `_path` for a GeoJSON file
 * (what `parseJson` writes), or whatever column a CSV carries WKT in. Named
 * explicitly, like `latKey`/`lngKey`, so the manifest says what it reads.
 */
export interface LineLayerBlock extends LayerBlockCommon {
  geometry: 'line'
  pathKey: string
  labelKey: string
  /** Same bound as the point block's: what the map draws, not what the
   *  viewer may see. The auth guard is the confidentiality boundary. */
  popupFields: string[]
  color: string | null
  /** Stroke width in px, 0.5–10. Null takes the client default. */
  width: number | null
}

/**
 * A state layer (P7-9). The criterion it exists for — spec §B, *"Permit +
 * Laws state by state — pop-up about the specific state requirements +
 * permitting processes"* — is about READING, so the popup is the feature and
 * the block is shaped around it.
 *
 * `stateKey` names the column holding the state, in any of the three
 * spellings P6-19 consolidated (`GA`, `Georgia`, `13`). Named explicitly,
 * like `pathKey` and `latKey`/`lngKey`, so the manifest says what it reads.
 *
 * `labelKey` is the one field a state layer may omit, and the only optional
 * geometry field in this file: the title of a state's popup is the state's
 * name, which the canonical table already knows. Requiring the column would
 * be requiring a dataset to restate `Georgia` in a row keyed `GA`.
 *
 * `detailFields` is what makes the popup worth opening. `popupFields` are
 * short facts in a two-column list — the permitting authority, a statute
 * number, a day count. `detailFields` are paragraphs, rendered as prose under
 * them, which is what a permitting process actually is. One list would have
 * had to guess which a column was from its length.
 */
export interface StateLayerBlock extends LayerBlockCommon {
  geometry: 'state'
  stateKey: string
  /** Null takes the state's own name from the canonical table. */
  labelKey: string | null
  /** Same bound as the point and line blocks': what the map draws, not what
   *  the viewer may see. The auth guard is the confidentiality boundary. */
  popupFields: string[]
  /** Columns rendered as prose rather than as a list row. */
  detailFields: string[]
  color: string | null
}

export type LayerBlock = CountyLayerBlock | PointLayerBlock | LineLayerBlock | StateLayerBlock

export const LAYER_GEOMETRIES = ['county', 'point', 'line', 'state'] as const
export type LayerGeometry = (typeof LAYER_GEOMETRIES)[number]

/** `[minLng, minLat, maxLng, maxLat]` — the order mapbox-gl's `fitBounds`
 *  reads, and the order `?fit=bbox:` writes (P5-74). */
export type LayerBounds = [number, number, number, number]

export interface InternalLayerManifestEntry {
  id: string
  slug: string
  geometry: LayerGeometry
  name: string
  dataType: LayerDataType
  unit: string
  direction: LayerDirection
  range: { min: number; max: number } | null
  description: string
  source: string
  /** P6-1: who published the dataset behind this layer, from its manifest —
   *  the id, and the plain words to head a group with. Empty when the
   *  manifest names no publisher. The datasets browser (P6-3) groups the
   *  layers in with everything else by this. */
  organization: string
  organizationLabel: string
  year: number | string
  /**
   * P7-10: WHEN this layer's data is from — the period it covers, when the
   * publisher put it out, and when we pulled it. The LEGEND reads this: a
   * choropleth that gives no indication of its vintage is a correctness
   * problem for a dashboard that argues from a map, and two layers drawn
   * together can be a decade apart with nothing to say so.
   *
   * Folded off the entry's own manifest, not off the layer block, because the
   * dates belong to the DATASET and the layer is a view of it. `year` above is
   * the author's declared vintage and stays what it was — it is the fallback
   * the client reads when a layer carries no block at all, which is every
   * public registry layer.
   */
  dates: DataDates
  file: string | null
  /** Point, line and state layers: swatch color + the popup field names
   *  (names only, no data). */
  color: string | null
  popupFields: string[]
  /** State layers (P7-9): the columns whose values are prose. Names only. */
  detailFields: string[]
  /** Line layers (P7-3): stroke width in px, null for the client default. */
  width: number | null
  /** Point and line layers (P5-77, P7-3): the extent of the layer's own
   *  features, so "Show on map" opens on them instead of on the national
   *  view. Null for a county layer, and for a feature layer whose rows carry
   *  no drawable geometry.
   *
   *  Null for a state layer too, and not for want of trying: the outlines are
   *  the client's, dissolved from the county polygons, so this server has
   *  nothing to measure. A state layer is also the one geometry for which the
   *  national view is right — "permit + laws state by state" covers the
   *  country — so the frame it would carry is the frame it already opens on. */
  bbox: LayerBounds | null
  updatedAt: string | null
}

// --- Derived layers: a composite index IS a layer (P7-8) ---------------------

/**
 * The one character that separates a working set from one of its columns in a
 * layer slug.
 *
 * `~` because it is URL-unreserved (so `encodeURIComponent` leaves it alone
 * and nothing in the client's generic loader needs to learn a new rule) and
 * because `SLUG_RE` forbids it in a dataset slug, so `<set>~<column>` can
 * never collide with a dataset's own layer id.
 */
export const DERIVED_LAYER_SEPARATOR = '~'

export function derivedLayerSlug(set: string, column: string): string {
  return `${set}${DERIVED_LAYER_SEPARATOR}${column}`
}

export function isDerivedLayerSlug(slug: string): boolean {
  return slug.includes(DERIVED_LAYER_SEPARATOR)
}

/** `<set>~<column>` → its two halves, or null. Split on the FIRST separator:
 *  a set slug cannot contain one, a column id cannot either, and splitting
 *  from the left means a hand-typed extra one fails to resolve rather than
 *  resolving to something else. */
export function splitDerivedLayerSlug(slug: string): { set: string; column: string } | null {
  const at = slug.indexOf(DERIVED_LAYER_SEPARATOR)
  if (at <= 0) return null
  const set = slug.slice(0, at)
  const column = slug.slice(at + 1)
  if (!set || !column || column.includes(DERIVED_LAYER_SEPARATOR)) return null
  return { set, column }
}

/**
 * The derived columns that are layers, and why not all of them are.
 *
 * P7-8's acceptance criterion is that a composite index *"produces a layer
 * that draws and can be cited"*, and the cheapest honest way to do that is to
 * stop treating it as a special case: a composite is a county layer, so it
 * goes in the manifest beside every other county layer and the client draws it
 * with **no client change at all**. That matters more than it sounds — the
 * Lens is on the public map, so the safest way to generalise it is to add
 * nothing to the bundle that draws it.
 *
 * A **proximity** column is deliberately NOT listed, and the reason is not
 * laziness. A layer needs a `direction` — which end of the scale is good — and
 * nothing in a proximity record says whether being close to a transmission
 * line is an asset or a hazard; it depends entirely on the story. P6-19's rule
 * applies: inventing a direction is worse than declining to name one. A
 * composite has no such problem, because every term's direction is already in
 * the formula and has already been applied, so more of the index is by
 * construction more of what the index measures.
 */
function derivedLayersOf(
  slug: string,
  meta: Record<string, unknown>,
  updatedAt: string | null,
): InternalLayerManifestEntry[] {
  const set = readWorkingSet(meta, slug)
  const out: InternalLayerManifestEntry[] = []
  for (const column of readDerivedColumns(set.derived)) {
    if (column.analysis?.type !== 'composite') continue
    const id = derivedLayerSlug(slug, column.id)
    out.push({
      id: `${INTERNAL_LAYER_ID_PREFIX}${id}`,
      slug: id,
      geometry: 'county',
      name: column.label ?? column.id,
      // A 0-100 index prints as a bare number to one decimal, which is what
      // `index` means to the client's formatter.
      dataType: 'index',
      unit: '',
      direction: 'higher_better',
      // Declared, and exactly right rather than merely plausible: the index
      // is a weighted mean of values normalised onto 0-1, times 100.
      range: { min: 0, max: 100 },
      description: column.method ?? '',
      source: `Derived from ${set.title}`,
      organization: '',
      organizationLabel: '',
      year: (column.computedAt ?? '').slice(0, 4) || '',
      // P7-10: a composite was PUBLISHED by us on the day it was computed,
      // and what it COVERS is its inputs' business — deliberately left empty
      // rather than filled with the compute date, which would have a derived
      // index claiming to describe the year somebody pressed the button.
      dates: normalizeDataDate(column.computedAt) ? { published: normalizeDataDate(column.computedAt) } : {},
      file: null,
      color: null,
      popupFields: [],
      detailFields: [],
      width: null,
      bbox: null,
      updatedAt,
    })
  }
  return out
}

/**
 * A derived column's stored values, as a county layer payload.
 *
 * **Computes nothing**, which is P7-6's rule for every reader of a derived
 * number: the values were written when the analysis ran and this hands them
 * back, inline from the manifest or from the file beside it — the two storage
 * shapes P7-1 made the set a directory for. The range is the index's declared
 * 0-100 rather than the observed spread, so two sets' indices are drawn on the
 * same scale and a choropleth can be compared across them.
 */
async function derivedLayerValues(slug: string): Promise<InternalLayerValues> {
  const split = splitDerivedLayerSlug(slug)
  if (!split) throw new TabularError(404, 'not found')
  const entry = await getCatalogEntry(split.set)
  if (!entry || entry.kind !== WORKING_SET_KIND) throw new TabularError(404, 'not found')
  const set = readWorkingSet(isPlainObject(entry.meta) ? entry.meta : {}, split.set)
  const column = readDerivedColumns(set.derived).find(c => c.id === split.column)
  // A column that is not a composite is not a layer — same door, same answer
  // as an unknown slug, because the manifest is the only discovery surface.
  if (!column || column.analysis?.type !== 'composite') throw new TabularError(404, 'not found')
  let values: Record<string, number> = {}
  if (column.file) {
    const key = derivedColumnKey(split.set, column.file)
    if (!key) throw new TabularError(404, 'not found')
    try {
      values = readDerivedValues(JSON.parse((await getFile(key)).toString('utf8')))
    } catch {
      // Reported as an empty layer rather than a 500: the manifest says this
      // layer exists, and "this column has no values we can read" is a thing
      // to go and fix (P6-23).
      values = {}
    }
  } else {
    values = readDerivedValues(column.values)
  }
  return {
    id: `${INTERNAL_LAYER_ID_PREFIX}${slug}`,
    slug,
    geometry: 'county',
    values,
    count: Object.keys(values).length,
    range: { min: 0, max: 100 },
  }
}

export type PointFeature = {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: Record<string, string>
}

/** One path, as the parts a MultiLineString has and a LineString has one of. */
export type LinePath = [number, number][][]

export type LineFeature = {
  type: 'Feature'
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'MultiLineString'; coordinates: [number, number][][] }
  properties: Record<string, string>
}

export interface InternalLayerPoints {
  id: string
  slug: string
  geometry: 'point'
  type: 'FeatureCollection'
  features: PointFeature[]
  count: number
  skipped: number
  bbox: LayerBounds | null
}

export interface InternalLayerLines {
  id: string
  slug: string
  geometry: 'line'
  type: 'FeatureCollection'
  features: LineFeature[]
  count: number
  skipped: number
  bbox: LayerBounds | null
}

/**
 * One state's row (P7-9), as an **unlocated** GeoJSON feature — `geometry:
 * null`, which the format allows for exactly this: a feature whose position
 * is not in the file. The client locates it against the state outlines it
 * dissolves from the county polygons it already holds.
 *
 * `_state` is the 2-digit FIPS, because that is what the county GEOIDs the
 * outlines come from are keyed by. `_label` is the state's name unless the
 * block named a column.
 */
export type StateFeature = {
  type: 'Feature'
  geometry: null
  properties: Record<string, string>
}

export interface InternalLayerStates {
  id: string
  slug: string
  geometry: 'state'
  type: 'FeatureCollection'
  features: StateFeature[]
  count: number
  skipped: number
  /** Always null — see `InternalLayerManifestEntry.bbox`. */
  bbox: null
}

export interface InternalLayerValues {
  id: string
  slug: string
  geometry: 'county'
  values: Record<string, number>
  count: number
  range: { min: number; max: number } | null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/** The three fields every drawn-feature layer carries — the popup title
 *  column, the popup allowlist and the swatch colour. Shared by `point`,
 *  `line` and `state` so the three blocks cannot drift apart.
 *
 *  `labelRequired` is false for exactly one geometry: a state already has a
 *  name, so `labelKey` there is an override rather than a requirement. */
type FeatureFields<Label> = { labelKey: Label; popupFields: string[]; color: string | null }
function parseFeatureFields(raw: Record<string, unknown>): FeatureFields<string> | { error: string }
function parseFeatureFields(raw: Record<string, unknown>, opts: { labelRequired: false }): FeatureFields<string | null> | { error: string }
function parseFeatureFields(
  raw: Record<string, unknown>,
  { labelRequired = true }: { labelRequired?: boolean } = {},
): FeatureFields<string | null> | { error: string } {
  if (!nonEmptyString(raw.labelKey) && (labelRequired || raw.labelKey !== undefined)) {
    return { error: 'layer.labelKey is required (the column shown as the feature title)' }
  }
  const popupFields = raw.popupFields ?? []
  if (!Array.isArray(popupFields) || !popupFields.every(f => typeof f === 'string' && f.trim())) {
    return { error: 'layer.popupFields must be an array of column names' }
  }
  if (raw.color !== undefined && raw.color !== null && !(typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color))) {
    return { error: 'layer.color must be a #rrggbb hex color' }
  }
  return {
    labelKey: nonEmptyString(raw.labelKey) ? raw.labelKey.trim() : null,
    popupFields: [...new Set((popupFields as string[]).map(f => f.trim()))],
    color: typeof raw.color === 'string' ? raw.color.toLowerCase() : null,
  }
}

/** Validate meta.json's `layer` block. Every rejection names the field so a
 *  dev pushing a manifest can fix it from the server log alone. */
export function parseLayerBlock(meta: Record<string, unknown>): { block: LayerBlock } | { error: string } {
  const raw = meta.layer
  if (raw === undefined || raw === null) return { error: 'no layer block' }
  if (!isPlainObject(raw)) return { error: 'layer block must be an object' }

  const geometry = raw.geometry ?? 'county'
  if (!(LAYER_GEOMETRIES as readonly unknown[]).includes(geometry)) {
    return { error: `layer.geometry "${String(geometry)}" is not supported (${LAYER_GEOMETRIES.join(', ')})` }
  }
  if (raw.file !== undefined && !nonEmptyString(raw.file)) return { error: 'layer.file must be a file name' }
  if (!nonEmptyString(raw.name)) return { error: 'layer.name is required' }
  const common: LayerBlockCommon = {
    file: typeof raw.file === 'string' ? raw.file : undefined,
    name: raw.name.trim(),
    description: typeof raw.description === 'string' ? raw.description : '',
    source: typeof raw.source === 'string' ? raw.source : '',
    year: typeof raw.year === 'number' || typeof raw.year === 'string' ? raw.year : '',
  }

  // Everything a drawn-feature layer shares, whatever its geometry: the title
  // column, the popup allowlist and the swatch. One place, so a point and a
  // line cannot drift into two spellings of the same three fields.
  // The geometry's own columns are named first, so a block re-labelled from
  // one geometry to another is told what that geometry needs rather than
  // being sent off after a field both of them share.
  if (geometry === 'line') {
    if (!nonEmptyString(raw.pathKey)) {
      return { error: 'layer.pathKey is required (the column holding the path — "_path" for a GeoJSON file)' }
    }
    let width: number | null = null
    if (raw.width !== undefined && raw.width !== null) {
      if (typeof raw.width !== 'number' || !Number.isFinite(raw.width) || raw.width < 0.5 || raw.width > 10) {
        return { error: 'layer.width must be a number between 0.5 and 10 (px)' }
      }
      width = raw.width
    }
    const shared = parseFeatureFields(raw)
    if ('error' in shared) return shared
    return { block: { ...common, geometry: 'line', pathKey: raw.pathKey.trim(), ...shared, width } }
  }

  if (geometry === 'state') {
    if (!nonEmptyString(raw.stateKey)) {
      return { error: 'layer.stateKey is required (the column holding the state — a postal code, a name, or a 2-digit FIPS)' }
    }
    const shared = parseFeatureFields(raw, { labelRequired: false })
    if ('error' in shared) return shared
    const detail = raw.detailFields ?? []
    if (!Array.isArray(detail) || !detail.every(f => typeof f === 'string' && f.trim())) {
      return { error: 'layer.detailFields must be an array of column names' }
    }
    // A column in both lists would render twice — once as a list row and
    // once as prose. `popupFields` wins, because it is the one both the point
    // and line blocks also have.
    const popup = new Set(shared.popupFields)
    const detailFields = [...new Set((detail as string[]).map(f => f.trim()))].filter(f => !popup.has(f))
    return { block: { ...common, geometry: 'state', stateKey: raw.stateKey.trim(), ...shared, detailFields } }
  }

  if (geometry === 'point') {
    if (!nonEmptyString(raw.latKey)) return { error: 'layer.latKey is required (the latitude column)' }
    if (!nonEmptyString(raw.lngKey)) return { error: 'layer.lngKey is required (the longitude column)' }
    const shared = parseFeatureFields(raw)
    if ('error' in shared) return shared
    return { block: { ...common, geometry: 'point', latKey: raw.latKey.trim(), lngKey: raw.lngKey.trim(), ...shared } }
  }

  if (!nonEmptyString(raw.geoKey)) return { error: 'layer.geoKey is required (the GEOID column)' }
  if (!nonEmptyString(raw.valueKey)) return { error: 'layer.valueKey is required (the numeric column to map)' }

  const dataType = raw.dataType ?? 'index'
  if (!(LAYER_DATA_TYPES as readonly unknown[]).includes(dataType)) {
    return { error: `layer.dataType must be one of ${LAYER_DATA_TYPES.join(', ')}` }
  }
  const direction = raw.direction ?? 'higher_better'
  if (direction !== 'higher_better' && direction !== 'lower_better') {
    return { error: 'layer.direction must be higher_better or lower_better' }
  }

  let range: CountyLayerBlock['range'] = null
  if (raw.range !== undefined && raw.range !== null) {
    if (!isPlainObject(raw.range)) return { error: 'layer.range must be { min, max }' }
    const { min, max } = raw.range
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
      return { error: 'layer.range must be { min, max } numbers with min < max' }
    }
    range = { min, max }
  }

  return {
    block: {
      ...common,
      geometry: 'county',
      geoKey: raw.geoKey.trim(),
      valueKey: raw.valueKey.trim(),
      dataType: dataType as LayerDataType,
      unit: typeof raw.unit === 'string' ? raw.unit : '',
      direction,
      range,
    },
  }
}

/**
 * 5-digit county FIPS from the common spellings: 1001 → 01001,
 * 0500000US01001 → 01001, 47157.0 → 47157.
 *
 * P7-5: the trailing `.0` was the one spelling this did not forgive while
 * `derivedKeyAsGeoId` and the client's `normalizeGeoId` both did — so a GEOID
 * column a spreadsheet had written as a float read as no county at all, and a
 * county layer over it drew nothing. A fraction that is not zeros is a real
 * fraction and still not an id.
 */
export function normalizeGeoId(cell: string): string | null {
  const t = cell.trim().replace(/\.0+$/, '')
  const affgeoid = /US(\d{5})$/.exec(t)
  if (affgeoid) return affgeoid[1]
  if (/^\d{1,5}$/.test(t)) return t.padStart(5, '0')
  return null
}

/** Project a parsed table to `{ GEOID → number }` for the choropleth. */
export function projectCountyValues(
  ds: ParsedDataset,
  block: CountyLayerBlock,
): { values: Record<string, number>; count: number; skipped: number; range: { min: number; max: number } | null } {
  const names = new Set(ds.columns.map(c => c.name))
  for (const key of [block.geoKey, block.valueKey]) {
    if (!names.has(key)) throw new TabularError(415, `layer column "${key}" is not in the file (columns: ${[...names].join(', ')})`)
  }
  const values: Record<string, number> = {}
  let skipped = 0
  let min = Infinity
  let max = -Infinity
  for (const row of ds.rows) {
    const geoId = normalizeGeoId(row[block.geoKey] ?? '')
    const value = toNumber(row[block.valueKey] ?? '')
    if (geoId === null || value === null) {
      skipped++
      continue
    }
    values[geoId] = value
  }
  const count = Object.keys(values).length
  if (count > LAYER_MAX_VALUES) {
    throw new TabularError(413, `layer has ${count.toLocaleString()} values — over the ${LAYER_MAX_VALUES.toLocaleString()} cap for a county layer`)
  }
  for (const v of Object.values(values)) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const computed = count > 0 && min < max ? { min, max } : count > 0 ? { min, max: min + 1 } : null
  return { values, count, skipped, range: block.range ?? computed }
}

/** Project a parsed table to a GeoJSON FeatureCollection. Properties are the
 *  label + popupFields: a payload limit (a 50-column table would bloat every
 *  feature), not a redaction — the internal rows and download routes serve
 *  the full file to the same user. */
export function projectPointFeatures(ds: ParsedDataset, block: PointLayerBlock): Omit<InternalLayerPoints, 'id' | 'slug' | 'geometry'> {
  const names = new Set(ds.columns.map(c => c.name))
  for (const key of [block.latKey, block.lngKey, block.labelKey, ...block.popupFields]) {
    if (!names.has(key)) throw new TabularError(415, `layer column "${key}" is not in the file (columns: ${[...names].join(', ')})`)
  }
  const features: PointFeature[] = []
  let skipped = 0
  for (const row of ds.rows) {
    const coordinates = toCoordinate(row, block)
    if (coordinates === null) {
      skipped++
      continue
    }
    const properties: Record<string, string> = { _label: (row[block.labelKey] ?? '').trim() }
    for (const f of block.popupFields) properties[f] = row[f] ?? ''
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties })
    if (features.length > LAYER_MAX_FEATURES) {
      throw new TabularError(413, `layer has more than ${LAYER_MAX_FEATURES.toLocaleString()} points — over the cap for a point layer`)
    }
  }
  return {
    type: 'FeatureCollection',
    features,
    count: features.length,
    skipped,
    bbox: boundsOf(features.map(f => f.geometry.coordinates)),
  }
}

/** The `[lng, lat]` a row maps to, or null when it has none the map can draw —
 *  the one place a row becomes a point, for the payload and for the frame. */
function toCoordinate(row: Record<string, string>, block: PointLayerBlock): [number, number] | null {
  const lat = toNumber(row[block.latKey] ?? '')
  const lng = toNumber(row[block.lngKey] ?? '')
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return [lng, lat]
}

// --- lines (P7-3) -------------------------------------------------------------

const WKT_LINE_RE = /^\s*(MULTI)?LINESTRING\s*(?:Z|M|ZM)?\s*\((.*)\)\s*$/is

/** One `[lng, lat]` that is actually on the earth, or null. */
function toVertex(lng: unknown, lat: unknown): [number, number] | null {
  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return [lng, lat]
}

/** A part is drawable once two of its vertices survive. */
function toPart(coords: unknown): [number, number][] | null {
  if (!Array.isArray(coords)) return null
  const part: [number, number][] = []
  for (const vertex of coords) {
    if (!Array.isArray(vertex)) continue
    const v = toVertex(vertex[0], vertex[1])
    if (v) part.push(v)
  }
  return part.length >= 2 ? part : null
}

/**
 * The path a cell holds, as an array of parts — the one place a cell becomes
 * a line, for the payload and for the frame. Two spellings, because a path
 * reaches the library in two:
 *
 *   - compact JSON, which `parseJson` writes into `_path` from a GeoJSON file
 *     (`[[lng,lat],…]` for a LineString, nested once more for a Multi);
 *   - WKT, which is how an ArcGIS or Socrata CSV export carries geometry.
 *
 * Null for anything that is not a drawable path: a blank cell, a single
 * vertex, a point, coordinates off the earth. Callers count those as skipped
 * rather than failing the layer — one bad row must not cost the other 400.
 */
export function parseLinePath(cell: string): LinePath | null {
  const text = (cell ?? '').trim()
  if (!text) return null

  const wkt = WKT_LINE_RE.exec(text)
  if (wkt) {
    const multi = !!wkt[1]
    const body = wkt[2]
    const chunks = multi ? [...body.matchAll(/\(([^()]*)\)/g)].map(m => m[1]) : [body]
    const parts: LinePath = []
    for (const chunk of chunks) {
      const vertices = chunk
        .split(',')
        .map(pair => pair.trim().split(/\s+/).map(Number))
        .map(nums => toVertex(nums[0], nums[1]))
        .filter((v): v is [number, number] => v !== null)
      if (vertices.length >= 2) parts.push(vertices)
    }
    return parts.length > 0 ? parts : null
  }

  if (!text.startsWith('[')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  // `[[lng,lat],…]` is one part; `[[[lng,lat],…],…]` is several. The nesting
  // of the first element says which, the same way GeoJSON's own types do.
  const nested = Array.isArray(parsed[0]) && Array.isArray((parsed[0] as unknown[])[0])
  const parts = (nested ? (parsed as unknown[]) : [parsed]).map(toPart).filter((p): p is [number, number][] => p !== null)
  return parts.length > 0 ? parts : null
}

/**
 * Every feature of a point or line layer as a label plus bare geometry, with
 * **no payload cap** (P7-5).
 *
 * `projectPointFeatures` and `projectLineFeatures` build what the API SHIPS,
 * so they wrap each feature in GeoJSON, apply the popup allowlist, and refuse
 * past `LAYER_MAX_FEATURES` / `LAYER_MAX_VERTICES`. Those caps are about the
 * size of a response. The local proximity pass sends no response — it reads a
 * pulled tree and writes a manifest — so it reads the geometry through this
 * instead, and a two-million-vertex layer is a long afternoon rather than a
 * refusal. That is the whole reason tier 1 exists (spec §F.4b).
 *
 * The ON-DEMAND tier deliberately does NOT use this: it goes through the
 * capped projection, so a layer too big to ship is refused there by name
 * rather than quietly measured. The two tiers can therefore never disagree
 * about a number — one of them declines instead.
 */
export function featureGeometryOf(
  ds: ParsedDataset,
  block: PointLayerBlock | LineLayerBlock,
): { label: string; lat?: number; lng?: number; path?: LinePath }[] {
  const names = new Set(ds.columns.map(c => c.name))
  const needed = block.geometry === 'line' ? [block.pathKey, block.labelKey] : [block.latKey, block.lngKey, block.labelKey]
  for (const key of needed) {
    if (!names.has(key)) {
      throw new TabularError(415, `layer column "${key}" is not in the file (columns: ${[...names].join(', ')})`)
    }
  }
  const out: { label: string; lat?: number; lng?: number; path?: LinePath }[] = []
  ds.rows.forEach((row, i) => {
    const label = (row[block.labelKey] ?? '').trim() || `Feature ${i + 1}`
    if (block.geometry === 'line') {
      const path = parseLinePath(row[block.pathKey] ?? '')
      if (path) out.push({ label, path })
      return
    }
    const coordinate = toCoordinate(row, block)
    if (coordinate) out.push({ label, lng: coordinate[0], lat: coordinate[1] })
  })
  return out
}

/** Project a parsed table to a GeoJSON FeatureCollection of lines. The same
 *  property allowlist the point projection applies — label + popupFields and
 *  nothing else — and the same reason for it. */
export function projectLineFeatures(ds: ParsedDataset, block: LineLayerBlock): Omit<InternalLayerLines, 'id' | 'slug' | 'geometry'> {
  const names = new Set(ds.columns.map(c => c.name))
  for (const key of [block.pathKey, block.labelKey, ...block.popupFields]) {
    if (!names.has(key)) throw new TabularError(415, `layer column "${key}" is not in the file (columns: ${[...names].join(', ')})`)
  }
  const features: LineFeature[] = []
  const vertices: [number, number][] = []
  let skipped = 0
  for (const row of ds.rows) {
    const parts = parseLinePath(row[block.pathKey] ?? '')
    if (parts === null) {
      skipped++
      continue
    }
    // Pushed one at a time, never spread: a single dense transmission line
    // is hundreds of thousands of vertices, and `push(...part)` passes every
    // one as an argument — which overflows the call stack long before the cap
    // below could refuse the layer.
    for (const part of parts) for (const vertex of part) vertices.push(vertex)
    if (vertices.length > LAYER_MAX_VERTICES) {
      throw new TabularError(
        413,
        `layer has more than ${LAYER_MAX_VERTICES.toLocaleString()} vertices — over the cap for a line layer`,
      )
    }
    const properties: Record<string, string> = { _label: (row[block.labelKey] ?? '').trim() }
    for (const f of block.popupFields) properties[f] = row[f] ?? ''
    // One part is a LineString and several are a MultiLineString, so the
    // payload says what it is rather than wrapping every line in a Multi.
    const geometry: LineFeature['geometry'] =
      parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts }
    features.push({ type: 'Feature', geometry, properties })
    if (features.length > LAYER_MAX_FEATURES) {
      throw new TabularError(413, `layer has more than ${LAYER_MAX_FEATURES.toLocaleString()} lines — over the cap for a line layer`)
    }
  }
  return { type: 'FeatureCollection', features, count: features.length, skipped, bbox: boundsOf(vertices) }
}

// --- states (P7-9) ------------------------------------------------------------

/**
 * Project a parsed table to one unlocated feature per state.
 *
 * Three ways a row does not become a state, all counted as `skipped` rather
 * than failing the layer — one bad row must not cost the other fifty:
 *
 * - **the cell names no state.** `stateFipsFor` reads a postal code, a name
 *   or a FIPS and returns '' for anything else; it never guesses, because a
 *   wrong state's permitting rules are worse than no state's. A 5-digit county
 *   GEOID lands here, deliberately: a state layer pointed at a county column
 *   is a block to fix, not a file to reinterpret.
 * - **the state already has a row.** One state, one polygon — a second row
 *   has nowhere to draw, and silently overwriting the first would make which
 *   row you read depend on file order.
 * - **nothing to say.** A row with no label, no popup value and no prose is a
 *   blank wash over a state with an empty popup under it.
 *
 * The features come out ordered by state name, which is how the entity rail
 * lists them. File order is the point and line rule because their order is
 * the author's; fifty states have one obvious order and it is not the CSV's.
 */
export function projectStateRows(ds: ParsedDataset, block: StateLayerBlock): Omit<InternalLayerStates, 'id' | 'slug' | 'geometry'> {
  const names = new Set(ds.columns.map(c => c.name))
  const needed = [block.stateKey, ...(block.labelKey ? [block.labelKey] : []), ...block.popupFields, ...block.detailFields]
  for (const key of needed) {
    if (!names.has(key)) throw new TabularError(415, `layer column "${key}" is not in the file (columns: ${[...names].join(', ')})`)
  }
  const byFips = new Map<string, StateFeature>()
  let skipped = 0
  let chars = 0
  for (const row of ds.rows) {
    const fips = stateFipsFor(row[block.stateKey] ?? '')
    if (!fips || byFips.has(fips)) {
      skipped++
      continue
    }
    const properties: Record<string, string> = {
      _state: fips,
      _label: (block.labelKey ? row[block.labelKey] ?? '' : '').trim() || stateNameForCode(stateCodeForFips(fips)),
    }
    let said = false
    for (const field of [...block.popupFields, ...block.detailFields]) {
      const value = (row[field] ?? '').trim()
      properties[field] = value
      if (value) said = true
      chars += value.length
    }
    if (!said && !block.labelKey) {
      // Nothing but the state's own name, which the map already knows.
      skipped++
      continue
    }
    if (chars > LAYER_MAX_POPUP_CHARS) {
      throw new TabularError(
        413,
        `layer has more than ${LAYER_MAX_POPUP_CHARS.toLocaleString()} characters of popup text — over the cap for a state layer`,
      )
    }
    byFips.set(fips, { type: 'Feature', geometry: null, properties })
  }
  const features = [...byFips.values()].sort((a, b) => a.properties._label.localeCompare(b.properties._label))
  return { type: 'FeatureCollection', features, count: features.length, skipped, bbox: null }
}

/** The extent of a line layer's rows, without building the payload — the
 *  point layer's P5-77 rule, so "Show on map" opens on the corridor. */
export function lineLayerBounds(ds: ParsedDataset, block: LineLayerBlock): LayerBounds | null {
  const vertices: [number, number][] = []
  for (const row of ds.rows) {
    const parts = parseLinePath(row[block.pathKey] ?? '')
    if (!parts) continue
    for (const part of parts) for (const vertex of part) vertices.push(vertex)
  }
  return boundsOf(vertices)
}

/** Bounding box over `[lng, lat]` pairs, or null when there are none. The one
 *  place the extent arithmetic lives. */
export function boundsOf(coordinates: readonly [number, number][]): LayerBounds | null {
  if (coordinates.length === 0) return null
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity
  for (const [lng, lat] of coordinates) {
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
  }
  return [minLng, minLat, maxLng, maxLat]
}

/** The extent of a point layer's rows, without building the payload (P5-77):
 *  the manifest needs the frame, not the features. A block that names columns
 *  the file lacks yields null — a layer with no frame, not an error. */
export function pointLayerBounds(ds: ParsedDataset, block: PointLayerBlock): LayerBounds | null {
  const coordinates: [number, number][] = []
  for (const row of ds.rows) {
    const coordinate = toCoordinate(row, block)
    if (coordinate) coordinates.push(coordinate)
  }
  return boundsOf(coordinates)
}

const warned = new Set<string>()

/** Remembered point-layer frames, keyed by slug. The version is everything
 *  the extent depends on — the entry's revision and the block's coordinate
 *  columns — so a re-pushed file or an edited block recomputes it. */
const boundsCache = new Map<string, { version: string; bounds: LayerBounds | null }>()
const boundsWarned = new Set<string>()

/** Drop every remembered frame. Tests use it; so would an operator who wants
 *  the next manifest to re-read the files. */
export function clearInternalLayerBounds(): void {
  boundsCache.clear()
  boundsWarned.clear()
}

/**
 * A county layer's values with **no cap** — the local pass's reader (P7-8).
 *
 * The county counterpart of `featureGeometryOf`, and there for the same
 * reason: `LAYER_MAX_VALUES` bounds what the API *ships* over a wire, and the
 * batch tier ships nothing. So a county layer too big to send is still one the
 * local index pass can read, and the two tiers can never disagree about a
 * number — one of them declines instead (§F.4b).
 *
 * The range is deliberately not returned. An index normalises against the
 * values' own min and max, which `composite.ts` computes, and a second answer
 * to the same question is a second answer that can drift.
 */
export function countyValuesOf(ds: ParsedDataset, block: CountyLayerBlock): Record<string, number> {
  const names = new Set(ds.columns.map(c => c.name))
  for (const key of [block.geoKey, block.valueKey]) {
    if (!names.has(key)) {
      throw new TabularError(415, `layer column "${key}" is not in the file (columns: ${[...names].join(', ')})`)
    }
  }
  const values: Record<string, number> = {}
  for (const row of ds.rows) {
    const geoId = normalizeGeoId(row[block.geoKey] ?? '')
    const value = toNumber(row[block.valueKey] ?? '')
    if (geoId === null || value === null) continue
    values[geoId] = value
  }
  return values
}

/**
 * The frame a feature layer opens on (P5-77, and lines in P7-3). The manifest
 * is otherwise built from the catalog index alone, but a layer's extent lives
 * in its rows, so the file is read once per revision and only the four
 * numbers are kept here (the parse itself belongs to the tabular cache). A
 * layer whose file will not read still belongs on the map — it just opens on
 * the national view.
 */
async function boundsForFeatureLayer(
  slug: string,
  version: string,
  block: PointLayerBlock | LineLayerBlock,
): Promise<LayerBounds | null> {
  const hit = boundsCache.get(slug)
  if (hit && hit.version === version) return hit.bounds
  try {
    const { parsed } = await readDataset(slug, block.file)
    const bounds = block.geometry === 'line' ? lineLayerBounds(parsed, block) : pointLayerBounds(parsed, block)
    boundsCache.set(slug, { version, bounds })
    boundsWarned.delete(slug)
    return bounds
  } catch (err) {
    if (!boundsWarned.has(slug)) {
      boundsWarned.add(slug)
      console.warn(`[layers] "${slug}" opens on the national view — its file did not read: ${(err as any)?.message || err}`)
    }
    return null
  }
}

/** Published datasets with a valid layer block, from the catalog index (plus
 *  one cached file read per point or line layer, for its frame). */
export async function listInternalLayers(): Promise<InternalLayerManifestEntry[]> {
  const result = await libraryQuery(
    `SELECT slug, title, kind, status, meta, bytes, updated_at FROM library_catalog WHERE status = 'published' ORDER BY title ASC`,
  )
  const layers: InternalLayerManifestEntry[] = []
  const framing: Promise<void>[] = []
  for (const row of result.rows as { slug: string; title: string; kind: string; meta: Record<string, unknown>; bytes: unknown; updated_at: unknown }[]) {
    const meta = isPlainObject(row.meta) ? row.meta : {}
    const stamp =
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : typeof row.updated_at === 'string'
          ? row.updated_at
          : null
    // P7-8: a working set's composite columns are layers too, out of the same
    // one query — a set IS a catalog row, so this costs no extra round trip.
    if (row.kind === WORKING_SET_KIND) {
      layers.push(...derivedLayersOf(row.slug, meta, stamp))
      continue
    }
    if (meta.layer === undefined) continue
    const parsed = parseLayerBlock(meta)
    if ('error' in parsed) {
      if (!warned.has(row.slug)) {
        warned.add(row.slug)
        console.warn(`[layers] "${row.slug}" has an invalid layer block and is skipped: ${parsed.error}`)
      }
      continue
    }
    warned.delete(row.slug)
    const b = parsed.block
    // P6-1: from the DATASET's manifest, not from the layer block's `source`
    // line — the block says where the numbers came from in prose, the
    // manifest says who published them in a word.
    const organization = organizationForMeta(meta)
    const entry: InternalLayerManifestEntry = {
      id: `${INTERNAL_LAYER_ID_PREFIX}${row.slug}`,
      slug: row.slug,
      geometry: b.geometry,
      name: b.name,
      dataType: b.geometry === 'county' ? b.dataType : 'count',
      unit: b.geometry === 'county' ? b.unit : '',
      direction: b.geometry === 'county' ? b.direction : 'higher_better',
      range: b.geometry === 'county' ? b.range : null,
      description: b.description,
      source: b.source,
      organization,
      organizationLabel: organization ? organizationLabel(organization) : '',
      year: b.year,
      dates: datesFromManifest({ kind: row.kind, meta, slug: row.slug }),
      file: b.file ?? null,
      color: b.geometry === 'county' ? null : b.color,
      popupFields: b.geometry === 'county' ? [] : b.popupFields,
      detailFields: b.geometry === 'state' ? b.detailFields : [],
      width: b.geometry === 'line' ? b.width : null,
      bbox: null,
      updatedAt: stamp,
    }
    layers.push(entry)
    if (b.geometry === 'point' || b.geometry === 'line') {
      // The version is everything the extent depends on — the entry's
      // revision and the block's geometry columns — so a re-pushed file or an
      // edited block recomputes it.
      const geometryKeys = b.geometry === 'line' ? b.pathKey : `${b.latKey}|${b.lngKey}`
      const version = `${entry.updatedAt ?? ''}|${String(row.bytes ?? '')}|${b.file ?? ''}|${geometryKeys}`
      framing.push(boundsForFeatureLayer(row.slug, version, b).then(bounds => {
        entry.bbox = bounds
      }))
    }
  }
  // The frames in parallel: a manifest with three feature layers is one round
  // of (usually cached) reads, not three.
  await Promise.all(framing)
  return layers
}

/** Values for one layer. Unknown, unpublished, and blockless slugs all 404
 *  identically — the manifest is the only discovery surface. */
export async function readInternalLayerValues(
  slug: string,
): Promise<InternalLayerValues | InternalLayerPoints | InternalLayerLines | InternalLayerStates> {
  // P7-8: `<set>~<column>` is a derived index, served from the set's manifest.
  // Checked first because the separator cannot occur in a dataset slug, so
  // this can never shadow one.
  if (isDerivedLayerSlug(slug)) return derivedLayerValues(slug)
  const entry = await getCatalogEntry(slug)
  if (!entry || entry.status !== 'published') throw new TabularError(404, 'not found')
  const parsed = parseLayerBlock(isPlainObject(entry.meta) ? entry.meta : {})
  if ('error' in parsed) throw new TabularError(404, 'not found')
  const { parsed: ds } = await readDataset(slug, parsed.block.file)
  const id = `${INTERNAL_LAYER_ID_PREFIX}${slug}`
  if (parsed.block.geometry === 'point') {
    return { id, slug, geometry: 'point', ...projectPointFeatures(ds, parsed.block) }
  }
  if (parsed.block.geometry === 'line') {
    return { id, slug, geometry: 'line', ...projectLineFeatures(ds, parsed.block) }
  }
  if (parsed.block.geometry === 'state') {
    return { id, slug, geometry: 'state', ...projectStateRows(ds, parsed.block) }
  }
  const { values, count, range } = projectCountyValues(ds, parsed.block)
  return { id, slug, geometry: 'county', values, count, range }
}
