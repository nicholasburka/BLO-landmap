import { describe, it, expect } from 'vitest'
import argon2 from 'argon2'
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, hashPassword, verifyPassword } from './passwords.js'

/**
 * The one place passwords are hashed (P5-76). The CLI and the account page's
 * change-password route both call this, so a change here changes both.
 */

describe('hashPassword', () => {
  it('produces an argon2id hash that verifies, and salts each one separately', async () => {
    const first = await hashPassword('hunter2hunter2')
    const second = await hashPassword('hunter2hunter2')
    expect(first.startsWith('$argon2id$')).toBe(true)
    // Same password, different stored strings: a leaked table cannot be
    // scanned for accounts that share a password.
    expect(first).not.toBe(second)
    expect(await argon2.verify(first, 'hunter2hunter2')).toBe(true)
  })

  it('never stores the plaintext', async () => {
    const hash = await hashPassword('correct-horse-battery')
    expect(hash).not.toContain('correct-horse-battery')
  })
})

describe('verifyPassword', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('hunter2hunter2')
    expect(await verifyPassword(hash, 'hunter2hunter2')).toBe(true)
    expect(await verifyPassword(hash, 'hunter2hunter3')).toBe(false)
    expect(await verifyPassword(hash, '')).toBe(false)
  })

  it('verifies a hash made with cheaper parameters (they travel in the string)', async () => {
    const cheap = await argon2.hash('hunter2hunter2', { timeCost: 2, memoryCost: 2048, parallelism: 1 })
    expect(await verifyPassword(cheap, 'hunter2hunter2')).toBe(true)
    expect(await verifyPassword(cheap, 'nope')).toBe(false)
  })

  it('returns false rather than throwing on a corrupt hash column', async () => {
    expect(await verifyPassword('not-a-hash', 'hunter2hunter2')).toBe(false)
    expect(await verifyPassword('', 'hunter2hunter2')).toBe(false)
  })
})

describe('the shared limits', () => {
  it('are the ones the CLI and the account route both quote', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8)
    expect(MAX_PASSWORD_LENGTH).toBe(256)
  })
})
