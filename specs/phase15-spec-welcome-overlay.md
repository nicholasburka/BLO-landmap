# Spec: the public map's welcome overlay

**Status:** Draft v0.1 — for sign-off
**Date:** 2026-10-22
**Route:** `/` (public, logged-out)

From Nick: *"frosty / semi opaque box on the site that explains how to use it
— welcome to the mapping tool, you can [3 options of things to do]. Maybe
takes up 2/3 of the screen. Welcome, click here to start. Overlay."*

---

## Problem Statement

**The public map's best features are invisible, and the one piece of
onboarding it has was sized for a map that did less.**

A first-time visitor lands on a national choropleth with a 320px card
(`WelcomeCard.vue`, `Map.vue:70`) that says one sentence about the Livability
Index and offers "Got it". Since that card shipped (phase 4f, May 2026) the
map has gained a prompt box, weighted multi-layer scoring, a 3,144-county
leaderboard, a guided walkthrough and a listings search. The card mentions
none of them.

Measured against the code, three capabilities are effectively undiscoverable:

| What | Where it hides | Why nobody finds it |
|---|---|---|
| **Weighted scoring** — weights, directions, threshold and range filters, a composite 0-100 score | Unlocks when a **second** layer is ticked (`Map.vue:498`) | **Nothing anywhere says so.** Not the card, not the Lens, not `/about`. A whole engine behind an unannounced rule. |
| **The national leaderboard** — all 3,144 counties ranked, no query needed (`Map.vue:778-800`) | Behind the grey text "rank 412th of 3,144" in the inspect rail (`CountyRail.vue:66-76`) | Styled as metadata. Its only affordance is a `title` attribute. |
| **What the prompt box can actually take** | The placeholder offers *"top 5 affordable counties"* | The server handles regions, thresholds and top-N in one call (`chatPrompt.ts:36-68`). The placeholder understates it. |

**And the card it replaces has two defects of its own, both current:**

- **It covers a shared link.** `WelcomeCard` checks only localStorage
  (`:39-47`); it never looks at the URL. So a first-time visitor opening
  `/?layers=…&fit=…` today gets a welcome card over the answer they were
  sent. The e2e suite works around it by pressing "Got it" before it can
  interact (`cypress/e2e/smoke.cy.ts:48-51`) — a test accommodating a bug.
