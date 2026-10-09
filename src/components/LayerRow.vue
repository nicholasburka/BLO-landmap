<template>
  <!--
    P9-2b: one layer's row in a picker — checkbox, label, optional tooltip,
    and whatever the host puts beside it.

    `LayerControls` hand-wrote this block twelve times; six of those were
    byte-identical once the array, the selection and the emit name were
    normalised away. The scoring controls were already their own component
    (`LayerScoringControls`); the shell around them was not.

    DELIBERATELY UNSTYLED. The root element is `.layer-item`, and Vue applies
    a parent's scoped styles to a child's ROOT node — so the host's existing
    `.layer-item` rules keep reaching this without anything being copied or
    kept in sync. Inner nodes (the label, the tooltip) need `:deep()` in the
    host, which is the one cost of the move and is marked there.
  -->
  <div class="layer-item">
    <input type="checkbox" :id="layer.id" :checked="checked" @change="$emit('toggle', layer.id)" />
    <label :for="layer.id">{{ layer.name }}</label>
    <span v-if="layer.tooltip" class="tooltip-wrapper">
      <button
        type="button"
        class="tooltip-icon"
        :aria-label="'Info about ' + layer.name"
        :aria-describedby="'tooltip-' + layer.id"
      >ⓘ</button>
      <span class="tooltip-popup" :id="'tooltip-' + layer.id" role="tooltip" v-html="layer.tooltip"></span>
    </span>
    <!-- weights, filters, load state, links — whatever this picker adds. -->
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** Enough of a layer to draw a row: everything else comes through the slot. */
  layer: { id: string; name: string; tooltip?: string }
  checked: boolean
}>()

defineEmits<{ toggle: [layerId: string] }>()
</script>
