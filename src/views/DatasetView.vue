<script setup lang="ts">
/**
 * Dataset explorer (P5-31): browse a library entry's tabular file at the
 * table level — search, sort, per-column filters, column chooser, row
 * drawer, schema panel. The URL query is the source of truth (see
 * src/lib/libraryData.ts), so a filtered table is linkable and reloadable.
 *
 * P5-42 turns browsing into ANALYSIS for a researcher who does not write
 * code: an overview strip, a Summaries panel that describes any column
 * (bars, a histogram, a date range), Group by → a value/count table, a
 * CSV of exactly what is on screen, and an Ask box. Every summary is of
 * the CURRENT filtered set, so "filter, then ask" is the whole workflow —
 * and clicking a bar writes the filter back into the same URL state.
 *
 * P5-48 adds COUNTY CONTEXT: any table that carries a county GEOID can pull
 * the public map's county numbers in as extra columns (`?layers=`), joined in
 * the browser for the rows on screen. See src/lib/countyJoin.ts.
 *
 * P5-54 lets the researcher KEEP one: "Save view" stores the dataset,
 * search, filters, sort, visible columns, county layers and the open summary
 * as a saved view (`type: 'table'`), which shows up in the strip below the
 * toolbar, in ⌘K, in Ask's index, and as a wiki embed. Opening one is
 * `?view=<slug>` alongside the restored query: the table re-runs the query
 * against today's rows — it is a recipe, not a snapshot — and says so when
 * the number of matching rows has moved since it was saved.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import AskBox from '@/components/AskBox.vue'
import ColumnSummaryPanel from '@/components/ColumnSummary.vue'
import CountyContextPicker from '@/components/CountyContextPicker.vue'
import GroupBySummary from '@/components/GroupBySummary.vue'
import {
  fetchDatasetSchema,
  fetchDatasetRows,
  fetchColumnSummary,
  fetchColumnOverview,
  datasetExportUrl,
  parseRowsState,
  rowsStateToQuery,
  cellOf,
  isHttpUrl,
  describeColumn,
  DatasetRequestError,
  FILTER_OPS,
  ROWS_LIMIT_DEFAULT,
  type DatasetSchema,
  type DatasetRow,
  type RowsState,
  type RowFilter,
  type FilterOp,
  type ColumnSummary,
  type ColumnOverview,
} from '@/lib/libraryData'
import {
  contextCell,
  contextLayerName,
  contextLayersParam,
  findGeoIdColumn,
  loadContextValues,
  parseContextLayers,
  rowGeoId,
  sortRowsByContext,
  tableCsv,
  type CountyValues,
  type JoinedColumn,
  type SortDirection,
} from '@/lib/countyJoin'
import { mapUrlForLayers, recordUrl } from '@/lib/mapDeepLinks'
import MapPane from '@/components/MapPane.vue'
import { useShowOnMap } from '@/composables/useShowOnMap'
import {
  fetchView,
  fetchViews,
  saveView,
  tableStateOf,
  tableViewUrl,
  type SavedSummary,
  type SavedTableViewState,
  type SavedViewSummary,
} from '@/lib/views'
import { chartKindsFor, type ChartKind } from '@/lib/charts'
import { completeFirstRunStep } from '@/lib/firstRun'
import { usePhoneLayout, useBodyScrollLock } from '@/composables/usePhoneLayout'

const props = defineProps<{
  /** P5-37: rendered inside the entry hub — no back link / title of its own. */
  embedded?: boolean
  /**
   * P7-2: which dataset, when the route is not about one.
   *
   * On `/library/:slug` the route param IS the dataset; on `/views/:slug` it
   * is the VIEW, and the table is showing the dataset the view's working set is
   * anchored on. One prop, so the explorer is reusable over a set without a
   * second copy of 2,000 lines of table.
   */
  slug?: string
  /**
   * P7-2: columns joined from outside — a working set's derived columns.
   *
   * They go through the same pipeline as P5-48's county context: same header
   * row, same cells, same client-side sort, same CSV. A derived column arrives
   * already keyed by GEOID (`derivedTableColumns` in `lib/workingSets.ts`), so
   * the table sorts a set's analysis through code that already existed.
   */
  extraColumns?: JoinedColumn[]
  /**
   * P7-2: the host page provides the map, so do not offer a second one.
   *
   * `/views/:slug` has a Map interface of its own over the whole working set —
   * every layer in it, not just this one dataset's — and two "Show on map"
   * buttons in one page would be two answers to one question.
   */
  hostMap?: boolean
}>()

const emit = defineEmits<{
  /**
   * P7-2: what this table is showing, for a host that owns the map.
   *
   * `geoIds` is the subset — exactly what `query.only` wants — and the counts
   * are what a pane's note says about it. Emitted whenever the rows change, so
   * the host's map follows a filter without asking for the rows again.
   *
   * `loading` is the half a host actually needs to act on: an empty subset
   * means "the whole layer" to `query.only`, so a host that cannot tell "no
   * rows yet" from "no counties in these rows" would open its map on
   * everything and then snap to the answer a moment later.
   */
  (e: 'shown', payload: { geoIds: string[]; rows: number; total: number; loading: boolean }): void
}>()

const route = useRoute()
const router = useRouter()

/** Query keys the table owns; anything else (e.g. the hub's `tab`, or a
 *  working-set view's `interface`) is preserved on writes. */
const TABLE_QUERY_KEYS = new Set(['file', 'q', 'sort', 'dir', 'filter', 'page', 'limit'])

const slug = computed(() => props.slug ?? String(route.params.slug ?? ''))
const state = computed<RowsState>(() => parseRowsState(route.query as Record<string, string | string[] | null | undefined>))

const schema = ref<DatasetSchema | null>(null)
const rows = ref<DatasetRow[]>([])
const total = ref(0)
const loadingSchema = ref(true)
const loadingRows = ref(false)
/** P5-48: the column holding this file's county GEOID, or null when it has
 *  none. Sticky for the life of a file — a page whose GEOIDs happen to be
 *  blank must not make the county-context control vanish mid-browse — and
 *  reset when the file changes. Declared here because `loadSchema` clears it. */
const geoIdColumn = ref<string | null>(null)
const error = ref('')
const errorStatus = ref(0)

const page = computed(() => state.value.page ?? 1)
const limit = computed(() => state.value.limit ?? ROWS_LIMIT_DEFAULT)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
const firstRow = computed(() => (total.value === 0 ? 0 : (page.value - 1) * limit.value + 1))
const lastRow = computed(() => Math.min(total.value, page.value * limit.value))

// --- URL state writes -----------------------------------------------------------

function replaceState(next: RowsState): void {
  const preserved: Record<string, string> = {}
  for (const [k, v] of Object.entries(route.query)) {
    if (!TABLE_QUERY_KEYS.has(k) && typeof v === 'string') preserved[k] = v
  }
  void router.replace({ query: { ...preserved, ...rowsStateToQuery(next) } })
}

/** Any change to search/sort/filter/file resets to page 1. */
function patchState(patch: Partial<RowsState>, keepPage = false): void {
  const next: RowsState = { ...state.value, ...patch }
  if (!keepPage) delete next.page
  for (const key of Object.keys(next) as (keyof RowsState)[]) {
    if (next[key] === undefined || next[key] === '') delete next[key]
  }
  replaceState(next)
}

// --- Loading ------------------------------------------------------------------------

let schemaKey = ''
async function loadSchema(): Promise<void> {
  const key = `${slug.value}::${state.value.file ?? ''}`
  if (key === schemaKey && schema.value) return
  schemaKey = key
  // Another file, another set of columns: re-detect the county key (P5-48).
  geoIdColumn.value = null
  loadingSchema.value = true
  error.value = ''
  errorStatus.value = 0
  try {
    schema.value = await fetchDatasetSchema(slug.value, state.value.file)
    restoreHidden()
  } catch (err: unknown) {
    schema.value = null
    errorStatus.value = err instanceof DatasetRequestError ? err.status : 0
    error.value = err instanceof Error ? err.message : 'dataset request failed'
  } finally {
    loadingSchema.value = false
  }
}

let rowsRequest = 0
/** P7-2: a first page of rows has come back (or failed). Distinct from
 *  `loadingRows`, which is false both before a request starts and after it
 *  finishes — a host waiting on the subset must not be told "settled" in the
 *  gap between the schema landing and the rows being asked for. */
