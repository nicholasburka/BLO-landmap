# Spec: Phase 4f — Onboarding & Polish

**Status:** Draft v0.1
**Author:** Nick / Claude
**Date:** 2026-04-29
**Phase:** 4f (Bucket C from the post-4d audit)

---

## Problem Statement

The hard architecture is right. What's left are the small frictions a first-time user hits in the first 30 seconds:

1. **D5 — No introduction to BLO Livability Index.** The default landing shows a colored map labeled "BLO Livability Index" with no explanation of what it measures. The Context tab has the national snapshot, but the user has to find it.
2. **A1 — Mobile chip overflow.** When the active query has 2+ scoring layers, chips wrap or truncate awkwardly in the Lens drawer's peek state. "Median H..." is unreadable.
3. **A2 — Mapbox marker clashes with BLO palette.** Picking a place drops a default blue Mapbox pin. It feels like an artifact, not a designed element.
4. **A4 — Layers tab content overflows with no scroll affordance.** On a 540px-tall Lens, the full category list exceeds the visible area. macOS auto-hides scrollbars, leaving no "more below" hint.
5. **D6 — No hover affordance on the choropleth.** Counties are interactive (click → inspect rail in Phase 4e) but a new user has no visual cue. No cursor change, no hover outline, no tooltip.

None of these block flows. All of them tax the user's attention on each session.

---

## Success Criteria

- [ ] A first-time visitor sees a brief explanation of "BLO Livability Index" without dismissing a popup or visiting a separate About page.
- [ ] Active-query chips on mobile peek state never truncate the layer name. They scroll horizontally if needed, or collapse gracefully into a "+N more" pill.
- [ ] When a place is dropped on the map, the marker uses the BLO palette (cream + ink, or a small orange dot for "selected place"). No bright Mapbox blue.
- [ ] When the Layers tab has more content than fits, a subtle scroll cue (top/bottom fade gradient or a "more below" caption) makes the overflow visible.
- [ ] Hovering a county on the choropleth shows a cursor change AND a thin temporary outline so the user knows the polygon is interactive.

---

## Solution Overview

Five small, independent improvements:

1. **About-the-Index card** — A compact, dismissible card at the bottom-left (above the Lens) that introduces the BLO Livability Index in one sentence, with a link to the About page. Persists per-session via localStorage; once dismissed, doesn't return until next visit.

2. **Mobile chip overflow** — Make the chips row scroll horizontally on `overflow-x: auto`, with momentum scroll. Add a small fade-mask on the right edge to hint at more content.

3. **Themed map markers** — Replace `new mapboxgl.Marker()` with a small custom DOM element (cream filled, ink border, BLO orange accent) for selected places. Use the same marker template as walkthrough rank chips for visual consistency.

4. **Lens scroll affordances** — Add `:before` and `:after` pseudo-elements to the Lens body that fade in when content is scrollable above/below. Pure CSS, no JS.

5. **Choropleth hover** — Mapbox's `mousemove` already fires; add a thin highlight outline layer (`line` type, 1px, ink-soft) bound to a hover-feature-id state. Toggle cursor to `pointer` on hover.

---

## Detailed Requirements

### Functional

**About-the-Index card (D5)**
1. On first visit (no localStorage key `blo:welcomeDismissed`), render a compact welcome card at viewport position bottom-left, above the Lens.
2. Card content: "🟢 Welcome — this map shows the **BLO Livability Index**, a composite score (1–5) combining demographics, racial equity, economics, housing, environment, and health for every US county. Click any county to inspect, or ask the AI for a custom view." + a small "Got it" button.
3. Clicking "Got it" sets `localStorage.blo:welcomeDismissed = '1'` and removes the card.
4. The card never returns within the same browser unless localStorage is cleared.
5. Card position: 16 px above the Lens; max-width 360 px; never overlaps with chat history.

