<script setup lang="ts">
/**
 * The "This is a data source" fields (P5-56).
 *
 * One component, two homes: the drop-a-link form on the library page and the
 * filing form on an entry page. A teammate who found a dataset should be able
 * to register it in a minute — provider is the only required field, and the
 * rest can be filled in later on the entry page, so nothing here is a gate.
 *
 * The block itself is built by `sourceFromForm` and cleaned by the server;
 * this component only collects strings.
 */
import { ref } from 'vue'
import { SOURCE_GEOGRAPHIES, SOURCE_ACCESS_TYPES, accessTypeLabel, type SourceFormState } from '@/lib/libraryCatalog'

const props = defineProps<{
  modelValue: SourceFormState
  disabled?: boolean
  /**
   * P5-59: fields the machine filled in from an inspection. Each gets an
   * "inferred" chip so nothing looks like a person typed it. The chip goes
   * the moment somebody edits that field — at which point it IS typed.
   */
  inferred?: (keyof SourceFormState)[]
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: SourceFormState): void }>()

const edited = ref(new Set<keyof SourceFormState>())

function isInferred(field: keyof SourceFormState): boolean {
  return !!props.inferred?.includes(field) && !edited.value.has(field)
}

function set<K extends keyof SourceFormState>(field: K, value: string): void {
  if (!edited.value.has(field)) edited.value = new Set([...edited.value, field])
  emit('update:modelValue', { ...props.modelValue, [field]: value })
}
</script>

<template>
  <fieldset class="source-fields" data-testid="source-form" :disabled="disabled">
    <div class="field">
      <input
        :value="modelValue.provider"
        type="text"
        placeholder="Who publishes it? e.g. US EPA (required)"
        aria-label="Provider"
        data-testid="source-form-provider"
        :class="{ inferred: isInferred('provider') }"
        required
        @input="set('provider', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="isInferred('provider')" class="badge inferred-chip" data-testid="inferred-provider">inferred</span>
    </div>
    <div class="field">
      <input
        :value="modelValue.program"
        type="text"
        placeholder="Program or dataset name (optional) — e.g. Superfund"
        aria-label="Program"
        data-testid="source-form-program"
        :class="{ inferred: isInferred('program') }"
        @input="set('program', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="isInferred('program')" class="badge inferred-chip" data-testid="inferred-program">inferred</span>
    </div>
    <div class="source-row">
      <label class="source-label">
        What shape is it?
        <span class="with-chip">
          <select
            :value="modelValue.geography"
            aria-label="Geography"
            data-testid="source-form-geography"
            :class="{ inferred: isInferred('geography') }"
            @change="set('geography', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Not sure</option>
            <option v-for="g in SOURCE_GEOGRAPHIES" :key="g" :value="g">{{ g }}</option>
          </select>
          <span v-if="isInferred('geography')" class="badge inferred-chip" data-testid="inferred-geography">inferred</span>
        </span>
      </label>
      <span class="field grow">
        <input
          :value="modelValue.coverage"
          type="text"
          placeholder="Where does it cover? e.g. national, Tennessee"
          aria-label="Coverage"
          data-testid="source-form-coverage"
          :class="{ inferred: isInferred('coverage') }"
          @input="set('coverage', ($event.target as HTMLInputElement).value)"
        />
        <span v-if="isInferred('coverage')" class="badge inferred-chip" data-testid="inferred-coverage">inferred</span>
      </span>
    </div>
    <div class="field">
      <input
        :value="modelValue.topics"
        type="text"
        placeholder="Topics (comma-separated) — e.g. contamination, flooding"
        aria-label="Topics"
        data-testid="source-form-topics"
        :class="{ inferred: isInferred('topics') }"
        @input="set('topics', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="isInferred('topics')" class="badge inferred-chip" data-testid="inferred-topics">inferred</span>
    </div>
    <div class="source-row">
      <label class="source-label">
        How do you get it?
        <span class="with-chip">
          <select
            :value="modelValue.accessType"
            aria-label="Access type"
            data-testid="source-form-access-type"
            :class="{ inferred: isInferred('accessType') }"
            @change="set('accessType', ($event.target as HTMLSelectElement).value)"
          >
            <option value="">Not sure</option>
            <option v-for="t in SOURCE_ACCESS_TYPES" :key="t" :value="t">{{ accessTypeLabel(t) }}</option>
          </select>
          <span v-if="isInferred('accessType')" class="badge inferred-chip" data-testid="inferred-accessType">inferred</span>
        </span>
      </label>
      <span class="field grow">
        <input
          :value="modelValue.accessUrl"
          type="url"
          placeholder="Endpoint or download URL (https)"
          aria-label="Access URL"
          data-testid="source-form-access-url"
          :class="{ inferred: isInferred('accessUrl') }"
          @input="set('accessUrl', ($event.target as HTMLInputElement).value)"
        />
        <span v-if="isInferred('accessUrl')" class="badge inferred-chip" data-testid="inferred-accessUrl">inferred</span>
      </span>
    </div>
    <div class="field">
      <input
        :value="modelValue.license"
        type="text"
        placeholder="License / terms (optional) — e.g. public domain"
        aria-label="License"
        data-testid="source-form-license"
        :class="{ inferred: isInferred('license') }"
        @input="set('license', ($event.target as HTMLInputElement).value)"
      />
      <span v-if="isInferred('license')" class="badge inferred-chip" data-testid="inferred-license">inferred</span>
    </div>
    <div class="field">
      <textarea
        :value="modelValue.notes"
        rows="2"
        placeholder="Why it matters for a land decision (optional)"
        aria-label="Why it matters"
        data-testid="source-form-notes"
        :class="{ inferred: isInferred('notes') }"
        @input="set('notes', ($event.target as HTMLTextAreaElement).value)"
      ></textarea>
      <span v-if="isInferred('notes')" class="badge inferred-chip" data-testid="inferred-notes">inferred</span>
    </div>
  </fieldset>
