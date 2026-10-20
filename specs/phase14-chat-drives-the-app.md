# Phase 14 — chat drives the pane it already has

2026-10-20. From Nick's question: *"can the chat show inline map panes, and
continue to chat, see the status of the map that's being used by the user,
etc? can the chat show inline data panes? can essentially all UI
functionality be brought up, accessed, modified, read, etc?"*

The audit's answer, in one line each: **the map pane exists and nothing can
drive it; there is no data rendering at all; the assistant cannot see what
you are looking at; and about half the app has no tool.**

---

## What is actually true today

### 1. The map pane is a three-way mismatch

| Layer | What it has |
|---|---|
| `src/views/ChatView.vue:285` | A real second Mapbox instance in a third column — desktop ≥1024px, lazy chunk, its own `useMapState()`. Opened by hand with the **Map** button (`:228`). |
| `src/views/ChatView.vue:42` | `MAP_TOOLS` dispatches **four** of the six: `show_layer`, `zoom_to_county`, `show_county_details`, `set_query_state`. |
| `server/src/prompt/toolDefinitions.ts` | Defines **six**, and belongs to the **public map's** prompt box. |
| `server/src/services/chatLoop.ts` → `chatTools()` | Registers **none** of them. |

`docs/CHAT.md:288` is honest about it: *"Server-side registration of the four
in the library chat's tool table is follow-up work; `onToolCall` in
`useLibraryChat` is the seam it will arrive through, and
`cypress/e2e/chatMapPane.cy.ts` drives it today with a stubbed stream."*

**And there is a second blocker nobody wrote down.** `runMapTool` bails unless
`MAP_TOOLS.has(call.tool) && call.args` — but a read's `tool_call` event
carries **no `args` and no `result`** (`chatLoop.ts:584-600` builds
`{ id, tool, kind, status, summary }` and nothing else). So registering the
four as read tools would still produce a dead seam. The wire has to learn a
third kind of call first. That is P14-1, and nothing else starts without it.

The pane is also mounted with **no `overlay` slot** (`MapPane.vue:33`), so it
has no layer controls, no legend — a bare canvas with a title and an ✕.

### 2. The assistant cannot see what you are looking at

`src/lib/libraryChat.ts:305` sends exactly `{ text, workingSet? }`. No
viewport, no layers, no open dataset, no selected county, no route. The scope
chip (`ScopeChip.vue`) scopes to **one** thing — a working set — and that slug
is the only signal about the reader's situation that ever reaches the model.

The machinery for the rest exists, in the other chat: `useChat.ts:189` sends
`context.activeFilters`, and `TurnSnapshot` (`:58`) captures layers with
weights, filters, limit, region states, current county and listing count at
every turn boundary — persisted, with click-a-bubble-to-rewind.

### 3. Nothing tabular can render, even as text

`renderMarkdown`'s LLM profile (`src/lib/renderMarkdown.ts:96`) allows
`p br strong em b i u code ul ol li blockquote a span hr` — **no `table`,
`thead`, `tr`, `td`, no headings, no `pre`**. Those live in `WIKI_TAGS`, which
chat does not use. So a model that answers with a markdown table has it
flattened into running prose.

And `query_dataset` returning 412 rows renders as the string *"Queried the
“slug” table · 412 rows"* — the rows reach the model's context and never the
screen.

### 4. Half the app has no tool

**Can:** read the library (search, entries, pages, documents, datasets); read
layers, county values, views and working sets; place lookup
(`fetch_for_place`, `place_report`); propose notes, pages, links, a saved
view, a composite index, a proximity column, a rename, a column removal.

**Cannot:** touch the map; open or filter a dataset table for the reader;
**create a working set or change which datasets are in one** (`POST
/api/working-sets`, `PUT /api/working-sets/:slug` exist for the UI and have no
tool); upload or ingest; reindex; read activity or usage; administer users,
tokens or OAuth clients; delete anything but a derived column.

