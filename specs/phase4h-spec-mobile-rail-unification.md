# Spec: Mobile Rail Unification — fold rankings into CountyRail

**Status:** Draft
**Author:** Nick A.B. + Claude
**Date:** 2026-05-06
**Phase:** 4h (mobile only; desktop deferred)

---

## Problem Statement

On mobile, two surfaces compete for the same vertical real estate: `CountyRail` (inspect/walk/rank/listings) and `RankingPanel` (top-N ranked counties). Both can be open simultaneously. The rail already handles ranked content via its swap-in `rank` view, so the standalone `RankingPanel` is duplication that crowds the screen and forces the user to track two views of overlapping data.

---

## Success Criteria

We'll know this works when:

- [ ] On a mobile viewport (≤ 768px), `RankingPanel` is hidden and never renders.
- [ ] Issuing a chat query (or otherwise activating scoring) opens the rail to a new `rankings` view on mobile, even when no county has been inspected yet.
- [ ] When neither a scoring query nor an inspect target is active, the rail is hidden on mobile (no empty rail at the bottom of the screen).
- [ ] Tapping a county row in the rail's rankings view inspects that county (swaps to the existing `detail` view) — same UX as the existing `rank` swap-in list.
- [ ] The rail can be collapsed via the existing ▼ toggle while in rankings view; the bar shows the active query descriptor instead of a county name.
- [ ] No walk-through button is present anywhere on mobile.
- [ ] Desktop layout is unchanged. RankingPanel still renders > 768px exactly as before.

---

## Solution Overview

Add a fourth swap-in view to `CountyRail`: `rankings`. This is the unified rail's "what's currently ranked" surface, distinct from the existing `rank` view (which is "show all counties so I can see where THIS one ranks") in trigger but identical in core rendering. On mobile, hide `RankingPanel` entirely; auto-open the rail to the new `rankings` view whenever a scoring query becomes active and there's no inspect target. Drop walk-through, top-N, and filter-pill controls from the rail (LensHeader already surfaces filters; top-N is set by the LLM via `set_query_state.limit`).

---

## Detailed Requirements

### Functional Requirements

**Rail view machine:**

