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
