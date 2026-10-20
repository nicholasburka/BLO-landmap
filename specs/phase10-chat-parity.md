# Phase 10 — tickets: chat reaches phase 9

Opened 2026-10-13, from asking a simple question — *how much of phase 9 can you
do by talking to it?* — and tracing both chat surfaces end to end.

> ## ⚠ CORRECTED 2026-10-20 — the central claim below is WRONG
>
> **The in-app chat has 22 tools, not six, and has had the whole MCP surface
> all along** — `build_index` and `measure_proximity` included. The table and
> most of the tickets under it were written against the wrong file.
>
> The mistake: this audit read `server/src/prompt/toolDefinitions.ts` and
> `src/lib/mapTools.ts`. Those belong to the **public map's prompt box**
> (`POST /api/chat` → `chatHaiku`), which genuinely does have six synchronous,
> map-only tools. The **library chat** at `/chat` is a different path —
> `runChatTurn` → `chatTools()` (`services/chatLoop.ts:162`) — which composes
> `MCP_TOOLS` minus `ask`, three place tools, and all of `MCP_WRITE_TOOLS` as
> proposals the person confirms.
>
> Two chats, two tool buses, and I checked one and reported on the other.
> Verified by enumerating `chatTools()` directly: 22 tools.
>
> **`/chat-context` now answers this question from the source** (P13-1), so it
> cannot be got wrong by reading again. What survives of the analysis below is
> noted at the end.

The answer is **almost none in the in-app chat, and about half over MCP**. The
focus here is the in-app chat, with MCP kept at parity: every capability below
lands on both surfaces, because the day they diverge is the day a person is
told "ask Claude to do it, it can't be done here."

---

## Where we actually are

There are two chats and they are not alike.

| Capability | In-app chat (`/chat`) | MCP connector |
|---|---|---|
| Find a working set | ✗ | ✓ `search_library kind:"working-set"` |
| Read what a set holds | ✗ | ✗ **neither** |
| Open / display a set's view | ✗ | ✓ `list_views` · `get_view` |
| Draw or rank by a set's index | ✓ *(as a plain layer)* | ✓ *(as a plain layer)* |
| Build an index on a set | ✗ | ✓ `build_index` |
| Re-weight an existing index | ✗ | ✗ **neither** |
| Measure proximity | ✗ | ✓ `measure_proximity` |
| Compare two indexes | ✗ | ✗ **neither** |
| Find a place by address | ✗ | ◐ `place_report` (not set-scoped) |
| Any write at all | ✗ **none** | ✓ behind `write` scope |

**The one thing that already works everywhere** is worth keeping in view,
because it is the model the rest should follow. `listInternalLayers()`
(`server/src/services/internalLayers.ts:1088`) pushes a working set's composite
columns into the layer manifest typed `geometry: 'county'`, `dataType: 'index'`.
That manifest is rendered into the chat system prompt
(`server/src/routes/chat.ts:92`) and backs MCP's `list_layers`. So an index
built on a set becomes an ordinary county layer that both surfaces can already
rank, filter, draw and read — *without either knowing what a working set is*.
P7-8 bought that, and it is why the gap below is narrower than it looks.

**Live check, 2026-10-13:** this is latent in production. Prod holds one
working set (`redevelopment-dashboard`) with **zero** derived columns and one
county layer, so there is currently no index for either surface to see. The
mechanism is deployed; the data is not.

---

## P10-1 [ARCH] The chat tool bus cannot call the server

**This is the enabling ticket and nothing else in this file starts without it.**

The in-app chat has six tools — `search_housing`, `set_query_state`,
`show_county_details`, `show_layer`, `toggle_ranking_panel`, `zoom_to_county`
(`server/src/prompt/toolDefinitions.ts`, 123 lines). They are executed **in the
browser** by a `switch` in `src/lib/mapTools.ts`, and that file contains **no
`fetch`, no `internalFetch`, and no `await` on a network call** — all six are
synchronous mutations of local map state. Even `search_housing` only calls
`ctx.triggerHousingSearch(...)` and returns a sentence.

Every phase-9 capability is a **server** resource: a working set is a
`library_catalog` row, an index is computed by `composite.ts`, geocoding is an
API route. So "give chat a working-set tool" is not another `case` in the
switch — the bus has no way to await anything, show that it is waiting, or fail
a tool call that fails for a reason the model should relay.

**Do:** add an async tool class to the bus — a tool may return a promise; the
transcript shows it working; a rejection becomes a tool result the model can
read and explain, not a thrown error. Keep the existing six exactly as they
are: they are synchronous because the map is local, and that is correct.

