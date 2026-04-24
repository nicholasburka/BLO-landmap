import type { Request, Response, NextFunction } from 'express'

/**
 * Daily Anthropic token budget middleware.
 *
 * In-memory counter that resets at UTC midnight. Pre-flight check: if the
 * current total has already exceeded DAILY_BUDGET_TOKENS we reject with 503
 * before calling Anthropic. Usage is recorded post-flight by the haiku service.
 *
 * Limitations:
 * - Process-local only (not shared across multiple Railway instances). For
 *   a single instance that's fine; if we scale out, move to Redis.
 * - One request can still push us slightly past the cap (we check before, not
 *   after). Acceptable for a soft ceiling.
 */

const DEFAULT_DAILY_BUDGET_TOKENS = 200_000

interface UsageSnapshot {
  /** YYYY-MM-DD in UTC */
  day: string
  totalTokens: number
}

let current: UsageSnapshot = { day: currentDayKey(), totalTokens: 0 }

function currentDayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function rolloverIfNeeded(): void {
  const today = currentDayKey()
  if (current.day !== today) {
    current = { day: today, totalTokens: 0 }
  }
}

function getBudget(): number {
  const raw = process.env.DAILY_BUDGET_TOKENS
  if (!raw) return DEFAULT_DAILY_BUDGET_TOKENS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_BUDGET_TOKENS
}

/** Called by the haiku service after each successful Anthropic call. */
export function recordUsage(inputTokens: number, outputTokens: number): void {
  rolloverIfNeeded()
  current.totalTokens += (inputTokens || 0) + (outputTokens || 0)
}

/** Snapshot for observability / health endpoint. */
export function getUsageSnapshot(): UsageSnapshot & { budget: number } {
  rolloverIfNeeded()
  return { ...current, budget: getBudget() }
}

/** Express middleware: reject with 503 when today's total has exceeded the cap. */
export function dailyBudgetMiddleware(_req: Request, res: Response, next: NextFunction): void {
  rolloverIfNeeded()
  const budget = getBudget()
  if (current.totalTokens >= budget) {
    res.status(503).json({
      error: "We've hit today's usage cap. Please try again tomorrow.",
      code: 'daily_budget_exceeded',
    })
    return
  }
  next()
}
