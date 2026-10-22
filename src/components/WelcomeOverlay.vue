<script setup lang="ts">
/**
 * The public map's welcome (P15-3).
 *
 * Replaces `WelcomeCard` — a 320px card from phase 4f that introduced the
 * Livability Index in one sentence and said nothing about anything added
 * since: the prompt box, weighted scoring, the 3,144-county leaderboard.
 *
 * **Three doors, not a tour.** Phase 4f ruled multi-step onboarding out of
 * scope — *"One card, one dismiss."* That holds; this is still one screen
 * and one dismissal. What changed is that the map now does three things a
 * visitor will never find on their own, and each door here DOES the thing
 * rather than describing it: press one and the overlay is gone with the map
 * already set up. The host decides what each means — this component only
 * says which was pressed.
 *
 * The order is a ladder. Rankings first because it costs nothing and pays
 * at once; the measures last because it is the most to take in.
 *
 * **It must not cover a shared link.** The card this replaces checked only
 * localStorage and never the URL, so a first-time visitor opening
 * `/?layers=…&fit=…` got a welcome screen over the answer they were sent —
 * and the e2e suite pressed "Got it" before every interaction to work
 * around it. The host decides whether to render this at all; see `Map.vue`.
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { RouterLink } from 'vue-router'
import { usePhoneLayout } from '@/composables/usePhoneLayout'
import { useFocusTrap } from '@/composables/useFocusTrap'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/scrollLock'
import { SEED_QUESTION, type WelcomeDoor } from '@/lib/welcome'

const emit = defineEmits<{
  (e: 'door', door: WelcomeDoor): void
  (e: 'close'): void
}>()

const isPhone = usePhoneLayout()
const panel = ref<HTMLElement | null>(null)

/**
 * P15-1 exists for this surface: it was extracted so this would not be the
 * third hand-rolled copy. `aria-modal` without a trap is worse than neither,
 * because it hides the page from a screen reader while Tab still walks a
 * keyboard out onto a map nothing is announcing.
 *
 * `capture()` with no argument records whatever had focus, which is what an
 * overlay that appears on load has instead of a trigger — and is the Lens's
 * "What is this?" action once P15-4 can re-open it.
 */
const focusTrap = useFocusTrap(panel)

function choose(door: WelcomeDoor): void {
  // Deliberately no `release()`: every door hands focus somewhere of its own
  // — the prompt box, the first layer checkbox, the rankings rail (P15-3) —
  // so returning it to the trigger first would be a fight the host has to
  // win back on the next tick.
  emit('door', door)
}

function close(): void {
  // Back where it came from. A dialog that closes to nowhere drops a keyboard
  // reader at the top of the document, which on this page is the whole map.
  focusTrap.release()
  emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  // A modal swallows its own dismissal key. Nothing else on the logged-out
  // map listens for Escape today — `CountyModal` is only mounted while open,
  // the rest are internal — but the next global shortcut should not fire
  // underneath a dialog it cannot see.
  event.stopPropagation()
  close()
}

onMounted(async () => {
  lockBodyScroll()
  focusTrap.capture()
  // Capture phase, so the keystroke is ours before it is anybody else's.
  window.addEventListener('keydown', onKey, true)
  await nextTick()
  // The panel rather than the first button, which is the APG's rule for a
  // dialog that is a capped scroller: focusing a control inside one scrolls
  // the title and lede out of view before they have been read.
  panel.value?.focus()
})

