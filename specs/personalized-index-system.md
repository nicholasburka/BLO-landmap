# Spec: Dynamic Personalized Index System

**Status:** Draft
**Author:** Nick + Claude
**Date:** 2026-03-27

---

## Problem Statement

The BLO National Map currently displays a fixed composite livability score or individual data layers, but users can't express what matters *to them*. A first-time homebuyer cares about different metrics than a retiree or a business owner. Users need to ask questions like "show me counties with high Black population, low mortgage costs, and high income" and get a dynamically computed, personalized index with visual rankings -- without needing to understand which data layers exist or how to combine them.

---

## Success Criteria

We'll know this works when:

- [ ] A unified layer registry is the single source of truth for all layer metadata (id, name, type, range, direction, data source)
- [ ] Users can select 2+ layers and assign weights via sliders, producing a dynamic composite score per county
- [ ] Missing data for a county redistributes that weight proportionally across available components
- [ ] The choropleth dynamically recolors based on the personalized composite score
- [ ] A ranking panel shows top-N counties for the current weighted selection
- [ ] (Phase 2) Users can type a natural language query and have it translated to layer selections + weights via Claude Haiku
- [ ] (Phase 3) Prompt can trigger map actions (zoom, search, toggle layers)

---

## Solution Overview

Three-phase transformation from static layer viewer to dynamic, prompt-driven exploration tool.

**Phase 1** unifies the scattered layer metadata into a single registry, builds a client-side dynamic scoring engine with weight redistribution, adds weight sliders to the UI, and introduces a county ranking panel. All existing functionality is preserved.

**Phase 2** adds a lightweight backend (Node/Express on a separate service or Netlify Functions) with Claude Haiku integration. The LLM receives the layer registry as context and maps natural language queries to structured layer selections with weights and direction preferences.

**Phase 3** extends the LLM interface with tool-use capabilities: zoom to a county, trigger the housing search, toggle specific layers -- enabling conversational map exploration.

---

## Phase 1: Data Foundation + Dynamic Scoring + Visualization

### 1.1 Unified Layer Registry

**What:** A single TypeScript module that is the canonical source for all layer metadata. Replaces the current scatter across `layerConfig.ts`, `datasetMetadata.ts`, `ColorLegend.vue` gradient definitions, and hardcoded color functions in `Map.vue`.

**Registry entry shape:**
```typescript
interface LayerDefinition {
  id: string                          // e.g. 'median_home_value'
  name: string                        // e.g. 'Median Home Value'
  category: LayerCategory             // 'demographic' | 'economic' | 'housing' | 'equity' | 'transportation' | 'environment' | 'health'
  dataType: 'percentage' | 'currency' | 'count' | 'index' | 'years' | 'ordinal'
  direction: 'higher_better' | 'lower_better' | 'neutral'
  unit: string                        // '%', '$', 'years', 'sites', etc.
  range: { min: number, max: number } // theoretical or observed
  description: string                 // human-readable, also used as LLM context
  source: string                      // 'US Census Bureau', 'EPA', etc.
  year: number | string
  dataPath: string                    // path to CSV/JSON in public/datasets/
  dataKey: string                     // field name in the loaded data map
  gradient: { low: string, high: string, lowLabel: string, highLabel: string }
  formatValue: (value: number) => string  // display formatter
}
```

**Current sources to consolidate:**
- `src/config/layerConfig.ts` (layer arrays with id, name, visible, tooltip, category)
- `src/config/datasetMetadata.ts` (descriptions, display names)
- `src/components/ColorLegend.vue` (gradient definitions, low/high labels)
- `src/components/Map.vue` (`getColorFor*Layer()` functions, `getLayerValue()` in tooltip, `layerToComponent` mapping)
- `src/config/constants.ts` (DATA_PATHS, color constants)

**Complete layer inventory (17 layers):**

