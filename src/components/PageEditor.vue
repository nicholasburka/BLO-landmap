<script setup lang="ts">
/**
 * The page writing surface (P5-49).
 *
 * A researcher writes here, not an engineer — so the toolbar does the
 * remembering ("what's the syntax for a table again?") while the markdown
 * source stays the single truth. Every button is a pure string transform
 * from lib/editor.ts applied around the current selection; nothing is
 * contenteditable and there is no WYSIWYG library to fight.
 *
 * Three things make it feel like a real editor:
 *  - the preview sits beside the source on a wide screen and scrolls with it
 *  - unfinished text is autosaved to localStorage, so a closed tab costs nothing
 *  - citations and embeds are pickers, not syntax to memorise
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import {
  toggleWrap,
  cycleHeading,
  toggleList,
  insertLink,
  insertBlock,
  embedFence,
  citationMarkdown,
  TABLE_SNIPPET,
  readDraft,
  writeDraft,
  clearDraft,
  type EditResult,
} from '@/lib/editor'
import { renderWikiMarkdown } from '@/lib/renderMarkdown'
import { hydrateEmbeds } from '@/lib/wikiEmbeds'
import { askLibrary, askErrorMessage, recentQuestions, type RecentQuestion } from '@/lib/ask'
import EmbedPicker from './EmbedPicker.vue'

const props = defineProps<{
  /** The markdown being edited. */
  modelValue: string
  /** Page slug — namespaces the autosaved draft. */
  slug: string
  /** What the server currently holds. A draft is only worth keeping (and
   *  announcing) while it differs from this. */
  saved: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

/** Below this the panes would be two useless columns, so the screen keeps the
 *  Write/Preview toggle instead. */
const SIDE_BY_SIDE = '(min-width: 1100px)'
/** P5-60: at this width the popovers become bottom sheets, which need a
 *  backdrop — CSS alone cannot add one, so the width is also read in JS. */
const PHONE = '(max-width: 640px)'
/** Long enough that autosave never fires mid-word. */
const AUTOSAVE_MS = 500
/** A citation is only useful while the question is still fresh in mind. */
const RECENT_SHOWN = 10

const sourceEl = ref<HTMLTextAreaElement | null>(null)
const previewEl = ref<HTMLElement | null>(null)
const showPreview = ref(false)
const wide = ref(false)
const phone = ref(false)
const draftRestored = ref(false)

const rendered = computed(() => renderWikiMarkdown(props.modelValue))
/** Side by side when there's room; otherwise whichever the toggle picked. */
const previewVisible = computed(() => wide.value || showPreview.value)
const sourceVisible = computed(() => wide.value || !showPreview.value)

// --- Selection-aware edits -------------------------------------------------

/** Apply a transform to the current selection, then put the caret back where
 *  the transform asked for it. Focus matters: the writer must be able to keep
 *  typing straight after clicking a button. */
async function apply(transform: (text: string, start: number, end: number) => EditResult): Promise<void> {
  const el = sourceEl.value
  if (!el) return
  const result = transform(props.modelValue, el.selectionStart, el.selectionEnd)
  emit('update:modelValue', result.text)
  await nextTick()
  el.focus()
  el.setSelectionRange(result.selectionStart, result.selectionEnd)
}

function bold(): void {
  void apply((t, s, e) => toggleWrap(t, s, e, '**'))
}
function italic(): void {
  void apply((t, s, e) => toggleWrap(t, s, e, '_'))
}
function heading(): void {
  void apply(cycleHeading)
}
function bulletList(): void {
  void apply((t, s, e) => toggleList(t, s, e, 'bullet'))
}
function numberList(): void {
  void apply((t, s, e) => toggleList(t, s, e, 'number'))
}
function table(): void {
  void apply((t, s, e) => insertBlock(t, s, e, TABLE_SNIPPET))
}

/** ⌘/Ctrl B, I, K — the three shortcuts people already have in their fingers. */
function onKeydown(event: KeyboardEvent): void {
  if (!event.metaKey && !event.ctrlKey) return
  if (event.altKey) return
  const key = event.key.toLowerCase()
  if (key === 'b') {
    event.preventDefault()
    bold()
  } else if (key === 'i') {
    event.preventDefault()
    italic()
  } else if (key === 'k') {
    event.preventDefault()
    void openLink()
  }
}

