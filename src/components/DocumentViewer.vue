<script setup lang="ts">
/**
 * In-app document viewer (P5-44, extended by P5-46): shows a PDF, image, text
 * or markdown file inline so a reviewer never has to download it. Bytes are
 * fetched through the internal API and rendered from a same-origin blob (see
 * lib/documentView), so nothing cross-origin and nothing script-bearing is
 * ever framed.
 *
 * P5-46 adds the reading tools the research intern actually asked for:
 *  - a Word or RTF file shows the text the server pulled out of it, instead
 *    of "Preview isn't available";
 *  - a PDF can be flipped between the original and its text;
 *  - "Find in document" searches whichever text is on screen;
 *  - a `#page=N` link (an Ask citation) opens the PDF at that page and
 *    scrolls the text view to it.
 */
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue'
import {
  loadDocument,
  loadDocumentText,
  pageFromHash,
  renderDocumentText,
  type DocumentText,
  type LoadedDocument,
} from '@/lib/documentView'
import { libraryFileUrl } from '@/lib/libraryCatalog'
import { friendlyError } from '@/lib/errors'

const props = defineProps<{ slug: string; name: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const doc = ref<LoadedDocument | null>(null)
const loading = ref(false)
const error = ref('')

// PDF "Text" view (P5-46): loaded on demand, then kept for the toggle.
const showText = ref(false)
const pdfText = ref<DocumentText | null>(null)
const textLoading = ref(false)
const textError = ref('')

// Find in document.
const query = ref('')
const activeMatch = ref(0)
const pane = ref<HTMLElement | null>(null)

/** The page an Ask citation asked for, read once per open. */
const anchorPage = ref<number | null>(null)

const downloadUrl = computed(() => libraryFileUrl(props.slug, props.name))

/** The PDF frame honours `#page=N` in Chrome's and Firefox's built-in
 *  viewers, which is the whole reason Ask links carry it. */
const pdfSrc = computed(() =>
  doc.value?.url && anchorPage.value ? `${doc.value.url}#page=${anchorPage.value}` : doc.value?.url,
)

/** The text currently on screen: an extracted document, a plain text file, or
 *  a PDF flipped to its text view. Null when there is no text pane. */
const paneText = computed<string | null>(() => {
  if (!doc.value || doc.value.fallback) return null
  if (doc.value.kind === 'pdf') return showText.value ? (pdfText.value?.text ?? null) : null
  return doc.value.kind === 'text' ? (doc.value.text ?? '') : null
})

const rendered = computed(() =>
  paneText.value === null
    ? null
    : renderDocumentText(paneText.value, { query: query.value, active: activeMatch.value }),
)

const matchCount = computed(() => rendered.value?.count ?? 0)

function revoke(): void {
  if (doc.value?.url) URL.revokeObjectURL(doc.value.url)
}

async function open(slug: string, name: string): Promise<void> {
  revoke()
  doc.value = null
  pdfText.value = null
  showText.value = false
  textError.value = ''
  query.value = ''
  activeMatch.value = 0
  error.value = ''
  anchorPage.value = pageFromHash(window.location.hash)
  loading.value = true
  try {
    doc.value = await loadDocument(slug, name)
  } catch (err: unknown) {
    error.value = friendlyError(err, 'Could not load this file.')
  } finally {
    loading.value = false
  }
}

/** Flip a PDF between the original and its text, fetching the text once. */
async function toggleText(): Promise<void> {
  if (showText.value) {
    showText.value = false
    return
  }
  showText.value = true
  if (pdfText.value || textLoading.value) return
  textLoading.value = true
  textError.value = ''
  try {
    pdfText.value = await loadDocumentText(props.slug, props.name)
  } catch (err: unknown) {
    textError.value = friendlyError(err, 'Could not load the text of this file.')
  } finally {
    textLoading.value = false
  }
}

function scrollTo(selector: string): void {
  // scrollIntoView does not exist in jsdom (and not on a missing element).
  const target = pane.value?.querySelector(selector) as HTMLElement | null
  target?.scrollIntoView?.({ block: 'center' })
}

/** Enter walks the matches, wrapping at the end — the behaviour of every
 *  find bar the reader already knows. */
async function nextMatch(): Promise<void> {
  if (matchCount.value === 0) return
  activeMatch.value = (activeMatch.value + 1) % matchCount.value
  await nextTick()
  scrollTo('#doc-hit')
}

// A new search starts at its first hit, not wherever the last one ended.
watch(query, () => {
  activeMatch.value = 0
})

// When the text pane appears and a citation named a page, go to it.
watch(paneText, async text => {
  if (text === null || !anchorPage.value) return
  await nextTick()
  scrollTo(`#doc-page-${anchorPage.value}`)
})

watch(
  () => [props.slug, props.name] as const,
  ([slug, name]) => {
    if (slug && name) void open(slug, name)
  },
  { immediate: true },
)

onBeforeUnmount(revoke)
</script>

<template>
  <section class="doc-viewer" data-testid="doc-viewer">
    <header class="doc-bar">
      <button type="button" class="doc-back touch-target" data-testid="doc-close" @click="emit('close')">← Files</button>
      <span class="doc-name">{{ name }}</span>
      <button
        v-if="doc && doc.kind === 'pdf' && !doc.fallback"
        type="button"
        class="doc-toggle touch-target"
        data-testid="doc-text-toggle"
        @click="toggleText"
      >
        {{ showText ? 'Original' : 'Text' }}
      </button>
      <a class="doc-download touch-target" :href="downloadUrl" :download="name" data-testid="doc-download">Download</a>
    </header>

    <p v-if="loading" class="doc-state">Opening {{ name }}…</p>
    <p v-else-if="error" class="doc-state error" data-testid="doc-error">{{ error }}</p>

    <template v-else-if="doc">
      <p v-if="doc.fallback" class="doc-state" data-testid="doc-fallback">
        <template v-if="doc.fallback === 'too-large'">This file is too large to preview here. Download it to review.</template>
        <template v-else>Preview isn't available for this file type. Download it to review.</template>
      </p>

      <template v-else-if="doc.kind === 'pdf' && showText">
        <p v-if="textLoading" class="doc-state">Reading the text of {{ name }}…</p>
        <p v-else-if="textError" class="doc-state error" data-testid="doc-text-error">{{ textError }}</p>
      </template>

      <!-- Find in document: shown wherever there is text on screen. -->
      <div v-if="paneText !== null" class="doc-find" data-testid="doc-find">
        <input
          v-model="query"
          type="search"
          class="doc-find-input"
          data-testid="doc-find-input"
          placeholder="Find in document"
          aria-label="Find in document"
          @keydown.enter.prevent="nextMatch"
        />
        <span v-if="query.trim()" class="doc-find-count" data-testid="doc-find-count">
          {{ matchCount ? `${activeMatch + 1} of ${matchCount}` : 'no matches' }}
        </span>
        <button
          v-if="matchCount"
          type="button"
          class="doc-find-next touch-target"
          data-testid="doc-find-next"
          @click="nextMatch"
        >
          Next
        </button>
      </div>

      <iframe
        v-if="doc.kind === 'pdf' && !showText"
        class="doc-pdf"
        data-testid="doc-pdf"
        :src="pdfSrc"
        :title="name"
      ></iframe>

      <div v-else-if="doc.kind === 'image'" class="doc-image-wrap">
        <img class="doc-image" data-testid="doc-image" :src="doc.url" :alt="name" />
      </div>

      <!-- eslint-disable-next-line vue/no-v-html -- sanitized by renderWikiMarkdown (DOMPurify) -->
      <div v-else-if="doc.kind === 'markdown'" class="doc-markdown wiki-body" data-testid="doc-markdown" v-html="doc.html"></div>

      <!-- eslint-disable-next-line vue/no-v-html -- renderDocumentText escapes every character it did not add itself -->
      <pre
        v-else-if="rendered"
        ref="pane"
        class="doc-text"
        data-testid="doc-text"
        v-html="rendered.html"
      ></pre>
    </template>
  </section>
</template>

<style scoped>
.doc-viewer { display: flex; flex-direction: column; gap: 0.75rem; }
.doc-bar { display: flex; align-items: center; gap: 0.75rem; }
.doc-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-back { border: 0; background: none; color: #1b5e20; cursor: pointer; font: inherit; padding: 0.25rem 0; }
.doc-toggle { border: 1px solid #cfd8dc; background: #fff; border-radius: 4px; color: #1b5e20; cursor: pointer; font: inherit; font-weight: 600; padding: 0.25rem 0.6rem; }
.doc-download { color: #1b5e20; text-decoration: none; font-weight: 600; }
.doc-state { color: #607d8b; padding: 1.5rem 0; }
.doc-state.error { color: #b71c1c; }
.doc-find { display: flex; align-items: center; gap: 0.6rem; }
.doc-find-input { flex: 1; min-width: 0; max-width: 22rem; padding: 0.35rem 0.5rem; border: 1px solid #cfd8dc; border-radius: 4px; font: inherit; }
.doc-find-count { color: #607d8b; font-size: 0.85rem; }
.doc-find-next { border: 1px solid #cfd8dc; background: #fff; border-radius: 4px; color: #1b5e20; cursor: pointer; font: inherit; padding: 0.3rem 0.6rem; }
.doc-pdf { width: 100%; height: min(80vh, 900px); border: 1px solid #cfd8dc; border-radius: 6px; }
.doc-image-wrap { text-align: center; }
.doc-image { max-width: 100%; height: auto; border-radius: 6px; }
.doc-markdown { line-height: 1.55; }
.doc-text { max-height: min(80vh, 900px); overflow: auto; padding: 1rem; background: #263238; color: #eceff1; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
.doc-text :deep(mark) { background: #ffe082; color: #263238; }
.doc-text :deep(.doc-hit-active) { background: #ffab40; }
.doc-text :deep(.doc-page-mark) { display: block; color: #90a4ae; margin: 0.75rem 0 0.25rem; }

/* --- Phone (P5-60) ---------------------------------------------------------
   A PDF in an iframe cannot reflow, so it gets a tall frame (70svh — the
   small viewport, so the browser chrome appearing never crops it) and the
   reader pinches. The bar wraps into two rows of 44 px controls and the find
   box takes the whole width, because searching is how you read a long
   document on a phone. */
@media (max-width: 640px) {
  .doc-bar { flex-wrap: wrap; gap: 0.5rem; }
  .doc-name { flex: 1 1 100%; order: -1; white-space: normal; overflow-wrap: anywhere; font-size: 1rem; }
  .doc-back,
  .doc-toggle,
  .doc-download { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 0.75rem; font-size: 0.95rem; }
  .doc-back { padding-left: 0; }
  .doc-find { flex-wrap: wrap; }
  .doc-find-input { flex: 1 1 100%; max-width: none; min-height: 44px; font-size: 16px; }
  .doc-find-count { font-size: 0.95rem; }
  .doc-find-next { min-height: 44px; padding: 0 0.9rem; font-size: 0.95rem; }
  .doc-state { font-size: 0.95rem; }
  .doc-pdf { height: 70svh; }
  .doc-text { max-height: 70svh; padding: 0.75rem; font-size: 0.95rem; }
}
</style>
