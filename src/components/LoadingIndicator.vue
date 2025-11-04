<template>
  <div v-if="!loaded" class="loading-overlay">
    <div class="loading-content">
      <div class="progress-bar">
        <div class="progress" :style="{ width: `${progress}%` }"></div>
      </div>
      <div class="loading-text">Loading layers: {{ progress }}%</div>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  loaded: boolean
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
