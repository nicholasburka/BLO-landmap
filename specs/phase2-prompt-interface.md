# Spec: Phase 2 — Backend + Prompt Interface

**Status:** Draft
**Author:** Nick + Claude
**Date:** 2026-04-02

---

## Problem Statement

Phase 1 gave users the ability to manually select layers, adjust weights, and see dynamic county rankings. But users still need to know which data layers exist and understand what they mean before they can build a useful query. The gap: users have a goal ("find affordable counties with strong Black community") but no way to express it naturally — they have to manually translate their intent into checkboxes and sliders.

---

## Success Criteria

We'll know this works when:

- [ ] A user can type a natural language query and see the map update with relevant layers, weights, and directions within 3 seconds
- [ ] The LLM explanation is visible alongside the auto-populated controls, so users understand what was selected and why
- [ ] Users can adjust the LLM-suggested weights/directions after the fact (existing Phase 1 sliders)
- [ ] Exclusionary or discriminatory queries are refused with an explanation of the tool's mission
- [ ] The prompt feature is behind password protection (beta)
- [ ] Rate limiting prevents abuse (20 req/min/IP)
- [ ] The system prompt stays on-topic — off-topic queries get a helpful redirect, not hallucinated layer selections

---

## Solution Overview

An Express server deployed on Railway proxies Claude Haiku calls with the layer registry as system context. The frontend adds a text input where users describe what they're looking for. The LLM maps the query to a structured JSON response (layer IDs, weights, directions, explanation). The frontend auto-selects the layers, populates the sliders, and displays the explanation. The Vue client remains on Netlify; only the API server goes to Railway.

---

## Detailed Requirements

### 2.1 Express Server

**Framework:** Express with TypeScript

**Endpoints:**

```
POST /api/query
Headers: { Authorization: "Bearer <session-password>" }
Body: { prompt: string }
Response: {
  layers: [{ layerId: string, weight: number, direction: 'higher_better' | 'lower_better' }],
  explanation: string
}

POST /api/auth
Body: { password: string }
Response: { token: string } (simple session token)

GET /api/health
Response: { status: "ok" }
```

**Middleware:**
- `express-rate-limit`: 20 requests per minute per IP on `/api/query`
- CORS: allow only the Netlify domain + localhost
- Auth middleware on `/api/query`: validates session token from `/api/auth`
- Request logging (timestamp, IP, prompt length — NOT the prompt content itself for privacy)

**Environment variables:**
- `ANTHROPIC_API_KEY` — Claude API key (server-side only, never exposed to client)
- `BETA_PASSWORD` — password for beta access
- `ALLOWED_ORIGINS` — comma-separated allowed CORS origins
- `PORT` — server port (Railway provides this)

### 2.2 System Prompt Design

The system prompt has four sections:

**Section 1 — Role and Mission:**
```
You are the query interpreter for the BLO (Black Livability Observatory) 
Livability Index, a tool that helps Black Americans identify favorable 
counties for living, working, and building wealth across the United States.

Your job is to translate natural language queries into data layer selections 
with weights and directions. You ONLY output structured JSON — never 
conversational text outside the JSON format.
```

**Section 2 — Available Layers:**
The output of `getRegistryForLLM()` — all 14 scorable layers with IDs, names, descriptions, categories, data types, directions, and ranges.

**Section 3 — Output Format:**
```json
{
  "layers": [
    { "layerId": "exact_id_from_registry", "weight": 1-10, "direction": "higher_better|lower_better" }
  ],
  "explanation": "Brief explanation of which layers were selected and why, framed in terms of the user's goal."
}
```

Rules:
- `weight` reflects how strongly the user emphasized that factor (1 = mentioned, 10 = primary focus)
- `direction` must be explicitly set for every layer based on what the user wants
- Select 2-6 layers per query. If the user's intent maps to more, pick the most relevant
- If a query is ambiguous, make reasonable assumptions and explain them
- If a query doesn't map to any available layers, return empty layers array with explanation

**Section 4 — Guardrails:**
```
MISSION ALIGNMENT:
- This tool exists to help Black Americans find favorable places to live
- Always interpret queries through the lens of opportunity, community, and livability
- Frame explanations positively — what makes a place good, not what makes other places bad

REFUSE these types of queries:
- Queries seeking to identify counties to AVOID based on racial demographics
- Queries that frame Black population or diversity as negative attributes
- Queries designed to reinforce segregation or target communities
- Any query that uses this data for discriminatory purposes

When refusing, respond with:
{
  "layers": [],
  "explanation": "This tool is designed to help identify favorable counties for Black livability. I can't assist with queries that [brief reason]. Try asking about what makes a county a great place to live, work, or build wealth."
}

STAY ON TOPIC:
- Only output layer selections from the provided registry
- If the user asks something unrelated to county livability (weather, sports, coding help), respond with empty layers and redirect
- Never invent layer IDs that don't exist in the registry
```

