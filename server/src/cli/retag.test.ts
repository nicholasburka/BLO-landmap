import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Anthropic from '@anthropic-ai/sdk'

import {
  buildRetagUserMessage,
  findManifests,
  planOne,
  planEntries,
  proposeTopicsFromTitles,
  renderOrganizationReport,
  renderReport,
  renderCoverageReport,
  renderShapeReport,
  retagLibrary,
  topicFromWords,
  type RetagRow,
} from './retag.js'

/**
 * P5-63's migration. Everything here runs on a temp folder: the tool is local
 * file work by design, so the suite exercises exactly what a person runs.
 *
 * The one thing that is stubbed is the model, and only where the tool asks it
 * to read a title. That path is a PROPOSAL either way — the assertions are
 * about what the tool does with an answer, never about the answer.
 */

let dir: string

function seed(kind: string, slug: string, meta: Record<string, unknown>): string {
  const path = join(dir, 'library', kind, slug)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
  return join(path, 'meta.json')
}

function read(kind: string, slug: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'library', kind, slug, 'meta.json'), 'utf8'))
}

/** A client that answers with one recorded JSON object. */
function stubClient(answer: string) {
  const calls: string[] = []
  return {
    calls,
    client: {
      messages: {
        create: async (params: { messages: { content: string }[] }) => {
          calls.push(String(params.messages[0].content))
          return { content: [{ type: 'text', text: answer }], usage: { input_tokens: 1, output_tokens: 1 } }
        },
      },
    } as unknown as Anthropic,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blo-retag-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('reading the tree', () => {
  it('finds one manifest per entry across every file-backed kind, and nothing else', async () => {
    seed('datasets', 'organizations', { title: 'Organizations', category: 'network' })
    seed('documents', 'brief', { title: 'A brief', category: 'research' })
    seed('notes', 'idea', { title: 'An idea', category: 'ideas' })
    seed('sources', 'epa-npl', { title: 'NPL', category: 'environment' })
    seed('incoming', 'drop', { title: 'Drop' })
    // Wiki pages and saved views are flat files with no manifest — untouched.
    mkdirSync(join(dir, 'library', 'wiki'), { recursive: true })
    writeFileSync(join(dir, 'library', 'wiki', 'guide.md'), '# Guide\n')

    const found = await findManifests(dir)
    expect(found).toHaveLength(5)
    expect(found.every(p => p.endsWith('meta.json'))).toBe(true)
    expect(found.some(p => p.includes('wiki'))).toBe(false)
  })

  it('skips a manifest that is not valid JSON instead of failing the run', async () => {
    const path = seed('documents', 'broken', {})
    writeFileSync(path, '{oops')
    expect(await planOne(path, dir)).toBeNull()
  })

  it('reads the category and tags, and says what they become', async () => {
    const path = seed('sources', 'census-acs', {
      title: 'ACS',
      category: 'Demographics',
      tags: ['demographics', 'Flooding', 'site_selection'],
    })
    const row = await planOne(path, dir)
    expect(row).toMatchObject({
      slug: 'census-acs',
      kind: 'source',
      category: 'Demographics',
      newCategory: 'demographic',
      newTags: ['demographic', 'flood', 'site-selection'],
      topic: 'demographic',
      unknownCategory: false,
    })
  })

  it('flags a category the taxonomy does not know, and keeps it', async () => {
    const path = seed('documents', 'odd', { title: 'Odd', category: 'kitchen sink' })
    const row = await planOne(path, dir)
    expect(row).toMatchObject({ newCategory: 'kitchen-sink', unknownCategory: true, topic: null })
  })
})

describe('proposing a topic', () => {
  const row = (over: Partial<RetagRow>): RetagRow => ({
    slug: 'x',
    kind: 'document',
    path: 'p',
    category: '',
    newCategory: '',
    tags: [],
    newTags: [],
    topic: null,
    proposedTopic: null,
    proposedFrom: null,
    unknownCategory: false,
    ...over,
  })

  it('reads a topic off the words already on the entry, for free', () => {
    expect(topicFromWords(row({ newTags: ['seeds', 'foodways'] }))).toBe('agriculture')
    expect(topicFromWords(row({ newTags: ['wells'] }))).toBe('water')
    // The slug counts as words too — a hyphen is a space.
    expect(topicFromWords(row({ slug: 'county-parcels-export' }))).toBe('land')
    expect(topicFromWords(row({ newTags: ['pitch', '5-5-5'] }))).toBeNull()
  })

  it('asks the model once for all the rest, and refuses an id outside the taxonomy', async () => {
    const { client, calls } = stubClient(
      JSON.stringify({ a: 'land', b: 'kitchen-sink', c: 'Demographics', d: 'network', unknown: 'water' }),
    )
    const proposals = await proposeTopicsFromTitles(
      [
        { slug: 'a', title: 'Landholders' },
        { slug: 'b', title: 'Something' },
        { slug: 'c', title: 'Population' },
        { slug: 'd', title: 'Funders' },
      ],
      client,
    )
    // One call for four documents.
    expect(calls).toHaveLength(1)
    expect(proposals.topics).toEqual({ a: 'land', c: 'demographic', d: 'network' })
    // A slug we did not ask about is not a proposal about anything of ours.
    expect(proposals.topics).not.toHaveProperty('unknown')
    expect(proposals.error).toBeUndefined()
  })

  it('shows the model the subjects with their descriptions, and the tags each entry carries', () => {
    const message = buildRetagUserMessage([{ slug: 'a', title: 'A study', tags: ['land', 'history'] }])
    expect(message).toContain('land (Land)')
    expect(message).toContain('Parcels, ownership, conservation')
    expect(message).toContain('- a: A study [tags: land, history]')
    expect(message).toMatch(/Leave a slug out ONLY when/)
  })
})

describe('the dry run', () => {
  beforeEach(() => {
    seed('sources', 'census-acs', { title: 'ACS', category: 'demographics', tags: ['demographics', 'ownership'] })
    seed('documents', 'homestead-acts', { title: 'The Homestead Acts', category: 'primary-sources', tags: ['history', 'land'] })
    seed('documents', 'plan', { title: 'Five-year plan', category: 'strategy', tags: ['funding'] })
    seed('datasets', 'gardens', { title: 'Gardens', category: 'places', tags: ['gardens'] })
  })

  it('changes nothing on disk and writes the report beside the tree', async () => {
    const result = await retagLibrary(dir)
    expect(result.rows).toHaveLength(4)
    expect(result.applied).toEqual([])
    expect(read('sources', 'census-acs').category).toBe('demographics')
    expect(existsSync(result.reportPath)).toBe(true)
    expect(result.reportPath).toBe(join(dir, 'retag-report.md'))
    const report = readFileSync(result.reportPath, 'utf8')
    expect(report).toContain('Dry run — nothing was written')
    expect(report).toContain('`census-acs`')
    expect(report).toContain('demographics → **demographic**')
    expect(report).toContain('primary-sources → **research**')
  })

  it('counts what would change, what gets a proposal, and what it does not recognise', async () => {
    seed('documents', 'odd', { title: 'Odd', category: 'kitchen-sink' })
    const result = await retagLibrary(dir)
    expect(result.changed.map(r => r.slug).sort()).toEqual(['census-acs', 'homestead-acts'])
    expect(result.unknown.map(r => r.slug)).toEqual(['odd'])
    // `plan` is a purpose with no subject anywhere on it. With no key
    // configured the tool says so rather than pretending it looked.
    expect(result.rows.find(r => r.slug === 'plan')?.topic).toBeNull()
  })

  it('says plainly when a topic could be read off a title and no key is configured', async () => {
    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const result = await retagLibrary(dir)
      expect(result.modelNote).toMatch(/set ANTHROPIC_API_KEY/)
      expect(result.proposed).toEqual([])
    } finally {
      if (key) process.env.ANTHROPIC_API_KEY = key
    }
  })

  it('says the model could not be ASKED rather than that the titles say nothing', async () => {
    const client = { messages: { create: async () => { throw new Error('credit balance is too low') } } } as never
    const result = await retagLibrary(dir, { client })
    expect(result.proposed).toEqual([])
    expect(result.modelNote).toContain('the model could not be asked')
    expect(result.modelNote).not.toContain('do not say')
  })

  it('marks a model proposal as one, and says where it came from', async () => {
    const { client } = stubClient(JSON.stringify({ plan: 'land' }))
    const result = await retagLibrary(dir, { client })
    const plan = result.rows.find(r => r.slug === 'plan')!
    expect(plan.proposedTopic).toBe('land')
    expect(plan.proposedFrom).toBe('title')
    expect(readFileSync(result.reportPath, 'utf8')).toContain('proposed **land** (from title, model)')
  })
})

describe('--apply', () => {
  it('rewrites only category and tags, leaving every other field exactly as it was', async () => {
    seed('sources', 'census-acs', {
      title: 'ACS',
      category: 'Demographics',
      status: 'published',
      tags: ['demographics', 'Flooding'],
      source: { provider: 'US Census Bureau', topics: ['income'] },
      lineage: { from: 'https://example.gov' },
    })
    const result = await retagLibrary(dir, { apply: true })
    expect(result.applied).toHaveLength(1)
    expect(read('sources', 'census-acs')).toEqual({
      title: 'ACS',
      category: 'demographic',
      status: 'published',
      tags: ['demographic', 'flood'],
      source: { provider: 'US Census Bureau', topics: ['income'] },
      lineage: { from: 'https://example.gov' },
    })
  })

  it('applies a proposed topic as a TAG, never over the category a person chose', async () => {
    seed('documents', 'plan', { title: 'Five-year plan', category: 'strategy', tags: ['funding'] })
    const { client } = stubClient(JSON.stringify({ plan: 'land' }))
    await retagLibrary(dir, { apply: true, client })
    const meta = read('documents', 'plan')
    // The purpose it was filed under stands; the subject joins the tags,
    // which is where the derived topic is read from.
    expect(meta.category).toBe('strategy')
    expect(meta.tags).toEqual(['funding', 'land'])
  })

  it('leaves a manifest alone when nothing about it changes', async () => {
    seed('datasets', 'gardens', { title: 'Gardens', category: 'places', tags: ['gardens'] })
    const before = readFileSync(join(dir, 'library', 'datasets', 'gardens', 'meta.json'), 'utf8')
    const result = await retagLibrary(dir, { apply: true })
    expect(result.applied).toEqual([])
    expect(readFileSync(join(dir, 'library', 'datasets', 'gardens', 'meta.json'), 'utf8')).toBe(before)
  })

  it('never touches a wiki page or a saved view', async () => {
    mkdirSync(join(dir, 'library', 'wiki'), { recursive: true })
    mkdirSync(join(dir, 'library', 'views'), { recursive: true })
    writeFileSync(join(dir, 'library', 'wiki', 'guide.md'), '# Guide\n\ncategory: demographics\n')
    writeFileSync(join(dir, 'library', 'views', 'v.json'), '{"name":"V","category":"views"}\n')
    seed('datasets', 'gardens', { title: 'Gardens', category: 'Places' })

    await retagLibrary(dir, { apply: true })
    expect(readFileSync(join(dir, 'library', 'wiki', 'guide.md'), 'utf8')).toContain('category: demographics')
    expect(readFileSync(join(dir, 'library', 'views', 'v.json'), 'utf8')).toContain('"category":"views"')
    expect(read('datasets', 'gardens').category).toBe('places')
  })
})

describe('the report', () => {
  it('says what it is, what the vocabulary is, and one row per entry', () => {
    const rows: RetagRow[] = [
      {
        slug: 'a',
        kind: 'source',
        path: 'p',
        category: 'demographics',
        newCategory: 'demographic',
        tags: ['Flooding'],
        newTags: ['flood'],
        topic: 'demographic',
        proposedTopic: null,
        proposedFrom: null,
        unknownCategory: false,
      },
      {
        slug: 'b',
        kind: 'document',
        path: 'p',
        category: 'kitchen-sink',
        newCategory: 'kitchen-sink',
        tags: [],
        newTags: [],
        topic: null,
        proposedTopic: 'land',
        proposedFrom: 'tags',
        unknownCategory: true,
      },
    ]
    const md = renderReport(rows)
    expect(md).toContain('# Retag report')
    expect(md).toContain('demographics → **demographic**')
    expect(md).toContain('Flooding → **flood**')
    expect(md).toContain('⚠ category not in the taxonomy')
    expect(md).toContain('proposed **land** (from tags)')
    expect(md).toContain('1 would change')
    expect(renderReport(rows, { applied: true })).toContain('**Applied.**')
  })
})

describe('a folder that is not a library tree', () => {
  it('says so instead of failing to write a report into a directory that is not there', async () => {
    const result = await retagLibrary(join(dir, 'nowhere'))
    expect(result.rows).toEqual([])
    expect(existsSync(result.reportPath)).toBe(false)
  })
})

// --- P6-1: the organization pass -------------------------------------------

/** A file beside a manifest, for the shape pass to read. */
function seedFile(kind: string, slug: string, name: string, body: string): void {
  const path = join(dir, 'library', kind, slug)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, name), body)
}

