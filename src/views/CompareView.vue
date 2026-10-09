<script setup lang="ts">
/**
 * County comparison (P5-55): a handful of candidate counties, side by side,
 * across the layers that matter.
 *
 * The map scores places one layer at a time; this page is the next question —
 * "of these five counties, which one?" — and it has to answer it in a form a
 * researcher can export, embed and come back to. So:
 *
 *  - the URL is the state (`?counties=…&layers=…`): every comparison is a
 *    link, and the pickers only ever rewrite the URL,
 *  - only the layers actually asked for are loaded, one loader per layer,
 *  - best and worst are marked PER LAYER, read through that layer's own
 *    direction, and labelled "best of these" — they rank these counties, not
 *    all 3,000,
 *  - saving turns the shortlist into a `type: 'compare'` view, which is what
 *    makes it embeddable in a page like any other view.
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { friendlyError } from '@/lib/errors'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import AskBox from '@/components/AskBox.vue'
import MapPane from '@/components/MapPane.vue'
import { useShowOnMap } from '@/composables/useShowOnMap'
import type { LayerDefinition } from '@/config/layerRegistry'
import { directionLabel, groupLayers, publicLayers, searchLayers } from '@/lib/publicLayers'
import { mapUrlForLayers } from '@/lib/mapDeepLinks'
import { fetchView, fetchViews, saveView, compareStateOf, type SavedViewSummary } from '@/lib/views'
import {
  COMPARE_CSV_FILENAME,
  MAX_COMPARE_COUNTIES,
  MAX_COMPARE_LAYERS,
  NOTE_MAX_CHARS,
  buildCompareRows,
  clearShortlist,
  compareCsv,
  compareLayerIndex,
  compareHeading,
  compareQuestion,
  compareUrl,
  loadCompareCounties,
  loadLayerColumn,
  parseCompareUrl,
  searchCounties,
  shortlist,
  sortCompareRows,
  type CompareCounty,
  type LayerColumn,
  type SortDirection,
} from '@/lib/compare'

const route = useRoute()
const router = useRouter()

// --- URL state ---------------------------------------------------------------

const urlState = computed(() => parseCompareUrl(route.query as Record<string, string | string[] | null | undefined>))
const geoIds = computed(() => urlState.value.counties)
const layerIds = computed(() => urlState.value.layers)
const viewSlug = computed(() => urlState.value.view)

/** Every change goes through the URL, so Back works and any comparison on
 *  screen can be copied out of the address bar. `replace` keeps the history
 *  from filling with one entry per checkbox. */
function go(counties: string[], layers: string[]): void {
  void router.replace(compareUrl({ counties, layers, ...(viewSlug.value ? { view: viewSlug.value } : {}) }))
}

function addCounty(geoId: string): void {
  if (geoIds.value.includes(geoId) || geoIds.value.length >= MAX_COMPARE_COUNTIES) return
  go([...geoIds.value, geoId], layerIds.value)
}

function removeCounty(geoId: string): void {
  go(geoIds.value.filter(id => id !== geoId), layerIds.value)
}

function toggleLayer(layerId: string): void {
  if (layerIds.value.includes(layerId)) go(geoIds.value, layerIds.value.filter(id => id !== layerId))
  else if (layerIds.value.length < MAX_COMPARE_LAYERS) go(geoIds.value, [...layerIds.value, layerId])
}

// --- The counties being compared ----------------------------------------------

const counties = ref<CompareCounty[]>([])

watch(
  geoIds,
  async ids => {
    counties.value = await loadCompareCounties(ids)
  },
  { immediate: true },
)

/** Counties waiting on the shortlist that are not in this comparison yet —
 *  the reason "Add to shortlist" on the map and on a layer's table is worth
 *  anything. Offered as one click rather than silently applied: arriving at
 *  a saved comparison should not quietly change it. */
const waiting = computed(() => shortlist.value.filter(id => !geoIds.value.includes(id)))

