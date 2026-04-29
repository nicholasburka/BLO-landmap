# Spec: The Lens — Data-Surface Coherence

**Status:** Draft v0.1
**Author:** Nick / Claude
**Date:** 2026-04-28
**Phase:** 4d

---

## Problem Statement

A single piece of state — *"what am I currently looking at on the map?"* — is visualized in **four separate surfaces** simultaneously, each with different fidelity and different controls. The result is clutter, redundancy, and confusion about which surface to interact with for what intent.

### Surface inventory (current state)

| Surface | Position | What it shows | Controls it owns |
|---|---|---|---|
| **Active-query strip** | Top, below Ask | Scoring chips (`Diversity Index ↑`), filter chips (`pct_Black > 30`), `Top 5` chip | `Clear ×` |
| **Data Layers panel** | Top-right pill (collapsed) → categorized checkbox tree (expanded) | Active layer count badge, all available layers grouped by category, per-layer scoring controls (weight slider, direction toggle, threshold filter) | Toggle layer on/off, set weight, direction, filter |
| **Color Key** | Bottom-left card | Active layer name (or "Custom Index"), gradient bar, "Lower" / "Higher" labels, directional chips (`↑ Diversity Index`, `↓ Median Home Value`) | None — display only |
| **County Averages** | Bottom-left card, below Color Key (collapsed by default) | National averages for *every* layer (BLO Index, Black Population, Diversity, Toxicity, Life Expectancy) regardless of what's active | Collapse/expand |

### The duplication map (verified via Playwright in `surf-04-desktop-active-query.png`)

For the query *"top 5 affordable counties with high diversity"*:

| Signal | Where it appears today |
|---|---|
| Currently scoring layer names | active-query strip + Color Key + Data Layers checked items + chat history narration |
| Direction (↑↓) for each layer | active-query strip + Color Key |
| Limit "Top 5" | active-query strip + ranking panel "Showing 5 of 3144" + chat narration |
| Filter chips | active-query strip + ranking panel filter pills |
| Top-N county list | ranking panel + chat narration |
| Color gradient | Color Key only (the only place this lives) |
| National avg for the active layer | County Averages — buried among unrelated averages |

The user sees the same query state expressed in **four places at once**. The cost is not just visual noise — it's cognitive load. The user can't tell which surface to *use* (vs. which to read), so they hover indecisively across all four.

### What's specifically broken