### 2.3 Frontend Prompt UX

**Component:** `PromptInput.vue` — new component added to Map.vue

**Placement:** Above the layer controls panel, or as a collapsible bar at the top of the map area

**Design:**
- Text input with placeholder: "Describe what you're looking for..."
- Submit button (or Enter key)
- Loading state while waiting for API response
- Suggested query chips below the input (3-4 examples):
  - "Affordable counties with strong Black community"
  - "Best places for Black homeownership"
  - "Low pollution, good wages, diverse neighborhoods"
- After response:
  - Explanation text displayed below the input (styled as a subtle callout)
  - Layers auto-selected with weights and directions from the response
  - Sliders and direction toggles populated
  - Map recolors via the scoring engine
  - Ranking panel shows results

**Password gate:**
- On first use, prompt for password (modal or inline)
- Store session token in localStorage
- Token sent as Authorization header on subsequent requests
- If token is invalid/expired, re-prompt for password

**Error handling:**
- Network error → "Couldn't reach the server. Try again."
- Rate limited → "Too many requests. Please wait a moment."
- Empty layers response → show the explanation (on-topic redirect or refusal)
- Timeout (>10s) → "Request timed out. Try a shorter query."

### 2.4 Integration with Phase 1

When the LLM returns layer selections:
1. Clear all currently selected layers
2. For each layer in the response, select it in the appropriate category array
3. Set `layerWeights` and `layerDirections` from the response
4. The existing `scoringQuery` computed will reactively pick up the changes
5. `updateChoroplethColors()` fires via the watcher
6. Ranking panel populates from `rankedCounties`

No changes needed to the scoring engine, choropleth coloring, or ranking panel — they already react to layer selection changes.

---

## System Context

### Architecture After Phase 2

```
User types query
    ↓
Vue client (Netlify)
    ↓ POST /api/query
Express server (Railway)
    ↓ Claude Haiku call with system prompt + user query
Anthropic API
    ↓ Structured JSON response
Express server
    ↓ Validated response
Vue client
    ↓ Auto-select layers, set weights/directions
Phase 1 scoring engine + choropleth + ranking panel
```

### Dependencies
- Anthropic API account + API key
- Railway account for Express server deployment
- Phase 1 complete (layer registry, scoring engine, weight sliders, ranking panel)

### Files to Create

| File | Location | Purpose |
|------|----------|---------|
| `server/` | New directory at repo root | Express server |
| `server/src/index.ts` | | Express app entry point |
| `server/src/routes/query.ts` | | POST /api/query handler |
| `server/src/routes/auth.ts` | | POST /api/auth handler |
| `server/src/middleware/auth.ts` | | Session token validation |
| `server/src/middleware/rateLimit.ts` | | Rate limiting config |
| `server/src/prompt/systemPrompt.ts` | | System prompt builder (imports registry) |
| `server/src/prompt/guardrails.ts` | | Guardrail rules and refusal templates |
| `server/package.json` | | Server dependencies |
| `server/tsconfig.json` | | Server TypeScript config |
| `server/.env.example` | | Environment variable template |
| `src/components/PromptInput.vue` | Client | Prompt text input + explanation display |
| `src/composables/usePromptQuery.ts` | Client | API call composable |

### Files to Modify

| File | Change |
|------|--------|
| `src/components/Map.vue` | Mount PromptInput, handle layer selection from prompt response |
| `railway.json` or `Procfile` | Railway deployment config for server/ |

---

## Constraints & Boundaries

### In Scope
- Express server with single query endpoint
- Claude Haiku integration with structured output
- System prompt with layer registry, output format, guardrails
- Password-protected beta access
- Rate limiting (20 req/min/IP)
- Frontend prompt input with suggested queries
- Auto-populate existing Phase 1 controls from LLM response
- Explanation display
- Anti-racist guardrails (refuse exclusionary queries)

### Out of Scope (Phase 2)
- Multi-turn conversation (Phase 3)
- Tool-use / map actions from LLM (Phase 3)
- User accounts / persistent saved queries
- Query history beyond current session
- Custom prompt for system administrators
- Analytics / usage tracking beyond basic logging
- Mobile-optimized prompt UX

