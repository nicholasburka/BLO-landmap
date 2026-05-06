# Phase 4g Tickets — Multi-Turn Chat State

**Spec:** `specs/phase4g-spec-multi-turn-state.md`
**Date:** 2026-05-06
**Author:** Nick + Claude

---

## Sequencing

Land in this order. Each ticket builds on prior ones.

```
Q1 — Fix silent 401 drop      (XS, P0 Bug)         ── quick win
Q2 — Tool-cap copy             (XS, P1 Bug)         ── quick win
─────────────────────────────────────────────────────
T1 — set_query_state tool      (M, P0 Feature)      ── structural
T2 — Turn snapshots + persist  (M, P0 Feature)
T3 — Click-to-rewind           (S, P1 Feature)
```

Q1 + Q2 are independent of the spec and of each other; either can ship first.
T1 must land before T2 so snapshots capture the new unified state shape.
T3 needs T2's snapshot infrastructure.

---

# [BUG] Q1 — Silent 401 swallows user message after auth expiry

**Type:** Bug
**Priority:** P0 (Critical)
**Size:** XS (hours)
**Dependencies:** None

---

## Summary

After a 401 response from `/api/chat`, the user's message vanishes from the conversation thread with no acknowledgment — they don't know it failed. Surface an inline error and preserve the message.

---

## Bug Description

**Expected:** When auth expires, the user sees a clear inline error in the chat thread ("Session expired — please sign in again") attached to the message they just tried to send. The message they typed remains visible above the error.

**Actual:** `useChat.postChat()` on 401 calls `clearAuth()`, sets `messages.value = []`, and returns null. The user's message they just typed is *deleted* from the thread along with everything else. From the user's perspective, they typed a question, hit Enter, the input cleared, and nothing happened — no reply, no error, no trace of their message.

**Steps to Reproduce:**
1. Open the app and start a chat.
2. Wait for the auth token to expire (or manually invalidate it).
3. Type a follow-up message and submit.
4. Observe: thread goes empty, no error.

---

## Acceptance Criteria

### Scenario 1: 401 with messages already in thread
**Given:** A user has a 5-message conversation in the thread.
**When:** Their next message returns 401 from the server.
**Then:** The 5 prior messages remain visible. The new user message remains visible. An inline `chat-message--error` bubble appears below the new user message reading "Session expired — please sign in again." `clearAuth()` still fires so the auth ref reflects the expired state.

### Scenario 2: 401 with retry-after-reauth
**Given:** A user has just signed back in after a 401.
**When:** They retry their message.
**Then:** It sends normally and gets a reply. (No special retry logic needed in this ticket — the error bubble is the only signal; user can re-submit manually.)

---

## Out of Scope

- Automatic retry of the 401'd message after re-auth. Worth doing later but separate ticket.
- Changing the auth flow itself.

---

## Files to Create/Modify

- `src/composables/useChat.ts` — in `postChat()`, replace `messages.value = []` on 401 with `pushError('Session expired — please sign in again.')` and remove the `error.value = null` reset.

---

# [BUG] Q2 — User-friendly tool-call-cap message

**Type:** Bug
**Priority:** P1 (High)
**Size:** XS (hours)
**Dependencies:** None

---

## Summary

When a chat turn hits `MAX_TOOL_CALLS_PER_TURN`, the user sees the developer string "Too many tool calls in one turn. Stopping." Replace with plain-English copy that names the apparent intent and offers an alternative action.

---

## Acceptance Criteria

- [ ] The error bubble shown when `toolCallCount >= MAX_TOOL_CALLS_PER_TURN` reads roughly: "I started doing this in pieces and ran out of steps. Want me to try a different approach — like filtering by region instead of state-by-state?"
- [ ] Copy is a single string (no templating in this ticket).
- [ ] Renders via the existing inline `chat-message--error` bubble path (no new visual treatment).

---

## Files to Create/Modify

