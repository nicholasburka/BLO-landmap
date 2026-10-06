/**
 * A module-level counter that exists only to be leaked (P7-11).
 *
 * The fix for the suite's moving single failure rests on a premise worth
 * pinning: every test FILE gets its own module registry, so a service's
 * `let` cannot carry a value from one file into another. That is vitest's
 * `isolate`, on by default for the forks pool — not something this repo
 * configures, and therefore something a future config change could silently
 * take away. `__tests__/isolation.*.test.ts` bump this and assert they each
 * started from zero; under `isolate: false` the second file to run fails.
 */

let bumps = 0

export function bumpIsolationProbe(): number {
  bumps += 1
  return bumps
}

export function isolationProbeBumps(): number {
  return bumps
}