function addWaiting(): void {
  go([...geoIds.value, ...waiting.value].slice(0, MAX_COMPARE_COUNTIES), layerIds.value)
  clearShortlist()
}

// --- The layers being compared -------------------------------------------------

/** Public layers ship in the bundle, so the picker draws at once; the
 *  internal ones replace this the moment the manifest lands. */
const layerById = ref(new Map<string, LayerDefinition>(publicLayers().map(l => [l.id, l])))
void compareLayerIndex().then(index => {
  layerById.value = index
})

const allLayers = computed(() => [...layerById.value.values()])
const selectedLayers = computed(() =>
  layerIds.value.map(id => layerById.value.get(id)).filter((l): l is LayerDefinition => !!l),
)

const layerQuery = ref('')
const layerGroups = computed(() => groupLayers(searchLayers(allLayers.value, layerQuery.value)))

// --- The numbers ----------------------------------------------------------------

const columns = ref<Record<string, LayerColumn>>({})
const loading = ref<string[]>([])
const loadErrors = ref<string[]>([])

/** Load exactly the layers on screen, once each. A comparison of four layers
 *  must never pull the map's whole data set. */
watch(
  selectedLayers,
  layers => {
    for (const layer of layers) {
      if (columns.value[layer.id] || loading.value.includes(layer.id)) continue
      loading.value = [...loading.value, layer.id]
      void loadLayerColumn(layer)
        .then(column => {
          columns.value = { ...columns.value, [layer.id]: column }
          loadErrors.value = loadErrors.value.filter(name => name !== layer.name)
        })
        .catch(() => {
          // One layer that will not load is an empty column with a note, not
          // a broken page — the other columns are still the comparison.
          columns.value = { ...columns.value, [layer.id]: {} }
          if (!loadErrors.value.includes(layer.name)) loadErrors.value = [...loadErrors.value, layer.name]
        })
        .finally(() => {
          loading.value = loading.value.filter(id => id !== layer.id)
        })
    }
  },
  { immediate: true },
)

const stillLoading = computed(() => selectedLayers.value.some(l => !columns.value[l.id]))

const sortKey = ref('name')
const sortDir = ref<SortDirection>('asc')

const rows = computed(() =>
  sortCompareRows(buildCompareRows(counties.value, selectedLayers.value, columns.value), sortKey.value, sortDir.value),
)

function sortBy(key: string): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
}

function arrow(key: string): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'desc' ? '↓' : '↑'
}

function ariaSort(key: string): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'desc' ? 'descending' : 'ascending'
}

/** The plain label behind a highlighted cell — it ranks THESE counties. */
function rankTitle(rank: 'best' | 'worst' | null): string | undefined {
  return rank === 'best' ? 'best of these' : rank === 'worst' ? 'worst of these' : undefined
}

/** P5-60: at 375 px a full layer name in every column header pushed the
 *  table 400 px past the screen. The header shows this short form on a phone
 *  (the full name is the button's title, its aria-label, and the legend under
 *  the table); a wide screen still shows the whole thing. */
const SHORT_HEADER_CHARS = 12
function shortLayerName(name: string): string {
  return name.length > SHORT_HEADER_CHARS ? `${name.slice(0, SHORT_HEADER_CHARS - 1).trimEnd()}…` : name
}

const heading = computed(() => compareHeading(counties.value.length, selectedLayers.value.length))
const isEmpty = computed(() => counties.value.length === 0 || selectedLayers.value.length === 0)

const question = computed(() =>
  compareQuestion(
    counties.value.map(c => (c.state ? `${c.county}, ${c.state}` : c.county)),
    selectedLayers.value.map(l => l.name),
  ),
)

/** "Show on map": the layers on, and the map framed on these counties. Still
 *  the shareable address of this view, and what a narrow window gets; the
 *  button itself opens the pane below (P6-14). */
const mapHref = computed(() => mapUrlForLayers(layerIds.value, null, geoIds.value))

