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
import { computed } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
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
}>()

const emit = defineEmits<{
  shown: [payload: { geoIds: string[]; rows: number; total: number; loading: boolean }]
}>()

const route = useRoute()
const router = useRouter()

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
  font-size: 0.9rem;
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
  font-size: 0.95rem;
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
  font-size: 0.9rem;
  color: var(--blo-ink);
  overflow-wrap: anywhere;
}

.d-meta {
  font-size: 0.78rem;
  color: var(--blo-stone);
}

.d-missing .d-name {
  color: var(--blo-stone);
}

@media (max-width: 640px) {
  .d-row {
    flex-wrap: wrap;
  }
}
</style>
