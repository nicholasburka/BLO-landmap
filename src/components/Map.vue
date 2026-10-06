<template>
  <div id="map" class="map-root">
    <!-- P6-10: the map itself. First in the DOM, absolutely positioned and
         filling `.map-root`, so every panel below paints over it exactly as
         it did when this element *was* the Mapbox container. Everything the
         chrome does to the map goes through `canvas` — the chat page mounts
         the same component on its own, with no chrome at all. -->
    <MapCanvas
      ref="canvas"
      :layers="layerState"
      :query="queryState"
      :data="data"
      :hover-tooltip="!inspectActive && !walkthroughActive"
      expose-handle
      @ready="onCanvasReady"
      @counties-ready="onCountiesReady"
      @county-click="onCountyClick"
    />

    <!-- Phase 4c: the dedicated geocoder input is gone. Place lookup now
         lives inline inside the Ask input via `PromptInput`'s suggestion
         strip — one visible input, two intents auto-detected.
         The "Find land for sale" CTA is now a contextual action inside
         CountyRail (below) rather than a floating top-left button — the
         rail is the canonical place for county-scoped actions. -->

    <PromptInput
      :messages="chat.messages.value"
      :is-thinking="chat.isThinking.value"
      :chat-error="chat.error.value"
      :active-turn-index="chat.activeTurnIndex.value"
      :send-message="chat.sendMessage"
      :clear-conversation="clearActiveQuery"
      :rewind-to-turn="chat.rewindToTurn"
      @select-place="handlePlaceSelection"
    />

    <!-- The floating "Available Properties" panel is gone — its content
         now lives inside CountyRail's third view (listings), opened from
         the "view N listings" link under the Find land CTA. The map
         markers (blue pins) remain as the spatial visualization. -->

    <!-- Phase 4d L4: standalone LayerControls pill removed.
         Layer picking now lives inside the Lens "Layers" tab.
         P6-10: the loading overlay moved into MapCanvas — it reports the
         canvas's own two county files, wherever that canvas is. -->

    <CountyModal
      :show="showDetailedPopup"
      :county-id="currentCounty?.id || ''"
      :county-name="currentCounty?.name || ''"
      :diversity-data="currentCounty?.id ? diversityData[currentCounty.id] : undefined"
      :contamination-data="currentCounty?.id ? countyContaminationCounts[currentCounty.id] : undefined"
      :life-expectancy="currentCounty?.id ? lifeExpectancyData[currentCounty.id]?.lifeExpectancy : undefined"
      :combined-score="currentCounty?.id ? combinedScoresData[currentCounty.id] : undefined"
      :combined-score-v2="currentCounty?.id ? combinedScoresV2Data[currentCounty.id] : undefined"
      :economic-data="currentCounty?.id ? economicData[currentCounty.id] : undefined"
      :housing-data="currentCounty?.id ? housingData[currentCounty.id] : undefined"
      :equity-data="currentCounty?.id ? equityData[currentCounty.id] : undefined"
      :transportation-data="currentCounty?.id ? transportationData[currentCounty.id] : undefined"
      :walkthrough-active="false"
      :walkthrough-index="0"
      :walkthrough-total="0"
      :co-rail="walkthroughActive"
      @close="handleModalClose"
    />

    <!-- Phase 4f: one-time welcome card explaining the BLO Livability
         Index. Auto-dismisses on click and via localStorage. -->
    <WelcomeCard />

    <!-- Phase 4d: the Lens — single primary surface for "what does this
         map mean right now?" Replaces ColorLegend, AveragesPanel, and
         the standalone Data Layers pill. -->
    <Lens :actions="!!internalUser">
      <!-- P5-16 / P5-74: save the current map+query state as a named library
           view. Internal users only, and now a row of the panel rather than a
           floating control that sat on top of it. -->
      <template #actions>
        <div class="save-view-row">
          <button v-if="!saveViewOpen" class="save-view-toggle" data-testid="save-view" @click="openSaveView">
            Save view
          </button>
          <form v-else class="save-view-form" @submit.prevent="submitSaveView">
            <input
              v-model="saveViewName"
              class="save-view-name"
              type="text"
              placeholder="Name this view"
              maxlength="80"
              :disabled="saveViewSaving"
            />
            <button
              type="submit"
              class="save-view-save"
              :disabled="saveViewSaving || !saveViewName.trim()"
            >
              {{ saveViewSaving ? "Saving…" : "Save" }}
            </button>
            <button
              type="button"
              class="save-view-cancel"
              :disabled="saveViewSaving"
              @click="closeSaveView"
            >
              ✕
            </button>
          </form>
          <span v-if="saveViewNote" class="save-view-note">
            <RouterLink v-if="savedViewSlug" :to="`/views/${savedViewSlug}`" class="save-view-link">{{ saveViewNote }}</RouterLink>
            <template v-else>{{ saveViewNote }}</template>
          </span>
          <span v-if="saveViewError" class="save-view-note save-view-error">{{ saveViewError }}</span>
        </div>
      </template>
      <template #header>
        <LensHeader
          :scoring-chips="scoringChips"
          :active-filters="activeFilters"
          :limit="activeLimit"
          :default-layer-name="defaultLensLayerName"
          :can-walk-through="canWalkThrough"
          @clear="clearActiveQuery"
          @walk-through="startWalkthrough"
        />
      </template>
      <template #legend>
        <LensLegend
          :selected-demographic-layers="selectedDemographicLayers"
          :selected-economic-layers="selectedEconomicLayers"
          :selected-housing-layers="selectedHousingLayers"
          :selected-equity-layers="selectedEquityLayers"
          :selected-transportation-layers="selectedTransportationLayers"
          :selected-internal-layers="selectedInternalLayers"
          :show-contamination-choropleth="showContaminationChoropleth"
          :layer-directions="layerDirections"
          :layer-weights="layerWeights"
          :has-active-filters="activeFilters.length > 0"
        />
      </template>
      <template #layers>
        <LensLayers
          :demographic-layers="demographicLayers"
          :economic-layers="economicLayers"
          :housing-layers="housingLayers"
          :equity-layers="equityLayers"
          :transportation-layers="transportationLayers"
          :contamination-layers="contaminationLayers"
          :selected-demographic-layers="selectedDemographicLayers"
          :selected-economic-layers="selectedEconomicLayers"
          :selected-housing-layers="selectedHousingLayers"
          :selected-equity-layers="selectedEquityLayers"
          :selected-transportation-layers="selectedTransportationLayers"
          :internal-layers="internalLayers"
          :internal-point-layers="internalPointLayers"
          :selected-internal-layers="selectedInternalLayers"
          :selected-internal-feature-layers="selectedInternalFeatureLayers"
          :show-contamination-layers="showContaminationLayers"
          :show-contamination-choropleth="showContaminationChoropleth"
          :dev-mode-only="DEV_MODE_DEMOGRAPHICS_ONLY"
          :show-scoring-controls="showScoringControls"
          :layer-weights="layerWeights"
          :layer-directions="layerDirections"
          :active-filters="activeFilters"
          @toggle-demographic="toggleDemographicLayer"
          @toggle-economic="toggleEconomicLayer"
          @toggle-housing="toggleHousingLayer"
          @toggle-equity="toggleEquityLayer"
          @toggle-transportation="toggleTransportationLayer"
          @toggle-internal="toggleInternalLayer"
          @toggle-internal-point="toggleInternalFeatureLayer"
          @toggle-contamination="toggleContaminationLayer"
          @retry-contamination="retryContaminationLayer"
          @toggle-contamination-layers="toggleContaminationLayers"
          @toggle-contamination-choropleth="toggleContaminationChoropleth"
          @update-weight="updateLayerWeight"
          @update-direction="updateLayerDirection"
          @update-filter="updateLayerFilter"
        />
      </template>
      <template #context>
        <LensContext :scoring-layer-ids="allSelectedLayers" />
      </template>
    </Lens>

    <RankingPanel
      :expanded="rankingPanelExpanded"
      :visible="showRankingPanel"
      :ranked-counties="rankedCounties"
      :get-county-name="getCountyName"
      :active-filters="activeFilters"
      :display-limit="activeLimit"
      v-model:selected-state="rankingStateFilter"
      :region-states="rankingRegionStates"
      @toggle="toggleRankingPanel"
      @select-county="selectCountyFromRanking"
      @clear-filters="clearActiveFilters"
      @start-walkthrough="startWalkthrough"
    />

    <EntityRail
      :visible="entityRailVisible"
      :layers="entityRailLayers"
      :active="activeEntity"
      :loading="entityRailLoading"
      @select="canvas?.focusEntity"
      @dismiss="entityRailDismissed = true"
    />
    <CountyRail
      :visible="railVisible"
      :mode="walkthroughActive ? 'walk' : 'inspect'"
      :rank="walkthroughIndex + 1"
      :total="limitedRankedCounties.length"
      :county-name="currentCounty?.name || ''"
      :state-name="currentCounty?.id ? getStateName(currentCounty.id) : ''"
      :score="walkthroughScore"
      :score-scale="walkthroughScoreScale"
      :score-rank="walkthroughRank"
      :stats="walkthroughStats"
      :rank-counties="rankExplorerCounties"
      :rankings-counties="railRankingsCounties"
      :current-geo-id="currentCounty?.id || null"
      :initial-view="railInitialView"
      :query-descriptor="railQueryDescriptor"
      v-model:selected-state="rankingStateFilter"
      :rankings-limit="activeLimit"
      :land-search="railLandSearchState"
      @prev="walkthroughPrev"
      @next="walkthroughNext"
      @exit="handleRailExit"
      @view-details="openWalkthroughDetails"
      @select-county="inspectCounty"
      @search-land="handleRailSearchLand"
      @clear-land="clearActiveQuery"
      @select-listing="handleRailSelectListing"
      @hover-listing="handleRailHoverListing"
      @download-listings="downloadCSV"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick, type Ref } from "vue";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { usePropertyListings } from "@/composables/usePropertyListings";
