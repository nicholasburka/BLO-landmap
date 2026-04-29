# Spec: Phase 4e — Surface Architecture Follow-ups

**Status:** Draft v0.1
**Author:** Nick / Claude
**Date:** 2026-04-29
**Phase:** 4e (Bucket B from the post-4d audit)

---

## Problem Statement

Three surface-architecture issues survived Phase 4c/4d. They're not breaking, but they undercut the design coherence the Lens introduced:

1. **S3 — Direct county click still opens a centered modal that covers the map.** The walkthrough rail solved this for tour mode, but a casual click on any county polygon still detonates the legacy CountyModal in the middle of the screen. The user just wanted to glance at one county; instead the map disappears.
2. **T1 — Opening "View full details" from the rail breaks the spotlight context.** Once the modal opens, the rail hides (mutually exclusive surfaces), so the active-county outline + spotlight + numbered marker all visually disappear. Closing the modal restores them, but the user lost the spatial tether.
3. **A3 — Place suggestions resolve to cities instead of counties.** Picking "Charlotte" from the place strip drops a Mapbox marker on Charlotte the city — but BLO's data is county-level. The user is now staring at street tiles with no county outline, no score for Mecklenburg County, no path to "what's this place's livability score?"

These are linked: all three describe the surface that *should* appear when the user wants to inspect a single county. Today that surface is the centered modal. The Lens architecture says the data-state surface lives bottom-left. We need a parallel idea for *single-county inspection* that respects the same map-stays-visible principle.

---

## Success Criteria

- [ ] Clicking any county opens an **inspection rail** on the right side of the map (the same slot the walkthrough rail uses), not a centered modal. The map stays visible underneath.
- [ ] The inspection rail shows the same content the walkthrough rail does for a single county (rank context + score + relevant stats + "View full details ▸"), but with no walkthrough nav (no Prev/Next).
- [ ] Picking a place suggestion (e.g., "Charlotte") that resolves to a known county auto-zooms to a regional view of that county AND opens the inspection rail with that county's data — same surface as direct click.
- [ ] During walkthrough, "View full details ▸" no longer hides the rail. The full modal opens as a *floating layer* over the map but the walkthrough rail and spotlight outline stay visible behind/beside it. Closing the modal restores normal walkthrough.
- [ ] The centered CountyModal is reduced to an opt-in "Full details" layer reachable from any rail. No code path opens it as the *primary* response to a click.
- [ ] On mobile, the inspection rail behaves like the walkthrough rail does today: bottom-anchored peek/drawer, no overlap with the Lens.

---

## Solution Overview

Three changes, each individually small but coordinated:

### 1. Generalize the rail

The current `WalkthroughRail.vue` is hard-coded to walkthrough state. Refactor it into `CountyRail.vue` with two modes:

- **`mode: "inspect"`** — single county, no nav buttons, has a "Close" affordance. Used by direct click and place selection.
- **`mode: "walk"`** — current behavior with rank, prev/next, exit. Used by tour.

The visual treatment is nearly identical between modes. Only the bottom row of the rail changes (Close vs. Prev/Next/Exit) and the "rank N of M" header morphs into "single county" header.

### 2. Direct-click and place-pick route through the rail

`Map.vue`'s click handler currently calls `openCountyModalById`, which sets `showDetailedPopup = true`. New flow:

```ts
function inspectCounty(geoId: string): void {
  currentCounty.value = { id: geoId, name: getCountyName(geoId) }
  inspectActive.value = true
  zoomToGeoId(geoId, { regional: true })
}
```

This sets a new `inspectActive` ref. The rail mounts `v-if="inspectActive || walkthroughActive"`. The full modal stays available behind a "View full details" button inside the rail.

Place selection (`handlePlaceSelection`) is upgraded to:
- Try to resolve the Mapbox feature to a county GEOID first (via Mapbox `district` type or a centroid-to-county spatial lookup against `countiesData`)
- If resolved → call `inspectCounty(geoId)` and the rail opens
- If not → fall back to the current generic flyTo + marker

### 3. Modal becomes a peer-overlay during walkthrough

Today, when the walkthrough rail is active and the user opens "View full details", the rail hides via `v-if="walkthroughActive && !showDetailedPopup"`. We change that so the modal appears as a *card overlapping the map* but the rail and the spotlight outline stay rendered. The modal should:

- Anchor to the *center-left* of the available map area (not perfectly centered — leaves room for the rail at right)
- Be dismissible with X or Esc
- Inherit the rail's currentCounty data (single source of truth)

This eliminates the rail-vanishes-on-View-full-details behavior. The modal becomes a true peer overlay rather than a replacement.

