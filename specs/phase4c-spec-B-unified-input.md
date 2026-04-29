# Spec: Unified Input — Ask with Inline Place

**Status:** Draft v0.2 (rewritten 2026-04-28)
**Author:** Nick / Claude
**Date:** 2026-04-28
**Phase:** 4c

---

## Problem Statement

Two visually similar input pills sit side-by-side at the top of the map:

| | Geocoder (top-left, 220px) | Ask / chat (top-center, 518px) |
|---|---|---|
| Placeholder | *Search for a location* | *Ask a question or describe what you're looking for…* |
| Icon | 🔍 magnifier | ☼ orange sparkle |
| Behavior | Mapbox geocoder — jumps to a county/state on selection | Submits to LLM chat |

Users can't tell which to use when. Both read as "search" because the magnifier metaphor dominates. Forcing the user to *first decide which input* — before they've even articulated what they want — is the failure mode. The right fix is not a mode toggle: it's making the system smart enough that the user never has to choose.

---

## Success Criteria

We'll know this works when:

- [ ] One input pill is visible above the map. There is no second visible search/text input field.
- [ ] A user typing a county or state name (e.g., "Mecklenburg County, NC", "Texas") sees inline place suggestions appear *as they type*, without manually switching modes.
- [ ] A user typing a data query (e.g., "best counties for housing", "top 5 with low pollution") sees no place suggestions and submits to chat as today.
- [ ] An ambiguous case ("Houston" — could be a place OR could be the start of "Houston-area counties") shows place suggestions but does not pre-empt the chat submit; the user can still hit Enter to send to chat.
- [ ] Selecting a place suggestion zooms the map and does not create a chat message.
- [ ] Pressing Enter (or clicking Ask) always submits the typed text to chat, regardless of whether place suggestions are showing.
- [ ] The Mapbox geocoder's existing keyboard navigation (arrow keys to highlight suggestions, Enter to pick highlighted) works for the inline place suggestions.
- [ ] Mobile keeps the same behavior — one input, place suggestions appear inline.

---

## Solution Overview

Single input pill, **Ask is the only mode label** — the user never sees "Place" as an option. Under the hood, two parallel things happen as the user types:

1. **Place lookup** runs in the background using the Mapbox geocoder API (already mounted). When it returns matches, a small "Did you mean a place?" suggestion strip renders **directly below the input**, distinct from the chip-style example queries below it. The suggestion strip auto-hides when there are no matches or the input doesn't pattern-match a place query.
2. **Chat input** waits for Enter / Ask click. Submitting always goes to chat.

The user has two clear actions when place suggestions are showing:
- **Click a suggestion** → instant zoom, no chat message
- **Hit Enter** → chat submission, place suggestions dismissed

No mode pill, no toggle. The interface is one thing. Place capability is a *contextual affordance* that surfaces only when relevant.

---

## Detailed Requirements

### Functional Requirements

**Input shell**