| ID | Name | Type | Direction | Category |
|----|------|------|-----------|----------|
| `combined_scores_v2` | BLO Livability Index | index | higher_better | composite |
| `diversity_index` | Diversity Index | index | higher_better | demographic |
| `pct_Black` | Percent Black | percentage | neutral | demographic |
| `life_expectancy` | Life Expectancy | years | higher_better | health |
| `avg_weekly_wage` | Average Weekly Wage | currency | higher_better | economic |
| `median_income_by_race` | Median Income (Black) | currency | higher_better | economic |
| `median_home_value` | Median Home Value | currency | lower_better | housing |
| `median_property_tax` | Median Property Tax | currency | lower_better | housing |
| `homeownership_by_race` | Black Homeownership Rate | percentage | higher_better | equity |
| `poverty_by_race` | Poverty Rate (Black) | percentage | lower_better | equity |
| `black_progress_index` | Black Progress Index | index | higher_better | equity |
| `commute_time` | Most Common Commute Time | ordinal | lower_better | transportation |
| `drove_alone` | % Drove Alone (Black Workers) | percentage | neutral | transportation |
| `public_transit` | % Public Transit (Black Workers) | percentage | higher_better | transportation |
| `contamination` | EPA Contamination Sites | count | lower_better | environment |

Note: The 5 individual EPA GeoJSON layers (brownfields, air pollution, hazardous waste, superfund, toxic release) are point/polygon overlays, not choropleth layers. They contribute to the `contamination` count but are not independently scored.

### 1.2 Dynamic Scoring Engine

**What:** A composable (`usePersonalizedScore.ts`) that computes a weighted composite score per county given a set of layers and weights.

**Algorithm:**
```
Input: selectedLayers = [{layerId, weight, direction?}]
For each county:
  1. For each selected layer:
     a. Get raw value from data map
     b. If missing → skip, redistribute weight
     c. Normalize to [0, 1] using layer's range (min-max)
     d. If direction is 'lower_better', invert: 1 - normalized
     e. Multiply by weight
  2. availableWeight = sum of weights for layers with data
  3. score = sum(weightedValues) / availableWeight
  4. Scale to 0-100 for display
Output: Map<GEOID, { score, components[], missingLayers[] }>
```

**Weight redistribution example:**
- User selects 3 layers with weights [0.5, 0.3, 0.2]
- County X is missing layer 2 data
- Available weight = 0.5 + 0.2 = 0.7
- Score = (layer1_weighted + layer3_weighted) / 0.7
- Effect: layers 1 and 3 are proportionally upweighted for this county

**Direction handling:** All layers default to `neutral` in the scoring engine — the `direction` field in the registry describes the layer's semantic meaning (for LLM context and UI labeling), but the scoring engine only applies a direction when the user (or LLM in Phase 2) explicitly specifies one. Users may want to flip a layer's typical direction (e.g., "I want HIGH property tax areas because that means better schools"), so the scoring engine accepts direction as a parameter per-layer per-query, not as a hardcoded default.

### 1.3 Dynamic Choropleth Coloring

**What:** Replace the current multi-layer coloring logic (which falls back to the precomputed BLO score) with real-time coloring from the dynamic scoring engine.

**Current problem:** When 2+ layers are selected, `computeCombinedScore()` in Map.vue looks up pre-computed component values from `combinedScoresV2Data.components` and averages them. This means: (a) equal weights only, (b) tied to the BLO v2 normalization, (c) no user control.

**New approach:**
- `usePersonalizedScore` computes scores for all counties
- Map.vue builds a Mapbox `match` expression mapping GEOID → color
- Color gradient: configurable, default yellow → green
- Single function replaces all `getColorFor*Layer()` functions for multi-layer mode
- Single-layer mode continues to use layer-specific gradients from the registry

### 1.4 Weight Adjustment UI

**What:** When a layer is selected, a weight slider appears next to its checkbox.

