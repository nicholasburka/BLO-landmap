# Phase 3 Tickets: Promptable Map Controls

**Spec:** [personalized-index-system.md](./personalized-index-system.md) (Section "Phase 3: Promptable Map Controls")
**Phase:** 3 — Conversational Map Control via LLM Tool-Use
**Date:** 2026-04-02

---

## Architecture Decisions

1. **Client-side conversation state** — the client sends the last N messages with each request. Server stays stateless. Simpler to start; can migrate to server-side if needed.
2. **Shared county-name lookup module** — create a module that works in both browser and Node, for resolving county names to GEOIDs. Lives in `src/` (client) with no client-only dependencies so the server can import it.
3. **Client-side tool execution** — server returns Anthropic's `tool_use` blocks unchanged; client executes them (zoom, search, toggle, etc.) against the map. Server only calls the Claude API.

---

## Dependency Graph

```
T1 (County lookup module)
 └── T3 (Tool-use server integration)

T2 (Tool definitions + handlers)
 ├── T3 (Tool-use server integration)
 └── T5 (Client tool executor)

T3 (Tool-use server integration) → T4 (Conversation state) → T5 (Client tool executor)
 └── T6 (Conversational UX + message history display)

T7 (Polish + testing) depends on T6
```

**Critical path:** T1 → T2 → T3 → T4 → T5 → T6 → T7
**Parallelizable:** T1 and T2 can run in parallel after planning.

---

## T1: Shared County Name → GEOID Lookup Module

**Type:** Feature
**Size:** S
**Blocked by:** None
**Blocks:** T2, T3

### Description

Build a module that resolves county names (with optional state) to GEOIDs. Used by both the LLM tool handlers (e.g., `zoom_to_county("Mecklenburg", "NC")`) and any backend data scripts that currently do this lookup ad-hoc.

Must work in browser and Node without dependencies on either environment (no `fs`, no `window`).

### Requirements

1. Location: `src/lib/countyLookup.ts` (client-importable, also server-importable via relative path)
2. Data source: the counties GeoJSON at `public/datasets/geographic/counties.geojson` — or a lightweight CSV/JSON index derived from it
3. **Shape:**
   ```typescript
   export interface CountyLookup {
     geoId: string
     name: string        // e.g., "Mecklenburg County"
     stateName: string   // e.g., "North Carolina"
     stateAbbr: string   // e.g., "NC"
   }

   export function findCounty(name: string, stateHint?: string): CountyLookup[]
   export function getCountyByGeoId(geoId: string): CountyLookup | undefined
   ```
4. **Matching rules:**
   - Case-insensitive substring match on county name
   - If `stateHint` provided, filter to that state (matches either full name or abbr)
   - "Mecklenburg" + "NC" → matches Mecklenburg County, NC (not Mecklenburg County, VA)
   - Returns all matches; caller picks first or disambiguates
   - Handle variations: "Mecklenburg" vs "Mecklenburg County" vs "Mecklenburg Co."
5. Data: extract county names + GEOIDs + state info from the existing GeoJSON. Pre-build a JSON lookup file to avoid loading the full 2.8MB GeoJSON for name lookups. Script it in `scripts/build-county-lookup.cjs`.

### Acceptance Criteria

- [ ] `findCounty("Mecklenburg", "NC")` returns exactly one match with GEOID 37119
- [ ] `findCounty("Orange")` returns matches in multiple states (CA, FL, NC, etc.)
- [ ] `findCounty("Orange", "CA")` returns only the California match
- [ ] `getCountyByGeoId("06001")` returns Alameda County, California
- [ ] Module imports in both client (Vue) and server (Express) without errors
- [ ] Lookup runs in <10ms for any query

### Files

| File | Action |
|------|--------|
| `scripts/build-county-lookup.cjs` | **CREATE** — script to build index from GeoJSON |
| `public/datasets/geographic/county-lookup.json` | **CREATE** — generated lookup index |
| `src/lib/countyLookup.ts` | **CREATE** — module exporting findCounty, getCountyByGeoId |