// --- Popovers --------------------------------------------------------------
// One at a time: opening any of them closes the others, so the toolbar never
// sprouts two overlapping panels.

type Popover = 'link' | 'embed' | 'cite' | null
const openPopover = ref<Popover>(null)

/** Clicking a toolbar button steals focus from the textarea and with it the
 *  selection the button is supposed to act on; preventing mousedown's default
 *  keeps both where they are. */
function keepSelection(event: MouseEvent): void {
  event.preventDefault()
}

/** The selection the popover will act on, captured when it opens — by the
 *  time the writer has typed a URL, the textarea's own selection is gone. */
const pending = ref<{ start: number; end: number }>({ start: 0, end: 0 })

function capture(): void {
  const el = sourceEl.value
  pending.value = { start: el?.selectionStart ?? props.modelValue.length, end: el?.selectionEnd ?? props.modelValue.length }
}

function closePopover(): void {
  openPopover.value = null
}

async function insertAtPending(build: (text: string, start: number, end: number) => EditResult): Promise<void> {
  const { start, end } = pending.value
  const result = build(props.modelValue, start, end)
  emit('update:modelValue', result.text)
  closePopover()
  await nextTick()
  const el = sourceEl.value
  if (!el) return
  el.focus()
  el.setSelectionRange(result.selectionStart, result.selectionEnd)
}

// Link
const linkUrl = ref('')
const linkEl = ref<HTMLInputElement | null>(null)
async function openLink(): Promise<void> {
  capture()
  linkUrl.value = ''
  openPopover.value = 'link'
  // ⌘K has to land the caret in the URL box, or the shortcut is half a
  // feature and the writer reaches for the mouse anyway.
  await nextTick()
  linkEl.value?.focus()
}
function confirmLink(): void {
  const url = linkUrl.value.trim()
  if (!url) return
  void insertAtPending((t, s, e) => insertLink(t, s, e, url))
}

// Embed
function openEmbed(): void {
  capture()
  openPopover.value = 'embed'
}
function onEmbedSelect(choice: { kind: 'entry' | 'view' | 'map'; slug: string }): void {
  void insertAtPending((t, s, e) => insertBlock(t, s, e, embedFence(choice.kind, choice.slug)))
}

// Citation
const recent = ref<RecentQuestion[]>([])
const citing = ref('')
const citeError = ref('')
function openCite(): void {
  capture()
  citeError.value = ''
  recent.value = recentQuestions().slice(0, RECENT_SHOWN)
  openPopover.value = 'cite'
}

/** The recent list stores the question, not the answer, so the answer is
 *  fetched fresh — which also means the quote reflects today's library. */
async function cite(question: RecentQuestion): Promise<void> {
  if (citing.value) return
  citing.value = question.q
  citeError.value = ''
  try {
    const answer = await askLibrary(question.q, question.dataset)
    await insertAtPending((t, s, e) =>
      insertBlock(t, s, e, citationMarkdown(question.q, answer, question.dataset)),
    )
  } catch (err: unknown) {
    citeError.value = askErrorMessage(err)
  } finally {
    citing.value = ''
  }
}

// --- Draft autosave --------------------------------------------------------

let autosave: ReturnType<typeof setTimeout> | undefined

watch(
  () => props.modelValue,
  text => {
    clearTimeout(autosave)
    autosave = setTimeout(() => {
      // A draft identical to the saved page is not a draft — clearing it here
      // is what stops a stale "Draft restored" on the next visit.
      if (text === props.saved) clearDraft(props.slug)
      else writeDraft(props.slug, text)
    }, AUTOSAVE_MS)
  },
)

onBeforeUnmount(() => clearTimeout(autosave))

function discardDraft(): void {
  clearDraft(props.slug)
  draftRestored.value = false
  emit('update:modelValue', props.saved)
}

// --- Preview: hydration and scroll sync ------------------------------------

