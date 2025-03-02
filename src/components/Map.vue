<template>
  <div id="map" ref="mapContainer" style="width: 100%; height: 80vh">
    <div
      id="geocoder"
      class="geocoder"
      style="position: absolute; top: 10px; left: 10px; z-index: 1"
    ></div>
      <div 
      id="search-listings"
      class="search-listings"
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
    </div>
    <div 
    v-if="listings.length > 0"
    id="listings-panel"
    class="listings-panel"
  >
    <h3>Available Properties <button @click="toggleListings" class="toggle-listings-button">
        {{ listingsPanelExpanded ? '▼' : '▲' }}
      </button></h3>
    
    <div v-show="listingsPanelExpanded">
      <button @click="downloadCSV" class="download-csv-button">
        Download CSV
      </button>
    <div class="listings-container">
      <div v-for="listing in listings" :key="listing.id" class="listing-card" 
      @click="highlightMarker(listing)">
        <h4>{{ listing.formattedAddress }}</h4>
        <p>Price: ${{ listing.price.toLocaleString() }}</p>
        <p>Lot Size: {{ listing.lotSize }} sq ft</p>
        <p>Days on Market: {{ listing.daysOnMarket }}</p>
        <a :href="listing.listingOffice?.website" target="_blank">Realtor Website</a>
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
    <div
      id="layer-control-container"
      :class="{ 'layer-control-collapsed': !layerControlExpanded }"
      style="
        position: absolute;
        top: 50px;
        right: 10px;
        z-index: 10;
      "
    >
      <button @click="toggleLayerControl" class="layer-control-toggle">
        {{ layerControlExpanded ? '▼' : '▲' }} Layers
      </button>
      <div
        id="layer-control"
        v-show="layerControlExpanded"
        @click.stop
        style="
          background: white;
          padding: 10px;
          border-radius: 4px;
          box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
        "
      >
      <h3 style="color: black">Demographic Layers</h3>
      <div v-for="layer in demographicLayers" :key="layer.id" class="layer-item">
        <input
          type="checkbox"
          :id="layer.id"
          :checked="selectedDemographicLayers.includes(layer.id)"
          @change="toggleDemographicLayer(layer.id)"
        />
        <label :for="layer.id">{{ layer.name }}</label>
        <span class="tooltip-icon" v-if="layer.tooltip">
        ⓘ
        <span class="tooltip-text">{{ layer.tooltip }}</span>
        </span>
      </div>
      <template v-if="!DEV_MODE_DEMOGRAPHICS_ONLY">
        <h3 style="color: black">EPA - Sites of Contamination</h3>
        <div>
          <label style="color: black">
            <input
              type="checkbox"
              v-model="showContaminationLayers"
              @change="toggleContaminationLayers"
            />
            Show All
          </label>
        </div>
        <div v-for="layer in contaminationLayers" :key="layer.id" class="layer-item">
          <label style="color: black">
            <input type="checkbox" v-model="layer.visible" @click="toggleLayer(layer.id)" />
            <span class="color-dot" :style="{ backgroundColor: layer.color }"></span>
            {{ layer.name }}
          </label>
        </div>
        <div class="layer-item">
          <label style="color: black">
            <input
              type="checkbox"
              v-model="showContaminationChoropleth"
              @click="toggleContaminationChoropleth"
            />
            Show Contamination Choropleth
          </label>
        </div>
      </template>
      
    </div>
    <div v-if="!layersLoaded" class="loading-overlay">
      <div class="loading-content">
        <div class="progress-bar">
          <div class="progress" :style="{ width: `${loadingProgress}%` }"></div>
        </div>
        <div class="loading-text">Loading layers: {{ loadingProgress }}%</div>
      </div>
    </div>
    <div v-if="showDetailedPopup" id="detailed-popup" :class="{ 'desktop-view': isDesktopView }"@click.stop>
      <button @click="closeDetailedPopup" class="detailed-popup-close">&times;</button>
      <div class="detailed-popup-content" v-html="detailedPopupContent"></div>
    </div>
  </div>
  <div 
      id="averages-panel"
      :class="{ 'averages-panel-collapsed': !averagesPanelExpanded }"
      style="position: absolute; bottom: 10px; left: 10px; z-index: 10;"
    >
      <button @click="toggleAveragesPanel" class="averages-panel-toggle">
        {{ averagesPanelExpanded ? '▼' : '▲' }} National Averages (per county)
      </button>
      <div 
        v-show="averagesPanelExpanded"
        class="averages-content"
      >
        <p>Contamination Sites: 8.77</p>
        <p>Black Population: 9.05%</p>
        <p>Diversity Index: 0.33</p>
        <p>Life Expectancy: 77.74 years</p>
        <p>BLO Combined Score: 1.4</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive, watch, computed } from 'vue'
import mapboxgl, { Expression, Map } from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import MapboxGeocoder from '@mapbox/mapbox-gl-geocoder'
import '@mapbox/mapbox-gl-geocoder/dist/mapbox-gl-geocoder.css'
import Papa from 'papaparse'

const DEV_MODE_DEMOGRAPHICS_ONLY = false

const DEBUG = true; // Set to false to disable console logs

// Function to handle logging based on the debug flag
const debugLog = (...args) => {
  if (DEBUG) {
    console.log(...args);
  }
};

const mapContainer = ref<HTMLElement | null>(null)
const map = ref<mapboxgl.Map | null>(null)
const countiesData = ref<GeoJSON.FeatureCollection | null>(null)
let geocoder: MapboxGeocoder
const currentGeocoderResult = ref<any>(null)
const countyContaminationCounts = reactive<{ [key: string]: number }>({})
const detailedPopup = ref<HTMLElement | null>(null)

const layerControlExpanded = ref(true)
const showContaminationLayers = ref(false)
const showContaminationChoropleth = ref(false)
const showDiversityChoropleth = ref(false)
const showDetailedPopup = ref(false)
const detailedPopupContent = ref('')

const listings = ref<any[]>([])
const listingMarkers = ref<mapboxgl.Marker[]>([])

const listingsPanelExpanded = ref(true)

const isSearchResultsLoading = ref(false)

const toggleListings = () => {
  listingsPanelExpanded.value = !listingsPanelExpanded.value
}

