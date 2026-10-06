<template>
  <!-- Nothing is ever really seen: the redirect runs before this paints.
       The line is here for the instant a slow device takes to swap routes,
       and for a screen reader that reaches the page mid-navigation. -->
  <p class="moving" data-testid="retired-redirect">Taking you there…</p>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { retiredTarget } from '@/lib/retiredRoutes'

/**
 * P6-5: the pages the cutover retired, still answering.
 *
 * `/library` and `/wiki` cannot be plain `redirect:` entries in the route
 * table because where they go depends on what they were asked for — a
 * `?kind=` decides between three browsers and a search. `retiredTarget` holds
 * that decision as a pure function (so every case is a unit test, not a
 * click-through), and this component is the two lines of Vue that run it.
 *
 * `replace`, not `push`: a retired URL is not a place in history, and Back
 * from the browser we land on should leave rather than bounce through here.
 */
const route = useRoute()
const router = useRouter()

onMounted(() => {
  void router.replace(retiredTarget(route.path, route.query))
})
</script>

<style scoped>
.moving {
  padding: 24px 20px;
  font-size: 14px;
  color: var(--blo-stone);
}
</style>
