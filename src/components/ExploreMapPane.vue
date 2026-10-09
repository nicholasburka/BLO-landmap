<template>
  <section class="explore" data-testid="explore-map">
    <template v-if="pane.isOpen.value">
      <MapPane
        class="explore-pane"
        testid="explore-pane"
        :layers="state.layers"
        :query="state.query"
        :data="state.data"
        title="Everything we can draw"
        :note="paneNote"
        label="Explore the library on a map"
        @close="close"
      >
        <template #overlay>
          <SetLayerList v-if="choices.length" :layers="state.layers" :ids="choices" />
        </template>
      </MapPane>

      <!-- The point of the pane: a combination worth keeping becomes the
           object the rest of phase 9 already knows how to weigh and map. -->
      <form class="explore-save" data-testid="explore-save" @submit.prevent="save">
        <p v-if="!chosen.length" class="explore-note" data-testid="explore-empty">
          Nothing is switched on yet. Turn on the layers you want to look at together —
          then they can be kept as a working set.
        </p>
        <template v-else>
          <p class="explore-note" data-testid="explore-chosen">
            {{ chosen.length }} {{ chosen.length === 1 ? 'layer' : 'layers' }} on:
            {{ chosenNames }}
          </p>
          <p class="explore-row">
            <label class="explore-label" for="explore-set-name">Keep these as a working set called</label>
            <input
              id="explore-set-name"
              v-model="name"
              type="text"
              class="explore-input"
              maxlength="120"
              placeholder="Sites and what bears on them"
              data-testid="explore-name"
            />
            <button type="submit" class="explore-btn" :disabled="!canSave" data-testid="explore-create">
              {{ saving ? 'Making it…' : 'Make the set' }}
            </button>
          </p>
          <p v-if="!name.trim()" class="explore-note" data-testid="explore-why">
            Give it a name and it becomes a set you can weigh, compare and come back to.
          </p>
        </template>
        <p v-if="error" class="explore-note error" data-testid="explore-error">{{ error }}</p>
        <p v-if="made" class="explore-note done" data-testid="explore-made">
          Made it.
          <RouterLink :to="workingSetHref(made.slug)">Open {{ made.name }}</RouterLink>
        </p>
      </form>
    </template>

    <!-- A map beside a page wants a desktop (P6-14). The link that was here
         before this ticket is still the answer on a phone. -->
    <p v-else class="explore-note" data-testid="explore-too-narrow">
      There is not room for a map here.
      <RouterLink to="/">Open the full map</RouterLink>.
    </p>
  </section>
</template>

<script setup lang="ts">
/**
 * Play with every layer we can draw, and keep the combination (P9-12).
 *
 * The "Show on map" tool used to be `href: '/'` — it navigated away to the
 * public map and whatever the reader turned on there was lost to this page.
 * This opens the pane in place instead, lists everything drawable, and turns
 * a selection into a WORKING SET.
 *
 * That last part is the point. P9-0 through P9-11 all assume a set exists;
 * the only ways to get one were the API and a promotion flow. This is the
 * direction where playing with the data produces the set.
 *
 * **Everything starts off.** A picker that pre-selects has already made the
 * choice the reader came to make, and with ~30 layers drawable it would also
 * paint an unreadable map.
 */
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import MapPane from '@/components/MapPane.vue'
import SetLayerList from '@/components/SetLayerList.vue'
import { useMapPane } from '@/composables/useMapPane'
import { useMapState } from '@/composables/useMapState'
import { createWorkingSet, workingSetHref } from '@/lib/workingSets'
import { friendlyError } from '@/lib/errors'
import { LAYER_REGISTRY } from '@/config/layerRegistry'
import {
  DEMOGRAPHIC_LAYERS,
  ECONOMIC_LAYERS,
  HOUSING_LAYERS,
  EQUITY_LAYERS,
  TRANSPORTATION_LAYERS,
} from '@/config/layerConfig'

const emit = defineEmits<{ close: [] }>()

/** The public map's own layers, in the order it lists them. */
const PUBLIC_IDS = [
  ...DEMOGRAPHIC_LAYERS,
  ...ECONOMIC_LAYERS,
  ...HOUSING_LAYERS,
  ...EQUITY_LAYERS,
  ...TRANSPORTATION_LAYERS,
].map(l => l.id)

const name = ref('')
const saving = ref(false)
const error = ref('')
const made = ref<{ slug: string; name: string } | null>(null)