watch(
  [rendered, previewVisible],
  () => {
    // P7-4: `liveMaps: false`. This preview re-renders its whole DOM on every
    // keystroke, so a map block here would build and tear down a mapbox-gl
    // WebGL context per keystroke — a browser keeps only so many and starts
    // dropping them, and each one re-downloads nothing but still costs a GPU
    // context. The block renders as itself instead, naming the view it will
    // draw on the page, which is the thing a writer needs to see. No router is
    // lent for the same reason: the only thing that wanted one was the canvas.
    if (previewEl.value) void hydrateEmbeds(previewEl.value, { liveMaps: false })
  },
  { flush: 'post' },
)

/** Proportional, not line-mapped: markdown source and rendered output have no
 *  1:1 relationship, and "roughly the same place in the document" is what a
 *  writer actually wants. */
function syncScroll(): void {
  const source = sourceEl.value
  const preview = previewEl.value
  if (!source || !preview) return
  const sourceRange = source.scrollHeight - source.clientHeight
  const previewRange = preview.scrollHeight - preview.clientHeight
  if (sourceRange <= 0 || previewRange <= 0) return
  preview.scrollTop = (source.scrollTop / sourceRange) * previewRange
}

// --- Mount -----------------------------------------------------------------

let media: MediaQueryList | null = null
let phoneMedia: MediaQueryList | null = null
function onMediaChange(event: MediaQueryListEvent): void {
  wide.value = event.matches
}
function onPhoneChange(event: MediaQueryListEvent): void {
  phone.value = event.matches
}

onMounted(() => {
  if (typeof window.matchMedia === 'function') {
    media = window.matchMedia(SIDE_BY_SIDE)
    wide.value = media.matches
    media.addEventListener?.('change', onMediaChange)
    phoneMedia = window.matchMedia(PHONE)
    phone.value = phoneMedia.matches
    phoneMedia.addEventListener?.('change', onPhoneChange)
  }

  // Unsaved text from a closed tab or a crashed browser. Only worth restoring
  // (and announcing) while it still differs from what the server holds.
  const stored = readDraft(props.slug)
  if (stored !== null && stored !== props.saved) {
    draftRestored.value = true
    if (stored !== props.modelValue) emit('update:modelValue', stored)
  }
})

onBeforeUnmount(() => {
  media?.removeEventListener?.('change', onMediaChange)
  phoneMedia?.removeEventListener?.('change', onPhoneChange)
})
</script>

