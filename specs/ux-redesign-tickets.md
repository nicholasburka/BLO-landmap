# UX Redesign Tickets: Map-First Layout + BLO Brand Identity

**Branch:** `ux-redesign-phase4b`
**Date:** 2026-04-23
**Author:** design pass triggered after Phase 4a complete

---

## Problem Statement

Two concrete usability concerns surfaced after Phase 4a shipped:

1. **The map is the product, but it's the smallest element on screen.** Panels (Data Layers, Color Key, County Averages, Ranking Panel, chat history) occupy ~40% of a 1440px viewport. When a query result lands, the chat history expands and often occludes the map it describes.
2. **Two inputs at the top are visually indistinguishable.** The Mapbox geocoder (location search) and the AI chat prompt sit side-by-side at `top: 10px`, with similar containers, similar icons, and overlapping copy patterns ("type a place" vs. "ask a question"). Users can't tell which to use when.

Additionally, the app has **no brand identity** — it reads as a generic civic data tool. The product serves two audiences:

- **Data journalism** — journalists, policy analysts, researchers who need authority and rigor
- **Homebuying research** — Black individuals and families evaluating where to live, who need warmth, trust, and agency

The tool should hold both. The homebuying use case should be **easily at hand** without being the forced framing.

---

## Design Anchors

### Palette — anchored in blacklandownership.com

From the BLO website + merch:

| Token | Hex | Role |
|---|---|---|
| `--blo-green` | `#37B34A` | Primary brand accent, positive data signal |
| `--blo-green-deep` | `#1F7A2E` | Hover / emphasis |
| `--blo-ink` | `#111111` | Headlines, primary text |
| `--blo-cream` | `#F7F4EE` | Surface / card background (warm off-white) |
| `--blo-cream-deep` | `#EDE8DD` | Recessed panels, dividers |
| `--blo-stone` | `#6B6560` | Secondary / muted text |
| `--blo-orange` | `#FF6B1C` | **Reserved for AI / "Ask" input only** |

Rationale: the BLO brand is NOT warm-earth/terracotta — it's bold kelly green + black + cream with safety orange as the merch accent. Using orange exclusively for the AI input makes "this is a conversation, not a search" unmistakable without any copy changes.

### Typography

Minimal initial pass — stay on system sans for body, introduce one display serif for headings and county names (homebuying warmth + editorial authority). Candidates: **Fraunces**, **Source Serif 4**, **DM Serif Display**. Final pick deferred to UX-03.

### Copy

**Minimal copy changes.** Human writing later. Placeholder defaults stay as-is unless a swap is trivial. The *structural* design should make the homebuying use case accessible — no forced "are you looking for a home?" framing.

---

## Scope

**In scope (three tickets):**
- **UX-01** — quick wins: input differentiation, auto-open ranking on result, chat-history cap, active-query status strip. ~2 hours.
- **UX-02** — layout: collapse Data Layers by default, reposition location search as a utility, unify panel visual hierarchy, reframe ranking as cards. ~½ day.
- **UX-03** — identity: typography system, full palette rollout, motion polish, subtle home/land iconography accents. ~1.5 days.

**Out of scope for this redesign:**
- Changing actual data-layer content or scoring logic
- Rewriting user-facing copy beyond minimal structural labels (human will write)
- Mobile-first redesign (mobile remains functional; refinements in a later pass)
- Onboarding or first-run tour
- Accessibility audit (separate effort)
- Phase 4b manual threshold sliders (still deferred)

---

## Dependency Graph

```
UX-01 (quick wins, shippable standalone)
  └── UX-02 (layout, depends on UX-01 tokens in place)
        └── UX-03 (identity, depends on UX-02 structure)
```

Each ticket is independently shippable and reviewable. Merge gate: all three complete, or merge UX-01 alone for a smaller first iteration.

---

## UX-01: Quick Wins — Input Differentiation + Result Surfacing

**Type:** UX
**Size:** S (~2 hours)
**Blocked by:** None
**Blocks:** UX-02

### Description

Fix the two reported concerns with the smallest structural diff possible. No copy rewrites. No layout rearrangement beyond what's necessary to differentiate the inputs.

### Changes

**1. BLO design tokens in `src/assets/base.css`**

