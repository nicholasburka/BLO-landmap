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
      v-show="!showDetailedPopup"
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
      :selected-demographic-layers="selectedDemographicLayers"
      :show-contamination-layers="showContaminationLayers"
      :show-contamination-choropleth="showContaminationChoropleth"
      :dev-mode-only="DEV_MODE_DEMOGRAPHICS_ONLY"
      @toggle="toggleLayerControl"
      @toggle-demographic="toggleDemographicLayer"
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
      @close="closeDetailedPopup"
    />

    <AveragesPanel
      :expanded="averagesPanelExpanded"
      @toggle="toggleAveragesPanel"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive, watch, computed } from "vue";
import mapboxgl, { Expression, Map } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import MapboxGeocoder from "@mapbox/mapbox-gl-geocoder";
import "@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css";
import { usePropertyListings } from "@/composables/usePropertyListings";
import { useMapData } from "@/composables/useMapData";
import { useColorCalculation } from "@/composables/useColorCalculation";
import { DEMOGRAPHIC_LAYERS, CONTAMINATION_LAYERS } from "@/config/layerConfig";
import {
  DEV_MODE_DEMOGRAPHICS_ONLY,
  debugLog,
  MAPBOX_ACCESS_TOKEN,
  MAP_CONFIG,
} from "@/config/constants";
import CountyModal from "@/components/CountyModal.vue";
import LayerControls from "@/components/LayerControls.vue";
import LoadingIndicator from "@/components/LoadingIndicator.vue";
import AveragesPanel from "@/components/AveragesPanel.vue";

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
const showDiversityChoropleth = ref(false);
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
  updateChoroplethVisibility();
};

const selectedDemographicLayers = ref<string[]>([]);

