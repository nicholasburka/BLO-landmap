<template>
  <aside class="map-pane" :data-testid="testid" :aria-label="label">
    <header class="pane-head">
      <div class="pane-names">
        <h2 class="pane-title" :data-testid="`${testid}-layer`">{{ title || layers.activeName.value }}</h2>
        <p v-if="note" class="pane-note" :data-testid="`${testid}-note`">{{ note }}</p>
      </div>
      <button
        type="button"
        class="pane-close"
        :data-testid="`${testid}-close`"
        :aria-label="closeLabel"
        @click="emit('close')"
      >✕</button>
    </header>
    <div class="pane-map">
      <MapCanvas
        :layers="layers"
        :query="query"
        :data="data"
        :fit="fit"
        :focus-geo-id="focusGeoId"
        @ready="emit('ready', $event)"
        @county-click="emit('county-click', $event)"
        @counties-ready="emit('counties-ready')"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
/**
 * A map beside the page that asked for it (P6-14).
 *
 * The chrome around `MapCanvas`: a header naming what the map is showing, a
 * Close, and the box that gives mapbox-gl a definite height. Nothing else —
 * no state, no breakpoint, no open/close. The host owns whether this is
 * mounted (`v-if`, never `v-show`), which is what keeps a reader who never
 * opens a pane from downloading a county file; `useMapPane` is that switch.
 *
 * Lifted out of `ChatView`, which held all of this inline, so the three
 * "Show on map" call sites get a pane in one element instead of a copy of the
 * chat page's markup each.
 *
 * `MapCanvas` is loaded on demand from in here rather than by every host: it
 * pulls in mapbox-gl and, on mount, the page's two county files (1.07 MB
 * gzipped). A host can therefore import this component normally — it costs
 * its own markup and nothing more until it renders.
 */
import { defineAsyncComponent } from 'vue'
import type { MapLayerState, MapQueryState, MapDataStore } from '@/composables/useMapState'
import type { MapFitRequest } from '@/components/MapCanvas.vue'
import type { ToolContext } from '@/lib/mapTools'

const MapCanvas = defineAsyncComponent(() => import('@/components/MapCanvas.vue'))

const props = withDefaults(
  defineProps<{
    /** Which layers are on. From `useMapState()` — the same object for the
     *  life of the pane, which an inline literal would not be. */
    layers: MapLayerState
    /** What is ranked, filtered and framed. From `useMapState()`. */
    query: MapQueryState
    /** The host page's county data store, so one page is one download. */
    data?: MapDataStore
    /** Frame this. A page's own filtered rows, or a point layer's extent. */
    fit?: MapFitRequest | null
    /** Zoom to one county — a place, a single row. */
    focusGeoId?: string | null
    /** Header text. Defaults to the name of the layer being drawn. */
    title?: string
    /** A second line saying what the map is framed on ("18 of 3,142
     *  counties"), when the subset is the point of opening it. */
    note?: string
    /** `data-testid` of the pane; the title and the Close derive theirs from
     *  it (`<testid>-layer`, `<testid>-close`, `<testid>-note`). */
    testid?: string
    /** The landmark's accessible name. */
    label?: string
    closeLabel?: string
  }>(),
  {
    data: undefined,
    fit: null,
    focusGeoId: null,
    title: '',
    note: '',
    testid: 'map-pane',
    label: 'Map',
    closeLabel: 'Close the map',
  },
)

const emit = defineEmits<{
  /** The X was pressed. The host closes the pane; this component does not
   *  decide its own existence. */
  (e: 'close'): void
  /** The canvas has a map, and this is what drives it. */
  (e: 'ready', ctx: ToolContext): void
  (e: 'county-click', geoId: string): void
  (e: 'counties-ready'): void
}>()
</script>

<style scoped>
/* A column: the header takes what it needs and the map takes the rest, which
   is what gives mapbox-gl a definite height. The host decides how wide. */
.map-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
}

.pane-names {
  min-width: 0;
}

.pane-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pane-note {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.pane-close {
  flex: 0 0 auto;
  padding: 2px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--blo-ink-soft, #5c564e);
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  cursor: pointer;
}

.pane-close:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-ink-soft, #5c564e);
}

.pane-map {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}
</style>
