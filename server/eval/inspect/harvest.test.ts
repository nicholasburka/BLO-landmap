import { describe, it, expect } from 'vitest'

import { harvestLinks } from '../../src/services/linkHarvest.js'
import { capturedSlugs, hasLabel, normaliseUrl, readCapture, readLabel } from './fixtures.js'

/**
 * The half of the eval set that costs nothing to run (P5-62).
 *
 * The scorer needs the model and a key; this does not. It asserts the one
 * thing the model can never make up for: **every link the label says a
 * researcher wants was actually harvested off the page**. A prune can only
 * ever choose among candidates, so a harvester regression is invisible in the
 * scored numbers — a page's recall would simply fall, and nobody would know
 * whether the prompt or the harvester did it.
 *
 * Offline, deterministic, and in the ordinary suite.
 */

const slugs = capturedSlugs().filter(hasLabel)

describe('the inspection eval set harvests every link its labels want', () => {
  it('has captured pages with labels beside them', () => {
    expect(slugs.length).toBeGreaterThanOrEqual(12)
  })

  it.each(slugs)('%s', slug => {
    const { capture, html } = readCapture(slug)
    const label = readLabel(slug)
    const { candidates } = harvestLinks(html, new URL(capture.finalUrl))
    const harvested = new Set(candidates.map(c => normaliseUrl(c.url)))

    const missing = label.keep.map(k => k.url).filter(url => !harvested.has(normaliseUrl(url)))
    expect(missing, `${slug}: the label wants these and the harvester did not find them`).toEqual([])

    // The other direction: a gap we recorded on purpose must still be a gap.
    // If one of these starts being harvested, that is good news — and the test
    // says so rather than staying quietly green.
    for (const gap of label.keepUnharvested ?? []) {
      expect(
        harvested.has(normaliseUrl(gap.url)),
        `${slug}: ${gap.url} is harvested now — move it from keepUnharvested into keep`,
      ).toBe(false)
    }
  })

  /**
   * A label is only useful if it names links this page really has. A typo in
   * a `drop` URL would silently make the scorer count a bad extra as neutral.
   */
  it.each(slugs)('%s labels only URLs the page really offers', slug => {
    const { capture, html } = readCapture(slug)
    const label = readLabel(slug)
    const { candidates } = harvestLinks(html, new URL(capture.finalUrl))
    const harvested = new Set(candidates.map(c => normaliseUrl(c.url)))

    const strays = label.drop.filter(url => !harvested.has(normaliseUrl(url)))
    expect(strays, `${slug}: these "drop" URLs are not candidates at all — a typo, or the page changed`).toEqual([])
  })

  it('captures carry the final URL and the date they were taken', () => {
    for (const slug of slugs) {
      const { capture } = readCapture(slug)
      expect(() => new URL(capture.finalUrl)).not.toThrow()
      expect(capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })
})