describe('retag --organizations', () => {
  it('reads a publisher off a source block and off a dataset’s free prose', async () => {
    seed('sources', 'epa-npl', { title: 'NPL', source: { provider: 'US EPA', program: 'Superfund' } })
    seed('datasets', 'gardens', { title: 'Gardens', source: 'DC Open Data — Community Gardens (ArcGIS export)' })

    const result = await retagLibrary(dir, { organizations: true })
    const by = (slug: string) => result.rows.find(r => r.slug === slug)!
    expect(by('epa-npl')).toMatchObject({ organization: '', proposedOrganization: 'epa', providerText: 'US EPA' })
    expect(by('gardens').proposedOrganization).toBe('dc-open-data')
    expect(result.organizationChanged!.map(r => r.slug).sort()).toEqual(['epa-npl', 'gardens'])
    expect(result.organizationUnknown).toEqual([])
    expect(existsSync(result.organizationReportPath!)).toBe(true)
  })

  it('writes nothing on a dry run, and names the report', async () => {
    seed('sources', 'epa-npl', { title: 'NPL', source: { provider: 'US EPA' } })
    const result = await retagLibrary(dir, { organizations: true })
    expect(read('sources', 'epa-npl').organization).toBeUndefined()
    expect(result.organizationReportPath).toBe(join(dir, 'retag-organizations.md'))
    const md = readFileSync(result.organizationReportPath!, 'utf8')
    expect(md).toContain('# Retag report — organizations')
    expect(md).toContain('**Dry run — nothing was written.**')
    expect(md).toContain('US EPA')
  })

  it('writes the id into the manifest with --apply, leaving every other field alone', async () => {
    seed('sources', 'epa-npl', {
      title: 'NPL',
      category: 'environment',
      lineage: 'seeded by hand, 2026-08',
      source: { provider: 'US EPA' },
    })
    await retagLibrary(dir, { organizations: true, apply: true })
    const meta = read('sources', 'epa-npl')
    expect(meta.organization).toBe('epa')
    expect(meta.lineage).toBe('seeded by hand, 2026-08')
    expect(meta.source).toEqual({ provider: 'US EPA' })
  })

  it('never writes a publisher the vocabulary does not know — it reports it', async () => {
    seed('sources', 'deeds', { title: 'Deeds', source: { provider: 'Shelby County Register of Deeds' } })
    const result = await retagLibrary(dir, { organizations: true, apply: true })
    expect(read('sources', 'deeds').organization).toBeUndefined()
    expect(result.organizationUnknown!.map(r => r.slug)).toEqual(['deeds'])
    const md = readFileSync(result.organizationReportPath!, 'utf8')
    expect(md).toContain('Publishers the vocabulary does not know')
    expect(md).toContain('Shelby County Register of Deeds')
  })

  it('leaves the manifest alone when it already says the right thing', async () => {
    seed('sources', 'epa-npl', { title: 'NPL', organization: 'epa', source: { provider: 'US EPA' } })
    const result = await retagLibrary(dir, { organizations: true, apply: true })
    expect(result.organizationChanged).toEqual([])
    expect(result.applied).toEqual([])
  })

  it('writes no organization report at all unless it was asked for', async () => {
    seed('sources', 'epa-npl', { title: 'NPL', source: { provider: 'US EPA' } })
    const result = await retagLibrary(dir, { apply: true })
    expect(result.organizationReportPath).toBeUndefined()
    expect(existsSync(join(dir, 'retag-organizations.md'))).toBe(false)
    expect(read('sources', 'epa-npl').organization).toBeUndefined()
  })

  it('escapes a manifest’s prose so one pipe cannot break the table', () => {
    const rows = [
      {
        slug: 'odd',
        kind: 'dataset',
        organization: '',
        providerText: 'A | B',
        proposedOrganization: 'Nobody We Know',
      } as RetagRow,
    ]
    const md = renderOrganizationReport(rows)
    expect(md).toContain('A \\| B')
    expect(md).toContain('⚠ not in the vocabulary')
  })
})

