<script setup lang="ts">
/**
 * Global search / command palette (P5-38). One box, internal users only,
 * across everything the catalog indexes — wiki pages, datasets, documents,
 * notes, saved views — plus the internal map layers from the manifest.
 * ⌘K / Ctrl-K opens it, arrows move, Esc closes. Enter on a row you moved
 * onto opens that row; Enter on what you typed, with no row picked, hands the
 * query to /search — the palette is the quick version of that page (P6-6,
 * spec §D.13). Each row also carries the actions the item supports
 * (Browse data · Show on map) so the palette is a hub, not just a finder.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { fetchCatalogPage, entryUrl, layerIdForEntry, sourceOf, purposeLabelOf, topicLabelOf, type CatalogEntry } from '@/lib/libraryCatalog'
import { hasTabularFile } from '@/lib/libraryData'
import { sharedManifest, mapHrefForInternalLayer, type InternalLayerManifestEntry } from '@/lib/internalLayers'
import { mapUrlForLayers } from '@/lib/mapDeepLinks'
import { askUrl } from '@/lib/ask'
import { searchUrl } from '@/lib/search'
import { kindLabel } from '@/lib/kb'
import { CATEGORY_LABELS, publicLayers, searchLayers } from '@/lib/publicLayers'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/scrollLock'
import { friendlyError } from '@/lib/errors'

export interface SearchResult {
  key: string
  group: 'Ask' | 'Pages' | 'Datasets' | 'Layers' | 'Documents' | 'Notes' | 'Views' | 'To file' | 'Data sources'
  title: string
  meta: string
  href: string
  data?: string
  map?: string
}

/**
 * P5-64: grouped by trust. What the team holds and has vetted comes first, the
 * queue of things nobody has filed yet after it, and the registry we only point
 * at last — where a badge used to be the only thing saying so.
 */
const GROUP_ORDER: SearchResult['group'][] = [
  'Pages',
  'Datasets',
  'Layers',
  'Documents',
  'Notes',
  'Views',
  'To file',
  'Data sources',
]

/** A group name as a test/CSS-safe id: "Data sources" → "data-sources". */
function groupId(group: SearchResult['group']): string {
  return group.toLowerCase().replace(/\s+/g, '-')
}

const PER_GROUP = 5
const DEBOUNCE_MS = 200

const router = useRouter()
const open = ref(false)
const query = ref('')
const results = ref<SearchResult[]>([])
const loading = ref(false)
const error = ref('')
/** Nothing highlighted. The palette opens on no row at all, so Enter means
 *  "search everything for what I typed" (P6-6) until somebody moves onto a
 *  row with the arrows or the mouse, when it means "open that". */
const NOTHING_HIGHLIGHTED = -1
const highlighted = ref(NOTHING_HIGHLIGHTED)
const inputEl = ref<HTMLInputElement | null>(null)

let requestId = 0
let timer: ReturnType<typeof setTimeout> | null = null

function groupFor(entry: CatalogEntry): SearchResult['group'] | null {
  switch (entry.kind) {
    case 'wiki':
      return 'Pages'
    case 'dataset':
      return 'Datasets'
    // P5-64: a source is a pointer at somebody else's data. It used to sit
    // with the datasets under a badge, which put five sources above the vetted
    // layer somebody was actually looking for.
    case 'source':
      return 'Data sources'
    case 'document':
      return 'Documents'
    // A dropped link nobody has filed yet is not a document — it is a job.
    case 'incoming':
      return 'To file'
    case 'note':
      return 'Notes'
    case 'view':
      return 'Views'
    default:
      return null
  }
}

