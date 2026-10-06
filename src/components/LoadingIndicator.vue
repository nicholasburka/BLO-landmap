<template>
  <div v-if="!loaded" class="loading-overlay">
    <div class="loading-content">
      <div class="progress-bar">
        <div class="progress" :style="{ width: `${progress}%` }"></div>
      </div>
      <div class="loading-text">Loading counties…</div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The map's startup overlay. P5-74: it reports the county dataset and
 * nothing else — contamination GeoJSONs load on demand now — and it never
 * takes a click, so the map underneath stays usable while the counties
 * arrive.
 *
 * P5-87: the basemap is already up and painting behind it — the map is
 * constructed before the county files are fetched, not after — so this is a
 * progress report on two downloads, not a wait for the map itself.
 */
interface Props {
  /** True once the choropleth can paint; the overlay disappears. */
  loaded: boolean
  /** 0-100: county files landed, out of county files expected. */
  progress: number
}

defineProps<Props>()
</script>

<style scoped>
.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.9);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
  /* P5-74: never blocks. The overlay is a status report, not a modal —
     panning, zooming and the Lens all keep working underneath it. */
  pointer-events: none;
}

.loading-content {
  text-align: center;
  min-width: 200px;
}

.progress-bar {
  width: 100%;
  height: 20px;
  background-color: #f0f0f0;
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 10px;
}

.progress {
  height: 100%;
  background-color: #4caf50;
  transition: width 0.3s ease;
}

.loading-text {
  font-size: 14px;
  color: #333;
}
</style>
