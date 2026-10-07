<script setup lang="ts">
/**
 * Catalog entry detail (P5-9): full meta + file list for one entry, plus the
 * "File this entry" form for incoming uploads (P5-11, Example 5).
 * File download links arrive with the file-serving API (Step 3).
 */
import { ref, watch, computed } from 'vue'
import { isSiteLayerId, siteLayerName } from '@/config/siteLayers'
import { friendlyError } from '@/lib/errors'
import { annotateAgain } from '@/lib/bulkDrop'
import { useRoute, useRouter } from 'vue-router'
import DatasetView from './DatasetView.vue'
import {
  fetchCatalogEntry,
  fileCatalogEntry,
  formatBytes,
  libraryFileUrl,
  layerIdForEntry,
  entryUrl,
  fetchViewsUsingLayer,
  fetchViewsOfWorkingSet,
  fetchMembersOfWorkingSet,
  type WorkingSetMemberRow,
  mentionedBy,
  linkOf,
  sourceOf,
  coversLine,
  datesOf,
  accessTypeLabel,
  accessAuthLabel,
  canFetchForPlace,
  replicationSummary,
  replicationDatasets,
  askQuestionForSource,
  emptySourceForm,
  sourceFormFrom,
  sourceFromForm,
  fetchStateOf,
  isFetchPending,
  suggestionOf,
  suggestedTitleOf,
  hasSuggestion,
  modelPassGap,
  readinessLine,
  refetchLink,
  createLinkEntry,
  inferredFormFields,
  topicLabelOf,
  purposeLabelOf,
  organizationLabelOf,
  shapeLabelOf,
  NOTE_STATUSES,
  type CatalogEntry,
  type ProposalResponse,
  type SourceFormState,
  type SourceMeta,
  type ViewRef,
} from '@/lib/libraryCatalog'
import { relativeTime } from '@/lib/kb'
import { fieldLabel, fieldValueOf, unverifiedFieldsOf } from '@/lib/provenance'
import { coversLabel, fetchedLabel, publishedLabel } from '@/lib/dataDates'
import NeedsALookNote from '@/components/browse/NeedsALookNote.vue'
import { ADMIN_REASON_TEXT } from '@/lib/ask'
import { useAuth } from '@/composables/useAuth'
import AskBox from '@/components/AskBox.vue'
import SourceFields from '@/components/SourceFields.vue'
import TaxonomyFields from '@/components/TaxonomyFields.vue'
import OrganizationShapeFields from '@/components/OrganizationShapeFields.vue'
import { organizationLabel } from '@/config/organizations'
import { shapeLabel } from '@/config/taxonomy'
import IngestPanel from '@/components/IngestPanel.vue'
import PlaceFetchPanel from '@/components/PlaceFetchPanel.vue'
import { hasTabularFile } from '@/lib/libraryData'
import { mapUrlForLayers } from '@/lib/mapDeepLinks'
import { mapHrefForInternalLayerId } from '@/lib/internalLayers'
import { isManifestFile, isViewable, loadDocumentText, primaryViewableFile } from '@/lib/documentView'
import { completeFirstRunStep } from '@/lib/firstRun'
import { getPublicLayer } from '@/lib/publicLayers'
import DocumentViewer from '@/components/DocumentViewer.vue'

const route = useRoute()
const router = useRouter()
// P5-59: the ingest plan and "Copy it in now" are admin decisions, so the
// panel is told who is looking rather than guessing from the route.
const { internalUser } = useAuth()
const isAdmin = computed(() => internalUser.value?.role === 'admin')
const entry = ref<CatalogEntry | null>(null)
const loading = ref(true)
const error = ref('')
const notFound = ref(false)

async function load(slug: string): Promise<void> {
  loading.value = true
  error.value = ''
  notFound.value = false
  try {
    // P5-89: an entry already read this session paints from the cache and the
    // refreshed row arrives through the callback.
    const result = await fetchCatalogEntry(slug, fresh => {
      if (String(route.params.slug) === slug && fresh) entry.value = fresh
    })
    if (result === null) notFound.value = true
    entry.value = result
  } catch (err: unknown) {
    error.value = friendlyError(err, 'This entry did not load. Try again in a moment.')
  } finally {
    loading.value = false
  }
}

watch(() => route.params.slug, slug => load(String(slug)), { immediate: true })

// ============= P5-37: entry hub tabs =============
type Tab = 'overview' | 'data' | 'map' | 'mentions' | 'files'
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', data: 'Data', map: 'Map', mentions: 'Mentions', files: 'Files' }

const layerId = computed(() => (entry.value ? layerIdForEntry(entry.value) : null))
// A saved view's only file is its snapshot — not a table to browse (P5-69).
const isTabular = computed(() => !!entry.value && entry.value.kind !== 'view' && hasTabularFile(entry.value.files))
const pages = computed(() => (entry.value ? mentionedBy(entry.value) : []))
const views = ref<ViewRef[]>([])

const availableTabs = computed<Tab[]>(() => {
  if (!entry.value) return []
  const tabs: Tab[] = ['overview']
  if (isTabular.value) tabs.push('data')
  if (layerId.value) tabs.push('map')
  tabs.push('mentions', 'files')
  return tabs
})

const tab = computed<Tab>(() => {
  const t = route.query.tab
  return typeof t === 'string' && (availableTabs.value as string[]).includes(t) ? (t as Tab) : 'overview'
})

/**
 * The entry's files as a reader sees them (P5-70). `meta.json` is the
 * manifest the reindexer writes — plumbing, not a document anybody filed —
 * so it is out of the list, out of the counts, and out of the total.
 */
const visibleFiles = computed(() =>
  (entry.value?.files ?? []).filter(file => !isManifestFile(fileName(file.key))),
)
const visibleBytes = computed(() => visibleFiles.value.reduce((sum, file) => sum + file.size, 0))

function tabCount(t: Tab): number | null {
  if (!entry.value) return null
  if (t === 'mentions') return pages.value.length + views.value.length
  if (t === 'files') return visibleFiles.value.length
  return null
}

function setTab(t: Tab): void {
  void router.replace({ query: t === 'overview' ? {} : { tab: t } })
}

// In-app document viewing (P5-44): `?view=<filename>` opens the viewer in the
// Files tab. Only a name that matches a real, viewable file counts — a stale
// or non-viewable value falls back to the list.
const viewingName = computed<string | null>(() => {
  const v = route.query.view
  if (typeof v !== 'string' || !entry.value) return null
  const file = visibleFiles.value.find(f => fileName(f.key) === v)
  return file && isViewable(v) ? v : null
})

function openView(name: string): void {
  void router.push({ query: { tab: 'files', view: name } })
  // P5-71: "Open a document in the app" ticks when the viewer actually opens,
  // not when someone walks past /library.
  completeFirstRunStep('read')
}

function closeView(): void {
  void router.replace({ query: { tab: 'files' } })
}

/**
 * The file a "Read" action opens (P5-70): the first viewable non-manifest
 * file, PDF first. A saved view is excluded — its only file IS the snapshot
 * document, and "Open this view" is how you read that.
 */
const primaryFile = computed<string | null>(() =>
  entry.value && entry.value.kind !== 'view'
    ? primaryViewableFile(visibleFiles.value.map(file => fileName(file.key)))
    : null,
)

/** Layer summary from the manifest (names only; the block's plumbing stays server-side). */
const layerSummary = computed(() => {
  const raw = entry.value?.meta.layer
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const l = raw as Record<string, unknown>
  return {
    name: typeof l.name === 'string' ? l.name : entry.value?.title ?? '',
    geometry: typeof l.geometry === 'string' ? l.geometry : 'county',
    description: typeof l.description === 'string' ? l.description : '',
  }
})

/**
 * The "Show on map" link (P5-77). A point layer's frame lives in the manifest,
 * not in `meta.layer`, so the link is the plain one from the first paint and
 * gains the frame as soon as the manifest answers — never absent, never stale.
 */
const framedMapHref = ref('')
const mapHref = computed(() => framedMapHref.value || (layerId.value ? mapUrlForLayers([layerId.value]) : ''))
watch(
  layerId,
  async id => {
    framedMapHref.value = ''
    if (!id) return
    const href = await mapHrefForInternalLayerId(id)
    if (layerId.value === id) framedMapHref.value = href
  },
  { immediate: true },
)

// Views that use this entry's layer — loaded once per entry (Map + Mentions tabs).
watch(
  layerId,
  async id => {
    views.value = []
    if (!id) return
    try {
      views.value = await fetchViewsUsingLayer(id)
    } catch {
      /* the tab just shows no views */
    }
  },
  { immediate: true },
)

/**
 * P7-2: the views presenting this working set.
 *
 * A set holds no framing, so this is the only way from the set to the two
 * interfaces over it — and "no views of it yet" is a real, common state worth
 * saying, not an empty list to hide. Costs no request (the shared catalog).
 */
const setViews = ref<ViewRef[]>([])
/** P8-3: the member datasets, named. The manifest holds slugs; a reader wants
 *  to see WHAT is in the set without clicking through to another page. */
const setMembers = ref<WorkingSetMemberRow[]>([])
const setMissing = ref<string[]>([])
watch(
  () => (entry.value?.kind === 'working-set' ? entry.value.slug : ''),
  async slug => {
    setViews.value = []
    setMembers.value = []
    setMissing.value = []
    if (!slug) return
    try {
      setViews.value = await fetchViewsOfWorkingSet(slug)
    } catch {
      /* the block just lists no views */
    }
    try {
      const resolved = await fetchMembersOfWorkingSet(workingSetBlock.value?.datasets ?? [])
      setMembers.value = resolved.members
      setMissing.value = resolved.missing
    } catch {
      /* fall back to the counts alone */
    }
  },
  { immediate: true },
)

const description = computed(() =>
  entry.value && typeof entry.value.meta.description === 'string' ? entry.value.meta.description : '',
)

/**
 * P7-7: the one line saying what this data ANSWERS.
 *
 * On the page as well as in `search_library`, for the reason P6-34 found with
 * coverage: the entry page never mentioned coverage at all, so the queue sent
 * people to a page with nothing about the gap and no way to fix it. The gap
 * and the claim both belong where somebody can act on them — the Keep / Edit /
 * Clear row below is `NeedsALookNote`, unchanged, because the field table is
 * what it reads.
 *
 * Shown with its own "Answers:" lead-in, and the stored value's own lead-in
 * stripped if it has one, so a model that wrote "Answers: …" (as the prompt
 * asks) and a person who wrote the bare sentence render the same.
 */
/**
 * P7-10: when the entry's DATA is from, in words.
 *
 * Three facts named separately, because they conflate badly: a 2024 release of
 * 2010 census tracts has all three and they are years apart. Read through
 * `datesOf` — the one reader — so this page, the needs-a-look row, the
 * verification queue and the map legend cannot disagree about one entry.
 */
