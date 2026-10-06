/**
 * Recorded answers from the endpoints P5-59's inspector probes, trimmed to the
 * fields the classifier and the proposal actually read.
 *
 * They are readable literals rather than saved response bodies for the same
 * reason the P5-57 fixtures are: a reviewer has to be able to see exactly what
 * each branch is being asked to make sense of. The SHAPES are real (an ArcGIS
 * layer's `?f=json`, a FeatureServer's layer listing, Socrata's views API, an
 * ArcGIS Hub dataset page), only the contents are small.
 */

/** One ArcGIS layer: `…/FeatureServer/0?f=json`. Points, with a FIPS column. */
export const ARCGIS_LAYER = {
  currentVersion: 11.2,
  id: 0,
  name: 'Superfund National Priorities List (NPL) Sites',
  type: 'Feature Layer',
  description:
    'Point locations of Superfund sites on, proposed to, or deleted from the National Priorities List, published by the US EPA.',
  copyrightText: 'US EPA Office of Land and Emergency Management. Public domain.',
  geometryType: 'esriGeometryPoint',
  minScale: 0,
  maxScale: 0,
  extent: {
    xmin: -124.73,
    ymin: 24.5,
    xmax: -66.95,
    ymax: 49.38,
    spatialReference: { wkid: 4326, latestWkid: 4326 },
  },
  drawingInfo: { renderer: { type: 'simple' } },
  maxRecordCount: 2000,
  supportsPagination: true,
  standardMaxRecordCount: 4000,
  fields: [
    { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID', domain: null },
    { name: 'SITE_NAME', type: 'esriFieldTypeString', alias: 'Site name', length: 120, domain: null },
    { name: 'EPA_ID', type: 'esriFieldTypeString', alias: 'EPA site ID', length: 20, domain: null },
    { name: 'NPL_STATUS', type: 'esriFieldTypeString', alias: 'NPL status', length: 40, domain: null },
    { name: 'STCOFIPS', type: 'esriFieldTypeString', alias: 'State/county FIPS', length: 5, domain: null },
    { name: 'SITE_SCORE', type: 'esriFieldTypeDouble', alias: 'HRS score', domain: null },
    { name: 'LISTING_DATE', type: 'esriFieldTypeDate', alias: 'Date listed', length: 8, domain: null },
  ],
}

/** The same layer's `…/query?returnCountOnly=true` answer. */
export const ARCGIS_COUNT = { count: 1337 }

/** A FeatureServer with NO layer index: it lists its layers instead. */
export const ARCGIS_SERVICE = {
  currentVersion: 11.2,
  serviceDescription:
    'National Flood Hazard Layer (NFHL) — effective flood hazard zones, base flood elevations and firm panels.',
  serviceItemId: '8b0adb5e0a1c4b13b0a5f9e0d1234567',
  copyrightText: 'FEMA',
  hasVersionedData: false,
  maxRecordCount: 1000,
  layers: [
    { id: 0, name: 'Flood Hazard Zones', parentLayerId: -1, defaultVisibility: true, geometryType: 'esriGeometryPolygon' },
    { id: 1, name: 'Base Flood Elevations', parentLayerId: -1, defaultVisibility: true, geometryType: 'esriGeometryPolyline' },
    { id: 16, name: 'FIRM Panels', parentLayerId: -1, defaultVisibility: false, geometryType: 'esriGeometryPolygon' },
  ],
  tables: [{ id: 20, name: 'Study Info' }],
}

/** What an ArcGIS endpoint says when the token/URL is wrong. */
export const ARCGIS_ERROR = { error: { code: 400, message: 'Invalid URL', details: [] } }

/** Socrata's `/api/views/<id>.json` — the dataset's own metadata. */
export const SOCRATA_VIEW = {
  id: 'spb7-eyx7',
  name: 'Hazardous Site Inventory',
  attribution: 'Georgia Environmental Protection Division',
  attributionLink: 'https://epd.georgia.gov/',
  description:
    'Sites listed on the Georgia Hazardous Site Inventory, with the class of the site and the contaminants of concern.',
  category: 'Environment',
  createdAt: 1_484_006_400,
  rowsUpdatedAt: 1_756_857_600,
  viewLastModified: 1_756_857_600,
  license: { name: 'Public Domain', termsLink: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  metadata: {
    rowLabel: 'Site',
    custom_fields: { Update: { 'Update Frequency': 'Quarterly' } },
  },
  columns: [
    {
      id: 1,
      name: 'Site name',
      fieldName: 'site_name',
      dataTypeName: 'text',
      cachedContents: { non_null: 764, null: 0 },
    },
    { id: 2, name: 'HSI number', fieldName: 'hsi_number', dataTypeName: 'text' },
    { id: 3, name: 'County FIPS', fieldName: 'county_fips', dataTypeName: 'text' },
    { id: 4, name: 'Class', fieldName: 'class', dataTypeName: 'text' },
    { id: 5, name: 'Location', fieldName: 'location_1', dataTypeName: 'point' },
  ],
}

/** A direct CSV download: three rows and a county column. */
export const CSV_BODY = `GEOID,COUNTY,STATE,RISK_SCORE,EAL_VALT
13121,Fulton County,GA,88.4,41200000
13089,DeKalb County,GA,71.2,18900000
47157,Shelby County,TN,64.0,22100000
`

/** A direct GeoJSON download: points with properties. */
export const GEOJSON_BODY = JSON.stringify({
  type: 'FeatureCollection',
  name: 'community_wells',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.39, 33.75] },
      properties: { well_id: 'GA-0001', system_name: 'Southside Water', population_served: 12400 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-84.41, 33.76] },
      properties: { well_id: 'GA-0002', system_name: 'Peachtree Water', population_served: 3100 },
    },
  ],
})