The working-set one is the sharpest, and it is worse than a chat gap:
**`updateWorkingSet` (`src/lib/workingSets.ts:181`) has no caller in any view
or component.** `PUT /api/working-sets/:slug` exists and nothing in the app
calls it. So changing which datasets are in a set is not a thing chat cannot
do — it is a thing **nobody** can do without curl. Chat can compute an index
**on** a set and rename its columns, but *"build me a working set for the
Delta and index it"* dies at step one, and so does the same request made by
hand.

Three smaller ones found with it:

- **`save_view`'s enum is `['map', 'table']`**, but the UI also saves
  `compare` views (`CompareView.vue:301`). The tool cannot produce one.
- **Nothing edits a view.** `save_view` creates; there is no update tool and
  no update endpoint — only `POST /api/views` and `PUT
  /api/views/:slug/working-set`.
- **`query_dataset` takes no sort**, although `save_view`'s table state does.
- **`requestReindex` (`src/lib/libraryCatalog.ts:668`) also has no view
  caller** — reindex is API-only today, which is worth knowing given it is
  the step every deploy ends with.

---

## Success criteria

1. A person asks *"show me flood risk in Shelby"* in `/chat` and the pane
   opens and recolours, without them pressing anything.
2. The assistant's next answer can say what is on that map, because it was
   told.
3. A ten-row answer renders as ten rows.
4. *"Build me a working set from these four datasets and index it"* completes
   in one conversation.
5. Nothing above weakens the two standing guarantees: **MCP never deletes**,
   and **a write is proposed and confirmed, never run.**

## Decisions taken

**Map tools are chat-only, like `remove_column`.** They drive *this page's
canvas*, which no MCP client has. They go in a new `CLIENT_TOOLS` table, never
in `MCP_TOOLS`. `docs/MCP.md`'s surface is unchanged.

**A map tool is dispatched, not confirmed.** A write changes stored state and
needs a person; recolouring the reader's own map is the "Show" half of Go /
Show / Write (P9-13) and needs no gate. It is undone by asking for something
else.

**One definition, two buses.** The four shared definitions move to a module
both `prompt/toolDefinitions.ts` and `chatTools()` import, so the public map
and the library chat cannot drift.

**Working-set membership is a write, and goes to MCP too.** Creating a set is
not deleting anything, so the MCP guarantee is untouched and parity is kept.

---

## P14-1 [CHORE] A tool call can carry what it was called with — DONE 2026-10-20

**Type:** Chore · **Size:** M · **Depends:** none

**This is the enabling ticket and nothing else in this file starts without it.**

### Context

`runMapTool` needs `call.args` and read calls do not have them. A read's
arguments are deliberately omitted — the summary is for the reader and the
result is the model's business. A **client tool** is the opposite: the browser
is what runs it, so the arguments are the payload.

### Requirements

- [ ] A third `kind` on `ChatToolCall`: `'client'` beside `'read'` and `'write'`.
- [ ] `chatTools()` accepts a client-tool class that is **not run on the
      server**: the loop emits `tool_call` with `args`, hands the model a tool
      result naming what was shown, and records the call.
- [ ] The result the model reads is a sentence, not a stub — *"Shown on the
      person's map."* — so it can say so in its answer.
- [ ] Client calls persist with their `args` (`setToolCalls`), so reopening a
      thread can replay the map state.
- [ ] `MAX_TOOL_CALLS_PER_TURN` counts them.

### Acceptance criteria

**Given** a client tool registered in the table, **when** the model calls it,
**then** the emitted `tool_call` event carries `kind: 'client'` and the parsed
`args`, and the handler is never invoked on the server.

**Given** the same turn, **when** the model writes its answer, **then** the
tool result it read says what was shown, not "Not run".

**Given** a thread reopened later, **when** its messages load, **then** each
client call still carries its `args`.

**Given** a read tool, **when** it runs, **then** its event carries no `args`
— unchanged, and a test pins it.

### Out of scope

Registering any actual map tool (P14-2). Replaying stored calls on reload.

### Files