import MapCanvas from "@/components/MapCanvas.vue";
import { useMapState } from "@/composables/useMapState";
import {
  SET_OUTLINE_LAYER,
  ACTIVE_OUTLINE_LAYER,
  INSPECT_HALO_LAYER,
  INSPECT_OUTLINE_LAYER,
} from "@/lib/countyOverlays";
import {
  DEV_MODE_DEMOGRAPHICS_ONLY,
  debugLog,
  MAPBOX_ACCESS_TOKEN,
  MAP_CONFIG,
} from "@/config/constants";
import { LAYER_REGISTRY } from "@/config/layerRegistry";
import { NATIONAL_AVERAGES } from "@/config/nationalAverages";
// BLO_PRESET available in @/config/presets for future "load preset" feature
import CountyModal from "@/components/CountyModal.vue";
import LayerControls from "@/components/LayerControls.vue";
import RankingPanel from "@/components/RankingPanel.vue";
import CountyRail from "@/components/CountyRail.vue";
import EntityRail from "@/components/EntityRail.vue";
import type { EntityRailLayer } from "@/lib/entityRail";
import { parseMapDeepLink } from "@/lib/mapDeepLinks";
import { completeFirstRunStep } from "@/lib/firstRun";
import Lens from "@/components/Lens.vue";
import LensHeader from "@/components/LensHeader.vue";
import LensLegend from "@/components/LensLegend.vue";
import LensLayers from "@/components/LensLayers.vue";
import LensContext from "@/components/LensContext.vue";
import WelcomeCard from "@/components/WelcomeCard.vue";
import PromptInput from "@/components/PromptInput.vue";
import type { QueryResponse } from "@/composables/usePromptQuery";
import { useChat } from "@/composables/useChat";
import { initCountyLookup } from "@/lib/countyLookup";
import type { ToolContext } from "@/lib/mapTools";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "@/composables/useAuth";
import { saveView, fetchView, mapStateOf, siteLayerRestore, VIEW_RESULTS_MAX, type SavedViewResult } from "@/lib/views";
import { isInternalLayerId } from "@/lib/internalLayers";
import { boundsForFeatures } from "@/lib/internalFeatureLayers";

// Cast instead of ref<mapboxgl.Map | null>(): letting Vue compute UnwrapRef
// on the mapbox-gl v3 Map class blows TS's instantiation depth ("Map$1"
// errors). Runtime behavior is identical — it's still a plain deep ref.
// Filled from the canvas's `ready` event — this component no longer builds
// the map, it wraps the component that does.
const map = ref(null) as Ref<mapboxgl.Map | null>;
let geocoder: MapboxGeocoder;
const geocoderRef = { value: undefined as MapboxGeocoder | undefined };

/** The canvas: the map, the counties, the choropleth and the overlays this
 *  page's chrome drives (P6-10). */
const canvas = ref<InstanceType<typeof MapCanvas> | null>(null);

/** P5-28: the entity rail is dismissable, which is a rail concern. */
const entityRailDismissed = ref(false);
/** Resolves when the manifest for the current login has been applied —
 *  a saved view carrying internal ids must wait for it. */
let internalManifestLoaded: Promise<void> | null = null;

/**
 * This map's state — which layers are on, what is ranked and filtered.
 * Per instance since P6-10: the chat page has a map of its own, and the two
 * must not share one answer about what is loaded.
 */
const state = useMapState();
const {
  data,
  layers: layerState,
  query: queryState,
  getCountyName,
  getStateName,
  getRawLayerValueFor,
  stateAbbrFromGeo: getStateAbbrFromGeo,
  filteredOutCountyIds,
  repaint,
  updateLayerWeight,
  updateLayerDirection,
  updateLayerFilter,
  clearActiveFilters,
  toggleDemographicLayer,
  toggleEconomicLayer,
  toggleHousingLayer,
  toggleEquityLayer,
  toggleTransportationLayer,
  toggleContaminationChoropleth,
  toggleInternalLayer,
  toggleInternalFeatureLayer,
  setInternalFeatureLayers,
  loadInternalLayers,
  teardownInternalLayers,
} = state;
const {
  countiesData,
  diversityData,
  lifeExpectancyData,
  countyContaminationCounts,
  combinedScoresData,
  combinedScoresV2Data,
  economicData,
  housingData,
  equityData,
  transportationData,
} = data;
const {
  demographic: selectedDemographicLayers,
  economic: selectedEconomicLayers,
  housing: selectedHousingLayers,
  equity: selectedEquityLayers,
  transportation: selectedTransportationLayers,
  internal: selectedInternalLayers,
  points: selectedInternalFeatureLayers,
  contaminationChoropleth: showContaminationChoropleth,
  allContaminationSites: showContaminationLayers,
  internalDefinitions: internalLayers,
  pointDefinitions: internalPointLayers,
  pointData: internalPointData,
  activeEntity,
  all: allSelectedLayers,
  activeName: defaultLensLayerName,
} = layerState;
const {
  demographic: demographicLayers,
  economic: economicLayers,
  housing: housingLayers,
  equity: equityLayers,
  transportation: transportationLayers,
  contamination: contaminationLayers,
} = layerState.definitions;
const {
  weights: layerWeights,
  directions: layerDirections,
  filters: activeFilters,
  limit: activeLimit,
  regionStates: rankingRegionStates,
  scores: personalizedScores,
  ranked: rankedCounties,
  limitedRanked: limitedRankedCounties,
  topNGeoIds,
  scoring: scoringQuery,
} = queryState;



// Initialize property listings composable. listingsPanelExpanded /
// toggleListings are intentionally not destructured — the floating
// Available Properties panel was retired in favor of CountyRail's
// in-rail listings view.
const {
  listings,
  isSearchResultsLoading,
  currentGeocoderResult,
  selectedListingId,
  hoveredListingId,
  highlightMarker,
  downloadCSV,
  searchListings,
  clearSearch,
} = usePropertyListings(map, geocoderRef);

/** Marker-click → swap rail to listings view + pan to the marker, all
 *  driven off selectedListingId set inside the composable. We don't
 *  need to touch the rail directly — selectedListingId flows in via
 *  landSearch so the rail can scroll/highlight on its own. */
watch(selectedListingId, (id) => {
  if (!id) return;
  const listing = listings.value.find((l: any) => l.id === id);
  if (listing) highlightMarker(listing);
});

/** Has the user run a land search for the current county at least once?
 *  Drives the "No listings nearby" empty-state copy in the rail —
 *  without this we'd flash the empty state for an unsearched county. */
const landSearchAttempted = ref(false);

/** Run the rail's "Find land for sale" CTA. The composable already
 *  centers on map.getCenter() when no geocoder result is set, and
 *  inspectCounty() has just zoomed to the county — so map center IS
 *  the county center. No extra parameter plumbing required. */
const handleRailSearchLand = async () => {
  landSearchAttempted.value = true;
  await searchListings();
};

/** Listing row click in the rail's listings view → flow through the
 *  same selectedListingId ref the marker click uses. The watcher above
 *  takes it from there (pan map + restyle marker), and the rail
 *  reads selectedListingId back via landSearch to highlight its card. */
const handleRailSelectListing = (listingId: string) => {
  selectedListingId.value = listingId;
};

/** Rail card hover → tint the matching map pin so the user can see
 *  which row corresponds to which dot on the map. */
const handleRailHoverListing = (listingId: string | null) => {
  hoveredListingId.value = listingId;
};

// Phase 4d: Data Layers panel + its expanded state are gone — layer
// picking now lives inside the Lens "Layers" tab which is always visible.
const showDetailedPopup = ref(false);

// County modal state
const currentCounty = ref<{
  id: string
  name: string
} | null>(null);

const isDesktopView = computed(() => {
  return window.innerWidth > 768;
});

const handleOutsideClick = (event: MouseEvent) => {
  const popup = document.getElementById("detailed-popup");
  if (
    showDetailedPopup.value &&
    popup &&
    !popup.contains(event.target as Node)
  ) {
    closeDetailedPopup();
  }
};

/**
 * Moving the map is the canvas's job (P6-10); these are the chrome's names
 * for it, so every call site below reads as it always did. Each is a no-op
 * until the canvas has mounted — exactly as they were no-ops while `map`
 * was still null.
 */
const zoomToGeoId = (geoId: string, opts?: { regional?: boolean }): boolean =>
  canvas.value?.zoomToGeoId(geoId, opts) ?? false;
const fitToGeoIds = (
  geoIds: string[],
  opts: { padding?: number; maxZoom?: number; duration?: number } = {},
): boolean => canvas.value?.fitToGeoIds(geoIds, opts) ?? false;

/** Two or more layers means the weights and directions are worth showing. */
const showScoringControls = computed(() => allSelectedLayers.value.length >= 2);

const rankingPanelExpanded = ref(false);
const rankingStateFilter = ref('');
const toggleRankingPanel = () => {
  rankingPanelExpanded.value = !rankingPanelExpanded.value;
};

/** True after an LLM-driven scoring query produces ≥1 layer. Reset by
 *  clearActiveQuery. Drives RankingPanel mount so single-layer "top 5"
 *  queries surface results (and walkthrough nav) instead of disappearing. */
const hasActiveScoringQuery = ref(false);

const showRankingPanel = computed(() =>
  (hasActiveScoringQuery.value && allSelectedLayers.value.length >= 1) ||
  allSelectedLayers.value.length >= 2 ||
  activeFilters.value.length > 0
);



/** Handle county selection from ranking panel — opens the inspect rail
 *  (Phase 4e). The map zooms regionally so the user sees the county in
 *  context, not as a single polygon filling the screen. */
