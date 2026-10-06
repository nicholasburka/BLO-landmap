import { describe, it, expect } from 'vitest'
import {
  featureSourceId,
  pointMapLayerIds,
  lineMapLayerIds,
  stateMapLayerIds,
  featureMapLayerIds,
  featureDrawOrder,
  allFeatureMapLayerIds,
  orderFeatureLayers,
  addFeatureLayerToMap,
  removeFeatureLayerFromMap,
  buildFeaturePopup,
  boundsForFeatures,
  boundsOfFeature,
  anchorOfFeature,
  POINT_DEFAULT_COLOR,
  LINE_DEFAULT_WIDTH,
  LINE_HIT_WIDTH,
  LINE_HOVER_EXTRA,
  STATE_FILL_OPACITY,
  STATE_HOVER_OPACITY,
  STATE_OUTLINE_WIDTH,
  STATE_HOVER_OUTLINE_WIDTH,
  type FeatureMapLike,
} from '../internalFeatureLayers'
import type { InternalFeatureLayer, InternalFeatureCollection, PointFeature, LineFeature, StateFeature } from '../internalLayers'

const layer: InternalFeatureLayer = { id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', name: 'Organizations (HQ)', description: '', source: '', color: null, popupFields: ['Tier', 'Website'], detailFields: [], width: null }
const collection: InternalFeatureCollection = {
  id: 'internal-orgs-hq', slug: 'orgs-hq', geometry: 'point', type: 'FeatureCollection', count: 1, skipped: 0, bbox: [-74, 40, -74, 40],
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-74, 40] }, properties: { _label: 'Black Farmer Fund', Tier: 'Tier 1', Website: 'https://blackfarmerfund.org' } }],
}

const lineLayer: InternalFeatureLayer = { id: 'internal-transmission', slug: 'transmission', geometry: 'line', name: 'Transmission lines', description: '', source: '', color: null, popupFields: ['OWNER'], detailFields: [], width: null }
const lineCollection: InternalFeatureCollection = {
  id: 'internal-transmission', slug: 'transmission', geometry: 'line', type: 'FeatureCollection', count: 2, skipped: 0, bbox: [-91, 34, -87.6, 36.4],
  features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-90.05, 35.15], [-89.9, 35.2]] }, properties: { _label: 'Allen tie', OWNER: 'TVA' } },
    { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[-91, 34], [-90.5, 34.5]], [[-88, 36.4], [-87.6, 36.2]]] }, properties: { _label: 'Nucor spur', OWNER: 'MLGW' } },
  ],
}

function fakeMap(): FeatureMapLike & { sources: Map<string, any>; layers: Map<string, any>; log: string[] } {
  const sources = new Map<string, any>()
  const layers = new Map<string, any>()
  const log: string[] = []
  return {
    sources, layers, log,
    getSource: id => sources.get(id),
    addSource: (id, src) => { log.push(`addSource:${id}`); sources.set(id, src) },
    getLayer: id => layers.get(id),
    addLayer: l => { log.push(`addLayer:${l.id}`); layers.set(l.id as string, l) },
    moveLayer: id => { log.push(`moveLayer:${id}`) },
    removeLayer: id => { log.push(`removeLayer:${id}`); layers.delete(id) },
    removeSource: id => { log.push(`removeSource:${id}`); sources.delete(id) },
  }
}

describe('ids', () => {
  it('namespaces sources and layers by the internal layer id', () => {
    expect(featureSourceId('internal-orgs-hq')).toBe('internal-orgs-hq-src')
    expect(pointMapLayerIds('internal-orgs-hq')).toEqual({ clusters: 'internal-orgs-hq-clusters', clusterCount: 'internal-orgs-hq-cluster-count', points: 'internal-orgs-hq-points' })
    expect(lineMapLayerIds('internal-transmission')).toEqual({ line: 'internal-transmission-line', hit: 'internal-transmission-line-hit' })
    // The clickable layer comes first, because that is the order the canvas
    // asks Mapbox for a hit in.
    expect(featureMapLayerIds('internal-a', 'point')).toEqual(['internal-a-points', 'internal-a-clusters', 'internal-a-cluster-count'])
    expect(featureMapLayerIds('internal-b', 'line')).toEqual(['internal-b-line-hit', 'internal-b-line'])
    expect(allFeatureMapLayerIds([{ id: 'internal-a', geometry: 'point' }, { id: 'internal-b', geometry: 'line' }]))
      .toEqual(['internal-a-points', 'internal-a-clusters', 'internal-a-cluster-count', 'internal-b-line-hit', 'internal-b-line'])
  })
})

