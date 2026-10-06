import { describe, it, expect, afterEach, vi } from 'vitest'
import { isAllowedOrigin } from './origins.js'

afterEach(() => vi.unstubAllEnvs())

const req = (host?: string) => ({ headers: { host } })

describe('isAllowedOrigin', () => {
  it('accepts a configured frontend origin (trimmed, comma-separated list)', () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example, https://staging.example')
    expect(isAllowedOrigin('https://app.example', req('api.example'))).toBe(true)
    expect(isAllowedOrigin('https://staging.example', req('api.example'))).toBe(true)
  })

  it('accepts a same-origin request (the /dashboard page calling its own host)', () => {
    vi.stubEnv('ALLOWED_ORIGINS', '')
    expect(isAllowedOrigin('https://api.example', req('api.example'))).toBe(true)
    expect(isAllowedOrigin('http://localhost:3001', req('localhost:3001'))).toBe(true)
  })

  it('rejects everything else, including malformed origins and a missing host', () => {
    vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example')
    expect(isAllowedOrigin('https://evil.example', req('api.example'))).toBe(false)
    expect(isAllowedOrigin('https://app.example.evil', req('api.example'))).toBe(false)
    expect(isAllowedOrigin('not a url', req('api.example'))).toBe(false)
    expect(isAllowedOrigin('null', req('api.example'))).toBe(false)
    expect(isAllowedOrigin('https://evil.example', req(undefined))).toBe(false)
  })
})