const selectCountyFromRanking = (geoId: string) => {
  inspectCounty(geoId);
};

/** Open county inspection by GEOID — used by the LLM `show_county_details` tool. */
const openCountyModalById = (geoId: string) => {
  inspectCounty(geoId);
};

// Dynamic scoring state

const closeDetailedPopup = () => {
  showDetailedPopup.value = false;
};





/** Chips describing the active scoring query, shown in the status strip above the map */
const scoringChips = computed(() => {
  return allSelectedLayers.value.map(layerId => {
    const reg = LAYER_REGISTRY[layerId];
    const dir = layerDirections.value[layerId] ?? reg?.direction ?? 'higher_better';
    return {
      id: layerId,
      name: reg?.name ?? layerId,
      arrow: dir === 'lower_better' ? '↓' : '↑',
      directionClass: dir === 'lower_better' ? 'dir-lower' : 'dir-higher',
    };
  });
});


/** Clear-all for the status strip: revert selected layers, filters, and limit
 *  to the BLO Livability Index default state. The Lens header advertises
 *  "Showing BLO Livability Index" when no query is active, so the actual
 *  visible layer must match — Phase 4d cleanup restores BLO here. */
/** The chrome's half of a reset: the panels follow the query. */
const resetQueryScoring = () => {
  state.resetQueryScoring();
  rankingPanelExpanded.value = false;
  rankingStateFilter.value = '';
  hasActiveScoringQuery.value = false;
};

const clearActiveQuery = () => {
  resetQueryScoring();
  // D3: chat narration goes stale once the query clears — drop it.
  chat.clearConversation();
  // Phase 4e: clear any open inspect rail; its context is gone too.
  if (inspectActive.value) closeInspect();
  // Phase 4i (Round-3 feedback): nuclear reset includes the land
  // search. The user reported that the 3 separate "Clear" buttons
  // each scoped to a different concern (chat / query / listings) were
  // confusing — all three now route here, so the user can press
  // whichever one is in front of them and get back to a clean slate.
  clearSearch();
  landSearchAttempted.value = false;
  repaint();
};

/** Phase 4d cleanup: walkthrough is reachable from the Lens header when
 *  there's at least one ranked county to tour. Discoverable on mobile
 *  (RankingPanel is display:none there) and when the RankingPanel is
 *  collapsed on desktop. */
const canWalkThrough = computed(() =>
  hasActiveScoringQuery.value && limitedRankedCounties.value.length > 0,
);

// Phase 4a: walkthrough state
const walkthroughActive = ref(false);
const walkthroughIndex = ref(0);

// Phase 4e: single-county inspect mode. Mutually exclusive with walkthrough —
// only one rail mode is active at a time. Inspect is the default response to
// any "show me this county" intent (direct click, place pick, LLM tool).
const inspectActive = ref(false);

/** Snapshot-restored county that arrived before county data / the map
 *  existed (chat hydration runs during setup). Replayed once the map's
 *  `load` handler fires, so a refresh mid-inspection restores the rail. */
const pendingInspectGeoId = ref<string | null>(null);



/** Default snapshot layers used by inspect mode when no scoring query is
 *  active — gives the rail something useful to show on a casual click. */
const INSPECT_DEFAULT_LAYERS = [
  'pct_Black',
  'diversity_index',
  'median_home_value',
  'life_expectancy',
] as const;

/** Layers we DON'T color in the rail. Empty by default — for the BLO
 *  audience, both higher Black population and higher diversity are
 *  positive indicators (the index is built around supporting Black
 *  community-building), so we lean into the registry's direction
 *  judgments rather than hiding from them. */
const NEUTRAL_LAYER_IDS = new Set<string>();

/** Stat lines shown in the rail — one per active scoring layer when a query
 *  is running; otherwise a default snapshot for inspect mode. Each row gets
 *  a `delta` of 'good' | 'bad' | 'neutral' based on:
 *    - LAYER_REGISTRY[id].direction (higher_better vs lower_better)
 *    - county value vs the national average for that layer
 *  Coloring is suppressed for descriptive layers (pct_Black, diversity_index)
 *  where "better" isn't a meaningful frame. */
const walkthroughStats = computed(() => {
  const geoId = currentCounty.value?.id;
  if (!geoId) return [];
  const layerIds = allSelectedLayers.value.length > 0
    ? allSelectedLayers.value
    : (inspectActive.value ? [...INSPECT_DEFAULT_LAYERS] : []);
  return layerIds.map(layerId => {
    const reg = LAYER_REGISTRY[layerId];
    const raw = getRawLayerValueFor(layerId, geoId);
    const avg = NATIONAL_AVERAGES[layerId]?.value;
    const dir = reg?.direction;
    let delta: 'good' | 'bad' | 'neutral' = 'neutral';
    if (
      typeof raw === 'number' &&
      typeof avg === 'number' &&
      avg > 0 &&
      dir &&
      !NEUTRAL_LAYER_IDS.has(layerId)
    ) {
      // Within ±2% of average → neutral; otherwise green/red by direction.
      const ratio = raw / avg;
      if (Math.abs(ratio - 1) < 0.02) delta = 'neutral';
      else if (dir === 'higher_better') delta = raw > avg ? 'good' : 'bad';
      else delta = raw < avg ? 'good' : 'bad';
    }
    // Tooltip: dataset source + year + a 1-line description if we have one.
    // The user's pain point: rates like "100% Black homeownership" in
    // tiny-population counties read as facts when they're sample-size
    // artifacts. Surfacing the source nudges them to think about
    // provenance and (eventually) click through to the dataset page.
    const source = reg?.source ?? '';
    const year = reg?.year ?? '';
    const sourceLine = source
      ? `Source: ${source}${year ? ` (${year})` : ''}`
      : '';
    const tooltipParts = [
      reg?.description,
      sourceLine,
    ].filter(Boolean) as string[];
    return {
      layerId,
      name: reg?.name ?? layerId,
      value: reg?.formatValue(raw) ?? '?',
      delta,
      tooltip: tooltipParts.join('\n'),
    };
  });
});

// ============= Phase 4f follow-up: Rank Explorer =============
//
// Clicking the "rank N of M" line in the rail swaps the rail's content
// to a scrollable ranked list of every county. Back arrow returns to
// the detail view. Clicking any row switches inspect to that county
// AND auto-returns to detail. Implemented as a view inside CountyRail
// (not a separate panel) so we don't add another floating surface.

/** Phase 4h: rail is visible whenever a walkthrough is active, an
 *  inspect target is set, OR (mobile-only) a scoring query is active.
 *  The query-active branch is what auto-opens the rail to its new
 *  rankings view on mobile when the user submits a query without
 *  having clicked a county first. */
const railVisible = computed(() => {
  if (walkthroughActive.value) return true;
  if (inspectActive.value && !showDetailedPopup.value) return true;
  if (hasActiveScoringQuery.value && isMobileViewport.value) return true;
  return false;
});

/** Phase 4h: which view the rail should open in. inspect/walk → 'detail'
 *  (CountyRail's default). Query-active-without-inspect → 'rankings'. */
const railInitialView = computed<'detail' | 'rankings' | null>(() => {
  if (walkthroughActive.value || inspectActive.value) return 'detail';
  if (hasActiveScoringQuery.value && isMobileViewport.value) return 'rankings';
  return null;
});

/** Phase 4h: short descriptor for the rankings header (mirrors
 *  LensHeader.vue's queryDescriptor logic). Returns the first scoring
 *  layer name with trailing "Rate"/"Index"/"Score" stripped, plus a
 *  "+N" if more layers are active. */
const railQueryDescriptor = computed(() => {
  const layers = scoringQuery.value;
  if (layers.length === 0) return '';
  const first = LAYER_REGISTRY[layers[0].layerId];
  if (!first) return '';
  const short = first.name.replace(/\s+(Rate|Index|Score|Count|Population|Average)$/i, '').trim();
  return layers.length === 1 ? short : `${short} +${layers.length - 1}`;
});

/** Cheap reactive viewport-width check; updates on resize. The 768px
 *  threshold matches the existing rail/RankingPanel media-query
 *  breakpoint. SSR-safe — returns false when window is undefined. */
const isMobileViewport = ref(typeof window !== 'undefined' && window.innerWidth <= 768);
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    isMobileViewport.value = window.innerWidth <= 768;
  });
}

/** Land-for-sale CTA state for the inspect rail. Returns null in walk
 *  mode — the walkthrough is about scanning multiple counties, not
 *  shopping for parcels in any one of them. Includes the raw results
 *  array so the rail can swap into a listings view (third view, after
 *  detail and rank) once a search returns. */
const railLandSearchState = computed(() => {
  if (walkthroughActive.value) return null;
  if (!inspectActive.value || !currentCounty.value) return null;
  return {
    loading: isSearchResultsLoading.value,
    attempted: landSearchAttempted.value,
    resultCount: listings.value.length,
    results: listings.value,
    selectedListingId: selectedListingId.value,
  };
});

/** Phase 4h fix: dedicated source for the rail's `rankings` view.
 *  ALWAYS reflects the active scoring query (any layer count), unlike
 *  rankExplorerCounties which falls back to BLO default for 0-1
 *  layers. Also applies the chat-set regionStates filter so what the
 *  user sees in the mobile rail matches what desktop's RankingPanel
 *  shows. Empty when no query is active (rail's rankings view is only
 *  rendered with an active query, so this is safe). */
