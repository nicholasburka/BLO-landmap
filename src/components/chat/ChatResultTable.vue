<script setup lang="ts">
/**
 * The rows behind a tool line (P14-5).
 *
 * `query_dataset` returning 412 rows rendered as the string *"Queried the
 * organizations table · 412 rows"* — the model read the sample and the
 * reader got a number. These are the same rows, in the same clip, rendered
 * as a table.
 *
 * Only `query_dataset` and `county_values` carry one; the server decides
 * (`clientResult` in `chatLoop.ts`), not this component. Collapsed by
 * default, because a transcript is a conversation and a table is a detour
 * the reader should choose.
 */
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { toAppPath } from '@/lib/libraryChat'

const props = defineProps<{
  result: Record<string, unknown>
}>()

const open = ref(false)

const columns = computed(() =>
  Array.isArray(props.result.columns) ? (props.result.columns as string[]) : [],
)
const rows = computed(() =>
  Array.isArray(props.result.rows) ? (props.result.rows as Record<string, unknown>[]) : [],
)
/** The whole match, which is usually larger than what is shown. */
const total = computed(() => (typeof props.result.total === 'number' ? props.result.total : rows.value.length))
const href = computed(() =>
  typeof props.result.href === 'string' ? (toAppPath(props.result.href) ?? '') : '',
)

/** "showing 25 of 412" — and nothing at all when it is showing all of them. */
const shownNote = computed(() =>
  total.value > rows.value.length ? `showing ${rows.value.length} of ${total.value.toLocaleString()}` : '',
)

function cell(row: Record<string, unknown>, column: string): string {
  const value = row[column]
  if (value === null || value === undefined || value === '') return '—'
  return typeof value === 'number' ? value.toLocaleString() : String(value)
}
</script>

<template>
  <div v-if="rows.length" class="result" data-testid="chat-result">
    <p class="result-head">
      <button
        type="button"
        class="blo-act"
        :aria-expanded="open"
        data-testid="chat-result-toggle"
        @click="open = !open"
      >{{ open ? 'Hide the rows' : `Show ${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` }}</button>
      <span v-if="shownNote" class="blo-type-meta" data-testid="chat-result-count">{{ shownNote }}</span>
      <!-- Sorting and filtering are the table explorer's, not a transcript's. -->
      <RouterLink v-if="href" :to="href" class="blo-type-action" data-testid="chat-result-open">
        Open the table
      </RouterLink>
    </p>

    <div v-if="open" class="result-scroll" data-testid="chat-result-rows">
      <table>
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i">
            <td v-for="column in columns" :key="column">{{ cell(row, column) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.result {
  margin: 4px 0 8px 18px;
}

.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0;
}

/* The table scrolls, never the transcript. */
.result-scroll {
  overflow-x: auto;
  margin-top: 6px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

table {
  border-collapse: collapse;
  font-size: var(--blo-text-meta);
  line-height: 1.45;
  width: max-content;
  min-width: 100%;
}

th,
td {
  padding: 5px 10px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--blo-cream-divider);
}

th {
  font-size: var(--blo-text-caption);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone);
  background: var(--blo-cream-deep);
  position: sticky;
  top: 0;
}

td {
  color: var(--blo-ink);
  font-variant-numeric: tabular-nums;
}

tbody tr:last-child td {
  border-bottom: none;
}
</style>
