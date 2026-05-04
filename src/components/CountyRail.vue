<template>
  <aside
    v-if="visible"
    class="county-rail blo-panel blo-panel--primary"
    :class="{
      'county-rail--walk': mode === 'walk',
      'county-rail--inspect': mode === 'inspect',
    }"
    role="complementary"
    :aria-label="mode === 'walk' ? 'County walkthrough' : 'County inspection'"
    @click.stop
  >
    <header class="rail-header">
      <button
        v-if="view === 'rank' || view === 'listings'"
        type="button"
        class="rail-back"
        @click="view = 'detail'"
        aria-label="Back to county details"
        title="Back"
      >← Back</button>
      <span v-else-if="mode === 'walk'" class="rail-rank">
        {{ rank }}<span class="rail-rank-of"> of {{ total }}</span>
      </span>
      <span v-else class="rail-eyebrow">Inspect</span>
      <button
        class="rail-exit"
        type="button"
        @click="$emit('exit')"
        :aria-label="mode === 'walk' ? 'Exit walkthrough' : 'Close inspection'"
        :title="mode === 'walk' ? 'Exit walkthrough (Esc)' : 'Close (Esc)'"
      >×</button>
    </header>

    <!-- =============== DETAIL VIEW (default) =============== -->
    <template v-if="view === 'detail'">
      <div class="rail-county">
        <h2 class="rail-county-name">{{ countyName }}</h2>
        <p v-if="stateName" class="rail-state">{{ stateName }}</p>
      </div>

      <div v-if="score != null" class="rail-score">
        <div class="rail-score-row">
          <span class="rail-score-label">{{ scoreLabel }}</span>
          <span class="rail-score-value">
            {{ score.toFixed(scoreScale === 5 ? 2 : 1) }}<span class="rail-score-unit"> / {{ scoreScale }}</span>
          </span>
        </div>
        <button
          v-if="scoreRank"
          type="button"
          class="rail-score-rank"
          @click.stop="view = 'rank'"
          :aria-label="`Open full ranking — currently ${formatRank(scoreRank.rank)} of ${scoreRank.total}`"
          title="See where this county ranks among all counties"
        >
          rank {{ formatRank(scoreRank.rank) }} of {{ scoreRank.total.toLocaleString() }}
          <span class="rail-score-rank-arrow" aria-hidden="true">→</span>
        </button>
      </div>

      <ul v-if="stats.length > 0" class="rail-stats">
        <li
          v-for="stat in stats"
          :key="stat.layerId"
          class="rail-stat"
          :class="{
            'rail-stat--good': stat.delta === 'good',
            'rail-stat--bad': stat.delta === 'bad',
          }"
        >
          <span class="rail-stat-label">{{ stat.name }}</span>
          <span class="rail-stat-value">
            <span v-if="stat.delta === 'good' || stat.delta === 'bad'" class="rail-stat-pip" aria-hidden="true"></span>
            {{ stat.value }}
          </span>
        </li>
      </ul>

      <button
        class="rail-details"
        type="button"
        @click="$emit('view-details')"
      >View full details ▸</button>

      <!-- Find land for sale: contextual CTA. Hidden until the parent
           wires `landSearch` (so a rail in a context without listings
           support — e.g. the walkthrough — won't show a dead button). -->
      <div v-if="landSearch" class="rail-land">
        <button
          type="button"
          class="rail-land-btn"
          :disabled="landSearch.loading || landSearch.disabled"
          @click="$emit('search-land')"
        >
          <span v-if="landSearch.loading" class="rail-land-spinner" aria-hidden="true"></span>
          <span v-else class="rail-land-icon" aria-hidden="true">⌂</span>
          <span>{{ landSearch.loading ? 'Searching listings…' : 'Find land for sale' }}</span>
        </button>
        <p v-if="landSearch.resultCount > 0" class="rail-land-result">
          <button type="button" class="rail-land-open" @click="view = 'listings'">
            view {{ landSearch.resultCount }} {{ landSearch.resultCount === 1 ? 'listing' : 'listings' }}
            <span class="rail-land-open-arrow" aria-hidden="true">→</span>
          </button>
          <button type="button" class="rail-land-clear" @click="$emit('clear-land')">clear</button>
        </p>
        <p v-else-if="landSearch.attempted && !landSearch.loading" class="rail-land-empty">
          No listings nearby — try another county.
        </p>
      </div>
    </template>

    <!-- =============== RANK VIEW (from "rank N of M" click) =============== -->
    <template v-else-if="view === 'rank'">
      <div class="rail-rank-titles">
        <span class="rail-rank-eyebrow">Ranked by</span>
        <h3 class="rail-rank-title">{{ scoreLabel }}</h3>
        <p class="rail-rank-sub">
          {{ rankCounties.length.toLocaleString() }} counties · scroll or click to inspect
        </p>
      </div>
      <ol class="rail-rank-list" ref="rankListEl">
        <li
          v-for="row in rankCounties"
          :key="row.geoId"
          class="rail-rank-row"
          :class="{ 'rail-rank-row--current': row.geoId === currentGeoId }"
          :data-geoid="row.geoId"
        >
          <button
            type="button"
            class="rail-rank-row-btn"
            @click="onPickRow(row.geoId)"
            :aria-current="row.geoId === currentGeoId ? 'true' : undefined"
          >
            <span class="rail-rank-num">{{ row.rank.toLocaleString() }}</span>
            <span class="rail-rank-name">
              <span class="rail-rank-county">{{ row.name }}</span>
              <span class="rail-rank-state">{{ row.stateAbbr }}</span>
            </span>
            <span class="rail-rank-score">
              {{ row.scoreFmt }}<span class="rail-rank-score-unit">/{{ scoreScale }}</span>
            </span>
          </button>
        </li>
      </ol>
    </template>

    <!-- =============== LISTINGS VIEW (from "view N listings" click) =============== -->
    <template v-else-if="view === 'listings' && landSearch">
      <div class="rail-listings-head">
        <span class="rail-listings-eyebrow">Land for sale near</span>
        <h3 class="rail-listings-title">{{ countyName }}</h3>
        <p class="rail-listings-sub">
          {{ landSearch.results.length }} {{ landSearch.results.length === 1 ? 'listing' : 'listings' }}
          <button
            v-if="landSearch.results.length > 0"
            type="button"
            class="rail-listings-csv"
            @click="$emit('download-listings')"
            title="Download all listings as CSV"
          >· download CSV</button>
        </p>
      </div>
      <ul class="rail-listings-list">
        <li
          v-for="listing in landSearch.results"
          :key="listing.id"
          class="rail-listing-card"
        >
          <button
            type="button"
            class="rail-listing-card-btn"
            @click="$emit('select-listing', listing.id)"
            :title="`Show ${listing.formattedAddress} on map`"
          >
            <div class="rail-listing-row">
              <span class="rail-listing-price">${{ listing.price.toLocaleString() }}</span>
              <span class="rail-listing-days" v-if="listing.daysOnMarket != null">{{ listing.daysOnMarket }}d on market</span>
            </div>
            <div class="rail-listing-address">{{ listing.formattedAddress }}</div>
            <div class="rail-listing-meta" v-if="listing.lotSize != null">
              {{ listing.lotSize.toLocaleString() }} sq ft lot
            </div>
          </button>
          <div class="rail-listing-links">
            <a
              v-if="listing.listingOffice && listing.listingOffice.website"
              :href="listing.listingOffice.website"
              target="_blank"
              rel="noopener noreferrer"
              class="rail-listing-link"
              @click.stop
            >Realtor ↗</a>
            <a
              :href="`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(listing.formattedAddress)}`"
              target="_blank"
              rel="noopener noreferrer"
              class="rail-listing-link"
              @click.stop
            >Google Maps ↗</a>
          </div>
        </li>
      </ul>
    </template>

    <footer v-if="view === 'detail' && mode === 'walk'" class="rail-nav">
      <button
        class="rail-nav-btn"
        type="button"
        @click="$emit('prev')"
        :disabled="rank <= 1"
        aria-label="Previous county"
      >← Prev</button>
      <button
        class="rail-nav-btn rail-nav-btn--primary"
        type="button"
        @click="$emit('next')"
        :disabled="rank >= total"
        aria-label="Next county"
      >Next →</button>
    </footer>
  </aside>
</template>

<script setup lang="ts">
interface RankRow {
  geoId: string
  rank: number
  name: string
  stateAbbr: string
  scoreFmt: string
}

const props = defineProps<{
  visible: boolean
  /** "walk" — multi-county tour with prev/next/rank.
   *  "inspect" — single-county glance, X to close. */
  mode: 'walk' | 'inspect'
  /** Walk-mode only — ignored in inspect mode. */
  rank?: number
  total?: number
  countyName: string
  stateName: string
  score: number | null
  stats: { layerId: string; name: string; value: string; delta?: 'good' | 'bad' | 'neutral' }[]
  /** Scale denominator for the score: 5 for BLO Livability (default and
   *  single-layer), 100 for the multi-layer custom composite. */
  scoreScale?: 5 | 100
  /** Optional override for the score label. Defaults to context-appropriate
   *  copy: "BLO Livability Index" (default), "Match score" (custom). */
  scoreLabel?: string
  /** Where this county sits among all scored counties for the current
   *  metric. Rendered as "rank N of M" under the score. */
  scoreRank?: { rank: number; total: number } | null
  /** Full ranked list of counties for the rank-explorer view. Rendered
   *  in the rail's 'rank' view (swap-in). */
  rankCounties?: RankRow[]
  /** GEOID of the currently-inspected county — highlighted in the rank list. */
  currentGeoId?: string | null
  /** Optional land-for-sale CTA state. When omitted, no CTA renders.
   *  When present, the rail surfaces a "Find land for sale" button and
   *  reports its current loading/result/empty state back to the user.
   *  When `results` is non-empty the rail can swap into a listings
   *  view (third view, after detail and rank). */
  landSearch?: {
    loading: boolean
    /** True after the user has run at least one search this session. */
    attempted: boolean
    /** Disable button (e.g. no county selected, no API key). */
    disabled?: boolean
    resultCount: number
    /** Listing records (RentCast shape — kept loose since the rail only
     *  reads a few fields and the parent owns the canonical type). */
    results: Array<{
      id: string
      formattedAddress: string
      price: number
      lotSize?: number | null
      daysOnMarket?: number | null
      listingOffice?: { website?: string } | null
    }>
  } | null
}>()

const emit = defineEmits<{
  prev: []
  next: []
  exit: []
  'view-details': []
  'view-rank': []
  'select-county': [geoId: string]
  'search-land': []
  'clear-land': []
  'select-listing': [listingId: string]
  'download-listings': []
}>()

import { computed, ref, watch, nextTick } from 'vue'
const scoreScale = computed(() => props.scoreScale ?? 5)
const scoreLabel = computed(() =>
  props.scoreLabel ?? (props.scoreScale === 100 ? 'Match score' : 'BLO Livability Index'),
)

const rankCounties = computed(() => props.rankCounties ?? [])

// View mode: detail (default), rank (county-ranking list), or listings
// (land-for-sale results). Each is a swap-in surface with a back arrow.
const view = ref<'detail' | 'rank' | 'listings'>('detail')

// Reset to detail whenever the rail closes — reopening should never
// land on the rank or listings view.
watch(() => props.visible, (open) => {
  if (!open) view.value = 'detail'
})
// Reset to detail when the inspected county changes via external means
// (e.g. user clicked another county on the map). Picking from the rank
// list is handled separately via onPickRow().
watch(() => props.currentGeoId, (newId, oldId) => {
  if (oldId != null && newId !== oldId) view.value = 'detail'
})
// If the listings view is open and results vanish (clearSearch, county
// switch that wiped state), bounce back to detail so the user isn't
// staring at an empty scroll area.
watch(() => props.landSearch?.results.length ?? 0, (n) => {
  if (view.value === 'listings' && n === 0) view.value = 'detail'
})

const rankListEl = ref<HTMLOListElement | null>(null)

function scrollCurrentRowIntoView(): void {
  if (view.value !== 'rank' || !props.currentGeoId || !rankListEl.value) return
  const el = rankListEl.value.querySelector(`[data-geoid="${props.currentGeoId}"]`) as HTMLElement | null
  if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' })
}
watch(view, (v) => {
  if (v === 'rank') nextTick(scrollCurrentRowIntoView)
})

function onPickRow(geoId: string): void {
  emit('select-county', geoId)
  // Auto-return to detail view on selection so the user immediately sees
  // the new county's stats. They can re-open rank to keep browsing.
  view.value = 'detail'
}

/** "1st", "2nd", "3rd", "1,234th" — small contextual ordinal label. */
function formatRank(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n.toLocaleString()}th`
  switch (n % 10) {
    case 1: return `${n.toLocaleString()}st`
    case 2: return `${n.toLocaleString()}nd`
    case 3: return `${n.toLocaleString()}rd`
    default: return `${n.toLocaleString()}th`
  }
}

// (Defined above near the prop block; nothing to add.)
</script>

<style scoped>
.county-rail {
  position: fixed;
  top: 80px;
  right: 16px;
  bottom: 16px;
  width: 320px;
  z-index: 25;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow-y: auto;
  background: var(--blo-cream, #f7f4ee);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  animation: rail-slide-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.rail-eyebrow {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}

@keyframes rail-slide-in {
  from { opacity: 0; transform: translateX(20px); }
  to   { opacity: 1; transform: translateX(0); }
}

.rail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.rail-rank {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 22px;
  font-weight: 700;
  color: var(--blo-green-deep, #1f7a2e);
  line-height: 1;
}
.rail-rank-of {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  font-weight: 400;
  color: var(--blo-stone, #6b6560);
  margin-left: 2px;
}

.rail-exit {
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  width: 28px;
  height: 28px;
  border-radius: 999px;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  color: var(--blo-stone, #6b6560);
  padding: 0;
}
.rail-exit:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-stone-soft, #9a948e);
}

.rail-county {
  margin: 4px 0 0;
}
.rail-county-name {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 24px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  margin: 0 0 2px;
  line-height: 1.15;
}
.rail-state {
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  margin: 0;
  letter-spacing: 0.02em;
}

.rail-score {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: white;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}
.rail-score-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.rail-score-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}
.rail-score-value {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 28px;
  font-weight: 700;
  color: var(--blo-green-deep, #1f7a2e);
  line-height: 1;
}
.rail-score-unit {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
  font-weight: 500;
  color: var(--blo-stone, #6b6560);
  letter-spacing: 0.02em;
}
/* Subtle ordinal rank — same row as score, smaller, ink-soft. Now a
   button that opens the full ranking explorer; the right-arrow + hover
   underline read as "click for more" without overwhelming the headline. */
.rail-score-rank {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-end;
  background: transparent;
  border: none;
  padding: 2px 0;
  font-family: inherit;
  font-size: 11px;
  font-feature-settings: "tnum";
  color: var(--blo-stone, #6b6560);
  letter-spacing: 0.02em;
  cursor: pointer;
  border-radius: 4px;
}
.rail-score-rank:hover {
  color: var(--blo-ink, #111);
  text-decoration: underline;
}
.rail-score-rank:focus-visible {
  outline: 2px solid var(--blo-green-deep, #1f7a2e);
  outline-offset: 2px;
}
.rail-score-rank-arrow {
  font-size: 10px;
  opacity: 0.7;
  transition: transform 120ms ease;
}
.rail-score-rank:hover .rail-score-rank-arrow {
  transform: translateX(2px);
  opacity: 1;
}

.rail-stats {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--blo-cream-divider, #e0d9ca);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  overflow: hidden;
}
.rail-stat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: white;
  font-size: 13px;
  gap: 12px;
  /* Phase 4f: subtle left border carries the good/bad signal without
     making the row feel "highlighted." Default neutral state has no border. */
  border-left: 3px solid transparent;
}
/* Comparison vs national average — color tinted from the BLO palette. */
.rail-stat--good {
  border-left-color: var(--blo-green-deep, #1f7a2e);
  background: linear-gradient(to right, rgba(31, 122, 46, 0.045), white 60%);
}
.rail-stat--bad {
  border-left-color: #c0392b;
  background: linear-gradient(to right, rgba(192, 57, 43, 0.045), white 60%);
}
.rail-stat-label {
  color: var(--blo-ink-soft, #2a2a2a);
}
.rail-stat-value {
  color: var(--blo-ink, #111);
  font-weight: 600;
  font-feature-settings: "tnum";
  text-align: right;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
/* Tiny pip beside the value — reinforces the row tint with a glance-readable dot. */
.rail-stat-pip {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex-shrink: 0;
}
.rail-stat--good .rail-stat-pip {
  background: var(--blo-green-deep, #1f7a2e);
}
.rail-stat--bad .rail-stat-pip {
  background: #c0392b;
}

.rail-details {
  align-self: flex-start;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}
.rail-details:hover {
  border-color: var(--blo-stone-soft, #9a948e);
}

/* Land-for-sale CTA — sits below the inspect details as the primary
   "act on this county" affordance. Solid green so it visually outweighs
   the secondary "View full details" link. */
.rail-land {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
}
.rail-land-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 9px 16px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: white;
  background: var(--blo-green-deep, #1f7a2e);
  border: none;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.rail-land-btn:hover:not(:disabled) {
  background: #196624;
}
.rail-land-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.rail-land-icon {
  font-size: 14px;
  line-height: 1;
}
.rail-land-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: white;
  border-radius: 50%;
  animation: rail-land-spin 0.7s linear infinite;
}
@keyframes rail-land-spin {
  to { transform: rotate(360deg); }
}
.rail-land-result,
.rail-land-empty {
  margin: 0;
  font-size: 11.5px;
  color: var(--blo-stone, #6b6560);
}
.rail-land-clear {
  margin-left: 8px;
  padding: 0;
  font: inherit;
  color: var(--blo-green-deep, #1f7a2e);
  background: transparent;
  border: none;
  text-decoration: underline;
  cursor: pointer;
}
.rail-land-clear:hover {
  color: #154e1e;
}
.rail-land-open {
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  background: transparent;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.rail-land-open:hover {
  color: #154e1e;
}
.rail-land-open-arrow {
  transition: transform 0.15s ease;
}
.rail-land-open:hover .rail-land-open-arrow {
  transform: translateX(2px);
}

/* ---- Listings view ---- */
.rail-listings-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}
.rail-listings-eyebrow {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}
.rail-listings-title {
  margin: 0;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 18px;
  font-weight: 600;
  color: var(--blo-ink, #111);
}
.rail-listings-sub {
  margin: 2px 0 0 0;
  font-size: 11.5px;
  color: var(--blo-stone, #6b6560);
}
.rail-listings-csv {
  padding: 0;
  margin-left: 4px;
  font: inherit;
  color: var(--blo-green-deep, #1f7a2e);
  background: transparent;
  border: none;
  text-decoration: underline;
  cursor: pointer;
}
.rail-listings-csv:hover {
  color: #154e1e;
}
.rail-listings-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  /* room for scrollbar */
  padding-right: 2px;
}
.rail-listing-card {
  display: flex;
  flex-direction: column;
  /* Don't let the flex parent squish each card — the list scrolls. */
  flex-shrink: 0;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  background: white;
  overflow: hidden;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.rail-listing-card:hover {
  border-color: var(--blo-green-deep, #1f7a2e);
  box-shadow: 0 1px 4px rgba(31, 122, 46, 0.08);
}
.rail-listing-card-btn {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 3px;
  padding: 10px 12px 8px;
  font: inherit;
  text-align: left;
  background: transparent;
  border: none;
  cursor: pointer;
}
.rail-listing-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.rail-listing-price {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  font-weight: 700;
  color: var(--blo-ink, #111);
  font-feature-settings: "tnum";
}
.rail-listing-days {
  font-size: 10.5px;
  color: var(--blo-stone, #6b6560);
  white-space: nowrap;
}
.rail-listing-address {
  font-size: 12px;
  color: var(--blo-ink-soft, #2a2a2a);
  line-height: 1.35;
}
.rail-listing-meta {
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
}
.rail-listing-links {
  display: flex;
  gap: 12px;
  padding: 6px 12px 9px;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
  background: var(--blo-cream, #f7f4ee);
}
.rail-listing-link {
  font-size: 11px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}
.rail-listing-link:hover {
  text-decoration: underline;
}

.rail-nav {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
}
.rail-nav-btn {
  flex: 1;
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  background: white;
  color: var(--blo-ink, #111);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  cursor: pointer;
}
.rail-nav-btn:hover:not(:disabled) {
  border-color: var(--blo-stone-soft, #9a948e);
}
.rail-nav-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.rail-nav-btn--primary {
  background: var(--blo-green-deep, #1f7a2e);
  color: white;
  border-color: var(--blo-green-deep, #1f7a2e);
}
.rail-nav-btn--primary:hover:not(:disabled) {
  background: var(--blo-ink, #111);
  border-color: var(--blo-ink, #111);
}

/* ============= Rank-view (swap-in inside the rail) ============= */

.rail-back {
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  color: var(--blo-stone, #6b6560);
  cursor: pointer;
  letter-spacing: 0.02em;
}
.rail-back:hover {
  color: var(--blo-ink, #111);
  border-color: var(--blo-stone-soft, #9a948e);
}

.rail-rank-titles {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}
.rail-rank-eyebrow {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}
.rail-rank-title {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 17px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  margin: 0;
  line-height: 1.2;
}
.rail-rank-sub {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
  font-feature-settings: "tnum";
}

.rail-rank-list {
  list-style: none;
  margin: 6px -16px -16px;
  padding: 4px 0 0;
  background: white;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
  flex: 1 1 auto;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.rail-rank-row { margin: 0; }
.rail-rank-row-btn {
  display: grid;
  grid-template-columns: 48px 1fr auto;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 16px;
  background: transparent;
  border: none;
  border-left: 3px solid transparent;
  cursor: pointer;
  font-family: inherit;
  font-feature-settings: "tnum";
}
.rail-rank-row-btn:hover {
  background: var(--blo-cream, #f7f4ee);
}
.rail-rank-row--current .rail-rank-row-btn {
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.10));
  border-left-color: var(--blo-green-deep, #1f7a2e);
}
.rail-rank-row-btn:focus-visible {
  outline: 2px solid var(--blo-green-deep, #1f7a2e);
  outline-offset: -3px;
}

.rail-rank-num {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rail-rank-row--current .rail-rank-num {
  color: var(--blo-green-deep, #1f7a2e);
}

.rail-rank-name {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.rail-rank-county {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail-rank-state {
  font-size: 10px;
  color: var(--blo-stone, #6b6560);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.rail-rank-score {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.rail-rank-score-unit {
  font-weight: 500;
  font-size: 10px;
  color: var(--blo-stone, #6b6560);
  margin-left: 1px;
}

@media (max-width: 768px) {
  .county-rail {
    top: auto;
    right: 8px;
    left: 8px;
    bottom: 8px;
    width: auto;
    max-height: 55vh;
  }
}
</style>
