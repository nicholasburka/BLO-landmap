<script setup lang="ts">
/**
 * What happened lately (P5-40). The operations home answers "what happened"
 * before "where is everything", so this panel fetches its own rows and owns
 * its own loading/empty/error states — the landing never waits on it.
 */
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { fetchActivity, ACTIVITY_PAGE, ACTIVITY_MORE, type ActivityRow } from '@/lib/kbConfig'
import { relativeTime, kindLabel } from '@/lib/kb'
import { friendlyError } from '@/lib/errors'

const rows = ref<ActivityRow[]>([])
const loading = ref(true)
const error = ref('')
const expanded = ref(false)

async function load(limit: number): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    rows.value = await fetchActivity(limit)
  } catch (err: unknown) {
    error.value = friendlyError(err, 'Recent activity did not load. Try again in a moment.')
  } finally {
    loading.value = false
  }
}

onMounted(() => void load(ACTIVITY_PAGE))

function showMore(): void {
  expanded.value = true
  void load(ACTIVITY_MORE)
}

// A full first page means there is probably more behind it; a short one is
// the whole history, so the button would only disappoint.
const canShowMore = computed(() => !expanded.value && !loading.value && !error.value && rows.value.length >= ACTIVITY_PAGE)
</script>

<template>
  <section class="activity" data-testid="activity">
    <h2>What happened</h2>

    <ul v-if="loading && !rows.length" class="skeleton" data-testid="activity-skeleton" aria-hidden="true">
      <li v-for="n in 4" :key="n"><span class="bar" /></li>
    </ul>

    <p v-else-if="error" class="state-note error">{{ error }}</p>

    <ul v-else-if="rows.length" class="activity-list">
      <li v-for="(row, i) in rows" :key="`${row.at}:${i}`" class="activity-row" data-testid="activity-row">
        <span class="line">
          <span class="actor">{{ row.actor }}</span>
          {{ row.verb }}
          <RouterLink v-if="row.target" :to="row.target.href" class="target">{{ row.target.title }}</RouterLink>
          <span v-if="row.target" class="kind">{{ kindLabel(row.target.kind) }}</span>
        </span>
        <time class="when" :datetime="row.at">{{ relativeTime(row.at) }}</time>
      </li>
    </ul>

    <p v-else class="state-note">Nothing yet. Uploads, link drops, filings, page edits, saved views, and pushes show up here.</p>

    <button v-if="canShowMore" type="button" class="more" data-testid="activity-more" @click="showMore">Show more</button>
  </section>
</template>

<style scoped>
.activity h2 {
  font-size: 16px;
  margin: 0 0 8px;
}

.activity-list,
.skeleton {
  list-style: none;
  margin: 0;
  padding: 0;
}

.activity-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--blo-cream-deep, #efe8da);
  font-size: 13px;
}

.actor {
  font-weight: 700;
  color: var(--blo-ink);
}

.target {
  color: var(--blo-ink);
  font-weight: 600;
  text-decoration: none;
}

.target:hover {
  color: var(--blo-green-deep);
}

.kind {
  font-size: 11px;
  color: var(--blo-stone);
  border: 1px solid var(--blo-cream-divider);
  border-radius: 4px;
  padding: 0 5px;
  margin-left: 4px;
  white-space: nowrap;
}

.when {
  font-size: 12px;
  color: var(--blo-stone);
  white-space: nowrap;
}

.skeleton li {
  padding: 7px 0;
}

.bar {
  display: block;
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--blo-cream-deep, #efe8da), #fff, var(--blo-cream-deep, #efe8da));
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

.skeleton li:nth-child(2n) .bar {
  width: 78%;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bar {
    animation: none;
  }
}

.more {
  margin-top: 10px;
  padding: 6px 12px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-ink);
  background: #fff;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 6px;
  cursor: pointer;
}

.state-note {
  font-size: 13px;
  color: var(--blo-stone);
}

.state-note.error {
  color: #b71c1c;
}

/* P5-60: the line and its timestamp fought for one row at 375 px; stacked,
   both are readable and nothing is cut off. */
@media (max-width: 640px) {
  .activity-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    font-size: 14px;
    min-width: 0;
  }

  /* Page and dataset titles are content: they wrap, they do not widen. */
  .line {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .kind {
    font-size: 13px;
  }

  .when,
  .state-note {
    font-size: 14px;
  }

  .more {
    min-height: 44px;
    font-size: 14px;
  }
}
</style>
