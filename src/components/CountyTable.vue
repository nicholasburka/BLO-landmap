<script setup lang="ts">
/**
 * One public map layer's numbers, county by county (P5-45).
 *
 * The dataset explorer (P5-31/42) does this for library tables by asking the
 * server. A public layer has no server side — its CSV is already in the
 * browser because the map loads it — so search, sort, paging and the CSV all
 * happen here over the rows the page hands in. The parent owns loading, so
 * this component stays a pure view of an array.
 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import type { LayerDefinition } from '@/config/layerRegistry'
import {
  csvFilename,
  filterCountyRows,
  pageOf,
  rowsToCsv,
  sortCountyRows,
  type CountySortKey,
  type CountyValueRow,
  type SortDirection,
} from '@/lib/publicLayers'
import { MAX_COMPARE_COUNTIES, addToShortlist, isShortlisted, shortlist } from '@/lib/compare'
import { useAuth } from '@/composables/useAuth'

const props = withDefaults(
  defineProps<{
    layer: LayerDefinition
    rows: CountyValueRow[]
    loading: boolean
    error?: string
    pageSize?: number
  }>(),
  { error: '', pageSize: 50 },
)

const emit = defineEmits<{
  /**
   * The GEOIDs of the rows this table is showing — the search applied, the
   * page not, the same set "Download what I see" writes out (P6-14). The
   * layer page hands them to its submap as `query.only`, which is the one
   * thing a `?layers=…` link cannot say: *this* subset is the answer.
   */
  (e: 'shown', geoIds: string[]): void
}>()

const PAGE_SIZES = [25, 50, 100, 200]

/** P5-55: reading one layer's numbers is how a candidate county gets
 *  noticed, so this is where a shortlist starts. The column exists only for
 *  logged-in users — the same table renders for nobody else, but the guard
 *  is here rather than assumed from the route. */
const { internalUser } = useAuth()
const canShortlist = computed(() => !!internalUser.value)

/** Recomputed from the shared list, so adding a county here also lights up
 *  the Compare badge in the nav and any other table on screen. */
function shortlistState(geoId: string): 'added' | 'full' | 'open' {
  if (isShortlisted(geoId)) return 'added'
  return shortlist.value.length >= MAX_COMPARE_COUNTIES ? 'full' : 'open'
}

function shortlistLabel(geoId: string): string {
  const state = shortlistState(geoId)
  return state === 'added' ? 'On shortlist' : state === 'full' ? 'Shortlist full' : 'Add to shortlist'
}

const search = ref('')
const sortKey = ref<CountySortKey>('name')
const sortDir = ref<SortDirection>('asc')
const page = ref(1)
const size = ref(props.pageSize)

const filtered = computed(() => filterCountyRows(props.rows, search.value))
const sorted = computed(() => sortCountyRows(filtered.value, sortKey.value, sortDir.value))
const pageCount = computed(() => Math.max(1, Math.ceil(sorted.value.length / size.value)))
const visible = computed(() => pageOf(sorted.value, page.value, size.value))

// Reported rather than exposed: a host that wants to draw these rows should
// not have to reach into this component for them.
watch(filtered, rows => emit('shown', rows.map(r => r.geoId)), { immediate: true })

/** "3,142 counties" — or "18 of 3,142 counties" once a search narrows it. */
const showing = computed(() => {
  const total = props.rows.length.toLocaleString()
  if (filtered.value.length === props.rows.length) return `${total} counties`
  return `${filtered.value.length.toLocaleString()} of ${total} counties`
})

// A narrower list means the page you were on may not exist any more.
watch([search, () => props.rows, size], () => {
  page.value = 1
})

function sortBy(key: CountySortKey): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else {
    sortKey.value = key
    sortDir.value = 'asc'
  }
  page.value = 1
}

function arrow(key: CountySortKey): string {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'desc' ? '↓' : '↑'
}

function ariaSort(key: CountySortKey): 'ascending' | 'descending' | 'none' {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'desc' ? 'descending' : 'ascending'
}

function goPage(next: number): void {
  page.value = Math.min(Math.max(1, next), pageCount.value)
}

function changeSize(event: Event): void {
  size.value = Number((event.target as HTMLSelectElement).value) || props.pageSize
}

/** "Download what I see": the searched and sorted list, not the whole layer.
 *  Built on click rather than as a computed — a 3,000-row CSV rebuilt on
 *  every keystroke would be work nobody asked for. */
let objectUrl = ''
function releaseUrl(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}

function downloadCsv(): void {
  const csv = rowsToCsv(props.layer, sorted.value)
  releaseUrl()
  objectUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = csvFilename(props.layer)
  link.click()
}

onBeforeUnmount(releaseUrl)
</script>