// --- Show on map, in place (P6-14) ------------------------------------------
// The link already framed the shortlist — `&fit=` is exactly these counties.
// What it could not do was *say* they were the answer: it drew the whole layer
// and framed a box around the right part of it. `only` says it, so the
// counties being compared are the saturated ones and the rest of the country
// dims behind them. And the comparison is still on screen behind the map.

const map = useShowOnMap({
  layers: () => layerIds.value,
  only: () => geoIds.value,
})

/** The compared layers by name. `activeName` would say "BLO Livability Index"
 *  for any two of them, which is not what is on this map. */
const paneTitle = computed(() =>
  selectedLayers.value.length ? selectedLayers.value.map(l => l.name).join(' · ') : '',
)

const paneNote = computed(() =>
  geoIds.value.length === 1 ? '1 county' : `${geoIds.value.length} counties`,
)

// --- Notes ------------------------------------------------------------------------

const notes = ref<Record<string, string>>({})

function noteFor(geoId: string): string {
  return notes.value[geoId] ?? ''
}

function setNote(geoId: string, text: string): void {
  notes.value = { ...notes.value, [geoId]: text.slice(0, NOTE_MAX_CHARS) }
}

// --- Download ----------------------------------------------------------------------

let objectUrl = ''
function releaseUrl(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}
onBeforeUnmount(releaseUrl)

function downloadCsv(): void {
  const csv = compareCsv(rows.value, selectedLayers.value, notes.value)
  releaseUrl()
  objectUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = COMPARE_CSV_FILENAME
  link.click()
}

// --- Saving, and the comparisons already saved --------------------------------------

const saveOpen = ref(false)
const saveName = ref('')
const saving = ref(false)
const saveError = ref('')
/** The view just saved, so the confirmation can name it and open it —
 *  the same line the map and the table show (P5-69). */
const savedNote = ref<{ slug: string; name: string } | null>(null)
const savedViews = ref<SavedViewSummary[]>([])

function loadSavedViews(): void {
  void fetchViews({ type: 'compare' })
    .then(list => {
      savedViews.value = list
    })
    .catch(() => {
      savedViews.value = []
    })
}
loadSavedViews()

async function submitSave(): Promise<void> {
  const name = saveName.value.trim()
  if (!name || saving.value) return
  saving.value = true
  saveError.value = ''
  try {
    const kept: Record<string, string> = {}
    for (const county of counties.value) {
      const note = noteFor(county.geoId).trim()
      if (note) kept[county.geoId] = note
    }
    const saved = await saveView({
      name,
      type: 'compare',
      state: {
        counties: geoIds.value,
        layers: layerIds.value,
        ...(Object.keys(kept).length > 0 ? { notes: kept } : {}),
      },
      results: [],
    })
    savedNote.value = { slug: saved.slug, name: saved.name }
    saveOpen.value = false
    saveName.value = ''
    loadSavedViews()
  } catch (err) {
    saveError.value = friendlyError(err, 'Could not save this view. Try again.')
  } finally {
    saving.value = false
  }
}

/** A comparison opened from a saved view names itself, and brings its notes
 *  back — the counties and layers already came in through the URL. */
const savedName = ref('')
watch(
  viewSlug,
  async slug => {
    savedName.value = ''
    if (!slug) return
    try {
      const view = await fetchView(slug)
      const state = view && compareStateOf(view)
      if (!view || !state) return
      savedName.value = view.name
      notes.value = { ...state.notes }
    } catch {
      // A deleted or unreadable view just means no banner; the URL still
      // carries a perfectly good comparison.
    }
  },
  { immediate: true },
)

// --- The county picker ---------------------------------------------------------------

const countyQuery = ref('')
const countyMatches = ref<CompareCounty[]>([])

watch(countyQuery, async query => {
  const asked = query
  const matches = await searchCounties(query)
  // A slow lookup must not overwrite the results of a later keystroke.
  if (asked === countyQuery.value) countyMatches.value = matches
})

function pick(county: CompareCounty): void {
  addCounty(county.geoId)
  countyQuery.value = ''
  countyMatches.value = []
}
</script>