**Design:**
- Slider range: 1-10 (displayed as relative importance, not percentage)
- Default weight: 5 for all layers
- Weights are normalized to sum-to-1 internally by the scoring engine
- Visual: compact horizontal slider, current value displayed
- Changing a weight triggers immediate recalculation and recolor

**Placement:** Inline within `LayerControls.vue`, below each selected layer's checkbox.

### 1.5 County Ranking Panel

**What:** A new component showing top-N counties ranked by the personalized composite score.

**Design:**
- Toggleable panel, similar to existing AveragesPanel
- Shows when 2+ layers are selected with weights
- Default: top 20 counties
- Columns: Rank, County Name, State, Score (0-100)
- Click a county → map zooms to it + opens CountyModal
- Optional: show bottom 20 toggle
- Updates dynamically as weights change

---

## Phase 2: Backend + Prompt Interface

### 2.1 Backend Service

**What:** Lightweight API that proxies Claude Haiku calls with the layer registry as system context.

**Options:**
- Netlify Functions (serverless, stays in current infra)
- Separate Express server (more flexibility for Phase 3 tool-use)

**Endpoint:**
```
POST /api/query
Body: { prompt: string }
Response: {
  layers: [{ layerId: string, weight: number, direction: 'higher_better' | 'lower_better' }],
  explanation: string
}
```

**System prompt includes:** Full layer registry (IDs, names, descriptions, directions, data types). LLM maps natural language to structured output.

### 2.2 Prompt UX

**What:** Text input where users describe what they're looking for.

**Design:**
- Text input at top of LayerControls or as a separate panel
- Suggested queries / examples shown as chips
- After submission: layers auto-selected, weights auto-set, explanation shown
- User can then adjust weights with sliders
- History of recent queries

**Examples:**
- "Best counties for Black homeownership with low cost of living"
- "High diversity, good wages, low pollution"
- "Where can I find affordable housing near public transit?"

### 2.3 LLM Integration

**Model:** Claude Haiku (fast, cheap, sufficient for structured extraction)
**Context:** Layer registry serialized as system prompt
**Output format:** Structured JSON (layer selections + weights + directions)
**Error handling:** If query doesn't map to any layers, return explanation + suggest alternatives

---

## Phase 3: Promptable Map Controls

### 3.1 LLM Tool-Use

**What:** Extend the LLM interface with callable tools that control the map.

**Tools:**
- `zoom_to_county(county_name, state)` - zoom + highlight
- `search_housing(location)` - trigger property listing search
- `toggle_layer(layer_id, enabled)` - turn layers on/off
- `set_weight(layer_id, weight)` - adjust layer weight
- `show_ranking()` - open the ranking panel
- `compare_counties(county1, county2)` - side-by-side view

### 3.2 Conversational Flow

**What:** Multi-turn interaction where users can refine their view.

**Example:**
```
User: "Show me the top counties for Black families in the South"
→ LLM selects: pct_Black (high), median_income_by_race (high), homeownership_by_race (high), poverty_by_race (low)
→ Zooms to southeastern US

User: "Now focus on North Carolina"
→ Zooms to NC, filters ranking to NC counties

User: "What housing is available in Mecklenburg County?"
→ Zooms to Mecklenburg, triggers housing search
```

---

## Phase 4: Threshold Filtering + Combined Queries

**Not yet scoped — noting for future planning.**

Phases 1-3 support **scoring** (rank all counties by weighted factors) and **map controls** (zoom, search, toggle). What's missing is **filtering** — the ability to set hard thresholds that exclude counties from results entirely.

### 4.1 Data-Level Filtering

**What:** Users can specify threshold conditions per layer, applied as filters before scoring.

**Examples:**
- "Show me counties with percent Black higher than 50% and life expectancy above 74 years"
- "Only counties where median home value is under $200,000"
- "Counties with at least 60% Black homeownership rate"

**Filter types:**
- `greater_than(layerId, value)` — only include counties where this layer exceeds the threshold
- `less_than(layerId, value)` — only include counties where this layer is below the threshold
- `between(layerId, min, max)` — range filter

