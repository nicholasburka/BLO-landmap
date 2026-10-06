import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { HELP_RECIPES, RECIPE_TAGS, searchRecipes, groupRecipes, helpDrawerOpen, openHelpDrawer, closeHelpDrawer } from '../helpRecipes'
import { firstRunSteps } from '../firstRun'

/**
 * The router cannot be imported here: `src/router/index.ts` pulls in HomeView
 * → Map.vue → mapbox-gl, which does not survive jsdom. Reading its source and
 * pulling the route paths out keeps this check honest anyway — a route
 * renamed in the router fails this test, which a hand-written list would not.
 */
const routerFile = resolve(process.cwd(), 'src/router/index.ts')
if (!existsSync(routerFile)) throw new Error(`helpRecipes.spec: cannot find ${routerFile} — run vitest from the client root`)
const routerSource = readFileSync(routerFile, 'utf8')
const ROUTE_PATHS = [...routerSource.matchAll(/^\s*path: '([^']+)'/gm)].map(m => m[1])

function isRoute(href: string): boolean {
  const path = href.split('?')[0].split('#')[0]
  return ROUTE_PATHS.some(route => {
    const pattern = new RegExp(`^${route.replace(/:[^/]+/g, '[^/]+')}$`)
    return pattern.test(path)
  })
}

