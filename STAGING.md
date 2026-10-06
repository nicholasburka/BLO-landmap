# Staging Deployment Runbook

A separate Netlify site for sharing this branch (and any future feature branches) with the project manager or other stakeholders without pushing to prod. Uses a single shared backend with a per-tier password mechanism so the staging traffic doesn't eat the prod daily-token quota.

---

## How the password tier works

Two passwords on the server, each optional:

- **`BETA_PASSWORD`** — if set, POSTs to `/api/auth` with this value return a `normal`-tier token. Subject to the daily token cap.
- **`STAGING_PASSWORD`** — if set, POSTs to `/api/auth` with this value return a `staging`-tier token. Bypasses the daily token cap. Usage is still recorded for observability.

The tier is baked into the HMAC-signed token, so a normal-tier user can't tamper their way into staging.

If `STAGING_PASSWORD` is unset (production), the upgrade path simply doesn't exist — the auth route 401s on any password that isn't `BETA_PASSWORD`.

On the client, the **Staging access** pill in the bottom-right corner only renders when the build env `VITE_STAGING_GATE_ENABLED=true`. On prod the pill is absent at compile time.

---

## One-time setup

### Server (whichever host you deploy the Express app to — Railway / Render / Fly / etc.)

Set these envs on the backend service:

| Env | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your Anthropic key (same one prod uses) |
| `SESSION_HMAC_SECRET` | **required** — random string ≥32 chars for token signing (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). The server refuses to boot without it. Never reuse a password here. |
| `NODE_ENV` | `production` — hardens error responses and force-disables `BUDGET_BYPASS` |
| `BETA_PASSWORD` | leave unset unless you want a normal-tier password too |
| `STAGING_PASSWORD` | a strong opaque string — this is the cap-bypass password |
| `ALLOWED_ORIGINS` | comma-separated list including BOTH the prod and staging Netlify origins, e.g. `https://blo-livability.netlify.app,https://blo-staging.netlify.app` |
| `TRUST_PROXY_HOPS` | proxy hops between client and server; default `1` (Railway/Render direct). Set `2` if a CDN fronts the host — must match reality or per-IP caps are spoofable |
| `PORT` | as required by host |

If you redeploy or add a new staging origin later, append to `ALLOWED_ORIGINS` and restart the server.

### Internal knowledge base on staging (phase 5)

The public map needs nothing beyond the table above. To light up the internal tier (login, library, Ask, MCP) on the staging backend, add these — the full reference is the env table in **DEPLOY.md**:

| Env | Value |
|---|---|
| `DATABASE_URL` | a staging Postgres (Neon/Railway/Render). Accounts, sessions, the catalog index, audit and OAuth state live here; the server verifies the DB certificate by default (`PGSSL_CA` for a private CA). Create the first admin with `npm run users -- create <name> --role admin` from `server/`. |
| `LIBRARY_BUCKET_ENDPOINT` / `_REGION` / `_NAME` / `_KEY_ID` / `_SECRET` | the B2 bucket. Staging may share prod's bucket read-only for a preview, but any bucket that people **write** to from staging should be its own (`blo-library-staging`) so test drops never land in the real library. |
| `LIBRARY_DATA_DIR` | a writable path for the mirror (ephemeral is fine — it rebuilds at boot). |
| `PUBLIC_SITE_URL` | the staging **frontend** origin — used for absolute links in MCP results, the OAuth login detour and the county-data fetch fallback. |
| `OAUTH_ISSUER` | the staging **API** origin (see the note above). |
| `LIBRARY_ASK_MODEL` / `LIBRARY_ASK_MAX_TOKENS` / `LIBRARY_SUGGEST_MAX_TOKENS` | optional; defaults are `claude-sonnet-5`, `1000`, `400`. Point the model at Haiku 4.5 to make staging cheap. |
| `EXTRACT_MAX_BYTES` / `EXTRACT_MAX_PAGES` / `PLACE_FETCH_TIMEOUT_MS` / `PLACE_FETCH_MAX_BYTES` | optional caps for document extraction and place fetches; defaults 20 MB / 400 pages / 30 s / 25 MB. |

After the first boot: log in, press **Reindex** on Data & documents (the catalog is rebuilt from the bucket), then verify the P5-19 deploy checklist in DEPLOY.md. The three things only Nick can decide before staging goes up: pushing the `phase5-auth-core` branch to GitHub (it has never been pushed), which host runs the staging API, and what happens to the old public donor site.

If this staging backend also needs to support the ChatGPT/Claude OAuth connectors (P5-51, see **docs/MCP.md**), set **`OAUTH_ISSUER`** to the public https origin of the **staging API itself** — never the frontend, and never a preview URL that changes on every deploy. It has to be the one fixed origin a connector will keep coming back to. A separate staging backend needs its own `OAUTH_ISSUER` value distinct from prod's; get the issuer wrong (or leave it pointed at a moving preview URL) and connectors either can't discover the server at all or send authorization codes to an address that no longer exists.

### Frontend — staging Netlify site

