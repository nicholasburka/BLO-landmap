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
      <p v-if="!result.movers.length" class="ic-note">
        No county changed place between them.
      </p>
      <template v-else>
        <p class="ic-movers-title">Moved furthest:</p>
        <ul class="ic-movers" data-testid="index-movers">
          <li v-for="m in result.movers" :key="m.geoId">
            <span class="ic-geo">{{ placeName(m.geoId) }}</span>
            <span class="ic-move">#{{ m.from }} → #{{ m.to }}</span>
            <span class="ic-delta">{{ m.delta }} {{ m.delta === 1 ? 'place' : 'places' }}</span>
          </li>
        </ul>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { compareIndices } from '@/lib/indexCompare'
import { getCountyByGeoId, initCountyLookup } from '@/lib/countyLookup'
import type { DerivedColumn } from '@/lib/workingSets'

const props = defineProps<{ columns: DerivedColumn[] }>()

/**
 * County NAMES for the movers, not GEOIDs.
 *
 * "Moved furthest: 72003 #13 → #3166" names nothing a reader knows. The lookup
 * is a static file the map page has usually already paid for, and it is cached
 * for the session — so this costs nothing here and turns the list into
 * sentences about places. A geoid with no match still prints, because a row
 * that cannot be named is still a row that moved.
 */
const namesReady = ref(false)
onMounted(async () => {
  try {
    await initCountyLookup()
    namesReady.value = true
  } catch {
    // No lookup, no names — the geoids below stand on their own.
  }
})

function placeName(geoId: string): string {
  if (!namesReady.value) return geoId
  try {
    const county = getCountyByGeoId(geoId)
    return county ? `${county.name}, ${county.stateAbbr}` : geoId
  } catch {
    return geoId
  }
}

/** Only an index can be compared to an index. A proximity column is a
 *  distance, and "did the ranking change" is not a question about it. */
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
  if (!a || !b) return { n: 0, spearman: null, note: 'Pick two indices.', movers: [] }
  return compareIndices(a.values, b.values, { movers: 8 })
})

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
.ic-movers-title {
  margin: 0.4rem 0 0.2rem;
  font-size: 0.86rem;
  color: #6b6560;
}
.ic-movers {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.15rem;
  font-size: 0.86rem;
}
.ic-movers li {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
}
.ic-geo {
  font-variant-numeric: tabular-nums;
}
.ic-move {
  color: #6b6560;
  font-variant-numeric: tabular-nums;
}
.ic-delta {
  color: #92400e;
  font-size: 0.8rem;
}
</style>
