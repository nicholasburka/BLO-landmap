import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import { ref } from 'vue'

// The map is the one thing in App.vue that cannot run here (mapbox-gl needs a
// real canvas), and this file is about the header, not the map.
vi.mock('@/components/Map.vue', () => ({ default: { name: 'MapStub', template: '<div class="map-stub" />' } }))

const userRef = ref<{ username: string; role: 'admin' | 'internal' } | null>(null)
const logoutInternal = vi.fn(async () => {
  userRef.value = null
})
// `registerLogoutHook` is a module-level side effect of lib/compare (which the
// Menu sheet reads the shortlist badge from), so the mock has to offer it.
vi.mock('@/composables/useAuth', () => ({
  useAuth: () => ({ internalUser: userRef, logoutInternal }),
  registerLogoutHook: () => {},
}))

import App from '../App.vue'
import { FIRST_RUN_KEY, loadFirstRun, firstRunState } from '@/lib/firstRun'
import { helpDrawerOpen, closeHelpDrawer } from '@/lib/helpRecipes'
import { resetBodyScrollLock } from '@/lib/scrollLock'
import { shortlist } from '@/lib/compare'
import { readStyles, mediaBlock, ruleFor } from '@/testing/sfcStyles'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const stub = { template: '<div />' }

/**
 * P5-60 baseline. Captured from the header as it stood BEFORE the mobile pass,
 * at a 375 px viewport, logged out. The public map must stay pixel-identical
 * for logged-out visitors, so this string is the contract: any change to the
 * public header's tags, classes, attributes or text breaks this test.
 *
 * The three `<!--v-if-->` placeholders are Vue's markers for the internal-only
 * nodes a visitor never gets: the four internal links (ONE marker, because
 * they share a `<template v-if>`), Search, and the header tools. Their count
 * is part of the contract too — that is why the help drawer and the phone
 * Menu share ONE component, and why P6-5 wrapped four links in one template
 * rather than giving each its own `v-if`.
 */
const LOGGED_OUT_HEADER_AT_375 =
  '<header><nav>' +
  '<a href="https://blacklandownership.com" target="_blank" rel="noopener noreferrer" class="logo-link">' +
  '<img src="/BLO-FAVICON.png" alt="BLO Logo" class="logo"></a>' +
  '<h1 class="site-title">U.S. Livability Index</h1>' +
  '<a aria-current="page" href="/" class="router-link-active router-link-exact-active">Map</a>' +
  '<a href="/about" class="">About</a>' +
  '<!--v-if--><!--v-if--><!--v-if-->' +
  '<a href="/login" class="internal-entry">Log in</a>' +
  '</nav></header>'

/** jsdom has no matchMedia; the components that branch on width need one. */
function setViewportWidth(width: number): void {
  window.matchMedia = ((query: string) => {
    // Only `(max-width: N)` queries are used here — enough for these tests.
    const max = /max-width:\s*(\d+)px/.exec(query)
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }
  }) as unknown as typeof window.matchMedia
}

let router: Router

async function mountApp(path = '/') {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: stub },
      { path: '/kb', component: stub },
      { path: '/search', component: stub },
      { path: '/chat', component: stub },
      { path: '/new', component: stub },
      { path: '/datasets', component: stub },
      { path: '/docs', component: stub },
      { path: '/analysis', component: stub },
      { path: '/place', component: stub },
      { path: '/library/:slug', component: stub },
      { path: '/wiki/:slug', component: stub },
      { path: '/:pathMatch(.*)*', component: stub },
    ],
  })
  await router.push(path)
  await router.isReady()
  const w = mount(App, { global: { plugins: [router] }, attachTo: document.body })
  // HelpDrawer is an async component (kept out of the public entry chunk):
  // let its dynamic import settle before asserting on the header.
  await flushPromises()
  for (let i = 0; i < 40 && !w.find('[data-testid="help-trigger"]').exists() && !w.find('[data-testid="search-trigger"]').exists(); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await flushPromises()
  }
  // The header button belongs to the async drawer; give its import a beat
  // even when Search (sync) is already there.
  for (let i = 0; i < 40 && w.find('[data-testid="search-trigger"]').exists() && !w.find('[data-testid="help-trigger"]').exists(); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await flushPromises()
  }
  return w
}

