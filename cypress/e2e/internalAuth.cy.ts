/**
 * Internal auth (P5-4): guard redirect + login/logout golden path.
 *
 * The guard tests run backend-free: with no API reachable, /api/me boot
 * hydration resolves to logged-out and the router guard must bounce
 * /account to /login.
 *
 * The golden-path tests need the dev API with its seeded account, so they
 * only run when CYPRESS_INTERNAL_AUTH_LIVE=1. Local recipe:
 *   cd server && env -u ANTHROPIC_API_KEY LIBRARY_DEV_PGMEM=1 PORT=3005 npx tsx src/index.ts
 *   VITE_API_URL=http://localhost:3005 npm run build
 *   CYPRESS_INTERNAL_AUTH_LIVE=1 npm run test:e2e
 * (http://localhost:4173 must be in the server's ALLOWED_ORIGINS.)
 */

describe('internal route guard (backend-free)', () => {
  it('redirects a logged-out visit to /account to /login with a redirect query', () => {
    cy.visit('/account')
    cy.location('pathname').should('eq', '/login')
    cy.location('search').should('contain', 'redirect=')
  })

  it('shows the login form at /login', () => {
    cy.visit('/login')
    cy.get('#login-username').should('be.visible')
    cy.get('#login-password').should('be.visible')
    cy.contains('button', 'Log in').should('be.disabled')
  })

  it('logged out, the nav shows only a quiet "Log in" link', () => {
    cy.visit('/')
    cy.contains('nav a', 'Log in').should('have.attr', 'href', '/login')
    cy.contains('nav a', 'Account').should('not.exist')
    // P6-5: the four internal items a visitor must never see.
    cy.contains('nav a', 'Library').should('not.exist')
    cy.contains('nav a', 'Search').should('not.exist')
    cy.contains('nav a', 'Chat').should('not.exist')
    cy.contains('nav a', 'New').should('not.exist')
  })

  it('redirects logged-out /library and /library/:slug to /login (P5-9)', () => {
    cy.visit('/library')
    cy.location('pathname').should('eq', '/login')
    cy.visit('/library/some-entry')
    cy.location('pathname').should('eq', '/login')
    cy.location('search').should('contain', 'redirect=')
    // P5-31: the dataset explorer route is guarded too.
    cy.visit('/library/some-entry/data?q=secret')
    cy.location('pathname').should('eq', '/login')
    cy.location('search').should('contain', 'redirect=')
  })

  it('redirects logged-out /wiki and /wiki/:slug to /login (P5-15)', () => {
    cy.visit('/wiki')
    cy.location('pathname').should('eq', '/login')
    cy.visit('/wiki/some-page')
    cy.location('pathname').should('eq', '/login')
    cy.location('search').should('contain', 'redirect=')
  })

  it('guards the new surfaces too, and the retired paths redirect through login (P6-5)', () => {
    for (const path of ['/kb', '/search', '/chat', '/new', '/datasets', '/docs', '/analysis']) {
      cy.visit(path)
      cy.location('pathname').should('eq', '/login')
      cy.location('search').should('contain', 'redirect=')
    }
    // A retired URL is guarded BEFORE it redirects, so a shared link still
    // bounces a logged-out reader through login rather than leaking where it
    // was going to land.
    cy.visit('/ask?q=who+owns+this+land')
    cy.location('pathname').should('eq', '/login')
    cy.visit('/layers')
    cy.location('pathname').should('eq', '/login')
  })
})

const live = Cypress.env('INTERNAL_AUTH_LIVE') === '1' || Cypress.env('INTERNAL_AUTH_LIVE') === 1

