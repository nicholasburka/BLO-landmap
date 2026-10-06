import { describe, it, expect, vi } from 'vitest'

/**
 * P5-59 classifier. Every case is a recorded fixture behind a fake `fetch`
 * and a fake resolver, so "what is this link?" is answered without a byte
 * leaving the machine — and the two refusals that matter (a private address,
 * a host that never answers) are asserted the same way.
 */

const {
  inspectUrl,
  classifyByShape,
  socrataIdIn,
  inspectionSummary,
  inspectionText,
  parseInspection,
  organisationIn,
  readExtent,
  cleanPageTitle,
  readPageBlock,
  INSPECT_SAMPLE_BYTES,
  INSPECT_DOCUMENTS_MAX,
  PAGE_DESCRIPTION_MAX,
} = await import('./linkInspect.js')
const { proposeSource } = await import('./sourceProposal.js')
const { proposeIngestPlan } = await import('./ingestPlan.js')
const {
  ARCGIS_LAYER,
  ARCGIS_COUNT,
  ARCGIS_SERVICE,
  ARCGIS_ERROR,
  SOCRATA_VIEW,
  CSV_BODY,
  GEOJSON_BODY,
  HUB_PAGE,
  PLAIN_PAGE,
  NC_PARCELS_LAYER,
  NC_PARCEL_SAMPLES,
  NC_EXTENT_4326,
  SOCRATA_TRACT_VIEW,
  HUB_EXPORT_PENDING,
  HUB_GEOJSON_3857,
  HUB_SPA_PAGE,
  HUB_API_DATASET,
  DATA_GOV_PAGE,
  AGENCY_PROSE_PAGE,
  JSONLD_DATASET_PAGE,
  CKAN_PACKAGE,
  CKAN_MISS,
  CKAN_SEARCH_HIT,
  CKAN_SEARCH_MISS,
  CKAN_SEARCH_WRONG,
  TIGER_DIRECTORY_PAGE,
  jsonProbe,
  probeResponse,
  publicLookup,
  privateLookup,
} = await import('../testutils/fixtures/inspect/index.js')

/** A fetch that answers from a table of url-substring to Response factory. */
function router(routes: [string, () => Response][]): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: any) => {
    const url = String(input)
    for (const [needle, make] of routes) if (url.includes(needle)) return make()
    return new Response('not found', { status: 404 })
  })
}

const opts = (fetchImpl: any) => ({ fetchImpl: fetchImpl as typeof fetch, lookup: publicLookup })

describe('classifyByShape', () => {
  it('reads the kind off the URL alone, for links we have not probed', () => {
    expect(classifyByShape('https://x.example/arcgis/rest/services/NPL/FeatureServer/0')).toBe('arcgis-layer')
    expect(classifyByShape('https://x.example/arcgis/rest/services/NPL/MapServer/12')).toBe('arcgis-layer')
    expect(classifyByShape('https://x.example/arcgis/rest/services/NPL/FeatureServer')).toBe('arcgis-service')
    expect(classifyByShape('https://data.example.gov/resource/spb7-eyx7.json')).toBe('socrata')
    expect(classifyByShape('https://data.example.gov/d/spb7-eyx7')).toBe('socrata')
    expect(classifyByShape('https://x.example/files/risk.csv')).toBe('file')
    expect(classifyByShape('https://x.example/files/parcels.zip')).toBe('file')
    expect(classifyByShape('https://x.example/about')).toBeNull()
  })

  it('finds a Socrata 4-4 id in each of its three URL shapes', () => {
    expect(socrataIdIn(new URL('https://d.example.gov/resource/spb7-eyx7.json'))).toBe('spb7-eyx7')
    expect(socrataIdIn(new URL('https://d.example.gov/d/spb7-eyx7'))).toBe('spb7-eyx7')
    expect(socrataIdIn(new URL('https://d.example.gov/dataset/Hazardous-Sites/spb7-eyx7'))).toBe('spb7-eyx7')
    expect(socrataIdIn(new URL('https://d.example.gov/browse'))).toBeNull()
  })
})

describe('inspectUrl - ArcGIS', () => {
  const LAYER_URL = 'https://services1.arcgis.com/ab/arcgis/rest/services/NPL_Sites/FeatureServer/0'

  it('reads a layer fields, geometry, extent, licence and row count', async () => {
    const fetchImpl = router([
      ['returnCountOnly', () => jsonProbe(ARCGIS_COUNT)],
      ['FeatureServer/0', () => jsonProbe(ARCGIS_LAYER)],
    ])
    const result = await inspectUrl(LAYER_URL, opts(fetchImpl))

    expect(result.kind).toBe('arcgis-layer')
    expect(result.confidence).toBe('high')
    expect(result.title).toBe('Superfund National Priorities List (NPL) Sites')
    expect(result.geometry).toBe('point')
    expect(result.fields?.map(f => f.name)).toEqual([
      'OBJECTID',
      'SITE_NAME',
      'EPA_ID',
      'NPL_STATUS',
      'STCOFIPS',
      'SITE_SCORE',
      'LISTING_DATE',
    ])
    expect(result.fields?.find(f => f.name === 'SITE_NAME')).toMatchObject({ type: 'string', alias: 'Site name' })
    expect(result.extent).toEqual({ xmin: -124.73, ymin: 24.5, xmax: -66.95, ymax: 49.38 })
    expect(result.license).toContain('US EPA')
    expect(result.rowCount).toBe(1337)
    // The layer URL itself, not the ?f=json we asked with.
    expect(result.finalUrl).toBe(LAYER_URL)
    expect(result.checkedAt).toMatch(/^\d{4}-/)
  })

  it('lists the layers of a service that names no layer, and picks none', async () => {
    const url = 'https://hazards.fema.gov/arcgis/rest/services/NFHL/MapServer'
    const fetchImpl = router([['MapServer', () => jsonProbe(ARCGIS_SERVICE)]])
    const result = await inspectUrl(url, opts(fetchImpl))

    expect(result.kind).toBe('arcgis-service')
    expect(result.fields).toBeUndefined()
    expect(result.layers).toEqual([
      { id: 0, name: 'Flood Hazard Zones', url: `${url}/0`, geometry: 'polygon' },
      { id: 1, name: 'Base Flood Elevations', url: `${url}/1`, geometry: 'line' },
      { id: 16, name: 'FIRM Panels', url: `${url}/16`, geometry: 'polygon' },
    ])
    expect(result.title).toContain('National Flood Hazard Layer')
  })

  it('an ArcGIS error body is not a layer - it falls through to the page probe', async () => {
    const fetchImpl = router([
      ['f=json', () => jsonProbe(ARCGIS_ERROR)],
      ['', () => probeResponse(PLAIN_PAGE, 'text/html')],
    ])
    const result = await inspectUrl('https://x.example/arcgis/rest/services/Gone/FeatureServer/3', opts(fetchImpl))
    expect(result.kind).toBe('page')
    expect(result.notes?.join(' ')).toMatch(/Invalid URL|did not answer/i)
  })
})

