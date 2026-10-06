<script setup lang="ts">
/**
 * "Fetch for a place" (P5-57).
 *
 * A source entry indexes a dataset we do not hold. This panel is where a
 * person turns that index into an answer about somewhere real: name a place,
 * press Run, and the server fetches exactly that slice, caches it, and hands
 * back the rows. A slice that keeps mattering gets saved as a dataset and the
 * ordinary explorer and map pipeline takes over.
 *
 * Everything here is deliberately plain: three ways to say where, one number
 * for how far, one button. The geocoding, the guard and the adapters are the
 * server's business — the panel only has to be honest about what came back and
 * what went wrong.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  csvFilename,
  defaultRadius,
  fetchForPlace,
  fetchSlices,
  placeLabel,
  promoteSlice,
  sortRows,
  toCsv,
  type PlaceFetchRequest,
  type PlaceFetchResult,
  type SliceSummary,
  type SortDirection,
} from '@/lib/placeFetch'
import { radiusLabel, type SourceMeta } from '@/lib/libraryCatalog'
import { findCounty, initCountyLookup, type CountyLookup } from '@/lib/countyLookup'
import { relativeTime } from '@/lib/kb'
import { friendlyError } from '@/lib/errors'
import { usePhoneLayout, useBodyScrollLock } from '@/composables/usePhoneLayout'

const props = defineProps<{
  slug: string
  source: SourceMeta
  /** The map's current centre, when the caller has one. Absent on the library
   *  entry page, which has no map of its own. */
  mapCenter?: { lat: number; lng: number } | null
  /** A slice to open on arrival — `?place=<cacheKey>`, the link Ask and MCP
   *  hand back. It reads from the cache, so it costs the agency nothing. */
  openPlace?: string
}>()

const emit = defineEmits<{ (e: 'promoted', slug: string): void }>()

type Mode = 'address' | 'county' | 'center'

const mode = ref<Mode>('address')
const address = ref('')
const radius = ref(defaultRadius(props.source.placeQuery?.radiusMiles))
const countyQuery = ref('')
const countyMatches = ref<CountyLookup[]>([])
const county = ref<CountyLookup | null>(null)
const countyError = ref('')

const running = ref(false)
const error = ref('')
const result = ref<PlaceFetchResult | null>(null)
const slices = ref<SliceSummary[]>([])
const saving = ref(false)
const savedSlug = ref('')

const modes = computed<{ key: Mode; label: string }[]>(() => [
  { key: 'address', label: 'An address' },
  { key: 'county', label: 'A county' },
  ...(props.mapCenter ? [{ key: 'center' as const, label: "The map's centre" }] : []),
])

/** The radius only matters when we are looking around a point — a county is a
 *  whole area, not a circle. */
const usesRadius = computed(() => mode.value !== 'county')

/** P5-60: on a phone this panel is a bottom sheet over the entry page. The
 *  handle collapses it to a title strip — the same gesture the entity rail
 *  uses — so the page underneath is reachable without leaving the panel, and
 *  the page only holds still while the sheet is actually open. */
const collapsed = ref(false)
const isPhone = usePhoneLayout()
const sheetOpen = computed(() => isPhone.value && !collapsed.value)
useBodyScrollLock(sheetOpen)

const canRun = computed(() => {
  if (running.value) return false
  if (mode.value === 'address') return address.value.trim().length > 1
  if (mode.value === 'county') return !!county.value
  return !!props.mapCenter
})

async function loadSlices(): Promise<void> {
  try {
    slices.value = await fetchSlices(props.slug)
  } catch {
    // The list is a convenience; failing to load it must not stop a fetch.
    slices.value = []
  }
}

/** Load the list, and open the slice a deep link asked for if we hold it. */
async function start(): Promise<void> {
  await loadSlices()
  if (!props.openPlace) return
  const wanted = slices.value.find(s => s.cacheKey === props.openPlace)
  if (wanted) openSlice(wanted)
}
void start()

watch(() => props.slug, () => {
  result.value = null
  error.value = ''
  savedSlug.value = ''
  void start()
})

// --- The county picker -------------------------------------------------------

let lookupReady: Promise<void> | null = null

