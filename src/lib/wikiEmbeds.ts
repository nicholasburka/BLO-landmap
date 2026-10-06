/**
 * Wiki embed hydration (P5-17).
 *
 * renderWikiMarkdown turns fenced ```view:<slug>``` / ```entry:<slug>```
 * blocks into inert `<div data-embed data-embed-slug>` placeholders (the only
 * thing the sanitizer lets through). After the sanitized HTML lands in the
 * DOM, hydrateEmbeds() upgrades each placeholder into a live card:
 *
 * - view  → saved-view card: name, data-as-of date, top results, and an
 *           "Open in map →" link to /views/<slug> that restores the exact
 *           layers/query/viewport (P5-16).
 * - view  → (P5-54, `type: 'table'`) the saved table, re-run: the first
 *           EMBED_ROWS_SHOWN rows, or the saved chart, plus "Open in
 *           explorer →" and a note when the row count has moved since the
 *           view was saved. A table view is a recipe, so the card shows
 *           today's data, not what was on screen the day it was saved.
 * - view  → (P5-55, `type: 'compare'`) the saved comparison, re-read: the
 *           counties as rows, the layers as columns, the notes the
 *           researcher wrote, and "Open comparison →". A comparison is a
 *           recipe too, so the card shows today's numbers.
 * - entry → catalog card: title, kind/category/status, "Open in library →".
 * - map  → (P7-4) the same saved view, as a LIVE canvas instead of a summary:
 *          `WikiMapBlock` mounted into the placeholder, drawing the view's
 *          state (or, for a set-backed view, the set's layers in the view's
 *          framing). The component is reached by a **dynamic import inside this
 *          branch**, which is what makes the ticket's second acceptance
 *          criterion true by construction: a page with no `map:` block never
 *          evaluates that import, so mapbox-gl and the two county files (1.07
 *          MB gzipped) are never even requested.
 *
 * SECURITY: placeholders come from sanitized-but-user-authored markdown and
 * card data comes from the API, so everything here is built with
 * createElement/textContent — never innerHTML — and slugs are re-validated
 * before any fetch. A malformed placeholder degrades to a note, never throws.
 *
 * Fetches are cached per slug for the session so the editor's live preview
 * (which re-renders the DOM on every keystroke) doesn't hammer the API.
 */

import { createApp, type App } from 'vue'
import type { Router } from 'vue-router'
import { isSiteLayerId, siteLayerName } from '@/config/siteLayers'
import {
  compareStateOf,
  compareViewUrl,
  fetchView,
  tableStateOf,
  tableViewUrl,
  type SavedCompareViewState,
  type SavedTableViewState,
  type SavedView,
} from './views'
import {
  buildCompareRows,
  clearCompareLayerIndex,
  compareLayerIndex,
  loadCompareCounties,
  loadLayerColumn,
  type LayerColumn,
} from './compare'
import { fetchCatalogEntry, layerIdForEntry, linkOf, type CatalogEntry } from './libraryCatalog'
import {
  cellOf,
  fetchColumnSummary,
  fetchDatasetRows,
  hasTabularFile,
  type DatasetRow,
  type RowsState,
} from './libraryData'
import { buildChart } from './charts'
import { mapHrefForInternalLayerId } from './internalLayers'
import SummaryChart from '@/components/SummaryChart.vue'
import { registerLogoutHook } from '@/composables/useAuth'

/** Same shape as the server's slug rules (WIKI_SLUG / view slugs). */
export const EMBED_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/

/** Embed cards are a teaser, not a data table. */
export const EMBED_RESULTS_SHOWN = 5

/** A table-view card shows the head of the table, not the table (P5-54). */
export const EMBED_ROWS_SHOWN = 20
/** …and at most this many columns, so a 40-column file stays a card. */
export const EMBED_COLUMNS_SHOWN = 6

const viewCache = new Map<string, Promise<SavedView | null>>()
const entryCache = new Map<string, Promise<CatalogEntry | null>>()

/** Test seam + logout hook: forget everything fetched so far (and tear down
 *  any chart mounted inside a card — it holds fetched data too). */
export function clearEmbedCache(): void {
  viewCache.clear()
  entryCache.clear()
  clearCompareLayerIndex()
  unmountAllApps()
}
// Cards cache fetched entries; drop them the moment the session ends (P5-19).
registerLogoutHook(clearEmbedCache)

