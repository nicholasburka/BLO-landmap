<script setup lang="ts">
/**
 * The library's own strip (P6-13; was the resource tabs of P6-5, spec §A.2).
 *
 * Both of the spec's axes, in one row with a divider between them:
 *
 *   Datasets · Docs · Analysis │ Search · Chat · New
 *   ──── the three RESOURCES ──┼──── the three FUNCTIONS ────
 *
 * The three nouns are what the library HOLDS; the three verbs are what you DO
 * with it. P6-5 put the verbs in the sitewide header beside Map and About,
 * which read as a claim that they are site-level destinations — they are not,
 * they are the library's own top level, which is what Nick named on
 * 2026-10-03. The divider is what keeps them from reading as six of the same
 * thing; the order (browse, then do) is the order a person arrives in.
 *
 * It replaces the eight-item strip (Overview · Ask · Check a place · Library ·
 * Pages · Map layers · Compare · Ideas), every item of which either lives here
 * now, became a filter inside a browser, or became a tool card on Analysis.
 */
import { computed } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import KbNavIcon from '@/components/KbNavIcon.vue'
import { shortlist } from '@/lib/compare'

const route = useRoute()

/** What the library holds. The entry routes are included so opening a dataset,
 *  a page or a saved view keeps the tab it was reached from lit —
 *  `/library/:slug` is the one that can be either, so it lights nothing.
 *  (`/wiki` is matched here even though this strip is not rendered on
 *  `WikiPageView` today: the rule is the vocabulary, not the current call
 *  sites, and a page that starts rendering the strip should light Docs.) */
const RESOURCES = [
  { to: '/datasets', label: 'Datasets', icon: 'datasets', match: /^\/(datasets|layers)(\/|$)/ },
  { to: '/docs', label: 'Docs', icon: 'docs', match: /^\/(docs|wiki)(\/|$)/ },
  { to: '/analysis', label: 'Analysis', icon: 'analysis', match: /^\/(analysis|place|compare|views)(\/|$)/ },
] as const

/** What you do with it. Single pages, so each marks itself exactly. */
const FUNCTIONS = [
  { to: '/search', label: 'Search', icon: 'search', match: /^\/search(\/|$)/ },
  { to: '/chat', label: 'Chat', icon: 'chat', match: /^\/chat(\/|$)/ },
  { to: '/new', label: 'New', icon: 'new', match: /^\/new(\/|$)/ },
] as const

const itemsFor = (sections: typeof RESOURCES | typeof FUNCTIONS) =>
  sections.map(section => ({
    to: section.to,
    label: section.label,
    icon: section.icon,
    active: section.match.test(route.path),
    // P5-55: the badge is the whole point of Compare being reachable from
    // here — counties added from the map or a layer's table pile up out of
    // sight until something says how many are waiting. Compare is a tool on
    // Analysis now, so the count rides on that tab.
    badge: section.to === '/analysis' ? shortlist.value.length : 0,
  }))

const resources = computed(() => itemsFor(RESOURCES))
const functions = computed(() => itemsFor(FUNCTIONS))
</script>

<template>
  <nav class="kb-nav strip" aria-label="Library" data-testid="kb-nav">
    <RouterLink v-for="item in resources" :key="item.to" :to="item.to" class="kb-nav-link" :class="{ active: item.active }" :aria-current="item.active ? 'page' : undefined">
      <KbNavIcon :name="item.icon" />{{ item.label }}
      <span v-if="item.badge" class="kb-nav-badge" data-testid="shortlist-badge" :aria-label="`${item.badge} counties on the shortlist`">
        {{ item.badge }}
      </span>
    </RouterLink>
    <!-- Decorative: the two groups are already named to a screen reader by the
         nav labels below, so the bar itself must not be announced. -->
    <span class="kb-nav-divider" aria-hidden="true" data-testid="kb-nav-divider"></span>
    <RouterLink v-for="item in functions" :key="item.to" :to="item.to" class="kb-nav-link" :class="{ active: item.active }" :aria-current="item.active ? 'page' : undefined">
      <KbNavIcon :name="item.icon" />{{ item.label }}
    </RouterLink>
  </nav>
</template>

<style scoped>
.kb-nav {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.kb-nav-link {
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.kb-nav-link:hover {
  color: var(--blo-ink, #111);
}

.kb-nav-link.active {
  color: var(--blo-ink, #111);
  border-bottom-color: var(--blo-green-deep, #1f7a2e);
}

/* The glyph is quiet until the item is the one you are on, or under the
   pointer. These live here because `.kb-nav-link` is this component's class;
   `:deep` reaches the icon inside its own scope. */
.kb-nav-link.active :deep(.kb-icon),
.kb-nav-link:hover :deep(.kb-icon) {
  opacity: 1;
}

/* The seam between what the library holds and what you do with it. A hairline
   rather than a gap: a gap alone reads as a layout accident at narrow widths,
   where the row scrolls. */
.kb-nav-divider {
  align-self: center;
  width: 1px;
  height: 18px;
  margin: 0 8px;
  background: var(--blo-cream-divider, #e0d9ca);
}

.kb-nav-badge {
  display: inline-block;
  min-width: 16px;
  margin-left: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.4;
  text-align: center;
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border-radius: 999px;
}

/* P5-60: six items no longer fit on a phone, so the strip earns its rules —
   it is what
   keeps a long label from widening the whole page, and they cost nothing.
   These overrides live here rather than in the shared sheet because a scoped
   rule beats a plain global class. */
@media (max-width: 640px) {
  .kb-nav {
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 2px;
    margin-bottom: 12px;
  }

  /* Six items scroll where three fitted; the divider keeps its own margins so
     the two groups stay distinguishable mid-scroll. */
  .kb-nav-divider {
    flex: 0 0 auto;
    margin: 0 6px;
  }

  .kb-nav-link {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 12px;
    font-size: 14px;
    white-space: nowrap;
  }

  .kb-nav-badge {
    font-size: 13px;
  }
}
</style>