describe('inspectUrl - Socrata', () => {
  it('reads columns, cadence, licence and provider from the views API', async () => {
    const fetchImpl = router([['/api/views/spb7-eyx7.json', () => jsonProbe(SOCRATA_VIEW)]])
    const result = await inspectUrl('https://data.georgia.gov/resource/spb7-eyx7.json', opts(fetchImpl))

    expect(result.kind).toBe('socrata')
    expect(result.confidence).toBe('high')
    expect(result.title).toBe('Hazardous Site Inventory')
    expect(result.provider).toBe('Georgia Environmental Protection Division')
    expect(result.fields?.map(f => f.name)).toEqual(['site_name', 'hsi_number', 'county_fips', 'class', 'location_1'])
    expect(result.fields?.find(f => f.name === 'location_1')?.type).toBe('point')
    expect(result.geometry).toBe('point')
    expect(result.rowCount).toBe(764)
    expect(result.cadence).toBe('Quarterly')
    expect(result.license).toBe('Public Domain')
    // The resource endpoint, which is what an adapter would call.
    expect(result.finalUrl).toBe('https://data.georgia.gov/resource/spb7-eyx7.json')
  })

  it('a dataset page with a 4-4 id is looked up the same way', async () => {
    const fetchImpl = router([['/api/views/spb7-eyx7.json', () => jsonProbe(SOCRATA_VIEW)]])
    const result = await inspectUrl('https://data.georgia.gov/d/spb7-eyx7', opts(fetchImpl))
    expect(result.kind).toBe('socrata')
    expect(result.finalUrl).toBe('https://data.georgia.gov/resource/spb7-eyx7.json')
  })
})

describe('inspectUrl - direct files', () => {
  it('names a CSV columns from the first bytes, and its size from the headers', async () => {
    const fetchImpl = router([
      [
        '.csv',
        () =>
          probeResponse(CSV_BODY, 'text/csv', {
            'content-range': `bytes 0-${INSPECT_SAMPLE_BYTES - 1}/4211234`,
          }),
      ],
    ])
    const result = await inspectUrl('https://x.example/files/risk.csv', opts(fetchImpl))

    expect(result.kind).toBe('file')
    expect(result.formats).toEqual(['csv'])
    expect(result.contentType).toBe('text/csv')
    expect(result.bytes).toBe(4211234)
    expect(result.fields?.map(f => f.name)).toEqual(['GEOID', 'COUNTY', 'STATE', 'RISK_SCORE', 'EAL_VALT'])
    expect(result.geometry).toBe('table')
  })

  it('names a GeoJSON properties and its geometry', async () => {
    const fetchImpl = router([['.geojson', () => probeResponse(GEOJSON_BODY, 'application/geo+json')]])
    const result = await inspectUrl('https://x.example/files/wells.geojson', opts(fetchImpl))

    expect(result.kind).toBe('file')
    expect(result.formats).toEqual(['geojson'])
    expect(result.geometry).toBe('point')
    expect(result.fields?.map(f => f.name)).toEqual(['well_id', 'system_name', 'population_served'])
  })

  it('a zip is a file we cannot read into columns, and says so', async () => {
    const fetchImpl = router([['.zip', () => probeResponse('PKbinary', 'application/zip', { 'content-length': '9100000' })]])
    const result = await inspectUrl('https://x.example/files/parcels.zip', opts(fetchImpl))

    expect(result.kind).toBe('file')
    expect(result.formats).toEqual(['zip'])
    expect(result.fields).toBeUndefined()
    expect(result.bytes).toBe(9100000)
    expect(result.notes?.join(' ')).toMatch(/zip/i)
  })
})

describe('inspectUrl - pages', () => {
  it('an ArcGIS Hub dataset page is a portal, and its data links are listed', async () => {
    const fetchImpl = router([['', () => probeResponse(HUB_PAGE, 'text/html; charset=utf-8')]])
    const result = await inspectUrl('https://opendata.georgia.gov/datasets/water-systems', opts(fetchImpl))

    expect(result.kind).toBe('portal')
    expect(result.title).toBe('Community Water Systems')
    expect(result.provider).toBe('Georgia Environmental Protection Division')
    expect(result.license).toContain('creativecommons.org')
    expect(result.cadence).toBe('Quarterly')
    expect(result.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'https://opendata.georgia.gov/datasets/water-systems.csv', label: 'CSV', kind: 'file' }),
        expect.objectContaining({ url: 'https://opendata.georgia.gov/datasets/water-systems.geojson', label: 'GeoJSON', kind: 'file' }),
        expect.objectContaining({
          url: 'https://services1.arcgis.com/abc/arcgis/rest/services/Water_Systems/FeatureServer/0',
          label: 'API - GeoService',
          kind: 'arcgis-layer',
        }),
      ]),
    )
    /**
     * P5-61, found live: a page whose publisher declares schema.org gets a
     * TYPED link list and skips the model pass — and used to show three
     * downloads with no role at all. A typed list is still typed: the declared
     * format says what each one is.
     */
    expect(result.links?.map(l => l.role)).toEqual(['data-file', 'data-file', 'service-layer'])
    expect(result.links?.[0].reason).toMatch(/structured data/i)
    // "/about" is not data; a portal lists what could be ingested, not its nav.
    expect(result.links?.some(l => l.url.endsWith('/about'))).toBe(false)
  })

  it('a plain page is a document, with nothing to ingest', async () => {
    const fetchImpl = router([['', () => probeResponse(PLAIN_PAGE, 'text/html')]])
    const result = await inspectUrl('https://llpp.example/reports/heirs-property', opts(fetchImpl))

    expect(result.kind).toBe('page')
    expect(result.title).toContain('Heirs')
    expect(result.description).toContain('field report')
    expect(result.links ?? []).toEqual([])
  })
})

