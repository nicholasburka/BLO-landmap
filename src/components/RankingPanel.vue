<template>
  <div
    v-if="visible"
    class="ranking-panel blo-panel blo-panel--primary"
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
      <span class="ranking-toggle-motif" aria-hidden="true">
        <svg viewBox="0 0 28 14" width="26" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12 L7 5 L11 9 L16 3 L22 8 L27 4" />
          <path d="M1 12 H27" opacity="0.35" />
        </svg>
      </span>
      <span class="ranking-toggle-label">County Rankings</span>
      <span class="ranking-toggle-chevron" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
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
      <div class="ranking-count-row">
        <span class="ranking-count">{{ countLabel }}</span>
        <button
          v-if="displayedCounties.length > 0"
          class="walk-through-btn"
          @click="$emit('start-walkthrough')"
          title="Step through results with Next/Previous"
        >Walk through</button>
      </div>
      <div class="ranking-list">
        <div
          v-for="(county, index) in displayedCounties"
          :key="county.geoId"
          class="ranking-row"
          :style="{ '--i': index }"
          @click="$emit('select-county', county.geoId)"
          role="button"
          tabindex="0"
          @keydown.enter="$emit('select-county', county.geoId)"
          :aria-label="`${county.name}, ${county.state}: score ${county.score}`"
        >
          <span class="ranking-rank">{{ county.displayRank }}</span>
          <span class="ranking-name">
            <span class="ranking-county">{{ county.name }}</span>
            <span class="ranking-state">{{ county.stateAbbr }}</span>
          </span>
          <span class="ranking-score" title="Composite match score (0–100); higher matches the query more closely">
            {{ county.score }}<span class="ranking-score-unit">/100</span>
          </span>
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
  /** v-model: currently selected state filter (name, abbr, or empty).
   *  This is the dropdown's single-select axis — direct user picks. */
  selectedState?: string
  /** Phase 4g: parallel multi-state filter axis driven by the chat
   *  set_query_state tool. When non-empty, takes precedence over
   *  selectedState so a regional chat query isn't ANDed with a stale
   *  dropdown selection. */
  regionStates?: string[]
  /** Active threshold filters from LLM (for pill display) */
  activeFilters?: ScoringFilter[]
  /** LLM-specified display limit (number of rows). null/undefined = show all */
  displayLimit?: number | null
}

const props = withDefaults(defineProps<Props>(), {
  selectedState: '',
  regionStates: () => [],
  activeFilters: () => [],
  displayLimit: null,
})

const emit = defineEmits<{
  toggle: []
  'select-county': [geoId: string]
  'update:selectedState': [value: string]
  'clear-filters': []
  'start-walkthrough': []
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
    // US territories
    'American Samoa': 'AS', 'Guam': 'GU', 'Northern Mariana Islands': 'MP',
    'Puerto Rico': 'PR', 'U.S. Virgin Islands': 'VI',
  }
  return abbrs[stateName] || stateName.substring(0, 2).toUpperCase()
}

/** Effective limit: LLM-specified limit, capped at 50. Defaults to 20 when not set. */
const effectiveLimit = computed(() => {
  const raw = props.displayLimit
  if (typeof raw === 'number' && raw > 0) return Math.min(50, raw)
  return 20
})

/** Ranked counties that pass the state filter (before slicing by limit).
 *  Two parallel axes:
 *   - selectedState: dropdown single-select, direct user pick
 *   - regionStates:  chat-driven multi-state region (Phase 4g)
 *  When regionStates is non-empty it takes precedence; the chat already
 *  cleared the dropdown when it set the region (see Map.vue
 *  applyQueryState) so this branch should only fire from chat-set state. */