const railRankingsCounties = computed(() => {
  if (!hasActiveScoringQuery.value || allSelectedLayers.value.length === 0) return [];
  const region = rankingRegionStates.value.length > 0
    ? new Set(rankingRegionStates.value.map(s => s.toUpperCase()))
    : null;
  const ranked = rankedCounties.value.filter(c => c.score != null);
  const filtered = region
    ? ranked.filter(c => region.has(getStateAbbrFromGeo(c.geoId).toUpperCase()))
    : ranked;
  return filtered.map((c, i) => ({
    geoId: c.geoId,
    rank: i + 1,
    name: getCountyName(c.geoId),
    stateAbbr: getStateAbbrFromGeo(c.geoId),
    scoreFmt: (c.score as number).toFixed(1),
  }));
});

/** All counties sorted by the active scoring metric (BLO v2 by default,
 *  composite when ≥2 scoring layers). One pass over the data; filtered
 *  to entries that have BOTH a score and a name, so the list is clean.
 *  This feeds the rank-explorer view ("where does THIS county rank in
 *  the full list") and intentionally keeps the BLO fallback so the
 *  view is meaningful even with no active query. */
const rankExplorerCounties = computed(() => {
  if (allSelectedLayers.value.length >= 2) {
    return rankedCounties.value
      .filter(c => c.score != null)
      .map((c, i) => ({
        geoId: c.geoId,
        rank: i + 1,
        name: getCountyName(c.geoId),
        stateAbbr: getStateAbbrFromGeo(c.geoId),
        scoreFmt: (c.score as number).toFixed(1),
      }));
  }
  // BLO Livability default — sort all counties by blo_score_v2 desc.
  const entries: { geoId: string; score: number }[] = [];
  for (const [geoId, v] of Object.entries(combinedScoresV2Data.value)) {
    const s = (v as any)?.blo_score_v2;
    if (typeof s === 'number') entries.push({ geoId, score: s });
  }
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.geoId.localeCompare(b.geoId);
  });
  return entries.map((e, i) => ({
    geoId: e.geoId,
    rank: i + 1,
    name: getCountyName(e.geoId),
    stateAbbr: getStateAbbrFromGeo(e.geoId),
    scoreFmt: e.score.toFixed(2),
  }));
});

/** State postal abbreviation from the first 2 digits of GEOID. Mirrors
 *  the lookup in RankingPanel + the FIPS map; small inline copy avoids
 *  extracting a shared helper just for this. */

/** Rank context shown under the score in the rail header. Computed from
 *  the BLO Livability score (default) or the active composite (≥2 layers).
 *  Returns { rank, total } where rank is 1-indexed (1 = best). */
const walkthroughRank = computed<{ rank: number; total: number } | null>(() => {
  const geoId = currentCounty.value?.id;
  if (!geoId) return null;
  if (allSelectedLayers.value.length >= 2) {
    // Composite: rank within rankedCounties (already sorted descending)
    const idx = rankedCounties.value.findIndex(c => c.geoId === geoId);
    if (idx === -1) return null;
    return { rank: idx + 1, total: rankedCounties.value.length };
  }
  // Default: rank by BLO v2 score across all counties with that score
  const target = combinedScoresV2Data.value[geoId]?.blo_score_v2;
  if (typeof target !== 'number') return null;
  let better = 0;
  let total = 0;
  for (const v of Object.values(combinedScoresV2Data.value)) {
    const s = (v as any)?.blo_score_v2;
    if (typeof s !== 'number') continue;
    total++;
    if (s > target) better++;
  }
  return { rank: better + 1, total };
});

/** Composite score shown in the rail header.
 *  - 2+ active scoring layers → custom composite from personalizedScores.
 *  - Single layer or no query → BLO Livability v2 score (the default
 *    "what is this county like overall" answer). */
const walkthroughScore = computed(() => {
  const geoId = currentCounty.value?.id;
  if (!geoId) return null;
  if (allSelectedLayers.value.length >= 2) {
    const s = personalizedScores.value.get(geoId)?.score;
    return s != null ? s : null;
  }
  // Default fallback: BLO Livability Index v2 score (1–5 range)
  const blo = combinedScoresV2Data.value[geoId]?.blo_score_v2;
  return typeof blo === 'number' ? blo : null;
});

/** Score scale: 100 for the custom composite (≥2 layers), 5 for BLO. */
const walkthroughScoreScale = computed<5 | 100>(() =>
  allSelectedLayers.value.length >= 2 ? 100 : 5,
);

/** Phase 4a/4c: walkthrough handlers
 *
 *  Walkthrough no longer auto-opens the centered CountyModal — that was
 *  occluding the map on every step. Instead we set `currentCounty`, do a
 *  regional zoom, and let `WalkthroughRail` render alongside the map.
 *  The full modal is opt-in via the rail's "View full details" button. */
const stepWalkthroughTo = (geoId: string) => {
  const name = getCountyName(geoId);
  currentCounty.value = { id: geoId, name };
  zoomToGeoId(geoId, { regional: true });
};

const openCountyAtWalkthroughIndex = () => {
  const county = limitedRankedCounties.value[walkthroughIndex.value];
  if (!county) return;
  stepWalkthroughTo(county.geoId);
};

/** Token cancelled when the user advances/exits before the entry auto-fit
 *  has handed off to the step-in flyTo. Prevents an in-flight auto-step
 *  from overriding the user's manual choice. */
let walkthroughEntryHandoff: ReturnType<typeof setTimeout> | null = null;

const startWalkthrough = () => {
  if (limitedRankedCounties.value.length === 0) return;
  walkthroughActive.value = true;
  walkthroughIndex.value = 0;
  showDetailedPopup.value = false;

  // Phase 4c: first show the geographic distribution of the answer for
  // ~1000ms (matches fitToTopN duration), THEN step into county 1. If the
  // user clicks Next/Prev/Exit during the dwell, the handoff is cancelled
  // so we don't override their input with a stale auto-step.
  const fitFired = fitToTopN();
  if (walkthroughEntryHandoff) clearTimeout(walkthroughEntryHandoff);
  if (fitFired && limitedRankedCounties.value.length > 1) {
    walkthroughEntryHandoff = setTimeout(() => {
      walkthroughEntryHandoff = null;
      if (walkthroughActive.value && walkthroughIndex.value === 0) {
        openCountyAtWalkthroughIndex();
      }
    }, 1100);
  } else {
    openCountyAtWalkthroughIndex();
  }
};

/** Helper: any manual step or exit cancels the entry handoff. */
const cancelEntryHandoff = () => {
  if (walkthroughEntryHandoff) {
    clearTimeout(walkthroughEntryHandoff);
    walkthroughEntryHandoff = null;
  }
};

const walkthroughNext = () => {
  if (walkthroughIndex.value < limitedRankedCounties.value.length - 1) {
    cancelEntryHandoff();
    walkthroughIndex.value++;
    openCountyAtWalkthroughIndex();
  }
};

const walkthroughPrev = () => {
  if (walkthroughIndex.value > 0) {
    cancelEntryHandoff();
    walkthroughIndex.value--;
    openCountyAtWalkthroughIndex();
  }
};

const exitWalkthrough = () => {
  cancelEntryHandoff();
  walkthroughActive.value = false;
  walkthroughIndex.value = 0;
  showDetailedPopup.value = false;
};

/** Phase 4e: open the inspect rail for a single county. Used by direct
 *  click, place selection, and the LLM `show_county_details` tool. Closes
 *  any active walkthrough first — they're mutually exclusive surfaces. */
const inspectCounty = (geoId: string) => {
  if (!geoId) return;
  if (walkthroughActive.value) exitWalkthrough();
  // Different county → discard last search's "no results" state so the
  // rail doesn't show a stale empty-message under the new county.
  if (currentCounty.value?.id !== geoId) {
    landSearchAttempted.value = false;
    if (listings.value.length > 0) clearSearch();
  }
  currentCounty.value = { id: geoId, name: getCountyName(geoId) };
  inspectActive.value = true;
  showDetailedPopup.value = false;
  zoomToGeoId(geoId, { regional: true });
};

/** Close the inspect rail. The full modal (if open as the opt-in detail
 *  layer) closes too, since inspect is the surface that owns the modal. */
const closeInspect = () => {
  inspectActive.value = false;
  showDetailedPopup.value = false;
  currentCounty.value = null;
};

/** Rail's "exit" emit routes here. The rail's mode tells us which to call. */
const handleRailExit = () => {
  if (walkthroughActive.value) exitWalkthrough();
  else closeInspect();
};

/** Opt-in: open the full CountyModal from whichever rail is active.
 *  The modal coexists with the rail (Phase 4e); it does not replace it. */
const openWalkthroughDetails = () => {
  if (!currentCounty.value?.id) return;
  showDetailedPopup.value = true;
};

/** Modal close: just close the modal. The active rail (walk or inspect)
 *  stays alive. Exit/Close is its own explicit action via the rail. */
const handleModalClose = () => {
  showDetailedPopup.value = false;
};

/**
 * A prompt or a tool result: the state applies it, and the chrome reacts
 * through `onQueryApplied` below — so a query that arrives from the chat's
 * `set_query_state` and one typed into the prompt do exactly the same thing.
 */
const handleQueryResult = (result: QueryResponse) => {
  state.applyQueryState({
    layers: result.layers ?? [],
    filters: result.filters,
    limit: result.limit ?? null,
    explanation: result.explanation,
  });
};

/**
 * Everything the public map does about a new query that a bare canvas does
 * not: leave a walkthrough or an inspection that is now about the wrong
 * counties, and open the ranking panel on the answer.
 */
