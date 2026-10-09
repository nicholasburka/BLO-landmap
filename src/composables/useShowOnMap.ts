/**
 * "Show on map", in place (P6-14).
 *
 * The button used to be a link to `/?layers=…&fit=…`, which lost two things
 * at once: the page you were reading, and the rows you were reading on it. A
 * URL can say *which layer* and *where to look*; it has no way to say *this
 * subset*. `query.only` does (P6-10) — set, it **is** the answer: the counties
 * in it stay saturated, everything else dims, and the frame follows them.
 *
 * So a page offering a submap has to say three things, and they are the same
 * three everywhere: which layers it is showing, which of its own rows are the
 * answer, and where to put the map. This takes them as getters — read off
 * whatever the page already has on screen — and keeps the map matching them
 * for as long as the pane is open. Filter the table, turn a page, toggle a
 * layer: the map follows, because it is a view of the page and not a copy of
 * it.
 *
 * The chrome is `MapPane.vue`; the open/close switch is `useMapPane`. This is
 * the wiring between a page's selection and a map's state.
 *
 *   const shown = computed(() => rows.value.map(r => r.geoId))
 *   const map = useShowOnMap({
 *     layers: () => [layer.value.id],
 *     only: () => shown.value,
 *   })
 *   // template: <button @click="map.open()"> and
 *   //           <MapPane v-if="map.isOpen.value" :layers="map.state.layers" …>
 */
import { computed, ref, watch, type ComputedRef } from 'vue'
import { useMapPane, type MapPaneToggle } from '@/composables/useMapPane'
import { useMapState, type MapState } from '@/composables/useMapState'
import { isInternalLayerId } from '@/lib/internalLayers'
import { boundsForFeatures } from '@/lib/internalFeatureLayers'
import type { MapFitRequest } from '@/components/MapCanvas.vue'
import type { ScoringQueryLayer } from '@/types/mapTypes'

/**
 * What a page is showing. Every field is a getter so this reads the page's
 * live state rather than a snapshot; pass `computed`s (or getters over them)
 * so an unchanged selection stays referentially stable and does not re-apply
 * on every tick.
 */
export interface MapSelection {
  /** Layer ids on screen — public ids, `internal-…` county layers, or
   *  `internal-…` point layers, in any mix. */
  layers: () => string[]
  /**
   * The GEOIDs of this page's own rows: the subset the map draws as the
   * answer. `null` (or an empty array) means "the whole layer" — which is the
   * right answer for a page that is not narrowing anything, and the only
   * answer for a page whose rows are not counties.
   */
  only?: () => string[] | null
  /**
   * P9-6a: how much each scored layer counts, when the page is previewing a
   * FORMULA rather than naming layers.
   *
   * Absent (or null) is the default and the common case: every county layer
   * the page names counts the same, because a page that names three layers is
   * asking to see them, not proposing a weighting. A page that *is* proposing
   * one — the weight editor — supplies its terms here, and the choropleth is
   * that formula rather than an average of its ingredients.
   *
   * It supplies weights only. Which ids are scorable at all stays with the
   * geometry dispatch in `apply`, so a formula cannot talk the canvas into
   * scoring a line layer; a scored id this does not mention keeps the equal
   * weight.
   */
  weights?: () => ScoringQueryLayer[] | null
  /** Where to put the map. Defaults to framing `only`, then a point layer's
   *  own extent. */
  fit?: () => MapFitRequest | null
}

export interface ShowOnMap extends MapPaneToggle {
  /** This pane's map state — the two objects `MapPane` takes as props. */
  state: MapState
  /** What the canvas should frame, as `MapPane`'s `fit` prop. */
  fit: ComputedRef<MapFitRequest | null>
  /** Hand the page's current selection to the map. Called for you. */
  sync: () => Promise<void>
}

