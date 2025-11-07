<template>
  <div id="map" ref="mapContainer" style="width: 100%; height: 80vh">
    <div
      id="geocoder"
      class="geocoder"
      v-show="!showDetailedPopup"
      style="position: absolute; top: 10px; left: 10px; z-index: 1"
    ></div>
    <div
      id="search-listings"
      class="search-listings"
      v-show="!showDetailedPopup && currentGeocoderResult"
      style="position: absolute; top: 60px; left: 10px; z-index: 1"
    >
      <button
        @click="searchListings"
        class="listings-button"
        :disabled="!currentGeocoderResult || isSearchResultsLoading"
      >
        <span v-if="!isSearchResultsLoading">Find land for sale</span>
        <div v-else class="loader"></div>
      </button>
      <button
        v-if="listings.length > 0"
        @click="clearSearch"
        class="clear-search-button"
      >
        Clear Search
      </button>
    </div>
    <div v-if="listings.length > 0" id="listings-panel" class="listings-panel">
      <h3>
        Available Properties
        <button @click="toggleListings" class="toggle-listings-button">
          {{ listingsPanelExpanded ? "▼" : "▲" }}
        </button>
      </h3>

      <div v-show="listingsPanelExpanded">
        <button @click="downloadCSV" class="download-csv-button">
          Download CSV
        </button>
        <div class="listings-container">
          <div
            v-for="listing in listings"
            :key="listing.id"
            class="listing-card"
            @click="highlightMarker(listing)"
          >
            <h4>{{ listing.formattedAddress }}</h4>
            <p>Price: ${{ listing.price.toLocaleString() }}</p>
            <p>Lot Size: {{ listing.lotSize }} sq ft</p>
            <p>Days on Market: {{ listing.daysOnMarket }}</p>
            <a :href="listing.listingOffice?.website" target="_blank"
              >Realtor Website</a
            >
            <a
              :href="`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(listing.formattedAddress)}`"
              target="_blank"
              class="google-maps-link"
            >
              View on Google Maps
            </a>
          </div>
        </div>
      </div>
    </div>
    <LayerControls
      :expanded="layerControlExpanded"
      :demographic-layers="demographicLayers"
      :economic-layers="economicLayers"
      :housing-layers="housingLayers"
      :equity-layers="equityLayers"
      :contamination-layers="contaminationLayers"
      :selected-demographic-layers="selectedDemographicLayers"
      :selected-economic-layers="selectedEconomicLayers"
      :selected-housing-layers="selectedHousingLayers"
      :selected-equity-layers="selectedEquityLayers"
      :show-contamination-layers="showContaminationLayers"
      :show-contamination-choropleth="showContaminationChoropleth"
      :dev-mode-only="DEV_MODE_DEMOGRAPHICS_ONLY"
      @toggle="toggleLayerControl"
      @toggle-demographic="toggleDemographicLayer"
      @toggle-economic="toggleEconomicLayer"
      @toggle-housing="toggleHousingLayer"
      @toggle-equity="toggleEquityLayer"
      @toggle-contamination="toggleContaminationLayer"
      @toggle-contamination-layers="toggleContaminationLayers"
      @toggle-contamination-choropleth="toggleContaminationChoropleth"
    >
      <LoadingIndicator :loaded="layersLoaded" :progress="loadingProgress" />
    </LayerControls>

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
      @close="closeDetailedPopup"
    />

    <AveragesPanel
      :expanded="averagesPanelExpanded"
      @toggle="toggleAveragesPanel"
    />

    <ColorLegend
      :selected-demographic-layers="selectedDemographicLayers"
      :selected-economic-layers="selectedEconomicLayers"
      :selected-housing-layers="selectedHousingLayers"
      :selected-equity-layers="selectedEquityLayers"
      :show-contamination-choropleth="showContaminationChoropleth"
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
} from "@/config/layerConfig";
import {
  DEV_MODE_DEMOGRAPHICS_ONLY,
  debugLog,
  MAPBOX_ACCESS_TOKEN,
  MAP_CONFIG,
} from "@/config/constants";
import type { ColorBlend } from "@/types/mapTypes";
import CountyModal from "@/components/CountyModal.vue";
import LayerControls from "@/components/LayerControls.vue";
import LoadingIndicator from "@/components/LoadingIndicator.vue";
import AveragesPanel from "@/components/AveragesPanel.vue";
import ColorLegend from "@/components/ColorLegend.vue";

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

