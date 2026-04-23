# Phase 4a Tickets: Threshold Filtering + Result Counts + Walkthrough

**Spec:** [personalized-index-system.md](./personalized-index-system.md) (Section "Phase 4: Threshold Filtering + Combined Queries")
**Phase:** 4a — LLM-Driven Filtering and Result-Count Queries
**Date:** 2026-04-23

---

## Scope

Phase 4a focuses on **LLM-driven** filtering and result-count behavior, reusing Phase 1-3 infrastructure. Phase 4b (manual threshold UI controls) is a separate, later deliverable.

**What's in:**
- Threshold filters in the scoring query (greater_than, less_than, between)
- `limit` field for top-N result counts
- Filtered-out counties greyed on choropleth, hidden in ranking
- Guided walkthrough (Next/Previous) in the CountyModal
- LLM extensions to emit filters and limits

**What's out (deferred to 4b):**
- Per-layer threshold slider UI in LayerControls
- Manual filter controls outside the prompt interface

---

## Architecture Decisions

1. **Filter model** — filters are a new field on `ScoringQuery`, applied before the scoring engine runs. Counties that don't pass are excluded from ranking and rendered with muted/grey fill on the choropleth (not transparent — keeps geographic context).
2. **Result count as display limit only** — the scoring engine still scores every passing county. The `limit` field only controls how many appear in the ranking panel. Choropleth remains a gradient across all passing counties.
3. **Walkthrough scope** — walkthrough iterates the currently-displayed ranking (respects both filters and limit). Next/Previous buttons live in the CountyModal header; a "Walk through results" button on the ranking panel starts it.
4. **Manual controls deferred** — LLM is the only way to set filters in Phase 4a. Users see filters as "Applied filters: ..." text next to the explanation so they know what's active.

---

## Dependency Graph

```
T1 (Types + scoring engine filter support)
 ├── T2 (LLM prompt + filter schema extensions)
 ├── T3 (Choropleth: grey filtered-out counties)
 └── T4 (Ranking panel: respect limit + filters)
T5 (Walkthrough UI) depends on T4
T6 (Polish + E2E testing) depends on all
```

**Critical path:** T1 → T2 → T3/T4 (parallel) → T5 → T6

---

## T1: Filter Types + Scoring Engine Filter Support

**Type:** Feature
**Size:** S
**Blocked by:** None
**Blocks:** T2, T3, T4

### Description

Extend the scoring types and engine to support threshold filters. Counties that fail any filter get a null score and are marked as "filtered out" (distinct from "missing data").

### Requirements

1. **Add to `src/types/mapTypes.ts`:**
   ```typescript
   export type FilterOperator = 'greater_than' | 'less_than' | 'between'

   export interface ScoringFilter {
     layerId: string
     operator: FilterOperator
     value: number          // for greater_than, less_than
     max?: number           // for between (min is value)
   }

   export interface ExtendedScoringQuery {
     layers: ScoringQueryLayer[]
     filters?: ScoringFilter[]
     limit?: number         // display limit (informational; engine doesn't slice)
   }

   // Extend CountyScore with filter status
   export interface CountyScore {
     geoId: string
     score: number | null
     components: ScoredComponent[]
     missingLayers: string[]
     /** True if the county was excluded by a filter */
     filteredOut?: boolean
   }
   ```

