<script setup lang="ts">
/**
 * The docs browser (P6-4).
 *
 * Everything written rather than tabular: wiki **pages**, uploaded
 * **documents**, **notes** (ideas among them), and the **to-file queue** —
 * things somebody dropped and nobody has filed yet.
 *
 * Grouped by **Purpose** (the default — strategy, research, outreach, ideas),
 * **Topic** or **Kind**, with the most recently updated first inside each
 * group, because a docs list is read for what changed.
 *
 * The queue is its own group rather than a kind among kinds: it is work
 * waiting on a person, not a category of writing, so it sits at the top and
 * only for the people it is work for — whoever dropped the file, and admins.
 * See `canSeeQueueRow` for exactly how that is decided, and what the list row
 * would have to carry for it to work for everyone.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import NewPageForm from '@/components/NewPageForm.vue'
import GroupControl from '@/components/browse/GroupControl.vue'
import GroupedList from '@/components/browse/GroupedList.vue'
import FilterChips from '@/components/browse/FilterChips.vue'
import {
  browseQuery,
  facetsFor,
  groupRows,
  matchesFilter,
  matchesQuery,
  queryValue,
  readStoredChoice,
  resolveChoice,
  writeStoredChoice,
  type BrowseGroup,
  type GroupKey,
} from '@/lib/browse'
import {
  fetchCatalog,
  purposeLabelOf,
  purposeOf,
  topicLabelOf,
  topicOf,
  type CatalogEntry,
} from '@/lib/libraryCatalog'
import { attentionKeysFor, attentionLabel, entryHref, isNeedsALookKey, kindLabel, needsALookNote, relativeTime } from '@/lib/kb'
import NeedsALookNote from '@/components/browse/NeedsALookNote.vue'
import { useAuth, type InternalUser } from '@/composables/useAuth'
import { friendlyError } from '@/lib/errors'

const GROUP_KEY = 'blo:docs-group'
const GROUPS = [
  { id: 'purpose', label: 'Purpose' },
  { id: 'topic', label: 'Topic' },
  { id: 'kind', label: 'Kind' },
]
const GROUP_IDS = GROUPS.map(g => g.id)
const DEFAULT_GROUP = 'purpose'

/** The kinds this browser lists, and what a heading full of them is called. */
const KIND_HEADINGS: Record<string, string> = {
  wiki: 'Pages',
  document: 'Documents',
  note: 'Notes',
  incoming: 'To file',
}
const DOC_KINDS = Object.keys(KIND_HEADINGS)

/** The queue's own heading — one group, always at the top when it is shown. */
const QUEUE_GROUP_ID = 'incoming'
const QUEUE_LABEL = 'To file'

interface DocRow {
  key: string
  title: string
  href: string
  kind: string
  kindLabel: string
  purpose: string
  purposeLabel: string
  topic: string
  topicLabel: string
  updatedAt: string
  when: string
  line: string
  search: string
  /** A drop nobody has filed — the queue group's rows. */
  isQueue: boolean
  /** P6-5: the admin queues this row is on (see `lib/kb`), so `?attention=…`
   *  from the attention panel opens exactly the rows its count came from. */
  attention: string[]
  /** P6-33: which fields this row needs a look at — "no topic · no coverage".
   *  The per-row line that makes the collapse lossless. */
  needsALook: string
  /** P6-34: the row's own entry, for the Keep / Edit / Clear actions. A
   *  reference, not a copy — the note reads the manifest's provenance block. */
  entry: CatalogEntry
}

const route = useRoute()
const router = useRouter()
const { internalUser } = useAuth()

const entries = ref<CatalogEntry[]>([])
const loading = ref(true)
const error = ref('')

const q = ref('')
const purpose = ref('')
const topic = ref('')
const kind = ref('')
const group = ref(DEFAULT_GROUP)
/** P6-5: not a chip — a link. The attention panel's rows open this page
 *  narrowed to one queue, and the only way out of it is Clear. */
const attention = ref('')

// --- Who may see the queue ---------------------------------------------------

/**
 * Who dropped this, by username.
 *
 * P6-5a: the list row carries `uploadedBy` whichever door the entry came
 * through — an upload writes `uploadedBy`, a dropped link writes `linkedBy`,
 * and the server folds the two into one key. `linkedBy` is read as well so
 * this answers correctly for a whole manifest (the entry page's shape) too.
 */