**Chip overflow (A1)**
6. The Lens header chips row (`.lens-hd-chips`) shall use `flex-wrap: nowrap; overflow-x: auto` on mobile (≤ 768 px). 
7. A `mask-image` linear-gradient on the right edge shall fade the last ~20px to suggest more content.
8. Touch-scroll enabled via `-webkit-overflow-scrolling: touch`.
9. Chips never truncate text — full layer name always visible when scrolled to.

**Themed marker (A2)**
10. Replace `new mapboxgl.Marker().setLngLat(coords)` (in `handleGeocoderResult`) with a custom-element marker:
    ```
    <div class="blo-place-marker">
      <div class="blo-place-marker-dot"></div>
      <div class="blo-place-marker-pulse"></div>
    </div>
    ```
11. Styling: 14×14 cream circle with 1.5px ink border, optional 24×24 BLO-orange pulse ring (animated, fades out after 600ms).
12. Marker is created via `new mapboxgl.Marker({ element })` so Mapbox's positioning logic still applies.

**Scroll affordances (A4)**
13. The Lens `.lens-body` element shall include `:before` and `:after` pseudo-elements that render fade-gradients (~24px tall, cream→transparent) at the top and bottom edges respectively.
14. The fades are visible only when content is actually scrollable in that direction. Implementation: track `scrollTop` and `scrollHeight - clientHeight` and toggle classes `lens-body--scroll-up` / `lens-body--scroll-down`.
15. Scroll affordances active in all three tabs whenever content overflows.