describe('inspectUrl - refusals', () => {
  it('a private address is refused before any request is made', async () => {
    const fetchImpl = vi.fn()
    const result = await inspectUrl('https://intranet.example/data.csv', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: privateLookup,
    })
    expect(result.kind).toBe('unreachable')
    expect(result.notes?.join(' ')).toMatch(/not a public address/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a literal IP address is refused without even a DNS lookup', async () => {
    const fetchImpl = vi.fn()
    const lookup = vi.fn()
    const result = await inspectUrl('http://169.254.169.254/latest/meta-data/', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: lookup as any,
    })
    expect(result.kind).toBe('unreachable')
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('a host that does not answer is unreachable, in words a person can act on', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' })
    })
    const result = await inspectUrl('https://gone.example/data.csv', opts(fetchImpl))
    expect(result.kind).toBe('unreachable')
    expect(result.confidence).toBe('high')
    expect(result.notes?.join(' ')).toMatch(/could not reach/i)
  })
})

describe('inspection helpers', () => {
  const arcgis = {
    kind: 'arcgis-layer' as const,
    confidence: 'high' as const,
    url: 'https://x/FeatureServer/0',
    title: 'NPL sites',
    geometry: 'point' as const,
    fields: Array.from({ length: 12 }, (_, i) => ({ name: `f${i}` })),
    extent: { xmin: -85.6, ymin: 30.3, xmax: -80.8, ymax: 35.0 },
    checkedAt: '2026-09-06T00:00:00.000Z',
  }

  it('summarises an inspection in one line for the entry and the queue', () => {
    expect(inspectionSummary(arcgis)).toBe('ArcGIS point layer · 12 fields · Georgia extent')
    expect(inspectionSummary({ ...arcgis, extent: { xmin: -125, ymin: 24, xmax: -66, ymax: 50 } })).toBe(
      'ArcGIS point layer · 12 fields · national extent',
    )
    expect(inspectionSummary({ kind: 'unreachable', confidence: 'high', url: 'x', checkedAt: 'x' })).toBe(
      'Could not reach it — check the link',
    )
  })

  it('renders the metadata as text the filing model can read', () => {
    const text = inspectionText(arcgis)
    expect(text).toContain('NPL sites')
    expect(text).toContain('ArcGIS')
    expect(text).toContain('f0')
  })

  it('parses an inspection back off a manifest, dropping anything unusable', () => {
    expect(parseInspection({ kind: 'file', confidence: 'medium', url: 'https://x/a.csv', checkedAt: 'now' })).toMatchObject({
      kind: 'file',
    })
    expect(parseInspection({ kind: 'nonsense', url: 'x', checkedAt: 'x' })).toBeNull()
    expect(parseInspection(null)).toBeNull()
    expect(parseInspection('inspected')).toBeNull()
  })
})

/**
 * Behaviours found live on 2026-09-06 against the seven candidate links. Each
 * of these cost a wrong answer the first time round, so each gets a fixture.
 */