1. The system shall add `'rankings'` to the existing `view` union in `CountyRail.vue`: `'detail' | 'rank' | 'listings' | 'rankings'`.
2. The new `rankings` view shall render: a header eyebrow + active-query descriptor (mirroring LensHeader's "ACTIVE QUERY · <name>" content), the existing single-state dropdown filter, and a scrollable list of ranked counties. List rows reuse the existing `.rail-rank-row` styling and click-to-inspect handler.
3. The rail's `mode` prop accepts an additional value-equivalent state: when no county is inspected but a query is active, `mode` is effectively `'rankings'` — represented either by a new mode value or by a derived computed in the rail. Implementation choice: extend the prop or treat it as `mode: 'inspect'` with `view: 'rankings'` and `currentCounty: null`. The latter is the simpler path and is the chosen default.
4. Tapping a row in the rankings view shall emit `select-county` (existing emit) which Map.vue handles via `inspectCounty(geoId)` — this swaps the rail to `detail` view for that county. Tapping a row is identical to the rank-explorer flow.

**Rail visibility:**

5. The rail's parent-controlled `visible` prop shall be `true` on mobile when ANY of: walkthrough active, inspect active, OR a scoring query is active. (Today: walkthrough OR inspect.) On desktop: unchanged.
6. When the rail is visible solely because a query is active (no inspect, no walk), the rail's initial view shall be `'rankings'`.
7. When the user inspects a county (taps a row, taps a polygon on the map), the rail swaps to `'detail'` for that county.
8. Closing the rail via × clears the inspect target AND clears any chat-driven query state — same behavior as the existing close.

**RankingPanel mobile gate:**

9. `RankingPanel` shall not render at viewports ≤ 768px (CSS `display: none` or template `v-if`). All of its functionality is now reachable via the rail's rankings view.

**Drops (mobile, this phase):**

10. The walk-through button is removed from any UI surface that renders on mobile (RankingPanel itself is gone; LensHeader's was already removed in 4d).
11. The top-N selector and "show bottom" toggle from RankingPanel are NOT migrated into the rail. The LLM sets `limit` via `set_query_state`; the user can change it by re-querying.
12. The filter-pills row from RankingPanel is NOT migrated into the rail. LensHeader already shows the active-query descriptor and filter chips; duplicating in the rail adds noise.

### Non-Functional Requirements

- **Performance:** Rail view swaps remain ≤ one frame. The rankings list reuses existing virtualization patterns (none — the list is small after `limit`).
- **Backward compatibility:** Walk mode UI machinery in CountyRail (prev/next footer, `mode === 'walk'` template branches) stays in place. Without an entry point on mobile it never renders, but the code is untouched so a desktop revisit can re-enable it.
- **Accessibility:** Rail view changes preserve focus management; tapping a county row does not break tab order.

---

## System Context

### How It Fits

```
Map.vue
  ├─ CountyRail (mobile + desktop)
  │   ├─ view: 'detail'    ← inspect mode
  │   ├─ view: 'rank'      ← swap-in: where does THIS county rank
  │   ├─ view: 'listings'  ← swap-in: land for sale
  │   └─ view: 'rankings'  ← NEW: top-N ranked counties (default
  │                          when query active, no inspect)
  └─ RankingPanel (desktop only after this phase)
```

### Dependencies

- `src/components/CountyRail.vue` — adds `rankings` view, state dropdown migration
- `src/components/Map.vue` — extends `:visible` condition; emits already wired
- `src/components/RankingPanel.vue` — wraps in mobile-hide media query (or v-if on a `isMobile` ref)
- `src/components/LensHeader.vue` — unchanged

### Affected Systems

- **The new T1 `set_query_state` tool** — its `regionStates` already feeds the rankings panel's filter; the rail's rankings view reads the same source and shows the same set.
- **Phase 4g snapshots** — already capture `regionStates` and `limit`, so the rail's rankings view is a function of state already in the snapshot. No new snapshot fields needed.

---

## Constraints & Boundaries

### In Scope

- New `rankings` view in CountyRail with rows + state dropdown
- Auto-open rail to rankings view on mobile when a query is active and no county is inspected
- Hide RankingPanel on mobile
- Remove walk-through button entry points on mobile
- Empty-when-idle: rail hidden when nothing is active

### Out of Scope

- Desktop unification. RankingPanel continues to render on desktop with its existing controls. A future phase (4i?) extends this consolidation across viewports.
- Removing walk mode from the codebase. The state and template branches stay in place.
- Migrating top-N control. LLM sets it via `set_query_state.limit`; users change it by re-querying.
- Migrating filter pills. LensHeader covers them.
- New keyboard shortcuts.
- Changing how counties are scored or filtered.

### Assumptions

- The active-query state already lives in Map.vue refs (`scoringQuery`, `activeFilters`, `activeLimit`, `rankingRegionStates`). The rail can read these via existing prop wiring.
- Phase 4g is landed (atomic `set_query_state`, snapshots) so the rail and rankings draw from the same source of truth.
- Existing `start-walkthrough` emit from RankingPanel is the only walk entry point on mobile; removing the panel removes the entry point.

### Technical Constraints

- TypeScript strict, no new runtime dependencies.
- CSS-only mobile gating preferred over JS resize-listener; the @media query already used in `RankingPanel.vue` extends naturally.
- No regression in desktop behavior measured by existing screenshots.

---

## Examples

### Example 1: Happy Path — Query opens rail to rankings on mobile

**Given:** Mobile viewport. User is looking at the default BLO Livability map with no inspect, no query, no rail visible.

**When:** User submits "top 5 affordable counties in the Southeast" via the Ask input.

**Then:** The chat returns with a `set_query_state` tool call. The rankings panel does NOT appear (mobile-hidden). The CountyRail slides up at the bottom in `rankings` view, showing 5 county rows with the "ACTIVE QUERY · Affordable" descriptor at top and the state-dropdown filter ready to narrow further.

### Example 2: Tap a row → inspect a county

**Given:** Continuing from Example 1, the rail is open in rankings view showing 5 counties.

**When:** User taps the third row.

**Then:** The rail swaps to `detail` view for that county, showing the existing inspect content (score, stats, Find Land CTA, etc.). The map zooms regionally and highlights the county. Pressing the rail's × closes everything; pressing the existing "rank N of M →" link opens the rank-explorer view for "where does this county sit in the full list."

### Example 3: Empty State — Idle map, no rail

**Given:** Mobile viewport. App freshly loaded. No query has been submitted, no county has been inspected.

**When:** User lands on the page.

**Then:** The rail is not visible. The map is full-screen below the Ask input + Lens. (Same behavior as today, just confirming the new visibility rule doesn't accidentally pop the rail open on idle.)

### Example 4: Edge Case — Clear query while inspecting

**Given:** Mobile, rail in `detail` view for a county that was selected from the rankings view of an active query.

**When:** User clears the query (Lens "Clear ×").

**Then:** The query goes inactive. Inspect remains active (the user is still reading about that county), so the rail stays in `detail` view. Tapping the existing rank-N-of-M link opens the rank-explorer (now showing all 3,144 counties since no query/region filter applies).

### Example 5: Edge Case — Refresh while in rankings view

**Given:** Mobile, rail in rankings view from a 3-turn convo. User refreshes the browser.

**When:** App rehydrates from `blo:conversation`.

**Then:** Phase 4g snapshot replay restores `scoringQuery`, `activeFilters`, `activeLimit`, `regionStates`. The visibility rule re-evaluates and re-opens the rail to `rankings` view because a query is active and no county is inspected. Same content the user saw before refresh.

---

## Open Questions

- [ ] **Should the active-query descriptor in the rail's rankings view header be tappable to clear?** LensHeader already has a Clear ×. Probably no — keep the rail's clear action limited to ×.
- [ ] **What happens to the rail's collapse state when it auto-opens for a new query?** If the user collapsed the rail manually for one county and a new query comes in, do we expand or honor the collapsed state? Recommended default: auto-expand on view change (already the behavior we set in Phase 4g for inspected-county changes).
- [ ] **Do we restore mobile rail-visibility behavior on tablet (768-1024px)?** The current 768px breakpoint is the rail's mobile cutoff. Tablets fall on the desktop side. This is fine for v1; revisit if user feedback flags it.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-05-06 | Nick + Claude | Initial draft |