<template>
  <div class="page-editor">
    <div class="toolbar" role="toolbar" aria-label="Formatting">
      <!-- P5-60: on a phone the nine format buttons scroll sideways as one
           strip instead of wrapping into three rows of 24 px targets. -->
      <div class="tool-group strip" data-testid="tb-format-group">
        <button type="button" class="tool" data-testid="tb-heading" title="Heading (H2 / H3)" @mousedown="keepSelection" @click="heading">Heading</button>
        <button type="button" class="tool" data-testid="tb-bold" aria-label="Bold" title="Bold (⌘B)" @mousedown="keepSelection" @click="bold"><strong>B</strong></button>
        <button type="button" class="tool" data-testid="tb-italic" aria-label="Italic" title="Italic (⌘I)" @mousedown="keepSelection" @click="italic"><em>I</em></button>
        <button type="button" class="tool" data-testid="tb-bullet" aria-label="Bulleted list" title="Bulleted list" @mousedown="keepSelection" @click="bulletList">• List</button>
        <button type="button" class="tool" data-testid="tb-number" aria-label="Numbered list" title="Numbered list" @mousedown="keepSelection" @click="numberList">1. List</button>
        <button type="button" class="tool" data-testid="tb-link" title="Link (⌘K)" @mousedown="keepSelection" @click="openLink">Link</button>
        <button type="button" class="tool" data-testid="tb-table" title="Insert a table" @mousedown="keepSelection" @click="table">Table</button>
        <button type="button" class="tool" data-testid="tb-embed" title="Embed an entry or saved view" @mousedown="keepSelection" @click="openEmbed">Embed</button>
        <button type="button" class="tool" data-testid="tb-cite" title="Quote a recent Ask answer" @mousedown="keepSelection" @click="openCite">Insert citation</button>
      </div>

      <!-- Two states of one thing, so a segmented control rather than two
           buttons that happen to sit next to each other. -->
      <div v-if="!wide" class="tool-group segmented" role="group" aria-label="Write or preview" data-testid="tb-write-preview">
        <button type="button" class="tool" :class="{ active: !showPreview }" :aria-pressed="!showPreview" data-testid="toggle-write" @click="showPreview = false">Write</button>
        <button type="button" class="tool" :class="{ active: showPreview }" :aria-pressed="showPreview" data-testid="toggle-preview" @click="showPreview = true">Preview</button>
      </div>
    </div>

    <!-- Popovers hang under the toolbar so they never cover what's being
         written. On a phone there is no room for that, so the host becomes a
         dimmed backdrop and each popover rises from the bottom edge. -->
    <div v-if="openPopover" class="popover-host" :class="{ 'sheet-backdrop': phone }" data-testid="popover-host" @click.self="closePopover">
    <div v-if="openPopover === 'link'" class="popover" :class="{ sheet: phone }" data-testid="link-popover">
      <form data-testid="link-form" @submit.prevent="confirmLink">
        <label class="popover-label" for="link-url-input">Link address</label>
        <div class="popover-row">
          <input
            id="link-url-input"
            ref="linkEl"
            v-model="linkUrl"
            type="text"
            class="popover-input"
            data-testid="link-url"
            placeholder="/wiki/another-page or https://…"
            @keydown.escape="closePopover"
          />
          <button type="submit" class="tool primary">Add link</button>
          <button type="button" class="tool" data-testid="link-cancel" @click="closePopover">Cancel</button>
        </div>
      </form>
    </div>

    <div v-if="openPopover === 'embed'" class="popover" :class="{ sheet: phone }" data-testid="embed-popover">
      <span v-if="phone" class="sheet-handle" aria-hidden="true"></span>
      <EmbedPicker @select="onEmbedSelect" @close="closePopover" />
    </div>

    <div v-if="openPopover === 'cite'" class="popover" :class="{ sheet: phone }" data-testid="cite-popover">
      <span v-if="phone" class="sheet-handle" aria-hidden="true"></span>
      <div class="popover-head">
        <span class="popover-label">Quote a recent answer</span>
        <button type="button" class="tool" data-testid="cite-close" @click="closePopover">Close</button>
      </div>
      <p v-if="citeError" class="popover-note error" data-testid="cite-error">{{ citeError }}</p>
      <p v-if="!recent.length" class="popover-note" data-testid="cite-empty">
        Nothing to quote yet — ask a question on the Ask page first, then come back.
      </p>
      <ul v-else class="cite-list">
        <li v-for="question in recent" :key="`${question.q}|${question.dataset ?? ''}`">
          <button
            type="button"
            class="cite-item"
            data-testid="cite-item"
            :disabled="!!citing"
            @click="cite(question)"
          >
            <span>{{ question.q }}</span>
            <span v-if="citing === question.q" class="cite-status">Getting the answer…</span>
          </button>
        </li>
      </ul>
    </div>
    </div>

    <p v-if="draftRestored" class="draft-note" data-testid="draft-restored">
      Draft restored — you have unsaved changes from last time.
      <button type="button" class="link-btn" data-testid="draft-discard" @click="discardDraft">
        Discard
      </button>
    </p>

    <div class="panes" :class="{ split: wide }">
      <textarea
        v-if="sourceVisible"
        ref="sourceEl"
        :value="modelValue"
        rows="20"
        class="source"
        data-testid="editor-textarea"
        aria-label="Page markdown"
        placeholder="# Page title&#10;&#10;Write markdown here…"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onKeydown"
        @scroll="syncScroll"
      ></textarea>
      <!-- Sanitized by renderWikiMarkdown (DOMPurify) — v-html is safe here. -->
      <div
        v-if="previewVisible"
        ref="previewEl"
        class="wiki-content preview"
        data-testid="editor-preview"
        v-html="rendered"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.page-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tool-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tool {
  padding: 4px 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: transparent;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.tool:hover {
  background: rgba(17, 17, 17, 0.04);
}

.tool.active {
  background: rgba(17, 17, 17, 0.06);
}

.tool.primary {
  color: #ffffff;
  background: var(--blo-ink);
  border-color: var(--blo-ink);
}

/* A plain wrapper on a wide screen: it must not add a box of its own. */
.popover-host {
  display: contents;
}

.popover {
  padding: 10px 12px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  box-shadow: 0 6px 18px rgba(17, 17, 17, 0.1);
}

.popover-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.popover-label {
  display: block;
  margin-bottom: 4px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--blo-stone);
}

