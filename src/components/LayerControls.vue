<template>
  <div
    id="layer-control-container"
    :class="{ 'layer-control-collapsed': !expanded }"
    style="position: absolute; top: 50px; right: 10px; z-index: 10; pointer-events: auto"
    @click.stop
  >
    <button
      @click="$emit('toggle')"
      class="layer-control-toggle"
      :class="{ 'layer-control-toggle--collapsed': !expanded }"
      :aria-expanded="expanded"
      aria-controls="layer-control"
      aria-label="Toggle layer controls"
    >
      <span class="layer-control-gear" aria-hidden="true">⚙</span>
      <span class="layer-control-title">Data Layers</span>
      <span
        v-if="!expanded && activeLayerCount && activeLayerCount > 0"
        class="layer-control-badge"
      >{{ activeLayerCount }}</span>
      <span class="layer-control-chevron" aria-hidden="true">{{ expanded ? '▾' : '◂' }}</span>
    </button>
    <div
      id="layer-control"
      v-show="expanded"
      @click.stop
      class="layer-control-content"
    >
      <!-- BLO Livability Index (no category) -->
      <div v-for="layer in demographicLayers.filter(l => !l.category)" :key="layer.id" class="layer-item">
        <input
          type="checkbox"
          :id="layer.id"
          :checked="selectedDemographicLayers.includes(layer.id)"
          @change="$emit('toggle-demographic', layer.id)"
        />
        <label :for="layer.id">{{ layer.name }}</label>
        <span class="tooltip-wrapper" v-if="layer.tooltip">
          <button
            type="button"
            class="tooltip-icon"
            :aria-label="'Info about ' + layer.name"
            :aria-describedby="'tooltip-' + layer.id"
          >ⓘ</button>
          <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
        </span>
      </div>

      <!-- Demographics Category -->
      <template v-if="demographicLayers.filter(l => l.category === 'Demographics').length > 0">
        <h3 class="category-header" @click="toggleCategory('demographics')">
          <span class="arrow" :class="{ expanded: expandedCategories.demographics }">▶</span>
          Demographics
        </h3>
        <div v-show="expandedCategories.demographics">
          <div v-for="layer in demographicLayers.filter(l => l.category === 'Demographics')" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedDemographicLayers.includes(layer.id)"
              @change="$emit('toggle-demographic', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="tooltip-wrapper" v-if="layer.tooltip">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
            </span>
            <LayerScoringControls
              v-if="showScoringControls && isLayerSelected(layer.id)"
              :layer-id="layer.id"
              :layer-name="getLayerName(layer.id)"
              :weight="getWeight(layer.id)"
              :direction="getDirection(layer.id)"
              :filter="getFilter(layer.id)"
              :range="getRange(layer.id)"
              :unit="getUnit(layer.id)"
              @update-weight="(id, w) => $emit('update-weight', id, w)"
              @update-direction="(id, d) => $emit('update-direction', id, d)"
              @update-filter="(id, f) => $emit('update-filter', id, f)"
            />
          </div>
        </div>
      </template>

      <template v-if="economicLayers && economicLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('economic')">
          <span class="arrow" :class="{ expanded: expandedCategories.economic }">▶</span>
          Economic Indicators
        </h3>
        <div v-show="expandedCategories.economic">
          <div v-for="layer in economicLayers" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedEconomicLayers?.includes(layer.id)"
              @change="$emit('toggle-economic', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="tooltip-wrapper" v-if="layer.tooltip">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
            </span>
            <LayerScoringControls
              v-if="showScoringControls && isLayerSelected(layer.id)"
              :layer-id="layer.id"
              :layer-name="getLayerName(layer.id)"
              :weight="getWeight(layer.id)"
              :direction="getDirection(layer.id)"
              :filter="getFilter(layer.id)"
              :range="getRange(layer.id)"
              :unit="getUnit(layer.id)"
              @update-weight="(id, w) => $emit('update-weight', id, w)"
              @update-direction="(id, d) => $emit('update-direction', id, d)"
              @update-filter="(id, f) => $emit('update-filter', id, f)"
            />
          </div>
        </div>
      </template>

      <template v-if="housingLayers && housingLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('housing')">
          <span class="arrow" :class="{ expanded: expandedCategories.housing }">▶</span>
          Housing & Affordability
        </h3>
        <div v-show="expandedCategories.housing">
          <div v-for="layer in housingLayers" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedHousingLayers?.includes(layer.id)"
              @change="$emit('toggle-housing', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="tooltip-wrapper" v-if="layer.tooltip">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
            </span>
            <LayerScoringControls
              v-if="showScoringControls && isLayerSelected(layer.id)"
              :layer-id="layer.id"
              :layer-name="getLayerName(layer.id)"
              :weight="getWeight(layer.id)"
              :direction="getDirection(layer.id)"
              :filter="getFilter(layer.id)"
              :range="getRange(layer.id)"
              :unit="getUnit(layer.id)"
              @update-weight="(id, w) => $emit('update-weight', id, w)"
              @update-direction="(id, d) => $emit('update-direction', id, d)"
              @update-filter="(id, f) => $emit('update-filter', id, f)"
            />
          </div>
        </div>
      </template>

      <template v-if="equityLayers && equityLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('equity')">
          <span class="arrow" :class="{ expanded: expandedCategories.equity }">▶</span>
          Racial Equity
        </h3>
        <div v-show="expandedCategories.equity">
          <div v-for="layer in equityLayers" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedEquityLayers?.includes(layer.id)"
              @change="$emit('toggle-equity', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="tooltip-wrapper" v-if="layer.tooltip">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
            </span>
            <LayerScoringControls
              v-if="showScoringControls && isLayerSelected(layer.id)"
              :layer-id="layer.id"
              :layer-name="getLayerName(layer.id)"
              :weight="getWeight(layer.id)"
              :direction="getDirection(layer.id)"
              :filter="getFilter(layer.id)"
              :range="getRange(layer.id)"
              :unit="getUnit(layer.id)"
              @update-weight="(id, w) => $emit('update-weight', id, w)"
              @update-direction="(id, d) => $emit('update-direction', id, d)"
              @update-filter="(id, f) => $emit('update-filter', id, f)"
            />
          </div>
        </div>
      </template>

      <template v-if="transportationLayers && transportationLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('transportation')">
          <span class="arrow" :class="{ expanded: expandedCategories.transportation }">▶</span>
          Transportation
        </h3>
        <div v-show="expandedCategories.transportation">
          <div v-for="layer in transportationLayers" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedTransportationLayers?.includes(layer.id)"
              @change="$emit('toggle-transportation', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="tooltip-wrapper" v-if="layer.tooltip">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
            </span>
            <LayerScoringControls
              v-if="showScoringControls && isLayerSelected(layer.id)"
              :layer-id="layer.id"
              :layer-name="getLayerName(layer.id)"
              :weight="getWeight(layer.id)"
              :direction="getDirection(layer.id)"
              :filter="getFilter(layer.id)"
              :range="getRange(layer.id)"
              :unit="getUnit(layer.id)"
              @update-weight="(id, w) => $emit('update-weight', id, w)"
              @update-direction="(id, d) => $emit('update-direction', id, d)"
              @update-filter="(id, f) => $emit('update-filter', id, f)"
            />
          </div>
        </div>
      </template>

      <template v-if="!devModeOnly">
        <h3 class="category-header" @click="toggleCategory('epa')">
          <span class="arrow" :class="{ expanded: expandedCategories.epa }">▶</span>
          Environment
        </h3>
        <div v-show="expandedCategories.epa">
          <div class="layer-item">
            <label style="color: black">
              <input
                type="checkbox"
                :checked="showContaminationLayers"
                @change="$emit('toggle-contamination-layers')"
              />
              All Individual Sites
            </label>
            <span class="tooltip-wrapper">
              <button
                type="button"
                class="tooltip-icon"
                aria-label="Info about All Individual Sites"
                aria-describedby="tooltip-all-sites"
              >ⓘ</button>
              <span class="tooltip-popup" id="tooltip-all-sites" role="tooltip">Toggle all individual EPA contamination sites on/off.</span>
            </span>
          </div>

          <!-- Individual contamination layer checkboxes -->
          <div v-if="contaminationLayers && contaminationLayers.length > 0" style="margin-left: 20px;">
            <div v-for="layer in contaminationLayers" :key="layer.id" class="layer-item">
              <input
                type="checkbox"
                :id="layer.id"
                :checked="layer.visible"
                @change="$emit('toggle-contamination', layer.id)"
              />
              <label :for="layer.id">{{ layer.name }}</label>
              <span class="tooltip-wrapper" v-if="layer.tooltip">
                <button
                  type="button"
                  class="tooltip-icon"
                  :aria-label="'Info about ' + layer.name"
                  :aria-describedby="'tooltip-' + layer.id"
                >ⓘ</button>
                <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
              </span>
            </div>
          </div>

          <div class="layer-item">
            <label style="color: black">
              <input
                type="checkbox"
                :checked="showContaminationChoropleth"
                @click="$emit('toggle-contamination-choropleth')"
              />
              County-Level Polluted Site Comparison
            </label>
            <span class="tooltip-wrapper">
              <button
                type="button"
                class="tooltip-icon"
                aria-label="Info about County-Level Polluted Site Comparison"
                aria-describedby="tooltip-county-pollution"
              >ⓘ</button>
              <span class="tooltip-popup" id="tooltip-county-pollution" role="tooltip">Total EPA contamination sites per county (lower is better).</span>
            </span>
          </div>
        </div>
      </template>

      <!-- Health Category -->
      <template v-if="demographicLayers.filter(l => l.category === 'Health').length > 0">
        <h3 class="category-header" @click="toggleCategory('health')">
          <span class="arrow" :class="{ expanded: expandedCategories.health }">▶</span>
          Health
        </h3>
        <div v-show="expandedCategories.health">
          <div v-for="layer in demographicLayers.filter(l => l.category === 'Health')" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedDemographicLayers.includes(layer.id)"
              @change="$emit('toggle-demographic', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="tooltip-wrapper" v-if="layer.tooltip">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.tooltip }}</span>
            </span>
            <LayerScoringControls
              v-if="showScoringControls && isLayerSelected(layer.id)"
              :layer-id="layer.id"
              :layer-name="getLayerName(layer.id)"
              :weight="getWeight(layer.id)"
              :direction="getDirection(layer.id)"
              :filter="getFilter(layer.id)"
              :range="getRange(layer.id)"
              :unit="getUnit(layer.id)"
              @update-weight="(id, w) => $emit('update-weight', id, w)"
              @update-direction="(id, d) => $emit('update-direction', id, d)"
              @update-filter="(id, f) => $emit('update-filter', id, f)"
            />
          </div>
        </div>
      </template>
    </div>
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import type {
  DemographicLayer,
  EconomicLayer,
  HousingLayer,
  EquityLayer,
  TransportationLayer,
  ContaminationLayer,
} from '@/config/layerConfig'
import type { ScoringFilter } from '@/types/mapTypes'
import LayerScoringControls from '@/components/LayerScoringControls.vue'

