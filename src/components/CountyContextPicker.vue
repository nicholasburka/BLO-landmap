<script setup lang="ts">
/**
 * Pick the county layers to add to a table (P5-48).
 *
 * The same list, in the same categories, as /layers — a researcher who has
 * read a layer's about page should find it here under the same heading. Only
 * layers with county numbers behind them appear; picking one adds a column to
 * the table for the rows on screen.
 */
import { computed, ref } from 'vue'
import {
  MAX_CONTEXT_LAYERS,
  contextLayerGroups,
  contextLayers,
} from '@/lib/countyJoin'
import { sourceLine } from '@/lib/publicLayers'

const props = defineProps<{ selected: string[] }>()
const emit = defineEmits<{
  (e: 'update:selected', ids: string[]): void
  (e: 'close'): void
}>()

const query = ref('')
const groups = computed(() => contextLayerGroups(query.value))
const matches = computed(() => groups.value.reduce((n, g) => n + g.layers.length, 0))
const total = computed(() => contextLayers().length)

/** Each column is another dataset to download, so the picker stops adding
 *  rather than letting a table quietly pull the whole map. */
const atLimit = computed(() => props.selected.length >= MAX_CONTEXT_LAYERS)

function isOn(id: string): boolean {
  return props.selected.includes(id)
}

function toggle(id: string): void {
  if (isOn(id)) emit('update:selected', props.selected.filter(s => s !== id))
  else if (!atLimit.value) emit('update:selected', [...props.selected, id])
}
</script>

<template>
  <!-- A card inside the toolbar on a wide screen; a bottom sheet on a phone
       (P5-60) — hence the handle, which only shows under 640 px. -->
  <div class="context-picker sheet" data-testid="county-context-picker">
    <span class="sheet-handle" aria-hidden="true"></span>
    <header class="picker-head">
      <h3>Add county context</h3>
      <button type="button" class="close-btn touch-target" aria-label="Close county context" @click="emit('close')">×</button>
    </header>
    <p class="picker-hint">
      Public map layers, joined to each row by its county. Values are added for the rows on this page.
    </p>

    <input
      v-model="query"
      type="search"
      class="picker-search"
      placeholder="Search layers by name or what they measure…"
      aria-label="Search county layers"
      data-testid="context-search"
    />

    <p v-if="atLimit" class="picker-note" data-testid="context-limit">
      That is {{ MAX_CONTEXT_LAYERS }} layers — remove one to add another.
    </p>
    <p v-else-if="matches === 0" class="picker-note" data-testid="context-empty">
      No layer matches “{{ query.trim() }}”.
    </p>

    <section v-for="group in groups" :key="group.category" class="context-group">
      <h4 class="group-name" data-testid="context-group">{{ group.label }}</h4>
      <label v-for="layer in group.layers" :key="layer.id" class="context-row" data-testid="context-layer">
        <input
          type="checkbox"
          :checked="isOn(layer.id)"
          :disabled="atLimit && !isOn(layer.id)"
          :aria-label="layer.name"
          @change="toggle(layer.id)"
        />
        <span class="context-body">
          <span class="context-name">{{ layer.name }}</span>
          <span class="context-desc">{{ layer.description }}</span>
          <span class="context-source">{{ sourceLine(layer) }}</span>
        </span>
      </label>
    </section>

    <footer class="picker-foot">
      <span data-testid="context-count">{{ props.selected.length }} of {{ total }} added</span>
      <button
        v-if="props.selected.length"
        type="button"
        class="clear-btn touch-target"
        data-testid="context-clear"
        @click="emit('update:selected', [])"
      >
        Remove all
      </button>
    </footer>
  </div>
</template>

<style scoped>
.context-picker {
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 10px;
}

.picker-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.picker-head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--blo-ink, #111);
}

.close-btn {
  padding: 0 4px;
  font: inherit;
  font-size: 18px;
  line-height: 1;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: 0;
  cursor: pointer;
}

.picker-hint,
.picker-note {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--blo-stone, #6b6560);
}

.picker-search {
  width: 100%;
  margin-top: 10px;
  padding: 6px 10px;
  font: inherit;
  font-size: 14px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.context-group {
  margin-top: 12px;
}

.group-name {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.context-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 0;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
  cursor: pointer;
}

.context-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.context-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
}

.context-desc,
.context-source {
  font-size: 12px;
  line-height: 1.4;
  color: var(--blo-stone, #6b6560);
}

.context-source {
  color: var(--blo-stone-soft, #9a948e);
}

.picker-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 8px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.clear-btn {
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  background: none;
  border: 0;
  cursor: pointer;
}

/* Hidden until the sheet exists. */
.sheet-handle {
  display: none;
}

/* --- Phone (P5-60): a full-width bottom sheet -------------------------------
   The picker is a long checklist; as a popover inside a 375 px toolbar it was
   unreadable and its rows were 20 px tall. Down here it takes the bottom of
   the screen, its rows are 44 px, and its checkboxes are 20 px with the whole
   row as their hit area (the row is the <label>). */
@media (max-width: 640px) {
  .sheet {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    max-height: 85svh;
    overflow-y: auto;
    border: none;
    border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.16);
    padding: 8px 16px calc(16px + env(safe-area-inset-bottom, 0px));
  }

  .sheet-handle {
    display: block;
    width: 36px;
    height: 4px;
    margin: 0 auto 10px;
    border-radius: 2px;
    background: var(--blo-cream-divider, #e0d9ca);
  }

  .picker-head h3 {
    font-size: 17px;
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    font-size: 24px;
  }

  .picker-hint,
  .picker-note,
  .picker-foot,
  .context-desc,
  .context-source {
    font-size: 14px;
  }

  .picker-search {
    min-height: 44px;
    font-size: 16px;
  }

  .group-name {
    font-size: 13px;
  }

  .context-row {
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 8px 0;
  }

  .context-row input[type='checkbox'] {
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
  }

  .context-name {
    font-size: 15px;
  }

  .clear-btn {
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