---

## Detailed Requirements

### Functional

**Inspection mode (S3)**
1. Clicking any county polygon on the choropleth shall set `inspectActive = true` and open the rail in inspect mode.
2. The rail in inspect mode shall display: county name, state, BLO Livability Index score, 3-5 relevant stats (preferring active scoring layers if any, else default snapshot), "View full details ▸" button, and a "Close" affordance.
3. Clicking close (or pressing Esc) shall set `inspectActive = false` and clear `currentCounty`.
4. Clicking another county while inspect mode is open shall replace the rail content (no flash, no modal).
5. The map shall pan-and-zoom to a regional view of the clicked county (`regional: true`, maxZoom 7) — same camera behavior as walkthrough steps.

**Place → county resolution (A3)**
6. When the user picks a place suggestion, the system shall attempt county resolution:
   - If the Mapbox feature has `place_type: ["district"]` AND a US state context, treat as a county; map to GEOID via name+state lookup against `countiesData`.
   - Otherwise (city, region, etc.), find the county containing the feature's `center` coords using a point-in-polygon lookup over `countiesData.features`.
7. On successful resolution, call `inspectCounty(geoId)` — opens the rail in inspect mode.
8. On failed resolution, fall back to the current behavior: `flyTo(center, zoom: 10)` + place marker. The rail does not open.

**Walkthrough + modal coexistence (T1)**
9. The walkthrough rail's "View full details" button shall NOT hide the rail. It shall set `showDetailedPopup = true` while leaving `walkthroughActive = true`.
10. The CountyModal shall render as a center-left card overlapping the map but NOT covering the rail (right side) or the Lens (bottom-left).
11. The walkthrough spotlight outline + numbered markers shall remain visible while the modal is open.
12. Closing the modal (X or Esc) shall restore the rail-only walkthrough view; walkthrough state preserved.

**Single-source-of-truth**
13. The CountyModal shall consume `currentCounty` and read all data through the same selectors used by the rail. No duplicate state.

### Non-Functional

- **Performance:** Rail open/close <100ms. Click-to-rail latency <50ms.
- **Accessibility:** Inspect-mode rail must trap-focus when keyboard-focused; Esc must close. Click outside the rail (on the map) must NOT close — the user is intentionally clicking another county.
- **Backwards compatibility:** External CountyModal callers (LLM tool `show_county_details`, ranking-panel row click) keep working — they now open the inspection rail instead of the centered modal. Modal-as-modal is gone except as opt-in detail view.

---

## System Context

### Components

| Component | Change |
|---|---|
| `WalkthroughRail.vue` | Renamed `CountyRail.vue`; gains `mode` prop. |
| `Map.vue` | New `inspectActive` ref; `inspectCounty` function; click handler routes through it; place selection routes through it. CountyModal mounting becomes an overlay with new positioning. |
| `CountyModal.vue` | Repositioned to center-left when walkthrough is active; otherwise center as today. |
| `mapTools.ts` | `show_county_details` LLM tool routes to `inspectCounty`. |

### Dependencies

- Existing `countiesData` GeoJSON (already loaded) — used for point-in-polygon resolution.
- Mapbox geocoding API (already used) — features with `place_type: ["district"]` map to counties.
- `currentCounty` ref + `getCountyName` (existing) — unchanged.

### Affected Behavior

- The centered CountyModal becomes opt-in only.
- Place lookup gains county awareness.
- Walkthrough flow becomes additive: rail + spotlight + modal can all coexist.

---

## Constraints & Boundaries

### In Scope

- Refactoring WalkthroughRail.vue → CountyRail.vue with `mode` prop.
- New `inspectActive` ref + `inspectCounty` flow.
- Click and place-pick route through inspect mode.
- Modal repositioning when walkthrough is active.
- Point-in-polygon county resolution for place lookups.

### Out of Scope

- **Multi-county inspect** (selecting 2+ counties to compare). Future feature.
- **Saving inspect to chat history.** Inspect is ephemeral.
- **Editing CountyModal's content.** Same data, same layout — just a different surface.
- **Place lookup performance optimizations** (spatial index). Linear point-in-polygon over 3144 county polygons is fine for v1.

### Assumptions

- The walkthrough rail's content layout works for inspect mode with minor tweaks (no Prev/Next, optional "Close").
- A clicked county should always behave the same way regardless of whether a query is active. (Open question — see below.)
- The Mapbox geocoder returns `district` type for US counties when types include `district`.

### Technical Constraints

- Vue 3 Composition API, no new dependencies.
- Point-in-polygon implementation is O(N×M) — N polygons, M points per polygon. Acceptable for one-time queries.

