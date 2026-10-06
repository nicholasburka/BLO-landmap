import { describe, it, expect } from 'vitest'
import { readinessOf, fitsPlace, runnableAccess, isByHandOnly, type ReadinessRow } from './readiness.js'
import type { SourceMeta } from './sourceMeta.js'

function row(over: Partial<ReadinessRow> = {}): ReadinessRow {
  return { kind: 'incoming', meta: {}, files: [], ...over }
}

/** Entry files as the catalog stores them: library/<kind>/<slug>/<name>. */
function files(kind: string, slug: string, ...names: string[]) {
  return [{ key: `library/${kind}/${slug}/meta.json`, size: 10 }, ...names.map(n => ({ key: `library/${kind}/${slug}/${n}`, size: 100 }))]
}

const EPA: SourceMeta = {
  provider: 'EPA',
  access: [{ type: 'arcgis', url: 'https://gis.epa.gov/arcgis/rest/services/Sites/FeatureServer/0' }],
  placeQuery: { by: ['county', 'point'], fipsField: 'FIPS' },
}

describe('readinessOf — one case per `as` verdict', () => {
  it('dataset: a table we hold', () => {
    const verdict = readinessOf(row({ kind: 'dataset', files: files('datasets', 'orgs', 'organizations.csv') }))
    expect(verdict.as).toBe('dataset')
    expect(verdict.placeReport).toBe('never')
  })

  it('source: a registered pointer, whatever else it carries', () => {
    expect(readinessOf(row({ kind: 'source', meta: { source: EPA } })).as).toBe('source')
  })

  it('collection: a drop holding three readable files', () => {
    const verdict = readinessOf(row({ files: files('incoming', 'landowners', 'a.pdf', 'b.pdf', 'c.docx') }))
    expect(verdict.as).toBe('collection')
    expect(verdict.notes).toContain('text extracted from 3 of 3 files')
  })

  it('document: one readable file', () => {
    expect(readinessOf(row({ kind: 'document', files: files('documents', 'plan', 'plan.pdf') })).as).toBe('document')
  })

  it('page: a web page we read, holding nothing', () => {
    const verdict = readinessOf(row({ meta: { inspection: { kind: 'page' } } }))
    expect(verdict.as).toBe('page')
    expect(verdict.placeReport).toBe('never')
  })

  it('link: nothing read yet, and a link we could not reach', () => {
    expect(readinessOf(row()).as).toBe('link')
    expect(readinessOf(row()).notes).toContain('not read yet')
    const dead = readinessOf(row({ meta: { inspection: { kind: 'unreachable' } } }))
    expect(dead.as).toBe('link')
    expect(dead.notes).toContain('could not be reached')
  })

  it('a page whose files are all unreadable is still a document, and says so', () => {
    const verdict = readinessOf(row({ files: files('incoming', 'deck', 'slides.pptx') }))
    expect(verdict.as).toBe('document')
    expect(verdict.notes).toContain('text extracted from 0 of 1 file')
  })

  it('a note is a document — we hold the words, there is nothing to fetch', () => {
    expect(readinessOf(row({ kind: 'note', files: files('notes', 'idea') })).as).toBe('document')
  })
})

describe('readinessOf — one case per `placeReport` verdict', () => {
  it('runs: a source with an endpoint we can query for a place', () => {
    const verdict = readinessOf(row({ kind: 'source', meta: { source: EPA } }))
    expect(verdict.placeReport).toBe('runs')
    expect(verdict.notes).toEqual([])
  })

  it('by-hand: manual and WFS access only', () => {
    const source: SourceMeta = { provider: 'A county clerk', access: [{ type: 'manual', notes: 'phone' }, { type: 'wfs', url: 'https://gis.example.gov/wfs' }] }
    expect(readinessOf(row({ kind: 'source', meta: { source } })).placeReport).toBe('by-hand')
  })

  it('never: a source block with no endpoint at all', () => {
    const source: SourceMeta = { provider: 'State of Georgia' }
    const verdict = readinessOf(row({ kind: 'source', meta: { source } }))
    expect(verdict.placeReport).toBe('never')
    expect(verdict.notes).toContain('no endpoint to query')
  })

  it('candidate: a dropped link the inspector found an endpoint on', () => {
    const verdict = readinessOf(row({ meta: { inspection: { kind: 'arcgis-layer' } } }))
    expect(verdict.placeReport).toBe('candidate')
    for (const kind of ['arcgis-service', 'socrata', 'file']) {
      expect(readinessOf(row({ meta: { inspection: { kind } } })).placeReport).toBe('candidate')
    }
  })

  it('a runnable source that never said how to ask for a county says so', () => {
    const source: SourceMeta = { provider: 'EPA', access: [{ type: 'socrata', url: 'https://data.example.gov/resource/abcd-1234.json' }] }
    const verdict = readinessOf(row({ kind: 'source', meta: { source } }))
    expect(verdict.placeReport).toBe('runs')
    expect(verdict.notes).toContain('answers a point, not a whole county')
  })
})