<template>
  <div class="compare-view">
    <div class="compare-panel">
      <header class="compare-header">
        <h1 data-testid="compare-heading">{{ heading }}</h1>
        <p class="lede">
          Put candidate counties next to each other on the layers that matter. Best and worst are marked within this
          shortlist, not against the whole country.
        </p>
        <p v-if="savedName" class="saved-banner" data-testid="compare-saved-banner">
          Saved comparison: <strong>{{ savedName }}</strong>
        </p>
      </header>
      <KbNav />

      <section v-if="savedViews.length" class="saved-strip" data-testid="saved-comparisons">
        <h2 class="section-name">Saved comparisons</h2>
        <ul class="saved-list">
          <li v-for="view in savedViews" :key="view.slug" data-testid="saved-comparison">
            <RouterLink :to="`/views/${view.slug}`" class="saved-link">{{ view.name }}</RouterLink>
            <span class="saved-meta">{{ view.description }}</span>
          </li>
        </ul>
      </section>

      <section class="pickers">
        <div class="picker">
          <h2 class="section-name">Counties</h2>
          <ul v-if="counties.length" class="chips">
            <li v-for="county in counties" :key="county.geoId" class="chip" data-testid="county-chip">
              {{ county.county }}<span v-if="county.state">, {{ county.state }}</span>
              <button
                type="button"
                class="chip-remove touch-target"
                :aria-label="`Remove ${county.county}`"
                data-testid="remove-county"
                @click="removeCounty(county.geoId)"
              >
                ✕
              </button>
            </li>
          </ul>
          <p v-if="waiting.length" class="waiting" data-testid="shortlist-waiting">
            {{ waiting.length }} {{ waiting.length === 1 ? 'county is' : 'counties are' }} waiting on your shortlist.
            <button type="button" class="link-btn touch-target" data-testid="add-waiting" @click="addWaiting">Add them</button>
          </p>
          <input
            v-model="countyQuery"
            type="search"
            class="search-input"
            placeholder="Search counties by name or state…"
            aria-label="Search counties"
            :disabled="geoIds.length >= MAX_COMPARE_COUNTIES"
            data-testid="county-search"
          />
          <p v-if="geoIds.length >= MAX_COMPARE_COUNTIES" class="picker-note">
            A comparison holds at most {{ MAX_COMPARE_COUNTIES }} counties. Remove one to add another.
          </p>
          <ul v-if="countyMatches.length" class="matches" data-testid="county-matches">
            <li v-for="match in countyMatches" :key="match.geoId">
              <button type="button" class="match-btn touch-target" data-testid="county-match" @click="pick(match)">
                {{ match.county }}, {{ match.state }}
              </button>
            </li>
          </ul>
        </div>

        <div class="picker">
          <h2 class="section-name">Layers</h2>
          <input
            v-model="layerQuery"
            type="search"
            class="search-input"
            placeholder="Search layers by name or what they measure…"
            aria-label="Search map layers"
            data-testid="layer-search"
          />
          <p v-if="layerIds.length >= MAX_COMPARE_LAYERS" class="picker-note">
            A comparison holds at most {{ MAX_COMPARE_LAYERS }} layers. Uncheck one to add another.
          </p>
          <div v-for="group in layerGroups" :key="group.category" class="layer-group">
            <h3 class="group-name" data-testid="layer-group-name">{{ group.label }}</h3>
            <ul class="layer-list">
              <li v-for="layer in group.layers" :key="layer.id">
                <label class="layer-option touch-target" data-testid="layer-option">
                  <input
                    type="checkbox"
                    :checked="layerIds.includes(layer.id)"
                    :disabled="!layerIds.includes(layer.id) && layerIds.length >= MAX_COMPARE_LAYERS"
                    @change="toggleLayer(layer.id)"
                  />
                  <span class="layer-name">{{ layer.name }}</span>
                  <span class="layer-direction">{{ directionLabel(layer.direction) }}</span>
                </label>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <p v-if="isEmpty" class="state-note" data-testid="compare-empty">Pick at least one county and one layer.</p>

      <template v-else>
        <div class="toolbar">
          <!-- Wide enough for a map beside the table: open one here rather
               than navigating away from the comparison (P6-14). Narrower
               than that, the deep link stands. -->
          <button
            v-if="map.canOpen.value"
            type="button"
            class="tool-btn touch-target"
            data-testid="compare-map-open"
            :aria-expanded="map.isOpen.value"
            @click="map.toggle()"
          >Show on map</button>
          <RouterLink v-else :to="mapHref" class="tool-btn touch-target" data-testid="compare-map">Show on map</RouterLink>
          <button type="button" class="tool-btn touch-target" data-testid="compare-download" @click="downloadCsv">
            Download CSV
          </button>
          <button v-if="!saveOpen" type="button" class="tool-btn touch-target" data-testid="compare-save" @click="saveOpen = true">
            Save view
          </button>
          <form v-else class="save-form" data-testid="compare-save-form" @submit.prevent="submitSave">
            <input
              v-model="saveName"
              type="text"
              class="save-name"
              placeholder="Name this comparison"
              aria-label="Name this comparison"
              maxlength="80"
              :disabled="saving"
              data-testid="compare-save-name"
            />
            <button type="submit" class="tool-btn touch-target primary" :disabled="saving || !saveName.trim()">
              {{ saving ? 'Saving…' : 'Save' }}
            </button>
            <button type="button" class="tool-btn touch-target" data-testid="compare-save-cancel" :disabled="saving" @click="saveOpen = false">Cancel</button>
          </form>
        </div>

        <p v-if="saveError" class="state-note error" data-testid="compare-save-error">{{ saveError }}</p>
        <!-- P5-69: the map, the table and this page all confirm a save the
             same way, and all three link to the view they just made. -->
        <p v-if="savedNote" class="saved-note" data-testid="compare-saved">
          Saved —
          <RouterLink :to="`/views/${savedNote.slug}`" class="saved-link">open “{{ savedNote.name }}”</RouterLink>
          · embed it in a page with <code>view:{{ savedNote.slug }}</code>
        </p>
        <p v-if="loadErrors.length" class="state-note error" data-testid="compare-load-error">
          Couldn't load {{ loadErrors.join(', ') }}. Those columns are blank.
        </p>

        <div class="table-scroll">
          <table class="compare-table" data-testid="compare-table">
            <thead>
              <tr>
                <th :aria-sort="ariaSort('name')">
                  <button type="button" class="sort-btn touch-target" data-testid="sort-name" @click="sortBy('name')">
                    County <span class="sort-arrow">{{ arrow('name') }}</span>
                  </button>
                </th>
                <th v-for="layer in selectedLayers" :key="layer.id" class="num" :aria-sort="ariaSort(layer.id)">
                  <button
                    type="button"
                    class="sort-btn touch-target"
                    :title="layer.name"
                    :aria-label="`Sort by ${layer.name}`"
                    :data-testid="`sort-${layer.id}`"
                    @click="sortBy(layer.id)"
                  >
                    <span class="head-full">{{ layer.name }}</span>
                    <span class="head-short" aria-hidden="true">{{ shortLayerName(layer.name) }}</span>
                    <span class="sort-arrow">{{ arrow(layer.id) }}</span>
                  </button>
                  <span class="direction-cue" data-testid="direction-cue">{{ directionLabel(layer.direction) }}</span>
                </th>
                <th class="notes-col">Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="stillLoading" data-testid="compare-skeleton" aria-hidden="true">
                <td v-for="n in selectedLayers.length + 2" :key="`sk-${n}`"><span class="sk"></span></td>
              </tr>
              <tr v-for="row in rows" :key="row.geoId" data-testid="compare-row">
                <th scope="row" class="county-cell">
                  {{ row.county }}
                  <span v-if="row.state" class="county-state">{{ row.state }}</span>
                  <!-- P5-58: the numbers say how this county compares; the
                       report says what is actually sitting in it. -->
                  <RouterLink
                    :to="`/place?geoid=${row.geoId}`"
                    class="county-report"
                    :aria-label="`Place report for ${row.county}`"
                    data-testid="compare-report"
                  >
                    Report
                  </RouterLink>
                </th>
                <td
                  v-for="cell in row.cells"
                  :key="cell.layerId"
                  class="num"
                  :class="cell.rank ? `rank-${cell.rank}` : ''"
                  :title="rankTitle(cell.rank)"
                  :data-rank="cell.rank || undefined"
                  data-testid="compare-cell"
                >
                  {{ cell.display }}
                  <span v-if="cell.rank" class="rank-label">{{ rankTitle(cell.rank) }}</span>
                </td>
                <td class="notes-col">
                  <textarea
                    class="note-input"
                    rows="2"
                    :maxlength="NOTE_MAX_CHARS"
                    :placeholder="`Notes on ${row.county}`"
                    :aria-label="`Notes on ${row.county}`"
                    :value="noteFor(row.geoId)"
                    data-testid="compare-note"
                    @input="setNote(row.geoId, ($event.target as HTMLTextAreaElement).value)"
                  ></textarea>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- The key to the shortened column headers. Only drawn on a phone
             (see the media query), where the headers are abbreviated. -->
        <ul class="layer-legend" data-testid="compare-legend">
          <li v-for="layer in selectedLayers" :key="layer.id" data-testid="compare-legend-row">
            <span class="legend-short">{{ shortLayerName(layer.name) }}</span>
            <span class="legend-full">{{ layer.name }}</span>
          </li>
        </ul>

        <section class="ask-section">
          <h2 class="section-name">Ask about these counties</h2>
          <AskBox :model-value="question" label="Ask about this comparison" />
        </section>
      </template>
    </div>

    <!-- The submap (P6-14). A sibling of the comparison, not a replacement
         for it: the route never changes and closing it leaves the shortlist,
         the sort and the notes exactly as they were. -->
    <MapPane
      v-if="map.isOpen.value"
      class="compare-map-pane"
      testid="compare-map-pane"
      :layers="map.state.layers"
      :query="map.state.query"
      :data="map.state.data"
      :fit="map.fit.value"
      :title="paneTitle"
      :note="paneNote"
      label="These counties on the map"
      @close="map.close()"
    />
  </div>
