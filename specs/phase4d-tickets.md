# Phase 4d Tickets — The Lens

Source spec: `specs/phase4d-spec-data-surface-coherence.md`
Defaults locked (per user direction):
- Bottom-left placement
- No full-hide minimize (always visible)
- Layers tab scrolls internally

Tickets are sequential — implement L1 → L8 in order, validating after each. Don't merge L8 separately; treat the whole epic as one PR.

---

## L1 — Lens shell + 3-tab scaffolding

**Type:** Feature · **Size:** M
**Depends on:** none

### Description
Create `Lens.vue` with a persistent header slot, a 3-tab strip (LEGEND / LAYERS / CONTEXT), and 3 placeholder content panels. Mount in `Map.vue` bottom-left, replacing the `bottom-left-panels` div. Tabs use `role="tablist"`, keyboard-navigable.

### Acceptance Criteria
- New `src/components/Lens.vue` with header slot + tab navigation + 3 tab panels
- Active tab visually marked (2px ink underline, bolded)
- Right/Left arrow keys cycle tabs; Enter/Space activates
- 150ms cross-fade between tab content (CSS transition)
- Tab default: LEGEND
- Mounted in `Map.vue` bottom-left at viewport position equivalent to current Color Key
- Existing ColorLegend + AveragesPanel are unchanged for now (still rendering — to be removed in L7)
- TypeScript clean; no console errors

### Out of scope
- Tab content (placeholders only — "Legend content here", etc.)
- Header content (placeholder only)
- Mobile drawer behavior (deferred to L6)

---

## L2 — Lens header (active-query summary, persistent)

**Type:** Feature · **Size:** S
**Depends on:** L1

### Description
Port the active-query summary block (scoring chips, filter chips, Top-N chip, Clear ×) from `PromptInput.vue` into the Lens header slot. Remove the block from PromptInput. The header persists across all 3 tabs.

### Acceptance Criteria
- Lens header shows uppercase letterspaced label (`ACTIVE QUERY`) when ≥1 chip is active; otherwise shows `Showing` `<single-layer-name>` (e.g., `BLO Livability Index`)
- Chips: scoring chips with ↑↓, filter chips, `Top N` chip when limit is set
- `Clear ×` button visible only when ≥1 chip is active; wired to existing `clearActiveQuery`
- The block previously inside `PromptInput.vue` is deleted — no two surfaces show this content
- `hasActiveQuery` computed deleted from `PromptInput.vue` if no longer used elsewhere
- TypeScript clean

### Out of scope
- Mobile drawer header behavior

---

## L3 — Legend tab content

**Type:** Feature · **Size:** M
**Depends on:** L1

### Description
Port `ColorLegend.vue`'s content into the Lens "Legend" tab. Add the "What's in this score" mini-list when ≥2 layers are scoring (showing layer name + ↑↓ + weight). Default state (only BLO precomputed) shows the BLO gradient.