beforeEach(() => {
  localStorage.clear()
  loadFirstRun()
  closeHelpDrawer()
  resetBodyScrollLock()
  shortlist.value = []
  userRef.value = null
  setViewportWidth(375)
})

afterEach(() => {
  localStorage.clear()
  loadFirstRun()
  closeHelpDrawer()
  resetBodyScrollLock()
  shortlist.value = []
  document.body.innerHTML = ''
})

describe('App header (P5-43 help + first run)', () => {
  it('shows a logged-out visitor no Help button at all', async () => {
    const w = await mountApp()
    expect(w.find('[data-testid="help-trigger"]').exists()).toBe(false)
    expect(w.find('[data-testid="search-trigger"]').exists()).toBe(false)
    // The public header is unchanged: the login link is still the only
    // difference from a plain map.
    expect(w.findAll('nav a').map(a => a.text())).toEqual(['', 'Map', 'About', 'Log in'])
    w.unmount()
  })

  it('gives an internal user a Help button beside Search, which opens the drawer', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()

    const buttons = w.findAll('nav button').map(b => b.attributes('data-testid'))
    expect(buttons).toEqual(['search-trigger', 'help-trigger', 'nav-menu-trigger'])

    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(false)
    await w.get('[data-testid="help-trigger"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="help-drawer"]').exists()).toBe(true)
    expect(helpDrawerOpen.value).toBe(true)
    w.unmount()
  })

  it('records first-run progress from the pages an internal user visits', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()

    await router.push('/datasets')
    expect(firstRunState.value.done).toEqual([])

    await router.push('/search?q=who%20owns%20this%20land')
    await router.push('/chat')
    await flushPromises()

    expect(firstRunState.value.done).toEqual(['search', 'ask'])
    expect(JSON.parse(localStorage.getItem(FIRST_RUN_KEY)!).done).toEqual(['search', 'ask'])
    w.unmount()
  })

  it('no longer ticks the action steps off a mere visit (P5-71)', async () => {
    // Opening a table is not filtering it and opening the drop page is not
    // dropping — the surfaces report those themselves now.
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()

    await router.push('/library/organizations?tab=data')
    await router.push('/new')
    await router.push('/library/plan?tab=files&view=plan.pdf')
    await router.push('/docs')
    await flushPromises()

    expect(firstRunState.value.done).toEqual([])
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull()
    w.unmount()
  })

  it('records nothing for a logged-out visitor', async () => {
    const w = await mountApp()
    await router.push('/search?q=anything')
    await flushPromises()
    expect(firstRunState.value.done).toEqual([])
    expect(localStorage.getItem(FIRST_RUN_KEY)).toBeNull()
    w.unmount()
  })
})