const whenFacts = computed<string[]>(() => {
  if (!entry.value) return []
  const dates = datesOf(entry.value)
  return [coversLabel(dates.covers), publishedLabel(dates.published), fetchedLabel(dates.fetched)].filter(Boolean)
})

const whatItAnswers = computed(() => {
  if (!entry.value) return ''
  return fieldValueOf(entry.value, 'whatItAnswers').replace(/^answers:\s*/i, '')
})

// --- P5-70: the Overview opens on the document ------------------------------
// Reading a filed document used to take three clicks. The first words of it
// go on the Overview instead, pulled from the same extraction the viewer's
// "Text" mode reads. Only kinds the server extracts whole are asked for — a
// dataset's CSV has no document to preview.

/** How much of the document the Overview shows before "Read the whole …". */
const PREVIEW_CHARS = 600

const extractedText = ref('')

const previewText = computed(() => {
  const text = extractedText.value.trim()
  if (!text) return ''
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text
})

watch(
  entry,
  async e => {
    extractedText.value = ''
    const name = primaryFile.value
    if (!e || !name || (e.kind !== 'document' && e.kind !== 'incoming')) return
    const slug = e.slug
    try {
      const { text } = await loadDocumentText(slug, name)
      // Another entry may have arrived while this was in flight.
      if (entry.value?.slug === slug) extractedText.value = text
    } catch {
      // No extraction — a scan, an unreadable format, a file the server holds
      // no reader for. The description alone, as before.
    }
  },
  { immediate: true },
)

// --- P5-69: a saved view's entry page ---------------------------------------
// The snapshot lives behind /views/<slug>; this page says what it is and sends
// the reader there. Everything shown comes from the meta the server writes when
// it indexes the document (savedViewMeta), so no second fetch is needed.

const VIEW_KIND_LABELS: Record<string, string> = {
  map: 'Saved map view',
  table: 'Saved table view',
  compare: 'Saved comparison',
}

const savedView = computed(() => {
  const e = entry.value
  if (!e || e.kind !== 'view') return null
  const meta = e.meta
  const type = meta.type === 'table' || meta.type === 'compare' ? meta.type : 'map'
  return {
    type,
    kindLabel: VIEW_KIND_LABELS[type],
    description: typeof meta.description === 'string' ? meta.description : '',
    savedBy: typeof meta.savedBy === 'string' ? meta.savedBy : '',
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
    dataset: typeof meta.dataset === 'string' ? meta.dataset : '',
    layers: (Array.isArray(meta.layers) ? meta.layers : []).filter(
      (id): id is string => typeof id === 'string' && !!id,
    ),
  }
})

/**
 * P7-1: a working set, read straight off its manifest.
 *
 * A set is a nested-manifest kind, so the row's meta IS the document — no
 * second request. The block below is deliberately small: a set's real home is
 * P7-2's pair of interfaces, and what this page owes a reader who arrived from
 * search is what the set contains and the two things they can do with it.
 */
const workingSetBlock = computed(() => {
  const e = entry.value
  if (!e || e.kind !== 'working-set') return null
  const meta = e.meta
  const strings = (value: unknown) =>
    (Array.isArray(value) ? value : []).filter((v): v is string => typeof v === 'string' && !!v)
  return {
    purpose: typeof meta.purpose === 'string' ? meta.purpose : '',
    datasets: strings(meta.datasets),
    layers: strings(meta.layers),
    sites: typeof meta.sites === 'string' ? meta.sites : '',
    savedBy: typeof meta.savedBy === 'string' ? meta.savedBy : '',
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
    fromView: typeof meta.fromView === 'string' ? meta.fromView : '',
    derived: Array.isArray(meta.derived) ? meta.derived.length : 0,
  }
})

/** P8-3: a set's layers, named rather than keyed. An internal layer's id is
 *  `internal-<slug>`, and the slug is the entry it came from — so the name is
 *  the member's title when we have it, and the bare slug when we do not. */
const setLayers = computed(() =>
  (workingSetBlock.value?.layers ?? []).map(id => {
    const slug = id.replace(/^internal-/, '')
    const member = setMembers.value.find(m => m.slug === slug)
    return { id, slug, name: getPublicLayer(id)?.name ?? member?.title ?? slug }
  }),
)

/** What the view holds, in the server's own words. A map snapshot's
 *  description opens with "Map view", which the kind line already said. */
const viewHolds = computed(() => {
  const view = savedView.value
  if (!view) return ''
  return view.type === 'map' ? view.description.replace(/^Map view(\s·\s)?/, '') : view.description
})

/** The layers a map view is built on, named rather than keyed. An internal
 *  layer is not in the public registry, so its id is the best name we have. */
const viewLayerNames = computed(() =>
  (savedView.value?.layers ?? []).map(id => getPublicLayer(id)?.name ?? (isSiteLayerId(id) ? siteLayerName(id) : id)),
)

// --- Data source block (P5-56) ---------------------------------------------
// A source entry indexes a dataset we do NOT hold. The block answers, in
// order: who publishes it, what it covers, what's in it, how to get it, what
// it costs you, why it matters, and what we actually hold.

/** How many fields a source shows before "Show all N" — enough to recognise
 *  the table, short enough not to bury the rest of the block. */
const FIELD_PREVIEW = 6

const source = computed(() => (entry.value ? sourceOf(entry.value) : null))
const showAllFields = ref(false)
const sourceFields = computed(() => source.value?.fields ?? [])
const shownFields = computed(() =>
  showAllFields.value ? sourceFields.value : sourceFields.value.slice(0, FIELD_PREVIEW),
)
/** license · update cadence · last checked — whichever the manifest carries. */
const sourceTerms = computed(() => {
  const s = source.value
  if (!s) return ''
  return [s.license, s.updateCadence, s.lastChecked ? `checked ${s.lastChecked}` : ''].filter(Boolean).join(' · ')
})
const replication = computed(() => (source.value ? replicationSummary(source.value) : null))
/** Datasets on the replication line. P5-56 wrote bare slugs here; P5-57 writes
 *  place slices, and a promoted one carries the slug it became — the places
 *  themselves are listed in the fetch panel, where they can be re-opened. */
const replicationSlices = computed(() => replicationDatasets(source.value))
/** There is an adapter only for these access types; otherwise there is nothing
 *  to promise, so the button is hidden rather than shown permanently dead. */
const showFetchForPlace = computed(() => canFetchForPlace(source.value))

// P5-57: the panel opens on demand, and `?place=<cacheKey>` (the link Ask and
// MCP hand back) opens it already looking at that slice.
const placeOpen = ref(false)
const placeKey = computed(() => (typeof route.query.place === 'string' ? route.query.place : ''))
watch(
  placeKey,
  key => {
    if (key) placeOpen.value = true
  },
  { immediate: true },
)

function togglePlacePanel(): void {
  placeOpen.value = !placeOpen.value
}

/** A saved slice is a new entry — go straight to it, the way filing does. */
function onPromoted(newSlug: string): void {
  void router.push(`/library/${newSlug}`)
}

/**
 * P6-24: who published this, and what kind of thing it is — the two words the
 * browser row carried, read from the row's own helpers so the entry page and
 * the row can never say different things about the same entry.
 *
 * Both answers travel ON the row (worked out at reindex), so this costs no
 * request and no second resolution of the vocabulary. `organizationLabelOf`
 * shows an unknown publisher as the words somebody wrote, which is why the
 * page asks it rather than `organizationLabel` — the suggestion panel below
 * has a bare id and uses that one.
 */
const publisher = computed(() => (entry.value ? organizationLabelOf(entry.value) : ''))
const shapeText = computed(() => (entry.value ? shapeLabelOf(entry.value) : ''))

/** Provenance prose in `source` (datasets have carried it since the first
 *  content load) — a plain string, not the P5-56 block.
 *
 *  P6-24: it is NOT the publisher's name. The founding content load wrote
 *  internal folder notes here ("final folder for … / (Nick, 2026-09)"), so
 *  P5-65's "Publisher:" label was claiming a publisher from a filing note.
 *  The publisher is the curated organization above; this stays as what it has
 *  always been — where the material came from. P6-11 gives it a section. */
const sourceNote = computed(() =>
  entry.value && typeof entry.value.meta.source === 'string' ? entry.value.meta.source : '',
)

function formatDate(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** meta rows minus the fields already shown as first-class UI. */
const extraMeta = computed(() => {
  if (!entry.value) return []
  // P5-69: the view block says what a saved view is and holds; its raw meta
  // (type, savedBy, resultCount…) would be the same thing said badly.
  if (entry.value.kind === 'view') return []
  // P7-1: the same rule, for the same reason — the block below says what the
  // set holds; `datasets ["a","b"]` down here would be the same thing said
  // badly.
  if (entry.value.kind === 'working-set') return []
  // 'body' renders as the note text (P5-12); 'lineage' gets its own block
  // (P5-13); 'fetch' and 'suggested' are the P5-47 status line and panel —
  // raw JSON of any of them here would just be the same thing said badly.
  // P5-59: 'inspection' and 'ingest' are the panel above; their raw JSON here
  // would be the same story told in a way nobody can read.
  // P6-24: 'organization' and 'shape' are the meta row's two curated labels.
  // They were landing down here as their raw ids — `organization blo`,
  // `shape points` — which is the same defect this ticket fixes, one block
  // lower: the words are upstairs, so the ids are noise.
  // P7-7: 'whatItAnswers' has its own line above — down here it would be the
  // same sentence again, which is the defect P6-24 fixed for the publisher and
  // the type. 'provenance' is the same case, found live while verifying this
  // ticket: `NeedsALookNote` says the mechanism and the evidence in words a
  // few lines up, and the raw block below was the whole record as JSON on
  // every remediated entry — one more field in it would only have made a
  // bigger wall.
  // P7-10: 'dates' is the line below the meta row, in words — the raw block
  // here would read `dates {"covers":"2019/2023"}`, which is the same fact in
  // the one spelling a person cannot read.
  const shown = new Set(['title', 'category', 'status', 'tags', 'body', 'lineage', 'description', 'mentionedBy', 'layer', 'supersededBy', 'source', 'url', 'note', 'fetch', 'suggested', 'inspection', 'ingest', 'organization', 'shape', 'whatItAnswers', 'dates', 'provenance'])
  return Object.entries(entry.value.meta).filter(([key]) => !shown.has(key))
})

/** Lineage (P5-13): where a published dataset came from and what cleaning was
 *  done — the dev cleaning pathway records this in meta.json. A bare string
 *  renders as a single note; an object renders one row per field. */
const lineageRows = computed<[string, string][]>(() => {
  const raw = entry.value?.meta.lineage
  if (typeof raw === 'string' && raw.trim()) return [['note', raw]]
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key,
      metaValue(value),
    ])
  }
  return []
})

