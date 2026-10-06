import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * `npm run library -- index` (P7-8) — the bulk tier.
 *
 * Over a real temp tree, like `retag`'s and `proximity`'s suites: no bucket,
 * no database. What this file is judged on is that the local pass and the
 * request **agree about the number** — same primitive, `computeComposite` —
 * while differing in the two ways they are meant to: no byte ceiling here,
 * and a manifest written on disk rather than to a bucket.
 *
 * It also pins the thing the API's 413 promises. That refusal tells a caller
 * to *"run it locally instead: npm run library -- index …"*, and a path
 * nothing ever takes is a path nobody can trust.
 */

const { formatCompositeReport, parseCompositeArgs, runComposite } = await import('./composite.js')
const { isLibraryTree } = await import('./proximity.js')
const { computeComposite } = await import('../services/composite.js')

let dir: string

const VOTES_CSV = [
  'GEOID,registered_pct',
  '47157,61.4',
  '51760,72.8',
  '04019,44.1',
  '01001,38.6',
  '13121,80.2',
].join('\n')

const TURNOUT_CSV = ['GEOID,turnout_pct', '47157,48.2', '51760,66.0', '04019,31.5', '13121,70.9'].join('\n')

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(dir, path, '..'), { recursive: true })
  await writeFile(join(dir, path), body, 'utf8')
}

function countyLayer(name: string, file: string, valueKey: string): Record<string, unknown> {
  return {
    title: name,
    status: 'published',
    category: 'equity',
    layer: {
      geometry: 'county',
      name,
      file,
      geoKey: 'GEOID',
      valueKey,
      dataType: 'percentage',
      unit: '%',
      direction: 'higher_better',
    },
  }
}

async function seedTree(over: { setMeta?: Record<string, unknown> } = {}): Promise<void> {
  await write(
    'library/working-sets/efficacy/meta.json',
    JSON.stringify(
      {
        title: 'Political efficacy',
        category: 'working-sets',
        status: 'published',
        tags: [],
        purpose: 'Where engagement is strongest',
        datasets: ['votes', 'turnout'],
        layers: ['internal-votes', 'internal-turnout', 'pct_Black'],
        sites: null,
        savedBy: 'maria',
        savedById: 1,
        savedAt: '2026-10-06T00:00:00.000Z',
        ...over.setMeta,
      },
      null,
      2,
    ),
  )
  await write('library/datasets/votes/meta.json', JSON.stringify(countyLayer('Black voter registration', 'votes.csv', 'registered_pct')))
  await write('library/datasets/votes/votes.csv', VOTES_CSV)
  await write('library/datasets/turnout/meta.json', JSON.stringify(countyLayer('Local election turnout', 'turnout.csv', 'turnout_pct')))
  await write('library/datasets/turnout/turnout.csv', TURNOUT_CSV)
}

const TERMS = ['--layer', 'internal-votes:6:higher', '--layer', 'internal-turnout:4:higher']

function args(...extra: string[]): string[] {
  return ['index', 'efficacy', '--name', 'Political efficacy', ...TERMS, ...extra]
}

function parsed(...extra: string[]) {
  const read = parseCompositeArgs(args(...extra))
  if ('error' in read) throw new Error(read.error)
  return read
}

async function setMeta(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(dir, 'library/working-sets/efficacy/meta.json'), 'utf8'))
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'blo-index-cli-'))
  await seedTree()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// --- Argument parsing --------------------------------------------------------

