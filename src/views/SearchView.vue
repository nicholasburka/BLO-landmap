<script setup lang="ts">
/**
 * Search (P6-6, spec §D). One box, one page, every resource.
 *
 * The URL is the state: `?q=` plus the five filter keys (`kind`,
 * `organization`, `topic`, `type`, `purpose`), so a grouped, filtered search
 * is something a researcher can send to somebody else. Everything on screen is
 * read from the route and nothing is remembered behind its back.
 *
 * Results come back grouped in the held-first order — what the team holds
 * before what it only points at — and when the filed rows are thin the
 * documents themselves are searched too (`lib/search.ts`).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import {
  FILTER_KEYS,
  INSIDE_DOCUMENTS,
  searchEverything,
  searchUrl,
  filtersFromQuery,
  type FilterKey,
  type SearchFilters,
  type SearchOutcome,
} from '@/lib/search'
import { friendlyError } from '@/lib/errors'

const route = useRoute()
const router = useRouter()

/** What is in the box — free to differ from the URL until Enter. */
const typed = ref('')
/** What the URL asked for, and so what is on screen. */
const searched = ref('')
const filters = ref<SearchFilters>({})
const outcome = ref<SearchOutcome | null>(null)
const loading = ref(false)
const error = ref('')
const boxEl = ref<HTMLInputElement | null>(null)

const FILTER_LABELS: Record<FilterKey, string> = {
  kind: 'Kind',
  organization: 'Organization',
  topic: 'Topic',
  type: 'Type',
  purpose: 'Purpose',
}

/** A group name as a test/CSS-safe id: "Inside documents" → "inside-documents". */
function groupId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-')
}

/** Every search takes a ticket, so a slow answer that lands after a newer one
 *  began is dropped instead of replacing the list someone is now reading. */
let ticket = 0

async function run(): Promise<void> {
  const mine = ++ticket
  const current = () => mine === ticket
  if (!searched.value) {
    outcome.value = null
    error.value = ''
    loading.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    const result = await searchEverything(searched.value, filters.value)
    if (current()) outcome.value = result
  } catch (err: unknown) {
    if (current()) {
      outcome.value = null
      error.value = friendlyError(err, 'The search did not run. Try again in a moment.')
    }
  } finally {
    if (current()) loading.value = false
  }
}

/** The route is the truth: read it, then search. */
function syncFromRoute(): void {
  const q = typeof route.query.q === 'string' ? route.query.q.trim() : ''
  typed.value = q
  searched.value = q
  filters.value = filtersFromQuery(route.query)
  void run()
}

watch(() => route.fullPath, syncFromRoute)

onMounted(() => {
  syncFromRoute()
  // A search page you have to click into is a search page you have to click
  // into twice.
  boxEl.value?.focus()
})

function submit(): void {
  void router.push(searchUrl(typed.value, filters.value))
}

/** A chip is a toggle: pressing the one you are on clears it. */
function toggleFilter(key: FilterKey, id: string): void {
  const next: SearchFilters = { ...filters.value }
  if (next[key] === id) delete next[key]
  else next[key] = id
  void router.replace(searchUrl(searched.value, next))
}

function clearFilters(): void {
  void router.replace(searchUrl(searched.value, {}))
}

const activeFilters = computed(() => FILTER_KEYS.filter(key => !!filters.value[key]))

/** One row of chips per filter that has anything to choose from. The active
 *  value is always among them, so a chosen chip can always be un-chosen. */
const chipRows = computed(() =>
  FILTER_KEYS.map(key => {
    const facets = outcome.value?.facets[key] ?? []
    const active = filters.value[key]
    const rows = active && !facets.some(f => f.id === active) ? [{ id: active, label: active, count: 0 }, ...facets] : facets
    return { key, label: FILTER_LABELS[key], facets: rows }
  }).filter(row => row.facets.length > 0),
)

const groups = computed(() => outcome.value?.groups ?? [])
const nothingMatched = computed(() => !loading.value && !error.value && !!searched.value && groups.value.length === 0)
</script>

