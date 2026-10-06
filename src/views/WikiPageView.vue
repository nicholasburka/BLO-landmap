<script setup lang="ts">
/**
 * Wiki page (P5-15): rendered view with Edit → PageEditor (P5-49: toolbar,
 * side-by-side preview, autosaved draft, citation and embed pickers).
 * A slug that doesn't exist yet renders straight into create mode with a
 * prefilled `# Title` — the index's "New page" lands here, and so does any
 * red link someone types by hand.
 *
 * This view owns the round trip: it holds the `updatedAt` the page was loaded
 * with, hands it back on save, and turns the server's refusal into the
 * "reload or overwrite" choice. The editor itself only edits text.
 *
 * Internal links inside the rendered markdown (/wiki/…, /library/…) are
 * intercepted and routed in-SPA; renderWikiMarkdown leaves them un-hardened
 * for exactly that purpose. External links open hardened in a new tab.
 */
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { fetchWikiPage, saveWikiPage, WikiConflictError, type WikiPage } from '@/lib/wiki'
import { renderWikiMarkdown, isInternalHref } from '@/lib/renderMarkdown'
import { friendlyError } from '@/lib/errors'
import { hydrateEmbeds } from '@/lib/wikiEmbeds'
import { clearDraft } from '@/lib/editor'
import PageEditor from '@/components/PageEditor.vue'

const route = useRoute()
const router = useRouter()

const page = ref<WikiPage | null>(null)
const loading = ref(true)
const error = ref('')
const notFound = ref(false)

const editing = ref(false)
const draft = ref('')
const saving = ref(false)
const saveNote = ref('')
const saveError = ref(false)
/** The page's `updatedAt` when this browser loaded it. Sent back on save so
 *  the server can refuse a write over someone else's edit (P5-49). */
const baseline = ref<string | undefined>(undefined)
/** Set when the server refused: holds the sentence to show. Clearing it is
 *  what dismisses the notice. */
const conflict = ref('')

/** What the server holds — the editor measures its autosaved draft against
 *  this to decide whether there is anything worth restoring. */
const savedMarkdown = computed(() => page.value?.markdown ?? '')

const slug = computed(() => String(route.params.slug))

/**
 * The server takes a page's title from its first `# heading`, so a page's
 * markdown almost always opens with the very words the reading view prints
 * above it. Drop that one heading (P5-73) so the page is not named twice —
 * the markdown itself is untouched, and a body whose first heading says
 * something else keeps it.
 */
function bodyWithoutTitleHeading(markdown: string, title: string): string {
  const heading = /^[ \t]*\n*[ \t]*#[ \t]+(.+?)[ \t]*(?:\n|$)/.exec(markdown)
  if (!heading || heading[1].trim() !== title.trim()) return markdown
  return markdown.slice(heading[0].length).replace(/^\n+/, '')
}

const renderedPage = computed(() =>
  page.value ? renderWikiMarkdown(bodyWithoutTitleHeading(page.value.markdown, page.value.title)) : '',
)

/** Embed hydration (P5-17): after v-html lands sanitized placeholder divs in
 *  the DOM, upgrade them into live view/entry cards. flush:'post' runs the
 *  watchers after the DOM update, so no manual nextTick. hydrateEmbeds never
 *  rejects and per-slug fetch caching keeps keystroke-by-keystroke preview
 *  re-renders cheap. P7-4 adds `map:` blocks to what gets upgraded — a live
 *  canvas rather than a card. */
const contentEl = ref<HTMLElement | null>(null)

watch(
  [renderedPage, editing],
  () => {
    // P7-4: the page lends its router, so a map block's own links and
    // `MapCanvas`'s feature popups route through the SPA — an app mounted
    // inside a placeholder has no plugins of its own. `liveMaps` is left at
    // its default: this IS the page, and a block here draws.
    if (contentEl.value) void hydrateEmbeds(contentEl.value, { router })
  },
  { immediate: true, flush: 'post' },
)

/** Title for a brand-new page: ?title=… from the index form, else the slug. */
function newPageTitle(): string {
  const fromQuery = typeof route.query.title === 'string' ? route.query.title.trim() : ''
  return fromQuery || slug.value
}