function droppedBy(entry: CatalogEntry): string {
  for (const field of ['uploadedBy', 'linkedBy'] as const) {
    const value = entry.meta?.[field]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/**
 * The spec's rule: an unfiled drop is shown to the person who dropped it and
 * to admins, and to nobody else.
 *
 * P6-5a scopes this server-side as well, so a member's catalog no longer even
 * contains another member's queue rows. This stays because the rule has to
 * hold for whatever the client is holding — a cached catalog from before a
 * logout, say — and because a browser that decides what to show from the data
 * it has is easier to reason about than one that trusts the wire.
 */
function canSeeQueueRow(entry: CatalogEntry, user: InternalUser | null): boolean {
  if (!user) return false
  if (user.role === 'admin') return true
  return droppedBy(entry) === user.username
}

// --- The rows ----------------------------------------------------------------

function rowFor(entry: CatalogEntry): DocRow {
  const purposeId = purposeOf(entry) ?? ''
  const topicId = topicOf(entry) ?? ''
  const description = typeof entry.meta?.description === 'string' ? entry.meta.description : ''
  return {
    key: `${entry.kind}:${entry.slug}`,
    title: entry.title,
    href: entryHref(entry),
    kind: entry.kind,
    kindLabel: kindLabel(entry.kind),
    purpose: purposeId,
    purposeLabel: purposeLabelOf(entry),
    topic: topicId,
    topicLabel: topicLabelOf(entry),
    updatedAt: entry.updatedAt ?? '',
    when: relativeTime(entry.updatedAt),
    line: description,
    search: [entry.title, entry.slug, entry.category, entry.tags.join(' '), description].join(' '),
    isQueue: entry.kind === 'incoming',
    attention: attentionKeysFor(entry),
    needsALook: needsALookNote(entry),
    entry,
  }
}

/** Recently updated first — a docs list is read for what moved. Rows with no
 *  stamp sort last rather than pretending to be from 1970. */
function newestFirst(rows: DocRow[]): DocRow[] {
  return [...rows].sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0
    return bt - at || a.title.localeCompare(b.title)
  })
}

const allRows = computed<DocRow[]>(() =>
  newestFirst(
    entries.value
      .filter(entry => DOC_KINDS.includes(entry.kind) && entry.status !== 'archived')
      .filter(entry => entry.kind !== 'incoming' || canSeeQueueRow(entry, internalUser.value))
      .map(rowFor),
  ),
)

// --- Filtering ---------------------------------------------------------------

function passes(row: DocRow, skip: string): boolean {
  if (attention.value && !row.attention.includes(attention.value)) return false
  if (skip !== 'q' && !matchesQuery(row.search, q.value)) return false
  if (skip !== 'purpose' && !matchesFilter(row.purpose, purpose.value)) return false
  if (skip !== 'topic' && !matchesFilter(row.topic, topic.value)) return false
  if (skip !== 'kind' && !matchesFilter(row.kind, kind.value)) return false
  return true
}

const visibleRows = computed(() => allRows.value.filter(row => passes(row, '')))

/** P6-33/P6-34: the field detail and its actions belong on the list that
 *  queue opens, and nowhere else — a browse list is not a place to be asked
 *  to decide things. */
const showNeedsALook = computed(() => isNeedsALookKey(attention.value))

const byPurpose = (row: DocRow): GroupKey => ({ id: row.purpose, label: row.purposeLabel || 'No purpose' })
const byTopic = (row: DocRow): GroupKey => ({ id: row.topic, label: row.topicLabel || 'No topic' })
const byKind = (row: DocRow): GroupKey => ({ id: row.kind, label: KIND_HEADINGS[row.kind] ?? row.kindLabel })

const groupKeyOf = computed(() => (group.value === 'topic' ? byTopic : group.value === 'kind' ? byKind : byPurpose))

/** The queue first, then everything else under the chosen grouping. */
const groups = computed<BrowseGroup<DocRow>[]>(() => {
  const queue = visibleRows.value.filter(row => row.isQueue)
  const rest = groupRows(
    visibleRows.value.filter(row => !row.isQueue),
    groupKeyOf.value,
  )
  if (!queue.length) return rest
  return [{ id: QUEUE_GROUP_ID, label: QUEUE_LABEL, count: queue.length, rows: queue }, ...rest]
})

const purposeFacets = computed(() =>
  facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'purpose')), byPurpose, purpose.value),
)
const topicFacets = computed(() => facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'topic')), byTopic, topic.value))
const kindFacets = computed(() => facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'kind')), byKind, kind.value))

/** The banner's words while the page is narrowed to one queue. */
const queueLabel = computed(() => attentionLabel(attention.value))

/**
 * How many of this queue's rows are in the OTHER browser.
 *
 * P6-23's invariant is that a count never disagrees with the list it opens,
 * and `attentionHref` can only send a queue to ONE browser — it picks by
 * majority. Before P6-33 that was survivable because each metadata row
 * happened to be all-docs or all-datasets; the roll-up mixes them, so "14
 * Needs a look" opened a list of 12 and said nothing about the other two.
 *
 * Rather than split the row back up or shrink the count to whatever one
 * browser can show, the list accounts for the difference and offers the way
 * to it. The same shortfall was already latent for every mixed queue —
 * `needs-review` can span both kinds too — so this fixes more than the new row.
 */
