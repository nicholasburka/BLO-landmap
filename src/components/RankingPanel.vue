<template>
  <div
    v-if="visible"
    class="ranking-panel"
    style="pointer-events: auto"
    @click.stop
  >
    <button
      @click="$emit('toggle')"
      class="ranking-toggle"
      :aria-expanded="expanded"
      aria-controls="ranking-content"
      aria-label="Toggle county ranking panel"
    >
      {{ expanded ? '▼' : '▲' }} County Rankings
    </button>
    <div v-show="expanded" id="ranking-content" class="ranking-content">
      <!-- Active filter pills (threshold filters from LLM) -->
      <div v-if="filterPills.length > 0" class="ranking-filter-row">
        <span class="ranking-filter-label">Filters:</span>
        <span
          v-for="(pill, i) in filterPills"
          :key="i"
          class="ranking-filter-pill"
        >{{ pill }}</span>
        <button
          class="ranking-filter-clear"
          @click="$emit('clear-filters')"
          aria-label="Clear filters"
          title="Clear all filters"
        >×</button>
      </div>
      <div class="ranking-controls">
        <select
          v-model="selectedState"
          class="state-filter"
          aria-label="Filter by state"
        >
          <option value="">All States</option>
          <option v-for="state in stateList" :key="state" :value="state">{{ state }}</option>
        </select>
        <button
          class="sort-toggle"
          @click="showBottom = !showBottom"
          :aria-label="showBottom ? 'Show top counties' : 'Show bottom counties'"
        >
          {{ showBottom ? `Bottom ${effectiveLimit}` : `Top ${effectiveLimit}` }}
        </button>
      </div>
      <div class="ranking-count">{{ countLabel }}</div>
      <div class="ranking-list">
        <div
          v-for="(county, index) in displayedCounties"
          :key="county.geoId"
          class="ranking-row"
          @click="$emit('select-county', county.geoId)"
          role="button"
          tabindex="0"
          @keydown.enter="$emit('select-county', county.geoId)"
          :aria-label="`${county.name}, ${county.state}: score ${county.score}`"
        >
          <span class="ranking-rank">{{ county.displayRank }}</span>
          <span class="ranking-name">{{ county.name }}</span>
          <span class="ranking-state">{{ county.stateAbbr }}</span>
          <span class="ranking-score">{{ county.score }}</span>
        </div>
        <div v-if="displayedCounties.length === 0" class="ranking-empty">
          {{ filterPills.length > 0 ? 'No counties match the filters' : 'No counties match' }}
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { CountyScore, ScoringFilter } from '@/types/mapTypes'
import { FIPS_TO_STATE } from '@/config/stateFips'
import { LAYER_REGISTRY } from '@/config/layerRegistry'

interface CountyDisplay {
  geoId: string
  name: string
  state: string
  stateAbbr: string
  score: string
  displayRank: number
}

interface Props {
  expanded: boolean
  visible: boolean
  rankedCounties: CountyScore[]
  /** Function to resolve county name from GEOID */
  getCountyName: (geoId: string) => string
  /** v-model: currently selected state filter (name, abbr, or empty) */
  selectedState?: string
  /** Active threshold filters from LLM (for pill display) */
  activeFilters?: ScoringFilter[]
  /** LLM-specified display limit (number of rows). null/undefined = show all */
  displayLimit?: number | null
}

const props = withDefaults(defineProps<Props>(), {
  selectedState: '',
  activeFilters: () => [],
  displayLimit: null,
})

const emit = defineEmits<{
  toggle: []
  'select-county': [geoId: string]
  'update:selectedState': [value: string]
  'clear-filters': []
}>()

/** Short, terse filter pill text: "pct_Black > 30" */
const filterPills = computed(() => {
  return (props.activeFilters || []).map((f) => {
    const layer = LAYER_REGISTRY[f.layerId]
    const shortId = layer?.id || f.layerId
    switch (f.operator) {
      case 'greater_than': return `${shortId} > ${f.value}`
      case 'less_than': return `${shortId} < ${f.value}`
      case 'between': return `${shortId} ${f.value}–${f.max ?? '?'}`
      default: return shortId
    }
  })
})

const showBottom = ref(false)

/** Two-way binding for the state dropdown */
const selectedState = computed({
  get: () => props.selectedState,
  set: (v: string) => emit('update:selectedState', v),
})

/** Build sorted list of state names for the dropdown */
const stateList = computed(() => {
  return Object.values(FIPS_TO_STATE).sort()
})

/** Get state name from the first 2 digits of GEOID */
const getStateName = (geoId: string): string => {
  const fips = geoId.substring(0, 2)
  return FIPS_TO_STATE[fips] || 'Unknown'
}

