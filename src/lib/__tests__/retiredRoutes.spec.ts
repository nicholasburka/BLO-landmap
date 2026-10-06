import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { retiredTarget } from '../retiredRoutes'

/**
 * P6-5: every deep link written during phase 5 has to keep working. These are
 * the ones that exist — the attention panel's hrefs, the landing's tiles, the
 * help recipes, the two wiki pages, and what people typed themselves.
 */
describe('retiredTarget — /library', () => {
  it('sends held datasets and indexed sources to the datasets browser', () => {
    // `/datasets` asks "do we hold it?", so the kind has to be translated or
    // the list would come back unfiltered.
    expect(retiredTarget('/library', { kind: 'dataset' })).toEqual({ path: '/datasets', query: { readiness: 'held' } })
    expect(retiredTarget('/library', { kind: 'source' })).toEqual({ path: '/datasets', query: { readiness: 'indexed' } })
  })

  it('sends pages, documents, notes and the queue to the docs browser', () => {
    for (const kind of ['document', 'wiki', 'note', 'incoming']) {
      expect(retiredTarget('/library', { kind }), kind).toEqual({ path: '/docs', query: { kind } })
    }
  })

  it('sends saved views to analysis', () => {
    expect(retiredTarget('/library', { kind: 'view' })).toEqual({ path: '/analysis', query: {} })
  })

  it('keeps the rest of the query on the way', () => {
    expect(retiredTarget('/library', { kind: 'dataset', topic: 'water', q: 'wells' })).toEqual({
      path: '/datasets',
      query: { topic: 'water', q: 'wells', readiness: 'held' },
    })
    expect(retiredTarget('/library', { kind: 'note', purpose: 'ideas' })).toEqual({
      path: '/docs',
      query: { purpose: 'ideas', kind: 'note' },
    })
  })

  it('sends the ideas shelf to docs, under either spelling of the query', () => {
    expect(retiredTarget('/library', { purpose: 'ideas' })).toEqual({ path: '/docs', query: { purpose: 'ideas' } })
    // P5-65 renamed `category` to `purpose`; links sent before it still work.
    expect(retiredTarget('/library', { category: 'ideas' })).toEqual({ path: '/docs', query: { purpose: 'ideas' } })
  })

  it('sends a queue link where that queue now lives', () => {
    expect(retiredTarget('/library', { attention: 'no-organization' })).toEqual({
      path: '/datasets',
      query: { attention: 'no-organization' },
    })
    expect(retiredTarget('/library', { attention: 'source-failing' })).toEqual({
      path: '/datasets',
      query: { attention: 'source-failing' },
    })
    expect(retiredTarget('/library', { attention: 'no-plan' })).toEqual({ path: '/docs', query: { attention: 'no-plan' } })
    expect(retiredTarget('/library', { attention: 'uncategorised' })).toEqual({
      path: '/docs',
      query: { attention: 'uncategorised' },
    })
  })

  it('turns the old status links into the queues they were', () => {
    expect(retiredTarget('/library', { status: 'needs-cataloging' })).toEqual({ path: '/docs', query: { attention: 'to-file' } })
    expect(retiredTarget('/library', { status: 'needs-review' })).toEqual({ path: '/docs', query: { attention: 'needs-review' } })
    expect(retiredTarget('/library', { status: 'in-cleaning' })).toEqual({
      path: '/datasets',
      query: { attention: 'in-cleaning' },
    })
  })

  it('sends a drop or an upload to the page that adds things', () => {
    expect(retiredTarget('/library', { drop: 'link' })).toEqual({ path: '/new', query: {} })
    expect(retiredTarget('/library', { upload: '1' })).toEqual({ path: '/new', query: {} })
  })

  it('falls back to search when nothing says which browser, keeping the filters', () => {
    expect(retiredTarget('/library', {})).toEqual({ path: '/search', query: {} })
    expect(retiredTarget('/library', { q: 'absentee owners', topic: 'land' })).toEqual({
      path: '/search',
      query: { q: 'absentee owners', topic: 'land' },
    })
  })

  it('drops an empty filter rather than carrying it', () => {
    expect(retiredTarget('/library', { kind: 'dataset', topic: '' })).toEqual({
      path: '/datasets',
      query: { readiness: 'held' },
    })
  })

  it('reads the first value of a repeated key, and tolerates junk', () => {
    expect(retiredTarget('/library', { kind: ['dataset', 'source'] })).toEqual({
      path: '/datasets',
      query: { readiness: 'held' },
    })
    expect(retiredTarget('/library', { kind: null, q: 'x' })).toEqual({ path: '/search', query: { q: 'x' } })
  })
})

