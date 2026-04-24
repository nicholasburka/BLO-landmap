<template>
  <div class="scoring-controls">
    <!-- Weight -->
    <div class="weight-control">
      <label :for="'weight-' + layerId" class="weight-label">Weight: {{ weight }}</label>
      <input
        type="range"
        :id="'weight-' + layerId"
        min="1" max="10"
        :value="weight"
        @input="$emit('update-weight', layerId, Number(($event.target as HTMLInputElement).value))"
        :aria-label="'Weight for ' + layerName"
        class="weight-slider"
      />
    </div>

    <!-- Direction (hidden when filter is an active `between`) -->
    <button
      v-if="!isBetween"
      type="button"
      class="direction-toggle"
      @click="toggleDirection"
      :aria-label="'Direction for ' + layerName + ': ' + directionLabel"
      :title="directionTooltipValue"
    >{{ directionLabel }}</button>

    <!-- Filter affordance: Add button → active slider -->
    <div class="filter-control">
      <button
        v-if="!filter"
        type="button"
        class="filter-add"
        @click="addFilter"
        :aria-label="'Add filter for ' + layerName"
      >+ Filter</button>

      <div v-else class="filter-active">
        <div class="filter-header">
          <span class="filter-label">{{ filterLabel }}</span>
          <div class="filter-mode-switch" role="group" aria-label="Filter mode">
            <button
              type="button"
              class="filter-mode"
              :class="{ active: !isBetween }"
              @click="switchToThreshold"
            >Threshold</button>
            <button
              type="button"
              class="filter-mode"
              :class="{ active: isBetween }"
              @click="switchToRange"
            >Range</button>
          </div>
          <button
            type="button"
            class="filter-clear"
            @click="$emit('update-filter', layerId, null)"
            :aria-label="'Clear filter for ' + layerName"
            title="Clear filter"
          >×</button>
        </div>

        <!-- Single-thumb: greater_than / less_than -->
        <input
          v-if="!isBetween"
          type="range"
          :min="range.min"
          :max="range.max"
          :step="step"
          :value="filter.value"
          @input="onSingleSliderInput"
          class="filter-slider"
          :aria-label="'Filter threshold for ' + layerName"
        />

        <!-- Dual-thumb: between -->
        <div v-else class="filter-range">
          <div class="filter-range-row">
            <span class="filter-range-bound">Min</span>
            <input
              type="range"
              :min="range.min"
              :max="range.max"
              :step="step"
              :value="filter.value"
              @input="onRangeMinInput"
              class="filter-slider"
              :aria-label="'Range minimum for ' + layerName"
            />
            <span class="filter-range-value">{{ formatNumber(filter.value) }}{{ unit }}</span>
          </div>
          <div class="filter-range-row">
            <span class="filter-range-bound">Max</span>
            <input
              type="range"
              :min="range.min"
              :max="range.max"
              :step="step"
              :value="filter.max ?? range.max"
              @input="onRangeMaxInput"
              class="filter-slider"
              :aria-label="'Range maximum for ' + layerName"
            />
            <span class="filter-range-value">{{ formatNumber(filter.max ?? range.max) }}{{ unit }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ScoringFilter } from '@/types/mapTypes'

interface Range { min: number; max: number }

const props = defineProps<{
  layerId: string
  layerName: string
  weight: number
  direction: string
  /** null/undefined when no filter is applied for this layer */
  filter: ScoringFilter | null | undefined
  range: Range
  unit: string
}>()

const emit = defineEmits<{
  'update-weight': [layerId: string, weight: number]
  'update-direction': [layerId: string, direction: string]
  /** null means "remove filter for this layer" */
  'update-filter': [layerId: string, filter: ScoringFilter | null]
}>()

/** Reasonable slider step based on the layer's value domain */
const step = computed(() => {
  const span = props.range.max - props.range.min
  if (span <= 2) return 0.01
  if (span <= 20) return 0.1
  if (span <= 200) return 1
  return Math.max(1, Math.round(span / 200))
})

const isBetween = computed(() => props.filter?.operator === 'between')

const directionLabel = computed(() =>
  props.direction === 'lower_better' ? '↓ Less scores higher' : '↑ More scores higher',
)

const directionTooltipValue = computed(() =>
  props.direction === 'lower_better'
    ? `Lower ${props.layerName} produces a higher score. Click to flip.`
    : `Higher ${props.layerName} produces a higher score. Click to flip.`,
)

function nextDirection(dir: string): string {
  return dir === 'lower_better' ? 'higher_better' : 'lower_better'
}

function operatorForDirection(dir: string): 'greater_than' | 'less_than' {
  // Filter intent follows scoring intent:
  //   higher_better → keep counties above threshold → greater_than
  //   lower_better  → keep counties below threshold → less_than
  return dir === 'lower_better' ? 'less_than' : 'greater_than'
}