onBeforeUnmount(() => {
  unlockBodyScroll()
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div
    class="welcome-backdrop"
    :class="{ 'welcome-backdrop--sheet': isPhone }"
    data-testid="welcome-backdrop"
    @click.self="close"
  >
    <section
      ref="panel"
      class="welcome blo-panel blo-panel--reference"
      :class="{ 'welcome--sheet': isPhone }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      tabindex="-1"
      data-testid="welcome"
      @keydown="focusTrap.onKeydown"
    >
      <!-- The phone sheet's grab handle. Decorative: the dismiss below is
           the real affordance, and a handle announced to a screen reader is
           a control that does nothing. -->
      <span v-if="isPhone" class="welcome-handle" aria-hidden="true"></span>

      <h2 id="welcome-title" class="welcome-title" data-testid="welcome-title">
        Welcome to BLO's Black Livability Data Map
      </h2>

      <p class="blo-type-body blo-type-body--measure welcome-lede">
        Every county in the country, scored on the conditions that shape Black livability.
        Start anywhere:
      </p>

      <!-- `role="list"` because `list-style: none` takes list semantics away
           in Safari/VoiceOver, and the order here is the point: it is a
           ladder, least setup first. Each door's title is a real heading so
           a screen reader can jump between the three. -->
      <ol class="welcome-doors" role="list">
        <li class="welcome-door">
          <h3 class="blo-type-item welcome-door-title">See how every county ranks</h3>
          <p class="blo-type-body blo-type-body--measure welcome-door-body">
            All 3,144, best to worst on the Livability Index. Click any one to look closer.
          </p>
          <button
            type="button"
            class="blo-act blo-act--lg"
            data-testid="welcome-door-rankings"
            @click="choose('rankings')"
          >See the rankings</button>
        </li>

        <li class="welcome-door">
          <h3 class="blo-type-item welcome-door-title">Ask a question in plain words</h3>
          <!-- The quote marks are literal rather than a `<q>` element with a
               `quotes` property. Generated content is not in `textContent`,
               so signed-off copy rendered that way is copy no test can read
               back — and this is an example of what to type, not a quotation
               from a source. -->
          <p class="blo-type-body blo-type-body--measure welcome-door-body">
            <span class="welcome-quote">“{{ SEED_QUESTION }}”</span> — the map answers by
            redrawing itself.
          </p>
          <button
            type="button"
            class="blo-act blo-act--lg"
            data-testid="welcome-door-ask"
            @click="choose('ask')"
          >Try this question</button>
        </li>

        <li class="welcome-door">
          <h3 class="blo-type-item welcome-door-title">Score counties on what matters to you</h3>
          <p class="blo-type-body blo-type-body--measure welcome-door-body">
            Choose the measures — homeownership, wages, pollution, life expectancy — and set
            how much each one counts.
          </p>
          <button
            type="button"
            class="blo-act blo-act--lg"
            data-testid="welcome-door-measures"
            @click="choose('measures')"
          >Choose your measures</button>
        </li>
      </ol>

      <p class="welcome-foot">
        <!-- A Show and a Go. Neither is filled: P9-13 reserves the fill for
             a write, and nothing here writes anything anybody else sees. -->
        <button
          type="button"
          class="blo-type-action welcome-skip"
          data-testid="welcome-skip"
          @click="close"
        >Just show me the map</button>
        <RouterLink
          to="/about"
          class="blo-type-action welcome-about"
          data-testid="welcome-about"
        >How the score works →</RouterLink>
      </p>
    </section>
  </div>
</template>

<style scoped>
.welcome-backdrop {
  position: fixed;
  inset: 0;
  /* Above the county loader (z-index 1000), which is a status report rather
     than a modal and keeps painting underneath. A visitor reading three
     doors while 5.6 MB of counties stream in has spent the wait. */
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* The value both existing overlays use. */
  background: rgba(20, 18, 14, 0.35);
  animation: welcome-backdrop-in 160ms ease-out;
}

.welcome {
  /* Two thirds of the window, and never more than a readable column. Two
     thirds of a wide monitor's HEIGHT would leave three doors floating in
     whitespace, so the height is the content's. */
  width: min(720px, 66vw);
  max-height: min(560px, 80vh);
  padding: 28px 32px;
  border-radius: 12px;
  /* The DOORS scroll, not the panel. Three doors already pass an 80vh cap on
     a laptop, and a panel that scrolls as one carries "Just show me the map"
     — the one guaranteed way out of a modal — below the fold with them. The
     column makes the door list the only shrinkable child; `overflow-y` stays
     here as well for the case nothing else can absorb (a short landscape
     phone, where the title and lede alone pass the cap). */
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
  animation: welcome-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.welcome:focus {
  outline: none;
}

.welcome-title {
  margin: 0 0 10px;
  font-family: var(--blo-font-display);
  font-size: 1.7rem;
  font-weight: 500;
  line-height: 1.2;
}

.welcome-lede {
  margin: 0 0 18px;
}

.welcome-doors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  /* Without this a flex child will not shrink below its content and the
     overflow walks back up to the panel, taking the footer with it. */
  min-height: 0;
}

.welcome-door {
  padding: 14px 16px;
  border: 1px solid var(--blo-cream-divider);
  border-radius: 8px;
  /* The panel above it is only 92% opaque, so a door's real background is
     part choropleth and changes as the map redraws. 0.6 is the lightest
     translucent white the codebase already uses (`AnalysisView.vue:1174`)
     and keeps `--blo-ink-soft` body type legible over any of it. */
  background: rgba(255, 255, 255, 0.6);
}

.welcome-door-title {
  margin: 0 0 4px;
}

.welcome-door-body {
  margin: 0 0 10px;
}

.welcome-quote {
  color: var(--blo-ink);
}

.welcome-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin: 18px 0 0;
}

.welcome-skip {
  /* Reset only what a <button> brings that a text action must not: the UA's
     own font family, chrome and padding. Size, weight and colour stay
     `.blo-type-action`'s — re-stating them here would win on scoped
     specificity and quietly opt this control out of the vocabulary it wears.
     `.link-btn` in `IngestPanel.vue:572` is the same reset. */
  font-family: inherit;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

.welcome-skip:hover {
  text-decoration: underline;
}

/* --- the phone, which is a sheet rather than a smaller box --------------- */

.welcome-backdrop--sheet {
  align-items: flex-end;
  padding: 0;
}

.welcome--sheet {
  width: 100%;
  max-width: none;
  max-height: 85vh;
  max-height: 85svh;
  border-radius: 14px 14px 0 0;
  padding: 10px 18px calc(20px + env(safe-area-inset-bottom, 0px));
  animation: welcome-sheet-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.welcome-handle {
  display: block;
  width: 40px;
  height: 4px;
  margin: 2px auto 12px;
  border-radius: 999px;
  background: var(--blo-cream-divider);
}

@media (max-width: 640px) {
  .welcome-title {
    font-size: clamp(20px, 6.5vw, 1.7rem);
  }

  .welcome-foot {
    justify-content: flex-start;
  }

  /* "Every control ≥44px on a phone" (P15-3). `.blo-act` buys it for the
     three doors (`base.css:349`) and buys it for nothing down here, because
     a Show in running text is not a `.blo-act` — which left the dismiss, the
     one guaranteed way out of a modal, as a ~20px target under a thumb. */
  .welcome-skip,
  .welcome-about {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }
}

@keyframes welcome-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes welcome-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

@keyframes welcome-sheet-in {
  from { transform: translateY(100%); }
  to { transform: none; }
}

/* The fourth component in the repo to honour this, and the first overlay.
   A 2/3-screen panel sliding in is exactly the motion the setting is for. */
@media (prefers-reduced-motion: reduce) {
  .welcome-backdrop,
  .welcome,
  .welcome--sheet {
    animation: none;
  }
}
</style>
