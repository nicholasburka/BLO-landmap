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
      <span v-if="mode === 'walk'" class="rail-rank">
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

    <div class="rail-county">
      <h2 class="rail-county-name">{{ countyName }}</h2>
      <p v-if="stateName" class="rail-state">{{ stateName }}</p>
    </div>

    <div v-if="score != null" class="rail-score">
      <span class="rail-score-label">Composite score</span>
      <span class="rail-score-value">{{ score.toFixed(1) }}</span>
    </div>

    <ul v-if="stats.length > 0" class="rail-stats">
      <li v-for="stat in stats" :key="stat.layerId" class="rail-stat">
        <span class="rail-stat-label">{{ stat.name }}</span>
        <span class="rail-stat-value">{{ stat.value }}</span>
      </li>
    </ul>

    <button
      class="rail-details"
      type="button"
      @click="$emit('view-details')"
    >View full details ▸</button>

    <footer v-if="mode === 'walk'" class="rail-nav">
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
defineProps<{
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
  stats: { layerId: string; name: string; value: string }[]
}>()

defineEmits<{
  prev: []
  next: []
  exit: []
  'view-details': []
}>()
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
  align-items: baseline;
  justify-content: space-between;
  padding: 10px 12px;
  background: white;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
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
