/**
 * Opening and closing a map pane beside a page's own content (P6-14).
 *
 * Every "Show on map" used to be a link to `/?layers=…&fit=…`: it left the
 * page you were reading, and the URL could say *which layer* and *where to
 * look* but never *which rows you were looking at*. A pane says both without
 * going anywhere — so the state behind one is three things, and all three are
 * the same on every page that offers it:
 *
 *  - **Is there room?** A map beside something else wants a desktop. The
 *    breakpoint is `MAP_PANE_QUERY`, shared with the chat pane.
 *  - **Is it open?** The host keeps the pane behind a `v-if` on this, which is
 *    what stops a reader who never opens it from downloading a county file.
 *  - **It closes itself when the window narrows past the breakpoint, and opens
 *    itself again when the room comes back.** Hiding it in CSS instead would
 *    leave a phone running a WebGL context it cannot see — but closing without
 *    reopening left the page saying "there is not room for a map here" on a
 *    1,440px window, because the hosts only call `open()` from a watcher on
 *    their own state and widening changes none of it. Reopening is for the
 *    width alone: a reader who pressed X meant it, and stays closed.
 *
 * The pane's chrome — header, X, the canvas — is `MapPane.vue`. This is only
 * the switch, so a page can offer the button without owning any of that.
 */
import { ref, watch, type Ref } from 'vue'
import { useMediaQuery, MAP_PANE_QUERY } from '@/composables/usePhoneLayout'

export interface MapPaneToggle {
  /** Wide enough to hold a map beside the content (≥1024 px). */
  canOpen: Ref<boolean>
  /** Whether the pane is mounted. `v-if` on this, not `v-show`. */
  isOpen: Ref<boolean>
  /** Open it, if this viewport can hold one. */
  open: () => void
  /** Close it, running `onClose` if it was in fact open. */
  close: () => void
  toggle: () => void
}

export function useMapPane(options: { onClose?: () => void } = {}): MapPaneToggle {
  const canOpen = useMediaQuery(MAP_PANE_QUERY)
  const isOpen = ref(false)

  /**
   * Somebody wants this pane open and the WIDTH is the only thing stopping it.
   *
   * One flag covers both ways that happens, because they are the same thing:
   * the host asked while the window was too narrow (a page opened on a small
   * window and then widened), or it was open and the window narrowed under it.
   * Cleared by any deliberate close — a reader who pressed X and then resized
   * did not ask for the map back.
   */
  let wantsOpen = false

  const open = (): void => {
    // A phone gets the link it has always had, not a pane it cannot read.
    if (canOpen.value) {
      isOpen.value = true
      wantsOpen = false
    } else {
      wantsOpen = true
    }
  }

  const close = (): void => {
    wantsOpen = false
    if (!isOpen.value) return
    isOpen.value = false
    options.onClose?.()
  }

  const toggle = (): void => {
    if (isOpen.value) close()
    else open()
  }

  // Narrowing past the breakpoint closes the pane. One path out means a host's
  // `onClose` runs whether a person pressed the X or resized the window.
  watch(canOpen, wide => {
    if (!wide) {
      const wasOpen = isOpen.value
      close()
      // Set after `close`, which clears it: this is the one close that is not
      // a decision, so it is the one that can be undone.
      wantsOpen = wasOpen
    } else if (wantsOpen) {
      open()
    }
  })

  return { canOpen, isOpen, open, close, toggle }
}
