# Type audit — the whole app

2026-10-14, after P12-1 settled the five roles on `/analysis` and a set's page.
Nick asked for a pass over the other pages, "for similar issues and to bring
coherence and consistency to our design system across them."

Measured two ways: every `font-size` declaration in every `.vue` file, and the
rendered values in Chrome on `/analysis`, `/datasets`, a set page and the
public map.

---

## The size of it

**~900 literal `font-size` declarations across the app**, before this pass.
The most-used values were 14px (230), 13px (214), 12px (136), 11px (63),
16px (39), 15px (35), 10.5px (24).

Two things follow from that distribution:

1. **There already was a de-facto scale** — 11 / 12 / 13 / 14 — arrived at by
   many people independently reaching for a reasonable number. The job was
   less to invent one than to name it and remove what missed.
2. **My own proposal was wrong about 12px.** The signed-off scale was
   11 · 13 · 14 · 17, and 12px is used 136 times. Keeping the proposal as
   written would have meant changing 136 declarations to avoid admitting a
   step that is plainly in use. 12px is in the scale.

The scale is **whole pixels, not a modular ratio**, and that is deliberate: a
×1.2 ratio through this range gives 11.6 / 14 / 16.8, and fractional sizes are
exactly what produced the mess.

```
10  micro      map chrome, over a canvas
11  eyebrow    a SECTION, as an overline
12  caption    chips, badges, column heads
13  meta       counts, timestamps, actions
14  body       prose
16  input      form fields — below this iOS zooms on focus
17  item       the thing a row is about
20  section    a section that has to be a real heading
27  page       the display face, one per page
```

---

## 1. Ninety-one declarations were within a pixel of a step

Swept onto the scale across 26 files: **10.5px** (24 — the single most common
off-scale value), **12.5** (10), **11.5** (3), **13.5** (3), **9.5** (2), and
forty-three `rem` fractions — 0.68, 0.75, 0.78, 0.8, 0.82, 0.85, 0.86, 0.88,
0.9, 0.92, 0.95.

At a 16px root those render 11.2 / 12.5 / 12.8 / 13.1 / 13.4 / 13.6 / 13.8 /
14.4 / 15.2 — **nine values spanning four pixels**, which is what produced the
13.8px span that was larger than the 13px links beside it on `/analysis`.

A set's page went from **13 distinct text sizes to 6**.

## 2. The app's default text colour was the Vite starter template's

`--color-text` and `--color-heading` both pointed at `--vt-c-indigo`
(`#2c3e50`), which ships with the Vue scaffold. So **every element that did
not set a colour of its own inherited the scaffold's indigo rather than the
product's ink.**

Measured on `/datasets`: the dataset-group headings rendered
`rgb(44, 62, 80)`. Not a near-miss — a different hue family from anything in
the palette.

It is also the explanation for a pattern all over the codebase: components
setting `color: var(--blo-ink)` on things that should simply inherit it. Each
one was compensating, separately, for a default that was wrong.

**Fixed in one line.** After: zero elements in the scaffold colour, on
`/datasets` or on the public map.

## 3. Two tests asserted pixel values that are now tokens

`NewView.spec` and `DocumentViewer.spec` read the raw stylesheet and asserted
`font-size: 0.95rem`. The intent — a phone floor of 14px — is unchanged,
because `--blo-text-body` **is** 14px. They assert the token now, which is
also what stops the test and the stylesheet drifting apart again.

---

## Reported, not swept — these are decisions, not typos

**15px, 35 uses.** One pixel from body and one from input. It is either a
"large body" step worth naming or it is drift, and that is a judgement about
how many steps this product wants. I did not want to make it inside a
mechanical sweep.

**The display ladder: 18, 20, 21, 22, 24, 26, 28, 30px.** Page titles were
normalised to 1.7rem in P9-15, but these survive in modals, rails and the
county panels. They want a second, display-side scale — three steps, probably
— and that is a design decision rather than a find-and-replace.

**`CountyRail.vue` has 14 distinct sizes in one component**; `LibraryEntryView`
11; `PlaceView` 10. All three are public-facing or close to it, and all three
deserve the P12-1 treatment — the five roles applied by hand, the way
`/analysis` got it — rather than a sweep that only makes the numbers tidier.

**Role violations beyond `/analysis`.** The two collisions Nick named —
section typed as its items, link typed as prose — were checked on `/datasets`
and are not present there. The remaining pages have not been checked
one-by-one for them, and that check is per-page judgement, not measurement.

---

## Gates

Client 2,422 / 2,422 across 113 files. Server 2,736 passed, 14 skipped.
Typecheck clean. Verified in Chrome on `/analysis`, `/datasets`, a set page
and the public map — canvas renders, no horizontal overflow, no element left
in the scaffold colour.