const rowsSettled = ref(false)
async function loadRows(): Promise<void> {
  if (!schema.value) return
  const id = ++rowsRequest
  loadingRows.value = true
  try {
    const result = await fetchDatasetRows(slug.value, state.value)
    if (id !== rowsRequest) return // a newer request superseded this one
    rows.value = result.rows
    total.value = result.total
    error.value = ''
    // Named candidate + real 5-digit values: only then is county context on.
    if (!geoIdColumn.value && schema.value) geoIdColumn.value = findGeoIdColumn(schema.value.columns, rows.value)
  } catch (err: unknown) {
    if (id !== rowsRequest) return
    rows.value = []
    total.value = 0
    error.value = err instanceof Error ? err.message : 'dataset rows request failed'
  } finally {
    if (id === rowsRequest) {
      loadingRows.value = false
      rowsSettled.value = true
    }
  }
}

// Only the table's own keys trigger a reload. `layers` (P5-48) changes what
// the table SHOWS, not what the server is asked for, so it must not cost a
// round trip.
watch(
  () => [slug.value, JSON.stringify(rowsStateToQuery(state.value))].join('|'),
  async () => {
    await loadSchema()
    await loadRows()
  },
  { immediate: true },
)

// --- Search (debounced) ---------------------------------------------------------------

const searchText = ref(state.value.q ?? '')
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchText, value => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if ((value.trim() || undefined) !== state.value.q) patchState({ q: value.trim() || undefined })
  }, 300)
})
watch(
  () => state.value.q,
  q => {
    if ((q ?? '') !== searchText.value.trim()) searchText.value = q ?? ''
  },
)

// --- Sorting ------------------------------------------------------------------------------

function toggleSort(column: string): void {
  if (state.value.sort !== column) patchState({ sort: column, dir: undefined })
  else if (state.value.dir !== 'desc') patchState({ sort: column, dir: 'desc' })
  else {
    // Third press clears the sort — nothing was applied, so nothing ticks.
    patchState({ sort: undefined, dir: undefined })
    return
  }
  completeFirstRunStep('data')
}

function ariaSort(column: string): 'ascending' | 'descending' | 'none' {
  if (state.value.sort !== column) return 'none'
  return state.value.dir === 'desc' ? 'descending' : 'ascending'
}

// --- Filters ----------------------------------------------------------------------------------

const filters = computed<RowFilter[]>(() => state.value.filter ?? [])
const filterColumn = ref<string | null>(null)
const filterOp = ref<FilterOp>('contains')
const filterValue = ref('')

const OP_LABEL: Record<FilterOp, string> = {
  contains: 'contains',
  eq: 'is',
  gte: '≥',
  lte: '≤',
  empty: 'is empty',
  notEmpty: 'is not empty',
}

function openFilter(column: string): void {
  if (filterColumn.value === column) {
    filterColumn.value = null
    return
  }
  const existing = filters.value.find(f => f.column === column)
  filterColumn.value = column
  filterOp.value = existing?.op ?? (columnType(column) === 'number' ? 'gte' : 'contains')
  filterValue.value = existing?.value ?? ''
}

function applyFilter(): void {
  if (!filterColumn.value) return
  const needsValue = filterOp.value !== 'empty' && filterOp.value !== 'notEmpty'
  if (needsValue && !filterValue.value.trim()) return
  const clause: RowFilter = needsValue
    ? { column: filterColumn.value, op: filterOp.value, value: filterValue.value.trim() }
    : { column: filterColumn.value, op: filterOp.value }
  const next = filters.value.filter(f => f.column !== clause.column).concat(clause)
  filterColumn.value = null
  patchState({ filter: next })
  completeFirstRunStep('data')
}

function removeFilter(index: number): void {
  const next = filters.value.filter((_, i) => i !== index)
  patchState({ filter: next.length ? next : undefined })
}

function clearAll(): void {
  searchText.value = ''
  patchState({ q: undefined, filter: undefined, sort: undefined, dir: undefined })
}

/** Schema-panel shortcut: click a top value → "column is value". */
function filterByValue(column: string, value: string): void {
  const next = filters.value.filter(f => f.column !== column).concat({ column, op: 'eq', value })
  patchState({ filter: next })
  completeFirstRunStep('data')
}

const hasQuery = computed(() => !!(state.value.q || filters.value.length || state.value.sort))

// --- Columns (visibility persisted per dataset file) ---------------------------------------

const hidden = ref<Set<string>>(new Set())
const columnsOpen = ref(false)
const schemaOpen = ref(false)

function storageKey(): string {
  return `blo.dataset.hidden.${slug.value}.${schema.value?.file ?? ''}`
}

function restoreHidden(): void {
  try {
    const raw = localStorage.getItem(storageKey())
    const list: unknown = raw ? JSON.parse(raw) : []
    hidden.value = new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    hidden.value = new Set()
  }
}

function toggleColumn(name: string): void {
  const next = new Set(hidden.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  hidden.value = next
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...next]))
  } catch {
    /* storage unavailable — visibility just won't persist */
  }
}

const visibleColumns = computed(() => (schema.value?.columns ?? []).filter(c => !hidden.value.has(c.name)))

function columnType(name: string): string {
  return schema.value?.columns.find(c => c.name === name)?.type ?? 'string'
}

// --- Analysis: overview, column summaries, group by (P5-42) ------------------------------------

/** 'list' = every column at a glance; 'column' = one column's distribution;
 *  'group' = the same column as a value/count table (the server's `top`
 *  list with a higher cap — see fetchColumnSummary). */
type AnalysisMode = 'list' | 'column' | 'group'

const summariesOpen = ref(false)
const analysisMode = ref<AnalysisMode>('list')
const analysisColumn = ref<string | null>(null)
const overview = ref<ColumnOverview[] | null>(null)
const summary = ref<ColumnSummary | null>(null)
const loadingAnalysis = ref(false)
const analysisError = ref('')

/** Rows the summaries describe: the filtered total, not the file's. */
const matched = computed(() => total.value)

/** Have search or filters narrowed the file? (Sorting has not — it moves
 *  rows around, it does not remove any, so it never earns a match count.) */
const narrowed = computed(() => !!(state.value.q || filters.value.length))

/** "312 rows · 187 match your filters · 14 columns" — built here rather
 *  than in the template so the separators cannot drift. */
const overviewLine = computed(() => {
  if (!schema.value) return ''
  const parts = [`${schema.value.rowCount.toLocaleString()} rows`]
  if (narrowed.value) parts.push(`${total.value.toLocaleString()} match your filters`)
  parts.push(`${schema.value.columns.length.toLocaleString()} columns`)
  return parts.join(' · ')
})

/** Only the columns on screen go into the CSV — "download what I see". */
const exportUrl = computed(() =>
  schema.value
    ? datasetExportUrl(slug.value, state.value, hidden.value.size ? visibleColumns.value.map(c => c.name) : undefined)
    : '',
)

let analysisRequest = 0
async function refreshAnalysis(): Promise<void> {
  if (!summariesOpen.value) return
  const id = ++analysisRequest
  const mode = analysisMode.value
  const column = analysisColumn.value
  if (mode !== 'list' && !column) return
  loadingAnalysis.value = true
  analysisError.value = ''
  try {
    if (mode === 'list') {
      const data = await fetchColumnOverview(slug.value, state.value)
      if (id === analysisRequest) overview.value = data
    } else {
      const data = await fetchColumnSummary(slug.value, state.value, column!, { groupBy: mode === 'group' })
      if (id === analysisRequest) summary.value = data
    }
  } catch (err: unknown) {
    if (id !== analysisRequest) return
    overview.value = mode === 'list' ? null : overview.value
    summary.value = mode === 'list' ? summary.value : null
    analysisError.value = err instanceof Error ? err.message : 'summary request failed'
  } finally {
    if (id === analysisRequest) loadingAnalysis.value = false
  }
}

// A narrower table means different counts, so the panel follows the URL —
// but only the parts that decide WHICH rows. Turning a page or changing
// the sort shows the same rows in a different order; re-asking for the
// same summary would be a wasted round trip.
watch(
  () => [slug.value, state.value.file ?? '', state.value.q ?? '', JSON.stringify(state.value.filter ?? [])].join('\u0000'),
  () => void refreshAnalysis(),
)

function showColumnList(): void {
  analysisMode.value = 'list'
  analysisColumn.value = null
  summary.value = null
  void refreshAnalysis()
}

