<template>
  <section class="counties" data-testid="set-counties">
    <p v-if="!cols.length" class="state-note" data-testid="counties-empty">
      This set names no county layers and has no derived columns, so there is nothing to show per
      county yet. Add a county layer to it, or weigh one into an index.
    </p>

    <template v-else>
      <p class="counties-line" data-testid="counties-line">
        {{ shown.length.toLocaleString() }} of {{ rows.length.toLocaleString() }}
        {{ rows.length === 1 ? 'county' : 'counties' }}, by
        <strong>{{ sortLabel }}</strong
        >. <span class="counties-hint">Press a column to sort by it.</span>
      </p>

      <div class="counties-scroll">
        <table class="counties-table">
          <thead>
            <tr>
              <th scope="col" class="c-name">
                <button type="button" class="c-sort" data-testid="county-sort" @click="sortBy('')">
                  County<span v-if="sort === ''" class="c-dir">{{ dir === 'asc' ? '▲' : '▼' }}</span>
                </button>
              </th>
              <th v-for="col in cols" :key="col.id" scope="col" class="c-num">
                <button
                  type="button"
                  class="c-sort"
                  :data-testid="`county-sort-${col.id}`"
                  @click="sortBy(col.id)"
                >
                  {{ col.name }}<span v-if="sort === col.id" class="c-dir">{{ dir === 'asc' ? '▲' : '▼' }}</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shown" :key="row.geoId" data-testid="county-row">
              <th scope="row" class="c-name">{{ row.name }}</th>
              <td v-for="col in cols" :key="col.id" class="c-num" :class="{ blank: row.cells[col.id] === null }">
                {{ print(row.cells[col.id], col) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- P9-7's distinction, said once rather than guessed at per cell. -->
      <p v-if="anyBlank" class="counties-key" data-testid="counties-key">
        <strong>—</strong> is measured-but-missing: nobody recorded a number for that county.
        <template v-if="anyCounted"><strong>0</strong> is counted-and-absent — the thing was looked for and is not there.</template>
      </p>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * What a working set says about each county (P11-5).
 *
 * The Data tab showed the set's ANCHOR table — for a set anchored on sites,
 * a list of sites; for a set of county layers, the sentence "this set is not
 * anchored on a table we hold". Neither answers *what does this set say about
 * a county*, which is the question a county-level set exists to answer.
 *
 * Nothing is fetched here. Every number already exists on the page: the
 * county layers are what the map is scoring, the derived columns came back
 * with the set, and a point layer is rolled up by `countPointsByCounty` —
 * the same rollup the free analyses use, so this table and the analysis above
 * it can never disagree about a count.
 */
import { computed, ref } from 'vue'
import type { DerivedColumn } from '@/lib/workingSets'
import { getCountyByGeoId } from '@/lib/countyLookup'
import { readable } from '@/lib/layerStats'

/**
 * Rows rendered at once.
 *
 * The country is 3,215 counties and this table is five to ten columns wide,
 * so rendering all of it is thirty thousand cells for a page somebody is
 * going to sort and read the top of. Sorting is the mechanism for getting to
 * what you want; the line above the table says what you are looking at, so
 * the cap is stated rather than silent.
 */
const ROWS_SHOWN = 250

const props = defineProps<{
  /** The set's analysable layers: county layers, and point layers as counts. */
  layers: { id: string; name: string }[]
  /** The set's derived columns, values and all. */
  columns: DerivedColumn[]
  /** Values for one layer id, and whether absence means zero. */
  valuesFor: (id: string) => { values: Record<string, number>; counted?: boolean }
  /** Every county any of the set's layers measures. */
  universe: string[]
}>()

interface Col {
  id: string
  name: string
  unit: string
  /** True when a county with no entry has NONE of the thing, rather than no
   *  measurement — a rollup counts every point, so absence is a zero. */
  counted: boolean
}

const cols = computed<Col[]>(() => [
  ...props.layers.map(layer => {
    const got = props.valuesFor(layer.id)
    return { id: layer.id, name: layer.name, unit: '', counted: got.counted === true }
  }),
  ...props.columns.map(column => ({
    id: column.id,
    name: column.label,
    unit: column.unit,
    counted: false,
  })),
])

/** One lookup per column, not one per cell: 250 rows × 8 columns is 2,000
 *  cell reads and `valuesFor` rolls points up on every call. */
const valuesByCol = computed(() => {
  const out: Record<string, Record<string, number>> = {}
  for (const layer of props.layers) out[layer.id] = props.valuesFor(layer.id).values
  for (const column of props.columns) out[column.id] = column.values
  return out
})

interface Row {
  geoId: string
  name: string
  /** False when the lookup has no name and the GEOID is standing in. */
  named: boolean
  cells: Record<string, number | null>
}

const rows = computed<Row[]>(() => {
  const byCol = valuesByCol.value
  const geoIds = new Set(props.universe)
  // A derived column can carry a county no raw layer does — an index is
  // computed over its own inputs, and the universe is the raw layers'.
  for (const column of props.columns) for (const geoId of Object.keys(column.values)) geoIds.add(geoId)
  return [...geoIds].map(geoId => {
    const known = nameOf(geoId)
    const cells: Record<string, number | null> = {}
    for (const col of cols.value) {
      const raw = byCol[col.id]?.[geoId]
      cells[col.id] = typeof raw === 'number' ? raw : col.counted ? 0 : null
    }
    return { geoId, name: known ? `${known.name}, ${known.stateAbbr}` : geoId, named: !!known, cells }
  })
})

/** The county's name and state. Missing is fine — the GEOID stands in, the
 *  way it does everywhere else that names a county. */
function nameOf(geoId: string): { name: string; stateAbbr: string } | null {
  try {
    return getCountyByGeoId(geoId) ?? null
  } catch {
    return null
  }
}

/** '' is the county name; anything else is a column id. */
const sort = ref('')
const dir = ref<'asc' | 'desc'>('asc')

const sortLabel = computed(() => {
  if (!sort.value) return `county name, ${dir.value === 'asc' ? 'A–Z' : 'Z–A'}`
  const col = cols.value.find(c => c.id === sort.value)
  return `${col?.name ?? sort.value}, ${dir.value === 'desc' ? 'highest first' : 'lowest first'}`
})

function sortBy(id: string): void {
  if (sort.value === id) {
    dir.value = dir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sort.value = id
  // Highest first on a number, A–Z on the name: the useful direction for an
  // index is the top of it, and the useful direction for a name is the start.
  dir.value = id ? 'desc' : 'asc'
}

const shown = computed<Row[]>(() => {
  const key = sort.value
  const sign = dir.value === 'asc' ? 1 : -1
  const sorted = [...rows.value].sort((a, b) => {
    if (!key) {
      // A county we cannot NAME sorts after the ones we can, either way up.
      // Alphabetically a bare GEOID beats every letter, so the default sort
      // opened on "02063" — a page of numbers where the names should be.
      if (a.named !== b.named) return a.named ? -1 : 1
      return sign * a.name.localeCompare(b.name)
    }
    const av = a.cells[key]
    const bv = b.cells[key]
    // A county with no number sorts last whichever way the column is read:
    // "no measurement" is not a low score and must not top a descending sort
    // or bottom an ascending one as though it were one.
    if (av === null && bv === null) return a.name.localeCompare(b.name)
    if (av === null) return 1
    if (bv === null) return -1
    return sign * (av - bv)
  })
  return sorted.slice(0, ROWS_SHOWN)
})

const anyBlank = computed(() => shown.value.some(row => cols.value.some(col => row.cells[col.id] === null)))
const anyCounted = computed(() => cols.value.some(col => col.counted))

function print(value: number | null, col: Col): string {
  if (value === null) return '—'
  const n = readable(value)
  return col.unit === 'percent' ? `${n}%` : n
}
</script>

<style scoped>
.counties {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  min-width: 0;
}

.state-note {
  margin: 0;
  font-size: 0.9rem;
  color: var(--blo-stone);
}

.counties-line {
  margin: 0;
  font-size: 0.86rem;
  color: var(--blo-stone);
}

.counties-line strong {
  color: var(--blo-ink);
  font-weight: 600;
}

.counties-hint {
  color: var(--blo-stone-soft);
}

/* The table scrolls in its own box — a set with ten columns must not make the
   page scroll sideways. */
.counties-scroll {
  overflow-x: auto;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.counties-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
  font-variant-numeric: tabular-nums;
}

.counties-table th,
.counties-table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--blo-cream-divider);
  text-align: left;
  white-space: nowrap;
}

.counties-table tbody tr:last-child th,
.counties-table tbody tr:last-child td {
  border-bottom: none;
}

.counties-table thead th {
  position: sticky;
  top: 0;
  background: var(--blo-cream, #f7f4ee);
  padding: 0;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.c-sort {
  width: 100%;
  padding: 7px 10px;
  font: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--blo-stone);
  text-align: inherit;
  background: none;
  border: none;
  cursor: pointer;
  white-space: nowrap;
}

.c-sort:hover {
  color: var(--blo-ink);
}

.c-dir {
  margin-left: 5px;
  color: var(--blo-green-deep);
  font-size: 0.7rem;
}

.c-name {
  font-weight: 500;
  color: var(--blo-ink);
}

.c-num {
  text-align: right;
}

thead .c-num .c-sort {
  text-align: right;
}

.c-num.blank {
  color: var(--blo-stone-soft);
}

.counties-key {
  margin: 0;
  font-size: 0.8rem;
  color: var(--blo-stone);
}

.counties-key strong {
  color: var(--blo-ink);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  .counties-table {
    font-size: 0.8rem;
  }
}
</style>
