<script setup lang="ts">
/**
 * The datasets browser (P6-3).
 *
 * One list of every dataset-shaped thing the library knows about, whether we
 * hold it, only index it, or draw it on the map:
 *
 *  - **held datasets** (`kind: dataset`) — a table in the bucket;
 *  - **indexed sources** (`kind: source`) — a dataset we point at, fetched on
 *    demand for a place;
 *  - **public map layers** — the registry the map draws from, which had no
 *    home in the knowledge base outside `/layers`;
 *  - **internal map layers** — a held dataset's own layer.
 *
 * The last of those is deliberately NOT a fourth row. An internal layer is a
 * held dataset with a `layer` block: listing both would put the same thing on
 * the page twice under two names, and pressing either opens the same entry.
 * So a held dataset that is also drawn carries a **Map layer** badge, is found
 * by the "Map layers" chip, and needs no request of its own — `layerIdForEntry`
 * reads the block's presence off the list row the page already has.
 *
 * Grouped by **Organization** (the default), **Topic**, **Type** or
 * **Geography**, because those are the four questions a researcher actually
 * arrives with: who publishes it, what is it about, what shape is it in, and
 * where does it apply. The choice is remembered per browser and can be
 * overridden by a link.
 *
 * P6-19 added the fourth. "What do we hold for Georgia?" is the most natural
 * question a place-based organization asks of its own library and the page
 * could not answer it — so a dataset covering several states is found under
 * each of their chips, while a NATIONWIDE one is under National and under no
 * single state's, which is what keeps the answer about Georgia.
 *
 * P7-1 added a fifth filter, and it is the only one that is not a property of
 * the row: **which working set a dataset is in**. A set is "these datasets,
 * together, for this purpose", so narrowing to one turns this page into that
 * project's sourcing checklist — *9 of 11 held, 2 could not be reached* — and
 * the progress line counts exactly the rows the chip opens, which is P6-23's
 * rule. The existing attention queues scoped to a set ARE the progress: there
 * is deliberately no second vocabulary for "this member needs work".
 *
 * Every filter and the grouping ride in the URL, so any view of this page is
 * a link somebody can be sent. `group` is written even when it is the default:
 * without it, a colleague whose browser remembers "Topic" would open the link
 * grouped differently from the person who sent it.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import GroupControl from '@/components/browse/GroupControl.vue'
import GroupedList from '@/components/browse/GroupedList.vue'
import FilterChips from '@/components/browse/FilterChips.vue'
import { organizationLabel, organizationParent } from '@/config/organizations'
import {
  browseQuery,
  facetsFor,
  groupRows,
  matchesAnyFilter,
  matchesFilter,
  matchesQuery,
  queryValue,
  readStoredChoice,
  resolveChoice,
  writeStoredChoice,
  type GroupKey,
} from '@/lib/browse'
import {
  coverageChipsOf,
  coverageGroupOf,
  coverageKeysOf,
  coverageOf,
  fetchCatalog,
  layerIdForEntry,
  organizationLabelOf,
  organizationOf,
  readinessLine,
  shapeLabelOf,
  shapeOf,
  sourceOf,
  topicLabelOf,
  topicOf,
  SOURCE_BADGE,
  type CatalogEntry,
  type Coverage,
} from '@/lib/libraryCatalog'
import { attentionKeysFor, attentionLabel, entryHref, isNeedsALookKey, needsALookNote } from '@/lib/kb'
import {
  fetchWorkingSets,
  progressLine,
  workingSetIdsOf,
  workingSetKeysOf,
  workingSetPlaceHref,
  workingSetProgress,
  type WorkingSetSummary,
} from '@/lib/workingSets'
import NeedsALookNote from '@/components/browse/NeedsALookNote.vue'
import {
  layerAboutHref,
  layerOrganization,
  layerOrganizationLabel,
  publicLayerShapeLabel,
  publicLayers,
  PUBLIC_LAYER_COVERAGE,
  PUBLIC_LAYER_SHAPE,
} from '@/lib/publicLayers'
import { topicForLayerCategory, topicLabel } from '@/config/taxonomy'
import { friendlyError } from '@/lib/errors'

/** How this browser remembers the grouping you last chose. */
const GROUP_KEY = 'blo:datasets-group'
const GROUPS = [
  { id: 'organization', label: 'Organization' },
  { id: 'topic', label: 'Topic' },
  { id: 'type', label: 'Type' },
  { id: 'geography', label: 'Geography' },
]
const GROUP_IDS = GROUPS.map(g => g.id)
const DEFAULT_GROUP = 'organization'

