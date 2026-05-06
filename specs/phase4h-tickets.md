# Phase 4h Tickets — Mobile Rail Unification

**Spec:** `specs/phase4h-spec-mobile-rail-unification.md`
**Date:** 2026-05-06

---

## Sequencing

```
T1 — rankings view in CountyRail        (S, P0 Feature)
T2 — mobile gate + auto-open + hide RP  (S, P0 Feature)
```

T2 depends on T1 (the auto-open destination must exist).

---

# [FEATURE] T1 — Add `rankings` view to CountyRail

**Type:** Feature
**Priority:** P0
**Size:** S (1-2 days)
**Dependencies:** Phase 4g landed

---

## Summary

Add a new `view: 'rankings'` to CountyRail.vue rendering: an active-query descriptor header, the existing single-state dropdown migrated from RankingPanel, and a scrollable list of ranked counties (reusing rank-explorer row styling). Tapping a row inspects that county (swaps to `detail`).

---

## Requirements

- [ ] Extend the `view` union to include `'rankings'`.
- [ ] Render template branch for `view === 'rankings'`. Header: small "ACTIVE QUERY" eyebrow + descriptor (single line, derived from active scoring layers — same logic as LensHeader's `queryDescriptor`).
- [ ] Single-state dropdown migrated as-is from RankingPanel, two-way bound through a new prop / emit pair (or via `rankingStateFilter` prop already wired by Map).
- [ ] List of counties: render the same `.rail-rank-row` items used in the existing `rank` view. Click → `emit('select-county', geoId)`.
- [ ] Active-county highlight: if `currentGeoId` is in the list, mark it with the existing `.rail-rank-row--current` class.
- [ ] Counties shown match `rankExplorerCounties` filtered by `regionStates` (Phase 4g) and the local state dropdown.
- [ ] No walk-through button. No top-N selector. No filter pills. No "show bottom" toggle.

---

## Acceptance Criteria

### Scenario 1: Rendering the rankings view
**Given:** Rail visible with `view='rankings'`, props include `rankCounties` (5 entries), `regionStates: ['NC','SC']`, `selectedState: ''`.
**When:** Component renders.
**Then:** The list shows 5 rows, all from NC or SC counties. Header reads "ACTIVE QUERY · <descriptor>". State dropdown is empty.

### Scenario 2: Tap row → inspect
**Given:** Rail in rankings view with rows.
**When:** User taps a row.
**Then:** Component emits `select-county` with that geoId. (Map.vue's existing handler swaps to detail.)

### Scenario 3: State dropdown filter
**Given:** Rail in rankings view, 50 rows.
**When:** User picks "TX" from the dropdown.
**Then:** Visible rows filter to TX counties only. Selection persists.

---

## Out of Scope

- Auto-open / mobile gate (T2).
- Walk-through button.
- Top-N selector. Filter pills. "Show bottom" toggle.

---

## Files to Create/Modify

- `src/components/CountyRail.vue` — new view + rendering branch + state dropdown + descriptor computed.
- `src/components/Map.vue` — pass any new props (descriptor, dropdown v-model) into CountyRail.

---

# [FEATURE] T2 — Mobile gate: hide RankingPanel, auto-open rail to rankings

**Type:** Feature
**Priority:** P0
**Size:** S (1 day)
**Dependencies:** T1

---

## Summary

On mobile, hide RankingPanel entirely. Make the rail visible whenever a scoring query is active OR an inspect target is set OR a walkthrough is active. When the rail is visible solely because a query is active (no inspect), default `view` to `rankings`.

---

## Requirements

- [ ] In `RankingPanel.vue`, add `@media (max-width: 768px) { .ranking-panel { display: none; } }` (or template-level `v-if` that depends on a viewport ref). The desktop layout stays untouched.
- [ ] In `Map.vue`, extend the rail's `:visible` computed:
  - Today: `walkthroughActive || (inspectActive && !showDetailedPopup)`
  - New: `walkthroughActive || (inspectActive && !showDetailedPopup) || hasActiveScoringQuery.value`
- [ ] Add a computed in CountyRail (or Map) that resolves the initial `view` for the rail:
  - inspect on a county → `detail`
  - walk active → `detail` (existing walk path)
  - query active, no inspect, no walk → `rankings`
- [ ] When the rail is in `rankings` view and the user inspects a county (rail emits `select-county`), the rail swaps to `detail` for that county.
- [ ] When the user clears inspect (× button) AND a query is still active, swap back to `rankings` instead of closing the rail.

---

## Acceptance Criteria

### Scenario 1: Query opens rail to rankings on mobile
**Given:** Mobile viewport, no inspect, no query, rail not visible, RankingPanel CSS-hidden.
**When:** User issues "top 5 affordable counties in the Southeast" and the chat applies the `set_query_state`.
**Then:** RankingPanel does not appear. CountyRail slides in at the bottom in `view: 'rankings'` showing 5 rows, the active-query descriptor, and the state dropdown.

### Scenario 2: Tap row → detail; close → back to rankings
**Given:** Continuing from Scenario 1, user taps a county row.
**When:** Map zooms regionally and rail swaps to `detail`.
**Then:** Detail view renders for that county. Tapping × closes the inspect; because the query is still active, the rail returns to `rankings` view rather than disappearing.

### Scenario 3: Clear query → rail disappears
**Given:** Rail in `rankings` view (no inspect).
**When:** User clears the query via Lens "Clear ×".
**Then:** Rail hides. RankingPanel still hidden (mobile). Map is full-screen.

### Scenario 4: Desktop unchanged
**Given:** Desktop viewport > 768px, mid-conversation with active query.
**When:** Page renders.
**Then:** RankingPanel renders as today. CountyRail behaves as today (no rankings-view auto-open). No regression.

---

## Out of Scope

- Restoring walk-mode UI on mobile.
- Removing walk-mode code paths (separate cleanup ticket).
- Tablet-specific layout.

---

## Files to Create/Modify

- `src/components/RankingPanel.vue` — mobile-hide media query.
- `src/components/Map.vue` — extend rail visibility computed; route close-with-active-query back to rankings.
- `src/components/CountyRail.vue` — initial-view computation; close-handler swaps to rankings when query active.
