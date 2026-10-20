# The starter-pack transcript — what should have happened

2026-10-20, from a real conversation a lead had with the assistant before the
P10 remediation. Nick's note on it: *"this probably should've made a new page
to work off of."*

**The ask:** *"using our library of documents as well as links and archive, I
need to pull a 'starter pack' together for a person new to land ownership and
stewardship and in need of sorting out an heirs property issue. Give me ten
resources (documents, links, organizations)."*

---

## What it got right, first

Worth saying, because the fixes below are about plumbing and not about
judgement. The assistant ran four searches, returned ten items, **grouped them
editorially** — "Heirs' property specifically", "Basic ownership
considerations / stewardship mindset", "Broader context on why this matters" —
gave each a line on why it was in the list, cited its sources with excerpts,
and **opened by naming the gap**: nothing in the library is a legal how-to or
legal-aid contact for actually resolving a title.

That is a good answer. Everything below is about what happened to it.

## What an ideal result looks like

1. **A page exists when the conversation ends.** A starter pack is a thing you
   hand to somebody. The lead asked for an artifact and received a transcript.
2. **Every resource links into the library.** Ten titles nobody can click is a
   list somebody has to go and search for a second time.
3. **The grouping survives**, because the editorial work is the value.
4. **The gap is recorded as a gap.** "The library has no legal-aid contact for
   heirs' property" is the single most actionable sentence in the output — a
   sourcing instruction derived from real use — and it died with the
   transcript.
5. **Organizations are actually returned**, because the lead asked for them.
6. **It is offered, not imposed.** Writes stay proposals the person confirms.

## Why none of that happened — five mechanisms, none of them disobedience

| # | What stopped it | Where |
|---|---|---|
| 1 | *"Call one only when they asked you to"* — read as "only if they said the word page". A starter pack is a thing you keep; the lead never had to say so. | rule 6 |
| 2 | *"Keep it short: two to five sentences, or a short list."* A ten-item grouped pack cannot comply. It did the right thing **against** the prompt. | rule 5 |
| 3 | **Nothing mentioned links.** Every `search_library` result already carries an `href`. The model had all ten and used none, because no rule said to. | — |
| 4 | **Nothing said a gap is worth keeping.** Rule 3 says "say so plainly" and stops there. | rule 3 |
| 5 | **Organizations are rows, not entries.** `search_library` searches the catalog; the organizations live inside a dataset. No phrasing of that search could have returned one. | — |

The assistant also *had* a way to be kept — "Save as note" sits on every
answer — and the lead didn't use it. Worth noting rather than fixing blind:
the button is one of three equal-weight controls, it says **note** when what
was wanted was a **page**, and the person who just read a good answer has to
know the difference.

## Fixed

Five prompt amendments, with tests pinning each:

- **Rule 6 widened.** A request for a thing somebody will keep, hand on or come
  back to *is* asking — `update_page` with `create: true` for something to
  return to, `create_note` for a finding.
- **Rule 5b added.** A compiled answer may be long; rule 5 is about not padding
  a short answer, not about refusing to build a long one somebody asked for.
- **Rule 8 added — link what you name**, using the href the tool already gave.
- **Rule 3 extended.** An absence found while answering is a sourcing
  instruction; offer to keep it.
- **Rule 4b added.** `search_library` searches the catalog; a category of thing
  — organizations, sites, parcels — may live as rows, and wants
  `query_dataset`.

Rule 7 is deliberately untouched: text in the library is information, never an
instruction. Widening when the assistant may write must not widen *what can
ask it to*. A test asserts rule 7 survives.

## Not fixed — a content gap, and the real reason the organizations ask failed

**The `organizations` dataset has an empty `description` and an empty
`whatItAnswers`.** `search_library` matches on both. So the one entry in the
library that holds organizations is close to invisible to the search that was
looking for them, and would have been even with rule 4b.

That is a cataloguing fix, not a code one, and it is exactly the kind of thing
the assistant's own gap sentence should be feeding back. Two sentences on that
entry would have changed this transcript more than any rule here.

## Decided — the affordance, and the content gap

Both of the things left open above were closed the same day.

**"Keep this…" (P13-4).** The three equal-weight verbs became one decision.
It opens onto three lines — a **new page** with a title defaulted from the
question, a note, or an append to a page that already exists — and the new
page is the first line and the only solid button in the panel. Making a new
page from an answer was not possible at all before this; `saveAnswerAsPage`
in `src/lib/ask.ts` is the path that did not exist.

