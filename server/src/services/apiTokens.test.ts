import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { API_TOKEN_PREFIX, generateApiToken } from './apiTokens.js'
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX } from './oauthStore.js'

/**
 * P5-51 security review, finding 11. Personal tokens are `blo_<random>` and
 * OAuth tokens are `blo_at_<random>` / `blo_rt_<random>`, so a personal token
 * whose random body happened to start with `at_` or `rt_` would be routed to
 * the OAuth tables by getBearerPrincipal and could never authenticate. One in
 * 2^18 is rare enough never to be diagnosed and common enough to happen.
 */

/** A buffer that base64url-encodes to exactly `prefix` + padding. */
function bodyStartingWith(prefix: string): Buffer {
  const encoded = prefix + 'A'.repeat(43 - prefix.length)
  const buffer = Buffer.from(encoded, 'base64url')
  // Guard the fixture itself: the round trip must be exact, or the test would
  // be asserting nothing.
  expect(buffer.toString('base64url')).toBe(encoded)
  return buffer
}

describe('generateApiToken', () => {
  it('produces a prefixed 256-bit token', () => {
    const token = generateApiToken()
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
    expect(token.slice(API_TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateApiToken()).not.toBe(token)
  })

  it('draws again when the random body would collide with the OAuth namespace', () => {
    const draws = [bodyStartingWith('at_'), bodyStartingWith('rt_'), randomBytes(32)]
    let call = 0
    const token = generateApiToken(() => draws[call++])
    expect(call).toBe(3)
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false)
    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(false)
    expect(token.startsWith(API_TOKEN_PREFIX)).toBe(true)
  })

  it('gives up loudly rather than looping forever on a broken source of randomness', () => {
    expect(() => generateApiToken(() => bodyStartingWith('at_'))).toThrow(/random/i)
  })
})
