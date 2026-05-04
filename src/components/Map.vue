<template>
  <div id="map" ref="mapContainer" class="map-root">
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
      :send-message="chat.sendMessage"
      :clear-conversation="chat.clearConversation"
      @select-place="handlePlaceSelection"
    />

    <!-- The floating "Available Properties" panel is gone — its content
         now lives inside CountyRail's third view (listings), opened from
         the "view N listings" link under the Find land CTA. The map
         markers (blue pins) remain as the spatial visualization. -->

    <!-- Phase 4d L4: standalone LayerControls pill removed.
         Layer picking now lives inside the Lens "Layers" tab. -->
    <LoadingIndicator :loaded="layersLoaded" :progress="loadingProgress" />

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
    <Lens>
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
          @toggle-contamination="toggleContaminationLayer"
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
      @toggle="toggleRankingPanel"
      @select-county="selectCountyFromRanking"
      @clear-filters="clearActiveFilters"
      @start-walkthrough="startWalkthrough"
    />

    <CountyRail
      :visible="walkthroughActive || (inspectActive && !showDetailedPopup)"
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
      :current-geo-id="currentCounty?.id || null"
      :land-search="railLandSearchState"
      @prev="walkthroughPrev"
      @next="walkthroughNext"
      @exit="handleRailExit"
      @view-details="openWalkthroughDetails"
      @select-county="inspectCounty"
      @search-land="handleRailSearchLand"
      @clear-land="clearSearch"
      @select-listing="handleRailSelectListing"
      @hover-listing="handleRailHoverListing"
      @download-listings="downloadCSV"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive, watch, computed } from "vue";
import mapboxgl, { type Expression, type Map } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { usePropertyListings } from "@/composables/usePropertyListings";
import { useMapData } from "@/composables/useMapData";
import { useColorCalculation } from "@/composables/useColorCalculation";
import {
  DEMOGRAPHIC_LAYERS,
  CONTAMINATION_LAYERS,
  ECONOMIC_LAYERS,
  HOUSING_LAYERS,
  EQUITY_LAYERS,
  TRANSPORTATION_LAYERS,
} from "@/config/layerConfig";
import {
  DEV_MODE_DEMOGRAPHICS_ONLY,
  debugLog,
  MAPBOX_ACCESS_TOKEN,
  MAP_CONFIG,
} from "@/config/constants";
import type { ColorBlend, ScoringQuery, ScoringFilter } from "@/types/mapTypes";
import { LAYER_REGISTRY } from "@/config/layerRegistry";
import { NATIONAL_AVERAGES } from "@/config/nationalAverages";
import { usePersonalizedScore, type DataMaps } from "@/composables/usePersonalizedScore";
// BLO_PRESET available in @/config/presets for future "load preset" feature
import CountyModal from "@/components/CountyModal.vue";
import LayerControls from "@/components/LayerControls.vue";
import LoadingIndicator from "@/components/LoadingIndicator.vue";
import RankingPanel from "@/components/RankingPanel.vue";
import CountyRail from "@/components/CountyRail.vue";
import Lens from "@/components/Lens.vue";
import LensHeader from "@/components/LensHeader.vue";
import LensLegend from "@/components/LensLegend.vue";
import LensLayers from "@/components/LensLayers.vue";
import LensContext from "@/components/LensContext.vue";
import WelcomeCard from "@/components/WelcomeCard.vue";
import PromptInput from "@/components/PromptInput.vue";
import type { QueryResponse } from "@/composables/usePromptQuery";
import { useChat } from "@/composables/useChat";
import { initCountyLookup, findCounty } from "@/lib/countyLookup";
import type { ToolContext } from "@/lib/mapTools";

const mapContainer = ref<HTMLElement | null>(null);
const map = ref<mapboxgl.Map | null>(null);
let geocoder: MapboxGeocoder;
const geocoderRef = { value: undefined as MapboxGeocoder | undefined };
const detailedPopup = ref<HTMLElement | null>(null);

// Initialize map data composable
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
  loadAllCountyData,
} = useMapData();

// Initialize color calculation composable
const {
  preCalculatedColors,
  colorCalculationComplete,
  preCalculateColors,
  getColorForLayer,
} = useColorCalculation(
  diversityData,
  lifeExpectancyData,
  countyContaminationCounts,
  combinedScoresData
);

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
const showContaminationLayers = ref(false);
const showContaminationChoropleth = ref(false);
const showDiversityChoropleth = ref(true); // Start with true since BLO layer is pre-selected
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

/** Zoom the map to a county's bounds by GEOID.
 *  `regional: true` caps zoom at 7 and adds extra padding so neighboring counties
 *  remain visible — the right framing for walkthrough mode where county-tight
 *  zoom would just show a single polygon with no comparative context. */
const zoomToGeoId = (geoId: string, opts?: { regional?: boolean }): boolean => {
  if (!countiesData.value?.features || !map.value) return false;
  const feature = countiesData.value.features.find(
    (f: any) => f.properties?.GEOID === geoId
  );
  if (!feature) return false;
  const bounds = new mapboxgl.LngLatBounds();
  const coords = feature.geometry.type === 'MultiPolygon'
    ? feature.geometry.coordinates.flat(2)
    : feature.geometry.coordinates.flat(1);
  coords.forEach((coord: number[]) => bounds.extend(coord as [number, number]));
  const padding = opts?.regional ? 160 : 50;
  const maxZoom = opts?.regional ? 7 : 10;
  map.value.fitBounds(bounds, { padding, maxZoom, duration: 700 });
  return true;
};

/** Resolve county name from GEOID. Tries the data maps first, then falls
 *  back to the polygon GeoJSON's NAME property — which covers ~3220 features
 *  including territories that aren't in diversityData. Last resort is the
 *  raw GEOID string, but we should rarely hit that now. */
const getCountyName = (geoId: string): string => {
  const div = diversityData.value[geoId];
  if (div?.countyName) return div.countyName;
  const econ = economicData.value[geoId];
  if (econ?.county_name) return econ.county_name;
  const housing = housingData.value[geoId];
  if (housing?.county_name) return housing.county_name;
  // GeoJSON fallback: polygon features include NAME for every county we draw
  const feature = countiesData.value?.features.find(
    (f: any) => f.properties?.GEOID === geoId
  );
  const geoName = feature?.properties?.NAME;
  if (geoName && typeof geoName === 'string') return geoName;
  return geoId;
};

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
const layerWeights = ref<Record<string, number>>({})
const layerDirections = ref<Record<string, string>>({})

const showScoringControls = computed(() => allSelectedLayers.value.length >= 2)

const updateLayerWeight = (layerId: string, weight: number) => {
  layerWeights.value = { ...layerWeights.value, [layerId]: weight }
}

const updateLayerDirection = (layerId: string, direction: string) => {
  layerDirections.value = { ...layerDirections.value, [layerId]: direction }
}

/** Phase 4b: manual threshold filter edit from LayerControls.
 *  Replaces any existing filter for this layer; null removes it. */
const updateLayerFilter = (layerId: string, filter: ScoringFilter | null) => {
  const others = activeFilters.value.filter(f => f.layerId !== layerId)
  activeFilters.value = filter ? [...others, filter] : others
}

const closeDetailedPopup = () => {
  showDetailedPopup.value = false;
};

const toggleContaminationChoropleth = () => {
  if (!showContaminationChoropleth.value && isBLOPrecomputedMode()) {
    expandBLOPreset();
  }
  showContaminationChoropleth.value = !showContaminationChoropleth.value;
  updateChoroplethVisibility();
};

const selectedDemographicLayers = ref<string[]>(['combined_scores_v2']);
const selectedEconomicLayers = ref<string[]>([]);
const selectedHousingLayers = ref<string[]>([]);
const selectedEquityLayers = ref<string[]>([]);
const selectedTransportationLayers = ref<string[]>([]);

// Computed property to track ALL selected layers across categories
const allSelectedLayers = computed(() => {
  const layers = [
    ...selectedDemographicLayers.value,
    ...selectedEconomicLayers.value,
    ...selectedHousingLayers.value,
    ...selectedEquityLayers.value,
    ...selectedTransportationLayers.value,
  ].filter(layerId =>
    // Exclude BLO combined scores from multi-layer computation
    layerId !== 'combined_scores' && layerId !== 'combined_scores_v2'
  );

  // Add contamination if the choropleth is showing
  if (showContaminationChoropleth.value) {
    layers.push('contamination');
  }

  return layers;
});