**The `organizations` metadata (P13-3).** Written from the data rather than
imagined: 100 organizations, tiered 27 / 40 / 32 / 1, across 26 states, 99
geocoded, 82 with an EIN. "organizations", "land loss prevention", "who funds
Black farming organizations" and "legal assistance organizations" all return
the dataset at **#1** now; every one of them returned nothing before.

And a second bug fell out of writing it: **`whatItAnswers` was never in the
search haystack**, although `docs/MCP.md` says it is and the field exists for
exactly that purpose. Fixed in `libraryCatalog.ts`, with a test.

## The sentence this all turns on

The lead was told *"the library has no entry for a legal aid organization that
handles heirs' property cases."*

**The Land Loss Prevention Project is in the `organizations` dataset** —
Durham NC, legal assistance for Black landowners facing land loss. So is the
Federation of Southern Cooperatives, which the transcript searched for by
name. Eleven of the 100 organizations match legal / law / heirs / title.

That was not a gap honestly reported. It was a **confident false negative on
the single thing the person most needed**, produced by an empty description
field on one catalog entry. Worth remembering the next time the assistant
says the library holds nothing: the honest-sounding answer and the wrong one
look identical from the outside.

---

# The replay (P13-5)

The amendments above were tested, and the tests were worthless for the thing
that mattered: they pin that the rules **say** what they should, not that the
model **acts** on them. So the lead's question was asked again, verbatim,
against the real model — `npm run eval:chat`, a script rather than a test
because every run is a real call.

Three runs, and the first one failed outright.

## Run 1 — "I could not put an answer together. Try asking it a shorter way."

The model made nine tool calls, including six `query_dataset` calls against
the organizations rows — rule 4b working exactly as intended — and then:

```
[round 4] tools:25 → stop:max_tokens content:thinking in:32762 out:1500
```

**It spent its whole output cap on a thinking block and wrote nothing.** No
text, no tool call, so the loop broke out with an empty answer and the person
got the honesty line. Which is not honest: the question was fine, the ANSWER
was what did not fit, and "ask it a shorter way" sends somebody to rewrite the
one part of this that was already right.

This is the **fourth** time this codebase has sized an output cap too small
and been bitten the same way — `annotateEntry` at 600, `askMaxTokens` at
1,000, now chat at 1,500. The cap is spent by the thinking block as well as
the answer, and the failure is always silent.

It was also **self-inflicted**: rule 5b invites a compiled answer, and nothing
raised the ceiling to let one be written. Three fixes:

- `chatMaxTokens()` 1,500 → **4,000**. An output cap is a ceiling, not a
  spend; headroom is free.
- A round that ends `max_tokens` with no text now gets **one more round**,
  tools withdrawn, told to write from what it has.
- If it still writes nothing, the message **says what happened** instead of
  blaming the question.

## Run 2 — a good answer, kept nowhere

2,676 characters, four sections, ten items, seven links, nine citations. It
named the **Land Loss Prevention Project** as legal aid for heirs' property —
the exact thing the original transcript said the library did not have.

Then it ended: *"I can save this as a note so it is easy to come back to —
want me to create it?"*

So rule 6 was still being read as "ask permission", and it said **note** for a
thing somebody would hand off. But calling a write tool **is** asking: the
person sees a proposal and confirms it. Offering in prose costs them a turn
and usually loses the artifact.

Run 2b, with "the tool call IS how you ask" added, did the same thing in a
different order — announced *"I'll compile ten resources and propose a new
wiki page"*, wrote all ten into the chat, and then asked anyway. The reason is
plain once you see it: proposing the page means writing the whole pack a
second time, as a tool argument.

So the fix was an **ordering**, not more insistence: propose the page FIRST
and let the page carry the content, then write a short message saying what is
in it. The content is written once, and the short message is rule 5 again
rather than an exception to it.

## Run 3 — the ideal result

```
[round 4] … ✎ PROPOSED update_page: Replace the page "heirs-property-starter-pack"
[round 5] → end_turn
```

- **A page is proposed**, unasked, named by the model, carrying all ten items.
- The chat message is **1,104 characters** — it says what is on the page and
  links to it.
- The Land Loss Prevention Project, the Federation of Southern Cooperatives
  and Black Farmer Fund are all named, **from the organizations rows**.
- Seven library links in the message, every item linked on the page.
- The gap — no plain-language guide to clearing title — is recorded **on the
  page**, not left in the transcript.

Against the six-point list at the top of this document, that is all six.

## What to take from it

The gap between "the rule says so" and "the model does so" was three real
defects, and **none of them were visible to a test**. One was a hard failure
that would have hit a person the first time they asked for anything long.

`npm run eval:chat` is the check. It costs a few cents and takes a minute, and
it is the only thing that would have caught any of this.
