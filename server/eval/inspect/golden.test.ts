import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

import type { LinkCandidate } from '../../src/services/linkHarvest.js'
import {
  unwrapAnswer,
  parseKeptLinks,
  parseProse,
  foldAccessNotes,
  type KeptLink,
  type ProseRead,
} from '../../src/services/linkPrune.js'
import { proposeSource } from '../../src/services/sourceProposal.js'
import type { Inspection } from '../../src/services/linkInspect.js'
import { GOLDEN_DIR, readLabel, hasLabel } from './fixtures.js'

/**
 * The gate the scorer cannot be (P5-62).
 *
 * `npm run eval:inspect` costs money, so it is not in CI — which would leave
 * the validators and the proposal mapping completely unguarded between eval
 * runs. A "golden" is one real answer the model gave, recorded verbatim, with
 * the candidate list it was answering about. Feeding it back through
 * `unwrapAnswer` → `parseKeptLinks` → `parseProse` → `foldAccessNotes` →
 * `proposeSource` reproduces the stored shapes exactly, with no model and no
 * network. Refactor any of those and this says so.
 *
 * What it does NOT assert: that the answers are good. That is the scorer's
 * job and a person's. This only asserts that the same answer still produces
 * the same record.
 */

interface Golden {
  slug: string
  url: string
  capturedAt: string
  recordedAt: string
  model: string
  answer: string
  candidates: LinkCandidate[]
  expected: { links: KeptLink[]; prose: ProseRead }
}

const goldens: Golden[] = existsSync(GOLDEN_DIR)
  ? readdirSync(GOLDEN_DIR)
      .filter(name => name.endsWith('.json'))
      .sort()
      .map(name => JSON.parse(readFileSync(join(GOLDEN_DIR, name), 'utf8')) as Golden)
  : []

/** Replayed exactly as `pruneLinks` does it, in the same order. */
function replay(golden: Golden): { links: KeptLink[]; prose: ProseRead } {
  const parsed = unwrapAnswer(golden.answer)
  expect(parsed, `${golden.slug}: the recorded answer no longer unwraps`).not.toBeNull()
  const links = parseKeptLinks(parsed!, golden.candidates)
  return { links, prose: foldAccessNotes(links, parseProse(parsed!, golden.candidates)) }
}

describe('recorded model answers still produce the same stored shapes', () => {
  it('has goldens to check', () => {
    expect(goldens.length).toBeGreaterThanOrEqual(12)
  })

  it.each(goldens.map(g => [g.slug, g] as const))('%s · links, roles and reasons', (_slug, golden) => {
    expect(replay(golden).links).toEqual(golden.expected.links)
  })

  it.each(goldens.map(g => [g.slug, g] as const))('%s · prose, evidence and access notes', (_slug, golden) => {
    expect(replay(golden).prose).toEqual(golden.expected.prose)
  })

  /**
   * The other half of the mapping: what a person is actually shown. A role
   * that stopped becoming the right `access.type`, or evidence that stopped
   * travelling with its field, would pass every test above and still be a
   * proposal nobody could check.
   */
  it.each(goldens.map(g => [g.slug, g] as const))('%s · the source proposal built from it', (_slug, golden) => {
    const { links, prose } = replay(golden)
    const inspection: Inspection = {
      kind: 'page',
      confidence: 'medium',
      url: golden.url,
      finalUrl: golden.url,
      checkedAt: golden.recordedAt,
      ...(links.length ? { links } : {}),
      ...(Object.keys(prose).length ? { prose } : {}),
    }
    const proposal = proposeSource(inspection)

    // Every access entry points at a link we kept, and only at roles that
    // could ever be called: a `docs` or `landing` link is not an endpoint.
    const kept = new Set(links.map(l => l.url))
    for (const access of proposal.source.access ?? []) {
      expect(kept.has(access.url ?? ''), `${golden.slug}: ${access.url} is not one of the kept links`).toBe(true)
    }
    // A viewer or a directory is honestly manual, never an adapter's job.
    for (const link of links) {
      if (link.role !== 'viewer' && link.role !== 'directory') continue
      const entry = (proposal.source.access ?? []).find(a => a.url === link.url)
      if (entry) expect([golden.slug, link.url, entry.type]).toEqual([golden.slug, link.url, 'manual'])
    }
    // Every field taken from prose is marked inferred, and every piece of
    // evidence belongs to a field that is.
    for (const path of Object.keys(proposal.evidence ?? {})) {
      expect(proposal.inferred, `${golden.slug}: evidence for an un-inferred field`).toContain(path)
    }
    // Nothing the model said about the page leaks in as a declared fact.
    if (prose.provider && !proposal.source.provider.includes('http')) {
      expect(proposal.inferred).toContain('provider')
    }
  })

  /** A golden is only about a page we still have, and a label we still have. */
  it('every golden matches a labelled fixture', () => {
    for (const golden of goldens) {
      expect(hasLabel(golden.slug), `${golden.slug} has a golden but no label`).toBe(true)
      expect(readLabel(golden.slug).url).toBeTruthy()
      expect(golden.candidates.length, `${golden.slug}: a golden with no candidates asserts nothing`).toBeGreaterThan(0)
    }
  })
})
