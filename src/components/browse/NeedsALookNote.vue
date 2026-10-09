<script setup lang="ts">
/**
 * What needs looking at on one row, and the three things you can do about it
 * (P6-33, P6-34).
 *
 * P6-33 collapsed four attention rows into one — "Needs a look" — because
 * opening an entry and deciding what goes in a blank is the same job whatever
 * the blank is. The collapse only loses nothing if the LIST says which fields
 * and which case, so this is that line: per field, what it is, what it says,
 * how it got there, and the sentence a model read it from.
 *
 * Two cases, one action:
 *
 * - **missing** — nothing could fill it. There is nothing to keep, so the only
 *   offer is to write it.
 * - **unverified** — a model filled it. **Keep** records that a person looked,
 *   **Edit** replaces it with their own words, and **Clear** returns the field
 *   to EMPTY so the entry rejoins this very list. Clear is the load-bearing
 *   one: a rejected value must not silently stay.
 *
 * One component, used by both browsers and by the entry page, so the three
 * surfaces cannot drift in what they offer.
 */
import { computed, ref } from 'vue'
import { needsALookFieldsFor, type NeedsALookField } from '@/lib/kb'
import { WHAT_IT_ANSWERS_MAX_CHARS, mechanismLabel } from '@/lib/provenance'
import { verifyField, type VerifyAction } from '@/lib/remediation'
import type { CatalogEntry } from '@/lib/libraryCatalog'
import { TOPICS, topicLabel } from '@/config/taxonomy'

const props = withDefaults(
  defineProps<{
    entry: CatalogEntry
    /**
     * Which rolled-up queue is open. `needs-a-look` shows every field; an old
     * deep link (`no-coverage`, `uncategorised`, …) narrows to its own one, so
     * a count can never disagree with the list it opens (P6-23).
     */
    queueKey?: string
  }>(),
  { queueKey: 'needs-a-look' },
)

const emit = defineEmits<{ changed: [] }>()

const fields = computed(() => needsALookFieldsFor(props.entry, props.queueKey))

/** Which field's Edit box is open, and what is in it. */
const editing = ref('')
const draft = ref('')
const busy = ref('')
const error = ref('')

function startEdit(field: NeedsALookField): void {
  editing.value = field.field
  draft.value = field.value
  error.value = ''
}

function cancelEdit(): void {
  editing.value = ''
  draft.value = ''
}