- `src/composables/useChat.ts` — replace the `pushError('Too many tool calls in one turn. Stopping.')` string.

---

# [FEATURE] T1 — Atomic `set_query_state` tool

**Type:** Feature
**Priority:** P0 (Critical)
**Size:** M (2-3 days)
**Dependencies:** Q1, Q2 (clean baseline; not strictly blocking)

---

## Summary

Replace the two singleton tools `set_layer_selection` and `filter_ranking_by_state` with a single atomic `set_query_state` that takes the entire desired query state (layers + filters + limit + region states) in one call. Eliminates multi-call loops and makes chat↔rankings disagreement impossible by construction.

---

## User Story

As a user asking the chat about regional or multi-criteria queries,
I want one well-formed result that matches both the chat narrative and the rankings panel,
so that I trust what I'm seeing and don't have to re-issue queries when the AI hits the tool-call cap mid-region.

---

## Context

Currently the LLM has two separate tools to mutate query state:
- `set_layer_selection({ layers, filters?, limit? })` — sets scoring layers
- `filter_ranking_by_state({ state })` — narrows rankings to a single state

For "Counties in the Southeast," the model loops the second tool 9-12 times, each call replacing the prior filter. Tool-call cap stops it mid-region.

`set_query_state` accepts a `regionStates: string[]` array so the same query is one tool call. Validation, atomicity, and prompt clarity make it the single mutation point.

See `specs/phase4g-spec-multi-turn-state.md` Examples 1 and 5.

---

## Requirements

### Functional Requirements

- [ ] New tool `set_query_state` defined with input schema:
  - `layers: { layerId, weight (1-10), direction (higher_better|lower_better) }[]`
  - `filters: { layerId, operator (greater_than|less_than|between), value, max? }[]`
  - `limit: number | null` (1-50, null/omitted means show all)
  - `regionStates: string[]` (2-letter US state codes; empty/missing means all states)
  - `explanation: string`
- [ ] `set_layer_selection` and `filter_ranking_by_state` removed from `TOOL_DEFINITIONS`.
- [ ] Server-side validation rejects unknown layer IDs, invalid operators, weights outside 1-10, limits outside 1-50, and state codes not matching `/^[A-Z]{2}$/`. Validation mirrors the existing checks in `haiku.ts` for the old tool.
- [ ] Client-side dispatcher in `mapTools.ts` translates the tool input into the existing reactive refs (`scoringQuery`, `activeFilters`, `activeLimit`, `rankingStateFilter`). For `regionStates: ["MS"]`, write the single state to `rankingStateFilter`. For `regionStates: ["VA","NC","SC",...]`, extend `rankingStateFilter` to accept an array (small Map.vue change) — alternatively, add a second ref `rankingStateFilters: string[]` and feed both into RankingPanel filtering.
- [ ] `chatPrompt.ts` updated with: tool description, examples for region queries, examples for the dual-layer Black-homeownership case (existing rule preserved), and explicit guidance that this tool replaces both prior mutators.

### Technical Requirements

- [ ] Full TypeScript types end-to-end. New tool input type exported from `haiku.ts` and consumed in `mapTools.ts`.
- [ ] Backward-compat: if a chat history loaded from localStorage (post-T2) contains old `set_layer_selection` or `filter_ranking_by_state` tool calls, render them as historical text but do not replay/dispatch them.

---

## Acceptance Criteria

### Scenario 1: Multi-state region query in one tool call
**Given:** A user asks "Top 10 affordable Southeast counties with high Black population."
**When:** The LLM responds.
**Then:** Exactly one `set_query_state` tool call fires with `regionStates` containing all 12 Census-Bureau Southeast states. The rankings panel shows ≤10 counties, all from those states. The chat narrative names exactly the counties the rankings panel shows. Tool-call count for this turn ≤ 2.

