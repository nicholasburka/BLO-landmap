<script setup lang="ts">
/**
 * Two interfaces over one working set (P7-2, spec §F.1).
 *
 * Nick (2026-10-03): a working set *"can be mapped or explored in terms of data
 * (two interfaces to the same compound data object)"*. P7-1 built the object;
 * this is the surface, and the whole design is in which half owns what:
 *
 *  - **The working set is the data** — its members, its anchor, and the derived
 *    columns P7-5 computes onto it. Loaded ONCE, here.
 *  - **The view is the framing** — which is why this component takes a
 *    `SavedView` and reads the set off it, rather than the other way round. A
 *    set holds no viewport, no sort and no palette, so there is nothing to show
 *    it *with* until a view supplies one; a set may carry several views, and
 *    each of them lands here over the same rows.
 *  - **The interface is neither.** It is a query key, so switching is a
 *    `router.replace` on the path you are already on: nothing navigates,
 *    nothing unmounts that holds data, and nothing is fetched twice. A deep
 *    link to either interface opens there.
 *
 * **The data half is kept mounted behind `v-show`, deliberately.** The map
 * draws the subset the table is showing (`query.only`, P6-10), so the rows have
 * to survive a switch — tear the table down and the map would have to ask the
 * server for the same rows again to know what it is drawing, which is exactly
 * the duplication this ticket exists to remove. The map pane is the other way
 * round (`v-if`, as `useMapPane` requires): a reader who never opens it never
 * downloads a county file, and a hidden WebGL context is never left running.
 *
 * **Neither interface computes anything.** `fetchWorkingSetColumns` is called
 * once; the table sorts those values and the map reports them over the counties
 * it is drawing, from the same `Map`s. That is what makes a number in a story
 * citable: there is one of it.
 *
 * Reuses rather than rebuilds, as the ticket asks. The data half is
 * `DatasetView` — the explorer, with its search, filters, sort, summaries and
 * CSV — pointed at the set's anchor by a prop. The map half is P6-14's
 * `useShowOnMap` + `MapPane`, which is six lines. `MapCanvas` is untouched.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import DatasetView from '@/views/DatasetView.vue'
import MapPane from '@/components/MapPane.vue'
import SetLayerList from '@/components/SetLayerList.vue'
import IndexCompareCard from '@/components/IndexCompareCard.vue'
import IndexWeightEditor from '@/components/IndexWeightEditor.vue'
import { useShowOnMap } from '@/composables/useShowOnMap'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import { contextCell } from '@/lib/countyJoin'
import { friendlyError } from '@/lib/errors'
import { clearIndexDraft, readIndexDraft, writeIndexDraft } from '@/lib/indexDraft'
import {
  SET_INTERFACE_KEY,
  interfaceForViewType,
  parseSetInterface,
  tableStateOf,
  tableViewQuery,
  type SavedView,
  type SetInterface,
} from '@/lib/views'
import {
  derivedFreshnessBadge,
  derivedFreshnessLine,
  derivedRange,
  derivedRangeLine,
  derivedTableColumns,
  fetchWorkingSet,
  fetchWorkingSetColumns,
  rerunDerivedColumn,
  runComposite,
  workingSetDatasetsHref,
  workingSetHref,
  workingSetPlaceHref,
  type CompositeTerm,
  type DerivedColumn,
  type WeightTerm,
  type WorkingSetDetail,
} from '@/lib/workingSets'
import type { ScoringQueryLayer } from '@/types/mapTypes'

const props = defineProps<{
  /** The view whose framing this is. Its `workingSet` is what gets loaded. */
  view: SavedView
}>()

const route = useRoute()
const router = useRouter()

/** How long after the last slider change the draft is written (P9-6a). The
 *  same pause `PageEditor` leaves before autosaving page text. */
const AUTOSAVE_MS = 500

const set = ref<WorkingSetDetail | null>(null)
const columns = ref<DerivedColumn[]>([])
/** Columns the set names that could not be opened — said out loud rather than
 *  folded away, because it is a thing to go and fix (P6-23). */
const unreadable = ref<string[]>([])
const loading = ref(true)
const error = ref('')
const setGone = ref(false)

// --- Which interface -------------------------------------------------------

/** The interface the view's own type opens in — the view IS the framing, so a
 *  view saved off the map opens on the map and one saved off a table on the
 *  table. The set is the same either way, which is the point. */
const defaultInterface = computed(() => interfaceForViewType(props.view.type))

const iface = computed<SetInterface>(() =>
  parseSetInterface(route.query[SET_INTERFACE_KEY], defaultInterface.value),
)

/**
 * Switch interface. `replace`, same path, every other query key untouched — so
 * the table's filters survive a look at the map and come back with it, and Back
 * does not walk a trail of interface switches.
 */
function show(next: SetInterface): void {
  if (next === iface.value) return
  const query: Record<string, string | string[] | null> = { ...route.query } as Record<
    string,
    string | string[] | null
  >
  if (next === defaultInterface.value) delete query[SET_INTERFACE_KEY]
  else query[SET_INTERFACE_KEY] = next
  void router.replace({ query })
}

// --- The data half ---------------------------------------------------------

/**
 * Which table the data interface shows.
 *
 * The view's own dataset first, when it has one: a saved table view is about
 * that table and has to keep opening on it. Then the set's anchor — the held
 * dataset the set is *about* — then its first held member, so a map view over a
 * set still gets a table to explore. In practice these agree: the promote
 * action puts a table view's dataset into the set it makes.
 */
