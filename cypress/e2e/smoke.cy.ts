/**
 * Launch smoke test: the app shell must render without a backend —
 * map canvas, prompt input, lens, and rankings. The LLM round-trip
 * itself needs a live API key, so it's exercised manually / in staging,
 * not here.
 */
/** The county datasets are tens of MB; on a loaded machine the initial fetch
 *  can take well over Cypress's 4s default. Give data-dependent UI a real
 *  budget instead of racing the loading overlay. (P5-74 took the 24 MB of
 *  contamination GeoJSON out of startup, so this is now a ceiling, not a
 *  typical wait — and the overlay no longer takes clicks while it is up.) */
const DATA_LOAD_TIMEOUT = 90000

describe('app shell smoke', () => {
  it('renders the map and core UI', () => {
    cy.visit('/')
    cy.contains('h1', 'U.S. Livability Index')

    // Unified LLM prompt input
    cy.get('input[placeholder*="Ask about a place"]').should('be.visible')

    // Mapbox canvas comes up (token is baked in at build time)
    cy.get('.mapboxgl-canvas', { timeout: 20000 }).should('exist')

    // Lens (legend/layers/context tabs)
    cy.contains('[role="tab"]', 'Legend').should('exist')

    // Rankings panel is query-driven now (mounts after an LLM scoring query
    // or 2+ selected layers) — at rest it must NOT render.
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.contains('County Rankings').should('not.exist')
  })

  it('shows no internal layers and never asks for them when logged out (P5-18)', () => {
    cy.intercept('GET', '**/api/layers/**').as('layers')
    cy.visit('/')
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.contains('[role="tab"]', 'Layers').click()
    cy.get('[data-testid="internal-layers-header"]').should('not.exist')
    cy.contains('.category-header', 'Internal').should('not.exist')
    cy.get('@layers.all').should('have.length', 0)
  })

  it('opens public layers from a deep link and ignores internal ids logged out (P5-36)', () => {
    cy.intercept('GET', '**/api/layers/**').as('layers')
    cy.visit('/?layers=pct_Black,internal-p518-standin')
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    // The welcome card overlays the lens until dismissed; the layer picker
    // mounts inside the Layers tab.
    cy.contains('button', 'Got it').click()
    cy.contains('[role="tab"]', 'Layers').click()
    cy.contains('.category-header', 'Demographics').click()
    cy.get('#pct_Black', { timeout: 20000 }).should('be.checked')
    cy.get('[data-testid="internal-layers-header"]').should('not.exist')
    cy.get('@layers.all').should('have.length', 0)
  })

  it('welcome card dismisses and stays dismissed', () => {
    cy.visit('/')
    // Wait for the counties before clicking, so the click lands on a settled
    // card rather than one the datasets are about to re-render underneath.
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.contains('button', 'Got it').click()
    cy.contains('Click any county to inspect').should('not.exist')
  })
})
