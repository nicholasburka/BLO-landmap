/**
 * Phone-width behaviour for internal surfaces (P5-60).
 *
 * Layout belongs in CSS — every mobile rule in this pass is a
 * `@media (max-width: 640px)` block inside the component that owns it. This
 * file exists only for the two things a stylesheet cannot express:
 *
 *  - knowing, in script, that we are on a phone, because a panel that is a
 *    side drawer on a desktop and a bottom sheet on a phone must only lock
 *    the page behind it in the second case;
 *  - the Vue lifecycle around the shared, reference-counted body scroll lock
 *    in `lib/scrollLock`, so a sheet that unmounts while open still lets the
 *    page go.
 *
 * The breakpoint is stated once, here, so a component and its test cannot
 * drift apart on what "phone" means.
 */
import { ref, watch, onMounted, onBeforeUnmount, type Ref } from 'vue'
import { lockBodyScroll, unlockBodyScroll } from '@/lib/scrollLock'

/** The one breakpoint every internal mobile rule is written against. */
export const PHONE_QUERY = '(max-width: 640px)'

/**
 * Wide enough for a map beside something else (P6-10). The chat page's map
 * pane is desktop-only: two WebGL contexts and a 26rem column are not a
 * phone's business, and the CSS that hides it is written against this.
 */
export const MAP_PANE_QUERY = '(min-width: 1024px)'

/**
 * True while the viewport matches `query`. Starts false and is filled in on
 * mount: a component must render the same markup on the server and in a test
 * that has no `matchMedia`, and the classes it carries are the same either
 * way — only behaviour branches on this.
 */
export function useMediaQuery(mediaQuery: string): Ref<boolean> {
  const matches = ref(false)
  let query: MediaQueryList | null = null

  function sync(): void {
    matches.value = !!query?.matches
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    query = window.matchMedia(mediaQuery)
    matches.value = query.matches
    // Older Safari only has addListener; neither is worth a polyfill, so a
    // missing listener just means the value is read once at mount.
    query.addEventListener?.('change', sync)
  })

  onBeforeUnmount(() => {
    query?.removeEventListener?.('change', sync)
    query = null
  })

  return matches
}

/** True while the viewport is phone-width. */
export function usePhoneLayout(): Ref<boolean> {
  return useMediaQuery(PHONE_QUERY)
}

/**
 * Hold the page still while `locked` is true — what stops the list behind a
 * bottom sheet from scrolling under the reader's thumb.
 *
 * The lock itself lives in `lib/scrollLock`, shared with the help drawer, the
 * search palette and the nav menu: it is reference-counted, so two sheets open
 * at once (a row drawer under the help drawer) do not unlock the page when the
 * first one closes. All this adds is the Vue lifecycle around it — one lock
 * per component, released on unmount even if the sheet was still open.
 */
export function useBodyScrollLock(locked: Ref<boolean>): void {
  let held = false

  function apply(on: boolean): void {
    if (on === held) return
    if (on) lockBodyScroll()
    else unlockBodyScroll()
    held = on
  }

  watch(locked, apply, { immediate: true })
  onBeforeUnmount(() => apply(false))
}