/** Get abbreviated state (first 2 chars or known abbreviation) */
const getStateAbbr = (stateName: string): string => {
  // Common abbreviations
  const abbrs: Record<string, string> = {
    'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
    'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
    'District of Columbia': 'DC', 'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI',
    'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
    'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME',
    'Maryland': 'MD', 'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN',
    'Mississippi': 'MS', 'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE',
    'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
    'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
    'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI',
    'South Carolina': 'SC', 'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX',
    'Utah': 'UT', 'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA',
    'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
  }
  return abbrs[stateName] || stateName.substring(0, 2).toUpperCase()
}

/** Effective limit: LLM-specified limit, capped at 50. Defaults to 20 when not set. */
const effectiveLimit = computed(() => {
  const raw = props.displayLimit
  if (typeof raw === 'number' && raw > 0) return Math.min(50, raw)
  return 20
})

/** Ranked counties that pass the state filter (before slicing by limit) */
const stateFilteredCounties = computed(() => {
  let filtered = props.rankedCounties.filter(c => c.score !== null)
  if (selectedState.value) {
    const filter = selectedState.value.toUpperCase()
    filtered = filtered.filter(c => {
      const name = getStateName(c.geoId)
      return name.toUpperCase() === filter || getStateAbbr(name) === filter
    })
  }
  return filtered
})

const displayedCounties = computed<CountyDisplay[]>(() => {
  const filtered = stateFilteredCounties.value

  // Sort: top (descending) or bottom (ascending)
  const sorted = showBottom.value
    ? [...filtered].sort((a, b) => (a.score as number) - (b.score as number))
    : filtered // already sorted descending from rankedCounties

  const sliced = sorted.slice(0, effectiveLimit.value)

  return sliced.map((c, i) => ({
    geoId: c.geoId,
    name: props.getCountyName(c.geoId),
    state: getStateName(c.geoId),
    stateAbbr: getStateAbbr(getStateName(c.geoId)),
    score: (c.score as number).toFixed(1),
    displayRank: showBottom.value ? filtered.length - i : i + 1,
  }))
})

/** Human-readable count: "Showing 5 of 42 matching counties" with filter awareness */
const countLabel = computed(() => {
  const shown = displayedCounties.value.length
  const total = stateFilteredCounties.value.length
  const hasFilters = filterPills.value.length > 0 || !!selectedState.value
  const noun = hasFilters ? 'matching counties' : 'counties'
  if (shown === total) return `Showing ${shown} ${noun}`
  return `Showing ${shown} of ${total} ${noun}`
})
</script>

<style scoped>
.ranking-panel {
  background: white;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  max-width: 320px;
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 5;
}

.ranking-toggle {
  background-color: white;
  border: none;
  padding: 10px 12px;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font-weight: 600;
  border-radius: 4px;
  min-height: 40px;
  font-size: 14px;
}

.ranking-toggle:hover {
  background-color: #f0f0f0;
}

.ranking-toggle:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
}

.ranking-content {
  padding: 0 10px 10px;
  max-height: 50vh;
  overflow-y: auto;
}

.ranking-filter-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  flex-wrap: wrap;
  font-size: 10px;
}

.ranking-filter-label {
  color: #888;
  font-weight: 600;
}

.ranking-filter-pill {
  background: #eaf5ef;
  color: #2d6a4f;
  padding: 2px 6px;
  border-radius: 10px;
  font-family: ui-monospace, monospace;
  font-size: 10px;
  white-space: nowrap;
}

.ranking-filter-clear {
  background: transparent;
  border: none;
  cursor: pointer;
  color: #888;
  font-size: 14px;
  padding: 0 4px;
  line-height: 1;
}
.ranking-filter-clear:hover {
  color: #c0392b;
}

.ranking-count {
  font-size: 10px;
  color: #888;
  padding: 2px 0 6px;
}

.ranking-controls {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}

.state-filter {
  flex: 1;
  padding: 4px 6px;
  border: 1px solid #ccc;
  border-radius: 3px;
  font-size: 12px;
  background: white;
}

.sort-toggle {
  padding: 4px 8px;
  border: 1px solid #ccc;
  border-radius: 3px;
  font-size: 11px;
  background: #f8f8f8;
  cursor: pointer;
  white-space: nowrap;
}

.sort-toggle:hover {
  border-color: #4a90e2;
  color: #4a90e2;
}

.ranking-list {
  display: flex;
  flex-direction: column;
}

.ranking-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  font-size: 12px;
  transition: background-color 0.1s;
}

.ranking-row:hover {
  background-color: #f0f7ff;
}

.ranking-row:last-child {
  border-bottom: none;
}

.ranking-rank {
  color: #888;
  font-size: 11px;
  min-width: 24px;
  text-align: right;
}

.ranking-name {
  flex: 1;
  font-weight: 500;
  color: #2c3e50;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ranking-state {
  color: #888;
  font-size: 11px;
  min-width: 20px;
}

.ranking-score {
  font-weight: 600;
  color: #2d8a4e;
  min-width: 36px;
  text-align: right;
}

.ranking-empty {
  padding: 12px;
  text-align: center;
  color: #888;
  font-size: 12px;
  font-style: italic;
}

@media (max-width: 768px) {
  .ranking-panel {
    display: none;
  }
}
</style>
