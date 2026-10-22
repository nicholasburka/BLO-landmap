import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  WELCOME_KEY,
  hasSeenWelcome,
  markWelcomeSeen,
  hasDestination,
  hasConversation,
  shouldShowWelcome,
} from '../welcome'

/**
 * P15-3 — when the welcome may appear, and the half that matters: when it
 * may not.
 *
 * The card this replaces checked localStorage and nothing else, so a shared
 * `/?layers=…&fit=…` link opened by a first-time visitor rendered a welcome
 * screen over the answer they were sent — and `smoke.cy.ts` pressed "Got it"
 * before every interaction to work around it.
 */
describe('shouldShowWelcome (P15-3)', () => {
  beforeEach(() => localStorage.clear())
  // Braces, not a concise body: `vi.restoreAllMocks()` returns the Vitest
  // utils object, and an arrow that returns it hands Vitest a value where a
  // hook wants `void`. `tsconfig.app.json` excludes `src/**/__tests__/*`, so
  // the gate used all phase never saw it — `npm run type-check` does.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A persisted thread in the shape `useChat` writes (`useChat.ts:380-388`). */
  function storeConversation(
    overrides: { v?: number; savedAt?: number; messages?: unknown[] } = {},
  ): void {
    localStorage.setItem(
      'blo:conversation',
      JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        messages: [{ role: 'user', content: 'hi' }],
        ...overrides,
      }),
    )
  }

  it('shows on a bare first visit', () => {
    expect(shouldShowWelcome({})).toBe(true)
  })

  it('does not show once it has been seen', () => {
    markWelcomeSeen()
    expect(hasSeenWelcome()).toBe(true)
    expect(shouldShowWelcome({})).toBe(false)
  })

  it('never covers a link that asked for something specific', () => {
    for (const param of ['layers', 'focus', 'fit', 'view', 'set']) {
      expect(shouldShowWelcome({ [param]: 'something' }), param).toBe(false)
    }
  })

  it('does not count an empty or absent param as a destination', () => {
    expect(hasDestination({})).toBe(false)
    expect(hasDestination({ layers: '' })).toBe(false)
    expect(hasDestination({ layers: null })).toBe(false)
    expect(hasDestination({ layers: [] })).toBe(false)
    expect(hasDestination({ layers: [null] })).toBe(false)
    // Repeated params are how vue-router hands over `?layers=a&layers=b`.
    expect(hasDestination({ layers: ['pct_Black', 'contamination'] })).toBe(true)
  })

  it('leaves the flag alone for a destination visit, so a bare visit still shows it', () => {
    expect(shouldShowWelcome({ fit: '47157' })).toBe(false)
    // Nothing was written: they have not seen it.
    expect(localStorage.getItem(WELCOME_KEY)).toBeNull()
    expect(shouldShowWelcome({})).toBe(true)
  })

  it('counts the key as seen whatever value it carries', () => {
    // The rule is "`blo:welcome:v2` is set", not "is exactly 1". A browser
    // carrying it with some other value has still seen this screen.
    localStorage.setItem(WELCOME_KEY, 'seen-2026-10-22')
    expect(hasSeenWelcome()).toBe(true)
    expect(shouldShowWelcome({})).toBe(false)
  })

  it('does not interrupt a conversation restored from a previous visit', () => {
    storeConversation({ savedAt: Date.now() })
    expect(hasConversation()).toBe(true)
    expect(shouldShowWelcome({})).toBe(false)
  })

  /**
   * The question is whether `useChat` would RESTORE the thread, not whether
   * something is parked under the key. It drops the key unhydrated outside a
   * 7-day window and off its schema version (`useChat.ts:398-426`) — so a
   * stale thread that suppressed the welcome left a returning visitor with
   * neither their conversation nor the screen that explains the map.
   */
  it('ignores a conversation too old for useChat to restore', () => {
    const eightDays = 8 * 24 * 60 * 60 * 1000
    storeConversation({ savedAt: Date.now() - eightDays })
    expect(hasConversation()).toBe(false)
    expect(shouldShowWelcome({})).toBe(true)
  })

  it('ignores a conversation useChat would reject on schema version', () => {
    storeConversation({ v: 0, savedAt: Date.now() })
    expect(hasConversation()).toBe(false)
    expect(shouldShowWelcome({})).toBe(true)
  })

  it('ignores a conversation with no savedAt, which useChat also drops', () => {
    localStorage.setItem('blo:conversation', JSON.stringify({ v: 1, messages: [{ role: 'user' }] }))
    expect(hasConversation()).toBe(false)
    expect(shouldShowWelcome({})).toBe(true)
  })

  it('treats an empty, corrupt or unreadable conversation as no conversation', () => {
    storeConversation({ savedAt: Date.now(), messages: [] })
    expect(hasConversation()).toBe(false)

    // `useChat` filters these out before it restores anything, so a thread of
    // nothing but junk is a thread of nothing.
    storeConversation({ savedAt: Date.now(), messages: [null, 'hello', { role: 'system' }] })
    expect(hasConversation()).toBe(false)

    localStorage.setItem('blo:conversation', 'not json')
    expect(hasConversation()).toBe(false)
    expect(shouldShowWelcome({})).toBe(true)
  })

  it('shows, rather than throwing, when localStorage is denied', () => {
    // Private mode denies access rather than returning null.
    const denied = () => {
      throw new Error('SecurityError')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied)

    expect(() => shouldShowWelcome({})).not.toThrow()
    expect(shouldShowWelcome({})).toBe(true)
    expect(() => markWelcomeSeen()).not.toThrow()
  })
})