/** Note text (P5-12): the body lives inside the bucket manifest. */
const noteBody = computed(() =>
  entry.value?.kind === 'note' && typeof entry.value.meta.body === 'string'
    ? entry.value.meta.body
    : '',
)

function metaValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Path relative to the entry's folder — the full key is noise here. */
function fileName(key: string): string {
  const parts = key.split('/')
  return parts.slice(3).join('/') || key
}

// --- Filing form (P5-11): only shown for kind === 'incoming' ---------------
const filingTitle = ref('')
const filingCategory = ref('')
const filingTags = ref('')
const filingDescription = ref('')

/** P6-5: the browser this entry lives in — where "back" should go now that
 *  `/library` is a redirect. Datasets and sources sit under Datasets, saved
 *  views under Analysis, everything else under Docs. */
const browserHome = computed(() => {
  const kind = entry.value?.kind
  if (kind === 'dataset' || kind === 'source') return { to: '/datasets', label: 'Datasets' }
  // P7-1: a working set is what an analysis runs against, and the list of
  // them is on /analysis beside the views that present them.
  if (kind === 'view' || kind === 'working-set') return { to: '/analysis', label: 'Analysis' }
  return { to: '/docs', label: 'Docs' }
})
// P6-8a: the two vocabulary fields a filing carries beside the taxonomy.
const filingOrganization = ref('')
const filingShape = ref('')
// P5-56: "This is a data source" on the filing form — an already-dropped link
// becomes a source, and an existing source's block gets filled in later.
const filingIsSource = ref(false)
const filingSourceForm = ref(emptySourceForm())
// P5-59: which form fields came from an inspection rather than from a person,
// and the block they came from — the form renders nine fields, the block can
// carry columns and a place query besides, and those must survive a Save.
const filingInferred = ref<(keyof SourceFormState)[]>([])
const filingSourceBase = ref<SourceMeta | null>(null)
const filing = ref(false)
const filingNote = ref('')
const filingError = ref(false)

// --- P5-67: a source page reads first ---------------------------------------
// The fifteen-field form is what a *filer* needs; a researcher opening a source
// wants "How to get it". So a source keeps the form behind an Edit button — the
// same affordance a wiki page uses — and `?edit=1` opens it, which is how a
// dropped link lands on a fresh entry ready to file. An incoming entry keeps it
// open: filing is that page's whole point. Anyone may edit: not admin-gated.
const filingFormOpen = computed(
  () => entry.value?.kind === 'incoming' || (entry.value?.kind === 'source' && route.query.edit === '1'),
)

function openFilingForm(): void {
  void router.replace({ query: { ...route.query, edit: '1' } })
}

function closeFilingForm(): void {
  const query = { ...route.query }
  delete query.edit
  void router.replace({ query })
}

// --- Fetch on drop + suggested filing (P5-47) ------------------------------
// The server fetches a dropped link and proposes how to file it. Both are
// shown here; neither changes anything until a person acts.
const fetchState = computed(() => (entry.value ? fetchStateOf(entry.value) : null))
const suggestion = computed(() => (entry.value ? suggestionOf(entry.value) : null))
const suggestionReady = computed(() => (entry.value ? hasSuggestion(entry.value) : false))

/** P6-8: the proposed title, while it is still only a proposal. */
const suggestedTitle = computed(() => (entry.value ? suggestedTitleOf(entry.value) : null))

/** The file the suggestion was read from — the "Why?" line's whole answer. */
const suggestionSource = computed(() =>
  typeof entry.value?.meta.originalFilename === 'string' && entry.value.meta.originalFilename
    ? entry.value.meta.originalFilename
    : fetchState.value?.name || 'this file',
)

/** A fetch that failed, or one that never started because the queue was
 *  busy, is the only case where trying again is a real offer. */
const canRetryFetch = computed(() => fetchState.value?.status === 'failed' || fetchState.value?.status === 'later')
const refetching = ref(false)
const refetchNote = ref('')

async function tryFetchAgain(): Promise<void> {
  if (!entry.value || refetching.value) return
  refetching.value = true
  refetchNote.value = ''
  try {
    await refetchLink(entry.value.slug)
    // Re-read rather than guess: the job may already have finished.
    const refreshed = await fetchCatalogEntry(entry.value.slug)
    if (refreshed) entry.value = refreshed
    refetchNote.value = 'Fetching now — reload in a moment to see the file.'
  } catch (err: unknown) {
    refetchNote.value = friendlyError(err, 'The fetch could not start. Try again.')
  } finally {
    refetching.value = false
  }
}

// --- P5-82: what this entry is ready as --------------------------------------
// One line, straight from the server's verdict. The rules live in
// server/src/services/readiness.ts so every surface says the same thing.
//
// Only for the kinds the question is about — what we hold, what we point at,
// and what somebody dropped. A wiki page and a saved view carry a verdict too
// (every row does), but "ready as a document" says nothing about a page that
// IS the knowledge base.
const READINESS_KINDS = ['dataset', 'document', 'incoming', 'source']
const readinessText = computed(() =>
  entry.value?.readiness && READINESS_KINDS.includes(entry.value.kind) ? readinessLine(entry.value.readiness) : '',
)

// --- P5-83: read, but not summarised -----------------------------------------

/** An admin sentence turned into the tail of ours: "The model refused the key
 *  — check billing." → "the model refused the key — check billing". */
