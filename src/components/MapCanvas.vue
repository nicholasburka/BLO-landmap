<template>
  <div class="map-canvas">
    <div ref="mapContainer" class="map-canvas-gl" data-testid="map-canvas"></div>
    <LoadingIndicator :loaded="layersLoaded" :progress="loadingProgress" />
  </div>
</template>

<script setup lang="ts">
/**
 * The map itself, and nothing else (P6-10).
 *
 * Extracted from `Map.vue`, which was 4,427 lines and owned everything: the
 * map, the Lens, the rails, the walkthrough, saved views, deep links, the
 * prompt. One component could not be mounted twice, so there could only ever
 * be one map in the app — at `/`.
 *
 * This is the part that is the same wherever a map appears: the container, the
 * `mapboxgl.Map`, the counties source, the choropleth and its colours, the
 * hover tooltip, the point overlays, the contamination layers, and the three
 * ways to move it (`zoomToGeoId`, `fitToGeoIds`, `inspectCounty`).
 *
 * What it does **not** do, by design: no Lens, no prompt, no rails, no saved
 * views, no reading or writing the URL, no assumption that it owns the route.
 * It takes the page's state in through two props and reports what happened
 * through two events, so it can be mounted anywhere — the public map's chrome
 * wraps it (`Map.vue`), the chat page opens it in a pane, and a page that
 * wants to show its own filtered rows on a map can open one in place without
 * navigating away and losing its context.
 *
 * Driving it from a host:
 *
 *   const state = useMapState({ layers: ['pct_Black'], only: filteredGeoIds })
 *   <MapCanvas :layers="state.layers" :query="state.query"
 *              :fit="{ geoIds: filteredGeoIds }" @county-click="…" />
 *
 * `layers` and `query` come from `useMapState()` and must be the same objects
 * for the life of the canvas (an inline literal would be a new object every
 * render). Everything a tool or a checkbox changes is written back through
 * them, so the host and the canvas never hold two versions of the truth.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, type Ref } from "vue";
import mapboxgl, { type Expression } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useRouter } from "vue-router";
import LoadingIndicator from "@/components/LoadingIndicator.vue";
import { useColorCalculation } from "@/composables/useColorCalculation";
import { useMapData } from "@/composables/useMapData";
import { useAuth } from "@/composables/useAuth";
import type { MapLayerState, MapQueryState, MapDataStore } from "@/composables/useMapState";
import {
  ensureContaminationLayer,
  setContaminationVisibility,
  type ContaminationHost,
  type ContaminationLayer,
} from "@/config/layerConfig";
import {
  debugLog,
  MAPBOX_ACCESS_TOKEN,
  MAP_CONFIG,
} from "@/config/constants";
import type { ContaminationData } from "@/types/mapTypes";
import { LAYER_REGISTRY } from "@/config/layerRegistry";
import { addCountyOverlayLayers, HOVER_OUTLINE_LAYER } from "@/lib/countyOverlays";
import { recordUrl } from "@/lib/mapDeepLinks";
import type { EntityRef } from "@/lib/entityRail";
import type { ToolContext } from "@/lib/mapTools";
import {
  colorForRegistryValue,
  fetchInternalLayerFeatures,
  isInternalLayerId,
  type InternalFeatureLayer,
  type InternalFeatureCollection,
} from "@/lib/internalLayers";
import {
  addFeatureLayerToMap,
  removeFeatureLayerFromMap,
  boundsForFeatures,
  boundsOfFeature,
  anchorOfFeature,
  pointMapLayerIds,
  lineMapLayerIds,
  stateMapLayerIds,
  allFeatureMapLayerIds,
  orderFeatureLayers,
  featureSourceId,
  buildFeaturePopup,
} from "@/lib/internalFeatureLayers";

/** Where to put the map: a set of counties, a bounding box, or a viewport. */
export interface MapFitRequest {
  /** Frame the union of these counties' polygons. */
  geoIds?: string[];
  /** Frame a box, as `[west, south, east, north]` (a `?fit=bbox:…` link). */
  bbox?: [number, number, number, number];
  /**
   * P7-4: go exactly here — `[lng, lat]` plus `zoom`, which is how a saved map
   * view stores the place somebody chose to look at (`SavedViewState.viewport`).
   *
   * The other two are *derived* frames: the host says which rows matter and the
   * canvas works out the box. A saved viewport is not derived from anything —
   * it is a decision, and a map block in a page has to be able to honour it
   * without holding the mapbox-gl handle itself. Both halves are required
   * together; one on its own is ignored.
   */
  center?: [number, number];
  zoom?: number;
  padding?: number;
  maxZoom?: number;
  duration?: number;
}

const props = withDefaults(
  defineProps<{
    /** Which layers are on, and how to switch one. From `useMapState()`. */
    layers: MapLayerState;
    /** What is ranked, filtered and framed. From `useMapState()`. */
    query: MapQueryState;
    /** Zoom to this county whenever it changes. */
    focusGeoId?: string | null;
    /** Frame this whenever it changes. */
    fit?: MapFitRequest | null;
    /** The page's county data store, so one page is one download. */
    data?: MapDataStore;
    /** Show the hover tooltip. The public map turns it off while a rail is
     *  open — the rail already says what the county is. */
    hoverTooltip?: boolean;
    /** Publish `window.__bloMap` for dev tools and the e2e specs. Exactly one
     *  canvas in a page may claim it; the public map does. */
    exposeHandle?: boolean;
  }>(),
  { focusGeoId: null, fit: null, data: undefined, hoverTooltip: true, exposeHandle: false },
);

const emit = defineEmits<{
  /** The tool context this canvas can be driven by, once the map exists. */
  (e: "ready", ctx: ToolContext): void;
  /** Someone clicked a county. The canvas does not decide what that means. */
  (e: "county-click", geoId: string): void;
  /** The counties source and the choropleth are on the map — a host adding
   *  its own overlay layers on top of them can go ahead. */
  (e: "counties-ready"): void;
}>();

const mapContainer = ref<HTMLElement | null>(null);
// Cast instead of ref<mapboxgl.Map | null>(): letting Vue compute UnwrapRef
// on the mapbox-gl v3 Map class blows TS's instantiation depth ("Map$1"
// errors). Runtime behavior is identical — it's still a plain deep ref.
const map = ref(null) as Ref<mapboxgl.Map | null>;
const router = useRouter();
const { internalUser } = useAuth();