const highlightMarker = (listing) => {
  // Remove highlight from all markers
  listingMarkers.value.forEach(marker => {
    marker.getElement().style.zIndex = '0'
    marker.getElement().style.filter = 'none'
  })

  // Find and highlight the corresponding marker
  const markerIndex = listings.value.findIndex(l => l.id === listing.id)
  if (markerIndex !== -1) {
    const marker = listingMarkers.value[markerIndex]
    marker.getElement().style.zIndex = '1'
    marker.getElement().style.filter = 'brightness(1.5)'
    
    // Center map on the marker
    map.value?.flyTo({
      center: [listing.longitude, listing.latitude],
      zoom: 10
    })
  }
}

const downloadCSV = () => {
  // Convert listings data to CSV format
  const csvData = Papa.unparse(listings.value.map(listing => ({
    // Basic Property Info
    address: listing.formattedAddress,
    addressLine1: listing.addressLine1,
    addressLine2: listing.addressLine2,
    city: listing.city,
    state: listing.state,
    zipCode: listing.zipCode,
    county: listing.county,
    latitude: listing.latitude,
    longitude: listing.longitude,
    
    // Property Details
    propertyType: listing.propertyType,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    squareFootage: listing.squareFootage,
    lotSize: listing.lotSize,
    yearBuilt: listing.yearBuilt,
    hoaFee: listing.hoa?.fee,
    
    // Listing Info
    status: listing.status,
    price: listing.price,
    listingType: listing.listingType,
    listedDate: listing.listedDate,
    removedDate: listing.removedDate,
    createdDate: listing.createdDate,
    lastSeenDate: listing.lastSeenDate,
    daysOnMarket: listing.daysOnMarket,
    mlsName: listing.mlsName,
    mlsNumber: listing.mlsNumber,
    
    // Listing Agent Info
    agentName: listing.listingAgent?.name,
    agentPhone: listing.listingAgent?.phone,
    agentEmail: listing.listingAgent?.email,
    agentWebsite: listing.listingAgent?.website,
    
    // Listing Office Info
    officeName: listing.listingOffice?.name,
    officePhone: listing.listingOffice?.phone,
    officeEmail: listing.listingOffice?.email,
    officeWebsite: listing.listingOffice?.website,
    
    // History (most recent event)
    mostRecentHistoryEvent: listing.history ? 
      Object.entries(listing.history)[0]?.[1]?.event : null,
    mostRecentHistoryPrice: listing.history ? 
      Object.entries(listing.history)[0]?.[1]?.price : null,
    mostRecentHistoryDate: listing.history ? 
      Object.entries(listing.history)[0]?.[0] : null
  })))

  // Create and trigger download
  const blob = new Blob([csvData], { type: 'text/csv' })
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.setAttribute('href', url)
  const getDateTime = (date = new Date()) => {
  return date.toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).replace(',', '');
}
  a.setAttribute('download', listings.value[0].county + listings.value[0].state + '-LandForSale-' + getDateTime() + '.csv')
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}

