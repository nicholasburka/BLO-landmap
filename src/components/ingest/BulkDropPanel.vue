<script setup lang="ts">
/**
 * Many documents (P6-8, panel three).
 *
 * See what the pass will cost, press Start. Every file lands at once with its
 * filename as its title; the model reads them three at a time and proposes the
 * rest. The list below is the review queue, and **nothing is filed until
 * somebody presses Accept.**
 *
 * P6-29 took the drop zone and the two pickers away. There is now ONE zone on
 * `/new`, which counts the files and routes them — one to the single form, more
 * than one to here — so a second zone would be a second way to be refused by
 * the wrong rule. `take(files)` was already the single entry point behind this
 * component's own pick and drop handlers; it is now exposed and is the only way
 * in. Everything below the zone — the pre-flight, the queue, the rows — is as
 * it was.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import BulkDropRow from './BulkDropRow.vue'
import { friendlyError } from '@/lib/errors'
import { formatBytes } from '@/lib/libraryCatalog'
import {
  acceptFiling,
  annotateAgain,
  checkBulkFiles,
  estimateCents,
  fetchBulkStatus,
  filingFrom,
  folderNameOf,
  formatCents,
  hasProposal,
  startBulkDrop,
  type AcceptedFiling,
  type BulkDropStatus,
  type BulkRow,
} from '@/lib/bulkDrop'

const props = withDefaults(defineProps<{ isAdmin?: boolean }>(), { isAdmin: false })
const emit = defineEmits<{ (event: 'changed'): void }>()

/** How often the page asks how the queue is getting on. */
const POLL_MS = 1500

const chosen = ref<File[]>([])
const collection = ref(false)
const collectionTitle = ref('')
const starting = ref(false)
const busySlug = ref('')
const accepted = ref<string[]>([])
const status = ref<BulkDropStatus | null>(null)
const message = ref('')
const failed = ref(false)

let timer: ReturnType<typeof setTimeout> | null = null

/** What the page reads back to decide which limit to quote and which words to
 *  put under the zone — so it cannot go stale when `clear()` empties this. */
const count = computed(() => chosen.value.length)
const totalBytes = computed(() => chosen.value.reduce((sum, f) => sum + f.size, 0))
const estimate = computed(() => formatCents(estimateCents(chosen.value.length)))
const refusal = computed(() => (chosen.value.length ? checkBulkFiles(chosen.value) : null))
const rows = computed<BulkRow[]>(() => status.value?.rows ?? [])
const spent = computed(() => formatCents(status.value?.spentCents ?? 0))
const acceptable = computed(() => rows.value.filter(row => hasProposal(row) && !accepted.value.includes(row.slug)))

function say(text: string, isError = false): void {
  message.value = text
  failed.value = isError
}

function take(list: FileList | null | undefined): void {
  const files = [...(list ?? [])]
  if (!files.length) return
  chosen.value = files
  const folder = folderNameOf(files)
  if (folder) {
    collection.value = true
    collectionTitle.value = folder
  }
  say('')
}

function clear(): void {
  chosen.value = []
  collection.value = false
  collectionTitle.value = ''
}

async function start(): Promise<void> {
  if (starting.value || !chosen.value.length) return
  const bad = refusal.value
  if (bad) {
    say(bad, true)
    return
  }
  starting.value = true
  say('')
  try {
    status.value = await startBulkDrop(chosen.value, {
      collection: collection.value,
      collectionTitle: collectionTitle.value,
    })
    accepted.value = []
    clear()
    emit('changed')
    schedulePoll()
  } catch (err: unknown) {
    say(friendlyError(err, 'The drop did not land. Try again.'), true)
  } finally {
    starting.value = false
  }
}

/** Poll while anything is queued or being read, and stop the moment it is
 *  not — a finished drop must not keep asking. */
function schedulePoll(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!status.value?.running) return
  timer = setTimeout(poll, POLL_MS)
}

