/**
 * Map deep links — the contract every "Show on map" link is written against
 * (P5-36 `?layers=`, P5-55 `?fit=<geoids>`, P5-74 `?fit=bbox:…`, P5-36
 * `?focus=`), and the one the map-canvas extraction (P6-10) has to keep.
 *
 * Backend-free: `/api/me` and the internal layer routes are stubbed with
 * `cy.intercept`; the map itself is the real one, read through
 * `window.__bloMap`, which the e2e build exposes (`VITE_E2E=1`, set by
 * `npm run test:e2e`). The URL patterns are anchored regexes on the path
 * because the API base is a build-time variable.
 */

// A module, so these names do not collide with the other specs' top-level consts.
export {}

const DATA_LOAD_TIMEOUT = 90000
const MAP_TIMEOUT = 20000

const ME = { username: 'dev-admin', role: 'admin', csrfToken: 'test-csrf-token' }

const LAYER = {
  id: 'internal-organizations',
  slug: 'organizations',
  geometry: 'point',
  name: 'Organizations (HQ)',
  dataType: 'number',
  unit: '',
  direction: 'higher',
  range: null,
  description: 'Headquarters of the network organizations.',
  source: 'BLO research',
  year: 2026,
  file: 'organizations.csv',
  color: '#ff6b1c',
  popupFields: ['Tier'],
  bbox: [-105.3, 33.5, -84.3, 40.1],
  updatedAt: null,
}

function point(label: string, lng: number, lat: number, tier: string) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { _label: label, Tier: tier } }
}

const POINTS = {
  id: LAYER.id,
  slug: LAYER.slug,
  geometry: 'point',
  type: 'FeatureCollection',
  features: [
    point('Atlanta Land Trust', -84.39, 33.75, 'Tier 2'),
    point('Memphis Green', -90.05, 35.15, 'Tier 3'),
    point('GreenLatinos', -105.27, 40.02, 'Tier 1'),
  ],
  count: 3,
  skipped: 0,
  bbox: LAYER.bbox,
}

type MapHandle = {
  getLayer(id: string): unknown
  getZoom(): number
  getCenter(): { lng: number; lat: number }
  getBounds(): { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number }
}

function stubLoggedIn(): void {
  cy.intercept('GET', /\/api\/me$/, { statusCode: 200, body: ME }).as('me')
  cy.intercept('GET', /\/api\/layers\/internal$/, { statusCode: 200, body: { layers: [LAYER] } }).as('manifest')
  cy.intercept('GET', /\/api\/layers\/internal\/organizations$/, { statusCode: 200, body: POINTS }).as('points')
}

function mapHandle(): Cypress.Chainable<MapHandle> {
  cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
  return cy.window({ timeout: MAP_TIMEOUT }).its('__bloMap').should('exist') as unknown as Cypress.Chainable<MapHandle>
}

describe('map deep links (logged in, stubbed layers)', () => {
  beforeEach(stubLoggedIn)

  it('opens an internal point layer on its own frame and lists its entities', () => {
    cy.visit('/?layers=internal-organizations&fit=bbox:-106,33,-84,41')
    // The deep link is applied once the counties are in, so the layer's own
    // request can be a long way behind the visit on a cold browser.
    mapHandle()
    cy.wait('@manifest', { timeout: DATA_LOAD_TIMEOUT })
    cy.wait('@points', { timeout: DATA_LOAD_TIMEOUT })
    cy.window({ timeout: MAP_TIMEOUT }).should(win => {
      const m = (win as unknown as { __bloMap: MapHandle }).__bloMap
      expect(m.getLayer('internal-organizations-points'), 'the point layer').to.exist
      // fitBounds framed the bbox: tighter than the national view (zoom ≈ 3.5).
      expect(m.getZoom()).to.be.greaterThan(4)
      // The frame covers the bbox (padding makes it a little wider; a float
      // hair narrower is fitBounds' rounding, not a miss).
      const b = m.getBounds()
      expect(b.getWest()).to.be.at.most(-105.9)
      expect(b.getEast()).to.be.at.least(-84.1)
    })
    cy.contains('Organizations (HQ)').should('exist')
    cy.contains('3 entities').should('exist')
  })

  it('flies to one point of the layer with ?focus=', () => {
    cy.visit('/?layers=internal-organizations&focus=internal-organizations:GreenLatinos')
    mapHandle()
    cy.wait('@points', { timeout: DATA_LOAD_TIMEOUT })
    cy.window({ timeout: MAP_TIMEOUT }).should(win => {
      const m = (win as unknown as { __bloMap: MapHandle }).__bloMap
      expect(m.getZoom()).to.be.at.least(8)
      const c = m.getCenter()
      expect(Math.abs(c.lng - -105.27)).to.be.lessThan(0.5)
      expect(Math.abs(c.lat - 40.02)).to.be.lessThan(0.5)
    })
  })

  it('frames the counties a comparison names with ?fit=<geoids> and turns the public layer on', () => {
    cy.visit('/?layers=pct_Black&fit=13121,13089')
    mapHandle()
    cy.window({ timeout: MAP_TIMEOUT }).should(win => {
      const m = (win as unknown as { __bloMap: MapHandle }).__bloMap
      expect(m.getZoom()).to.be.at.least(7)
      const c = m.getCenter()
      // Fulton + DeKalb, GA.
      expect(Math.abs(c.lng - -84.4)).to.be.lessThan(1)
      expect(Math.abs(c.lat - 33.8)).to.be.lessThan(1)
    })
    cy.contains('Percent Black').should('exist')
  })
})

describe('map deep links (logged out)', () => {
  it('ignores an internal id silently and never asks for the layer', () => {
    // No /api/me stub: boot hydration settles as logged out.
    cy.intercept('GET', /\/api\/layers\/internal.*/).as('layers')
    cy.visit('/?layers=internal-organizations&fit=bbox:-106,33,-84,41')
    mapHandle()
    cy.window().should(win => {
      const m = (win as unknown as { __bloMap: MapHandle }).__bloMap
      expect(m.getLayer('internal-organizations-points')).to.be.undefined
    })
    cy.contains('Organizations (HQ)').should('not.exist')
    cy.get('@layers.all').should('have.length', 0)
  })
})
