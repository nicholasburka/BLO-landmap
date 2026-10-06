/**
 * Resolved API base URL, shared by useChat and useAuth.
 *
 * VITE_API_URL wins when set. In dev we fall back to the local server;
 * in a production build with no env var there is nothing sane to fall
 * back to, so we export '' and log loudly. Callers must treat an empty
 * base as "AI features aren't configured" and fail fast instead of
 * fetching a dead localhost URL.
 */

export const API_URL: string = (() => {
  const configured = import.meta.env.VITE_API_URL
  if (configured) return configured
  if (import.meta.env.DEV) return 'http://localhost:3001'
  // eslint-disable-next-line no-console
  console.error(
    '[apiBase] VITE_API_URL is not set in this production build — ' +
      'AI features are disabled. Set VITE_API_URL at build time.',
  )
  return ''
})()

/**
 * CSRF token for the internal library session (P5-4). Set by useAuth after
 * login (and refreshed from GET /api/me on hard reload); cleared on logout.
 * Module-level because every internal API caller shares one session.
 */
let internalCsrfToken: string | null = null

export function setInternalCsrfToken(token: string | null): void {
  internalCsrfToken = token
}

// ---------------------------------------------------------------------------
// Expired sessions (P5-72)
// ---------------------------------------------------------------------------

/**
 * What to do when the session behind an internal call has gone: clear the
 * local auth state and send the person to the login page, which brings them
 * back afterwards. Registered once by the router (the only place that has
 * both the session and a way to navigate); this module stays ignorant of both.
 */
export type SessionExpiredHandler = (loginPath: string) => void

let sessionExpiredHandler: SessionExpiredHandler | null = null

export function setSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler
}

/**
 * The session endpoints. A 401 from these is an answer, not an expiry:
 * GET /api/me is how boot asks "am I logged in?", and the login and logout
 * calls speak for themselves. Redirecting on those is how you build a loop.
 */
const SESSION_PATHS = new Set(['/api/me', '/api/login', '/api/logout'])

/** One redirect per expiry, however many requests were in flight when the
 *  session went. Cleared by the next internal call that succeeds — signing
 *  back in re-arms the handler without anyone resetting anything. */
let redirectSent = false

/** Test seam: reset the module's memory of a redirect between cases. */
export function resetSessionExpiry(): void {
  redirectSent = false
}

function handleExpiredSession(path: string): void {
  if (redirectSent || SESSION_PATHS.has(path.split('?')[0])) return
  // Already on the login page: the 401 is the page doing its job.
  const here = `${window.location.pathname}${window.location.search}`
  if (window.location.pathname === '/login') return
  redirectSent = true
  sessionExpiredHandler?.(`/login?redirect=${encodeURIComponent(here)}`)
}

/**
 * fetch() wrapper for internal (library) API calls: always sends the
 * httpOnly session cookie, and attaches X-CSRF-Token on mutating methods.
 *
 * A 401 means the session expired under the page (P5-72) — every internal
 * caller used to surface that as the word "Unauthorized" — so it is handled
 * here, once, rather than in twenty catch blocks. The response is still
 * returned: the caller's own error path runs as it always did.
 */
export async function internalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== 'GET' && method !== 'HEAD' && internalCsrfToken) {
    headers.set('X-CSRF-Token', internalCsrfToken)
  }
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include' })
  if (res.status === 401) handleExpiredSession(path)
  else if (res.ok) redirectSent = false
  return res
}
