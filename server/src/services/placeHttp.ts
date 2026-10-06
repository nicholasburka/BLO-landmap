import { promises as dns } from 'node:dns'
import { isPublicHost, type LookupFn } from '../cli/fetchLink.js'

/**
 * The one way P5-57 talks to the outside world.
 *
 * Every adapter (and the geocoder behind them) sends its requests through
 * `guardedGet`. The URLs come from manifests a teammate hand-typed and from a
 * place a person typed into a box, so they are treated exactly like the
 * dropped links of P5-47: http(s) only, every hop re-checked against the host
 * guard so a redirect cannot walk us into this network, a hard timeout, and a
 * byte cap enforced on both the declared length and the bytes that arrive.
 *
 * It reads into memory rather than to a temp file (P5-47's `fetchToTemp`)
 * because a slice is small by construction — a page of features, a county's
 * rows — and the caller parses it immediately. The one big read (a whole CSV
 * for the `download` adapter) is what the byte cap is sized for.
 */

/** How long one request may take. 30 s: an ArcGIS envelope query against a
 *  national layer is slow, and a person is waiting. */
export function placeFetchTimeoutMs(): number {
  const raw = Number(process.env.PLACE_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000
}

/** Most a single response may weigh. 25 MB is a generous county CSV and a
 *  long way short of anything that would hurt the box the map shares. */
export function placeFetchMaxBytes(): number {
  const raw = Number(process.env.PLACE_FETCH_MAX_BYTES)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25 * 1024 * 1024
}

/** Requests one source may make in a minute, from this process. Politeness to
 *  a public agency's server first, a brake on a runaway loop second. */
export const RATE_LIMIT_PER_MINUTE = 30
export const MAX_REDIRECTS = 5

/** Why a fetch for a place failed, in a form the route and the panel turn into
 *  plain words without matching on message text. */
export type PlaceFetchFailure =
  | 'bad-scheme'
  | 'not-public'
  | 'too-many-redirects'
  | 'http-error'
  | 'too-large'
  | 'timeout'
  | 'network'
  | 'rate-limited'
  | 'bad-response'
  | 'no-endpoint'
  | 'manual-only'
  | 'bad-place'

export class PlaceFetchError extends Error {
  code: PlaceFetchFailure
  constructor(message: string, code: PlaceFetchFailure) {
    super(message)
    this.name = 'PlaceFetchError'
    this.code = code
  }
}

/** What a reader is told. Never the URL, the host or the status line — those
 *  are for the log; this is the sentence under the Run button. */
export const FAILURE_TEXT: Record<PlaceFetchFailure, string> = {
  'bad-scheme': 'that endpoint is not a web address we can call.',
  'not-public': 'that endpoint is not a public address, so we did not call it.',
  'too-many-redirects': 'that endpoint kept redirecting us somewhere else.',
  'http-error': 'the agency’s server refused the request.',
  'too-large': 'the answer was too big to hold here — narrow the place and try again.',
  timeout: 'the agency’s server took too long. Try a smaller radius.',
  network: 'we could not reach the agency’s server.',
  'rate-limited': 'we have asked this source a lot in the last minute — wait a moment and try again.',
  'bad-response': 'the agency’s server answered with something we could not read.',
  'no-endpoint': 'this source has no endpoint we can query — open it by hand.',
  'manual-only': 'this source is spreadsheets and phone calls only — open it by hand.',
  'bad-place': 'we could not find that place.',
}

export function failureText(code: PlaceFetchFailure): string {
  return FAILURE_TEXT[code] ?? FAILURE_TEXT.network
}

// --- Per-source rate limit ---------------------------------------------------

/** Timestamps of recent requests, per source slug. In-memory and per process,
 *  like every other limiter here (DEPLOY.md's scaling note applies). */
const recentBySource = new Map<string, number[]>()

/** Records one request against a source and says whether it may go. */
export function takeRateToken(source: string, now: number = Date.now()): boolean {
  const window = now - 60_000
  const hits = (recentBySource.get(source) ?? []).filter(t => t > window)
  if (hits.length >= RATE_LIMIT_PER_MINUTE) {
    recentBySource.set(source, hits)
    return false
  }
  hits.push(now)
  recentBySource.set(source, hits)
  return true
}

/** Tests and the process's own hygiene — nothing in a request path calls it. */
export function resetRateLimits(): void {
  recentBySource.clear()
}

// --- The guarded request -----------------------------------------------------

export interface GuardedGetOptions {
  fetchImpl?: typeof fetch
  lookup?: LookupFn
  maxBytes?: number
  timeoutMs?: number
  headers?: Record<string, string>
  /** Source slug the request is charged to. Omit to skip the per-source limit
   *  (the geocoder, which is not a source). */
  source?: string
  /**
   * P5-59 probe mode: stop reading at the cap and SAY SO, instead of failing.
   * An inspection wants the first bytes of a file to name its columns; the
   * file itself may be 400 MB, and "too big to read" is the wrong answer to
   * "what is this?".
   */
  truncate?: boolean
  /** HEAD when the content type and the declared length are the whole answer.
   *  Falls back to nothing clever: a server that refuses HEAD is retried with
   *  a ranged GET by the caller, not here. */
  method?: 'GET' | 'HEAD'
}

export interface GuardedGetResult {
  body: string
  contentType: string
  finalUrl: URL
  bytes: number
  /** P5-59: true when `truncate` stopped the read at the cap — the body is a
   *  prefix of the resource, not the resource. */
  truncated?: boolean
  /** P5-59: what the server said it was sending, when it said anything. */
  contentLength?: number
  /** P5-59: the raw `content-range`, so a ranged probe can report the size of
   *  the WHOLE file rather than of the slice it read. */
  contentRange?: string
  status: number
}

/**
 * GET one URL under the guard and return its body as text.
 *
 * Redirects are followed by hand so every hop is checked — `redirect: 'follow'`
 * would hand the whole chain to undici and let hop two land on 169.254.169.254.
 */
export async function guardedGet(url: URL, options: GuardedGetOptions = {}): Promise<GuardedGetResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const lookup = options.lookup ?? dns.lookup
  const maxBytes = options.maxBytes && options.maxBytes > 0 ? options.maxBytes : placeFetchMaxBytes()
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : placeFetchTimeoutMs()

  if (options.source && !takeRateToken(options.source)) {
    throw new PlaceFetchError(`rate limit for "${options.source}": more than ${RATE_LIMIT_PER_MINUTE} requests a minute`, 'rate-limited')
  }

  let current = url
  for (let hop = 0; ; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') {
      throw new PlaceFetchError(`refusing to fetch a non-http(s) url: ${current.protocol}`, 'bad-scheme')
    }
    if (!(await isPublicHost(current.hostname, lookup))) {
      throw new PlaceFetchError(`refusing to fetch ${current.hostname}: not a public host`, 'not-public')
    }
    let res: Response
    try {
      res = await fetchImpl(current.toString(), {
        ...(options.method ? { method: options.method } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json, text/csv, */*', ...(options.headers ?? {}) },
      })
    } catch (err: any) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      throw new PlaceFetchError(
        timedOut ? `no answer within ${Math.round(timeoutMs / 1000)}s` : `could not reach ${current.hostname}: ${err?.message || err}`,
        timedOut ? 'timeout' : 'network',
      )
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new PlaceFetchError(`too many redirects (more than ${MAX_REDIRECTS})`, 'too-many-redirects')
      await res.body?.cancel().catch(() => {})
      current = new URL(location, current)
      continue
    }
    if (!res.ok) throw new PlaceFetchError(`request failed: HTTP ${res.status}`, 'http-error')

    const declared = Number(res.headers.get('content-length'))
    // In probe mode an oversize resource is a FACT about it, not a failure —
    // the size is exactly what the reader wants to be told.
    if (!options.truncate && Number.isFinite(declared) && declared > maxBytes) {
      throw new PlaceFetchError(`answer is ${declared} bytes — over the ${maxBytes}-byte cap`, 'too-large')
    }
    const read =
      options.method === 'HEAD'
        ? { body: '', truncated: false }
        : await readCapped(res, maxBytes, options.truncate === true)
    return {
      body: read.body,
      contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(),
      finalUrl: current,
      bytes: Buffer.byteLength(read.body),
      ...(read.truncated ? { truncated: true } : {}),
      ...(Number.isFinite(declared) && declared >= 0 ? { contentLength: declared } : {}),
      ...(res.headers.get('content-range') ? { contentRange: res.headers.get('content-range') as string } : {}),
      status: res.status,
    }
  }
}

/** Read the body, stopping the moment it goes over the cap rather than after —
 *  a server that lies about content-length must not be able to fill memory.
 *  `truncate` turns the overrun from a failure into a flagged short read. */
async function readCapped(res: Response, maxBytes: number, truncate = false): Promise<{ body: string; truncated: boolean }> {
  const stream = res.body as unknown as AsyncIterable<Uint8Array> | null
  if (!stream || typeof (stream as any)[Symbol.asyncIterator] !== 'function') {
    // A fake or a polyfill without an iterable body: text() is all there is,
    // so the cap is checked once, after.
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) {
      if (!truncate) throw new PlaceFetchError(`answer exceeded the ${maxBytes}-byte cap`, 'too-large')
      // Slicing by characters would split a multi-byte sequence; go through
      // the buffer and let the decoder drop the trailing partial character.
      return { body: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true }
    }
    return { body: text, truncated: false }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += chunk.byteLength
    if (size > maxBytes) {
      if (!truncate) {
        await (res.body as any)?.cancel?.().catch(() => {})
        throw new PlaceFetchError(`answer exceeded the ${maxBytes}-byte cap`, 'too-large')
      }
      chunks.push(Buffer.from(chunk))
      await (res.body as any)?.cancel?.().catch(() => {})
      return { body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated: true }
    }
    chunks.push(Buffer.from(chunk))
  }
  return { body: Buffer.concat(chunks).toString('utf8'), truncated: false }
}

/** JSON from a guarded GET. A body that is not JSON is a `bad-response`, not a
 *  crash — public endpoints answer with HTML error pages more often than not. */
export async function guardedJson<T = unknown>(url: URL, options: GuardedGetOptions = {}): Promise<T> {
  const { body } = await guardedGet(url, options)
  try {
    return JSON.parse(body) as T
  } catch {
    throw new PlaceFetchError(`expected JSON from ${url.hostname}, got ${body.slice(0, 40)}…`, 'bad-response')
  }
}