function toResult(entry: CatalogEntry, layers: Map<string, InternalLayerManifestEntry>): SearchResult | null {
  const group = groupFor(entry)
  if (!group) return null
  const layerId = layerIdForEntry(entry)
  // P5-77: the manifest knows a point layer's extent, so the row's map link
  // opens on the layer instead of on the whole country.
  const layer = layerId ? layers.get(layerId) : undefined
  const source = sourceOf(entry)
  // P5-54: a saved view's row says which kind it is and what it holds. Its
  // category ("views") and status ("published") tell a reader nothing.
  // P5-63: the plain-word topic (and the purpose when it has one) rather than
  // the raw category id — the same words the Library facet and /layers use.
  const metaParts = (
    entry.kind === 'view'
      ? [entry.meta?.type === 'table' ? 'table view' : 'map view', entry.meta?.description]
      : [source?.provider, topicLabelOf(entry) || purposeLabelOf(entry) || entry.category, entry.status]
  ).filter((part): part is string => typeof part === 'string' && part !== '')
  return {
    key: `${entry.kind}:${entry.slug}`,
    group,
    title: entry.title,
    meta: metaParts.join(' · '),
    href: group === 'Pages' ? `/wiki/${entry.slug}` : group === 'Views' ? `/views/${entry.slug}` : entryUrl(entry.slug),
    data: hasTabularFile(entry.files ?? []) ? entryUrl(entry.slug, 'data') : undefined,
    map: layer ? mapHrefForInternalLayer(layer) : layerId ? mapUrlForLayers([layerId]) : undefined,
  }
}

function layerResults(layers: InternalLayerManifestEntry[], needle: string): SearchResult[] {
  return layers
    .filter(l => l.name.toLowerCase().includes(needle) || l.slug.toLowerCase().includes(needle))
    .map(l => ({
      key: `layer:${l.id}`,
      group: 'Layers' as const,
      title: l.name,
      meta: `${l.geometry} layer`,
      href: mapHrefForInternalLayer(l),
      map: mapHrefForInternalLayer(l),
      data: entryUrl(l.slug, 'data'),
    }))
}

/** P5-45: the public map's own layers are knowledge-base material too. They
 *  need no request — the registry is in this bundle — so they cost nothing
 *  here, and their primary link is the about page, not the map. */
function publicLayerResults(needle: string): SearchResult[] {
  return searchLayers(publicLayers(), needle).map(l => ({
    key: `public-layer:${l.id}`,
    group: 'Layers' as const,
    title: l.name,
    meta: `${kindLabel('layer')} · ${CATEGORY_LABELS[l.category]}`,
    href: `/layers/${l.id}`,
    map: mapUrlForLayers([l.id]),
  }))
}

async function runSearch(): Promise<void> {
  const needle = query.value.trim().toLowerCase()
  const id = ++requestId
  if (!needle) {
    results.value = []
    error.value = ''
    return
  }
  loading.value = true
  try {
    // P5-89: both reads go through their module's cache — a query typed twice
    // answers from memory, and the manifest is fetched once per session.
    const [page, layers] = await Promise.all([
      fetchCatalogPage({ q: needle }),
      sharedManifest().catch(() => [] as InternalLayerManifestEntry[]),
    ])
    if (id !== requestId) return
    const byLayerId = new Map(layers.map(l => [l.id, l]))
    const grouped = new Map<SearchResult['group'], SearchResult[]>()
    for (const entry of page.entries) {
      const r = toResult(entry, byLayerId)
      if (!r) continue
      const list = grouped.get(r.group) ?? []
      if (list.length < PER_GROUP) list.push(r)
      grouped.set(r.group, list)
    }
    // Internal layers first: they are the ones a logged-in researcher is
    // usually hunting for, and the public ones are always one click away
    // on /layers.
    grouped.set('Layers', [...layerResults(layers, needle), ...publicLayerResults(needle)].slice(0, PER_GROUP))
    results.value = GROUP_ORDER.flatMap(g => grouped.get(g) ?? [])
    highlighted.value = NOTHING_HIGHLIGHTED
    error.value = ''
  } catch (err: unknown) {
    if (id !== requestId) return
    results.value = []
    error.value = friendlyError(err, 'The search did not run. Try again in a moment.')
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch(query, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void runSearch(), DEBOUNCE_MS)
})

const groups = computed(() =>
  GROUP_ORDER.map(g => ({ name: g, items: results.value.filter(r => r.group === g) })).filter(g => g.items.length > 0),
)

/** P5-41: the first row is always "Ask: <what you typed>" — the palette's
 *  answer to "I don't know what this is filed under". It needs no request, so
 *  it appears the moment you type, ahead of the debounced search. */
