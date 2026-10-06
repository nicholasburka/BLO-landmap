<script setup lang="ts">
/**
 * Embed picker (P5-49): find a library entry or a saved view, drop it into
 * the page as a ```entry:<slug>``` / ```view:<slug>``` fence that
 * renderWikiMarkdown turns into a live card (P5-17).
 *
 * P7-4 adds a second action on a saved MAP view: the same view as a ```map:```
 * fence, which draws a canvas in the page instead of summarising it. Offered
 * only where it can work — a table view and a comparison have no map in them,
 * and a map view naming no layer has nothing to draw — because a button that
 * leads to "there is no map in it" is worse than no button.
 *
 * Search runs on the server (the catalog caps results at 200 rows and filters
 * `q` before that cap, so filtering a first page client-side would quietly
 * miss things). Typing is debounced into one request; a stale response can
 * never overwrite a newer one.
 *
 * Map layers are deliberately absent — public layer pages are P5-45's, and
 * this picker must not depend on them landing.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'

const emit = defineEmits<{
  select: [{ kind: 'entry' | 'view' | 'map'; slug: string }]
  close: []
}>()

/** Long enough to swallow a burst of typing, short enough to feel live. */
const DEBOUNCE_MS = 250
/** A picker is a shortlist, not a browser — the search box narrows it. */
const SHOWN = 20

const query = ref('')
const entries = ref<CatalogEntry[]>([])
const loading = ref(false)
const error = ref('')
const queryEl = ref<HTMLInputElement | null>(null)

let debounce: ReturnType<typeof setTimeout> | undefined
/** Only the newest search may write to `entries` — responses can land out of
 *  order, and an old one overwriting a new one looks like a broken search. */
let latest = 0

async function search(): Promise<void> {
  const ticket = ++latest
  const q = query.value.trim()
  loading.value = true
  error.value = ''
  try {
    const found = await fetchCatalog(q ? { q } : {})
    if (ticket !== latest) return
    entries.value = found.slice(0, SHOWN)
  } catch {
    if (ticket !== latest) return
    entries.value = []
    error.value = "That search couldn't be run. Try again in a moment."
  } finally {
    if (ticket === latest) loading.value = false
  }
}

function onInput(): void {
  clearTimeout(debounce)
  debounce = setTimeout(() => void search(), DEBOUNCE_MS)
}

function onSubmit(): void {
  clearTimeout(debounce)
  void search()
}

onMounted(() => {
  queryEl.value?.focus()
  void search()
})
onBeforeUnmount(() => clearTimeout(debounce))

/** Saved views hydrate from a different endpoint than everything else, so the
 *  fence keyword differs; every other catalog kind is an `entry`. */
function embedKindOf(entry: CatalogEntry): 'entry' | 'view' {
  return entry.kind === 'view' ? 'view' : 'entry'
}

/** "view" is the catalog's word; "saved view" is the one people here use. */
function kindLabel(entry: CatalogEntry): string {
  return entry.kind === 'view' ? 'saved view' : entry.kind
}

function choose(entry: CatalogEntry): void {
  emit('select', { kind: embedKindOf(entry), slug: entry.slug })
}

/**
 * Whether this row can be embedded as a live map (P7-4).
 *
 * Read off the catalog row's own meta — `savedViewMeta` already puts the view's
 * type and the union of its layers there, so the picker needs no second request
 * and no new endpoint. A document written before view types carries no `type`
 * and is a map view, the same stated absence `fetchView` normalises.
 */
function canEmbedAsMap(entry: CatalogEntry): boolean {
  if (embedKindOf(entry) !== 'view') return false
  const type = entry.meta?.type
  if (type !== undefined && type !== 'map') return false
  const layers = entry.meta?.layers
  return Array.isArray(layers) && layers.length > 0
}
</script>

