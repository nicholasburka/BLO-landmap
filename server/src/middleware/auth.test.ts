import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'

// Secret must exist before the module's functions run.
process.env.SESSION_HMAC_SECRET = 'test-secret-0123456789abcdef0123456789abcdef'

const { createToken, validateToken, requireAuthEnv } = await import('./auth.js')

describe('token roundtrip', () => {
  it('accepts a freshly minted normal token', () => {
    const result = validateToken(createToken())
    expect(result).toEqual({ valid: true, tier: 'normal' })
  })

  it('accepts a staging token and preserves the tier', () => {
    const result = validateToken(createToken('staging'))
    expect(result).toEqual({ valid: true, tier: 'staging' })
  })
})

describe('tampering', () => {
  it('rejects a token whose tier was flipped to staging', () => {
    const token = createToken('normal')
    const [payload, signature] = token.split('.')
    const body = Buffer.from(payload, 'base64').toString()
    const forgedBody = body.replace('.normal', '.staging')
    const forgedPayload = Buffer.from(forgedBody).toString('base64')
    const result = validateToken(`${forgedPayload}.${signature}`)
    expect(result.valid).toBe(false)
  })

  it('rejects a token signed with a different secret', () => {
    const token = createToken('staging')
    const [payload] = token.split('.')
    const body = Buffer.from(payload, 'base64').toString()
    const wrongSig = createHmac('sha256', 'blo-session-default').update(body).digest('hex')
    expect(validateToken(`${payload}.${wrongSig}`).valid).toBe(false)
  })

  it('rejects garbage tokens', () => {
    expect(validateToken('').valid).toBe(false)
    expect(validateToken('abc').valid).toBe(false)
    expect(validateToken('a.b.c').valid).toBe(false)
    expect(validateToken('not-base64.deadbeef').valid).toBe(false)
  })
})

describe('expiry', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects a token older than 24 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    const token = createToken()
    vi.setSystemTime(new Date('2026-07-02T00:00:01Z'))
    expect(validateToken(token).valid).toBe(false)
  })

  it('accepts a token within 24 hours', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    const token = createToken()
    vi.setSystemTime(new Date('2026-07-01T23:59:00Z'))
    expect(validateToken(token).valid).toBe(true)
  })
})

describe('requireAuthEnv', () => {
  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('exits when the secret is missing or short', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const saved = process.env.SESSION_HMAC_SECRET
    process.env.SESSION_HMAC_SECRET = 'too-short'
    requireAuthEnv()
    expect(exit).toHaveBeenCalledWith(1)
    process.env.SESSION_HMAC_SECRET = saved
    exit.mockRestore()
  })

  it('passes with a strong secret', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    requireAuthEnv()
    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})