function toggleSummaries(): void {
  summariesOpen.value = !summariesOpen.value
  columnsOpen.value = false
  schemaOpen.value = false
  if (summariesOpen.value) void refreshAnalysis()
}

/** Open one column — from the panel's list or a column header's menu. */
function summarizeColumn(name: string, mode: AnalysisMode = 'column'): void {
  summariesOpen.value = true
  filterColumn.value = null
  analysisMode.value = mode
  analysisColumn.value = name
  summary.value = null
  void refreshAnalysis()
  // P5-71: "Open a dataset's table" ticks when the table is actually used —
  // a summary or a group-by counts, the same as a filter or a sort.
  completeFirstRunStep('data')
}

/** Which chart the summary panel is showing (P5-54). Null until the reader
 *  picks one — the panel's own default is used until then, and a saved view
 *  sets it. */
const chartKind = ref<ChartKind | null>(null)

// --- Row drawer -------------------------------------------------------------------------------

const openRow = ref<DatasetRow | null>(null)

function showRow(row: DatasetRow): void {
  openRow.value = row
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    openRow.value = null
    filterColumn.value = null
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (searchTimer) clearTimeout(searchTimer)
})

// --- File + paging ------------------------------------------------------------------------------

function changeFile(event: Event): void {
  const file = (event.target as HTMLSelectElement).value
  hidden.value = new Set()
  // Another file has other columns — the open summary is about to be a
  // question nobody asked, so go back to the list.
  showColumnList()
  replaceState(file ? { file } : {})
}

function goPage(next: number): void {
  const clamped = Math.min(Math.max(1, next), pageCount.value)
  patchState({ page: clamped > 1 ? clamped : undefined }, true)
}

function changeLimit(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  patchState({ limit: value === ROWS_LIMIT_DEFAULT ? undefined : value })
}

const PAGE_SIZES = [25, 50, 100, 200]

// --- County context (P5-48) -----------------------------------------------------------
// `layers` is deliberately NOT a table key: it changes what the table shows
// without changing what the server is asked for, and `replaceState` preserves
// it through every search, sort and page turn.

const contextOpen = ref(false)
/** layer id → that layer's county values. Filled one layer at a time. */
const contextData = ref<Map<string, CountyValues>>(new Map())
const contextLoading = ref(false)
const contextError = ref('')
/** A joined column is sorted in the browser (see sortContext below), by its
 *  own id — a layer's, or a derived column's (P7-2). */
const contextSort = ref<{ columnId: string; dir: SortDirection } | null>(null)

const contextIds = computed(() => parseContextLayers(route.query.layers as string | string[] | undefined))

/**
 * The joined columns, in the order they were chosen: the chosen county layers
 * first, then whatever the host joined on (P7-2's derived columns).
 *
 * `values` is undefined until that layer has finished loading — the cells read
 * "—" until then. Nothing is joined to a file with no county key: switching to
 * such a file puts the columns away rather than showing a wall of dashes, and
 * that applies to a derived column too, because it is keyed by GEOID like
 * every other one.
 */
const contextColumns = computed<JoinedColumn[]>(() =>
  geoIdColumn.value
    ? [
        ...contextIds.value.map(id => ({ id, name: contextLayerName(id), values: contextData.value.get(id) })),
        ...(props.extraColumns ?? []),
      ]
    : [],
)

/** The values behind one joined column, whichever kind made it. The single
 *  lookup the sort, the cells and the row drawer all go through, so a derived
 *  column cannot end up sortable-but-unprintable or the other way round. */
function columnValuesFor(columnId: string): CountyValues | undefined {
  return contextColumns.value.find(column => column.id === columnId)?.values
}

let contextRequest = 0
/** Load whatever is selected but not loaded yet — one layer at a time, so
 *  choosing three does not start three CSV downloads at once. */
async function loadContext(): Promise<void> {
  // No county key, nothing to join to — and no reason to download a CSV.
  if (!geoIdColumn.value) return
  const missing = contextIds.value.filter(id => !contextData.value.has(id))
  if (missing.length === 0) return
  const id = ++contextRequest
  contextLoading.value = true
  contextError.value = ''
  try {
    for (const layerId of missing) {
      const values = await loadContextValues(layerId)
      if (id !== contextRequest) return
      // A new Map so the computed columns see the change.
      contextData.value = new Map(contextData.value).set(layerId, values)
    }
  } catch {
    if (id !== contextRequest) return
    contextError.value = 'Those county numbers could not be loaded. Try adding the layer again.'
  } finally {
    if (id === contextRequest) contextLoading.value = false
  }
}

// Both halves matter: the selection, and whether this file has a county key
// at all (which is only known once the first page of rows has arrived).
watch(() => [geoIdColumn.value ?? '', contextIds.value.join(',')].join('|'), () => void loadContext(), { immediate: true })

function setContextLayers(ids: string[]): void {
  const query: Record<string, string> = {}
  for (const [k, v] of Object.entries(route.query)) if (typeof v === 'string') query[k] = v
  const param = contextLayersParam(ids)
  if (param) query.layers = param
  else delete query.layers
  // A column that is going away cannot go on ordering the table.
  if (contextSort.value && !ids.includes(contextSort.value.columnId)) contextSort.value = null
  void router.replace({ query })
}

function toggleContext(): void {
  contextOpen.value = !contextOpen.value
  columnsOpen.value = false
  schemaOpen.value = false
}

/** The rows as drawn. A joined column is sorted here rather than in the URL
 *  because the server has never heard of it: this reorders the page you are
 *  looking at, and the pager still walks the server's order. */
const shownRows = computed(() =>
  contextSort.value
    ? sortRowsByContext(rows.value, geoIdColumn.value, columnValuesFor(contextSort.value.columnId), contextSort.value.dir)
    : rows.value,
)

// --- Show on map, in place (P6-14) ------------------------------------------
// "Show on map" used to be a link to `/?layers=internal-<slug>`, which drew
// the whole layer and took this page — the search, the filters, the sort, the
// page you were on — with it. A pane keeps all of that and, for a county
// layer, draws the rows that are actually on screen: `query.only` is the one
// thing the URL grammar cannot express.

/**
 * The GEOIDs of the rows on screen. Empty when this file has no county key
 * column (`geoIdColumn` is discovered from the data, not declared) or when a
 * row's value is not a GEOID — those rows simply are not counties, and the
 * map says nothing about them.
 */
const shownGeoIds = computed<string[]>(() => {
  const column = geoIdColumn.value
  if (!column) return []
  const ids: string[] = []
  for (const row of shownRows.value) {
    const geoId = rowGeoId(row, column)
    if (geoId) ids.push(geoId)
  }
  return ids
})

const map = useShowOnMap({
  layers: () => (schema.value?.layer ? [schema.value.layer.id] : []),
  /**
   * A county layer's rows **are** counties, so the rows on screen are the
   * answer. A point layer's are not: `only` dims county polygons, and the
   * dots — which are the rows — would stay unfiltered behind the dimming,
   * which would read as "these are your rows" while showing all of them. So
   * a point layer draws its whole overlay and the pane's note says so.
   */
  only: () => (schema.value?.layer?.geometry === 'county' ? shownGeoIds.value : null),
})

/**
 * Whether THIS page offers a map at all.
 *
 * Two conditions, and the second is P7-2's: the dataset has to power a layer,
 * and the host must not already be providing a map. `/views/:slug` has a Map
 * interface over the whole working set — every layer in it, narrowed to these
 * rows — so a second "Show on map" inside the table would be a worse answer to
 * a question already answered better one element up.
 */
const offersMap = computed(() => !!schema.value?.layer && !props.hostMap)

/**
 * Whether the subset is still arriving.
 *
 * `loadingSchema` starts true, so the first thing a host hears is "not settled
 * yet" rather than an empty answer that looks like a real one. The third term
 * closes the gap between the two loaders: the schema's `finally` runs before
 * `loadRows` sets its own flag, and in that tick neither is loading and there
 * are still no rows. A schema that FAILED settles immediately — no rows are
 * coming, and a host must not wait forever for them.
 */
const settling = computed(() => loadingSchema.value || loadingRows.value || (!!schema.value && !rowsSettled.value))

/**
 * P7-2: hand the host what this table is showing.
 *
 * The same `shownGeoIds` the in-page pane uses, so a host's map and this page's
 * own pane are driven by one computation over one set of rows — the table is
 * fetched once however many interfaces are reading it.
 */
watch(
  [shownGeoIds, total, settling],
  () =>
    emit('shown', {
      geoIds: shownGeoIds.value,
      rows: shownRows.value.length,
      total: total.value,
      loading: settling.value,
    }),
  { immediate: true },
)

