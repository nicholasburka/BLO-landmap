<script setup lang="ts">
/**
 * The analysis page (P6-4): the tools, and what has been run with them.
 *
 * Two halves, in that order, because the page answers two questions a
 * researcher arrives with — "what can I do here?" and "what did we already
 * find out?".
 *
 * **The tools** are four cards with a one-line description and a Start.
 * Two of them are pages of their own (`/place`, `/compare`). The other two
 * are not pages at all, so each links to the nearest real door:
 *
 *  - *Explore a dataset* is a tab on an entry, not a route, so it opens the
 *    datasets browser narrowed to the tables we actually hold — pick one and
 *    its Data tab is the explorer. The card says so, rather than leaving the
 *    reader on a list wondering.
 *  - *Show on map* opens the public map itself (`/`), which is where the
 *    layer picker lives. A saved view would be a shortcut to one particular
 *    answer; the tool card is for the person who has not chosen a layer yet,
 *    and the saved views they might want are in the list right below.
 *
 * **Recent analyses** merges the two places an analysis is kept — saved views
 * (catalog documents) and cached place reports (the server's index) — into
 * one list, newest first, each opening in a single press. See `lib/analyses`.
 *
 * P7-1 puts **working sets** between the two, because that is where they sit
 * in the work: a set is what an analysis runs *against*, so it belongs above
 * the record of what has been run and below the tools that run it. Each set
 * shows how far its sourcing has got and the views that present it — several
 * is the normal case, which is the whole reason a set and a view are two
 * objects.
 *
 * The **promote** control lives here and nowhere else. A curated set comes
 * into being because somebody decided an ad-hoc view matters, never because a
 * migration guessed from a layer list (spec §F.1), so it is a deliberate
 * press with a name attached.
 *
 * P7-5 adds the first of spec §F.5's tool cards that **operate on a working
 * set rather than on the whole library**: *Measure proximity* and, since P7-8,
 * *Build an index*. Each sits on the
 * set's own row because that is what it is scoped to — a set is what an
 * analysis runs against — and what it writes is a derived column on that set,
 * which the map pane and the data table both then show without a second
 * computation (P7-2). The four cards above it still operate on the library.
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import { recentAnalyses, type Analysis } from '@/lib/analyses'
import { fetchPlaceReports, type PlaceReportRow } from '@/lib/placeReport'
import { fetchViews, type SavedViewSummary } from '@/lib/views'
import { relativeTime } from '@/lib/kb'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import {
  fetchWorkingSets,
  compositeLine,
  compositeServedLine,
  compositeTermLine,
  indexableLayersOf,
  measurableLayersOf,
  progressLine,
  promoteViewToWorkingSet,
  proximityLine,
  proximityServedLine,
  runComposite,
  runProximity,
  workingSetDatasetsHref,
  workingSetHref,
  workingSetPlaceHref,
  workingSetProgress,
  type CompositeRun,
  type CompositeTerm,
  type ProximityRun,
  type WorkingSetSummary,
} from '@/lib/workingSets'
import { friendlyError } from '@/lib/errors'
// The public registry's static half — names, units and declared directions for
// the county layers an index can weigh. Type and data only: this page mounts no
// map, so nothing of the drawing pipeline comes with it.
import { LAYER_REGISTRY } from '@/config/layerRegistry'

interface Tool {
  id: string
  name: string
  description: string
  href: string
  /** What pressing Start actually lands on, when that needs saying. */
  hint?: string
}

const TOOLS: Tool[] = [
  {
    id: 'place',
    name: 'Check a place',
    description: 'One address or county, and every source we hold or index that covers it.',
    href: '/place',
  },
  {
    id: 'compare',
    name: 'Compare',
    description: 'A handful of candidate counties side by side, across the layers that matter.',
    href: '/compare',
  },
  {
    id: 'explore',
    name: 'Explore a dataset',
    description: 'Filter, sort and summarise a table we hold, with the county context beside it.',
    href: '/datasets?readiness=held',
    hint: 'Opens the datasets browser — pick a table, then its Data tab.',
  },
  {
    id: 'map',
    name: 'Show on map',
    description: 'Draw a layer over the counties and read it where it lands.',
    href: '/',
    hint: 'Opens the map, where the layer picker is.',
  },
]

