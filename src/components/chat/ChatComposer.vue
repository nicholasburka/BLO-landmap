<script setup lang="ts">
/**
 * The box at the foot of a conversation (P6-7b).
 *
 * Enter sends, Shift+Enter starts a new line — the convention every chat box
 * has, and the reason this is a textarea rather than an input. While an
 * answer is streaming the box is disabled and the send button becomes
 * **Stop**, which aborts the request that is reading it.
 */
import { ref, watch, nextTick } from 'vue'
import { MESSAGE_MAX_CHARS } from '@/lib/libraryChat'

const props = withDefaults(
  defineProps<{
    streaming?: boolean
    /** Seeded when a turn failed with nothing stored — the text comes back. */
    seed?: string
    placeholder?: string
  }>(),
  { streaming: false, seed: '', placeholder: 'Ask the library something…' },
)

const emit = defineEmits<{ (e: 'send', text: string): void; (e: 'stop'): void }>()

const text = ref(props.seed)
const box = ref<HTMLTextAreaElement | null>(null)

watch(
  () => props.seed,
  value => {
    if (value) text.value = value
  },
)

/** Back to one row after a send, whatever the reader had grown it to. */
function resize(): void {
  const el = box.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 200)}px`
}

function submit(): void {
  const body = text.value.trim()
  if (!body || props.streaming) return
  emit('send', body)
  text.value = ''
  void nextTick(resize)
}

function onKeydown(event: KeyboardEvent): void {
  // A composing IME uses Enter to accept a candidate; sending there would eat
  // the word being typed.
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submit()
}
</script>

<template>
  <form class="composer" data-testid="chat-composer" @submit.prevent="submit">
    <textarea
      ref="box"
      v-model="text"
      class="composer-box"
      rows="1"
      :maxlength="MESSAGE_MAX_CHARS"
      :disabled="streaming"
      :placeholder="placeholder"
      aria-label="Message the library"
      data-testid="chat-input"
      @keydown="onKeydown"
      @input="resize"
    ></textarea>
    <button v-if="streaming" type="button" class="composer-stop" data-testid="chat-stop" @click="emit('stop')">Stop</button>
    <button v-else type="submit" class="composer-send" :disabled="!text.trim()" data-testid="chat-send">Send</button>
  </form>
</template>

<style scoped>
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 12px 0 0;
  border-top: 1px solid var(--blo-cream-divider, #e0d9ca);
  background: var(--blo-cream, #f7f4ee);
}

.composer-box {
  flex: 1;
  min-width: 0;
  max-height: 200px;
  padding: 10px 14px;
  font: inherit;
  font-size: 15px;
  line-height: 1.5;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 12px;
  resize: none;
}

.composer-box:focus {
  outline: 2px solid var(--blo-green-deep, #1f7a2e);
  outline-offset: -1px;
}

.composer-box:disabled {
  color: var(--blo-stone, #6b6560);
  background: var(--blo-cream, #f7f4ee);
}

.composer-send,
.composer-stop {
  flex: 0 0 auto;
  padding: 10px 20px;
  font: inherit;
  font-weight: 600;
  color: #fff;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
}

.composer-send {
  background: var(--blo-green-deep, #1f7a2e);
}

.composer-send:disabled {
  background: var(--blo-stone-soft, #9a948e);
  cursor: default;
}

.composer-stop {
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
}

@media (max-width: 640px) {
  .composer-box {
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .composer-send,
  .composer-stop {
    min-height: 44px;
    padding: 0 16px;
  }
}
</style>