### Scenario 2: Single-state filter still works
**Given:** A user asks "Just show me Mississippi."
**When:** The LLM responds.
**Then:** One `set_query_state` call with `regionStates: ["MS"]`. The rankings panel and choropleth restrict to MS counties.

### Scenario 3: Clearing all state
**Given:** A user has an active query with filters and a region.
**When:** They say "Reset" or "show me everything."
**Then:** One `set_query_state` call with empty layers, empty filters, null limit, empty regionStates. The rankings panel returns to its full unfiltered view.

### Scenario 4: Invalid input rejected
**Given:** The LLM emits a `set_query_state` with `regionStates: ["XYZ", "QQ"]`.
**When:** The server validates.
**Then:** Invalid codes are stripped (or the whole call rejected if all codes are bad). Server response carries a clear `tool_result` content explaining what was filtered. The choropleth doesn't apply nonsense state filters.

---

## Out of Scope

- Region-name-to-state-list resolution server-side. The LLM emits the array; we don't have a server dictionary of "Southeast" → states. Prompt examples cover common regions; the LLM resolves from training data.
- Historical replay of old `set_layer_selection`/`filter_ranking_by_state` tool calls in pre-existing chat history. They're text-only after T2.
- Multi-state filter UI in the rankings panel (state dropdown stays single-select for direct user picks). The multi-state filter only applies via chat.

---

## Technical Notes

The simplest integration with the existing rankings code is to widen `rankingStateFilter` from `string | null` to `string[] | null` (empty array == null). RankingPanel's existing single-state dropdown can write a length-1 array. The chat path can write any-length array.

Prompt examples to include in `chatPrompt.ts`:

```
User: "Top 10 affordable Southeast counties with high Black population"
→ set_query_state({
    layers: [
      { layerId: "median_home_value", weight: 8, direction: "lower_better" },
      { layerId: "pct_Black", weight: 6, direction: "higher_better" }
    ],
    filters: [],
    limit: 10,
    regionStates: ["VA","NC","SC","GA","FL","AL","MS","TN","KY","WV","AR","LA"],
    explanation: "Ranking Southeast counties by housing affordability and Black population share. Top 10 across 12 states."
  })

User: "Reset"
→ set_query_state({ layers: [], filters: [], limit: null, regionStates: [], explanation: "Cleared all filters and scoring." })
```

---

## Files to Create/Modify

- `server/src/prompt/toolDefinitions.ts` — remove old tools, add `set_query_state`.
- `server/src/prompt/chatPrompt.ts` — rewrite tool list + examples.
- `server/src/services/haiku.ts` — extend validation + types.
- `src/lib/mapTools.ts` — add `case 'set_query_state'`, remove old cases.
- `src/components/Map.vue` — extend `rankingStateFilter` to `string[] | null`; expose `applyQueryState(input)` helper.
- `src/components/RankingPanel.vue` — adapt single-state dropdown to write/read length-1 array.

---

## Definition of Done

- [ ] Build passes (frontend + server).
- [ ] Manually verified: "Southeast" query → single tool call → rankings + chat agree.
- [ ] Manually verified: state-name dropdown in RankingPanel still works.
- [ ] PR includes a screenshot of a multi-state query before/after.

---

# [FEATURE] T2 — Turn snapshots + localStorage persistence

**Type:** Feature
**Priority:** P0 (Critical)
**Size:** M (2-3 days)
**Dependencies:** T1 (snapshots include unified query state)

---

## Summary

Capture a state snapshot at the boundary of each user turn and attach it to the user message. Serialize the entire `messages` array (with snapshots) to `localStorage["blo:conversation"]` after each turn. On mount, hydrate from storage if within 7-day TTL and apply the most recent snapshot.

---

## User Story

As a user mid-research,
I want my conversation and map state to survive a browser refresh,
so that I don't lose 17 turns of compounded context to a stray cmd-R.

---

## Requirements

### Functional Requirements

