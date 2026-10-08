<template>
  <!-- P9-2: the public map's layer-by-layer display and toggling, scoped to
       one working set. Reuses the STATE and the toggle semantics rather than
       `LayerControls`' markup, which carries the public categories, weights,
       filters and contamination along with it. -->
  <ul class="set-layers" data-testid="set-layer-list">
    <li v-for="row in rows" :key="row.id" class="set-layer" data-testid="set-layer">
      <label v-if="row.known" class="set-layer-label">
        <input type="checkbox" :checked="row.on" @change="toggle(row)" />
        <span
          class="set-layer-swatch"
          data-testid="set-layer-swatch"
          :style="{ background: row.color }"
        />
        <span class="set-layer-name">{{ row.name }}</span>
        <span class="set-layer-shape">{{ row.geometry }}</span>
      </label>
      <span v-else class="set-layer-missing" data-testid="set-layer-missing">
        {{ row.id }} — not in the library any more
      </span>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MapLayerState } from '@/composables/useMapState'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

const props = defineProps<{
  /** The same `MapLayerState` the canvas draws from — one source of truth. */
  layers: MapLayerState
  /** The layer ids the SET names, in the order it names them. */
  ids: string[]
}>()

/** The default swatch for a layer whose manifest declares no colour. */
const FALLBACK = '#6b7280'

/**
 * The public categories a map holds a selection for.
 *
 * A registry layer in some other category — `composite`, `environment`,
 * `health` — has no slot in `MapLayerState` and so nothing this list could
 * toggle, which is the one case where naming it as a row would be a lie.
 */
const PUBLIC_CATEGORIES = ['demographic', 'economic', 'housing', 'equity', 'transportation'] as const

type PublicCategory = (typeof PUBLIC_CATEGORIES)[number]

interface Row {
  id: string
  known: boolean
  name: string
  geometry: string
  color: string
  on: boolean
  county: boolean
  /** A public registry layer's category, which is how it is toggled. */
  category: PublicCategory | null
}

const rows = computed<Row[]>(() =>
  props.ids.map(id => {
    const feature = props.layers.pointDefinitions.value.find(l => l.id === id)
    if (feature) {
      return {
        id,
        known: true,
        name: feature.name,
        geometry: feature.geometry,
        color: feature.color ?? FALLBACK,
        on: props.layers.points.value.includes(id),
        county: false,
        category: null,
      }
    }
    const county = props.layers.internalDefinitions.value.find(l => l.id === id)
    if (county) {
      return {
        id,
        known: true,
        name: county.name,
        geometry: 'county',
        color: FALLBACK,
        on: props.layers.internal.value.includes(id),
        county: true,
        category: null,
      }
    }
    // A set may name a PUBLIC layer — `indexableLayersOf` offers them as index
    // terms, so a set can hold one and a formula can weigh one. They are not
    // in the internal manifest and were reading as lost, which is a county
    // choropleth the national map draws every day being called missing.
    const def = LAYER_REGISTRY[id]
    const category = PUBLIC_CATEGORIES.find(name => name === def?.category)
    if (def && category) {
      return {
        id,
        known: true,
        name: def.name,
        geometry: 'county',
        color: FALLBACK,
        on: props.layers[category].value.includes(id),
        county: false,
        category,
      }
    }
    // A set may name something the library has since lost. P6-23: a count may
    // not disagree with the list it opens, so say so rather than drop a row.
    return { id, known: false, name: id, geometry: '', color: FALLBACK, on: false, county: false, category: null }
  }),
)

/** The same toggles the public map calls — a county layer scores, a feature
 *  layer draws, and the two go down different paths in the state. */
function toggle(row: Row): void {
  if (row.category) props.layers.toggle[row.category](row.id)
  else if (row.county) props.layers.toggle.internal(row.id)
  else props.layers.toggle.points(row.id)
}
</script>

<style scoped>
.set-layers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.2rem;
}
.set-layer-label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.86rem;
}
.set-layer-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: none;
  border: 1px solid rgba(0, 0, 0, 0.15);
}
.set-layer-name {
  overflow-wrap: anywhere;
}
.set-layer-shape {
  font-size: 0.74rem;
  color: #6b7280;
}
.set-layer-missing {
  font-size: 0.82rem;
  color: #92400e;
  overflow-wrap: anywhere;
}
</style>