export function useShowOnMap(selection: MapSelection): ShowOnMap {
  const state = useMapState()
  const pane = useMapPane()

  /** A point layer's own extent, once its features have landed. */
  const pointFit = ref<MapFitRequest | null>(null)

  /** The part that needs nothing fetched, so the pane's first paint already
   *  names the right layer instead of flashing the default. */
  function apply(): void {
    const ids = selection.layers()
    // P9-1: dispatch on the layer's DECLARED geometry, never on "is it a
    // point". A drawn geometry — point, line or state — has its own source and
    // its own markers; a COUNTY layer is a column of numbers and is the only
    // kind that can be a scoring term.
    //
    // The old split asked only "is this a known point layer", and scored
    // everything else at weight 5. A line layer is not a point, so a working
    // set's transmission lines were scored as though they were county metrics:
    // the set's map drew a choropleth with no legend instead of the set's own
    // layers, and P7-3's line geometry had no branch here at all.
    //
    // An internal id the manifest has not described yet is **held back**, not
    // guessed at. `apply()` runs once before the manifest lands — that is the
    // point of it, so the first paint names the right layer — and the old
    // default for "unknown" was *score it*, which is how the wrong thing got
    // drawn. A public registry id needs no manifest and is scorable at once.
    const drawnIds = new Set(state.layers.pointDefinitions.value.map(d => d.id))
    const countyIds = new Set(state.layers.internalDefinitions.value.map(d => d.id))
    const points: string[] = []
    const scorable: string[] = []
    for (const id of ids) {
      if (drawnIds.has(id)) points.push(id)
      else if (countyIds.has(id)) scorable.push(id)
      else if (!isInternalLayerId(id)) scorable.push(id)
      // else: internal, unclassified — wait for the manifest rather than guess
    }
    const only = selection.only?.() ?? null
    // P9-6a: a declared weight wins over the equal default, per layer.
    const weights = new Map((selection.weights?.() ?? []).map(term => [term.layerId, term]))
    state.query.apply({
      layers: scorable.map(layerId => weights.get(layerId) ?? { layerId, weight: 5 }),
      only: only && only.length ? only : null,
      // A page's own rows are the subset; "top N of them" is a question the
      // map asks, not one a table that is already showing them asks.
      limit: null,
      filters: [],
      regionStates: [],
    })
    state.setInternalFeatureLayers(points)
  }

  /** The whole selection, including the parts that need the network: an
   *  `internal-…` id resolves against the manifest, and a point layer's
   *  extent against its features. */
  async function sync(): Promise<void> {
    if (selection.layers().some(isInternalLayerId)) await state.loadInternalLayers()
    apply()
    if (selection.fit) return
    const [firstPoint] = state.layers.points.value
    if (!firstPoint) {
      pointFit.value = null
      return
    }
    const collection = await state.waitForPointData(firstPoint)
    const bbox = collection ? boundsForFeatures(collection.features) : null
    pointFit.value = bbox ? { bbox } : null
  }

  function open(): void {
    pane.open()
    // `isOpen` stays false on a phone, where today's link stands instead.
    if (pane.isOpen.value) apply()
  }

  function toggle(): void {
    if (pane.isOpen.value) pane.close()
    else open()
  }

  // P9-1: when the manifest lands, the classification above changes, so the
  // drawn set has to be recomputed. Watching the definitions makes that a
  // consequence of the data arriving rather than of `sync()` happening to run
  // its second `apply()` — which is the ordering that failed in practice.
  watch(
    [() => state.layers.pointDefinitions.value, () => state.layers.internalDefinitions.value],
    () => {
      if (pane.isOpen.value) apply()
    },
  )

  // While it is open the pane is a live view of the page, not a snapshot of
  // the moment it was opened. Opening it runs this too, which is where the
  // manifest-dependent half of `sync()` happens.
  watch(
    [
      pane.isOpen,
      () => selection.layers(),
      () => selection.only?.() ?? null,
      // P9-6a: dragging a weight changes neither the layers nor the subset, so
      // without this the canvas would keep painting the formula it opened with.
      () => selection.weights?.() ?? null,
    ],
    () => {
      if (pane.isOpen.value) void sync()
    },
  )

  /** The page's own frame wins; then a point layer's extent; then the subset
   *  the page is showing. Null leaves the viewport where it is. */
  const fit = computed<MapFitRequest | null>(() => {
    if (selection.fit) return selection.fit()
    if (pointFit.value) return pointFit.value
    const geoIds = selection.only?.() ?? null
    return geoIds && geoIds.length ? { geoIds } : null
  })

  return { ...pane, open, toggle, state, fit, sync }
}