const searchListings = async () => {
  isSearchResultsLoading.value = true // Set loading to true when search starts
  // Clear existing markers
  listingMarkers.value.forEach(marker => marker.remove())
  listingMarkers.value = []

  const center = map.value?.getCenter()
  if (!center) return

  let searchUrl = 'https://api.rentcast.io/v1/listings/sale?'
  
  if (currentGeocoderResult.value) {
    if (currentGeocoderResult.value.place_type?.includes('place')) {
      // If it's a city search
      const state = currentGeocoderResult.value.context?.find(c => c.id.startsWith('region'))?.short_code?.split('-')[1]
      searchUrl += `city=${currentGeocoderResult.value.text}&state=${state}`
    } else {
      // If it's an address search
      searchUrl += `latitude=${center.lat}&longitude=${center.lng}&radius=100`
    }
  } else {
    // No geocoder result, use map center
    searchUrl += `latitude=${center.lat}&longitude=${center.lng}&radius=100`
  }

  // Add common parameters
  searchUrl += '&propertyType=Land&status=Active&limit=60'

  try {
    const response = await fetch(searchUrl, {
      headers: {
        accept: 'application/json',
        'X-Api-Key': '72f7ed2c628a40169dfa4bdaf2655fd8'
      }
    })
    
    const data = await response.json()
    debugLog('got rentcast data')
    debugLog(data)
    listings.value = data
    if (data.length === 0) {
      alert("No lots found within 100 miles of this point, try somewhere else.");
    }

    // Add markers for each listing
    data.forEach((listing: any) => {
      const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <div class="listing-popup">
          <h4>${listing.formattedAddress}</h4>
          <p>Price: $${listing.price.toLocaleString()}</p>
          <p>Lot Size: ${listing.lotSize} sq ft</p>
          <p>Days on Market: ${listing.daysOnMarket}</p>
          <a href="${listing.listingOffice?.website}" target="_blank">View Website</a>
        </div>
      `)

      const marker = new mapboxgl.Marker()
        .setLngLat([listing.longitude, listing.latitude])
        .setPopup(popup)
        .addTo(map.value!)

      listingMarkers.value.push(marker)
    })
  } catch (error) {
    console.error('Error fetching listings:', error)
  } finally {
    isSearchResultsLoading.value = false 
  }
}

const isDesktopView = computed(() => {
  return window.innerWidth > 768
})

const handleOutsideClick = (event: MouseEvent) => {
  const popup = document.getElementById('detailed-popup')
  if (showDetailedPopup.value && popup && !popup.contains(event.target as Node)) {
    closeDetailedPopup()
  }
}

const averagesPanelExpanded = ref(false)

const toggleAveragesPanel = (event: Event) => {
  event.stopPropagation()
  averagesPanelExpanded.value = !averagesPanelExpanded.value
}

const closeDetailedPopup = () => {
  showDetailedPopup.value = false
}

const toggleLayerControl = (event: Event) => {
  event.stopPropagation()
  layerControlExpanded.value = !layerControlExpanded.value
}

const toggleContaminationChoropleth = () => {
  showContaminationChoropleth.value = !showContaminationChoropleth.value
  updateChoroplethVisibility()
}

const selectedDemographicLayers = ref<string[]>([])

const toggleDemographicLayer = (layerId: string) => {
  debugLog("TOGGLING " + layerId);
  const layer = demographicLayers.find((l) => l.id === layerId)
  if (!layer) return

  if (layerId === 'combined_scores') {
    // Handle combined scores separately
    if (selectedDemographicLayers.value[0] === 'combined_scores') {
      selectedDemographicLayers.value = [];
      demographicLayers.forEach(l => {if (l.id==='combined_scores') {l.visible = false}})
    } else {
      selectedDemographicLayers.value = ['combined_scores']
      demographicLayers.forEach(l => l.visible = l.id === 'combined_scores')
    } 
  } else {

    const currentIndex = selectedDemographicLayers.value.indexOf(layerId)
    
    if (currentIndex === -1) {
      // Adding a new layer
      if (selectedDemographicLayers.value.length >= 2) {
        // If we already have 2 layers, remove the first one
        selectedDemographicLayers.value.shift()
      }
      selectedDemographicLayers.value.push(layerId)
      layer.visible = true
    } else {
      // Removing a layer
      selectedDemographicLayers.value.splice(currentIndex, 1)
      layer.visible = false
    }
  }

  showDiversityChoropleth.value = selectedDemographicLayers.value.length > 0
  updateChoroplethVisibility()
  updateChoroplethColors()
}

const updateChoroplethVisibility = () => {
  if (!map.value) return

  debugLog('Updating choropleth visibility:', {
    showContaminationChoropleth: showContaminationChoropleth.value,
    showDiversityChoropleth: showDiversityChoropleth.value
  })

  const visibility = 
    showContaminationChoropleth.value || 
    showDiversityChoropleth.value || 
    selectedDemographicLayers.value.includes('combined_scores')
      ? 'visible' 
      : 'none'
  
  map.value.setLayoutProperty('county-choropleth', 'visibility', visibility)

  if (visibility === 'visible') {
    updateChoroplethColors()
  }
}

const contaminationLayers = DEV_MODE_DEMOGRAPHICS_ONLY
  ? []
  : reactive([
      {
        id: 'acres_brownfields',
        name: 'Brownfields',
        file: '/datasets/acres_brownfields.geojson',
        color: '#FF0000',
        visible: false
      },
      {
        id: 'air_pollution_sources',
        name: 'Air Pollution Sources',
        file: '/datasets/air_pollution_sources.geojson',
        color: '#00FF00',
        visible: false
      },
      {
        id: 'hazardous_waste_sites',
        name: 'Hazardous Waste Sites',
        file: '/datasets/hazardous_waste_sites.geojson',
        color: '#0000FF',
        visible: false
      },
      {
        id: 'superfund_sites',
        name: 'Superfund Sites',
        file: '/datasets/superfund_sites.geojson',
        color: '#FFFF00',
        visible: false
      },
      {
        id: 'toxic_release_inventory',
        name: 'Toxic Release Inventory',
        file: '/datasets/toxic_release_inventory.geojson',
        color: '#FF00FF',
        visible: false
      }
    ])

const demographicLayers = reactive([
  {
    id: 'diversity_index',
    name: 'Diversity Index',
    file: '/datasets/county_diversity_index_with_stats.csv',
    color: '#800080', // Purple color for diversity
    visible: false,
    tooltip: '2023 Census => Simpson\'s Diversity Index'
  },
  {
    id: 'pct_nhBlack',
    name: 'Percent Black (Non-Hispanic)',
    file: '/datasets/county_diversity_index_with_stats.csv',
    color: '#000080', // Navy blue color
    visible: false,
    tooltip: '2023 Census'
  },
  {
    id: 'life_expectancy',
    name: 'Life Expectancy',
    visible: false,
    tooltip: '2014, Center for Disease Control'
  },
  {
    id: 'combined_scores',
    name: 'BLO Combined Score',
    visible: false
  }
])

interface ColorBlend {
  geoID: string
  diversityColor: [number, number, number, number]
  blackPctColor: [number, number, number, number]
  contaminationColor: [number, number, number, number]
  lifeExpectancyColor: [number, number, number, number]
  blendedColors: {
    diversityAndContamination: [number, number, number, number]
    blackPctAndContamination: [number, number, number, number]
  },
  combinedScoreColor: [number, number, number, number]
}

const preCalculatedColors = ref<{ [key: string]: ColorBlend }>({})
const colorCalculationComplete = ref(false)

const lifeExpectancyData = ref<{ [geoID: string]: { lifeExpectancy: number, standardError: number } }>({})
const showLifeExpectancyChoropleth = ref(false)

const layersLoaded = ref(false)
const loadedLayersCount = ref(0)
// Update the totalLayers computed property
const totalLayers = computed(() => {
  const contaminationLayerCount = DEV_MODE_DEMOGRAPHICS_ONLY ? 0 : contaminationLayers.length
  return contaminationLayerCount + 1 // +1 for choropleth layer
})


const loadingProgress = computed(() => {
  return Math.round((loadedLayersCount.value / totalLayers.value) * 100)
})

const loadCountiesData = async () => {
  try {
    const countiesResponse = await fetch('/datasets/counties.geojson')
    countiesData.value = await countiesResponse.json()
    
    // Add debug logging
    debugLog('Counties data loaded:', {
      features: countiesData.value?.features?.length,
      sampleFeature: countiesData.value?.features?.[0]
    })

    const contaminationResponse = await fetch('/datasets/contamination_counts.json')
    const contaminationData = await contaminationResponse.json()
    Object.assign(countyContaminationCounts, contaminationData)

    await loadDiversityData()
    await loadLifeExpectancyData()

    const combinedScoresResponse = await fetch('/datasets/combined_scores.json')
    combinedScoresData.value = await combinedScoresResponse.json()
    
    // Pre-calculate colors after all data is loaded
    preCalculateColors()

    debugLog('All data loaded successfully')
  } catch (error) {
    console.error('Error loading counties data:', error)
  }
}

const addContaminationLayer = async (map: mapboxgl.Map, layer: any) => {
  try {
    const response = await fetch(layer.file)
    const data = await response.json()

    debugLog(`Loaded data for ${layer.id}:`, data.features.length, 'features')

    const sourceId = `contamination-source-${layer.id}`
    const layerId = `contamination-layer-${layer.id}`

    map.addSource(sourceId, {
      type: 'geojson',
      data: data,
      attribution: 'Data source: U.S. Environmental Protection Agency - add link here'
    })

    map.addLayer({
      id: layerId,
      type: 'circle',
      source: sourceId,
      paint: {
        'circle-radius': 6,
        'circle-color': layer.color,
        'circle-opacity': 0.7
      },
      layout: {
        visibility: 'none'
      }
    })

    debugLog(`Added contamination layer: ${layerId}`)
    loadedLayersCount.value++
  } catch (error) {
    console.error(`Error adding layer ${layer.id}:`, error)
  }
}

const addDiversityLayer = async (map: mapboxgl.Map) => {
  try {
    await loadDiversityData()

    if (!map.getSource('counties')) {
      console.warn("Counties source not found. Make sure it's added before calling this function.")
      return
    }

    map.addLayer({
      id: 'diversity-layer',
      type: 'fill',
      source: 'counties',
      paint: {
        'fill-color': ['rgba', 0, 0, 0, 0],
        'fill-opacity': 0.7
      },
      layout: {
        visibility: 'none'
      }
    })

    debugLog('Added diversity layer')
    loadedLayersCount.value++
  } catch (error) {
    console.error('Error adding diversity layer:', error)
  }
}

const addCountyChoroplethLayer = () => {
  debugLog('Adding county choropleth layer...')
  if (!map.value || !map.value.isStyleLoaded() || !countiesData.value) {
    debugLog('Map style not yet loaded or counties data not ready, waiting...')
    return
  }

  if (!map.value.getSource('counties')) {
    debugLog('Adding counties source...')
    debugLog(
      'Sample counties:',
      countiesData.value.features
        .slice(0, 5)
        .map((f) => ({ id: f.properties.GEOID, properties: f.properties }))
    )
    map.value.addSource('counties', {
      type: 'geojson',
      data: countiesData.value
    })
  }

  if (!map.value.getLayer('county-choropleth')) {
    debugLog('Adding county choropleth layer...')
    map.value.addLayer({
      id: 'county-choropleth',
      type: 'fill',
      source: 'counties',
      paint: {
        'fill-color': ['rgba', 0, 0, 0, 0],
        'fill-opacity': 0.7
      },
      layout: {
        visibility: 'none' // Set initial visibility to none
      }
    })
  }

  debugLog('County choropleth layer added/updated:', map.value.getLayer('county-choropleth'))
}

const toggleLayer = (layerId: string) => {
  if (!layersLoaded.value || !map.value) {
    debugLog(`Layers not loaded yet, skipping toggle for ${layerId}`)
    return
  }

  const layer = contaminationLayers.find((l) => l.id === layerId)
  if (layer) {
    layer.visible = !layer.visible
    const visibility = layer.visible ? 'visible' : 'none'
    const mapLayerId = `contamination-layer-${layerId}`
    if (map.value.getLayer(mapLayerId)) {
      map.value.setLayoutProperty(mapLayerId, 'visibility', visibility)
    }

    debugLog(`Set ${layerId} visibility to ${visibility}`)

    // Update the "Show All" checkbox state
    updateShowAllCheckbox()

    // Update choropleth if it's visible
    if (showContaminationChoropleth.value) {
      updateChoroplethColors()
    }
  } else {
    console.warn(`Layer ${layerId} not found`)
  }
}

const toggleContaminationLayers = () => {
  debugLog(`Toggling all layers to ${showContaminationLayers.value ? 'visible' : 'none'}`)
  contaminationLayers.forEach((layer) => {
    layer.visible = showContaminationLayers.value
    const visibility = layer.visible ? 'visible' : 'none'
    if (map.value && map.value.getLayer(`contamination-layer-${layer.id}`)) {
      map.value.setLayoutProperty(`contamination-layer-${layer.id}`, 'visibility', visibility)
    }
  })

  // Update choropleth if it's visible
  if (showContaminationChoropleth.value) {
    updateChoroplethColors()
  }
}

// Add this new function to synchronize the "Show All" checkbox state
const updateShowAllCheckbox = () => {
  showContaminationLayers.value = contaminationLayers.every((l) => l.visible)
}

const updateChoroplethColors = () => {
  debugLog('Updating choropleth colors:', {
    selectedLayers: selectedDemographicLayers.value,
    colorCalculationComplete: colorCalculationComplete.value,
    preCalculatedColorsCount: Object.keys(preCalculatedColors.value).length
  })

  if (!map.value || !map.value.getLayer('county-choropleth') || !colorCalculationComplete.value) {
    debugLog('Early return due to:', {
      mapExists: !!map.value,
      layerExists: map.value?.getLayer('county-choropleth'),
      colorCalculationComplete: colorCalculationComplete.value
    })
    return
  }

  let expression: Expression = ['rgba', 0, 0, 0, 0] // Default transparent

  if (showContaminationChoropleth.value) {
    expression = [
      'match',
      ['get', 'GEOID'],
      ...Object.entries(preCalculatedColors.value).flatMap(([geoID, colors]) => [
        geoID,
        ['rgba', ...colors.contaminationColor]
      ]),
      ['rgba', 0, 0, 0, 0] // default color
    ]
  } else if (selectedDemographicLayers.value.length > 0) {
    expression = [
      'match',
      ['get', 'GEOID'],
      ...Object.entries(preCalculatedColors.value).flatMap(([geoID, colors]) => {
        let finalColor: [number, number, number, number]
        
        if (selectedDemographicLayers.value.length === 1) {
          // Single layer selected
          const layer = selectedDemographicLayers.value[0]
          switch (layer) {
            case 'diversity_index':
              finalColor = colors.diversityColor
              break
            case 'pct_nhBlack':
              finalColor = colors.blackPctColor
              break
            case 'life_expectancy':
              finalColor = colors.lifeExpectancyColor
              break
            case 'combined_scores':
              finalColor = colors.combinedScoreColor
              break
            default:
              finalColor = [0, 0, 0, 0]
          }
        } else {
          // Two layers selected - blend colors
          const [layer1, layer2] = selectedDemographicLayers.value
          const color1 = getLayerColor(colors, layer1)
          const color2 = getLayerColor(colors, layer2)
          
          finalColor = [
            Math.round((color1[0] + color2[0]) / 2),
            Math.round((color1[1] + color2[1]) / 2),
            Math.round((color1[2] + color2[2]) / 2),
            Math.max(color1[3], color2[3])
          ]
        }
        
        return [geoID, ['rgba', ...finalColor]]
      }),
      ['rgba', 0, 0, 0, 0]
    ]
  }

  map.value.setPaintProperty('county-choropleth', 'fill-color', expression)
}

// Helper function to get color for a specific layer
const getLayerColor = (colors: ColorBlend, layerId: string): [number, number, number, number] => {
  switch (layerId) {
    case 'diversity_index':
      return colors.diversityColor
    case 'pct_nhBlack':
      return colors.blackPctColor
    case 'life_expectancy':
      return colors.lifeExpectancyColor
    case 'combined_scores':
      return colors.combinedScoreColor
    default:
      return [0, 0, 0, 0]
  }
}

const updateDiversityColors = () => {
  if (!map.value || !map.value.getLayer('diversity-layer')) return

  const maxDiversityIndex = Math.max(
    ...Object.values(diversityData.value).map((d) => d.diversityIndex)
  )

  const expression: mapboxgl.Expression = [
    'interpolate',
    ['linear'],
    ['get', ['get', 'GEOID']],
    0,
    ['rgba', 128, 0, 128, 0],
    maxDiversityIndex,
    ['rgba', 128, 0, 128, 1]
  ]

  map.value.setPaintProperty('diversity-layer', 'fill-color', expression)
}

// Call updateChoroplethColors whenever contamination data changes
watch(
  () => [...contaminationLayers, ...demographicLayers].map((layer) => layer.visible),
  () => {
    /*if (showChoroplethLayer.value) {
      updateChoroplethColors()
    }*/
  },
  { deep: true }
)

const popup = ref<mapboxgl.Popup | null>(null)

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
            EPA Sources of Contamination: ${contaminationCount}
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
  if (!map.value) return

  const tooltip = new mapboxgl.Popup({
    closeButton: false,
    closeOnClick: false
  })

   const averages = {
    contamination: 8.767526188557614,
    blackPct: 9.052875828856244,
    diversityIndex: 0.32891281038322207,
    lifeExpectancy: 77.73516731016737
  }

  map.value.on('mousemove', 'county-choropleth', (e) => {
    if (e.features && e.features.length > 0) {
      const feature = e.features[0]
      const countyId = feature.properties.GEOID
      const countyName = feature.properties.NAME
      
      // Use FIPS for state name
      const stateFIPS = countyId.substring(0, 2)
      const fipsToState: { [key: string]: string } = {
        '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas',
        '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware',
        '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
        '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa',
        '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine',
        '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
        '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska',
        '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico',
        '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio',
        '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island',
        '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas',
        '49': 'Utah', '50': 'Vermont', '51': 'Virginia', '53': 'Washington',
        '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming'
      }
      const stateName = fipsToState[stateFIPS] || 'Unknown State'

      // Add debugging for demographic data linking
      debugLog('County data lookup:', {
        countyId,
        hasData: !!diversityData.value[countyId],
        sampleDiversityKeys: Object.keys(diversityData.value).slice(0, 5),
        diversityDataFormat: diversityData.value[countyId]
      })

      const countyDiversityData = diversityData.value[countyId]
      const totalContamination = countyContaminationCounts[countyId]?.total || 0

       const getColoredValue = (value: number, average: number) => {
        const color = value > average ? 'green' : 'red'
        return `<span style="color: ${color}">${value.toFixed(2)}</span>`
      }
      const getColoredValueContam = (value: number, average: number) => {
        const color = value > average ? 'red' : 'green'
        return `<span style="color: ${color}">${value.toFixed(2)}</span>`
      }

      const tooltipContent = `
        <h3>${countyName}, ${stateName}</h3>
        <p>BLO Combined Score: ${getColoredValue(combinedScoresData.value[countyId]?.combinedScore || 0, 1.4)}</p>
        <p>Total Population: ${countyDiversityData ? countyDiversityData.totalPopulation.toLocaleString() : 'N/A'}</p>
        <p>Life Expectancy: ${getColoredValue(lifeExpectancyData.value[countyId]?.lifeExpectancy || 0, averages.lifeExpectancy)} years</p>
        <p>Percent Black (Non-Hispanic): ${getColoredValue(countyDiversityData?.pct_nhBlack || 0, averages.blackPct)}</p>
        <p>Diversity Index: ${getColoredValue(countyDiversityData?.diversityIndex || 0, averages.diversityIndex)}</p>
        <p>EPA Contaminated Sites: ${getColoredValueContam(totalContamination, averages.contamination)}</p>
      `

      tooltip.setLngLat(e.lngLat).setHTML(tooltipContent).addTo(map.value)
    }
  })

  map.value.on('mouseleave', 'county-choropleth', () => {
    tooltip.remove()
  })
}

const showDetailedPopupForFeature = (feature: mapboxgl.MapboxGeoJSONFeature) => {
  const countyId = feature.properties.GEOID
  const countyName = feature.properties.NAME
  // Add debug logging
  debugLog('Feature properties:', feature.properties)
  
  // Use FIPS to state mapping for reliable state names
  const stateFIPS = countyId.substring(0, 2)
  const fipsToState: { [key: string]: string } = {
    '01': 'Alabama', '02': 'Alaska', '04': 'Arizona', '05': 'Arkansas',
    '06': 'California', '08': 'Colorado', '09': 'Connecticut', '10': 'Delaware',
    '11': 'District of Columbia', '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
    '16': 'Idaho', '17': 'Illinois', '18': 'Indiana', '19': 'Iowa',
    '20': 'Kansas', '21': 'Kentucky', '22': 'Louisiana', '23': 'Maine',
    '24': 'Maryland', '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
    '28': 'Mississippi', '29': 'Missouri', '30': 'Montana', '31': 'Nebraska',
    '32': 'Nevada', '33': 'New Hampshire', '34': 'New Jersey', '35': 'New Mexico',
    '36': 'New York', '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio',
    '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania', '44': 'Rhode Island',
    '45': 'South Carolina', '46': 'South Dakota', '47': 'Tennessee', '48': 'Texas',
    '49': 'Utah', '50': 'Vermont', '51': 'Virginia', '53': 'Washington',
    '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming'
  }
  
  const stateName = fipsToState[stateFIPS] || 'Unknown State'
  debugLog('County ID:', countyId, 'State FIPS:', stateFIPS, 'State Name:', stateName)

  const countyDiversityData = diversityData.value[countyId]
  const contaminationData = countyContaminationCounts[countyId] || { total: 0, layers: {} }
  const lifeExpectancyValue = lifeExpectancyData.value[countyId]?.lifeExpectancy
  const combinedScore = combinedScoresData.value[countyId]

  let content = `
    <h2>${countyName}, ${stateName}</h2>
    <h3>Demographic Data – Census</h3>
  `

  if (countyDiversityData) {
    content += `
      <p>BLO Combined Score: ${combinedScore.combinedScore.toFixed(2)}</p>
      <p>Rank: ${combinedScore.rankScore} (${combinedScore.countiesWithSameRank} counties tied) of 3244</p>
      <p>Total Population: ${countyDiversityData.totalPopulation.toLocaleString()}</p>
      <p>Life Expectancy: ${lifeExpectancyValue ? lifeExpectancyValue.toFixed(1) : 'N/A'} years</p>
      <p>Diversity Index: ${countyDiversityData.diversityIndex.toFixed(4)}</p>
      <p>Black (Non-Hispanic): ${countyDiversityData.nhBlack.toLocaleString()} (${countyDiversityData.pct_nhBlack.toFixed(2)}%)</p>
      <p>White (Non-Hispanic): ${countyDiversityData.nhWhite.toLocaleString()} (${((countyDiversityData.nhWhite / countyDiversityData.totalPopulation) * 100).toFixed(2)}%)</p>
      <p>American Indian: ${countyDiversityData.nhAmIndian.toLocaleString()} (${((countyDiversityData.nhAmIndian / countyDiversityData.totalPopulation) * 100).toFixed(2)}%)</p>
      <p>Asian: ${countyDiversityData.nhAsian.toLocaleString()} (${((countyDiversityData.nhAsian / countyDiversityData.totalPopulation) * 100).toFixed(2)}%)</p>
      <p>Pacific Islander: ${countyDiversityData.nhPacIslander.toLocaleString()} (${((countyDiversityData.nhPacIslander / countyDiversityData.totalPopulation) * 100).toFixed(2)}%)</p>
      <p>Two or More Races: ${countyDiversityData.nhTwoOrMore.toLocaleString()} (${((countyDiversityData.nhTwoOrMore / countyDiversityData.totalPopulation) * 100).toFixed(2)}%)</p>
      <p>Hispanic: ${countyDiversityData.hispanic.toLocaleString()} (${((countyDiversityData.hispanic / countyDiversityData.totalPopulation) * 100).toFixed(2)}%)</p>
    `
  } else {
    content += `<p>No demographic data available</p>`
  }

  content += `
    <h3>Contamination Data – EPA</h3>
    <p>Brownfields: ${contaminationData.layers?.acres_brownfields || 0}</p>
    <p>Air Pollution Sources: ${contaminationData.layers?.air_pollution_sources || 0}</p>
    <p>Hazardous Waste Sites: ${contaminationData.layers?.hazardous_waste_sites || 0}</p>
    <p>Superfund Sites: ${contaminationData.layers?.superfund_sites || 0}</p>
    <p>Toxic Release Inventory: ${contaminationData.layers?.toxic_release_inventory || 0}</p>
    <p>Total Contamination Count: ${contaminationData.total}</p>
  `

  detailedPopupContent.value = content
  showDetailedPopup.value = true
}

interface DiversityData {
  [geoID: string]: {
    diversityIndex: number
    totalPopulation: number
    nhWhite: number
    nhBlack: number
    pct_nhBlack: number
    nhAmIndian: number
    nhAsian: number
    nhPacIslander: number
    nhTwoOrMore: number
    hispanic: number
    countyName: string
    stateName: string
  }
}


const diversityData = ref<DiversityData>({})

interface CombinedScoreData {
  combinedScore: number
  rankScore: number
  stdDevsFromMean: number
  countiesWithSameRank: number
}

const combinedScoresData = ref<{ [key: string]: CombinedScoreData }>({});

const loadDiversityData = async () => {
  try {
    const response = await fetch('/datasets/county_pctBlack_diversity_index_with_stats.csv')
    const csvText = await response.text()

    const results = Papa.parse(csvText, { header: true, dynamicTyping: true })
    
    // Debug the parsed data
    debugLog('Diversity data parsing:', {
      totalRows: results.data.length,
      sampleRows: results.data.slice(0, 5),
      sampleGEOIDs: results.data.slice(0, 5).map((row: any) => row.GEOID),
      errors: results.errors
    })

    results.data.forEach((row: any) => {
      if (!row.GEOID) return
      
      // Ensure GEOID is properly formatted (5 digits with leading zeros)
      const geoID = row.GEOID.toString().padStart(5, '0')
      
      diversityData.value[geoID] = {
        diversityIndex: row.diversity_index,
        totalPopulation: row.total_population,
        pct_nhBlack: row.pct_nhBlack,
        nhWhite: row.NH_White,
        nhBlack: row.NH_Black,
        nhAmIndian: row.NH_AmIndian,
        nhAsian: row.NH_Asian,
        nhPacIslander: row.NH_PacIslander,
        nhTwoOrMore: row.NH_TwoOrMore,
        hispanic: row.Hispanic,
        countyName: row.CTYNAME,
        stateName: row.STNAME
      }
    })

    debugLog('Diversity data loaded:', {
      totalCounties: Object.keys(diversityData.value).length,
      sampleKeys: Object.keys(diversityData.value).slice(0, 5),
      sampleData: Object.entries(diversityData.value).slice(0, 2)
    })
  } catch (error) {
    console.error('Error loading diversity data:', error)
  }
}

const loadLifeExpectancyData = async () => {
  try {
    const response = await fetch('/datasets/lifeexpectancy-USA-county.csv')
    const csvText = await response.text()

    const results = Papa.parse(csvText, { header: true, dynamicTyping: true })
    
    // Debug the raw data format
    debugLog('Life expectancy raw data sample:', {
      headers: results.meta.fields,
      firstFewRows: results.data.slice(0, 10).map(row => ({
        rawGEOID: row.GEOID,
        typeofGEOID: typeof row.GEOID,
        state: row.STATE2KX,
        county: row.CNTY2KX,
        lifeExp: row['e(0)']
      }))
    })

    // Check for any Colorado counties using state code
    const coloradoData = results.data.filter((row: any) => {
      debugLog('Row state:', row.STATE2KX, typeof row.STATE2KX);
      return row.STATE2KX === 8 || row.STATE2KX === '8' || row.STATE2KX === '08';
    });
    debugLog('Colorado counties found:', coloradoData);

    results.data.forEach((row: any) => {
      if (!row.GEOID) return
      
      // Convert state and county codes to proper GEOID format
      let geoID;
      if (row.STATE2KX && row.CNTY2KX) {
        const stateCode = row.STATE2KX.toString().padStart(2, '0');
        const countyCode = row.CNTY2KX.toString().padStart(3, '0');
        geoID = stateCode + countyCode;
      } else {
        geoID = row.GEOID.toString().padStart(5, '0');
      }
      
      debugLog('Processing row:', {
        originalGEOID: row.GEOID,
        state: row.STATE2KX,
        county: row.CNTY2KX,
        constructedGEOID: geoID,
        lifeExp: row['e(0)']
      });
      
      lifeExpectancyData.value[geoID] = {
        lifeExpectancy: row['e(0)'],
        standardError: row['se(e(0))']
      }
    })

    // Debug final data
    debugLog('Life expectancy data loaded:', {
      totalCounties: Object.keys(lifeExpectancyData.value).length,
      coloradoCounties: Object.entries(lifeExpectancyData.value)
        .filter(([id]) => id.startsWith('08'))
        .map(([id, data]) => ({
          id,
          lifeExp: data.lifeExpectancy
        }))
    });

  } catch (error) {
    console.error('Error loading life expectancy data:', error)
  }
}

const showGeocoderError = (message: string) => {
  const errorElement = document.createElement('div')
  errorElement.textContent = message
  errorElement.style.cssText = `
    position: absolute;
    top: 50px;
    left: 10px;
    background-color: #ff6b6b;
    color: white;
    padding: 10px;
    border-radius: 4px;
    z-index: 1000;
  `
  document.body.appendChild(errorElement)
  setTimeout(() => {
    errorElement.remove()
  }, 3000)
}

const handleGeocoderResult = (result: any) => {
  debugLog('Geocoder result:', result)

  if (result.center) {
    map.value?.flyTo({
      center: result.center,
      zoom: 10
    })

    new mapboxgl.Marker().setLngLat(result.center).addTo(map.value!)
  } else {
    console.error('No coordinates found for this result')
    showGeocoderError('Unable to find location. Please try a different search.')
  }
}

onMounted(async () => {
  mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN
  debugLog('Component mounted')
  try {
    await loadCountiesData()
    await loadDiversityData()
    debugLog('Counties data loaded successfully')
  } catch (error) {
    console.error('Error loading counties data:', error)
    return
  }

  debugLog('Initializing map')
  map.value = new mapboxgl.Map({
    container: mapContainer.value!,
    style: 'mapbox://styles/mapbox/light-v10',
    center: [-98.5795, 39.8283], // Center of the US
    zoom: 2
  })

  geocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    countries: 'us',
    types: 'country,region,postcode,district,place',
    placeholder: 'Search for a location'
  })

  const geocoderContainer = document.getElementById('geocoder')
  if (geocoderContainer) {
    geocoderContainer.appendChild(geocoder.onAdd(map.value!))

    // Add event listener for the 'result' event
    geocoder.on('result', function (e) {
      currentGeocoderResult.value = e.result
      handleGeocoderResult(e.result)
    })

    // Add event listener for the Enter key press
    const geocoderInput = geocoderContainer.querySelector('input')
    if (geocoderInput) {
      geocoderInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault()
          const query = (e.target as HTMLInputElement).value
          geocoder.query(query)
        }
      })
    }
  }

  geocoder.on('error', function (e) {
    console.error('Geocoder error:', e)
  })

  map.value.on('load', async function () {
    debugLog('Map loaded')
    debugLog('Counties source:', map.value?.getSource('counties'))

    // Wait for style to be fully loaded
  if (!map.value?.isStyleLoaded()) {
    await new Promise(resolve => map.value?.once('style.load', resolve))
  }

  // Add counties source first
  if (!map.value?.getSource('counties')) {
    debugLog('Adding counties source...')
    map.value?.addSource('counties', {
      type: 'geojson',
      data: countiesData.value!
    })
  }

  // Then add choropleth layer
  if (!map.value?.getLayer('county-choropleth')) {
    debugLog('Adding choropleth layer...')
    map.value?.addLayer({
      id: 'county-choropleth',
      type: 'fill',
      source: 'counties',
      paint: {
        'fill-color': ['rgba', 0, 0, 0, 0],
        'fill-opacity': 0.7
      },
      layout: {
        visibility: 'none'
      }
    })
  }

    
    addCountyChoroplethLayer()

    // Add contamination layers
    if (!DEV_MODE_DEMOGRAPHICS_ONLY) {
      for (const layer of contaminationLayers) {
        await addContaminationLayer(map.value!, layer)
      }
    }

    // Add diversity layer
    await addDiversityLayer(map.value!)

    layersLoaded.value = true
    addTooltip()

    if (!DEV_MODE_DEMOGRAPHICS_ONLY) {
      // Set initial visibility based on checkbox state
      contaminationLayers.forEach((layer) => {
        if (layer.visible) {
          if (map.value && map.value.getLayer(`contamination-layer-${layer.id}`)) {
            map.value.setLayoutProperty(`contamination-layer-${layer.id}`, 'visibility', 'visible')
          }
        }
      })
    }

    // Ensure choropleth layer is not visible by default
    if (map.value && map.value.getLayer('county-choropleth')) {
      map.value.setLayoutProperty('county-choropleth', 'visibility', 'none')
    }
  })

  // Check if the style is already loaded (it might be if we're using a local style)
  if (map.value.isStyleLoaded()) {
    debugLog('Style already loaded')
    addCountyChoroplethLayer()
  }

  // Add a listener for the 'styledata' event, which fires when the map's style is fully loaded
  map.value.on('styledata', () => {
    debugLog('Style data loaded')
    addCountyChoroplethLayer()
  })

  map.value.on('click', (e) => {
    const features = map.value?.queryRenderedFeatures(e.point, { layers: ['county-choropleth'] })
    if (features && features.length > 0) {
      const feature = features[0]
      debugLog('Clicked feature:', feature)
      debugLog('Feature ID:', feature.properties.GEOID)
      debugLog('Feature properties:', feature.properties)
      showDetailedPopupForFeature(feature)
    } else {
      debugLog('No feature found at click point')
    }


  })


  const tooltipIcons = document.querySelectorAll('.tooltip-icon')
  tooltipIcons.forEach(icon => {
    icon.addEventListener('mouseenter', (e) => {
      const tooltip = icon.querySelector('.tooltip-text')
      const iconRect = icon.getBoundingClientRect()
      
      // Position the tooltip above the icon
      tooltip.style.left = `${iconRect.left}px`
      tooltip.style.top = `${iconRect.top - tooltip.offsetHeight - 10}px`
      
      // Check if tooltip is going off the left side of the screen
      if (tooltip.getBoundingClientRect().left < 0) {
        tooltip.style.left = '0px'
      }
      
      // Check if tooltip is going off the right side of the screen
      if (tooltip.getBoundingClientRect().right > window.innerWidth) {
        tooltip.style.left = `${window.innerWidth - tooltip.offsetWidth}px`
      }
    })
  })

  /*map.value.on('mousemove', 'county-choropleth', updatePopup)
  map.value.on('mouseleave', 'county-choropleth', () => {
    if (popup.value) {
      popup.value.remove()
    }
  })*/

  // Add zoom and rotation controls to the map in the bottom-right corner
  map.value.addControl(new mapboxgl.NavigationControl(), 'bottom-right')

  addTooltip()

  debugLog('Map initialization complete')
})


// Update preCalculateColors to handle the new layer structure
const preCalculateColors = () => {
  debugLog('Pre-calculating color blends...')
  const colors = {
  diversity_index: [128, 0, 128], // Purple
  pct_nhBlack: [0, 0, 128],      // Navy blue
  contamination: [255, 0, 0],     // Red
  life_expectancy: [0, 128, 0],   // Green
  combined_scores: {
    min: [255, 255, 0],  // Yellow
    max: [0, 255, 0]     // Vivid green
  }
}

  // Get the range of combined scores
  // Add null checks and proper access to combinedScoresData
  const combinedScores = Object.values(combinedScoresData.value || {})
    .filter(d => d && typeof d.combinedScore === 'number')
    .map(d => d.combinedScore)

  // Add fallback values if there are no valid scores
  const maxCombinedScore = combinedScores.length > 0 ? Math.max(...combinedScores) : 5
  const minCombinedScore = combinedScores.length > 0 ? Math.min(...combinedScores) : 0

  // Get all necessary ranges
  const maxDiversityIndex = Math.max(
    ...Object.values(diversityData.value).map((d) => d.diversityIndex || 0)
  )
  const maxContamination = Math.max(
    ...Object.values(countyContaminationCounts).map(d => d.total)
  )

  // Get life expectancy range
  const lifeExpectancyValues = Object.values(lifeExpectancyData.value)
    .map(d => d.lifeExpectancy)
    .filter(v => v !== undefined && v !== null)
  const maxLifeExpectancy = Math.max(...lifeExpectancyValues)
  const minLifeExpectancy = Math.min(...lifeExpectancyValues)

  debugLog('Pre-calculation ranges:', {
    maxDiversityIndex,
    maxContamination,
    lifeExpectancy: {
      min: minLifeExpectancy,
      max: maxLifeExpectancy
    }
  })

  // Pre-calculate colors for each county
  Object.entries(diversityData.value).forEach(([geoID, data]) => {
    const diversityValue = maxDiversityIndex > 0 ? (data.diversityIndex || 0) / maxDiversityIndex : 0
    const blackPctValue = (data.pct_nhBlack || 0) / 100
    const contaminationValue = countyContaminationCounts[geoID]?.total || 0
    const contaminationNormalized = maxContamination > 0 ? contaminationValue / maxContamination : 0
    
    // Linear normalization to [0,1] range
    const lifeExpectancyValue = lifeExpectancyData.value[geoID]?.lifeExpectancy || minLifeExpectancy
    const lifeExpectancyNormalized = (lifeExpectancyValue - minLifeExpectancy) / (maxLifeExpectancy - minLifeExpectancy)

    preCalculatedColors.value[geoID] = {
      geoID,
      diversityColor: [...colors.diversity_index, diversityValue] as [number, number, number, number],
      blackPctColor: [...colors.pct_nhBlack, blackPctValue] as [number, number, number, number],
      contaminationColor: [...colors.contamination, contaminationNormalized] as [number, number, number, number],
      lifeExpectancyColor: [...colors.life_expectancy, lifeExpectancyNormalized] as [number, number, number, number],
      blendedColors: {
        diversityAndContamination: [
          Math.min(255, colors.diversity_index[0] * diversityValue + colors.contamination[0] * contaminationNormalized),
          Math.min(255, colors.diversity_index[1] * diversityValue + colors.contamination[1] * contaminationNormalized),
          Math.min(255, colors.diversity_index[2] * diversityValue + colors.contamination[2] * contaminationNormalized),
          Math.max(diversityValue, contaminationNormalized)
        ] as [number, number, number, number],
        blackPctAndContamination: [
          Math.min(255, colors.pct_nhBlack[0] * blackPctValue + colors.contamination[0] * contaminationNormalized),
          Math.min(255, colors.pct_nhBlack[1] * blackPctValue + colors.contamination[1] * contaminationNormalized),
          Math.min(255, colors.pct_nhBlack[2] * blackPctValue + colors.contamination[2] * contaminationNormalized),
          Math.max(blackPctValue, contaminationNormalized)
        ] as [number, number, number, number]
      }
    }

    // Ensure combinedScoresData exists for this county
  const combinedScore = combinedScoresData.value?.[geoID]?.combinedScore ?? minCombinedScore
  const combinedScoreNormalized = (combinedScore - minCombinedScore) / 
    (maxCombinedScore - minCombinedScore || 1) // Prevent division by zero
    
    // Interpolate between yellow and green
    const combinedScoreColor: [number, number, number, number] = [
      Math.round(colors.combined_scores.min[0] + (colors.combined_scores.max[0] - colors.combined_scores.min[0]) * combinedScoreNormalized),
      Math.round(colors.combined_scores.min[1] + (colors.combined_scores.max[1] - colors.combined_scores.min[1]) * combinedScoreNormalized),
      Math.round(colors.combined_scores.min[2] + (colors.combined_scores.max[2] - colors.combined_scores.min[2]) * combinedScoreNormalized),
      0.7 // Set a constant opacity
    ]

    preCalculatedColors.value[geoID] = {
      ...preCalculatedColors.value[geoID],
      combinedScoreColor
    }
  })

  colorCalculationComplete.value = true
  loadedLayersCount.value++ // Increment the loaded layers count
  
  debugLog('Color blend pre-calculation complete')
}
</script>

<style scoped>

.download-csv-button {
  background-color: #4CAF50;
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
  border: 3px solid rgba(255,255,255,.3);
  border-radius: 50%;
  border-top-color: #fff;
  animation: spin 1s ease-in-out infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.listings-button {
  background-color: #4CAF50;
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

.listings-panel {
  position: absolute;
  left: 10px;
  top: 20vh;
  background: white;
  color: black;
  padding: 15px;
  border-radius: 4px;
  box-shadow: 0 0 10px rgba(0,0,0,0.1);
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

.layer-item input[type='checkbox'] {
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
    12px/20px 'Helvetica Neue',
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
  content: '';
  position: absolute;
  top: 100%;
  right: 15px;  /* Position the arrow on the right side */
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
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
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
  box-shadow: 0 0 10px 2px rgba(0,0,0,.1);
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