// Build reactive scoring query from selected layers + weights + directions
const scoringQuery = computed<ScoringQuery>(() => {
  return allSelectedLayers.value.map(layerId => {
    const reg = LAYER_REGISTRY[layerId];
    return {
      layerId,
      weight: layerWeights.value[layerId] ?? 5,
      direction: (layerDirections.value[layerId] as 'higher_better' | 'lower_better') ?? reg?.direction ?? 'higher_better',
    };
  });
});

// Phase 4a: reactive filters and display limit (set by LLM, cleared manually)
const activeFilters = ref<ScoringFilter[]>([]);
const activeLimit = ref<number | null>(null);

/** Clear threshold filters without changing the scoring query or selected layers */
const clearActiveFilters = () => {
  activeFilters.value = [];
};

/** Phase 4d: name shown in the Lens header when no query is active.
 *  Reflects whatever single layer is rendering by default. */
const defaultLensLayerName = computed(() => {
  if (allSelectedLayers.value.length === 0) {
    return showContaminationChoropleth.value ? 'Contamination' : 'BLO Livability Index'
  }
  if (allSelectedLayers.value.length === 1) {
    return LAYER_REGISTRY[allSelectedLayers.value[0]]?.name ?? allSelectedLayers.value[0]
  }
  return 'BLO Livability Index'
})

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
const clearActiveQuery = () => {
  selectedDemographicLayers.value = ['combined_scores_v2'];
  selectedEconomicLayers.value = [];
  selectedHousingLayers.value = [];
  selectedEquityLayers.value = [];
  selectedTransportationLayers.value = [];
  showContaminationChoropleth.value = false;
  demographicLayers.forEach(l => { l.visible = l.id === 'combined_scores_v2'; });
  economicLayers.forEach(l => { l.visible = false; });
  housingLayers.forEach(l => { l.visible = false; });
  equityLayers.forEach(l => { l.visible = false; });
  transportationLayers.forEach(l => { l.visible = false; });
  layerWeights.value = {};
  layerDirections.value = {};
  activeFilters.value = [];
  activeLimit.value = null;
  rankingPanelExpanded.value = false;
  rankingStateFilter.value = '';
  hasActiveScoringQuery.value = false;
  showDiversityChoropleth.value = true;
  // D3: chat narration goes stale once the query clears — drop it.
  chat.clearConversation();
  // Phase 4e: clear any open inspect rail; its context is gone too.
  if (inspectActive.value) closeInspect();
  updateChoroplethVisibility();
  updateChoroplethColors();
};

// Phase 4a: walkthrough state
const walkthroughActive = ref(false);
const walkthroughIndex = ref(0);

// Phase 4e: single-county inspect mode. Mutually exclusive with walkthrough —
// only one rail mode is active at a time. Inspect is the default response to
// any "show me this county" intent (direct click, place pick, LLM tool).
const inspectActive = ref(false);

// Initialize scoring engine
const dataMaps: DataMaps = {
  diversityData,
  lifeExpectancyData,
  countyContaminationCounts,
  economicData,
  housingData,
  equityData,
  transportationData,
};

const {
  scores: personalizedScores,
  rankedCounties,
  filteredOutCountyIds,
} = usePersonalizedScore(scoringQuery, dataMaps, activeFilters);

/** Ranked counties after applying display limit */
const limitedRankedCounties = computed(() => {
  const limit = activeLimit.value;
  if (limit == null) return rankedCounties.value;
  return rankedCounties.value.slice(0, limit);
});

/** Phase 4d cleanup: walkthrough is reachable from the Lens header when
 *  there's at least one ranked county to tour. Discoverable on mobile
 *  (RankingPanel is display:none there) and when the RankingPanel is
 *  collapsed on desktop. */
const canWalkThrough = computed(() =>
  hasActiveScoringQuery.value && limitedRankedCounties.value.length > 0,
)

/** Phase 4c: GEOIDs of the top-N counties when a limit is active. Drives
 *  choropleth dim logic (non-top-N counties render at reduced alpha) and
 *  walkthrough overlays (set outline + numbered markers).
 *  Empty when no limit is set — choropleth renders normally. */
const topNGeoIds = computed<Set<string>>(() => {
  if (activeLimit.value == null) return new Set();
  if (allSelectedLayers.value.length < 1) return new Set();
  return new Set(limitedRankedCounties.value.map(c => c.geoId));
});

/** Look up the raw value for a layer in the appropriate data map.
 *  Mirrors `getRawLayerValue` from the tooltip closure but takes geoId
 *  as a parameter so it can be used outside that closure (e.g. by
 *  WalkthroughRail). Returns undefined when the layer or county is missing. */
const getRawLayerValueFor = (layerId: string, geoId: string): any => {
  const reg = LAYER_REGISTRY[layerId];
  if (!reg) return undefined;
  const key = reg.dataKey;
  switch (layerId) {
    case 'combined_scores_v2':
      return combinedScoresV2Data.value[geoId]?.blo_score_v2;
    case 'diversity_index':
      return diversityData.value[geoId]?.diversityIndex;
    case 'pct_Black':
      return diversityData.value[geoId]?.pct_Black;
    case 'life_expectancy':
      return lifeExpectancyData.value[geoId]?.lifeExpectancy;
    case 'contamination': {
      const c = countyContaminationCounts[geoId] as any;
      return typeof c === 'number' ? c : c?.total;
    }
    case 'avg_weekly_wage':
    case 'median_income_by_race':
      return (economicData.value[geoId] as any)?.[key];
    case 'median_home_value':
    case 'median_property_tax':
    case 'homeownership_by_race':
      return (housingData.value[geoId] as any)?.[key];
    case 'poverty_by_race':
    case 'black_progress_index':
      return (equityData.value[geoId] as any)?.[key];
    case 'commute_time':
    case 'drove_alone':
    case 'public_transit':
      return (transportationData.value[geoId] as any)?.[key];
    default:
      return undefined;
  }
};

/** Resolve a state name from diversityData (which carries STNAME). */
const getStateName = (geoId: string): string => {
  return diversityData.value[geoId]?.stateName || '';
};

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
    return {
      layerId,
      name: reg?.name ?? layerId,
      value: reg?.formatValue(raw) ?? '?',
      delta,
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

/** All counties sorted by the active scoring metric (BLO v2 by default,
 *  composite when ≥2 scoring layers). One pass over the data; filtered
 *  to entries that have BOTH a score and a name, so the list is clean. */
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
const STATE_ABBR_BY_NAME: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR',
  California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE',
  'District of Columbia': 'DC', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI',
  Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME',
  Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE',
  Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM',
  'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI',
  'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX',
  Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA',
  'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'American Samoa': 'AS', Guam: 'GU', 'Northern Mariana Islands': 'MP',
  'Puerto Rico': 'PR', 'U.S. Virgin Islands': 'VI',
};
function getStateAbbrFromGeo(geoId: string): string {
  const name = getStateName(geoId);
  return STATE_ABBR_BY_NAME[name] || name.substring(0, 2).toUpperCase();
}

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

