<template>
  <!-- Mobile-only backdrop. Tapping it collapses the drawer back to peek. -->
  <div
    v-if="mobileExpanded"
    class="lens-backdrop"
    @click="mobileExpanded = false"
    aria-hidden="true"
  ></div>

  <aside
    class="lens blo-panel"
    :class="{
      'lens--mobile-peek': isMobile && !mobileExpanded,
      'lens--mobile-expanded': isMobile && mobileExpanded,
    }"
    role="region"
    aria-label="Map context — what you're looking at"
  >
    <!-- Persistent header: active-query summary.
         On mobile in peek state, this whole strip is the tap target to expand. -->
    <header
      class="lens-header"
      :class="{ 'lens-header--peek': isMobile && !mobileExpanded }"
      :tabindex="isMobile && !mobileExpanded ? 0 : -1"
      :role="isMobile && !mobileExpanded ? 'button' : undefined"
      :aria-expanded="isMobile ? mobileExpanded : undefined"
      :aria-controls="isMobile ? 'lens-tabs-and-body' : undefined"
      @click="onHeaderClick"
      @keydown="onHeaderKeydown"
    >
      <!-- Mobile-only chevron, left-aligned. Big enough to read as an
           obvious "tap to expand" affordance — earlier mobile users
           reported the small right-side handle was easy to miss. -->
      <span
        v-if="isMobile"
        class="lens-chevron"
        :class="{ 'lens-chevron--expanded': mobileExpanded }"
        aria-hidden="true"
      ></span>
      <slot name="header">
        <span class="lens-header-fallback">Context</span>
      </slot>
    </header>

    <div
      id="lens-tabs-and-body"
      class="lens-tabs-and-body"
      :class="{ 'lens-tabs-and-body--hidden': isMobile && !mobileExpanded }"
    >
      <!-- Tabs -->
      <div
        class="lens-tabs"
        role="tablist"
        aria-label="Lens views"
      >
        <button
          v-for="tab in TABS"
          :key="tab.id"
          :id="'lens-tab-' + tab.id"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.id"
          :aria-controls="'lens-panel-' + tab.id"
          :tabindex="activeTab === tab.id ? 0 : -1"
          class="lens-tab"
          :class="{ 'lens-tab--active': activeTab === tab.id }"
          @click="activeTab = tab.id"
          @keydown="onTabKeydown($event, tab.id)"
        >{{ tab.label }}</button>
      </div>

      <!-- Tab panels: only one visible at a time, cross-fade between -->
      <div
        class="lens-body"
        :class="{
          'lens-body--scroll-up': showScrollUp,
          'lens-body--scroll-down': showScrollDown,
        }"
        ref="lensBodyEl"
        @scroll="updateScrollAffordance"
      >
        <transition name="lens-fade" mode="out-in">
          <section
            :key="activeTab"
            :id="'lens-panel-' + activeTab"
            role="tabpanel"
            :aria-labelledby="'lens-tab-' + activeTab"
            class="lens-panel"
          >
            <slot v-if="activeTab === 'legend'" name="legend">
              <p class="lens-placeholder">Legend content here.</p>
            </slot>
            <slot v-else-if="activeTab === 'layers'" name="layers">
              <p class="lens-placeholder">Layers content here.</p>
            </slot>
            <slot v-else-if="activeTab === 'context'" name="context">
              <p class="lens-placeholder">Context content here.</p>
            </slot>
          </section>
        </transition>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'

type TabId = 'legend' | 'layers' | 'context'

const TABS: { id: TabId; label: string }[] = [
  { id: 'legend', label: 'Legend' },
  { id: 'layers', label: 'Layers' },
  { id: 'context', label: 'Context' },
]

const activeTab = ref<TabId>('legend')

/** Mobile drawer state — tracks whether the bottom drawer is expanded
 *  beyond its 48px peek. Window-width detected reactively. */
const isMobile = ref(false)
const mobileExpanded = ref(false)

const MOBILE_BP = 768
function checkMobile(): void {
  isMobile.value = typeof window !== 'undefined' && window.innerWidth <= MOBILE_BP
  if (!isMobile.value) {
    // Always reset expanded state when leaving mobile so desktop renders fully open
    mobileExpanded.value = false
  }
}
onMounted(() => {
  checkMobile()
  window.addEventListener('resize', checkMobile)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', checkMobile)
})