### 4.2 Combined Scoring + Filtering

**What:** Filters narrow the set, then scoring ranks within that set.

**Example:**
- Filter: `pct_Black > 50%` AND `life_expectancy > 74`
- Score remaining counties by: `median_income_by_race` (weight 8, higher_better) + `median_home_value` (weight 6, lower_better)
- Result: "Among counties with majority Black population and above-average life expectancy, here are the most affordable with best income"

### 4.3 LLM Integration

The system prompt would need to support a `filters` field in addition to `layers`:
```json
{
  "filters": [
    { "layerId": "pct_Black", "operator": "greater_than", "value": 50 },
    { "layerId": "life_expectancy", "operator": "greater_than", "value": 74 }
  ],
  "layers": [
    { "layerId": "median_income_by_race", "weight": 8, "direction": "higher_better" }
  ],
  "explanation": "..."
}
```

### 4.4 Implementation Considerations
- Scoring engine needs a pre-filter step: exclude counties that don't pass all filter conditions
- Choropleth should visually distinguish filtered-out counties (transparent or greyed out)
- Ranking panel only shows counties that pass all filters
- Filter UI: could be threshold sliders per-layer, or purely prompt-driven via LLM
- Filter counts: show "X of 3,144 counties match your filters" as feedback

---

## System Context

### Current Architecture
- Frontend: Vue 3 + TypeScript + Vite
- Map: Mapbox GL JS with choropleth layers
- Data: Static CSV/JSON in `public/datasets/`, loaded client-side via PapaParse
- Hosting: Netlify (static site)
- State: Component-level refs in Map.vue, composables for data loading and color calculation

### After Phase 1
- New `src/config/layerRegistry.ts` replaces scattered config
- New `src/composables/usePersonalizedScore.ts` for dynamic scoring
- Existing composables and components refactored to consume registry
- Still fully static, no backend needed

### After Phase 2
- Backend service (Netlify Functions or Express)
- API key management (Claude API key server-side only)
- Frontend adds prompt input component

### After Phase 3
- Backend expanded with tool-use capabilities
- Frontend adds conversational UI elements

### Key Files Affected (Phase 1)

| File | Change |
|------|--------|
| `src/config/layerRegistry.ts` | **NEW** - unified layer definitions |
| `src/composables/usePersonalizedScore.ts` | **NEW** - dynamic scoring engine |
| `src/components/RankingPanel.vue` | **NEW** - county ranking display |
| `src/config/layerConfig.ts` | **REFACTOR** - consume from registry |
| `src/config/datasetMetadata.ts` | **REFACTOR** - consume from registry |
| `src/config/constants.ts` | **REFACTOR** - move layer-specific constants to registry |
| `src/components/Map.vue` | **REFACTOR** - remove hardcoded color functions, use scoring engine for multi-layer |
| `src/components/LayerControls.vue` | **MODIFY** - add weight sliders |
| `src/components/ColorLegend.vue` | **REFACTOR** - consume gradients from registry |
| `src/components/CountyModal.vue` | **MODIFY** - show personalized rank context |
| `src/types/mapTypes.ts` | **MODIFY** - add PersonalizedScore types |
| `src/composables/useColorCalculation.ts` | **REFACTOR** - use registry for color config |

---

## Constraints & Boundaries

### In Scope (Phase 1)
- Unified layer registry
- Dynamic weighted scoring with missing data redistribution
- Weight slider UI in LayerControls
- Dynamic multi-layer choropleth recoloring
- County ranking panel (top/bottom N)
- Geographic filtering in ranking (by state/region)
- BLO composite score as a "preset" (predefined layers/weights that users can load and then customize)
- Refactoring existing code to use registry

### Out of Scope (Phase 1)
- Backend / API server
- LLM integration / prompt interface
- Custom data upload
- User accounts / saved configurations
- Mobile-specific redesign
- CSV export from ranking panel

