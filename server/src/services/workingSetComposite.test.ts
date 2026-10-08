import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { newDb } from 'pg-mem'
import type { Pool as PgPool } from 'pg'
import type { S3Client } from '@aws-sdk/client-s3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FakeS3 } from '../testutils/fakeS3.js'

/**
 * A weighted index over a working set (P7-8) — the on-demand tier.
 *
 * The real catalog, the real bucket, the real tabular reader and the real
 * layer projection, like P7-5's proximity suite: what is judged here is the
 * seam between them, so nothing is injected. The fixture is the workbook's own
 * question in miniature — a *political efficacy* index over a race indicator
 * and a class indicator, one of which is a public registry layer and one of
 * which is a held internal layer, because the whole point of generalising the
 * Lens is that those two kinds of layer can appear in one formula.
 */

process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET || 'test-secret-0123456789abcdef0123456789abcdef'

const { initLibraryDb, closeLibraryDb } = await import('./libraryDb.js')
const { initLibraryBucket, closeLibraryBucket } = await import('./libraryBucket.js')
const { reindexCatalog } = await import('./libraryCatalog.js')
const { createWorkingSet, getWorkingSet, putDerivedColumns } = await import('./libraryWorkingSets.js')
const { workingSetPrefix } = await import('./workingSetMeta.js')
const { readDerivedColumns, readDerivedValues, rerunOf } = await import('./workingSetColumns.js')
const { clearTabularCache } = await import('./libraryTabular.js')
const { clearInternalLayerBounds, listInternalLayers, readInternalLayerValues } = await import('./internalLayers.js')
const { clearAnalysisInputMemo, checkAnalysisInputs } = await import('./analysisInputs.js')
const { clearPublicLayerCache } = await import('./publicLayerValues.js')
const { CompositeError, listWorkingSetComposites, runWorkingSetComposite, storedComposite } = await import(
  './workingSetComposite.js'
)

function memPool(): PgPool {
  const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
  return new Pool() as unknown as PgPool
}

// --- The fixture -------------------------------------------------------------

/** A held county layer: Black voter registration by county. Six counties, a
 *  real spread, and one county only this layer covers — so "missing data
 *  divides by the full declared weight" is exercised by the data. */
const VOTES_CSV = [
  'GEOID,registered_pct',
  '47157,61.4',
  '51760,72.8',
  '04019,44.1',
  '01001,38.6',
  '13121,80.2',
  '29510,55.0',
].join('\n')

const VOTES_META = {
  title: 'Black voter registration',
  status: 'published',
  category: 'equity',
  layer: {
    geometry: 'county',
    name: 'Black voter registration',
    file: 'votes.csv',
    geoKey: 'GEOID',
    valueKey: 'registered_pct',
    dataType: 'percentage',
    unit: '%',
    direction: 'higher_better',
  },
}

/** A second held county layer, missing two of the six counties above. */
const TURNOUT_CSV = ['GEOID,turnout_pct', '47157,48.2', '51760,66.0', '04019,31.5', '13121,70.9'].join('\n')

const TURNOUT_META = {
  title: 'Local election turnout',
  status: 'published',
  category: 'equity',
  layer: {
    geometry: 'county',
    name: 'Local election turnout',
    file: 'turnout.csv',
    geoKey: 'GEOID',
    valueKey: 'turnout_pct',
    dataType: 'percentage',
    unit: '%',
    direction: 'higher_better',
  },
}

/** A flat layer — the same number everywhere — so the refusal that stops a
 *  constant term silently scaling the whole index has something to refuse. */
const FLAT_META = {
  title: 'Flat layer',
  status: 'published',
  category: 'equity',
  layer: { geometry: 'county', name: 'Flat layer', file: 'flat.csv', geoKey: 'GEOID', valueKey: 'v' },
}

/** A point layer, so "an index over features" can be refused by name. */
const SITES_META = {
  title: 'Redevelopment sites',
  status: 'published',
  category: 'land',
  layer: {
    geometry: 'point',
    name: 'Redevelopment sites',
    file: 'sites.csv',
    latKey: 'lat',
    lngKey: 'lng',
    labelKey: 'name',
    popupFields: [],
  },
}

let fake: FakeS3
let dataDir: string

