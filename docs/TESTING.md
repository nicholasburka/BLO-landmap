# Testing this codebase

Two suites, two environments, one hard-won lesson each.

```bash
npx vitest run              # client (jsdom), 107 files
cd server && npm test       # server (node), its own config
```

Run them **sequentially**, not at once. Several server cases fire real HTTP
round trips against a rate limiter and tip over under CPU load.

---

## The two things that have ever made this suite flaky

Both were misdiagnosed first, both took a day, and both have a one-line rule.

### 1. Detached work outliving the test that armed it

**A mounted component is a running component.** Every debounce in this codebase
is cleared in `onBeforeUnmount` — `GlobalSearch`, `DatasetView`, `EmbedPicker`,
`PageEditor`, `WorkingSetWorkspace` — and `PlaceView` holds a one-second
interval. None of that cleanup runs if nobody unmounts, so a timer armed in one
test fires during the next one, into its freshly reset mocks and cleared
`localStorage`.

The server suite's version (P7-11) was `onReindex` hooks launching detached
writers that resolved `pool` and `dataDir` *at use time*, so a sweep armed by
one test wrote into the next test's mirror.

**Rule:** anything you arm, something has to disarm. On the client that is
handled for you — `src/testing/vitestSetup.ts` calls `enableAutoUnmount`, so
every wrapper is unmounted after its test. Do not rely on a component "being
done"; it is done when it is unmounted.

### 2. Waiting for async work by sleeping

`App.spec` waited for an async component by polling the clock: forty
ten-millisecond turns, then give up and assert. 400ms is plenty on an idle
machine and not always enough on a loaded one — so the test's real assertion
was *how fast Vite transformed a module*, and the failure it printed was "an
internal user has no Help button".

**Rule:** never `setTimeout` your way to a conclusion. Await the work itself.

```ts
// Resolve the dynamic import by the SAME specifier the component defers on,
// then settle on microtasks only.
await import('@/components/MapCanvas.vue')
for (let i = 0; i < 20; i++) await flushPromises()
```

`settleMap` in `WorkingSetWorkspace.spec` and `settleAsyncHeader` in `App.spec`
are the two worked examples. A slow machine then makes a test slower rather
than wrong, and something genuinely broken fails every time.

---

## Judging a flake

**"Passes in isolation" is evidence, not proof — and so is a diagnosis that
sounds right.** Run it alone several times; once is a coin flip. `mcp.test.ts`
was written off as a contention flake twice before measurement showed it failed
one run in four *on an idle machine*, which is nondeterminism, not starvation.

Read the symptom before reaching for a cause. App.spec's failure named the
missing buttons, and which ones were missing ruled auth out entirely: the one
gated on `internalUser` was present, so only the async component was late.

**The bar for calling a flake fixed is twenty consecutive clean full runs.**
Not a retry, not a raised timeout, not a skipped case.

---

## What is real and what is faked

- **The network is faked, everything else is real.** `WorkingSetWorkspace.spec`
  runs the real explorer, pane and canvas against `mapboxStub`, because claims
  like "no duplicate fetch" are claims about the network and have to be
  measured there.
- **`src/testing/mapboxStub.ts` is deliberately faithful.** It throws what
  mapbox-gl throws — `setLayoutProperty` on an unloaded style, on a layer that
  does not exist — because P9-1b was a bug a lenient stub had been hiding.
- **jsdom gaps belong in `src/testing/vitestSetup.ts`**, not in guards inside
  components. jsdom implements no object URLs; `URL.createObjectURL` and
  `revokeObjectURL` are polyfilled there. A
  `typeof URL.revokeObjectURL === 'function'` check inside `PlaceView` would be
  production code bending around a test runner.
- **The client suite still makes real calls to `localhost:3001`** from some
  specs (`GET /api/me`, `POST /api/session`), so behaviour can depend on
  whether a dev server is up. Not a known failure, still worth stubbing when
  you touch an affected spec.

## Vitest facts worth knowing

- Defaults are pool `forks`, `isolate: true` — **a fresh process and module
  registry per file.** Module state does not leak between files; it never did.
  `fileParallelism: false` was once added to "fix" that and bought ordering,
  never the problem, for 73 seconds a run. It is gone.
- `afterEach` hooks run in reverse registration order, so the setup file's hook
  runs last.
