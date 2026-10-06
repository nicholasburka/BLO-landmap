<script setup lang="ts">
/**
 * Entity rail (P5-28): the list side of internal point layers. Lives in the
 * county rail's slot whenever a point layer is on and no county is being
 * inspected. Lists every entity of the active point layers (sorted by
 * label), searches across the label + popup fields, and syncs both ways
 * with the map: a row click flies to the point and opens its popup, a
 * marker click highlights (and scrolls to) the row.
 */
import { ref, computed, watch, nextTick } from 'vue'
import { ENTITY_ROWS_MAX, type EntityRailLayer, type EntityRef } from '@/lib/entityRail'

const props = defineProps<{
  visible: boolean
  layers: EntityRailLayer[]
  active: EntityRef | null
  /** True while a toggled layer's features are still downloading. */
  loading?: boolean
}>()

/** Mobile: the rail is a bottom sheet; tapping the header collapses it to a strip. */
const collapsed = ref(false)

const emit = defineEmits<{
  (e: 'select', ref: EntityRef): void
  (e: 'dismiss'): void
}>()

const DEFAULT_COLOR = '#ff6b1c'

const query = ref('')
const listEl = ref<HTMLElement | null>(null)

interface Row {
  key: string
  layerId: string
  index: number
  label: string
  subtitle: string
  color: string
  haystack: string
}

const allRows = computed<Row[]>(() => {
  const rows: Row[] = []
  for (const layer of props.layers) {
    const color = layer.color || DEFAULT_COLOR
    layer.features.forEach((feature, index) => {
      const p = feature.properties ?? {}
      const label = String(p._label ?? '').trim() || `${layer.name} #${index + 1}`
      const values = layer.popupFields.map(f => String(p[f] ?? '').trim()).filter(Boolean)
      rows.push({
        key: `${layer.id}:${index}`,
        layerId: layer.id,
        index,
        label,
        subtitle: values.slice(0, 2).join(' · '),
        color,
        haystack: [label, ...values].join(' ').toLowerCase(),
      })
    })
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
})

const matching = computed<Row[]>(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return allRows.value
  return allRows.value.filter(r => r.haystack.includes(q))
})

const shown = computed(() => matching.value.slice(0, ENTITY_ROWS_MAX))
const total = computed(() => allRows.value.length)
const multiLayer = computed(() => props.layers.length > 1)

/** What the rail is listing, in the plainest word that is true of all of it:
 *  "point"/"line"/"state" when every layer is one, "overlay" for a mixed set
 *  (P7-3, states in P7-9). */
const kind = computed(() => {
  const kinds = new Set(props.layers.map(l => l.geometry))
  return kinds.size === 1 ? [...kinds][0] : 'overlay'
})

const title = computed(() => (props.layers.length === 1 ? props.layers[0].name : `${props.layers.length} ${kind.value} layers`))
const eyebrow = computed(() =>
  kind.value === 'line' ? 'Lines' : kind.value === 'point' ? 'Points' : kind.value === 'state' ? 'States' : 'Overlays',
)

function isActive(row: Row): boolean {
  return !!props.active && props.active.layerId === row.layerId && props.active.index === row.index
}

function select(row: Row): void {
  emit('select', { layerId: row.layerId, index: row.index })
}