describe('add / remove', () => {
  it('adds a clustered source + clusters/count/points layers in the layer color, idempotently', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, { ...layer, color: '#123456' }, collection)
    expect(map.log).toEqual(['addSource:internal-orgs-hq-src', 'addLayer:internal-orgs-hq-clusters', 'addLayer:internal-orgs-hq-cluster-count', 'addLayer:internal-orgs-hq-points'])
    const src = map.sources.get('internal-orgs-hq-src')
    expect(src.cluster).toBe(true)
    expect(src.data.features).toHaveLength(1)
    expect(map.layers.get('internal-orgs-hq-points').paint['circle-color']).toBe('#123456')
    expect(map.layers.get('internal-orgs-hq-clusters').filter).toEqual(['has', 'point_count'])
    addFeatureLayerToMap(map, { ...layer, color: '#123456' }, collection)
    expect(map.log).toHaveLength(4)
  })

  it('falls back to the default color and removes layers before the source', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, layer, collection)
    expect(map.layers.get('internal-orgs-hq-points').paint['circle-color']).toBe(POINT_DEFAULT_COLOR)
    map.log.length = 0
    removeFeatureLayerFromMap(map, 'internal-orgs-hq')
    expect(map.log).toEqual(['removeLayer:internal-orgs-hq-points', 'removeLayer:internal-orgs-hq-cluster-count', 'removeLayer:internal-orgs-hq-clusters', 'removeSource:internal-orgs-hq-src'])
    removeFeatureLayerFromMap(map, 'internal-orgs-hq') // tolerant
    expect(map.log).toHaveLength(4)
  })
})

describe('buildFeaturePopup', () => {
  it('renders the label, non-empty fields in order, links for http URLs, and the layer name', () => {
    const el = buildFeaturePopup({ _label: 'Black Farmer Fund', Tier: 'Tier 1', Website: 'https://blackfarmerfund.org', Empty: '' }, { name: 'Organizations (HQ)', popupFields: ['Tier', 'Empty', 'Website'] })
    expect(el.querySelector('.popup-title')!.textContent).toBe('Black Farmer Fund')
    expect([...el.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['Tier', 'Website'])
    const a = el.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://blackfarmerfund.org')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(el.querySelector('.popup-layer')!.textContent).toBe('Organizations (HQ)')
  })

  it('adds an in-app "Open record" link when given a record href (P5-36)', () => {
    const el = buildFeaturePopup({ _label: 'X' }, { name: 'Layer', popupFields: [] }, '/library/orgs/data?q=X')
    const a = el.querySelector('a.popup-record')!
    expect(a.getAttribute('href')).toBe('/library/orgs/data?q=X')
    expect(a.getAttribute('data-internal')).toBe('1')
    expect(buildFeaturePopup({ _label: 'X' }, { name: 'Layer', popupFields: [] }).querySelector('a.popup-record')).toBeNull()
  })

  it('never interprets cell values as HTML and falls back to the layer name for an empty label', () => {
    const el = buildFeaturePopup({ _label: '', Tier: '<img src=x onerror="alert(1)">', Note: 'javascript:alert(1)' }, { name: 'Layer', popupFields: ['Tier', 'Note'] })
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('a')).toBeNull()
    expect(el.querySelector('.popup-title')!.textContent).toBe('Layer')
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">')
  })
})

/**
 * P5-74: the frame a "Show on map" link carries, computed on the client from
 * the GeoJSON the caller already loaded.
 */