async function seedLibrary(): Promise<void> {
  fake.seed('library/datasets/votes/meta.json', JSON.stringify(VOTES_META))
  fake.seed('library/datasets/votes/votes.csv', VOTES_CSV)
  fake.seed('library/datasets/turnout/meta.json', JSON.stringify(TURNOUT_META))
  fake.seed('library/datasets/turnout/turnout.csv', TURNOUT_CSV)
  fake.seed('library/datasets/flat/meta.json', JSON.stringify(FLAT_META))
  fake.seed('library/datasets/flat/flat.csv', 'GEOID,v\n47157,7\n51760,7\n')
  fake.seed('library/datasets/sites/meta.json', JSON.stringify(SITES_META))
  fake.seed('library/datasets/sites/sites.csv', 'name,lat,lng\nxAI,35.06,-90.15\n')
  await reindexCatalog()
}

/** The set names both held layers, a public registry layer, the point layer
 *  and the flat one — so every refusal below is about the formula and never
 *  about membership. */
async function aSet(over: Record<string, unknown> = {}) {
  const made = await createWorkingSet({
    name: 'Political efficacy',
    purpose: 'Where engagement is strongest, from class and race indicators',
    datasets: ['votes', 'turnout', 'flat', 'sites'],
    layers: ['internal-votes', 'internal-turnout', 'internal-flat', 'internal-sites', 'pct_Black', 'poverty_by_race'],
    savedBy: 'maria',
    savedById: 1,
    ...over,
  })
  if (made.error) throw new Error(made.error)
  return made.slug
}