if (import.meta.env.DEV) {
  watch(
    () => [props.layers, props.query],
    () => {
      console.warn(
        "[MapCanvas] `layers` and `query` changed identity. They must be the " +
          "same objects for the life of the canvas — build them with useMapState().",
      );
    },
  );
}

// The page's data store, or our own when the canvas stands alone. Both county
// files are promise-cached in `useMapData`, so a second store is a second set
// of refs over the same parsed objects — not a second download.
const data = props.data ?? useMapData();
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
  loadCountiesGeoJSON,
  loadCountyData,
} = data;

// The state this canvas draws. Destructured once (see the docblock) and under
// the names the extracted code already used.
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
  diversityChoropleth: showDiversityChoropleth,
  internalDefinitions: internalLayers,
  pointDefinitions: internalFeatureLayers,
  internalValues: internalLayerValues,
  pointData: internalFeatureData,
  activeEntity,
  all: allSelectedLayers,
} = props.layers;
const {
  demographic: demographicLayers,
  economic: economicLayers,
  housing: housingLayers,
  equity: equityLayers,
  transportation: transportationLayers,
  contamination: contaminationLayers,
} = props.layers.definitions;
const {
  scores: personalizedScores,
  scoring: scoringQuery,
  filters: activeFilters,
  topNGeoIds,
} = props.query;

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

/** Point-layer click/hover handlers are registered once per layer id. */
const pointHandlersAttached = new Set<string>();
let pointPopup: mapboxgl.Popup | null = null;

// ========== zoomToGeoId — the counties source is the only thing that knows a county's bounds ==========
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
  // County features are always Polygon/MultiPolygon; the GeoJSON Geometry
  // union includes GeometryCollection (no `coordinates`), hence the cast.
  const geom = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  const coords = geom.type === 'MultiPolygon'
    ? geom.coordinates.flat(2)
    : geom.coordinates.flat(1);
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

// ========== fitToGeoIds — the same union, for a set of counties ==========
// ----- Walkthrough auto-fit (entry) -----

/** Fit map bounds to the union of these counties' polygons. The map already
 *  holds every county polygon (it draws them), so framing a set of counties
 *  is a bounds union and nothing else. Shared by the walkthrough's entry
 *  auto-fit and the `?fit=` deep link (P5-55). */
const fitToGeoIds = (
  geoIds: string[],
  opts: { padding?: number; maxZoom?: number; duration?: number } = {},
): boolean => {
  if (!map.value || !countiesData.value || geoIds.length === 0) return false;
  const bounds = new mapboxgl.LngLatBounds();
  let hasAny = false;
  for (const geoId of geoIds) {
    const feature = countiesData.value.features.find(
      (f: any) => f.properties?.GEOID === geoId
    );
    if (!feature) continue;
    // Same Polygon/MultiPolygon-only cast as zoomToGeoId above.
    const geom = feature.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
    const coords = geom.type === "MultiPolygon"
      ? geom.coordinates.flat(2)
      : geom.coordinates.flat(1);
    coords.forEach((coord: number[]) => bounds.extend(coord as [number, number]));
    hasAny = true;
  }
  if (!hasAny) return false;
  map.value.fitBounds(bounds, {
    padding: opts.padding ?? 100,
    maxZoom: opts.maxZoom ?? 9,
    duration: opts.duration ?? 1000,
  });
  return true;
};

// ========== choropleth visibility ==========
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
    selectedTransportationLayers.value.length > 0 ||
    selectedInternalLayers.value.length > 0
      ? "visible"
      : "none";

  map.value.setLayoutProperty("county-choropleth", "visibility", visibility);

  if (visibility === "visible") {
    updateChoroplethColors();
  }
};


// ========== county data load + waitForStyle ==========
/** P5-74: the startup overlay reports the county dataset and nothing else —
 *  the contamination GeoJSONs used to be counted here and fetched up front
 *  (24 MB for every visitor, whether or not they ever switched one on); they
 *  are now loaded on demand and are no part of startup.
 *
 *  P5-87/P5-90: it counts FILES, not steps. Startup is two fetches — the
 *  prebuilt county data file and the polygons — issued together, each ticking
 *  the bar as it lands. */
const COUNTY_DATA_FILES = 2;
const layersLoaded = ref(false);
const loadedFilesCount = ref(0);
const loadingProgress = computed(() =>
  Math.round((loadedFilesCount.value / COUNTY_DATA_FILES) * 100)
);

/** P5-87: start both county files at once and hand back a promise that says
 *  whether the choropleth can paint. Nothing awaits this before the map is
 *  constructed — the Mapbox style and tiles go out in the same tick — and a
 *  failure leaves the basemap usable instead of an empty page. */
const startCountyDataLoad = (): Promise<boolean> => {
  const counted = <T,>(request: Promise<T>): Promise<T> =>
    request.then((value) => {
      loadedFilesCount.value++;
      return value;
    });

  const geometry = counted(loadCountiesGeoJSON());
  // Colours need the data file only, so they are computed the moment it lands
  // rather than after the (larger) geometry has also arrived.
  const data = counted(loadCountyData()).then(() => preCalculateColors());

  return Promise.all([geometry, data])
    .then(() => true)
    .catch((error) => {
      console.error("Error loading counties data:", error);
      return false;
    });
};

/** Resolve once the style can take sources and layers. `isStyleLoaded()` is
 *  briefly false whenever layers are being added (e.g. right after the map's
 *  own `load` work), and `once('load')` would never fire again — so poll.
 *  False means the map went away or never settled. */
const waitForStyle = async (timeoutMs = 15_000): Promise<boolean> => {
  const sleep = () => new Promise((resolve) => setTimeout(resolve, 100));
  // The county work keeps the style busy for as long as it takes — 25 s on a
  // loaded laptop — and the page already says "Loading counties…" for that.
  // A layer asked for during it must wait for it, not time out against it;
  // the clock below only starts once the counties are on.
  const ceiling = Date.now() + COUNTY_WAIT_CEILING_MS;
  while (map.value && !layersLoaded.value && Date.now() < ceiling) await sleep();
  const deadline = Date.now() + timeoutMs;
  while (map.value && !map.value.isStyleLoaded() && Date.now() < deadline) await sleep();
  return !!map.value && map.value.isStyleLoaded();
};
/** How long a layer request will wait for the counties before giving up. */
const COUNTY_WAIT_CEILING_MS = 120_000;

