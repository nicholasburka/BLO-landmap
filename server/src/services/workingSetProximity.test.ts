import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * Proximity over a working set (P7-5) — the on-demand tier.
 *
 * The real catalog, the real bucket, the real tabular reader and the real
 * layer projection: nothing is injected, because what this file is judged on
 * is the seam between them. The fixture is the shape of the staged
 * `redevelopment-sites` table — **four of its rows in one county**, which is
 * what makes the county projection a real decision rather than an edge case,
 * and two rows deliberately unlocated, which is what makes the shortfall
 * reporting a real decision too.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog, getCatalogEntry } = await import('./libraryCatalog.js')
const { createWorkingSet, getWorkingSet, updateWorkingSet } = await import('./libraryWorkingSets.js')
const { workingSetKey, workingSetPrefix } = await import('./workingSetMeta.js')
const { readDerivedColumns, readDerivedValues } = await import('./workingSetColumns.js')
const { clearTabularCache } = await import('./libraryTabular.js')
const { clearInternalLayerBounds } = await import('./internalLayers.js')
const { ProximityError, listWorkingSetProximity, runWorkingSetProximity, storedProximity } = await import(
  './workingSetProximity.js'
)
const { clearAnalysisInputMemo, fingerprintOf } = await import('./analysisInputs.js')

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

// --- The fixture: the staged redevelopment table's shape ---------------------
// Four Memphis rows in 47157 (xAI, Valero, TVA Allen, Nucor), single sites in
// two other counties, and two rows the geocoder could not match — which is the
// real table's own state, nine of eleven located.

const SITES_CSV = [
  'name,address,lat,lng,GEOID,geocode_method',
  'xAI supercomputer,"Memphis, TN",35.060080,-90.152192,47157,census-address',
  'Valero Memphis Refinery,"Memphis, TN",35.081019,-90.078223,47157,census-address',
  'TVA Allen Plant,"Memphis, TN",35.065000,-90.140000,47157,census-address',
  'Nucor Steel Memphis,"Memphis, TN",35.110000,-90.100000,47157,census-address',
  'Coherent Richmond,"Richmond, VA",37.540700,-77.436000,51760,census-address',
  'Project Blue,"Tucson, AZ",32.221700,-110.926300,04019,census-address',
  'MP Materials Rare Earh Production,"Fort Worth, TX",,,,',
  'MP Materials Recycling Center,"Mountain Pass, CA",,,,',
].join('\n')

const SITES_META = {
  title: 'Redevelopment sites',
  status: 'published',
  category: 'land',
  layer: {
    geometry: 'point',
    name: 'Redevelopment sites',
    file: 'redevelopment-sites.csv',
    latKey: 'lat',
    lngKey: 'lng',
    labelKey: 'name',
    popupFields: ['address'],
  },
}

/** Two transmission corridors as a GeoJSON FeatureCollection, which is the
 *  shape `replicate.ts` has been writing beside every copied CSV since P5-59
 *  and the shape P7-3 taught the parser to keep. One is a MultiLineString. */
const LINES_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { NAME: 'Allen–Southaven 500kV', OWNER: 'TVA' },
      geometry: { type: 'LineString', coordinates: [[-90.10, 34.9], [-90.10, 35.3]] },
    },
    {
      type: 'Feature',
      properties: { NAME: 'Richmond loop', OWNER: 'Dominion' },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [[-77.50, 37.50], [-77.50, 37.60]],
          [[-77.40, 37.50], [-77.40, 37.60]],
        ],
      },
    },
  ],
})

const LINES_META = {
  title: 'Transmission lines',
  status: 'published',
  category: 'network',
  layer: {
    geometry: 'line',
    name: 'Transmission lines',
    file: 'transmission.geojson',
    pathKey: '_path',
    labelKey: 'NAME',
    popupFields: ['OWNER'],
    color: '#2b6cb0',
    width: 3,
  },
}

/** A county choropleth, so "measure to a county layer" can be refused. */
const SCORES_META = {
  title: 'Target index',
  status: 'published',
  category: 'economic',
  layer: { geometry: 'county', file: 'scores.csv', geoKey: 'GEOID', valueKey: 'score', name: 'Target index' },
}