/** What a row is, whatever it came from. */
interface DatasetRow {
  key: string
  title: string
  href: string
  /** The badge that says where it lives: held, indexed, or drawn. */
  badge: string
  /** The readiness chip this row answers to. */
  readiness: 'held' | 'indexed' | 'layers'
  /** A held dataset that is also drawn on the map. */
  hasLayer: boolean
  organization: string
  organizationLabel: string
  topic: string
  topicLabel: string
  shape: string
  shapeLabel: string
  /**
   * P6-19: where it applies, and the values its filter compares.
   *
   * The `coverage` object is the single field all three readers read — the
   * chips, the Geography heading and the filter. `coverageKeys` is the only
   * thing precomputed, because `passes` runs it for every row on every
   * keystroke, the same reason `attention` is carried rather than derived.
   */
  coverage: Coverage | null
  coverageKeys: string[]
  /**
   * P7-1: the working sets this row is in, and the ids its filter compares.
   *
   * MULTI-VALUED like coverage — a dataset eleven projects depend on belongs
   * under all eleven chips — and carried on the row rather than recomputed,
   * for the same reason `attention` is: `passes` runs it for every row on
   * every keystroke.
   */
  workingSets: GroupKey[]
  workingSetIds: string[]
  /** The one line under the title — the readiness verdict, or what a layer
   *  measures. '' when there is nothing honest to say. */
  line: string
  /** Everything the text box searches. */
  search: string
  /**
   * P6-5: the admin queues this row is on (see `lib/kb`). Carried on the row
   * rather than recomputed, so `?attention=…` is one array lookup per row and
   * the list a queue opens is exactly the set its count came from. A registry
   * layer is on no queue — it has no manifest to be missing anything.
   */
  attention: string[]
  /** P6-33: which fields this row needs a look at — "no topic · no coverage".
   *  The per-row line that makes the collapse lossless. */
  needsALook: string
  /** P6-34: the row's own entry, for the Keep / Edit / Clear actions. Null for
   *  a public map layer, which has no manifest. */
  entry: CatalogEntry | null
}

const READINESS_CHOICES = [
  { id: 'held', label: 'Held' },
  { id: 'indexed', label: 'Indexed' },
  { id: 'layers', label: 'Map layers' },
]

const route = useRoute()
const router = useRouter()

const entries = ref<CatalogEntry[]>([])
/** P7-1. Loaded beside the catalog and allowed to fail on its own: a bucket
 *  that is briefly unhappy about working sets must not cost the datasets
 *  list, which is what this page is for. */
const workingSets = ref<WorkingSetSummary[]>([])
const loading = ref(true)
const error = ref('')

const q = ref('')
const readiness = ref('')
const organization = ref('')
const topic = ref('')
const type = ref('')
/** P6-19: one key for one chip row. It takes a state (`GA`), `national`, a
 *  scope word the chat may send (`multi-state`), or `none` — all answers to
 *  the one question "where does this apply?". */
const coverage = ref('')
/** P7-1: one working set's members, or `none` for the datasets no set names. */
const workingSet = ref('')
const group = ref(DEFAULT_GROUP)
/** P6-5: not a chip — a link. The attention panel's rows open this page
 *  narrowed to one queue, and the only way out of it is Clear. */
const attention = ref('')

// --- The rows ----------------------------------------------------------------