**Choropleth hover (D6)**
16. On `mouseenter` of a county polygon, change cursor to `pointer`.
17. Add a `county-hover-outline` line layer at the top of the layer stack (above active outline + set outline + fill).
18. Filter to `["==", ["get", "GEOID"], hoveredGeoId]`; default to `__none__` when no hover.
19. Visual: 1.5px ink line, opacity 0.6.
20. Fires only when `inspectActive === false` AND `walkthroughActive === false` (don't compete with active-county outline during those flows).

### Non-Functional

- **Performance:** Hover handler must not cause re-renders >60fps. Mapbox state-based hover is preferred over manual filter swapping if profiler shows lag.
- **Accessibility:** The welcome card must be keyboard-dismissible (Esc or Tab→Enter on Got-it button). Hover affordance is purely visual; equivalent keyboard hint is offered via county tabbing in a future phase.
- **Persistence:** Welcome card uses `localStorage`. Failed access (private browsing) silently no-ops; card always shows.

---

## System Context

### Components

| Component | Change |
|---|---|
| `WelcomeCard.vue` | NEW — compact one-time intro card. |
| `Map.vue` | Mounts WelcomeCard, adds hover layer + state, replaces Mapbox marker construction. |
| `Lens.vue` | Adds scroll-affordance classes via `@scroll` listener. |
| `LensHeader.vue` | Mobile chips row gets overflow-x scroll + fade mask. |

### Affected Behavior

- First-load gains a welcome card (one-time per browser).
- Place markers visually unify with the BLO design system.
- Map polygons gain a hover affordance.

---

## Constraints & Boundaries

### In Scope

- Welcome card with localStorage dismissal.
- Mobile chip horizontal scroll.
- Themed place markers.
- Lens scroll-fade affordances.
- Choropleth hover cursor + outline.

### Out of Scope

- **Multi-step onboarding** (tour, tutorials). One card, one dismiss.
- **Customizable welcome content** per user — single static copy.
- **Animated county-pulse on first hover** — possible future delight; not required.
- **Tooltip on hover** — replaced by the inspect rail (Phase 4e). Hover only changes cursor + outline.
- **Saved preferences server-side.** localStorage only.

### Assumptions

- localStorage is available in 95%+ of browsers; the welcome card is recoverable in private mode (just shows again).
- Mapbox marker accepts a custom HTMLElement via `{ element }`.
- The choropleth fill layer can support a hover-state via Mapbox feature-state OR via filter expression on a separate line layer.

### Technical Constraints

- No new dependencies.
- No SVG sprites — all custom markers are CSS / DOM.

---

## Examples

### Example 1: First visit
**Given:** No `localStorage.blo:welcomeDismissed`.
**When:** Page loads.
**Then:**
- Welcome card appears at bottom-left, above the Lens.
- Card explains BLO Livability Index in one sentence.
- "Got it" button visible.

### Example 2: Dismissal
**Given:** Welcome card is visible.
**When:** User clicks "Got it".
**Then:**
- Card animates out.
- `localStorage.blo:welcomeDismissed = '1'`.
- Future visits in this browser don't show the card.

### Example 3: Mobile chips with 4 layers
**Given:** Active query has 4 scoring layers + Top 5 + 1 filter.
**When:** Lens drawer is in peek state on mobile.
**Then:**
- All chips render in a single horizontal scrollable row.
- Right edge fades to suggest more content.
- User scrolls to see all chips; no truncation.

### Example 4: Themed marker on place pick
**Given:** User selects "Charlotte, NC" from the place strip (Phase 4e: also opens inspect rail).
**When:** Marker drops.
**Then:**
- A cream-with-ink-border 14px circle appears at the location, with a brief 600ms BLO-orange pulse ring.
- No bright blue Mapbox default.

### Example 5: Layers tab scroll affordance
**Given:** Layers tab expanded; content exceeds Lens body height.
**When:** User looks at the tab.
**Then:**
- Bottom edge of `.lens-body` shows a subtle cream→transparent fade.
- After scrolling down, top edge gains the same fade; bottom fade may persist or disappear based on remaining content.

### Example 6: Hover a county
**Given:** No active query, no walkthrough.
**When:** User mouses over Mecklenburg County.
**Then:**
- Cursor becomes `pointer`.
- A 1.5px ink outline appears around Mecklenburg's polygon.
- Mousing off → cursor returns to default, outline removes.

### Example 7: Hover during walkthrough
**Given:** Walkthrough active; user mouses over a non-active top-N county.
**When:** Hover fires.
**Then:**
- Cursor stays default (county click is a no-op during walkthrough per Phase 4e).
- No hover outline (would compete with active-county and set outlines).

### Example 8: Hover during inspect
**Given:** Inspect rail open on County A.
**When:** User mouses over County B.
**Then:**
- Cursor becomes `pointer` — clicking will switch inspect to County B.
- Hover outline appears on County B.

---

## Decisions Locked

- One-time welcome card, localStorage-dismissed, no recurring tour.
- Mobile chips: horizontal scroll, no truncation.
- Place markers: custom DOM, BLO palette.
- Scroll affordances via CSS pseudo-elements + JS-toggled classes.
- Hover: cursor + outline only, no tooltip.

---

## Open Questions

- [ ] **Welcome card copy** — Final wording needs review. Proposed copy in req 2 is a starting point.
- [ ] **Should the welcome card link to the About page?** Adds discoverability for documentation. **Recommendation:** yes, small "Learn more" link inline.
- [ ] **Hover during empty state (no active query)** — Should hovering a county show a mini score in the cursor area? **Recommendation:** defer; the inspect rail on click is enough for v1.
- [ ] **What if the Mapbox marker is positioned over the active-county outline?** Stacking order — the marker should sit ABOVE the outline so it stays visible. Verify in implementation.
- [ ] **Performance of point-in-polygon on hover** — Tests show it's fine for click (one query), but if hover fires for every mousemove, we need throttling. Recommend `requestAnimationFrame` throttling for hover state updates.

---

## Tickets sketch (to be split out)

- F1: WelcomeCard component + Map mounting + localStorage handling.
- F2: Mobile chip overflow scroll + fade mask.
- F3: Themed place marker — replace Mapbox default.
- F4: Lens body scroll-affordance fade pseudo-elements + scroll-position class toggling.
- F5: Choropleth hover layer + cursor toggle.
- F6: E2E verification.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-29 | Nick / Claude | Initial draft |
