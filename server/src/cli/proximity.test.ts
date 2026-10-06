import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * `npm run library -- proximity` (P7-5) — the bulk tier.
 *
 * Over a real temp tree, like `retag`'s suite: no bucket, no database. What
 * this file is judged on is that the local pass and the request **agree about
 * the number** — same primitive — while differing in the two ways they are
 * meant to: no ceiling here, and a manifest written on disk rather than to a
 * bucket.
 */

const { formatProximityReport, isLibraryTree, parseProximityArgs, runProximity } = await import('./proximity.js')

let dir: string

const SITES_CSV = [
  'name,lat,lng,GEOID',
  'xAI supercomputer,35.060080,-90.152192,47157',
  'TVA Allen Plant,35.065000,-90.140000,47157',
  'Coherent Richmond,37.540700,-77.436000,51760',
  'MP Materials Fort Worth,,,',
].join('\n')

const LINES_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { NAME: 'Allen–Southaven 500kV', OWNER: 'TVA' },
      geometry: { type: 'LineString', coordinates: [[-90.1, 34.9], [-90.1, 35.3]] },
    },
    {
      type: 'Feature',
      properties: { NAME: 'Richmond loop', OWNER: 'Dominion' },
      geometry: { type: 'LineString', coordinates: [[-77.5, 37.5], [-77.5, 37.6]] },
    },
  ],
})

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), body, 'utf8')
}

async function seedTree(over: { setMeta?: Record<string, unknown> } = {}): Promise<void> {
  await write(
    'library/working-sets/memphis/meta.json',
    JSON.stringify(
      {
        title: 'Memphis redevelopment',
        category: 'working-sets',
        status: 'published',
        tags: [],
        purpose: 'Which parcels can be redeveloped',
        datasets: ['redevelopment-sites', 'transmission'],
        layers: ['internal-transmission'],
        sites: 'redevelopment-sites',
        savedBy: 'maria',
        savedById: 1,
        savedAt: '2026-10-06T00:00:00.000Z',
        ...over.setMeta,
      },
      null,
      2,
    ),
  )
  await write(
    'library/datasets/redevelopment-sites/meta.json',
    JSON.stringify({
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
    }),
  )
  await write('library/datasets/redevelopment-sites/sites.csv', SITES_CSV)
  await write(
    'library/datasets/transmission/meta.json',
    JSON.stringify({
      title: 'Transmission lines',
      status: 'published',
      category: 'network',
      layer: {
        geometry: 'line',
        name: 'Transmission lines',
        file: 'lines.geojson',
        pathKey: '_path',
        labelKey: 'NAME',
        popupFields: ['OWNER'],
        color: '#2b6cb0',
      },
    }),
  )
  await write('library/datasets/transmission/lines.geojson', LINES_GEOJSON)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'blo-proximity-cli-'))
  await seedTree()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const quiet = () => {}

async function setManifest(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, 'library/working-sets/memphis/meta.json'), 'utf8'))
}

// --- Arguments ---------------------------------------------------------------

describe('parseProximityArgs', () => {
  it('reads the set, the layer and the options', () => {
    expect(parseProximityArgs(['proximity', 'memphis', '--to', 'internal-transmission', '--within', '5', '--apply'])).toEqual({
      set: 'memphis',
      to: 'internal-transmission',
      within: 5,
      apply: true,
    })
  })

  it('is a dry run unless --apply, which is retag’s rule and not geocode’s', () => {
    const parsed = parseProximityArgs(['proximity', 'memphis', '--to', 'transmission'])
    expect(parsed).toMatchObject({ apply: false })
  })

  it('does not mistake the --dir value for the set', () => {
    expect(parseProximityArgs(['proximity', '--dir', '/tmp/tree', 'memphis', '--to', 'x'])).toMatchObject({
      set: 'memphis',
    })
  })

  it('says what is missing, in one sentence', () => {
    expect(parseProximityArgs(['proximity'])).toMatchObject({ error: /missing <working-set>/ })
    expect(parseProximityArgs(['proximity', 'memphis'])).toMatchObject({ error: /--to <layer>/ })
    expect(parseProximityArgs(['proximity', 'memphis', '--to', 'x', '--within', 'soon'])).toMatchObject({
      error: /not a number of miles/,
    })
    expect(parseProximityArgs(['proximity', 'memphis', '--to', 'x', '--id', 'No Good'])).toMatchObject({
      error: /not a column id/,
    })
  })
})

