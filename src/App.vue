<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import MapComponent from './components/Map.vue'
</script>

<template>
  <div class="app-container">
    <header>
      <nav>
        <a href="https://blacklandownership.com" target="_blank" rel="noopener noreferrer" class="logo-link">
          <img src="/BLO-FAVICON.png" alt="BLO Logo" class="logo" />
        </a>
        <RouterLink to="/">Map</RouterLink>
        <RouterLink to="/about">About</RouterLink>
      </nav>
    </header>

    <main>
      <RouterView v-slot="{ Component }">
        <component :is="Component || MapComponent" />
      </RouterView>
    </main>
  </div>
</template>

<style>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

header {
  background-color: #f0f0f0;
  padding: 1rem;
}

nav {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.logo-link {
  display: flex;
  align-items: center;
  margin-right: 0.5rem;
}

.logo {
  height: 32px;
  width: 32px;
  transition: opacity 0.2s;
}

.logo:hover {
  opacity: 0.8;
}

main {
  flex-grow: 1;
  display: flex;
}

/* Ensure the MapComponent takes up all available space */
main > :first-child {
  flex-grow: 1;
}

nav a {
  color: #2c3e50;
  text-decoration: none;
}

nav a.router-link-exact-active {
  color: #42b983;
}
</style>