/** The layer this dataset powers, by name. `activeName` would say "BLO
 *  Livability Index" for a point layer, because a point overlay is not part
 *  of the scoring query — true of the choropleth under it, and not what this
 *  page means by "show on map". */
const paneTitle = computed(() => schema.value?.layer?.name ?? '')

/** What the pane is framed on — the fidelity claim, said out loud, because
 *  for a point layer it is "not narrowed" and the reader should know. */
const paneNote = computed(() => {
  const layer = schema.value?.layer
  if (!layer) return ''
  // P7-9: every geometry drawn from its own features says so. This read
  // `=== 'point'`, so a line layer and then a state layer fell through to
  // counting GEOIDs and claimed "No counties in these rows" — true, and not
  // the fidelity claim the reader needs.
  if (layer.geometry === 'point') return 'Every point in this layer'
  if (layer.geometry === 'line') return 'Every line in this layer'
  if (layer.geometry === 'state') return 'Every state in this layer'
  const shown = shownGeoIds.value.length
  if (!shown) return 'No counties in these rows'
  return `${shown.toLocaleString()} of ${total.value.toLocaleString()} rows`
})

function sortContext(columnId: string): void {
  const current = contextSort.value
  if (!current || current.columnId !== columnId) contextSort.value = { columnId, dir: 'asc' }
  else if (current.dir === 'asc') contextSort.value = { columnId, dir: 'desc' }
  else contextSort.value = null
}

function contextAriaSort(columnId: string): 'ascending' | 'descending' | 'none' {
  if (contextSort.value?.columnId !== columnId) return 'none'
  return contextSort.value.dir === 'desc' ? 'descending' : 'ascending'
}

function contextCellFor(row: DatasetRow, columnId: string): string {
  return contextCell(columnValuesFor(columnId), rowGeoId(row, geoIdColumn.value))
}

/** The page as a file, joined columns included. The server export cannot
 *  write columns it does not know about, so this one is built here from
 *  exactly what is on screen. */