### Acceptance Criteria
- Gradient bar renders full-width minus padding
- "Lower" / "Higher" labels below the gradient (use the layer's natural domain language when single-layer; `Lower` / `Higher` when composite)
- When ≥2 layers active, render a stacked weight breakdown:
  ```
  Diversity Index ↑   weight 7
  Median Home Value ↓ weight 8
  ```
- When 0 or 1 layer, no breakdown shown
- Default page-load state shows BLO Livability Index gradient with title "BLO Livability Index"
- ColorLegend.vue file remains for now (delete in L7)
- TypeScript clean

### Out of scope
- Replacing ColorLegend.vue's mount in Map.vue (still showing twice during this ticket — accepted for migration step)

---

## L4 — Layers tab content + remove top-right pill

**Type:** Feature · **Size:** M
**Depends on:** L1

### Description
Move the current `LayerControls.vue` body content (BLO checkbox, category accordion, per-layer scoring controls) into the Lens "Layers" tab. Delete the top-right `Data Layers ▾` pill from `Map.vue`. The Lens Layers tab scrolls internally when content overflows max-height.

### Acceptance Criteria
- Layers tab shows: BLO Livability Index checkbox, then accordion sections (Demographics, Economic Indicators, etc.) — collapsed by default
- `LayerScoringControls` per layer when ≥2 layers selected (existing behavior)
- Adding/removing/weighting/filtering inside the tab updates the choropleth identically to today
- Top-right `Data Layers ▾` pill is removed from `Map.vue` template
- Layers tab content scrolls internally (max-height: `min(60vh, 540px)` minus header + tabs)
- TypeScript clean; no console errors

### Out of scope
- Deleting `LayerControls.vue` (keep file; just don't mount it via the pill)
- Final cleanup of `LayerControls.vue` is L7

---

## L5 — Context tab content (averages, filtered to active layers)

**Type:** Feature · **Size:** M
**Depends on:** L1

### Description
Build the Context tab. Show national averages. When ≥1 scoring layer is active, show ONLY those layers' averages with a tick-on-scale visual element. When no scoring is active, show the default "national snapshot" (5 averages: BLO Index, Black Population %, Diversity Index, Toxic Sites, Life Expectancy).

### Acceptance Criteria
- Context tab renders averages
- When ≥1 scoring layer is active, the tab filters to only those layers
- Each row shows: layer name, formatted avg value, and a small horizontal scale (1px ink-soft baseline) with a 6px green-deep tick at the avg's position relative to the layer's range
- When no scoring is active, default snapshot of 5 averages
- Numbers use tabular figures (`font-feature-settings: "tnum"`) and right-align
- Missing-data note when applicable: e.g., "Sites of Land Toxicity 8.77 — missing for 712 counties"
- AveragesPanel.vue file remains for now (delete in L7)
- TypeScript clean

### Out of scope
- Custom average computation (use existing pre-computed values)

---

## L6 — Mobile drawer behavior

**Type:** Feature · **Size:** M
**Depends on:** L1, L2, L3, L4, L5

### Description
On viewports ≤ 768px, the Lens becomes a bottom-anchored drawer with a 48px peek state showing the header summary. Tap to expand to 70vh. No collision with chat history or walkthrough rail.

### Acceptance Criteria
- ≤ 768px: Lens renders as bottom drawer
- Peek state: 48px tall, shows the header summary line (chips collapse to a single ellipsized line if needed) + a "▴" handle
- Expanded state: 70vh max, internal scrolling for tab content
- Tap on peek expands; tap on backdrop or `X` collapses to peek
- Drawer animates with 220ms `cubic-bezier(0.2, 0.8, 0.2, 1)`
- Chat history (when present) does not overlap the drawer — it shrinks/scrolls within its own container
- Walkthrough rail (when active on mobile) does not collide — they share the bottom region but stack appropriately
- TypeScript clean

---

## L7 — Cleanup: delete `ColorLegend.vue`, `AveragesPanel.vue`, the old `LayerControls.vue` pill

**Type:** Chore · **Size:** S
**Depends on:** L1–L6

### Description
Once all three tabs are working, delete the now-unused components and stale CSS in `Map.vue`. Verify no imports break.

### Acceptance Criteria
- `src/components/ColorLegend.vue` deleted
- `src/components/AveragesPanel.vue` deleted
- `src/components/LayerControls.vue` either deleted (if all content has migrated) OR reduced to a stub used only inside `Lens.vue`'s Layers tab
- `Map.vue` template region for `bottom-left-panels` div removed
- All imports of deleted components removed
- All CSS rules in `Map.vue` related to the old panels removed
- `npx vue-tsc --noEmit` returns 0
- App still renders; no missing-component runtime errors

---

## L8 — E2E verification via Playwright

**Type:** Chore · **Size:** S
**Depends on:** L7

### Description
Capture desktop and mobile screenshots verifying all flows work in the new Lens architecture.

### Acceptance Criteria
- Desktop default state: Lens shows BLO Livability Index Legend, single-line header, no chips
- Desktop active-query (top-5 affordable + diversity): header chips populated, Legend shows weight breakdown, Context shows filtered averages
- Switching tabs (Legend → Layers → Context → Legend) — visual + interaction
- Mobile peek + expanded states — no collisions
- Walkthrough still works end-to-end (entry fit, step nav, modal, exit)
- All screenshots captured to `lens-*.png` for the commit message
- Console: 0 unexpected errors

---

## Quality checklist

Before declaring the epic done:

- [ ] Active-query state is visualized in exactly **one** surface (the Lens header)
- [ ] Currently scoring layer names appear in exactly **one** primary surface (the Lens; ranking panel is OK because it's a list of counties, not state)
- [ ] Color Key, County Averages, top-right Data Layers pill are gone
- [ ] No new colors or fonts introduced — uses existing BLO tokens only
- [ ] Mobile has no panel collisions
- [ ] Desktop layout: Lens bottom-left, ranking panel bottom-right, walkthrough rail right (when active)
- [ ] Underlying state (selectedDemographicLayers, layerWeights, etc.) is unchanged