/** An ArcGIS Hub dataset page. Hub renders client-side, so the machine-readable
 *  part is the `application/ld+json` Dataset block plus the download links. */
export const HUB_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Community Water Systems | Georgia Open Data</title>
  <meta property="og:site_name" content="Georgia Open Data">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "name": "Community Water Systems",
    "description": "Public water systems serving Georgia communities, updated quarterly by Georgia EPD.",
    "license": "https://creativecommons.org/publicdomain/zero/1.0/",
    "accrualPeriodicity": "Quarterly",
    "publisher": { "@type": "Organization", "name": "Georgia Environmental Protection Division" },
    "distribution": [
      { "@type": "DataDownload", "name": "CSV", "encodingFormat": "CSV",
        "contentUrl": "https://opendata.georgia.gov/datasets/water-systems.csv" },
      { "@type": "DataDownload", "name": "GeoJSON", "encodingFormat": "GeoJSON",
        "contentUrl": "https://opendata.georgia.gov/datasets/water-systems.geojson" }
    ]
  }
  </script>
</head>
<body>
  <h1>Community Water Systems</h1>
  <a href="https://opendata.georgia.gov/datasets/water-systems.csv">Download CSV</a>
  <a href="https://services1.arcgis.com/abc/arcgis/rest/services/Water_Systems/FeatureServer/0">API - GeoService</a>
  <a href="/about">About this portal</a>
</body>
</html>
`

/** A plain web page: a report, not a dataset. Nothing to ingest. */
export const PLAIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Heirs' property in the Black Belt — Land Loss Prevention Project</title>
  <meta name="description" content="A 2025 field report on heirs' property and clouded title across the Black Belt counties.">
</head>
<body>
  <h1>Heirs' property in the Black Belt</h1>
  <p>Our field team spent eighteen months with landowners in twelve counties. This report sets out what we heard.</p>
  <a href="/contact">Contact us</a>
</body>
</html>
`

/** A response with the headers a probe reads. */
export function probeResponse(
  body: string,
  contentType: string,
  extra: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(body, { status, headers: { 'content-type': contentType, ...extra } })
}

export function jsonProbe(body: unknown, extra: Record<string, string> = {}): Response {
  return probeResponse(JSON.stringify(body), 'application/json; charset=utf-8', extra)
}

