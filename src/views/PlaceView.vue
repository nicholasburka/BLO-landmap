<script setup lang="ts">
/**
 * Check a place (P5-58).
 *
 * Nick's question — "what datasets will tell me all environmental risks
 * associated with x property I'm looking at?" — has one page now. Give it an
 * address, a point, or a county; it runs every data source that covers the
 * place, reads the county's map-layer values, finds the organizations nearby,
 * and shows the written summary above the evidence it came from.
 *
 * The URL is the state (`/place?address=` | `?lat=&lng=` | `?geoid=`), so a
 * report is a link you can send to a colleague and it re-runs against today's
 * sources — the cached copy is a week's grace, not a snapshot, and "Run
 * again" refreshes it.
 */
import { ref, computed, watch, nextTick, onBeforeUnmount, onUnmounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import KbNav from '@/components/KbNav.vue'
import { renderMarkdown } from '@/lib/renderMarkdown'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { WikiConflictError } from '@/lib/wiki'
import { friendlyError } from '@/lib/errors'
import { searchCounties, type CompareCounty } from '@/lib/compare'
import { fetchWorkingSet } from '@/lib/workingSets'
import {
  addReportToPage,
  advanceProgress,
  citationTarget,
  compareUrlFor,
  directionCue,
  freshnessPhrase,
  groupCountLine,
  initialProgress,
  mapUrlFor,
  parsePlaceUrl,
  placeErrorMessage,
  placeUrl,
  progressNote,
  progressSentence,
  readMapCentre,
  reportCsv,
  reportCsvFilename,
  reportGroups,
  reportVerdict,
  requestFromUrl,
  runPlaceReport,
  saveReportAsNote,
  statusPhrase,
  RADIUS_MAX_MILES,
  type PlaceProgress,
  type PlaceReport,
  type ReportGroup,
  type ReportSection,
} from '@/lib/placeReport'

const route = useRoute()
const router = useRouter()

// --- URL state ---------------------------------------------------------------

const urlState = computed(() => parsePlaceUrl(route.query as Record<string, string | string[] | null | undefined>))
const request = computed(() => requestFromUrl(urlState.value))

/** The form, seeded from the URL so a link opens with its own values in it. */
const addressInput = ref(urlState.value.address)
const radiusInput = ref(urlState.value.radius ?? 5)

/**
 * Where the map was last looking, if it left a note. Read once, on open —
 * with nothing there the "use the map's centre" button is not offered at all
 * rather than offered and broken.
 */
const mapCentre = ref(readMapCentre())

/**
 * P7-1: the working set this run is scoped to, from `?set=`.
 *
 * It rides through every navigation below, because which datasets to ask is a
 * separate question from which place to ask about — changing the address must
 * not silently widen a scoped report back to all forty sources.
 */
const scopedSet = computed(() => urlState.value.set)
const scopedSetName = ref('')

function go(next: Parameters<typeof placeUrl>[0]): void {
  void router.push(placeUrl({ radius: radiusInput.value, set: scopedSet.value, ...next }))
}

/** Leave the set and ask the whole library instead. */
function clearScope(): void {
  void router.push(placeUrl({ ...urlState.value, set: '' }))
}

function submitAddress(): void {
  const address = addressInput.value.trim()
  if (!address) return
  go({ address })
}

function submitCounty(geoId: string): void {
  countyQuery.value = ''
  countyMatches.value = []
  go({ geoid: geoId })
}

function useMapCentre(): void {
  if (!mapCentre.value) return
  go({ lat: Number(mapCentre.value.lat.toFixed(5)), lng: Number(mapCentre.value.lng.toFixed(5)) })
}

// --- The county picker -------------------------------------------------------

const countyQuery = ref('')
const countyMatches = ref<CompareCounty[]>([])

watch(countyQuery, async query => {
  const asked = query
  const matches = await searchCounties(query)
  // A slow lookup must not overwrite the results of a later keystroke.
  if (asked === countyQuery.value) countyMatches.value = matches
})

// --- Running it --------------------------------------------------------------

const report = ref<PlaceReport | null>(null)
const loading = ref(false)
const error = ref('')
const sourceCount = ref(0)

/** Only the newest run may write to the page. */
let runId = 0

/**
 * How many sources exist at all, so the progress line can say a number
 * instead of "please wait". Loaded once, and never blocking the report.
 *
 * P7-1: **scoped, when the run is.** A page that said "40 sources" over a run
 * that asked eleven would make the whole point of a working set invisible —
 * and it would be a number disagreeing with what happened, which is the one
 * thing this codebase does not do.
 */
function loadSourceCount(): void {
  if (sourceCount.value) return
  const set = scopedSet.value
  void Promise.all([fetchCatalog({ kind: 'source' }), set ? fetchWorkingSet(set) : Promise.resolve(null)])
    .then(([rows, scope]) => {
      const inScope = scope ? rows.filter(r => scope.datasets.includes(r.slug)) : rows
      if (scope) scopedSetName.value = scope.name
      // Only sources a report can actually run or list by hand count; a
      // pointer with no endpoint is never checked, so "40" would be a lie.
      const runnable = inScope.filter(r => r.readiness && r.readiness.placeReport !== 'never')
      sourceCount.value = inScope.some(r => r.readiness) ? runnable.length : inScope.length
    })
    .catch(() => {
      sourceCount.value = 0
    })
}

// The scope changes what "every source" means, so the seeded count has to be
// read again rather than kept from the scope before it.
watch(scopedSet, () => {
  sourceCount.value = 0
  scopedSetName.value = ''
  loadSourceCount()
})

/** Seconds since the current run started — the progress line's second half.
 *  Kept from the old counter: elapsed time is useful, it was just never the
 *  whole message (P6-16). */
const elapsed = ref(0)
let clock: ReturnType<typeof setInterval> | null = null
function startClock(): void {
  stopClock()
  elapsed.value = 0
  clock = setInterval(() => { elapsed.value += 1 }, 1000)
}
function stopClock(): void {
  if (clock) clearInterval(clock)
  clock = null
}
onUnmounted(stopClock)

/** What the run has told us so far. Seeded with the catalog's source count so
 *  the first line can say a number before the server has said one. */
const progress = ref<PlaceProgress>(initialProgress())

async function run(refresh = false): Promise<void> {
  const asked = request.value
  const id = ++runId
  resetKeeping()
  error.value = ''
  if (!asked) {
    report.value = null
    loading.value = false
    return
  }
  report.value = null
  loading.value = true
  progress.value = initialProgress(sourceCount.value)
  startClock()
  loadSourceCount()
  try {
    const result = await runPlaceReport({ ...asked, ...(refresh ? { refresh: true } : {}) }, event => {
      // A stale run's events must never move the live run's numbers.
      if (id === runId) progress.value = advanceProgress(progress.value, event)
    })
    if (id !== runId) return
    report.value = result
  } catch (err: unknown) {
    if (id !== runId) return
    error.value = placeErrorMessage(err)
  } finally {
    if (id === runId) {
      loading.value = false
      stopClock()
    }
  }
}

const progressLine = computed(() => progressSentence(progress.value))
const progressSecond = computed(() => progressNote(progress.value, elapsed.value))
const summaryHtml = computed(() => (report.value?.summary ? renderMarkdown(report.value.summary.text) : ''))

/** The catalog count is only an upper bound until the run says otherwise; once
 *  it has, the run's own total wins. */
watch(sourceCount, count => {
  if (loading.value && !progress.value.total) progress.value = initialProgress(count)
})

/** Where a `[n]` in the summary goes: the card on this page when the finding
 *  is one of ours, its own link when it came from the wider library. */
function citationHref(source: { title: string; href: string }): string {
  if (!report.value) return source.href
  const target = citationTarget(source, report.value)
  return 'anchor' in target ? target.anchor : target.href
}

// --- The shape of the result (P6-17) -----------------------------------------

/** The answer, before the evidence for it. */
const verdict = computed(() => (report.value ? reportVerdict(report.value) : null))

/** The report's sources in groups: what was found, under its topic heading
 *  (P5-63's headings, now `lib/browse`'s grouping), then one row each for what
 *  found nothing and what could not be checked. */
const groups = computed<ReportGroup[]>(() => (report.value ? reportGroups(report.value) : []))

/**
 * Which groups the reader has pressed, against the group's own default.
 *
 * A fold is a way of reading rather than a filter, so it stays component state
 * and out of the URL — the same rule `GroupedList` states for the browsers. A
 * new report starts from the defaults again, which is why this is keyed by
 * group id and cleared with the report.
 */
const pressed = ref(new Map<string, boolean>())

function isOpen(group: ReportGroup): boolean {
  return pressed.value.get(group.id) ?? group.open
}

function toggleGroup(group: ReportGroup): void {
  // A new Map so the computed template re-reads it; Map mutation is not
  // reactive on its own.
  const next = new Map(pressed.value)
  next.set(group.id, !isOpen(group))
  pressed.value = next
}

/**
 * A `#section-…` link whose card is inside a folded group opens that group
 * first (P6-17).
 *
 * The summary's citations and the verdict's standouts both anchor to cards on
 * this page, and folding one of those groups would otherwise turn a working
 * link into nothing happening. An open group keeps the plain anchor and the
 * browser's own behaviour; only the folded case is intercepted, because the
 * card does not exist to jump to until Vue has drawn it.
 */
async function jumpToSection(href: string, event: MouseEvent): Promise<void> {
  const slug = /^#section-(.+)$/.exec(href)?.[1]
  if (!slug) return
  const group = groups.value.find(g => g.rows.some(s => s.slug === slug))
  if (!group || isOpen(group)) return
  event.preventDefault()
  const next = new Map(pressed.value)
  next.set(group.id, true)
  pressed.value = next
  await nextTick()
  document.getElementById(`section-${slug}`)?.scrollIntoView({ block: 'start' })
}

/** The rows that are actually drawn: a heading per group, and the section
 *  cards of the groups that are open. One list, so a card's markup is written
 *  once however it was grouped. */
type ReportRow =
  | { kind: 'head'; key: string; group: ReportGroup }
  | { kind: 'section'; key: string; section: ReportSection }

const rows = computed<ReportRow[]>(() => {
  const out: ReportRow[] = []
  for (const group of groups.value) {
    out.push({ kind: 'head', key: `head:${group.id}`, group })
    if (!isOpen(group)) continue
    for (const section of group.rows) out.push({ kind: 'section', key: section.slug, section })
  }
  return out
})

function shownColumns(section: ReportSection): string[] {
  // Six columns is what a card can show without a horizontal scrollbar of its
  // own; the rest are one click away in the full slice.
  return section.columns.slice(0, 6)
}

// --- Keeping the report (P5-48's two ways out) -------------------------------

const savedNote = ref<{ slug: string; title: string } | null>(null)
const savingNote = ref(false)
const saveError = ref('')

const pickerOpen = ref(false)
const pages = ref<CatalogEntry[]>([])
const pagesLoaded = ref(false)
const pagesLoading = ref(false)
const pageQuery = ref('')
const addingSlug = ref('')
const addedPage = ref<{ slug: string; title: string } | null>(null)
const addError = ref('')
const conflictSlug = ref('')

/** Everything this page remembered about the report it was showing. */
function resetKeeping(): void {
  // Which groups were folded belonged to the last report, not this one.
  pressed.value = new Map()
  savedNote.value = null
  savingNote.value = false
  saveError.value = ''
  pickerOpen.value = false
  addedPage.value = null
  addError.value = ''
  conflictSlug.value = ''
  addingSlug.value = ''
}

async function saveNote(): Promise<void> {
  if (!report.value || savingNote.value || savedNote.value) return
  savingNote.value = true
  saveError.value = ''
  try {
    const entry = await saveReportAsNote(report.value)
    savedNote.value = { slug: entry.slug, title: entry.title }
  } catch (err: unknown) {
    saveError.value = friendlyError(err, 'That note could not be saved. Please try again.')
  } finally {
    savingNote.value = false
  }
}

async function togglePicker(): Promise<void> {
  pickerOpen.value = !pickerOpen.value
  if (!pickerOpen.value || pagesLoaded.value || pagesLoading.value) return
  pagesLoading.value = true
  try {
    pages.value = await fetchCatalog({ kind: 'wiki' })
    pagesLoaded.value = true
  } catch {
    addError.value = 'The list of pages could not be loaded. Please try again.'
  } finally {
    pagesLoading.value = false
  }
}

const filteredPages = computed(() => {
  const needle = pageQuery.value.trim().toLowerCase()
  const matches = needle ? pages.value.filter(p => p.title.toLowerCase().includes(needle)) : pages.value
  return matches.slice(0, 12)
})

async function addToPage(slug: string): Promise<void> {
  if (!report.value || addingSlug.value) return
  addingSlug.value = slug
  addError.value = ''
  conflictSlug.value = ''
  try {
    addedPage.value = await addReportToPage(slug, report.value)
    pickerOpen.value = false
  } catch (err: unknown) {
    if (err instanceof WikiConflictError) {
      // Nothing was written. Re-reading is the whole fix, so offer it.
      conflictSlug.value = slug
      addError.value = 'That page changed while you were reading it. Nothing was added yet.'
    } else {
      addError.value = friendlyError(err, 'That report could not be added to the page.')
    }
  } finally {
    addingSlug.value = ''
  }
}

/**
 * The URL runs the report. Registered down here, after the state it resets,
 * because `immediate: true` fires during setup and a watcher declared earlier
 * would reach for refs that do not exist yet.
 */
watch(request, () => void run(), { immediate: true, deep: true })

// --- Download ----------------------------------------------------------------

let objectUrl = ''
function releaseUrl(): void {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = ''
  }
}
onBeforeUnmount(releaseUrl)

