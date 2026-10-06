# Chat — the wire protocol

Chat (P6-7) is a conversation with the library: threads that persist per user,
answers drawn from the same retrieval Ask uses, and the library's own tool set
behind them. This file is the contract the `/chat` page (P6-7b) builds against.
The server side lives in `server/src/routes/libraryChat.ts`,
`server/src/services/chatLoop.ts` and `server/src/services/libraryChat.ts`.

Two rules shape everything below:

- **A thread belongs to one person.** Every route looks a thread up by (id,
  owner). Somebody else's thread — an admin's included, this phase — is a
  `404`, never a `403`, so an id tells a probing client nothing.
- **Writes are proposed, never executed by the model.** When the assistant
  reaches for `create_note`, `append_to_page`, `update_page`, `drop_link` or
  `save_view`, nothing happens to the library. The call arrives on the stream
  as a `proposed_action` and waits, with its arguments, until a person confirms
  it through the confirm route. What then runs is the stored proposal — the
  arguments shown are the arguments executed.

---

## 1. Auth, transport, limits

Every route is internal-tier: the `blo_internal_session` cookie, plus an
`X-CSRF-Token` header on `POST`, `PATCH` and `DELETE` (the value `POST /api/login`
returned). The per-user limiter (120/min, shared with the rest of the internal
API) applies to all of them; the daily token budget applies to the message route
alone, because it is the only one that spends model tokens.

| Limit | Value |
|---|---|
| Message length | 2,000 characters |
| Thread title | 120 characters |
| Threads listed | 100, most recently used first |
| Model rounds per turn | 6 (tools are withdrawn on the last one, so a turn always ends in prose) |
| Tool calls per turn | 12, of which 2 may reach an outside service (`inspect_link`, `fetch_for_place`, `place_report`) |
| Compaction | past 30 turns, the older part becomes one `summary` message |

Failures are the usual ones: `401` logged out, `403` without the CSRF header,
`404` for a thread (or action) that is not yours, `400` for a message that is
empty or too long, `503` when the library is unavailable or the day's token
budget is gone (`{ error, code: "daily_budget_exceeded" }`).

---

## 2. Routes

| Method | Path | Body | Answer |
|---|---|---|---|
| `GET` | `/api/chats` | — | `{ chats: Chat[] }`, most recently used first |
| `POST` | `/api/chats` | `{ title?, message? }` | `201 { chat: Chat }` |
| `GET` | `/api/chats/:id` | — | `{ chat: Chat, messages: Message[] }`, oldest first |
| `PATCH` | `/api/chats/:id` | `{ title }` | `{ chat: Chat }` |
| `DELETE` | `/api/chats/:id` | — | `{ archived: true }` |
| `POST` | `/api/chats/:id/messages` | `{ text }` | **a stream** — section 3 |
| `POST` | `/api/chats/:id/actions/:actionId/confirm` | — | `{ action: ToolCall, message: Message }` |

`POST /api/chats` takes `message` only to NAME the thread — it is not stored and
not sent to the model. Create the thread, then send the same text to the message
route; the first message names an untitled thread anyway, so passing it twice is
optional.

`DELETE` archives: the thread stops being listed and stops being readable, and
the record of what was run from it survives.

---

## 3. The stream

`POST /api/chats/:id/messages` answers `200` with
`Content-Type: application/x-ndjson; charset=utf-8` — **newline-delimited JSON**:
one complete JSON object per line, in order, flushed as it happens. Not SSE:
the client posts a body with a CSRF header, so `EventSource` was never an
option, and NDJSON over `fetch` is ten lines to parse.

```js
const res = await fetch(`/api/chats/${id}/messages`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
  body: JSON.stringify({ text }),
})
if (!res.ok) throw new Error((await res.json()).error)   // 400 / 404 / 503 arrive as JSON

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) if (line.trim()) handle(JSON.parse(line))
}
```

### The events

| `type` | Shape | Meaning |
|---|---|---|
| `text` | `{ type, text }` | A piece of the answer. **Concatenate the pieces in order** (join with a blank line): today one arrives per model round, and true token streaming can start arriving as many without a client change. |
| `tool_call` | `{ type, phase: "started" \| "finished", call: ToolCall }` | A read tool the assistant ran. `started` carries `status: "running"`; `finished` carries `done` or `failed` and the final one-line summary. The two share a `call.id`. |
| `proposed_action` | `{ type, action: ToolCall }` | A write the assistant wants to make. `action.status` is `"proposed"`, `action.args` is what would run, `action.summary` says it in a line ("Write a note “Shelby follow-up”"). Nothing has happened yet. |
| `citations` | `{ type, citations: Citation[] }` | The numbered sources of this answer, sent once, just before `done`. Omitted when there are none. |
| `done` | `{ type, chatId, messageId, userMessageId }` | The turn finished. `messageId` is the stored assistant message, `userMessageId` the stored question. |
| `error` | `{ type, error, reason?, messageId? }` | The turn could not be finished. |

