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
 *  - **It closes itself when the window narrows past the breakpoint.** Hiding
 *    it in CSS instead would leave a phone running a WebGL context it cannot
 *    see.
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

  const open = (): void => {
    // A phone gets the link it has always had, not a pane it cannot read.
    if (canOpen.value) isOpen.value = true
  }

  const close = (): void => {
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
    if (!wide) close()
  })

  return { canOpen, isOpen, open, close, toggle }
}
