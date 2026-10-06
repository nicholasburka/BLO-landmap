<script setup lang="ts">
/**
 * The conversations this person has had (P6-7b, spec E.15).
 *
 * A thread belongs to one person, so this list is never anybody else's. Two
 * destructive-ish things live here and both stay on the row: renaming turns
 * the title into a field, and archiving asks in place. Neither uses
 * `window.confirm` — a browser dialog blocks the page, cannot be styled, and
 * reads nothing like the rest of the app.
 *
 * On a phone the same list is one `<select>` above the conversation: a column
 * of threads beside a column of messages does not fit, and a drawer that
 * needs opening puts a door in front of the thing people came for.
 */
import { ref, nextTick } from 'vue'
import { relativeTime } from '@/lib/kb'
import { CHAT_TITLE_MAX, type Chat } from '@/lib/libraryChat'

const props = defineProps<{
  threads: Chat[]
  currentId: number | null
  loading?: boolean
  error?: string
  /** Phone width: one select instead of a column. */
  compact?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', chatId: number): void
  (e: 'create'): void
  (e: 'rename', payload: { chatId: number; title: string }): void
  (e: 'archive', chatId: number): void
}>()

const renamingId = ref<number | null>(null)
const draftTitle = ref('')
const confirmingId = ref<number | null>(null)
const titleBox = ref<HTMLInputElement | null>(null)

function startRename(thread: Chat): void {
  confirmingId.value = null
  renamingId.value = thread.id
  draftTitle.value = thread.title
  void nextTick(() => titleBox.value?.select())
}

function commitRename(): void {
  const chatId = renamingId.value
  const title = draftTitle.value.trim()
  renamingId.value = null
  if (chatId !== null && title) emit('rename', { chatId, title })
}

function cancelRename(): void {
  renamingId.value = null
}

function onSelect(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value)
  if (Number.isInteger(value) && value > 0) emit('select', value)
}
</script>

<template>
  <div class="threads" :class="{ compact }" data-testid="chat-threads">
    <div class="threads-head">
      <h2 v-if="!compact" class="threads-title">Conversations</h2>
      <button type="button" class="new-chat" data-testid="chat-new" @click="emit('create')">New chat</button>
    </div>

    <p v-if="error" class="threads-note bad" data-testid="chat-threads-error">{{ error }}</p>
    <p v-else-if="loading" class="threads-note" data-testid="chat-threads-loading">Loading conversations…</p>
    <p v-else-if="!threads.length" class="threads-note" data-testid="chat-threads-empty">
      No conversations yet. Start one and ask the library something.
    </p>

    <!-- Phone: one control, no column. -->
    <select
      v-else-if="compact"
      class="threads-select"
      aria-label="Conversations"
      data-testid="chat-threads-select"
      :value="currentId ?? ''"
      @change="onSelect"
    >
      <option v-for="thread in threads" :key="thread.id" :value="thread.id">{{ thread.title }}</option>
    </select>

    <ul v-else class="thread-list">
      <li v-for="thread in threads" :key="thread.id" class="thread" :class="{ current: thread.id === currentId }" data-testid="chat-thread">
        <template v-if="renamingId === thread.id">
          <input
            :ref="el => { titleBox = (el as HTMLInputElement | null) }"
            v-model="draftTitle"
            class="thread-rename"
            type="text"
            :maxlength="CHAT_TITLE_MAX"
            aria-label="Conversation name"
            data-testid="chat-rename-input"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
          />
          <div class="thread-row-actions">
            <button type="button" class="row-btn go" data-testid="chat-rename-save" @click="commitRename">Save</button>
            <button type="button" class="row-btn" data-testid="chat-rename-cancel" @click="cancelRename">Cancel</button>
          </div>
        </template>

        <template v-else-if="confirmingId === thread.id">
          <p class="thread-ask" data-testid="chat-archive-ask">Archive “{{ thread.title }}”?</p>
          <div class="thread-row-actions">
            <button type="button" class="row-btn danger" data-testid="chat-archive-confirm" @click="emit('archive', thread.id); confirmingId = null">
              Archive
            </button>
            <button type="button" class="row-btn" data-testid="chat-archive-cancel" @click="confirmingId = null">Keep</button>
          </div>
        </template>

        <template v-else>
          <button
            type="button"
            class="thread-open"
            :aria-current="thread.id === currentId ? 'true' : undefined"
            data-testid="chat-thread-open"
            @click="emit('select', thread.id)"
          >
            <span class="thread-title">{{ thread.title }}</span>
            <span class="thread-when">{{ relativeTime(thread.updatedAt) }}</span>
          </button>
          <div class="thread-row-actions quiet">
            <button type="button" class="row-btn" data-testid="chat-rename" @click="startRename(thread)">Rename</button>
            <button type="button" class="row-btn" data-testid="chat-archive" @click="confirmingId = thread.id">Archive</button>
          </div>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.threads {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 8px;
}

.threads-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.threads-title {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.new-chat {
  padding: 5px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border: 0;
  border-radius: 999px;
  cursor: pointer;
}

.threads-note {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--blo-stone, #6b6560);
}

.bad {
  color: #7f1d1d;
}

.threads-select {
  width: 100%;
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.thread-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.thread {
  padding: 6px 8px;
  border-radius: 8px;
}

.thread.current {
  background: #fff;
  box-shadow: inset 2px 0 0 var(--blo-green-deep, #1f7a2e);
}

.thread-open {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 0;
  font: inherit;
  text-align: left;
  background: none;
  border: 0;
  cursor: pointer;
}

.thread-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--blo-ink, #111);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-when {
  font-size: 12px;
  color: var(--blo-stone-soft, #9a948e);
}

.thread-ask {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--blo-ink, #111);
}

.thread-rename {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  font: inherit;
  font-size: 14px;
  border: 1px solid var(--blo-green-deep, #1f7a2e);
  border-radius: 6px;
}

.thread-row-actions {
  display: flex;
  gap: 10px;
  margin-top: 2px;
}

/* The row's own controls stay out of the way until the row is wanted. */
.thread-row-actions.quiet {
  opacity: 0;
}

.thread:hover .thread-row-actions.quiet,
.thread:focus-within .thread-row-actions.quiet {
  opacity: 1;
}

.row-btn {
  padding: 0;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: 0;
  cursor: pointer;
}

.row-btn:hover {
  color: var(--blo-ink, #111);
  text-decoration: underline;
}

.row-btn.go {
  color: var(--blo-green-deep, #1f7a2e);
}

.row-btn.danger {
  color: #b91c1c;
}

@media (max-width: 640px) {
  .threads-note,
  .thread-title,
  .thread-when,
  .row-btn {
    font-size: 14px;
  }

  .new-chat {
    min-height: 40px;
    font-size: 14px;
  }

  .threads-select {
    min-height: 44px;
    font-size: 16px;
  }

  /* No hover on a touch screen: the row's controls are simply there. */
  .thread-row-actions.quiet {
    opacity: 1;
  }
}
</style>
