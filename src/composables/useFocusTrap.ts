/**
 * One focus trap, shared (P15-1).
 *
 * This was the same fifteen lines twice — `onPanelKeydown` + `focusables()`,
 * copied between the Help drawer and the phone nav menu — and the welcome
 * overlay (P15-3) would have been the third copy. Two is a coincidence; three
 * is a pattern with no home, so this is the home and both copies are gone.
 *
 * A modal panel needs three things from it, all of them about the person who
 * is not using a mouse: Tab and Shift+Tab wrap inside the panel rather than
 * walking off into the page behind it, the first tab stop takes focus as the
 * panel opens, and the trigger gets focus back when it closes — otherwise
 * closing a dialog dumps you at the top of the document.
 */
import type { Ref } from 'vue'

/**
 * What counts as a tab stop. This is the union of the two selectors it
 * replaces, which differed only by accident of their contents: the drawer's
 * listed `input` because it has a search box, the nav menu's did not because
 * it has none. Disabled controls are excluded here rather than per-call,
 * since the browser will not focus one however it got into the panel.
 */
const TAB_STOPS =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Whether `el` can actually be reached, checked up to `container`.
 *
 * The HelpDrawer copy skipped this, and its comment earned the omission:
 * everything inside that panel is on screen, because a collapsed recipe is
 * removed from the DOM by `v-if` rather than hidden, so there was nothing to
 * filter out. A shared trap cannot assume that of the next panel — one door
 * hidden by a `@media` rule or a `hidden` attribute would silently become the
 * end of the cycle, and a Tab that should have wrapped would land nowhere —
 * so the check moves here, and the comment with it.
 *
 * It reads styles rather than measuring layout (`offsetParent`,
 * `getClientRects()`), which is how this is usually written. jsdom computes no
 * layout, so the measured version calls every element hidden, the trap would
 * do nothing under test, and the tests are the only reason we know it works.
 */
function isReachable(el: HTMLElement, container: HTMLElement): boolean {
  let node: HTMLElement | null = el
  while (node) {
    if (node.hidden) return false
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (node === container) return true
    node = node.parentElement
  }
  return true
}

export interface FocusTrap {
  /** Bind to the panel's `@keydown`: this is the wrap itself. */
  onKeydown(event: KeyboardEvent): void
  /** The panel's tab stops, in document order. */
  focusables(): HTMLElement[]
  /** Move focus to the first tab stop — what a panel wants as it opens. */
  focusFirst(): void
  /** Record where focus must go when the panel closes. */
  capture(trigger?: HTMLElement | null): void
  /** Hand focus back to whatever `capture` recorded. */
  release(): void
}

/** Trap Tab inside `containerEl` for as long as its panel is on screen. */
export function useFocusTrap(containerEl: Ref<HTMLElement | null>): FocusTrap {
  let returnTo: HTMLElement | null = null

  function focusables(): HTMLElement[] {
    const container = containerEl.value
    if (!container) return []
    return Array.from(container.querySelectorAll<HTMLElement>(TAB_STOPS)).filter(el =>
      isReachable(el, container),
    )
  }

  function focusFirst(): void {
    focusables()[0]?.focus()
  }

  function capture(trigger?: HTMLElement | null): void {
    // A panel opened from a button names it, because that is where focus
    // belongs however the panel was opened — the drawer answers to `?` and to
    // a link on the landing page as well as to its own trigger, and all three
    // must end up back on the Help button. An overlay that appears on load has
    // no trigger to name, so whatever had focus stands in for one.
    returnTo = trigger ?? (document.activeElement as HTMLElement | null)
  }

  function release(): void {
    // Not cleared: a second close — Esc arriving while the panel is already
    // going — must still land on the trigger rather than on nothing.
    returnTo?.focus()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return
    const stops = focusables()
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement as HTMLElement | null
    // Everything that counts as "at the start", for Shift+Tab's purposes:
    //  - the first tab stop, obviously;
    //  - the CONTAINER itself. A dialog whose content would scroll past if a
    //    button took focus puts focus on its own `tabindex="-1"` panel
    //    instead (the welcome overlay, P15-3) — and `contains` says yes to an
    //    element about itself, so without this case the first Shift+Tab out
    //    of such a panel walks straight out of the modal.
    const atStart = active === first || active === containerEl.value
    // Shift+Tab from outside the panel wraps to its end too: focus can still
    // be on the document when the keystroke arrives, and sending it backwards
    // out of a modal is exactly what the trap is for.
    if (event.shiftKey && (atStart || !containerEl.value?.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return { onKeydown, focusables, focusFirst, capture, release }
}