const anchor = computed(() => {
  const saved = tableStateOf(props.view)?.dataset
  if (saved) return saved
  if (set.value?.sites) return set.value.sites
  return set.value?.members.find(member => member.kind === 'dataset')?.slug ?? ''
})

/** The set's derived columns as joined table columns. ONE conversion, shared:
 *  the table's prop and the map's readout below read these same `Map`s. */
const joined = computed(() => derivedTableColumns(columns.value))

/** What the table is showing, lifted out of it (P7-2's `shown` emit) so the
 *  map can draw this subset without asking for the rows again. */
const shown = ref<{ geoIds: string[]; rows: number; total: number; loading: boolean }>({
  geoIds: [],
  rows: 0,
  total: 0,
  loading: true,
})

/**
 * Whether the table has settled at least once.
 *
 * A ONE-WAY latch, and both halves of that matter. It has to be set before the
 * map opens, because an empty `only` means "the whole layer" — opening sooner
 * would paint all 3,142 counties and snap to the subset a moment later, and
 * the repaint lands in the middle of the Mapbox style load. And it must never
 * go back, or every filter would tear the canvas down and build it again.
 */
const subsetSettled = ref(false)

function onShown(payload: { geoIds: string[]; rows: number; total: number; loading: boolean }): void {
  shown.value = payload
  if (!payload.loading) subsetSettled.value = true
}

// --- The map half (P6-14, six lines of it) ---------------------------------

/**
 * P9-6a: the formula being tried out, or null.
 *
 * The weight editor is a sandbox and this is the sandbox's contents: a live
 * formula that exists only on this page until somebody names a version and
 * saves it. Held HERE rather than in the editor because the map has to draw it
 * and the autosave has to keep it — the editor owns the sliders, the page owns
 * what they currently mean.
 */
const previewTerms = ref<CompositeTerm[] | null>(null)

/** Which index's formula is open for editing, by column id. '' is none. */
const editing = ref('')

/** The preview as the canvas takes it. Null whenever there is nothing to
 *  preview, which is the state every page but this one is always in. */
const previewQuery = computed<ScoringQueryLayer[] | null>(() => {
  const terms = previewTerms.value
  if (!terms || !terms.length) return null
  return terms.map(term => ({ layerId: term.layer, weight: term.weight, direction: term.direction }))
})

/**
 * P7-8: the derived index the map is drawing instead of the set's own layers,
 * or `''` for the set's layers.
 *
 * It has to be *instead of*, not *as well as*. The pane hands every layer it
 * names to the Lens at equal weight, so a set with three layers is already
 * painting a three-way composite of them — adding a saved index as a fourth
 * term would dilute the very thing somebody asked to look at, and the
 * choropleth would no longer be the number the column says it is. So drawing
 * an index is a switch, and the control says which state it is in.
 */
const drawnIndex = ref('')

/** The layers the SET names: it is the data, and what to draw is a question
 *  about the data. The view contributes the framing around them. */
const drawsLayers = computed(
  () => (set.value?.layers.length ?? 0) > 0 || !!drawnIndex.value || !!previewQuery.value,
)

/**
 * What the map is drawing, in one list — and it is a list of ONE thing at a
 * time by design.
 *
 * A preview beats a drawn index beats the set's own layers, because each of
 * those is a different claim about what the choropleth means and two of them
 * at once is two choropleths arguing. P9-6a's rule: dragging a weight replaces
 * the saved index on the map, and the layer list below says that it has.
 */
const drawnLayerIds = computed(() => {
  const preview = previewQuery.value
  if (preview) return preview.map(term => term.layerId)
  if (drawnIndex.value) return [drawnIndex.value]
  return set.value?.layers ?? []
})

/** The layers the set names, in its own order — what the list offers to
 *  toggle. A drawn index stands alone, the way it draws alone. */
const setLayerIds = computed(() => drawnLayerIds.value)

const map = useShowOnMap({
  layers: () => drawnLayerIds.value,
  // Equal weight unless a formula is being tried out, which is the one case a
  // page here has an opinion about how much each layer counts.
  weights: () => previewQuery.value,
  only: () => shown.value.geoIds,
})

/**
 * Draw one index on its own, or go back to the set's layers.
 *
 * Nothing is fetched here: the id came back on the column, the layer is in the
 * internal manifest, and `useShowOnMap` resolves it through exactly the path
 * every other internal county layer takes — which is why an index drawing
 * needed no new drawing code at all.
 */
function drawIndex(layerId: string): void {
  drawnIndex.value = drawnIndex.value === layerId ? '' : layerId
}

/** A column dropping out from under the switch — a re-run that renamed it, a
 *  set edited elsewhere — must not leave the map drawing a layer that is no
 *  longer there. */
watch(columns, list => {
  if (drawnIndex.value && !list.some(column => column.layerId === drawnIndex.value)) drawnIndex.value = ''
  if (editing.value && !list.some(column => column.id === editing.value)) closeEditor()
})

// --- P9-6a: weighing an index differently ----------------------------------