---

## T2: Tool Definitions + Handler Specs

**Type:** Feature
**Size:** M
**Blocked by:** None
**Blocks:** T3, T5

### Description

Define the Anthropic tool schemas for map control actions, and write the client-side handler functions that execute them. Tools are defined once and shared — server passes them to Claude, client executes them when Claude calls them.

### Requirements

1. **Define 6 tools** in `src/lib/mapTools.ts`:
   - `zoom_to_county` — params: `{ county_name: string, state?: string }`
   - `search_housing` — params: `{ county_name: string, state?: string }`
   - `set_layer_selection` — params: `{ layers: Array<{layerId, weight, direction}>, explanation?: string }` (replaces full layer state — same shape as Phase 2's query response)
   - `toggle_ranking_panel` — params: `{ expanded: boolean }`
   - `filter_ranking_by_state` — params: `{ state: string }`
   - `show_county_details` — params: `{ county_name: string, state?: string }` (opens the CountyModal)

2. **Tool schemas** follow Anthropic's format:
   ```typescript
   {
     name: "zoom_to_county",
     description: "Zoom the map to a specific US county and highlight it.",
     input_schema: {
       type: "object",
       properties: {
         county_name: { type: "string", description: "County name (e.g., 'Mecklenburg County' or 'Mecklenburg')" },
         state: { type: "string", description: "State name or 2-letter abbreviation (optional, used to disambiguate)" }
       },
       required: ["county_name"]
     }
   }
   ```

3. **Handler interface:**
   ```typescript
   export interface ToolContext {
     map: mapboxgl.Map | null
     setLayerSelection: (layers: LayerSelection[]) => void
     openCountyModal: (geoId: string) => void
     toggleRankingPanel: (expanded: boolean) => void
     setRankingStateFilter: (state: string) => void
     triggerHousingSearch: (county: CountyLookup) => void
   }

   export async function executeTool(
     toolName: string,
     toolInput: any,
     ctx: ToolContext
   ): Promise<string>  // returns a string result the LLM sees
   ```

4. **Each handler** resolves county names via `countyLookup.findCounty()` (T1), then performs the UI action, then returns a human-readable result string for the LLM to reference in follow-up messages (e.g., "Zoomed to Mecklenburg County, NC (GEOID 37119)").

5. **Error results** (county not found, ambiguous match, etc.) return descriptive strings so the LLM can respond intelligibly.

### Acceptance Criteria

- [ ] `TOOL_DEFINITIONS` exports all 6 tools with valid Anthropic schema
- [ ] `executeTool("zoom_to_county", {county_name: "Mecklenburg", state: "NC"}, ctx)` zooms the map and returns a confirmation string
- [ ] Ambiguous name ("Orange" with no state) returns a string listing all matches, caller decides what to do
- [ ] Unknown tool name returns an error result (doesn't crash)
- [ ] Unit tests cover each tool handler with mock ToolContext

### Files

| File | Action |
|------|--------|
| `src/lib/mapTools.ts` | **CREATE** — tool definitions + executeTool |
| `src/lib/mapTools.test.ts` | **CREATE** — unit tests (optional but recommended) |

---

## T3: Server-Side Tool-Use Integration

**Type:** Feature
**Size:** M
**Blocked by:** T1, T2
**Blocks:** T4

### Description

Update the `/api/query` endpoint to support Anthropic's tool use API. The server passes tool definitions to Claude, relays any `tool_use` blocks back to the client, and processes multi-turn conversations (client sends tool results → server sends to Claude → Claude responds with more tools or final text).

### Requirements

1. **New endpoint** `POST /api/chat` (keep existing `/api/query` for simple Phase 2 queries):
   ```typescript
   // Request
   {
     messages: Array<{
       role: 'user' | 'assistant',
       content: string | ContentBlock[]  // can be text or tool_result blocks
     }>
   }

   // Response (one of):
   { type: "tool_use", message: AssistantMessage, toolCalls: ToolUseBlock[] }
   { type: "final", message: AssistantMessage, text: string }
   ```

2. **Server logic:**
   - Receive messages array from client
   - Call Anthropic with `tools: TOOL_DEFINITIONS` from `src/lib/mapTools.ts` (import relative path)
   - Use a Phase 3-specific system prompt (see below)
   - If Claude returns `stop_reason: "tool_use"` → return the tool_use blocks to client
   - If Claude returns `stop_reason: "end_turn"` → return the final text to client
   - Do NOT execute tools server-side

3. **New system prompt** (`server/src/prompt/chatPrompt.ts`):
   - Role: "You are the conversational assistant for the BLO Livability Index"
   - Capabilities list: explains the tools the LLM can use
   - Guardrails: same anti-racist rules as Phase 2
   - Example: "When user asks to zoom to a county, call `zoom_to_county`. When user asks for a new scoring query, call `set_layer_selection`."

4. **Layer registry** still included in the system prompt so Claude knows what layers to reference in `set_layer_selection` calls. Reuse or share with Phase 2's `systemPrompt.ts`.

5. **Rate limiting + auth**: same middleware as `/api/query`. Possibly lower rate limit (10/min) since chats are multi-request.

### Acceptance Criteria

- [ ] `POST /api/chat` with `{ messages: [{ role: "user", content: "zoom to Mecklenburg County" }] }` returns a tool_use block for zoom_to_county
- [ ] Sending tool_result back (`{ messages: [...previous, { role: "assistant", content: [tool_use] }, { role: "user", content: [tool_result] }] }`) continues the conversation
- [ ] Server does not execute any tool; only forwards tool_use blocks to client
- [ ] System prompt includes all 6 tool capabilities
- [ ] Guardrails still apply — exclusionary queries refused
- [ ] Auth and rate limiting work on `/api/chat`

### Files

| File | Action |
|------|--------|
| `server/src/routes/chat.ts` | **CREATE** — POST /api/chat handler |
| `server/src/prompt/chatPrompt.ts` | **CREATE** — chat system prompt with tool descriptions |
| `server/src/services/haiku.ts` | **MODIFY** — add `chatHaiku(messages, tools)` function |
| `server/src/index.ts` | **MODIFY** — mount /api/chat route |

---

## T4: Client Conversation State Management

**Type:** Feature
**Size:** S
**Blocked by:** T3
**Blocks:** T5

### Description

Build the client-side composable that manages conversation history and the tool-execution loop. Every `/api/chat` response that contains tool_use blocks triggers client-side tool execution; results are sent back with the next request until the server returns a final text response.

### Requirements

1. **New composable** `src/composables/useChat.ts`:
   ```typescript
   export interface ChatMessage {
     role: 'user' | 'assistant'
     content: string | ContentBlock[]
     displayText?: string  // for rendering in the UI
   }

   export function useChat(toolCtx: ToolContext) {
     const messages: Ref<ChatMessage[]>
     const isThinking: Ref<boolean>
     const sendMessage(text: string): Promise<void>
     const clearConversation(): void
     return { messages, isThinking, sendMessage, clearConversation }
   }
   ```

2. **Send message flow:**
   - Append user message to `messages`
   - Set `isThinking = true`
   - POST to `/api/chat` with all messages
   - If response is `tool_use`:
     - Append assistant message (with tool_use blocks) to messages
     - For each tool_use, call `executeTool(name, input, toolCtx)` (from T2)
     - Append a user message with `tool_result` blocks containing the execution results
     - Recursively POST again with updated messages
   - If response is `final`:
     - Append assistant message with text
     - Set `isThinking = false`

3. **Conversation length:** cap at last 20 messages sent to server to control token usage. Older messages stay in UI state but aren't resent.

4. **Error handling:**
   - Network error → append error as system message, stop the loop
   - Tool execution error → include error in tool_result, continue
   - Infinite loop protection: max 10 tool calls per turn

5. **Persistence:** conversation stays in memory only. Cleared on page reload or manual clear.

### Acceptance Criteria

- [ ] `sendMessage("zoom to Mecklenburg County")` triggers /api/chat, executes zoom tool, appends final response
- [ ] Multi-step queries work: "show me the top 5 for homeownership, then zoom to #1" → set_layer_selection → zoom_to_county → final text
- [ ] `clearConversation()` resets message history
- [ ] After 10 tool calls in a single user turn, loop stops and shows error
- [ ] Only last 20 messages are sent to server

### Files

| File | Action |
|------|--------|
| `src/composables/useChat.ts` | **CREATE** — conversation state + tool execution loop |

---

## T5: Client Tool Executor + Map Integration

**Type:** Feature
**Size:** M
**Blocked by:** T2, T4
**Blocks:** T6

### Description

Wire the `ToolContext` (T2) with Map.vue's actual state — the map instance, layer selection functions, modal opener, ranking panel state, etc. Connect `useChat` composable to Map.vue so tool calls actually affect the UI.

### Requirements

1. In `Map.vue`:
   - Build a `toolCtx: ToolContext` object with all current state + mutators:
     - `map`: the Mapbox instance ref
     - `setLayerSelection`: the existing `handleQueryResult` function from T7 (Phase 2)
     - `openCountyModal`: existing `selectCountyFromRanking` logic
     - `toggleRankingPanel`: existing state toggle
     - `setRankingStateFilter`: need to expose the state filter ref from RankingPanel (emit event or store in Map.vue)
     - `triggerHousingSearch`: existing `searchListings` function

2. Instantiate `useChat(toolCtx)` in Map.vue setup

3. **Key change:** RankingPanel's state filter needs to be controllable from outside. Currently it's internal — refactor to accept `selectedState` as a prop with an `update:selectedState` emit (v-model pattern). Map.vue owns the state.

4. **Tool execution feedback:** when a tool is executed, optionally show a subtle visual indicator ("Zooming to Mecklenburg County...") that disappears after completion.

### Acceptance Criteria

- [ ] Typing "zoom to Mecklenburg County NC" in the chat UI zooms the map
- [ ] "Show me the top 5 for Black homeownership" runs set_layer_selection, map recolors, ranking panel populates
- [ ] "Now filter to North Carolina" calls filter_ranking_by_state, ranking panel filters
- [ ] Multi-step: "Show top 5 for X and zoom to #1" executes set_layer_selection then zoom_to_county
- [ ] Ambiguous county names prompt the LLM to ask for clarification in its final text

### Files

| File | Action |
|------|--------|
| `src/components/Map.vue` | **MODIFY** — build toolCtx, use useChat |
| `src/components/RankingPanel.vue` | **MODIFY** — make selectedState controllable via v-model |

---

## T6: Chat UI + Message History Display

**Type:** Feature
**Size:** M
**Blocked by:** T5
**Blocks:** T7

### Description

Evolve `PromptInput.vue` from a single-query input into a conversational chat UI. Show message history, thinking indicator, and allow multi-turn conversations.

### Requirements

1. **Replace or augment PromptInput.vue:**
   - Option A: transform PromptInput into a chat panel
   - Option B: create a new `ChatPanel.vue` component, deprecate PromptInput
   - Recommend Option A — keeps the single entry point for prompt queries

2. **Template structure:**
   ```
   [Auth gate if not authenticated]
   [Conversation history (scrollable, newest at bottom)]
     [User messages right-aligned]
     [Assistant messages left-aligned, with optional tool-call indicators]
   [Thinking indicator when isThinking]
   [Input box + send button]
   [Clear conversation button]
   ```

3. **Message rendering:**
   - User text: plain text bubble
   - Assistant text: markdown rendering (or just plain text for simplicity — explanation is usually short)
   - Tool calls: show as subtle inline notes: "→ Zoomed to Mecklenburg County, NC"
   - Errors: red text

4. **Collapsible/expandable:**
   - When collapsed: show just input + latest response
   - When expanded: show full conversation history
   - Persist expanded/collapsed preference in localStorage

5. **Empty state:** when no conversation, show the existing suggested chips (from Phase 2)

6. **Conversation controls:**
   - Clear button (trash icon) resets conversation via `clearConversation()`
   - Copy conversation button (optional)

### Acceptance Criteria

- [ ] Multi-turn conversation displays as user/assistant message bubbles
- [ ] Thinking indicator appears while waiting for response
- [ ] Tool calls appear as inline notes in the conversation
- [ ] Clear button resets conversation
- [ ] Empty state shows suggested chips
- [ ] Collapsed state still allows sending new messages
- [ ] UI doesn't interfere with map interaction (z-index, pointer-events)

### Files

| File | Action |
|------|--------|
| `src/components/PromptInput.vue` | **MAJOR REFACTOR** — turn into chat panel |

---

## T7: Polish + End-to-End Testing

**Type:** Chore
**Size:** S
**Blocked by:** T6
**Blocks:** None

### Description

Playwright scenarios covering the key Phase 3 flows, plus UX polish based on testing feedback.

### Requirements

1. **Test scenarios:**
   - Single tool call: "zoom to Atlanta"
   - Layer query via chat: "counties best for homeownership"
   - Multi-step: "top 5 for affordability, then zoom to #1"
   - Filter: "filter to Texas"
   - Ambiguous county: "zoom to Orange" → LLM asks which state
   - Clarification flow: user responds "Orange County California" → zoom succeeds
   - Clear conversation mid-turn

2. **Polish items (discovered during testing):**
   - Loading state visibility
   - Error message clarity
   - Keyboard shortcuts (Enter to send, Shift+Enter for newline)
   - Scroll behavior (auto-scroll to latest message)
   - Mobile responsiveness (or mark as desktop-only beta)

3. **Update refinements-backlog.md** with any items that couldn't be addressed in this phase.

### Acceptance Criteria

- [ ] All test scenarios pass manually via Playwright
- [ ] Loading and error states are clear
- [ ] Enter key sends, Shift+Enter creates newline
- [ ] Conversation auto-scrolls to latest
- [ ] No console errors during normal flows

### Files

| File | Action |
|------|--------|
| Various | polish only |
| `specs/refinements-backlog.md` | **MODIFY** — add any new items |

---

## Summary

| Ticket | Type | Size | Dependencies |
|--------|------|------|-------------|
| T1: County Lookup Module | Feature | S | None |
| T2: Tool Definitions + Handlers | Feature | M | None |
| T3: Server Tool-Use Integration | Feature | M | T1, T2 |
| T4: Client Conversation State | Feature | S | T3 |
| T5: Client Tool Executor + Map Integration | Feature | M | T2, T4 |
| T6: Chat UI | Feature | M | T5 |
| T7: Polish + Testing | Chore | S | T6 |

**Critical path:** T1 → T2 → T3 → T4 → T5 → T6 → T7
**Parallelizable:** T1 and T2 can run in parallel.
**Total tickets:** 7 (6 features, 1 chore)

---

## Out of Scope (Phase 3)

- Server-side conversation state (deferred; client-side state is simpler for MVP)
- Persistent chat history across sessions
- Streaming responses (tool use works without streaming)
- Voice input / voice output
- Multi-user collaboration on the same conversation
- Threshold filtering (that's Phase 4)

---

## Open Questions

- [ ] Should the chat UI be always-visible, or collapsible by default to reduce visual clutter?
- [ ] Do we want a "retry" button on failed tool calls?
- [ ] Should we log tool call patterns (which tools get used most) for analytics, similar to Phase 2's theme logging?