1. **Create a second Netlify site** linked to this same Git repo (`nicholasburka/BLO-landmap`).
2. **Production branch:** `ux-redesign-phase4b` (or whichever feature branch you're staging).
3. **Build settings** — already in `netlify.toml`:
   - Build command: `npm run build`
   - Publish directory: `dist`
4. **Environment variables** on the staging site:

   | Env | Value |
   |---|---|
   | `VITE_API_URL` | URL of the shared backend, e.g. `https://blo-map-api-production.up.railway.app` |
   | `VITE_MAPBOX_ACCESS_TOKEN` | same Mapbox token as prod (or a separate one if you want separated usage metrics) |
   | `VITE_STAGING_GATE_ENABLED` | `true` — turns on the "Staging access" pill in the bottom-right |

5. **Deploy** — Netlify builds the branch and assigns a URL like `blo-staging.netlify.app`.

### Frontend — prod Netlify site

Leave it alone. Do NOT set `VITE_STAGING_GATE_ENABLED` on prod — the pill is supposed to be invisible there.

---

## Sharing access with the PM

Send them:

1. The staging URL (e.g. `https://blo-staging.netlify.app`)
2. The `STAGING_PASSWORD` value
3. A note: "Click the **Staging access** pill in the bottom-right of the map, paste the password, hit Unlock. You'll see a green ✓ Staging tier badge — that means the daily cap is off for your session."

The session lasts 24 hours (token TTL). They re-enter the password to extend.

---

## Local dev

For pure local development you don't need the password gate at all — set `BUDGET_BYPASS=true` in `server/.env` and skip the password mechanism. That env disables the cap globally on the local backend.

If you want to test the staging-gate flow locally:

1. Set `STAGING_PASSWORD=local-test` in `server/.env`.
2. Add `VITE_STAGING_GATE_ENABLED=true` to a local `.env` file in the repo root (or pass on the Vite command line).
3. `npm run dev` and click the **Staging access** pill that appears bottom-right.

### Internal library login (phase 5) locally

The internal tier needs Postgres for accounts. For local dev without one, set `LIBRARY_DEV_PGMEM=1` in `server/.env` — the server boots an in-memory pg-mem store and seeds a known dev account (`dev-admin` / `dev-password-123`, logged as a warning on boot). Both guards are dev-only: the flag is ignored when `NODE_ENV=production`, and the seed never touches a real database. Then open `/login` on the Vite dev site (its origin must be in `ALLOWED_ORIGINS` in `server/.env`).

To run the live-login Cypress specs: ensure `http://localhost:4173` is in `ALLOWED_ORIGINS` and run `VITE_API_URL=http://localhost:3001 CYPRESS_INTERNAL_AUTH_LIVE=1 npm run test:e2e` with the pg-mem server up. Without the flag, the backend-dependent specs are skipped and only the backend-free specs run. `npm run test:e2e` builds its own copy into `dist-e2e/` with the API base pointed at the preview origin (`http://localhost:4173`) so the stubbed internal specs (chat, and any that `cy.intercept` an `/api/...` route) see their requests; `dist/` is left as the production build made it.

---

## Troubleshooting

- **Pill doesn't appear** — `VITE_STAGING_GATE_ENABLED=true` must be set on the Netlify staging site's env, AND the site rebuilt after setting it. Vite envs are inlined at build time.
- **"Invalid password"** — `STAGING_PASSWORD` on the backend doesn't match what was typed, or the backend service was deployed without the env set.
- **CORS errors in the browser console** — the staging Netlify origin isn't in `ALLOWED_ORIGINS` on the backend. Add it and restart.
- **Cap still appears to apply** — verify in browser devtools that the auth token's payload (base64-decode the first segment) ends with `.staging`. If it ends with `.normal` or has no tier suffix, the password didn't take.
- **Checking budget/usage state** — `GET /api/health` is deliberately bare (`{status: 'ok'}`). The full usage snapshot lives at `GET /api/health/usage` and requires an **internal-account session cookie** (P5-20 — a staging-tier bearer token no longer works). Easiest: log in on the map site or `/dashboard`, then hit the endpoint from the same browser. `bypassEnabled: true` there is the global `BUDGET_BYPASS` flag, not the per-user staging tier — it's ignored when `NODE_ENV=production`.
- **Usage dashboard** — visit `https://<backend-host>/dashboard` and log in with an **internal account** (created via the admin CLI — see DEPLOY.md → "Account management"; the staging password no longer opens the dashboard as of P5-20) for a visual view of tokens/day, request volume, unique visitors, query themes, and recent requests. Set `DATABASE_URL` (any managed Postgres) for history that survives redeploys; without it the dashboard shows only data since the last restart. See DEPLOY.md → "Usage dashboard".

---

## Tearing it back down

When the PM testing is done and you want the staging site gone:

1. Either pause the Netlify staging site (Settings → Site overview → "Stop builds") or delete it.
2. Remove the staging origin from `ALLOWED_ORIGINS` on the backend and restart.
3. Optionally remove `STAGING_PASSWORD` from the backend env to close the upgrade path entirely.

Code-side, no cleanup needed — the gate component is a no-op without its build flag, and the server route is a no-op without `STAGING_PASSWORD`.
