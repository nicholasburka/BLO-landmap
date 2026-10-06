/**
 * The handles on work that runs detached from the request that started it
 * (P7-11).
 *
 * A reindex fires its hooks synchronously and ignores what they return, so a
 * hook that needs to do real work — parse the documents the reindex just
 * brought in, rebuild the place-report index — launches it and returns. That
 * is right for a request: parsing a shelf of PDFs must never be what an HTTP
 * caller waits for. It is wrong for a test, because the writer resolves
 * `libraryBucket`'s `dataDir` and `libraryDb`'s `pool` at USE time, not at
 * launch: a sweep armed by one test writes into the NEXT test's mirror, or
 * races the `rmSync` in the afterEach of the test that armed it. That is what
 * `ENOTEMPTY` from a test's own teardown was, and what the suite's single
 * moving failure was. It is not cross-file state — vitest gives every file
 * its own process and module registry — it is a writer outliving its test.
 *
 * So every module that launches detached work registers its settle handle
 * here, and the harness joins all of them after each test (see
 * `testutils/quiesce.ts`). One place to ask "is anything still writing?",
 * rather than each suite knowing which services it transitively armed —
 * five files had learned that by hand, and ninety-six had not.
 *
 * Deliberately dependency-free: the setup file that calls this imports it in
 * every suite, and importing a service here would pull `libraryBucket` and
 * `libraryCatalog` into files that never loaded them — changing the import
 * order their own `await import()` headers exist to control. Modules
 * register themselves when they load, so a suite drains exactly what it
 * armed and nothing else.
 */

/** How many times to re-ask. One settler's work can arm another's: the
 *  extraction sweep's `onExtracted` hooks drop the ask index, and a rebuild
 *  can queue a write behind the one just joined. Two passes cover the chains
 *  that exist; the third is the margin that keeps this from being a guess. */
const MAX_PASSES = 3

const settlers = new Set<() => Promise<unknown>>()

/**
 * Declare that this module launches detached work, and hand over the handle
 * that resolves when it is done.
 *
 * The handle must NOT start work of its own — `extractPending()` would begin
 * a sweep when none was running, which is how a drain turns into a writer.
 */
export function reportsDetachedWork(settled: () => Promise<unknown>): void {
  settlers.add(settled)
}

/**
 * Resolve once nothing registered is still writing.
 *
 * Never rejects: a settler that failed has already logged, and a drain that
 * threw would fail the test that was merely tidying up after itself.
 */
export async function detachedWorkSettled(): Promise<void> {
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    if (settlers.size === 0) return
    await Promise.all(
      [...settlers].map(settled =>
        settled().then(
          () => undefined,
          () => undefined,
        ),
      ),
    )
  }
}