Add the `--blo-*` CSS custom properties listed in Design Anchors. Leave existing `--vt-c-*` and `--color-*` tokens in place (they're used by router scaffolding).

**2. AI chat input styling in `src/components/PromptInput.vue`**

- Background: `var(--blo-cream)` instead of white
- Border: `1px solid var(--blo-orange-ring)` (subtle warm ring)
- Icon: replace/add a sparkle/wand glyph at the input's leading edge (inline SVG, single color `var(--blo-orange)`)
- Focus state: `box-shadow: 0 0 0 3px var(--blo-orange-soft)`
- Keep current placeholder text (user will rewrite) OR swap to the terser: "Describe what you're looking for" — leave as a single-line code comment for the human writer
- Max-width stays ~600px; no layout reflow

**3. Location search (Mapbox geocoder) styling in `src/components/Map.vue`**

- Override geocoder input container: neutral white bg, thin `1px solid var(--blo-cream-divider)`, subtle shadow
- Collapse default width from ~240px to ~180px
- Keep existing magnifier icon and placeholder — it's already clearly "search"
- Add a small `Search place` or similar label above (optional, can defer to UX-02)

**4. Auto-open ranking panel on result in `src/components/Map.vue`**

In the `setLayerSelection` handler (the one passed into `ToolContext`), after applying layers, set `rankingPanelExpanded.value = true`. If the user has manually collapsed it, respect that (track a `rankingManuallyCollapsed` flag that resets on a fresh query).

**5. Chat-history height cap in `src/components/PromptInput.vue`**

- Message list max-height: `min(30vh, 320px)` (currently uncapped)
- Internal scroll with `overflow-y: auto`
- Add a subtle top/bottom fade mask when scrollable

**6. Active-query status strip (new, small)**

Inline into `PromptInput.vue` or a tiny new child. Shows when `activeFilters.length > 0` or scoring layers are active:

```
┌────────────────────────────────────────────────────────┐
│ Scoring: [Black homeownership ↑] [Median home value ↓] │
│ Filter: [pct_Black > 30]   •   Top 5   •   [ Clear × ] │
└────────────────────────────────────────────────────────┘
```

- Pill-style chips for each active layer + filter
- Single Clear button (wires into existing `clearAll` flow)
- Hidden entirely when no query is active

### Acceptance Criteria

- [ ] Design tokens `--blo-*` exist in `base.css` and are used (not hardcoded hexes) in new component styles
- [ ] AI input visually distinct from location search at a glance (orange accent, different icon)
- [ ] Running a query auto-expands the ranking panel
- [ ] Chat history never exceeds 30vh; scrolls internally when longer
- [ ] Active-query strip appears after a scoring query; disappears when cleared
- [ ] No existing behavior regresses (tool calls still work, walkthrough still works, filter pill in ranking panel still works)
- [ ] Playwright screenshot shows the diff

### Out of Scope

- Reflowing the top bar layout (both inputs stay at top)
- Changing the Data Layers panel
- Changing copy beyond icon / pill labels
- Typography / font changes (deferred to UX-03)

---

## UX-02: Layout — Map-First Spatial Rebalance

**Type:** UX
**Size:** M (~½ day)
**Blocked by:** UX-01
**Blocks:** UX-03

### Description

Rebalance the spatial composition so the map gets the stage. Collapse peripheral controls by default; promote answer-surfacing UI. Panel visual hierarchy unified.

### Changes

**1. Data Layers panel collapsed by default in `src/components/LayerControls.vue`**

- Default state: a slim vertical rail at the right edge showing only "⚙ Layers" and maybe the active-layer count
- Click to expand into the full 7-category accordion as it exists today
- Persist state in `localStorage` so manual layer users aren't re-collapsed on each visit
- BLO Livability Index top-level toggle remains visible when collapsed (one-line pill)

**2. Ranking panel reframed as "Places to consider" cards in `src/components/RankingPanel.vue`**

- Header copy change (minimal): "Ranked counties" → "Places to consider" (if user agrees; otherwise leave current)
- Each row becomes a card: county name in serif/display face, state pill, composite score badge, 1-line "why" snippet (e.g., "High homeownership, low cost of living")
- Card background: `var(--blo-cream)`, border: `1px solid var(--blo-cream-divider)`
- Active walkthrough card gets `border-color: var(--blo-green)`
- Desktop: vertical stack as today. Future: responsive horizontal strip (deferred).

**3. Location search relocated in `src/components/Map.vue`**

- Move geocoder from `top-left` to `bottom-right` of the map (Mapbox-standard location for zoom/utility controls)
- Shrinks to collapsed icon-only state; expands on focus
- Removes the "two inputs at the top" visual ambiguity for good
- Keep keyboard shortcut (if any) working

**4. Unified panel visual hierarchy**

Establish three tiers via shared classes in `base.css`:

- `.blo-panel--primary` — strong shadow, cream bg (used by Ranking Panel)
- `.blo-panel--reference` — muted shadow, translucent cream (Color Key, County Averages)
- `.blo-panel--control` — flat, no shadow, neutral (Data Layers rail)

Apply these to existing panels; remove per-component shadow/background declarations.

**5. Map gets more canvas**

- Increase the gap between chat input and Data Layers panel so the map center is actually in the center
- Bottom-left panel stack (Color Key + Averages) shrinks to a single combined card with tabs OR an expand/collapse button
- Goal: continental US map viewable without scrolling within a 1280×720 viewport

### Acceptance Criteria

- [ ] Data Layers collapsed on first load; expanded state persists per-user
- [ ] Location search not at top of screen anymore
- [ ] All floating panels use one of the three `.blo-panel--*` tier classes
- [ ] Ranking panel renders as cards (at minimum: cream bg, serif county name, muted metadata)
- [ ] Continental US visible without overlap in 1280×720 viewport
- [ ] All prior flows still work (LLM queries, walkthrough, filter clear, etc.)
- [ ] Playwright pass on default state + active-query state

### Out of Scope

- Typography / font selection (UX-03)
- Adding new interactions or affordances
- Mobile layout refinement
- Reordering of layer categories inside Data Layers

---

## UX-03: Identity — Typography, Motion, Iconography

**Type:** UX / Brand
**Size:** L (~1.5 days)
**Blocked by:** UX-02
**Blocks:** none

### Description

Final identity pass. Introduces display serif, subtle motion, and homebuying-adjacent iconography moments. Elevates the tool from "functional" to "has a point of view."

### Changes

**1. Typography system**

- Add display serif via `<link>` in `index.html`: pick ONE of Fraunces, Source Serif 4, DM Serif Display. Default recommendation: **Fraunces** (friendly + authoritative)
- Body face stays system sans initially; can introduce General Sans or Manrope in a follow-up
- Apply serif to:
  - App header site title
  - County names in Ranking Panel cards
  - County name in CountyModal header
  - AI response text (the explanation under active-query strip)
- Establish `--blo-font-display` and `--blo-font-body` tokens

**2. Motion polish**

- Ranking panel cards: stagger-fade in on mount (`animation-delay: calc(var(--index) * 40ms)`)
- AI response text: typewriter reveal on arrival (can be simple opacity + translateY; full typewriter is nice-to-have)
- Choropleth color transitions: use Mapbox paint-property transitions instead of snap
- County modal: scale-in instead of hard appearance

**3. Iconography accents**

- Replace generic emoji/Unicode icons with a minimal custom SVG set (can hand-draw or pick from Lucide/Phosphor):
  - Sparkle/wand for AI input
  - Magnifier for location search
  - Rolling hills or mountains motif near the ranking panel header (tiny, not a centerpiece) — echoes BLO logo
  - House silhouette (subtle, in Color Key legend footer or similar low-stakes spot)
- Style: thin-weight line icons, single color inherits current text color
- Avoid making iconography shout "HOMEBUYING" — subtle supporting cues only

**4. Header polish in `src/App.vue`**

- Cream bg (`var(--blo-cream)`) instead of `#f0f0f0`
- BLO logo remains; site title in display serif
- Thin `var(--blo-cream-divider)` bottom border

### Acceptance Criteria

- [ ] One display serif font loaded and applied to county names, app title, AI responses
- [ ] Stagger-fade motion on ranking cards
- [ ] At least 2 iconography moments (sparkle on AI input, one land/home motif)
- [ ] No hardcoded colors outside of `base.css` tokens
- [ ] Google Fonts or equivalent source documented in the spec
- [ ] Final Playwright screenshot comparison with pre-UX-01 state

### Out of Scope

- Full icon set redesign
- Custom font hosting (Google Fonts acceptable)
- Dark mode
- Animation library integration (Motion, Framer) — CSS-only is sufficient
- Marketing site / about page revamp

---

## Merge Strategy

- Each ticket lands as its own commit on `ux-redesign-phase4b`
- After UX-01: eyeball, Playwright pass, decide to continue or merge-early
- After UX-02: same
- After UX-03: squash-merge or retain as three commits into `main`

## Risks

- **UX-02 Data Layers collapse** risks hiding controls power-users rely on. Mitigation: persist expanded state per-user + a visible "⚙ Layers" affordance that never hides.
- **UX-03 typography load** risks FOUT or layout shift. Mitigation: `font-display: swap` + reserve space via `line-height` tokens.
- **Motion in UX-03** risks feeling gimmicky. Mitigation: keep animations under 250ms, respect `prefers-reduced-motion`.

## Open Questions

- Does the Ranking Panel copy swap ("Ranked counties" → "Places to consider") need human sign-off? Default: yes, leave for human.
- Should the chat history drawer be relocated entirely (bottom-left, or side drawer) in UX-02? Default: no, keep current position; only cap height in UX-01.
- Do we need a "View conversation" button to expose full chat history when capped? Default: yes, add in UX-02 if the capped list feels too hidden.