/**
 * What the reader has switched on, read off the map's own state rather than
 * kept beside it — so the list and the canvas cannot disagree about what is
 * drawn.
 *
 * `state` is assigned a line after the map is built, and is null until then,
 * because `useShowOnMap` evaluates this getter once WHILE it is constructing
 * (its watcher reads the sources to capture their initial values). Touching
 * `map` from in here before that returns would be a temporal-dead-zone throw
 * during setup, which is exactly what it was.
 */
/**
 * The map's own state, driven the way the PUBLIC map drives it — the layer
 * list toggles `state.layers` and the canvas reacts. No `useShowOnMap`.
 *
 * That composable exists to push a *page's* selection into a map, and here
 * the map's selection IS the page's: feeding it back in made a cycle, because
 * its `apply()` rewrites the very arrays the getter reads. Vue caught it as
 * "maximum recursive updates exceeded", and the throw aborted the remaining
 * mount hooks — including the media query's, so the pane decided it was on a
 * phone and never opened. The fix is not a cleverer getter; it is not having
 * a loop.
 */
const state = useMapState()
const pane = useMapPane()

const chosen = computed<string[]>(() => [
  ...state.layers.internal.value,
  ...state.layers.points.value,
  ...state.layers.demographic.value,
  ...state.layers.economic.value,
  ...state.layers.housing.value,
  ...state.layers.equity.value,
  ...state.layers.transportation.value,
])

/** Everything drawable, internal first: the library's own layers are the
 *  reason somebody is on this page rather than on the public map. */
const choices = computed(() => [
  ...state.layers.internalDefinitions.value.map(d => d.id),
  ...state.layers.pointDefinitions.value.map(d => d.id),
  ...PUBLIC_IDS.filter(id => !!LAYER_REGISTRY[id]),
])

const nameOf = (id: string) =>
  state.layers.internalDefinitions.value.find(d => d.id === id)?.name ??
  state.layers.pointDefinitions.value.find(d => d.id === id)?.name ??
  LAYER_REGISTRY[id]?.name ??
  id

const chosenNames = computed(() => chosen.value.map(nameOf).join(', '))

const paneNote = computed(() =>
  chosen.value.length
    ? `${chosen.value.length} of ${choices.value.length} layers on`
    : `${choices.value.length} layers to choose from`,
)

const canSave = computed(() => !!name.value.trim() && chosen.value.length > 0 && !saving.value)

onMounted(() => {
  // Everything OFF. `useMapState` starts on the public map's default — the
  // BLO Livability Index — which is right for `/` and wrong here: a picker
  // that arrives pre-selected has already made the choice the reader opened
  // it to make, and the first thing they would have to do is find and undo it.
  state.layers.demographic.value = []
  state.layers.economic.value = []
  state.layers.housing.value = []
  state.layers.equity.value = []
  state.layers.transportation.value = []
  state.layers.internal.value = []
  state.layers.points.value = []
  if (state.layers.contaminationChoropleth.value) state.layers.toggle.contaminationChoropleth()

  pane.open()
  // The manifest is what turns ids into names and geometries, and the list
  // is the whole feature — so it is loaded whether or not anything is drawn.
  void state.loadInternalLayers()
})

function close(): void {
  pane.close()
  emit('close')
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  error.value = ''
  try {
    // Layers only: a set made here is a selection of things to draw. Its
    // datasets, its anchor and its derived columns come later, on the set's
    // own page, where there is room to say what they are.
    made.value = await createWorkingSet({ name: name.value.trim(), layers: [...chosen.value] })
    name.value = ''
  } catch (err) {
    error.value = friendlyError(err, 'That set could not be made.')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.explore {
  margin: 12px 0 20px;
}

.explore-pane {
  height: 520px;
}

.explore-save {
  margin-top: 10px;
}

.explore-note {
  margin: 4px 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.explore-note.error {
  color: var(--blo-orange-deep, #e65100);
}

.explore-note.done {
  color: var(--blo-ink);
}

.explore-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
}

.explore-label {
  font-size: 13px;
  color: var(--blo-stone);
}

.explore-input {
  flex: 1 1 16rem;
  min-width: 0;
  font: inherit;
  font-size: 13px;
  padding: 4px 8px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
}

.explore-btn {
  font: inherit;
  font-size: 13px;
  padding: 4px 12px;
  cursor: pointer;
}

.explore-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
