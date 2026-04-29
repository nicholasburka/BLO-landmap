<template>
  <div class="lens-legend">
    <!-- Single-layer or default state: full gradient + low/high labels -->
    <div v-if="primaryLegend" class="lens-legend-bar">
      <div class="lens-legend-title">{{ primaryTitle }}</div>
      <div class="lens-legend-gradient" :style="{ background: primaryLegend.gradient }"></div>
      <div class="lens-legend-bounds">
        <span>{{ primaryLegend.lowLabel }}</span>
        <span>{{ primaryLegend.highLabel }}</span>
      </div>
    </div>

    <!-- Multi-layer (composite) score: BLO custom-index gradient + breakdown -->
    <div v-if="scoringBreakdown.length > 0" class="lens-legend-breakdown">
      <div class="lens-legend-breakdown-label">What's in this score</div>
      <ul class="lens-legend-breakdown-list">
        <li
          v-for="row in scoringBreakdown"
          :key="row.id"
          class="lens-legend-breakdown-row"
        >
          <span class="lens-legend-breakdown-name">{{ row.name }}</span>
          <span class="lens-legend-breakdown-arrow" :class="row.directionClass">{{ row.arrow }}</span>
          <span class="lens-legend-breakdown-weight">w {{ row.weight }}</span>
        </li>
      </ul>
    </div>

    <!-- Filter-applied note -->
    <p v-if="hasActiveFilters" class="lens-legend-filter-note">
      <span class="lens-legend-filter-dot" aria-hidden="true"></span>
      Grey counties are excluded by your filter.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

interface LayerLegendInfo {
  id: string
  name: string
  gradient: string
  lowLabel: string
  highLabel: string
}

interface ScoringBreakdownRow {
  id: string
  name: string
  arrow: string
  directionClass: string
  weight: number
}

const props = defineProps<{
  selectedDemographicLayers: string[]
  selectedEconomicLayers: string[]
  selectedHousingLayers: string[]
  selectedEquityLayers: string[]
  selectedTransportationLayers: string[]
  showContaminationChoropleth: boolean
  layerDirections: Record<string, string>
  layerWeights: Record<string, number>
  hasActiveFilters: boolean
}>()

function getLegend(id: string): LayerLegendInfo | null {
  const reg = LAYER_REGISTRY[id]
  if (!reg) return null
  return {
    id: reg.id,
    name: reg.name,
    gradient: reg.gradient.css,
    lowLabel: reg.gradient.lowLabel,
    highLabel: reg.gradient.highLabel,
  }
}

/** All non-BLO scoring layer IDs currently active. */
const scoringIds = computed<string[]>(() => {
  const all = [
    ...props.selectedDemographicLayers,
    ...props.selectedEconomicLayers,
    ...props.selectedHousingLayers,
    ...props.selectedEquityLayers,
    ...props.selectedTransportationLayers,
  ].filter(id => id !== 'combined_scores' && id !== 'combined_scores_v2')
  if (props.showContaminationChoropleth) all.push('contamination')
  return all
})

/** The single layer whose gradient drives the choropleth right now.
 *  When ≥2 scoring layers are active, the choropleth shows a composite
 *  score using the BLO scale, so we render that gradient with a
 *  "Custom score" title. */
const primaryLegend = computed<LayerLegendInfo | null>(() => {
  const ids = scoringIds.value
  if (ids.length >= 2) {
    return getLegend('combined_scores_v2')
  }
  if (ids.length === 1) return getLegend(ids[0])
  // No scoring → default BLO precomputed
  return getLegend('combined_scores_v2')
})

const primaryTitle = computed(() => {
  if (scoringIds.value.length >= 2) return 'Custom score'
  return primaryLegend.value?.name ?? ''
})

/** Breakdown rendered only in composite (≥2 layer) mode. */
const scoringBreakdown = computed<ScoringBreakdownRow[]>(() => {
  const ids = scoringIds.value
  if (ids.length < 2) return []
  return ids.map(id => {
    const reg = LAYER_REGISTRY[id]
    const dir = props.layerDirections[id] ?? reg?.direction ?? 'higher_better'
    return {
      id,
      name: reg?.name ?? id,
      arrow: dir === 'lower_better' ? '↓' : '↑',
      directionClass: dir === 'lower_better' ? 'dir-lower' : 'dir-higher',
      weight: props.layerWeights[id] ?? 5,
    }
  })
})
</script>

<style scoped>
.lens-legend {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Title above the gradient — Fraunces in subdued ink */
.lens-legend-title {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  margin-bottom: 6px;
  line-height: 1.2;
}

/* The gradient bar — full Lens width minus padding, the hero of this tab */
.lens-legend-gradient {
  height: 14px;
  width: 100%;
  border-radius: 4px;
  border: 1px solid rgba(17, 17, 17, 0.06);
}

.lens-legend-bounds {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
  font-feature-settings: "tnum";
}

/* Breakdown — what's in the composite score */
.lens-legend-breakdown {
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
  padding-top: 10px;
}

.lens-legend-breakdown-label {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
  margin-bottom: 6px;
}

.lens-legend-breakdown-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.lens-legend-breakdown-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--blo-ink-soft, #2a2a2a);
}

.lens-legend-breakdown-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lens-legend-breakdown-arrow {
  font-weight: 700;
  font-size: 13px;
}
.lens-legend-breakdown-arrow.dir-higher { color: var(--blo-green-deep, #1f7a2e); }
.lens-legend-breakdown-arrow.dir-lower  { color: var(--blo-stone, #6b6560); }

.lens-legend-breakdown-weight {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  color: var(--blo-stone, #6b6560);
  font-feature-settings: "tnum";
}

/* Filter note */
.lens-legend-filter-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding-top: 8px;
  border-top: 1px dashed var(--blo-cream-divider, #e0d9ca);
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
}

.lens-legend-filter-dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: rgba(200, 200, 200, 0.6);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
}
</style>
