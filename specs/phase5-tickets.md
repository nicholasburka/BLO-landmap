# Phase 5 Tickets — Internal Data Library

**Source spec:** `phase5-spec-internal-data-library.md`
**Status:** Step 1 (Auth Core) ticketed in full; steps 2–8 outlined for sequencing.

## Epic map

```
Epic: Internal Data Library
├── Step 1: Auth Core            → P5-1 … P5-5   (detailed below)
├── Analytics track (parallel)   → P5-20 (re-gate usage dashboard), P5-21 (spike), P5-22 (implement)
├── Step 2: Library store + catalog read
├── Step 3: Upload flow (incl. quick drop, text entries, ideas)
├── Step 4: Sync CLI + lifecycle
├── Step 5: Wiki
├── Step 6: Saved views + embeds
├── Step 7: Internal map layers   → P5-18 (county mechanism), P5-23 (enrichment), P5-24 (points), P5-26 (LLM), P5-28 (entity panel), P5-30 (UI conventions)
├── Content + migration track   → P5-25 (file download), P5-27 (homesteading load), P5-29 (sibling-map datasets)
├── Data tooling track          → P5-31 (dataset explorer: tabular service + table view), P5-32 (in-app enrichment, stub), P5-33 (ask-a-dataset, stub)
├── Cohesion track (Nick's UX feedback 2026-09-04) → P5-35 (supersession), P5-36 (cross-links + deep links), P5-37 (entry hub), P5-38 (global search)
└── Step 8: Hardening pass
```

**Critical path:** P5-1 → P5-2 → P5-4 → P5-5. (P5-3 can run parallel after P5-1.)

---

# Step 1: Auth Core

**Step gate (from spec, Example 3):** an unauthenticated request to any internal endpoint returns 401 with no content hints, while the public map works exactly as today.

---

## P5-1 [CHORE] Postgres foundation for the library index

**Type:** Chore
**Priority:** P0
**Size:** S (1–2 days)
**Dependencies:** None

> **Pivot note (2026-09-02):** originally scoped as host-disk SQLite (`better-sqlite3`). Reworked to Postgres after deployment review: Railway/Render disks are ephemeral and auth state is not rebuildable from files, and better-sqlite3 v12 segfaults on the dev machine. Uses the same `DATABASE_URL` instance as the usage store, with JSONB columns for schema flexibility (no migration framework — idempotent CREATE TABLE IF NOT EXISTS on boot, matching `usageStore.ts`).

### Summary
Create the Postgres-backed database service that will back all of Phase 5: users, sessions, and audit log now; catalog/wiki/views tables come in later steps.

### Context
The spec's storage design is "files are the truth, Postgres is the index" — except auth state, which lives *only* in Postgres because it can't be rebuilt from files. Shares `DATABASE_URL` with the usage dashboard; library tables are namespaced `library_*`.

### Requirements
- [x] No new native dependencies; reuse `pg`, add `pg-mem` (dev) for tests
- [x] DB service module with idempotent schema-on-boot (CREATE TABLE IF NOT EXISTS — matches the repo's existing usage-store pattern); open-ended attributes in JSONB (`meta`, `detail`)
- [x] Tables: `library_users` (id, username UNIQUE, password_hash, role CHECK(role IN ('admin','internal')), disabled, created_at, meta JSONB), `library_sessions` (id, user_id FK, token_hash UNIQUE, created_at, expires_at, revoked), `library_audit` (id, user_id, actor, action, target, detail JSONB, created_at)
- [x] Server boots and serves all existing routes when `DATABASE_URL` is unset/unreachable (library features off, warning logged) — public map must never depend on this DB

### Acceptance Criteria
**Given:** `DATABASE_URL` set to a reachable Postgres
**When:** the server starts
**Then:** `library_*` tables are created, schema applied, `/api/health` unchanged.

**Given:** `DATABASE_URL` unset or unreachable
**When:** the server boots
**Then:** it logs a clear warning, disables library features, and all existing endpoints work.

- [x] No changes to any existing route's behavior
- [x] Schema application is idempotent across restarts

### Files to Create/Modify
- `server/src/services/libraryDb.ts` — new DB service + schema
- `server/src/index.ts` — init call (non-fatal on failure, parallel with usage store)
- `server/package.json` — `pg-mem` devDependency
- `DEPLOY.md` — clarify `LIBRARY_DATA_DIR` (file mirror only) vs `DATABASE_URL` (index + auth)

### Testing Notes
- [x] Unit tests: schema creation, idempotency, role CHECK, unique username, disabled-mode fallback, audit writes (Vitest + pg-mem injected pool)

### Definition of Done
- [ ] Tests pass; lint clean; existing server tests unaffected

---

## P5-2 [FEATURE] Internal login/logout API + session middleware

**Type:** Feature
**Priority:** P0
**Size:** M (2–3 days)
**Dependencies:** Blocked by P5-1. Enables P5-4, P5-5.

### Summary
Per-user password authentication: `POST /api/login`, `POST /api/logout`, httpOnly cookie sessions, and a `requireInternalUser` middleware that will guard every internal route in later steps.

### User Story
As an internal team member, I want to log in with my own username and password, so that I can access internal data with my actions attributable to me.

### Context
The server already has `authMiddleware` for **anonymous** sessions (localStorage token, rate-limit tiers) — that path is the public map's and must stay byte-compatible. This ticket adds a separate, parallel auth system. No email flows exist anywhere.

> **Implementation note (2026-09-02):** the frontend is served cross-origin (Netlify → API host via `VITE_API_URL`), which invalidates two assumptions below: `SameSite=Strict` cookies are never attached to cross-site fetches, and readable-cookie double-submit CSRF requires same-origin cookie access. Shipped instead: cookie is `SameSite=None; Secure` in production (`Lax` in dev over http); CSRF token is HMAC-derived from the session token and returned in the login response *body*, echoed via `X-CSRF-Token` (stateless, revokes with the session). CORS now sends `Access-Control-Allow-Credentials` for allowed origins.

### Requirements
- [x] `POST /api/login` — verifies username/password (argon2id via `argon2`), rejects disabled users, creates a session row, sets cookie: httpOnly, `Secure`, `SameSite=None` (see note), 30-day expiry; only the token *hash* is stored server-side
- [x] `POST /api/logout` — revokes session, clears cookie
- [x] `GET /api/me` — returns `{username, role}` for a valid session, 401 otherwise
- [x] `requireInternalUser` middleware — validates cookie, loads user, rejects expired/revoked/disabled with bare 401 `{"error":"unauthorized"}` (no detail leakage); `requireAdmin` variant
- [x] CSRF: token issued at login (response body, HMAC-derived — see note), `X-CSRF-Token` header match required on all mutating internal routes (403 on mismatch)
- [x] Dedicated rate limit on `/api/login` (10/hour/IP, `express-rate-limit` factory for test isolation)
- [x] Login attempts (success + failure) written to `library_audit`
- [x] One guarded placeholder route (`GET /api/library/ping`) to prove the middleware end-to-end
- [x] Uniform response timing for unknown-user vs wrong-password (hash a dummy on unknown user)

### Acceptance Criteria
**Given:** an internal user with valid credentials
**When:** they POST `/api/login` then GET `/api/library/ping`
**Then:** login sets an httpOnly cookie (token absent from response body) and ping returns 200.

**Given:** no session, an expired session, or a revoked session
**When:** any request hits a `requireInternalUser` route
**Then:** 401 with no content hints (spec Example 3).

**Given:** 11 failed logins from one IP within an hour
**When:** the 11th arrives
**Then:** 429; the attempts are all in `audit_log`.

- [ ] Anonymous-session and staging-gate flows behave exactly as before (existing tests untouched and passing)
- [ ] No password or token ever logged

### Technical Notes
- New router `server/src/routes/internalAuth.ts`; do not modify the existing session/auth routers.
- Mount order in `index.ts` mirrors existing pattern: `app.use(internalAuthRouter)` before guarded routers.

### Files to Create/Modify
- `server/src/routes/internalAuth.ts` — login/logout/me
- `server/src/middleware/requireInternalUser.ts` — session + CSRF middleware
- `server/src/index.ts` — mount router + placeholder guarded route
- `server/package.json` — `argon2`, `cookie-parser`

### Testing Notes
- [ ] Unit: middleware accept/reject matrix (valid, expired, revoked, disabled, tampered)
- [ ] Integration: full login → ping → logout → ping(401) sequence
- [ ] Integration: CSRF rejection on mutating route without header

### Definition of Done
- [ ] All tests pass incl. pre-existing server suite; acceptance criteria verified by test, not manually

---

## P5-3 [FEATURE] Admin user-management CLI

**Type:** Feature
**Priority:** P1
**Size:** S (1–2 days)
**Dependencies:** Blocked by P5-1. (Parallel with P5-2.)

### Summary
A server-side CLI for the full account lifecycle — since there are no email flows, this is the only way accounts are created and passwords reset.

### User Story
As an admin, I want to create and manage team accounts from the command line, so that onboarding/offboarding never requires email infrastructure.

> **Implementation note (2026-09-02):** with the P5-1 Postgres pivot, the CLI runs against `DATABASE_URL` (same Postgres as the server), not `LIBRARY_DATA_DIR`. Audit rows go to `library_audit`. `reset-password` also revokes all live sessions (a reset is a "something is wrong" moment).

### Requirements
- [x] `npm run users -- create <username> [--role admin|internal]` — prompts for password (hidden input) or generates one and prints it once
- [x] `npm run users -- reset-password <username>`
- [x] `npm run users -- disable <username>` / `enable <username>` — disable also revokes all live sessions
- [x] `npm run users -- list` — username, role, status, created; never hashes
- [x] All actions written to `library_audit` (actor: `cli`)
- [x] Runs against `DATABASE_URL`; clear error if DB missing/unreachable

### Acceptance Criteria
**Given:** a fresh deployment
**When:** admin runs `create nick --role admin`
**Then:** the account exists and can log in via P5-2's endpoint.

**Given:** a team member departs
**When:** admin runs `disable <username>`
**Then:** their live session 401s on the very next request.

### Files to Create/Modify
- `server/src/cli/users.ts` — CLI entrypoint
- `server/package.json` — script entry

### Testing Notes
- [x] Unit tests for each subcommand against a temp DB (pg-mem); disable-revokes-session integration test with P5-2

### Definition of Done
- [x] Tests pass; DEPLOY.md gains an "Account management" section

---

## P5-4 [FEATURE] Login UI + authenticated app state

**Type:** Feature
**Priority:** P0
**Size:** M (2–3 days)
**Dependencies:** Blocked by P5-2. Enables P5-5 and all later internal UI.

> **Implementation notes (2026-09-02):**
> - *Entry-point placement:* the ticket says "top left of the map", but the PromptInput panel occupies `top:10px; left:10px` on the map at every breakpoint. The Log in / username link lives in the header nav instead (right of About), styled quieter than the public links (`--blo-stone-soft`, weight 400). Flagged for Nick's sign-off.
> - */api/me now returns `csrfToken`* (same HMAC derivation as login) so a hard-refreshed client can still send mutating calls (logout). Safe: CORS blocks cross-site response reading.
> - *Cypress smoke spec fixed:* it was failing on `main` too — 4s timeout raced the dataset loading overlay, and the "County Rankings" assertion was stale (RankingPanel is query-driven now, absent at rest). Spec now waits out the overlay and asserts the panel is absent at rest.
> - *Local verification env:* `LIBRARY_DEV_PGMEM=1` boots the library on in-memory pg-mem and seeds `dev-admin`/`dev-password-123` (non-production only). Live Cypress golden path gated behind `CYPRESS_INTERNAL_AUTH_LIVE=1`.

### Summary
Add a `/login` route to the Vue app and internal-session state in `useAuth.ts`, establishing the auth-guarded routing pattern later steps (library, wiki) will hang off — while keeping the logged-out app pixel-identical to today.

### User Story
As an internal user, I want to log in inside the map app, so that internal features appear for me and remain invisible to everyone else.

### Context
`useAuth.ts` currently manages the anonymous session + staging tier via localStorage. Internal auth is cookie-based — the client never touches the token; it just tracks "who am I" via `/api/me`. Entry point (decided 2026-09-02): a small visible "Log in" link at the top left of the map.

### Requirements
- [x] "Log in" link at top left of the map → `/login`; unobtrusive, styled consistent with existing map chrome; must not collide with Mapbox controls/geocoder at any breakpoint (check mobile)
- [x] When authenticated, the same top-left spot shows the username → links to `/account` (later: library nav)
- [x] `/login` route: username + password form, error state ("Invalid credentials" — nothing more specific), redirect to `/` on success
- [x] `useAuth.ts`: `internalUser` reactive state, hydrated from `GET /api/me` on app boot (silent 401 = logged out); `login()`/`logout()`; CSRF header wiring for future mutating calls
- [x] Router: `requiresInternal` meta + global guard redirecting to `/login` (pattern only — no internal routes exist yet beyond a trivial `/account` stub showing username/role/logout)
- [x] Logged out: aside from the top-left login link, zero visual or bundle-visible difference on the public map — no internal strings, no layer names, no nav items
- [x] `credentials: 'include'` only on API calls that need it; anonymous-session fetch paths untouched

### Acceptance Criteria
**Given:** a logged-out visitor on `/`
**When:** they use the map
**Then:** experience is identical to production today except a small "Log in" link top left (existing Cypress suite passes unchanged); clicking it lands on `/login`.

**Given:** an internal user at `/login` with valid credentials
**When:** they submit
**Then:** they land on `/`, `/account` shows their username, and a hard refresh keeps them logged in (cookie, not localStorage).

**Given:** a logged-out visitor navigates to `/account`
**When:** the route guard runs
**Then:** they're redirected to `/login`.

### Files to Create/Modify
- `src/views/LoginView.vue`, `src/views/AccountView.vue` (stub) — new
- `src/composables/useAuth.ts` — internal session state (additive)
- `src/router/index.ts` — routes + guard
- `src/lib/apiBase.ts` — credentialed-fetch + CSRF helper

### Testing Notes
- [x] Vitest: useAuth state transitions (mocked API)
- [x] Cypress: login/logout golden path; guard redirect; full existing public-map suite green
- [x] Manual: verify in browser per repo standards (login, refresh persistence, logout)

### Definition of Done
- [x] All acceptance criteria verified in a running browser, not just tests

---

## P5-5 [CHORE] Step-1 security & regression gate

**Type:** Chore
**Priority:** P0
**Size:** S (1–2 days)
**Dependencies:** Blocked by P5-2, P5-4. Closes Step 1.

### Summary
The reality checkpoint before Step 2: automated proof that the public map is unregressed and the auth boundary holds, plus the bundle-leak CI check pulled forward from Step 8 (cheapest to add while the bundle is still clean).

### Requirements
- [x] Endpoint sweep test: every route under `/api/library/*` (and future-guarded mounts) returns 401 unauthenticated — implemented as a test that walks the Express router table so new internal routes are covered automatically
- [x] Bundle-leak check: build script greps `dist/` for a canary list (internal route fragments, "wiki", internal layer slugs — maintained in one file) and fails CI on match; wired into `npm run build` verification
- [x] Confirm `noindex` headers on `/login` and `/account` (netlify.toml)
- [x] Cypress: full public-map regression suite green against a server with auth enabled
- [x] `STAGING.md`/`DEPLOY.md` updated: new env vars, account bootstrap, what the gate checks

### Acceptance Criteria
**Given:** the full Step-1 branch
**When:** CI runs build + server tests + Cypress
**Then:** all green; and intentionally adding an internal string to a client file fails the bundle-leak check (verified once, then reverted). ✅ verified 2026-09-03: planted `console.warn("probe: api/library/leak-test")` in `src/lib/apiBase.ts` → postbuild exited 1 flagging `dist/assets/index-*.js`; removed → clean pass. (Probe must be side-effectful — a bare `export const` gets tree-shaken by Rollup and never reaches `dist/`.)

### Files to Create/Modify
- `server/src/__tests__/authSweep.test.ts` — router-walking 401 sweep
- `scripts/check-bundle-leaks.mjs` + canary list — new
- `netlify.toml`, `package.json`, docs — wiring

### Definition of Done
- [x] Step-1 gate demonstrably passes; Step 2 unblocked

> **Implementation notes (2026-09-03):**
> - `createApp()` extracted from `server/src/index.ts` into `server/src/app.ts` so the sweep walks the **production** router table (`app._router.stack`), not a test double; `index.ts` now owns env validation + boot only. The sweep asserts its own walk works (finds `/api/health`, finds `/api/library/ping`) so a mounting refactor can't silently blind it.
> - Canary list (9 entries) lives in `scripts/check-bundle-leaks.mjs`; `dist/datasets/` skipped (public data mirror, repo-layout rule not string rule). Wired as `postbuild` so Netlify's `npm run build` runs it automatically; standalone via `npm run check:bundle-leaks`.
> - Gate results: server 69 passed / 2 pre-existing usageStore failures (uniqueIps aggregation — unrelated, fails on `main` too), authSweep 5/5, frontend units 13/13, both `tsc` clean, Cypress 7/7 with `CYPRESS_INTERNAL_AUTH_LIVE=1` against a pg-mem-backed server.
> - DEPLOY.md gained a "Step-1 security gate" section + first-admin bootstrap note; STAGING.md gained the `LIBRARY_DEV_PGMEM` local-login recipe.

---

## P5-20 [CHORE] Re-gate the usage dashboard behind internal login

**Type:** Chore
**Priority:** P1
**Size:** XS (hours)
**Dependencies:** Blocked by P5-2.

### Summary
The existing AI-usage dashboard (`/dashboard` + `/api/usage` in `server/src/routes/usage.ts`) is currently gated by the staging-tier password. Swap that gate for `requireInternalUser` so it's part of the internal tier like everything else; the staging password keeps its original deploy-gating role only.

### Requirements
- [x] `/api/usage` guarded by `requireInternalUser` instead of `requireStaging`
- [x] Dashboard page uses the internal session (cookie) — remove its staging-password prompt; unauthenticated visitors to `/dashboard` get a login redirect or bare 401, no data
- [x] `/api/health/usage` gets the same treatment
- [x] Staging-gate behavior elsewhere (map access tiers) untouched

### Acceptance Criteria
**Given:** a logged-in internal user
**When:** they open `/dashboard`
**Then:** it loads without any password prompt.

**Given:** no internal session (including a valid *staging* token)
**When:** `/api/usage` is requested
**Then:** 401/403 with no data.

### Files to Modify
- `server/src/routes/usage.ts`, `server/src/routes/dashboardAssets.ts` (drop password prompt, use credentialed fetch)
- `STAGING.md` — note the gate change

### Definition of Done
- [x] Auth sweep test (P5-5) covers `/api/usage`; existing usage tests updated and green

> **Implementation notes (2026-09-03):**
> - The `/dashboard` page shell stays public (it holds no data — same posture as the SPA's `/login` route); the gate is on the data endpoints, which the sweep now proves return bare 401s. Unauthenticated visitors get an in-page internal-login form posting to the same `/api/login` as the map site — same origin as the API host, so one session covers both the dashboard and the map frontend.
> - New `server/src/routes/usage.test.ts` (6 tests, against the real `createApp()`): internal session → 200 on both endpoints; no session → bare 401; **a valid staging-tier bearer token → 401** (the AC's key case); shipped dashboard page contains no staging references and no `/api/auth` call.
> - `GUARDED_PREFIXES` in the sweep grew to `['/api/library/', '/api/usage', '/api/health/usage']` (7 sweep tests now). Playwright-verified: bad creds → "Invalid credentials.", login → data renders, reload → loads straight in via cookie, no prompt.
> - DEPLOY.md + STAGING.md updated: `STAGING_PASSWORD` is cap-bypass only now, dashboard/usage endpoints use internal accounts.

---

## P5-21 [SPIKE] Choose public-site analytics approach

**Type:** Spike
**Priority:** P2
**Size:** XS–S (timebox: half a day)
**Dependencies:** None (parallel with anything).

### Spike Question
What should track public-map usage (visitors, pageviews, layer toggles, county clicks): self-hosted Umami on our existing API host, hosted Plausible (~$9/mo), or first-party event logging into our own store?

### Evaluation criteria
- Custom events (layer/county interactions) — hard requirement
- No cookie banner needed (privacy-friendly, no PII) — hard requirement
- Ops burden on our single API host; cost; CSP compatibility with the existing helmet config
- Dashboard must be gate-able behind internal login (or embedded in ours)

### Deliverable
Written recommendation in this file (or a short addendum in the spec) with the chosen tool, event list v1, and sizing for the implementation ticket P5-22.

### ✅ Recommendation (spike answered 2026-09-03): first-party event logging

**Choose first-party**, reusing the usage-store + internal-dashboard infrastructure that already exists (and that P5-20 just re-gated behind internal login).

| Criterion | First-party | Umami (self-hosted) | Plausible (hosted) |
|---|---|---|---|
| Custom events (hard req) | ✅ native — events are just rows we define | ✅ | ✅ (counts toward billable volume) |
| No cookie banner (hard req) | ✅ daily-salted IP hash, no cookies, no PII — same scheme `usageStore` already uses | ✅ | ✅ |
| Ops burden | **None new** — same API host, same `DATABASE_URL`, same idempotent-schema pattern | New Node service (~512MB incl. its Postgres; second Railway service ≈ $5+/mo) + Prisma migrations in our DB instance + its own upgrade cadence | None, but $9/mo (10k pageviews/mo tier; events count toward volume) |
| Dashboard behind internal login | ✅ **already is** — extends `/dashboard`, gated by `requireInternalUser` (P5-20) | ❌ Umami ships its own user system; can't ride our session | ⚠️ separate Plausible login; private dashboards embeddable only via shared-link iframe |
| CSP / bundle-leak posture | ✅ no third-party script; nothing internal ships to the client | script from our own host — fine | third-party script origin to allow |
| What we give up | referrer/UTM/geo breakdowns (build-it-yourself; skip in v1) | — | — |

**Rationale:** the deciding criterion is the internal-login gate — only first-party satisfies it natively, and P5-20 already built the exact pattern (Postgres store with in-memory fallback, rollup queries, internal-gated dashboard, tests against `createApp()`). The classic web-analytics extras (referrers, UTM, geo) are the only real loss; if they're ever wanted, hosted Plausible is a $9/mo additive drop-in that doesn't conflict with any of this. Revisit only if that need materializes.

**Event list v1** (allowlist enforced server-side; anything else rejected):
- `pageview` — `{ path }`, fired on SPA route change
- `layer_toggle` — `{ layerId, on }`
- `county_click` — `{ fips }`
- `query_submitted` — no client payload needed (theme + tokens already captured server-side by the usage store; the event just ties volume to visits)

**Mechanics sketch for P5-22:** client batches events (flush every ~10s and on `visibilitychange` via `sendBeacon`/`keepalive`), `POST /api/events` accepts an array (size-capped, per-IP rate-limited, event-name allowlist, props schema-checked); `analytics_events` table (`day`, `ts`, `event`, `props JSONB`, `ip_hash` daily-salted) + daily rollups; raw rows pruned after 90 days, rollups kept; dashboard gets an "Events" tab beside usage. No auth token required to post (public-map visitors aren't logged in) — abuse contained by rate limit + allowlist + tiny payload cap.

**P5-22 sizing: confirmed S–M** (~3 dev days: 1–1.5 server endpoint/store/tests, 0.5–1 client instrumentation, 1 dashboard tab + rollup queries).

---

# Steps 2–8: planned tickets (to be detailed at each step boundary)

| ID | Step | Ticket | Size | Depends on |
|----|------|--------|------|------------|
| P5-6 | 2 | [SPIKE] Choose bucket provider + confirm host disk for mirror (spec open questions) | XS | — |
| P5-7 | 2 | [CHORE] Bucket + server mirror + rclone sync plumbing | S | P5-6 |
| P5-8 | 2 | [FEATURE] Catalog schema, `reindex` from file tree, catalog read API | M | P5-1, P5-7 |
| P5-9 | 2 | [FEATURE] Catalog browser UI (search/filter, seeded data) | M | P5-4, P5-8 |
| P5-10 | 3 | [FEATURE] Upload API → `incoming/` (multipart, size limit, manifest, audit) | M | P5-8 |
| P5-11 | 3 | [FEATURE] Drag-and-drop upload UI + filing form + quick drop / needs-cataloging queue | M | P5-9, P5-10 |
| P5-12 | 3 | [FEATURE] Text-only entries + ideas category with status list | S | P5-10 |
| P5-13 | 4 | [FEATURE] `library pull`/`push` dev CLI + lifecycle statuses + lineage | M | P5-7, P5-8 |
| P5-14 | 5 | [FEATURE] Wiki CRUD API + markdown render (existing DOMPurify stack) | M | P5-2 |
| P5-15 | 5 | [FEATURE] Wiki editor UI + intra-wiki and entry links | M | P5-9, P5-14 |
| P5-16 | 6 | [FEATURE] Save/restore data views (map+query state snapshot) | M | P5-4, P5-8 |
| P5-17 | 6 | [FEATURE] Wiki embed blocks (view/entry cards + open-in-map) | M | P5-15, P5-16 |
| P5-18 | 7 | [FEATURE] Internal layer manifest API + first internal (county) layer on map | M | P5-8, P5-13, P5-16 |
| P5-19 | 8 | [CHORE] Hardening pass + pre-deployment security audit: /security-review sweep, pen-check, rate-limit review, bucket versioning verify, docs | S–M | all |
| P5-22 | — | [FEATURE] Public-site analytics per P5-21 recommendation (instrument events, internal-only dashboard) | S–M | P5-2, P5-21 |
| P5-23 | 7 | [FEATURE] Enrichment pathway: `library geocode` + provenance conventions | M | P5-13 |
| P5-24 | 7 | [FEATURE] Point layers: GeoJSON/CSV points with clustering + popups | M | P5-18, P5-23 |
| P5-25 | — | [FEATURE] Library file download route (spec gap) | S | P5-8 |
| P5-26 | 7 | [FEATURE] LLM awareness of internal layers (stub) | S–M | P5-18, P5-24 |
| P5-27 | — | [CHORE] Homesteading content load via the CLI pathway (stub) | M | P5-13, P5-15, P5-23 |
| P5-28 | 7 | [FEATURE] Entity panel for point layers: list/search/sync/color-by/recency (stub) | M | P5-24 |
| P5-29 | — | [CHORE] Migrate sibling-map datasets into the library + donor-site takedown (stub) | M | P5-23, P5-24 |
| P5-30 | 7 | [CHORE] UI conventions to port from sibling maps (stub) | S | P5-24 |
| P5-31 | 7 | [FEATURE] Dataset explorer: tabular service + in-app table view (browse/search/sort/filter) | M–L | P5-8, P5-13 |
| P5-32 | 7 | [FEATURE] In-app enrichment: edit cells / add columns with provenance + audit (stub) | M | P5-31 |
| P5-33 | 7 | [FEATURE] Ask a dataset: natural-language queries over tables via chat (stub) | M | P5-31, P5-26 |
| P5-34 | 3 | [FEATURE] Link drops: file a URL (dataset/page/source) into the incoming queue without a download | S | P5-11 |
| P5-35 | 7 | [FEATURE] Supersession: archived hidden by default, `supersededBy` pointers, banners | S | P5-9 |
| P5-36 | 7 | [FEATURE] Cross-links + map deep links: show-on-map / browse-data / about from every surface | S–M | P5-24, P5-31 |
| P5-37 | 7 | [FEATURE] Entry hub: Overview / Data / Map / Mentions / Files tabs + wiki backlink index (stub) | M | P5-36 |
| P5-38 | 7 | [FEATURE] Global search / command palette across pages, entries, and layers (stub) | M | P5-36 |
| P5-39 | 7 | [CHORE] UX pass: knowledge-base front door, states, mobile sheets, layer order, wiki polish, naming | M | P5-38 |
| P5-40 | 7 | [FEATURE] Operations home: activity feed, needs-attention, pinned, initiative panel, `library/kb.json` config | M | P5-39 |
| P5-41 | 7 | [FEATURE] Ask the knowledge base: cited Q&A over pages, manifests and datasets, with a dataset query tool | L | P5-31, P5-26 |
| P5-42 | 7 | [FEATURE] Explorer analysis for non-technical researchers: column summaries, group-by, filtered CSV export, ask-about-this-data | L | P5-31 |
| P5-43 | 7 | [STUB] In-app help recipes ("How do I…") and guided first run | S | P5-40 |
| P5-44 | 7 | [FEATURE] In-app document viewer: read PDFs, images, text and markdown without downloading | M | P5-25 |
| P5-45 | 7 | [FEATURE] Every map layer in the knowledge base: layer index, about pages, county table, ask/search coverage | M | P5-31, P5-40 |
| P5-46 | 8 | [FEATURE] Document text extraction: PDFs and Word files become searchable, citable by page, and previewable as text | M | P5-41, P5-44 |
| P5-47 | 8 | [FEATURE] Fetch-and-suggest on drop: the server fetches a dropped link, extracts it, and proposes title/category/tags for one-click filing | M | P5-34, P5-46 |
| P5-48 | 8 | [FEATURE] Save an answer as a note; cross-dataset county join in the explorer | S–M | P5-41, P5-42 |
| P5-49 | 8 | [FEATURE] Page editor: toolbar, side-by-side preview, insert citation from Ask, embed picker | M | P5-15, P5-41 |
| P5-50 | 8 | [FEATURE] MCP server, read tools: search, read, query datasets, layers, views as links — usable from Claude Desktop/Code with a personal token | M | P5-41, P5-45 |
| P5-51 | 8 | [FEATURE] OAuth 2.1 for remote MCP clients (ChatGPT connectors): PKCE, dynamic registration, scoped short-lived tokens, revocation | M | P5-50 |
| P5-52 | 8 | [FEATURE] MCP write tools: notes, pages, link drops, saved views — attributed "via <client>", no deletes | S–M | P5-51 |
| P5-53 | 8 | [STUB] Map views inside ChatGPT (Apps SDK widget) and place dossiers | L | P5-52 |
| P5-54 | 8 | [FEATURE] Saved charts and saved table views: chart any summary, save an explorer state, embed both in pages | M | P5-42, P5-16 |
| P5-55 | 8 | [FEATURE] County comparison table and shortlists: N counties × chosen layers, side by side, exportable, embeddable | M | P5-45, P5-54 |
| P5-56 | 8 | [FEATURE] Data source registry: index datasets we do not hold (kind `source`), structured metadata, seed of environmental-risk and land sources, Ask/search coverage | M | P5-34, P5-41 |
| P5-57 | 8 | [FEATURE] Lazy fetch for a place: adapters (ArcGIS, Socrata, CSV) pull just the slice a question needs, cache it, promote it to a dataset on demand; Ask + MCP tool | L | P5-56, P5-47 |
| P5-58 | 8 | [FEATURE] Place report: "all environmental risks for this property" — run every applicable source for a point or county and write a cited report | M | P5-57, P5-53 |
| P5-59 | 8 | [FEATURE] Link inspection and ingest plan: probe a dropped URL, propose the source block from service metadata, record how it will be ingested, admin "To ingest" queue, Replicate now | M | P5-47, P5-56, P5-57 |
| P5-60 | 8 | [CHORE] Mobile pass across every internal surface: header, tap targets, text size, tables that scroll inside the page, sheets for drawers and panels | M | P5-39 |
| P5-61 | 8 | [FEATURE] Read any page for data: harvest candidate links, prune and rank them with a model pass, read access options from prose, CKAN portals | M | P5-59 |
| P5-62 | 8 | [CHORE] Inspection eval set: labelled real pages, a repeatable opt-in run that scores kept/missed/extra links, roles, prose fields, consistency and cost; prompt fixes the first hand-eval found | S–M | P5-61 |
| P5-63 | 8 | [FEATURE] One taxonomy: topics built on the public layer categories, purposes for documents, controlled tags with aliases — shared by layers, datasets, sources, filters, suggestions, Ask and MCP | M | P5-45, P5-56, P5-61 |

---

## P5-6 [SPIKE] Choose bucket provider + confirm host disk for mirror

**Type:** Spike · **Size:** XS · **Dependencies:** none (opens Step 2)

Answers the spec's two storage open questions: (a) which object storage provider, (b) does the API host have persistent disk for the mirror, or should the server stream from the bucket?

### ✅ (a) Provider (spike answered 2026-09-03): Backblaze B2

**Deciding criterion is versioning, not price.** The spec's deletion-protection safety net is "bucket versioning enabled → automatic version history for free" (and P5-19 explicitly verifies it). B2 versioning is native and **on by default** — every overwrite/delete keeps the prior version. R2's object versioning remains ambiguous as of mid-2026 (native S3 `PutBucketVersioning` reportedly still unsupported; GA claims conflict) — we can't hang the safety net on it.

| Criterion | B2 | R2 | S3 |
|---|---|---|---|
| Versioning (the safety net) | ✅ native, default-on | ⚠️ ambiguous / not S3-API-settable | ✅ |
| Cost at our scale (GBs) | ~$0 (10GB free; $6.95/TB after — cheapest at-rest) | ~$0 (10GB free; $0.015/GB) | Most expensive; no free tier to speak of |
| Egress | Free up to 3× stored/mo (internal team use won't approach it) | Free always | Paid |
| S3-compatible + rclone | ✅ (s3-compat endpoint **and** first-class `b2` rclone backend → P5-13 CLI works out of the box) | ✅ | ✅ |
| Team direct access | ✅ bucket-scoped **read-only application keys** — hand one to the team for "files still there if the app is down" | ✅ scoped API tokens | ✅ IAM (heavier) |

S3 rejected (no AWS footprint, most cost/console overhead). **Portability rule for P5-7:** the server talks to the bucket only via the S3-compatible API/SDK with endpoint + credentials from env (`LIBRARY_BUCKET_ENDPOINT/NAME/KEY_ID/SECRET`) — no B2-proprietary API calls — so switching to R2/S3 later is an env change, not a code change.

### ✅ (b) Host disk: assume NO persistent disk — mirror is a rebuildable cache

DEPLOY.md targets Railway/Render; base services on both have **ephemeral disks** (paid volumes exist — Railway ~$0.15/GB-mo, Render ~$0.25 — but aren't needed). The spec already frames the mirror as "a cache of the bucket," so we design for ephemeral:

- `LIBRARY_DATA_DIR` lives on the ephemeral disk. On boot, the server does a **full sync of the `library/` tree from the bucket** (fine while the library is ≤ a few GB), then serves files from the local mirror. Restarts lose nothing — bucket + Postgres are the sources of truth.
- Uploads write **bucket-first**, then the local mirror (never mirror-only).
- If boot-sync ever gets slow (multi-GB library / cold-start pain), the escape hatches are: attach a host volume, or switch to lazy per-file fetch-and-cache. Noted for P5-7's design comment; not built now.
- Keeps host choice flexible — no host-specific volume dependency.

**Unblocks P5-7** (bucket + mirror + rclone plumbing). Remaining spec open question after this: first internal map layer (P5-18's concern, not Step 2's).

---

## P5-7 [CHORE] Bucket + server mirror + rclone sync plumbing ✅ DONE (2026-09-03)

**Type:** Chore · **Size:** S · **Dependencies:** P5-6

### Acceptance criteria
- [x] Private, versioned bucket exists; server reaches it with a **bucket-scoped** key (never the account master key)
- [x] `server/src/services/libraryBucket.ts`: init from `LIBRARY_BUCKET_*` envs (all five or disabled-with-warning; public map unaffected), injected-client test seam, `putFile`/`getFile`/`deleteFile`/`listFiles`/`syncMirror`
- [x] Writes are **bucket-first, then mirror** — a failed bucket write leaves no mirror-only file
- [x] `syncMirror()` on boot rebuilds the ephemeral-disk mirror: downloads missing/size-changed objects, prunes local strays (bucket is truth)
- [x] `getFile` serves from the mirror, lazily fetch-and-caches on miss (the future escape hatch is mostly pre-built)
- [x] Keys are a security boundary (they become mirror file paths): allowlist regex under `library/`, path-traversal rejected, tested
- [x] Unit tests against an injected fake S3 client (18/18)
- [x] Boot wiring in `index.ts` inside the existing `Promise.allSettled` — sync failure logs and never blocks listen
- [x] Docs: DEPLOY.md env rows + "Library object storage (B2)" section incl. read-only team key and dev rclone recipe
- [x] Bundle-leak canaries added same-PR: `blo-library`, `LIBRARY_BUCKET`

### Implementation notes
- Provisioned live (2026-09-03): bucket `blo-library` (allPrivate, S3-enabled, no lifecycle rules → all versions kept), endpoint `s3.us-west-000.backblazeb2.com`. Two scoped keys minted via `b2_create_key`: `blo-library-server` (list/read/write/delete/share, bucket-scoped → server/.env) and `blo-library-readonly` (list/read → for team direct access). The account master key is NOT used by the server.
- Live-verified: S3 put/list/get/delete smoke with the scoped key, then a real boot (`LIBRARY_DEV_PGMEM=1`) logged `[library] mirror synced: 1 downloaded, 0 kept, 0 pruned` and the object appeared under `library-data/`; seed object cleaned up afterwards.
- `@aws-sdk/client-s3` is dynamically imported inside each op (matches the libraryDb lazy-import pattern; keeps cold paths off the public-map boot).
- rclone itself is not vendored — the dev remote recipe lives in DEPLOY.md; the `library pull/push` CLI that wraps it is P5-13 as planned.

---

## P5-8 [FEATURE] Catalog schema, `reindex` from file tree, catalog read API ✅ DONE (2026-09-03)

**Type:** Feature · **Size:** M · **Dependencies:** P5-1, P5-7

### Acceptance criteria
- [x] `library_catalog` table added to the idempotent boot schema: slug (unique), kind, title, category, status (default `needs-review`), JSONB `tags`/`meta`/`files`, bytes, updated_at — open-ended attributes go in `meta`, no ALTER TABLE ever needed
- [x] `POST /api/library/reindex` walks the bucket tree (`library/datasets/*`, `library/documents/*`), groups files into `(kind, slug)` entries, reads each `meta.json`, and rebuilds the index; returns `{indexed}`; writes a `catalog.reindex` audit entry with the acting user
- [x] Files are truth: entries whose files vanished from the bucket drop out on the next reindex; malformed `meta.json` logs a warning and indexes with defaults (title=slug, status=`needs-review`) instead of crashing
- [x] Reindex deletes **only file-backed kinds** (`dataset`, `document`) — future non-file-backed rows (P5-12 text-only entries, if DB-only) can never be wiped by a rebuild
- [x] `GET /api/library/catalog` with `q` (title/slug substring), `category`, `status`, `kind`, `tag` filters, combinable; `GET /api/library/catalog/:slug` returns full entry incl. meta + file list, bare 404 on unknown slug
- [x] All three routes internal-tier: bare 401 unauthenticated (auth-sweep canaries added), CSRF required on the reindex POST, 503 when the library store/bucket is disabled
- [x] Integration tests against real `createApp()` + pg-mem + fake bucket client (15/15): auth boundary, reindex counts/audit/vanished-files/malformed-meta, list fields, all five filters via `it.each`, detail + 404

### Implementation notes
- Equality filters (category/status/kind) run in SQL; `q`/`tag` filter in JS over the bounded result set (≤200 returned) — sidesteps pg-mem jsonb-operator portability and stays far inside the spec's 500 ms budget at our scale.
- Sequential delete+insert (no transaction) keeps pg-mem compatibility; the index is rebuildable at any time, so a mid-run failure is repaired by rerunning.
- Test-infra notes: per-test logins use a unique `X-Forwarded-For` (app trusts 1 proxy hop) so the 10/hr login limiter doesn't collide, and the seeded user's argon2 hash uses minimum cost params (verify cost is embedded in the hash) so ~15 verifies don't starve parallel suites' timeouts.
- Live-verified against the real B2 bucket + `LIBRARY_DEV_PGMEM=1` boot: seeded `library/datasets/demo-live/`, login → reindex `{indexed:1}` → list/detail/filter/unauth all correct; bucket versions cleaned afterwards.

---

## P5-9 [FEATURE] Catalog browser UI (search/filter, seeded data) ✅ DONE (2026-09-03)

**Type:** Feature · **Size:** M · **Dependencies:** P5-4, P5-8

### Acceptance criteria
- [x] `/library` route (auth-guarded, same `requiresInternal` guard as `/account`): catalog list with debounced free-text search + kind/category/status/tag dropdowns (options derived from the unfiltered catalog so narrowing one filter doesn't empty the others), combinable, with a Clear button
- [x] `/library/:slug` detail route: title/kind/status/category/tags, extra `meta` fields as a definition list, file list with human-readable sizes, friendly not-found state
- [x] Reindex button on the list page (POST via `internalFetch` → CSRF attached) showing the indexed count
- [x] "Library" nav link appears only when logged in; loading/error/empty states throughout
- [x] `src/lib/libraryCatalog.ts` client helpers (`buildCatalogQuery`, `formatBytes`, fetch wrappers) unit-tested (17/17)
- [x] Cypress: logged-out `/library` and `/library/:slug` redirect to `/login` (backend-free); live golden path extended to click through the Library page
- [x] Bundle-leak gate updated same-PR: the `api/library` canary is retired (the catalog UI shell legitimately ships; every `/api/library/*` **response** stays session-gated — data is the gate, same posture as the P5-20 dashboard); the 10 data canaries remain

### Implementation notes
- Live-verified with Playwright against the real B2 bucket (5 seeded demo objects) + `LIBRARY_DEV_PGMEM=1` API + Vite dev: login → Library nav → empty state → Reindex ("Reindexed 3 entries") → q/kind/status filters and Clear all correct → detail page shows `meta.source` + file sizes → unknown slug friendly 404 → zero console errors. Bucket versions cleaned afterwards.
- Cypress gotcha fixed during the run: the new Library click-through initially sat between the `/account` assertions and the `cy.reload()` persistence check, so the reload happened on `/library` — reordered; full e2e 8/8 live.
- File download links are deliberately absent — they arrive with the file-serving/upload APIs (Step 3).

---

## P5-10 [FEATURE] Upload API → `incoming/` (multipart, size limit, manifest, audit) ✅ DONE (2026-09-03)

**Type:** Feature · **Size:** M · **Dependencies:** P5-8

### Acceptance criteria
- [x] `POST /api/library/upload` (internal-tier: bare 401 anon, 403 without CSRF; auto-covered by the auth sweep + canary path added) accepts multipart via busboy and **streams** the file part — temp file on disk, then a streaming `PutObjectCommand` to the bucket; the body never sits in Node's heap (spec: "streamed not buffered")
- [x] Files land bucket-first at `library/incoming/<uuid>/<sanitized-filename>` (SAFE_KEY charset enforced; original filename preserved in the manifest); temp file promotes into the mirror only after bucket success
- [x] Size limit `LIBRARY_UPLOAD_MAX_BYTES` (default 200 MB) → 413 with a clear message naming the limit; oversize attempts leave **nothing** in the bucket or catalog. File **type** is never rejected (Example 8: the .zip goes in as-is, byte-identical)
- [x] Upload manifest written as `library/incoming/<uuid>/meta.json`: uploader id/username, ISO timestamp, original filename, content type, size, plus filing-form fields (title/category/tags/description). Manifest-as-meta.json means `reindexCatalog` rebuilds incoming entries from the bucket alone — `incoming` is now a first-class `FILE_BACKED_KINDS` entry
- [x] Filed upload → catalog row `needs-review` immediately (direct insert, no reindex wait — Example 1); bare quick drop → `needs-cataloging`, title falls back to the filename, still attributed (Example 5)
- [x] Audit entry `library.upload` with actor, target slug, filename/size/quickDrop detail
- [x] 11-test integration suite (real `createApp()` + pg-mem + FakeS3): auth boundary, filed happy path, quick drop, live 413, type acceptance, filename sanitization (UTF-8 names — `defParamCharset: 'utf8'`), no-file 400, non-multipart 400, audit, reindex reproduction

### Implementation notes
- Deps: `busboy` (+types). `@aws-sdk/lib-storage` was evaluated and dropped — the temp-file design knows the exact size, so a plain streaming `PutObjectCommand` with `ContentLength` is simpler and FakeS3-testable.
- Real S3 client now sets `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'`: the SDK's default aws-chunked trailing checksums break B2's S3 layer on streaming bodies. Live-verified against the real bucket: filed upload + quick drop 201, catalog visible pre- and post-reindex (`indexed: 2`), 6 MB file vs 5 MB dev limit → 413 "the upload limit is 5 MB", B2 held exactly the 4 expected objects byte-identical (versions cleaned afterwards).
- `meta.json` filename is reserved: an uploaded file literally named `meta.json` stores as `upload.meta.json`.
- FakeS3's `PutObjectCommand` learned to consume stream bodies (testutils only).
- The `needs-cataloging` bundle canary **stays** — the string is server-side only until the P5-11 queue UI ships (retire it in that PR, same as `api/library` in P5-9).

---

## P5-11 [FEATURE] Drag-and-drop upload UI + filing form + quick drop / needs-cataloging queue ✅ DONE (2026-09-03)

**Type:** Feature · **Size:** M · **Dependencies:** P5-9, P5-10

### Acceptance criteria
- [x] `/library` has a drop zone (drag & drop + hidden-input browse) above the filters; staging files opens a filing form — title (single-file drops only, so a multi-file drop can't mint N identically-named entries), category, tags, description — with **File**, **Quick drop**, and **Cancel** actions
- [x] Client mirrors the server limit (`UPLOAD_MAX_BYTES` = 200 MB): oversize files are rejected before any bytes leave the browser AND server-side (Example 8); server error messages (413 etc.) surface verbatim in the per-file status list
- [x] Uploads run sequentially with a per-file status line (`uploading… / filed for review / dropped — needs cataloging / error`); the list and filter options refresh afterwards
- [x] Quick drops surface in a "N uploads need cataloging" banner; **Show queue** applies the `needs-cataloging` status filter (Example 5's queue view)
- [x] New `PATCH /api/library/catalog/:slug` files (or re-files) an `incoming` entry: merges title/category/tags/description into the bucket manifest **bucket-first** (upload attribution preserved), sets status `needs-review`, rebuilds the catalog row (delete+insert, pg-mem-portable), audits `library.file`. 404 unknown slug, 409 for non-incoming kinds, guarded like every `/api/library/*` route (auth sweep auto-covers the method)
- [x] `/library/:slug` shows a prefilled "File this entry" form for `incoming` entries (File → Re-file after first filing); success note confirms the status flip
- [x] Reindex reproduces filed entries from the bucket alone (manifest is the truth)
- [x] `needs-cataloging` bundle canary retired in this PR (UI ships the string; the DATA stays session-gated) — bundle-leak gate green with 9 canaries

### Implementation notes
- Server: `fileIncomingEntry()` in `services/libraryCatalog.ts` + PATCH route; 2 new integration test blocks in `libraryUpload.test.ts` (filing happy path incl. bucket meta rewrite + reindex reproduction + audit; guards: 401/403/404/409). Client helpers `uploadLibraryFile()` / `fileCatalogEntry()` in `src/lib/libraryCatalog.ts` with 11 new unit tests (form shape, quick-drop `['file']`-only body, client-side oversize with no network call, server-message surfacing).
- `uploadLibraryFile` appends the file part **last** so busboy sees the metadata fields before the stream.
- `formatBytes` drops a trailing `.0` ("200 MB", not "200.0 MB").
- Entry-view gotcha: the prefill watcher must not clear the success note — it re-fires when a successful filing replaces `entry` and would wipe the note a tick later; notes clear on navigation (loading watcher) instead.
- Live-verified via Playwright against real B2: filed upload (immediate `needs-review` row with tags/category), quick drop (filename title, queue banner "1 upload needs cataloging"), Show queue filter, entry filing form flip to `needs-review` + Re-file, "Reindexed 2 entries" reproducing filed metadata from the bucket. All incoming/ test objects (6 versions) cleaned after.
- Cypress live block gained the full quick-drop → queue → file golden path (`CYPRESS_INTERNAL_AUTH_LIVE=1`; writes to the configured bucket — clean up after live runs).

---

## P5-12 [FEATURE] Text-only entries + ideas category with status list ✅ DONE (2026-09-03)

**Type:** Feature · **Size:** S · **Dependencies:** P5-10

### Acceptance criteria
- [x] `POST /api/library/entries` creates a text-only catalog entry (kind `note`): title + body required (clear 400s for missing/blank/unsluggable titles — validation failures leave **nothing** in the bucket), category defaults to `ideas`, tags trimmed. Slug = slugified title with `-2`/`-3`… collision suffixes (slug is globally unique). Internal-tier guarded (bare 401 anon, 403 without CSRF; auto-covered by the auth sweep)
- [x] Notes are **bucket-backed like everything else**: manifest at `library/notes/<slug>/meta.json` carries title/body/category/status/tags plus createdBy/createdById/createdAt — `library/notes/` is a first-class `FILE_BACKED_KINDS` entry and `reindexCatalog` reproduces notes (body + attribution included) from the bucket alone. This resolves P5-8's "if DB-only" hedge: **all** catalog kinds are now file-backed
- [x] Ideas get the status list: category `ideas` → status `open` on create; other categories → `needs-review`. `NOTE_STATUSES = open / planned / done`; out-of-list status on edit → 400 naming the allowed values
- [x] `PATCH /api/library/catalog/:slug` now dispatches on kind: `incoming` → filing (P5-11 behavior unchanged), `note` → in-place edit (title/body/category/tags/status, manifest rewritten bucket-first, slug stable across retitles, attribution preserved), anything else → 409. Audits: create `library.note`, edit `library.note.update`
- [x] `/library` grows a **New idea** button + form (title/body/category/tags; category prefilled `ideas`), an "N ideas in the library" banner with a **Show ideas** shortcut (applies the `ideas` category filter), and open/planned/done status badges
- [x] `/library/:slug` renders the note body (pre-wrap) above the metadata and offers an Edit form with a status selector for notes; non-idea notes sitting at `needs-review` keep their current status unless explicitly moved onto the list (the client only sends allowlisted statuses)
- [x] 15-test integration suite (`libraryNotes.test.ts`, real `createApp()` + pg-mem + FakeS3): auth boundary, idea + non-idea creation (manifest content, immediate `?category=ideas&status=open` visibility, audit), 3-way slug collision, 5 validation 400s with no bucket writes, reindex round-trip, note PATCH (edit + audit, bad status 400, retitle slug-stability, 409 for dataset kind)

### Implementation notes
- Server: `slugify()` / `createNoteEntry()` / `updateNoteEntry()` / `NOTE_STATUSES` in `services/libraryCatalog.ts`; shared `insertCatalogRow()` extracted (catalog writes are delete+insert, pg-mem-portable). Route-level validation messages are user-facing ("a body is required — write at least a sentence").
- Client: `createNoteEntry()` + `NOTE_STATUSES` + note fields on `FilingUpdates` in `src/lib/libraryCatalog.ts` (unit tests to 26). Entry-view gotcha: the status `<select>` unshifts an out-of-list current status (e.g. `needs-review`) for display and submits `undefined` for it — otherwise every edit of a non-idea note would 400.
- `server/vitest.config.ts` gained `testTimeout: 30_000`: each route suite imports the full app (~7s) and the 13-file parallel run oversubscribes CPUs, blowing the 5s default with shifting timeout failures. Full suite now 144 pass (the 2 `usageStore` failures pre-date Phase 5 and fail on main too).
- Live-verified via Playwright against real B2: New idea → "Cross-reference parcel vacancy…" created `open`/`ideas` with correct slug + 423 B manifest, ideas banner + Show ideas filter, detail body render with createdBy/At, Edit → body + status `planned` flip, Reindex → "Reindexed 1 entry" reproducing the **edited** note from the bucket alone. Both manifest versions cleaned from B2 afterwards (0 objects remain under `library/`).
- **Step 3 gate complete** (P5-10/11/12): spec Examples 1 (upload→needs-review), 5 (quick drop→queue), 7 (idea with status), 8 (oversize + odd types) all live-verified.

---

## P5-13 [FEATURE] `library pull`/`push` dev CLI + lifecycle statuses + lineage ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-7, P5-8 · **Step:** 4 (opens and closes it)

### Acceptance criteria
- [x] `npm run library -- pull|push|status` (`server/src/cli/library.ts`) syncs a local folder (default `./library-local`, or `$LIBRARY_SYNC_DIR` / `--dir <path>`) with the bucket's `library/` tree. **SDK-based, not an rclone wrapper** — reuses the bucket service (SAFE_KEY screening, mirror discipline, FakeS3-testable) and needs no external binary
- [x] **Non-destructive defaults:** `push` never deletes remote strays without `--delete`; `pull` never deletes local strays without `--prune` (both are *reported* either way). `push` copies (never moves) local files — `putFileFromPath` gained `{ keepSource: true }` so a push can't destroy the dev's working tree
- [x] Unchanged files skipped by size — **except `meta.json` manifests, which are content-compared** on both pull and push (status flips can be size-neutral). `status` is a read-only dry run (asserted: only `ListObjectsV2` calls)
- [x] Unsafe filenames are skipped with a warning; malformed `meta.json` / unknown `status` **warn but never block** (files are truth) — the unknown-status warning names the known list (`DATASET_STATUSES` + `needs-cataloging` + `NOTE_STATUSES`)
- [x] `push` reindexes the catalog directly + audits (`actor: 'cli'`, `action: 'library.push'`) when `DATABASE_URL` reaches Postgres; otherwise uploads still land and a warning says to hit Reindex in the app. Empty local tree → hard error ("nothing to push — run pull first"), so a wrong `--dir` can't look like success
- [x] Lifecycle statuses: `DATASET_STATUSES = needs-review / in-cleaning / published / archived` exported from `libraryCatalog.ts`; badges for `in-cleaning` (teal) and `archived` (gray) in `/library` and `/library/:slug` alongside the existing published/needs-review/needs-cataloging ones
- [x] Lineage: `meta.json` `lineage` (object `{from, cleaning, script}` or bare string) renders as a dedicated **Lineage** block on the entry view instead of the generic meta list; no server indexing changes needed (reindex already stores full meta JSONB)
- [x] 13-test suite `server/src/cli/library.test.ts` (pg-mem + FakeS3, fresh-mirror-per-run modeled): full pull/push/status contract incl. keepSource regression, manifest content-compare, stray reporting vs `--delete`/`--prune`, warnings, reindex + audit, DB-down fallback, read-only status
- [x] **Stale-mirror reindex bug found live and fixed (TDD):** the running server's mirror-first `getFile` served stale manifest bytes after an external CLI push, so Reindex never saw status changes. Fix: `getFile(key, { fresh: true })` (bypasses + repairs the mirror) used by `reindexCatalog` for every manifest, and the reindex route now runs `syncMirror()` first (size-changed files refreshed, deleted files pruned). Covered by new tests in `libraryBucket.test.ts` + `libraryCatalog.test.ts`

### Implementation notes
- Service seams added: `isSafeKey()` exported (assertSafeKey delegates), `walkLocal()` exported, `putFileFromPath(..., { keepSource })`, `getFile(..., { fresh })`.
- CLI safety detail: `main()` points `LIBRARY_DATA_DIR` at a fresh `mkdtemp` per run (removed on exit) so the CLI's own mirror-first reads can never serve stale bytes on a dev machine.
- DEPLOY.md: dev sync CLI recipe replaces the raw rclone recipe (rclone kept as escape hatch, switched to `rclone copy` — `sync` deletes remote strays by default, which is why the CLI exists).
- Live-verified end-to-end against real B2 (spec **Example 2**, the Step 4 gate): app quick-drop of a messy CSV → `pull` (2 files) → local clean + `datasets/tn-heirs/meta.json` (`status: published`, `lineage: {from, cleaning, script}`) → `push` (uploads, warns "NOT reindexed" without DATABASE_URL, local copies intact) → app Reindex → **published** entry with green badge + Lineage block. Then status flipped to `in-cleaning` via CLI (only the manifest re-uploaded — content-compare) → Reindex → teal badge; flipped back to `published` on a warm mirror → Reindex picked it up (the exact path that failed before the stale-mirror fix). All 6 B2 object versions cleaned afterwards (0 remain under both prefixes).
- Suites: server 159 pass (+2 pre-existing `usageStore` failures, also on main), client 39 pass, vue-tsc + server tsc clean, build + bundle-leak gate green.
- **Step 4 gate complete** (spec Example 2 live-verified).

---

## P5-14 [FEATURE] Wiki CRUD API + markdown render (existing DOMPurify stack) ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-2 · **Step:** 5 (opens it)

### Acceptance criteria
- [x] **Pages are flat files, per the spec:** `library/wiki/<slug>.md` in the bucket tree — no frontmatter, no sidecar manifest. Title = first `# Heading` in the markdown (fallback: the slug), so pages are 100% readable outside the app (Example 4) and ride along in `library pull`/`push` for free
- [x] Indexed into the existing `library_catalog` as kind `wiki` (category `wiki`, status `published`): wiki pages appear in the catalog list/search, and listing rides `GET /api/library/catalog?kind=wiki` — no duplicate list endpoint
- [x] `reindexCatalog()` special-cases the flat `wiki/` prefix (slug from filename, title via **fresh** read of the `.md` — same staleness rule as manifests); `'wiki'` added to the reindex DELETE list (fully rebuildable from files); non-`.md` strays (e.g. `.DS_Store`) ignored
- [x] `GET /api/wiki/:slug` → `{ slug, title, markdown }` (raw markdown; client renders + sanitizes) — bare 404 on miss, 503 when store/bucket off
- [x] `PUT /api/wiki/:slug` takes the **raw markdown body** (`text/plain`/`text/markdown`, router-scoped `express.text` at 1 MB) — not JSON, so pages clear the app-wide 64kb `express.json` limit and the guard 401s before any body parse. 201 create / 200 update with `{ slug, title, created }`
- [x] Validation with user-facing messages: slug `/^[a-z0-9][a-z0-9-]{0,79}$/` (400), empty body (400), JSON-instead-of-text (400 "send the page as raw text/markdown"), > 1 MB (413 naming the limit, via a router-level error handler for body-parser's `entity.too.large`), slug occupied by a **non-wiki** catalog entry (409 — slugs are globally unique in `library_catalog`)
- [x] Auth: `router.use('/api/wiki', requireInternalUser)` — bare 401s, CSRF 403 on PUT; auth-sweep `GUARDED_PREFIXES` += `/api/wiki/`, `EXPECTED_GUARDED_PATHS` += `/api/wiki/:slug` (sweep auto-discovered and 401-verified both methods)
- [x] Audit: `wiki.create` / `wiki.update` with actor, target slug, `{ title, bytes }`
- [x] No DELETE in v1 (spec doesn't ask; bucket versioning + CLI are the escape hatch). No page-history UI, no attribution on pages (audit + B2 versions per spec out-of-scope list)
- [x] 20-test suite `server/src/routes/wiki.test.ts` vs real `createApp()` (pg-mem + FakeS3): auth boundary, create/update/audit, title extraction + fallback, all validation paths, 409 collision, reindex-from-bucket-alone incl. external CLI push + vanished-file drop + stray tolerance

### Implementation notes
- Service additions in `libraryCatalog.ts`: `WIKI_SLUG`, `extractWikiTitle()`, `upsertWikiPage()` (bucket-first, delete+insert row), `getWikiPage()` (catalog row = existence check, mirror-cached file = body). Route file `server/src/routes/wiki.ts`, mounted in `app.ts` after the upload router.
- Live-verified against real B2 (API-level; UI verify lands with P5-15): login → PUT create (201, `created:true`) → GET raw markdown back → catalog `kind=wiki` row → PUT update (200, `created:false`) → reindex `{indexed:1}` rebuilt the row with the revised title via fresh bucket read → unauthenticated GET bare-401. Both B2 object versions cleaned (0 remain under `library/wiki/`).
- Suites: server 181 pass (+2 pre-existing `usageStore` failures, also on main), server tsc clean.
- `'wiki'` bundle canary still in the leak gate — retires in P5-15 when the UI ships (same data-is-the-gate posture as P5-9/P5-11).

---

## P5-15 [FEATURE] Wiki editor UI + intra-wiki and entry links ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-9, P5-14 · **Step:** 5 (closes it)

### Acceptance criteria
- [x] `/wiki` index (`WikiView.vue`, `requiresInternal`): lists every page via the existing catalog client (`fetchCatalog({ kind: 'wiki' })` — no new list endpoint), sorted by title; **New page** form slugifies the title client-side (`slugifyWikiTitle`, mirrors the server's `/^[a-z0-9][a-z0-9-]{0,79}$/` incl. the 80-char cap and NFKD accent-stripping), shows a live `→ /wiki/<slug>` preview, and navigates to the page view carrying `?title=` — so there is exactly one editor code path
- [x] `/wiki/:slug` (`WikiPageView.vue`, `requiresInternal`): rendered view with **Edit** → plain textarea + Write/Preview toggle + Save. A slug that doesn't exist yet (404 → `fetchWikiPage` returns null) drops straight into create mode with a prefilled `# Title` — which also makes hand-typed red links work
- [x] **Intra-wiki + entry links:** `renderMarkdown.ts` gains a wiki profile (`renderWikiMarkdown`): same marked+DOMPurify pipeline, extended tags (`h1–h6`, `table/thead/tbody/tr/th/td`, `pre`), and the module-level DOMPurify hook now exempts internal hrefs (exactly one leading `/`, so `//host` stays external) from the forced `target=_blank` — the page view's container click-intercept routes those through `router.push` in-SPA. External links keep the hardened new-tab treatment; the LLM profile is byte-for-byte unchanged (profile flag reset in a `finally`, covered by a no-leak test)
- [x] Client lib `src/lib/wiki.ts`: `fetchWikiPage` (404 → null), `saveWikiPage` (**raw `text/markdown` PUT** via `internalFetch` — not JSON — matching the server's 1 MB text parser; client-side size pre-check mirrors `WIKI_PAGE_MAX_BYTES`), `slugifyWikiTitle`
- [x] Nav: `Wiki` RouterLink in `App.vue`, internal-users-only like Library; Cypress asserts it's absent logged-out
- [x] `'wiki'` bundle canary retired in `scripts/check-bundle-leaks.mjs` (data is the gate — every `/api/wiki/*` request is session-checked), leak check green with the remaining 8 canaries
- [x] Tests: 12 client unit tests for the lib (slugify table incl. em-dash/§/accents, 404→null, raw-PUT contract with Content-Type assert, oversize pre-check, server-message surfacing) + 7 for the render profiles (tables/headings/pre, internal-link exemption, protocol-relative kept external, XSS strip, LLM-profile isolation); Cypress guard test: logged-out `/wiki` and `/wiki/:slug` → `/login?redirect=`

### Implementation notes
- Sanitization note: both `v-html` sinks in `WikiPageView.vue` are fed exclusively by `renderWikiMarkdown` (DOMPurify). The click-intercept ignores modified/middle clicks and only ever `preventDefault`s hrefs it will route itself.
- Live-verified end-to-end against real B2 (Playwright, dev API pg-mem + real bucket): login → `/wiki` empty state → title "Field Guide (Live Test)" → slug preview → create mode prefilled → page with h1/h2, table, code block, internal + external links → **clicked the internal red link** → in-SPA to `/wiki/second-page-live-test` in create mode → Preview toggle rendered the backlink → created → index lists both pages by H1 title → Edit in place ("Saved.", title → v2) → `/library?kind=wiki` shows both as `wiki`/`published` → **Reindex: "Reindexed 2 entries"** rebuilt from the bucket alone with the updated titles. All 3 B2 object versions cleaned (0 remain under `library/wiki/`); local mirror cache purged.
- Suites: client 60 pass, vue-tsc clean, build + bundle-leak green (20 files, 8 canaries), Cypress 7 pass (+3 live-skipped).
- **Step 5 (wiki) complete.**

---

## P5-16 [FEATURE] Save/restore data views (map+query state snapshot) ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-4, P5-8 · **Step:** 6

### Acceptance criteria
- [x] **Server** (`routes/views.ts`, internal-tier throughout): `POST /api/views` validates name/state/results (results capped at `VIEW_RESULTS_MAX = 100`), slugifies the name server-side with auto-suffix on collision (`-2`, `-3` — createNoteEntry pattern, friendlier than a 409 since the server owns naming), stamps `savedBy`/`savedById`/`savedAt` from the session, writes `library/views/<slug>.json` bucket-first, inserts a catalog row (`kind: 'view'`, category `views`, status `published`, meta `{savedBy, savedAt, resultCount}`), audits `view.create`. `GET /api/views` lists summaries sorted by the documents' own `savedAt` (not index order); `GET /api/views/:slug` returns the full snapshot; wrong-kind slugs 404. `savedAt` doubles as the embed cards' data-as-of date. The `state` payload is opaque to the server — the client is the only reader/restorer.
- [x] **Reindex**: `library/views/*.json` walk branch rebuilds `kind: 'view'` rows from the bucket alone — fresh read recovers the real name + meta; malformed JSON degrades to slug-as-title; vanished files drop; `.DS_Store` junk ignored.
- [x] **Client lib** `src/lib/views.ts`: `saveView` (POST JSON, trims results to the cap client-side), `fetchView` (404 → null), typed `SavedViewState` (layers/filters/limit/regionStates/prompt/viewport) + `SavedViewResult` + `SavedView`.
- [x] **Save UI** (Map.vue, `v-if="internalUser"`, bottom-left above Mapbox attribution): pill → inline name form → success note shows the embed handle (`Saved — embed with view:<slug>`). Captures the TurnSnapshot refs (scoringQuery/filters/limit/regionStates) + last user chat prompt + live viewport (`map.getCenter()`/`getZoom()`) + a region-filtered, display-limited results snapshot (same rows the RankingPanel shows, ≤100).
- [x] **Restore**: `/views/:slug` guarded shim route (`ViewRedirect.vue`, `requiresInternal` → login-redirect flow for shared links) `router.replace`s to `/?view=<slug>`; Map.vue watches the query param, fetches the view, re-applies state through `toolContext.applyQueryState` (the same atomic mutator the LLM tools use) + `map.jumpTo(viewport)`. Early arrivals defer via `pendingViewSlug` until the map's `load` handler (pendingInspectGeoId pattern). Logged-out `/?view=` fetch 401s and is silently ignored — public map unharmed. All state fields defensively checked (opaque payload must degrade, not throw).
- [x] Tests: 20 server route/catalog tests (401 sweep ×3, CSRF, create→bucket+catalog+audit, auto-suffix, 7-case validation table, >100 results 400, list/get/404/wrong-kind, reindex external push + vanished + malformed) and 7 client lib tests (POST contract, cap trim, error surfacing, GET/encode/404-null/503).

### Implementation notes
- Live-verified end-to-end against real B2 (Playwright, dev API pg-mem + real bucket): login → toggled Percent Black + Median Home Value → zoomed to 5.5 → **Save view** "Live Test View (P5-16)" → note `Saved — embed with view:live-test-view-p5-16` → API list + full doc show layers/weights/directions, viewport, 20-row results snapshot, `savedBy: dev-admin` → fresh load of `/views/live-test-view-p5-16` redirected to `/?view=` and restored the exact query (Claiborne #1 90.3), zoom 5.5 → cookies cleared, shim link → `/login?redirect=/views/live-test-view-p5-16` → login completed the loop back to the restored view → logged-out `/?view=` degraded silently (map fine, no Active query) → Save-view control absent logged-out → **reindex `{indexed:1}`** rebuilt the row from the bucket with the real name. B2 version cleaned (0 remain under `library/views/`); mirror cache + temp script purged.
- Suites: server 20 new (full suite green minus the pre-existing time-bombed usageStore pair, flagged separately), client 67 pass, vue-tsc + tsc clean, build + bundle-leak green (21 files, 8 canaries), Cypress all specs pass.

---

## P5-17 [FEATURE] Wiki embed blocks (view/entry cards + open-in-map) ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-15, P5-16 · **Step:** 6

### Acceptance criteria
- [x] **Renderer** (`renderMarkdown.ts`, wiki profile only): fenced code blocks naming an embed — info-string style (` ```view:<slug> `) or body style (bare fence, body `entry:<slug>`) — become inert `<div data-embed="view|entry" data-embed-slug="…">` placeholders via a dedicated `Marked` instance with a `code` renderer override (returns `false` → default rendering for everything else). Slug must match `/^[a-z0-9][a-z0-9-]{0,79}$/` (server slug shape) or the block stays ordinary code. Inline code is never an embed, so prose *about* embeds renders literally. Sanitizer: `div` added to WIKI_TAGS, `data-embed`/`data-embed-slug` explicitly allow-listed (ALLOW_DATA_ATTR stays false); LLM profile untouched — it can't emit placeholder divs at all.
- [x] **Hydration** (`src/lib/wikiEmbeds.ts`): `hydrateEmbeds(container)` upgrades placeholders after the sanitized HTML lands. View card = name + `Data as of <savedAt> · saved by <savedBy>` + top `EMBED_RESULTS_SHOWN = 5` results + "…and N more" + **Open in map →** `/views/<slug>` (P5-16 restore). Entry card = title + kind·category·status + **Open in library →** `/library/<slug>`. All DOM via createElement/textContent — untrusted names can't inject. Invalid kind/slug → note without fetching; 404 → not-found note; fetch failure → error note + console.warn, never throws. Per-slug promise cache (failures evicted for retry) keeps keystroke-level preview re-renders cheap; `clearEmbedCache()` seam.
- [x] **WikiPageView wiring**: `flush: 'post'` watchers on the rendered page ([renderedPage, editing]) and live preview ([renderedPreview, showPreview]) hydrate the freshly-patched v-html containers; hydration is idempotent (data-embed-state marks skip re-work). Preview pane gained the same internal-link click intercept, so card links route in-SPA from both panes. Card/note styles in the `:deep` block.
- [x] Tests: 7 renderer placeholder tests (both authoring styles, invalid slug stays code, inline code literal, ordinary fences unchanged, LLM profile can't emit, hand-written div attrs stripped to the allow-list) + 11 hydration tests (view/entry cards, 5-result cap + "and N more", not-found, invalid-without-fetch, error degradation, idempotency, cross-container cache, failure retry, textContent injection safety).

### Implementation notes
- Live-verified Example 6 end-to-end against real B2 (Playwright, dev API pg-mem + real bucket): login → ranking query (Percent Black + Median Home Value) → **Save view** "TN target counties" → note `Saved — embed with view:tn-target-counties` (the spec's exact slug) → new wiki page `/wiki/maria-target-notes` with the fenced embed + an intentional `view:does-not-exist` → **Preview** hydrated both (card: name, `Data as of Sep 3, 2026 · saved by dev-admin`, 5 results topped by Claiborne County MS 90.3, "…and 15 more", link `/views/tn-target-counties`; missing → "Saved view not found"), inline mention stayed literal → **Create page** → rendered article hydrated identically → clicked **Open in map →** → SPA-routed to `/?view=tn-target-counties` → Active query + exact rankings (Claiborne 90.3 #1, 20 of 3144) + both layers restored. Console clean except the two expected 404s (create-mode page fetch, intentional missing embed). B2 versions cleaned (0 remain under `library/views/` and `library/wiki/`); mirror cache + temp script purged.
- No server changes — embeds are pure client (renderer + hydration) riding P5-14/P5-16 APIs.
- Suites: client 85 pass (19 renderer + 11 embed among them), vue-tsc clean, build + bundle-leak green (21 files, 8 canaries), Cypress 7 pass + 3 live-gated pending.

---

## P5-18 [FEATURE] Internal layer manifest API + first internal (county) layer on map ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-8, P5-13, P5-16 · **Step:** 7 (opens)

### Summary
Make "internal map layer" a **data-driven mechanism**, not a bespoke layer: any `published` library dataset whose `meta.json` carries a `layer` block becomes a county choropleth on the map for logged-in users, riding the existing GEOID + layer-registry pipeline (scoring, weights, filters, ranking, tooltip, saved views, wiki embeds). Layer names, configs, and data never ship in the public bundle. Geometry v1 = `county` only; points are P5-24.

### Context
- Research (2026-09-03): nothing in the homesteading corpus is county-keyed or geocodable as-is (Organizations.csv has no location column), so the *mechanism* is built and verified against a stand-in county CSV; the first real datasets land via P5-23 (enrichment) / P5-24 (points) and the content load.
- The file parsing + cache belongs to the shared tabular service (P5-31 `readDataset`); P5-18's values endpoint is a projection of it (`geoKey` → `valueKey`). If P5-31 ships first, P5-18 reuses it; if P5-18 ships first, it lands the service's parse/cache core and P5-31 extends it — either way one parser, one cache.
- Everything downstream keys on `GEOID` + `LAYER_REGISTRY[id]` (`dataKey`, `range`, `direction`, `formatValue`, `gradient`), so a runtime-registered `LayerDefinition` inherits the whole pipeline. Map.vue's per-category `switch` blocks (`getRawLayerValueFor`, `usePersonalizedScore.getRawValue`, `handleQueryResult` routing, choropleth single-layer branch) each need one generic "internal" branch.

### Acceptance criteria
- [x] **Manifest contract** (`meta.json` → `layer` block, documented in DEPLOY.md + the library-guide wiki page):
  ```json
  "layer": { "geometry": "county", "file": "orgs_by_county.csv", "geoKey": "GEOID", "valueKey": "score",
             "name": "…", "dataType": "index", "unit": "", "direction": "higher_better",
             "range": { "min": 0, "max": 100 }, "description": "…", "source": "…", "year": 2026 }
  ```
  `file` defaults to the dataset's single `.csv`/`.json`. Only `status: published` datasets with a *valid* block are exposed; an invalid block is skipped with one server log line (never fails reindex or the manifest). Validation lives in `services/libraryCatalog.ts` (`parseLayerBlock`) and is unit-tested table-style.
- [x] **Server routes** `server/src/routes/layers.ts`, `router.use('/api/layers', requireInternalUser)` (bare 401s; authSweep `GUARDED_PREFIXES += '/api/layers/'`):
  - `GET /api/layers/internal` → `{ layers: [{ id: 'internal-<slug>', slug, geometry, name, dataType, unit, direction, range, description, source, year, updatedAt }] }` from the catalog index (no file reads).
  - `GET /api/layers/internal/:slug` → `{ id, geometry: 'county', values: { "01001": 12.3, … } }`. Server parses the file (papaparse, add to server deps), zero-pads GEOIDs to 5 digits, skips non-numeric values, caps at `LAYER_MAX_ROWS` (10 000) → 413 beyond; reads via `getFile` (mirror cache) with an in-memory parsed cache keyed by slug + file size, invalidated on reindex. 404 for unknown/unpublished/no-layer-block slugs (same body as unknown).
- [x] **Client lib** `src/lib/internalLayers.ts`: `fetchInternalLayerManifest`, `fetchInternalLayerValues(slug)` (per-slug promise cache, failures evicted — wikiEmbeds pattern), `toLayerDefinition(entry)` (gradient + `formatValue` derived from `dataType`/`direction`, `category: 'internal'` added to `LayerCategory`), `registerInternalLayers(defs)` / `unregisterInternalLayers()` mutate `LAYER_REGISTRY` at runtime and are idempotent.
- [x] **Map integration** (Map.vue): `internalLayers` (defs) + `selectedInternalLayers` + `internalLayerValues` refs; values fetched lazily on first toggle (not at login). Included in `allSelectedLayers` → scoring query; `DataMaps` gains `internalLayerValues` and `getRawValue`/`getRawLayerValueFor` get a generic `internal-` branch; single-layer choropleth branch uses a new generic `getColorForRegistryLayer(geoId, layerId)` (range + direction + gradient); tooltip shows the value via `formatValue`; `handleQueryResult` routes `internal-*` ids to the internal ref. Manifest loads when `internalUser` becomes truthy; on logout every internal ref clears, registry entries are removed, choropleth recomputes.
- [x] **LayerControls**: `internalLayers` prop + `toggle-internal` emit + an "Internal" section rendered only when the prop is non-empty (never logged-out). Weight/direction controls work like any other layer.
- [x] **Saved views** restore a view containing internal ids only after the manifest has loaded (`pendingViewSlug` waits on `internalLayersReady`); ids that no longer exist are dropped silently (existing defensive parsing).
- [x] **Security / leak gate**: no layer names, slugs, or values in `dist/` — the stand-in dataset's slug is added as a bundle-leak canary for the ticket's lifetime; logged-out map is pixel-identical (Cypress smoke asserts no "Internal" section, no `/api/layers` request); `/api/layers/*` returns bare 401 logged-out (sweep).
- [x] **Scenario (gate for Step 7):** *Given* a dataset pushed via `npm run library -- push` with a valid `layer` block and `status: published`, and Reindex run — *When* an internal user opens the map — *Then* the layer appears under "Internal", toggling it colors counties by value with a correct tooltip, it can be weighted with public layers in a ranking, saved as a view, embedded in a wiki page, and none of it is visible or fetchable logged-out.

### Out of scope
- Point / polygon geometry (P5-24); LLM/chat awareness of internal layers (P5-26); generic file download (P5-25); per-entry ACLs; tiling (values-over-API suffices at county scale).

### Files
- Server: `routes/layers.ts` (+ `layers.test.ts`), `services/libraryCatalog.ts` (`parseLayerBlock`, `listInternalLayers`, `readInternalLayerValues`), `app.ts` mount, `authSweep.test.ts` prefixes, `package.json` (papaparse).
- Client: `src/lib/internalLayers.ts` (+ spec), `src/config/layerRegistry.ts` (`'internal'` category), `src/composables/usePersonalizedScore.ts` (DataMaps + generic branch), `src/components/Map.vue`, `src/components/LayerControls.vue`, `scripts/check-bundle-leaks.mjs` (canary), `cypress/e2e/smoke.cy.ts`, DEPLOY.md.

### Tests
- Server: layer-block validation table; manifest excludes unpublished / blockless / invalid; values endpoint parse + zero-pad + NaN skip + cap + 404 + cache invalidation on reindex; 401 sweep.
- Client: lib mapping/caching/register-unregister; scoring reads internal values; logout teardown; Cypress logged-out negative assertions + live-gated toggle path.
- Live verify vs real B2 with the stand-in dataset (push → reindex → toggle → rank → save view → embed), then version cleanup.

---

### Implementation notes
- Server: `services/internalLayers.ts` — `parseLayerBlock` (table-tested; every rejection names the field; `geometry: point` rejected with a P5-24 pointer), `normalizeGeoId` (zero-pad + `…US01001` form), `projectCountyValues` (loose numeric parse, bad rows skipped, last duplicate wins, computed range when the block has none, `LAYER_MAX_VALUES` 10k → 413), `listInternalLayers` (catalog index only, published + valid block, invalid blocks warned once per slug), `readInternalLayerValues` (404 for unknown/unpublished/blockless — the manifest is the only discovery surface). Values are a projection of the P5-31 tabular parse (`readDataset`), so there is one parser and one cache; Reindex refreshes both. Routes `routes/layers.ts` under `/api/layers` (sweep prefix + canaries). Installed no new deps.
- Client: `lib/internalLayers.ts` (manifest/values fetchers with per-slug promise cache + failure eviction, `toLayerDefinition` → registry entry in the new `internal` category with dataType formatter + direction gradient, `registerInternalLayers`/`unregisterInternalLayers` mutate `LAYER_REGISTRY` idempotently, `applyLayerRange` patches the data-derived range in once values load, `colorForRegistryValue` generic choropleth color). Map.vue: `internalLayers`/`selectedInternalLayers`/`internalLayerValues` refs; `internalUser` watcher loads the manifest on login and tears everything down on logout; `allSelectedLayers`, `dataMaps`, `getRawLayerValueFor`, the tooltip closure, `handleQueryResult` routing, `resetQueryScoring`, visibility + color builders (`getColorForInternalLayer`), and `applySavedView` (awaits `internalManifestLoaded` so a view carrying internal ids restores after a fresh load) all gained one internal branch. `usePersonalizedScore`: `DataMaps.internalLayerValues` + prefix-routed lookup + GEOID universe. `LayerControls`/`LensLayers`/`LensLegend`: `internalLayers`/`selectedInternalLayers` props + `toggle-internal`; the "Internal" section renders only when the (logged-in-only) prop is non-empty.
- Tests: 18 service + 8 route (server 275 pass); client 11 lib + 4 scoring + 3 LayerControls + 3 LensLegend (client 126 pass); vue-tsc clean; build + bundle-leak green with the `p518-standin` canary (9 canaries); Cypress 8 pass + 3 pending incl. the new logged-out smoke assertion (no Internal section, zero `/api/layers` requests).
- Live-verified vs real B2 with a synthetic 3,142-county stand-in (`library/datasets/p518-standin/`, pushed via `library push`): Reindex → manifest listed `internal-p518-standin` with its declared range → map Layers tab showed **Internal → Plan target index (stand-in)** → toggle fetched values once and colored the choropleth (pale → BLO green) → legend titled with the layer → adding Percent Black produced County Rankings with a weight slider on the internal layer and a hover tooltip reading "Custom Score 9.1 / 100 · 2 layers weighted · Plan target index (stand-in): 17.7 pts" → **Save view** → fresh load of `/?view=p5-18-internal-layer-view` re-selected the internal layer after the manifest loaded → console clean. Stand-in objects + the test view deleted from B2 afterwards (0 versions remain), mirror purged.
- Follow-ups noted: P5-24 points, P5-26 LLM awareness (the query interpreter's static id list still can't select internal layers), P5-23 geocode so the Organizations dataset can become the first real layer.

## P5-23 [FEATURE] Enrichment pathway: `library geocode` + provenance conventions ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-13 · **Step:** 7

### Summary
Incorporating a new dataset almost always needs an enrichment pass before it can be mapped — add locations, join to county FIPS, record where each fact came from. Make that a first-class, repeatable step of the pull → clean → push pathway instead of ad-hoc scripts.

### Acceptance criteria
- [x] **Provenance convention** (documented in the library-guide wiki page + DEPLOY.md): enriched columns travel with `<field>_source` (URL) and `<field>_confidence` (`high|medium|low`) siblings; `meta.json.lineage` gains `{ from, cleaning, script, enriched: [{ field, method, date }] }`. The Organizations HQ research (2026-09-03) is the first dataset filed this way.
- [x] **`npm run library -- geocode <csv> [--city COL --state COL | --address COL | --lat COL --lng COL] [--out path] [--force]`** appends `lat`, `lng`, `GEOID` (5-digit county FIPS), `geocode_method`, `geocode_confidence`. Primary resolver: US Census Geocoder (free, no key, batch endpoint, returns county FIPS via `geographies`); rows that already carry lat/lng only get the FIPS join. Results cached in a sidecar `<csv>.geocode-cache.json` so re-runs are idempotent and offline; existing values never overwritten without `--force`.
- [x] **FIPS join helper** for rows with county + state names (no geocoder call): normalizes Parish / Borough / Census Area / "St." variants against `public/datasets/geographic/county-lookup.json` (CLAUDE.md FIPS rules).
- [x] **Conflict handling**: rows carrying `<field>_conflict=city` (P5-23 provenance convention; first used on Organizations `hq_conflict`/`hq_alt_location`) geocode the alternate too and emit `<field>_alt_geoid` + `<field>_same_county` (yes/no) — Nick (2026-09-03): conflicting values are fine when they land in the same county; different-county conflicts surface in the dry-run report for review.
- [x] Dry-run report lists unmatched rows with reasons; exit code 0 with warnings (warnings never block, P5-13 rule). Unit tests use a fake resolver; one gated live test hits the Census API.
- [x] **Scenario:** *Given* `organizations.csv` with `HQ City`/`HQ State` columns — *When* Nick runs `library geocode` then `library push` — *Then* the pushed CSV has lat/lng/GEOID + method/confidence columns, `meta.json.lineage` records the enrichment, and the dataset qualifies for a point layer (P5-24) or a county aggregate (P5-18).

### Out of scope
- Automated web research of missing facts (that stays a human/agent task recorded via the provenance columns); non-US geocoding; reverse geocoding.

### Files
`server/src/cli/library.ts` (subcommand) + `server/src/cli/geocode.ts` (+ tests), DEPLOY.md, wiki `library-guide`.

---

### Implementation notes
- `server/src/cli/geocode.ts` (+ 14 unit tests with a fake resolver, 1 gated live test `GEOCODE_LIVE=1`): resolution order existing lat/lng → county only; county + state names → offline `FipsIndex` join over `public/datasets/geographic/county-lookup.json` (Parish / Borough / Municipality / "St." normalised; ambiguous base names such as "St. Louis" MO refused unless the type word is given); street address → Census one-line geocoder (coordinates + county GEOID in one call, no key); city + state → Nominatim place (1 req/s, identifying `User-Agent`, `GEOCODE_USER_AGENT` override) → Census coordinates → county. `cachedResolver` memoises every answer including no-match in `<csv>.geocode-cache.json` (keys normalised for case/whitespace, coordinates rounded to 5 dp), so re-runs are offline. Existing complete rows are kept unless `--force`. Conflict handling auto-detects `<x>_conflict` + `<x>_alt_location`, parses the first "City, ST" from the alternate text, geocodes it, and emits `<x>_alt_geoid` + `<x>_same_county`. Output defaults to `<name>.geocoded.csv` (`--in-place` to overwrite, `--dry-run` for the report only). The subcommand runs before bucket/DB init in `library.ts` — pure local work. Papaparse for CSV I/O (BOM, quoted commas/newlines preserved).
- Docs: DEPLOY.md "Enrichment pathway" bullet (command, resolution order, cache, provenance convention incl. `_conflict`/`_alt_location`/`_alt_geoid`/`_same_county`, lineage.enriched). The `library-guide` wiki page is drafted at `/Users/mac/Desktop/BLO/library-staging/wiki/library-guide.md` for the content load (P5-27) — categories, statuses, adding data, provenance, geocoding, layers.
- **First real run (2026-09-03) on the enriched Organizations CSV** (`--address "HQ Street Address" --city "HQ City" --state "HQ State"`): 100 rows → 99 geocoded (69 census-address high, 30 nominatim-place medium), 159 resolver calls, 136 cache entries; 1 unmatched (Seeding Sovereignty — no location by design); state/GEOID prefixes consistent for all 99; 13 city-level conflicts checked, 4 same-county, 9 different-county listed for review (HEAL Food Alliance Oakland vs Sacramento, Climate Justice Alliance LA vs Berkeley, Democracy at Work Institute San Diego vs SF, US Federation of Worker Cooperatives Philadelphia vs Oakland, Native American Food Sovereignty Alliance Flagstaff vs Scandia MN, CJA Black Caucus, Black Belt Citizens Uniontown vs Faunsdale, NC3 Dover NH vs Ridgewood NY, SAAFON Atlanta vs Raleigh). Output `organizations-enriched.geocoded.csv` + sidecar cache in the staging folder — ready to push as the first point-layer dataset (P5-24).
- Server suite 289 pass (+1 skipped live); tsc clean. No client changes.

## P5-24 [FEATURE] Point layers: GeoJSON/CSV points with clustering + popups ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-18, P5-23 · **Step:** 7

### Summary
Second internal geometry: datasets with `layer.geometry: "point"` (CSV with lat/lng or GeoJSON FeatureCollection) render as a clustered point layer with click popups. First dataset: Organizations HQs (from P5-23).

### Acceptance criteria
- [x] Manifest block extends P5-18: `{ geometry: "point", file, latKey, lngKey, labelKey, popupFields: [...], color?, category? }`; `GET /api/layers/internal/:slug` returns a GeoJSON FeatureCollection whose properties are **only** `popupFields` + label (server-side allowlist — the rest of the row never leaves the server). Cap `LAYER_MAX_FEATURES` (20 000).
- [x] Map: one Mapbox GeoJSON source per toggled point layer with native clustering (`cluster`, `clusterRadius`, count labels), unclustered circles in the layer color, click → popup listing `popupFields`, cluster click → zoom-expand. Layers are added/removed on toggle and on logout; sources are namespaced `internal-<slug>` and never collide with public ids.
- [x] LayerControls "Internal" section shows a swatch for point layers; points do not enter the scoring query (`allSelectedLayers` excludes them) — optional `layer.countyAggregate: true` companion county layer — **stretch, not built** (a county aggregate can be produced with `library geocode` + a GEOID group-by and published as a P5-18 county layer).
- [x] Saved views capture selected point layer ids + viewport and restore them; wiki embed card for a view lists point layers by name.
- [x] Logged-out: no point sources, no requests; leak gate + sweep as P5-18.
- [x] **Scenario:** *Given* the enriched Organizations dataset is published with a point block — *When* an internal user toggles "Organizations (HQ)" — *Then* clustered markers appear nationwide, clicking one shows name/tier/leadership fields, and the state survives a saved-view round trip.

### Out of scope
- Heatmaps, polygon layers, drawing, routing, per-point editing (candidates from the sibling-map survey get their own tickets).

---

### Implementation notes
- Server (`services/internalLayers.ts`): `parseLayerBlock` now accepts `geometry: point` (`latKey`/`lngKey`/`labelKey` required, `popupFields` de-duplicated, `color` `#rrggbb` validated); `projectPointFeatures` builds a FeatureCollection whose properties are **only** `_label` + `popupFields` (a test asserts a `secret` column never leaves the server), skips rows with missing/out-of-range coordinates (counted in `skipped`), computes `bbox`, and 413s over `LAYER_MAX_FEATURES` (20 000). The manifest carries `geometry`, `color`, `popupFields` (names only); `GET /api/layers/internal/:slug` dispatches on geometry. 11 new unit + 2 route tests (server 302 pass).
- Client: `lib/internalLayers.ts` (`pointLayersFrom`, `fetchInternalLayerPoints` with promise cache), new `lib/internalPointLayers.ts` (namespaced source/layer ids, clustered source + clusters/count/points layers in the layer color, DOM-built popup with http links only — `<img onerror>` in a cell renders as text), `LayerControls`/`LensLayers` point rows with a color swatch inside the Internal section (no weight controls — overlays don't score), Map.vue: `internalPointLayers`/`selectedInternalPointLayers`, lazy fetch on toggle, click → popup / cluster click → `getClusterExpansionZoom` → `easeTo`, pointer cursor, county-click guard (a hit on a point/cluster never opens the county rail), logout teardown removes sources/layers, saved views carry `state.pointLayers: [{id,name}]` and `applySavedView` calls `setInternalPointLayers`, embed cards print "Point layers: …". Dev-only `window.__bloMap` handle (dead code in prod) so browser checks can query rendered layers. 5 helper + 1 LayerControls + 1 embed + 2 lib tests (client 135 pass); vue-tsc, build + leak (9 canaries), Cypress 8 pass + 3 pending.
- **First real internal layer — live-verified vs real B2 (2026-09-03):** pushed the geocoded Organizations CSV with a point block (`popupFields`: Tier, HQ City, HQ State, ED/CEO, Website, hq_confidence) → Reindex → manifest listed `internal-organizations` (point, `#ff6b1c`) → `/api/layers/internal/organizations` returned 99 features / 1 skipped with exactly the 7 allow-listed properties (no EIN, board, or notes) → Layers tab showed the swatch row → toggle rendered 22 clusters + 10 singles at zoom 3.5 → clicking Indigenous Environmental Network opened its popup (Tier 1, Bemidji MN, Tom Goldtooth, website link) without opening the county rail → cluster click eased to zoom 4 → toggle-off removed all three layers + the source → **Save view** → fresh load of `/?view=p5-24-org-points-view` re-selected and re-rendered the layer. GOTCHA fixed live: waiting on `map.once('load')` for style readiness deadlocks during a saved-view restore (the map's own post-load source/layer work keeps `isStyleLoaded()` false and `load` never re-fires) — poll `isStyleLoaded()` instead. Objects + view + check page deleted from B2 afterwards; mirror purged.

## P5-25 [FEATURE] Library file download route (spec gap) ✅ DONE

**Type:** Feature · **Size:** S · **Dependencies:** P5-8

### Summary
The spec lists `GET /api/library/file/:id` but no ticket owned it; detail pages list files nobody can download. Add `GET /api/library/file/:slug/:filename` (internal tier) streaming from the mirror (lazy bucket fetch on miss via `getFile`), with `Content-Disposition: attachment`, content-type by extension, `isSafeKey` enforcement, bare 401/404. Detail-page file rows become download links. Audit `library.download` at info level (cheap, useful for the hardening pass).

### Acceptance criteria
- [x] Route + 6 tests (401 sweep, 404 unknown slug/file, traversal attempt 404, streams bytes byte-identical, content-type, audit row).
- [x] `LibraryEntryView` file list links; Cypress guard unchanged.

---

### Implementation notes
- `routes/libraryFile.ts`: resolves `:filename` against the entry's file list by basename (same helper as the client), re-checks `isSafeKey`, then streams from disk via new `libraryBucket.ensureMirrored(key)` (returns mirror path + size; a miss fetches once through `getFile`) — no per-request buffering. Headers: content type by extension (octet-stream fallback), RFC 6266 attachment header with ASCII fallback + UTF-8 `filename*`, Content-Length, `private, no-store`. Audits `library.download` with the key + bytes. Sweep canary `/api/library/file/:slug/:filename`. Note: bucket keys never contain spaces (SAFE_KEY), so filenames are always single-segment ASCII-safe names.
- Client: `libraryFileUrl(slug, name)` in `lib/libraryCatalog.ts`; `LibraryEntryView` file rows are `<a download>` links to the API host (cookie rides on the top-level navigation).
- Tests: 6 route (401, byte-identical CSV with headers + audit + mirror populated, binary PDF, 404 ×4 incl. traversal + NUL) + 2 helper; client 1. Server suite 309 pass, client 136 pass, vue-tsc + build + leak green, Cypress unchanged (guard already covers `/library/:slug`).

## P5-26 [FEATURE] LLM awareness of internal layers (chat can select them) ✅ DONE

**Type:** Feature · **Size:** S–M · **Dependencies:** P5-18, P5-24 · **Stub — refine after P5-18 lands**

### Summary
Today the query interpreter's layer registry and `VALID_LAYER_IDS` (`server/src/prompt/systemPrompt.ts`) are static, so internal layers are UI-toggle only. For requests carrying a valid internal session, build the prompt's registry section from static + internal manifest (names, descriptions, ranges) and extend the id allowlist per request; anonymous sessions keep today's prompt byte-for-byte. Client side already routes any registry id (`handleQueryResult`).

### Open questions for definition
- "Visualize when relevant / queried": a `show_layer` tool (toggle an internal layer by id + `flyTo` its manifest `bbox`) so "show the DC gardens" or "where are the orgs near my top counties" works without a UI click; server computes `bbox` per point layer at reindex.
- Should point layers be LLM-selectable ("show me orgs near the top counties") or only county layers? Prompt-size budget with many internal layers (summarize by category?). Should saved-view prompts mention internal layers by name (they will — fine, views are internal).

---

### Implementation notes (2026-09-04)
- Server: `attachInternalUser` (never denies) runs on `/api/chat` and `/api/query`; when `res.locals.internalUser` is set, the routes load `listInternalLayers()` and pass it to `chatHaiku` / `queryHaiku`. `prompt/internalLayersContext.ts` renders an "Internal data layers (available in this session only)" section (county layers with type/unit/direction/range, point layers marked show-with-`show_layer`; author text clipped and stripped of backticks/newlines). Validation is per request: `validLayerIdsFor(internal)` = public ids + internal *county* ids (point ids never score); `sanitizeQueryResponse` extracted and unit-tested; active-filter context uses the same set. `toolDefinitions.ts` gains `show_layer { layerId, on? }`. 6 tests.
- Client: chat fetch sends `credentials: 'include'`; `mapTools` `show_layer` tool + `ToolContext.showLayer`; Map.vue resolves the id — internal county → toggle; internal point → toggle, wait for the collection, `fitBounds(bbox)`; public → category toggles on/off (`ensurePublicLayerOff` added); unknown → "not available in this session". 2 tests.
- Answers to the ticket's open questions: point layers are LLM-selectable via `show_layer` (not scoring); prompt budget stays small (one line per layer, clipped); saved-view prompts may name internal layers (views are internal).
- Gates: server 333 pass, client 168 pass, vue-tsc, build + leak, Cypress green. Live-verified with the real model: see final report.


## P5-27 [CHORE] Homesteading content load via the CLI pathway ✅ DONE

**Type:** Chore (content) · **Size:** M · **Dependencies:** P5-13, P5-15, P5-23 (for the Organizations dataset) · **Stub — needs Nick's taxonomy sign-off**

Per `HANDOFF-homesteading-library-content.md` §4–5: ~18 catalog entries (datasets/documents/notes incl. `archived` supersession chain), 7 wiki pages, taxonomy — **decided 2026-09-03 with Nick:** `strategy · research · network · outreach · primary-sources · places · ideas` (was `prospects` → `network`: who we know — organizations, individuals, landholders; `outreach` = materials we send out — flyers, one-pagers, catalogs; `wiki` is NOT a category — wiki pages are the knowledge base itself and now index with an empty category; categories are free strings and are expected to evolve, so the library-guide page documents them and a rename is a manifest edit + Reindex); cross-cuts stay in tags; load = `library pull` → stage → `library push` (no `--delete`) → Reindex; first pipeline test at scale. Now unblocked (wiki UI shipped in P5-15/17). Sensitive prospect CSVs stay internal-only; Individuals scoring is *not* a map layer.

---

### Implementation notes (2026-09-03, first real content in the bucket — kept, not cleaned up)
- Push tree built at `/Users/mac/Desktop/BLO/library-staging/push/library/` (55 objects) from the handoff inventory, filenames normalised to the bucket's key rules (no spaces): **3 datasets** (`organizations` — enriched + geocoded, published, point layer "Organizations (HQ)"; `individuals` — 290 scored people, published, tagged `sensitive`; `landholders` — 20-row first-pass extraction of the Strategic Prospect Table + the PDF, `in-cleaning`), **17 documents** (strategy 3, research 6 incl. the retitled comparative-landlessness study, primary-sources 1 entry with both Homestead Act texts, outreach 4 incl. 5 de-duplicated illustrations, archived 3 = Reference Manual, Section 6 extract, landowner comparison table), **2 notes** (`for-william-idea`, `veggies-research-program`, needs-review), **7 wiki pages** (hub `homesteading-initiative`, `evidence-base`, `why-five-million`, `funding-network`, `seed-catalog`, `field-expedition`, `library-guide`) authored from the source documents by three parallel agents with a no-invented-facts rule; each page cites its sources by linking entries and embeds one source card; conflicting figures across documents (acreage 5,000 vs 6,000 vs 8–12k; 1920 farmland measures; land-share statistics) are called out on the pages rather than resolved. Categories: research 9 · strategy 4 · outreach 4 · network 4 · primary-sources 1 · wiki pages uncategorised. Every meta.json carries `source` + `lineage.from`.
- Pushed with `npm run library -- push --dir …` (55 uploaded), then Reindex → **29 entries**; verified in the browser: hub page renders with 29 entry links + 10 wiki links and a hydrated strategic-plan card, `why-five-million` page embeds the memo card, wiki index lists all 7, `/library/individuals/data` shows 290 rows × 11 columns, `landholders` shows `in-cleaning` + Browse data + 3 download links, the manifest lists `internal-organizations:point`.
- **Bug found and fixed by the load:** a wiki page and a document both named `why-five-million` collided on the catalog's globally-unique slug and the reindex INSERT crashed the whole rebuild (500). `reindexCatalog` now de-duplicates by slug in walk order (datasets → documents → incoming → notes → wiki → views), skips the loser with a `[library] slug collision` warning, and returns `collisions`; regression test in `libraryCatalog.test.ts`. The document was renamed `why-five-million-memo` (links updated) and the stray remote folder removed with `push --delete`.
- Not done / follow-ups: split the landholders CSV columns (raw rows kept); review the 9 different-county HQ conflicts flagged by P5-23; Individuals `Name` cells contain some extraction fragments (data-quality note on the funding-network page).


## P5-28 [FEATURE] Entity panel for point layers: list, search, map↔list sync, color-by, recency ✅ DONE (v1: list · search · sync)

**Type:** Feature · **Size:** M · **Dependencies:** P5-24 · **Stub — refine after P5-24 lands**

### Summary
Every sibling map (DC gardens, Memphis green resources, donor map) converges on the same interaction set around points, and none of it exists in the national map: a side list of the visible entities sorted/filtered, text search over name/address/category, click-card → flyTo + open popup and marker-click → highlight card, a legend with per-category counts, a "color by" switcher (tier / status / category) driven by a `COLOR_SCHEMES`-style config, and a recency chip filter when entities carry a date. Build it once as a rail mode driven by the P5-24 manifest (`labelKey`, `categoryKey`, `colorBy: [{ field, scheme }]`, `dateKey`), not per dataset.

### Definition needed
- Rail placement vs `CountyRail` (one rail, modes?) · list cap + virtualization threshold · whether search also hits the geocoder · mobile bottom-sheet behaviour (P5-30).
- Reference implementations: donor `COLOR_SCHEMES`/legend counts (`donor-map/src/main.js:63-107, 416-461`), Memphis list↔marker sync + hover-vs-touch popups (`memphis-map/src/main.js:265-315, 352-416`), DC per-site modal field list (`DC-map/src/components/MapboxGardens.vue:177-225`).

---

### Implementation notes (v1, 2026-09-03 — Nick: "go ahead; I won't know about placement until I see it")
- Placement: a sibling of the county rail in the same fixed right-hand slot (`src/components/EntityRail.vue`, styles mirror `.county-rail`; bottom sheet ≤768px). It shows whenever ≥1 internal point layer is on and nothing county-shaped is open (`entityRailVisible = layers && !dismissed && !railVisible`), so inspecting a county takes the slot and the list returns on close. × hides it until the next layer toggle.
- Contents: every entity of the active point layers sorted by label, subtitle = first two popup fields, swatch in the layer color, layer name per row when several layers are on; search across label + all popup fields; count line ("99 entities" / "8 of 99 match"); rendering capped at 500 rows with a note (`ENTITY_ROWS_MAX`, `src/lib/entityRail.ts`).
- Sync: row click → `easeTo` (zoom ≥ 9) + popup + active highlight; marker click → matching row highlighted and scrolled into view (index resolved by label + coordinates against the fetched collection, now kept in `internalPointData`). Toggle-off drops the layer's rows and clears the highlight; logout tears everything down.
- Tests: 5 component tests (hidden/sorted/subtitles, search, select via click + Enter and dismiss, active + multi-layer names, row cap); client 141 pass; vue-tsc, build + leak, Cypress green.
- Live-verified on the real Organizations layer: 99 entities listed, "atlanta" → 8 matches, clicking Atlanta Land Trust eased from zoom 3.5 to 9 with its popup and highlighted row, × dismissed, re-toggle returned the rail; marker click → row highlight + scroll-into-view checked on a single point (fixed live: rendered features carry tile-quantized coordinates, so the row lookup matches by label + nearest coordinates instead of exact equality).
- Deferred to a follow-up (still stubs in this ticket's definition): color-by switcher, recency filter, legend counts per category.


## P5-29 [CHORE] Migrate sibling-map datasets into the library (donors, DC gardens, Memphis resources) ✅ DC + Memphis migrated; donors kept OUT (Nick 2026-09-04)

**Type:** Chore (content + security) · **Size:** M · **Dependencies:** P5-23, P5-24 · **Stub — needs Nick's call on the donor site**

### Summary
The three sibling apps hold point datasets that belong in the internal library, and two of them ship sensitive data publicly today. Bring each in as a `datasets/<slug>/` entry with a point `layer` block, enriched via P5-23, and retire the public exposure where it should never have existed.

### Per-dataset checklist
- [ ] ~~**Donors (Otsego County, 36 pts)**~~ — **Nick's decision 2026-09-04: the donor list does not belong in this library.** It was imported for verification and then removed: the push tree entry and its notes page deleted and every bucket version purged (0 donor keys remain in any version); the dev mirror copy removed. The public donor site (`otsego-donors.netlify.app`) is unchanged and still serves its JSON — taking it down is a separate action outside this library — `donor-map/public/donor-data.json` carries full names, street addresses, address-precision coordinates, and lifetime giving, served publicly behind a *client-side* password that is readable in the bundle (`donor-map/src/main.js:21`, `dist/assets/*.js`). **First step of this ticket (Nick 2026-09-03: takedown rides with the migration, not before):** take `/donor-data.json` (and the site) off Netlify; then import the pipeline (`scripts/prepare-data.js`: LGL CSV → aggregate → Mapbox geocode) as a server-side enrichment recipe with the token moved to env, honour LGL `Anonymous gift?`/`Anonymous?` flags, and keep street addresses out of `popupFields` by default. Internal-only forever.
- [x] **DC community gardens (70 pts, DC Open Data)** — site data is public, but `CONTACT/CONTACT2/PHONE/EMAIL` are named volunteers with personal numbers/emails (`DC-map/public/Community_Gardens.geojson`). Import full record internal-only; if the public DC map stays up, strip those four fields from its copy. Add a documented refresh recipe (ArcGIS export → GeoJSON).
- [x] **Memphis green resources (114 records, no coordinates)** — currently geocoded live in the browser on every visit (~79 Mapbox calls, `memphis-map/src/main.js:84-109`), 35 records never map. Run `library geocode` once (address precedence chain `address → location → meeting_location → …`), fix the category-key mismatch (4 of 10 categories render as fallback pins), store as GeoJSON with a canonical `category`. Public directory purpose can keep running from a *public* pre-geocoded export that omits phone/email/mailing_address.
- [x] Each entry: `meta.json` with category `prospects` (donors) / `places` (gardens, resources), tags, lineage, provenance columns; wiki page per dataset describing source + refresh.

### Out of scope
- Rebuilding the sibling apps on the national map codebase; whether the public Memphis/DC sites live on is a separate product decision.

---

### Implementation notes (2026-09-04)
- **Donors (REMOVED 2026-09-04 per Nick)** — had been → `datasets/donors-otsego/donors.csv` (36 rows flattened from `donor-data.json`; the one constituent flagged anonymous in the LGL export is de-identified — name, street, zip, lat/lng blanked, `anonymous=yes`; email/phone/birthday/spouse/notes never imported), category `network`, tags incl. `sensitive`, point layer **Donors (Otsego County)** whose popup fields exclude the street address. **Confirmed live exposure today:** `https://otsego-donors.netlify.app/donor-data.json` returns HTTP 200 (25,955 bytes) behind a client-side password. The Netlify CLI on this machine is logged in as Nick (team `nab`, site `otsego-donors`, id `a93f5edc-…`), so the takedown is one command away — **not executed without an explicit go** (destructive on a live site). Options: deploy an empty placeholder to the site (reversible), or `netlify sites:delete` (gone for good).
- **DC gardens** → `datasets/dc-community-gardens/community-gardens.geojson` (70 features, full record internal), category `places`, point layer **DC community gardens** with popup fields ADDRESS/WARD/PLOTS/ORGANIZATION/WEB_URL (no CONTACT/PHONE/EMAIL). A PII-stripped copy for the public DC site is at `library-staging/sibling-maps/Community_Gardens.public.geojson` — swapping it into the DC-map project is Nick's call (that project is not a git repo).
- **Memphis** → flattened 114 records to one CSV (canonical `category`, address precedence chain, city/state defaulted to Memphis, TN when an address exists — 72 rows), then `library geocode --address --city --state`: 100 located (76 Census address, 24 place-level), 14 organizations have no location at all; 89 in Shelby County. Point layer **Memphis green resources** with popup fields category/type/address/city/website/hours (no phone/email/mailing_address).
- Three wiki pages (`donors-otsego-notes`, `dc-community-gardens-notes`, `memphis-green-resources-notes`: source, contents, sensitivity, refresh recipe) — named `-notes` because the catalog's slugs are global and the datasets own the bare slugs (the validator caught the collision before reindex). Pushed with `--delete` to drop the first attempt's keys. Live: reindex → 35 entries, manifest lists 4 point layers, all three new layers render together with the entity rail titled "3 point layers", the donors layer serves 35 features / 1 skipped (the anonymous row) with only the allow-listed popup keys.
- Rebuilding the sibling apps on the national map codebase remains out of scope; whether the public Memphis/DC sites live on is a product decision.


## P5-30 [CHORE] UI conventions to port from sibling maps (mobile bottom sheet, a11y, hover-vs-touch)

**Type:** Chore · **Size:** S · **Dependencies:** P5-24 · **Stub**

Worth lifting regardless of dataset: the CSS-only mobile bottom sheet with drag handle for side panels (`memphis-map/src/style.css:484-530`, donor `style.css:738-805`) as an option for `CountyRail`/entity panel; touch detection that disables hover popups (`memphis-map/src/main.js:373`); `prefers-reduced-motion` / `prefers-contrast` handling and ARIA live regions (`memphis-map/index.html:12,34,54`); `fitBounds` to a layer's extent on enable (`DC-map … MapboxGardens.vue:93-99`, needs `layer.bbox` computed server-side in the manifest). Not ported: DC's dead "region vs city average" panel (the county rail + national averages already cover it), DOM-element markers (don't scale nationally), client-side password gates.

---

## P5-31 [FEATURE] Dataset explorer: tabular service + in-app table view (browse, search, sort, filter) ✅ DONE

**Type:** Feature · **Size:** M–L · **Dependencies:** P5-8, P5-13 · **Soft:** P5-25 (download link) · **Step:** 7 (data tooling)

### Summary
Every dataset in the library should be viewable and queryable inside the knowledge base without a map — at the table level. Add a server-side **tabular service** that parses a dataset file once (CSV / JSON array / GeoJSON properties), infers a schema with column stats, and serves paged, searchable, sortable, filterable rows; and a **DatasetView** page that browses it. The same parsed representation feeds the map layers (P5-18 county values, P5-24 points), so this is the shared foundation, not a side feature. First user story: "look through and search the Organizations and what we know about them."

### Context
- Today `/library/:slug` shows meta + a file list and nothing inside the files (no download either — P5-25). Files can be up to 200 MB (upload cap), so the table must page server-side; the browser never receives a whole file.
- Client already has papaparse; server gets it here (P5-18 then reuses it instead of adding its own parser).

### Acceptance criteria
- [x] **Tabular service** `server/src/services/libraryTabular.ts`: `readDataset(slug, file?)` → `{ file, columns: [{ name, type: 'number'|'string'|'date'|'boolean'|'empty', filled, distinct, min?, max?, mean?, topValues? }], rows, rowCount, bytes, parsedAt }`. Handles UTF-8 BOM, quoted commas/newlines, ragged rows (padded), JSON arrays of objects, GeoJSON (properties + `_lng/_lat`). Type inference from a sample; numbers stay strings in `rows` only if the column is mixed. Parsed cache keyed by slug + file key + size, invalidated on reindex (and by any P5-32 write). Caps `TABULAR_MAX_BYTES` (25 MB) / `TABULAR_MAX_ROWS` (200 000) → 413 with "download instead" message. Files with no tabular shape → 415.
- [x] **Routes** (internal tier, `/api/library/` sweep prefix already guards): `GET /api/library/data/:slug[?file=]` → schema + stats + `rowCount` + file list; `GET /api/library/data/:slug/rows?q=&sort=&dir=&filter=<json>&page=&limit=` → `{ rows, total, page, limit }` (limit ≤ 500, default 50). `q` = case-insensitive substring over string columns; `filter` = array of `{ column, op: 'eq'|'contains'|'gte'|'lte'|'empty'|'notEmpty', value }`; sort typed (numeric vs string vs date). Rows carry `_row` (stable index within the parsed file). Invalid params → 400 naming the field. Reads are not audited.
- [x] **DatasetView** `src/views/DatasetView.vue` at `/library/:slug/data` (`requiresInternal`), reached from a "Browse data" button on `LibraryEntryView` for entries with a parseable file (file selector when several). Sticky-header table, column chooser (hide/show, persisted per dataset in localStorage), click-to-sort, per-column filter popover (text contains / numeric range / empty), global search box (debounced), pagination with total count, row-detail drawer (every field vertically, long text wrapped, URLs linkified), schema panel (type, fill rate, min/max/top values). Query state lives in the URL (`?q=&sort=&dir=&filter=&page=`) so a filtered table is linkable from wiki pages. States: loading, empty, too-large (offer P5-25 download), non-tabular.
- [x] **Client lib** `src/lib/libraryData.ts`: `fetchDatasetSchema`, `fetchDatasetRows`, `buildRowsQuery` (URL ↔ state round-trip), unit-tested.
- [x] **Stretch:** wiki embed ```data:<slug>``` card (columns, row count, "Browse →" link) via the P5-17 embed mechanism.
- [x] **Scenario:** *Given* `organizations` is published in the library — *When* an internal user opens `/library/organizations/data`, searches "Georgia", sorts by Tier, filters `Data Status = Needs extraction` — *Then* the table shows matching rows with a correct total, the row drawer shows every known field for an org, the URL reproduces the view on reload, and none of it is reachable logged-out.

### Out of scope
- Editing rows or adding columns in-app (P5-32); natural-language queries over a table (P5-33); joins across datasets; charts.

### Files
- Server: `services/libraryTabular.ts` (+ tests), `routes/libraryData.ts` (+ tests), `app.ts` mount, `package.json` (papaparse). P5-18/P5-24 consume `readDataset`.
- Client: `views/DatasetView.vue`, `lib/libraryData.ts` (+ spec), `views/LibraryEntryView.vue` (button), `router/index.ts`, `lib/wikiEmbeds.ts` (stretch).

### Tests
- Server: parser table (BOM, quoting, ragged, JSON, GeoJSON, mixed types), stats, search/filter/sort/paging matrix, caps → 413/415, cache invalidation on reindex, 401/404. Client: lib round-trips; component tests for sort/filter/search state → URL; Cypress guard for the new route. Live verify with the Organizations CSV.

---

### Implementation notes
- Built first in Step 7 (Nick 2026-09-03: explorer before the county layer — Organizations is browsable without geocoding, and P5-18/P5-24 project from this parser). Server: `services/libraryTabular.ts` (papaparse; BOM strip, ragged-row padding, blank/duplicate header naming, JSON arrays + GeoJSON `_lng/_lat`; typed inference number/date/boolean/string/empty with `$ , %` tolerance; stats + top-5 values for ≤200-distinct columns; `queryRows` q/filter/sort/page with typed comparisons and empties-last; `parseRowsQuery` names every rejected field; `pickTabularFile` never picks a manifest; parsed cache keyed by file key + size, cleared by the reindex route). Routes `routes/libraryData.ts` mounted after upload; sweep canaries `/api/library/data/:slug(/rows)`. Client: `lib/libraryData.ts` (URL ↔ state round-trip, typed errors), `views/DatasetView.vue` (URL is the source of truth via `router.replace`; debounced search; sort cycle asc→desc→none with `aria-sort`; header filter popover; chips; column chooser persisted per dataset file in localStorage; row drawer with http(s)-only links; schema panel whose top values are one-click "is" filters; too-large/non-tabular/404 states), route `/library/:slug/data`, **Browse data →** on `LibraryEntryView` when a tabular file exists. Stretch ```data:<slug>``` embed card not built.
- Tests: 33 tabular unit + 10 route (incl. 401 sweep, ?file=, 404/413/415, 400 field naming, cache + reindex refresh); client 10 lib + 10 component (vue-test-utils + memory router). Gates: server 248 pass, client 105 pass, vue-tsc clean, build + bundle-leak green (24 files, 8 canaries), Cypress 7 pass + 3 pending (guard extended to the data route).
- Live-verified vs real B2: pushed the enriched Organizations CSV via `library push` → Reindex → entry showed category `network`, lineage block, Browse data → `/library/organizations/data` rendered 100 rows × 20 columns, "georgia" search → 3 rows, URL `filter=[HQ State eq GA]&sort=Organization&dir=desc` → 13 rows correctly ordered with chip + aria-sort, row drawer (Row 43, 20 fields, website link `rel=noopener`), hid `hq_notes` → persisted across reload, schema panel `hq_confidence` high 87 / medium 10 / low 3 → clicking "medium" composed a second filter → 2 rows; logged-out data endpoints bare-401. Console clean. B2 versions deleted (0 remain), mirror purged.
- GOTCHAS: port 5173 was held by an unrelated project — use 5174 (already in ALLOWED_ORIGINS); Playwright snapshots of a 50×20 table blow the tool budget — assert via `browser_evaluate` instead.

## P5-32 [FEATURE] In-app enrichment: edit cells / add columns with provenance and audit

**Type:** Feature · **Size:** M · **Dependencies:** P5-31 · **Stub — Nick: "potentially, but maybe not"; decide after P5-31 is in use**

### Summary
Let internal users fix or add facts directly in the table (e.g., fill an organization's HQ city) instead of round-tripping through the CLI. Writes go bucket-first (`PUT` of the rewritten file; B2 versioning is the history), are audited (`library.data.edit` with a per-cell diff), and automatically maintain the P5-23 provenance convention (`<field>_source` / `<field>_confidence` prompted on edit, `lineage.enriched` appended). Optimistic concurrency via file size/etag → 409 "reload".

### Open questions
- Who may edit (any internal user vs admin)? CSV round-trip fidelity (quoting, column order, BOM). Concurrent editors. Whether a lighter "suggest a correction" note (P5-12 notes linked to a row) covers most of the need without a write path. Does a write invalidate saved views/embeds that snapshot results (they carry data-as-of, so no).

---

## P5-33 [FEATURE] Ask a dataset: natural-language queries over tables via chat

**Type:** Feature · **Size:** M · **Dependencies:** P5-31, P5-26 · **Stub**

### Summary
"Which Tier 1 organizations have a Ford Foundation funder and no ED identified?" → the LLM translates the question into the P5-31 filter/sort spec (validated server-side, never free SQL), the table applies it, and the answer is a linkable filtered view, optionally saved as a view or embedded (```data:<slug>?…```). Builds on the P5-26 per-session prompt plumbing (schema + column stats in the prompt for the dataset in focus). Open: model tier and token budget per dataset, summarisation over sampled rows vs pure filtering, cross-dataset questions.

---

## P5-34 [FEATURE] Link drops: file a URL into the incoming queue without a download ✅ DONE

**Type:** Feature · **Size:** S · **Dependencies:** P5-11 · **Requested by Nick 2026-09-03**

### Summary
Teammates find datasets and sources they can't export in the right format. Let them drop the **link** instead of a file — it lands in the same incoming queue, stays trackable in the pipeline, and Nick pulls/ingests from the link manually (or with a later `library fetch`). Keeps non-technical team members dropping what they find.

### Acceptance criteria
- [x] Library page: next to the drop zone, a "Drop a link" field (URL + optional note; title optional → defaults to the hostname + path) creating an `incoming` entry with **no file**: manifest `library/incoming/<uuid>/meta.json` carries `{ url, note, title, originalFilename: null, uploader, timestamp, status: 'needs-cataloging' }`; the API is `POST /api/library/links` (internal-tier, CSRF, URL validated http(s) only, audited `library.link`). Reindex rebuilds link entries from the manifest like any incoming entry.
- [x] Catalog + queue: link entries show a link icon, the URL as a clickable (rel noopener) line, and the note; the filing form (P5-11) works unchanged so they can be categorised/tagged; status flows `needs-cataloging` → `needs-review` → `in-cleaning` → `published`.
- [x] Ingest path: `npm run library -- fetch <slug> [--as <filename>]` downloads the URL into the entry folder (size-capped, content-type recorded, `lineage.from = url`) so the normal pull → clean → push flow takes over; failures are reported, never block.
- [x] Wiki: ` ```entry:<slug> ` cards for link entries show the URL.
- [x] Scenario: *Given* a teammate pastes a state GIS portal URL with the note "county parcel export, needs login" — *When* they submit — *Then* it appears in the "to file" queue immediately, Nick files it under `places`, and later `library fetch` (or a manual download into the pulled folder) attaches the file with the URL recorded as lineage.

### Out of scope
- Crawling/auto-detecting export formats; scheduled re-fetches.

---

### Implementation notes (2026-09-04)
- Server: `routes/libraryLinks.ts` — `POST /api/library/links` validates http(s) only (`parseLinkUrl`: no javascript:/data:/ftp:, ≤2048 chars), defaults the title to host + path (`defaultLinkTitle`), writes `library/incoming/<uuid>/meta.json` `{ title, category, status, tags, url, note?, linkedBy, linkedById, linkedAt, originalFilename: null }`, indexes the row immediately, audits `library.link`; a bare URL → `needs-cataloging`, any title/category/tags → `needs-review`. Reindex rebuilds link entries from the manifest like any incoming entry; filing (PATCH) keeps the URL. `cli/fetchLink.ts` — `npm run library -- fetch <slug> [--as name]` reads the manifest from the bucket, streams the URL to a temp file with a byte cap (content-length and streamed), derives a bucket-safe filename (path basename → host + content-type extension), `putFileFromPath` into the entry folder, updates the manifest (`originalFilename`, `contentType`, `size`, `fetchedAt`, `lineage.from`), reindexes when the DB is reachable else warns. Sweep canary `/api/library/links`. 6 route + 4 CLI tests.
- Client: `createLinkEntry`, `linkOf`, `hostOf`; Library page "Drop a link" form (URL, optional title, note) next to New idea; cards show "🔗 host" instead of the file count; entry Overview shows a Link block (URL, note, and the `library fetch` hint until a file is attached); wiki entry cards show the URL as an external link. 2 lib + 1 card + 1 hub tests.
- Gates: server 328 pass, client 166 pass, vue-tsc, build + leak, Cypress green. Live-verified: see final report.


## P5-19 [CHORE] Hardening pass + pre-deployment security audit ✅ AUDIT DONE, FIXES IN (2026-09-04)

**Type:** Chore · **Size:** S–M · **Dependencies:** all Step-7 tickets · **Nick 2026-09-03: "after we finish the next phase of tickets we should do another security audit before deployment"**

### Scope
- [x] `security-review` pass over the whole `phase5-auth-core` diff vs `main`, run as three parallel read-only audits (auth/sessions/CSRF/SQL; files/bucket/links/tabular/CLIs; client XSS/deep links/LLM surface) followed by a per-finding false-positive filter. Every finding below is either fixed in this pass or ticketed.
- [x] Manual pen-check sweep against the running dev API (script kept in the session scratchpad): every `/api/library/*`, `/api/wiki/*`, `/api/layers/*`, `/api/views/*`, `/api/me`, `/api/logout`, `/api/usage` route answers a bare `401 {"error":"unauthorized"}` logged out; all nine mutating routes answer `403 forbidden` with a valid session but no / wrong `X-CSRF-Token`; `..%2F`, `%2e%2e%2f` and `../` on file, data, layer and catalog routes → 401/404, never 500 or a file; 70 kB JSON body → 413; unknown `Origin` → 403 before routing, allowed origin → exact-match `Access-Control-Allow-Origin` + credentials; login timing identical for unknown user vs wrong password (≈55 ms both); login limiter trips (429); forged session cookie → 401; helmet headers present (CSP, HSTS, nosniff, frame-options, referrer). Probe artifacts (one link entry) purged from B2 and reindexed away.
- [x] Data exposure review: `popupFields` is enforced server-side for layer payloads (verified); the rows/download routes intentionally give internal users the full file (docstrings corrected). Public bundle: the hub-page slug leak fixed (below); canary list extended; `dist/datasets` now gated by git provenance.
- [x] Bucket: versioning confirmed live (every cleanup this phase listed and deleted versions); key safety regex tightened (length + segment caps); `push --delete` documented and guarded (`--delete-incoming`). Postgres: no shared DB yet — table privileges become a deploy-checklist item (DEPLOY.md).
- [x] Docs: DEPLOY.md security section refreshed; findings recorded here.

### Findings (severity as reported → verdict after the false-positive filter → action)

**Fixed in this pass**
1. **Postgres TLS trusted any certificate** (`libraryDb.ts`, `usageStore.ts`: `ssl: { rejectUnauthorized: false }`) — medium → real (7/10): an on-path attacker or DNS hijack of the DB host could read/spoof session and password hashes. Now verifies by default; `PGSSL_CA` for private CAs, `PGSSL_NO_VERIFY=1` as an explicit, logged escape hatch.
2. **Client-declared MIME stored as the B2 object Content-Type** (`libraryUpload.ts`, `fetchLink.ts`) — low → real (7/10): the app's download route ignores it, but the B2 console / read-only team key would render a `text/html` upload inline on the B2 origin. Object type now derives from the stored filename's extension allowlist; the declared type stays in `meta.contentType` only.
3. **Hub page slug baked into the public bundle** (`src/lib/kb.ts` `KB_HOME_SLUG = 'homesteading-initiative'`) — medium → real (6/10): internal subject matter in a world-readable chunk, and the canary gate had nothing that would catch it. The convention is now a generic `home` wiki page (created and pushed; it links to the initiative hub); `homesteading` added to the canaries; `dist/datasets` files must be git-tracked public datasets.
4. **Link-fetch CLI had no address filtering, redirect re-check, or timeout** (`fetchLink.ts`) — high as reported → false-positive under the threat model (3/10: runs on a dev laptop, requester and operator are both trusted teammates), fixed anyway as cheap defence: public-address check on every hop (loopback, private, link-local, CGNAT, ULA, `localhost`/`.internal`/`.local`), manual redirects capped at 5, 60 s timeout, random `wx` temp file, tolerant filename decoding, normalised content type. `parseLinkUrl` also rejects userinfo, literal IPs and reserved hostnames.
5. **Upload temp files leaked on client abort / truncated multipart** (`libraryUpload.ts`, reproduced) — medium (resource exhaustion; excluded by the review rules, fixed as hardening): temp path hoisted, `pipeline()` write, abort → busboy destroyed, `finally` always removes the temp; busboy `fields/parts/fieldSize` limits and field length caps added.
6. **Over-long keys wedged mirror sync and reindex** (`isSafeKey` had no length cap; a 300-char note title made a bucket object whose mirror path exceeded NAME_MAX, after which `syncMirror` threw forever) — medium (availability; fixed as hardening): key ≤ 1024 and segments ≤ 200 bytes / non-empty; `slugify` ≤ 80, `sanitizeFilename` ≤ 120; `syncMirror` skips a failing object with a warning instead of aborting.
7. **Tabular cache unbounded; reindex not single-flight; no per-user limiter on heavy routes** — medium (DoS class; fixed as hardening): cache bounded by parsed bytes with in-flight dedupe, `__proto__` header safe, reindex returns the in-flight promise, per-user `120/min` limiter on data rows, layer values, upload and reindex.
8. **Login throttle per-IP only; sessions not revoked on re-login; expired rows never pruned; login audit rows without client fingerprint; NODE_ENV unset silently ran dev defaults** — low/hardening: per-username failure throttle (20/h, same 401 body), IPv6 /64 keying where the limiter supports it, previous session revoked on successful re-login, boot-time prune of long-expired sessions, `ipHash` + `ua` on login audit rows, loud boot warning when `NODE_ENV` is unset, cookie `Secure` whenever the request is HTTPS.
9. **Login-CSRF depended on CORS config alone** — low → false-positive (2/10: browsers send `Origin` on every POST and the JSON-only body parser closes the form vector), still made explicit: the login handler refuses a disallowed `Origin` itself via the shared `isAllowedOrigin`.
10. **Auth sweep test was an allowlist** — hardening: inverted to walk every registered route (401 unless in the explicit public set) plus a logged-in CSRF sweep over every mutating route and a production cookie-flag test.
11. **Wiki `/\host` hrefs classed internal** (`renderMarkdown.ts`, `WikiPageView.vue`) — low → excluded (3/10, insider-only tabnabbing), fixed: `isInternalHref` resolves against a fixed origin and rejects backslashes; the click interceptor shares it.
12. **`?layers=` deep link unbounded** — low (client DoS): capped at 24 ids.
13. **Internal residue in localStorage after logout** (chat thread naming internal layers, per-dataset column prefs, embed cache) — low: logout wipes the keys, runs registered cleanup hooks, and clears the in-memory thread.
14. **Manifest `unit` reached the system prompt uncleaned** — low: clipped like name/description.
15. CLI hygiene: `push --delete` refuses to delete `library/incoming/` strays without `--delete-incoming`; dotfiles and `*.geocode-cache.json` never pushed; Census coordinates numerically coerced before the follow-up URL.

**Verified sound (no change)**: cookie flags (HttpOnly; Secure + SameSite=None in prod, Lax in dev), 32-byte session tokens stored hashed, per-login rotation, logout/reset/disable revocation, HMAC-bound CSRF with constant-time compare on every mutating route, argon2id defaults, dummy-hash verify for unknown users with identical responses, all SQL parameterised (the one dynamic WHERE takes column names from a fixed tuple), 64 kB JSON / 1 MB wiki body limits, whitelisted tabular query params, generic error bodies, request log without headers/bodies, salted IP hashes, DOMPurify profiles (no `javascript:`/`data:` hrefs, no event handlers, forced `noopener` on external links), DOM-only popup and embed cards, deep-link ids applied only against the post-login manifest, LLM internal context attached only to DB-validated sessions with `validLayerIdsFor`/`sanitizeQueryResponse` widening only then, CORS allowlist with credentials, helmet defaults, trust-proxy numeric.

**Ticketed / pre-existing (not in this diff)**
- **RentCast API key ships in the public bundle** (`src/config/constants.ts` → `X-Api-Key` header to api.rentcast.io) — real, pre-dates phase 5; `LAUNCH_CHECKLIST.md` already flags the key as compromised. Fix belongs with the public-map listings feature: proxy through the API behind the existing auth + limiter and rotate the key. Not touched here (public map stays pixel-identical).
- `public/datasets/*-properties.csv` carry agent name/phone/email columns on the public CDN — confirm licensing and intent (pre-existing).
- `requireAdmin` is unused by any route: every internal user can reindex, edit any page, file any entry. Acceptable for the current team; revisit when the team grows (ownership checks on wiki/notes, admin-only reindex).
- Idle session timeout (currently 30-day absolute): revisit with the above.
- No CSP on the Netlify front end (helmet covers the API only): defence in depth for a later pass.
- `hiddenColumns` manifest field for sensitive columns in browsable datasets: only needed if a dataset must show a layer but hide a column; downloads could not honour it, so such a column would live in a separate file.
- IPv6 /64 keying for the per-IP login limiter needs `ipKeyGenerator`, which express-rate-limit 7.5.1 does not ship — upgrade the dependency, then key on the subnet.
- The sync CLI's `push` still labels objects with its own narrower `contentTypeFor` (undefined for unknown extensions); consolidate onto `services/contentTypes.ts` in a follow-up.

### Implementation notes (2026-09-04)
- Gates after the pass: server 454 pass + 1 skipped (31 files), client 179 pass, tsc + vue-tsc clean, build + bundle-leak (10 canaries + `dist/datasets` provenance) green, Cypress 9 pass + 3 pending. Live re-probe against the restarted dev API: `NODE_ENV` boot warning present; disallowed `Origin` on login → 403 with no cookie, allowed origin → 200 + cookie; two concurrent reindexes → one run, identical results; link drops to a link-local address, a URL with userinfo, and `localhost` → 400 (queue stays empty); 125 quick row requests → 118 × 200 then 429 (the two reindexes counted toward the same 120/min budget); re-login invalidates the previous cookie (old → 401, new → 200).
- Extra bug found while fixing the upload leak: tripping busboy's `fieldsLimit` before the file part arrived left a temp file nobody removed; the stream is now drained once the request is finished (tested).
- New modules: `middleware/origins.ts` (shared allowlist), `services/pgSsl.ts`, `services/hostGuard.ts`, `services/contentTypes.ts`, `middleware/internalRateLimit.ts`; schema gains `library_sessions.revoked_at` (added with `ALTER TABLE … IF NOT EXISTS` on boot).

### Deploy-checklist additions (mirrored in DEPLOY.md)
Set `NODE_ENV=production`; verify the DB certificate chain (or set `PGSSL_CA`); confirm `TRUST_PROXY_HOPS` against the real topology from the first request log line; grant the API's DB role only the library tables; keep the B2 read-only team key scoped to the bucket; run the auth sweep + Cypress before promoting.

---

## P5-40 [FEATURE] Operations home: activity feed, needs-attention, pinned, initiative panel, `library/kb.json` ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-39 · **Nick 2026-09-04:** "go deeper on ux. think operational center for all things blacklandownership.com, this new initiative, quick answers, data analysis for PhD's with low tech abilities"

### Why
The `/kb` landing is a directory. An operations center answers "what happened, what needs me, what matters right now" before "where is everything". The initiative (5-5-5) should be visible as a thing with numbers and a next step, not a wiki page you have to know to open.

### Acceptance criteria
- [x] **Config in content, not code:** `library/kb.json` in the bucket (pushed like any file; validated, all fields optional) → `GET /api/library/kb` (internal) returns `{ homeSlug, pinned: [resolved catalog refs], initiative: { name, tagline, facts: [{label, value, href?}], nextStep?: {text, href} }, links: [{label, href}] }`. Unknown/missing file → sensible defaults (`homeSlug: 'home'`, empty lists). Read fresh at reindex (cached in between, like manifests). The client stops hard-coding the hub slug.
- [x] **Activity feed:** `GET /api/library/activity?limit=` (internal, ≤ 100) from `library_audit`, display-allowlisted actions only (uploads, link drops, filings, notes, wiki create/update, view saves, downloads, reindex, CLI pushes; never logins or user admin), each row → `{ at, actor, verb, target: {slug, title, kind, href} | null }` with titles resolved from the catalog. Landing shows the last ~12 with relative times; "Show more" loads 50.
- [x] **Needs attention** panel (computed from the catalog the landing already fetches): to-file queue (`needs-cataloging`), `needs-review` entries, datasets `in-cleaning`, and link drops without a fetched file — each a count with a deep link into the filtered list; hidden when everything is zero ("All clear").
- [x] **Pinned** row from `kb.json.pinned` (cards with kind badge + title + one-line description) and the **initiative panel** (name, tagline, facts as big numbers, next step, links) at the top of the landing. `AskBox` (P5-41) sits directly under the initiative panel — the first interactive element on the page.
- [x] Layout: two columns on desktop (left: initiative → ask → needs attention → activity; right: pinned → section tiles → quick actions → recently updated), single column on mobile in that same order. Skeletons for activity and pinned; empty states in plain words.
- [x] Content: `kb.json` written into the push tree with the real initiative facts (5 years, $5M, 5,000 acres; sourced from the strategic plan entry), pinned = hub page, library guide, organizations dataset, strategic plan, funding network page.
- [x] Tests: server config parsing/defaults + activity allowlist/resolution; client landing panels (empty/non-empty), attention computation, activity rendering. Live-verified on the loaded content.

---

## P5-41 [FEATURE] Ask the knowledge base: cited Q&A with a dataset query tool ✅ DONE

**Type:** Feature · **Size:** L · **Dependencies:** P5-31, P5-26 · **Nick 2026-09-04:** "quick answers"

### Why
The team should be able to type "which organizations in Georgia do land trusts?" or "what does the funding strategy say about year two?" and get an answer with sources they can open — without knowing where things live. The map chat already talks to Anthropic; this is the same pattern pointed at the library.

### Acceptance criteria
- [x] `POST /api/library/ask` `{ question, dataset? }` (internal, CSRF, per-user limiter, daily budget middleware) → `{ answer, sources: [{ n, slug, kind, title, href, snippet }], queries: [{ slug, filters, groupBy?, rowCount, href }] }`. Never streams internal data to anyone without a validated session; audited as `library.ask` (question truncated to 200 chars, source count, tool calls).
- [x] **Retrieval without embeddings:** a search index built at reindex (cached, cleared with the tabular cache): every catalog entry (title, description, tags, category, kind, status), wiki pages chunked by heading (≤ 1,500 chars/chunk), note bodies, dataset schemas (columns + types + row count) and any README in a dataset folder, link URLs. Simple TF-IDF/BM25 scoring with title boost; top chunks within a ~24k-character context budget; a `dataset` hint pins that dataset's schema into context.
- [x] **Answer generation:** Anthropic model from `LIBRARY_ASK_MODEL` (default `claude-sonnet-5`; Haiku 4.5 acceptable for cost), system prompt: answer only from the excerpts, cite as `[n]`, say when the library does not contain the answer, keep it short. Tool `query_dataset({ slug, filters[], groupBy?, limit })` backed by the existing `queryRows` (+ a small group-by count) so data questions get real numbers; ≤ 3 tool rounds; every returned table also yields a deep link into the explorer (`/library/<slug>?tab=data&filter=…`) and, for layer datasets, a map link.
- [x] Client: `AskBox` on the landing, on dataset pages ("Ask about this data" → `dataset` hint), and as the first row of ⌘K ("Ask: …"). `/ask?q=` page: question, answer rendered with the LLM markdown profile, numbered sources with kind badges linking into the app, query cards ("Open in table" / "Show on map"), follow-up box, recent questions in localStorage (`blo:ask`, wiped at logout). Loading state with the retrieval count ("Reading 7 pages and 2 datasets…"), error and budget states in plain words.
- [x] Tests: index build/scoring, chunking, context budget; tool loop with a fake Anthropic client (query tool called with validated filters; unknown slug refused); route auth/CSRF/limits; client Ask page states and source links. Live-verified with real questions against the loaded content.

---

## P5-42 [FEATURE] Explorer analysis for non-technical researchers ✅ DONE

**Type:** Feature · **Size:** L · **Dependencies:** P5-31 · **Nick 2026-09-04:** "data analysis for PhD's with low tech abilities"

### Why
The table explorer filters and sorts. A researcher who does not write code wants to *understand* a column, count things by category, and take the filtered result with them — in plain language, without a spreadsheet detour.

### Acceptance criteria
- [x] `GET /api/library/data/:slug/summary?file=&column=&…same filter/q params as rows` (internal, limiter): with `column` → `{ column, type, filled, empty, distinct, top: [{value, count}] (≤ 20), numbers: {min, max, mean, median} | null, dates: {min, max} | null }` for the CURRENT filtered set; without `column` → per-column overview `[{ column, type, filledPct, distinct }]`. Cached per (dataset, filters).
- [x] `GET /api/library/data/:slug/export.csv?…same params` → the filtered rows as CSV (attachment, formula-escaped, `no-store`, ≤ 200k rows), audited `library.export`.
- [x] Explorer UI: an **Overview** strip ("312 rows · 187 match your filters · 14 columns"); per-column **Summarize** (from the column header menu and a "Summaries" toggle) showing a distribution as simple bars (top values with counts and %; numbers as min/median/max + a 10-bin histogram; dates as range) — click a bar to filter by that value; **Group by** any column → a summary table (value · count · %) with click-to-filter and its own CSV download; **Download filtered CSV**; **Ask about this data** (P5-41 box with the dataset hint). Everything labelled in plain words (no "aggregate", "facet", "cardinality").
- [x] Mobile: summaries stack under the table; bars remain readable.
- [x] Tests: summary math (numbers/dates/strings, empties, filtered set), export escaping and caps, route auth/limits; client summary panel, group-by table, click-to-filter round trip through the URL state.

---

## P5-43 [FEATURE] In-app help recipes and guided first run ✅ DONE

**Type:** Stub · **Size:** S · **Dependencies:** P5-40

A "How do I…" drawer (find an organization, show something on the map, ask a question, drop a link, download a filtered table) sourced from the library guide, and a first-run checklist on the landing for new team members. Define after P5-40–42 land and the surfaces settle.


### Implementation notes (2026-09-05)
- `src/lib/helpRecipes.ts`: 21 recipes on six shelves (Find things · Ask · Look at data · Maps · Add things · Read), each step quoting the label the app really shows; `searchRecipes`, `groupRecipes`, and a shared `openHelpDrawer()` flag. `HelpDrawer.vue`: right-side panel, searchable, expand → steps + "Take me there", Esc, `?` when no input is focused, focus trap, `aria-modal`; opened from the header Help button beside Search (internal only) and from "How do I…" at the foot of the landing. Loaded as an async component so its how-to copy stays out of the public entry chunk.
- `src/lib/firstRun.ts` + `FirstRunChecklist.vue`: six items (Start here, ask, open a table, show a layer, drop or upload, open a document) detected from route visits by a router hook registered in App (so visits count while the landing is unmounted), stored as progress only in `blo:firstrun` (deliberately not wiped at logout), "Getting started — N of 6", Dismiss, hidden when complete; placed below the initiative panel and above the Ask box.
- Recipe hrefs are validated against the router source read as text (importing the router pulls mapbox-gl into jsdom). Two recipes were updated by the lead once their features landed: find-in-document now describes the Text view and find box (P5-46), and a new "Add county numbers next to your rows" recipe covers county context (P5-48).
- Tests: helpRecipes 9, firstRun 12, HelpDrawer 10, FirstRunChecklist 6, App 4 (new), KnowledgeBaseView +3. Client 556 pass; type-check + build (35 files, 10 canaries) green.

---

## P5-44 [FEATURE] In-app document viewer ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-25 · **Nick 2026-09-05:** "we should be able to see pdf's / other docs in app instead of having to download them to review"

### Why
Reviewing a document should not mean downloading it. A PDF, an image, a text or markdown file should open in the app; only formats a browser genuinely cannot render (docx, xlsx, zip) fall back to download.

### Acceptance criteria
- [x] **Server, inline-safe only.** `GET /api/library/file/:slug/:filename?disposition=inline` serves `Content-Disposition: inline` **only** for an allowlist of types that render without executing script: `pdf`, `png/jpg/jpeg/gif/webp`, `txt/md/csv/tsv/json/geojson`. For anything else (docx, xlsx, pptx, rtf, zip, and — critically — any `text/html` or `image/svg+xml`, which stay `application/octet-stream` in the type table) the `inline` request is ignored and the file is still served `attachment`. This preserves the P5-19 rule that nothing uploaded renders as active content. Inline serves are audited `library.view` (kept out of the activity feed); attachments remain `library.download`. `X-Content-Type-Options: nosniff` on both (helmet already sets it globally).
- [x] **Client renders from a blob, not a cross-origin frame.** The viewer fetches the file through `internalFetch` (so the session cookie and API base are handled, and it works under dev's `SameSite=Lax` where a cross-origin `<iframe src>` would not) and renders a same-origin `blob:` URL: PDFs in an `<iframe>`/`<embed>` (the browser's sandboxed PDF viewer — a blob PDF cannot run page script), images in `<img>`, text/csv/tsv/json in a `<pre>`, markdown through the wiki markdown renderer (DOMPurify). Blobs are revoked on close/navigation. A size ceiling (`VIEW_MAX_BYTES`, ~25 MB) falls back to download.
- [x] **Unsupported formats** (docx/xlsx/pptx/zip/rtf/unknown) show "Preview isn't available for this file type — download it to review" with the download link, honestly, rather than an empty frame.
- [x] **Entry integration.** On the entry page Files tab each viewable file gets a **View** action beside its download link; the raw-file list keeps the download link for every file. Opening a file sets `?view=<filename>` on the entry route (deep-linkable, shareable, back-button closes it) and shows the viewer full-width in the tab with the filename, a Download button, and a Close/back-to-files control. A non-viewable `?view=` falls back to the file list.
- [x] Tests: server disposition/allowlist (inline for pdf/txt, attachment forced for html/svg/docx even with `?disposition=inline`, `library.view` vs `library.download` audit rows); client viewer kind detection, blob fetch + render per kind, size-cap fallback, unsupported message, and the entry `?view=` open/close round trip. Live-verified on a real PDF in the loaded content.

### Notes
- The map/table already render their own data; this is for prose documents. CSV/TSV entries still get the table explorer as their primary surface — the viewer is the raw-bytes fallback.


### Implementation notes (2026-09-05)
- Built by three parallel Opus agents (P5-40, P5-41, P5-42) with per-file ownership plus two seams put in first: an `AskBox` stub both could place, and `onReindex(hook)` in `services/libraryCatalog.ts` so derived caches (kb.json, the Ask index) rebuild after every reindex without touching the rebuild itself. P5-44 and the admin gate were done by the lead.
- **P5-40**: `services/kbConfig.ts` (defensive parse, caps 12 pinned / 6 facts / 8 links, hrefs must be same-origin paths), `services/libraryActivity.ts` (`ACTIVITY_VERBS` is the allowlist; targets resolved in one batched query; downloads record a bucket key so `detail.slug` wins), `routes/kb.ts`; client `lib/kbConfig.ts`, `InitiativePanel`, `PinnedRow`, `AttentionPanel`, `ActivityFeed`, landing restructured; `LibraryView` learned `?kind=` so the "links with no file" row can deep-link. **Nick 2026-09-05: needs-attention is an admin concern** → `AttentionPanel` and the To-file alarm render only for `role === 'admin'`; regular members see the tile as plain navigation.
- **P5-41**: `services/kbSearch.ts` (BM25 k1=1.2/b=0.75, title boost 2.5, heading chunks ≤ 1,500 chars, 24k-char context budget, lazy build with in-flight dedupe, cleared on reindex), `services/askKb.ts` (≤ 3 tool rounds then tools withdrawn; `query_dataset` validated by `parseRowsQuery`; own group-by ≤ 5,000 rows), `prompt/askPrompt.ts` (static system prompt; excerpts ride in the user turn), `routes/libraryAsk.ts` (guard → limiter → budget; reserve/settle like chat). Client `lib/ask.ts`, `AskBox`, `AskView`, ⌘K "Ask: …" first row, `blo:ask` wiped at logout. Only cited excerpts are returned as sources (top 3 as "Related material" when nothing was cited).
- **P5-42**: `summarizeColumn`/`overviewColumns` cached per (parse, filter signature) in a WeakMap on the parsed dataset; `queryRows` = `selectRows` + page slice (identical output, tested); export streams 1,000-row chunks, unconditional formula escaping (a negative number exports as `'-5` — soften if researchers complain); client `ColumnSummary`, `GroupBySummary`, `DistributionBars`, overview strip, header-menu Summarize/Group by, click-to-filter through URL state, "Ask about this data".
- **P5-44**: server `isInlineSafe` allowlist + `dispositionHeader`; `library.view` audit; client `lib/documentView.ts` (`viewKind`, `loadDocument` → blob URL / text / rendered markdown, 25 MB cap), `DocumentViewer.vue`, entry Files tab `?view=<name>` (view button for viewable files, download link for all).
- Gates: server 589 pass + 1 skipped (37 files), client 274 pass (27 files), tsc + vue-tsc clean, build + bundle-leak (29 files, 10 canaries) green, Cypress 9 pass + 3 pending. Live on the dev API after pushing `kb.json`: initiative panel with the three facts, six pinned cards, ask box first, admin sees "Needs attention · All clear"; Ask answered "Which organizations are in Georgia, and what is the 5-5-5 plan trying to raise?" in 7 s with four cited sources, two query cards (table deep link filtered on HQ State, map link) and "Read 5 pages, 1 dataset and 2 documents."; explorer shows "100 rows · 27 columns" with Summaries and a filtered-CSV export link; the strategic plan PDF opens in-app from a blob URL at `?view=…pdf`.

---

## P5-45 [FEATURE] Every map layer in the knowledge base: layer index, about pages, county table ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-31, P5-40 · **Nick 2026-09-05:** "make it so all the data layers are viewable, not just internal ones, and they have about pages etc"

### Why
The public map's county layers (demographics, economics, housing, equity, transportation, contamination…) are data the team reasons with every day, but inside the knowledge base only internal datasets have an about page and a browsable table. A researcher should be able to open any layer, read where it comes from, see its numbers county by county, and jump to it on the map — exactly like an internal dataset.

### Acceptance criteria
- [x] **Layer index** at `/layers` (internal-gated, in the KbNav as "Map layers"): every public layer from `LAYER_REGISTRY` grouped by category, plus the internal layers from the manifest when logged in (linking to their library entries). Each row: name, one-line description, unit, year/source when known, "About" and "Show on map". Searchable by name/description; ⌘K search includes public layers (kind label "layer").
- [x] **About page** at `/layers/:id` for every public layer: name, category, what it measures (registry `description`), data type / unit / direction ("higher is better"), value range, source and year when the registry or layer config carries them, and honest "Source: not recorded" otherwise; actions **Show on map** (`/?layers=<id>`) and **Ask about this layer** (AskBox with a `layer` hint → the Ask retrieval index includes public layer metadata so the model can explain a layer and name its source).
- [x] **County table**: the layer's values for all counties, rendered client-side from the data the map already loads (`useMapData`), with county name + state (from the county lookup already in the client), the value formatted per data type, search, sort by value/name, paging, and **Download as CSV** (client-side). The same plain labels as the explorer (P5-42). Keep it lazy: load the layer's data only when the page opens, never for the whole registry at once.
- [x] **Internal layers keep their own pages**: an internal layer row on the index and any `/layers/internal-<slug>` URL redirect to `/library/<slug>` (the entry hub already has About / Data / Map tabs).
- [x] The public map stays pixel-identical and its bundle unchanged for logged-out visitors (new views are lazy routes behind `requiresInternal`; the bundle-leak gate must stay green).
- [x] Tests: registry → index grouping and search; about-page fields incl. the "not recorded" fallback; county table sort/search/paging/CSV from a mocked data loader; internal redirect; ⌘K rows. Live-verified on two public layers and one internal one.

### Notes
- Source/year fields: `LayerDefinition` in `src/config/layerRegistry.ts` is the truth; where a source is missing, add it to the registry (that is content the public map also benefits from, but do not change any public rendering).
- Ask (P5-41): extend `kbSearch` with one chunk per public layer from the server's copy of the registry text (`prompt/themes.ts` / `systemPrompt.ts` already carry it) — read-only use of the P5-41 modules, additive.


### Implementation notes (2026-09-05)
- Client: `src/lib/publicLayers.ts` (grouping with plain-language category labels, search, `sourceLine`, `SOURCE_NOT_RECORDED`, `LAYER_DATA_SOURCES` mapping each layer id to the ONE `useMapData` loader that holds it — keyed per layer, not per category, because e.g. `homeownership_by_race` is an equity layer that rides in the housing CSV; `loadCountyRows`, `rowsToCsv`), `src/lib/countyLookup.ts` (lazy `/datasets/geographic/county-lookup.json`, 3,142 rows; misses fall back to the record's own county/state name, then the GEOID — Connecticut planning regions and the territories), `LayersIndexView.vue` (public groups + internal section from the manifest when logged in), `LayerAboutView.vue` (fact cards: type + unit, direction, range via the layer's own `formatValue`, source; Show on map; AskBox prefilled "What does the … layer measure and where does it come from?"; `/layers/internal-<slug>` redirects to `/library/<slug>` from inside the view), `CountyTable.vue` (search, sort with blanks sinking, paging, CSV of the searched/sorted rows). KbNav "Map layers"; ⌘K rows `layer · <Category>`; `App.vue` treats `/layers` as a knowledge-base route (title + nav highlight, internal only). `loadAllCountyData()` is never called (tested).
- Server: `scripts/export-layer-registry.mjs` (`npm run export:layers`, Node 22 type stripping imports the TS registry directly) writes `server/src/prompt/publicLayers.generated.json`; a client test asserts its ids equal the registry's, a server test asserts every entry has id/name/description and nothing internal. `kbSearch.ts` appends one `layer` chunk per public layer (`href: /layers/<id>`), counted as data in the "Read …" line. All 15 public layers already carried `source` + `year`; only the composite index lacks a `sourceUrl` (its methodology is on /about), so the registry is unchanged.
- Gates (agent run): client 345 pass, server 603 pass + 1 skipped, tsc + vue-tsc clean, build + bundle-leak green (32 files, 10 canaries; the two views are lazy chunks of 3.8 kB and 7.2 kB). Live-verified by the lead: see the P5-45 line in the commit.

---

## Step 8 — Research-intern track and the team-lead MCP track (Nick 2026-09-05)

Nick: "I like all the research intern ones. I'm less convinced on the team lead as I'm not sure he'll want to file all of his progress in app that way … I know he uses ChatGPT, so what about enabling an MCP so he can interact with all the data (both read/write in terms of adding more) within ChatGPT, pull map views in, etc?"

## P5-46 [FEATURE] Document text extraction ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-41, P5-44

### Why
Ask reads pages and manifests but not the documents themselves; PDFs and Word files are opaque. Extracting their text makes the whole collection searchable and citable by page, and gives the viewer a text fallback for formats a browser cannot render.

### Acceptance criteria
- [x] At reindex (and lazily on first read), extract text from `pdf` (per page), `docx`, `rtf`, `txt`, `md` for every document/incoming/dataset README file under a size cap; store the result as a derived object `library/derived/<slug>/<file>.txt.json` (`{ pages: [{ n, text }], chars, extractedAt, tool }`) so it survives restarts and is versioned like everything else; skip and record `{ error }` for encrypted/scanned PDFs (no OCR in v1).
- [x] Ask index (P5-41) chunks documents by page with `Title › p. N` source labels; sources deep-link to `/library/<slug>?tab=files&view=<file>#page=N` and the viewer opens the PDF at that page.
- [x] Viewer (P5-44): docx/rtf show the extracted text instead of "Preview isn't available"; a "Text" toggle on PDFs.
- [x] Explorer-style "Find in document" search box on the viewer.
- [x] Tests: extraction per format with fixtures, page chunking and labels, cap/skip behaviour, index coverage; live-verified on the strategic plan and the fact manual.


### Implementation notes (2026-09-05)
- `services/textExtract.ts`: pdf.js legacy build per page, `mammoth.extractRawText`, a scanning RTF stripper, TXT/MD/CSV passthrough; derived objects `library/derived/<slug>/<file>.txt.json` (`pages`, `chars`, `extractedAt`, `tool`, `sourceSize`, `sourceKey`, `truncated?`) or `{ error, extractedAt, sourceSize }` — a scanned PDF (zero characters) is recorded as an error naming OCR rather than as empty pages. Caps: `EXTRACT_MAX_BYTES` 20 MB, `EXTRACT_MAX_PAGES` 400, 20k chars/page, 1.5M chars/doc. `extractPending` sweeps after reindex (installed by the text route, not on import, so `library push` on a laptop never parses PDFs); `GET /api/library/text/:slug/:filename` extracts on demand with the same staleness rule (`sourceSize` mismatch re-extracts).
- Ask index: one chunk per PDF page labelled `Title › p. N` with `href …?tab=files&view=<file>#page=N`; single-page formats (docx/rtf/txt) get the file name and no anchor; `onExtracted(clearKbIndex)` so pages that land after a reindex enter the index. `askKb` needed no change (sources pass hrefs verbatim, pinned by a test). Sync CLI `listRemote` skips `library/derived/` for pull, status AND push (`push --delete` would otherwise delete every derived object as a stray).
- Viewer: docx/rtf are now viewable as text; PDFs get a Text/Original toggle; find-in-document with "3 of 12", Enter cycles with wrap; `#page=N` opens the PDF at the page and scrolls the text view to its separator.
- Tests: textExtract 24 (fixtures built at test time: a real 2-page PDF with an xref table, a hand-zipped .docx, RTF), libraryText 9, kbSearch +7, askKb +1, CLI +3, client documentView 21 + DocumentViewer 16. Server 724 pass + 1 skipped; client 556 pass; both type-checks clean.

---

## P5-47 [FEATURE] Fetch-and-suggest on drop ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-34, P5-46

### Why
A dropped link waits for a developer to run the fetch command. With the host guard in place the server can fetch on drop, extract, and propose the filing fields; the intern files their own research and the admin only approves.

### Acceptance criteria
- [x] `POST /api/library/links` queues a server-side fetch (same host guard, redirect and byte caps as the CLI; job runs in-process with a small queue, status on the entry: `fetching → fetched | failed`); the file lands in the entry folder exactly as the CLI would place it, with `lineage.from` and `contentType` recorded.
- [x] After fetch, extraction (P5-46) runs and an LLM pass (`LIBRARY_ASK_MODEL`) proposes `suggested: { title, category, tags, summary }` stored in the manifest, never applied automatically. The filing form (P5-11) shows the suggestion prefilled with an "Apply" button; Ask and search index the summary immediately.
- [x] Uploads get the same suggestion pass. Failed fetches show why on the entry ("site refused", "too large", "not a public address").
- [x] Tests: queue + status transitions, guard reuse, suggestion shape and non-application, form prefill; live-verified with a public PDF link.


### Implementation notes (2026-09-06)
- `services/linkFetchQueue.ts`: in-process FIFO, one job at a time, bounded at 50 (beyond that the drop succeeds and the entry says `later`), one retry on network/timeout only, never blocks the response; the guarded fetch was extracted from the CLI as `fetchToTemp` so the queue and `library fetch` share one implementation (same host guard, redirect cap, byte cap, `wx` temp file); manifest written bucket-first then the catalog row replaced, so the UI sees `fetch.status` without a reindex; audit `library.fetch`; plain-word reasons ("not a public address", "the site refused the request", "too large (limit …)", "took too long", "could not reach the site", "the link kept redirecting"). Sources are never fetched; an entry re-filed as a source mid-download stores nothing. `clearKbIndex()` after a fetched file and after a suggestion.
- `services/suggestFiling.ts`: extraction (P5-46) → first 6,000 characters → `LIBRARY_ASK_MODEL` (`LIBRARY_SUGGEST_MAX_TOKENS` default 400) → strict JSON parse; category must be in the guide's set ∪ the categories already in use (so a person-made category can be reused), title ≤ 160, summary ≤ 600, tags ≤ 6 lowercase kebab; stored ONLY as `meta.suggested` (never applied); budget reserved/settled against the dropping user's IP; `{ error: 'unavailable' }` when the model is unreachable. Uploads get the same pass. `POST /api/library/catalog/:slug/refetch` re-queues a failed fetch. kbSearch's entry chunk includes the suggested title and summary, so Ask and ⌘K see a drop's content before anyone files it.
- UI: entry fetch-status line ("Fetching the link…" / "Fetched <name> (<size>) · <ago>" / "Could not fetch: <reason> · Try again"), "Suggested by the assistant" panel with one **Apply suggestion** button that fills the filing form (still editable) and a "Based on the first pages of <file>" line; library cards carry "Fetching…" / "Fetched" / "Fetch failed" chips; the needs-attention "links with no file" row ignores fetches in progress. Under vitest with no injected fetch/suggester a queued job does nothing, so no suite touches the network.
- Live (dev API, real bucket): a USDA link was refused by the site → "Could not fetch: the site refused the request" on the entry and a "Fetch failed" chip; a govinfo.gov PDF fetched in 5 s (182 KB), was extracted, and a suggestion (title, category, six tags, summary) appeared at 10 s; Apply filled the form. Both probe entries and their derived text were purged from the bucket afterwards. Tests: linkFetchQueue 16, suggestFiling 15, links +8, upload +2, kbSearch +2, client +19. Server 963 pass + 1 skipped; client 709 pass; type-checks and build clean.

---

## P5-48 [FEATURE] Save an answer as a note; cross-dataset county join ✅ DONE

**Type:** Feature · **Size:** S–M · **Dependencies:** P5-41, P5-42

- [x] Ask page: "Save as note" creates a note (`kind: note`) with the question, answer, and sources as markdown links; "Add to page…" appends to a chosen wiki page.
- [x] Explorer: on any dataset with a `GEOID` (or lat/lng already geocoded) column, a "Add county context" control joins selected public layer values per row (client-side from `useMapData`), sortable and exportable like any column.
- [x] Tests for both; live-verified.


### Implementation notes (2026-09-05)
- No server changes: notes go through `POST /api/library/entries` (category `research`, tag `ask`; title from the question, ≤ 160 chars on a word boundary); "Add to page…" composes GET → append `## From Ask: <question>` (+ `**Sources**`) → PUT with `If-Unmodified-Since`, and a 412 shows "That page changed while you were reading it. Nothing was added yet." with Try again (re-GETs). Save is idempotent: the button disables and "open note" appears beside it; state resets per question.
- `src/lib/countyJoin.ts`: GEOID column detection (named candidates AND at least one row that parses; 4-digit FIPS zero-padded, `.0` stripped), public layers with a loader grouped as `/layers`, `?layers=` (≤ 6, not a table key so toggling costs no rows request), one loader per layer via the shared `loadCountyRows`, `—` for missing, client-side sort with blanks last, and a separate "Download this page with county context" CSV built in the browser (the server export is untouched). `CountyContextPicker.vue` with search and grouped checkboxes; joined columns appear in the table and the row drawer.
- Tests: countyJoin 38, picker 7, ask +10, AskView +9, DatasetView +12 (client 556 pass); type-check + build clean.

---

## P5-49 [FEATURE] Page editor upgrade ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-15, P5-41

- [x] Toolbar (headings, bold/italic, lists, link, table, embed picker for entries/views/layers), side-by-side preview on wide screens, autosave draft in localStorage (wiped at logout), "Insert citation" from a recent Ask answer, conflict notice when the page changed underneath (compare `updatedAt`).
- [x] Tests; live-verified.


### Implementation notes (2026-09-05)
- `src/lib/editor.ts`: pure markdown transforms over (text, selection) — heading cycle (plain → H2 → H3 → plain; a stray `# H1` demotes to H2, which changes the page title since the server derives it from the first `#`), bold/italic, bulleted/numbered lists, link, 3×2 table, embed fence, `citationMarkdown` (blockquote of the answer's first sentence with `[n]` stripped + `[title](href)` sources + a link back to `/ask?q=`), draft helpers (`blo:draft:<slug>`, storage-failure safe). `PageEditor.vue`: toolbar (`@mousedown.prevent` keeps the selection; every action re-focuses and restores it), ⌘/Ctrl B · I · K, side-by-side panes at ≥ 1100 px with proportional scroll sync (Write/Preview toggle only when narrow), 500 ms debounced autosave, "Draft restored — Discard". `EmbedPicker.vue`: debounced catalog search, `view:` vs `entry:` fences. Insert citation re-runs the recent question through Ask (localStorage keeps questions, not answers) so the quote reflects today's library.
- Conflict notice with the smallest server change: `GET /api/wiki/:slug` returns `updatedAt`; `PUT` honours `If-Unmodified-Since` and answers `412 { updatedAt, actor }` on a mismatch (actor from the audit log, best-effort) and returns the fresh baseline on success. Client `WikiConflictError` → "This page changed while you were editing (by …). Reload to see the latest, or save anyway." Reload keeps the draft.
- `.wiki-content` rules moved to an unscoped style block so the reading view and the preview pane share one definition. `blo:draft:` added to the logout wipe list.
- Tests: editor 30, PageEditor 21, EmbedPicker 8, WikiPageView 8 (new), wiki lib +5, server wiki +6. Client 414 pass, server wiki 26; both type-checks clean; build + leak green. Live: draft key created on typing, Bold wrapped the selection, embed picker searched the catalog, side-by-side panes at 1400 px.

---

## P5-50 [FEATURE] MCP server — read tools ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-41, P5-45

### Why
The team lead works in ChatGPT (and Nick in Claude). One MCP server on the API lets any assistant search the library, read pages and documents, query datasets, look up layers and counties, and hand back links to map views — without anyone filing progress "in the app". Read tools first: they are the value, and they are testable from Claude Desktop/Claude Code today with a personal token before the OAuth work needed for ChatGPT.

### Acceptance criteria
- [x] Streamable-HTTP MCP endpoint on the API (`/mcp`), bearer-token auth (personal tokens minted on the account page, hashed at rest like sessions, revocable, scoped `read`), per-user limiter, every call audited (`mcp.<tool>`, actor = user, `detail.client`).
- [x] Tools (thin wrappers over existing services, same validators): `search_library(query, kind?)`, `get_entry(slug)`, `read_page(slug)`, `read_document(slug, file, page?)` (P5-46 text), `query_dataset(slug, filters, groupBy?, limit)` (the P5-41 tool), `list_layers()`, `get_layer(id)`, `county_values(layerId, geoids[])`, `list_views()` / `get_view(slug)` → definition + deep link, `ask(question)` (server-side cited answer) — plus resources for pages and entries. Tool descriptions written for a model; results are data, never instructions.
- [x] Works from Claude Desktop and Claude Code (documented config); STAGING/DEPLOY notes.
- [x] Tests: token minting/revocation, auth failures, each tool against pg-mem + FakeS3, audit rows; live-verified from Claude Code.


### Implementation notes (2026-09-05)
- `routes/mcp.ts`: stateless Streamable-HTTP (`sessionIdGenerator: undefined`, JSON responses), a fresh `McpServer` per request, both closed on response close; `GET`/`DELETE /mcp` answer 405 (handing GET to the transport opened an SSE stream that never produced anything). `requireApiToken` sets `res.locals.internalUser` like the cookie guard, so `internalRateLimit` keys on the account. Every call audited `mcp.<tool>` with `detail.client` (User-Agent) and args clipped to 200 chars; failures flagged. `token.create`/`token.revoke` audited and absent from the activity feed.
- `services/apiTokens.ts` + `library_api_tokens` (sha256 at rest; `blo_` + 32 random bytes base64url shown once; `last_used_at` throttled to once a minute; admins may revoke anyone's, others get 404 for foreign ids). `POST/GET/DELETE /api/library/tokens` are cookie + CSRF only — a token can never mint a token. Account page: mint (secret shown once), list, revoke.
- `services/mcpTools.ts`: `search_library`, `get_entry`, `read_page`, `read_document` (text kinds; PDF/docx say "not yet available" until P5-46 is wired), `query_dataset` (the P5-41 tool), `list_layers`/`get_layer` (generated registry export), `county_values` (≤ 200 GEOIDs from `../public/datasets/<dataPath>` or `PUBLIC_SITE_URL`), `list_views`/`get_view` (+ deep link), `ask`; resources `library://page/<slug>`, `library://entry/<slug>`; `readOnlyHint` everywhere; errors are one sentence. Registry gained an optional `valueColumn` (four layers whose `dataKey` names the reshaped field, not the file column) and the export carries `dataPath` + `valueColumn`, guarded by a test against the real files.
- Docs: `docs/MCP.md` (mint, Claude Code `claude mcp add --transport http …`, Claude Desktop remote connector / `mcp-remote`, curl with `Accept: application/json, text/event-stream`, tool table, limits, troubleshooting, ChatGPT waits on P5-51). Env `PUBLIC_SITE_URL`.
- Tests: apiTokens 10, mcp 34 (auth, own-vs-admin revoke, every tool, audit, limiter key, county values from real files + fixtures + fetch fallback), client 27. Server 701 pass + 1 skipped. Live-verified on a private instance against the real bucket: tools/list, initialize, every tool, resources, 401/405/406, mint → list → revoke → 401.

---

## P5-51 [FEATURE] OAuth 2.1 for remote MCP clients (ChatGPT) ✅ DONE (security review applied — see notes)

**Type:** Feature · **Size:** M · **Dependencies:** P5-50 · **security-critical: gets its own audit before deploy**

- [x] Authorization-code + PKCE, dynamic client registration (RFC 7591), protected-resource and authorization-server metadata (RFC 9728 / 8414), the existing login page as the consent step ("ChatGPT wants to read your library / add notes"), scoped short-lived access tokens + rotating refresh tokens stored hashed, revocation from the account page, audit of grants.
- [x] ChatGPT custom connector (developer mode / workspace connector) documented end to end; Claude Desktop remote connector too.
- [x] Tests for every flow and failure; a `security-review` pass on the diff.


### Implementation notes (2026-09-05)
- `routes/oauth.ts` + `services/oauthStore.ts`: RFC 9728 protected-resource metadata (bare and `/mcp` path forms) and RFC 8414 server metadata (public, 1 h cache; issuer from `OAUTH_ISSUER` only, https except loopback); RFC 7591 registration for public clients only (≤ 5 redirect URIs, https or http-loopback, no fragments/userinfo, `token_endpoint_auth_method` must be `none`, 10/h/IP); authorize with exact redirect match, S256-only PKCE, RFC 8707 `resource` = the MCP URL, scope ⊆ supported ∩ registered, repeated parameters rejected, client/redirect failures render an error page (never a redirect), other errors redirect with `state`; logged-out users detour to `${PUBLIC_SITE_URL}/login?redirect=/account?oauth=<opaque id>` (fixed path — no caller URL crosses the detour) and the account page offers "Continue to <app> authorization"; the consent page is server-rendered with zero script, its own CSP (`default-src 'none'; frame-ancestors 'none'`) and `X-Frame-Options: DENY`, CSRF = HMAC(secret, session + pending id) compared constant-time, plus an Origin backstop; token endpoint (form or JSON, 60/min/IP): atomic single-use codes (`UPDATE … WHERE used_at IS NULL`), refresh rotation with family revocation on reuse, audits `oauth.grant/refresh/reuse/revoke/deny` with client name + scopes only; RFC 7009 revocation always 200; connected-apps API and UI (list, revoke; own tokens, per-user limiter); `/mcp` accepts personal and OAuth bearer tokens (audience checked) and answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`; `requireScope('read')` left as the P5-52 hook (`write` is grantable but 403 at `/mcp` until then). Tables `library_oauth_clients/pending/codes/tokens`, pruned at boot. `LoginView` `?redirect=` hardened to same-path-only.
- Self-review fixed two gaps before hand-off: parameter pollution (`?scope=read&scope=write` collapsed to the default) and an unlimited unauthenticated authorize endpoint that wrote pending rows (now 30/min/IP). Live walkthrough on a private instance covered register → 401 challenge → metadata → login detour → consent (wrong CSRF 403) → code → wrong verifier → tokens → tools → code replay (kills derived tokens) → refresh rotation → reuse kills the family → revoke → deny → unregistered redirect gets an HTML 400 with no Location → connected apps; zero token material in the server log.
- Deliberately not done: CORS was not widened for `/oauth/*` (ChatGPT and Claude call the token endpoint server-side; a browser-based client such as MCP Inspector on another origin would be refused — a separate decision).
- Tests: oauthStore 47, oauth route 69, client AccountView +9, apiTokens +13, LoginView 6 (new); auth sweep lists the nine new public routes deliberately. Server 862 pass + 1 skipped after the lead fixed the Ask route's `read` expectation for the new `sources` count; client 610 pass; type-checks and build clean.


### Security review (2026-09-05, independent Security Engineer pass; all findings applied in the hardening commit that follows)
- **Medium:** a disabled client's live access tokens kept working and nothing could disable a client (no writer of `disabled_at`) → bearer query excludes disabled clients; `disableClient` revokes every token of the client across users; CLI `oauth-clients list|disable`. Unauthenticated registration growth with per-IP keying an IPv6 /64 defeats → limiter keys bucket a /64; `pruneOAuth` also removes old token-less clients; the register audit row no longer stores full redirect URIs. Consent page gave the human nothing to judge a self-registered app by → shows the signed-in username, the redirect host on its own line, a warning that the app registered itself and when.
- **Low:** bidi/zero-width characters allowed in `client_name` (heading spoofing) → normalised and stripped; a stale code with a junk verifier could revoke a live family for seven days (replay branch ran before PKCE) → PKCE and expiry checked first; non-transactional claim → issue window on refresh/code paths → post-issue family re-check; registration default scope was the full set → `read`; redirect origin interpolated raw into the CSP `form-action` → charset-checked; pending rows pruned only at boot → 15-minute prune interval.
- **Info:** pending endpoint now also returns registration age; personal tokens avoid the `blo_at_`/`blo_rt_` namespace; RFC 9207 `iss` on redirects. Logout deliberately leaves OAuth grants alive (a standing delegation, not a browser session; disabling the account cuts them; Disconnect on the account page is the lever) — documented and locked by a test.
- Verified sound by the reviewer: PKCE (S256-only, constant-time), atomic single-use codes bound to client/redirect/challenge/scope/resource/user, exact redirect matching, no open redirect, parameter-pollution handling, RFC 8707 audience at every step, consent CSRF binding, clickjacking headers, fixed-path login detour, env-only issuer, 256-bit hashed token material with no token in logs or audit, refresh rotation with family revocation, RFC 7009 semantics, one bare 401 for every bearer failure.

---

## P5-52 [FEATURE] MCP write tools ✅ DONE

**Type:** Feature · **Size:** S–M · **Dependencies:** P5-51

- [x] `create_note`, `append_to_page` / `update_page` (size caps, slug rules, same audit as the UI), `drop_link(url, note)` (queues P5-47), `save_view(name, layers, weights, filters)` → link, `add_organization_note(row, text)` once row notes exist. `write` scope required; no delete tool; every write attributed "via <client>" in the activity feed.


### Implementation notes (2026-09-06)
- `services/mcpWriteTools.ts` — five tools, each a thin wrapper over the service the app's own form already calls: `create_note` (`createNoteEntry`, so the category default and therefore the status rule are the form's), `append_to_page` (read → `## <heading or "From <client>">` → write, with the route's If-Unmodified-Since meaning enforced on both the timestamp AND the body so two saves inside one clock tick cannot silently merge; one retry, which lands on the other person's text rather than over it), `update_page` (whole replace, stale `expectedUpdatedAt` refused, `create: true` to start a page), `drop_link` (the P5-47 path, `parseSourceMeta` for `isSource`), `save_view` (map state checked against the generated public registry **and** the live internal manifest; table state through the views route's own `parseTableState`). Caps: body/markdown 200,000 chars, titles/headings 160, 20 tags — declared in the zod shapes, so the SDK refuses before a handler runs. Both page tools refuse `home` without `allowHome: true` (the ticket asked for it on append; a whole-page replace of the front door is worse, so it is guarded too).
- Registration is the one loop in `routes/mcp.ts` over `[...MCP_TOOLS, ...MCP_WRITE_TOOLS]`: same audit wrapper, same error shaping, `readOnlyHint: !tool.write`, `destructiveHint: false` everywhere (nothing deletes), `idempotentHint` true only for `update_page`. The `write` gate cannot be middleware — one POST carries a call to any tool — so it lives in the wrapper and answers `insufficient_scope` as a tool error, audited with `refused`. The endpoint keeps `requireScope('read')`: a connection that cannot look at the library has no business writing to it.
- Attribution: `getBearerPrincipal` now always carries a `clientName` (an OAuth `client_name`, or a personal token's own name), so every write records `actor` plus `detail.via` on TWO rows — the entity's (`library.note`, `wiki.update`, `wiki.create`, `library.link`, `view.create`) and the call's (`mcp.<tool>`). `libraryActivity.viaLabel` folds it into the verb ("maria wrote the note via ChatGPT") with control/bidi characters stripped, so every feed surface prints it with no client change.
- Service extractions: link creation moved out of the route body into `services/libraryLinks.ts` (`createLinkEntry` + `parseLinkUrl`/`defaultLinkTitle`) so the tool and the drop form share one implementation; `routes/views.ts`'s `parseTableState` gained an `export` for the same reason. Notes needed nothing — `createNoteEntry` was already a service.
- Personal tokens can now hold `write`: the account page's mint form has an **Allow writes** checkbox (off by default, resets after a successful mint, keeps its state when the mint failed) with a plain warning about what it grants and that it cannot delete. `POST /api/library/tokens` reads `write: true`; absent still means read-only.
- Tests: mcpWriteTools 35 (every tool's happy path and refusals, the append race via a `setAppendRaceHook` seam, the schema caps, the feed line), mcp +10 (annotations, initialize instructions, read-only personal AND read-only OAuth tokens both getting `insufficient_scope`, both audit rows and their `via`, the feed, table-view validation reuse, home guard, stale baseline), client AccountView +3, apiTokens +1. Server 1121 pass + 1 skipped; both type-checks clean.
- Not done: `add_organization_note` — row notes still do not exist, so there is nothing to attach one to.

---

## P5-53 [STUB] Map views inside ChatGPT; place dossiers

Apps-SDK widget that renders a saved view inline (iframe of the app with a short-lived signed view token), and county/region dossier pages (every layer value, organizations there, mentions, notes, Ask with county context) with a shortlist comparison table. Define after P5-50–52.

---

## P5-54 [FEATURE] Saved charts and saved table views ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-42, P5-16 · **Nick 2026-09-05:** "Did you also ticket the extended data analysis features you mentioned for the researcher?"

### Why
Summaries and group-by tables vanish when the tab closes. A researcher needs to keep a chart or a filtered table, put it in a page next to the argument it supports, and come back to it after the data is refreshed.

### Acceptance criteria
- [x] **Charts from summaries:** any column summary or group-by result can be shown as a bar chart (top values), a histogram (numbers), or a count-over-time line (date columns, by month/year) — plain SVG, no charting library; readable on mobile; values labelled; a "Copy as image" that renders the SVG to PNG in the browser.
- [x] **Saved table views:** "Save this view" on the explorer stores the state (dataset, file, filters, search, sort, visible columns, optional summary column and chart type) as a saved view document alongside map views (`library/views/<slug>.json`, `type: 'table'`; map views keep `type: 'map'`). Saved table views appear on the entry's Data tab, on the landing tiles count, in ⌘K, and in Ask's index (name + description). Opening one re-runs the query against the current data — it is a recipe, not a snapshot — and says when the row count changed since it was saved.
- [x] **Embeds:** ` ```view:<slug> ` in a wiki page renders a table view as a compact table (first 20 rows) or its chart, with "Open in explorer"; the existing map-view embed is unchanged.
- [x] **Two-dataset views:** a saved view may name a public layer join (P5-48) so the chart can be, for example, organizations per state coloured by a layer value.
- [x] Tests: chart data shaping per type, save/restore round trip through URL state, embed rendering, stale-count notice; live-verified on Organizations (Tier bar chart saved and embedded in a page).


### Implementation notes (2026-09-06)
- `src/lib/charts.ts` + `SummaryChart.vue` (plain SVG, `viewBox` only, labelled marks, `role="img"` with a full text description, long labels clipped with a title): bars of a column's top values (≤ 12 with "showing N of M"), histogram from the summary's ten bins (single-bin case labelled), count-over-time from a new server `dates.byMonth` (dense months up to 36, whole years beyond, ≤ 120 buckets), "Copy as image" via a 2× canvas to the clipboard with a download fallback. `ColumnSummary` gained a Bars/Spread/Over-time toggle (the old inline histogram list was replaced, not duplicated); `GroupBySummary` shows the bars above its table.
- Saved table views: `library/views/<slug>.json` gains `type: 'map' | 'table'` (absent = map for old files) and, for tables, a `state` (dataset, file, q, filters, sort, columns, county-context `layers` ≤ 6, optional `summary` {column, chart} | {groupBy}, `savedRowCount`); validated on save with the rows route's own `parseRowsQuery` against the dataset's real columns (unknown column → 400); `savedViewMeta` exposes `type`, `dataset` and a one-line description ("Organizations · HQ State is Georgia · 13 rows"), which Ask and ⌘K pick up with no index change; `GET /api/views?dataset=` filters. Opening a table view re-runs the query from the URL (a recipe, not a snapshot) and the explorer banner says "Saved view: <name> · saved with 13 rows, now 15" when the count drifted or "you have changed the filters since". "Save this view" (inline name, no window.prompt) → "Saved — open" + a `view:<slug>` embed handle; "Saved views of this table" strip on the explorer.
- Embeds: ` ```view:<slug> ` renders a table view as a compact table (≤ 20 rows × 6 columns) or its saved chart (the real `SummaryChart` mounted per card and unmounted on the next hydration so the editor preview cannot leak), with the drift note and "Open in explorer"; map-view embeds unchanged. `/views/:slug` redirects table views into the explorer with the state and `?view=` carried through.
- Live: filtered Organizations → Save this view → "Saved — open" → strip lists it → `/views/<slug>` redirected into the explorer with the filter and the "Saved view: …" banner; the Tier summary renders an SVG bar chart ("Tier 2: 40, Tier 3: 32, Tier 1: 27, Unverified: 1") with Copy as image. The verification view was deleted from the bucket afterwards. Tests: charts 17, SummaryChart 9, ColumnSummary 7, GroupBySummary 4, DistributionBars 6, ViewRedirect 6, views lib +11, wikiEmbeds +9, DatasetView +11; server tabular +4, views route +22. Client 709 pass; both type-checks and build clean.

---

## P5-55 [FEATURE] County comparison table and shortlists ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-45, P5-54

### Why
The map scores places; a researcher (and the team lead) then needs the numbers for a handful of candidate counties side by side, across the layers that matter, in a table they can export, embed, and revisit.

### Acceptance criteria
- [x] `/compare?counties=<geoid,…>&layers=<id,…>` (internal): N counties × M layers, county names + state, each cell formatted per data type with the layer's direction cue (higher/lower is better), sortable by any column, min/max highlighted per layer, "Show on map" (deep link with the layers on and the map fitted to the counties), Download CSV, and Ask with the counties as context.
- [x] **Shortlists:** save a comparison as a saved view (`type: 'compare'`), name it, add notes per county, embed it in a page like any view; add counties from the map (county popup → "Add to shortlist"), from a layer's county table (P5-45), or by search.
- [x] Reuses the P5-45 county-name resolution and data loaders; loads only the layers requested.
- [x] Tests: URL state, cell formatting/direction cues, sort, CSV, save/embed; live-verified with three counties across four layers.


### Implementation notes (2026-09-06)
- `/compare?counties=&layers=` (`CompareView.vue`, `src/lib/compare.ts`): county picker (search via the county lookup, chips, ≤ 12), layer picker grouped like `/layers` (≤ 12), counties as rows × layers as columns, each cell through the layer's own `formatValue`, a direction cue per header, best/worst per layer marked with the title text "best of these", sortable with blanks sinking, Show on map, Download CSV, AskBox prefilled, skeleton and empty state. Only the requested layers load (public via `loadCountyRows`, internal county layers via the manifest), through dynamic imports so the public bundle is untouched.
- Shortlists: `blo:shortlist` (GEOIDs only, ≤ 12, wiped at logout) fed by "Add to shortlist" on `/layers/:id` county rows and in the county modal (both internal-only), a badge on the KbNav "Compare" link, offered on `/compare` as one click. "Save this comparison" → `POST /api/views` `type: 'compare'` with `{ counties, layers, notes }` validated server-side (5-digit GEOIDs, layer ids against the generated registry plus the internal manifest, notes ≤ 500 keyed by a listed county); `describeSavedView` → "3 counties × 4 layers"; `GET /api/views?type=compare`; `/views/<slug>` redirects into `/compare` with "Saved comparison: <name>" and the notes restored; embeds render the ≤ 12 × 12 table with a notes column and "Open comparison".
- `fit` implemented: `mapUrlForLayers(ids, focus, fit)` emits `?fit=<geoid,…>` and `applyMapDeepLink` fits the map to those counties through a reusable `fitToGeoIds` (the old `fitToTopN` became one line).
- Live: Shelby TN, Hinds MS, Fulton GA across Percent Black, Median home value, Life expectancy — three best/worst marks, direction cues in the headers, "Compare" in the nav, Show on map link carrying `layers` and `fit`. Tests: compare 40, CompareView 21, CountyModal 3, CountyTable +4, views lib +7, wikiEmbeds +8, ViewRedirect +2, mapDeepLinks +4, server views +11. Client 802 pass; both type-checks and build clean.

---

## P5-56 [FEATURE] Data source registry — index datasets we do not hold ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-34, P5-41 · **Nick 2026-09-05:** "part of the intention is we should be indexing datasets even if we're not necessarily replicating them (though we may eventually — think lazy evaluation). for questions like 'what datasets will tell me all environmental risks associated with x property i'm looking at?'"

### Why
Most of the data that matters for a land decision lives elsewhere: EPA, FEMA, USDA, USGS, state agencies. Copying all of it is neither possible nor useful. Knowing that a dataset exists, what it covers, at what geography, and how to ask it about a place is the value; holding a slice is a later, on-demand step (P5-57).

### The `source` kind
A manifest-only entry under `library/sources/<slug>/meta.json` (no files required; a sample or a data dictionary may sit beside it). Validated at reindex and by the content validator; every field optional except `title` and `source.provider`.

```json
{
  "title": "EPA Superfund National Priorities List (NPL) sites",
  "category": "environment",
  "status": "published",
  "tags": ["environmental-risk", "contamination", "superfund", "site-selection"],
  "description": "Every site on or proposed for the NPL with location, status and contaminants of concern.",
  "source": {
    "provider": "US EPA",
    "program": "Superfund / CERCLIS",
    "homepage": "https://www.epa.gov/superfund/search-superfund-sites-where-you-live",
    "geography": "point",
    "coverage": "national",
    "granularity": ["point", "county"],
    "topics": ["contamination", "hazardous waste"],
    "fields": [
      { "name": "SITE_NAME", "description": "Site name" },
      { "name": "NPL_STATUS", "description": "Proposed, final, deleted" },
      { "name": "LATITUDE", "description": "WGS84" }
    ],
    "access": [
      { "type": "arcgis", "url": "https://services.arcgis.com/.../FeatureServer/0", "docs": "https://…", "auth": "none", "notes": "query by envelope or county FIPS" },
      { "type": "download", "url": "https://…/npl.csv", "format": "csv" }
    ],
    "placeQuery": { "by": ["point", "county"], "radiusMiles": 5 },
    "license": "public domain",
    "updateCadence": "monthly",
    "lastChecked": "2026-09-05",
    "relevance": "Any NPL site within a few miles of a candidate parcel is a red flag for the campus; deleted sites still matter for history.",
    "replication": { "status": "indexed" }
  }
}
```
`replication.status` is `indexed` (metadata only), `partial` (slices cached by P5-57, listed under `slices`), or `replicated` (points at a dataset entry `slug`). `geography` ∈ point | parcel | tract | county | state | national; `access[].type` ∈ arcgis | socrata | rest | download | wfs | manual.

### Acceptance criteria
- [x] **Catalog:** `library/sources/` is a file-backed kind `source`; reindex validates the block (bad values dropped with a warning, entry still indexed), the catalog exposes `meta.source`, search matches provider/program/topics/fields, and the content validator (`npm run library -- validate` or the existing script) checks the schema before a push.
- [x] **Entry page:** a Source block on Overview — provider and program, what it covers (geography, coverage, granularity), topics, key fields (expandable), how to get it (each access method with its type badge and link, "no key needed" / "key needed"), license and cadence, why it matters, replication status (and links to slices or the replicated dataset). Actions: Ask about this source (prefilled), "Fetch for a place" appears only when P5-57 has an adapter for one of its access types. Cards in Data & documents carry a **Source** badge and the provider.
- [x] **Drop a link becomes a source:** the link-drop form and the filing form get "This is a data source" which reveals the structured fields (provider, geography, coverage, topics, access type/URL, license) — a non-technical teammate can register a dataset they found; the rest can be filled in later. Saved as `kind: source` with the block.
- [x] **Ask / search coverage:** each source contributes chunks for the block (title + description + provider/program + topics + geography/coverage + field names + relevance + access types) so "what datasets tell me about environmental risks for a property" retrieves the right sources; the system prompt tells the model that a source is a pointer, not held data, and to say how to query it for a place (`placeQuery`) when asked about a location. Sources are counted as "sources" in the "Read …" line. ⌘K shows them with a Source badge; `/layers` links to sources that back a public layer when a layer's `source` names one (optional).
- [x] **Seed content (research):** 25–35 sources relevant to a land decision, researched with real, checked endpoints: EPA EJScreen, FRS/ECHO facilities, Superfund NPL, Brownfields (ACRES), TRI, RCRA sites, UST/LUST (state examples), FEMA NFHL flood zones, FEMA National Risk Index, USDA SSURGO / Web Soil Survey, USGS NWIS water, EPA SDWIS drinking water, EPA NEI / AirNow, PFAS sites, MSHA mines, PHMSA pipelines, EIA power plants, LMOP landfills, USFS wildfire risk, NOAA sea-level/storm surge, USDA Census of Agriculture, county parcel data (Regrid, commercial — noted as such), NCCPI soil productivity, water rights (state), plus whatever backs the map's `contamination` layer. Each with `relevance` written for the initiative. Pushed to the bucket as `library/sources/<slug>/meta.json` with a wiki page `data-sources` that groups them by question ("Is this land contaminated?", "Will it flood?", "Can it grow food?", "Who owns it?").
- [x] Tests: kind + validation + warnings, catalog/search fields, entry Source block, drop-as-source form, Ask chunking and prompt line; live-verified: Ask "what datasets will tell me all environmental risks associated with a property I'm looking at?" returns the right sources with how-to-query hints.


### Implementation notes (2026-09-05)
- Code (agent): `services/sourceMeta.ts` (`parseSourceMeta` → cleaned block + `dropped` list; enums, caps, https-only, unknown keys dropped by name; one warning per entry), kind `source` in `FILE_BACKED_KINDS` after notes, `applySourceBlock` at reindex (a plain-string `source` on datasets is left alone), search text from provider/program/topics/field names; entry Source block (who · covers · topics · fields · how to get it with type badges and key-needed notes · terms · why it matters · notes · replication line) with "Ask about this source" and a placeholder "Fetch for a place" for adapter types; Source badges on cards and in ⌘K; `SourceFields.vue` shared by the drop-a-link and filing forms ("This is a data source"); `POST /api/library/links` and the filing `PATCH` accept a `source` block (a manifest-only link can be re-filed under `library/sources/`; entries with files stay documents, 409); `npm run validate:library -- --dir <path>`.
- Seed content (research agent, 40 sources + `wiki/data-sources.md` by question): every ArcGIS/WFS endpoint re-fetched live (22/22 returned a real layer name); 13 secondary access entries marked `unverified` rather than invented. Findings written into the entries: EPA EJScreen offline since Feb 2025 (archive + Harvard Dataverse mirror; ECHO carries a partial live substitute), NCED frozen Jan 2025, ATTAINS REST key-gated (ArcGIS open), PHMSA has no public API by policy, Georgia UST/water are spreadsheets only, Alabama ADEM runs a strong open ArcGIS server, South Carolina UST unusable programmatically (EPA UST Finder as fallback). The validator accepted all 40; the only warnings were a top-level `notes` key, which the schema now accepts and the Source block shows.
- Ask coverage (lead): `sourceBlockText` puts provider/program, coverage, topics, field names, access types, place query, license, cadence, relevance, notes and replication status into the entry chunk; sources count as "data sources" in the Read line; prompt rule 8 says a data source is a pointer, to list matches with how to query for a place, and never to claim results from one not run; MCP `search_library` accepts kind `source`. Then a retrieval fix: on "what data exists" questions (datasets, data sources, layers…) half the context budget is reserved for the best-matching source entries (≤ 12) before normal ranking — the "Data sources" page had outscored every entry and the first live answer named two of forty.
- Live, Nick's exact question — "what datasets will tell me all environmental risks associated with a property I'm looking at?" — answered in 8 s reading 7 data sources: EJScreen (with the offline caveat), Brownfields/Cleanups in My Community, Georgia EPD USTs (spreadsheet-only), PHMSA pipelines (viewer-only), EIA power plants, Superfund NPL, each with what it flags and how it is queried, and a closing line that these are pointers to fetch for the parcel, not held data. Gates: sourceMeta 16, libraryCatalog 10, links 12, catalog route 30, kbSearch 40, askPrompt +2, mcp 35; client 584 pass; tsc + vue-tsc clean.

---

## P5-57 [FEATURE] Lazy fetch for a place ✅ DONE

**Type:** Feature · **Size:** L · **Dependencies:** P5-56, P5-47

### Why
Once a source is indexed, the next question is always about a specific place. Fetching only the slice that question needs — the facilities within five miles, the flood zone at a point, the county's risk index row — and caching it is "lazy replication": the library grows exactly as fast as the questions do, and a slice that keeps mattering can be promoted to a real dataset.

### Acceptance criteria
- [x] **Adapters** (server, behind the host guard, per-source rate limits, timeouts, byte caps): `arcgis` (FeatureServer/MapServer query by envelope or point + distance, or by a FIPS field; paging; GeoJSON out), `socrata` (SoQL `within_circle` / field filters), `download` + filter (CSV/GeoJSON pulled once, cached, filtered by GEOID or bounding box), `rest` with a documented URL template (`{lat}`, `{lng}`, `{geoid}`). `manual` sources explain what to do by hand.
- [x] `POST /api/library/sources/:slug/fetch { point: {lat,lng} | geoid, radiusMiles? }` (internal, CSRF, limiter, audited `source.fetch`) → `{ rows, columns, count, truncated, fetchedAt, cacheKey }`; slices cached as derived objects `library/derived/sources/<slug>/<place-key>.json` (TTL from `updateCadence`), listed on the source entry under `slices`; `replication.status` moves to `partial`.
- [x] **UI:** "Fetch for a place" on the source entry (address → geocode via the existing Census path, or pick on a small map, or county picker) → slice table (reuse the explorer table component with in-memory rows), "Show on map" (temporary point layer from the slice), "Save as dataset" → an incoming dataset entry with the rows as CSV and `lineage: { from: source, place, fetchedAt }` — the full explorer and layer pipeline then apply.
- [x] **Ask + MCP:** tool `fetch_for_place({ source, point|geoid, radiusMiles })` available to Ask (P5-41 tool loop) and the MCP server (P5-50), so "any Superfund sites near 123 Main St?" runs the fetch and cites it; the address is geocoded first.
- [x] Tests: each adapter against recorded fixtures, cache TTL, place keys, promotion with lineage, tool validation; live-verified against two real sources.


### Implementation notes (2026-09-06)
- Adapters under `services/placeAdapters/`: `arcgis` (point + buffer preferred, FIPS filter otherwise; ≤ 5 pages × 1,000; GeoJSON or Esri JSON; a bare `/FeatureServer` gets layer `/0`), `socrata` (`within_circle` on `placeQuery.geoField` or a `fipsField` equality; `$limit` 5,000), `download` (full file cached once under `library/derived/sources/<slug>/full.<ext>` within the byte cap, re-pulled past the cadence TTL, filtered by GEOID column or bounding box then exact radius), `rest` (a `placeQuery.template` whose only substitutions are `{lat} {lng} {geoid} {radiusMiles} {bbox}`, each URL-encoded from numbers or 5-digit codes; a template without a placeholder is refused), `manual`/`wfs` → "this source is spreadsheets and phone calls only — open it by hand". Column names used in a WHERE clause must match a strict identifier pattern. Every request goes through the host guard per hop, `PLACE_FETCH_TIMEOUT_MS` (30 s), `PLACE_FETCH_MAX_BYTES` (25 MB), 30 requests/min/source.
- `services/placeFetch.ts`: address → Census onelineaddress, then Nominatim (the CLI's geocoder was extracted into `services/geocodePlace.ts` and the CLI keeps using it); `placeKey` = `g<geoid>` or `p<lat4>_<lng4>_r<miles>`; slices cached as `library/derived/sources/<slug>/<placeKey>.json` with a TTL from `updateCadence`; the source entry's `replication.slices` (newest first, ≤ 50) updated bucket-first and the row replaced, status → `partial`; audit `source.fetch`. `POST /api/library/sources/:slug/fetch`, `GET …/slices`, `POST …/promote` (an incoming dataset with the rows as CSV, `lineage: { from: 'source:<slug>', place, fetchedAt }`, status needs-review, P5-47 suggestion queued).
- Ask gained `fetch_for_place` (≤ 1 per question; count + first 20 rows + a deep link `/library/<slug>?place=<cacheKey>`; the source entry is cited). MCP: `registerPlaceTools` exposes `fetch_for_place` and `list_place_slices` with the usual audit wrapper; the lead wired it into the registration path.
- UI: the Source block's "Fetch for a place" opens `PlaceFetchPanel` — address, county picker, or the map centre when one is passed (hidden today: the library page holds no map centre); radius from `placeQuery`; sortable in-memory table; Download CSV; Save as dataset; slices with age and Open; `?place=<key>` opens a slice. "Show on map" for an ad-hoc slice is a follow-up (needs a temporary point source in Map.vue): the panel says "Map preview coming — save it as a dataset to draw it today".
- Opt-in live test (`PLACE_FETCH_LIVE=1`) passes against FEMA NFHL at an Atlanta point and EPA Superfund NPL from a geocoded street address (GEOID 13121, real sites). Nine new server test files and three client ones cover URL building and encoding, paging and byte caps, host-guard refusal, TTL and keys, promotion lineage, route auth/CSRF/limits, Ask validation, MCP registration, panel states.

---

## P5-58 [FEATURE] Place report ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-57, P5-53

- [x] `/place?lat=&lng=` or `/place/<geoid>`: runs every applicable source with an adapter (in parallel, bounded), shows each result as a section (found / nothing within range / could not check), the county's public layer values, organizations nearby, and a cited written summary from Ask ("Environmental risks for this property: …"); "Save as note" / "Add to page"; becomes the dossier surface for P5-53.


### Implementation notes (2026-09-06)
- `services/placeReport.ts` + `POST /api/library/place/report` (internal, CSRF, per-user limiter; `GET …/:placeKey` serves the cached report): the place is geocoded once; every `source` entry whose access has an implemented adapter and whose `placeQuery.by` fits the place runs through `fetchForPlace` with three workers and one deadline (`PLACE_REPORT_TIMEOUT_MS` 90 s; still-running sources become `timeout`), capped at `PLACE_REPORT_MAX_SOURCES` (25); manual/wfs sources and any source that turns out to have nothing queryable (spreadsheet-only downloads, a template with no placeholder) are `skipped` with the researcher's own instructions and a link — a finding, not a failure; real failures carry a plain-word reason. The county card reads the public registry through the same CSV reader as `county_values`; organizations come from whichever dataset has a point layer block (never a hard-coded slug), ≤ 10 within 50 miles; the summary is written by Ask with the sections, county values and organizations as numbered excerpts and the tool loop off. Reports cached 7 days at `library/derived/place/<placeKey>.json`; `refresh: true` re-runs everything; audited `place.report`.
- Client `/place?address=|lat=&lng=|geoid=` (`PlaceView.vue`, `src/lib/placeReport.ts`): form (address, county picker, radius, map centre when one is published), progress line, cited summary that anchors to the section cards, county card (values with direction cues, Compare, Show on map with `fit`), sections in the order found → none → skipped → failed, organizations, Save as note / Add to page (the Ask page's helpers, report rendered as markdown), Download CSV, Run again. Entry points: landing "Check a place", county modal "Place report" (internal only), `/compare` per-county "Report", a help recipe. MCP `place_report`.
- Live, "55 Trinity Ave SW, Atlanta, GA 30303", 5 miles, 31 s: 25 sources — 8 found (Superfund 1, UST Finder 1,018, NFHL flood zones 591, National Risk Index 2, wetlands 225, PAD-US 400, Opportunity Zones 24, watersheds 8), 2 none, hand-check sources listed with where to look, two genuine failures (NCED answered unreadably; SLOSH too large for a 5-mile radius), county card (Fulton, GA: index 2.87, Percent Black 44.0%, life expectancy 77.4), nearest organization 25.7 miles, and a cited summary covering contamination, tanks, flooding and the rest. Artifacts (slices, report, the ten manifests that had become `partial`) were purged and restored afterwards. The first run classified "nothing queryable" sources as failed; fixed by the lead with a test. Tests: placeReport 33, route 17, askKb +5, mcpPlaceTools +5, client placeReport 29 + PlaceView 19 + entry points.
- Not wired: "Use the map's centre" reads `sessionStorage['blo:map-centre']`, which nothing writes yet (a one-line `moveend` handler in Map.vue when wanted).

---

## P5-59 [FEATURE] Link inspection and ingest plan ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-47, P5-56, P5-57 · **Nick 2026-09-06:** "say the researcher finds a new dataset they link, and then we begin figuring out how to ingest it — either manually via me reviewing, downloading, cleaning and ingesting, or there's a clear API available"

### Why
Today a researcher can drop a link and, if they already know it is an ArcGIS layer or a Socrata dataset, register it as a source that Fetch-for-a-place and place reports use immediately. What is missing is the step in between: looking at an unknown URL and working out what it is, and recording the decision about how it will come in. That step is done by a developer today.

### Acceptance criteria
- [x] **Inspect on drop.** After a link is dropped (and on demand from the entry: "Inspect this link"), the server probes the URL through the host guard and classifies it: an ArcGIS Feature/Map service or layer (`…/FeatureServer[/N]`, `…/MapServer[/N]`, or a page whose `?f=json` answers with `fields`/`geometryType`/`extent`), a Socrata dataset (`/resource/xxxx-xxxx` or a dataset page with the 4-4 id; fields from `/api/views/<id>.json`), a direct file (`text/csv`, GeoJSON, zipped shapefile, XLSX by content type or extension), an ArcGIS Hub / data.gov / Socrata portal page (scrape the data links it lists), or a plain web page (nothing to ingest; extract text as a document). The result is stored on the entry as `inspection: { kind, confidence, fields, geometry, extent, rowCount?, formats, links[], checkedAt }` — data, never applied.
- [x] **Propose the source block.** For a recognised service, the entry offers "Register as a data source" with the block prefilled from the metadata: provider (from the service owner / the site), `access[]` with the exact layer URL and type, `fields` from the service, `geography` from the geometry type and extent, `placeQuery.by` inferred (`point` for point/polygon layers, `county` when a FIPS-like field exists, with `fipsField` set), `updateCadence` when the service reports it; the LLM suggestion (P5-47) fills title, topics, description and relevance. One click creates the source; nothing is guessed silently — every inferred value is marked "inferred" in the form until saved.
- [x] **Ingest plan.** Every incoming link and every source carries an explicit plan, chosen by an admin from the entry: `index` (pointer only), `fetch-on-demand` (adapter; the default when inspection finds a queryable endpoint), `replicate` (copy into the library: automatically for a direct file or an ArcGIS/Socrata/download source within caps, or manually — "Nick reviews, downloads, cleans, pushes"), or `document` (it is a report, not data). Stored as `ingest: { plan, owner?, note?, decidedBy, decidedAt }`; the entry shows the plan and what happens next in plain words.
- [x] **Admin "To ingest" queue** on the landing (admin-only, like Needs attention): links with no plan yet, plans of `replicate` not yet done, inspections that failed ("could not reach it — check the link"), sources whose adapter has been failing; each row deep-links to the entry with the inspection summary ("ArcGIS point layer, 12 fields, Georgia extent").
- [x] **Replicate now** for a direct file or a `download`/`arcgis`/`socrata` source: pulls the whole dataset within `REPLICATE_MAX_BYTES` / `REPLICATE_MAX_ROWS` (paged for ArcGIS/Socrata) into an incoming dataset entry with the rows as CSV (+ GeoJSON when there is geometry), `lineage: { from: 'source:<slug>' | url, fetchedAt, rows }`, status `needs-review`, the P5-47 suggestion queued, and the source's `replication` → `{ status: 'replicated', dataset: <slug> }`. Over the cap → the plan falls back to `fetch-on-demand` with a note. The manual path is unchanged: pull → clean → push with a `layer` block → Reindex, and the entry's plan flips to done when the dataset appears (matched by lineage).
- [x] **Ask + MCP:** `inspect_link({ url })` returns the classification and proposal (read-only; no entry created) so an assistant can answer "what is this link and can we use it?"; the drop_link tool accepts `plan`.
- [x] Tests: classifier per kind with recorded fixtures (ArcGIS `?f=json`, Socrata views API, CSV/GeoJSON headers, a Hub page), proposal mapping (fields, geometry → placeQuery, fipsField detection), plan transitions and the queue rules, Replicate now paging/caps/lineage/status, route auth, MCP tool, client entry panel and queue. Live-verified by dropping one unknown ArcGIS layer URL and one CSV link and walking both to a usable source/dataset without touching the CLI.


### Implementation notes (2026-09-06)
- `services/linkInspect.ts`: classifies a URL as `arcgis-layer` / `arcgis-service` / `socrata` / `file` / `portal` / `page` / `unreachable` through the host guard (`INSPECT_TIMEOUT_MS` 15 s, `INSPECT_MAX_BYTES` 2 MB — a probe reads metadata and the head of a file, never the data; a ranged GET, so an 800 MB file is described, not downloaded). ArcGIS `?f=json` (a service lists its layers; a state-plane extent that cannot be converted is re-asked as `returnExtentOnly&outSR=4326`; the organisation is read from `copyrightText`/`serviceDescription` when it is not boilerplate), Socrata `/api/views/<id>.json` (columns with sample values), content-type plus body sniffing (an ArcGIS Hub export answers 202 "ExportingData" on a cold cache → bounded retry; `application/octet-stream` GeoJSON is recognised by its bytes; a non-4326 `crs` is recorded and noted), Hub SPA pages fall back to `hub.arcgis.com/api/v3/datasets/<id>`, data.gov pages expose their typed resource links. Stored on the manifest as `inspection`, never applied. The P5-47 queue inspects BEFORE fetching: services and pages skip the download (`fetch.status: 'later'` with a plain reason) and are summarised from their metadata or page text; files proceed; text files over the extraction cap are summarised from their first 64 kB (`suggested.basis: 'head'`).
- `services/sourceProposal.ts`: a `SourceMeta` draft from the inspection — provider, program, exact layer/resource/file URL, fields, geography from geometry and extent, `placeQuery` (`point` for geometry layers; `county` with `fipsField` when a FIPS-like column exists, judged by sample values rather than names: 5 digits county, 11 tract, 12/15 block group, numeric columns allowed to have lost a leading zero, prefixed ids such as `1400000US…` refused), `fipsMatch: 'prefix'` and `fipsType: 'number'` when needed — the adapters then use `starts_with`/`LIKE` for text and numeric half-open ranges for numbers; every inferred value listed. Client "Register as a data source" prefills `SourceFields` with inferred chips that clear on edit; a `portal` inspection lists its data links with "Drop this link"; a service lists its layers the same way.
- `services/ingestPlan.ts`: `ingest` = `{ plan: index | fetch-on-demand | replicate | document, mode?: auto | manual, owner?, note?, decidedBy, decidedAt, done? }`; a default is proposed from the inspection, never set silently; admin-only `POST …/plan`; at reindex a manual replication flips to done when a dataset appears whose `lineage.from` matches (computed, not stored). Admin queue rows: links with no plan (links only — a source's plan is implicit), replications not done, failed inspections, sources whose last fetch failed (`source.lastError`), each an `?attention=` filter that returns exactly the rows counted.
- `services/replicate.ts` (admin `POST …/replicate`, queued): a file entry or an ArcGIS/Socrata/download source is pulled in full within `REPLICATE_MAX_BYTES` (100 MB) / `REPLICATE_MAX_ROWS` into `library/datasets/<slug>/` as CSV (+ GeoJSON when there is geometry) with `lineage`, a proposed point `layer` block (label = a name-like column, popups = human columns, ids and coordinates skipped; polygons get bounding-box-centre `longitude`/`latitude` and a `GEOID` copy when a FIPS column exists; Web Mercator is reprojected, other projections refused by name), the slug from the suggested title; ArcGIS pages on `resultOffset` until `exceededTransferLimit` is false; over the cap the plan falls back to fetch-on-demand with a note; the source's replication becomes `replicated`. MCP + Ask `inspect_link` (read-only, open-world); `drop_link` accepts a plan.
- **Live walk on seven unregistered datasets** (candidates and evidence in `/Users/mac/Desktop/BLO/library-staging/candidates/p5-59-candidates.md`): all seven classified correctly within 50 s of dropping. NC OneMap statewide parcels (ArcGIS point layer, 60 fields, 5.9 M rows) → registered from the proposal → 939 parcels within a mile of Warrenton NC in 2.6 s with owner, acreage, county code and value. USDA rural-urban continuum codes (CSV) → Replicate now → `rural-urban-continuum-codes-2023-by-county`, 9,703 rows with a FIPS column, county context available, plan flipped to done. Georgia conservation lands (Hub GeoJSON, EPSG:3857) → reprojected, 4,254 rows, `georgia-conservation-lands-2020` with a point layer labelled `name`. USGS government units (service) → 42 layers offered → the County layer dropped and inspected as polygons. CDC well-water index (Socrata, tract-level, numeric FIPS) → registered → a Fulton County query returned its 83 tracts. data.gov catalog page → four typed links → the 26 MB CSV dropped, fetched and summarised from its head. National Ag Law Center heirs' property page → "nothing to ingest", plan document. `inspect_link` worked through MCP and Ask ("what is this link and can we use it?"). Eight defects found by the walk were fixed in two rounds with tests (URL-derived slugs, tract FIPS as a county query, numeric FIPS samples, the queue counting seeded sources, raw HTML stored for pages, no coordinates or layer for polygons, no suggestion for files over the extraction cap, poor layer labels). All test entries, datasets and slices were purged from the bucket afterwards.
- Tests: 109 + 44 new server tests, 25 + 5 client; server 1398 pass + 6 skipped (serial run — the parallel run has a pre-existing cross-suite rate-limiter flake, one different limiter test per run, tracked below), client 912 pass; both type-checks, build + leak, Cypress green.
- Follow-ups: the parallel-worker limiter flake (reset limiter stores per suite); "Show on map" for an ad-hoc place slice and the map-centre seam (Map.vue); an ingest-plan filter in the Library list UI beyond the queue links.

---

## P5-60 [CHORE] Mobile pass across every internal surface ✅ DONE

**Type:** Chore · **Size:** M · **Dependencies:** P5-39 · **Nick 2026-09-06:** "lets do a mobile pass on everything"

### Audit (375 × 812, logged in, every internal route, 2026-09-06)
Measured with a script: horizontal overflow of the page, elements wider than the viewport, tap targets under 36 px, text under 13 px, tables and their scroll wrappers, fixed elements. Screenshots in the session scratchpad.
- **Header overflows on every page by 210–231 px**: title wraps to three lines and the internal additions (Knowledge base link, Search, Help, username) run off the right edge; the Search and Help buttons are 30 × 28 px, nav links 43 × 29 px. The logged-out header is unaffected and must stay byte-identical.
- **Explorer**: the page itself scrolls sideways by 4,797 px — the table (5,150 px) is in a scroll wrapper that does not clip; the toolbar row (file chip · counts · Show on map) overflows; sort/menu buttons ~19 px tall; the row drawer has no phone layout (open item from P5-30).
- **Compare**: page overflows by 403 px (table 736 px, wrapper not clipping); the heading is cut off; remove-county buttons 17 × 19 px; checkboxes 13 px; 46 text elements under 13 px.
- **Library list**: title and the three action buttons squeeze into three-line pills; the drop-zone sentence and the search + kind-filter row overflow; 415 text elements under 13 px (card meta).
- **Landing**: 31 tiny text elements; quick links 21 px tall; otherwise stacks correctly.
- **Layers index / layer about**: 63 / 54 tiny text elements; county-table sort buttons 19 px; the table scrolls in its wrapper (correct).
- **Source entry, ingest panel, fetch-for-a-place panel, help drawer, ⌘K palette, editor toolbar, document viewer, ask page, account**: not measured beyond the shared header problem; each to be checked and fixed by the owning agent (⌘K has no keyboard on a phone — the Search button is the entry; the editor's side-by-side preview is already desktop-only).
- **Map with an internal layer**: the chat panel, lens and county rail stack over the map so no map is visible. These are public-map components (pre-existing behaviour); out of scope for this pass under the pixel-identical rule — flagged for a separate decision. The internal entity rail already becomes a bottom sheet.

### Acceptance criteria
- [x] **Header (internal only).** Under 640 px, when logged in, the header becomes one line: logo, short title, then a compact toolbar of 44 px icon buttons — Search, Help, and a Menu that opens a sheet with Map · About · Knowledge base · Compare · Account/Log out. The logged-out header's markup and styles are unchanged (a test snapshots the logged-out header HTML at 375 px and asserts equality before/after; the bundle-leak gate stays green).
- [x] **No page-level horizontal scroll** on any internal route at 375 px: tables scroll inside their own container (`overflow-x: auto`, `max-width: 100%`, `min-width: 0` on flex children), long headings wrap, toolbars wrap or scroll as strips. A vitest helper + a Cypress mobile smoke check (`cy.viewport(375, 812)`) assert `document.documentElement.scrollWidth <= innerWidth` on the landing and the library list (the only routes Cypress can reach logged out are the login redirects; so the check runs against the public map logged out — header unchanged — and the internal checks live in vitest with jsdom widths where feasible; the lead verifies the rest live).
- [x] **Tap targets ≥ 44 px** for every button, link-as-button, tab, chip action and checkbox on internal surfaces (native checkboxes scaled to 20 px with a 44 px hit area via the label); table sort controls become full-height header cells; remove/close controls 44 px.
- [x] **Text ≥ 14 px** for body and meta on internal surfaces at phone width (13 px allowed only for badges); headings scale with `clamp()`.
- [x] **Sheets and panels**: the help drawer, ⌘K palette, embed picker, citation picker, county-context picker, save-view forms, the fetch-for-a-place panel, the summaries panel and the row drawer become full-width bottom sheets (or full-screen for the palette) under 640 px with a visible close control and body scroll locked behind them.
- [x] **Explorer on a phone**: toolbar as a two-row layout (counts line, then actions as a horizontal strip), the table scrolls inside with the first column sticky, the row drawer as a bottom sheet with a "Show on map" / "Open record" row, summaries under the table.
- [x] **Compare on a phone**: pickers stack, chips wrap, the table scrolls inside with the county column sticky and layer headers abbreviated with full names in a title, save form full-width.
- [x] **Forms**: inputs full-width with 44 px height, selects likewise, the drop-a-link and source fields stack, the filing form stacks, the login form is already fine.
- [x] **Viewer**: the PDF frame uses `height: 70svh` on phones; text view padding reduced; find box full-width.
- [x] Tests: header collapse (logged-in only) + logged-out snapshot equality, tap-target and text-size assertions on the key components (computed styles in jsdom are limited, so assert the CSS classes/attributes and the media-query rules exist), sheet open/close and scroll lock, explorer/compare wrappers. Live-verified by the lead at 375 and 768 on every route in the audit list.


### Implementation notes (2026-09-06)
- **Public map untouched, proven:** the logged-out header's outerHTML at 375 px was captured before any change (447 chars) and is asserted byte-for-byte by `src/__tests__/App.spec.ts`; the live hash matched after the pass. Internal mobile rules live in `src/components/InternalMobileStyles.vue` (unscoped `<style>`, rendered only when logged in, its CSS a separate lazy chunk; the header hook is a `data-internal-nav` attribute that is absent when logged out), so the public bundle carries none of them. The header's phone tools (Search, Help, Menu sheet) are one component, `InternalHeaderTools.vue`, so the `<!--v-if-->` placeholder count in `<nav>` did not change.
- **Root cause of every "page scrolls sideways" finding was the same:** each route root is a flex item of `<main>` whose automatic minimum width is its content's min-content width — the widest strip, table, or `white-space: nowrap` line inside it — so the page grew instead of the inner container scrolling. Four shapes of it were fixed: `min-width: 0; max-width: 100%` on every internal page container (a test now loops all eight and fails when a new view lacks the guard); `.strip` (horizontal scroll strips) with `min-width: 0; width: 100%; overflow-x: auto`; grid tracks `minmax(0, 1fr)` instead of bare `1fr` (pinned rows, the layer list, place cards); and stacked flex columns using `align-items: stretch` rather than `flex-start` (the explorer's table area shrink-wrapped to a 4,721 px table). The explorer also overflowed at 768 px, so its guard is unconditional.
- Shell: collapsed header under 640 px (one-line title, three 44 px icon buttons, a menu sheet with Map · About · Knowledge base · Compare · Account · Log out, focus trap, Esc, reference-counted body scroll lock in `src/lib/scrollLock.ts`), KbNav as a strip, landing tiles/actions/facts two-up, library title row and filters stacked with 16 px inputs (prevents iOS zoom), entry tabs as a strip with stacked Source rows and 44 px file rows, editor toolbar strip + segmented Write/Preview + pickers as bottom sheets, help drawer and ⌘K as sheets (the palette gains a close button; keyboard hints hidden under `hover: none`), Ask/Account/Login stacked with 44 px controls. Rendered markdown tables scroll in their own box.
- Data surfaces: explorer toolbar as counts line + action strip, sort controls fill the header cells, first column sticky, row drawer / save-view / county-context as sheets with "Show on map" and a new "Open record"; charts and bars readable at 360 px; layer index rows as cards, county table with sticky county column and 44 px controls; compare with abbreviated layer headers plus a legend, 44 px chips/checkbox rows, sticky county column; place report form/actions/cards stacked, section tables scroll inside; PlaceFetchPanel as a collapsible sheet; DocumentViewer PDF at 70svh with a full-width find box; EntityRail handle 44 px with safe-area padding. Shared `usePhoneLayout()` / `useBodyScrollLock()` composables and a test helper (`src/testing/sfcStyles.ts`) that asserts mobile CSS rules from the SFC source, since jsdom computes no layout.
- **Measured after the pass** (375 × 812 and 768 × 1024, thirteen routes): horizontal overflow 0 on every route at both widths; header buttons 44 × 44; remaining sub-40 px targets are inline text links in prose and the "browse" word inside the drop-zone sentence (deliberate). Cypress green (public map). Tests: 36 (shell) + 63 (data) new; client 1012 pass; build + leak green.
- Out of scope, flagged: the public map's chat panel, lens and county rail stacking over the map on a phone (public components); `viewport-fit=cover` for iPhone safe areas (would change the public page); `GlobalSearch` is still a static import (P5-38), so its inert phone rules ship in the public CSS.

---

## P5-61 [FEATURE] Read any page for data ✅ DONE (live check with the lead outstanding)

**Type:** Feature · **Size:** M · **Dependencies:** P5-59 · **Nick 2026-09-06:** "1 is a fine idea as long as something like a 2 / an llm pass can prune before we save any of those links. otherwise we end up spamming a link tree instead of actually extracting the valuable data query urls. i like 2 and 3, 4 is interesting but a can of worms"

### Why
Inspection (P5-59) reads endpoints that describe themselves and files that serve bytes. The page a researcher actually finds is usually prose with a download link or an API mention somewhere in it. This ticket makes that page yield its data endpoints — pruned, not dumped.

### Acceptance criteria
- [x] **Harvest, then prune, then store.** For any `page` (and for `portal` pages beyond the recognised ones) the inspector collects candidate links from the HTML: anchors whose URL shape or extension looks like data (csv/tsv/xlsx/zip/geojson/kml/kmz/shp/json, ArcGIS and Socrata shapes, `/api/`, `download`, `export`, `resource`), anchors whose text says Download / Export / API / Data / Dataset / GeoJSON / CSV, `<link rel="alternate">` to data types, schema.org `Dataset` JSON-LD `distribution[].contentUrl`, DCAT `data.json` at the site root when the page links to it, and the page's own `<title>`/`og:` data. Candidates are shallow-classified by shape only (no fetches). Then a **model pass** receives the page title, its first ~3,000 characters, and the candidate list (URL, anchor text, surrounding sentence) and returns the few that are the dataset's real data or query endpoints, each with a one-line reason and a role (`data-file`, `api`, `service-layer`, `docs`, `landing`), dropping navigation, share links, sibling datasets, and duplicates. Only that pruned list is stored as `inspection.links` (≤ 12) with the reasons; the raw candidate count is kept as a number. The entry offers "Drop this link" per kept link. With no API key the raw candidates are kept but capped at 6 and marked unranked.
- [x] **Read access options from prose.** The same model pass (or the existing suggestion pass on `page` kinds) extracts, into the source proposal, what the text says: provider and program, update cadence, license or terms, coverage and geography in words, and the access methods described (an API with docs, a bulk download, a viewer, "request by email") — each marked inferred with the sentence it came from; the proposal's `access[]` includes only entries with a URL, the rest go into `notes`. A page that turns out to describe a dataset gets `suggestedPlan: index` and a ready "Register as a data source" instead of "nothing to ingest".
- [x] **CKAN portals.** Pages on a CKAN site (data.gov and state portals; detected by `/dataset/<slug>` plus the CKAN API answering `/api/3/action/package_show?id=<slug>`) are read through the API: title, notes, organization, license, `resources[]` with format and URL, tags; resources become the pruned links directly (no model pass needed) and the source proposal comes from the package metadata. Replaces the HTML scrape for data.gov.
- [x] Guards unchanged: every probe through the host guard with the inspect timeout and byte cap; the model pass is budget-metered like the suggestion pass; nothing is registered or dropped without a person.
- [x] Out of scope, by decision: table extraction from PDFs and OCR.
- [x] Tests (Live-verified on three real agency pages still to be done by the lead — the URLs are in the notes below): harvesting from fixture pages (an agency prose page with one CSV link among 40 navigation links; a page with JSON-LD; a Hub-style SPA; a CKAN dataset page + API fixture), the model pass with a fake client (prunes to the data links, keeps reasons, respects the cap), no-key fallback, proposal from prose (cadence/license/access marked inferred), CKAN path end to end. Live-verified on three real agency pages that are not portals.

---

### Implementation notes (2026-09-06)

- `services/linkHarvest.ts` (pure, no requests): candidates off HTML already in hand — anchors by URL shape (`csv|tsv|xlsx|xls|zip|geojson|json|kml|kmz|shp|gdb|parquet`, `/FeatureServer|/MapServer`, a Socrata 4-4 id, `/api/`, `/download`, `/export`, `/resource/`) and by anchor text (`Download|Export|API|Data|Dataset|GeoJSON|CSV|Shapefile|Bulk`), `<link rel=alternate>` to a data type (RSS/Atom excluded — an `xml` alternate is a news feed nine times in ten), schema.org `Dataset` `distribution[].contentUrl`, `citation_pdf_url`-style meta, and the site's `/data.json`. Resolved against the FINAL url, https only (an http link is dropped, never upgraded), fragments stripped, de-duplicated, capped at 80 — but `total` counts every distinct candidate, because "44 other links were left out" has to be true of the page. Each keeps its anchor text and the surrounding sentence (≤ 200 chars, cut at sentence boundaries) and a shape-only `kind` from `classifyByShape`.
- `services/linkPrune.ts`: one metered call, two outputs. The model gets the page title, its first 3,000 characters and the NUMBERED candidates (url · link text · looks like · nearby text) and answers `{isDataset, links:[{index, role, reason}], provider, program, updateCadence, license, coverage, geography, accessNotes:[{kind,text,url?}], evidence:{field: sentence}}`. **A stored URL is always one we harvested**: a kept link is named by its index, a `url` in the answer is ignored, and an access note's url survives only if it equals a candidate we collected. Roles are the enum, reasons are trimmed at 200 chars, an unknown role or a missing reason drops that entry alone, one entry per index, cap 12. An answer that keeps nothing IS an answer (`pruned: 'model'`, empty links) — falling back there would undo the pass. No key / model error / unparseable → `unrankedLinks`: first 6 by static priority `service-layer > data-file > api > docs > landing`, then page order, `pruned: 'unranked'`, reason "Picked by the shape of its URL — nobody read the page."
- `services/assistantCall.ts` (new, shared): the ~40 lines P5-47's suggestion and P5-61's prune were both about to carry — lazy client, `hasApiKey`, `textOf`, `jsonObjectIn`, and `callAssistant` (estimate → `reserveUsage` → one `messages.create` → `settleReservation` with the real usage, or 0 on failure; a failure is always `null`, never a throw). `suggestFiling.ts` now uses it and re-exports `jsonObjectIn`; its 18 tests are unchanged.
- `linkInspect.ts` wiring: in the HTML branch, CKAN first, then the Hub SPA fallback, then harvest+prune. The pruned answer REPLACES `readPage`'s raw anchor list, including when it keeps nothing. A publisher's own typed `distribution[]` skips the pass entirely (`typedLinks`). Under a test runner an un-injected prune does not run at all (`pruner()`, the same rule as the queue's `seamMissing`), so no suite can reach Anthropic. Stored: `links[] {url,label,kind,role,reason}` (≤ 12), `candidates: number`, `pruned: 'model'|'unranked'`, `prose: {…, accessNotes[], evidence{}, isDataset}`, plus `platform` and `topics` for CKAN. `parseInspection` re-validates every one of them; `inspectionSummary` stops saying "nothing to ingest" for a page that yielded links; `inspectionText` hands the filing model the links with their roles and reasons and what the prose said.
- **CKAN** (`ckanSlugIn` + `inspectCkan`): `/dataset/<slug>` (CKAN's own reserved names excluded) confirmed by one guarded `GET /api/3/action/package_show?id=<slug>`; `success !== true` or a body that will not parse falls straight back to the HTML scrape. Resources become the kept links directly with a role from the declared format (ArcGIS shape wins first, then the format — a Socrata `rows.csv?accessType=DOWNLOAD` is a FILE on a Socrata host, and calling it an API would send the wrong adapter at it), a reason from the resource description, http resources refused. Provider = `organization.title`, licence = `license_title`, cadence from `extras[]`, topics from `tags[]`, description from `notes`. No `candidates`/`pruned` are written: nothing was harvested and nothing was thrown away. The ticket's "provider: 'ckan'" is stored as `inspection.platform = 'ckan'`, because the same criterion also says `provider` comes from the package's organization and the two cannot be the same field.
- `sourceProposal.ts`: prose FILLS GAPS, never overrides a service's own words (`inspection.provider || prose.provider || hostOf(url)`, and the same for cadence, licence, coverage). Every field taken from prose is marked inferred AND its sentence is copied into the new `proposal.evidence` (a declared value gets no evidence — the endpoint is the evidence). `prose.geography` is mapped onto the schema's enum by `geographyInWords` and goes to `notes` when it maps to nothing, so the enum is never filled with a phrase nobody can filter on. Access: an access note whose url is a KEPT link becomes an `access[]` entry (`viewer`/`request` → `manual`); everything else goes to `notes`; a page or CKAN record with no single endpoint gets `access[]` from its kept links (`data-file` → `download` whatever the host, ArcGIS → `arcgis`, Socrata → `socrata`, `api`/`service-layer` → `rest`, and the first `docs` link becomes `docs` on the first entry).
- `ingestPlan.ts`: `describesDataset` = the model's `isDataset` AND at least one kept link or access note. A `page` that passes gets `{plan: 'index'}` ("keep the pointer and register the source") instead of `document`; the client's `canRegisterAsSource` uses the same pair of signals, so "Register as a data source" and the suggested plan can never disagree.
- Queue: `runInspection` passes `clientIp`, so a prune's tokens are billed to whoever dropped the link; a page whose links were kept says so in its `fetch.reason`. MCP `inspect_link` is additive only (`candidates`, `pruned`, `readFromThePage`, `evidence`; `links[]` gained `role`/`reason`); Ask's `inspect_link` prints the roles, reasons, the left-out count and the access notes.
- Client: `IngestPanel` shows each kept link with a role badge (file · API · map layer · docs · page), the reason on `title=` and behind a "Why?" toggle, "Drop this link" unchanged, "N other links on the page were left out" from `candidates − links.length`, and an explicit "Nobody read the page — these were picked by the shape of their addresses" when `pruned === 'unranked'`.
- **Tests**: server +61 (`linkHarvest` 12, `linkPrune` 18, `linkInspect` +9 incl. CKAN end-to-end and the HTML fallback, `sourceProposal` +8, `linkFetchQueue` +1 real-inspector wiring test, plus the P5-59 data.gov test rewritten as the fallback) → **1446 pass, 8 skipped**; client +14 (`IngestPanel` +9, `libraryCatalog` +5) → **1026 pass**. Both type-checks, `npm run build` and the bundle-leak check green. New fixtures: `AGENCY_PROSE_PAGE` (one CSV among 40 nav links), `JSONLD_DATASET_PAGE`, `ALTERNATE_PAGE` (rel=alternate + a relative url + an http url), `CKAN_PACKAGE`, `CKAN_MISS`.
- **Live (opt-in, `INSPECT_LIVE=1`)**: `linkInspect.live.test.ts` now covers three real agency pages, none of them a portal — all 5 live tests pass. The model pass is deliberately not exercised there (an un-injected prune does not run under vitest), so what it asserts is reachable + classified `page` + harvested. Verified 2026-09-06:
  - `https://www.ers.usda.gov/data-products/rural-urban-continuum-codes` — 11 candidates, the five real code files (2023 xlsx/csv, 2013 xls, 2003 xls ×2) at the top.
  - `https://www.epa.gov/frs/geospatial-data-download-service` — 18 candidates, four real downloads (`national_frs.kmz`, `FRS_Interests_Download.zip`, `EPAXMLDownload.zip`, `acres_frs.kmz`).
  - `https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html` — 11 candidates; the shape-only fallback ranks the technical notes first here, which is exactly the case the model pass is for and the clearest one to check live.
### Round two — four defects from the lead's live check (2026-09-06)

1. **A silent fallback (EPA FRS page).** `unranked` on a server with a key configured and nothing in the log. Two paths reached the static fallback without saying a word: `jsonObjectIn` returning null, and `!hasApiKey()`. (A thrown SDK error always logged, which is how the cause was narrowed.) Fixed at the root and at the symptom: `callAssistant` now returns `{error}` with a classified reason instead of `null` and surfaces `stop_reason`; **every** fallback path in `pruneLinks` logs one line `[link-prune] <slug>: <reason>` and records `inspection.pruneError`, which the entry shows. The queue and the inspect route pass the entry slug as that label. Leading cause: a truncated answer — the EPA page harvests **18 candidates into a 10,042-character prompt**, and a full answer at this module's own caps (12 links × 200-char reasons + 6 prose fields + 6 access notes + 6 quoted evidence sentences) is ~2,000 output tokens against a 1,500 cap, so the JSON never closed. `LIBRARY_PRUNE_MAX_TOKENS` default 1,500 → **3,000**, a `max_tokens` stop is named separately from "not JSON", and a live opt-in test asserts the worst-case answer fits the cap. Also made the parser tolerant of the two shapes it was refusing: a single-key wrapper (`{"result": {…}}`) and a bare array of link entries. *(I could not run the model myself — no key in this environment — so the cap is confirmed by arithmetic against the real prompt, not by observation; the live prune test `INSPECT_LIVE=1 PRUNE_LIVE=1` is there for you to confirm it.)*
2. **Census TIGER kept only a landing page.** The candidates were never harvested: the only route to the shapefiles is one anchor reading **"FTP Archive"** pointing at the protocol-relative `//www2.census.gov/geo/tiger/TIGER2025/` — no data extension, no data word. Added a `directory` harvest source (text `ftp|archive|file transfer|web interface|directory|browse|index of|file listing|all files`, or a path ending in a data folder) and a new **`directory` role**, ranked just below `data-file`, told to the model explicitly ("a directory, an FTP archive or a browse-the-files index IS a data endpoint… if the only route to the actual data is a listing of files, keep it"), labelled "folder of files" in the UI, and mapped to `access.type: 'manual'` so no adapter is ever pointed at an HTML index. Live re-check: the page now yields 13 candidates with the FTP archive and the shapefile web interface as the top two, **even with no model**.
3. **data.gov links had no role (`[?]`).** Cause: data.gov pages carry schema.org `Dataset` JSON-LD, so `typedLinks` short-circuits the prune and the distributions were stored with a `kind` and nothing else. New `roleForLink(format, url)` types every un-pruned link — schema.org distributions, portal anchors, Hub exports, CKAN resources — from its declared format and URL shape (media types included, `/d/<4-4>` and `/about_data` → `landing`), with a reason saying where it came from.
4. **data.gov `package_show` 404s.** Confirmed live: `?id=state-normed-well-water-index-wwi` answers 404 for a page that renders fine. `ckanPackage` now tries `package_search?fq=name:<slug>&rows=1` behind it and accepts the first result **only when its `name` equals the slug** (a loose `fq` hit is not this page), with the HTML scrape behind that.

Also added: `inspection.dropped` — up to 20 URLs the pass rejected, stored so the next reviewer can audit it, shown behind a "Show them" toggle rather than by default. Static role order fixed so a file extension beats the `/api/` around it (`…/api/v3/views/<id>/export.csv` is a file, `/resource/<4-4>.json` is still an API).

Round-two tests: server +24 (prune 14, harvest 4, inspect 6) → **1470 pass, 14 skipped**; client +5 → **1031 pass**. Both type-checks, build and the leak check green.

- **Not done, deliberately**: PDF table extraction and OCR (out of scope by Nick's decision); no new fetches of any harvested link (a candidate is classified by URL shape alone); no crawling of `/data.json` (it is offered as one candidate the model can drop).

## P5-62 [CHORE] Inspection eval set and the first prompt fixes ✅ DONE

**Type:** Chore · **Size:** S–M · **Dependencies:** P5-61 · **Nick 2026-09-06:** "how did the llm pass perform? did we informally eval it / test it?"

### What was actually checked (2026-09-06)
Four live pages, one run each, judged by eye against the kept and dropped lists stored on the entries — no labelled set, no repeat runs, no per-page cost tracking.
- **USDA rural-urban page:** 8 kept = exactly the eight code files, 4 dropped = navigation. Provider and program right; cadence sentence right; **coverage wrongly given the cadence sentence**; access notes duplicate the kept links.
- **EPA FRS download page:** 4 real downloads kept with good reasons; three API *documentation* pages kept as `api` (they are docs, not endpoints); the "download options" overview page dropped (arguably a `docs` keep); cadence "Weekly" right; **geography evidence is a dumped table row**, not a sentence.
- **Census TIGER page:** FTP archive kept as `directory` and the shapefile web interface kept (labelled `api`; it is a viewer/form), plus an irrelevant PUMA user-notes doc; 8 navigation links dropped correctly.
- **data.gov page:** CKAN/JSON-LD path, no model pass needed.
Net: link *selection* was good on all three prose pages (no clear misses, one or two irrelevant docs picks); *roles* confuse documentation with endpoints and viewers with APIs; *prose* fields are right on provider/program/cadence and weak on coverage and evidence.

### Acceptance criteria
- [x] **Prompt fixes from the above:** `docs` for pages that describe an API; `api` only for a machine endpoint; a `viewer` role (or map to `landing`) for query forms and web interfaces; coverage must not repeat the cadence sentence; evidence must be a sentence, never a table cell dump (drop evidence shorter than a clause or lacking a verb); access notes that duplicate a kept link are folded into that link's reason. Fixture tests for each.
- [x] **Eval set:** 12–15 real pages saved as fixtures (HTML captured once, with the capture date) across the shapes that matter — agency prose pages, a CKAN page, a Hub SPA, a Socrata page, a directory-only page, a page with JSON-LD, two pages that are NOT datasets — each with a hand-written label file: links to keep with their role, links that must be dropped, expected provider/program/cadence/license/geography, `isDataset`.
- [x] **Scorer:** `npm run eval:inspect` (opt-in, needs the key) runs harvest + prune on every fixture N times (default 3) and prints per page: kept/missed/extra links, role accuracy, prose field exact/partial matches, run-to-run agreement, input/output tokens, latency; writes `server/eval/inspect/<date>.json` so a prompt change can be compared against the last run. A summary line states precision and recall for links and the mean agreement.
- [x] **Gate:** the scorer is not in CI (it costs money); instead a fixed "golden" answer per fixture, checked in, feeds an offline test that the validator and proposal mapping still produce the same stored shapes — so refactors are caught without a model call.
- [x] Live-verified: one full run recorded in the ticket with the numbers.

---

### Implementation notes (2026-09-07)

#### The run

14 pages x 3 runs against `claude-sonnet-5`, 2026-09-07 (`server/eval/inspect/results/2026-09-07T02-17.json`):

> **links: precision 85% recall 91% - roles 96% - isDataset 12.7/14 - agreement 0.92 - ~$0.0164 per page** (estimated from tokens at Sonnet 5's list price: 4,175 in / 800 out per page). 9.9 s per page; whole run about $0.69.
> prose 16.0 exact + 11.3 partial of 41 labelled fields. 3 fallbacks, all of them the ArcGIS Hub SPA, which yields no candidates and so is never sent.

| page | cand | kept | hit | miss | bad | neut | role | prose | ds | agree | in | out | s | $/page |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| arcgis-hub-counties | 0 | 0 | 0/0 | 0 | 0 | 0 | - | 0/0 | 0% | 1.00 | 0 | 0 | 0.0 | $0.0000 |
| census-tiger-directory | 56 | 10.7 | 6.7/8 | 1.3 | 0.7 | 3.3 | 100% | 2.3/3 | 100% | 0.60 | 11914 | 2265 | 23.3 | $0.0465 |
| census-tiger-line | 13 | 3 | 3/3 | 0 | 0 | 0 | 100% | 2/5 | 100% | 1.00 | 3626 | 1007 | 9.6 | $0.0173 |
| datagov-well-water | 8 | 4 | 4/4 | 0 | 0 | 0 | 83% | 3.3/4 | 100% | 1.00 | 3586 | 679 | 6.3 | $0.0140 |
| epa-frs-download | 17 | 5.7 | 4/6 | 2 | 1.7 | 0 | 100% | 3/5 | 100% | 0.89 | 4513 | 832 | 8.4 | $0.0173 |
| ers-county-level-data | 5 | 1 | 1/1 | 0 | 0 | 0 | 67% | 2.7/4 | 100% | 1.00 | 2625 | 752 | 8.3 | $0.0128 |
| ers-rural-classifications | 7 | 0 | 0/0 | 0 | 0 | 0 | - | 0/0 | 100% | 1.00 | 3437 | 119 | 2.4 | $0.0081 |
| farmers-heirs-property | 9 | 0 | 0/0 | 0 | 0 | 0 | - | 0/0 | 100% | 1.00 | 3608 | 16 | 1.3 | $0.0074 |
| noaa-ncei-c00946 | 11 | 6 | 6/6 | 0 | 0 | 0 | 100% | 4/5 | 100% | 1.00 | 3796 | 1111 | 9.8 | $0.0187 |
| socrata-cdc-wwi | 5 | 3 | 3/3 | 0 | 0 | 0 | 67% | 1.7/2 | 100% | 1.00 | 2885 | 164 | 2.2 | $0.0074 |
| usda-ers-rucc | 12 | 8 | 8/8 | 0 | 0 | 0 | 100% | 3.7/5 | 100% | 1.00 | 4458 | 784 | 6.4 | $0.0168 |
| usda-nass-quickstats | 16 | 3.3 | 2/2 | 0 | 1.3 | 0 | 100% | 2/3 | 100% | 0.67 | 4889 | 483 | 4.7 | $0.0146 |
| usgs-nhd-access | 23 | 11.7 | 10.3/12 | 1.7 | 0 | 1.3 | 100% | 2.7/5 | 100% | 0.76 | 5776 | 2512 | 49.8 | $0.0367 |
| usgs-press-release | 8 | 0 | 0/0 | 0 | 0 | 0 | - | 0/0 | 67% | 1.00 | 3330 | 481 | 5.5 | $0.0115 |

**Per-page misses that are still there** (`bad` = kept something the label calls a distractor):
- **census-tiger-directory** - misses `BG/` and `COUSUB/` (it keeps ~11 of the 50 sibling folders and does not always pick the same eleven; agreement 0.60, the lowest in the set), and keeps a column-sort link `?C=N;O=D` on some runs. Also the most expensive page in the set at 4.6c: 56 candidates is an 11,900-token prompt.
- **epa-frs-download** - misses the two `docs` keeps (`/frs/frs-api`, `/frs/frs-data-download-options`): after the round-two prompt tightening it now drops documentation rather than mislabelling it. Keeps `search-frs-data` and the EDG catalogue on some runs.
- **usgs-nhd-access** - misses one or two of the twelve wanted links per run, which is what happens when a page has exactly `KEPT_LINKS_MAX` wanted links and the pass has to rank.
- **usda-nass-quickstats** - keeps one or two NASS nav pages (`Data_Visualization`, `Data_and_Statistics`).
- **Roles**: the only steady disagreements are Socrata's `.../api/v3/views/<id>/query.json?accessType=DOWNLOAD`, which the model calls `api` and the label calls `data-file` (P5-61 decided these are files served by an API host), and the ERS county download page, called `data-file`/`landing` where the label says `directory`.
- **isDataset**: the ArcGIS Hub SPA scores 0% because it has no candidates, so no call is made and no answer exists - a scoring artefact of an empty page, not a wrong answer. The USGS press release is right on 2 runs of 3.

#### The prompt fixes (each with a fixture test)

1. **`api` only for a machine endpoint.** New `looksLikeMachineEndpoint(url)` (an `/api/` segment, `/rest/services/`, `/resource/<4-4>`, a FeatureServer, a `/v<n>/`, an `f=json`, a trailing format segment - EPA's Envirofacts `.../GA/JSON` taught us that one - or a data extension). `correctedRole` demotes an `api`/`service-layer` answer on anything else to `viewer` (if it is a form) or `docs`. Applied in `parseKeptLinks` AND in `linkInspect.roleForLink`, so a CKAN resource declaring `format: "API"` on a developer page gets the same treatment. Only those two roles are corrected: a wrong `data-file` fails loudly, a wrong `api` quietly stores a web page.
2. **New `viewer` role**, additive in the enum, ranked between `api` and `docs`. `looksLikeViewer(url, label)` reads the anchor's words ("Web interface", "query tool", "explorer") as well as the URL, because agencies name these in the link text. Maps to `access.type: 'manual'` beside `directory` in `sourceProposal.accessTypeFor`; labelled **"query form / viewer"** in `src/lib/libraryCatalog.ts`; added to `parseInspection` (via `LINK_ROLES`) and to `docs/MCP.md`'s role list.
3. **Coverage may not repeat the cadence sentence.** `dropRepeatedCoverage` drops a `coverage` identical to `updateCadence` or `geography` after folding whitespace, case and trailing punctuation - in `parseProse` and again in `cleanProse` on the way back off a manifest. The prompt now defines all four fields with an example each and says outright not to put the update sentence in coverage. **The USDA page that produced this defect no longer produces it.**
4. **Evidence has to be a sentence.** `isEvidenceSentence` refuses a quotation under 25 characters, one with no verb-like token (a curated list of the verbs agency pages use, plus lowercase `-ed`/`-ing`), or one that is a run of 3+ capitalised words with no sentence punctuation anywhere - a table row. The "no punctuation anywhere" half is what keeps "The Environmental Protection Agency publishes..." safe: a proper-noun run inside real prose is not a table row, and the full stop is what tells them apart. The field survives when its evidence does not; it simply reaches the reviewer unquoted rather than quoted wrongly.
5. **An access note that names a kept link is folded into that link's reason.** `foldAccessNotes` runs between `parseProse` and the result, appends the note's words to the link's reason (trimmed to the same 200-char cap, skipped if already contained) and drops the note. One claim, one place - the USDA page was storing the same sentence as a link reason, an access note and a second `access[]` entry.

#### The eval set

`server/eval/inspect/` - 14 pages captured 2026-09-06 through `guardedGet` with the inspect timeout and byte cap, each with a `<!-- BLO eval capture -->` header carrying the final URL, the date and the byte count, and a **hand-written** label (`keep` with roles, `drop` for the tempting distractors, `prose`, `isDataset`, notes). Three agency prose pages from the P5-61 live check (USDA ERS rural-urban, EPA FRS download, Census TIGER/Line), a data.gov CKAN/JSON-LD page, an ArcGIS Hub SPA, a Socrata page (CDC well-water index), the TIGER 2025 directory listing, a non-data.gov schema.org Dataset page (NOAA NCEI GSOM), three more agency prose pages (NASS Quick Stats, USGS hydrography, ERS county-level data), and three that are NOT datasets (a USGS press release, the farmers.gov heirs'-property explainer, an ERS programme overview).

**Skipped, all verified by hand on 2026-09-06 and recorded in `pages.json`:** `fema.gov/flood-maps/national-flood-hazard-layer` (403 to every automated client, browser user-agent included - this is why USGS hydrography stands in for it), `bls.gov/cew/downloadable-data-files.htm` (403), `huduser.gov/portal/datasets/usps_crosswalk.html` (202 with an empty body), `nrcs.usda.gov/.../gridded-soil-survey-geographic-gssurgo-database` (connection reset).

Labels also carry `keepUnharvested`: links a researcher wants that the harvester genuinely cannot see. Two, both found by labelling: NASS's own **Quick Stats** tool (an anchor reading only "Quick Stats" pointing at a bare subdomain - no data word, no data shape) and the TIGER **file-name-definitions PDF** (documents are deliberately not data candidates). `harvest.test.ts` asserts these are still missing, so the day one starts being harvested the test says to promote it.

#### The scorer and the gates

- `npm run eval:inspect -- [--runs 3] [--only <slug>] [--offline] [--write-golden]` (`server/eval/inspect/run.ts`). Harvests the saved HTML and prunes against the real model N times per page, scoring hits / missed / extras-bad / extras-neutral, role accuracy on hits, prose exact and partial (partial = substring either way, or 60% of the label's tokens), `isDataset`, run-to-run Jaccard, tokens and latency off the call metadata (a recording wrapper around the injected client - `pruneLinks` keeps its own return shape). Writes `results/<date>.json` and prints a delta against the previous one; a second run on the same day gets a `T<hh-mm>` suffix rather than overwriting the file the delta needs. Neutral extras count against precision on purpose: storing a link nobody asked for is the link-tree spam this pass exists to stop.
- **`--offline`** harvests only, needs no key and no money, and scores harvest recall: **100% (53/53 wanted links found among the candidates)**. The same check is a unit test - `eval/inspect/harvest.test.ts`, 30 tests - which also asserts every `drop` URL really is a candidate, so a typo in a label cannot quietly turn a bad extra into a neutral one.
- **Golden gate** - `golden/<slug>.json` holds one real answer verbatim **with the candidate list it answered about**, because the answer names links by index and a golden without them silently starts asserting about different URLs the first time the harvester changes (which is exactly what happened the day it was written). `eval/inspect/golden.test.ts` (41 tests) replays each through `unwrapAnswer` -> `parseKeptLinks` -> `parseProse` -> `foldAccessNotes` -> `proposeSource` and asserts the stored links, roles, reasons, prose, evidence and access-type mapping are unchanged. 13 goldens covering all six roles; the ArcGIS SPA has none because it produces no call. Verified it bites: breaking one validator turns 9 of the 41 red.
- Vitest now includes `eval/**/*.test.ts`; `tsconfig.eval.json` type-checks `eval/` (which the build's `rootDir: src` cannot see) without emitting.

#### What the eval itself found, and the second round

The first scored run came back **precision 69% / recall 92% / roles 95% / isDataset 10.7 of 14 / agreement 0.87**. Two things it showed that no amount of reading could:

1. **The pass keeps too much on a page with little to keep.** It kept USGS mega-menu items reading "All Data", the NOAA sample files the page itself calls examples, a re-sort link on a directory index, and it read a programme overview that merely NAMES datasets as a dataset. Four prompt lines (an empty answer is a good answer; "data" in the link text is not a reason; not a file the page calls a sample; not the same listing re-sorted) plus a sharper `isDataset` definition. **The harvester also now refuses a page's own address** - Socrata's "Skip to main content" anchor and EPA's own side-nav entry both resolved to the page being inspected, and the model kept them, reasonably, since nothing said "you are already here".
2. **The output cap was still too low.** Round two of P5-61 raised it 1,500 -> 3,000 by arithmetic; the re-run showed the USGS hydrography page (23 candidates, twelve wanted links) hitting 3,000 on **two runs of three**, falling back to the shape-only ranking, and losing a third of its recall. The arithmetic was wrong because it measured what we STORE - the model does not know about `REASON_MAX_CHARS` and writes what it likes; we trim afterwards. `LIBRARY_PRUNE_MAX_TOKENS` default **3,000 -> 6,000**. An output cap is not a spend: only tokens written are billed, and the median page uses ~800.

Round two moved it to **85% / 91% / 96% / 12.7 of 14 / 0.92** - precision +16 points and isDataset +2 pages against the first run, at 1.6c a page. The three runs are `results/2026-09-07.json` (round one and two, same file - the day's first name) and `results/2026-09-07T02-17.json` (final).

**Listed, not fixed:** the Socrata `query.json?accessType=DOWNLOAD` role disagreement (the model says `api`, the label says `data-file`; both are defensible and P5-61 chose the label's reading deliberately, because an adapter must not be pointed at it as a query API); the TIGER directory's 0.60 agreement, which is a page with fifty equally-good folders and a twelve-link cap rather than a defect; and the two `keepUnharvested` harvester gaps above.

> **Fixed in P5-63 (2026-09-07).** The TIGER agreement was a defect after all — see the numbers appended at the end of P5-63's notes. In short: a bare file index is now ranked in code rather than read, the label files gained hand-written `topic` and `tags`, and the scorer gained topic accuracy and tag precision/recall.

#### Tests

Server **1,566 pass, 14 skipped** (72 files), up from P5-61's 1,470: **+21** `linkPrune` fixture tests for the five prompt fixes, **+3** for the round-two prompt lines, **+1** `linkHarvest` (the self-link), **+30** `eval/inspect/harvest.test.ts`, **+41** `eval/inspect/golden.test.ts`. Client **1,031 pass** (the `libraryCatalog` role-label assertion gained `viewer`). `tsc --noEmit` clean on `tsconfig.json` and on the new `tsconfig.eval.json`; `npm run build` and `vue-tsc --build` green.

---

## P5-63 [FEATURE] One taxonomy built on the public layer categories ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-45, P5-56, P5-61 · **Nick 2026-09-07:** "we should be categorizing datasets / tagging them, we already do this on the public layers so we should be building on that"

### Today
Three vocabularies drift: the public map's `LayerCategory` (composite, demographic, economic, housing, equity, transportation, environment, health) with plain labels ("People", "Jobs and income", "Getting to work"); the library's free-word `category` (strategy, research, network, outreach, environment, land, water, hazards, agriculture, demographics, places, ideas) that mixes subject with purpose; and sources' `topics` plus free `tags` (`site-selection` on all 40, `environmental-risk`, `contamination`, `water`, `ownership`…). The filing suggestion picks from the library list, the layer pages from the registry, and nothing maps between them.

### Design
- **One module, one export.** `src/config/taxonomy.ts` is the source of truth (the client imports it; `npm run export:layers` also writes `server/src/prompt/taxonomy.generated.json`, with the same stale-check test on both sides as the layer export). It defines:
  - **Topics** — the subject spine, keyed so the public layer categories are members: `composite` (Overall index), `demographic` (People), `economic` (Jobs and income), `housing` (Housing), `equity` (Equity), `transportation` (Getting to work), `environment` (Environment), `health` (Health), plus the library's subjects `land` (Land: parcels, ownership, conservation, heirs' property), `water` (Water), `hazards` (Hazards: flood, fire, storm), `agriculture` (Agriculture and food), `places` (Places: gardens, green resources, sibling maps), `network` (Network: organizations, individuals). Each topic: id, label, one-line description, `layerCategory` when it is one, suggested tags.
  - **Purposes** — what a document or note is for, not what it is about: `strategy`, `research`, `outreach`, `ideas`. Stored in the same `category` field for backward compatibility; the taxonomy says which ids are topics and which are purposes.
  - **Tags** — kebab-case, an alias table (`flooding`→`flood`, `demographics`→`people`, `environmental-risk`→`environment` as a topic-implying tag…), each topic's suggested tags, and a short list of cross-cutting tags (`site-selection`, `homesteading`, `heirs-property`).
  - `CATEGORY_LABELS` in `src/lib/publicLayers.ts` becomes a view over the taxonomy so `/layers`, compare's layer picker and the county context picker keep their labels from one place.
- **Applied everywhere a category or tag appears.** Reindex normalises `category` and `tags` through the aliases (unknowns kept, warned once, and counted in the admin queue as "uncategorised"); the filing suggestion (P5-47) and the page-reading proposal (P5-61) choose `category` from the taxonomy ids and tags from the suggested list first (the validator refuses ids outside it; free tags still allowed, normalised); `sourceMeta.topics` map to taxonomy topics/tags; the Library list's category filter becomes a **topic facet** with the shared labels and counts plus a separate purpose filter, tag chips clickable; cards, ⌘K rows, the entry page, `/layers`, place-report sections (grouped by topic), Ask's system prompt (one line listing the topics so "what do we have on water" retrieves by topic) and an MCP `list_topics` tool all read the same labels.
- **Migration, explicit.** `npm run library -- retag --dir <push tree> [--apply]` reports every entry's category/tags before and after alias normalisation and proposes a topic for entries that carry only a purpose (from tags, then from the title with the model when a key is set, marked "proposed"); `--apply` rewrites manifests. Run it on the push tree, review the report, apply, push, reindex. The library guide's Categories section is regenerated from the taxonomy.
- Tests: taxonomy shape + stale export, alias normalisation, reindex warnings and the uncategorised row, suggestion/proposal validators, facet counts and labels, retag dry-run/apply, place-report grouping, MCP tool; live-verified on the loaded content (filters, /layers, a fresh drop's suggestion).



### Implementation notes (2026-09-07)

- Lead's one change to the agent's alias table: `environmental-risk` stays a cross-cutting tag rather than folding into the Environment topic — it is the screening concept behind Nick's question and spans environment, water and hazards; 26 entries keep it and `?tag=environmental-risk` returns them.

#### The vocabulary

`src/config/taxonomy.ts` is the source of truth and the only place a person edits it. Three kinds of word, each answering a different question:

- **14 topics** — what a thing is ABOUT. The public map's eight layer categories are members (`layerCategory` names which), so the same plain words label a map layer and a library entry: `composite` **Overall index**, `demographic` **People**, `economic` **Jobs and income**, `housing` **Housing**, `equity` **Equity**, `transportation` **Getting to work**, `environment` **Environment**, `health` **Health**, plus `land` **Land**, `water` **Water**, `hazards` **Hazards**, `agriculture` **Agriculture and food**, `places` **Places**, `network` **Network**. Each carries a one-line description and its own suggested tags.
- **4 purposes** — what a document is FOR: `strategy` **Strategy**, `research` **Research**, `outreach` **Outreach**, `ideas` **Ideas**. Stored in the same `category` field; the taxonomy is what says which is which.
- **Tags** — kebab-case and free, with an alias table, per-topic suggestions, and four cross-cutting words (`environmental-risk`, `site-selection`, `heirs-property`, `sensitive`).

**A topic is DERIVED, never stored twice.** `topicFor(category, tags)` = the category when that is a topic, else the first tag that is one. So a `research` brief tagged `land` files under **Land** with no manifest edit and no second field to keep in step — and the server answers `?topic=land` by exactly the same rule the card, the facet and the place report use.

**The alias table** (`TAG_ALIASES`) folds both spelling variants and topic-implying words, and is idempotent by test — normalising twice never moves a word again, and no suggested or cross-cutting tag is also an alias key:

| from | to | | from | to |
|---|---|---|---|---|
| `flooding`, `floods` | `flood` | | `demographics`, `demography` | `demographic` |
| `wildfires` | `wildfire` | | `economy`, `economics` | `economic` |
| `hazard` | `hazards` | | `transport` | `transportation` |
| `soils` | `soil` | | `environmental` | `environment` |
| `farm`, `farmland` | `farms` | | `water-quality` | `water` |
| `parcel` | `parcels` | | `farming`, `agricultural`, `ag` | `agriculture` |
| `well` | `wells` | | `place` | `places` |
| `watersheds` | `watershed` | | `land-ownership` | `ownership` |
| `garden` | `gardens` | | `primary-sources` | `research` |
| `site` | `sites` | | `organisations`, `orgs` | `organizations` |
| `idea` | `ideas` | | | |

`primary-sources` → `research` is the one judgement call in the table: verbatim historical texts are what a document is FOR, and their subject rides in the tags (`homestead-acts` carries `land`).

**It ships in the public bundle.** `src/lib/publicLayers.ts` reads `CATEGORY_LABELS` and `CATEGORY_ORDER` from it, and the public map reaches that module — so the file holds generic words only. `homesteading` is a bundle-leak canary and is therefore NOT in `CROSS_TAGS` despite the ticket naming it; a test in `src/config/__tests__/taxonomy.spec.ts` asserts the module mentions none of the canaries, catching it in the suite rather than at the end of a build.

#### Generated, not copied

`npm run export:layers` now writes `server/src/prompt/taxonomy.generated.json` beside the layer registry (`scripts/export-layer-registry.mjs`). `server/src/services/taxonomy.ts` reads it and re-exports the same helpers. Stale-check tests on both sides: the client spec compares the JSON against the module a person edits; `server/src/services/taxonomy.test.ts` asserts the committed JSON is the file the script writes and describes a usable taxonomy.

#### Applied

- **Reindex** (`libraryCatalog.applyTaxonomy`): every manifest's `category` and `tags` folded through the aliases, on the reindex path AND on the direct-insert paths (upload, filing, note create/update), so a row inserted today is spelled the same as the same entry after tomorrow's rebuild. An unknown category is **kept** and warned about once per entry, naming the fix (`library -- retag`). Kinds that carry no manifest category (wiki, view) are never warned about and never counted.
- **`searchCatalog`** takes `topic=`, `purpose=` and `tag=` (all through the aliases on both sides); `category=` still works as an alias for whichever question its word asks, and is matched literally for a word the taxonomy does not know — so every link written before this ticket opens the same list. `attention=uncategorised` is the "no topic" queue. `q=` also asks the folded question, so a search for a spelling variant still finds the entries stored under the canonical tag. (`environmental-risk` itself is a cross-cutting tag, not an alias — the lead's decision, below.)
- **Ask retrieval**: each entry's chunk gains `Topic: <label> — <description>`, which is what keeps the plain words searchable after the aliases fold the ids (a kbSearch test caught this the moment the aliases landed).
- **The filing suggestion** (`suggestFiling`): `knownCategories()` is now the taxonomy and nothing else — it used to be twelve hand-kept words UNION whatever the catalog happened to hold, which is how three vocabularies grew. The validator reads the answer through the aliases and then refuses anything outside the list; tags are cleaned and folded. The prompt shows the ids split by the question they answer (`categoryMenu`) with the suggested tags beside them.
- **The page-reading pass** (`linkPrune`): the prose read gains `topic` (one topic id — a purpose is refused, because a page on somebody's website is not FOR anything of ours) and `tags`. `sourceProposal` uses them for `category`, `tags` and `source.topics` when no filing pass ran, and `linkInspect.inspectionText` passes them to the filing model so the two passes start from one vocabulary.
- **Source topics** are folded only where they name a taxonomy word (`normalizeSourceTopic`); "underground storage tanks" and "303(d) list" stay as the publisher wrote them.
- **Ask's system prompt** gains one line naming every topic with its label.
- **MCP**: new read tool **`list_topics`** (topics with labels, descriptions and a count of entries under each, the four purposes, and how many entries have no topic); `search_library` takes `topic=` (enforced against the taxonomy, applied to the content matches as well as the name matches) and every result carries `topic` and `purpose`.
- **Client**: the Library list's category dropdown became a **topic facet** (buttons with counts, plus "No topic"), a separate purpose select, and clickable tag chips; URL keys `topic`, `purpose`, `tag`, with an incoming `category` routed to whichever filter its word belongs to. Cards, the entry page and ⌘K rows show the topic label and the purpose beside it. `/layers`, compare's layer picker and the county context picker are unchanged on screen and now read their labels from the taxonomy (a test pins the eight labels and their order). Place-report sections are grouped under topic headings (`groupSections`, with "Everything else" last). The drop-a-link, upload-filing, idea and note-edit forms share one `TaxonomyFields.vue` — a select grouped "What it is about" / "What it is for", the chosen topic's suggested tags as toggle chips, and the free-text tag box.
- **Operations home**: a new attention row, "Entries with no topic", deep-linking to `?attention=uncategorised`.

#### The migration

`npm run library -- retag --dir <path> [--apply]` (`server/src/cli/retag.ts`). Pure local file work — no bucket, no database. The dry run prints a table and writes `<dir>/retag-report.md`; `--apply` rewrites manifests, touching only `category` and `tags` and re-serialising from the object it parsed, so lineage, source blocks, supersession pointers and note bodies come back byte-identical. Wiki pages and saved views are never opened.

A topic is proposed for an entry that has none: first from the words it already carries (free and checkable), then — only for what is left, and only when `ANTHROPIC_API_KEY` is set — from the titles, in **one** call for the whole tree so the entries are filed as a set. **A proposal is applied as a TAG, never over the category a person chose**: the category already says something true, the topic is read from the tags, and overwriting a filing is the one unrecoverable thing this tool could do.

**Dry run on the push tree** (`/Users/mac/Desktop/BLO/library-staging/push`, report at `/Users/mac/Desktop/BLO/library-staging/push/retag-report.md`): first run, before the lead kept `environmental-risk` as a cross-cutting tag: **64 entries · 31 would change · 3 get a proposed topic · 0 carry a category the taxonomy does not know.** Final run after that decision: **64 entries · 6 changed · 3 proposed (applied as tags).** The 31 are 3 category folds (`demographics` → `demographic` on 2 entries, `primary-sources` → `research` on 1) and 28 tag folds (`environmental-risk` → `environment` on the source manifests, `demographics` → `demographic`, `site_selection` → `site-selection`). The 3 proposals are `agriculture` for the seed and vegetable entries, read from their tags.

Eleven more entries carry only a purpose and would have had a topic read off their title — an earlier run with credits available proposed `land` for the campus documents and `network` for the funding ones — but the API ran out of credit during this session, so the report says so in as many words rather than claiming the titles say nothing. Rerun the dry run once credits are back to fill those in. Not applied either way: the lead reviews.

#### Content and docs

The library guide's **Categories** section is regenerated from the taxonomy (topics with their descriptions and suggested tags, purposes, cross-cutting tags) and a **Topics and tags** section above it explains topic vs purpose vs tag and states the alias rule. Written in place at `library-staging/push/library/wiki/library-guide.md`; not pushed. `DEPLOY.md` gained one bullet (regenerate the export when the taxonomy changes; the retag command). `docs/MCP.md` documents `list_topics` and the `topic` filter.

#### Consistency in the page-reading pass (Nick's addendum, 2026-09-07)

P5-62 listed the TIGER directory's **0.60 agreement** as "a page with fifty equally-good folders and a twelve-link cap rather than a defect". It was a defect. Three changes, all in `server/src/services/linkPrune.ts`:

1. **Topic-aware pruning.** The prune prompt now carries the taxonomy (topic ids with labels, and the suggested tags), and the answer carries `topic` (one topic id — a *purpose* is refused, because a page on somebody else's website is not FOR anything of ours) and `tags` (normalised through the aliases, free words kept). `sourceProposal` and `inspectionText` use them, so a dropped link's `category` comes from the same vocabulary as everything else instead of a second one.
2. **Deterministic selection under the cap.** The prompt states the preference order — links whose words match the page's own tags, then files and endpoints over documentation, then page order — and the same rule is then applied in code (`rankByPreference`), so the stored order is the same however the model wrote it. The list is topped up only when the CAP was what stopped it (more candidates than `KEPT_LINKS_MAX`, at least one kept, short of the cap), and only with links that both match the page's words and ARE data — "kept nothing" stays the right answer on a navigation page.
   **A bare file index skips the model for its links entirely.** `isDirectoryListing` (mostly folder candidates, at least eight) → `rankDirectoryLinks`: the page's own address under a different sort and the parent directory are dropped, then the folders whose name IS a geography we file by (`sourceMeta`'s own list plus `bg`, `cousub`, `place`, `zcta`, `tabblock`; matched on the letters, so `ZCTA520` counts and `POINTLM` does not), then data files, alphabetical within each. The candidate list is not even serialised into the prompt — the model is asked only what the page IS. `linkSelection: 'ranked'` says so on the result.
3. **Eval hooks.** Every label file gained a hand-written `topic` and `tags` (left out where the page's own words name no subject — the ArcGIS Hub shell has neither); the scorer gained a `topic` column (accuracy over the pages that state one), a `tags` column and tag precision/recall on the summary line, and a delta that reads them as new rather than as a change from zero.

**The run** — 14 pages × 3 runs, `claude-sonnet-5`, `results/2026-09-07T07-20.json` against P5-62's `2026-09-07T02-17.json`. (A first post-change run at 07-12 was superseded by the geography-folder tightening below and its results file was not kept; 07-20 is the shipped code.)

| | before | after |
|---|---|---|
| **census-tiger-directory · agreement** | **0.60** | **1.00** |
| census-tiger-directory · hit | 6.7/8 | **8/8** |
| census-tiger-directory · bad + neutral extras | 4.0 | **0** |
| census-tiger-directory · input tokens | 11,914 | **3,158** |
| census-tiger-directory · $/page | $0.0465 | **$0.0160** |
| overall precision | 85% | 86% |
| overall recall | 91% | **93%** |
| overall agreement | 0.92 | 0.91 |
| roles | 96% | 94% |
| isDataset | 12.7/14 | 12.3/14 |
| topic (new) | — | 7.0/13 pages |
| tags (new) | — | precision 41%, recall 73% |

**The overall line understates it, for a reason worth recording:** the API ran out of credit on the last page of the run, so `usgs-press-release` lost 2 of its 3 runs to a 400 and fell back to the unranked ranking, which keeps six links on a page whose right answer is none. Excluding that one page from BOTH runs:

> **precision 85% → 92% (+7 pts) · recall 91% → 93% · agreement 0.92 → 0.95 · roles 96% → 94% · isDataset 12.0/13 unchanged · input tokens 4,239 → 4,004.**

The remaining role loss is the known Socrata `query.json?accessType=DOWNLOAD` disagreement plus one ERS download page; both were listed as "not fixed" in P5-62 and still are. Topic at 7.0/13 and tag precision at 41% are a first baseline, not a target: the pass answers more tags than the label states, which is what the precision number is for.

#### Tests and gates

Server **1,628 pass, 14 skipped** (75 files), up from P5-62's 1,566 — new: 14 `services/taxonomy.test.ts`, 18 `cli/retag.test.ts`, 12 `linkPrune` (topic/tags parsing, the directory ranking, the deterministic finish), 8 `libraryCatalog` (fold, warn, filters, the uncategorised row), 3 `sourceProposal`, 3 MCP `list_topics`/`topic`, 1 `placeReport`, plus the suggestion-validator rewrites. Client **1,066 pass** (64 files), up from 1,031 — new: 20 `config/__tests__/taxonomy.spec.ts`, 9 LibraryView facet/forms, 4 `libraryCatalog` helpers, 1 PlaceView grouping, 1 kb attention row. `vue-tsc --build` and `tsc --noEmit` (both `tsconfig.json` and `tsconfig.eval.json`) clean; `npm run build` + bundle-leak green (45 files, 10 canaries).

---

## P5-35 [FEATURE] Supersession: archived hidden by default, `supersededBy` pointers, banners ✅ DONE

**Type:** Feature · **Size:** S · **Dependencies:** P5-9 · **Nick 2026-09-04:** "we shouldn't have a bunch of out of date docs that are superseded by other docs, we should only be visibly showing the latest"

### Acceptance criteria
- [x] **Manifest field** `supersededBy: "<slug>"` on an archived entry names the current one. Reindex validates it (warning when the target slug doesn't exist) and the catalog exposes the reverse relation on the current entry (`supersedes: [slugs]`, computed at read time — no manifest edit on the winner).
- [x] **Catalog hides archived by default**: `GET /api/library/catalog` excludes `status=archived` unless `?archived=1` or an explicit `status=archived` filter; the response carries `archivedCount`. The Library page shows a quiet "N archived · Show" banner (same pattern as the ideas/queue banners) that reveals them; search results follow the same rule.
- [x] **Entry page banners**: an archived entry with `supersededBy` shows "Superseded by <title> → open the latest"; a current entry with `supersedes` shows "Replaces: <titles> (archived)". Archived entries render with muted styling.
- [x] **Wiki cards**: ` ```entry:<slug> ` for an archived entry renders the pointer ("Archived — superseded by <title>", linking to the current entry) instead of a normal card.
- [x] **Content**: the three archived homesteading entries get pointers (Reference Manual + Section 6 extract → `homesteading-fact-manual`; landowner comparison table → `landholders`); the library guide explains "new version = same entry" (bucket versioning keeps history).
- [x] Tests: server search default/`archived=1`/explicit status + `archivedCount`, `supersedes`, reindex warning; client query builder + wiki card pointer. Live-verified on the loaded content.

---

### Implementation notes (2026-09-04)
- Server: `searchCatalog` drops `archived` rows unless `includeArchived` or an explicit `status=archived`; new `searchCatalogPage` returns `{ entries, archivedCount }` (count of hidden rows under the same other filters) and the list route takes `?archived=1`. `getCatalogEntry` returns `CatalogEntryDetail` with `supersededBy` (manifest pointer resolved to a title; a dangling pointer still returns the slug) and `supersedes` (reverse relation from archived rows). Reindex warns `"<slug>" is supersededBy "<x>", which does not exist`. 3 route tests.
- Client: `fetchCatalogPage` + `archived` filter; Library page banner "N archived entries are hidden — superseded by newer material · Show archived" (toggle re-queries; the option dropdowns still load with archived included); entry page banners ("Archived — superseded by <title>. Kept for the record; use the latest." / "Replaces: … (archived)") with muted title on archived entries; wiki `entry:` cards for archived entries render the pointer + a muted "Open the archived copy →". 3 client tests.
- Content: `supersededBy` set on the three archived homesteading entries (→ `homesteading-fact-manual` ×2, → `landholders`); library guide gained "Versions and superseded material". Pushed + reindexed: default catalog 26 of 29 (3 hidden), research 7 + 2 hidden; relations verified both ways via API and in the UI (banner toggle 26 → 29 cards, archived entry banner links to the fact manual, fact manual lists both replaced documents).
- Gates: server 313 pass, client 144 pass, vue-tsc, build + leak, Cypress green.


## P5-36 [FEATURE] Cross-links + map deep links: show-on-map / browse-data / about from every surface ✅ DONE

**Type:** Feature · **Size:** S–M · **Dependencies:** P5-24, P5-31 · **Nick 2026-09-04:** files, wiki entries, data views and map layers "should all fluidly be accessible and viewable"

### Acceptance criteria
- [x] **Map deep links**: `/?layers=<id,id>` opens the map with those layers on (public ids and `internal-<slug>` ids, applied after the manifest loads; unknown ids dropped) and `&focus=<internal-id>:<label>` flies to a point (label, not index — row order in the table differs from the projected feature order once bad coordinates are skipped) and opens its popup. Saved views keep `?view=`; both parse defensively.
- [x] **From the map**: each Internal layer row gets "About" (`/library/<slug>`) and, when tabular, "Browse data" (`/library/<slug>/data`); point popups and the entity-rail header get "Open record" → `/library/<slug>/data?q=<label>`.
- [x] **From the table**: header actions "About" and, when the entry has a layer block, "Show on map" (`/?layers=internal-<slug>`); the row drawer gets "Show on map" for point datasets (`focus=`).
- [x] **From the entry page**: "Show on map" when a layer block exists; "Browse data" already exists.
- [x] **From wiki cards**: entry cards show the actions the entry actually supports (Open · Browse data · Show on map) — the card already fetches the entry so no new request.
- [x] Tests: deep-link parser, card actions, table header actions; Cypress: logged-out `/?layers=internal-x` is a no-op (no request, no error).

---

### Implementation notes (2026-09-04)
- `src/lib/mapDeepLinks.ts`: `parseMapDeepLink` (comma/repeated `layers`, id regex, de-dupe; `focus` only for internal ids, label may contain colons), `mapUrlForLayers`, `internalLayerId`, `recordUrl`. Map.vue: `applyMapDeepLink` watches `layers`/`focus` (deferred via `pendingDeepLink` until map + counties, replayed in the load handler like saved views; awaits the internal manifest when internal ids are present; public ids go through the category toggles via `ensurePublicLayerOn`; unknown/internal-while-logged-out ids are dropped; `focus` polls for the point collection then reuses `onEntitySelect`). Point popups get an in-app "Open record →" (`a[data-internal]`, routed through `router.push` by a click interceptor on the popup element).
- Surfaces: `LibraryEntryView` Show on map (via `layerIdForEntry` — published + layer block only); `DatasetView` header Show on map + row drawer Show on map for point datasets (uses the schema's new `layer` summary incl. `labelKey`); wiki entry cards Open · Browse data · Show on map; LayerControls internal rows About · Data; EntityRail header About · Data (single-layer case; `EntityRailLayer.slug` added).
- Server: `readDataset` returns the entry's `meta`; the schema route adds `layer: { id, geometry, name, labelKey } | null` (1 test).
- Tests: deep-link parser 4, table 1, cards 1, layer rows 2 assertions, rail 2, popup 1, catalog helper 1; client 152 pass; server 314 pass; vue-tsc, build + leak green; Cypress smoke gained the logged-out deep-link test (public layer toggled on, internal id ignored, zero `/api/layers` requests).
- Live-verified on the loaded content: entry page → Show on map opened the map with Organizations (HQ) on and the entity rail up; table header/row links; a fresh load of `/?layers=internal-organizations&focus=internal-organizations:Black Farmer Fund` opened the popup on Black Farmer Fund with its rail row highlighted; "Open record →" routed in-app to the table filtered to that organization.


## P5-37 [FEATURE] Entry hub: Overview / Data / Map / Mentions / Files tabs + wiki backlink index ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-36 · **Stub — refine after P5-35/36 land**

One page per entry instead of three destinations: Overview (meta, provenance, lineage, supersession), Data (the P5-31 table inline), Map (small static preview or the show-on-map action + which saved views use the layer), Mentions (wiki pages that link `/library/<slug>` or embed `entry:<slug>`, plus saved views using its layer — built as a backlink index at reindex by scanning wiki markdown, stored in the catalog row's meta), Files (downloads). Open question: keep `/library/<slug>/data` as a deep link into the Data tab.

---

### Implementation notes (2026-09-04)
- Server: reindex scans each wiki page (already read fresh for its title) with `extractWikiMentions` (`/library/<slug>` links incl. `?tab=`/`#` suffixes, and ` ```entry:<slug> ` embeds; de-duplicated per page) and stores `meta.mentionedBy: [{slug,title}]` on every entry (empty array when none) — no read-time scanning. `savedViewMeta` records `layers` (scoring layer ids + point layer ids) on view rows. 1 catalog test + 1 views test.
- Client: `LibraryEntryView` is the hub — title/badges/supersession banners stay above a tab bar (`?tab=`; Data only for tabular files, Map only when `layerIdForEntry`), Overview keeps everything the page had plus description/source/quick actions, Data embeds `DatasetView` (new `embedded` prop hides its own back link/title; `replaceState` now preserves non-table query keys so `tab` survives sorting/filtering; the panel widens for the table), Map shows the layer summary + Show on map + saved views using the layer (`fetchViewsUsingLayer` filters `kind=view` rows by `meta.layers`), Mentions lists `mentionedBy` pages + those views, Files lists downloads. `entryUrl(slug, tab)` helper; `recordUrl`, wiki cards, LayerControls/EntityRail "Data" links now target `?tab=data`; the old `/library/:slug/data` route redirects into the Data tab keeping its query. 6 hub tests (tabs per capability, counts, tab clicks, Data hosts the table, Mentions/Map lists, redirect, unknown tab).
- Gates: client 158 pass, server 316 pass, vue-tsc, build + leak, Cypress 9 pass. Live-verified on the loaded content (see final report).
- Decision left open (ticket question): `/library/:slug/data` kept only as a redirect — deep links to the table are now `?tab=data` everywhere.


## P5-38 [FEATURE] Global search / command palette across pages, entries, and layers ✅ DONE

**Type:** Feature · **Size:** M · **Dependencies:** P5-36 · **Stub**

One header search (⌘K) hitting the catalog (wiki pages are catalog rows already) returning grouped results — Pages · Datasets · Documents · Layers · Views — each row carrying its actions (Open · Browse data · Show on map). Optional larger move: fold Library + Wiki into one "Knowledge base" nav item whose landing page is the hub wiki page.

---

### Implementation notes (2026-09-04)
- `src/components/GlobalSearch.vue` in the header (internal only): trigger button + ⌘K/Ctrl-K palette; 200 ms debounce → `fetchCatalogPage({ q })` (archived stay hidden) + the internal layer manifest (cached for the session; failure → no Layers group, never an error); results grouped Pages · Datasets · Documents · Notes · Views · Layers (5 per group) with primary hrefs (`/wiki/<slug>`, `/library/<slug>`, `/views/<slug>`, `/?layers=<id>`) and per-row actions (Browse data → `?tab=data`, Show on map) built with the P5-36/37 helpers; ↑↓ move, Enter opens the highlighted row, Esc closes, backdrop click closes; empty state links to `/library?q=`. Server: `searchCatalog` `q` now matches title, slug, tags, category, and `meta.description`.
- Tests: 4 component (open/close/shortcuts, grouping + actions + layer match, keyboard + in-app routing, empty/failed manifest) + 1 server. Client 162 pass, server 317 pass, vue-tsc, build + leak, Cypress green.
- Not done (optional in the ticket): folding Library + Wiki into one "Knowledge base" nav item — the search box now sits between them; revisit after Nick has used it.


## P5-39 [CHORE] UX pass ✅ DONE (Nick 2026-09-04: "take your best shot across all those")

**Type:** Chore · **Size:** M · **Dependencies:** P5-38

### What changed
- [x] **Knowledge base front door.** One `Knowledge base` nav link (replacing Library + Wiki) → `/kb`: a "Start here" tile for the hub page when it exists (`KB_HOME_SLUG`, content convention), section tiles with counts (Pages · Data & documents · Saved views · To file, which turns orange when the queue is non-empty), quick actions (New page → `/wiki?new=1` focuses the title field; Drop a link → `/library?drop=link` opens the form; Upload; Ideas), and a Recently updated list across kinds. A shared `KbNav` strip (Overview · Pages · Data & documents · Ideas) sits on the landing, the pages index, and the data list; deep links into `/library` honour `q`/`category`/`status` from the URL. Server: catalog rows carry `updatedAt` = the newest bucket object among the entry's files (B2 `LastModified`, surfaced by `listFiles`), falling back to the index time when the listing reports none — so the list reflects content changes, not the last Reindex (which would stamp everything "just now").
- [x] **Naming.** The header title reads "BLO Knowledge base" on knowledge-base routes while logged in and "U.S. Livability Index" everywhere else (public unchanged); the pages index is "Pages", the list is "Data & documents".
- [x] **Loading and empty states.** Skeleton cards on the data list and skeleton rows on the table while loading; "Nothing matches these filters · Clear filters" vs "The library is empty — …" on the list; the entity rail shows "Loading entities…" while a layer's features download; the pages index shows "Recently updated" above "All pages".
- [x] **Mobile.** The entity rail is a bottom sheet with a drag handle; tapping it collapses the sheet to a strip (the county rail already did this). Table skeletons and wrapping toolbars keep the hub's Data tab usable on narrow screens.
- [x] **Layers tab.** The Internal section moved to the top of the layer picker (right under the BLO index), expanded by default.
- [ ] Deferred: a11y sweep (reduced-motion / contrast, from P5-30) and a proper mobile layout for the table's row drawer.

### Tests / gates
- 4 kb helper + 2 landing + 1 layer-order + 1 rail-loading tests; client 176 pass, server 334 pass, vue-tsc, build + leak, Cypress green (internalAuth updated for the new nav).

---

## P5-64 [FEATURE] Held before indexed — the registry ranks behind vetted data ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P5-56, P5-63 · **Nick 2026-09-07:** "does the data registry interfere with the accessibility of already vetted and ingested data layers that we previously implicitly prioritized" → "Great, let's do it."

### Today
The 40 indexed-only sources outnumber everything the team actually holds (5 datasets, 17 documents, 11 pages, 2 notes), and every list that mixes kinds orders by recency alone. Measured on the loaded content: the Library list's first two screens are all sources and the five held datasets are the last five cards (`ORDER BY updated_at DESC`, `server/src/services/libraryCatalog.ts:742`, no kind ordering); ⌘K folds sources into the **Datasets** group with only a badge (`src/components/GlobalSearch.vue:58`), so "flood" returns five sources and nothing held, "contamination" lists five sources before the vetted public layer *EPA Contamination Sites*, and "housing" cannot find *Median Home Value* because layers are matched on label and description only, never on their category name; the landing's count tile says "22 Data & documents" while the list shows 72, because `kbCounts` (`src/lib/kb.ts:20`) counts no sources at all. Where it already works: `/layers` (public groups first, internal last, sources absent) and the map's Layers panel.

### Design
- **A kind rank, server-side, so every consumer agrees.** `KIND_RANK = dataset 0 · view 1 · wiki 2 · document 3 · note 4 · incoming 5 · source 6` in `server/src/services/libraryCatalog.ts`; `searchCatalog` orders by `kind rank, updated_at DESC` by default and by recency alone for `sort=recent`. The route validates `sort ∈ {held-first, recent}`; the client wrapper exposes it; MCP `search_library` inherits held-first (one line in `docs/MCP.md`). Free-text queries keep the same order — a search for "flood" shows what we hold before what we point at. Anything that means "recently updated" (landing feed, wiki index) must keep saying so: verify whether they sort client-side today; if they call the catalog, pass `sort=recent`.
- **The boundary is visible.** In the Library list with no kind filter, one divider row sits before the first source card — "Data sources · indexed, fetched on demand · 40" — with a one-line explanation of "not copied here". The per-card badge stays. With a kind filter or an empty list no divider renders.
- **⌘K groups by trust.** Group order becomes Pages · Datasets · Layers · Documents · Notes · Views · To file · Data sources; sources leave the Datasets group and get their own last group (cap 5, the `Source` badge dropped because the group name says it); incoming entries move from Documents to **To file**. Public layers match on label, description, *and the category label* through the taxonomy (`src/lib/publicLayers.ts`), so "housing" returns the Housing group and "people" the People group; internal point layers stay first inside Layers.
- **The registry gets a home on the landing.** `kbCounts` gains `sources`; the landing (P5-68 owns the view) shows a *Data sources · 40 · indexed, fetched on demand* tile linking to `/library?kind=source`, and the Library tile's sub-line reads "held here: 5 datasets · 17 documents · 2 notes".
- **Out of scope, on purpose:** Ask retrieval (data-intent questions reserve half the budget for sources by design, P5-56) and place-report candidates (sources are what a place report runs, P5-58).
- Tests: default order and `sort=recent` in `searchCatalog`, route validation, client wrapper param, divider render/no-render, ⌘K group order + category matching + To file group, `kbCounts.sources`. Live: `/library` shows the five datasets first, ⌘K "housing" → Housing layers, "flood" → held/vetted first then sources.


### Implementation notes (2026-09-07)
- `KIND_RANK` (dataset 0 · view 1 · wiki 2 · document 3 · note 4 · incoming 5 · source 6) lives in `server/src/services/libraryCatalog.ts`; `searchCatalog` stable-sorts by rank before the 200-row cap, so recency survives inside each rank; `sort=recent` is the old order and the route refuses any other value with a 400 naming the two. Unknown kinds rank with documents (something we hold). Free-text queries inherit the order. MCP `search_library` inherits it (one line in `docs/MCP.md`; no `sort` argument yet).
- Library list: one divider before the first source card — "Data sources · indexed, fetched on demand · N" (N = the sources in the current list) with the "not copied here" sentence — suppressed by a kind filter or an empty list, kept under topic/tag/status filters. The h1 is **Library**.
- ⌘K: Pages · Datasets · Layers · Documents · Notes · Views · To file · Data sources; the per-row `Source` badge is gone (the group says it); `searchLayers` now matches the category label through the taxonomy — one code path, so `/layers`, compare's picker and the county-context picker gained the same match. Live: "housing" → BLO Livability Index, Median Home Value, Median Property Tax in Layers, then the ACS source under Data sources; "flood" and "superfund" return only sources, which is honest — nothing held matches those words.
- Landing: `kbCounts.sources`; the tiles no longer count archived entries (the Library tile said 17 documents over a list of 14 — lead's fix, with a test). Both "Recently updated" blocks already sorted client-side, so held-first changed nothing there.
- Follow-up found during the live check and fixed by the lead: one place report put 15 of 40 sources into the admin queue as "last fetch failed" because `recordFetchFailure` recorded `no-endpoint`, `manual-only` and `bad-place` alongside real failures. `isSourceFault()` now gates it — a hand-only source is not broken, and a bad address is the caller's. Tested.
- Live (dev API restarted, 75 entries): `/library` order d·d·d·d·d·w×11·doc×14·n·n·s×40; divider present; landing tiles 11 pages · 21 held · 40 data sources · 15 map layers; no page overflow at 375 px on `/kb`, `/library`, `/ask`, `/place`, an entry.

---

## P5-65 [CHORE] One name per thing ✅ DONE

**Type:** Chore · **Priority:** P1 · **Size:** S · **Dependencies:** none · **Nick 2026-09-07:** "does the app seem coherent?"

### Today
The library is "Data & documents" in the strip and the heading but "the library" in every sentence of copy, the guide's name and the back link; "Source" is an entry kind, the provenance line on every card and page ("Source: US EPA"), and the citations under an Ask answer; the header brand reads "U.S. Livability Index" on `/ask`, `/place` and `/compare` and "BLO Knowledge base" everywhere else internal; "Ideas" is a nav item but a purpose filter, still linked as `?category=ideas`; the "Saved map views" tile links to the map root; incoming files are "To file" on the landing and "Documents" in ⌘K; the map chat and the knowledge-base Ask have different powers and nothing says which answers what.

### Design — the rename table, applied everywhere a user reads it
| Today | Becomes | Where |
|---|---|---|
| Data & documents | **Library** | strip, `/library` h1, landing tile, first-run step, help recipes, Cypress, wiki `home.md` / `library-guide.md` copy in the push tree |
| `Source: <publisher>` provenance line | **Publisher:** | entry page, layer pages, cards (entry page + layer views done inside P5-67's files) |
| "Sources" heading under an answer | **Where this came from** | `src/lib/ask.ts`, AskBox / AskView |
| "Sources checked" on a place report | **Data sources checked** | PlaceView |
| Ideas → `?category=ideas` | `?purpose=ideas` | strip, landing; the list accepts both and treats `category=ideas` as the purpose |
| Saved map views → `/` | `/library?kind=view` | landing tile |
| ⌘K "Documents" holds incoming | **To file** group | done in P5-64's group change |
| "U.S. Livability Index" on `/ask` `/place` `/compare` | **BLO Knowledge base** | `App.vue` `inKnowledgeBase`; the logged-out header stays byte-identical (existing snapshot test) |
| "wiki page" in visible text | **page** | wherever a user sees it (prompt text untouched) |
| Two Ask boxes, unexplained | the public map chat is untouched; `/ask`'s intro gains one sentence: "For the map itself — a county, a layer, a ranking — use the chat on the map." | AskView |

- Tests: the strip labels, the h1, the purpose link, the header title on the three routes plus the logged-out snapshot, the answer heading, the place heading. Cypress expectations updated. Content copy changed in the push tree and pushed by the lead.


### Implementation notes (2026-09-07)
- Every row of the rename table applied: **Library** (strip, h1, landing tile, help recipes incl. the recipe title "Browse the library", Cypress, and `home.md` + `data-sources.md` in the push tree — pushed and reindexed); **Publisher:** on entry pages and both layer views (`publisherLine()` in `src/lib/publicLayers.ts`, next to the public map's untouched `sourceLine`); **Where this came from** under answers (AskView, `ask.ts` saved notes, help recipes); **Data sources checked** on place reports and in `placeReport.ts`'s exported markdown; `?purpose=ideas` in the strip (the list still honours `?category=ideas`); the header reads **BLO Knowledge base** on `/ask`, `/place` and `/compare` for a logged-in user, with the logged-out header still byte-identical by test; visible "wiki page" → "page" (wiki index empty state, entry "Pages" backlink heading, page-load error).
- The two Ask boxes: the public map chat is untouched; `/ask`'s intro says "For the map itself — a county, a layer, a ranking — use the chat on the map."
- The Ideas quick link on the landing went with the quick-action row (P5-68); the strip carries Ideas.

---

## P5-66 [FEATURE] Ask and Check a place in the strip ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** XS · **Dependencies:** P5-65 (labels) · **Nick 2026-09-07:** "are there clear user flows, even for an inexperienced user, to get what they need?"

### Today
The two flows a newcomer actually has — ask a question, check an address — are served by `/ask` and `/place`, but neither has a nav item: `/place` is one black button on the landing, `/ask` is reachable only from the first-run checklist, an Ask box or ⌘K. `/ask` does not render the strip; `/place` and `/compare` do.

### Design
- Strip order: **Overview · Ask · Check a place · Library · Pages · Map layers · Compare · Ideas** — the two task flows right after Overview, the browsing surfaces after. `/ask`, `/place` and `/compare` all render the strip with the right item active.
- The phone menu sheet (`InternalHeaderTools`) lists Ask and Check a place too.
- The strip already scrolls sideways on phones (P5-60); verify eight items at 375 px cause no page overflow.
- Tests: strip items and active states, menu sheet items, the 375 px overflow guard. Live: land on `/kb`, reach `/place` and `/ask` in one click each.


### Implementation notes (2026-09-07)
- Strip: Overview · Ask · Check a place · Library · Pages · Map layers · Compare · Ideas, on every knowledge-base page including `/ask` (placed above its h1, since its header only renders once a question exists), `/place` and `/compare`. Ask and Check a place use exact-path active states; the browsing items keep prefix matching. The phone menu sheet lists both. A test pins that eight items scroll inside the strip rather than widening the page; live at 375 px there is no overflow.

---

## P5-67 [CHORE] Source pages read first, edit behind a button ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** none

### Today
A source entry's Overview tab shows the full 15-field "Edit this source" form, expanded, to every visitor — gated by kind, not by role (`src/views/LibraryEntryView.vue:775`). A researcher opening the Superfund entry meets "Who publishes it? (required)" before "How to get it".

### Design
- For `kind === 'source'` the filing form is closed by default behind an **Edit** button beside the title, the same affordance wiki pages use; `?edit=1` opens it, and the drop-a-link flow keeps landing with it open when it routes to a fresh entry. `kind === 'incoming'` keeps the form open — filing is that page's whole point.
- The suggestion panel and any model call run only once the form is open.
- Everyone may still edit (not admin-gated): the researcher who dropped the link is the one who fixes its title.
- Overview reading order for a source: description → How to get it → Key fields → Fetch for a place → Publisher line. The provenance line reads **Publisher:** here and on the layer pages (P5-65's row, done here for file ownership).
- Tests: closed by default for sources, open for incoming, `?edit=1`, no suggestion call while closed, the Publisher label. Live: open `epa-superfund-npl`, read without a form; press Edit, the form and suggestion appear.


### Implementation notes (2026-09-07)
- For a source the filing form and the ingest panel render only with `?edit=1`; an **Edit** button beside the title sets it, **Cancel** clears it; incoming entries stay open. The open state lives in the URL, so an edit link is shareable; switching tabs closes the form and typed values survive in their refs. No suggestion or proposal request fires while closed (tested). The drop-a-link flow's only in-app navigation to a fresh entry (`onDropDiscoveredLink`) now lands with `edit=1`; the library page's own drop does not navigate at all. Filing an incoming link *as* a source re-opens the form so the confirmation stays visible.
- Overview order: description → How to get it → Key fields → Fetch for a place → Publisher and the rest of the provenance rows; the redundant "Data source" h2 is gone. Live: `epa-superfund-npl` renders one input (the Ask box) closed, fifteen open.

---

## P5-68 [FEATURE] The landing as a front door ✅ DONE

**Type:** Feature · **Priority:** P2 · **Size:** M · **Dependencies:** P5-64 (`kbCounts.sources`), P5-65 (labels) · **Nick 2026-09-07:** "think operational center… quick answers, data analysis for PhD's with low tech abilities" (P5-40) and "let's do it" (2026-09-07)

### Today
`/kb` carries ten blocks — initiative hero, six-step checklist, Ask box, Needs attention, What happened, Pinned, Start here, four count tiles, five quick-action buttons, Recently updated. It reads as a dashboard for the admin, not a front door for a research intern; the Pinned grid repeats the hero's own links; "Saved map views" links to the map.

### Design — the layout, decided
Two columns on desktop, one on phones, in this order:
1. **The initiative** — hero trimmed to the one-liner, the three numbers and "Read the initiative hub"; its link row stays (it replaces the Pinned grid, which is removed; the `pinned` data stays for search).
2. **What do you want to do?** — three flow cards with the input inline: *Ask a question* (a question box that submits to `/ask?q=`), *Check a place* (an address box that submits to `/place?address=`; add the query param if the page lacks it), *Browse* (Library · Map layers · Pages as three links).
3. **Start here** card with the first-run checklist beneath it, shown only until it is complete or hidden.
4. **Counts row** — Pages · Library (held here) · Data sources · Map layers · Saved views, each a link.
5. **Recently updated** — unchanged.
6. **Add something** — one compact row: New page · Drop a link · Upload files.
7. **Admin only, last** — Needs attention and What happened (P5-43's rule: attention is the admin's, not the reader's).
- The `How do I…?` footer link stays. Nothing here touches the public map.
- Tests: block order, admin-only blocks hidden for members, the flow-card submits, the counts row (including `sources`), the checklist hidden when complete. Live: before/after screenshots at 1280 and 375 for Nick's review — this is the one ticket whose look is a design call.


### Implementation notes (2026-09-07)
- Seven blocks in the ticket's order: hero (link row kept, Pinned grid and `PinnedRow.vue` removed) → "What do you want to do?" (Ask, Check a place, Browse — stacked, since three abreast left no room for a question) → Start here + checklist (checklist only until complete or hidden) → counts row (Pages · Library "held here" · Data sources · Map layers from the public registry · Saved views) → Recently updated (client-side sort) → Add something (New page · Drop a link · Upload files) → admin only: Needs attention and What happened (members make no activity request). Tiles show `—` until the catalog lands. `.kb-main` / `.kb-side` collapse to one column at 900 px with the P5-60 guards.
- Before/after screenshots at 1280 and 375 in the session scratchpad (`before-kb-*.png`, `after-kb-*.png`) for Nick's review — the one ticket whose look is a design call.

---

## P5-69 [FEATURE] Saved views open ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P5-64 · **Nick 2026-09-07:** "Let's do em all"

### Today
The map says "Save view", the table "Save this view", compare "Save this comparison"; all three become `kind: 'view'` entries listed under "Saved views". A library card for a view links to `/library/<slug>` (`LibraryView.vue:756`), where `LibraryEntryView` has no `view` branch at all — a description and no way to open it. ⌘K and the landing use `entryHref` (`/views/<slug>`), so the same entry opens from one surface and dead-ends from another. `/views/<unknown>` redirects to `/?view=<slug>` and the map's restore failure is a `console.warn` (`Map.vue:3503`).

### Design
- **One label**: "Save view" on the map, the table and compare; the confirmation in all three reads the same way and links to the saved view.
- **Cards link where the entry lives**: the library card uses `entryHref` like every other surface, so a view card opens the view. The entry page for a view (still reachable by URL and from Mentions) gets a **view branch**: what kind it is (map · table · compare), what it holds (layers / dataset + filters / counties × layers) and one primary action **Open this view**, plus the embed code for page authors.
- **A view that does not exist says so**: `ViewRedirect` fetches the view before redirecting; on 404 it renders "There is no saved view called “<slug>”." with links to Saved views and the map, instead of a silent plain map.
- Tests: card href by kind, the entry page's view branch and Open action, the redirect's 404 state, the three labels.


### Implementation notes (2026-09-07)
- "Save view" on the map, the table and compare; all three confirmations read `Saved — open “<name>” · embed it in a page with view:<slug>` and link to the view. Library cards use `entryHref`, so a view card opens `/views/<slug>`; the entry page gained a view branch (kind line, what it holds, named layers, **Open this view →**, the embed line) built from the row meta with no second fetch. `ViewRedirect` fetches first and renders "There is no saved view called “<slug>”." with links to Saved views and the map on a 404 (a failed fetch still falls back to the map). Live: the not-found state renders; the card links were checked in tests (no saved view exists in the dev content).

---

## P5-70 [FEATURE] Documents open on the document ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** none

### Today
A document entry's Overview shows Lineage and Quick actions (49 words for the strategic plan). Reading it takes three clicks: entry → Files → file name. The Files tab lists `meta.json`, the entry's manifest, as a readable file.

### Design
- **A Read action** in the entry header for any entry whose primary file the viewer can show (`isViewable`), opening the viewer directly (`?tab=files&view=<name>`); the same action leads the Quick actions row. The primary file is the first viewable non-manifest file, preferring PDF, then docx/rtf, then text.
- **The Overview shows the document**: for documents with an extraction, the first ~600 characters of extracted text as a preview with "Read the whole document →". No extraction → the existing description only.
- **Manifests are not files**: `meta.json` (and any `*.manifest.json`) is hidden from the Files list and from file counts; the Download link for the manifest goes with it.
- Tests: Read action presence by file type, primary-file choice, preview render + fallback, manifest filtering and counts.


### Implementation notes (2026-09-07)
- `primaryViewableFile()` / `isManifestFile()` in `src/lib/documentView.ts`. A **Read** button in the entry header and **Read →** first in Quick actions open the viewer on the primary file; the Overview shows the first 600 characters of the extraction (documents and incoming only — a dataset's CSV would otherwise trigger an extraction nobody asked for) with "Read the whole document →"; manifests are gone from the Files list, the tab count, the quick-action count and the byte total. Live on the strategic plan: Read in the header, page-1 text in the preview, Files shows one file.

---

## P5-71 [CHORE] The checklist ticks on actions ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** none

### Today
`matchFirstRunStep` (`src/lib/firstRun.ts:113`) ticks on routes: "Drop a link or upload a file" ticks the moment its own link (`/library?drop=link`) is followed; "Open a document in the app" links to `/library`, which matches nothing, and only ticks via `?view=`; uploads never tick (`upload=` is emitted nowhere); "Open a dataset's table" ticks on opening the tab.

### Design
- `completeFirstRunStep(id)` — an exported, idempotent, persisted call the surfaces use when the thing actually happened: a link dropped or a file uploaded (`add`), the viewer opened (`read`), a filter/sort/summary applied on a table (`data`), a layer toggled on the map or shown via a link (`map`), a question asked (`ask`), the Start-here page read (`start`, still a visit).
- Route matching stays only for `start` and `ask`; `add`, `read`, `data`, `map` tick from the action calls. The step copy says what ticks ("Drop a link or upload a file — it ticks when the drop lands").
- Tests: each action call ticks once, route visits no longer tick `add`/`read`/`data`/`map`, persistence, and the copy.


### Implementation notes (2026-09-07)
- `completeFirstRunStep(id)` in `src/lib/firstRun.ts` (idempotent, persisted); route matching keeps `start` and `ask` only. Callers: a landed link drop or upload (`add`, LibraryView), the viewer opening (`read`, LibraryEntryView), a filter/sort/summary/group-by on a table (`data`, DatasetView), a layer going on by checkbox or link (`map`, one watch on the active-layer count in Map.vue, not immediate, so the default layer never ticks it). Step hints say what ticks ("it ticks when the drop or the upload lands"). Live: the checklist copy renders.

---

## P5-72 [CHORE] Session expiry and friendly errors ✅ DONE

**Type:** Chore · **Priority:** P1 · **Size:** S · **Dependencies:** none

### Today
`internalFetch` (`src/lib/apiBase.ts:39`) has no 401 handling; a session that expires mid-page surfaces as raw "Unauthorized" on library and wiki views, and only a navigation bounces to login. About 25 places render `err.message` verbatim (inventory in the P5-68 pass).

### Design
- **One 401 handler** in `internalFetch`: on 401 for an internal call, clear the auth state and send the user to `/login?redirect=<current path+query>` once (no loops); the login page's redirect brings them back. Public calls untouched.
- **`friendlyError(err, fallback)`** in `src/lib/errors.ts`: keeps server-provided sentences (they are written for users), maps network failures to "No connection — check your network and try again.", and everything else to the caller's fallback; internal views use it instead of `err.message`. Expected, worded refusals (e.g. place-fetch messages) pass through unchanged.
- Tests: the handler redirects once and not on public calls; the helper's three branches; a sample of views render the fallback.


### Implementation notes (2026-09-07)
- `internalFetch` calls `handleExpiredSession` on a 401 — skipping `/api/me`, `/api/login`, `/api/logout` and the login page, firing once and re-arming on the next OK — and the router registers the handler as `clearInternalSession()` + `replace('/login?redirect=…')`. `friendlyError(err, fallback)` in `src/lib/errors.ts`: network failures → "No connection — check your network and try again."; a sentence written for people passes through; a machine string (one token, a trailing `(500)`, an HTTP status phrase such as `not found`) → the fallback. Applied in every internal view and component (the lead folded LibraryView, LibraryEntryView, CompareView, AccountView and IngestPanel after the agents); the `WikiConflictError` message is ours and stays verbatim. Tests updated where they pinned machine strings.

---

## P5-73 [CHORE] Vocabulary leftovers, round two ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** none

| Today | Becomes | Where |
|---|---|---|
| "No catalog entry named …" | "Nothing in the library is called …" | `LibraryEntryView.vue:541` |
| "Search title or slug…" / `aria-label="Search catalog"` | "Search titles…" / "Search the library" | `LibraryView.vue:702-703` |
| "Upload now, catalog later" / "uploads need cataloging" / "dropped — needs cataloging" | "Upload now, file later" / "uploads to file" / "dropped — to file" | `LibraryView.vue:614,632,291` |
| "the catalog did not load" / "…push a dataset and press Reindex" | "the library did not load" / admin-only sentence | `KnowledgeBaseView.vue:93`, `LibraryView.vue:745` |
| "← Wiki" | "← Pages" | `WikiPageView.vue:184` |
| "Open in explorer →" | "Open the table →" | `wikiEmbeds.ts:286` |
| "a dev can pull it in with `npm run library -- fetch <slug>`" | shown to admins only | `LibraryEntryView.vue:635` |
| Wiki page title rendered twice | the body's leading H1 is dropped when it equals the title | `WikiPageView.vue` |
| Account page under "U.S. Livability Index" | "BLO Knowledge base" | `App.vue` `inKnowledgeBase` |

- Tests pin each string; the logged-out header snapshot stays green.


### Implementation notes (2026-09-07)
- Every row applied, plus the help recipes that quoted the old strings ("Search title or slug…", "dropped — needs cataloging") and the Cypress expectation. The wiki page drops its body's leading H1 only when it equals the page title. `/account` carries the knowledge-base title; the logged-out header snapshot is unchanged.

---

## P5-74 [FEATURE] The map for people who are logged in: Save view in the panel, a loading screen that does not block, contamination layers on demand ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** none · **Nick 2026-09-07:** "i like the lazy loading idea" — explicit go-ahead for a public-map behaviour change

### Today
`.save-view-control` (`Map.vue:4195`, left 10 / bottom 40) sits on top of the Lens panel (`Lens.vue:238`, left 16 / bottom 16). The loading overlay intercepts every click until `loadedLayersCount === totalLayers` (`Map.vue:1774`), and the total counts the five contamination GeoJSONs (24 MB, `layerConfig.ts:111-145`) fetched and parsed up front — 38 s in Nick's Chrome — for every visitor, whether or not they ever toggle them. "Show on map" links turn a layer on but never move the map unless the URL carries `fit`/`focus` (`mapDeepLinks.ts:80`).

### Design
- **Save view lives in the Lens panel** as a row under the tabs (internal users only; the panel is byte-identical when logged out — extend the header snapshot test to the panel). The map's standalone control is removed.
- **The loading overlay never blocks**: `pointer-events: none` on the overlay, and it reports only the county data ("Loading counties…"); it is gone as soon as the choropleth can paint. Visually identical otherwise.
- **Contamination layers load on demand**: a contamination GeoJSON is fetched the first time its checkbox is turned on (or when a deep link names it), with a per-layer "Loading…" state on the checkbox row and an error state ("Could not load — try again") that lets the user retry; once loaded it stays. The initial paint of the public map is unchanged; a logged-out visitor with no contamination layer on downloads 24 MB less. Any code that assumed those sources exist at load (legend, popups, query tools, the chat's layer tools) must wait for the load.
- **"Show on map" moves the map** for internal point layers: the deep link carries `fit` from the layer's bounds (computed from the loaded GeoJSON on the client) so a Memphis layer opens on Memphis; county layers keep the national view.
- Tests: panel row present only for internal users and the logged-out panel snapshot; overlay `pointer-events`; lazy fetch on toggle/deep link, loading + error + retry states, no fetch at startup; `fit` in the entry's Show-on-map link. Cypress smoke stays green; live check the initial paint and toggling a contamination layer.


### Implementation notes (2026-09-07)
- **Save view** is a row under the Lens tabs (`actions` prop + slot; the standalone control is gone); a new Lens spec pins the logged-out panel byte-for-byte. **The overlay** has `pointer-events: none`, reads "Loading counties…", and clears the instant the choropleth is added (`COUNTY_LOAD_STEPS = 2`). **Contamination layers** are fetched on first toggle, deep link (`?layers=superfund_sites`) or chat `show_layer`, through one `showContaminationLayer` that de-dupes concurrent asks and waits for the style; the row shows *Loading…* (checkbox checked and disabled) then, on failure, goes back off with a **Could not load — try again** button; a style remount re-shows what was on. The load state machine lives in `src/config/layerConfig.ts` behind an injectable host so it is unit-tested without Mapbox. Audit: every choropleth/legend/tooltip/ranking reader uses the small per-county counts JSON, not the GeoJSONs, so nothing waited on them. **"Show on map"** for a point layer frames the layer from its own extent on the client; `?fit=bbox:…` and `mapUrlForLayerBounds()` make it instant and shareable, and are ready for the entry, layers-index, search and embed links (follow-up, listed by the agent; the fallback already frames correctly one animation later). Saved views cannot name a contamination site layer yet (view state only stores scoring layers) — follow-up if wanted.
- Live in Nick's Chrome: the Layers tab was clickable 2.5 s after load while "Loading counties…" still showed; no contamination GeoJSON was requested at startup (before: five files, 24 MB). Cypress smoke and internal suites green.
- Found in the live check and fixed by the lead: a layer toggled while the counties were still loading hit `waitForStyle`'s 15 s clock and showed "Could not load — try again" for a file that had downloaded fine. The wait now holds for the county work first (ceiling 120 s, the page already says "Loading counties…") and only then starts the 15 s clock; live, Superfund toggled at 3 s stayed "Loading…" through the county load and came on at 35 s, no error.

---

## P5-75 [CHORE] Say why the model is unavailable ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** none

### Today
`assistantCall.ts:160` knows the reason (no key or refused key, rate limit, model error, empty body) and only `console.warn`s it; the user sees "The answering service is having trouble" or the model-less fallback. With the account out of credit, an admin cannot tell that from an outage.

### Design
- The server returns `503 { error: <user sentence>, reason: <code> }` from Ask, the filing suggestion and the page-reading pass when the model call fails for a configuration reason (`no-key`, `refused`, `rate-limited`, `model-error`); `reason` is included only for admins (the route knows the role).
- The client maps the reason for admins: "The answering model is not configured on the server." / "The model refused the key — check billing or the key." / "The model is rate-limiting us — try again in a minute." Members keep the generic sentence.
- Tests: the route's admin/member shapes, the client mapping.


### Implementation notes (2026-09-07)
- `AssistantFailureCode = 'no-key' | 'refused' | 'rate-limited' | 'model-error'`, mapped in one place in `assistantCall.ts` (`failureReason` now distinguishes a missing key from a refused one). Ask answers `503 { error }` for members and `503 { error, reason }` for admins (`AskModelError` keeps a model outage apart from a retrieval bug, which stays 502); the filing suggestion records `meta.suggested.reason`; the page-reading pass records `inspection.pruneErrorCode` (carried through `linkInspect` and validated on read-back). Client: `askErrorMessage(err, { isAdmin })` with the four admin sentences; the ingest panel shows the sentence to admins next to the plain reason (lead). The lead added the case that is live today: an exhausted credit balance comes back as a 400 `invalid_request_error`, not an auth status — it now maps to `refused`, and the Ask page for an admin reads "The model refused the key — check billing or the key." (verified against the real account). `DEPLOY.md` notes that admins see the reason.

---

## P5-76 [FEATURE] Change your own password ✅ DONE

**Type:** Feature · **Priority:** P2 · **Size:** S · **Dependencies:** none

### Today
Passwords are set only by the admin CLI (`npm run users`). The account page offers role, log out, API tokens and connected apps; no password change, so "I forgot mine" means asking Nick.

### Design
- `POST /api/account/password` `{ current, next }`: requires the session, verifies `current` with the same hash the login uses, enforces the login's minimum length, rate-limited per user, writes an audit row, and **revokes every other session** for the user (the current one stays); CSRF like every internal write.
- Account page: a "Change password" block (current, new, confirm) with the same error copy style as login; success says other sessions were signed out.
- Tests: wrong current → 400 with a sentence, short next → 400, success revokes other sessions and audits, the form's states.


### Implementation notes (2026-09-07)
- `POST /api/account/password` (`server/src/routes/account.ts`): session + CSRF, the shared limiter plus 5/hour per user, `verifyPassword` against the stored hash (hashing/verifying now live in `server/src/services/passwords.ts`, used by the CLI and — folded by the lead — the login route), minimum 8 / maximum 256 characters, next ≠ current, audit `account.password` (a wrong current password audits `account.password.failure`), and `revokeOtherSessions()` keeps only the current session; `200 { ok, signedOutOthers }`. Account page: a Change password card with current/new/confirm and proper autocomplete hints; success says other sessions were signed out when any were. API tokens and OAuth grants are deliberately untouched (they have their own revoke controls). Added to the inverted auth sweep. Live: the card renders under the knowledge-base title; a wrong current password answers 400 with its sentence.

---

## P5-77 [CHORE] "Show on map" carries the layer's frame from every surface ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** S · **Dependencies:** P5-74 · **Nick 2026-09-07:** "let's take those follow ups on"

### Today
P5-74 taught the map to frame a point layer from its own extent and added `?fit=bbox:…` plus `mapUrlForLayerBounds()`, but every "Show on map" link still calls `mapUrlForLayers([id])` with no frame (`LibraryEntryView.vue` ×2, `LayersIndexView.vue` internal rows, `GlobalSearch.vue` ×4, `wikiEmbeds.ts`, `LayerAboutView.vue`), so the map opens on the national view and animates to Memphis a beat later. The server already computes a `bbox` for the points payload (`internalLayers.ts:100`) but not on the manifest entry the surfaces read.

### Design
- **The manifest carries the frame.** `GET /api/layers/internal` includes `bbox: [minLng, minLat, maxLng, maxLat] | null` on every point-layer entry, computed at index time from the same rows the points payload uses (one pass, cached with the manifest; null when no row has coordinates). Client `InternalLayerManifestEntry.bbox` mirrors it.
- **One helper, used everywhere.** `mapHrefForInternalLayer(entry)` in `src/lib/internalLayers.ts` returns `mapUrlForLayerBounds(id, bbox)` for a point layer with a bbox and `mapUrlForLayers([id])` otherwise; every surface listed above uses it (county layers and public layers keep the plain link). `?focus=` links are unchanged.
- Tests: the manifest's bbox (with and without coordinates), the helper's two branches, and one assertion per surface that the href contains `fit=bbox:`.


### Implementation notes (2026-09-07)
- The manifest (`GET /api/layers/internal`) carries `bbox` on every point layer, computed at manifest-build time from the same rows as the points payload (`toCoordinate` / `boundsOf` / `pointLayerBounds` extracted so the arithmetic lives once), cached per dataset revision (`updatedAt|bytes|file|latKey|lngKey`), null when no row has coordinates or the file will not read. `mapHrefForInternalLayer(entry)` and, for surfaces that hold only an id, `mapHrefForInternalLayerId(id)` (session-cached manifest, evicted on failure and on logout) are used by the entry page (plain link from first paint, framed once the manifest answers), the layers index, ⌘K (point-layer rows and the dataset row), and the wiki embed card. County and public layers keep the plain link. Live: the three point layers carry `fit=bbox:` on `/layers` and the Organizations entry.

---

## P5-78 [FEATURE] Saved map views remember contamination layers ✅ DONE

**Type:** Feature · **Priority:** P2 · **Size:** S · **Dependencies:** P5-74

### Today
A map view's `state.layers` comes from the scoring query and `pointLayers` from the internal point layers; the five contamination site layers (`superfund_sites`, `acres_brownfields`, `air_pollution_sources`, `hazardous_waste_sites`, `toxic_release_inventory`) are overlays that no view can name, so a saved view of "Superfund sites over the equity index" comes back without the sites.

### Design
- `siteLayers?: string[]` on the map-view state (`src/lib/views.ts`, the server's view validation): the ids of the contamination layers that were on when the view was saved; validated against the known ids on both sides, unknown ids dropped with a warning, absent = none.
- Saving reads the visible contamination layers; restoring (`?view=` and the in-app restore) turns each on through the P5-74 on-demand path, so the file loads then and not before. The view's description line and the entry page's view branch name them ("Superfund sites" etc., from `layerConfig`).
- Tests: state round-trip with and without `siteLayers`, server validation (unknown id dropped), restore turns the layers on, description names them.


### Implementation notes (2026-09-07)
- The five site layers moved to `src/config/siteLayers.ts` as plain data (`CONTAMINATION_LAYERS` is a view over it) so `npm run export:layers` can hand the server `siteLayers.generated.json` for validation and labels — the same generated-not-copied rule as the layer registry and the taxonomy. `SavedViewState.siteLayers?: string[]` (client `readSiteLayers`, server `normaliseMapState`: unknown ids dropped with one warning, absent = none, older documents stored byte-for-byte; the MCP `save_view` tool refuses an unknown id instead). Save writes the visible site layers (omitted when none); restore is exact (`siteLayerRestore` → on/off) and runs after the query, point layers and viewport so a 24 MB file never delays the jump; the description names them ("Map view · Superfund Sites") and `meta.layers` carries the ids so "which views use this layer" works. Lead: the entry page names site layers (`siteLayerName` fallback), hides the raw meta list and the Data tab for a view, and the embed card gains a "Site layers:" line.
- Live round trip in Nick's Chrome: Superfund on → Save view → document holds `siteLayers: ["superfund_sites"]`, description "Map view · Superfund Sites" → Superfund off → open `/views/<slug>` → the layer comes back on and its file is requested once. Both probe views deleted from the bucket afterwards (`server/library-local/delete-keys.mts`).

---

## P5-79 [FEATURE] A deterministic floor for every dropped link ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P5-61 · **Nick 2026-09-10:** "Let's do it. I don't really follow but we'll review it in post"

### Today
A dropped page lands titled by its hostname with no description, because every enrichment (title, summary, category, tags) is the model's job and the account has no credit. The inspector already parses the page `<title>`, meta description and `og:site_name` (`linkInspect.ts:1810-1813`) and throws them away. Live: `http://www.engaginglandowners.org/` became an entry called `www.engaginglandowners.org` with nothing else.

### Design
- `inspection.page = { title, description, provider, insecure }` is stored for every `page`/`portal` inspection (title cleaned, a trailing " | Site name" or " - Site name" dropped when it repeats the provider; description from the meta tag, else the first ~300 characters of the page's main text; `insecure` when the page itself is http).
- **Applied to the entry at the end of the fetch, never over a person's words:** if the entry title is still the URL-derived default, it becomes the page title (≤120 chars); if `meta.description` is empty, it becomes the description. A filename drop keeps its filename title. The catalog reindexes so ⌘K and Ask see the words at once.
- The model passes are unchanged and still improve on the floor; the suggestion's own title/summary remain a suggestion.
- Tests: title/description/provider extraction (with and without the site suffix), the never-overwrite rule, a page with no title, the reindex.


### Implementation notes (2026-09-10)
- `inspection.page = { title, description, provider, insecure }` on every page/portal inspection (`readPageBlock`, validated on read-back, caps 120/300). The title drops a trailing site-name suffix only when provable — it equals the provider, the host, or words the head already carries ("TELE - Tools for X | Tools for X"); the description comes from the meta tag, else the page's opening words with the `<head>`, nav/header/footer, forms and skip-links removed and a repeated title skipped (lead's fixes after the live run). The queue applies title and description to the entry only while the title is still the URL-derived default and the description is empty — compared, not flagged, so a person's words can never be replaced — then clears the index. Also fixed: `metaContent` truncated attribute values at an apostrophe.
- Live (no model credit): the TELE home page landed as "TELE - Tools for Engaging Landowners Effectively" with the site's own description instead of `www.engaginglandowners.org` and nothing.

---

## P5-80 [FEATURE] Documents on a page, pulled in as one collection ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** M · **Dependencies:** P5-79

### Today
The harvester keeps a PDF only when its link text says "download" (`linkHarvest.ts:311-316`); thirty landowner profiles labelled by content are invisible, and the only way in is thirty separate drops.

### Design
- `harvestLinks` returns a second list, `documents`: same-site links (same registrable domain) whose URL ends in `.pdf`, `.docx`, `.doc`, `.rtf`, `.pptx`, `.xlsx`, `.xls`, deduped, ≤30, each with label and context; stored as `inspection.documents`. Data candidates are unchanged.
- **Pull-in is a person's choice, bounded, and free of model calls.** `POST /api/library/catalog/:slug/documents { urls }`: the urls must be a subset of `inspection.documents` (nothing arbitrary), ≤30 per call, each fetched through the host guard under the upload size cap, stored under the entry as files named from the link label (slug + extension, made unique), text extracted locally, one audit row, per-file status in the response (`stored` / `too large` / `unreachable`). No suggestion runs for pulled files; they inherit the entry's filing. Total per call ≤100 MB.
- Entry page (IngestPanel): "Documents on this page · N" with checkboxes, Select all, **Pull in selected**, per-file results, and the files then appear in the Files tab and the viewer.
- Tests: document harvest by shape and site, the cap, the subset rule, size and host failures recorded per file, naming uniqueness, extraction ran, the panel's list and action.


### Implementation notes (2026-09-10)
- `harvestLinks` returns `documents` (same registrable domain, `.pdf .docx .doc .rtf .pptx .xlsx .xls` by URL shape, ≤30, label + context); stored as `inspection.documents`, kept even when the page has no data candidates. `POST /api/library/catalog/:slug/documents { urls }` (`documentPull.ts`): session + CSRF, incoming/document only, every url must be in the stored list (400 naming the first stranger, nothing fetched), ≤30 and ≤100 MB (`LIBRARY_PULL_MAX_BYTES` for tests), host-guarded fetch under the upload cap, an HTML answer is `not-a-document`, files named from the label and made unique, text extracted locally, one audit row `entry.pull-documents`, no model call. IngestPanel: "Documents on this page · N", checkboxes (none ticked), Select all/none, Pull in selected, per-file results. MCP `pull_documents` deferred.
- Live: 25 profile PDFs listed on the TELE profiles page; three pulled and extracted (3 of 3); the entry's verdict moved from page to collection.

---

## P5-81 [CHORE] Follow the page's own scheme ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** P5-80 (same file)

### Today
`candidateUrl` keeps https only (`linkHarvest.ts:114`), so on an http page every relative link resolves to http and is dropped — zero candidates before any model sees the page. The rule was written for agencies serving data over http; it also erases every link on a site whose certificate merely expired.

### Design
- When the page itself is http, same-site links over http are kept and the inspection carries `page.insecure = true`; links to other hosts still require https. An https page keeps the https-only rule.
- The readiness line (P5-82) says "Served over http" for such entries.
- Tests: http page keeps same-site http links, drops off-site http, https page unchanged.


### Implementation notes (2026-09-10)
- `candidateUrl` keeps same-site http links when the page itself is http (`Harvest.insecure`, stored as `page.insecure`); off-site links still need https; an https page is unchanged. Lead's addition after the live run: the site's own https document links failed (expired certificate), so `documentPull` retries a same-site https document over http when the page is insecure and the failure was a network one — never for a page served properly over https — and records `via: 'http'` on the result and the manifest. Tested both ways.

---

## P5-82 [FEATURE] A readiness verdict on every entry ✅ DONE

**Type:** Feature · **Priority:** P1 · **Size:** S · **Dependencies:** P5-79, P5-80

### Today
Nothing tells a person what a dropped thing is ready as. "Is it ready for ingestion, will it be useful" has to be answered by reading the manifest.

### Design
- `readinessOf(entry)` — a pure server function, computed when rows are read (not stored), exposed as `readiness` on catalog rows, `get_entry` and `inspect_link` over MCP:
  - `as`: `dataset` (held table) · `source` (registered pointer) · `collection` (document/incoming with ≥3 readable files) · `document` (≥1 readable file) · `page` (a web page we read, no files) · `link` (nothing read yet / unreachable).
  - `placeReport`: `runs` (a source with a non-manual access entry and a place query that fits) · `by-hand` (manual or WFS access only) · `never` (no endpoint at all, or not a source) · `candidate` (a page whose inspection found an ArcGIS/Socrata/file endpoint — could be registered as a source that runs).
  - `notes`: short reasons — "N documents on the page can be pulled in", "served over http", "text extracted from 3 of 30 files", "no endpoint to query".
- Entry page: one line under the title, e.g. **Ready as: a document collection · Place report: never (no endpoint) · served over http**. The drop form, when "This is a data source" is ticked for a plain page, says under the button: "This registers a pointer. It cannot run in a place report until it has an endpoint."
- Tests: one case per `as` and per `placeReport` value, the notes, the row field, the MCP shapes, the entry line, the form hint.


### Implementation notes (2026-09-10)
- `readinessOf(row)` in `server/src/services/readiness.ts`, attached to every row read (`withUpdatedAt`) and never stored; on MCP `get_entry` and `inspect_link`. `as`: source → dataset (held table) → collection (≥3 readable files) → document (≥1) → document for note/wiki/view → page → link. `placeReport`: `runs` when an adapter-runnable access entry exists, `by-hand` for manual/WFS only, `never` with no endpoint; non-sources `candidate` when the inspection found an ArcGIS/Socrata/file endpoint. Notes: not read yet · could not be reached · text extracted from N of M files · N documents on the page can be pulled in · served over http · no endpoint to query · answers a point, not a whole county. `fitsPlace` now lives here and `placeFetch`'s `pickAccess` uses the same `runnableAccess`/`isByHandOnly` — one rule. Entry line under the title for dataset/document/incoming/source; the drop form warns under Register source when the URL is a plain page.
- Live: the TELE profiles entry reads "page · never · 25 documents on the page can be pulled in · served over http", then "collection · never · text extracted from 3 of 3 files …" after the pull.

### Addendum (2026-09-15) — "Check a place never returns"
- Nick's demo rehearsal: the page said "Checking 40 sources…" for the whole run and appeared hung. The API had answered both of his runs (200 in 49 s and 38 s); the page gave no sign of life for close to a minute, the Run button stayed enabled, and a second press restarted the run and discarded the first answer — so a natural retry made it look endless. Fixed: Run and Run again are disabled while a report is in flight; the progress line carries a moving clock and, after ten seconds, says why it is slow; the count is the sources a report can run or list by hand (25), from the rows' readiness, not every registered source (40). Server: six sources in flight instead of three (each is a different agency), and the report's cap raised from 25 to 50 sources — at 25 it silently never looked at 15 of the 40. Making the count honest exposed that the readiness verdict called 38 sources runnable while the report attempted 10: the two adapters refuse before the network when a REST URL carries no `{lat}`/`{geoid}`/`{bbox}` placeholder or a download is not a CSV/GeoJSON. That static half now lives in `readiness.ts` (`cannotAnswerPlace`) and the report's candidate pass uses it to list those sources by hand up front, so verdict, sections and count agree (20 run · 20 by hand; the report: 18 attempted, 22 by hand — the residual two refuse only after reading the file). A fresh Atlanta report on the laptop now runs all 40 in 42 s: 11 found, 4 nothing, 3 failed, 22 by hand.

---

## P5-83 [CHORE] Say what was not done when the model is out ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** P5-75

### Today
When the model pass fails, `meta.suggested = { error: 'unavailable', reason }` is written and the entry shows an empty summary. Nobody can tell "read, but not summarised" from "never read".

### Design
- The entry page's status line says **Read on <date>. No model pass — <reason>.** — the admin sentence for admins ("the model refused the key — check billing"), "the model was unavailable" for members — with **Look again** re-running the pass; the To file queue row and the landing's attention row say "no summary yet" for such entries.
- Tests: the line for admins and members, the queue row, and that a successful pass removes it.


### Implementation notes (2026-09-10)
- The entry page shows "Read on <date>. No model pass — <sentence>." (admin sentence from P5-75's map, "the model was unavailable" for members) with **Look again** re-queueing the fetch for incoming links; `attention=no-summary` on the server (`isReadWithNoSummary`) backs the landing row "Read, but no summary yet" and the list's "no summary yet" on rows, so the count and the list are the same set.

---

## P5-84 [CHORE] TELE in the library ✅ DONE

**Type:** Chore · **Priority:** P1 · **Size:** S · **Dependencies:** P5-80 · **Nick 2026-09-11:** "definitely want to add TELE to the library"

### Design
- Through the reviewed content path (the push tree), not the app's drop: `documents/tele-engagement-guide/` (the Engagement Guide and the Yale workbook; category `outreach`, tags `land`, `landowners`, `outreach`, `engagement`) and one collection per geography, `documents/tele-landowner-profiles-<us|georgia|alabama|mississippi|north-carolina|south-carolina|tennessee>/` (every profile PDF the state page offers, named `<geography>-<segment>.pdf`; category `outreach`, tags `land`, `landowners`, `nwos`, `demographic`, the state). Descriptions from the site; `lineage.from` = the page URL, with the note that the site is served over http with an expired certificate (pulled 2026-09-11) and that the profiles derive from the National Woodland Owner Survey (TELE, Yale School of the Environment / UMass Amherst).
- Cross-links: a paragraph on `field-expedition.md` (outreach method) and `evidence-base.md` (what NWOS says about landowners) linking the guide and the Georgia profiles, so the entries have backlinks and Ask cites them from the pages.
- Verify after push + reindex: each entry's verdict reads collection (or document), text extracted from N of N, ⌘K finds "Georgia landowner profiles", the Mentions tab shows the two pages.


### Implementation notes (2026-09-11)
- Eight document entries in the push tree, pulled over http on 2026-09-11 (88 files, 17.3 MB): `tele-engagement-guide` (the Engagement Guide, 6.5 MB, and the Yale workbook, 3.3 MB) and `tele-landowner-profiles-{us,georgia,alabama,mississippi,north-carolina,south-carolina,tennessee}` (25 · 14 · 10 · 10 · 10 · 12 · 5 profiles, named `<geography>-<segment>.pdf`, each manifest's `lineage.files` recording label and source URL). Category `outreach`, tags `land landowners nwos demographic outreach` (+ the state), so they file under Land with purpose Outreach. Cross-linked from `field-expedition.md` ("Approaching landowners: the TELE method") and `evidence-base.md` ("What the National Woodland Owner Survey says about landowners"). Pushed (98 objects) and reindexed: 83 entries; every entry's verdict reads "a document collection · text extracted from N of N files" (the guide: "a document"); the viewer opens a profile; ⌘K finds them.
- Two bugs found by the content and fixed by the lead: (1) `extractWikiMentions` let one link swallow the next on the same line (a `)` inside the optional tail), so Georgia had no backlinks — fixed with a test; (2) a two-word search ("Georgia landowner") found nothing because the catalog matched the phrase in one field — every word is now matched across fields, with a test.

---

## P5-85 [CHORE] Documents over MCP: held copies only ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** P5-80 · **Nick 2026-09-11:** "docs over MCP, i think we want to enable if we already have a copy available in our data library (b2) - if it requires fresh pulls from the source URL then we don't want to"

### Design
- MCP never fetches a document from a source URL. `get_entry` gains `documents: { held: [{ file, bytes, readable }], offered: N, note }` where `held` are the entry's own files in the bucket (manifests excluded) and `offered` counts `inspection.documents` not yet held, with the note "pulling documents in is done in the app"; `read_document` stays as it is (held files only). No `pull_documents` tool. `docs/MCP.md` states the rule.
- Tests: held/offered shapes, a manifest never listed, an entry with nothing offered.


### Implementation notes (2026-09-11)
- `get_entry` returns `documents: { held: [{ file, bytes, readable }], offered, note }` — held = the entry's own files (manifests excluded, `readable` by the extractor), `offered` = documents the inspection found that are not yet held (matched by the pull record's source URL or by the name a pull would give), note "Pulling documents in is done in the app; MCP reads only what the library already holds." `read_document` unchanged; no `pull_documents` tool; the rule is stated in `docs/MCP.md`. Four tests.

---

## P5-86 [BUG] The app shell mounts the map while a route chunk loads ✅ DONE

**Type:** Bug · **Priority:** P0 · **Size:** XS · **Dependencies:** none · **Nick 2026-09-11:** "any optimizations we can do for snappy page loads?"

### Today
`App.vue` renders `<component :is="Component || MapComponent" />`. While a lazy route's chunk is loading, `Component` is undefined, so the map mounts, its `onMounted` starts all thirteen county downloads (10 MB decoded), then the route arrives and the map unmounts — the downloads continue. Measured: every internal page, and the login page, pulls 10.3 MB of county data it never uses.

### Design
- No fallback: while a chunk loads, render nothing (the header stays). The map renders only through the `/` route's `HomeView`. `HomeView` stays statically imported so the public map's first paint gains no extra round trip; internal pages still download the mapbox chunk once (cached thereafter) — accepted trade-off, noted here.
- Tests: the shell renders no map on a non-map route while the chunk is pending and after; the public map still mounts on `/`.


### Implementation notes (2026-09-11)
- `App.vue` renders the route component only when it exists; the `Map.vue` import is gone from the shell, `HomeView` stays static. Measured on the production build: `/kb`, `/library`, an entry and `/layers` went from 16 dataset requests (10.3 MB) to none; requests per page 37 → 20, 37 → 18, 39 → 21, 34 → 16; first paint on `/kb` 772 → 476 ms. The login page no longer downloads the map's data either.

---

## P5-87 [FEATURE] The public map loads in parallel and paints before its data ✅ DONE

**Type:** Feature · **Priority:** P0 · **Size:** M · **Dependencies:** none

### Today
`loadAllCountyData()` awaits thirteen fetches one after another, then the county-name file, and only then constructs the Mapbox map — tiles and style start last. `preCalculateColors` writes ~3,200 counties × 8 colours into a reactive ref and spreads whole arrays into `Math.max`. Counties reach the screen at 6.6 s locally and 25–38 s on Nick's Chrome.

### Design
- Create the Mapbox map first; fetch every data file in parallel (`Promise.all`); add the county source and choropleth as soon as the geometry and the first score file are in; apply the rest as they land. The county-name lookup is not on the critical path. The loading indicator counts files, not steps.
- Colours precomputed into a plain `Map` (not reactive), with loops instead of spreads; no behaviour change.
- The one score file the map actually uses stays; the other is dropped (`combined_scores.json` vs `combined_scores_v2.json` — verify usage before removing either).
- Guardrails: the public map must look the same (Cypress smoke; a before/after screenshot at the default view and at a state zoom, diffed by the lead); deep links, saved views, chat tools and the contamination on-demand path keep working.
- Measure before and after with the same script and record the numbers.


### Implementation notes (2026-09-11)
- `onMounted` issues both county fetches and the county-name lookup without awaiting and constructs the Mapbox map in the same tick; the `load` handler waits for the style, then for the county data, and adds source, choropleth, outlines, tooltip and deep-link replays. Colours are precomputed into a non-reactive structure as soon as the data file lands. A failed fetch leaves a working basemap. The overlay counts files (2). Only `combined_scores_v2.json` was ever read at runtime; the v1 file's two reachable fields ride in the built file so colours and the county modal are bit-identical, and its 1.4 MB fetch is gone. Follow-up: delete the v1 plumbing (`mapTypes.ts`, `CountyModal.vue`).
- Measured (production build, local): counties on screen 6.6 s → 3.2 s; dataset requests 31 → 4; decoded 20.2 MB → 6.9 MB; transfer 4.2 MB → 3.5 MB; requests 52 → 30. Screenshot diff of the loading rewrite alone: 0.0% of pixels at the national view. Cypress smoke green.

---

## P5-88 [CHORE] The API compresses, caches, and sends list rows that fit the list ✅ DONE

**Type:** Chore · **Priority:** P1 · **Size:** S · **Dependencies:** none

### Today
No compression middleware, no `Cache-Control` or ETag anywhere; the catalog list response is 214 KB raw (50 KB gzipped) and carries every entry's full manifest — inspection results, link lists, source blocks (91 KB) — that no list reads. `GET /api/library/kb` reads a file from the bucket on every call (1.1 s on the landing). `getCatalogEntry` runs an archived-table scan per request.

### Design
- `compression` on every JSON response; `Cache-Control: private, no-cache` + ETag on catalog, entry, layers manifest and kb config so unchanged answers are 304s.
- The list endpoint returns **list rows**: everything the list, the landing tiles, ⌘K, the attention rows and the filters read (title, kind, category, status, tags, description, updatedAt, bytes, file count, readiness, and the small meta fields the client predicates use — audit `src/lib/kb.ts`, `LibraryView.vue`, `GlobalSearch.vue` and keep exactly those, e.g. `source.provider`, `source.lastError`, `fetch.status`, `suggested.error/reason`, `inspection.kind`, `layer`, `supersededBy`, `mentionedBy` count). The entry endpoint keeps the full manifest. A `?full=1` escape hatch for the CLI/MCP if anything needs it.
- `getKbConfig` cached in memory, invalidated by the reindex hook; the archived scan in `getCatalogEntry` cached per index generation.
- Tests: compression header, ETag/304 round trip, the list row shape (and that the predicates' fields survive), the config cache invalidation.


### Implementation notes (2026-09-11)
- `compression` (JSON only, threshold 1 KB), weak ETags set explicitly, `Cache-Control: private, no-cache` on the catalog list, the entry, the layers manifest and the kb config (304 on `If-None-Match`). The list endpoint returns a projection (`listRowMeta`, `LIST_ROW_META_KEYS`): the row columns plus `description, url, layer, supersededBy, type, layers, savedBy, savedAt, source{provider,lastError}, fetch{status,at}, suggested, inspection{kind,checkedAt}, ingest{plan,done}`; the entry keeps the full manifest; `?full=1` for callers that need it; `searchCatalog` (used by place reports, the KB index, views) is not projected. Readiness is computed from the full manifest before the cut. The client predicates were copied into a server test and asserted equal on full vs projected rows. The kb config and the archived-row index are cached per catalog generation (bumped by every row insert). Measured on the real catalog: 212.6 KB / 48.4 KB gz → 63.7 KB / 12.1 KB gz; `/api/library/kb` 1,068 → 268 ms.

---

## P5-89 [CHORE] One client-side catalog cache, no duplicate fetches ✅ DONE

**Type:** Chore · **Priority:** P1 · **Size:** S · **Dependencies:** P5-88 (row shape)

### Today
Every view refetches: the library page fetches the catalog twice on mount (`load()` + `loadAll()`), the layers page fetches the manifest twice, the entry page fetches a catalog query to list views for one layer, and in-app navigation refetches everything (424 ms `/kb` → `/library` locally with two catalog calls).

### Design
- A module-level cache in `src/lib/libraryCatalog.ts`: promise-deduped per query key, stale-while-revalidate (serve the last answer at once, refresh in the background, update reactively), invalidated by writes (drop, upload, file, save view, reindex, pull-in, password? no) and on logout (`clearInternalSession`). The internal-layer manifest already has one; dedupe its callers.
- The library page derives its facet counts from one fetch; the landing and the list share it; the entry page's "views using this layer" comes from the cached list filtered client-side.
- Tests: dedupe of concurrent calls, SWR refresh, invalidation on each write, logout clears.


### Implementation notes (2026-09-11)
- `readThrough(key, load, onFresh?)` in `src/lib/libraryCatalog.ts`: promise-deduped, stale-while-revalidate (cached answer at once, refresh in the background, `onFresh` delivers it), generation-guarded so a pre-write answer never lands after a write, LRU-bounded at 24 keys with the full catalog pinned. Invalidated after every write path (12 triggers, each tested) and on logout via the logout hook. The library page makes one request instead of two (the unfiltered list is derived from the full catalog client-side, archived split as the server does; a request ticket guards against late answers); the layers index, ⌘K, compare and the map share `sharedManifest()`; "views using this layer" reads the cached catalog. Measured: `/kb → /library` in-app 424 → 347 ms with one catalog call instead of two; `/library` first paint 380 → 184 ms.

---

## P5-90 [CHORE] One prebuilt county data file, hashed dataset names, lighter county outlines ✅ DONE

**Type:** Chore · **Priority:** P1 · **Size:** M · **Dependencies:** P5-87

### Today
Ten CSVs (2 MB) are parsed on the main thread at every map load; `counties.geojson` is 2.9 MB; dataset paths carry no hash, so Netlify caches them for a day and refetches; two overlapping score files total 4.8 MB.

### Design
- `scripts/build-datasets.mjs` (run before `vite build`, and by `npm run build`) writes `public/datasets/build/county-data.<hash>.json` — every per-county number the map uses, keyed by GEOID, from the CSVs, the contamination counts and the score file — and `counties.<hash>.geojson`, plus `src/config/datasetsManifest.generated.json` the app imports so the hashed names are baked into the bundle. Netlify: `/datasets/build/*` → `max-age=31536000, immutable`. The old per-file paths stay for the layer pages that load one layer's CSV (`LAYER_DATA_SOURCES`) unless the agent can point them at the built file cheaply.
- Geometry: `mapshaper -simplify <n>% keep-shapes` on the county outlines, written as a second candidate file; the lead diffs screenshots at the default view and a state zoom and picks the tolerance (target ≤ 1 MB, no visible change at the zooms the map uses). Nick reviews the diff.
- Tests: the build script's output shape, the manifest import, the loader reading the built file.


### Implementation notes (2026-09-11)
- `scripts/build-datasets.mjs` (`prebuild` and `predev`) writes `public/datasets/build/county-data.<hash>.json` (3.61 MB raw / 530 KB gz — every per-county number the map uses, keyed by GEOID; the contamination per-source breakdown and v2's name fields dropped as unread) and `counties.<hash>.geojson`, plus `src/config/datasetsManifest.generated.json` (committed; the bundle imports it). `netlify.toml`: `/datasets/build/*` immutable for a year. `public/datasets/build/` is gitignored and the leak check gates it against the manifest. The per-layer pages resolve the one built file through a deduped promise instead of parsing a CSV each.
- **Nick's choice (2026-09-14): coordinate rounding only.** `roundGeometry()` in the build script rounds every vertex to 4 decimals (~11 m; the map's deepest programmed zoom draws ~125 m per pixel) and is the default (`--precision 4`; `--precision none` ships the source bytes). Vertex count unchanged (62,563 across 3,220 counties); the source's median 14 decimals were 0.76 MB of digits. Shipped geometry 2.9 MB / 835 KB gz → 1.77 MB / 495 KB gz. Screenshot diff against the original: 0.002% of pixels at the national view, 0.018% at a state zoom, none strong (max delta 44/255) — antialiasing on a handful of edge pixels; a re-render of the original against itself is 0.0%.
- Geometry candidates measured earlier (the simplified ones are NOT shipped): coordinate rounding to ~11 m only → 1.8 MB / 495 KB gz, no vertex removed; `-simplify 50%` + rounding → 1.5 MB / 390 KB; `30%` → 1.4 MB / 342 KB; `15%` → 1.25 MB / 306 KB. Like-for-like screenshot diff for 15%: 0.9% of pixels at the national view and 0.9% at a state zoom, all along edges; at that zoom, boundaries that follow rivers read visibly straighter. Nick to choose; `node scripts/build-datasets.mjs --geometry <file>` wires any of them in.

---

## P5-91 [CHORE] Self-hosted fonts ✅ DONE

**Type:** Chore · **Priority:** P2 · **Size:** XS · **Dependencies:** none

### Design
- Fraunces (SIL OFL) self-hosted as one variable woff2 covering the `opsz 9..144` and `wght 400..700` axes, `font-display: swap`, a `<link rel="preload" as="font">`, the Google Fonts stylesheet and preconnects removed. Cypress smoke and the logged-out header snapshot stay green.


### Implementation notes (2026-09-11)
- One variable woff2 (99 KB; `opsz 9..144`, `wght 400..700`, latin + latin-ext, built from the upstream OFL file with SOFT/WONK pinned) in `src/assets/fonts/`, `@font-face` with `font-display: swap`, a preload in `index.html`; the Google Fonts stylesheet and preconnects are gone. Live: one font request of 97 KB, served with the app.

---

## Quality checklist (run at each step boundary)

- [ ] Public map Cypress suite green (the standing regression gate)
- [ ] 401 sweep green (auth boundary)
- [ ] Bundle-leak check green (no internal bytes shipped)
- [ ] Spec success-criteria items for the step checked off in the spec doc
