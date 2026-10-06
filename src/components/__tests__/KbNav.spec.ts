import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import KbNav from '../KbNav.vue'
import { shortlist } from '@/lib/compare'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'

let router: Router

async function mountNav(path = '/kb') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  await router.push(path)
  await router.isReady()
  return mount(KbNav, { global: { plugins: [router] } })
}

function labels(w: ReturnType<typeof mount>): string[] {
  return w.findAll('[data-testid="kb-nav"] a').map(a => a.text().trim())
}

/** The label of whichever item is marked current, or '' when none is. */
function current(w: ReturnType<typeof mount>): string {
  const link = w.findAll('[data-testid="kb-nav"] a').find(a => a.attributes('aria-current') === 'page')
  return link ? link.text().trim() : ''
}

beforeEach(() => {
  shortlist.value = []
})

afterEach(() => {
  shortlist.value = []
  document.body.innerHTML = ''
})

describe('KbNav — the library strip (P6-13, was P6-5)', () => {
  it('carries both axes: what the library holds, then what you do with it', async () => {
    // P6-13: Search, Chat and New came down out of the sitewide header, where
    // they read as site-level destinations beside Map and About. The eight-item
    // strip before them is still gone: Overview is Library, Ask is Chat, Check
    // a place and Compare are tool cards on Analysis, Pages and Map layers are
    // filters inside Docs and Datasets, Ideas is a chip.
    const w = await mountNav('/datasets')
    expect(labels(w)).toEqual(['Datasets', 'Docs', 'Analysis', 'Search', 'Chat', 'New'])
    expect(w.findAll('[data-testid="kb-nav"] a').map(a => a.attributes('href'))).toEqual([
      '/datasets',
      '/docs',
      '/analysis',
      '/search',
      '/chat',
      '/new',
    ])
    expect(current(w)).toBe('Datasets')
    w.unmount()
  })

  it('separates the nouns from the verbs, without announcing the seam', async () => {
    const w = await mountNav('/datasets')
    const divider = w.get('[data-testid="kb-nav-divider"]')
    expect(divider.attributes('aria-hidden')).toBe('true')
    expect(divider.text()).toBe('')
    w.unmount()
  })

  it('marks the function you are using, so standing on one says you are inside the library', async () => {
    for (const [path, item] of [
      ['/search?q=x', 'Search'],
      ['/chat', 'Chat'],
      ['/new', 'New'],
    ] as const) {
      const w = await mountNav(path)
      expect(current(w), path).toBe(item)
      w.unmount()
    }
  })

  it('marks the tab you are under, including the pages the cutover folded in', async () => {
    for (const [path, tab] of [
      ['/datasets?group=topic', 'Datasets'],
      ['/layers/pct_Black', 'Datasets'],
      ['/docs?purpose=ideas', 'Docs'],
      ['/wiki/home', 'Docs'],
      ['/analysis', 'Analysis'],
      ['/place?address=55+Trinity+Ave+SW', 'Analysis'],
      ['/compare', 'Analysis'],
      ['/views/georgia-shortlist', 'Analysis'],
    ] as const) {
      const w = await mountNav(path)
      expect(current(w), path).toBe(tab)
      w.unmount()
    }
  })

  it('marks nothing on the landing or on an entry that could be either', async () => {
    // `/library/:slug` is a dataset OR a document, so lighting a tab would be
    // a guess; the landing is above the strip rather than one of its items.
    for (const path of ['/kb', '/library/organizations']) {
      const w = await mountNav(path)
      expect(current(w), path).toBe('')
      w.unmount()
    }
  })

  it('carries the shortlist badge on Analysis, where Compare now lives', async () => {
    shortlist.value = ['01001', '01003', '13001']
    const w = await mountNav()
    const badge = w.get('[data-testid="shortlist-badge"]')
    expect(badge.text()).toBe('3')
    // On the Analysis tab, and on no other item — the three verbs carry none.
    const texts = w.findAll('[data-testid="kb-nav"] a').map(a => a.text())
    expect(texts[2]).toContain('3')
    expect(texts.filter(t => t.includes('3'))).toHaveLength(1)
    w.unmount()
  })

  it('shows no badge when nothing is waiting', async () => {
    const w = await mountNav()
    expect(w.find('[data-testid="shortlist-badge"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('KbNav on a phone (P5-60)', () => {
  // jsdom computes no layout, so the class IS the mobile variant here: `.strip`
  // is what turns the tabs from a wrapping row into one that scrolls.
  it('is a horizontal scroll strip rather than a wrapping row', async () => {
    const w = await mountNav()
    expect(w.get('[data-testid="kb-nav"]').classes()).toContain('strip')
    w.unmount()
  })

  it('scrolls sideways instead of widening the page at 375 px', async () => {
    const phone = mediaBlock(readStyles('src/components/KbNav.vue'), 640)
    const nav = ruleFor(phone, '.kb-nav')
    expect(nav).toContain('flex-wrap: nowrap')
    expect(nav).toContain('overflow-x: auto')
    expect(ruleFor(phone, '.kb-nav-link')).toContain('white-space: nowrap')
  })

  it('keeps the divider from collapsing while the six items scroll', async () => {
    const phone = mediaBlock(readStyles('src/components/KbNav.vue'), 640)
    expect(ruleFor(phone, '.kb-nav-divider')).toContain('flex: 0 0 auto')
  })
})

describe('KbNav icons (P6-30, from the handdrawn mockup)', () => {
  it('gives every item its own glyph, in the mockup’s order', async () => {
    const w = await mountNav('/datasets')
    expect(w.findAll('[data-testid="kb-nav"] a svg').map(s => s.attributes('data-icon'))).toEqual([
      'datasets',
      'docs',
      'analysis',
      'search',
      'chat',
      'new',
    ])
    w.unmount()
  })

  it('draws the glyphs decoratively — the word is what gets announced', async () => {
    const w = await mountNav('/datasets')
    for (const svg of w.findAll('[data-testid="kb-nav"] a svg')) {
      expect(svg.attributes('aria-hidden')).toBe('true')
      expect(svg.attributes('focusable')).toBe('false')
      expect(svg.find('title').exists(), 'a titled glyph would be read out twice').toBe(false)
    }
    w.unmount()
  })

  it('leaves the labels exactly as they were — an icon is not a rename', async () => {
    const w = await mountNav('/datasets')
    expect(labels(w)).toEqual(['Datasets', 'Docs', 'Analysis', 'Search', 'Chat', 'New'])
    w.unmount()
  })

  it('takes its colour from the item, so an active tab lights word and glyph together', async () => {
    const w = await mountNav('/datasets')
    expect(w.get('[data-icon="datasets"]').attributes('stroke')).toBe('currentColor')
    w.unmount()
  })

  it('lifts the glyph out of its resting state only when the item is active or hovered', () => {
    // One rule, two selectors — `ruleFor` reads a single selector, so this
    // asserts on the sheet itself.
    const css = readStyles('src/components/KbNav.vue').replace(/\s+/g, ' ')
    expect(css).toContain('.kb-nav-link.active :deep(.kb-icon), .kb-nav-link:hover :deep(.kb-icon) { opacity: 1; }')
  })

  it('rests the glyph quieter than its word', () => {
    const css = readStyles('src/components/KbNavIcon.vue').replace(/\s+/g, ' ')
    expect(css).toMatch(/\.kb-icon \{[^}]*opacity: 0\.75/)
  })
})

describe('the strip cannot widen the page it sits on (P6-30)', () => {
  // jsdom computes no layout, so the rule IS the behaviour here. Measured in a
  // real browser at 390px before the fix: `/search` put the document at 566px
  // inside a 390px viewport and cut every page to its right; after, all nine
  // KbNav routes measure 390 and the strip is what scrolls.
  const phone = () => mediaBlock(readStyles('src/components/InternalMobileStyles.vue'), 640)

  it('contributes nothing to an ancestor’s intrinsic width, and still fills the width it is given', () => {
    const strip = ruleFor(phone(), '.strip')
    // `min-width: 0` alone only lets the STRIP shrink — a flex-item ancestor
    // whose own min-width is still `auto` keeps sizing to the strip's content.
    expect(strip).toContain('width: 0')
    expect(strip).toContain('min-width: 100%')
    expect(strip).toContain('max-width: 100%')
  })

  it('still scrolls its own overflow rather than wrapping', () => {
    expect(ruleFor(phone(), '.strip')).toContain('overflow-x: auto')
    expect(ruleFor(mediaBlock(readStyles('src/components/KbNav.vue'), 640), '.kb-nav')).toContain('flex-wrap: nowrap')
  })

  it('keeps the six items from shrinking into each other while it scrolls', () => {
    expect(ruleFor(phone(), '.strip > *')).toContain('flex: 0 0 auto')
  })
})
