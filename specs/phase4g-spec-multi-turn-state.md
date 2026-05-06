# Spec: Multi-Turn Chat State — Atomic Tool + Turn Snapshots

**Status:** Draft
**Author:** Nick A.B. + Claude
**Date:** 2026-05-06
**Phase:** 4g

---

## Problem Statement

The conversational layer works at the language level — context carries, "the second one" resolves, the LLM produces real reasoning — but the underlying tool layer thinks in singletons (one filter, one state, one query at a time) while the LLM thinks in regions and concepts. This seam produces three concrete failures: (1) "show me the Southeast" loops the single-state filter once per state, replacing each prior call until the tool-call cap stops the chain mid-region; (2) the chat thread and the County Rankings panel disagree because the LLM's reply describes a result set the rankings panel never actually computed; (3) the entire conversation evaporates on browser reload, with no way to revert to an earlier research state.

---

## Success Criteria

We'll know this works when:

- [ ] **Multi-state queries succeed in one tool call.** "Counties in the Southeast" produces one `set_query_state` call with `regionStates: ["VA","NC","SC","GA","FL","AL","MS","TN","KY","WV","AR","LA"]` (or equivalent), not 9 single-state calls. Tool-call count for this turn ≤ 2.
- [ ] **Chat reply and rankings panel never disagree.** Whatever counties the LLM names in its narrative reply are exactly the counties the rankings panel currently shows (and they're a subset of `rankedCounties` after current filters apply). Verified by: LLM reply listing N counties → rankings panel "Showing N of M" matches.
- [ ] **Conversation survives reload.** Starting a 5-turn convo, hard-refreshing the browser, and seeing the same thread restored, with the same map state from the last turn. Persistence key `blo:conversation`, schema-versioned, TTL 7 days.
- [ ] **Any prior user message in the thread is clickable to rewind.** Clicking the user bubble for turn 3 of a 5-turn convo restores: the layer/filter/limit set at turn 3, the inspected county at turn 3, and which county was selected for the rail at turn 3. Subsequent turns are *not* deleted — the thread is read-only history; only the map snapshot rewinds.
- [ ] **Tool-call cap doesn't dead-end the user with dev text.** When a turn hits the cap, the user sees a plain-English fallback offering an alternative ("I started filtering 9 states one at a time and ran out of attempts. Want me to try the 5 most populous, or pick a single state?"), not "Too many tool calls. Stopping."

---

## Solution Overview

Two architectural changes that reinforce each other:

**(1) `set_query_state` — atomic single-tool replacement.** The LLM picks the *whole desired state* (layers, filters, limit, optional region/state list) in one tool call. The client applies it atomically. This makes chat↔rankings disagreement impossible by construction (the rankings panel reads the same state the LLM just set), eliminates the multi-call loop pattern, and gives us a clean unit to snapshot.

**(2) Turn-boundary state snapshots.** At the end of each user turn, the client serializes a snapshot — `{layers, filters, limit, currentCounty, listingsActive}` — and attaches it to that turn's user message. This snapshot shape is small (~200 bytes), trivially serializable, and supports both reload-persistence (whole `messages` array → `localStorage["blo:conversation"]`) and per-turn rewind (click bubble → apply that snapshot to map state).

The two changes share an invariant: **whatever's in the latest snapshot IS the live map state.** No separate "what is currently displayed" tracking — the snapshot tail is the truth.

---

## Detailed Requirements

### Functional Requirements

**Tool layer:**

1. The system shall expose a new `set_query_state` tool that accepts:
   - `layers: { layerId, weight, direction }[]` — replaces all current scoring layers
   - `filters: { layerId, operator, value, max? }[]` — replaces all current threshold filters (empty array means clear)
   - `limit: number | null` — top-N cap, null means show all matching
   - `regionStates: string[]` — optional 2-letter state codes to constrain the rankings; empty/missing means "all states"
   - `explanation: string` — narrative shown to user
2. The system shall remove the `set_layer_selection` and `filter_ranking_by_state` tool definitions from the active toolset. The chat prompt shall guide the LLM to use `set_query_state` for any state mutation.
3. The system shall keep `zoom_to_county`, `show_county_details`, `search_housing`, `toggle_ranking_panel` as-is — those are read/UI-only side effects, not state mutations.

**Snapshot layer:**

4. After each `sendMessage()` resolves successfully, the system shall capture a `TurnSnapshot` object with shape `{ layers, filters, limit, currentCountyId, currentCountyName, listingsCount }` and attach it to the *user message* that triggered the turn (so the snapshot represents "the state when the user said this").
5. The system shall persist the entire `messages` array (with attached snapshots) to `localStorage["blo:conversation"]` after each turn, schema-versioned with `{ v: 1, savedAt: ISO8601, messages: [...] }`.
6. On `useChat()` mount, the system shall hydrate from `blo:conversation` if present and if `savedAt` is within 7 days. On expiry or schema mismatch, clear and start fresh.
7. The system shall apply the *most recent* snapshot's state on hydration so the map matches the resumed thread.
8. The system shall make every user message bubble in the chat thread clickable. Click → applies that bubble's attached snapshot via the same code path the LLM uses (no special "rewind" branch).

**Failure UX:**

9. When the chat loop hits `MAX_TOOL_CALLS_PER_TURN`, the system shall replace the current "Too many tool calls in one turn. Stopping." with a copy that names the apparent intent and suggests an alternative — e.g. "I tried to do too many filter operations in one turn. Want me to try a different approach, like filtering by region instead of state-by-state?" — surfaced via the existing inline error bubble.

### Non-Functional Requirements

- **Performance:** Snapshot serialization < 5ms per turn. localStorage write < 10ms. Hydration on mount < 20ms. Snapshot size < 1KB per turn typical.
- **Reliability:** localStorage write failures (quota, private mode) must not break chat — fail silently and log once.
- **Backward compatibility:** Existing live deployments using `set_layer_selection` or `filter_ranking_by_state` in cached chat history continue to render (treat as historical / no-op replay) but new turns can't produce them.
- **Security:** No PII in localStorage beyond what's already in the chat (county queries are not sensitive, but the convention is "don't expand the surface").

---

## System Context

### How It Fits

```
PromptInput.vue ─────▶ useChat.ts ─────▶ /api/chat ─────▶ chatHaiku ──▶ Anthropic
       │                  │                                    │
       │                  │                                    └─▶ tool: set_query_state
       │                  │                                          (replaces set_layer_selection +
       │                  ▼                                           filter_ranking_by_state)
       │           [TurnSnapshot capture]
       │                  │
       │                  ▼
       │           localStorage["blo:conversation"]
       │                  │
       └─◀───── click user bubble ─◀────┘
                  applies snapshot via Map.vue's existing
                  handleQueryResult + setRankingStateFilter paths
```

### Dependencies

- `src/composables/useChat.ts` — owns messages array, snapshot capture, localStorage I/O
- `src/lib/mapTools.ts` — tool dispatcher, gets new `set_query_state` case + drops the two old cases
- `server/src/prompt/chatPrompt.ts` — prompt rewrite to teach LLM the new tool
- `server/src/prompt/toolDefinitions.ts` — tool schema swap
- `server/src/services/haiku.ts` — `VALID_LAYER_IDS`/`VALID_OPERATORS` already exist; reuse for new tool's input validation
- `src/components/PromptInput.vue` — render snapshot rewind affordance on user bubbles
- `src/components/Map.vue` — exposes `applyQueryState(snapshot)` for both LLM tool and rewind clicks

### Affected Systems

- **County Rankings panel** — auto-syncs because it reads from the same `scoringQuery + activeFilters + limit + rankingStateFilter` refs that `set_query_state` writes
- **Lens header** — descriptor / clear behavior unchanged
- **CountyRail** — current-county snapshot field drives whether rail is open and on which county after rewind
- **Walkthrough** — out of scope; rewinding into a walkthrough state is deferred

---

## Constraints & Boundaries

### In Scope

- One new tool `set_query_state` replacing two existing tools
- TurnSnapshot capture + attach to user messages
- localStorage persistence keyed `blo:conversation`, schema v1, 7-day TTL
- Clickable user-bubble rewind in chat thread
- User-facing tool-call-cap error copy

### Out of Scope

- **Streaming responses.** The Mecklenburg comparison truncation is real but requires SSE end-to-end; deferred to a separate phase.
- **Cross-browser-tab sync.** Two open tabs each maintain their own `blo:conversation`; last-write-wins on the same key. Acceptable.
- **Walkthrough state in snapshots.** Walkthrough mode is its own state machine; rewinding into a partial walkthrough is messy. If snapshot was taken during a walkthrough, restore inspectActive=false (just close it).
- **Server-side conversation persistence.** Local-only, no account-bound history. If the user clears localStorage, history is gone — same UX as today.
- **Editing prior turns.** The thread is append-only history. Click-to-rewind restores state but does not delete or edit the messages that came after.
- **Snapshot diff-rendering.** No "what changed since the previous snapshot" UI — just whole-state replacement.

### Assumptions

- Multi-state filter semantics are "OR within the array" (county passes if its state is in the list).
- The LLM, given a clear `set_query_state` prompt with examples, will reliably emit ≤2 tool calls per turn for typical queries.
- localStorage is available on all target browsers (degrades gracefully if not).
- Existing scoring code in `usePersonalizedScore.ts` doesn't care how the layers/filters got there — it'll work with `set_query_state` output unchanged.

### Technical Constraints

- Must continue to use Anthropic's tool-use API; no migration to a different LLM contract.
- TypeScript strict; new tool must have full type coverage end-to-end (server schema → client dispatcher → snapshot type).
- No new runtime dependencies. Snapshot/persistence is pure ref + JSON.stringify.

---

## Examples

### Example 1: Happy Path — Region query in one tool call

**Given:** The user has been chatting with the map and just said "show me the top 10 affordable counties in the Southeast with high Black population."

**When:** The LLM responds.

**Then:** The model emits a single tool call:

```json
{
  "name": "set_query_state",
  "input": {
    "layers": [
      { "layerId": "median_home_value", "weight": 8, "direction": "lower_better" },
      { "layerId": "pct_Black", "weight": 6, "direction": "higher_better" }
    ],
    "filters": [],
    "limit": 10,
    "regionStates": ["VA","NC","SC","GA","FL","AL","MS","TN","KY","WV","AR","LA"],
    "explanation": "Ranking Southeast counties by housing affordability (lower home values weighted highest) and Black population share. Top 10 across 12 states."
  }
}
```

The map recolors, the rankings panel shows 10 counties — all from the named states — and the chat narrative names exactly those 10 counties. A turn snapshot is attached to the user message capturing the 12-state filter.

### Example 2: Failure Case — Browser reload mid-research

**Given:** The user has done 5 turns refining a query, with the latest turn showing "Top 5 affordable Black-majority counties" highlighting Macon County, AL on the map.

**When:** The user hard-refreshes the browser (cmd-shift-R).

**Then:** On `useChat` mount, hydration reads `blo:conversation`, finds 5 turns saved 12 minutes ago (within 7-day TTL), restores the messages array, and applies the most recent snapshot — layers/filters/limit/currentCounty all match the pre-refresh state. The user sees their thread, scrolled to the latest reply, with the map already colored and Macon County still inspected.

### Example 3: Edge Case — Click-to-rewind to turn 3 of a 7-turn convo

**Given:** The user has 7 turns in the thread. Turn 3 was "narrow to Mississippi only," turn 5 was "actually expand to all Southeast." The map currently reflects turn 7.

**When:** The user clicks the user-bubble for turn 3.

**Then:** The map state restores to turn 3's snapshot (Mississippi-only filter, the layers active at turn 3, the county inspected at turn 3). Turns 4-7 remain in the thread unchanged but visually marked as "ahead of current state" (subtle treatment — out of scope to fully design here, but messages must remain visible). Clicking turn 7's bubble jumps forward again.

### Example 4: Edge Case — Stale or corrupted persisted snapshot

**Given:** A user has `blo:conversation` from 8 days ago in localStorage, OR the schema has bumped to v2 since their last visit.

**When:** They open the page.

**Then:** Hydration sees `savedAt` outside the 7-day TTL (or `v` mismatch), clears the key silently, and the chat starts empty as it would for a first-time user. No crash, no error banner — the loss is by policy.

### Example 5: Failure Case — Tool-call cap hit

**Given:** The user, mid-conversation, says something the LLM interprets as needing many tool calls (despite the new atomic tool — e.g. "compare top 3 counties in each of these 9 states").

**When:** The chat loop runs `MAX_TOOL_CALLS_PER_TURN` (10) iterations without `end_turn`.

**Then:** Instead of "Too many tool calls in one turn. Stopping." the user sees an inline error bubble: "I started doing this in pieces and ran out of steps. Want me to focus on the top 3 across the whole region, or pick one state to drill into?" The thread shows whatever partial work *did* land (e.g. a recolored map for the first state) — those tool effects aren't rolled back.

---

## Open Questions

- [ ] **Tool-cap fallback copy: dynamic vs static?** The plain-English fallback could be templated (replace "{intent}" by inspecting which tool was called repeatedly) or a single static line. Static is simpler v1; dynamic is more useful but requires intent classification.
- [ ] **Should rewinding to an earlier turn truncate later turns?** Currently spec'd as "no — thread is append-only." Alternative: rewind = delete messages after that point + return user to free entry. The append-only version preserves research history but creates ambiguous state ("which turn am I at?"). Recommended default: keep append-only with subtle visual marker for "ahead of current," no truncation.
- [ ] **How does region resolution work?** "Southeast" must become `["VA","NC",...]` somewhere. Options: (a) LLM hard-codes the mapping in prompt examples; (b) server-side region dictionary that the prompt references by name; (c) client-side resolution after the LLM emits a region keyword. Recommended: prompt examples + the LLM reads US Census regional groupings — its training data has this. Keep server stateless on geography.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-05-06 | Nick + Claude | Initial draft from /spec-design |