interface Props {
  expanded: boolean
  /** Count of currently-active layers (for the collapsed rail badge) */
  activeLayerCount?: number
  demographicLayers: DemographicLayer[]
  economicLayers?: EconomicLayer[]
  housingLayers?: HousingLayer[]
  equityLayers?: EquityLayer[]
  transportationLayers?: TransportationLayer[]
  contaminationLayers?: ContaminationLayer[]
  selectedDemographicLayers: string[]
  selectedEconomicLayers?: string[]
  selectedHousingLayers?: string[]
  selectedEquityLayers?: string[]
  selectedTransportationLayers?: string[]
  showContaminationLayers: boolean
  showContaminationChoropleth: boolean
  devModeOnly?: boolean
  /** When true, show weight sliders and direction toggles for selected layers */
  showScoringControls?: boolean
  layerWeights?: Record<string, number>
  layerDirections?: Record<string, string>
  /** Active threshold filters, indexed by layer id (one per layer max) */
  activeFilters?: ScoringFilter[]
}

const props = defineProps<Props>()

defineEmits<{
  toggle: []
  'toggle-demographic': [layerId: string]
  'toggle-economic': [layerId: string]
  'toggle-housing': [layerId: string]
  'toggle-equity': [layerId: string]
  'toggle-transportation': [layerId: string]
  'toggle-contamination': [layerId: string]
  'toggle-contamination-layers': []
  'toggle-contamination-choropleth': []
  'update-weight': [layerId: string, weight: number]
  'update-direction': [layerId: string, direction: string]
  /** null → clear the filter for this layer */
  'update-filter': [layerId: string, filter: ScoringFilter | null]
}>()

