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
        <h1 class="site-title">U.S. Livability Index</h1>
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
  background-color: var(--blo-cream);
  border-bottom: 1px solid var(--blo-cream-divider);
  padding: 12px 20px;
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

.site-title {
  margin: 0;
  font-family: var(--blo-font-display);
  font-size: 1.4rem;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--blo-ink);
}

main {
  flex-grow: 1;
  display: flex;
  min-height: 0;
}

/* Ensure the MapComponent takes up all available space */
main > :first-child {
  flex-grow: 1;
}

nav a {
  color: var(--blo-stone);
  text-decoration: none;
  font-size: 13px;
  font-weight: 500;
  padding: 4px 8px;
  border-radius: var(--blo-radius-input);
  transition: color 120ms ease, background-color 120ms ease;
}

nav a:hover {
  color: var(--blo-ink);
  background-color: rgba(17, 17, 17, 0.04);
}

nav a.router-link-exact-active {
  color: var(--blo-green-deep);
  font-weight: 600;
}
</style>
