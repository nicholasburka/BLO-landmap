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

/** Snapshot for observability / health endpoint. */
export function getUsageSnapshot() {
  rolloverIfNeeded()
  return {
    day: total.day,
    totalTokens: total.totalTokens,
    totalBudget: getTotalBudget(),
    perIpBudget: getPerIpBudget(),
    uniqueIps: perIp.size,
  }
}

/** Express middleware: reject 503 when either cap has been reached.
 *  Also stashes the client IP on res.locals so the route handler /
 *  haiku service can attribute usage back to the right bucket. */
export function dailyBudgetMiddleware(req: Request, res: Response, next: NextFunction): void {
  rolloverIfNeeded()

  const clientIp = getClientIp(req)
  res.locals.clientIp = clientIp

  if (total.totalTokens >= getTotalBudget()) {
    res.status(503).json({
      error: "We've hit today's usage cap. Please try again tomorrow.",
      code: 'daily_budget_exceeded',
    })
    return
  }

  if ((perIp.get(clientIp) || 0) >= getPerIpBudget()) {
    res.status(503).json({
      error: "You've reached today's usage cap on this device. Please try again tomorrow.",
      code: 'daily_budget_exceeded_per_ip',
    })
    return
  }

  next()
}
