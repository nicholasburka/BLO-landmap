import { describe, it, expect } from 'vitest'
import request from 'supertest'

/**
 * P5-88: the two pieces of the middleware chain the internal pages now depend
 * on — gzip for JSON, and weak ETags so an unchanged answer is a 304.
 *
 * Both are asserted against the REAL createApp(), on routes that need no
 * store: a change to the chain's order (compression before the routers,
 * `etag` still on) shows up here rather than as a slow page.
 */

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-real'
process.env.SESSION_HMAC_SECRET =
  process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { createApp } = await import('./app.js')

const app = createApp()

describe('compression (P5-88)', () => {
  it('leaves a small JSON answer alone — below the threshold gzip costs more than it saves', async () => {
    const res = await request(app).get('/api/health').set('Accept-Encoding', 'gzip')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
    expect(res.headers['content-encoding']).toBeUndefined()
  })

  it('leaves a non-JSON answer alone, whatever its size', async () => {
    // The dashboard's script is ~5 KB of public JavaScript — well over the
    // threshold, and deliberately outside the filter: the file routes stream
    // their bytes and the CSV export writes its own, and neither wants a
    // middleware buffering them. Only JSON is compressed.
    const res = await request(app).get('/dashboard.js').set('Accept-Encoding', 'gzip')
    expect(res.status).toBe(200)
    expect(res.text.length).toBeGreaterThan(1024)
    expect(res.headers['content-encoding']).toBeUndefined()
  })
})

describe('ETags (P5-88)', () => {
  it('is configured for weak ETags, out loud rather than by default', () => {
    expect(app.get('etag')).toBe('weak')
  })

  it('answers 304 to a matching If-None-Match on any JSON route', async () => {
    const first = await request(app).get('/api/health')
    expect(first.headers.etag).toBeTruthy()
    const again = await request(app).get('/api/health').set('If-None-Match', first.headers.etag)
    expect(again.status).toBe(304)
    expect(again.text).toBeFalsy()
  })
})
