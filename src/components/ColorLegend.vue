<template>
  <div v-if="activeLayers.length > 0" class="color-legend">
    <div class="legend-header">Color Key</div>
    <div v-for="layer in activeLayers" :key="layer.id" class="legend-item">
      <div class="legend-label">{{ layer.name }}</div>
      <div class="legend-gradient" :style="{ background: layer.gradient }"></div>
      <div class="legend-values">
        <span class="legend-low">{{ layer.lowLabel }}</span>
        <span class="legend-high">{{ layer.highLabel }}</span>
      </div>
    </div>
    <div v-if="scoringLayers.length > 0" class="legend-scoring-layers">
      <div v-for="sl in scoringLayers" :key="sl.id" class="legend-scoring-item">
        <span class="legend-direction-arrow" :class="sl.directionClass">{{ sl.arrow }}</span>
        <span class="legend-scoring-name">{{ sl.name }}</span>
      </div>
    </div>
    <div v-if="hasActiveFilters" class="legend-filter-note">
      <span class="legend-filter-swatch"></span>
      <span>Grey = excluded by filter</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

interface LayerLegend {
  id: string
  name: string
  gradient: string
  lowLabel: string
  highLabel: string
}

interface Props {
  selectedDemographicLayers: string[]
  selectedEconomicLayers: string[]
  selectedHousingLayers: string[]
  selectedEquityLayers: string[]
  selectedTransportationLayers: string[]
  showContaminationChoropleth: boolean
  layerDirections?: Record<string, string>
  hasActiveFilters?: boolean
}

const props = defineProps<Props>()

/** Derive legend info from the layer registry */
function getLegend(id: string): LayerLegend | null {
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

const activeLayers = computed(() => {
  const allSelected = [
    ...props.selectedDemographicLayers,
    ...props.selectedEconomicLayers,
    ...props.selectedHousingLayers,
    ...props.selectedEquityLayers,
    ...props.selectedTransportationLayers,
  ]

  if (props.showContaminationChoropleth) {
    allSelected.push('contamination')
  }

  // If multiple layers are selected (multi-layer mode), show BLO gradient
  const nonBLOLayers = allSelected.filter(id => id !== 'combined_scores' && id !== 'combined_scores_v2')
  if (nonBLOLayers.length >= 2) {
    const bloLegend = getLegend('combined_scores_v2')
    return bloLegend ? [{ ...bloLegend, name: 'Custom Index' }] : []
  }

  // Otherwise show the specific layer legend
  return allSelected
    .map(id => getLegend(id))
    .filter((l): l is LayerLegend => l !== null)
})

/** In multi-layer mode, show each layer with its direction indicator */
const scoringLayers = computed(() => {
  const allSelected = [
    ...props.selectedDemographicLayers,
    ...props.selectedEconomicLayers,
    ...props.selectedHousingLayers,
    ...props.selectedEquityLayers,
    ...props.selectedTransportationLayers,
  ].filter(id => id !== 'combined_scores' && id !== 'combined_scores_v2')

  if (props.showContaminationChoropleth) {
    allSelected.push('contamination')
  }

  if (allSelected.length < 2) return []

  return allSelected.map(id => {
    const reg = LAYER_REGISTRY[id]
    const dir = props.layerDirections?.[id] ?? reg?.direction ?? 'higher_better'
    return {
      id,
      name: reg?.name || id,
      arrow: dir === 'lower_better' ? '↓' : '↑',
      directionClass: dir === 'lower_better' ? 'dir-lower' : 'dir-higher',
    }
  })
})
</script>

<style scoped>
.color-legend {
  background: white;
  padding: 12px;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  min-width: 200px;
  pointer-events: auto;
}

.legend-header {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 10px;
  color: #2c3e50;
}

.legend-item {
  margin-bottom: 12px;
}

.legend-item:last-child {
  margin-bottom: 0;
}

.legend-label {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 4px;
  color: #34495e;
}

.legend-gradient {
  height: 12px;
  border-radius: 3px;
  margin-bottom: 4px;
  border: none;
}

.legend-values {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: #555;
}

.legend-low,
.legend-high {
  font-style: italic;
}

.legend-scoring-layers {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #e0e0e0;
}

.legend-scoring-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: #444;
  margin: 3px 0;
}

.legend-direction-arrow {
  font-weight: 700;
  font-size: 12px;
  width: 14px;
  text-align: center;
}

.legend-direction-arrow.dir-higher {
  color: #2d8a4e;
}

.legend-direction-arrow.dir-lower {
  color: #c0392b;
}

.legend-scoring-name {
  font-size: 11px;
}

.legend-filter-note {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed #e0e0e0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: #888;
  font-style: italic;
}

.legend-filter-swatch {
  display: inline-block;
  width: 12px;
  height: 12px;
  background: rgba(200, 200, 200, 0.6);
  border-radius: 2px;
  border: 1px solid #ccc;
}

@media (max-width: 768px) {
  .color-legend {
    min-width: 160px;
    padding: 10px;
  }

  .legend-header {
    font-size: 12px;
    margin-bottom: 8px;
  }

  .legend-label {
    font-size: 11px;
  }

  .legend-gradient {
    height: 10px;
  }

  .legend-values {
    font-size: 9px;
  }
}
</style>
