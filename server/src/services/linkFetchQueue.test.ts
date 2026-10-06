import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * P5-47 fetch-on-drop queue. The network is a fake fetch, DNS is a fake
 * resolver, the bucket is FakeS3 and Postgres is pg-mem — so ordering, the
 * bound, the one retry, the guard, the manifest/catalog transitions and the
 * audit trail are all asserted without a byte leaving the machine.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb, libraryQuery } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket, getFile } = await import('./libraryBucket.js')
const { indexFileBackedEntry, getCatalogEntry } = await import('./libraryCatalog.js')
const { LinkFetchError } = await import('../cli/fetchLink.js')
const { getKbIndex, clearKbIndex } = await import('./kbSearch.js')
const {
  enqueueLinkJob,
  queueLinkFetch,
  queueSuggestion,
  queueDepth,
  whenQueueIdle,
  resetLinkFetchQueue,
  failureReason,
  QUEUE_MAX,
} = await import('./linkFetchQueue.js')
const { defaultLinkTitle } = await import('./libraryLinks.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

let fake: FakeS3
let dataDir: string

/** Fake resolver: these names map to fixed addresses, everything else public. */
const ADDRESSES: Record<string, string[]> = {
  'evil.example': ['127.0.0.1'],
  'intranet.example': ['10.1.2.3'],
}
const lookup = async (host: string) =>
  (ADDRESSES[host] ?? ['93.184.216.34']).map(address => ({ address, family: address.includes(':') ? 6 : 4 }))

function csvFetch(body = 'id,val\n1,2\n', headers: Record<string, string> = { 'content-type': 'text/csv' }, status = 200): typeof fetch {
  return (async () => new Response(body, { status, headers })) as unknown as typeof fetch
}

/** Seed one link drop exactly as POST /api/library/links leaves it. */
async function seedLink(slug: string, url: string, extra: Record<string, unknown> = {}): Promise<void> {
  const meta = {
    title: `link ${slug}`,
    category: '',
    status: 'needs-cataloging',
    tags: [],
    url,
    linkedBy: 'maria',
    linkedById: 1,
    linkedAt: '2026-09-05T00:00:00.000Z',
    originalFilename: null,
    fetch: { status: 'queued', at: '2026-09-05T00:00:00.000Z' },
    ...extra,
  }
  const json = JSON.stringify(meta, null, 2)
  const key = `library/incoming/${slug}/meta.json`
  fake.seed(key, json)
  await indexFileBackedEntry('incoming', slug, meta, [{ key, size: Buffer.byteLength(json) }])
}

const noSuggestion = async () => null

function job(slug: string, over: Record<string, unknown> = {}) {
  return { slug, work: 'fetch' as const, userId: 1, actor: 'maria', lookup, suggest: noSuggestion, ...over }
}

beforeEach(async () => {
  resetLinkFetchQueue()
  clearKbIndex()
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-queue-test-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
})

afterEach(async () => {
  await whenQueueIdle()
  resetLinkFetchQueue()
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('the queue itself', () => {
  it('takes jobs in order, runs one at a time, and never makes the caller wait', async () => {
    const order: string[] = []
    let active = 0
    const slow = (slug: string): typeof fetch =>
      (async () => {
        active++
        expect(active, 'two downloads ran at once').toBe(1)
        order.push(`start ${slug}`)
        await new Promise(r => setTimeout(r, 5))
        order.push(`end ${slug}`)
        active--
        return new Response('id\n1\n', { status: 200, headers: { 'content-type': 'text/csv' } })
      }) as unknown as typeof fetch

    for (const slug of ['a', 'b', 'c']) await seedLink(slug, `https://example.org/${slug}.csv`)
    for (const slug of ['a', 'b', 'c']) expect(enqueueLinkJob(job(slug, { fetchImpl: slow(slug) }))).toBe('queued')
    // Enqueueing is synchronous: the drop's response is not waiting on this.
    // Asserted by what has HAPPENED rather than by a stopwatch — a wall-clock
    // budget small enough to be meaningful here is smaller than the noise of
    // a loaded test runner, and this says the same thing exactly.
    expect(order, 'a download ran during the enqueue loop').toEqual([])
    // The first job is already in flight (the drain starts on the enqueue),
    // so two are still waiting.
    expect(queueDepth()).toBe(2)

    await whenQueueIdle()
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('is bounded: past the cap the drop still succeeds and the entry says it will be picked up later', async () => {
    await seedLink('later-one', 'https://example.org/late.csv')
    // Nothing else is seeded, so each filler job ends immediately at "no
    // manifest" — but not before this synchronous run of enqueues finishes.
    for (let i = 0; i < QUEUE_MAX; i++) expect(enqueueLinkJob(job(`x${i}`))).toBe('queued')
    while (queueDepth() < QUEUE_MAX) enqueueLinkJob(job('filler'))
    expect(enqueueLinkJob(job('over'))).toBe('full')

    const state = queueLinkFetch({ slug: 'later-one', userId: 1, actor: 'maria' })
    expect(state.status).toBe('later')
    expect(state.reason).toMatch(/busy/)
    await whenQueueIdle()
  })
})

describe('a successful fetch', () => {
  it('stores the file, records lineage and content type, and moves the entry to fetched — in the manifest AND the row', async () => {
    await seedLink('abc', 'https://example.org/exports/parcels.csv?token=1')
    enqueueLinkJob(job('abc', { fetchImpl: csvFetch() }))
    await whenQueueIdle()

    expect((await getFile('library/incoming/abc/parcels.csv')).toString()).toBe('id,val\n1,2\n')
    const meta = JSON.parse((await getFile('library/incoming/abc/meta.json', { fresh: true })).toString())
    expect(meta).toMatchObject({
      originalFilename: 'parcels.csv',
      contentType: 'text/csv',
      size: 11,
      lineage: { from: 'https://example.org/exports/parcels.csv?token=1' },
      fetch: { status: 'fetched', bytes: 11, name: 'parcels.csv' },
    })
    expect(typeof meta.fetch.at).toBe('string')

    // The catalog row followed the bucket, without a reindex.
    const row = await getCatalogEntry('abc')
    expect((row!.meta.fetch as { status: string }).status).toBe('fetched')
    expect(row!.files.map(f => f.key).sort()).toEqual(['library/incoming/abc/meta.json', 'library/incoming/abc/parcels.csv'])
    expect(row!.title).toBe('link abc') // the filing is untouched: only a person files
  })

  it('writes fetching before fetched, and leaves no temp file behind', async () => {
    const seen: string[] = []
    await seedLink('t', 'https://example.org/x.csv')
    const watching: typeof fetch = (async () => {
      const meta = JSON.parse((await getFile('library/incoming/t/meta.json', { fresh: true })).toString())
      seen.push(meta.fetch.status)
      return new Response('a', { status: 200, headers: { 'content-type': 'text/csv' } })
    }) as unknown as typeof fetch
    // Own temp dir (see fetchLink.test): the OS temp dir is shared with other
    // workers' in-flight downloads.
    const tmpDir = mkdtempSync(join(tmpdir(), 'blo-fetch-test-'))
    enqueueLinkJob(job('t', { fetchImpl: watching, tmpDir }))
    await whenQueueIdle()
    expect(seen).toEqual(['fetching'])
    expect(JSON.parse((await getFile('library/incoming/t/meta.json', { fresh: true })).toString()).fetch.status).toBe('fetched')
    expect(readdirSync(tmpDir)).toEqual([])
  })

  it('audits the fetch', async () => {
    await seedLink('aud', 'https://example.org/a.csv')
    enqueueLinkJob(job('aud', { fetchImpl: csvFetch() }))
    await whenQueueIdle()
    const audit = await libraryQuery(`SELECT actor, target, detail FROM library_audit WHERE action = 'library.fetch'`)
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({ actor: 'maria', target: 'aud' })
    expect(audit.rows[0].detail).toMatchObject({ ok: true, bytes: 11, name: 'a.csv' })
  })

  it('runs the suggestion pass afterwards, and stores it without applying it', async () => {
    await seedLink('sug', 'https://example.org/plan.csv')
    const suggest = vi.fn(async () => ({ title: 'A better title', category: 'research', at: '2026-09-05T01:00:00.000Z', model: 'stub' }))
    enqueueLinkJob(job('sug', { fetchImpl: csvFetch(), suggest }))
    await whenQueueIdle()
    expect(suggest).toHaveBeenCalledOnce()
    const meta = JSON.parse((await getFile('library/incoming/sug/meta.json', { fresh: true })).toString())
    expect(meta.suggested).toMatchObject({ title: 'A better title', category: 'research' })
    // NEVER applied: the entry's own filing is exactly what the dropper left.
    expect(meta.title).toBe('link sug')
    expect(meta.category).toBe('')
    expect((await getCatalogEntry('sug'))!.meta.suggested).toBeTruthy()
  })
})

describe('failures', () => {
  it('refuses a private host before any fetch is attempted, and says so in plain words', async () => {
    await seedLink('priv', 'https://intranet.example/secrets.csv')
    const calls: string[] = []
    const spy: typeof fetch = (async (input: any) => {
      calls.push(String(input))
      return new Response('x', { status: 200 })
    }) as unknown as typeof fetch
    enqueueLinkJob(job('priv', { fetchImpl: spy }))
    await whenQueueIdle()
    expect(calls).toEqual([])
    const meta = JSON.parse((await getFile('library/incoming/priv/meta.json', { fresh: true })).toString())
    expect(meta.fetch).toMatchObject({ status: 'failed', reason: 'not a public address' })
    expect(meta.originalFilename).toBeNull()
    const audit = await libraryQuery(`SELECT detail FROM library_audit WHERE action = 'library.fetch'`)
    expect(audit.rows[0].detail).toMatchObject({ ok: false, reason: 'not a public address' })
  })

  it('says the site refused the request, in the manifest and on the row', async () => {
    await seedLink('gone', 'https://example.org/missing.csv')
    enqueueLinkJob(job('gone', { fetchImpl: csvFetch('', {}, 404) }))
    await whenQueueIdle()
    const row = await getCatalogEntry('gone')
    expect(row!.meta.fetch).toMatchObject({ status: 'failed', reason: 'the site refused the request' })
  })

  it('says too large, with the limit, when the download is over the cap', async () => {
    const previous = process.env.LIBRARY_UPLOAD_MAX_BYTES
    process.env.LIBRARY_UPLOAD_MAX_BYTES = String(50 * 1024 * 1024)
    try {
      await seedLink('big', 'https://example.org/huge.csv')
      enqueueLinkJob(job('big', { fetchImpl: csvFetch('x', { 'content-length': String(200 * 1024 * 1024) }) }))
      await whenQueueIdle()
      const meta = JSON.parse((await getFile('library/incoming/big/meta.json', { fresh: true })).toString())
      expect(meta.fetch).toMatchObject({ status: 'failed', reason: 'too large (limit 50 MB)' })
    } finally {
      if (previous === undefined) delete process.env.LIBRARY_UPLOAD_MAX_BYTES
      else process.env.LIBRARY_UPLOAD_MAX_BYTES = previous
    }
  })

  it('retries a network error exactly once, then gives up with a plain reason', async () => {
    await seedLink('flaky', 'https://example.org/flaky.csv')
    let calls = 0
    const flaky: typeof fetch = (async () => {
      calls++
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response('id\n1\n', { status: 200, headers: { 'content-type': 'text/csv' } })
    }) as unknown as typeof fetch
    enqueueLinkJob(job('flaky', { fetchImpl: flaky }))
    await whenQueueIdle()
    expect(calls).toBe(2)
    expect(JSON.parse((await getFile('library/incoming/flaky/meta.json', { fresh: true })).toString()).fetch.status).toBe('fetched')

    await seedLink('dead', 'https://example.org/dead.csv')
    let deadCalls = 0
    const dead: typeof fetch = (async () => {
      deadCalls++
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    enqueueLinkJob(job('dead', { fetchImpl: dead }))
    await whenQueueIdle()
    expect(deadCalls).toBe(2) // the attempt plus one retry, and no more
    expect(JSON.parse((await getFile('library/incoming/dead/meta.json', { fresh: true })).toString()).fetch).toMatchObject({
      status: 'failed',
      reason: 'could not reach the site',
    })
  })

  it('does not retry a refusal — the second request would only be refused again', async () => {
    await seedLink('nope', 'https://example.org/nope.csv')
    let calls = 0
    const refusing: typeof fetch = (async () => {
      calls++
      return new Response('', { status: 403 })
    }) as unknown as typeof fetch
    enqueueLinkJob(job('nope', { fetchImpl: refusing }))
    await whenQueueIdle()
    expect(calls).toBe(1)
  })

  it('ends quietly when the entry has gone, or has no url', async () => {
    enqueueLinkJob(job('vanished', { fetchImpl: csvFetch() }))
    await seedLink('nolink', 'https://example.org/a.csv', { url: '' })
    enqueueLinkJob(job('nolink', { fetchImpl: csvFetch() }))
    await whenQueueIdle()
    expect(await getCatalogEntry('vanished')).toBeNull()
  })

  it('names every failure in words a reader can act on', () => {
    expect(failureReason(new LinkFetchError('x', 'not-public'))).toBe('not a public address')
    expect(failureReason(new LinkFetchError('x', 'timeout'))).toBe('took too long')
    expect(failureReason(new LinkFetchError('x', 'http-error'))).toBe('the site refused the request')
    expect(failureReason(new LinkFetchError('x', 'too-many-redirects'))).toMatch(/redirect/)
    expect(failureReason(new Error('anything else'))).toBe('the download did not work')
  })
})

describe('uploads', () => {
  it('queues a suggestion pass with no download at all', async () => {
    await seedLink('up', 'https://example.org/never.csv')
    const fetchImpl = vi.fn()
    const suggest = vi.fn(async () => ({ summary: 'What this is.', at: 'now', model: 'stub' }))
    expect(queueSuggestion({ slug: 'up', userId: 1, actor: 'maria', suggest, fetchImpl: fetchImpl as any })).toBe('queued')
    await whenQueueIdle()
    expect(fetchImpl).not.toHaveBeenCalled()
    const meta = JSON.parse((await getFile('library/incoming/up/meta.json', { fresh: true })).toString())
    expect(meta.suggested).toMatchObject({ summary: 'What this is.' })
    expect(meta.fetch.status).toBe('queued') // untouched — this job never fetches
  })
})

describe('an entry that changed under the job', () => {
  it('stores nothing when the drop was re-filed as a source mid-download', async () => {
    await seedLink('moved', 'https://example.org/x.csv')
    const movingFetch: typeof fetch = (async () => {
      // The user files it as a source while the bytes are on the wire: the
      // incoming manifest is gone by the time we come back.
      fake.objects.delete('library/incoming/moved/meta.json')
      return new Response('id\n1\n', { status: 200, headers: { 'content-type': 'text/csv' } })
    }) as unknown as typeof fetch
    enqueueLinkJob(job('moved', { fetchImpl: movingFetch }))
    await whenQueueIdle()
    expect(fake.objects.has('library/incoming/moved/meta.json')).toBe(false)
    expect(fake.objects.has('library/incoming/moved/x.csv')).toBe(false)
  })
})

describe('what Ask can see', () => {
  it('drops the cached ask index so a summary written now is findable now', async () => {
    await seedLink('askable', 'https://example.org/study.csv')
    const before = await getKbIndex()
    expect(before.entryBySlug.get('askable')?.text).not.toContain('tangled titles')

    enqueueLinkJob(
      job('askable', {
        fetchImpl: csvFetch(),
        suggest: async () => ({ summary: 'A study of tangled titles.', at: 'T', model: 'stub' }),
      }),
    )
    await whenQueueIdle()

    const after = await getKbIndex()
    expect(after).not.toBe(before) // the cache was dropped, not stale-served
    expect(after.entryBySlug.get('askable')?.text).toContain('Suggested summary: A study of tangled titles.')
  })
})

/**
 * P5-59: the queue looks at a link before it downloads it. The point of the
 * order is that an ArcGIS layer or a Socrata dataset never gets downloaded at
 * all — its "file" would be a page of JSON metadata pretending to be data.
 */
describe('inspection runs first (P5-59)', () => {
  const arcgis = {
    kind: 'arcgis-layer' as const,
    confidence: 'high' as const,
    url: 'https://services.example/rest/services/NPL/FeatureServer/0',
    finalUrl: 'https://services.example/rest/services/NPL/FeatureServer/0',
    title: 'NPL sites',
    geometry: 'point' as const,
    fields: [{ name: 'SITE_NAME' }, { name: 'STCOFIPS' }],
    checkedAt: '2026-09-06T00:00:00.000Z',
  }

  it('stores what it found on the entry, before the download, without applying it', async () => {
    await seedLink('insp', 'https://example.org/data.csv')
    const order: string[] = []
    const fetchImpl = (async () => {
      order.push('fetch')
      return new Response('id,val\n1,2\n', { status: 200, headers: { 'content-type': 'text/csv' } })
    }) as unknown as typeof fetch
    const inspect = (async () => {
      order.push('inspect')
      return { ...arcgis, kind: 'file' as const, formats: ['csv'], url: 'https://example.org/data.csv' }
    }) as any

    enqueueLinkJob(job('insp', { fetchImpl, inspect }))
    await whenQueueIdle()

    expect(order).toEqual(['inspect', 'fetch'])
    const entry = await getCatalogEntry('insp')
    expect((entry!.meta.inspection as any).kind).toBe('file')
    // Data, never applied: the title and status are the drop's.
    expect(entry!.title).toBe('link insp')
    expect(entry!.status).toBe('needs-cataloging')
    expect((entry!.meta.fetch as any).status).toBe('fetched')
  })

  it('an ArcGIS layer is never downloaded, and the model reads the service instead', async () => {
    await seedLink('svc', 'https://services.example/rest/services/NPL/FeatureServer/0')
    const fetchImpl = vi.fn(async () => new Response('should not be called', { status: 200 })) as unknown as typeof fetch
    let sawText = ''
    const suggest = (async (_slug: string, options: any) => {
      sawText = options?.text?.text ?? ''
      return { at: 'now', model: 'test', title: 'EPA NPL sites' }
    }) as any

    enqueueLinkJob(job('svc', { fetchImpl, inspect: (async () => arcgis) as any, suggest }))
    await whenQueueIdle()

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(sawText).toContain('NPL sites')
    expect(sawText).toContain('SITE_NAME')

    const entry = await getCatalogEntry('svc')
    expect((entry!.meta.fetch as any).status).toBe('later')
    expect((entry!.meta.fetch as any).reason).toMatch(/service we query/i)
    expect((entry!.meta.suggested as any).title).toBe('EPA NPL sites')
  })

  /**
   * P5-59, found live: a web page's raw HTML was downloaded and stored as the
   * entry's file, which the viewer can only offer as an attachment. The probe
   * has already read the page for the summary, so there is nothing to fetch.
   */
  it('a web page is not downloaded either — its text was already read', async () => {
    await seedLink('report', 'https://example.org/heirs-property-report')
    const page = {
      kind: 'page' as const,
      confidence: 'high' as const,
      url: 'https://example.org/heirs-property-report',
      title: "Heirs' property in the Black Belt",
      description: 'A 2025 field report on clouded title.',
      checkedAt: '2026-09-06T00:00:00.000Z',
    }
    const fetchImpl = vi.fn(async () => new Response('<html>…</html>', { status: 200 })) as unknown as typeof fetch
    let sawText = ''
    const suggest = (async (_slug: string, options: any) => {
      sawText = options?.text?.text ?? ''
      return { at: 'now', model: 'test', title: "Heirs' property in the Black Belt" }
    }) as any

    enqueueLinkJob(job('report', { fetchImpl, inspect: (async () => page) as any, suggest }))
    await whenQueueIdle()

    expect(fetchImpl).not.toHaveBeenCalled()
    const entry = await getCatalogEntry('report')
    expect(entry!.files.every(f => f.key.endsWith('/meta.json'))).toBe(true)
    expect((entry!.meta.fetch as any).status).toBe('later')
    expect((entry!.meta.fetch as any).reason).toBe(
      'a web page — its text was read for the summary; nothing to download',
    )
    // The suggestion still happens, from what the probe read off the page.
    expect(sawText).toContain("Heirs' property in the Black Belt")
    expect((entry!.meta.suggested as any).title).toBe("Heirs' property in the Black Belt")
  })

  it('a portal page is treated the same way', async () => {
    await seedLink('portal', 'https://catalog.data.gov/dataset/well-water')
    const portal = {
      kind: 'portal' as const,
      confidence: 'high' as const,
      url: 'https://catalog.data.gov/dataset/well-water',
      title: 'Well Water Index',
      links: [{ url: 'https://data.cdc.gov/api/views/fxwg-3udm/rows.csv', label: 'CSV' }],
      checkedAt: '2026-09-06T00:00:00.000Z',
    }
    const fetchImpl = vi.fn(async () => new Response('<html>…</html>', { status: 200 })) as unknown as typeof fetch
    enqueueLinkJob(job('portal', { fetchImpl, inspect: (async () => portal) as any }))
    await whenQueueIdle()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(((await getCatalogEntry('portal'))!.meta.fetch as any).reason).toMatch(/a web page/)
  })

  it('a plain file is still downloaded, exactly as before', async () => {
    await seedLink('plain', 'https://example.org/data.csv')
    const file = {
      kind: 'file' as const,
      confidence: 'high' as const,
      url: 'https://example.org/data.csv',
      formats: ['csv'],
      checkedAt: '2026-09-06T00:00:00.000Z',
    }
    enqueueLinkJob(job('plain', { fetchImpl: csvFetch(), inspect: (async () => file) as any }))
    await whenQueueIdle()
    const entry = await getCatalogEntry('plain')
    expect((entry!.meta.fetch as any).status).toBe('fetched')
    expect(entry!.files.some(f => !f.key.endsWith('/meta.json'))).toBe(true)
  })

  /**
   * P5-61: the queue drives the REAL inspector against a fake network, so what
   * is asserted is the wiring — a dropped prose page is harvested and pruned
   * once, only the kept links are written to the entry, and the filing model
   * is shown them.
   */
  it('a dropped page is harvested and pruned once, and only the kept links are stored', async () => {
    const { AGENCY_PROSE_PAGE, publicLookup } = await import('../testutils/fixtures/inspect/index.js')
    const { inspectUrl } = await import('./linkInspect.js')
    await seedLink('prose', 'https://epd.example.gov/programs/wells')

    const fetchImpl = vi.fn(
      async () => new Response(AGENCY_PROSE_PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as unknown as typeof fetch
    const prune = vi.fn(async (input: any) => ({
      links: [
        {
          url: input.candidates.find((c: any) => c.url.endsWith('.csv')).url,
          kind: 'file' as const,
          role: 'data-file' as const,
          reason: 'The annual results file.',
        },
      ],
      candidates: input.candidates.length,
      pruned: 'model' as const,
      prose: { isDataset: true, provider: 'Georgia EPD' },
    }))
    let sawText = ''
    const suggest = (async (_slug: string, options: any) => {
      sawText = options?.text?.text ?? ''
      return { at: 'now', model: 'test', title: 'Private Well Testing Program' }
    }) as any

    enqueueLinkJob(
      job('prose', {
        fetchImpl,
        lookup: publicLookup,
        clientIp: '203.0.113.4',
        suggest,
        inspect: ((url: string, options: any) =>
          inspectUrl(url, { ...options, fetchImpl, lookup: publicLookup, prune })) as any,
      }),
    )
    await whenQueueIdle()

    // Once — a drop must not pay for the model twice.
    expect(prune).toHaveBeenCalledTimes(1)
    // And billed to whoever dropped it.
    expect(prune.mock.calls[0][1]).toMatchObject({ clientIp: '203.0.113.4' })

    const entry = await getCatalogEntry('prose')
    const inspection = entry!.meta.inspection as any
    expect(inspection.kind).toBe('page')
    expect(inspection.links).toHaveLength(1)
    expect(inspection.links[0].url).toBe('https://epd.example.gov/files/well-testing-results-2024.csv')
    expect(inspection.links[0].reason).toBe('The annual results file.')
    // The forty navigation links are NOT on the entry; only the count is.
    expect(inspection.candidates).toBeGreaterThan(1)
    expect(JSON.stringify(inspection)).not.toContain('/careers')
    // The page itself is not downloaded, and the filing model reads the links.
    expect((entry!.meta.fetch as any).status).toBe('later')
    expect(sawText).toContain('The annual results file.')
  })

  it('a probe that throws costs the drop nothing', async () => {
    await seedLink('boom', 'https://example.org/data.csv')
    const inspect = (async () => {
      throw new Error('the probe exploded')
    }) as any
    enqueueLinkJob(job('boom', { fetchImpl: csvFetch(), inspect }))
    await whenQueueIdle()

    const entry = await getCatalogEntry('boom')
    expect(entry!.meta.inspection).toBeUndefined()
    expect((entry!.meta.fetch as any).status).toBe('fetched')
  })
})


/**
 * P5-79: the deterministic floor. A dropped page used to land titled by its
 * hostname with nothing else, because every enrichment was the model's job and
 * the account can be out of credit. The page said what it was; the queue puts
 * that on the entry — and only where nobody has said anything.
 */
describe('the page own words land on the entry (P5-79)', () => {
  const PAGE_URL = 'http://www.engaginglandowners.org/'
  const pageInspection = (over: Record<string, unknown> = {}) => ({
    kind: 'page' as const,
    confidence: 'medium' as const,
    url: PAGE_URL,
    finalUrl: PAGE_URL,
    checkedAt: '2026-09-10T00:00:00.000Z',
    page: {
      title: 'Engaging Landowners',
      description: 'A programme helping family forest owners keep their land in the family.',
      provider: 'Engaging Landowners',
      insecure: true,
    },
    ...over,
  })

  /** A drop as `createLinkEntry` leaves it: the title derived from the URL. */
  async function seedDroppedLink(slug: string, url = PAGE_URL, extra: Record<string, unknown> = {}): Promise<void> {
    await seedLink(slug, url, { title: defaultLinkTitle(new URL(url)), ...extra })
  }

  it('titles and describes an entry that has no words of its own, at once', async () => {
    await seedDroppedLink('floor')
    const before = await getKbIndex()
    expect(before.entryBySlug.get('floor')?.text).not.toContain('family forest owners')

    enqueueLinkJob(job('floor', { fetchImpl: csvFetch(), inspect: (async () => pageInspection()) as any }))
    await whenQueueIdle()

    const entry = await getCatalogEntry('floor')
    expect(entry!.title).toBe('Engaging Landowners')
    expect(entry!.meta.description).toBe('A programme helping family forest owners keep their land in the family.')
    // The floor is applied to the entry AND kept as what the page said.
    expect((entry!.meta.inspection as any).page.insecure).toBe(true)
    // ⌘K reads the row and Ask reads its index: both see it now, not at the
    // next reindex.
    const after = await getKbIndex()
    expect(after).not.toBe(before)
    expect(after.entryBySlug.get('floor')?.text).toContain('family forest owners')
    expect(after.entryBySlug.get('floor')?.text).toContain('Engaging Landowners')
  })

  it('never writes over a person words', async () => {
    await seedLink('mine', PAGE_URL, { title: 'Landowner outreach, Georgia', description: 'What Maria wrote.' })
    enqueueLinkJob(job('mine', { fetchImpl: csvFetch(), inspect: (async () => pageInspection()) as any }))
    await whenQueueIdle()

    const entry = await getCatalogEntry('mine')
    expect(entry!.title).toBe('Landowner outreach, Georgia')
    expect(entry!.meta.description).toBe('What Maria wrote.')
  })

  it('fills only the half that is empty', async () => {
    await seedDroppedLink('half', PAGE_URL, { description: 'Already described.' })
    enqueueLinkJob(job('half', { fetchImpl: csvFetch(), inspect: (async () => pageInspection()) as any }))
    await whenQueueIdle()

    const entry = await getCatalogEntry('half')
    expect(entry!.title).toBe('Engaging Landowners')
    expect(entry!.meta.description).toBe('Already described.')
  })

  it('a page with no title of its own leaves the entry titled as it was', async () => {
    await seedDroppedLink('untitled')
    const inspect = (async () => pageInspection({ page: { description: 'Some words off the page.' } })) as any
    enqueueLinkJob(job('untitled', { fetchImpl: csvFetch(), inspect }))
    await whenQueueIdle()

    const entry = await getCatalogEntry('untitled')
    expect(entry!.title).toBe(defaultLinkTitle(new URL(PAGE_URL)))
    expect(entry!.meta.description).toBe('Some words off the page.')
  })

  it('a file has no page words, so nothing is applied', async () => {
    await seedDroppedLink('file', 'https://example.org/data.csv')
    const file = {
      kind: 'file' as const,
      confidence: 'high' as const,
      url: 'https://example.org/data.csv',
      formats: ['csv'],
      checkedAt: '2026-09-10T00:00:00.000Z',
    }
    enqueueLinkJob(job('file', { fetchImpl: csvFetch(), inspect: (async () => file) as any }))
    await whenQueueIdle()

    const entry = await getCatalogEntry('file')
    expect(entry!.title).toBe('example.org/data.csv')
    expect(entry!.meta.description).toBeUndefined()
    expect((entry!.meta.fetch as any).status).toBe('fetched')
  })

  /** The whole path, with the REAL inspector reading a real page off a fake
   *  network: no model anywhere, and the entry still ends up with words. */
  it('reads a real page and gives the entry its title and description, with no model at all', async () => {
    const { AGENCY_PROSE_PAGE, publicLookup } = await import('../testutils/fixtures/inspect/index.js')
    const { inspectUrl } = await import('./linkInspect.js')
    const url = 'https://epd.example.gov/programs/wells'
    await seedDroppedLink('real', url)

    const fetchImpl = vi.fn(
      async () => new Response(AGENCY_PROSE_PAGE, { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as unknown as typeof fetch
    // The pass that cannot run is exactly the point of the floor.
    const prune = async () => ({ links: [], candidates: 0, pruned: 'unranked' as const, pruneError: 'no credit' })

    enqueueLinkJob(
      job('real', {
        fetchImpl,
        lookup: publicLookup,
        inspect: ((u: string, options: any) => inspectUrl(u, { ...options, fetchImpl, lookup: publicLookup, prune })) as any,
      }),
    )
    await whenQueueIdle()

    const entry = await getCatalogEntry('real')
    expect(entry!.title).toBe('Private Well Testing Program — Georgia Environmental Protection Division')
    expect(entry!.meta.description).toBe("Results of the state's private well sampling program, by county.")
    expect((entry!.meta.inspection as any).page.insecure).toBeUndefined()
  })

  it('applies the floor once and does not re-title what it already titled', async () => {
    await seedDroppedLink('again')
    enqueueLinkJob(job('again', { fetchImpl: csvFetch(), inspect: (async () => pageInspection()) as any }))
    await whenQueueIdle()
    // A second look, a different page title: the entry is no longer the
    // URL-derived default, so it keeps what it has.
    const renamed = (async () => pageInspection({ page: { title: 'Something else entirely' } })) as any
    enqueueLinkJob(job('again', { fetchImpl: csvFetch(), inspect: renamed }))
    await whenQueueIdle()

    expect((await getCatalogEntry('again'))!.title).toBe('Engaging Landowners')
  })
})
