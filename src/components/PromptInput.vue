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
      <!-- Input row -->
      <form @submit.prevent="handleSubmit" class="prompt-form">
        <input
          v-model="query"
          type="text"
          placeholder="Ask a question or describe what you're looking for..."
          class="prompt-input"
          :disabled="isThinking"
          aria-label="Chat input"
          maxlength="500"
          @keydown.enter.prevent="handleSubmit"
        />
        <button type="submit" class="prompt-submit" :disabled="isThinking || !query.trim()">
          <span v-if="!isThinking">Send</span>
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

const props = defineProps<{
  messages: ChatMessage[]
  isThinking: boolean
  chatError: string | null
  sendMessage: (text: string) => Promise<void>
  clearConversation: () => void
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
  max-width: 600px;
}

.auth-form,
.prompt-form {
  display: flex;
  gap: 4px;
  background: white;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  padding: 4px;
}

.auth-input,
.prompt-input {
  flex: 1;
  border: none;
  padding: 8px 12px;
  font-size: 14px;
  border-radius: 4px;
  outline: none;
  min-width: 0;
}

.auth-input::placeholder,
.prompt-input::placeholder {
  color: #999;
}

.auth-submit,
.prompt-submit {
  padding: 8px 16px;
  background: #4a7c59;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.auth-submit:hover,
.prompt-submit:hover {
  background: #3d6b4a;
}

.auth-submit:disabled,
.prompt-submit:disabled {
  background: #999;
  cursor: not-allowed;
}

.prompt-clear {
  padding: 0 12px;
  background: transparent;
  color: #999;
  border: none;
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
}
.prompt-clear:hover {
  color: #c0392b;
}

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

.prompt-chips {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.prompt-chip {
  padding: 4px 10px;
  background: white;
  border: 1px solid #ddd;
  border-radius: 14px;
  font-size: 11px;
  color: #555;
  cursor: pointer;
  transition: all 0.15s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.prompt-chip:hover {
  border-color: #4a7c59;
  color: #4a7c59;
  background: #f0f7f2;
}

.prompt-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-history {
  margin-top: 6px;
  background: rgba(255, 255, 255, 0.98);
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.chat-history-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid #eee;
  font-size: 11px;
  color: #888;
}

.chat-toggle {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 10px;
  color: #888;
}

.chat-messages {
  max-height: 320px;
  overflow-y: auto;
  padding: 8px 12px;
}

.chat-message {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.5;
}

.chat-message.user .chat-text {
  background: #e8f4ea;
  padding: 6px 10px;
  border-radius: 12px 12px 4px 12px;
  display: inline-block;
  max-width: 85%;
  color: #2c3e50;
  margin-left: auto;
}

.chat-message.user {
  display: flex;
  justify-content: flex-end;
}

.chat-message.assistant .chat-text {
  color: #333;
  padding: 4px 0;
}

.chat-tools {
  margin: 4px 0;
  padding-left: 10px;
  border-left: 2px solid #ddd;
}

.chat-tool {
  display: flex;
  flex-direction: column;
  font-size: 11px;
  color: #666;
  margin: 2px 0;
}

.chat-tool-name {
  font-style: italic;
}

.chat-tool-result {
  color: #888;
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
  background: #999;
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
    max-height: 200px;
  }
}
</style>