</template>

<style scoped>
.compare-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  gap: 20px;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
  /* P5-60, the page-overflow fix — the 403 px the audit measured at 375 px.
     App.vue lays the shell out with `display: flex` on `main`, so this
     route root is a flex item, and a flex item's automatic minimum size is its
     content's min-content width — here, the comparison table's. Without this
     the document scrolls sideways (837 px of it at a 375 px viewport in a
     reduced test page) however well `.table-scroll` clips. */
  min-width: 0;
}

.compare-panel {
  width: 100%;
  max-width: 1100px;
  /* The comparison table scrolls inside `.table-scroll`; without this the
     panel is a flex item that grows to the table's width and takes the whole
     page sideways with it (P5-60). */
  min-width: 0;
}

/* The submap (P6-14). A column of its own; `MapPane` lays out the header and
   the map inside it. Not sticky: these route roots are viewport-height flex
   items of App.vue's `main`, so a sticky child's containing block is only one
   screen tall and would scroll away with it anyway. */
.compare-map-pane {
  flex: 0 0 26rem;
  align-self: flex-start;
  height: calc(100vh - 140px);
  min-height: 24rem;
}

/* Below the pane's breakpoint there is no pane: `useMapPane` will not open
   one and closes any that is open, and this is the belt to that braces. */