/** "Fulton, GA" and "Fulton County GA" both mean the same place. */
function splitCountyQuery(raw: string): { name: string; state?: string } {
  const parts = raw.split(',')
  if (parts.length > 1) return { name: parts[0].trim(), state: parts.slice(1).join(',').trim() }
  const words = raw.trim().split(/\s+/)
  const last = words[words.length - 1]
  if (words.length > 1 && /^[A-Za-z]{2}$/.test(last)) return { name: words.slice(0, -1).join(' '), state: last }
  return { name: raw.trim() }
}

async function searchCounties(): Promise<void> {
  countyError.value = ''
  const raw = countyQuery.value.trim()
  if (raw.length < 2) {
    countyMatches.value = []
    return
  }
  try {
    lookupReady = lookupReady ?? initCountyLookup()
    await lookupReady
    const { name, state } = splitCountyQuery(raw)
    countyMatches.value = findCounty(name, state).slice(0, 12)
    if (!countyMatches.value.length) countyError.value = `No county called "${raw}".`
  } catch {
    lookupReady = null
    countyError.value = 'The county list did not load. Try an address instead.'
  }
}

function chooseCounty(match: CountyLookup): void {
  county.value = match
  countyQuery.value = `${match.name}, ${match.stateAbbr}`
  countyMatches.value = []
}

// --- Running -----------------------------------------------------------------

function requestFor(): PlaceFetchRequest {
  const radiusMiles = usesRadius.value ? Number(radius.value) : undefined
  if (mode.value === 'county') return { geoid: county.value!.geoId }
  if (mode.value === 'center') return { point: props.mapCenter!, radiusMiles }
  return { address: address.value.trim(), radiusMiles }
}

async function run(request: PlaceFetchRequest = requestFor()): Promise<void> {
  running.value = true
  error.value = ''
  savedSlug.value = ''
  try {
    result.value = await fetchForPlace(props.slug, request)
    sortColumn.value = ''
    await loadSlices()
  } catch (err: unknown) {
    result.value = null
    error.value = friendlyError(err, 'that fetch did not work. Try again, or a smaller radius.')
  } finally {
    running.value = false
  }
}

/** Open a slice we already hold. It runs the same request, which the server
 *  answers from the cache — so "Open" is instant and never asks the agency. */
function openSlice(slice: SliceSummary): void {
  const place = slice.place
  if (place?.geoid && place.lat === null) void run({ geoid: place.geoid })
  else if (place?.lat !== null && place?.lng !== null) void run({ point: { lat: place.lat!, lng: place.lng! }, radiusMiles: place.radiusMiles })
}

async function save(): Promise<void> {
  if (!result.value) return
  saving.value = true
  error.value = ''
  try {
    const saved = await promoteSlice(props.slug, result.value.cacheKey)
    savedSlug.value = saved.slug
    emit('promoted', saved.slug)
    await loadSlices()
  } catch (err: unknown) {
    error.value = friendlyError(err, 'that did not save. Try again in a moment.')
  } finally {
    saving.value = false
  }
}

// --- The table ---------------------------------------------------------------

const sortColumn = ref('')
const sortDir = ref<SortDirection>('asc')

const sortedRows = computed(() => {
  const rows = result.value?.rows ?? []
  return sortColumn.value ? sortRows(rows, sortColumn.value, sortDir.value) : rows
})

function sortBy(column: string): void {
  if (sortColumn.value === column) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortColumn.value = column
    sortDir.value = 'asc'
  }
}

function arrow(column: string): string {
  if (sortColumn.value !== column) return ''
  return sortDir.value === 'desc' ? '↓' : '↑'
}

function ariaSort(column: string): 'ascending' | 'descending' | 'none' {
  if (sortColumn.value !== column) return 'none'
  return sortDir.value === 'desc' ? 'descending' : 'ascending'
}

/** Built on click, not as a computed: a CSV rebuilt on every sort is work
 *  nobody asked for. */
let objectUrl = ''
function releaseUrl(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}
onBeforeUnmount(releaseUrl)

function downloadCsv(): void {
  if (!result.value) return
  const csv = toCsv(result.value.columns, sortedRows.value)
  releaseUrl()
  objectUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = csvFilename(props.slug, result.value.cacheKey)
  link.click()
}

