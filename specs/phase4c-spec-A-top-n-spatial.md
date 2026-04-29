# Spec: Top-N Spatial Signal + Walkthrough Spotlight

**Status:** Draft
**Author:** Nick / Claude
**Date:** 2026-04-28
**Phase:** 4c

---

## Problem Statement

When a user asks for "top N counties for X", the choropleth recolors all 3144 counties on a gradient. The "top 5" appear in the ranking panel and are walkable in the rail, but on the map itself they look identical to the 3139 counties below them — same color band, same outline, same weight. The map fails to honor the user's expressed intent: they asked for *5*, the panel shows *5*, but the map still shows *all*.

During walkthrough, the same problem repeats at the per-step level: the user clicks Next and the map pans to a new county, but that county is visually indistinguishable from the four other top-N counties around it. There is no spatial cue for "this is the one you're reading about right now."

The data resolution does not reward zooming tighter to compensate (Path A already capped walkthrough zoom at 7). The only remaining lever is *what gets emphasized on the map itself*.

---

## Success Criteria

We'll know this works when:

- [ ] When `activeLimit` is non-null and there is ≥1 scoring layer, only the top-N counties render in full chromatic intensity; counties ranked N+1 and below are dimmed to a clearly subordinate visual weight while remaining identifiable.
- [ ] On `startWalkthrough`, the map auto-fits its viewport to the union of all top-N county bounds (with padding) so the user sees the geographic distribution of the answer before stepping into it.
- [ ] On each walkthrough step, the active county is rendered with a thick distinguishing outline AND a numbered marker pinned at its centroid; the other top-N counties have a lighter "set marker" outline so they read as a cohort.
- [ ] Exiting walkthrough clears outlines and markers but **preserves** the top-N choropleth emphasis (limit is still active in the query, even when the user isn't actively walking through).
- [ ] `clearActiveQuery` (the strip's × button) restores the full default choropleth — no dimming, no outlines, no markers.
- [ ] Non-top-N counties remain hoverable and clickable so users can explore "why isn't X in the top-N" — dimming is visual de-emphasis, not interaction lock-out.

---

## Solution Overview

Three coordinated layers of visual signal, all driven off existing reactive state:

1. **Choropleth dimming**: When `activeLimit` is set, the existing match expression for fill color blends top-N counties at full saturation while the rest get a desaturated/translucent treatment. This is a small change to `updateChoroplethColors`.
2. **Auto-fit on walkthrough entry**: `startWalkthrough` first computes the union bounds of all `limitedRankedCounties` and `fitBounds` to that envelope before stepping to county 1.
3. **Spotlight overlay during walkthrough**: Two new Mapbox layers: a "top-N set" outline (medium weight, ink-soft) drawn over all `limitedRankedCounties`, and an "active county" outline (heavy weight, ink) drawn over the current walkthrough geo. Plus DOM markers (numbered chips) anchored at each county centroid via `mapboxgl.Marker`.

---

## Detailed Requirements

### Functional Requirements

**Choropleth dimming**

1. The system shall compute a `topNGeoIds: Set<string>` from `limitedRankedCounties` whenever `activeLimit` and ranked counties change.
2. When `topNGeoIds.size > 0`, the choropleth fill expression shall produce full-saturation colors only for counties in the set; counties outside the set shall render at reduced alpha (target: 0.35) over a desaturated base, so the gradient is still legible but visually subordinate.
3. When `topNGeoIds.size === 0`, the choropleth shall behave exactly as today (no dimming).
4. Counties already filtered out by threshold filters (`filteredOutCountyIds`) shall continue to render in their existing muted-grey state — the new dimming is an additional layer applied only to "passed-but-not-top-N" counties.

**Walkthrough auto-fit**

5. On `startWalkthrough`, before opening county 1, the system shall compute the bounding box of all `limitedRankedCounties` (union of polygon bounds) and call `map.fitBounds` with padding ≥ 80px on all sides and a 700ms animation.
6. If `limitedRankedCounties.length === 1`, auto-fit shall fall back to the standard regional zoom for that single county (existing `zoomToGeoId(geoId, { regional: true })` behavior).
7. After auto-fit completes, the standard step-into-county-1 flow runs (regional pan-and-zoom to county 1).

**Spotlight outline**

8. While `walkthroughActive` is true, a "top-N set outline" layer shall render over all `topNGeoIds` with line color `var(--blo-ink-soft, #2a2a2a)` and line-width 1.2.
9. While `walkthroughActive` is true, an "active county outline" layer shall render only over `currentCounty.id` with line color `var(--blo-ink, #111)` and line-width 2.5.
10. Both layers shall sit above the choropleth fill but below the existing hover/click interaction layers so they don't block input.
11. Both layers shall be removed (or hidden via filter) when `walkthroughActive` becomes false.

**Numbered markers**

12. While `walkthroughActive` is true, each county in `limitedRankedCounties` shall display a small numbered chip (`1`, `2`, …) anchored at its polygon centroid via `mapboxgl.Marker`.
13. The chip for the active county shall use a primary visual treatment (filled green-deep background, white number, scale 1.15× larger).
14. Chips for non-active top-N counties shall use a secondary treatment (cream background, ink number, smaller).
15. All markers shall be removed when `walkthroughActive` becomes false.

### Non-Functional Requirements

- **Performance:** Dim recomputation must be O(N) per query change (N ≤ 3144). Marker creation/teardown must be O(top-N) where top-N ≤ 50. No frame drops on `flyTo` between steps.
- **Reliability:** All overlay layers must clean up on component unmount. Marker DOM nodes must not leak across walkthrough sessions.
- **Accessibility:** Numbered marker chips must have `aria-label` like "Rank 2: Scott County, Illinois". Marker chips are decorative supplements — keyboard users still navigate via the rail's prev/next buttons.

---

## System Context

### How It Fits

- **Map.vue** owns the state (`activeLimit`, `limitedRankedCounties`, `walkthroughActive`, `currentCounty`) and the Mapbox map instance. All new rendering hooks fit inside Map.vue's existing lifecycle.
- **`updateChoroplethColors`** already builds a Mapbox match expression — extending it to know about `topNGeoIds` is additive.
- **`startWalkthrough`** already exists and is the natural insertion point for auto-fit before step-into-1.
- **WalkthroughRail.vue** is unaffected by this spec — it already reads `currentCounty` and rank.

### Dependencies

- Mapbox GL JS (already in use): `match` expressions, `LngLatBounds`, `fitBounds`, `Marker`.
- `limitedRankedCounties` computed (already present, gated by `activeLimit` slice).
- `personalizedScores` map (already present — for scoring).
- County polygon centroids — need to compute from `countiesData` GeoJSON (one-time per polygon, can be lazy-cached).

### Affected Systems

- Choropleth fill expression (extended)
- Mapbox layer stack (two new outline layers added)
- Mapbox marker pool (new — created/torn down with walkthrough state)
- `startWalkthrough` handler (auto-fit step added)
- `clearActiveQuery` handler (must also clear topNGeoIds-driven state — set of ids becomes empty automatically when limit clears)

---

## Constraints & Boundaries

### In Scope

- Dimming non-top-N counties when `activeLimit` is active.
- Auto-fit-bounds on walkthrough entry.
- Active-county outline + top-N set outline during walkthrough.
- Numbered marker chips for top-N during walkthrough.

### Out of Scope

- **Animated transitions between dimmed and undimmed states.** Initial implementation can be instant; smooth tween is a polish pass.
- **"Spotlight pulse" animation on the active county.** Static thick outline only; pulse is a stretch goal.
- **Auto-fit on every walkthrough step.** `flyTo` to regional zoom (already implemented in Path A) is sufficient per-step. Auto-fit is only on the *initial* entry to give big-picture context.
- **Hover states on top-N counties** (existing hover stays unchanged; no special "you're hovering an answer" affordance).
- **Zoom-out cap on auto-fit.** If top-N counties span Alaska and the East Coast, the map will zoom out to fit. Acceptable — that's the geographic answer.
- **Mobile-specific layout for markers.** Markers will appear identically on mobile; if visual density is a problem we can revisit, but the marker count is bounded by `limit` (≤ 50, typically ≤ 10).
- **Persistence across page reload.** Walkthrough state is session-only (already true).

### Assumptions

- `countiesData` GeoJSON is loaded by the time walkthrough starts (it's already a hard dependency).
- Mapbox `fitBounds` behaves correctly for non-contiguous polygons (it does — it builds a bounding rect).
- `mapboxgl.Marker` performance is acceptable at N ≤ 50 markers (it is — we tested in earlier phases).

### Technical Constraints

- Must use Mapbox GL JS (already in use) — no swap to alternative renderers.
- Choropleth fill stays a single layer with a `match` expression — no fork into multiple layers per state.
- Outline layers must respect z-order: fill < top-N outline < active outline < hover/click layers.

---

## Examples

### Example 1: Happy Path — Query
**Given:** User has just submitted "top 5 counties for Black homeownership" via the Ask input.
**When:** The LLM returns and `handleQueryResult` runs (`activeLimit = 5`, `layers = [homeownership_by_race]`).
**Then:**
- The 5 top-ranked counties render at full red→green gradient saturation.
- The other 2,251 counties (post-filter, non-top-5) render at ~35% alpha — the gradient is still readable but clearly de-emphasized.
- The 888 counties filtered out by missing data continue to render in their existing muted-grey state.
- Hover tooltip works on every county regardless of dim state.

### Example 2: Happy Path — Walkthrough Entry
**Given:** Top-5 query is active; user clicks "Walk through" in the ranking panel.
**When:** `startWalkthrough` runs.
**Then:**
- Map first `fitBounds` to encompass all 5 counties (if they're spread across GA-IL-IN, the view zooms to roughly the eastern half of the country).
- After 700ms, the rail opens at "1 of 5" and the map `flyTo`s county 1 at regional zoom (≤ zoom 7).
- On the map: 5 numbered marker chips visible, "1" is active (green-deep + white), 2-5 are secondary (cream + ink).
- Active county (county 1) has thick ink outline; counties 2-5 have lighter ink-soft outlines.

### Example 3: Walkthrough Step
**Given:** Walkthrough is at step 1 of 5.
**When:** User clicks Next.
**Then:**
- Map smoothly `flyTo`s county 2 at regional zoom.
- Marker "1" demotes to secondary treatment; marker "2" promotes to primary.
- Active outline moves from county 1 to county 2.
- Top-N set outline is unchanged (still on all 5).
- Rail content updates to county 2's name + score + stats.

### Example 4: Edge Case — Single-County Result
**Given:** User asks "best 1 county for X" (or filters narrow result to a single passing county).
**When:** Walkthrough starts.
**Then:**
- Auto-fit-bounds falls back to regional zoom on that single county.
- One marker rendered, primary treatment.
- Active outline = top-N outline (overlap is acceptable; visually identical to a regular spotlight).
- Rail shows "1 of 1" with prev/next disabled.

### Example 5: Edge Case — Wide Geographic Spread
**Given:** Top-N query returns counties spanning Alaska, Hawaii, and the contiguous US.
**When:** Walkthrough starts → auto-fit-bounds.
**Then:**
- Map zooms out to a hemispheric view that contains all polygons.
- This is acceptable — it accurately reflects "your answer is geographically dispersed".
- After auto-fit, step 1 still flies to regional zoom on county 1 individually, so the user gets context-then-focus.

### Example 6: Failure Case — `currentCounty` Mid-Step Glitch
**Given:** Walkthrough is active; the user rapidly clicks Next/Prev several times.
**When:** `currentCounty` updates faster than `flyTo` can complete.
**Then:**
- The active outline must always reflect the *current* `currentCounty.id`, not the in-flight one.
- Mapbox layer filter updates are synchronous to the state change; only the `flyTo` is async.
- Markers should not duplicate or leak across the rapid step changes.

### Example 7: Exit Walkthrough
**Given:** Walkthrough is active at step 3 of 5.
**When:** User clicks rail Exit (or presses Esc).
**Then:**
- All markers removed, both outline layers removed/hidden.
- Map view stays where it is (regional zoom on county 3) — does not snap back.
- Choropleth dim state remains active (top-N still emphasized) because `activeLimit` is still 5.
- Rail closes.

### Example 8: Clear Active Query
**Given:** Top-5 query active, walkthrough not active.
**When:** User clicks the "×" on the active-query strip (or chat clears via tool/explicit clear).
**Then:**
- `activeLimit` becomes null, `topNGeoIds` becomes empty.
- Choropleth restores to full default coloring (no dimming).
- All counties render at standard saturation.
- (No outlines/markers existed in this case, so nothing to remove there.)

---

## Decisions Locked

- **Dim treatment**: 35% alpha on the existing fill expression (no desaturation) for v1. Re-evaluate live; add HSL desaturation only if alpha alone reads as "translucent" rather than "subordinate."
- **Marker style**: Filled numbered chips. Active = filled green-deep with white number; inactive top-N = cream with ink number. Reinforces the ordering and pairs with the rail's rank badge.
- **Marker click behavior**: Deferred to v2. Markers are visual signal only; navigation stays via rail prev/next + arrow keys.
- **Auto-fit transition**: 1000ms duration on the entry auto-fit (it's a bigger move than a step), then 700ms on per-step `flyTo` (matches Path A).
- **New query mid-walkthrough**: `handleQueryResult` shall auto-exit walkthrough before applying the new query — clears outlines/markers, closes the rail, and lets the user re-enter walkthrough from the new ranking.
- **Marker performance**: Use `mapboxgl.Marker` (DOM-anchored) for v1. Limit is clamped to 50 server-side; 50 DOM markers is comfortably within budget. Revisit only if profiler shows frame drops.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-28 | Nick / Claude | Initial draft |
