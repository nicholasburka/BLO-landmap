# Pre-Launch Checklist — LLM-Enabled BLO National Map

Updated 2026-07-03. Code fixes are **done and verified** (type-check clean, 25 server + 5 frontend tests passing, production build passing, live browser pass against the hardened backend). What remains is **deploy-time ops you must do on the hosts** — nobody can set those from the repo.

---

## ✅ Done in code (this pass)

### Server hardening (`server/src`)
- **Dedicated token secret** — `SESSION_HMAC_SECRET` (≥32 chars) replaces the password-derived/`"default"` key; server refuses to boot without it; signature compare is now `timingSafeEqual`. A forged staging token can no longer bypass the cap.
- **`BUDGET_BYPASS` is dead in production** — ignored (with a warning) whenever `NODE_ENV=production`, regardless of env.
- **Rate limits on the auth surface** — `/api/auth` 5/min, `/api/session` 10/min (verified: brute-force trips 429 on attempt 6).
- **Chat endpoint locked down** — role allowlist (user/assistant only), content-block-type allowlist, 48K-char history cap, `express.json` limit dropped to 64 KB (verified: oversized body → 413, no stack trace).
- **Prompt-injection surface closed** — `context.activeFilters` is validated against known layer ids/operators before it can reach the system prompt.
- **Budget reservation** — estimated cost is reserved before each Anthropic call and settled to actuals after (released on failure), so a fresh IP and concurrent requests can no longer overshoot the caps.
- **Express hardening** — `helmet()`, a terminal JSON error handler (never leaks stacks), boot-time guards on `SESSION_HMAC_SECRET` + `ANTHROPIC_API_KEY`, configurable `TRUST_PROXY_HOPS`.
- **`/api/health` trimmed** to `{status:'ok'}`; usage snapshot moved to `/api/health/usage` behind a staging-tier token (verified: 401 without token).

### Client (`src/`)
- **`VITE_API_URL`** — shared `src/lib/apiBase.ts`; localhost fallback only in dev; prod build with no env var disables AI features with a clear message instead of silently pointing at localhost.
- **Session-mint failure** now retries `ensureSession()` before erroring (no more permanent "please sign in").
- **History truncation** trims at user-turn boundaries so tool_use/tool_result pairs never split (no more 400 loops past 20 messages).
- **Corrupt localStorage** can't white-screen the app — hydration validates shape and clears the key on any error.
- **429 vs daily-cap vs 401** messaging is now distinct; 401 silently re-mints and asks the user to resend (verified live).
- **LLM links** get `rel="noopener noreferrer"` + `target="_blank"` via a DOMPurify hook.

### Map / tool loop (`src/components/Map.vue`, `src/lib/mapTools.ts`)
- **Region-filter bug fixed and verified live** — the tool_result the LLM sees now matches the ranking panel (root cause was that the region filter was never applied to the tool result at all, not just a 100 ms race). "top 5 affordable → only in Texas" now correctly returns 5 Texas counties to the model.
- **`layers: []`** now actually clears scoring (was a silent no-op reported as success).
- **`set_query_state` payload** validated/clamped (weights 1–10, limit 1–50, unknown layers dropped) and dropped items are reported back to the LLM so it can self-correct.
- **Inspected county** survives a reload (replayed after county data loads).
- **Live crash fixed** — a stale `expandBLOPreset()` call site (renamed to `clearBLO()`) that threw a `ReferenceError` when toggling the contamination choropleth in BLO mode.

### Config / hygiene
- RentCast key moved out of source into gitignored `.env` (root `.env.example` added); `DEBUG` is now dev-only.
- **All 124 TypeScript errors fixed** — `npm run type-check` is clean (removed stray `@types/mapbox-gl`, added a geocoder ambient d.ts).
- mapbox-gl split into its own vendor chunk; Netlify security + cache headers added.
- 189 stray screenshots moved to `screenshots/` and gitignored (with `.playwright-mcp/`).
- **Tests added**: server auth (forgery/tamper/expiry/boot-guard), budget (reserve/settle/bypass-guard), chat validation; frontend markdown-sanitization; real Cypress smoke spec (scaffold deleted).

---

## ⏳ Deploy-time ops — YOU must do these (can't be done from the repo)

- [ ] **Rotate the RentCast API key at the vendor.** The old key `72f7ed2c…` was in git history and the shipped bundle — treat it as compromised. Generate a new one, set it as `VITE_RENTCAST_API_KEY` on the Netlify site(s). (If listings ever need a *private* key, proxy through the backend instead of shipping it.)
- [ ] **Backend host (Railway/Render/etc.):** set `SESSION_HMAC_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`), `NODE_ENV=production`, `ANTHROPIC_API_KEY`, `ALLOWED_ORIGINS` (prod + staging), and `TRUST_PROXY_HOPS` matching the real topology (1 = direct, 2 = CDN in front). Do **not** set `BUDGET_BYPASS`. Redeploy after setting the git-tracked env changes (helmet is a new dependency — `npm install` on the server).
- [ ] **Netlify (prod):** set `VITE_API_URL` to the backend URL and `VITE_MAPBOX_ACCESS_TOKEN`. Leave `VITE_STAGING_GATE_ENABLED` and `STAGING_PASSWORD` unset. Rebuild.
- [ ] **Verify the topology**: confirm `req.ip` is the real client IP on the actual host (hit `/api/health/usage` with a staging token and watch `uniqueIps`) — if a CDN fronts it, bump `TRUST_PROXY_HOPS`.
- [ ] **Anthropic spend alert / hard limit** on the API key as a backstop behind the daily cap.
- [ ] **Uptime monitor** on `GET /api/health`.
- [ ] Merge `ux-redesign-phase4b` → `main` and point the prod Netlify site at `main`.

## 🔭 Post-launch / nice-to-have (not blocking)
- Move the in-memory rate-limit + budget counters to Redis before scaling the backend past one instance (today they're per-process and reset on redeploy).
- The app JS chunk is still ~400 KB gzip (mapbox-gl split out to its own ~390 KB chunk) — consider lazy-loading the property-listings/About paths.
- Broaden e2e coverage: the Cypress smoke test only covers the shell; the LLM round-trip is still manual/staging-only (needs a live key).