/** Handle prompt query result: auto-select layers with weights and directions */
const handleQueryResult = (result: QueryResponse) => {
  if (!result.layers || result.layers.length === 0) return;

  // Phase 4c: any new query result invalidates a walkthrough in progress —
  // it would be referring to the old ranked set. Exit cleanly so overlays
  // and the rail don't show stale state, then let the user re-enter the
  // walkthrough from the new ranking via the panel.
  // Phase 4e: same logic applies to inspect mode — a new query is a new
  // context, so close any active inspection card.
  if (walkthroughActive.value) exitWalkthrough();
  if (inspectActive.value) closeInspect();

  // Clear everything
  selectedDemographicLayers.value = [];
  selectedEconomicLayers.value = [];
  selectedHousingLayers.value = [];
  selectedEquityLayers.value = [];
  selectedTransportationLayers.value = [];
  showContaminationChoropleth.value = false;
  demographicLayers.forEach(l => { l.visible = false; });
  economicLayers.forEach(l => { l.visible = false; });
  housingLayers.forEach(l => { l.visible = false; });
  equityLayers.forEach(l => { l.visible = false; });
  transportationLayers.forEach(l => { l.visible = false; });

  const newWeights: Record<string, number> = {};
  const newDirections: Record<string, string> = {};

  for (const layer of result.layers) {
    newWeights[layer.layerId] = layer.weight;
    newDirections[layer.layerId] = layer.direction;

    // Route to the correct category array
    const demoLayer = demographicLayers.find(l => l.id === layer.layerId);
    if (demoLayer) {
      selectedDemographicLayers.value.push(layer.layerId);
      demoLayer.visible = true;
      continue;
    }
    const econLayer = economicLayers.find(l => l.id === layer.layerId);
    if (econLayer) {
      selectedEconomicLayers.value.push(layer.layerId);
      econLayer.visible = true;
      continue;
    }
    const housLayer = housingLayers.find(l => l.id === layer.layerId);
    if (housLayer) {
      selectedHousingLayers.value.push(layer.layerId);
      housLayer.visible = true;
      continue;
    }
    const eqLayer = equityLayers.find(l => l.id === layer.layerId);
    if (eqLayer) {
      selectedEquityLayers.value.push(layer.layerId);
      eqLayer.visible = true;
      continue;
    }
    const transLayer = transportationLayers.find(l => l.id === layer.layerId);
    if (transLayer) {
      selectedTransportationLayers.value.push(layer.layerId);
      transLayer.visible = true;
      continue;
    }
    if (layer.layerId === 'contamination') {
      showContaminationChoropleth.value = true;
    }
  }

  layerWeights.value = newWeights;
  layerDirections.value = newDirections;

  // Phase 4a: apply filters and limit from the response.
  // Phase 4b: distinguish "LLM didn't touch filters" (undefined → preserve)
  // from "LLM explicitly cleared filters" (empty array → clear).
  if (result.filters !== undefined) {
    activeFilters.value = [...result.filters];
  }
  activeLimit.value = typeof result.limit === 'number' ? result.limit : null;

  showDiversityChoropleth.value = true;
  updateChoroplethVisibility();
  updateChoroplethColors();

  hasActiveScoringQuery.value = result.layers.length > 0;

  // UX-01: auto-open the ranking panel so the answer is visible without hunting for it
  if (result.layers.length >= 1) {
    rankingPanelExpanded.value = true;
  }
};

/** Clear BLO precomputed layer when user selects a different layer */
const clearBLO = () => {
  const bloIdx = selectedDemographicLayers.value.indexOf('combined_scores_v2');
  if (bloIdx !== -1) selectedDemographicLayers.value.splice(bloIdx, 1);
  const bloLayer = demographicLayers.find(l => l.id === 'combined_scores_v2');
  if (bloLayer) bloLayer.visible = false;
};

/** Check if BLO composite is the only selected layer (precomputed mode) */
const isBLOPrecomputedMode = () => {
  return selectedDemographicLayers.value.length === 1 &&
    selectedDemographicLayers.value[0] === 'combined_scores_v2' &&
    selectedEconomicLayers.value.length === 0 &&
    selectedHousingLayers.value.length === 0 &&
    selectedEquityLayers.value.length === 0 &&
    selectedTransportationLayers.value.length === 0 &&
    !showContaminationChoropleth.value;
};

const toggleDemographicLayer = (layerId: string) => {
  debugLog("TOGGLING " + layerId);
  const layer = demographicLayers.find((l) => l.id === layerId);
  if (!layer) return;

  if (layerId === "combined_scores" || layerId === "combined_scores_v2") {
    // BLO toggle: simple on/off for precomputed view
    if (selectedDemographicLayers.value.includes(layerId)) {
      selectedDemographicLayers.value = selectedDemographicLayers.value.filter(id => id !== layerId);
      layer.visible = false;
    } else {
      selectedDemographicLayers.value.push(layerId);
      layer.visible = true;
    }
  } else {
    const currentIndex = selectedDemographicLayers.value.indexOf(layerId);

    if (currentIndex === -1) {
      if (isBLOPrecomputedMode()) clearBLO();
      selectedDemographicLayers.value.push(layerId);
      layer.visible = true;
    } else {
      selectedDemographicLayers.value.splice(currentIndex, 1);
      layer.visible = false;
    }
  }

  showDiversityChoropleth.value = selectedDemographicLayers.value.length > 0;
  updateChoroplethVisibility();
  updateChoroplethColors();
};

const toggleEconomicLayer = (layerId: string) => {
  debugLog("TOGGLING ECONOMIC " + layerId);
  const layer = economicLayers.find((l) => l.id === layerId);
  if (!layer) return;

  const currentIndex = selectedEconomicLayers.value.indexOf(layerId);

  if (currentIndex === -1) {
    if (isBLOPrecomputedMode()) clearBLO();
    selectedEconomicLayers.value.push(layerId);
    layer.visible = true;
  } else {
    selectedEconomicLayers.value.splice(currentIndex, 1);
    layer.visible = false;
  }

  showDiversityChoropleth.value = selectedEconomicLayers.value.length > 0 || selectedDemographicLayers.value.length > 0;
  updateChoroplethVisibility();
  updateChoroplethColors();
};

const toggleHousingLayer = (layerId: string) => {
  debugLog("TOGGLING HOUSING " + layerId);
  const layer = housingLayers.find((l) => l.id === layerId);
  if (!layer) return;

  const currentIndex = selectedHousingLayers.value.indexOf(layerId);

  if (currentIndex === -1) {
    if (isBLOPrecomputedMode()) clearBLO();
    selectedHousingLayers.value.push(layerId);
    layer.visible = true;
  } else {
    selectedHousingLayers.value.splice(currentIndex, 1);
    layer.visible = false;
  }

  showDiversityChoropleth.value = selectedHousingLayers.value.length > 0 || selectedDemographicLayers.value.length > 0;
  updateChoroplethVisibility();
  updateChoroplethColors();
};

const toggleEquityLayer = (layerId: string) => {
  debugLog("TOGGLING EQUITY " + layerId);
  const layer = equityLayers.find((l) => l.id === layerId);
  if (!layer) return;

  const currentIndex = selectedEquityLayers.value.indexOf(layerId);

  if (currentIndex === -1) {
    if (isBLOPrecomputedMode()) clearBLO();
    selectedEquityLayers.value.push(layerId);
    layer.visible = true;
  } else {
    selectedEquityLayers.value.splice(currentIndex, 1);
    layer.visible = false;
  }

  showDiversityChoropleth.value = selectedEquityLayers.value.length > 0 || selectedDemographicLayers.value.length > 0;
  updateChoroplethVisibility();
  updateChoroplethColors();
};

const toggleTransportationLayer = (layerId: string) => {
  debugLog("TOGGLING TRANSPORTATION " + layerId);
  const layer = transportationLayers.find((l) => l.id === layerId);
  if (!layer) return;

  const currentIndex = selectedTransportationLayers.value.indexOf(layerId);

  if (currentIndex === -1) {
    if (isBLOPrecomputedMode()) clearBLO();
    selectedTransportationLayers.value.push(layerId);
    layer.visible = true;
  } else {
    selectedTransportationLayers.value.splice(currentIndex, 1);
    layer.visible = false;
  }

  showDiversityChoropleth.value = selectedTransportationLayers.value.length > 0 || selectedDemographicLayers.value.length > 0;
  updateChoroplethVisibility();
  updateChoroplethColors();
};

// ============= Phase 4c: Walkthrough overlays =============
//
// Two outline layers driven by Mapbox `filter` expressions on the counties
// source — set outline (all top-N) and active outline (current step). DOM
// markers (numbered chips) anchored at county centroids via mapboxgl.Marker.
// All overlays clear when walkthrough exits or the query clears.

const SET_OUTLINE_LAYER = "walkthrough-set-outline";
const ACTIVE_OUTLINE_LAYER = "walkthrough-active-outline";
const HOVER_OUTLINE_LAYER = "county-hover-outline";
// Inspect mode (single county selected via click): a soft halo, a crisp
// green outline, and a fill-opacity drop inside the polygon so the
// underlying Mapbox basemap detail (roads, towns, water) shows through.
const INSPECT_HALO_LAYER = "inspect-halo";
const INSPECT_OUTLINE_LAYER = "inspect-outline";

