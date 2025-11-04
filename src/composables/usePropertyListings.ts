import { ref, type Ref } from 'vue'
import mapboxgl from 'mapbox-gl'
import type MapboxGeocoder from '@mapbox/mapbox-gl-geocoder'
import Papa from 'papaparse'
import { RENTCAST_API_KEY, PROPERTY_SEARCH, debugLog } from '@/config/constants'

export function usePropertyListings(mapRef: Ref<mapboxgl.Map | null>, geocoderRef: { value?: MapboxGeocoder }) {
  const listings = ref<any[]>([])
  const listingMarkers = ref<mapboxgl.Marker[]>([])
  const listingsPanelExpanded = ref(true)
  const isSearchResultsLoading = ref(false)
  const currentGeocoderResult = ref<any>(null)

  const toggleListings = () => {
    listingsPanelExpanded.value = !listingsPanelExpanded.value
  }

  const highlightMarker = (listing: any) => {
    // Remove highlight from all markers
    listingMarkers.value.forEach((marker) => {
      marker.getElement().style.zIndex = '0'
      marker.getElement().style.filter = 'none'
    })

    // Find and highlight the corresponding marker
    const markerIndex = listings.value.findIndex((l) => l.id === listing.id)
    if (markerIndex !== -1) {
      const marker = listingMarkers.value[markerIndex]
      marker.getElement().style.zIndex = '1'
      marker.getElement().style.filter = 'brightness(1.5)'

      // Center map on the marker
      mapRef.value?.flyTo({
        center: [listing.longitude, listing.latitude],
        zoom: 10,
      })
    }
  }

  const downloadCSV = () => {
    // Convert listings data to CSV format
    const csvData = Papa.unparse(
      listings.value.map((listing) => ({
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
        mostRecentHistoryEvent: listing.history
          ? Object.entries(listing.history)[0]?.[1]?.event
          : null,
        mostRecentHistoryPrice: listing.history
          ? Object.entries(listing.history)[0]?.[1]?.price
          : null,
        mostRecentHistoryDate: listing.history
          ? Object.entries(listing.history)[0]?.[0]
          : null,
      }))
    )

    // Create and trigger download
    const blob = new Blob([csvData], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.setAttribute('href', url)
    const getDateTime = (date = new Date()) => {
      return date
        .toLocaleString('en', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        })
        .replace(',', '')
    }
    a.setAttribute(
      'download',
      listings.value[0].county +
        listings.value[0].state +
        '-LandForSale-' +
        getDateTime() +
        '.csv'
    )
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)
  }

  const searchListings = async () => {
    isSearchResultsLoading.value = true
    // Clear existing markers
    listingMarkers.value.forEach((marker) => marker.remove())
    listingMarkers.value = []

    const center = mapRef.value?.getCenter()
    if (!center) return

    let searchUrl = `${PROPERTY_SEARCH.BASE_URL}?`

    if (currentGeocoderResult.value) {
      if (currentGeocoderResult.value.place_type?.includes('place')) {
        // If it's a city search
        const state = currentGeocoderResult.value.context
          ?.find((c: any) => c.id.startsWith('region'))
          ?.short_code?.split('-')[1]
        searchUrl += `city=${currentGeocoderResult.value.text}&state=${state}`
      } else {
        // If it's an address search
        searchUrl += `latitude=${center.lat}&longitude=${center.lng}&radius=${PROPERTY_SEARCH.SEARCH_RADIUS}`
      }
    } else {
      // No geocoder result, use map center
      searchUrl += `latitude=${center.lat}&longitude=${center.lng}&radius=${PROPERTY_SEARCH.SEARCH_RADIUS}`
    }

    // Add common parameters
    searchUrl += `&propertyType=${PROPERTY_SEARCH.PROPERTY_TYPE}&status=${PROPERTY_SEARCH.STATUS}&limit=${PROPERTY_SEARCH.LIMIT}`

    try {
      const response = await fetch(searchUrl, {
        headers: {
          accept: 'application/json',
          'X-Api-Key': RENTCAST_API_KEY,
        },
      })

      const data = await response.json()
      debugLog('got rentcast data')
      debugLog(data)
      listings.value = data
      if (data.length === 0) {
        alert(
          'No lots found within 100 miles of this point, try somewhere else.'
        )
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
          .addTo(mapRef.value!)

        listingMarkers.value.push(marker)
      })
    } catch (error) {
      console.error('Error fetching listings:', error)
    } finally {
      isSearchResultsLoading.value = false
    }
  }

  const clearSearch = () => {
    // Remove all listing markers from map
    listingMarkers.value.forEach((marker) => marker.remove())
    listingMarkers.value = []

    // Clear listings array (this will hide the panel)
    listings.value = []

    // Clear geocoder input
    if (geocoderRef.value) {
      geocoderRef.value.clear()
    }

    // Reset geocoder result
    currentGeocoderResult.value = null
  }

  return {
    // State
    listings,
    listingMarkers,
    listingsPanelExpanded,
    isSearchResultsLoading,
    currentGeocoderResult,

    // Methods
    toggleListings,
    highlightMarker,
    downloadCSV,
    searchListings,
    clearSearch,
  }
}
