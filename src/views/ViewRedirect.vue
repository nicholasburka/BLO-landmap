<template>
  <!-- P7-2: a view that PRESENTS a working set stops here and gets the set's
       two interfaces, because this is the URL they live at. A view with no set
       is ad-hoc — permanent and first-class, never legacy — and goes exactly
       where it has always gone, by exactly the code below. -->
  <WorkingSetWorkspace v-if="workspaceView" :view="workspaceView" />

  <!-- Almost nothing renders: this route exists so /views/<slug> share links
       get the internal-route guard (login redirect + return), then land on
       the surface that can restore the view. The line below is only ever
       seen for the instant the document takes to arrive. -->
  <p v-else-if="!missing" class="opening" data-testid="view-redirect">Opening saved view…</p>

  <!-- P5-69: a link to a view that is not there any more used to drop the
       reader on a plain map with no explanation. Say what happened, and
       offer the two places worth going next. -->
  <div v-else-if="missing" class="view-missing" data-testid="view-missing">
    <p class="missing-line">There is no saved view called “{{ slug }}”.</p>
    <p class="missing-links">
      <RouterLink to="/analysis">Saved views</RouterLink>
      ·
      <RouterLink to="/">The map</RouterLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import WorkingSetWorkspace from '@/components/WorkingSetWorkspace.vue'
import { compareStateOf, compareViewUrl, fetchView, tableStateOf, tableViewUrl, type SavedView } from '@/lib/views'

/**
 * P5-16 shim: /views/:slug → the surface that can restore that view.
 *
 * The map lives at `/`, which can't carry `meta.requiresInternal` (the
 * public map must stay public). This guarded route gives shared view links
 * the login-redirect flow, then immediately replaces itself with the URL
 * the view restores from. `replace` keeps the shim out of history so Back
 * doesn't bounce through it.
 *
 * P5-54: a saved TABLE view restores in the explorer instead, so the
 * document has to be read before we know where to go. P5-55 adds a third
 * destination — a saved comparison restores on /compare.
 *
 * P5-69: a 404 — the view was deleted, or the slug was mistyped — stops
 * here and says so. A document that IS there but cannot be read (hand
 * edited, a table naming no dataset) still falls back to the map, which
 * has always degraded quietly; so does a failed fetch, because the map is
 * public and a logged-out visitor should still see it.
 *
 * P7-2 adds the one case that does NOT redirect: a view presenting a working
 * set is already where it belongs, because `/views/:slug` is the URL the set's
 * two interfaces live at. So this is now a fork rather than only a shim — and
 * the ad-hoc branch is untouched, which is the point. A view with no working
 * set is a permanent, first-class state (spec §F.1: ad-hoc, not legacy), and
 * every line below that decides where such a view goes is the line that
 * decided it yesterday.
 */
const route = useRoute()
const router = useRouter()

const slug = String(route.params.slug)
const missing = ref(false)
/** P7-2: set when this view presents a working set — the workspace renders
 *  here instead of anything being replaced. Null for an ad-hoc view, which is
 *  every view saved before P7-1 and plenty saved after. */
const workspaceView = ref<SavedView | null>(null)

onMounted(async () => {
  const mapUrl = { path: '/', query: { view: slug } }
  try {
    const view = await fetchView(slug)
    if (!view) {
      missing.value = true
      return
    }
    // The one fork. Everything after it is P5-16/P5-54/P5-55, unchanged.
    if (view.workingSet) {
      workspaceView.value = view
      return
    }
    const table = tableStateOf(view)
    if (table) {
      await router.replace(tableViewUrl(table, slug))
      return
    }
    const compare = compareStateOf(view)
    await router.replace(compare ? compareViewUrl(compare, slug) : mapUrl)
  } catch {
    await router.replace(mapUrl)
  }
})
</script>

<style scoped>
.opening {
  padding: 24px 20px;
  font-size: 14px;
  color: var(--blo-stone);
}

.view-missing {
  padding: 24px 20px;
  font-size: 14px;
}

.missing-line {
  margin: 0 0 8px;
  color: var(--blo-ink, #1a1a1a);
}

.missing-links {
  margin: 0;
  color: var(--blo-stone);
}

.missing-links a {
  color: inherit;
}
</style>
