import { describe, it, expect } from 'vitest'
import { ACTIVITY_VERBS } from './libraryActivity.js'

/** The verb table IS the activity feed's allowlist: what is not here never
 *  reaches the ops home. Lock the shape so a new audit action is a
 *  deliberate choice either way. */
describe('activity verbs (P5-40 allowlist)', () => {
  it('shows fetches — link files (P5-47) and place slices (P5-57)', () => {
    expect(ACTIVITY_VERBS['library.fetch']).toBe('fetched the file for')
    expect(ACTIVITY_VERBS['source.fetch']).toBe('fetched a place from')
  })

  it('shows a place report (P5-58) as a line that reads without a target', () => {
    // Its audit target is a place key, not a catalog slug, so the feed
    // resolves no link — the verb has to stand on its own.
    expect(ACTIVITY_VERBS['place.report']).toBe('ran a place report')
  })

  it('never shows logins, tokens, OAuth or user admin', () => {
    for (const key of Object.keys(ACTIVITY_VERBS)) {
      expect(key).not.toMatch(/^(login|logout|user|token|oauth|mcp)\./)
      expect(key).not.toBe('logout')
    }
  })
})