</template>

<style scoped>
.source-fields {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.source-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  flex-wrap: wrap;
}

.source-row > input {
  flex: 1 1 200px;
}

.source-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--blo-stone);
}

.source-fields input,
.source-fields textarea,
.source-fields select {
  padding: 7px 10px;
  font-size: 14px;
  font-family: inherit;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.source-fields textarea {
  resize: vertical;
}

.source-fields:disabled {
  opacity: 0.6;
}

/* --- Inferred values (P5-59) ---
   A value the machine worked out from the service's own metadata is NOT yet
   something a person said. It gets the same dashed treatment the suggested
   filing panel uses for "proposed, not filed", plus a chip naming it, and
   both go the moment somebody edits the field. */
.field {
  display: flex;
  align-items: center;
  gap: 6px;
}

.field > input,
.field > textarea {
  flex: 1 1 auto;
  min-width: 0;
}

.field.grow {
  flex: 1 1 200px;
}

.with-chip {
  display: flex;
  align-items: center;
  gap: 6px;
}

.source-fields .inferred {
  border-style: dashed;
  background: var(--blo-cream);
}

.badge.inferred-chip {
  flex: 0 0 auto;
  padding: 1px 8px;
  font-size: 11px;
  border-radius: 999px;
  color: #4a3b76;
  border: 1px dashed #c5b8e6;
  background: #f1edfb;
}

/* P5-60: on a phone every field is its own full-width line — the two
   label+input pairs side by side left both too narrow to read. */
@media (max-width: 640px) {
  .source-row {
    flex-direction: column;
    align-items: stretch;
  }

  .source-row > input,
  .field.grow {
    flex: 1 1 auto;
  }

  .source-label {
    font-size: 14px;
  }

  .source-fields input,
  .source-fields textarea,
  .source-fields select {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .badge.inferred-chip {
    font-size: 13px;
  }
}
</style>
