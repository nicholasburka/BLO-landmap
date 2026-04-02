# Phase 2 Tickets: Backend + Prompt Interface

**Spec:** [phase2-prompt-interface.md](./phase2-prompt-interface.md)
**Phase:** 2 — Backend + Prompt Interface
**Date:** 2026-04-02

---

## Dependency Graph

```
T1 (Server scaffold)
 ├── T2 (System prompt + Haiku integration)
 │    └── T5 (Query endpoint)
 ├── T3 (Auth middleware)
 │    └── T5 (Query endpoint)
 └── T4 (Rate limiting + CORS + logging)
      └── T5 (Query endpoint)

T6 (Frontend composable + PromptInput) depends on T5
T7 (Map.vue integration) depends on T6
T8 (Railway deployment) depends on T5
```

**Critical path:** T1 → T2 → T5 → T6 → T7
**Parallelizable:** T2, T3, T4 can run in parallel after T1. T8 can start after T5.

---

## T1: Express Server Scaffold

**Type:** Chore
**Size:** S
**Blocked by:** None
**Blocks:** T2, T3, T4, T5

### Description

Create the `server/` directory with an Express + TypeScript project scaffold. No business logic — just the skeleton with dev tooling, build config, and a health endpoint.

### Requirements

1. Create `server/` directory at repo root
2. `server/package.json` with dependencies:
   - `express`, `cors`, `dotenv`
   - Dev: `typescript`, `tsx` (for dev server), `@types/express`, `@types/cors`
3. `server/tsconfig.json` targeting Node with ESM or CommonJS (match what Railway expects)
4. `server/src/index.ts` — Express app with:
   - `dotenv/config` loaded
   - JSON body parser
   - `GET /api/health` returning `{ status: "ok" }`
   - Listen on `process.env.PORT || 3001`
5. `server/.env.example` with all required env vars (no real values):
   ```
   ANTHROPIC_API_KEY=
   BETA_PASSWORD=
   ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
   PORT=3001
   ```
6. Scripts in `server/package.json`:
   - `dev`: run with tsx watch
   - `build`: tsc
   - `start`: node dist/index.js
7. Add `server/node_modules/` and `server/dist/` to root `.gitignore`

### Acceptance Criteria

- [ ] `cd server && npm install && npm run dev` starts server on port 3001
- [ ] `curl http://localhost:3001/api/health` returns `{"status":"ok"}`
- [ ] `npm run build` compiles TypeScript without errors
- [ ] `.env.example` documents all required environment variables

### Files

| File | Action |
|------|--------|
| `server/package.json` | **CREATE** |
| `server/tsconfig.json` | **CREATE** |
| `server/src/index.ts` | **CREATE** |
| `server/.env.example` | **CREATE** |
| `.gitignore` | **MODIFY** — add server/node_modules, server/dist |

---

## T2: System Prompt + Claude Haiku Integration

**Type:** Feature
**Size:** M
**Blocked by:** T1
**Blocks:** T5

### Description

Build the system prompt and Claude Haiku integration. The system prompt combines the role/mission statement, the serialized layer registry (with national averages), the output format specification, and the anti-racist guardrails. The Haiku integration handles the API call and response parsing.

### Requirements

1. **`server/src/prompt/systemPrompt.ts`**:
   - Import `getRegistryForLLM()` from the shared layer registry (or duplicate the serialized output as a constant — see note below)
   - Build system prompt with 4 sections: Role, Layers (with national averages), Output Format, Guardrails
   - National averages to include:
     - Diversity Index: 0.33, Percent Black: 9.47%, Life Expectancy: 77.74 years
     - Avg Weekly Wage: $1,070, Median Income (Black): $52,493
     - Median Home Value: $231,974, Median Property Tax: $2,124
     - Black Homeownership: 50.64%, Poverty Rate (Black): 29.44%
     - Black Progress Index: 74.02, EPA Contamination Sites: 8.77
   - Export `buildSystemPrompt(): string`

2. **`server/src/prompt/guardrails.ts`**:
   - Guardrail rules as per spec Section 4
   - Export as string to be appended to system prompt
   - Refusal template for exclusionary queries
   - Redirect template for off-topic queries