/** How many rows "recent" means. Long enough to be a memory, short enough to
 *  read without scrolling past the tools. */
const RECENT_LIMIT = 12

const views = ref<SavedViewSummary[]>([])
const reports = ref<PlaceReportRow[]>([])
const sets = ref<WorkingSetSummary[]>([])
const entries = ref<CatalogEntry[]>([])
const loading = ref(true)

/** P7-1: the promote control's state. One name, one view, one press. */
const promoteFrom = ref('')
const promoteName = ref('')
const promoting = ref(false)
const promoteError = ref('')
const promoted = ref('')

/**
 * The views that present no set.
 *
 * These are the promotable ones, and they are **ad-hoc, not legacy** — saving
 * the map after exploring is a reasonable thing to do and must not require
 * naming a dataset collection first. Most views are here permanently and that
 * is fine; the control is for the one that turns out to matter.
 */
const adHocViews = computed(() => views.value.filter(view => !view.workingSet))

/** Each set with the sentence that says how far its sourcing has got. */
const setRows = computed(() =>
  sets.value.map(set => ({ set, progress: progressLine(workingSetProgress(set, entries.value)) })),
)

const analyses = computed<Analysis[]>(() => recentAnalyses(views.value, reports.value, RECENT_LIMIT))

/**
 * Each half loads on its own. A library with no place reports yet — or a
 * bucket that is briefly unhappy — must still show the saved views, and the
 * other way round: neither half is worth an error page over.
 */
async function load(): Promise<void> {
  loading.value = true
  const [savedViews, savedReports, savedSets, catalog] = await Promise.allSettled([
    fetchViews(),
    fetchPlaceReports(RECENT_LIMIT),
    fetchWorkingSets(),
    // Cached app-wide (P5-89), so this usually costs no request at all. It is
    // what turns a set's member list into "9 of 11 held".
    fetchCatalog({ archived: true }),
  ])
  views.value = savedViews.status === 'fulfilled' ? savedViews.value : []
  reports.value = savedReports.status === 'fulfilled' ? savedReports.value : []
  sets.value = savedSets.status === 'fulfilled' ? savedSets.value : []
  entries.value = catalog.status === 'fulfilled' ? catalog.value : []
  loading.value = false
}

onMounted(load)

/**
 * "Make a working set from this view" (spec §F.1).
 *
 * What it takes from the view is the layers the view draws — and, for a table
 * view or an internal point layer, the dataset underneath. Everything else a
 * view stores is framing. The set it makes is therefore a **starting point**,
 * which the confirmation says out loud rather than implying the set is
 * finished: the next step is adding the sources that make it an analysis.
 */
async function promote(): Promise<void> {
  if (!promoteFrom.value || promoting.value) return
  promoting.value = true
  promoteError.value = ''
  promoted.value = ''
  try {
    const made = await promoteViewToWorkingSet(promoteFrom.value, {
      ...(promoteName.value.trim() ? { name: promoteName.value.trim() } : {}),
    })
    promoted.value = made.slug
    promoteFrom.value = ''
    promoteName.value = ''
    await load()
  } catch (err: unknown) {
    promoteError.value = friendlyError(err, 'The working set could not be made. Try again in a moment.')
  } finally {
    promoting.value = false
  }
}

/**
 * P7-5: *Measure proximity* — the first analysis scoped to a set (spec §F.5).
 *
 * One form, reused by whichever set's row is open, because two sets are never
 * being measured at once and a form per row would be a form per row.
 */
const proximityFor = ref('')
const proximityTo = ref('')
/** A string OR a number: `v-model` on an `<input type="number">` casts what
 *  was typed, so this holds `''` before anybody types and `5` after. Read
 *  through `Number()` rather than trimmed — a `.trim()` here threw a
 *  TypeError the moment a radius was entered, which the spec caught. */
const proximityWithin = ref<string | number>('')
const measuring = ref(false)
const proximityError = ref('')
const proximityRun = ref<ProximityRun | null>(null)

/** The layers a set can actually be measured against — point and line only,
 *  read off the catalog this page already loaded. A county layer holds values
 *  rather than features, so it is not offered. */
function measurableLayers(set: WorkingSetSummary) {
  return measurableLayersOf(set, entries.value)
}

