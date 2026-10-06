import { describe, it, expect } from 'vitest'

/**
 * P5-59 plans. Pure: what the four choices mean, which one an inspection
 * points at, and when a `replicate` plan is done.
 */

const { parseIngestPlan, proposeIngestPlan, markReplicatedPlans, lineageKeysFor, planSummary, INGEST_PLANS } =
  await import('./ingestPlan.js')
import type { Inspection } from './linkInspect.js'

const inspection = (kind: Inspection['kind']): Inspection => ({
  kind,
  confidence: 'high',
  url: 'https://example.org/thing',
  checkedAt: '2026-09-06T00:00:00.000Z',
})

describe('proposeIngestPlan', () => {
  it('sends a queryable endpoint to fetch-on-demand', () => {
    expect(proposeIngestPlan(inspection('arcgis-layer'))).toMatchObject({ plan: 'fetch-on-demand' })
    expect(proposeIngestPlan(inspection('socrata'))).toMatchObject({ plan: 'fetch-on-demand' })
    expect(proposeIngestPlan(inspection('arcgis-service'))).toMatchObject({ plan: 'fetch-on-demand' })
  })

  it('sends a direct file to an automatic copy', () => {
    expect(proposeIngestPlan(inspection('file'))).toMatchObject({ plan: 'replicate', mode: 'auto' })
  })

  it('sends a page to document and a portal to index', () => {
    expect(proposeIngestPlan(inspection('page'))).toMatchObject({ plan: 'document' })
    expect(proposeIngestPlan(inspection('portal'))).toMatchObject({ plan: 'index' })
  })

  it('proposes nothing for a link it could not reach, and nothing for no inspection', () => {
    expect(proposeIngestPlan(inspection('unreachable'))).toBeNull()
    expect(proposeIngestPlan(null)).toBeNull()
  })

  it('always gives a reason, because the picker shows it', () => {
    for (const kind of ['arcgis-layer', 'socrata', 'file', 'page', 'portal'] as const) {
      expect(proposeIngestPlan(inspection(kind))!.why.length).toBeGreaterThan(10)
    }
  })
})

describe('planSummary', () => {
  it('says what happens next in plain words, for every plan', () => {
    for (const plan of INGEST_PLANS) expect(planSummary(plan).length).toBeGreaterThan(30)
  })

  it('distinguishes a copy the server can do from one Nick does by hand', () => {
    expect(planSummary('replicate', 'auto')).toMatch(/Replicate now/)
    expect(planSummary('replicate', 'manual')).toMatch(/download, clean, push/)
  })
})

describe('parseIngestPlan', () => {
  it('keeps a good block and fills in what a manifest may be missing', () => {
    expect(
      parseIngestPlan({ plan: 'replicate', mode: 'manual', owner: 'Nick', note: 'by hand', decidedBy: 'nick', decidedAt: 'x' }),
    ).toEqual({ plan: 'replicate', mode: 'manual', owner: 'Nick', note: 'by hand', decidedBy: 'nick', decidedAt: 'x' })
    expect(parseIngestPlan({ plan: 'index' })).toEqual({ plan: 'index', decidedBy: 'unknown', decidedAt: '' })
  })

  it('drops what it cannot use rather than half-rendering it', () => {
    expect(parseIngestPlan({ plan: 'magic', decidedBy: 'nick' })).toBeNull()
    expect(parseIngestPlan(null)).toBeNull()
    expect(parseIngestPlan('replicate')).toBeNull()
    // A bad mode loses the mode, not the plan.
    const badMode = parseIngestPlan({ plan: 'replicate', mode: 'sideways' })
    expect(badMode?.plan).toBe('replicate')
    expect(badMode && 'mode' in badMode).toBe(false)
  })

  it('keeps a done marker only when it says when', () => {
    expect(parseIngestPlan({ plan: 'replicate', done: { at: 'then', dataset: 'x' } })?.done).toEqual({
      at: 'then',
      dataset: 'x',
    })
    expect(parseIngestPlan({ plan: 'replicate', done: { dataset: 'x' } })?.done).toBeUndefined()
  })
})

describe('markReplicatedPlans', () => {
  const planned = (slug: string, meta: Record<string, unknown>) => ({
    slug,
    kind: 'source',
    meta: { ingest: { plan: 'replicate', decidedBy: 'nick', decidedAt: 'x' }, ...meta },
  })

  it('closes a plan when a dataset names the source in its lineage', () => {
    const rows = [
      planned('epa-npl', {}),
      { slug: 'epa-clean', kind: 'dataset', meta: { lineage: { from: 'source:epa-npl', fetchedAt: 'then' } } },
    ]
    expect(markReplicatedPlans(rows)).toBe(1)
    expect((rows[0].meta.ingest as any).done).toEqual({ at: 'then', dataset: 'epa-clean' })
  })

  it('closes a link plan when the dataset names the dropped URL', () => {
    const rows = [
      planned('link-1', { url: 'https://hazards.fema.gov/nri.csv' }),
      {
        slug: 'nri',
        kind: 'dataset',
        meta: { lineage: { from: 'https://hazards.fema.gov/nri.csv', fetchedAt: 'then' } },
      },
    ]
    expect(markReplicatedPlans(rows)).toBe(1)
    expect((rows[0].meta.ingest as any).done.dataset).toBe('nri')
  })

  it('leaves alone every plan that is not an unfinished replicate', () => {
    const rows = [
      { slug: 'a', kind: 'source', meta: { ingest: { plan: 'index', decidedBy: 'n', decidedAt: 'x' } } },
      {
        slug: 'b',
        kind: 'source',
        meta: { ingest: { plan: 'replicate', decidedBy: 'n', decidedAt: 'x', done: { at: 'before' } } },
      },
      { slug: 'c', kind: 'source', meta: {} },
      { slug: 'a-data', kind: 'dataset', meta: { lineage: { from: 'source:a', fetchedAt: 't' } } },
      { slug: 'b-data', kind: 'dataset', meta: { lineage: { from: 'source:b', fetchedAt: 't' } } },
      { slug: 'c-data', kind: 'dataset', meta: { lineage: { from: 'source:c', fetchedAt: 't' } } },
    ]
    expect(markReplicatedPlans(rows)).toBe(0)
    expect((rows[1].meta.ingest as any).done).toEqual({ at: 'before' })
  })

  it('ignores lineage on anything that is not a dataset', () => {
    const rows = [
      planned('epa-npl', {}),
      { slug: 'note', kind: 'note', meta: { lineage: { from: 'source:epa-npl', fetchedAt: 't' } } },
    ]
    expect(markReplicatedPlans(rows)).toBe(0)
  })

  it('names both ways a dataset can point back at an entry', () => {
    expect(lineageKeysFor({ slug: 'x', meta: { url: 'https://a/b.csv' } })).toEqual(['source:x', 'https://a/b.csv'])
    expect(lineageKeysFor({ slug: 'x', meta: {} })).toEqual(['source:x'])
  })
})
