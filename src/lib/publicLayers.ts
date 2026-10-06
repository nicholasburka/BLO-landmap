/**
 * The public map's layers, as knowledge-base material (P5-45).
 *
 * `LAYER_REGISTRY` already knows what every county layer measures, where it
 * came from and how to print a value — but only the map ever read it. This
 * module turns the same registry into the three things a researcher needs:
 * a browsable list, one about page per layer, and the layer's numbers county
 * by county. Nothing here renders or styles anything, so all of it is
 * testable without a browser.
 *
 * Two rules shape the code below:
 *  - internal layers (registered at runtime after login) are NOT ours. They
 *    have their own library entry with About/Data/Map tabs, so we only ever
 *    link to it.
 *  - a page asks for ONE layer's data, through `LAYER_DATA_SOURCES` below.
 *    That used to mean "fetch and parse just this layer's CSV"; since P5-90
 *    every entry resolves the same prebuilt, content-hashed county file, so
 *    the answer is one download (deduped and shared with the map, and
 *    `immutable` in the CDN) and no CSV parsing at all.
 */
import {
  LAYER_REGISTRY,
  type DataType,
  type Direction,
  type LayerCategory,
  type LayerDefinition,
} from '@/config/layerRegistry'
import { TOPICS, shapeLabel } from '@/config/taxonomy'
import { organizationFor, organizationLabel } from '@/config/organizations'
import { useMapData } from '@/composables/useMapData'
import { initCountyLookup, getCountyByGeoId } from '@/lib/countyLookup'
import { INTERNAL_PREFIX } from '@/lib/mapDeepLinks'

// --- The list ------------------------------------------------------------------

/**
 * Reading order for the index page, and the labels that go with it — both from
 * the taxonomy (P5-63), which is where the same words are read from on the
 * library list, the entry pages, the place report and the Ask prompt.
 *
 * `internal` is the one category with no topic: runtime-registered library
 * layers are not a subject, they are a source. It keeps its own label here.
 */
export const INTERNAL_CATEGORY_LABEL = 'Internal library layers'

const LAYER_TOPICS = TOPICS.filter(topic => !!topic.layerCategory)

export const CATEGORY_ORDER: LayerCategory[] = [
  ...LAYER_TOPICS.map(topic => topic.layerCategory as LayerCategory),
  'internal',
]

/** Plain words, not the registry's internal category keys. */
export const CATEGORY_LABELS: Record<LayerCategory, string> = {
  ...(Object.fromEntries(
    LAYER_TOPICS.map(topic => [topic.layerCategory as LayerCategory, topic.label]),
  ) as Record<LayerCategory, string>),
  internal: INTERNAL_CATEGORY_LABEL,
}

export function isPublicLayerId(id: string): boolean {
  const layer = LAYER_REGISTRY[id]
  return !!layer && layer.category !== 'internal'
}

/** Every layer that ships in the public bundle, in category order then by name. */
export function publicLayers(): LayerDefinition[] {
  return Object.values(LAYER_REGISTRY)
    .filter(l => l.category !== 'internal')
    .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name))
}

export function getPublicLayer(id: string): LayerDefinition | null {
  return isPublicLayerId(id) ? LAYER_REGISTRY[id] : null
}

export interface LayerGroup {
  category: LayerCategory
  label: string
  layers: LayerDefinition[]
}

export function groupLayers(layers: LayerDefinition[]): LayerGroup[] {
  return CATEGORY_ORDER.map(category => ({
    category,
    label: CATEGORY_LABELS[category],
    layers: layers.filter(l => l.category === category),
  })).filter(group => group.layers.length > 0)
}

/**
 * Name, description and the category's plain-word label — a researcher
 * searching "poverty" means the subject, not the file path or the field name,
 * and "housing" is a subject even though no layer is named for it (P5-64).
 * The label comes from the taxonomy, so ⌘K, /layers, compare's picker and the
 * county context picker all match on the same words the groups are titled with.
 */
export function searchLayers(layers: LayerDefinition[], query: string): LayerDefinition[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return layers
  return layers.filter(l => layerSearchText(l).includes(needle))
}

function layerSearchText(layer: LayerDefinition): string {
  return `${layer.name} ${layer.description} ${CATEGORY_LABELS[layer.category] ?? ''}`.toLowerCase()
}

// --- Saying what a layer is ------------------------------------------------------

export function directionLabel(direction: Direction): string {
  return direction === 'lower_better' ? 'lower is better' : 'higher is better'
}

export function dataTypeLabel(dataType: DataType): string {
  switch (dataType) {
    case 'currency':
      return 'dollars'
    case 'ordinal':
      return 'category'
    case 'index':
      return 'index score'
    default:
      return dataType
  }
}

/** Shown wherever a layer has no provenance in the registry. Saying so beats
 *  a blank line: "we don't know" is information. */
export const SOURCE_NOT_RECORDED = 'Source: not recorded'

