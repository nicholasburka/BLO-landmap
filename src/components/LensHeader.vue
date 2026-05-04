<template>
  <div class="lens-hd">
    <!-- Empty state — single line "Showing X" -->
    <div v-if="!hasActiveQuery" class="lens-hd-empty">
      <span class="lens-hd-prefix">Showing</span>
      <span class="lens-hd-default">{{ defaultLayerName }}</span>
    </div>

    <!-- Active state. Two-row layout so the descriptor has room to
         breathe even on narrow rails:
           row 1: ACTIVE QUERY eyebrow ··· Clear ×
           row 2: <descriptor> (e.g. "Black Homeownership")
         The scoring layer's full name lives in the Legend tab below
         and the rank/walk entry is in the Rankings panel + the rail.
         Filter chips remain because they're not surfaced anywhere
         else and they materially change the result set. -->
    <div v-else class="lens-hd-active">
      <div class="lens-hd-active-row">
        <span class="lens-hd-label">Active query</span>
        <button
          type="button"
          class="lens-hd-clear"
          @click.stop="$emit('clear')"
          aria-label="Clear current query"
          title="Clear current query"
        >Clear ×</button>
      </div>
      <div v-if="queryDescriptor" class="lens-hd-descriptor" :title="queryDescriptorFull">
        {{ queryDescriptor }}
      </div>
      <div v-if="filterChips.length > 0" class="lens-hd-chips">
        <span
          v-for="chip in filterChips"
          :key="'f-' + chip.key"
          class="lens-hd-chip lens-hd-chip--filter"
        >{{ chip.label }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ScoringFilter } from '@/types/mapTypes'

interface ScoringChip {
  id: string
  name: string
  arrow: string
  directionClass: string
}

interface FilterChip {
  key: string
  label: string
}

const props = defineProps<{
  scoringChips: ScoringChip[]
  activeFilters: ScoringFilter[]
  limit: number | null
  /** Shown in the empty/no-query state, e.g. "BLO Livability Index". */
  defaultLayerName: string
  /** Render the inline "▶ Walk through" CTA when there's a ranked result
   *  worth touring. Phase 4d cleanup makes the tour reachable on mobile
   *  (where RankingPanel is hidden) and discoverable when the panel is
   *  collapsed on desktop. */
  canWalkThrough?: boolean
}>()

defineEmits<{
  (e: 'clear'): void
  (e: 'walk-through'): void
}>()

const filterChips = computed<FilterChip[]>(() =>
  props.activeFilters.map((f) => {
    let label = ''
    switch (f.operator) {
      case 'greater_than': label = `${f.layerId} > ${f.value}`; break
      case 'less_than':    label = `${f.layerId} < ${f.value}`; break
      case 'between':      label = `${f.layerId} ${f.value}–${f.max ?? '?'}`; break
      default:             label = `${f.layerId} ? ${f.value}`
    }
    return { key: `${f.layerId}-${f.operator}`, label }
  }),
)

const hasActiveQuery = computed(
  () => props.scoringChips.length > 0 || filterChips.value.length > 0 || props.limit != null,
)

/** Short label printed next to "ACTIVE QUERY". Strips trailing
 *  redundant words so e.g. "Black Homeownership Rate" reads as
 *  "Black Homeownership" — punchier and still unambiguous since the
 *  Legend tab below carries the full layer name. */
function shortenLayerName(name: string): string {
  return name
    .replace(/\s+(Rate|Index|Score|Count|Population|Average)$/i, '')
    .trim()
}

const queryDescriptor = computed(() => {
  if (props.scoringChips.length === 0) {
    if (filterChips.value.length > 0) return 'Filtered'
    return ''
  }
  const primary = shortenLayerName(props.scoringChips[0].name)
  if (props.scoringChips.length === 1) return primary
  return `${primary} +${props.scoringChips.length - 1}`
})

const queryDescriptorFull = computed(() => {
  if (props.scoringChips.length === 0) return ''
  return props.scoringChips.map(c => c.name).join(' · ')
})
</script>

<style scoped>
.lens-hd {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-feature-settings: "tnum";
}

/* Empty state */
.lens-hd-empty {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.lens-hd-prefix {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}
.lens-hd-default {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
}

/* Active state */
.lens-hd-active-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lens-hd-label {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
  flex-shrink: 0;
}
/* Concise query name — sits on its own row beneath the eyebrow so it
   has room without competing with the Clear button. Display font for
   prominence; the Legend tab below shows the full layer name. */
.lens-hd-descriptor {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  line-height: 1.25;
  /* Truncate if a long custom-mix overflows, but the row above gives
     us full panel width so this rarely fires. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.lens-hd-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.lens-hd-walk {
  background: var(--blo-green-deep, #1f7a2e);
  color: white;
  border: 1px solid var(--blo-green-deep, #1f7a2e);
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  padding: 3px 10px;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.lens-hd-walk:hover {
  background: var(--blo-ink, #111);
  border-color: var(--blo-ink, #111);
}

.lens-hd-clear {
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  font-size: 10.5px;
  padding: 2px 8px;
  color: var(--blo-stone, #6b6560);
  cursor: pointer;
  flex-shrink: 0;
}
.lens-hd-clear:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-stone-soft, #9a948e);
}

.lens-hd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
}

/* Mobile: chips don't wrap or truncate — they scroll horizontally with a
   fade-mask hint on the right edge. Keeps every chip's full layer name
   readable in the peek state where vertical space is precious. */
@media (max-width: 768px) {
  .lens-hd-chips {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    padding-right: 14px;
    mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
    -webkit-mask-image: linear-gradient(to right, black calc(100% - 24px), transparent 100%);
    scrollbar-width: none;
  }
  .lens-hd-chips::-webkit-scrollbar {
    display: none;
  }
}

.lens-hd-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 999px;
  white-space: nowrap;
  font-feature-settings: "tnum";
}

.lens-hd-chip--scoring {
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  color: var(--blo-green-deep, #1f7a2e);
  border: 1px solid var(--blo-green-soft, rgba(55, 179, 74, 0.24));
}

.lens-hd-chip--filter {
  background: white;
  color: var(--blo-ink-soft, #2a2a2a);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
}

.lens-hd-chip--limit {
  background: var(--blo-ink, #111);
  color: white;
  font-weight: 600;
}

.lens-hd-arrow {
  font-weight: 700;
}
.lens-hd-arrow.dir-lower {
  color: var(--blo-stone, #6b6560);
}
</style>