describe('boundsForFeatures', () => {
  const at = (lng: number, lat: number): PointFeature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lng, lat] },
    properties: {},
  })

  it('is the extent of the points, in fitBounds order', () => {
    expect(boundsForFeatures([at(-90.31, 35.35), at(-89.6, 34.99), at(-90.0, 35.1)]))
      .toEqual([-90.31, 34.99, -89.6, 35.35])
  })

  it('collapses to a degenerate box for a single point (fitBounds still frames it)', () => {
    expect(boundsForFeatures([at(-74, 40)])).toEqual([-74, 40, -74, 40])
  })

  it('ignores rows whose coordinates a geocoder never filled in', () => {
    const broken = [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [NaN, 40] }, properties: {} },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-500, 40] }, properties: {} },
      { type: 'Feature', properties: {} },
    ] as unknown as PointFeature[]
    expect(boundsForFeatures([...broken, at(-74, 40)])).toEqual([-74, 40, -74, 40])
    expect(boundsForFeatures(broken)).toBeNull()
  })

  it('says null for an empty layer, so the map keeps the national view', () => {
    expect(boundsForFeatures([])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// P7-3: lines. A line is not a circle, so the paint differs; everything else
// about it — the source id, the popup, the removal, the frame — is the point
// layer's code, reached through the same two functions.
// ---------------------------------------------------------------------------
describe('line layers (P7-3)', () => {
  it('adds one unclustered source + a transparent hit layer under the visible stroke', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, { ...lineLayer, color: '#2b6cb0', width: 4 }, lineCollection)
    // The hit layer is added first so the stroke paints on top of it.
    expect(map.log).toEqual([
      'addSource:internal-transmission-src',
      'addLayer:internal-transmission-line-hit',
      'addLayer:internal-transmission-line',
    ])
    const src = map.sources.get('internal-transmission-src')
    // Clustering is meaningless for a line; the ids feature-state needs are not.
    expect(src.cluster).toBeUndefined()
    expect(src.generateId).toBe(true)
    expect(src.data.features).toHaveLength(2)

    const hit = map.layers.get('internal-transmission-line-hit')
    expect(hit.type).toBe('line')
    expect(hit.paint['line-opacity']).toBe(0)
    expect(hit.paint['line-width']).toBe(LINE_HIT_WIDTH)

    const stroke = map.layers.get('internal-transmission-line')
    expect(stroke.type).toBe('line')
    expect(stroke.paint['line-color']).toBe('#2b6cb0')
    // The hovered line widens, which is what tells you which of several
    // crossing corridors a click would take.
    expect(stroke.paint['line-width']).toEqual(['case', ['boolean', ['feature-state', 'hover'], false], 4 + LINE_HOVER_EXTRA, 4])

    addFeatureLayerToMap(map, { ...lineLayer, color: '#2b6cb0', width: 4 }, lineCollection)
    expect(map.log).toHaveLength(3)
  })

  it('takes the default color and width when the block names neither', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, lineLayer, lineCollection)
    const stroke = map.layers.get('internal-transmission-line')
    expect(stroke.paint['line-color']).toBe(POINT_DEFAULT_COLOR)
    expect(stroke.paint['line-width']).toEqual([
      'case', ['boolean', ['feature-state', 'hover'], false], LINE_DEFAULT_WIDTH + LINE_HOVER_EXTRA, LINE_DEFAULT_WIDTH,
    ])
  })

  it('removes a line layer without being told it was one', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, lineLayer, lineCollection)
    map.log.length = 0
    // The same call a point layer gets: a toggle-off must not need the
    // manifest still to be in hand to know what to tear down.
    removeFeatureLayerFromMap(map, 'internal-transmission')
    expect(map.log).toEqual([
      'removeLayer:internal-transmission-line',
      'removeLayer:internal-transmission-line-hit',
      'removeSource:internal-transmission-src',
    ])
    expect(map.sources.size).toBe(0)
    removeFeatureLayerFromMap(map, 'internal-transmission') // tolerant
    expect(map.log).toHaveLength(3)
  })

  it('frames a layer on the union of every vertex of every part', () => {
    expect(boundsForFeatures(lineCollection.features)).toEqual([-91, 34, -87.6, 36.4])
  })

  it('frames one line on its own extent, and a point on a degenerate box', () => {
    expect(boundsOfFeature(lineCollection.features[1])).toEqual([-91, 34, -87.6, 36.4])
    expect(boundsOfFeature(collection.features[0])).toEqual([-74, 40, -74, 40])
  })

  /**
   * The anchor is the question a line forces: a point has one coordinate and
   * a line has none, so something has to stand for it. It is the MIDDLE
   * VERTEX of the path — always a coordinate the line passes through. The
   * centre of the bounding box would be the obvious alternative and is wrong:
   * for an L-shaped corridor it sits off the wire entirely.
   */
  describe('anchorOfFeature', () => {
    it('is a point itself, and the middle vertex of a line', () => {
      expect(anchorOfFeature(collection.features[0])).toEqual([-74, 40])
      const elbow: LineFeature = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-90, 35], [-90, 36], [-89, 36]] },
        properties: {},
      }
      const anchor = anchorOfFeature(elbow)!
      expect(anchor).toEqual([-90, 36])
      // On the line, not in the middle of the box it fits in.
      expect(elbow.geometry.coordinates as [number, number][]).toContainEqual(anchor)
      const box = boundsOfFeature(elbow)!
      expect(anchor).not.toEqual([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2])
    })

    it('spans the parts of a MultiLineString and is still a real vertex', () => {
      const anchor = anchorOfFeature(lineCollection.features[1])!
      const parts = (lineCollection.features[1].geometry as { coordinates: [number, number][][] }).coordinates
      expect(parts.flat()).toContainEqual(anchor)
    })

    it('is null when nothing in the feature is drawable', () => {
      expect(anchorOfFeature({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} } as LineFeature)).toBeNull()
      expect(anchorOfFeature({ type: 'Feature', properties: {} } as unknown as PointFeature)).toBeNull()
    })
  })

  it('popups are built by the same function a point uses', () => {
    const el = buildFeaturePopup(lineCollection.features[0].properties, lineLayer)
    expect(el.querySelector('.popup-title')!.textContent).toBe('Allen tie')
    expect([...el.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['OWNER'])
    expect(el.querySelector('.popup-layer')!.textContent).toBe('Transmission lines')
  })

  it('draws points and lines together without either touching the other ids', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, layer, collection)
    addFeatureLayerToMap(map, lineLayer, lineCollection)
    expect([...map.layers.keys()]).toEqual([
      'internal-orgs-hq-clusters',
      'internal-orgs-hq-cluster-count',
      'internal-orgs-hq-points',
      'internal-transmission-line-hit',
      'internal-transmission-line',
    ])
    removeFeatureLayerFromMap(map, 'internal-transmission')
    expect([...map.layers.keys()]).toEqual([
      'internal-orgs-hq-clusters',
      'internal-orgs-hq-cluster-count',
      'internal-orgs-hq-points',
    ])
    expect(map.sources.has('internal-orgs-hq-src')).toBe(true)
  })
})