/**
 * The formula the editor shows: the saved one, with whatever has been dragged
 * since laid over it.
 *
 * It has to be a COMPUTED rather than a one-shot seed, because the editor now
 * lives inside the map pane (where the thing it repaints is) and the pane is
 * `v-if`'d — so switching to the data interface and back unmounts and remounts
 * it. Reading the live formula means it comes back as it was left instead of
 * snapping to what is saved.
 *
 * The round trip this creates is harmless and the one trap in it is handled: a
 * term dragged to ZERO is absent from the live formula (zero means out), so
 * "absent while a formula is live" reads as 0 rather than falling back to the
 * saved weight and springing the slider back under the cursor.
 */
const editorBase = ref<CompositeTerm[]>([])

const editorTerms = computed<WeightTerm[]>(() => {
  const live = previewTerms.value
  return editorBase.value.map(row => {
    const term = live?.find(x => x.layer === row.layer)
    return {
      layer: row.layer,
      name: layerName(row.layer),
      weight: live ? (term ? term.weight : 0) : row.weight,
      direction: term ? term.direction : row.direction,
    }
  })
})

/** Shown when the sliders opened on an autosaved draft rather than on the
 *  saved formula, because weights nobody can account for are worse than none. */
const draftRestored = ref(false)

const savingIndex = ref(false)
const indexError = ref('')

const editingColumn = computed(() => columns.value.find(column => column.id === editing.value) ?? null)

/**
 * A set that could carry an index but has none yet (P9-3's rule, P9-6a's
 * first question).
 *
 * It is NOT offered sliders. Equal weights over a set's candidate layers is a
 * real formula wearing the clothes of a neutral starting point, and a reader
 * cannot tell the difference. So there is exactly one way to make a first
 * formula — "Create a combined ranking" on the Analysis page — and this says where it is
 * rather than leaving a capability to be discovered. Said only when the set
 * could actually carry one: a reason a reader cannot act on is worse than
 * silence.
 */
const couldWeigh = computed(() => {
  if (columns.value.some(column => column.rerun?.type === 'composite')) return false
  // ONE source, because `registerInternalLayers` injects every internal COUNTY
  // layer into `LAYER_REGISTRY` as well. Counting the manifest and the registry
  // separately counted each of those twice, which told the redevelopment set —
  // one county layer and five point and line layers — that it had "layers that
  // could be ranked together", and sent the reader to a control that would
  // refuse them for having fewer than two. A point layer has features, not
  // values; nothing in the registry has features, so this is the whole test.
  const indexable = (set.value?.layers ?? []).filter(id => !!LAYER_REGISTRY[id])
  return indexable.length >= 2
})

/** A layer id is not a thing to put beside a slider. Internal names come off
 *  the manifest the pane already loaded, public ones off the static registry,
 *  so naming a term costs no request. */
function layerName(layerId: string): string {
  const internal = map.state.layers.internalDefinitions.value.find(def => def.id === layerId)
  if (internal) return internal.name
  return LAYER_REGISTRY[layerId]?.name || layerId
}

/**
 * Open (or close) the weight editor on one index's formula.
 *
 * The terms come from the column's own stored formula — the same record a
 * re-run reads — so nothing is retyped and nothing is inferred from a layer
 * manifest that somebody may since have edited. A set with no index is not
 * offered this at all: equal weights over its candidate layers would be a real
 * formula presented as a neutral starting point, which it is not. That path is
 * "Create a combined ranking" on the Analysis page, so there is exactly one way
 * to make a first formula.
 *
 * Awaits the manifest before seeding, so the rows open with names rather than
 * with ids that fill in a moment later. It is cached and shared; when the pane
 * is already open this costs nothing.
 */
async function openEditor(column: DerivedColumn): Promise<void> {
  if (editing.value === column.id) {
    closeEditor()
    return
  }
  if (column.rerun?.type !== 'composite' || !set.value) return
  const saved = column.rerun.terms
  indexError.value = ''
  await map.state.loadInternalLayers()
  // A draft is only usable if it is still about this formula's layers; a set
  // edited since is a reason to start from what is saved.
  const draft = readIndexDraft(set.value.slug, column.id)
  const known = draft && draft.every(term => saved.some(row => row.layer === term.layer))
  // A draft worth announcing is one that still fits this formula's layers AND
  // actually differs from it. One left behind by a Reset is neither.
  const usable = known && draft && !sameFormula(draft, saved) ? draft : null
  if (draft && !usable) clearIndexDraft(set.value.slug, column.id)
  editorBase.value = saved.map(row => ({ ...row }))
  draftRestored.value = !!usable
  // A restored draft draws at once: sliders saying one thing while the map
  // shows another is the single worst state this feature could be in.
  previewTerms.value = usable
  editing.value = column.id
}

function closeEditor(): void {
  editing.value = ''
  editorBase.value = []
  previewTerms.value = null
  draftRestored.value = false
  indexError.value = ''
}

/**
 * Two formulas that would score every county identically.
 *
 * Used to keep a draft that merely *equals* the saved index from announcing
 * itself as unsaved work — `PageEditor`'s rule ("a draft identical to the saved
 * page is not a draft"), which this did not have until the real page showed
 * "These weights are an unsaved version from last time" above sliders sitting
 * on exactly the published weights. Order is not part of a formula, so both
 * sides are compared by layer.
 */
function sameFormula(a: readonly CompositeTerm[], b: readonly CompositeTerm[]): boolean {
  const live = a.filter(term => term.weight > 0)
  const saved = b.filter(term => term.weight > 0)
  if (live.length !== saved.length) return false
  return live.every(term => {
    const other = saved.find(x => x.layer === term.layer)
    return !!other && other.weight === term.weight && other.direction === term.direction
  })
}

