<template>
  <div class="prompt-panel" style="pointer-events: auto" @click.stop>
    <!-- Chat panel (silent auto-session — no password gate) -->
    <div class="prompt-main">
      <!-- Input row: the "Ask" input — unmistakably the AI entry point -->
      <form @submit.prevent="handleSubmit" class="prompt-form" :class="{ 'prompt-form--thinking': isThinking }">
        <span class="prompt-leading" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
            <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
          </svg>
        </span>
        <input
          v-model="query"
          type="text"
          placeholder="Ask about a place or the data — e.g., 'top 5 affordable counties' or 'Mecklenburg County'"
          class="prompt-input"
          :disabled="isThinking"
          aria-label="Ask about a place or the data"
          aria-autocomplete="list"
          :aria-activedescendant="highlightedIndex >= 0 ? 'place-suggestion-' + highlightedIndex : undefined"
          maxlength="500"
          @keydown="onKeydown"
        />
        <button type="submit" class="prompt-submit" :disabled="isThinking || !query.trim()">
          <span v-if="!isThinking">Ask</span>
          <span v-else class="prompt-spinner"></span>
        </button>
        <button
          v-if="messages.length > 0"
          type="button"
          class="prompt-clear"
          @click="clearConversation"
          aria-label="Clear conversation"
          title="Clear conversation"
        >×</button>
      </form>

      <!-- Inline place-suggestion strip — shows when input pattern-matches a place
           lookup AND no data-query verbs trip the suppression heuristic. Click
           routes to the map (zoom + marker); Enter without highlight still
           submits to chat. -->
      <ul
        v-if="placeSuggestions.length > 0 && !isThinking"
        class="place-strip"
        role="listbox"
        aria-label="Place suggestions"
      >
        <li
          v-for="(s, i) in placeSuggestions"
          :key="s.id"
          :id="'place-suggestion-' + i"
          role="option"
          :aria-selected="i === highlightedIndex"
          class="place-suggestion"
          :class="{ 'place-suggestion--active': i === highlightedIndex }"
          @click="selectSuggestion(s)"
          @mouseenter="highlightedIndex = i"
        >
          <span class="place-pin" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </span>
          <span class="place-text">
            <span class="place-name">{{ s.name }}</span>
            <span v-if="s.context" class="place-context">{{ s.context }}</span>
          </span>
          <span v-if="i === highlightedIndex" class="place-enter-hint" aria-hidden="true">↩</span>
        </li>
      </ul>

      <!-- Phase 4d L2: active-query strip removed — content moved to the
           Lens header (bottom-left). PromptInput is now strictly the
           input + chat. The Map.vue Lens owns "what am I looking at." -->

      <!-- Suggested chips (only when conversation is empty) -->
      <div v-if="messages.length === 0 && !isThinking" class="prompt-chips">
        <button
          v-for="chip in suggestedQueries"
          :key="chip"
          class="prompt-chip"
          @click="submitChip(chip)"
          :disabled="isThinking"
        >{{ chip }}</button>
      </div>

      <!-- Conversation history -->
      <div v-if="messages.length > 0 || isThinking" class="chat-history" :class="{ collapsed: !historyExpanded }">
        <div class="chat-history-header">
          <span class="chat-history-count">{{ visibleMessages.length }} message{{ visibleMessages.length === 1 ? '' : 's' }}</span>
          <button
            type="button"
            class="chat-toggle"
            @click="historyExpanded = !historyExpanded"
            :aria-label="historyExpanded ? 'Collapse conversation' : 'Expand conversation'"
          >{{ historyExpanded ? '▼' : '▲' }}</button>
        </div>
        <div v-if="historyExpanded" ref="scrollRef" class="chat-messages">
          <div
            v-for="(msg, idx) in visibleMessages"
            :key="idx"
            class="chat-message"
            :class="msg.role"
          >
            <div
              v-if="msg.displayText && msg.role === 'assistant'"
              class="chat-text"
              v-html="renderMarkdown(msg.displayText)"
            ></div>
            <div
              v-else-if="msg.displayText"
              class="chat-text"
            >{{ msg.displayText }}</div>
            <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="chat-tools">
              <div v-for="(tc, tcIdx) in msg.toolCalls" :key="tcIdx" class="chat-tool">
                <span class="chat-tool-name">→ {{ describeToolCall(tc.name, tc.input) }}</span>
                <span v-if="tc.result" class="chat-tool-result">{{ tc.result }}</span>
              </div>
            </div>
          </div>
          <div v-if="isThinking" class="chat-message assistant thinking">
            <span class="chat-dot"></span>
            <span class="chat-dot"></span>
            <span class="chat-dot"></span>
          </div>
        </div>
      </div>

      <!-- Error -->
      <p v-if="chatError" class="prompt-error">{{ chatError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onBeforeUnmount } from 'vue'
import type { ChatMessage } from '@/composables/useChat'
import { renderMarkdown } from '@/lib/renderMarkdown'
import { MAPBOX_ACCESS_TOKEN } from '@/config/constants'

/** A Mapbox geocoder feature shape we pass back to the parent for zooming. */
export interface PlaceSuggestion {
  id: string
  name: string
  context: string
  center: [number, number]
  raw: any
}

const props = defineProps<{
  messages: ChatMessage[]
  isThinking: boolean
  chatError: string | null
  sendMessage: (text: string) => Promise<void>
  clearConversation: () => void
}>()

const emit = defineEmits<{
  (e: 'select-place', suggestion: PlaceSuggestion): void
}>()

const query = ref('')
const historyExpanded = ref(true)
const scrollRef = ref<HTMLElement | null>(null)

// ============= Phase 4c: Inline place suggestions =============
//
// As the user types, we run a debounced Mapbox geocoder lookup in the
// background. If the input pattern-matches a place query (and not a data
// query — see suppression regex), suggestions render below the input.
// Pressing Enter always submits to chat; clicking a suggestion zooms.

const placeSuggestions = ref<PlaceSuggestion[]>([])
const highlightedIndex = ref(-1) // -1 = input focused; 0..N = suggestion index
let placeAbort: AbortController | null = null
let placeDebounce: ReturnType<typeof setTimeout> | null = null

/** Tokens that signal "this is a data query, not a place lookup". When any
 *  of these patterns hit, suggestions are suppressed. We err on the side of
 *  *showing* suggestions when ambiguous — Enter still goes to chat, so the
 *  cost of a false positive is just visual noise, while a false negative
 *  hides a useful affordance. */
const SUPPRESSION_PATTERNS: RegExp[] = [
  /\b(top|best|worst|affordable|expensive|with|where|under|over|rank(?:ed|ing)?|score|index|filter|find counties|show me|rate|rates)\b/i,
  /\bmore than\b/i,
  /\bless than\b/i,
  /\bhigher than\b/i,
  /\blower than\b/i,
  /\bbetween\b.*\band\b/i,
  /\bcompared to\b/i,
  /[%$]/,
  /\b\d+\s*(percent|pct|k|thousand|million)\b/i,
]

function shouldSuppressSuggestions(text: string): boolean {
  return SUPPRESSION_PATTERNS.some((re) => re.test(text))
}

async function fetchPlaceSuggestions(text: string, signal: AbortSignal): Promise<PlaceSuggestion[]> {
  if (!MAPBOX_ACCESS_TOKEN) return []
  const encoded = encodeURIComponent(text)
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json` +
    `?access_token=${MAPBOX_ACCESS_TOKEN}` +
    `&country=us&types=district,region,place&limit=4&autocomplete=true`
  const res = await fetch(url, { signal })
  if (!res.ok) return []
  const data = await res.json()
  return (data.features || []).map((f: any) => ({
    id: f.id,
    name: f.text,
    context: f.place_name?.replace(new RegExp('^' + (f.text || '') + ',?\\s*'), '') || '',
    center: f.center as [number, number],
    raw: f,
  }))
}

watch(query, (text) => {
  highlightedIndex.value = -1
  if (placeDebounce) clearTimeout(placeDebounce)
  if (placeAbort) placeAbort.abort()

  const trimmed = text.trim()
  if (!trimmed || shouldSuppressSuggestions(trimmed)) {
    placeSuggestions.value = []
    return
  }

  placeDebounce = setTimeout(async () => {
    const ctrl = new AbortController()
    placeAbort = ctrl
    try {
      const results = await fetchPlaceSuggestions(trimmed, ctrl.signal)
      // Race guard: only commit if this is still the active query
      if (query.value.trim() === trimmed) {
        placeSuggestions.value = results
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') placeSuggestions.value = []
    }
  }, 150)
})

onBeforeUnmount(() => {
  if (placeDebounce) clearTimeout(placeDebounce)
  if (placeAbort) placeAbort.abort()
})

function selectSuggestion(s: PlaceSuggestion): void {
  emit('select-place', s)
  query.value = ''
  placeSuggestions.value = []
  highlightedIndex.value = -1
}

/** Keyboard navigation between input and suggestion strip. */
function onKeydown(e: KeyboardEvent): void {
  if (placeSuggestions.value.length === 0) {
    // No suggestions — Enter falls through to form submit handler
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlightedIndex.value = Math.min(highlightedIndex.value + 1, placeSuggestions.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlightedIndex.value = Math.max(highlightedIndex.value - 1, -1)
  } else if (e.key === 'Escape') {
    placeSuggestions.value = []
    highlightedIndex.value = -1
  } else if (e.key === 'Enter' && highlightedIndex.value >= 0) {
    // A suggestion is highlighted — pick it instead of submitting to chat
    e.preventDefault()
    const s = placeSuggestions.value[highlightedIndex.value]
    if (s) selectSuggestion(s)
  }
  // Otherwise Enter goes through to form @submit (chat path)
}

const suggestedQueries = [
  'Show me the top 5 counties for Black homeownership',
  'Affordable counties with low pollution',
  'Zoom to Mecklenburg County, NC',
]

/** Only show messages that have something to display (skip empty tool_result messages) */
const visibleMessages = computed(() =>
  props.messages.filter((m) => m.displayText || (m.toolCalls && m.toolCalls.length > 0))
)

function describeToolCall(name: string, input: any): string {
  switch (name) {
    case 'zoom_to_county':
      return `Zoom to ${input.county_name}${input.state ? ', ' + input.state : ''}`
    case 'search_housing':
      return `Search housing in ${input.county_name}${input.state ? ', ' + input.state : ''}`
    case 'set_layer_selection':
      return `Apply ${input.layers?.length || 0} scoring layers`
    case 'toggle_ranking_panel':
      return input.expanded ? 'Open ranking panel' : 'Close ranking panel'
    case 'filter_ranking_by_state':
      return input.state ? `Filter ranking to ${input.state}` : 'Clear ranking filter'
    case 'show_county_details':
      return `Show details for ${input.county_name}${input.state ? ', ' + input.state : ''}`
    default:
      return name
  }
}

async function handleSubmit() {
  const text = query.value.trim()
  if (!text || props.isThinking) return
  query.value = ''
  historyExpanded.value = true
  await props.sendMessage(text)
}

async function submitChip(chip: string) {
  query.value = chip
  await handleSubmit()
}

// Scroll the LATEST message to the TOP of the scroll area when a new
// message arrives. The previous behavior (scrollTop = scrollHeight)
// pinned the very BOTTOM in view, which on multi-paragraph assistant
// replies meant the user saw the closing line and had to scroll up to
// read what was actually being said. Top-aligned puts the new message's
// opening words in their eyeline.
watch(() => props.messages.length, () => {
  nextTick(() => {
    if (!scrollRef.value) return
    const items = scrollRef.value.querySelectorAll('.chat-message')
    const last = items[items.length - 1] as HTMLElement | undefined
    if (last) {
      // offsetTop is relative to the scroll container's offsetParent — for
      // a position:relative container, that's the container itself.
      scrollRef.value.scrollTop = last.offsetTop - 8
    }
  })
})
</script>

<style scoped>
/* Phase 4c: unified input now claims the full top-of-map width minus
   the right-side Data Layers pill. The geocoder used to sit at left:10
   in 220px; that real estate is now part of this single input. */
.prompt-panel {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 270px;
  z-index: 5;
  max-width: 720px;
}

/* The "Ask" input — reserved orange accent makes it unmistakably the AI entry point */
.prompt-form {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--blo-cream);
  border: 1px solid var(--blo-orange-ring);
  border-radius: var(--blo-radius-input);
  box-shadow: var(--blo-shadow-panel);
  padding: 4px 4px 4px 12px;
  transition: box-shadow 120ms ease, border-color 120ms ease;
}

.prompt-form:focus-within {
  border-color: var(--blo-orange);
  box-shadow: 0 0 0 3px var(--blo-orange-soft), var(--blo-shadow-panel);
}

.prompt-form--thinking {
  border-color: var(--blo-orange);
  box-shadow: 0 0 0 3px var(--blo-orange-soft), var(--blo-shadow-panel);
}

.prompt-leading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--blo-orange);
  flex-shrink: 0;
}

.prompt-input {
  flex: 1;
  border: none;
  padding: 8px 10px;
  font-size: 14px;
  background: transparent;
  color: var(--blo-ink);
  border-radius: 4px;
  outline: none;
  min-width: 0;
}

.prompt-input::placeholder {
  color: var(--blo-stone);
  font-style: italic;
}

.prompt-submit {
  padding: 8px 18px;
  background: var(--blo-orange);
  color: white;
  border: none;
  border-radius: var(--blo-radius-input);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 120ms ease;
}
.prompt-submit:hover { background: var(--blo-orange-deep); }
.prompt-submit:disabled {
  background: var(--blo-stone-soft);
  cursor: not-allowed;
}

.prompt-clear {
  padding: 0 10px;
  background: transparent;
  color: var(--blo-stone);
  border: none;
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
}
.prompt-clear:hover { color: var(--blo-ink); }

.prompt-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Inline place-suggestion strip — sits directly under the Ask input pill.
   Visually distinct from the example chips below (rectangular, list-style)
   so users read it as "did you mean a place?" not "preset queries". */
.place-strip {
  list-style: none;
  margin: 6px 0 0;
  padding: 4px;
  background: white;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: var(--blo-shadow-panel);
  overflow: hidden;
  animation: place-fade-in 140ms ease-out;
}
@keyframes place-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.place-suggestion {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.3;
  color: var(--blo-ink-soft, #2a2a2a);
  transition: background 100ms ease;
}
.place-suggestion + .place-suggestion {
  margin-top: 2px;
}
.place-suggestion:hover,
.place-suggestion--active {
  background: var(--blo-cream, #f7f4ee);
  color: var(--blo-ink, #111);
}

.place-pin {
  display: inline-flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  color: var(--blo-green-deep, #1f7a2e);
  flex-shrink: 0;
}

.place-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.place-name {
  font-weight: 600;
  color: var(--blo-ink, #111);
}
.place-context {
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.place-enter-hint {
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  margin-left: auto;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--blo-cream-deep, #ede8dd);
}

/* Phase 4d L2: active-query CSS removed — chips now live in Lens header */

/* Suggested starter chips */
.prompt-chips {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  flex-wrap: wrap;
}

.prompt-chip {
  padding: 4px 10px;
  background: white;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-input);
  font-size: 11px;
  color: var(--blo-stone);
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: 0 1px 3px rgba(17, 17, 17, 0.06);
}

.prompt-chip:hover {
  border-color: var(--blo-orange-ring);
  color: var(--blo-orange-deep);
  /* Opaque peach. The previous --blo-orange-soft is rgba(255,107,28,0.10),
     which on hover REPLACED the chips white background — the underlying
     map bled through and made the chip text fight with road labels.
     This solid color matches the visual intent of orange-soft over
     white without being transparent. */
  background: #fff0e6;
}

.prompt-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Chat history — desktop: left-anchored column so the map center stays
   visible. Mobile: overrides below revert to the original inline flow.
   top value chosen to clear the Ask input + any active-query status strip
   sitting at top-center. */
.chat-history {
  position: fixed;
  top: 220px;
  left: 10px;
  width: 340px;
  /* Leave room for Color Key + County Averages stack at bottom-left */
  max-height: calc(100vh - 480px);
  z-index: 4;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: var(--blo-shadow-panel);
  overflow: hidden;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
}

.chat-history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--blo-cream-divider);
  font-size: 11px;
  color: var(--blo-stone);
}

.chat-toggle {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 10px;
  color: var(--blo-stone);
}

.chat-messages {
  /* Inside the fixed left-column card: fill what's left and scroll internally */
  flex: 1;
  min-height: 0;
  max-height: min(60vh, 480px);
  overflow-y: auto;
  padding: 8px 12px;
}

.chat-message {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.5;
}

.chat-message.user .chat-text {
  background: var(--blo-green-soft);
  padding: 6px 10px;
  border-radius: 12px 12px 4px 12px;
  display: inline-block;
  max-width: 85%;
  color: var(--blo-ink);
  margin-left: auto;
}

.chat-message.user {
  display: flex;
  justify-content: flex-end;
}

.chat-message.assistant .chat-text {
  color: var(--blo-ink-soft);
  font-family: var(--blo-font-display);
  font-weight: 400;
  font-size: 13.5px;
  line-height: 1.55;
  letter-spacing: -0.005em;
  padding: 4px 0;
  /* UX-03: gentle fade-in for assistant responses */
  animation: chat-text-in 260ms ease-out;
}

/* Markdown elements inside assistant messages. v-html renders children,
   so scoped selectors use :deep() to reach in. */
.chat-message.assistant .chat-text :deep(p) {
  margin: 0 0 8px;
}
.chat-message.assistant .chat-text :deep(p:last-child) {
  margin-bottom: 0;
}
.chat-message.assistant .chat-text :deep(strong),
.chat-message.assistant .chat-text :deep(b) {
  font-weight: 600;
  color: var(--blo-ink);
}
.chat-message.assistant .chat-text :deep(em),
.chat-message.assistant .chat-text :deep(i) {
  font-style: italic;
}
.chat-message.assistant .chat-text :deep(ul),
.chat-message.assistant .chat-text :deep(ol) {
  margin: 6px 0 8px 0;
  padding-left: 20px;
}
.chat-message.assistant .chat-text :deep(li) {
  margin: 2px 0;
}
.chat-message.assistant .chat-text :deep(a) {
  color: var(--blo-green-deep);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.chat-message.assistant .chat-text :deep(a:hover) {
  color: var(--blo-green);
}
.chat-message.assistant .chat-text :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: var(--blo-cream-deep);
  padding: 1px 5px;
  border-radius: 4px;
}

@keyframes chat-text-in {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .chat-message.assistant .chat-text {
    animation: none;
  }
}

.chat-tools {
  margin: 4px 0;
  padding-left: 10px;
  border-left: 2px solid var(--blo-cream-divider);
}

.chat-tool {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  color: var(--blo-stone);
  margin: 2px 0;
}

.chat-tool-name {
  font-style: italic;
}

.chat-tool-result {
  color: var(--blo-stone-soft);
  font-size: 10px;
  padding-left: 12px;
}

.chat-message.thinking {
  display: flex;
  gap: 4px;
  padding: 8px 0;
}

.chat-dot {
  width: 6px;
  height: 6px;
  background: var(--blo-stone-soft);
  border-radius: 50%;
  animation: blink 1.2s infinite;
}
.chat-dot:nth-child(2) { animation-delay: 0.2s; }
.chat-dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.3; }
  40% { opacity: 1; }
}

.prompt-error {
  margin: 6px 0 0;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.95);
  border-radius: 4px;
  border-left: 3px solid #c0392b;
  font-size: 12px;
  color: #c0392b;
}

@media (max-width: 768px) {
  .prompt-panel {
    position: relative;
    top: auto;
    left: auto;
    right: auto;
    max-width: none;
    margin: 8px;
  }
  /* On mobile revert chat history to inline flow — no room for a left column */
  .chat-history {
    position: relative;
    top: auto;
    left: auto;
    width: auto;
    margin-top: 8px;
    z-index: auto;
  }
  .chat-messages {
    max-height: min(25vh, 200px);
  }
}
</style>
