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
      style="
        background: white;
        padding: 10px;
        border-radius: 4px;
        box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
      "
    >
      <h3 style="color: black">Demographic Layers</h3>
      <div v-for="layer in demographicLayers" :key="layer.id" class="layer-item">
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
      <template v-if="!devModeOnly">
        <h3 style="color: black">EPA - Sites of Land Toxicity</h3>
        <div class="layer-item">
          <label style="color: black">
            <input
              type="checkbox"
              :checked="showContaminationLayers"
              @change="$emit('toggle-contamination-layers')"
            />
            Show All Sites
          </label>
        </div>
        <div class="layer-item">
          <label style="color: black">
            <input
              type="checkbox"
              :checked="showContaminationChoropleth"
              @click="$emit('toggle-contamination-choropleth')"
            />
            County-Level Breakdown
          </label>
        </div>
      </template>
    </div>
    <slot></slot>
  </div>
</template>

<script setup lang="ts">
import type { DemographicLayer } from '@/config/layerConfig'

interface Props {
  expanded: boolean
  demographicLayers: DemographicLayer[]
  selectedDemographicLayers: string[]
  showContaminationLayers: boolean
  showContaminationChoropleth: boolean
  devModeOnly?: boolean
}

defineProps<Props>()

defineEmits<{
  toggle: []
  'toggle-demographic': [layerId: string]
  'toggle-contamination-layers': []
  'toggle-contamination-choropleth': []
}>()
</script>

<style scoped>
#layer-control-container {
  max-width: 250px;
}

.layer-control-collapsed #layer-control {
  display: none;
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

.tooltip-icon {
  cursor: help;
  margin-left: 5px;
  font-size: 14px;
  color: #666;
  position: relative;
}

.tooltip-icon:hover .tooltip-text {
  visibility: visible;
  opacity: 1;
}

.tooltip-text {
  visibility: hidden;
  opacity: 0;
  width: 200px;
  background-color: #555;
  color: #fff;
  text-align: center;
  border-radius: 6px;
  padding: 5px;
  position: absolute;
  z-index: 1;
  bottom: 125%;
  left: 50%;
  margin-left: -100px;
  transition: opacity 0.3s;
  font-size: 12px;
}

.tooltip-text::after {
  content: '';
  position: absolute;
  top: 100%;
  left: 50%;
  margin-left: -5px;
  border-width: 5px;
  border-style: solid;
  border-color: #555 transparent transparent transparent;
}
</style>