function cachedFetch<T>(
  cache: Map<string, Promise<T>>,
  slug: string,
  fetcher: (slug: string) => Promise<T>,
): Promise<T> {
  let promise = cache.get(slug)
  if (!promise) {
    promise = fetcher(slug)
    // Failures are not cached — the next hydration retries.
    promise.catch(() => cache.delete(slug))
    cache.set(slug, promise)
  }
  return promise
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function note(target: HTMLElement, text: string, state: 'missing' | 'error'): void {
  target.textContent = text
  target.dataset.embedState = state
  target.classList.add('wiki-embed-note')
}

function formatSavedAt(savedAt: string): string {
  const date = new Date(savedAt)
  if (Number.isNaN(date.getTime())) return savedAt
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function renderViewCard(target: HTMLElement, view: SavedView): void {
  target.textContent = ''
  target.dataset.embedState = 'loaded'
  target.classList.add('wiki-embed-card')

  target.appendChild(el('div', 'embed-title', view.name))
  target.appendChild(
    el('div', 'embed-meta', `Data as of ${formatSavedAt(view.savedAt)} · saved by ${view.savedBy}`),
  )

  const pointLayers = Array.isArray(view.state?.pointLayers)
    ? view.state.pointLayers.filter(p => p && typeof p.name === 'string' && p.name).map(p => p.name)
    : []
  if (pointLayers.length > 0) {
    target.appendChild(el('div', 'embed-meta', `Point layers: ${pointLayers.join(', ')}`))
  }
  // P5-78: the contamination site layers a map view had on, by name.
  const siteLayers = Array.isArray(view.state?.siteLayers)
    ? (view.state.siteLayers as unknown[]).filter(isSiteLayerId).map(siteLayerName)
    : []
  if (siteLayers.length > 0) {
    target.appendChild(el('div', 'embed-meta', `Site layers: ${siteLayers.join(', ')}`))
  }

  if (view.results.length > 0) {
    const list = el('ol', 'embed-results')
    for (const result of view.results.slice(0, EMBED_RESULTS_SHOWN)) {
      const item = document.createElement('li')
      item.textContent = `${result.name}, ${result.state} — ${result.score.toFixed(1)}`
      list.appendChild(item)
    }
    target.appendChild(list)
    if (view.results.length > EMBED_RESULTS_SHOWN) {
      target.appendChild(
        el('div', 'embed-more', `…and ${view.results.length - EMBED_RESULTS_SHOWN} more`),
      )
    }
  }

  const link = el('a', 'embed-link', 'Open in map →')
  link.setAttribute('href', `/views/${view.slug}`)
  target.appendChild(link)
}

// --- Saved table views (P5-54) ----------------------------------------------

/**
 * Vue apps mounted inside embed blocks — a table view's chart, and (P7-4) a map.
 *
 * A wiki page re-renders its whole `v-html` on every keystroke of the editor's
 * preview, so the apps whose nodes have left the document are unmounted before
 * each pass — otherwise a long editing session leaks one app per keystroke.
 *
 * P7-4 made that bookkeeping load-bearing rather than tidy. A chart that leaks
 * is some memory; a **map** that leaks is a WebGL context, and a browser keeps
 * only so many before it starts dropping the oldest — which would blank a map
 * higher up the page. `MapCanvas` calls `map.remove()` on unmount, so this
 * sweep is the thing that releases the context.
 */
const mountedApps: { app: App; node: HTMLElement; drawsMap: boolean }[] = []

function releaseDetachedApps(): void {
  for (let i = mountedApps.length - 1; i >= 0; i--) {
    if (!mountedApps[i].node.isConnected) {
      mountedApps[i].app.unmount()
      mountedApps.splice(i, 1)
    }
  }
}

/** Test seam: drop every mounted app (used by clearEmbedCache). */
function unmountAllApps(): void {
  for (const { app } of mountedApps.splice(0)) app.unmount()
}

/** How many live maps are on the page right now — the ones holding a WebGL
 *  context, so a stand-in block does not occupy a slot it is not using. */
function liveMapCount(): number {
  return mountedApps.filter(entry => entry.drawsMap && entry.node.isConnected).length
}

/** The saved state as the rows API wants it, capped to a card's worth. */
function rowsStateFor(state: SavedTableViewState, limit?: number): RowsState {
  return {
    ...(state.file ? { file: state.file } : {}),
    ...(state.q ? { q: state.q } : {}),
    ...(state.filters.length ? { filter: state.filters } : {}),
    ...(state.sort ? { sort: state.sort } : {}),
    ...(state.dir ? { dir: state.dir } : {}),
    ...(limit ? { limit } : {}),
  }
}

/** "13 rows" — or, when the count has moved, what it was and what it is. */
function rowCountNote(saved: number, now: number): string {
  const rows = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}`
  return saved === now ? rows(now) : `Saved with ${rows(saved)} · ${rows(now)} now`
}

function renderRowsTable(target: HTMLElement, columns: string[], rows: DatasetRow[]): void {
  const wrap = el('div', 'embed-table-scroll')
  const table = document.createElement('table')
  table.className = 'embed-table'
  const head = document.createElement('tr')
  for (const name of columns) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = name
    head.appendChild(th)
  }
  const thead = document.createElement('thead')
  thead.appendChild(head)
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    for (const name of columns) {
      const td = document.createElement('td')
      td.textContent = cellOf(row, name)
      tr.appendChild(td)
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  wrap.appendChild(table)
  target.appendChild(wrap)
}

/**
 * A saved table view, re-run now. Either the saved chart or the head of the
 * table — never both: the card is an illustration beside an argument, and
 * the "Open the table" link is there for anyone who wants the rest.
 */
async function renderTableViewCard(
  target: HTMLElement,
  view: SavedView,
  state: SavedTableViewState,
): Promise<void> {
  target.textContent = ''
  target.dataset.embedState = 'loaded'
  target.classList.add('wiki-embed-card')

  target.appendChild(el('div', 'embed-title', view.name))
  target.appendChild(
    el('div', 'embed-meta', `Saved ${formatSavedAt(view.savedAt)} · saved by ${view.savedBy}`),
  )
  if (view.description) target.appendChild(el('div', 'embed-meta', view.description))

  let now = state.savedRowCount
  if (state.summary) {
    // A group-by is the same counts with a bigger cap — one column, drawn as
    // bars; a saved chart names its own shape.
    const saved = state.summary
    const groupBy = 'groupBy' in saved
    const column = 'groupBy' in saved ? saved.groupBy : saved.column
    const summary = await fetchColumnSummary(state.dataset, rowsStateFor(state), column, { groupBy })
    now = summary.filled + summary.empty
    const chart = buildChart(summary, 'groupBy' in saved ? 'bars' : saved.chart, { matched: now })
    if (chart) {
      const host = el('div', 'embed-chart')
      target.appendChild(host)
      const app = createApp(SummaryChart, { spec: chart, fileName: `${state.dataset}-${column}` })
      app.mount(host)
      mountedApps.push({ app, node: host, drawsMap: false })
    }
  } else {
    const page = await fetchDatasetRows(state.dataset, rowsStateFor(state, EMBED_ROWS_SHOWN))
    now = page.total
    const columns = (state.columns ?? Object.keys(page.rows[0] ?? {}).filter(k => k !== '_row')).slice(
      0,
      EMBED_COLUMNS_SHOWN,
    )
    if (page.rows.length > 0 && columns.length > 0) {
      renderRowsTable(target, columns, page.rows)
      if (page.total > page.rows.length) {
        target.appendChild(el('div', 'embed-more', `…and ${(page.total - page.rows.length).toLocaleString()} more rows`))
      }
    } else {
      target.appendChild(el('div', 'embed-more', 'No rows match this view right now.'))
    }
  }

  target.appendChild(el('div', 'embed-meta', rowCountNote(state.savedRowCount, now)))

  const link = el('a', 'embed-link', 'Open the table →')
  // Carries the county-context layers (P5-48) through with everything else.
  link.setAttribute('href', tableViewUrl(state, view.slug))
  target.appendChild(link)
}

// --- Saved compare views (P5-55) --------------------------------------------

/**
 * A saved comparison, re-read now: the counties as rows, the layers as
 * columns, and whatever the researcher wrote about each county.
 *
 * Both caps are already applied by `compareStateOf` (12 × 12), so this is
 * the whole table rather than a teaser — a comparison with rows missing
 * would be misleading in a way a truncated list is not. Built with
 * createElement/textContent like every other card: county names, layer names
 * and notes are all user-authored text.
 */
async function renderCompareViewCard(
  target: HTMLElement,
  view: SavedView,
  state: SavedCompareViewState,
): Promise<void> {
  target.textContent = ''
  target.dataset.embedState = 'loaded'
  target.classList.add('wiki-embed-card')

  target.appendChild(el('div', 'embed-title', view.name))
  target.appendChild(
    el('div', 'embed-meta', `Saved ${formatSavedAt(view.savedAt)} · saved by ${view.savedBy}`),
  )
  if (view.description) target.appendChild(el('div', 'embed-meta', view.description))

  const index = await compareLayerIndex()
  const layers = state.layers.map(id => index.get(id)).filter(<T,>(l: T | undefined): l is T => !!l)
  const counties = await loadCompareCounties(state.counties)
  const columns: Record<string, LayerColumn> = {}
  await Promise.all(
    layers.map(async layer => {
      // One column that will not load is blank; the rest is still the point.
      columns[layer.id] = await loadLayerColumn(layer).catch(() => ({}))
    }),
  )
  const rows = buildCompareRows(counties, layers, columns)
  const notes = state.notes ?? {}
  const hasNotes = rows.some(row => (notes[row.geoId] ?? '').trim() !== '')

  if (rows.length > 0 && layers.length > 0) {
    const wrap = el('div', 'embed-table-scroll')
    const table = document.createElement('table')
    table.className = 'embed-table'

    const head = document.createElement('tr')
    for (const name of ['County', ...layers.map(l => l.name), ...(hasNotes ? ['Notes'] : [])]) {
      const th = document.createElement('th')
      th.scope = 'col'
      th.textContent = name
      head.appendChild(th)
    }
    const thead = document.createElement('thead')
    thead.appendChild(head)
    table.appendChild(thead)

    const tbody = document.createElement('tbody')
    for (const row of rows) {
      const tr = document.createElement('tr')
      const name = document.createElement('td')
      name.textContent = row.state ? `${row.county}, ${row.state}` : row.county
      tr.appendChild(name)
      for (const cell of row.cells) {
        const td = document.createElement('td')
        td.textContent = cell.display
        // Same words as the page: these rank THESE counties, nothing wider.
        // The tint is set inline rather than by class because a card is
        // hydrated inside whatever page embeds it — it cannot assume the
        // wiki's stylesheet is the one on screen.
        if (cell.rank) {
          td.className = `embed-rank-${cell.rank}`
          td.title = `${cell.rank} of these`
          td.style.background = cell.rank === 'best' ? 'rgba(31, 122, 46, 0.08)' : 'rgba(183, 28, 28, 0.06)'
        }
        tr.appendChild(td)
      }
      if (hasNotes) {
        const note = document.createElement('td')
        note.textContent = notes[row.geoId] ?? ''
        tr.appendChild(note)
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    wrap.appendChild(table)
    target.appendChild(wrap)
  } else {
    target.appendChild(el('div', 'embed-more', 'This comparison has nothing left to show.'))
  }

  const link = el('a', 'embed-link', 'Open comparison →')
  link.setAttribute('href', compareViewUrl(state, view.slug))
  target.appendChild(link)
}

async function renderEntryCard(target: HTMLElement, entry: CatalogEntry): Promise<void> {
  target.textContent = ''
  target.dataset.embedState = 'loaded'
  target.classList.add('wiki-embed-card')

  // P5-35: an archived entry points readers at the latest instead of
  // presenting itself as current.
  if (entry.status === 'archived') {
    target.classList.add('wiki-embed-card--archived')
    target.appendChild(el('div', 'embed-title', entry.title))
    if (entry.supersededBy) {
      const note = el('div', 'embed-meta', 'Archived — superseded by ')
      const link = el('a', 'embed-link', entry.supersededBy.title)
      link.setAttribute('href', `/library/${entry.supersededBy.slug}`)
      note.appendChild(link)
      target.appendChild(note)
    } else {
      target.appendChild(el('div', 'embed-meta', 'Archived — kept for the record'))
    }
    const old = el('a', 'embed-link embed-link--muted', 'Open the archived copy →')
    old.setAttribute('href', `/library/${entry.slug}`)
    target.appendChild(old)
    return
  }

  target.appendChild(el('div', 'embed-title', entry.title))
  const metaParts = [entry.kind, entry.category, entry.status].filter(Boolean)
  if (metaParts.length > 0) {
    target.appendChild(el('div', 'embed-meta', metaParts.join(' · ')))
  }
  // P5-34: link drops show where they point.
  const url = linkOf(entry)
  if (url) {
    const line = el('div', 'embed-meta')
    const a = el('a', 'embed-link embed-link--external', url)
    a.setAttribute('href', url)
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
    line.appendChild(a)
    target.appendChild(line)
  }

  // P5-36: every action the entry actually supports, so a card is a hub.
  const actions = el('div', 'embed-actions')
  const open = el('a', 'embed-link', 'Open in library →')
  open.setAttribute('href', `/library/${entry.slug}`)
  actions.appendChild(open)
  if (hasTabularFile(entry.files ?? [])) {
    const data = el('a', 'embed-link', 'Browse data →')
    data.setAttribute('href', `/library/${entry.slug}?tab=data`)
    actions.appendChild(data)
  }
  const layerId = layerIdForEntry(entry)
  if (layerId) {
    const map = el('a', 'embed-link', 'Show on map →')
    // P5-77: a point layer's card opens the map on its points, not the country.
    map.setAttribute('href', await mapHrefForInternalLayerId(layerId))
    actions.appendChild(map)
  }
  target.appendChild(actions)
}

// --- Map blocks (P7-4) ------------------------------------------------------

/**
 * How many live canvases one page may mount.
 *
 * mapbox-gl holds a WebGL context per map and a browser keeps only so many —
 * somewhere in the mid-teens — before it starts dropping the oldest, which
 * would blank a map the reader has already scrolled past. A cap is the same
 * bounded-by-construction rule `EMBED_RESULTS_SHOWN` and `EMBED_ROWS_SHOWN`
 * already follow, and three is enough for a story that frames a thing, then
 * reframes it, then shows the consequence. The rest say so and link out.
 */
export const MAP_BLOCKS_LIVE = 3

/**
 * Why a map block is not a live map, when it is not one.
 *
 * Host policy, so it lives with the host and not with the component: `preview`
 * is the editor saying "not in here", `capped` is this page saying "not a
 * fourth". The block adds one more reason of its own — too narrow — which it
 * reads off `useMapPane` rather than being told, because that one can change
 * under a reader who resizes the window.
 */
export type MapBlockMode = 'live' | 'preview' | 'capped'

/**
 * The one thing a `map:` block is most likely to be wrong about.
 *
 * §F.1: a page embeds **views**, and the views read from the set. So
 * `map:<working-set-slug>` is the natural mistake, and "Saved view not found"
 * would be a true sentence that sends somebody looking in the wrong place. If
 * the slug IS a set, say so and name the views over it — which are the things
 * that can be embedded.
 *
 * Imported on demand, inside the branch that needs it: a page whose blocks all
 * resolve never loads the working-set client at all.
 */
async function noteWorkingSetInstead(target: HTMLElement, slug: string): Promise<void> {
  try {
    const { fetchWorkingSet } = await import('./workingSets')
    const set = await fetchWorkingSet(slug)
    if (!set) {
      note(target, `Saved view not found: ${slug}`, 'missing')
      return
    }
    const views = set.views.map(view => view.name)
    note(
      target,
      views.length
        ? `“${set.name}” is a working set, not a view — a page embeds a view of it. Views over it: ${views.join(', ')}.`
        : `“${set.name}” is a working set, not a view — a page embeds a view of it, and this set has none yet.`,
      'missing',
    )
  } catch {
    note(target, `Saved view not found: ${slug}`, 'missing')
  }
}

/**
 * The block component, imported at most once.
 *
 * One promise rather than one per block: several `map:` placeholders on a page
 * hydrate concurrently, and N concurrent `import()`s of one module is N chances
 * to resolve it differently for no benefit. Memoised here rather than at the
 * top of the file because **not** evaluating it is the point — a page with no
 * map block never calls this, so the chunk, mapbox-gl and the county files are
 * never requested.
 */
let mapBlockModule: Promise<typeof import('@/components/WikiMapBlock.vue')> | null = null
function loadMapBlock(): Promise<typeof import('@/components/WikiMapBlock.vue')> {
  mapBlockModule ??= import('@/components/WikiMapBlock.vue')
  return mapBlockModule
}

/**
 * Mount a live map for a saved view.
 *
 * The dynamic import is the ticket's second acceptance criterion, expressed as
 * code rather than as care: a page with no `map:` placeholder never reaches
 * this function, so the block's chunk — and through it mapbox-gl and the county
 * files — is never requested. Everything that can be decided WITHOUT the map
 * (the slug is not a view, the view has no map state, the page is already full)
 * is decided above the import, so a page that cannot draw does not pay either.
 */
async function renderMapBlock(
  target: HTMLElement,
  slug: string,
  mode: MapBlockMode,
  options: HydrateOptions,
): Promise<void> {
  const view = await cachedFetch(viewCache, slug, fetchView)
  if (view === null) {
    await noteWorkingSetInstead(target, slug)
    return
  }
  target.textContent = ''
  target.dataset.embedState = 'loaded'
  target.classList.add('wiki-embed-map')

  const { default: WikiMapBlock } = await loadMapBlock()
  const app = createApp(WikiMapBlock, { view, mode, limit: MAP_BLOCKS_LIVE })
  // `MapCanvas` resolves `useRouter()` for its feature popups, and a block's
  // own links are plain anchors the page's click interceptor routes. An app
  // created here has no plugins of its own, so the host lends its router.
  if (options.router) app.use(options.router)
  app.mount(target)
  mountedApps.push({ app, node: target, drawsMap: mode === 'live' })
}

async function hydrateOne(
  target: HTMLElement,
  options: HydrateOptions,
  mapMode: MapBlockMode = 'live',
): Promise<void> {
  const kind = target.dataset.embed
  const slug = target.dataset.embedSlug ?? ''
  if ((kind !== 'view' && kind !== 'entry' && kind !== 'map') || !EMBED_SLUG.test(slug)) {
    note(target, `Invalid embed: ${kind ?? '?'}:${slug || '?'}`, 'error')
    return
  }
  target.dataset.embedState = 'loading'
  try {
    if (kind === 'map') {
      await renderMapBlock(target, slug, mapMode, options)
    } else if (kind === 'view') {
      const view = await cachedFetch(viewCache, slug, fetchView)
      const table = view && tableStateOf(view)
      const compare = view && compareStateOf(view)
      if (view === null) note(target, `Saved view not found: ${slug}`, 'missing')
      else if (table) await renderTableViewCard(target, view, table)
      else if (compare) await renderCompareViewCard(target, view, compare)
      else renderViewCard(target, view)
    } else {
      const entry = await cachedFetch(entryCache, slug, fetchCatalogEntry)
      if (entry === null) note(target, `Library entry not found: ${slug}`, 'missing')
      else await renderEntryCard(target, entry)
    }
  } catch (err: unknown) {
    console.warn('[wiki] embed hydration failed:', err)
    note(target, `Couldn't load ${kind}:${slug}`, 'error')
  }
}

