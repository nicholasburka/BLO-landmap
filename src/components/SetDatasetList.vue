<template>
  <section class="set-datasets" data-testid="set-datasets">
    <!-- One open dataset, in place. The list stays behind it in history, so
         Back closes this rather than leaving the set (P11-6). -->
    <template v-if="open">
      <p class="open-head">
        <button type="button" class="blo-act" data-testid="dataset-close" @click="close">
          ← {{ setName }}
        </button>
        <span class="open-name" data-testid="dataset-open-name">{{ openTitle }}</span>
      </p>
      <DatasetView embedded host-map :slug="open" :extra-columns="extraColumns" @shown="emit('shown', $event)" />
    </template>

    <template v-else>
      <p v-if="!members.length && !missing.length" class="state-note" data-testid="datasets-empty">
        Nothing in this set yet. Add the datasets and sources that bear on it, and they will be here.
      </p>

      <ul v-else class="d-list">
        <li v-for="member in members" :key="member.slug" class="d-row" data-testid="dataset-row">
          <span class="d-main">
            <span class="d-name">{{ member.title }}</span>
            <span class="d-meta">
              {{ member.kind === 'dataset' ? 'held' : 'indexed, not held' }}
              <template v-if="member.status && member.status !== 'published'"> · {{ member.status }}</template>
            </span>
          </span>
          <span class="d-acts">
            <button
              v-if="member.kind === 'dataset'"
              type="button"
              class="blo-act"
              :data-testid="`dataset-open-${member.slug}`"
              @click="openOne(member.slug)"
            >
              Open
            </button>
            <!-- A source we point at but do not hold has no rows to open. Say
                 what it is instead of offering a button that cannot work. -->
            <RouterLink v-else :to="`/library/${member.slug}`" class="blo-act" data-testid="dataset-source">
              Where it lives
            </RouterLink>
            <!-- P14-6: takes it out of the SET. Nothing leaves the library,
                 which is why this is quiet and not a destructive red. -->
            <button
              type="button"
              class="blo-act"
              :disabled="!!saving"
              :data-testid="`dataset-remove-${member.slug}`"
              @click="removeOne(member.slug)"
            >{{ saving === member.slug ? 'Removing…' : 'Remove' }}</button>
          </span>
        </li>

        <!-- P6-23's rule: a set that names something the library lost says so,
             rather than quietly being a shorter set. -->
        <li v-for="slug in missing" :key="slug" class="d-row d-missing" data-testid="dataset-missing">
          <span class="d-main">
            <span class="d-name">{{ slug }}</span>
            <span class="d-meta">named by this set, not in the library any more</span>
          </span>
        </li>
      </ul>

      <!-- P14-6: the control the product never had. `updateWorkingSet` has
           been written since phase 5 with no caller anywhere. -->
      <p class="add-row">
        <button type="button" class="blo-act" :aria-expanded="adding" data-testid="dataset-add-open" @click="openAdd">
          {{ adding ? 'Never mind' : 'Add a dataset…' }}
        </button>
      </p>

      <p v-if="adding" class="add-panel" data-testid="dataset-add-panel">
        <span v-if="choicesLoading" class="blo-type-meta">Reading the library…</span>
        <template v-else>
          <select v-model="pick" class="blo-select" aria-label="A dataset to add" data-testid="dataset-add-pick">
            <option value="">Choose a dataset…</option>
            <option v-for="entry in available" :key="entry.slug" :value="entry.slug">{{ entry.title }}</option>
          </select>
          <button
            type="button"
            class="blo-act blo-act--write"
            :disabled="!pick || !!saving"
            data-testid="dataset-add"
            @click="addPicked"
          >{{ saving ? 'Adding…' : 'Add it' }}</button>
          <span v-if="!available.length" class="blo-type-meta">This set already holds every dataset the library has.</span>
        </template>
      </p>

      <p v-if="changeError" class="state-note error" data-testid="dataset-change-error">{{ changeError }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
/**
 * What a working set is made of (P11-6).
 *
 * This lived on another page — `/datasets?workingSet=<slug>` — so seeing what
 * was in a set meant leaving the set. That is the navigability complaint in
 * one sentence, and it is why this is a tab.
 *
 * Opening one renders the explorer in place and puts `&open=<slug>` on the
 * URL, so Back closes the dataset and returns to the list instead of leaving
 * the workspace. The standalone page stays and keeps working: it is what the
 * set's progress line counts, and the two must not disagree.
 */
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { updateWorkingSet } from '@/lib/workingSets'
import { fetchCatalog, type CatalogEntry } from '@/lib/libraryCatalog'
import { friendlyError } from '@/lib/errors'
import DatasetView from '@/views/DatasetView.vue'
import type { WorkingSetMember } from '@/lib/workingSets'
import type { JoinedColumn } from '@/lib/countyJoin'
import { SET_OPEN_KEY } from '@/lib/views'

const props = defineProps<{
  members: WorkingSetMember[]
  missing: string[]
  /** For the back control: "← Memphis redevelopment" says where it goes. */
  setName: string
  /** The set's derived columns, joined onto whatever table is opened. */
  extraColumns?: JoinedColumn[]
  /** The set's slug, for the two controls that change what it holds (P14-6). */
  slug: string
}>()

const emit = defineEmits<{
  shown: [payload: { geoIds: string[]; rows: number; total: number; loading: boolean }]
  /** The membership changed — the host refetches rather than guessing. */
  changed: []
}>()

const route = useRoute()
const router = useRouter()

// --- P14-6: changing what the set holds ------------------------------------
//
// `updateWorkingSet` has existed since phase 5 with NO caller in any view, so
// adding a dataset to a set was impossible from the product — not merely
// from a conversation. The endpoint replaces the list, so both controls send
// the whole membership rather than a delta.

const adding = ref(false)
const choices = ref<CatalogEntry[]>([])
const choicesLoading = ref(false)
const pick = ref('')
const saving = ref('')
const changeError = ref('')

/** Everything dataset-shaped the library holds that this set does not. */
const available = computed(() => {
  const held = new Set(props.members.map(m => m.slug))
  return choices.value.filter(entry => !held.has(entry.slug))
})

async function openAdd(): Promise<void> {
  adding.value = !adding.value
  if (!adding.value || choices.value.length || choicesLoading.value) return
  choicesLoading.value = true
  changeError.value = ''
  try {
    choices.value = await fetchCatalog({ kind: 'dataset' })
  } catch (err) {
    changeError.value = friendlyError(err, 'The library could not be read.')
  } finally {
    choicesLoading.value = false
  }
}

async function replaceMembers(datasets: string[], busy: string): Promise<void> {
  if (saving.value) return
  saving.value = busy
  changeError.value = ''
  try {
    await updateWorkingSet(props.slug, { datasets })
    emit('changed')
  } catch (err) {
    changeError.value = friendlyError(err, 'That change could not be saved.')
  } finally {
    saving.value = ''
  }
}

function held(): string[] {
  return props.members.map(m => m.slug)
}

async function addPicked(): Promise<void> {
  const slug = pick.value
  if (!slug) return
  await replaceMembers([...held(), slug], slug)
  pick.value = ''
  adding.value = false
}

async function removeOne(slug: string): Promise<void> {
  await replaceMembers(held().filter(s => s !== slug), slug)
}

/** Only a slug this set actually holds. A hand-edited `&open=` naming
 *  something else opens the list, not someone else's table. */
const open = computed(() => {
  const raw = route.query[SET_OPEN_KEY]
  const slug = Array.isArray(raw) ? raw[0] : raw
  if (typeof slug !== 'string' || !slug) return ''
  return props.members.some(m => m.slug === slug && m.kind === 'dataset') ? slug : ''
})

const openTitle = computed(() => props.members.find(m => m.slug === open.value)?.title ?? open.value)

function openOne(slug: string): void {
  void router.push({ query: { ...route.query, [SET_OPEN_KEY]: slug } })
}

function close(): void {
  const query = { ...route.query } as Record<string, unknown>
  delete query[SET_OPEN_KEY]
  void router.push({ query: query as Record<string, string> })
}
</script>

<style scoped>
.set-datasets {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  min-width: 0;
}

.state-note {
  margin: 0;
  font-size: var(--blo-text-body);
  color: var(--blo-stone);
}

.open-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  flex-wrap: wrap;
}

.open-name {
  font-size: var(--blo-text-body);
  font-weight: 600;
  color: var(--blo-ink);
}

.d-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
}

.d-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--blo-cream-divider);
}

.d-row:last-child {
  border-bottom: none;
}

.d-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.d-name {
  font-size: var(--blo-text-body);
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

.d-meta {
  font-size: var(--blo-text-meta);
  color: var(--blo-stone);
}

.d-missing .d-name {
  color: var(--blo-stone);
}

.d-acts {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.add-row,
.add-panel {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0;
}

.add-panel select {
  flex: 1 1 20rem;
  min-width: 0;
}

.state-note.error {
  color: var(--blo-orange-deep);
}

@media (max-width: 640px) {
  .d-row {
    flex-wrap: wrap;
  }
}
</style>