const elsewhere = computed(() => {
  if (!attention.value) return 0
  return entries.value.filter(
    entry =>
      entry.status !== 'archived' && !DOC_KINDS.includes(entry.kind) && attentionKeysFor(entry).includes(attention.value),
  ).length
})

const hasFilters = computed(() => !!(q.value || purpose.value || topic.value || kind.value || attention.value))

function clearFilters(): void {
  q.value = ''
  purpose.value = ''
  topic.value = ''
  kind.value = ''
  attention.value = ''
}

// --- The URL -----------------------------------------------------------------

function applyRoute(): void {
  q.value = queryValue(route.query, 'q')
  purpose.value = queryValue(route.query, 'purpose')
  topic.value = queryValue(route.query, 'topic')
  kind.value = queryValue(route.query, 'kind')
  attention.value = queryValue(route.query, 'attention')
  group.value = resolveChoice(
    queryValue(route.query, 'group'),
    readStoredChoice(GROUP_KEY, GROUP_IDS, DEFAULT_GROUP),
    GROUP_IDS,
    DEFAULT_GROUP,
  )
}

applyRoute()
watch(() => route.query, applyRoute)

watch([q, purpose, topic, kind, attention, group], () => {
  void router.replace({
    query: browseQuery({
      q: q.value,
      purpose: purpose.value,
      topic: topic.value,
      kind: kind.value,
      attention: attention.value,
      group: group.value,
    }),
  })
})

function pickGroup(next: string): void {
  group.value = next
  writeStoredChoice(GROUP_KEY, next)
}

// --- Loading -----------------------------------------------------------------

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    entries.value = await fetchCatalog({ archived: true }, fresh => {
      entries.value = fresh
    })
  } catch (err: unknown) {
    error.value = friendlyError(err, 'The documents did not load. Try again in a moment.')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="docs-view">
    <div class="docs-panel">
      <KbNav />
      <header class="docs-header">
        <h1>Docs</h1>
        <p class="lede">Pages, documents and notes — what we have written down, and what is still waiting to be filed.</p>
      </header>

      <!-- P6-5: the one thing the retired pages index did that nothing else
           does. `/wiki?new=1` redirects here, so the old link still opens it
           focused. -->
      <NewPageForm />

      <input
        v-model="q"
        type="search"
        class="search-input"
        placeholder="Search pages, documents and notes…"
        aria-label="Search the documents"
        data-testid="docs-search"
      />

      <FilterChips
        v-model="purpose"
        :facets="purposeFacets"
        label="Filter by purpose"
        all-label="Any purpose"
        data-testid="purpose-chips"
      />
      <FilterChips v-model="topic" :facets="topicFacets" label="Filter by topic" all-label="All topics" data-testid="topic-chips" />
      <FilterChips v-model="kind" :facets="kindFacets" label="Filter by kind" all-label="All kinds" data-testid="kind-chips" />

      <GroupControl :model-value="group" :options="GROUPS" label="Group the documents by" @update:model-value="pickGroup" />

      <!-- P6-5: arrived from the attention panel. Say which queue this is, and
           offer the way out — the chips above cannot express it. -->
      <p v-if="queueLabel" class="queue-note" data-testid="docs-queue-note">
        Showing one queue: <strong>{{ queueLabel }}</strong>.
        <!-- P6-23's invariant: the count on the landing has to be accounted
             for, and a queue that spans both browsers can only link to one. -->
        <RouterLink v-if="elsewhere" :to="`/datasets?attention=${attention}`" data-testid="docs-queue-elsewhere">
          {{ elsewhere }} more {{ elsewhere === 1 ? 'is' : 'are' }} in the datasets browser
        </RouterLink>
        <button type="button" class="link-btn" @click="attention = ''">Show everything</button>
      </p>

      <ul v-if="loading" class="row-list skeleton" aria-busy="true" aria-label="Loading documents" data-testid="docs-loading">
        <li v-for="n in 4" :key="n" class="doc-row doc-row--skeleton">
          <span class="sk sk-title"></span><span class="sk sk-meta"></span>
        </li>
      </ul>
      <p v-else-if="error" class="state-note error" data-testid="docs-error">{{ error }}</p>
      <p v-else-if="visibleRows.length === 0" class="state-note empty" data-testid="docs-empty">
        <template v-if="hasFilters">
          Nothing matches these filters.
          <button type="button" class="link-btn" @click="clearFilters">Clear filters</button>
        </template>
        <template v-else>Nothing written down yet — start a page or drop a document.</template>
      </p>

      <GroupedList v-else :groups="groups" noun="item" noun-plural="items" :row-key="(row: DocRow) => row.key">
        <template #row="{ row }">
          <RouterLink :to="row.href" class="doc-row" data-testid="doc-row">
            <div class="row-title-line">
              <span class="row-title">{{ row.title }}</span>
              <span class="badge kind" :class="`kind-${row.kind}`" data-testid="row-kind">{{ row.kindLabel }}</span>
            </div>
            <div class="row-meta-line">
              <span v-if="row.purposeLabel" class="chip purpose-chip" data-testid="row-purpose">{{ row.purposeLabel }}</span>
              <span v-if="row.topicLabel" class="chip topic-chip" data-testid="row-topic">{{ row.topicLabel }}</span>
              <span v-if="row.when" class="row-when" data-testid="row-when">{{ row.when }}</span>
            </div>
            <p v-if="row.line" class="row-line" data-testid="row-line">{{ row.line }}</p>
            <!-- P6-33: which fields, and which case. Four rows reading
                 12 / 2 / 0 / 0 became one row of 14 entries; this is what
                 keeps that lossless. -->
            <p v-if="row.needsALook" class="row-gap-line" data-testid="row-needs-a-look">{{ row.needsALook }}</p>
          </RouterLink>
          <!-- Outside the link, deliberately: these are buttons, and a button
               inside a link navigates instead of acting. -->
          <NeedsALookNote v-if="showNeedsALook" :entry="row.entry" :queue-key="attention" @changed="load" />
        </template>
      </GroupedList>
    </div>
  </div>
</template>

<style scoped>
.docs-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
  /* P5-60, the page-overflow fix — see DatasetsView for the long version. */
  min-width: 0;
}