/** What the host can tell hydration about itself (P7-4). */
export interface HydrateOptions {
  /**
   * Whether a `map:` block may mount a real canvas. The page itself: yes. The
   * editor's preview: **no** — it re-renders on every keystroke, and a WebGL
   * context per keystroke is a different thing from a chart per keystroke.
   */
  liveMaps?: boolean
  /** The host app's router, lent to the apps mounted inside blocks so their
   *  in-app links and popups route instead of reloading the page. */
  router?: Router
}

/** Upgrade every un-hydrated embed placeholder inside `container`. Safe to
 *  call repeatedly (already-hydrated nodes are skipped) and never rejects. */
export async function hydrateEmbeds(
  container: ParentNode,
  options: HydrateOptions = {},
): Promise<void> {
  releaseDetachedApps()
  const targets = Array.from(container.querySelectorAll<HTMLElement>('[data-embed]')).filter(
    target => !target.dataset.embedState,
  )
  if (targets.length === 0) return
  // Which map blocks get a live canvas is decided HERE, synchronously, in
  // document order — before anything is awaited. Letting `renderMapBlock`
  // check the count itself would have three blocks all read "0 live" in the
  // same tick and all mount; deciding up front also means the cap falls on the
  // blocks furthest down the page, which is the order a reader meets them.
  const live = options.liveMaps !== false
  let slots = live ? Math.max(0, MAP_BLOCKS_LIVE - liveMapCount()) : 0
  const work = targets.map(target => {
    if (target.dataset.embed !== 'map') return hydrateOne(target, options)
    if (!live) return hydrateOne(target, options, 'preview')
    if (slots > 0) {
      slots--
      return hydrateOne(target, options, 'live')
    }
    return hydrateOne(target, options, 'capped')
  })
  await Promise.all(work)
}