describe('inspectUrl - what real services actually do', () => {
  it('asks for the extent in degrees when the layer reports a state plane', async () => {
    const fetchImpl = router([
      ['returnExtentOnly', () => jsonProbe(NC_EXTENT_4326)],
      ['returnCountOnly', () => jsonProbe({ count: 5533 })],
      ['FeatureServer/0', () => jsonProbe(NC_PARCELS_LAYER)],
    ])
    const result = await inspectUrl(
      'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0',
      opts(fetchImpl),
    )
    expect(result.kind).toBe('arcgis-layer')
    // 407567 is not a longitude; the reprojected answer is.
    expect(result.extent).toEqual({ xmin: -84.4, ymin: 33.8, xmax: -75.4, ymax: 36.6 })
    expect(inspectionSummary(result)).toContain('North Carolina extent')
    expect(result.rowCount).toBe(5533)
  })

  it('drops an extent in a projection it cannot convert rather than inventing one', () => {
    expect(readExtent(NC_PARCELS_LAYER.extent)).toBeUndefined()
    expect(readExtent({ xmin: -9400000, ymin: 3900000, xmax: -9399000, ymax: 3901000, spatialReference: { wkid: 102100 } }))
      .toMatchObject({ xmin: expect.closeTo(-84.44, 1) })
  })

  it('"secure" in the path is a site name, not an auth wall', () => {
    expect(classifyByShape('https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0')).toBe(
      'arcgis-layer',
    )
  })

  it('waits out a 202 export and then reads the file it was preparing', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) return probeResponse(JSON.stringify(HUB_EXPORT_PENDING), 'application/json', {}, 202)
      return probeResponse(HUB_GEOJSON_3857, 'application/octet-stream')
    })
    const result = await inspectUrl('https://hub.arcgis.com/api/download/v1/items/d18/geojson?layers=0', {
      ...opts(fetchImpl),
      retryDelayMs: 0,
    })
    expect(calls).toBe(2)
    expect(result.kind).toBe('file')
    // The header said octet-stream; the bytes said GeoJSON.
    expect(result.formats).toEqual(['geojson'])
    expect(result.fields?.map(f => f.name)).toEqual(['name', 'ownr_categ', 'gisacres'])
    expect(result.geometry).toBe('polygon')
  })

  it('warns when the coordinates are not latitude and longitude', async () => {
    const fetchImpl = router([['', () => probeResponse(HUB_GEOJSON_3857, 'application/octet-stream')]])
    const result = await inspectUrl('https://hub.arcgis.com/api/download/v1/items/d18/geojson', {
      ...opts(fetchImpl),
      retryDelayMs: 0,
    })
    expect(result.crs).toBe('EPSG:3857')
    expect(result.notes?.join(' ')).toMatch(/reprojected/i)
  })

  it('gives up on an export that never finishes, in words that say what to do', async () => {
    const fetchImpl = vi.fn(async () => probeResponse(JSON.stringify(HUB_EXPORT_PENDING), 'application/json', {}, 202))
    const result = await inspectUrl('https://hub.arcgis.com/api/download/v1/items/d18/geojson', {
      ...opts(fetchImpl),
      retryDelayMs: 0,
    })
    expect(result.kind).toBe('file')
    expect(result.notes?.join(' ')).toMatch(/still preparing/i)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('falls back to the Hub catalogue record when the page is a single-page app', async () => {
    const fetchImpl = router([
      ['/api/v3/datasets/', () => jsonProbe(HUB_API_DATASET)],
      ['', () => probeResponse(HUB_SPA_PAGE, 'text/html')],
    ])
    const result = await inspectUrl(
      'https://hub.arcgis.com/datasets/fws::continental-hubs-southeast-blueprint-2025',
      opts(fetchImpl),
    )
    expect(result.kind).toBe('portal')
    expect(result.title).toBe('Continental Hubs (Southeast Blueprint 2025)')
    expect(result.provider).toBe('U.S. Fish and Wildlife Service')
    expect(result.rowCount).toBe(1842)
    expect(result.links?.map(l => l.label)).toEqual(['Feature service', 'CSV', 'GeoJSON'])
    expect(result.links?.[0]).toMatchObject({ kind: 'arcgis-layer' })
    expect(result.links?.[2].url).toContain('/items/0228345c81a643f3a5d2b5b81e7d2e83/geojson?layers=0')
  })

  /**
   * P5-61 replaced the data.gov HTML scrape with the CKAN API (see the
   * "CKAN portals" block below). What is left here is the FALLBACK: the same
   * page when the API will not answer still yields its typed resource list.
   */
  it('falls back to scraping a data.gov page when the CKAN API refuses', async () => {
    const fetchImpl = router([
      ['/api/3/action/package_show', () => jsonProbe(CKAN_MISS)],
      ['', () => probeResponse(DATA_GOV_PAGE, 'text/html')],
    ])
    const result = await inspectUrl('https://catalog.data.gov/dataset/state-normed-well-water-index-wwi', opts(fetchImpl))
    expect(result.kind).toBe('portal')
    expect(result.platform).toBeUndefined()
    expect(result.links?.map(l => l.url)).toEqual([
      'https://data.cdc.gov/api/v3/views/snkv-n8f6/export.csv?accessType=DOWNLOAD',
      'https://data.cdc.gov/api/v3/views/snkv-n8f6/query.json?accessType=DOWNLOAD',
      'https://data.cdc.gov/api/v3/views/snkv-n8f6/query.xml?accessType=DOWNLOAD',
    ])
    // The licence link is not data, however prominent it is on the page.
    expect(result.links?.some(l => l.url.includes('creativecommons'))).toBe(false)
    // Nothing read the page, and the entry has to be able to say so.
    expect(result.pruned).toBe('unranked')
  })

  it('says "tabular, joinable by FIPS" for a Socrata set with no location column', async () => {
    const fetchImpl = router([['/api/views/fxwg-3udm.json', () => jsonProbe(SOCRATA_TRACT_VIEW)]])
    const result = await inspectUrl('https://data.cdc.gov/d/fxwg-3udm', opts(fetchImpl))
    expect(result.kind).toBe('socrata')
    expect(result.geometry).toBe('table')
    expect(result.fields?.map(f => f.name)).toContain('ct_fips')
  })

  /**
   * P5-59: `geo_id` and `ct_fips` read the same and are not the same. The
   * sample value is the only thing that says which one a county filter can
   * use, so it has to survive from the metadata all the way onto the entry.
   */
  it('carries one real value of each column off the Socrata views API', async () => {
    const fetchImpl = router([['/api/views/fxwg-3udm.json', () => jsonProbe(SOCRATA_TRACT_VIEW)]])
    const result = await inspectUrl('https://data.cdc.gov/d/fxwg-3udm', opts(fetchImpl))
    expect(result.fields?.find(f => f.name === 'geo_id')?.sample).toBe('1400000US13001950100')
    expect(result.fields?.find(f => f.name === 'ct_fips')?.sample).toBe('13001950100')
    // And back off a manifest, so an entry stored yesterday still says it.
    expect(parseInspection(result)?.fields?.find(f => f.name === 'ct_fips')?.sample).toBe('13001950100')
  })

  it('asks an ArcGIS layer for one value of its FIPS columns, and nothing else', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (input: any) => {
      const url = String(input)
      asked.push(url)
      if (url.includes('outFields=')) return jsonProbe(NC_PARCEL_SAMPLES)
      if (url.includes('returnExtentOnly')) return jsonProbe(NC_EXTENT_4326)
      if (url.includes('returnCountOnly')) return jsonProbe({ count: 5533 })
      return jsonProbe(NC_PARCELS_LAYER)
    })
    const result = await inspectUrl(
      'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0',
      opts(fetchImpl),
    )
    expect(result.fields?.find(f => f.name === 'stcntyfips')?.sample).toBe('37183')
    expect(result.fields?.find(f => f.name === 'cntyfips')?.sample).toBe('183')
    // Only the FIPS-shaped columns, and only one request for all of them.
    const sampleCalls = asked.filter(u => u.includes('outFields='))
    expect(sampleCalls).toHaveLength(1)
    expect(decodeURIComponent(sampleCalls[0])).toContain('outFields=cntyfips,stfips,stcntyfips')
    expect(result.fields?.find(f => f.name === 'ownname')?.sample).toBeUndefined()
  })

  it('names the organisation the service credits instead of the hostname', async () => {
    const fetchImpl = router([
      ['returnExtentOnly', () => jsonProbe(NC_EXTENT_4326)],
      ['returnCountOnly', () => jsonProbe({ count: 5533 })],
      ['FeatureServer/0', () => jsonProbe(NC_PARCELS_LAYER)],
    ])
    const result = await inspectUrl(
      'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/FeatureServer/0',
      opts(fetchImpl),
    )
    // The first clause of copyrightText — the owner, not the contributor list.
    expect(result.provider).toBe('NC Center for Geographic Information and Analysis (NCCGIA)')
    expect(proposeSource(result).source.provider).toBe('NC Center for Geographic Information and Analysis (NCCGIA)')
  })

  it('keeps the hostname when the attribution is boilerplate or not a name', () => {
    expect(organisationIn('All rights reserved. Do not redistribute.')).toBeUndefined()
    expect(organisationIn('Updated nightly from the parcel warehouse')).toBeUndefined()
    expect(organisationIn('')).toBeUndefined()
    expect(organisationIn('FEMA')).toBe('FEMA')
  })
})

/**
 * P5-61: reading a page that is prose rather than a service.
 *
 * The classifier's own tests above are about links that describe themselves.
 * These are about the link a researcher actually finds: a programme page with
 * one CSV in it, or a CKAN record behind a `/dataset/<slug>` address.
 */