function downloadCsv(): void {
  if (!report.value) return
  releaseUrl()
  objectUrl = URL.createObjectURL(new Blob([reportCsv(report.value)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = reportCsvFilename(report.value)
  link.click()
}
</script>

<template>
  <div class="place-view">
    <div class="place-panel">
      <header class="place-header">
        <h1 data-testid="place-heading">Check a place</h1>
        <p class="lede">
          Give an address, a point, or a county. Every data source that covers it is run at once — the sites nearby, the
          flood zones, the county's numbers — and the answer says which sources found something and which had nothing.
        </p>
        <!-- P7-1: running inside a working set. Said before the form, because
             it changes what the answer will be, and with the way out beside
             it — a scope you cannot see is a scope you cannot leave. -->
        <p v-if="scopedSet" class="scope-note" data-testid="place-scope">
          Inside the working set <strong>{{ scopedSetName || scopedSet }}</strong> — only its sources will be asked.
          <button type="button" class="link-btn" data-testid="place-scope-clear" @click="clearScope">
            Ask every source instead
          </button>
        </p>
      </header>
      <KbNav />

      <section class="form-card" data-testid="place-form">
        <form class="address-row" @submit.prevent="submitAddress">
          <label class="field-label" for="place-address">Address or place</label>
          <div class="field-row">
            <input
              id="place-address"
              v-model="addressInput"
              type="text"
              class="text-input"
              :maxlength="300"
              placeholder="55 Trinity Ave SW, Atlanta, GA"
              data-testid="place-address"
            />
            <button type="submit" class="tool-btn touch-target primary" :disabled="loading || !addressInput.trim()" data-testid="place-run">
              Run
            </button>
          </div>
        </form>

        <div class="split">
          <div class="field">
            <label class="field-label" for="place-county">Or a county</label>
            <input
              id="place-county"
              v-model="countyQuery"
              type="search"
              class="text-input"
              placeholder="Search counties by name or state…"
              data-testid="place-county-search"
            />
            <ul v-if="countyMatches.length" class="matches" data-testid="place-county-matches">
              <li v-for="match in countyMatches" :key="match.geoId">
                <button type="button" class="match-btn touch-target" data-testid="place-county-match" @click="submitCounty(match.geoId)">
                  {{ match.county }}, {{ match.state }}
                </button>
              </li>
            </ul>
          </div>

          <div class="field">
            <label class="field-label" for="place-radius">How far to look</label>
            <div class="field-row">
              <input
                id="place-radius"
                v-model.number="radiusInput"
                type="number"
                class="text-input narrow"
                min="0.1"
                :max="RADIUS_MAX_MILES"
                step="0.5"
                data-testid="place-radius"
              />
              <span class="unit">miles</span>
            </div>
            <button
              v-if="mapCentre"
              type="button"
              class="tool-btn touch-target"
              data-testid="place-map-centre"
              @click="useMapCentre"
            >
              Use the map's centre
            </button>
          </div>
        </div>
      </section>

      <div v-if="loading" class="progress" data-testid="place-progress" role="status" aria-live="polite">
        <p class="state-note progress-line">{{ progressLine }}</p>
        <p v-if="progressSecond" class="progress-note" data-testid="place-progress-note">{{ progressSecond }}</p>
      </div>
      <p v-else-if="error" class="state-note error" data-testid="place-error">{{ error }}</p>
      <p v-else-if="!request" class="state-note" data-testid="place-empty">
        Nothing checked yet. Type an address above, or pick a county.
      </p>

      <template v-else-if="report">
        <div class="result-head">
          <h2 class="place-label" data-testid="place-result-label">{{ report.place.label }}</h2>
          <!-- P6-26: where, how far, and whether these numbers are today's. -->
          <p class="place-sub" data-testid="place-sub">
            <template v-if="report.place.county">{{ report.place.county }}, {{ report.place.state }} · </template>
            {{ report.radiusMiles }} miles ·
            <span class="freshness" :class="{ cached: report.cached }" data-testid="place-generated">
              {{ freshnessPhrase(report) }}
            </span>
          </p>
        </div>

        <!-- P6-17: the answer, then the evidence. The page used to open with
             forty cards and no answer to "what should I look at first". -->
        <section v-if="verdict" class="card verdict-card" data-testid="place-verdict">
          <p class="verdict-headline" data-testid="place-verdict-headline">{{ verdict.headline }}</p>
          <ul v-if="verdict.standouts.length" class="standouts" data-testid="place-standouts">
            <li v-for="s in verdict.standouts" :key="s.slug">
              <a :href="s.anchor" class="standout-name" data-testid="place-standout" @click="jumpToSection(s.anchor, $event)">{{ s.title }}</a>
              <span class="standout-count">{{ s.phrase }}</span>
            </li>
          </ul>
          <p v-if="verdict.rest" class="verdict-rest" data-testid="place-verdict-rest">{{ verdict.rest }}</p>
        </section>

        <div class="toolbar">
          <button type="button" class="tool-btn touch-target" data-testid="place-rerun" :disabled="loading" @click="run(true)">Run again</button>
          <button type="button" class="tool-btn touch-target" data-testid="place-save-note" :disabled="savingNote || !!savedNote" @click="saveNote">
            {{ savingNote ? 'Saving…' : 'Save as note' }}
          </button>
          <button type="button" class="tool-btn touch-target" data-testid="place-add-to-page" :aria-expanded="pickerOpen" @click="togglePicker">
            Add to page…
          </button>
          <button type="button" class="tool-btn touch-target" data-testid="place-download" @click="downloadCsv">Download CSV</button>
          <RouterLink :to="mapUrlFor(report)" class="tool-btn touch-target" data-testid="place-map">Show on map</RouterLink>
          <span v-if="savedNote" class="kept" data-testid="place-note-saved">
            Saved — <RouterLink :to="`/library/${savedNote.slug}`" data-testid="place-note-link">open note</RouterLink>
          </span>
          <span v-if="addedPage" class="kept" data-testid="place-page-added">
            Added — <RouterLink :to="`/wiki/${addedPage.slug}`" data-testid="place-page-link">open page</RouterLink>
          </span>
          <span v-if="saveError" class="kept bad" data-testid="place-save-error">{{ saveError }}</span>
        </div>

        <div v-if="pickerOpen" class="page-picker" data-testid="place-page-picker">
          <input
            v-model="pageQuery"
            type="search"
            class="text-input"
            placeholder="Find a page…"
            aria-label="Find a page"
            data-testid="place-page-search"
          />
          <p v-if="pagesLoading" class="picker-note">Loading pages…</p>
          <p v-else-if="!filteredPages.length" class="picker-note" data-testid="place-page-empty">No page matches.</p>
          <ul v-else class="picker-list">
            <li v-for="p in filteredPages" :key="p.slug">
              <button type="button" class="match-btn touch-target" data-testid="place-page-option" :disabled="!!addingSlug" @click="addToPage(p.slug)">
                {{ p.title }}
              </button>
            </li>
          </ul>
          <p v-if="addError" class="picker-note bad" data-testid="place-add-error">
            {{ addError }}
            <button v-if="conflictSlug" type="button" class="link-btn" data-testid="place-add-retry" @click="addToPage(conflictSlug)">
              Try again
            </button>
          </p>
        </div>

        <section v-if="report.summary" class="card summary-card" data-testid="place-summary">
          <h3 class="card-title">What this adds up to</h3>
          <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown -->
          <div class="summary-text" v-html="summaryHtml"></div>
          <ol v-if="report.summary.sources.length" class="summary-sources" data-testid="place-summary-sources">
            <li v-for="s in report.summary.sources" :key="s.n">
              <a
                :href="citationHref(s)"
                class="cite"
                data-testid="place-summary-source"
                @click="jumpToSection(citationHref(s), $event)"
              >[{{ s.n }}] {{ s.title }}</a>
            </li>
          </ol>
        </section>

        <section v-if="report.county" id="county" class="card county-card" data-testid="place-county">
          <h3 class="card-title">{{ report.county.name }}<span v-if="report.county.state">, {{ report.county.state }}</span></h3>
          <ul class="layer-list">
            <li v-for="layer in report.county.layers" :key="layer.id" data-testid="place-county-layer">
              <span class="layer-name">{{ layer.name }}</span>
              <span class="layer-value">{{ layer.formatted }}</span>
              <span class="layer-direction">{{ directionCue(layer.direction) }}</span>
            </li>
          </ul>
          <p v-if="!report.county.layers.length" class="card-note">No county numbers for this one yet.</p>
          <p class="card-links">
            <RouterLink :to="compareUrlFor(report.county)" class="touch-target" data-testid="place-compare">Compare</RouterLink>
            <RouterLink :to="mapUrlFor(report)" class="touch-target" data-testid="place-county-map">Show on map</RouterLink>
          </p>
        </section>

        <section class="sections" data-testid="place-sections">
          <!-- P5-65: "Sources" is what the citations under an Ask answer are
               called; what this page runs is the data-source registry. -->
          <h3 class="section-name">Data sources checked</h3>
          <!-- P5-63/P6-17: what was found, under the same plain-word headings
               the library files by; then one row each for what found nothing
               and what could not be checked. Nothing is removed — every card
               that was in the flat list is one press away. -->
          <template v-for="row in rows" :key="row.key">
            <h4
              v-if="row.kind === 'head'"
              class="topic-heading"
              :class="{ quiet: !row.group.open }"
            >
              <button
                type="button"
                class="fold-toggle"
                :aria-expanded="isOpen(row.group)"
                :data-topic="row.group.id"
                data-testid="place-topic-heading"
                @click="toggleGroup(row.group)"
              >
                <span class="fold-caret" aria-hidden="true">{{ isOpen(row.group) ? '▾' : '▸' }}</span>
                <span class="fold-label">{{ row.group.label }}</span>
                <span class="fold-count">· {{ groupCountLine(row.group.count) }}</span>
              </button>
            </h4>
            <article
              v-else
              :id="`section-${row.section.slug}`"
              class="card section-card"
              :class="`status-${row.section.status}`"
              data-testid="place-section"
              :data-status="row.section.status"
            >
              <div class="section-head">
                <h5 class="section-title">{{ row.section.title }}</h5>
                <span class="provider">{{ row.section.provider }}</span>
              </div>
              <p class="status-chip" :class="`chip-${row.section.status}`" data-testid="place-section-status">
                {{ statusPhrase(row.section, report.radiusMiles) }}
              </p>

              <div v-if="row.section.rows.length" class="table-scroll">
                <table class="rows-table" data-testid="place-section-table">
                  <thead>
                    <tr>
                      <th v-for="c in shownColumns(row.section)" :key="c">{{ c }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(dataRow, i) in row.section.rows" :key="i">
                      <td v-for="c in shownColumns(row.section)" :key="c">{{ dataRow[c] }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <p class="card-links">
                <RouterLink v-if="row.section.cacheKey" :to="row.section.href" class="touch-target" data-testid="place-section-slice">
                  Open the full slice
                </RouterLink>
                <RouterLink :to="`/library/${row.section.slug}`" class="touch-target" data-testid="place-section-about">
                  About this source
                </RouterLink>
              </p>
            </article>
          </template>
        </section>

        <section v-if="report.organizations.length" id="organizations" class="card orgs-card" data-testid="place-organizations">
          <h3 class="card-title">Organizations nearby</h3>
          <ul class="org-list">
            <li v-for="org in report.organizations" :key="org.name" data-testid="place-organization">
              <RouterLink :to="org.href" class="org-name">{{ org.name }}</RouterLink>
              <span class="org-distance">{{ org.distanceMiles }} miles</span>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.place-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
  /* P5-60, the page-overflow fix. App.vue lays the shell out with
     `display: flex` on `main`, so this route root is a flex item, and a flex
     item's automatic minimum size is its content's min-content width — the
     widest table on the page. Without this the whole document scrolls
     sideways however well the table's own wrapper clips. */
  min-width: 0;
}

.place-panel {
  width: 100%;
  max-width: 900px;
  /* The compact source tables scroll inside their cards; this keeps their
     width from reaching the page (P5-60). */
  min-width: 0;
}

/* P9-15: one page-title treatment across the app. */
.place-header h1 {
  margin: 0 0 4px;
  font-family: var(--blo-font-display);
  font-size: 1.7rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.scope-note {
  margin: 0 0 10px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.lede {
  margin: 0 0 8px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--blo-stone);
}

.form-card,
.card {
  padding: 14px 16px;
  margin-bottom: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.field-label {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--blo-stone-soft);
}

.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.text-input {
  flex: 1;
  width: 100%;
  padding: 8px 12px;
  font: inherit;
  font-size: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.text-input.narrow {
  flex: 0 0 96px;
  width: 96px;
}

.unit {
  font-size: 13px;
  color: var(--blo-stone);
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); /* minmax(0, …): a bare 1fr keeps a min-content floor */
  gap: 16px;
  margin-top: 12px;
}

.field .tool-btn {
  margin-top: 8px;
}

.matches,
.picker-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 190px;
  overflow-y: auto;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.match-btn {
  display: block;
  width: 100%;
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--blo-ink);
  background: none;
  border: 0;
  cursor: pointer;
}

.match-btn:hover:not(:disabled) {
  background: var(--blo-cream-deep);
}

.result-head {
  margin: 18px 2px 10px;
}

.place-label {
  margin: 0;
  font-size: 20px;
  color: var(--blo-ink);
}

.place-sub {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.tool-btn {
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  cursor: pointer;
  text-decoration: none;
}

.tool-btn:hover:not(:disabled) {
  border-color: var(--blo-green-deep);
  color: var(--blo-green-deep);
}

.tool-btn:disabled {
  color: var(--blo-stone-soft);
  cursor: default;
}

.tool-btn.primary {
  color: #fff;
  background: var(--blo-green-deep);
  border-color: var(--blo-green-deep);
}

.tool-btn.primary:hover:not(:disabled) {
  color: #fff;
}

.kept {
  font-size: 13px;
  color: var(--blo-stone);
}

.kept.bad,
.picker-note.bad {
  color: #b71c1c;
}

.page-picker {
  padding: 12px 14px;
  margin-bottom: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
}

.picker-note {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.link-btn {
  padding: 0;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep);
  background: none;
  border: 0;
  cursor: pointer;
  text-decoration: underline;
}

.state-note {
  margin: 16px 2px;
  font-size: 14px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b71c1c;
}

.card-title {
  margin: 0 0 8px;
  font-size: 16px;
  color: var(--blo-ink);
}

.summary-card {
  border-left: 3px solid var(--blo-green-deep);
}

.summary-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--blo-ink);
}

.summary-text :deep(p) {
  margin: 0 0 8px;
}

.summary-sources {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 13px;
}

.cite {
  color: var(--blo-green-deep);
  text-decoration: none;
}

.cite:hover {
  text-decoration: underline;
}

.layer-list,
.org-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.layer-list li,
.org-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
}

.layer-name,
.org-name {
  flex: 1;
  color: var(--blo-ink);
}

.org-name {
  text-decoration: none;
  color: var(--blo-green-deep);
  font-weight: 600;
}

.layer-value {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.layer-direction,
.org-distance {
  font-size: 11px;
  color: var(--blo-stone-soft);
}

.card-note {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.card-links {
  display: flex;
  gap: 14px;
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 600;
}

.card-links a {
  color: var(--blo-green-deep);
  text-decoration: none;
}

.card-links a:hover {
  text-decoration: underline;
}

/* P5-63: a quiet subject heading between the report's cards. P6-17 made it
   the fold control for its group, the way `GroupedList` heads a browse group
   — same caret, same count, same `aria-expanded`. */
.topic-heading {
  margin: 18px 0 6px;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6558);
}

.fold-toggle {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 4px 2px;
  font: inherit;
  color: inherit;
  text-align: left;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--blo-cream-divider);
  cursor: pointer;
}

.fold-toggle:hover {
  color: var(--blo-green-deep);
}

.fold-caret {
  font-size: 11px;
  letter-spacing: 0;
}

.fold-count {
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  font-variant-numeric: tabular-nums;
  color: var(--blo-stone-soft);
}

/* A group that arrives folded is housekeeping — what found nothing, what we
   could not ask. Quieter until somebody goes looking for it. */
.topic-heading.quiet .fold-label {
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0;
  font-size: 14px;
}

/* --- The verdict (P6-17) --------------------------------------------------- */

.verdict-card {
  border-left: 3px solid var(--blo-green-deep);
}

.verdict-headline {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--blo-ink);
}

.standouts {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 4px;
}

.standouts li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 14px;
}

