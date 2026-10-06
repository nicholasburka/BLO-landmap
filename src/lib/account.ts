/**
 * Client helpers for your own account (P5-76): changing your password.
 *
 * The server owns the real rules — it verifies the current password with the
 * same hash the login uses and enforces the length itself. What lives here is
 * the copy the form shows and the two checks worth making before a round trip:
 * a too-short new password, and a confirm box that does not match (the server
 * never sees the confirm field at all, so that one can only be caught here).
 *
 * The call rides the internal session cookie + CSRF (internalFetch), so it is
 * unreachable without being logged in as the account being changed.
 */

import { internalFetch } from './apiBase'

/** Mirrors the server's minimum (services/passwords.ts). The server still
 *  enforces it — this only saves a round trip and shows the same sentence. */
export const MIN_PASSWORD_LENGTH = 8

export interface PasswordChangeResult {
  ok: true
  /** How many other live sessions were signed out — usually 0. */
  signedOutOthers: number
}

/**
 * Check what the form can check on its own. Returns the message to show, or
 * null when the change is worth sending.
 *
 * The sentences match the server's byte for byte where both can produce them,
 * so a user never sees the same problem worded two ways.
 */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): string | null {
  if (!current) return 'Enter your current password.'
  if (next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (next === current) return 'Your new password must be different from your current one.'
  if (next !== confirm) return 'The new passwords do not match.'
  return null
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    if (typeof body?.error === 'string' && body.error) return body.error
  } catch {
    // non-JSON body — fall through
  }
  return fallback
}

/**
 * Change the password. On success every OTHER session for the account is
 * signed out; this one survives, so the page the user is on keeps working.
 *
 * Rejects with the server's own sentence ("That is not your current
 * password.") — those are written to be shown to the person as-is.
 */
export async function changePassword(
  current: string,
  next: string,
): Promise<PasswordChangeResult> {
  const res = await internalFetch('/api/account/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current, next }),
  })
  if (!res.ok) {
    throw new Error(await errorMessage(res, `Failed to change the password (${res.status})`))
  }
  const body = (await res.json()) as { signedOutOthers?: number }
  return { ok: true, signedOutOthers: body.signedOutOthers ?? 0 }
}