async function poll(): Promise<void> {
  const dropId = status.value?.dropId
  if (!dropId) return
  try {
    status.value = await fetchBulkStatus(dropId)
  } catch {
    // A poll that fails is not worth a banner: the next one may work, and the
    // files are already in. Stop asking rather than spin.
    return
  }
  schedulePoll()
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

async function applyFiling(slug: string, filing: AcceptedFiling): Promise<void> {
  busySlug.value = slug
  try {
    await acceptFiling(slug, filing)
    if (!accepted.value.includes(slug)) accepted.value = [...accepted.value, slug]
    const row = rows.value.find(r => r.slug === slug)
    if (row && filing.title.trim()) row.title = filing.title.trim()
    emit('changed')
  } catch (err: unknown) {
    say(friendlyError(err, 'That could not be filed. Try again.'), true)
  } finally {
    busySlug.value = ''
  }
}

function acceptRow(slug: string): void {
  const row = rows.value.find(r => r.slug === slug)
  if (!row) return
  const filing = filingFrom(row.suggested)
  if (!filing.title) filing.title = row.title
  void applyFiling(slug, filing)
}

function saveRow(payload: { slug: string; filing: AcceptedFiling }): void {
  void applyFiling(payload.slug, payload.filing)
}

async function acceptAll(): Promise<void> {
  say('')
  // One at a time, on purpose: each is an ordinary filing call with its own
  // audit row, and a half-finished batch must leave the rest reviewable.
  for (const row of [...acceptable.value]) await applyFiling(row.slug, filingFrom(row.suggested))
}

async function lookAgain(slug: string): Promise<void> {
  busySlug.value = slug
  try {
    await annotateAgain(slug)
    const row = rows.value.find(r => r.slug === slug)
    if (row) {
      row.state = 'queued'
      row.reason = undefined
    }
    if (status.value) status.value = { ...status.value, running: true }
    schedulePoll()
  } catch (err: unknown) {
    say(friendlyError(err, 'The pass could not be started. Try again.'), true)
  } finally {
    busySlug.value = ''
  }
}

defineExpose({ take, clear, count })
</script>

<template>
  <!-- Nothing picked, nothing said and nothing landed: draw nothing at all, so
       the page above is the zone and only the zone. -->
  <div v-if="chosen.length || message || status" class="bulk">
    <div v-if="chosen.length" class="chosen" data-testid="bulk-chosen">
      <p class="count">
        {{ chosen.length }} {{ chosen.length === 1 ? 'file' : 'files' }} · {{ formatBytes(totalBytes) }}
      </p>
      <p class="estimate" data-testid="bulk-estimate">
        Reading them will cost {{ estimate }} — about a cent a file.
      </p>
      <label class="check">
        <input v-model="collection" type="checkbox" data-testid="keep-as-collection" />
        Keep as one collection — one entry holding every file
      </label>
      <input
        v-if="collection"
        v-model="collectionTitle"
        type="text"
        class="title-input"
        aria-label="Collection title"
        placeholder="What to call the collection"
      />
      <p v-if="refusal" class="note error" data-testid="bulk-refusal">{{ refusal }}</p>
      <div class="actions">
        <button type="button" class="primary" :disabled="starting || !!refusal" data-testid="bulk-start" @click="start">
          {{ starting ? 'Dropping…' : 'Start' }}
        </button>
        <button type="button" class="plain" :disabled="starting" @click="clear">Cancel</button>
      </div>
    </div>

    <p v-if="message" class="note" :class="{ error: failed }" data-testid="bulk-note">{{ message }}</p>

    <section v-if="status" class="progress" data-testid="bulk-progress">
      <header class="progress-head">
        <p class="running-total" data-testid="bulk-total">
          {{ status.running ? 'Reading…' : 'Done.' }}
          {{ status.counts.suggested }} of {{ status.rows.length }} suggested · spent {{ spent }}
        </p>
        <button
          v-if="acceptable.length"
          type="button"
          class="primary"
          :disabled="!!busySlug"
          data-testid="accept-all"
          @click="acceptAll"
        >
          Accept all ({{ acceptable.length }})
        </button>
      </header>
      <ul class="rows">
        <BulkDropRow
          v-for="row in rows"
          :key="row.slug"
          :row="row"
          :busy="busySlug === row.slug"
          :accepted="accepted.includes(row.slug)"
          :is-admin="props.isAdmin"
          @accept="acceptRow"
          @save="saveRow"
          @look-again="lookAgain"
        />
      </ul>
    </section>
  </div>
</template>

<style scoped>
.bulk {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chosen {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--blo-cream-divider, #e8e1d4);
  border-radius: 8px;
  padding: 12px;
  background: #fff;
}

.count {
  margin: 0;
  font-weight: 600;
}

.estimate {
  margin: 0;
  font-size: 0.88rem;
  color: #5c5348;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 0.9rem;
}

.title-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
  font: inherit;
  box-sizing: border-box;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.primary {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background: var(--blo-green, #2f5d3a);
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.plain {
  padding: 8px 14px;
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

.progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.progress-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.running-total {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  .actions button,
  .progress-head .primary {
    width: 100%;
  }
}
</style>
