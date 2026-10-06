import Anthropic from '@anthropic-ai/sdk'
import { askModel, type AnthropicLike } from './askKb.js'
import { estimateRequestTokens, reserveUsage, settleReservation } from '../middleware/budget.js'

/**
 * One metered call to the model, for the passes that are not a conversation
 * (P5-61).
 *
 * P5-47's filing suggestion and P5-61's link prune do the same five things —
 * build a client lazily, reserve a budget, ask once, settle what it actually
 * cost, and turn a failure into "we could not ask" rather than an exception.
 * They were about to be the same forty lines twice, so they are these forty
 * lines once. Everything specific (the prompt, the schema, what counts as a
 * usable answer) stays with the pass that owns it.
 *
 * A failure is ALWAYS a value, never a throw: both callers are on a path where
 * the work stands without the model (the drop still happened, the link was
 * still classified), and an exception there would cost the person their real
 * result to report a missing optional one. It is a value rather than a bare
 * `null` because "why is this unranked?" is a question the entry has to be
 * able to answer — a silent fallback is a bug report nobody can act on.
 */

export type { AnthropicLike }

let defaultClient: AnthropicLike | null = null

/**
 * Built lazily (not at import) and never cached when it throws, so a server
 * with no API key answers "unavailable" instead of failing to boot.
 */
export function getAssistantClient(): AnthropicLike {
  if (!defaultClient) defaultClient = new Anthropic() as unknown as AnthropicLike
  return defaultClient
}

/** For tests, which share one process. */
export function resetAssistantClient(): void {
  defaultClient = null
}

/**
 * Is a key configured at all?
 *
 * Asked BEFORE building a prompt by the passes that have a real fallback
 * (P5-61's unranked candidate list): with no key the call is a guaranteed
 * failure, and paying to serialise 80 candidates into a message nobody will
 * send is just latency.
 */
export function hasApiKey(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY ?? '').trim()
}

/** The text blocks of an answer, joined. Tool blocks and thinking are not
 *  what a single-shot JSON pass is asking for. */
export function textOf(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim()
}

/** Strip a ```json fence and any prose either side of the object. */
export function jsonObjectIn(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface AssistantCallInput {
  /** What to name in the warning when it fails ("link prune for <url>"). */
  label: string
  system: string
  user: string
  maxTokens: number
  /** Tests pass a stub; nothing else passes anything. */
  client?: AnthropicLike
  /** The acting user's IP, so the spend is attributed to them (P5-41). */
  clientIp?: string
  model?: string
}

export interface AssistantAnswer {
  text: string
  /** Which model answered, recorded alongside whatever it produced. */
  model: string
  /**
   * Why the model stopped. `max_tokens` is the one that matters: the answer
   * is a TRUNCATED document, so a JSON parse failure downstream is a cap
   * problem and not a model that ignored the schema.
   */
  stopReason?: string
}

/**
 * Why a model call could not be answered, in four codes (P5-75).
 *
 * The sentences below are for a log and an entry; this is for a wire. Only an
 * admin is shown it, and only because the four cases need four different
 * actions: set a key, fix the billing, wait a minute, or wait for Anthropic.
 * Everyone else gets "the model is unavailable", which is all they can act on.
 */
export type AssistantFailureCode = 'no-key' | 'refused' | 'rate-limited' | 'model-error'

/** The three reasons that map to a code of their own; everything else is a
 *  `model-error`. Named because `failureCode` matches on them exactly. */
export const NO_KEY_REASON = 'no ANTHROPIC_API_KEY is configured'
export const REFUSED_REASON = 'the API key was refused'
export const RATE_LIMITED_REASON = 'the model was rate-limited'

export interface AssistantError {
  /** Short enough to store on an entry and show to a person. */
  error: string
  /** The same failure as a code, for a caller that has to branch on it. */
  code: AssistantFailureCode
}

export function isAssistantError(value: AssistantAnswer | AssistantError): value is AssistantError {
  return typeof (value as AssistantError).error === 'string'
}

/**
 * An SDK error in a few words a reader can act on.
 *
 * The raw message is a stack-adjacent sentence with a request id in it; what
 * the entry needs is "the model was rate-limited", so it can say so and a
 * person can press the button again in a minute.
 *
 * "No key" and "key refused" used to share one sentence. They are opposite
 * problems — one is an unconfigured server, the other is an account out of
 * credit — so they are told apart here, by the only thing that can tell them
 * apart: whether a key is set at all.
 */
export function failureReason(err: any): string {
  const status = Number(err?.status ?? err?.statusCode)
  const message = String(err?.message ?? err ?? '').slice(0, 200)
  if (status === 401 || status === 403 || /authentication|api[- ]key|x-api-key|credential/i.test(message)) {
    return hasApiKey() ? REFUSED_REASON : NO_KEY_REASON
  }
  // Out of credit comes back as a 400 invalid_request_error, not an auth
  // status — but it is the account, not the request, that is the problem,
  // and the admin sentence ("check billing or the key") is the right one.
  if (/credit balance|billing|purchase credits|insufficient (credit|funds)|payment required/i.test(message) || status === 402) {
    return REFUSED_REASON
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(message)) return RATE_LIMITED_REASON
  if (status === 529 || /overloaded/i.test(message)) return 'the model was overloaded'
  if (status === 400 || /invalid_request|too long|exceeds|max.?tokens/i.test(message)) {
    return `the request was refused: ${message}`
  }
  if (/timeout|timed out|ETIMEDOUT|abort/i.test(message)) return 'the model call timed out'
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(message)) return 'could not reach the model'
  return message || 'the model call failed'
}