const TWO_HELD = [
  { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
  { layer: 'internal-turnout', weight: 4, direction: 'higher_better' },
]

beforeEach(async () => {
  expect(await initLibraryDb(memPool())).toBe(true)
  fake = new FakeS3()
  dataDir = mkdtempSync(join(tmpdir(), 'blo-composite-'))
  await initLibraryBucket({ client: fake as unknown as S3Client, bucket: 'test-bucket', dataDir })
  clearTabularCache()
  clearInternalLayerBounds()
  clearAnalysisInputMemo()
  clearPublicLayerCache()
  delete process.env.COMPOSITE_BYTES_BUDGET
  await seedLibrary()
})

afterEach(async () => {
  delete process.env.COMPOSITE_BYTES_BUDGET
  await closeLibraryBucket()
  await closeLibraryDb()
  rmSync(dataDir, { recursive: true, force: true })
})

async function build(over: Record<string, unknown> = {}) {
  const slug = (over.set as string) ?? (await aSet())
  return runWorkingSetComposite({
    set: slug,
    label: 'Political efficacy',
    terms: TWO_HELD,
    by: 'maria',
    ...over,
  } as any)
}

// --- The index itself --------------------------------------------------------

describe('the index', () => {
  it('writes one GEOID-keyed derived column P7-2’s reader can read', async () => {
    const slug = await aSet()
    const run = await build({ set: slug })

    expect(run.served).toBe('computed')
    expect(run.column).toBe('political-efficacy')
    expect(run.label).toBe('Political efficacy')

    const set = await getWorkingSet(slug)
    const columns = readDerivedColumns(set!.derived)
    expect(columns.map(c => c.id)).toEqual(['political-efficacy'])
    expect(columns[0].unit).toBe('index')
    const values = readDerivedValues(columns[0].values)
    // Every county either layer covers, keyed on a 5-digit GEOID.
    expect(Object.keys(values).sort()).toEqual(['01001', '04019', '13121', '29510', '47157', '51760'])
    for (const value of Object.values(values)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(100)
    }
  })

  it('ranks the counties the way the weights say, and penalises the incomplete ones', async () => {
    const run = await build()
    const set = await getWorkingSet(run.set)
    const values = readDerivedValues(readDerivedColumns(set!.derived)[0].values)

    // 13121 is top of both layers, so it is the only 100.
    expect(values['13121']).toBe(100)
    // 29510 and 01001 carry only the registration layer (weight 6 of 10), so
    // neither can beat a county that carries both — the Lens's own rule, which
    // keeps incomplete counties in the ranking rather than letting one layer
    // pump them to the top.
    expect(values['29510']).toBeLessThan(60)
    expect(values['01001']).toBe(0)
    expect(run.complete).toBe(4)
    expect(run.partial).toBe(2)
  })

  it('records the scale each term was normalised against, so the 0 and 100 can be read back', async () => {
    const run = await build()
    expect(run.scales).toEqual([
      // P9-4: `scale` says WHICH span the 0-100 was measured against. These
      // held layers pin no range, so both read `observed`.
      { layer: 'internal-turnout', weight: 4, direction: 'higher_better', min: 31.5, max: 70.9, counties: 4, scale: 'observed' },
      { layer: 'internal-votes', weight: 6, direction: 'higher_better', min: 38.6, max: 80.2, counties: 6, scale: 'observed' },
    ])
  })

  /**
   * P9-4, the point of the ticket. A registry layer pins a range, and the
   * Lens scales against that literal. If this scaled against the observed
   * span instead, the same weights would produce a different number and
   * "the index is a working set" would silently move published scores.
   */
  it('scales a registry layer against the range the registry pins, like the Lens does', async () => {
    const run = await build({
      label: 'Public terms',
      terms: [
        { layer: 'pct_Black', weight: 5, direction: 'higher_better' },
        { layer: 'internal-votes', weight: 5, direction: 'higher_better' },
      ],
    })
    const scale = run.scales.find(x => x.layer === 'pct_Black')
    expect(scale).toBeDefined()
    expect(scale!.scale).toBe('pinned')
    // A percentage runs 0-100 whether or not any county reaches either end.
    expect(scale!.min).toBe(0)
    expect(scale!.max).toBe(100)
  })

  /**
   * P9-4. The two calls a researcher makes, both stored with the result, so
   * a number can be read back as "this index, under these rules".
   */
  it('stores the missing-data rule it was run under', async () => {
    const run = await build({ label: 'Strict', missing: 'ignore' })
    expect(run.missing).toBe('ignore')
  })

  it('defaults the rule rather than leaving it unsaid', async () => {
    const run = await build()
    expect(run.missing).toBe('penalise')
  })

  it('refuses a rule it does not know, in words a person can act on', async () => {
    await expect(build({ label: 'Odd', missing: 'sideways' })).rejects.toThrow(/penalise|ignore/)
  })

  it('declares what it measures, in a method a column header can show', async () => {
    const run = await build()
    expect(run.method).toContain('Black voter registration ×6 higher is better')
    expect(run.method).toContain('Local election turnout ×4 higher is better')
    expect(run.method).toContain('6 counties, 4 with every layer')
    expect(run.method.length).toBeLessThanOrEqual(500)
  })

  it('mixes a public registry layer with a held one — the workbook’s actual question', async () => {
    const run = await build({
      label: 'Political efficacy',
      terms: [
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
        { layer: 'pct_Black', weight: 4, direction: 'higher_better' },
        { layer: 'poverty_by_race', weight: 4, direction: 'lower_better' },
      ],
    })
    expect(run.served).toBe('computed')
    // The public layers cover the whole country, so the index does too.
    expect(run.counties).toBeGreaterThan(3000)
    expect(run.scales.map(s => s.layer)).toEqual(['internal-votes', 'pct_Black', 'poverty_by_race'])

    // And each public term is recorded as an input with a version, so the
    // staleness machinery can check it like any other.
    const set = await getWorkingSet(run.set)
    const analysis = readDerivedColumns(set!.derived)[0].analysis as any
    const pub = analysis.inputs.find((i: any) => i.slug === 'pct_Black')
    expect(pub).toMatchObject({ role: 'term', source: 'public' })
    expect(pub.bytes).toBeGreaterThan(0)
    expect(pub.content).toMatch(/^[0-9a-f]{16}$/)
    expect((await checkAnalysisInputs(analysis.inputs)).verdict).toBe('fresh')
  })
})

// --- Reproducibility, which is the acceptance criterion that matters ---------

describe('reproducibility', () => {
  it('produces byte-identical values when the same definition is run again', async () => {
    const slug = await aSet()
    await build({ set: slug })
    const first = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)

    // Force the work rather than serving the stored answer, and clear every
    // cache between: this has to be the arithmetic agreeing, not a memo.
    clearTabularCache()
    clearAnalysisInputMemo()
    clearPublicLayerCache()
    await build({ set: slug, recompute: true })
    const second = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('reproduces from the SAVED definition, read back off the manifest', async () => {
    // The criterion is about the saved definition, not about the arguments the
    // caller still has in hand — so this re-runs from what `rerunOf` reads off
    // the stored record, which is exactly what the button on the page sends.
    const slug = await aSet()
    await build({ set: slug })
    const stored = readDerivedColumns((await getWorkingSet(slug))!.derived)[0]
    const before = readDerivedValues(stored.values)

    const rerun = rerunOf(stored.analysis)
    expect(rerun).toEqual({
      type: 'composite',
      terms: [
        { layer: 'internal-turnout', weight: 4, direction: 'higher_better' },
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
      ],
    })

    clearTabularCache()
    const again = await runWorkingSetComposite({
      set: slug,
      label: stored.label,
      id: stored.id,
      terms: (rerun as any).terms,
      recompute: true,
      by: 'maria',
    })
    expect(again.served).toBe('computed')
    const after = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect(again.scales).toEqual((stored.analysis as any).scales)
  })

  it('does not depend on the order the formula was typed in', async () => {
    const slug = await aSet()
    await build({ set: slug })
    const first = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)

    const other = await aSet({ name: 'Political efficacy two' })
    await build({ set: other, terms: [...TWO_HELD].reverse() })
    const second = readDerivedValues(readDerivedColumns((await getWorkingSet(other))!.derived)[0].values)

    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('stores the formula canonically, so the same index typed either way is one index', async () => {
    const slug = await aSet()
    await build({ set: slug })
    const analysis = readDerivedColumns((await getWorkingSet(slug))!.derived)[0].analysis as any
    expect(analysis.terms.map((t: any) => t.layer)).toEqual(['internal-turnout', 'internal-votes'])
    expect(storedComposite([{ analysis }], [...TWO_HELD].reverse() as any)).not.toBeNull()
  })
})

// --- Served, not recomputed (P7-6's contract, inherited) ---------------------

describe('serving a stored index', () => {
  it('serves the stored result with nothing parsed, and says so', async () => {
    const slug = await aSet()
    await build({ set: slug })

    // P7-6's own proof, applied here: make computing IMPOSSIBLE and then ask
    // again. Both input files are deleted from the bucket, the local mirror is
    // wiped and every cache cleared — deliberately WITHOUT reindexing, so the
    // catalog still says the files are there at the sizes the run recorded,
    // which is the state a server is in between pushes.
    fake.objects.delete('library/datasets/votes/votes.csv')
    fake.objects.delete('library/datasets/turnout/turnout.csv')
    rmSync(dataDir, { recursive: true, force: true })
    clearTabularCache()
    clearAnalysisInputMemo()
    fake.calls.length = 0

    const served = await build({ set: slug })
    expect(served.served).toBe('stored')
    expect(served.reused).toBe(true)
    expect(served.freshness).toBe('fresh')
    expect(served.terms.map(t => t.layer)).toEqual(['internal-turnout', 'internal-votes'])

    // Neither input was asked for, and nothing was written.
    expect(fake.calls.some(c => c.endsWith('votes.csv'))).toBe(false)
    expect(fake.calls.some(c => c.endsWith('turnout.csv'))).toBe(false)
    expect(fake.calls.some(c => c.startsWith('PutObjectCommand'))).toBe(false)
  })

  it('and the serve is not true by accident: forcing the work throws', async () => {
    const slug = await aSet()
    await build({ set: slug })
    fake.objects.delete('library/datasets/votes/votes.csv')
    rmSync(dataDir, { recursive: true, force: true })
    clearTabularCache()
    await expect(build({ set: slug, recompute: true })).rejects.toThrow()
  })

  it('recomputes when an input has changed, and says which', async () => {
    const slug = await aSet()
    await build({ set: slug })
    const before = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)

    // One digit, same byte count: the edit a byte count cannot see and only
    // the content hash catches. Asserted identical in size first, so the test
    // is about the hash and not about the cheaper half of the check.
    const edited = VOTES_CSV.replace('61.4', '91.4')
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(VOTES_CSV))
    fake.seed('library/datasets/votes/votes.csv', edited)
    await reindexCatalog()
    clearTabularCache()
    clearAnalysisInputMemo()

    const again = await build({ set: slug })
    expect(again.served).toBe('computed')
    expect(again.staleNote).toContain('“votes” has been rewritten since this ran')
    // And the number actually moved: 47157 was mid-pack on the registration
    // layer and is now top of it. The point of recomputing is that the stored
    // number was wrong, so a test that only checked `served` would pass on an
    // implementation that recomputed and wrote the old values back.
    const values = readDerivedValues(readDerivedColumns((await getWorkingSet(slug))!.derived)[0].values)
    expect(values['47157']).toBeGreaterThan(before['47157'])
  })

  it('serves an index whose inputs cannot be checked rather than recomputing it', async () => {
    const slug = await aSet()
    // A pre-P7-8 shaped record: a formula, no inputs. Recomputing every one of
    // these on sight is the compute P7-6 exists to avoid.
    await putDerivedColumns(slug, [
      {
        id: 'political-efficacy',
        label: 'Political efficacy',
        unit: 'index',
        method: 'by hand',
        values: { '47157': 42 },
        analysis: { type: 'composite', terms: TWO_HELD, columns: ['political-efficacy'], by: '', at: '2026-01-01T00:00:00.000Z' },
      },
    ])
    const served = await build({ set: slug })
    expect(served.served).toBe('stored')
    expect(served.freshness).toBe('unknown')
  })
})

// --- A composite IS a layer --------------------------------------------------

describe('drawing it', () => {
  it('appears in the internal layer manifest as a county layer on 0-100', async () => {
    const slug = await aSet()
    const run = await build({ set: slug })

    const manifest = await listInternalLayers()
    const layer = manifest.find(l => l.id === run.layerId)
    expect(layer).toBeDefined()
    expect(layer).toMatchObject({
      slug: `${slug}~political-efficacy`,
      geometry: 'county',
      name: 'Political efficacy',
      dataType: 'index',
      direction: 'higher_better',
      range: { min: 0, max: 100 },
    })
    expect(layer!.description).toBe(run.method)
  })

  it('serves its values through the layer route, computing nothing', async () => {
    const slug = await aSet()
    const run = await build({ set: slug })

    // Delete the inputs: drawing a stored index must not reach for them.
    fake.objects.delete('library/datasets/votes/votes.csv')
    fake.objects.delete('library/datasets/turnout/turnout.csv')
    clearTabularCache()

    const values = await readInternalLayerValues(`${slug}~political-efficacy`)
    expect(values.geometry).toBe('county')
    expect((values as any).range).toEqual({ min: 0, max: 100 })
    expect((values as any).count).toBe(6)
    expect((values as any).values['13121']).toBe(100)
  })

  it('does NOT list a proximity column as a layer, because nothing says which end is good', async () => {
    const slug = await aSet()
    await putDerivedColumns(slug, [
      {
        id: 'miles-to-transmission',
        label: 'Miles to nearest Transmission lines',
        unit: 'miles',
        method: 'great-circle miles',
        values: { '47157': 1.2 },
        analysis: { type: 'proximity', from: 'sites', to: 'internal-transmission', within: null, columns: ['miles-to-transmission'], by: '', at: '2026-01-01T00:00:00.000Z' },
      },
    ])
    const manifest = await listInternalLayers()
    expect(manifest.some(l => l.slug === `${slug}~miles-to-transmission`)).toBe(false)
    await expect(readInternalLayerValues(`${slug}~miles-to-transmission`)).rejects.toThrow(/not found/)
  })

  it('a derived layer cannot be a term, because staleness does not chain', async () => {
    const slug = await aSet()
    const run = await build({ set: slug })
    const other = await aSet({ name: 'Second set', layers: ['internal-votes', run.layerId] })
    await expect(
      runWorkingSetComposite({
        set: other,
        label: 'Index of an index',
        terms: [
          { layer: 'internal-votes', weight: 1, direction: 'higher_better' },
          { layer: run.layerId, weight: 1, direction: 'higher_better' },
        ],
        by: 'maria',
      }),
    ).rejects.toThrow(/an index over an index would need a chain of staleness/)
  })
})

// --- Refusals ----------------------------------------------------------------

describe('refusals', () => {
  it('refuses a set that does not exist, with a sentence', async () => {
    await expect(build({ set: 'no-such-set' })).rejects.toMatchObject({
      status: 404,
      message: 'There is no working set called “no-such-set”.',
    })
  })

  it('refuses a layer the set does not name', async () => {
    // Neither as a layer nor as a dataset: the same two spellings of
    // membership `layerBFor` forgives for proximity.
    const slug = await aSet({ layers: ['internal-votes'], datasets: ['votes'] })
    await expect(build({ set: slug })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('“internal-turnout” is not a layer this working set names'),
    })
  })

  it('refuses a point layer by name — an index is over county values', async () => {
    const slug = await aSet()
    await expect(
      build({
        set: slug,
        terms: [
          { layer: 'internal-votes', weight: 1, direction: 'higher_better' },
          { layer: 'internal-sites', weight: 1, direction: 'higher_better' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('is a point layer') })
  })

  it('refuses a flat term rather than quietly scaling the whole index down', async () => {
    const slug = await aSet()
    await expect(
      build({
        set: slug,
        terms: [
          { layer: 'internal-votes', weight: 1, direction: 'higher_better' },
          { layer: 'internal-flat', weight: 1, direction: 'higher_better' },
        ],
      }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('ranks nothing') })
  })

  it('refuses an unnamed index, because an unnamed number cannot be cited', async () => {
    const slug = await aSet()
    await expect(build({ set: slug, label: '  ' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('An index needs a name'),
    })
  })

  it('refuses to overwrite a differently-typed column with the same id', async () => {
    const slug = await aSet()
    await putDerivedColumns(slug, [
      {
        id: 'political-efficacy',
        label: 'Miles to something',
        unit: 'miles',
        method: '',
        values: { '47157': 1 },
        analysis: { type: 'proximity', from: 'sites', to: 'internal-votes', within: null, columns: ['political-efficacy'], by: '', at: '2026-01-01T00:00:00.000Z' },
      },
    ])
    await expect(build({ set: slug })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('already has a proximity column called “political-efficacy”'),
    })
  })

  it('refuses past the byte budget before opening anything, and writes nothing', async () => {
    const slug = await aSet()
    // Low enough that the two small fixtures exceed it. The budget is read off
    // the catalog, so this refusal costs no parse at all.
    process.env.COMPOSITE_BYTES_BUDGET = '10'
    await expect(build({ set: slug })).rejects.toMatchObject({
      status: 413,
      message: expect.stringContaining('npm run library -- index'),
    })
    // A refusal is never a half-run.
    const set = await getWorkingSet(slug)
    expect(readDerivedColumns(set!.derived)).toHaveLength(0)
  })
})

// --- The read side -----------------------------------------------------------

describe('listWorkingSetComposites', () => {
  it('gives each index its saved formula, its scales and its standing', async () => {
    const slug = await aSet()
    await build({ set: slug })
    const indices = await listWorkingSetComposites(slug)
    expect(indices).toHaveLength(1)
    expect(indices[0].column).toBe('political-efficacy')
    expect(indices[0].label).toBe('Political efficacy')
    expect(indices[0].analysis.terms).toHaveLength(2)
    expect(indices[0].analysis.scales).toHaveLength(2)
    expect(indices[0].freshness.verdict).toBe('fresh')
  })

  it('reports a changed input as stale without hiding the index', async () => {
    const slug = await aSet()
    await build({ set: slug })
    fake.seed('library/datasets/turnout/turnout.csv', `${TURNOUT_CSV}\n29510,40.0`)
    await reindexCatalog()
    clearAnalysisInputMemo()

    const [index] = await listWorkingSetComposites(slug)
    expect(index.freshness.verdict).toBe('stale')
    expect(index.freshness.note).toContain('“turnout” has changed since this ran')
    // Still there, formula and all.
    expect(index.analysis.terms).toHaveLength(2)
  })

  it('ignores a working set with no indices rather than failing', async () => {
    expect(await listWorkingSetComposites(await aSet())).toEqual([])
    expect(await listWorkingSetComposites('no-such-set')).toEqual([])
  })
})

describe('the set’s own directory', () => {
  it('keeps a route-written index and a reindexed one the same row', async () => {
    // P7-1's load-bearing invariant, and P7-5 found the bug that breaks it.
    const slug = await aSet()
    await build({ set: slug })
    const before = (await getWorkingSet(slug))!
    await reindexCatalog()
    const after = (await getWorkingSet(slug))!
    expect(readDerivedColumns(after.derived)).toEqual(readDerivedColumns(before.derived))
    expect([...fake.objects.keys()].filter(k => k.startsWith(workingSetPrefix(slug)))).toEqual([`${workingSetPrefix(slug)}meta.json`])
  })
})
