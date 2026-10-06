<script setup lang="ts">
/**
 * One row of filter chips with counts (P6-3, P6-4).
 *
 * The same shape as the library list's topic facet (P5-63): plain words, the
 * count beside each, pressing the one you are on clears it. Counts come from
 * `facetsOf`, which counts the rows the OTHER filters have already left — so
 * a chip never promises rows that are not there.
 *
 * A facet whose id is empty is the "nothing said" bucket. It travels in a URL
 * as `NONE_VALUE` rather than as an empty string, because an empty string is
 * already "not filtered at all".
 */
import { computed, ref } from 'vue'
import { NONE_VALUE, type Facet } from '@/lib/browse'

const props = defineProps<{
  modelValue: string
  facets: Facet[]
  /** What this row filters by, for a screen reader: "Filter by publisher". */
  label: string
  /** The word for "no filter": "All publishers", "Any topic". */
  allLabel: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

/**
 * How many values a row shows before it folds (P6-18).
 *
 * Facets arrive count-ordered, so the first few are the ones worth offering:
 * the publishers run 15, 5, 4, 3, 3, 3, 2… and then seventeen values with a
 * count of one. Unfolded, that row was 844px on a phone — a full screen of
 * chips above a list nobody had reached yet.
 */
const VISIBLE_LIMIT = 8

/** Per visit, not per URL: a shared link must open the same page for
 *  everyone, so this never reaches `browseQuery`. */
const expanded = ref(false)

/** The value a chip writes into the URL. */
function valueOf(facet: Facet): string {
  return facet.id || NONE_VALUE
}

const collapsible = computed(() => props.facets.length > VISIBLE_LIMIT)

const activeFacet = computed(() => props.facets.find(facet => valueOf(facet) === props.modelValue))

/**
 * What the row draws. Folded, that is the heaviest `VISIBLE_LIMIT` values —
 * **plus the chosen one, wherever it sits in the order**. A filter you cannot
 * see is a filter you cannot clear, and the twenty-second publisher is as
 * choosable as the first.
 */
const visibleFacets = computed(() => {
  if (expanded.value || !collapsible.value) return props.facets
  const head = props.facets.slice(0, VISIBLE_LIMIT)
  const active = activeFacet.value
  return active && !head.includes(active) ? [...head, active] : head
})

const hiddenCount = computed(() => props.facets.length - visibleFacets.value.length)

/** Pressing the chip you are already on clears it — a facet is a toggle, not
 *  a one-way door (the same rule the library list's topics follow). */
function pick(value: string): void {
  emit('update:modelValue', props.modelValue === value ? '' : value)
}
</script>

<template>
  <div v-if="facets.length" class="filter-chips" role="group" :aria-label="label" data-testid="filter-chips">
    <button
      type="button"
      class="chip"
      :class="{ active: !modelValue }"
      :aria-pressed="!modelValue"
      data-chip=""
      @click="emit('update:modelValue', '')"
    >
      {{ allLabel }}
    </button>
    <button
      v-for="facet in visibleFacets"
      :key="valueOf(facet)"
      type="button"
      class="chip"
      :class="{ active: modelValue === valueOf(facet), muted: !facet.id }"
      :aria-pressed="modelValue === valueOf(facet)"
      :data-chip="valueOf(facet)"
      @click="pick(valueOf(facet))"
    >
      {{ facet.label }} <span class="chip-count">{{ facet.count }}</span>
    </button>
    <button
      v-if="collapsible"
      type="button"
      class="chip chip-toggle"
      :aria-expanded="expanded"
      data-testid="chips-toggle"
      @click="expanded = !expanded"
    >
      {{ expanded ? 'Show fewer' : `+${hiddenCount} more` }}
    </button>
  </div>
</template>

<style scoped>
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.chip {
  padding: 3px 12px;
  font-family: inherit;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--blo-ink, #111);
  color: var(--blo-ink, #111);
}

.chip.active {
  background: var(--blo-ink, #111);
  border-color: var(--blo-ink, #111);
  color: #ffffff;
}

/* "No organization" is a gap to fill, not a publisher. */
.chip.muted {
  border-style: dashed;
}

/* The fold is a control, not a value — no border, so it never reads as one
   more publisher at the end of the row. */
.chip-toggle {
  border-color: transparent;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.chip-count {
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
}

/* --- Phone (P5-60) -------------------------------------------------------- */
@media (max-width: 640px) {
  .chip {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