// ========== contamination layers, loaded on demand (P5-74) ==========
//
// Nothing contamination-related is fetched at startup. A layer's GeoJSON is
// fetched the first time it is switched on — by its checkbox, a `?layers=`
// deep link, a saved view, or the chat's show_layer tool — and once it is on
// the map it stays there. `layer.status` is what the checkbox row renders
// ("Loading…", "Could not load — try again"); `contaminationLoads` de-dupes
// callers that ask for the same layer while a fetch is already in flight.

const contaminationLoads = new Map<string, Promise<boolean>>();

/** The download starts immediately; the add waits for the style. That order
 *  is why a deep link can turn a layer on before the map has finished its own
 *  `load` work without dropping the request. */
const contaminationHost: ContaminationHost = {
  map: async () => ((await waitForStyle()) ? map.value : null),
  fetchGeoJson: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
};

/** Switch one contamination layer on, fetching its GeoJSON if this is the
 *  first time. A failed fetch leaves the checkbox off, so the row's "try
 *  again" is the only way back in. */
const showContaminationLayer = async (layer: ContaminationLayer): Promise<boolean> => {
  layer.visible = true;
  const loaded = await ensureContaminationLayer(layer, contaminationHost, contaminationLoads);
  if (!loaded) {
    layer.visible = false;
    return false;
  }
  // The user may have switched it back off (or left) while it was in flight.
  if (!layer.visible || !map.value) return false;
  setContaminationVisibility(map.value, layer.id, true);
  return true;
};

const hideContaminationLayer = (layer: ContaminationLayer): void => {
  layer.visible = false;
  if (map.value) setContaminationVisibility(map.value, layer.id, false);
};