state.onQueryApplied((input) => {
  // Phase 4c: any new query result invalidates a walkthrough in progress —
  // it would be referring to the old ranked set. Exit cleanly so overlays
  // and the rail don't show stale state, then let the user re-enter the
  // walkthrough from the new ranking via the panel.
  // Phase 4e: same logic applies to inspect mode — a new query is a new
  // context, so close any active inspection card.
  if (walkthroughActive.value) exitWalkthrough();
  if (inspectActive.value) closeInspect();

  if ((input.layers?.length ?? 0) === 0) {
    rankingPanelExpanded.value = false;
    rankingStateFilter.value = '';
    hasActiveScoringQuery.value = false;
  } else {
    hasActiveScoringQuery.value = true;
    // UX-01: auto-open the ranking panel so the answer is visible without
    // hunting for it.
    rankingPanelExpanded.value = true;
  }

  // The single-state dropdown is for direct user selection; the chat's
  // multi-state filter is a parallel axis. Clear the dropdown when a region
  // is set (otherwise both would AND together and the user couldn't tell why
  // their counties disappeared).
  if ((input.regionStates?.length ?? 0) > 0) {
    rankingStateFilter.value = '';
    rankingPanelExpanded.value = true;
  }
});


// ============= Phase 4c: Walkthrough overlays =============
//
// Two outline layers driven by Mapbox `filter` expressions on the counties
// source — set outline (all top-N) and active outline (current step). DOM
// markers (numbered chips) anchored at county centroids via mapboxgl.Marker.
// All overlays clear when walkthrough exits or the query clears.


/** Update the set-outline filter to match all top-N geoIds. */
const updateSetOutline = () => {
  if (!map.value || !map.value.getLayer(SET_OUTLINE_LAYER)) return;
  const ids = Array.from(topNGeoIds.value);
  const visible = walkthroughActive.value && ids.length > 0;
  if (visible) {
    map.value.setFilter(SET_OUTLINE_LAYER, ["in", ["get", "GEOID"], ["literal", ids]]);
    map.value.setLayoutProperty(SET_OUTLINE_LAYER, "visibility", "visible");
  } else {
    map.value.setLayoutProperty(SET_OUTLINE_LAYER, "visibility", "none");
  }
};

/** Update the active-outline filter to match the current walkthrough county. */
const updateActiveOutline = () => {
  if (!map.value || !map.value.getLayer(ACTIVE_OUTLINE_LAYER)) return;
  const id = currentCounty.value?.id;
  const visible = walkthroughActive.value && !!id;
  if (visible) {
    map.value.setFilter(ACTIVE_OUTLINE_LAYER, ["==", ["get", "GEOID"], id]);
    map.value.setLayoutProperty(ACTIVE_OUTLINE_LAYER, "visibility", "visible");
  } else {
    map.value.setLayoutProperty(ACTIVE_OUTLINE_LAYER, "visibility", "none");
  }
};

/** Update the inspect-mode highlight (halo + outline + fill reveal) so the
 *  user can clearly see which county was just clicked, even after the
 *  map has finished its zoom-to-center. Drops choropleth opacity inside
 *  the polygon to ~0.4 so basemap labels and roads show through. */
const updateInspectOutline = () => {
  if (!map.value) return;
  const id = inspectActive.value ? currentCounty.value?.id : null;
  const visible = !!id;

  if (map.value.getLayer(INSPECT_HALO_LAYER)) {
    if (visible) {
      map.value.setFilter(INSPECT_HALO_LAYER, ["==", ["get", "GEOID"], id]);
      map.value.setLayoutProperty(INSPECT_HALO_LAYER, "visibility", "visible");
    } else {
      map.value.setLayoutProperty(INSPECT_HALO_LAYER, "visibility", "none");
    }
  }
  if (map.value.getLayer(INSPECT_OUTLINE_LAYER)) {
    if (visible) {
      map.value.setFilter(INSPECT_OUTLINE_LAYER, ["==", ["get", "GEOID"], id]);
      map.value.setLayoutProperty(INSPECT_OUTLINE_LAYER, "visibility", "visible");
    } else {
      map.value.setLayoutProperty(INSPECT_OUTLINE_LAYER, "visibility", "none");
    }
  }
  // Reveal basemap detail through the choropleth inside the inspected
  // county. When nothing is inspected, restore the flat 0.7 opacity.
  if (map.value.getLayer("county-choropleth")) {
    if (visible) {
      map.value.setPaintProperty("county-choropleth", "fill-opacity", [
        "case",
        ["==", ["get", "GEOID"], id],
        0.4,
        0.7,
      ]);
    } else {
      map.value.setPaintProperty("county-choropleth", "fill-opacity", 0.7);
    }
  }
};

// ----- Numbered marker chips -----

/** Pool of mapboxgl.Markers, keyed by GEOID. Recycled across walkthrough steps. */
const walkthroughMarkers = new Map<string, mapboxgl.Marker>();

/** Compute polygon centroid (rough — average of vertices). Sufficient for marker
 *  placement on a county polygon since we only need a label anchor. */
const computeCentroid = (feature: any): [number, number] | null => {
  if (!feature?.geometry) return null;
  const coords = feature.geometry.type === "MultiPolygon"
    ? feature.geometry.coordinates.flat(2)
    : feature.geometry.coordinates.flat(1);
  if (coords.length === 0) return null;
  let sx = 0, sy = 0, n = 0;
  for (const c of coords as [number, number][]) {
    sx += c[0]; sy += c[1]; n++;
  }
  return n > 0 ? [sx / n, sy / n] : null;
};

const buildMarkerEl = (rank: number, isActive: boolean): HTMLElement => {
  const el = document.createElement("div");
  el.className = "walkthrough-marker" + (isActive ? " walkthrough-marker--active" : "");
  el.setAttribute("aria-hidden", "true");
  el.textContent = String(rank);
  return el;
};

const clearAllWalkthroughMarkers = () => {
  walkthroughMarkers.forEach(m => m.remove());
  walkthroughMarkers.clear();
};

/** Sync markers to the current walkthrough state. Idempotent — adds missing,
 *  updates active treatment, removes stale. */
const updateWalkthroughMarkers = () => {
  if (!map.value || !countiesData.value) return;

  if (!walkthroughActive.value) {
    clearAllWalkthroughMarkers();
    return;
  }

  const counties = limitedRankedCounties.value;
  const activeId = currentCounty.value?.id;
  const wantedIds = new Set(counties.map(c => c.geoId));

  // Remove markers no longer needed
  for (const [geoId, marker] of walkthroughMarkers) {
    if (!wantedIds.has(geoId)) {
      marker.remove();
      walkthroughMarkers.delete(geoId);
    }
  }

  // Add or refresh markers for current top-N
  counties.forEach((c, i) => {
    const isActive = c.geoId === activeId;
    const existing = walkthroughMarkers.get(c.geoId);
    if (existing) {
      // Refresh active state by replacing the element class
      const el = existing.getElement();
      if (isActive) el.classList.add("walkthrough-marker--active");
      else el.classList.remove("walkthrough-marker--active");
      return;
    }
    const feature = countiesData.value?.features.find(
      (f: any) => f.properties?.GEOID === c.geoId
    );
    const centroid = computeCentroid(feature);
    if (!centroid) return;
    const el = buildMarkerEl(i + 1, isActive);
    const marker = new mapboxgl.Marker({ element: el, anchor: "center" })
      .setLngLat(centroid)
      .addTo(map.value!);
    walkthroughMarkers.set(c.geoId, marker);
  });
};

// ----- Walkthrough auto-fit (entry) -----

/** Fit map bounds to the union of all top-N counties — gives the user the
 *  geographic distribution of the answer before stepping into county 1. */
const fitToTopN = (): boolean => fitToGeoIds(limitedRankedCounties.value.map(c => c.geoId));

// ----- Watchers wiring overlays to state -----

watch([walkthroughActive, topNGeoIds], () => {
  updateSetOutline();
  updateWalkthroughMarkers();
});

watch([walkthroughActive, currentCounty], () => {
  updateActiveOutline();
  updateWalkthroughMarkers();
}, { deep: true });

watch([inspectActive, currentCounty], () => {
  updateInspectOutline();
}, { deep: true });








// Phase 4e: showDetailedPopupForFeature removed — county clicks route
// through `inspectCounty(geoId)` which opens the rail, not the modal.


const showGeocoderError = (message: string) => {
  const errorElement = document.createElement("div");
  errorElement.textContent = message;
  errorElement.style.cssText = `
    position: absolute;
    top: 50px;
    left: 10px;
    background-color: #ff6b6b;
    color: white;
    padding: 10px;
    border-radius: 4px;
    z-index: 1000;
  `;
  document.body.appendChild(errorElement);
  setTimeout(() => {
    errorElement.remove();
  }, 3000);
};

/** Phase 4f: themed place marker — cream + ink + green-deep dot with a
 *  brief BLO-orange pulse ring. Replaces the bright Mapbox blue default
 *  so the marker fits the BLO design system. */
const buildBloPlaceMarker = (): HTMLElement => {
  const wrap = document.createElement('div');
  wrap.className = 'blo-place-marker';
  const dot = document.createElement('div');
  dot.className = 'blo-place-marker-dot';
  const pulse = document.createElement('div');
  pulse.className = 'blo-place-marker-pulse';
  pulse.setAttribute('aria-hidden', 'true');
  wrap.appendChild(pulse);
  wrap.appendChild(dot);
  return wrap;
};

const handleGeocoderResult = (result: any) => {
  debugLog("Geocoder result:", result);

  if (result.center) {
    map.value?.flyTo({
      center: result.center,
      zoom: 10,
    });

    new mapboxgl.Marker({ element: buildBloPlaceMarker(), anchor: 'center' })
      .setLngLat(result.center)
      .addTo(map.value!);
  } else {
    console.error("No coordinates found for this result");
    showGeocoderError(
      "Unable to find location. Please try a different search."
    );
  }
};

/** Phase 4c: handle a place suggestion picked inside the unified Ask input.
 *  PromptInput emits this when the user clicks a suggestion in its inline
 *  strip. Phase 4e: we now try to resolve the place to a US county GEOID
 *  first (so "Charlotte" opens the inspect rail for Mecklenburg County
 *  instead of dropping a pin on city streets). Falls back to the prior
 *  generic flyTo+marker behavior when resolution fails (e.g. national
 *  parks, cross-county places). */
