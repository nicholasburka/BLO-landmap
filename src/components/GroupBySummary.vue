<script setup lang="ts">
/**
 * "Count the rows by …" (P5-42) — the pivot table a researcher would
 * otherwise build in a spreadsheet: one row per value, how many rows have
 * it, and what share of the filtered set that is. Clicking a value filters
 * the table to it; the whole table saves as a CSV without a round trip
 * (the counts are already here — no reason to ask the server again).
 *
 * P5-54 puts the same counts on a bar chart above the table, so the shape of
 * the answer is visible at a glance and can be copied into a page as an
 * image. The table stays the interactive half (click a value to filter).
 */
import { computed } from 'vue'
import SummaryChart from './SummaryChart.vue'
import { barsChart } from '@/lib/charts'
import { sharePct, groupByCsv, type ColumnSummary } from '@/lib/libraryData'

const props = defineProps<{
  column: string
  summary: ColumnSummary | null
  loading: boolean
  /** Rows in the current filtered set — the denominator for the share. */
  matched: number
  /** Used to name the downloaded file. */
  slug: string
  error?: string
}>()

const emit = defineEmits<{
  (e: 'pick', value: string): void
  (e: 'back'): void
}>()

const values = computed(() => props.summary?.top ?? [])
const truncated = computed(() => !!props.summary && props.summary.distinct > values.value.length)

/** The top of the same list as bars. Group-by can return 200 values; the
 *  chart draws the readable head of it and says how many it left out. */
const chartSpec = computed(() => (props.summary ? barsChart(props.summary, { matched: props.matched }) : null))

/** Exactly the rows on screen, blank row included — "download this table"
 *  has to mean this table, not a tidier one. */
const csvRows = computed(() =>
  props.summary && props.summary.empty > 0
    ? [...values.value, { value: '(blank)', count: props.summary.empty }]
    : values.value,
)

function fileNameSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'column'
}

/** Save the visible table as a CSV. A Blob + a click is the whole trick —
 *  nothing leaves the browser, so there is nothing to audit. */
function downloadCsv(): void {
  const csv = groupByCsv(props.column, csvRows.value, props.matched)
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${fileNameSafe(props.slug)}-${fileNameSafe(props.column)}-counts.csv`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <section class="group-by" data-testid="group-by">
    <header class="gb-head">
      <button type="button" class="back-btn touch-target" @click="emit('back')">← All columns</button>
      <h3>Rows counted by {{ column }}</h3>
    </header>

    <p v-if="error" class="gb-error" data-testid="group-by-error">{{ error }}</p>

    <div v-else-if="loading || !summary" class="gb-skeleton" data-testid="group-by-skeleton" aria-hidden="true">
      <span v-for="n in 6" :key="n" class="sk-line"></span>
    </div>

    <template v-else>
      <SummaryChart v-if="chartSpec" :spec="chartSpec" :file-name="`${slug}-${column}-counts`" />

      <!-- The counts table can carry long values; it scrolls inside the card
           rather than pushing the page sideways (P5-60). -->
      <div class="gb-scroll" data-testid="group-by-scroll">
      <table class="gb-table" data-testid="group-by-table">
        <thead>
          <tr>
            <th scope="col">{{ column }}</th>
            <th scope="col" class="num">Rows</th>
            <th scope="col" class="num">Share</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in values" :key="v.value">
            <td>
              <button
                type="button"
                class="value-btn"
                :title="`Show only rows where ${column} is ${v.value}`"
                @click="emit('pick', v.value)"
              >
                {{ v.value }}
              </button>
            </td>
            <td class="num">{{ v.count.toLocaleString() }}</td>
            <td class="num">{{ sharePct(v.count, matched) }}</td>
          </tr>
          <tr v-if="summary.empty > 0" class="blank-row">
            <td>(blank)</td>
            <td class="num">{{ summary.empty.toLocaleString() }}</td>
            <td class="num">{{ sharePct(summary.empty, matched) }}</td>
          </tr>
        </tbody>
      </table>
      </div>

      <p v-if="truncated" class="gb-note">
        Showing the {{ values.length.toLocaleString() }} most common of {{ summary.distinct.toLocaleString() }} values.
      </p>
      <p v-else-if="values.length === 0" class="gb-note">Nothing is filled in here for these rows.</p>

      <button type="button" class="csv-btn touch-target" data-testid="group-by-csv" @click="downloadCsv">
        Download this table as CSV
      </button>
    </template>
  </section>
</template>

<style scoped>
.group-by {
  font-size: 13px;
}

.gb-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.gb-head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

.back-btn {
  flex-basis: 100%;
  text-align: left;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--blo-green-deep);
  cursor: pointer;
}

.gb-scroll {
  overflow-x: auto;
  max-width: 100%;
}

.gb-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.gb-table th {
  text-align: left;
  padding: 4px 6px;
  border-bottom: 1px solid var(--blo-cream-divider);
  color: var(--blo-stone);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.gb-table td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--blo-cream);
}

.gb-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.value-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--blo-green-deep);
  text-align: left;
  cursor: pointer;
  overflow-wrap: anywhere;
}

.value-btn:hover,
.value-btn:focus-visible {
  text-decoration: underline;
}

.blank-row td {
  color: var(--blo-stone-soft);
}

.gb-note {
  margin: 8px 0;
  font-size: 12px;
  color: var(--blo-stone);
}

.csv-btn {
  margin-top: 4px;
  padding: 6px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.gb-error {
  color: #b71c1c;
}

.gb-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sk-line {
  height: 12px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--blo-cream-deep) 25%, #fff 50%, var(--blo-cream-deep) 75%);
  background-size: 200% 100%;
  animation: gb-shimmer 1.2s infinite;
}

@keyframes gb-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

/* Phone (P5-60): body text at 14 px, and every value in the table is a
   filter, so every value is a 44 px row. */
@media (max-width: 640px) {
  .group-by {
    font-size: 14px;
  }

  .gb-head h3 {
    font-size: 17px;
  }

  .back-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .gb-table {
    font-size: 14px;
  }

  .gb-table th {
    font-size: 13px;
  }

  .gb-table td {
    padding: 6px;
  }

  .value-btn {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 44px;
    font-size: 14px;
  }

  .gb-note {
    font-size: 14px;
  }

  .csv-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