describe('inspectUrl - reading any page for data (P5-61)', () => {
  /** A prune that answers without a model, so the wiring is what is tested. */
  const fakePrune = (answer: any) => vi.fn(async () => answer)

  const PROSE_URL = 'https://epd.example.gov/programs/wells'

  it('harvests a prose page, stores only what the prune kept, and counts the rest', async () => {
    const fetchImpl = router([['', () => probeResponse(AGENCY_PROSE_PAGE, 'text/html')]])
    const prune = vi.fn(async (input: any) => {
      // Everything the ticket promises the model gets: the title, the page's
      // words, and the candidates with their context.
      expect(input.title).toContain('Private Well Testing Program')
      expect(input.text).toContain('sampled private drinking-water wells')
      expect(input.text).not.toContain('<p>')
      const csv = input.candidates.findIndex((c: any) => c.url.endsWith('well-testing-results-2024.csv'))
      expect(csv).toBeGreaterThanOrEqual(0)
      return {
        links: [
          {
            url: input.candidates[csv].url,
            label: input.candidates[csv].label,
            kind: 'file',
            role: 'data-file',
            reason: 'The annual results file the page calls the full set of results.',
          },
        ],
        candidates: input.candidates.length,
        pruned: 'model',
        prose: {
          isDataset: true,
          provider: 'Georgia Environmental Protection Division',
          updateCadence: 'Once a year, each spring',
          license: 'Public domain',
          evidence: { updateCadence: 'Results are published once a year, each spring.' },
        },
      }
    })
    const result = await inspectUrl(PROSE_URL, { ...opts(fetchImpl), prune: prune as any })

    expect(result.kind).toBe('page')
    expect(prune).toHaveBeenCalledTimes(1)
    expect(result.links).toEqual([
      {
        url: 'https://epd.example.gov/files/well-testing-results-2024.csv',
        label: 'county-level CSV file (2.4 MB)',
        kind: 'file',
        role: 'data-file',
        reason: 'The annual results file the page calls the full set of results.',
      },
    ])
    // The raw count is kept as a number so the entry can say what was dropped.
    expect(result.candidates).toBeGreaterThan(result.links!.length)
    expect(result.pruned).toBe('model')
    expect(result.prose?.provider).toBe('Georgia Environmental Protection Division')
    // And the one-line summary stops calling it "nothing to ingest".
    expect(inspectionSummary(result)).toBe('Web page · 1 data link')
  })

  it('keeps "none of these is the data" rather than storing the navigation', async () => {
    const fetchImpl = router([['', () => probeResponse(AGENCY_PROSE_PAGE, 'text/html')]])
    const prune = fakePrune({ links: [], candidates: 5, pruned: 'model', prose: { isDataset: false } })
    const result = await inspectUrl(PROSE_URL, { ...opts(fetchImpl), prune: prune as any })

    expect(result.links).toBeUndefined()
    expect(result.pruned).toBe('model')
    expect(inspectionSummary(result)).toContain('nothing to ingest')
  })

  it('leaves a publisher’s own typed distribution list alone', async () => {
    const fetchImpl = router([['', () => probeResponse(JSONLD_DATASET_PAGE, 'text/html')]])
    const prune = fakePrune({ links: [], candidates: 0, pruned: 'model' })
    const result = await inspectUrl('https://fws.example.gov/wetlands', { ...opts(fetchImpl), prune: prune as any })

    // schema.org said which files are the dataset; there is nothing to prune.
    expect(prune).not.toHaveBeenCalled()
    expect(result.kind).toBe('portal')
    expect(result.links?.map(l => l.url)).toEqual([
      'https://data.example.gov/downloads/wetlands.geojson',
      'https://data.example.gov/downloads/wetlands.zip',
    ])
    expect(result.pruned).toBeUndefined()
  })

  it('falls back to the URL shapes, capped and marked unranked, with no model', async () => {
    const fetchImpl = router([['', () => probeResponse(AGENCY_PROSE_PAGE, 'text/html')]])
    // No `prune` and no `client`: exactly what a server with no API key does.
    const result = await inspectUrl(PROSE_URL, opts(fetchImpl))

    expect(result.pruned).toBe('unranked')
    expect(result.links!.length).toBeLessThanOrEqual(6)
    expect(result.links![0]).toMatchObject({ role: 'data-file', reason: expect.stringMatching(/nobody read the page/i) })
    expect(result.prose).toBeUndefined()
  })

  it('a page that describes a dataset is offered as a source, not as a document', async () => {
    const fetchImpl = router([['', () => probeResponse(AGENCY_PROSE_PAGE, 'text/html')]])
    const prune = fakePrune({
      links: [
        {
          url: 'https://epd.example.gov/files/well-testing-results-2024.csv',
          kind: 'file',
          role: 'data-file',
          reason: 'The results file.',
        },
      ],
      candidates: 6,
      pruned: 'model',
      prose: {
        isDataset: true,
        provider: 'Georgia EPD',
        updateCadence: 'Once a year, each spring',
        license: 'Public domain',
        geography: 'One row per sampled well',
        accessNotes: [
          { kind: 'download', text: 'A county-level CSV of every sampled well.', url: 'https://epd.example.gov/files/well-testing-results-2024.csv' },
          { kind: 'request', text: 'County health departments can email wells@epd.example.gov.' },
        ],
        evidence: {
          updateCadence: 'Results are published once a year, each spring.',
          license: 'and are in the public domain.',
        },
      },
    })
    const result = await inspectUrl(PROSE_URL, { ...opts(fetchImpl), prune: prune as any })
    const proposal = proposeSource(result)

    expect(proposeIngestPlan(result)).toMatchObject({ plan: 'index' })
    // Everything read from words is inferred AND carries its sentence.
    expect(proposal.inferred).toEqual(expect.arrayContaining(['provider', 'updateCadence', 'license', 'geography', 'access']))
    expect(proposal.source.updateCadence).toBe('Once a year, each spring')
    expect(proposal.evidence?.updateCadence).toMatch(/published once a year/)
    expect(proposal.evidence?.license).toMatch(/public domain/)
    expect(proposal.source.geography).toBe('point')
    // The note with a kept URL became an endpoint; the "email us" one is a note.
    expect(proposal.source.access).toEqual([
      {
        type: 'download',
        url: 'https://epd.example.gov/files/well-testing-results-2024.csv',
        auth: 'none',
        notes: 'A county-level CSV of every sampled well.',
      },
    ])
    expect(proposal.source.notes).toContain('wells@epd.example.gov')
  })

  it('survives a page it can read nothing off', async () => {
    const fetchImpl = router([['', () => probeResponse(PLAIN_PAGE, 'text/html')]])
    const result = await inspectUrl('https://lawcenter.example.org/heirs-property', opts(fetchImpl))
    expect(result.kind).toBe('page')
    expect(result.links).toBeUndefined()
    expect(result.candidates).toBe(0)
  })
})

