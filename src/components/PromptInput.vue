<template>
  <div class="prompt-panel" style="pointer-events: auto" @click.stop>
    <!-- Password gate -->
    <div v-if="!isAuthenticated" class="prompt-auth">
      <form @submit.prevent="handleAuth" class="auth-form">
        <input
          v-model="password"
          type="password"
          placeholder="Enter beta password"
          class="auth-input"
          aria-label="Beta password"
        />
        <button type="submit" class="auth-submit" :disabled="!password">Go</button>
      </form>
      <p v-if="authError" class="prompt-error">{{ authError }}</p>
    </div>

    <!-- Chat panel -->
    <div v-else class="prompt-main">
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
          placeholder="Ask a question or describe what you're looking for..."
          class="prompt-input"
          :disabled="isThinking"
          aria-label="Ask about county livability"
          maxlength="500"
          @keydown.enter.prevent="handleSubmit"
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

      <!-- Active-query status strip: visible trace of what's currently scoring the map -->
      <div v-if="hasActiveQuery" class="query-status">
        <div class="query-status-row">
          <span class="query-status-label">Scoring</span>
          <span
            v-for="chip in scoringChips"
            :key="'layer-' + chip.id"
            class="query-chip query-chip--layer"
            :title="chip.name"
          >
            {{ chip.name }}
            <span class="query-chip-arrow" :class="chip.directionClass">{{ chip.arrow }}</span>
          </span>
        </div>
        <div v-if="filterChips.length > 0 || displayLimit" class="query-status-row">
          <span v-if="filterChips.length > 0" class="query-status-label">Filter</span>
          <span
            v-for="chip in filterChips"
            :key="'filter-' + chip.key"
            class="query-chip query-chip--filter"
          >{{ chip.label }}</span>
          <span v-if="displayLimit" class="query-chip query-chip--limit">Top {{ displayLimit }}</span>
          <button
            type="button"
            class="query-clear-all"
            @click="$emit('clear-query')"
            aria-label="Clear current query"
          >Clear ×</button>
        </div>
        <div v-else class="query-status-row query-status-row--actions">
          <button
            type="button"
            class="query-clear-all"
            @click="$emit('clear-query')"
            aria-label="Clear current query"
          >Clear ×</button>
        </div>
      </div>

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
            <div v-if="msg.displayText" class="chat-text">{{ msg.displayText }}</div>
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
import { ref, computed, nextTick, watch } from 'vue'
import { usePromptQuery } from '@/composables/usePromptQuery'
import type { ChatMessage } from '@/composables/useChat'
import type { ScoringFilter } from '@/types/mapTypes'

interface ScoringChip {
  id: string
  name: string
  arrow: string
  directionClass: string
}

interface FilterChip {
  key: string
  label: string
}

const props = defineProps<{
  messages: ChatMessage[]
  isThinking: boolean
  chatError: string | null
  sendMessage: (text: string) => Promise<void>
  clearConversation: () => void
  scoringChips?: ScoringChip[]
  activeFilters?: ScoringFilter[]
  displayLimit?: number | null
}>()

defineEmits<{
  (e: 'clear-query'): void
}>()

// Reuse usePromptQuery just for authentication state
const { isAuthenticated, authenticate, error: authError } = usePromptQuery()

const password = ref('')
const query = ref('')
const historyExpanded = ref(true)
const scrollRef = ref<HTMLElement | null>(null)

const suggestedQueries = [
  'Show me the top 5 counties for Black homeownership',
  'Affordable counties with low pollution',
  'Zoom to Mecklenburg County, NC',
]

/** Only show messages that have something to display (skip empty tool_result messages) */
const visibleMessages = computed(() =>
  props.messages.filter((m) => m.displayText || (m.toolCalls && m.toolCalls.length > 0))
)

const scoringChips = computed<ScoringChip[]>(() => props.scoringChips ?? [])

const filterChips = computed<FilterChip[]>(() => {
  const filters = props.activeFilters ?? []
  return filters.map((f) => {
    let label = ''
    switch (f.operator) {
      case 'greater_than': label = `${f.layerId} > ${f.value}`; break
      case 'less_than':    label = `${f.layerId} < ${f.value}`; break
      case 'between':      label = `${f.layerId} ${f.value}-${f.max ?? '?'}`; break
      default:             label = `${f.layerId} ? ${f.value}`
    }
    return { key: `${f.layerId}-${f.operator}`, label }
  })
})

const hasActiveQuery = computed(
  () => scoringChips.value.length > 0 || filterChips.value.length > 0 || !!props.displayLimit,
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

async function handleAuth() {
  await authenticate(password.value)
  password.value = ''
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

// Auto-scroll to latest message
watch(() => props.messages.length, () => {
  nextTick(() => {
    if (scrollRef.value) {
      scrollRef.value.scrollTop = scrollRef.value.scrollHeight
    }
  })
})
</script>

<style scoped>
.prompt-panel {
  position: absolute;
  top: 10px;
  left: 310px;
  right: 270px;
  z-index: 5;
  max-width: 620px;
}

.auth-form {
  display: flex;
  gap: 4px;
  background: white;
  border-radius: var(--blo-radius-panel);
  box-shadow: var(--blo-shadow-panel);
  padding: 4px;
}

.auth-input {
  flex: 1;
  border: none;
  padding: 8px 12px;
  font-size: 14px;
  border-radius: 4px;
  outline: none;
  min-width: 0;
}

.auth-input::placeholder {
  color: var(--blo-stone-soft);
}

.auth-submit {
  padding: 8px 16px;
  background: var(--blo-ink);
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.auth-submit:hover { background: var(--blo-ink-soft); }
.auth-submit:disabled { background: var(--blo-stone-soft); cursor: not-allowed; }

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

/* Active-query status strip */
.query-status {
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(247, 244, 238, 0.96);
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.query-status-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-height: 22px;
}

.query-status-row--actions {
  justify-content: flex-end;
}

.query-status-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--blo-stone);
  margin-right: 2px;
}

.query-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 500;
  border-radius: var(--blo-radius-input);
  background: white;
  border: 1px solid var(--blo-cream-divider);
  color: var(--blo-ink-soft);
}

.query-chip--layer {
  border-color: var(--blo-green-soft);
  background: var(--blo-green-soft);
  color: var(--blo-green-deep);
}

.query-chip--filter {
  background: white;
  border-color: var(--blo-cream-divider);
  color: var(--blo-ink-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
}

.query-chip--limit {
  background: var(--blo-ink);
  color: white;
  border-color: var(--blo-ink);
  font-weight: 600;
}

.query-chip-arrow {
  font-weight: 700;
}
.query-chip-arrow.dir-higher { color: var(--blo-green-deep); }
.query-chip-arrow.dir-lower  { color: #c0392b; }

.query-clear-all {
  margin-left: auto;
  padding: 2px 10px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-stone);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--blo-radius-input);
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.query-clear-all:hover {
  color: var(--blo-ink);
  border-color: var(--blo-cream-divider);
}

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
  background: var(--blo-orange-soft);
}

.prompt-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Chat history */
.chat-history {
  margin-top: 8px;
  background: rgba(255, 255, 255, 0.98);
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: var(--blo-shadow-panel);
  overflow: hidden;
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
  /* Hard cap so the map is never occluded by a long conversation */
  max-height: min(30vh, 320px);
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
  .chat-messages {
    max-height: min(25vh, 200px);
  }
}
</style>