function openProximity(set: WorkingSetSummary): void {
  const open = proximityFor.value === set.slug
  proximityFor.value = open ? '' : set.slug
  proximityTo.value = open ? '' : (measurableLayers(set)[0]?.id ?? '')
  proximityWithin.value = ''
  proximityError.value = ''
  proximityRun.value = null
}

async function measure(): Promise<void> {
  if (!proximityFor.value || !proximityTo.value || measuring.value) return
  measuring.value = true
  proximityError.value = ''
  proximityRun.value = null
  try {
    const within = Number(proximityWithin.value)
    proximityRun.value = await runProximity(proximityFor.value, {
      to: proximityTo.value,
      ...(Number.isFinite(within) && within > 0 ? { within } : {}),
    })
    // The set's derived count changed, so the row under the form is stale.
    await load()
  } catch (err: unknown) {
    // The ceiling's refusal names the local batch pass, so it is shown as
    // written rather than replaced with "something went wrong".
    proximityError.value = friendlyError(err, 'The measurement could not be run. Try again in a moment.')
  } finally {
    measuring.value = false
  }
}

/**
 * P7-8: *Build an index* — spec §F.5's second set-scoped tool card, and §F.3's
 * whole feature.
 *
 * One form, reused by whichever set's row is open, the same way the proximity
 * form is: two sets are never being indexed at once.
 *
 * The formula is a row per county layer the set names, because that is the
 * list the server will accept and an option that can only ever be refused is
 * not an option. **The direction is pre-filled from the layer's declared one
 * and is a visible control**, which is a different thing from the server
 * defaulting it: what a person leaves in that box is what gets saved, so the
 * stored formula never depends on a manifest field somebody can later edit.
 */
const indexFor = ref('')
const indexName = ref('')
/** Layer id → whether it is in the formula, how much it counts, which end is
 *  good. Keyed by layer so toggling one off and on again keeps its weight. */
const indexTerms = ref<Record<string, { on: boolean; weight: number; direction: 'higher_better' | 'lower_better' }>>({})
const indexing = ref(false)
const indexError = ref('')
const indexRun = ref<CompositeRun | null>(null)

/** The layers an index can weigh: county layers only — internal ones off the
 *  catalog this page already loaded, public ones off the static registry. */
function indexableLayers(set: WorkingSetSummary) {
  return indexableLayersOf(set, entries.value, LAYER_REGISTRY)
}

/** The formula as the server takes it, in the order the rows are shown; the
 *  server stores it canonically, so this order is only what was typed. */
const indexFormula = computed<CompositeTerm[]>(() =>
  Object.entries(indexTerms.value)
    .filter(([, term]) => term.on && term.weight > 0)
    .map(([layer, term]) => ({ layer, weight: term.weight, direction: term.direction })),
)

/** Names for the result's term lines, so a reader sees "Black poverty rate"
 *  and not `poverty_by_race`. */
const indexNames = computed<Record<string, string>>(() => {
  const set = sets.value.find(s => s.slug === indexFor.value)
  if (!set) return {}
  return Object.fromEntries(indexableLayers(set).map(layer => [layer.id, layer.name]))
})

function openIndex(set: WorkingSetSummary): void {
  const open = indexFor.value === set.slug
  indexFor.value = open ? '' : set.slug
  indexName.value = ''
  indexError.value = ''
  indexRun.value = null
  indexTerms.value = open
    ? {}
    : Object.fromEntries(
        // Nothing pre-selected: an index is a claim about what matters, and a
        // form that arrives with every layer ticked invites somebody to press
        // Build without having made it.
        indexableLayers(set).map(layer => [layer.id, { on: false, weight: 5, direction: layer.direction }]),
      )
}

async function buildIndex(): Promise<void> {
  if (!indexFor.value || indexFormula.value.length < 2 || !indexName.value.trim() || indexing.value) return
  indexing.value = true
  indexError.value = ''
  indexRun.value = null
  try {
    indexRun.value = await runComposite(indexFor.value, {
      label: indexName.value.trim(),
      terms: indexFormula.value,
    })
    // The set's derived count changed, so the row under the form is stale.
    await load()
  } catch (err: unknown) {
    // The ceiling's refusal names the local batch pass, and a flat layer's
    // names the layer — both are shown as written rather than replaced with
    // "something went wrong".
    indexError.value = friendlyError(err, 'The index could not be built. Try again in a moment.')
  } finally {
    indexing.value = false
  }
}

