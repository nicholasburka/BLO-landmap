# Deploy Runbook — LLM-Enabled BLO National Map

Step-by-step to take `main` live. Two pieces deploy separately:

- **Backend** — the Express LLM proxy in `server/` (Railway / Render / Fly / any Node host).
- **Frontend** — the Vite static build in `dist/` (Netlify).

Do the **backend first** so you have its URL to give the frontend. Everything in this doc is a one-time setup plus a redeploy; later code pushes to `main` just trigger rebuilds.

> Secrets live only in host env settings and gitignored local `.env` files — never commit them.

---

## 0. Prerequisites (once)

- [ ] **Rotate the RentCast API key.** The previous key was committed to git history and shipped in the browser bundle — treat it as compromised. Generate a fresh key in the RentCast dashboard; you'll paste it into the frontend env below. (If listings ever need a *private* key, proxy the calls through the backend instead of shipping it.)
- [ ] Generate a session signing secret and keep it somewhere safe (you'll paste it into the backend env):
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- [ ] Have your **Anthropic API key** and **Mapbox public token** ready.

---

## 1. Backend (Express LLM proxy)

The backend lives in the `server/` subdirectory. Point your host at that directory (Railway/Render: set **Root Directory** = `server`).

**Build & start commands:**
- Install: `npm install` (helmet is a new dependency — a fresh install is required)
- Build: `npm run build`
- Start: `npm start`

**Environment variables** (Settings → Variables):

| Env | Value | Notes |
|---|---|---|
| `SESSION_HMAC_SECRET` | the 32-byte hex string from step 0 | **Required — server refuses to boot without it.** Not a password; a random secret. |
| `ANTHROPIC_API_KEY` | your Anthropic key | Required — server refuses to boot without it. |
| `NODE_ENV` | `production` | Hardens error responses; force-disables `BUDGET_BYPASS`. |
| `ALLOWED_ORIGINS` | `https://<prod-site>.netlify.app` (comma-add the staging origin if used) | CORS allowlist. Must include every browser origin that calls the API. |
| `TRUST_PROXY_HOPS` | `1` (default) or `2` | Proxy hops between the client and the server. `1` = host proxies directly (Railway/Render). `2` = a CDN sits in front of the host. **Must match reality** or per-IP limits are spoofable. |
| `PORT` | as your host requires | Railway/Render usually inject this automatically. |
| `BETA_PASSWORD` | *(leave unset for pure prod)* | Optional normal-tier password. |
| `STAGING_PASSWORD` | *(leave unset for pure prod)* | Optional cap-bypass password for PM testing — see STAGING.md. Also unlocks `/api/health/usage`. |
| `DAILY_BUDGET_TOKENS` / `DAILY_BUDGET_TOKENS_PER_IP` | *(unset = defaults 200k / 15k)* | Only override if you know what you're changing. |

- [ ] **Do NOT set `BUDGET_BYPASS`.** (It's ignored in production anyway, but don't rely on that.)
- [ ] Deploy. Watch the logs for `BLO API server listening on port …`. If you see a `FATAL:` line instead, a required secret is missing.
- [ ] Note the public backend URL (e.g. `https://blo-api.up.railway.app`).

**Smoke-test the backend** (replace the host):
```bash
# Bare health — expect {"status":"ok"}
curl https://blo-api.up.railway.app/api/health

# Usage snapshot without a token — expect 401 (it's auth-gated now)
curl https://blo-api.up.railway.app/api/health/usage

# Anonymous session mint — expect {"token":"..."}
curl -X POST https://blo-api.up.railway.app/api/session
```

---

## 2. Frontend (Netlify)

Build settings are already in `netlify.toml` (build `npm run build`, publish `dist`, SPA redirect, security + cache headers). Point the prod Netlify site at the **`main`** branch.

**Environment variables** (Site settings → Environment variables) — Vite inlines these at **build time**, so you must **rebuild after changing them**:

| Env | Value | Notes |
|---|---|---|
| `VITE_API_URL` | the backend URL from step 1 | **Required.** Without it the built app disables AI features (it will not silently call localhost). No trailing slash. |
| `VITE_MAPBOX_ACCESS_TOKEN` | your Mapbox public token (`pk.…`) | Required for the map to render. |
| `VITE_RENTCAST_API_KEY` | the **rotated** key from step 0 | Powers the property-listings panel. Ships in the bundle (publishable-only). |
| `VITE_STAGING_GATE_ENABLED` | *(leave unset on prod)* | Only set `true` on a staging site to show the password pill. |

- [ ] Set the three required vars, leave the staging flag unset.
- [ ] Trigger a deploy (Deploys → Trigger deploy → **Clear cache and deploy site** to guarantee the new envs are inlined).
- [ ] Open the site: the map loads, and a suggested-chip query returns a ranked list (that confirms the frontend↔backend↔Anthropic path end-to-end).

---

## 3. Verify the topology (5 min, important)

The per-IP rate limit and per-IP budget depend on the server seeing the **real client IP**.

- [ ] With a `STAGING_PASSWORD` set (or temporarily), unlock a staging token and hit `GET /api/health/usage`; make a couple of chat requests and confirm `uniqueIps` increments by real distinct clients, not `1`.
- [ ] If a CDN (Cloudflare, etc.) fronts the backend, set `TRUST_PROXY_HOPS=2` and redeploy.

---

## 4. Backstops & monitoring

- [ ] **Anthropic spend limit / alert** on the API key — a hard cap behind the app's daily budget in case anything slips.
- [ ] **Uptime monitor** on `GET /api/health` (any pinger — UptimeRobot, Better Stack, etc.).
- [ ] Know the daily-cap behavior: once the budget trips, the app returns a friendly "hit today's usage cap" message and resets at UTC midnight. Raise `DAILY_BUDGET_TOKENS` if legitimate traffic hits it.

---

## 5. Known one-time blip at cutover

The token signing secret changed in this release. Any returning user holding a token from an older build gets **one** silent 401 on their next action, then the client auto-re-mints and shows "Session refreshed — please send that again." It self-heals on the next send — no action needed, just don't be alarmed by a brief 401 blip in logs right after deploy.

---

## Rollback

- **Frontend:** Netlify → Deploys → pick the previous deploy → "Publish deploy" (instant).
- **Backend:** redeploy the previous commit/image on your host. Env vars persist across redeploys.
- **Code:** `main` fast-forwarded from `ux-redesign-phase4b`; the prior prod commit was `ab6c97a` if you need to reset.

---

## Scaling note (later, not now)

The rate-limit and budget counters are in-memory per process, so they reset on each backend redeploy and don't share state across replicas. Fine for a single instance. Before scaling the backend horizontally, move both to Redis (the code comments mark where).

See also: **STAGING.md** for the PM/stakeholder preview site and the password-tier mechanism.
