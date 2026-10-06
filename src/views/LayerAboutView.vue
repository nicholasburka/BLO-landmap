<script setup lang="ts">
/**
 * About one public map layer (P5-45): what it measures, where it came from,
 * and its numbers county by county — the same shape an internal dataset gets
 * from its library entry.
 *
 * Internal layers are NOT rendered here. They already have a hub page with
 * About / Data / Map tabs, so `/layers/internal-<slug>` bounces there; this
 * page would only be a worse copy.
 *
 * The county data is loaded when the page opens and only for THIS layer —
 * the map's `loadAllCountyData()` would pull every CSV in the registry.
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import AskBox from '@/components/AskBox.vue'
import CountyTable from '@/components/CountyTable.vue'
import MapPane from '@/components/MapPane.vue'
import { useShowOnMap } from '@/composables/useShowOnMap'
import { mapUrlForLayers, INTERNAL_PREFIX } from '@/lib/mapDeepLinks'
import { friendlyError } from '@/lib/errors'
import {
  CATEGORY_LABELS,
  askQuestionFor,
  dataTypeLabel,
  directionLabel,
  getPublicLayer,
  layerAboutHref,
  loadCountyRows,
  publisherLine,
  rangeLine,
  type CountyValueRow,
} from '@/lib/publicLayers'
import { coversLabel, fetchedLabel, layerDatesOf, publishedLabel } from '@/lib/dataDates'

const route = useRoute()
const router = useRouter()

const layerId = computed(() => String(route.params.id ?? ''))
const layer = computed(() => getPublicLayer(layerId.value))
/** On the way to the library entry — say so rather than flashing "no such layer". */
const isInternal = computed(() => layerId.value.startsWith(INTERNAL_PREFIX))

/**
 * P7-10: when this layer's data is from, as the facts it actually has.
 *
 * The legend has room for one line and picks the most informative; this page
 * has a definition list, so all three are named and nothing is conflated. Read
 * through `layerDatesOf`, the one reader, so the page and the legend cannot
 * disagree about the same layer.
 */
const whenFacts = computed<string[]>(() => {
  if (!layer.value) return []
  const dates = layerDatesOf(layer.value)
  return [coversLabel(dates.covers), publishedLabel(dates.published), fetchedLabel(dates.fetched)].filter(Boolean)
})

const rows = ref<CountyValueRow[]>([])
const loadingRows = ref(true)
const rowsError = ref('')

// --- Show on map, in place (P6-14) ------------------------------------------
// This used to be a link to `/?layers=<id>`, which drew the whole layer and
// took the page with it. The pane draws what the table is showing: search the
// county list for "Mississippi" and the map is Mississippi, outlined and
// framed, with the rest of the country dimmed behind it.

/** The GEOIDs `CountyTable` is showing, reported by the table itself. */
const shownGeoIds = ref<string[]>([])

/**
 * The subset the map should draw as the answer — **null while the table is
 * showing everything**, which is a layer page's resting state.
 *
 * "Every county this layer has a number for" is not a subset, it is the
 * layer; saying it in `only` would frame the union of all 3,124 counties,
 * and that union contains Guam and American Samoa, so the map would open on
 * the globe. Unsearched, this page means what the old link meant: the whole
 * layer, in the default view. Search it and the subset becomes real.
 */
const shownSubset = computed<string[] | null>(() => {
  const shown = shownGeoIds.value
  if (!shown.length || shown.length >= rows.value.length) return null
  return shown
})

const map = useShowOnMap({
  layers: () => (layer.value ? [layer.value.id] : []),
  only: () => shownSubset.value,
})

/** Said under the pane's title only when the table has in fact narrowed. */
const paneNote = computed(() => {
  const subset = shownSubset.value
  if (!subset) return ''
  return `${subset.length.toLocaleString()} of ${rows.value.length.toLocaleString()} counties`
})

