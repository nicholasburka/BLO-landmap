<script setup lang="ts">
/**
 * A map block in a page (P7-4, spec §C.2 and §F.1).
 *
 * `WikiPageView` renders markdown and had no block that mounts a canvas, so a
 * data story could *link* to a map but never show one. A ```map:<view-slug>```
 * fence does: `renderWikiMarkdown` turns it into the same inert placeholder a
 * `view:` card gets, and `hydrateEmbeds` mounts this component into it.
 *
 * **A block names a VIEW, never a working set, and that is §F.1's rule rather
 * than a shortcut.** A set holds no framing — no viewport, no palette, no sort
 * — so there is nothing to show it *with* until a view supplies one; P7-2 hit
 * the same wall and put the two interfaces on `/views/:slug` for the same
 * reason. What a block therefore draws is:
 *
 *  - **an ad-hoc view** → its own saved map state, which is the whole of what
 *    it shows: layers with their weights, filters, limit, region, point
 *    overlays, and the viewport somebody chose;
 *  - **a set-backed view** → the SET's layers (it is the data, and what to draw
 *    is a question about the data — P7-2's own words) inside the VIEW's
 *    framing.
 *
 * So changing what a story shows is a view change, and changing what it is
 * about is a working-set change, exactly as §F.1 asks — and a story that wants
 * a second framing of the same data embeds a second view of the same set
 * rather than copying a number.
 *
 * **Reused, not rebuilt.** The breakpoint, the "narrowing closes it rather than
 * hiding a live WebGL context" rule and the open/close switch are `useMapPane`
 * (P6-14); the chrome and the lazy `MapCanvas` are `MapPane`; the state is
 * `useMapState`; reading the document is `mapStateOf` (`lib/views.ts`), which
 * the public map's own `?view=` restore now calls too. What is new here is the
 * degrading, which is most of the component: a block sits in somebody's prose,
 * so every way it can fail to be a map has to be a sentence.
 *
 * **It does not follow the reader down the page, deliberately.** `position:
 * sticky` cannot work for a pane here and the reason is structural, not a CSS
 * mistake: these route roots are viewport-height flex items of `App.vue`'s
 * `main`, so a sticky child's containing block is one screen tall. Making a
 * story map track the scroll means moving the scroll to the document, which the
 * public map's full-bleed canvas and every other route share. That is a change
 * to the shell, not to a page, and this ticket does not make it — see the DONE
 * note on P7-4. A block is placed where its argument is instead, and a page may
 * hold more than one.
 */
import { computed, onMounted, ref, watch } from 'vue'
import MapPane from '@/components/MapPane.vue'
import { useMapPane } from '@/composables/useMapPane'
import { useMapState } from '@/composables/useMapState'
import { isInternalLayerId } from '@/lib/internalLayers'
import { describesAMap, mapStateOf, viewOpenUrl, type SavedView } from '@/lib/views'
import { fetchWorkingSet, workingSetHref, type WorkingSetDetail } from '@/lib/workingSets'
import type { MapFitRequest } from '@/components/MapCanvas.vue'
// Type only, so this does not import the hydrator that dynamically imports
// this component. `preview` and `capped` are the host's call and arrive as a
// prop; "too narrow" is this block's own, read off `useMapPane` — all three
// land in the same card, because a reader does not care which it was, only
// what to do instead.
import type { MapBlockMode } from '@/lib/wikiEmbeds'

const props = withDefaults(
  defineProps<{
    /** The view this block embeds. Fetched by the hydrator, through the same
     *  per-slug cache a `view:` card uses — so a page carrying both a card and
     *  a map of one view asks for it once. */
    view: SavedView
    /** `preview` in the editor (a canvas per keystroke would burn through the
     *  browser's WebGL contexts); `capped` when the page already holds as many
     *  live maps as it may. */
    mode?: MapBlockMode
    /** How many live maps a page may hold, for the `capped` sentence. */
    limit?: number
  }>(),
  { mode: 'live', limit: 0 },
)

const pane = useMapPane()
const state = useMapState()

/** The set this view presents, when it presents one. Null for an ad-hoc view,
 *  which is permanent and first-class (§F.1) and must not look broken. */
const set = ref<WorkingSetDetail | null>(null)
/** The set is named but the library no longer has it — said, not swallowed. */
const setGone = ref(false)
/** False until the first pass has decided what this block is. Without it a
 *  block that is about to be a map flashes "the map is hidden" for a tick. */
const settled = ref(false)

/** The view's own state. Null when the slug names a table view or a
 *  comparison: those have no map in them, and `mapStateOf` says so rather than
 *  applying a table's county-context ids as if they were scoring layers. */