.docs-panel {
  width: 100%;
  max-width: 820px;
  min-width: 0;
}

.docs-header h1 {
  margin: 0 0 6px;
  font-family: var(--blo-font-display);
  font-size: 1.7rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.lede {
  margin: 0 0 16px;
  font-size: 14px;
  color: var(--blo-stone);
}

.search-input {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 12px;
  padding: 7px 10px;
  font-size: 14px;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.state-note {
  font-size: 14px;
  color: var(--blo-stone);
}

.row-gap-line {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--blo-orange-deep, #e65100);
  min-width: 0;
  overflow-wrap: anywhere;
}

.queue-note {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b3261e;
}

.link-btn {
  border: none;
  background: none;
  color: var(--blo-green-deep);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

.row-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.doc-row {
  display: block;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  text-decoration: none;
  color: inherit;
  transition: box-shadow 120ms ease;
}

.doc-row:hover {
  box-shadow: var(--blo-shadow-panel);
}

.doc-row--skeleton {
  pointer-events: none;
  min-height: 62px;
}

.sk {
  display: block;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--blo-cream-deep) 25%, #fff 50%, var(--blo-cream-deep) 75%);
  background-size: 200% 100%;
  animation: sk-shimmer 1.2s infinite;
}

.sk-title {
  width: 55%;
  height: 14px;
  margin-bottom: 8px;
}

.sk-meta {
  width: 35%;
  height: 10px;
}

@keyframes sk-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.row-title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.row-title {
  font-weight: 600;
  font-size: 15px;
  color: var(--blo-ink);
}

.row-meta-line {
  margin-top: 6px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.badge {
  padding: 1px 8px;
  font-size: 12px;
  border-radius: 999px;
  border: 1px solid var(--blo-cream-divider);
  color: var(--blo-stone);
  background: rgba(17, 17, 17, 0.03);
}

.badge.kind-wiki {
  color: #1b5e20;
  border-color: #a5d6a7;
  background: #e8f5e9;
  font-weight: 600;
}

/* A drop nobody has filed: the same blue the library list gives the queue. */
.badge.kind-incoming {
  color: #0d47a1;
  border-color: #90caf9;
  background: #e3f2fd;
  font-weight: 600;
}

.chip {
  padding: 1px 8px;
  font-size: 12px;
  color: var(--blo-stone);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 999px;
}

.row-when {
  font-size: 12px;
  color: var(--blo-stone);
}

.row-line {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

/* --- Phone (P5-60) -------------------------------------------------------- */
@media (max-width: 640px) {
  .docs-view {
    padding: 20px 12px 40px;
  }

  .docs-view,
  .docs-panel,
  .docs-header {
    min-width: 0;
    max-width: 100%;
  }

  .docs-header h1 {
    font-size: clamp(20px, 6.5vw, 1.7rem);
  }

  .search-input {
    min-height: 44px;
    /* 16 px is the size below which iOS Safari zooms the page on focus. */
    font-size: 16px;
  }

  .lede,
  .state-note,
  .row-meta-line,
  .row-line,
  .row-when {
    font-size: 14px;
  }

  .badge,
  .chip {
    font-size: 13px;
  }
}
</style>