/** The live formula, on every drag. Nothing is written to the set. */
function onScore(terms: ScoringQueryLayer[]): void {
  previewTerms.value = terms.map(term => ({
    layer: term.layerId,
    weight: term.weight,
    direction: term.direction === 'lower_better' ? 'lower_better' : 'higher_better',
  }))
}

/**
 * Autosave, so a formula somebody spent five minutes on does not die with a
 * clicked link (`PageEditor`'s answer to unfinished page text). Debounced:
 * dragging a slider fires a change per pixel and none of them is worth a
 * synchronous write.
 */
let autosave: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(autosave))
watch([previewTerms, editing], ([terms, columnId]) => {
  const slug = set.value?.slug
  if (!slug || !columnId) return
  clearTimeout(autosave)
  autosave = setTimeout(() => {
    // Dragging a weight back to where it started is not unsaved work.
    if (terms && terms.length && !sameFormula(terms, editorBase.value)) {
      writeIndexDraft(slug, columnId, terms)
    } else {
      clearIndexDraft(slug, columnId)
    }
  }, AUTOSAVE_MS)
})

/** Throw the restored draft away and go back to what the set holds. */
function discardDraft(): void {
  const column = editingColumn.value
  if (!set.value || column?.rerun?.type !== 'composite') return
  // The last drag may still have a write pending. Without this it lands after
  // the clear and the draft is back, which is how a discarded version comes
  // haunting the next time somebody opens the sliders.
  clearTimeout(autosave)
  clearIndexDraft(set.value.slug, column.id)
  editorBase.value = column.rerun.terms.map(row => ({ ...row }))
  draftRestored.value = false
  previewTerms.value = null
}

/**
 * Save the previewed formula as a new index on the set.
 *
 * A version, never an overwrite: no `id` is sent, so the set gains a column
 * and keeps the one it had — which is the whole point of being able to compare
 * two versions (`IndexCompareCard`). The columns are then read again rather
 * than patched in place, for the reason a re-run does the same: one source of
 * truth re-read beats several patched by hand. The new column becomes what the
 * map draws, because somebody who just saved a version is looking at it.
 */
async function saveIndex(input: { label: string; terms: WeightTerm[] }): Promise<void> {
  if (savingIndex.value || !set.value) return
  const columnId = editing.value
  savingIndex.value = true
  indexError.value = ''
  try {
    const run = await runComposite(set.value.slug, {
      label: input.label,
      terms: input.terms.map(term => ({
        layer: term.layer,
        weight: term.weight,
        direction: term.direction,
      })),
    })
    const stored = await fetchWorkingSetColumns(set.value.slug)
    columns.value = stored.columns
    unreadable.value = stored.unreadable
    // Same race as `discardDraft`, and worse here: a pending write landing
    // after the save would make the next visit announce an unsaved version of
    // a formula that is now saved.
    clearTimeout(autosave)
    clearIndexDraft(set.value.slug, columnId)
    closeEditor()
    if (run.layerId) drawnIndex.value = run.layerId
  } catch (err) {
    // A 413 is the on-demand ceiling and its sentence names the local batch
    // pass, so it is shown rather than reworded.
    indexError.value = friendlyError(err, 'That index could not be saved.')
  } finally {
    savingIndex.value = false
  }
}

/**
 * The pane follows the interface. Opening it is what loads the county files,
 * so a reader who stays on the table never pays for them; closing it on the
 * way out is what stops a hidden map holding a WebGL context.
 *
 * It waits for the table's first answer (or for a set with no table at all),
 * so the pane's first paint is already the right subset rather than the whole
 * layer — which is what `useShowOnMap` promises and what the data half being
 * mounted all along makes possible.
 */
const readyToDraw = computed(() => drawsLayers.value && (subsetSettled.value || !anchor.value))

watch(
  [iface, readyToDraw],
  () => {
    if (iface.value === 'map' && readyToDraw.value) map.open()
    else map.close()
  },
  { immediate: true },
)

/** A county pressed on the map, so the readout can say what this column says
 *  about that one. Reset when the subset moves under it. */
const clickedGeoId = ref<string | null>(null)
watch(
  () => shown.value.geoIds.join(','),
  () => {
    clickedGeoId.value = null
  },
)

/**
 * The fidelity claim, said out loud.
 *
 * A filtered table hands the map its own rows, which is the one thing a URL
 * cannot say (P6-10). What it hands over is the page you are looking at, as
 * every "show on map" in this codebase does, so the note says which number is
 * which rather than letting the reader assume the map is drawing all 1,900
 * matches.
 */
const paneNote = computed(() => {
  const { geoIds, rows, total } = shown.value
  if (!geoIds.length) return 'Every county in these layers'
  const counties = `${geoIds.length.toLocaleString()} ${geoIds.length === 1 ? 'county' : 'counties'}`
  const from = `${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`
  const matched = total > rows ? ` of ${total.toLocaleString()} matching` : ''
  return `${counties} from ${from}${matched}`
})

/**
 * The MAP's reading of a derived column.
 *
 * The canvas draws registry layers, so a derived column is not something it can
 * paint without the layer pipeline. What the map can say honestly — and from
 * the same values the table is sorting — is the column's spread across the
 * counties it is actually drawing, and what it says about the one you pressed.
 */
