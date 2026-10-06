import { describe, it, expect } from 'vitest'
import { parseMapDeepLink, mapUrlForLayers, mapUrlForLayerBounds, parseFitBounds, internalLayerId, recordUrl, MAX_DEEP_LINK_LAYERS, MAX_DEEP_LINK_FIT } from '../mapDeepLinks'

describe('parseMapDeepLink', () => {
  it('reads comma-separated and repeated layer ids, de-duplicated, dropping junk', () => {
    expect(parseMapDeepLink({ layers: 'pct_Black,internal-orgs, pct_Black ,../x,<b>' })).toEqual({ layers: ['pct_Black', 'internal-orgs'], focus: null, fit: [], bounds: null })
    expect(parseMapDeepLink({ layers: ['a', 'b,c'] })).toEqual({ layers: ['a', 'b', 'c'], focus: null, fit: [], bounds: null })
    expect(parseMapDeepLink({})).toEqual({ layers: [], focus: null, fit: [], bounds: null })
  })

  it('caps the layer list (P5-19 audit: a crafted URL must not pin the main thread)', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `layer_${i}`)
    const parsed = parseMapDeepLink({ layers: ids.join(',') })
    expect(parsed.layers).toEqual(ids.slice(0, MAX_DEEP_LINK_LAYERS))
    expect(MAX_DEEP_LINK_LAYERS).toBe(24)
  })

  it('reads focus as <internal layer id>:<label> (labels may contain colons) and adds the layer', () => {
    expect(parseMapDeepLink({ focus: 'internal-organizations:Black Farmer Fund' })).toMatchObject({
      layers: ['internal-organizations'],
      focus: { layerId: 'internal-organizations', label: 'Black Farmer Fund' },
    })
    expect(parseMapDeepLink({ layers: 'internal-a', focus: 'internal-a:Org: with colon' }).focus).toEqual({ layerId: 'internal-a', label: 'Org: with colon' })
    expect(parseMapDeepLink({ focus: 'pct_Black:x' }).focus).toBeNull() // only internal point layers can be focused
    expect(parseMapDeepLink({ focus: 'internal-a' }).focus).toBeNull() // no label
  })
})

describe('mapUrlForLayers / helpers', () => {
  it('round-trips through the parser and encodes labels', () => {
    const url = mapUrlForLayers(['pct_Black', 'internal-organizations'], { layerId: 'internal-organizations', label: 'Fund, Inc. & Co' })
    expect(url).toBe('/?layers=pct_Black%2Cinternal-organizations&focus=internal-organizations%3AFund%2C+Inc.+%26+Co')
    const q = Object.fromEntries(new URLSearchParams(url.slice(2)).entries())
    expect(parseMapDeepLink(q)).toEqual({ layers: ['pct_Black', 'internal-organizations'], focus: { layerId: 'internal-organizations', label: 'Fund, Inc. & Co' }, fit: [], bounds: null })
    expect(mapUrlForLayers([])).toBe('/')
    expect(mapUrlForLayers(['bad id'])).toBe('/')
  })

  it('builds internal ids and record links', () => {
    expect(internalLayerId('organizations')).toBe('internal-organizations')
    expect(recordUrl('organizations', 'Black Farmer Fund')).toBe('/library/organizations?tab=data&q=Black%20Farmer%20Fund')
  })
})

describe('fitting the map to counties (P5-55)', () => {
  it('reads five-digit GEOIDs out of ?fit=, dropping anything else', () => {
    expect(parseMapDeepLink({ fit: '47157, 28033 ,4715,../x,47157' }).fit).toEqual(['47157', '28033'])
    expect(parseMapDeepLink({ fit: '' }).fit).toEqual([])
  })

  it('caps the list at what a comparison can hold', () => {
    const many = Array.from({ length: 20 }, (_, i) => String(47000 + i)).join(',')
    expect(parseMapDeepLink({ fit: many }).fit).toHaveLength(MAX_DEEP_LINK_FIT)
  })

  it('round-trips through mapUrlForLayers', () => {
    const url = mapUrlForLayers(['pct_Black'], null, ['47157', '28033', 'nope'])
    expect(url).toBe('/?layers=pct_Black&fit=47157%2C28033')
    const params = Object.fromEntries(new URL(url, 'http://x').searchParams)
    expect(parseMapDeepLink(params)).toEqual({ layers: ['pct_Black'], focus: null, fit: ['47157', '28033'], bounds: null })
  })

  it('leaves the map URL untouched when nothing is being fitted', () => {
    expect(mapUrlForLayers(['pct_Black'])).toBe('/?layers=pct_Black')
    expect(mapUrlForLayers(['pct_Black'], null, [])).toBe('/?layers=pct_Black')
  })
})

/**
 * P5-74. "Show on map" for an internal point layer carries the layer's own
 * extent, so a Memphis layer opens on Memphis instead of on the country. The
 * `bbox:` prefix keeps that form apart from the county-GEOID form above —
 * neither can be read as the other.
 */
describe('fitting the map to a bounding box (P5-74)', () => {
  const memphis: [number, number, number, number] = [-90.31, 34.99, -89.6, 35.35]

  it('reads a well-formed box and refuses everything else', () => {
    expect(parseFitBounds('bbox:-90.31,34.99,-89.6,35.35')).toEqual(memphis)
    expect(parseFitBounds('-90.31,34.99,-89.6,35.35')).toBeNull() // no prefix
    expect(parseFitBounds('bbox:-90.31,34.99,-89.6')).toBeNull() // three numbers
    expect(parseFitBounds('bbox:-90.31,34.99,-89.6,35.35,1')).toBeNull() // five
    expect(parseFitBounds('bbox:a,b,c,d')).toBeNull()
    expect(parseFitBounds('bbox:-200,34.99,-89.6,35.35')).toBeNull() // off Earth
    expect(parseFitBounds('bbox:-89.6,34.99,-90.31,35.35')).toBeNull() // inside out
  })

  it('parses out of ?fit= alongside the county form, and wins when both appear', () => {
    expect(parseMapDeepLink({ fit: 'bbox:-90.31,34.99,-89.6,35.35' })).toMatchObject({ fit: [], bounds: memphis })
    expect(parseMapDeepLink({ fit: ['47157', 'bbox:-90.31,34.99,-89.6,35.35'] })).toMatchObject({
      fit: ['47157'],
      bounds: memphis,
    })
    expect(parseMapDeepLink({ fit: 'bbox:nonsense' })).toMatchObject({ fit: [], bounds: null })
  })

  it('round-trips a point layer\'s "Show on map" link', () => {
    const url = mapUrlForLayerBounds('internal-orgs-hq', memphis)
    expect(url).toBe('/?layers=internal-orgs-hq&fit=bbox%3A-90.31%2C34.99%2C-89.6%2C35.35')
    const params = Object.fromEntries(new URL(url, 'http://x').searchParams)
    expect(parseMapDeepLink(params)).toEqual({
      layers: ['internal-orgs-hq'],
      focus: null,
      fit: [],
      bounds: memphis,
    })
  })

  it('leaves a county layer on the national view', () => {
    // null bounds is how a caller says "this layer has no extent of its own".
    expect(mapUrlForLayerBounds('pct_Black', null)).toBe('/?layers=pct_Black')
  })

  it('rounds coordinates to five decimals so the link stays readable', () => {
    expect(mapUrlForLayerBounds('internal-a', [-90.3123456789, 34.9987654321, -89.6, 35.35])).toContain(
      'bbox%3A-90.31235%2C34.99877%2C-89.6%2C35.35',
    )
  })
})