export function sourceLine(layer: LayerDefinition): string {
  const source = layer.source?.trim() ?? ''
  const year = String(layer.year ?? '').trim()
  if (!source) return SOURCE_NOT_RECORDED
  return year ? `${source} · ${year}` : source
}

/** The knowledge base's word for the same line: "Source" is an entry kind
 *  there, so the provenance of a layer is its publisher. The public map keeps
 *  `sourceLine`. */
export const PUBLISHER_NOT_RECORDED = 'Publisher: not recorded'

export function publisherLine(layer: LayerDefinition): string {
  const line = sourceLine(layer)
  return line === SOURCE_NOT_RECORDED ? PUBLISHER_NOT_RECORDED : line
}

// --- Organization and shape (P6-1, P6-2) -------------------------------------

/**
 * A public layer as the datasets browser files it: who published it, and what
 * kind of thing it is.
 *
 * The registry has always carried a publisher — as prose, in `source` ("Urban
 * Institute - Diversity Data Kids", "US Bureau of Labor Statistics (BLS)") —
 * so the organization is that prose folded through the vocabulary, exactly the
 * way a library manifest's provider is. A name nothing matches keeps its own
 * text and heads its own group, same rule as everywhere else.
 *
 * The shape is not derived at all: every public layer is a number per county.
 * That is what `statistics` means, and it is true of all fifteen by
 * construction — a layer that was not one could not be drawn by the map.
 */
export const PUBLIC_LAYER_SHAPE = 'statistics'

/**
 * P6-19 rule 5: every public layer covers the whole country.
 *
 * Nor is the coverage derived, and for the same reason the shape is not: all
 * fifteen are a value for every county in the United States. That is a fact
 * about the registry rather than a fallback, which is the one thing that lets
 * a layer row say `national` when a dataset nobody could place must not.
 */
export const PUBLIC_LAYER_COVERAGE: { scope: string; states: string[]; label: string } = {
  scope: 'national',
  states: [],
  label: 'National',
}

export function layerOrganization(layer: Pick<LayerDefinition, 'source'>): string {
  const source = layer.source?.trim() ?? ''
  if (!source) return ''
  return organizationFor(source) ?? source
}

export function layerOrganizationLabel(layer: Pick<LayerDefinition, 'source'>): string {
  const organization = layerOrganization(layer)
  return organization ? organizationLabel(organization) : ''
}

export function publicLayerShapeLabel(): string {
  return shapeLabel(PUBLIC_LAYER_SHAPE)
}

export function rangeLine(layer: LayerDefinition): string {
  return `${layer.formatValue(layer.range.min)} to ${layer.formatValue(layer.range.max)}`
}

/** What the Ask box on the about page starts with. */
export function askQuestionFor(layer: LayerDefinition): string {
  return `What does the ${layer.name} layer measure and where does it come from?`
}

/** Public layers have an about page here; internal ones keep their library
 *  entry (About / Data / Map tabs already live there). */
export function layerAboutHref(id: string): string {
  if (id.startsWith(INTERNAL_PREFIX)) return `/library/${encodeURIComponent(id.slice(INTERNAL_PREFIX.length))}`
  return `/layers/${encodeURIComponent(id)}`
}

// --- County values -----------------------------------------------------------------

export interface CountyValueRow {
  geoId: string
  county: string
  state: string
  value: number | string | null
  /** The value as the map prints it (the layer's own formatter). */
  display: string
}

type MapData = ReturnType<typeof useMapData>
/** Load one layer's data, then hand back the GEOID → record map it landed in.
 *  Keyed by layer id rather than category because the registry's categories
 *  and the data maps do not line up: the Black homeownership rate is an
 *  `equity` layer whose values sit in the housing map. */
export const LAYER_DATA_SOURCES: Record<string, (data: MapData) => Promise<Record<string, unknown>>> = {
  combined_scores_v2: async d => {
    await d.loadCombinedScoresV2()
    return d.combinedScoresV2Data.value
  },
  diversity_index: async d => {
    await d.loadDiversityData()
    return d.diversityData.value
  },
  pct_Black: async d => {
    await d.loadDiversityData()
    return d.diversityData.value
  },
  life_expectancy: async d => {
    await d.loadLifeExpectancyData()
    return d.lifeExpectancyData.value
  },
  avg_weekly_wage: async d => {
    await d.loadEconomicData()
    return d.economicData.value
  },
  median_income_by_race: async d => {
    await d.loadEconomicData()
    return d.economicData.value
  },
  median_home_value: async d => {
    await d.loadHousingData()
    return d.housingData.value
  },
  median_property_tax: async d => {
    await d.loadHousingData()
    return d.housingData.value
  },
  homeownership_by_race: async d => {
    await d.loadHousingData()
    return d.housingData.value
  },
  poverty_by_race: async d => {
    await d.loadEquityData()
    return d.equityData.value
  },
  black_progress_index: async d => {
    await d.loadEquityData()
    return d.equityData.value
  },
  commute_time: async d => {
    await d.loadTransportationData()
    return d.transportationData.value
  },
  drove_alone: async d => {
    await d.loadTransportationData()
    return d.transportationData.value
  },
  public_transit: async d => {
    await d.loadTransportationData()
    return d.transportationData.value
  },
  contamination: async d => {
    await d.loadContaminationData()
    return d.countyContaminationCounts
  },
}

