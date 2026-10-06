<script setup lang="ts">
/**
 * What to do with an answer (P6-7b, spec E.17): **Save as note**, **Add to
 * page**, and **Open** when the answer produced an analysis.
 *
 * The first two are Ask's, not a second implementation of them: an answer
 * kept from Chat writes the same markdown, files itself under the same
 * category and tag, and appends to a page through the same read-modify-write
 * that turns a concurrent edit into a `WikiConflictError` rather than a lost
 * one. All this component does is describe a chat answer in the shape Ask's
 * functions take — the text, and the citations as its numbered sources.
 */
import { ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import { saveAnswerAsNote, addAnswerToPage, type AskAnswer } from '@/lib/ask'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { WikiConflictError } from '@/lib/wiki'
import { friendlyError } from '@/lib/errors'
import { openTargetFor, type ChatMessage } from '@/lib/libraryChat'

const props = defineProps<{
  /** The question this answered — the note's title and its "ask again" link. */
  question: string
  message: ChatMessage
}>()

/** A chat answer in the shape Ask's keep-this helpers read. */
const answer = computed<AskAnswer>(() => ({
  answer: props.message.text,
  sources: props.message.citations,
  queries: [],
  read: { pages: 0, datasets: 0, documents: 0, notes: 0 },
}))

const openTarget = computed(() => openTargetFor(props.message))

// --- Save as note ----------------------------------------------------------

const savedNote = ref<{ slug: string; title: string } | null>(null)
const savingNote = ref(false)
const saveError = ref('')

/** One note per answer: the button locks once it has a slug, so a double
 *  click cannot leave two copies of the same answer in the library. */
async function saveNote(): Promise<void> {
  if (savingNote.value || savedNote.value) return
  savingNote.value = true
  saveError.value = ''
  try {
    const entry = await saveAnswerAsNote(props.question, answer.value)
    savedNote.value = { slug: entry.slug, title: entry.title }
  } catch (err: unknown) {
    saveError.value = friendlyError(err, 'That note could not be saved. Please try again.')
  } finally {
    savingNote.value = false
  }
}

// --- Add to page -----------------------------------------------------------

const pickerOpen = ref(false)
const pages = ref<CatalogEntry[]>([])
const pagesLoaded = ref(false)
const pagesLoading = ref(false)
const pageQuery = ref('')
const addingSlug = ref('')
const addedPage = ref<{ slug: string; title: string } | null>(null)
const addError = ref('')
/** The page a 412 refused — the retry button re-reads it and appends again. */
const conflictSlug = ref('')

async function togglePicker(): Promise<void> {
  pickerOpen.value = !pickerOpen.value
  if (!pickerOpen.value || pagesLoaded.value || pagesLoading.value) return
  pagesLoading.value = true
  try {
    pages.value = await fetchCatalog({ kind: 'wiki' })
    pagesLoaded.value = true
  } catch {
    addError.value = 'The list of pages could not be loaded. Please try again.'
  } finally {
    pagesLoading.value = false
  }
}

const filteredPages = computed(() => {
  const needle = pageQuery.value.trim().toLowerCase()
  const matches = needle ? pages.value.filter(page => page.title.toLowerCase().includes(needle)) : pages.value
  return matches.slice(0, 12)
})

async function addToPage(slug: string): Promise<void> {
  if (addingSlug.value) return
  addingSlug.value = slug
  addError.value = ''
  conflictSlug.value = ''
  try {
    addedPage.value = await addAnswerToPage(slug, props.question, answer.value)
    pickerOpen.value = false
  } catch (err: unknown) {
    if (err instanceof WikiConflictError) {
      // Nothing was written. Re-reading is the whole fix, so offer it.
      conflictSlug.value = slug
      addError.value = 'That page changed while you were reading it. Nothing was added yet.'
    } else {
      addError.value = friendlyError(err, 'That answer could not be added to the page.')
    }
  } finally {
    addingSlug.value = ''
  }
}
</script>

<template>
  <div class="answer-actions" data-testid="chat-answer-actions">
    <div class="action-row">
      <button type="button" class="action-btn" data-testid="chat-save-note" :disabled="savingNote || !!savedNote" @click="saveNote">
        {{ savingNote ? 'Saving…' : 'Save as note' }}
      </button>
      <button type="button" class="action-btn" data-testid="chat-add-to-page" :aria-expanded="pickerOpen" @click="togglePicker">
        Add to page…
      </button>
      <RouterLink
        v-if="openTarget"
        :to="openTarget.href"
        class="action-btn"
        :aria-label="openTarget.label"
        :title="openTarget.label"
        data-testid="chat-open"
      >
        Open
      </RouterLink>

      <span v-if="savedNote" class="action-said" data-testid="chat-note-saved">
        Saved — <RouterLink :to="`/library/${savedNote.slug}`" data-testid="chat-note-link">open note</RouterLink>
      </span>
      <span v-if="addedPage" class="action-said" data-testid="chat-page-added">
        Added — <RouterLink :to="`/wiki/${addedPage.slug}`" data-testid="chat-page-link">open page</RouterLink>
      </span>
      <span v-if="saveError" class="action-said bad" data-testid="chat-save-error">{{ saveError }}</span>
    </div>

    <div v-if="pickerOpen" class="page-picker" data-testid="chat-page-picker">
      <input
        v-model="pageQuery"
        type="search"
        class="picker-search"
        placeholder="Find a page…"
        aria-label="Find a page"
        data-testid="chat-page-search"
      />
      <p v-if="pagesLoading" class="picker-note">Loading pages…</p>
      <p v-else-if="!filteredPages.length" class="picker-note" data-testid="chat-page-empty">No page matches.</p>
      <ul v-else class="picker-list">
        <li v-for="page in filteredPages" :key="page.slug">
          <button type="button" class="picker-page" data-testid="chat-page-option" :disabled="!!addingSlug" @click="addToPage(page.slug)">
            {{ page.title }}
          </button>
        </li>
      </ul>
      <p v-if="addError" class="picker-note bad" data-testid="chat-add-error">
        {{ addError }}
        <button v-if="conflictSlug" type="button" class="link-btn" data-testid="chat-add-retry" @click="addToPage(conflictSlug)">
          Try again
        </button>
      </p>
    </div>
  </div>
</template>

<style scoped>
.answer-actions {
  margin-top: 10px;
}

.action-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.action-btn {
  padding: 5px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
  text-decoration: none;
}

.action-btn:hover:not(:disabled) {
  border-color: var(--blo-green-deep, #1f7a2e);
  color: var(--blo-green-deep, #1f7a2e);
}

.action-btn:disabled {
  cursor: default;
  color: var(--blo-stone-soft, #9a948e);
}

.action-said {
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.action-said a {
  color: var(--blo-green-deep, #1f7a2e);
  font-weight: 600;
}

.bad {
  color: #7f1d1d;
}

.page-picker {
  margin-top: 8px;
  padding: 10px 12px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 10px;
}

.picker-search {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  font: inherit;
  font-size: 14px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.picker-note {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.picker-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  max-height: 14rem;
  overflow-y: auto;
}

.picker-page,
.link-btn {
  padding: 4px 0;
  font: inherit;
  font-size: 14px;
  color: var(--blo-green-deep, #1f7a2e);
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
}

.picker-page:disabled {
  color: var(--blo-stone-soft, #9a948e);
  cursor: default;
}

.link-btn {
  font-weight: 600;
  text-decoration: underline;
}

@media (max-width: 640px) {
  .action-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 14px;
  }

  .action-said,
  .picker-note {
    font-size: 14px;
  }

  .picker-search {
    min-height: 44px;
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .picker-page,
  .link-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
}
</style>