let fake: FakeS3
let dataDir: string

async function seedLibrary(): Promise<void> {
  fake.seed('library/datasets/redevelopment-sites/meta.json', JSON.stringify(SITES_META))
  fake.seed('library/datasets/redevelopment-sites/redevelopment-sites.csv', SITES_CSV)
  fake.seed('library/datasets/transmission/meta.json', JSON.stringify(LINES_META))
  fake.seed('library/datasets/transmission/transmission.geojson', LINES_GEOJSON)
  fake.seed('library/datasets/target-index/meta.json', JSON.stringify(SCORES_META))
  fake.seed('library/datasets/target-index/scores.csv', 'GEOID,score\n47157,0.8\n')
  await reindexCatalog()
}

async function aSet(over: Record<string, unknown> = {}) {
  const made = await createWorkingSet({
    name: 'Memphis redevelopment',
    purpose: 'Which parcels can be redeveloped, and what bears on siting',
    datasets: ['transmission', 'target-index'],
    layers: ['internal-transmission', 'internal-target-index'],
    sites: 'redevelopment-sites',
    savedBy: 'maria',
    savedById: 1,
    ...over,
  })
  if (made.error) throw new Error(made.error)
  return made.slug
}

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-proximity-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  clearTabularCache()
  clearInternalLayerBounds()
  clearAnalysisInputMemo()
  await seedLibrary()
})