// ========== the counties source, the choropleth, the diversity layer ==========
const addDiversityLayer = async (map: mapboxgl.Map) => {
  try {
    // The "counties" source is added by the load handler once both county
    // files are in; this only ever runs after that.
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

/** The checkbox on a contamination row. No longer waits for the map: the
 *  fetch can start before the style settles, and `waitForStyle` holds the
 *  add until it has. */

// ========== the contamination checkboxes ==========
const toggleContaminationLayer = async (layerId: string): Promise<void> => {
  const layer = contaminationLayers.find((l) => l.id === layerId);
  if (!layer) {
    console.warn(`Layer ${layerId} not found`);
    return;
  }
  if (layer.visible) hideContaminationLayer(layer);
  else await showContaminationLayer(layer);
  afterContaminationChange();
};

/** The row's "Could not load — try again" (P5-74). The layer is off after a
 *  failure, so this is simply the on path once more, minus the stale error. */
const retryContaminationLayer = async (layerId: string): Promise<void> => {
  const layer = contaminationLayers.find((l) => l.id === layerId);
  if (!layer || layer.status === "loading") return;
  layer.status = undefined;
  await showContaminationLayer(layer);
  afterContaminationChange();
};

const toggleContaminationLayers = async (): Promise<void> => {
  const turnOn = !showContaminationLayers.value;
  showContaminationLayers.value = turnOn;
  debugLog(`Toggling all layers to ${turnOn ? "visible" : "none"}`);
  if (turnOn) await Promise.all(contaminationLayers.map(showContaminationLayer));
  else contaminationLayers.forEach(hideContaminationLayer);
  afterContaminationChange();
};

/** Put one contamination site layer on or off by id — what a saved view's
 *  restore asks for (P5-78). Returns whether it ended up on. */
const setContaminationLayer = async (layerId: string, on: boolean): Promise<boolean> => {
  const layer = contaminationLayers.find((l) => l.id === layerId);
  if (!layer) return false;
  let nowOn = false;
  if (on) nowOn = await showContaminationLayer(layer);
  else hideContaminationLayer(layer);
  afterContaminationChange();
  return nowOn;
};

/** Re-sync the "All Individual Sites" checkbox and, when the county-level
 *  comparison is on, its colors. Every contamination change ends here. */
const afterContaminationChange = () => {
  updateShowAllCheckbox();
  if (showContaminationChoropleth.value) updateChoroplethColors();
};

// Add this new function to synchronize the "Show All" checkbox state
const updateShowAllCheckbox = () => {
  showContaminationLayers.value =
    contaminationLayers.length > 0 && contaminationLayers.every((l) => l.visible);
};

// ========== colours ==========
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
    selectedInternalLayers.value.length > 0 ||
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
          } else if (selectedInternalLayers.value.length === 1) {
            finalColor = getColorForInternalLayer(geoID, selectedInternalLayers.value[0]);
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
    value = data.median_income_black ?? null;
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
    value = data.median_home_value ?? null;
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
    value = data.median_property_tax ?? null;
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
    value = data.homeownership_rate_black ?? null;
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
    value = data.poverty_rate_black ?? null;
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
    value = data.black_progress_index ?? null;
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

/** P5-18: generic color for a runtime-registered internal layer — range +
 *  direction come from the registry definition (data-derived range once
 *  values load), so no per-layer code exists in the bundle. */
const getColorForInternalLayer = (
  geoID: string,
  layerId: string
): [number, number, number, number] => {
  const def = LAYER_REGISTRY[layerId];
  if (!def) return [0, 0, 0, 0];
  return colorForRegistryValue(def, internalLayerValues.value[layerId]?.[geoID]);
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

// ========== recolour watchers ==========
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


// ========== the hover tooltip ==========
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
    if (props.hoverTooltip) {
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
    if (!props.hoverTooltip) {
      tooltip.remove();
      return;
    }
    if (e.features && e.features.length > 0) {
      const feature = e.features[0];
      // Rendered county features always carry properties; `!` matches the
      // pre-existing runtime assumption (would have thrown on null before).
      const countyId = feature.properties!.GEOID;
      const countyName = feature.properties!.NAME;

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
      // Entries can be a bare number (legacy shape); `.total` on a number is
      // undefined at runtime and falls through to 0 — the cast keeps that
      // exact behavior while satisfying the union type.
      const totalContamination =
        (countyContaminationCounts[countyId] as ContaminationData | undefined)
          ?.total || 0;

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
        if (isInternalLayerId(layerId)) return internalLayerValues.value[layerId]?.[countyId];
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
        ...selectedInternalLayers.value,
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

      tooltip.setLngLat(e.lngLat).setHTML(tooltipContent).addTo(map.value!);
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
watch(() => props.hoverTooltip, () => {
  if (!map.value || !map.value.getLayer(HOVER_OUTLINE_LAYER)) return;
  if (!props.hoverTooltip) {
    map.value.setLayoutProperty(HOVER_OUTLINE_LAYER, "visibility", "none");
    map.value.getCanvas().style.cursor = '';
  }
});

// ========== internal feature overlays — points (P5-24), lines (P7-3) ==========
/** Fetch an overlay layer's features and put them on the map. The paint is
 *  the layer module's business; what differs here is only what a click means
 *  and what "go to this feature" can mean for a shape with no one position. */
const showInternalFeatureLayer = async (layerId: string): Promise<void> => {
  const layer = internalFeatureLayers.value.find(l => l.id === layerId);
  if (!layer) return;
  try {
    const collection = await fetchInternalLayerFeatures(layer.slug);
    // Still selected and still logged in? (toggle-off or logout may have raced)
    if (!selectedInternalFeatureLayers.value.includes(layerId) || !internalUser.value) return;
    internalFeatureData.value = { ...internalFeatureData.value, [layerId]: collection };
    if (!map.value) return;
    await waitForStyle();
    if (!selectedInternalFeatureLayers.value.includes(layerId) || !map.value) return;
    addFeatureLayerToMap(map.value, layer, collection);
    // P7-9: restack every overlay that is on, bottom to top — state washes,
    // then lines, then points. Mapbox appends, so a state switched on last
    // would otherwise cover the features it is context for and take their
    // clicks.
    orderFeatureLayers(map.value, activeFeatureLayers());
    attachFeatureHandlers(layer);
  } catch (err) {
    console.warn("[layers] internal feature layer failed:", err instanceof Error ? err.message : err);
  }
};

/** Registered once per layer id; Mapbox keeps layer-scoped listeners across
 *  remove/re-add. Which handlers a layer gets depends on its geometry. */
const attachFeatureHandlers = (layer: InternalFeatureLayer) => {
  if (!map.value || pointHandlersAttached.has(layer.id)) return;
  pointHandlersAttached.add(layer.id);
  if (layer.geometry === "line") return attachLineHandlers(layer, map.value);
  if (layer.geometry === "state") return attachStateHandlers(layer, map.value);
  attachPointHandlers(layer, map.value);
};

/** Click → popup, cluster click → zoom in, pointer cursor. */
const attachPointHandlers = (layer: InternalFeatureLayer, m: mapboxgl.Map) => {
  const ids = pointMapLayerIds(layer.id);
  m.on("click", ids.points, (e) => {
    const feature = e.features?.[0];
    if (!feature || feature.geometry.type !== "Point") return;
    const coords = feature.geometry.coordinates.slice(0, 2) as [number, number];
    pointPopup?.remove();
    pointPopup = new mapboxgl.Popup({ closeButton: true, maxWidth: "320px" })
      .setLngLat(coords)
      .setDOMContent(popupContent(feature.properties ?? {}, layer))
      .addTo(m);
    // Highlight the matching row in the entity rail (P5-28). Rendered
    // features carry tile-quantized coordinates, so match by label and
    // take the nearest candidate rather than an exact coordinate equality.
    const label = String(feature.properties?._label ?? "");
    const candidates = (internalFeatureData.value[layer.id]?.features ?? [])
      .map((f, index) => ({ index, f }))
      .filter(c => c.f.properties._label === label);
    let best: { index: number; d: number } | null = null;
    for (const c of candidates) {
      const at = anchorOfFeature(c.f);
      if (!at) continue;
      const d = Math.hypot(at[0] - coords[0], at[1] - coords[1]);
      if (!best || d < best.d) best = { index: c.index, d };
    }
    activeEntity.value = best && best.d < 0.01 ? { layerId: layer.id, index: best.index } : null;
  });
  m.on("click", ids.clusters, (e) => {
    const feature = e.features?.[0];
    if (!feature || feature.geometry.type !== "Point") return;
    const clusterId = feature.properties?.cluster_id;
    const source = m.getSource(featureSourceId(layer.id)) as mapboxgl.GeoJSONSource | undefined;
    if (!source || clusterId == null) return;
    const coords = feature.geometry.coordinates.slice(0, 2) as [number, number];
    source.getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err || zoom == null) return;
      m.easeTo({ center: coords, zoom });
    });
  });
  for (const id of [ids.points, ids.clusters]) {
    m.on("mouseenter", id, () => { m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; });
  }
};

/**
 * A line's handlers (P7-3). Three decisions live here, and they are the three
 * a shape with no single position forces:
 *
 * - **The popup anchors where you clicked** (`e.lngLat`), not at some computed
 *   centre. A 200-mile corridor has no "position"; the honest answer to "where
 *   is this line" is "where you touched it", and a popup that opens 80 miles
 *   from the pointer reads as a different feature's.
 * - **Hover widens the line it would take.** Transmission corridors cross, and
 *   on a 2 px stroke there is no other way to see which one is under the
 *   pointer. `feature-state` + the source's generated ids do it in the paint,
 *   so no re-render is involved.
 * - **The clicked row is matched by the feature's id, not by label + nearest
 *   coordinate** as a point's is. `generateId` numbers features by their index
 *   in the collection, so the rail row is exact — which matters because a
 *   click on a long line is nowhere near the vertex that stands for it.
 */
const attachLineHandlers = (layer: InternalFeatureLayer, m: mapboxgl.Map) => {
  const ids = lineMapLayerIds(layer.id);
  let hovered: number | string | null = null;
  const clearHover = () => {
    if (hovered !== null) m.removeFeatureState({ source: featureSourceId(layer.id), id: hovered }, "hover");
    hovered = null;
  };

  m.on("click", ids.hit, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    pointPopup?.remove();
    pointPopup = new mapboxgl.Popup({ closeButton: true, maxWidth: "320px" })
      .setLngLat(e.lngLat)
      .setDOMContent(popupContent(feature.properties ?? {}, layer))
      .addTo(m);
    const index = typeof feature.id === "number" ? feature.id : Number(feature.id);
    const total = internalFeatureData.value[layer.id]?.features.length ?? 0;
    activeEntity.value = Number.isInteger(index) && index >= 0 && index < total ? { layerId: layer.id, index } : null;
  });

  m.on("mousemove", ids.hit, (e) => {
    m.getCanvas().style.cursor = "pointer";
    const id = e.features?.[0]?.id;
    if (id == null || id === hovered) return;
    clearHover();
    hovered = id;
    m.setFeatureState({ source: featureSourceId(layer.id), id }, { hover: true });
  });
  m.on("mouseleave", ids.hit, () => {
    m.getCanvas().style.cursor = "";
    clearHover();
  });
};

/**
 * A state's handlers (P7-9). Deliberately the line's, with the fill as the
 * hit target instead of an invisible twin:
 *
 * - **The popup anchors where you clicked.** A state has no position either,
 *   and a popup for Georgia opening on the Georgia/Florida line reads as
 *   Florida's. This is P7-3's rule holding for the same reason.
 * - **Hover lifts the wash and thickens the outline.** At 18% opacity a state
 *   is scenery; the lift is what says the thing under the pointer is clickable
 *   and which of two neighbours it is. `feature-state` does it in the paint.
 * - **The clicked row is matched by `feature.id`**, which `generateId` makes
 *   the index in the collection. A state has no coordinate to match on at all,
 *   so the point layer's label-plus-nearest-vertex rule has nothing to work
 *   with here.
 */
const attachStateHandlers = (layer: InternalFeatureLayer, m: mapboxgl.Map) => {
  const ids = stateMapLayerIds(layer.id);
  let hovered: number | string | null = null;
  const clearHover = () => {
    if (hovered !== null) m.removeFeatureState({ source: featureSourceId(layer.id), id: hovered }, "hover");
    hovered = null;
  };

  m.on("click", ids.fill, (e) => {
    const feature = e.features?.[0];
    if (!feature) return;
    pointPopup?.remove();
    pointPopup = new mapboxgl.Popup({ closeButton: true, maxWidth: "380px", className: "popup-state" })
      .setLngLat(e.lngLat)
      .setDOMContent(popupContent(feature.properties ?? {}, layer))
      .addTo(m);
    const index = typeof feature.id === "number" ? feature.id : Number(feature.id);
    const total = internalFeatureData.value[layer.id]?.features.length ?? 0;
    activeEntity.value = Number.isInteger(index) && index >= 0 && index < total ? { layerId: layer.id, index } : null;
  });

  m.on("mousemove", ids.fill, (e) => {
    m.getCanvas().style.cursor = "pointer";
    const id = e.features?.[0]?.id;
    if (id == null || id === hovered) return;
    clearHover();
    hovered = id;
    m.setFeatureState({ source: featureSourceId(layer.id), id }, { hover: true });
  });
  m.on("mouseleave", ids.fill, () => {
    m.getCanvas().style.cursor = "";
    clearHover();
  });
};

/** The map side of an overlay going on or off. The selection itself is
 *  `useMapState`'s, so this reacts to it rather than owning it — which is also
 *  what puts the overlays back on a style this canvas has just rebuilt. */
const syncPointLayers = (now: string[], before: string[] = []) => {
  for (const id of before) {
    if (now.includes(id)) continue;
    if (map.value) removeFeatureLayerFromMap(map.value, id);
    pointPopup?.remove();
    pointPopup = null;
  }
  for (const id of now) {
    if (before.includes(id)) continue;
    void showInternalFeatureLayer(id);
  }
};

/** Wait (up to 10 s) for a point layer's features to land after it was
 *  switched on. Callers that need the data — a deep link's frame, the chat
 *  tool's fly-to, a `?focus=` label — all go through here. */
const waitForPointData = async (layerId: string): Promise<InternalFeatureCollection | null> => {
  for (let i = 0; i < 50 && !internalFeatureData.value[layerId]; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return internalFeatureData.value[layerId] ?? null;
};

/**
 * P5-26: the chat's `show_layer` tool. Public ids go through the category
 * toggles; internal ids only resolve while logged in (the manifest is empty
 * otherwise, so the model gets "not available"). Resolves to the line the
 * answer reads back, or null when this session has no such layer.
 */
const showLayer = async (layerId: string, on: boolean): Promise<string | null> => {
  const county = internalLayers.value.find(l => l.id === layerId);
  if (county) {
    const isOn = selectedInternalLayers.value.includes(layerId);
    if (on !== isOn) props.layers.toggle.internal(layerId);
    return `${county.name} is now ${on ? 'on' : 'off'}.`;
  }
  const overlay = internalFeatureLayers.value.find(l => l.id === layerId);
  if (overlay) {
    const isOn = selectedInternalFeatureLayers.value.includes(layerId);
    if (on !== isOn) props.layers.toggle.points(layerId);
    if (on) {
      const collection = await waitForPointData(layerId);
      const bbox = collection?.bbox ?? (collection ? boundsForFeatures(collection.features) : null);
      if (bbox && map.value) map.value.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 60, maxZoom: 10, duration: 800 });
      // The count says what it counted: "3 lines", never "3 points".
      const noun = overlay.geometry === "line" ? "line" : overlay.geometry === "state" ? "state" : "point";
      const counted = collection?.count != null ? ` (${collection.count} ${noun}${collection.count === 1 ? '' : 's'})` : '';
      return `${overlay.name} is now on${counted}.`;
    }
    return `${overlay.name} is now off.`;
  }
  // P5-74: a contamination site layer is not in the registry, so its name
  // comes from its own definition — and switching it on waits for the fetch.
  const publicName = LAYER_REGISTRY[layerId]?.name
    ?? contaminationLayers.find(l => l.id === layerId)?.name
    ?? layerId;
  if (!on) {
    const wasOn = ensurePublicLayerOff(layerId);
    return wasOn === null ? null : `${publicName} is now off.`;
  }
  if (!(await ensurePublicLayerOn(layerId))) return null;
  const site = contaminationLayers.find(l => l.id === layerId);
  if (site && site.status === "error") return `${publicName} could not be loaded — the data did not download.`;
  return `${publicName} is now on.`;
};

