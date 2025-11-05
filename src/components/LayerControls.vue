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
      :aria-expanded="expanded"
      aria-controls="layer-control"
      aria-label="Toggle layer controls"
    >
      {{ expanded ? '▼' : '▲' }} Data Layers
    </button>
    <div
      id="layer-control"
      v-show="expanded"
      @click.stop
      class="layer-control-content"
    >
      <!-- BLO Liveability Index (no category) -->
      <div v-for="layer in demographicLayers.filter(l => !l.category)" :key="layer.id" class="layer-item">
        <input
          type="checkbox"
          :id="layer.id"
          :checked="selectedDemographicLayers.includes(layer.id)"
          @change="$emit('toggle-demographic', layer.id)"
        />
        <label :for="layer.id">{{ layer.name }}</label>
        <span class="tooltip-icon" v-if="layer.tooltip">
          ⓘ
          <span class="tooltip-text">{{ layer.tooltip }}</span>
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
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">{{ layer.tooltip }}</span>
            </span>
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
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">{{ layer.tooltip }}</span>
            </span>
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
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">{{ layer.tooltip }}</span>
            </span>
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
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">{{ layer.tooltip }}</span>
            </span>
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
              Individual Sites of Pollution
            </label>
            <span class="tooltip-wrapper">
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">Individual EPA contamination sites (Superfund, hazardous waste, toxic release, brownfields, air pollution).</span>
            </span>
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
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">Total EPA contamination sites per county (lower is better).</span>
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
              <span class="tooltip-icon">ⓘ</span>
              <span class="tooltip-popup">{{ layer.tooltip }}</span>
            </span>
          </div>
        </div>
      </template>
    </div>
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type {
  DemographicLayer,
  EconomicLayer,
  HousingLayer,
  EquityLayer,
} from '@/config/layerConfig'

interface Props {
  expanded: boolean
  demographicLayers: DemographicLayer[]
  economicLayers?: EconomicLayer[]
  housingLayers?: HousingLayer[]
  equityLayers?: EquityLayer[]
  selectedDemographicLayers: string[]
  selectedEconomicLayers?: string[]
  selectedHousingLayers?: string[]
  selectedEquityLayers?: string[]
  showContaminationLayers: boolean
  showContaminationChoropleth: boolean
  devModeOnly?: boolean
}

defineProps<Props>()

defineEmits<{
  toggle: []
  'toggle-demographic': [layerId: string]
  'toggle-economic': [layerId: string]
  'toggle-housing': [layerId: string]
  'toggle-equity': [layerId: string]
  'toggle-contamination-layers': []
  'toggle-contamination-choropleth': []
}>()

// Category expansion state
const expandedCategories = ref({
  demographics: false,
  economic: false,
  housing: false,
  equity: false,
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
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  max-height: 70vh;
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
  background-color: white;
  border: none;
  padding: 12px 15px;
  cursor: pointer;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  width: 100%;
  text-align: left;
  font-weight: 600;
  min-height: 44px;
  font-size: 16px;
}

.layer-control-toggle:hover {
  background-color: #f0f0f0;
}

.layer-control-toggle:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
}

@media (max-width: 768px) {
  #layer-control-container {
    position: fixed !important;
    top: auto !important;
    bottom: 20px !important;
    right: auto !important;
    left: 10px !important;
    max-width: calc(100vw - 20px) !important;
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }

  .layer-control-toggle {
    font-size: 14px;
    width: auto !important;
    min-width: 140px;
    box-sizing: border-box;
    position: relative;
  }

  .layer-control-content {
    position: absolute !important;
    bottom: 100% !important;
    left: 0 !important;
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

.tooltip-icon {
  cursor: help;
  font-size: 14px;
  color: #666;
  display: inline-block;
  transition: all 0.2s ease;
  padding: 2px;
  border-radius: 50%;
}

.tooltip-wrapper:hover .tooltip-icon {
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

.tooltip-wrapper:hover .tooltip-popup {
  visibility: visible;
  opacity: 1;
}
</style>