const saved = computed(() => mapStateOf(props.view))

/**
 * The layers to draw.
 *
 * The SET's when there is one — P7-2's rule, and the reason the two objects are
 * two objects: what to draw is a question about the data. The view's own when
 * there is no set, or when the set names none yet (a set is edited as sourcing
 * progresses, and a half-sourced set must not blank a page that was working).
 */
const layers = computed(() => {
  if (set.value?.layers.length) return set.value.layers.map(layerId => ({ layerId, weight: 5 }))
  return saved.value?.layers ?? []
})

const pointLayers = computed(() => saved.value?.pointLayers ?? [])

/** Whether there is a map in here at all. A view naming no layer and no point
 *  overlay draws an all-grey country, which reads as broken data where
 *  "this view names no map layer" points at the thing to fix (P6-23). */
const drawable = computed(() => (set.value?.layers.length ?? 0) > 0 || describesAMap(props.view))

/**
 * Where to put the map.
 *
 * The saved viewport first: it is the one part of a map view's state that is a
 * decision rather than a derivation, and a story framed on Memphis has to open
 * on Memphis. Failing that, the counties the view's own snapshot named — so a
 * view saved before viewports, or one saved without moving the map, still opens
 * on its answer instead of on the whole country.
 */
const fit = computed<MapFitRequest | null>(() => {
  const viewport = saved.value?.viewport
  if (viewport) return { center: viewport.center, zoom: viewport.zoom }
  const geoIds = props.view.results.map(result => result.geoId).filter(Boolean)
  return geoIds.length ? { geoIds } : null
})

/** The reader pressed Close. Remembered, so a resize does not undo a decision
 *  — but a resize on its own is not one, which is why re-opening below is
 *  gated on this and not on `isOpen`. */
const closedByReader = ref(false)

/** Only a live, wide-enough, drawable block mounts a canvas. */
const canDraw = computed(() => props.mode === 'live' && drawable.value && !!saved.value)

/**
 * Hand the view's state to this block's own map state.
 *
 * The manifest first when any id is an internal one: `apply` routes layer ids
 * against the registry, so an `internal-…` id applied before the manifest is in
 * is silently dropped (P5-18) — which is what makes a story map go blank.
 */
async function sync(): Promise<void> {
  const doc = saved.value
  if (!doc) return
  const ids = [...layers.value.map(layer => layer.layerId), ...pointLayers.value]
  if (ids.some(isInternalLayerId)) await state.loadInternalLayers()
  state.query.apply({
    layers: layers.value,
    filters: doc.filters,
    limit: doc.limit,
    regionStates: doc.regionStates,
    // A block draws the view, not a page's own rows: there is no table here to
    // narrow it, and an empty `only` means "the whole layer" to `query.only`.
    only: null,
  })
  state.setInternalFeatureLayers(pointLayers.value)
}

/**
 * The set this view presents, fetched at most once.
 *
 * Only ever called from a path that is about to draw: the editor's preview
 * re-mounts this component on every keystroke, and an un-cached request per
 * keystroke is exactly the hammering `wikiEmbeds`' own caches exist to avoid.
 */
let setRequest: Promise<void> | null = null
function ensureSet(): Promise<void> {
  const slug = props.view.workingSet ?? ''
  if (!slug) return Promise.resolve()
  setRequest ??= fetchWorkingSet(slug)
    .then(detail => {
      if (detail) set.value = detail
      else setGone.value = true
    })
    // A set that cannot be loaded is not a reason to show no map: the view's
    // own layers are still a map, and `setGone` says what happened.
    .catch(() => {
      setGone.value = true
    })
  return setRequest
}

/** Everything a live block does, in the one order that works: the set decides
 *  which layers get applied, the layers decide what the manifest has to hold,
 *  and only then is there something worth mounting a canvas for. */
async function draw(): Promise<void> {
  await ensureSet()
  await sync()
  if (!closedByReader.value) pane.open()
}

onMounted(async () => {
  try {
    if (canDraw.value) await draw()
  } finally {
    settled.value = true
  }
})

// A window that grows past the breakpoint gets the map it could not hold —
// unless the reader closed it. `useMapPane` owns the other direction
// (narrowing closes it, rather than leaving a canvas nobody can see running).
watch([pane.canOpen, canDraw], ([wide, drawing]) => {
  if (wide && drawing && !closedByReader.value && !pane.isOpen.value) void draw()
})

function close(): void {
  closedByReader.value = true
  pane.close()
}

function reopen(): void {
  closedByReader.value = false
  void draw()
}