/** A held dataset or an indexed source, as a row. */
function rowForEntry(entry: CatalogEntry): DatasetRow {
  const held = entry.kind === 'dataset'
  const hasLayer = !!layerIdForEntry(entry)
  const source = sourceOf(entry)
  const organizationLabel = organizationLabelOf(entry)
  const topicId = topicOf(entry) ?? ''
  const shape = shapeOf(entry)
  return {
    key: `${entry.kind}:${entry.slug}`,
    title: entry.title,
    href: entryHref(entry),
    badge: held ? 'Held' : SOURCE_BADGE,
    readiness: held ? 'held' : 'indexed',
    hasLayer,
    organization: organizationOf(entry),
    organizationLabel,
    topic: topicId,
    topicLabel: topicLabelOf(entry),
    shape,
    shapeLabel: shapeLabelOf(entry),
    coverage: coverageOf(entry),
    coverageKeys: coverageKeysOf(entry),
    workingSets: workingSetKeysOf(entry.slug, workingSets.value),
    workingSetIds: workingSetIdsOf(entry.slug, workingSets.value),
    line: entry.readiness ? readinessLine(entry.readiness) : '',
    search: [
      entry.title,
      entry.slug,
      entry.category,
      entry.tags.join(' '),
      typeof entry.meta.description === 'string' ? entry.meta.description : '',
      source?.provider ?? '',
      organizationLabel,
      topicLabelOf(entry),
      shapeLabelOf(entry),
      // P6-19: so typing "georgia" finds the Georgia datasets, and typing a
      // state we only hold through a multi-state table finds that table.
      coverageChipsOf(entry)
        .map(chip => chip.label)
        .join(' '),
      entry.coverage?.label ?? '',
    ].join(' '),
    attention: attentionKeysFor(entry),
    needsALook: needsALookNote(entry),
    entry,
  }
}

/** A public map layer, as a row. The registry has no readiness verdict — it
 *  is drawn, which is the whole answer — so the line is what it measures. */
function rowForLayer(layer: ReturnType<typeof publicLayers>[number]): DatasetRow {
  const organizationLabel = layerOrganizationLabel(layer)
  const topicId = topicForLayerCategory(layer.category) ?? ''
  const shapeLabel = publicLayerShapeLabel()
  return {
    key: `layer:${layer.id}`,
    title: layer.name,
    href: layerAboutHref(layer.id),
    badge: 'Map layer',
    readiness: 'layers',
    hasLayer: true,
    organization: layerOrganization(layer),
    organizationLabel,
    topic: topicId,
    topicLabel: topicId ? topicLabel(topicId) : '',
    shape: PUBLIC_LAYER_SHAPE,
    shapeLabel,
    // P6-19 rule 5: a county value for every county in the country.
    coverage: PUBLIC_LAYER_COVERAGE,
    coverageKeys: coverageKeysOf({ coverage: PUBLIC_LAYER_COVERAGE }),
    // A registry layer has no catalog slug, so it is in no set — and it is
    // found by the "In no working set" chip, like any uncurated dataset.
    workingSets: workingSetKeysOf('', workingSets.value),
    workingSetIds: workingSetIdsOf('', workingSets.value),
    line: layer.description,
    search: [
      layer.name,
      layer.description,
      organizationLabel,
      topicId ? topicLabel(topicId) : '',
      shapeLabel,
      PUBLIC_LAYER_COVERAGE.label,
    ].join(' '),
    attention: [],
    needsALook: '',
    entry: null,
  }
}

const allRows = computed<DatasetRow[]>(() => [
  ...entries.value
    .filter(e => (e.kind === 'dataset' || e.kind === 'source') && e.status !== 'archived')
    .map(rowForEntry),
  ...publicLayers().map(rowForLayer),
])

// --- Filtering ---------------------------------------------------------------

/** The "Map layers" chip means "can be drawn", which is true of a registry
 *  row AND of a held dataset carrying a layer block. */
function matchesReadiness(row: DatasetRow, filter: string): boolean {
  if (!filter) return true
  if (filter === 'layers') return row.readiness === 'layers' || row.hasLayer
  return row.readiness === filter
}

/** Every filter but one. Counting a chip's rows with that chip's own filter
 *  applied would make every count either the whole list or zero. */