/**
 * "who · when", or just when.
 *
 * P6-27: this line used to print `analysis.by || 'someone'`, which invented a
 * person. Nine of eleven rows read "someone · Sep 15" — not because nobody
 * ran them, but because the index's rebuild was overwriting the name the live
 * write had stored (fixed in `services/placeReportIndex.ts`). For the rows
 * already de-attributed the name is gone for good, and the honest way to say
 * so is to say nothing: a date with no name reads as a date, while "someone"
 * reads as a fact about a person.
 */
function whoAndWhen(analysis: Analysis): string {
  return [analysis.by, relativeTime(analysis.at)].filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="analysis-view">
    <div class="analysis-panel">
      <KbNav />
      <header class="analysis-header">
        <h1>Analysis</h1>
        <p class="lede">What you can run over what the library holds, and what has been run lately.
          Some tools work on the whole library; others need a working set, and say so.</p>
      </header>

      <ul class="tool-cards" data-testid="tool-cards">
        <li v-for="tool in TOOLS" :key="tool.id" class="tool-card" :data-tool="tool.id" data-testid="tool-card">
          <h2 class="tool-name">{{ tool.name }}</h2>
          <p class="tool-description">{{ tool.description }}</p>
          <p v-if="tool.hint" class="tool-hint" data-testid="tool-hint">{{ tool.hint }}</p>
          <RouterLink :to="tool.href" class="tool-start" data-testid="tool-start">Start</RouterLink>
        </li>
      </ul>

      <!-- P7-1: what an analysis runs AGAINST, above the record of what has
           been run. -->
      <section class="sets" data-testid="working-sets">
        <h2 class="recent-heading">Working sets</h2>
        <p class="section-lede">
          A named set of datasets and the sites they bear on. A place report run inside one asks that set's sources and
          no others.
        </p>

        <p v-if="loading" class="state-note" data-testid="sets-loading">Looking for working sets…</p>
        <p v-else-if="setRows.length === 0" class="state-note empty" data-testid="sets-empty">
          No working sets yet. Save a view you keep coming back to, then make a working set from it.
        </p>
        <ul v-else class="set-list">
          <li v-for="row in setRows" :key="row.set.slug" class="set-row" data-testid="set-row">
            <div class="row-title-line">
              <RouterLink :to="workingSetHref(row.set.slug)" class="row-title" data-testid="set-title">
                {{ row.set.name }}
              </RouterLink>
              <span class="badge kind-set" data-testid="set-progress">{{ row.progress }}</span>
            </div>
            <p v-if="row.set.purpose" class="row-line" data-testid="set-purpose">{{ row.set.purpose }}</p>
            <!-- A set may carry SEVERAL views, which is the point of the two
                 objects being two objects. -->
            <p class="set-views" data-testid="set-views">
              <template v-if="row.set.views.length">
                <span class="set-views-label">{{ row.set.views.length === 1 ? 'One view' : `${row.set.views.length} views` }}:</span>
                <RouterLink
                  v-for="view in row.set.views"
                  :key="view.slug"
                  :to="`/views/${view.slug}`"
                  class="set-view-link"
                  data-testid="set-view-link"
                >
                  {{ view.name }}
                </RouterLink>
              </template>
              <span v-else class="set-views-label" data-testid="set-no-views">No views of it yet</span>
            </p>
            <p class="set-actions">
              <RouterLink :to="workingSetPlaceHref(row.set.slug)" data-testid="set-place">Check a place in this set</RouterLink>
              ·
              <RouterLink :to="workingSetDatasetsHref(row.set.slug)" data-testid="set-datasets">Its datasets</RouterLink>
              <!-- P7-5, spec §F.5: a tool that operates on THIS set. It needs
                   both halves of the question — rows to measure FROM and a
                   feature layer to measure TO.
                   P9-3: when a half is missing, SAY SO rather than vanish.
                   P7-5 hid the control so it could not be refused, which is
                   right when a reader cannot act on the reason and wrong when
                   they can: both of these are things they set on the set. A
                   capability nobody can see is one nobody knows exists. -->
              <template v-if="measurableLayers(row.set).length">
                ·
                <button
                  v-if="row.set.sites"
                  type="button"
                  class="set-tool"
                  data-testid="set-proximity"
                  @click="openProximity(row.set)"
                >
                  {{ proximityFor === row.set.slug ? 'Close' : 'Measure proximity' }}
                </button>
                <span v-else class="set-tool-why" data-testid="set-proximity-why">
                  Measure proximity — needs an anchor table, the rows to measure from
                </span>
              </template>
              <!-- P7-8, spec §F.5: over ONE layer an index is that layer
                   rescaled, which the server refuses. Same P9-3 change: name
                   the missing half instead of disappearing. -->
              <template v-if="indexableLayers(row.set).length >= 2">
                ·
                <button type="button" class="set-tool" data-testid="set-index" @click="openIndex(row.set)">
                  {{ indexFor === row.set.slug ? 'Close' : 'Build an index' }}
                </button>
              </template>
              <template v-else>
                ·
                <span class="set-tool-why" data-testid="set-index-why">
                  Build an index — needs two or more county layers to weigh against each other
                </span>
              </template>
            </p>

            <form
              v-if="indexFor === row.set.slug"
              class="proximity"
              data-testid="index-form"
              @submit.prevent="buildIndex"
            >
              <p class="proximity-lede">
                A weighted score per county over this set's layers — written onto the set as a column the map and the
                table both read, and drawn as a layer of its own.
              </p>
              <div class="proximity-row">
                <label class="proximity-label" :for="`index-name-${row.set.slug}`">Call it</label>
                <input
                  :id="`index-name-${row.set.slug}`"
                  v-model="indexName"
                  class="index-name"
                  type="text"
                  maxlength="120"
                  placeholder="Political efficacy"
                  data-testid="index-name"
                />
              </div>
              <ul class="index-terms">
                <li v-for="layer in indexableLayers(row.set)" :key="layer.id" class="index-term" data-testid="index-term">
                  <label class="index-term-on">
                    <input
                      v-model="indexTerms[layer.id].on"
                      type="checkbox"
                      :data-testid="`index-on-${layer.id}`"
                    />
                    <span class="index-term-name">{{ layer.name }}</span>
                  </label>
                  <template v-if="indexTerms[layer.id].on">
                    <label class="proximity-label" :for="`index-w-${row.set.slug}-${layer.id}`">counts</label>
                    <input
                      :id="`index-w-${row.set.slug}-${layer.id}`"
                      v-model.number="indexTerms[layer.id].weight"
                      class="index-weight"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      :data-testid="`index-weight-${layer.id}`"
                    />
                    <!-- Pre-filled from what the layer declares, and left
                         editable: what a person leaves here is what gets
                         saved, so the stored formula never depends on a
                         manifest field somebody can edit later. -->
                    <select
                      v-model="indexTerms[layer.id].direction"
                      class="index-direction"
                      :aria-label="`Which end of ${layer.name} is better`"
                      :data-testid="`index-direction-${layer.id}`"
                    >
                      <option value="higher_better">higher is better</option>
                      <option value="lower_better">lower is better</option>
                    </select>
                  </template>
                </li>
              </ul>
              <div class="proximity-row">
                <button
                  type="submit"
                  class="promote-btn"
                  :disabled="indexFormula.length < 2 || !indexName.trim() || indexing"
                  data-testid="index-submit"
                >
                  {{ indexing ? 'Building…' : 'Build' }}
                </button>
                <span class="index-hint" data-testid="index-hint">
                  {{
                    indexFormula.length < 2
                      ? 'Pick at least two layers — over one layer an index is that layer rescaled.'
                      : `${indexFormula.length} layers. Weights are relative, so 6 and 4 is the same index as 3 and 2.`
                  }}
                </span>
              </div>

              <div v-if="indexRun" class="proximity-result" data-testid="index-result">
                <p class="proximity-done" :data-served="indexRun.served">
                  <span data-testid="index-served">{{ compositeServedLine(indexRun) }}</span>
                  <span class="proximity-counts" data-testid="index-counts">{{ compositeLine(indexRun) }}</span>
                </p>
                <!-- What each layer's 0 and 100 meant. An index whose scales
                     are unstated is a number nobody can check, and `method`
                     is one line where this is the whole record. -->
                <ul class="proximity-columns">
                  <li v-for="scale in indexRun.scales" :key="scale.layer" data-testid="index-scale">
                    {{ compositeTermLine(scale, indexNames[scale.layer]) }}
                  </li>
                </ul>
                <p class="proximity-where" data-testid="index-layer">
                  It draws as its own county layer, <code>{{ indexRun.layerId }}</code
                  >.
                </p>
                <p v-if="row.set.views.length" class="proximity-where">
                  Open it on
                  <RouterLink
                    v-for="view in row.set.views"
                    :key="view.slug"
                    :to="`/views/${view.slug}`"
                    class="set-view-link"
                    >{{ view.name }}</RouterLink
                  >
                </p>
                <p v-else class="proximity-where" data-testid="index-no-views">
                  Save a view of this set to see the column on a map or in a table.
                </p>
              </div>
              <p v-if="indexError" class="promote-note error" data-testid="index-error">{{ indexError }}</p>
            </form>

            <form
              v-if="proximityFor === row.set.slug"
              class="proximity"
              data-testid="proximity-form"
              @submit.prevent="measure"
            >
              <p class="proximity-lede">
                For each of <strong>{{ row.set.sites }}</strong>'s rows, the distance to the nearest feature — written
                onto this set as a column the map and the table both read.
              </p>
              <div class="proximity-row">
                <label class="proximity-label" :for="`prox-to-${row.set.slug}`">Measure to</label>
                <select :id="`prox-to-${row.set.slug}`" v-model="proximityTo" data-testid="proximity-to">
                  <option v-for="layer in measurableLayers(row.set)" :key="layer.id" :value="layer.id">
                    {{ layer.name }}
                  </option>
                </select>
                <label class="proximity-label" :for="`prox-within-${row.set.slug}`">and count within</label>
                <input
                  :id="`prox-within-${row.set.slug}`"
                  v-model="proximityWithin"
                  class="proximity-within"
                  type="number"
                  min="0.1"
                  max="500"
                  step="0.5"
                  placeholder="miles"
                  data-testid="proximity-within"
                />
                <button type="submit" class="promote-btn" :disabled="!proximityTo || measuring" data-testid="proximity-submit">
                  {{ measuring ? 'Measuring…' : 'Measure' }}
                </button>
              </div>

              <div v-if="proximityRun" class="proximity-result" data-testid="proximity-result">
                <p class="proximity-done" :data-served="proximityRun.served">
                  <!-- P7-6: three outcomes, not two. "Nothing recomputed" is
                       the feature and is said; "measured AGAIN, because the
                       sites table changed" is the one a reader must not read
                       as a first run, since the number just moved. -->
                  <span data-testid="proximity-served">{{ proximityServedLine(proximityRun) }}</span>
                  <span class="proximity-counts" data-testid="proximity-counts">{{ proximityLine(proximityRun) }}</span>
                </p>
                <ul class="proximity-columns">
                  <li v-for="column in proximityRun.columns" :key="column.id" data-testid="proximity-column">
                    {{ column.label }} — {{ column.counties }}
                    {{ column.counties === 1 ? 'county' : 'counties' }}
                  </li>
                </ul>
                <p v-if="row.set.views.length" class="proximity-where">
                  Open it on
                  <RouterLink
                    v-for="view in row.set.views"
                    :key="view.slug"
                    :to="`/views/${view.slug}`"
                    class="set-view-link"
                    >{{ view.name }}</RouterLink
                  >
                </p>
                <p v-else class="proximity-where" data-testid="proximity-no-views">
                  Save a view of this set to see the column on a map or in a table.
                </p>
              </div>
              <p v-if="proximityError" class="promote-note error" data-testid="proximity-error">{{ proximityError }}</p>
            </form>
          </li>
        </ul>

        <!-- The promote action. Deliberate, named, and only ever offered for a
             view that presents no set — there is no backfill and will not be
             one (spec §F.1). -->
        <form v-if="adHocViews.length" class="promote" data-testid="promote-form" @submit.prevent="promote">
          <label class="promote-label" for="promote-view">Make a working set from a saved view</label>
          <div class="promote-row">
            <select id="promote-view" v-model="promoteFrom" class="promote-select" data-testid="promote-view">
              <option value="">Choose a view…</option>
              <option v-for="view in adHocViews" :key="view.slug" :value="view.slug">{{ view.name }}</option>
            </select>
            <input
              v-model="promoteName"
              class="promote-name"
              type="text"
              placeholder="Name it (or keep the view's name)"
              data-testid="promote-name"
            />
            <button type="submit" class="promote-btn" :disabled="!promoteFrom || promoting" data-testid="promote-submit">
              {{ promoting ? 'Making…' : 'Make a working set' }}
            </button>
          </div>
          <p v-if="promoted" class="promote-note" data-testid="promote-done">
            Made from the view's layers — add the sources that bear on it to finish it.
            <RouterLink :to="workingSetDatasetsHref(promoted)">Add datasets</RouterLink>
          </p>
          <p v-if="promoteError" class="promote-note error" data-testid="promote-error">{{ promoteError }}</p>
        </form>
      </section>

      <section class="recent">
        <h2 class="recent-heading">Recent analyses</h2>
        <p v-if="loading" class="state-note" data-testid="analyses-loading">Looking for what has been run…</p>
        <p v-else-if="analyses.length === 0" class="state-note empty" data-testid="analyses-empty">
          Nothing has been run yet. Check a place or save a view and it will appear here.
        </p>
        <ul v-else class="analysis-list">
          <li v-for="analysis in analyses" :key="analysis.key">
            <component
              :is="analysis.href ? 'RouterLink' : 'div'"
              :to="analysis.href || undefined"
              class="analysis-row"
              data-testid="analysis-row"
            >
              <div class="row-title-line">
                <span class="row-title">{{ analysis.title }}</span>
                <span class="badge" :class="`kind-${analysis.kind}`" data-testid="analysis-kind">{{ analysis.kindLabel }}</span>
              </div>
              <div class="row-meta-line">
                <span v-if="analysis.line" class="row-line" data-testid="analysis-line">{{ analysis.line }}</span>
                <span v-if="whoAndWhen(analysis)" class="row-who" data-testid="analysis-who">{{ whoAndWhen(analysis) }}</span>
              </div>
            </component>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.analysis-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
  /* P5-60, the page-overflow fix — see DatasetsView for the long version. */
  min-width: 0;
}