The one real design question, worth answering here rather than discovering
later: **tool results from the server are untrusted text in the same way a
dataset description is**, and they land in the model's context. The internal
layer manifest already goes through `clean()`
(`server/src/prompt/internalLayersContext.ts:20`) for exactly this reason.
Whatever the new class returns needs the same treatment.

**Size: M.**

## P10-2 [FEATURE] Nothing can read what a working set holds

Neither surface has a tool that answers *"what is in this set?"*. MCP can
**find** a set (`search_library` accepts kind `working-set` —
`server/src/services/mcpTools.ts:933`) and can **write columns onto** it
(`build_index`, `measure_proximity`), but there is no `get_working_set`. The
`build_index` description even tells the model to source layer ids from
`list_layers` rather than from the set, which is why it has to say "Must be one
the working set names" and hope.

This is the cheapest ticket with the widest effect: it is the prerequisite for
P10-3, P10-4 and P10-5, and it makes `build_index` stop guessing.

**Do:** one read tool returning a set's datasets, its county/point/line layers,
its derived columns (id, label, kind, when computed, freshness), its site
table if it has one, and the link to its workspace. Wire it to **both**
surfaces. The data is already one row — the probe for this ticket read it in a
single query against `library_catalog`.

**Size: S** server-side, plus the wiring.

## P10-3 [FEATURE] The in-app chat has no concept of a working set

Grepped the whole chat path — `toolDefinitions.ts`, `chatPrompt.ts`,
`chat.ts`, `chatLoop.ts` — for working-set, saved-view, composite and geocode
awareness: **zero hits**. A logged-in team member on `/chat` cannot ask *"what
sets do we have"*, *"open the livability set"* or *"what's in the redevelopment
dashboard"*, and nothing in the prompt tells them sets exist.

Meanwhile the same person's *browser* is sitting on a workspace that does all
of it. The chat is the one surface that does not know the product has working
sets.

**Do:** find a set, describe it (via P10-2), and open its view — the chat
equivalent of the three things `/analysis` offers. Opening a view is the
interesting one: in-app chat can *navigate the page it lives on*, which MCP
cannot, so this is a place the in-app surface should be better rather than at
parity.

**Depends on:** P10-1, P10-2. **Size: M.**

## P10-4 [FEATURE] Chat cannot build an index; MCP can

`build_index` (`server/src/services/mcpWriteTools.ts:883`) is a genuinely good
tool — it refuses a one-layer index, refuses a layer with no variance, handles
missing counties by dividing through the full declared weight, and returns the
stored result rather than recomputing. None of it is reachable from `/chat`.

**Do:** the same tool on the in-app bus, against the same server path, so there
is one scorer and one set of refusals.

**Decide first, explicitly:** this would be the in-app chat's **first write**.
All six current tools are display-only, so there is no precedent and no
established scope gate. MCP requires the `write` scope and audits every call
with `detail.via`; in-app chat is session-authed with no equivalent. Options
are (a) any logged-in user, since they can already do it in the UI two clicks
away, (b) admin only, (c) a per-session confirmation. **(a) is the honest
default** — the chat should not be able to do less than the page it sits on —
but it should be a decision in writing, and the audit row must carry that the
write came from chat, the way MCP's does.

**Depends on:** P10-1, P10-2. **Size: M.**

## P10-5 [FEATURE] An index can be created but never changed

Modification is **add-only on both surfaces**. `build_index` with the same
formula returns the stored column; with a different formula it creates a *new*
one. There is no re-weight, no rename, no remove — so a conversation that
iterates on a formula leaves a trail of dead columns behind it, and a set caps
at `DERIVED_COLUMNS_MAX` (24).

This is not hypothetical: dev currently carries two columns
(`heavier-on-black-progress-test-save`, `no-property-tax-term-test-save-2`)
created exactly this way and unremovable.

It is the same hole as **P8-2** (views and working sets cannot be deleted or
renamed), which is still open — so fix them together or the delete endpoint
gets written twice.

**Do:** re-weight an existing derived column in place, rename it, and remove
it. Both surfaces, plus the UI, since the browser cannot do it either.

**Size: M**, and it closes P8-2 at the same time.

## P10-6 [FEATURE] "How much moved" exists only in the browser

`src/lib/indexCompare.ts` computes the shift between two indexes — how many
places moved and by how much — and has **no server counterpart**
(`grep -rln indexCompare server/src` → nothing). So the question phase 9 was
built to answer, *"what does re-weighting actually change?"*, is the one
question neither chat can be asked.