function onHeaderClick(): void {
  if (!isMobile.value) return
  mobileExpanded.value = !mobileExpanded.value
}

function onHeaderKeydown(e: KeyboardEvent): void {
  if (!isMobile.value) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    mobileExpanded.value = !mobileExpanded.value
  }
}

function onTabKeydown(e: KeyboardEvent, currentId: TabId): void {
  const idx = TABS.findIndex(t => t.id === currentId)
  if (idx === -1) return
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    const next = TABS[(idx + 1) % TABS.length]
    activeTab.value = next.id
    focusTab(next.id)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    const prev = TABS[(idx - 1 + TABS.length) % TABS.length]
    activeTab.value = prev.id
    focusTab(prev.id)
  } else if (e.key === 'Home') {
    e.preventDefault()
    activeTab.value = TABS[0].id
    focusTab(TABS[0].id)
  } else if (e.key === 'End') {
    e.preventDefault()
    const last = TABS[TABS.length - 1]
    activeTab.value = last.id
    focusTab(last.id)
  }
}

function focusTab(id: TabId): void {
  // After Vue updates tabindex, refocus the now-active tab
  requestAnimationFrame(() => {
    const el = document.getElementById('lens-tab-' + id)
    el?.focus()
  })
}

// Phase 4f: scroll-affordance fades. Track whether the body has content
// above and/or below the visible area, expose as classes on the scroll
// container — the CSS pseudo-elements pick those up.
const lensBodyEl = ref<HTMLElement | null>(null)
const showScrollUp = ref(false)
const showScrollDown = ref(false)

function updateScrollAffordance(): void {
  const el = lensBodyEl.value
  if (!el) {
    showScrollUp.value = false
    showScrollDown.value = false
    return
  }
  const max = el.scrollHeight - el.clientHeight
  showScrollUp.value = el.scrollTop > 4
  showScrollDown.value = max - el.scrollTop > 4
}

// Re-evaluate when the active tab changes (wait past the 150ms cross-fade)
// AND whenever the body content resizes (categories accordion expand,
// chips wrap, etc.). ResizeObserver fires for any DOM change inside
// the body, including children — exactly the trigger we need.
function scheduleAffordanceCheck(): void {
  nextTick(updateScrollAffordance)
  setTimeout(updateScrollAffordance, 180)
}
watch(activeTab, scheduleAffordanceCheck)

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  scheduleAffordanceCheck()
  if (lensBodyEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => updateScrollAffordance())
    resizeObserver.observe(lensBodyEl.value)
    // Also observe direct children — scrollHeight only updates when child
    // size changes, which the parent observer might miss.
    Array.from(lensBodyEl.value.children).forEach((c) => resizeObserver!.observe(c))
  }
  window.addEventListener('resize', updateScrollAffordance)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('resize', updateScrollAffordance)
})
</script>

<style scoped>
/* The Lens — single primary card for "what does this map mean right now?"
   Editorial-modern direction: cream background, ink-soft hairline divider,
   monospace tabular figures (in nested tab content), Fraunces section labels. */
