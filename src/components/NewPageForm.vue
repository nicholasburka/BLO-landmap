<script setup lang="ts">
/**
 * Start a page (P5-15, moved here by P6-5).
 *
 * This was the one thing the pages index did that nothing else does: turn a
 * title into a slug and open the page at it. `/new` adds links and files, not
 * pages, so when the pages index became `/docs?kind=wiki` this form came with
 * it rather than being lost.
 *
 * It only routes. `/wiki/:slug` handles the does-not-exist-yet → create flow,
 * so there is exactly one editor code path, as there always was.
 *
 * `?new=1` focuses the box on arrival — the query the landing's old "New page"
 * link carried, and the one `/wiki?new=1` still redirects with.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { slugifyWikiTitle } from '@/lib/wiki'

const route = useRoute()
const router = useRouter()

const input = ref<HTMLInputElement | null>(null)
const title = ref('')
const error = ref('')

const slug = computed(() => slugifyWikiTitle(title.value))

function focusNew(): void {
  if (route.query.new === '1') input.value?.focus()
}
onMounted(focusNew)
watch(() => route.query.new, focusNew)

function createPage(): void {
  error.value = ''
  if (!slug.value) {
    error.value = 'That title has no letters or numbers to make a page name from.'
    return
  }
  void router.push({ path: `/wiki/${slug.value}`, query: { title: title.value.trim() } })
}
</script>

<template>
  <div class="new-page" data-testid="new-page">
    <form class="new-page-form" @submit.prevent="createPage">
      <input
        ref="input"
        v-model="title"
        type="text"
        placeholder="New page title…"
        aria-label="New page title"
        data-testid="new-page-title"
        required
      />
      <button type="submit" class="create-btn" data-testid="new-page-submit">New page</button>
    </form>
    <p v-if="title.trim() && slug" class="slug-preview" data-testid="new-page-slug">→ /wiki/{{ slug }}</p>
    <p v-if="error" class="state-note error" data-testid="new-page-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.new-page {
  margin-bottom: 14px;
}

.new-page-form {
  display: flex;
  gap: 8px;
}

.new-page-form input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  font-size: 14px;
  color: var(--blo-ink, #111);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 6px;
}

.create-btn {
  flex: 0 0 auto;
  padding: 7px 14px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: var(--blo-green-deep, #1f7a2e);
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}

.slug-preview {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  overflow-wrap: anywhere;
}

.state-note {
  margin: 6px 0 0;
  font-size: 14px;
  color: var(--blo-stone, #6b6560);
}

.state-note.error {
  color: #b3261e;
}

/* P5-60: a real tap target, and 16 px in the field — the size below which iOS
   Safari zooms the page on focus. */
@media (max-width: 640px) {
  .new-page-form input {
    min-height: 44px;
    font-size: 16px;
  }

  .create-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font-size: 14px;
  }

  .slug-preview {
    font-size: 14px;
  }
}
</style>
