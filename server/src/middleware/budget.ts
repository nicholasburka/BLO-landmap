import type { Request, Response, NextFunction } from 'express'

/**
 * Two-layer Anthropic token budget:
 *
 *   - Total daily cap (DAILY_BUDGET_TOKENS, default 200_000) protects the
 *     wallet. Hard ceiling across all traffic.
 *   - Per-IP daily cap (DAILY_BUDGET_TOKENS_PER_IP, default 15_000) stops
 *     one abusive user from exhausting the whole quota for everyone else.
 *
 * Both reset at UTC midnight. Whichever cap trips first wins.
 *
 * In-memory only — fine for a single Railway instance. If we scale out,
 * move both counters to Redis.
 */

const DEFAULT_DAILY_BUDGET_TOKENS = 200_000
const DEFAULT_DAILY_BUDGET_TOKENS_PER_IP = 15_000

/** Ceiling used when estimating a request's output cost before the call.
 *  Matches the largest max_tokens any route passes to Anthropic (chat). */
const MAX_OUTPUT_TOKENS_ESTIMATE = 2_048

interface TotalSnapshot {
  /** YYYY-MM-DD in UTC */
  day: string
  totalTokens: number
}

let total: TotalSnapshot = { day: currentDayKey(), totalTokens: 0 }
let perIp = new Map<string, number>()

function currentDayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function rolloverIfNeeded(): void {
  const today = currentDayKey()
  if (total.day !== today) {
    total = { day: today, totalTokens: 0 }
    perIp = new Map()
  }
}

function getTotalBudget(): number {
  return parsePositiveInt(process.env.DAILY_BUDGET_TOKENS, DEFAULT_DAILY_BUDGET_TOKENS)
}

function getPerIpBudget(): number {
  return parsePositiveInt(process.env.DAILY_BUDGET_TOKENS_PER_IP, DEFAULT_DAILY_BUDGET_TOKENS_PER_IP)
}

/** Local-dev escape hatch. Set BUDGET_BYPASS=1 (or true) in your
 *  server .env to skip both the per-IP and total daily cap checks
 *  while still recording usage for observability. Intended ONLY for
 *  local development — production deployments must leave this unset
 *  so the wallet-protection layer stays armed. The middleware logs
 *  a one-time banner at first hit so you can see in the server log
 *  that you're running uncapped. */
function isBypassEnabled(): boolean {
  const v = (process.env.BUDGET_BYPASS || '').trim().toLowerCase()
  const requested = v === '1' || v === 'true' || v === 'yes' || v === 'on'
  // Hard-disabled in production no matter what the env says — the global
  // bypass is a local-dev tool only, and a copy-pasted .env must not be
  // able to run a public deployment uncapped.
  if (requested && process.env.NODE_ENV === 'production') {
    logBypassIgnoredOnce()
    return false
  }
  return requested
}

let bypassIgnoredWarned = false
function logBypassIgnoredOnce(): void {
  if (bypassIgnoredWarned) return
  bypassIgnoredWarned = true
  console.warn('[budget] BUDGET_BYPASS is set but NODE_ENV=production — ignoring it. Caps stay enforced.')
}

