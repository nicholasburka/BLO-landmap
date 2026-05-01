<template>
  <aside
    v-if="visible"
    class="welcome-card blo-panel"
    role="region"
    aria-label="About this map"
  >
    <header class="welcome-eyebrow">
      <span class="welcome-dot" aria-hidden="true"></span>
      Welcome
    </header>
    <p class="welcome-body">
      This map shows the <strong>BLO Livability Index</strong> — a composite
      score from 1–5 combining demographics, racial equity, economics,
      housing, environment, and health for every US county.
    </p>
    <p class="welcome-hint">
      Click any county to inspect, or ask the AI for a custom view.
    </p>
    <footer class="welcome-footer">
      <a href="/about" class="welcome-link">Learn more</a>
      <button
        type="button"
        class="welcome-dismiss"
        @click="dismiss"
        aria-label="Dismiss welcome message"
      >Got it</button>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'

const STORAGE_KEY = 'blo:welcomeDismissed'

const visible = ref(false)

onMounted(() => {
  // Show on first visit only — localStorage failures (private mode) leave
  // the card visible, which is the safe degrade.
  try {
    if (localStorage.getItem(STORAGE_KEY) !== '1') visible.value = true
  } catch {
    visible.value = true
  }
})

function dismiss(): void {
  visible.value = false
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch { /* private mode — accept that the card returns next session */ }
}

/** Esc dismisses the card globally so keyboard users aren't stuck. */
function onKey(e: KeyboardEvent): void {
  if (visible.value && e.key === 'Escape') dismiss()
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
})
</script>

<style scoped>
/* Compact, editorial card pinned above the Lens at bottom-left.
   Cream + ink, with a small green dot to match the BLO badge. */
.welcome-card {
  /* Top-left, below the Ask input + example chips. One-time card —
     dismissed via localStorage so the slot returns to the chat history
     once the user has run their first query. */
  position: absolute;
  top: 168px;
  left: 16px;
  width: 320px;
  max-width: calc(100vw - 32px);
  padding: 14px 16px 12px;
  background: white;
  border: 1px solid var(--blo-cream-divider, #e0d9ca);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(17, 17, 17, 0.10);
  z-index: 6;
  animation: welcome-fade 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

@keyframes welcome-fade {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.welcome-eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--blo-stone, #6b6560);
  margin-bottom: 6px;
}
.welcome-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--blo-green-deep, #1f7a2e);
  box-shadow: 0 0 0 3px var(--blo-green-soft, rgba(55, 179, 74, 0.18));
}

.welcome-body {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--blo-ink, #111);
}
.welcome-body strong {
  font-weight: 700;
}

.welcome-hint {
  margin: 0 0 12px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--blo-stone, #6b6560);
}

.welcome-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.welcome-link {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--blo-green-deep, #1f7a2e);
  text-decoration: none;
}
.welcome-link:hover {
  color: var(--blo-ink, #111);
  text-decoration: underline;
}

.welcome-dismiss {
  background: var(--blo-ink, #111);
  color: white;
  border: 1px solid var(--blo-ink, #111);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  letter-spacing: 0.02em;
}
.welcome-dismiss:hover {
  background: var(--blo-green-deep, #1f7a2e);
  border-color: var(--blo-green-deep, #1f7a2e);
}

/* Mobile: full-width banner just under the header, above all map content. */
@media (max-width: 768px) {
  .welcome-card {
    top: 8px;
    left: 8px;
    right: 8px;
    width: auto;
  }
}
</style>
