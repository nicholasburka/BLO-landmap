<script setup lang="ts">
/**
 * `/new` — the one page that takes something in (P6-8, reshaped by P6-29).
 *
 * Two questions used to stand between a person and a drop: link / document /
 * folder, and then which of two drop zones. Only the first half of the first
 * one is a real question — whether the thing in your hand is a URL or a file is
 * something only you know. **How many files there are is something the browser
 * can count**, so it does, and the page stops asking.
 *
 * So: a two-way chooser, and on the File side ONE zone that routes by
 * `files.length` — one file to the form you fill in yourself, more than one to
 * the pass that fills them in for you to accept. Both children already had
 * `take(files)` as the single entry point behind their own pick and drop
 * handlers, so this is a handoff rather than a merge; neither draws a zone of
 * its own any more, because there is one, here.
 *
 * There is no `<h1>` and no lede. You arrived by pressing `New`; a page does
 * not need to repeat the button you just pressed. The lede's one load-bearing
 * sentence — how the single and the many differ — moved into the zone, where
 * the decision is actually made.
 */
import { computed, ref } from 'vue'
import KbNav from '@/components/KbNav.vue'
import BulkDropPanel from '@/components/ingest/BulkDropPanel.vue'
import DocumentDropForm from '@/components/ingest/DocumentDropForm.vue'
import LinkDropForm from '@/components/ingest/LinkDropForm.vue'
import { useAuth } from '@/composables/useAuth'
import { BULK_MAX_FILES, BULK_MAX_FILE_BYTES } from '@/lib/bulkDrop'
import { completeFirstRunStep } from '@/lib/firstRun'
import { UPLOAD_MAX_BYTES, formatBytes } from '@/lib/libraryCatalog'

const { internalUser } = useAuth()
const isAdmin = ref(false)
isAdmin.value = internalUser.value?.role === 'admin'

/**
 * Link or File — and nothing else. Component state, not a URL key: `/new` is
 * linked bare from the library strip, the header and the first-run checklist,
 * and the page holds nothing else worth sharing, so `?kind=` would be a query
 * only this page ever writes. A `router.replace` per toggle is not free
 * (history churn on a write surface, an invalid value to defend against, a
 * router dependency this view does not otherwise have), so by P6-18's rule —
 * the URL only when it costs nothing — it stays a ref.
 */
type Kind = 'link' | 'file'
const kind = ref<Kind>('link')

const single = ref<InstanceType<typeof DocumentDropForm> | null>(null)
const many = ref<InstanceType<typeof BulkDropPanel> | null>(null)
const filesInput = ref<HTMLInputElement | null>(null)
const folderInput = ref<HTMLInputElement | null>(null)
const dragOver = ref(false)

/** Read back off the children instead of mirrored here, so the two lines under
 *  the zone cannot go stale when a child's own Cancel empties it. */
const singleCount = computed(() => single.value?.count ?? 0)
const manyCount = computed(() => many.value?.count ?? 0)

/** What will happen to what has been picked — the old lede, specialised. */
const nextNote = computed(() => {
  if (singleCount.value) {
    return 'One file — you describe it. The server reads it afterwards and proposes a filing on the entry; it applies none of it.'
  }
  if (manyCount.value) {
    return `${manyCount.value} files — each lands straight away under its filename, and the assistant proposes a title, a summary, a publisher, a topic and tags for you to accept or edit.`
  }
  return 'Drop one thing and you describe it. Drop many and the assistant describes each one for you — greyed, on a row, until you accept it.'
})

/**
 * The size limit for the action in hand, and only that one.
 *
 * The two limits are different and both real — 200 MB for one file
 * (`UPLOAD_MAX_BYTES`), 100 MB per file in a pass (`BULK_MAX_FILE_BYTES`) — and
 * the three-card page quoted both of them eight lines apart (UX audit,
 * 2026-10-03). With one zone that is visible nonsense, so the line follows the
 * pick: no byte figure before one, because neither limit applies yet. Derived
 * from the constants the validators use, so the page cannot drift from them.
 */
const limitNote = computed(() => {
  if (singleCount.value) return `One file, up to ${formatBytes(UPLOAD_MAX_BYTES)}.`
  if (manyCount.value) return `Up to ${formatBytes(BULK_MAX_FILE_BYTES)} each, ${BULK_MAX_FILES} at a time.`
  return `Any file type, up to ${BULK_MAX_FILES} at a time. The size limit depends on how many you drop.`
})

/**
 * The whole of the single-vs-many decision, in one place: the count routes it,
 * and the child that did not get the files is emptied so the single form and
 * the pre-flight can never both stand for the same pick.
 */
function route(files: FileList | null | undefined): void {
  const count = files?.length ?? 0
  if (!count) return
  if (count === 1) {
    many.value?.clear()
    single.value?.take(files ?? null)
  } else {
    single.value?.clear()
    many.value?.take(files)
  }
}

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  route(input.files)
  // Let the same file be picked twice running.
  input.value = ''
}

function onDrop(event: DragEvent): void {
  dragOver.value = false
  route(event.dataTransfer?.files)
}

/** Anything landing is the checklist's "add something" step, whichever path it
 *  came from. `/new` is the only proof of `add` there is — `matchFirstRunStep`
 *  proves `search`, `map` and `ask` from a URL and this one from nowhere — so
 *  all three emits report it. */
function added(): void {
  completeFirstRunStep('add')
}
</script>

