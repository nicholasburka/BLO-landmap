# Refinements Backlog

Issues and improvements identified during Phase 1/2 implementation. Not yet ticketed — to be scoped and prioritized.

**Date:** 2026-04-02

---

## UX Issues

### 1. Property search from county interaction
Users should be able to search for properties in a county after hovering or clicking on it. Currently the property search is only accessible via the geocoder search bar. Need a "Search properties here" action in the county tooltip or modal.

### 2. County modal overlaps/underlaps other UI elements
The CountyModal component has z-index and positioning issues — it can appear behind the layer controls or ranking panel, or overlap the prompt input. Needs a proper modal overlay with backdrop or fixed positioning that clears other elements.

### 3. Links resolve to localhost instead of external URLs
Some links in the UI (likely in tooltips, modal, or About page) render as relative paths (e.g., `localhost:5173/the_actual_link.com`) instead of absolute external URLs. Need to audit all `<a>` tags and ensure external links have `https://` prefix and `target="_blank"`.

### 4. LLM explanation should be collapsible/closeable
The Haiku explanation paragraph below the prompt input takes up significant screen real estate. Should be collapsible (click to collapse) or closeable (X button), with the ability to re-expand if needed. Maybe collapsed by default after the first few seconds.

### 5. "Clear all" button for active layers
When multiple layers are selected (especially after a prompt query populates 5+ layers), there's no quick way to reset. Need a "Clear all" button — either next to the prompt input, in the layer controls header, or both. Should clear all selected layers, weights, directions, and return to default BLO view (or empty state).

---

## Future Consideration

- Property search UX could integrate with the ranking panel — click a ranked county → see properties
- County modal could show the personalized score breakdown (which layers contributed what)
- Mobile layout needs attention — several panels hidden on mobile that should be accessible somehow

---

## Open Spec Stub — Data-Surface Coherence (Phase 4d candidate)

**Surfaced:** 2026-04-28 during Phase 4c spec design.

There is real redundancy and visual incoherence across the surfaces that describe "what data is being shown":

- **Data Layers panel** (top-right pill → expandable category list) — controls which layers are active.
- **Color Key** (bottom-left) — shows the legend for the currently active layer's gradient.
- **County Averages panel** (bottom-left, collapsed) — shows national averages for context.
- **Active-query status strip** (top, below Ask) — shows scoring chips, filter chips, limit chip.
- **Currently selected layers** are *also* implicitly visible inside the Data Layers panel (checked items) and inside the Color Key (the layer name labels in the legend), and inside the active-query strip (the scoring chips).

So a single piece of state — *the user's currently-active scoring* — is visualized in 3-4 places simultaneously, each with different fidelity and different controls. This adds up to: clutter, ambiguity about which surface to interact with, and visual incoherence.

A future spec should:
1. Inventory exactly what each surface shows and what controls each owns.
2. Identify the dedup opportunities (e.g., merge Color Key + Averages into a single "Legend & context" card).
3. Decide whether the Data Layers panel should remain a separate surface or fold into an expanded Color Key.
4. Decide where the active-query chips belong — in the strip (today), inside the legend, or absorbed into the rail when one is open.
5. Land on a coherent "data surface" architecture: ideally one canonical home for "what's shown", with disclosure rather than parallel surfaces.

This is **not yet specced**. Out of scope for Phase 4c. To revisit after A (top-N spatial) and B (unified input) ship and we can see how the panel constellation feels with the new walkthrough rail in place.