/** A DNS lookup that calls every hostname public, so classifier tests never
 *  touch the network. The guard's own refusals get their own test. */
export const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]

/** A lookup that puts every name inside this network — the refusal case. */
export const privateLookup = async () => [{ address: '10.1.2.3', family: 4 }]

// --- Behaviours found live on 2026-09-06 (see library-staging candidates) ----

/** NC OneMap parcels: the extent is EPSG:2264 (state plane feet), and three
 *  FIPS-ish columns of which only one is the 5-digit county code. */
export const NC_PARCELS_LAYER = {
  currentVersion: 10.91,
  id: 0,
  name: 'Parcels (pts)',
  type: 'Feature Layer',
  geometryType: 'esriGeometryPoint',
  copyrightText: 'NC Center for Geographic Information and Analysis (NCCGIA), NC County Governments, US EPA',
  maxRecordCount: 5000,
  extent: {
    xmin: 407567,
    ymin: 35548,
    xmax: 3051911,
    ymax: 1480316,
    spatialReference: { wkid: 102719, latestWkid: 2264 },
  },
  fields: [
    { name: 'parno', type: 'esriFieldTypeString', alias: 'Parcel number' },
    { name: 'ownname', type: 'esriFieldTypeString', alias: 'Owner name' },
    { name: 'cntyfips', type: 'esriFieldTypeString', alias: 'County FIPS (3 digit)' },
    { name: 'stfips', type: 'esriFieldTypeString', alias: 'State FIPS' },
    { name: 'stcntyfips', type: 'esriFieldTypeString', alias: 'State + county FIPS' },
    { name: 'parval', type: 'esriFieldTypeDouble', alias: 'Parcel value' },
  ],
}

/** Three rows of the FIPS columns, which is what a `resultRecordCount=3`
 *  query with `outFields=<fips columns>` answers with. The 3-digit `cntyfips`
 *  beside the 5-digit `stcntyfips` is the whole reason samples exist. */
export const NC_PARCEL_SAMPLES = {
  features: [
    { attributes: { cntyfips: '183', stfips: '37', stcntyfips: '37183' } },
    { attributes: { cntyfips: '183', stfips: '37', stcntyfips: '37183' } },
  ],
}

/** What `returnExtentOnly=true&outSR=4326` gives back for that layer. */
export const NC_EXTENT_4326 = {
  extent: {
    xmin: -84.4,
    ymin: 33.8,
    xmax: -75.4,
    ymax: 36.6,
    spatialReference: { wkid: 4326, latestWkid: 4326 },
  },
}

/** CDC well-water index: 63 columns, no location column, tract-level key. */
export const SOCRATA_TRACT_VIEW = {
  id: 'fxwg-3udm',
  name: 'Nationally-normed Well Water Index (WWI)',
  attribution: 'CDC/ATSDR Environmental Public Health Tracking Network',
  description: 'Private-well reliance with nitrate and arsenic risk, by census tract.',
  license: null,
  rowsUpdatedAt: 1_750_000_000,
  metadata: {},
  columns: [
    // Socrata ships the commonest values with the metadata. `geo_id` is a
    // census URI and `ct_fips` the id itself: the names do not say that, the
    // values do (P5-59).
    {
      id: 1,
      name: 'Geography',
      fieldName: 'geo_id',
      dataTypeName: 'text',
      cachedContents: { non_null: 84_414, null: 0, top: [{ item: '1400000US13001950100', count: 1 }] },
    },
    { id: 2, name: 'State', fieldName: 'state', dataTypeName: 'text', cachedContents: { top: [{ item: 'Georgia', count: 2 }] } },
    { id: 3, name: 'County', fieldName: 'county', dataTypeName: 'text', cachedContents: { top: [{ item: 'Appling County', count: 2 }] } },
    {
      id: 4,
      name: 'Census tract FIPS',
      fieldName: 'ct_fips',
      dataTypeName: 'text',
      cachedContents: { top: [{ item: '13001950100', count: 1 }] },
    },
    {
      id: 5,
      name: 'Well population percent',
      fieldName: 'wellpop_pcnt2',
      dataTypeName: 'number',
      cachedContents: { top: [{ item: '41.2', count: 1 }] },
    },
  ],
}