async function load(currentSlug: string): Promise<void> {
  loading.value = true
  error.value = ''
  notFound.value = false
  editing.value = false
  saveNote.value = ''
  saveError.value = false
  conflict.value = ''
  try {
    const result = await fetchWikiPage(currentSlug)
    page.value = result
    baseline.value = result?.updatedAt
    if (result === null) {
      notFound.value = true
      draft.value = `# ${newPageTitle()}\n\n`
      editing.value = true
    }
  } catch (err: unknown) {
    error.value = friendlyError(err, 'This page did not load. Try again in a moment.')
  } finally {
    loading.value = false
  }
}

watch(slug, s => load(s), { immediate: true })

function startEditing(): void {
  draft.value = savedMarkdown.value
  saveNote.value = ''
  saveError.value = false
  conflict.value = ''
  editing.value = true
}

function cancelEditing(): void {
  if (saving.value) return
  if (notFound.value) {
    router.push('/wiki')
    return
  }
  editing.value = false
  saveNote.value = ''
  saveError.value = false
  conflict.value = ''
}

/**
 * Save. `overwrite` drops the baseline, which is the "save anyway" path after
 * a conflict — the server only guards a write that claims to know when the
 * page was last changed.
 */
async function save(overwrite = false): Promise<void> {
  if (saving.value) return
  saving.value = true
  saveNote.value = ''
  saveError.value = false
  conflict.value = ''
  try {
    const since = overwrite ? undefined : baseline.value
    const result = await saveWikiPage(slug.value, draft.value, since ? { ifUnmodifiedSince: since } : {})
    page.value = {
      slug: result.slug,
      title: result.title,
      markdown: draft.value,
      updatedAt: result.updatedAt,
    }
    baseline.value = result.updatedAt
    notFound.value = false
    editing.value = false
    // The page and the draft now agree, so the safety copy has done its job.
    clearDraft(slug.value)
    saveNote.value = result.created ? 'Page created.' : 'Saved.'
  } catch (err: unknown) {
    if (err instanceof WikiConflictError) {
      // Stay in the editor with the text intact: the writer chooses between
      // reloading and overwriting, and loses nothing either way.
      conflict.value = err.message
    } else {
      saveError.value = true
      saveNote.value = friendlyError(err, 'This page could not be saved. Try again in a moment.')
    }
  } finally {
    saving.value = false
  }
}

/** Reload after a conflict. The autosaved draft is deliberately left alone —
 *  reopening the editor offers it straight back, so this never costs work. */
function reloadAfterConflict(): void {
  conflict.value = ''
  void load(slug.value)
}

/** Route internal links (/wiki/…, /library/…, anything same-origin) through
 *  the SPA router instead of a full page load. External links keep their
 *  target=_blank from the sanitizer and never reach preventDefault. */
function onContentClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0) return
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const anchor = (event.target as HTMLElement).closest('a')
  if (!anchor) return
  const href = anchor.getAttribute('href')
  if (!isInternalHref(href)) return
  event.preventDefault()
  router.push(href!)
}
</script>

<template>
  <div class="wiki-page-view">
    <div class="wiki-page-panel" :class="{ editing }">
      <RouterLink to="/docs?kind=wiki" class="back-link">← Pages</RouterLink>

      <p v-if="loading" class="state-note">Loading page…</p>
      <p v-else-if="error" class="state-note error">{{ error }}</p>

      <template v-else>
        <article v-if="!editing && page">
          <div class="title-row">
            <h1>{{ page.title }}</h1>
            <button type="button" class="edit-btn" data-testid="edit-page" @click="startEditing">
              Edit
            </button>
          </div>
          <p v-if="saveNote" class="save-note" :class="{ error: saveError }">{{ saveNote }}</p>
          <!-- Sanitized by renderWikiMarkdown (DOMPurify) — v-html is safe here. -->
          <div
            ref="contentEl"
            class="wiki-content"
            @click="onContentClick"
            v-html="renderedPage"
          ></div>
        </article>

        <div v-if="editing" class="editor">
          <p v-if="notFound" class="state-note">
            This page doesn't exist yet — write it and Save to create
            <strong>/wiki/{{ slug }}</strong>.
          </p>
          <PageEditor v-model="draft" :slug="slug" :saved="savedMarkdown" />

          <p v-if="conflict" class="conflict-notice" data-testid="conflict-notice">
            {{ conflict }}
            <span class="conflict-actions">
              <button type="button" class="cancel-btn" data-testid="conflict-reload" @click="reloadAfterConflict">
                Reload
              </button>
              <button type="button" class="cancel-btn" :disabled="saving" data-testid="conflict-overwrite" @click="save(true)">
                Save anyway
              </button>
            </span>
          </p>

          <div class="editor-actions">
            <button type="button" class="save-btn" :disabled="saving" data-testid="save-page" @click="save(false)">
              {{ saving ? 'Saving…' : notFound ? 'Create page' : 'Save' }}
            </button>
            <button type="button" class="cancel-btn" :disabled="saving" @click="cancelEditing">
              Cancel
            </button>
          </div>
          <p v-if="saveNote" class="save-note" :class="{ error: saveError }">{{ saveNote }}</p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wiki-page-view {
  flex-grow: 1;
  display: flex;
  justify-content: center;
  padding: 32px 20px 60px;
  background-color: var(--blo-cream);
}

