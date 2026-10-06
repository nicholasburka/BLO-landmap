/**
 * The chat page's map pane (P6-10).
 *
 * `MapCanvas` extracted from `Map.vue` means the same map can be mounted
 * somewhere other than `/`. This is that: the pane opens on demand, draws the
 * counties, closes again, and runs the assistant's `show_layer` against its
 * own map while every library tool stays on the server.
 *
 * Backend-free, like `chat.cy.ts`: every route is stubbed, the answer included
 * (a static NDJSON body is all the page's parser needs). The county files are
 * the real ones out of `dist-e2e`, so this also proves the pane is wired to
 * the real data path — and that nothing fetches them until it is opened.
 *
 * The map is read through `window.__bloMap`, which only the public map claims,
 * so the pane is checked through the DOM and the network instead. The
 * public-map contract lives in `mapDeepLinks.cy.ts` and must stay untouched.
 */
export {}

const DATA_LOAD_TIMEOUT = 90000

const ME = { username: 'dev-admin', role: 'admin', csrfToken: 'test-csrf-token' }

const CHAT = {
  id: 1,
  title: 'where is the Black population highest?',
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:00:00.000Z',
}

/** A map tool the page runs itself, with the arguments to run it with. */
const SHOW_LAYER = {
  id: 'call-map-1',
  tool: 'show_layer',
  kind: 'read',
  status: 'running',
  summary: 'Showed Percent Black on the map',
  args: { layerId: 'pct_Black', on: true },
}

const ANSWER_STREAM = [
  { type: 'tool_call', phase: 'started', call: SHOW_LAYER },
  { type: 'tool_call', phase: 'finished', call: { ...SHOW_LAYER, status: 'done' } },
  { type: 'text', text: 'Percent Black is on the map — the Black Belt stands out [1].' },
  { type: 'done', chatId: 1, messageId: 9, userMessageId: 8 },
]
  .map(event => JSON.stringify(event))
  .join('\n')
  .concat('\n')

describe('the map pane on the chat page (P6-10)', () => {
  beforeEach(() => {
    cy.viewport(1440, 900)
    cy.intercept('GET', /\/api\/me$/, { statusCode: 200, body: ME }).as('me')
    cy.intercept('GET', /\/api\/chats$/, { statusCode: 200, body: { chats: [CHAT] } }).as('threads')
    cy.intercept('GET', /\/api\/chats\/1$/, {
      statusCode: 200,
      body: { chat: CHAT, messages: [] },
    }).as('thread')
    cy.intercept('POST', /\/api\/chats\/1\/messages$/, {
      statusCode: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ANSWER_STREAM,
    }).as('send')
    cy.intercept('GET', /\/api\/layers\/internal$/, { statusCode: 200, body: { layers: [] } }).as('manifest')
    // The county files: counted, not stubbed. Nothing may ask for them until
    // the pane is open.
    cy.intercept('GET', /\/datasets\/build\/.*$/).as('countyFiles')
  })

  it('fetches no county file until the pane is opened, then draws the counties', () => {
    cy.visit('/chat')
    cy.wait('@thread')

    cy.get('[data-testid="chat-pane"]').should('not.exist')
    cy.get('@countyFiles.all').should('have.length', 0)

    cy.get('[data-testid="chat-pane-open"]').click()

    cy.get('[data-testid="chat-pane"]').should('exist')
    cy.get('[data-testid="chat-pane"] .mapboxgl-canvas', { timeout: DATA_LOAD_TIMEOUT }).should('exist')
    // Both files, once each: the geometry and the data.
    cy.get('@countyFiles.all', { timeout: DATA_LOAD_TIMEOUT }).should('have.length', 2)
    // The pane says what it is showing.
    cy.get('[data-testid="chat-pane-layer"]').should('have.text', 'BLO Livability Index')
    // The overlay goes away once the choropleth can paint.
    cy.get('[data-testid="chat-pane"] .loading-overlay', { timeout: DATA_LOAD_TIMEOUT }).should('not.exist')
  })

  it('closes again, and the conversation keeps the column to itself', () => {
    cy.visit('/chat')
    cy.wait('@thread')
    cy.get('[data-testid="chat-pane-open"]').click()
    cy.get('[data-testid="chat-pane"]').should('exist')

    cy.get('[data-testid="chat-pane-close"]').click()

    cy.get('[data-testid="chat-pane"]').should('not.exist')
    cy.get('[data-testid="chat-conversation"]').should('be.visible')
    // Opening it again is a fresh map, and the files come from the cache.
    cy.get('[data-testid="chat-pane-open"]').click()
    cy.get('[data-testid="chat-pane"] .mapboxgl-canvas', { timeout: DATA_LOAD_TIMEOUT }).should('exist')
  })

  it('runs the assistant\'s show_layer against the pane and names the layer', () => {
    cy.visit('/chat')
    cy.wait('@thread')

    cy.get('[data-testid="chat-input"]').type('where is the Black population highest?{enter}')
    cy.wait('@send')

    // The tool call opened the pane on its own and ran there.
    cy.get('[data-testid="chat-pane"]', { timeout: DATA_LOAD_TIMEOUT }).should('exist')
    cy.get('[data-testid="chat-pane-layer"]', { timeout: DATA_LOAD_TIMEOUT }).should('have.text', 'Percent Black')
    cy.get('[data-testid="chat-answer"]').should('contain', 'Percent Black is on the map')
    // The map itself is up, with the layer the assistant asked for.
    cy.get('[data-testid="chat-pane"] .mapboxgl-canvas', { timeout: DATA_LOAD_TIMEOUT }).should('exist')
  })

  it('offers no pane on a phone', () => {
    cy.viewport(390, 844)
    cy.visit('/chat')
    cy.wait('@thread')

    cy.get('[data-testid="chat-pane-open"]').should('not.exist')
    cy.get('[data-testid="chat-pane"]').should('not.exist')
    cy.get('@countyFiles.all').should('have.length', 0)
  })
})