/**
 * A `failureReason` sentence as a code. THE one place the two vocabularies
 * meet — Ask, the filing suggestion and the link prune all classify here, so
 * a new reason is added in one file and every surface says the same thing.
 */
export function failureCode(reason: string): AssistantFailureCode {
  if (reason === NO_KEY_REASON) return 'no-key'
  if (reason === REFUSED_REASON) return 'refused'
  if (reason === RATE_LIMITED_REASON) return 'rate-limited'
  return 'model-error'
}

/** A thrown SDK error as both halves at once: the sentence we log and store,
 *  and the code an admin's browser branches on. */
export function failureOf(err: unknown): { reason: string; code: AssistantFailureCode } {
  const reason = failureReason(err)
  return { reason, code: failureCode(reason) }
}

/**
 * Ask once, metered. An `{ error }` when there was no answer we can use — no
 * key, a rate limit, a model error, or an empty body — with a reason short
 * enough for the caller to store and show.
 */
export async function callAssistant(input: AssistantCallInput): Promise<AssistantAnswer | AssistantError> {
  const model = input.model ?? askModel()
  const clientIp = input.clientIp || 'unknown'
  const reserved = estimateRequestTokens(input.user, input.maxTokens)
  reserveUsage(clientIp, reserved)
  try {
    const client = input.client ?? getAssistantClient()
    const message = await client.messages.create({
      model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    })
    settleReservation(clientIp, reserved, (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0))
    const text = textOf(message)
    if (!text) {
      // Logged, because this case left no trace at all and cost an hour to
      // find: a reasoning model can spend the whole output budget on its
      // thinking block and emit no text block, which arrives here as an
      // ordinary `model-error` indistinguishable from a transport failure.
      // `stop_reason` is the tell — `max_tokens` means raise the caller's cap.
      console.warn(
        `[library] the model answered with no text for ${input.label} — stop_reason ${message.stop_reason ?? 'unknown'}, ` +
          `max_tokens ${input.maxTokens}`,
      )
      return { error: 'the model answered with nothing', code: 'model-error' }
    }
    return { text, model, ...(message.stop_reason ? { stopReason: String(message.stop_reason) } : {}) }
  } catch (err: any) {
    // No API key, a model error, a rate limit: the caller's real work stands,
    // the model's contribution simply is not there.
    settleReservation(clientIp, reserved, 0)
    const { reason, code } = failureOf(err)
    console.warn('[library] model unavailable for', input.label, '—', reason)
    return { error: reason, code }
  }
}
