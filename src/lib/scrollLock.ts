/**
 * Body scroll lock for full-screen overlays (P5-60).
 *
 * On a phone a bottom sheet or full-screen palette sits over the page; if the
 * page behind it keeps scrolling, a finger drag that misses the sheet moves
 * the wrong thing and the reader loses their place. Locking `body` fixes that.
 *
 * Reference-counted on purpose: the Help drawer, the search palette and the
 * nav menu can be layered (Help opens over the menu), and the first one to
 * close must not unlock the page for the ones still open.
 */

let depth = 0
/** What `body` had before the first lock, restored by the last unlock. */
let previousOverflow = ''

export function lockBodyScroll(): void {
  if (typeof document === 'undefined') return
  if (depth === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  depth++
}

export function unlockBodyScroll(): void {
  if (typeof document === 'undefined') return
  if (depth === 0) return
  depth--
  if (depth === 0) document.body.style.overflow = previousOverflow
}

/** Tests only: forget any leaked locks between cases. */
export function resetBodyScrollLock(): void {
  depth = 0
  if (typeof document !== 'undefined') document.body.style.overflow = ''
}
