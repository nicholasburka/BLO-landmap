import { describe, it, expect } from 'vitest'
import { bumpIsolationProbe, isolationProbeBumps } from '../testutils/isolationProbe.js'

/** The other half of P7-11's isolation pair — see `isolation.a.test.ts`. */
describe('module state does not cross test files, from the other side (P7-11)', () => {
  it('starts from a registry this file has not touched', () => {
    expect(isolationProbeBumps()).toBe(0)
    expect(bumpIsolationProbe()).toBe(1)
  })
})