describe('App header (P6-5 the cutover)', () => {
  const linkTexts = (w: Awaited<ReturnType<typeof mountApp>>) => w.findAll('nav a').map(a => a.text())
  const linkHrefs = (w: Awaited<ReturnType<typeof mountApp>>) => w.findAll('nav a').map(a => a.attributes('href'))

  it('shows an internal user only what is sitewide: Map, About, Library', async () => {
    // P6-13: Search, Chat and New left this header for the library's own strip
    // (KbNav). They are the library's top level, not the site's — beside Map
    // and About they claimed to be site-level destinations, and standing on
    // one, nothing in the chrome said you were inside the library at all.
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp('/kb')
    expect(linkTexts(w)).toEqual(['', 'Map', 'About', 'Library', 'phd'])
    expect(linkHrefs(w)).toEqual(['https://blacklandownership.com', '/', '/about', '/kb', '/account'])
    w.unmount()
  })

  it('does not offer the three functions from the sitewide header any more', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp('/kb')
    expect(linkHrefs(w)).not.toContain('/search')
    expect(linkHrefs(w)).not.toContain('/chat')
    expect(linkHrefs(w)).not.toContain('/new')
    w.unmount()
  })

  it('has dropped every item of the old strip from the header', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp('/kb')
    const hrefs = linkHrefs(w)
    for (const gone of ['/ask', '/place', '/compare', '/library', '/wiki', '/layers']) {
      expect(hrefs, gone).not.toContain(gone)
    }
    // "Knowledge base" is "Library" now, and it is the landing.
    expect(linkTexts(w)).not.toContain('Knowledge base')
    w.unmount()
  })

  it('keeps Library lit everywhere inside the library — the three functions included', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp('/kb')
    const library = () => w.findAll('nav a').find(a => a.text() === 'Library')!

    // P6-13: `/search`, `/chat` and `/new` joined this list. They were treated
    // as NOT the library, which is the plane confusion written down in code —
    // the header's one lit item went out exactly while you were using the
    // library. Which of the three you are on is marked by KbNav, below.
    for (const path of [
      '/kb',
      '/datasets',
      '/docs',
      '/analysis',
      '/library/organizations',
      '/wiki/home',
      '/place',
      '/search',
      '/chat',
      '/new',
    ]) {
      await router.push(path)
      await flushPromises()
      expect(library().classes(), path).toContain('router-link-exact-active')
    }

    // `/account` is the person's own page, not the library's.
    await router.push('/account')
    await flushPromises()
    expect(library().classes()).not.toContain('router-link-exact-active')
    w.unmount()
  })

  it('gives a logged-out visitor none of them', async () => {
    const w = await mountApp('/')
    expect(linkTexts(w)).toEqual(['', 'Map', 'About', 'Log in'])
    w.unmount()
  })
})

describe('App header (P5-65 one name per thing)', () => {
  /** The `<h1>` in the header, whatever it currently says. */
  const title = (w: Awaited<ReturnType<typeof mountApp>>) => w.get('.site-title').text()

  it('says "BLO Knowledge base" on every internal surface the cutover left', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp('/kb')
    for (const path of [
      '/kb',
      '/search',
      '/chat',
      '/new',
      '/datasets',
      '/docs',
      '/analysis',
      '/place',
      '/compare',
      '/library/organizations',
      '/wiki/georgia',
      '/layers/pct_Black',
      '/views/south',
      '/account',
    ]) {
      await router.push(path)
      await flushPromises()
      expect(title(w), path).toBe('BLO Knowledge base')
    }
    w.unmount()
  })

  it('keeps the public name on the map and About, even when logged in', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp('/')
    expect(title(w)).toBe('U.S. Livability Index')
    await router.push('/about')
    await flushPromises()
    expect(title(w)).toBe('U.S. Livability Index')
    w.unmount()
  })

  it('never renames the header for a logged-out visitor on an internal path', async () => {
    // The guard is `internalUser`, not the path: a visitor who types /chat is
    // bounced to the login page and must never see the internal name flash.
    const w = await mountApp('/chat')
    expect(title(w)).toBe('U.S. Livability Index')
    w.unmount()
  })
})

