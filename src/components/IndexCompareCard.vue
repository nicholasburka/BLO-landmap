<template>
  <!-- P9-6: two versions of an index, and what re-weighting did to the ORDER.
       The set already holds both columns' values, so this fetches nothing and
       costs nothing — where an analysis runs is our problem, not the
       reader's, and the answer here is "here, instantly". -->
  <section v-if="indices.length >= 2" class="index-compare" data-testid="index-compare">
    <h3 class="ic-title">Compare two versions</h3>

    <p class="ic-pick">
      <select v-model="leftId" aria-label="First index">
        <option v-for="c in indices" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
      <span class="ic-vs">against</span>
      <select v-model="rightId" aria-label="Second index">
        <option v-for="c in indices" :key="c.id" :value="c.id">{{ c.label }}</option>
      </select>
    </p>

    <p v-if="result.spearman === null" class="ic-note" data-testid="index-compare-note">
      {{ result.note }}
    </p>
    <template v-else>
      <!-- Never a bare correlation: the words, the number and the count it is
           over, together or not at all. -->
      <p class="ic-verdict">
        {{ verdict }} — <strong>{{ result.spearman.toFixed(2) }}</strong>
        across {{ result.n.toLocaleString() }} {{ result.n === 1 ? 'county' : 'counties' }}
        they both cover.
      </p>
      <!-- How much moved and how far, never WHICH counties moved furthest.
           That list was the same eight sparse-data territories every time. -->
      <p class="ic-shift" data-testid="index-shift">{{ shiftLine }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { compareIndices, shiftLineOf } from '@/lib/indexCompare'
import type { DerivedColumn } from '@/lib/workingSets'

const props = defineProps<{ columns: DerivedColumn[] }>()

const indices = computed(() => props.columns.filter(c => c.type === 'composite'))

const leftId = ref('')
const rightId = ref('')

watch(
  indices,
  list => {
    if (!list.some(c => c.id === leftId.value)) leftId.value = list[0]?.id ?? ''
    if (!list.some(c => c.id === rightId.value) || rightId.value === leftId.value) {
      rightId.value = list.find(c => c.id !== leftId.value)?.id ?? ''
    }
  },
  { immediate: true },
)

const result = computed(() => {
  const a = indices.value.find(c => c.id === leftId.value)
  const b = indices.value.find(c => c.id === rightId.value)
  if (!a || !b) return { n: 0, spearman: null, note: 'Pick two indices.', shift: null }
  return compareIndices(a.values, b.values)
})

const shiftLine = computed(() => shiftLineOf(result.value))

/**
 * The statistic in words. A correlation is a number most readers cannot place,
 * and the point of the comparison is the judgement, not the coefficient.
 */
const verdict = computed(() => {
  const r = result.value.spearman
  if (r === null) return ''
  if (r >= 0.95) return 'Almost the same ranking'
  if (r >= 0.8) return 'Broadly the same ranking'
  if (r >= 0.5) return 'Related, but they disagree in places'
  if (r >= 0) return 'Largely different rankings'
  return 'They rank counties in opposite directions'
})
</script>

<style scoped>
/* Same as the analysis card: a bare <select> renders in the UA's Arial among
   the app's type, and sizes its native dropdown from that. */
.ic-pick select {
  font: inherit;
  font-size: 0.86rem;
  max-width: 100%;
  padding: 2px 4px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  background: #fff;
}

.index-compare {
  margin: 1rem 0;
  padding: 0.75rem 0 0;
  border-top: 1px solid #e7e2da;
}
.ic-title {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
}
.ic-pick {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin: 0 0 0.5rem;
}
.ic-vs {
  color: #6b6560;
  font-size: 0.85rem;
}
.ic-verdict {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
}
.ic-note {
  margin: 0;
  color: #6b6560;
  font-size: 0.86rem;
}
.ic-shift { margin: 0.3rem 0 0; font-size: 0.86rem; }
</style>
