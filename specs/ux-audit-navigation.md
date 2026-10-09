# UX audit — navigation across the new functionality

2026-10-09. Chrome via Playwright at 1440×1000, dev server, logged in as an
internal user, against the real library. Every control on `/analysis`, a
working set's workspace, `/kb`, `/datasets` and a library entry was
enumerated programmatically — tag, class, label and destination — rather than
eyeballed, so the claims below are counts and not impressions.

The question was: can you find things, are they shown in consistent patterns,
and is it clear what kind of thing a control is about to do.

**The short answer: the pages are individually fine and the SYSTEM is not.**
There is no shared vocabulary for "what will this control do to me", so the
same shape means four different things, and the newest and most powerful
features sit four levels deep with nothing pointing at them.

---

## 1. The same shape means four different things — **the big one**

Six buttons on a working set's map interface share the class
**`derived-rerun`**, and they do three unrelated kinds of thing:

| Label | What it actually does | Class |
|---|---|---|
| Draw on the map | Toggles what the canvas paints — reversible, local | `derived-rerun` |
| Weigh it differently | Opens an editor below — a disclosure | `derived-rerun` |
| Run again | **Recomputes on the server and rewrites the column** | `derived-rerun` |
| Save as an index | **Writes a new column to the shared library** | `w-btn` |

So a reversible toggle, a disclosure, and a write that costs server time and
changes a stored number are **visually identical**, while the other write on
the same screen looks different again. A reader has no way to tell, before
pressing, which of these is free and which is permanent. The class being
named after the rarest of the three (`rerun`) is how it happened: each new
control reached for the nearest existing style.

## 2. "Start" four times, four different behaviours

`/analysis` has four controls labelled exactly **"Start"**, all with the class
`tool-start`:

- → `/place` (a tool page)
- → `/compare` (a tool page)
- → `/datasets?readiness=held` (a *filtered list*, not a tool)
- **a `<button>`** that expands a map pane on the current page (P9-12)

Three navigate and one does not; two land on a tool, one on a list. They are
indistinguishable. P9-12 made this worse by adding the button — I gave it the
same class so it would look consistent, which is exactly backwards: it looks
like the others and behaves unlike all of them.

The card text carries the real information ("Opens the datasets browser…"),
which is the tell: **the hint exists because the control cannot say it.**

## 3. One label, two destinations, same page

On `/kb` and on `/analysis`, **"Redevelopment dashboard"** appears twice with
different targets:

- `/views/redevelopment-dashboard-2` — the saved view
- `/library/redevelopment-dashboard` — the catalog entry

Same words, same page, different places. The set/view distinction is load-
bearing everywhere else in phase 9 (§F: a set is the data, a view is the
framing) and the navigation is the one surface that hides it.

## 4. The new power is four levels deep with no signpost

Everything built in P9-6a through P9-12 lives inside a working set's map
interface:

```
/analysis → a set's view → Map interface → scroll past the map
            → weight editor · free analyses · address search · comparison
```

Nothing on `/analysis` mentions that an index can be re-weighed, that layers
can be correlated, or that an address can be looked up inside a set. The six
tool cards — the page's answer to "what can I run?" — list none of them,
because they were built as *parts of a set's page* rather than as tools.

A reader who has not been told these exist will not find them.

## 5. Navigation that changes the URL is sometimes a button

The workspace's Map/Data switch is two `<button>`s, and pressing one does a
`router.replace` — the URL changes, the back button is affected, and the state
is shareable. Meanwhile `Its datasets` and `Check a place in this set` are
links that also just change a URL. Same consequence, two different shapes.

## What is already good, and should not be "fixed"

- **`/datasets` is the most consistent surface in the app**: every row is a
  link to an entry, every filter is a button, counts live on the chips. 75
  links and 70 buttons and no ambiguity about which is which.
- **The attention panel's hierarchy reads correctly**: the roll-up rows carry
  an arrow and a border, the P9-8 reason rows are quieter and smaller, so
  "these are a way into the row above" is legible without a label.
- **The back link is contextual** — `← Analysis` when you came from analysis,
  `← Docs` otherwise — which is better than a fixed breadcrumb.
- **Shape chips** (`Statistics by county or tract`, `Lines and networks`) do
  tell you what kind of thing a row is, consistently, everywhere they appear.

---

## The proposed approach

Not fifteen fixes. **One vocabulary, applied everywhere, then two structural
changes.** The individual defects above are symptoms of there being no rule.

### Rule 1 — a control's shape says what it will do

Three kinds, and nothing else:

| Kind | Shape | Means |
|---|---|---|
| **Go** | a link, always `<a href>` | the URL changes; right-clickable; back works |
| **Show** | quiet button, no fill | changes what is on this screen; free; reversible |
| **Write** | solid button | changes something stored, for everybody |

`derived-rerun` splits into *Show* (`Draw on the map`, `Weigh it differently`)
and *Write* (`Run again`). `Save as an index` becomes the same *Write* as
`Run again`. The Map/Data switch is a tablist and stays a button — a tab is a
recognised exception and already reads as one.

This is the rule that pays for itself: it is a styling change plus two class
renames, and it retires the "which of these costs something?" question
permanently.

### Rule 2 — name the destination, not the gesture

Replace every "Start" with what it opens: *Open the place report*, *Compare
counties*, *Browse the tables we hold*, *Open a map here*. The last one reads
differently from the others on purpose, because it behaves differently. Then
delete the hints that exist only to compensate for the label.

### Rule 3 — one label, one destination

Where a set and its view are both listed, say which: **"Redevelopment
dashboard"** (the set) and **"Redevelopment dashboard — map view"** (the
view). The distinction is already the spine of phase 9; the labels should
carry it.

### Structural 1 — a contents strip on the set's workspace

The workspace has two interfaces and, below them, five independent tools that
a reader has to scroll to discover. It needs one line near the top naming
what is on this page and jumping to it — *Layers · Weigh the index · Look at a
layer · Compare versions · Find an address*. Cheap, and it converts five
hidden features into five visible ones.

### Structural 2 — the tool cards should list the tools

`/analysis` claims to answer "what can I run?" and currently omits
re-weighting, correlation, distribution, coverage, rollup and address lookup
— because they need a set and the cards do not know how to say "needs a set".
P9-3 already solved exactly this problem for the per-set tools: **a gated
capability says why.** The same treatment belongs on the cards.

### Sequencing

1. **Rule 1** — the vocabulary. Everything else is easier once a control's
   shape is honest, and it is the one that prevents a *Write* being mistaken
   for a *Show*. **S.**
2. **Rules 2 and 3** — labels. Pure copy, no logic. **S.**
3. **Structural 1** — the contents strip. **S/M.**
4. **Structural 2** — the tool cards, reusing P9-3's pattern. **M.**

Worth saying plainly: 1–3 are small and would fix most of what this audit
found. Only the last is a real piece of work.