// --- P6-2: the shape pass --------------------------------------------------

describe('retag --shapes', () => {
  it('says what each dataset and source would be called, reading the table on disk', async () => {
    seed('datasets', 'acs', { title: 'ACS' })
    seedFile('datasets', 'acs', 'acs.csv', 'GEOID,median_income\n13089,65000\n')
    seed('datasets', 'people', { title: 'People' })
    seedFile('datasets', 'people', 'people.csv', 'Name,Roles\nA,B\n')
    seed('sources', 'parcels', { title: 'Parcels', source: { provider: 'Regrid', placeQuery: { by: ['point', 'parcel'] } } })
    // Not a dataset-shaped kind: never asked, never reported.
    seed('documents', 'memo', { title: 'Memo' })

    const result = await retagLibrary(dir, { shapes: true })
    const shape = (slug: string) => result.shaped!.find(r => r.slug === slug)?.proposedShape
    expect(shape('acs')).toBe('statistics')
    expect(shape('people')).toBe('records')
    expect(shape('parcels')).toBe('areas')
    expect(result.shaped!.map(r => r.slug)).not.toContain('memo')
  })

  it('reports only — the manifests are never touched', async () => {
    seed('datasets', 'acs', { title: 'ACS' })
    seedFile('datasets', 'acs', 'acs.csv', 'GEOID,value\n13089,1\n')
    const result = await retagLibrary(dir, { shapes: true, apply: true })
    expect(read('datasets', 'acs').shape).toBeUndefined()
    expect(result.shapeReportPath).toBe(join(dir, 'retag-shapes.md'))
    const md = readFileSync(result.shapeReportPath!, 'utf8')
    expect(md).toContain('# Retag report — dataset shapes')
    expect(md).toContain('**Report only — nothing is ever written.**')
    expect(md).toContain('statistics')
  })

  it('shows a manifest’s own shape winning, and says so', async () => {
    seed('datasets', 'zones', { title: 'Zones', shape: 'areas' })
    seedFile('datasets', 'zones', 'zones.csv', 'GEOID,zone\n13089,A\n')
    const result = await retagLibrary(dir, { shapes: true })
    expect(result.shaped![0]).toMatchObject({ shape: 'areas', proposedShape: 'areas' })
    expect(renderShapeReport(result.shaped!)).toContain('the manifest’s `shape:`')
  })

  it('runs no shape pass and reads no file unless it was asked for', async () => {
    seed('datasets', 'acs', { title: 'ACS' })
    const result = await retagLibrary(dir)
    expect(result.shapeReportPath).toBeUndefined()
    expect(result.rows[0].proposedShape).toBeNull()
    expect(existsSync(join(dir, 'retag-shapes.md'))).toBe(false)
  })

  it('reads an entry with no files as records rather than failing the run', async () => {
    seed('datasets', 'empty', { title: 'Empty' })
    const shaped = await planEntries((await retagLibrary(dir)).rows, { shapes: true })
    expect(shaped.map(r => r.proposedShape)).toEqual(['records'])
  })
})