/** What this map is of, in one line under its name. */
const note = computed(() => {
  const parts: string[] = []
  if (set.value) parts.push(`Over ${set.value.name}`)
  const count = layers.value.length
  if (count) parts.push(`${count} ${count === 1 ? 'layer' : 'layers'}`)
  const points = pointLayers.value.length
  if (points) parts.push(`${points} point ${points === 1 ? 'overlay' : 'overlays'}`)
  return parts.join(' · ')
})

/** Where "Open" goes: the full map for an ad-hoc view, the set's workspace for
 *  a set-backed one. `viewOpenUrl` already answers that for every kind. */
const openHref = computed(() => viewOpenUrl(props.view))

const openLabel = computed(() => (props.view.workingSet ? 'Open the working set →' : 'Open the full map →'))

/**
 * The sentence that stands in for a map, when one does not stand here.
 *
 * Empty while a canvas is mounting or mounted. Every branch names what to do
 * instead, because a block sits in somebody's argument and a silent gap there
 * is worse than a short sentence.
 */
const standin = computed(() => {
  if (!saved.value) {
    const kind = props.view.type === 'table' ? 'table view' : 'saved comparison'
    return `“${props.view.name}” is a ${kind}, so there is no map in it to draw.`
  }
  if (!drawable.value) return `“${props.view.name}” names no map layer, so there is nothing to draw yet.`
  if (props.mode === 'preview') {
    return `A map of “${props.view.name}”. It draws on the page itself — the preview does not mount a canvas.`
  }
  if (props.mode === 'capped') {
    return `This page already draws ${props.limit} ${props.limit === 1 ? 'map' : 'maps'}, which is as many as one page holds.`
  }
  if (!pane.canOpen.value) return 'There is not room for a map here.'
  return ''
})
</script>

<template>
  <div class="wiki-map-block" data-testid="wiki-map-block" :data-map-state="pane.isOpen.value ? 'live' : 'standin'">
    <!-- A live canvas. `v-if`, never `v-show`: an unmounted pane is what keeps
         a reader who closed it from holding a WebGL context, and what keeps a
         page whose block cannot draw from downloading a county file at all. -->
    <MapPane
      v-if="pane.isOpen.value"
      class="block-pane"
      testid="wiki-map-pane"
      :layers="state.layers"
      :query="state.query"
      :data="state.data"
      :fit="fit"
      :title="view.name"
      :note="note"
      :label="`${view.name} on the map`"
      close-label="Hide this map"
      @close="close"
    />

    <p v-else-if="standin" class="block-standin" data-testid="wiki-map-standin">
      {{ standin }}
      <a :href="openHref" class="block-link">{{ openLabel }}</a>
    </p>

    <p v-else-if="!settled" class="block-standin" data-testid="wiki-map-opening">Opening the map…</p>

    <!-- Closed by the reader, on a screen that could hold it: offer it back. -->
    <p v-else class="block-standin" data-testid="wiki-map-hidden">
      The map of “{{ view.name }}” is hidden.
      <button type="button" class="block-show" data-testid="wiki-map-show" @click="reopen">Show it</button>
    </p>

    <p v-if="setGone" class="block-standin warn" data-testid="wiki-map-set-gone">
      This view presents a working set called “{{ view.workingSet }}”, and the library does not have one by that name
      any more — so this map draws the view's own layers.
    </p>

    <p v-if="pane.isOpen.value" class="block-foot">
      <a v-if="set" :href="workingSetHref(set.slug)" class="block-link">{{ set.name }}</a>
      <a :href="openHref" class="block-link">{{ openLabel }}</a>
    </p>
  </div>
</template>

<style scoped>
.wiki-map-block {
  margin: 18px 0;
}

/* A map in prose takes a readable band, not a screen: the reader is reading,
   and the full map is one link away. */
.block-pane {
  height: min(60vh, 520px);
}

.block-standin {
  margin: 0;
  padding: 12px 14px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  background: var(--blo-cream, #fbf8f1);
}

.block-standin.warn {
  margin-top: 8px;
  color: var(--blo-ink-soft, #5c564e);
}

.block-foot {
  display: flex;
  gap: 12px;
  margin: 8px 0 0;
  font-size: 13px;
}

.block-link {
  color: var(--blo-green-deep, #1f4332);
  font-weight: 600;
  text-decoration: none;
}

.block-link:hover {
  text-decoration: underline;
}

.block-show {
  padding: 2px 8px;
  font: inherit;
  font-size: 13px;
  color: var(--blo-ink, #111);
  background: transparent;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  cursor: pointer;
}
</style>