<template>
  <section class="county-table" data-testid="county-table" aria-label="County values">
    <div class="toolbar">
      <input
        v-model="search"
        type="search"
        class="search-input"
        placeholder="Search counties…"
        aria-label="Search counties"
        data-testid="county-search"
      />
      <span class="showing" data-testid="county-showing">{{ showing }}</span>
      <button type="button" class="tool-btn touch-target" data-testid="county-download" @click="downloadCsv">Download as CSV</button>
    </div>

    <p v-if="error" class="state-note error" data-testid="county-error">{{ error }}</p>

    <div v-else class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th :aria-sort="ariaSort('name')">
              <button type="button" class="sort-btn touch-target" data-testid="sort-name" @click="sortBy('name')">
                County <span class="sort-arrow">{{ arrow('name') }}</span>
              </button>
            </th>
            <th class="state-col">State</th>
            <th class="num" :aria-sort="ariaSort('value')">
              <button type="button" class="sort-btn touch-target" data-testid="sort-value" @click="sortBy('value')">
                {{ layer.name }} <span class="sort-arrow">{{ arrow('value') }}</span>
              </button>
            </th>
            <th v-if="canShortlist" class="shortlist-col">Compare</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in loading && rows.length === 0 ? 6 : 0" :key="`sk-${n}`" data-testid="county-skeleton" aria-hidden="true">
            <td><span class="sk"></span></td>
            <td><span class="sk"></span></td>
            <td><span class="sk"></span></td>
            <td v-if="canShortlist"><span class="sk"></span></td>
          </tr>
          <tr v-for="r in visible" :key="r.geoId" data-testid="county-row">
            <td>{{ r.county }}</td>
            <td class="state-col">{{ r.state }}</td>
            <td class="num">{{ r.display }}</td>
            <td v-if="canShortlist" class="shortlist-col">
              <button
                type="button"
                class="shortlist-btn touch-target"
                :class="{ added: shortlistState(r.geoId) === 'added' }"
                :disabled="shortlistState(r.geoId) !== 'open'"
                :title="shortlistState(r.geoId) === 'full' ? `A comparison holds at most ${MAX_COMPARE_COUNTIES} counties` : undefined"
                data-testid="county-shortlist"
                @click="addToShortlist(r.geoId)"
              >
                {{ shortlistLabel(r.geoId) }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <p v-if="!loading && sorted.length === 0" class="state-note" data-testid="county-empty">
        No county matches “{{ search }}”.
      </p>
    </div>

    <footer v-if="!error" class="pager">
      <label class="page-size">
        Rows per page
        <select :value="size" aria-label="Rows per page" @change="changeSize">
          <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
        </select>
      </label>
      <button type="button" class="tool-btn touch-target" data-testid="county-prev" :disabled="page <= 1" @click="goPage(page - 1)">← Prev</button>
      <span data-testid="county-page">Page {{ page }} of {{ pageCount }}</span>
      <button type="button" class="tool-btn touch-target" data-testid="county-next" :disabled="page >= pageCount" @click="goPage(page + 1)">
        Next →
      </button>
    </footer>
  </section>
</template>

<style scoped>
.county-table {
  margin-top: 8px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.search-input {
  flex: 1 1 220px;
  min-width: 0;
  padding: 8px 12px;
  font: inherit;
  font-size: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.showing {
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.tool-btn {
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  cursor: pointer;
}

.tool-btn:hover:not(:disabled) {
  border-color: var(--blo-green-deep, #1f7a2e);
  color: var(--blo-green-deep, #1f7a2e);
}

.tool-btn:disabled {
  color: var(--blo-stone-soft, #9a948e);
  cursor: default;
}

.table-scroll {
  overflow-x: auto;
  /* Keeps the table's width inside this box instead of on the page (P5-60). */
  max-width: 100%;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: var(--blo-radius-panel, 10px);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.data-table th,
.data-table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
  white-space: nowrap;
}

.data-table th {
  position: sticky;
  top: 0;
  background: var(--blo-cream-deep, #ede8dd);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--blo-stone, #6b6560);
}

.data-table tbody tr:last-child td {
  border-bottom: 0;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
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
  color: var(--blo-green-deep, #1f7a2e);
}

.sort-arrow {
  color: var(--blo-green-deep, #1f7a2e);
}

.sk {
  display: block;
  height: 12px;
  width: 70%;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--blo-cream-deep, #ede8dd) 25%, #fff 50%, var(--blo-cream-deep, #ede8dd) 75%);
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s infinite;
}

@keyframes sk-shimmer {
  to {
    background-position: -200% 0;
  }
}

.state-note {
  margin: 12px;
  font-size: 14px;
  color: var(--blo-stone, #6b6560);
}

.state-note.error {
  color: #b71c1c;
}

.pager {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 10px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.page-size select {
  margin-left: 6px;
  font: inherit;
  padding: 4px 6px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  background: #fff;
}

.shortlist-col {
  white-space: nowrap;
}

.shortlist-btn {
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.shortlist-btn:hover:not(:disabled) {
  border-color: var(--blo-green-deep, #1f7a2e);
}

.shortlist-btn:disabled {
  cursor: default;
}

.shortlist-btn.added {
  color: var(--blo-stone, #6b6560);
}

/* --- Phone (P5-60) ---------------------------------------------------------
   3,000 counties on a 375 px screen: the state column goes (it is already in
   the county's own row on the map), the county name stays pinned while the
   numbers scroll under your thumb, and every control — sort, page, shortlist
   — is a 44 px target. */
@media (max-width: 640px) {
  .state-col {
    display: none;
  }

  .toolbar {
    gap: 8px;
  }

  .search-input {
    flex: 1 1 100%;
    min-height: 44px;
    font-size: 16px;
  }

  .showing {
    font-size: 14px;
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  /* A header cell IS the sort control. */
  .data-table thead th {
    height: 44px;
    padding: 0 12px;
    font-size: 13px;
  }

  .sort-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    height: 44px;
  }

  .data-table td {
    padding: 10px 12px;
  }

  /* The county name is the row's label; it stays put while the value
     scrolls. Opaque backgrounds so nothing shows through it. */
  .data-table th:first-child,
  .data-table td:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    background: #fff;
    box-shadow: 1px 0 0 var(--blo-cream-divider, #e0d9ca);
  }

  .data-table thead th:first-child {
    z-index: 3;
    background: var(--blo-cream-deep, #ede8dd);
  }

  .shortlist-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  .pager {
    gap: 10px;
    font-size: 14px;
  }

  .page-size,
  .page-size select {
    min-height: 44px;
    font-size: 14px;
  }

  .state-note {
    font-size: 14px;
  }
}
</style>
