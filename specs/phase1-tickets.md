# Phase 1 Tickets: Dynamic Personalized Index System

**Spec:** [personalized-index-system.md](./personalized-index-system.md)
**Phase:** 1 — Data Foundation + Dynamic Scoring + Visualization
**Date:** 2026-03-27

---

## Dependency Graph

```
T1 (Registry + Types)
 ├── T2 (Refactor components to consume registry)
 │    └── T5 (Dynamic choropleth coloring)
 ├── T3 (Scoring engine)
 │    ├── T5 (Dynamic choropleth coloring)
 │    └── T6 (Ranking panel)
 └── T4 (Weight sliders + direction toggle)
      ├── T5 (Dynamic choropleth coloring)
      └── T6 (Ranking panel)

T7 (BLO preset) depends on T1 + T3 + T4
```

**Critical path:** T1 → T2 + T3 + T4 (parallel) → T5 → T6 → T7

---

## T1: Unified Layer Registry + Types

**Type:** Chore
**Size:** M
**Blocked by:** None
**Blocks:** T2, T3, T4, T5, T6, T7

### Description

Create `src/config/layerRegistry.ts` as the single source of truth for all layer metadata. Define the `LayerDefinition` interface and populate entries for all 15 scorable layers. Add supporting types to `src/types/mapTypes.ts`.

This ticket is foundational — every other ticket in Phase 1 depends on it.

### Requirements

1. Define `LayerDefinition` interface:
   - `id`, `name`, `category`, `dataType`, `direction`, `unit`, `range`, `description`, `source`, `year`, `dataPath`, `dataKey`
   - `gradient`: `{ colors: [string, string], lowLabel: string, highLabel: string }`
   - `formatValue`: `(value: number) => string`
2. Define `LayerCategory` type: `'demographic' | 'economic' | 'housing' | 'equity' | 'transportation' | 'environment' | 'health' | 'composite'`
3. Populate `LAYER_REGISTRY: Record<string, LayerDefinition>` with all 15 layers from the spec inventory table
4. Export helper functions:
   - `getLayer(id: string): LayerDefinition`
   - `getLayersByCategory(category: LayerCategory): LayerDefinition[]`
   - `getAllScorableLayers(): LayerDefinition[]` (excludes `combined_scores_v2` composite)
   - `getRegistryForLLM(): string` (serialized registry for Phase 2 system prompt — implement now so structure is validated)
5. Add types to `src/types/mapTypes.ts`:
   - `ScoringQuery`: `{ layerId: string, weight: number, direction?: 'higher_better' | 'lower_better' }[]`
   - `CountyScore`: `{ geoId: string, score: number, components: { layerId: string, normalizedValue: number, weight: number, direction: string }[], missingLayers: string[] }`

### Data sources to consolidate

| Current location | Data to extract |
|---|---|
| `layerConfig.ts` — layer arrays | id, name, visible, tooltip, category, file, color |
| `datasetMetadata.ts` — metadata dict | description, source, sourceUrl, year, unit, range, methodology |
| `ColorLegend.vue` — `layerLegends` | gradient CSS strings, lowLabel, highLabel |
| `Map.vue` — `getLayerValue()` | value formatting logic per layer |
| `Map.vue` — `layerToComponent` mapping | dataKey (field name in data map) |
| `constants.ts` — `DATA_PATHS` | dataPath for each layer |
| `constants.ts` — `LAYER_COLORS` | RGB color tuples |

### Acceptance Criteria

- [ ] `LAYER_REGISTRY` contains all 15 scorable layers with complete metadata
- [ ] Every field in `LayerDefinition` is populated (no undefined/placeholder values)
- [ ] `getLayersByCategory('economic')` returns the 2 economic layers
- [ ] `getAllScorableLayers()` returns 14 layers (excludes composite BLO score)
- [ ] `formatValue` produces correct output: e.g., `formatValue(52493)` → `"$52,493"` for median income
- [ ] TypeScript compiles with no new errors
- [ ] Existing app behavior unchanged (registry is additive, not yet consumed)

### Files

| File | Action |
|---|---|
| `src/config/layerRegistry.ts` | **CREATE** |
| `src/types/mapTypes.ts` | **MODIFY** — add ScoringQuery, CountyScore types |

---