describe('inspectUrl - CKAN portals (P5-61)', () => {
  const CKAN_URL = 'https://catalog.data.gov/dataset/state-normed-well-water-index-wwi'

  it('reads the package record instead of the page, and types every resource', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (input: any) => {
      asked.push(String(input))
      if (String(input).includes('/api/3/action/package_show')) return jsonProbe(CKAN_PACKAGE)
      return probeResponse(DATA_GOV_PAGE, 'text/html')
    })
    const result = await inspectUrl(CKAN_URL, opts(fetchImpl))

    expect(result.kind).toBe('portal')
    expect(result.platform).toBe('ckan')
    expect(asked.some(u => u.includes('package_show?id=state-normed-well-water-index-wwi'))).toBe(true)
    expect(result.title).toBe('State-normed Well Water Index (WWI)')
    expect(result.provider).toBe('U.S. Department of Health & Human Services')
    expect(result.license).toBe('Creative Commons CCZero')
    expect(result.cadence).toBe('R/P1Y')
    expect(result.topics).toEqual(['drinking-water', 'wells', 'census-tract'])
    expect(result.description).toMatch(/census-tract index/)

    // Resources become the kept links directly — the publisher declared them,
    // so no model pass runs and nothing is "left out".
    expect(result.links).toEqual([
      {
        url: 'https://data.cdc.gov/api/views/snkv-n8f6/rows.csv?accessType=DOWNLOAD',
        label: 'Well water index, by census tract (CSV)',
        // The URL is on a Socrata host; the portal says it is a CSV, and the
        // portal is describing what the resource IS.
        kind: 'socrata',
        role: 'data-file',
        reason: 'One row per census tract with the index and its state ranking.',
      },
      {
        url: 'https://data.cdc.gov/resource/snkv-n8f6.json',
        label: 'Socrata API endpoint',
        kind: 'socrata',
        role: 'api',
        reason: 'Listed by the portal as a API of this dataset.',
      },
      {
        url: 'https://www.cdc.gov/wwi/data-dictionary.pdf',
        label: 'Data dictionary',
        kind: 'file',
        role: 'docs',
        reason: 'What each column means.',
      },
    ])
    // The http mirror is refused, exactly as everywhere else.
    expect(result.links?.some(l => l.url.startsWith('http://'))).toBe(false)
    expect(result.candidates).toBeUndefined()
    expect(result.pruned).toBeUndefined()
  })

  it('proposes a source from the package, with the resources as access methods', async () => {
    const fetchImpl = router([['/api/3/action/package_show', () => jsonProbe(CKAN_PACKAGE)], ['', () => probeResponse(DATA_GOV_PAGE, 'text/html')]])
    const proposal = proposeSource(await inspectUrl(CKAN_URL, opts(fetchImpl)))

    expect(proposal.source.provider).toBe('U.S. Department of Health & Human Services')
    expect(proposal.source.program).toBe('State-normed Well Water Index (WWI)')
    expect(proposal.source.license).toBe('Creative Commons CCZero')
    expect(proposal.source.updateCadence).toBe('R/P1Y')
    expect(proposal.source.topics).toEqual(['drinking-water', 'wells', 'census-tract'])
    expect(proposal.source.access).toEqual([
      {
        type: 'download',
        url: 'https://data.cdc.gov/api/views/snkv-n8f6/rows.csv?accessType=DOWNLOAD',
        auth: 'none',
        notes: 'One row per census tract with the index and its state ranking.',
        // The data dictionary documents the endpoint rather than serving it.
        docs: 'https://www.cdc.gov/wwi/data-dictionary.pdf',
      },
      {
        type: 'socrata',
        url: 'https://data.cdc.gov/resource/snkv-n8f6.json',
        auth: 'none',
        notes: 'Listed by the portal as a API of this dataset.',
      },
    ])
  })

  it('does not call the CKAN API for a path that is not a dataset page', async () => {
    const asked: string[] = []
    const fetchImpl = vi.fn(async (input: any) => {
      asked.push(String(input))
      return probeResponse(PLAIN_PAGE, 'text/html')
    })
    await inspectUrl('https://catalog.data.gov/dataset/new', opts(fetchImpl))
    await inspectUrl('https://lawcenter.example.org/reports/heirs', opts(fetchImpl))
    expect(asked.some(u => u.includes('package_show'))).toBe(false)
  })
})

/**
 * Round two, all four found by the lead's live check on 2026-09-06.
 */
describe('inspectUrl - what the live check found (P5-61)', () => {
  it('keeps the Census FTP archive, and calls it a directory', async () => {
    const fetchImpl = router([['', () => probeResponse(TIGER_DIRECTORY_PAGE, 'text/html')]])
    const result = await inspectUrl(
      'https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html',
      opts(fetchImpl),
    )
    // No model pass in a test, so this is the STATIC fallback — and even it
    // now puts the archive first, because a directory outranks a docs page.
    expect(result.links?.[0]).toMatchObject({
      url: 'https://www2.census.gov/geo/tiger/TIGER2025/',
      role: 'directory',
      label: 'FTP Archive',
    })
    expect(result.pruned).toBe('unranked')
    // And says why it is unranked instead of leaving a reader to guess.
    expect(result.pruneError).toBe('no model pass was available')
  })

  it('records the candidates it dropped, so the next reviewer can see them', async () => {
    const fetchImpl = router([['', () => probeResponse(AGENCY_PROSE_PAGE, 'text/html')]])
    const prune = vi.fn(async (input: any) => ({
      links: [{ url: input.candidates[0].url, role: 'data-file' as const, reason: 'kept' }],
      candidates: input.candidates.length,
      pruned: 'model' as const,
      dropped: input.candidates.slice(1).map((c: any) => c.url),
    }))
    const result = await inspectUrl('https://epd.example.gov/programs/wells', { ...opts(fetchImpl), prune: prune as any })
    expect(result.dropped!.length).toBeGreaterThan(0)
    expect(result.dropped).not.toContain(result.links![0].url)
    // Read back off a manifest, an http URL in there is refused like any other.
    expect(parseInspection({ ...result, dropped: [...result.dropped!, 'http://insecure.example/x'] })!.dropped).toEqual(
      result.dropped,
    )
  })

  it('carries the prune reason CODE onto the entry, and refuses one it does not know (P5-75)', async () => {
    const fetchImpl = router([['', () => probeResponse(AGENCY_PROSE_PAGE, 'text/html')]])
    const prune = vi.fn(async (input: any) => ({
      links: [],
      candidates: input.candidates.length,
      pruned: 'unranked' as const,
      pruneError: 'the API key was refused',
      pruneErrorCode: 'refused' as const,
    }))
    const result = await inspectUrl('https://epd.example.gov/programs/wells', { ...opts(fetchImpl), prune: prune as any })
    expect(result.pruneError).toBe('the API key was refused')
    expect(result.pruneErrorCode).toBe('refused')
    // Read back off a manifest, anything outside the four codes is dropped.
    expect(parseInspection(result)!.pruneErrorCode).toBe('refused')
    expect(parseInspection({ ...result, pruneErrorCode: 'out-of-credit' })!.pruneErrorCode).toBeUndefined()
  })

  it('a page with typed structured data still gets roles on its links', async () => {
    // Found live: data.gov publishes schema.org, so the model pass is skipped
    // — and the links used to arrive with no role at all.
    const fetchImpl = router([['', () => probeResponse(JSONLD_DATASET_PAGE, 'text/html')]])
    const result = await inspectUrl('https://fws.example.gov/wetlands', opts(fetchImpl))
    expect(result.links?.map(l => l.role)).toEqual(['data-file', 'data-file'])
    expect(result.links?.every(l => !!l.reason)).toBe(true)
  })
})

