import { afterEach } from 'vitest'
import { detachedWorkSettled } from '../services/detachedWork.js'

/**
 * Nothing the library launched is still writing when the next test starts
 * (P7-11). Loaded for every suite by `setupFiles` in vitest.config.ts.
 *
 * The suite's moving single failure was read as cross-file module state three
 * times, and serialised once. It was neither: vitest's forks pool gives every
 * test FILE its own process and its own module registry, so `dataDir` and the
 * limiter counters cannot leak sideways OR forwards between files — a probe
 * on this repo's config confirms it, and `--no-isolate` is the only way to
 * make them. What crossed test boundaries was work in flight: a reindex hook
 * launches a writer, the writer resolves `libraryBucket`'s `dataDir` and
 * `libraryDb`'s `pool` at use time, and the test that armed it has since
 * moved on to a fresh temp mirror and a fresh pg-mem store.
 *
 * Five files had worked this out and drained by hand — textExtract's afterEach
 * joins the sweep, four place-report suites await `placeReportIndexSettled()`.
 * This is that habit made general, so the other ninety-six get it too.
 *
 * It is the second line of defence, not the first. Hook order is stack order:
 * a setup file's afterEach runs AFTER the test file's, so this cannot save a
 * teardown that has already removed its mirror — only the next test. The race
 * inside one test is fixed where it starts, by `installExtractionHook` not
 * arming an unbounded sweep under the runner at all.
 */
afterEach(async () => {
  await detachedWorkSettled()
})
