import { describe, it, expect } from 'vitest'
import { bumpIsolationProbe, isolationProbeBumps } from '../testutils/isolationProbe.js'

/**
 * Half of the pair that pins P7-11's premise: a module-level value does not
 * cross between test FILES. Both halves bump the same counter and both assert
 * they started from zero, so the assertion holds whichever runs first and
 * fails for the second one under `isolate: false`.
 *
 * This is the evidence the ticket's first two diagnoses lacked. The suites do
 * share module-level singletons — `libraryBucket`'s `dataDir`,
 * `placeHttp`'s `recentBySource` — but not with each other, so neither
 * capping workers nor `fileParallelism: false` ever addressed the real leak,
 * which was a detached writer outliving the test that armed it.
 */
describe('module state does not cross test files (P7-11)', () => {
  it('starts from a registry this file has not touched', () => {
    expect(isolationProbeBumps()).toBe(0)
    expect(bumpIsolationProbe()).toBe(1)
  })
})
