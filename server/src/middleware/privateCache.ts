import type { NextFunction, Request, Response } from 'express'

/**
 * Conditional-request headers for the read endpoints a page loads every time
 * (P5-88): the catalog list, one entry, the internal layer manifest and the
 * kb landing config.
 *
 * `private` — never a shared cache. Every one of these answers is behind the
 * internal session and differs per user's right to see it at all, so a proxy
 * or a CDN must not hold a copy.
 *
 * `no-cache` — the browser MAY keep the body, but must revalidate before
 * using it. Paired with the weak ETag `res.json` sets (see `app.set('etag')`),
 * an unchanged catalog costs a 304 with no body instead of 214 KB, and a
 * changed one is never served stale. `max-age` would be the wrong trade here:
 * the library changes when somebody files something, not on a clock, and a
 * list that lags a filing by even a minute reads as a bug.
 */
export function privateNoCache(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'private, no-cache')
  next()
}