## T2: Refactor Components to Consume Registry

**Type:** Chore
**Size:** L
**Blocked by:** T1
**Blocks:** T5

### Description

Refactor existing components and config files to consume `layerRegistry.ts` as their source of truth instead of maintaining independent copies of layer metadata. After this ticket, layer metadata lives in exactly one place.

This is a pure refactor — no new features, no behavior changes. Every interaction should work identically before and after.

### Requirements

1. **`layerConfig.ts`** — Derive layer arrays from registry:
   - `DEMOGRAPHIC_LAYERS` = `getLayersByCategory('demographic')` + composite, mapped to current shape
   - Same for `ECONOMIC_LAYERS`, `HOUSING_LAYERS`, `EQUITY_LAYERS`, `TRANSPORTATION_LAYERS`
   - Preserve the existing interface shapes (`DemographicLayer`, etc.) as thin wrappers so downstream imports don't break
   - Delete duplicated metadata that now lives in the registry

2. **`datasetMetadata.ts`** — Derive `datasetMetadata` record from registry:
   - `datasetMetadata[id]` reads from `LAYER_REGISTRY[id]`
   - Keep `getDatasetById()` and `getAllDatasets()` working
   - Keep `bloCalculationMethodology` string (not layer-specific)

3. **`constants.ts`** — Remove `LAYER_COLORS` constant (now in registry). Keep `DATA_PATHS` for non-layer data (counties GeoJSON, contamination counts, combined scores). Individual layer paths now come from registry.

4. **`ColorLegend.vue`** — Replace hardcoded `layerLegends` record with registry lookups:
   - `layerLegends[id]` → derives gradient, lowLabel, highLabel from `getLayer(id).gradient`

5. **`Map.vue`** — Replace `getLayerValue()` switch statement with registry:
   - `getLayer(layerId).formatValue(rawValue)` replaces per-layer formatting
   - Remove `layerToComponent` mapping object (now `getLayer(id).dataKey`)

### Acceptance Criteria

- [ ] All layer metadata originates from `layerRegistry.ts` — no duplicate definitions
- [ ] `npm run build` succeeds with no new TypeScript errors
- [ ] All existing layers render, toggle, show tooltips, and display legends identically
- [ ] Hovering over counties shows correct formatted values in tooltips
- [ ] CountyModal displays all data sections correctly
- [ ] ColorLegend shows correct gradients and labels for every layer

### Files

| File | Action |
|---|---|
| `src/config/layerConfig.ts` | **REFACTOR** — derive from registry |
| `src/config/datasetMetadata.ts` | **REFACTOR** — derive from registry |
| `src/config/constants.ts` | **MODIFY** — remove LAYER_COLORS |
| `src/components/ColorLegend.vue` | **REFACTOR** — use registry for legends |
| `src/components/Map.vue` | **REFACTOR** — use registry for formatting + data keys |
| `src/composables/useColorCalculation.ts` | **REFACTOR** — use registry for color config |

---

## T3: Dynamic Scoring Engine

**Type:** Feature
**Size:** M
**Blocked by:** T1
**Blocks:** T5, T6, T7

### Description

Create `src/composables/usePersonalizedScore.ts` — a Vue composable that computes a weighted composite score per county given a set of layers with weights and optional direction overrides. Handles missing data via weight redistribution.

### Requirements

1. **Input:** Reactive `ScoringQuery[]` (layerId, weight, direction?)
2. **Output:** Reactive `Map<string, CountyScore>` — keyed by GEOID
3. **Algorithm** (per county):
   ```
   For each layer in query:
     rawValue = dataMap[geoId][layer.dataKey]
     if rawValue is null/undefined → mark missing, skip
     normalized = (rawValue - layer.range.min) / (layer.range.max - min)
     if direction === 'lower_better': normalized = 1 - normalized
     if direction === 'neutral' or undefined: no inversion
     weightedValue = normalized * layer.weight

   availableWeight = sum of weights for non-missing layers
   score = (sum of weightedValues / availableWeight) * 100
   ```
4. **Edge cases:**
   - All layers missing for a county → score = null, excluded from results
   - Single layer query → still works (score = normalized value * 100)
   - Weight of 0 → layer excluded from computation
   - `availableWeight = 0` → score = null