/** Check if a layer is currently selected (across all category arrays) */
const isLayerSelected = (layerId: string): boolean => {
  return (
    props.selectedDemographicLayers.includes(layerId) ||
    (props.selectedEconomicLayers?.includes(layerId) ?? false) ||
    (props.selectedHousingLayers?.includes(layerId) ?? false) ||
    (props.selectedEquityLayers?.includes(layerId) ?? false) ||
    (props.selectedTransportationLayers?.includes(layerId) ?? false)
  )
}

const getWeight = (layerId: string): number => {
  return props.layerWeights?.[layerId] ?? 5
}

/** Look up the active filter for a given layer, or null if none. */
const getFilter = (layerId: string): ScoringFilter | null => {
  return props.activeFilters?.find(f => f.layerId === layerId) ?? null
}

/** Per-layer range + unit sourced from the registry — used by the filter slider. */
const getRange = (layerId: string): { min: number; max: number } => {
  const reg = LAYER_REGISTRY[layerId]
  return reg?.range ?? { min: 0, max: 100 }
}

const getUnit = (layerId: string): string => LAYER_REGISTRY[layerId]?.unit ?? ''

const getLayerName = (layerId: string): string => LAYER_REGISTRY[layerId]?.name ?? layerId

const getDirection = (layerId: string): string => {
  return props.layerDirections?.[layerId] ?? LAYER_REGISTRY[layerId]?.direction ?? 'neutral'
}

