<script setup lang="ts">
/**
 * One thing the assistant did, as a collapsed line (P6-7b, spec E.16):
 * "Searched the library for … · 6 results". The summary is written by the
 * server for a reader, so the line needs no assembling here.
 *
 * Pressing it opens what the line is short for — which tool, and for a write
 * the arguments that ran. Reads carry no arguments on the wire (the summary
 * is the whole record), so an expanded read shows the tool and its state.
 */
import { ref, computed } from 'vue'
import type { ChatToolCall } from '@/lib/libraryChat'

const props = defineProps<{ call: ChatToolCall }>()

const open = ref(false)

const state = computed(() => {
  switch (props.call.status) {
    case 'running':
      return { word: 'running', bad: false }
    case 'failed':
      return { word: 'failed', bad: true }
    default:
      return { word: '', bad: false }
  }
})

/** Arguments and results are small objects of scalars; anything bigger is
 *  shown as its JSON, clipped, because this is a detail line and not a page. */
function pairs(source: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!source) return []
  return Object.entries(source).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return [key, text.length > 400 ? `${text.slice(0, 400)}…` : text] as [string, string]
  })
}

const args = computed(() => pairs(props.call.args))
const result = computed(() => pairs(props.call.result))
</script>

<template>
  <div class="tool-line" data-testid="chat-tool-call">
    <button
      type="button"
      class="tool-summary"
      :class="{ bad: state.bad }"
      :aria-expanded="open"
      data-testid="chat-tool-summary"
      @click="open = !open"
    >
      <span class="tool-dot" :class="call.status" aria-hidden="true"></span>
      <span class="tool-text">{{ call.summary }}</span>
      <span v-if="state.word" class="tool-state">{{ state.word }}</span>
    </button>
    <dl v-if="open" class="tool-detail" data-testid="chat-tool-detail">
      <dt>tool</dt>
      <dd>{{ call.tool }}</dd>
      <template v-for="[key, value] in args" :key="`a-${key}`">
        <dt>{{ key }}</dt>
        <dd>{{ value }}</dd>
      </template>
      <template v-for="[key, value] in result" :key="`r-${key}`">
        <dt>{{ key }}</dt>
        <dd>{{ value }}</dd>
      </template>
    </dl>
  </div>
</template>

<style scoped>
.tool-line {
  margin: 4px 0;
}

.tool-summary {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  padding: 3px 0;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: 0;
  cursor: pointer;
}

.tool-summary:hover .tool-text {
  color: var(--blo-ink, #111);
  text-decoration: underline;
}

.tool-summary.bad {
  color: #7f1d1d;
}

.tool-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--blo-stone-soft, #9a948e);
}

.tool-dot.done {
  background: var(--blo-green-deep, #1f7a2e);
}

.tool-dot.failed {
  background: #b91c1c;
}

.tool-dot.running {
  background: var(--blo-orange, #ff6b1c);
}

.tool-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.tool-state {
  flex: 0 0 auto;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--blo-stone-soft, #9a948e);
}

.tool-detail {
  display: grid;
  grid-template-columns: minmax(5rem, auto) 1fr;
  gap: 2px 10px;
  margin: 4px 0 8px 13px;
  padding: 8px 10px;
  font-size: 12px;
  background: var(--blo-cream, #f7f4ee);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.tool-detail dt {
  color: var(--blo-stone-soft, #9a948e);
}

.tool-detail dd {
  margin: 0;
  min-width: 0;
  color: var(--blo-ink, #111);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

@media (max-width: 640px) {
  .tool-summary,
  .tool-detail {
    font-size: 14px;
  }

  .tool-summary {
    min-height: 34px;
  }
}
</style>
