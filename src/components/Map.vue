<template>
  <div id="map" ref="mapContainer" style="width: 100%; height: 80vh">
    <div
      id="geocoder"
      class="geocoder"
      style="position: absolute; top: 10px; left: 10px; z-index: 1"
    ></div>
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
      <template v-if="!DEV_MODE_DEMOGRAPHICS_ONLY">
        <h3 style="color: black">Potential Sources of Contamination</h3>
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
      <h3 style="color: black">Demographic Layers</h3>
      <div v-for="layer in demographicLayers" :key="layer.id" class="layer-item">
        <input
          type="checkbox"
          :id="layer.id"
          :checked="layer.visible"
          @change="toggleDemographicLayer(layer.id)"
        />
        <label :for="layer.id">{{ layer.name }}</label>
      </div>
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

const mapContainer = ref<HTMLElement | null>(null)
const map = ref<mapboxgl.Map | null>(null)
const countiesData = ref<GeoJSON.FeatureCollection | null>(null)
let geocoder: MapboxGeocoder
const countyContaminationCounts = reactive<{ [key: string]: number }>({})
const detailedPopup = ref<HTMLElement | null>(null)

const layerControlExpanded = ref(true)
const showContaminationLayers = ref(false)
const showContaminationChoropleth = ref(false)
const showDiversityChoropleth = ref(false)
const showDetailedPopup = ref(false)
const detailedPopupContent = ref('')

const isDesktopView = computed(() => {
  return window.innerWidth > 768
})

const handleOutsideClick = (event: MouseEvent) => {
  const popup = document.getElementById('detailed-popup')
  if (showDetailedPopup.value && popup && !popup.contains(event.target as Node)) {
    closeDetailedPopup()
  }
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

const toggleDemographicLayer = (layerId: string) => {
  const layer = demographicLayers.find((l) => l.id === layerId)
  if (layer) {
    // If this layer is being activated, deactivate all other demographic layers
    if (!layer.visible) {
      demographicLayers.forEach((otherLayer) => {
        if (otherLayer.id !== layerId) {
          otherLayer.visible = false
        }
      })
    }
    
    // Toggle the selected layer
    layer.visible = !layer.visible
    selectedDemographicLayer.value = layer.visible ? layerId : ''
    showDiversityChoropleth.value = layer.visible
    updateChoroplethVisibility()
    updateChoroplethColors()
  }
}

const updateChoroplethVisibility = () => {
  if (!map.value) return

  const visibility =
    showContaminationChoropleth.value || showDiversityChoropleth.value ? 'visible' : 'none'
  map.value.setLayoutProperty('county-choropleth', 'visibility', visibility)

  if (showContaminationChoropleth.value || showDiversityChoropleth.value) {
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
    visible: false
  },
  {
    id: 'pct_nhBlack',
    name: 'Percent Black (Non-Hispanic)',
    file: '/datasets/county_diversity_index_with_stats.csv',
    color: '#000080', // Navy blue color
    visible: false
  },
  {
    id: 'life_expectancy',
    name: 'Life Expectancy',
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
  }
}

const preCalculatedColors = ref<{ [key: string]: ColorBlend }>({})
const colorCalculationComplete = ref(false)

const selectedDemographicLayer = ref<string>('')

const preCalculateColors = () => {
  console.log('Pre-calculating color blends...')
  const colors = {
    diversity_index: [128, 0, 128], // Purple
    pct_nhBlack: [0, 0, 128],      // Navy blue
    contamination: [255, 0, 0],      // Red
    life_expectancy: [0, 128, 0]    // Green
  }

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

  console.log('Life expectancy range:', {
    min: minLifeExpectancy,
    max: maxLifeExpectancy,
    range: maxLifeExpectancy - minLifeExpectancy
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
      },
    }
  })

  colorCalculationComplete.value = true
  console.log('Color blend pre-calculation complete')
  console.log('Sample life expectancy colors:', 
    Object.entries(preCalculatedColors.value)
      .slice(0, 5)
      .map(([geoID, colors]) => ({
        geoID,
        lifeExpectancy: lifeExpectancyData.value[geoID]?.lifeExpectancy,
        normalizedValue: colors.lifeExpectancyColor[3]
      }))
  )
}

const layersLoaded = ref(false)
const loadedLayersCount = ref(0)
const totalLayers = computed(() => contaminationLayers.length + demographicLayers.length + 1) // +1 for choropleth layer

const loadingProgress = computed(() => {
  return Math.round((loadedLayersCount.value / totalLayers.value) * 100)
})

const lifeExpectancyData = ref<{ [geoID: string]: { lifeExpectancy: number, standardError: number } }>({})
const showLifeExpectancyChoropleth = ref(false)