const directionLabel = (dir: string): string => {
  return dir === 'lower_better' ? '↓ Less scores higher' : '↑ More scores higher'
}

const directionTooltip = (layerId: string, dir: string): string => {
  const layer = LAYER_REGISTRY[layerId]
  const name = layer?.name || layerId
  return dir === 'lower_better'
    ? `Lower ${name} values score higher`
    : `Higher ${name} values score higher`
}

const nextDirection = (current: string): string => {
  return current === 'higher_better' ? 'lower_better' : 'higher_better'
}

// Category expansion state
const expandedCategories = ref({
  demographics: false,
  economic: false,
  housing: false,
  equity: false,
  transportation: false,
  epa: false,
  health: false,
})

const toggleCategory = (category: keyof typeof expandedCategories.value) => {
  expandedCategories.value[category] = !expandedCategories.value[category]
}

// Position tooltips dynamically
onMounted(() => {
  const updateTooltipPosition = (e: MouseEvent) => {
    const wrapper = (e.currentTarget as HTMLElement)
    const tooltip = wrapper.querySelector('.tooltip-popup') as HTMLElement
    if (!tooltip) return

    const rect = wrapper.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()

    // Check if mobile viewport
    const isMobile = window.innerWidth <= 768

    if (isMobile) {
      // On mobile, position above the icon
      tooltip.style.left = `${rect.left + rect.width / 2 - tooltipRect.width / 2}px`
      tooltip.style.top = `${rect.top - tooltipRect.height - 8}px`

      // Adjust if going off left edge
      const leftEdge = parseFloat(tooltip.style.left)
      if (leftEdge < 10) {
        tooltip.style.left = '10px'
      }

      // Adjust if going off right edge
      if (leftEdge + tooltipRect.width > window.innerWidth - 10) {
        tooltip.style.left = `${window.innerWidth - tooltipRect.width - 10}px`
      }
    } else {
      // On desktop, position to the left of the icon
      const leftPos = rect.left - tooltipRect.width - 10

      // If would go off-screen, position to the right instead
      if (leftPos < 10) {
        tooltip.style.left = `${rect.right + 10}px`
      } else {
        tooltip.style.left = `${leftPos}px`
      }

      tooltip.style.top = `${rect.top + rect.height / 2 - tooltipRect.height / 2}px`
    }
  }

  // Add event listeners to all tooltip wrappers
  setTimeout(() => {
    document.querySelectorAll('.tooltip-wrapper').forEach(wrapper => {
      wrapper.addEventListener('mouseenter', updateTooltipPosition as EventListener)
    })
  }, 100)
})
</script>

<style scoped>
#layer-control-container {
  max-width: 250px;
}

.layer-control-content {
  background: white;
  padding: 10px;
  margin-top: 6px;
  border-radius: var(--blo-radius-panel);
  border: 1px solid var(--blo-cream-divider);
  box-shadow: var(--blo-shadow-panel);
  /* UX-02: cap height so the ranking panel (bottom-right) remains visible
     when both are open at the same time. Content scrolls internally. */
  max-height: 50vh;
  overflow-y: auto;
  overflow-x: hidden;
}

.layer-control-collapsed #layer-control {
  display: none;
}

