/**
 * The browser-origin allowlist, in one place.
 *
 * Extracted from app.ts's CORS delegate because CORS is not the only caller:
 * POST /api/login runs the same check itself as its login-CSRF control. A
 * single implementation means loosening CORS can never silently loosen the
 * login gate (or vice versa).
 *
 * ALLOWED_ORIGINS is read on every call, not captured at import time, so
 * tests (and a future reload) see the current value.
 */

/** Just enough of an Express request to decide same-origin. */
interface HostBearing {
  headers: { host?: string | undefined }
}

export function isAllowedOrigin(origin: string, req: HostBearing): boolean {
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean)
  if (allowed.includes(origin)) return true

  // Same-origin: the /dashboard page fetching /api/* on its own host. Its
  // origin is never in ALLOWED_ORIGINS, but it is trusted by definition.
  // A missing Host header (or an unparseable Origin, including the literal
  // "null" a sandboxed iframe sends) can never match.
  const host = req.headers.host
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}