/** Friendly label for the active-filter header (e.g. "pct_Black > 30%") */
const filterLabel = computed(() => {
  if (!props.filter) return ''
  const op = props.filter.operator
  const val = formatNumber(props.filter.value)
  if (op === 'between') {
    return `${props.layerId} ${val}–${formatNumber(props.filter.max ?? 0)}${props.unit}`
  }
  const symbol = op === 'greater_than' ? '≥' : '≤'
  return `${props.layerId} ${symbol} ${val}${props.unit}`
})

function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(step.value < 1 ? 2 : 1)
}

function addFilter(): void {
  const midpoint = (props.range.min + props.range.max) / 2
  emit('update-filter', props.layerId, {
    layerId: props.layerId,
    operator: operatorForDirection(props.direction),
    value: roundToStep(midpoint),
  })
}

function onSingleSliderInput(e: Event): void {
  if (!props.filter) return
  const value = Number((e.target as HTMLInputElement).value)
  emit('update-filter', props.layerId, {
    ...props.filter,
    operator: operatorForDirection(props.direction),
    value,
  })
}

function toggleDirection(): void {
  const newDir = nextDirection(props.direction)
  emit('update-direction', props.layerId, newDir)
  // If a filter is active, flip its operator live to match the new direction
  if (props.filter && props.filter.operator !== 'between') {
    emit('update-filter', props.layerId, {
      ...props.filter,
      operator: operatorForDirection(newDir),
    })
  }
}

/** Switch filter mode to a single threshold (direction-derived operator) */
function switchToThreshold(): void {
  if (!props.filter) return
  if (props.filter.operator !== 'between') return
  emit('update-filter', props.layerId, {
    layerId: props.layerId,
    operator: operatorForDirection(props.direction),
    value: props.filter.value,
  })
}

/** Switch filter mode to a between-range with sensible default bounds */
function switchToRange(): void {
  if (isBetween.value) return
  const span = props.range.max - props.range.min
  const defaultMin = props.filter?.value ?? roundToStep(props.range.min + span * 0.25)
  const defaultMax = roundToStep(props.range.max - span * 0.25)
  emit('update-filter', props.layerId, {
    layerId: props.layerId,
    operator: 'between',
    value: Math.min(defaultMin, defaultMax),
    max: Math.max(defaultMin, defaultMax),
  })
}

/** Clamp min to not exceed current max */
function onRangeMinInput(e: Event): void {
  if (!props.filter) return
  const value = Number((e.target as HTMLInputElement).value)
  const max = props.filter.max ?? props.range.max
  emit('update-filter', props.layerId, {
    ...props.filter,
    operator: 'between',
    value: Math.min(value, max),
    max,
  })
}

/** Clamp max to not fall below current min */
function onRangeMaxInput(e: Event): void {
  if (!props.filter) return
  const max = Number((e.target as HTMLInputElement).value)
  const min = props.filter.value
  emit('update-filter', props.layerId, {
    ...props.filter,
    operator: 'between',
    value: min,
    max: Math.max(max, min),
  })
}

function roundToStep(n: number): number {
  const s = step.value
  return Math.round(n / s) * s
}
</script>

<style scoped>
.scoring-controls {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--blo-cream, #f7f4ee);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.weight-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.weight-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--blo-ink-soft, #2a2a2a);
  min-width: 70px;
}

.weight-slider {
  flex: 1;
  min-width: 0;
}

.direction-toggle {
  align-self: flex-start;
  padding: 3px 8px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  background: white;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}
.direction-toggle:hover { border-color: var(--blo-green, #37b34a); }

.filter-control {
  border-top: 1px dashed var(--blo-cream-divider, #e0d9ca);
  padding-top: 6px;
}

.filter-add {
  padding: 3px 8px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
  background: transparent;
  border: 1px dashed var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}
.filter-add:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-stone-soft, #9a948e);
  border-style: solid;
}

.filter-active {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
}

.filter-label {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--blo-ink-soft, #2a2a2a);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.filter-clear {
  padding: 0 6px;
  background: transparent;
  color: var(--blo-stone, #6b6560);
  border: none;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.filter-clear:hover { color: var(--blo-ink, #111); }

.filter-slider {
  width: 100%;
}

/* Threshold / Range mode switch */
.filter-mode-switch {
  display: inline-flex;
  gap: 0;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  padding: 1px;
  background: white;
}

.filter-mode {
  padding: 2px 8px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  background: transparent;
  color: var(--blo-stone, #6b6560);
  border: none;
  border-radius: 999px;
  cursor: pointer;
}
.filter-mode.active {
  background: var(--blo-ink, #111);
  color: white;
}

/* Dual-thumb range mode — stacked sliders with inline value readouts */
.filter-range {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-range-row {
  display: grid;
  grid-template-columns: 30px 1fr 50px;
  align-items: center;
  gap: 6px;
}

.filter-range-bound {
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}

.filter-range-value {
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--blo-ink-soft, #2a2a2a);
  text-align: right;
}
</style>