### Assumptions
- All existing data layers remain static CSV/JSON (no live data feeds)
- Client-side scoring is fast enough for ~3,200 counties x ~15 layers
- Mapbox `match` expression can handle ~3,200 entries per repaint (already proven in current code)
- Weight sliders use relative importance (1-10), not raw percentages

### Technical Constraints
- Must remain deployable to Netlify (Phase 1)
- Must preserve all existing single-layer visualization behavior
- TypeScript strict mode
- No new runtime dependencies for Phase 1 (scoring is pure math)

---

## Examples

### Example 1: Basic Multi-Layer Scoring (Happy Path)
**Given:** User selects `pct_Black` (weight 8), `median_home_value` (weight 6, direction: lower_better), `median_income_by_race` (weight 7, direction: higher_better)
**When:** Weights are normalized and scoring runs
**Then:**
- Normalized weights: [0.38, 0.29, 0.33]
- Each county gets a score 0-100
- `pct_Black` uses direction `neutral` (no direction specified → raw normalized value, no inversion)
- `median_home_value` uses direction `lower_better` (user specified → inverted: lower price = higher score)
- `median_income_by_race` uses direction `higher_better` (user specified → higher income = higher score)
- Choropleth recolors, ranking panel shows top 20
- User can then flip `pct_Black` to `higher_better` via a direction toggle if desired

### Example 2: Missing Data Redistribution
**Given:** County X has data for `pct_Black` and `median_income_by_race` but NOT `median_home_value`
**When:** Scoring runs with weights [0.38, 0.29, 0.33]
**Then:**
- Available weight = 0.38 + 0.33 = 0.71
- Score = (pct_Black_weighted + income_weighted) / 0.71
- County X still appears in ranking with a valid score
- Tooltip or modal indicates 1 layer was unavailable

### Example 3: Single Layer (Backwards Compatibility)
**Given:** User selects only `diversity_index`
**When:** Single layer mode
**Then:** Choropleth uses the layer-specific gradient from the registry (purple scale), not the composite gradient. Ranking panel hidden (only 1 layer). Behavior identical to current app.

### Example 4: Prompt to Layers (Phase 2)
**Given:** User types "affordable counties with good transit and low pollution"
**When:** LLM processes query with registry context
**Then:** Returns:
```json
{
  "layers": [
    {"layerId": "median_home_value", "weight": 8, "direction": "lower_better"},
    {"layerId": "median_property_tax", "weight": 5, "direction": "lower_better"},
    {"layerId": "public_transit", "weight": 7, "direction": "higher_better"},
    {"layerId": "contamination", "weight": 6, "direction": "lower_better"}
  ],
  "explanation": "Selected housing cost metrics (home value + property tax), public transit access, and EPA contamination levels. Weighted housing slightly higher since 'affordable' was the lead term."
}
```

### Example 5: All Layers Missing for a County (Edge Case)
**Given:** County Y has no data for any of the selected layers
**When:** Scoring runs
**Then:** County Y gets `null` score, appears transparent on choropleth, excluded from ranking

---

## Open Questions

- [x] LLM model choice → Claude Haiku
- [x] Missing data strategy → weight redistribution
- [x] Backend approach → decided later (Phase 2), likely Netlify Functions or Express
- [x] Default direction for all layers → defaults to the registry's `direction` field (matching BLO index semantics). Users can override per-query. This means selecting multiple layers immediately produces sensible scoring without manual direction-setting.
- [x] Geographic filtering → Phase 1. It's a data filtering problem regardless of whether a human or LLM is requesting it. Add state/region filter to ranking panel.
- [x] CSV export from ranking → deferred, low lift but not Phase 1
- [x] BLO composite score → remains as a "preset" that coexists with custom queries. Selecting BLO score is like loading a saved query with predefined layers/weights. Custom queries are independent.
- [ ] Performance: should we debounce weight slider changes or recalculate on every change? (likely debounce at ~100ms)

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-03-27 | Nick + Claude | Initial draft |
