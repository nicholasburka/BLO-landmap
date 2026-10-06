<script setup lang="ts">
/**
 * Ask the knowledge base (P5-41). One box, one job: take a question and open
 * /ask with it. It appears on the landing, on dataset pages (with a `dataset`
 * hint so "ask about this data" knows which table), and as the follow-up box
 * on the answer page — so routing lives here rather than in each host.
 *
 * The hosting page never needs to know the URL shape: `askUrl` owns it.
 */
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { askUrl, QUESTION_MAX_CHARS } from '@/lib/ask'

const props = withDefaults(
  defineProps<{
    placeholder?: string
    /** Pins an answer to one dataset (the explorer's "Ask about this data"). */
    dataset?: string
    /** Seed text — the answer page fills the follow-up box with nothing, the
     *  question it just asked appears above it instead. */
    modelValue?: string
    autofocus?: boolean
    label?: string
  }>(),
  { modelValue: '' },
)

const emit = defineEmits<{ (e: 'ask', question: string): void }>()

const router = useRouter()
const question = ref(props.modelValue)
watch(
  () => props.modelValue,
  value => {
    question.value = value ?? ''
  },
)

function submit(): void {
  const q = question.value.trim()
  if (!q) return
  emit('ask', q)
  question.value = ''
  void router.push(askUrl(q, props.dataset))
}
</script>

<template>
  <form class="ask-box" data-testid="ask-box" @submit.prevent="submit">
    <input
      v-model="question"
      type="text"
      class="ask-input"
      :maxlength="QUESTION_MAX_CHARS"
      :placeholder="placeholder ?? 'Ask a question about the library…'"
      :aria-label="label ?? 'Ask the knowledge base'"
      :autofocus="autofocus"
      autocomplete="off"
      data-testid="ask-input"
    />
    <button type="submit" class="ask-submit" :disabled="!question.trim()" data-testid="ask-submit">Ask</button>
  </form>
</template>

<style scoped>
.ask-box {
  display: flex;
  gap: 8px;
}

.ask-input {
  flex: 1;
  min-width: 0;
  padding: 10px 14px;
  font: inherit;
  font-size: 15px;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.ask-input:focus {
  outline: 2px solid var(--blo-green-deep, #1f7a2e);
  outline-offset: -1px;
}

.ask-submit {
  flex: 0 0 auto;
  padding: 10px 20px;
  font: inherit;
  font-weight: 600;
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}

.ask-submit:disabled {
  background: var(--blo-stone-soft, #9a948e);
  cursor: default;
}

/* P5-60: the box people type a whole question into needs a real height, and
   16 px is the size below which iOS Safari zooms the page on focus. */
@media (max-width: 640px) {
  .ask-input {
    min-height: 44px;
    font-size: 16px;
  }

  .ask-submit {
    min-height: 44px;
    padding: 0 16px;
  }
}
</style>