watch(
  layerId,
  id => {
    if (id.startsWith(INTERNAL_PREFIX)) {
      void router.replace(layerAboutHref(id))
      return
    }
    const definition = getPublicLayer(id)
    rows.value = []
    rowsError.value = ''
    if (!definition) {
      loadingRows.value = false
      return
    }
    loadingRows.value = true
    void loadCountyRows(definition)
      .then(loaded => {
        rows.value = loaded
      })
      .catch((err: unknown) => {
        rowsError.value = friendlyError(err, 'The county data did not load. Try again in a moment.')
      })
      .finally(() => {
        loadingRows.value = false
      })
  },
  { immediate: true },
)
</script>

<template>
  <div class="layer-view">
    <div class="layer-panel">
      <KbNav />
      <RouterLink to="/datasets?readiness=layers" class="back-link touch-target">← All map layers</RouterLink>

      <p v-if="isInternal" class="state-note">Opening this layer's library entry…</p>

      <p v-else-if="!layer" class="state-note" data-testid="layer-missing">
        There is no map layer called “{{ layerId }}”.
        <RouterLink to="/datasets?readiness=layers">See every layer →</RouterLink>
      </p>

      <template v-else>
        <header class="layer-header">
          <span class="category" data-testid="layer-category">{{ CATEGORY_LABELS[layer.category] }}</span>
          <h1 data-testid="layer-name">{{ layer.name }}</h1>
          <p class="description">{{ layer.description }}</p>
          <div class="actions">
            <!-- Wide enough for a map beside the page: open one here rather
                 than navigating to `/` and losing the page (P6-14). Narrower
                 than that, the deep link stands — it is still how a view is
                 shared, and a new tab is still how you get the whole map. -->
            <button
              v-if="map.canOpen.value"
              type="button"
              class="primary-action touch-target"
              data-testid="layer-map-open"
              :aria-expanded="map.isOpen.value"
              @click="map.toggle()"
            >Show on map</button>
            <RouterLink
              v-else
              :to="mapUrlForLayers([layer.id])"
              class="primary-action touch-target"
              data-testid="layer-map-link"
            >Show on map</RouterLink>
          </div>
        </header>

        <dl class="facts" data-testid="layer-facts">
          <div class="fact">
            <dt>What the numbers are</dt>
            <dd>{{ dataTypeLabel(layer.dataType) }}<template v-if="layer.unit"> ({{ layer.unit }})</template></dd>
          </div>
          <div class="fact">
            <dt>Which way is good</dt>
            <dd>{{ directionLabel(layer.direction) }}</dd>
          </div>
          <div class="fact">
            <dt>Values run from</dt>
            <dd>{{ rangeLine(layer) }}</dd>
          </div>
          <!-- P7-10: all three dates, spelled out — this is the surface with
               room for the distinction the legend has to compress into one
               line. `covers` is the period the DATA describes, `published` is
               when the publisher put it out, `fetched` is when we pulled it. A
               layer that says nothing shows nothing. -->
          <div v-if="whenFacts.length" class="fact" data-testid="layer-dates">
            <dt>When it is from</dt>
            <dd>
              <template v-for="(fact, i) in whenFacts" :key="fact">{{ i ? ' · ' : '' }}{{ fact }}</template>
            </dd>
          </div>
          <div class="fact">
            <dt>Where it comes from</dt>
            <dd data-testid="layer-source">
              <a v-if="layer.sourceUrl && layer.source" :href="layer.sourceUrl" target="_blank" rel="noopener noreferrer">
                {{ publisherLine(layer) }}
              </a>
              <template v-else>{{ publisherLine(layer) }}</template>
            </dd>
          </div>
        </dl>

        <section class="ask-section">
          <h2>Ask about this layer</h2>
          <AskBox :model-value="askQuestionFor(layer)" label="Ask about this layer" placeholder="Ask about this layer…" />
        </section>

        <section class="table-section">
          <h2>County by county</h2>
          <p class="section-note">Every county this layer has a number for. Search, sort, and download what you see.</p>
          <CountyTable
            :layer="layer"
            :rows="rows"
            :loading="loadingRows"
            :error="rowsError"
            @shown="shownGeoIds = $event"
          />
        </section>
      </template>
    </div>

    <!-- The submap (P6-14). A sibling of the content, not a replacement for
         it: the route never changes and closing it leaves the page as it
         was. -->
    <MapPane
      v-if="map.isOpen.value"
      class="layer-map-pane"
      testid="layer-map-pane"
      :layers="map.state.layers"
      :query="map.state.query"
      :data="map.state.data"
      :fit="map.fit.value"
      :note="paneNote"
      label="This layer on the map"
      @close="map.close()"
    />
  </div>