Both surfaces can already fetch two indexes' values per county
(`county_values`) and compare them by hand, which is slow, costs a round trip
per county batch, and will produce a different answer from the card on screen.
One number computed one way.

**Do:** lift the comparison into a server service the card, the chat and MCP
all call. The card's current behaviour is the spec; it should not change.

**Size: M.**

## P10-7 [FEATURE] Address search is browser-only

P9-11 routed geocoding through our own API (`server/src/routes/geocode.ts`) so
the Mapbox spend is a number we can read — and then exposed it to exactly one
caller — `src/lib/addressSearch.ts`, used only by `MapAddressSearch.vue`.
Neither chat can resolve an address.

In-app chat has `zoom_to_county`, which needs a county name you already know.
MCP has `place_report`, which does accept an address but runs a full
every-source report — far too heavy for *"where is 1600 Pennsylvania Ave in
this data?"*.

**Do:** an address → county tool on both surfaces, through the existing route
so it stays metered and the usage dashboard keeps seeing it under one `path`.

**Size: S.**

## P10-8 [CHORE] The working-set tools are undocumented

`build_index`, `measure_proximity` and the `working-set` search kind have
**zero mentions** across `docs/MCP.md` and `docs/CHAT.md`. Worse than absent:
`MCP.md:222` still lists `search_library`'s kinds as the old eight
(`wiki|dataset|document|note|view|incoming|link|source`) while the code
(`mcpTools.ts:933`) accepts nine. Anyone reading the docs concludes working
sets are unreachable over MCP — which is how this phase got opened.

Same failure mode as the `railway ssh` section: the docs describe the shape the
product had when someone last wrote them down.

**Do:** document the three, fix the kind list, and add the capability matrix at
the top of this file to `CHAT.md` so the two surfaces can be compared at a
glance.

**Size: S.**

## P10-9 [FEATURE] A place report cannot be scoped to a set

`place_report` checks a place against **every** source that covers it. A
working set exists precisely to say *these sources and no others* — the
`/analysis` copy says so in as many words: "A place report run inside one asks
that set's sources and no others."

The UI honours that. The tool does not.

**Do:** an optional `workingSet` argument that narrows the report to the set's
sources. Cheaper than the unscoped call, not more expensive.

**Size: S.** Last, because the unscoped report still answers the question —
just slower and wider than asked.

---

## Sequencing

```
P10-1  async tool bus            ← nothing starts without this
  └─ P10-2  get_working_set      ← widest effect per line; unblocks 3, 4, 5
       ├─ P10-3  chat knows sets
       ├─ P10-4  chat builds an index   (decide the write gate first)
       └─ P10-5  re-weight / rename / remove   (closes P8-2 too)

independent of the bus, useful immediately:
P10-6  server-side index comparison
P10-7  address → county
P10-8  document the working-set tools   ← do first; it is an hour
P10-9  set-scoped place report
```

**P10-8 first** regardless of the rest: the tools already exist and nobody can
find them.

**The honest sequencing note:** P10-1 is real architecture, not a wrapper. If
the goal is "show that chat can work with a working set" sooner than that,
P10-2 + P10-8 alone make the MCP surface genuinely usable today — because MCP
already has the async bus the in-app chat lacks.

---

## What survives the correction (2026-10-20)

Most of this file was answering a question that had the wrong premise. Three
findings stand, and one of them is now the only real gap.

**P10-2 still stands and is still the gap.** There is no `get_working_set` on
either surface. `build_index` really does tell the model to source layer ids
from `list_layers` rather than from the set, and really does have to say "Must
be one the working set names" and hope. This was the cheapest ticket with the
widest effect when it was written and it still is.

**P10-5 still stands.** Index modification is add-only everywhere: the same
formula returns the stored column, a different one makes a new one, and there
is no re-weight, rename or remove. Same hole as P8-2.

**P10-8 is half done and half wrong.** `build_index`, `measure_proximity` and
the `working-set` search kind were undocumented, which is true and still is.
But the fix is no longer only a docs edit: `/chat-context` renders every tool
and the whole system prompt from the functions the turn reads, so the docs
have something that cannot drift to point at.

**P10-1, P10-3, P10-4 are void.** They were written to add an async tool bus,
a working-set concept and `build_index` to a chat that already had all three.
P11-9 separately gave chat a visible, rescopable set scope, which is the part
of P10-3 that was real.

**P10-6, P10-7, P10-9 are unaffected** — server-side index comparison, an
address→county tool, and a set-scoped place report are missing from both
surfaces regardless of which tool list is in front of the model.
