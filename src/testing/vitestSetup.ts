/**
 * What every jsdom test file gets, whether it asks or not (P9-6b).
 *
 * **Mounted components are unmounted after each test.** They were not, in
 * twenty-seven spec files, and that is a flake factory rather than untidiness:
 * a component that is still mounted is still *running*. Every debounce in this
 * codebase is cleared in `onBeforeUnmount` — `GlobalSearch`, `DatasetView`,
 * `EmbedPicker`, `PageEditor`, `WorkingSetWorkspace` — and `PlaceView` holds a
 * one-second interval. None of that cleanup runs if nobody unmounts, so a
 * timer armed in one test fires during the next one, into its freshly reset
 * mocks and cleared `localStorage`.
 *
 * P9-6a hit exactly this: two tests passed alone and failed in the full run,
 * asserting that a draft had been restored when none was written — because a
 * 500ms autosave from an earlier test had landed in between. That is P7-11's
 * finding in the server suite ("what leaked was detached work, not state")
 * showing up on the client.
 *
 * `enableAutoUnmount` is test-utils' own answer, and it is the whole fix: one
 * hook here instead of twenty-seven `afterEach`es that each have to be
 * remembered, and it covers every spec written from now on.
 */
import { afterEach } from 'vitest'
import { enableAutoUnmount } from '@vue/test-utils'

/**
 * jsdom implements no object URLs, and two views legitimately use them —
 * `CompareView` and `PlaceView` hand a reader a CSV, and both release the URL
 * in `onBeforeUnmount`.
 *
 * This never bit before because nothing was ever unmounted. It is a gap in the
 * environment rather than in the code, so it is filled here: putting a
 * `typeof URL.revokeObjectURL === 'function'` guard in a component would be
 * production code bending around a test runner. A spec that wants to WATCH
 * these still stubs its own (`vi.stubGlobal('URL', …)`); `unstubAllGlobals`
 * restores the real `URL`, which from here on has both.
 */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:jsdom'
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {}
}

enableAutoUnmount(afterEach)