.wiki-page-panel {
  width: 100%;
  max-width: 720px;
}

/* Side-by-side editing needs the room reading does not. */
.wiki-page-panel.editing {
  max-width: 1200px;
}

.back-link {
  display: inline-block;
  margin-bottom: 16px;
  font-size: 14px;
  color: var(--blo-stone);
  text-decoration: none;
}

.back-link:hover {
  text-decoration: underline;
}

.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.title-row h1 {
  margin: 0;
  font-family: var(--blo-font-display);
  font-size: 1.6rem;
  font-weight: 500;
  color: var(--blo-ink);
}

.edit-btn,
.cancel-btn {
  padding: 4px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: transparent;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.cancel-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.conflict-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--blo-ink);
  background: #fff8e1;
  border: 1px solid #e6d9a8;
  border-radius: 6px;
}

.conflict-actions {
  display: flex;
  gap: 6px;
}

.editor-actions {
  display: flex;
  gap: 8px;
}

.save-btn {
  padding: 6px 18px;
  font-size: 13px;
  font-weight: 600;
  color: #ffffff;
  background: var(--blo-ink);
  border: 1px solid var(--blo-ink);
  border-radius: 6px;
  cursor: pointer;
}

.save-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.save-note {
  margin: 0;
  font-size: 13px;
  color: #1b5e20;
}

.save-note.error {
  color: #b3261e;
}

.state-note {
  font-size: 14px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b3261e;
}

/* P5-60: the page header wraps, and every editor control gets a real target. */
@media (max-width: 640px) {
  .wiki-page-view {
    padding: 20px 12px 40px;
  }

  /* Editing widens this panel to 1200 px on a desktop, and `.wiki-page-view` is
     a flex item of <main> whose default `min-width: auto` is the min-content
     width of everything below it — including the editor's toolbar strip, which
     does not wrap. Without these the page grew to fit the strip instead of the
     strip scrolling inside the page. */
  .wiki-page-view,
  .wiki-page-panel,
  .wiki-page-panel.editing,
  .editor {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .title-row {
    flex-wrap: wrap;
    gap: 8px;
  }

  .title-row h1 {
    font-size: clamp(20px, 6.5vw, 1.6rem);
    overflow-wrap: anywhere;
  }

  .edit-btn,
  .cancel-btn,
  .save-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font-size: 14px;
  }

  .editor-actions {
    flex-wrap: wrap;
  }

  .editor-actions .save-btn,
  .editor-actions .cancel-btn {
    flex: 1 1 140px;
  }

  .conflict-actions .cancel-btn {
    flex: 1 1 120px;
  }

  .save-note,
  .state-note,
  .conflict-notice {
    font-size: 14px;
  }
}
</style>

<style>
/* Rendered markdown, deliberately UNSCOPED.
   Two components render page markdown into `.wiki-content`: the reading view
   here and the editor's live preview (PageEditor). Scoped styles stop at a
   child component's root, so scoping these would leave the preview unstyled —
   and the preview is only useful if it looks like the finished page. One
   definition, both places. */