.lens {
  position: absolute;
  bottom: 16px;
  left: 16px;
  width: 300px;
  max-height: min(60vh, 540px);
  z-index: 4;
  display: flex;
  flex-direction: column;
  background: var(--blo-cream, #f7f4ee);
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: var(--blo-radius-panel, 10px);
  box-shadow: var(--blo-shadow-panel, 0 8px 24px rgba(17, 17, 17, 0.10));
  overflow: hidden;
}

.lens-header {
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
  background: var(--blo-cream-deep, #ede8dd);
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  text-align: left;
}
/* The header's main content (LensHeader) takes remaining width */
.lens-header > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}

.lens-header-fallback {
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 13px;
  font-weight: 600;
  color: var(--blo-stone, #6b6560);
  letter-spacing: 0.03em;
}

.lens-tabs {
  display: flex;
  align-items: stretch;
  padding: 0 8px;
  background: var(--blo-cream, #f7f4ee);
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
}

.lens-tab {
  flex: 1;
  padding: 10px 6px;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease;
}
.lens-tab:hover {
  color: var(--blo-ink-soft, #2a2a2a);
}
.lens-tab--active {
  color: var(--blo-ink, #111);
  border-bottom-color: var(--blo-ink, #111);
}
.lens-tab:focus-visible {
  outline: 2px solid var(--blo-green-deep, #1f7a2e);
  outline-offset: -3px;
  border-radius: 4px;
}

.lens-body {
  flex: 1 1 auto;
  min-height: 80px;
  overflow-y: auto;
  position: relative;
}

/* Phase 4f: scroll-affordance fades. Sticky pseudo-elements that overlay
   the top and bottom 16px of the scroll container; opacity is driven by
   the parent class so they only show when there's something to scroll. */
.lens-body::before,
.lens-body::after {
  content: "";
  position: sticky;
  left: 0;
  right: 0;
  display: block;
  height: 16px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 150ms ease;
  z-index: 1;
}
.lens-body::before {
  top: 0;
  margin-bottom: -16px;
  background: linear-gradient(to bottom, var(--blo-cream, #f7f4ee), transparent);
}
.lens-body::after {
  bottom: 0;
  margin-top: -16px;
  background: linear-gradient(to top, var(--blo-cream, #f7f4ee), transparent);
}
.lens-body--scroll-up::before { opacity: 1; }
.lens-body--scroll-down::after { opacity: 1; }

.lens-panel {
  padding: 12px 14px 14px;
}

.lens-placeholder {
  margin: 0;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  font-style: italic;
}

/* Cross-fade between tab panels — 150ms */
.lens-fade-enter-active,
.lens-fade-leave-active {
  transition: opacity 150ms ease;
}
.lens-fade-enter-from,
.lens-fade-leave-to {
  opacity: 0;
}

.lens-tabs-and-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
.lens-tabs-and-body--hidden {
  display: none;
}

.lens-handle {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--blo-stone, #6b6560);
  margin-left: auto;
  display: none;
}

/* ----- Phase 4d L6: Mobile drawer ------------------------------------- */
.lens-backdrop {
  display: none;
}

@media (max-width: 768px) {
  .lens {
    /* Anchor to the bottom edge — drawer behavior */
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    width: auto;
    max-width: none;
    border-radius: 14px 14px 0 0;
    box-shadow: 0 -8px 24px rgba(17, 17, 17, 0.14);
    transition: max-height 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
    z-index: 9;
  }

  .lens--mobile-peek {
    max-height: 56px;
  }
  .lens--mobile-peek .lens-tabs-and-body {
    /* Already hidden via class; ensure no scroll height */
    pointer-events: none;
  }

  .lens--mobile-expanded {
    max-height: 70vh;
  }

  .lens-header {
    padding: 10px 14px;
  }
  .lens-header--peek {
    cursor: pointer;
  }
  .lens-header--peek:focus-visible {
    outline: 2px solid var(--blo-green-deep, #1f7a2e);
    outline-offset: -3px;
  }

  /* Mobile chevron — CSS-drawn V using two borders. Sits left of the
     header text. Points UP when collapsed (peek), rotates 180° to
     point DOWN when expanded. Visible affordance for "tap me."
     Selector specificity intentionally beats `.lens-header > :first-child`
     above (which sets flex:1 — would stretch the chevron to full bar
     width and produce a huge diagonal stripe after the 45° rotation). */
  .lens-header > .lens-chevron {
    flex: 0 0 auto;
    align-self: center;
    display: inline-block;
    box-sizing: border-box;
    width: 10px;
    height: 10px;
    margin-right: 6px;
    /* Two borders form a chevron pointing up (^) */
    border-top: 2px solid var(--blo-stone, #6b6560);
    border-right: 2px solid var(--blo-stone, #6b6560);
    border-left: 0;
    border-bottom: 0;
    background: transparent;
    transform: rotate(-45deg) translateY(2px);
    transform-origin: center center;
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
                border-color 120ms ease;
  }
  /* Expanded: rotate so the chevron points DOWN (v) */
  .lens-header > .lens-chevron--expanded {
    transform: rotate(135deg) translateY(-2px);
  }
  /* Hover on the peek bar darkens the chevron — reinforces tappability. */
  .lens-header--peek:hover > .lens-chevron {
    border-color: var(--blo-ink, #111);
  }

  /* Backdrop dims map slightly when expanded */
  .lens-backdrop {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(17, 17, 17, 0.10);
    z-index: 8;
    animation: lens-backdrop-in 180ms ease;
  }
  @keyframes lens-backdrop-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }
}
</style>