const stateFilteredCounties = computed(() => {
  let filtered = props.rankedCounties.filter(c => c.score !== null)
  if (props.regionStates && props.regionStates.length > 0) {
    const region = new Set(props.regionStates.map(s => s.toUpperCase()))
    filtered = filtered.filter(c => {
      const name = getStateName(c.geoId)
      return region.has(getStateAbbr(name).toUpperCase())
    })
  } else if (selectedState.value) {
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
  const hasFilters = filterPills.value.length > 0 || !!selectedState.value || (props.regionStates?.length ?? 0) > 0
  const noun = hasFilters ? 'matching counties' : 'counties'
  if (shown === total) return `Showing ${shown} ${noun}`
  return `Showing ${shown} of ${total} ${noun}`
})
</script>

<style scoped>
/* Surface from .blo-panel--primary; only layout concerns below. */
.ranking-panel {
  width: 320px;
  max-width: 320px;
  position: absolute;
  bottom: 10px;
  right: 10px;
  z-index: 5;
}

.ranking-toggle {
  background-color: transparent;
  color: var(--blo-ink);
  border: none;
  padding: 12px 14px;
  cursor: pointer;
  width: 100%;
  text-align: left;
  font-family: var(--blo-font-display);
  font-weight: 600;
  font-size: 17px;
  letter-spacing: -0.005em;
  border-bottom: 1px solid var(--blo-cream-divider);
  display: flex;
  align-items: center;
  gap: 8px;
}

.ranking-toggle:hover {
  color: var(--blo-green-deep);
}

.ranking-toggle:focus-visible {
  outline: 2px solid var(--blo-green);
  outline-offset: -2px;
}

.ranking-toggle-motif {
  display: inline-flex;
  align-items: center;
  color: var(--blo-green);
  flex-shrink: 0;
}

.ranking-toggle-label {
  flex: 1;
}

.ranking-toggle-chevron {
  font-size: 12px;
  color: var(--blo-stone-soft);
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

.ranking-count-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0 6px;
}

.ranking-count {
  font-size: 10px;
  color: #888;
}

.walk-through-btn {
  background: #eaf5ef;
  color: #2d6a4f;
  border: 1px solid #c0d9c8;
  border-radius: 3px;
  font-size: 10px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.walk-through-btn:hover {
  background: #d4e9db;
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

/* UX-02: rows become cards. "Places to consider", not spreadsheet rows. */
.ranking-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ranking-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: white;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
  /* UX-03: stagger-fade on mount. --i is set inline per-card (0, 1, 2, ...) */
  opacity: 0;
  transform: translateY(4px);
  animation: ranking-row-in 320ms ease-out forwards;
  animation-delay: calc(var(--i, 0) * 35ms);
}

@keyframes ranking-row-in {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ranking-row {
    animation: none;
    opacity: 1;
    transform: none;
  }
}

.ranking-row:hover {
  border-color: var(--blo-green);
  transform: translateY(-1px);
  box-shadow: 0 4px 10px rgba(55, 179, 74, 0.10);
}

.ranking-row:focus-visible {
  outline: 2px solid var(--blo-green);
  outline-offset: 2px;
}

.ranking-rank {
  color: var(--blo-stone);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-align: center;
  background: var(--blo-cream-deep);
  border-radius: var(--blo-radius-input);
  padding: 3px 0;
}

.ranking-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.ranking-county {
  font-family: var(--blo-font-display);
  font-weight: 500;
  font-size: 15px;
  letter-spacing: -0.005em;
  color: var(--blo-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.ranking-state {
  color: var(--blo-stone);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  background: var(--blo-cream-deep);
  padding: 1px 6px;
  border-radius: var(--blo-radius-input);
  flex-shrink: 0;
}

.ranking-score {
  font-weight: 700;
  font-size: 13px;
  color: var(--blo-green-deep);
  min-width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.ranking-score-unit {
  font-weight: 500;
  font-size: 10.5px;
  color: var(--blo-stone, #6b6560);
  margin-left: 1px;
  letter-spacing: 0.02em;
}

.ranking-empty {
  padding: 12px;
  text-align: center;
  color: #888;
  font-size: 12px;
  font-style: italic;
}

@media (max-width: 768px) {
  /* Phase 4h: RankingPanel is hidden on mobile. Its functionality is
     unified into CountyRail's new 'rankings' view, which shows up
     automatically when a query is active and no county is inspected.
     The desktop layout above is untouched. */
  .ranking-panel {
    display: none !important;
  }
  /* Stale rules below kept for reference (and in case we ever toggle
     back on tablet); they no longer apply since display:none above
     wins. */
  .ranking-panel.legacy-mobile-rules {
    position: fixed;
    top: 70px;
    right: 8px;
    bottom: auto;
    left: auto;
    width: auto;
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 200px);
    z-index: 7;
  }
}
</style>
