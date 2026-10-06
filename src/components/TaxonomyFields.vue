<script setup lang="ts">
/**
 * The category select and the tag chips, shared by every filing form (P5-63).
 *
 * Four forms used to offer a bare "Category" text box, which is how the
 * library ended up with `demographics` beside `demographic` and
 * `primary-sources` beside `research`. There is one vocabulary now, so there
 * is one control for it: a select grouped by the two questions it answers
 * (what is this ABOUT / what is it FOR), and the chosen topic's own suggested
 * tags as chips beside a free-text box that still takes anything.
 *
 * Two v-models rather than one object, because the two fields are stored
 * separately everywhere they are used and a wrapper object would only have to
 * be unpacked again.
 */
import { computed } from 'vue'
import { PURPOSES, TOPICS, isPurpose, isTopic, tagChoicesFor, normalizeTag } from '@/config/taxonomy'

const props = withDefaults(
  defineProps<{
    /** A topic id, a purpose id, or a word the taxonomy does not know. */
    category: string
    /** Comma-separated, exactly as the forms have always stored them. */
    tags: string
    disabled?: boolean
    /** Distinguishes the controls when two of these are on one page. */
    label?: string
  }>(),
  { disabled: false, label: '' },
)

const emit = defineEmits<{
  (event: 'update:category', value: string): void
  (event: 'update:tags', value: string): void
}>()

const categoryLabel = computed(() => (props.label ? `${props.label} category` : 'Category'))
const tagsLabel = computed(() => (props.label ? `${props.label} tags` : 'Tags'))

/** A word already on the entry that the taxonomy has never heard of. Kept as
 *  an option so opening the form cannot silently retag somebody's entry. */
const unknownCategory = computed(() =>
  props.category && !isTopic(props.category) && !isPurpose(props.category) ? props.category : '',
)

const chosenTags = computed(() =>
  props.tags
    .split(',')
    .map(t => t.trim())
    .filter(Boolean),
)

/** The chips: the chosen topic's own tags first, then the cross-cutting ones.
 *  With no topic chosen there is nothing subject-specific to suggest, so only
 *  the cross-cutting ones show. */
const chips = computed(() => tagChoicesFor(props.category))

function isOn(tag: string): boolean {
  return chosenTags.value.some(t => normalizeTag(t) === tag)
}

function toggleTag(tag: string): void {
  if (props.disabled) return
  const next = isOn(tag) ? chosenTags.value.filter(t => normalizeTag(t) !== tag) : [...chosenTags.value, tag]
  emit('update:tags', next.join(', '))
}
</script>

<template>
  <select
    class="taxonomy-select"
    :value="category"
    :disabled="disabled"
    :aria-label="categoryLabel"
    data-testid="taxonomy-category"
    @change="emit('update:category', ($event.target as HTMLSelectElement).value)"
  >
    <option value="">No category</option>
    <optgroup label="What it is about">
      <option v-for="topic in TOPICS" :key="topic.id" :value="topic.id" :title="topic.description">{{ topic.label }}</option>
    </optgroup>
    <optgroup label="What it is for">
      <option v-for="purpose in PURPOSES" :key="purpose.id" :value="purpose.id" :title="purpose.description">
        {{ purpose.label }}
      </option>
    </optgroup>
    <optgroup v-if="unknownCategory" label="Not in the taxonomy">
      <option :value="unknownCategory">{{ unknownCategory }}</option>
    </optgroup>
  </select>

  <div v-if="chips.length" class="tag-chips" data-testid="taxonomy-chips">
    <button
      v-for="chip in chips"
      :key="chip"
      type="button"
      class="tag-chip"
      :class="{ on: isOn(chip) }"
      :aria-pressed="isOn(chip)"
      :disabled="disabled"
      :data-chip="chip"
      @click="toggleTag(chip)"
    >
      {{ chip }}
    </button>
  </div>

  <input
    :value="tags"
    type="text"
    placeholder="Tags (comma-separated)"
    :aria-label="tagsLabel"
    :disabled="disabled"
    data-testid="taxonomy-tags"
    @input="emit('update:tags', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.tag-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-chip {
  border: 1px solid var(--blo-border, #d8d2c4);
  background: transparent;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 0.78rem;
  color: var(--blo-ink-muted, #6b6558);
  cursor: pointer;
}

.tag-chip:hover:not(:disabled) {
  border-color: var(--blo-ink, #2c2a26);
  color: var(--blo-ink, #2c2a26);
}

.tag-chip.on {
  background: var(--blo-ink, #2c2a26);
  border-color: var(--blo-ink, #2c2a26);
  color: #fff;
}

.tag-chip:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