function downloadWithContext(): void {
  if (typeof URL.createObjectURL !== 'function') return
  const csv = tableCsv(
    shownRows.value,
    visibleColumns.value.map(c => c.name),
    geoIdColumn.value,
    contextColumns.value,
  )
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${slug.value}-with-county-context.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// --- Saved table views (P5-54) -----------------------------------------------

const saveOpen = ref(false)
const saveName = ref('')
const saving = ref(false)
const saveError = ref('')
/** The view just saved, so the reader can open it (or embed it) immediately. */
const savedNote = ref<{ slug: string; name: string; url: string } | null>(null)
/** Every saved view of THIS table — the strip under the toolbar. */
const savedViews = ref<SavedViewSummary[]>([])
/** Set when this page was opened from a saved view (`?view=<slug>`).
 *  `query` is the saved query in canonical form, so the note can tell "this
 *  is that view" from "you have since changed the filters". */
const openedView = ref<{ name: string; savedRowCount: number; query: string } | null>(null)
/** A view's non-URL state (visible columns, open summary), held until the
 *  schema arrives — column names cannot be hidden before they are known. */
const pendingViewState = ref<SavedTableViewState | null>(null)

const viewSlug = computed(() => {
  const raw = route.query.view
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value ? value : ''
})

/** Which rows a state selects, as one comparable string. Paging and page
 *  size are left out: they change what is on screen, not what matches. */
function selectionKey(rows: RowsState): string {
  const { page, limit, ...selection } = rows
  void page
  void limit
  return JSON.stringify(rowsStateToQuery(selection))
}

/** "saved with 13 rows, now 15" — the whole point of a recipe: the data
 *  moved. Silent while the rows are still loading; honest about it once the
 *  reader has changed the query themselves. */
const staleNote = computed(() => {
  if (!openedView.value || loadingRows.value) return ''
  const { name, savedRowCount, query } = openedView.value
  if (query !== selectionKey(state.value)) return `Saved view: ${name} · you have changed the filters since`
  const now = total.value
  return savedRowCount === now
    ? `Saved view: ${name}`
    : `Saved view: ${name} · saved with ${savedRowCount.toLocaleString()} rows, now ${now.toLocaleString()}`
})

function openSave(): void {
  saveOpen.value = true
  saveError.value = ''
  savedNote.value = null
  saveName.value = ''
}

/** The summary the panel is showing, in the shape a view stores. */
function summaryForSave(): SavedSummary | undefined {
  if (!summariesOpen.value || !analysisColumn.value) return undefined
  if (analysisMode.value === 'group') return { groupBy: analysisColumn.value }
  if (analysisMode.value !== 'column') return undefined
  // The panel picks a default chart when the reader has not; a saved view
  // has to name the one that is actually on screen.
  const chart = chartKind.value ?? chartKindsFor(summary.value)[0] ?? 'bars'
  return { column: analysisColumn.value, chart }
}

/** Exactly what is on screen, as a saved-view state. */
function currentViewState(): SavedTableViewState {
  const summaryState = summaryForSave()
  return {
    dataset: slug.value,
    ...(state.value.file ? { file: state.value.file } : {}),
    ...(state.value.q ? { q: state.value.q } : {}),
    filters: filters.value.map(f => ({ ...f })),
    ...(state.value.sort ? { sort: state.value.sort } : {}),
    ...(state.value.sort && state.value.dir ? { dir: state.value.dir } : {}),
    // Only worth storing when the reader actually hid something; otherwise
    // "all columns" should follow the file if it gains one.
    ...(hidden.value.size ? { columns: visibleColumns.value.map(c => c.name) } : {}),
    // Only the chosen LAYERS. A derived column is the working SET's and is
    // never written into a view's state — that is the §F.1 line this whole
    // phase turns on (P7-2).
    ...(contextIds.value.length ? { layers: contextIds.value } : {}),
    ...(summaryState ? { summary: summaryState } : {}),
    savedRowCount: total.value,
  }
}

async function loadSavedViews(): Promise<void> {
  try {
    savedViews.value = await fetchViews({ dataset: slug.value })
  } catch {
    // The strip is a convenience; a table must not fail to load without it.
    savedViews.value = []
  }
}

async function submitSave(): Promise<void> {
  const name = saveName.value.trim()
  if (!name || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const viewState = currentViewState()
    const saved = await saveView({ name, type: 'table', state: viewState })
    savedNote.value = { slug: saved.slug, name: saved.name, url: tableViewUrl(viewState, saved.slug) }
    saveOpen.value = false
    saveName.value = ''
    await loadSavedViews()
  } catch (err: unknown) {
    saveError.value = err instanceof Error ? err.message : "Couldn't save this view."
  } finally {
    saving.value = false
  }
}

/** Apply the parts of a saved view the URL does not carry. Runs once the
 *  schema is in — before that there are no column names to hide. */
function applyPendingView(): void {
  const saved = pendingViewState.value
  if (!saved || !schema.value) return
  pendingViewState.value = null
  if (saved.columns?.length) {
    hidden.value = new Set(schema.value.columns.map(c => c.name).filter(name => !saved.columns!.includes(name)))
  }
  if (saved.summary && 'groupBy' in saved.summary) {
    summarizeColumn(saved.summary.groupBy, 'group')
  } else if (saved.summary) {
    chartKind.value = saved.summary.chart
    summarizeColumn(saved.summary.column, 'column')
  }
}

/** Read the view named in `?view=`: its name and the row count it was saved
 *  with, plus the panel state to restore. A view that has been deleted (or
 *  points at another dataset) is simply ignored — the URL still describes a
 *  perfectly good table. */
async function loadOpenedView(): Promise<void> {
  if (!viewSlug.value) {
    openedView.value = null
    pendingViewState.value = null
    return
  }
  try {
    const view = await fetchView(viewSlug.value)
    const saved = view ? tableStateOf(view) : null
    if (!view || !saved || saved.dataset !== slug.value) {
      openedView.value = null
      return
    }
    openedView.value = {
      name: view.name,
      savedRowCount: saved.savedRowCount,
      query: selectionKey({
        ...(saved.file ? { file: saved.file } : {}),
        ...(saved.q ? { q: saved.q } : {}),
        ...(saved.sort ? { sort: saved.sort } : {}),
        ...(saved.dir ? { dir: saved.dir } : {}),
        ...(saved.filters.length ? { filter: saved.filters } : {}),
      }),
    }
    pendingViewState.value = saved
    applyPendingView()
  } catch {
    openedView.value = null
  }
}

watch(
  () => [slug.value, viewSlug.value].join('|'),
  () => void loadOpenedView(),
  { immediate: true },
)
// The schema is what makes column names (and so the saved column choice)
// meaningful; it also tells the strip which dataset to ask about.
watch(
  () => schema.value?.entry.slug ?? '',
  entrySlug => {
    if (!entrySlug) return
    applyPendingView()
    void loadSavedViews()
  },
  { immediate: true },
)

// --- Phone layout (P5-60) --------------------------------------------------------------
// Everything about how this page LOOKS on a phone is in the media queries at
// the bottom of this file. Script only has to know the one thing CSS cannot
// say: that the drawer, the county-context picker and the save form are
// bottom sheets down there, so the table behind them must hold still. On a
// desktop they are a side drawer and inline panels, where locking the page
// would be a bug — hence the media query rather than an "is anything open".

const isPhone = usePhoneLayout()
const sheetOpen = computed(() => isPhone.value && (!!openRow.value || contextOpen.value || saveOpen.value))
useBodyScrollLock(sheetOpen)

/** The column a record is named by: the map layer's label when there is one,
 *  otherwise the first column — which is what the table shows first anyway. */
const labelColumn = computed(() => schema.value?.layer?.labelKey || schema.value?.columns[0]?.name || '')

/** "Open record" — the table narrowed to this one row, the same shareable
 *  record address P5-36 put on the map popups and the entity rail. */
function recordHref(row: DatasetRow): string | null {
  const label = labelColumn.value ? cellOf(row, labelColumn.value).trim() : ''
  return label ? recordUrl(slug.value, label) : null
}
</script>

<template>
  <div class="dataset-view" :class="{ embedded: props.embedded }">
    <header class="dataset-header">
      <RouterLink v-if="!props.embedded" :to="`/library/${slug}`" class="back-link">← Entry</RouterLink>

      <p v-if="loadingSchema" class="state-note">Loading dataset…</p>
      <p v-else-if="!schema" class="state-note error" data-testid="dataset-error">
        <template v-if="errorStatus === 404">No dataset named “{{ slug }}”.</template>
        <template v-else>{{ error }}</template>
      </p>

      <template v-else>
        <div class="title-row">
          <h1 v-if="!props.embedded">{{ schema.entry.title }}</h1>
          <span class="badge">{{ schema.file }}</span>
          <span class="count" data-testid="row-count">{{ schema.rowCount.toLocaleString() }} rows · {{ schema.columns.length }} columns</span>
          <!-- Wide enough for a map beside the table: open one here rather
               than navigating to `/` and losing the filter, the sort and the
               page you are on (P6-14). Narrower than that, the deep link
               stands — it is still how this view is shared. -->
          <button
            v-if="offersMap && map.canOpen.value"
            type="button"
            class="map-link map-open"
            data-testid="show-on-map-open"
            :aria-expanded="map.isOpen.value"
            @click="map.toggle()"
          >Show on map →</button>
          <RouterLink
            v-else-if="offersMap"
            :to="mapUrlForLayers([schema!.layer!.id])"
            class="map-link"
            data-testid="show-on-map"
          >
            Show on map →
          </RouterLink>
        </div>

        <!-- P5-41: a plain-English question about THIS dataset. -->
        <AskBox class="dataset-ask" :dataset="slug" placeholder="Ask about this data…" />

        <!-- The one line that says what you are looking at right now. -->
        <p class="overview-strip" data-testid="overview-strip">{{ overviewLine }}</p>

        <!-- P5-54: opened from a saved view — and whether the data has moved. -->
        <p v-if="staleNote" class="saved-view-banner" data-testid="saved-view-banner">{{ staleNote }}</p>

        <!-- P5-60: two rows on a phone — what you are looking at (search and
             file), then the actions as one horizontal strip you can swipe. -->
        <div class="toolbar">
          <div class="toolbar-find">
            <input
              v-model="searchText"
              type="search"
              class="search-input"
              placeholder="Search all columns…"
              aria-label="Search rows"
            />
            <label v-if="schema.files.length > 1" class="file-pick">
              File
              <select :value="schema.file" aria-label="Choose file" @change="changeFile">
                <option v-for="f in schema.files" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
          </div>
          <div class="toolbar-actions strip" data-testid="toolbar-actions">
            <button type="button" class="tool-btn touch-target" :aria-expanded="summariesOpen" data-testid="summaries-toggle" @click="toggleSummaries">
              Summaries
            </button>
            <button type="button" class="tool-btn touch-target" :aria-expanded="columnsOpen" @click="columnsOpen = !columnsOpen; schemaOpen = false">
              Columns{{ hidden.size ? ` (${hidden.size} hidden)` : '' }}
            </button>
            <button type="button" class="tool-btn touch-target" :aria-expanded="schemaOpen" @click="schemaOpen = !schemaOpen; columnsOpen = false">
              Schema
            </button>
            <button
              v-if="geoIdColumn"
              type="button"
              class="tool-btn touch-target"
              :aria-expanded="contextOpen"
              data-testid="county-context-toggle"
              @click="toggleContext"
            >
              Add county context{{ contextIds.length ? ` (${contextIds.length})` : '' }}
            </button>
            <!-- A plain link: the session cookie rides along on the navigation
                 and the server answers with an attachment (as file downloads do). -->
            <a class="tool-btn touch-target download-link" :href="exportUrl" download data-testid="export-csv">Download filtered CSV</a>
            <!-- The server export cannot write the joined columns, so this page
                 builds its own file when there are any. -->
            <button
              v-if="contextColumns.length"
              type="button"
              class="tool-btn touch-target"
              data-testid="context-csv"
              @click="downloadWithContext"
            >
              Download this page with county context
            </button>
            <!-- P5-54: keep this table — filters, sort, columns, chart and all. -->
            <button type="button" class="tool-btn touch-target" data-testid="save-view-btn" @click="openSave">Save view</button>
            <button v-if="hasQuery" type="button" class="tool-btn touch-target clear" @click="clearAll">Clear all</button>
          </div>
        </div>

        <!-- Naming a view is a bottom sheet on a phone (see the media query):
             a two-field form squeezed into a 375 px toolbar is unusable. -->
        <form v-if="saveOpen" class="save-view-form sheet" data-testid="save-view-form" @submit.prevent="submitSave">
          <span class="sheet-handle" aria-hidden="true"></span>
          <span class="sheet-title">Save view</span>
          <input
            v-model="saveName"
            type="text"
            class="save-view-name"
            placeholder="Name this view"
            aria-label="Name this view"
            maxlength="80"
            :disabled="saving"
          />
          <button type="submit" class="tool-btn touch-target" :disabled="saving || !saveName.trim()">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <button type="button" class="tool-btn touch-target" data-testid="save-view-cancel" :disabled="saving" @click="saveOpen = false">
            Cancel
          </button>
        </form>
        <p v-if="saveError" class="state-note error" data-testid="save-view-error">{{ saveError }}</p>
        <p v-if="savedNote" class="saved-view-note" data-testid="save-view-note">
          Saved —
          <RouterLink :to="savedNote.url">open “{{ savedNote.name }}”</RouterLink>
          · embed it in a page with <code>view:{{ savedNote.slug }}</code>
        </p>

        <!-- Every saved view of this table, so one is always a click away. -->
        <p v-if="savedViews.length" class="saved-views-strip" data-testid="saved-views-strip">
          <span class="strip-label">Saved views of this table:</span>
          <RouterLink
            v-for="v in savedViews"
            :key="v.slug"
            :to="`/views/${v.slug}`"
            class="strip-link"
            :title="v.description"
          >
            {{ v.name }}
          </RouterLink>
        </p>

        <!-- The picker draws its own card (and, on a phone, its own bottom
             sheet), so it only needs the spacing the other panels have. -->
        <CountyContextPicker
          v-if="contextOpen"
          class="context-host"
          :selected="contextIds"
          @update:selected="setContextLayers"
          @close="contextOpen = false"
        />
        <p v-if="contextLoading" class="state-note" data-testid="context-loading">Loading county numbers…</p>
        <p v-else-if="contextError" class="state-note error" data-testid="context-error">{{ contextError }}</p>

        <div v-if="columnsOpen" class="panel columns-panel" data-testid="columns-panel">
          <label v-for="c in schema.columns" :key="c.name" class="column-toggle">
            <input type="checkbox" :checked="!hidden.has(c.name)" @change="toggleColumn(c.name)" />
            {{ c.name }}
          </label>
        </div>

        <div v-if="schemaOpen" class="panel schema-panel" data-testid="schema-panel">
          <div v-for="c in schema.columns" :key="c.name" class="schema-row">
            <span class="schema-name">{{ c.name }}</span>
            <span class="schema-desc">{{ describeColumn(c, schema.rowCount) }}</span>
            <span v-if="c.topValues?.length" class="schema-top">
              <button
                v-for="tv in c.topValues"
                :key="tv.value"
                type="button"
                class="top-value"
                :title="`Filter ${c.name} = ${tv.value}`"
                @click="filterByValue(c.name, tv.value)"
              >
                {{ tv.value }} <em>{{ tv.count }}</em>
              </button>
            </span>
          </div>
        </div>

        <div v-if="filters.length" class="chips" data-testid="filter-chips">
          <span v-for="(f, i) in filters" :key="`${f.column}-${i}`" class="chip">
            <strong>{{ f.column }}</strong> {{ OP_LABEL[f.op] }} <span v-if="f.value !== undefined">“{{ f.value }}”</span>
            <button type="button" class="chip-x" :aria-label="`Remove filter on ${f.column}`" @click="removeFilter(i)">×</button>
          </span>
        </div>
      </template>
    </header>

    <div v-if="schema" class="work-area">
      <div class="table-area">
        <p v-if="error" class="state-note error" data-testid="rows-error">{{ error }}</p>
        <div class="table-scroll" :class="{ busy: loadingRows }">
          <table class="data-table">
            <thead>
              <tr>
                <th
                  v-for="c in visibleColumns"
                  :key="c.name"
                  :aria-sort="ariaSort(c.name)"
                  :class="{ sorted: state.sort === c.name, filtered: filters.some(f => f.column === c.name) }"
                >
                  <div class="th-inner">
                    <button type="button" class="sort-btn" :title="`Sort by ${c.name}`" @click="toggleSort(c.name)">
                      {{ c.name }}
                      <span v-if="state.sort === c.name" class="sort-arrow">{{ state.dir === 'desc' ? '↓' : '↑' }}</span>
                    </button>
                    <button
                      type="button"
                      class="filter-btn"
                      :aria-label="`Filter ${c.name}`"
                      :aria-expanded="filterColumn === c.name"
                      @click="openFilter(c.name)"
                    >
                      ⌄
                    </button>
                  </div>
                  <form v-if="filterColumn === c.name" class="filter-pop" data-testid="filter-pop" @submit.prevent="applyFilter">
                    <select v-model="filterOp" aria-label="Filter operator">
                      <option v-for="op in FILTER_OPS" :key="op" :value="op">{{ OP_LABEL[op] }}</option>
                    </select>
                    <input
                      v-if="filterOp !== 'empty' && filterOp !== 'notEmpty'"
                      v-model="filterValue"
                      type="text"
                      aria-label="Filter value"
                      placeholder="value"
                    />
                    <button type="submit" class="apply-btn">Apply</button>
                    <span class="pop-actions">
                      <button type="button" class="pop-link" data-testid="summarize-column" @click="summarizeColumn(c.name)">
                        Summarize
                      </button>
                      <button type="button" class="pop-link" data-testid="group-by-column" @click="summarizeColumn(c.name, 'group')">
                        Group by
                      </button>
                    </span>
                  </form>
                </th>
                <th
                  v-for="c in contextColumns"
                  :key="c.id"
                  class="context-th"
                  :class="{ sorted: contextSort?.columnId === c.id }"
                  :aria-sort="contextAriaSort(c.id)"
                  data-testid="context-header"
                >
                  <div class="th-inner">
                    <button type="button" class="sort-btn" :title="`Sort by ${c.name}`" @click="sortContext(c.id)">
                      {{ c.name }}
                      <span v-if="contextSort?.columnId === c.id" class="sort-arrow">{{ contextSort.dir === 'desc' ? '↓' : '↑' }}</span>
                    </button>
                    <!-- Only a column the URL chose can be un-chosen here.
                         A working set's derived column is the SET's, not this
                         view's: taking it away would be an edit to what the
                         analysis is about, not to what this table shows, so
                         this offers no control that cannot do what it says
                         (P7-2). -->
                    <button
                      v-if="contextIds.includes(c.id)"
                      type="button"
                      class="filter-btn"
                      :aria-label="`Remove ${c.name}`"
                      @click="setContextLayers(contextIds.filter(id => id !== c.id))"
                    >
                      ×
                    </button>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loadingRows && rows.length === 0" v-for="n in 3" :key="`sk-${n}`" class="data-row data-row--skeleton" aria-hidden="true">
                <td v-for="c in visibleColumns" :key="c.name"><span class="sk-cell"></span></td>
              </tr>
              <tr v-for="row in shownRows" :key="row._row" class="data-row" tabindex="0" @click="showRow(row)" @keydown.enter="showRow(row)">
                <td v-for="c in visibleColumns" :key="c.name" :class="`type-${c.type}`" :title="cellOf(row, c.name)">
                  {{ cellOf(row, c.name) }}
                </td>
                <td v-for="c in contextColumns" :key="c.id" class="context-td" data-testid="context-cell">
                  {{ contextCellFor(row, c.id) }}
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!loadingRows && rows.length === 0 && !error" class="state-note empty" data-testid="empty-note">
            No rows match.
            <button v-if="hasQuery" type="button" class="link-btn" @click="clearAll">Clear filters</button>
          </p>
        </div>

        <footer class="pager">
          <span data-testid="showing">Showing {{ firstRow.toLocaleString() }}–{{ lastRow.toLocaleString() }} of {{ total.toLocaleString() }}</span>
          <label class="page-size">
            Rows per page
            <select :value="limit" aria-label="Rows per page" @change="changeLimit">
              <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
            </select>
          </label>
          <button type="button" class="tool-btn" :disabled="page <= 1" @click="goPage(page - 1)">← Prev</button>
          <span>Page {{ page }} of {{ pageCount }}</span>
          <button type="button" class="tool-btn" :disabled="page >= pageCount" @click="goPage(page + 1)">Next →</button>
        </footer>
      </div>

      <!-- Summaries: beside the table on a wide screen, under it on a phone. -->
      <aside v-if="summariesOpen && schema" class="analysis-panel" data-testid="summaries-panel" aria-label="Column summaries">
        <GroupBySummary
          v-if="analysisMode === 'group' && analysisColumn"
          :column="analysisColumn"
          :summary="summary"
          :loading="loadingAnalysis"
          :matched="matched"
          :slug="slug"
          :error="analysisError"
          @pick="value => filterByValue(analysisColumn!, value)"
          @back="showColumnList"
        />
        <ColumnSummaryPanel
          v-else-if="analysisMode === 'column' && analysisColumn"
          :column="analysisColumn"
          :summary="summary"
          :loading="loadingAnalysis"
          :matched="matched"
          :chart="chartKind"
          :slug="slug"
          :error="analysisError"
          @update:chart="kind => (chartKind = kind)"
          @pick="value => filterByValue(analysisColumn!, value)"
          @group-by="summarizeColumn(analysisColumn!, 'group')"
          @back="showColumnList"
        />
        <section v-else class="overview-list" data-testid="overview-list">
          <h3>Summaries</h3>
          <p class="panel-hint">Pick a column to see what is in it.</p>
          <p v-if="analysisError" class="state-note error" data-testid="overview-error">{{ analysisError }}</p>
          <div v-else-if="loadingAnalysis && !overview" class="overview-skeleton" data-testid="overview-skeleton" aria-hidden="true">
            <span v-for="n in 6" :key="n" class="sk-line"></span>
          </div>
          <ul v-else-if="overview" class="overview-rows">
            <li v-for="c in overview" :key="c.column">
              <button type="button" class="overview-row" @click="summarizeColumn(c.column)">
                <span class="ov-name">{{ c.column }}</span>
                <span class="ov-track"><span class="ov-fill" :style="{ width: `${c.filledPct}%` }"></span></span>
                <span class="ov-pct">{{ Math.round(c.filledPct) }}% filled</span>
              </button>
            </li>
          </ul>
        </section>
      </aside>

      <!-- The submap (P6-14). A third column in a row that already has two,
           so the table keeps its place: the route never changes, and closing
           the pane leaves the filter, the sort and the scroll untouched. -->
      <MapPane
        v-if="offersMap && map.isOpen.value"
        class="map-pane-col"
        testid="dataset-map-pane"
        :layers="map.state.layers"
        :query="map.state.query"
        :data="map.state.data"
        :fit="map.fit.value"
        :title="paneTitle"
        :note="paneNote"
        label="These rows on the map"
        @close="map.close()"
      />
    </div>

    <!-- One row, in full. A side drawer on a desktop; a bottom sheet on a
         phone (see the media query) — hence the handle, which only shows
         there, and the actions on a line of their own. -->
    <aside v-if="openRow && schema" class="row-drawer sheet" data-testid="row-drawer" aria-label="Row details">
      <span class="sheet-handle" aria-hidden="true"></span>
      <div class="drawer-head">
        <strong>Row {{ openRow._row + 1 }}</strong>
        <button type="button" class="tool-btn touch-target" aria-label="Close row details" data-testid="row-drawer-close" @click="openRow = null">
          Close
        </button>
      </div>
      <div class="drawer-actions strip" data-testid="row-drawer-actions">
        <RouterLink
          v-if="schema.layer?.geometry === 'point' && schema.layer.labelKey && cellOf(openRow, schema.layer.labelKey)"
          :to="mapUrlForLayers([schema.layer.id], { layerId: schema.layer.id, label: cellOf(openRow, schema.layer.labelKey) })"
          class="tool-btn touch-target"
          data-testid="row-show-on-map"
        >
          Show on map
        </RouterLink>
        <RouterLink
          v-if="recordHref(openRow)"
          :to="recordHref(openRow)!"
          class="tool-btn touch-target"
          data-testid="row-open-record"
        >
          Open record
        </RouterLink>
      </div>
      <dl class="drawer-fields">
        <template v-for="c in contextColumns" :key="c.id">
          <dt data-testid="drawer-context">{{ c.name }}</dt>
          <dd>{{ contextCellFor(openRow, c.id) }}</dd>
        </template>
        <template v-for="c in schema.columns" :key="c.name">
          <dt>{{ c.name }}</dt>
          <dd :class="{ muted: !cellOf(openRow, c.name) }">
            <a v-if="isHttpUrl(cellOf(openRow, c.name))" :href="cellOf(openRow, c.name).trim()" target="_blank" rel="noopener noreferrer">
              {{ cellOf(openRow, c.name) }}
            </a>
            <template v-else>{{ cellOf(openRow, c.name) || '—' }}</template>
          </dd>
        </template>
      </dl>
    </aside>
  </div>
</template>

<style scoped>
.context-th,
.context-td {
  background: var(--blo-cream, #f7f4ee);
}

.context-td {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dataset-view {
  flex-grow: 1;
  display: flex;
  flex-direction: column;
  padding: 24px 20px 48px;
  /* The table is 5,000 px wide and scrolls inside `.table-scroll`; these two
     stop that width from reaching the page and scrolling the whole document
     sideways (P5-60). Every flex ancestor up to the tab panel needs the same
     — see the note on `.entry-panel` in LibraryEntryView. */
  min-width: 0;
  max-width: 100%;
}

.dataset-view.embedded {
  padding: 8px 0 0;
  background-color: var(--blo-cream);
  position: relative;
}

.dataset-header {
  max-width: 1400px;
  width: 100%;
  min-width: 0;
  margin: 0 auto 12px;
}

.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: 14px;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

.title-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.title-row h1 {
  margin: 0;
  font-size: 24px;
  color: var(--blo-ink);
}

.badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--blo-cream-deep);
  color: var(--blo-stone);
}

.count {
  font-size: 13px;
  color: var(--blo-stone);
}

.map-link {
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.map-link:hover {
  text-decoration: underline;
}

.drawer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.drawer-actions:empty {
  display: none;
}

.drawer-actions a.tool-btn {
  text-decoration: none;
  color: var(--blo-green-deep);
}

.context-host {
  display: block;
  margin-top: 10px;
}

.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 14px;
  min-width: 0;
}

/* On a wide screen the two groups wrap into one row, exactly as the flat
   toolbar did; on a phone they become the two rows the ticket asks for. */
.toolbar-find {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 260px;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

/* Sheet furniture: invisible until the media query turns a panel into a
   bottom sheet, so the desktop drawer and form look exactly as before. */
.sheet-handle,
.sheet-title {
  display: none;
}

.search-input {
  flex: 1 1 260px;
  padding: 8px 12px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  font-size: 14px;
  background: #fff;
}

.file-pick,
.page-size {
  font-size: 13px;
  color: var(--blo-stone);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tool-btn {
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.tool-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.tool-btn.clear {
  color: var(--blo-orange-deep);
}

.panel {
  margin-top: 10px;
  padding: 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  font-size: 13px;
}

.columns-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}

.column-toggle {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.schema-row {
  display: grid;
  grid-template-columns: minmax(140px, 220px) minmax(180px, 1fr) 2fr;
  gap: 10px;
  padding: 5px 0;
  border-bottom: 1px solid var(--blo-cream);
  align-items: baseline;
}

.schema-name {
  font-weight: 600;
}

.schema-desc {
  color: var(--blo-stone);
}

.schema-top {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.top-value {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--blo-cream-divider);
  background: var(--blo-cream);
  cursor: pointer;
}

.top-value em {
  font-style: normal;
  color: var(--blo-stone-soft);
  margin-left: 4px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 12px;
  background: var(--blo-green-soft);
  border-radius: 999px;
}

.chip-x {
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  color: var(--blo-stone);
}

.dataset-ask {
  max-width: 560px;
  margin-top: 12px;
}

.overview-strip {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone);
}

/* Saved table views (P5-54) */
.saved-view-banner {
  margin: 8px 0 0;
  padding: 6px 10px;
  border-left: 3px solid var(--blo-green-deep);
  background: var(--blo-green-soft);
  border-radius: 0 4px 4px 0;
  font-size: 13px;
  color: var(--blo-ink);
}

.save-view-form {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
}

.save-view-name {
  flex: 1 1 220px;
  max-width: 320px;
  padding: 7px 10px;
  font: inherit;
  font-size: 14px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.saved-view-note {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--blo-ink);
}

.saved-view-note code {
  background: var(--blo-cream-deep);
  border-radius: 3px;
  padding: 1px 5px;
}

.saved-views-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 10px 0 0;
  font-size: 13px;
}

.strip-label {
  color: var(--blo-stone);
}

.strip-link {
  color: var(--blo-green-deep);
}

.download-link {
  text-decoration: none;
  line-height: normal;
}

.pop-actions {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin-left: 4px;
}

.pop-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--blo-green-deep);
  cursor: pointer;
  white-space: nowrap;
}

