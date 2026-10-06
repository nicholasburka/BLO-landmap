import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { S3Client } from '@aws-sdk/client-s3'

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryBucket, closeLibraryBucket, getFile } = await import('../services/libraryBucket.js')
const { fetchLink, filenameFor, safeFilename, isPublicHost, normalizeContentType, MAX_REDIRECTS } = await import('./fetchLink.js')
const { FakeS3 } = await import('../testutils/fakeS3.js')

let fake: InstanceType<typeof FakeS3>
let dataDir: string

beforeEach(async () => {
  fake = new FakeS3()
  dataDir = await mkdtemp(join(tmpdir(), 'blo-fetch-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await closeLibraryBucket()
  await rm(dataDir, { recursive: true, force: true })
})

function fakeFetch(body: string, headers: Record<string, string> = { 'content-type': 'text/csv' }, status = 200): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch
}

/** Fake resolver: hostnames map to fixed addresses; unknown names are public. */
const ADDRESSES: Record<string, string[]> = {
  'evil.example': ['127.0.0.1'],
  'metadata.example': ['169.254.169.254'],
  'intranet.example': ['10.1.2.3'],
  'mixed.example': ['93.184.216.34', '192.168.0.9'],
  'v6loop.example': ['::1'],
  'nx.example': [],
}
const lookup = async (host: string) => (ADDRESSES[host] ?? ['93.184.216.34']).map(address => ({ address, family: address.includes(':') ? 6 : 4 }))

/** A fetch that records every URL it was asked for and answers by URL. */
function routingFetch(routes: Record<string, () => Response>): typeof fetch & { urls: string[]; inits: RequestInit[] } {
  const urls: string[] = []
  const inits: RequestInit[] = []
  const f = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    urls.push(url)
    inits.push(init ?? {})
    const handler = routes[url]
    if (!handler) throw new Error(`unexpected fetch of ${url}`)
    return handler()
  }
  return Object.assign(f as unknown as typeof fetch, { urls, inits })
}

const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } })
const csv = (body = 'id\n1\n') => () => new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } })

const META = { title: 'Parcels', category: '', status: 'needs-cataloging', tags: [], url: 'https://example.org/exports/parcels.csv?token=1', linkedBy: 'maria', originalFilename: null }

describe('filenames', () => {
  it('derives a bucket-safe name from the url path, falling back to the host + content-type extension', () => {
    expect(filenameFor(new URL('https://example.org/exports/County Parcels.csv'), null)).toBe('County-Parcels.csv')
    expect(filenameFor(new URL('https://example.org/download'), 'application/json; charset=utf-8')).toBe('download.json')
    expect(filenameFor(new URL('https://data.census.gov/'), 'application/pdf')).toBe('data.census.gov.pdf')
    expect(filenameFor(new URL('https://example.org/x.csv'), null, 'my file.csv')).toBe('my-file.csv')
    expect(safeFilename('../../meta.json')).toBe('download.bin')
  })

  it('falls back to the raw path segment when it is not valid percent-encoding', () => {
    expect(filenameFor(new URL('https://example.org/exports/bad%E0%A4%A.csv'), null)).toBe('bad-E0-A4-A.csv')
  })
})

describe('normalizeContentType', () => {
  it('keeps a well-formed type/subtype (lowercased, parameters stripped), else application/octet-stream', () => {
    expect(normalizeContentType('Text/CSV; charset=utf-8')).toBe('text/csv')
    expect(normalizeContentType('application/geo+json')).toBe('application/geo+json')
    expect(normalizeContentType(null)).toBe('application/octet-stream')
    expect(normalizeContentType('')).toBe('application/octet-stream')
    expect(normalizeContentType('text/html\r\nX-Injected: 1')).toBe('application/octet-stream')
    expect(normalizeContentType('not a type')).toBe('application/octet-stream')
    expect(normalizeContentType('text/')).toBe('application/octet-stream')
  })
})