2. **Update `usePersonalizedScore`:**
   - Accept either `ScoringQuery` (layers only) or `ExtendedScoringQuery` — handle both for backwards compat
   - For each county, before scoring:
     - Check each filter. If county's value for that layer fails the filter, set `filteredOut: true` and `score: null`, skip scoring
     - If a filter references a layer with no data for the county, treat as filter-failed (don't score) — consistent with requiring all filter conditions to hold
   - `rankedCounties` computed excludes `filteredOut` counties
   - New computed `filteredOutCountyIds: Ref<Set<string>>` exposes the filtered set for visual styling

3. **Backwards compat:** callers that pass plain `ScoringQuery[]` continue to work — filters are optional, undefined means no filtering.

### Acceptance Criteria

- [ ] `ExtendedScoringQuery` with `filters: [{layerId: 'pct_Black', operator: 'greater_than', value: 50}]` excludes counties with pct_Black ≤ 50
- [ ] `between` filter: `{layerId: 'life_expectancy', operator: 'between', value: 74, max: 82}` includes only 74–82
- [ ] Filtered counties have `score: null` and `filteredOut: true`
- [ ] `rankedCounties` returns only non-filtered, scorable counties
- [ ] Counties missing the filter's layer data are filtered out (conservative: require data to evaluate)
- [ ] Scoring still completes in <100ms for 3,200 counties with 3 filters + 4 scoring layers

### Files

| File | Action |
|------|--------|
| `src/types/mapTypes.ts` | **MODIFY** — add ScoringFilter, ExtendedScoringQuery, CountyScore.filteredOut |
| `src/composables/usePersonalizedScore.ts` | **MODIFY** — apply filters before scoring, expose filteredOutCountyIds |

---

## T2: LLM Filter + Limit Schema Extensions

**Type:** Feature
**Size:** M
**Blocked by:** T1
**Blocks:** T3, T4

### Description

Extend the Phase 2 query endpoint and the Phase 3 chat tool definitions to support `filters` and `limit` fields. Update the system prompts so Claude knows when to emit filters vs just scoring weights.

### Requirements

1. **Phase 2 `/api/query` response extension:**
   ```json
   {
     "layers": [...],
     "filters": [
       { "layerId": "pct_Black", "operator": "greater_than", "value": 50 },
       { "layerId": "life_expectancy", "operator": "greater_than", "value": 74 }
     ],
     "limit": 5,
     "explanation": "..."
   }
   ```

2. **Update `server/src/prompt/systemPrompt.ts`:**
   - Describe the `filters` and `limit` fields with examples
   - Guidance:
     - "Use filters when the user specifies a threshold or cutoff ('more than 50%', 'above 74 years', 'under $200k')"
     - "Use `limit` for 'top N' / 'bottom N' queries (cap at 50; default to no limit)"
     - "Don't use filters when the user wants to rank by a factor — that's a weight+direction, not a filter"

3. **Update `server/src/services/haiku.ts queryHaiku`:**
   - Parse `filters` and `limit` from the response
   - Validate: filter layerIds must exist in registry, operators are valid enum values, values are numbers
   - Clamp `limit` to 1–50

4. **Update Phase 3 `set_layer_selection` tool:**
   - Extend `input_schema` to accept optional `filters` and `limit`
   - Update tool description to describe when to use them
   - Executor passes them through to `ctx.setLayerSelection`
   - ToolContext's `setLayerSelection` signature becomes `(layers, options?: { filters?, limit?, explanation? })`

5. **Update system prompts (both Phase 2 and Phase 3):** add examples showing filter usage. E.g.:
   ```
   User: "Show me the top 5 affordable counties with more than 30% Black population"
   Response: {
     "layers": [
       {"layerId": "median_home_value", "weight": 8, "direction": "lower_better"}
     ],
     "filters": [
       {"layerId": "pct_Black", "operator": "greater_than", "value": 30}
     ],
     "limit": 5,
     "explanation": "Filtered to counties with >30% Black population, then ranked by lowest home value. Showing the top 5."
   }
   ```

### Acceptance Criteria

- [ ] POST /api/query with "affordable counties with more than 30% Black" returns filters array + layers
- [ ] Invalid filter operator or unknown layerId gets stripped (not an error)
- [ ] `limit` is clamped to 1-50 (values outside silently clamped)
- [ ] Phase 3 `set_layer_selection` tool accepts filters/limit and passes through
- [ ] System prompts updated with filter/limit examples
- [ ] Backwards compat: queries without thresholds still return `filters: undefined` or empty array

### Files

| File | Action |
|------|--------|
| `server/src/services/haiku.ts` | **MODIFY** — parse and validate filters/limit |
| `server/src/prompt/systemPrompt.ts` | **MODIFY** — add filter/limit documentation + examples |
| `server/src/prompt/chatPrompt.ts` | **MODIFY** — same for chat system prompt |
| `server/src/prompt/toolDefinitions.ts` | **MODIFY** — extend set_layer_selection schema |
| `src/lib/mapTools.ts` | **MODIFY** — extend ToolContext.setLayerSelection signature, pass through filters/limit |
| `src/composables/usePromptQuery.ts` | **MODIFY** — QueryResponse type gets optional filters/limit |

---

## T3: Choropleth Styling for Filtered-Out Counties

**Type:** Feature
**Size:** S
**Blocked by:** T1
**Blocks:** T6

### Description

When filters are active, render filtered-out counties with a muted grey fill on the choropleth instead of the usual score-based gradient. This keeps geographic context while making the filtered set visually distinct.

### Requirements

1. In `Map.vue`'s `updateChoroplethColors` function (multi-layer mode):
   - For each county, check `personalizedScores.value.get(geoID)?.filteredOut`
   - If true, use a muted grey color: `[200, 200, 200, 0.4]`
   - If `score === null` without `filteredOut` (missing data), keep existing transparent behavior
2. Add a note in the ColorLegend when filters are active: "Grey counties don't meet the filter criteria"
3. In Phase 1 single-layer mode: no change (filters only apply to multi-layer scoring queries)

### Acceptance Criteria

- [ ] With a `pct_Black > 50%` filter, counties with pct_Black ≤ 50% appear in muted grey
- [ ] Passing counties still show the score-gradient color
- [ ] Counties with missing data for filtered layer still render greyed (filtered out)
- [ ] Legend shows a small note about greyed counties when filters active
- [ ] No visual change in single-layer mode

### Files

| File | Action |
|------|--------|
| `src/components/Map.vue` | **MODIFY** — add filtered-out color branch in updateChoroplethColors |
| `src/components/ColorLegend.vue` | **MODIFY** — add filter-active note |

---

## T4: Ranking Panel Respects Filters + Limit

**Type:** Feature
**Size:** S
**Blocked by:** T1
**Blocks:** T5, T6

### Description

Update the ranking panel to respect the LLM-specified `limit` (default 20) and show an active-filter indicator. Ranking already only shows non-null scores, so filtering is automatic once T1 excludes filtered counties from `rankedCounties`.

### Requirements

1. **Dynamic limit:** add a `displayLimit` prop (default 20). Use `limit` from the LLM response when set.
2. **Filter indicator:** at the top of the ranking panel, when filters are active, show a small pill: "Filters: pct_Black > 50%, life_expectancy > 74"
3. **Count accuracy:** show "Showing top 5 of 42 matching counties" when both filters and limit are active (vs existing "top 20").
4. **Clear filters button:** small × on the filter pill clears filters and re-applies the current scoring with no filters.

### Acceptance Criteria

- [ ] With `limit: 5`, ranking shows 5 rows
- [ ] With filters, the count label reads "N of M matching counties"
- [ ] Filter pill shows human-readable filter descriptions (e.g., "Percent Black > 50%")
- [ ] Clicking × on the pill clears filters
- [ ] Without filters, no pill appears, count reads "top 20" as before

### Files

| File | Action |
|------|--------|
| `src/components/RankingPanel.vue` | **MODIFY** — add displayLimit prop, filter pill, dynamic count label |
| `src/components/Map.vue` | **MODIFY** — pass current filters + limit as props to RankingPanel, handle clear-filters |

---

## T5: Guided Walkthrough in CountyModal

**Type:** Feature
**Size:** M
**Blocked by:** T4
**Blocks:** T6

### Description

Add Next/Previous navigation to the CountyModal when opened as part of a walkthrough. A "Walk through results" button on the ranking panel starts the walkthrough at rank #1, opens the modal, and zooms the map. Next/Previous step through the ranked list respecting filters and limit.

### Requirements

1. **Ranking panel:** add a "Walk through results" button at the top of the panel (when panel is expanded and at least one county is ranked). Clicking starts walkthrough mode.
2. **Walkthrough state in Map.vue:**
   ```typescript
   const walkthrough = ref<{
     active: boolean
     currentIndex: number  // 0-based rank
     total: number         // total ranked after filters + limit
   }>({ active: false, currentIndex: 0, total: 0 })
   ```
3. **Starting walkthrough:**
   - Set `active: true`, `currentIndex: 0`, `total: rankedCounties.length` (respecting limit)
   - Call `selectCountyFromRanking(rankedCounties[0].geoId)` to open modal + zoom
4. **CountyModal changes:**
   - When `walkthrough.active` is true, show a header bar with "← 1 of 5 →" navigation
   - Previous/Next buttons (disabled at boundaries)
   - Keyboard shortcuts: Left/Right arrows, Escape to exit walkthrough
   - Close button also exits walkthrough
5. **Next/Previous logic:**
   - Next: increment index, open next county
   - Previous: decrement, open previous
   - At end (next on last): do nothing or loop to start (pick loop: wrap around)
6. **Exit walkthrough:** sets `active: false`, keeps modal closed state

### Acceptance Criteria

- [ ] "Walk through results" button appears on ranking panel when it has results
- [ ] Clicking starts walkthrough at #1, opens modal, zooms map
- [ ] Modal header shows "1 of N" with arrow buttons
- [ ] Next button advances to county #2, updates map + modal
- [ ] Previous button goes back to #1
- [ ] Arrow keys work
- [ ] Escape exits walkthrough and closes modal
- [ ] Walkthrough respects filter/limit (walks through matching set only)
- [ ] If limit is 5, walkthrough has 5 items and stops at end

### Files

| File | Action |
|------|--------|
| `src/components/RankingPanel.vue` | **MODIFY** — add "Walk through results" button, emit start event |
| `src/components/CountyModal.vue` | **MODIFY** — walkthrough header, Next/Previous, keyboard shortcuts |
| `src/components/Map.vue` | **MODIFY** — walkthrough state, handlers, pass to CountyModal |

---

## T6: End-to-End Testing + Polish

**Type:** Chore
**Size:** S
**Blocked by:** T1, T2, T3, T4, T5
**Blocks:** None

### Description

Test scenarios, polish rough edges found during testing, and update docs.

### Requirements

1. **Test scenarios via Playwright:**
   - "Show me the top 5 counties with more than 30% Black population, ranked by homeownership" → filter + limit + scoring
   - "Affordable housing in counties with life expectancy above 75" → filter + scoring
   - "Top 3 poorest counties with more than 40% Black population" → filter + limit + inverted direction
   - Walkthrough flow: start → Next → Next → Escape
   - Clear filter pill → all counties return

2. **Edge cases to verify:**
   - Filter eliminates all counties → ranking shows "No counties match the filters"
   - LLM emits invalid filter → server strips it, no crash
   - Walkthrough on a ranking with 1 result → Next/Previous disabled
   - Filtered-out grey counties still hover-able in the tooltip (show that they're filtered)

3. **Polish (discovered during testing):**
   - Filter pill styling
   - Walkthrough keyboard focus behavior
   - Loading states if filter/limit change during scoring

4. **Docs:**
   - Update `refinements-backlog.md` with anything not addressed
   - Note in README or docs that Phase 4a is live

### Acceptance Criteria

- [ ] All 5 test scenarios pass
- [ ] Edge cases handled without crashes or visual glitches
- [ ] No regressions in Phase 1, 2, or 3 flows

### Files

| File | Action |
|------|--------|
| Various | Polish only |
| `specs/refinements-backlog.md` | **MODIFY** — add any items |

---

## Summary

| Ticket | Type | Size | Dependencies |
|--------|------|------|-------------|
| T1: Types + Scoring Filter Support | Feature | S | None |
| T2: LLM Filter + Limit Schema | Feature | M | T1 |
| T3: Choropleth Grey for Filtered-Out | Feature | S | T1 |
| T4: Ranking Panel Respects Filters + Limit | Feature | S | T1 |
| T5: Walkthrough in CountyModal | Feature | M | T4 |
| T6: E2E Testing + Polish | Chore | S | T1-T5 |

**Critical path:** T1 → T2 → T3/T4 (parallel) → T5 → T6
**Total tickets:** 6 (5 features, 1 chore)

---

## Deferred to Phase 4b

- Manual threshold slider UI per layer in LayerControls
- Filter presets ("urban", "rural", "Southern states")
- Saved filter sets
- Range filter UI (dual-ended slider for `between`)

---

## Open Questions

- [ ] Filter pill wording: "Percent Black > 50%" or "Black population above 50%"? (Prefer the latter — more natural language)
- [ ] Walkthrough: should it disable other map interactions while active, or let users click around freely?
- [ ] Should the `limit` default to 20 (match current top-N) or to "all passing counties" when unspecified?
