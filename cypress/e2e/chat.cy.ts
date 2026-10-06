/**
 * Chat (P6-7b): new chat → ask → answer with a citation → run a proposed write.
 *
 * Backend-free. Every route the page touches is stubbed with `cy.intercept`,
 * including the answer itself: `POST /api/chats/:id/messages` is served as a
 * static NDJSON body, which is all the page's parser needs — it splits the
 * body on newlines and reads one JSON event per line (docs/CHAT.md §3).
 *
 * The URL patterns are anchored regexes on the path because the API base is a
 * build-time variable: the same spec has to match `/api/chats` on this origin
 * and `http://localhost:3001/api/chats` on a build pointed at the dev server
 * (a `**` glob does not match a URL with a `//` in it).
 */

const ME = { username: 'dev-admin', role: 'admin', csrfToken: 'test-csrf-token' }

const CHAT = {
  id: 1,
  title: 'what do we hold on Shelby County?',
  createdAt: '2026-09-23T10:00:00.000Z',
  updatedAt: '2026-09-23T10:00:00.000Z',
}

const CITATION = {
  n: 1,
  slug: 'parcels',
  kind: 'dataset',
  title: 'Shelby parcels',
  href: '/library/parcels',
  snippet: 'One row per parcel, with owner and acreage.',
  cited: true,
}

const PROPOSAL = {
  id: 'action-1',
  tool: 'create_note',
  kind: 'write',
  status: 'proposed',
  summary: 'Write a note “Shelby follow-up”',
  args: { title: 'Shelby follow-up', body: 'Three parcels, two wooded.' },
}

/** One event per line, in the order the server would flush them. */
const ANSWER_STREAM = [
  { type: 'tool_call', phase: 'started', call: { id: 'call-1', tool: 'search_library', kind: 'read', status: 'running', summary: 'Searched the library for “Shelby County”' } },
  { type: 'tool_call', phase: 'finished', call: { id: 'call-1', tool: 'search_library', kind: 'read', status: 'done', summary: 'Searched the library for “Shelby County” · 6 results' } },
  { type: 'text', text: 'We hold three parcels in Shelby County [1].' },
  { type: 'proposed_action', action: PROPOSAL },
  { type: 'citations', citations: [CITATION] },
  { type: 'done', chatId: 1, messageId: 9, userMessageId: 8 },
]
  .map(event => JSON.stringify(event))
  .join('\n')
  .concat('\n')

describe('chat with the library (stubbed API)', () => {
  beforeEach(() => {
    cy.intercept('GET', /\/api\/me$/, { statusCode: 200, body: ME }).as('me')
    cy.intercept('GET', /\/api\/chats$/, { statusCode: 200, body: { chats: [] } }).as('threads')
    cy.intercept('POST', /\/api\/chats$/, { statusCode: 201, body: { chat: CHAT } }).as('newChat')
    cy.intercept('GET', /\/api\/chats\/1$/, { statusCode: 200, body: { chat: CHAT, messages: [] } }).as('thread')
    cy.intercept('POST', /\/api\/chats\/1\/messages$/, {
      statusCode: 200,
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
      body: ANSWER_STREAM,
    }).as('send')
    cy.intercept('POST', /\/api\/chats\/1\/actions\/action-1\/confirm$/, {
      statusCode: 200,
      body: {
        action: { ...PROPOSAL, status: 'confirmed', result: { slug: 'shelby-follow-up', href: '/library/shelby-follow-up' } },
        message: {
          id: 20,
          role: 'tool',
          text: 'Write a note “Shelby follow-up” — done.\n{"slug":"shelby-follow-up"}',
          toolCalls: [{ ...PROPOSAL, status: 'confirmed' }],
          citations: [],
          createdAt: '2026-09-23T10:05:00.000Z',
        },
      },
    }).as('confirm')
  })

  it('starts a conversation, gets a cited answer, and runs the write it proposes', () => {
    cy.visit('/chat')
    cy.wait('@threads')

    // Nothing yet: the page says so and offers the one thing to do.
    cy.get('[data-testid="chat-threads-empty"]').should('contain', 'No conversations yet')
    cy.get('[data-testid="chat-new"]').click()
    cy.wait('@newChat')
    cy.get('[data-testid="chat-thread"]').should('have.length', 1)

    // Enter sends (Shift+Enter would newline).
    cy.get('[data-testid="chat-input"]').type('what do we hold on Shelby County?{enter}')
    cy.wait('@send')

    cy.get('[data-testid="chat-user-text"]').should('have.text', 'what do we hold on Shelby County?')
    cy.get('[data-testid="chat-answer"]').should('contain', 'three parcels in Shelby County')

    // The tool call is one collapsed line that opens.
    cy.get('[data-testid="chat-tool-summary"]').should('contain', '6 results').click()
    cy.get('[data-testid="chat-tool-detail"]').should('contain', 'search_library')

    // Citations read as they do on Ask.
    cy.get('[data-testid="chat-citations"]').should('contain', 'Where this came from')
    cy.get('[data-testid="chat-citation"]').should('contain', 'Shelby parcels')
    cy.get('[data-testid="chat-citation"] a').should('have.attr', 'href', '/library/parcels')

    // The write is a proposal: its arguments are shown and nothing has run.
    cy.get('[data-testid="chat-proposal"]').should('contain', 'The assistant wants to:')
    cy.get('[data-testid="chat-proposal-args"]').should('contain', 'Shelby follow-up')
    cy.get('[data-testid="chat-proposal-run"]').click()
    cy.wait('@confirm')

    cy.get('[data-testid="chat-proposal-done"]').should('contain', 'Done.')
    cy.get('[data-testid="chat-outcome"]').should('contain', 'Write a note “Shelby follow-up” — done.')

    // P6-10's slot is reserved but empty in this phase.
    cy.get('[data-testid="chat-pane"]').should('not.exist')
  })

  it('leaves a proposal unrun when it is dismissed', () => {
    cy.visit('/chat')
    cy.wait('@threads')
    cy.get('[data-testid="chat-new"]').click()
    cy.wait('@newChat')
    cy.get('[data-testid="chat-input"]').type('note that down{enter}')
    cy.wait('@send')

    cy.get('[data-testid="chat-proposal-dismiss"]').click()
    cy.get('[data-testid="chat-proposal-dismissed"]').should('contain', 'Left unrun')
    cy.get('@confirm.all').should('have.length', 0)
  })
})

describe('chat is internal-only', () => {
  it('bounces a logged-out visit to /chat to the login page', () => {
    // No /api/me stub: boot hydration settles as logged out.
    cy.visit('/chat')
    cy.location('pathname').should('eq', '/login')
    cy.location('search').should('contain', 'redirect=')
  })
})
