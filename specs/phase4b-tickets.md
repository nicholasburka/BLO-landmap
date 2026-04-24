# Phase 4b Tickets: Manual Threshold Controls

**Spec:** [personalized-index-system.md](./personalized-index-system.md) (Section "Phase 4")
**Predecessor:** [phase4a-tickets.md](./phase4a-tickets.md) — LLM-driven filtering shipped
**Date:** 2026-04-24
**Branch:** `ux-redesign-phase4b` (continuing on the same branch we've been using; name stuck)

---

## Problem Statement

Phase 4a gave users *LLM-driven* filtering: the model emits `greater_than`, `less_than`, `between` thresholds based on a natural-language query. That works for users who know how to ask, but fails two scenarios:

1. **Tweaking after a query.** A user asks "top counties for Black homeownership with pct_Black > 30", sees the results, and wants to try `> 40` without rewriting the whole prompt. Today they have to re-type the full query or talk the LLM into adjusting — high friction.
2. **Exploration without a prompt.** A user playing with weight sliders has no way to add a filter without opening the chat. The chat is great for framing; sliders are better for tuning.

## Success Criteria

- A user can add/adjust/remove a threshold filter on any selected layer directly from `LayerControls`, without chatting
- Sliders snap to meaningful data ranges (layer registry's `range`)
- Filters added manually appear as pills in the active-query status strip (same visual language as LLM-set filters — no split brain)
- Subsequent LLM queries respect user-set filters rather than blowing them away, unless the user explicitly says so
- `between` filters get a dual-ended slider (single concern, clear affordance)

---

## Scope

**In scope:**
- Per-layer threshold slider UI in `LayerControls` (single-ended for `greater_than` / `less_than`)
- Dual-ended range slider for `between`
- Clear-filter affordance per layer
- LLM-awareness of active user-set filters (don't clobber unless intent is clear)

**Out of scope (deferred to 4c):**
- Filter presets ("Southern states", "urban", "rural")
- Saved filter sets / named queries
- Categorical (non-numeric) filters
- Compound logical filters ("A OR B")

---

## Architecture Decisions

1. **Filters stay in one bucket.** `activeFilters: ScoringFilter[]` already lives in `Map.vue`. Manual filters push to the same array as LLM filters. No new "manual" vs "llm" distinction — the data model treats them the same.
2. **Slider UI lives inside the existing per-layer scoring controls.** `LayerControls.vue` already has `.scoring-controls` (weight slider + direction toggle) that show up when a layer is selected. The filter slider joins that cluster — no new panel.
3. **Registry `range` is the slider domain.** Each layer has `range: { min, max }` in the registry. Slider min/max snap to those. Default thumb position: unset (no filter applied).
4. **Persistence is per-session only.** Like filters today — cleared when layers are deselected or via the Clear button. No localStorage persistence in 4b; that's a 4c concern.
5. **LLM awareness via prompt context, not schema.** When the user has active filters AND fires a new chat query, the server system prompt gets a prefix like "Currently active filters: pct_Black > 30. Keep them unless the user's request contradicts them." Simpler than threading a new `preserveFilters` boolean through the whole stack.

---

## Dependency Graph

```
B1 (Per-layer filter slider — single-ended, greater/less)
 └── B2 (Dual-ended range slider for between)
B3 (Filter awareness in chat prompt) — independent
B4 (E2E polish + tests) depends on B1-B3
```

**Critical path:** B1 → B2 → B4. B3 can land in parallel.

---

## B1: Per-Layer Filter Slider (single-ended)

**Type:** Feature
**Size:** M
**Blocked by:** None
**Blocks:** B2

### Description

When a layer is selected in `LayerControls`, the scoring controls block (weight slider + direction toggle) gets a third row: a **filter** affordance. By default: "No filter — click to add". Click expands into a single-thumb slider using the registry's `range.min`/`range.max`. The thumb position becomes the threshold; the direction of the filter is derived from the layer's *current* direction toggle:

- Direction `higher_better` → `greater_than` (keep counties above threshold)
- Direction `lower_better` → `less_than` (keep counties below threshold)

Rationale: if the user says "higher is better" for income, a filter naturally means "at least this much." One less control to reason about; filter re-derives when direction toggles.

### Changes

**`src/components/LayerControls.vue`:**
- New `filter-control` block inside each `.scoring-controls` cluster
- States: empty ("Add filter" button) → active (slider + label + × clear)
- Slider uses HTML `<input type="range">` with min/max from `LAYER_REGISTRY[id].range`
- Emits `update-filter (layerId, value | null)` → Map.vue writes into `activeFilters`
- Displays current value inline with the layer's unit (`%`, `$`, `years`, etc.)

**`src/components/Map.vue`:**
- New `updateLayerFilter(layerId, value)` handler — reconciles the filter against `activeFilters` (replaces existing filter for that layer, or removes if value is null)
- When a layer is deselected, remove any filter for it

**`src/config/layerRegistry.ts`:**
- Audit that every entry has a sensible `range` (some entries may have defaults that don't match reality — fix any that break the slider feel)

### Acceptance Criteria

- [ ] Each selected layer shows a filter control inline with its weight slider
- [ ] Dragging the slider emits a `ScoringFilter` that reaches `activeFilters` in Map.vue
- [ ] Choropleth greys out filtered counties as it does for LLM filters (same code path)
- [ ] Active-query status strip shows the new filter pill with the same formatting as LLM pills
- [ ] Clearing the filter (× button or slider-value-unset affordance) removes the pill and restores the full choropleth
- [ ] Direction toggle flips the filter operator live (from `greater_than` to `less_than`)
- [ ] Deselecting a layer also removes its filter

### Out of Scope

- Numeric input field (slider only for now)
- Histograms / distribution shading behind the slider
- Saving filter state per-layer in localStorage

---

## B2: Dual-Ended Range Slider (between)

**Type:** Feature
**Size:** S
**Blocked by:** B1
**Blocks:** B4

### Description

Add a "Range" mode to the filter control that uses two thumbs (min + max) and emits a `between` filter.

### Changes

**`src/components/LayerControls.vue`:**
- Filter control gains a mode toggle: `Threshold` / `Range`
- In Range mode: two `<input type="range">` elements styled as a shared track with two thumbs. Use a small abstraction to keep min ≤ max.
- Emits `between` filter: `{ layerId, operator: 'between', value: min, max }`

### Acceptance Criteria

- [ ] Toggling to Range shows two thumbs; switching back to Threshold collapses to one
- [ ] Min and max thumbs can't cross
- [ ] Active-query strip renders the range pill: `pct_Black 30–60` (terse format, matches current)
- [ ] Direction toggle is hidden or disabled while in Range mode (direction is irrelevant for `between`)

### Out of Scope

- Step granularity beyond 1 (fine for now; per-layer step later if needed)

---

## B3: LLM Awareness of Active Filters

**Type:** Feature
**Size:** S
**Blocked by:** None
**Blocks:** B4

### Description

When the user fires a chat query while filters are active, the server currently processes the query in isolation — it has no idea the user already set `pct_Black > 30`. If the LLM then emits a new `set_layer_selection` without filters, the client wipes `activeFilters` (since `result.filters ?? []`). That surprises users who were tweaking.

Two-part fix:

1. **Client sends active filters with each chat message** so the LLM knows about them.
2. **System prompt instructs the LLM** to preserve active filters unless the user explicitly changes or clears them.

### Changes

**`src/composables/useChat.ts`:**
- Add an `activeFilters` param (getter) to the `useChat(toolContext)` factory or pass as a second arg to `sendMessage`
- Include `context: { activeFilters: [...] }` in the `/api/chat` request body

**`server/src/routes/chat.ts`:**
- Accept `context.activeFilters` and forward to `chatHaiku`

**`server/src/prompt/chatPrompt.ts`:**
- When `context.activeFilters` is non-empty, prepend a line: "Active filters on the map right now: `pct_Black > 30`. Preserve these in any set_layer_selection tool calls unless the user's message asks to change or remove them."

**`server/src/services/haiku.ts`:**
- Thread context through to the prompt builder

**`src/components/Map.vue`:**
- `handleQueryResult`: if `result.filters` is undefined (not explicitly empty), keep current `activeFilters`. Distinguish "LLM didn't touch filters" from "LLM cleared filters."

### Acceptance Criteria

- [ ] With `pct_Black > 30` active, asking "also show me high homeownership" preserves the filter
- [ ] Asking "clear all filters" or "remove the filter" clears them
- [ ] Asking "use pct_Black > 50 instead" replaces the filter
- [ ] Empty-result queries don't accidentally clear filters

### Out of Scope

- Filter history / undo
- Showing "preserved filters" as a distinct visual cue (keep the existing pills as-is)

---

## B4: E2E Testing + Polish

**Type:** Chore
**Size:** S
**Blocked by:** B1, B2, B3
**Blocks:** None

### Description

- Playwright at 1440 + 390: add filter via slider → verify choropleth + pill + ranking panel
- Adjust slider → verify live recolor
- Toggle direction → verify operator flips
- Switch to Range → drag both thumbs → verify `between` behavior
- Fire chat query with active filter → verify preservation
- Commit on `ux-redesign-phase4b`

---

## Deferred to Phase 4c

- Filter presets ("Southern states", "urban counties", "high-diversity counties")
- Named/saved filter sets
- Categorical filters (state, region)
- Histograms behind the slider for distribution awareness
- Compound logical filters ("A OR B")
- Filter persistence to localStorage

## Open Questions

- [ ] Should the filter control stay visible when collapsed, or only appear after clicking "Add filter"? Default: "Add filter" button, expands on click — keeps the panel compact for users who don't filter
- [ ] For layers with skewed distributions (e.g. pollution counts), linear slider is awkward. Add log-scale support? Defer — use linear for all in 4b, revisit if needed.
- [ ] Should manual filters survive a page reload? Default: no, matches current behavior (Phase 4a filters are session-only). localStorage persistence is a 4c concern.