describe('inspectUrl - CKAN when package_show will not answer (P5-61)', () => {
  const CKAN_URL = 'https://catalog.data.gov/dataset/state-normed-well-water-index-wwi'

  it('finds the package by search when package_show 404s on its own slug', async () => {
    // Found live on 2026-09-06: data.gov answers `package_show` with 404
    // {"message":"Not Found"} for a dataset whose page renders perfectly.
    const asked: string[] = []
    const fetchImpl = vi.fn(async (input: any) => {
      const url = String(input)
      asked.push(url)
      if (url.includes('package_show')) return jsonProbe({ message: 'Not Found' }, {})
      if (url.includes('package_search')) return jsonProbe(CKAN_SEARCH_HIT)
      return probeResponse(DATA_GOV_PAGE, 'text/html')
    })
    const result = await inspectUrl(CKAN_URL, opts(fetchImpl))

    expect(asked.some(u => u.includes('package_search') && u.includes('name%3Astate-normed'))).toBe(true)
    expect(result.platform).toBe('ckan')
    expect(result.title).toBe('State-normed Well Water Index (WWI)')
    expect(result.links?.map(l => l.role)).toEqual(['data-file', 'api', 'docs'])
  })

  it('refuses a search hit that is a different dataset', async () => {
    const fetchImpl = router([
      ['package_show', () => jsonProbe(CKAN_MISS)],
      ['package_search', () => jsonProbe(CKAN_SEARCH_WRONG)],
      ['', () => probeResponse(DATA_GOV_PAGE, 'text/html')],
    ])
    const result = await inspectUrl(CKAN_URL, opts(fetchImpl))
    // A loose `fq` match is not this page; the HTML scrape takes over.
    expect(result.platform).toBeUndefined()
    expect(result.title).toContain('State-normed Well Water Index')
  })

  it('falls back to the page when neither API answers, and roles the links it scrapes', async () => {
    const fetchImpl = router([
      ['package_show', () => jsonProbe(CKAN_MISS)],
      ['package_search', () => jsonProbe(CKAN_SEARCH_MISS)],
      ['', () => probeResponse(DATA_GOV_PAGE, 'text/html')],
    ])
    const result = await inspectUrl(CKAN_URL, opts(fetchImpl))

    expect(result.kind).toBe('portal')
    expect(result.platform).toBeUndefined()
    // The lead saw `[?]` here: a scraped link is still typed by its shape.
    expect(result.links?.every(l => !!l.role)).toBe(true)
    expect(result.links?.map(l => l.role)).toEqual(['data-file', 'data-file', 'data-file'])
  })
})


/**
 * P5-79. The floor is what the page says about ITSELF — no model, no network
 * beyond the one read the probe already did. Every case here is a page held in
 * the test, so what is asserted is the reading, not a site.
 */
