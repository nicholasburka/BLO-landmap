import { describe, it, expect, afterEach, vi } from 'vitest'
import { isPrivateNetworkHost, pgSslConfig, _resetPgSslWarning } from './pgSsl.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  _resetPgSslWarning()
})

describe('pgSslConfig', () => {
  it('verifies the server certificate by default', () => {
    vi.stubEnv('PGSSL_CA', '')
    vi.stubEnv('PGSSL_NO_VERIFY', '')
    expect(pgSslConfig()).toBe(true)
  })

  it('pins the CA from PGSSL_CA, unescaping literal \\n from flattened env values', () => {
    vi.stubEnv('PGSSL_CA', '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----')
    expect(pgSslConfig()).toEqual({ ca: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----' })
  })

  it('PGSSL_NO_VERIFY=1 disables verification and warns exactly once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('PGSSL_CA', '')
    vi.stubEnv('PGSSL_NO_VERIFY', '1')
    expect(pgSslConfig()).toEqual({ rejectUnauthorized: false })
    expect(pgSslConfig()).toEqual({ rejectUnauthorized: false })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('PGSSL_NO_VERIFY')
  })

  it('a pinned CA wins over PGSSL_NO_VERIFY', () => {
    vi.stubEnv('PGSSL_CA', 'PEM')
    vi.stubEnv('PGSSL_NO_VERIFY', '1')
    expect(pgSslConfig()).toEqual({ ca: 'PEM' })
  })

  it('warns when DATABASE_URL carries sslmode= (pg lets it override PGSSL_*)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('PGSSL_CA', 'PEM')
    pgSslConfig('postgres://u:p@db.example/app?sslmode=require')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('sslmode')
    // No PGSSL_* set → nothing to override → no noise.
    warn.mockClear()
    vi.stubEnv('PGSSL_CA', '')
    pgSslConfig('postgres://u:p@db.example/app?sslmode=require')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('private-network hosts (Railway internal)', () => {
  it('connects without TLS to a *.railway.internal host, and verifies everywhere else', () => {
    expect(isPrivateNetworkHost('postgresql://u:p@postgres.railway.internal:5432/railway')).toBe(true)
    expect(pgSslConfig('postgresql://u:p@postgres.railway.internal:5432/railway')).toBe(false)
    expect(isPrivateNetworkHost('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db')).toBe(false)
    expect(pgSslConfig('postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db')).toBe(true)
    expect(isPrivateNetworkHost('not a url')).toBe(false)
  })
})