describe('isLibraryTree', () => {
  it('knows a pulled tree from any other folder', async () => {
    expect(await isLibraryTree(dir)).toBe(true)
    expect(await isLibraryTree(join(dir, 'library/datasets'))).toBe(false)
  })
})

// --- The pass ----------------------------------------------------------------

describe('the pass', () => {
  it('measures the same numbers the request does, with no bucket and no database', async () => {
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission' }, dir, quiet)

    expect(report.stats).toMatchObject({ rows: 4, measured: 3, withoutPoint: 1, targets: 2, counties: 2 })
    const xai = report.rows.find(r => r.label === 'xAI supercomputer')!
    // The same 2.95 miles the route suite asserts — one primitive, two homes.
    expect(xai.miles).toBeCloseTo(2.95, 1)
    expect(xai.nearest).toBe('Allen–Southaven 500kV')
    expect(report.columnId).toBe('miles-to-transmission')
    expect(report.method).toContain('point-to-segment')
  })

  it('writes nothing without --apply', async () => {
    const before = await setManifest()
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission' }, dir, quiet)
    expect(report.written).toEqual([])
    expect(await setManifest()).toEqual(before)
  })

  it('writes the column into the manifest with --apply, and nothing else', async () => {
    const before = await setManifest()
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)

    expect(report.written).toEqual([
      'library/working-sets/memphis/derived/miles-to-transmission.rows.json',
      'library/working-sets/memphis/meta.json',
    ])
    const after = await setManifest()
    // Every field the pass does not touch comes back identical — retag's rule.
    expect({ ...after, derived: undefined }).toEqual({ ...before, derived: undefined })

    expect(after.derived).toHaveLength(1)
    expect(after.derived[0]).toMatchObject({
      id: 'miles-to-transmission',
      label: 'Miles to nearest Transmission lines',
      unit: 'miles',
    })
    expect(Object.keys(after.derived[0].values).sort()).toEqual(['47157', '51760'])
    expect(after.derived[0].analysis).toMatchObject({
      type: 'proximity',
      from: 'redevelopment-sites',
      to: 'internal-transmission',
      by: 'npm run library -- proximity',
    })
  })

  it('records the version of each input, in the shape the server reads back (P7-6)', async () => {
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    const { fingerprintOf } = await import('../services/analysisInputs.js')
    const { inputs } = (await setManifest()).derived[0].analysis

    // One store, one record: tier 1 writes exactly what tier 2 writes, so a
    // staleness check never has to know which tier produced the number.
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toEqual({
      slug: 'redevelopment-sites',
      role: 'from',
      file: 'sites.csv',
      bytes: Buffer.byteLength(SITES_CSV),
      keys: 'point|sites.csv|lat|lng||||name',
      content: fingerprintOf(SITES_CSV),
      // No stamp: a local pass over a pulled tree has no catalog to ask, and
      // that field is only ever a short circuit.
      at: '',
    })
    expect(inputs[1]).toMatchObject({
      slug: 'transmission',
      role: 'to',
      file: 'lines.geojson',
      content: fingerprintOf(LINES_GEOJSON),
      at: '',
    })
    // The colour in the layer block is NOT part of the version: a restyle must
    // not mark a batch result stale.
    expect(inputs[1].keys).not.toContain('#2b6cb0')
  })

  it('records the version of the file it actually read, not the one declared', async () => {
    // A block pointing at a file that is not there falls back to the first
    // table in the directory, and the recorded version has to name THAT one or
    // the check would look for a file nobody read.
    await write(
      'library/datasets/redevelopment-sites/meta.json',
      JSON.stringify({
        title: 'Redevelopment sites',
        status: 'published',
        layer: { geometry: 'point', file: 'gone.csv', latKey: 'lat', lngKey: 'lng', labelKey: 'name' },
      }),
    )
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    expect((await setManifest()).derived[0].analysis.inputs[0].file).toBe('sites.csv')
  })

  it('writes a shape P7-2’s one reader resolves — the same one the server writes', async () => {
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    const { readDerivedColumns, readDerivedValues } = await import('../services/workingSetColumns.js')
    const columns = readDerivedColumns((await setManifest()).derived)
    expect(columns).toHaveLength(1)
    expect(columns[0].unit).toBe('miles')
    expect(Object.keys(readDerivedValues(columns[0].values)).sort()).toEqual(['47157', '51760'])
  })

  it('stores the per-row numbers beside the manifest', async () => {
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    const stored = JSON.parse(
      await readFile(join(dir, 'library/working-sets/memphis/derived/miles-to-transmission.rows.json'), 'utf8'),
    )
    expect(stored.rows).toHaveLength(4)
    expect(stored.rows.find((r: any) => r.label === 'MP Materials Fort Worth').miles).toBeNull()
  })

  it('writes the count column too when a radius is asked for', async () => {
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission', within: 5, apply: true }, dir, quiet)
    expect(report.countColumnId).toBe('miles-to-transmission-within-5mi')
    const derived = (await setManifest()).derived
    expect(derived.map((c: any) => c.unit)).toEqual(['miles', 'count'])
    expect(derived[1].values['47157']).toBe(1)
    expect(derived[1].values['51760']).toBe(1)
  })

  it('replaces a column of the same id in place on a second run', async () => {
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    expect((await setManifest()).derived).toHaveLength(1)
  })

  it('keeps a derived column the pass did not write', async () => {
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'blo-proximity-cli-'))
    await seedTree({ setMeta: { derived: [{ id: 'hand-written', label: 'Kept', unit: '', values: { '47157': 1 } }] } })
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    const derived = (await setManifest()).derived
    expect(derived.map((c: any) => c.id)).toEqual(['hand-written', 'miles-to-transmission'])
  })

  it('modifies neither source dataset', async () => {
    const sites = await readFile(join(dir, 'library/datasets/redevelopment-sites/sites.csv'), 'utf8')
    const lines = await readFile(join(dir, 'library/datasets/transmission/lines.geojson'), 'utf8')
    await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    expect(await readFile(join(dir, 'library/datasets/redevelopment-sites/sites.csv'), 'utf8')).toBe(sites)
    expect(await readFile(join(dir, 'library/datasets/transmission/lines.geojson'), 'utf8')).toBe(lines)
  })

  it('has NO row ceiling — which is the whole reason it exists', async () => {
    // 6,000 rows is what the API refuses with a 413 naming this pass. Here it
    // simply runs.
    const rows = Array.from(
      { length: 6_000 },
      (_, i) => `Brownfield ${i},${35 + (i % 90) / 1000},${-90 - (i % 90) / 1000},47157`,
    ).join('\n')
    await write('library/datasets/brownfields/meta.json', JSON.stringify({ title: 'Brownfields', status: 'published', category: 'land' }))
    await write('library/datasets/brownfields/b.csv', `name,lat,lng,GEOID\n${rows}`)

    const report = await runProximity(
      { set: 'memphis', to: 'internal-transmission', from: 'brownfields' },
      dir,
      quiet,
    )
    expect(report.stats.rows).toBe(6_000)
    expect(report.stats.measured).toBe(6_000)
  })
})

