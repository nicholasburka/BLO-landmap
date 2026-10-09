<template>
  <!-- Phase 4d: this component is mounted only inside the Lens "Layers"
       tab. The standalone pill-and-toggle chrome (top-right "Data Layers"
       button) was retired with the Lens; this is the picker UI only. -->
  <div class="layer-control-content layer-control-content--embedded" @click.stop>
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
          <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip" v-html="layer.tooltip"></span>
        </span>
      </div>

      <!-- P5-18: internal library layers — the prop is only ever non-empty
           for a logged-in internal user, so the section never renders on
           the public map. -->
      <template v-if="(internalLayers && internalLayers.length > 0) || (internalPointLayers && internalPointLayers.length > 0)">
        <h3 class="category-header" data-testid="internal-layers-header" @click="toggleCategory('internal')">
          <span class="arrow" :class="{ expanded: expandedCategories.internal }">▶</span>
          Internal
        </h3>
        <div v-show="expandedCategories.internal" data-testid="internal-layers">
          <div v-for="layer in internalLayers" :key="layer.id" class="layer-item">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedInternalLayers?.includes(layer.id)"
              @change="$emit('toggle-internal', layer.id)"
            />
            <label :for="layer.id">{{ layer.name }}</label>
            <span class="layer-links" data-testid="internal-layer-links">
              <RouterLink :to="`/library/${layer.dataKey}`">About</RouterLink>
              ·
              <RouterLink :to="`/library/${layer.dataKey}?tab=data`">Data</RouterLink>
            </span>
            <span class="tooltip-wrapper" v-if="layer.description">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.description }}<template v-if="layer.source"> ({{ layer.source }})</template></span>
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
          <!-- P5-24 points, P7-3 lines, P7-9 states: overlays, not scoring
               layers (no weight controls). The swatch is drawn as the shape
               the layer draws, so the legend reads as the map does. -->
          <div v-for="layer in internalPointLayers ?? []" :key="layer.id" class="layer-item" data-testid="internal-point-layer">
            <input
              type="checkbox"
              :id="layer.id"
              :checked="selectedInternalFeatureLayers?.includes(layer.id)"
              @change="$emit('toggle-internal-point', layer.id)"
            />
            <label :for="layer.id">
              <span
                class="point-swatch"
                :class="{ 'line-swatch': layer.geometry === 'line', 'state-swatch': layer.geometry === 'state' }"
                :style="{ background: layer.color || '#ff6b1c' }"
                aria-hidden="true"
              ></span>
              {{ layer.name }}
            </label>
            <span class="layer-links" data-testid="internal-layer-links">
              <RouterLink :to="`/library/${layer.slug}`">About</RouterLink>
              ·
              <RouterLink :to="`/library/${layer.slug}?tab=data`">Data</RouterLink>
            </span>
            <span class="tooltip-wrapper" v-if="layer.description">
              <button
                type="button"
                class="tooltip-icon"
                :aria-label="'Info about ' + layer.name"
                :aria-describedby="'tooltip-' + layer.id"
              >ⓘ</button>
              <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip">{{ layer.description }}<template v-if="layer.source"> ({{ layer.source }})</template></span>
            </span>
          </div>
        </div>
      </template>

      <!-- Demographics Category -->
      <template v-if="demographicLayers.filter(l => l.category === 'Demographics').length > 0">
        <h3 class="category-header" @click="toggleCategory('demographics')">
          <span class="arrow" :class="{ expanded: expandedCategories.demographics }">▶</span>
          Demographics
        </h3>
        <div v-show="expandedCategories.demographics">
          <LayerRow
            v-for="layer in demographicLayers.filter(l => l.category === 'Demographics')"
            :key="layer.id"
            :layer="layer"
            :checked="selectedDemographicLayers.includes(layer.id) ?? false"
            @toggle="$emit('toggle-demographic', $event)"
          >
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
          </LayerRow>
        </div>
      </template>

      <template v-if="economicLayers && economicLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('economic')">
          <span class="arrow" :class="{ expanded: expandedCategories.economic }">▶</span>
          Economic Indicators
        </h3>
        <div v-show="expandedCategories.economic">
          <LayerRow
            v-for="layer in economicLayers"
            :key="layer.id"
            :layer="layer"
            :checked="selectedEconomicLayers?.includes(layer.id) ?? false"
            @toggle="$emit('toggle-economic', $event)"
          >
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
          </LayerRow>
        </div>
      </template>

      <template v-if="housingLayers && housingLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('housing')">
          <span class="arrow" :class="{ expanded: expandedCategories.housing }">▶</span>
          Housing & Affordability
        </h3>
        <div v-show="expandedCategories.housing">
          <LayerRow
            v-for="layer in housingLayers"
            :key="layer.id"
            :layer="layer"
            :checked="selectedHousingLayers?.includes(layer.id) ?? false"
            @toggle="$emit('toggle-housing', $event)"
          >
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
          </LayerRow>
        </div>
      </template>

      <template v-if="equityLayers && equityLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('equity')">
          <span class="arrow" :class="{ expanded: expandedCategories.equity }">▶</span>
          Racial Equity
        </h3>
        <div v-show="expandedCategories.equity">
          <LayerRow
            v-for="layer in equityLayers"
            :key="layer.id"
            :layer="layer"
            :checked="selectedEquityLayers?.includes(layer.id) ?? false"
            @toggle="$emit('toggle-equity', $event)"
          >
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
          </LayerRow>
        </div>
      </template>

      <template v-if="transportationLayers && transportationLayers.length > 0">
        <h3 class="category-header" @click="toggleCategory('transportation')">
          <span class="arrow" :class="{ expanded: expandedCategories.transportation }">▶</span>
          Transportation
        </h3>
        <div v-show="expandedCategories.transportation">
          <LayerRow
            v-for="layer in transportationLayers"
            :key="layer.id"
            :layer="layer"
            :checked="selectedTransportationLayers?.includes(layer.id) ?? false"
            @toggle="$emit('toggle-transportation', $event)"
          >
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
          </LayerRow>
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

          <!-- Individual contamination layer checkboxes. P5-74: each one's
               GeoJSON is fetched the first time it is switched on, so the row
               carries the load's state — "Loading…" while it is on the way,
               and a retry button (the checkbox goes back off) when it fails. -->
          <div v-if="contaminationLayers && contaminationLayers.length > 0" style="margin-left: 20px;">
            <div v-for="layer in contaminationLayers" :key="layer.id" class="layer-item">
              <input
                type="checkbox"
                :id="layer.id"
                :checked="layer.visible"
                :disabled="layer.status === 'loading'"
                @change="$emit('toggle-contamination', layer.id)"
              />
              <label :for="layer.id">{{ layer.name }}</label>
              <span
                v-if="layer.status === 'loading'"
                class="layer-state"
                role="status"
                data-testid="contamination-loading"
              >Loading…</span>
              <button
                v-else-if="layer.status === 'error'"
                type="button"
                class="layer-state layer-state--error"
                data-testid="contamination-error"
                @click="$emit('retry-contamination', layer.id)"
              >Could not load — try again</button>
              <span class="tooltip-wrapper" v-if="layer.tooltip">
                <button
                  type="button"
                  class="tooltip-icon"
                  :aria-label="'Info about ' + layer.name"
                  :aria-describedby="'tooltip-' + layer.id"
                >ⓘ</button>
                <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip" v-html="layer.tooltip"></span>
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
          <LayerRow
            v-for="layer in demographicLayers.filter(l => l.category === 'Health')"
            :key="layer.id"
            :layer="layer"
            :checked="selectedDemographicLayers.includes(layer.id) ?? false"
            @toggle="$emit('toggle-demographic', $event)"
          >
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
          </LayerRow>
        </div>
      </template>
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
import type { LayerDefinition } from '@/config/layerRegistry'
import type { InternalFeatureLayer } from '@/lib/internalLayers'
import LayerRow from '@/components/LayerRow.vue'
import LayerScoringControls from '@/components/LayerScoringControls.vue'

