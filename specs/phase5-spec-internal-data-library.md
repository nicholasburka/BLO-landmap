# Spec: Internal Data Library (Wiki + Ingestion + Internal Tier)

**Status:** Draft
**Author:** Nick + Claude
**Date:** 2026-09-02

---

## Problem Statement

BLO's data library currently has exactly one interface — the public county map — and exactly one storage location: publicly fetchable static files in `public/datasets/`. The internal team has no secure place to file new datasets, one-off documents, or research findings, no way to maintain narrative knowledge around the data (a wiki), and no redundant access path to the raw material. Because everything in `public/` is world-readable on the Netlify CDN, internal-only data cannot be added at all today without leaking it.

---

## Success Criteria

We'll know this works when:

- [ ] The public map works exactly as it does today — same layers, same data, same URLs, no login required. (Regression gate: existing Cypress suite passes unchanged.)
- [ ] An internal team member can log in with their own username + password and see the library (wiki + catalog) and any internal map layers.
- [ ] A logged-out user (or anyone probing URLs directly) cannot retrieve any internal dataset, document, or wiki page — verified by direct `curl` of every internal endpoint returning 401, and by a build check proving no internal files exist in `dist/`.
- [ ] An internal user can drag-and-drop a file (CSV, PDF, GeoJSON, image, anything) into the app, fill a short filing form, and it appears in the catalog with status `needs-review`.
- [ ] A dev can pull the entire library to a local folder with one command, clean/transform data there (manually or with Claude Code), push it back with one command, and the changes appear in the app.
- [ ] The raw library files are accessible to the team through a direct path (bucket/synced folder) even if the web app is down.
- [ ] An internal user can create, edit, and interlink wiki pages, and link pages to catalog entries.

---

## Solution Overview