// --- The refusals ------------------------------------------------------------

describe('what it refuses', () => {
  async function fails(input: Record<string, unknown>): Promise<string> {
    try {
      await runProximity(input as any, dir, quiet)
      throw new Error('expected a refusal')
    } catch (err: any) {
      return err.message as string
    }
  }

  it('a set that is not in the tree, naming the path it looked at', async () => {
    const message = await fails({ set: 'no-such-set', to: 'internal-transmission' })
    expect(message).toContain('no working-set at')
    expect(message).toContain('meta.json')
  })

  it('a layer with no layer block', async () => {
    await write('library/datasets/plain/meta.json', JSON.stringify({ title: 'Plain', status: 'published' }))
    await write('library/datasets/plain/p.csv', 'a\n1\n')
    expect(await fails({ set: 'memphis', to: 'plain' })).toContain('no usable layer block')
  })

  it('a county layer, which has values rather than features', async () => {
    await write(
      'library/datasets/scores/meta.json',
      JSON.stringify({
        title: 'Scores',
        status: 'published',
        layer: { geometry: 'county', name: 'Scores', file: 's.csv', geoKey: 'GEOID', valueKey: 'score' },
      }),
    )
    await write('library/datasets/scores/s.csv', 'GEOID,score\n47157,1\n')
    expect(await fails({ set: 'memphis', to: 'scores' })).toContain('is a county layer')
  })

  it('a table with no county column, naming the geocode pass', async () => {
    await write('library/datasets/nogeo/meta.json', JSON.stringify({ title: 'No GEOID', status: 'published' }))
    await write('library/datasets/nogeo/n.csv', 'name,lat,lng\nA,35,-90\n')
    const message = await fails({ set: 'memphis', to: 'internal-transmission', from: 'nogeo' })
    expect(message).toContain('no county FIPS column')
    expect(message).toContain('npm run library -- geocode')
  })

  it('a set with no anchor and no --from', async () => {
    rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(join(tmpdir(), 'blo-proximity-cli-'))
    await seedTree({ setMeta: { sites: null } })
    expect(await fails({ set: 'memphis', to: 'internal-transmission' })).toContain('not anchored on a dataset')
  })
})