const handlePlaceSelection = (suggestion: { center: [number, number]; name: string; raw: any }) => {
  currentGeocoderResult.value = suggestion.raw;
  const geoId = resolvePlaceToCountyGeoId(suggestion);
  if (geoId) {
    inspectCounty(geoId);
  } else {
    handleGeocoderResult(suggestion.raw);
  }
};

/** Ray-casting point-in-polygon test for a single ring of [lng, lat] points. */
const pointInRing = (point: [number, number], ring: [number, number][]): boolean => {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
};

/** Test whether a point sits inside a Polygon or MultiPolygon feature.
 *  For Polygon, the first ring is the outer boundary; subsequent rings
 *  are holes (we treat any-ring containment as inside, accepting some
 *  imprecision around enclaves — fine for county boundaries). */
const pointInFeature = (point: [number, number], feature: any): boolean => {
  if (!feature?.geometry) return false;
  const geom = feature.geometry;
  if (geom.type === 'Polygon') {
    return pointInRing(point, geom.coordinates[0] as [number, number][]);
  }
  if (geom.type === 'MultiPolygon') {
    for (const polygon of geom.coordinates) {
      if (pointInRing(point, polygon[0] as [number, number][])) return true;
    }
  }
  return false;
};

/** Resolve a Mapbox place feature to a county GEOID. Tries the fast path
 *  (Mapbox returned a `district` type — already a county) before doing a
 *  point-in-polygon walk over the county GeoJSON. Returns null when no
 *  containing county is found (e.g. multi-county features, the place is
 *  outside the US). */
const resolvePlaceToCountyGeoId = (
  suggestion: { center: [number, number]; name: string; raw: any },
): string | null => {
  if (!countiesData.value) return null;
  const features = countiesData.value.features;
  // Fast path: Mapbox `district` features for US counties have the
  // GEOID embedded in the place context. We don't currently parse it
  // — the point-in-polygon path is reliable enough for v1.
  const center = suggestion.center;
  if (!Array.isArray(center) || center.length < 2) return null;
  for (const f of features) {
    if (pointInFeature(center, f)) {
      const geoId = (f as any).properties?.GEOID;
      if (typeof geoId === 'string') return geoId;
    }
  }
  return null;
};

// ============= Phase 3: LLM chat with tool use =============

/**
 * What the public map's chat drives. The canvas builds one of these too — a
 * bare canvas is a complete map — and this is that, plus the two tools only
 * the public chrome can answer for: the ranking panel and the land search.
 */
const toolContext: ToolContext = {
  get map() { return map.value; },
  /** Phase 4g atomic mutator. The full desired state lands in one call, so
   *  the chat reply and the rankings panel can never disagree — they read
   *  from the same refs we just wrote. */
  applyQueryState: (input) => {
    state.applyQueryState(input);
  },
  openCountyModal: (geoId) => {
    openCountyModalById(geoId);
    zoomToGeoId(geoId);
  },
  toggleRankingPanel: (expanded) => {
    rankingPanelExpanded.value = expanded;
  },
  triggerHousingSearch: (county) => {
    // Center map on the county first, then the user can click "Find land for sale"
    zoomToGeoId(county.geoId);
    // Note: full housing search requires a geocoder result shape; this opens
    // the county and lets the existing listings flow work. Full auto-trigger
    // deferred as a refinement.
  },
  zoomToGeoId: (geoId) => {
    zoomToGeoId(geoId);
  },
  // P5-26's show_layer lives on the canvas: turning a layer on is as much
  // about this map's style as it is about the selection.
  showLayer: (layerId, on) =>
    canvas.value?.showLayer(layerId, on) ?? Promise.resolve(null),
  getTopRankedCounties: async (limit) => {
    // The scoring pipeline is a chain of synchronous lazy computeds
    // (selected-layer refs → all → scoringQuery → scores → ranked), so a
    // read here is already settled the moment applyQueryState's ref writes
    // return. One nextTick drains any pending reactive effects
    // deterministically — no arbitrary sleep.
    await nextTick();
    return state.topRankedCounties(limit);
  },
};

const chat = useChat(toolContext, {
  getActiveFilters: () => activeFilters.value,
  /** Phase 4g: snapshot capture at turn end. Reads the live refs that
   *  drive scoring/filtering/ranking so a future replay can recreate
   *  the exact same map state. */
  getSnapshot: () => ({
    layers: scoringQuery.value.map(l => ({
      layerId: l.layerId,
      weight: l.weight,
      direction: l.direction,
    })),
    filters: activeFilters.value.map(f => ({ ...f })),
    limit: activeLimit.value,
    regionStates: [...rankingRegionStates.value],
    currentCountyId: currentCounty.value?.id ?? null,
    currentCountyName: currentCounty.value?.name ?? null,
    listingsCount: listings.value.length,
  }),
  /** Phase 4g: replay a snapshot. Same code path applyQueryState uses
   *  for the LLM tool, plus optional inspect-rail restoration. */
  applySnapshot: (snap) => {
    toolContext.applyQueryState({
      layers: snap.layers,
      filters: snap.filters,
      limit: snap.limit,
      regionStates: snap.regionStates,
      explanation: '',
    });
    if (snap.currentCountyId) {
      // Restore inspect rail to the snapshot's county. During early
      // hydration (before the counties source / map exist) stash the
      // GEOID; the map's `load` handler replays it once ready.
      if (countiesData.value && map.value) {
        pendingInspectGeoId.value = null;
        inspectCounty(snap.currentCountyId);
      } else {
        pendingInspectGeoId.value = snap.currentCountyId;
      }
    } else {
      // Snapshot had no county selected — make sure the rail is closed
      // and any not-yet-replayed pending inspect is discarded.
      pendingInspectGeoId.value = null;
      if (inspectActive.value) closeInspect();
    }
    // Listings re-fetch is deferred (see spec); just leave the listings
    // panel state alone — user can re-run Find Land if they care.
  },
});

// ============= P5-16: saved data views =============
// A saved view = TurnSnapshot + viewport + prompt + a bounded results
// snapshot, stored server-side (library/views/<slug>.json) so it can be
// embedded in wiki pages and restored by any internal user via ?view=<slug>.

const route = useRoute();
const router = useRouter();
const { internalUser } = useAuth();

/**
 * P5-71 / P5-74: "Show a layer on the map" ticks off the first-run checklist
 * the moment a layer actually goes on — a checkbox, a `?layers=` deep link, a
 * saved view, the chat's show_layer tool, all of them. Watching the count
 * rather than each toggle means there is one rule and no site to forget; the
 * BLO layer the map opens with is already selected before this watcher runs,
 * so merely loading the map ticks nothing. Progress is internal-only, exactly
 * as App.vue's route recorder is.
 */
const activeLayerCount = computed(
  () =>
    allSelectedLayers.value.length +
    selectedInternalFeatureLayers.value.length +
    contaminationLayers.filter(l => l.visible).length
);
watch(activeLayerCount, (now, before) => {
  if (now > before && internalUser.value) completeFirstRunStep("map");
});



// ============= P5-28: entity rail =============
const entityRailLayers = computed<EntityRailLayer[]>(() =>
  selectedInternalFeatureLayers.value
    .map(id => {
      const layer = internalPointLayers.value.find(l => l.id === id);
      if (!layer) return null;
      return { id, slug: layer.slug, geometry: layer.geometry, name: layer.name, color: layer.color, popupFields: layer.popupFields, features: internalPointData.value[id]?.features ?? [] };
    })
    .filter((l): l is EntityRailLayer => l !== null),
);

/** The entity rail shares the county rail's slot: it shows whenever an
 *  overlay layer is on and nothing county-shaped is open. */
const entityRailLoading = computed(() => selectedInternalFeatureLayers.value.some(id => !internalPointData.value[id]));

const entityRailVisible = computed(
  () => entityRailLayers.value.length > 0 && !entityRailDismissed.value && !railVisible.value,
);


// ============= P5-36: map deep links (?layers=…&focus=…) =============
const pendingDeepLink = ref(false);
let deepLinkApplied = "";


const applyMapDeepLink = async (): Promise<void> => {
  const key = JSON.stringify([route.query.layers ?? null, route.query.focus ?? null, route.query.fit ?? null]);
  const { layers, focus, fit, bounds } = parseMapDeepLink(route.query as Record<string, string | string[] | null | undefined>);
  if ((layers.length === 0 && fit.length === 0 && !bounds) || key === deepLinkApplied) return;
  if (!map.value || !countiesData.value) {
    pendingDeepLink.value = true;
    return;
  }
  deepLinkApplied = key;
  // Internal ids exist only after login + manifest; logged out they are simply dropped.
  if (layers.some(isInternalLayerId) && internalManifestLoaded) await internalManifestLoaded;
  const pointLayerIds: string[] = [];
  for (const id of layers) {
    if (!isInternalLayerId(id)) {
      await canvas.value?.ensurePublicLayerOn(id);
    } else if (internalLayers.value.some(l => l.id === id)) {
      if (!selectedInternalLayers.value.includes(id)) toggleInternalLayer(id);
    } else if (internalPointLayers.value.some(l => l.id === id)) {
      pointLayerIds.push(id);
      if (!selectedInternalFeatureLayers.value.includes(id)) toggleInternalFeatureLayer(id);
    }
  }
  if (bounds) {
    // P5-74: `?fit=bbox:…` — the frame a "Show on map" link computed from the
    // layer's own points, so a Memphis layer opens on Memphis.
    map.value.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 60, maxZoom: 10, duration: 900 });
  } else if (fit.length > 0) {
    // P5-55: `?fit=` frames the counties being compared, so "Show on map" from
    // /compare lands on them rather than on the whole country. Wider padding
    // and a lower max zoom than a single-county zoom: the point is seeing them
    // together, with their neighbours for context.
    fitToGeoIds(fit, { padding: 80, maxZoom: 8, duration: 900 });
  } else if (pointLayerIds.length > 0 && !focus) {
    // P5-74: a link that names a point layer but carries no frame of its own
    // still moves the map — to the extent of the points once they land. County
    // layers fall through and keep the national view, and a `?focus=` link is
    // left alone: it is about to fly to one point, not to the whole extent.
    const collection = await canvas.value?.waitForPointData(pointLayerIds[0]);
    const box = collection ? boundsForFeatures(collection.features) : null;
    if (box && map.value) {
      map.value.fitBounds([[box[0], box[1]], [box[2], box[3]]], { padding: 60, maxZoom: 10, duration: 900 });
    }
  }
  if (focus && internalPointLayers.value.some(l => l.id === focus.layerId)) {
    const collection = await canvas.value?.waitForPointData(focus.layerId);
    const index = (collection?.features ?? []).findIndex(f => f.properties._label === focus.label);
    if (index >= 0) canvas.value?.focusEntity({ layerId: focus.layerId, index });
  }
};

