<template>
  <!-- P9-11: find a place, and say what THIS SET holds there. A map search
       that only moves the map is a map search; the readout under it is what
       makes it a search "within the context of the data". -->
  <section class="addr blo-panel blo-panel--reference" data-testid="map-address-search">
    <label class="addr-label" for="map-address-input">Find an address</label>
    <input
      id="map-address-input"
      ref="box"
      type="search"
      class="addr-input"
      placeholder="Street, city or ZIP"
      autocomplete="off"
      :value="query"
      data-testid="address-input"
      @input="onInput(($event.target as HTMLInputElement).value)"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="choose(hits[active])"
      @keydown.esc="hits = []"
    />

    <ul v-if="hits.length" class="addr-hits" role="listbox" data-testid="address-hits">
      <li v-for="(hit, i) in hits" :key="hit.name">
        <button
          type="button"
          class="addr-hit"
          :class="{ active: i === active }"
          role="option"
          :aria-selected="i === active"
          data-testid="address-hit"
          @click="choose(hit)"
        >{{ hit.name }}</button>
      </li>
    </ul>

    <p v-if="searching" class="addr-note" data-testid="address-searching">Looking…</p>
    <p v-else-if="noneFound" class="addr-note" data-testid="address-none">Nothing found for that.</p>

    <!-- What the set says about where you landed. -->
    <div v-if="found" class="addr-found" data-testid="address-found">
      <p class="addr-place">{{ found.name }}</p>
      <p v-if="!found.geoId" class="addr-note" data-testid="address-no-county">
        That point is not in any county this map draws.
      </p>
      <template v-else>
        <p class="addr-county" data-testid="address-county">{{ countyLabel }}</p>
        <dl class="addr-values" data-testid="address-values">
          <template v-for="row in here" :key="row.id">
            <dt>{{ row.name }}</dt>
            <dd :class="{ blank: row.value === null }">
              {{ row.value === null ? 'no number here' : readable(row.value) }}
            </dd>
          </template>
        </dl>
      </template>
      <button type="button" class="addr-clear" data-testid="address-clear" @click="clear">Clear</button>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * An address search over a set's map (P9-11).
 *
 * The component owns the typing, the debounce and the suggestion list. It
 * does NOT own what a hit means: the host says which county a point is in
 * and what its layers hold there, because that is the set's business and
 * this box is reusable without it.
 */
import { ref } from 'vue'
import { readable } from '@/lib/layerStats'
import { DEBOUNCE_MS, MIN_QUERY, cachedAddresses, suggestAddresses, type AddressHit } from '@/lib/addressSearch'

const props = defineProps<{
  /** Where a point lands and what is known there. Null county means the
   *  point is outside everything this map draws. */
  resolve: (center: [number, number]) => {
    geoId: string | null
    countyLabel: string
    values: { id: string; name: string; value: number | null }[]
  }
}>()

const emit = defineEmits<{
  /** Go here. `[lng, lat]`, plus the county if there is one. */
  found: [place: { center: [number, number]; geoId: string | null }]
  cleared: []
}>()

const query = ref('')
const hits = ref<AddressHit[]>([])
const active = ref(0)
const searching = ref(false)
const noneFound = ref(false)
const found = ref<{ name: string; geoId: string | null } | null>(null)

const countyLabel = ref('')
const here = ref<{ id: string; name: string; value: number | null }[]>([])

let timer: ReturnType<typeof setTimeout> | undefined
let inFlight: AbortController | undefined

function onInput(value: string): void {
  query.value = value
  found.value = null
  noneFound.value = false
  active.value = 0
  clearTimeout(timer)
  inFlight?.abort()

  if (value.trim().length < MIN_QUERY) {
    hits.value = []
    searching.value = false
    return
  }
  // Already known: answer in this frame and spend nothing.
  const known = cachedAddresses(value)
  if (known) {
    hits.value = known
    noneFound.value = known.length === 0
    searching.value = false
    return
  }
  searching.value = true
  timer = setTimeout(async () => {
    inFlight = new AbortController()
    const results = await suggestAddresses(value, inFlight.signal)
    // A later keystroke has already moved on; this answer is stale.
    if (query.value !== value) return
    hits.value = results
    noneFound.value = results.length === 0
    searching.value = false
  }, DEBOUNCE_MS)
}

function move(by: number): void {
  if (!hits.value.length) return
  active.value = (active.value + by + hits.value.length) % hits.value.length
}

function choose(hit: AddressHit | undefined): void {
  if (!hit) return
  const where = props.resolve(hit.center)
  query.value = hit.name
  hits.value = []
  searching.value = false
  found.value = { name: hit.name, geoId: where.geoId }
  countyLabel.value = where.countyLabel
  here.value = where.values
  emit('found', { center: hit.center, geoId: where.geoId })
}

function clear(): void {
  query.value = ''
  hits.value = []
  found.value = null
  noneFound.value = false
  emit('cleared')
}

/** The host clears the search when the map moves for another reason. */
defineExpose({ clear })
const box = ref<HTMLInputElement | null>(null)
</script>

<style scoped>
.addr {
  padding: 8px 10px;
  margin-top: 8px;
}
.addr-label {
  display: block;
  margin-bottom: 4px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
}
.addr-input {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  font-size: 0.82rem;
  padding: 4px 6px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
}
.addr-hits {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  max-height: 11rem;
  overflow-y: auto;
}
.addr-hit {
  display: block;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 0.78rem;
  padding: 4px 6px;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}
.addr-hit:hover,
.addr-hit.active {
  background: rgba(31, 122, 46, 0.12);
}
.addr-note {
  margin: 4px 0 0;
  font-size: 0.76rem;
  color: var(--blo-stone, #6b6560);
}
.addr-found {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
}
.addr-place {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
}
.addr-county {
  margin: 2px 0 4px;
  font-size: 0.76rem;
  color: var(--blo-stone, #6b6560);
}
.addr-values {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1px 8px;
  margin: 0;
  font-size: 0.76rem;
}
.addr-values dt {
  overflow-wrap: anywhere;
}
.addr-values dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.addr-values dd.blank {
  color: var(--blo-stone, #6b6560);
}
.addr-clear {
  margin-top: 6px;
  font: inherit;
  font-size: 0.76rem;
  background: none;
  border: none;
  padding: 0;
  color: var(--blo-stone, #6b6560);
  text-decoration: underline;
  cursor: pointer;
}
</style>
