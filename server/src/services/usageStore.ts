import { createHash } from 'crypto'
import type { Pool as PgPool } from 'pg'

/**
 * Usage recording + querying for the internal dashboard.
 *
 * Durability is optional:
 *   - DATABASE_URL set  → Postgres. Survives redeploys; full history.
 *   - DATABASE_URL unset → in-memory ring buffer. Works out of the box for
 *     dev and no-DB deploys, but only holds data since the last restart.
 *
 * Every record is also emitted as one structured JSON line to stdout, so the
 * host log viewer is useful even without querying the store. Raw IPs are
 * never stored — only a salted hash — matching the rest of the server's
 * privacy-conscious logging.
 */

export interface UsageEntry {
  ts: number
  path: string
  status: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  tier: string
  themes: string[]
  ipHash: string
}

export interface DailyAggregate {
  day: string
  requests: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  chat: number
  query: number
  uniqueIps: number
}

export interface ThemeCount {
  theme: string
  count: number
}

export interface RecentEntry {
  ts: number
  path: string
  status: number
  durationMs: number
  totalTokens: number
  tier: string
  themes: string[]
}

const MEMORY_CAP = 20_000

let memory: UsageEntry[] = []
let pool: PgPool | null = null
let pgReady: Promise<void> | null = null

function ipSalt(): string {
  return process.env.SESSION_HMAC_SECRET || 'blo-usage-salt'
}

/** One-way, salted hash so a raw client IP is never persisted or logged. */
export function hashIp(ip: string): string {
  return createHash('sha256').update(`${ipSalt()}:${ip}`).digest('hex').slice(0, 16)
}

export function persistenceMode(): 'postgres' | 'memory' {
  return pool ? 'postgres' : 'memory'
}

/** Initialize the store. Call once at boot. Falls back to in-memory (and
 *  logs why) if DATABASE_URL is absent or the DB is unreachable. */
export async function initUsageStore(): Promise<void> {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.log('[usage] DATABASE_URL not set — using in-memory store (no history across restarts).')
    return
  }
  try {
    const { Pool } = await import('pg')
    pool = new Pool({
      connectionString: url,
      // Managed Postgres (Neon/Railway/Render/Supabase) requires TLS.
      ssl: { rejectUnauthorized: false },
      max: 4,
    })
    pgReady = pool
      .query(
        `CREATE TABLE IF NOT EXISTS usage_events (
           id           BIGSERIAL PRIMARY KEY,
           ts           TIMESTAMPTZ  NOT NULL,
           path         TEXT         NOT NULL,
           status       INTEGER      NOT NULL,
           duration_ms  INTEGER      NOT NULL,
           input_tokens INTEGER      NOT NULL,
           output_tokens INTEGER     NOT NULL,
           tier         TEXT         NOT NULL,
           themes       TEXT[]       NOT NULL DEFAULT '{}',
           ip_hash      TEXT         NOT NULL
         );
         CREATE INDEX IF NOT EXISTS usage_events_ts_idx ON usage_events (ts);`,
      )
      .then(() => {
        console.log('[usage] Postgres store ready.')
      })
    await pgReady
  } catch (err: any) {
    console.error('[usage] Failed to init Postgres, falling back to in-memory:', err?.message || err)
    pool = null
  }
}

/** Fire-and-forget record of one billable request. Never throws into the
 *  request path — a logging failure must not fail a user's query. */