describe('parseCompositeArgs', () => {
  it('reads the set, the name and every --layer in order', () => {
    expect(parsed()).toMatchObject({
      set: 'efficacy',
      name: 'Political efficacy',
      // Stored canonically — sorted by layer id — so the formula has one
      // spelling however it was typed.
      terms: [
        { layer: 'internal-turnout', weight: 4, direction: 'higher_better' },
        { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
      ],
      apply: false,
    })
  })

  it('takes higher/lower as well as the full spellings', () => {
    const read = parseCompositeArgs([
      'index',
      'efficacy',
      '--name',
      'x',
      '--layer',
      'a:1:lower',
      '--layer',
      'b:2:higher_better',
    ])
    expect(read).toMatchObject({
      terms: [
        { layer: 'a', weight: 1, direction: 'lower_better' },
        { layer: 'b', weight: 2, direction: 'higher_better' },
      ],
    })
  })

  it('needs a name, because an index that is not named cannot be cited', () => {
    expect(parseCompositeArgs(['index', 'efficacy', ...TERMS])).toEqual({
      error: 'index: give --name "<what the index is called>"',
    })
  })

  it('needs at least two layers, and says so in the maths’ own words', () => {
    expect(parseCompositeArgs(['index', 'efficacy', '--name', 'x'])).toEqual({
      error: 'index: give at least two --layer <layer>:<weight>:<direction> terms',
    })
    expect(parseCompositeArgs(['index', 'efficacy', '--name', 'x', '--layer', 'a:1:higher'])).toMatchObject({
      error: expect.stringContaining('An index needs at least 2 layers'),
    })
  })

  it('refuses a malformed term rather than guessing at it', () => {
    expect(parseCompositeArgs(['index', 's', '--name', 'x', '--layer', 'a:1', '--layer', 'b:1:higher'])).toEqual({
      error: 'index: "a:1" is not <layer>:<weight>:<direction>',
    })
    expect(parseCompositeArgs(['index', 's', '--name', 'x', '--layer', 'a:1:sideways', '--layer', 'b:1:higher'])).toEqual({
      error: 'index: "sideways" is not a direction — say higher or lower',
    })
    expect(parseCompositeArgs(['index', 's', '--name', 'x', '--layer', 'a:0:higher', '--layer', 'b:1:higher'])).toEqual({
      error: 'index: "0" is not a weight above zero',
    })
    expect(parseCompositeArgs(['index', 's', '--name', 'x', '--layer'])).toEqual({
      error: 'index: --layer needs <layer>:<weight>:<direction>',
    })
  })

  it('refuses a column id that is not one', () => {
    expect(parseCompositeArgs(args('--id', 'Not An Id'))).toEqual({
      error: 'index: "Not An Id" is not a column id (lower case, digits, dashes)',
    })
  })
})

// --- The pass ----------------------------------------------------------------

describe('runComposite', () => {
  it('computes the index and writes nothing without --apply', async () => {
    const report = await runComposite(parsed(), dir, () => {})
    expect(report.written).toEqual([])
    expect(report.columnId).toBe('political-efficacy')
    expect(report.layerId).toBe('internal-efficacy~political-efficacy')
    expect(report.counties).toBe(5)
    expect(report.complete).toBe(4)
    expect(report.partial).toBe(1)
    expect(report.values['13121']).toBe(100)
    // The manifest is untouched.
    expect((await setMeta()).derived).toBeUndefined()
  })

  it('agrees with the primitive the request tier uses, to the last bit', async () => {
    // The point of sharing `computeComposite`: the two tiers can differ in
    // where the bytes come from and whether a ceiling applies, never in the
    // number. Computed here directly from the same values.
    const report = await runComposite(parsed(), dir, () => {})
    const direct = computeComposite([
      {
        layer: 'internal-turnout',
        weight: 4,
        direction: 'higher_better',
        values: { '47157': 48.2, '51760': 66.0, '04019': 31.5, '13121': 70.9 },
      },
      {
        layer: 'internal-votes',
        weight: 6,
        direction: 'higher_better',
        values: { '47157': 61.4, '51760': 72.8, '04019': 44.1, '01001': 38.6, '13121': 80.2 },
      },
    ])
    expect(JSON.stringify(report.values)).toBe(JSON.stringify(direct.values))
    expect(report.scales).toEqual(direct.scales)
  })

  it('writes the same record shape the request tier writes, inputs and all', async () => {
    await runComposite(parsed('--apply'), dir, () => {})
    const meta = await setMeta()
    expect(meta.derived).toHaveLength(1)
    const column = meta.derived[0]
    expect(column).toMatchObject({ id: 'political-efficacy', label: 'Political efficacy', unit: 'index' })
    expect(column.values['13121']).toBe(100)
    expect(column.analysis).toMatchObject({
      type: 'composite',
      columns: ['political-efficacy'],
      counties: 5,
      complete: 4,
      // Named, not a person: the batch tier's provenance is the pass.
      by: 'npm run library -- index',
    })
    expect(column.analysis.terms).toEqual([
      { layer: 'internal-turnout', weight: 4, direction: 'higher_better' },
      { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
    ])
    // The input versions the server will check, in the server's own shape.
    expect(column.analysis.inputs).toHaveLength(2)
    for (const input of column.analysis.inputs) {
      expect(input).toMatchObject({ role: 'term', at: '' })
      expect(input.bytes).toBeGreaterThan(0)
      expect(input.content).toMatch(/^[0-9a-f]{16}$/)
      expect(input.keys).toContain('county')
    }
  })

  it('leaves every field it does not touch byte-identical', async () => {
    const before = await readFile(join(dir, 'library/working-sets/efficacy/meta.json'), 'utf8')
    await runComposite(parsed('--apply'), dir, () => {})
    const after = await readFile(join(dir, 'library/working-sets/efficacy/meta.json'), 'utf8')
    // Re-serialised from the parsed object, so the only difference is the new
    // key (retag's rule).
    const strip = (text: string) => {
      const doc = JSON.parse(text)
      delete doc.derived
      return `${JSON.stringify(doc, null, 2)}\n`
    }
    expect(strip(after)).toBe(before.endsWith('\n') ? before : `${before}\n`)
  })

  it('replaces a re-run in place, keeping the column order', async () => {
    await runComposite(parsed('--apply'), dir, () => {})
    // A second, differently-named column, then a re-run of the first.
    await runComposite(
      { ...parsed('--apply'), name: 'Second index', id: 'second' },
      dir,
      () => {},
    )
    await runComposite(parsed('--apply'), dir, () => {})
    const meta = await setMeta()
    expect(meta.derived.map((c: any) => c.id)).toEqual(['political-efficacy', 'second'])
  })

  it('reads a public registry layer off public/datasets with no network', async () => {
    // The workbook's class and race indicators are registry layers, so the
    // local pass has to reach them too — from the checkout, which is where
    // they live.
    const report = await runComposite(
      {
        set: 'efficacy',
        name: 'Political efficacy',
        terms: [
          { layer: 'internal-votes', weight: 6, direction: 'higher_better' },
          { layer: 'pct_Black', weight: 4, direction: 'higher_better' },
        ],
      },
      dir,
      () => {},
    )
    expect(report.counties).toBeGreaterThan(3000)
    expect(report.scales.find(s => s.layer === 'pct_Black')!.counties).toBeGreaterThan(3000)
  })

  it('has NO byte ceiling, which is the whole reason it exists', async () => {
    // The API would refuse this with a 413 naming this pass. Here the budget
    // is simply never consulted, so a budget set absurdly low changes nothing.
    process.env.COMPOSITE_BYTES_BUDGET = '1'
    try {
      const report = await runComposite(parsed(), dir, () => {})
      expect(report.counties).toBe(5)
    } finally {
      delete process.env.COMPOSITE_BYTES_BUDGET
    }
  })

  it('refuses a layer with no county block, by name', async () => {
    await write(
      'library/datasets/sites/meta.json',
      JSON.stringify({
        title: 'Sites',
        status: 'published',
        layer: { geometry: 'point', name: 'Sites', file: 'sites.csv', latKey: 'lat', lngKey: 'lng', labelKey: 'name', popupFields: [] },
      }),
    )
    await write('library/datasets/sites/sites.csv', 'name,lat,lng\nx,35,-90\n')
    await expect(
      runComposite(
        {
          set: 'efficacy',
          name: 'x',
          terms: [
            { layer: 'internal-votes', weight: 1, direction: 'higher_better' },
            { layer: 'internal-sites', weight: 1, direction: 'higher_better' },
          ],
        },
        dir,
        () => {},
      ),
    ).rejects.toThrow(/sites has no county layer block/)
  })

  it('says which tree it could not find rather than failing opaquely', async () => {
    await expect(runComposite({ ...parsed(), set: 'nope' }, dir, () => {})).rejects.toThrow(
      /no working-set at .*nope.*meta\.json/,
    )
    expect(await isLibraryTree(dir)).toBe(true)
  })
})

// --- The report --------------------------------------------------------------

describe('formatCompositeReport', () => {
  it('shows every term with its weight, direction and the scale it used', async () => {
    const text = formatCompositeReport(await runComposite(parsed(), dir, () => {}))
    expect(text).toContain('Black voter registration')
    expect(text).toContain('higher')
    expect(text).toContain('38.6')
    expect(text).toContain('80.2')
    expect(text).toContain('5 counties · 4 with every layer · 1 missing at least one')
    expect(text).toContain('draws as internal-efficacy~political-efficacy')
    expect(text).toContain('Nothing was written. Rerun with --apply once the report reads right.')
  })

  it('names what it wrote, and what to do next', async () => {
    const text = formatCompositeReport(await runComposite(parsed('--apply'), dir, () => {}))
    expect(text).toContain('Wrote library/working-sets/efficacy/meta.json')
    expect(text).toContain('npm run library -- push')
  })
})