let bypassWarned = false
function logBypassOnce(): void {
  if (bypassWarned) return
  bypassWarned = true
  // eslint-disable-next-line no-console
  console.warn(
    '[budget] BUDGET_BYPASS is enabled — daily token caps disabled. ' +
      'Usage is still recorded but limits are not enforced. Do NOT ship with this set.',
  )
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Best-effort client IP — Express's req.ip already handles X-Forwarded-For
 *  when `trust proxy` is set (Railway sets it via standard headers). */
function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

/** Called by the haiku service after each successful Anthropic call. */
export function recordUsage(clientIp: string, inputTokens: number, outputTokens: number): void {
  rolloverIfNeeded()
  const used = (inputTokens || 0) + (outputTokens || 0)
  total.totalTokens += used
  perIp.set(clientIp, (perIp.get(clientIp) || 0) + used)
}

/** Rough pre-request cost estimate: serialized request body at ~4 chars
 *  per token, plus the response's max_tokens ceiling. Deliberately
 *  pessimistic — settleReservation reconciles to actuals afterward. */
export function estimateRequestTokens(body: unknown, maxOutputTokens: number): number {
  let inputChars = 0
  try {
    inputChars = JSON.stringify(body)?.length ?? 0
  } catch {
    inputChars = 0
  }
  return Math.ceil(inputChars / 4) + maxOutputTokens
}

/** Reserve estimated tokens against both counters before the Anthropic
 *  call. Without this, a fresh IP always clears the gate no matter how
 *  expensive its request is, and concurrent requests all pass before any
 *  of them record — either way overshooting the caps. */
export function reserveUsage(clientIp: string, tokens: number): void {
  rolloverIfNeeded()
  total.totalTokens += tokens
  perIp.set(clientIp, (perIp.get(clientIp) || 0) + tokens)
}

/** Replace a reservation with actual usage once the call finishes (or
 *  release it entirely on failure by passing actualTokens = 0). */
export function settleReservation(clientIp: string, reservedTokens: number, actualTokens: number): void {
  rolloverIfNeeded()
  const delta = actualTokens - reservedTokens
  total.totalTokens = Math.max(0, total.totalTokens + delta)
  perIp.set(clientIp, Math.max(0, (perIp.get(clientIp) || 0) + delta))
}

/** Snapshot for observability / health endpoint. */
export function getUsageSnapshot() {
  rolloverIfNeeded()
  return {
    day: total.day,
    totalTokens: total.totalTokens,
    totalBudget: getTotalBudget(),
    perIpBudget: getPerIpBudget(),
    uniqueIps: perIp.size,
    bypassEnabled: isBypassEnabled(),
  }
}

/** Express middleware: reject 503 when either cap has been reached.
 *  Also stashes the client IP on res.locals so the route handler /
 *  haiku service can attribute usage back to the right bucket.
 *
 *  Two bypass paths:
 *    1. BUDGET_BYPASS env (local dev) — global, no auth required.
 *    2. authTier === 'staging' — per-request, set by authMiddleware
 *       when the user authenticated with STAGING_PASSWORD. Lets PM
 *       testing run uncapped on a shared staging site without
 *       opening the global bypass to anonymous traffic.
 *  Usage is still recorded in both cases for observability. */
export function dailyBudgetMiddleware(req: Request, res: Response, next: NextFunction): void {
  rolloverIfNeeded()

  const clientIp = getClientIp(req)
  res.locals.clientIp = clientIp
  res.locals.budgetReservation = 0

  if (isBypassEnabled()) {
    logBypassOnce()
    next()
    return
  }

  // Staging-tier users (authenticated with STAGING_PASSWORD) bypass
  // the cap. authMiddleware stamps res.locals.authTier upstream of
  // this middleware on protected routes.
  if (res.locals.authTier === 'staging') {
    next()
    return
  }

  // Reserve the estimated cost up front so the gate accounts for this
  // request's own size and for concurrent in-flight requests. The route
  // settles the reservation to actual usage when the call completes.
  const estimate = estimateRequestTokens(req.body, MAX_OUTPUT_TOKENS_ESTIMATE)

  if (total.totalTokens + estimate > getTotalBudget()) {
    res.status(503).json({
      error: "We've hit today's usage cap. Please try again tomorrow.",
      code: 'daily_budget_exceeded',
    })
    return
  }

  if ((perIp.get(clientIp) || 0) + estimate > getPerIpBudget()) {
    res.status(503).json({
      error: "You've reached today's usage cap on this device. Please try again tomorrow.",
      code: 'daily_budget_exceeded_per_ip',
    })
    return
  }

  reserveUsage(clientIp, estimate)
  res.locals.budgetReservation = estimate
  next()
}
