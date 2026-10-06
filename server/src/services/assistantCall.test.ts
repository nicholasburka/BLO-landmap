import { describe, it, expect, vi, afterEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

/**
 * P5-75: the one place an SDK failure becomes a code.
 *
 * Ask, the filing suggestion and the link prune all classify here, so this is
 * where the four codes are pinned down. The pair that matters most is
 * `no-key` against `refused`: they arrive as the same 401 and mean opposite
 * things — an unconfigured server against an account out of credit — and only
 * the presence of a key tells them apart.
 */

const {
  callAssistant,
  failureReason,
  failureCode,
  failureOf,
  isAssistantError,
  NO_KEY_REASON,
  REFUSED_REASON,
  RATE_LIMITED_REASON,
} = await import('./assistantCall.js')
type AnthropicLike = import('./askKb.js').AnthropicLike

const KEY = process.env.ANTHROPIC_API_KEY

afterEach(() => {
  if (KEY === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = KEY
})

function withKey(): void {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
}

function withoutKey(): void {
  delete process.env.ANTHROPIC_API_KEY
}

function sdkError(message: string, status?: number): Error {
  const err: any = new Error(message)
  if (status !== undefined) err.status = status
  return err
}

function textTurn(text: string): Anthropic.Messages.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: text ? [{ type: 'text', text, citations: null }] : [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Messages.Message
}

function stubClient(turn: Anthropic.Messages.Message | Error): AnthropicLike {
  const create = vi.fn()
  if (turn instanceof Error) create.mockRejectedValue(turn)
  else create.mockResolvedValue(turn)
  return { messages: { create } } as unknown as AnthropicLike
}

function ask(client: AnthropicLike) {
  return callAssistant({ label: 'test pass', system: 'be brief', user: 'hello', maxTokens: 50, client })
}

describe('failureReason', () => {
  it('treats an exhausted credit balance as a refused key, not a bad request (P5-75)', () => {
    const err = Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}'), { status: 400 })
    expect(failureOf(err)).toEqual({ reason: REFUSED_REASON, code: 'refused' })
    expect(failureOf(Object.assign(new Error('Payment Required'), { status: 402 })).code).toBe('refused')
  })

  it('tells a missing key apart from a refused one, which is the whole point', () => {
    withoutKey()
    expect(failureReason(sdkError('authentication_error', 401))).toBe(NO_KEY_REASON)
    withKey()
    expect(failureReason(sdkError('authentication_error', 401))).toBe(REFUSED_REASON)
    // 403 and a bare message with no status reach the same branch.
    expect(failureReason(sdkError('permission denied', 403))).toBe(REFUSED_REASON)
    expect(failureReason(sdkError('invalid x-api-key'))).toBe(REFUSED_REASON)
  })

  it('still says the other failures in words a reader can act on', () => {
    withKey()
    expect(failureReason(sdkError('rate_limit_error', 429))).toBe(RATE_LIMITED_REASON)
    expect(failureReason(sdkError('overloaded_error', 529))).toBe('the model was overloaded')
    expect(failureReason(sdkError('socket hang up: fetch failed'))).toBe('could not reach the model')
    expect(failureReason(sdkError('the request timed out'))).toBe('the model call timed out')
    expect(failureReason(sdkError('something odd'))).toBe('something odd')
  })
})

describe('failureCode', () => {
  it('maps every sentence with a code of its own, and nothing else', () => {
    expect(failureCode(NO_KEY_REASON)).toBe('no-key')
    expect(failureCode(REFUSED_REASON)).toBe('refused')
    expect(failureCode(RATE_LIMITED_REASON)).toBe('rate-limited')
    expect(failureCode('the model was overloaded')).toBe('model-error')
    expect(failureCode('could not reach the model')).toBe('model-error')
    expect(failureCode('the request was refused: max_tokens too large')).toBe('model-error')
    expect(failureCode('anything at all')).toBe('model-error')
  })
})

describe('failureOf', () => {
  it('hands back the sentence we log and the code a client branches on', () => {
    withoutKey()
    expect(failureOf(sdkError('authentication_error', 401))).toEqual({ reason: NO_KEY_REASON, code: 'no-key' })
    withKey()
    expect(failureOf(sdkError('rate_limit_error', 429))).toEqual({ reason: RATE_LIMITED_REASON, code: 'rate-limited' })
  })
})

describe('callAssistant', () => {
  it('carries the code next to the sentence when the call fails', async () => {
    withKey()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await ask(stubClient(sdkError('rate_limit_error', 429)))
    expect(isAssistantError(result)).toBe(true)
    expect(result).toMatchObject({ error: RATE_LIMITED_REASON, code: 'rate-limited' })
    warn.mockRestore()
  })

  it('calls an empty answer a model error, because a key that answers is configured', async () => {
    withKey()
    const result = await ask(stubClient(textTurn('')))
    expect(result).toEqual({ error: 'the model answered with nothing', code: 'model-error' })
  })

  it('says "no key" when nothing is configured, even though the SDK says 401', async () => {
    withoutKey()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await ask(stubClient(sdkError('Could not resolve authentication method', 401)))
    expect(result).toMatchObject({ error: NO_KEY_REASON, code: 'no-key' })
    warn.mockRestore()
  })

  it('a usable answer carries no code at all', async () => {
    withKey()
    const result = await ask(stubClient(textTurn('{"ok": true}')))
    expect(isAssistantError(result)).toBe(false)
    expect(result).toMatchObject({ text: '{"ok": true}' })
    expect((result as Record<string, unknown>).code).toBeUndefined()
  })
})
