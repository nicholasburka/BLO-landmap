import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * Input versions and staleness (P7-6).
 *
 * The real catalog and the real bucket, like `workingSetProximity.test.ts`:
 * what this file is judged on is whether a verdict tracks the BYTES, so faking
 * the thing that holds the bytes would test nothing.
 *
 * The two tests that matter most are the pair that pull in opposite
 * directions, because together they are the ticket's one design rule —
 * *keyed by content, never by clock*:
 *
 *  - the clock moves and the content does not → still **fresh**
 *  - the content moves and the byte count does not → **stale**
 *
 * Either one alone can be passed by the wrong implementation.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog, getCatalogEntry } = await import('./libraryCatalog.js')
const { clearTabularCache } = await import('./libraryTabular.js')
const {
  captureAnalysisInput,
  checkAnalysisInputs,
  clearAnalysisInputMemo,
  fingerprintOf,
  freshnessNote,
  layerKeysOf,
  readAnalysisInputs,
} = await import('./analysisInputs.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

const SITES_CSV = 'name,lat,lng,GEOID\nxAI supercomputer,35.060080,-90.152192,47157\n'

const SITES_META = {
  title: 'Redevelopment sites',
  status: 'published',
  category: 'land',
  layer: { geometry: 'point', name: 'Redevelopment sites', file: 'sites.csv', latKey: 'lat', lngKey: 'lng' },
}

let fake: FakeS3
let dataDir: string

/** A fixed stamp, so a test that moves the clock has to do it on purpose. */
const WHEN = new Date('2026-10-01T00:00:00.000Z')

async function seed(body = SITES_CSV, at: Date = WHEN): Promise<void> {
  fake.seed('library/datasets/redevelopment-sites/meta.json', JSON.stringify(SITES_META), at)
  fake.seed('library/datasets/redevelopment-sites/sites.csv', body, at)
  await reindexCatalog()
  // The parse cache and the fingerprint memo both key on the bucket key, and
  // a test that rewrites a file behind them is exactly what reindex clears.
  clearTabularCache()
  clearAnalysisInputMemo()
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-inputs-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  clearTabularCache()
  clearAnalysisInputMemo()
  await seed()
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const capture = () => captureAnalysisInput({ slug: 'redevelopment-sites', role: 'from', file: 'sites.csv' })

// --- What a version is -------------------------------------------------------

describe('what a recorded input version is', () => {
  it('records the file, its size, its content and the entry’s stamp', async () => {
    const input = await capture()
    expect(input).toMatchObject({
      slug: 'redevelopment-sites',
      role: 'from',
      file: 'sites.csv',
      bytes: Buffer.byteLength(SITES_CSV),
      keys: 'point|sites.csv|lat|lng||||',
    })
    expect(input.content).toMatch(/^[0-9a-f]{16}$/)
    expect(input.at).toBe((await getCatalogEntry('redevelopment-sites'))!.updatedAt)
  })

  it('is the content of the file, not of the whole entry', async () => {
    const input = await capture()
    expect(input.content).toBe(fingerprintOf(SITES_CSV))
  })

  it('records a slug the library does not have, with nothing to compare', async () => {
    const input = await captureAnalysisInput({ slug: 'no-such-thing', role: 'to', file: 'x.csv' })
    expect(input).toMatchObject({ slug: 'no-such-thing', bytes: 0, content: '', at: '' })
  })

  it('falls back to the table a re-run would read, and records THAT name', async () => {
    // A caller that cannot name the file it read — and a manifest pointing at a
    // file that is not there — must not record an uncheckable version. It
    // records the file `readDataset` would pick, which is the file a re-run
    // would actually read, so the check later looks for the right thing.
    const input = await captureAnalysisInput({ slug: 'redevelopment-sites', role: 'from', file: 'not-there.csv' })
    expect(input.file).toBe('sites.csv')
    expect(input.content).toBe(fingerprintOf(SITES_CSV))
    expect(input.at).not.toBe('')
    expect((await checkAnalysisInputs([input])).verdict).toBe('fresh')
  })

  it('takes the caller at its word about which file it read', async () => {
    // A named file that IS there is versioned as named, tabular or not. The
    // fallback exists for a claim that cannot be resolved, not to second-guess
    // one that can.
    fake.seed('library/datasets/paper/meta.json', JSON.stringify({ title: 'A PDF', status: 'published' }))
    fake.seed('library/datasets/paper/report.pdf', 'not a table')
    await reindexCatalog()
    const input = await captureAnalysisInput({ slug: 'paper', role: 'to', file: 'report.pdf' })
    expect(input.file).toBe('report.pdf')
    expect(input.content).toBe(fingerprintOf('not a table'))
  })

  it('records nothing checkable when there is no file it could have read', async () => {
    fake.seed('library/datasets/paper/meta.json', JSON.stringify({ title: 'A PDF', status: 'published' }))
    fake.seed('library/datasets/paper/report.pdf', 'not a table')
    await reindexCatalog()
    const input = await captureAnalysisInput({ slug: 'paper', role: 'to', file: 'gone.csv' })
    expect(input.content).toBe('')
    expect(input.at).not.toBe('')
    // Uncheckable, which is a third verdict and not a pass.
    expect((await checkAnalysisInputs([input])).verdict).toBe('unknown')
  })
})

// --- The rule: content, never clock -----------------------------------------

describe('keyed by content, never by clock', () => {
  it('stays FRESH when the clock moves and the bytes do not', async () => {
    const input = await capture()
    // A re-push of byte-identical content, a reindex, a retag: the stamp moves
    // and the answer must not. If a timer or an mtime were the key, this is
    // the test that would fail.
    await seed(SITES_CSV, new Date('2026-10-05T00:00:00.000Z'))
    expect((await getCatalogEntry('redevelopment-sites'))!.updatedAt).not.toBe(input.at)

    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('fresh')
    expect(freshness.note).toBe('')
  })

  it('goes STALE when the content changes and the byte count does not', async () => {
    const input = await capture()
    // One corrected digit — 35.060080 → 35.060081. Every byte count is
    // identical, and the number the analysis produced is now wrong.
    const edited = SITES_CSV.replace('35.060080', '35.060081')
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(SITES_CSV))
    await seed(edited, new Date('2026-10-05T00:00:00.000Z'))

    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('rewritten since this ran')
    expect(freshness.note).toContain('different content')
  })

  it('goes STALE when the file grows, and says both sizes', async () => {
    const input = await capture()
    await seed(`${SITES_CSV}Project Blue,32.2217,-110.9263,04019\n`)

    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain(`${Buffer.byteLength(SITES_CSV).toLocaleString()} bytes, now`)
    expect(freshness.note).toContain('may have drifted')
  })

  it('never expires: an old result over unchanged inputs is fresh', async () => {
    // The place report's 7-day TTL is the model this deliberately does not
    // copy. There is no clock to advance here, which is the point — nothing in
    // the record is a deadline.
    const input = { ...(await capture()), at: '' }
    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('fresh')
  })

  it('checks the content even with no stamp recorded — the batch tier’s case', async () => {
    // The local pass has no catalog to ask, so it writes `at: ''`. The check
    // then has no short circuit and must fall through to the bytes.
    const input = { ...(await capture()), at: '' }
    await seed(SITES_CSV.replace('35.060080', '35.060081'))
    expect((await checkAnalysisInputs([input])).verdict).toBe('stale')
  })
})

// --- The columns a run read it with -----------------------------------------

describe('the columns a run read it with', () => {
  it('goes STALE when the block is repointed, though no byte of data changed', async () => {
    const input = await capture()
    // The CSV is untouched; the manifest now says the latitude is somewhere
    // else. A re-run would read a different column, so the stored number is
    // not an answer to the same question.
    fake.seed(
      'library/datasets/redevelopment-sites/meta.json',
      JSON.stringify({ ...SITES_META, layer: { ...SITES_META.layer, latKey: 'latitude' } }),
      WHEN,
    )
    await reindexCatalog()
    clearAnalysisInputMemo()

    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('different columns')
  })

  it('stays FRESH when only how the layer is DRAWN changes', async () => {
    const input = await capture()
    // A nicer blue and a thicker line change no number. A version that marked
    // this stale would teach a reader to ignore the label.
    fake.seed(
      'library/datasets/redevelopment-sites/meta.json',
      JSON.stringify({
        ...SITES_META,
        layer: { ...SITES_META.layer, color: '#ff0000', width: 6, name: 'Sites, renamed', popupFields: ['x'] },
      }),
      new Date('2026-10-05T00:00:00.000Z'),
    )
    await reindexCatalog()
    clearAnalysisInputMemo()

    expect((await checkAnalysisInputs([input])).verdict).toBe('fresh')
  })

  it('reads the keys off the block, in a fixed order, cosmetics excluded', () => {
    expect(layerKeysOf({ layer: { geometry: 'line', file: 'x.geojson', pathKey: '_path' } })).toBe(
      'line|x.geojson|||_path|||',
    )
    // Absent and empty are the same input; a colour is not part of the version.
    expect(layerKeysOf({ layer: { geometry: 'point', labelKey: '' } })).toBe(
      layerKeysOf({ layer: { geometry: 'point', color: '#abc' } }),
    )
    for (const meta of [{}, { layer: null }, { layer: 'x' }, { layer: [] }]) expect(layerKeysOf(meta)).toBe('')
  })
})

// --- Gone, and uncheckable ---------------------------------------------------

describe('an input that is gone or cannot be read', () => {
  it('is STALE when the entry has left the library', async () => {
    const input = await capture()
    fake.objects.clear()
    fake.modified.clear()
    await reindexCatalog()
    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('no longer in the library')
  })

  it('is STALE when the entry no longer holds the file it read', async () => {
    const input = await capture()
    fake.objects.delete('library/datasets/redevelopment-sites/sites.csv')
    fake.modified.delete('library/datasets/redevelopment-sites/sites.csv')
    await reindexCatalog()
    clearAnalysisInputMemo()
    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('sites.csv')
  })

  it('is UNKNOWN when the bytes cannot be re-read — not fresh, and not stale', async () => {
    const input = { ...(await capture()), at: '' }
    clearAnalysisInputMemo()
    // The row still says the file is there and the right size; the bucket
    // cannot hand it over. Claiming either verdict would be a guess.
    fake.objects.delete('library/datasets/redevelopment-sites/sites.csv')
    rmSync(dataDir, { recursive: true, force: true })
    const freshness = await checkAnalysisInputs([input])
    expect(freshness.verdict).toBe('unknown')
    expect(freshness.note).toContain('cannot be checked')
  })

  it('is UNKNOWN when nothing was recorded for it', async () => {
    const freshness = await checkAnalysisInputs([{ slug: 'redevelopment-sites', role: 'from' }])
    expect(freshness.verdict).toBe('unknown')
    expect(freshness.inputs[0].reason).toContain('not recorded when this ran')
  })

  it('is UNKNOWN, with a sentence, when a result records no inputs at all', async () => {
    // Every column written before this ticket. It still renders — which is the
    // acceptance criterion — and it does not claim to be checked.
    for (const stored of [undefined, null, [], 'nonsense']) {
      const freshness = await checkAnalysisInputs(stored)
      expect(freshness.verdict).toBe('unknown')
      expect(freshness.note).toContain('before its inputs were recorded')
    }
  })
})

// --- Several inputs ----------------------------------------------------------

describe('a result with more than one input', () => {
  it('is only fresh when every input is', async () => {
    const good = await capture()
    const gone = await captureAnalysisInput({ slug: 'no-such-thing', role: 'to', file: 'x.csv', keys: '' })
    const freshness = await checkAnalysisInputs([good, gone])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.inputs.map(c => c.verdict)).toEqual(['fresh', 'stale'])
  })

  it('names every changed input, never just the first', async () => {
    const checks = [
      { slug: 'a', role: 'from', verdict: 'stale' as const, reason: '“a” has changed' },
      { slug: 'b', role: 'to', verdict: 'stale' as const, reason: '“b” has changed' },
    ]
    const note = freshnessNote('stale', checks)
    expect(note).toContain('“a” has changed')
    expect(note).toContain('“b” has changed')
  })

  it('lets a changed input beat an uncheckable one — there is already a reason to re-run', async () => {
    const checks = [
      { slug: 'a', role: 'from', verdict: 'unknown' as const, reason: '“a” cannot be checked' },
      { slug: 'b', role: 'to', verdict: 'stale' as const, reason: '“b” has changed' },
    ]
    expect(freshnessNote('stale', checks)).toBe('“b” has changed, so this number may have drifted.')
  })

  it('says nothing at all when everything is fresh', () => {
    expect(freshnessNote('fresh', [{ slug: 'a', role: 'from', verdict: 'fresh', reason: '' }])).toBe('')
  })
})

