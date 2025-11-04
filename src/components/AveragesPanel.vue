<template>
  <div
    id="averages-panel"
    :class="{ 'averages-panel-collapsed': !expanded }"
    style="position: absolute; bottom: 10px; left: 10px; z-index: 10; pointer-events: auto"
    @click.stop
  >
    <button
      @click="$emit('toggle')"
      class="averages-panel-toggle"
      :aria-expanded="expanded"
      aria-controls="averages-content"
      aria-label="Toggle county averages panel"
    >
      {{ expanded ? '▼' : '▲' }} County Averages
    </button>
    <div v-show="expanded" id="averages-content" class="averages-content">
      <p>BLO Combined Score: 2.84 of 5</p>
      <p>Black Population: 9.05%</p>
      <p>Diversity Index: 0.33 of 1</p>
      <p>Sites of Land Toxicity: 8.77</p>
      <p>Life Expectancy: 77.74 years</p>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  expanded: boolean
}

defineProps<Props>()

defineEmits<{
  toggle: []
}>()
</script>

<style scoped>
#averages-panel {
  background: white;
  padding: 10px;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  max-width: 300px;
}

.averages-panel-collapsed .averages-content {
  display: none;
}

.averages-panel-toggle {
  background-color: white;
  border: none;
  padding: 12px 15px;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font-weight: 600;
  border-radius: 4px;
  min-height: 44px;
  font-size: 16px;
}

.averages-panel-toggle:hover {
  background-color: #f0f0f0;
}

.averages-panel-toggle:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
}

.averages-content {
  margin-top: 10px;
  color: #333;
}

.averages-content p {
  margin: 5px 0;
  font-size: 14px;
}

@media (max-width: 768px) {
  #averages-panel {
    display: none;
  }
}
</style>