1. The unified input shall present a single pill with: leading sparkle icon (orange), single-line text field, trailing "Ask" submit button.
2. Placeholder shall read *"Ask about a place or the data — e.g., 'top 5 affordable counties' or 'Mecklenburg County'"* (or similar — open).
3. Layout: top-center on desktop ≥ 1100px (replaces today's center Ask placement); narrower on intermediate breakpoints; full-width with 8px margins on mobile.
4. The current top-left geocoder DOM (`.geocoder-wrap`) shall be removed from the page. The geocoder *instance* remains (mounted to the map for control purposes), but its visible UI is gone.

**Inline place suggestion strip**

5. As the user types (debounced ~150ms), the system shall query the Mapbox geocoder for place matches.
6. When matches exist AND the system judges them "place-like enough" to surface (see #8), the system shall render a thin suggestion strip immediately below the input pill, listing up to 3 top matches.
7. Each suggestion row shall show: location pin icon + place name + admin context (e.g., "📍 Mecklenburg County · North Carolina") + an `Enter ↩` indicator on hover.
8. **Heuristic for surfacing place suggestions** (combination — all must be true):
   - Geocoder returned ≥1 match.
   - At least one match has type `district`, `region`, or `place` (county / state / city).
   - The user's input text does not contain explicit data-query verbs ("show", "top", "best", "find counties", "with low/high", "filter", "where", "more than", "under", "rank", numeric thresholds, etc.) — see suppression list below.
9. **Suppression list** — if the user's input contains any of the following tokens (case-insensitive, word-boundary), the suggestion strip is hidden even if the geocoder returns place matches: `top`, `best`, `worst`, `affordable`, `with`, `where`, `under`, `over`, `more than`, `less than`, `between`, `compared to`, `rank`, `score`, `index`, percent / `%` characters, dollar / `$` characters.
10. The suggestion strip shall auto-hide:
    - When the input is empty.
    - When the suppression list triggers.
    - When the user submits via Enter / Ask (the strip is dismissed and chat fires).
    - When the user clicks anywhere outside the input region.

**Selecting a place suggestion**

11. Clicking a place suggestion shall trigger the geocoder's selection flow: map zooms, no chat message, suggestion strip dismisses, input clears.
12. Keyboard navigation: arrow-down enters the suggestion strip, arrow-up/down moves through rows, Enter selects the highlighted row, Escape returns to the input without selecting.
13. If the user's text is in the input but no suggestion is highlighted, Enter submits to chat (default behavior takes precedence over implicit place selection).

**Submitting to chat**

14. Pressing Enter when no suggestion row is highlighted, OR clicking the "Ask" button, shall submit the typed text to chat as today.
15. After submission, the input clears, suggestion strip dismisses, example chips dismiss, status strip + chat history flow proceeds as today.
16. Empty input on Enter / Ask: no-op.

**Example-query chips (below input)**

17. Three example chips shall remain visible *only* when:
    - The chat history is empty (no submissions yet in this session), AND
    - The input is empty.
18. The chips dismiss permanently for the session after the first chat submission.
19. Clicking a chip fills the input with the chip text and submits to chat as today.

### Non-Functional Requirements

- **Performance:** Place-lookup debounce: 150ms after last keystroke. Suggestion render must not block keystrokes. Keystrokes never wait on the geocoder API — typing always feels instant.
- **Accessibility:**
  - The input itself shall have `aria-label="Ask about a place or the data"`.
  - The suggestion strip shall use `role="listbox"` with `role="option"` rows; `aria-activedescendant` updates as the user navigates.
  - Suggestion appearance shall be announced to screen readers via `aria-live="polite"` on the strip container.
- **Geocoder rate limits:** Mapbox geocoder is rate-limited per token; existing token is fine for current traffic. Debouncing at 150ms keeps requests bounded.
- **Token budget impact:** Place lookups do NOT hit the LLM; they hit Mapbox. They have zero cost against the daily Anthropic budget. Only chat submissions cost tokens. This is a deliberate value of the design.

---

## System Context

### How It Fits

- **Replaces** `.geocoder-wrap` (top-left) and consolidates onto `.prompt-input-wrap` (top-center) which absorbs place-lookup capability.
- **Reuses** the existing Mapbox geocoder instance — its UI is dismissed but the instance stays attached to the map (for `query` calls and for synchronization with map state).
- **Modifies** `PromptInput.vue`: adds the suggestion strip rendering, debounced geocoder query, suppression heuristic, and selection routing.
- **Modifies** `Map.vue`: removes the `.geocoder-wrap` template region; geocoder instantiation moves into the unified input component (or stays in Map.vue but its DOM is no longer rendered visibly).

### Dependencies

- Mapbox GL Geocoder plugin — used in headless mode (no built-in UI).
- `useChat` composable — unchanged.
- BLO design tokens — already defined.

### Affected Systems

- `Map.vue` — template region cleanup, geocoder mount changes.
- `PromptInput.vue` — adds suggestion strip + place-lookup logic.
- Mobile CSS — needs unification under one input.

---

## Constraints & Boundaries

### In Scope

- Single visible input replacing dual inputs.
- Inline place-suggestion strip with auto-detection.
- Suppression heuristic to avoid noise when intent is clearly a data query.
- Keyboard navigation across input ↔ suggestion strip.
- Mobile-friendly layout.

### Out of Scope

- **Mode pill / explicit toggle** — explicitly removed from this design. The system decides; the user does not toggle.
- **LLM-based intent classification** — first version uses a deterministic heuristic (suppression list). LLM classification could come later if the heuristic misses too often, but adds latency and cost.
- **Voice input.**
- **Multi-line / textarea Ask.**
- **Recent-search history.**
- **"Cross" suggestions** — no county-name suggestions while typing data queries; no data-query suggestions while typing place names. The strip is only place-flavored.

### Assumptions

- Mapbox geocoder API can be queried directly (`geocoder.query(text)` or via `MapboxGeocoder` constructor in headless mode). Confirmed by Mapbox docs.
- The suppression list catches the vast majority of data queries; false positives (showing place suggestions when not wanted) are tolerable because Enter still submits to chat — they're never destructive.
- Users will accept that place suggestions appear contextually rather than via an explicit search bar — this matches modern unified-search patterns (Spotlight, Google Search).

### Technical Constraints

- Must use the existing Mapbox geocoder plugin.
- Must not regress chat behavior, status strip integration, walkthrough triggering.

---

## Examples

### Example 1: Happy Path — Pure Ask
**Given:** Page loaded; chat history empty; input empty; example chips visible.
**When:** User types "best counties for affordable housing" and presses Enter.
**Then:**
- During typing, the suppression list catches "best" and "for affordable" → no place suggestions rendered.
- Enter submits to chat as today.
- Example chips dismiss after submission.

### Example 2: Happy Path — Pure Place
**Given:** Page loaded; user types "Mecklenburg".
**When:** ~150ms after last keystroke.
**Then:**
- Mapbox returns matches like "Mecklenburg County, North Carolina" and "Mecklenburg-Vorpommern, Germany".
- Suggestion strip renders below the input with up to 3 rows.
- User clicks "Mecklenburg County, North Carolina".
- Map zooms to Mecklenburg County. No chat message. Strip dismisses. Input clears.

### Example 3: Place Suggestions + User Submits to Chat Anyway
**Given:** User has typed "Mecklenburg County" and the suggestion strip is showing matches.
**When:** User presses Enter without highlighting any suggestion.
**Then:**
- Suggestion strip dismisses.
- "Mecklenburg County" is sent to chat. The LLM may decide to call `zoom_to_county` itself, or describe data, or whatever it judges appropriate. The suggestion strip was an offer; the user declined by submitting.

### Example 4: Keyboard Selection of a Place Suggestion
**Given:** User has typed "Texas" and suggestion strip is showing.
**When:** User presses arrow-down → focus enters the strip → arrow-down once more → "Texas, USA" is highlighted → Enter.
**Then:**
- Map zooms to Texas. No chat message.

### Example 5: Edge Case — Suppression List Hit
**Given:** User types "top 5 counties in Texas".
**When:** ~150ms after last keystroke.
**Then:**
- Mapbox might return "Texas, USA" as a place match.
- Suppression list catches "top 5", "counties", "in" — strip is suppressed.
- Enter submits the full query to chat. The LLM is responsible for understanding that "in Texas" is a state filter and calling `set_layer_selection` + `filter_ranking_by_state` or similar.

### Example 6: Edge Case — Ambiguous "Houston"
**Given:** User types just "Houston".
**When:** ~150ms after last keystroke.
**Then:**
- Mapbox returns "Houston, Texas" and "Houston County, Georgia".
- No suppression terms detected → strip is shown.
- User chooses: click a suggestion (zoom), or type more then submit (chat). Either path is supported.

### Example 7: Mobile
**Given:** Viewport 390×844 (mobile); page loaded.
**When:** User taps the unified input and types "Mecklenburg".
**Then:**
- Suggestion strip appears below the input, full-width minus 8px margins, max 3 rows.
- Tapping a row zooms the map. Tap-and-Done on the soft keyboard, then tap Ask, submits to chat.

### Example 8: Empty Input
**Given:** Input is empty.
**When:** User clicks Ask or presses Enter.
**Then:** No-op. No chat message. No place lookup.

### Example 9: Erasing While Strip Is Visible
**Given:** Strip is showing with "Mecklenburg County, North Carolina".
**When:** User backspaces back to "Meckl".
**Then:** Geocoder re-queries; strip updates to new matches (or hides if no matches). No flicker — the strip animates updates, not a hide-and-show cycle.

### Example 10: Rapid Typing
**Given:** User types "M-e-c-k-l-e-n-b-u-r-g" quickly (faster than debounce).
**When:** Each keystroke arrives.
**Then:** Geocoder is only queried once, ~150ms after the final keystroke. No request burst.

---

## Decisions Locked

- **No mode pill / no toggle.** Single input. Ask is the canonical action; place is a contextual affordance. (Reverses v0.1 spec.)
- **Default behavior: Ask.** Pressing Enter always submits to chat unless the user has explicitly highlighted a place suggestion via keyboard.
- **Auto-feed into Place via inline suggestion strip.** Place capability surfaces only when the heuristic judges the input to be place-like.
- **Heuristic = deterministic suppression list** for v1. No LLM classification overhead.
- **Typed-text persistence** is irrelevant under this design (no mode switch to preserve across).
- **No keyboard shortcut for switching modes** — there are no modes.
- **Mode-pill placement** — not applicable; no pill.
- **Geocoder in headless mode** — instantiated for its query API; no built-in dropdown UI.
- **Top-center placement on desktop** for the unified input. Top-left geocoder is gone.

---

## Open Questions

- [ ] **Suppression list completeness**: Will need to iterate live. Initial list above is a first cut. False positives (suppressing a legitimate place lookup) should be rare and recoverable; false negatives (showing place suggestions for a clear data query) are visual noise and should be tightened. Add telemetry or a debug mode to surface suppressions for refinement.
- [ ] **Suggestion strip styling**: Distinct from the example chips? Same row format? Stacked rows or horizontal scroll? Recommend stacked rows below the input, visually distinct from the example chips (which sit further below).
- [ ] **What if the geocoder API rate-limits us?** Fall back gracefully — strip just doesn't appear; chat still works.
- [ ] **County-name disambiguation**: When Mapbox returns "Mecklenburg County" without state context (rare but possible for unusual names), include the state in the row. The Mapbox response includes this in `place_name` already.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-28 | Nick / Claude | Initial draft (mode-pill design) |
| 0.2 | 2026-04-28 | Nick / Claude | Rewritten: no mode pill; Ask-first with inline place suggestions auto-detected via suppression heuristic |