- **It paints over the Lens** (`z-index: 6` vs the Lens's `4`), which
  `smoke.cy.ts:48-50` also records as expected behaviour.

And `/about`'s "How to Use This Tool" list (`AboutView.vue:189-209`) is four
items about clicking counties and toggling layers — written before the prompt
box, the rankings and the scoring existed.

## Who has this problem

A logged-out visitor on `/`. That is the entire public product: `/`,
`/about` and `/login` are the only unauthenticated routes
(`src/router/index.ts:9-199`).

---

## This reverses a decision, on purpose

`specs/phase4f-spec-C-onboarding-polish.md` put **"Multi-step onboarding
(tour, tutorials)"** explicitly out of scope, with the reasoning *"One card,
one dismiss."* That was right for a map whose only real gesture was clicking a
county. It is no longer right.

**What this spec is NOT doing is re-opening that decision in full.** There is
no multi-step tour here, no coachmarks, no "next ▸" through five tips. It is
**one screen with three doors** — closer to "one card, one dismiss" grown to
fit the product than to the tour that was rejected.

---

## Success Criteria

- [ ] A first-time visitor is told, in one screen, the three things the map
      does that they would not otherwise find.
- [ ] Each of the three is a **button that does the thing**, not a sentence
      describing it. Pressing one leaves the map set up and the overlay gone.
- [ ] A visitor who wants to poke around can get to the map in one press.
- [ ] It never appears over a shared link. Someone opening
      `/?layers=pct_Black&fit=…` sees the map they were sent.
- [ ] It appears once per browser, and there is a way back to it.
- [ ] Keyboard and screen-reader usable: Escape closes, focus is trapped
      while open and returns to where it came from.
- [ ] Nothing in it promises a layer the public map does not have.
- [ ] `WelcomeCard.vue` is deleted, not left beside it.

---

## Solution Overview

A centred, frosted panel over a dimmed map, holding a one-line welcome, three
labelled doors, and a quiet way past. The primary door is visually weighted;
the other two are peers; dismissal is a text action, not a button.

**The frosted treatment already exists** and is the only one in the codebase
(`src/assets/base.css:373-377`):

```css
.blo-panel--reference {
  background: rgba(247, 244, 238, 0.92);
  backdrop-filter: saturate(1.1) blur(6px);
  box-shadow: var(--blo-shadow-panel);
}
```

Cream at 92% over a 6px blur. The overlay wears
`.blo-panel .blo-panel--reference` — the same tier as the address search —
rather than inventing a glass.

---

## Mockup — desktop (≥1024px)

```
╔══════════════════════════════════════════════════════════════════════╗
║  the map, dimmed:  rgba(20, 18, 14, 0.35)                            ║
║                                                                      ║
║      ┌────────────────────────────────────────────────────┐          ║
║      │  .blo-panel .blo-panel--reference                   │          ║
║      │  min(720px, 66vw) wide · auto height · radius 12px  │          ║
║      │                                                     │          ║
║      │  THE BLACK LIVABILITY OBSERVATORY        ← eyebrow  │          ║
║      │                                           11/700    │          ║
║      │  Welcome to the map              ← 1.7rem display   │          ║
║      │                                                     │          ║
║      │  Every US county, scored on the conditions that     │          ║
║      │  shape Black livability. Three ways in:  ← 14/400   │          ║
║      │                                            68ch     │          ║
║      │  ┌───────────────────────────────────────────────┐  │          ║
║      │  │ ① Rank counties by what matters to you        │  │          ║
║      │  │   Pick the measures, set their weights, and   │  │          ║
║      │  │   the map re-scores every county.             │  │          ║
║      │  │                       [ Choose measures ]  ←lg│  │          ║
║      │  └───────────────────────────────────────────────┘  │          ║
║      │  ┌───────────────────────────────────────────────┐  │          ║
║      │  │ ② See how all 3,144 counties rank             │  │          ║
║      │  │   The national leaderboard, no setup needed.  │  │          ║
║      │  │                      [ Open the rankings ]    │  │          ║
║      │  └───────────────────────────────────────────────┘  │          ║
║      │  ┌───────────────────────────────────────────────┐  │          ║
║      │  │ ③ Ask for what you want, in plain English     │  │          ║
║      │  │   "top 10 affordable Southeast counties with  │  │          ║
║      │  │    high Black population"                     │  │          ║
║      │  │                        [ Try that question ]  │  │          ║
║      │  └───────────────────────────────────────────────┘  │          ║
║      │                                                     │          ║
║      │  Just show me the map          About the index →    │          ║
║      │  ↑ .blo-type-action            ↑ a.blo-type-action  │          ║
║      └────────────────────────────────────────────────────┘          ║
╚══════════════════════════════════════════════════════════════════════╝
```

**Why "2/3" is width, not area.** `min(720px, 66vw)` is two thirds of a
1100px window and caps at 720px on a 1440px one. Two thirds of the *height*
of a wide monitor would make three doors float in whitespace; the panel is
`height: auto` and caps at `min(560px, 80vh)` with the door list scrolling
inside if the copy grows.

## Mockup — phone (≤640px)

Two thirds of a 390px viewport cannot hold three doors legibly, so the phone
takes the shape the product already uses for this — a bottom sheet.

```
┌──────────────────────────┐
│ map, dimmed              │
│                          │
│                          │
├──────────────────────────┤
│         ──────           │ ← 40×4 handle
│  THE BLACK LIVABILITY…   │
│  Welcome to the map      │
│                          │
│  Every US county, scored │
│  on the conditions that… │
│                          │
│  ① Rank counties by…     │
│     [ Choose measures ]  │ ← 44px min target
│  ② See how all 3,144…    │
│     [ Open the rankings ]│
│  ③ Ask in plain English  │
│     [ Try that question ]│
│                          │
│  Just show me the map    │
└──────────────────────────┘
   max-height: 85svh, scrolls
```

`.sheet` / `.sheet-backdrop` live in `InternalMobileStyles.vue`, which is
mounted behind `v-if="internalUser"` — **a logged-out visitor never downloads
them**. The overlay restates those rules in its own scoped block or it ships
unstyled to precisely the audience it is for.

---

## Detailed Requirements

### The three doors

Each is a real first move. Pressing one dismisses the overlay and leaves the
map in that state — so the first thing a visitor does is the thing, not a
tutorial about the thing.

1. **"Choose measures"** → opens the Lens on the **Layers** tab
   (`Lens.vue:122-126`; the tab defaults to Legend, so it must be switched,
   not merely revealed). The visitor is one tick away from the scoring engine
   that nothing currently announces.
2. **"Open the rankings"** → opens the rail's rank explorer directly. It
   already works with no query (`Map.vue:778-800` keeps a BLO fallback for
   exactly this) but today it can only be reached by inspecting a county
   first and then clicking its rank. **This needs a new entry point** — the
   one piece of new plumbing in the phase.
3. **"Try that question"** → focuses the prompt box and **seeds** the text
   with the worked example. It does **not** submit: the visitor presses Ask.
   Spending a stranger's first model call for them is a cost and a surprise.

### Where it sits in the stack

The map's own loading overlay is `z-index: 1000` and `pointer-events: none`
— *"a status report, not a modal"* (`LoadingIndicator.vue:45-47`) — and it
runs until 3.78 MB of county data and 1.86 MB of geometry have landed
(`MapCanvas.vue:1741-1842`). The welcome overlay sits **above** it.

That is deliberate and it is the one genuine win in the timing: the basemap,
the prompt box and the Lens are interactive in the first frame, but the
choropleth is not. A visitor who reads three doors while the counties stream
in has spent the wait rather than watched it.

### When it must not appear

| Condition | Why |
|---|---|
| `blo:welcome:v2` is set in localStorage | Seen it. |
| Any of `?layers=`, `?focus=`, `?fit=` (`mapDeepLinks.ts:75-111`), `?view=` (`Map.vue:1796`) or `?set=` (`Map.vue:1804`) is on the URL | They were sent to a specific answer. A welcome screen over it is a bug — **and it is the bug the current card has.** |
| A conversation was restored from localStorage (`useChat.ts:94-97`, 7-day window) | A returning visitor mid-thread is not a first-time visitor. |
| localStorage throws (private mode) | Degrade to showing it; never throw. |

**A new key, not the old one.** `blo:welcomeDismissed` belongs to the card
being deleted. Reusing it would hide the new overlay from every visitor who
ever dismissed the old card — i.e. from exactly the returning audience this
is meant to re-orient.

### The way back

A visitor who dismisses it has no route back today. The Lens header gains a
quiet **"What is this?"** action that re-opens the overlay. Without it the
overlay is a thing you can only ever lose.

### Accessibility

`role="dialog"`, `aria-modal="true"`, an `aria-label`, Escape to close,
backdrop `@click.self` to close, focus moved to the panel on open and
**returned to the trigger** on close, focus trapped while open, and body
scroll locked (`src/lib/scrollLock.ts`).

**There is no focus-trap utility in this codebase.** Two hand-rolled copies
exist — `HelpDrawer.vue:81` and `InternalHeaderTools.vue:91` — and both are
internal-only. This is the third; it should be extracted rather than copied a
third time.

`prefers-reduced-motion` is honoured in three components and none of them is
an overlay (`PromptInput`, `ActivityFeed`, `RankingPanel`). A 2/3-screen
panel that animates in should be the fourth, following the RankingPanel
pattern (reset `animation`, `opacity`, `transform`).

### Type and controls

Per `specs/ux-audit-type-system.md` and P9-13:

- Eyebrow `.blo-type-section` (11/700 uppercase); title `--blo-font-display`
  at `1.7rem`, `clamp(20px, 6.5vw, 1.7rem)` under 640px; lede
  `.blo-type-body .blo-type-body--measure`; door titles `.blo-type-item`
  (17/600); door descriptions `.blo-type-body`.
- **Every door button is `.blo-act .blo-act--lg` — bordered, never
  `--write`.** P9-13 states it flatly: *"FILL MEANS CONSEQUENCE, and nothing
  else may use it."* These doors change this screen and write nothing shared.
  A localStorage dismissal flag is a per-browser preference, not stored state
  for everybody.
- `.blo-act` also buys the 44px phone touch target for free
  (`base.css:342-371`), which a hand-rolled button would have to restate.
- **Orange is forbidden.** The token comment reserves it for the Ask input.

> **The card being deleted gets this wrong**, which is worth recording:
> `WelcomeCard.vue:150-160` styles its dismiss as a solid ink pill with no
> `.blo-act` class at all — a second primary look on a control with no
> consequence. That is the exact defect P9-15 removed from `/analysis`.

---

## System Context

**Replaces:** `src/components/WelcomeCard.vue` (deleted) and its mount at
`Map.vue:70`/`:279`.

**Does not touch:** `HelpDrawer.vue` and `FirstRunChecklist.vue`. Both are
internal, both are lazy so their copy never enters the public chunk
(`App.vue:6-8`), and both are about internal destinations.

**Depends on:** `Lens` tab state (door 1), a new rank-explorer entry point
(door 2), `PromptInput` focus + seed (door 3), `scrollLock`, `usePhoneLayout`.

---

## Constraints & Boundaries

### In scope
The overlay, its three doors, the re-open affordance, deleting WelcomeCard,
extracting the focus trap, and the new rank-explorer entry point.

### Out of scope
- **A multi-step tour, coachmarks, or spotlighting.** One screen, three doors.
- **Server-side "seen it" state.** localStorage only, as in phase 4f.
- **Per-visitor or A/B'd copy.** One static set of three.
- **"Find land for sale"** as a door. It is double-gated — a county must be
  inspected *and* `VITE_RENTCAST_API_KEY` must be set on the deploy
  (`constants.ts:6`) — and the rail itself warns its links do not reach the
  property page. Too conditional to promise.
- **"Walk through"** as a door. It needs an active query first.
- **Rewriting `/about`'s stale "How to Use" list.** Real, and a separate fix.

### Assumptions
- `backdrop-filter` is acceptable to degrade: a browser without it gets cream
  at 92% and no blur, which is legible.
- **There is no password gate to pass.** `/` mints an anonymous session on
  load (`useAuth.ts:238` → `POST /api/session`) and `StagingGate` is a
  usage-cap bypass pill compiled out of prod, not a gate
  (`StagingGate.vue:64`). The overlay is the first thing a stranger meets.

### Hard constraints
- **No layer may be promised that does not exist.** There is no heirs'
  property layer, no flood-risk layer, and no Black-land-ownership acreage
  layer on the public map — 15 county layers plus 5 EPA point overlays
  (`layerRegistry.ts:129-482`, `siteLayers.ts:25-63`). "Black Land Ownership"
  is the publisher name on the composite, not a measured layer.
- Copy must pass the bundle-leak gate — no internal concepts
  (`scripts/check-bundle-leaks.mjs`).
- No new dependencies.

---

## Examples

### 1 — First visit, happy path
**Given** no `blo:welcome:v2` and a bare `/`.
**When** the map loads.
**Then** the overlay fades in over a dimmed map; focus is on the panel;
Escape, the backdrop and "Just show me the map" all close it and set the key.

### 2 — A shared link
**Given** no `blo:welcome:v2`.
**When** the visitor opens `/?layers=pct_Black,median_home_value&fit=47157`.
**Then** no overlay renders at all, and the key is **not** set — they have
not seen it, and a later bare visit still shows it.

### 3 — Door 1
**Given** the overlay is open.
**When** "Choose measures" is pressed.
**Then** the overlay closes, the key is set, the Lens is open on the
**Layers** tab, and focus lands on the first layer checkbox.

### 4 — Door 3 does not spend their turn
**Given** the overlay is open.
**When** "Try that question" is pressed.
**Then** the overlay closes, the prompt box is focused, and the example text
is in the field **unsent**, with the cursor at the end.

### 5 — Phone
**Given** a 390px viewport.
**When** the overlay opens.
**Then** it renders as a bottom sheet at `max-height: 85svh` with a handle,
every button is ≥44px, and the body does not scroll behind it.

### 6 — Reduced motion
**Given** `prefers-reduced-motion: reduce`.
**When** the overlay opens.
**Then** it appears with no animation, and is otherwise identical.

### 7 — Private mode
**Given** localStorage throws on read and write.
**When** the visitor opens `/` twice.
**Then** the overlay appears both times and nothing throws.

---

## Open Questions

- [ ] **Door 2's label.** "Open the rankings" vs "See the leaderboard". The
      product calls the panel "County Rankings" and the rail view "3,144
      counties"; neither says leaderboard. Leaning on the product's word.
- [ ] **Is "Welcome to the map" the right title**, or should it name the
      product — "The Black Livability Observatory"? The mockup uses the
      eyebrow for the product and the title for the act, which is the
      P12-1 pattern, but this is a founder call.
- [ ] **Does the re-open affordance belong in the Lens header** or in the
      prompt box's row? The Lens header has a "Clear ×" already and is the
      quieter home.

---

## Noted in passing, not in this spec

- `LensHeader.vue` carries a `canWalkThrough` prop, a `walk-through` emit and
  `.lens-hd-walk` CSS with **no button rendered**. A comment at `:12-14` says
  the entry deliberately lives in the Rankings panel and the rail — so this
  is dead code, not a missing feature. Worth a cleanup, not a fix.
- The public map's own components use a `768px` breakpoint
  (`Lens.vue:417`, `WelcomeCard.vue:188`) while the stated standard is 640px
  (`usePhoneLayout.ts:22`, `base.css:342`). The overlay will use 640; the
  inconsistency is older and larger than this phase.
- `WelcomeCard.vue` has no spec file and no unit test. Its replacement
  should have both.
- `cypress/e2e/smoke.cy.ts:48-65` encodes the current card — its overlap with
  the Lens, and a "Got it" press before every interaction. Those change with
  it, and the deep-link case becomes a real assertion rather than a
  workaround.
- The public map's at-rest chrome covers ~22% of the map area, all of it a
  left column plus the top strip; the centre and right half are bare. A
  centred panel covers the Lens, the card it replaces, and most of the
  prompt box — which is the point, but it means **every** control a visitor
  might reach for is behind it while it is open.

---

# Tickets

```
P15-1 ──┐
        ├── P15-3 ── P15-4
P15-2 ──┘
```

**Critical path: P15-2 → P15-3.** P15-1 is independent and can run first or
in parallel. Roughly a week.

---

## P15-1 [CHORE] A focus trap, once

**Type:** Chore · **Size:** S · **Depends:** none

### Context

There is no focus-trap utility in this codebase. There are **two hand-rolled
copies** of the same ~15-line pair — `onPanelKeydown` + `focusables()` — in
`HelpDrawer.vue:71-95` and `InternalHeaderTools.vue:91`. Both are
internal-only components, so the public map has no access to either, and
`CountyModal` — the one dialog a public visitor actually meets today — has no
trap, no focus return and no backdrop at all.

P15-3 would be the third copy. Two is a coincidence; three is a pattern with
no home.

### Requirements

- [ ] `src/composables/useFocusTrap.ts` (or `src/lib/`): given a container
      ref, trap Tab and Shift+Tab inside it, and return focus to a recorded
      trigger on release.
- [ ] `HelpDrawer` and `InternalHeaderTools` both use it; their local copies
      are deleted, not left beside it.
- [ ] Their existing tests pass **unchanged** — this ticket changes no
      behaviour, and that is how we know.
- [ ] Documented: the HelpDrawer copy deliberately does not filter hidden
      elements because collapsed recipes are `v-if`'d out of the DOM
      (`HelpDrawer.vue:72-74`). A shared utility cannot assume that, so it
      filters on visibility and the comment moves with it.

### Acceptance criteria

**Given** the help drawer is open, **when** Tab is pressed on its last
focusable element, **then** focus moves to its first — as it does today.

**Given** the drawer closes, **when** focus is read, **then** it is on the
Help trigger — as it does today.

**Given** a container with a hidden focusable child, **when** Tab cycles,
**then** the hidden child is skipped.

### Files

`src/composables/useFocusTrap.ts` (new) · `src/components/HelpDrawer.vue` ·
`src/components/InternalHeaderTools.vue` · tests for the new utility

---

## P15-2 [FEATURE] The national leaderboard has a front door

**Type:** Feature · **Size:** S · **Depends:** none

### User story

As a visitor who has just arrived, I want to see how every county ranks
without first guessing that a grey line of text is a button, so that the best
zero-setup thing on the map is reachable.

### Context

`CountyRail`'s rank explorer lists **all 3,144 counties** by BLO Index and
works with **no query at all** — `Map.vue:778-800` keeps a BLO fallback for
precisely this. It is the strongest zero-setup payoff on the public map.

Today it can only be opened by inspecting a county and then clicking *"rank
412th of 3,144"* (`CountyRail.vue:66-76`), which is styled as metadata beside
the score and whose only affordance is a `title` attribute.

P15-3's second door needs to open it directly. So does anyone who has not
clicked a county yet.

### Requirements

- [ ] The rail can open in `rank` mode with **no county inspected** — no
      highlighted row, the list from the top.
- [ ] The existing path (inspect → click the rank) is unchanged, including
      the highlighted current county.
- [ ] Works with no scoring query active, which is the default state.
- [ ] On a phone the rail is already the rankings surface
      (`RankingPanel.vue:537-543`); this must not double up.

### Acceptance criteria

**Given** a bare `/` with nothing clicked, **when** the rank explorer is
opened, **then** the rail shows 3,144 counties ordered by BLO Index with no
row highlighted, and clicking a row inspects that county.

**Given** a county already inspected, **when** its rank line is pressed,
**then** behaviour is exactly as before, with that county highlighted.

**Given** a 390px viewport, **when** the rank explorer opens, **then** one
rankings surface renders, not two.

### Out of scope

Restyling the "rank N of M" line, and the `RankingPanel`'s own rankings.

### Files

`src/components/Map.vue` · `src/components/CountyRail.vue` ·
`src/components/__tests__/CountyRail.spec.ts`

---

## P15-3 [FEATURE] The welcome overlay

**Type:** Feature · **Size:** L · **Depends:** P15-1, P15-2

### User story

As a first-time visitor, I want one screen telling me the three things this
map does, each of which I can press to actually do it, so that I start by
using the tool rather than by reading about it.

### Requirements

**The panel**
- [ ] `src/components/WelcomeOverlay.vue`, mounted by `Map.vue` in place of
      `WelcomeCard`.
- [ ] `.blo-panel .blo-panel--reference` — the existing frosted tier. No new
      glass.
- [ ] Desktop: centred, `min(720px, 66vw)` wide, height auto capped at
      `min(560px, 80vh)` with the doors scrolling inside.
- [ ] Phone (≤640px): a bottom sheet, `max-height: 85svh`, with a handle.
      `.sheet`/`.sheet-backdrop` are internal-only and must be restated
      locally — see the spec.
- [ ] Backdrop `rgba(20, 18, 14, 0.35)`, the value both existing overlays
      use. Above the loading overlay (`z-index: 1000`).
- [ ] Type per P12-1; **every door button `.blo-act .blo-act--lg`, never
      `--write`**; no orange.

**The three doors**
- [ ] *Choose measures* → closes, opens the Lens on the **Layers** tab (it
      defaults to Legend, so it must be switched), focus to the first layer
      checkbox.
- [ ] *Open the rankings* → closes, opens the rank explorer (P15-2).
- [ ] *Try that question* → closes, focuses the prompt box, **seeds** the
      example text **unsent**, cursor at the end.
- [ ] *Just show me the map* → closes, nothing else.

**When it must not appear**
- [ ] `blo:welcome:v2` set. **A new key** — reusing `blo:welcomeDismissed`
      would hide this from everyone who dismissed the old card.
- [ ] Any of `?layers=`, `?focus=`, `?fit=`, `?view=`, `?set=` on the URL.
      In this case the key is **not** set either.
- [ ] A conversation restored from localStorage (`useChat.ts:94-97`).
- [ ] localStorage throwing degrades to showing it, never to an exception.

**Accessibility**
- [ ] `role="dialog"`, `aria-modal="true"`, `aria-label`; Escape and
      backdrop-`@click.self` close; focus trapped via P15-1 and returned;
      body scroll locked via `src/lib/scrollLock.ts`.
- [ ] `prefers-reduced-motion` honoured — the fourth component in the repo
      to do it, following `RankingPanel.vue:451-456`.
- [ ] Every control ≥44px on a phone (free with `.blo-act`).

**Retiring the old one**
- [ ] `WelcomeCard.vue` deleted; its mount at `Map.vue:70`/`:279` removed.
- [ ] `cypress/e2e/smoke.cy.ts:48-65` updated — the "press Got it first"
      workaround goes, and the deep-link case becomes a real assertion.

### Acceptance criteria

The seven worked examples in the spec are the acceptance criteria verbatim:
first visit, a shared link, each of the three doors, the phone sheet, reduced
motion, and private mode.

Plus, pinned as tests because they are the two rules most likely to drift:

**Given** the overlay renders, **when** its primary button's classes are
read, **then** they contain `blo-act` and `blo-act--lg` and **do not**
contain `blo-act--write` — the `IndexWeightEditor.spec.ts:19-27` pattern.

**Given** the overlay's copy, **when** it is read, **then** it names no layer
absent from `layerRegistry.ts` — no heirs' property, no flood risk, no
land-ownership acreage.

### Out of scope

A multi-step tour. Server-side "seen it". A/B'd copy. Rewriting `/about`'s
stale "How to Use" list. The "Find land for sale" and "Walk through" doors —
both too conditional (see the spec).

### Files

`src/components/WelcomeOverlay.vue` (new) ·
`src/components/__tests__/WelcomeOverlay.spec.ts` (new) ·
`src/components/WelcomeCard.vue` (deleted) · `src/components/Map.vue` ·
`src/components/Lens.vue` · `src/components/PromptInput.vue` ·
`cypress/e2e/smoke.cy.ts`

---

## P15-4 [FEATURE] A way back to it

**Type:** Feature · **Size:** XS · **Depends:** P15-3

### Context

Dismissal is permanent per browser and there is no route back. An overlay you
can only ever lose is one nobody can recommend to a colleague — *"click the
thing that explains it"* has no referent.

### Requirements

- [ ] A quiet **"What is this?"** action re-opens the overlay. The Lens
      header is the proposed home — it already carries "Clear ×" and is the
      calmer surface (see the spec's open question).
- [ ] Re-opening does **not** clear `blo:welcome:v2`; dismissing again does
      not re-set it. The key records "has seen it", not "is hidden".
- [ ] `.blo-type-action`, not a button — this is a Show, and a small one.

### Acceptance criteria

**Given** the overlay was dismissed, **when** "What is this?" is pressed,
**then** it opens with all three doors working.

**Given** it was re-opened and dismissed again, **when** the page is
reloaded, **then** it does not appear.

### Files

`src/components/LensHeader.vue` · `src/components/Map.vue` ·
`src/components/__tests__/LensHeader.spec.ts`

---

## Backlog, from this audit

- `LensHeader.vue` carries `canWalkThrough`, a `walk-through` emit and
  `.lens-hd-walk` CSS with no button rendered. A comment at `:12-14` says the
  entry deliberately lives elsewhere — so this is dead code to delete, not a
  feature to restore.
- `/about`'s "How to Use This Tool" (`AboutView.vue:189-209`) predates the
  prompt box, the rankings and the scoring. The overlay will say three true
  things that page does not.
- The public map uses a 768px breakpoint; the stated standard is 640px.
- A stale comment at `layerRegistry.ts:60` says 26 public layers; there are
  15 (plus 5 EPA point overlays).
