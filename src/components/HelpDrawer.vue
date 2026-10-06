<script setup lang="ts">
/**
 * "How do I…" drawer (P5-43). The manual, one keystroke away from wherever
 * the person is stuck — because a new researcher does not stop work to go
 * and read documentation, they just stop.
 *
 * Opened from the Help button next to Search, from `?` on the keyboard, and
 * from the link at the bottom of the knowledge-base landing (which is why the
 * open flag lives in `lib/helpRecipes.ts` rather than in this component).
 * Esc closes it, focus stays inside it while it is open.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import {
  HELP_RECIPES,
  searchRecipes,
  groupRecipes,
  helpDrawerOpen,
  openHelpDrawer,
  closeHelpDrawer,
} from '@/lib/helpRecipes'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/scrollLock'

const query = ref('')
const expandedId = ref<string | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)
const triggerEl = ref<HTMLButtonElement | null>(null)

const matches = computed(() => searchRecipes(query.value, HELP_RECIPES))
const groups = computed(() => groupRecipes(matches.value))

function toggleRecipe(id: string): void {
  // One open at a time: the drawer is for finding an answer, not for
  // comparing five of them.
  expandedId.value = expandedId.value === id ? null : id
}

function open(): void {
  openHelpDrawer()
}

function close(): void {
  closeHelpDrawer()
  // Send focus back where it came from, so keyboard users are not dumped at
  // the top of the document.
  triggerEl.value?.focus()
}

// Opening can happen from here or from the landing page — either way the
// search box takes focus. Closing clears the filter, so the next person to
// press `?` gets the whole manual rather than someone else's search.
watch(helpDrawerOpen, async isOpen => {
  if (!isOpen) {
    query.value = ''
    expandedId.value = null
    // P5-60: the drawer is a bottom sheet on a phone; the page behind it must
    // not scroll away under a finger that misses the panel.
    unlockBodyScroll()
    return
  }
  lockBodyScroll()
  await nextTick()
  inputEl.value?.focus()
})

watch(matches, list => {
  if (query.value.trim() && list.length === 1) expandedId.value = list[0].id
})

function focusables(): HTMLElement[] {
  if (!panelEl.value) return []
  // Everything inside the panel is on screen: collapsed recipes are removed
  // from the DOM by v-if rather than hidden, so there is nothing to filter out.
  return Array.from(
    panelEl.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'),
  )
}

/** Focus trap: Tab off either end of the panel wraps to the other end. */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Tab') return
  const items = focusables()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (e.shiftKey && (active === first || !panelEl.value?.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

/** True when the person is typing somewhere — `?` must stay a question mark. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && helpDrawerOpen.value) {
    e.preventDefault()
    close()
    return
  }
  if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return
  if (isTyping(e.target)) return
  e.preventDefault()
  if (helpDrawerOpen.value) close()
  else open()
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  // Unmounting while open (a logout, say) must not leave the page frozen.
  if (helpDrawerOpen.value) unlockBodyScroll()
})
</script>

<template>
  <button
    ref="triggerEl"
    type="button"
    class="help-trigger"
    aria-label="Help — how do I…?"
    aria-haspopup="dialog"
    :aria-expanded="helpDrawerOpen"
    data-testid="help-trigger"
    @click="open"
  >
    <span class="help-trigger-icon" aria-hidden="true">?</span>
    <span class="help-trigger-text">Help</span>
  </button>

  <div v-if="helpDrawerOpen" class="help-backdrop sheet-backdrop" data-testid="help-backdrop" @click.self="close">
    <aside
      ref="panelEl"
      class="help-panel sheet"
      role="dialog"
      aria-modal="true"
      aria-label="How do I…"
      data-testid="help-drawer"
      @keydown="onPanelKeydown"
    >
      <span class="sheet-handle" aria-hidden="true"></span>
      <header class="help-header">
        <div>
          <h2 class="help-title">How do I…</h2>
          <p class="help-lede">
            Short recipes for the things you will do most.<span class="kbd-hint" data-testid="help-kbd-hint"> Press <kbd>?</kbd> to open this any time.</span>
          </p>
        </div>
        <button type="button" class="help-close" aria-label="Close help" data-testid="help-close" @click="close">✕</button>
      </header>

      <input
        ref="inputEl"
        v-model="query"
        type="search"
        class="help-search"
        placeholder="What are you trying to do?"
        aria-label="Search the help recipes"
        autocomplete="off"
        data-testid="help-search"
      />

      <p v-if="matches.length === 0" class="help-empty" data-testid="help-empty">
        Nothing here matches “{{ query.trim() }}”. Try a plainer word — “download”, “map”, “upload” — or ask the question in Chat.
      </p>

      <section v-for="group in groups" :key="group.tag" class="help-group" data-testid="help-group">
        <h3 class="help-group-name">{{ group.tag }}</h3>
        <ul class="help-list">
          <li v-for="recipe in group.recipes" :key="recipe.id" class="help-item" data-testid="help-recipe" :data-recipe="recipe.id">
            <button
              type="button"
              class="help-item-title"
              :aria-expanded="expandedId === recipe.id"
              data-testid="help-recipe-toggle"
              @click="toggleRecipe(recipe.id)"
            >
              <span>{{ recipe.title }}</span>
              <span class="help-chevron" aria-hidden="true">{{ expandedId === recipe.id ? '−' : '+' }}</span>
            </button>

            <div v-if="expandedId === recipe.id" class="help-body" data-testid="help-steps">
              <ol class="help-steps">
                <li v-for="(step, i) in recipe.steps" :key="i">{{ step }}</li>
              </ol>
              <RouterLink :to="recipe.href" class="help-goto" data-testid="help-goto" @click="close">Take me there →</RouterLink>
            </div>
          </li>
        </ul>
      </section>

      <p class="help-foot">
        Looking for a thing rather than a how-to?
        <span class="kbd-hint">Press <kbd>⌘K</kbd> to search everything.</span>
        <span class="touch-hint">Use the Search button in the header.</span>
      </p>
    </aside>
  </div>
</template>

<style scoped>
/* Same visual language as the command palette: cream panel, soft overlay,
   green for the one action that navigates. */
.help-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 999px;
  cursor: pointer;
}

.help-trigger:hover {
  color: var(--blo-ink, #111);
}

.help-trigger-icon {
  font-weight: 700;
}

.help-backdrop {
  position: fixed;
  inset: 0;
  z-index: 61;
  background: rgba(20, 18, 14, 0.35);
  display: flex;
  justify-content: flex-end;
}

.help-panel {
  width: min(420px, 100vw);
  height: 100%;
  overflow-y: auto;
  background: var(--blo-cream, #f7f4ee);
  border-left: 1px solid var(--blo-cream-divider, #e0d9ca);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.18);
  padding: 16px 18px 40px;
}

.help-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.help-title {
  margin: 0;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 20px;
  color: var(--blo-ink, #111);
}

.help-lede {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

.help-lede kbd,
.help-foot kbd {
  font-family: inherit;
  font-size: 11px;
  padding: 1px 5px;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 4px;
}

.help-close {
  margin-left: auto;
  padding: 2px 6px;
  font-size: 14px;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: none;
  cursor: pointer;
}

.help-close:hover {
  color: var(--blo-ink, #111);
}

.help-search {
  width: 100%;
  margin-top: 12px;
  padding: 10px 12px;
  font-size: 14px;
  background: #fff;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 8px;
}

.help-empty {
  margin: 14px 2px;
  font-size: 13px;
  color: var(--blo-stone, #6b6560);
}

.help-group {
  margin-top: 18px;
}

.help-group-name {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--blo-stone-soft, #9a948e);
}

.help-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.help-item {
  border-bottom: 1px solid var(--blo-cream-deep, #ede8dd);
}

.help-item-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 2px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  text-align: left;
  color: var(--blo-ink, #111);
  background: none;
  border: none;
  cursor: pointer;
}

.help-item-title:hover {
  color: var(--blo-green-deep, #1f7a2e);
}

.help-chevron {
  flex: 0 0 auto;
  color: var(--blo-stone-soft, #9a948e);
}

.help-body {
  padding: 0 2px 12px;
}

.help-steps {
  margin: 0 0 10px;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--blo-ink-soft, #2a2a2a);
}

.help-steps li {
  margin-bottom: 6px;
}

.help-goto {
  display: inline-block;
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}

.help-goto:hover {
  text-decoration: underline;
}

.help-foot {
  margin: 24px 2px 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
}

@media (max-width: 720px) {
  .help-trigger-text {
    display: none;
  }
}

/* The sheet handle only belongs to the phone layout. */
.sheet-handle {
  display: none;
}

/* P5-60: a keyboard shortcut is a lie on a touch device. `hover: none` is the
   closest thing CSS has to "this person has no keyboard". */
.touch-hint {
  display: none;
}

@media (hover: none) {
  .kbd-hint {
    display: none;
  }

  .touch-hint {
    display: inline;
  }
}

/* --- P5-60 (mobile pass) --------------------------------------------------
   Under 640 px the side drawer becomes a bottom sheet: a phone's thumb lives
   at the bottom of the screen, not at its right edge. */
@media (max-width: 640px) {
  .help-backdrop {
    justify-content: center;
    align-items: flex-end;
  }

  .sheet-handle {
    display: block;
  }

  .help-panel {
    width: 100%;
    height: auto;
    max-height: 85svh;
    border-left: 0;
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.22);
    padding: 10px 16px calc(28px + env(safe-area-inset-bottom, 0px));
  }

  .help-close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    font-size: 18px;
  }

  .help-search {
    min-height: 44px;
    /* Below 16 px iOS Safari zooms the page when the field takes focus. */
    font-size: 16px;
  }

  .help-item-title {
    min-height: 44px;
  }

  .help-goto {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  .help-lede,
  .help-empty,
  .help-steps,
  .help-goto,
  .help-foot {
    font-size: 14px;
  }

  .help-group-name {
    font-size: 12px;
  }
}
</style>