3. **`server/src/services/haiku.ts`**:
   - Install `@anthropic-ai/sdk`
   - Create Anthropic client using `ANTHROPIC_API_KEY` env var
   - `queryHaiku(userPrompt: string): Promise<QueryResponse>` function
   - Sends system prompt + user message to `claude-haiku-4-5-20251001`
   - Parses JSON from response, validates layer IDs exist in registry
   - Returns typed `{ layers: LayerSelection[], explanation: string }`
   - Error handling: malformed JSON → return error explanation, API errors → throw

4. **Shared registry concern:** The layer registry lives in `src/config/layerRegistry.ts` (client code). For the server, either:
   - Option A: Symlink or copy the serialized output at build time
   - Option B: Duplicate the `getRegistryForLLM()` output as a static string in the server
   - Option C: Move registry to a shared package
   - Recommend Option B for simplicity — the registry changes rarely and the server only needs the serialized string

### Acceptance Criteria

- [ ] `buildSystemPrompt()` returns a string containing all 14 layer descriptions with national averages
- [ ] Guardrails section includes refusal rules and templates
- [ ] `queryHaiku("affordable housing for Black families")` returns valid JSON with 2-6 layers
- [ ] `queryHaiku("counties with fewest Black people")` returns empty layers with refusal explanation
- [ ] `queryHaiku("write me a poem")` returns empty layers with redirect explanation
- [ ] All returned layer IDs are valid (exist in registry)
- [ ] Invalid JSON from Haiku is handled gracefully (returns error explanation, doesn't crash)

### Files

| File | Action |
|------|--------|
| `server/src/prompt/systemPrompt.ts` | **CREATE** |
| `server/src/prompt/guardrails.ts` | **CREATE** |
| `server/src/services/haiku.ts` | **CREATE** |
| `server/package.json` | **MODIFY** — add `@anthropic-ai/sdk` |

---

## T3: Auth Middleware + Password Gate

**Type:** Feature
**Size:** S
**Blocked by:** T1
**Blocks:** T5

### Description

Implement password-based beta access with 24-hour session tokens. No database — use HMAC-signed tokens that encode the issue timestamp.

### Requirements

1. **`POST /api/auth`** route:
   - Accepts `{ password: string }`
   - Validates against `BETA_PASSWORD` env var
   - Returns `{ token: string }` — HMAC-SHA256 of `timestamp:password` using a secret derived from `BETA_PASSWORD`
   - Returns 401 if password is wrong

2. **`server/src/middleware/auth.ts`**:
   - Reads `Authorization: Bearer <token>` header
   - Validates HMAC signature
   - Checks timestamp is within 24 hours
   - Returns 401 with `{ error: "Unauthorized" }` if invalid or expired
   - Applies to `/api/query` only (not `/api/health` or `/api/auth`)

3. **Token format:** `base64(timestamp):base64(hmac(timestamp, secret))`
   - No external JWT library needed — just Node crypto

### Acceptance Criteria

- [ ] `POST /api/auth` with correct password returns a token
- [ ] `POST /api/auth` with wrong password returns 401
- [ ] `POST /api/query` with valid token succeeds
- [ ] `POST /api/query` without token returns 401
- [ ] `POST /api/query` with expired token (>24h) returns 401
- [ ] `GET /api/health` works without any token

### Files

| File | Action |
|------|--------|
| `server/src/routes/auth.ts` | **CREATE** |
| `server/src/middleware/auth.ts` | **CREATE** |
| `server/src/index.ts` | **MODIFY** — mount auth route and middleware |

---

## T4: Rate Limiting + CORS + Request Logging

**Type:** Chore
**Size:** S
**Blocked by:** T1
**Blocks:** T5

### Description

Add rate limiting, CORS configuration, and anonymized request logging middleware to the Express server.

### Requirements

1. **Rate limiting:**
   - Install `express-rate-limit`
   - 20 requests per minute per IP on `/api/query`
   - Return 429 with `{ error: "Too many requests. Please wait a moment." }`

2. **CORS:**
   - Read `ALLOWED_ORIGINS` from env var (comma-separated)
   - Only allow listed origins
   - Include localhost origins for development

3. **Request logging:**
   - Log to stdout (Railway captures stdout)
   - Format: `[timestamp] [method] [path] [status] [duration_ms] [ip]`
   - For `/api/query`: also log prompt length (character count) and response layer count
   - Do NOT log prompt content (privacy)
   - **Anonymized query patterns:** Extract and log keyword themes from the prompt. Simple approach: check for presence of predefined keywords (housing, income, safety, diversity, schools, transit, pollution, affordable, homeownership, jobs, etc.) and log which themes were present. E.g., `themes: [housing, affordable, homeownership]`

### Acceptance Criteria

- [ ] 21st request within 1 minute from same IP returns 429
- [ ] Request from unlisted origin is rejected by CORS
- [ ] Request from allowed origin succeeds
- [ ] Each request logs timestamp, method, path, status, duration
- [ ] `/api/query` requests log prompt length and theme keywords
- [ ] Prompt content is never logged

### Files

| File | Action |
|------|--------|
| `server/src/middleware/rateLimit.ts` | **CREATE** |
| `server/src/middleware/requestLogger.ts` | **CREATE** |
| `server/src/index.ts` | **MODIFY** — mount middleware |
| `server/package.json` | **MODIFY** — add `express-rate-limit` |

---

## T5: Query Endpoint

**Type:** Feature
**Size:** S
**Blocked by:** T2, T3, T4
**Blocks:** T6, T8

### Description

Wire up the `POST /api/query` endpoint that accepts a user prompt, calls Haiku via the service, validates the response, and returns it. This is the integration point for all server-side work.

### Requirements

1. **`server/src/routes/query.ts`**:
   - Accepts `{ prompt: string }`
   - Validates prompt is non-empty string, max 500 characters
   - Calls `queryHaiku(prompt)` from T2's service
   - Returns the response JSON
   - Error handling:
     - Empty prompt → 400 `{ error: "Prompt is required" }`
     - Prompt too long → 400 `{ error: "Prompt must be under 500 characters" }`
     - Haiku API error → 502 `{ error: "Service temporarily unavailable" }`
     - Timeout (>10s) → 504 `{ error: "Request timed out" }`

2. **Mount in `server/src/index.ts`:**
   - Auth middleware applied
   - Rate limiting applied
   - Route: `POST /api/query`

### Acceptance Criteria

- [ ] Valid prompt returns layer selections and explanation
- [ ] Empty prompt returns 400
- [ ] Prompt over 500 chars returns 400
- [ ] Unauthenticated request returns 401
- [ ] Rate-limited request returns 429
- [ ] Full round trip: auth → query → valid response in <5s

### Files

| File | Action |
|------|--------|
| `server/src/routes/query.ts` | **CREATE** |
| `server/src/index.ts` | **MODIFY** — mount query route |

---

## T6: Frontend PromptInput Component + API Composable

**Type:** Feature
**Size:** M
**Blocked by:** T5
**Blocks:** T7

### Description

Create `PromptInput.vue` (text input, suggested chips, explanation display, password gate) and `usePromptQuery.ts` (API call composable with auth token management).

### Requirements

1. **`src/composables/usePromptQuery.ts`**:
   - `authenticate(password: string): Promise<boolean>` — calls `/api/auth`, stores token in localStorage
   - `submitQuery(prompt: string): Promise<QueryResponse>` — calls `/api/query` with stored token
   - Handles 401 (clears token, signals re-auth needed)
   - Handles 429 (returns rate limit message)
   - Handles network errors and timeouts
   - `isAuthenticated: Ref<boolean>` — true if valid token exists in localStorage
   - `isLoading: Ref<boolean>` — true while query is in flight
   - API base URL from env var `VITE_API_URL` (or default to localhost:3001)

2. **`src/components/PromptInput.vue`**:
   - **Password gate:** If not authenticated, show password input + submit button
   - **Prompt input:** Text input with placeholder "Describe what you're looking for..."
   - **Submit:** Button or Enter key triggers query
   - **Loading state:** Disable input, show spinner/loading text while waiting
   - **Suggested chips:** 3-4 clickable chip buttons below input:
     - "Affordable counties with strong Black community"
     - "Best places for Black homeownership"
     - "Low pollution, good wages, diverse neighborhoods"
   - Clicking a chip fills the input and auto-submits
   - **Explanation display:** After response, show explanation text in a styled callout below the input
   - **Error display:** Show error messages (rate limit, network error, etc.)
   - **Emits:** `query-result` event with the response payload for Map.vue to consume

### Acceptance Criteria

- [ ] Unauthenticated user sees password input, not prompt input
- [ ] Correct password → token stored, prompt input appears
- [ ] Wrong password → error message, stays on password input
- [ ] Typing a query and pressing Enter submits to API
- [ ] Loading spinner shows during API call
- [ ] Explanation text appears after successful response
- [ ] Clicking a suggested chip fills and submits the query
- [ ] Rate limit error shows user-friendly message
- [ ] Network error shows user-friendly message
- [ ] `query-result` event emits the layer selections

### Files

| File | Action |
|------|--------|
| `src/composables/usePromptQuery.ts` | **CREATE** |
| `src/components/PromptInput.vue` | **CREATE** |

---

## T7: Map.vue Integration

**Type:** Feature
**Size:** S
**Blocked by:** T6
**Blocks:** None

### Description

Wire `PromptInput.vue` into Map.vue so that LLM query results auto-populate the existing layer selection, weight, and direction controls.

### Requirements

1. Mount `PromptInput` in Map.vue template (above LayerControls or as a top bar)
2. Handle `query-result` event:
   - Clear all currently selected layers (all category arrays)
   - Clear all layer visible flags
   - For each layer in the response:
     - Determine which category array it belongs to (use registry)
     - Push to the appropriate `selected*Layers` array
     - Set the layer's visible flag
   - Set `layerWeights` from response weights
   - Set `layerDirections` from response directions
   - The existing reactive pipeline handles the rest (scoring → coloring → ranking)
3. Add `VITE_API_URL` to client `.env.example`

### Acceptance Criteria

- [ ] Prompt query result auto-selects the correct layers across all categories
- [ ] Weight sliders show the LLM-specified weights
- [ ] Direction toggles show the LLM-specified directions
- [ ] Choropleth recolors based on the dynamic score
- [ ] Ranking panel populates with results
- [ ] Explanation is visible
- [ ] User can then adjust sliders/directions manually (Phase 1 behavior preserved)
- [ ] Subsequent prompt query clears previous selection and applies new one

### Files

| File | Action |
|------|--------|
| `src/components/Map.vue` | **MODIFY** — mount PromptInput, handle query-result |
| `.env.example` | **MODIFY** — add VITE_API_URL |

---

## T8: Railway Deployment

**Type:** Chore
**Size:** S
**Blocked by:** T5
**Blocks:** None (can run in parallel with T6, T7)

### Description

Configure the Express server for Railway deployment. Set up the service, environment variables, and verify the health endpoint is reachable.

### Requirements

1. Add `railway.json` or `Procfile` in `server/` directory
2. Configure Railway service:
   - Root directory: `server/`
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
3. Set environment variables in Railway dashboard:
   - `ANTHROPIC_API_KEY`
   - `BETA_PASSWORD`
   - `ALLOWED_ORIGINS` (Netlify production URL + localhost)
   - `PORT` (Railway auto-sets this)
4. Verify:
   - Health endpoint accessible at Railway URL
   - CORS works from Netlify domain
   - Auth flow works end-to-end

### Acceptance Criteria

- [ ] Server is deployed and running on Railway
- [ ] `GET <railway-url>/api/health` returns `{"status":"ok"}`
- [ ] `POST <railway-url>/api/auth` with correct password returns token
- [ ] `POST <railway-url>/api/query` with valid token returns layer selections
- [ ] CORS blocks requests from unlisted origins
- [ ] Environment variables are set (not committed to repo)

### Files

| File | Action |
|------|--------|
| `server/railway.json` or `server/Procfile` | **CREATE** |

---

## Summary

| Ticket | Type | Size | Dependencies |
|--------|------|------|-------------|
| T1: Server Scaffold | Chore | S | None |
| T2: System Prompt + Haiku | Feature | M | T1 |
| T3: Auth Middleware | Feature | S | T1 |
| T4: Rate Limit + CORS + Logging | Chore | S | T1 |
| T5: Query Endpoint | Feature | S | T2, T3, T4 |
| T6: Frontend Prompt + Composable | Feature | M | T5 |
| T7: Map.vue Integration | Feature | S | T6 |
| T8: Railway Deployment | Chore | S | T5 |

**Critical path:** T1 → T2 → T5 → T6 → T7
**Parallelizable:** T2, T3, T4 after T1. T8 after T5 (parallel with T6/T7).
**Total tickets:** 8 (3 chores, 5 features)
