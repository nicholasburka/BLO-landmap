/**
 * Launch smoke test: the app shell must render without a backend —
 * map canvas, prompt input, lens, and rankings. The LLM round-trip
 * itself needs a live API key, so it's exercised manually / in staging,
 * not here.
 */
describe('app shell smoke', () => {
  it('renders the map and core UI', () => {
    cy.visit('/')
    cy.contains('h1', 'U.S. Livability Index')

    // Unified LLM prompt input
    cy.get('input[placeholder*="Ask about a place"]').should('be.visible')

    // Mapbox canvas comes up (token is baked in at build time)
    cy.get('.mapboxgl-canvas', { timeout: 20000 }).should('exist')

    // Lens (legend/layers/context tabs) and rankings panel shell
    cy.contains('[role="tab"]', 'Legend').should('exist')
    cy.contains('County Rankings').should('exist')
  })

  it('welcome card dismisses and stays dismissed', () => {
    cy.visit('/')
    cy.contains('button', 'Got it').click()
    cy.contains('Click any county to inspect').should('not.exist')
  })
})
