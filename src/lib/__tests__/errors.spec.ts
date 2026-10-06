import { describe, it, expect } from 'vitest'
import { friendlyError, NETWORK_ERROR_MESSAGE } from '../errors'

const FALLBACK = 'The library did not load. Try again in a moment.'

describe('friendlyError — the sentences the server wrote', () => {
  it('passes a server sentence through word for word', () => {
    // These come from the response body's `error` field, via errorMessage()
    // in lib/libraryCatalog.ts and its twins.
    for (const sentence of [
      'This entry has no link to fetch.',
      'There is no text to pull out of this kind of file.',
      'Too many attempts. Please try again later.',
      'a title is required',
      'Give a public http(s) URL to look at.',
    ]) {
      expect(friendlyError(new Error(sentence), FALLBACK)).toBe(sentence)
    }
  })

  it('leaves an expected, worded refusal alone', () => {
    // Place-fetch says exactly what went wrong and what to try instead; the
    // panel must not swallow that for a generic line.
    const refusal = 'that fetch did not work. Try again, or a smaller radius.'
    expect(friendlyError(new Error(refusal), 'that did not save.')).toBe(refusal)
    expect(friendlyError(new Error('your session expired — sign in again.'), FALLBACK)).toBe(
      'your session expired — sign in again.',
    )
  })

  it('keeps a written sentence even when it carries a number', () => {
    const tooBig = 'This page is too large: wiki pages are limited to 1 MB of markdown'
    expect(friendlyError(new Error(tooBig), FALLBACK)).toBe(tooBig)
  })
})

describe('friendlyError — a request that never arrived', () => {
  it('says so, whatever the browser called it', () => {
    for (const message of [
      'Failed to fetch', // Chrome
      'NetworkError when attempting to fetch resource.', // Firefox
      'Load failed', // Safari
      'fetch failed', // undici / node
    ]) {
      expect(friendlyError(new TypeError(message), FALLBACK)).toBe(NETWORK_ERROR_MESSAGE)
    }
  })
})

describe('friendlyError — everything else falls back', () => {
  it('never shows a bare HTTP status', () => {
    // The bug this ticket exists for: an expired session put "Unauthorized"
    // on the library page.
    expect(friendlyError(new Error('Unauthorized'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error('Forbidden'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error('Internal server error'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error('Not Found.'), FALLBACK)).toBe(FALLBACK)
  })

  it('never shows the technical fallback the API layer invented', () => {
    expect(friendlyError(new Error('catalog request failed (500)'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error('Failed to load wiki page (503)'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error('Could not load this file (404).'), FALLBACK)).toBe(FALLBACK)
  })

  it('never shows a machine code, or nothing at all', () => {
    expect(friendlyError(new Error('invalid_request'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error('bad-name'), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(new Error(''), FALLBACK)).toBe(FALLBACK)
    expect(friendlyError(undefined, FALLBACK)).toBe(FALLBACK)
    expect(friendlyError('a thrown string', FALLBACK)).toBe(FALLBACK)
    expect(friendlyError({ error: 'an object' }, FALLBACK)).toBe(FALLBACK)
  })
})