- `server/src/services/chatLoop.ts` — the `kind`, the branch, the result text
- `server/src/services/libraryChat.ts` — persistence of `args` on a client call
- `src/lib/libraryChat.ts` — the `ChatToolCall` type
- `docs/CHAT.md` §4 Shapes, §3 The stream

---

## P14-2 [FEATURE] The assistant can put something on the chat's map — DONE 2026-10-20

**Type:** Feature · **Size:** M · **Depends:** P14-1

### User story

As a researcher in `/chat`, I want to ask to see something on a map and have
it appear, so that I do not have to leave the conversation, find the layer,
and come back.

### Requirements

- [ ] The four definitions move to one shared module; both
      `prompt/toolDefinitions.ts` and `chatTools()` import them.
- [ ] `chatTools()` registers `show_layer`, `zoom_to_county`,
      `show_county_details`, `set_query_state` as client tools.
- [ ] The system prompt gains a rule: a question about where something **is**
      wants the map, and the internal layer manifest is already in the prompt.
- [ ] `ChatView.vue` drops nothing — its dispatcher and queue already work.
- [ ] Phone and narrow windows: a map call with the pane unavailable answers
      in prose and says the map is desktop-only, rather than failing silently.

### Acceptance criteria

**Given** a desktop reader, **when** they ask "show me flood risk in Shelby
County", **then** the pane opens, the layer colours, the map moves, and the
answer says what it showed.

**Given** the pane is closed, **when** a map call arrives, **then** it opens
and the queued call drains in order once the canvas is ready.

**Given** a window under 1024px, **when** the reader asks to see something,
**then** the answer is in words and nothing throws.

> **Built differently from how this was written, and better.** The criterion
> said the answer should "say so" — which needs the model to be told about a
> map and then told it cannot use it. Instead the four tools are simply **not
> in the table** for a reader with no pane (`chatTools({ map: false })`), and
> the rule about having a map is not in the prompt either. A capability you
> do not have is one you cannot call, and no explanation has to be written,
> read, or kept true. `ChatView` passes `pane.canOpen` — the same 1024px test
> that decides whether the column renders — so the two can never disagree.

**Given** the public map at `/`, **when** anything in this ticket ships,
**then** its six tools and its behaviour are unchanged — pinned by its
existing specs.

### Out of scope

