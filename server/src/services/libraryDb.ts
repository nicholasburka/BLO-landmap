import type { Pool as PgPool, QueryResult } from 'pg'
import { pgSslConfig } from './pgSsl.js'

/**
 * Postgres store for the internal data library (phase 5): users, sessions,
 * audit log now; catalog/wiki/views tables in later steps.
 *
 * Design notes:
 *  - Library *files* live in the bucket-mirrored tree and remain the source
 *    of truth for datasets; this DB holds auth state and the queryable index.
 *  - Auth state (accounts, sessions, audit) is NOT rebuildable from files,
 *    which is exactly why it lives in managed Postgres and not on the host's
 *    ephemeral disk.
 *  - Schema is applied idempotently at boot (CREATE TABLE IF NOT EXISTS) —
 *    same zero-migration pattern as usage_events. Open-ended attributes go
 *    in `meta`/`detail` JSONB columns so new fields never require ALTER TABLE.
 *  - No DATABASE_URL (or unreachable DB) → library features disabled with a
 *    logged warning. The public map's routes never depend on this module.
 */

let pool: PgPool | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('admin', 'internal')),
  disabled      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta          JSONB       NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS library_sessions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES library_users(id),
  token_hash TEXT        NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN     NOT NULL DEFAULT FALSE,
  -- When revoked, so pruneExpiredSessions() can date the grace period from
  -- the revocation rather than from the (much later) natural expiry.
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS library_sessions_user_idx ON library_sessions (user_id);
-- Migration for databases created before revoked_at existed. Idempotent, so
-- it runs alongside the CREATE TABLEs on every boot.
ALTER TABLE library_sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- Personal API tokens for non-browser clients — the MCP server (P5-50).
-- Same rule as library_sessions: only the sha256 of the token is stored, so
-- a DB leak yields nothing usable. Revocation is a timestamp rather than a
-- boolean because "when did we cut this off" is the question an incident
-- asks; scopes is JSONB so a "write" scope (P5-52) needs no ALTER TABLE.
CREATE TABLE IF NOT EXISTS library_api_tokens (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES library_users(id),
  name         TEXT        NOT NULL,
  token_hash   TEXT        NOT NULL UNIQUE,
  scopes       JSONB       NOT NULL DEFAULT '["read"]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS library_api_tokens_user_idx ON library_api_tokens (user_id);

-- OAuth 2.1 for remote MCP clients (P5-51). ChatGPT's and Claude's connector
-- flows will not carry a personal token, so they register themselves and walk
-- an authorization-code + PKCE flow instead.
--
-- Same rule as every other credential here: only sha256 hashes are stored, so
-- a DB leak yields nothing replayable. There are no client secrets at all —
-- every client is public (token_endpoint_auth_method "none"), which is why
-- PKCE is mandatory rather than optional.

-- Dynamically registered clients (RFC 7591). No secret column exists, so one
-- can never be added by accident.
CREATE TABLE IF NOT EXISTS library_oauth_clients (
  id            BIGSERIAL PRIMARY KEY,
  client_id     TEXT        NOT NULL UNIQUE,
  client_name   TEXT        NOT NULL,
  redirect_uris JSONB       NOT NULL DEFAULT '[]',
  grant_types   JSONB       NOT NULL DEFAULT '[]',
  scopes        JSONB       NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at   TIMESTAMPTZ
);

-- An authorize request parked while the human goes and logs in. The SPA login
-- page can only return to a path on its OWN origin, so the request cannot
-- ride along in the redirect: it waits here under an opaque id and the account
-- page links back to it. Short-lived, and it holds no credential.
CREATE TABLE IF NOT EXISTS library_oauth_pending (
  id_hash    TEXT        PRIMARY KEY,
  params     JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Authorization codes: single use, 10 minutes, bound to the client, the exact
-- redirect_uri, the PKCE challenge, the scopes, the resource and the user.
-- family_id is stamped when the code is exchanged, so presenting a code twice
-- can revoke everything that first exchange produced.
CREATE TABLE IF NOT EXISTS library_oauth_codes (
  id             BIGSERIAL PRIMARY KEY,
  code_hash      TEXT        NOT NULL UNIQUE,
  client_id      TEXT        NOT NULL,
  user_id        BIGINT      NOT NULL REFERENCES library_users(id),
  redirect_uri   TEXT        NOT NULL,
  code_challenge TEXT        NOT NULL,
  scopes         JSONB       NOT NULL DEFAULT '[]',
  resource       TEXT        NOT NULL,
  family_id      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

-- Access and refresh tokens in one table: they differ only in kind and TTL,
-- and every lookup wants the same columns. family_id ties one authorization
-- together — it is what "revoke this connected app" and refresh-token reuse
-- detection both act on. used_at marks a refresh token that has been rotated
-- away; seeing it again means the token leaked.
CREATE TABLE IF NOT EXISTS library_oauth_tokens (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT        NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash   TEXT        NOT NULL UNIQUE,
  family_id    TEXT        NOT NULL,
  user_id      BIGINT      NOT NULL REFERENCES library_users(id),
  client_id    TEXT        NOT NULL,
  scopes       JSONB       NOT NULL DEFAULT '[]',
  resource     TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS library_oauth_tokens_family_idx ON library_oauth_tokens (family_id);
CREATE INDEX IF NOT EXISTS library_oauth_tokens_user_idx ON library_oauth_tokens (user_id);

CREATE TABLE IF NOT EXISTS library_catalog (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT        NOT NULL UNIQUE,
  kind       TEXT        NOT NULL,
  title      TEXT        NOT NULL DEFAULT '',
  category   TEXT        NOT NULL DEFAULT '',
  status     TEXT        NOT NULL DEFAULT 'needs-review',
  tags       JSONB       NOT NULL DEFAULT '[]',
  meta       JSONB       NOT NULL DEFAULT '{}',
  files      JSONB       NOT NULL DEFAULT '[]',
  bytes      BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat threads (P6-7). A thread belongs to ONE person: every read is keyed
-- by (id, user_id), so another account — an admin included, this phase —
-- gets the same 404 as a thread that never existed. Archiving is a flag
-- rather than a DELETE because a thread is a record of what was asked and
-- of every write that was run from it.
CREATE TABLE IF NOT EXISTS library_chats (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES library_users(id),
  title      TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived   BOOLEAN     NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS library_chats_user_idx ON library_chats (user_id);

-- One message in a thread. The role carries a fourth value the wire protocol
-- calls out: "summary" is the compaction message written when a thread runs
-- past thirty turns (docs/CHAT.md), and its meta.throughMessageId says which
-- messages it stands in for when the context is rebuilt.
--
-- tool_calls holds what the assistant did (and what it PROPOSED to do: a
-- write waits there as status "proposed" with its arguments until the person
-- confirms it), citations the numbered sources of that answer — both JSONB,
-- so a new field on either never needs an ALTER TABLE.
CREATE TABLE IF NOT EXISTS library_chat_messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    BIGINT      NOT NULL REFERENCES library_chats(id),
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'summary')),
  text       TEXT        NOT NULL DEFAULT '',
  tool_calls JSONB       NOT NULL DEFAULT '[]',
  citations  JSONB       NOT NULL DEFAULT '[]',
  meta       JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_chat_messages_chat_idx ON library_chat_messages (chat_id);

CREATE TABLE IF NOT EXISTS library_audit (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT,
  actor      TEXT        NOT NULL,
  action     TEXT        NOT NULL,
  target     TEXT,
  detail     JSONB       NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_audit_created_idx ON library_audit (created_at);
`

/** Initialize the library store. Call once at boot (or from tests with an
 *  injected pool, e.g. pg-mem). Returns true when library features are
 *  available; any failure logs a warning and returns false so the rest of
 *  the server boots normally. */
export async function initLibraryDb(injectedPool?: PgPool): Promise<boolean> {
  try {
    let candidate: PgPool
    if (injectedPool) {
      candidate = injectedPool
    } else {
      const url = process.env.DATABASE_URL
      if (!url) {
        // Dev-only escape hatch: LIBRARY_DEV_PGMEM=1 boots the library on an
        // in-memory pg-mem store (a devDependency) so login flows can be
        // exercised locally without Postgres. Data vanishes on restart.
        // Never set this in production.
        if (process.env.LIBRARY_DEV_PGMEM === '1' && process.env.NODE_ENV !== 'production') {
          const { newDb } = await import('pg-mem')
          const { Pool } = newDb({ noAstCoverageCheck: true }).adapters.createPg()
          candidate = new Pool() as unknown as PgPool
          console.warn(
            '[library] LIBRARY_DEV_PGMEM=1 — in-memory dev store; all library data is lost on restart.',
          )
          await candidate.query(SCHEMA)
          pool = candidate
          return true
        }
        console.warn(
          '[library] DATABASE_URL not set — library features disabled, public map unaffected.',
        )
        pool = null
        return false
      }
      const { Pool } = await import('pg')
      candidate = new Pool({
        connectionString: url,
        // Managed Postgres (Neon/Railway/Render/Supabase) requires TLS. This
        // pool carries password hashes and session rows, so the certificate
        // is verified unless the operator opts out — see services/pgSsl.ts.
        ssl: pgSslConfig(url),
        max: 4,
      })
    }
    await candidate.query(SCHEMA)
    pool = candidate
    console.log('[library] Postgres store ready.')
    return true
  } catch (err: any) {
    console.warn(
      `[library] init failed (${err?.message || err}) — library features disabled, public map unaffected.`,
    )
    pool = null
    return false
  }
}

export function isLibraryEnabled(): boolean {
  return pool !== null
}

/** Run a query against the library store. Callers must sit behind
 *  isLibraryEnabled() or route-level guards; throwing here means a code
 *  path forgot that. */
export function libraryQuery(text: string, params?: unknown[]): Promise<QueryResult> {
  if (!pool) throw new Error('library store is not initialized')
  return pool.query(text, params)
}

/** Test hook + graceful shutdown. Does not end injected pools' underlying
 *  resources beyond pg's own end(). */
export async function closeLibraryDb(): Promise<void> {
  const p = pool
  pool = null
  await p?.end().catch(() => {})
}

export interface AuditEntry {
  userId?: number | null
  actor: string
  action: string
  target?: string
  detail?: Record<string, unknown>
}

/** Best-effort audit write: auditing must never take down the request that
 *  triggered it, but silence would hide a broken audit trail, so failures
 *  are logged loudly. Returns a never-rejecting promise so synchronous
 *  callers (Express handlers) can fire-and-forget while the CLI awaits it
 *  before the process exits. */
export function writeAudit(entry: AuditEntry): Promise<void> {
  if (!pool) return Promise.resolve()
  return pool
    .query(
      `INSERT INTO library_audit (user_id, actor, action, target, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.userId ?? null,
        entry.actor,
        entry.action,
        entry.target ?? null,
        JSON.stringify(entry.detail ?? {}),
      ],
    )
    .then(() => undefined)
    .catch(err => console.error('[library] audit write failed:', err?.message || err))
}