// Initialize property listings composable
const {
  listings,
  listingMarkers,
  listingsPanelExpanded,
  isSearchResultsLoading,
  currentGeocoderResult,
  toggleListings,
  highlightMarker,
  downloadCSV,
  searchListings,
  clearSearch,
} = usePropertyListings(map, geocoderRef);

const layerControlExpanded = ref(true);
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

const averagesPanelExpanded = ref(false);

const toggleAveragesPanel = () => {
  averagesPanelExpanded.value = !averagesPanelExpanded.value;
};

const closeDetailedPopup = () => {
  showDetailedPopup.value = false;
};

const toggleLayerControl = () => {
  layerControlExpanded.value = !layerControlExpanded.value;
};

const toggleContaminationChoropleth = () => {
  showContaminationChoropleth.value = !showContaminationChoropleth.value;

  // Clear BLO index if present when turning on contamination choropleth
  if (showContaminationChoropleth.value) {
    const bloIndex = selectedDemographicLayers.value.findIndex(
      id => id === 'combined_scores' || id === 'combined_scores_v2'
    );
    if (bloIndex !== -1) {
      selectedDemographicLayers.value.splice(bloIndex, 1);
      const bloLayer = demographicLayers.find(l => l.id === 'combined_scores' || l.id === 'combined_scores_v2');
      if (bloLayer) bloLayer.visible = false;
    }
  }

  updateChoroplethVisibility();
};

const selectedDemographicLayers = ref<string[]>(['combined_scores_v2']);
const selectedEconomicLayers = ref<string[]>([]);
const selectedHousingLayers = ref<string[]>([]);
const selectedEquityLayers = ref<string[]>([]);