- [ ] `TurnSnapshot` type added to `useChat.ts`:
  ```ts
  interface TurnSnapshot {
    layers: ScoringQuery
    filters: ScoringFilter[]
    limit: number | null
    regionStates: string[]
    currentCountyId: string | null
    currentCountyName: string | null
    listingsCount: number
  }
  ```
- [ ] After every successful `sendMessage()`, the system captures the live snapshot and attaches it to the most recent user-role message in `messages.value`.
- [ ] After every turn (success or error), the system writes `{ v: 1, savedAt: ISO8601, messages }` to `localStorage["blo:conversation"]`. Failures (quota, private mode) are caught and logged once.
- [ ] On `useChat()` instantiation, the system attempts to read `blo:conversation`. If present, valid JSON, `v === 1`, and `Date.now() - savedAt <= 7 days`, the messages array is restored. Otherwise the key is removed.
- [ ] Immediately after hydration, the most recent snapshot is applied to the map state via the same code path the LLM tool dispatcher uses (no rewind-specific branch).

### Technical Requirements

- [ ] Snapshot capture must read from a single source of truth — pass a `getSnapshot: () => TurnSnapshot` factory into `useChat` from Map.vue.
- [ ] Hydration writes to refs through the same `applyQueryState(...)` introduced in T1.
- [ ] Snapshot serialization < 5ms typical; localStorage I/O < 10ms.
- [ ] No new runtime dependencies.

---

## Acceptance Criteria

### Scenario 1: Reload restores conversation and map
**Given:** A user has 5 turns of chat with the map showing a Southeast affordability query.
**When:** They hard-refresh.
**Then:** The 5 messages reappear in the thread. The map is colored as it was. The rankings panel shows the same N counties. `currentCounty` (if any) is restored.

### Scenario 2: Stale storage cleared
**Given:** `blo:conversation` was written 8 days ago.
**When:** The user opens the page.
**Then:** The key is removed; the chat starts empty. No errors logged to console beyond the standard "no prior session" path.

### Scenario 3: Schema mismatch cleared
**Given:** `blo:conversation` is `{ v: 0, ... }` from a prior format.
**When:** The user opens the page.
**Then:** The key is removed; chat starts empty.

### Scenario 4: Storage write failure
**Given:** localStorage is full or unavailable (private mode, quota exceeded).
**When:** A turn completes and tries to persist.
**Then:** The chat itself works (no UX disruption). One console.warn fires with the storage error. Subsequent turns try again silently.

---

## Out of Scope

- Cross-tab sync. Two tabs each maintain their own copy; last-write-wins on the same key.
- Server-side persistence / cross-device.
- Compression of the messages array.
- A "Clear conversation history" UI action (already exists via `clearConversation`).

---

## Files to Create/Modify

- `src/composables/useChat.ts` — add `TurnSnapshot`, snapshot capture, persist + hydrate. Accept `getSnapshot` and `applyQueryState` callbacks via the existing `ChatOptions`.
- `src/components/Map.vue` — wire `getSnapshot()` and `applyQueryState()` into `useChat()` options.

---

## Definition of Done

- [ ] Refresh reload restores 5+ turn conversation correctly.
- [ ] 8-day-old key auto-clears.
- [ ] Schema-bump path (manually edit `v` to 0 in dev tools) clears cleanly.
- [ ] No console errors during normal flow.

---

# [FEATURE] T3 — Click-to-rewind on user message bubbles

**Type:** Feature
**Priority:** P1 (High)
**Size:** S (1-2 days)
**Dependencies:** T2 (needs snapshot data on each user message)

---

## Summary

Make each user-message bubble in the chat thread clickable. Click → applies that bubble's attached `TurnSnapshot` to the live map state, restoring layers/filters/limit/region/county/listings to where they were at that turn. Thread is not truncated — later turns remain visible but visually marked as "ahead of current state."

---

## User Story

As a user who has refined a query 5 turns deep and wants to see what turn 2 looked like,
I want to click that earlier message and see the map snap back to that point,
so that I can compare without losing the rest of my conversation.

