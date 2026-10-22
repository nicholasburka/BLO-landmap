/**
 * When the public map's welcome overlay may appear (P15-3).
 *
 * Its own module rather than a few `if`s inside `Map.vue`, because the rule
 * that matters here is a rule about NOT appearing, and that is the half
 * nobody notices is missing. The card this replaces checked one thing —
 * localStorage — and so a first-time visitor opening a shared
 * `/?layers=…&fit=…` link got a welcome screen over the answer they had been
 * sent. The e2e suite pressed "Got it" before every interaction to work
 * around it, which is a test accommodating a bug.
 */

/**
 * A NEW key, deliberately. `blo:welcomeDismissed` belongs to the 320px card
 * being deleted; reusing it would hide this overlay from every visitor who
 * ever dismissed that card — which is exactly the returning audience this
 * exists to re-orient.
 */
export const WELCOME_KEY = 'blo:welcome:v2'

/** Which door of the welcome was pressed. The host owns what each means. */
export type WelcomeDoor = 'rankings' | 'ask' | 'measures'

/**
 * What the question door seeds into the prompt box, unsent.
 *
 * A region plus a constraint plus a top-N, because the placeholder's own
 * examples ("top 5 affordable counties") understate what the server will
 * take — it handles all three in one call (`chatPrompt.ts:36-68`). Teaching
 * the capability the placeholder does not is the whole reason the door is
 * there, so a bare example would waste it.
 */
export const SEED_QUESTION = 'top 10 affordable Southeast counties with high Black population'

/**
 * The conversation `useChat` restores, and the two gates it must clear first
 * (`useChat.ts:94-97`, `:398-426`): this schema version, and a 7-day window.
 *
 * Copied rather than imported, deliberately. `useChat` pulls in `useAuth`,
 * which mints an anonymous session with a `fetch` at import time
 * (`useAuth.ts:238`) — and this module is read on the public map's first
 * frame and by a unit test that must make no network calls. Three constants
 * are the cheaper copy; if the version or the window moves there, it moves
 * here, and `welcome.spec.ts` is what notices.
 */
const CONVERSATION_KEY = 'blo:conversation'
const CONVERSATION_VERSION = 1
const CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Params that mean "I was sent here to see something specific".
 *
 * `layers`, `focus` and `fit` are the public deep links (`mapDeepLinks.ts`);
 * `view` and `set` are read straight off the route by `Map.vue` and 401 for
 * a logged-out reader, but a visitor who followed one still asked for a
 * destination rather than for a welcome.
 */
const DESTINATION_PARAMS = ['layers', 'focus', 'fit', 'view', 'set'] as const

/** A localStorage read that cannot throw. Private mode denies access rather
 *  than returning null, and an onboarding screen is not worth an exception. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/**
 * Whether this browser has seen the overlay.
 *
 * Presence, not equality: the rule is "`blo:welcome:v2` is set" (P15-3), and
 * a browser carrying the key with some other value — a hand-edit, a later
 * writer that stores a timestamp — has still seen this screen. Testing for
 * the exact string would show it to them again.
 */
export function hasSeenWelcome(): boolean {
  return read(WELCOME_KEY) !== null
}

/** Records that it has been SEEN — not that it is hidden. Re-opening it
 *  later (P15-4) does not clear this, and dismissing again does not re-set
 *  it; the flag answers "is this a first visit", nothing more. */
export function markWelcomeSeen(): void {
  try {
    localStorage.setItem(WELCOME_KEY, '1')
  } catch {
    /* Private mode. They will see it again, which is the safe failure. */
  }
}

/** A query value as vue-router hands it over: absent, a string, or repeated. */
type QueryValue = string | null | (string | null)[] | undefined

export function hasDestination(query: Record<string, QueryValue>): boolean {
  return DESTINATION_PARAMS.some(param => {
    const value = query[param]
    if (Array.isArray(value)) return value.some(entry => typeof entry === 'string' && entry.length > 0)
    return typeof value === 'string' && value.length > 0
  })
}

/** One stored message, as far as this module needs to care. */
function isMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const role = (value as { role?: unknown }).role
  return role === 'user' || role === 'assistant'
}

/**
 * Whether a thread would actually be RESTORED from a previous visit.
 *
 * "Is there a conversation in localStorage" is the wrong question, and asking
 * it was a bug: `useChat` deletes the key and restores nothing unless it
 * carries this schema version, was saved inside the 7-day window, and holds
 * at least one well-formed message (`useChat.ts:398-426`). A three-week-old
 * thread is one nobody gets back — so suppressing the welcome for it left a
 * returning visitor with neither their conversation nor the screen that
 * explains the map. The spec's rule is "a conversation **was restored**".
 */
export function hasConversation(): boolean {
  const raw = read(CONVERSATION_KEY)
  if (!raw) return false
  try {
    const parsed = JSON.parse(raw) as
      | { v?: unknown; savedAt?: unknown; messages?: unknown }
      | null
    if (!parsed || typeof parsed !== 'object') return false
    if (parsed.v !== CONVERSATION_VERSION) return false
    if (typeof parsed.savedAt !== 'number') return false
    if (Date.now() - parsed.savedAt > CONVERSATION_TTL_MS) return false
    return Array.isArray(parsed.messages) && parsed.messages.some(isMessage)
  } catch {
    // Unparseable is not a conversation. Show the welcome.
    return false
  }
}

/**
 * The whole rule, in one place so a test can state it.
 *
 * Note what is NOT done here: a destination link does not mark the overlay
 * seen. They have not seen it, and a later bare visit should still show it.
 */
export function shouldShowWelcome(query: Record<string, QueryValue>): boolean {
  if (hasDestination(query)) return false
  if (hasSeenWelcome()) return false
  if (hasConversation()) return false
  return true
}