const loadCountiesData = async () => {
  try {
    const countiesResponse = await fetch('/datasets/counties.geojson')
    countiesData.value = await countiesResponse.json()

    const contaminationResponse = await fetch('/datasets/contamination_counts.json')
    const contaminationData = await contaminationResponse.json()
    Object.assign(countyContaminationCounts, contaminationData)

    await loadDiversityData()
    await loadLifeExpectancyData()
    
    // Pre-calculate colors after all data is loaded
    preCalculateColors()

    console.log('All data loaded and colors pre-calculated')
  } catch (error) {
    console.error('Error loading counties data:', error)
  }
}

const addContaminationLayer = async (map: mapboxgl.Map, layer: any) => {
  try {
    const response = await fetch(layer.file)
    const data = await response.json()

    console.log(`Loaded data for ${layer.id}:`, data.features.length, 'features')

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

    console.log(`Added contamination layer: ${layerId}`)
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

    console.log('Added diversity layer')
    loadedLayersCount.value++
  } catch (error) {
    console.error('Error adding diversity layer:', error)
  }
}

const addCountyChoroplethLayer = () => {
  console.log('Adding county choropleth layer...')
  if (!map.value || !map.value.isStyleLoaded() || !countiesData.value) {
    console.log('Map style not yet loaded or counties data not ready, waiting...')
    return
  }

  if (!map.value.getSource('counties')) {
    console.log('Adding counties source...')
    console.log(
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
    console.log('Adding county choropleth layer...')
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

  console.log('County choropleth layer added/updated:', map.value.getLayer('county-choropleth'))
}

const toggleLayer = (layerId: string) => {
  if (!layersLoaded.value || !map.value) {
    console.log(`Layers not loaded yet, skipping toggle for ${layerId}`)
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

    console.log(`Set ${layerId} visibility to ${visibility}`)

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
  console.log(`Toggling all layers to ${showContaminationLayers.value ? 'visible' : 'none'}`)
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
  console.log('Updating choropleth colors')
  console.log('Selected demographic layer:', selectedDemographicLayer.value)
  console.log('Show diversity choropleth:', showDiversityChoropleth.value)
  
  if (!map.value || !map.value.getLayer('county-choropleth') || !colorCalculationComplete.value) {
    console.log('Early return due to:', {
      mapExists: !!map.value,
      layerExists: map.value?.getLayer('county-choropleth'),
      colorCalculationComplete: colorCalculationComplete.value
    })
    return
  }

  let expression: Expression = ['rgba', 0, 0, 0, 0] // Default transparent

  if (selectedDemographicLayer.value) {
    if (selectedDemographicLayer.value === 'diversity_index') {
      expression = [
        'match',
        ['get', 'GEOID'],
        ...Object.entries(preCalculatedColors.value).flatMap(([geoID, colors]) => [
          geoID,
          showContaminationChoropleth.value 
            ? ['rgba', ...colors.blendedColors.diversityAndContamination]
            : ['rgba', ...colors.diversityColor]
        ]),
        ['rgba', 0, 0, 0, 0]
      ]
    } else if (selectedDemographicLayer.value === 'pct_nhBlack') {
      expression = [
        'match',
        ['get', 'GEOID'],
        ...Object.entries(preCalculatedColors.value).flatMap(([geoID, colors]) => [
          geoID,
          showContaminationChoropleth.value 
            ? ['rgba', ...colors.blendedColors.blackPctAndContamination]
            : ['rgba', ...colors.blackPctColor]
        ]),
        ['rgba', 0, 0, 0, 0]
      ]
    } else if (selectedDemographicLayer.value === 'life_expectancy') {
      console.log('Rendering life expectancy choropleth')
      console.log('Sample colors:', Object.entries(preCalculatedColors.value).slice(0, 5))
      expression = [
        'match',
        ['get', 'GEOID'],
        ...Object.entries(preCalculatedColors.value).flatMap(([geoID, colors]) => [
          geoID,
          ['rgba', ...colors.lifeExpectancyColor]
        ]),
        ['rgba', 0, 0, 0, 0]
      ]
      console.log('Expression:', expression)
    }
  } else if (!DEV_MODE_DEMOGRAPHICS_ONLY && showContaminationChoropleth.value) {
    expression = [
      'match',
      ['get', 'GEOID'],
      ...Object.values(preCalculatedColors.value).flatMap(colors => [
        colors.geoID,
        ['rgba', ...colors.contaminationColor]
      ]),
      ['rgba', 0, 0, 0, 0]
    ]
  }

  map.value.setPaintProperty('county-choropleth', 'fill-color', expression)
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

  map.value.on('mousemove', 'county-choropleth', (e) => {
    if (e.features && e.features.length > 0) {
      const feature = e.features[0]
      const countyId = feature.properties.GEOID
      const countyName = feature.properties.NAME
      const stateName =
        feature.properties.STATE_NAME || diversityData.value[countyId]?.stateName || 'Unknown State'

      const countyDiversityData = diversityData.value[countyId]
      const contaminationData = countyContaminationCounts[countyId] || {}
      const totalContamination = countyContaminationCounts[feature.properties?.GEOID].total || 0

      const tooltipContent = `
        <h3>${countyName}, ${stateName}</h3>
        <p>Total Population: ${countyDiversityData ? countyDiversityData.totalPopulation.toLocaleString() : 'N/A'}</p>
        <p>Life Expectancy: ${lifeExpectancyData.value[countyId]?.lifeExpectancy.toFixed(1) || 'N/A'} years</p>
        <p>Percent Black (Non-Hispanic): ${countyDiversityData ? countyDiversityData.pct_nhBlack.toFixed(2) : 'N/A'}</p>
        <p>Diversity Index: ${countyDiversityData ? countyDiversityData.diversityIndex.toFixed(4) : 'N/A'}</p>
        <p>EPA Contaminated Sites: ${totalContamination}</p>
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
  const stateName =
    feature.properties.STATE_NAME || diversityData.value[countyId]?.stateName || 'Unknown State'

  const countyDiversityData = diversityData.value[countyId]
  const contaminationData = countyContaminationCounts[countyId] || { total: 0, layers: {} }
  const lifeExpectancyValue = lifeExpectancyData.value[countyId]?.lifeExpectancy

  let content = `
    <h2>${countyName}, ${stateName}</h2>
    <h3>Demographic Data – Census</h3>
  `

  if (countyDiversityData) {
    content += `
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

const loadDiversityData = async () => {
  try {
    const response = await fetch('/datasets/county_pctBlack_diversity_index_with_stats.csv')
    const csvText = await response.text()

    const results = Papa.parse(csvText, { header: true, dynamicTyping: true })

    results.data.forEach((row: any) => {
      const geoID = `${row.GEOID}`
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

    console.log('Diversity data loaded:', diversityData.value)
    console.log('Sample diversity data:', Object.entries(diversityData.value).slice(0, 5))
  } catch (error) {
    console.error('Error loading diversity data:', error)
  }
}

const loadLifeExpectancyData = async () => {
  try {
    const response = await fetch('/datasets/lifeexpectancy-USA-county.csv')
    const csvText = await response.text()

    const results = Papa.parse(csvText, { header: true, dynamicTyping: true })
    console.log('Parsed life expectancy data:', results.data.slice(0, 5))

    results.data.forEach((row: any) => {
      if (!row.GEOID) return // Skip rows without GEOID
      
      lifeExpectancyData.value[row.GEOID] = {
        lifeExpectancy: row['e(0)'],
        standardError: row['se(e(0))']
      }
    })

    console.log('Life expectancy data loaded:', 
      Object.entries(lifeExpectancyData.value)
        .slice(0, 5)
        .map(([geoID, data]) => ({
          geoID,
          lifeExpectancy: data.lifeExpectancy,
          standardError: data.standardError
        }))
    )
  } catch (error) {
    console.error('Error loading life expectancy data:', error)
    console.error('Error details:', {
      message: error.message,
      stack: error.stack
    })
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
  console.log('Geocoder result:', result)

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
  mapboxgl.accessToken =
    'pk.eyJ1IjoibmJ1cmthIiwiYSI6ImNseWYweWIwdTA5YXIyaW9mY3ViYmw1bTYifQ.io_uiRu0x603ZlLU5-2h1A'
  console.log('Component mounted')
  try {
    await loadCountiesData()
    await loadDiversityData()
    console.log('Counties data loaded successfully')
  } catch (error) {
    console.error('Error loading counties data:', error)
    return
  }

  console.log('Initializing map')
  map.value = new mapboxgl.Map({
    container: mapContainer.value!,
    style: 'mapbox://styles/mapbox/light-v10',
    center: [-98.5795, 39.8283], // Center of the US
    zoom: 3
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
    console.log('Map loaded')
    console.log('Counties source:', map.value?.getSource('counties'))

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
    console.log('Style already loaded')
    addCountyChoroplethLayer()
  }

  // Add a listener for the 'styledata' event, which fires when the map's style is fully loaded
  map.value.on('styledata', () => {
    console.log('Style data loaded')
    addCountyChoroplethLayer()
  })

  map.value.on('click', (e) => {
    const features = map.value?.queryRenderedFeatures(e.point, { layers: ['county-choropleth'] })
    if (features && features.length > 0) {
      const feature = features[0]
      console.log('Clicked feature:', feature)
      console.log('Feature ID:', feature.properties.GEOID)
      console.log('Feature properties:', feature.properties)
      showDetailedPopupForFeature(feature)
    } else {
      console.log('No feature found at click point')
    }
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

  console.log('Map initialization complete')
})
</script>

<style scoped>
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
  overflow-y: auto;
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
  z-index: 1000;
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
