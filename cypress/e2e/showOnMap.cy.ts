/**
 * "Show on map", in place (P6-14).
 *
 * The button used to be a link to `/?layers=…&fit=…`. Pressing it left the
 * page you were reading, and the URL it went to could say *which layer* and
 * *where to look* but never *which rows you were looking at* — so a searched
 * table "shown on the map" drew the whole layer.
 *
 * This is the whole round trip on one call site: open the pane, search the
 * table, watch the map narrow to what the table is showing, close it, and
 * find the page exactly as it was. The route never changes, which is the
 * other half of the point.
 *
 * The deep links are unchanged and `mapDeepLinks.cy.ts` still pins them: a
 * pasted `/?layers=…` URL opens the full map, and this spec opens one to
 * prove it. That file is the shared contract between the public map and
 * every pane, and it must stay untouched.
 *
 * Backend-free, like `chatMapPane.cy.ts`: `/api/me` is stubbed so the page is
 * reachable, and the county files are the real ones out of `dist-e2e`.
 */
export {}

const DATA_LOAD_TIMEOUT = 90000

const ME = { username: 'dev-admin', role: 'admin', csrfToken: 'test-csrf-token' }

/** A public layer with a county table: housing, so the page has rows to
 *  search and the map has a choropleth to narrow. */
const LAYER = 'median_home_value'
const LAYER_NAME = 'Median Home Value'

describe('Show on map opens a submap in place (P6-14)', () => {
  beforeEach(() => {
    cy.viewport(1440, 900)
    cy.intercept('GET', /\/api\/me$/, { statusCode: 200, body: ME }).as('me')
    cy.intercept('GET', /\/api\/layers\/internal$/, { statusCode: 200, body: { layers: [] } }).as('manifest')
    // The county polygons: counted, not stubbed. Nothing may ask for them
    // until a pane is open — the table's numbers are a different file.
    cy.intercept('GET', /\/datasets\/build\/counties.*$/).as('polygons')
  })

  it('opens beside the page, draws the searched rows, and closes back to it', () => {
    cy.visit(`/layers/${LAYER}`)
    cy.get('[data-testid="layer-name"]', { timeout: DATA_LOAD_TIMEOUT }).should('have.text', LAYER_NAME)
    cy.get('[data-testid="county-row"]', { timeout: DATA_LOAD_TIMEOUT }).should('have.length.greaterThan', 1)

    // Nothing yet: no pane, and no polygons downloaded for one.
    cy.get('[data-testid="layer-map-pane"]').should('not.exist')
    cy.get('@polygons.all').should('have.length', 0)

    // --- open ---------------------------------------------------------
    cy.get('[data-testid="layer-map-open"]').click()

    cy.get('[data-testid="layer-map-pane"]').should('exist')
    cy.get('[data-testid="layer-map-pane"] .mapboxgl-canvas', { timeout: DATA_LOAD_TIMEOUT }).should('exist')
    cy.get('[data-testid="layer-map-pane-layer"]').should('have.text', LAYER_NAME)
    cy.get('@polygons.all', { timeout: DATA_LOAD_TIMEOUT }).should('have.length', 1)
    // The overlay goes once the choropleth can paint.
    cy.get('[data-testid="layer-map-pane"] .loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')

    // The page it was opened from is still the page: the route never moved.
    cy.location('pathname').should('eq', `/layers/${LAYER}`)
    cy.location('search').should('eq', '')
    cy.get('[data-testid="layer-facts"]').should('be.visible')
    cy.get('[data-testid="county-table"]').should('be.visible')
    // Nothing is said about a subset while the table is showing everything.
    cy.get('[data-testid="layer-map-pane-note"]').should('not.exist')

    // --- filter -------------------------------------------------------
    // Searching the table narrows the map: this is the fidelity half of the
    // ticket, and the thing a `?layers=…&fit=…` link cannot express.
    cy.get('[data-testid="county-search"]').type('Mississippi')
    cy.get('[data-testid="layer-map-pane-note"]', { timeout: DATA_LOAD_TIMEOUT })
      .should('exist')
      .invoke('text')
      .should('match', /^\d+ of [\d,]+ counties$/)
    // Still the same page, still the same URL.
    cy.location('pathname').should('eq', `/layers/${LAYER}`)
    cy.get('[data-testid="layer-map-pane"] .mapboxgl-canvas').should('exist')

    // --- close --------------------------------------------------------
    cy.get('[data-testid="layer-map-pane-close"]').click()

    cy.get('[data-testid="layer-map-pane"]').should('not.exist')
    cy.location('pathname').should('eq', `/layers/${LAYER}`)
    cy.location('search').should('eq', '')
    // Closing a map is not a reset: the search the reader typed is still
    // there, and so is everything else on the page.
    cy.get('[data-testid="county-search"]').should('have.value', 'Mississippi')
    cy.get('[data-testid="layer-name"]').should('have.text', LAYER_NAME)
    cy.get('[data-testid="layer-facts"]').should('be.visible')
  })

  it('still offers the deep link on a window too narrow for a pane', () => {
    cy.viewport(900, 800)
    cy.visit(`/layers/${LAYER}`)
    cy.get('[data-testid="layer-name"]', { timeout: DATA_LOAD_TIMEOUT }).should('have.text', LAYER_NAME)

    cy.get('[data-testid="layer-map-open"]').should('not.exist')
    cy.get('[data-testid="layer-map-link"]').should('have.attr', 'href', `/?layers=${LAYER}`)
    cy.get('@polygons.all').should('have.length', 0)
  })

  it('leaves the pasted URL meaning exactly what it always meant', () => {
    // The button changed; the grammar did not. `mapDeepLinks.cy.ts` is the
    // contract — this is only the reassurance that a pane did not replace it.
    cy.visit(`/?layers=${LAYER}`)
    cy.get('.mapboxgl-canvas', { timeout: DATA_LOAD_TIMEOUT }).should('exist')
    cy.location('pathname').should('eq', '/')
    cy.location('search').should('eq', `?layers=${LAYER}`)
    // The full map, not a pane in a page.
    cy.get('[data-testid="layer-map-pane"]').should('not.exist')
  })
})