// --- P6-19: the coverage pass ----------------------------------------------

describe('retag --coverage', () => {
  it('says how much ground each dataset and source covers, reading the table on disk', async () => {
    seed('datasets', 'georgia', { title: 'Georgia parcels' })
    seedFile('datasets', 'georgia', 'g.csv', 'GEOID,value\n13121,1\n13089,2\n')
    seed('datasets', 'memphis', { title: 'Memphis' })
    seedFile('datasets', 'memphis', 'm.csv', 'GEOID,name\n47157,a\n28033,b\n')
    seed('datasets', 'people', { title: 'People' })
    seedFile('datasets', 'people', 'p.csv', 'Name,Roles\nA,B\n')
    seed('datasets', 'gardens', { title: 'Gardens' })
    seedFile('datasets', 'gardens', 'g2.csv', 'name,lat,lng\na,38.9,-77\n')
    seed('sources', 'epa', { title: 'EPA', source: { provider: 'US EPA', coverage: 'national' } })
    seed('sources', 'adem', { title: 'ADEM', source: { provider: 'Alabama Department of Environmental Management' } })
    // Not a dataset-shaped kind: never asked, never reported.
    seed('documents', 'memo', { title: 'Memo' })

    const result = await retagLibrary(dir, { coverage: true })
    const got = (slug: string) => result.covered!.find(r => r.slug === slug)?.proposedCoverage
    expect(got('georgia')).toMatchObject({ scope: 'state', states: ['GA'], counties: ['13089', '13121'] })
    expect(got('memphis')).toMatchObject({ scope: 'multi-state', states: ['MS', 'TN'] })
    expect(got('gardens')).toMatchObject({ scope: 'local', states: [] })
    expect(got('epa')).toMatchObject({ scope: 'national', states: [] })
    expect(got('adem')).toMatchObject({ scope: 'state', states: ['AL'] })
    // The one that cannot be placed carries nothing at all — never "national".
    expect(got('people')).toBeNull()
    expect(result.covered!.map(r => r.slug)).not.toContain('memo')
  })

  it('reports only — the manifests are never touched, even with --apply', async () => {
    seed('datasets', 'acs', { title: 'ACS' })
    seedFile('datasets', 'acs', 'acs.csv', 'GEOID,value\n13089,1\n')
    const result = await retagLibrary(dir, { coverage: true, apply: true })
    expect(read('datasets', 'acs').coverage).toBeUndefined()
    expect(result.coverageReportPath).toBe(join(dir, 'retag-coverage.md'))
    const md = readFileSync(result.coverageReportPath!, 'utf8')
    expect(md).toContain('# Retag report — dataset coverage')
    expect(md).toContain('**Report only — nothing is ever written.**')
    expect(md).toContain('Georgia')
  })

  it('records the distribution and the state counts, which is the point of the dry run', async () => {
    seed('sources', 'epa', { title: 'EPA', source: { provider: 'US EPA', coverage: 'national' } })
    seed('sources', 'gaepd', { title: 'GA EPD', source: { provider: 'x', coverage: 'state:GA' } })
    seed('datasets', 'people', { title: 'People' })
    seedFile('datasets', 'people', 'p.csv', 'Name\nA\n')
    const result = await retagLibrary(dir, { coverage: true })
    const md = renderCoverageReport(result.covered!)
    expect(md).toContain('## Distribution')
    expect(md).toContain('| National (`national`) | 1 |')
    expect(md).toContain('| **No coverage** | 1 |')
    expect(md).toContain('## What we hold, by state')
    expect(md).toContain('| Georgia (GA) | 1 |')
    expect(md).toContain('## Entries nobody could place')
    expect(md).toContain('`people`')
  })

  it('shows a manifest’s own coverage winning, and says so', async () => {
    seed('datasets', 'zones', { title: 'Zones', coverage: 'state:AL' })
    seedFile('datasets', 'zones', 'zones.csv', 'GEOID,zone\n13089,A\n')
    const result = await retagLibrary(dir, { coverage: true })
    expect(result.covered![0]).toMatchObject({ coverage: 'state:AL' })
    expect(result.covered![0].proposedCoverage).toMatchObject({ states: ['AL'] })
    expect(renderCoverageReport(result.covered!)).toContain('the manifest’s `coverage:`')
  })

  it('runs no coverage pass and reads no file unless it was asked for', async () => {
    seed('datasets', 'acs', { title: 'ACS' })
    const result = await retagLibrary(dir)
    expect(result.coverageReportPath).toBeUndefined()
    expect(result.rows[0].proposedCoverage).toBeNull()
    expect(existsSync(join(dir, 'retag-coverage.md'))).toBe(false)
  })

  it('reads the entry’s table once when both passes run', async () => {
    seed('datasets', 'acs', { title: 'ACS' })
    seedFile('datasets', 'acs', 'acs.csv', 'GEOID,value\n13089,1\n')
    const result = await retagLibrary(dir, { shapes: true, coverage: true })
    // One pass over the disk answers both questions, and both reports name it.
    expect(result.shaped![0].proposedShape).toBe('statistics')
    expect(result.covered![0].proposedCoverage).toMatchObject({ states: ['GA'] })
    expect(result.shaped).toBe(result.covered)
  })
})