5. **Performance:** Must compute ~3,200 counties in <100ms. Use plain loops, avoid unnecessary allocations.
6. **Exported API:**
   ```typescript
   usePersonalizedScore(query: Ref<ScoringQuery[]>, dataMaps: DataMaps)
   Returns: {
     scores: ComputedRef<Map<string, CountyScore>>
     rankedCounties: ComputedRef<CountyScore[]>  // sorted descending
     isComputing: Ref<boolean>
   }
   ```
7. The composable needs access to all loaded data maps. Accept them as a parameter (the refs from `useMapData`).

### Acceptance Criteria

- [ ] Given 3 layers with weights [8, 6, 7], computes scores for all counties with data
- [ ] County missing 1 of 3 layers gets a valid score with redistributed weights
- [ ] County missing all layers gets null score and is excluded from `rankedCounties`
- [ ] `rankedCounties` is sorted descending by score
- [ ] Direction `lower_better` inverts the normalized value (lower raw = higher score)
- [ ] Direction `neutral` or omitted uses raw normalized value without inversion
- [ ] Scoring ~3,200 counties x 3 layers completes in <100ms (verify with `performance.now()`)
- [ ] TypeScript compiles, composable is importable from Map.vue

### Files

| File | Action |
|---|---|
| `src/composables/usePersonalizedScore.ts` | **CREATE** |

---

## T4: Weight Sliders + Direction Toggle

**Type:** Feature
**Size:** S
**Blocked by:** T1
**Blocks:** T5, T6

### Description

Add weight sliders and direction toggles to `LayerControls.vue`. When a layer is selected (checked), a slider and direction control appear below it. Emit weight and direction changes to Map.vue.

### Requirements

1. **Weight slider:**
   - Range: 1–10, default: 5
   - Compact horizontal `<input type="range">`
   - Shows current value next to slider
   - Only visible when layer is checked
2. **Direction toggle:**
   - Three-state: neutral (default), higher_better (↑), lower_better (↓)
   - Simple button/icon toggle cycling through states
   - Shows current direction with icon or label
   - Only visible when layer is checked
3. **State management in Map.vue:**
   - New ref: `layerWeights: Ref<Record<string, number>>` — default 5 for all
   - New ref: `layerDirections: Ref<Record<string, 'neutral' | 'higher_better' | 'lower_better'>>` — default 'neutral' for all
   - When a layer is toggled off, its weight/direction persist (restored if re-enabled)
4. **Events:**
   - `LayerControls` emits `update-weight(layerId: string, weight: number)`
   - `LayerControls` emits `update-direction(layerId: string, direction: string)`
   - Map.vue handles both, updates refs
5. **Props to LayerControls:**
   - `layerWeights: Record<string, number>`
   - `layerDirections: Record<string, string>`

### Acceptance Criteria

- [ ] Selecting a layer shows a weight slider (1-10) and direction toggle below the checkbox
- [ ] Deselecting hides the slider/toggle
- [ ] Moving the slider emits `update-weight` with correct layerId and value
- [ ] Clicking direction cycles: neutral → higher_better → lower_better → neutral
- [ ] Weight and direction state persists when toggling a layer off and back on
- [ ] UI is compact — sliders don't bloat the controls panel
- [ ] Accessible: slider has aria-label, direction toggle has aria-label with current state

### Files

| File | Action |
|---|---|
| `src/components/LayerControls.vue` | **MODIFY** — add sliders + direction toggles |
| `src/components/Map.vue` | **MODIFY** — add weight/direction refs, handle events, pass as props |

---

## T5: Dynamic Multi-Layer Choropleth Coloring

**Type:** Feature
**Size:** M
**Blocked by:** T2, T3, T4
**Blocks:** T6

### Description

Wire the scoring engine to Map.vue's choropleth coloring. When 2+ layers are selected, use `usePersonalizedScore` to compute scores with user-specified weights and directions, then map scores to colors on the choropleth.

### Requirements

1. **Integrate scoring engine in Map.vue:**
   - Build `ScoringQuery[]` from selected layers + `layerWeights` + `layerDirections` refs
   - Pass to `usePersonalizedScore` composable
   - When query changes (layer toggled, weight changed, direction changed), scores recompute
