<template>
  <!-- Phase 4d L4: thin wrapper around the layer-picker UI for use inside
       the Lens "Layers" tab. Phase 4e cleanup: no more `embedded` /
       `expanded` props — LayerControls is embed-only now. -->
  <LayerControls
    :demographic-layers="demographicLayers"
    :economic-layers="economicLayers"
    :housing-layers="housingLayers"
    :equity-layers="equityLayers"
    :transportation-layers="transportationLayers"
    :contamination-layers="contaminationLayers"
    :selected-demographic-layers="selectedDemographicLayers"
    :selected-economic-layers="selectedEconomicLayers"
    :selected-housing-layers="selectedHousingLayers"
    :selected-equity-layers="selectedEquityLayers"
    :selected-transportation-layers="selectedTransportationLayers"
    :show-contamination-layers="showContaminationLayers"
    :show-contamination-choropleth="showContaminationChoropleth"
    :dev-mode-only="devModeOnly"
    :show-scoring-controls="showScoringControls"
    :layer-weights="layerWeights"
    :layer-directions="layerDirections"
    :active-filters="activeFilters"
    @toggle-demographic="(id) => $emit('toggle-demographic', id)"
    @toggle-economic="(id) => $emit('toggle-economic', id)"
    @toggle-housing="(id) => $emit('toggle-housing', id)"
    @toggle-equity="(id) => $emit('toggle-equity', id)"
    @toggle-transportation="(id) => $emit('toggle-transportation', id)"
    @toggle-contamination="(id) => $emit('toggle-contamination', id)"
    @toggle-contamination-layers="$emit('toggle-contamination-layers')"
    @toggle-contamination-choropleth="$emit('toggle-contamination-choropleth')"
    @update-weight="(id, w) => $emit('update-weight', id, w)"
    @update-direction="(id, d) => $emit('update-direction', id, d)"
    @update-filter="(id, f) => $emit('update-filter', id, f)"
  />
</template>

<script setup lang="ts">
import LayerControls from '@/components/LayerControls.vue'
import type { ScoringFilter } from '@/types/mapTypes'

defineProps<{
  demographicLayers: any[]
  economicLayers?: any[]
  housingLayers?: any[]
  equityLayers?: any[]
  transportationLayers?: any[]
  contaminationLayers?: any[]
  selectedDemographicLayers: string[]
  selectedEconomicLayers?: string[]
  selectedHousingLayers?: string[]
  selectedEquityLayers?: string[]
  selectedTransportationLayers?: string[]
  showContaminationLayers: boolean
  showContaminationChoropleth: boolean
  devModeOnly?: boolean
  showScoringControls?: boolean
  layerWeights?: Record<string, number>
  layerDirections?: Record<string, string>
  activeFilters?: ScoringFilter[]
}>()

defineEmits<{
  (e: 'toggle-demographic', id: string): void
  (e: 'toggle-economic', id: string): void
  (e: 'toggle-housing', id: string): void
  (e: 'toggle-equity', id: string): void
  (e: 'toggle-transportation', id: string): void
  (e: 'toggle-contamination', id: string): void
  (e: 'toggle-contamination-layers'): void
  (e: 'toggle-contamination-choropleth'): void
  (e: 'update-weight', id: string, weight: number): void
  (e: 'update-direction', id: string, direction: string): void
  (e: 'update-filter', id: string, filter: ScoringFilter | null): void
}>()
</script>