interface Props {
  demographicLayers: DemographicLayer[]
  economicLayers?: EconomicLayer[]
  housingLayers?: HousingLayer[]
  equityLayers?: EquityLayer[]
  transportationLayers?: TransportationLayer[]
  contaminationLayers?: ContaminationLayer[]
  /** P5-18: runtime-registered internal layers (logged-in only). */
  internalLayers?: LayerDefinition[]
  /** P5-24: internal point layers (logged-in only). */
  internalPointLayers?: InternalFeatureLayer[]
  selectedDemographicLayers: string[]
  selectedEconomicLayers?: string[]
  selectedHousingLayers?: string[]
  selectedEquityLayers?: string[]
  selectedTransportationLayers?: string[]
  selectedInternalLayers?: string[]
  selectedInternalFeatureLayers?: string[]
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
  'toggle-demographic': [layerId: string]
  'toggle-economic': [layerId: string]
  'toggle-housing': [layerId: string]
  'toggle-equity': [layerId: string]
  'toggle-transportation': [layerId: string]
  'toggle-internal': [layerId: string]
  'toggle-internal-point': [layerId: string]
  'toggle-contamination': [layerId: string]
  /** P5-74: "try again" after a contamination GeoJSON failed to load. */
  'retry-contamination': [layerId: string]
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
    (props.selectedTransportationLayers?.includes(layerId) ?? false) ||
    (props.selectedInternalLayers?.includes(layerId) ?? false)
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
  internal: true,
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
/* The host (Lens "Layers" tab) owns the panel chrome — this just renders
   the picker UI flush inside whatever container it's mounted in. */
.layer-control-content {
  background: transparent;
  padding: 0;
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

/* Phase 4d: standalone pill/toggle CSS removed — picker is embed-only now */

@media (max-width: 768px) {
  /* Mobile: items wrap so long layer names don't push past the drawer edge */
  .layer-item {
    display: flex;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .layer-item :deep(label) {
    word-wrap: break-word;
    overflow-wrap: break-word;
    max-width: calc(100% - 50px);
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

/* P5-74: the on-demand load's state, inline on the row. Quiet while it
   loads; the error is a button because it is the way back in. */
.layer-state {
  margin-left: 6px;
  font-size: 11px;
  color: #6b6560;
  font-style: italic;
}

button.layer-state {
  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
}

.layer-state--error {
  color: #b91c1c;
  cursor: pointer;
  text-decoration: underline;
  font-style: normal;
}

:deep(.tooltip-wrapper) {
  position: relative;
  display: inline-block;
  margin-left: 5px;
  vertical-align: middle;
}

:deep(button.tooltip-icon) {
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

:deep(.tooltip-wrapper:hover button.tooltip-icon),
:deep(.tooltip-wrapper button.tooltip-icon:focus) {
  color: #4a90e2;
  background-color: #f0f7ff;
  transform: scale(1.2);
}

:deep(.tooltip-popup) {
  visibility: hidden;
  opacity: 0;
  position: fixed;
  background-color: #2c3e50;
  color: white;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  max-width: 260px;
  width: max-content;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 10001;
  /* Allow tooltip content (e.g. the BLO methodology link) to receive
     pointer events. The wrapper's :hover keeps the popup visible while
     the user moves into it via :hover on the popup itself too. */
  pointer-events: auto;
  transition: opacity 0.15s ease;
  white-space: normal;
  text-align: left;
}

:deep(.tooltip-wrapper:hover .tooltip-popup),
:deep(.tooltip-wrapper:focus-within .tooltip-popup),
:deep(.tooltip-popup:hover) {
  visibility: visible;
  opacity: 1;
}

/* Make any embedded links visible against the dark tooltip background. */
:deep(.tooltip-popup a) {
  color: #9be29b;
  text-decoration: underline;
}
:deep(.tooltip-popup a:hover) {
  color: white;
}

/* Scoring controls (weight / direction / filter) moved into
   <LayerScoringControls> — styles live in that component. */
.layer-links {
  margin-left: 6px;
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
  white-space: nowrap;
}

.layer-links a {
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}

.layer-links a:hover {
  text-decoration: underline;
}

.point-swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  margin-right: 4px;
  vertical-align: middle;
}

/* P7-3: a line layer's swatch is a stroke, not a dot — the one visual cue
   that says which of two overlays will draw as a corridor. */
.point-swatch.line-swatch {
  width: 14px;
  height: 3px;
  border-radius: 2px;
  border: none;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}

/* P7-9: a state layer's swatch is an AREA — a filled rectangle at the wash's
   own opacity, inside a solid border, which is exactly the two paint layers
   the map draws. The three swatches are the only thing in the panel that says
   whether an overlay will arrive as dots, a corridor, or a region. */
.point-swatch.state-swatch {
  width: 14px;
  height: 10px;
  border-radius: 2px;
  border: none;
  opacity: 0.55;
  box-shadow: 0 0 0 1.5px currentColor;
}
</style>