watch(
  () => [route.query.layers, route.query.focus, route.query.fit],
  () => {
    void applyMapDeepLink();
  },
  { immediate: true },
);




watch(
  internalUser,
  (user, previous) => {
    if (user) {
      internalManifestLoaded = loadInternalLayers();
      return;
    }
    entityRailDismissed.value = false;
    teardownInternalLayers();
    // Only on an actual logout (not the immediate first run for a public
    // visitor): the thread may name internal layers and counts (P5-19).
    if (previous) chat.clearConversation();
  },
  { immediate: true },
);

const saveViewOpen = ref(false);
const saveViewName = ref("");
const saveViewSaving = ref(false);
const saveViewNote = ref("");
/** P5-69: the slug just saved, so the note can link to the view like the table and compare do. */
const savedViewSlug = ref("");
const saveViewError = ref("");
/** Restore requested before the map/counties existed — replayed once in
 *  the map's `load` handler, same deferral pattern as pendingInspectGeoId. */
const pendingViewSlug = ref<string | null>(null);

const openSaveView = () => {
  saveViewOpen.value = true;
  saveViewNote.value = "";
  saveViewError.value = "";
};

const closeSaveView = () => {
  saveViewOpen.value = false;
  saveViewError.value = "";
};

/** The most recent user chat message — stored with the view so a wiki
 *  reader can see the question that produced the ranking. */
const lastUserPrompt = (): string => {
  const msgs = chat.messages.value;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" || m.isError) continue;
    if (typeof m.displayText === "string" && m.displayText) return m.displayText;
    if (typeof m.content === "string") return m.content;
    return "";
  }
  return "";
};

/** The Lens's contamination rows, through the canvas: switching one on is a
 *  fetch and a style change, which is the canvas's business (P5-74). */
const toggleContaminationLayer = (layerId: string): void => {
  void canvas.value?.toggleContaminationLayer(layerId);
};
const retryContaminationLayer = (layerId: string): void => {
  void canvas.value?.retryContaminationLayer(layerId);
};
const toggleContaminationLayers = (): void => {
  void canvas.value?.toggleContaminationLayers();
};

/** The contamination site layers that are on right now — what a saved view
 *  remembers, and what a restore is compared against (P5-78). */
const visibleSiteLayerIds = (): string[] =>
  contaminationLayers.filter(l => l.visible).map(l => l.id);

/** Put the contamination layers back the way the view had them (P5-78).
 *  Every layer switched on goes through the on-demand path, so its GeoJSON is
 *  fetched here and not at startup. */
const restoreSiteLayers = async (saved: unknown): Promise<void> => {
  const { on, off } = siteLayerRestore(saved, visibleSiteLayerIds());
  if (on.length === 0 && off.length === 0) return;
  for (const id of off) await canvas.value?.setContaminationLayer(id, false);
  await Promise.all(on.map(id => canvas.value?.setContaminationLayer(id, true)));
};

/** Snapshot the visible ranking (region-filtered, display-limited — the
 *  same rows the RankingPanel shows) into embed-ready result rows. */
const snapshotResults = (): SavedViewResult[] => {
  const region = rankingRegionStates.value.length > 0
    ? new Set(rankingRegionStates.value.map(s => s.toUpperCase()))
    : null;
  const eligible = region
    ? rankedCounties.value.filter(c => region.has(getStateAbbrFromGeo(c.geoId).toUpperCase()))
    : rankedCounties.value;
  const limit = Math.min(activeLimit.value ?? 20, VIEW_RESULTS_MAX);
  return eligible
    .filter(c => c.score != null)
    .slice(0, limit)
    .map((c, i) => ({
      rank: i + 1,
      geoId: c.geoId,
      name: getCountyName(c.geoId),
      state: getStateName(c.geoId),
      score: c.score ?? 0,
    }));
};

const submitSaveView = async () => {
  const name = saveViewName.value.trim();
  if (!name || saveViewSaving.value) return;
  saveViewSaving.value = true;
  saveViewError.value = "";
  // P5-78: the contamination site layers that are on. Omitted when none are,
  // so a view of the plain map is the document it always was.
  const siteLayers = visibleSiteLayerIds();
  try {
    const saved = await saveView({
      name,
      state: {
        layers: scoringQuery.value.map(l => ({
          layerId: l.layerId,
          weight: l.weight,
          direction: l.direction,
        })),
        filters: activeFilters.value.map(f => ({ ...f })),
        limit: activeLimit.value,
        regionStates: [...rankingRegionStates.value],
        prompt: lastUserPrompt(),
        pointLayers: selectedInternalFeatureLayers.value.map(id => ({
          id,
          name: internalPointLayers.value.find(l => l.id === id)?.name ?? id,
        })),
        ...(siteLayers.length > 0 ? { siteLayers } : {}),
        viewport: map.value
          ? {
              center: [map.value.getCenter().lng, map.value.getCenter().lat] as [number, number],
              zoom: map.value.getZoom(),
            }
          : null,
      },
      results: snapshotResults(),
    });
    saveViewOpen.value = false;
    saveViewName.value = "";
    savedViewSlug.value = saved.slug;
    saveViewNote.value = `Saved — open “${saved.name ?? saved.slug}” · embed it in a page with view:${saved.slug}`;
  } catch (err) {
    saveViewError.value = err instanceof Error ? err.message : "Couldn't save the view.";
  } finally {
    saveViewSaving.value = false;
  }
};

/** Restore a saved view (?view=<slug>): re-apply its layers/filters/limit/
 *  region through the same atomic mutator the LLM tools use, then jump the
 *  viewport. Field checks are defensive — the state payload is opaque to
 *  the server, so a hand-edited document must degrade, not throw. */
const applySavedView = async (slug: string) => {
  if (!map.value || !countiesData.value) {
    pendingViewSlug.value = slug;
    return;
  }
  try {
    // A view may reference internal layers — they have to be registered
    // before applyQueryState routes ids, or they would be dropped (P5-18).
    if (internalManifestLoaded) await internalManifestLoaded;
    const view = await fetchView(slug);
    if (!view) {
      console.warn(`[views] no such view: ${slug}`);
      return;
    }
    // P7-4: one reader of a saved map view's state, shared with the map block
    // a page can embed (`mapStateOf`). It was inline here until a second
    // surface needed the same answer.
    const saved = mapStateOf(view);
    if (!saved) {
      console.warn(`[views] ${slug} is a ${view.type} view — nothing here can draw it`);
      return;
    }
    toolContext.applyQueryState({
      layers: saved.layers,
      filters: saved.filters,
      limit: saved.limit,
      regionStates: saved.regionStates,
      explanation: "",
    });
    // P5-24: point layers are overlays outside the scoring query.
    setInternalFeatureLayers(saved.pointLayers);
    if (saved.viewport) map.value?.jumpTo(saved.viewport);
    // P5-78: last, because switching a site layer on downloads its GeoJSON
    // (P5-74) — the query, the point layers and the viewport must not wait
    // for it.
    await restoreSiteLayers(saved.siteLayers);
  } catch (err) {
    // A logged-out visitor's fetch 401s here — the guarded /views/:slug
    // shim is the shareable entry point, so just log and show the map.
    console.warn("[views] restore failed:", err instanceof Error ? err.message : err);
  }
};

watch(
  () => route.query.view,
  (slug) => {
    if (typeof slug === "string" && slug) void applySavedView(slug);
  },
  { immediate: true },
);

onMounted(() => {
  debugLog("Component mounted");

  // The county-name lookup feeds the chat tools and the layer tables, not the
  // first paint. It loads alongside the canvas's own county files; nothing
  // waits on it.
  void initCountyLookup().catch((err) => {
    console.warn("County lookup failed to initialize:", err);
  });

  // Phase 4c: the geocoder instance is kept for `usePropertyListings`
  // (it consumes `geocoderRef.value.clear()` to reset the search bar) but
  // its DOM is no longer rendered. Place lookup happens via direct fetch
  // calls inside PromptInput; selection routes here through
  // `handlePlaceSelection` which sets `currentGeocoderResult` and flies the map.
  geocoder = new MapboxGeocoder({
    accessToken: MAPBOX_ACCESS_TOKEN,
    mapboxgl: mapboxgl,
    countries: MAP_CONFIG.GEOCODER_COUNTRIES,
    types: "country,region,postcode,district,place",
    placeholder: "Search for a location",
  });
  geocoderRef.value = geocoder;

  const tooltipIcons = document.querySelectorAll(".tooltip-icon");
  tooltipIcons.forEach((icon) => {
    icon.addEventListener("mouseenter", () => {
      // Non-null + HTMLElement: every .tooltip-icon ships with a
      // .tooltip-text child in the template; `!` preserves the original
      // (would-throw-on-missing) runtime behavior.
      const tooltip = icon.querySelector<HTMLElement>(".tooltip-text")!;
      const iconRect = icon.getBoundingClientRect();

      // Position the tooltip above the icon
      tooltip.style.left = `${iconRect.left}px`;
      tooltip.style.top = `${iconRect.top - tooltip.offsetHeight - 10}px`;

      // Check if tooltip is going off the left side of the screen
      if (tooltip.getBoundingClientRect().left < 0) {
        tooltip.style.left = "0px";
      }

      // Check if tooltip is going off the right side of the screen
      if (tooltip.getBoundingClientRect().right > window.innerWidth) {
        tooltip.style.left = `${window.innerWidth - tooltip.offsetWidth}px`;
      }
    });
  });
});

