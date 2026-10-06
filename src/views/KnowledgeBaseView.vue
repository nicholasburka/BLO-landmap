<script setup lang="ts">
/**
 * The front door (P5-40, rebuilt by P5-68, rebuilt again by P6-5).
 *
 * The header above carries what a person DOES — Library, Search, Chat, New —
 * and the resource tabs carry the three kinds of thing the library holds, so
 * the landing no longer has to be a menu. It is a short answer to "what has
 * been happening, and what is in here":
 *
 *   1 recently edited   2 pinned items   3 the three resources, with counts
 *   4 the most recent items   5 admin only, last: needs attention, what happened
 *
 * One column, in that order, on every width — the spec's order is the reading
 * order, and a second column would only decide it for the reader.
 *
 * Two blocks sit above the list because they are not part of it: the
 * initiative hero (what this whole library is for, from `library/kb.json`, so
 * nothing about it is hard-coded here) and the first-run checklist, which a
 * person sees once and never again.
 *
 * The P5-68 flow cards are gone: asking is a header item now, Check a place is
 * a tool card on Analysis, and "browse" is the tab strip.
 */
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import InitiativePanel from '@/components/InitiativePanel.vue'
import FirstRunChecklist from '@/components/FirstRunChecklist.vue'
import AttentionPanel from '@/components/AttentionPanel.vue'
import ActivityFeed from '@/components/ActivityFeed.vue'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { fetchKbConfig, KB_CONFIG_DEFAULTS, type KbConfig } from '@/lib/kbConfig'
import { fetchPlaceReports } from '@/lib/placeReport'
import { publicLayers } from '@/lib/publicLayers'
import { kbCounts, recentlyUpdated, attentionItems, entryHref, kindLabel, relativeTime } from '@/lib/kb'
import { fetchRecentEdits, recentlyEdited, type EditRow, type RecentEdit } from '@/lib/recentlyEdited'
import { firstRunVisible } from '@/lib/firstRun'
import { useAuth } from '@/composables/useAuth'
import { openHelpDrawer } from '@/lib/helpRecipes'
import { friendlyError } from '@/lib/errors'

const { internalUser } = useAuth()
// The curation backlog and the audit feed are an admin's view of the place,
// not a researcher's — they go last, and only for an admin (Nick, 2026-09-05).
const isAdmin = computed(() => internalUser.value?.role === 'admin')

const entries = ref<CatalogEntry[]>([])
const loading = ref(true)
const error = ref('')

const config = ref<KbConfig>({ ...KB_CONFIG_DEFAULTS })
const configLoading = ref(true)

const edits = ref<EditRow[]>([])
const editsLoading = ref(true)
const editsError = ref('')

/** Cached place reports, for the Analysis tile's half of its count. The index
 *  is capped server-side, so this is "recent reports", not "every report ever
 *  run" — which is what the tile's sub-line says. */
const reportCount = ref(0)

onMounted(() => {
  // Four independent requests: a slow config must not hold up the directory,
  // and a failed edits feed must not empty the tiles.
  // P5-89: the catalog goes through the shared cache, so arriving from a
  // browser paints from memory and the refreshed rows land in the callback.
  void fetchCatalog({ archived: true }, fresh => {
    entries.value = fresh
  })
    .then(rows => {
      entries.value = rows
    })
    .catch((err: unknown) => {
      error.value = friendlyError(err, 'The library did not load. Try again in a moment.')
    })
    .finally(() => {
      loading.value = false
    })

  void fetchKbConfig()
    .then(cfg => {
      config.value = cfg
    })
    .finally(() => {
      configLoading.value = false
    })

  void fetchRecentEdits()
    .then(rows => {
      edits.value = rows
    })
    .catch((err: unknown) => {
      editsError.value = friendlyError(err, 'Recent edits did not load. Try again in a moment.')
    })
    .finally(() => {
      editsLoading.value = false
    })

  // The report index is a small, separate store; no report is not an error.
  void fetchPlaceReports(50)
    .then(rows => {
      reportCount.value = rows.length
    })
    .catch(() => {
      reportCount.value = 0
    })
})

const counts = computed(() => kbCounts(entries.value))
const attention = computed(() => attentionItems(entries.value))

/** The one list: mine first and marked, then the last few by anyone. */
const recentEdits = computed<RecentEdit[]>(() =>
  recentlyEdited(edits.value, internalUser.value?.username ?? null),
)

/** Public county layers ship in the bundle, so the Datasets tile needs no
 *  extra request to count them. */
const publicLayerCount = publicLayers().length

/** The three tiles, each the whole of what its browser lists. */
const tiles = computed(() => [
  {
    id: 'datasets',
    to: '/datasets',
    label: 'Datasets',
    count: counts.value.datasets + counts.value.sources + publicLayerCount,
    sub: 'Tables we hold, sources we index, and the map’s layers',
  },
  {
    id: 'docs',
    to: '/docs',
    label: 'Docs',
    count: counts.value.pages + counts.value.documents + counts.value.notes,
    sub: 'Pages, documents and notes',
  },
  {
    id: 'analysis',
    to: '/analysis',
    label: 'Analysis',
    count: counts.value.views + reportCount.value,
    sub: 'The tools, and the saved views and recent place reports they made',
  },
])