describe('readinessOf — notes', () => {
  it('counts the documents a page offers and says when the page was http', () => {
    const verdict = readinessOf(
      row({
        meta: {
          inspection: {
            kind: 'page',
            page: { insecure: true },
            documents: [{ url: 'http://x.org/a.pdf', label: 'A' }, { url: 'http://x.org/b.pdf', label: 'B' }],
          },
        },
      }),
    )
    expect(verdict.as).toBe('page')
    expect(verdict.notes).toEqual(['2 documents on the page can be pulled in', 'served over http'])
  })

  it('says one document, singular, and never invents a note it has no reason for', () => {
    const verdict = readinessOf(row({ meta: { inspection: { kind: 'portal', documents: [{ url: 'https://x.org/a.pdf', label: 'A' }] } } }))
    expect(verdict.notes).toEqual(['1 document on the page can be pulled in'])
  })
})

describe('the shared place rule', () => {
  it('fitsPlace: a point fits anything; a bare county needs a source that answers by county', () => {
    const point = { lat: 33.7, lng: -84.4 }
    const county = { lat: null, lng: null }
    const parcelOnly: SourceMeta = { provider: 'P', placeQuery: { by: ['parcel'] } }
    expect(fitsPlace(parcelOnly, point)).toBe(true)
    expect(fitsPlace(parcelOnly, county)).toBe(false)
    expect(fitsPlace({ provider: 'P', placeQuery: { fipsField: 'GEOID' } }, county)).toBe(true)
    expect(fitsPlace({ provider: 'P' }, county)).toBe(false)
  })

  it('runnableAccess picks the first method an adapter can run; isByHandOnly is the rest', () => {
    expect(runnableAccess(EPA)?.type).toBe('arcgis')
    // An arcgis method with no url is not runnable, and it is not by hand either.
    const broken: SourceMeta = { provider: 'P', access: [{ type: 'arcgis' }] }
    expect(runnableAccess(broken)).toBeUndefined()
    expect(isByHandOnly(broken)).toBe(false)
    expect(isByHandOnly({ provider: 'P', access: [{ type: 'manual' }] })).toBe(true)
    expect(isByHandOnly({ provider: 'P' })).toBe(false)
  })
})

describe('cannotAnswerPlace — the static half of "can a report run this" (2026-09-15)', async () => {
  const { cannotAnswerPlace, readinessOf } = await import('./readiness.js')
  const row = (access: Record<string, unknown>[], placeQuery: Record<string, unknown> = { by: ['point', 'county'] }) => ({
    slug: 'x', kind: 'source', title: 'X', category: 'environment', status: 'published', tags: [], bytes: 1,
    files: [{ key: 'library/sources/x/meta.json', size: 1 }],
    meta: { source: { provider: 'Agency', access, placeQuery } },
  })
  it('an ArcGIS or Socrata endpoint runs', () => {
    expect(readinessOf(row([{ type: 'arcgis', url: 'https://gis.example/arcgis/rest/services/x/FeatureServer/0' }]) as never).placeReport).toBe('runs')
    expect(readinessOf(row([{ type: 'socrata', url: 'https://data.example/resource/abcd-1234.json' }]) as never).placeReport).toBe('runs')
  })
  it('a REST endpoint runs only with a place placeholder in its template', () => {
    expect(readinessOf(row([{ type: 'rest', url: 'https://api.census.gov/data/2023/acs/acs5' }]) as never).placeReport).toBe('by-hand')
    expect(cannotAnswerPlace({ provider: 'A', access: [{ type: 'rest', url: 'https://api.example/x' }] } as never)).toBe('its REST endpoint has no place template')
    expect(readinessOf(row([{ type: 'rest', url: 'https://api.example/x' }], { by: ['point'], template: 'https://api.example/x?lat={lat}&lng={lng}' }) as never).placeReport).toBe('runs')
  })
  it('a download runs only when it is a CSV or GeoJSON', () => {
    expect(readinessOf(row([{ type: 'download', url: 'https://arlweb.msha.gov/OpenGovernmentData/OGIMSHA.asp' }]) as never).placeReport).toBe('by-hand')
    expect(readinessOf(row([{ type: 'download', url: 'https://www.nhc.noaa.gov/gis/x.zip', format: 'geotiff' }]) as never).placeReport).toBe('by-hand')
    expect(readinessOf(row([{ type: 'download', url: 'https://data.example/sites.csv' }]) as never).placeReport).toBe('runs')
    expect(readinessOf(row([{ type: 'download', url: 'https://data.example/download?id=9', format: 'geojson' }]) as never).placeReport).toBe('runs')
  })
  it('says why a by-hand source is by hand', () => {
    const notes = readinessOf(row([{ type: 'rest', url: 'https://api.example/x' }]) as never).notes
    expect(notes).toContain('its REST endpoint has no place template')
  })
})