const askRow = computed<SearchResult | null>(() => {
  const typed = query.value.trim()
  if (!typed) return null
  return { key: 'ask', group: 'Ask', title: `Ask: ${typed}`, meta: 'get an answer with sources', href: askUrl(typed) }
})

/** Every navigable row, in screen order — the Ask row, then the results. */
const rows = computed<SearchResult[]>(() => (askRow.value ? [askRow.value, ...results.value] : results.value))

function indexOf(r: SearchResult): number {
  return rows.value.findIndex(x => x.key === r.key)
}

async function openPalette(): Promise<void> {
  open.value = true
  highlighted.value = NOTHING_HIGHLIGHTED
  // P5-60: the palette is full-screen on a phone; the page behind it must not
  // scroll away under a finger that misses a row.
  lockBodyScroll()
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}

function closePalette(): void {
  if (!open.value) return
  open.value = false
  unlockBodyScroll()
}

function go(href: string): void {
  closePalette()
  void router.push(href)
}

function onKey(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    if (open.value) closePalette()
    else void openPalette()
    return
  }
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    closePalette()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (rows.value.length) highlighted.value = (highlighted.value + 1) % rows.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    // From nothing, up is the last row — the same wrap the other direction has.
    if (rows.value.length) {
      highlighted.value =
        highlighted.value <= 0 ? rows.value.length - 1 : highlighted.value - 1
    }
  } else if (e.key === 'Enter') {
    const r = rows.value[highlighted.value]
    const typed = query.value.trim()
    // P6-6 (spec §D.13): the palette is the quick version of /search, so Enter
    // on a row you picked opens that row, and Enter on what you typed hands
    // the whole query to the search page.
    if (r) {
      e.preventDefault()
      go(r.href)
    } else if (typed) {
      e.preventDefault()
      go(searchUrl(typed))
    }
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (timer) clearTimeout(timer)
  // Unmounting while open (a logout, say) must not leave the page frozen.
  if (open.value) unlockBodyScroll()
})

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
</script>

<template>
  <button type="button" class="search-trigger" aria-label="Search the knowledge base" data-testid="search-trigger" @click="openPalette">
    <span class="search-trigger-icon" aria-hidden="true">⌕</span>
    <span class="search-trigger-text">Search</span>
    <kbd class="search-trigger-kbd">{{ isMac ? '⌘K' : 'Ctrl K' }}</kbd>
  </button>

  <div v-if="open" class="palette-backdrop" data-testid="search-palette" @click.self="closePalette">
    <div class="palette sheet sheet--full" role="dialog" aria-modal="true" aria-label="Search">
      <!-- The input stays first so a phone keyboard pushes the results down
           rather than covering what you are typing into. Esc is the way out on
           a keyboard; on a phone there is not one, hence the close button. -->
      <div class="palette-top">
        <input
          ref="inputEl"
          v-model="query"
          type="search"
          class="palette-input"
          placeholder="Search pages, datasets, documents, notes, views, layers…"
          aria-label="Search the knowledge base"
          autocomplete="off"
        />
        <button type="button" class="palette-close touch-target" aria-label="Close search" data-testid="search-close" @click="closePalette">✕</button>
      </div>
      <ul v-if="askRow" class="palette-list palette-ask">
        <li
          class="palette-row"
          :class="{ active: indexOf(askRow) === highlighted }"
          data-testid="search-result-ask"
          @mouseenter="highlighted = indexOf(askRow!)"
        >
          <a class="palette-primary" :href="askRow.href" @click.prevent="go(askRow!.href)">
            <span class="palette-title">{{ askRow.title }}</span>
            <span class="palette-meta">{{ askRow.meta }}</span>
          </a>
        </li>
      </ul>

      <p v-if="error" class="palette-note error">{{ error }}</p>
      <p v-else-if="!query.trim()" class="palette-note">Type to search. ↑↓ to move, Enter to open, Esc to close.</p>
      <p v-else-if="!loading && results.length === 0" class="palette-note" data-testid="search-empty">
        Nothing matches “{{ query.trim() }}”.
        <RouterLink :to="`/library?q=${encodeURIComponent(query.trim())}`" @click="closePalette">Search the library list →</RouterLink>
      </p>

      <div v-for="g in groups" :key="g.name" class="palette-group">
        <div class="palette-group-name">{{ g.name }}</div>
        <ul class="palette-list">
          <li
            v-for="r in g.items"
            :key="r.key"
            class="palette-row"
            :class="{ active: indexOf(r) === highlighted }"
            :data-testid="`search-result-${groupId(r.group)}`"
            @mouseenter="highlighted = indexOf(r)"
          >
            <a class="palette-primary" :href="r.href" @click.prevent="go(r.href)">
              <span class="palette-title">{{ r.title }}</span>
              <span v-if="r.meta" class="palette-meta">{{ r.meta }}</span>
            </a>
            <span class="palette-actions">
              <a v-if="r.data" :href="r.data" class="palette-action" @click.prevent="go(r.data!)">Browse data</a>
              <a v-if="r.map" :href="r.map" class="palette-action" @click.prevent="go(r.map!)">Show on map</a>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.search-trigger:hover {
  color: var(--blo-ink, #111);
}

.search-trigger-kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 4px;
  color: var(--blo-stone-soft, #9a948e);
}

.palette-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(20, 18, 14, 0.35);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 12vh;
}

