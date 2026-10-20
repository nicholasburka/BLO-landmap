<script lang="ts">
/** Shared by every instance: `<script setup>` re-runs per component, so a
 *  counter declared there would hand the same id to every answer. */
let keepSeq = 0
</script>

<script setup lang="ts">
/**
 * What to do with an answer (P6-7b, spec E.17; reshaped by P13-4).
 *
 * One decision — **Keep this…** — opening onto the three things it can
 * become: a NEW page, a note filed under answers, or an append to a page that
 * already exists. **Open** sits beside it when the answer produced an
 * analysis.
 *
 * It was three equal-weight verbs, and the first of them was missing: a lead
 * who asked for a starter pack wanted a page to work off, and the controls
 * offered a note, an append to something that already existed, and Open. They
 * kept nothing. The missing option is now the first line of the panel and the
 * only solid button in it.
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
import {
  saveAnswerAsNote,
  saveAnswerAsPage,
  addAnswerToPage,
  noteTitleFromQuestion,
  type AskAnswer,
} from '@/lib/ask'
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

// --- P13-4: keeping an answer ----------------------------------------------

/** The panel of three ways to keep it. */
const keepOpen = ref(false)

/** One of these renders per answer, so the title field needs an id of its
 *  own — a fixed one would point every label at the first answer's input. */
const titleId = `keep-title-${++keepSeq}`

/** The new page's title. Defaults to the question, which is almost always
 *  the right name for what the answer is. */
const defaultTitle = computed(() => noteTitleFromQuestion(props.question))
const pageTitle = ref('')
const savingPage = ref(false)
const savedPage = ref<{ slug: string; title: string } | null>(null)
const pageError = ref('')

async function keepAsPage(): Promise<void> {
  if (savingPage.value) return
  savingPage.value = true
  pageError.value = ''
  try {
    savedPage.value = await saveAnswerAsPage(
      props.question,
      answer.value,
      pageTitle.value.trim() || defaultTitle.value,
    )
  } catch (err: unknown) {
    pageError.value = friendlyError(err, 'That page could not be made.')
  } finally {
    savingPage.value = false
  }
}

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
      <!-- P13-4: ONE decision — keep this — instead of three unrelated verbs,
           and the option that was missing entirely. A lead who asked for a
           starter pack wanted it to become a page they could work off; the
           controls offered a note, an append to a page that already existed,
           and Open. There was no way to make a new page from an answer. -->
      <button
        type="button"
        class="action-btn action-keep"
        :aria-expanded="keepOpen"
        data-testid="chat-keep"
        @click="keepOpen = !keepOpen"
      >
        {{ keepOpen ? 'Never mind' : 'Keep this…' }}
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

    <!-- The three ways to keep it, named by what they make. -->
    <div v-if="keepOpen" class="keep-panel" data-testid="chat-keep-panel">
      <p class="keep-line">
        <label class="keep-label" :for="titleId">As a new page, called</label>
        <input
          :id="titleId"
          v-model="pageTitle"
          class="blo-select keep-title"
          type="text"
          :placeholder="defaultTitle"
          data-testid="chat-keep-title"
        />
        <button
          type="button"
          class="blo-act blo-act--write"
          :disabled="!!savingPage"
          data-testid="chat-keep-page"
          @click="keepAsPage"
        >{{ savingPage ? 'Making…' : 'Make the page' }}</button>
      </p>
      <p class="keep-line">
        <span class="keep-label">Or as a note, filed under answers</span>
        <button
          type="button"
          class="blo-act"
          :disabled="savingNote || !!savedNote"
          data-testid="chat-save-note"
          @click="saveNote"
        >{{ savingNote ? 'Saving…' : 'Save as note' }}</button>
      </p>
      <p class="keep-line">
        <span class="keep-label">Or add it to a page you already have</span>
        <button
          type="button"
          class="blo-act"
          :aria-expanded="pickerOpen"
          data-testid="chat-add-to-page"
          @click="togglePicker"
        >Choose a page…</button>
      </p>
      <p v-if="savedPage" class="action-said" data-testid="chat-page-made">
        Made — <RouterLink :to="`/wiki/${savedPage.slug}`" data-testid="chat-made-link">open the page</RouterLink>
      </p>
      <p v-if="pageError" class="action-said bad" data-testid="chat-page-error">{{ pageError }}</p>
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

/* P13-4: the three ways to keep an answer, as one decision. */
.keep-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  padding: 12px 14px;
  background: var(--blo-cream-deep, #ede8dd);
  border-radius: 8px;
}

.keep-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0;
}

.keep-label {
  font-size: var(--blo-text-meta, 13px);
  color: var(--blo-stone, #6b6560);
}

.keep-title {
  flex: 1 1 18rem;
  min-width: 0;
}

/* Keeping is the point of this row; Open is a convenience beside it. */
.action-keep {
  font-weight: 600;
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