.wiki-content {
  padding: 18px 20px;
  background: #ffffff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: var(--blo-radius-panel);
  font-size: 15px;
  line-height: 1.6;
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

.wiki-content h1 {
  margin: 0 0 12px;
  font-family: var(--blo-font-display);
  font-size: 1.4rem;
  font-weight: 500;
}

.wiki-content h2 {
  margin: 20px 0 8px;
  font-size: 1.15rem;
  font-weight: 600;
}

.wiki-content h3 {
  margin: 16px 0 6px;
  font-size: 1rem;
  font-weight: 600;
}

.wiki-content p {
  margin: 0 0 10px;
}

.wiki-content a {
  color: #0d47a1;
}

.wiki-content table {
  border-collapse: collapse;
  margin: 0 0 12px;
  font-size: 14px;
}

.wiki-content th,
.wiki-content td {
  padding: 6px 12px;
  border: 1px solid var(--blo-cream-divider);
  text-align: left;
}

.wiki-content th {
  background: rgba(17, 17, 17, 0.03);
}

.wiki-content pre {
  padding: 12px 14px;
  background: rgba(17, 17, 17, 0.04);
  border-radius: 6px;
  overflow-x: auto;
  font-size: 13px;
}

.wiki-content code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.92em;
}

.wiki-content blockquote {
  margin: 0 0 10px;
  padding: 4px 14px;
  border-left: 3px solid var(--blo-cream-divider);
  color: var(--blo-stone);
}

/* Embed cards (P5-17) — placeholder divs upgraded by hydrateEmbeds. */
.wiki-content [data-embed] {
  margin: 0 0 12px;
  padding: 12px 16px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  background: rgba(17, 17, 17, 0.02);
  font-size: 14px;
}

.wiki-content .wiki-embed-note {
  color: var(--blo-stone);
  font-style: italic;
}

.wiki-content [data-embed-state='error'] {
  color: #b3261e;
}

/* A map block (P7-4) brings its own chrome — the pane has a border and every
   stand-in is a card — so the placeholder's box gets out of its way. Same
   specificity as the rule above, after it on purpose. */
.wiki-content .wiki-embed-map {
  padding: 0;
  border: 0;
  background: none;
}

.wiki-content .embed-title {
  font-weight: 600;
  margin-bottom: 2px;
}

.wiki-content .embed-meta {
  font-size: 12.5px;
  color: var(--blo-stone);
  margin-bottom: 8px;
}

.wiki-content .embed-results {
  margin: 0 0 6px;
  padding-left: 22px;
}

.wiki-content .embed-results li {
  margin: 2px 0;
}

.wiki-content .embed-more {
  font-size: 12.5px;
  color: var(--blo-stone);
  margin-bottom: 6px;
}

.wiki-content .embed-link {
  display: inline-block;
  font-weight: 600;
  font-size: 13px;
}

/* Saved table views (P5-54): the head of the table, or its chart. */
.wiki-content .embed-table-scroll {
  overflow-x: auto;
  margin-bottom: 8px;
}

.wiki-content .embed-table {
  border-collapse: collapse;
  font-size: 12.5px;
  width: 100%;
}

.wiki-content .embed-table th,
.wiki-content .embed-table td {
  text-align: left;
  padding: 4px 10px 4px 0;
  border-bottom: 1px solid var(--blo-cream-divider);
  white-space: nowrap;
}

.wiki-content .embed-table th {
  color: var(--blo-stone);
  font-weight: 600;
}

.wiki-content .embed-chart {
  margin-bottom: 8px;
}

/* P5-60: rendered markdown on a phone. A wide table is the one thing that
   pushes the whole page sideways, and markdown gives us nowhere to hang a
   scroll wrapper — so the table itself becomes the scrolling box. Unscoped
   with the rest of this block: the editor's preview needs it too. */
@media (max-width: 640px) {
  .wiki-content {
    padding: 14px 14px;
    font-size: 15px;
  }

  .wiki-content table,
  .wiki-content .embed-table-scroll {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }

  .wiki-content pre {
    font-size: 14px;
  }

  .wiki-content .embed-meta,
  .wiki-content .embed-more,
  .wiki-content .embed-link {
    font-size: 14px;
  }
}
</style>
