/**
 * A `matchMedia` for jsdom, driven by one width.
 *
 * jsdom lays nothing out and implements no `matchMedia`, so anything that
 * branches on a breakpoint — `usePhoneLayout`, and `useMapPane`'s
 * desktop-only rule (P6-14) — reads `false` for every query and never takes
 * its narrow *or* its wide path. Three specs had grown their own copy of this
 * stub; it lives here once so a component and its test cannot disagree about
 * what 1024 px means.
 *
 * `matches` is derived from the width for `min-width:` and `max-width:`
 * queries, which is every query this codebase writes. `resize()` moves the
 * width and fires each listener, so a test can prove a pane closes when the
 * window narrows rather than only that it starts closed.
 */
interface Registered {
  media: string
  listeners: ((event: MediaQueryListEvent) => void)[]
  mql: { matches: boolean; media: string }
}

export interface ViewportStub {
  /** Move the viewport and tell every listener. */
  resize(width: number): void
  /** The width right now. */
  readonly width: number
}

function evaluate(media: string, width: number): boolean {
  const max = /max-width:\s*(\d+)px/.exec(media)
  const min = /min-width:\s*(\d+)px/.exec(media)
  if (max) return width <= Number(max[1])
  if (min) return width >= Number(min[1])
  return false
}

export function stubViewportWidth(width: number): ViewportStub {
  let current = width
  const registered: Registered[] = []

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (media: string) => {
      const entry: Registered = {
        media,
        listeners: [],
        mql: { matches: evaluate(media, current), media },
      }
      registered.push(entry)
      return {
        get matches() {
          return entry.mql.matches
        },
        media,
        onchange: null,
        addEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
          entry.listeners.push(fn)
        },
        removeEventListener: (_: string, fn: (event: MediaQueryListEvent) => void) => {
          const i = entry.listeners.indexOf(fn)
          if (i >= 0) entry.listeners.splice(i, 1)
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }
    },
  })

  return {
    get width() {
      return current
    },
    resize(next: number) {
      current = next
      for (const entry of registered) {
        const matches = evaluate(entry.media, current)
        if (matches === entry.mql.matches) continue
        entry.mql.matches = matches
        for (const fn of [...entry.listeners]) fn({ matches } as MediaQueryListEvent)
      }
    },
  }
}

/** Put jsdom back the way it was. Call in `afterEach`. */
export function restoreViewport(): void {
  Reflect.deleteProperty(window, 'matchMedia')
}