/** The 202 an ArcGIS Hub export answers with while it is still building. */
export const HUB_EXPORT_PENDING = {
  message: 'Up to date download file is being generated. Please check back later.',
  status: 'ExportingData',
}

/** The warm answer: GeoJSON, served as octet-stream, declaring EPSG:3857. */
export const HUB_GEOJSON_3857 = JSON.stringify({
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'EPSG:3857' } },
  features: [
    {
      type: 'Feature',
      properties: { name: 'BARROW EASEMENT', ownr_categ: 'private conservation land with easement or covenant', gisacres: 412.6 },
      geometry: { type: 'Polygon', coordinates: [[[-9400000, 3900000], [-9399000, 3900000], [-9399000, 3901000], [-9400000, 3900000]]] },
    },
  ],
})

/** An ArcGIS Hub dataset page: a shell the browser fills in. */
export const HUB_SPA_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Continental Hubs (Southeast Blueprint 2025) | ArcGIS Hub</title>
<meta property="og:title" content="Continental Hubs (Southeast Blueprint 2025)">
<meta property="og:url" content="https://hub.arcgis.com/datasets/fws::continental-hubs-southeast-blueprint-2025">
</head><body><div id="app"></div></body></html>
`

/** What `hub.arcgis.com/api/v3/datasets/<id>` answers for that page. */
export const HUB_API_DATASET = {
  data: {
    id: '0228345c81a643f3a5d2b5b81e7d2e83_0',
    type: 'dataset',
    attributes: {
      name: 'Continental Hubs (Southeast Blueprint 2025)',
      description: '<p>Priority connectivity hubs from the Southeast Conservation Blueprint.</p>',
      orgName: 'U.S. Fish and Wildlife Service',
      licenseInfo: 'Public domain',
      recordCount: 1842,
      url: 'https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/Continental_Hubs/FeatureServer/0',
    },
  },
}

/** A data.gov catalog page: server-rendered, with a typed resources list. */
export const DATA_GOV_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>U.S. Department of Health &amp; Human Services - State-normed Well Water Index (WWI)</title>
<meta name="description" content="State-normed well water index by census tract.">
</head><body>
<ul class="resources-list">
  <li class="resources-list__item">
    <a class="heading" href="https://data.cdc.gov/api/v3/views/snkv-n8f6/export.csv?accessType=DOWNLOAD">CSV</a>
  </li>
  <li class="resources-list__item">
    <a class="heading" href="https://data.cdc.gov/api/v3/views/snkv-n8f6/query.json?accessType=DOWNLOAD">JSON</a>
  </li>
  <li class="resources-list__item">
    <a class="heading" href="https://data.cdc.gov/api/v3/views/snkv-n8f6/query.xml?accessType=DOWNLOAD">XML</a>
  </li>
</ul>
<a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0 1.0</a>
</body></html>
`

// --- P5-61: pages that have to be read rather than asked -------------------

/**
 * The page this ticket exists for: an agency programme page, mostly prose,
 * with a navigation menu of forty links and exactly ONE download in it.
 *
 * Everything about the shape is real — a skip link, a menu, breadcrumbs, a
 * "share this page" row, a footer of sibling programmes — because those are
 * what a naive harvest turns into a link tree.
 */
function navLinks(): string {
  const sections = [
    'about', 'leadership', 'careers', 'newsroom', 'events', 'contact', 'accessibility', 'privacy',
    'foia', 'budget', 'grants', 'permits', 'inspections', 'enforcement', 'training', 'library',
    'publications', 'maps', 'programs/air', 'programs/water', 'programs/waste', 'programs/land',
    'programs/energy', 'programs/climate', 'programs/coastal', 'programs/forestry', 'espanol',
    'site-map', 'help', 'feedback', 'newsletter', 'jobs', 'partners', 'volunteer', 'donate',
    'calendar', 'directory', 'offices', 'regions',
  ]
  return sections.map(s => `<li><a href="/${s}">${s.replace(/[-/]/g, ' ')}</a></li>`).join('\n    ')
}

