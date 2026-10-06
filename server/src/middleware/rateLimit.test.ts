import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { subnetKey, oauthRegisterRateLimit, resetOAuthRateLimits } from './rateLimit.js'

/**
 * P5-51 security review, finding 2: the OAuth limiters are the only
 * unauthenticated write surface on this API, and a per-ADDRESS key is free to
 * defeat over IPv6 — a single subscriber is routinely handed a /64, which is
 * 18 quintillion keys. subnetKey collapses that to one bucket.
 */

describe('subnetKey', () => {
  it('keys an IPv4 address on itself — there is no slack to collapse', () => {
    expect(subnetKey('203.0.113.7')).toBe('203.0.113.7')
  })

  it('unwraps an IPv4-mapped IPv6 address (what a dual-stack socket reports)', () => {
    expect(subnetKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(subnetKey('::FFFF:203.0.113.7')).toBe('203.0.113.7')
  })

  it('collapses every address in one IPv6 /64 to a single bucket', () => {
    const a = subnetKey('2001:db8:1234:5678:0000:0000:0000:0001')
    const b = subnetKey('2001:db8:1234:5678:ffff:ffff:ffff:ffff')
    expect(a).toBe(b)
    // A neighbouring /64 is a different subscriber and a different bucket.
    expect(subnetKey('2001:db8:1234:5679::1')).not.toBe(a)
  })

  it('reads compressed and expanded spellings of one address the same way', () => {
    expect(subnetKey('2001:db8::1')).toBe(subnetKey('2001:0db8:0000:0000:0000:0000:0000:0002'))
    expect(subnetKey('::1')).toBe(subnetKey('0000:0000:0000:0000:0000:0000:0000:0001'))
    expect(subnetKey('2001:DB8::1')).toBe(subnetKey('2001:db8::9'))
  })

  it('handles an IPv6 address with an embedded IPv4 tail', () => {
    // 2001:db8::13.1.68.3 is 2001:db8::0d01:4403 — same /64 as 2001:db8::1.
    expect(subnetKey('2001:db8::13.1.68.3')).toBe(subnetKey('2001:db8::1'))
  })

  it('drops a zone identifier rather than treating it as a separate subnet', () => {
    expect(subnetKey('fe80::1%eth0')).toBe(subnetKey('fe80::2'))
  })

  it('never returns an empty key: a missing or unparseable address gets its own bucket', () => {
    expect(subnetKey(undefined)).toBe('unknown')
    expect(subnetKey('')).toBe('unknown')
    expect(subnetKey('not-an-address')).toBe('not-an-address')
  })
})

describe('the OAuth limiters key on the subnet', () => {
  it('counts two addresses in one IPv6 /64 against the same registration budget', async () => {
    await resetOAuthRateLimits()
    const app = express()
    app.set('trust proxy', true)
    app.post('/oauth/register', oauthRegisterRateLimit, (_req, res) => {
      res.status(201).json({ ok: true })
    })

    // Ten registrations spread over ten addresses in one /64 — under a
    // per-address key this would be ten fresh budgets.
    let last = 0
    for (let i = 0; i < 11; i++) {
      last = (
        await request(app)
          .post('/oauth/register')
          .set('X-Forwarded-For', `2001:db8:abcd:1234::${i + 1}`)
          .send({})
      ).status
    }
    expect(last).toBe(429)

    // A different /64 still has its own budget.
    const other = await request(app)
      .post('/oauth/register')
      .set('X-Forwarded-For', '2001:db8:abcd:9999::1')
      .send({})
    expect(other.status).toBe(201)
    await resetOAuthRateLimits()
  })
})