.pop-link:hover {
  text-decoration: underline;
}

.work-area {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  max-width: 1400px;
  width: 100%;
  min-width: 0;
  margin: 0 auto;
}

.table-area {
  flex: 1 1 auto;
  min-width: 0;
}

/* The submap (P6-14). A column beside the table, which has its own
   scrollbar — the two never fight over one. */
.map-pane-col {
  flex: 0 0 26rem;
  align-self: flex-start;
  height: calc(100vh - 220px);
  min-height: 24rem;
}

/* Below the pane's breakpoint there is no pane: `useMapPane` will not open
   one and closes any that is open, and this is the belt to that braces. */
@media (max-width: 1023px) {
  .map-pane-col {
    display: none;
  }
}

/* A button that behaves like the link it replaced. */
.map-open {
  padding: 0;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  background: none;
  border: 0;
  cursor: pointer;
}

.analysis-panel {
  flex: 0 0 320px;
  max-width: 320px;
  padding: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  max-height: calc(100vh - 260px);
  overflow-y: auto;
}

.overview-list h3 {
  margin: 0;
  font-size: 15px;
  color: var(--blo-ink);
}

.panel-hint {
  margin: 2px 0 10px;
  font-size: 12px;
  color: var(--blo-stone);
}

.overview-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.overview-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 56px auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: none;
  border-radius: 4px;
  background: none;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  color: var(--blo-ink);
}