/** Five of anything, by when it last changed. */
const mostRecent = computed(() => recentlyUpdated(entries.value, 5))

/** Zero is a fact; zero-because-we-have-not-loaded-yet is not. */
const countsReady = computed(() => !loading.value && !error.value)
function tally(value: number): string {
  return countsReady.value ? String(value) : '—'
}

/** An empty list after a failed request is not an empty library. Reindex is
 *  an admin button in the section below, so only an admin is told to press it
 *  (P5-73). */
const recentNote = computed(() => {
  if (error.value) return 'Nothing to show — the library did not load.'
  return isAdmin.value
    ? 'Nothing here yet. Add a page, drop a file, or push a dataset and press Reindex.'
    : 'Nothing here yet. Add a page or drop a file.'
})
</script>

<template>
  <div class="kb-view">
    <div class="kb-panel">
      <header class="kb-header">
        <h1>Library</h1>
        <p class="kb-lede">
          Everything the team holds, indexes or has written down.<span class="kbd-hint"> Searchable with <kbd>⌘K</kbd>.</span>
        </p>
      </header>
      <KbNav />

      <!-- What this library is for. Content, not code: it comes from
           library/kb.json, and is simply absent when nothing is configured. -->
      <InitiativePanel :initiative="config.initiative" :links="config.links" :loading="configLoading" />

      <!-- Seen once, by one person, and never again (P5-43). -->
      <FirstRunChecklist v-if="firstRunVisible" />

      <div class="kb-blocks" data-testid="kb-blocks">
        <!-- 1. Recently edited: yours first, then the team's. One list. -->
        <section class="block" data-testid="kb-recent-edited">
          <h2>Recently edited</h2>
          <p v-if="editsLoading" class="state-note">Loading…</p>
          <p v-else-if="editsError" class="state-note error">{{ editsError }}</p>
          <ul v-else-if="recentEdits.length" class="row-list" data-testid="kb-edits">
            <li v-for="row in recentEdits" :key="row.target.slug">
              <RouterLink :to="row.target.href" class="row-link">{{ row.target.title }}</RouterLink>
              <span class="row-meta">
                <span v-if="row.mine" class="yours" data-testid="kb-edit-yours">yours</span>
                <template v-else>{{ row.actor }}</template>
                · {{ relativeTime(row.at) }}
              </span>
            </li>
          </ul>
          <p v-else class="state-note">Nothing edited yet.</p>
        </section>

        <!-- 2. Pinned items: what the team decided is worth keeping at hand. -->
        <section v-if="config.pinned.length" class="block" data-testid="kb-pinned">
          <h2>Pinned</h2>
          <ul class="row-list" data-testid="kb-pinned-list">
            <li v-for="item in config.pinned" :key="item.slug">
              <RouterLink :to="item.href" class="row-link">{{ item.title }}</RouterLink>
              <span class="row-meta">{{ kindLabel(item.kind) }}<template v-if="item.category"> · {{ item.category }}</template></span>
            </li>
          </ul>
        </section>

        <!-- 3. The three resources, each number a way in. -->
        <section class="block" data-testid="kb-counts">
          <p v-if="error" class="state-note error">{{ error }}</p>
          <div class="tiles" data-testid="kb-tiles">
            <RouterLink v-for="tile in tiles" :key="tile.id" :to="tile.to" class="tile" :data-testid="`kb-tile-${tile.id}`">
              <span class="tile-count">{{ tally(tile.count) }}</span>
              <span class="tile-label">{{ tile.label }}</span>
              <span class="tile-sub">{{ tile.sub }}</span>
            </RouterLink>
          </div>
        </section>

        <!-- 4. The most recent items of any kind. -->
        <section class="block" data-testid="kb-recent-block">
          <h2>Most recent items</h2>
          <p v-if="loading" class="state-note">Loading…</p>
          <ul v-else-if="mostRecent.length" class="row-list" data-testid="kb-recent">
            <li v-for="e in mostRecent" :key="`${e.kind}:${e.slug}`">
              <RouterLink :to="entryHref(e)" class="row-link">{{ e.title }}</RouterLink>
              <span class="row-meta">{{ kindLabel(e.kind) }}<template v-if="e.category"> · {{ e.category }}</template><template v-if="e.updatedAt"> · {{ relativeTime(e.updatedAt) }}</template></span>
            </li>
          </ul>
          <p v-else class="state-note">{{ recentNote }}</p>
        </section>
      </div>

      <!-- 5. The admin's own view of the place, last and only for an admin. -->
      <section v-if="isAdmin" class="kb-admin" data-testid="kb-admin">
        <AttentionPanel :items="attention" :loading="loading" />
        <ActivityFeed />
      </section>

      <!-- P5-43: the way back to the manual, at the bottom of the front door
           where someone who has run out of ideas will be looking. -->
      <footer class="kb-foot">
        <button type="button" class="kb-help-link" data-testid="kb-help-link" @click="openHelpDrawer">
          How do I…?
        </button>
        <span class="kb-foot-hint">Short recipes for finding, asking, filtering, mapping and filing.<span class="kbd-hint"> Press <kbd>?</kbd> any time.</span></span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.kb-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
}

