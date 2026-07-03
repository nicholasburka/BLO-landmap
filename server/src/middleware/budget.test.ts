import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

/** Budget module keeps day-scoped counters in module state, so each test
 *  imports a fresh copy. */
async function freshBudget() {
  vi.resetModules()
  return await import('./budget.js')
}

function mockReqRes(body: unknown = {}, authTier?: string) {
  const req = { body, ip: '203.0.113.7', socket: { remoteAddress: '203.0.113.7' } } as unknown as Request
  const res = {
    locals: authTier ? { authTier } : {},
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.payload = payload
      return this
    },
  }
  const next = vi.fn() as unknown as NextFunction
  return { req, res: res as unknown as Response & typeof res, next }
}

const savedEnv = { ...process.env }
beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  process.env = { ...savedEnv }
  vi.restoreAllMocks()
})

describe('estimateRequestTokens', () => {
  it('charges ~chars/4 plus the output ceiling', async () => {
    const { estimateRequestTokens } = await freshBudget()
    const body = { messages: 'x'.repeat(4000) }
    const estimate = estimateRequestTokens(body, 2048)
    expect(estimate).toBeGreaterThan(1000 + 2048)
    expect(estimate).toBeLessThan(1100 + 2048)
  })
})

describe('reserve / settle', () => {
  it('reservation counts against the caps and settles down to actuals', async () => {
    const budget = await freshBudget()
    budget.reserveUsage('1.2.3.4', 10_000)
    expect(budget.getUsageSnapshot().totalTokens).toBe(10_000)
    budget.settleReservation('1.2.3.4', 10_000, 1_500)
    expect(budget.getUsageSnapshot().totalTokens).toBe(1_500)
  })

  it('a failed call releases the whole reservation', async () => {
    const budget = await freshBudget()
    budget.reserveUsage('1.2.3.4', 8_000)
    budget.settleReservation('1.2.3.4', 8_000, 0)
    expect(budget.getUsageSnapshot().totalTokens).toBe(0)
  })
})

describe('dailyBudgetMiddleware', () => {
  it('rejects a request whose own estimate exceeds the per-IP cap', async () => {
    process.env.DAILY_BUDGET_TOKENS_PER_IP = '1000'
    const { dailyBudgetMiddleware } = await freshBudget()
    const { req, res, next } = mockReqRes({ big: 'y'.repeat(20_000) })
    dailyBudgetMiddleware(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
    expect((res.payload as { code: string }).code).toBe('daily_budget_exceeded_per_ip')
  })

  it('reserves the estimate so concurrent requests cannot all slip under the cap', async () => {
    // Each tiny request reserves ~2050 tokens (output ceiling dominates);
    // a 4000 cap admits one reservation but not two.
    process.env.DAILY_BUDGET_TOKENS = '4000'
    const budget = await freshBudget()
    const first = mockReqRes({ q: 'hello' })
    budget.dailyBudgetMiddleware(first.req, first.res, first.next)
    expect(first.next).toHaveBeenCalled()
    expect(first.res.locals.budgetReservation as number).toBeGreaterThan(2048)
    // Second identical request: cap already consumed by the reservation.
    const second = mockReqRes({ q: 'hello' })
    budget.dailyBudgetMiddleware(second.req, second.res, second.next)
    expect(second.next).not.toHaveBeenCalled()
    expect(second.res.statusCode).toBe(503)
  })

  it('staging tier bypasses the caps with no reservation', async () => {
    process.env.DAILY_BUDGET_TOKENS = '1'
    const { dailyBudgetMiddleware } = await freshBudget()
    const { req, res, next } = mockReqRes({ q: 'hello' }, 'staging')
    dailyBudgetMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.locals.budgetReservation).toBe(0)
  })

  it('BUDGET_BYPASS works outside production', async () => {
    process.env.BUDGET_BYPASS = 'true'
    delete process.env.NODE_ENV
    process.env.DAILY_BUDGET_TOKENS = '1'
    const { dailyBudgetMiddleware } = await freshBudget()
    const { req, res, next } = mockReqRes({ q: 'hello' })
    dailyBudgetMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('BUDGET_BYPASS is ignored when NODE_ENV=production', async () => {
    process.env.BUDGET_BYPASS = 'true'
    process.env.NODE_ENV = 'production'
    process.env.DAILY_BUDGET_TOKENS = '1'
    const { dailyBudgetMiddleware } = await freshBudget()
    const { req, res, next } = mockReqRes({ q: 'hello' })
    dailyBudgetMiddleware(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(503)
  })
})
