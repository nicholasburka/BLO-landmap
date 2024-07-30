<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import MapComponent from './components/Map.vue'
</script>

<template>
  <div class="app-container">
    <header>
      <nav>
        <RouterLink to="/">Home</RouterLink>
        <RouterLink to="/about">About</RouterLink>
      </nav>
    </header>

    <main>
      <MapComponent />
    </main>

    <!--<RouterView />-->
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
  gap: 1rem;
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