// ========== entity focus + feature popups (P5-28, lines in P7-3) ==========
/**
 * Go to one feature of an overlay layer — a rail row, a `?focus=` link, the
 * chat's fly-to.
 *
 * **A point flies to itself; anything with an extent is FRAMED.** Easing to a
 * line's anchor at zoom 9 would show three miles of a hundred-mile corridor and
 * no sense of where it runs — "show me this transmission line" means the line,
 * so its own extent is the frame. `maxZoom` keeps a short stub from zooming to
 * street level. The popup still opens at the anchor vertex, because a popup
 * needs one coordinate and that one is on the wire.
 *
 * P7-9 makes that a rule about shape rather than a case for lines: a state is
 * framed too, and more obviously — "show me Georgia" could not mean anything
 * else. A point is the only geometry that IS a position, so it is the only one
 * that flies to one.
 */
const focusEntity = (target: EntityRef) => {
  const layer = internalFeatureLayers.value.find(l => l.id === target.layerId);
  const feature = internalFeatureData.value[target.layerId]?.features[target.index];
  if (!layer || !feature || !map.value) return;
  const anchor = anchorOfFeature(feature);
  if (!anchor) return;
  activeEntity.value = target;
  const extent = layer.geometry === "point" ? null : boundsOfFeature(feature);
  if (extent) {
    map.value.fitBounds([[extent[0], extent[1]], [extent[2], extent[3]]], { padding: 60, maxZoom: 12, duration: 700 });
  } else {
    map.value.easeTo({ center: anchor, zoom: Math.max(map.value.getZoom(), 9) });
  }
  pointPopup?.remove();
  pointPopup = new mapboxgl.Popup({ closeButton: true, maxWidth: "320px" })
    .setLngLat(anchor)
    .setDOMContent(popupContent(feature.properties ?? {}, layer))
    .addTo(map.value);
};