<template>
  <div class="embed-picker" data-testid="embed-picker">
    <div class="picker-head">
      <strong>Add an embed</strong>
      <button type="button" class="close-btn" data-testid="embed-close" @click="emit('close')">
        Close
      </button>
    </div>
    <p class="picker-hint">
      Pick something from the library and it appears in the page as a card. A saved map view can be drawn as a map.
    </p>

    <form data-testid="embed-search" @submit.prevent="onSubmit">
      <input
        ref="queryEl"
        v-model="query"
        type="search"
        class="picker-input"
        data-testid="embed-query"
        placeholder="Search the library…"
        aria-label="Search the library"
        @input="onInput"
        @keydown.escape="emit('close')"
      />
    </form>

    <p v-if="error" class="picker-note error" data-testid="embed-error">{{ error }}</p>
    <p v-else-if="loading && !entries.length" class="picker-note">Searching…</p>
    <p v-else-if="!entries.length" class="picker-note" data-testid="embed-empty">
      Nothing matched. Try a different word.
    </p>

    <ul v-if="entries.length" class="picker-results">
      <li v-for="entry in entries" :key="entry.slug" class="picker-row">
        <button
          type="button"
          class="picker-result"
          data-testid="embed-result"
          :data-slug="entry.slug"
          :data-kind="embedKindOf(entry)"
          @click="choose(entry)"
        >
          <span class="result-title">{{ entry.title }}</span>
          <span class="result-kind" data-testid="embed-kind">{{ kindLabel(entry) }}</span>
        </button>
        <!-- The same view, as a canvas rather than a summary (P7-4). -->
        <button
          v-if="canEmbedAsMap(entry)"
          type="button"
          class="picker-as-map"
          data-testid="embed-as-map"
          :data-slug="entry.slug"
          :title="`Draw “${entry.title}” as a map in this page`"
          @click="emit('select', { kind: 'map', slug: entry.slug })"
        >as a map</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.embed-picker {
  width: min(420px, 90vw);
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: 0 8px 24px rgba(17, 17, 17, 0.12);
}

/* The row is the result plus, for a map view, one extra action. */
.picker-row {
  display: flex;
  align-items: stretch;
  gap: 6px;
}

.picker-row .picker-result {
  flex: 1 1 auto;
  min-width: 0;
}

.picker-as-map {
  flex: 0 0 auto;
  padding: 0 10px;
  font: inherit;
  font-size: 12px;
  color: var(--blo-green-deep, #1f4332);
  background: transparent;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.picker-as-map:hover {
  background: rgba(31, 67, 50, 0.06);
}

.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
  font-size: 14px;
  color: var(--blo-ink);
}

.close-btn {
  padding: 2px 10px;
  font-size: 12px;
  color: var(--blo-stone);
  background: transparent;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.picker-hint,
.picker-note {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--blo-stone);
}

.picker-note.error {
  color: #b3261e;
}

.picker-input {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 8px;
  padding: 6px 10px;
  font-size: 14px;
  color: var(--blo-ink);
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.picker-results {
  max-height: 260px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.picker-result {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  font-size: 13.5px;
  text-align: left;
  color: var(--blo-ink);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.picker-result:hover,
.picker-result:focus-visible {
  background: rgba(17, 17, 17, 0.05);
}

.result-title {
  overflow-wrap: anywhere;
}

.result-kind {
  flex-shrink: 0;
  padding: 1px 7px;
  font-size: 11.5px;
  color: var(--blo-stone);
  background: rgba(17, 17, 17, 0.05);
  border-radius: 999px;
}

/* P5-60: inside a bottom sheet the picker is the sheet — it drops its own
   fixed width, border and shadow and fills the width it is given. */
@media (max-width: 640px) {
  .embed-picker {
    width: 100%;
    padding: 0;
    background: transparent;
    border: 0;
    box-shadow: none;
  }

  .picker-head {
    font-size: 16px;
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    font-size: 14px;
  }

  .picker-hint,
  .picker-note {
    font-size: 14px;
  }

  .picker-input {
    min-height: 44px;
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .picker-results {
    max-height: 50svh;
  }

  .picker-result {
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .result-kind {
    font-size: 13px;
  }
}
</style>