export function recordUsage(entry: UsageEntry): void {
  // Structured line to stdout regardless of persistence backend.
  console.log(
    JSON.stringify({
      t: 'usage',
      ts: new Date(entry.ts).toISOString(),
      path: entry.path,
      status: entry.status,
      ms: entry.durationMs,
      in: entry.inputTokens,
      out: entry.outputTokens,
      total: entry.inputTokens + entry.outputTokens,
      tier: entry.tier,
      themes: entry.themes,
      ip: entry.ipHash,
    }),
  )

  if (pool) {
    pool
      .query(
        `INSERT INTO usage_events
           (ts, path, status, duration_ms, input_tokens, output_tokens, tier, themes, ip_hash)
         VALUES (to_timestamp($1 / 1000.0), $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.ts,
          entry.path,
          entry.status,
          entry.durationMs,
          entry.inputTokens,
          entry.outputTokens,
          entry.tier,
          entry.themes,
          entry.ipHash,
        ],
      )
      .catch(err => console.error('[usage] insert failed:', err?.message || err))
    return
  }

  memory.push(entry)
  if (memory.length > MEMORY_CAP) memory = memory.slice(-MEMORY_CAP)
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

// ---- In-memory aggregation (used when no DATABASE_URL) --------------------

function memoryDaily(sinceTs: number): DailyAggregate[] {
  const byDay = new Map<string, DailyAggregate & { _ips: Set<string> }>()
  for (const e of memory) {
    if (e.ts < sinceTs) continue
    const day = dayKey(e.ts)
    let agg = byDay.get(day)
    if (!agg) {
      agg = { day, requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, chat: 0, query: 0, uniqueIps: 0, _ips: new Set() }
      byDay.set(day, agg)
    }
    agg.requests += 1
    agg.inputTokens += e.inputTokens
    agg.outputTokens += e.outputTokens
    agg.totalTokens += e.inputTokens + e.outputTokens
    if (e.path === '/api/chat') agg.chat += 1
    else if (e.path === '/api/query') agg.query += 1
    agg._ips.add(e.ipHash)
  }
  return [...byDay.values()]
    .map(({ _ips, ...rest }) => ({ ...rest, uniqueIps: _ips.size }))
    .sort((a, b) => a.day.localeCompare(b.day))
}

function memoryThemes(sinceTs: number): ThemeCount[] {
  const counts = new Map<string, number>()
  for (const e of memory) {
    if (e.ts < sinceTs) continue
    for (const theme of e.themes) counts.set(theme, (counts.get(theme) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => b.count - a.count)
}

function memoryRecent(limit: number): RecentEntry[] {
  return memory
    .slice(-limit)
    .reverse()
    .map(e => ({
      ts: e.ts,
      path: e.path,
      status: e.status,
      durationMs: e.durationMs,
      totalTokens: e.inputTokens + e.outputTokens,
      tier: e.tier,
      themes: e.themes,
    }))
}

// ---- Postgres aggregation -------------------------------------------------

async function pgDaily(sinceTs: number): Promise<DailyAggregate[]> {
  const { rows } = await pool!.query(
    `SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS day,
            COUNT(*)::int                                AS requests,
            COALESCE(SUM(input_tokens),0)::int           AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int          AS output_tokens,
            COALESCE(SUM(input_tokens + output_tokens),0)::int AS total_tokens,
            COUNT(*) FILTER (WHERE path = '/api/chat')::int    AS chat,
            COUNT(*) FILTER (WHERE path = '/api/query')::int   AS query,
            COUNT(DISTINCT ip_hash)::int                 AS unique_ips
       FROM usage_events
      WHERE ts >= to_timestamp($1 / 1000.0)
      GROUP BY 1
      ORDER BY 1`,
    [sinceTs],
  )
  return rows.map(r => ({
    day: r.day,
    requests: r.requests,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    totalTokens: r.total_tokens,
    chat: r.chat,
    query: r.query,
    uniqueIps: r.unique_ips,
  }))
}

async function pgThemes(sinceTs: number): Promise<ThemeCount[]> {
  const { rows } = await pool!.query(
    `SELECT theme, COUNT(*)::int AS count
       FROM usage_events, unnest(themes) AS theme
      WHERE ts >= to_timestamp($1 / 1000.0)
      GROUP BY theme
      ORDER BY count DESC`,
    [sinceTs],
  )
  return rows.map(r => ({ theme: r.theme, count: r.count }))
}

async function pgRecent(limit: number): Promise<RecentEntry[]> {
  const { rows } = await pool!.query(
    `SELECT (EXTRACT(EPOCH FROM ts) * 1000)::bigint AS ts, path, status,
            duration_ms, (input_tokens + output_tokens) AS total_tokens, tier, themes
       FROM usage_events
      ORDER BY ts DESC
      LIMIT $1`,
    [limit],
  )
  return rows.map(r => ({
    ts: Number(r.ts),
    path: r.path,
    status: r.status,
    durationMs: r.duration_ms,
    totalTokens: Number(r.total_tokens),
    tier: r.tier,
    themes: r.themes ?? [],
  }))
}

export async function getDailyAggregates(days: number): Promise<DailyAggregate[]> {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000
  return pool ? pgDaily(sinceTs) : memoryDaily(sinceTs)
}

export async function getThemeCounts(days: number): Promise<ThemeCount[]> {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000
  return pool ? pgThemes(sinceTs) : memoryThemes(sinceTs)
}

export async function getRecent(limit: number): Promise<RecentEntry[]> {
  return pool ? pgRecent(limit) : memoryRecent(limit)
}

/** Test-only: reset the in-memory buffer between cases. */
export function _resetMemory(): void {
  memory = []
}