/** Popup DOM for a feature: fields + an in-app "Open record" link (P5-36)
 *  that routes through the SPA instead of reloading the page. */
const popupContent = (properties: Record<string, unknown>, layer: InternalFeatureLayer): HTMLElement => {
  const label = String(properties._label ?? "");
  const el = buildFeaturePopup(properties, layer, label ? recordUrl(layer.slug, label) : undefined);
  el.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.("a[data-internal]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    void router.push(a.getAttribute("href") ?? "/");
  });
  return el;
};


// ========== public layers on and off — a deep link, a saved view, the chat tool ==========
/** Turn a public layer on by id through its category toggle (no-op if
 *  unknown). Async because a contamination site layer fetches its GeoJSON on
 *  the way on (P5-74) — the callers narrate the result, so they wait for it. */
const ensurePublicLayerOn = async (id: string): Promise<boolean> => {
  const categories: [{ id: string }[], string[], (id: string) => void][] = [
    [demographicLayers, selectedDemographicLayers.value, props.layers.toggle.demographic],
    [economicLayers, selectedEconomicLayers.value, props.layers.toggle.economic],
    [housingLayers, selectedHousingLayers.value, props.layers.toggle.housing],
    [equityLayers, selectedEquityLayers.value, props.layers.toggle.equity],
    [transportationLayers, selectedTransportationLayers.value, props.layers.toggle.transportation],
  ];
  for (const [defs, selected, toggle] of categories) {
    if (defs.some(l => l.id === id)) {
      if (!selected.includes(id)) toggle(id);
      return true;
    }
  }
  const site = contaminationLayers.find(l => l.id === id);
  if (site) {
    if (!site.visible) await toggleContaminationLayer(id);
    return true;
  }
  if (id === "contamination") {
    if (!showContaminationChoropleth.value) props.layers.toggle.contaminationChoropleth();
    return true;
  }
  return false;
};

/** Turn a public layer off by id (null = unknown id, false = already off). */
const ensurePublicLayerOff = (id: string): boolean | null => {
  const categories: [{ id: string }[], string[], (id: string) => void][] = [
    [demographicLayers, selectedDemographicLayers.value, props.layers.toggle.demographic],
    [economicLayers, selectedEconomicLayers.value, props.layers.toggle.economic],
    [housingLayers, selectedHousingLayers.value, props.layers.toggle.housing],
    [equityLayers, selectedEquityLayers.value, props.layers.toggle.equity],
    [transportationLayers, selectedTransportationLayers.value, props.layers.toggle.transportation],
  ];
  for (const [defs, selected, toggle] of categories) {
    if (defs.some(l => l.id === id)) {
      if (selected.includes(id)) {
        toggle(id);
        return true;
      }
      return false;
    }
  }
  const site = contaminationLayers.find(l => l.id === id);
  if (site) {
    if (!site.visible) return false;
    hideContaminationLayer(site);
    afterContaminationChange();
    return true;
  }
  if (id === "contamination") {
    if (showContaminationChoropleth.value) {
      props.layers.toggle.contaminationChoropleth();
      return true;
    }
    return false;
  }
  return null;
};

// ========== overlay map layer ids (the click guard) ==========
/** Map layer ids of active overlay layers that exist right now, for the click
 *  hit-test that stops a click on a feature from also opening the county
 *  underneath it. A line's wide transparent hit layer is in here — without it
 *  clicking a transmission line would inspect the county it crosses. */
const existingPointMapLayerIds = (): string[] => {
  if (!map.value) return [];
  return allFeatureMapLayerIds(activeFeatureLayers()).filter(id => !!map.value!.getLayer(id));
};

/** The overlay layers that are switched on and known to the manifest — what
 *  the click guard hit-tests and what `orderFeatureLayers` restacks. */
const activeFeatureLayers = (): InternalFeatureLayer[] =>
  selectedInternalFeatureLayers.value
    .map(id => internalFeatureLayers.value.find(l => l.id === id))
    .filter((l): l is InternalFeatureLayer => !!l);

// ========== moving the map ==========

