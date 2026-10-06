/**
 * First-run checklist state (P5-43, rewritten for the new layout by P6-5).
 * Six things a new team member should do once, ticked off by *doing* them —
 * nobody has to remember to mark anything, and nobody is asked to sit through
 * a tour they did not want.
 *
 * The six are now one per surface: find a dataset, open a document, run an
 * analysis, ask in Chat, add something, search. Between them they visit every
 * page the header and the resource tabs offer, which is the point — the tour
 * IS the information architecture.
 *
 * Progress lives in localStorage under one key. It is progress, not content:
 * no titles, no slugs, no answers — which is why logout deliberately leaves
 * it alone (see INTERNAL_STORAGE_PREFIXES in composables/useAuth.ts). Having
 * finished the tour once should survive signing out and back in.
 */
import { computed, ref } from 'vue'

export const FIRST_RUN_KEY = 'blo:firstrun'

/**
 * The ids are storage keys and are reported by the surfaces that do the work
 * (`Map.vue`, `DatasetView.vue`, `LibraryEntryView.vue`, `NewView.vue`), so
 * they outlive the words on screen. P6-5 changed every label and every link
 * and added `search`; `start` went, because reading the hub page is a link on
 * the landing rather than a task.
 */
export type FirstRunStepId = 'data' | 'read' | 'map' | 'ask' | 'add' | 'search'

export interface FirstRunStep {
  id: FirstRunStepId
  /** The instruction, as an action: "Ask a question", not "Asking questions". */
  label: string
  /** One line saying what the person will get out of it. */
  hint: string
  href: string
}

export interface FirstRunState {
  done: FirstRunStepId[]
  dismissed: boolean
}

/** Order is the order on screen: the three resource tabs left to right, then
 *  the three things the header offers. */
const STEP_IDS: FirstRunStepId[] = ['data', 'read', 'map', 'ask', 'add', 'search']

export const FIRST_RUN_TOTAL = STEP_IDS.length

/** The six items, with links to the surface each one happens on. */
export function firstRunSteps(): FirstRunStep[] {
  return [
    {
      id: 'data',
      label: 'Find a dataset',
      hint: 'Group them by who publishes them, what they are about, or what shape they are — it ticks when you filter, sort or summarise a table.',
      href: '/datasets',
    },
    {
      id: 'read',
      label: 'Open a page or a document',
      hint: 'Everything the team has written down — it ticks when a document opens in the app.',
      href: '/docs',
    },
    {
      id: 'map',
      label: 'Run an analysis',
      hint: 'Check a place, compare counties, or show a layer on the map — it ticks when a report runs or a layer goes on.',
      href: '/analysis',
    },
    {
      id: 'ask',
      label: 'Ask Chat a question',
      hint: 'Plain English, with the library\u2019s own tools behind the answer — it ticks when you open Chat.',
      href: '/chat',
    },
    {
      id: 'add',
      label: 'Add something',
      hint: 'A link, a file, or a folder of them. Half-finished is fine — it ticks when the drop or the upload lands.',
      href: '/new',
    },
    {
      id: 'search',
      label: 'Search for something',
      hint: 'One box across every dataset, page, document and analysis — it ticks when you search.',
      href: '/search',
    },
  ]
}

// ---------------------------------------------------------------------------
// Detecting progress from the routes someone visits
// ---------------------------------------------------------------------------

/** Vue Router's LocationQuery, loosened so this module (and its tests) need
 *  no router import to describe a URL. */
export type QueryLike = Record<string, unknown>

function firstValue(query: QueryLike, key: string): string {
  const raw = query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

function has(query: QueryLike, key: string): boolean {
  return firstValue(query, key).length > 0
}

/**
 * Which checklist item (if any) this visit completes. Pure, so the rules are
 * readable in one place and testable without a router.
 *
 * P5-71's rule, kept: only a URL that could not exist unless the thing had
 * been DONE counts. `/search?q=` needs somebody to have searched and
 * `/place?address=` needs somebody to have named a place, so both are honest
 * proof. The rest are actions on a page — a drop, a viewer, a filter, a layer
 * switched on — and the surface that performs one calls
 * `completeFirstRunStep` when it happens.
 *
 * Chat is the one compromise: it holds a conversation over a POST and writes
 * nothing to the URL, so opening it is the most a route can prove. Its hint
 * says exactly that rather than pretending otherwise.
 */
export function matchFirstRunStep(path: string, query: QueryLike = {}): FirstRunStepId | null {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path

  if (clean === '/search' && has(query, 'q')) return 'search'
  if (clean === '/place' && (has(query, 'address') || has(query, 'geoid') || has(query, 'lat'))) return 'map'
  if (clean === '/chat') return 'ask'

  return null
}

// ---------------------------------------------------------------------------
// Stored progress
// ---------------------------------------------------------------------------

function readState(): FirstRunState {
  try {
    const raw = localStorage.getItem(FIRST_RUN_KEY)
    if (!raw) return { done: [], dismissed: false }
    const parsed = JSON.parse(raw) as Partial<FirstRunState>
    const done = Array.isArray(parsed?.done) ? parsed.done.filter(id => STEP_IDS.includes(id)) : []
    return { done, dismissed: parsed?.dismissed === true }
  } catch {
    // Unreadable or unparseable (private mode, hand-edited value) — start
    // clean rather than break the landing over a checklist.
    return { done: [], dismissed: false }
  }
}

function writeState(next: FirstRunState): void {
  try {
    localStorage.setItem(FIRST_RUN_KEY, JSON.stringify(next))
  } catch {
    // Storage unavailable: the checklist still works for this session.
  }
}

const state = ref<FirstRunState>(readState())

/** Read-only view for components. */
export const firstRunState = computed<FirstRunState>(() => state.value)

export const firstRunDone = computed<FirstRunStepId[]>(() => state.value.done)

export const firstRunComplete = computed(() => STEP_IDS.every(id => state.value.done.includes(id)))

/** Whether the checklist should be on screen at all. */
export const firstRunVisible = computed(() => !state.value.dismissed && !firstRunComplete.value)

/** Re-read storage — on mount, and in tests between cases. */
export function loadFirstRun(): FirstRunState {
  state.value = readState()
  return state.value
}

/**
 * Tick a step off because the person just did it (P5-71). Idempotent — the
 * surfaces call it on every drop, every filter, every layer toggle, and only
 * the first one writes anything.
 */
export function completeFirstRunStep(id: FirstRunStepId): void {
  if (!STEP_IDS.includes(id) || state.value.done.includes(id)) return
  state.value = { ...state.value, done: [...state.value.done, id] }
  writeState(state.value)
}

/** Record a visit. Returns the step it completed, if it completed one. */
export function recordFirstRunVisit(path: string, query: QueryLike = {}): FirstRunStepId | null {
  const step = matchFirstRunStep(path, query)
  if (!step || state.value.done.includes(step)) return null
  completeFirstRunStep(step)
  return step
}

/** "I know, thanks" — hidden for good, on this browser. */
export function dismissFirstRun(): void {
  state.value = { ...state.value, dismissed: true }
  writeState(state.value)
}