`search_housing` and `toggle_ranking_panel` (public-map chrome, not the
chat's). Layer controls inside the pane (P14-7).

### Files

- `server/src/prompt/mapToolDefinitions.ts` (new) — the four, shared
- `server/src/prompt/toolDefinitions.ts` — import rather than declare
- `server/src/services/chatLoop.ts` — registration + the prompt rule
- `cypress/e2e/chatMapPane.cy.ts` — drop the stub, drive the real stream

---

## P14-3 [FEATURE] The assistant is told what the reader is looking at

**Type:** Feature · **Size:** M · **Depends:** P14-2

### Context

Today the only context is a working-set slug. The public map chat already
solves this (`useChat.ts:189` + `TurnSnapshot`); this is that idea on the
library chat's own pane.

### Requirements

- [ ] `sendMessage` takes an optional `context`: the pane's open state, its
      selected layers with weights, its filters, its focused county, and the
      route the reader is on.
- [ ] The server renders it into the turn as a short situational block —
      *"They are looking at …"* — not as excerpts, and never as instructions.
- [ ] It is **absent when the pane is closed**, so a closed pane costs nothing
      and says nothing.
- [ ] The block is visible on `/chat-context`, like everything else the model
      is given.
- [ ] Capped: a fixed, small set of fields, so the turn cannot grow with the
      page.

### Acceptance criteria

**Given** the pane is showing two layers, **when** the reader asks "what am I
looking at?", **then** the answer names those two layers.

**Given** the pane is closed, **when** a message is sent, **then** the body
carries no `context` and the prompt carries no situational block.

**Given** a `context` with an unknown layer id, **when** the turn runs,
**then** it is dropped rather than named, and the turn still answers.

**Given** `/chat-context`, **when** it renders, **then** the situational block
appears with the rest of the prompt.

### Out of scope

The public map's state. Click-to-rewind. Persisting context with the thread.

### Files

- `src/lib/libraryChat.ts`, `src/composables/useLibraryChat.ts`, `src/views/ChatView.vue`
- `server/src/routes/libraryChat.ts`, `server/src/services/chatLoop.ts`
- `server/src/routes/chatContext.ts`, `src/views/ChatContextView.vue`

---

## P14-4 [BUG] A table in an answer is flattened into prose — DONE 2026-10-20

**Type:** Bug · **Size:** S · **Depends:** none

**Expected:** an answer comparing four counties across three columns renders
as a table.
**Actual:** `renderMarkdown`'s LLM profile has no table tags
(`src/lib/renderMarkdown.ts:96`), so the pipes and dashes arrive as running
text.

### Requirements

- [ ] `table thead tbody tr th td` added to `LLM_TAGS`, with the same
      sanitiser and the same attribute allowlist as `WIKI_TAGS`.
- [ ] Styled to the P12-1 scale: 13px meta, column heads 12px uppercase.
- [ ] Wide tables scroll inside their own container; the message column never
      scrolls sideways.
- [ ] Still no `img`, no `pre`, no headings — an answer is not a page.

### Acceptance criteria

**Given** an answer containing a markdown table, **when** it renders, **then**
it is a `<table>`.

**Given** a table of nine columns on a 1024px window, **when** it renders,
**then** the table scrolls and the page does not.

**Given** an answer containing `<img>` or a script, **when** it renders,
**then** both are stripped — the existing sanitiser tests still pass.

### Files

- `src/lib/renderMarkdown.ts`, `src/components/chat/ChatMessageItem.vue`

---

## P14-5 [FEATURE] A dataset answer shows its rows

**Type:** Feature · **Size:** M · **Depends:** P14-1, P14-4

### Context

`query_dataset` and `county_values` are the two tools whose value **is** the
rows, and the reader sees only a count. P14-1 gives the wire a place to put a
result; this puts a small table under the tool line.

### Requirements

- [ ] `query_dataset` and `county_values` calls carry a **clipped** result to
      the client — at most 25 rows and 8 columns, the same clip the model gets.
- [ ] A `ChatResultTable` renders under the tool line, collapsed by default,
      with the row and column counts and "showing 25 of 412".
- [ ] A grouped query renders its groups; a failed call renders its error, as
      now.
- [ ] Nothing else carries a result — a `place_report` payload is not a table
      and must not become one here.

### Acceptance criteria

**Given** a query returning 412 rows, **when** the line is expanded, **then**
25 rows render and the header says "showing 25 of 412".

**Given** a query returning 3 rows, **when** the line is expanded, **then** 3
rows render with no "showing" note.

**Given** a reopened thread, **when** it loads, **then** the stored rows
render without re-running the query.

**Given** a dataset the reader may not see, **when** the turn runs, **then**
no rows reach the client — the existing visibility rules decide, not this
component.

### Out of scope

Sorting, filtering or paging in chat — that is `/datasets`, and "Open" goes
there.

### Files

- `server/src/services/chatLoop.ts`, `src/components/chat/ChatResultTable.vue` (new),
  `src/components/chat/ChatToolLine.vue`

---

## P14-6 [FEATURE] A working set's membership can be changed at all

**Type:** Feature · **Size:** M · **Depends:** none

### User story

As an organizer, I want to say "make a set from these four datasets and index
it", so that the thing I am building exists when the conversation ends.

### Context

Not only a chat gap. `PUT /api/working-sets/:slug` is implemented and
`updateWorkingSet` is written, and **no view or component calls either**
(`src/lib/workingSets.ts:181`). Adding a dataset to an existing set is
currently impossible from the product. The tool and the control are the same
ticket because shipping the tool alone would mean the assistant could do
something the person it is helping cannot.

### Requirements

- [ ] `create_working_set` (title, datasets, optional framing) and
      `set_working_set_datasets` (slug, datasets) as **write** tools —
      proposed, confirmed, audited, exactly like `save_view`.
- [ ] Both in `MCP_WRITE_TOOLS`, so MCP keeps parity. Neither deletes a set:
      membership is replaced, the set stays.
- [ ] The proposal card names the datasets by title, not slug.
- [ ] `get_working_set` already reads one back; `build_index` already indexes
      one. The chain completes with no further tools.
- [ ] A slug collision is answered, not overwritten.
- [ ] **The Datasets tab of `/sets/<slug>` gains Add and Remove**, calling the
      same `updateWorkingSet` the tool proposes — so the dead client function
      gets its first caller and the person has the control the assistant has.

### Acceptance criteria

**Given** four dataset slugs, **when** the reader asks for a set of them,
**then** a `create_working_set` proposal appears naming all four, and Run
creates it and links it.

**Given** that set, **when** the reader asks to add a fifth dataset, **then**
`set_working_set_datasets` proposes all five and the audit records it.

**Given** a title whose slug already exists, **when** the proposal runs,
**then** it is refused with a sentence naming the existing set.

**Given** MCP, **when** its tool list is read, **then** both appear and the
"no delete tool" test still passes.

**Given** `/sets/<slug>` → Datasets, **when** a person presses Add, **then**
the set gains the dataset through the same call the tool makes.

### Files

- `server/src/services/mcpWriteTools.ts`, `server/src/services/libraryWorkingSets.ts`
- `docs/MCP.md`, `docs/CHAT.md` §6

---

## P14-7 [FEATURE] Open a view in the pane instead of leaving the page

**Type:** Feature · **Size:** S · **Depends:** P14-2

### Context

`openTargetFor` (`src/lib/libraryChat.ts:418`) matches four route shapes and
every one of them navigates **away** from the conversation. A saved view is
exactly what the pane is for.

### Requirements

- [ ] When the target is a saved view and the pane can open, offer **"Show it
      here"** beside **Open**, and render it in the pane.
- [ ] `Open` stays, unchanged, for a reader who wants the full page.
- [ ] Under 1024px only `Open` renders.

### Acceptance criteria

**Given** an answer that saved a view, **when** the pane can open, **then**
both controls render and "Show it here" draws it without navigating.

**Given** a phone, **when** the same answer renders, **then** only "Open"
appears.

### Files

- `src/lib/libraryChat.ts`, `src/components/chat/ChatAnswerActions.vue`,
  `src/views/ChatView.vue`

---

## Order and critical path

```
P14-1 ──┬── P14-2 ──┬── P14-3
        │           └── P14-7
        └── P14-5 (also needs P14-4)
P14-4 ─────┘
P14-6  (independent — can run in parallel from day one)
```

**Critical path: P14-1 → P14-2 → P14-3.** P14-4 and P14-6 are independent and
are the cheapest value in the file. Total ≈ 2 weeks of sequential work; the
first demonstrable result ("show me flood risk in Shelby" works) lands at the
end of P14-2.

## Not in this phase, and why

- **Upload, ingest, reindex, users, tokens, OAuth.** Administration is not
  conversation, and every one of them is destructive or expensive to get
  wrong. They stay in the UI.
- **Deleting anything.** Unchanged: MCP never deletes, and chat deletes only a
  derived column.
- **Click-to-rewind on the chat's map.** Wants P14-1's stored `args` and is
  worth doing after P14-3 proves the context block earns its tokens.
- **Scoping chat to a dataset or a county.** The chip takes a working set
  only. Worth a spike once P14-3 shows what context is actually used.
- **`save_view` cannot make a `compare` view, and no tool edits a view.**
  Both are real gaps and neither is on the path to the five success criteria.
  Backlogged rather than forgotten.
- **`query_dataset` takes no sort.** P14-5 renders rows in the order the tool
  returns them; sorting is `/datasets`, and "Open" goes there.
- **No user administration exists anywhere** — not a route, not an API, only
  the `npm run users` CLI over `railway ssh`. That is a deliberate shape, not
  a gap chat should fill.
