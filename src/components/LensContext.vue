<template>
  <div class="lens-context">
    <p class="lens-context-label">{{ headerLabel }}</p>
    <ul v-if="rows.length > 0" class="lens-context-rows">
      <li
        v-for="row in rows"
        :key="row.id"
        class="lens-context-row"
      >
        <div class="lens-context-row-head">
          <span class="lens-context-name">{{ row.name }}</span>
          <span class="lens-context-value">{{ row.formatted }}</span>
        </div>
        <div class="lens-context-scale" v-if="row.tickPercent != null">
          <div class="lens-context-track"></div>
          <div
            class="lens-context-tick"
            :style="{ left: row.tickPercent + '%' }"
            :title="row.name + ' national avg sits at ' + row.tickPercent.toFixed(0) + '% of the range'"
          ></div>
        </div>
        <p v-if="row.note" class="lens-context-note">{{ row.note }}</p>
      </li>
    </ul>
    <p v-else class="lens-context-empty">No averages available for the active selection.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import { NATIONAL_AVERAGES } from '@/config/nationalAverages'

interface Row {
  id: string
  name: string
  formatted: string
  /** Where the average sits within [layer.range.min, layer.range.max] as a 0–100 percent. Null if range is missing. */
  tickPercent: number | null
  note?: string
}

/** Default layers shown when no scoring is active — the "national snapshot." */
const DEFAULT_LAYER_IDS = [
  'combined_scores_v2',
  'pct_Black',
  'diversity_index',
  'contamination',
  'life_expectancy',
]

const props = defineProps<{
  /** Layer IDs currently driving the choropleth (excluding combined_scores_v2). */
  scoringLayerIds: string[]
}>()

const headerLabel = computed(() =>
  props.scoringLayerIds.length > 0 ? 'National average for active layers' : 'National average',
)

const rows = computed<Row[]>(() => {
  const ids = props.scoringLayerIds.length > 0
    ? props.scoringLayerIds
    : DEFAULT_LAYER_IDS

  return ids.map(id => {
    const reg = LAYER_REGISTRY[id]
    const avg = NATIONAL_AVERAGES[id]
    if (!reg || !avg) {
      return null
    }
    const range = reg.range
    let tickPercent: number | null = null
    if (range && typeof range.min === 'number' && typeof range.max === 'number' && range.max > range.min) {
      tickPercent = Math.max(0, Math.min(100, ((avg.value - range.min) / (range.max - range.min)) * 100))
    }
    return {
      id,
      name: reg.name,
      formatted: reg.formatValue(avg.value),
      tickPercent,
      note: avg.note,
    } as Row
  }).filter((r): r is Row => r !== null)
})
</script>

<style scoped>
.lens-context {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-feature-settings: "tnum";
}

.lens-context-label {
  margin: 0;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}

.lens-context-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.lens-context-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.lens-context-row-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.lens-context-name {
  font-size: 12.5px;
  color: var(--blo-ink-soft, #2a2a2a);
}

.lens-context-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  font-feature-settings: "tnum";
  white-space: nowrap;
}

/* Tick-on-scale: thin horizontal track + green-deep marker showing where
   the national average sits in the layer's range. */
.lens-context-scale {
  position: relative;
  height: 6px;
  margin: 1px 0;
}
.lens-context-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  background: var(--blo-cream-divider, #e0d9ca);
}
.lens-context-tick {
  position: absolute;
  top: 0;
  width: 6px;
  height: 6px;
  margin-left: -3px;
  border-radius: 999px;
  background: var(--blo-green-deep, #1f7a2e);
  box-shadow: 0 0 0 2px var(--blo-cream, #f7f4ee);
}

.lens-context-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--blo-stone, #6b6560);
}

.lens-context-empty {
  margin: 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  font-style: italic;
}
</style>
