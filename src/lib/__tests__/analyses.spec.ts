import { describe, it, expect } from 'vitest'
import {
  analysisFromReport,
  analysisFromView,
  foundLine,
  recentAnalyses,
  ANALYSIS_KIND_LABELS,
} from '../analyses'
import type { SavedViewSummary } from '../views'
import type { PlaceReportRow } from '../placeReport'

const view = (over: Partial<SavedViewSummary> = {}): SavedViewSummary => ({
  slug: 'georgia-shortlist',
  name: 'Georgia shortlist',
  type: 'map',
  dataset: '',
  // P7-1: '' is the ad-hoc view — the state every view written before P7-1
  // is in, permanently.
  workingSet: '',
  description: 'Fulton, DeKalb, Clayton',
  savedBy: 'maria',
  savedAt: '2026-09-20T10:00:00Z',
  resultCount: 3,
  ...over,
})

const report = (over: Partial<PlaceReportRow> = {}): PlaceReportRow => ({
  placeKey: 'g13121',
  label: 'Fulton County, GA',
  by: 'nick',
  at: '2026-09-21T10:00:00Z',
  found: 4,
  sources: 12,
  ...over,
})

describe('a saved view as an analysis (P6-4)', () => {
  it('carries its kind, who saved it and when, and opens through the shim', () => {
    expect(analysisFromView(view())).toEqual({
      key: 'view:georgia-shortlist',
      kind: 'map',
      kindLabel: 'Map view',
      title: 'Georgia shortlist',
      href: '/views/georgia-shortlist',
      by: 'maria',
      at: '2026-09-20T10:00:00Z',
      line: 'Fulton, DeKalb, Clayton',
    })
  })

  it('names all three kinds of view in plain words', () => {
    expect(analysisFromView(view({ type: 'table' })).kindLabel).toBe('Table view')
    expect(analysisFromView(view({ type: 'compare' })).kindLabel).toBe('Comparison')
    expect(ANALYSIS_KIND_LABELS.place).toBe('Place report')
  })
})

describe('a cached place report as an analysis (P6-4)', () => {
  it('opens the /place URL that reopens it from cache, and says what it found', () => {
    expect(analysisFromReport(report())).toEqual({
      key: 'place:g13121',
      kind: 'place',
      kindLabel: 'Place report',
      title: 'Fulton County, GA',
      href: '/place?geoid=13121',
      by: 'nick',
      at: '2026-09-21T10:00:00Z',
      line: '4 of 12 sources found something',
    })
  })

  it('reopens a point report at its own coordinates and radius', () => {
    const row = analysisFromReport(report({ placeKey: 'p33.7490_-84.3880_r5', label: '55 Trinity Ave SW' }))
    expect(row.href).toBe('/place?lat=33.749&lng=-84.388&radius=5')
  })

  it('leaves the link empty for a key we do not recognise, rather than guessing', () => {
    expect(analysisFromReport(report({ placeKey: 'nonsense' })).href).toBe('')
  })

  it('falls back to the key when the report never recorded a label', () => {
    expect(analysisFromReport(report({ label: '' })).title).toBe('g13121')
  })

  it('counts honestly', () => {
    expect(foundLine(0, 12)).toBe('0 of 12 sources found something')
    expect(foundLine(1, 1)).toBe('1 of 1 source found something')
    expect(foundLine(0, 0)).toBe('No sources ran')
  })
})

describe('both lists as one (P6-4)', () => {
  it('interleaves views and reports, newest first', () => {
    const rows = recentAnalyses(
      [view({ slug: 'a', savedAt: '2026-09-18T10:00:00Z' }), view({ slug: 'b', savedAt: '2026-09-22T10:00:00Z' })],
      [report({ placeKey: 'g13121', at: '2026-09-21T10:00:00Z' }), report({ placeKey: 'g13089', at: '2026-09-19T10:00:00Z' })],
    )
    expect(rows.map(r => r.key)).toEqual(['view:b', 'place:g13121', 'place:g13089', 'view:a'])
  })

  it('takes only as many as asked for', () => {
    const rows = recentAnalyses([view({ slug: 'a' }), view({ slug: 'b' })], [report()], 2)
    expect(rows).toHaveLength(2)
  })

  it('puts anything with no time on it last', () => {
    const rows = recentAnalyses([view({ slug: 'undated', savedAt: '' })], [report()])
    expect(rows.map(r => r.key)).toEqual(['place:g13121', 'view:undated'])
  })

  it('is an empty list when nothing has been run', () => {
    expect(recentAnalyses([], [])).toEqual([])
  })
})
