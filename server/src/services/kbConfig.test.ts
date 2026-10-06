import { describe, it, expect, vi } from 'vitest'
import { parseKbConfig, KB_DEFAULTS, entryHref } from './kbConfig.js'

/**
 * P5-40: `library/kb.json` is content, pushed like any other file, so the
 * parser must survive anything a person can type into it. Every field is
 * optional; anything malformed falls back to the default rather than
 * breaking the landing page.
 */

describe('parseKbConfig', () => {
  it('returns defaults for a missing, non-object, or empty file', () => {
    expect(parseKbConfig(undefined)).toEqual(KB_DEFAULTS)
    expect(parseKbConfig(null)).toEqual(KB_DEFAULTS)
    expect(parseKbConfig('nope')).toEqual(KB_DEFAULTS)
    expect(parseKbConfig([1, 2])).toEqual(KB_DEFAULTS)
    expect(parseKbConfig({})).toEqual(KB_DEFAULTS)
    expect(KB_DEFAULTS.homeSlug).toBe('home')
  })

  it('keeps a valid homeSlug and falls back on a bad one', () => {
    expect(parseKbConfig({ homeSlug: 'front-door' }).homeSlug).toBe('front-door')
    expect(parseKbConfig({ homeSlug: '  front-door  ' }).homeSlug).toBe('front-door')
    expect(parseKbConfig({ homeSlug: '../../etc/passwd' }).homeSlug).toBe('home')
    expect(parseKbConfig({ homeSlug: 42 }).homeSlug).toBe('home')
  })

  it('cleans the pinned list: strings only, deduped, slug-shaped, capped', () => {
    expect(parseKbConfig({ pinned: ['home', ' organizations ', 'home', 7, '', 'Bad Slug'] }).pinned).toEqual([
      'home',
      'organizations',
    ])
    const many = Array.from({ length: 30 }, (_, i) => `entry-${i}`)
    expect(parseKbConfig({ pinned: many }).pinned).toHaveLength(12)
    expect(parseKbConfig({ pinned: 'home' }).pinned).toEqual([])
  })

  it('accepts an initiative with facts, next step, and drops unusable pieces', () => {
    const cfg = parseKbConfig({
      initiative: {
        name: 'Black Homesteading Initiative (5-5-5)',
        tagline: 'Five years, $5 million, 5,000 acres.',
        facts: [
          { label: 'Years', value: '2027–2032', href: '/library/five-year-strategic-plan' },
          { label: 'Raise', value: '$5 million' },
          { label: '', value: 'dropped — no label' },
          { label: 'Bad link', value: '1', href: 'javascript:alert(1)' },
          'nope',
        ],
        nextStep: { text: 'Read the hub page', href: '/wiki/homesteading-initiative' },
      },
    })
    expect(cfg.initiative).toEqual({
      name: 'Black Homesteading Initiative (5-5-5)',
      tagline: 'Five years, $5 million, 5,000 acres.',
      facts: [
        { label: 'Years', value: '2027–2032', href: '/library/five-year-strategic-plan' },
        { label: 'Raise', value: '$5 million' },
        // The javascript: href is stripped, the fact itself survives.
        { label: 'Bad link', value: '1' },
      ],
      nextStep: { text: 'Read the hub page', href: '/wiki/homesteading-initiative' },
    })
  })

  it('drops an initiative with no name, and a next step with no href', () => {
    expect(parseKbConfig({ initiative: { tagline: 'orphan' } }).initiative).toBeNull()
    expect(parseKbConfig({ initiative: 'nope' }).initiative).toBeNull()
    const cfg = parseKbConfig({ initiative: { name: 'X', nextStep: { text: 'go' } } })
    expect(cfg.initiative).toEqual({ name: 'X', tagline: '', facts: [], nextStep: null })
  })

  it('keeps well-formed links and drops unsafe or malformed ones', () => {
    const cfg = parseKbConfig({
      links: [
        { label: 'Library guide', href: '/wiki/library-guide' },
        { label: 'Census', href: 'https://data.census.gov/' },
        { label: 'Bad', href: 'javascript:alert(1)' },
        { label: 'Protocol-relative', href: '//evil.example' },
        { label: 'No href' },
        'nope',
      ],
    })
    expect(cfg.links).toEqual([
      { label: 'Library guide', href: '/wiki/library-guide' },
      { label: 'Census', href: 'https://data.census.gov/' },
    ])
  })

  it('ignores unknown keys instead of failing', () => {
    const cfg = parseKbConfig({ homeSlug: 'home', somethingNew: { a: 1 }, pinned: ['home'] })
    expect(cfg).toEqual({ ...KB_DEFAULTS, homeSlug: 'home', pinned: ['home'] })
  })

  it('sends pages and views to their own routes, everything else to the entry hub', () => {
    expect(entryHref('wiki', 'home')).toBe('/wiki/home')
    expect(entryHref('view', 'delta')).toBe('/views/delta')
    expect(entryHref('dataset', 'organizations')).toBe('/library/organizations')
    expect(entryHref('incoming', 'a-b')).toBe('/library/a-b')
  })
})

describe('parseKbConfig logging', () => {
  it('does not throw on deeply malformed input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => parseKbConfig({ pinned: [{ deep: [[[]]] }], initiative: { facts: 5 }, links: 9 })).not.toThrow()
    warn.mockRestore()
  })
})