function passes(row: DatasetRow, skip: string): boolean {
  if (attention.value && !row.attention.includes(attention.value)) return false
  if (skip !== 'q' && !matchesQuery(row.search, q.value)) return false
  if (skip !== 'readiness' && !matchesReadiness(row, readiness.value)) return false
  if (skip !== 'organization' && !matchesFilter(publisherOf(row).id, organization.value)) return false
  if (skip !== 'topic' && !matchesFilter(row.topic, topic.value)) return false
  if (skip !== 'type' && !matchesFilter(row.shape, type.value)) return false
  // P6-19: ANY of the row's coverage values, because a row can be under
  // several state chips at once. The same values the chips are counted from.
  if (skip !== 'coverage' && !matchesAnyFilter(row.coverageKeys, coverage.value)) return false
  // P7-1: ANY of the sets the row is in, counted off the same values.
  if (skip !== 'workingSet' && !matchesAnyFilter(row.workingSetIds, workingSet.value)) return false
  return true
}

const visibleRows = computed(() => allRows.value.filter(row => passes(row, '')))

/**
 * The publisher a row is filed under (P6-25).
 *
 * A sub-unit is filed under its parent agency: the spec's own example groups
 * `USDA · 6`, not four shards of two. `organizationParent` was modelled in
 * P6-1 and then called from nowhere, so USDA arrived as four groups that each
 * sank down the count-sorted order. Unknown free text has no parent and is
 * left exactly as it was written. The ROW still names its sub-unit — only the
 * heading and the chip roll up — and the sub-unit label stays in the row's
 * search text, so "NASS" still finds it.
 */
function publisherOf(row: DatasetRow): GroupKey {
  const parent = row.organization ? organizationParent(row.organization) : null
  if (parent) return { id: parent, label: organizationLabel(parent) }
  return { id: row.organization, label: row.organizationLabel || 'No organization' }
}

const byOrganization = (row: DatasetRow): GroupKey => publisherOf(row)
const byTopic = (row: DatasetRow): GroupKey => ({ id: row.topic, label: row.topicLabel || 'No topic' })
const byType = (row: DatasetRow): GroupKey => ({ id: row.shape, label: row.shapeLabel || 'No type' })
/**
 * P6-19. The CHIPS are multi-valued (a four-state table is under four of
 * them); the HEADING cannot be, or a row would be counted four times in a
 * list of twelve — so `coverageGroupOf` picks the one that reads best: the
 * state's own name when one state names it, "Several states" when more do.
 * Both read the row's single `coverage` field, which is what keeps the
 * Georgia heading and the Georgia chip the same thing.
 */
const byCoverage = (row: DatasetRow): GroupKey[] => coverageChipsOf(row)
const byWorkingSet = (row: DatasetRow): GroupKey[] => row.workingSets
const byGeography = (row: DatasetRow): GroupKey => coverageGroupOf(row)

const groupKeyOf = computed(() =>
  group.value === 'topic' ? byTopic : group.value === 'type' ? byType : group.value === 'geography' ? byGeography : byOrganization,
)

const groups = computed(() => groupRows(visibleRows.value, groupKeyOf.value))

const readinessFacets = computed(() => {
  const rows = allRows.value.filter(row => passes(row, 'readiness'))
  return READINESS_CHOICES.map(choice => ({
    ...choice,
    count: rows.filter(row => matchesReadiness(row, choice.id)).length,
  })).filter(facet => facet.count > 0 || facet.id === readiness.value)
})
const organizationFacets = computed(() =>
  facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'organization')), byOrganization, organization.value),
)
const topicFacets = computed(() => facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'topic')), byTopic, topic.value))
const typeFacets = computed(() => facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'type')), byType, type.value))
const coverageFacets = computed(() =>
  facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'coverage')), byCoverage, coverage.value),
)
/** P7-1. `facetsFor` keeps the chosen chip visible at its true count of 0,
 *  which matters more here than anywhere: a set whose last member was just
 *  filed out from under the other filters must still be un-narrowable. */
const workingSetFacets = computed(() =>
  facetsFor(allRows.value, allRows.value.filter(row => passes(row, 'workingSet')), byWorkingSet, workingSet.value),
)

/**
 * P7-1: the set this page is narrowed to, and how its sourcing is going.
 *
 * Counted off the SET's own member list rather than off the visible rows, so
 * the denominator is what the set NAMES — a set of eleven whose twelfth member
 * was archived reads "9 of 11 held · 1 no longer in the library", not a tidy
 * ten. That is the honest number and the one worth acting on.
 */