/** Created once on map load. Filters update reactively via watchers. */
const addWalkthroughOverlayLayers = () => {
  if (!map.value) return;
  if (map.value.getLayer(SET_OUTLINE_LAYER)) return;

  // Set outline — all top-N counties get a medium ink-soft border.
  map.value.addLayer({
    id: SET_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#2a2a2a",
      "line-width": 1.2,
      "line-opacity": 0.85,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Active outline — single current county gets a heavy ink border on top.
  map.value.addLayer({
    id: ACTIVE_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#111111",
      "line-width": 2.8,
      "line-opacity": 1.0,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Phase 4f: hover outline — thin ink line on the county under the cursor.
  // Sits on top of fill but below the heavier active/set outlines.
  map.value.addLayer({
    id: HOVER_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#111111",
      "line-width": 1.5,
      "line-opacity": 0.6,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Inspect halo — wide, soft green glow that gives the selected county
  // presence even when the user has zoomed out or is scanning the map.
  map.value.addLayer({
    id: INSPECT_HALO_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#1f7a2e",
      "line-width": 10,
      "line-opacity": 0.22,
      "line-blur": 4,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });

  // Inspect outline — crisp BLO-green border on the selected county.
  // Sits on top of every other line layer so it's never occluded.
  map.value.addLayer({
    id: INSPECT_OUTLINE_LAYER,
    type: "line",
    source: "counties",
    paint: {
      "line-color": "#1f7a2e",
      "line-width": 3,
      "line-opacity": 1,
    },
    filter: ["==", ["get", "GEOID"], "__none__"],
    layout: { visibility: "none" },
  });
};

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
const fitToTopN = (): boolean => {
  if (!map.value || !countiesData.value) return false;
  const counties = limitedRankedCounties.value;
  if (counties.length === 0) return false;
  const bounds = new mapboxgl.LngLatBounds();
  let hasAny = false;
  for (const c of counties) {
    const feature = countiesData.value.features.find(
      (f: any) => f.properties?.GEOID === c.geoId
    );
    if (!feature) continue;
    const coords = feature.geometry.type === "MultiPolygon"
      ? feature.geometry.coordinates.flat(2)
      : feature.geometry.coordinates.flat(1);
    coords.forEach((coord: number[]) => bounds.extend(coord as [number, number]));
    hasAny = true;
  }
  if (!hasAny) return false;
  map.value.fitBounds(bounds, { padding: 100, maxZoom: 9, duration: 1000 });
  return true;
};

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

const updateChoroplethVisibility = () => {
  if (!map.value) return;

  debugLog("Updating choropleth visibility:", {
    showContaminationChoropleth: showContaminationChoropleth.value,
    showDiversityChoropleth: showDiversityChoropleth.value,
  });

  const visibility =
    showContaminationChoropleth.value ||
    showDiversityChoropleth.value ||
    selectedDemographicLayers.value.includes("combined_scores") ||
    selectedDemographicLayers.value.includes("combined_scores_v2") ||
    selectedEconomicLayers.value.length > 0 ||
    selectedHousingLayers.value.length > 0 ||
    selectedEquityLayers.value.length > 0 ||
    selectedTransportationLayers.value.length > 0
      ? "visible"
      : "none";

  map.value.setLayoutProperty("county-choropleth", "visibility", visibility);

  if (visibility === "visible") {
    updateChoroplethColors();
  }
};

const contaminationLayers = DEV_MODE_DEMOGRAPHICS_ONLY
  ? []
  : reactive(CONTAMINATION_LAYERS);

const demographicLayers = reactive(DEMOGRAPHIC_LAYERS);
const economicLayers = reactive(ECONOMIC_LAYERS);
const housingLayers = reactive(HOUSING_LAYERS);
const equityLayers = reactive(EQUITY_LAYERS);
const transportationLayers = reactive(TRANSPORTATION_LAYERS);

const showLifeExpectancyChoropleth = ref(false);

const layersLoaded = ref(false);
const loadedLayersCount = ref(0);
// Update the totalLayers computed property
const totalLayers = computed(() => {
  const contaminationLayerCount = DEV_MODE_DEMOGRAPHICS_ONLY
    ? 0
    : contaminationLayers.length;
  return contaminationLayerCount + 1; // +1 for choropleth layer
});

const loadingProgress = computed(() => {
  return Math.round((loadedLayersCount.value / totalLayers.value) * 100);
});

const loadCountiesData = async () => {
  try {
    await loadAllCountyData();
    // Pre-calculate colors after all data is loaded
    preCalculateColors();
    loadedLayersCount.value++; // Increment the loaded layers count
  } catch (error) {
    console.error("Error loading counties data:", error);
  }
};

const addContaminationLayer = async (map: mapboxgl.Map, layer: any) => {
  try {
    const response = await fetch(layer.file);
    const data = await response.json();

    debugLog(`Loaded data for ${layer.id}:`, data.features.length, "features");

    const sourceId = `contamination-source-${layer.id}`;
    const layerId = `contamination-layer-${layer.id}`;

    map.addSource(sourceId, {
      type: "geojson",
      data: data,
      attribution:
        'Data source: <a href="https://www.epa.gov/frs" target="_blank" rel="noopener">U.S. EPA Facility Registry Service</a>',
    });

    map.addLayer({
      id: layerId,
      type: "circle",
      source: sourceId,
      paint: {
        "circle-radius": 6,
        "circle-color": layer.color,
        "circle-opacity": 0.7,
      },
      layout: {
        visibility: "none",
      },
    });

    debugLog(`Added contamination layer: ${layerId}`);
    loadedLayersCount.value++;
  } catch (error) {
    console.error(`Error adding layer ${layer.id}:`, error);
  }
};

const addDiversityLayer = async (map: mapboxgl.Map) => {
  try {
    // Data already loaded by loadCountiesData()
    if (!map.getSource("counties")) {
      console.warn(
        "Counties source not found. Make sure it's added before calling this function."
      );
      return;
    }

    map.addLayer({
      id: "diversity-layer",
      type: "fill",
      source: "counties",
      paint: {
        "fill-color": ["rgba", 0, 0, 0, 0],
        "fill-opacity": 0.7,
      },
      layout: {
        visibility: "none",
      },
    });

    debugLog("Added diversity layer");
    loadedLayersCount.value++;
  } catch (error) {
    console.error("Error adding diversity layer:", error);
  }
};

const addCountyChoroplethLayer = () => {
  debugLog("Adding county choropleth layer...");
  if (!map.value || !map.value.isStyleLoaded() || !countiesData.value) {
    debugLog("Map style not yet loaded or counties data not ready, waiting...");
    return;
  }

  if (!map.value.getSource("counties")) {
    debugLog("Adding counties source...");
    debugLog(
      "Sample counties:",
      countiesData.value.features
        .slice(0, 5)
        .map((f) => ({ id: f.properties.GEOID, properties: f.properties }))
    );
    map.value.addSource("counties", {
      type: "geojson",
      data: countiesData.value,
    });
  }

  if (!map.value.getLayer("county-choropleth")) {
    debugLog("Adding county choropleth layer...");
    map.value.addLayer({
      id: "county-choropleth",
      type: "fill",
      source: "counties",
      paint: {
        "fill-color": ["rgba", 0, 0, 0, 0],
        "fill-opacity": 0.7,
      },
      layout: {
        visibility: "none", // Set initial visibility to none
      },
    });
  }

  debugLog(
    "County choropleth layer added/updated:",
    map.value.getLayer("county-choropleth")
  );
};

const toggleContaminationLayer = (layerId: string) => {
  if (!layersLoaded.value || !map.value) {
    debugLog(`Layers not loaded yet, skipping toggle for ${layerId}`);
    return;
  }

  const layer = contaminationLayers.find((l) => l.id === layerId);
  if (layer) {
    layer.visible = !layer.visible;
    const visibility = layer.visible ? "visible" : "none";
    const mapLayerId = `contamination-layer-${layerId}`;
    if (map.value.getLayer(mapLayerId)) {
      map.value.setLayoutProperty(mapLayerId, "visibility", visibility);
    }

    debugLog(`Set ${layerId} visibility to ${visibility}`);

    // Update the "Show All" checkbox state
    updateShowAllCheckbox();

    // Update choropleth if it's visible
    if (showContaminationChoropleth.value) {
      updateChoroplethColors();
    }
  } else {
    console.warn(`Layer ${layerId} not found`);
  }
};

const toggleContaminationLayers = () => {
  showContaminationLayers.value = !showContaminationLayers.value;
  debugLog(
    `Toggling all layers to ${showContaminationLayers.value ? "visible" : "none"}`
  );
  contaminationLayers.forEach((layer) => {
    layer.visible = showContaminationLayers.value;
    const visibility = layer.visible ? "visible" : "none";
    if (map.value && map.value.getLayer(`contamination-layer-${layer.id}`)) {
      map.value.setLayoutProperty(
        `contamination-layer-${layer.id}`,
        "visibility",
        visibility
      );
    }
  });

  // Update choropleth if it's visible
  if (showContaminationChoropleth.value) {
    updateChoroplethColors();
  }
};

// Add this new function to synchronize the "Show All" checkbox state
const updateShowAllCheckbox = () => {
  showContaminationLayers.value = contaminationLayers.every((l) => l.visible);
};

const updateChoroplethColors = () => {
  debugLog("Updating choropleth colors:", {
    selectedLayers: selectedDemographicLayers.value,
    colorCalculationComplete: colorCalculationComplete.value,
    preCalculatedColorsCount: Object.keys(preCalculatedColors.value).length,
  });

  if (
    !map.value ||
    !map.value.getLayer("county-choropleth") ||
    !colorCalculationComplete.value
  ) {
    debugLog("Early return due to:", {
      mapExists: !!map.value,
      layerExists: map.value?.getLayer("county-choropleth"),
      colorCalculationComplete: colorCalculationComplete.value,
    });
    return;
  }

  let expression: Expression = ["rgba", 0, 0, 0, 0]; // Default transparent

  if (
    selectedDemographicLayers.value.length > 0 ||
    selectedEconomicLayers.value.length > 0 ||
    selectedHousingLayers.value.length > 0 ||
    selectedEquityLayers.value.length > 0 ||
    selectedTransportationLayers.value.length > 0 ||
    showContaminationChoropleth.value
  ) {
    // Check if we should use multi-layer combined scoring
    const useMultiLayerScoring = allSelectedLayers.value.length >= 2;

    // Phase 4c: dim non-top-N counties when a limit is active. Top-N stays
    // fully saturated; everyone else's alpha is reduced so the answer the
    // user asked for ("top 5") is visually prominent on the map.
    const topN = topNGeoIds.value;
    const dimActive = topN.size > 0;
    const DIM_ALPHA = 0.35;

    expression = [
      "match",
      ["get", "GEOID"],
      ...Object.entries(preCalculatedColors.value).flatMap(
        ([geoID, colors]) => {
          let finalColor: [number, number, number, number];

          if (useMultiLayerScoring) {
            // Multi-layer: use dynamic scoring engine
            const countyScore = personalizedScores.value.get(geoID);
            if (countyScore?.filteredOut) {
              // Filtered out by threshold: muted grey, keeps geographic context
              finalColor = [200, 200, 200, 0.4];
            } else {
              finalColor = getColorForDynamicScore(countyScore?.score ?? null);
            }
          } else if (selectedDemographicLayers.value.length === 1) {
            // Single demographic layer selected
            const layer = selectedDemographicLayers.value[0];
            switch (layer) {
              case "diversity_index":
                finalColor = colors.diversityColor;
                break;
              case "pct_Black":
                finalColor = colors.blackPctColor;
                break;
              case "life_expectancy":
                finalColor = colors.lifeExpectancyColor;
                break;
              case "combined_scores":
                finalColor = colors.combinedScoreColor;
                break;
              case "combined_scores_v2":
                // Get BLO v2.0 score and convert to color
                finalColor = getColorForBLOV2(geoID);
                break;
              default:
                finalColor = [0, 0, 0, 0];
            }
          } else if (selectedEconomicLayers.value.length === 1) {
            finalColor = getColorForEconomicLayer(geoID, selectedEconomicLayers.value[0]);
          } else if (selectedHousingLayers.value.length === 1) {
            finalColor = getColorForHousingLayer(geoID, selectedHousingLayers.value[0]);
          } else if (selectedEquityLayers.value.length === 1) {
            finalColor = getColorForEquityLayer(geoID, selectedEquityLayers.value[0]);
          } else if (selectedTransportationLayers.value.length === 1) {
            finalColor = getColorForTransportationLayer(geoID, selectedTransportationLayers.value[0]);
          } else if (showContaminationChoropleth.value && allSelectedLayers.value.length === 1) {
            // Single contamination layer selected
            finalColor = colors.contaminationColor;
          } else {
            finalColor = [0, 0, 0, 0];
          }

          // Phase 4c: dim non-top-N counties (preserves filtered-out greying).
          // Filtered-out counties keep their muted-grey 0.4 alpha; passing-but-not-top-N
          // gets multiplied down to DIM_ALPHA.
          if (dimActive && !topN.has(geoID)) {
            const isFilteredOut = useMultiLayerScoring &&
              personalizedScores.value.get(geoID)?.filteredOut;
            if (!isFilteredOut) {
              finalColor = [finalColor[0], finalColor[1], finalColor[2], finalColor[3] * DIM_ALPHA];
            }
          }

          return [geoID, ["rgba", ...finalColor]];
        }
      ),
      ["rgba", 0, 0, 0, 0],
    ];
  }

  map.value.setPaintProperty("county-choropleth", "fill-color", expression);
};

// Helper function to get color for a specific layer
const getLayerColor = (
  colors: ColorBlend,
  layerId: string
): [number, number, number, number] => {
  switch (layerId) {
    case "diversity_index":
      return colors.diversityColor;
    case "pct_Black":
      return colors.blackPctColor;
    case "life_expectancy":
      return colors.lifeExpectancyColor;
    case "combined_scores":
      return colors.combinedScoreColor;
    default:
      return [0, 0, 0, 0];
  }
};

// Color calculation for BLO Livability Index
const getColorForBLOV2 = (geoID: string): [number, number, number, number] => {
  const score = combinedScoresV2Data.value[geoID];
  if (!score || score.blo_score_v2 == null) return [0, 0, 0, 0];

  // Actual data range: 1.15 - 3.28 (out of 5)
  // Normalize to actual min/max for better visual contrast
  const MIN_SCORE = 1.15;
  const MAX_SCORE = 3.28;

  const normalized = Math.max(0, Math.min(1, (score.blo_score_v2 - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)));

  // Apply slight curve to emphasize extremes
  const curved = Math.pow(normalized, 0.9);

  // Dramatic color gradient: Bright yellow -> Deep emerald green
  // Low scores: Bright yellow (255, 245, 100)
  // High scores: Deep emerald green (0, 100, 0)
  const r = Math.round(255 - (255 - 0) * curved);
  const g = Math.round(245 - (245 - 100) * curved);
  const b = Math.round(100 - (100 - 0) * curved);

  return [r, g, b, 0.9];
};

// Color calculation for dynamic personalized scores (0-100 range)
const getColorForDynamicScore = (score: number | null): [number, number, number, number] => {
  if (score === null || score === 0) return [0, 0, 0, 0];

  // Score is 0-100, normalize to 0-1
  const normalized = Math.max(0, Math.min(1, score / 100));
  const curved = Math.pow(normalized, 0.9);

  // BLO gradient: Bright yellow (255, 245, 100) -> Deep emerald green (0, 100, 0)
  const r = Math.round(255 - (255 - 0) * curved);
  const g = Math.round(245 - (245 - 100) * curved);
  const b = Math.round(100 - (100 - 0) * curved);

  return [r, g, b, 0.9];
};

// Color calculation for economic layers
const getColorForEconomicLayer = (
  geoID: string,
  layerId: string
): [number, number, number, number] => {
  const data = economicData.value[geoID];
  if (!data) return [0, 0, 0, 0];

  let value: number | null = null;
  let min = 0;
  let max = 1;

  if (layerId === "avg_weekly_wage") {
    value = data.avg_weekly_wage;
    if (value == null) {
      return [0, 0, 0, 0];
    }
    min = 601;
    max = 4514;
    // Light yellow/green (low) to Deep emerald green (high) - similar to BLO gradient
    const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const curved = Math.pow(normalized, 0.9);

    // Gradient: Light yellow-green (200, 220, 100) -> Deep emerald green (0, 100, 0)
    const r = Math.round(200 - (200 - 0) * curved);
    const g = Math.round(220 - (220 - 100) * curved);
    const b = Math.round(100 - (100 - 0) * curved);

    return [r, g, b, 0.85];
  } else if (layerId === "median_income_by_race") {
    value = data.median_income_black;
    // Treat 0 as missing data
    if (value == null || value === 0) return [0, 0, 0, 0];
    min = 0;
    max = 250001;

    // Dramatic gradient with varying opacity
    const normalized = Math.max(0, Math.min(1, (value - min) / (max - min)));

    // Apply power curve to emphasize differences
    const curved = Math.pow(normalized, 0.8);

    // Color gradient: Light cyan (low) -> Deep royal blue (high)
    // Low income: Light cyan (100, 200, 255)
    // High income: Deep royal blue (0, 50, 150)
    const r = Math.round(100 - (100 - 0) * curved);
    const g = Math.round(200 - (200 - 50) * curved);
    const b = Math.round(255 - (255 - 150) * curved);

    // Opacity increases with income (0.3 to 0.95)
    const alpha = 0.3 + (curved * 0.65);

    return [r, g, b, alpha];
  }

  return [0, 0, 0, 0];
};

// Color calculation for housing layers
const getColorForHousingLayer = (
  geoID: string,
  layerId: string
): [number, number, number, number] => {
  const data = housingData.value[geoID];
  if (!data) return [0, 0, 0, 0];

  let value: number | null = null;
  let min = 0;
  let max = 1;

  if (layerId === "median_home_value") {
    value = data.median_home_value;
    // Treat 0 as missing data
    if (value == null || value === 0) return [0, 0, 0, 0];
    min = 0;
    max = 1535200;
    // Green (low/affordable) to Red (high/expensive)
    const normalized = (value - min) / (max - min);
    const curved = Math.pow(normalized, 0.8);
    const r = Math.round(curved * 220);
    const g = Math.round((1 - curved) * 200);
    return [r, g, 0, 0.85];
  } else if (layerId === "median_property_tax") {
    value = data.median_property_tax;
    if (value == null) return [0, 0, 0, 0];
    min = 0;
    max = 10001;
    // Green (low/affordable) to Red (high/expensive)
    const normalized = (value - min) / (max - min);
    const curved = Math.pow(normalized, 0.8);
    const r = Math.round(curved * 220);
    const g = Math.round((1 - curved) * 200);
    return [r, g, 0, 0.85];
  } else if (layerId === "homeownership_by_race") {
    value = data.homeownership_rate_black;
    // Treat 0 and null as missing data
    if (value == null || value === 0) return [0, 0, 0, 0];
    min = 0;
    max = 100;
    // Green (high/good) to Red (low/bad) - higher homeownership is better
    const normalized = (value - min) / (max - min);
    const curved = Math.pow(normalized, 0.8);
    const r = Math.round((1 - curved) * 220);
    const g = Math.round(curved * 200);
    return [r, g, 0, 0.85];
  }

  return [0, 0, 0, 0];
};

// Color calculation for equity layers
const getColorForEquityLayer = (
  geoID: string,
  layerId: string
): [number, number, number, number] => {
  const data = equityData.value[geoID];
  if (!data) return [0, 0, 0, 0];

  let value: number | null = null;
  let min = 0;
  let max = 1;

  if (layerId === "poverty_by_race") {
    value = data.poverty_rate_black;
    // Treat 0 as missing data
    if (value == null || value === 0) return [0, 0, 0, 0];
    min = 0;
    max = 100;
    // Green (low/good) to Red (high/bad)
    const normalized = (value - min) / (max - min);
    const curved = Math.pow(normalized, 0.8);
    const r = Math.round(curved * 220);
    const g = Math.round((1 - curved) * 200);
    return [r, g, 0, 0.85];
  } else if (layerId === "black_progress_index") {
    value = data.black_progress_index;
    if (value == null) return [0, 0, 0, 0];
    min = 0;
    max = 100;
    // Green (high/good) to Red (low/bad) - inverted from poverty
    const normalized = (value - min) / (max - min);
    const curved = Math.pow(normalized, 0.8);
    const r = Math.round((1 - curved) * 220);
    const g = Math.round(curved * 200);
    return [r, g, 0, 0.85];
  }

  return [0, 0, 0, 0];
};

// Color calculation for transportation layers
const getColorForTransportationLayer = (
  geoID: string,
  layerId: string
): [number, number, number, number] => {
  const data = transportationData.value[geoID];
  if (!data) return [0, 0, 0, 0];

  if (layerId === "commute_time") {
    const value = data.commute_time_ordinal;
    if (value == null || value === 0) return [0, 0, 0, 0];

    // Ordinal scale 1-12 (1 = shortest, 12 = longest)
    const min = 1;
    const max = 12;
    const normalized = (value - min) / (max - min);
    const curved = Math.pow(normalized, 0.8);

    // Green (short commute) -> Yellow (medium) -> Red (long commute)
    let r: number, g: number, b: number;
    if (curved < 0.5) {
      // Green to Yellow
      const t = curved * 2;
      r = Math.round(t * 255);
      g = Math.round(180 + t * 75);
      b = 0;
    } else {
      // Yellow to Red
      const t = (curved - 0.5) * 2;
      r = 255;
      g = Math.round(255 - t * 255);
      b = 0;
    }

    return [r, g, b, 0.85];
  } else if (layerId === "drove_alone") {
    const value = data.pct_drove_alone;
    if (value == null) return [0, 0, 0, 0];

    // Percentage 0-100
    const normalized = Math.max(0, Math.min(1, value / 100));
    const curved = Math.pow(normalized, 0.8);

    // Light teal to dark teal
    const r = Math.round(78 - curved * 50);
    const g = Math.round(205 - curved * 80);
    const b = Math.round(196 - curved * 50);

    return [r, g, b, 0.85];
  } else if (layerId === "public_transit") {
    const value = data.pct_public_transit;
    if (value == null) return [0, 0, 0, 0];

    // Percentage 0-100 (often low values)
    const normalized = Math.max(0, Math.min(1, value / 50)); // Cap at 50% for better contrast
    const curved = Math.pow(normalized, 0.7);

    // Light purple to dark purple
    const r = Math.round(200 - curved * 45);
    const g = Math.round(150 - curved * 61);
    const b = Math.round(230 - curved * 48);

    return [r, g, b, 0.85];
  }

  return [0, 0, 0, 0];
};

const updateDiversityColors = () => {
  if (!map.value || !map.value.getLayer("diversity-layer")) return;

  const maxDiversityIndex = Math.max(
    ...Object.values(diversityData.value).map((d) => d.diversityIndex)
  );

  const expression: mapboxgl.Expression = [
    "interpolate",
    ["linear"],
    ["get", ["get", "GEOID"]],
    0,
    ["rgba", 128, 0, 128, 0],
    maxDiversityIndex,
    ["rgba", 128, 0, 128, 1],
  ];

  map.value.setPaintProperty("diversity-layer", "fill-color", expression);
};

// Call updateChoroplethColors whenever contamination data changes
watch(
  () =>
    [...contaminationLayers, ...demographicLayers].map(
      (layer) => layer.visible
    ),
  () => {
    /*if (showChoroplethLayer.value) {
      updateChoroplethColors()
    }*/
  },
  { deep: true }
);

// Recolor choropleth when scoring query or filters change
let recolorTimeout: ReturnType<typeof setTimeout> | null = null;
watch([scoringQuery, activeFilters], () => {
  // Debounce at 100ms to avoid jank during rapid slider movement
  if (recolorTimeout) clearTimeout(recolorTimeout);
  recolorTimeout = setTimeout(() => {
    updateChoroplethColors();
  }, 100);
}, { deep: true });

// Phase 4c: re-render choropleth when the top-N set changes (limit toggled,
// limit value changed, or scoring query changed in a way that reorders ranks).
watch(topNGeoIds, () => {
  updateChoroplethColors();
});

const popup = ref<mapboxgl.Popup | null>(null);

/*const updatePopup = (
  e: mapboxgl.MapMouseEvent & { features?: mapboxgl.MapboxGeoJSONFeature[] | undefined }
) => {
  if (e.features && e.features.length > 0) {
    const feature = e.features[0]
    const countyName = feature.properties?.NAME
    const countyState = feature.properties?.STATE_NAME
    const contaminationCount = countyContaminationCounts[feature.properties?.GEOID] || 0

    if (countyName) {
      if (!popup.value) {
        popup.value = new mapboxgl.Popup({ closeButton: false, closeOnClick: false })
      }
      popup.value
        .setLngLat(e.lngLat)
        .setHTML(
          `
          <div style="color: black;">
            <strong>${countyName}</strong><br>
            EPA Sites of Land Toxicity: ${contaminationCount}
          </div>
        `
        )
        .addTo(map.value!)
    }
  } else {
    if (popup.value) {
      popup.value.remove()
    }
  }
}*/

const addTooltip = () => {
  if (!map.value) return;

  const tooltip = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false,
  });

  const averages = {
    contamination: 8.767526188557614,
    blackPct: 9.052875828856244,
    diversityIndex: 0.32891281038322207,
    lifeExpectancy: 77.73516731016737,
  };

  map.value.on("mousemove", "county-choropleth", (e) => {
    // Phase 4f: hover outline + cursor cue. Skip when a rail is open
    // — the active county already has a heavier outline and clicks are
    // routed to the rail anyway, so the hover signal would compete.
    if (!inspectActive.value && !walkthroughActive.value) {
      const hoverGeo = e.features?.[0]?.properties?.GEOID;
      if (typeof hoverGeo === 'string' && map.value?.getLayer(HOVER_OUTLINE_LAYER)) {
        map.value.setFilter(HOVER_OUTLINE_LAYER, ["==", ["get", "GEOID"], hoverGeo]);
        map.value.setLayoutProperty(HOVER_OUTLINE_LAYER, "visibility", "visible");
      }
      if (map.value) map.value.getCanvas().style.cursor = 'pointer';
    }

    // Phase 4e cleanup: when the inspect rail or walkthrough rail is open,
    // the rail already shows the active county's stats — the hover popup
    // duplicates that content right next to the cursor. Suppress it so
    // the rail is the single source of "what is this county."
    if (inspectActive.value || walkthroughActive.value) {
      tooltip.remove();
      return;
    }
    if (e.features && e.features.length > 0) {
      const feature = e.features[0];
      const countyId = feature.properties.GEOID;
      const countyName = feature.properties.NAME;

      // Use FIPS for state name
      const stateFIPS = countyId.substring(0, 2);
      const fipsToState: { [key: string]: string } = {
        "01": "Alabama",
        "02": "Alaska",
        "04": "Arizona",
        "05": "Arkansas",
        "06": "California",
        "08": "Colorado",
        "09": "Connecticut",
        "10": "Delaware",
        "11": "District of Columbia",
        "12": "Florida",
        "13": "Georgia",
        "15": "Hawaii",
        "16": "Idaho",
        "17": "Illinois",
        "18": "Indiana",
        "19": "Iowa",
        "20": "Kansas",
        "21": "Kentucky",
        "22": "Louisiana",
        "23": "Maine",
        "24": "Maryland",
        "25": "Massachusetts",
        "26": "Michigan",
        "27": "Minnesota",
        "28": "Mississippi",
        "29": "Missouri",
        "30": "Montana",
        "31": "Nebraska",
        "32": "Nevada",
        "33": "New Hampshire",
        "34": "New Jersey",
        "35": "New Mexico",
        "36": "New York",
        "37": "North Carolina",
        "38": "North Dakota",
        "39": "Ohio",
        "40": "Oklahoma",
        "41": "Oregon",
        "42": "Pennsylvania",
        "44": "Rhode Island",
        "45": "South Carolina",
        "46": "South Dakota",
        "47": "Tennessee",
        "48": "Texas",
        "49": "Utah",
        "50": "Vermont",
        "51": "Virginia",
        "53": "Washington",
        "54": "West Virginia",
        "55": "Wisconsin",
        "56": "Wyoming",
      };
      const stateName = fipsToState[stateFIPS] || "Unknown State";

      // Add debugging for demographic data linking
      debugLog("County data lookup:", {
        countyId,
        hasData: !!diversityData.value[countyId],
        sampleDiversityKeys: Object.keys(diversityData.value).slice(0, 5),
        diversityDataFormat: diversityData.value[countyId],
      });

      const countyDiversityData = diversityData.value[countyId];
      const totalContamination =
        countyContaminationCounts[countyId]?.total || 0;

      const getColoredValue = (value: number, average: number) => {
        const color = value > average ? "green" : "red";
        return `<span style="color: ${color}">${value.toFixed(2)}</span>`;
      };
      const getColoredValueContam = (value: number, average: number) => {
        const color = value > average ? "red" : "green";
        return `<span style="color: ${color}">${Math.round(value)}</span>`;
      };

      const lifeExpValue = lifeExpectancyData.value[countyId]?.lifeExpectancy;
      const pctBlackValue = countyDiversityData?.pct_Black;
      const diversityValue = countyDiversityData?.diversityIndex;

      // Build active layers section
      let activeLayersHTML = '';

      // Helper to get layer name from registry
      const getLayerName = (layerId: string) => {
        return LAYER_REGISTRY[layerId]?.name || layerId;
      };

      // Helper to get raw value for a layer from the correct data map
      const getRawLayerValue = (layerId: string): any => {
        const reg = LAYER_REGISTRY[layerId];
        if (!reg) return undefined;
        const key = reg.dataKey;
        switch (layerId) {
          case 'combined_scores_v2':
            return combinedScoresV2Data.value[countyId]?.blo_score_v2;
          case 'diversity_index':
            return diversityValue;
          case 'pct_Black':
            return pctBlackValue;
          case 'life_expectancy':
            return lifeExpValue;
          case 'contamination':
            return totalContamination;
          case 'avg_weekly_wage':
          case 'median_income_by_race':
            return (economicData.value[countyId] as any)?.[key];
          case 'median_home_value':
          case 'median_property_tax':
          case 'homeownership_by_race':
            return (housingData.value[countyId] as any)?.[key];
          case 'poverty_by_race':
          case 'black_progress_index':
            return (equityData.value[countyId] as any)?.[key];
          case 'commute_time':
          case 'drove_alone':
          case 'public_transit':
            return (transportationData.value[countyId] as any)?.[key];
          default:
            return undefined;
        }
      };

      // Helper to get formatted value for a layer using registry formatValue
      const getLayerValue = (layerId: string) => {
        const reg = LAYER_REGISTRY[layerId];
        if (!reg) return '?';
        const raw = getRawLayerValue(layerId);
        return reg.formatValue(raw);
      };

      // Collect all active layers
      const activeLayers = [
        ...selectedDemographicLayers.value,
        ...selectedEconomicLayers.value,
        ...selectedHousingLayers.value,
        ...selectedEquityLayers.value,
        ...selectedTransportationLayers.value,
      ];

      // Add contamination if choropleth is showing
      if (showContaminationChoropleth.value) {
        activeLayers.push('contamination');
      }

      // Show custom score if multiple layers are selected
      let combinedScoreHTML = '';
      if (allSelectedLayers.value.length >= 2) {
        const countyScore = personalizedScores.value.get(countyId);
        const scoreDisplay = countyScore?.score != null ? countyScore.score.toFixed(1) : '?';
        const missingCount = countyScore?.missingLayers?.length || 0;
        const missingNote = missingCount > 0 ? ` (${missingCount} layer${missingCount > 1 ? 's' : ''} unavailable)` : '';
        combinedScoreHTML = `
          <div style="background-color: #f0f8ff; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
            <p style="margin: 0; font-size: 14px; font-weight: bold; color: #2c5f2d;">
              Custom Score: ${scoreDisplay} / 100
            </p>
            <p style="margin: 4px 0 0 0; font-size: 11px; color: #555;">
              ${allSelectedLayers.value.length} layers weighted${missingNote}
            </p>
          </div>
        `;
      }

      if (activeLayers.length > 0) {
        activeLayersHTML = '<div style="border-bottom: 2px solid #ddd; padding-bottom: 8px; margin-bottom: 8px;">';
        activeLayers.forEach(layerId => {
          const name = getLayerName(layerId);
          const value = getLayerValue(layerId);
          activeLayersHTML += `<p style="margin: 4px 0;"><strong>${name}:</strong> ${value}</p>`;
        });
        activeLayersHTML += '</div>';
      }

      const tooltipContent = `
        <h3>${countyName}, ${stateName}</h3>
        ${combinedScoreHTML}
        ${activeLayersHTML}
        <p>Total Population: ${countyDiversityData?.totalPopulation ? countyDiversityData.totalPopulation.toLocaleString() : "?"}</p>
        <p>Percent Black: ${pctBlackValue != null ? pctBlackValue.toFixed(2) + "%" : "?"}</p>
      `;

      tooltip.setLngLat(e.lngLat).setHTML(tooltipContent).addTo(map.value);
    }
  });

  map.value.on("mouseleave", "county-choropleth", () => {
    tooltip.remove();
    // Phase 4f: clear the hover outline + restore default cursor.
    if (map.value?.getLayer(HOVER_OUTLINE_LAYER)) {
      map.value.setLayoutProperty(HOVER_OUTLINE_LAYER, "visibility", "none");
    }
    if (map.value) map.value.getCanvas().style.cursor = '';
  });
};

/** Phase 4f: hide the hover outline immediately when a rail opens — the
 *  active-county outline is heavier and would compete visually. */
watch([inspectActive, walkthroughActive], () => {
  if (!map.value || !map.value.getLayer(HOVER_OUTLINE_LAYER)) return;
  if (inspectActive.value || walkthroughActive.value) {
    map.value.setLayoutProperty(HOVER_OUTLINE_LAYER, "visibility", "none");
    map.value.getCanvas().style.cursor = '';
  }
});

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

const toolContext: ToolContext = {
  get map() { return map.value; },
  setLayerSelection: (layers, options) => {
    handleQueryResult({
      layers,
      explanation: options?.explanation || '',
      filters: options?.filters,
      limit: options?.limit,
    });
  },
  openCountyModal: (geoId) => {
    openCountyModalById(geoId);
    zoomToGeoId(geoId);
  },
  toggleRankingPanel: (expanded) => {
    rankingPanelExpanded.value = expanded;
  },
  setRankingStateFilter: (stateName) => {
    rankingStateFilter.value = stateName;
    // Also expand the ranking panel so the user sees the filter take effect
    if (stateName) rankingPanelExpanded.value = true;
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
  getTopRankedCounties: async (limit) => {
    // Wait for reactive scoring engine to catch up (layer state change → scoringQuery → scores)
    await new Promise(resolve => setTimeout(resolve, 100));
    const ranked = rankedCounties.value.slice(0, limit);
    return ranked.map((c, i) => {
      const name = getCountyName(c.geoId);
      const div = diversityData.value[c.geoId];
      return {
        rank: i + 1,
        geoId: c.geoId,
        name,
        state: div?.stateName || '',
        score: c.score ?? 0,
      };
    });
  },
};

const chat = useChat(toolContext, {
  getActiveFilters: () => activeFilters.value,
});

onMounted(async () => {
  mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;
  debugLog("Component mounted");
  try {
    await loadCountiesData();
    debugLog("Counties data loaded successfully");
  } catch (error) {
    console.error("Error loading counties data:", error);
    return;
  }

  // Initialize the county name lookup for LLM tools
  try {
    await initCountyLookup();
  } catch (err) {
    console.warn("County lookup failed to initialize:", err);
  }

  debugLog("Initializing map");
  // Guard against the case where async work above (initCountyLookup,
  // useMapData) finishes after the component has been torn down or
  // before the template ref is bound. The error is benign — Vite HMR
  // can disconnect the container — but the stack trace is noisy.
  if (!mapContainer.value) {
    console.warn("Map container not ready; skipping map init.");
    return;
  }
  map.value = new mapboxgl.Map({
    container: mapContainer.value,
    style: "mapbox://styles/mapbox/light-v10",
    center: MAP_CONFIG.DEFAULT_CENTER,
    zoom: MAP_CONFIG.DEFAULT_ZOOM,
  });

  // Phase 4c: Geocoder instance is kept for `usePropertyListings`
  // (it consumes `geocoderRef.value.clear()` to reset the search bar) but
  // its DOM is no longer rendered. Place lookup happens via direct fetch
  // calls inside PromptInput; selection routes here through
  // `handlePlaceSelection` which sets `currentGeocoderResult` and flies the map.
  geocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    countries: MAP_CONFIG.GEOCODER_COUNTRIES,
    types: "country,region,postcode,district,place",
    placeholder: "Search for a location",
  });
  geocoderRef.value = geocoder;

  map.value.on("load", async function () {
    debugLog("Map loaded");
    debugLog("Counties source:", map.value?.getSource("counties"));

    // Wait for style to be fully loaded
    if (!map.value?.isStyleLoaded()) {
      await new Promise((resolve) => map.value?.once("style.load", resolve));
    }

    // Add counties source first
    if (!map.value?.getSource("counties")) {
      debugLog("Adding counties source...");
      map.value?.addSource("counties", {
        type: "geojson",
        data: countiesData.value!,
      });
    }

    // Then add choropleth layer
    if (!map.value?.getLayer("county-choropleth")) {
      debugLog("Adding choropleth layer...");
      map.value?.addLayer({
        id: "county-choropleth",
        type: "fill",
        source: "counties",
        paint: {
          "fill-color": ["rgba", 0, 0, 0, 0],
          "fill-opacity": 0.7,
        },
        layout: {
          visibility: "none",
        },
      });
    }

    addCountyChoroplethLayer();
    addWalkthroughOverlayLayers();

    // Add contamination layers
    if (!DEV_MODE_DEMOGRAPHICS_ONLY) {
      for (const layer of contaminationLayers) {
        await addContaminationLayer(map.value!, layer);
      }
    }

    // Add diversity layer
    await addDiversityLayer(map.value!);

    layersLoaded.value = true;
    addTooltip();

    if (!DEV_MODE_DEMOGRAPHICS_ONLY) {
      // Set initial visibility based on checkbox state
      contaminationLayers.forEach((layer) => {
        if (layer.visible) {
          if (
            map.value &&
            map.value.getLayer(`contamination-layer-${layer.id}`)
          ) {
            map.value.setLayoutProperty(
              `contamination-layer-${layer.id}`,
              "visibility",
              "visible"
            );
          }
        }
      });
    }

    // Set initial choropleth visibility based on pre-selected layers
    if (map.value && map.value.getLayer("county-choropleth")) {
      const initialVisibility = showDiversityChoropleth.value ? "visible" : "none";
      map.value.setLayoutProperty("county-choropleth", "visibility", initialVisibility);

      // Update colors if layer is visible
      if (showDiversityChoropleth.value) {
        updateChoroplethColors();
      }
    }
  });

  // Check if the style is already loaded (it might be if we're using a local style)
  if (map.value.isStyleLoaded()) {
    debugLog("Style already loaded");
    addCountyChoroplethLayer();
  }

  // Add a listener for the 'styledata' event, which fires when the map's style is fully loaded
  map.value.on("styledata", () => {
    debugLog("Style data loaded");
    addCountyChoroplethLayer();
  });

  map.value.on("click", (e) => {
    // Phase 4e: county click is a no-op during walkthrough so the user
    // can't accidentally derail the tour. They have to Exit first to switch.
    if (walkthroughActive.value) return;
    // Marker clicks bubble to the map's click event in mapbox-gl. Without
    // this guard, clicking a property pin would also fire the county
    // click handler — which calls inspectCounty, which (when the underlying
    // county differs from the current one) wipes the active land search.
    // Bail when the original DOM click target is inside a marker.
    const target = (e.originalEvent?.target as HTMLElement | null);
    if (target && target.closest(".mapboxgl-marker")) {
      debugLog("Click landed on a marker — skipping county inspect");
      return;
    }
    const features = map.value?.queryRenderedFeatures(e.point, {
      layers: ["county-choropleth"],
    });
    if (features && features.length > 0) {
      const feature = features[0];
      const countyId = feature.properties?.GEOID;
      debugLog("Clicked feature:", countyId);
      if (countyId) inspectCounty(countyId);
    } else {
      debugLog("No feature found at click point");
    }
  });

  const tooltipIcons = document.querySelectorAll(".tooltip-icon");
  tooltipIcons.forEach((icon) => {
    icon.addEventListener("mouseenter", (e) => {
      const tooltip = icon.querySelector(".tooltip-text");
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

  /*map.value.on('mousemove', 'county-choropleth', updatePopup)
  map.value.on('mouseleave', 'county-choropleth', () => {
    if (popup.value) {
      popup.value.remove()
    }
  })*/

  // Add zoom and rotation controls to the map in the bottom-right corner
  map.value.addControl(new mapboxgl.NavigationControl(), "bottom-right");

  addTooltip();

  debugLog("Map initialization complete");
});

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

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(255, 255, 255, 0.8);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 1000;
}

.loading-content {
  text-align: center;
}

.progress-bar {
  width: 200px;
  height: 20px;
  background-color: #f0f0f0;
  border-radius: 10px;
  overflow: hidden;
}

.progress {
  height: 100%;
  background-color: #4caf50;
  transition: width 0.3s ease-in-out;
}

.loading-text {
  color: black;
  margin-top: 10px;
  font-weight: bold;
}

/* Mapbox GL JS popup styles */
:global(.mapboxgl-popup) {
  max-width: 400px;
  font:
    12px/20px "Helvetica Neue",
    Arial,
    Helvetica,
    sans-serif;
}

:global(.mapboxgl-popup-content) {
  padding: 10px;
  max-width: 300px;
  font-size: 12px;
  border-radius: 3px;
  color: black;
}

:global(.mapboxgl-popup-content strong) {
  color: black;
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
