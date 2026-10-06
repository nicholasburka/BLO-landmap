/**
 * Turning a thrown error into something worth reading (P5-72).
 *
 * Internal views used to render `err.message` verbatim, which is fine when
 * the server wrote the sentence ("This entry has no link to fetch.") and
 * terrible when it did not — a session that expires mid-page put the word
 * "Unauthorized" on screen, and a dropped Wi-Fi put "Failed to fetch".
 *
 * The API layer already does the right thing at the throw site: helpers like
 * `errorMessage(res, fallback)` in lib/libraryCatalog.ts and `failureOf(res)`
 * in lib/placeFetch.ts return the response body's `error` field when there is
 * one — a sentence written for users — and otherwise make up a technical
 * string carrying the status code. So the two are told apart here by the
 * shape those helpers give them: a made-up fallback ends in `(404)`, or is a
 * bare HTTP status word. Everything else that reads like a sentence is the
 * server talking to the person, and is passed through untouched.
 */

export const NETWORK_ERROR_MESSAGE = 'No connection — check your network and try again.'

/**
 * What `fetch()` rejects with when the request never reached the server:
 * "Failed to fetch" (Chrome), "NetworkError when attempting to fetch
 * resource." (Firefox), "Load failed" (Safari), "fetch failed" (undici).
 */
const NETWORK_MESSAGES = /^(failed to fetch|fetch failed|load failed|networkerror\b|network request failed)/i

/** The technical fallbacks the API helpers invent: "…failed (500)", possibly
 *  with a full stop after the code. */
const STATUS_SUFFIX = /\(\d{3}\)\s*\.?\s*$/

/** Bare status phrases, from the server or from a proxy in front of it.
 *  These are the ones that leak through as an "error message" with no
 *  sentence attached. */
const HTTP_PHRASES = new Set([
  'unauthorized',
  'forbidden',
  'not found',
  'bad request',
  'conflict',
  'gone',
  'payload too large',
  'unsupported media type',
  'too many requests',
  'internal server error',
  'not implemented',
  'bad gateway',
  'service unavailable',
  'gateway timeout',
  'method not allowed',
])

function messageOf(err: unknown): string {
  return err instanceof Error && typeof err.message === 'string' ? err.message.trim() : ''
}

/** A sentence someone wrote for a reader, rather than a string a program
 *  assembled: more than one word, no status code bolted on the end, and not
 *  one of the bare HTTP phrases. */
function isWrittenForPeople(message: string): boolean {
  if (!message || !/\s/.test(message)) return false
  if (STATUS_SUFFIX.test(message)) return false
  return !HTTP_PHRASES.has(message.replace(/[.!]+$/, '').toLowerCase())
}

/**
 * The sentence to show for `err`.
 *
 * - The server's own wording is kept — it is written for the reader, and
 *   expected refusals ("that fetch did not work. Try again, or a smaller
 *   radius.") must reach them word for word.
 * - A request that never left the building says so.
 * - Anything else is the caller's fallback: the view knows what the person
 *   was trying to do, and a status code does not help them.
 */
export function friendlyError(err: unknown, fallback: string): string {
  const message = messageOf(err)
  if (NETWORK_MESSAGES.test(message)) return NETWORK_ERROR_MESSAGE
  return isWrittenForPeople(message) ? message : fallback
}