const narrowedSet = computed<WorkingSetSummary | null>(
  () => workingSets.value.find(set => set.slug === workingSet.value) ?? null,
)
const setProgress = computed(() =>
  narrowedSet.value ? progressLine(workingSetProgress(narrowedSet.value, entries.value)) : '',
)

/** The banner's words while the page is narrowed to one queue. */
const queueLabel = computed(() => attentionLabel(attention.value))

/**
 * How many of this queue's rows are in the OTHER browser.
 *
 * P6-23's invariant is that a count never disagrees with the list it opens,
 * and `attentionHref` can only send a queue to ONE browser — it picks by
 * majority. P6-33's roll-up mixes datasets and documents, so the list has to
 * account for the difference and offer the way to it rather than silently
 * showing fewer rows than the panel counted.
 */
const elsewhere = computed(() => {
  if (!attention.value) return 0
  return entries.value.filter(
    entry =>
      entry.status !== 'archived' &&
      entry.kind !== 'dataset' &&
      entry.kind !== 'source' &&
      attentionKeysFor(entry).includes(attention.value),
  ).length
})

/** P6-33/P6-34: the field detail and its actions belong on the list that
 *  queue opens, and nowhere else — a browse list is not a place to be asked
 *  to decide things. */
const showNeedsALook = computed(() => isNeedsALookKey(attention.value))

const hasFilters = computed(
  () =>
    !!(
      q.value ||
      readiness.value ||
      organization.value ||
      topic.value ||
      type.value ||
      coverage.value ||
      workingSet.value ||
      attention.value
    ),
)

function clearFilters(): void {
  q.value = ''
  readiness.value = ''
  organization.value = ''
  topic.value = ''
  type.value = ''
  coverage.value = ''
  workingSet.value = ''
  attention.value = ''
}

// --- The URL -----------------------------------------------------------------

/** The URL is the truth on arrival, and on every later navigation (the back
 *  button, a link pressed inside the page). The remembered grouping only
 *  answers when the URL says nothing. */
