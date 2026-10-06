/**
 * Recorded answers from the four kinds of endpoint P5-57 fetches, trimmed to
 * the fields that matter. Kept as readable literals rather than saved response
 * bodies so a reviewer can see exactly what each adapter is being asked to
 * make sense of — the shapes are real (EPA's ArcGIS GeoJSON, a Socrata rows
 * array, FEMA's flood polygons, an Envirofacts REST envelope), the contents
 * are three rows each.
 */

/** Atlanta City Hall — the point every fixture is arranged around. */
export const ATLANTA = { lat: 33.749, lng: -84.388 }

/** EPA Superfund NPL sites as an ArcGIS FeatureServer answers `f=geojson`. */
export const ARCGIS_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.39, 33.75] },
      properties: { Site_Name: 'Lakewood Landfill', Site_EPA_ID: 'GAD000000001', Status: 'Final', Site_Score: 51.9 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.41, 33.76] },
      properties: { Site_Name: 'Peachtree Solvents', Site_EPA_ID: 'GAD000000002', Status: 'Deleted', Site_Score: 33.1 },
    },
    {
      type: 'Feature',
      geometry: null,
      properties: { Site_Name: 'Unlocated Site', Site_EPA_ID: 'GAD000000003', Status: 'Proposed' },
    },
  ],
}

/** The same layer when the server ignores `f=geojson` (common on MapServer). */
export const ARCGIS_ESRI_JSON = {
  features: [
    { attributes: { FLD_ZONE: 'AE', SFHA_TF: 'T', STATIC_BFE: 812.4 }, geometry: { x: -84.39, y: 33.75 } },
    { attributes: { FLD_ZONE: 'X', SFHA_TF: 'F', STATIC_BFE: -9999 }, geometry: { x: -84.4, y: 33.74 } },
  ],
  exceededTransferLimit: false,
}

/** What an ArcGIS layer says when the query itself is wrong. */
export const ARCGIS_ERROR = {
  error: { code: 400, message: "Invalid field: BADFIELD", details: [] },
}

/** A Socrata rows array, with the location column these portals carry. */
export const SOCRATA_ROWS = [
  {
    facility_name: 'Southside Metals',
    permit_number: 'GAP-0001',
    fips: '13121',
    location_1: { type: 'Point', coordinates: [-84.395, 33.742] },
  },
  {
    facility_name: 'Chattahoochee Plating',
    permit_number: 'GAP-0002',
    fips: '13121',
    location_1: { latitude: '33.7551', longitude: '-84.4012' },
  },
]

/** A county-level CSV: the shape of a national bulk download. */
export const COUNTY_CSV = `GEOID,COUNTY,RISK_SCORE,EAL_VALT
13121,Fulton County,88.4,41200000
13089,DeKalb County,71.2,18900000
47157,Shelby County,64.0,22100000
`

/** A point CSV with coordinates and no county column. */
export const POINT_CSV = `name,latitude,longitude,tons
Near well,33.7500,-84.3900,120
Across town,33.9000,-84.6000,80
Way out,35.1000,-90.0000,5
`

/** Flood-zone polygons, the download adapter's GeoJSON path. */
export const POLYGON_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { FLD_ZONE: 'AE', DFIRM_ID: '13121C' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-84.40, 33.74], [-84.38, 33.74], [-84.38, 33.76], [-84.40, 33.76], [-84.40, 33.74]]],
      },
    },
    {
      type: 'Feature',
      properties: { FLD_ZONE: 'X', DFIRM_ID: '47157C' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-90.10, 35.10], [-90.00, 35.10], [-90.00, 35.20], [-90.10, 35.20], [-90.10, 35.10]]],
      },
    },
  ],
}

/** EPA Envirofacts: the rows arrive one level down inside an envelope. */
export const REST_ENVELOPE = {
  Results: {
    tri_facility: [
      { tri_facility_id: '30303SNTHS1000P', facility_name: 'Southside Plating', state_county_fips_code: '13121' },
      { tri_facility_id: '30310PCHTR2000P', facility_name: 'Peachtree Coatings', state_county_fips_code: '13121' },
    ],
  },
}

/** A JSON response with a `fetch`-shaped stub around it. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

export function textResponse(body: string, contentType = 'text/csv'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } })
}

/** A DNS lookup that says every hostname is public, so adapter tests never
 *  touch the network — the host guard's own refusals get their own test. */
export const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
