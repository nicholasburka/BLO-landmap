/**
 * TLS settings for every Postgres pool this server opens (P5-19).
 *
 * The DB holds password hashes and live session rows, so the connection
 * VERIFIES the server certificate by default. Managed hosts with public CAs
 * (Neon, Supabase, Render) need no configuration; a host fronted by a
 * private CA (Railway's proxy) gets its chain pasted into PGSSL_CA.
 * PGSSL_NO_VERIFY=1 is the explicit, logged escape hatch — an on-path
 * attacker against an unverified connection reads everything.
 *
 * Env contract lives in DEPLOY.md; keep the two in step.
 */

/** Accepted by pg's PoolConfig.ssl. */
export type PgSslConfig = boolean | { ca: string } | { rejectUnauthorized: false }

// Warn once per process, not once per pool — libraryDb and usageStore both
// call this at boot and two identical scary lines read like two problems.
let warnedNoVerify = false
let warnedSslMode = false

/** Test hook: forget which one-shot warnings have already fired. */
export function _resetPgSslWarning(): void {
  warnedNoVerify = false
  warnedSslMode = false
}

/**
 * @param connectionString the DATABASE_URL the pool will use, when known —
 *   only so an `sslmode=` in it can be flagged (pg lets the URL parameter
 *   override what we pass here, which would silently undo a pinned CA).
 */
export function pgSslConfig(connectionString?: string): PgSslConfig {
  // A host on the platform's private network (`*.railway.internal`) has no TLS
  // endpoint at all — the wire never leaves the project's private network —
  // so asking for TLS there fails outright. Everything else keeps verifying.
  if (isPrivateNetworkHost(connectionString)) return false
  const ca = (process.env.PGSSL_CA || '').trim()
  const noVerify = process.env.PGSSL_NO_VERIFY === '1'

  if ((ca || noVerify) && connectionString && /[?&]sslmode=/i.test(connectionString) && !warnedSslMode) {
    warnedSslMode = true
    console.warn(
      '[pg] DATABASE_URL carries an sslmode= parameter, which pg applies on top of PGSSL_CA / ' +
        'PGSSL_NO_VERIFY — remove it so the TLS policy has exactly one source.',
    )
  }

  // A pinned CA is the stronger setting, so it wins over the escape hatch:
  // leaving PGSSL_NO_VERIFY set after adding a CA must not weaken anything.
  if (ca) {
    // Hosting dashboards flatten multi-line PEMs into a single line with
    // literal backslash-n; restore the real newlines OpenSSL needs.
    return { ca: ca.replace(/\\n/g, '\n') }
  }

  if (noVerify) {
    if (!warnedNoVerify) {
      warnedNoVerify = true
      console.warn(
        '[pg] PGSSL_NO_VERIFY=1 — the database certificate is NOT verified. ' +
          'Anyone on the network path can read session tokens and password hashes. ' +
          'Set PGSSL_CA instead and unset this.',
      )
    }
    return { rejectUnauthorized: false }
  }

  return true
}

/** `postgres.railway.internal` and friends: reachable only from inside the
 *  project, and served without TLS. */
export function isPrivateNetworkHost(connectionString?: string): boolean {
  if (!connectionString) return false
  try {
    return /\.railway\.internal$/i.test(new URL(connectionString).hostname)
  } catch {
    return false
  }
}