---

## Requirements

### Functional Requirements

- [ ] User message bubbles in the chat thread render as clickable elements (cursor: pointer; subtle hover treatment).
- [ ] Clicking a user bubble calls `applyQueryState(bubble.snapshot)` and additionally restores the `currentCounty` and `listingsCount` state from the snapshot (open inspect rail, restore listings if appropriate — listings re-fetch deferred; just open or close the rail to match).
- [ ] After a rewind click, message bubbles for turns *ahead of* the active turn render with a faint "ahead-of-current" treatment (reduced opacity 0.55 + a subtle marker like a left border or "(ahead)" badge — implementation choice within the scope).
- [ ] The currently-active turn is highlighted (e.g. a small "↺ at this turn" indicator or a left border).
- [ ] Clicking a turn that's already active is a no-op.
- [ ] Sending a new follow-up message from a rewound state appends to the existing thread; it does not branch or fork.

### Technical Requirements

- [ ] Track active turn index in `useChat` as `activeTurnIndex: Ref<number>`. New messages set it to the latest user message index. Clicking a bubble sets it to that message's index.
- [ ] Persist `activeTurnIndex` alongside `messages` in localStorage so reload restores both the thread and the view-pointer.

---

## Acceptance Criteria

### Scenario 1: Rewind to mid-conversation
**Given:** A 7-turn convo. Turn 3 had `regionStates: ["MS"]`. Turn 5 had `regionStates: ["VA","NC","SC",...]`. Map currently reflects turn 7.
**When:** User clicks the user-bubble for turn 3.
**Then:** Map applies turn 3's snapshot (Mississippi-only). The currentCounty and listings state restore. Turns 4-7 in the thread render with reduced opacity / "ahead" marker. Turn 3's bubble has the "active" indicator.

### Scenario 2: Click already-active turn
**Given:** Turn 3 is the currently active turn.
**When:** User clicks turn 3's bubble again.
**Then:** Nothing changes. No re-application, no jitter.

### Scenario 3: New message after rewind
**Given:** User has rewound to turn 3 of a 7-turn convo.
**When:** They send a new follow-up.
**Then:** The new message and its reply append to the thread (now 8 user-visible turns + tool messages). `activeTurnIndex` advances to the new latest user message. All bubbles return to normal opacity. The previous "ahead" treatment for turns 4-7 is gone.

---

## Out of Scope

- Forking the conversation at a rewound point (creating an alternate timeline). Append-only is the chosen simpler model.
- Truncating turns ahead of the rewind point. They remain in the thread.
- Animation of the rewind transition. Snap-state is fine for v1.
- Re-fetching property listings on rewind. If listings were active at the snapshot, just open the listings view as empty until user re-runs Find Land.

---

## Files to Create/Modify

- `src/composables/useChat.ts` — add `activeTurnIndex` ref + persistence; expose `rewindToTurn(idx)`.
- `src/components/PromptInput.vue` — render user bubbles as clickable; "ahead-of-current" styling on later messages; "active" indicator on current.
- `src/components/Map.vue` — pass `activeTurnIndex` into the snapshot/apply pipeline so listings + inspect open/close on rewind.

---

## Definition of Done

- [ ] Clicking a 5-turn-old bubble restores layers, filters, limit, region, currentCounty.
- [ ] "Ahead-of-current" styling applied to later messages.
- [ ] Reload while pointed mid-thread → restores to that mid-thread view, not the latest.
- [ ] PR includes a short clip of click-to-rewind in action.

---

## Cross-cutting validation (all tickets)

- [ ] Build passes both `npm run build` (frontend) and `npm run build` from `server/` (TypeScript).
- [ ] Manual smoke test of a 5-turn region query end-to-end after each ticket.
- [ ] No regressions in existing tools (`zoom_to_county`, `show_county_details`, `search_housing`, `toggle_ranking_panel`).
