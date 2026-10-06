<script setup lang="ts">
/**
 * "What's in this column?" (P5-42) — the answer a researcher who does not
 * write code actually wants: how much is filled in, how many different
 * values there are, which ones are common, and for numbers and dates the
 * range. Every label is a plain phrase: Filled, Different values, Most
 * common, Smallest / Middle / Largest.
 *
 * P5-54 adds the picture: a chart of the same numbers that can be copied
 * straight into a slide, with a toggle between the shapes this column can
 * draw (bars / spread / over time — see src/lib/charts.ts). The chart is
 * what a saved view remembers; the bar list below it stays because it is the
 * interactive one — clicking a bar filters the table.
 */
import { computed, ref, watch } from 'vue'
import DistributionBars from './DistributionBars.vue'
import SummaryChart from './SummaryChart.vue'
import { buildChart, chartKindsFor, CHART_LABELS, type ChartKind } from '@/lib/charts'
import { TYPE_WORDS, sharePct, formatNumber, type ColumnSummary } from '@/lib/libraryData'

const props = defineProps<{
  column: string
  summary: ColumnSummary | null
  loading: boolean
  /** Rows in the current filtered set (filled + empty). */
  matched: number
  /** Which chart to show; falls back to the best one for this column. */
  chart?: ChartKind | null
  /** Names the copied image file. */
  slug?: string
  error?: string
}>()

const emit = defineEmits<{
  (e: 'pick', value: string): void
  (e: 'groupBy'): void
  (e: 'back'): void
  (e: 'update:chart', kind: ChartKind): void
}>()

/** The shapes this column's data can actually make, best first. */
const chartKinds = computed(() => chartKindsFor(props.summary))

// The parent owns the choice (a saved view restores it), but the toggle has
// to work on its own too — so the pick is kept here and announced upward.
const picked = ref<ChartKind | null>(props.chart ?? null)
watch(
  () => [props.column, props.chart],
  () => {
    picked.value = props.chart ?? null
  },
)

const activeKind = computed<ChartKind | null>(() =>
  picked.value && chartKinds.value.includes(picked.value) ? picked.value : (chartKinds.value[0] ?? null),
)

const chartSpec = computed(() =>
  activeKind.value ? buildChart(props.summary, activeKind.value, { matched: props.matched }) : null,
)

function pickChart(kind: ChartKind): void {
  picked.value = kind
  emit('update:chart', kind)
}
</script>

