import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchRecentEdits, recentlyEdited, EDITS_TOTAL, MINE_COUNT, type EditRow } from '../recentlyEdited'

const row = (slug: string, actor: string, at: string, kind = 'wiki'): EditRow => ({
  at,
  actor,
  target: { slug, title: slug.replace(/-/g, ' '), kind, href: kind === 'wiki' ? `/wiki/${slug}` : `/library/${slug}` },
})

/** Newest first, as the route hands them over. */
const FEED: EditRow[] = [
  row('field-notes', 'maria', '2026-09-23T12:00:00Z'),
  row('funding', 'nick', '2026-09-23T11:00:00Z'),
  row('organizations', 'maria', '2026-09-23T10:00:00Z', 'dataset'),
  row('evidence-base', 'omar', '2026-09-23T09:00:00Z'),
  row('seed-catalog', 'maria', '2026-09-23T08:00:00Z'),
  row('why-five-million', 'nick', '2026-09-23T07:00:00Z'),
  row('home', 'omar', '2026-09-23T06:00:00Z'),
  row('land-loss', 'maria', '2026-09-23T05:00:00Z'),
]

describe('recentlyEdited — mine first, then anyone (P6-5)', () => {
  it('leads with the three the person edited last, marked, then fills from everyone', () => {
    const list = recentlyEdited(FEED, 'maria')
    expect(list).toHaveLength(EDITS_TOTAL)
    expect(list.map(r => [r.target.slug, r.mine])).toEqual([
      // Maria's last three, newest first.
      ['field-notes', true],
      ['organizations', true],
      ['seed-catalog', true],
      // Then the newest by anyone that is not already on the list.
      ['funding', false],
      ['evidence-base', false],
      ['why-five-million', false],
    ])
    expect(MINE_COUNT).toBe(3)
  })

  it('never repeats an entry between the two halves', () => {
    const slugs = recentlyEdited(FEED, 'maria').map(r => r.target.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('is just "recently updated by anyone" for a new colleague', () => {
    const list = recentlyEdited(FEED, 'newcomer')
    expect(list.every(r => r.mine)).toBe(false)
    expect(list.map(r => r.target.slug)).toEqual([
      'field-notes',
      'funding',
      'organizations',
      'evidence-base',
      'seed-catalog',
      'why-five-million',
    ])
  })

  it('does the same when nobody is signed in yet, rather than throwing', () => {
    expect(recentlyEdited(FEED, null).map(r => r.mine)).toEqual([false, false, false, false, false, false])
    expect(recentlyEdited(FEED, '  ')).toHaveLength(EDITS_TOTAL)
  })

  it('takes fewer than three of mine when that is all there are', () => {
    const list = recentlyEdited(FEED, 'omar')
    expect(list.filter(r => r.mine).map(r => r.target.slug)).toEqual(['evidence-base', 'home'])
    expect(list).toHaveLength(EDITS_TOTAL)
  })

  it('is empty, not broken, when nothing has been edited', () => {
    expect(recentlyEdited([], 'maria')).toEqual([])
  })

  it('honours a different shape of list when a caller asks for one', () => {
    const list = recentlyEdited(FEED, 'maria', { mine: 1, total: 3 })
    expect(list.map(r => [r.target.slug, r.mine])).toEqual([
      ['field-notes', true],
      ['funding', false],
      ['organizations', false],
    ])
  })
})

describe('fetchRecentEdits', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const ok = (body: unknown) =>
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body } as unknown as Response)

  it('asks the route for more rows than the list shows', async () => {
    ok({ rows: [] })
    await fetchRecentEdits()
    expect(fetchMock.mock.calls[0][0]).toContain('/api/library/recent-edits?limit=24')
  })

  it('keeps the rows that can be opened and drops the ones that cannot', async () => {
    ok({
      rows: [
        { at: 'now', actor: 'maria', target: { slug: 'home', title: 'Start here', kind: 'wiki', href: '/wiki/home' } },
        // No target at all, and a target with no href: neither is a link.
        { at: 'now', actor: 'maria' },
        { at: 'now', actor: 'maria', target: { slug: 'x', title: 'X', kind: 'note' } },
      ],
    })
    const rows = await fetchRecentEdits()
    expect(rows.map(r => r.target.slug)).toEqual(['home'])
  })

  it('falls back to the slug when a row has lost its title', async () => {
    ok({ rows: [{ at: 'now', actor: 'nick', target: { slug: 'land-loss', href: '/library/land-loss' } }] })
    const rows = await fetchRecentEdits()
    expect(rows[0].target.title).toBe('land-loss')
    expect(rows[0].target.kind).toBe('')
  })

  it('throws when the request fails, so the block can say so', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
    await expect(fetchRecentEdits()).rejects.toThrow('recent edits request failed (503)')
  })

  it('treats a body with no rows as no edits', async () => {
    ok({})
    await expect(fetchRecentEdits()).resolves.toEqual([])
  })
})
