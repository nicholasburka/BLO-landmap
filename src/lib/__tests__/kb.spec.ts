import { describe, it, expect } from 'vitest'
import {
  kbCounts,
  recentlyUpdated,
  entryHref,
  kindLabel,
  relativeTime,
  attentionItems,
  attentionKeysFor,
  attentionLabel,
  matchesAttention,
  needsALookFields,
  needsALookFieldsFor,
  needsALookNote,
  isNeedsALookKey,
  ATTENTION_KEYS,
} from '../kb'
import type { CatalogEntry } from '../libraryCatalog'

const e = (over: Partial<CatalogEntry>): CatalogEntry => ({ slug: 'x', kind: 'document', title: 'X', category: '', status: 'published', tags: [], meta: {}, files: [], bytes: 0, ...over })

describe('kb helpers (UX pass)', () => {
  const entries = [
    e({ slug: 'hub', kind: 'wiki', updatedAt: '2026-09-04T10:00:00Z' }),
    e({ slug: 'orgs', kind: 'dataset', category: 'network', updatedAt: '2026-09-04T12:00:00Z' }),
    e({ slug: 'plan', kind: 'document', updatedAt: '2026-09-01T00:00:00Z' }),
    e({ slug: 'old', kind: 'document', status: 'archived', updatedAt: '2026-09-05T00:00:00Z' }),
    e({ slug: 'drop', kind: 'incoming', status: 'needs-cataloging' }),
    e({ slug: 'idea', kind: 'note', category: 'ideas', status: 'open' }),
    e({ slug: 'v', kind: 'view', category: 'views' }),
    // P5-64: the registry is 40 entries the landing used to count as nothing.
    e({ slug: 'epa-npl', kind: 'source', category: 'environment' }),
    e({ slug: 'fema-nfhl', kind: 'source', category: 'hazards' }),
  ]

  it('leaves archived entries out of the tiles, as every list does (P5-64)', () => {
    const rows = [
      e({ slug: 'a', kind: 'document' }),
      e({ slug: 'b', kind: 'document', status: 'archived' }),
      e({ slug: 'c', kind: 'source', status: 'archived' }),
      e({ slug: 'd', kind: 'wiki' }),
    ]
    const c = kbCounts(rows)
    expect(c.documents).toBe(1)
    expect(c.sources).toBe(0)
    expect(c.pages).toBe(1)
  })

  it('counts by kind, queue, ideas, and the data sources we only index', () => {
    expect(kbCounts(entries)).toEqual({ pages: 1, datasets: 1, documents: 2, notes: 1, views: 1, queue: 1, ideas: 1, sources: 2 })
  })

  it('orders recently updated by updatedAt, skips archived, honours kind filters and limits', () => {
    expect(recentlyUpdated(entries).map(x => x.slug)).toEqual(['orgs', 'hub', 'plan', 'drop', 'idea', 'v', 'epa-npl', 'fema-nfhl'])
    expect(recentlyUpdated(entries, 2, ['wiki', 'document']).map(x => x.slug)).toEqual(['hub', 'plan'])
  })

  it('routes pages and views to their own routes, everything else to the entry hub', () => {
    expect(entryHref({ kind: 'wiki', slug: 'a' })).toBe('/wiki/a')
    expect(entryHref({ kind: 'view', slug: 'a' })).toBe('/views/a')
    expect(entryHref({ kind: 'dataset', slug: 'a' })).toBe('/library/a')
    // P5-45: a public map layer's home is its about page, not a library entry.
    expect(entryHref({ kind: 'layer', slug: 'pct_Black' })).toBe('/layers/pct_Black')
    expect(kindLabel('wiki')).toBe('page')
    expect(kindLabel('incoming')).toBe('to file')
    expect(kindLabel('layer')).toBe('layer')
  })

  it('lists only the things that actually need attention, with deep links', () => {
    const link = (over: Partial<CatalogEntry>) =>
      e({ kind: 'incoming', meta: { url: 'https://data.census.gov/table/x' }, files: [{ key: 'library/incoming/a/meta.json', size: 10 }], ...over })
    const attention = [
      e({ slug: 'q1', kind: 'incoming', status: 'needs-cataloging' }),
      e({ slug: 'q2', kind: 'incoming', status: 'needs-cataloging' }),
      e({ slug: 'r1', kind: 'document', status: 'needs-review' }),
      e({ slug: 'c1', kind: 'dataset', status: 'in-cleaning' }),
      e({ slug: 'c2', kind: 'document', status: 'in-cleaning' }), // not a dataset — not counted
      link({ slug: 'l1', status: 'needs-review' }),
      // Already fetched: the link now has a real file alongside its manifest.
      link({ slug: 'l2', status: 'needs-review', files: [{ key: 'library/incoming/l2/meta.json', size: 10 }, { key: 'library/incoming/l2/table.csv', size: 99 }] }),
    ]
    // P6-5: every row is now `?attention=<key>` on the browser its rows live
    // in — the Library list they all used to open is gone. Both browsers
    // filter by the same predicate, so a count and its list are one set.
    expect(attentionItems(attention)).toEqual([
      { key: 'to-file', label: 'Waiting to be filed', count: 2, href: '/docs?attention=to-file' },
      { key: 'needs-review', label: 'Needs review', count: 3, href: '/docs?attention=needs-review' },
      // One dataset, so this queue's rows live in the datasets browser.
      { key: 'in-cleaning', label: 'Datasets in cleaning', count: 1, href: '/datasets?attention=in-cleaning' },
      { key: 'unfetched-links', label: 'Dropped links with no file yet', count: 1, href: '/docs?attention=unfetched-links' },
      // P5-59: both dropped links are waiting on the "how does this come in?"
      // decision; the quick drops with no URL are not.
      { key: 'no-plan', label: 'No ingest plan yet', count: 2, href: '/docs?attention=no-plan' },
      // (both `link()` rows carry a url and no ingest block)
      // P6-33: ONE row where `uncategorised`, `no-organization`, `no-coverage`
      // and `no-summary` used to be four. Seven entries have no topic and `c1`
      // additionally has no publisher and no coverage — so the four old rows
      // would have read 7 / 1 / 1 / 0 and implied ten jobs. There are seven.
      { key: 'needs-a-look', label: 'Needs a look', count: 7, href: '/docs?attention=needs-a-look' },
    ])
  })

  /**
   * P6-33's load-bearing case, and the one a naive implementation gets wrong:
   * the row is a list of entries to open, so an entry missing three fields is
   * ONE row of work, not three.
   */
  it('counts distinct entries, not gaps, so one entry missing four fields counts once', () => {
    // A dataset with no topic, no publisher, no coverage, (P7-7) no answers
    // line and (P7-10) neither date: six of the seven per-field keys, one job.
    // The case gets stronger with every field that lands, which is the point
    // of the roll-up — and P7-10 is the clearest demonstration of it yet,
    // because its two keys fall on entries `no-answers-line` already counted,
    // so the ROW's number does not move at all.
    const threeGaps = e({ slug: 'landholders', kind: 'dataset', status: 'published' })
    const oneGap = e({ slug: 'memo', kind: 'document', status: 'published' })
    const fine = e({ slug: 'ok', kind: 'dataset', status: 'published', category: 'land', organization: 'epa', coverage: { scope: 'national', states: [], label: 'National' }, dates: { covers: '2024', published: '2024-03' }, meta: { whatItAnswers: 'Answers: who owns what.' } })

    const item = attentionItems([threeGaps, oneGap, fine]).find(i => i.key === 'needs-a-look')
    // Summed gaps would be 7 (6 + 1). Distinct entries is 2.
    expect(item?.count).toBe(2)
    // And the summed reading is what the old rows gave, so the test says the
    // number out loud rather than trusting the implementation.
    const summed = ['uncategorised', 'no-organization', 'no-coverage', 'no-answers-line', 'no-period-covered', 'no-published-date', 'no-summary'].reduce(
      (n, key) => n + [threeGaps, oneGap, fine].filter(row => matchesAttention(row, key)).length,
      0,
    )
    expect(summed).toBe(7)
  })

  it('says which fields each listed entry is missing, so the collapse loses nothing', () => {
    const dataset = e({ slug: 'landholders', kind: 'dataset', status: 'published' })
    expect(needsALookNote(dataset)).toBe(
      'no topic · no organization · no coverage · no answers line · no period covered · no published date',
    )
    expect(needsALookFields(dataset).map(f => [f.field, f.state])).toEqual([
      ['topic', 'missing'],
      ['organization', 'missing'],
      ['coverage', 'missing'],
      ['whatItAnswers', 'missing'],
      ['covers', 'missing'],
      ['published', 'missing'],
    ])
    // `fetched` is never on the line: we work it out ourselves, and most of
    // the library was never fetched from anywhere.
    expect(needsALookFields(dataset).map(f => f.field)).not.toContain('fetched')
    // An entry missing nothing is not listed, and says nothing.
    const fine = e({ slug: 'ok', kind: 'dataset', status: 'published', category: 'land', organization: 'epa', coverage: { scope: 'national', states: [], label: 'National' }, dates: { covers: '2024', published: '2024-03' }, meta: { whatItAnswers: 'Answers: who owns what.' } })
    expect(needsALookFields(fine)).toEqual([])
    expect(needsALookNote(fine)).toBe('')
  })

  it('keeps every old deep link working, narrowed to its own field (P6-33)', () => {
    const dataset = e({ slug: 'landholders', kind: 'dataset', status: 'published' })
    // The browsers filter by `row.attention.includes(key)`, so every old key
    // has to still be on the row…
    expect(attentionKeysFor(dataset)).toEqual([
      'needs-a-look',
      'uncategorised',
      'no-organization',
      'no-coverage',
      'no-answers-line',
      'no-period-covered',
      'no-published-date',
    ])
    // …and the list a key opens narrows to that key's own field.
    expect(needsALookFieldsFor(dataset, 'no-coverage').map(f => f.field)).toEqual(['coverage'])
    expect(needsALookFieldsFor(dataset, 'uncategorised').map(f => f.field)).toEqual(['topic'])
    expect(needsALookFieldsFor(dataset, 'no-answers-line').map(f => f.field)).toEqual(['whatItAnswers'])
    // P7-10: two keys for two facts, each opening exactly its own field — a
    // row that read "no dates" would hide which of the two is missing.
    expect(needsALookFieldsFor(dataset, 'no-period-covered').map(f => f.field)).toEqual(['covers'])
    expect(needsALookFieldsFor(dataset, 'no-published-date').map(f => f.field)).toEqual(['published'])
    expect(needsALookFieldsFor(dataset, 'needs-a-look').map(f => f.field)).toEqual([
      'topic',
      'organization',
      'coverage',
      'whatItAnswers',
      'covers',
      'published',
    ])
    expect(needsALookFieldsFor(dataset, 'needs-review')).toEqual([])
    expect(isNeedsALookKey('needs-a-look')).toBe(true)
    expect(isNeedsALookKey('no-coverage')).toBe(true)
    expect(isNeedsALookKey('no-answers-line')).toBe(true)
    expect(isNeedsALookKey('no-period-covered')).toBe(true)
    expect(isNeedsALookKey('no-published-date')).toBe(true)
    expect(isNeedsALookKey('unverified')).toBe(true)
    expect(isNeedsALookKey('no-plan')).toBe(false)
  })

  /**
   * P7-10's own case: two new keys, and the ROW does not move.
   *
   * The row counts distinct entries, and the entries missing a date are the
   * same shaped entries `no-answers-line` already counts — so the number a
   * person sees is unchanged and what grows is the per-row line. That is the
   * whole argument for P6-33's roll-up, measured.
   */
  it('adds no work to the row when the dates land on entries already on it', () => {
    const untagged = e({ slug: 'sites', kind: 'dataset', status: 'published' })
    const before = ['uncategorised', 'no-organization', 'no-coverage', 'no-answers-line']
    const after = [...before, 'no-period-covered', 'no-published-date']
    expect(before.filter(key => matchesAttention(untagged, key)).length).toBe(4)
    expect(after.filter(key => matchesAttention(untagged, key)).length).toBe(6)
    // Six gaps, one row, count of one.
    expect(attentionItems([untagged]).find(i => i.key === 'needs-a-look')?.count).toBe(1)
  })

  it('takes a dated dataset off both date queues and leaves it on neither', () => {
    const dated = e({
      slug: 'acs',
      kind: 'dataset',
      status: 'published',
      category: 'land',
      organization: 'epa',
      coverage: { scope: 'national', states: [], label: 'National' },
      dates: { covers: '2019/2023', published: '2024-03' },
      meta: { whatItAnswers: 'Answers: how many households rent.' },
    })
    expect(matchesAttention(dated, 'no-period-covered')).toBe(false)
    expect(matchesAttention(dated, 'no-published-date')).toBe(false)
    expect(needsALookNote(dated)).toBe('')
    // One of the two is still an answer to "when is this from?", so a dataset
    // with only a period covered is off that queue and still on the other.
    const halfDated = { ...dated, dates: { covers: '2019/2023' } }
    expect(matchesAttention(halfDated, 'no-period-covered')).toBe(false)
    expect(matchesAttention(halfDated, 'no-published-date')).toBe(true)
    expect(needsALookNote(halfDated)).toBe('no published date')
  })

  it('never asks a wiki page or a note when it is from', () => {
    // They have an edit history already (the ticket's out-of-scope line), and
    // asking would put a row on the queue nobody could clear.
    for (const kind of ['wiki', 'document', 'note', 'view']) {
      const row = e({ slug: kind, kind, status: 'published', category: 'land' })
      expect(matchesAttention(row, 'no-period-covered')).toBe(false)
      expect(matchesAttention(row, 'no-published-date')).toBe(false)
    }
  })

  it('sends each queue to the browser its rows actually live in (P6-5)', () => {
    const dataset = e({ slug: 'a', kind: 'dataset', status: 'needs-review', category: 'land', organization: 'epa' })
    const source = e({ slug: 'b', kind: 'source', status: 'needs-review', category: 'land', organization: 'epa' })
    const doc = e({ slug: 'c', kind: 'document', status: 'needs-review', category: 'land' })
    const href = (entries: CatalogEntry[]) => attentionItems(entries).find(i => i.key === 'needs-review')?.href

    // Datasets and sources in the majority → the datasets browser.
    expect(href([dataset, source, doc])).toBe('/datasets?attention=needs-review')
    // Anything else, including a tie, reads as docs.
    expect(href([dataset, doc])).toBe('/docs?attention=needs-review')
    expect(href([doc])).toBe('/docs?attention=needs-review')
  })

  it('answers the same question for one entry as it does for the whole panel', () => {
    // This is what the browsers filter by, so the two cannot drift.
    const drop = e({ slug: 'q', kind: 'incoming', status: 'needs-cataloging' })
    expect(attentionKeysFor(drop)).toEqual(['to-file', 'needs-a-look', 'uncategorised'])
    expect(matchesAttention(drop, 'to-file')).toBe(true)
    expect(matchesAttention(drop, 'in-cleaning')).toBe(false)
    // A key nobody has heard of matches nothing, so a mistyped link shows an
    // empty list rather than the whole one.
    expect(matchesAttention(drop, 'not-a-queue')).toBe(false)
    expect(attentionKeysFor(e({ slug: 'p', kind: 'wiki', status: 'published' }))).toEqual([])
  })

  it('names every queue, and nothing else', () => {
    // P6-33: the vocabulary keeps a key per field — the panel shows one row.
    expect([...ATTENTION_KEYS]).toEqual([
      'to-file',
      'needs-review',
      'in-cleaning',
      'unfetched-links',
      'no-plan',
      'replicate-todo',
      'unreachable',
      'source-failing',
      'needs-a-look',
      'uncategorised',
      'no-organization',
      'no-coverage',
      'no-answers-line',
      'no-period-covered',
      'no-published-date',
      'no-summary',
      'unverified',
    ])
    // The panel is shorter than the vocabulary, deliberately and by exactly
    // the eight rolled-up keys.
    const everyGap = [
      e({ slug: 'a', kind: 'dataset', status: 'published' }),
      e({ slug: 'b', kind: 'incoming', status: 'published', meta: { url: 'https://x/y', fetch: { status: 'fetched', at: 'T' } } }),
    ]
    expect(attentionItems(everyGap).map(i => i.key)).toEqual(['unfetched-links', 'no-plan', 'needs-a-look'])
    expect(attentionLabel('needs-a-look')).toBe('Needs a look')
    expect(attentionLabel('no-organization')).toBe('Datasets with no organization')
    expect(attentionLabel('no-coverage')).toBe('Datasets with no coverage')
    expect(attentionLabel('no-answers-line')).toBe('Datasets with no answers line')
    expect(attentionLabel('no-period-covered')).toBe('Datasets with no period covered')
    expect(attentionLabel('no-published-date')).toBe('Datasets with no published date')
    expect(attentionLabel('not-a-queue')).toBe('')
  })

  it('does not ask a person to fetch a link the server is already fetching (P5-47)', () => {
    const link = (meta: Record<string, unknown>) =>
      e({ kind: 'incoming', status: 'needs-review', meta: { url: 'https://example.org/x.csv', ...meta }, files: [{ key: 'library/incoming/a/meta.json', size: 10 }] })
    const unfetched = (entries: CatalogEntry[]) => attentionItems(entries).find(i => i.key === 'unfetched-links')?.count ?? 0

    expect(unfetched([link({})])).toBe(1)
    expect(unfetched([link({ fetch: { status: 'queued', at: 'T' } })])).toBe(0)
    expect(unfetched([link({ fetch: { status: 'fetching', at: 'T' } })])).toBe(0)
    // A fetch that failed IS work waiting on a person again.
    expect(unfetched([link({ fetch: { status: 'failed', at: 'T', reason: 'the site refused the request' } })])).toBe(1)
    expect(unfetched([link({ fetch: { status: 'later', at: 'T' } })])).toBe(1)
  })

  it('is empty when nothing needs attention', () => {
    expect(
      attentionItems([e({ status: 'published', category: 'land' }), e({ kind: 'wiki', status: 'published' })]),
    ).toEqual([])
    expect(attentionItems([])).toEqual([])
  })

  it('counts an entry with no topic, and only for the kinds that carry one (P5-63)', () => {
    const row = (over: Partial<CatalogEntry>) => e({ status: 'published', ...over })
    // P6-33 folded this row into "Needs a look", but the predicate underneath
    // is unchanged and is what a `?attention=uncategorised` link still filters
    // by — so the test asks the predicate, as the browsers do.
    const noTopic = (entries: CatalogEntry[]) => entries.filter(row => matchesAttention(row, 'uncategorised')).length

    // A purpose says what it is FOR, not what it is about — still no topic.
    expect(noTopic([row({ kind: 'document', category: 'strategy' })])).toBe(1)
    // …until a tag names one.
    expect(noTopic([row({ kind: 'document', category: 'strategy', tags: ['funding', 'land'] })])).toBe(0)
    expect(noTopic([row({ kind: 'source', category: 'water' })])).toBe(0)
    // Through the aliases, like everywhere else.
    expect(noTopic([row({ kind: 'dataset', category: 'demographics' })])).toBe(0)
    // A page IS the knowledge base, and a view's category is a machine word.
    expect(noTopic([row({ kind: 'wiki' }), row({ kind: 'view', category: 'views' })])).toBe(0)
  })

  /**
   * Found live: two kept place reports sat on the needs-a-look queue with no
   * description, no extractable file and nothing a model could read — they
   * could never be filled, and nobody was ever going to assign a topic to the
   * library's own output. A queue that counts what it generates never drains.
   */
  it('never asks a person to file the library’s own output (the `ask` note)', () => {
    const row = (over: Partial<CatalogEntry>) => e({ status: 'published', ...over })
    const noTopic = (entries: CatalogEntry[]) => entries.filter(r => matchesAttention(r, 'uncategorised')).length

    // `saveAnswerAsNote` / `saveReportAsNote` write `category: research` and
    // the `ask` tag. A purpose is not a topic, so these used to count.
    const report = row({ slug: 'place-report-40-7785-73-9572', kind: 'note', category: 'research', tags: ['ask'], status: 'open' })
    const answer = row({ slug: 'kept-answer', kind: 'note', category: 'research', tags: ['ask'], status: 'open' })
    expect(noTopic([report, answer])).toBe(0)
    expect(needsALookNote(report)).toBe('')
    // A note a PERSON wrote is untouched — it is real content with a real gap.
    const written = row({ slug: 'for-william-idea', kind: 'note', category: 'strategy', tags: ['5-5-5', 'pitch'], status: 'open' })
    expect(noTopic([written])).toBe(1)
    // And the tag only excuses a NOTE: a document somebody tagged `ask` is
    // still a document somebody has to file.
    expect(noTopic([row({ kind: 'document', category: 'research', tags: ['ask'] })])).toBe(1)
  })

  it('counts what was read but never summarised (P5-83)', () => {
    const link = (meta: Record<string, unknown>) =>
      e({ kind: 'incoming', status: 'published', category: 'land', meta: { url: 'https://example.org/x', ...meta } })
    const noSummary = (entries: CatalogEntry[]) => entries.filter(row => matchesAttention(row, 'no-summary')).length

    expect(noSummary([link({ suggested: { error: 'unavailable', at: 'T', reason: 'refused' } })])).toBe(1)
    expect(noSummary([link({ fetch: { status: 'fetched', at: 'T', name: 'index.html' } })])).toBe(1)
    // A pass that worked, and a link nobody has read yet, are not this row.
    expect(noSummary([link({ fetch: { status: 'fetched', at: 'T' }, suggested: { summary: 'A page.', at: 'T', model: 'm' } })])).toBe(0)
    expect(noSummary([link({})])).toBe(0)
    // P6-33: it reaches the panel through the one row, and names itself there.
    const read = link({ suggested: { error: 'unavailable', at: 'T' } })
    expect(attentionItems([read]).at(-1)).toEqual({
      key: 'needs-a-look',
      label: 'Needs a look',
      count: 1,
      href: '/docs?attention=needs-a-look',
    })
    expect(needsALookNote(read)).toBe('no summary')
  })

  it('formats relative times', () => {
    const now = Date.parse('2026-09-04T12:00:00Z')
    expect(relativeTime('2026-09-04T11:59:30Z', now)).toBe('just now')
    expect(relativeTime('2026-09-04T11:20:00Z', now)).toBe('40m ago')
    expect(relativeTime('2026-09-04T03:00:00Z', now)).toBe('9h ago')
    expect(relativeTime('2026-09-01T12:00:00Z', now)).toBe('3d ago')
    expect(relativeTime(undefined, now)).toBe('')
    expect(relativeTime('nope', now)).toBe('')
  })
})