- **Active-query strip and Color Key duplicate scoring chips.** Same icons, same labels, ~80px apart vertically.
- **Color Key calls a multi-layer score "Custom Index"** with no further detail. The user has to scan elsewhere to learn what's in the index.
- **County Averages is contextless.** When scoring on diversity + home value, the panel still leads with BLO Livability Index (which isn't being scored) and buries the relevant averages.
- **Data Layers panel overflows on mobile.** Expanded panel collides with chat history (verified `surf-07-mobile-data-layers.png`).
- **Two long-lived panels live in opposite corners** (Data Layers top-right, Color Key/Averages bottom-left). The user's eye traces a diagonal across the map to assemble "what am I seeing."

---

## Success Criteria

We'll know this works when:

- [ ] A single primary surface — the **Lens** — owns the answer to "what does this map mean right now?" No other panel duplicates its content.
- [ ] The Color Key, County Averages, Data Layers panel, and active-query strip are gone as independent surfaces and consolidated into the Lens.
- [ ] The Lens fits within ~280–320 px width on desktop and slides into a bottom-anchored drawer on mobile.
- [ ] Three tabs — **Legend / Layers / Context** — share the Lens footprint; only one is visible at a time.
- [ ] Switching tabs is fast (≤ 150ms transition), keyboard-accessible, and does not lose the user's place in the map.
- [ ] When ≥1 scoring layer is active, the **Legend** tab shows the gradient bar + the active layer chips + (when ≥2 layers) a "what's in this score" mini-list with weights — the legend is *complete*, not a stub that hands you off to other panels.
- [ ] Adding/removing/weighting layers happens entirely inside **Layers** tab. The pill at top-right is gone.
- [ ] National averages appear in **Context**, **filtered to the active scoring layers** when any are set; otherwise show the full set.
- [ ] On mobile, the Lens never collides with chat history or the walkthrough rail. It is a bottom drawer, not an overlapping panel.
- [ ] The active-query strip at the top of the map is gone. Its content (scoring chips, filter chips, limit, Clear) becomes the Lens's persistent header.

---

## Solution Overview

A single card — **the Lens** — replaces four panels. It lives in one slot (bottom-left on desktop, bottom drawer on mobile), 280–320 px wide, with a small typographic tab strip and a fixed header showing the active-query summary.

```
┌─ The Lens ──────────────────────────────┐
│  ── ACTIVE QUERY ───────  Clear ×       │  ← persistent header
│  Diversity Index ↑  ·  Median Home ↓    │
│  Top 5  ·  Black > 30%                  │
├─────────────────────────────────────────┤
│  LEGEND  ·  LAYERS  ·  CONTEXT          │  ← tabs (small, typographic)
├─────────────────────────────────────────┤
│                                         │
│  [tab content — gradient OR pickers     │
│   OR averages]                          │
│                                         │
└─────────────────────────────────────────┘
```

When **no query is active**, the header collapses to a single line ("BLO Livability Index") and the default tab is Legend showing the BLO precomputed gradient.

---

## Detailed Requirements

### Functional Requirements

**Container**

1. The Lens shall be a single card mounted bottom-left on desktop (replacing today's Color Key + County Averages stack) and as a bottom-anchored drawer on mobile.
2. The Lens shall always be visible — there is no "fully hidden" state. On mobile, the drawer can be collapsed to a slim 48px peek-handle showing the active-query summary line.
3. The Lens shall be ~280–320 px wide on desktop. Height is content-driven, capped at `min(60vh, 540px)`.
4. The card design shall use existing BLO tokens: cream background, ink-soft borders, the existing panel shadow.

**Header (active-query summary)**

5. The header shall persist across all three tabs and shall display:
   - A small uppercase letterspaced label (`ACTIVE QUERY`) on the left.
   - A `Clear ×` button on the right when a query is active; hidden when not.
   - Below the label, a flex-wrap row of chips: scoring chips (with ↑↓ indicators), filter chips, and a `Top N` chip when limit is set.
6. When no query is active, the header shall collapse to a single line: `Showing` `BLO Livability Index` (or whichever single layer is on by default), no chips, no Clear.
7. Clicking `Clear ×` shall invoke the existing `clearActiveQuery` handler.

**Tabs**

8. Three tabs shall be presented as small typographic segments (uppercase, ~10.5px letter-spaced):
   - `LEGEND` — what the colors mean
   - `LAYERS` — pick / weight / filter
   - `CONTEXT` — national averages
9. The active tab shall be marked with a 2px ink underline and bolded weight.
10. Tabs shall be keyboard-accessible (`role="tablist"`, arrow-left/right cycles, Enter/Space activates).
11. Tab content panels shall transition with a 150ms cross-fade.

**Legend tab content**

12. The Legend tab shall render:
    - A horizontal gradient bar (full Lens width minus 24px padding) representing the current choropleth scale.
    - "Lower" / "Higher" labels below the gradient using the active layer's natural domain language ("Less affordable" / "More affordable" when the layer is `median_home_value` lower_better, etc.).
    - When ≥2 layers are active (custom score), a stacked "What's in this score" mini-list:
      ```
      Diversity Index ↑   weight 7
      Median Home Value ↓ weight 8
      ```
13. When no scoring layer is active and only the BLO precomputed default is shown, the legend shows the BLO gradient and "BLO Livability Index" as the title.

**Layers tab content**

14. The Layers tab shall contain the existing layer-selection UI from `LayerControls.vue`:
    - The default BLO Livability Index checkbox at top.
    - Categorized accordion (Demographics, Economic Indicators, Housing & Affordability, Racial Equity, Transportation, Environment, Health) — collapsed by default.
    - Per-layer `LayerScoringControls` (weight slider, direction toggle, optional threshold filter) when ≥2 layers are scoring.
15. The existing top-right `Data Layers ▾` pill is removed entirely.
16. State changes inside the Layers tab shall update the choropleth identically to today.

**Context tab content**

17. The Context tab shall show national averages.
18. When ≥1 scoring layer is active, the Context tab shall show ONLY the averages for those layers, with a small visual marker (a tick on a thin scale) indicating where the average sits relative to the layer's full range. This makes the context *useful* — "the national average for Black Homeownership is 50.6%, and you're filtering ≥ 30%."
19. When no scoring layer is active, the Context tab shall show a default "national snapshot" — BLO Index, Black Population %, Diversity Index, Toxic Sites, Life Expectancy.

**Ranking panel and walkthrough rail (unchanged)**

20. The ranking panel and walkthrough rail are NOT part of the Lens. They are temporal/action surfaces (county selection + walk-through), not data-state surfaces.
21. They shall continue to live where they do today (ranking panel bottom-right, rail right side during walkthrough).

**Mobile**

22. On viewports ≤ 768px, the Lens shall be a bottom-anchored drawer:
    - Peek state: 48px tall, showing the header summary line.
    - Expanded state: full Lens content, max-height 70vh, scrollable.
    - Tap on the peek expands; tap on a backdrop or X collapses.
23. The drawer shall not overlap the chat history or walkthrough rail. When chat history is open and the Lens drawer is expanded, the chat history shrinks or moves above the drawer.

### Non-Functional Requirements

- **Performance:** Tab switch must complete (visual + interaction-ready) in ≤ 150ms. No layout thrash on switch.
- **Accessibility:** Tabs must use ARIA tabs pattern. Header must use a live region so query changes are announced. Color Key gradient must include text equivalents for screen readers (the "Lower / Higher" labels).
- **Backwards compatibility:** Underlying state shape (selectedDemographicLayers, layerWeights, layerDirections, activeFilters, activeLimit, hasActiveScoringQuery) does not change. Only the UI surfaces consuming it change.

---

## System Context

### How It Fits

- **Replaces** four template regions:
  - `<LayerControls>` (top-right pill, replaced by Lens "Layers" tab)
  - `<ColorLegend>` (bottom-left, replaced by Lens "Legend" tab)
  - `<AveragesPanel>` (bottom-left, replaced by Lens "Context" tab)
  - The active-query strip inside `<PromptInput>` (replaced by Lens header)
- **Preserves** `<RankingPanel>` and `<WalkthroughRail>` unchanged.
- **Reuses** `<LayerScoringControls>` (per-layer weight/direction/filter) inside Layers tab.

### Dependencies

- Existing reactive state from Map.vue: `allSelectedLayers`, `layerWeights`, `layerDirections`, `activeFilters`, `activeLimit`, `hasActiveScoringQuery`, `scoringChips`.
- Existing panel-toggle handlers: `toggleLayerControl`, `toggleAveragesPanel` — these go away.
- Existing `clearActiveQuery` — wired to Lens header `Clear ×`.

### Affected Components

| Component | Fate |
|---|---|
| `Lens.vue` | NEW — the single primary surface |
| `LensHeader.vue` | NEW — the persistent active-query summary |
| `LensLegend.vue` | NEW — gradient + scoring breakdown |
| `LensLayers.vue` | NEW — wraps existing LayerControls content |
| `LensContext.vue` | NEW — averages with active-layer filtering |
| `LayerControls.vue` | KEEP body content but remove the pill/expand wrapper; mounted inside LensLayers |
| `ColorLegend.vue` | DELETE after migration |
| `AveragesPanel.vue` | DELETE after migration |
| `PromptInput.vue` | Remove the active-query status strip block (the header in the Lens replaces it) |
| `Map.vue` | Replace the top-right pill region + bottom-left stack with `<Lens>` |

---

## Constraints & Boundaries

### In Scope

- Consolidating four surfaces into the Lens with three tabs.
- Persistent active-query header at top of Lens.
- Mobile bottom-drawer behavior.
- Filtering Context averages by active scoring layers.
- Deleting `ColorLegend.vue` and `AveragesPanel.vue` after migration.

### Out of Scope

- **Redesigning the chat history surface.** Chat history is conversation, not data-state.
- **Redesigning the ranking panel or walkthrough rail.** Different surface job.
- **Adding new analytics** (e.g., "most-similar counties to X" — would belong in a future Phase 4e).
- **Voice or AI-suggested layer combinations.** Out of scope for v1.
- **Themed Lenses or saved presets.** Future feature.
- **Custom averages computation.** Use existing national averages dataset.

### Assumptions

- The user's mental model groups "controls", "legend", and "context" together — they are facets of the same question ("what is this map showing?"), not separate workflows.
- 280–320 px is enough horizontal space for all three tabs' content. Layers tab content can scroll vertically when needed.
- The bottom-left position (where Color Key sits today) is the right anchor for the Lens. Bottom-right is reserved for the action surfaces (ranking, zoom controls, attribution).

### Technical Constraints

- Vue 3 Composition API + TypeScript only.
- Must reuse existing tokens in `base.css` — no new color or typography decisions.
- Must keep the underlying scoring engine and state untouched.

---

## Aesthetic Direction (frontend-design output)

**Tone**: editorial-modern, Smithsonian-meets-FT. The Lens is a *card of record* — a calm, dense reference panel that the user trusts.

- **Typography**: Fraunces for the `ACTIVE QUERY` and tab labels, both in small caps with letter-spacing. Body figures use ui-monospace for tabular alignment of percentages and dollars (`font-feature-settings: "tnum"`).
- **Color**: Cream card, ink-soft hairline divider between header and tabs, ink underline on active tab. Green-deep accents reserved for "this is the active scoring layer" markers (small dot before the name). Orange remains exclusive to the Ask input.
- **Spatial composition**: 16px top padding, 14px side padding, 12px between header and tabs. The gradient bar in Legend is full-width (minus padding) and dominant — it's the hero of that tab.
- **Motion**: 150ms tab cross-fade. 220ms drawer slide on mobile (cubic-bezier(0.2, 0.8, 0.2, 1)). No motion on tab content within a tab — the content is reference, not dynamic.
- **Backgrounds & details**: Subtle 1px hairlines instead of heavy borders. The gradient bar is the only color-saturated element on the card. Numbers in Context tab align right with monospace digits — gives the panel a quiet, almanac-like authority.

What the user remembers: **the gradient.** It is large, vivid, and paired tightly with the active layer chips. Everything else recedes.

---

## Examples

### Example 1: Default page load
**Given:** No query, BLO Livability Index is the default visible layer.
**When:** Lens renders.
**Then:**
- Header shows: `Showing` `BLO Livability Index` (no chips, no Clear).
- Default tab: Legend.
- Gradient bar shows red→green BLO scale.
- "Lower" / "Higher" labels below.
- "What's in this score" not shown (single layer).

### Example 2: Active 2-layer query, Top 5
**Given:** User has just submitted "top 5 affordable counties with high diversity".
**When:** Result lands; Lens updates.
**Then:**
- Header chips: `Diversity Index ↑`, `Median Home Value ↓`, `Top 5`. Clear × visible.
- Legend tab: gradient + "What's in this score" mini-list:
  ```
  Diversity Index ↑   weight 7
  Median Home Value ↓ weight 8
  ```
- Layers tab: Diversity Index and Median Home Value checkboxes ticked, scoring controls visible inline.
- Context tab: only Diversity Index avg (0.33 of 1) and Median Home Value avg ($231,974) — with small ticks showing where they sit on each layer's range.

### Example 3: User adds a threshold filter
**Given:** Above query active. User opens Layers tab → finds Median Home Value row → clicks `+ Filter` → drags slider to $250,000.
**When:** Filter applies.
**Then:**
- Header gains a chip: `Median Home Value < $250k`.
- Choropleth re-renders (existing logic).
- Legend gradient is unchanged — the legend describes the *score*, not the filter.
- Context tab: median home value avg now shows the tick at the filter threshold too, so the user sees "you've cut off about half the distribution."

### Example 4: User clicks Clear
**Given:** Query active.
**When:** User clicks Clear × in Lens header.
**Then:**
- All scoring layers, filters, limit cleared (existing `clearActiveQuery`).
- Header collapses to "Showing BLO Livability Index".
- Legend tab: BLO gradient.
- Layers tab: only BLO checkbox ticked.
- Context tab: full national snapshot (all five averages).
- Ranking panel disappears (gate condition unmet).

### Example 5: Mobile peek
**Given:** Mobile viewport (≤ 768px). Query active.
**When:** Lens drawer is collapsed.
**Then:**
- Bottom of screen shows a 48px-tall peek strip with: chips row + "▴" handle.
- Map is fully visible above.
- No collision with chat history (chat sits above the peek and resizes when peek is present).

### Example 6: Mobile expanded
**Given:** Mobile viewport. User taps the peek handle.
**When:** Drawer expands.
**Then:**
- Drawer slides up to 70vh, tabs visible.
- Chat history shrinks to fit above the drawer; if it can't fit, it scrolls within its container.
- Tap on backdrop (the area not covered by the drawer) collapses the drawer back to peek.

### Example 7: Walkthrough doesn't fight the Lens
**Given:** Walkthrough is active. User is at step 3 of 5.
**When:** Walkthrough rail and Lens are both visible on desktop.
**Then:**
- Lens (bottom-left, 280–320 px) and rail (right, 320 px) are spatially distinct.
- Map fills the middle.
- No visual conflict; the Lens describes "what's the score" and the rail describes "what's *this county* like."

### Example 8: Edge — keyboard tab navigation
**Given:** Lens is rendered, focus is on the LEGEND tab.
**When:** User presses Right arrow.
**Then:**
- Focus moves to LAYERS, content cross-fades.
- Right arrow again → CONTEXT.
- Left arrow → cycles back.

### Example 9: Edge — no-data layer in Context
**Given:** User has scored on a layer with sparse coverage (e.g., contamination data missing for ~700 counties).
**When:** Context tab renders.
**Then:**
- Avg row shows: `Sites of Land Toxicity` `8.77` with a footnote "missing for 712 counties."

---

## Open Questions

- [ ] **Where exactly should the Lens live on desktop?** Options:
  - Bottom-left (current Color Key slot) — claims the same real estate, no overlap with ranking panel
  - Right rail above ranking panel — keeps "data" surfaces left and "actions" surfaces right (mirrors current convention but shrinks height)
  - **Recommendation**: bottom-left. Symmetric with ranking panel bottom-right.
- [ ] **What happens to the Color Key when only contamination is active (not part of the diversity composite)?** The Lens should adapt — Legend renders the contamination scale. Verify in implementation.
- [ ] **Should the active-query header show a "save query" affordance?** Future feature. Out of v1 scope but worth noting the slot.
- [ ] **What's the right interaction for closing the Lens entirely?** Spec currently says no full-hide. Should there be an opt-in "minimize to icon" for power users wanting a clean map? — **Recommendation**: defer to v2. Always-visible Lens is more discoverable for first-time users.
- [ ] **The Layers tab content is taller than the Lens panel allows in some cases.** Internal scroll? Or pop the tab into a temporary expanded state? — **Recommendation**: internal scroll within a max-height. Pop-out is more code for the same outcome.
- [ ] **How do we transition existing user sessions** that have stale localStorage state for `blo:layerControlExpanded`? — Just ignore the key going forward; no migration needed since the Data Layers panel goes away.

---

## Migration / Rollout

1. Build `Lens.vue` + sub-components alongside the existing panels (no removal yet).
2. Wire the Lens to the same reactive state.
3. Hide existing `LayerControls`, `ColorLegend`, `AveragesPanel`, and the active-query strip behind a feature flag (or just stub them out in the same PR).
4. Verify on desktop + mobile via Playwright.
5. Delete the now-unused components.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-28 | Nick / Claude | Initial draft |