describe('helpRecipes (P5-43)', () => {
  it('reads the real route table', () => {
    // Guards the guard: a regex that silently matched nothing would make
    // every href "valid".
    expect(ROUTE_PATHS).toContain('/library/:slug')
    expect(ROUTE_PATHS.length).toBeGreaterThan(8)
    expect(isRoute('/library/organizations?tab=data')).toBe(true)
    expect(isRoute('/nope')).toBe(false)
  })

  it('gives every recipe the shape the drawer renders', () => {
    expect(HELP_RECIPES.length).toBeGreaterThan(0)
    for (const r of HELP_RECIPES) {
      expect(r.id).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(r.title.length).toBeGreaterThan(0)
      expect(RECIPE_TAGS).toContain(r.tag)
      expect(r.steps.length).toBeGreaterThan(1)
      for (const step of r.steps) {
        // One plain sentence: no line breaks, ends in a full stop, and short
        // enough to read in one go.
        expect(step).not.toMatch(/\n/)
        expect(step.endsWith('.')).toBe(true)
        expect(step.length).toBeLessThan(220)
      }
    }
  })

  it('has unique ids and fills every shelf', () => {
    const ids = HELP_RECIPES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tag of RECIPE_TAGS) {
      expect(HELP_RECIPES.filter(r => r.tag === tag).length).toBeGreaterThan(0)
    }
  })

  it('links every recipe at a page that exists', () => {
    for (const r of HELP_RECIPES) {
      expect(isRoute(r.href), `${r.id} → ${r.href}`).toBe(true)
    }
  })

  it('links every first-run step at a page that exists', () => {
    for (const step of firstRunSteps()) {
      expect(isRoute(step.href), `${step.id} → ${step.href}`).toBe(true)
    }
  })

  it('sends nobody to a page the cutover retired (P6-5)', () => {
    // These paths still EXIST as routes — they redirect — so `isRoute` would
    // happily pass them. The manual has to name the page a reader will
    // actually land on.
    const retired = ['/library', '/wiki', '/layers', '/ask']
    for (const r of [...HELP_RECIPES, ...firstRunSteps()]) {
      const path = r.href.split('?')[0]
      expect(retired, `${r.id ?? ''} → ${r.href}`).not.toContain(path)
    }
  })

  it('covers the questions a new researcher actually asks', () => {
    const ids = HELP_RECIPES.map(r => r.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'search-everything',
        'ask-question',
        'open-table',
        'filter-sort',
        'summaries',
        'download-csv',
        'save-view',
        'drop-link',
        'upload-files',
        'write-page',
        'open-document',
        // P5-58: the question people arrive with.
        'check-a-place',
        // P6-5: one per new surface — the two browsers, and what Chat can do
        // that Ask could not.
        'browse-datasets',
        'browse-docs',
        'chat-writes',
      ]),
    )
  })

  it('has a recipe for each of the four header items and each resource tab (P6-5)', () => {
    const hrefs = new Set(HELP_RECIPES.map(r => r.href.split('?')[0]))
    for (const path of ['/search', '/chat', '/new', '/datasets', '/docs', '/analysis']) {
      expect([...hrefs], path).toContain(path)
    }
  })

  it('sends the place recipe at Analysis, where the tool card now lives, with the buttons the page shows', () => {
    const recipe = HELP_RECIPES.find(r => r.id === 'check-a-place')!
    expect(recipe.title).toBe('Check a property or county for risks')
    expect(recipe.href).toBe('/analysis')
    expect(isRoute(recipe.href)).toBe(true)
    const steps = recipe.steps.join(' ')
    for (const label of ['Check a place', 'Place report', 'Run', 'Open the full slice', 'About this source', 'Save as note', 'Add to page', 'Download CSV', 'Run again']) {
      expect(steps, label).toContain(label)
    }
  })

  it('calls every surface what the app calls it (P5-65, P6-5)', () => {
    // A recipe that names a button the app no longer has is worse than no
    // recipe: the reader goes looking for it.
    const everything = HELP_RECIPES.flatMap(r => [r.title, ...r.steps]).join(' ')
    expect(everything).not.toContain('Data & documents')
    expect(everything).not.toContain('data and documents')
    expect(everything).not.toContain('"Sources"')
    // The strip these named is gone: Ask is Chat, Pages and Map layers are
    // filters, Library is the landing.
    expect(everything).not.toContain('"Ask"')
    expect(everything).not.toContain('"Pages"')
    expect(everything).not.toContain('"Map layers" in the row of links')
    expect(everything).not.toContain('knowledge-base home')

    // The new words, in the recipes that describe each surface.
    expect(HELP_RECIPES.find(r => r.id === 'browse-datasets')!.steps[0]).toContain('"Datasets"')
    expect(HELP_RECIPES.find(r => r.id === 'browse-docs')!.steps[0]).toContain('"Docs"')
    expect(HELP_RECIPES.find(r => r.id === 'search-everything')!.steps[0]).toContain('"Search" in the top bar')
    expect(HELP_RECIPES.find(r => r.id === 'ask-question')!.steps[0]).toContain('"Chat" in the top bar')
    expect(HELP_RECIPES.find(r => r.id === 'drop-link')!.steps[0]).toContain('"New" in the top bar')
    expect(HELP_RECIPES.find(r => r.id === 'ask-question')!.steps.join(' ')).toContain('"Where this came from"')
  })

  it('searches titles, steps and shelves, case-insensitively', () => {
    expect(searchRecipes('')).toHaveLength(HELP_RECIPES.length)
    expect(searchRecipes('   ')).toHaveLength(HELP_RECIPES.length)

    // Title match.
    expect(searchRecipes('save a map view').map(r => r.id)).toEqual(['save-view'])
    // Step match: "Download filtered CSV" is only ever written in a step.
    expect(searchRecipes('DOWNLOAD FILTERED CSV').map(r => r.id)).toContain('download-csv')
    // Shelf match.
    expect(searchRecipes('Look at data').every(r => r.tag === 'Look at data')).toBe(true)

    expect(searchRecipes('quantum tunnelling')).toEqual([])
  })

  it('groups recipes onto shelves in a fixed order, dropping empty ones', () => {
    expect(groupRecipes(HELP_RECIPES).map(g => g.tag)).toEqual([...RECIPE_TAGS])
    const oneShelf = groupRecipes(HELP_RECIPES.filter(r => r.tag === 'Maps'))
    expect(oneShelf).toHaveLength(1)
    expect(oneShelf[0].tag).toBe('Maps')
  })

  it('shares one open/closed flag so the header and the landing drive the same drawer', () => {
    closeHelpDrawer()
    expect(helpDrawerOpen.value).toBe(false)
    openHelpDrawer()
    expect(helpDrawerOpen.value).toBe(true)
    closeHelpDrawer()
    expect(helpDrawerOpen.value).toBe(false)
  })
})
