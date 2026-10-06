<script setup lang="ts">
/**
 * Shared phone rules for the internal surfaces (P5-60).
 *
 * This component renders nothing. It exists so that a set of GLOBAL (unscoped)
 * classes can be loaded for logged-in people only: App.vue mounts it behind
 * `v-if="internalUser"` and imports it lazily, so a logged-out visitor's map
 * never downloads these bytes and never has these rules in the document — the
 * public map stays pixel-identical (P5-19 bundle rule, P5-60 hard rule).
 *
 * ---------------------------------------------------------------------------
 * THE SHARED CLASSES
 * ---------------------------------------------------------------------------
 *  .touch-target   A control at least 44 × 44 px, centred. Put it on any
 *                  button, link-as-button, tab or chip action.
 *  .strip          One row that scrolls sideways instead of wrapping into two
 *                  or three. Scrollbar hidden, edges faded so it reads as
 *                  "there is more this way".
 *  .stack          Children in one column, each full width.
 *  .sheet          A bottom sheet: fixed to the bottom of the screen, at most
 *                  85% of it tall, with a drag handle and safe-area padding.
 *                  Use with `.sheet-backdrop` on its parent overlay, and
 *                  `.sheet-handle` on the grab bar at the top.
 *  .sheet--full    The full-screen variant of `.sheet` (the search palette).
 *
 * There is deliberately NO shared `.text-body` class. The ticket's 14 px floor
 * is real and enforced everywhere, but `font-size` is precisely the property a
 * component's own scoped rule always sets — so a plain global class could
 * never win it (see below), and a class that loses every argument is worse
 * than no class at all. Each component raises its own sub-14 px text inside
 * its `@media (max-width: 640px)` block instead, next to the rule it replaces.
 *
 * ---------------------------------------------------------------------------
 * WHY COMPONENTS ALSO CARRY THEIR OWN @media BLOCKS
 * ---------------------------------------------------------------------------
 * Vue's scoped styles compile `.toolbar` into `.toolbar[data-v-abc]`, which is
 * MORE specific than a plain `.strip` here. So where a component's own rule
 * sets the same property (flex-wrap, font-size, flex-direction…), the winning
 * rule has to live in that component's `<style scoped>` block. The classes
 * below are the shared vocabulary and carry the properties nobody else sets
 * (hit sizes, scrollbar hiding, sheet positioning); each component adds the
 * handful of overrides only it can win. Tests assert the class is present —
 * jsdom computes no layout, so the class is what "renders the mobile variant"
 * means there.
 */
</script>

<template>
  <!-- Nothing to draw: this component is its stylesheet. -->
</template>

<style>
/* Deliberately UNSCOPED: these classes are applied by components all over the
   internal app, and a scoped block would stop at this component's own root. */

@media (max-width: 640px) {
  .touch-target {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
  }

  .strip {
    /* The strip scrolls its own content. Without `min-width: 0` its unwrapped
       width (nine editor buttons, six nav sections) is its intrinsic minimum,
       and that minimum climbs the whole ancestor chain until the PAGE grows
       instead of the strip scrolling — which is exactly what /kb and the wiki
       editor did at 375 px. `max-width: 100%` is the second half of the same
       promise. */
    max-width: 100%;
    /* P6-30: and those two are still not enough where an ANCESTOR is a flex
       item. `min-width: 0` lets the strip shrink; it does not stop the strip's
       min-content width being handed up to a flex item whose own `min-width`
       is still `auto`, which then refuses to go narrower than its contents.
       `/search` was the case: `.search-panel` sized to the strip's 543 px and
       pushed the document to 566 inside a 390 px viewport, cutting every page
       to its right. `/datasets` hid it, because nothing in that chain is flex.
       `width: 0` makes the strip contribute nothing to any ancestor's
       intrinsic width, and `min-width: 100%` paints it back out to the full
       width it is given — so the page sizes to the viewport and the strip,
       not the page, is what scrolls. Six nav items made this reachable where
       three had fitted. */
    width: 0;
    min-width: 100%;
    overflow-x: auto;
    /* Momentum scrolling on iOS, no scrollbar eating a row of pixels, and a
       fade at each edge so a half-cut tab reads as "keep swiping". */
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    scroll-padding-inline: 12px;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  }

  .strip::-webkit-scrollbar {
    display: none;
  }

  .strip > * {
    flex: 0 0 auto;
  }

  .stack {
    align-items: stretch;
    min-width: 0;
    max-width: 100%;
  }

  .stack > * {
    max-width: 100%;
  }

  /* --- Bottom sheets ----------------------------------------------------
     The overlay dims the page; the panel rises from the bottom edge, where a
     thumb can reach it. `svh` is the small viewport height, so the sheet does
     not hide under a mobile browser's collapsing address bar. */
  .sheet-backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    background: rgba(20, 18, 14, 0.35);
  }

  .sheet {
    position: relative;
    width: 100%;
    max-width: none;
    max-height: 85vh;
    max-height: 85svh;
    overflow-y: auto;
    border-radius: 14px 14px 0 0;
    /* env() is 0 until index.html asks for viewport-fit=cover — which would
       move the PUBLIC map, so it stays as it is. The padding is written the
       right way round for the day that changes. */
    padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -12px 40px rgba(0, 0, 0, 0.22);
  }

  .sheet--full {
    max-height: none;
    height: 100vh;
    height: 100svh;
    border-radius: 0;
    padding-top: calc(10px + env(safe-area-inset-top, 0px));
  }

  .sheet-handle {
    display: block;
    width: 40px;
    height: 4px;
    margin: 2px auto 10px;
    border-radius: 999px;
    background: var(--blo-cream-divider, #e0d9ca);
  }
}

/* --- The internal header, collapsed (P5-60 deliverable 1) -----------------
   `nav[data-internal-nav]` only exists while somebody is logged in, so the
   logged-out header cannot match any of this even after a logout leaves this
   stylesheet in the document. */
@media (max-width: 640px) {
  nav[data-internal-nav] {
    gap: 6px;
    flex-wrap: nowrap;
  }

  /* Map · About · Knowledge base · <username> move into the Menu sheet; the
     logo is the one link that stays. */
  nav[data-internal-nav] > a:not(.logo-link) {
    display: none;
  }

  nav[data-internal-nav] .logo-link {
    margin-right: 0;
  }

  /* One line, cut with an ellipsis rather than wrapped to three. */
  nav[data-internal-nav] .site-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 1.05rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The three icon buttons, pushed to the right edge as one toolbar. */
  nav[data-internal-nav] .search-trigger {
    margin-left: auto;
  }

  nav[data-internal-nav] .search-trigger,
  nav[data-internal-nav] .help-trigger,
  nav[data-internal-nav] .nav-menu-btn {
    flex: 0 0 auto;
    justify-content: center;
    min-width: 44px;
    min-height: 44px;
    padding: 0;
    font-size: 17px;
  }
}
</style>