function applyRoute(): void {
  q.value = queryValue(route.query, 'q')
  readiness.value = queryValue(route.query, 'readiness')
  organization.value = queryValue(route.query, 'organization')
  topic.value = queryValue(route.query, 'topic')
  type.value = queryValue(route.query, 'type')
  // P6-19: `state=GA` is the server's and MCP's spelling of the same filter,
  // honoured here so a link from the chat opens the page it describes.
  coverage.value = queryValue(route.query, 'coverage') || queryValue(route.query, 'state')
  workingSet.value = queryValue(route.query, 'workingSet')
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

// Writing back is `replace`, not `push`: narrowing a list is not a place in
// history, and a Back press should leave the page rather than undo a chip.
watch([q, readiness, organization, topic, type, coverage, workingSet, attention, group], () => {
  void router.replace({
    query: browseQuery({
      q: q.value,
      readiness: readiness.value,
      organization: organization.value,
      topic: topic.value,
      type: type.value,
      coverage: coverage.value,
      workingSet: workingSet.value,
      attention: attention.value,
      group: group.value,
    }),
  })
})

/** Only a press remembers. Opening somebody else's link is a visit, not a
 *  change of mind about how you like to read this page. */
function pickGroup(next: string): void {
  group.value = next
  writeStoredChoice(GROUP_KEY, next)
}

// --- Loading -----------------------------------------------------------------

/** The whole catalog, archived rows included — the one query every internal
 *  page shares (P5-89), so this page usually costs no request at all. */
async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  // P7-1: the sets are ONE FILTER ROW; the catalog IS the page. So the list
  // never waits on them and never fails with them — a bucket that is briefly
  // unhappy about working sets costs the chip row and nothing else. (Awaiting
  // both together held the whole list behind the slower of the two, which is
  // the wrong trade for a filter.)
  void fetchWorkingSets()
    .then(sets => {
      workingSets.value = sets
    })
    .catch(() => {
      workingSets.value = []
    })
  try {
    entries.value = await fetchCatalog({ archived: true }, fresh => {
      entries.value = fresh
    })
  } catch (err: unknown) {
    error.value = friendlyError(err, 'The datasets did not load. Try again in a moment.')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="datasets-view">
    <div class="datasets-panel">
      <KbNav />
      <header class="datasets-header">
        <h1>Datasets</h1>
        <p class="lede">
          Everything with rows in it — the tables we hold, the sources we index and fetch on demand, and the layers
          the map draws.
        </p>
      </header>

      <input
        v-model="q"
        type="search"
        class="search-input"
        placeholder="Search datasets by name, publisher or subject…"
        aria-label="Search the datasets"
        data-testid="datasets-search"
      />

      <GroupControl :model-value="group" :options="GROUPS" label="Group the datasets by" @update:model-value="pickGroup" />

      <FilterChips
        v-model="readiness"
        :facets="readinessFacets"
        label="Filter by what we hold"
        all-label="Everything"
        data-testid="readiness-chips"
      />
      <FilterChips
        v-model="organization"
        :facets="organizationFacets"
        label="Filter by publisher"
        all-label="All publishers"
        data-testid="organization-chips"
      />
      <FilterChips v-model="topic" :facets="topicFacets" label="Filter by topic" all-label="All topics" data-testid="topic-chips" />
      <FilterChips v-model="type" :facets="typeFacets" label="Filter by type" all-label="All types" data-testid="type-chips" />
      <FilterChips
        v-model="coverage"
        :facets="coverageFacets"
        label="Filter by where it applies"
        all-label="Anywhere"
        data-testid="coverage-chips"
      />
      <!-- P7-1. Only drawn once there is a set to press: a chip row offering
           nothing but "Every dataset" is a control that does nothing. -->
      <FilterChips
        v-if="workingSets.length"
        v-model="workingSet"
        :facets="workingSetFacets"
        label="Filter by working set"
        all-label="Every dataset"
        data-testid="working-set-chips"
      />

      <!-- P7-1: narrowed to one set, so this page is that project's sourcing
           checklist. The counts come off the set's own member list, which is
           what the chip opened — so the line and the list agree. -->
      <p v-if="narrowedSet" class="set-note" data-testid="working-set-note">
        <strong>{{ narrowedSet.name }}</strong>
        <span class="set-progress" data-testid="working-set-progress">{{ setProgress }}</span>
        <span v-if="narrowedSet.purpose" class="set-purpose">{{ narrowedSet.purpose }}</span>
        <RouterLink :to="workingSetPlaceHref(narrowedSet.slug)" data-testid="working-set-place">
          Check a place in this set
        </RouterLink>
      </p>

      <!-- P6-5: arrived from the attention panel. Say which queue this is, and
           offer the way out — the chips above cannot express it. -->
      <p v-if="queueLabel" class="queue-note" data-testid="datasets-queue-note">
        Showing one queue: <strong>{{ queueLabel }}</strong>.
        <!-- P6-23's invariant: the count on the landing has to be accounted
             for, and a queue that spans both browsers can only link to one. -->
        <RouterLink v-if="elsewhere" :to="`/docs?attention=${attention}`" data-testid="datasets-queue-elsewhere">
          {{ elsewhere }} more {{ elsewhere === 1 ? 'is' : 'are' }} in the docs browser
        </RouterLink>
        <button type="button" class="link-btn" @click="attention = ''">Show everything</button>
      </p>

      <ul v-if="loading" class="row-list skeleton" aria-busy="true" aria-label="Loading datasets" data-testid="datasets-loading">
        <li v-for="n in 4" :key="n" class="dataset-row dataset-row--skeleton">
          <span class="sk sk-title"></span><span class="sk sk-meta"></span>
        </li>
      </ul>
      <p v-else-if="error" class="state-note error" data-testid="datasets-error">{{ error }}</p>
      <p v-else-if="visibleRows.length === 0" class="state-note empty" data-testid="datasets-empty">
        <template v-if="hasFilters">
          Nothing matches these filters.
          <button type="button" class="link-btn" @click="clearFilters">Clear filters</button>
        </template>
        <template v-else>No datasets yet — nothing has been pushed or registered.</template>
      </p>

      <GroupedList
        v-else
        :groups="groups"
        noun="dataset"
        noun-plural="datasets"
        :row-key="(row: DatasetRow) => row.key"
      >
        <template #row="{ row }">
          <RouterLink :to="row.href" class="dataset-row" data-testid="dataset-row">
            <div class="row-title-line">
              <span class="row-title">{{ row.title }}</span>
              <span class="badge readiness" :class="`readiness-${row.readiness}`" data-testid="row-badge">{{ row.badge }}</span>
              <!-- A held dataset that is also drawn. The row stays one row:
                   both names open the same entry. -->
              <span v-if="row.hasLayer && row.readiness !== 'layers'" class="badge readiness readiness-layers" data-testid="row-layer-badge">
                Map layer
              </span>
            </div>
            <div class="row-meta-line">
              <span v-if="row.shapeLabel" class="chip type-chip" data-testid="row-type">{{ row.shapeLabel }}</span>
              <span v-if="row.topicLabel" class="chip topic-chip" data-testid="row-topic">{{ row.topicLabel }}</span>
              <span v-if="row.organizationLabel" class="row-publisher" data-testid="row-organization">{{ row.organizationLabel }}</span>
            </div>
            <p v-if="row.line" class="row-line" data-testid="row-line">{{ row.line }}</p>
            <!-- P6-33: which fields, and which case — what keeps one row in
                 place of four from losing anything. -->
            <p v-if="row.needsALook" class="row-gap-line" data-testid="row-needs-a-look">{{ row.needsALook }}</p>
          </RouterLink>
          <!-- Outside the link, deliberately: these are buttons, and a button
               inside a link navigates instead of acting. -->
          <NeedsALookNote v-if="showNeedsALook && row.entry" :entry="row.entry" :queue-key="attention" @changed="load" />
        </template>
      </GroupedList>
    </div>
  </div>
</template>

<style scoped>
.datasets-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
  /* P5-60, the page-overflow fix: a route root is a flex item of App.vue's
     `main`, and a flex item's automatic minimum size is its content's
     min-content width. Without this a long title scrolls the document. */
  min-width: 0;
}

.datasets-panel {
  width: 100%;
  max-width: 820px;
  min-width: 0;
}

.datasets-header h1 {
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

.set-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  margin: 0 0 12px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.set-progress {
  font-variant-numeric: tabular-nums;
  color: var(--blo-stone);
}

.set-purpose {
  flex-basis: 100%;
  color: var(--blo-stone);
}

.set-note a {
  color: inherit;
}

.state-note {
  font-size: 14px;
  color: var(--blo-stone);
}

/* P9-8: quiet, not orange. Two thirds of the library carries one of these,
   and a queue holding 68% of everything is not a queue — it is the
   background. Warning colour is for a value that is WRONG; these say a value
   is merely unconfirmed, and rendering the two the same trains people to read
   past both. */
.row-gap-line {
  margin: 4px 0 0;
  font-size: 12px;
  font-style: italic;
  color: var(--blo-stone);
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

.dataset-row {
  display: block;
  padding: 12px 14px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  text-decoration: none;
  color: inherit;
  transition: box-shadow 120ms ease;
}

.dataset-row:hover {
  box-shadow: var(--blo-shadow-panel);
}

.dataset-row--skeleton {
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

/* Held, indexed, drawn — three states in the same voice as the status badges
   on the library list, so the words mean one thing across the site. */
.badge.readiness-held {
  color: #1b5e20;
  border-color: #a5d6a7;
  background: #e8f5e9;
  font-weight: 600;
}

.badge.readiness-indexed {
  color: #4a3b76;
  border-color: #c5b8e6;
  background: #f1edfb;
  font-weight: 600;
}

.badge.readiness-layers {
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

.row-publisher {
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-stone);
}

.row-line {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

/* --- Phone (P5-60) ---------------------------------------------------------
   The page must not set its own width from a long dataset title, the search
   box must not zoom iOS on focus, and card meta stays at 14 px with the
   badges alone at 13 px. */
@media (max-width: 640px) {
  .datasets-view {
    padding: 20px 12px 40px;
  }

  .datasets-view,
  .datasets-panel,
  .datasets-header {
    min-width: 0;
    max-width: 100%;
  }

  .datasets-header h1 {
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
  .row-publisher {
    font-size: 14px;
  }

  .badge,
  .chip {
    font-size: 13px;
  }
}
</style>