.palette {
  width: min(640px, 94vw);
  max-height: 70vh;
  overflow-y: auto;
  background: var(--blo-cream, #f7f4ee);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.25);
  padding: 12px;
}

.palette-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.palette-input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  padding: 12px 14px;
  font-size: 16px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  background: #fff;
}

/* Esc closes the palette on a keyboard, so this button is for the devices
   that have none. */
.palette-close {
  display: none;
  flex: 0 0 auto;
  font-size: 18px;
  color: var(--blo-stone, #6b6560);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
  cursor: pointer;
}

.palette-note {
  margin: 10px 4px 0;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.palette-note.error {
  color: #b71c1c;
}

.palette-note a {
  color: var(--blo-green-deep, #1f7a2e);
}

.palette-ask {
  margin-top: 10px;
}

.palette-group {
  margin-top: 12px;
}

.palette-group-name {
  padding: 0 6px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.palette-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.palette-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 8px;
  border-radius: 8px;
}

.palette-row.active {
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.14));
}

.palette-primary {
  display: flex;
  flex-direction: column;
  min-width: 0;
  text-decoration: none;
  color: var(--blo-ink, #111);
}

.palette-title {
  font-size: 14px;
  font-weight: 600;
}

.palette-meta {
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.palette-actions {
  display: inline-flex;
  gap: 8px;
  flex: 0 0 auto;
}

.palette-action {
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
  white-space: nowrap;
}

.palette-action:hover {
  text-decoration: underline;
}

@media (max-width: 720px) {
  .search-trigger-text,
  .search-trigger-kbd {
    display: none;
  }
}

/* ⌘K is not a thing you can press on a phone. */
@media (hover: none) {
  .search-trigger-kbd {
    display: none;
  }
}

/* --- P5-60 (mobile pass) --------------------------------------------------
   A centred card floating 12vh down a 375 px screen wastes most of it and
   leaves the results under the keyboard. Full-screen instead: box at the top,
   results filling everything below it. */
@media (max-width: 640px) {
  .palette-backdrop {
    padding-top: 0;
    align-items: stretch;
  }

  .palette {
    width: 100%;
    max-height: none;
    height: 100svh;
    border-radius: 0;
    padding: calc(10px + env(safe-area-inset-top, 0px)) 12px calc(16px + env(safe-area-inset-bottom, 0px));
  }

  .palette-close {
    display: inline-flex;
  }

  .palette-input {
    min-height: 44px;
  }

  .palette-row {
    flex-wrap: wrap;
    min-height: 44px;
    padding: 4px 8px;
  }

  .palette-primary {
    flex: 1 1 100%;
    justify-content: center;
    min-height: 44px;
  }

  .palette-actions {
    flex-basis: 100%;
    gap: 12px;
  }

  .palette-action {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .palette-meta,
  .palette-note {
    font-size: 14px;
  }

  .palette-group-name {
    font-size: 13px;
  }
}
</style>