describe('retiredTarget — the other three', () => {
  it('sends the layers index to the datasets browser, filtered to what a layer is', () => {
    expect(retiredTarget('/layers')).toEqual({ path: '/datasets', query: { type: 'statistics' } })
    expect(retiredTarget('/layers', { q: 'flood' })).toEqual({ path: '/datasets', query: { q: 'flood', type: 'statistics' } })
  })

  it('sends the pages index to docs', () => {
    expect(retiredTarget('/wiki')).toEqual({ path: '/docs', query: { kind: 'wiki' } })
    // The landing's old "New page" link: the focus flag travels.
    expect(retiredTarget('/wiki', { new: '1' })).toEqual({ path: '/docs', query: { new: '1', kind: 'wiki' } })
  })

  it('sends Ask to Chat with the question still attached', () => {
    expect(retiredTarget('/ask')).toEqual({ path: '/chat', query: {} })
    expect(retiredTarget('/ask', { q: 'who owns this land' })).toEqual({
      path: '/chat',
      query: { q: 'who owns this land' },
    })
  })

  it('ignores a trailing slash', () => {
    expect(retiredTarget('/library/', { kind: 'view' })).toEqual({ path: '/analysis', query: {} })
    expect(retiredTarget('/wiki/')).toEqual({ path: '/docs', query: { kind: 'wiki' } })
  })

  it('lands anything unexpected on the front door rather than throwing', () => {
    expect(retiredTarget('/nope')).toEqual({ path: '/kb', query: {} })
  })
})

describe('the routes that did NOT move', () => {
  /**
   * The router cannot be imported here (it pulls in HomeView → Map.vue →
   * mapbox-gl, which does not survive jsdom), so the route table is read from
   * its source — a renamed route fails this, which a hand-written list would
   * not.
   */
  const source = readFileSync(resolve(process.cwd(), 'src/router/index.ts'), 'utf8')
  const paths = [...source.matchAll(/^\s*path: '([^']+)'/gm)].map(m => m[1])

  it('keeps every entry route the cutover promised to leave alone', () => {
    for (const path of ['/library/:slug', '/wiki/:slug', '/layers/:id', '/views/:slug', '/place', '/compare']) {
      expect(paths, path).toContain(path)
    }
  })

  it('keeps the four retired paths as routes, so they redirect rather than 404', () => {
    for (const path of ['/library', '/wiki', '/layers', '/ask']) {
      expect(paths, path).toContain(path)
    }
    // …and all four are the redirect component, not a page of their own.
    expect(source.match(/RetiredRedirect\.vue/g)).toHaveLength(4)
  })

  it('has a route for each of the new surfaces', () => {
    for (const path of ['/kb', '/search', '/chat', '/new', '/datasets', '/docs', '/analysis']) {
      expect(paths, path).toContain(path)
    }
  })
})

describe('a retired tag link (P6-21)', () => {
  // It used to forward `tag` to /search, which has no such filter and dropped
  // it — a blank page with an empty box, from every tag on every entry.
  it('becomes the search words, because the catalog can answer that', () => {
    expect(retiredTarget('/library', { tag: 'environmental-risk' })).toEqual({
      path: '/search',
      query: { q: 'environmental-risk' },
    })
  })

  it('never carries a dropped filter key through', () => {
    const target = retiredTarget('/library', { tag: 'heirs-property' })
    expect(target.query).not.toHaveProperty('tag')
  })

  it('leaves an explicit query alone — the person said what they wanted', () => {
    expect(retiredTarget('/library', { tag: 'land', q: 'georgia' })).toEqual({
      path: '/search',
      query: { q: 'georgia' },
    })
  })
})