const toggleDemographicLayer = (layerId: string) => {
  debugLog("TOGGLING " + layerId);
  const layer = demographicLayers.find((l) => l.id === layerId);
  if (!layer) return;

  if (layerId === "combined_scores") {
    // Handle combined scores separately
    if (selectedDemographicLayers.value[0] === "combined_scores") {
      selectedDemographicLayers.value = [];
      demographicLayers.forEach((l) => {
        if (l.id === "combined_scores") {
          l.visible = false;
        }
      });
    } else {
      selectedDemographicLayers.value = ["combined_scores"];
      demographicLayers.forEach(
        (l) => (l.visible = l.id === "combined_scores")
      );
    }
  } else {
    const currentIndex = selectedDemographicLayers.value.indexOf(layerId);

    if (currentIndex === -1) {
      // Adding a new layer
      if (selectedDemographicLayers.value.length >= 2) {
        // If we already have 2 layers, remove the first one
        selectedDemographicLayers.value.shift();
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

const updateChoroplethVisibility = () => {
  if (!map.value) return;

  debugLog("Updating choropleth visibility:", {
    showContaminationChoropleth: showContaminationChoropleth.value,
    showDiversityChoropleth: showDiversityChoropleth.value,
  });

  const visibility =
    showContaminationChoropleth.value ||
    showDiversityChoropleth.value ||
    selectedDemographicLayers.value.includes("combined_scores")
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

const toggleLayer = (layerId: string) => {
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

  if (showContaminationChoropleth.value) {
    expression = [
      "match",
      ["get", "GEOID"],
      ...Object.entries(preCalculatedColors.value).flatMap(
        ([geoID, colors]) => [geoID, ["rgba", ...colors.contaminationColor]]
      ),
      ["rgba", 0, 0, 0, 0], // default color
    ];
  } else if (selectedDemographicLayers.value.length > 0) {
    expression = [
      "match",
      ["get", "GEOID"],
      ...Object.entries(preCalculatedColors.value).flatMap(
        ([geoID, colors]) => {
          let finalColor: [number, number, number, number];

          if (selectedDemographicLayers.value.length === 1) {
            // Single layer selected
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
              default:
                finalColor = [0, 0, 0, 0];
            }
          } else {
            // Two layers selected - blend colors
            const [layer1, layer2] = selectedDemographicLayers.value;
            const color1 = getLayerColor(colors, layer1);
            const color2 = getLayerColor(colors, layer2);

            finalColor = [
              Math.round((color1[0] + color2[0]) / 2),
              Math.round((color1[1] + color2[1]) / 2),
              Math.round((color1[2] + color2[2]) / 2),
              Math.max(color1[3], color2[3]),
            ];
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

      const tooltipContent = `
        <h3>${countyName}, ${stateName}</h3>
        <p>BLO Combined Score: ${combinedScoresData.value[countyId]?.combinedScore ? getColoredValue(combinedScoresData.value[countyId].combinedScore, 2.84) : "?"}</p>
        <p>Total Population: ${countyDiversityData?.totalPopulation ? countyDiversityData.totalPopulation.toLocaleString() : "?"}</p>
        <p>Life Expectancy: ${lifeExpValue ? getColoredValue(lifeExpValue, averages.lifeExpectancy) + " years" : "?"}</p>
        <p>Percent Black: ${pctBlackValue != null ? getColoredValue(pctBlackValue, averages.blackPct) + "%" : "?"}</p>
        <p>Diversity Index: ${diversityValue != null ? getColoredValue(diversityValue, averages.diversityIndex) : "?"}</p>
        <p>EPA Sites of Land Toxicity: ${totalContamination != null ? getColoredValueContam(totalContamination, averages.contamination) : "?"}</p>
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

    // Ensure choropleth layer is not visible by default
    if (map.value && map.value.getLayer("county-choropleth")) {
      map.value.setLayoutProperty("county-choropleth", "visibility", "none");
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
  padding: 10px 20px;
  margin-top: 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 150px;
  min-height: 40px;
}

.listings-button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.listings-button:hover {
  background-color: #45a049;
}

.clear-search-button {
  background-color: #f44336;
  color: white;
  padding: 10px 20px;
  margin-top: 20px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 150px;
  min-height: 40px;
}

.clear-search-button:hover {
  background-color: #da190b;
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
    max-width: none;
  }
}

#layer-control-container {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  pointer-events: none; /* Allow clicks to pass through to the map */
}
.layer-control-toggle {
  background-color: white;
  border: none;
  padding: 5px 10px;
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
  pointer-events: auto; /* Re-enable pointer events for the button */
}
#layer-control {
  margin-top: 5px;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  pointer-events: auto; /* Re-enable pointer events for the control panel */
}

.layer-control-collapsed #layer-control {
  display: none;
}

.averages-panel-toggle {
  background-color: rgba(255, 255, 255, 0.9);
  border: none;
  padding: 5px 10px;
  font-size: 14px;
  cursor: pointer;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
}

.averages-content {
  color: black;
  background-color: rgba(255, 255, 255, 0.9);
  padding: 10px;
  margin-top: 5px;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
}

@media (max-width: 768px) {
  #layer-control-container {
    left: 10px;
    right: 10px;
    bottom: 10px;
  }

  .layer-control-toggle {
    width: 100%;
  }

  #layer-control {
    width: 100%;
    max-height: 50vh;
  }

  #averages-panel {
    left: 10px;
    right: 10px;
    bottom: 60px; /* Adjust based on your layer control height */
  }

  .averages-panel-toggle {
    width: 100%;
  }

  .averages-content {
    width: 100%;
  }
}

#layer-control h3 {
  margin-top: 0;
  color: black;
}

#layer-control label {
  display: block;
  margin-bottom: 5px;
  color: black;
}

.layer-item {
  display: flex;
  align-items: center;
  margin-bottom: 5px;
}

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

/*#detailed-popup {
  position: absolute;
  color: black;
  left: 20px;
  top: 20px;
  background: white;
  padding: 20px;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  max-width: 300px;
  max-height: 80vh;
  display: none;
  z-index: 1000;
}*/

/*#detailed-popup {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background: white;
  padding: 20px;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
  max-width: 90%;
  max-height: 90vh;
  width: 400px;
  overflow-y: auto;
  z-index: 1000;
  color: black;
}

.detailed-popup-close {
  position: absolute;
  top: 10px;
  right: 10px;
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #333;
}*/

#detailed-popup {
  position: fixed;
  background: white;
  padding: 20px;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  z-index: 2000 !important; /* Increased z-index to be above geocoder */
  color: black;
  font-size: 16px;
  overflow-y: auto;
  pointer-events: auto;
}

.detailed-popup-content {
  padding-right: 20px;
  pointer-events: auto;
}

.county-stats-table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
}

.county-stats-table tr {
  border-bottom: 1px solid #e0e0e0;
}

.county-stats-table tr:last-child {
  border-bottom: none;
}

.county-stats-table td {
  padding: 8px 10px;
  line-height: 1.4;
}

.county-stats-table td.label {
  font-weight: 600;
  color: #555;
  width: 50%;
  text-align: left;
}

.county-stats-table td.value {
  color: #333;
  text-align: right;
  width: 50%;
}

.detailed-popup-close {
  position: absolute;
  top: 10px;
  right: 10px;
  background: none;
  border: none;
  font-size: 28px; /* Increased close button size */
  cursor: pointer;
  color: #333;
  z-index: 2000;
  pointer-events: auto;
}

#detailed-popup h2 {
  font-size: 24px; /* Larger heading */
  margin-bottom: 15px;
}

#detailed-popup h3 {
  font-size: 20px; /* Larger subheading */
  margin-top: 20px;
  margin-bottom: 10px;
}

#detailed-popup p {
  margin: 8px 0;
  line-height: 1.4;
}

/* Mobile styles */
@media (max-width: 768px) {
  #detailed-popup {
    left: 5%;
    right: 5%;
    top: 50%;
    transform: translateY(-50%);
    max-height: 90vh;
    width: auto;
  }
}

/* Desktop styles */
@media (min-width: 769px) {
  #detailed-popup.desktop-view {
    left: 20px;
    top: 20px;
    max-height: calc(100vh - 40px);
    width: 400px;
    max-width: 30%;
  }
}

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
