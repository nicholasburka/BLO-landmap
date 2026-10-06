<script setup lang="ts">
/**
 * A link (P6-8, panel one) — the drop form, as it has always been.
 *
 * Every rule here came from phase 5 and is unchanged: a bare URL lands in the
 * to-file queue, a title files it straight away, the taxonomy fields are the
 * same select and chips every other form uses, "This is a data source" turns
 * the drop into a registered pointer, and the server reads the page in the
 * background and proposes a filing that nobody applies for you.
 *
 * It lives in a component of its own so `/new` and the library list are the
 * same form rather than two forms that drift.
 */
import { computed, ref } from 'vue'
import SourceFields from '@/components/SourceFields.vue'
import TaxonomyFields from '@/components/TaxonomyFields.vue'
import { friendlyError } from '@/lib/errors'
import {
  createLinkEntry,
  emptySourceForm,
  looksLikeEndpointUrl,
  sourceFromForm,
  type LinkResult,
} from '@/lib/libraryCatalog'

const emit = defineEmits<{ (event: 'dropped', result: LinkResult): void }>()

const url = ref('')
const title = ref('')
const note = ref('')
const category = ref('')
const tags = ref('')
const isSource = ref(false)
const sourceForm = ref(emptySourceForm())
const busy = ref(false)
const message = ref('')
const failed = ref(false)

/** P5-82: what registering this particular URL will and will not do. */
const pointerOnly = computed(() => isSource.value && !looksLikeEndpointUrl(url.value))

async function submit(): Promise<void> {
  if (busy.value) return
  const address = url.value.trim()
  const source = isSource.value
    ? sourceFromForm({ ...sourceForm.value, accessUrl: sourceForm.value.accessUrl.trim() || address })
    : null
  if (isSource.value && !source) {
    failed.value = true
    message.value = 'A data source needs a provider — who publishes it.'
    return
  }
  busy.value = true
  failed.value = false
  try {
    const result = await createLinkEntry({
      url: address,
      note: note.value.trim() || undefined,
      title: title.value.trim() || undefined,
      category: category.value || undefined,
      tags: tags.value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
      ...(source ? { source } : {}),
    })
    message.value =
      result.kind === 'source'
        ? `Data source registered: “${result.title}”.`
        : result.status === 'needs-cataloging'
          ? `Link dropped: “${result.title}” is in the to-file queue.`
          : `Link filed: “${result.title}”.`
    if (result.fetch === 'queued') {
      message.value += ' Reading it now — open the entry in a moment for a suggested filing.'
    }
    if (result.dropped?.length) message.value += ` We could not use: ${result.dropped.join(', ')}.`
    url.value = ''
    title.value = ''
    note.value = ''
    category.value = ''
    tags.value = ''
    isSource.value = false
    sourceForm.value = emptySourceForm()
    emit('dropped', result)
  } catch (err: unknown) {
    failed.value = true
    message.value = friendlyError(err, 'That link could not be dropped. Try again.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <form class="drop-form" data-testid="link-drop-form" @submit.prevent="submit">
    <input
      v-model="url"
      type="url"
      placeholder="https://… (a dataset, portal, or source you can't export yet)"
      aria-label="Link URL"
      required
    />
    <input v-model="title" type="text" placeholder="Title (optional — leave blank to file it later)" aria-label="Link title" />
    <textarea
      v-model="note"
      rows="2"
      placeholder="Note (optional): what it is, what format we'd want, any login needed"
      aria-label="Link note"
    ></textarea>
    <TaxonomyFields v-model:category="category" v-model:tags="tags" :disabled="busy" label="Link" />
    <label class="check">
      <input v-model="isSource" type="checkbox" data-testid="link-is-source" />
      This is a data source — a dataset we point at rather than hold
    </label>
    <SourceFields v-if="isSource" v-model="sourceForm" :disabled="busy" />
    <div class="actions">
      <button type="submit" class="primary" :disabled="busy">
        {{ busy ? 'Dropping…' : isSource ? 'Register source' : 'Drop link' }}
      </button>
    </div>
    <p v-if="pointerOnly" class="hint" data-testid="pointer-only-hint">
      This registers a pointer. It cannot run in a place report until it has an endpoint.
    </p>
    <p v-if="message" class="note" :class="{ error: failed }" data-testid="link-drop-note">{{ message }}</p>
  </form>
</template>

<style scoped>
.drop-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.drop-form input[type='url'],
.drop-form input[type='text'],
.drop-form textarea {
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  font: inherit;
  background: #fff;
  color: inherit;
  box-sizing: border-box;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.9rem;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.primary {
  padding: 9px 16px;
  border: none;
  border-radius: 6px;
  background: var(--blo-green, #2f5d3a);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.hint,
.note {
  margin: 0;
  font-size: 0.88rem;
  color: #5c5348;
}

.note.error {
  color: #9a3412;
}

@media (max-width: 640px) {
  .primary {
    width: 100%;
  }
}
</style>