Extend the existing Express server (`server/`) with per-user auth and a **library service** backed by a plain-files store + a Postgres index (same managed `DATABASE_URL` instance that powers the usage dashboard — chosen over host-disk SQLite because auth state isn't rebuildable from files and Railway/Render disks are ephemeral; JSONB `meta`/`detail` columns keep schemas flexible with no migration framework). All internal material lives in a single `library/` tree in object storage (mirrored locally on the server), never in `public/` or the client bundle. The Vue app gains a login and, when authenticated, four additions: internal map layers, a catalog browser with drag-and-drop upload, an in-app markdown wiki, and **saved views** — named snapshots of map/query state that attach to a user's account and can be embedded in wiki pages. Improvement requests and ideas are filed as lightweight text-only catalog entries (category `ideas`), reusing the same catalog infrastructure. Devs interact with the same library tree via a sync CLI (`pull`/`push`), making Claude-Code-driven data cleaning a first-class pathway rather than a workaround.

---

## Architecture

### Storage layout (single source of truth)

```
library/                      # object storage bucket, mirrored on server
├── incoming/<uuid>/          # raw uploads, exactly as received + upload manifest
├── datasets/<slug>/          # published datasets (cleaned, documented)
│   ├── data.*                # the file(s)
│   └── meta.json             # title, category, tags, source, status, lineage
├── documents/<slug>/         # one-off docs, research findings, PDFs, notes
├── views/<slug>.json         # saved data views (map/query state snapshots)
└── wiki/<slug>.md            # wiki pages as markdown files
```

Design rules:
- **Files are the truth; Postgres is the index.** The catalog/wiki/views index can always be rebuilt by walking the tree and reading `meta.json` files — a re-indexing job, not a data migration. Auth state (users, sessions, audit) is the exception: it is *not* rebuildable from files, which is exactly why it lives in managed Postgres rather than on the host's ephemeral disk. Open-ended attributes go in JSONB columns so new fields never require `ALTER TABLE`.
- **Wiki pages are files too** — they ride along in every sync/backup and are directly readable outside the app.
- **`meta.json` carries lineage**: which `incoming/` upload a published dataset came from, and what cleaning was done (free text + script reference).

### Data lifecycle (the "fluid pathway")

```
upload via app ──▶ incoming/ (status: needs-review)
                      │
        dev: `library pull` ──▶ local folder ──▶ clean with Claude Code / scripts
                      │
        dev: `library push` ──▶ datasets/<slug>/ (status: published)
                      │
        catalog + wiki + map layers read from published entries
```

- The sync CLI is a small script in `scripts/` (wraps `rclone`/S3 sync + an index-rebuild call). One command each way.
- Statuses: `needs-review` → `in-cleaning` → `published` (or `archived`). The catalog shows all; only `published` datasets are offered as map layers.

### Auth

- Per-user accounts: username + password (argon2/bcrypt hashed), created by an admin via CLI or admin page. No email flows.
- Server-side sessions in httpOnly, `Secure`, `SameSite=Strict` cookies. CSRF token on mutating routes.
- Roles: `admin` (manage users), `internal` (everything else). The existing anonymous-session tier is untouched and remains what the public map uses.
- Every upload, edit, publish, and delete is written to an audit log with the acting user.

### API surface (all under existing Express app)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/login`, `POST /api/logout` | — / internal | Session management |
| `GET /api/library/catalog` | internal | Search/browse catalog (from the Postgres index) |
| `POST /api/library/upload` | internal | Multipart upload → `incoming/` |
| `GET /api/library/file/:id` | internal | Stream any library file (per-entry ACL-ready) |
| `GET/PUT /api/wiki/:slug` | internal | Read/write wiki pages |
| `GET/POST /api/views`, `GET /api/views/:slug` | internal | Save/list/load data views |
| `GET /api/layers/internal` | internal | Internal map layer manifest + data |

### Saved views & wiki embeds

- **Saving:** from the map, an internal user hits "Save view" to capture the current state — active layers, filters, prompt/query text, ranking results, viewport — as a named `views/<slug>.json` owned by their account. Query *results* are snapshotted alongside the query itself, so a view stays meaningful even if underlying data is later revised (the embed indicates data-as-of date).
- **Embedding:** wiki markdown supports an embed block, e.g. ` ```view:tn-heirs-ranking``` `, rendered as an inline card: the snapshot's key results plus an "open in map" link that restores the full view. Same mechanism works for catalog entries (` ```entry:<slug>``` ` renders a citation card).
- **Ideas & improvement requests:** the catalog accepts **text-only entries** (no file) via a quick form — title + body + category. Category `ideas` gets a status field (`open` / `planned` / `done`) and a simple filtered list view. No separate tracker system.

### Frontend (Vue app)

- Small "Log in" link at the top left of the map → `/login`; when authenticated it becomes the account/library entry point. Aside from this link, the logged-out experience is pixel-identical to today.
- `/library` route (auth-guarded): catalog list with search/filter by category, tag, status; drag-and-drop upload with filing form (title, category, tags, notes). **Quick drop:** the form is skippable — files dropped without metadata land in `incoming/` as `needs-cataloging`, surfaced in a "to file" queue anyone internal can complete later.
- `/wiki/:slug` route: rendered markdown (existing markdown + DOMPurify stack), edit mode with plain textarea + preview, page-to-page links and page-to-catalog-entry links.
- Map: internal layers appear in layer controls only when authenticated, data fetched from `/api/layers/internal` — layer names and configs never ship in the public bundle.

### Redundancy / direct access

- Primary store is the object storage bucket (Cloudflare R2, Backblaze B2, or S3 — cheap, S3-compatible so `rclone` works). The server keeps a local mirror for fast serving.
- Team direct access = read credentials to the bucket (or a periodically synced shared folder). If the app is down, the files are still there, organized, with `meta.json` beside each.
- Bucket versioning enabled → automatic version history and deletion protection for free.

---

## Detailed Requirements

### Functional
1. The system shall serve the existing public map and its datasets unchanged, with no authentication.
2. The system shall authenticate internal users by username + password and maintain server-side sessions via httpOnly cookies.
3. The system shall accept file uploads of any type up to a configured size limit (default 200 MB), storing them under `incoming/` with a manifest recording uploader, timestamp, and filing-form metadata; metadata is optional at upload time (quick drop → `needs-cataloging` queue).
3a. The system shall accept text-only catalog entries (title + body + category, no file), including `ideas` entries with an open/planned/done status.
3b. The system shall let users save named data views (map/query state + result snapshot) to their account, and render view/entry embeds inside wiki pages with an "open in map" restore link.
4. The system shall maintain a searchable catalog of all library entries with title, category, tags, status, and lineage.
5. The system shall serve library files only to authenticated internal users, streamed through the API (no static/public paths).
6. The system shall provide create/edit/render for markdown wiki pages, sanitized before render, with intra-wiki and wiki→catalog links.
7. The system shall expose internal map layers only via authenticated API, discoverable only after login.
8. The system shall provide a dev sync CLI: `pull` (bucket → local folder) and `push` (local → bucket + reindex).
9. The system shall record an audit log entry for every mutating library action, attributed to a user.
10. The system shall rebuild the Postgres catalog/wiki/views index from the file tree on demand (`reindex` command); auth tables are excluded (not file-backed).

### Non-Functional
- **Security:** no internal bytes in `public/`, `dist/`, or the client bundle (enforced by a CI/build check); password hashes via argon2id; rate-limited login endpoint; existing helmet/CORS/proxy config retained; `noindex` headers on all internal routes.
- **Reliability:** bucket versioning on; index rebuildable from files; server restart never loses data (server mirror is a cache of the bucket).
- **Performance:** catalog search < 500 ms for up to ~10k entries (Postgres is fine well past this); uploads streamed, not buffered in memory.
- **Portability:** storage layer is "S3-compatible + files," so moving to a more robust backend later means re-pointing the sync + reindexing — no lock-in.

---

## System Context

### How it fits
- Builds directly on `server/` (Express, helmet, rate limiting, pg). The library shares the usage dashboard's `DATABASE_URL` instance with its own `library_*` tables — one managed database, zero native modules, survives ephemeral host disks.
- Frontend additions are new routes/components in the existing Vue app; `useAuth.ts` grows a real login alongside the anonymous session path.
- Netlify continues to serve only public assets; the API host serves everything internal.

### Dependencies
- Object storage bucket (R2/B2/S3) + credentials.
- `pg` (already present; `pg-mem` for tests), `multer` or equivalent (uploads), `rclone` (dev sync).

### Affected systems
- `server/src/` (new routers/middleware), `src/` (login, library, wiki routes), `scripts/` (sync CLI), CI (bundle-leak check).
- Explicitly NOT affected: `public/datasets/`, existing map components' logged-out behavior, DC/memphis/donor maps.

---

## Constraints & Boundaries

### In scope
- Per-user password auth, roles admin/internal
- File store + Postgres index + catalog UI + upload flow
- In-app markdown wiki with view/entry embeds
- Saved data views on user accounts; text-only entries incl. `ideas` with status
- Internal map layers behind auth
- Dev sync CLI and cleaning pathway
- Bucket-based redundancy + direct team access
- Public-site analytics (visitors, pageviews, layer/county interaction events), dashboard visible to internal users only; tracker choice via spike (privacy-friendly, no cookie banner, custom events required)
- Existing AI-usage dashboard re-gated from staging password to internal login

### Out of scope (v1)
- Email flows of any kind (reset is admin-performed)
- In-app data cleaning/transformation tools (cleaning is dev-side by design)
- Bulk zip export from the app (direct bucket access covers this; revisit later)
- Watched drop-zone folder/bucket outside the app (in-app quick drop + dev sync CLI cover the convenience without a second security surface)
- Live/auto-refreshing wiki embeds (v1 embeds are snapshots with data-as-of dates; live queries later if needed)
- Voting/commenting on ideas entries (it's a filing cabinet, not a forum — revisit if volume warrants)
- WYSIWYG wiki editor, comments, page history UI (bucket versioning is the safety net; history UI later)
- Fine-grained per-dataset permissions (single `internal` tier for now; ACL field reserved in `meta.json`)
- Migrating public datasets into the library (they stay static; can be cataloged as "external/public" entries later)
- Any changes to DC/memphis/donor maps

### Assumptions
- Internal team is small (≤ ~15 people); admin-managed accounts are acceptable.
- Total library volume in the tens of GB at most for the foreseeable future.
- The API host can hold a mirror of the library on disk.
- Devs doing cleaning have bucket credentials and a local clone.

### Technical constraints
- Nothing internal may ever be committed to `public/`, `dist/`, or the client bundle.
- Passwords never stored or logged in plaintext; sessions httpOnly (no localStorage tokens for internal auth).
- Keep the anonymous-session/staging-gate code path byte-compatible for the public map.

---

## Examples

### Example 1: Filing a research finding (happy path)
**Given:** Maria is logged in as an internal user
**When:** she drags `heirs-property-tn-notes.pdf` onto the library page, titles it "Heirs' property field notes — TN," picks category *Research*, tags `land`, `tennessee`, and submits
**Then:** the file lands in `incoming/<uuid>/` with her user ID in the manifest, appears in the catalog as `needs-review`, and an audit entry is recorded.

### Example 2: Dev cleaning pathway (happy path)
**Given:** a dataset sits in `incoming/` as `needs-review`
**When:** Nick runs `npm run library pull`, cleans the CSV locally with Claude Code, writes `meta.json` (status `published`, lineage noting the cleaning), and runs `npm run library push`
**Then:** the file appears under `datasets/<slug>/`, the index is rebuilt, the catalog shows it as published, and (if geographic) it becomes available as an internal map layer.

### Example 3: Probing for internal data (failure case)
**Given:** an unauthenticated visitor on the public map
**When:** they request `/api/library/file/123`, `/api/wiki/strategy`, or `/api/layers/internal` directly
**Then:** every request returns 401 with no content, no filenames, and no hint of what exists; the public map continues working normally.

### Example 4: App outage (edge case)
**Given:** the API host is down
**When:** a team member needs this quarter's dataset
**Then:** they open the synced bucket/folder, navigate `library/datasets/<slug>/`, and read the file plus its `meta.json` — no app required.

### Example 5: Quick drop, filed later (happy path)
**Given:** Devon is logged in but mid-meeting
**When:** he drags three PDFs onto the library page and dismisses the filing form
**Then:** all three land in `incoming/` as `needs-cataloging` attributed to Devon; later, anyone internal opens the "to file" queue, adds titles/categories/tags, and they become normal catalog entries.

### Example 6: A wiki page backed by data (happy path)
**Given:** Maria has run a ranking query on the map ("top 20 counties by land value + Black population share") and hit **Save view** as `tn-target-counties`
**When:** she writes a wiki page on TN strategy and includes the block ` ```view:tn-target-counties``` `
**Then:** the page renders an inline card with the ranked results and data-as-of date, plus an "open in map" link that restores her exact layers, query, and viewport for any internal user.

### Example 7: Filing an idea (happy path)
**Given:** a team member notices the layer legend is confusing on mobile
**When:** they open the library, choose "New idea," and type a title + two sentences
**Then:** a text-only `ideas` entry is created with status `open`, attributed to them, visible in the filtered ideas list — no separate tool, no email.

### Example 8: Weird upload (edge case)
**Given:** an internal user uploads a 300 MB video (over limit) and then a `.zip` (allowed)
**Then:** the video is rejected client- and server-side with a clear size message; the zip is stored as-is in `incoming/` — the library never rejects a *type*, only size — and filed for review.

---

## Open Questions

- [ ] Which object storage provider? (R2 is the cheap default; B2 if egress pricing matters; S3 if AWS already in play.)
- [ ] Internal map layers v1: which dataset(s) first? (Drives whether we need tiling or GeoJSON-over-API suffices.)
- [ ] Does the current API host have persistent disk for the mirror, or should the server stream straight from the bucket?

---

## Suggested build order

1. **Auth core** — users table, login/logout, session middleware, admin CLI. *(Gate: Example 3 passes.)*
2. **Library store + catalog read** — bucket, mirror, Postgres index, `reindex`, catalog API + UI (seeded manually). *(Gate: Example 4 works.)*
3. **Upload flow** — drag-and-drop → `incoming/`, filing form + quick drop, text-only entries (incl. ideas), audit log. *(Gate: Examples 1, 5, 7.)*
4. **Sync CLI + lifecycle** — pull/push/reindex, statuses, lineage. *(Gate: Example 2.)*
5. **Wiki** — CRUD + render + linking.
6. **Saved views + embeds** — save/restore view, wiki embed cards. *(Gate: Example 6.)*
7. **Internal map layers** — authenticated layer manifest + first internal layer.
8. **Hardening pass** — bundle-leak CI check, login rate limits, noindex, Cypress regression on public map.

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-09-02 | Nick + Claude | Initial draft from planning discussion |