<template>
  <section class="column-summary" data-testid="column-summary">
    <header class="cs-head">
      <button type="button" class="back-btn touch-target" @click="emit('back')">← All columns</button>
      <h3>{{ column }}</h3>
      <p v-if="summary" class="cs-type">{{ TYPE_WORDS[summary.type] }}</p>
    </header>

    <p v-if="error" class="cs-error" data-testid="summary-error">{{ error }}</p>

    <div v-else-if="loading || !summary" class="cs-skeleton" data-testid="summary-skeleton" aria-hidden="true">
      <span v-for="n in 6" :key="n" class="sk-line"></span>
    </div>

    <template v-else>
      <dl class="cs-facts">
        <div>
          <dt>Filled</dt>
          <dd>{{ summary.filled.toLocaleString() }} of {{ matched.toLocaleString() }} ({{ sharePct(summary.filled, matched) }})</dd>
        </div>
        <div>
          <dt>Blank</dt>
          <dd>{{ summary.empty.toLocaleString() }}</dd>
        </div>
        <div>
          <dt>Different values</dt>
          <dd>{{ summary.distinct.toLocaleString() }}</dd>
        </div>
      </dl>

      <section v-if="summary.numbers" class="cs-block" data-testid="number-summary">
        <dl class="cs-numbers">
          <div>
            <dt>Smallest</dt>
            <dd>{{ formatNumber(summary.numbers.min) }}</dd>
          </div>
          <div>
            <dt>Middle</dt>
            <dd>{{ formatNumber(summary.numbers.median) }}</dd>
          </div>
          <div>
            <dt>Largest</dt>
            <dd>{{ formatNumber(summary.numbers.max) }}</dd>
          </div>
          <div>
            <dt>Average</dt>
            <dd>{{ formatNumber(Math.round(summary.numbers.mean * 100) / 100) }}</dd>
          </div>
        </dl>
      </section>

      <p v-if="summary.dates" class="cs-block cs-dates" data-testid="date-summary">
        <span class="cs-label">Dates run from</span>
        <strong>{{ summary.dates.min }}</strong> to <strong>{{ summary.dates.max }}</strong>
      </p>

      <!-- P5-54: the picture, and the choice of which one. -->
      <section v-if="chartSpec" class="cs-block" data-testid="column-chart">
        <div v-if="chartKinds.length > 1" class="chart-toggle" role="group" aria-label="Chart type">
          <button
            v-for="kind in chartKinds"
            :key="kind"
            type="button"
            class="chart-toggle-btn touch-target"
            :class="{ active: kind === activeKind }"
            :aria-pressed="kind === activeKind"
            @click="pickChart(kind)"
          >
            {{ CHART_LABELS[kind] }}
          </button>
        </div>
        <SummaryChart :spec="chartSpec" :file-name="`${slug ?? 'data'}-${column}`" />
      </section>

      <section v-if="summary.top.length" class="cs-block">
        <p class="cs-label">Most common</p>
        <DistributionBars :values="summary.top" :matched="matched" :column="column" @pick="v => emit('pick', v)" />
        <p v-if="summary.distinct > summary.top.length" class="cs-more">
          Showing the top {{ summary.top.length }} of {{ summary.distinct.toLocaleString() }} values.
        </p>
      </section>
      <p v-else class="cs-more">Nothing is filled in here for these rows.</p>

      <button type="button" class="group-btn touch-target" data-testid="group-by-btn" @click="emit('groupBy')">
        Group by this column
      </button>
    </template>
  </section>
</template>

<style scoped>
.column-summary {
  font-size: 13px;
}

.cs-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.cs-head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

.cs-type {
  margin: 0;
  font-size: 12px;
  color: var(--blo-stone);
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

.cs-facts,
.cs-numbers {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 18px;
  margin: 0 0 10px;
}

.cs-facts dt,
.cs-numbers dt {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blo-stone);
}

.cs-facts dd,
.cs-numbers dd {
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.cs-block {
  margin: 0 0 12px;
  padding-top: 10px;
  border-top: 1px solid var(--blo-cream-divider);
}

.cs-label {
  margin: 0 0 6px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blo-stone);
}

.chart-toggle {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.chart-toggle-btn {
  padding: 3px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--blo-ink);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 999px;
  cursor: pointer;
}

.chart-toggle-btn.active {
  background: var(--blo-green-soft);
  border-color: var(--blo-green-deep);
  font-weight: 600;
}

.cs-dates strong {
  font-variant-numeric: tabular-nums;
}

.cs-more {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

.group-btn {
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

.cs-error {
  color: #b71c1c;
}

.cs-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sk-line {
  height: 12px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--blo-cream-deep) 25%, #fff 50%, var(--blo-cream-deep) 75%);
  background-size: 200% 100%;
  animation: cs-shimmer 1.2s infinite;
}

.sk-line:nth-child(even) {
  width: 70%;
}

@keyframes cs-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

/* Phone (P5-60): the summary is the whole width of the screen down here, so
   the facts read at 14 px and every control is a 44 px target. */
@media (max-width: 640px) {
  .column-summary {
    font-size: 14px;
  }

  .cs-head h3 {
    font-size: 17px;
  }

  .cs-type,
  .cs-more {
    font-size: 14px;
  }

  .back-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .cs-facts dt,
  .cs-numbers dt,
  .cs-label {
    font-size: 13px;
  }

  .chart-toggle {
    flex-wrap: wrap;
    gap: 8px;
  }

  .chart-toggle-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  .group-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