export const AGENCY_PROSE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Private Well Testing Program — Georgia Environmental Protection Division</title>
  <meta name="description" content="Results of the state's private well sampling program, by county.">
</head>
<body>
  <a href="#main">Skip to main content</a>
  <nav><ul>
    ${navLinks()}
  </ul></nav>
  <main id="main">
    <h1>Private Well Testing Program</h1>
    <p>The Environmental Protection Division has sampled private drinking-water wells across
      Georgia since 2016. Results are published once a year, each spring, covering the previous
      calendar year, and are in the public domain.</p>
    <p>The full set of results is available as a
      <a href="/files/well-testing-results-2024.csv">county-level CSV file (2.4 MB)</a>,
      one row per sampled well with its county FIPS code, the analyte and the measured value.</p>
    <p>Programmatic users can query the same data through the state's open-data API; see the
      <a href="/developers/wells">API documentation</a> for the endpoint and its parameters.
      County health departments may also request the raw laboratory reports by emailing
      wells@epd.example.gov.</p>
    <p><a href="/share?u=wells">Share this page</a> · <a href="/print/wells">Print</a></p>
  </main>
  <footer><a href="/programs/air">Air</a> <a href="/programs/water">Water</a></footer>
</body>
</html>
`

/** A page whose publisher filled in schema.org: the distributions ARE typed,
 *  so nothing about them should be guessed at or pruned. */
export const JSONLD_DATASET_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>National Wetlands Inventory</title>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Dataset",
  "name": "National Wetlands Inventory",
  "description": "Wetland polygons for the conterminous United States.",
  "publisher": { "@type": "Organization", "name": "U.S. Fish and Wildlife Service" },
  "license": "https://creativecommons.org/publicdomain/zero/1.0/",
  "accrualPeriodicity": "Annually",
  "distribution": [
    { "@type": "DataDownload", "name": "Wetlands (GeoJSON)", "encodingFormat": "application/geo+json",
      "contentUrl": "https://data.example.gov/downloads/wetlands.geojson" },
    { "@type": "DataDownload", "name": "Wetlands (Shapefile)", "encodingFormat": "application/zip",
      "contentUrl": "https://data.example.gov/downloads/wetlands.zip" }
  ]
}
</script>
</head><body><h1>National Wetlands Inventory</h1>
<a href="/about">About us</a> <a href="/contact">Contact</a>
</body></html>
`

/**
 * The three URL rules, in one page: a `<link rel="alternate">` to a data type,
 * a RELATIVE download (which has to be resolved against the page's own final
 * address), and an http link (which must be dropped, not upgraded).
 */
export const ALTERNATE_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Parcel boundaries — Warren County</title>
<link rel="alternate" type="application/geo+json" title="Parcels as GeoJSON" href="/api/parcels.geojson">
<link rel="alternate" type="application/rss+xml" title="News" href="/news.rss">
</head><body>
<p>Download the <a href="../data/parcels.csv">parcel table</a> or the
   <a href="http://legacy.example.gov/parcels.zip">legacy shapefile</a>.</p>
