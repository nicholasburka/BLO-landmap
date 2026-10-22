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
    // P15-3: a bare `/` is a first visit, so the welcome is up and covers
    // the whole map — by design, not by accident. Getting past it is the
    // visitor's real first gesture here, which is what makes this different
    // from the "press Got it first" line the deep-link test below used to
    // carry: that one was working around a welcome that should never have
    // rendered at all.
    cy.get('[data-testid="welcome-skip"]').click()
    cy.contains('[role="tab"]', 'Layers').click()
    cy.get('[data-testid="internal-layers-header"]').should('not.exist')
    cy.contains('.category-header', 'Internal').should('not.exist')
    cy.get('@layers.all').should('have.length', 0)
  })

  it('opens public layers from a deep link and ignores internal ids logged out (P5-36)', () => {
    cy.intercept('GET', '**/api/layers/**').as('layers')
    cy.visit('/?layers=pct_Black,internal-p518-standin')
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    // P15-3: nothing to dismiss. This visitor asked for `pct_Black` over
    // Fulton and Mecklenburg, and a welcome screen over the answer they
    // were sent is a bug — the one this phase fixed.
    cy.get('[data-testid="welcome"]').should('not.exist')
    cy.contains('[role="tab"]', 'Layers').click()
    cy.contains('.category-header', 'Demographics').click()
    cy.get('#pct_Black', { timeout: 20000 }).should('be.checked')
    cy.get('[data-testid="internal-layers-header"]').should('not.exist')
    cy.get('@layers.all').should('have.length', 0)
  })

  it('welcomes a first visit once, and remembers (P15-3)', () => {
    cy.visit('/')
    // Wait for the counties before pressing anything, so the click lands on
    // a settled panel rather than one the datasets are about to re-render
    // underneath.
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.get('[data-testid="welcome"]').should('be.visible')
    cy.contains('[data-testid="welcome"]', 'See the rankings').should('exist')
    cy.get('[data-testid="welcome-skip"]').click()
    cy.get('[data-testid="welcome"]').should('not.exist')

    // The flag is per browser, so a reload is the real test of it — the
    // dismissal above only proved the v-if works.
    cy.reload()
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.get('[data-testid="welcome"]').should('not.exist')
  })

  /**
   * The rule the card this replaces broke, as an assertion rather than as a
   * workaround. `WelcomeCard` read localStorage and never the URL, so a
   * first-time visitor opening a shared link got a welcome screen over the
   * answer they had been sent — and this suite pressed "Got it" before every
   * interaction to get on with it.
   */
  it('never welcomes a visitor who was sent to a specific answer (P15-3)', () => {
    cy.visit('/?layers=pct_Black&fit=13121,13089')
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.contains('[role="tab"]', 'Legend').should('exist')
    cy.get('[data-testid="welcome"]').should('not.exist')

    // And nothing was written: they have not SEEN it, so the bare visit they
    // make later still gets one. A deep link must not spend the welcome.
    cy.visit('/')
    cy.get('[data-testid="welcome"]', { timeout: DATA_LOAD_TIMEOUT }).should('be.visible')
  })

  /**
   * P15-4 — dismissal is permanent per browser, so without a way back the
   * overlay is a screen you can only ever lose.
   */
  it('can be re-opened from the Lens, without un-seeing it (P15-4)', () => {
    cy.visit('/')
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.get('[data-testid="welcome-skip"]').click()

    cy.get('[data-testid="lens-what-is-this"]').click()
    cy.get('[data-testid="welcome"]').should('be.visible')
    cy.get('[data-testid="welcome-skip"]').click()

    // Re-opening does not clear the flag and dismissing again does not
    // re-set it: it records "has seen it", not "is hidden".
    cy.reload()
    cy.get('.loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
    cy.get('[data-testid="welcome"]').should('not.exist')
  })
})