.overview-row:hover,
.overview-row:focus-visible {
  background: var(--blo-green-soft);
  outline: none;
}

.ov-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.ov-track {
  height: 8px;
  border-radius: 999px;
  background: var(--blo-cream-deep);
  overflow: hidden;
}

.ov-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--blo-green-deep);
}

.ov-pct {
  color: var(--blo-stone);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.overview-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.overview-skeleton .sk-line {
  height: 12px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--blo-cream-deep) 25%, #fff 50%, var(--blo-cream-deep) 75%);
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s infinite;
}

.table-scroll {
  /* The one place the table's real width is allowed to exist. `max-width`
     is what makes the clipping hold when an ancestor is a flex item. */
  overflow-x: auto;
  overflow-y: auto;
  max-width: 100%;
  max-height: calc(100vh - 300px);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.table-scroll.busy {
  opacity: 0.6;
}

.data-table {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  min-width: 100%;
  font-size: 13px;
}

.data-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--blo-cream-deep);
  text-align: left;
  padding: 0;
  border-bottom: 1px solid var(--blo-cream-divider);
  vertical-align: top;
}

.th-inner {
  display: flex;
  align-items: stretch;
  gap: 2px;
  /* The padding moved onto the controls so that tapping anywhere in the
     header cell sorts it (P5-60) rather than only the few pixels of text. */
  padding: 0;
}

