import { ref, watch, type Ref } from 'vue'
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
  /** ID of the listing whose card is "selected" in the rail. Set by either
   *  a marker click on the map or a card click in the rail. Drives the
   *  --selected style on the matching marker element. */
  const selectedListingId = ref<string | null>(null)
  /** ID of the listing currently hovered in the rail's card list. Drives
   *  the --hovered style on the matching marker so the user can see
   *  which pin corresponds to which row. */
  const hoveredListingId = ref<string | null>(null)

  /** Apply the selected/hovered classes to the matching marker elements,
   *  one pass over the markers array. Cheap (60 entries) and idempotent. */
  const refreshMarkerStyles = () => {
    for (let i = 0; i < listingMarkers.value.length; i++) {
      const marker = listingMarkers.value[i]
      const id = listings.value[i]?.id
      const el = marker.getElement()
      el.classList.toggle('listing-marker--selected', id != null && id === selectedListingId.value)
      el.classList.toggle('listing-marker--hovered', id != null && id === hoveredListingId.value)
    }
  }

  const toggleListings = () => {
    listingsPanelExpanded.value = !listingsPanelExpanded.value
  }

  /** Pan the map to a listing while preserving the user's current zoom.
   *  Marker hover/selected styling is handled by CSS classes via
   *  refreshMarkerStyles — this function is purely the camera move. */
  const highlightMarker = (listing: any) => {
    const map = mapRef.value
    if (!map) return
    const currentZoom = map.getZoom()
    const target: { center: [number, number]; zoom?: number } = {
      center: [listing.longitude, listing.latitude],
    }
    if (currentZoom < 7) target.zoom = 8
    map.easeTo({ ...target, duration: 500 })
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
      // Sort by days-on-market ascending so the freshest listings come
      // first — stale 1500+-day-old listings dominating the top of the
      // list reads as "this market is dead" even when there's a recent
      // listing 10 cards down. Missing dom values sink to the bottom.
      const sortedData = Array.isArray(data)
        ? [...data].sort((a: any, b: any) => {
            const da = typeof a?.daysOnMarket === 'number' ? a.daysOnMarket : Number.POSITIVE_INFINITY
            const db = typeof b?.daysOnMarket === 'number' ? b.daysOnMarket : Number.POSITIVE_INFINITY
            return da - db
          })
        : []
      listings.value = sortedData
      if (sortedData.length === 0) {
        alert(
          'No lots found within 100 miles of this point, try somewhere else.'
        )
      }

      // Add markers for each listing. No popup — clicking a pin instead
      // selects the listing in the rail (handled by parent watcher on
      // selectedListingId). The default mapbox SVG element is reused;
      // we just stamp data-listing-id and a click handler on it.
      sortedData.forEach((listing: any) => {
        const marker = new mapboxgl.Marker({ color: '#1f7a2e' })
          .setLngLat([listing.longitude, listing.latitude])
          .addTo(mapRef.value!)

        const el = marker.getElement()
        el.classList.add('listing-marker')
        el.dataset.listingId = listing.id
        el.style.cursor = 'pointer'
        el.addEventListener('click', (ev) => {
          ev.stopPropagation()
          selectedListingId.value = listing.id
        })

        listingMarkers.value.push(marker)
      })
      // Reapply any pending selected/hovered state to the new markers
      refreshMarkerStyles()
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

    // Reset geocoder result. Skip geocoderRef.value.clear() — Phase 4c
    // removed the geocoder DOM, so the underlying _inputEl is undefined
    // and calling .clear() throws. The exception used to abort the rest
    // of clearSearch (and propagate up through inspectCounty), leaving
    // the rail stuck on its previous view after a county switch.
    currentGeocoderResult.value = null
    // Drop any in-flight selection/hover so subsequent searches start clean
    selectedListingId.value = null
    hoveredListingId.value = null
  }

  // Restyle markers whenever selection/hover state changes. Cheap and
  // idempotent — skips if no markers exist yet.
  watch([selectedListingId, hoveredListingId], refreshMarkerStyles)

  return {
    // State
    listings,
    listingMarkers,
    listingsPanelExpanded,
    isSearchResultsLoading,
    currentGeocoderResult,
    selectedListingId,
    hoveredListingId,

    // Methods
    toggleListings,
    highlightMarker,
    downloadCSV,
    searchListings,
    clearSearch,
  }
}
