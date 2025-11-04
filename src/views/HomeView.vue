<script setup lang="ts">
import MapComponent from '../components/Map.vue'
</script>

<template>
  <main class="map-view">
    <MapComponent />
  </main>
</template>

<style scoped>
.map-view {
  display: flex;
  width: 100%;
  height: 100%;
  flex-grow: 1;
}
</style>