// --- Reading a hand-edited record -------------------------------------------

describe('reading the record back', () => {
  it('keeps an entry missing fields rather than dropping it', () => {
    const read = readAnalysisInputs([{ slug: 'a' }, { slug: 'b', bytes: 'lots', content: 7 }])
    expect(read).toHaveLength(2)
    expect(read[0]).toMatchObject({ slug: 'a', bytes: 0, content: '', keys: '', at: '' })
    expect(read[1]).toMatchObject({ slug: 'b', bytes: 0, content: '' })
  })

  it('drops only what has no slug — there is nothing to check it against', () => {
    expect(readAnalysisInputs([{ role: 'from' }, 'x', null, 42, { slug: '  ' }])).toEqual([])
  })

  it('reads a non-list as no inputs', () => {
    for (const value of [undefined, null, 'x', 3, {}]) expect(readAnalysisInputs(value)).toEqual([])
  })
})

// --- P7-8: a public map layer as an input ------------------------------------

describe('a public registry layer as an input', () => {
  /** A real registry layer, so the file read is the real file: the workbook's
   *  own race indicator, which is exactly what a political efficacy index
   *  weighs. */
  const LAYER = 'pct_Black'

  it('captures bytes, content and the columns it reads — with no catalog row at all', async () => {
    const input = await captureAnalysisInput({ slug: LAYER, role: 'term', file: '', source: 'public' })
    expect(input).toMatchObject({ slug: LAYER, role: 'term', source: 'public' })
    // The registry says which file and column; the file says its size and
    // content. A public layer has nothing in `library_catalog`, so without
    // this branch every index over one would have read back as stale.
    expect(input.file).toMatch(/^\/datasets\//)
    expect(input.keys).toContain('/datasets/')
    expect(input.bytes).toBeGreaterThan(0)
    expect(input.content).toMatch(/^[0-9a-f]{16}$/)
    // No revision stamp: a static dataset file has none, so the clock short
    // circuit simply never fires and the content always decides.
    expect(input.at).toBe('')
  })

  it('reads back as fresh against the real file', async () => {
    const input = await captureAnalysisInput({ slug: LAYER, role: 'term', file: '', source: 'public' })
    const freshness = await checkAnalysisInputs([input])
    expect(freshness).toMatchObject({ verdict: 'fresh', note: '' })
  })

  it('goes stale when the recorded bytes no longer match the file', async () => {
    const input = await captureAnalysisInput({ slug: LAYER, role: 'term', file: '', source: 'public' })
    const freshness = await checkAnalysisInputs([{ ...input, bytes: input.bytes + 1 }])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain(`“${LAYER}” has changed since this ran`)
    expect(freshness.note).toContain('bytes, now')
  })

  it('goes stale when the content moved but the size did not', async () => {
    const input = await captureAnalysisInput({ slug: LAYER, role: 'term', file: '', source: 'public' })
    const freshness = await checkAnalysisInputs([{ ...input, content: '0'.repeat(16) }])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('has been rewritten since this ran')
  })

  it('goes stale when the layer is read from a different file or column', async () => {
    const input = await captureAnalysisInput({ slug: LAYER, role: 'term', file: '', source: 'public' })
    const freshness = await checkAnalysisInputs([{ ...input, keys: '/datasets/elsewhere.csv|other' }])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('is now read from a different file or column')
  })

  it('goes stale when the layer has left the public map', async () => {
    const freshness = await checkAnalysisInputs([
      { slug: 'retired_layer', role: 'term', file: '/datasets/x.csv', bytes: 1, keys: 'a', content: 'b', at: '', source: 'public' },
    ])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.note).toContain('is no longer a layer on the public map')
  })

  it('reads as unknown when nothing was recorded, never as fresh', async () => {
    const freshness = await checkAnalysisInputs([
      { slug: LAYER, role: 'term', file: '/datasets/x.csv', bytes: 0, keys: '', content: '', at: '', source: 'public' },
    ])
    expect(freshness.verdict).toBe('unknown')
    expect(freshness.note).toContain('was not recorded when this ran')
  })

  it('leaves a library input a library input — absent and misspelt both mean library', () => {
    const [plain, misspelt, declared] = readAnalysisInputs([
      { slug: 'a', role: 'from', bytes: 1, keys: 'k', content: 'c', at: 'T' },
      { slug: 'b', role: 'to', bytes: 1, keys: 'k', content: 'c', at: 'T', source: 'bucket' },
      { slug: 'c', role: 'term', bytes: 1, keys: 'k', content: 'c', at: '', source: 'public' },
    ])
    // Every record written before P7-8 has no `source`, and must keep the
    // verdict it had — so only the one exact spelling counts.
    expect(plain.source).toBeUndefined()
    expect(misspelt.source).toBeUndefined()
    expect(declared.source).toBe('public')
  })

  it('mixes the two kinds in one result, worst verdict winning', async () => {
    const pub = await captureAnalysisInput({ slug: LAYER, role: 'term', file: '', source: 'public' })
    const held = await captureAnalysisInput({ slug: 'gone-from-the-library', role: 'term', file: 'x.csv' })
    const freshness = await checkAnalysisInputs([pub, { ...held, content: 'deadbeefdeadbeef' }])
    expect(freshness.verdict).toBe('stale')
    expect(freshness.inputs.find(i => i.slug === LAYER)!.verdict).toBe('fresh')
  })
})