<template>
  <div class="new-view">
    <div class="panel">
      <KbNav />

      <div class="chooser" role="tablist" aria-label="What are you adding?" data-testid="new-chooser">
        <button
          type="button"
          role="tab"
          class="chooser-btn touch-target"
          :class="{ active: kind === 'link' }"
          :aria-selected="kind === 'link'"
          data-testid="choose-link"
          @click="kind = 'link'"
        >
          Link
        </button>
        <button
          type="button"
          role="tab"
          class="chooser-btn touch-target"
          :class="{ active: kind === 'file' }"
          :aria-selected="kind === 'file'"
          data-testid="choose-file"
          @click="kind = 'file'"
        >
          File
        </button>
      </div>

      <section v-if="kind === 'link'" class="pane" role="tabpanel" aria-label="A link" data-testid="pane-link">
        <p class="what">A page, a portal or a dataset we cannot export yet. We read it in the background.</p>
        <LinkDropForm @dropped="added" />
      </section>

      <section v-else class="pane" role="tabpanel" aria-label="A file" data-testid="pane-file">
        <div
          class="zone"
          :class="{ over: dragOver }"
          data-testid="new-drop-zone"
          @dragover.prevent="dragOver = true"
          @dragleave="dragOver = false"
          @drop.prevent="onDrop"
        >
          <p class="zone-lead">
            Drag files here, or
            <button type="button" class="link-btn" data-testid="pick-files" @click="filesInput?.click()">browse</button>
            ·
            <button type="button" class="link-btn" data-testid="pick-folder" @click="folderInput?.click()">
              a whole folder
            </button>
          </p>
          <p class="zone-next" data-testid="new-hint">{{ nextNote }}</p>
          <p class="zone-limit" data-testid="new-limit">{{ limitNote }}</p>
          <input
            ref="filesInput"
            type="file"
            multiple
            class="file-input"
            data-testid="new-file-input"
            aria-label="Choose files to upload"
            @change="onPick"
          />
          <!-- A second picker, not a second decision: an OS folder picker is the
               only thing that sets `webkitRelativePath`, which is what names a
               collection. The count still decides what happens. -->
          <input
            ref="folderInput"
            type="file"
            multiple
            webkitdirectory
            class="file-input"
            data-testid="new-folder-input"
            aria-label="Choose a folder to upload"
            @change="onPick"
          />
        </div>

        <!-- Both are mounted whenever this pane is, so the zone always has
             somewhere to hand files to. Each draws nothing until it holds
             something, so only the one the files went to is on screen. -->
        <DocumentDropForm ref="single" @uploaded="added" />
        <BulkDropPanel ref="many" :is-admin="isAdmin" @changed="added" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.new-view {
  padding: 16px;
}

.panel {
  max-width: 820px;
  margin: 0 auto;
}

/* --- The chooser ---------------------------------------------------------
   One pill, two halves, one click between them. */
.chooser {
  display: flex;
  gap: 4px;
  width: max-content;
  max-width: 100%;
  margin: 16px 0;
  padding: 3px;
  border: 1px solid var(--blo-cream-divider, #e8e1d4);
  border-radius: 999px;
  background: #fffdf8;
}

.chooser-btn {
  padding: 8px 24px;
  border: none;
  border-radius: 999px;
  background: none;
  font: inherit;
  font-weight: 600;
  color: #5c5348;
  cursor: pointer;
}

.chooser-btn:hover {
  color: var(--blo-green, #2f5d3a);
}

.chooser-btn.active {
  background: var(--blo-green, #2f5d3a);
  color: #fff;
}

.chooser-btn:focus-visible {
  outline: 2px solid var(--blo-green, #2f5d3a);
  outline-offset: 2px;
}

/* No `gap` on the pane: both file children are mounted, and an empty one that
   draws nothing must also cost nothing. The zone carries the spacing instead. */
.what {
  margin: 0 0 12px;
  font-size: 0.9rem;
  color: #5c5348;
  max-width: 62ch;
}

/* --- The one drop zone --------------------------------------------------- */
.zone {
  border: 1px dashed var(--blo-cream-divider, #d8cfbd);
  border-radius: 10px;
  padding: 22px 18px;
  margin-bottom: 14px;
  text-align: center;
  background: #fffdf8;
}

.zone.over {
  border-color: var(--blo-green, #2f5d3a);
  background: #f3f7f1;
}

.zone-lead,
.zone-next,
.zone-limit {
  margin: 0 auto;
  max-width: 62ch;
}

.zone-lead {
  font-size: 0.95rem;
}

.zone-next {
  margin-top: 8px;
  font-size: 0.88rem;
  color: #5c5348;
}

.zone-limit {
  margin-top: 4px;
  font-size: 0.82rem;
  color: #7a7063;
}

.file-input {
  display: none;
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--blo-green, #2f5d3a);
  text-decoration: underline;
  cursor: pointer;
}

/* P5-60: the chooser becomes two full-width 44 px targets, and nothing in the
   zone is below the 14 px floor. */
@media (max-width: 640px) {
  .new-view {
    padding: 10px;
  }

  .chooser {
    width: 100%;
  }

  .chooser-btn {
    flex: 1 1 0;
    min-width: 0;
    padding: 10px 12px;
    font-size: 1rem;
  }

  .zone {
    padding: 16px 12px;
  }

  .zone-lead {
    font-size: 1rem;
  }

  .zone-next {
    font-size: 0.95rem;
  }

  .zone-limit {
    font-size: 0.875rem;
  }
}
</style>