.analysis-panel {
  width: 100%;
  max-width: 820px;
  min-width: 0;
}

.analysis-header h1 {
  margin: 0 0 6px;
  font-family: var(--blo-font-display);
  font-size: 1.7rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.lede {
  margin: 0 0 18px;
  font-size: 14px;
  color: var(--blo-stone);
}

.tool-cards {
  list-style: none;
  margin: 0 0 28px;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

/* --- Working sets (P7-1) -------------------------------------------------- */

.sets {
  margin-bottom: 28px;
}

.section-lede {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--blo-stone);
}

.set-list {
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
}

.set-row {
  padding: 10px 0;
  border-top: 1px solid var(--blo-cream-divider);
}

.set-row .row-title {
  font-size: 14px;
  color: var(--blo-ink);
  text-decoration: none;
}

.set-row .row-title:hover {
  text-decoration: underline;
}

.badge.kind-set {
  font-variant-numeric: tabular-nums;
}

.set-views,
.set-actions {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.set-views-label {
  margin-right: 4px;
}

.set-view-link:not(:last-child)::after {
  content: ',';
  color: var(--blo-stone);
}

.set-view-link,
.set-actions a {
  margin-right: 4px;
  color: inherit;
}

.promote {
  padding: 10px 12px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.promote-label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--blo-ink);
}

.promote-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.promote-select,
.promote-name {
  flex: 1 1 180px;
  min-width: 0;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.promote-btn {
  padding: 6px 12px;
  font-family: inherit;
  font-size: 13px;
  color: #ffffff;
  background: var(--blo-ink);
  border: 1px solid var(--blo-ink);
  border-radius: 6px;
  cursor: pointer;
}

.promote-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.promote-note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.promote-note.error {
  color: #9b2c2c;
}

.tool-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  min-width: 0;
}

.tool-name {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--blo-ink);
}