const resultLine = computed(() => {
  const r = result.value
  if (!r) return ''
  const where = placeLabel(r.place)
  const rows = `${r.count.toLocaleString()} ${r.count === 1 ? 'row' : 'rows'}`
  const when = r.cached ? `read from what we already had, fetched ${relativeTime(r.fetchedAt)}` : 'fetched just now'
  return `${rows} for ${where} — ${when}.`
})
</script>

<template>
  <section class="place-panel sheet" :class="{ 'sheet--collapsed': collapsed }" data-testid="place-fetch-panel">
    <!-- Phone only: the sheet's grab handle. Tapping it drops the panel to a
         title strip so the entry page behind it is reachable again. -->
    <button
      type="button"
      class="sheet-handle"
      :aria-expanded="!collapsed"
      aria-label="Collapse or expand the place fetcher"
      data-testid="place-sheet-handle"
      @click="collapsed = !collapsed"
    >
      <span aria-hidden="true"></span>
    </button>
    <h3>Fetch for a place</h3>
    <div class="sheet-body">
      <p class="panel-hint">
        We do not hold this dataset. Name a place and we will fetch just that piece of it, keep it, and show you the rows.
      </p>

      <!-- One segmented control: three ways to say where, one of them on. -->
      <div class="mode-row" role="group" aria-label="How to say where">
        <button
          v-for="m in modes"
          :key="m.key"
          type="button"
          class="mode-btn touch-target"
          :class="{ active: mode === m.key }"
          :aria-pressed="mode === m.key"
          :data-testid="`mode-${m.key}`"
          @click="mode = m.key"
        >
          {{ m.label }}
        </button>
      </div>

      <div v-if="mode === 'address'" class="field">
        <label for="place-address">Address or place name</label>
        <input
          id="place-address"
          v-model="address"
          type="text"
          placeholder="1040 Westview Dr SW, Atlanta, GA"
          data-testid="place-address"
          @keyup.enter="canRun && run()"
        />
      </div>

      <div v-else-if="mode === 'county'" class="field">
        <label for="place-county">County</label>
        <input
          id="place-county"
          v-model="countyQuery"
          type="text"
          placeholder="Fulton, GA"
          data-testid="place-county"
          @input="county = null"
          @keyup.enter="searchCounties"
        />
        <button type="button" class="find-btn touch-target" data-testid="find-county" @click="searchCounties">Find</button>
        <ul v-if="countyMatches.length" class="county-matches" data-testid="county-matches">
          <li v-for="match in countyMatches" :key="match.geoId">
            <button type="button" class="touch-target" @click="chooseCounty(match)">{{ match.name }}, {{ match.stateAbbr }}</button>
          </li>
        </ul>
        <p v-if="countyError" class="field-note" data-testid="county-error">{{ countyError }}</p>
        <p v-else-if="county" class="field-note" data-testid="county-chosen">{{ county.name }}, {{ county.stateAbbr }}</p>
      </div>

      <p v-else class="field-note" data-testid="center-note">
        Looking around where the map is now: {{ mapCenter?.lat.toFixed(4) }}, {{ mapCenter?.lng.toFixed(4) }}
      </p>

      <div v-if="usesRadius" class="field radius-field">
        <label for="place-radius">How far around it</label>
        <input id="place-radius" v-model.number="radius" type="number" min="0.1" max="100" step="0.25" data-testid="place-radius" />
        <span class="field-note">{{ radiusLabel(Number(radius)) }}</span>
      </div>

      <div class="run-row">
        <button type="button" class="run-btn touch-target" :disabled="!canRun" data-testid="place-run" @click="run()">
          {{ running ? 'Fetching…' : 'Run' }}
        </button>
        <button
          v-if="result"
          type="button"
          class="link-btn touch-target"
          :disabled="running"
          data-testid="place-refresh"
          @click="run({ ...requestFor(), refresh: true })"
        >
          Fetch it again
        </button>
      </div>

      <p v-if="error" class="place-error" data-testid="place-error">{{ error }}</p>

      <div v-if="result" class="place-result" data-testid="place-result">
        <p class="result-line" data-testid="place-result-line">{{ resultLine }}</p>
        <p v-if="result.truncated" class="field-note" data-testid="place-truncated">
          The source had more than we kept — this is the first slice of it.
        </p>

        <div v-if="result.count" class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th v-for="c in result.columns" :key="c" :aria-sort="ariaSort(c)">
                  <button type="button" class="sort-btn touch-target" :data-testid="`sort-${c}`" @click="sortBy(c)">
                    {{ c }} <span class="sort-arrow">{{ arrow(c) }}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in sortedRows" :key="i">
                <td v-for="c in result.columns" :key="c">{{ row[c] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="field-note" data-testid="place-empty">
          Nothing here for that place. That can mean the area is clear, or that this source has never mapped it.
        </p>

        <div class="result-actions strip">
          <button v-if="result.count" type="button" class="link-btn touch-target" data-testid="place-csv" @click="downloadCsv">
            Download CSV
          </button>
          <button
            v-if="result.count"
            type="button"
            class="link-btn touch-target"
            :disabled="saving || !!savedSlug"
            data-testid="place-save"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save as dataset' }}
          </button>
          <!-- P5-57: "Show on map" needs an ad-hoc point layer, which lives in
               Map.vue (owned by P5-55). Saving the slice as a dataset already
               puts it through the normal layer pipeline, so this says so
               plainly rather than offering a button that does nothing. -->
          <span v-if="result.geometry" class="field-note" data-testid="place-map-note">
            Map preview coming — save it as a dataset to draw it today.
          </span>
        </div>

        <p v-if="savedSlug" class="saved-note" data-testid="place-saved">
          Saved.
          <RouterLink :to="`/library/${savedSlug}`">Open the new dataset</RouterLink>
        </p>
      </div>

      <div v-if="slices.length" class="slice-list" data-testid="place-slices">
        <h4>Places we already have</h4>
        <ul>
          <li v-for="slice in slices" :key="slice.cacheKey" class="slice-row">
            <span class="slice-place">{{ placeLabel(slice.place) }}</span>
            <span class="field-note">{{ slice.count.toLocaleString() }} rows · {{ relativeTime(slice.fetchedAt) }}</span>
            <button type="button" class="link-btn touch-target" :data-testid="`open-${slice.cacheKey}`" @click="openSlice(slice)">Open</button>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>

<style scoped>
.place-panel {
  border: 1px solid var(--color-border, #e2e2e2);
  border-radius: 8px;
  padding: 1rem;
  margin-top: 1rem;
  background: var(--color-background-soft, #fafafa);
}

.place-panel h3 {
  margin: 0 0 0.25rem;
  font-size: 1rem;
}

.panel-hint {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--color-text-soft, #666);
  max-width: 60ch;
}

.mode-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.mode-btn {
  border: 1px solid var(--color-border, #ddd);
  background: transparent;
  border-radius: 999px;
  padding: 0.25rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
}

.mode-btn.active {
  background: var(--color-text, #222);
  color: var(--color-background, #fff);
  border-color: var(--color-text, #222);
}

.field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.6rem;
}

.field label {
  font-size: 0.8rem;
  color: var(--color-text-soft, #666);
  min-width: 9rem;
}

.field input[type='text'] {
  flex: 1 1 18rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--color-border, #ddd);
  border-radius: 4px;
  font: inherit;
}

.radius-field input {
  width: 6rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--color-border, #ddd);
  border-radius: 4px;
  font: inherit;
}

.field-note {
  font-size: 0.8rem;
  color: var(--color-text-soft, #666);
  margin: 0;
}

.county-matches {
  list-style: none;
  margin: 0;
  padding: 0;
  flex-basis: 100%;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.county-matches button,
.find-btn {
  border: 1px solid var(--color-border, #ddd);
  background: transparent;
  border-radius: 4px;
  padding: 0.25rem 0.6rem;
  font-size: 0.85rem;
  cursor: pointer;
}

.run-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.run-btn {
  padding: 0.4rem 1rem;
  border: none;
  border-radius: 4px;
  background: var(--color-text, #222);
  color: var(--color-background, #fff);
  font: inherit;
  cursor: pointer;
}

.run-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 0.85rem;
  color: var(--color-link, #2563eb);
  text-decoration: underline;
  cursor: pointer;
}

.link-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.place-error {
  margin: 0.75rem 0 0;
  font-size: 0.85rem;
  color: #b3261e;
}

.place-result {
  margin-top: 1rem;
}

.result-line {
  margin: 0 0 0.5rem;
  font-size: 0.9rem;
}

.table-scroll {
  overflow-x: auto;
  max-height: 24rem;
  overflow-y: auto;
  border: 1px solid var(--color-border, #eee);
  border-radius: 4px;
}

.data-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.85rem;
}

.data-table th,
.data-table td {
  padding: 0.35rem 0.6rem;
  text-align: left;
  border-bottom: 1px solid var(--color-border, #eee);
  white-space: nowrap;
}

.data-table th {
  position: sticky;
  top: 0;
  background: var(--color-background, #fff);
  font-weight: 600;
}

.sort-btn {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.sort-arrow {
  color: var(--color-text-soft, #888);
}

.result-actions {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}

.saved-note {
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
}

.slice-list {
  margin-top: 1rem;
  border-top: 1px solid var(--color-border, #eee);
  padding-top: 0.75rem;
}

.slice-list h4 {
  margin: 0 0 0.4rem;
  font-size: 0.85rem;
  color: var(--color-text-soft, #666);
}

.slice-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}

.slice-row {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  padding: 0.2rem 0;
  flex-wrap: wrap;
}

.slice-place {
  font-size: 0.9rem;
}

/* Only a sheet on a phone; an ordinary card everywhere else. */
.sheet-handle {
  display: none;
}

.table-scroll {
  max-width: 100%;
}

/* --- Phone (P5-60) ---------------------------------------------------------
   The panel takes the bottom of the screen: a segmented control for the three
   ways to say where, 44 px inputs and buttons, the results table scrolling
   inside its own box, and the actions as a strip. The handle drops it to a
   title strip so the entry page behind it is reachable. */
@media (max-width: 640px) {
  .place-panel.sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    margin-top: 0;
    max-height: 85svh;
    overflow-y: auto;
    border: none;
    border-top: 1px solid var(--color-border, #e2e2e2);
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.16);
    padding: 8px 1rem calc(1rem + env(safe-area-inset-bottom, 0px));
    background: var(--color-background, #fff);
    transition: max-height 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .sheet--collapsed {
    max-height: 84px;
    overflow: hidden;
  }

  .sheet--collapsed .sheet-body {
    display: none;
  }

  /* The shared `.sheet-handle` is the 4 px bar itself; here the bar is the
     span inside a 44 px button, so height and background are taken back. */
  .sheet-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: auto;
    min-height: 44px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }

  .sheet-handle span {
    display: block;
    width: 36px;
    height: 4px;
    margin: 0 auto;
    border-radius: 2px;
    background: var(--color-border, #ddd);
  }

  .place-panel h3 {
    font-size: 1.05rem;
  }

  .panel-hint,
  .field-note,
  .place-error,
  .saved-note,
  .result-line,
  .slice-place {
    font-size: 0.9rem;
  }

  /* Segmented control: the three modes share one row and one border. */
  .mode-row {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 0;
    flex-wrap: nowrap;
    border: 1px solid var(--color-border, #ddd);
    border-radius: 999px;
    overflow: hidden;
  }

  .mode-btn {
    min-height: 44px;
    padding: 0 0.5rem;
    font-size: 0.9rem;
    border: none;
    border-radius: 0;
  }

  .mode-btn + .mode-btn {
    border-left: 1px solid var(--color-border, #ddd);
  }

  .field {
    align-items: stretch;
    flex-direction: column;
    gap: 0.35rem;
  }

  .field label {
    min-width: 0;
    font-size: 0.85rem;
  }

  .field input[type='text'],
  .radius-field input {
    flex: 1 1 auto;
    width: 100%;
    min-height: 44px;
    font-size: 16px;
  }

  .find-btn,
  .county-matches button {
    min-height: 44px;
    padding: 0 0.9rem;
    font-size: 0.9rem;
  }

  .run-row {
    gap: 1rem;
  }

  .run-btn {
    min-height: 44px;
    padding: 0 1.25rem;
    font-size: 1rem;
  }

  .link-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 0.9rem;
  }

  .data-table {
    font-size: 0.9rem;
  }

  .sort-btn {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-height: 44px;
  }

  /* One swipeable line of actions. */
  .result-actions {
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .result-actions > * {
    flex: 0 0 auto;
  }

  .slice-row {
    align-items: center;
    min-height: 44px;
  }
}
</style>