const mapColumns = computed(() =>
  columns.value.map((column, index) => {
    const range = derivedRange(column, shown.value.geoIds)
    const values = joined.value[index]?.values
    return {
      id: column.id,
      label: column.label,
      line: range ? derivedRangeLine(column, range) : 'No numbers for the counties on the map',
      here: clickedGeoId.value ? contextCell(values, clickedGeoId.value) : '',
      method: column.method,
      stored: column.storedAt,
      // P7-6: what this number's standing is, and whether it can be fixed from
      // here. A stale column keeps every value above and gains these.
      freshness: column.freshness,
      badge: derivedFreshnessBadge(column),
      provenance: derivedFreshnessLine(column),
      canRerun: !!column.rerun,
      // P7-8: a composite index IS a county layer, so it can be put on the
      // map. A measurement is not one — nothing in a proximity record says
      // which end of "miles away" is good — and `layerId` is `''` for it, so
      // no control is offered that cannot do what it says.
      layerId: column.layerId,
      drawing: !!column.layerId && drawnIndex.value === column.layerId,
      // P9-6a: a formula is editable, a measurement is not — there is nothing
      // in "miles to the nearest line" to weigh against anything.
      //
      // And only where the editor can actually appear. It lives in the map
      // pane, beside the choropleth it repaints, and the pane wants a desktop
      // — so on a narrower window this button opened nothing and relabelled
      // itself "Close the weights", which is a dead control wearing the
      // clothes of a working one. P9-3's rule: say why instead.
      isIndex: column.rerun?.type === 'composite',
      canWeigh: column.rerun?.type === 'composite' && map.canOpen.value,
      weighing: editing.value === column.id,
      column,
    }
  }),
)

/**
 * The columns whose inputs have moved, or cannot be checked (P7-6).
 *
 * Counted into one line in the HEADER, which sits outside both interface
 * panes — so the caveat reaches a reader on the data interface too, where the
 * derived values are indistinguishable from county-context columns once they
 * are inside the explorer's table. "Stale must be visible, never silent"
 * cannot be half a feature that only holds on the map.
 */
const unsound = computed(() => columns.value.filter(c => c.freshness !== 'fresh'))

const unsoundLine = computed(() => {
  const stale = unsound.value.filter(c => c.freshness === 'stale')
  const unchecked = unsound.value.filter(c => c.freshness === 'unknown')
  const parts: string[] = []
  if (stale.length) {
    parts.push(
      `${stale.length === 1 ? 'A derived column is' : `${stale.length} derived columns are`} out of date: ` +
        `${stale.map(c => c.label).join(', ')}.`,
    )
  }
  if (unchecked.length) {
    parts.push(
      `${unchecked.length === 1 ? 'One column does' : `${unchecked.length} columns do`} not record what ` +
        `${unchecked.length === 1 ? 'it was' : 'they were'} measured from, so ` +
        `${unchecked.length === 1 ? 'it cannot' : 'they cannot'} be checked.`,
    )
  }
  // Named on the map interface, where each one also carries its own sentence
  // and its own re-run.
  if (stale.length) parts.push('The numbers still show, with what changed, on the Map interface.')
  return parts.join(' ')
})

// --- Re-running one (P7-6) -------------------------------------------------

const rerunning = ref('')
const rerunError = ref('')

/**
 * Measure a stale column again, from where it is read.
 *
 * The arguments come from the column's own stored record, so nothing is
 * retyped and nothing is guessed. On success the whole column set is read
 * again rather than patched in place: the run may have written two columns
 * (a distance and a count), and one source of truth re-read is simpler than
 * two patched by hand.
 */
async function rerun(column: DerivedColumn): Promise<void> {
  if (rerunning.value || !set.value) return
  rerunning.value = column.id
  rerunError.value = ''
  try {
    await rerunDerivedColumn(set.value.slug, column)
    const stored = await fetchWorkingSetColumns(set.value.slug)
    columns.value = stored.columns
    unreadable.value = stored.unreadable
  } catch (err) {
    // A 413 from the ceiling is the interesting case and its sentence names
    // the local batch pass, so it is shown rather than reworded.
    rerunError.value = friendlyError(err, 'That column could not be measured again.')
  } finally {
    rerunning.value = ''
  }
}

/** What the set holds, in counts — the same sentence shape its catalog row
 *  uses, so the two cannot disagree. */
const holds = computed(() => {
  const s = set.value
  if (!s) return ''
  const parts = [`${s.datasets.length} ${s.datasets.length === 1 ? 'dataset' : 'datasets'}`]
  if (s.layers.length) parts.push(`${s.layers.length} ${s.layers.length === 1 ? 'layer' : 'layers'}`)
  if (columns.value.length) {
    parts.push(`${columns.value.length} derived ${columns.value.length === 1 ? 'column' : 'columns'}`)
  }
  return parts.join(' · ')
})

/** Every other view of this set. Several is the normal case, not an edge, and
 *  this is the one place a reader can see that they are all over one object. */
const siblingViews = computed(() => (set.value?.views ?? []).filter(view => view.slug !== props.view.slug))

// --- Load, once ------------------------------------------------------------

/**
 * A saved table view's query, put on the URL it is already on.
 *
 * The explorer reads its state from the URL, so restoring a table view is the
 * same job here as on the entry hub — the keys, not the destination
 * (`tableViewQuery`). Only when the URL carries none of them: a link somebody
 * shared with its own filters must win over the ones the document was saved
 * with.
 */