describe('the deterministic floor for a dropped page (P5-79)', () => {
  it('drops a suffix the head already carries, and skips the title and chrome in a fallback description', () => {
    const url = new URL('http://www.engaginglandowners.org/landowner-data/find-profiles?region=97')
    expect(cleanPageTitle('TELE - Tools for Engaging Landowners Effectively | Tools for Engaging Landowners Effectively', 'TELE - Tools for Engaging Landowners Effectively', url))
      .toBe('TELE - Tools for Engaging Landowners Effectively')
    const html = `<html><head><title>Find Profiles | TELE - Tools for Engaging Landowners Effectively</title>
      <meta property="og:site_name" content="TELE - Tools for Engaging Landowners Effectively"></head><body>
      <a href="#main-content" class="element-invisible">Skip to main content</a>
      <form class="search-form"><label>Search form</label><input type="text"><button>Search</button></form>
      <h1>Find Profiles | TELE - Tools for Engaging Landowners Effectively</h1>
      <p>Choose Geographic Area then download your profiles below.</p></body></html>`
    const page = readPageBlock(html, url)
    expect(page?.title).toBe('Find Profiles')
    expect(page?.description).toBe('Choose Geographic Area then download your profiles below.')
  })

  const html = (head: string, body = '<h1>Hello</h1><p>Body words.</p>') =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`

  it('reads the page own title, description and publisher', async () => {
    const fetchImpl = router([['', () => probeResponse(PLAIN_PAGE, 'text/html')]])
    const result = await inspectUrl('https://llpp.example/reports/heirs-property', opts(fetchImpl))

    expect(result.page).toEqual({
      // The page declares no og:site_name and "Land Loss Prevention Project"
      // is not what llpp.example is called, so the suffix stays: the floor
      // drops a site name it can PROVE, and guesses at nothing.
      title: "Heirs' property in the Black Belt — Land Loss Prevention Project",
      description: "A 2025 field report on heirs' property and clouded title across the Black Belt counties.",
    })
  })

  it('drops a trailing site name, whichever dash the CMS used', () => {
    const url = new URL('https://www.engaginglandowners.org/about')
    // The site says its own name after the separator: the entry already knows
    // whose site it is.
    expect(cleanPageTitle('Woodland owners | Engaging Landowners', 'Engaging Landowners', url)).toBe('Woodland owners')
    expect(cleanPageTitle('Woodland owners - Engaging Landowners', 'Engaging Landowners', url)).toBe('Woodland owners')
    expect(cleanPageTitle('Woodland owners — Engaging Landowners', 'Engaging Landowners', url)).toBe('Woodland owners')
    // No provider declared: the host answers to the same name.
    expect(cleanPageTitle('Woodland owners | Engaging Landowners', undefined, url)).toBe('Woodland owners')
  })

  it('keeps a suffix that is not the site saying its own name', () => {
    const url = new URL('https://epd.example.gov/wells')
    expect(cleanPageTitle('Private wells — 2024 results', 'Georgia EPD', url)).toBe('Private wells — 2024 results')
    // And a title that IS only the site name keeps it: dropping it would
    // leave the entry with no title at all.
    expect(cleanPageTitle('Engaging Landowners', 'Engaging Landowners', url)).toBe('Engaging Landowners')
  })

  it('collapses whitespace and caps the title', () => {
    const url = new URL('https://x.example/')
    expect(cleanPageTitle('\n  Heirs’   property\n  report ', undefined, url)).toBe('Heirs’ property report')
    const long = cleanPageTitle('word '.repeat(60), undefined, url)!
    expect(long.length).toBeLessThanOrEqual(121)
    expect(long.endsWith('…')).toBe(true)
  })

  it('falls back to the page first words when it declares no description', () => {
    const page = readPageBlock(
      html(
        '<title>Landowner resources</title>',
        '<nav><a href="/a">Home</a><a href="/b">Contact</a></nav>' +
          '<main><p>Heirs property is land passed down without a will, and it is the leading cause of Black land loss.</p></main>' +
          '<footer><a href="/privacy">Privacy</a></footer>',
      ),
      new URL('https://x.example/resources'),
    )
    expect(page?.description).toContain('Heirs property is land passed down without a will')
    // The navigation and the footer are not the page's description.
    expect(page?.description).not.toContain('Privacy')
    expect(page?.description).not.toContain('Contact')
    expect(page!.description!.length).toBeLessThanOrEqual(PAGE_DESCRIPTION_MAX + 1)
  })

  it('cuts a long fallback on a word boundary', () => {
    const words = 'landowners '.repeat(80)
    const page = readPageBlock(html('<title>Long</title>', `<p>${words}</p>`), new URL('https://x.example/'))
    expect(page!.description!.length).toBeLessThanOrEqual(PAGE_DESCRIPTION_MAX + 1)
    expect(page!.description!.endsWith('…')).toBe(true)
    expect(page!.description).not.toMatch(/landown…$/)
  })

  it('a page with no title of its own gets none invented for it', async () => {
    const fetchImpl = router([['', () => probeResponse(html('', '<p>Just some words.</p>'), 'text/html')]])
    const result = await inspectUrl('https://x.example/untitled', opts(fetchImpl))
    expect(result.page?.title).toBeUndefined()
    expect(result.page?.description).toBe('Just some words.')
  })

  it('says when the page itself was served over http', async () => {
    const fetchImpl = router([['', () => probeResponse(PLAIN_PAGE, 'text/html')]])
    const insecure = await inspectUrl('http://www.engaginglandowners.org/', opts(fetchImpl))
    expect(insecure.page?.insecure).toBe(true)
    const secure = await inspectUrl('https://llpp.example/reports/heirs-property', opts(fetchImpl))
    expect(secure.page?.insecure).toBeUndefined()
  })

  it('carries og:site_name as the publisher, and reaches a portal page too', async () => {
    const body = html(
      '<title>Water systems | Georgia EPD</title><meta property="og:site_name" content="Georgia EPD">' +
        '<meta name="description" content="Community water systems, by county.">',
      '<p>Systems.</p><a href="/files/systems.csv">CSV</a>',
    )
    const fetchImpl = router([['', () => probeResponse(body, 'text/html')]])
    const result = await inspectUrl('https://opendata.georgia.gov/datasets/water-systems', opts(fetchImpl))
    expect(result.kind).toBe('portal')
    expect(result.page).toEqual({
      title: 'Water systems',
      description: 'Community water systems, by county.',
      provider: 'Georgia EPD',
    })
  })

  it('stores the documents the page offers, beside the links (P5-80)', async () => {
    const body = html(
      '<title>Landowner profiles</title>',
      '<p>Profiles from the 2024 cohort.</p>' +
        '<a href="/profiles/ada-carter.pdf">Ada Carter</a>' +
        '<a href="/profiles/ben-oyelaran.pdf">Ben Oyelaran</a>' +
        '<a href="https://elsewhere.example/other.pdf">Someone else site</a>',
    )
    const fetchImpl = router([['', () => probeResponse(body, 'text/html')]])
    const result = await inspectUrl('https://x.example/profiles', opts(fetchImpl))

    expect(result.documents).toEqual([
      expect.objectContaining({ url: 'https://x.example/profiles/ada-carter.pdf', label: 'Ada Carter' }),
      expect.objectContaining({ url: 'https://x.example/profiles/ben-oyelaran.pdf', label: 'Ben Oyelaran' }),
    ])
    // Another site's PDF is not this page's collection.
    expect(JSON.stringify(result.documents)).not.toContain('elsewhere.example')
  })

  it('is validated on read-back like every other stored field', () => {
    const stored = parseInspection({
      kind: 'page',
      confidence: 'medium',
      url: 'https://x.example/',
      checkedAt: '2026-09-10T00:00:00.000Z',
      page: { title: '  Heirs property  ', description: 'A report.', provider: 7, insecure: 'yes' },
    })
    expect(stored?.page).toEqual({ title: 'Heirs property', description: 'A report.' })

    // Nothing usable in the block, the block goes.
    expect(
      parseInspection({
        kind: 'page',
        confidence: 'low',
        url: 'https://x.example/',
        checkedAt: 'T',
        page: { title: '   ', provider: null },
      })?.page,
    ).toBeUndefined()
    expect(
      parseInspection({ kind: 'page', confidence: 'low', url: 'https://x.example/', checkedAt: 'T', page: 'nope' })?.page,
    ).toBeUndefined()
  })

  it('reads the page documents back, capped and cleaned (P5-80)', () => {
    const read = (documents: unknown) =>
      parseInspection({ kind: 'page', confidence: 'low', url: 'https://x.example/', checkedAt: 'T', documents })
        ?.documents

    // A url and a label, both strings; the context capped.
    expect(
      read([
        { url: 'https://x.example/a.pdf', label: 'Profile A', context: 'c'.repeat(400) },
        { url: 'https://x.example/b.pdf' }, // no label: not an offer a person can read
        { url: 'javascript:alert(1)', label: 'Nope' },
        { url: 'https://x.example/c.pdf', label: 7 },
        'not an object',
      ]),
    ).toEqual([{ url: 'https://x.example/a.pdf', label: 'Profile A', context: 'c'.repeat(200) }])

    // Thirty is the cap the pull-in works to, so it is the cap we store.
    expect(read(Array.from({ length: 40 }, (_, i) => ({ url: `https://x.example/${i}.pdf`, label: `Doc ${i}` })))).toHaveLength(
      INSPECT_DOCUMENTS_MAX,
    )
    expect(read('no')).toBeUndefined()
    expect(read([])).toBeUndefined()
  })
})