// Computed property to track ALL selected layers across categories
const allSelectedLayers = computed(() => {
  const layers = [
    ...selectedDemographicLayers.value,
    ...selectedEconomicLayers.value,
    ...selectedHousingLayers.value,
    ...selectedEquityLayers.value,
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

// Layer ID to component name mapping for combined_scores_v2.json
const layerToComponent: Record<string, string> = {
  'diversity_index': 'diversity',
  'pct_Black': 'pct_black',
  'life_expectancy': 'life_expectancy',
  'contamination': 'contamination',  // For EPA contamination choropleth
  'avg_weekly_wage': 'avg_weekly_wage',
  'median_income_by_race': 'median_income_black',
  'median_home_value': 'median_home_value',
  'median_property_tax': 'median_property_tax',
  'homeownership_by_race': 'homeownership_black',
  'poverty_by_race': 'poverty_rate_black',
  'black_progress_index': 'black_progress_index',
};

// Compute combined score for multiple selected layers
const computeCombinedScore = (countyId: string, selectedLayerIds: string[]): number => {
  if (selectedLayerIds.length === 0) return 0;

  const countyData = combinedScoresV2Data.value[countyId];
  if (!countyData || !countyData.components) return 0;

  // Map layer IDs to component names and get their normalized values
  const componentValues: number[] = [];

  selectedLayerIds.forEach(layerId => {
    const componentName = layerToComponent[layerId];
    if (componentName && countyData.components[componentName as keyof typeof countyData.components] != null) {
      componentValues.push(countyData.components[componentName as keyof typeof countyData.components]);
    }
  });

  // Return 0 if no valid components found
  if (componentValues.length === 0) return 0;

  // Average the normalized component values (0-1) and scale to 0-5
  const average = componentValues.reduce((sum, val) => sum + val, 0) / componentValues.length;
  return average * 5;
};

const toggleDemographicLayer = (layerId: string) => {
  debugLog("TOGGLING " + layerId);
  const layer = demographicLayers.find((l) => l.id === layerId);
  if (!layer) return;

  if (layerId === "combined_scores" || layerId === "combined_scores_v2") {
    // Handle combined scores separately
    if (selectedDemographicLayers.value[0] === layerId) {
      selectedDemographicLayers.value = [];
      demographicLayers.forEach((l) => {
        if (l.id === layerId) {
          l.visible = false;
        }
      });
    } else {
      selectedDemographicLayers.value = [layerId];
      demographicLayers.forEach(
        (l) => (l.visible = l.id === layerId)
      );
    }
  } else {
    const currentIndex = selectedDemographicLayers.value.indexOf(layerId);

    if (currentIndex === -1) {
      // Adding a new layer - clear BLO index if present
      const bloIndex = selectedDemographicLayers.value.findIndex(
        id => id === 'combined_scores' || id === 'combined_scores_v2'
      );
      if (bloIndex !== -1) {
        selectedDemographicLayers.value.splice(bloIndex, 1);
        const bloLayer = demographicLayers.find(l => l.id === 'combined_scores' || l.id === 'combined_scores_v2');
        if (bloLayer) bloLayer.visible = false;
      }

      selectedDemographicLayers.value.push(layerId);
      layer.visible = true;
    } else {
      // Removing a layer
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
    // Clear BLO index if present
    const bloIndex = selectedDemographicLayers.value.findIndex(
      id => id === 'combined_scores' || id === 'combined_scores_v2'
    );
    if (bloIndex !== -1) {
      selectedDemographicLayers.value.splice(bloIndex, 1);
      const bloLayer = demographicLayers.find(l => l.id === 'combined_scores' || l.id === 'combined_scores_v2');
      if (bloLayer) bloLayer.visible = false;
    }

    // Allow multiple economic layers to be selected
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
    // Clear BLO index if present
    const bloIndex = selectedDemographicLayers.value.findIndex(
      id => id === 'combined_scores' || id === 'combined_scores_v2'
    );
    if (bloIndex !== -1) {
      selectedDemographicLayers.value.splice(bloIndex, 1);
      const bloLayer = demographicLayers.find(l => l.id === 'combined_scores' || l.id === 'combined_scores_v2');
      if (bloLayer) bloLayer.visible = false;
    }

    // Allow multiple housing layers to be selected
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
    // Clear BLO index if present
    const bloIndex = selectedDemographicLayers.value.findIndex(
      id => id === 'combined_scores' || id === 'combined_scores_v2'
    );
    if (bloIndex !== -1) {
      selectedDemographicLayers.value.splice(bloIndex, 1);
      const bloLayer = demographicLayers.find(l => l.id === 'combined_scores' || l.id === 'combined_scores_v2');
      if (bloLayer) bloLayer.visible = false;
    }

    // Allow multiple equity layers to be selected
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
    selectedEquityLayers.value.length > 0
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
        "Data source: U.S. Environmental Protection Agency - add link here",
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
    showContaminationChoropleth.value
  ) {
    // Check if we should use multi-layer combined scoring
    const useMultiLayerScoring = allSelectedLayers.value.length >= 2;

    expression = [
      "match",
      ["get", "GEOID"],
      ...Object.entries(preCalculatedColors.value).flatMap(
        ([geoID, colors]) => {
          let finalColor: [number, number, number, number];

          if (useMultiLayerScoring) {
            // Multi-layer selection: compute combined score and use BLO gradient
            const combinedScore = computeCombinedScore(geoID, allSelectedLayers.value);
            finalColor = getColorForCombinedScore(combinedScore);
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
          } else if (showContaminationChoropleth.value && allSelectedLayers.value.length === 1) {
            // Single contamination layer selected
            finalColor = colors.contaminationColor;
          } else {
            finalColor = [0, 0, 0, 0];
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

// Color calculation for BLO Liveability Index
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

// Color calculation for combined multi-layer scores (uses same BLO gradient)
const getColorForCombinedScore = (score: number): [number, number, number, number] => {
  if (score === 0) return [0, 0, 0, 0];

  // Score is already 0-5 range, normalize using same bounds as BLO v2
  const MIN_SCORE = 1.15;
  const MAX_SCORE = 3.28;

  const normalized = Math.max(0, Math.min(1, (score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)));

  // Apply slight curve to emphasize extremes
  const curved = Math.pow(normalized, 0.9);

  // Use same BLO gradient: Bright yellow -> Deep emerald green
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

      // Helper to get layer name from config
      const getLayerName = (layerId: string) => {
        if (layerId === 'contamination') {
          return 'EPA Contamination Sites';
        }
        const allLayers = [
          ...demographicLayers,
          ...economicLayers,
          ...housingLayers,
          ...equityLayers,
        ];
        return allLayers.find(l => l.id === layerId)?.name || layerId;
      };

      // Helper to get formatted value for a layer
      const getLayerValue = (layerId: string) => {
        switch (layerId) {
          case 'combined_scores_v2':
            return combinedScoresV2Data.value[countyId]?.blo_score_v2
              ? `${combinedScoresV2Data.value[countyId].blo_score_v2.toFixed(2)} of 5.0`
              : '?';
          case 'diversity_index':
            return diversityValue != null ? diversityValue.toFixed(4) : '?';
          case 'pct_Black':
            return pctBlackValue != null ? `${pctBlackValue.toFixed(2)}%` : '?';
          case 'life_expectancy':
            return lifeExpValue ? `${lifeExpValue.toFixed(1)} years` : '?';
          case 'avg_weekly_wage':
            return economicData.value[countyId]?.avg_weekly_wage
              ? `$${economicData.value[countyId].avg_weekly_wage.toLocaleString()}`
              : '?';
          case 'median_income_by_race':
            return economicData.value[countyId]?.median_income_black
              ? `$${economicData.value[countyId].median_income_black.toLocaleString()}`
              : '?';
          case 'median_home_value':
            return housingData.value[countyId]?.median_home_value
              ? `$${housingData.value[countyId].median_home_value.toLocaleString()}`
              : '?';
          case 'median_property_tax':
            return housingData.value[countyId]?.median_property_tax
              ? `$${housingData.value[countyId].median_property_tax.toLocaleString()}`
              : '?';
          case 'homeownership_by_race':
            return housingData.value[countyId]?.homeownership_rate_black != null
              ? `${housingData.value[countyId].homeownership_rate_black.toFixed(1)}%`
              : '?';
          case 'poverty_by_race':
            return equityData.value[countyId]?.poverty_rate_black != null
              ? `${equityData.value[countyId].poverty_rate_black.toFixed(1)}%`
              : '?';
          case 'black_progress_index':
            return equityData.value[countyId]?.black_progress_index != null
              ? equityData.value[countyId].black_progress_index.toFixed(2)
              : '?';
          case 'contamination':
            return totalContamination > 0
              ? `${totalContamination} sites`
              : '0 sites';
          default:
            return '?';
        }
      };

      // Collect all active layers
      const activeLayers = [
        ...selectedDemographicLayers.value,
        ...selectedEconomicLayers.value,
        ...selectedHousingLayers.value,
        ...selectedEquityLayers.value,
      ];

      // Add contamination if choropleth is showing
      if (showContaminationChoropleth.value) {
        activeLayers.push('contamination');
      }

      // Show combined score if multiple layers are selected (excluding BLO indices)
      let combinedScoreHTML = '';
      if (allSelectedLayers.value.length >= 2) {
        const combinedScore = computeCombinedScore(countyId, allSelectedLayers.value);
        combinedScoreHTML = `
          <div style="background-color: #f0f8ff; padding: 8px; border-radius: 4px; margin-bottom: 8px;">
            <p style="margin: 0; font-size: 14px; font-weight: bold; color: #2c5f2d;">
              Combined Score: ${combinedScore.toFixed(2)} of 5.0
            </p>
            <p style="margin: 4px 0 0 0; font-size: 11px; color: #555;">
              (Average of ${allSelectedLayers.value.length} selected layers)
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
  });
};

const showDetailedPopupForFeature = (
  feature: mapboxgl.MapboxGeoJSONFeature
) => {
  const countyId = feature.properties.GEOID;
  const countyName = feature.properties.NAME;

  debugLog("Showing modal for county:", countyId, countyName);

  currentCounty.value = {
    id: countyId,
    name: countyName,
  };
  showDetailedPopup.value = true;
};


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

const handleGeocoderResult = (result: any) => {
  debugLog("Geocoder result:", result);

  if (result.center) {
    map.value?.flyTo({
      center: result.center,
      zoom: 10,
    });

    new mapboxgl.Marker().setLngLat(result.center).addTo(map.value!);
  } else {
    console.error("No coordinates found for this result");
    showGeocoderError(
      "Unable to find location. Please try a different search."
    );
  }
};

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

  debugLog("Initializing map");
  map.value = new mapboxgl.Map({
    container: mapContainer.value!,
    style: "mapbox://styles/mapbox/light-v10",
    center: MAP_CONFIG.DEFAULT_CENTER,
    zoom: MAP_CONFIG.DEFAULT_ZOOM,
  });

  geocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    countries: MAP_CONFIG.GEOCODER_COUNTRIES,
    types: "country,region,postcode,district,place",
    placeholder: "Search for a location",
  });

  // Set geocoder ref for composables
  geocoderRef.value = geocoder;

  const geocoderContainer = document.getElementById("geocoder");
  if (geocoderContainer) {
    geocoderContainer.appendChild(geocoder.onAdd(map.value!));

    // Add event listener for the 'result' event
    geocoder.on("result", function (e) {
      currentGeocoderResult.value = e.result;
      handleGeocoderResult(e.result);
    });

    // Add event listener for the Enter key press
    const geocoderInput = geocoderContainer.querySelector("input");
    if (geocoderInput) {
      geocoderInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          const query = (e.target as HTMLInputElement).value;
          geocoder.query(query);
        }
      });
    }
  }

  geocoder.on("error", function (e) {
    console.error("Geocoder error:", e);
  });

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
    const features = map.value?.queryRenderedFeatures(e.point, {
      layers: ["county-choropleth"],
    });
    if (features && features.length > 0) {
      const feature = features[0];
      debugLog("Clicked feature:", feature);
      debugLog("Feature ID:", feature.properties.GEOID);
      debugLog("Feature properties:", feature.properties);
      showDetailedPopupForFeature(feature);
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

.geocoder {
  width: 50%;
  max-width: 300px;
  z-index: 100 !important;
}

:global(.mapboxgl-ctrl-geocoder) {
  z-index: 100 !important;
}

:global(.mapboxgl-ctrl-geocoder) {
  width: 100%;
  max-width: 100%;
  font-size: 15px;
  line-height: 20px;
  box-shadow: 0 0 10px 2px rgba(0, 0, 0, 0.1);
}

:global(.mapboxgl-ctrl-geocoder--input) {
  height: 36px;
}

:global(.mapboxgl-ctrl-geocoder--icon) {
  top: 8px;
}

:global(.mapboxgl-ctrl-geocoder--button) {
  width: 36px;
  height: 36px;
}

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
  .geocoder {
    width: calc(100% - 20px);
    max-width: none;
  }

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
