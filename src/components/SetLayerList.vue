<template>
  <!-- P9-2: the public map's layer-by-layer display and toggling, scoped to
       one working set. Reuses the STATE and the toggle semantics rather than
       `LayerControls`' markup, which carries the public categories, weights,
       filters and contamination along with it. -->
  <div class="set-layers-panel blo-panel blo-panel--reference" data-testid="set-layer-list-panel">
    <p class="set-layers-head">{{ heading }}</p>
    <ul class="set-layers" data-testid="set-layer-list">
    <li v-for="row in rows" :key="row.id" class="set-layer" data-testid="set-layer">
      <label v-if="row.known" class="set-layer-label" :class="{ fixed: readonly || row.fixed }">
        <!-- P9-6a: no checkbox while a formula is being previewed. Unchecking a
             term drops it from the scoring query while its slider still shows a
             weight, so the sliders would lie about what the map is. A term is
             taken out of a formula by dragging it to zero, which the editor
             labels "out" — one control per decision. -->
        <input v-if="!readonly && !row.fixed" type="checkbox" :checked="row.on" @change="toggle(row)" />
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { MapLayerState } from '@/composables/useMapState'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import {
  DEMOGRAPHIC_LAYERS,
  ECONOMIC_LAYERS,
  HOUSING_LAYERS,
  EQUITY_LAYERS,
  TRANSPORTATION_LAYERS,
} from '@/config/layerConfig'

const props = defineProps<{
  /** The same `MapLayerState` the canvas draws from — one source of truth. */
  layers: MapLayerState
  /** The layer ids the SET names, in the order it names them. */
  ids: string[]
  /**
   * Name the layers without offering to toggle them (P9-6a).
   *
   * For when something else already owns "is this layer in" — the weight
   * editor, whose sliders say so — and two controls for one decision would let
   * the list and the sliders disagree about the same map.
   */
  readonly?: boolean
}>()

/** The default swatch for a layer whose manifest declares no colour. */
const FALLBACK = '#6b7280'

/** What this panel is, in two words. It floats over the canvas now, so it
 *  cannot rely on the thing above it to say what it is. */
const heading = 'On this map'

type PublicCategory = 'demographic' | 'economic' | 'housing' | 'equity' | 'transportation'

/**
 * Which selection array each public layer actually lives in.
 *
 * Built from the CONFIG ARRAYS, not from the registry's `category` field,
 * because the two disagree and only this one decides anything: `applyQueryState`
 * routes a layer by searching these same arrays. `life_expectancy` is filed
 * `health` in the registry and sits in `DEMOGRAPHIC_LAYERS`, so trusting the
 * registry said "nothing here can toggle it" about a layer this map toggles
 * fine — measured: dragging its weight from 10 to 1 repainted 17% of the
 * canvas.
 *
 * A registry layer in no array at all is real and named, just not something
 * this list can switch — which is different again from one the library has
 * lost, and must not read the same.
 */
const CATEGORY_OF = new Map<string, PublicCategory>([
  ...DEMOGRAPHIC_LAYERS.map(l => [l.id, 'demographic'] as const),
  ...ECONOMIC_LAYERS.map(l => [l.id, 'economic'] as const),
  ...HOUSING_LAYERS.map(l => [l.id, 'housing'] as const),
  ...EQUITY_LAYERS.map(l => [l.id, 'equity'] as const),
  ...TRANSPORTATION_LAYERS.map(l => [l.id, 'transportation'] as const),
])

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
  /** Real, named, and nothing here can turn it on or off. */
  fixed?: boolean
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
    if (def) {
      const category = CATEGORY_OF.get(id)
      return {
        id,
        known: true,
        name: def.name,
        geometry: 'county',
        color: FALLBACK,
        // The contamination choropleth is one boolean rather than a list, so
        // it is still toggleable — just not through a category array.
        on: category
          ? props.layers[category].value.includes(id)
          : id === 'contamination'
            ? props.layers.contaminationChoropleth.value
            : false,
        county: false,
        category: category ?? null,
        fixed: !category && id !== 'contamination',
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
  else if (row.id === 'contamination') props.layers.toggle.contaminationChoropleth()
  else if (row.county) props.layers.toggle.internal(row.id)
  else props.layers.toggle.points(row.id)
}
</script>

<style scoped>
/* P9-10: over the canvas, in the tier the public map's Lens wears. The list
   itself is unchanged — what moved is where it sits, because a control for
   the map belongs ON the map and not below the fold under it. */
.set-layers-panel {
  padding: 8px 10px;
}

.set-layers-head {
  margin: 0 0 5px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}

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
/* Nothing to press, so nothing that looks pressable. */
.set-layer-label.fixed {
  cursor: default;
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