describe('isPublicHost', () => {
  it('rejects reserved names and literal private addresses without resolving', async () => {
    const calls: string[] = []
    const spy = async (host: string) => (calls.push(host), lookup(host))
    for (const host of ['localhost', 'api.localhost', 'db.internal', '127.0.0.1', '[::1]', '169.254.169.254', '10.0.0.1']) {
      expect(await isPublicHost(host, spy), host).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('requires every resolved address to be public', async () => {
    expect(await isPublicHost('example.org', lookup)).toBe(true)
    expect(await isPublicHost('93.184.216.34', lookup)).toBe(true)
    for (const host of ['evil.example', 'metadata.example', 'intranet.example', 'mixed.example', 'v6loop.example', 'nx.example']) {
      expect(await isPublicHost(host, lookup), host).toBe(false)
    }
    expect(await isPublicHost('boom.example', async () => { throw new Error('ENOTFOUND') })).toBe(false)
  })
})

describe('fetchLink', () => {
  it('downloads the url into the entry folder, records content type + lineage, and leaves no temp file', async () => {
    fake.seed('library/incoming/abc/meta.json', JSON.stringify(META))
    const logs: string[] = []
    const result = await fetchLink('abc', { fetchImpl: fakeFetch('id,val\n1,2\n'), lookup, log: s => logs.push(s) })
    expect(result).toMatchObject({ key: 'library/incoming/abc/parcels.csv', size: 11, contentType: 'text/csv', reindexed: false })
    expect((await getFile('library/incoming/abc/parcels.csv')).toString()).toBe('id,val\n1,2\n')
    const meta = JSON.parse((await getFile('library/incoming/abc/meta.json', { fresh: true })).toString())
    expect(meta).toMatchObject({ originalFilename: 'parcels.csv', contentType: 'text/csv', size: 11, lineage: { from: 'https://example.org/exports/parcels.csv?token=1' } })
    expect(typeof meta.fetchedAt).toBe('string')
    expect(logs.some(l => /not reindexed/.test(l))).toBe(true)
  })

  it('honours --as, and fails cleanly on a missing entry, a fileless-url entry, or an HTTP error', async () => {
    fake.seed('library/incoming/abc/meta.json', JSON.stringify(META))
    const r = await fetchLink('abc', { as: 'parcels 2026.csv', fetchImpl: fakeFetch('x'), lookup, log: () => {} })
    expect(r.key).toBe('library/incoming/abc/parcels-2026.csv')
    await expect(fetchLink('nope', { fetchImpl: fakeFetch('x'), lookup, log: () => {} })).rejects.toThrow(/no incoming entry/)
    fake.seed('library/incoming/nourl/meta.json', JSON.stringify({ title: 'file drop', status: 'needs-review' }))
    await expect(fetchLink('nourl', { fetchImpl: fakeFetch('x'), lookup, log: () => {} })).rejects.toThrow(/no url/)
    fake.seed('library/incoming/gone/meta.json', JSON.stringify(META))
    await expect(fetchLink('gone', { fetchImpl: fakeFetch('', {}, 404), lookup, log: () => {} })).rejects.toThrow(/HTTP 404/)
  })

  it('refuses downloads over the cap by content-length', async () => {
    fake.seed('library/incoming/big/meta.json', JSON.stringify(META))
    await expect(fetchLink('big', { fetchImpl: fakeFetch('x', { 'content-length': String(500 * 1024 * 1024) }), lookup, log: () => {} })).rejects.toThrow(/cap/)
  })

  it('refuses private, loopback, link-local, and localhost targets before any fetch', async () => {
    for (const [slug, url] of [
      ['loop', 'http://127.0.0.1:8080/secrets'],
      ['loopname', 'http://evil.example/secrets'],
      ['meta', 'http://169.254.169.254/latest/meta-data/'],
      ['metaname', 'http://metadata.example/'],
      ['priv', 'http://10.0.0.5/'],
      ['privname', 'http://intranet.example/'],
      ['lh', 'http://localhost:3000/api/health'],
      ['v6', 'http://[::1]/'],
    ] as const) {
      fake.seed(`library/incoming/${slug}/meta.json`, JSON.stringify({ ...META, url }))
      const f = routingFetch({})
      await expect(fetchLink(slug, { fetchImpl: f, lookup, log: () => {} }), url).rejects.toThrow(/not a public host/)
      expect(f.urls, url).toEqual([])
    }
  })

  it('follows redirects manually, re-checking every hop, and stores the final body with lineage from the original url', async () => {
    fake.seed('library/incoming/r/meta.json', JSON.stringify({ ...META, url: 'https://example.org/start' }))
    const f = routingFetch({
      'https://example.org/start': redirect('/hop1'),
      'https://example.org/hop1': redirect('https://cdn.example.net/final/parcels.csv'),
      'https://cdn.example.net/final/parcels.csv': csv('id\n1\n'),
    })
    const r = await fetchLink('r', { fetchImpl: f, lookup, log: () => {} })
    expect(f.urls).toEqual(['https://example.org/start', 'https://example.org/hop1', 'https://cdn.example.net/final/parcels.csv'])
    // Every hop is fetched without automatic redirects and with a timeout.
    for (const init of f.inits) {
      expect(init.redirect).toBe('manual')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(r.key).toBe('library/incoming/r/parcels.csv')
    expect((await getFile('library/incoming/r/parcels.csv')).toString()).toBe('id\n1\n')
    const meta = JSON.parse((await getFile('library/incoming/r/meta.json', { fresh: true })).toString())
    expect(meta.lineage.from).toBe('https://example.org/start')
  })

  it('refuses a redirect to a private host, a non-http(s) scheme, or a chain longer than the cap', async () => {
    fake.seed('library/incoming/rp/meta.json', JSON.stringify({ ...META, url: 'https://example.org/start' }))
    const toPrivate = routingFetch({ 'https://example.org/start': redirect('http://127.0.0.1/admin') })
    await expect(fetchLink('rp', { fetchImpl: toPrivate, lookup, log: () => {} })).rejects.toThrow(/not a public host/)
    expect(toPrivate.urls).toEqual(['https://example.org/start'])

    fake.seed('library/incoming/rn/meta.json', JSON.stringify({ ...META, url: 'https://example.org/start' }))
    const toName = routingFetch({ 'https://example.org/start': redirect('https://intranet.example/x') })
    await expect(fetchLink('rn', { fetchImpl: toName, lookup, log: () => {} })).rejects.toThrow(/not a public host/)

    fake.seed('library/incoming/rs/meta.json', JSON.stringify({ ...META, url: 'https://example.org/start' }))
    const toFile = routingFetch({ 'https://example.org/start': redirect('file:///etc/passwd') })
    await expect(fetchLink('rs', { fetchImpl: toFile, lookup, log: () => {} })).rejects.toThrow(/non-http/)

    fake.seed('library/incoming/rl/meta.json', JSON.stringify({ ...META, url: 'https://example.org/0' }))
    const routes: Record<string, () => Response> = {}
    for (let i = 0; i <= MAX_REDIRECTS + 1; i++) routes[`https://example.org/${i}`] = redirect(`/${i + 1}`)
    const loop = routingFetch(routes)
    await expect(fetchLink('rl', { fetchImpl: loop, lookup, log: () => {} })).rejects.toThrow(/too many redirects/)
    expect(loop.urls.length).toBe(MAX_REDIRECTS + 1)
  })

  it('labels the stored object from the filename, not from the server that served it', async () => {
    fake.seed('library/incoming/ht/meta.json', JSON.stringify({ ...META, url: 'https://example.org/exports/report.csv' }))
    const f = routingFetch({
      'https://example.org/exports/report.csv': () => new Response('id\n1\n', { status: 200, headers: { 'content-type': 'text/html' } }),
    })
    const r = await fetchLink('ht', { fetchImpl: f, lookup, log: () => {} })
    expect(r.key).toBe('library/incoming/ht/report.csv')
    // The bucket labels bytes by the name they are stored under…
    expect(fake.contentTypes.get(r.key)).toBe('text/csv; charset=utf-8')
    // …while the remote server's claim survives only in the manifest.
    expect(r.contentType).toBe('text/html')
  })

  it('normalises the recorded content type and leaves no temp file behind', async () => {
    fake.seed('library/incoming/ct/meta.json', JSON.stringify({ ...META, url: 'https://example.org/data' }))
    const f = routingFetch({ 'https://example.org/data': () => new Response('x', { status: 200, headers: { 'content-type': 'not a type' } }) })
    // Own temp dir: other vitest workers write blo-fetch-* files into the OS
    // temp dir at the same time, so asserting on tmpdir() was a flake.
    const { mkdtempSync, readdirSync } = await import('node:fs')
    const tmpDir = mkdtempSync(join(dataDir, 'tmp-'))
    const r = await fetchLink('ct', { fetchImpl: f, lookup, log: () => {}, tmpDir })
    expect(r.contentType).toBe('application/octet-stream')
    const meta = JSON.parse((await getFile('library/incoming/ct/meta.json', { fresh: true })).toString())
    expect(meta.contentType).toBe('application/octet-stream')
    expect(readdirSync(tmpDir)).toEqual([])
  })
})