/** GEOID → the county's name and state, or null when we cannot say. */
export type CountyNameLookup = (geoId: string) => { county: string; state: string } | null

function valueOf(record: unknown, dataKey: string): number | string | null {
  // Contamination counts are stored as a bare number per county in some rows.
  if (typeof record === 'number') return record
  if (!record || typeof record !== 'object') return null
  const raw = (record as Record<string, unknown>)[dataKey]
  if (raw == null || raw === '') return null
  return typeof raw === 'number' || typeof raw === 'string' ? raw : null
}

function fallbackName(record: unknown): { county: string; state: string } | null {
  if (!record || typeof record !== 'object') return null
  const r = record as Record<string, unknown>
  const county = r.county_name ?? r.countyName
  const state = r.state_name ?? r.stateName ?? r.state
  if (typeof county !== 'string' || !county) return null
  return { county, state: typeof state === 'string' ? state : '' }
}

/** Values + names → the table's rows. Counties with no value for this layer
 *  are left out: an empty cell in every row is noise, not data. */
export function buildCountyRows(
  layer: LayerDefinition,
  values: Record<string, unknown>,
  nameFor: CountyNameLookup,
): CountyValueRow[] {
  const rows: CountyValueRow[] = []
  for (const [geoId, record] of Object.entries(values)) {
    const value = valueOf(record, layer.dataKey)
    if (value == null) continue
    const named = nameFor(geoId) ?? fallbackName(record)
    rows.push({
      geoId,
      county: named?.county ?? geoId,
      state: named?.state ?? '',
      value,
      display: layer.formatValue(value),
    })
  }
  // Object key order puts "13121" before "01001" (JS lists integer-like keys
  // first), which would look random in the table. GEOID order is stable.
  return rows.sort((a, b) => a.geoId.localeCompare(b.geoId))
}

/** Load one layer's numbers for every county, with names attached. The name
 *  lookup is a separate public file; if it fails the table still works
 *  (GEOIDs instead of names) rather than showing an error. */
export async function loadCountyRows(layer: LayerDefinition): Promise<CountyValueRow[]> {
  const source = LAYER_DATA_SOURCES[layer.id]
  if (!source) throw new Error(`No county data source for layer "${layer.id}"`)
  const data = useMapData()
  const values = await source(data)

  let nameFor: CountyNameLookup = () => null
  try {
    await initCountyLookup()
    nameFor = geoId => {
      const hit = getCountyByGeoId(geoId)
      return hit ? { county: hit.name, state: hit.stateName } : null
    }
  } catch {
    // County names are a nicety; the values are the point.
  }
  return buildCountyRows(layer, values, nameFor)
}

// --- Table operations (search / sort / page / CSV) ---------------------------------

export function filterCountyRows(rows: CountyValueRow[], query: string): CountyValueRow[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return rows
  return rows.filter(r => `${r.county} ${r.state}`.toLowerCase().includes(needle))
}

export type CountySortKey = 'name' | 'value'
export type SortDirection = 'asc' | 'desc'

export function sortCountyRows(rows: CountyValueRow[], key: CountySortKey, direction: SortDirection): CountyValueRow[] {
  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((a, b) => {
    if (key === 'name') return sign * (`${a.county} ${a.state}`.localeCompare(`${b.county} ${b.state}`))
    // A blank is not the biggest number — rows with no value sink to the
    // bottom whichever way the column is pointed.
    if (a.value == null || b.value == null) return (a.value == null ? 1 : 0) - (b.value == null ? 1 : 0)
    if (typeof a.value === 'number' && typeof b.value === 'number') return sign * (a.value - b.value)
    return sign * String(a.value).localeCompare(String(b.value))
  })
}

export function pageOf<T>(rows: T[], page: number, size: number): T[] {
  const start = Math.max(0, (page - 1) * size)
  return rows.slice(start, start + size)
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The rows on screen, as a file. The value column keeps the registry's
 *  `dataKey` so a download lines up with the source CSV it came from. */
export function rowsToCsv(layer: LayerDefinition, rows: CountyValueRow[]): string {
  const lines = [['GEOID', 'County', 'State', layer.dataKey].map(csvCell).join(',')]
  for (const row of rows) {
    lines.push([row.geoId, row.county, row.state, row.value == null ? '' : String(row.value)].map(csvCell).join(','))
  }
  return lines.join('\n')
}

export function csvFilename(layer: LayerDefinition): string {
  return `${layer.id}-by-county.csv`
}