2. **Color mapping:**
   - Multi-layer mode: map score (0-100) to gradient (yellow → green, matching current BLO gradient)
   - Build Mapbox `match` expression: `['match', ['get', 'GEOID'], geoId1, color1, geoId2, color2, ..., defaultColor]`
   - Counties with null score → transparent
3. **Single-layer mode preserved:**
   - When only 1 layer selected, use the layer-specific gradient from registry (existing behavior)
   - No scoring engine needed for single layer — use direct normalization + registry gradient
4. **Replace existing multi-layer logic:**
   - Remove `computeCombinedScore()` function from Map.vue
   - Remove `getColorForCombinedScore()` and the multi-layer branch in `updateChoroplethColors()`
   - Single-layer `getColorFor*Layer()` functions stay until they can be consolidated (or refactored to use registry)
5. **Debounce:** Weight slider changes debounce recoloring at ~100ms to avoid jank during rapid slider movement
6. **Legend update:**
   - Multi-layer mode: ColorLegend shows "Custom Index" with yellow→green gradient
   - Single-layer: shows layer-specific legend from registry (already handled by T2)
7. **Tooltip update:**
   - Multi-layer mode: tooltip shows "Custom Score: XX.X / 100" plus individual layer values
   - Single-layer: tooltip shows layer value (existing behavior)

### Acceptance Criteria

- [ ] Select 2 layers → choropleth recolors using dynamic scoring engine, not precomputed BLO score
- [ ] Adjust weight slider → choropleth recolors within ~200ms
- [ ] Change direction toggle → choropleth recolors reflecting inversion
- [ ] Counties with missing data for all selected layers appear transparent
- [ ] Single-layer selection uses layer-specific gradient (backwards compatible)
- [ ] Legend shows "Custom Index" gradient in multi-layer mode
- [ ] Tooltip shows custom score + individual values in multi-layer mode
- [ ] No visual regression for existing single-layer behavior
- [ ] `computeCombinedScore()` and `getColorForCombinedScore()` removed from Map.vue

### Files

| File | Action |
|---|---|
| `src/components/Map.vue` | **MODIFY** — integrate scoring engine, remove old multi-layer logic |
| `src/components/ColorLegend.vue` | **MODIFY** — handle "Custom Index" mode |

---

## T6: County Ranking Panel + Geographic Filter

**Type:** Feature
**Size:** M
**Blocked by:** T3, T4, T5
**Blocks:** T7

### Description

Create `RankingPanel.vue` — a toggleable panel showing counties ranked by the dynamic composite score, with state/region geographic filtering.

### Requirements

1. **Panel design:**
   - Positioned bottom-right of the map (inside `.bottom-left-panels` equivalent on the right, or a new container)
   - Toggleable with a collapse/expand button (same pattern as AveragesPanel)
   - Shows when 2+ layers are selected
   - Hidden when 0-1 layers selected