/** Open a county: tell the host (which may put a rail or a modal on it) and
 *  frame it. The canvas itself has no notion of a "selected" county. */
const inspectCounty = (geoId: string): void => {
  if (!geoId) return;
  emit("county-click", geoId);
  zoomToGeoId(geoId);
};

/** Frame a box — what a `?fit=bbox:…` link and a point layer's extent use. */
const fitToBbox = (
  bbox: [number, number, number, number],
  opts: { padding?: number; maxZoom?: number; duration?: number } = {},
): boolean => {
  if (!map.value) return false;
  map.value.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
    padding: opts.padding ?? 60,
    maxZoom: opts.maxZoom ?? 10,
    duration: opts.duration ?? 900,
  });
  return true;
};

/** The declarative form of the two above: a host sets `fit` and the canvas
 *  moves. A page showing its own filtered rows frames them this way. */
const applyFit = (request: MapFitRequest | null | undefined): void => {
  if (!request) return;
  const { padding, maxZoom, duration } = request;
  if (request.bbox) fitToBbox(request.bbox, { padding, maxZoom, duration });
  else if (request.geoIds?.length) fitToGeoIds(request.geoIds, { padding, maxZoom, duration });
  // A saved viewport is a decision, not a frame to compute: jump, don't fit.
  else if (request.center && typeof request.zoom === "number") {
    map.value?.jumpTo({ center: request.center, zoom: request.zoom });
  }
};

watch(() => props.fit, (request) => applyFit(request), { deep: true });
watch(() => props.focusGeoId, (geoId) => {
  if (geoId) zoomToGeoId(geoId, { regional: true });
});

// A point overlay going on or off is the state's call; putting it on this
// map is ours.
watch(
  () => [...selectedInternalFeatureLayers.value],
  (now, before) => syncPointLayers(now, before),
);

// ========== the tool context ==========

/**
 * What the chat's map tools drive. The public map builds its own context on
 * top of this one (it has a ranking panel and a land search to offer); a page
 * that only has a canvas uses this as it stands, which is what `/chat` does:
 * `executeTool(name, args, ctx)` with the four map tools, while every library
 * tool stays on the server.
 */
const toolContext: ToolContext = {
  get map() { return map.value; },
  applyQueryState: (input) => { props.query.apply(input); },
  openCountyModal: (geoId) => { inspectCounty(geoId); },
  /** No ranking panel here — the public map's context overrides this. */
  toggleRankingPanel: () => {},
  /** No listings panel here either; framing the county is the useful half. */
  triggerHousingSearch: (county) => { zoomToGeoId(county.geoId); },
  zoomToGeoId: (geoId) => { zoomToGeoId(geoId); },
  showLayer,
  getTopRankedCounties: async (limit) => {
    // The scoring pipeline is a chain of synchronous lazy computeds
    // (selected-layer refs → all → scoringQuery → scores → ranked), so a read
    // here is already settled the moment applyQueryState's ref writes return.
    // One nextTick drains any pending reactive effects deterministically —
    // no arbitrary sleep.
    await nextTick();
    return props.query.topRanked(limit);
  },
};

// ========== lifecycle ==========

let releaseRepaint: (() => void) | null = null;

onMounted(async () => {
  mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

  // A toggle repaints as synchronously as it did when the state and the paint
  // lived in one component.
  releaseRepaint = props.query.onRepaint(() => {
    updateChoroplethVisibility();
    updateChoroplethColors();
  });

  // P5-87: the county files go out first and nothing awaits them here. The
  // map is constructed in the same tick, so the Mapbox style, the tiles and
  // the two county fetches are all in flight together — the basemap paints
  // while the counties are still downloading, instead of after.
  const countyDataReady = startCountyDataLoad();

  // Guard against the case where the component has been torn down or the
  // template ref is not bound yet. The error is benign — Vite HMR can
  // disconnect the container — but the stack trace is noisy.
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
  // A handle for dev tools and for the e2e build (`VITE_E2E=1`, set by
  // `npm run test:e2e`): the deep-link specs read the map's layers and
  // bounds through it. Never set in a production build, and claimed by one
  // canvas per page — the public map — so a pane cannot shadow it.
  if (props.exposeHandle && (import.meta.env.DEV || import.meta.env.VITE_E2E === "1")) {
    (window as unknown as { __bloMap?: mapboxgl.Map }).__bloMap = map.value;
  }

  // The host can drive the map from here on: the tools only need the map to
  // exist, not the counties to have landed.
  emit("ready", toolContext);

  // map.value is assigned a few lines up; the `!`s below exist because the
  // intervening calls make TS drop the non-null narrowing on the ref.
  map.value!.on("load", async function () {
    debugLog("Map loaded");

    // Wait for style to be fully loaded
    if (!map.value?.isStyleLoaded()) {
      await new Promise((resolve) => map.value?.once("style.load", resolve));
    }

    // P5-87: the basemap is now painting. Everything below needs the county
    // files, which are still in flight as often as not — so this is where the
    // wait happens, not before the map was built. A failed fetch leaves the
    // basemap (and the panning, and the host's chrome) working.
    if (!(await countyDataReady) || !map.value || !countiesData.value) {
      console.warn("County data unavailable; map is up without the choropleth.");
      return;
    }

    addCountyChoroplethLayer();
    // P5-74: the overlay's job is done the moment the choropleth can paint.
    // Everything below this line is either instant or on demand.
    loadedFilesCount.value = COUNTY_DATA_FILES;
    layersLoaded.value = true;

    addCountyOverlayLayers(map.value!);

    // Add diversity layer
    await addDiversityLayer(map.value!);

    addTooltip();

    // P5-74: no contamination GeoJSON is fetched at startup. A remount gets a
    // fresh Mapbox style, though, so a layer this session already had on has
    // to be put back on it — and only that re-fetches (from the HTTP cache).
    for (const layer of contaminationLayers) {
      layer.status = undefined;
      if (layer.visible) void showContaminationLayer(layer);
    }
    // Same for point overlays the state already had on when this canvas
    // mounted — a pane that is closed and opened again gets them back.
    syncPointLayers([...selectedInternalFeatureLayers.value], []);

    // Set initial choropleth visibility based on pre-selected layers
    if (map.value && map.value.getLayer("county-choropleth")) {
      const initialVisibility = showDiversityChoropleth.value ? "visible" : "none";
      map.value.setLayoutProperty("county-choropleth", "visibility", initialVisibility);

      // Update colors if layer is visible
      if (showDiversityChoropleth.value) {
        updateChoroplethColors();
      }
    }

    // Whatever the host wanted framed before the polygons existed.
    applyFit(props.fit);
    if (props.focusGeoId) zoomToGeoId(props.focusGeoId, { regional: true });

    // The host's own overlays and deferred work can go on now.
    emit("counties-ready");
  });

  // Check if the style is already loaded (it might be if we're using a local style)
  if (map.value!.isStyleLoaded()) {
    debugLog("Style already loaded");
    addCountyChoroplethLayer();
  }

  // Add a listener for the 'styledata' event, which fires when the map's style is fully loaded
  map.value!.on("styledata", () => {
    addCountyChoroplethLayer();
  });

  map.value!.on("click", (e) => {
    // Marker clicks bubble to the map's click event in mapbox-gl. Without
    // this guard, clicking a property pin would also fire the county
    // click handler — which the host turns into an inspect, wiping the
    // active land search. Bail when the original DOM click target is inside
    // a marker.
    const target = (e.originalEvent?.target as HTMLElement | null);
    if (target && target.closest(".mapboxgl-marker")) {
      debugLog("Click landed on a marker — skipping county inspect");
      return;
    }
    // P5-24: a click on an internal point or cluster is handled by the
    // layer's own listener — don't also inspect the county underneath.
    const pointLayerIds = existingPointMapLayerIds();
    if (pointLayerIds.length > 0) {
      const hits = map.value?.queryRenderedFeatures(e.point, { layers: pointLayerIds });
      if (hits && hits.length > 0) return;
    }
    const features = map.value?.queryRenderedFeatures(e.point, {
      layers: ["county-choropleth"],
    });
    if (features && features.length > 0) {
      const countyId = features[0].properties?.GEOID;
      if (countyId) emit("county-click", countyId);
    }
  });

  // Add zoom and rotation controls to the map in the bottom-right corner
  map.value!.addControl(new mapboxgl.NavigationControl(), "bottom-right");

  addTooltip();
});

