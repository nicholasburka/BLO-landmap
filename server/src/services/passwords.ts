import argon2 from 'argon2'

/**
 * Password hashing, in one place (P5-76).
 *
 * Until now the admin CLI hashed with argon2 inline and the login route
 * verified with argon2 inline; adding a second writer of password_hash (the
 * account page) made "which parameters, which minimum length" a question two
 * files could answer differently. Everything that reads or writes a
 * library_users.password_hash goes through here.
 *
 * Defaults are argon2's own (argon2id, 19 MiB, t=2) — deliberately expensive,
 * which is what makes an offline crack of a leaked hash unattractive and what
 * makes the login endpoint's own rate limits meaningful.
 */

/** The floor for any new password. Enforced by the CLI and by the account
 *  page's change-password route, so a password set one way can always be
 *  used the other way. */
export const MIN_PASSWORD_LENGTH = 8

/** Upper bound, matching the login route's own cap on the field it verifies:
 *  argon2 hashes whatever it is handed, so an unbounded field is a cheap way
 *  to make the server do expensive work. Far above any real passphrase. */
export const MAX_PASSWORD_LENGTH = 256

/** Hash a new password for storage. The salt and parameters travel inside
 *  the returned string, so an older hash keeps verifying after a parameter
 *  change. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password)
}

/**
 * Check a password against a stored hash. Never throws: a malformed or
 * truncated hash column is a failed verification, not a 500 — the caller's
 * only correct response either way is "those credentials don't work".
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password).catch(() => false)
}