describe('App header (P5-60 mobile pass)', () => {
  it('leaves the logged-out header byte-for-byte unchanged at 375 px', async () => {
    const w = await mountApp()
    expect(w.get('header').element.outerHTML).toBe(LOGGED_OUT_HEADER_AT_375)
    // Belt and braces: none of the internal-only hooks may appear either.
    expect(w.get('nav').attributes('data-internal-nav')).toBeUndefined()
    expect(w.find('[data-testid="nav-menu-trigger"]').exists()).toBe(false)
    expect(w.findComponent({ name: 'InternalMobileStyles' }).exists()).toBe(false)
    w.unmount()
  })

  it('marks the nav as internal so the collapsed-header rules can apply', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()
    expect(w.get('nav').attributes('data-internal-nav')).toBe('')
    // The three 44 px icon buttons, in the order they read on screen.
    expect(w.findAll('nav button').map(b => b.attributes('data-testid'))).toEqual([
      'search-trigger',
      'help-trigger',
      'nav-menu-trigger',
    ])
    expect(w.get('[data-testid="nav-menu-trigger"]').classes()).toContain('touch-target')
    w.unmount()
  })

  it('opens the Menu sheet with every link the collapsed header hides', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()

    expect(w.find('[data-testid="nav-menu-sheet"]').exists()).toBe(false)
    await w.get('[data-testid="nav-menu-trigger"]').trigger('click')

    const sheet = w.get('[data-testid="nav-menu-sheet"]')
    expect(sheet.attributes('role')).toBe('dialog')
    expect(sheet.attributes('aria-modal')).toBe('true')
    expect(sheet.classes()).toContain('sheet')
    expect(w.get('[data-testid="nav-menu-backdrop"]').classes()).toContain('sheet-backdrop')

    // P6-5: the same four internal items the wide header shows, plus the two
    // public links the collapsed header hides, plus Account.
    expect(w.findAll('[data-testid="nav-menu-link"]').map(a => a.text().replace(/\s+/g, ' ').trim())).toEqual([
      'Map',
      'About',
      'Library',
      'Search',
      'Chat',
      'New',
      'Accountphd',
    ])
    expect(w.findAll('[data-testid="nav-menu-link"]').map(a => a.attributes('href'))).toEqual([
      '/',
      '/about',
      '/kb',
      '/search',
      '/chat',
      '/new',
      '/account',
    ])
    // The collapsed header no longer shows who is signed in; the menu does.
    expect(w.get('[data-testid="nav-menu-note"]').text()).toBe('phd')
    expect(w.find('[data-testid="nav-menu-logout"]').exists()).toBe(true)
    expect(w.find('[data-testid="nav-menu-close"]').exists()).toBe(true)
    w.unmount()
  })

  it('locks the page behind the Menu sheet and unlocks it on close', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()

    await w.get('[data-testid="nav-menu-trigger"]').trigger('click')
    await flushPromises()
    expect(document.body.style.overflow).toBe('hidden')

    await w.get('[data-testid="nav-menu-backdrop"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="nav-menu-sheet"]').exists()).toBe(false)
    expect(document.body.style.overflow).toBe('')
    w.unmount()
  })

  it('closes the Menu sheet on Escape', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()

    await w.get('[data-testid="nav-menu-trigger"]').trigger('click')
    expect(w.find('[data-testid="nav-menu-sheet"]').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.find('[data-testid="nav-menu-sheet"]').exists()).toBe(false)
    expect(document.body.style.overflow).toBe('')
    w.unmount()
  })

  it('traps Tab inside the Menu sheet', async () => {
    userRef.value = { username: 'phd', role: 'internal' }
    const w = await mountApp()
    await w.get('[data-testid="nav-menu-trigger"]').trigger('click')
    await flushPromises()

    const focusable = w.get('[data-testid="nav-menu-sheet"]').element.querySelectorAll<HTMLElement>('a[href], button')
    const last = focusable[focusable.length - 1]
    last.focus()
    await w.get('[data-testid="nav-menu-sheet"]').trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(focusable[0])
    w.unmount()
  })
})

describe('the shared phone classes (P5-60)', () => {
  const SHARED = mediaBlock(readStyles('src/components/InternalMobileStyles.vue'), 640)

  it('promises that a .strip scrolls its content instead of widening the page', () => {
    // The single root cause of both overflowing routes: a strip that scrolls
    // but whose unwrapped content width is still its intrinsic minimum, which
    // climbs the ancestor chain until the page itself grows.
    //
    // P6-30 strengthened this. `min-width: 0` lets the STRIP shrink, and that
    // was enough while every ancestor was a block — but a flex-item ancestor
    // keeps its own `min-width: auto` and so refuses to go narrower than the
    // strip's min-content. `/search` was the case: `.search-panel` sized to
    // the strip's 543px and pushed the document to 566px in a 390px viewport.
    // `width: 0` is what stops the strip contributing to any ancestor's
    // intrinsic width at all; `min-width: 100%` paints it back out to the
    // width it is given, which also supersedes the old `min-width: 0`.
    const strip = ruleFor(SHARED, '.strip')
    expect(strip).toContain('width: 0')
    expect(strip).toContain('min-width: 100%')
    expect(strip).toContain('max-width: 100%')
    expect(strip).toContain('overflow-x: auto')
    expect(ruleFor(SHARED, '.strip > *')).toContain('flex: 0 0 auto')
  })

  it('keeps a .stack from widening the page either', () => {
    expect(ruleFor(SHARED, '.stack')).toContain('min-width: 0')
  })
})

