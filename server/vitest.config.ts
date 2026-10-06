import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // `eval/` holds P5-62's inspection eval set. Its harvest and golden tests
    // are offline and deterministic, so they belong in the ordinary suite;
    // the scorer beside them needs a key and is a script, not a test.
    include: ['src/**/*.test.ts', 'eval/**/*.test.ts'],
    // The route suites each import the full app (~7s) and run supertest +
    // argon2 logins; under a whole-suite run every CPU is oversubscribed and
    // the first test in a suite can blow the default 5s timeout before doing
    // any real work. 30s absorbs the parallel import storm without hiding
    // genuinely hung tests.
    testTimeout: 30_000,
    // And the same budget for hooks, which was left at vitest's 10s default
    // while the argument above applied to them word for word — more so: a
    // `beforeEach` that seeds a library, reindexes it and extracts the text
    // of a PDF does more real work than most of the tests it sets up.
    // P7-11 watched `librarySearchText`'s beforeEach blow 10s on a loaded
    // box, which reads as a failure in a test that had not begun.
    hookTimeout: 30_000,
    // P7-11: no detached writer outlives the test that armed it.
    //
    // `fileParallelism: false` was here, on the diagnosis that the suites
    // share module-level singletons across FILES. They do not, and cannot:
    // vitest's default pool is `forks` with `isolate` on, so every test file
    // gets its own process and its own module registry. A probe on this
    // config — two files, one module-level counter — reports different pids
    // and a counter of 0 in the second file; `--no-isolate` is the only way
    // to make it leak, and then it leaks whether files run in parallel or
    // not. Serialising isolated files bought ordering, which was never the
    // problem, at 155s a run.
    //
    // What actually crossed a boundary was work in flight. `onReindex` keeps
    // its hooks in an append-only registry, two of them launch detached
    // writers, and those writers resolve `libraryBucket`'s `dataDir` and
    // `libraryDb`'s `pool` when they write rather than when they started. So
    // a sweep armed by one test wrote into the next test's temp mirror and
    // queried the next test's pg-mem store, or was still recreating
    // directories while the afterEach of the test that armed it removed them
    // — the `ENOTEMPTY` that came out of a test's own teardown. Forward in
    // time, inside one worker, which is exactly why serialising left the
    // symptom alive and rarer (P7-9 and P7-6 both saw it).
    //
    // Fixed at the source — the extraction hook arms nothing under the runner
    // unless a suite asks (`installExtractionHook({ detachedUnderTest })`) —
    // and backstopped by `quiesce.ts`, which joins every registered handle
    // after each test. Parallelism restored on that basis, and proved the way
    // the ticket asked: twenty consecutive full runs, twenty greens.
    setupFiles: ['./src/testutils/quiesce.ts'],
  },
})