afterEach(async () => {
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

async function run(over: Record<string, unknown> = {}) {
  const slug = (over.set as string) ?? (await aSet())
  return runWorkingSetProximity({ set: slug, to: 'internal-transmission', by: 'maria', ...over } as any)
}

// --- Point to line, which is the headline case -------------------------------

describe('the measurement', () => {
  it('gives every located site a distance to the nearest line, written to the set', async () => {
    const slug = await aSet()
    const result = await run({ set: slug })

    expect(result.reused).toBe(false)
    expect(result.stats).toMatchObject({ rows: 8, measured: 6, withoutPoint: 2, targets: 2 })
    // Six located rows, each with a real number and a named nearest feature.
    const measured = result.perRow.filter(r => r.miles !== null)
    expect(measured).toHaveLength(6)
    expect(measured.every(r => r.nearest !== '')).toBe(true)

    // The Memphis rows measure to the TVA corridor, the Richmond row to the
    // Dominion loop — which is the whole point of relating two datasets.
    const xai = result.perRow.find(r => r.label === 'xAI supercomputer')!
    expect(xai.nearest).toBe('Allen–Southaven 500kV')
    expect(xai.miles).toBeCloseTo(2.95, 1)
    expect(result.perRow.find(r => r.label === 'Coherent Richmond')!.nearest).toBe('Richmond loop')
  })

  it('measures point-to-segment, not point-to-vertex', async () => {
    // The TVA corridor runs from 34.9 to 35.3 along -90.10. Every Memphis site
    // is abeam the middle of it, so a nearest-vertex answer would be tens of
    // miles out. This is the number P7-3 refused to fake with a centroid.
    const result = await run()
    const allen = result.perRow.find(r => r.label === 'TVA Allen Plant')!
    // Abeam: 0.04° of longitude at 35°N is about 2.3 miles.
    expect(allen.miles).toBeLessThan(3)
    // To the nearer END of the corridor is more than 11 miles.
    expect(allen.miles).toBeLessThan(11)
  })

  it('writes a derived column P7-2’s reader can read, keyed on the county GEOID', async () => {
    const slug = await aSet()
    await run({ set: slug })

    const set = await getWorkingSet(slug)
    const columns = readDerivedColumns(set!.derived)
    expect(columns.map(c => c.id)).toEqual(['miles-to-transmission'])
    expect(columns[0].unit).toBe('miles')
    expect(columns[0].label).toBe('Miles to nearest Transmission lines')

    // The constraint that is not negotiable: every key is a county.
    const values = readDerivedValues(columns[0].values)
    expect(Object.keys(values).sort()).toEqual(['04019', '47157', '51760'])
    expect(columns[0].computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(columns[0].method).toContain('point-to-segment')
  })

  it('takes the NEAREST of the four Memphis rows for their shared county', async () => {
    const slug = await aSet()
    const result = await run({ set: slug })
    const memphis = result.perRow.filter(r => r.geoid === '47157').map(r => r.miles as number)
    expect(memphis).toHaveLength(4)

    const values = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)
    expect(values['47157']).toBeCloseTo(Math.min(...memphis), 9)
    // And it is strictly nearer than the furthest of them, or the aggregation
    // would be doing nothing.
    expect(values['47157']).toBeLessThan(Math.max(...memphis))
  })

  it('reports the two rows it could not place rather than scoring them', async () => {
    const result = await run()
    const unplaced = result.perRow.filter(r => r.miles === null)
    expect(unplaced.map(r => r.label)).toEqual([
      'MP Materials Rare Earh Production',
      'MP Materials Recycling Center',
    ])
    expect(result.method).toContain('2 rows have no coordinates')
  })

  it('counts features within n miles as a second column', async () => {
    const slug = await aSet()
    const result = await run({ set: slug, within: 5 })

    expect(result.columns.map(c => c.id)).toEqual(['miles-to-transmission', 'miles-to-transmission-within-5mi'])
    expect(result.columns[1].unit).toBe('count')

    const columns = readDerivedColumns((await getWorkingSet(slug))!.derived)
    const counts = readDerivedValues(columns[1]!.values)
    expect(counts['47157']).toBe(1)
    // Tucson is nowhere near either corridor — zero is the FINDING, not a gap.
    expect(counts['04019']).toBe(0)
    expect(columns[1].label).toBe('Transmission lines within 5 miles')
  })

  it('counts a county’s rows’ distinct features, never the sum', async () => {
    const slug = await aSet()
    const result = await run({ set: slug, within: 400 })
    // At 400 miles every Memphis row reaches the one TVA corridor; four rows
    // reaching the same wire is one wire.
    const counts = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[1]!.values)
    expect(counts['47157']).toBe(1)
    expect(result.perRow.filter(r => r.geoid === '47157').every(r => r.within === 1)).toBe(true)
  })
})

// --- Neither source is modified ----------------------------------------------

describe('the sources', () => {
  it('modifies neither dataset — provenance stays clean and both stay re-fetchable', async () => {
    const before = new Map([...fake.objects].filter(([key]) => key.startsWith('library/datasets/')))
    expect(before.size).toBe(6)

    await run()

    for (const [key, value] of before) {
      expect(fake.objects.get(key), key).toEqual(value)
    }
    // And the catalog rows for both are byte-identical too.
    expect((await getCatalogEntry('redevelopment-sites'))!.meta).toMatchObject({ title: 'Redevelopment sites' })
    expect((await getCatalogEntry('transmission'))!.meta.layer).toMatchObject({ geometry: 'line' })
  })

  it('writes only inside the set’s own directory', async () => {
    const slug = await aSet()
    const before = new Set(fake.objects.keys())
    await run({ set: slug })
    const added = [...fake.objects.keys()].filter(key => !before.has(key))
    expect(added.every(key => key.startsWith(workingSetPrefix(slug)))).toBe(true)
  })

  it('leaves everything else about the set exactly as it was', async () => {
    const slug = await aSet()
    const before = await getWorkingSet(slug)
    await run({ set: slug })
    const after = await getWorkingSet(slug)
    expect({ ...after, derived: undefined, updatedAt: undefined }).toEqual({
      ...before,
      derived: undefined,
      updatedAt: undefined,
    })
  })

  it('survives a set edit, which is what P7-1 left the field unreachable for', async () => {
    const slug = await aSet()
    await run({ set: slug })
    await updateWorkingSet(slug, { datasets: ['transmission', 'target-index', 'redevelopment-sites'], purpose: 'Changed' })
    const after = await getWorkingSet(slug)
    expect(readDerivedColumns(after!.derived)).toHaveLength(1)
    expect(after!.purpose).toBe('Changed')
  })
})

// --- The row-level detail, which is what a story quotes ----------------------

describe('the per-row numbers', () => {
  it('stores them beside the manifest, so a cited number outlives the response', async () => {
    const slug = await aSet()
    await run({ set: slug })
    const key = `${workingSetPrefix(slug)}derived/miles-to-transmission.rows.json`
    expect(fake.objects.has(key)).toBe(true)

    const stored = await listWorkingSetProximity(slug)
    expect(stored).toHaveLength(1)
    expect(stored[0].rows).toHaveLength(8)
    expect(stored[0].rows.find(r => r.label === 'xAI supercomputer')!.miles).toBeCloseTo(2.95, 1)
    expect(stored[0].analysis).toMatchObject({ type: 'proximity', from: 'redevelopment-sites', to: 'internal-transmission', by: 'maria' })
  })

  it('lands in the catalog row’s file list, so a reindex rebuilds the same row', async () => {
    const slug = await aSet()
    await run({ set: slug })
    const written = await getCatalogEntry(slug)
    await reindexCatalog()
    const rebuilt = await getCatalogEntry(slug)
    expect(rebuilt!.files.map(f => f.key).sort()).toEqual(written!.files.map(f => f.key).sort())
    expect(rebuilt!.bytes).toBe(written!.bytes)
    expect(rebuilt!.files).toHaveLength(2)
  })
})

// --- Reuse -------------------------------------------------------------------

describe('a re-run with unchanged inputs', () => {
  it('reuses the stored result and computes nothing', async () => {
    const slug = await aSet()
    const first = await run({ set: slug })
    const manifest = fake.objects.get(workingSetKey(slug))

    const second = await run({ set: slug })
    expect(second.reused).toBe(true)
    expect(second.computedAt).toBe(first.computedAt)
    expect(second.perRow).toEqual(first.perRow)
    // Nothing was written: the manifest is byte-identical.
    expect(fake.objects.get(workingSetKey(slug))).toEqual(manifest)
  })

  it('recomputes when the radius changes, because that is a different question', async () => {
    const slug = await aSet()
    await run({ set: slug })
    const second = await run({ set: slug, within: 5 })
    expect(second.reused).toBe(false)
  })

  it('recomputes when asked to, and keeps the column in its place', async () => {
    const slug = await aSet()
    const first = await run({ set: slug })
    const again = await run({ set: slug, recompute: true })
    expect(again.reused).toBe(false)
    expect(again.computedAt).not.toBe(first.computedAt)
    expect(readDerivedColumns((await getWorkingSet(slug))!.derived)).toHaveLength(1)
  })

  it('matches on the inputs, which is what `storedProximity` compares', async () => {
    const derived = [
      { id: 'a', analysis: { type: 'proximity', from: 'sites', to: 'internal-x', within: null } },
      { id: 'b', analysis: { type: 'weighted-index', from: 'sites', to: 'internal-x', within: null } },
    ]
    // It returns the ANALYSIS record, which is what the comparison is made of.
    expect(storedProximity(derived, { from: 'sites', to: 'internal-x', within: null })).toMatchObject({
      type: 'proximity',
      from: 'sites',
      to: 'internal-x',
    })
    expect(storedProximity(derived, { from: 'sites', to: 'internal-y', within: null })).toBeNull()
    expect(storedProximity(derived, { from: 'sites', to: 'internal-x', within: 5 })).toBeNull()
    expect(storedProximity(derived, { from: 'other', to: 'internal-x', within: null })).toBeNull()
    // A column with no analysis record at all is not a proximity result.
    expect(storedProximity([{ id: 'c', values: {} }], { from: 'sites', to: 'internal-x', within: null })).toBeNull()
  })
})

// --- P7-6: stored, not recomputed -------------------------------------------

/** Rewrite one of the inputs and let the catalog see it. */
async function rewrite(key: string, body: string, at = new Date('2026-10-20T00:00:00.000Z')): Promise<void> {
  fake.seed(key, body, at)
  await reindexCatalog()
  clearTabularCache()
  clearInternalLayerBounds()
  clearAnalysisInputMemo()
}

const SITES_KEY = 'library/datasets/redevelopment-sites/redevelopment-sites.csv'
const LINES_KEY = 'library/datasets/transmission/transmission.geojson'

describe('what a stored result records about its inputs (P7-6)', () => {
  it('records both inputs, their files and a fingerprint of their bytes', async () => {
    const slug = await aSet()
    await run({ set: slug })

    const analysis = (readDerivedColumns((await getWorkingSet(slug))!.derived)[0] as any).analysis
    expect(analysis.inputs).toHaveLength(2)
    expect(analysis.inputs[0]).toMatchObject({
      slug: 'redevelopment-sites',
      role: 'from',
      file: 'redevelopment-sites.csv',
      bytes: Buffer.byteLength(SITES_CSV),
      content: fingerprintOf(SITES_CSV),
    })
    expect(analysis.inputs[1]).toMatchObject({
      slug: 'transmission',
      role: 'to',
      file: 'transmission.geojson',
      content: fingerprintOf(LINES_GEOJSON),
    })
    // Who and when were already there (P7-5); the versions are what P7-6 adds
    // to the SAME record, rather than beside it.
    expect(analysis).toMatchObject({ type: 'proximity', by: 'maria' })
    expect(analysis.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is SERVED, not recomputed, when the inputs are unchanged', async () => {
    const slug = await aSet()
    const first = await run({ set: slug })
    expect(first.served).toBe('computed')

    const second = await run({ set: slug })
    expect(second.served).toBe('stored')
    expect(second.reused).toBe(true)
    expect(second.freshness).toBe('fresh')
    expect(second.staleNote).toBe('')
    expect(second.computedAt).toBe(first.computedAt)
  })

  it('serves with both source files GONE — the proof that nothing recomputed', async () => {
    const slug = await aSet()
    const first = await run({ set: slug })

    // Take both inputs away from under it: out of the bucket, out of the local
    // mirror, out of the parse cache and out of the fingerprint memo. The
    // catalog row is deliberately NOT reindexed, so it still says both files
    // are there at the sizes the run recorded — which is the state a server
    // is in between pushes.
    //
    // This is the strongest available form of "nothing recomputed": a
    // measurement is now impossible. If the result still comes back, it was
    // stored and served.
    fake.objects.delete(SITES_KEY)
    fake.objects.delete(LINES_KEY)
    rmSync(dataDir, { recursive: true, force: true })
    clearTabularCache()
    clearInternalLayerBounds()
    clearAnalysisInputMemo()
    fake.calls.length = 0

    const second = await run({ set: slug })
    expect(second.served).toBe('stored')
    expect(second.freshness).toBe('fresh')
    expect(second.computedAt).toBe(first.computedAt)
    expect(second.perRow).toEqual(first.perRow)

    // Neither input was asked for, from the bucket or anywhere else.
    expect(fake.calls.filter(c => c.includes('redevelopment-sites.csv'))).toEqual([])
    expect(fake.calls.filter(c => c.includes('transmission.geojson'))).toEqual([])
    // And nothing was written: a serve that rewrote the manifest would not be
    // a serve.
    expect(fake.calls.filter(c => c.startsWith('PutObjectCommand:'))).toEqual([])

    // The same run with the files actually missing and the stored result
    // discarded cannot answer — which is what makes the assertion above mean
    // something rather than being true by accident.
    await expect(run({ set: slug, recompute: true })).rejects.toThrow()
  })

  it('recomputes when an input has changed, and says which', async () => {
    const slug = await aSet()
    const first = await run({ set: slug })
    // A twelfth site arrives in the table the measurement was from.
    await rewrite(SITES_KEY, `${SITES_CSV}\nNew Site,"Memphis, TN",35.07,-90.11,47157,census-address`)

    const second = await run({ set: slug })
    expect(second.served).toBe('computed')
    expect(second.staleNote).toContain('“redevelopment-sites” has changed')
    expect(second.computedAt).not.toBe(first.computedAt)
    // The new number, not the old one.
    expect(second.stats.rows).toBe(9)
  })

  it('recomputes when the LAYER has changed, not only the table', async () => {
    const slug = await aSet()
    await run({ set: slug })
    const moved = LINES_GEOJSON.replace('"Allen–Southaven 500kV"', '"Allen–Southaven 500kV, rebuilt"')
    await rewrite(LINES_KEY, moved)

    const second = await run({ set: slug })
    expect(second.served).toBe('computed')
    expect(second.staleNote).toContain('“transmission”')
  })

  it('still SERVES when only the clock moved — a re-push of identical bytes', async () => {
    const slug = await aSet()
    const first = await run({ set: slug })
    // The same bytes, pushed again, reindexed. Nothing about the answer
    // changed, so nothing may be recomputed: this is the test that fails if a
    // timestamp or a TTL is ever made the key.
    await rewrite(SITES_KEY, SITES_CSV)

    const second = await run({ set: slug })
    expect(second.served).toBe('stored')
    expect(second.computedAt).toBe(first.computedAt)
  })

  it('serves a result from before P7-6 rather than recomputing it, labelled unknown', async () => {
    const slug = await aSet()
    await run({ set: slug })
    // Strip the versions, which is exactly what a column written by P7-5 looks
    // like. Recomputing every one of those on sight would be the Railway
    // compute this ticket exists to avoid.
    const set = await getWorkingSet(slug)
    const derived = (set!.derived as any[]).map(c => ({ ...c, analysis: { ...c.analysis, inputs: undefined } }))
    const manifest = JSON.parse(fake.objects.get(workingSetKey(slug))!.toString('utf8'))
    fake.seed(workingSetKey(slug), JSON.stringify({ ...manifest, derived }))
    await reindexCatalog()
    clearAnalysisInputMemo()

    const second = await run({ set: slug })
    expect(second.served).toBe('stored')
    expect(second.freshness).toBe('unknown')
    expect(second.staleNote).toContain('before its inputs were recorded')
  })

  it('computes when told to, however fresh the stored result is', async () => {
    const slug = await aSet()
    await run({ set: slug })
    const again = await run({ set: slug, recompute: true })
    expect(again.served).toBe('computed')
    expect(again.staleNote).toBe('')
  })

  it('carries each analysis’s standing on the read side too', async () => {
    const slug = await aSet()
    await run({ set: slug })
    expect((await listWorkingSetProximity(slug))[0].freshness.verdict).toBe('fresh')

    await rewrite(SITES_KEY, SITES_CSV.replace('35.060080', '35.060081'))
    const listed = await listWorkingSetProximity(slug)
    // Still there, all its rows, with a sentence — never hidden, which is the
    // acceptance criterion.
    expect(listed).toHaveLength(1)
    expect(listed[0].rows.length).toBeGreaterThan(0)
    expect(listed[0].freshness.verdict).toBe('stale')
    expect(listed[0].freshness.note).toContain('rewritten since this ran')
  })
})

// --- The refusals ------------------------------------------------------------

describe('what it refuses, and what it says', () => {
  async function refusal(over: Record<string, unknown>): Promise<{ status: number; message: string }> {
    try {
      await run(over)
      throw new Error('expected a refusal')
    } catch (err: any) {
      expect(err).toBeInstanceOf(ProximityError)
      return { status: err.status, message: err.message }
    }
  }

  it('refuses a set that does not exist, by name', async () => {
    const { status, message } = await refusal({ set: 'no-such-set' })
    expect(status).toBe(404)
    expect(message).toBe('There is no working set called “no-such-set”.')
  })

  it('refuses a layer the set does not name, rather than reaching outside it', async () => {
    // Neither as a layer id nor as a member dataset: both spellings are
    // accepted on the way in, so both have to be absent for this to refuse.
    const slug = await aSet({ layers: [], datasets: ['target-index'] })
    const { status, message } = await refusal({ set: slug })
    expect(status).toBe(400)
    expect(message).toContain('is not a layer this working set names')
    expect(message).toContain('outside the set')
  })

  it('refuses a dataset the set does not name', async () => {
    const { status, message } = await refusal({ from: 'target-index-not-a-member' })
    expect(status).toBe(400)
    expect(message).toContain('is not in this working set')
  })

  it('refuses a set with no anchor and no `from`', async () => {
    const slug = await aSet({ sites: null })
    const { status, message } = await refusal({ set: slug })
    expect(status).toBe(400)
    expect(message).toContain('is not anchored on a dataset')
  })

  it('refuses a county layer, which has values rather than features', async () => {
    const { status, message } = await refusal({ to: 'internal-target-index' })
    expect(status).toBe(400)
    expect(message).toContain('is a county layer')
    expect(message).toContain('point or line layer')
  })

  it('refuses a table with no county column, naming the pass that makes one', async () => {
    fake.seed(
      'library/datasets/ungeocoded/meta.json',
      JSON.stringify({ title: 'Ungeocoded sites', status: 'published', category: 'land' }),
    )
    fake.seed('library/datasets/ungeocoded/sites.csv', 'name,lat,lng\nA,35.0,-90.1\n')
    await reindexCatalog()
    const slug = await aSet({ datasets: ['transmission', 'target-index', 'ungeocoded'] })

    const { status, message } = await refusal({ set: slug, from: 'ungeocoded' })
    expect(status).toBe(400)
    expect(message).toContain('no county FIPS column')
    expect(message).toContain('npm run library -- geocode')
  })

  it('refuses a table with no coordinates, naming the same pass', async () => {
    fake.seed(
      'library/datasets/addresses/meta.json',
      JSON.stringify({ title: 'Addresses', status: 'published', category: 'land' }),
    )
    fake.seed('library/datasets/addresses/a.csv', 'name,address,GEOID\nA,"Memphis, TN",47157\n')
    await reindexCatalog()
    const slug = await aSet({ datasets: ['transmission', 'target-index', 'addresses'] })

    const { status, message } = await refusal({ set: slug, from: 'addresses' })
    expect(status).toBe(400)
    expect(message).toContain('no latitude and longitude')
    expect(message).toContain('npm run library -- geocode')
  })

  it('refuses a “within” radius that is not a question about proximity', async () => {
    const { status, message } = await refusal({ within: 5000 })
    expect(status).toBe(413)
    expect(message).toContain('500 miles is the widest')
  })

  it('refuses a column id a URL could not carry', async () => {
    const { status, message } = await refusal({ id: 'Not An Id!' })
    expect(status).toBe(400)
    expect(message).toContain('is not a column id')
  })
})

// --- The ceiling -------------------------------------------------------------

describe('the ceiling', () => {
  it('refuses a whole-layer derivation with a sentence naming the local pass', async () => {
    // 6,000 rows is over the on-demand ceiling. Written as a real table so the
    // refusal is reached through the real reader, not a stubbed count.
    const header = 'name,lat,lng,GEOID\n'
    const rows = Array.from(
      { length: 6_000 },
      (_, i) => `Brownfield ${i},${35 + (i % 100) / 1000},${-90 - (i % 100) / 1000},47157`,
    ).join('\n')
    fake.seed(
      'library/datasets/brownfields/meta.json',
      JSON.stringify({ title: 'Brownfields', status: 'published', category: 'land' }),
    )
    fake.seed('library/datasets/brownfields/brownfields.csv', header + rows)
    await reindexCatalog()
    const slug = await aSet({ datasets: ['transmission', 'target-index', 'brownfields'] })

    let caught: any
    try {
      await runWorkingSetProximity({ set: slug, from: 'brownfields', to: 'internal-transmission' })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ProximityError)
    expect(caught.status).toBe(413)
    expect(caught.message).toContain('6,000 rows is a batch job, not a request')
    expect(caught.message).toContain('npm run library -- proximity')

    // And nothing was written — a refusal is not a half-run.
    expect(readDerivedColumns((await getWorkingSet(slug))!.derived)).toHaveLength(0)
  })
})
