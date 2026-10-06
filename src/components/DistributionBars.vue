<script setup lang="ts">
/**
 * Most-common values as horizontal bars (P5-42). Each bar is a button:
 * clicking it narrows the table to that value, which is how a researcher
 * "drills in" without writing a filter by hand.
 *
 * Bar length is relative to the LARGEST value in the list (so the shape of
 * the distribution is visible even when the top value is 3% of the rows);
 * the number beside it is the honest count and share of the filtered set.
 */
import { computed } from 'vue'
import { sharePct } from '@/lib/libraryData'

const props = defineProps<{
  values: { value: string; count: number }[]
  /** Rows in the current filtered set — the denominator for the share. */
  matched: number
  /** Verb used in each bar's title, e.g. "Filter Tier to Tier 1". */
  column: string
}>()

const emit = defineEmits<{ (e: 'pick', value: string): void }>()

const largest = computed(() => props.values.reduce((max, v) => Math.max(max, v.count), 0))

function widthOf(count: number): string {
  return largest.value > 0 ? `${Math.max(2, (count / largest.value) * 100)}%` : '0%'
}
</script>

<template>
  <ul class="bars" data-testid="distribution-bars">
    <li v-for="v in values" :key="v.value">
      <button
        type="button"
        class="bar-row"
        :title="`Show only rows where ${column} is ${v.value}`"
        @click="emit('pick', v.value)"
      >
        <!-- The label is clipped to one line; its own title keeps the whole
             value readable on a narrow screen (P5-60). -->
        <span class="bar-label" :title="v.value">{{ v.value }}</span>
        <span class="bar-track"><span class="bar-fill" :style="{ width: widthOf(v.count) }"></span></span>
        <span class="bar-count">{{ v.count.toLocaleString() }}</span>
        <span class="bar-share">{{ sharePct(v.count, matched) }}</span>
      </button>
    </li>
  </ul>
</template>

<style scoped>
.bars {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bar-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 64px auto 44px;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 6px;
  border: none;
  border-radius: 4px;
  background: none;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  color: var(--blo-ink);
}

.bar-row:hover,
.bar-row:focus-visible {
  background: var(--blo-green-soft);
  outline: none;
}

.bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  height: 8px;
  border-radius: 999px;
  background: var(--blo-cream-deep);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--blo-green-deep);
}

.bar-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.bar-share {
  font-variant-numeric: tabular-nums;
  color: var(--blo-stone);
  text-align: right;
}

/* Phone (P5-60): every bar is a filter, so every bar is a tap target — and
   at 360 px the track gives up width so the label keeps some. */
@media (max-width: 640px) {
  .bar-row {
    grid-template-columns: minmax(0, 1fr) 48px auto 42px;
    gap: 6px;
    min-height: 44px;
    padding: 4px 6px;
    font-size: 14px;
  }
}
</style>
