import { describe, it, expect } from 'vitest'
import { isForbiddenHostname, isPrivateAddress, literalIp } from './hostGuard.js'

/** SSRF guard shared by link drops (route) and the fetch CLI. */

describe('isForbiddenHostname', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'localhost.',
    'api.localhost',
    'db.internal',
    'printer.local',
    'nas.home.arpa',
    'a.b.home.arpa',
    '',
  ])('rejects reserved name %j', name => {
    expect(isForbiddenHostname(name)).toBe(true)
  })

  it.each(['example.org', 'data.census.gov', 'localhost.example.org', 'internal.example.org', 'my-local.example.org'])(
    'accepts public name %j',
    name => {
      expect(isForbiddenHostname(name)).toBe(false)
    },
  )
})

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', // IPv4-mapped
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('blocks %s', ip => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8'])(
    'allows public %s',
    ip => {
      expect(isPrivateAddress(ip)).toBe(false)
    },
  )
})

describe('literalIp', () => {
  it('returns the address for v4 and bracketed v6 hostnames, null for names', () => {
    expect(literalIp('127.0.0.1')).toBe('127.0.0.1')
    expect(literalIp('[::1]')).toBe('::1')
    expect(literalIp('[::ffff:7f00:1]')).toBe('::ffff:7f00:1')
    expect(literalIp('example.org')).toBeNull()
    expect(literalIp('[example.org]')).toBeNull()
  })
})
