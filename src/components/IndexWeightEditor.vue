<template>
  <!-- P9-6: drag a weight, watch the map move, keep the version you like.
       The scoring runs HERE — a full 3,144-county, 11-term recompute is about
       4ms, a quarter of a 60fps frame — so every change rescores immediately
       and nothing is written until a reader asks for it. The view is the
       sandbox; the set is the record. -->
  <section class="weights" data-testid="index-weight-editor">
    <h3 class="w-title">Weigh it differently</h3>

    <ul class="w-rows">
      <li v-for="t in rows" :key="t.layer" class="w-row" data-testid="weight-row">
        <span class="w-name">{{ t.name }}</span>
        <input
          type="range"
          min="0"
          :max="MAX_WEIGHT"
          step="1"
          :value="t.weight"
          :aria-label="`Weight for ${t.name}`"
          @input="setWeight(t.layer, Number(($event.target as HTMLInputElement).value))"
        />
        <span class="w-weight" :class="{ off: t.weight === 0 }">
          {{ t.weight === 0 ? 'out' : t.weight }}
        </span>
        <select
          class="w-dir"
          data-testid="weight-direction"
          :value="t.direction"
          :aria-label="`Direction for ${t.name}`"
          @change="setDirection(t.layer, ($event.target as HTMLSelectElement).value)"
        >
          <option value="higher_better">higher is better</option>
          <option value="lower_better">lower is better</option>
        </select>
      </li>
    </ul>

    <p class="w-save">
      <input
        type="text"
        class="w-name-input"
        data-testid="weight-name"
        placeholder="Name this version…"
        :value="label"
        @input="label = ($event.target as HTMLInputElement).value"
      />
      <button
        type="button"
        class="w-btn"
        data-testid="weight-save"
        :disabled="!canSave"
        @click="$emit('save', { label: label.trim(), terms: active })"
      >
        Save as an index
      </button>
      <button type="button" class="w-reset" data-testid="weight-reset" @click="reset">
        Reset
      </button>
    </p>
    <p v-if="active.length < 2" class="w-note">
      An index needs at least two layers — over one it is that layer rescaled.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

export interface WeightTerm {
  layer: string
  name: string
  weight: number
  direction: 'higher_better' | 'lower_better'
}

const props = defineProps<{ terms: WeightTerm[] }>()
const emit = defineEmits<{
  /** The live formula, on every change. Nothing is stored. */
  score: [terms: { layerId: string; weight: number; direction: string }[]]
  save: [input: { label: string; terms: WeightTerm[] }]
}>()

/** Matches the server's `COMPOSITE_WEIGHT_MAX`; weights are relative anyway. */
const MAX_WEIGHT = 10

const edited = ref<WeightTerm[]>([])
const label = ref('')

watch(() => props.terms, t => { edited.value = t.map(x => ({ ...x })) }, { immediate: true, deep: true })

const rows = computed(() => edited.value)

/** A term at zero is OUT of the index, not in it at nothing: the server
 *  refuses a zero weight, so the editor must not offer one that looks
 *  saveable. */
const active = computed(() => edited.value.filter(t => t.weight > 0))

const canSave = computed(() => !!label.value.trim() && active.value.length >= 2)

function publish(): void {
  emit('score', active.value.map(t => ({ layerId: t.layer, weight: t.weight, direction: t.direction })))
}

function setWeight(layer: string, weight: number): void {
  const t = edited.value.find(x => x.layer === layer)
  if (!t) return
  t.weight = Math.max(0, Math.min(MAX_WEIGHT, Math.round(weight)))
  publish()
}

function setDirection(layer: string, direction: string): void {
  const t = edited.value.find(x => x.layer === layer)
  if (!t || (direction !== 'higher_better' && direction !== 'lower_better')) return
  t.direction = direction
  publish()
}

function reset(): void {
  edited.value = props.terms.map(x => ({ ...x }))
  publish()
}
</script>

<style scoped>
.weights {
  margin: 1rem 0;
  padding-top: 0.75rem;
  border-top: 1px solid #e7e2da;
}
.w-title { margin: 0 0 0.5rem; font-size: 0.95rem; }
.w-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }
.w-row {
  display: grid;
  grid-template-columns: minmax(8rem, 1fr) 7rem 2.5rem auto;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.86rem;
}
.w-name { overflow-wrap: anywhere; }
.w-weight { font-variant-numeric: tabular-nums; color: #6b6560; }
.w-weight.off { color: #92400e; font-size: 0.78rem; }
.w-dir { font-size: 0.78rem; }
.w-save { display: flex; gap: 0.5rem; align-items: center; margin: 0.7rem 0 0; flex-wrap: wrap; }
.w-name-input { flex: 1 1 10rem; min-width: 0; }
.w-btn { cursor: pointer; }
.w-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.w-reset { background: none; border: none; color: #6b6560; cursor: pointer; font-size: 0.82rem; }
.w-note { margin: 0.4rem 0 0; color: #6b6560; font-size: 0.82rem; }
</style>