onBeforeUnmount(() => {
  cancelEntryHandoff();
  clearAllWalkthroughMarkers();
  // The registry entries this instance holds go with it; the shared manifest
  // and values caches stay, because another map may be reading them (P6-10).
  teardownInternalLayers(false);
});

/** The canvas has a map. Everything the chrome does to it starts here. */
const onCanvasReady = (ctx: ToolContext) => {
  map.value = ctx.map;
};

/** The counties source and the choropleth are up: the overlays exist, so the
 *  deferred replays that needed polygons can run. */
const onCountiesReady = () => {
  // Replay a snapshot-restored inspect that arrived during chat hydration,
  // before county data and the map existed.
  if (pendingInspectGeoId.value) {
    const geoId = pendingInspectGeoId.value;
    pendingInspectGeoId.value = null;
    inspectCounty(geoId);
  }

  // Replay a saved-view restore (?view=<slug>) that arrived before the map
  // existed (P5-16). Applied after pendingInspectGeoId so the view's query
  // state wins if both are somehow queued.
  if (pendingViewSlug.value) {
    const slug = pendingViewSlug.value;
    pendingViewSlug.value = null;
    void applySavedView(slug);
  }
  // Same deferral for ?layers= deep links (P5-36).
  if (pendingDeepLink.value) {
    pendingDeepLink.value = false;
    void applyMapDeepLink();
  }
};

/** A county was clicked on the canvas. Phase 4e: that opens the inspect rail
 *  — except during a walkthrough, where a stray click must not derail the
 *  tour; the user has to Exit first. */
const onCountyClick = (geoId: string) => {
  if (walkthroughActive.value) return;
  inspectCounty(geoId);
};

</script>

<style scoped>
/* Map fills the parent's remaining space (App.vue sets <main> to flex: 1
   of a 100vh container). No more 80vh hardcode + 20vh of empty space. */
.map-root {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* Phase 4d: .bottom-left-panels removed — Lens owns this slot */

.download-csv-button {
  background-color: #4caf50;
  color: white;
  padding: 5px 10px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 10px;
}

.download-csv-button:hover {
  background-color: #45a049;
}

.listing-card {
  cursor: pointer;
}

.listing-card:hover {
  background-color: #f5f5f5;
}

.google-maps-link {
  display: block;
  margin-top: 5px;
  color: #0066cc;
  text-decoration: none;
}

.google-maps-link:hover {
  text-decoration: underline;
}

.listings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.toggle-listings-button {
  background: none;
  border: none;
  font-size: 16px;
  cursor: pointer;
  padding: 5px;
}

.loader {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 3px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: #fff;
  animation: spin 1s ease-in-out infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.search-listings {
  display: flex;
  flex-direction: row;
  gap: 10px;
}

.listings-button {
  background-color: #4caf50;
  color: white;
  padding: 12px 20px;
  margin-top: 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 150px;
  min-height: 44px;
}

.listings-button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.listings-button:hover:not(:disabled) {
  background-color: #45a049;
}

.listings-button:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
}

.clear-search-button {
  background-color: #f44336;
  color: white;
  padding: 12px 20px;
  margin-top: 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 150px;
  min-height: 44px;
}

.clear-search-button:hover {
  background-color: #da190b;
}

.clear-search-button:focus {
  outline: 2px solid #4a90e2;
  outline-offset: 2px;
}

.listings-panel {
  position: absolute;
  left: 10px;
  top: 20vh;
  background: white;
  color: black;
  padding: 15px;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  max-width: 300px;
  max-height: 80vh;
  overflow-y: auto;
  z-index: 1;
}

.listing-card {
  border-bottom: 1px solid #eee;
  padding: 10px 0;
}

.listing-card:last-child {
  border-bottom: none;
}

.listing-popup {
  color: black;
  padding: 5px;
}

.listing-popup h4 {
  color: black;
  margin: 0 0 5px 0;
}

.listing-popup p {
  color: black;
  margin: 2px 0;
}

@media (max-width: 768px) {
  .listings-panel {
    color: black;
    left: 10px;
    right: 10px;
    top: 110px;
    max-width: none;
    max-height: calc(100vh - 220px);
  }

  .search-listings {
    flex-direction: column;
    gap: 5px;
  }

  .listings-button,
  .clear-search-button {
    margin-top: 10px;
    width: 100%;
  }
}

/* Duplicate styles removed - now in LayerControls.vue and AveragesPanel.vue */

.color-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 5px;
}

.layer-item label {
  display: flex;
  align-items: center;
}

.layer-item input[type="checkbox"] {
  margin-right: 5px;
}


.mapboxgl-popup-content h3 {
  margin: 0 0 10px 0;
  font-size: 16px;
}

.mapboxgl-popup-content h4 {
  margin: 10px 0 5px 0;
  font-size: 14px;
}

.mapboxgl-popup-content p {
  margin: 2px 0;
}

.tooltip-icon {
  display: inline-block;
  margin-left: 5px;
  font-size: 12px;
  position: relative;
  cursor: help;
  color: #666;
}

.tooltip-text {
  visibility: hidden;
  background-color: black;
  color: white;
  text-align: left;
  padding: 5px 10px;
  border-radius: 6px;
  position: fixed; /* Change from absolute to fixed */
  z-index: 1000; /* Increase z-index to ensure it's above other elements */
  width: 200px;
  height: auto;
  opacity: 0;
  transition: opacity 0.3s;
  font-size: 12px;
  pointer-events: none;
  white-space: normal;
  line-height: 1.4;
}

.tooltip-icon:hover .tooltip-text {
  visibility: visible;
  opacity: 1;
}

/* Add a pseudo-element for the tooltip arrow */
.tooltip-text::after {
  content: "";
  position: absolute;
  top: 100%;
  right: 15px; /* Position the arrow on the right side */
  border-width: 5px;
  border-style: solid;
  border-color: black transparent transparent transparent;
}

.tooltip-icon:hover .tooltip-text {
  visibility: visible;
  opacity: 1;
}

/* Duplicate #detailed-popup styles removed - now in CountyModal.vue */

/* Phase 4c: dedicated geocoder DOM removed — see PromptInput's place-strip */

.layer-control-toggle {
  background-color: white;
  border: none;
  padding: 5px 10px;
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
}

.layer-control-collapsed .layer-control-toggle {
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

#layer-control-container {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

#layer-control {
  margin-top: 5px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}

@media (max-width: 768px) {
  #layer-control-container {
    top: auto;
    bottom: 10px;
    right: 10px;
    left: 10px;
  }

  .layer-control-toggle {
    width: 100%;
  }

  #layer-control {
    width: 100%;
    max-height: 50vh;
  }
}

/* P5-16 / P5-74: Save view, now a row inside the Lens panel (internal users
   only) instead of a control floating on top of it. */
.save-view-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
}

.save-view-toggle {
  background-color: white;
  border: none;
  padding: 5px 10px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
}

.save-view-form {
  display: flex;
  gap: 4px;
  background-color: white;
  padding: 5px;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
}

.save-view-name {
  font-size: 13px;
  padding: 4px 6px;
  border: 1px solid #ccc;
  border-radius: 3px;
  min-width: 0;
  flex: 1 1 120px;
}

.save-view-save,
.save-view-cancel {
  border: none;
  padding: 4px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 3px;
  background-color: #1f7a2e;
  color: white;
}

.save-view-save:disabled {
  opacity: 0.5;
  cursor: default;
}

.save-view-cancel {
  background-color: #eee;
  color: #333;
}

.save-view-note {
  font-size: 12px;
  color: #1f7a2e;
  flex: 1 1 100%;
  overflow-wrap: anywhere;
}

.save-view-error {
  color: #b91c1c;
}
</style>

<!-- Unscoped: mapboxgl mounts marker DOM outside the component tree, so
     scoped selectors don't apply. These rules style the listing pins
     and respond to hover/selected state set by the composable. -->
<style>
.mapboxgl-marker.listing-marker {
  z-index: 1;
}
.mapboxgl-marker.listing-marker svg {
  transition: transform 0.15s ease, filter 0.15s ease;
  transform-origin: bottom center;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25));
}
.mapboxgl-marker.listing-marker:hover svg,
.mapboxgl-marker.listing-marker--hovered svg {
  transform: scale(1.25);
  filter: drop-shadow(0 2px 6px rgba(31, 122, 46, 0.45)) brightness(1.1);
}
/* Selected: bigger pop, warm amber halo, raised z-index. The fill
   stays BLO green so the user's eye travels naturally between
   the green card border and the green pin — the difference is the
   amber halo and the larger scale. */
.mapboxgl-marker.listing-marker--selected {
  z-index: 3;
}
.mapboxgl-marker.listing-marker--selected svg {
  transform: scale(1.55);
  filter:
    drop-shadow(0 0 0 #d97706)
    drop-shadow(0 0 6px rgba(217, 119, 6, 0.85))
    drop-shadow(0 3px 8px rgba(0, 0, 0, 0.3));
}
</style>