2. **Ranking table:**
   - Columns: Rank (#), County, State, Score (0-100)
   - Default: top 20 counties, sorted by score descending
   - Toggle to show bottom 20
   - Scores formatted to 1 decimal place
3. **Geographic filter:**
   - Dropdown at top of panel: "All States" + alphabetical state list
   - Uses `FIPS_TO_STATE` from `stateFips.ts` to map GEOID prefix → state name
   - Filtering updates the ranking to show top 20 within selected state
   - Optional: region presets (South, Northeast, Midwest, West) as quick-select chips
4. **Interactions:**
   - Click a county row → map zooms to that county + opens CountyModal
   - Zoom: use Mapbox `fitBounds` with the county's bbox from GeoJSON
   - Highlight: set a temporary outline on the clicked county
5. **Data source:** `rankedCounties` from `usePersonalizedScore` composable
6. **Reactivity:** Panel updates when scores change (weight/direction/layer changes)

### Acceptance Criteria

- [ ] Panel appears when 2+ layers are selected, hides when 0-1
- [ ] Shows top 20 counties ranked by dynamic score, descending
- [ ] Toggle switches to bottom 20
- [ ] State dropdown filters ranking to selected state's counties
- [ ] Clicking a county row zooms map to that county and opens detail modal
- [ ] Panel updates reactively when weights or layers change
- [ ] Panel is collapsible (toggle button pattern)
- [ ] Accessible: table has proper headers, dropdown has label

### Files

| File | Action |
|---|---|
| `src/components/RankingPanel.vue` | **CREATE** |
| `src/components/Map.vue` | **MODIFY** — mount RankingPanel, pass scores/data, handle zoom-to-county |

---

## T7: BLO Composite Score as Preset

**Type:** Feature
**Size:** S
**Blocked by:** T1, T3, T4
**Blocks:** None

### Description

Convert the existing BLO Livability Index from a mutually exclusive special layer into a "preset" — a predefined scoring query with known layers, weights, and directions that users can load and then customize.

### Requirements

1. **Define BLO preset** in registry or a new `presets.ts`:
   ```typescript
   const BLO_PRESET: ScoringQuery[] = [
     { layerId: 'diversity_index', weight: 4, direction: 'higher_better' },
     { layerId: 'pct_Black', weight: 4, direction: 'higher_better' },
     { layerId: 'life_expectancy', weight: 4, direction: 'higher_better' },
     { layerId: 'contamination', weight: 2, direction: 'lower_better' },
     { layerId: 'avg_weekly_wage', weight: 4, direction: 'higher_better' },
     { layerId: 'median_income_by_race', weight: 4, direction: 'higher_better' },
     { layerId: 'median_home_value', weight: 4, direction: 'lower_better' },
     { layerId: 'median_property_tax', weight: 2, direction: 'lower_better' },
     { layerId: 'homeownership_by_race', weight: 2, direction: 'higher_better' },
     { layerId: 'poverty_by_race', weight: 4, direction: 'lower_better' },
     { layerId: 'black_progress_index', weight: 6, direction: 'higher_better' },
   ]
   ```
   (Weights mapped from the original percentage weights in `calculate_blo_v2_scores.cjs` to 1-10 scale)
2. **Loading a preset:**
   - Selecting "BLO Livability Index" checkbox loads the preset: selects all 11 layers, sets their weights and directions
   - Sliders and direction toggles populate with preset values
   - User can then adjust any weight/direction (it's now a custom query based on the preset)
3. **Remove mutual exclusivity:**
   - Currently selecting BLO clears other layers and vice versa
   - After this ticket: BLO is just a shortcut that populates the query, not a separate mode
   - If user manually adds a 12th layer on top of the BLO preset, that's fine
4. **Visual indicator:**
   - When BLO preset is active and unmodified, show "(BLO Preset)" label near the scoring display
   - Once user modifies any weight/direction, label changes to "Custom" or disappears

### Acceptance Criteria

- [ ] Checking "BLO Livability Index" selects 11 layers with preset weights and directions
- [ ] Weight sliders show the preset values (e.g., diversity_index = 4)
- [ ] Direction toggles show preset directions (e.g., contamination = lower_better)
- [ ] Adjusting any slider or direction works normally (customizing the preset)
- [ ] Adding another layer on top of BLO preset works (no mutual exclusivity)
- [ ] Unchecking "BLO Livability Index" clears all preset layers
- [ ] Dynamic scoring produces results comparable to precomputed `combined_scores_v2.json` (within rounding tolerance)
- [ ] Ranking panel works with BLO preset selected

### Files

| File | Action |
|---|---|
| `src/config/presets.ts` | **CREATE** — BLO_PRESET definition |
| `src/components/Map.vue` | **MODIFY** — handle preset loading, remove mutual exclusivity logic |
| `src/components/LayerControls.vue` | **MODIFY** — preset loading populates sliders/toggles |

---

## Summary

| Ticket | Type | Size | Dependencies |
|--------|------|------|-------------|
| T1: Layer Registry + Types | Chore | M | None |
| T2: Refactor to consume registry | Chore | L | T1 |
| T3: Scoring Engine | Feature | M | T1 |
| T4: Weight Sliders + Direction | Feature | S | T1 |
| T5: Dynamic Choropleth | Feature | M | T2, T3, T4 |
| T6: Ranking Panel + Geo Filter | Feature | M | T3, T4, T5 |
| T7: BLO Preset | Feature | S | T1, T3, T4 |

**Estimated critical path:** T1 → T2 → T5 → T6 → T7
**Parallelizable:** T2, T3, T4 can run in parallel after T1
**Total tickets:** 7 (2 chores, 5 features)