@media (max-width: 1023px) {
  .compare-map-pane {
    display: none;
  }
}

/* P9-15: one page-title treatment across the app. */
.compare-header h1 {
  margin: 0 0 4px;
  font-family: var(--blo-font-display);
  font-size: 1.7rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.lede {
  margin: 0 0 8px;
  font-size: 14px;
  color: var(--blo-stone);
}

.saved-banner {
  margin: 0 0 12px;
  font-size: 14px;
  color: var(--blo-ink);
}

.section-name {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft);
}

.saved-strip {
  margin-bottom: 18px;
}

.saved-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.saved-link {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.saved-link:hover {
  text-decoration: underline;
}

.saved-meta {
  margin-left: 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.pickers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin-bottom: 18px;
}

.picker {
  padding: 14px 16px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  font: inherit;
  font-size: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.picker-note {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

.chips {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 8px;
  padding: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 10px;
  font-size: 13px;
  background: var(--blo-cream-deep);
  border-radius: 999px;
}

.chip-remove {
  padding: 0 4px;
  font: inherit;
  font-size: 12px;
  color: var(--blo-stone);
  background: none;
  border: 0;
  cursor: pointer;
}

.chip-remove:hover {
  color: var(--blo-ink);
}

.waiting {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.link-btn {
  padding: 0;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep);
  background: none;
  border: 0;
  cursor: pointer;
  text-decoration: underline;
}

.matches {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 190px;
  overflow-y: auto;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.match-btn {
  display: block;
  width: 100%;
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--blo-ink);
  background: none;
  border: 0;
  cursor: pointer;
}

.match-btn:hover {
  background: var(--blo-cream-deep);
}

.layer-group {
  margin-top: 10px;
}

.group-name {
  margin: 0 0 2px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone-soft);
}

.layer-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.layer-option {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
  cursor: pointer;
}

.layer-name {
  color: var(--blo-ink);
}

.layer-direction {
  font-size: 11px;
  color: var(--blo-stone-soft);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.tool-btn {
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  cursor: pointer;
  text-decoration: none;
}

.tool-btn:hover:not(:disabled) {
  border-color: var(--blo-green-deep);
  color: var(--blo-green-deep);
}

.tool-btn:disabled {
  color: var(--blo-stone-soft);
  cursor: default;
}

.tool-btn.primary {
  color: #fff;
  background: var(--blo-green-deep);
  border-color: var(--blo-green-deep);
}

.tool-btn.primary:hover:not(:disabled) {
  color: #fff;
}

.save-form {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.save-name {
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.saved-note {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--blo-stone);
}

.saved-note code {
  padding: 1px 5px;
  background: var(--blo-cream-deep);
  border-radius: 4px;
}

.state-note {
  margin: 16px 2px;
  font-size: 14px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b71c1c;
}

.table-scroll {
  overflow-x: auto;
  max-width: 100%;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

/* The abbreviated header and its key: each is shown at exactly one width. */
.head-short,
.layer-legend {
  display: none;
}

.compare-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.compare-table th,
.compare-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.compare-table thead th {
  background: var(--blo-cream-deep);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--blo-stone);
  white-space: nowrap;
}

.compare-table tbody tr:last-child td,
.compare-table tbody tr:last-child th {
  border-bottom: 0;
}

.county-cell {
  font-weight: 600;
  white-space: nowrap;
}

.county-state {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--blo-stone);
}

.county-report {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.county-report:hover {
  text-decoration: underline;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.direction-cue {
  display: block;
  font-size: 10px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
  color: var(--blo-stone-soft);
}

.rank-best {
  background: rgba(31, 122, 46, 0.08);
}

.rank-worst {
  background: rgba(183, 28, 28, 0.06);
}

.rank-label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  color: var(--blo-stone);
}

.rank-best .rank-label {
  color: var(--blo-green-deep);
}

.notes-col {
  min-width: 180px;
}

.note-input {
  width: 100%;
  padding: 6px 8px;
  font: inherit;
  font-size: 13px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  resize: vertical;
}

.sort-btn {
  padding: 0;
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  cursor: pointer;
  text-transform: inherit;
  letter-spacing: inherit;
}

.sort-btn:hover {
  color: var(--blo-green-deep);
}

.sort-arrow {
  color: var(--blo-green-deep);
}

.sk {
  display: block;
  height: 12px;
  width: 70%;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--blo-cream-deep) 25%, #fff 50%, var(--blo-cream-deep) 75%);
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s infinite;
}

@keyframes sk-shimmer {
  to {
    background-position: -200% 0;
  }
}

.ask-section {
  margin-top: 22px;
}

@media (max-width: 780px) {
  .pickers {
    grid-template-columns: 1fr;
  }
}

/* --- Phone (P5-60) ---------------------------------------------------------
   The audit found this page 403 px wider than the screen with its heading cut
   off. Here: the heading scales and wraps, the table's width lives inside
   `.table-scroll` with the county column pinned, the layer headers shrink to
   an abbreviation (full name in `title` and in the legend under the table),
   and every chip ×, checkbox and button is a 44 px target. */
@media (max-width: 640px) {
  .compare-view {
    padding: 20px 12px 40px;
  }

  .compare-header h1 {
    font-size: clamp(20px, 6.5vw, 1.7rem);
    line-height: 1.2;
    overflow-wrap: anywhere;
  }

  .lede,
  .saved-banner,
  .picker-note,
  .waiting,
  .saved-meta,
  .saved-note,
  .state-note {
    font-size: 14px;
  }

  .section-name,
  .group-name {
    font-size: 13px;
  }

  /* Saved comparisons: one swipeable line rather than a stack of links. */
  .saved-list {
    grid-auto-flow: column;
    grid-auto-columns: minmax(180px, max-content);
    overflow-x: auto;
    gap: 10px;
    scrollbar-width: none;
  }

  .saved-list li {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 44px;
  }

  .saved-meta {
    margin-left: 0;
  }

  .search-input {
    min-height: 44px;
    font-size: 16px;
  }

  .chip {
    font-size: 14px;
    padding: 0 0 0 12px;
  }

  .chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    font-size: 15px;
  }

  .link-btn {
    display: inline;
    font-size: 14px;
  }

  .match-btn {
    min-height: 44px;
    font-size: 15px;
  }

  .matches {
    max-height: 240px;
  }

  /* A 13 px checkbox is not a tap target: 20 px box, and the whole 44 px
     label row takes the tap. */
  .layer-option {
    align-items: center;
    /* The shared `.touch-target` centres its content; a checklist row reads
       from the left. */
    justify-content: flex-start;
    gap: 12px;
    min-height: 44px;
    padding: 4px 0;
    font-size: 15px;
  }

  .layer-option input[type='checkbox'] {
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
  }

  .layer-direction {
    font-size: 13px;
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  .toolbar {
    gap: 8px;
  }

  /* Naming and annotating both get the whole width. */
  .save-form {
    flex: 1 1 100%;
    flex-wrap: wrap;
  }

  .save-name {
    flex: 1 1 100%;
    min-height: 44px;
    font-size: 16px;
  }

  .compare-table {
    font-size: 14px;
  }

  .compare-table th,
  .compare-table td {
    padding: 8px 10px;
  }

  .compare-table thead th {
    font-size: 13px;
  }

  /* The county is the row's label: it stays put while the layers scroll. */
  .compare-table thead th:first-child,
  .county-cell {
    position: sticky;
    left: 0;
    z-index: 2;
    background: #fff;
    box-shadow: 1px 0 0 var(--blo-cream-divider);
  }

  .compare-table thead th:first-child {
    z-index: 3;
    background: var(--blo-cream-deep);
  }

  .county-state {
    font-size: 13px;
  }

  .county-report {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .sort-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
  }

  .head-full {
    display: none;
  }

  .head-short {
    display: inline;
  }

  .direction-cue,
  .rank-label {
    font-size: 12px;
  }

  .notes-col {
    min-width: 160px;
  }

  .note-input {
    font-size: 15px;
  }

  /* The key to those abbreviated headers. */
  .layer-legend {
    display: grid;
    gap: 4px;
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    font-size: 14px;
    color: var(--blo-stone);
  }

  .layer-legend li {
    display: flex;
    gap: 8px;
  }

  .legend-short {
    flex: 0 0 auto;
    font-weight: 600;
    color: var(--blo-ink);
  }
}
</style>
