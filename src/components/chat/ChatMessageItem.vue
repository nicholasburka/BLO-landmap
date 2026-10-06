<script setup lang="ts">
/**
 * One message in a conversation (P6-7b). Four roles, four shapes
 * (docs/CHAT.md §4):
 *
 *  - **user** — what the person typed, as they typed it.
 *  - **assistant** — what it did (collapsed tool lines), what it said
 *    (markdown), what it proposes (cards), where that came from (citations),
 *    and what to do with it.
 *  - **tool** — the result of a write the person confirmed: an outcome line,
 *    not prose.
 *  - **summary** — compaction. A quiet divider: everything before it is still
 *    in the thread, but the model reads this in its place.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { renderMarkdown } from '@/lib/renderMarkdown'
import { kindLabel } from '@/lib/kb'
import ChatToolLine from './ChatToolLine.vue'
import ChatProposedAction from './ChatProposedAction.vue'
import ChatAnswerActions from './ChatAnswerActions.vue'
import { actionStateOf, type ChatMessageView } from '@/composables/useLibraryChat'

const props = defineProps<{
  message: ChatMessageView
  /** The question this answers — only an assistant message uses it. */
  question: string
  /** Ids of the proposals whose confirm is in flight. */
  runningActions: string[]
}>()

defineEmits<{ (e: 'run', actionId: string): void }>()

const html = computed(() => (props.message.text ? renderMarkdown(props.message.text) : ''))

/** Reads happened; writes are waiting. The two are not the same kind of line,
 *  so they are not rendered in the same place. */
const reads = computed(() => props.message.toolCalls.filter(call => call.kind === 'read'))
const writes = computed(() => props.message.toolCalls.filter(call => call.kind === 'write'))

const citations = computed(() => props.message.citations ?? [])
/** Ask's wording (P5-65): leads offered when nothing was cited are "related". */
const citationsHeading = computed(() => (citations.value.some(source => source.cited) ? 'Where this came from' : 'Related material'))

/** An answer worth keeping: it finished, and it said something. */
const keepable = computed(() => !props.message.pending && !!props.message.text.trim())

/** A confirmed write's message reads as one line; the JSON behind it is for
 *  the model, not the reader. */
const outcomeLine = computed(() => props.message.text.split('\n')[0])
const outcomeFailed = computed(() => props.message.toolCalls.some(call => call.status === 'failed'))
</script>

<template>
  <article class="message" :class="message.role" :data-role="message.role" data-testid="chat-message">
    <!-- What the person asked -->
    <p v-if="message.role === 'user'" class="user-text" data-testid="chat-user-text">{{ message.text }}</p>

    <!-- Compaction (docs/CHAT.md §4): a divider, not a turn -->
    <template v-else-if="message.role === 'summary'">
      <p class="summary-label">Earlier in this conversation</p>
      <p class="summary-text" data-testid="chat-summary-text">{{ message.text }}</p>
    </template>

    <!-- The result of a write that was confirmed -->
    <p v-else-if="message.role === 'tool'" class="outcome" :class="{ bad: outcomeFailed }" data-testid="chat-outcome">
      {{ outcomeLine }}
    </p>

    <!-- An answer -->
    <template v-else>
      <ChatToolLine v-for="call in reads" :key="call.id" :call="call" />

      <p v-if="message.pending && !message.text" class="thinking" data-testid="chat-thinking">Reading the library…</p>
      <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderMarkdown -->
      <div v-else class="answer" data-testid="chat-answer" v-html="html"></div>
      <p v-if="message.stopped" class="stopped" data-testid="chat-stopped">Stopped.</p>

      <ChatProposedAction
        v-for="call in writes"
        :key="call.id"
        :call="call"
        :state="actionStateOf(call, runningActions)"
        @run="$emit('run', $event)"
      />

      <section v-if="citations.length" class="citations" data-testid="chat-citations">
        <h3 class="citations-title">{{ citationsHeading }}</h3>
        <ol class="citation-list">
          <li v-for="source in citations" :key="source.n" class="citation" data-testid="chat-citation">
            <span class="citation-n">[{{ source.n }}]</span>
            <span class="citation-body">
              <RouterLink :to="source.href" class="citation-title">{{ source.title }}</RouterLink>
              <span class="citation-kind">{{ kindLabel(source.kind) }}</span>
              <span class="citation-snippet">{{ source.snippet }}</span>
            </span>
          </li>
        </ol>
      </section>

      <ChatAnswerActions v-if="keepable" :question="question" :message="message" />
    </template>
  </article>
</template>

<style scoped>
.message {
  min-width: 0;
  margin: 0 0 18px;
}

/* What the person said reads as a said thing: a tinted block, indented. */
.message.user {
  display: flex;
  justify-content: flex-end;
}

.user-text {
  max-width: 85%;
  margin: 0;
  padding: 8px 14px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--blo-ink, #111);
  background: var(--blo-cream-deep, #ede8dd);
  border-radius: 14px 14px 2px 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.answer {
  font-size: 15px;
  line-height: 1.6;
  color: var(--blo-ink, #111);
  overflow-wrap: anywhere;
}

.answer :deep(p) {
  margin: 0 0 10px;
}

.answer :deep(p:last-child) {
  margin-bottom: 0;
}

.answer :deep(li) {
  margin-bottom: 4px;
}

.thinking,
.stopped {
  margin: 4px 0 0;
  font-size: 14px;
  color: var(--blo-stone, #6b6560);
}

.outcome {
  margin: 0;
  padding: 7px 12px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  background: var(--blo-green-soft, rgba(55, 179, 74, 0.12));
  border-radius: 8px;
  overflow-wrap: anywhere;
}

.outcome.bad {
  color: #7f1d1d;
  background: #fdecea;
}

.summary-label {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.summary-text {
  margin: 0;
  padding-left: 12px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--blo-stone, #6b6560);
  border-left: 2px solid var(--blo-cream-divider, #e0d9ca);
}

.citations {
  margin-top: 14px;
}

.citations-title {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.citation-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.citation {
  display: flex;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.citation-n {
  flex: 0 0 auto;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--blo-stone-soft, #9a948e);
}

.citation-body {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.citation-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}

.citation-title:hover {
  text-decoration: underline;
}

.citation-kind {
  padding: 1px 7px;
  font-size: 11px;
  color: var(--blo-stone, #6b6560);
  background: var(--blo-cream, #f7f4ee);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
}

.citation-snippet {
  flex-basis: 100%;
  font-size: 13px;
  line-height: 1.5;
  color: var(--blo-stone, #6b6560);
}

@media (max-width: 640px) {
  .user-text,
  .answer {
    font-size: 16px;
  }

  .user-text {
    max-width: 92%;
  }

  .summary-text,
  .outcome,
  .citation-n,
  .citation-snippet {
    font-size: 14px;
  }

  .citation-kind {
    font-size: 13px;
  }
}
</style>