.tool-description {
  margin: 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.tool-hint {
  margin: 0;
  font-size: 12px;
  font-style: italic;
  color: var(--blo-stone);
}

.tool-start {
  align-self: flex-start;
  margin-top: 8px;
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  text-decoration: none;
  background: var(--blo-ink);
  border: 1px solid var(--blo-ink);
  border-radius: 6px;
}

.recent-heading {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.state-note {
  font-size: 14px;
  color: var(--blo-stone);
}

.analysis-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.analysis-row {
  display: block;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  text-decoration: none;
  color: inherit;
  transition: box-shadow 120ms ease;
}

a.analysis-row:hover {
  box-shadow: var(--blo-shadow-panel);
}

.row-title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.row-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--blo-ink);
}

.row-meta-line {
  margin-top: 6px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.badge {
  padding: 1px 8px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--blo-cream-divider);
  color: var(--blo-stone);
  background: rgba(17, 17, 17, 0.03);
  font-weight: 600;
}

.badge.kind-place {
  color: #7a4f01;
  border-color: #ffe082;
  background: #fff8e1;
}

.badge.kind-compare {
  color: #00695c;
  border-color: #80cbc4;
  background: #e0f2f1;
}

.badge.kind-map {
  color: #0d47a1;
  border-color: #90caf9;
  background: #e3f2fd;
}