function seedTableState(): void {
  const saved = tableStateOf(props.view)
  if (!saved) return
  const query = tableViewQuery(saved, props.view.slug)
  const owned = ['file', 'q', 'sort', 'dir', 'filter', 'page', 'limit', 'view']
  if (owned.some(key => route.query[key] !== undefined)) return
  void router.replace({ query: { ...route.query, ...query } })
}

onMounted(async () => {
  const slug = props.view.workingSet ?? ''
  try {
    // Both at once: the set's members and its stored columns are two reads of
    // one object and neither waits on the other.
    const [detail, stored] = await Promise.all([fetchWorkingSet(slug), fetchWorkingSetColumns(slug)])
    if (!detail) {
      setGone.value = true
      return
    }
    set.value = detail
    columns.value = stored.columns
    unreadable.value = stored.unreadable
    seedTableState()
  } catch (err) {
    error.value = friendlyError(err, 'That working set could not be loaded.')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="set-workspace" data-testid="set-workspace">
    <RouterLink to="/analysis" class="back-link">← Analysis</RouterLink>

    <p v-if="loading" class="state-note" data-testid="workspace-loading">Opening the working set…</p>
    <p v-else-if="error" class="state-note error" data-testid="workspace-error">{{ error }}</p>

    <!-- A set can be archived or renamed out from under an open view. Say what
         happened and offer the map, which is where this view used to go. -->
    <div v-else-if="setGone" class="state-note" data-testid="workspace-set-gone">
      <p>
        The view “{{ view.name }}” presents a working set called “{{ view.workingSet }}”, and the library does not have
        one by that name any more.
      </p>
      <p class="gone-links">
        <RouterLink :to="`/?view=${view.slug}`">Open it on the map</RouterLink>
        ·
        <RouterLink to="/analysis">Working sets</RouterLink>
      </p>
    </div>

    <template v-else-if="set">
      <header class="workspace-head">
        <h1 data-testid="workspace-title">{{ view.name }}</h1>
        <p class="set-line" data-testid="workspace-set">
          Over
          <RouterLink :to="workingSetHref(set.slug)" data-testid="workspace-set-link">{{ set.name }}</RouterLink>
          <span class="set-holds" data-testid="workspace-holds"> · {{ holds }}</span>
        </p>
        <p v-if="set.purpose" class="set-purpose" data-testid="workspace-purpose">{{ set.purpose }}</p>
        <!-- P7-6: in the HEADER, which is outside both interface panes, so a
             reader on the data interface is told too. Inside the explorer a
             derived column is indistinguishable from a county-context one, and
             a caveat that only holds on the map is not a caveat. -->
        <p v-if="unsoundLine" class="set-unsound" data-testid="workspace-unsound">{{ unsoundLine }}</p>
        <!-- A set may carry several views, and all of them read these rows.
             Worth saying here, because it is the reason the set and the view
             are two objects at all. -->
        <p v-if="siblingViews.length" class="set-siblings" data-testid="workspace-siblings">
          Also presented by
          <RouterLink
            v-for="other in siblingViews"
            :key="other.slug"
            :to="`/views/${other.slug}`"
            class="sibling-link"
            data-testid="workspace-sibling"
          >{{ other.name }}</RouterLink>
        </p>
      </header>

      <!-- Two interfaces, one object, one URL. `replace` on the same path, so
           this is not a navigation. -->
      <nav class="tab-bar strip" role="tablist" aria-label="Interfaces" data-testid="interface-switch">
        <button
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ active: iface === 'map' }"
          :aria-selected="iface === 'map'"
          data-interface="map"
          @click="show('map')"
        >Map</button>
        <button
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ active: iface === 'data' }"
          :aria-selected="iface === 'data'"
          data-interface="data"
          @click="show('data')"
        >Data</button>
      </nav>

      <p v-if="set.missing.length" class="state-note warn" data-testid="workspace-missing">
        This set names {{ set.missing.length }}
        {{ set.missing.length === 1 ? 'thing' : 'things' }} the library no longer has:
        {{ set.missing.join(', ') }}.
      </p>

      <!-- MAP. `v-if` on the pane, never `v-show`: a reader who stays on the
           table must not download a county file, and a hidden canvas must not
           hold a WebGL context. -->
      <section v-show="iface === 'map'" class="interface" data-testid="interface-map">
        <template v-if="readyToDraw">
          <!-- The pane and everything that reads against it are ONE branch.
               They were siblings until P9-6, which left the `v-else` below
               pairing with whatever happened to precede it rather than with
               the pane — so "there is not room for a map" could show on a
               desktop whenever the set named no layers. -->
          <template v-if="map.isOpen.value">
            <MapPane
              class="workspace-pane"
              testid="set-map-pane"
              :layers="map.state.layers"
              :query="map.state.query"
              :data="map.state.data"
              :fit="map.fit.value"
              :title="set.name"
              :note="paneNote"
              label="This working set on the map"
              @close="show('data')"
              @county-click="clickedGeoId = $event"
            />
            <!-- P9-2: once a set's layers actually draw (P9-1, P9-1b) the map
                 is two dense national networks and thousands of clustered
                 points with nothing to say what they are. This names them,
                 carries each one's own colour so the list reads against the
                 map, and toggles through the same state the canvas draws from. -->
            <!-- P9-6a: the preview replaced the saved index on the canvas, so
                 the thing naming the map's layers has to say so. A reader must
                 never mistake a preview for the record. -->
            <p v-if="previewQuery" class="preview-note" data-testid="map-preview-note">
              Showing an unsaved version of
              {{ editingColumn ? '“' + editingColumn.label + '”' : 'this index' }}, weighed below.
            </p>
            <!-- P9-6a: the active control, so it sits closest to the canvas
                 it repaints — above the layer list, not below it.
                 It was first placed down with the derived columns, which it is
                 *about*, and seeing it rendered killed that idea: on a 900px
                 window the sliders were 1,500px below the map, so you could see
                 the control or the consequence, never both — which is the whole
                 feature. Even directly under the list it was 370px adrift,
                 because eleven layer rows sit between. Surviving an interface
                 switch is handled by seeding from the live formula instead
                 (`editorTerms`), not by placing it where nobody can use it. -->
            <template v-if="editing && editorTerms.length">
              <p v-if="draftRestored" class="draft-note" data-testid="index-draft-restored">
                These weights are an unsaved version from last time.
                <button type="button" class="link-btn" data-testid="index-draft-discard" @click="discardDraft">
                  Use the saved index instead
                </button>
              </p>
              <IndexWeightEditor :terms="editorTerms" @score="onScore" @save="saveIndex" />
              <p v-if="savingIndex" class="state-note" data-testid="index-saving">Saving this version…</p>
              <p v-if="indexError" class="state-note error" data-testid="index-save-error">{{ indexError }}</p>
            </template>
            <SetLayerList
              v-if="setLayerIds.length"
              class="workspace-layers"
              :layers="map.state.layers"
              :ids="setLayerIds"
              :readonly="!!previewQuery"
            />
            <!-- P9-6: when a set holds more than one index, the useful question
                 is not what either says but what re-weighting did to the order.
                 Both columns' values are already here, so this costs nothing. -->
            <IndexCompareCard :columns="columns" />
          </template>
          <!-- A map beside a page wants a desktop (P6-14). On a phone the deep
               link is still how this view is shared, and still works. -->
          <p v-else class="state-note" data-testid="map-too-narrow">
            There is not room for a map here.
            <RouterLink :to="`/?view=${view.slug}`">Open it on the full map</RouterLink>.
          </p>
        </template>
        <p v-else-if="!drawsLayers" class="state-note" data-testid="map-no-layers">
          This set names no map layers yet, so there is nothing to draw.
          <RouterLink :to="workingSetDatasetsHref(set.slug)">Its datasets</RouterLink>
          ·
          <RouterLink :to="workingSetPlaceHref(set.slug)">Check a place in it</RouterLink>
        </p>

        <!-- The map's reading of the set's derived columns: the same values the
             table is sorting, over the counties this map is drawing. -->
        <section v-if="mapColumns.length" class="derived" data-testid="derived-columns">
          <h2 class="derived-heading">Derived columns</h2>
          <ul class="derived-list">
            <li
              v-for="column in mapColumns"
              :key="column.id"
              class="derived-row"
              :data-freshness="column.freshness"
              data-testid="derived-row"
            >
              <strong class="derived-label">{{ column.label }}</strong>
              <!-- P7-6: the state word last, beside the thing it is about, and
                   never the only thing said — the sentence below names which
                   input moved. -->
              <span v-if="column.badge" class="derived-badge" data-testid="derived-stale">{{ column.badge }}</span>
              <span class="derived-line" data-testid="derived-range">{{ column.line }}</span>
              <span v-if="column.here" class="derived-here" data-testid="derived-here">
                Here: {{ column.here }}
              </span>
              <!-- The re-run, offered where the number is READ rather than on a
                   form elsewhere: the arguments are in the stored record, so
                   there is nothing for a reader to retype. -->
              <button
                v-if="column.freshness === 'stale' && column.canRerun"
                type="button"
                class="derived-rerun"
                :disabled="!!rerunning"
                data-testid="derived-rerun"
                @click="rerun(column.column)"
              >
                {{ rerunning === column.id ? 'Measuring…' : 'Run again' }}
              </button>
              <button
                v-if="column.layerId"
                type="button"
                class="derived-rerun"
                data-testid="derived-draw"
                :aria-pressed="column.drawing"
                @click="drawIndex(column.layerId)"
              >
                {{ column.drawing ? 'Show the set’s layers' : 'Draw on the map' }}
              </button>
              <!-- P9-6a: offered where the formula is READ, for the same reason
                   the re-run is — the terms are in the stored record, so there
                   is nothing for a reader to retype. -->
              <button
                v-if="column.canWeigh"
                type="button"
                class="derived-rerun"
                data-testid="derived-weigh"
                :aria-pressed="column.weighing"
                @click="openEditor(column.column)"
              >
                {{ column.weighing ? 'Close the weights' : 'Weigh it differently' }}
              </button>
              <span v-else-if="column.isIndex" class="derived-why" data-testid="derived-weigh-why">
                Weigh it differently — needs a wider window, so the map can show what the weights do
              </span>
              <span class="derived-provenance" data-testid="derived-provenance">{{ column.provenance }}</span>
              <span v-if="column.method" class="derived-method" data-testid="derived-method">{{ column.method }}</span>
            </li>
          </ul>
          <p v-if="rerunError" class="state-note error" data-testid="derived-rerun-error">{{ rerunError }}</p>
          <p class="derived-note">
            Stored on the set, not recomputed to draw this. The table sorts these same numbers.
          </p>

        </section>
        <!-- P9-6a: where a first formula comes from, for a set that has the
             layers to weigh but nothing weighing them yet. -->
        <p v-if="couldWeigh" class="state-note" data-testid="index-none-yet">
          This set has layers that could be ranked together, but nothing ranking them yet.
          <RouterLink to="/analysis">Create a combined ranking on the Analysis page</RouterLink> — then its
          weights can be dragged around here.
        </p>
        <p v-if="unreadable.length" class="state-note warn" data-testid="derived-unreadable">
          {{ unreadable.length === 1 ? 'One derived column' : `${unreadable.length} derived columns` }} could not be
          read: {{ unreadable.join(', ') }}.
        </p>
      </section>

      <!-- DATA. Kept mounted: the map draws the rows this is showing, so they
           have to survive a switch. -->
      <section v-show="iface === 'data'" class="interface" data-testid="interface-data">
        <DatasetView
          v-if="anchor"
          embedded
          host-map
          :slug="anchor"
          :extra-columns="joined"
          @shown="onShown"
        />
        <p v-else class="state-note" data-testid="data-no-anchor">
          This set is not anchored on a table we hold, so there are no rows to explore yet.
          <RouterLink :to="workingSetDatasetsHref(set.slug)">Its datasets, and what is still missing</RouterLink>
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.set-workspace {
  max-width: 1400px;
  margin: 0 auto;
  padding: 20px;
  min-width: 0;
}

.back-link {
  display: inline-block;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--blo-stone);
  text-decoration: none;
}