.popover-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.popover-input {
  flex: 1 1 240px;
  padding: 5px 10px;
  font-size: 14px;
  color: var(--blo-ink);
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
}

.popover-note {
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--blo-stone);
}

.popover-note.error {
  color: #b3261e;
}

.cite-list {
  max-height: 240px;
  margin: 6px 0 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.cite-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  font-size: 13.5px;
  text-align: left;
  color: var(--blo-ink);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.cite-item:hover:not(:disabled) {
  background: rgba(17, 17, 17, 0.05);
}

.cite-item:disabled {
  cursor: default;
  opacity: 0.7;
}

.cite-status {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--blo-stone);
}

.draft-note {
  margin: 0;
  font-size: 13px;
  color: var(--blo-stone);
}

.link-btn {
  padding: 0;
  font: inherit;
  color: #0d47a1;
  background: none;
  border: 0;
  text-decoration: underline;
  cursor: pointer;
}

.panes {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  align-items: start;
}

.panes.split {
  grid-template-columns: 1fr 1fr;
}

.source {
  width: 100%;
  min-height: 340px;
  box-sizing: border-box;
  padding: 12px 14px;
  font-size: 14px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  line-height: 1.5;
  color: var(--blo-ink);
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  resize: vertical;
}

.panes.split .preview {
  max-height: 70vh;
  overflow-y: auto;
}

/* --- P5-60 (mobile pass) --------------------------------------------------
   The editor is the one internal surface somebody uses for half an hour at a
   time, so every control here gets a real target. */
@media (max-width: 640px) {
  /* Every box from the editor down is exactly as wide as it is given, never as
     wide as its widest child — otherwise the toolbar strip's nine buttons set
     the width of the page. */
  .page-editor,
  .toolbar,
  .panes {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .toolbar {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }

  /* One row that scrolls, not three rows that wrap — and its content width
     stays its own business (see .strip in InternalMobileStyles.vue). */
  .tool-group.strip {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 4px;
  }

  .tool {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 12px;
    font-size: 14px;
    white-space: nowrap;
  }

  /* Segmented control: one box, two equal halves, the full width. */
  .tool-group.segmented {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    flex-wrap: nowrap;
    gap: 0;
    border: 1px solid var(--blo-cream-divider);
    border-radius: 8px;
    overflow: hidden;
  }

  .tool-group.segmented .tool {
    flex: 1 1 0;
    border: 0;
    border-radius: 0;
  }

  .tool-group.segmented .tool + .tool {
    border-left: 1px solid var(--blo-cream-divider);
  }

  .tool-group.segmented .tool.active {
    color: #fff;
    background: var(--blo-ink);
  }

  /* The popover host is the sheet backdrop; .popover-host's display:contents
     would stop it being a box at all, so it is undone here. */
  .popover-host {
    display: flex;
    z-index: 60;
  }

  .popover {
    box-sizing: border-box;
    padding: 10px 14px calc(20px + env(safe-area-inset-bottom, 0px));
    border-radius: 14px 14px 0 0;
  }

  .popover-row {
    flex-direction: column;
    align-items: stretch;
  }

  .popover-input {
    flex: 1 1 auto;
    min-height: 44px;
    font-size: 16px;
  }

  .popover-label,
  .popover-note {
    font-size: 14px;
  }

  .cite-item {
    min-height: 44px;
    font-size: 14px;
  }

  .draft-note {
    font-size: 14px;
  }

  .link-btn {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  /* 16 px is the size below which iOS Safari zooms the page on focus — the
     one thing that makes writing on a phone feel broken. */
  /* A textarea's default `cols` gives it an intrinsic width; the grid track
     must not honour it, and the box must not exceed the pane. */
  .panes {
    grid-template-columns: minmax(0, 1fr);
  }

  .source {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    min-height: 50svh;
    font-size: 16px;
  }
}
</style>