async function act(field: NeedsALookField, action: VerifyAction, value?: string): Promise<void> {
  busy.value = `${field.field}:${action}`
  error.value = ''
  try {
    await verifyField(props.entry.slug, field.field, action, value)
    cancelEdit()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

const isBusy = (field: NeedsALookField, action: VerifyAction) => busy.value === `${field.field}:${action}`
</script>

<template>
  <div v-if="fields.length" class="needs-a-look" data-testid="needs-a-look">
    <p v-for="field in fields" :key="field.field" class="field-line" :data-field="field.field" :data-state="field.state" data-testid="needs-a-look-field">
      <span class="field-label">{{ field.label }}</span>

      <!-- Missing: nothing could fill it, so there is nothing to keep.
           P9-8: "nothing could fill this" was the SYSTEM describing its own
           effort. The reader's question is "is there an organization?" and
           the answer is "no"; the machinery that went looking is not their
           concern. Three of these opened every entry page. -->
      <template v-if="field.state === 'missing'">
        <span class="gap">not set</span>
      </template>

      <!-- Unverified: a model's reading, with the sentence it came from. -->
      <template v-else>
        <span class="value" data-testid="needs-a-look-value">{{ field.field === 'topic' ? topicLabel(field.value) : field.value }}</span>
        <span class="mechanism" data-testid="needs-a-look-mechanism">{{ mechanismLabel(field.provenance?.mechanism ?? 'model') }}</span>
        <span v-if="field.provenance?.evidence" class="evidence" data-testid="needs-a-look-evidence">“{{ field.provenance.evidence }}”</span>
        <span v-else class="evidence muted" data-testid="needs-a-look-evidence">no sentence was recorded</span>
      </template>

      <span class="actions">
        <button
          v-if="field.state === 'unverified'"
          type="button"
          class="blo-act act keep"
          data-testid="needs-a-look-keep"
          :disabled="!!busy"
          @click="act(field, 'keep')"
        >
          {{ isBusy(field, 'keep') ? 'Keeping…' : 'Keep' }}
        </button>
        <!-- "Add" for a blank, "Edit" for a value: the same button, named for
             what pressing it actually does. -->
        <button type="button" class="blo-act act" data-testid="needs-a-look-edit" :disabled="!!busy" @click="startEdit(field)">
          {{ field.state === 'missing' ? 'Add' : 'Edit' }}
        </button>
        <button
          v-if="field.state === 'unverified'"
          type="button"
          class="blo-act act clear"
          data-testid="needs-a-look-clear"
          :disabled="!!busy"
          @click="act(field, 'clear')"
        >
          {{ isBusy(field, 'clear') ? 'Clearing…' : 'Clear' }}
        </button>
      </span>

      <span
        v-if="editing === field.field"
        class="edit-box"
        :class="{ wide: field.field === 'whatItAnswers' }"
        data-testid="needs-a-look-edit-box"
      >
        <!-- A topic is a word from one closed vocabulary, so it is chosen
             rather than typed; everything else is free text. -->
        <select v-if="field.field === 'topic'" v-model="draft" class="edit-input" data-testid="needs-a-look-input">
          <option value="">Not set</option>
          <option v-for="topic in TOPICS" :key="topic.id" :value="topic.id">{{ topic.label }}</option>
        </select>
        <!-- P7-7: a sentence, not a word, so it gets a sentence-sized box and
             the same cap the model is held to — the line rides on every list
             row (`LIST_ROW_META_KEYS`), and P5-88's 214 kB list answer is what
             an unbounded one costs. -->
        <input
          v-else
          v-model="draft"
          type="text"
          class="edit-input"
          :class="{ wide: field.field === 'whatItAnswers' }"
          :maxlength="field.field === 'whatItAnswers' ? WHAT_IT_ANSWERS_MAX_CHARS : undefined"
          data-testid="needs-a-look-input"
        />
        <button type="button" class="blo-act act save" data-testid="needs-a-look-save" :disabled="!draft || !!busy" @click="act(field, 'edit', draft)">
          {{ isBusy(field, 'edit') ? 'Saving…' : 'Save' }}
        </button>
        <button type="button" class="blo-act act" data-testid="needs-a-look-cancel" :disabled="!!busy" @click="cancelEdit">Cancel</button>
      </span>
    </p>

    <p v-if="error" class="field-error" data-testid="needs-a-look-error">Sorry — {{ error }}</p>
  </div>
</template>

<style scoped>
.needs-a-look {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 4px 0 0;
  /* P5-60: a long evidence sentence must not widen the row it sits in. */
  min-width: 0;
}

.field-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  min-width: 0;
}

.field-label {
  font-weight: 600;
  color: var(--blo-ink, #111);
}

.gap {
  font-style: italic;
}

.value {
  /* P7-7: the values were chips (a topic, a scope). An answers line is a
     sentence, and a sentence must wrap rather than widen the row. */
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 0 5px;
  background: var(--blo-cream, #faf6ec);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 4px;
  color: var(--blo-ink, #111);
}

/* An unverified value is never allowed to look like a curated one, which is
   the load-bearing half of P6-34. */
.mechanism {
  font-weight: 600;
  color: var(--blo-orange-deep, #e65100);
}

.evidence {
  min-width: 0;
  overflow-wrap: anywhere;
  font-style: italic;
}

.evidence.muted {
  opacity: 0.7;
}

.actions,
.edit-box {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* P9-17: `.blo-act` carries the look — this rule was a byte-for-byte copy of
   it but for the padding, which is the one thing that must differ. These sit
   INSIDE a sentence ("Publisher — unknown · Keep Edit Clear"), so they are
   the dense variant: tighter here, and 32px rather than 44px on a phone
   (below, and WCAG 2.5.8's 24px floor), because a thumb-sized box in a line
   of running text breaks the line. The scoped `.act[data-v-…]` outranks the
   global `.blo-act`, which is what lets the two rules below win. */
.act {
  padding: 1px 6px;
}

.act:hover:not(:disabled) {
  background: var(--blo-cream, #faf6ec);
}

.act.clear {
  color: var(--blo-orange-deep, #e65100);
}

.edit-input {
  font: inherit;
  font-size: 12px;
  padding: 1px 4px;
  max-width: 220px;
  min-width: 0;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 4px;
}

/* A sentence needs the row, not a chip's worth of it: the box takes a line of
   its own (the row already wraps) and the input fills it. */
.edit-box.wide {
  flex: 1 1 100%;
  min-width: 0;
}

.edit-input.wide {
  flex: 1 1 auto;
  max-width: 100%;
}

.field-error {
  margin: 0;
  font-size: 12px;
  color: var(--blo-orange-deep, #e65100);
}

/* --- Phone (P5-60) -------------------------------------------------------- */
@media (max-width: 640px) {
  .field-line {
    font-size: 13px;
  }

  .act {
    min-height: 32px;
    padding: 2px 10px;
    font-size: 13px;
  }
}
</style>