onBeforeUnmount(() => {
  // A pane is opened and closed over and over; everything this canvas put on
  // the page goes with it, or the next one inherits a popup and a WebGL
  // context nobody owns.
  releaseRepaint?.();
  releaseRepaint = null;
  pointPopup?.remove();
  pointPopup = null;
  pointHandlersAttached.clear();
  if (props.exposeHandle) {
    delete (window as unknown as { __bloMap?: mapboxgl.Map }).__bloMap;
  }
  map.value?.remove();
  map.value = null;
});

/**
 * The imperative surface a host needs on top of the two props: the chrome
 * around the public map drives its walkthrough, its deep links and its saved
 * views through these.
 */
defineExpose({
  /** The live map, for a host adding overlays of its own. */
  map,
  /** The same context `ready` emitted. */
  toolContext,
  /** True once the counties source and the choropleth are on the style. */
  countiesReady: layersLoaded,
  zoomToGeoId,
  fitToGeoIds,
  fitToBbox,
  inspectCounty,
  focusEntity,
  showLayer,
  ensurePublicLayerOn,
  ensurePublicLayerOff,
  toggleContaminationLayer,
  retryContaminationLayer,
  toggleContaminationLayers,
  setContaminationLayer,
  waitForStyle,
  waitForPointData,
  updateChoroplethVisibility,
  updateChoroplethColors,
});
</script>

<style scoped>
/* The canvas fills whatever box it is given — the public map's `.map-root`,
   or the chat page's pane. Position: relative so the loading overlay (which
   is absolute) belongs to the canvas and not to the host's layout. */
.map-canvas {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

/* Mapbox's container. Absolute so it cannot push the host's chrome around,
   and first in the DOM so every positioned sibling paints over it. */
.map-canvas-gl {
  position: absolute;
  inset: 0;
}

/* Mapbox GL JS popup styles. Global because Mapbox builds the popup DOM
   itself, outside any component's scope. Moved here with the tooltip and the
   point popups they style. */
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

/* P5-24: internal point-layer popups (DOM-built in lib/internalFeatureLayers.ts) */
:global(.internal-point-popup) {
  color: #111;
  font-size: 13px;
  line-height: 1.35;
  max-width: 300px;
}

:global(.internal-point-popup .popup-title) {
  display: block;
  font-size: 14px;
  margin-bottom: 6px;
}

:global(.internal-point-popup .popup-fields) {
  margin: 0;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 10px;
}

:global(.internal-point-popup .popup-fields dt) {
  color: #6b6560;
  font-weight: 600;
}

:global(.internal-point-popup .popup-fields dd) {
  margin: 0;
  word-break: break-word;
}

:global(.internal-point-popup .popup-fields a) {
  color: #1f7a2e;
}

/* P7-9: a state's prose. Its own scroll, so a long permitting process does not
   push the record link off the bottom of the map, and a wider popup than the
   300 px a point's two-column list wants — `.popup-state` is the class the
   state popup is constructed with. */
:global(.mapboxgl-popup.popup-state .mapboxgl-popup-content) {
  max-width: 380px;
}

:global(.popup-state .internal-point-popup) {
  max-width: 360px;
}

:global(.internal-point-popup .popup-detail) {
  margin-top: 8px;
  max-height: 260px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

:global(.internal-point-popup .popup-detail h4) {
  margin: 8px 0 2px;
  font-size: 12px;
  color: #6b6560;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

:global(.internal-point-popup .popup-detail h4:first-child) {
  margin-top: 0;
}

:global(.internal-point-popup .popup-detail p) {
  margin: 0 0 6px;
  white-space: pre-line;
  word-break: break-word;
}

:global(.internal-point-popup .popup-detail a) {
  color: #1f7a2e;
}

:global(.internal-point-popup .popup-record) {
  display: inline-block;
  margin-top: 8px;
  font-weight: 600;
  color: #1f7a2e;
}

:global(.internal-point-popup .popup-layer) {
  display: block;
  margin-top: 8px;
  color: #9a948e;
}
</style>