function asClause(sentence: string): string {
  const trimmed = sentence.trim().replace(/\.$/, '')
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

const modelGap = computed(() => (entry.value ? modelPassGap(entry.value) : null))

/**
 * "Read on 8 Sep 2026. No model pass — the model refused the key."
 *
 * An empty summary means two very different things, and the reader could not
 * tell them apart: never read, or read and not summarised. Admins get P5-75's
 * sentence, which names something they can fix; everyone else is told the
 * model was unavailable, which is the whole of what they can act on.
 */
const modelPassLine = computed(() => {
  const gap = modelGap.value
  if (!gap) return ''
  const reason = isAdmin.value && gap.reason ? asClause(ADMIN_REASON_TEXT[gap.reason]) : 'the model was unavailable'
  return `${gap.readAt ? `Read on ${formatDate(gap.readAt)}.` : 'Read.'} No model pass — ${reason}.`
})

/**
 * A pass that produced nothing can always be asked again — the only question
 * is which request asks it.
 *
 * For a dropped LINK the pass runs at the end of the fetch, so asking for the
 * fetch again is asking for the pass (P5-83, unchanged). For a dropped FILE
 * there is nothing to fetch — the file is already here — so P6-8's annotate
 * route re-reads it in place. Until that route existed, an uploaded file had
 * no way back at all.
 */
const LOOK_AGAIN_KINDS = ['incoming', 'document']
const canLookAgain = computed(
  () => !!modelGap.value && LOOK_AGAIN_KINDS.includes(entry.value?.kind ?? '') && !isFetchPending(entry.value ?? { meta: {} }),
)
const lookAgainNote = ref('')

async function lookAgain(): Promise<void> {
  if (!entry.value || refetching.value) return
  refetching.value = true
  lookAgainNote.value = ''
  try {
    if (linkOf(entry.value)) await refetchLink(entry.value.slug)
    else await annotateAgain(entry.value.slug)
    const refreshed = await fetchCatalogEntry(entry.value.slug)
    if (refreshed) entry.value = refreshed
    lookAgainNote.value = 'Looking again — reload in a moment to see what it found.'
  } catch (err: unknown) {
    lookAgainNote.value = friendlyError(err, 'The pass could not be started. Try again.')
  } finally {
    refetching.value = false
  }
}

/** Fill the filing form from the proposal. Nothing is saved: the fields are
 *  now the user's to edit, and filing is still a deliberate press. */
function applySuggestion(): void {
  const proposed = suggestion.value
  if (!proposed) return
  if (proposed.title) filingTitle.value = proposed.title
  if (proposed.category) filingCategory.value = proposed.category
  if (proposed.tags?.length) filingTags.value = proposed.tags.join(', ')
  if (proposed.summary) filingDescription.value = proposed.summary
  if (proposed.organization) filingOrganization.value = proposed.organization
  if (proposed.shape) filingShape.value = proposed.shape
  filingError.value = false
  filingNote.value = 'Suggestion filled in — edit anything you like, then file it.'
}

// --- Note edit form (P5-12): only shown for kind === 'note' ----------------
const editOpen = ref(false)
const editTitle = ref('')
const editBody = ref('')
const editCategory = ref('')
const editTags = ref('')
const editStatus = ref('open')

/** Idea lifecycle statuses, plus the note's current status when it sits
 *  outside them (e.g. a needs-review research note) so the select can show
 *  it. Only allowlisted statuses are ever sent back. */
const editStatusOptions = computed(() => {
  const options: string[] = [...NOTE_STATUSES]
  if (entry.value && !options.includes(entry.value.status)) options.unshift(entry.value.status)
  return options
})

// Prefill from the current entry so re-filing/editing starts from what's
// there. (Deliberately does NOT clear filingNote: this watcher also fires
// right after a successful save replaces entry, and would wipe the note on
// the next tick. Notes are cleared on navigation via loading instead.)
watch(entry, e => {
  if (e?.kind === 'incoming' || e?.kind === 'source') {
    filingTitle.value = e.title
    filingCategory.value = e.category
    filingTags.value = e.tags.join(', ')
    filingDescription.value = typeof e.meta.description === 'string' ? e.meta.description : ''
    filingOrganization.value = typeof e.meta.organization === 'string' ? e.meta.organization : ''
    filingShape.value = typeof e.meta.shape === 'string' ? e.meta.shape : ''
    // A source is already a source: the checkbox starts ticked and the fields
    // start from the block, so editing adds to it instead of replacing it.
    filingIsSource.value = e.kind === 'source'
    filingSourceForm.value = sourceFormFrom(sourceOf(e))
    // What is on the entry was typed by a person (or already saved), so it is
    // not inferred. A proposal sets these again straight after.
    filingInferred.value = []
    filingSourceBase.value = sourceOf(e)
    showAllFields.value = false
  }
  if (e?.kind === 'note') {
    editTitle.value = e.title
    editBody.value = typeof e.meta.body === 'string' ? e.meta.body : ''
    editCategory.value = e.category
    editTags.value = e.tags.join(', ')
    editStatus.value = e.status
  }
})

watch(loading, isLoading => {
  if (isLoading) {
    filingNote.value = ''
    filingError.value = false
    refetchNote.value = ''
    editOpen.value = false
  }
})

async function submitNoteEdit(): Promise<void> {
  if (!entry.value || filing.value) return
  filing.value = true
  filingNote.value = ''
  filingError.value = false
  try {
    entry.value = await fileCatalogEntry(entry.value.slug, {
      title: editTitle.value.trim(),
      body: editBody.value.trim(),
      category: editCategory.value.trim(),
      tags: editTags.value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
      // The server allowlists note statuses; an out-of-list current status
      // (non-idea notes start at needs-review) is simply left unchanged.
      status: (NOTE_STATUSES as readonly string[]).includes(editStatus.value)
        ? editStatus.value
        : undefined,
    })
    filingNote.value = 'Saved.'
    editOpen.value = false
  } catch (err: unknown) {
    filingError.value = true
    filingNote.value = friendlyError(err, 'Saving failed. Try again.')
  } finally {
    filing.value = false
  }
}

async function submitFiling(): Promise<void> {
  if (!entry.value || filing.value) return
  const sourceBlock = filingIsSource.value ? sourceFromForm(filingSourceForm.value, filingSourceBase.value) : null
  if (filingIsSource.value && !sourceBlock) {
    filingError.value = true
    filingNote.value = 'A data source needs a provider — who publishes it.'
    return
  }
  const wasSource = entry.value.kind === 'source'
  filing.value = true
  filingNote.value = ''
  filingError.value = false
  try {
    entry.value = await fileCatalogEntry(entry.value.slug, {
      title: filingTitle.value.trim(),
      category: filingCategory.value.trim(),
      tags: filingTags.value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
      description: filingDescription.value.trim(),
      organization: filingOrganization.value,
      shape: filingShape.value,
      ...(sourceBlock ? { source: sourceBlock } : {}),
    })
    // Saved means a person approved them: nothing is "inferred" any more.
    filingInferred.value = []
    filingNote.value = sourceBlock
      ? wasSource
        ? 'Saved.'
        : 'Filed as a data source — it now lives with the sources.'
      : 'Filed — status is now needs-review.'
    // P5-67: filing an incoming link AS a source makes this a source page,
    // where the form is closed by default — but the person is still standing
    // in it, and closing it would take the confirmation away with it.
    if (entry.value.kind === 'source' && route.query.edit !== '1') openFilingForm()
  } catch (err: unknown) {
    filingError.value = true
    filingNote.value = friendlyError(err, 'Filing failed. Try again.')
  } finally {
    filing.value = false
  }
}

// --- P5-59: the ingest panel talks back -------------------------------------

/** "Register as a data source": fill the filing form in from the proposal and
 *  mark every value the machine worked out. Nothing is saved — the person
 *  still reads it and presses File. */
function onRegisterProposal(result: ProposalResponse): void {
  filingIsSource.value = true
  filingSourceForm.value = sourceFormFrom(result.proposal.source)
  filingSourceBase.value = result.proposal.source
  filingInferred.value = [...inferredFormFields(result.proposal.inferred)]
  if (result.proposal.title && !filingTitle.value) filingTitle.value = result.proposal.title
  if (result.proposal.category && !filingCategory.value) filingCategory.value = result.proposal.category
  if (result.proposal.tags?.length && !filingTags.value) filingTags.value = result.proposal.tags.join(', ')
  if (result.proposal.description && !filingDescription.value) filingDescription.value = result.proposal.description
}

/** "Drop this link" on one of the downloads a portal page lists. It becomes a
 *  new entry through the same service the drop form uses, and we go there —
 *  the point of the button is to keep working on the real thing. */
const droppingLink = ref(false)
async function onDropDiscoveredLink(url: string): Promise<void> {
  if (droppingLink.value) return
  droppingLink.value = true
  try {
    const result = await createLinkEntry({ url })
    // P5-67: a fresh drop is there to be filed, so it lands with the form open.
    void router.push({ path: `/library/${result.slug}`, query: { edit: '1' } })
  } catch (err: unknown) {
    filingError.value = true
    filingNote.value = friendlyError(err, 'We could not drop that link. Try again.')
  } finally {
    droppingLink.value = false
  }
}

/**
 * P6-34: which of this entry's values a model wrote and nobody has checked.
 *
 * Named in the meta row rather than only in the queue, because the entry page
 * is where a claim leaves the library: somebody reading it, quoting it in a
 * story or handing it to a funder has to be able to tell a machine's reading
 * from a curated fact.
 */
const unverifiedHere = computed(() => (entry.value ? unverifiedFieldsOf(entry.value) : []))

/** The plan or the inspection changed — re-read so the panel shows the truth
 *  rather than what it hoped happened. */
async function reloadEntry(): Promise<void> {
  if (!entry.value) return
  const fresh = await fetchCatalogEntry(entry.value.slug).catch(() => null)
  if (fresh) entry.value = fresh
}
</script>

<template>
  <div class="entry-view">
    <div class="entry-panel">
      <RouterLink :to="browserHome.to" class="back-link">← {{ browserHome.label }}</RouterLink>

      <p v-if="loading" class="state-note">Loading entry…</p>
      <p v-else-if="error" class="state-note error">{{ error }}</p>
      <p v-else-if="notFound" class="state-note">Nothing in the library is called “{{ route.params.slug }}”.</p>

      <article v-else-if="entry" :class="{ 'entry-archived': entry.status === 'archived' }">
        <div class="title-row">
          <h1>{{ entry.title }}</h1>
          <span class="badge kind">{{ entry.kind }}</span>
          <span class="badge" :class="`status-${entry.status}`">{{ entry.status }}</span>
          <!-- P5-70: a document opens on the document. One press from the
               title, and the same action leads Quick actions below. -->
          <button
            v-if="primaryFile"
            type="button"
            class="edit-btn"
            data-testid="read-entry"
            @click="openView(primaryFile)"
          >
            Read
          </button>
          <button
            v-if="entry.kind === 'source' && !filingFormOpen"
            type="button"
            class="edit-btn"
            data-testid="edit-source"
            @click="openFilingForm"
          >
            Edit
          </button>
        </div>
        <div class="meta-row">
          <!-- P6-24: the type chip and the publisher the browser row showed,
               in the row's own reading order — type, topic, then who published
               it. §B.6 puts them on every row; landing from one and finding
               neither was the bug. -->
          <span v-if="shapeText" class="badge shape" data-testid="entry-type">{{ shapeText }}</span>
          <!-- P5-63: what it is about, then what it is for. The raw category
               id only shows when the taxonomy has never heard of it. -->
          <span v-if="topicLabelOf(entry)" class="category" data-testid="entry-topic">{{ topicLabelOf(entry) }}</span>
          <span v-if="purposeLabelOf(entry)" class="purpose" data-testid="entry-purpose">{{ purposeLabelOf(entry) }}</span>
          <!-- `working-sets` is the bucket directory, not a topic, and the kind
               chip beside the title already says what this is. -->
          <span v-else-if="!topicLabelOf(entry) && entry.category && entry.kind !== 'working-set'" class="category">{{ entry.category }}</span>
          <span v-if="publisher" class="publisher" data-testid="entry-organization">{{ publisher }}</span>
          <!-- P6-21: a tag opens a search for it. It used to point at
               `/library?tag=`, which has been retired since P6-5: the redirect
               forwards the query to `/search`, whose `FILTER_KEYS` have never
               included `tag`, so every tag on every entry led to a blank page
               with an empty box. `q` is the honest target — the catalog
               searches tags (P5-38) and folds the spelling (P5-63), so
               `environmental-risk` finds what carries it. It is a word search
               rather than an exact filter, so a tag that is also a common word
               can bring company; a real `tag=` filter needs server support and
               is noted on P6-21. -->
          <RouterLink v-for="t in entry.tags" :key="t" class="badge tag" :to="`/search?q=${encodeURIComponent(t)}`">{{ t }}</RouterLink>
          <!-- P6-34: a surface that carries a claim outward has to be able to
               say a value is unverified. An unverified value must never be
               indistinguishable from a curated one — that is the load-bearing
               half of applying by default — so the badge sits in the meta row
               beside the chips it is about, not in a panel below the fold. -->
          <span v-if="unverifiedHere.length" class="badge unverified" data-testid="entry-unverified">
            {{ unverifiedHere.map(fieldLabel).join(' and ') }} unverified
          </span>
        </div>

        <!-- P6-33/P6-34: what needs a look on this entry, with Keep / Edit /
             Clear — the same component the needs-a-look list uses, so the two
             surfaces cannot drift in what they offer. -->
        <NeedsALookNote v-if="entry" :entry="entry" @changed="reloadEntry" />

        <!-- P6-8: a title the assistant proposed and nobody has accepted.
             Grey and badged, because it is not this entry's name yet — the
             filing form below is where it becomes one. -->
        <p v-if="suggestedTitle" class="suggested-title" data-testid="suggested-title-line">
          {{ suggestedTitle }}
          <span class="badge suggested-badge" data-testid="suggested-badge">suggested</span>
        </p>

        <!-- P5-82: what this entry is ready to be used as, in one line. -->
        <p v-if="readinessText" class="readiness-line" data-testid="readiness">{{ readinessText }}</p>

        <!-- P5-83: read, but not summarised — said plainly, with the one
             action that can change it. -->
        <p v-if="modelPassLine" class="model-pass-line" data-testid="model-pass">
          {{ modelPassLine }}
          <button
            v-if="canLookAgain"
            type="button"
            class="retry-btn"
            data-testid="look-again"
            :disabled="refetching"
            @click="lookAgain"
          >
            {{ refetching ? 'Looking…' : 'Look again' }}
          </button>
        </p>
        <p v-if="lookAgainNote" class="link-hint" data-testid="look-again-note">{{ lookAgainNote }}</p>

        <!-- P5-35: supersession banners -->
        <p v-if="entry.status === 'archived'" class="supersede-banner archived" data-testid="superseded-banner">
          <template v-if="entry.supersededBy">
            Archived — superseded by
            <RouterLink :to="`/library/${entry.supersededBy.slug}`">{{ entry.supersededBy.title }}</RouterLink>.
            Kept for the record; use the latest.
          </template>
          <template v-else>Archived — kept for the record.</template>
        </p>
        <p v-else-if="entry.supersedes && entry.supersedes.length" class="supersede-banner current" data-testid="supersedes-banner">
          Replaces:
          <template v-for="(ref, i) in entry.supersedes" :key="ref.slug">
            <RouterLink :to="`/library/${ref.slug}`">{{ ref.title }}</RouterLink><template v-if="i < entry.supersedes.length - 1">, </template>
          </template>
          (archived)
        </p>

        <nav v-if="availableTabs.length > 1" class="tab-bar strip" role="tablist" aria-label="Entry sections" data-testid="entry-tabs">
          <button
            v-for="t in availableTabs"
            :key="t"
            type="button"
            role="tab"
            class="tab-btn"
            :class="{ active: tab === t }"
            :aria-selected="tab === t"
            :data-tab="t"
            @click="setTab(t)"
          >
            {{ TAB_LABELS[t] }}<span v-if="tabCount(t) !== null" class="tab-count">{{ tabCount(t) }}</span>
          </button>
        </nav>

        <section v-if="tab === 'overview'" class="tab-panel" data-testid="tab-overview">
        <!-- P5-69: a saved view opens from here the same as from anywhere
             else, and a page author gets the embed line without hunting. -->
        <div v-if="savedView" class="view-block" data-testid="view-block">
          <p class="view-kind" data-testid="view-kind">
            {{ savedView.kindLabel }}<template v-if="savedView.savedBy"> · saved by {{ savedView.savedBy }}</template><template v-if="savedView.savedAt"> · {{ formatDate(savedView.savedAt) }}</template>
          </p>
          <p v-if="viewHolds" class="view-holds" data-testid="view-holds">{{ viewHolds }}</p>
          <p v-if="viewLayerNames.length" class="view-holds" data-testid="view-layers">
            Layers: {{ viewLayerNames.join(', ') }}
          </p>
          <p v-if="savedView.type === 'table' && savedView.dataset" class="view-holds" data-testid="view-dataset">
            Table: <RouterLink :to="`/library/${savedView.dataset}`">{{ savedView.dataset }}</RouterLink>
          </p>
          <RouterLink :to="`/views/${entry.slug}`" class="file-btn view-open" data-testid="view-open">
            Open this view →
          </RouterLink>
          <p class="view-embed" data-testid="view-embed">
            Embed it in a page with <code>view:{{ entry.slug }}</code>
          </p>
        </div>

        <!-- P7-1: the compound data object an analysis runs against. Small on
             purpose — the set's own two interfaces are P7-2's. -->
        <div v-if="workingSetBlock" class="view-block" data-testid="working-set-block">
          <p class="view-kind" data-testid="working-set-kind">
            Working set<template v-if="workingSetBlock.savedBy"> · made by {{ workingSetBlock.savedBy }}</template><template v-if="workingSetBlock.savedAt"> · {{ formatDate(workingSetBlock.savedAt) }}</template>
          </p>
          <p v-if="workingSetBlock.purpose" class="view-holds" data-testid="working-set-purpose">
            {{ workingSetBlock.purpose }}
          </p>
          <p class="view-holds" data-testid="working-set-holds">
            {{ workingSetBlock.datasets.length }} {{ workingSetBlock.datasets.length === 1 ? 'dataset' : 'datasets' }}<!--
            --><template v-if="workingSetBlock.layers.length"> · {{ workingSetBlock.layers.length }} {{ workingSetBlock.layers.length === 1 ? 'layer' : 'layers' }}</template><!--
            --><template v-if="workingSetBlock.derived"> · {{ workingSetBlock.derived }} derived {{ workingSetBlock.derived === 1 ? 'column' : 'columns' }}</template>
          </p>
          <p v-if="workingSetBlock.sites" class="view-holds" data-testid="working-set-sites">
            Anchored on <RouterLink :to="`/library/${workingSetBlock.sites}`">{{ workingSetBlock.sites }}</RouterLink>
          </p>
          <p v-if="workingSetBlock.fromView" class="view-holds" data-testid="working-set-from-view">
            Made from the view <RouterLink :to="`/views/${workingSetBlock.fromView}`">{{ workingSetBlock.fromView }}</RouterLink>
          </p>
          <!-- P7-2: where the set's two interfaces are. A set holds no
               framing, so a view is what shows it — several views over one set
               is the normal case, and "none yet" is a real state. -->
          <p class="view-holds" data-testid="working-set-views">
            <template v-if="setViews.length">
              Mapped and explored through<!--
              --><RouterLink
                v-for="view in setViews"
                :key="view.slug"
                :to="`/views/${view.slug}`"
                class="set-view-link"
                data-testid="working-set-view"
              >{{ view.title }}</RouterLink>
            </template>
            <template v-else>No views of it yet — open the map, press Save view, and point it at this set.</template>
          </p>
          <RouterLink :to="`/place?set=${entry.slug}`" class="file-btn view-open" data-testid="working-set-place">
            Check a place in this set →
          </RouterLink>
          <!-- P8-3: WHAT is in the set, on the page. The manifest holds slugs
               and this page used to render only their count, putting the one
               fact a reader came for behind a link. -->
          <ul v-if="setMembers.length" class="set-members" data-testid="working-set-members">
            <li v-for="m in setMembers" :key="m.slug">
              <RouterLink :to="`/library/${m.slug}`">{{ m.title }}</RouterLink>
              <span class="set-member-kind">{{ m.kind }}</span>
              <span v-if="m.status !== 'published'" class="set-member-status">{{ m.status }}</span>
            </li>
          </ul>
          <p v-if="setLayers.length" class="view-holds" data-testid="working-set-layers">
            Layers: <template v-for="(l, i) in setLayers" :key="l.id"><span v-if="i"> · </span>{{ l.name }}</template>
          </p>
          <!-- Only when there IS something missing: P6-23's rule is that a count
               may not disagree with its list, and a standing "what is missing"
               link reads as a warning on a set with nothing wrong with it. -->
          <p v-if="setMissing.length" class="view-holds set-missing" data-testid="working-set-missing">
            {{ setMissing.length }} named {{ setMissing.length === 1 ? 'dataset is' : 'datasets are' }} no longer in the library:
            {{ setMissing.join(', ') }}
          </p>
          <p class="view-embed">
            <RouterLink :to="`/datasets?workingSet=${entry.slug}`" data-testid="working-set-datasets">
              Browse these datasets →
            </RouterLink>
          </p>
        </div>

        <div v-if="linkOf(entry)" class="link-block" data-testid="entry-link-block">
          <h2>Link</h2>
          <a :href="linkOf(entry)!" target="_blank" rel="noopener noreferrer" class="link-url">{{ linkOf(entry) }}</a>
          <p v-if="typeof entry.meta.note === 'string' && entry.meta.note" class="link-note">{{ entry.meta.note }}</p>

          <!-- P5-47: the server fetches a dropped link by itself. This line is
               the whole story of that download, in the reader's own words. -->
          <p v-if="fetchState" class="fetch-line" :class="`fetch-${fetchState.status}`" data-testid="fetch-status">
            <template v-if="fetchState.status === 'queued' || fetchState.status === 'fetching'">
              Fetching the link…
            </template>
            <template v-else-if="fetchState.status === 'fetched'">
              Fetched {{ fetchState.name }}<template v-if="typeof fetchState.bytes === 'number'"> ({{ formatBytes(fetchState.bytes) }})</template>
              <template v-if="relativeTime(fetchState.at)"> · {{ relativeTime(fetchState.at) }}</template>
            </template>
            <template v-else-if="fetchState.status === 'later'">
              <!-- 'later' with a reason is a page that was read and had nothing to download; without one, the queue was full. -->
              {{ fetchState.reason && fetchState.reason !== 'the fetch queue is busy' ? `Not downloaded: ${fetchState.reason}.` : 'Not fetched yet — the queue was busy.' }}
            </template>
            <template v-else>Could not fetch: {{ fetchState.reason || 'the download did not work' }}</template>
            <button
              v-if="canRetryFetch"
              type="button"
              class="retry-btn"
              data-testid="fetch-retry"
              :disabled="refetching"
              @click="tryFetchAgain"
            >
              {{ refetching ? 'Trying…' : 'Try again' }}
            </button>
          </p>
          <p v-if="refetchNote" class="link-hint" data-testid="refetch-note">{{ refetchNote }}</p>

          <!-- P5-73: the CLI half of this sentence is for whoever runs the
               CLI. Everyone else is told the thing they can actually do. -->
          <p v-if="!entry.meta.originalFilename && !fetchState" class="link-hint">
            No file attached yet — <template v-if="isAdmin">a dev can pull it in with <code>npm run library -- fetch {{ entry.slug }}</code>, or </template>download it and add the file to this entry.
          </p>
        </div>
        <!-- P5-59: what the link turned out to be, and how it comes in.
             P5-67: it inspects, proposes and replicates — editing work, so it
             opens with the form rather than greeting a reader. -->
        <IngestPanel
          v-if="filingFormOpen"
          :entry="entry"
          :is-admin="isAdmin"
          @register="onRegisterProposal"
          @drop-link="onDropDiscoveredLink"
          @changed="reloadEntry"
        />

        <!-- P7-10: WHEN the data is from, spelled out as the separate facts
             it is. `updatedAt` is deliberately absent: it says when the bytes
             last moved in our storage, so re-pushing a 2019 file would make it
             read as 2026 data — which is the misreading the whole field
             exists to stop. -->
        <p v-if="whenFacts.length" class="entry-dates" data-testid="entry-dates">
          <template v-for="(fact, i) in whenFacts" :key="fact">{{ i ? ' · ' : '' }}{{ fact }}</template>
        </p>

        <!-- P7-7: what it ANSWERS, above what it IS. A reader deciding
             whether this dataset bears on their question is asking the
             capability question, and the description answers a different one. -->
        <p v-if="whatItAnswers" class="entry-answers" data-testid="entry-answers">
          <span class="answers-lead">Answers:</span> {{ whatItAnswers }}
        </p>

        <!-- P8-3: `describeWorkingSet()` composes "Working set · <purpose> ·
             N datasets · M layers" for places where ONE line is all there is —
             cards, ⌘K rows, search_library. On this page every part of it is
             already shown above, so rendering it here says everything twice. -->
        <p v-if="description && entry.kind !== 'working-set'" class="entry-description">{{ description }}</p>

        <!-- P5-70: the first words of the document itself, so the Overview of
             a document is the document rather than a list of links to it. -->
        <div v-if="previewText && primaryFile" class="doc-preview" data-testid="doc-preview">
          <p class="preview-text">{{ previewText }}</p>
          <button type="button" class="link-btn" data-testid="read-whole" @click="openView(primaryFile)">
            Read the whole document →
          </button>
        </div>

        <!-- P6-24: provenance, not the publisher — see `sourceNote`. -->
        <p v-if="sourceNote" class="entry-source" data-testid="entry-provenance">Where it came from: {{ sourceNote }}</p>

        <!-- P5-56: everything you need to decide whether to go get this data.
             P5-67: in the order a researcher reads it — how to get it, what is
             in it, how to pull it for one place, and only then who publishes
             it. The filing form's own order is the filer's, and it is behind
             the Edit button. -->
        <div v-if="source" class="source-block" data-testid="source-block">
          <template v-if="source.access?.length">
            <h2>How to get it</h2>
            <ul class="access-list" data-testid="source-access">
              <li v-for="(a, i) in source.access" :key="i" class="access-row">
                <span class="badge access-type">{{ accessTypeLabel(a.type) }}</span>
                <a v-if="a.url" :href="a.url" target="_blank" rel="noopener noreferrer" class="link-url">{{ a.url }}</a>
                <span v-if="accessAuthLabel(a)" class="access-auth">{{ accessAuthLabel(a) }}</span>
                <a v-if="a.docs" :href="a.docs" target="_blank" rel="noopener noreferrer" class="access-docs">docs</a>
                <p v-if="a.notes" class="access-notes">{{ a.notes }}</p>
              </li>
            </ul>
          </template>

          <template v-if="sourceFields.length">
            <h2>Key fields</h2>
            <dl class="meta-list" data-testid="source-fields">
              <template v-for="f in shownFields" :key="f.name">
                <dt>{{ f.name }}</dt>
                <dd>{{ f.description || '—' }}</dd>
              </template>
            </dl>
            <button
              v-if="!showAllFields && sourceFields.length > FIELD_PREVIEW"
              type="button"
              class="link-btn"
              data-testid="show-all-fields"
              @click="showAllFields = true"
            >
              Show all {{ sourceFields.length }}
            </button>
          </template>

          <div class="source-actions">
            <AskBox
              :model-value="askQuestionForSource(entry.title)"
              label="Ask about this source"
              placeholder="Ask about this source…"
            />
            <button
              v-if="showFetchForPlace"
              type="button"
              class="file-btn fetch-btn"
              :aria-expanded="placeOpen"
              data-testid="fetch-for-place"
              @click="togglePlacePanel"
            >
              {{ placeOpen ? 'Hide the place fetcher' : 'Fetch for a place' }}
            </button>
          </div>

          <PlaceFetchPanel
            v-if="showFetchForPlace && placeOpen"
            :slug="entry.slug"
            :source="source"
            :open-place="placeKey || undefined"
            @promoted="onPromoted"
          />

          <!-- P5-65: the provenance line reads "Publisher" — "Source" is the
               kind of entry this is, not the name of who wrote the data. -->
          <p class="source-line" data-testid="source-publisher">
            <span class="source-key">Publisher</span> {{ source.provider }}<span v-if="source.program"> · {{ source.program }}</span>
          </p>
          <a
            v-if="source.homepage"
            :href="source.homepage"
            target="_blank"
            rel="noopener noreferrer"
            class="link-url"
            data-testid="source-homepage"
            >{{ source.homepage }}</a
          >

          <p v-if="coversLine(source)" class="source-line" data-testid="source-covers">
            <span class="source-key">Covers</span> {{ coversLine(source) }}
          </p>

          <div v-if="source.topics?.length" class="source-topics" data-testid="source-topics">
            <span v-for="t in source.topics" :key="t" class="badge tag">{{ t }}</span>
          </div>

          <p v-if="sourceTerms" class="source-line" data-testid="source-terms">
            <span class="source-key">Terms</span> {{ sourceTerms }}
          </p>
          <p v-if="source.relevance" class="source-line" data-testid="source-relevance">
            <span class="source-key">Why it matters</span> {{ source.relevance }}
          </p>
          <p v-if="source.notes" class="source-line" data-testid="source-notes">
            <span class="source-key">Notes</span> {{ source.notes }}
          </p>

          <p class="source-replication" data-testid="source-replication">
            {{ replication!.text }}
            <RouterLink v-if="replication!.datasetSlug" :to="`/library/${replication!.datasetSlug}`">{{ replication!.datasetSlug }}</RouterLink>
            <template v-if="replicationSlices.length">
              —
              <template v-for="(slice, i) in replicationSlices" :key="slice">
                <RouterLink :to="`/library/${slice}`">{{ slice }}</RouterLink><template v-if="i < replicationSlices.length - 1">, </template>
              </template>
            </template>
          </p>
        </div>

        <div v-if="entry.kind === 'note'" class="note-block">
          <p class="note-body">{{ noteBody }}</p>
          <button v-if="!editOpen" type="button" class="edit-btn" @click="editOpen = true">
            Edit
          </button>
        </div>

        <form v-if="entry.kind === 'note' && editOpen" class="filing-form" @submit.prevent="submitNoteEdit">
          <h2>Edit note</h2>
          <input v-model="editTitle" type="text" placeholder="Title" aria-label="Title" required />
          <textarea
            v-model="editBody"
            rows="4"
            placeholder="Note text"
            aria-label="Note text"
            required
          ></textarea>
          <TaxonomyFields v-model:category="editCategory" v-model:tags="editTags" :disabled="filing" />
          <label class="status-label">
            Status
            <select v-model="editStatus" aria-label="Status">
              <option v-for="s in editStatusOptions" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
          <div class="edit-actions">
            <button type="submit" class="file-btn" :disabled="filing">
              {{ filing ? 'Saving…' : 'Save' }}
            </button>
            <button type="button" class="cancel-btn" :disabled="filing" @click="editOpen = false">
              Cancel
            </button>
          </div>
        </form>
        <p v-if="entry.kind === 'note' && filingNote" class="filing-note" :class="{ error: filingError }">
          {{ filingNote }}
        </p>

        <div v-if="lineageRows.length" class="lineage-block">
          <h2>Lineage</h2>
          <dl class="meta-list">
            <template v-for="[key, value] in lineageRows" :key="key">
              <dt>{{ key }}</dt>
              <dd>{{ value }}</dd>
            </template>
          </dl>
        </div>

        <dl v-if="extraMeta.length" class="meta-list">
          <template v-for="[key, value] in extraMeta" :key="key">
            <dt>{{ key }}</dt>
            <dd>{{ metaValue(value) }}</dd>
          </template>
        </dl>

        <form v-if="filingFormOpen" class="filing-form" @submit.prevent="submitFiling">
          <h2>{{ entry.kind === 'source' ? 'Edit this source' : 'File this entry' }}</h2>

          <!-- P5-47: what the assistant read out of the document. A proposal
               only — one press fills the form, and the person still files. -->
          <div v-if="suggestionReady && suggestion" class="suggestion-panel" data-testid="suggestion-panel">
            <h3>Suggested by the assistant</h3>
            <dl class="suggestion-list">
              <template v-if="suggestion.title">
                <dt>Title</dt>
                <dd data-testid="suggested-title">{{ suggestion.title }}</dd>
              </template>
              <template v-if="suggestion.category">
                <dt>Category</dt>
                <dd data-testid="suggested-category">{{ suggestion.category }}</dd>
              </template>
              <template v-if="suggestion.tags?.length">
                <dt>Tags</dt>
                <dd data-testid="suggested-tags">{{ suggestion.tags.join(', ') }}</dd>
              </template>
              <template v-if="suggestion.summary">
                <dt>Summary</dt>
                <dd data-testid="suggested-summary">{{ suggestion.summary }}</dd>
              </template>
              <template v-if="suggestion.organization">
                <dt>Organization</dt>
                <dd data-testid="suggested-organization">{{ organizationLabel(suggestion.organization) }}</dd>
              </template>
              <template v-if="suggestion.shape">
                <dt>Type</dt>
                <dd data-testid="suggested-shape">{{ shapeLabel(suggestion.shape) }}</dd>
              </template>
            </dl>
            <button type="button" class="file-btn apply-btn" data-testid="apply-suggestion" @click="applySuggestion">
              Apply suggestion
            </button>
            <p class="suggestion-why" data-testid="suggestion-why">
              Based on the first pages of {{ suggestionSource }}. Nothing is filed until you press
              {{ entry.status === 'needs-cataloging' ? 'File' : 'Re-file' }}.
            </p>
          </div>
          <p v-else-if="suggestion?.error" class="suggestion-quiet" data-testid="suggestion-unavailable">
            The assistant could not suggest a filing for this one — please fill it in yourself.
          </p>

          <input v-model="filingTitle" type="text" placeholder="Title" aria-label="Title" />
          <TaxonomyFields v-model:category="filingCategory" v-model:tags="filingTags" :disabled="filing" />
          <OrganizationShapeFields v-model:organization="filingOrganization" v-model:shape="filingShape" :disabled="filing" />
          <textarea
            v-model="filingDescription"
            rows="2"
            placeholder="Notes / description"
            aria-label="Description"
          ></textarea>
          <label class="source-check">
            <input v-model="filingIsSource" type="checkbox" data-testid="filing-is-source" />
            This is a data source — a dataset we point at rather than hold
          </label>
          <SourceFields v-if="filingIsSource" v-model="filingSourceForm" :disabled="filing" :inferred="filingInferred" />
          <div class="edit-actions">
            <button type="submit" class="file-btn" :disabled="filing">
              {{ filing ? 'Saving…' : entry.kind === 'source' ? 'Save' : entry.status === 'needs-cataloging' ? 'File' : 'Re-file' }}
            </button>
            <button
              v-if="entry.kind === 'source'"
              type="button"
              class="cancel-btn"
              :disabled="filing"
              data-testid="cancel-source-edit"
              @click="closeFilingForm"
            >
              Cancel
            </button>
          </div>
          <p v-if="filingNote" class="filing-note" :class="{ error: filingError }">
            {{ filingNote }}
          </p>
        </form>

        <div class="files-head">
          <h2>Quick actions</h2>
          <span class="files-actions">
            <button
              v-if="primaryFile"
              type="button"
              class="browse-link read-link"
              data-testid="read-quick"
              @click="openView(primaryFile)"
            >
              Read →
            </button>
            <RouterLink
              v-if="isTabular"
              :to="entryUrl(entry.slug, 'data')"
              class="browse-link"
              data-testid="browse-data"
            >
              Browse data →
            </RouterLink>
            <RouterLink
              v-if="layerId"
              :to="mapHref"
              class="browse-link"
              data-testid="show-on-map"
            >
              Show on map →
            </RouterLink>
            <RouterLink :to="entryUrl(entry.slug, 'files')" class="browse-link">Files ({{ visibleFiles.length }}) →</RouterLink>
          </span>
        </div>
        </section>

        <section v-else-if="tab === 'data'" class="tab-panel tab-panel--data" data-testid="tab-data">
          <DatasetView embedded />
        </section>

        <section v-else-if="tab === 'map'" class="tab-panel" data-testid="tab-map">
          <h2>{{ layerSummary?.name }}</h2>
          <p class="tab-lede">
            <!-- P7-3 added `line` to LAYER_GEOMETRIES and this read
                 `point ? 'point' : 'county'`, so a line layer called itself a
                 county one. The ternary was a two-value guess; the vocabulary
                 has three values and names itself. -->
            Internal {{ layerSummary?.geometry ?? 'county' }} layer on the map (logged-in users only).
            <template v-if="layerSummary?.description"> {{ layerSummary.description }}</template>
          </p>
          <RouterLink v-if="layerId" :to="mapHref" class="file-btn map-btn" data-testid="map-open">Show on map →</RouterLink>
          <h3>Saved views using this layer</h3>
          <ul v-if="views.length" class="ref-list" data-testid="layer-views">
            <li v-for="v in views" :key="v.slug">
              <RouterLink :to="`/views/${v.slug}`">{{ v.title }}</RouterLink>
              <span class="ref-meta">saved by {{ v.savedBy }} · {{ formatDate(v.savedAt) }}</span>
            </li>
          </ul>
          <p v-else class="state-note">No saved views use this layer yet — toggle it on the map and press Save view.</p>
        </section>

        <section v-else-if="tab === 'mentions'" class="tab-panel" data-testid="tab-mentions">
          <h2>Mentioned in</h2>
          <h3>Pages</h3>
          <ul v-if="pages.length" class="ref-list" data-testid="mention-pages">
            <li v-for="p in pages" :key="p.slug">
              <RouterLink :to="`/wiki/${p.slug}`">{{ p.title }}</RouterLink>
            </li>
          </ul>
          <p v-else class="state-note">No page links or embeds this entry yet. Link it as <code>/library/{{ entry.slug }}</code> or embed it with <code>```entry:{{ entry.slug }}</code>.</p>
          <template v-if="layerId">
            <h3>Saved views</h3>
            <ul v-if="views.length" class="ref-list" data-testid="mention-views">
              <li v-for="v in views" :key="v.slug">
                <RouterLink :to="`/views/${v.slug}`">{{ v.title }}</RouterLink>
                <span class="ref-meta">saved by {{ v.savedBy }} · {{ formatDate(v.savedAt) }}</span>
              </li>
            </ul>
            <p v-else class="state-note">No saved views use this layer yet.</p>
          </template>
        </section>

        <section v-else-if="tab === 'files'" class="tab-panel" data-testid="tab-files">
          <DocumentViewer
            v-if="viewingName"
            :slug="entry.slug"
            :name="viewingName"
            @close="closeView"
          />
          <template v-else>
            <div class="files-head">
              <h2>Files</h2>
            </div>
            <ul class="file-list">
              <li v-for="file in visibleFiles" :key="file.key">
                <button
                  v-if="isViewable(fileName(file.key))"
                  type="button"
                  class="file-name file-view"
                  data-testid="file-view"
                  @click="openView(fileName(file.key))"
                >{{ fileName(file.key) }}</button>
                <a
                  v-else
                  class="file-name file-link"
                  :href="libraryFileUrl(entry.slug, fileName(file.key))"
                  :download="fileName(file.key)"
                  data-testid="file-download"
                >{{ fileName(file.key) }}</a>
                <span class="file-size">{{ formatBytes(file.size) }}</span>
                <a
                  v-if="isViewable(fileName(file.key))"
                  class="file-dl-small"
                  :href="libraryFileUrl(entry.slug, fileName(file.key))"
                  :download="fileName(file.key)"
                  data-testid="file-download"
                >Download</a>
              </li>
            </ul>
            <p class="total">Total: {{ formatBytes(visibleBytes) }}</p>
          </template>
        </section>
      </article>
    </div>
  </div>
</template>

<style scoped>
.entry-view {
  flex-grow: 1;
  /* A flex item of <main>: without this its minimum width is the widest
     table inside it, and the explorer scrolls the whole page sideways at any
     width narrower than the table (seen at 375 and 768). */
  min-width: 0;
  max-width: 100%;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
}

.entry-panel {
  width: 100%;
  min-width: 0;
  max-width: 680px;
}

.entry-panel:has(.tab-panel--data) {
  max-width: 1400px;
}

.back-link {
  display: inline-block;
  margin-bottom: 16px;
  font-size: 14px;
  color: var(--blo-stone);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

.entry-archived .title-row h1 {
  color: var(--blo-stone);
}

.supersede-banner {
  margin: 10px 0 0;
  padding: 8px 12px;
  font-size: 13px;
  border-radius: 6px;
}

.supersede-banner.archived {
  color: #5d4037;
  background: #fbe9e7;
}

.supersede-banner.current {
  color: var(--blo-stone);
  background: var(--blo-cream-deep);
}

.supersede-banner a {
  color: var(--blo-green-deep);
  font-weight: 600;
}

.title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.title-row h1 {
  margin: 0;
  font-family: var(--blo-font-display);
  font-size: 1.6rem;
  font-weight: 500;
  color: var(--blo-ink);
}

/* P5-67: Edit sits at the end of the title row, as it does on a wiki page. */
.title-row .edit-btn {
  margin-top: 0;
  margin-left: auto;
}

.meta-row {
  margin: 8px 0 18px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

/* P6-24: the type chip and the publisher, drawn as the browser row draws them
   (`DatasetsView`'s `.chip` and `.row-publisher`) so the two surfaces read as
   one vocabulary rather than two. The chip reuses this page's own `.badge`
   geometry and only lightens the ground, which is the row's difference too. */
.badge.shape {
  background: #ffffff;
}

.publisher {
  font-weight: 600;
  color: var(--blo-stone);
}

/* P6-34: an unverified value must never be indistinguishable from a curated
   one, so the badge is the orange the attention panel uses for work waiting on
   a person rather than another quiet grey chip. */
.badge.unverified {
  background: var(--blo-orange-deep, #e65100);
  border-color: var(--blo-orange-deep, #e65100);
  color: #fff;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
}

/* --- The readiness verdict and the model-pass gap (P5-82, P5-83) ---
   Two quiet lines under the title: what this is ready as, and — when a pass
   did not happen — what was not done and the one press that retries it. */
.readiness-line {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--blo-stone);
}

/* P6-8: grey, because nothing has been written down yet. */
.suggested-title {
  margin: -4px 0 8px;
  font-size: 15px;
  color: var(--blo-stone);
}

.suggested-badge {
  margin-left: 6px;
  vertical-align: middle;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
}

.model-pass-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
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

.badge.status-published {
  color: #1b5e20;
  border-color: #a5d6a7;
  background: #e8f5e9;
}

.badge.status-needs-review {
  color: #7a4f01;
  border-color: #ffe082;
  background: #fff8e1;
}

.badge.status-needs-cataloging {
  color: #0d47a1;
  border-color: #90caf9;
  background: #e3f2fd;
}

.badge.status-in-cleaning {
  color: #00695c;
  border-color: #80cbc4;
  background: #e0f2f1;
}

.badge.status-archived {
  color: #555555;
  border-color: #cccccc;
  background: #f0f0f0;
}

.badge.status-open {
  color: #4a2f7a;
  border-color: #c9b4ef;
  background: #f0e9fb;
}

.badge.status-planned {
  color: #7a4f01;
  border-color: #ffe082;
  background: #fff8e1;
}

.badge.status-done {
  color: #1b5e20;
  border-color: #a5d6a7;
  background: #e8f5e9;
}

/* --- Lineage (P5-13) --- */
.lineage-block {
  margin: 0 0 20px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.lineage-block h2 {
  margin: 0 0 10px;
  font-size: 17px;
}

.lineage-block .meta-list {
  margin: 0;
}

/* --- Note body + edit (P5-12) --- */
.note-block {
  margin: 0 0 20px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.note-body {
  margin: 0;
  font-size: 15px;
  line-height: 1.55;
  color: var(--blo-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.edit-btn,
.cancel-btn {
  margin-top: 10px;
  padding: 4px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: transparent;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.cancel-btn {
  margin-top: 0;
}

.cancel-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.status-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone);
}

.status-label select {
  padding: 6px 10px;
  font-size: 14px;
  font-family: inherit;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.edit-actions {
  display: flex;
  gap: 8px;
}

/* --- Filing form (P5-11) --- */
.filing-form {
  margin: 0 0 20px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.filing-form h2 {
  margin: 0;
}

.filing-form input,
.filing-form textarea {
  padding: 7px 10px;
  font-size: 14px;
  font-family: inherit;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  resize: vertical;
}

.file-btn {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  background: var(--blo-ink);
  border: 1px solid var(--blo-ink);
  border-radius: 6px;
  cursor: pointer;
}

.file-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.filing-note {
  margin: 0;
  font-size: 13px;
  color: #1b5e20;
}

.filing-note.error {
  color: #b3261e;
}

.meta-list {
  margin: 0 0 20px;
  padding: 14px 16px;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 18px;
  font-size: 14px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.meta-list dt {
  font-weight: 600;
  color: var(--blo-stone);
}

.meta-list dd {
  margin: 0;
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

h2 {
  margin: 0 0 8px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--blo-ink);
}

.files-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

/* --- A saved view's entry page (P5-69) ---
   Same card as the link block: what it is, what it holds, and the one press
   that opens it. */
.view-block {
  margin: 12px 0 4px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.view-kind {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone);
}

.view-holds {
  margin: 0 0 6px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--blo-ink);
}

.view-holds a {
  color: var(--blo-green-deep);
  font-weight: 600;
}

.view-open {
  display: inline-block;
  margin: 4px 0 0;
  text-decoration: none;
}

.view-embed {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

/* --- The document, on the Overview (P5-70) --- */
.doc-preview {
  margin: 10px 0 4px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.preview-text {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--blo-ink);
  white-space: pre-wrap;
}

/* A button that sits in a row of links (the header, Quick actions). */
.read-link {
  padding: 0;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep);
  background: none;
  border: 0;
  cursor: pointer;
}

.read-link:hover {
  text-decoration: underline;
}

.link-block {
  margin: 12px 0 4px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.link-block h2 {
  margin: 0 0 6px;
  font-size: 14px;
}

.link-url {
  color: var(--blo-green-deep);
  font-weight: 600;
}

.link-note {
  margin: 8px 0 0;
  font-size: 13px;
  white-space: pre-wrap;
}

.link-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

/* --- P6-31: a pasted URL must not widen the page ---
   A URL has no spaces, so normal wrapping cannot break it; its min-content
   width becomes the width of the whole string. On `/library/epa-echo-facilities`
   at 390px that was a 120-character ArcGIS query in `.access-notes` — a flex
   item inside `.access-row` with the default `min-width: auto`, so the row's
   line grew to the string's 761px and took `documentElement.scrollWidth` to
   788px in a 390px viewport. (`.link-url` measured 761px too and looked like
   the culprit; it already broke fine and was only being handed the widened
   line.)

   `overflow-wrap: anywhere` is the one that counts: unlike `break-word` it
   also shrinks the intrinsic min-content size, which is what a flex item's
   automatic minimum is computed from. `word-break: break-word` trails it for
   engines that predate `anywhere`.

   Listed per field rather than per element found: every one of these prints
   text somebody can paste a link into — the dropped link and its note, the
   access URL and its notes, the source block's prose lines, the provenance
   line, a description, the first words of a document and the assistant's
   suggestions. The lineage lines and the extra-meta rows are `.meta-list dd`,
   which has carried `overflow-wrap: anywhere` since P5-13. (`.access-auth`
   and `.access-docs` are left out on purpose: their text is "key needed" and
   "docs", four words that cannot overflow anything.) */
.link-url,
.link-note,
.access-notes,
.source-line,
.source-replication,
.entry-source,
.entry-description,
.entry-answers,
.tab-lede,
.preview-text,
.suggestion-list dd {
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* --- Fetch on drop (P5-47) ---
   One line, in the same voice as the rest of the card: what the server did
   with this link, and the one thing left to try when it could not. */
.fetch-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.fetch-line.fetch-fetched {
  color: var(--blo-green-deep);
}

.fetch-line.fetch-failed {
  color: #8a3b2f;
}

.retry-btn {
  padding: 2px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--blo-green-deep);
  background: none;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 999px;
  cursor: pointer;
}

.retry-btn:hover:not(:disabled) {
  background: var(--blo-cream);
}

.retry-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

/* --- Suggested filing (P5-47) ---
   Deliberately set apart from the form fields below it: what the assistant
   proposed is not yet what the entry says, and the panel should read as an
   offer rather than as filled-in data. */
.suggestion-panel {
  margin: 0 0 12px;
  padding: 10px 12px;
  background: var(--blo-cream);
  border: 1px dashed var(--blo-cream-divider);
  border-radius: 8px;
}

.suggestion-panel h3 {
  margin: 0 0 8px;
  font-size: 13px;
}

.suggestion-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 0 0 10px;
  font-size: 13px;
}

.suggestion-list dt {
  color: var(--blo-stone);
}

.suggestion-list dd {
  margin: 0;
}

.apply-btn {
  margin: 0;
}

.suggestion-why {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

.suggestion-quiet {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--blo-stone);
}

/* --- Data source block (P5-56) ---
   Same card as Link and Lineage: this is one more thing we know about the
   entry, not a different kind of page. */
.source-block {
  margin: 12px 0 4px;
  padding: 12px 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.source-block h2 {
  margin: 14px 0 4px;
  font-size: 14px;
}

.source-block h2:first-child {
  margin-top: 0;
}

.source-line {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--blo-ink);
}

.source-key {
  margin-right: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blo-stone);
}

.source-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.access-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.access-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--blo-cream-divider);
  font-size: 13px;
}

.access-row:first-child {
  border-top: 0;
}

.badge.access-type {
  font-weight: 600;
  color: #4a3b76;
  border-color: #c5b8e6;
  background: #f1edfb;
}

.access-auth,
.access-docs {
  font-size: 12px;
  color: var(--blo-stone);
}

.access-notes {
  flex-basis: 100%;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--blo-stone);
}

.source-replication {
  margin: 12px 0 0;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--blo-stone);
  background: var(--blo-cream-deep);
  border-radius: 6px;
}

.source-replication a {
  color: var(--blo-green-deep);
  font-weight: 600;
}

.source-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.source-actions .ask-box {
  flex: 1 1 260px;
}

.fetch-btn {
  cursor: not-allowed;
}

.link-btn {
  padding: 0;
  font: inherit;
  font-size: 13px;
  color: var(--blo-green-deep);
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}

.source-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--blo-stone);
}

.source-check input {
  width: auto;
}

.set-view-link {
  margin-left: 6px;
  color: inherit;
}

.set-view-link + .set-view-link {
  margin-left: 0;
}

.set-view-link + .set-view-link::before {
  content: ' · ';
}

.tab-bar {
  display: flex;
  gap: 4px;
  margin: 18px 0 8px;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.tab-btn {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
}

.tab-btn.active {
  color: var(--blo-ink);
  border-bottom-color: var(--blo-green-deep);
}

.tab-count {
  margin-left: 6px;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 999px;
  background: var(--blo-cream-deep);
  color: var(--blo-stone);
}

.tab-panel {
  min-width: 0;
  max-width: 100%;
  padding-top: 6px;
}

.tab-lede,
.set-members {
  list-style: none;
  margin: 0.35rem 0 0.6rem;
  padding: 0;
  display: grid;
  gap: 0.25rem;
}
.set-members li {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}
.set-member-kind,
.set-member-status {
  font-size: 0.78rem;
  color: #6b7280;
}
.set-member-status {
  color: #92400e;
}
.set-missing {
  color: #92400e;
}

.entry-description {
  font-size: 14px;
  line-height: 1.5;
  color: var(--blo-ink);
}

/* P7-7: the capability line. Same size as the description it sits above, with
   the lead-in carrying the weight — it is a different KIND of claim, and the
   reader scanning for "can this answer my question?" should find it first. */
.entry-answers {
  font-size: 14px;
  line-height: 1.5;
  color: var(--blo-ink);
}

.entry-answers .answers-lead {
  font-weight: 600;
  color: var(--blo-green-deep);
}

.entry-source {
  font-size: 13px;
  color: var(--blo-stone);
}

.ref-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.ref-list li {
  padding: 6px 0;
  border-bottom: 1px solid var(--blo-cream);
}

.ref-list a {
  color: var(--blo-green-deep);
  font-weight: 600;
  text-decoration: none;
}

.ref-meta {
  margin-left: 8px;
  font-size: 12px;
  color: var(--blo-stone);
}

.map-btn {
  display: inline-block;
  text-decoration: none;
  margin: 6px 0 14px;
}

.files-actions {
  display: inline-flex;
  gap: 14px;
}

.browse-link {
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.browse-link:hover {
  text-decoration: underline;
}

.file-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  background: #ffffff;
  overflow: hidden;
}

.file-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 14px;
  font-size: 14px;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.file-list li:last-child {
  border-bottom: none;
}

.file-link {
  color: var(--blo-green-deep);
  text-decoration: none;
}

.file-link:hover {
  text-decoration: underline;
}

.file-name {
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

/* The file name IS the View control for anything we can show in the browser
   (P5-44). It is a <button>, so it needs the chrome taken off — it had none
   of these rules and rendered as a default grey button. */
.file-view {
  padding: 0;
  font: inherit;
  text-align: left;
  color: var(--blo-green-deep);
  background: none;
  border: 0;
  cursor: pointer;
}

.file-view:hover,
.file-dl-small:hover {
  text-decoration: underline;
}

.file-dl-small {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.file-size {
  color: var(--blo-stone);
  white-space: nowrap;
}

.state-note {
  font-size: 14px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b3261e;
}

.total {
  font-size: 13px;
  color: var(--blo-stone);
}

/* --- P5-60 (mobile pass) ---------------------------------------------------
   The entry hub is the densest internal page: five tabs, a source block of
   label/value rows, a filing form and a files list, all built for a column
   680 px wide. At 375 px each of those becomes a stack. */
@media (max-width: 640px) {
  .entry-view {
    padding: 20px 12px 40px;
  }

  /* Same guard as /kb and the wiki editor: the tab strip must scroll inside
     the page rather than set the page's width. */
  .entry-view,
  .entry-panel,
  .entry-panel:has(.tab-panel--data) {
    min-width: 0;
    max-width: 100%;
  }

  /* Tabs: one row that scrolls, rather than two rows of 29 px targets. */
  .tab-bar {
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 2px;
    margin: 14px 0 6px;
  }

  .tab-btn {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 12px;
    font-size: 14px;
    white-space: nowrap;
  }

  .tab-count {
    font-size: 13px;
  }

  .title-row h1 {
    font-size: clamp(20px, 6.5vw, 1.6rem);
    overflow-wrap: anywhere;
  }

  .badge {
    font-size: 13px;
  }

  /* Source block: the label goes above its value, so neither is squeezed. */
  .source-line {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 14px;
  }

  .source-key {
    margin-right: 0;
    font-size: 13px;
  }

  /* Key fields: a definition list, not a two-column grid 375 px can't hold. */
  .meta-list {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    font-size: 14px;
  }

  .meta-list dt {
    margin-top: 10px;
  }

  .meta-list dt:first-child {
    margin-top: 0;
  }

  /* "How to get it": type chip, then the URL, then the notes — each its own
     line, with the URL free to break anywhere. */
  .access-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 0;
    font-size: 14px;
  }

  .access-auth,
  .access-docs,
  .access-notes,
  .link-hint,
  .suggestion-why,
  .suggestion-quiet,
  .fetch-line,
  .link-note,
  .entry-source,
  .source-replication,
  .ref-meta,
  .total,
  .filing-note,
  .supersede-banner {
    font-size: 14px;
  }

  .suggestion-list {
    grid-template-columns: minmax(0, 1fr);
    font-size: 14px;
  }

  .suggestion-list dt {
    margin-top: 8px;
    font-weight: 600;
  }

  /* Forms stack full width; 16 px keeps iOS from zooming on focus. */
  .filing-form input,
  .filing-form textarea,
  .status-label select {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    font-size: 16px;
  }

  .status-label {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    font-size: 14px;
  }

  .source-check {
    align-items: flex-start;
    min-height: 44px;
    font-size: 14px;
  }

  .source-check input {
    width: 20px;
    height: 20px;
    margin-top: 10px;
  }

  .file-btn,
  .edit-btn,
  .cancel-btn,
  .retry-btn,
  .link-btn,
  .browse-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font-size: 14px;
  }

  .edit-actions,
  .source-actions {
    flex-wrap: wrap;
  }

  .edit-actions .file-btn,
  .edit-actions .cancel-btn {
    flex: 1 1 140px;
  }

  /* Quick actions read as a strip of links rather than one squeezed row. */
  .files-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }

  .files-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
  }

  /* Files: name on one line, then View / Download as real buttons. */
  .file-list li {
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 8px 12px;
    font-size: 14px;
  }

  /* Name first, then its controls as thumb-sized buttons beneath it. */
  .file-name {
    flex: 1 1 100%;
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  .file-view,
  .file-dl-small {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
    font-weight: 600;
    color: var(--blo-green-deep);
    background: #fff;
    border: 1px solid var(--blo-cream-divider);
    border-radius: 6px;
    text-decoration: none;
  }

  /* The name is also the View button; it keeps the full line to itself. */
  .file-name.file-view {
    justify-content: flex-start;
    overflow-wrap: anywhere;
  }

  .file-size {
    margin-left: auto;
  }
}
</style>