/**
 * P7-9. A state layer is a point/line layer whose shape is a polygon and whose
 * popup is the point of it. The assertions here are the three places the
 * geometry actually differs: the paint, the stacking, and the prose.
 */
describe('state layers (P7-9)', () => {
  const stateLayer: InternalFeatureLayer = {
    id: 'internal-permits', slug: 'permits', geometry: 'state', name: 'Permitting by state',
    description: '', source: '', color: null, popupFields: ['Authority'], detailFields: ['Process'], width: null,
  }
  const georgia: StateFeature = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[-85, 31], [-81, 31], [-81, 35], [-85, 35], [-85, 31]]] },
    properties: { _state: '13', _label: 'Georgia', Authority: 'Georgia EPD', Process: 'Apply to EPD.\n\nThen a hearing.' },
  }
  const hawaii: StateFeature = {
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[[[-156, 19], [-155, 19], [-155, 20], [-156, 19]]], [[[-158, 21], [-157, 21], [-157, 22], [-158, 21]]]] },
    properties: { _state: '15', _label: 'Hawaii', Authority: 'Hawaii DOH', Process: '' },
  }
  const stateCollection: InternalFeatureCollection = {
    id: 'internal-permits', slug: 'permits', geometry: 'state', type: 'FeatureCollection',
    count: 2, skipped: 0, bbox: [-158, 19, -81, 35], features: [georgia, hawaii],
  }

  it('namespaces a fill and an outline, and makes the fill the clickable one', () => {
    expect(stateMapLayerIds('internal-permits')).toEqual({ fill: 'internal-permits-fill', outline: 'internal-permits-outline' })
    expect(featureMapLayerIds('internal-permits', 'state')).toEqual(['internal-permits-fill', 'internal-permits-outline'])
    // In the click guard beside the other two geometries — which is how a
    // click on a state reads the state rather than the county under it. The
    // consequence of that for a shape covering the whole map is deliberate:
    // drop 'state' from this list to put county clicks back.
    expect(allFeatureMapLayerIds([{ id: 'internal-permits', geometry: 'state' }, { id: 'internal-b', geometry: 'line' }]))
      .toEqual(['internal-permits-fill', 'internal-permits-outline', 'internal-b-line-hit', 'internal-b-line'])
  })

  it('adds one source and two layers, the wash under the outline, idempotently', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, { ...stateLayer, color: '#2f855a' }, stateCollection)
    expect(map.log).toEqual(['addSource:internal-permits-src', 'addLayer:internal-permits-fill', 'addLayer:internal-permits-outline'])
    const src = map.sources.get('internal-permits-src')
    // Unclustered — clustering a polygon is meaningless — and id-generating,
    // which is what feature-state hover and the rail match need.
    expect(src.cluster).toBeUndefined()
    expect(src.generateId).toBe(true)
    expect(src.data.features).toHaveLength(2)

    const fill = map.layers.get('internal-permits-fill')
    expect(fill.type).toBe('fill')
    expect(fill.paint['fill-color']).toBe('#2f855a')
    // A wash, lifted on hover. 50 opaque states would hide the map.
    expect(fill.paint['fill-opacity']).toEqual(['case', ['boolean', ['feature-state', 'hover'], false], STATE_HOVER_OPACITY, STATE_FILL_OPACITY])
    expect(STATE_FILL_OPACITY).toBeLessThan(STATE_HOVER_OPACITY)
    // Off, or every shared state line draws as a double-blended seam.
    expect(fill.paint['fill-antialias']).toBe(false)

    const outline = map.layers.get('internal-permits-outline')
    expect(outline.type).toBe('line')
    expect(outline.paint['line-color']).toBe('#2f855a')
    expect(outline.paint['line-width']).toEqual(['case', ['boolean', ['feature-state', 'hover'], false], STATE_HOVER_OUTLINE_WIDTH, STATE_OUTLINE_WIDTH])

    addFeatureLayerToMap(map, { ...stateLayer, color: '#2f855a' }, stateCollection)
    expect(map.log).toHaveLength(3)
  })

  it('takes the default colour, and removes the outline, the fill, then the source', () => {
    const map = fakeMap()
    addFeatureLayerToMap(map, stateLayer, stateCollection)
    expect(map.layers.get('internal-permits-fill').paint['fill-color']).toBe(POINT_DEFAULT_COLOR)
    map.log.length = 0
    removeFeatureLayerFromMap(map, 'internal-permits')
    expect(map.log).toEqual(['removeLayer:internal-permits-outline', 'removeLayer:internal-permits-fill', 'removeSource:internal-permits-src'])
    removeFeatureLayerFromMap(map, 'internal-permits') // tolerant
    expect(map.log).toHaveLength(3)
  })

  // Mapbox appends, so without this a state wash switched on last would cover
  // the corridors it is context for AND take their clicks.
  describe('orderFeatureLayers', () => {
    it('restacks bottom to top — states, then lines, then points', () => {
      const map = fakeMap()
      addFeatureLayerToMap(map, lineLayer, lineCollection)
      addFeatureLayerToMap(map, layer, collection)
      addFeatureLayerToMap(map, stateLayer, stateCollection)
      map.log.length = 0
      orderFeatureLayers(map, [layer, lineLayer, stateLayer])
      expect(map.log).toEqual([
        'moveLayer:internal-permits-fill',
        'moveLayer:internal-permits-outline',
        'moveLayer:internal-transmission-line-hit',
        'moveLayer:internal-transmission-line',
        'moveLayer:internal-orgs-hq-clusters',
        'moveLayer:internal-orgs-hq-cluster-count',
        'moveLayer:internal-orgs-hq-points',
      ])
    })

    it('draws a point layer\'s circles LAST and a line\'s hit twin FIRST — not the hit-test order', () => {
      // featureMapLayerIds puts the clickable layer first; the draw order is
      // the other way round for points, and these must not be confused.
      expect(featureDrawOrder('internal-a', 'point')).toEqual(['internal-a-clusters', 'internal-a-cluster-count', 'internal-a-points'])
      expect(featureDrawOrder('internal-b', 'line')).toEqual(['internal-b-line-hit', 'internal-b-line'])
      expect(featureDrawOrder('internal-c', 'state')).toEqual(['internal-c-fill', 'internal-c-outline'])
    })

    it('skips a layer whose map layers are not on the map yet', () => {
      const map = fakeMap()
      orderFeatureLayers(map, [stateLayer])
      expect(map.log).toEqual([])
    })
  })

  // The anchor rule P7-3 set, holding for a shape that has even less of a
  // position than a line: a vertex the feature actually passes through, never
  // the centre of its box.
  it('frames a state on its outline and anchors on a vertex of it', () => {
    expect(boundsOfFeature(georgia)).toEqual([-85, 31, -81, 35])
    expect(boundsOfFeature(hawaii)).toEqual([-158, 19, -155, 22])
    expect(boundsForFeatures([georgia, hawaii])).toEqual([-158, 19, -81, 35])

    const anchor = anchorOfFeature(georgia)!
    expect(georgia.geometry.coordinates[0]).toContainEqual(anchor)
    // A box centre is the obvious choice and is wrong: Michigan's is in Lake
    // Michigan and Florida's is in the Gulf.
    expect(anchor).not.toEqual([-83, 33])
    expect(hawaii.geometry.coordinates.flat(2)).toContainEqual(anchorOfFeature(hawaii)!)
  })

  // This is the ticket: the criterion is about READING a state's permitting
  // rules, so the popup is the feature rather than an afterthought.
  describe('the popup', () => {
    it('renders detailFields as headed paragraphs under the field list', () => {
      const el = buildFeaturePopup(georgia.properties, stateLayer, '/library/permits/data?q=Georgia')
      expect(el.querySelector('.popup-title')!.textContent).toBe('Georgia')
      expect([...el.querySelectorAll('dt')].map(d => d.textContent)).toEqual(['Authority'])
      const detail = el.querySelector('.popup-detail')!
      expect([...detail.querySelectorAll('h4')].map(h => h.textContent)).toEqual(['Process'])
      // A blank line is a paragraph break; every other newline is a wrap.
      expect([...detail.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Apply to EPD.', 'Then a hearing.'])
      // The record link still comes after the prose, which is why the prose
      // scrolls inside itself rather than growing the popup.
      expect(el.querySelector('a.popup-record')!.getAttribute('href')).toBe('/library/permits/data?q=Georgia')
      expect(el.querySelector('.popup-layer')!.textContent).toBe('Permitting by state')
    })

    it('leaves the prose block out entirely when no detail field has a value', () => {
      const el = buildFeaturePopup(hawaii.properties, stateLayer)
      expect(el.querySelector('.popup-detail')).toBeNull()
      expect(el.textContent).toContain('Hawaii DOH')
    })

    it('never interprets prose as HTML, and links a field that is only a URL', () => {
      const el = buildFeaturePopup(
        { _label: 'Georgia', Process: '<script>alert(1)</script>', Statute: 'https://rules.ga.gov/391-3-11' },
        { name: 'Permitting by state', popupFields: [], detailFields: ['Process', 'Statute'] },
      )
      expect(el.querySelector('script')).toBeNull()
      expect(el.querySelector('.popup-detail')!.textContent).toContain('<script>alert(1)</script>')
      expect(el.querySelector('.popup-detail a')!.getAttribute('href')).toBe('https://rules.ga.gov/391-3-11')
      expect(el.querySelector('.popup-detail a')!.getAttribute('rel')).toBe('noopener noreferrer')
    })

    it('adds no prose block for a point or line layer, which declare none', () => {
      expect(buildFeaturePopup(collection.features[0].properties, layer).querySelector('.popup-detail')).toBeNull()
      expect(buildFeaturePopup(lineCollection.features[0].properties, lineLayer).querySelector('.popup-detail')).toBeNull()
    })
  })
})
