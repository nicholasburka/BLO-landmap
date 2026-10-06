<script setup lang="ts">
/**
 * What the header gains once you are logged in (P5-43, P5-60): the "How do I…"
 * drawer, and — on a phone — the Menu that holds the nav links the collapsed
 * header no longer has room for.
 *
 * The two live in ONE lazily-imported component on purpose:
 *  - neither the drawer's how-to copy nor the menu's internal destinations
 *    belong in the public entry chunk (P5-19 bundle rule); and
 *  - App.vue's header keeps exactly the same number of `v-if`s it had before
 *    P5-60, so a logged-out visitor's header markup is byte-for-byte what it
 *    was. That is the hard rule of this ticket, and a test asserts it.
 *
 * The Menu is a bottom sheet: fixed to the bottom edge where a thumb reaches,
 * Esc or a tap outside closes it, focus stays inside while it is open, and the
 * page behind it stops scrolling.
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import HelpDrawer from './HelpDrawer.vue'
import { useAuth } from '@/composables/useAuth'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/scrollLock'

/** The width below which the header collapses — same number as the CSS. */
const PHONE = '(max-width: 640px)'

const router = useRouter()
const { internalUser, logoutInternal } = useAuth()

const open = ref(false)
const panelEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLButtonElement | null>(null)

/**
 * Everywhere the collapsed header can no longer show a link to (P5-60).
 *
 * P6-5: the same four internal items the wide header shows — Library,
 * Search, Chat, New — plus the two public links the collapsed header hides,
 * and Account, which is the only place a phone says who you are signed in as.
 * The resource tabs (Datasets · Docs · Analysis) are not here: they are on
 * every knowledge-base page already, as a strip that scrolls.
 */
const items = computed(() => [
  { to: '/', label: 'Map', note: '' },
  { to: '/about', label: 'About', note: '' },
  { to: '/kb', label: 'Library', note: '' },
  { to: '/search', label: 'Search', note: '' },
  { to: '/chat', label: 'Chat', note: '' },
  { to: '/new', label: 'New', note: '' },
  // The collapsed header no longer shows who you are signed in as, so the
  // Account row says it.
  { to: '/account', label: 'Account', note: internalUser.value?.username ?? '' },
])

function openMenu(): void {
  open.value = true
}

function close(): void {
  if (!open.value) return
  open.value = false
  // Back where it came from, so a keyboard user is not dumped at the top of
  // the document.
  triggerEl.value?.focus()
}

async function logout(): Promise<void> {
  open.value = false
  await logoutInternal()
  void router.push('/')
}

watch(open, async isOpen => {
  if (!isOpen) {
    unlockBodyScroll()
    return
  }
  lockBodyScroll()
  await nextTick()
  focusables()[0]?.focus()
})

function focusables(): HTMLElement[] {
  if (!panelEl.value) return []
  return Array.from(
    panelEl.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
  )
}

/** Focus trap: Tab off either end wraps to the other end. */
function onPanelKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const list = focusables()
  if (list.length === 0) return
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (event.shiftKey && (active === first || !panelEl.value?.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    close()
  }
}

// A sheet only makes sense while the header is collapsed. If the window grows
// past the breakpoint (a rotation, or a desktop window being widened) the Menu
// button disappears, so the sheet has to go with it.
let media: MediaQueryList | null = null
function onMediaChange(event: MediaQueryListEvent): void {
  if (!event.matches) close()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (typeof window.matchMedia === 'function') {
    media = window.matchMedia(PHONE)
    media.addEventListener?.('change', onMediaChange)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  media?.removeEventListener?.('change', onMediaChange)
  // An unmount while open (a logout, say) must not leave the page frozen.
  if (open.value) unlockBodyScroll()
})
</script>

<template>
  <HelpDrawer />

  <button
    ref="triggerEl"
    type="button"
    class="nav-menu-btn touch-target"
    aria-label="Menu"
    aria-haspopup="dialog"
    :aria-expanded="open"
    data-testid="nav-menu-trigger"
    @click="openMenu"
  >
    <span aria-hidden="true">☰</span>
  </button>

  <div v-if="open" class="nav-menu-backdrop sheet-backdrop" data-testid="nav-menu-backdrop" @click.self="close">
    <div
      ref="panelEl"
      class="nav-menu-sheet sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      data-testid="nav-menu-sheet"
      @keydown="onPanelKeydown"
    >
      <span class="sheet-handle" aria-hidden="true"></span>
      <div class="nav-menu-head">
        <h2 class="nav-menu-title">Menu</h2>
        <button type="button" class="nav-menu-close touch-target" aria-label="Close menu" data-testid="nav-menu-close" @click="close">✕</button>
      </div>
      <ul class="nav-menu-list">
        <li v-for="item in items" :key="item.to">
          <RouterLink :to="item.to" class="nav-menu-link touch-target" data-testid="nav-menu-link" @click="close">
            <span>{{ item.label }}</span>
            <span v-if="item.note" class="nav-menu-note" data-testid="nav-menu-note">{{ item.note }}</span>
          </RouterLink>
        </li>
        <li>
          <button type="button" class="nav-menu-link nav-menu-logout touch-target" data-testid="nav-menu-logout" @click="logout">
            Log out
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* The Menu exists only while the header is collapsed; on a wide screen the
   nav shows every one of these links itself. */
.nav-menu-btn {
  display: none;
}

.nav-menu-backdrop {
  z-index: 62;
}

.nav-menu-sheet {
  background: var(--blo-cream, #f7f4ee);
  padding: 8px 12px calc(20px + env(safe-area-inset-bottom, 0px));
}

.nav-menu-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.nav-menu-title {
  margin: 0;
  font-family: var(--blo-font-display, 'Fraunces', serif);
  font-size: 17px;
  font-weight: 500;
  color: var(--blo-ink, #111);
}

.nav-menu-close {
  font-size: 18px;
  color: var(--blo-stone, #6b6560);
  background: none;
  border: 0;
  cursor: pointer;
}

.nav-menu-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.nav-menu-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 52px;
  padding: 0 8px;
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  text-align: left;
  color: var(--blo-ink, #111);
  text-decoration: none;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--blo-cream-divider, #e0d9ca);
  cursor: pointer;
}

.nav-menu-list li:last-child .nav-menu-link {
  border-bottom: 0;
}

.nav-menu-logout {
  color: var(--blo-stone, #6b6560);
}

.nav-menu-note {
  font-size: 14px;
  font-weight: 400;
  color: var(--blo-stone, #6b6560);
}

@media (max-width: 640px) {
  .nav-menu-btn {
    display: inline-flex;
    color: var(--blo-stone, #6b6560);
    background: #fff;
    border: 1px solid var(--blo-cream-divider, #e0d9ca);
    border-radius: 999px;
    cursor: pointer;
  }
}
</style>
