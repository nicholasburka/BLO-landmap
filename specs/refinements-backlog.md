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
