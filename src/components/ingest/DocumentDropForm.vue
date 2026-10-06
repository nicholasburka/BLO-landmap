<script setup lang="ts">
/**
 * One document, with its filing fields (P6-8, panel two).
 *
 * The single path is unchanged on purpose: you are here, the file is in front
 * of you, so you say what it is while you drop it. The server still reads it
 * afterwards and proposes a filing, and still applies none of it.
 *
 * P6-29 took the drop zone away. There is now ONE zone on `/new`, which counts
 * the files and hands them to whichever of the two panels they belong to, so a
 * second zone here would be a second way to be refused by the wrong rule.
 * `take(files)` was already the single entry point behind this component's own
 * pick and drop handlers; it is now exposed and is the only way in. Everything
 * below the zone — the form, the two buttons, the note — is as it was.
 */
import { computed, ref } from 'vue'
import TaxonomyFields from '@/components/TaxonomyFields.vue'
import { friendlyError } from '@/lib/errors'
import { formatBytes, uploadLibraryFile, type UploadResult } from '@/lib/libraryCatalog'

const emit = defineEmits<{ (event: 'uploaded', result: UploadResult): void }>()

const chosen = ref<File | null>(null)
const title = ref('')
const category = ref('')
const tags = ref('')
const description = ref('')
const busy = ref(false)
const message = ref('')
const failed = ref(false)

/** What the page reads back to decide which limit to quote and which words to
 *  put under the zone — so it cannot go stale when `clear()` empties this. */
const count = computed(() => (chosen.value ? 1 : 0))

function take(files: FileList | null): void {
  const file = files?.[0] ?? null
  if (!file) return
  chosen.value = file
  message.value = ''
  failed.value = false
}

function clear(): void {
  chosen.value = null
  title.value = ''
  category.value = ''
  tags.value = ''
  description.value = ''
}

/** `filed` false is the quick drop: in now, catalogued later. */
async function upload(filed: boolean): Promise<void> {
  const file = chosen.value
  if (!file || busy.value) return
  busy.value = true
  failed.value = false
  try {
    const result = await uploadLibraryFile(
      file,
      filed
        ? { title: title.value, category: category.value, tags: tags.value, description: description.value }
        : {},
    )
    message.value = filed
      ? `Filed “${title.value.trim() || file.name}”. Reading it now — a suggested filing will appear on the entry.`
      : `“${file.name}” is in the to-file queue.`
    clear()
    emit('uploaded', result)
  } catch (err: unknown) {
    failed.value = true
    message.value = friendlyError(err, 'The upload did not land — try again.')
  } finally {
    busy.value = false
  }
}

defineExpose({ take, clear, count })
</script>

<template>
  <!-- Nothing picked and nothing to report: draw nothing at all, so the page
       above is the zone and only the zone. -->
  <div v-if="chosen || message" class="document-drop">
    <form v-if="chosen" class="drop-form" data-testid="document-form" @submit.prevent="upload(true)">
      <p class="chosen">{{ chosen.name }} · {{ formatBytes(chosen.size) }}</p>
      <input v-model="title" type="text" placeholder="Title" aria-label="Title" />
      <TaxonomyFields v-model:category="category" v-model:tags="tags" :disabled="busy" />
      <textarea v-model="description" rows="2" placeholder="Notes / description" aria-label="Description"></textarea>
      <div class="actions">
        <button type="submit" class="primary" :disabled="busy">{{ busy ? 'Uploading…' : 'File' }}</button>
        <button type="button" class="plain" :disabled="busy" title="Upload now, file later" @click="upload(false)">
          Quick drop
        </button>
        <button type="button" class="plain" :disabled="busy" @click="clear">Cancel</button>
      </div>
    </form>

    <p v-if="message" class="note" :class="{ error: failed }" data-testid="document-drop-note">{{ message }}</p>
  </div>
</template>

<style scoped>
.document-drop {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.drop-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chosen {
  margin: 0;
  font-weight: 600;
  font-size: 0.92rem;
}

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

.plain {
  padding: 9px 14px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  background: #fff;
  font: inherit;
  cursor: pointer;
}

.primary:disabled,
.plain:disabled {
  opacity: 0.6;
  cursor: default;
}

.note {
  margin: 0;
  font-size: 0.88rem;
  color: #5c5348;
}

.note.error {
  color: #9a3412;
}

@media (max-width: 640px) {
  .actions button {
    width: 100%;
  }
}
</style>