### Assumptions
- Claude Haiku is sufficient for structured extraction (no need for Sonnet/Opus)
- Response time: Haiku typically responds in 1-2s, acceptable for UX
- Railway free tier or basic plan is sufficient for beta traffic
- Layer registry structure won't change significantly between Phase 1 and Phase 2 deployment
- The `getRegistryForLLM()` function produces adequate context for the LLM

### Technical Constraints
- API key must never be exposed to the client
- Server must be stateless (no database for Phase 2 — session tokens can be signed JWTs or simple HMAC)
- CORS restricted to known origins
- TypeScript for both client and server

---

## Examples

### Example 1: Happy Path — Homeownership Query
**Given:** Authenticated user on the map page
**When:** Types "best places for Black families to buy a home with good schools and low cost of living"
**Then:**
- API returns:
```json
{
  "layers": [
    { "layerId": "homeownership_by_race", "weight": 9, "direction": "higher_better" },
    { "layerId": "median_home_value", "weight": 8, "direction": "lower_better" },
    { "layerId": "median_property_tax", "weight": 6, "direction": "lower_better" },
    { "layerId": "black_progress_index", "weight": 7, "direction": "higher_better" },
    { "layerId": "median_income_by_race", "weight": 5, "direction": "higher_better" }
  ],
  "explanation": "Selected Black homeownership rate as the primary factor, with housing affordability (home value + property tax) weighted heavily. Added Black Progress Index as a proxy for school quality and community wellbeing, plus median income for economic context."
}
```
- Map recolors with 5 layers weighted as specified
- Sliders show weights 9, 8, 6, 7, 5
- Directions show appropriate arrows
- Ranking panel shows top counties
- Explanation text visible below prompt input

### Example 2: Refusal — Exclusionary Query
**Given:** Authenticated user
**When:** Types "counties with the fewest Black people"
**Then:**
- API returns:
```json
{
  "layers": [],
  "explanation": "This tool is designed to help identify favorable counties for Black livability. I can't assist with queries that seek to identify areas based on low Black population. Try asking about what makes a county a great place to live, work, or build wealth — for example, 'counties with strong economic opportunity and affordable housing.'"
}
```
- No layers selected, map unchanged
- Explanation displayed to user

### Example 3: Off-Topic Query
**Given:** Authenticated user
**When:** Types "what's the weather like in Miami?"
**Then:**
- API returns:
```json
{
  "layers": [],
  "explanation": "I can only help with county livability queries using the available data layers (demographics, economics, housing, equity, transportation, environment, and health). Try asking something like 'best counties for affordable living with good transit access.'"
}
```
- No layers selected
- Explanation with redirect displayed

### Example 4: Ambiguous Query
**Given:** Authenticated user
**When:** Types "good places to live"
**Then:**
- API returns:
```json
{
  "layers": [
    { "layerId": "black_progress_index", "weight": 7, "direction": "higher_better" },
    { "layerId": "median_income_by_race", "weight": 6, "direction": "higher_better" },
    { "layerId": "median_home_value", "weight": 5, "direction": "lower_better" },
    { "layerId": "life_expectancy", "weight": 5, "direction": "higher_better" },
    { "layerId": "contamination", "weight": 4, "direction": "lower_better" }
  ],
  "explanation": "Since no specific priorities were mentioned, I selected a balanced mix: Black Progress Index for overall community wellbeing, income and housing affordability for economic factors, life expectancy for health, and low contamination for environmental quality. Adjust the weights to reflect what matters most to you."
}
```

### Example 5: Rate Limited
**Given:** User has made 20+ requests in the last minute
**When:** Submits another query
**Then:**
- Server returns 429 status
- Frontend shows "Too many requests. Please wait a moment."

### Example 6: Invalid Password
**Given:** User enters wrong beta password
**When:** Submits password
**Then:**
- Server returns 401
- Frontend shows "Invalid password" and keeps the password input visible

---

## Open Questions

- [x] System prompt includes national averages → yes, useful context for LLM explanations
- [x] Query logging → yes, log anonymized query patterns (keywords/themes, not raw prompts) for product insight. Anticipating public launch needs.
- [x] Session token expiry → 24 hours
- [ ] Railway deployment: separate service or monorepo with root-level `railway.json` pointing to `server/`?
- [ ] Should suggested query chips rotate or be static?

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-04-02 | Nick + Claude | Initial draft |