.standout-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--blo-green-deep);
  text-decoration: none;
}

.standout-name:hover {
  text-decoration: underline;
}

.standout-count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--blo-stone-soft);
}

.verdict-rest {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--blo-stone-soft);
}

/* P6-26: a cached copy says so, in the header, where the date is. */
.freshness.cached {
  font-weight: 600;
  color: var(--blo-stone);
}

/* P6-16: what the run is doing, and under it how long it has been doing it. */
.progress {
  margin: 16px 2px;
}

.progress-line {
  margin: 0;
}

.progress-note {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--blo-stone-soft);
  font-variant-numeric: tabular-nums;
}

.section-name {
  margin: 20px 2px 8px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft);
}

.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.section-title {
  margin: 0;
  font-size: 15px;
  color: var(--blo-ink);
}

.provider {
  font-size: 12px;
  color: var(--blo-stone-soft);
}

.status-chip {
  margin: 6px 0 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.chip-found {
  font-weight: 600;
  color: var(--blo-green-deep);
}

.chip-failed,
.chip-timeout {
  color: #b71c1c;
}

.section-card {
  min-width: 0;
  max-width: 100%;
}

/* A check-by-hand reason or a failure reason can carry a long URL with no
   break opportunity; on a phone that ran 495 px inside a 317 px card and
   scrolled the whole page sideways. Let long tokens break anywhere. */
.section-card p,
.status-chip,
.card-links {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.section-card.status-none,
.section-card.status-skipped,
.section-card.status-failed,
.section-card.status-timeout {
  background: var(--blo-cream-deep);
}

.table-scroll {
  margin-top: 10px;
  overflow-x: auto;
  max-width: 100%;
}

.rows-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.rows-table th,
.rows-table td {
  padding: 5px 10px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.rows-table thead th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--blo-stone);
}

@media (max-width: 720px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* --- Phone (P5-60) ---------------------------------------------------------
   The report reads top to bottom: the form stacks (address + Run on one
   44 px row, county search full width, radius its own field), the county's
   numbers go two-up so the card is short enough to take in, every section is
   a full-width card, and the action row becomes a strip you swipe. */
@media (max-width: 640px) {
  .place-view {
    padding: 20px 12px 40px;
  }

  .place-header h1 {
    font-size: clamp(20px, 6.5vw, 1.7rem);
  }

  .lede,
  .state-note,
  .picker-note,
  .kept,
  .card-note,
  .place-sub {
    font-size: 14px;
  }

  .field-label {
    font-size: 13px;
  }

  .text-input {
    min-height: 44px;
    font-size: 16px;
  }

  /* Address and Run stay on one line — Run is the whole point of the field. */
  .address-row .field-row {
    gap: 8px;
  }

  .address-row .tool-btn {
    flex: 0 0 auto;
  }

  .text-input.narrow {
    flex: 0 0 96px;
    min-height: 44px;
  }

  .unit {
    font-size: 14px;
  }

  .tool-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 14px;
    font-size: 14px;
  }

  .match-btn {
    min-height: 44px;
    font-size: 15px;
  }

  /* P6-28: the actions wrap. They used to be one swipeable `.strip` line —
     measured at 390 px that was 625 px of buttons in a 366 px box, so
     "Download CSV" and "Show on map" were entirely off-screen. The shared
     `.strip` fade mask was already on this element and the audit still found
     them undiscoverable, which is the case against adding a louder hint: a
     swipe nobody takes hides two actions, and two rows of 46 px hides none.
     Everything still has to stay inside the card, which is what the three
     width rules are for. */
  .toolbar {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    flex-wrap: wrap;
    row-gap: 8px;
  }

  /* A button never shrinks below its label; a "Saved — open note" note takes
     the rest of the row it lands on rather than squeezing its neighbours. */
  .toolbar > .tool-btn {
    flex: 0 0 auto;
  }

  .toolbar > .kept {
    flex: 1 0 100%;
  }

  .place-label {
    font-size: 18px;
    overflow-wrap: anywhere;
  }

  .card-title,
  .section-title {
    font-size: 16px;
  }

  .summary-sources,
  .status-chip {
    font-size: 14px;
  }

  /* The fold control is the thing you press most on this page. */
  .fold-toggle {
    min-height: 44px;
    font-size: 14px;
  }

  .verdict-headline {
    font-size: 16px;
  }

  .standouts li,
  .standout-count,
  .verdict-rest,
  .progress-note {
    font-size: 14px;
  }

  /* A source title and its count stack rather than squeezing each other. */
  .standouts li {
    flex-direction: column;
    align-items: flex-start;
    gap: 0;
    min-height: 44px;
    justify-content: center;
  }

  /* The county's numbers, two to a row. */
  .county-card .layer-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .county-card .layer-list li {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 8px 10px;
    background: var(--blo-cream);
    border-radius: 8px;
    font-size: 14px;
  }

  .county-card .layer-name {
    flex: 0 0 auto;
  }

  .layer-direction,
  .org-distance,
  .provider {
    font-size: 13px;
  }

  .org-list li {
    min-height: 44px;
    font-size: 15px;
  }

  /* "Open the full slice" and its neighbours are buttons down here. */
  .card-links {
    flex-wrap: wrap;
    gap: 8px;
    font-size: 14px;
  }

  .card-links a {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--blo-cream-divider);
    border-radius: 8px;
  }

  .rows-table {
    font-size: 14px;
  }

  .rows-table thead th {
    font-size: 13px;
  }

  .page-picker .picker-list {
    max-height: 240px;
  }
}
</style>