describe('the route slot (P5-86)', () => {
  /** A route whose chunk we resolve by hand, so the window between "navigation
   *  started" and "chunk arrived" can be inspected. */
  function pendingRoute() {
    let resolve!: (component: unknown) => void
    const chunk = new Promise(r => {
      resolve = r
    })
    return { component: () => chunk, resolve }
  }

  it('renders no map while a route chunk is still loading, nor after it lands', async () => {
    const kb = pendingRoute()
    const r = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: stub },
        { path: '/kb', component: kb.component },
        { path: '/:pathMatch(.*)*', component: stub },
      ],
    })
    const w = mount(App, { global: { plugins: [r] }, attachTo: document.body })
    const navigation = r.push('/kb')
    await flushPromises()

    // The chunk is still in flight: the shell shows the header and nothing else.
    expect(w.find('.map-stub').exists()).toBe(false)
    expect(w.get('main').element.children.length).toBe(0)

    kb.resolve({ template: '<div class="kb-stub" />' })
    await navigation
    await flushPromises()

    expect(w.find('.map-stub').exists()).toBe(false)
    expect(w.find('.kb-stub').exists()).toBe(true)
    w.unmount()
  })

  it('renders no map on the login page while its chunk loads', async () => {
    const login = pendingRoute()
    const r = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: stub },
        { path: '/login', component: login.component },
        { path: '/:pathMatch(.*)*', component: stub },
      ],
    })
    const w = mount(App, { global: { plugins: [r] }, attachTo: document.body })
    void r.push('/login')
    await flushPromises()
    expect(w.find('.map-stub').exists()).toBe(false)
    w.unmount()
  })

  it('still mounts the map on / — HomeView renders it, the shell does not', async () => {
    const HomeView = (await import('@/views/HomeView.vue')).default
    const r = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: HomeView },
        { path: '/:pathMatch(.*)*', component: stub },
      ],
    })
    await r.push('/')
    await r.isReady()
    const w = mount(App, { global: { plugins: [r] }, attachTo: document.body })
    await flushPromises()
    expect(w.find('.map-stub').exists()).toBe(true)
    w.unmount()
  })
})

describe('self-hosted fonts (P5-91)', () => {
  // Vitest's root is the repo root (vitest.config.ts), so cwd is too.
  const repoFile = (path: string) => resolve(process.cwd(), path)
  const read = (path: string) => readFileSync(repoFile(path), 'utf-8')

  it('declares Fraunces from a local woff2 with font-display: swap', () => {
    const css = read('src/assets/base.css')
    const face = /@font-face\s*{[^}]*}/.exec(css)?.[0] ?? ''
    expect(face).toContain("font-family: 'Fraunces'")
    expect(face).toContain('font-display: swap')
    expect(face).toContain('font-weight: 400 700')
    expect(face).toContain("url('./fonts/fraunces-variable.woff2') format('woff2')")
  })

  it('ships a real woff2 for it', () => {
    const font = readFileSync(repoFile('src/assets/fonts/fraunces-variable.woff2'))
    // wOF2 — the woff2 magic number. A 404 page or a woff1 would not have it.
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(font.byteLength).toBeGreaterThan(10_000)
  })

  it('preloads that exact file from index.html and asks Google for nothing', () => {
    const html = read('index.html')
    expect(html).toContain(
      '<link rel="preload" as="font" type="font/woff2" crossorigin href="/src/assets/fonts/fraunces-variable.woff2">',
    )
    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('fonts.gstatic.com')
  })
})