// Marker click → highlight + scroll the row into view (after the list renders).
watch(
  () => props.active,
  async active => {
    if (!active || !props.visible) return
    await nextTick()
    const el = listEl.value?.querySelector<HTMLElement>(`[data-key="${active.layerId}:${active.index}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  },
)

// A new layer set resets the search.
watch(
  () => props.layers.map(l => l.id).join('|'),
  () => {
    query.value = ''
  },
)
</script>

<template>
  <aside
    v-if="visible"
    class="entity-rail blo-panel blo-panel--primary"
    :class="{ 'entity-rail--collapsed': collapsed }"
    role="complementary"
    aria-label="Overlay layer entities"
    data-testid="entity-rail"
    @click.stop
  >
    <button type="button" class="rail-handle touch-target" :aria-expanded="!collapsed" aria-label="Collapse or expand the entity list" @click="collapsed = !collapsed"><span aria-hidden="true"></span></button>
    <header class="rail-header">
      <div class="rail-title-block">
        <span class="rail-eyebrow">{{ eyebrow }}</span>
        <h2 class="rail-title">{{ title }}</h2>
        <span v-if="layers.length === 1" class="rail-links" data-testid="entity-rail-links">
          <RouterLink :to="`/library/${layers[0].slug}`">About</RouterLink>
          ·
          <RouterLink :to="`/library/${layers[0].slug}?tab=data`">Data</RouterLink>
        </span>
      </div>
      <button type="button" class="rail-exit touch-target" aria-label="Hide the entity list" @click="emit('dismiss')">×</button>
    </header>

    <input
      v-model="query"
      type="search"
      class="rail-search"
      placeholder="Search entities…"
      aria-label="Search entities"
    />

    <p v-if="props.loading && total === 0" class="rail-count rail-loading" data-testid="entity-loading">Loading entities…</p>
    <p class="rail-count" data-testid="entity-count">
      <template v-if="query.trim()">{{ matching.length.toLocaleString() }} of {{ total.toLocaleString() }} match</template>
      <template v-else>{{ total.toLocaleString() }} {{ total === 1 ? 'entity' : 'entities' }}</template>
      <template v-if="matching.length > ENTITY_ROWS_MAX"> · showing the first {{ ENTITY_ROWS_MAX }}</template>
    </p>

    <ul ref="listEl" class="rail-list">
      <li
        v-for="row in shown"
        :key="row.key"
        :data-key="row.key"
        class="rail-row"
        :class="{ 'rail-row--active': isActive(row) }"
        tabindex="0"
        @click="select(row)"
        @keydown.enter.prevent="select(row)"
      >
        <span class="rail-swatch" :style="{ background: row.color }" aria-hidden="true"></span>
        <span class="rail-row-text">
          <span class="rail-row-label">{{ row.label }}</span>
          <span v-if="row.subtitle" class="rail-row-sub">{{ row.subtitle }}</span>
          <span v-if="multiLayer" class="rail-row-layer">{{ layers.find(l => l.id === row.layerId)?.name }}</span>
        </span>
      </li>
    </ul>
    <p v-if="shown.length === 0 && !props.loading" class="rail-empty">No entities match.</p>
  </aside>
</template>

<style scoped>
.entity-rail {
  position: fixed;
  top: 80px;
  right: 16px;
  bottom: 16px;
  width: 320px;
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  background: var(--blo-cream, #f7f4ee);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  animation: entity-rail-slide-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes entity-rail-slide-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

.rail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.rail-eyebrow {
  display: block;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}

.rail-title {
  margin: 2px 0 0;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 18px;
  font-weight: 700;
  color: var(--blo-ink, #111);
}

.rail-links {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.rail-links a {
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}

.rail-links a:hover {
  text-decoration: underline;
}

.rail-exit {
  border: none;
  background: none;
  font-size: 20px;
  line-height: 1;
  color: var(--blo-stone, #6b6560);
  cursor: pointer;
}

.rail-search {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  background: #fff;
  font-size: 14px;
}

.rail-count {
  margin: 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.rail-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}

.rail-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 6px;
  border-radius: 6px;
  cursor: pointer;
  border-bottom: 1px solid var(--blo-cream-deep, #ede8dd);
}

.rail-row:hover,
.rail-row:focus {
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  outline: none;
}

.rail-row--active {
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  box-shadow: inset 3px 0 0 var(--blo-green-deep, #1f7a2e);
}

.rail-swatch {
  flex: 0 0 10px;
  width: 10px;
  height: 10px;
  margin-top: 5px;
  border-radius: 50%;
  border: 1.5px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
}

.rail-row-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.rail-row-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
}

.rail-row-sub,
.rail-row-layer {
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-empty {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.rail-handle {
  display: none;
  border: none;
  background: none;
  padding: 0 0 6px;
  cursor: pointer;
}

.rail-handle span {
  display: block;
  width: 36px;
  height: 4px;
  margin: 0 auto;
  border-radius: 2px;
  background: var(--blo-cream-divider, #e0d9ca);
}

.rail-loading {
  color: var(--blo-green-deep, #1f7a2e);
}

/* --- Phone / small tablet: the rail is a bottom sheet ----------------------
   P5-39 made it one; P5-60 made it tappable — a 44 px grab handle and exit,
   44 px rows, 14 px meta text, and a bottom inset that clears the home bar on
   a notched phone. The `max-height` is `svh` so the sheet is measured against
   the small viewport and never grows under the browser's own chrome. */
@media (max-width: 768px) {
  .entity-rail {
    top: auto;
    left: 12px;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom, 0px));
    width: auto;
    max-height: 45svh;
    padding: 4px 14px calc(12px + env(safe-area-inset-bottom, 0px));
    transition: max-height 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  /* The grab bar is 4 px of paint in a 44 px target. */
  .rail-handle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 44px;
    padding: 0;
  }

  .rail-exit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    margin: -8px -8px 0 0;
    font-size: 24px;
  }

  .rail-links {
    font-size: 14px;
  }

  .rail-links a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  .rail-search {
    min-height: 44px;
    font-size: 16px;
  }

  .rail-count,
  .rail-empty {
    font-size: 14px;
  }

  .rail-row {
    align-items: center;
    min-height: 44px;
    padding: 8px;
  }

  .rail-row-label {
    /* A long entity name wraps rather than pushing the sheet wider. */
    overflow-wrap: anywhere;
  }

  .rail-row-sub,
  .rail-row-layer {
    font-size: 13px;
  }

  /* Collapsed: the handle plus the title block, nothing else. */
  .entity-rail--collapsed {
    max-height: 112px;
    overflow: hidden;
  }

  .entity-rail--collapsed .rail-search,
  .entity-rail--collapsed .rail-count,
  .entity-rail--collapsed .rail-list,
  .entity-rail--collapsed .rail-empty {
    display: none;
  }
}
</style>