.kb-panel {
  width: 100%;
  max-width: 900px;
}

.kb-header h1 {
  margin: 0 0 4px;
  font-size: 28px;
  color: var(--blo-ink);
}

.kb-lede {
  margin: 0 0 16px;
  font-size: 14px;
  color: var(--blo-stone);
}

.kb-lede kbd {
  font-family: inherit;
  font-size: 12px;
  padding: 1px 5px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 4px;
}

/* One column, in the spec's order. The blocks are siblings rather than a grid
   so that the DOM order IS the reading order at every width. */
.kb-blocks {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
  margin-top: 20px;
}

.block {
  min-width: 0;
}

.block h2 {
  font-size: 16px;
  margin: 0 0 8px;
}

.row-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--blo-cream-deep);
}

.row-link {
  color: var(--blo-ink);
  font-weight: 600;
  text-decoration: none;
}

.row-link:hover {
  color: var(--blo-green-deep);
}

.row-meta {
  font-size: 12px;
  color: var(--blo-stone);
  white-space: nowrap;
}

/* "yours" is the only mark the list needs — the spec's one list, no second
   heading, no second column. */
.yours {
  font-weight: 700;
  color: var(--blo-green-deep);
}

/* Three tiles across, one per resource. */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 10px;
  text-decoration: none;
  color: var(--blo-ink);
}

.tile:hover {
  border-color: var(--blo-green-deep);
}

.tile-count {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
}

.tile-label {
  font-size: 15px;
  font-weight: 600;
}

.tile-sub {
  font-size: 12px;
  color: var(--blo-stone);
}

/* Across the foot, below everything a reader came for. */
.kb-admin {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  align-items: start;
  margin-top: 28px;
  padding-top: 20px;
  border-top: 1px solid var(--blo-cream-divider);
}

.kb-foot {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 28px;
  padding-top: 14px;
  border-top: 1px solid var(--blo-cream-divider);
}

.kb-help-link {
  padding: 0;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-green-deep);
  background: none;
  border: none;
  cursor: pointer;
}

.kb-help-link:hover {
  text-decoration: underline;
}

.kb-foot-hint {
  font-size: 12px;
  color: var(--blo-stone);
}

.kb-foot-hint kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 4px;
}

.state-note {
  font-size: 14px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b71c1c;
}

/* P5-60: a keyboard shortcut is a lie on a touch device. `hover: none` is the
   closest thing CSS has to "this person has no keyboard". */
@media (hover: none) {
  .kbd-hint {
    display: none;
  }
}

@media (max-width: 900px) {
  .kb-admin {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* P5-60 (mobile pass). The page must never be wider than the screen:
   `.kb-view` is a flex item of <main>, so its default `min-width: auto` is the
   min-content width of everything inside it — including the KbNav strip, which
   does not wrap. `min-width: 0` is what lets the strip scroll instead of the
   page growing; `max-width: 100%` caps every box in the chain. */
@media (max-width: 640px) {
  .kb-view {
    padding: 20px 12px 40px;
  }

  .kb-view,
  .kb-panel,
  .kb-header,
  .kb-blocks,
  .block,
  .kb-admin {
    min-width: 0;
    max-width: 100%;
  }

  /* P6-28: both keyboard hints go on a phone — "Searchable with ⌘K" on the
     hero and "Press ? any time" at the foot. There is no keyboard to press and
     no palette shortcut to reach, so each is an instruction the reader cannot
     follow. The ticket named only the first; the second is the same defect in
     the same sheet, so it goes with it.

     `display: none` rather than removing the markup: the hint is correct on a
     laptop, and the span staying in the sentence is what keeps it from taking
     a line of its own there (the rule this replaces). Nothing else is lost —
     the sentence before it stands on its own. */
  .kbd-hint {
    display: none;
  }

  /* Long titles break rather than push the list sideways. */
  .row-link,
  .tile-sub,
  .kb-lede {
    overflow-wrap: anywhere;
  }

  .kb-header h1 {
    font-size: clamp(22px, 7vw, 28px);
  }

  /* Three tiles stack, with a zero floor so nothing scrolls sideways at
     375 px. */
  .tiles {
    grid-template-columns: repeat(1, minmax(0, 1fr));
    gap: 8px;
  }

  .tile {
    min-width: 0;
    padding: 14px 12px;
  }

  .tile-count {
    font-size: 26px;
  }

  .tile-sub {
    font-size: 14px;
  }

  .row-list li {
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-height: 44px;
    padding: 6px 0;
  }

  .row-link,
  .row-meta,
  .kb-lede,
  .kb-foot-hint,
  .state-note {
    font-size: 14px;
  }

  .row-meta {
    white-space: normal;
  }

  .kb-help-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
}
</style>