<p><a href="/data.json">Our full data catalogue</a></p>
</body></html>
`

/**
 * A CKAN `package_show` answer, trimmed to what we read.
 *
 * The real thing is the shape data.gov and most state portals return: a
 * `result` object with `resources[]` typed by format, an `organization`, a
 * licence title, tags, and the update frequency hiding in `extras`.
 */
export const CKAN_PACKAGE = {
  help: 'https://catalog.data.gov/api/3/action/help_show?name=package_show',
  success: true,
  result: {
    id: '0b0b8b0e-2f2f-4a4a-9c9c-1d1d1d1d1d1d',
    name: 'state-normed-well-water-index-wwi',
    title: 'State-normed Well Water Index (WWI)',
    notes: 'A census-tract index of the share of the population served by private wells, normed within each state. Updated annually from the American Housing Survey.',
    license_id: 'cc-zero',
    license_title: 'Creative Commons CCZero',
    organization: { name: 'hhs-gov', title: 'U.S. Department of Health & Human Services' },
    tags: [{ name: 'drinking-water' }, { name: 'wells' }, { name: 'census-tract' }],
    extras: [
      { key: 'accrual_periodicity', value: 'R/P1Y' },
      { key: 'publisher', value: 'Centers for Disease Control and Prevention' },
    ],
    resources: [
      {
        name: 'Well water index, by census tract (CSV)',
        format: 'CSV',
        url: 'https://data.cdc.gov/api/views/snkv-n8f6/rows.csv?accessType=DOWNLOAD',
        description: 'One row per census tract with the index and its state ranking.',
      },
      {
        name: 'Socrata API endpoint',
        format: 'API',
        url: 'https://data.cdc.gov/resource/snkv-n8f6.json',
        description: '',
      },
      {
        name: 'Data dictionary',
        format: 'PDF',
        url: 'https://www.cdc.gov/wwi/data-dictionary.pdf',
        description: 'What each column means.',
      },
      {
        name: 'Insecure mirror',
        format: 'CSV',
        url: 'http://mirror.example.gov/wwi.csv',
        description: 'Should never be recorded: not https.',
      },
    ],
  },
}

/** What a CKAN API says when the id is not one of its datasets. */
export const CKAN_MISS = { success: false, error: { message: 'Not found', __type: 'Not Found Error' } }

/** The HTML of the same page, for the fallback when the API will not answer. */
export const CKAN_DATASET_PAGE = DATA_GOV_PAGE

// --- Found live on 2026-09-06, second round -------------------------------

/**
 * The Census TIGER page, reduced to the thing that broke.
 *
 * The ONLY route to the shapefiles on the real page is a single anchor
 * reading "FTP Archive" pointing at a PROTOCOL-RELATIVE directory —
 * `//www2.census.gov/geo/tiger/TIGER2025/`. Nothing in that URL is a data
 * shape and nothing in those two words was a data word, so it was never
 * harvested at all and the most important link on the page was invisible.
 * Everything else here is the navigation it was buried in.
 */
export const TIGER_DIRECTORY_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>TIGER/Line Shapefiles</title></head>
<body>
  <nav>
    <a href="/geographies/mapping-files/time-series/geo/tiger-line-file.2024.html">2024</a>
    <a href="/geographies/mapping-files/time-series/geo/tiger-line-file.2023.html">2023</a>
    <a href="/about.html">About us</a>
    <a href="/newsroom.html">Newsroom</a>
  </nav>
  <main>
    <h1>TIGER/Line Shapefiles</h1>
    <p>The TIGER/Line Shapefiles are the fullest resolution boundary files, containing
      features such as roads, railroads and rivers, as well as legal and statistical
      geographic areas. They are released once a year.</p>
    <p>Access the files through the <a href="//www2.census.gov/geo/tiger/TIGER2025/">FTP Archive</a>
      or the <a href="/cgi-bin/geo/shapefiles/index.php">web interface</a>.</p>
    <p>Technical documentation: <a href="/programs-surveys/geography/technical-documentation/user-note/tiger-geo-line.html">TIGER/Line record layouts</a></p>
  </main>
</body></html>
`

/** A CKAN search answer, for the portals whose `package_show` 404s on a slug
 *  its own page renders. Found live on data.gov. */
export const CKAN_SEARCH_HIT = {
  success: true,
  result: { count: 1, results: [CKAN_PACKAGE.result] },
}

/** The same search when nothing matches. */
export const CKAN_SEARCH_MISS = { success: true, result: { count: 0, results: [] } }

/** A search that matches a DIFFERENT dataset — a loose `fq` hit that must not
 *  be mistaken for the page we are looking at. */
export const CKAN_SEARCH_WRONG = {
  success: true,
  result: { count: 1, results: [{ ...CKAN_PACKAGE.result, name: 'some-other-dataset', title: 'Something else' }] },
}