// --- The report --------------------------------------------------------------

describe('the report', () => {
  it('prints the rows, the counts and the dry-run couplet', async () => {
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission' }, dir, quiet)
    const text = formatProximityReport(report)
    expect(text).toContain('xAI supercomputer')
    expect(text).toContain('Allen–Southaven 500kV')
    expect(text).toContain('4 rows · 3 measured · 2 counties · 1 with no coordinates')
    expect(text).toContain('Column: miles-to-transmission (miles)')
    expect(text).toContain('Nothing was written. Rerun with --apply once the report reads right.')
  })

  it('names what it wrote, and the push that publishes it', async () => {
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission', apply: true }, dir, quiet)
    const text = formatProximityReport(report)
    expect(text).toContain('Wrote library/working-sets/memphis/meta.json')
    expect(text).toContain('npm run library -- push')
  })

  it('shows both ends of a long table and says how many it skipped', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `Site ${i},${35 + i / 100},-90.5,47157`).join('\n')
    await write('library/datasets/many/meta.json', JSON.stringify({ title: 'Many', status: 'published' }))
    await write('library/datasets/many/m.csv', `name,lat,lng,GEOID\n${rows}`)
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission', from: 'many' }, dir, quiet)
    const text = formatProximityReport(report)
    expect(text).toContain('40 more rows')
    expect(text).toContain('60 rows · 60 measured')
  })

  it('says nothing about shortfalls there are none of', async () => {
    const report = await runProximity({ set: 'memphis', to: 'internal-transmission', from: 'redevelopment-sites' }, dir, quiet)
    report.stats.withoutPoint = 0
    report.stats.withoutCounty = 0
    expect(formatProximityReport(report)).not.toContain('with no coordinates')
  })
})