<template>
  <div class="search-view">
    <div class="search-panel">
      <KbNav />
      <header class="search-header">
        <h1>Search</h1>
        <p class="search-sub">Everything in the knowledge base — datasets, pages, analyses, documents, notes, layers and sources.</p>
      </header>

      <form class="search-box" role="search" @submit.prevent="submit">
        <input
          ref="boxEl"
          v-model="typed"
          type="search"
          class="search-input"
          placeholder="What are you looking for?"
          aria-label="Search the knowledge base"
          autocomplete="off"
          data-testid="search-box"
        />
        <button type="submit" class="search-btn" data-testid="search-submit">Search</button>
      </form>

      <div v-if="chipRows.length" class="chip-rows" data-testid="search-chips">
        <div v-for="row in chipRows" :key="row.key" class="chip-row">
          <span class="chip-label">{{ row.label }}</span>
          <button
            v-for="facet in row.facets"
            :key="facet.id"
            type="button"
            class="chip"
            :class="{ active: filters[row.key] === facet.id }"
            :aria-pressed="filters[row.key] === facet.id"
            :data-testid="`search-chip-${row.key}-${facet.id}`"
            @click="toggleFilter(row.key, facet.id)"
          >
            {{ facet.label }}<span v-if="facet.count" class="chip-count">{{ facet.count }}</span>
          </button>
        </div>
        <button v-if="activeFilters.length" type="button" class="clear-btn" data-testid="search-clear" @click="clearFilters">
          Clear filters
        </button>
      </div>

      <!-- The skeleton is for the FIRST search only: narrowing an answer you
           are already reading should keep it on screen (dimmed) rather than
           replace it with three grey boxes. -->
      <ul v-if="loading && !outcome" class="result-list skeleton" aria-busy="true" aria-label="Searching">
        <li v-for="n in 3" :key="n" class="result result--skeleton"><span class="sk sk-title"></span><span class="sk sk-meta"></span></li>
      </ul>
      <p v-else-if="error" class="state-note error" data-testid="search-error">{{ error }}</p>
      <p v-else-if="!searched" class="state-note" data-testid="search-start">
        Type a few words and press Enter. Every filter is part of the link, so a search can be sent to somebody else.
      </p>
      <p v-else-if="nothingMatched" class="state-note empty" data-testid="search-empty">
        Nothing matched — try fewer words, or <RouterLink to="/chat">ask in Chat</RouterLink>.
      </p>

      <section
        v-for="group in groups"
        :key="group.name"
        class="result-group"
        :class="{ 'result-group--text': group.name === INSIDE_DOCUMENTS, searching: loading }"
        :data-testid="`search-group-${groupId(group.name)}`"
      >
        <h2 class="group-name">
          {{ group.name }}
          <span class="group-count" data-testid="group-count">{{ group.items.length }}</span>
        </h2>
        <!-- Said once, in words: these rows are pages of documents, not
             things somebody filed under these words (spec §D.14). -->
        <p v-if="group.name === INSIDE_DOCUMENTS" class="group-note">
          Matches in the text of documents we hold. Each one opens the document at that page.
        </p>
        <ul class="result-list">
          <li v-for="item in group.items" :key="item.key">
            <RouterLink :to="item.href" class="result">
              <span class="result-title-row">
                <span class="result-title">{{ item.title }}</span>
                <span class="badge">{{ item.badge }}</span>
              </span>
              <span v-if="item.snippet" class="result-snippet">{{ item.snippet }}</span>
              <span v-if="item.verdict" class="result-verdict">{{ item.verdict }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
}

.search-panel {
  width: 100%;
  max-width: 860px;
}

.search-header h1 {
  margin: 18px 0 4px;
  font-size: 26px;
  color: var(--blo-ink, #111);
}

.search-sub {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.search-box {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.search-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 12px 14px;
  font-size: 16px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.search-btn {
  flex: 0 0 auto;
  padding: 0 18px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.chip-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.chip-label {
  min-width: 96px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--blo-green-deep, #1f7a2e);
}

.chip.active {
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border-color: var(--blo-green-deep, #1f7a2e);
}

.chip-count {
  font-size: 11px;
  opacity: 0.7;
}

.clear-btn {
  align-self: flex-start;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.state-note {
  margin: 16px 2px;
  font-size: 14px;
  color: var(--blo-stone, #6b6560);
}

.state-note.error {
  color: #b71c1c;
}

.state-note a {
  color: var(--blo-green-deep, #1f7a2e);
}

.result-group {
  margin-top: 20px;
}

/* Narrowing an answer that is already on screen: it stays, faded, until the
   new one lands. */
.result-group.searching {
  opacity: 0.5;
}

.group-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.group-count {
  font-size: 12px;
  letter-spacing: 0;
  color: var(--blo-stone, #6b6560);
}

.group-note {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.result-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  text-decoration: none;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.result:hover {
  border-color: var(--blo-green-deep, #1f7a2e);
}

.result-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.result-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--blo-ink, #111);
}

.badge {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
  background: var(--blo-cream, #f7f4ee);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
}

.result-snippet,
.result-verdict {
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.result--skeleton {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.sk {
  display: block;
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, #efeae0, #f7f4ee, #efeae0);
}

.sk-title {
  width: 45%;
  height: 15px;
}

.sk-meta {
  width: 70%;
}

/* --- P5-60 (phone) --------------------------------------------------------
   One column, bigger type, and every chip a real touch target. */
@media (max-width: 640px) {
  .search-view {
    padding: 16px 12px 40px;
  }

  .search-input {
    min-height: 44px;
  }

  .search-btn,
  .chip,
  .clear-btn {
    min-height: 44px;
  }

  .chip-label {
    flex-basis: 100%;
    min-width: 0;
  }

  .search-sub,
  .group-note,
  .result-snippet,
  .result-verdict {
    font-size: 13px;
  }

  .state-note {
    font-size: 15px;
  }
}
</style>
