# Run the whole platform on a laptop

One command brings up the public map, the knowledge base and the API against the real library bucket, with an in-memory database that needs no Postgres. Good for a demo or a rehearsal; not for anything that has to survive a restart.

## Once

- Node 22 and `npm install` in the repo root **and** in `server/`.
- `server/.env` with the five `LIBRARY_BUCKET_*` variables, `ANTHROPIC_API_KEY`, `SESSION_HMAC_SECRET`, `PORT=3001` and `ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174,http://localhost:4173`. This machine already has it.
- A Mapbox token in the root `.env` as `VITE_MAPBOX_ACCESS_TOKEN` (already there).
- **Anthropic credit on the account.** Without it the map still works, but Ask, the filing suggestion, the page-reading pass and the place-report summary all report "the model refused the key".

## Every time

```bash
npm run demo
```

That runs two things side by side, with prefixed output:

- `demo:api` — the API on **http://localhost:3001** with `LIBRARY_DEV_PGMEM=1`: an in-memory database seeded with one account, `dev-admin` / `dev-password-123` (admin), and the library indexed from the bucket at boot (you will see `dev store indexed from the bucket: N entries`).
- `dev` — Vite on **http://localhost:5173**, built against `localhost:3001` by default. The county data file is rebuilt first (`predev`), which takes a few seconds.

Open http://localhost:5173, press **Knowledge base**, log in as `dev-admin`. Stop both with Ctrl-C.

## What to know during a demo

- **Writes go to the real bucket.** A dropped link, an upload, a pulled-in document or a saved view lands in the same library the team uses. Archive or delete afterwards (`npm run library -- push` from the push tree restores every manifest to its reviewed state).
- **The database is in memory.** Accounts, sessions, saved-view rows and audit rows vanish on restart; the bucket does not. Only `dev-admin` exists — extra accounts need a real Postgres (`DATABASE_URL`, then `npm run users -- create <name>` from `server/`). A free Neon database takes five minutes if you want named logins for the team.
- **The connectors (ChatGPT / Claude Desktop) need a public https origin** and will not reach a laptop. Everything else in the demo script works locally.
- **Login throttle**: ten attempts per hour per address. Mistype the password a few times and you wait.
- **First map load** downloads about 3.5 MB; open the map once before the room fills so it is cached.
- **Daily token cap**: the API allows 200,000 tokens a day by default across the public chat and Ask. Set `DAILY_BUDGET_TOKENS=2000000` in `server/.env` for a demo day.

## Two terminals instead of one

If you prefer separate windows:

```bash
cd server && LIBRARY_DEV_PGMEM=1 npm run dev     # API on 3001
npm run dev                                       # map + knowledge base on 5173
```

## Production build, locally

To rehearse the exact bundle Netlify serves (faster than the dev server):

```bash
VITE_API_URL=http://localhost:3001 npm run build
npm run preview -- --port 5174     # http://localhost:5174, allowed by the API's origin list
```
