<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import StagingGate from './components/StagingGate.vue'
import GlobalSearch from './components/GlobalSearch.vue'
// Lazy on purpose: the help drawer and the phone Menu are internal-only, and
// their copy has no business in the public entry chunk (P5-19 bundle rule).
const InternalHeaderTools = defineAsyncComponent(() => import('./components/InternalHeaderTools.vue'))
// P5-60: the shared phone rules for the internal surfaces. Lazy and gated on
// `internalUser` for the same reason — a logged-out visitor's map must never
// load a byte of them, so the public header cannot shift by a pixel.
const InternalMobileStyles = defineAsyncComponent(() => import('./components/InternalMobileStyles.vue'))
import { recordFirstRunVisit } from './lib/firstRun'
import { useAuth } from './composables/useAuth'

// Internal-session entry point (phase 5): "Log in" for visitors, the
// username (→ /account) once authenticated. Logged out, this link is the
// only visible difference from the public map.
const { internalUser } = useAuth()

// P6-13: the sitewide header carries the things that ARE sitewide — Map,
// About, Library — and nothing else. Search, Chat and New moved into the
// library's own strip (see KbNav), because that is what they are: this spec's
// three FUNCTIONS over its three RESOURCES, both halves belonging to the
// library and not to the site. P6-5 had put all four next to Map and About,
// which said they were site-level destinations; standing on Search, nothing
// in the chrome said you were inside the library at all.
//
// `Library` still sits inside ONE `<template v-if>` rather than carrying its
// own: a false v-if renders a `<!--v-if-->` marker and the logged-out
// header's byte-for-byte snapshot counts them — one template renders one
// marker whether it holds one link or four, which is exactly why removing
// three links leaves that snapshot untouched. (Template comments are rendered
// too, which is why this explanation lives here and not beside the markup.)
// P5-60 (mobile pass): `data-internal-nav` on the <nav> is the hook every
// collapsed-header rule hangs off. Bound to `undefined` when logged out, so no
// attribute is rendered at all and the public header's markup is byte-for-byte
// what it was — and after a logout the rules stop matching even though the
// lazily-loaded stylesheet is still in the document. Nothing else in this file
// changes for a logged-out visitor.
const route = useRoute()
// P5-65: every internal surface is a knowledge-base page, so the header stops
// calling any of them the public map. P5-73 added /account, which is reachable
// only from inside; P6-5 adds the four new surfaces and the three browsers.
const INTERNAL_PATHS =
  /^\/(kb|search|chat|new|datasets|docs|analysis|place|compare|layers|library|wiki|views|account)(\/|$)/
const inKnowledgeBase = computed(() => !!internalUser.value && INTERNAL_PATHS.test(route.path))

// "Library" is the landing AND everything you browse from it, so it stays lit
// while somebody is three clicks deep in a dataset — and now also while they
// are searching, chatting or adding, because those are inside the library too.
// P6-13 narrowed this from `(search|chat|new|account)`: treating the three
// functions as NOT the library was the plane confusion written down in code,
// and it put the header's only lit item out while you used one. `/account` is
// the one internal page that genuinely belongs to the person, not the library.
const OWN_PAGES = /^\/(account)(\/|$)/
const inLibrary = computed(() => inKnowledgeBase.value && !OWN_PAGES.test(route.path))
const siteTitle = computed(() => (inKnowledgeBase.value ? 'BLO Knowledge base' : 'U.S. Livability Index'))

// P5-43: the first-run checklist ticks itself off from the pages someone
// visits, so the watching has to live here rather than on the landing — the
// visits it cares about happen while the landing is unmounted. Logged-out
// visitors are never tracked and nothing is written for them.
// P5-71: only the steps a URL can honestly prove are matched from a visit —
// `/search?q=` cannot exist until somebody searched, and `/place?address=`
// cannot exist until somebody ran a report. The rest are actions, and the
// surface that performs one calls completeFirstRunStep.
const router = useRouter()
router.afterEach(to => {
  if (internalUser.value) recordFirstRunVisit(to.path, to.query)
})
</script>

<template>
  <div class="app-container">
    <header>
      <nav :data-internal-nav="internalUser ? '' : undefined">
        <a href="https://blacklandownership.com" target="_blank" rel="noopener noreferrer" class="logo-link">
          <img src="/BLO-FAVICON.png" alt="BLO Logo" class="logo" />
        </a>
        <h1 class="site-title">{{ siteTitle }}</h1>
        <RouterLink to="/">Map</RouterLink>
        <RouterLink to="/about">About</RouterLink>
        <template v-if="internalUser">
          <RouterLink to="/kb" :class="{ 'router-link-exact-active': inLibrary }">Library</RouterLink>
        </template>
        <GlobalSearch v-if="internalUser" />
        <InternalHeaderTools v-if="internalUser" />
        <RouterLink v-if="internalUser" to="/account" class="internal-entry">{{
          internalUser.username
        }}</RouterLink>
        <RouterLink v-else to="/login" class="internal-entry">Log in</RouterLink>
      </nav>
    </header>

    <main>
      <!-- P5-86: no fallback. While a lazy route's chunk is in flight
           `Component` is undefined and the slot renders nothing — the header
           stays, and the shell never mounts the map behind a page that has no
           use for it (which used to start 10 MB of county downloads on every
           internal page and on /login). The map is rendered by HomeView, for
           `/` alone. -->
      <RouterView v-slot="{ Component }">
        <component v-if="Component" :is="Component" />
      </RouterView>
    </main>

    <!-- Staging gate: renders only when VITE_STAGING_GATE_ENABLED=true
         on this build. On prod the flag is unset so the component is
         entirely no-op. -->
    <StagingGate />

    <!-- Outside <header> on purpose: it draws nothing, and keeping it out of
         the header means the logged-out header markup is untouched. -->
    <InternalMobileStyles v-if="internalUser" />
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

/* The route slot fills the shell (the map on `/`, a page everywhere else). */
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

/* Unobtrusive internal entry: quieter than the public nav links until
   hovered, so logged-out visitors barely register it. */
nav a.internal-entry {
  color: var(--blo-stone-soft);
  font-weight: 400;
}

nav a.internal-entry:hover,
nav a.internal-entry.router-link-exact-active {
  color: var(--blo-ink);
}

</style>