.sort-btn {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  padding: 6px 8px;
  border: none;
  background: none;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  text-align: left;
  color: var(--blo-ink);
}

.sort-arrow {
  margin-left: 4px;
  color: var(--blo-green-deep);
}

.filter-btn {
  flex: 0 0 auto;
  padding: 6px 8px;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--blo-stone-soft);
  font-size: 13px;
  line-height: 1;
}

th.filtered .filter-btn {
  color: var(--blo-green-deep);
  font-weight: 700;
}

.filter-pop {
  display: flex;
  gap: 4px;
  padding: 6px 8px 8px;
  font-weight: 400;
}

.filter-pop select,
.filter-pop input {
  font-size: 12px;
  padding: 3px 4px;
}

.filter-pop input {
  width: 120px;
}

.apply-btn {
  font-size: 12px;
  padding: 3px 8px;
  background: var(--blo-ink);
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.data-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--blo-cream);
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: top;
}

td.type-number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.data-row--skeleton {
  cursor: default;
}

.sk-cell {
  display: block;
  height: 12px;
  width: 70%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--blo-cream-deep) 25%, #fff 50%, var(--blo-cream-deep) 75%);
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s infinite;
}

@keyframes sk-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.data-row {
  cursor: pointer;
}

.data-row:hover,
.data-row:focus {
  background: var(--blo-green-soft);
  outline: none;
}

.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
  font-size: 13px;
  color: var(--blo-stone);
}

.state-note {
  margin: 12px 0;
  font-size: 14px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b71c1c;
}

.state-note.empty {
  padding: 24px;
  text-align: center;
}

.link-btn {
  border: none;
  background: none;
  color: var(--blo-green-deep);
  cursor: pointer;
  font: inherit;
  text-decoration: underline;
}

.row-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(480px, 92vw);
  background: #fff;
  border-left: 1px solid var(--blo-cream-divider);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.08);
  padding: 20px;
  overflow-y: auto;
  z-index: 20;
}

.drawer-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.drawer-fields {
  margin: 0;
  font-size: 13px;
}

.drawer-fields dt {
  font-weight: 600;
  color: var(--blo-stone);
  margin-top: 10px;
}

.drawer-fields dd {
  margin: 2px 0 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--blo-ink);
}

.drawer-fields dd.muted {
  color: var(--blo-stone-soft);
}

.drawer-fields a {
  color: var(--blo-green-deep);
}

/* Narrow enough that a 320px panel would squeeze the table: stack it
   underneath instead, full width, with the bars still readable. */
@media (max-width: 960px) {
  .work-area {
    flex-direction: column;
    /* Stretch, not flex-start: with flex-start each stacked child shrink-wraps
       to its content, so the table area became as wide as the table (4,721 px
       at 375) and the page scrolled sideways instead of the wrapper. */
    align-items: stretch;
  }

  .table-area {
    width: 100%;
    max-width: 100%;
  }

  .analysis-panel {
    flex: 1 1 auto;
    max-width: none;
    width: 100%;
    max-height: none;
  }
}

@media (max-width: 720px) {
  .dataset-view {
    padding: 16px 10px 32px;
  }

  .schema-row {
    grid-template-columns: 1fr;
  }

  .table-scroll {
    max-height: 60vh;
  }
}

/* --- Phone (P5-60) ---------------------------------------------------------
   The explorer at 375 px: the toolbar becomes a counts line and a swipeable
   strip of 44 px buttons, the table scrolls inside its own box with the
   first column pinned, and the three panels that were popovers become
   bottom sheets. Body text is 14 px throughout; only the file badge stays
   smaller, which the ticket allows for badges. */
@media (max-width: 640px) {
  .dataset-view {
    padding: 14px 10px 28px;
  }

  .title-row h1 {
    font-size: clamp(20px, 6vw, 24px);
    overflow-wrap: anywhere;
  }

  .count,
  .overview-strip,
  .saved-view-banner,
  .saved-view-note,
  .saved-views-strip,
  .map-link,
  .pager,
  .panel,
  .state-note {
    font-size: 14px;
  }

  /* Two rows: what you are looking at, then what you can do about it. */
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .toolbar-find {
    flex: 1 1 auto;
  }

  .search-input {
    flex: 1 1 auto;
    min-height: 44px;
  }

  /* One line that scrolls sideways rather than four rows of wrapped pills. */
  .toolbar-actions {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 2px;
  }

  .toolbar-actions::-webkit-scrollbar {
    display: none;
  }

  .toolbar-actions .tool-btn {
    flex: 0 0 auto;
  }

  .tool-btn,
  .touch-target {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  .file-pick,
  .page-size {
    font-size: 14px;
    min-height: 44px;
  }

  .file-pick select,
  .page-size select {
    min-height: 44px;
    font-size: 14px;
  }

  /* Chips and their × are tap targets too. */
  .chip {
    font-size: 14px;
    padding: 4px 4px 4px 10px;
  }

  .chip-x {
    min-width: 44px;
    min-height: 44px;
    font-size: 18px;
  }

  .saved-views-strip {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .strip-link {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  /* The table: readable cells, and the name column pinned so a sideways
     swipe never loses track of which row you are reading. */
  .table-scroll {
    max-height: 62svh;
  }

  .data-table {
    font-size: 14px;
  }

  .sort-btn,
  .filter-btn {
    min-height: 44px;
    font-size: 14px;
  }

  .filter-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
  }

  .data-table thead th:first-child {
    left: 0;
    z-index: 3;
  }

  .data-table tbody td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    /* Opaque, and tinted like a row header, so the scrolling cells pass
       behind it instead of showing through. */
    background: var(--blo-cream, #f7f4ee);
    box-shadow: 1px 0 0 var(--blo-cream-divider);
  }

  .data-table td {
    max-width: 60vw;
  }

  .filter-pop {
    flex-wrap: wrap;
  }

  .filter-pop select,
  .filter-pop input,
  .apply-btn,
  .pop-link {
    min-height: 44px;
    font-size: 14px;
  }

  .filter-pop input {
    width: auto;
    flex: 1 1 120px;
  }

  .analysis-panel {
    padding: 12px 10px;
    font-size: 14px;
  }

  .overview-row {
    min-height: 44px;
    font-size: 14px;
  }

  /* --- Bottom sheets ------------------------------------------------------
     The row drawer, the save form and the county-context picker all become
     the same thing down here: a panel pinned to the bottom edge with a
     handle, a safe-area gap for the home bar, and the page locked behind
     them (see `sheetOpen` in the script). */
  .sheet {
    position: fixed;
    top: auto;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-height: 85svh;
    overflow-y: auto;
    z-index: 30;
    border: none;
    border-top: 1px solid var(--blo-cream-divider);
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.16);
    padding: 8px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  }

  .sheet-handle {
    display: block;
    width: 36px;
    height: 4px;
    margin: 0 auto 10px;
    border-radius: 2px;
    background: var(--blo-cream-divider);
  }

  .sheet-title {
    display: block;
    margin-bottom: 8px;
    font-size: 15px;
    font-weight: 600;
    color: var(--blo-ink);
  }

  .row-drawer {
    background: #fff;
  }

  .drawer-head {
    align-items: center;
  }

  .drawer-actions {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .drawer-actions .tool-btn {
    flex: 0 0 auto;
  }

  .drawer-fields {
    font-size: 14px;
  }

  .save-view-form {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    background: #fff;
  }

  .save-view-name {
    max-width: none;
    min-height: 44px;
    font-size: 16px;
  }
}
</style>