**Ordering:** `text`, `tool_call` and `proposed_action` interleave in the order
they happened; `citations` comes last before the terminal event. **Exactly one
terminal event ends every stream** — `done` or `error`, never both.

### When the model is unavailable

The turn is still a `200` stream, and the thread still gets an answer: the
honesty line ("The answering service is unavailable right now. Please try again
in a minute.") arrives as a `text` event, is stored as the assistant message,
and is followed by an `error` event carrying the same sentence. **Admins only**
also get `reason` — `no-key`, `refused`, `rate-limited` or `model-error` (P5-75)
— which the page turns into a sentence saying what to go and fix. A member
cannot act on any of them and is told only the sentence.

An `error` with no `messageId` means nothing was stored: something on our side
failed and the question can simply be sent again.

---

## 4. Shapes

```ts
interface Chat {
  id: number
  title: string
  createdAt: string   // ISO
  updatedAt: string   // ISO — the list is sorted by this, newest first
}

interface Message {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'summary'
  text: string
  toolCalls: ToolCall[]
  citations: Citation[]
  createdAt: string
}

interface ToolCall {
  id: string                 // what the confirm route addresses
  tool: string               // 'search_library', 'create_note', …
  kind: 'read' | 'write'
  status: 'running' | 'done' | 'failed' | 'proposed' | 'confirmed'
  summary: string            // one line, already written for a reader
  args?: Record<string, unknown>     // writes: what would run / did run
  result?: Record<string, unknown>   // writes: what running it returned
}

interface Citation {
  n: number                  // the [n] in the answer text
  slug: string
  kind: string               // 'wiki' | 'dataset' | 'document' | 'note' | 'source' | 'place'
  title: string
  href: string               // opens the real thing in the app
  snippet: string
  cited: boolean             // false = a lead, offered when the answer cited nothing
}
```

**Roles.** `user` is the person, `assistant` the answer. A `tool` message is the
result of a write the person confirmed — render it as an outcome line, not as
prose. A `summary` message is compaction: past thirty turns the older part of
the thread is folded into one summary the model reads in place of what it
covers. Nothing is deleted, so the page can still show every message; the
summary is worth showing as a quiet divider ("earlier in this conversation").

**Citation numbers are per message.** `[1]` in one answer and `[1]` in the next
point at different sources; resolve a bracket against the citations of the
message it is in.

---

## 5. Confirming a write

A `proposed_action` is a question for the person, so ask it plainly: the
summary, the arguments that matter (the note's title and body, the page's slug),
and two buttons.

```
POST /api/chats/:id/actions/:actionId/confirm     (CSRF header, no body)
→ 200 { action: ToolCall, message: Message }      // action.status === 'confirmed'
→ 400 { error, action, message }                  // it ran and was refused — the
                                                  //   thread keeps the message
→ 409 { error, action }                           // already dealt with
→ 404 { error: 'not found' }                      // not an action in this thread
```

Append the returned `message` to the thread and replace the proposal on the
earlier assistant message with the returned `action`. The assistant reads that
result on the next turn, so a refused write ("no page by that slug") is
something it can talk about rather than repeat.

Declining is a client-side act: leave the proposal alone and it stays
`proposed` forever, harmless. There is no delete tool anywhere on this server,
and confirming twice is refused.

Every confirmed write is audited twice: `chat.<tool>` with the thread and
message it came from, and the entry's own row (`library.note`, `wiki.update`, …)
reading **via chat** in the activity feed — the same two rows an MCP client
produces, with a different word for the door.

---

## 6. What the assistant can reach

Read tools, run as the model asks for them: `search_library`, `list_topics`,
`get_entry`, `read_page`, `read_document`, `query_dataset`, `list_layers`,
`get_layer`, `county_values`, `list_views`, `get_view`, `inspect_link`,
`fetch_for_place`, `place_report`, `list_place_slices`.

Write tools, proposed only: `create_note`, `append_to_page`, `update_page`,
`drop_link`, `save_view`.

These are the MCP tools (`docs/MCP.md`) — the same handlers, the same
validation, the same audit rows — so a question asked here and the same question
asked from Claude Desktop run the same code against the same library. `ask` is
not offered: this loop is that.

---

## 7. The client

The `/chat` page (P6-7b). Lazy and internal-only, like `/ask` — none of its
strings reach the public build.

| File | What it is |
|---|---|
| `src/lib/libraryChat.ts` | The typed client: the six thread calls, `confirmAction`, `sendMessage`, and the shapes above. |
| `src/composables/useLibraryChat.ts` | The page's state: threads, the open thread's messages, the turn in flight, the proposals. |
| `src/views/ChatView.vue` | The three columns — threads, conversation, and the map pane. |
| `src/components/MapCanvas.vue` | The map itself (P6-10), mounted in the pane on demand. |
| `src/composables/useMapState.ts` | This page's own layer and query state, independent of the public map's. |
| `src/components/chat/*.vue` | `ChatThreadList`, `ChatMessageItem`, `ChatToolLine`, `ChatProposedAction`, `ChatAnswerActions`, `ChatComposer`. |

Everything goes through `internalFetch` (`src/lib/apiBase.ts`), so the session
cookie, the `X-CSRF-Token` header and the API base URL are the ones the rest
of the internal app uses. Failures reuse Ask's `AskRequestError` and
`askErrorMessage`, so the budget, the expired session and the admin-only
"why the model is down" read the same words on both pages.

### Reading the stream

`sendMessage(chatId, text, onEvent, signal)` posts the message and reads the
body with a `ReadableStream` reader. A chunk can end anywhere, **including
mid-line**, so the tail of each chunk is carried into the next one and only
whole lines are parsed. Each parsed event goes straight to `onEvent`; the call
resolves on `done` and rejects on `error`, on a non-2xx (which arrives as JSON
before the stream starts), and on a stream that ends with neither.

`onEvent` is the composable's reducer. A turn puts both messages into the list
the moment it starts — the question as typed and an empty answer marked
`pending` — and the events fill the answer in: `text` appends (joined with a
blank line, as the server joins them), `tool_call` adds or replaces a line by
`call.id`, `proposed_action` hangs a card on the answer, `citations` replaces
the sources. `done` stamps the stored ids. An `error` **with** a `messageId`
leaves the pair alone (the honesty line is a real answer) and puts the
sentence in the banner; **without** one, nothing was stored, so the pair is
removed and the text is handed back to the composer.

Stop aborts the `fetch` through the signal; the partial answer stays on screen
marked "Stopped." Leaving the page aborts it the same way.

### The map pane

P6-10. The right-hand column mounts `MapCanvas` — the same component the
public map at `/` wraps — with `v-if` on open. Closed, it costs an absent flex
item: no column, no gap, and **no county file downloaded**. The component
itself is loaded on demand (`defineAsyncComponent`), so a reader who never
opens the pane never pays for mapbox-gl's chunk either. It is desktop only
(`MAP_PANE_QUERY`, 1024 px): two WebGL contexts and a 26 rem column are not a
phone's business, and a window narrowing past the breakpoint closes the pane
rather than hiding it with a live map inside.

The pane's state is its own `useMapState()` — layers, weights, filters, the
scoring query — so what the chat shows and what the public map shows cannot
contradict each other. `MapCanvas` emits `ready(ToolContext)` when it has a
map, and the page holds that context.

**Four tools run here, not on the server.** `show_layer`, `zoom_to_county`,
`show_county_details` and `set_query_state` are about *this page's map*, which
only this page has; every library tool (search, read, the proposed writes)
stays on the server and arrives as a line in the answer. A map tool reaches
the page as a `tool_call` event whose `call.tool` is one of the four and whose
`call.args` carries what to run it with — the page runs it through
`executeTool` against the canvas's context, opening the pane if it is shut and
queueing the call until the map exists. A call without `args` is skipped: a
read tool's line is a summary for the reader, not a call the page can replay.
Server-side registration of the four in the library chat's tool table is
follow-up work; `onToolCall` in `useLibraryChat` is the seam it will arrive
through, and `cypress/e2e/chatMapPane.cy.ts` drives it today with a stubbed
stream.

### Adding an event type

1. Add the interface and put it in the `ChatEvent` union in
   `src/lib/libraryChat.ts`, and add its `type` to `EVENT_TYPES` — a line
   whose type is not in that set is skipped, so an old page never breaks on a
   new server event, and a new event stays invisible until it is listed.
2. Handle it in `applyEvent` in `src/composables/useLibraryChat.ts`. Only the
   two terminal events end a turn; everything else mutates the pending answer.
3. Render it in `ChatMessageItem.vue` (or a new component under
   `src/components/chat/`).

A write tool needs nothing here: every write arrives as `proposed_action` and
is drawn by `ChatProposedAction.vue` from its `summary` and `args`, whatever
the tool is.