/**
 * P5-59: the admin "to ingest" queue. Each row's count and the list its link
 * opens have to be the same set, which is why the hrefs are `?attention=`
 * filters rather than approximations built out of `kind` and `status`.
 */
describe('the to-ingest queue (P5-59)', () => {
  const entry = (over: Partial<CatalogEntry>): CatalogEntry =>
    ({
      slug: 'x',
      kind: 'incoming',
      title: 'x',
      category: '',
      status: 'needs-review',
      tags: [],
      meta: {},
      files: [],
      bytes: 0,
      ...over,
    }) as CatalogEntry
  const row = (entries: CatalogEntry[], key: string) => attentionItems(entries).find(i => i.key === key)

  const plan = (over: Record<string, unknown> = {}) => ({
    plan: 'replicate',
    decidedBy: 'nick',
    decidedAt: '2026-09-06T00:00:00.000Z',
    ...over,
  })

  it('counts dropped links with no plan, and nothing else', () => {
    const entries = [
      entry({ slug: 'link', meta: { url: 'https://a/b.csv' } }),
      // P5-59, found live: counting sources too showed 47 rows of work for 7
      // links. A source is already indexed and already fetched on demand —
      // nobody is waiting on a decision about one.
      entry({ slug: 'source', kind: 'source', meta: { source: { provider: 'EPA' } } }),
      // A page, a document and a cleaned dataset are not waiting on it either.
      entry({ slug: 'page', kind: 'wiki', meta: {} }),
      entry({ slug: 'doc', kind: 'document', meta: {} }),
      entry({ slug: 'data', kind: 'dataset', meta: {} }),
      // Already decided.
      entry({ slug: 'decided', meta: { url: 'https://a/c.csv', ingest: plan({ plan: 'index' }) } }),
    ]
    expect(row(entries, 'no-plan')).toEqual({
      key: 'no-plan',
      label: 'No ingest plan yet',
      count: 1,
      href: '/docs?attention=no-plan',
    })
  })

  it('counts copies that were decided on and have not arrived', () => {
    const waiting = entry({ slug: 'a', meta: { url: 'https://a/b.csv', ingest: plan({ mode: 'manual' }) } })
    const arrived = entry({ slug: 'b', meta: { url: 'https://a/c.csv', ingest: plan({ done: { at: 'T', dataset: 'd' } }) } })
    const other = entry({ slug: 'c', meta: { url: 'https://a/d.csv', ingest: plan({ plan: 'fetch-on-demand' }) } })
    expect(row([waiting, arrived, other], 'replicate-todo')?.count).toBe(1)
    expect(row([arrived, other], 'replicate-todo')).toBeUndefined()
  })

  it('says which links could not be reached, in the words a person can act on', () => {
    const broken = entry({ slug: 'a', meta: { url: 'https://gone/x', inspection: { kind: 'unreachable', url: 'x', checkedAt: 'T' } } })
    const fine = entry({ slug: 'b', meta: { url: 'https://ok/x.csv', inspection: { kind: 'file', url: 'x', checkedAt: 'T' } } })
    const item = row([broken, fine], 'unreachable')
    expect(item?.count).toBe(1)
    expect(item?.label).toMatch(/check the link/i)
    expect(item?.href).toBe('/docs?attention=unreachable')
  })

  it('counts sources whose adapter is failing now, not ones that failed once', () => {
    const failing = entry({
      slug: 'a',
      kind: 'source',
      meta: { source: { provider: 'EPA', lastError: { at: 'T', code: 'http-error', text: 'the agency refused' } } },
    })
    const healthy = entry({ slug: 'b', kind: 'source', meta: { source: { provider: 'FEMA' } } })
    expect(row([failing, healthy], 'source-failing')?.count).toBe(1)
    expect(row([healthy], 'source-failing')).toBeUndefined()
  })

  it('counts datasets and sources nobody has filed under a publisher (P6-1)', () => {
    const known = entry({ slug: 'a', kind: 'source', status: 'published', organization: 'epa' })
    // A publisher the vocabulary has never met heads its own group, which is
    // exactly the gap: it is one row of one, not a publisher.
    const unknown = entry({ slug: 'b', kind: 'source', status: 'published', organization: 'Shelby County Register of Deeds' })
    const missing = entry({ slug: 'c', kind: 'dataset', status: 'published' })
    // A page and a document have no publisher to be missing.
    const page = entry({ slug: 'd', kind: 'wiki', status: 'published' })
    const doc = entry({ slug: 'e', kind: 'document', status: 'published' })

    // P6-33: the predicate is unchanged and still what `?attention=
    // no-organization` filters by; the panel reaches it through "Needs a look".
    const rows = [known, unknown, missing, page, doc]
    expect(rows.filter(r => matchesAttention(r, 'no-organization')).length).toBe(2)
    expect(attentionLabel('no-organization')).toBe('Datasets with no organization')
    expect(needsALookNote(missing)).toBe(
      'no topic · no organization · no coverage · no answers line · no period covered · no published date',
    )
    expect(needsALookNote(page)).toBe('')
    expect(row([known], 'no-organization')).toBeUndefined()
  })

  it('counts datasets and sources nothing could place, and never calls them national (P6-19)', () => {
    const national = entry({
      slug: 'a',
      kind: 'source',
      status: 'published',
      coverage: { scope: 'national', states: [], label: 'National' },
    })
    const georgia = entry({
      slug: 'b',
      kind: 'dataset',
      status: 'published',
      coverage: { scope: 'state', states: ['GA'], label: 'Georgia' },
    })
    // Points we hold whose state nothing could name still HAVE a coverage —
    // `local` is an answer, so this is not a gap.
    const local = entry({ slug: 'c', kind: 'dataset', status: 'published', coverage: { scope: 'local', states: [], label: 'Local area' } })
    // These two are the gap: a directory of people, and a source nobody filled in.
    const unplaceable = entry({ slug: 'd', kind: 'dataset', status: 'published' })
    const alsoUnplaceable = entry({ slug: 'e', kind: 'source', status: 'published' })
    // A page and a document have no ground to be missing.
    const page = entry({ slug: 'f', kind: 'wiki', status: 'published' })
    const doc = entry({ slug: 'g', kind: 'document', status: 'published' })

    const rows = [national, georgia, local, unplaceable, alsoUnplaceable, page, doc]
    // P6-33: the predicate a `?attention=no-coverage` link still filters by.
    expect(rows.filter(r => matchesAttention(r, 'no-coverage')).length).toBe(2)
    expect(attentionLabel('no-coverage')).toBe('Datasets with no coverage')
    expect(needsALookFieldsFor(unplaceable, 'no-coverage').map(f => f.field)).toEqual(['coverage'])
    // And it disappears entirely once everything is placed: these three carry
    // a topic, a publisher and a coverage apiece, so nothing needs a look.
    const placed = [national, georgia, local].map(r => ({
      ...r,
      category: 'land',
      organization: 'epa',
      dates: { covers: '2024', published: '2024-03' },
      meta: { whatItAnswers: 'Answers: who owns what.' },
    }))
    expect(row(placed, 'needs-a-look')).toBeUndefined()
  })

  it('drops every row that has nothing in it, as the panel always has', () => {
    expect(attentionItems([entry({ slug: 'a', kind: 'wiki', status: 'published', meta: {} })])).toEqual([])
  })
})

describe('attention counts match the lists they open (P6-23)', () => {
  // The audit's repro: "14 Entries with no topic" opened a list of 12, because
  // the landing fetches archived rows for its tiles and counted them here,
  // while both browsers drop them.
  const uncategorised = (slug: string, status: CatalogEntry['status'] = 'published'): CatalogEntry => ({
    slug,
    kind: 'document',
    title: slug,
    category: '',
    status,
    tags: [],
    meta: {},
    files: [],
    bytes: 0,
  })

  it('counts only the rows a browser would show', () => {
    const rows = [uncategorised('a'), uncategorised('b'), uncategorised('old', 'archived')]
    // P6-33 folded this row into "Needs a look"; the exclusion is unchanged.
    const item = attentionItems(rows).find(i => i.key === 'needs-a-look')
    expect(item?.count).toBe(2)
  })

  it('drops a row entirely when only archived entries match it', () => {
    const item = attentionItems([uncategorised('old', 'archived')]).find(i => i.key === 'needs-a-look')
    expect(item).toBeUndefined()
  })
})