.category-header {
  color: black;
  margin-top: 15px;
  margin-bottom: 8px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  padding: 4px 0;
  transition: color 0.2s;
}

.category-header:hover {
  color: #4a90e2;
}

.category-header:first-child {
  margin-top: 5px;
}

.arrow {
  display: inline-block;
  transition: transform 0.2s ease;
  font-size: 12px;
  color: #666;
}

.arrow.expanded {
  transform: rotate(90deg);
}

.layer-control-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background-color: white;
  color: var(--blo-ink);
  border: 1px solid var(--blo-cream-divider);
  padding: 8px 14px;
  cursor: pointer;
  border-radius: var(--blo-radius-input);
  box-shadow: var(--blo-shadow-panel);
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  letter-spacing: 0.01em;
  transition: background-color 120ms ease, border-color 120ms ease;
  width: auto;
  min-width: 0;
}

/* When collapsed, the toggle is the ONLY UI showing — keep it compact + pill-like */
.layer-control-toggle--collapsed {
  background-color: var(--blo-cream);
  padding: 6px 12px;
  font-size: 12px;
}

.layer-control-toggle:hover {
  background-color: var(--blo-cream);
  border-color: var(--blo-stone-soft);
}

.layer-control-gear {
  font-size: 14px;
  color: var(--blo-stone);
  line-height: 1;
}

.layer-control-title {
  white-space: nowrap;
}

.layer-control-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--blo-green);
  color: white;
  font-size: 11px;
  font-weight: 700;
  border-radius: var(--blo-radius-input);
  line-height: 1;
}

.layer-control-chevron {
  font-size: 10px;
  color: var(--blo-stone-soft);
  margin-left: 2px;
}

.layer-control-toggle:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
}

@media (max-width: 768px) {
  /* Mobile: pill goes to bottom-right (clear of the bottom-left Color Key
     stack AND of Mapbox's bottom-right zoom/bearing controls). Content
     panel opens upward and rightward-anchored. */
  #layer-control-container {
    position: fixed !important;
    top: auto !important;
    bottom: 180px !important;
    left: auto !important;
    right: 10px !important;
    max-width: calc(100vw - 20px) !important;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .layer-control-toggle {
    font-size: 13px;
    width: auto !important;
    min-width: 140px;
    box-sizing: border-box;
    position: relative;
  }

  .layer-control-content {
    position: absolute !important;
    bottom: 100% !important;
    right: 0 !important;
    left: auto !important;
    margin-bottom: 8px !important;
    width: auto !important;
    max-width: calc(100vw - 40px) !important;
    min-width: 280px !important;
    box-sizing: border-box !important;
    overflow-x: hidden !important;
  }

  #layer-control {
    max-height: 50vh;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
  }

  #layer-control h3 {
    font-size: 14px;
    word-wrap: break-word;
  }

  .layer-item {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .layer-item label {
    word-wrap: break-word;
    overflow-wrap: break-word;
    max-width: calc(100% - 50px);
  }

  .layer-control-collapsed {
    max-height: none;
  }
}

.layer-item {
  margin: 10px 0;
  color: black;
  position: relative;
}

.layer-item label {
  margin-left: 5px;
  cursor: pointer;
  color: black;
}

.tooltip-wrapper {
  position: relative;
  display: inline-block;
  margin-left: 5px;
  vertical-align: middle;
}

button.tooltip-icon {
  background: none;
  border: none;
  cursor: help;
  font-size: 14px;
  color: #666;
  display: inline-block;
  transition: all 0.2s ease;
  padding: 2px;
  border-radius: 50%;
  line-height: 1;
}

button.tooltip-icon:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 1px;
}

.tooltip-wrapper:hover button.tooltip-icon,
.tooltip-wrapper button.tooltip-icon:focus {
  color: #4a90e2;
  background-color: #f0f7ff;
  transform: scale(1.2);
}

.tooltip-popup {
  visibility: hidden;
  opacity: 0;
  position: fixed;
  background-color: #2c3e50;
  color: white;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  max-width: 250px;
  width: max-content;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 10001;
  pointer-events: none;
  transition: opacity 0.15s ease;
  white-space: normal;
  text-align: left;
}

.tooltip-wrapper:hover .tooltip-popup,
.tooltip-wrapper:focus-within .tooltip-popup {
  visibility: visible;
  opacity: 1;
}

/* Scoring controls (weight / direction / filter) moved into
   <LayerScoringControls> — styles live in that component. */
</style>