.badge.kind-table {
  color: #4a3b76;
  border-color: #c5b8e6;
  background: #f1edfb;
}

.row-line,
.row-who {
  font-size: 12px;
  color: var(--blo-stone);
}

/* --- Phone (P5-60) ---------------------------------------------------------
   One card per row, a thumb-sized Start, and nothing that can widen the page. */
@media (max-width: 640px) {
  .analysis-view {
    padding: 20px 12px 40px;
  }

  .analysis-view,
  .analysis-panel,
  .analysis-header {
    min-width: 0;
    max-width: 100%;
  }

  .analysis-header h1 {
    font-size: clamp(20px, 6.5vw, 1.7rem);
  }

  .tool-cards {
    grid-template-columns: minmax(0, 1fr);
  }

  .tool-start {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .lede,
  .state-note,
  .tool-description,
  .tool-hint,
  .row-meta-line,
  .row-line,
  .row-who {
    font-size: 14px;
  }

  .badge {
    font-size: 13px;
  }
}

/* P7-5: the proximity tool on a set's row. */
.set-tool-why {
  color: #6b6560;
  font-size: 0.86rem;
}

.set-tool {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--blo-green, #2f6b4f);
  text-decoration: underline;
  cursor: pointer;
}
.set-tool:hover {
  text-decoration: none;
}
.proximity {
  margin: 10px 0 0;
  padding: 12px 14px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
}
.proximity-lede {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.45;
  color: #4a4a44;
}
.proximity-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.proximity-label {
  font-size: 13px;
  color: #4a4a44;
}
.proximity-row select {
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 6px;
  background: #fff;
  max-width: 260px;
}
.index-name {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 0.3rem 0.5rem;
  font: inherit;
  border: 1px solid var(--blo-border, #d5d8dd);
  border-radius: 4px;
}

.index-terms {
  margin: 0.5rem 0 0.25rem;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.index-term {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.index-term-on {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 14rem;
  cursor: pointer;
}

.index-term-name {
  font-weight: 500;
}

.index-weight {
  width: 4.5rem;
  padding: 0.25rem 0.4rem;
  font: inherit;
  border: 1px solid var(--blo-border, #d5d8dd);
  border-radius: 4px;
}

.index-direction {
  padding: 0.25rem 0.4rem;
  font: inherit;
}

.index-hint {
  font-size: 0.82rem;
  color: var(--blo-muted, #5a6472);
}

.proximity-within {
  width: 92px;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  border: 1px solid rgba(0, 0, 0, 0.18);
  border-radius: 6px;
}
.proximity-result {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid rgba(0, 0, 0, 0.08);
}
.proximity-done {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: #2f6b4f;
}
/* The counts, not the sentence: P7-6 put a second span in this paragraph, and
   a bare `span` selector would strip the headline's own emphasis. The leading
   space is explicit because Vue condenses the whitespace-only text node
   between two elements, which ran "recomputed." into "9 of 11 rows". */
.proximity-counts {
  font-weight: 400;
  color: #4a4a44;
}
.proximity-counts::before {
  content: ' ';
  white-space: pre;
}
.proximity-columns {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 13px;
  color: #4a4a44;
}
.proximity-where {
  margin: 8px 0 0;
  font-size: 13px;
  color: #4a4a44;
}
</style>