.back-link:hover {
  color: var(--blo-ink, #111);
}

.workspace-head h1 {
  margin: 0;
  font-size: 22px;
  color: var(--blo-ink, #111);
}

.set-line,
.set-purpose,
.set-siblings {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.set-line a {
  color: inherit;
  font-weight: 600;
}

.sibling-link {
  color: inherit;
}

.sibling-link + .sibling-link::before {
  content: ' · ';
}

/* Same tab bar as the entry hub: this is the same gesture over the same kind
   of object, and it should not look like a different one. */
.tab-bar {
  display: flex;
  gap: 4px;
  margin: 18px 0 8px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.tab-btn {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
}

.tab-btn.active {
  color: var(--blo-ink, #111);
  border-bottom-color: var(--blo-green-deep, #1f4332);
}

.interface {
  min-width: 0;
}

/* The pane is the whole interface here, not a column beside something else,
   so it takes a readable amount of height rather than the table's share. */
.workspace-pane {
  height: min(70vh, 640px);
}

.state-note {
  margin: 12px 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.state-note.error {
  color: var(--blo-clay, #a8422c);
}

.state-note.warn {
  color: var(--blo-ink-soft, #5c564e);
}

.state-note a {
  color: inherit;
}

.gone-links {
  margin: 8px 0 0;
}

.derived {
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.derived-heading {
  margin: 0 0 8px;
  font-size: 13px
}

.derived-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.derived-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
}

.derived-label {
  color: var(--blo-ink, #111);
}

.derived-line,
.derived-here {
  color: var(--blo-ink-soft, #5c564e);
}

.derived-here {
  font-weight: 600;
}

.derived-method {
  flex: 1 1 100%;
  font-size: 12px;
  color: var(--blo-stone);
}

/* P9-3's shape: a reason reads as a reason, not as a button somebody greyed. */
.derived-why {
  font-size: 12px;
  color: var(--blo-stone);
}

.derived-note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

/* P9-6a. The preview note and the restored-draft note carry the same orange a
   stale column's badge does — `--blo-orange-deep`, not a new hex — because the
   state is the same kind of state: a number on screen that nobody has committed
   to. Quiet grey would make them decorative, which is exactly the mistake; a
   reader who misses these is reading an unsaved formula as the set's record. */
.preview-note,
.draft-note {
  margin: 8px 0 0;
  padding: 6px 8px;
  border-left: 3px solid var(--blo-orange-deep, #e65100);
  background: var(--blo-orange-soft, rgba(255, 107, 28, 0.1));
  font-size: 12px;
  color: var(--blo-orange-deep, #e65100);
}

.link-btn {
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

/* P7-6: a column whose inputs have moved must never look like one whose have
   not — the same orange P6-34 uses for an unverified value, because the state
   is the same state: a value waiting on a person. Quiet grey would make the
   label decorative. */
.derived-badge {
  padding: 1px 5px;
  border: 1px solid var(--blo-orange-deep, #e65100);
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blo-orange-deep, #e65100);
}

/* Full width, so the sentence naming what changed drops to its own line under
   the row rather than being truncated into a chip. */
.derived-provenance {
  flex: 1 1 100%;
  font-size: 12px;
  color: var(--blo-stone);
}

.derived-row[data-freshness='stale'] .derived-provenance {
  color: var(--blo-orange-deep, #e65100);
}

/* `.act`'s geometry from NeedsALookNote, which is this codebase's small
   inline action beside a value that needs attention. */
.derived-rerun {
  padding: 1px 6px;
  font-size: 12px;
  color: var(--blo-green-deep, #1f7a2e);
  background: none;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 4px;
  cursor: pointer;
}

.derived-rerun:disabled {
  opacity: 0.6;
  cursor: default;
}

/* The header line — the half a reader on the DATA interface sees, where a
   derived column is indistinguishable from a county-context one. The row-level
   gap line's own styling (DatasetsView, DocsView). */
.set-unsound {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--blo-orange-deep, #e65100);
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