</template>

<style scoped>
.layer-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  gap: 20px;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
  /* P5-60, the page-overflow fix. App.vue lays the shell out with
     `display: flex` on `main`, so this route root is a flex item, and a flex
     item's automatic minimum size is its content's min-content width — the
     widest table on the page. Without this the whole document scrolls
     sideways however well the table's own wrapper clips. */
  min-width: 0;
}

.layer-panel {
  width: 100%;
  max-width: 1000px;
  /* Beside the pane this is the item that gives way: the table already
     scrolls inside its own wrapper, and the map has a fixed width. */
  min-width: 0;
}

/* The submap (P6-14). A column of its own; `MapPane` lays out the header and
   the map inside it. Not sticky: these route roots are viewport-height flex
   items of App.vue's `main`, so a sticky child's containing block is only one
   screen tall and would scroll away with it anyway. */
.layer-map-pane {
  flex: 0 0 26rem;
  align-self: flex-start;
  height: calc(100vh - 140px);
  min-height: 24rem;
}

/* Below the pane's breakpoint there is no pane: `useMapPane` will not open
   one and closes any that is open, and this is the belt to that braces. */
@media (max-width: 1023px) {
  .layer-map-pane {
    display: none;
  }
}

.back-link {
  display: inline-block;
  margin-bottom: 14px;
  font-size: 13px;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

.state-note {
  font-size: 15px;
  color: var(--blo-stone);
}

.state-note a {
  color: var(--blo-green-deep);
}

.category {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft);
}

.layer-header h1 {
  margin: 2px 0 6px;
  font-size: 28px;
  color: var(--blo-ink);
}

.description {
  margin: 0 0 12px;
  font-size: 15px;
  color: var(--blo-ink-soft);
  max-width: 62ch;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.primary-action {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--blo-green-deep);
  border-radius: 8px;
  text-decoration: none;
}

.primary-action:hover {
  background: var(--blo-green);
}

.facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;
  margin: 20px 0 0;
}

.fact {
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.fact dt {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone-soft);
}

.fact dd {
  margin: 4px 0 0;
  font-size: 14px;
  color: var(--blo-ink);
}

.fact dd a {
  color: var(--blo-green-deep);
}

.ask-section,
.table-section {
  margin-top: 26px;
}

.ask-section h2,
.table-section h2 {
  margin: 0 0 6px;
  font-size: 16px;
  color: var(--blo-ink);
}

.section-note {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--blo-stone);
}

/* --- Phone (P5-60) ---------------------------------------------------------
   The four fact cards go two-up rather than one long column — they are short
   enough to read side by side and it keeps the table above the fold. The
   heading scales instead of being cut off. */
@media (max-width: 640px) {
  .layer-view {
    padding: 20px 12px 40px;
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .category {
    font-size: 13px;
  }

  .layer-header h1 {
    font-size: clamp(22px, 7vw, 28px);
    overflow-wrap: anywhere;
  }

  .description,
  .state-note,
  .section-note {
    font-size: 14px;
  }

  .primary-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font-size: 15px;
  }

  .facts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .fact {
    padding: 10px 12px;
  }

  .fact dt {
    font-size: 13px;
    letter-spacing: 0.04em;
  }

  .fact dd {
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .ask-section h2,
  .table-section h2 {
    font-size: 17px;
  }
}
</style>
