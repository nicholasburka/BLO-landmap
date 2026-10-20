<template>
  <!-- P11-2: a working set's own page. Thin on purpose — the same shape
       `ViewRedirect` has — because the workspace is the component and this is
       only the route that mounts it with a slug off the URL. -->
  <WorkingSetWorkspace :slug="slug" />
</template>

<script setup lang="ts">
/**
 * `/sets/:slug` — where a working set lives (P11-2).
 *
 * Before this route, the workspace could only be reached through a saved view
 * that presented a set, so a set with no view could not be opened at all —
 * and `createWorkingSet` makes sets with no view, which is how the Explore
 * flow shipped unreachable ones. The set is the object; this is its address.
 *
 * `/views/<slug>` for a set-presenting view redirects here and keeps working.
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import WorkingSetWorkspace from '@/components/WorkingSetWorkspace.vue'

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
</script>