;(live ? describe : describe.skip)('login/logout golden path (live API)', () => {
  it('logs in, persists across reload, and logs out', () => {
    cy.visit('/login')
    cy.get('#login-username').type('dev-admin')
    cy.get('#login-password').type('dev-password-123')
    cy.contains('button', 'Log in').click()

    // Success → back on the map with the username in the nav
    cy.location('pathname').should('eq', '/')
    cy.contains('nav a', 'dev-admin').should('have.attr', 'href', '/account')

    // Account stub shows identity
    cy.visit('/account')
    cy.contains('dd', 'dev-admin')
    cy.contains('dd', 'admin')

    // Hard reload keeps the session (cookie, not localStorage)
    cy.reload()
    cy.contains('dd', 'dev-admin')
    cy.window().then(win => {
      expect(win.localStorage.getItem('blo-internal-session')).to.be.null
    })

    // P6-5: the landing is "Library" in the sitewide header.
    cy.contains('header nav a', 'Library').click()
    cy.location('pathname').should('eq', '/kb')
    cy.contains('h1', 'Library')

    // P6-13: both of the library's axes live in ITS strip — the three
    // resources and the three functions — and the sitewide header carries
    // only what is sitewide. Scoped to `header nav` on purpose: `KbNav` is a
    // `<nav>` too, so a bare `nav a` matches either and would keep passing if
    // the functions climbed back up into the header.
    for (const [label, path] of [
      ['Datasets', '/datasets'],
      ['Docs', '/docs'],
      ['Analysis', '/analysis'],
      ['Search', '/search'],
      ['Chat', '/chat'],
      ['New', '/new'],
    ] as const) {
      cy.contains('[data-testid="kb-nav"] a', label).should('have.attr', 'href', path)
      cy.get('header nav').contains('a', label).should('not.exist')
    }

    // The datasets browser renders past the guard. The dev bucket may be
    // empty — either the grouped list or the empty state proves it answered.
    cy.contains('[data-testid="kb-nav"] a', 'Datasets').click()
    cy.location('pathname').should('eq', '/datasets')
    cy.contains('h1', 'Datasets')
    cy.get('[data-testid="browse-group"], [data-testid="datasets-empty"], [data-testid="datasets-loading"]').should('exist')

    // P6-5: the retired list pages still answer, on the surface that replaced
    // them, with the filter translated.
    cy.visit('/library?kind=dataset')
    cy.location('pathname').should('eq', '/datasets')
    cy.location('search').should('contain', 'readiness=held')
    cy.visit('/wiki')
    cy.location('pathname').should('eq', '/docs')
    cy.visit('/ask')
    cy.location('pathname').should('eq', '/chat')

    // Logout returns to the logged-out shell
    cy.visit('/account')
    cy.contains('button', 'Log out').click()
    cy.location('pathname').should('eq', '/')
    cy.contains('nav a', 'Log in').should('exist')

    // And the guard is active again
    cy.visit('/account')
    cy.location('pathname').should('eq', '/login')
  })

  // NOTE: this writes real objects into the configured library bucket — clean
  // up incoming/ test entries (and their versions) after a live run.
  it('uploads a quick drop and files it from the queue (P5-10/P5-11)', () => {
    cy.visit('/login')
    cy.get('#login-username').type('dev-admin')
    cy.get('#login-password').type('dev-password-123')
    cy.contains('button', 'Log in').click()
    cy.location('pathname').should('eq', '/')

    // P6-8/P6-5: adding something is its own page now. P6-29: no heading, and
    // the chooser is the first thing — Link or File, nothing about how many.
    cy.visit('/new')
    // App.vue's own <h1> is the site title; the PAGE adds none.
    cy.get('.new-view h1').should('not.exist')
    cy.get('[data-testid="new-drop-zone"]').should('not.exist')
    cy.get('[data-testid="choose-file"]').click()
    cy.get('[data-testid="new-drop-zone"]').should('be.visible')
    // Nothing is picked, so no size limit is claimed yet.
    cy.get('[data-testid="new-limit"]').should('not.contain', 'MB')

    // Quick drop: pick ONE file through the one zone, which routes it to the
    // single-document form by count alone, then skip the form.
    const name = `cypress-drop-${Date.now()}.csv`
    cy.get('[data-testid="new-file-input"]').selectFile(
      {
        contents: Cypress.Buffer.from('county,score\nShelby,42\n'),
        fileName: name,
        mimeType: 'text/csv',
      },
      { force: true },
    )
    cy.contains('[data-testid="document-form"] .chosen', name)
    cy.get('[data-testid="bulk-chosen"]').should('not.exist')
    // One file, so the one limit that applies to one file.
    cy.get('[data-testid="new-limit"]').should('contain', '200 MB').and('not.contain', '100 MB')
    cy.contains('[data-testid="document-form"] button', 'Quick drop').click()
    cy.contains('[data-testid="document-drop-note"]', 'to file')

    // P6-5: the to-file queue is the first group on /docs, for whoever
    // dropped it (and for admins).
    cy.visit('/docs')
    cy.contains('[data-testid="browse-group"]', 'To file').contains('[data-testid="doc-row"]', name).click()

    // File it from the entry-detail form (Example 5).
    cy.get('.filing-form input[aria-label="Title"]').clear().type('Cypress filed entry')
    cy.get('.filing-form input[aria-label="Category"]').type('testing')
    cy.get('.filing-form input[aria-label="Tags"]').type('cypress, e2e')
    cy.contains('.filing-form button', 'File').click()
    cy.contains('.filing-note', 'needs-review')
    cy.contains('h1', 'Cypress filed entry')
    cy.contains('.badge', 'needs-review')

    // Log out so this spec leaves no session behind.
    cy.visit('/account')
    cy.contains('button', 'Log out').click()
  })

  it('rejects bad credentials with a generic error', () => {
    cy.visit('/login')
    cy.get('#login-username').type('dev-admin')
    cy.get('#login-password').type('not-the-password')
    cy.contains('button', 'Log in').click()
    cy.get('[role="alert"]').should('contain', 'Invalid credentials')
    cy.location('pathname').should('eq', '/login')
  })
})
