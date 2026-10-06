import rateLimit, { MemoryStore } from 'express-rate-limit'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * The rate-limit bucket for one caller (P5-51 security review, finding 2).
 *
 * WHY not the address: an IPv6 subscriber is routinely handed a whole /64 —
 * 18 quintillion addresses — so a per-address key on an unauthenticated
 * endpoint is a limit anyone with IPv6 can walk straight past. The first four
 * hextets are that /64, and everything below it is the same subscriber. IPv4
 * has no such slack, so there the address IS the key.
 *
 * express-rate-limit 7.5.1 ships no `ipKeyGenerator` helper (it arrives in
 * v8), which is why this lives here rather than being imported.
 */
export function subnetKey(ip: string | undefined): string {
  // A zone id (fe80::1%eth0) names an interface, not a network: two zones are
  // the same subnet and must not buy two budgets.
  const raw = (ip ?? '').trim().split('%')[0]
  if (!raw) return 'unknown'
  // A dual-stack socket reports IPv4 peers as ::ffff:203.0.113.7. That is one
  // IPv4 host, not a /64 of them.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw)
  if (mapped && isIPv4(mapped[1])) return mapped[1]
  if (isIPv4(raw)) return raw
  // Anything we cannot parse keys on itself: sharing one bucket between every
  // unparseable value would let one bad address deny service to the others.
  if (!isIPv6(raw)) return raw
  return `${expandIPv6(raw).slice(0, 4).join(':')}::/64`
}

/** Normalise an IPv6 address to eight lower-case hextets with no leading
 *  zeros, so every spelling of one address produces one key. */
function expandIPv6(address: string): string[] {
  let value = address.toLowerCase()
  // A trailing dotted-quad (2001:db8::13.1.68.3) is two hextets.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value)
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number)
    value = `${value.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tailPart] = value.split('::')
  const left = head ? head.split(':').filter(Boolean) : []
  const right = tailPart ? tailPart.split(':').filter(Boolean) : []
  const gap = value.includes('::') ? Math.max(0, 8 - left.length - right.length) : 0
  const hextets = [...left, ...Array.from({ length: gap }, () => '0'), ...right]
  return hextets.map(h => h.replace(/^0+(?=.)/, ''))
}

/** The key every unauthenticated OAuth limiter uses. */
const oauthKey = (req: { ip?: string }) => subnetKey(req.ip)

export const queryRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
})

/** Strict limit on the password endpoint — this is the brute-force surface. */
export const authRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a minute.' },
})

/** Internal login brute-force gate: 10 attempts/hour/IP (phase 5). A
 *  factory rather than an instance so tests get isolated limiters. */
export function makeInternalLoginRateLimit() {
  return rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
  })
}

/** Anonymous session mint — one per pageload in normal use, so a low
 *  ceiling costs legitimate users nothing but stops token-mint floods. */
export const sessionRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
})

/**
 * OAuth token/revocation endpoint (P5-51). Unauthenticated by definition — a
 * client presents a code or a refresh token, not a session — so the address
 * is the only key available. 60/min is far above a real connector (one
 * exchange per authorization, one refresh an hour) and far below what makes
 * guessing a 256-bit code worth attempting.
 */
const oauthTokenStore = new MemoryStore()
export const oauthTokenRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  store: oauthTokenStore,
  keyGenerator: oauthKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'invalid_request', error_description: 'Too many requests. Please wait a moment.' },
})

/**
 * Dynamic client registration (RFC 7591) is open by design, which makes it
 * the one endpoint an anonymous caller can use to write rows. 10/hour/IP: a
 * person sets up a connector once, and a table full of junk clients is the
 * only damage this endpoint can do.
 */
const oauthRegisterStore = new MemoryStore()
export const oauthRegisterRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  store: oauthRegisterStore,
  keyGenerator: oauthKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'invalid_request', error_description: 'Too many registrations. Please try again later.' },
})

/** Drop both OAuth buckets. For tests, which share one process and one store
 *  across every case — an hour-long registration window otherwise leaks from
 *  one test into the next. */
export async function resetOAuthRateLimits(): Promise<void> {
  await oauthTokenStore.resetAll()
  await oauthRegisterStore.resetAll()
  await oauthAuthorizeStore.resetAll()
}

/**
 * The browser-facing authorize/consent endpoints (P5-51). Lower value to an
 * attacker than the token endpoint, but `GET /oauth/authorize` writes a row
 * (the parked request) before anyone has logged in, so an unauthenticated
 * flood is a storage problem if nothing caps it. 30/min/IP is far above a
 * human clicking Allow and far below a useful flood; the rows also carry a
 * 10-minute TTL and are pruned at boot.
 */
const oauthAuthorizeStore = new MemoryStore()
export const oauthAuthorizeRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  store: oauthAuthorizeStore,
  keyGenerator: oauthKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'invalid_request', error_description: 'Too many requests. Please wait a moment.' },
})