---

## Examples

### Example 1: Direct click on a county
**Given:** No active query; user is browsing the BLO Livability Index choropleth.
**When:** User clicks Mecklenburg County, NC.
**Then:**
- Rail slides in from the right with: "Mecklenburg County, North Carolina", BLO Index score, 5 relevant stats, "View full details ▸", Close.
- Map pan-and-zooms to a regional view of Mecklenburg County.
- Lens at bottom-left is unchanged (still showing default Legend).

### Example 2: Click another county while one is open
**Given:** Inspect rail is showing Mecklenburg County.
**When:** User clicks Wake County, NC.
**Then:**
- Rail content updates to Wake County (no flash, smooth content swap).
- Map pan-and-zooms to a regional view of Wake County.

### Example 3: Place lookup resolves to county
**Given:** User types "Mecklenburg" and selects "Mecklenburg County, North Carolina".
**When:** Resolution succeeds.
**Then:**
- Rail opens in inspect mode with Mecklenburg's data.
- Map pan-and-zooms to regional view of Mecklenburg.

### Example 4: Place lookup resolves a city to its county
**Given:** User types "Charlotte" and selects "Charlotte, North Carolina".
**When:** Resolution succeeds via point-in-polygon (Charlotte's center → Mecklenburg County).
**Then:**
- Rail opens in inspect mode with Mecklenburg's data.
- Map pan-and-zooms to regional view.
- The previously-dropped place marker becomes a smaller pin (or is replaced with the inspect-mode outline + nothing).

### Example 5: Place lookup falls back
**Given:** User types "Yellowstone" and selects "Yellowstone National Park".
**When:** Resolution can't map to a single county (the park spans 3).
**Then:**
- No rail opens.
- Map flies to the place + marker drops (current behavior).

### Example 6: Walkthrough → View full details
**Given:** Walkthrough is at step 2 of 5 (Wyandotte County, KS); rail is showing.
**When:** User clicks "View full details ▸".
**Then:**
- CountyModal opens as a center-left card.
- Walkthrough rail stays visible on the right.
- Spotlight outline + "2" marker on Wyandotte stay visible.

### Example 7: Modal close during walkthrough
**Given:** As above, modal is open.
**When:** User clicks X (or Esc).
**Then:**
- Modal closes.
- Rail and spotlight unchanged.

### Example 8: LLM tool `show_county_details`
**Given:** Chat: "Tell me about Mecklenburg County".
**When:** LLM invokes `show_county_details`.
**Then:**
- Inspect rail opens (NOT the centered modal).
- Map pan-and-zooms to regional view.

---

## Decisions Locked

- Inspect mode and walkthrough mode share one component (`CountyRail.vue`), with a `mode` prop selecting nav controls.
- Place→county resolution uses point-in-polygon as the fallback; Mapbox `district` type as the fast path.
- Modal repositions to center-left when `walkthroughActive` is true. Otherwise unchanged.
- Single source of truth: rail and modal both read `currentCounty`.

---

## Open Questions

- [ ] **Should clicking a county also open the inspect rail when a walkthrough is active?** It would reuse the same surface. But mid-walkthrough, the user clicking a county might mean "advance to that county in the tour" or "switch to inspect that one" — ambiguous. **Recommendation:** during walkthrough, county click is a no-op (or briefly highlights the county) so the user can't accidentally derail the tour. Add a "Stop tour" affordance if they want to switch out.
- [ ] **What if the rail is open and the user runs a new query?** Today, `handleQueryResult` exits walkthrough. Should it also close inspect? **Recommendation:** yes — new query is a new context, close inspect.
- [ ] **Mobile inspect-rail:** same bottom-drawer pattern as walkthrough? **Recommendation:** yes, identical treatment.
- [ ] **Do we keep the Mapbox marker pin when inspect resolves to a county?** It's redundant with the active-county outline. **Recommendation:** drop the marker when inspect mode opens; keep it for failed-resolution fallback.

---

## Tickets sketch (to be split out)

- E1: Refactor WalkthroughRail → CountyRail with `mode` prop.
- E2: New `inspectActive` state + `inspectCounty` function in Map.vue.
- E3: Wire county-polygon click → `inspectCounty`.
- E4: Wire place-pick → county resolution → `inspectCounty`.
- E5: Modal repositions to center-left when walkthrough is active.
- E6: Walkthrough "View full details" no longer hides the rail.
- E7: LLM tool `show_county_details` routes to `inspectCounty`.
- E8: E2E verification on desktop + mobile.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-29 | Nick / Claude | Initial draft |
